/**
 * leva-connection.js
 * ─────────────────────────────────────────────────────────────────
 * Drop-in connection module for the Leva browser app.
 * Replaces the simulated data with a real WebSocket connection
 * to the leva-ws-proxy running on the same machine.
 *
 * Usage — add this script tag to the app HTML BEFORE the main app:
 *   <script src="leva-connection.js"></script>
 *
 * The module patches the global `LevaConnection` object, which the
 * app uses for all ITO communication.
 *
 * API:
 *   LevaConnection.connect(host, wsPort)   → open WebSocket
 *   LevaConnection.disconnect()            → close WebSocket
 *   LevaConnection.send(cmd)               → send text command to ITO
 *   LevaConnection.onTelemetry(fn)         → called with parsed telemetry
 *   LevaConnection.onLCD(fn)               → called with LCD lines array
 *   LevaConnection.onStatus(fn)            → called with connection status string
 *   LevaConnection.onRaw(fn)               → called with every raw ITO line
 *   LevaConnection.status                  → 'connected' | 'disconnected' | 'connecting'
 */

(function (global) {
  'use strict';

  const DEFAULT_PROXY_HOST = 'localhost';
  const DEFAULT_WS_PORT    = 8765;
  const RECONNECT_DELAY    = 4000;

  let ws              = null;
  let reconnectTimer  = null;
  let _wsUrl          = '';

  const handlers = {
    telemetry:   [],
    lcd:         [],
    status:      [],
    raw:         [],
    firmware:    [],
    display_raw: [],
  };

  function on(event, fn) {
    if (handlers[event]) handlers[event].push(fn);
    return LevaConnection; // chainable
  }

  function emit(event, data) {
    (handlers[event] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[LevaConnection] handler error:', e); } });
  }

  function connect(host = DEFAULT_PROXY_HOST, port = DEFAULT_WS_PORT) {
    _wsUrl = `ws://${host}:${port}`;
    _openWS();
  }

  function _openWS() {
    if (ws && ws.readyState < 2) return; // already open/connecting
    clearTimeout(reconnectTimer);

    console.log('[LevaConnection] Connecting to', _wsUrl);
    LevaConnection.status = 'connecting';
    emit('status', 'connecting');

    ws = new WebSocket(_wsUrl);

    ws.onopen = () => {
      console.log('[LevaConnection] WebSocket open');
      // status update will come from proxy's first message
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); }
      catch (e) { emit('raw', evt.data); return; }

      switch (msg.type) {
        case 'telemetry':
          emit('telemetry', msg);
          break;

        case 'lcd':
          emit('lcd', msg.lines);
          break;

        case 'raw':
          emit('raw', msg.line);
          break;

        case 'firmware':
          emit('firmware', msg.message);
          break;

        case 'display_raw':
          emit('display_raw', msg.data);
          break;

        case 'connection':
          LevaConnection.status = msg.status;
          emit('status', msg.status);
          console.log('[LevaConnection] ITO status:', msg.status);
          break;

        case 'pong':
          // keepalive acknowledged
          break;

        case 'config_response':
          // route to any pending config fetch promise
          _resolveConfigFetch(msg);
          break;
      }
    };

    ws.onerror = (e) => {
      console.warn('[LevaConnection] WebSocket error', e);
    };

    ws.onclose = (evt) => {
      console.log(`[LevaConnection] WebSocket closed (code ${evt.code}). Reconnecting in ${RECONNECT_DELAY}ms…`);
      LevaConnection.status = 'disconnected';
      emit('status', 'disconnected');
      ws = null;
      reconnectTimer = setTimeout(_openWS, RECONNECT_DELAY);
    };
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    LevaConnection.status = 'disconnected';
    emit('status', 'disconnected');
  }

  /**
   * Send a command to the ITO module via the proxy.
   * @param {string} cmd  e.g. 'dose', 'pump_pb', 'flush'
   */
  function send(cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[LevaConnection] Cannot send — not connected:', cmd);
      return false;
    }
    ws.send(JSON.stringify({ type: 'command', cmd }));
    return true;
  }

  // ── Config proxy ────────────────────────────────────────────────────────────
  // Fetch the ITO's HTTP config pages via the proxy's HTTP port.
  // These are the same pages the old Status Monitor's "Virtual Display" showed.

  const CONFIG_PROXY_PORT = 8766;
  let _configFetches = {};

  function fetchConfig(path = '/') {
    return new Promise((resolve, reject) => {
      const id = Date.now() + '_' + Math.random().toString(36).slice(2);
      _configFetches[id] = { resolve, reject, path };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'config_get', path, _id: id }));
      } else {
        // Fall back to direct HTTP call via config proxy
        fetch(`http://localhost:${CONFIG_PROXY_PORT}${path}`)
          .then(r => r.text())
          .then(body => resolve({ path, body }))
          .catch(reject);
        delete _configFetches[id];
      }
    });
  }

  function _resolveConfigFetch(msg) {
    const entry = Object.entries(_configFetches).find(([, v]) => v.path === msg.path);
    if (!entry) return;
    const [id, { resolve, reject }] = entry;
    delete _configFetches[id];
    if (msg.error) reject(new Error(msg.error));
    else resolve(msg);
  }

  // ── Helpers for the app ──────────────────────────────────────────────────────

  /**
   * Convenience: parse raw ITO telemetry line into a structured object.
   * Useful if you're handling 'raw' events and want to parse them yourself.
   */
  function parseRawLine(line) {
    if (!line || !line.includes(':')) return null;
    const result = {};
    for (const token of line.split(',')) {
      const c = token.indexOf(':');
      if (c < 0) continue;
      const key = token.slice(0, c).trim().toUpperCase();
      const val = token.slice(c + 1).trim();
      const num = parseFloat(val);
      const map = { T1:'temp1', T2:'temp2', TV:'tempVirt', P:'pressure',
                    F:'flow', W:'weight', S:'state', V:'volume',
                    D:'dose', H:'heat', SP:'setpoint', SP2:'setpoint2' };
      if (map[key]) result[map[key]] = isNaN(num) ? val : num;
    }
    return Object.keys(result).length ? result : null;
  }

  // ── Expose ───────────────────────────────────────────────────────────────────

  global.LevaConnection = {
    status: 'disconnected',
    connect,
    disconnect,
    send,
    fetchConfig,
    parseRawLine,
    // Event registration
    onTelemetry: (fn) => on('telemetry', fn),
    onLCD:       (fn) => on('lcd', fn),
    onStatus:    (fn) => on('status', fn),
    onRaw:       (fn) => on('raw', fn),
    onFirmware:    (fn) => on('firmware', fn),
    onDisplayRaw:  (fn) => on('display_raw', fn),
    // Internal (for testing)
    _handlers: handlers,
  };

})(typeof window !== 'undefined' ? window : global);
