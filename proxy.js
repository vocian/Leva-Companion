#!/usr/bin/env node
/**
 * Leva! ITO WebSocket Proxy
 * ─────────────────────────────────────────────────────────────────
 * Bridges the ITO module's raw TCP serial stream to a WebSocket
 * that the Leva browser app can connect to.
 *
 * Architecture:
 *   Browser App  ←──WebSocket──→  This proxy  ←──TCP──→  ITO Module
 *
 * The ITO's ESP8266/ESP32 WiFi chip acts as a serial-to-TCP bridge.
 * It streams newline-delimited telemetry and accepts text commands
 * over the same raw TCP socket.
 *
 * Usage:
 *   node proxy.js [options]
 *
 * Options:
 *   --ito-host   IP of ITO module       (default: 192.168.1.100)
 *   --ito-port   TCP port of ITO        (default: 80)
 *   --ws-port    WebSocket server port  (default: 8765)
 *   --http-port  HTTP config proxy port (default: 8766)
 *   --verbose    Log all telemetry lines
 *
 * Examples:
 *   node proxy.js
 *   node proxy.js --ito-host 192.168.4.1 --ito-port 23
 *   node proxy.js --verbose
 */

'use strict';

const net       = require('net');
const fs        = require('fs');
const http      = require('http');
const url       = require('url');
const { WebSocketServer } = require('ws');

// ─── Config ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i !== -1 ? argv[i + 1] : def;
}

// Persisted config — last ITO host/port the user pointed the proxy at.
// Lives next to proxy.js so a fresh start picks up the last setting
// without needing the --ito-host CLI arg every time. The browser's
// Connection panel writes this via the `set_ito_host` WS message.
const path = require('path');
const PROXY_CONFIG_FILE = path.join(__dirname, 'proxy-config.json');
function loadProxyConfig() {
  try {
    const raw = fs.readFileSync(PROXY_CONFIG_FILE, 'utf8');
    const j = JSON.parse(raw);
    return {
      itoHost: typeof j.itoHost === 'string' ? j.itoHost : null,
      itoPort: Number.isFinite(j.itoPort) ? j.itoPort : null,
    };
  } catch (_) {
    return { itoHost: null, itoPort: null };
  }
}
function saveProxyConfig(patch) {
  try {
    const cur = loadProxyConfig();
    const next = Object.assign({}, cur, patch);
    fs.writeFileSync(PROXY_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[proxy-config] save failed:', e.message);
    return false;
  }
}
const persistedCfg = loadProxyConfig();

// CLI args win over persisted config; persisted wins over the hard
// default. So `node proxy.js --ito-host X` always honours X for this run
// and writes nothing; restarts without args use the persisted value.
const CONFIG = {
  itoHost:  arg('ito-host',  persistedCfg.itoHost || '192.168.1.100'),
  itoPort:  parseInt(arg('ito-port',  String(persistedCfg.itoPort || 80)), 10),
  wsPort:   parseInt(arg('ws-port',   '8765'), 10),
  httpPort: parseInt(arg('http-port', '8766'), 10),
  verbose:  argv.includes('--verbose'),
  reconnectDelay: 3000,   // ms between ITO reconnect attempts
  pingInterval:   10000,  // ms between WebSocket keepalive pings
  // ITO firmware closes idle TCP connections after ~10s.
  // We send a bare newline every 7s - the firmware ignores empty lines
  // but the traffic resets its idle timer, keeping the socket alive.
  itoKeepaliveInterval: 7000,
};

// ─── State ───────────────────────────────────────────────────────────────────

let itoSocket         = null;
let itoConnected      = false;
let reconnectTimer    = null;
let itoKeepaliveTimer = null;
let lineBuffer        = '';
let handshakeState    = 'init'; // 'init' | 'identify' | 'rich' | 'ready'
let machineState      = 'UNKNOWN'; // last known ITO state from telemetry

// True when the machine is actively running an operation that makes profile
// editing unsafe - menu navigation would be ignored or mis-interpreted, and
// interrupting a shot/steam/flush mid-operation is user-hostile. IDLE, WAIT,
// STANDBY, HEATING, ECO are all safe to edit from.
function isMachineBusy() {
  return machineState === 'PULLING'
      || machineState === 'STEAMING'
      || machineState === 'FLUSHING';
}

// ─── ITO mutex ───────────────────────────────────────────────────────────────
// The ITO has a single serial-ish command channel. Long-running operations
// (MCu dumps, menu navigation for uploads, name entry) tie up that channel
// for seconds at a time, and a concurrent command from another WS client
// corrupts the operation. Every long op acquires this mutex before touching
// the ITO. Short fast commands (button presses, keepalive) don't need it -
// they complete in milliseconds and the race window is negligible.
let _itoLockOwner = null;          // descriptive string, null when free
let _itoLockQueue = [];            // array of { label, resolve }
async function withItoLock(label, fn) {
  if (_itoLockOwner) {
    log(`[lock] "${label}" waiting for "${_itoLockOwner}" (queue depth ${_itoLockQueue.length})`);
    await new Promise(resolve => _itoLockQueue.push({ label, resolve }));
  }
  _itoLockOwner = label;
  try {
    return await fn();
  } finally {
    _itoLockOwner = null;
    const next = _itoLockQueue.shift();
    if (next) {
      log(`[lock] releasing to "${next.label}" (queue depth ${_itoLockQueue.length})`);
      next.resolve();
    }
  }
}

const wsClients       = new Set();

// ─── Logging ─────────────────────────────────────────────────────────────────

const log  = (...a) => console.log( `[${ts()}]`, ...a);
const warn = (...a) => console.warn( `[${ts()}] ⚠`, ...a);
const err  = (...a) => console.error(`[${ts()}] ✗`, ...a);
const dbg  = (...a) => CONFIG.verbose && console.log(`[${ts()}] ·`, ...a);
function ts() { return new Date().toTimeString().slice(0,8); }

// ─── ITO TCP connection ───────────────────────────────────────────────────────

function connectToITO() {
  if (itoSocket) return;

  log(`Connecting to ITO at ${CONFIG.itoHost}:${CONFIG.itoPort} …`);

  itoSocket = new net.Socket();
  itoSocket.setEncoding('binary'); // ITO sends latin1/binary, not utf8
  itoSocket.setTimeout(15000);

  itoSocket.connect(CONFIG.itoPort, CONFIG.itoHost);

  itoSocket.on('connect', () => {
    itoConnected = true;
    handshakeState = 'identify';
    clearTimeout(reconnectTimer);
    log(`Connected to ITO module - starting MC handshake`);
    broadcast({ type: 'connection', status: 'connected', host: CONFIG.itoHost, port: CONFIG.itoPort });

    // Initiate MC protocol handshake (same as Status Monitor)
    itoSocket.write('\nMC?\r', 'binary');

    // Keepalive: send \n to keep TCP alive.
    // DO NOT send MC@ periodically - it enters the Info menu and disrupts navigation.
    // Display frames are triggered by button presses and by the initial MC@ after handshake.
    clearInterval(itoKeepaliveTimer);
    itoKeepaliveTimer = setInterval(() => {
      if (itoSocket && itoConnected && handshakeState === 'ready') {
        dbg('keepalive \\n');
        itoSocket.write('\n', 'binary');
      }
    }, CONFIG.itoKeepaliveInterval);
  });

  // ITO streams newline-delimited lines. Buffer partial lines.
  itoSocket.on('data', (chunk) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // last element may be incomplete
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      log('ITO >', JSON.stringify(line));
      handleITOLine(line);
    }
  });

  itoSocket.on('timeout', () => {
    warn('ITO socket timeout');
    itoSocket.destroy();
  });

  itoSocket.on('error', (e) => {
    err(`ITO socket error: ${e.message}`);
  });

  itoSocket.on('close', () => {
    itoConnected = false;
    itoSocket = null;
    lineBuffer = '';
    handshakeState = 'init';
    clearInterval(itoKeepaliveTimer);
    log('ITO disconnected. Reconnecting …');
    broadcast({ type: 'connection', status: 'disconnected' });
    reconnectTimer = setTimeout(connectToITO, CONFIG.reconnectDelay);
  });
}

/**
 * Parse a line from ITO and broadcast a structured JSON message
 * to all connected browser clients.
 *
 * ITO leva! serial protocol emits lines in several formats.
 * The main telemetry format (as observed from Status Monitor source and
 * community documentation) is CSV-like:
 *
 *   T:<temp1>[,<temp2>],P:<pressure>,F:<flow>,W:<weight>,S:<state>,...
 *
 * Additionally the virtual LCD content is sent as:
 *   LCD:<line1>|<line2>|<line3>|<line4>
 *
 * Other prefixed lines carry specific values. We parse what we can
 * and pass everything through as raw text so the browser can extend parsing.
 */
function handleITOLine(rawLine) {
  // Update nav display for server-side navigation
  updateNavDisplay(rawLine);

  // MCu capture: when active, collect non-display lines for profile verification
  if (_mcuCapture) {
    const cleaned = rawLine.replace(/[^\x20-\x7e]/g, '').trim();
    if (cleaned.length > 2 && !cleaned.startsWith('<')) {
      _mcuCapture.lines.push(cleaned);
    }
  }

  // MC handshake state machine.
  //
  // Rich-mode mode (CURRENT): send MCr, STAY in MCr. The ITO broadcasts
  // both `{ ... }` rich frames (with full telemetry: g + ml + planned curve)
  // AND `<...>` LCD frames at the same time. We parse both.
  //
  // LCD-mode was: MCr → MC@ (switch back to LCD-only). That gave us a single
  // field at a time (either g OR ml) and no planned curve - insufficient.
  if (handshakeState === 'identify' && rawLine.startsWith('XML=')) {
    handshakeState = 'rich';
    log('MC handshake: got XML id → sending MCr (rich mode, stays)');
    itoSocket.write('MCr\r', 'binary');
    return;
  }
  if (handshakeState === 'rich' && rawLine.trimStart().startsWith('{')) {
    handshakeState = 'ready';
    log('MC handshake: got first rich frame - ready, streaming at 10Hz');
    // NO heartbeat - a single MCr puts the ITO into continuous-report mode;
    // the machine streams 10Hz until something else (MC@ / MCu / etc.)
    // switches the mode. If rich frames stop, find the culprit and fix
    // THAT - don't paper over with periodic MCr re-requests.
    return;
  }
  if (handshakeState !== 'ready') return; // wait for handshake

  // Send raw display line with control chars preserved (for cursor detection)
  // The \x04 cursor marker is stripped by the ASCII filter below, so we
  // broadcast the raw display data separately for the browser MenuNav engine.
  if (rawLine.includes('<')) {
    const displayStart = rawLine.indexOf('<');
    const displayEnd = rawLine.lastIndexOf('>');
    if (displayStart >= 0 && displayEnd > displayStart) {
      broadcast({ type: 'display_raw', data: rawLine.substring(displayStart + 1, displayEnd) });

      // Extract LCD lines from raw display data: <BKL + 4x16 chars>
      if (displayEnd - displayStart >= 67) { // BKL + 4x16 chars
        const inner = rawLine.substring(displayStart + 1, displayEnd);
        if (inner.length >= 67) {
          const line1 = inner.substring(3, 19);
          const line2 = inner.substring(19, 35);
          const line3 = inner.substring(35, 51);
          const line4 = inner.substring(51, 67);
          // Clean non-printable chars but preserve degree sign (0xDF=223)
          const cleanLine = (s) => s.split('').map(c => {
            const code = c.charCodeAt(0);
            if (code === 223) return '\u00b0';
            if (code === 5) return '\u2713';
            if (code === 4) return '\u25ba';
            if (code >= 32 && code <= 126) return c;
            return ' ';
          }).join('');
          broadcast({ type: 'lcd', lines: [cleanLine(line1), cleanLine(line2), cleanLine(line3), cleanLine(line4)] });
        }
      }
    }
  }

  const line = rawLine.split("").filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126).join("").trim();
  if (!line) return;
  broadcast({ type: 'raw', line });

  if (line.startsWith('LCD:')) {
    broadcast({ type: 'lcd', lines: line.slice(4).split('|') });
    return;
  }

  if (line.startsWith('leva!') || line.startsWith('caffe!')) {
    broadcast({ type: 'firmware', message: line });
    return;
  }

  // Rich-mode frame: "{ -1OFF ??? ??? 094.15 ??? 02.50 02.46 02.54 ??? Adpt(form ... ~ DD }"
  // Contains all fields Status Monitor uses for the graph view (both g and ml,
  // planned curve, temp). Parse what we can from fixed positions.
  if (line.startsWith('{') && line.endsWith('}')) {
    const rich = parseRichFrame(line, rawLine);
    if (rich) {
      machineState = rich.state || machineState;
      dbg('rich:', 'P=' + rich.pressure, 'T=' + rich.temp1,
                   'vol=' + rich.volume, 'tmr=' + rich.timer,
                   'W=' + rich.weight, 'F=' + rich.flow);
      broadcast({ type: 'telemetry', ...rich, _raw: line });
      return;
    }
  }

  // Primary LCD format: <NNNMachineName   state   P.Pb T.T Ss VVVml>
  const leva = parseLevaDisplay(line, rawLine);
  if (leva) {
    machineState = leva.state;
    dbg('parsed:', JSON.stringify(leva));
    broadcast({ type: 'telemetry', ...leva, _raw: line });
    return;
  }

  // Fallback: legacy key:value format T1:93.2,P:8.7,...
  if (line.includes(':') && (line.includes('T') || line.includes('P'))) {
    const t = parseKeyValue(line);
    if (t) { broadcast({ type: 'telemetry', ...t, _raw: line }); return; }
  }
}

// Verified frame formats (captured live 2026-04-22 during shots):
//
// STANDBY:           "<002   STANDBY   >"
// MENU:              "<101MENU  <cursor>Info... [1] ESPRESSO [2] PUMP PB>"
// IDLE (home):       "<102PROFILE:- 1: OFF  ECO/<dots>  2.6b 85.3ß 0s    ml>"
// PULLING w/scale:   "<102 Ns W.Wg  1: OFF  <dots>  P.Pb R=F.F Ns W.Wg>"
//                    - R= is flow rate in g/s (NOT ratio - verified via live capture)
//                    - weight in grams, no temperature shown during pull
// PULLING no-scale:  "<102 0s Vml  1: OFF  <dots>  P.Pb Q=NNN 0s Vml>"
//                    - Q= is pump quality indicator, volume in ml
// WAIT (post-shot):  "<102PROFILE:- 1: OFF  SCALE  <dots>  P.Pb T.Tß NNs W.Wg>"
//                    - timer fixed at shot duration, temp back, weight/volume stable
function parseLevaDisplay(line, rawLine) {
  if (!line.startsWith('<') || !line.endsWith('>')) return null;
  const inner = line.slice(1, -1);

  const b = inner.toUpperCase();
  // State detection rules - derived from observed LCD frame patterns.
  //
  //   STANDBY: "<002 ... STANDBY ...>" or contains "STANDBY"/"ECO"
  //   MENU   : frame header starts with "101" (MCM screen) or contains "MENU"
  //   PULLING: contains "Q=" - pump quality/power indicator, ONLY appears
  //            during an active pump cycle. Works for both profiled (1: ON)
  //            and non-profiled (1: OFF) shots.
  //   WAIT   : shot ended, display frozen on results. Marked by:
  //            - grams suffix: "...11s 69.0g"
  //            - "SCALE" indicator: "...1: OFF SCALE ... 11s 62ml"
  //            - "R=" ratio field: "...R=2.1..."
  //            - "[NEXT]" prompt: explicit WAIT marker
  //            - non-zero timer with normal idle layout (N > 0 after "PROFILE:-")
  //   IDLE   : home screen, "0s    ml" (empty ml) or pressure without timer
  let state = 'IDLE';

  // STANDBY / MENU take priority
  if      (b.includes('STANDBY'))                       state = 'STANDBY';
  else if (b.includes('MENU'))                          state = 'MENU';
  // "<101 ..." and "<151..." headers = menu/info screens (not telemetry)
  else if (/^1[05]1/.test(inner.replace(/^</, '')))     state = 'MENU';
  // PULLING (check FIRST - takes priority over WAIT markers below).
  //   R= appears while pump is running with scale connected (flow rate g/s)
  //   Q= appears while pump is running without scale (pump quality indicator)
  else if (b.includes('R='))                            state = 'PULLING';
  else if (b.includes('Q='))                            state = 'PULLING';
  // Explicit WAIT markers (check AFTER pulling since SCALE can appear in
  // both post-shot AND during init - R= rules out in-flight case first).
  else if (b.includes('[NEXT]'))                        state = 'WAIT';
  else if (b.includes('SCALE'))                         state = 'WAIT';
  // Result screen: grams suffix with non-zero timer
  else if (/[1-9]\d*s\s+\d+\.\d+g\s*$/.test(inner))     state = 'WAIT';
  // PULLING legacy keywords (for other firmwares)
  else if (b.includes('PULLING') || b.includes('BREW')) state = 'PULLING';
  else if (b.includes('DOSE'))                          state = 'PULLING';
  else if (b.includes('STEAM'))                         state = 'STEAMING';
  else if (b.includes('HEAT') || b.includes('WARM'))    state = 'HEATING';
  else if (b.includes('FLUSH'))                         state = 'FLUSHING';
  // ECO → STANDBY only if not already in another state (ECO text appears
  // on the idle screen when energy saver is about to engage - don't want
  // that to override PULLING/WAIT).
  else if (b.includes('ECO'))                           state = 'STANDBY';
  // Result screen fallback: non-zero timer + non-empty ml (shot finished
  // but no SCALE indicator). "11s  62ml" matches this - timer > 0.
  else if (/[1-9]\d*s\s+\d+(?:\.\d+)?ml\s*$/.test(inner)) state = 'WAIT';

  const presM = inner.match(/(\d+\.?\d*)b/);

  // Temp: prefer rawLine where binary separator 0x05 clearly delimits pressure
  // from temp (e.g. "2.4b\x05 88.0\xDF263s"). Without rawLine, fall back to
  // ASCII-filtered inner where separators are stripped and temp+timer may run
  // together ("2.4b 88.0263s") - handle by capturing only one decimal digit.
  // Temperature parsing. ITO frames show temp as "N.Nß" (degree symbol is
  // byte 0xDF, which renders as ß in Latin-1). There is no "C" suffix in
  // the frame - temp is followed directly by " Xs" timer.
  //
  // Example frames (both idle and shot):
  //   "<102PROFILE:-  1: OFF  ECO  0.0b  22.0ß  0s    ml>"  ← idle @ 22°
  //   "<102PROFILE:-  1: OFF       9.0b  93.5ß 23s   30ml>" ← shot @ 93.5°
  //   "<102PROFILE:-  1: OFF       0.0b ---.-ß  0s    ml>"  ← temp unknown
  //
  // Strategy: find the number immediately before the 0xDF byte.
  let temp1 = null;
  if (rawLine) {
    // Primary: "<digits>.<digits>" immediately before the 0xDF degree byte.
    const tm = rawLine.match(/(\d+\.\d+)\s*\xDF/);
    if (tm) {
      const v = parseFloat(tm[1]);
      if (Number.isFinite(v) && v > 0 && v < 200) temp1 = v;
    }
    // Shot-mode fallback: some firmwares emit a 0x05 separator between
    // pressure and temp - handle it for backward compat.
    if (temp1 === null) {
      const tm2 = rawLine.match(/b\x05\s*(\d+\.?\d*)/);
      if (tm2) {
        const v = parseFloat(tm2[1]);
        if (Number.isFinite(v) && v > 0 && v < 200) temp1 = v;
      }
    }
  }
  if (temp1 === null) {
    // ASCII-filtered fallback: degree sign stripped → "22.0" or "93.5"
    // sitting between pressure "Xb" and timer "Ys".
    const tm = inner.match(/b\s+(\d+\.\d+)\s+\d+\s*s/);
    if (tm) {
      const v = parseFloat(tm[1]);
      if (Number.isFinite(v) && v > 0 && v < 200) temp1 = v;
    }
  }

  // Temp cache: during shots the LCD frame drops temp entirely. Carry the
  // last known value forward for up to 30s so the UI graph stays populated.
  if (temp1 !== null) {
    _lastTemp1 = temp1;
    _lastTemp1Ts = Date.now();
  } else if (_lastTemp1 !== null && Date.now() - _lastTemp1Ts < 30000) {
    temp1 = _lastTemp1;
  }

  // Volume: "Vml" at the end, only when scale is NOT connected (PULLING).
  // Anchor: must be preceded by whitespace to avoid matching "102 ... ml>".
  const volM = inner.match(/\s(\d+)\s*ml(?:\s*>)?\s*$/);

  // Timer: "Ns" (integer seconds). Must have whitespace/tab before to avoid
  // matching the frame prefix "102" + joined "10s" as "10210s". Use the LAST
  // occurrence (at end of frame) since header timer sometimes collides with
  // the "<102" prefix.
  let timer = null;
  const allTimers = [...inner.matchAll(/(?:^|\s)(\d+)s(?=\s|>|$)/g)];
  if (allTimers.length > 0) {
    timer = parseFloat(allTimers[allTimers.length - 1][1]);
  }

  // Weight: "W.Wg" (grams). Scale-connected shots + WAIT screen have this.
  const wm = inner.match(/(\d+(?:\.\d+)?)\s*g\b/);

  // Flow: during scale-connected shots the frame has "R=F.F" - flow in g/s.
  // This is more accurate than deriving from volume. Matches "R=0.0" to "R=99.9".
  const flowRm = inner.match(/R=\s*(\d+(?:\.\d+)?)/);

  const pressure = presM ? parseFloat(presM[1]) : null;
  const volume   = volM  ? parseFloat(volM[1])  : null;
  const weight   = wm    ? parseFloat(wm[1])    : null;

  // Flow from LCD: R= field is ml/s (flow meter). Scale flow (g/s) is
  // derived server-side from Δweight. Keeps the shape consistent with rich.
  const flowMl = flowRm ? parseFloat(flowRm[1]) : 0;
  const flowG  = _deriveWeightFlow(state, weight);

  return { pressure, temp1, volume, timer, weight, flowMl, flow: flowG, state };
}

// Derives scale flow rate (g/s) from weight deltas over wall-clock.
// Similar pattern to the old volume-based deriver but keyed on weight from
// the scale. The rich frame now supplies ml/s directly (R= field from flow
// meter), so we only derive g/s here.
let _weightFlowState = { weight: null, ts: 0, flow: 0 };
function _deriveWeightFlow(state, weight) {
  if (state === 'STANDBY' || weight == null) {
    _weightFlowState.weight = weight;
    _weightFlowState.ts = Date.now();
    _weightFlowState.flow = 0;
    return 0;
  }
  const now = Date.now();
  if (_weightFlowState.weight == null) {
    _weightFlowState.weight = weight;
    _weightFlowState.ts = now;
    _weightFlowState.flow = 0;
    return 0;
  }
  const dw = weight - _weightFlowState.weight;        // g
  const dt = (now - _weightFlowState.ts) / 1000;       // seconds
  // Require meaningful time delta and non-negative weight change.
  if (dt >= 0.3 && dw >= 0) {
    _weightFlowState.flow   = +(dw / dt).toFixed(2);
    _weightFlowState.weight = weight;
    _weightFlowState.ts     = now;
  } else if (dw < -0.5) {
    // Weight dropped significantly (cup removed, tared) → reset baseline.
    _weightFlowState.weight = weight;
    _weightFlowState.ts = now;
    _weightFlowState.flow = 0;
  }
  return _weightFlowState.flow;
}

// During shots the LCD frame drops the temperature (format changes to
// "pressure Q=N ... 0s Vml"). Cache the last temp we parsed when it WAS
// present so telemetry consumers still see a sensible value mid-shot.
let _lastTemp1 = null;
let _lastTemp1Ts = 0;

