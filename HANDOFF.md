# Handoff — Flutter rewrite of Leva Companion

This document is the kickoff brief for a fresh agent or developer who is going
to rebuild this app as a **standalone Flutter app for Android (then iOS)**. It
captures everything the existing browser+proxy version knows about the ITO
Leva! firmware so you don't have to reverse-engineer the protocol from
scratch.

> The shipped repo at https://github.com/vocian/Leva-Companion is the
> reference implementation. Read its `proxy.js` and `leva-control.html` —
> they're well-commented and contain every quirk we've discovered.

---

## 1. Mission

Build a single Flutter codebase that:

1. Runs on Android tablets (sideload first, Play Store later).
2. Runs on iPad (App Store later, requires a Mac for builds).
3. Talks **directly** to the ITO Leva! over its LAN TCP port (no Node proxy,
   no laptop in the loop).
4. Reproduces every feature of the current browser app at parity or better,
   re-rendered with native widgets (no WebView, no embedded HTML).
5. Ships as a single `.apk` (Android) and `.ipa` (iOS).

Non-goals:

- Cross-machine cloud sync, account system, or any server-side component.
- Supporting non-ITO espresso machines.

---

## 2. Tech stack (recommended)

| Concern | Pick | Notes |
|---|---|---|
| Framework | **Flutter** | Single Dart codebase, native rendering on both platforms |
| Charts | **`fl_chart`** or hand-rolled `CustomPainter` | The brew chart needs four overlaid traces + a dashed target curve + a floating chip; see §6 |
| TCP socket | `dart:io` `Socket` (Android), iOS-friendly via Flutter's built-in networking | Both platforms allow LAN TCP. Add `NSLocalNetworkUsageDescription` to iOS Info.plist. Android needs `INTERNET` + plaintext on the LAN. |
| State | `provider` or `riverpod` | Not too fancy — most state is per-screen with a global "machine connection" service |
| Local storage | `shared_preferences` for prefs, `path_provider` + JSON files for History | History is per-shot snapshots; SharedPrefs is too small for the trace arrays |
| Theme | `ThemeData` + custom tokens | The handoff design (`design_handoff_ito_leva/`) defines a dark "graphite" and a light "paper" theme; ship graphite first |
| Navigation | `BottomNavigationBar` or a top tab strip | The current HTML uses 5 tabs at the top: Brew / Profiles / History / Settings / Monitor |

Avoid:

- Capacitor / Cordova (the user explicitly said "no HTML").
- React Native (different ecosystem; Flutter's chart story is better and the
  team has zero JS code to reuse anyway).

---

## 3. MC Protocol cheat sheet

The ITO module exposes its menu/config protocol over telnet. **Default port
is 23** on current firmwares; older firmwares used 80. The Connection screen
already lets the user pick.

### Handshake

After TCP connect, the firmware emits `XML=leva!-<id>\r\n` plus a few status
lines. To start streaming telemetry, send:

```
\nMC?\r        (initial probe, optional)
MCr\r          (rich-mode telemetry — 10 Hz JSON-ish frames)
```

The proxy logs the handshake as:
1. Send `\nMC?\r`
2. Receive `XML=leva!-65FCB201`
3. Send `MCr\r`
4. Start receiving `{ ... }` rich frames + `<...>` LCD frames

### Commands (single shot)

| Command | What it does |
|---|---|
| `MCa\r` | Wake from standby |
| `MCe\r` / `MCE\r` | Energy saver |
| `MCu\r` | Dump full setup config (~3-4 s of streamed lines, see §4) |
| `MC@\r` | Switch to LCD-only mode (needed during menu navigation) |
| `MCr\r` | Switch back to rich mode (resumes telemetry) |
| `MC+\r` / `MC-\r` | Adjust setpoint up/down by 0.1 °C |
| `MCcSKIP\r` | Skip to next profile step during a shot |
| `MCcECO\r` | Activate energy saving mode |
| `MCcSTANDBY\r` | Standby |
| `MCcFLUSH\r` | Run flush program |
| `MCcWARMUP\r` | Run warm-up program |
| `MCcPUMP PB\r` | Toggle push-button pump (start / stop) |
| `MCcDOSE\r` | Fire active dose |
| `MCcPID 1` / `MCcPID 2` / `MCcNEXT PID` etc. | All the assignable functions in manual p.229-230 |

