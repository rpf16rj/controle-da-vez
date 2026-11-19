# Controle da Vez

*Read this in [Português](README.pt-BR.md)*

A private "friends room" for **PS5 Remote Play**: one host PC runs the console session, friends open a web page, watch the gameplay live, queue up, and take turns actually playing — sending their controller input back through the browser.

Inspired by community sites where people watch a shared console and take turns playing it. The motivation was simple: *my PS5 is already connected through Chiaki on my PC — why not let approved friends watch and play it from anywhere?*

## What it does

- **Live-first web app** — opens straight into the stream, app-like, no scrolling, mobile-friendly (portrait and landscape).
- **Nickname-only accounts** — no passwords for friends. The browser is fingerprinted (SHA-256 over device characteristics) so each device is a persistent identity that just asks for a nickname once.
- **Admin approval** — new devices start as *pending*. The owner approves each one before it can chat or play. Admin gets a bell icon in the top bar listing pending requests with one-click approval; the approved user is notified instantly via SSE.
- **Turns & queue** — one player at a time controls the console. Others can request the turn or wait; the active player can hand over, and viewers just watch.
- **Chat** — gated behind approval, persisted across restarts, with unread badge, side drawer on desktop/landscape and bottom sheet on mobile.
- **Dual input paths** — on-screen DualSense-style touch controls (configurable layout, opacity, presets, auto-hides when a physical gamepad connects) or a real gamepad via the browser Gamepad API.
- **Honest live state** — when the console/agent is offline the page shows "PS5 sleeping" with an explicit *Wake the PS5* button and an optional *watch last stream* recording — never mislabeled as live.
- **Wake-on-LAN** — the web app can wake the PS5 and launch `chiaki stream` remotely through the agent.

## Architecture

```
                 ┌─────────────┐        Remote Play         ┌────────────────┐
                 │    PS5      │◄──────────────────────────►│  chiaki-ng      │
                 └─────────────┘                            │ (Windows host)  │
                        ▲                                   └───────┬────────┘
                        │ ViGEm (virtual X360)                      │ WGC + WASAPI
                        │                                           ▼
┌───────────┐  WebRTC   │                                   ┌────────────────┐
│  Player   │◄──────────┼────────────── 60fps + DataChannel │   agent.py     │
│ (browser) │  input    │                                   │ (aiohttp/aiortc)│
└───────────┘           │                                   └───────┬────────┘
                        │                                           │ WHIP
┌───────────┐   WHEP    │                                           ▼
│Spectators │◄────────────────────────┐                     ┌────────────────┐
│ (browser) │    720p30 relay         │                     │    MediaMTX    │
└───────────┘                         │                     └────────────────┘
                        │                                           ▲
                        ▼                                           │
                ┌────────────────┐  HTTP/SSE  ┌────────────────┐    │
                │   Web app      │───────────►│   agent API    │────┘
                │  (Node.js, SPA)│  control   │  (port 3001)   │
                └────────────────┘            └────────────────┘
```

- **`agent.py`** (Python, on the Windows gaming PC) — captures the chiaki-ng window with **Windows Graphics Capture** (window-handle based, arbitration by actual frame production), encodes H.264 via **NVENC** (`bf=0`, `tune=ull` for low latency), captures chiaki's audio via **WASAPI process loopback**, and serves two WebRTC paths:
  - a **direct 60 fps** stream for the active player, with a DataChannel carrying controller input into a **ViGEm** virtual Xbox 360 pad that chiaki forwards to the console;
  - a **WHIP publish** into MediaMTX at 720p30 — one shared public stream for all spectators, read through the server's WHEP proxy.