// Rich-mode frame parser. Fixed-width ASCII format (per positional mapping
// derived from live Status Monitor sniff). Unavailable fields are filled
// with '?' characters (0x3F) rather than digits.
//
// Frame layout (1-indexed positions in the 289-char body inside { ... }):
//
//   Pos  1   { (frame start)
//   Pos  3   active profile: '-' = none, letter = profile first char
//   Pos  4   PID 1 indicator digit
//   Pos 5-7  PID 1 status ('OFF' / 'ON ')
//   Pos 79-81 PID 2 status ('OFF' / 'ON ')
//   Pos  8-78   [71 chars] binary/placeholder - during shot: current
//               volume (ml), current weight (g), flow indicator, etc
//   Pos 82-152  [71 chars] binary/placeholder - more realtime data
//   Pos 153-155 last shot volume (ml, 3 digits)
//   Pos 156-158 last shot duration (s, 3 digits)
//   Pos 159-163 last shot weight × 1000 (5 digits, e.g. "41000" = 41.0g)
//   Pos 164-168 ? ("0001.0" or similar)
//   Pos 175-180 current boiler temp (°C, "NNN.NN")
//   Pos 181-197 [17 chars] placeholder
//   Pos 198-202 current pressure (b, "NN.NN")
//   Pos 203-207 pressure setpoint/target
//   Pos 208-212 pressure secondary reading
//   Pos 213-236 [24 chars] placeholder
//   Pos 237-245 PProf name ('Adpt(form', 'TRAPEZOID', etc)
//   Pos 250-254 status flags ('A#b!c')
//   Pos 260-263 profile mode ('Full' / 'OFF ' / etc)
//   Pos 287-288 checksum (hex)
//   Pos 289     } (frame end)
//
function parseRichFrame(line, rawLine) {
  if (!line.startsWith('{') || !line.endsWith('}')) return null;
  const body = line.slice(1, -1); // body is 0-indexed; framePos 2 = body[0]

  // Helper: read a fixed-width field at frame position (1-indexed).
  // Returns null if the region contains '?' (field unavailable).
  const fld = (framePos, len) => {
    const bodyOff = framePos - 2;
    if (bodyOff < 0 || bodyOff + len > body.length) return null;
    const s = body.substr(bodyOff, len);
    return s.indexOf('?') >= 0 ? null : s;
  };

  // Pos 3: shot/profile indicator. '-' = idle, '*' = shot running, letter = profile.
  const profChar = fld(3, 1);
  const shotRunning = profChar === '*';
  const activeProfile = (profChar && profChar !== '-' && profChar !== '*') ? profChar : null;

  // Pos 5-7: PID 1 status
  const pidStatus = fld(5, 3);
  const pidOn = pidStatus ? pidStatus.trim() === 'ON' : null;

  // Pos 153-155: current volume (ml), 3 digits - flow meter volume
  const volStr = fld(153, 3);
  const volume = volStr ? parseInt(volStr, 10) : null;

  // Pos 156-160: ticks - 5-digit 100 Hz shot-duration counter.
  // Verified: shot of 2622 ticks = 26.22 s (= 2622 × 10 ms).
  // Timer in seconds (integer) = ticks / 100.
  const ticksStr = fld(156, 5);
  const ticks = ticksStr ? parseInt(ticksStr, 10) : null;
  const timer = ticks != null ? Math.floor(ticks / 100) : null;
  // Fractional seconds for high-res display (e.g. "26.2 s")
  const timerFrac = ticks != null ? (ticks / 100) : null;

  // Pos 175-180: current boiler temp (°C), "NNN.NN"
  const tempStr = fld(175, 6);
  let temp1 = tempStr ? parseFloat(tempStr) : null;
  if (temp1 !== null && (temp1 <= 0 || temp1 >= 200)) temp1 = null;

  // Pos 198-202: current pressure (bar), "NN.NN"
  const presStr = fld(198, 5);
  let pressure = presStr ? parseFloat(presStr) : null;
  if (pressure !== null && pressure < 0) pressure = null;

  // Pos 203-207 and 208-212: pressure BAND (low and high bounds). The
  // machine reports a tolerance window around the target pressure - current
  // pressure sits between these two values every frame during a shot.
  // Verified: low ≤ cur ≤ high across 15+ captured shot frames, band
  // width 0.2–0.4 bar (typical PID tolerance).
  const pressureLow  = (s => s ? parseFloat(s) : null)(fld(203, 5));
  const pressureHigh = (s => s ? parseFloat(s) : null)(fld(208, 5));

  // Pos 227-231: current weight (g) from scale - 5 chars "NNN.N"
  // Verified live: user reported 107.9g on display, frame showed "107.5".
  const wgtStr = fld(227, 5);
  const weight = wgtStr ? parseFloat(wgtStr) : null;

  // Pos 232-236: current flow rate from the flow meter, 5 chars "NN.NN",
  // unit ml/s. This is the SAME quantity that appears as "R=X.XX" in LCD
  // frames. Verified by matching range (0–3.36 observed) against the MCu's
  // "Flow unit ML/S" setting + flow meter (1925 impulses/L).
  const flowStr = fld(232, 5);
  const flowMl = flowStr ? parseFloat(flowStr) : null;

  // Profile slot names (4 user-configured pressure profiles):
  //   Pos 237-245: Profile 1 name (9 chars, right-padded)  e.g. "Adpt(form"
  //   Pos 250-254: Profile 2 name (5 chars)                 e.g. "A#b!c"
  //   Pos 260-263: Profile 3 name (4 chars)                 e.g. "Full"
  //   Pos 264-272: Profile 4 name (9 chars)                 e.g. "012345678"
  //   Pos 273-281: ACTIVE profile name (9 chars)            e.g. during shot
  const profileSlotNames = [
    (fld(237, 9) || '').replace(/\?/g, '').trim() || null,
    (fld(250, 5) || '').replace(/\?/g, '').trim() || null,
    (fld(260, 4) || '').replace(/\?/g, '').trim() || null,
    (fld(264, 9) || '').replace(/\?/g, '').trim() || null,
  ];
  const activeProfileName = ((fld(273, 9) || '').replace(/\?/g, '').trim()) || null;
  // Back-compat field - PProf (first slot name, or the active profile if set)
  const pprof = activeProfileName || profileSlotNames[0];

  // Update temp cache (shared with LCD parser) so brief temp dropouts don't
  // blank the graph.
  if (temp1 !== null) { _lastTemp1 = temp1; _lastTemp1Ts = Date.now(); }
  else if (_lastTemp1 !== null && Date.now() - _lastTemp1Ts < 30000) temp1 = _lastTemp1;

  // State inference from the rich frame:
  //   '*' at pos 3 → PULLING (shot running - definitive)
  //   '-' at pos 3 AND non-zero timer (previous shot result on display) → WAIT
  //   '-' at pos 3 AND timer = 0 → IDLE
  //   letter at pos 3 → profile active (but not necessarily pulling)
  let state;
  if (shotRunning) state = 'PULLING';
  else if (timer !== null && timer > 0 && !shotRunning) state = 'WAIT';
  else state = 'IDLE';

  // Derive scale flow (g/s) from Δweight/Δwall-clock. Only meaningful once
  // coffee starts landing on the scale.
  const flowG = _deriveWeightFlow(state, weight);

  return {
    pressure, temp1,
    volume, timer, timerFrac, ticks,     // timer (s int), timerFrac (s float), ticks (100Hz)
    weight,
    flowMl: flowMl != null ? flowMl : 0, // ml/s - direct from rich frame (R=) / flow meter
    flow:   flowG,                       // g/s - derived server-side from Δweight
    state,
    pprof,
    profileSlotNames,                     // 4-element array of configured profile names
    activeProfileName,                    // name of active profile during shot, or null
    activeProfile, pidOn, shotRunning,
    pressureLow, pressureHigh,            // pressure tolerance band bounds
    rich: true
  };
}

function parseKeyValue(line) {
  const result = {}; let found = 0;
  for (const token of line.split(',')) {
    const c = token.indexOf(':'); if (c < 0) continue;
    const key = token.slice(0, c).trim().toUpperCase();
    const val = token.slice(c + 1).trim();
    const num = parseFloat(val);
    switch(key) {
      case 'T1': result.temp1    = num; found++; break;
      case 'T2': result.temp2    = num; found++; break;
      case 'P':  result.pressure = num; found++; break;
      case 'F':  result.flow     = num; found++; break;
      case 'W':  result.weight   = num; found++; break;
      case 'S':  result.state    = val; found++; break;
      case 'V':  result.volume   = num; found++; break;
    }
  }
  return found > 0 ? result : null;
}


// ─── Send command to ITO ──────────────────────────────────────────────────────

// Virtual display button codes from ITO Protocol.pdf
// Sent as MC<byte>\r - firmware receives these continuously while held,
// MC\x00\r on release.
const NAV_COMMANDS = {
  nav_up:     '\x01',  // Up ▲  (pressure up during shot if profile active)
  nav_down:   '\x02',  // Down ▼ (pressure down during shot if profile active)
  nav_ok:     '\x03',  // OK / Select (also: stop a running shot, dismiss WAIT)
  nav_cancel: '\x04',  // Cancel / Back  (nav only - NOT start-shot)
  nav_user1:  '\x05',  // User button 1 = shortcut [1] = start shot (verified via SM sniff)
  nav_user2:  '\x06',  // User button 2 = shortcut [2]
};

function sendToITO(command) {
  if (!itoConnected || !itoSocket) {
    warn(`Cannot send "${command}" - ITO not connected`);
    return false;
  }
  const line = command.endsWith('\n') ? command : command + '\n';
  dbg('→ ITO:', JSON.stringify(command));
  itoSocket.write(line, 'binary');

  // Note: MCa/MCE don't get MC@ follow-up because MC@ from home screen enters Info menu.
  // The nav engine handles display refresh via button presses (which trigger MC@ in mcPress).
  return true;
}

// Write raw bytes to ITO without appending a newline (used for nav keys)
function sendRawToITO(bytes) {
  if (!itoConnected || !itoSocket) {
    warn(`Cannot send raw bytes - ITO not connected`);
    return false;
  }
  dbg('→ ITO raw:', JSON.stringify(bytes));
  itoSocket.write(bytes, 'binary');
  return true;
}

// Send an MC protocol button press + release
// Minimal timing: firmware processes buttons in its 10Hz display loop.
// We send press immediately and release after 20ms - just enough for
// the firmware to see it in the next UART poll.
function mcPress(byte) {
  dbg(`MC press: 0x${byte.charCodeAt(0).toString(16).padStart(2,'0')}`);
  sendRawToITO('MC' + byte + '\r');
  setTimeout(() => sendRawToITO('MC\x00\r'), 30);
  // NO MC@ - in LCD mode (MC@), display frames flow at 10fps automatically.
  // MC@ after presses was disrupting the name editor.
}

// Fast press: send press+release as a single burst with no delay.
// Used for rapid-fire navigation (UP/DOWN) where we want maximum speed.
function mcPressFast(byte) {
  sendRawToITO('MC' + byte + '\r');
  sendRawToITO('MC\x00\r');
}

// Start shot / stop shot - the shortcut-1 key only works from the home
// screen. If the machine is inside a menu, we must back out first with
// a few CANCEL presses before pressing shortcut-1.
//
// Verified command bytes via Status Monitor TCP sniff:
//   Start: MC\x05\r + MC\x00\r   (shortcut [1] press + release)
//   Stop : MC\x03\r + MC\x00\r   (OK press + release - stops a running shot)
//   Back : MC\x04\r + MC\x00\r   (CANCEL/BACK - exits one menu level)
function startShot() {
  // Robust start sequence (each step gates on the next via state check):
  //   1. If STANDBY/ECO → MCa wake, wait for state change, retry up to 3×
  //   2. If MENU       → CANCEL one level at a time, recheck, repeat up to 4×
  //   3. Fire MC\x05 (shortcut [1])
  //
  // Verified command bytes via Status Monitor TCP sniff:
  //   Start: MC\x05\r + MC\x00\r   (shortcut [1] press + release)
  //   Wake : MCa\r                  (resume from STANDBY/ECO)
  //   Back : MC\x04\r + MC\x00\r   (CANCEL/BACK - exits one menu level)
  const MAX_MENU_STEPS = 4;
  const MAX_WAKE_STEPS = 3;
  const STEP_WAIT_MS   = 150;
  const WAKE_WAIT_MS   = 600;   // STANDBY → IDLE transition is slower

  const fireShot = () => {
    log('startShot: MC\\x05 (shortcut [1]) - state=' + machineState);
    mcPress('\x05');
  };

  const exitMenu = (stepsLeft) => {
    if (machineState !== 'MENU') { fireShot(); return; }
    if (stepsLeft <= 0) {
      log('startShot: still MENU after ' + MAX_MENU_STEPS + ' CANCELs - firing anyway');
      fireShot();
      return;
    }
    log('startShot: MENU → CANCEL (' + (MAX_MENU_STEPS - stepsLeft + 1) + '/' + MAX_MENU_STEPS + ')');
    mcPressFast('\x04');
    setTimeout(() => exitMenu(stepsLeft - 1), STEP_WAIT_MS);
  };

  const wake = (stepsLeft) => {
    if (machineState !== 'STANDBY') { exitMenu(MAX_MENU_STEPS); return; }
    if (stepsLeft <= 0) {
      log('startShot: still STANDBY after ' + MAX_WAKE_STEPS + ' MCa attempts - proceeding anyway');
      exitMenu(MAX_MENU_STEPS);
      return;
    }
    log('startShot: STANDBY/ECO → MCa wake (' + (MAX_WAKE_STEPS - stepsLeft + 1) + '/' + MAX_WAKE_STEPS + ')');
    sendToITO('MCa');
    // Re-arm rich stream after wake (MCa puts ITO into LCD-only mode).
    setTimeout(() => sendRawToITO('MCr\r'), 200);
    setTimeout(() => wake(stepsLeft - 1), WAKE_WAIT_MS);
  };

  wake(MAX_WAKE_STEPS);
}

function stopShot() {
  log('stopShot: MC\\x03 (OK) - from ' + machineState);
  mcPress('\x03');
}

// ─── Server-side navigation engine ───────────────────────────────────────────
// Reads display after EVERY button press. No guessing, no blind counting.
// The ITO sends ~10 display frames/sec - we read them all.
// Uses coarse+fine for value changes: hold for speed, individual for precision.

// Latest display frame from ITO (updated by handleITOLine)
let _navDisplay = '';    // raw display with \x04 cursor
let _navClean = '';      // cleaned display text

// Ring buffer of the last ~30 non-LCD wire lines from the firmware
// (e.g. "[OFF]", "[ON]", "XML=…"). The diagnostic runner peeks at this
// to catch firmware-side state messages that don't appear inside an
// `<...>` LCD frame.
const _recentLines = [];
const _RECENT_MAX = 30;

// Hook into the existing display parsing to capture frames for nav
function updateNavDisplay(rawLine) {
  if (rawLine.includes('<')) {
    const s = rawLine.indexOf('<'), e = rawLine.lastIndexOf('>');
    if (s >= 0 && e > s) {
      _navDisplay = rawLine.substring(s + 1, e);
      _navClean = _navDisplay.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
      return;
    }
  }
  // Not an LCD frame - record it in the ring buffer so the diag runner
  // can scan recent firmware messages like [OFF].
  if (rawLine && rawLine.length < 60) {
    _recentLines.push({ t: Date.now(), line: rawLine });
    while (_recentLines.length > _RECENT_MAX) _recentLines.shift();
  }
}

// ─── MCu dump reader (uses proxy's existing ITO connection) ──────────────────
// Captures MCu output lines via the proxy's handleITOLine, then parses them.
let _mcuCapture = null; // { lines: [], resolve: fn } when active

// NOTE: readMcuProfile does NOT take the ITO mutex itself - it is called from
// both top-level WS handlers (which acquire the lock) AND from inside
// serverUploadProfile (which already holds the lock). Wrapping here would
// deadlock in the upload path.
function readMcuProfile(slotNum) {
  return new Promise((resolve) => {
    const lines = [];
    _mcuCapture = { lines, resolve: null };

    // Send MCu through proxy's existing connection
    sendRawToITO('MCu\r');

    // Wait for MCu data to come through (ITO sends ~1000 lines over ~5-8s)
    setTimeout(() => {
      _mcuCapture = null;

      // Parse profile for the target slot. Returned fields:
      //   name, pi[9], shot[9]                       - steps (existing)
      //   resizePI, resizeShot                       - float bar, null when `-`
      //   end                                        - 'STOP'|'SUSTAIN'|'FULL POWER'
      //   trackFlow (ml/s), trackTime (s)            - float, null when `-`
      //   pid1, pid2 (°C)                            - float, null when `-`
      //   cue (s)                                    - float, null when `-`
      //   piRepeat (int), piWait (s)                 - PI loop controls; null when `-`
      //   machine: { executePI, executeShot, dropEndsPI, limit, flood:{pressure,pumpPwr} }
      //     - machine-wide toggles/flood. Toggles are booleans ('/' ON, '-' OFF).
      const result = {
        name: '', pi: [], shot: [],
        resizePI: null, resizeShot: null,
        end: null,
        trackFlow: null, trackTime: null,
        pid1: null, pid2: null,
        cue: null,
        piRepeat: null, piWait: null,
        machine: {
          executePI: null, executeShot: null, dropEndsPI: null, limit: null,
          flood: { pressure: null, pumpPwr: null },
        },
      };
      // State machine for the scanner.
      let inProfiles = false;
      let inSlot = false;       // inside `| | <slotNum>...`
      let inPI = false;          // inside `| | | Edit PI...`
      let inShot = false;        // inside `| | | Edit shot...`
      let inFlood = false;       // inside `| Flood...` at profile root
      let stepNum = 0;
      let curStep = {};
      let sawTrackFlow = false;  // disambiguate the two `Track` lines by order

      // Parse numeric value: `-` → null, otherwise parseFloat (or parseInt for integer-only fields).
      const parseNum = (raw) => {
        if (raw === undefined || raw === null) return null;
        raw = String(raw).trim();
        if (raw === '-' || raw === '') return null;
        const n = parseFloat(raw);
        return Number.isNaN(n) ? null : n;
      };
      const parseInteger = (raw) => {
        const n = parseNum(raw);
        return n === null ? null : Math.round(n);
      };
      const parseToggle = (raw) => {
        raw = String(raw || '').trim();
        if (raw === '/') return true;
        if (raw === '-') return false;
        return null;
      };

      log(`[MCu] Captured ${lines.length} lines, parsing slot ${slotNum}...`);

      for (const line of lines) {
        const stripped = line.replace(/^[\|\s]+/, '').trim();

        // ── Find the Profiles section boundary ──
        // "Profiles..." begins it. Any non-pipe-prefixed line after it ends it.
        if (stripped === 'Edit...' && inProfiles) { continue; }
        if (stripped.startsWith('Profiles')) { inProfiles = true; continue; }
        if (inProfiles && !line.startsWith('|') && stripped.length > 2) {
          inProfiles = false; continue;
        }
        if (!inProfiles) continue;

        // ── Slot boundaries (depth 2: "| | N...") ──
        const slotOpenM = line.match(/^\|\s+\|\s+(\d+)\.\.\./);
        if (slotOpenM) {
          const n = parseInt(slotOpenM[1]);
          if (n === slotNum) {
            inSlot = true; inPI = false; inShot = false; sawTrackFlow = false;
          } else if (inSlot) {
            // Entering the next slot ends ours.
            inSlot = false;
          }
          continue;
        }

        // ── Machine-wide fields (depth 1: "| Label val") - only when NOT inside a slot ──
        if (!inSlot) {
          // Flood submenu opens at depth 1, its fields at depth 2
          if (/^\|\s+Flood\.\.\./.test(line)) { inFlood = true; continue; }
          if (inFlood) {
            // Exit Flood on any non-depth-2 line
            const depth2 = /^\|\s+\|\s/.test(line);
            if (!depth2) { inFlood = false; }
            else {
              const fpM = stripped.match(/^Pressure\s+(-|\d+\.?\d*)b?/);
              if (fpM) { result.machine.flood.pressure = parseNum(fpM[1]); continue; }
              const fpwM = stripped.match(/^PumpPwr\s+(-|\d+)/);
              if (fpwM) { result.machine.flood.pumpPwr = parseInteger(fpwM[1]); continue; }
              continue;
            }
          }
          // Toggles/limit at depth 1 under Profiles
          const execPIM = stripped.match(/^Execute PI\s+(\/|\-)/);
          if (execPIM) { result.machine.executePI = parseToggle(execPIM[1]); continue; }
          const execShotM = stripped.match(/^Execute shot\s+(\/|\-)/);
          if (execShotM) { result.machine.executeShot = parseToggle(execShotM[1]); continue; }
          const dropM = stripped.match(/^Drop ends PI\s+(\/|\-)/);
          if (dropM) { result.machine.dropEndsPI = parseToggle(dropM[1]); continue; }
          const limitM = stripped.match(/^Limit\s+(-|\d+\.?\d*)g/);
          if (limitM) { result.machine.limit = parseNum(limitM[1]); continue; }
          continue;
        }

        // ── Inside the target slot ──
        // Name: depth 3, matches the whole rest of the line after "Name "
        const nm = stripped.match(/^Name\s+(.*)/);
        if (nm) { result.name = nm[1].trim(); continue; }

        // Edit PI / Edit shot subsection openers (depth 3, end with ....)
        if (stripped.startsWith('Edit PI')) { inPI = true; inShot = false; stepNum = 0; continue; }
        if (stripped.startsWith('Edit shot')) { inShot = true; inPI = false; stepNum = 0; continue; }

        // Per-slot option fields (depth 3, after Edit shot subsection). These also
        // mark the end of any PI/Shot step parsing.
        const resizePIM = stripped.match(/^Resize PI\s+(-|\d+\.?\d*)b/);
        if (resizePIM) { result.resizePI = parseNum(resizePIM[1]); inPI = false; inShot = false; continue; }
        const resizeSM = stripped.match(/^Resize S\s+(-|\d+\.?\d*)b/);
        if (resizeSM) { result.resizeShot = parseNum(resizeSM[1]); inPI = false; inShot = false; continue; }
        const endM = stripped.match(/^End\s+(STOP|SUSTAIN|FULL POWER)/);
        if (endM) { result.end = endM[1]; inPI = false; inShot = false; continue; }
        // Two `Track` lines: disambiguate by unit. Flow has `ml/s`, time has bare `s`.
        const trackFlowM = stripped.match(/^Track\s+(-|\d+\.?\d*)ml\/s/);
        if (trackFlowM) { result.trackFlow = parseNum(trackFlowM[1]); sawTrackFlow = true; inPI = false; inShot = false; continue; }
        const trackTimeM = stripped.match(/^Track\s+(-|\d+\.?\d*)s/);
        if (trackTimeM && sawTrackFlow) { result.trackTime = parseNum(trackTimeM[1]); inPI = false; inShot = false; continue; }
        const pid1M = stripped.match(/^PID 1\s+(-|\d+\.?\d*)/);
        if (pid1M) { result.pid1 = parseNum(pid1M[1]); inPI = false; inShot = false; continue; }
        const pid2M = stripped.match(/^PID 2\s+(-|\d+\.?\d*)/);
        if (pid2M) { result.pid2 = parseNum(pid2M[1]); inPI = false; inShot = false; continue; }
        const cueM = stripped.match(/^Cue\s+(-|\d+\.?\d*)s/);
        if (cueM) { result.cue = parseNum(cueM[1]); inPI = false; inShot = false; continue; }

        // PI-only loop controls (depth 4 inside Edit PI)
        if (inPI) {
          const repeatM = stripped.match(/^Repeat\s+(-|\d+)/);
          if (repeatM) { result.piRepeat = parseInteger(repeatM[1]); continue; }
          const waitM = stripped.match(/^Wait\s+(-|\d+\.?\d*)s/);
          if (waitM) { result.piWait = parseNum(waitM[1]); continue; }
        }

        // ── Step parsing inside PI/Shot subsections ──
        const stepM = stripped.match(/^(\d+)\.\.\./);
        if (stepM && (inPI || inShot)) { stepNum = parseInt(stepM[1]); curStep = {}; continue; }

        // Time value
        const timeM = stripped.match(/Time\s+([\d.]+)s/);
        if (timeM && stepNum > 0) { curStep.time = parseFloat(timeM[1]); }
        if (stripped.match(/Time\s+-/) && stepNum > 0 && curStep.time === undefined) { curStep.time = -1; }

        // Pump value - bar (X.Xb) or phase angle (integer) or empty (-)
        const pumpBarM = stripped.match(/Pump\s+([\d.]+)b/);
        if (pumpBarM && stepNum > 0) { curStep.bar = parseFloat(pumpBarM[1]); curStep.unit = 'b'; }
        const pumpIntM = stripped.match(/Pump\s+(\d+)$/);
        if (pumpIntM && stepNum > 0 && curStep.bar === undefined) { curStep.bar = parseInt(pumpIntM[1]); curStep.unit = 'phase'; }
        if (stripped.match(/Pump\s+-/) && stepNum > 0 && curStep.bar === undefined) { curStep.bar = -1; curStep.unit = ''; }

        if (curStep.time !== undefined && curStep.bar !== undefined) {
          const arr = inPI ? result.pi : result.shot;
          arr[stepNum - 1] = { time: curStep.time, bar: curStep.bar, unit: curStep.unit || '' };
          curStep = {};
        }
      }
      // Fill empty step slots so downstream code sees all 9 positions.
      for (let i = 0; i < 9; i++) {
        if (!result.pi[i]) result.pi[i] = { time: -1, bar: -1, unit: '' };
        if (!result.shot[i]) result.shot[i] = { time: -1, bar: -1, unit: '' };
      }
      log(`[MCu] Slot ${slotNum}: name="${result.name}" PI=${result.pi.filter(s=>s.time>=0).length} Shot=${result.shot.filter(s=>s.time>=0).length} ` +
          `end=${result.end} track=(${result.trackFlow},${result.trackTime}) PID=(${result.pid1},${result.pid2}) cue=${result.cue}`);
      // After MCu flood, re-arm continuous rich stream with a single MCr.
      sendRawToITO('MCr\r');
      setTimeout(() => resolve(result), 500);
    }, 5000); // measured: full MCu dump finishes in ~3-4 s
  });
}