The complete `MCc<NAME>` list is in `proxy.js` → `MCC_MAP`.

### Virtual button bytes

Sent as `MC<byte>\r` (press) followed immediately by `MC\x00\r` (release).
The proxy currently uses 30 ms between the two.

| Byte | Function |
|---|---|
| `\x01` | UP |
| `\x02` | DOWN |
| `\x03` | OK / Stop shot |
| `\x04` | Cancel / Back |
| `\x05` | Shortcut [1] (Start shot) |
| `\x06` | Shortcut [2] |

### LCD frames

Format: `<NNN<row1><row2><row3><row4>>`

- `NNN` = a 3-digit prefix encoding LCD state. `<002` ≈ STANDBY home,
  `<102` ≈ IDLE home, `<131` ≈ menu-changed, `<101` ≈ menu-heartbeat.
- Each row is 16 chars; total LCD is 4×16=64 chars.
- The cursor appears as byte `\x04` (we render as `▶` in the LCD mirror).
- The fill char for progress bars is byte `\x05` (we render as `✓`).
- The first row of the home screen is the **active profile name** (e.g.
  `Declining       ` with right-padding spaces).

### Rich frames (`{ ... ~ NN }`)

Streamed at 10 Hz once `MCr` mode is active. Position-based parsing — see
`parseRichFrame()` in `proxy.js` for the offsets. Fields you'll need:

- `state` — `OFF` / `IDLE` / `WAIT` / `PULLING` / `BREWING` / `STEAMING` /
  `FLUSHING` / `HEATING` / `STANDBY` / `ECO` / `PROTECT`
- `pressure` (bar) — current group-head pressure
- `flow` (g/s) — from scale
- `flowMl` (ml/s) — from flow meter
- `volume` (ml)
- `weight` (g) — from scale
- `temp1` (°C) — group temp
- `setpoint` (°C)
- `pLow` / `pHigh` — pressure tolerance band
- `timer` (s) — shot elapsed
- `shotRunning` — pos-3 marker `*` flag

### Alarm tokens

When the firmware refuses a request, it overprints a token onto the LCD title
and emits a one-line `[TOKEN]` on the wire. Examples we've caught:

| Token | Meaning |
|---|---|
| `[OFF]` | The picked PID has Control = OFF |
| `[SCALE]` | Scale not connected (during flow calibration) |
| `[FLWMTR]` | Flow meter not installed |
| `[NO SNS]` / `[NO_SNS]` | No AC zero-cross at SNS clamp |
| `[GAUGE]` | Pressure-sensor error |
| `[BLE_OFF]` | Bluetooth radio off |
| `[VALVE]` | 3-way solenoid error |
| `[PROTECT]` | Pump or boiler protection trip |
| `[REFILL]` | Tank empty |
| `[FILTER]` | Filter exchange due |
| `[DSCALE]` | Descale required |
| `[BACKFL]` | Backflush required |
| `[SETUP]` | Setup incomplete |

The full token → human-readable map is in `proxy.js` → `ALARM_REASONS`.

### Mutex / serial access

The ITO menu state is a single shared resource. Two operations cannot
interleave (e.g. an MCu read while a profile upload is mid-navigation). The
proxy implements `withItoLock(name, fn)` — a promise-chain mutex with named
holders for debugging. Port this to a Dart equivalent (`Future` chain or a
`synchronized` package).

---

## 4. Data models

### Slot (firmware profile)

```dart
class ProfileSlot {
  int slot;             // 0-3
  String name;          // up to 9 chars on the firmware
  List<Step> pi;        // pre-infusion steps
  List<Step> shot;      // shot steps
  bool piEnabled;
  bool shotEnabled;
  bool floodEnabled;
  double? floodPressure;     // bar
  int?    floodPumpPwr;      // %
  double? trackFlow;         // ml/s threshold for "track flow" feature
  int?    trackTime;         // seconds
  String? end;               // 'STOP' | 'SUSTAIN' | 'FULL POWER'
  // per-PID overrides
  double? pid1, pid2;
  double? cue;
  int?    piRepeat;
  double? piWait;
  double? resizePI, resizeShot;
  // global toggles (machine-wide but per-slot tracked locally)
  bool? executePI, executeShot, dropEndsPI;
  double? piFirstDropWeight;
}

class Step {
  double time;          // seconds within the phase
  double bar;           // pressure target; bar==0 + time>0 = pause
  String? unit;         // 'flow' for ml/s steps (display-only, sent as bar=0)
}
```