- **`server.js`** (Node.js, no framework) — serves the SPA, the SSE state channel, session/user/chat storage (JSON files under `data/`), turn/queue logic, the hidden admin route, and a WHEP proxy to MediaMTX. Zero dependencies beyond `qrcode` (Pix donations).
- **`app.js` + `index.html` + `style.css`** — dependency-free SPA: WebRTC player/spectator client, touch gamepad overlay, chat drawer, fingerprint login, turn CTA, stats HUD.
- **`admin.html`/`admin.js`** — separate admin page served only at a configurable secret path (`ADMIN_PATH`), behind admin credentials. User approval/blocking/removal, password generation, diagnostics. Never linked from the public page.
- **`mediamtx.yml`** — MediaMTX config: WHIP ingest restricted to the agent's LAN IP, WHEP reads restricted to LAN/internal (the public edge is the Node proxy).
- **`docker-compose.yml` + `Dockerfile`** — web app + MediaMTX in containers, state persisted in `./data`.

### Latency engineering

The project went through a profiling pass against the chiaki source code and the WebRTC stack — notable details:

- Input path is already optimal in chiaki (4 ms poll, event-driven packet send); the perceived lag was all in the video glass, so:
- `h264_nvenc` launched with `bf=0` + `tune=ull` (B-frame reordering alone was ~66–100 ms);
- player track publishes at **60 fps** (chiaki natively produces ~55 fps; 30 fps was doubling frame staleness);
- receiver-side `jitterBufferTarget`/`playoutDelayHint` tuned down, plus client auto-degrade when `framesDropped` grows;
- Windows timer granularity fixed via `timeBeginPeriod(1)` + `time.sleep` pacing in a thread (a 33 ms `asyncio.sleep` was actually sleeping ~45 ms);
- capture pts uses the real capture instant so latency can't silently accumulate;
- the agent can launch chiaki with `--exit-app-on-stream-exit` so a dead session never lingers as a static window fooling the capture arbitration.

## Requirements

**Gaming PC (host):**
- Windows, NVIDIA GPU (NVENC used; encoder is swappable in `agent.py`)
- [chiaki-ng](https://streetpea.github.io/chiaki-ng/) installed and paired with the PS5
- [ViGEm Bus](https://github.com/nefarius/ViGEmBus) driver for the virtual X360 controller
- Python 3.10+ with `aiohttp aiortc windows_capture numpy` (+ `vigem` bindings)

**Server (any Linux box, e.g. an LXC):**
- Docker + Docker Compose
- Optional: coturn or any TURN server for players behind restrictive NAT
- Optional: a reverse proxy / tunnel to expose the site publicly

## Reproduce

1. **Pair chiaki-ng with your PS5** on the Windows host — register the console and note the nickname you used (`chiaki list`).
2. **MediaMTX + web app** — clone this repo on the server, copy `.env.example` to `.env` and fill it in (admin credentials, `AGENT_TOKEN`, `AGENT_URL`, your YouTube channel for the "last stream" fallback if desired). Replace `<…>` placeholders in `docker-compose.yml` / `mediamtx.yml` with your LAN values, then `docker compose up -d --build`.
3. **Agent** — on the Windows host: `python -m venv .venv && .venv\Scripts\pip install aiohttp aiortc windows_capture numpy vigem`, edit `start-agent.ps1` (token must match the server's `AGENT_TOKEN`), run it. The agent listens on `0.0.0.0:3001`.
4. **Publish the site** — point your reverse proxy/tunnel at the app port (`3100`). Set `ALLOWED_HOSTS` accordingly. Pick a non-obvious `ADMIN_PATH` — there is intentionally no public link to it.
5. **Approve friends** — a friend opens the page, types a nickname, and appears as *pending*. You approve from the 🔔 menu (or the admin page) and they can chat and play.

## Security notes

- No friend ever sees a password — devices are identified by fingerprint and each is explicitly approved by the owner.
- The admin UI lives only at a secret URL path and still requires credentials.
- All secrets (tokens, TURN credentials, LAN IPs, admin path) are environment variables or placeholders — keep it that way.
- Spectator reads go through the Node WHEP proxy; MediaMTX never needs to be publicly exposed.

## Status / roadmap ideas

- Persistent play-time ranking, presence list, and diagnostics are implemented.
- Natural next steps: scheduled sessions, per-user time limits, recording of sessions, OBS-style overlays.