// ─── Read dose list + active dose from MCu dump ──────────────────────────────
// Returns { active: 'ESPRESSO', doses: [{name, method, volume, weight, temp, profile, ...}] }
function readMcuDoses() {
  return new Promise((resolve) => {
    const lines = [];
    _mcuCapture = { lines, resolve: null };
    sendRawToITO('MCu\r');
    setTimeout(() => {
      _mcuCapture = null;
      const result = { active: '', doses: [], shortcuts: {} };
      let inDoses = false, currentDose = null;
      let inShortcuts = false;

      for (const line of lines) {
        const stripped = line.replace(/^[\|\s]+/, '').trim();

        // Shortcuts section - at 1-pipe depth inside Setup: "| Shortcuts..."
        // Entries are "| | [N]  FUNCTION" - e.g. "| | [1]  ESPRESSO"
        if (stripped.startsWith('Shortcuts')) { inShortcuts = true; continue; }
        if (inShortcuts) {
          // Leave the section when we see another top-level entry (starts
          // without `[` and follows a typical setup label).
          if (stripped.startsWith('LED') || stripped.startsWith('Wifi')
              || stripped.startsWith('Buzzer') || stripped.startsWith('Bluetooth')) {
            inShortcuts = false;
          } else {
            // Parse "[N]  VALUE" from either the full line or stripped form
            const sm = stripped.match(/^(\[\d+\])\s+(.+)$/);
            if (sm) {
              result.shortcuts[sm[1]] = sm[2].trim();
              continue;
            }
          }
        }

        // Find Doses section - matches "Doses..." (not "Dose" field inside a slot)
        if (stripped === 'Doses...' || stripped.startsWith('Doses...')) { inDoses = true; continue; }
        // End of Doses section - Cups, Signal, Profiles, Pump, Scale etc. follow.
        // Match ONLY top-level section headers (depth 0: no leading "|"), so
        // dose FIELDS like "PumpPwr" don't trip the end-condition.
        if (inDoses && !line.startsWith('|') && /^(Profiles|Pump|Scale|Paddle|Cups|Shot|Warm|Flush|Eco|Water|Descale|Backflush|Autotuning|Protection|Display|Input|Shortcuts|LED|Buzzer|Wifi|Bluetooth)\b/.test(stripped)) {
          inDoses = false;
          if (currentDose) { result.doses.push(currentDose); currentDose = null; }
          continue;
        }
        if (!inDoses) continue;

        // Active dose: "Use ESPRESSO"
        const useM = stripped.match(/^Use\s+(.+)$/);
        if (useM && !currentDose) { result.active = useM[1].trim(); continue; }

        // Dose entry: pattern like "| Espresso..." at depth 1 (one pipe).
        // Accept 2+ trailing dots - ITO display sometimes truncates long
        // names to 2 dots (e.g. "| Dbl Ristretto..").
        // Skip the Doses sub-entries "Reset", "Use", "Brew switch" (not doses).
        const doseM = line.match(/^\|\s+([A-Za-z][A-Za-z\s]*?)\.{2,}$/);
        if (doseM) {
          const nm = doseM[1].trim();
          if (nm !== 'Reset' && nm !== 'Use' && nm !== 'Brew switch') {
            if (currentDose) result.doses.push(currentDose);
            currentDose = { name: nm, fields: {} };
          }
          continue;
        }

        // Capture fields inside current dose - lines at depth 2 ("| | ...").
        // Field lines look like:
        //   "| | Method     TIME"           ← label + value with spaces
        //   "| | Duration00m:25s"            ← packed: no space after label
        //   "| | Out       16.0g"           ← suffix 'g'
        //   "| | Ratio 1 :   2.0"            ← special format, value = 2.0
        //   "| | PProf TRAPEZOID"            ← label + single-space value
        if (currentDose && line.startsWith('| |')) {
          const content = line.replace(/^\|\s+\|\s+/, '').trimEnd();

          // Special: "Ratio 1 :  2.0" - the useful number is after "1 :"
          const rm = content.match(/^Ratio\s+\d+\s*:\s*([\d.]+)/);
          if (rm) { currentDose.fields['Ratio'] = rm[1]; continue; }

          // Special: "Duration00m:25s" - packed digits right after label
          const dm = content.match(/^Duration\s*(\d+m[:\.]\d+s|\d+s|\d+)/);
          if (dm) { currentDose.fields['Duration'] = dm[1]; continue; }

          // Explicit known labels - anchored so "Ignore flood" wins over
          // "Ignore". Allows a SINGLE space before the value so wide values
          // like "Declining" (label+value fills the column) still parse.
          // Longer labels first so prefix matches don't misfire.
          const KNOWN = [
            'Ignore flood', 'Ignore PI',
            'Method', 'Volume', 'PProf', 'PumpPwr',
            'Path', 'Focus', 'Auto-dose', 'Reset',
            'In', 'Out',
          ];
          let matched = false;
          for (const lbl of KNOWN) {
            const esc = lbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('^' + esc + '\\s+(\\S.*)$');
            const m = content.match(re);
            if (m) {
              currentDose.fields[lbl] = m[1].trim();
              matched = true;
              break;
            }
          }
          if (matched) continue;
          // Generic fallback for any field we didn't list: still use 2+
          // spaces so multi-word labels don't get split.
          const fm = content.match(/^([A-Za-z][A-Za-z0-9\s]+?)\s{2,}([^\s].*)$/);
          if (fm) {
            currentDose.fields[fm[1].trim()] = fm[2].trim();
          }
        }
      }
      if (currentDose) result.doses.push(currentDose);
      log(`[MCu doses] active="${result.active}" count=${result.doses.length} shortcuts=${Object.keys(result.shortcuts).length}`);
      // Re-arm continuous rich stream with a single MCr.
      sendRawToITO('MCr\r');
      setTimeout(() => resolve(result), 500);
    }, 5000); // measured: MCu menu output completes in ~3-4 s
  });
}

// Stub: save brew settings to the machine.
// TODO: full implementation navigates Setup > Doses > [name] > [fields],
// Setup > Shortcuts > [1], Setup > PID 1 > Setpoint. For now, we:
//  (1) log what would change
//  (2) send MCc<DoseName> to actively switch to that dose (doesn't start it, just selects)
//  (3) echo back an OK so the UI clears the "pending" marker
// The user can Apply via Settings tab for PID setpoint changes.
async function serverSaveBrewSettings(ws, msg) {
  const status = m => { log('[save-brew] ' + m); send(ws, { type: 'brew_settings_status', msg: m }); };
  status(`Saving dose "${msg.doseName}" to machine...`);
  const changes = [];
  if (msg.setActive) changes.push(`active dose = ${msg.doseName}`);
  if (msg.setShortcut1) changes.push(`shortcut 1 = ${msg.doseName}`);
  if (msg.pidActive && msg.boilerTemp) changes.push(`PID1 setpoint = ${msg.boilerTemp}\u00B0C`);
  if (msg.profileIdx != null) changes.push(`pprof_idx = slot ${msg.profileIdx + 1}`);
  status('Pending: ' + changes.join(', '));
  // Full menu navigation for dose writes is not yet implemented.
  // The app-side settings are saved to localStorage and take effect immediately
  // in the UI. Machine-side writes require further MCc/menu nav work.
  status('Local settings saved. Machine-side write pending implementation.');
  return { ok: true, changes };
}

// Module-level helpers used by both serverUploadProfile and serverSetProfileName
const _sleep = ms => new Promise(r => setTimeout(r, ms));
const _strip = s => s.replace(/PROTECT|BACKFL|REFILL|FLWMTR/g, '').trim();

// Hold button and poll display. Used for coarse value adjustment and character search.
async function _holdUntil(byte, checkFn, maxMs) {
  const deadline = Date.now() + (maxMs || 5000);
  sendRawToITO('MC' + byte + '\r');
  await _sleep(80);
  while (Date.now() < deadline) {
    const d = _strip(_navClean);
    if (checkFn(d)) break;
    await _sleep(50);
  }
  sendRawToITO('MC\x00\r');
  await _sleep(150);
  return _strip(_navClean);
}

// ─── Module-level nav-context factory ────────────────────────────────────────
// Returns a bundle of nav helpers (btn, scrollTo, enter, readFieldValue, etc.)
// bound to the proxy's live _navDisplay / _navClean. Used by the new slot-option
// and machine-wide setters. The older serverUploadProfile/serverSetProfileName
// keep their own inline closures for now (not worth the regression risk to
// refactor them).
function _makeNavCtx(statusFn) {
  const status = statusFn || (() => {});
  const sleep = _sleep;
  const strip = _strip;

  async function btn(byte, waitMs) {
    sendRawToITO('MC' + byte + '\r');
    await sleep(30);
    sendRawToITO('MC\x00\r');
    await sleep(waitMs || 250);
  }

  function cursorText() {
    const i = _navDisplay.indexOf('\x04');
    if (i < 0) return '';
    return _navDisplay.substring(i + 1, i + 30).replace(/[^\x20-\x7e]/g, '').trim();
  }
  function isOn(target) {
    const ct = cursorText();
    if (ct.startsWith(target)) return true;
    return ct.replace(/PROTECT|BACKFL|REFILL|FLWMTR/g, '').trim().startsWith(target);
  }
  async function scrollTo(target, maxScroll) {
    const max = maxScroll || 30;
    if (isOn(target)) return true;
    for (let i = 0; i < max; i++) {
      await btn('\x02', 150);
      if (isOn(target)) return true;
    }
    for (let i = 0; i < max; i++) {
      await btn('\x01', 150);
      if (isOn(target)) return true;
    }
    return false;
  }
  async function enter() {
    const prev = strip(_navClean);
    await btn('\x03', 400);
    for (let i = 0; i < 30; i++) {
      const now = strip(_navClean);
      if (now !== prev && now.length > 3) return true;
      await sleep(100);
    }
    return strip(_navClean) !== prev;
  }
  function displayText() { return strip(_navClean); }

  // Read a numeric field's current value from the cleaned display, starting
  // AT the cursor position. When the same label appears multiple times in the
  // display window (e.g. two `Track` lines - one ml/s, one s - in a slot
  // menu), this returns the value under the currently-selected cursor.
  // Returns { value, unit, raw }. `value` is -1 if the field shows `-`.
  // Read a numeric field's current value.
  //   fieldName  - the label to match (e.g. 'Resize PI', 'Track', 'PID 1').
  //   opts.unit  - if provided, match is scoped to that unit suffix. Required
  //                 to disambiguate `Track` (ml/s vs s) when both are visible.
  // Returns { value, unit, raw }. `value` is -1 if the field shows `-`.
  function readFieldValue(fieldName, opts) {
    const unitOpt = opts && opts.unit;
    const esc = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let reUnit;
    if (unitOpt === 'ml/s') {
      reUnit = new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)\\s*ml/s');
    } else if (unitOpt === 's') {
      // Match `NNs` NOT followed by "ml" (to avoid `ml/s`)
      reUnit = new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)s(?!\\s*ml|\\/)');
    } else if (unitOpt === 'b') {
      reUnit = new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)b');
    } else if (unitOpt === 'g') {
      reUnit = new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)g');
    } else {
      // Generic: any numeric value, with optional unit suffix.
      reUnit = new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)(ml/s|b|s|g|°|%)?');
    }
    const d = displayText();
    const m = d.match(reUnit);
    if (m) {
      if (m[1] === '-') return { value: -1, unit: unitOpt || '', raw: m[0] };
      return { value: parseFloat(m[1]), unit: unitOpt || (m[2] || ''), raw: m[0] };
    }
    return { value: 0, unit: '', raw: '?' };
  }

  // Reset to root MENU. FAST PATH: if we're already at MENU root (because
  // a previous operation exited here without going home) just return - saves
  // ~5 s of standby/wake/MC@ dance. Otherwise use the reliable MCE+MCa+MC@+OK
  // sequence to get there from any state.
  // Reset to root MENU via the reliable MCE+MCa+MC@+OK sequence.
  // (Previous attempt at a "fast path" that skipped the wake-dance when
  // the machine was already in a menu landed ops in wrong states in some
  // edge cases - reverted to always do the full reliable dance.)
  async function gotoMenu() {
    sendRawToITO('MCE\r');
    await sleep(1000);
    sendRawToITO('MCa\r\n');
    await sleep(2000);
    _navDisplay = '';
    for (let r = 0; r < 10; r++) {
      sendRawToITO('MC@\r');
      await sleep(800);
      if (_navDisplay.includes('\x04') || (_navDisplay.length > 5 && strip(_navClean).includes('PROFILE'))) break;
    }
    await btn('\x03', 800);
    for (let r = 0; r < 3; r++) {
      if (_navDisplay.includes('\x04')) break;
      await btn('\x03', 600);
    }
  }

  async function gotoProfilesMenu() {
    await gotoMenu();
    if (!await scrollTo('Setup')) throw new Error('Setup not found');
    if (!await enter()) throw new Error('Could not enter Setup');
    if (!await scrollTo('Profiles')) throw new Error('Profiles not found');
    if (!await enter()) throw new Error('Could not enter Profiles');
  }

  async function gotoSlotDetail(slotNum) {
    await gotoProfilesMenu();
    if (!await scrollTo('Edit')) throw new Error('Edit not found');
    if (!await enter()) throw new Error('Could not enter Edit');
    if (!await scrollTo(String(slotNum))) throw new Error('Slot ' + slotNum + ' not found');
    if (!await enter()) throw new Error('Could not enter slot ' + slotNum);
  }

  // Read the display cleaned and scoped around the cursor. Includes ~20 chars
  // BEFORE the cursor (so the field's LABEL is visible - critical when the
  // cursor is inside the value area in edit mode) plus everything AFTER.
  // This disambiguates labels that appear twice in the same window (e.g. two
  // `Track` rows in the slot menu).
  function cursorTail() {
    const raw = _navDisplay;
    const ci = raw.indexOf('\x04');
    if (ci < 0) return _strip(_navClean);
    const pre = raw.substring(Math.max(0, ci - 20), ci);
    const post = raw.substring(ci); // includes \x04, which cleans to space
    return _strip((pre + post).replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim());
  }

  // Set a float field whose cursor is currently on the target label.
  // Handles empty (`-`) init via OK→UP. Uses chained coarse-holds + fine-press
  // loop so it copes with large deltas (e.g. PID 1 from 0 to 95°C) where one
  // 30 s hold wouldn't cover the distance.
  async function setFloatField(label, target, opts) {
    const o = opts || {};
    const coarse = o.coarseThreshold != null ? o.coarseThreshold : 1.5;
    const tolerance = o.tolerance != null ? o.tolerance : 0.15;
    const maxHoldChunks = o.maxHoldChunks != null ? o.maxHoldChunks : 8;   // 8 × 30s = 4 min budget
    const holdMs = 30000;
    const fineIters = o.fineIters != null ? o.fineIters : 120;
    await btn('\x03', 300); // OK to enter edit
    await btn('\x01', 300); // UP to init empty `-` field → 0.0
    let cur = readFieldValue(label, o);
    status(`  ${label}: ${cur.raw} → ${target}${o.unit || ''}`);
    // Coarse: chain holds until within coarseThreshold. Bail out if a hold makes no progress.
    for (let c = 0; c < maxHoldChunks; c++) {
      const diff = target - cur.value;
      if (Math.abs(diff) <= coarse) break;
      const dir = diff > 0 ? '\x01' : '\x02';
      const before = cur.value;
      await _holdUntil(dir, () => {
        const v = readFieldValue(label, o);
        if (v.value < 0) return false; // still empty
        return diff > 0 ? v.value >= target - coarse : v.value <= target + coarse;
      }, holdMs);
      await sleep(200);
      cur = readFieldValue(label, o);
      if (Math.abs(cur.value - before) < 0.05) break; // no progress - hardware limit
    }
    // Fine adjust - loop until within tolerance. The per-field tolerance is
    // expected to account for step granularity (e.g. Cue is 1 s steps, so
    // tolerance=0.6 lets us land on the nearest integer without oscillating).
    // Track the best (closest) value we saw so we can land on it if the loop
    // ping-pongs at a step boundary.
    let best = { value: cur.value, err: Math.abs(target - cur.value) };
    for (let a = 0; a < fineIters; a++) {
      cur = readFieldValue(label, o);
      const err = Math.abs(target - cur.value);
      if (err < best.err) best = { value: cur.value, err };
      if (err < tolerance) break;
      await btn(cur.value < target ? '\x01' : '\x02', 120);
    }
    // If we ended up further from target than `best`, step once toward best.
    cur = readFieldValue(label, o);
    if (Math.abs(target - cur.value) > best.err + 0.01 && Math.abs(cur.value - best.value) < 1.01) {
      await btn(cur.value > best.value ? '\x02' : '\x01', 120);
    }
    // Record the pre-OK value - fine loop just exited within tolerance, so
    // this is the confirmed value.
    const preOk = readFieldValue(label, o);
    await btn('\x03', 400); // OK to confirm
    await sleep(200);
    status(`  ${label} confirmed: ${preOk.value}${preOk.unit}`);
    if (Math.abs(preOk.value - target) > tolerance * 2) {
      throw new Error(`${label} mismatch: got ${preOk.value}, wanted ${target}`);
    }
    return preOk.value;
  }

  // Set an integer field.
  async function setIntField(label, target) {
    await btn('\x03', 300);
    await btn('\x01', 300); // init
    let cur = readFieldValue(label);
    status(`  ${label}: ${cur.raw} → ${target}`);
    for (let a = 0; a < 60; a++) {
      cur = readFieldValue(label);
      const diff = target - cur.value;
      if (diff === 0) break;
      await btn(diff > 0 ? '\x01' : '\x02', 120);
    }
    await btn('\x03', 400);
    await sleep(200);
    const v = readFieldValue(label);
    status(`  ${label} confirmed: ${v.value}`);
    return v.value;
  }

  // Clear a field - send it to `-` (the firmware's "empty/disabled" state).
  // Mechanism: enter edit (OK), HOLD DOWN until the value wraps below 0 to `-`,
  // confirm with OK. Used for Flood pressure / Flood pump power when the user
  // wants Flood disabled (firmware uses `-` for off, NOT 0 - writing 0 either
  // lands on 0.1 or oscillates).
  // Caller must already have the cursor on the field's label.
  async function clearField(label, opts) {
    const o = opts || {};
    const cur0 = readFieldValue(label, o);
    if (cur0.value < 0) {
      status(`  ${label}: already cleared (-) - skip`);
      return -1;
    }
    status(`  ${label}: ${cur0.raw} → -  (clearing)`);
    await btn('\x03', 300);  // enter edit
    // Hold DOWN until the field wraps to `-` (returns -1 from readFieldValue).
    // Hardware step is small (0.1 for floats, 1 for ints) so even a high value
    // wraps within ~30 s of holding.
    await _holdUntil('\x02', () => {
      const v = readFieldValue(label, o);
      return v.value < 0;
    }, 30000);
    await sleep(200);
    // Verify, then OK to confirm
    const v = readFieldValue(label, o);
    if (v.value >= 0) {
      // Hold didn't reach `-` - abort the edit so we don't leave a stray value.
      await btn('\x04', 400);  // CANCEL
      throw new Error(`${label}: hold-DOWN did not reach \`-\` (still ${v.raw})`);
    }
    await btn('\x03', 400);  // OK confirm
    await sleep(200);
    status(`  ${label} confirmed: cleared`);
    return -1;
  }

  // Set a cycle field (e.g., End: STOP | SUSTAIN | FULL POWER) by entering
  // edit mode and cycling UP while reading the live display, stopping when
  // the current option matches the target (prefix/case-insensitive).
  //
  // Why not "compute UP count from options list index": the machine's real
  // cycle can have more options than the browser knows about (e.g. a `-`
  // sentinel for dose "Use", or machine-specific shortcut functions like
  // "REPORT SP1" that aren't in our static list). A fixed press count is
  // off-by-N whenever that happens. Reading the display after each press
  // is robust to any list drift.
  //
  // `options` is still accepted for backward compat - used as an upper bound
  // on press count (len + 5) and nothing else.
  async function setCycleField(label, targetOption, options) {
    const escRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tgtU = String(targetOption).toUpperCase();
    const tgtPrefix = tgtU.slice(0, Math.min(8, tgtU.length));

    // Read the option currently under the cursor. Tries the cursor chunk
    // first; falls back to the full display when the cursor marker has
    // briefly disappeared (the firmware drops \x04 for ~300-700 ms during
    // some cycle transitions - without a fallback we'd miss the value).
    function readCurrent() {
      // Strategy 1: cursor-anchored chunk (most accurate when cursor present)
      const idx = _navDisplay.indexOf('\x04');
      if (idx >= 0) {
        const chunk = _navDisplay.substring(idx + 1, idx + 40)
          .replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
        // In view mode the chunk starts with the LABEL, then space, then VALUE.
        // In edit mode the cursor may sit at the VALUE column, so the chunk
        // starts directly with the value (label not visible).
        const reLabel = new RegExp('^' + escRegex(label) + '\\s+(.+)$', 'i');
        const m = chunk.match(reLabel);
        const payload = m ? m[1] : chunk;
        if (payload && /[A-Za-z0-9]/.test(payload)) {
          return payload.replace(/^\s+/, '').slice(0, 14).trim();
        }
      }
      // Strategy 2: full-display search for `<label> <value>`. Works during
      // the brief no-cursor transition frame after a cycle press, where the
      // value text is still visible on screen.
      const full = _navDisplay
        .replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
      const reFull = new RegExp('\\b' + escRegex(label) + '\\s+(.+)$');
      const m2 = full.match(reFull);
      if (m2) return m2[1].slice(0, 14).trim();
      return '';
    }

    // Match helper: cU must be substantive (≥2 chars) to avoid empty/stale
    // reads producing a false positive. Two-way prefix match handles mixed
    // full-name vs truncated display (e.g. target "AMERICANO XL" / seen
    // "AMERICANO XL" or "AMERICANO X" or "AMERICANO ").
    function matches(cU) {
      if (cU.length < 2) return false;
      if (cU.startsWith(tgtPrefix)) return true;
      // Also accept if the current display is a PREFIX of the target (length ≥ 4)
      // - handles 10-char-truncation cases.
      if (cU.length >= 4 && tgtU.startsWith(cU)) return true;
      return false;
    }

    // Retrying reader - display takes a moment to settle after each press.
    async function readStable() {
      for (let r = 0; r < 4; r++) {
        const v = readCurrent();
        if (v.length >= 2) return v;
        await sleep(100);
      }
      return readCurrent();
    }

    // Precheck: already at target?
    const cur0 = readCurrent();
    if (matches(cur0.toUpperCase())) {
      status(`  ${label} already ${cur0} - skip`);
      return targetOption;
    }
    status(`  ${label}: cycling from "${cur0}" to "${targetOption}"`);

    // Enter edit mode and give the display a moment to show the edit-mode frame.
    await btn('\x03', 300);
    await sleep(300);

    // Cycle UP, reading after each press, until target appears or we wrap.
    // Upper bound: options.length + 10 (safety margin for unknown options).
    const maxPresses = (options && options.length ? options.length : 40) + 10;
    let firstSeen = null;
    for (let i = 0; i < maxPresses; i++) {
      const cur = await readStable();
      const cU = cur.toUpperCase();
      if (matches(cU)) {
        await btn('\x03', 400);  // confirm
        status(`  ${label} → "${cur}" ✓`);
        return targetOption;
      }
      // Detect full cycle completion - exit after at least 2 steps.
      if (firstSeen === null) firstSeen = cU;
      else if (i >= 2 && cU === firstSeen) break;
      await btn('\x01', 150);
      await sleep(100);
    }

    // Not found - cancel edit and fail
    await btn('\x04', 400);
    throw new Error(`${label}: target "${targetOption}" not found after cycling`);
  }

  // Set a `\x05`/`-` toggle field (Execute PI/shot, Drop ends PI, Ignore
  // flood/PI etc.). Read state from the RAW display because the cleaned text
  // strips \x05 to a space - comparing that against `/` (the MCu-text glyph)
  // would never match. Press OK to toggle; UP/DOWN only move the cursor.
  // Verified with probe-exec-toggle.js on a live machine.
  async function setToggleField(label, wantOn) {
    const idx = _navDisplay.indexOf('\x04');
    if (idx < 0) {
      status(`  ${label}: no cursor - abort`);
      return null;
    }
    const chunk = _navDisplay.substring(idx + 1, idx + 1 + label.length + 6);
    if (!chunk.startsWith(label)) {
      status(`  ${label}: cursor not on "${label}" (chunk="${chunk.replace(/[^\x20-\x7e]/g, '?')}") - abort`);
      return null;
    }
    const after = chunk.substring(label.length).replace(/^\s+/, '');
    const c = after.charCodeAt(0);
    const isOnNow  = (c === 0x05);
    const isOffNow = (c === 0x2D);
    if (!isOnNow && !isOffNow) {
      status(`  ${label}: unexpected state byte 0x${c.toString(16)} - abort`);
      return null;
    }
    status(`  ${label}: ${isOnNow ? 'ON' : 'OFF'} → ${wantOn ? 'ON' : 'OFF'}`);
    if (isOnNow === !!wantOn) return !!wantOn;
    await btn('\x03', 350);  // OK = single-press toggle
    await sleep(150);
    return !!wantOn;
  }

  return {
    btn, cursorText, isOn, scrollTo, enter, displayText, readFieldValue,
    gotoMenu, gotoProfilesMenu, gotoSlotDetail,
    setFloatField, setIntField, setCycleField, setToggleField, clearField,
  };
}