### Dose preset

```dart
class DosePreset {
  String key;           // 'espresso', 'lungo', etc.
  String label;         // user-visible name
  String method;        // 'weight' | 'time' | 'volume'
  double quantity;
  int    profileIdx;    // 0-3, which profile slot fires for this dose
  bool   ignoreFlood;
  bool   ignorePI;
  double pumpPwr;
}
```

### History shot

```dart
class Shot {
  int id;               // ms epoch
  DateTime date;
  ProfileSlot profile;  // full snapshot
  double dose, yield, ratio, time, peakBar, finalTempC, targetTempC;
  List<TracePoint> trace;
  String notes;
}

class TracePoint {
  double t;             // s from shot start
  double? p;            // pressure (bar)
  double? f;            // flow (g/s)
  double? fm;           // flow (ml/s)
  double? T;            // temp (°C)
  double? w;            // weight (g)
  double? v;            // volume (ml)
}
```

History is persisted per-shot as a JSON file under
`getApplicationDocumentsDirectory()/history/<id>.json`.

### Setup config (MCu output)

`MCu` dumps the entire setup tree as indented lines:

```
PID 1...
| Control     PID
| Setpoint    93.0°
| Signal      ERR<1.0
...
PID 2...
| Control     OFF
...
Sensors...
| Temperature...
| | Type   NTC
| | Offset 0.0°
| Flow...
| | Installed /
| | Impulses/l 5600
...
```

Parser strategy in `proxy.js` is line-by-line with depth tracking based on
leading `|` count. Port that approach to Dart. The full schema (every field
the UI exposes) is in `leva-control.html` → `SETTINGS_SECTIONS` constant —
copy that as your config schema source of truth.

---

## 5. Feature inventory (per screen)

### Brew tab

- Three-column grid: setup column (dose/yield/ratio/temp/profile) | live
  chart with state header + timer | live readouts (Pressure / Flow / Temp /
  Weight) at 64 px JetBrains Mono numerals
- Live chart shows: target pressure curve (dashed gray-blue) + flow-tracking
  line (dashed teal with floating chip) + live pressure (red) + live flow
  ml/s (teal) + live temp (amber) + live weight (tan). Same render in
  History detail.
- Dose dropdown reflects firmware Shortcut[1] (the "active dose")
- Save / Discard buttons. Save turns amber when there are unsaved changes.
  Discard re-reads MCu and clears local edits.
- Pre-flight on Start Shot — if Brew or Profile has unsaved changes, a
  confirm modal pops ("Go back & save" / "Start anyway")
- Pre-flight: weight-method dose with no scale connected → refuse with
  inline error
- Watchdog: 3 s after sending Start, if state hasn't transitioned to
  PULLING/BREWING, show shot error

### Profiles tab

- 4 slot tabs (1 / 2 / 3 / 4)
- PI step table + Shot step table; each step has Time and Pump (or unit=flow)
- Flood enable + pressure + pump power
- Flow tracking enable + ml/s + duration
- Per-step PI overrides: PID 1, PID 2, Cue, piRepeat, piWait
- End mode dropdown (STOP / SUSTAIN / FULL POWER)
- Resize PI / Resize Shot
- Visualizer.coffee shot import (URL paste → fetch → convert curve to ITO
  steps)
- Upload to Machine button (turns amber when slot is dirty)
- Discard changes (re-reads slot from machine)
- Make Active button (pushes Flood + executePI/Shot + dropEndsPI to firmware)

### History tab

- Left rail: list of saved shots (profile name, date, dose→yield, time,
  peak bar)
- Right pane: header (profile name + date) + 5-readout grid (Dose / Yield /
  Ratio / Time / Peak) + replay chart (same renderer as Brew live chart) +
  Notes textarea (debounced auto-save)
