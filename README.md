# Leva Companion

Browser companion app for the [ITO Leva!](https://www.ipibarista.com/) espresso machine module. A small Node.js proxy bridges the machine's TCP MC protocol to a single-page web app that gives you live brew telemetry, profile editing, dose / shortcut management, and on-machine diagnostics — without touching the encoder.

## Features

- **Brew tab** — live pressure / flow / temp / weight readouts at iPad-distance, real-time chart, profile-aware target curve, shot timer, START / STOP.
- **Profiles tab** — edit the four firmware profile slots (Pre-infusion + Shot steps, flow tracking, PID per step, cue, end mode), upload to the machine in seconds. Visualizer.coffee shot import for converting Decent profiles.
- **History tab** — save shots locally; replay the trace alongside the saved profile target curve; export to JSON in Visualizer-friendly shape.
- **Settings tab** — Apple-style two-column layout. Setup wizards for PID 1 / PID 2 / Pump / Sensors (temp / flow / pressure as separate cards) / Scale / Contacts / Protection / Display / LED / Buzzer / Wifi / Autotune / Flush / Warm-Up / Descale / Backflush / Water / Eco / Shot timer. Search field filters across every field label, unit, tooltip, and option.
- **Run tab** — daily commands (Flush / Pump PB / Warm-Up), cleaning (Backflush / Descale), tests (valve / pressure / flow), calibration (flow meter / Autotune PID 1 / PID 2). Each card shows a manual-prep checklist before firing the firmware program; results stream live and the modal shows pass/fail with reason codes (e.g. `[SCALE] Scale not connected`).
- **Connection** — change the ITO machine IP from inside the app; the proxy persists it to `proxy-config.json` and reconnects without restarting.
- **No popups** — every prompt / confirm / error is rendered inline inside the app frame.

## Requirements

- Node.js ≥ 16
- An ITO Leva! module on your LAN (or in AP mode)
- A modern browser (Chrome / Edge / Safari)

## Quick start

```bash
git clone <this repo>
cd leva-companion-app
npm install

# Default: connects to 192.168.1.37:23
npm start

# Or point at a specific machine
node proxy.js --ito-host 192.168.4.1 --ito-port 23
```

The proxy listens on:
- `ws://localhost:8765` — WebSocket the browser connects to
- `http://localhost:8766` — HTTP pass-through to the machine's config pages

Open `leva-control.html` in your browser. By default it tries `ws://localhost:8765`. Change the proxy host / WS port (or the machine IP / port) under **Settings → Connection** at any time — the proxy applies and persists changes via WebSocket without a restart.

## Hardware notes

- **MC protocol port** is `23` on most current firmwares; older builds used `80`. The Setup → Connection panel exposes presets for both.
- **Bluetooth scale** required for weight-method dosing and flow-meter calibration. Pair it from the on-machine `Setup → Scale → Scan` menu.
- **Flow meter** required for volumetric dosing, flow tracking, and Run → Calibration → Flow meter. Configure under `Setup → Sensors → Flow`.

## Architecture

```
   browser                    proxy.js                  ITO Leva!
   ┌─────────────┐  WS:8765  ┌──────────┐   TCP:23     ┌────────┐
   │ leva-       │◄─────────►│  ws +    │◄────────────►│  MC    │
   │  control    │           │  net     │   (telnet)   │  proto │
   │  .html      │           │          │              │        │
   └─────────────┘           └──────────┘              └────────┘
        ▲
        │
   Chart.js (CDN) + JetBrains Mono (Google Fonts)
```

The proxy is intentionally dumb: it forwards MC commands, parses the machine's rich-mode telemetry frames into JSON, and serializes shared resources (menu navigation, MCu reads) behind a single mutex. All UI logic — the chart, profile editor, history, settings, wizards, diagnostics — lives in `leva-control.html`.

## License

All rights reserved. This software is not licensed for redistribution
or modification. Contact the author for inquiries.