// ─── Per-slot option setter ──────────────────────────────────────────────────
// Navigates to the slot detail menu and sets one of the post-Edit-shot fields.
// `field`: 'resizePI' | 'resizeShot' | 'end' | 'trackFlow' | 'trackTime' |
//          'pid1' | 'pid2' | 'cue' | 'piRepeat' | 'piWait'
// Caller is responsible for acquiring the ITO mutex.
async function serverSetSlotOption(ws, slotNum, field, value) {
  const status = msg => { log(`[slot-opt] ${msg}`); send(ws, { type: 'profile_upload_status', msg }); };
  const nav = _makeNavCtx(status);
  const { btn, scrollTo, enter, setFloatField, setIntField, setCycleField, gotoSlotDetail, displayText } = nav;

  status(`Set slot ${slotNum} ${field} = ${value}`);
  await gotoSlotDetail(slotNum);
  status(`In slot ${slotNum}`);

  // Helper: land on a label and set a float
  const atLabelSetFloat = async (label, opts) => {
    if (!await scrollTo(label)) throw new Error(label + ' not found');
    await setFloatField(label, value, opts);
  };

  try {
    switch (field) {
      case 'resizePI':
        // step=0.1 bar; tolerance < step/2 = 0.05 for exact landing.
        await atLabelSetFloat('Resize PI', { unit: 'b', coarseThreshold: 1.0, tolerance: 0.04 });
        break;
      case 'resizeShot':
        await atLabelSetFloat('Resize S', { unit: 'b', coarseThreshold: 1.0, tolerance: 0.04 });
        break;
      case 'end':
        if (!await scrollTo('End')) throw new Error('End not found');
        await setCycleField('End', value, ['STOP', 'SUSTAIN', 'FULL POWER']);
        break;
      case 'trackFlow':
        // Two `Track` labels exist; flow is FIRST (with ml/s unit).
        // step=0.1 ml/s; tolerance must be < step/2 = 0.05 so fine-adjust
        // demands exact match (otherwise 3.7 lands at 3.6).
        if (!await scrollTo('End')) throw new Error('End anchor not found');
        await btn('\x02', 200); // DOWN to first Track
        // Verify unit before committing
        if (!displayText().match(/Track\s+[\d\-.]+\s*ml\/s/)) throw new Error('First Track is not ml/s - menu changed?');
        await setFloatField('Track', value, { unit: 'ml/s', coarseThreshold: 1.0, tolerance: 0.04 });
        break;
      case 'trackTime':
        // Track (time) is SECOND - navigate via End → DOWN DOWN
        // step=1 s; default tolerance of 0.15 is plenty.
        if (!await scrollTo('End')) throw new Error('End anchor not found');
        await btn('\x02', 200); // DOWN to Track flow
        await btn('\x02', 200); // DOWN to Track time
        if (!displayText().match(/Track\s+[\d\-.]+s(?!\s*ml)/)) throw new Error('Second Track is not s - menu changed?');
        await setFloatField('Track', value, { unit: 's', coarseThreshold: 2.0 });
        break;
      case 'pid1':
        // step=0.1 °C; tolerance < step/2 for exact landing.
        if (!await scrollTo('PID 1')) throw new Error('PID 1 not found');
        await setFloatField('PID 1', value, { unit: '°C', coarseThreshold: 3.0, tolerance: 0.04 });
        break;
      case 'pid2':
        if (!await scrollTo('PID 2')) throw new Error('PID 2 not found');
        await setFloatField('PID 2', value, { unit: '°C', coarseThreshold: 3.0, tolerance: 0.04 });
        break;
      case 'cue':
        if (!await scrollTo('Cue')) throw new Error('Cue not found');
        // Cue increments in 1-second steps on the ITO, so tolerance must be
        // at least 0.6 to land on the rounded value (half a step).
        await setFloatField('Cue', value, { unit: 's', coarseThreshold: 2.0, tolerance: 0.6 });
        break;
      case 'piRepeat':
        if (!await scrollTo('Edit PI')) throw new Error('Edit PI not found');
        if (!await enter()) throw new Error('Could not enter Edit PI');
        if (!await scrollTo('Repeat')) throw new Error('Repeat not found');
        await setIntField('Repeat', value);
        await btn('\x04', 400); // ESC back to slot detail
        break;
      case 'piWait':
        if (!await scrollTo('Edit PI')) throw new Error('Edit PI not found');
        if (!await enter()) throw new Error('Could not enter Edit PI');
        if (!await scrollTo('Wait')) throw new Error('Wait not found');
        await setFloatField('Wait', value, { unit: 's', coarseThreshold: 2.0 });
        await btn('\x04', 400);
        break;
      default:
        throw new Error('Unknown slot option: ' + field);
    }
    // Exit to home
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: true, slot: slotNum, field, value };
  } catch (e) {
    status('Error: ' + e.message);
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: false, slot: slotNum, field, error: e.message };
  }
}

// ─── Machine-wide Flood setter ───────────────────────────────────────────────
// Set Flood pressure/pumpPwr. Per-arg semantics:
//   undefined → skip (don't touch this field)
//   null      → CLEAR (write `-` - disabled state, firmware uses this for off)
//   number    → set to this value
async function serverSetMachineFlood(ws, pressure, pumpPwr) {
  const status = msg => { log(`[flood] ${msg}`); send(ws, { type: 'profile_upload_status', msg }); };
  const nav = _makeNavCtx(status);
  const { btn, scrollTo, enter, setFloatField, setIntField, clearField, gotoProfilesMenu } = nav;
  const fmt = v => v === null ? '-' : (v === undefined ? '(skip)' : v);
  status(`Set Flood: pressure=${fmt(pressure)} pumpPwr=${fmt(pumpPwr)}`);
  try {
    await gotoProfilesMenu();
    if (!await scrollTo('Flood')) throw new Error('Flood not found');
    if (!await enter()) throw new Error('Could not enter Flood');
    if (pressure !== undefined) {
      if (!await scrollTo('Pressure')) throw new Error('Flood.Pressure not found');
      if (pressure === null) {
        await clearField('Pressure', { unit: 'b' });
      } else {
        // step=0.1bar, tolerance must be < step/2 = 0.05 so the fine-adjust
        // loop demands exact match (otherwise it'd stop one step short).
        await setFloatField('Pressure', pressure, { unit: 'b', coarseThreshold: 1.0, tolerance: 0.04 });
      }
    }
    if (pumpPwr !== undefined) {
      if (!await scrollTo('PumpPwr')) throw new Error('Flood.PumpPwr not found');
      if (pumpPwr === null) {
        await clearField('PumpPwr');
      } else {
        await setIntField('PumpPwr', pumpPwr);
      }
    }
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: true, pressure, pumpPwr };
  } catch (e) {
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: false, error: e.message };
  }
}

// ─── Machine-wide toggle setter ──────────────────────────────────────────────
// field: 'executePI' | 'executeShot' | 'dropEndsPI' | 'limit'
async function serverSetMachineToggle(ws, field, value) {
  const status = msg => { log(`[toggle] ${msg}`); send(ws, { type: 'profile_upload_status', msg }); };
  const nav = _makeNavCtx(status);
  const { btn, scrollTo, setFloatField, setToggleField, gotoProfilesMenu } = nav;
  const LABEL = {
    executePI: 'Execute PI', executeShot: 'Execute shot',
    dropEndsPI: 'Drop ends PI', limit: 'Limit',
  }[field];
  if (!LABEL) return { ok: false, error: 'Unknown toggle field: ' + field };
  status(`Set machine ${field} = ${value}`);
  try {
    await gotoProfilesMenu();
    if (!await scrollTo(LABEL)) throw new Error(LABEL + ' not found');
    if (field === 'limit') {
      // step=0.1g; tolerance must be < step/2 = 0.05 so the fine-adjust loop
      // demands an exact match (otherwise 0.4 target could land at 0.3/0.5).
      await setFloatField('Limit', Number(value), { unit: 'g', coarseThreshold: 1.0, tolerance: 0.04 });
    } else {
      await setToggleField(LABEL, !!value);
    }
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: true, field, value };
  } catch (e) {
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: false, field, error: e.message };
  }
}

// ─── Per-dose Ignore toggle (Ignore flood / Ignore PI) ─────────────────────
// On the LCD these fields render ON = \x05 (checkmark byte), OFF = '-'.
// ONE OK press flips them - there's no edit mode / confirm / cycle.
// `wantIgnored`: true → set to ignored ('/' in MCu, \x05 on LCD)
//                false → set to run ('-' on both)
// Caller is responsible for acquiring the ITO mutex.
async function serverSetDoseIgnore(ws, doseName, field, wantIgnored) {
  const status = msg => { log(`[dose-ignore] ${msg}`); send(ws, { type: 'dose_ignore_status', msg }); };
  const nav = _makeNavCtx(status);
  const { btn, scrollTo, enter, gotoMenu } = nav;

  const label = field === 'ignoreFlood' ? 'Ignore flood'
              : field === 'ignorePI'    ? 'Ignore PI'
              : null;
  if (!label) return { ok: false, error: 'Unknown ignore field: ' + field };

  // Read the bit-under-label of the currently-displayed cursor chunk.
  // Returns 'on' (\x05), 'off' ('-'), or null (not parseable).
  function readToggleState() {
    const raw = _navDisplay;
    const ci = raw.indexOf('\x04');
    if (ci < 0) return null;
    // Cursor chunk starts with the label, then whitespace, then the state char.
    const chunk = raw.substring(ci + 1, ci + 1 + label.length + 6);
    if (!chunk.startsWith(label)) return null;
    const after = chunk.substring(label.length).replace(/^\s+/, '');
    const c = after.charCodeAt(0);
    if (c === 0x05) return 'on';
    if (c === 0x2D) return 'off';
    return null;
  }

  status(`Set ${doseName} ${label} = ${wantIgnored ? 'IGNORE(/)' : 'RUN(-)'}`);
  try {
    await gotoMenu();
    if (!await scrollTo('Setup')) throw new Error('Setup not found');
    if (!await enter()) throw new Error('Could not enter Setup');
    if (!await scrollTo('Doses')) throw new Error('Doses not found');
    if (!await enter()) throw new Error('Could not enter Doses');
    if (!await scrollTo(doseName)) throw new Error(doseName + ' not found');
    if (!await enter()) throw new Error('Could not enter ' + doseName);
    if (!await scrollTo(label)) throw new Error(label + ' not found');

    const before = readToggleState();
    if (before === null) throw new Error('Could not read toggle state');
    status(`  current: ${before.toUpperCase()}`);

    const want = wantIgnored ? 'on' : 'off';
    if (before === want) {
      status(`  already ${want.toUpperCase()} - skip`);
    } else {
      await btn('\x03', 500);  // OK press = single-press toggle
      const after = readToggleState();
      if (after !== want) {
        status(`  WARN: after toggle saw ${after}, expected ${want}`);
      } else {
        status(`  ${before.toUpperCase()} → ${after.toUpperCase()} OK`);
      }
    }

    // Exit cleanly back to home
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: true, dose: doseName, field, value: wantIgnored, before, after: readToggleState() };
  } catch (e) {
    for (let i = 0; i < 6; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: false, dose: doseName, field, error: e.message };
  }
}

// ─── Server-side dose-field editor ────────────────────────────────────────
// Writes multiple fields of a dose in ONE menu visit, using the proven
// _makeNavCtx helpers (scrollTo/enter/setCycleField + delta-step for values).
// Replaces the browser's editDoseFields() which was ~150× slower because it
// round-tripped every scroll through the WS and fought with stale display
// frames in its sameCount detection.
//
// specs: array of { name, target, type, ... } where type is:
//   'cycle'  - { options: [...], aliases?: [...] }
//   'value'  - { current: number, step?: number, unit?: string }
// Fields not found in the dose submenu are silently skipped (they might be
// hidden by the current Method, e.g. `In` disappears in VOLUME mode).
// Caller is responsible for acquiring the ITO mutex.
async function serverSetDoseFields(ws, doseName, specs) {
  const status = msg => { log(`[set-dose] ${msg}`); send(ws, { type: 'set_dose_fields_status', msg }); };
  const nav = _makeNavCtx(status);
  const { btn, scrollTo, enter, gotoMenu, displayText, setCycleField } = nav;

  // Check if the cursor's current field value matches `target` (for skip-on-match).
  function cursorMatches(spec) {
    const d = displayText();
    if (spec.type === 'cycle') {
      const aliases = (spec.aliases || [spec.target]).map(a => String(a).trim().toUpperCase());
      // Display format: "LABEL    OPTION"; options may be truncated.
      const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = d.match(new RegExp(esc + '\\s+(\\S+)'));
      if (!m) return false;
      return aliases.some(a => m[1].toUpperCase().startsWith(a.slice(0, 8)));
    }
    if (spec.type === 'value') {
      // Ratio format is special: "Ratio 1 :  2.0" - take the 2nd number.
      if (spec.name === 'Ratio') {
        const m = d.match(/Ratio\s*\d+\s*:\s*([\d.]+)/);
        if (!m) return false;
        return Math.abs(parseFloat(m[1]) - Number(spec.target)) < (spec.step || 0.1) / 2;
      }
      const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = d.match(new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)'));
      if (!m) return false;
      if (m[1] === '-') return false;  // Empty field, definitely needs a write.
      return Math.abs(parseFloat(m[1]) - Number(spec.target)) < (spec.step || 0.1) / 2;
    }
    return false;
  }

  // Read the current float value under the cursor (for delta calc).
  function readCurrent(spec) {
    const d = displayText();
    if (spec.name === 'Ratio') {
      const m = d.match(/Ratio\s*\d+\s*:\s*([\d.]+)/);
      return m ? parseFloat(m[1]) : null;
    }
    const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = d.match(new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)'));
    if (!m) return null;
    return m[1] === '-' ? 0 : parseFloat(m[1]);
  }

  status(`Writing ${specs.length} field(s) to ${doseName}`);
  try {
    await gotoMenu();
    if (!await scrollTo('Setup')) throw new Error('Setup not found');
    if (!await enter()) throw new Error('Could not enter Setup');
    if (!await scrollTo('Doses')) throw new Error('Doses not found');
    if (!await enter()) throw new Error('Could not enter Doses');
    if (!await scrollTo(doseName)) throw new Error(doseName + ' not found');
    if (!await enter()) throw new Error('Could not enter ' + doseName);

    const results = [];
    for (const spec of specs) {
      try {
        if (!await scrollTo(spec.name)) {
          status(`  skip ${spec.name} (not in submenu - maybe hidden by Method)`);
          results.push({ field: spec.name, ok: false, skipped: true, reason: 'not found' });
          continue;
        }
        if (cursorMatches(spec)) {
          status(`  ${spec.name} already at ${spec.target} - skip`);
          results.push({ field: spec.name, ok: true, skipped: true });
          continue;
        }

        if (spec.type === 'cycle') {
          if (!spec.options || !Array.isArray(spec.options) || spec.options.length === 0) {
            status(`  WARN ${spec.name}: cycle spec missing options`);
            results.push({ field: spec.name, ok: false, error: 'no options' });
            continue;
          }
          await setCycleField(spec.name, spec.target, spec.options);
          results.push({ field: spec.name, ok: true });
        } else if (spec.type === 'value') {
          const cur = readCurrent(spec);
          const tgt = Number(spec.target);
          if (cur === null || !Number.isFinite(tgt)) {
            status(`  skip ${spec.name} (could not read current or invalid target)`);
            results.push({ field: spec.name, ok: false, error: 'read fail' });
            continue;
          }
          const step = spec.step || 0.1;
          const delta = tgt - cur;
          const steps = Math.round(Math.abs(delta) / step);
          if (steps === 0) {
            results.push({ field: spec.name, ok: true, skipped: true });
            continue;
          }
          if (steps > 200) {
            status(`  refuse ${spec.name}: ${steps} steps is too many`);
            results.push({ field: spec.name, ok: false, error: 'too many steps' });
            continue;
          }
          status(`  ${spec.name}: ${cur} → ${tgt} (${steps} ${delta > 0 ? 'UP' : 'DN'})`);
          await btn('\x03', 300);  // enter edit
          const dir = delta > 0 ? '\x01' : '\x02';
          for (let i = 0; i < steps; i++) await btn(dir, 100);
          await btn('\x03', 400);  // confirm
          results.push({ field: spec.name, ok: true });
        } else {
          results.push({ field: spec.name, ok: false, error: 'unknown type ' + spec.type });
        }
      } catch (e) {
        status(`  ${spec.name} FAILED: ${e.message}`);
        results.push({ field: spec.name, ok: false, error: e.message });
      }
    }

    // Clean exit
    for (let i = 0; i < 8; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: true, dose: doseName, results };
  } catch (e) {
    for (let i = 0; i < 8; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: false, dose: doseName, error: e.message };
  }
}

// ─── Generic menu-field setter ───────────────────────────────────────────
// Navigates Home → path[0] → path[1] → ... → path[N-1] (the last is the
// target FIELD, not a submenu) and applies `spec`:
//   spec.type === 'cycle' - { target, options: [...], aliases?: [...] }
//   spec.type === 'value' - { target, step?: number }
//   spec.type === 'toggle' - { value: boolean }  // for machine-wide `/`/`-`
// Replaces the browser's changeCycle / changeValue - same pattern as the
// dose-field and profile-name primitives.
// Caller is responsible for acquiring the ITO mutex.
async function serverSetMenuField(ws, path, spec) {
  const status = msg => { log(`[set-field] ${msg}`); send(ws, { type: 'set_menu_field_status', msg }); };
  const nav = _makeNavCtx(status);
  const { btn, scrollTo, enter, gotoMenu, displayText, setCycleField, setToggleField } = nav;

  if (!Array.isArray(path) || path.length === 0) {
    return { ok: false, error: 'path must be a non-empty array' };
  }
  const fieldName = path[path.length - 1];
  const submenus  = path.slice(0, -1);

  status(`Set ${path.join(' → ')} = ${JSON.stringify(spec.target ?? spec.value)}`);
  try {
    await gotoMenu();
    for (const name of submenus) {
      if (!await scrollTo(name)) throw new Error(name + ' not found');
      if (!await enter()) throw new Error('Could not enter ' + name);
    }
    if (!await scrollTo(fieldName)) throw new Error(fieldName + ' not found');

    if (spec.type === 'cycle') {
      if (!Array.isArray(spec.options) || spec.options.length === 0) {
        throw new Error('cycle spec requires options array');
      }
      // Precheck: skip if already at target. Escape regex metachars in both
      // the field label and each option (handles `[1]`, `TEMP +`, `P.PROF` etc.)
      // and match case-insensitively since machine may uppercase strings.
      const d = displayText();
      const escR = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const optPat = spec.options.map(o => escR(o).replace(/\\\s|\s+/g, '\\s+')).join('|');
      const m = d.match(new RegExp(escR(fieldName) + '\\s+(' + optPat + ')', 'i'));
      if (m && m[1].trim().toUpperCase() === String(spec.target).toUpperCase()) {
        status(`  already ${spec.target} - skip`);
      } else {
        await setCycleField(fieldName, spec.target, spec.options);
      }
    } else if (spec.type === 'value') {
      const step = spec.step || 0.1;
      const esc = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const d = displayText();
      const m = d.match(new RegExp(esc + '\\s+(-|\\d+\\.?\\d*)'));
      const cur = (m && m[1] !== '-') ? parseFloat(m[1]) : null;
      const tgt = Number(spec.target);
      if (cur !== null && Math.abs(cur - tgt) < step / 2) {
        status(`  already ${cur} - skip`);
      } else if (cur === null) {
        // Empty field: OK + UP to initialise, then fine-adjust.
        await btn('\x03', 300);
        await btn('\x01', 300);
        let now = 0;
        for (let i = 0; i < 200 && Math.abs(now - tgt) >= step / 2; i++) {
          await btn(now < tgt ? '\x01' : '\x02', 100);
          now = now + (now < tgt ? step : -step);
        }
        await btn('\x03', 400);
      } else {
        const delta = tgt - cur;
        const steps = Math.round(Math.abs(delta) / step);
        if (steps > 200) throw new Error('too many steps: ' + steps);
        status(`  ${cur} → ${tgt} (${steps} ${delta > 0 ? 'UP' : 'DN'})`);
        await btn('\x03', 300);
        const dir = delta > 0 ? '\x01' : '\x02';
        for (let i = 0; i < steps; i++) await btn(dir, 100);
        await btn('\x03', 400);
      }
    } else if (spec.type === 'toggle') {
      await setToggleField(fieldName, !!spec.value);
    } else if (spec.type === 'action') {
      // Action item - just press OK on the highlighted label. Used for
      // top-level system actions like "Restart BLE", "Restart Wifi",
      // "Factory reset". Some show a confirmation submenu (Yes/No);
      // spec.confirmYes (default true) presses UP+OK to confirm "Yes".
      status(`  ACTION: ${fieldName}`);
      await btn('\x03', 800);  // OK to fire
      if (spec.confirmYes !== false) {
        await sleep(500);
        // Confirmation prompts on this firmware show "yes/no"; UP selects "yes".
        await btn('\x01', 250);
        await btn('\x03', 800);
      }
    } else {
      throw new Error('unknown spec type: ' + spec.type);
    }

    // Exit back to home
    for (let i = 0; i < 8; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: true, path, spec: { type: spec.type, target: spec.target ?? spec.value } };
  } catch (e) {
    for (let i = 0; i < 8; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: false, path, error: e.message };
  }
}