- Save Shot button on the Brew tab snapshots into History
- Export JSON button writes a Visualizer-compatible shape (espresso_pressure,
  espresso_flow, espresso_flow_weight, espresso_weight,
  espresso_temperature_basket, espresso_water_dispensed, espresso_elapsed) +
  an `ito.profile` extras object with the full slot snapshot
- Delete button (inline confirm)
- 50-shot quota with auto-trim if storage runs out

### Settings tab

Apple-style two-column layout: search bar at top, left rail of section
cards, right pane with the selected section's fields. Sections, with their
glyphs, in the order they should appear in the rail:

- **Setup** category
  - PID 1 (icon: pid)
  - PID 2 (icon: steam)
  - Pump (icon: pump)
  - Scale (icon: scale)
  - Autotuning (icon: cycle) — settings; the Run button is on the Run tab
  - Temperature sensor (icon: thermometer)
  - Flow sensor (icon: drop)
  - Pressure sensor (icon: gauge)
  - Contacts (icon: wire) — AUX/ADC/ENC dropdowns from the assignable
    functions list (manual p.229-230)
  - Protection (icon: shield)
  - Display (icon: screen)
  - LED (icon: sun)
  - Buzzer (icon: beep)
  - Wifi (icon: wave)
  - Flush settings (icon: drop)
  - Warm-Up settings (icon: sun)
  - Descale settings (icon: bottle)
  - Backflush settings (icon: backflush — portafilter + bubbles)
  - Water (icon: tap)
  - Eco (icon: leaf)
  - Shot timer (icon: clock)
- **Shortcuts** category
  - Shortcuts (icon: star) — 9-slot table assigning MCc functions to
    physical buttons
  - Input (icon: knob) — encoder type, click size
  - Cups (icon: cup) — 8 cup definitions, each with min/max weight + dose
- **Connection** category
  - Proxy / WS connection (icon: plug) — but wait, **this section becomes
    irrelevant in the standalone app** because there's no proxy. Replace
    with a "Network" card showing the LAN address and connection state.
  - ITO Leva machine (icon: machine) — IP + port; persist locally
  - Restart BLE (icon: bluetooth) — `MCc Restart BLE`
  - Restart Wifi (icon: wave) — `MCc Restart Wifi`
  - Factory reset (icon: reset) — type-to-confirm "reset"

Search field filters across section title, every field label, every
tooltip, every option string, and every subsection title.

### Run tab (action grid)

Four sub-groups, each in its own labelled section with a 4-column button
grid. Every button: 24×24 icon + label + small hint underneath, fixed 104px
min-height so all four groups line up.

- **Daily commands**: Flush (drop / "Group rinse"), Pump PB (pushBtn /
  "Push-button pump"), Warm-Up (sun / "Heat group to setpoint")
- **Cleaning**: Backflush (backflush / "Detergent cycle"), Descale (bottle /
  "Mineral-removal cycle")
- **Tests**: Test valve (solenoid / "Cycle solenoid"), Test pressure (gauge
  / "Verify sensor vs. gauge"), Test flow (tune / "Pump phase profile")
- **Calibration**: Calibrate flow meter (drop / "Auto-tune impulses / L"),
  Autotune PID 1 (pid / "Tune brew loop"), Autotune PID 2 (steamWand /
  "Tune steam loop")

Each button opens a prep modal (manual checklist + warning banner + Start
button) before firing the firmware program. Live progress streams into a
gauge table during the run; completion clears transient rows and shows just
the result fields. Alarm tokens (`[SCALE]`, `[OFF]`, etc.) abort with a
Result: FAIL + Reason: explanation.

---

## 6. Brew chart spec

The chart is the single most complex visual in the app. Spec:

### Layout

- Pad: top 16, right 56 (flow axis labels), bottom 32, left 44 (pressure)
- X axis: 0 → max(targetEnd, liveEnd, 30) seconds
- Pressure axis (left): 0 → 12 bar
- Flow axis (right): 0 → 8 ml/s
- Temp axis (overlaid): 20-100 °C, no separate ticks
- Weight axis (overlaid): 0 → max(40, yield × 1.3)
- 5-line horizontal grid; vertical ticks every {10, 5, 2, 1}s based on tMax

### Layers, drawn in order