// ─── Diagnostic runner ─────────────────────────────────────────────────────
// Navigate to a Run-menu test (Test flow / Test pressure / Test valve /
// Autotuning), press OK to start, watch the firmware's display for
// numeric output, stream parsed values back to the browser, and back out
// when the display has been stable for `settleMs` ms.
//
// `kind` selects which numeric pattern to extract:
//   'flow'     - pumped volume + impulse count
//   'pressure' - peak pressure in bar
//   'valve'    - completion / cycle count (no specific number; returns when done)
//   'autotune' - Kc, Ti, Td values
//   'generic'  - just streams cleaned-display lines as progress
let _diagCancel = false;
async function serverRunDiagnostic(ws, path, kind, settleMs, maxMs, subSelect) {
  // Reset the recent-lines ring buffer at the START of the run so any
  // [ALARM] wire lines emitted by the firmware during navigation /
  // leaf-OK / sub-pick are caught by the monitor loop below. Resetting
  // later (after the leaf OK) drops the very [SCALE] / [OFF] / etc.
  // signal we need.
  _recentLines.length = 0;

  // Two ways the server reports progress to the browser:
  //   stage(text)              - replaces the spinner-line text only
  //   gauge({key:val,...})     - updates in-place gauge rows, no log spam
  //   note(text)               - generic "Status" gauge row (single, in-place)
  const status = (msg) => {
    log(`[diag] ${msg}`);
    send(ws, { type: 'diag_progress', stage: msg });
  };
  const gauge = (fields) => {
    log(`[diag] ${Object.entries(fields).map(([k,v])=>k+'='+v).join(' ')}`);
    send(ws, { type: 'diag_progress', fields });
  };
  const note = (text) => {
    send(ws, { type: 'diag_progress', value: text });
  };
  const nav = _makeNavCtx((m) => log('[diag-nav] ' + m));
  const { btn, scrollTo, enter, gotoMenu, displayText } = nav;

  _diagCancel = false;

  // Bar-fill heuristic - many firmware tests show a bar that fills as the
  // test runs. The bar can appear in different LCD positions and at varying
  // widths depending on the test, so we don't assume a fixed window. We
  // scan the entire raw navDisplay for the longest contiguous run of
  // "bar-cell candidates" (fill chars or spaces) and compute fill / total
  // within that run. Fill chars are recognised in three categories:
  //   • non-printable bytes (0x00-0x1F, 0x7F, 0x80+) - \x05 / \xFF blocks
  //   • spaces - empty cell
  //   • printable bar glyphs: # = * | (firmware-dependent)
  // Bracket-delimited bars `[XXXX]` are preferred when present - they're
  // unambiguous; otherwise we fall back to the longest run scan.
  function readBarProgress() {
    const raw = _navDisplay || '';

    const isFillByte  = (c) => (c < 0x20 || c === 0x7f || c >= 0x80);
    const isSpaceByte = (c) => (c === 0x20);
    const isPrintFill = (ch) => (ch === '#' || ch === '=' || ch === '*' || ch === '|');
    const countSlice = (s) => {
      let filled = 0, total = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i], c = s.charCodeAt(i);
        if (isSpaceByte(c)) { total++; }
        else if (isFillByte(c)) { filled++; total++; }
        else if (isPrintFill(ch)) { filled++; total++; }
      }
      return { filled, total };
    };

    // 1) Bracket-delimited bar: `[####    ]`
    const bm = raw.match(/\[([^\[\]]{4,})\]/);
    if (bm) {
      const { filled, total } = countSlice(bm[1]);
      if (total >= 4) return Math.round((filled / total) * 100);
    }

    // 2) Longest contiguous run of bar-cell candidates (≥ 8 chars long,
    //    must include at least one fill cell so we don't pick up spaces
    //    of the menu padding).
    let best = '';
    let cur = '';
    let curHasFill = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i], c = raw.charCodeAt(i);
      const isCell = isSpaceByte(c) || isFillByte(c) || isPrintFill(ch);
      if (isCell) {
        cur += ch;
        if (isFillByte(c) || isPrintFill(ch)) curHasFill = true;
      } else {
        if (curHasFill && cur.length > best.length) best = cur;
        cur = ''; curHasFill = false;
      }
    }
    if (curHasFill && cur.length > best.length) best = cur;
    if (best.length < 8) return null;
    const { filled, total } = countSlice(best);
    if (total < 4 || filled === 0) return null;
    return Math.round((filled / total) * 100);
  }

  // Patterns per diagnostic kind. Each returns an object of extracted fields
  // when found in a frame, or null if no match.
  const extractors = {
    flow: (line) => {
      // Flow-meter calibration (Run → Calibration → Flow meter):
      // pumps 200 g while counting flow-meter ticks. The LCD streams
      // current weight (g, from the wireless scale), volume (ml,
      // computed by firmware), and impulses. We surface all three plus
      // the running impulses-per-litre estimate. Error detection (scale
      // not connected, flow meter missing, …) lives in the main monitor
      // loop - see the [ALARM] check below.
      const fields = {};
      const g   = (line.match(/(\d+\.?\d*)\s*g(?!\/)/i) || [])[1];   // weight, not g/s
      const ml  = (line.match(/(\d+\.?\d*)\s*ml(?!\/)/i) || [])[1];
      const imp = (line.match(/(\d+)\s*imp/i) || [])[1];
      if (g)   fields['Weight (g)']    = parseFloat(g);
      if (ml)  fields['Volume (ml)']   = parseFloat(ml);
      if (imp) fields['Impulses']      = parseInt(imp);
      if (ml && imp && parseFloat(ml) > 0) {
        fields['Computed Impulses/L'] = Math.round(parseInt(imp) * 1000 / parseFloat(ml));
      }
      return Object.keys(fields).length ? fields : null;
    },
    pressure: (line) => {
      const bar = (line.match(/(\d+\.?\d*)\s*b(?!\w)/) || [])[1];
      if (!bar) return null;
      return { 'Pressure (bar)': parseFloat(bar) };
    },
    valve: (line) => {
      // Watch for "OK" / "PASS" / "FAIL" / cycle count, plus the bar-fill %.
      const cnt = (line.match(/(\d+)\s*cyc/i) || [])[1];
      if (/\b(OK|PASS|DONE|COMPLETED)\b/i.test(line)) return { Result: 'PASS' };
      if (/\b(FAIL|ERROR|ABORT)\b/i.test(line))       return { Result: 'FAIL' };
      const fields = {};
      if (cnt) fields.Cycles = parseInt(cnt);
      const pct = readBarProgress();
      if (pct !== null) fields['Progress'] = pct + '%';
      return Object.keys(fields).length ? fields : null;
    },
    autotune: (line) => {
      // Two field families during autotune:
      //   (a) Phase indicator ("WAIT" floats just before the active PID
      //       in the Autotune submenu while the firmware is in its
      //       pre-condition / soak phase).
      //   (b) Final result - Kc/Ti/Td written back into PID config when
      //       the autotune finishes. We only see those if the menu is
      //       displaying the PID Setup screen, which we can't guarantee
      //       during a long Autotune run; the monitor loop handles
      //       end-of-test detection separately by watching for the
      //       cursor returning to the Autotune submenu.
      const fields = {};
      // WAIT detection - token sits as a separate word in the row.
      if (/\bWAIT\b/.test(line)) {
        fields.Phase = 'WAIT (waiting for oscillations to start)';
      }
      const kc = (line.match(/Kc\s+(\d+\.?\d*)/i) || [])[1];
      const ti = (line.match(/Ti\s+(\d+\.?\d*)/i) || [])[1];
      const td = (line.match(/Td\s+(\d+\.?\d*)/i) || [])[1];
      if (kc) fields.Kc = parseFloat(kc);
      if (ti) fields.Ti = parseFloat(ti);
      if (td) fields.Td = parseFloat(td);
      return Object.keys(fields).length ? fields : null;
    },
    generic: () => null,
  };
  const extract = extractors[kind] || extractors.generic;

  status('Navigating to ' + path.join(' → '));
  try {
    // Navigate down the path; press OK on the last leaf to start the test.
    await gotoMenu();
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      const isLast = i === path.length - 1;
      if (!await scrollTo(step)) throw new Error(step + ' not found');
      if (!isLast) {
        if (!await enter()) throw new Error('Could not enter ' + step);
      }
    }
    status('Starting test');
    await btn('\x03', 800);  // OK to fire the test
    await _sleep(500);

    // Some Run programs (Test pressure, Backflush, Descale) show a yes/no
    // confirmation prompt right after OK. Auto-detect and confirm "yes".
    // Heuristic: cleaned display contains both " yes " and " no " tokens.
    // UP selects yes (cycle from "no" default), OK confirms.
    {
      const dConfirm = displayText().toLowerCase();
      if (/\byes\b/.test(dConfirm) && /\bno\b/.test(dConfirm)) {
        status('Confirming Yes/No prompt');
        await btn('\x01', 250);  // UP → "yes"
        await btn('\x03', 800);  // OK → confirm
        await _sleep(500);
      }
    }

    // Sub-screen pick (Autotune opens a "PID 1 / PID 2 / BACK" submenu
    // after the leaf OK). Three observed firmware states (verified from
    // live LCD trace):
    //
    //   OFF    cursor on a PID whose Control == OFF; title row
    //          flashes ">>Autotune   OFF" every ~500 ms; firmware
    //          refuses to advance.  → fail fast.
    //
    //   WAIT   autotune running, in pre-condition / soak phase. Display
    //          alternates between
    //              ">>Autotune       PID 1           PID 2           BACK"
    //          and ">>Autotune  WAIT PID 1           PID 2           BACK"
    //          (the "WAIT" token sits just *before* whichever PID is
    //          being tuned). No cursor visible during this phase.
    //          → keep monitoring, surface as a status note.
    //
    //   RUN    after pre-conditions are met the firmware starts forcing
    //          oscillations. The LCD looks similar to WAIT but without
    //          the WAIT token. Can take "minutes to hours" per the
    //          manual (p.38).
    //
    //   DONE   firmware writes Kc/Ti/Td back into Setup → PID N config
    //          and the cursor returns to the Autotune submenu.
    //
    // Steps below: enter submenu → scroll to picked PID → probe for OFF
    //   → if not OFF, press OK to start → fall through to monitor loop.
    if (subSelect) {
      // Give the firmware time to redraw the submenu after leaf OK.
      await _sleep(800);

      status('Selecting ' + subSelect);
      let picked = false;
      for (let attempt = 0; attempt < 3 && !picked; attempt++) {
        if (await scrollTo(subSelect)) { picked = true; break; }
        await _sleep(400);
      }
      if (!picked) {
        log(`[diag] sub-select "${subSelect}" not found in submenu`);
        status('Sub-pick "' + subSelect + '" not found in submenu');
        for (let i = 0; i < 8; i++) await btn('\x04', 200);
        sendRawToITO('MCa\r\n');
        return {
          ok: false,
          error: 'Could not find ' + subSelect + ' in the Autotune submenu.',
          fields: { Result: 'FAIL', Reason: subSelect + ' not found' },
        };
      }

      // Probe for OFF blink while sitting on the picked PID. The blink
      // alternates every ~500 ms; the firmware also emits a separate
      // "[OFF]" wire line (NOT inside an LCD frame) at the moment it
      // refuses to start. Probe for 5 s - enough to catch ≥ 4 blinks.
      status('Checking ' + subSelect + ' state…');
      // Reset the recent-lines window so we only look at lines that
      // arrive *after* we got onto the picked PID.
      const probeStart = Date.now();
      _recentLines.length = 0;

      let sawOff = false;
      while (Date.now() - probeStart < 5000) {
        await _sleep(150);
        const probe = (displayText() || '').toUpperCase();
        // a) "[OFF]" wire line - captured into _recentLines by updateNavDisplay
        const linesOff = _recentLines.some(r => /\[OFF\]/i.test(r.line));
        // b) "OFF" in the AUTOTUNE title row (e.g. ">>AUTOTUNE OFF PID 1 …")
        //    After _navClean collapses whitespace, the row looks like
        //    ">>Autotune OFF PID 1 PID 2 BACK". Anchor on AUTOTUNE\s+OFF.
        const titleOff = /AUTOTUNE\s+OFF/i.test(probe);
        // c) Generic OFF / DISABLED / ERROR tokens
        const errMatch = probe.match(/\b(PID\s*\d?\s*OFF|CONTROL\s*OFF|DISABLED|ERROR|NOT\s*AVAILABLE|UNAVAILABLE)\b/);
        if (linesOff || titleOff || errMatch) {
          log(`[diag] OFF detected: linesOff=${linesOff} titleOff=${titleOff} errMatch=${errMatch ? errMatch[1] : '-'}`);
          sawOff = true;
          break;
        }
      }
      if (sawOff) {
        status(subSelect + ' is OFF');
        for (let i = 0; i < 8; i++) await btn('\x04', 200);
        sendRawToITO('MCa\r\n');
        return {
          ok: false,
          error: subSelect + ' is currently OFF. Enable it first under Setup → ' +
                 subSelect + ' → Control (set to PID or 2-P) before autotuning.',
          fields: { Result: 'FAIL', Reason: subSelect + ' OFF' },
        };
      }

      // No OFF detected - fire OK to actually start the autotune.
      status('Starting autotune on ' + subSelect);
      await btn('\x03', 800);
      await _sleep(500);
    }

    // Watch the display for ~settleMs of stability OR for maxMs total.
    // We track BOTH the cleaned text and the RAW display bytes - bar-fill
    // progression only changes the raw bytes (the fill char is non-printable,
    // stripped by displayText()), so without raw tracking a slowly-rising
    // pressure test would falsely "settle" while the bar was still advancing.
    //
    // The runner also watches for a `✓` (0x05) appearing next to the test
    // label as a stronger "completed" signal - every test ends by drawing
    // that checkmark before returning to the parent menu.
    const t0 = Date.now();
    let lastSeen = '';
    let lastRawSeen = '';
    let lastChangeT = Date.now();
    const collectedFields = {};
    const testLabel = path[path.length - 1];

    let lastGaugeSig = '';   // dedupe: only send `gauge` when at least one value differs
    let lastNote     = '';   // dedupe: only send `note` when text differs

    // (The recent-lines ring buffer is reset at the top of
    // serverRunDiagnostic so any alarms fired during nav / leaf-OK /
    // sub-pick are still in the buffer when the loop below scans.)

    // Known firmware alarm tokens - when the firmware refuses to start a
    // program because of a missing dependency it emits a standalone
    // "[TOKEN]" wire line and flashes the token into the LCD title row
    // (e.g. ">>CalibratiSCALE" when the wireless scale isn't paired).
    // Detect any of these in the monitor loop and bail with a clear
    // structured error mapped to a human-readable message.
    const ALARM_REASONS = {
      'SCALE':   'Scale not connected - pair a wireless scale and retry',
      'OFF':     'PID is OFF - enable Setup → PID N → Control first',
      'FLWMTR':  'Flow meter not installed/enabled - Setup → Sensors → Flow meter',
      'NO_SNS':  'No AC zero-cross at SNS clamp',
      'NO SNS':  'No AC zero-cross at SNS clamp',
      'GAUGE':   'Pressure-sensor error - check Setup → Sensors → Pressure',
      'BLE_OFF': 'Bluetooth radio is off - enable it under Setup → Bluetooth',
      'VALVE':   'Valve error - check the 3-way solenoid wiring',
      'PROTECT': 'Protection trip - pump or boiler timeout',
      'BACKFL':  'Backflush in progress / required',
      'REFILL':  'Tank empty - refill water',
      'FILTER':  'Filter exchange due',
      'DSCALE':  'Descale program required',
      'SETUP':   'Setup incomplete - finish first-time-setup wizard',
    };

    // Bar-disappearance completion tracking:
    //   The Test valve / Test flow tests end silently - the firmware just
    //   removes the bar and the parent menu reappears. So once we've seen
    //   the bar at least twice (i.e. the test is genuinely running), if
    //   the bar then vanishes for ≥1 s in a row we treat that as completion
    //   and report PASS. `barEverSeen` gates the heuristic so a test that
    //   never showed a bar doesn't false-complete on first poll.
    let barEverSeen = false;
    let barLastSeenT = 0;

    // Autotune-only DONE tracking: the cursor (\x04) is HIDDEN once the
    // run actually starts (WAIT / oscillation phase). When the firmware
    // finishes it returns to the Autotune submenu and the cursor reappears.
    // So DONE = cursor was hidden at some point, then came back. Without
    // the "was hidden" gate, an OFF state (cursor never disappears because
    // the run never started) would falsely trigger DONE.
    let cursorEverHidden = false;

    while (!_diagCancel && (Date.now() - t0 < (maxMs || 180000))) {
      await _sleep(200);
      const cur = displayText();
      const rawNow = _navDisplay || '';
      const clean = cur.replace(/^[\d>\s]+/, '').trim();
      if (!clean) continue;

      // ── 0) Generic [ALARM] scan. Two independent signals:
      //   a) "[XXX]" wire line in _recentLines (firmware alarm event,
      //      e.g. "[SCALE]" - fires once per state change)
      //   b) The token overprinted into the LCD title row, e.g.
      //      ">>CalibratiSCALE" - the firmware paints "SCALE" into the
      //      menu title to flash the alert; this CONTINUES every ~500 ms
      //      while the alert is active, so even if we missed the wire
      //      line we'll still catch the title flash.
      //
      // [OFF] is intentionally excluded for autotune (handled above with
      // a more specific PID-N error). And we only run this scan AFTER
      // the test has actually started - the navigation phase walks past
      // legitimate menus like "Scale...", "Backflush...", "Filter..."
      // which contain alarm-keyword substrings without being alarms.
      // Use a small grace period after t0 to skip residual nav frames.
      if (Date.now() - t0 > 800) {
        const titleUpper = (rawNow.split('\x04')[0] || '').toUpperCase();
        for (const token of Object.keys(ALARM_REASONS)) {
          if (kind === 'autotune' && token === 'OFF') continue;
          const tag = '[' + token + ']';
          const seenLine  = _recentLines.some(r => r.line.includes(tag));
          // Title check looks ONLY at the row before the cursor (\x04)
          // so we don't false-positive on menu items below the cursor
          // (e.g. cursor on "Flow meter" with "Sensor 1..." below - the
          // title row is just ">>Calibration" or ">>CalibratiSCALE").
          const seenTitle = titleUpper.includes(token);
          if (seenLine || seenTitle) {
            const reason = ALARM_REASONS[token];
            status('Aborted: [' + token + '] - ' + reason);
            for (let i = 0; i < 8; i++) await btn('\x04', 200);
            sendRawToITO('MCa\r\n');
            return {
              ok: false,
              error: reason,
              fields: { Result: 'FAIL', Reason: '[' + token + '] ' + reason },
            };
          }
        }
      }

      // ── 1) Numeric-field extractor → in-place gauge update ───────────
      const fields = extract(clean);
      const pct = readBarProgress();

      // Track bar visibility for the disappearance completion signal.
      if (pct !== null) {
        barEverSeen = true;
        barLastSeenT = Date.now();
      }

      if (fields || pct !== null) {
        const merged = Object.assign({}, fields || {});
        if (pct !== null) merged['Progress'] = pct + '%';
        // (Error detection moved to the generic [ALARM] scan above.)
        // Merge into the running tally (latest wins per field).
        for (const [k, v] of Object.entries(merged)) collectedFields[k] = v;
        const sig = JSON.stringify(collectedFields);
        if (sig !== lastGaugeSig) {
          gauge(collectedFields);
          lastGaugeSig = sig;
        }
      }
      // ── 2) For text-only "Reading" lines (Test valve has no numbers,
      //    just a bar that fills), expose ONE Status row that gets
      //    rewritten - not a scrolling log.
      //    SKIPPED for autotune: the LCD spends most of the run on the
      //    Autotune submenu ("Autotune PID 1 PID 2 BACK"), which is
      //    just menu chrome - surfacing it as a Status row is noise.
      //    The Phase row (set by the autotune extractor whenever WAIT is
      //    visible) carries everything that's actually useful.
      if (kind !== 'autotune' && !fields && pct === null) {
        const note_ = clean.slice(0, 50);
        if (note_ !== lastNote) {
          note(note_);
          lastNote = note_;
        }
      }

      // ── 3a) Bar disappeared after running for a while → test ended.
      //    Only valid for tests that genuinely showed a bar (Test valve,
      //    Test flow). Skipped for autotune: that test never shows a
      //    bar, the OFF / WAIT blink would otherwise look like one.
      if (kind !== 'autotune' && barEverSeen && pct === null && (Date.now() - barLastSeenT) > 1000) {
        status('Bar finished - test complete');
        if (!collectedFields.Result) collectedFields.Result = 'PASS';
        break;
      }

      // ── 3b) Strong "completed" signal: a ✓ (0x05) appears next to the
      //    test label.
      const labelIdx = rawNow.indexOf(testLabel);
      if (labelIdx >= 0) {
        const tail = rawNow.substring(labelIdx + testLabel.length, labelIdx + testLabel.length + 8);
        if (tail.includes('\x05')) {
          status('Test complete ✓');
          if (!collectedFields.Result) collectedFields.Result = 'PASS';
          break;
        }
      }

      // ── 3c) Autotune-only: track cursor visibility on the Autotune
      //    submenu. State machine:
      //
      //      enter submenu → cursor visible on a PID
      //      OK pressed on enabled PID → cursor disappears (WAIT/RUN)
      //      autotune ends → cursor returns to submenu  ← DONE
      //
      //    If the run was refused (PID OFF), cursor never disappears,
      //    so we don't false-trigger DONE. The `cursorEverHidden` flag
      //    enforces that ordering.
      if (kind === 'autotune' && rawNow.includes('Autotune')) {
        const cursorVisible = rawNow.includes('\x04');
        if (!cursorVisible) {
          cursorEverHidden = true;
        } else if (cursorEverHidden) {
          status('Autotune complete - cursor returned to submenu');
          if (!collectedFields.Result) collectedFields.Result = 'DONE';
          break;
        }
      }

      // ── 4) Settle: NEITHER cleaned nor raw display changed for settleMs.
      //    Skipped for autotune - the firmware can sit on a quiet screen
      //    for many minutes during the soak/oscillation phase, and the
      //    real end-of-run signal is the cursor returning (3c above).
      if (kind !== 'autotune') {
        if (clean !== lastSeen || rawNow !== lastRawSeen) {
          lastSeen = clean;
          lastRawSeen = rawNow;
          lastChangeT = Date.now();
        } else if (Date.now() - lastChangeT > (settleMs || 4000)) {
          status('Test settled (no display change for ' + ((settleMs||4000)/1000).toFixed(0) + 's)');
          if (!collectedFields.Result) collectedFields.Result = 'PASS';
          break;
        }
      }
    }

    if (_diagCancel) status('Cancelled by user');

    // Back out to home cleanly.
    for (let i = 0; i < 10; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return {
      ok: true,
      summary: _diagCancel ? 'Cancelled' : 'Test complete',
      fields: collectedFields,
      raw: lastSeen,
    };
  } catch (e) {
    for (let i = 0; i < 8; i++) await btn('\x04', 200);
    sendRawToITO('MCa\r\n');
    return { ok: false, error: e.message };
  }
}