1. Panel background (`var(--ito-panel)` = `#14171B` graphite, `#FBF9F5` paper)
2. Grid (`var(--ito-line2)` ≈ 10% white)
3. Axis labels: pressure ticks (red, left), flow ticks (teal, right), x
   ticks in `--ito-ink3`. JetBrains Mono 10 px
4. **Target pressure curve** — Flood + PI + Shot via `buildProfileCurve()`:
   - Dashed `[4, 4]`
   - `var(--ch-profile)` = `#7E8B9E` slate
   - Width 2, alpha 0.7
5. **Flow-tracking line** — if `slot.trackFlow > 0`:
   - Dashed `[4, 4]`, teal, alpha 0.85, width 1.5
   - Span PI-end to shot-end on the X axis, fixed Y at trackFlow value
   - Optional cutoff tick at PI-end + trackTime
   - Floating chip in the middle: `<value> ml/s · hold <time>s` on a panel
     background with a 0.55-alpha teal stroke
6. **Live pressure** — solid red, width 2, alpha 0.95
7. **Live flow** (ml/s) — solid teal, width 1.5, alpha 0.85
8. **Live temperature** — solid amber, width 1.3, alpha 0.85
9. **Live weight** — solid tan (`#A6987D`), width 1.5, alpha 0.75
10. Optional pressure tolerance band (`pLow`/`pHigh` from rich frame) —
    semitransparent red fill between, low priority

### Pseudocode (Dart sketch)

```dart
class BrewChartPainter extends CustomPainter {
  final ProfileSlot slot;
  final List<TracePoint> live;
  final BrewChartTheme theme;
  final double yieldTarget;
  // ...
  void paint(Canvas c, Size sz) {
    final pad = EdgeInsets.fromLTRB(44, 16, 56, 32);
    // 1. background, 2. grid, 3. axis ticks
    // 4. target curve via buildProfileCurve(slot.pi, floodDur)
    //    + buildProfileCurve(slot.shot, piEnd, piEndBar)
    // 5. flow tracking line + chip
    // 6-9. four live traces (drop nulls, smooth via 5-point rolling mean)
  }
}
```

`buildProfileCurve` is a pure function — port it verbatim from
`leva-control.html`. It takes a list of steps + offset + preceding bar, and
returns a list of `(t, bar)` points handling pause steps, flow steps,
seeding from the preceding pressure, etc.

---

## 7. UX rules (carry these forward)

These are user-stated preferences from the HTML version. Honour them.

### Notifications

- **No browser-style popups.** No `alert()`-equivalent dialog. Implement:
  - **Toast** for transient info/success/error — slides down from top-centre
    (NOT bottom-right; covers the Start button). Auto-dismiss ~3.5 s.
    Variants: info, ok, warn, error.
  - **Confirm modal** for destructive actions (delete shot, factory reset,
    make profile active). Type-to-confirm for Factory reset.
  - **Info modal** for errors that need acknowledgement (e.g. "Sync failed").
  - All popups render inside the app frame, not as native OS dialogs.

### Save / dirty state

- Save buttons (Brew, Profile Upload) turn **amber** when there are unsaved
  edits.
- Discard buttons sit next to Save — re-read from the machine and clear
  local pending markers.
- Start Shot pre-flight modal fires if either Brew or Profile is dirty,
  with two buttons: "Go back & save" (default) and "Start anyway".

### State pill

- Top-bar Machine state pill flickers between MENU / PULL / WAIT / IDLE
  during long menu operations (uploads, autotunes, calibrations). Pin it to
  a stable label ("Uploading", "Diagnostic") for the duration of the
  operation.

### Typography

- No em-dashes (`—`, U+2014) anywhere in UI text or labels. Use ASCII
  hyphens. The HTML version went through a sweep stripping all 644.

### Icons

- Each Run-tab card has a distinctive icon (pushBtn for Pump PB, solenoid
  for Test valve, gauge for Test pressure, steamWand for Autotune PID 2,
  bluetooth for Restart BLE, etc.). The full glyph set is in
  `WIZARD_ICONS` and `RAW_RAIL_GLYPHS` of `leva-control.html`.

### Wizards / preset chips

- For toggle fields, **don't** render redundant preset chips that just say
  "On / Off". The toggle UI is self-explanatory. (Numbers/selects keep
  their preset chips because the values aren't obvious.)

### Diag runner

- Generic `[ALARM]` token detection during any Run-tab program. When
  caught, abort cleanly + return structured FAIL with Reason field.
- Auto-handle yes/no prompts (Test pressure, Backflush, Descale).
- Auto-handle sub-pick prompts (Autotune → PID 1 / PID 2 picker).
- Pre-flight Autotune: refresh MCu, refuse if pidN.control != PID/2-P
  before navigating.

---

## 8. Design tokens

From `design_handoff_ito_leva/companion-app/tokens.js`:

### Graphite (default, dark)

```dart
const _graphite = {
  'bg':       Color(0xFF0B0D10),
  'panel':    Color(0xFF14171B),
  'panel2':   Color(0xFF1B1F24),
  'panel3':   Color(0xFF23272D),
  'line':     Color(0x0FFFFFFF),    // 6%
  'line2':    Color(0x1AFFFFFF),    // 10%
  'ink':      Color(0xFFECEAE6),
  'ink2':     Color(0xFFA4A098),
  'ink3':     Color(0xFF6A6760),
  'ink4':     Color(0xFF3E3C37),
  'accent':   Color(0xFFD2604A),    // brand red / pressure / shot
  'ok':       Color(0xFF7FB27A),
  'warn':     Color(0xFFD9A14A),    // amber / dirty-state / temp
  'danger':   Color(0xFFD2604A),
  // channel colors
  'pressure': Color(0xFFD2604A),
  'flow':     Color(0xFF4FA89A),
  'temp':     Color(0xFFD9A14A),
  'weight':   Color(0xFFA6987D),
  'profile':  Color(0xFF7E8B9E),     // dashed target curve
};
```

### Typography

- UI sans: **Inter** (400/500/600/700)
- Numerals: **JetBrains Mono** (500), tabular-nums, `-0.02em` letter spacing
- Live readouts: 64 px, weight 500, mono
- Shot timer: 44 px, weight 500, mono
- Section labels: 10.5 px, `0.14em` tracking, uppercase, weight 600

### Density tiers (from tokens.js)

| Density | rowH | pad | gap | fs | fsNum | fsBig |
|---|---|---|---|---|---|---|
| compact | 36 | 10 | 10 | 12 | 20 | 36 |
| balanced (default) | 44 | 14 | 14 | 13 | 22 | 44 |
| relaxed | 52 | 18 | 18 | 14 | 24 | 52 |

---

## 9. Build & distribution

### Android APK (start here)

```bash
flutter create leva_companion
cd leva_companion
flutter pub add fl_chart provider shared_preferences path_provider
flutter pub add synchronized   # for the ITO mutex
# ... add the TCP socket logic via dart:io
flutter run                    # debug on attached tablet via USB
flutter build apk --release    # signed APK in build/app/outputs/flutter-apk/
```

For signed release builds, generate a keystore once, configure
`android/key.properties` and `android/app/build.gradle` (Flutter docs walk
through this). The first signed APK is the "MVP" deliverable.

For Play Store later: same APK + `flutter build appbundle --release` for an
AAB. $25 one-time Google developer fee.

### iOS (later, requires a Mac)

```bash
flutter build ios --release
```

Apple needs:
- Mac with Xcode installed
- Apple Developer account ($99/yr for distribution; free dev account
  sideloads to your own iPad with 7-day re-sign)
- Code signing setup in Xcode

This is the second milestone, not the first.

---

## 10. Suggested phasing

Don't try to ship every feature at once. Recommended order:

### Phase 1 — first APK on the tablet (1-2 weeks)

1. Flutter scaffold, theme tokens, navigation
2. **Connection screen** — IP/port input, Connect button, status
3. **TCP socket layer** + MC handshake + rich-frame parser + LCD parser
4. **Brew tab readouts** — Pressure / Flow / Temp / Weight live numbers,
   shot timer
5. **Start / Stop** button + watchdog
6. **First signed APK build, sideload on the tablet, end-to-end smoke test**

### Phase 2 — chart + profiles (1 week)

1. **Brew chart** — target curve + 4 live traces + flow-tracking line
2. **Profile editor** — slot tabs, PI/Shot tables, basic upload
3. MCu reader + parser

### Phase 3 — settings + history (1 week)

1. **Settings** — search bar, two-column rail, all the wizards
2. **History tab** — save/replay/export

### Phase 4 — diagnostics (1 week)

1. Run tab quick row
2. Diag runner with prep checklist + alarm detection

### Phase 5 — iOS port + polish (1 week, needs Mac)

1. Run on Xcode simulator, iPad, fix any platform-specific issues
2. App icon, splash screen, Info.plist permissions
3. Submit to TestFlight

---

## 11. Reference reading list

When the new agent needs to understand a specific feature, point at these
files in `https://github.com/vocian/Leva-Companion`:

| File | Lines of interest | What's there |
|---|---|---|
| `proxy.js` | 154-260 | TCP connect + MC handshake |
| `proxy.js` | 354-570 | LCD frame parsing + state classification |
| `proxy.js` | 571-800 | Rich-frame parser (telemetry) |
| `proxy.js` | 800-1100 | MCu dump parser + section schema |
| `proxy.js` | 1180-1700 | Nav engine (button presses, scrollTo, enter, value entry) |
| `proxy.js` | 2076-2510 | Diag runner (Test pressure, Autotune, Calibrate, alarm tokens) |
| `proxy.js` | 2580-3250 | Profile upload (Clear, write steps, options, verify) |
| `proxy.js` | 3500-3900 | WebSocket message switch — every supported request type |
| `leva-control.html` | search `SETTINGS_SECTIONS` | Full settings schema (every field, type, default, unit) |
| `leva-control.html` | search `SETUP_WIZARDS` | Wizard step definitions |
| `leva-control.html` | search `WIZARD_ICONS` | All SVG glyphs (port to AssetImage or vector_graphics) |
| `leva-control.html` | search `drawBrewCanvas` | Brew chart layer-by-layer render |
| `leva-control.html` | search `drawHistoryCanvas` | Same chart, applied to a saved trace |
| `leva-control.html` | search `buildProfileCurve` | Pure function — port to Dart verbatim |
| `leva-control.html` | search `MCC_MAP` | Semantic-name → MCc<NAME> translation |
| `leva-control.html` | search `ALARM_REASONS` | Token → reason map for alarm fail-fast |
| `leva-control.html` | search `saveCurrentShot` / `exportShotJSON` | History snapshot + Visualizer-shape export |
| `design_handoff_ito_leva/companion-app/tokens.js` | full | Theme / density tokens |
| `design_handoff_ito_leva/companion-app/screen-*.jsx` | full | Layout intent for each screen |

---

## 12. Open questions to confirm with user

Things the new agent should confirm before deep work:

1. **Bottom-nav vs. top-tabs** for Android. iPad's larger surface tolerates
   top tabs (matches the design), Android phones might prefer a bottom nav.
   Tablets in landscape work either way. Match the existing top-tab
   strip for Android tablet first.
2. **Single-window vs. master/detail** on iPad. Settings and History
   benefit from a master/detail split-view on a 12.9" iPad; on a 10"
   Android tablet, full-screen tabs probably read better.
3. **Persistent ITO machine address** — store in shared_preferences. Same
   mechanism the proxy uses with `proxy-config.json`.
4. **History sync** — confirm scope is per-device only (no cloud).

---

## 13. Things that go away in the standalone app

- **Proxy** — gone. The Dart app talks TCP directly.
- **WebSocket layer** — gone. Internal app events / streams instead.
- **HTTP config-page proxy on :8766** — only relevant if the app needs to
  surface the firmware's web pages. Skip for v1.
- **proxy-config.json** — replaced by SharedPreferences keys.
- **leva-connection.js** — concept stays (a connection service) but
  reimplemented in Dart.
- **The "Connection / Proxy" card in Settings** — drop. Only "Machine"
  card stays.

---

## 14. License & contribution

- **All rights reserved.** Repo is NOT open-source. No public license is
  granted; the source is visible (or private) but not redistributable.
  Don't add a LICENSE file to the Flutter fork unless explicitly told to.
- The user (`vocian`) is the sole contributor and copyright holder. Don't
  add co-authors to commits.
- Don't include any "Generated by Claude" or co-author footers in commit
  messages.

---

That's everything. Read `proxy.js` and `leva-control.html` for the gnarly
detail; this doc is the index. Good luck.