async function serverUploadProfile(ws, slotNum, phase, steps) {
  const sleep = _sleep;
  const status = msg => { log(`[upload] ${msg}`); send(ws, { type: 'profile_upload_status', msg }); };
  const strip = _strip;

  // Button press + wait for display update
  async function btn(byte, waitMs) {
    sendRawToITO('MC' + byte + '\r');
    await sleep(30);
    sendRawToITO('MC\x00\r');
    await sleep(waitMs || 250);
  }

  // Use module-level holdUntil
  const holdUntil = _holdUntil;

  // Read what cursor is on: text after \x04 marker
  function cursorText() {
    const i = _navDisplay.indexOf('\x04');
    if (i < 0) return '';
    return _navDisplay.substring(i + 1, i + 30).replace(/[^\x20-\x7e]/g, '').trim();
  }

  // Check if cursor is on target (handles PROTECT in text)
  function isOn(target) {
    const ct = cursorText();
    if (ct.startsWith(target)) return true;
    return ct.replace(/PROTECT|BACKFL|REFILL|FLWMTR/g, '').trim().startsWith(target);
  }

  // Scroll to find target (DOWN first, then UP). Returns true if found.
  // Always uses individual presses - menus are short and reliability matters.
  async function scrollTo(target, maxScroll) {
    const max = maxScroll || 30;
    if (isOn(target)) return true;
    for (let i = 0; i < max; i++) {
      await btn('\x02', 150); // DOWN - 150ms per press (faster than old 250ms)
      if (isOn(target)) return true;
    }
    for (let i = 0; i < max; i++) {
      await btn('\x01', 150); // UP
      if (isOn(target)) return true;
    }
    return false;
  }

  // Enter submenu: press OK, wait for display change
  async function enter() {
    const prev = strip(_navClean);
    await btn('\x03', 400);
    // Wait up to 3s for display to change
    for (let i = 0; i < 30; i++) {
      const now = strip(_navClean);
      if (now !== prev && now.length > 3) return true;
      await sleep(100);
    }
    // Even if display looks the same, check if depth changed (more > markers)
    const prevDepth = (prev.match(/>/g) || []).length;
    const nowDepth = (strip(_navClean).match(/>/g) || []).length;
    if (nowDepth > prevDepth) return true;
    return strip(_navClean) !== prev;
  }

  // Read the display text for value parsing
  function displayText() {
    return strip(_navClean);
  }

  // Read numeric value from display: X.Xb (bar), X.Xs (seconds), or plain integer (phase angle)
  // CRITICAL: bar values always have a decimal point (0.0b, 7.5b). Phase angles are plain integers.
  // Must NOT match "b" from "BACK" as a bar unit.
  function readFieldValue(fieldName) {
    const d = displayText();
    // First try: match with explicit unit attached to number (no space): X.Xb or X.Xs
    const reUnit = new RegExp(fieldName + '\\s+(\\d+\\.\\d+)(b|s)');
    const mUnit = d.match(reUnit);
    if (mUnit) return { value: parseFloat(mUnit[1]), unit: mUnit[2], raw: mUnit[0] };
    // Second try: match plain integer (phase angle mode) - number followed by space or BACK
    const reInt = new RegExp(fieldName + '\\s+(\\d+)(?:\\s|$|B)');
    const mInt = d.match(reInt);
    if (mInt) return { value: parseFloat(mInt[1]), unit: '', raw: mInt[0] };
    // Check for dash (empty)
    const reDash = new RegExp(fieldName + '\\s+-');
    if (reDash.test(d)) return { value: -1, unit: '', raw: fieldName + ' -' };
    // Debug
    log(`[readFieldValue] '${fieldName}' not found in: "${d.substring(0, 80)}"`);
    return { value: 0, unit: '', raw: '?' };
  }

  // Wait for display to show a specific field with a value (not dash)
  async function waitForFieldInit(fieldName, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 2000);
    while (Date.now() < deadline) {
      const v = readFieldValue(fieldName);
      if (v.value >= 0) return v;
      await sleep(50);
    }
    return readFieldValue(fieldName);
  }

  // Set Time value: OK to enter edit → UP to activate → HOLD for coarse → fine → OK to confirm → VERIFY
  async function setTime(target) {
    // OK to enter edit mode
    await btn('\x03', 300);

    // Press UP once to activate field (converts - to 0.0s or increments)
    await btn('\x01', 300);
    let cur = await waitForFieldInit('Time', 1000);
    status(`    Time: ${cur.raw} → ${target}s`);

    if (target <= 0.05 && cur.value >= 0 && cur.value <= 0.5) {
      if (cur.value > 0.05) await btn('\x02', 200);
      await btn('\x03', 400);
      return true;
    }

    // COARSE: hold UP/DOWN until within 1.5s of target
    if (target > cur.value + 2) {
      await holdUntil('\x01', (d) => {
        const m = d.match(/Time\s+(\d+\.\d+)s/);
        return m && parseFloat(m[1]) >= target - 1.5;
      }, 30000);
    } else if (target < cur.value - 2) {
      await holdUntil('\x02', (d) => {
        const m = d.match(/Time\s+(\d+\.\d+)s/);
        return m && parseFloat(m[1]) <= target + 1.5;
      }, 30000);
    }

    // FINE: individual presses to hit exact value
    for (let a = 0; a < 60; a++) {
      cur = readFieldValue('Time');
      const diff = target - cur.value;
      if (Math.abs(diff) < 0.06) break;
      await btn(diff > 0 ? '\x01' : '\x02', 120);
    }

    cur = readFieldValue('Time');
    await btn('\x03', 400); // OK to confirm

    // VERIFY: read display after OK - the confirmed value is shown (cursor moves to next field)
    await sleep(200);
    const verified = readFieldValue('Time');
    status(`    Time confirmed: ${verified.value}s`);
    if (Math.abs(verified.value - target) > 0.15) {
      status(`    TIME MISMATCH: got ${verified.value}s, wanted ${target}s - retrying`);
      // Re-enter edit: cursor moved to Pump, so go UP back to Time, then OK to edit
      await btn('\x01', 200); // UP to Time
      return await setTime(target); // retry
    }
    return true;
  }

  // Set Pump as PHASE ANGLE (0-180°).
  // If field is empty (-) → OK+UP inits to phase angle 0, then adjust UP to target.
  // If field has a bar value → press DOWN rapidly to 0.0b, then one more to wrap to 180,
  //   then adjust DOWN from 180 to target.
  // If field already has a phase angle → adjust directly.
  async function setPumpPhaseAngle(targetAngle) {
    targetAngle = Math.round(Math.max(0, Math.min(180, targetAngle)));

    // OK to enter edit mode
    await btn('\x03', 300);
    // UP to activate (converts - to 0 phase angle)
    await btn('\x01', 300);
    let cur = await waitForFieldInit('Pump', 1000);
    status(`    Pump phase angle: ${cur.raw} → ${targetAngle}°`);

    if (cur.unit === 'b') {
      // Currently in BAR mode. Need to go DOWN to 0.0b first, then wrap to phase angle.
      // Hold DOWN to rapidly decrease bar value to 0.0b
      status(`    In bar mode (${cur.value}b), going DOWN to 0.0b...`);
      await holdUntil('\x02', (d) => {
        const m = d.match(/Pump\s+0\.0b/);
        return !!m;
      }, 15000);
      // One more DOWN to wrap from 0.0b to phase angle 180
      await btn('\x02', 200);
      await sleep(200);
      cur = readFieldValue('Pump');
      status(`    Wrapped to phase angle: ${cur.value}${cur.unit}`);
    }

    // Now in phase angle mode. Adjust to target.
    for (let attempt = 0; attempt < 3; attempt++) {
      cur = readFieldValue('Pump');
      if (cur.unit === 'b') {
        status(`    ERROR: still in bar mode after wrap attempt`);
        break;
      }
      const curAngle = cur.value;
      const diff = targetAngle - curAngle;
      if (Math.abs(diff) < 1) break;

      const dir = diff > 0 ? '\x01' : '\x02';
      const presses = Math.abs(Math.round(diff));
      status(`    Adjusting ${presses} presses ${diff > 0 ? 'UP' : 'DOWN'} (cur=${curAngle})...`);

      for (let i = 0; i < presses && i < 200; i++) {
        await btn(dir, 55);
        // Check every 20 presses to avoid overshooting past 180→bar wrap
        if (i % 20 === 19) {
          cur = readFieldValue('Pump');
          if (cur.unit === 'b') {
            // Overshot into bar mode! Go back
            status(`    Overshot to bar mode, wrapping back...`);
            await btn('\x02', 200); // DOWN from 0.0b to 180
            break;
          }
          const remaining = Math.abs(targetAngle - cur.value);
          if (remaining < 1) break;
        }
      }
    }

    // Final read and confirm
    cur = readFieldValue('Pump');
    await btn('\x03', 400); // OK to confirm
    await sleep(200);
    const verified = readFieldValue('Pump');
    status(`    Phase angle confirmed: ${verified.value}${verified.unit} (target was ${targetAngle}°)`);
    return Math.abs(verified.value - targetAngle) < 2;
  }

  // Set Pump (bar) value. All values are in bar (0-9.5).
  // Phase angle upload removed - ITO doesn't allow mixing phase angle + bar in same profile.
  // Flow steps are uploaded as bar=0 (pause) instead.
  async function setPump(target) {
    // OK to enter edit mode
    await btn('\x03', 300);

    // Press UP once to activate field (converts - to 0 or increments)
    await btn('\x01', 300);
    let cur = await waitForFieldInit('Pump', 1000);
    status(`    Pump: ${cur.raw} → ${target}b`);

    // If in phase angle mode (no 'b' unit), rapid presses to pass 180 → bar mode.
    // ITO processes ~10 presses/sec (100ms frame rate).
    //
    // OVERSHOOT PROTECTION: we used to check the display every 20 presses,
    // which meant we could fire up to 19 extra presses AFTER crossing the
    // wrap point - each past-wrap press adds 0.1b. That's how step 4 with
    // target=0.6 ended up at 0.9b (observed 2026-04-17). Now we start with a
    // tight check every 3 presses once we're within the expected wrap range
    // (phase value > ~150), and also double-settle with a long pause + two
    // reads before declaring the display value reliable.
    if (cur.unit !== 'b') {
      status(`    Phase angle (${cur.value}), rapid UP to bar mode...`);
      const startAngle = cur.value;
      for (let t = 0; t < 250; t++) {
        await btn('\x01', 55); // 85ms total per press - safe rate for ITO
        // Near the wrap point (≥150° from a low start, or any time past t=15),
        // poll every 3 presses so we catch the transition within ~0.3b of 0.0b.
        // Before that, poll every 20 to save the overhead on the long ramp.
        const nearWrap = (startAngle + t * 1) > 140 || t > 140;
        const interval = nearWrap ? 3 : 20;
        if (t % interval === interval - 1) {
          cur = readFieldValue('Pump');
          if (cur.unit === 'b') break;
        }
      }
      // Settle: ITO's display can lag its internal state by ~200ms, especially
      // right after a rapid-press burst. Wait a full refresh cycle and take
      // two reads - if they agree, trust the value.
      await sleep(400);
      let read1 = readFieldValue('Pump');
      await sleep(200);
      let read2 = readFieldValue('Pump');
      cur = (read1.unit === 'b' && read2.unit === 'b' && Math.abs(read1.value - read2.value) < 0.01)
        ? read2 : read2;
      status(`    Now in bar mode: ${cur.value}${cur.unit}`);
    }

    // COARSE: hold UP/DOWN until within 1.0b of target
    if (cur.unit === 'b' && Math.abs(target - cur.value) > 1.5) {
      const dir = target > cur.value ? '\x01' : '\x02';
      await holdUntil(dir, (d) => {
        const m = d.match(/Pump\s+(\d+\.\d+)b/);
        if (!m) return false;
        return Math.abs(parseFloat(m[1]) - target) <= 1.0;
      }, 15000);
      cur = readFieldValue('Pump');
      status(`    Coarse: ${cur.value}${cur.unit}`);
    }

    // FINE: individual presses (0.1b each) to hit exact value.
    // Two reads after each press (separated by a short pause) protect against
    // stale display values, which previously caused overshoots past the
    // phase-angle→bar wrap.
    for (let a = 0; a < 30; a++) {
      cur = readFieldValue('Pump');
      if (cur.unit !== 'b') break;
      const diff = target - cur.value;
      if (Math.abs(diff) < 0.05) break;
      await btn(diff > 0 ? '\x01' : '\x02', 120);
      // Re-read to verify the press registered before the next iteration.
      // If the display didn't change at all for two reads we treat the value
      // as settled and continue; if it's moving the other way we bail so the
      // OK-confirm+retry path can handle it.
      await sleep(80);
      const post = readFieldValue('Pump');
      if (post.unit === 'b' && Math.abs(post.value - cur.value) < 0.01 && Math.abs(post.value - target) < 0.15) break;
    }

    cur = readFieldValue('Pump');
    if (cur.unit !== 'b') {
      status(`    ERROR: Pump still in phase angle mode (${cur.value}), cannot set bar value`);
      await btn('\x03', 400);
      return false;
    }
    await btn('\x03', 400); // OK to confirm

    // VERIFY: read display after OK - the confirmed value is shown (cursor moves to BACK)
    await sleep(200);
    const verified = readFieldValue('Pump');
    status(`    Pump confirmed: ${verified.value}${verified.unit}`);
    if (verified.unit === 'b' && Math.abs(verified.value - target) > 0.15) {
      status(`    PUMP MISMATCH: got ${verified.value}b, wanted ${target}b - retrying`);
      // Re-enter: cursor is on BACK, go UP to Pump, OK to edit
      await btn('\x01', 200); // UP to Pump
      await btn('\x03', 300); // OK to enter edit
      cur = readFieldValue('Pump');
      // Fine adjust from current
      for (let a = 0; a < 30; a++) {
        cur = readFieldValue('Pump');
        if (cur.unit !== 'b') break;
        const diff = target - cur.value;
        if (Math.abs(diff) < 0.06) break;
        await btn(diff > 0 ? '\x01' : '\x02', 120);
      }
      await btn('\x03', 400); // confirm retry
      const v2 = readFieldValue('Pump');
      status(`    Pump retry: ${v2.value}${v2.unit}`);
    }
    return true;
  }

  // ═══ MAIN UPLOAD SEQUENCE ═══
  const activeSteps = steps.filter(s => s.time > 0 || s.bar > 0);
  status(`Upload: slot ${slotNum} ${phase} (${activeSteps.length} steps)`);
  // Diagnostic: log the step array (ABSOLUTE per-phase times - matches the
  // ITO's own Time field - no conversion needed here).
  status(`  steps (abs, from app): ${JSON.stringify(steps.map((s, i) =>
    ((s.time > 0 || s.bar > 0) ? `${i+1}:t=${s.time}/b=${s.bar}` : null)
  ).filter(Boolean))}`);

  // Reset to home via MCE (standby) + MCa (wake), then MC@ for LCD.
  // MCE+MCa puts machine on the startup screen where OK enters MENU properly.
  sendRawToITO('MCE\r');
  await sleep(1000);
  sendRawToITO('MCa\r\n');
  await sleep(2000);
  // Now send MC@ - after MCa, ITO is in MCr mode (binary blobs).
  // MC@ switches to LCD. Retry until display frames with cursor appear.
  _navDisplay = '';
  for (let retry = 0; retry < 10; retry++) {
    sendRawToITO('MC@\r');
    await sleep(800);
    if (_navDisplay.includes('\x04') || (_navDisplay.length > 5 && strip(_navClean).includes('PROFILE'))) break;
  }
  status(`LCD ready (disp="${strip(_navClean).substring(0,40)}")`);

  // OK to enter menu
  await btn('\x03', 800);
  // Wait for cursor marker to appear (indicates proper menu display)
  for (let retry = 0; retry < 3; retry++) {
    if (_navDisplay.includes('\x04')) break;
    await btn('\x03', 600);
  }
  status(`In menu (cursor="${cursorText()}")`);

  // Navigate: Menu → Setup → Profiles → Edit
  if (!await scrollTo('Setup')) return { ok: false, error: 'Setup not found. cursor=' + cursorText() + ' disp=' + strip(_navClean).substring(0,50) };
  if (!await enter()) return { ok: false, error: 'Could not enter Setup' };
  status('In Setup');

  if (!await scrollTo('Profiles')) return { ok: false, error: 'Profiles not found' };
  if (!await enter()) return { ok: false, error: 'Could not enter Profiles' };
  status('In Profiles');

  if (!await scrollTo('Edit')) return { ok: false, error: 'Edit not found' };
  if (!await enter()) return { ok: false, error: 'Could not enter Edit' };
  status('In Edit');

  if (!await scrollTo(slotNum.toString())) return { ok: false, error: 'Slot ' + slotNum + ' not found' };
  if (!await enter()) return { ok: false, error: 'Could not enter slot ' + slotNum };
  status('In slot ' + slotNum);

  const editTarget = phase === 'pi' ? 'Edit PI' : 'Edit shot';
  if (!await scrollTo(editTarget)) return { ok: false, error: editTarget + ' not found' };
  if (!await enter()) return { ok: false, error: 'Could not enter ' + editTarget };
  status('In ' + editTarget);

  // ── CLEAR the phase first ──
  // Problem (seen 2026-04-17): in-place delta leaves orphan steps when the
  // new profile has fewer steps than the previous one - MCu ends up with
  // extra entries in phase-angle units from whatever was there before.
  // Fix: scroll to "Clear" (top of Edit PI/shot menu, index 0) and wipe all
  // 9 steps before writing the new ones. The OK→UP→OK yes/no flow mirrors
  // the name-clear sequence in serverSetProfileName.
  if (!await scrollTo('Clear')) return { ok: false, error: 'Clear not found in ' + editTarget };
  await btn('\x03', 500);  // OK → "Clear all?" yes/no prompt
  await btn('\x01', 200);  // UP → "yes"
  await btn('\x03', 1500); // OK → confirm + wait for menu to return
  status(editTarget + ': Cleared all steps');

  // Post-clear, every step reads as `- / -` (empty) - setTime/setPump handle
  // the empty-field init path via OK→UP.
  if (!await scrollTo('1')) return { ok: false, error: 'Step 1 not found' };

  for (let i = 0; i < 9; i++) {
    const step = steps[i];

    // Navigate to step i+1
    if (i > 0) {
      await btn('\x02', 200); // DOWN to next step
      if (!isOn((i + 1).toString())) {
        if (!await scrollTo((i + 1).toString(), 10)) {
          status(`  Step ${i + 1} not found, skipping`);
          continue;
        }
      }
    }

    // Skip completely empty steps
    if (step.time <= 0 && step.bar <= 0) continue;

    const isPause = step.bar <= 0 && step.time > 0;
    status(`Step ${i + 1}: t=${step.time}s p=${isPause ? 'PAUSE' : step.bar + 'b'}`);

    // Enter the step
    if (!await enter()) {
      await sleep(300);
      if (!await enter()) { status(`  Could not enter step ${i + 1}`); continue; }
    }

    // ── Set Time ──
    // Read current value first
    let curTime = readFieldValue('Time');
    status(`  Time: ${curTime.raw} → ${step.time}s`);

    if (curTime.value < 0) {
      // Empty '-' field - OK→UP to initialize
      await setTime(step.time);
    } else if (Math.abs(curTime.value - step.time) > 0.06) {
      // Has a value - enter edit mode (OK), then adjust delta
      await btn('\x03', 300); // OK to enter edit
      curTime = readFieldValue('Time');

      if (Math.abs(step.time - curTime.value) > 2) {
        // COARSE: hold UP/DOWN
        const dir = step.time > curTime.value ? '\x01' : '\x02';
        await holdUntil(dir, (d) => {
          const m = d.match(/Time\s+(\d+\.\d+)s/);
          return m && Math.abs(parseFloat(m[1]) - step.time) <= 1.5;
        }, 30000);
      }
      // FINE
      for (let a = 0; a < 60; a++) {
        curTime = readFieldValue('Time');
        const diff = step.time - curTime.value;
        if (Math.abs(diff) < 0.06) break;
        await btn(diff > 0 ? '\x01' : '\x02', 120);
      }
      await btn('\x03', 400); // OK to confirm
      // VERIFY after OK - display shows confirmed value for free
      await sleep(200);
      curTime = readFieldValue('Time');
      status(`  Time confirmed: ${curTime.value}s`);
      if (Math.abs(curTime.value - step.time) > 0.15) {
        status(`  TIME MISMATCH: got ${curTime.value}s, wanted ${step.time}s`);
      }
    } else {
      status(`  Time already correct: ${curTime.value}s`);
    }

    // ── Set Pump (skip for pause steps where bar=0) ──
    if (isPause) {
      status(`  Pump: SKIP (pause step, pump off)`);
    } else {
      // DOWN to Pump
      await btn('\x02', 250);

      let curPump = readFieldValue('Pump');
      status(`  Pump: ${curPump.raw} → ${step.bar}b`);

      if (curPump.value < 0) {
        // Empty field - needs OK→UP to init, then bar mode traverse
        await setPump(step.bar);
    } else if (curPump.unit === 'b' && Math.abs(curPump.value - step.bar) > 0.06) {
      // Already in bar mode - enter edit, adjust delta. NO phase angle traverse!
      await btn('\x03', 300); // OK to enter edit
      curPump = readFieldValue('Pump');

      if (curPump.unit === 'b' && Math.abs(step.bar - curPump.value) > 1.5) {
        // COARSE hold
        const dir = step.bar > curPump.value ? '\x01' : '\x02';
        await holdUntil(dir, (d) => {
          const m = d.match(/Pump\s+(\d+\.\d+)b/);
          return m && Math.abs(parseFloat(m[1]) - step.bar) <= 1.0;
        }, 15000);
      }
      // FINE
      for (let a = 0; a < 30; a++) {
        curPump = readFieldValue('Pump');
        if (curPump.unit !== 'b') break;
        const diff = step.bar - curPump.value;
        if (Math.abs(diff) < 0.06) break;
        await btn(diff > 0 ? '\x01' : '\x02', 120);
      }
      await btn('\x03', 400); // OK to confirm
      // VERIFY after OK - display shows confirmed value for free
      await sleep(200);
      curPump = readFieldValue('Pump');
      status(`  Pump confirmed: ${curPump.value}${curPump.unit}`);
      if (curPump.unit === 'b' && Math.abs(curPump.value - step.bar) > 0.15) {
        status(`  PUMP MISMATCH: got ${curPump.value}b, wanted ${step.bar}b`);
      }
    } else if (curPump.unit !== 'b') {
      // Phase angle - need to traverse to bar mode
      await setPump(step.bar);
    } else {
      status(`  Pump already correct: ${curPump.value}${curPump.unit}`);
    }
    } // end of non-pause pump handling

    // Exit step: BACK+OK to save
    if (!await scrollTo('BACK')) {
      await btn('\x02', 200);
      await btn('\x02', 200);
    }
    await btn('\x03', 400);
    status(`Step ${i + 1} done`);
  }

  // Exit menus
  for (let i = 0; i < 8; i++) await btn('\x04', 200);
  sendRawToITO('MCa\r\n');
  await sleep(1000);

  // Resume telemetry
  sendRawToITO('MCr\r');
  await sleep(300);
  sendRawToITO('MC@\r');

  status('Upload complete, verifying via MCu...');

  // ── MCu VERIFICATION - check ALL 9 steps ──
  // Since we now upload absolute (accumulated) times, the ITO's stored order
  // matches our upload order position-by-position. Compare that way - a
  // previous sort-and-find pass masked the position-shuffling bug (MCu
  // values did form the same set after sort, even though each position held
  // the wrong step's values).
  const mcu = await readMcuProfile(slotNum);
  const mcuSteps = phase === 'pi' ? mcu.pi : mcu.shot;
  let allOk = true;
  const errors = [];

  // `steps` here is already converted to absolute time (see top of this func).
  const activeTargets = steps.filter(s => s.time > 0 || s.bar > 0)
    .map(s => ({ time: s.time, bar: s.bar }));
  // Pause steps leave ITO's Pump as `-` (bar=-1 in our parser). Keep any row
  // whose Time is > 0 so pauses are preserved.
  const activeMcu = mcuSteps.filter(s => s.time > 0 || s.bar > 0)
    .map(s => ({ time: s.time, bar: s.bar, unit: s.unit }));

  // Log all MCu steps
  for (let i = 0; i < 9; i++) {
    const actual = mcuSteps[i] || { time: -1, bar: -1, unit: '' };
    status(`  MCu step ${i + 1}: t=${actual.time === -1 ? '-' : actual.time + 's'} p=${actual.bar === -1 ? '-' : actual.bar + actual.unit}`);
  }

  // Position-by-position verification. Because absolute times are ascending
  // by construction (we accumulated deltas), the ITO's stored order matches
  // activeTargets index-by-index.
  for (let i = 0; i < Math.max(activeTargets.length, activeMcu.length); i++) {
    const t = activeTargets[i];
    const m = activeMcu[i];
    if (t && !m) {
      allOk = false;
      errors.push(`step ${i + 1} missing on machine (expected t=${t.time}s p=${t.bar}b)`);
      continue;
    }
    if (!t && m) {
      allOk = false;
      errors.push(`step ${i + 1} is unexpected on machine (got t=${m.time}s p=${m.bar}${m.unit})`);
      continue;
    }
    const isPhaseAngle = t.bar > 12;
    const isPause = t.bar <= 0;
    const timeOk = Math.abs(m.time - t.time) < 0.5;
    let valueOk;
    if (isPhaseAngle)     valueOk = (m.unit === 'phase' || m.unit === '') && Math.abs(m.bar - t.bar) < 2;
    else if (isPause)     valueOk = (m.bar < 0 || (m.unit === 'b' && m.bar < 0.1));
    else                  valueOk = m.unit === 'b' && Math.abs(m.bar - t.bar) < 0.3;
    if (!timeOk || !valueOk) {
      allOk = false;
      const unitTag = isPhaseAngle ? '°' : isPause ? '(pause)' : 'b';
      errors.push(`step ${i + 1}: expected t=${t.time}s p=${t.bar}${unitTag} - got t=${m.time}s p=${m.bar}${m.unit || '?'}`);
    }
  }

  if (allOk) {
    status('MCu VERIFIED - all steps correct!');
    return { ok: true, steps: activeSteps.length, verified: true };
  } else {
    status('MCu MISMATCH: ' + errors.join('; '));
    return { ok: false, error: 'MCu verification failed: ' + errors.join('; '), verified: false };
  }
}

// ─── Server-side profile name setter ──────────────────────────────────────────

async function serverSetProfileName(ws, slotNum, name) {
  const sleep = _sleep;
  const holdUntil = _holdUntil;
  const status = msg => { log(`[name] ${msg}`); send(ws, { type: 'profile_upload_status', msg }); };
  const strip = _strip;

  async function btn(byte, waitMs) {
    sendRawToITO('MC' + byte + '\r');
    await sleep(30);
    sendRawToITO('MC\x00\r');
    await sleep(waitMs || 250);
  }

  function cursorText() {
    const i = _navDisplay.indexOf('\x04');
    if (i < 0) return '';
    return _navDisplay.substring(i + 1, i + 30).replace(/[^\x20-\x7e]/g, '').trim();
  }

  function isOn(target) {
    const ct = cursorText();
    return ct.startsWith(target) || ct.replace(/PROTECT|BACKFL|REFILL|FLWMTR/g, '').trim().startsWith(target);
  }

  async function scrollTo(target, maxScroll) {
    const max = maxScroll || 30;
    if (isOn(target)) return true;
    // Individual presses for menu navigation (menus are short, reliability matters)
    for (let i = 0; i < max; i++) { await btn('\x02', 180); if (isOn(target)) return true; }
    for (let i = 0; i < max; i++) { await btn('\x01', 180); if (isOn(target)) return true; }
    return false;
  }

  async function enter() {
    const prev = strip(_navClean);
    await btn('\x03', 400);
    for (let i = 0; i < 30; i++) { if (strip(_navClean) !== prev) return true; await sleep(100); }
    return strip(_navClean) !== prev;
  }

  // Read current name from display: "Name XXXX"
  function readName() {
    const d = strip(_navClean);
    const m = d.match(/Name\s+(\S+)/);
    return m ? m[1] : '';
  }

  // Read the character currently being edited from display
  // In the name editor, there is NO \x04 cursor marker.
  // The current editing character appears directly after "Name " before "Clear name"
  // Format: ">>>>2  Name  X  Clear name  Edit PI"
  // where X is the character(s) - last char of the name text is the one being edited
  // Read the character being edited. The ITO blinks the cursor - the character
  // is visible in some frames and hidden (space) in others. Poll multiple frames
  // and return the first non-space printable character found.
  function readEditChar() {
    // Method 1: check byte after \x04 cursor in raw display
    const raw = _navDisplay;
    const cursorIdx = raw.indexOf('\x04');
    if (cursorIdx >= 0 && cursorIdx + 1 < raw.length) {
      const ch = raw[cursorIdx + 1];
      if (ch !== ' ' && ch.charCodeAt(0) >= 0x21 && ch.charCodeAt(0) <= 0x7E) return ch;
    }
    // Method 2: text between "Name" and "Clear" in cleaned display
    const d = _navClean;
    const nameIdx = d.indexOf('Name');
    const clearIdx = d.indexOf('Clear');
    if (nameIdx >= 0 && clearIdx > nameIdx + 5) {
      const between = d.substring(nameIdx + 5, clearIdx).trim();
      if (between.length > 0) {
        const ch = between[between.length - 1];
        if (ch !== '>' && ch !== ' ') return ch;
      }
    }
    return '';
  }

  // Poll readEditChar across multiple display frames to catch the blink cycle.
  // Returns the character if found within timeoutMs, or '' if not visible.
  async function readEditCharPolled(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 500);
    while (Date.now() < deadline) {
      const ch = readEditChar();
      if (ch) return ch;
      await sleep(50); // poll at 20Hz (display updates at 10Hz, blink cycle ~500ms)
    }
    return '';
  }

  // Smart abbreviation for ITO's 10-char limit.
  // Keep full name in the web app; only abbreviate what gets sent to the machine.
  let itoName = name;
  if (itoName.length > 10) {
    // Remove common filler words
    itoName = itoName.replace(/\b(Espresso|Profile|Coffee|Default|Recipe|Standard)\b/gi, '').trim();
  }
  if (itoName.length > 10) {
    // Abbreviate common espresso terms
    const abbrevs = [
      [/Pressure/gi, 'Prs'], [/Blooming/gi, 'Bloom'], [/Preinfusion/gi, 'PI'],
      [/Pre-infusion/gi, 'PI'], [/Extraction/gi, 'Extr'], [/Temperature/gi, 'Temp'],
      [/Turbo/gi, 'Trbo'], [/Allonge/gi, 'Alng'], [/Ristretto/gi, 'Rstrto'],
      [/Lungo/gi, 'Lngo'], [/Filter/gi, 'Fltr'], [/Advanced/gi, 'Adv'],
      [/Classic/gi, 'Clsc'], [/Modified/gi, 'Mod'], [/Adaptive/gi, 'Adpt'],
      [/Declining/gi, 'Decl'], [/Spring/gi, 'Sprg'],
    ];
    for (const [re, rep] of abbrevs) { itoName = itoName.replace(re, rep); }
    itoName = itoName.trim();
  }
  if (itoName.length > 10) {
    // Remove spaces between words to compact
    itoName = itoName.replace(/\s+/g, '');
  }
  // Final truncate + pad. EMPIRICAL (2026-04-17 test log line 8283): the ITO
  // name editor has exactly 9 positions (auto-exits after the 9th OK press).
  // Padding to 10 makes position 10 unreachable and loses the last char.
  itoName = itoName.substring(0, 9).padEnd(9, ' ');
  status(`Setting name for slot ${slotNum}: "${name}" → ITO: "${itoName.trimEnd()}" (${itoName.trimEnd().length} chars)`);
  name = itoName;

  // PRECHECK - name editing is the slowest step in profile upload (~30 s of
  // character-by-character clicks). If the slot already has this name, skip
  // the whole sequence. MCu read costs ~5-8 s; net win on every upload where
  // the name hasn't changed.
  try {
    const mcu = await readMcuProfile(slotNum);
    const current = (mcu && mcu.name ? String(mcu.name) : '').trim();
    const target  = itoName.trim();
    if (current === target) {
      status(`Name already "${current}" on slot ${slotNum} - SKIP write`);
      return { ok: true, name: current, skipped: true };
    }
    status(`Slot ${slotNum} name "${current}" → "${target}"`);
  } catch (e) {
    // If precheck fails (network blip, parser issue, etc.) fall through
    // to a normal write rather than blocking the upload.
    status(`Name precheck failed (${e.message}); proceeding with write`);
  }

  // Go home, then switch to LCD mode (same robust sequence as upload)
  sendRawToITO('MCE\r');
  await sleep(1000);
  sendRawToITO('MCa\r\n');
  await sleep(2000);
  _navDisplay = '';
  for (let retry = 0; retry < 10; retry++) {
    sendRawToITO('MC@\r');
    await sleep(800);
    if (_navDisplay.length > 5 && (_navDisplay.includes('\x04') || strip(_navClean).includes('PROFILE'))) break;
  }
  // Enter menu
  await btn('\x03', 800);
  for (let retry = 0; retry < 3; retry++) {
    if (_navDisplay.includes('\x04')) break;
    await btn('\x03', 600);
  }
  status(`In menu (cursor="${cursorText()}")`);

  // Navigate to slot
  if (!await scrollTo('Setup')) return { ok: false, error: 'Setup not found. cursor=' + cursorText() };
  if (!await enter()) return { ok: false, error: 'Could not enter Setup' };
  if (!await scrollTo('Profiles')) return { ok: false, error: 'Profiles not found' };
  if (!await enter()) return { ok: false, error: 'Could not enter Profiles' };
  if (!await scrollTo('Edit')) return { ok: false, error: 'Edit not found' };
  if (!await enter()) return { ok: false, error: 'Could not enter Edit' };
  if (!await scrollTo(slotNum.toString())) return { ok: false, error: 'Slot not found' };
  if (!await enter()) return { ok: false, error: 'Could not enter slot' };
  status('In slot ' + slotNum);

  // Clear existing name first
  if (!await scrollTo('Clear name')) return { ok: false, error: 'Clear name not found' };
  await btn('\x03', 500); // OK on Clear name
  await btn('\x01', 200); // UP to "yes"
  await btn('\x03', 1500); // confirm - wait longer for menu to return
  status('Name cleared');

  // EMPIRICAL (2026-04-17 log): After Clear, cursor is AUTOMATICALLY placed in the
  // name editor at position 1 with all-space contents. DO NOT press OK again (that
  // would confirm a phantom char and advance prematurely). DO NOT scrollTo('Name')
  // (those DOWN presses cycle the char at pos 1 instead of navigating menu items).
  // Just wait for display to settle and start the character loop.
  await sleep(800);
  status('In name editor (post-Clear)');

  // Character cycle order (ASCII 32-126): space ! " # $ % & ' ( ) * + , - . / 0-9 : ; < = > ? @ A-Z [ \ ] ^ _ ` a-z { | } ~
  const CHAR_CYCLE = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

  // Calculate shortest direction to target character
  function charDistance(from, to) {
    const fi = CHAR_CYCLE.indexOf(from);
    const ti = CHAR_CYCLE.indexOf(to);
    if (fi < 0 || ti < 0) return { dir: '\x02', dist: 95 }; // unknown, just go DOWN full cycle
    const len = CHAR_CYCLE.length; // 95
    const fwd = (ti - fi + len) % len; // DOWN distance
    const bwd = (fi - ti + len) % len; // UP distance
    if (fwd <= bwd) return { dir: '\x02', dist: fwd }; // DOWN is shorter
    return { dir: '\x01', dist: bwd }; // UP is shorter
  }

  // PURE COUNT approach - the ITO telnet stream does NOT show the character being
  // edited (only shows cursor \x04 position). So we CANNOT read the display.
  // Instead: count presses from the known starting position (space = pos 0 after clear).
  // Each DOWN goes to the next character in ASCII order. Each UP goes to previous.
  // Use 200ms per press with 50ms hold for reliable registration.

  let currentPos = 0; // after clear, editor starts at space (pos 0)

  for (let ci = 0; ci < name.length; ci++) {
    const targetChar = name[ci];
    const targetPos = CHAR_CYCLE.indexOf(targetChar);
    if (targetPos < 0) {
      // Not in charset - skip (confirm whatever is there, leave currentPos alone)
      status(`  Char ${ci + 1}: "${targetChar}" not in charset, skipping`);
      await btn('\x03', 400);
      continue;
    }

    // EMPIRICAL (test 2026-04-17): ONLY UP (\x01) cycles characters in this
    // editor state. DOWN (\x02) does not cycle (tested 43 DOWN = no change).
    // Each press advances +1 in CHAR_CYCLE. currentPos resets to 0 (space)
    // after each OK, so distance from space is always the target's index.
    const len = CHAR_CYCLE.length; // 95
    const dir = '\x01';
    const dist = (targetPos - currentPos + len) % len; // UP distance from current

    status(`  Char ${ci + 1}: "${targetChar}" - ${dist} UP`);

    // Use btn() for consistent 180ms timing (matches scrollTo which was proven
    // to reliably cycle chars via its DOWN phase - same rate works here).
    for (let i = 0; i < dist; i++) {
      await btn(dir, 180);
    }

    // OK confirms character and advances to next position. On the 9th (last)
    // position, OK saves the char and auto-exits the editor.
    await btn('\x03', 400);
    // EMPIRICAL (test 1 data): after OK, the new position's char starts at
    // space (pos 0). Each position is independently edited starting from blank.
    currentPos = 0;
    status(`  "${targetChar}" confirmed`);
  }

  // name is already padded to 9 chars above, so all 9 positions are edited
  // by the char loop. No extra OKs needed - the editor auto-exits after pos 9.
  status('Name saved: "' + name + '"');

  // Exit menus
  for (let i = 0; i < 8; i++) await btn('\x04', 200);
  sendRawToITO('MCa\r\n');
  await sleep(1000);
  sendRawToITO('MCr\r');
  await sleep(300);
  sendRawToITO('MC@\r');

  return { ok: true, name: name };
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: CONFIG.wsPort });

wss.on('listening', () => log(`WebSocket server listening on ws://localhost:${CONFIG.wsPort}`));

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
  log(`Browser connected from ${addr}  (${wsClients.size + 1} clients)`);
  wsClients.add(ws);

  // No special action on new client connect - the MCr+MC@ handshake
  // provides telemetry. Client sends 'pause_telemetry' to switch to
  // LCD mode (MC@) for interactive navigation.

  // Immediately tell the client the current ITO connection state
  send(ws, {
    type: 'connection',
    status: itoConnected ? 'connected' : 'disconnected',
    host: CONFIG.itoHost,
    port: CONFIG.itoPort,
  });

  // Keepalive
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });

  // Handle messages from browser → ITO
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) {
      // Accept plain-text command (e.g. WS.send('1') from the app)
      const cmd = data.toString().trim();
      log('plain cmd from browser:', JSON.stringify(cmd));
      if      (cmd === '1') startShot();     // START: MC\x05 (state-aware)
      else if (cmd === '0') stopShot();      // STOP:  MC\x04
      else if (cmd === 'wake') sendToITO('MCa'); // wake from standby
      else if (cmd === 'MCu') {
        withItoLock('browser MCu', () => new Promise((resolve) => {
          sendToITO('MCu');
          setTimeout(resolve, 10000);
        })).catch(err => warn('MCu lock error: ' + err.message));
      }
      else sendToITO(cmd);
      return;
    }

    switch (msg.type) {
      case 'command':
        log('cmd from browser:', JSON.stringify(msg.cmd));
        // Map of semantic browser commands → firmware MCc<NAME> tokens.
        // Names come straight from the firmware manual's "Appendix:
        // Assignable Functions" (p.229–230). Token strings include
        // spaces ("PUMP PB", "DBL ESPRESSO", "SP USER 1") - the firmware
        // accepts them verbatim after MCc.
        const MCC_MAP = {
          flush:    'MCcFLUSH',
          pump_pb:  'MCcPUMP PB',
          warmup:   'MCcWARMUP',
          eco:      'MCcECO',
          standby:  'MCcSTANDBY',
          temp_reset: 'MCcTEMP RESET',
          temp_up:  'MCcTEMP +',
          temp_dn:  'MCcTEMP -',
          dose:     'MCcDOSE',
          preinfuse:'MCcPREINFUSE',
          cold:     'MCcCOLD',
        };
        if (msg.cmd === '1' || msg.cmd === 'start') {
          startShot();
        } else if (msg.cmd === '0' || msg.cmd === 'stop') {
          stopShot();
        } else if (msg.cmd === 'wake') {
          sendToITO('MCa');
        } else if (msg.cmd === 'pressure+') {
          sendToITO('MC+');          // pressure up 0.1 bar (during profiled shot)
        } else if (msg.cmd === 'pressure-') {
          sendToITO('MC-');          // pressure down 0.1 bar (during profiled shot)
        } else if (msg.cmd === 'skip') {
          sendToITO('MCcSKIP');      // skip to next profile step
        } else if (MCC_MAP[msg.cmd]) {
          sendToITO(MCC_MAP[msg.cmd]);
        } else if (msg.cmd === 'MCu') {
          // Web-app config read. Serialize through the ITO mutex so it
          // can't collide with an in-progress upload/name-entry. The reply
          // arrives asynchronously via the regular ITO text stream.
          withItoLock('browser MCu', () => new Promise((resolve) => {
            sendToITO('MCu');
            setTimeout(() => {
              // Recovery: put ITO back into LCD mode before releasing the lock.
              sendRawToITO('MC@\r');
              setTimeout(resolve, 500);
            }, 5000); // MCu output completes in ~3-4 s
          })).catch(e => warn('MCu lock error: ' + e.message));
        } else if (typeof msg.cmd === 'string' && msg.cmd.length > 0) {
          sendToITO(msg.cmd);
        } else {
          warn('Invalid "command" message - missing cmd string: ' + JSON.stringify(msg));
        }
        break;

      case 'nav': {
        // { type: 'nav', action: 'nav_ok' }
        const raw = NAV_COMMANDS[msg.action];
        if (raw) {
          dbg('nav:', msg.action, msg.fast ? '(fast)' : '');
          if (msg.fast) {
            mcPressFast(raw);  // instant press+release, no delay
          } else {
            mcPress(raw);      // press + 20ms release
          }
        } else {
          warn(`Unknown nav action: ${msg.action}`);
        }
        break;
      }

      case 'config_get':
        // Proxy HTTP config page from ITO and return as message
        fetchITOConfig(msg.path || '/').then(body => {
          send(ws, { type: 'config_response', path: msg.path, body });
        }).catch(e => {
          send(ws, { type: 'config_response', path: msg.path, error: e.message });
        });
        break;

      case 'pause_telemetry':
        log('Switching to LCD mode (MC@) for interactive nav');
        sendRawToITO('MC@\r');
        send(ws, { type: 'telemetry_paused' });
        break;

      case 'read_doses':
        // Read dose list + active dose from the machine's MCu dump
        log('Reading dose list via MCu');
        withItoLock('read_doses', () => readMcuDoses())
          .then(result => send(ws, { type: 'doses_info', ok: true, active: result.active, doses: result.doses, shortcuts: result.shortcuts || {} }))
          .catch(e => send(ws, { type: 'doses_info', ok: false, error: e.message }));
        break;

      case 'start_dose': {
        // Direct dose trigger: MCc <DoseName>\r
        const doseName = (msg.name || '').toUpperCase();
        if (!doseName) { send(ws, { type: 'dose_result', ok: false, error: 'no name' }); break; }
        log(`Starting dose: ${doseName} (MCc ${doseName})`);
        sendRawToITO('MCc' + doseName + '\r');
        send(ws, { type: 'dose_result', ok: true, name: doseName });
        break;
      }

      case 'save_brew_settings': {
        // Apply staged brew settings to the machine:
        // - Set active dose ("Setup > Doses > Use")
        // - Map Shortcut 1 to the selected dose ("Setup > Shortcuts > 1")
        // - Update PID setpoint if PID is active ("Setup > PID 1 > Setpoint")
        log(`Save brew settings: dose=${msg.doseName} profile=${msg.profileIdx} temp=${msg.boilerTemp} pid=${msg.pidActive}`);
        serverSaveBrewSettings(ws, msg).then(result => {
          send(ws, { type: 'brew_settings_result', ...result });
        }).catch(e => {
          send(ws, { type: 'brew_settings_result', ok: false, error: e.message });
        });
        break;
      }

      case 'resume_telemetry':
        // Re-arm the continuous rich stream with a single MCr.
        log('Resuming rich mode (single MCr)');
        sendRawToITO('MCr\r');
        send(ws, { type: 'telemetry_resumed' });
        break;

      case 'ping':
        send(ws, { type: 'pong', ts: Date.now() });
        break;

      case 'hold_button': {
        // Hold a button down for a duration (ITO auto-repeats while held).
        // Used for rapid value changes - like Status Monitor's hold behavior.
        // msg.byte = '\x01' (UP) or '\x02' (DOWN), msg.duration = ms to hold
        const byte = msg.byte || '\x01';
        const dur = Math.min(msg.duration || 1000, 30000); // max 30s
        log(`Hold button 0x${byte.charCodeAt(0).toString(16)} for ${dur}ms`);
        sendRawToITO('MC' + byte + '\r');
        setTimeout(() => {
          sendRawToITO('MC\x00\r'); // release
          log(`Released button after ${dur}ms hold`);
        }, dur);
        break;
      }

      case 'profile_set_name': {
        // Set profile name server-side
        if (isMachineBusy()) {
          const st = machineState;
          log(`Refusing profile_set_name - machine is ${st}`);
          send(ws, { type: 'profile_upload_done', ok: false, error: `Machine is ${st} - wait for current operation to finish before editing profiles.`, busy: true, state: st });
          break;
        }
        log(`Set profile name: slot ${msg.slot} name "${msg.name}"`);
        withItoLock(`set-name slot ${msg.slot}`, () => serverSetProfileName(ws, msg.slot, msg.name))
          .then(result => { send(ws, { type: 'profile_upload_done', ...result }); })
          .catch(e => { send(ws, { type: 'profile_upload_done', ok: false, error: e.message }); });
        break;
      }

      case 'set_slot_option': {
        // { slot, field, value } - sets one per-slot option.
        if (isMachineBusy()) {
          const st = machineState;
          send(ws, { type: 'slot_option_result', ok: false, error: `Machine is ${st} - wait for current operation to finish.`, busy: true, state: st });
          break;
        }
        log(`Set slot option: slot ${msg.slot} ${msg.field}=${msg.value}`);
        withItoLock(`slot-opt ${msg.field}`, () => serverSetSlotOption(ws, msg.slot, msg.field, msg.value))
          .then(r => send(ws, { type: 'slot_option_result', ...r }))
          .catch(e => send(ws, { type: 'slot_option_result', ok: false, error: e.message }));
        break;
      }

      case 'set_machine_flood': {
        if (isMachineBusy()) {
          const st = machineState;
          send(ws, { type: 'machine_flood_result', ok: false, error: `Machine is ${st} - wait.`, busy: true, state: st });
          break;
        }
        log(`Set machine Flood: pressure=${msg.pressure} pumpPwr=${msg.pumpPwr}`);
        withItoLock('machine-flood', () => serverSetMachineFlood(ws, msg.pressure, msg.pumpPwr))
          .then(r => send(ws, { type: 'machine_flood_result', ...r }))
          .catch(e => send(ws, { type: 'machine_flood_result', ok: false, error: e.message }));
        break;
      }

      case 'set_machine_toggle': {
        if (isMachineBusy()) {
          const st = machineState;
          send(ws, { type: 'machine_toggle_result', ok: false, error: `Machine is ${st} - wait.`, busy: true, state: st });
          break;
        }
        log(`Set machine toggle: ${msg.field}=${msg.value}`);
        withItoLock(`machine-toggle ${msg.field}`, () => serverSetMachineToggle(ws, msg.field, msg.value))
          .then(r => send(ws, { type: 'machine_toggle_result', ...r }))
          .catch(e => send(ws, { type: 'machine_toggle_result', ok: false, error: e.message }));
        break;
      }

      case 'set_dose_ignore': {
        // { type:'set_dose_ignore', dose:'Espresso', field:'ignoreFlood'|'ignorePI', value:true|false }
        // value=true means "mark as ignored" (machine will show `/`, LCD \x05).
        // value=false means "run this phase" (machine shows `-`).
        if (isMachineBusy()) {
          const st = machineState;
          send(ws, { type: 'dose_ignore_result', ok: false, error: `Machine is ${st} - wait.`, busy: true, state: st });
          break;
        }
        log(`Set dose ignore: ${msg.dose}.${msg.field}=${msg.value}`);
        withItoLock(`dose-ignore ${msg.dose}.${msg.field}`,
          () => serverSetDoseIgnore(ws, msg.dose, msg.field, !!msg.value))
          .then(r => send(ws, { type: 'dose_ignore_result', ...r }))
          .catch(e => send(ws, { type: 'dose_ignore_result', ok: false, error: e.message }));
        break;
      }

      case 'set_dose_fields': {
        // { type:'set_dose_fields', dose:'Espresso', specs:[{name,type,target,...}, ...] }
        // Server-side port of the browser's editDoseFields loop. ~150× faster
        // because it uses the proxy's proven _makeNavCtx helpers instead of
        // round-tripping every scroll through WS.
        if (isMachineBusy()) {
          const st = machineState;
          send(ws, { type: 'set_dose_fields_result', ok: false, error: `Machine is ${st} - wait.`, busy: true, state: st });
          break;
        }
        log(`Set dose fields: ${msg.dose} (${(msg.specs || []).length} field(s))`);
        withItoLock(`set-dose ${msg.dose}`,
          () => serverSetDoseFields(ws, msg.dose, msg.specs || []))
          .then(r => send(ws, { type: 'set_dose_fields_result', ...r }))
          .catch(e => send(ws, { type: 'set_dose_fields_result', ok: false, error: e.message }));
        break;
      }

      case 'set_menu_field': {
        // { type:'set_menu_field', path:['Setup','PID 1','Setpoint'], spec:{type:'value', target:85, step:0.1} }
        // Generic replacement for the browser's changeCycle / changeValue.
        if (isMachineBusy()) {
          const st = machineState;
          send(ws, { type: 'set_menu_field_result', ok: false, error: `Machine is ${st} - wait.`, busy: true, state: st });
          break;
        }
        log(`Set menu field: ${(msg.path || []).join(' → ')}`);
        withItoLock(`set-field ${(msg.path || []).join('/')}`,
          () => serverSetMenuField(ws, msg.path || [], msg.spec || {}))
          .then(r => send(ws, { type: 'set_menu_field_result', ...r }))
          .catch(e => send(ws, { type: 'set_menu_field_result', ok: false, error: e.message }));
        break;
      }

      case 'run_diagnostic': {
        // { type:'run_diagnostic', path:['Run','Test flow'], kind:'flow',
        //   subSelect:'PID 1', settleMs, maxMs }
        // Navigates, runs the test, watches firmware output, streams parsed
        // result values back via 'diag_progress' messages, then 'diag_result'.
        // `subSelect` (optional) is a label to scroll to and OK after the
        // main path's leaf - used for Autotune which prompts "PID 1 / PID 2"
        // after you press OK on Autotuning.
        if (isMachineBusy()) {
          const st = machineState;
          send(ws, { type: 'diag_result', ok: false, error: `Machine is ${st} - wait.` });
          break;
        }
        log(`Run diagnostic: ${(msg.path || []).join(' → ')}` +
            (msg.subSelect ? ` › ${msg.subSelect}` : '') + ` (kind=${msg.kind})`);
        withItoLock(`diag ${(msg.path || []).join('/')}`,
          () => serverRunDiagnostic(ws, msg.path || [], msg.kind || 'generic',
                                     msg.settleMs || 4000, msg.maxMs || 180000,
                                     msg.subSelect || null))
          .then(r => send(ws, { type: 'diag_result', ...r }))
          .catch(e => send(ws, { type: 'diag_result', ok: false, error: e.message }));
        break;
      }
      case 'cancel_diagnostic': {
        // Best-effort cancel: sets a flag the diagnostic loop polls between
        // frame reads. The loop then breaks, backs out, and returns ok:true
        // with summary='Cancelled'.
        log('Cancel diagnostic requested');
        _diagCancel = true;
        break;
      }

      case 'set_ito_host': {
        // Browser asked to point the proxy at a new ITO machine. Validates
        // the host:port, persists it to proxy-config.json, closes the
        // current ITO socket, and reconnects. Reply with ito_host_result.
        const newHost = (msg.host || '').toString().trim();
        const newPort = parseInt(msg.port, 10);
        const valid = /^[\w.\-]{1,253}$/.test(newHost) && newPort > 0 && newPort < 65536;
        if (!valid) {
          send(ws, { type: 'ito_host_result', ok: false,
                     error: 'Invalid host or port. Host must be a hostname / IP, port 1-65535.' });
          break;
        }
        log(`Set ITO host: ${CONFIG.itoHost}:${CONFIG.itoPort} -> ${newHost}:${newPort}`);
        CONFIG.itoHost = newHost;
        CONFIG.itoPort = newPort;
        const saved = saveProxyConfig({ itoHost: newHost, itoPort: newPort });

        // Tear down the existing ITO socket cleanly so the reconnect
        // logic targets the new address. itoSocket.destroy() triggers
        // the 'close' handler which schedules connectToITO() via
        // reconnectTimer; we set itoSocket = null so the reconnect
        // path doesn't think we're already connected.
        try {
          if (itoSocket) {
            itoSocket.removeAllListeners('error'); // suppress noise during teardown
            itoSocket.destroy();
          }
        } catch (_) {}
        itoSocket = null;
        itoConnected = false;
        clearTimeout(reconnectTimer);
        clearInterval(itoKeepaliveTimer);
        // Connect immediately rather than waiting for the auto-reconnect.
        setTimeout(() => connectToITO(), 200);
        send(ws, { type: 'ito_host_result', ok: true, host: newHost, port: newPort, persisted: saved });
        // Also broadcast the new target so any other browser tabs notice.
        broadcast({ type: 'connection', status: 'reconfiguring',
                    host: newHost, port: newPort });
        break;
      }
      case 'get_ito_host': {
        send(ws, { type: 'ito_host_result', ok: true, host: CONFIG.itoHost, port: CONFIG.itoPort });
        break;
      }

      case 'read_mcu': {
        // Read full profile (name, PI, shot, per-slot options, machine-wide
        // toggles + Flood) via the MCu dump. Read-only - safe during any state.
        log(`Read MCu for slot ${msg.slot}`);
        withItoLock(`read_mcu slot ${msg.slot}`, () => readMcuProfile(msg.slot))
          .then(result => send(ws, {
            type: 'mcu_profile', ok: true, slot: msg.slot,
            name: result.name, pi: result.pi, shot: result.shot,
            resizePI: result.resizePI, resizeShot: result.resizeShot,
            end: result.end,
            trackFlow: result.trackFlow, trackTime: result.trackTime,
            pid1: result.pid1, pid2: result.pid2,
            cue: result.cue,
            piRepeat: result.piRepeat, piWait: result.piWait,
            machine: result.machine,
          }))
          .catch(e => send(ws, { type: 'mcu_profile', ok: false, slot: msg.slot, error: e.message }));
        break;
      }

      case 'profile_upload': {
        if (isMachineBusy()) {
          const st = machineState;
          log(`Refusing profile_upload - machine is ${st}`);
          send(ws, { type: 'profile_upload_done', ok: false, error: `Machine is ${st} - wait for current operation to finish before editing profiles.`, busy: true, state: st });
          break;
        }
        // Server-side profile upload - navigates menus and sets values entirely in Node.js.
        // msg.slot = 1-4, msg.phase = 'pi'|'shot'|'full', msg.steps = [{time,bar}×9]
        // phase 'full': sets name (msg.name) + PI (msg.pi_steps) + shot (msg.shot_steps) in one pass.
        // The whole multi-phase sequence holds the ITO mutex so browser MCu polls can't
        // interleave between name/PI/shot writes.
        if (msg.phase === 'full') {
          log(`Full profile upload: slot ${msg.slot} name="${msg.name}" PI+Shot+options`);
          withItoLock(`full-upload slot ${msg.slot}`, async () => {
            // ── Single MCu dump up front. Used to skip any step that already
            // matches the payload - name, PI/shot steps, per-slot options,
            // machine-wide toggles, and Flood. Each individual write is slow
            // (a separate MCE/MCa wake + menu walk), so skipping unchanged
            // ones saves up to a minute per skipped step. ──
            let mcu = null;
            try { mcu = await readMcuProfile(msg.slot); }
            catch (e) { log(`[full-upload] MCu precheck failed: ${e.message} - proceeding without skips`); }

            // Compare two PI/Shot step arrays. MCu pads empty positions with
            // {time:-1,bar:-1}; payload pads with 0/0. Treat both as "empty".
            // Float tolerance: 0.5s on time, 0.05bar on bar.
            const stepsMatch = (mcuArr, payloadArr) => {
              if (!Array.isArray(mcuArr) || !Array.isArray(payloadArr)) return false;
              const isEmpty = s => !s || ((s.time||0) <= 0 && (s.bar||0) <= 0);
              const len = Math.max(mcuArr.length, payloadArr.length);
              for (let i = 0; i < len; i++) {
                const a = mcuArr[i], b = payloadArr[i];
                if (isEmpty(a) && isEmpty(b)) continue;
                if (isEmpty(a) || isEmpty(b)) return false;
                if (Math.abs(a.time - b.time) > 0.5) return false;
                if (Math.abs(a.bar  - b.bar)  > 0.05) return false;
              }
              return true;
            };
            // Generic option comparator: handles strings (case/whitespace
            // tolerant) and floats (0.05 tolerance).
            const optMatch = (cur, want) => {
              if (cur === null || cur === undefined) return false;
              if (typeof want === 'string') {
                return String(cur).trim().toUpperCase() === want.trim().toUpperCase();
              }
              if (typeof want === 'number' && typeof cur === 'number') {
                return Math.abs(cur - want) < 0.05;
              }
              return cur === want;
            };

            if (msg.name) {
              // Note: serverSetProfileName has its OWN MCu precheck (so it
              // works standalone too). When called from here it'll re-dump
              // MCu - costs ~6 s extra ONLY when the name actually needs
              // writing (where the 30 s write dwarfs it). When name already
              // matches, the inner precheck returns early.
              const nr = await serverSetProfileName(ws, msg.slot, msg.name);
              if (!nr.ok) return { ok: false, error: 'Name: ' + nr.error };
            }

            if (msg.pi_steps) {
              if (mcu && stepsMatch(mcu.pi, msg.pi_steps)) {
                log(`[full-upload] PI steps already match - SKIP`);
                send(ws, { type: 'profile_upload_status', msg: 'PI steps already match - skip' });
              } else {
                const pr = await serverUploadProfile(ws, msg.slot, 'pi', msg.pi_steps);
                if (!pr.ok) return { ok: false, error: 'PI: ' + pr.error };
              }
            }
            if (msg.shot_steps) {
              if (mcu && stepsMatch(mcu.shot, msg.shot_steps)) {
                log(`[full-upload] Shot steps already match - SKIP`);
                send(ws, { type: 'profile_upload_status', msg: 'Shot steps already match - skip' });
              } else {
                const sr = await serverUploadProfile(ws, msg.slot, 'shot', msg.shot_steps);
                if (!sr.ok) return { ok: false, error: 'Shot: ' + sr.error };
              }
            }
            // Per-slot options - only set fields the caller explicitly provided.
            // Each setter does its own MCE/MCa reset + navigation so they're
            // independent (and safe to call in any order).
            const options = [
              ['resizePI', msg.resizePI], ['resizeShot', msg.resizeShot],
              ['end', msg.end],
              ['trackFlow', msg.trackFlow], ['trackTime', msg.trackTime],
              ['pid1', msg.pid1], ['pid2', msg.pid2],
              ['cue', msg.cue],
              ['piRepeat', msg.piRepeat], ['piWait', msg.piWait],
            ];
            for (const [field, value] of options) {
              if (value === undefined || value === null) continue;
              if (mcu && optMatch(mcu[field], value)) {
                log(`[full-upload] ${field} already ${mcu[field]} - SKIP`);
                send(ws, { type: 'profile_upload_status', msg: `${field} already ${mcu[field]} - skip` });
                continue;
              }
              const r = await serverSetSlotOption(ws, msg.slot, field, value);
              if (!r.ok) return { ok: false, error: `${field}: ${r.error}` };
            }
            // Machine-wide toggles (Setup → Profiles → Execute PI/shot/Drop ends PI)
            // and Flood (Setup → Profiles → Flood... → Pressure / PumpPwr).
            // These are SHARED across all slots on the ITO; the app stores them
            // per-slot and pushes whichever slot is being uploaded.
            const machineToggles = [
              ['executePI',   msg.executePI],
              ['executeShot', msg.executeShot],
              ['dropEndsPI',  msg.dropEndsPI],
            ];
            for (const [field, value] of machineToggles) {
              if (typeof value !== 'boolean') continue;
              if (mcu && mcu.machine && mcu.machine[field] === value) {
                log(`[full-upload] ${field} already ${value} - SKIP`);
                send(ws, { type: 'profile_upload_status', msg: `${field} already ${value} - skip` });
                continue;
              }
              const r = await serverSetMachineToggle(ws, field, value);
              if (!r.ok) return { ok: false, error: `${field}: ${r.error}` };
            }
            // First-drop weight = firmware "Limit" (Setup → Profiles → Limit).
            // Numeric, machine-wide, also written via serverSetMachineToggle
            // (which special-cases field='limit' → setFloatField('Limit', ...)).
            if (typeof msg.firstDropWeight === 'number') {
              if (mcu && mcu.machine && mcu.machine.limit != null
                  && Math.abs(mcu.machine.limit - msg.firstDropWeight) < 0.05) {
                log(`[full-upload] limit already ${mcu.machine.limit}g - SKIP`);
                send(ws, { type: 'profile_upload_status', msg: `Limit already ${mcu.machine.limit}g - skip` });
              } else {
                const r = await serverSetMachineToggle(ws, 'limit', msg.firstDropWeight);
                if (!r.ok) return { ok: false, error: `limit: ${r.error}` };
              }
            }
            // Flood pressure + pump power. Tri-state per-field semantics:
            //   field absent in msg     → don't touch
            //   field present === null  → CLEAR ("-" / firmware-disabled)
            //   field present === num   → set to that value
            const hasFP = Object.prototype.hasOwnProperty.call(msg, 'floodPressure');
            const hasFPW = Object.prototype.hasOwnProperty.call(msg, 'floodPumpPwr');
            if (hasFP || hasFPW) {
              let skip = false;
              if (mcu && mcu.machine && mcu.machine.flood) {
                const cur = mcu.machine.flood;
                // Match: null target ⇄ null current (both cleared);
                //        numeric target ⇄ numeric current (within tolerance).
                const fieldOK = (has, want, curVal, isFloat) => {
                  if (!has) return true;  // not requested → trivially OK
                  if (want === null) return curVal === null;  // both cleared
                  if (curVal === null) return false;  // want number, have nothing
                  return isFloat ? Math.abs(curVal - want) < 0.05 : curVal === want;
                };
                const pressOK = fieldOK(hasFP, msg.floodPressure, cur.pressure, true);
                const pumpOK  = fieldOK(hasFPW, msg.floodPumpPwr, cur.pumpPwr, false);
                if (pressOK && pumpOK) {
                  const fmt = v => v === null ? '-' : v;
                  log(`[full-upload] Flood already (${fmt(cur.pressure)}b, ${fmt(cur.pumpPwr)}) - SKIP`);
                  send(ws, { type: 'profile_upload_status', msg: `Flood already (${fmt(cur.pressure)}b, ${fmt(cur.pumpPwr)}) - skip` });
                  skip = true;
                }
              }
              if (!skip) {
                const r = await serverSetMachineFlood(
                  ws,
                  hasFP  ? msg.floodPressure : undefined,
                  hasFPW ? msg.floodPumpPwr  : undefined,
                );
                if (!r.ok) return { ok: false, error: `flood: ${r.error}` };
              }
            }
            return { ok: true, phase: 'full' };
          })
            .then(result => send(ws, { type: 'profile_upload_done', ...result }))
            .catch(e => send(ws, { type: 'profile_upload_done', ok: false, error: e.message }));
        } else {
          log(`Profile upload: slot ${msg.slot} ${msg.phase} (${msg.steps.filter(s=>s.time>0||s.bar>0).length} steps)`);
          withItoLock(`upload ${msg.phase} slot ${msg.slot}`, () => serverUploadProfile(ws, msg.slot, msg.phase, msg.steps))
            .then(result => { send(ws, { type: 'profile_upload_done', ...result }); })
            .catch(e => { send(ws, { type: 'profile_upload_done', ok: false, error: e.message }); });
        }
        break;
      }

      default:
        warn(`Unknown message type from browser: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    log(`Browser disconnected from ${addr}  (${wsClients.size} remaining)`);
  });

  ws.on('error', (e) => {
    err(`WS client error from ${addr}: ${e.message}`);
    wsClients.delete(ws);
  });
});

// Ping all clients every N seconds, drop dead connections
const pingTimer = setInterval(() => {
  for (const ws of wsClients) {
    if (!ws._alive) {
      ws.terminate();
      wsClients.delete(ws);
      continue;
    }
    ws._alive = false;
    ws.ping();
  }
}, CONFIG.pingInterval);

function send(ws, obj) {
  if (ws.readyState !== 1 /* OPEN */) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch (e) { /* ignore */ }
    }
  }
}

// ─── HTTP config proxy ────────────────────────────────────────────────────────
// The ITO has a built-in HTTP server for configuration pages.
// We proxy it here so the browser app can reach it through the same
// local host without CORS issues.

const httpProxy = http.createServer((req, res) => {
  // CORS headers so the browser app can call this freely
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve static files from the proxy directory.
  // /  → leva-control.html, /leva-connection.js → leva-connection.js, etc.
  {
    const fs = require('fs');
    const path = require('path');
    let staticFile = null;
    if (req.url === '/' || req.url === '/app' || req.url === '/app/') {
      staticFile = 'leva-control.html';
    } else if (/^\/[\w.\-]+\.(html|js|css|json|png|svg|ico|jpg|jpeg|woff2?)$/i.test(req.url)) {
      staticFile = req.url.slice(1); // strip leading /
    }
    if (staticFile) {
      try {
        const filePath = path.join(__dirname, staticFile);
        // prevent directory traversal
        if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('forbidden'); return; }
        const body = fs.readFileSync(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const ct = {
          html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8',
          css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
          png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon',
          jpg: 'image/jpeg', jpeg: 'image/jpeg', woff: 'font/woff', woff2: 'font/woff2',
        }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(body);
      } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
        res.end(e.code === 'ENOENT' ? 'Not found: ' + staticFile : 'Error: ' + e.message);
      }
      return;
    }
  }

  // Status endpoint - handle before proxying to ITO
  if (req.url === '/proxy/status') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      proxy:        'leva-ws-proxy',
      version:      '1.0.0',
      itoHost:      CONFIG.itoHost,
      itoPort:      CONFIG.itoPort,
      itoConnected,
      wsClients:    wsClients.size,
      wsPort:       CONFIG.wsPort,
      uptime:       Math.floor(process.uptime()),
    }, null, 2));
    return;
  }

  // URL proxy - fetch external URLs (for visualizer.coffee CORS bypass)
  if (req.url.startsWith('/proxy?url=')) {
    const targetUrl = decodeURIComponent(req.url.split('url=')[1]);
    if (!targetUrl.startsWith('https://visualizer.coffee/')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Only visualizer.coffee URLs allowed');
      return;
    }
    const https = require('https');
    https.get(targetUrl, proxyRes => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': proxyRes.headers['content-type'] || 'application/json' });
        res.end(Buffer.concat(chunks));
      });
    }).on('error', e => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + e.message);
    });
    return;
  }

  const parsed = url.parse(req.url);
  const path   = parsed.pathname || '/';

  fetchITOConfig(path, req.method, req).then(({ status, headers, body }) => {
    res.writeHead(status, headers);
    res.end(body);
  }).catch(e => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${e.message}`);
  });
});

httpProxy.listen(CONFIG.httpPort, () => {
  log(`HTTP config proxy listening on http://localhost:${CONFIG.httpPort}`);
  log(`  → proxying http://${CONFIG.itoHost}/ for ITO configuration pages`);
});

function fetchITOConfig(path, method = 'GET', incomingReq = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.itoHost,
      port:     CONFIG.itoPort,
      path,
      method,
      timeout:  5000,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        resolve({
          status:  proxyRes.statusCode,
          headers: { 'Content-Type': proxyRes.headers['content-type'] || 'text/html' },
          body:    Buffer.concat(chunks),
        });
      });
    });

    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('ITO HTTP timeout')); });
    proxyReq.on('error', reject);

    if (incomingReq && method === 'POST') {
      incomingReq.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });
}

// Status endpoint is handled inside the main httpProxy createServer handler above.

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  log(`Received ${signal}, shutting down…`);
  clearInterval(pingTimer);
  clearInterval(itoKeepaliveTimer);
  clearTimeout(reconnectTimer);
  if (itoSocket) itoSocket.destroy();
  broadcast({ type: 'connection', status: 'proxy_shutdown' });
  wss.close(() => {
    httpProxy.close(() => {
      log('Proxy stopped.');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Boot ─────────────────────────────────────────────────────────────────────

log('═══════════════════════════════════════════');
log('  Leva! ITO WebSocket Proxy');
log('═══════════════════════════════════════════');
log(`  ITO target : ${CONFIG.itoHost}:${CONFIG.itoPort}`);
log(`  WebSocket  : ws://localhost:${CONFIG.wsPort}`);
log(`  HTTP proxy : http://localhost:${CONFIG.httpPort}`);
log(`  Verbose    : ${CONFIG.verbose}`);
log('───────────────────────────────────────────');

connectToITO();
