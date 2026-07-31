# Deployment topologies

**Status: notes / not started (2026-07-30).** How Luma is *packaged and run* — distinct from the
security model that governs *who may reach it* ([`security-and-deployment-model.md`](security-and-deployment-model.md)).
Two target shapes, one codebase. Transport-security (HTTP vs HTTPS) reasoning lives in the security
doc's "Transport security" section and is only referenced here.

## The two shapes (and the profile they map to)

| Shape | Who reaches it | Security profile | Transport |
| --- | --- | --- | --- |
| **LAN server** — headless box on the local network | multiple devices | Client-server (`network_private`), sign-in **on** | **HTTPS** (Caddy) — required once auth or an aggregator is in play |
| **Single-user desktop app** — starts/stops with the app, loopback-only | one machine (a couple of profiles ok) | `local_private`, perimeter off | plain HTTP on `127.0.0.1` (no wire) |

They are the *same app*; they differ only in (a) how uvicorn is launched/bound, (b) whether a
TLS-terminating front or a desktop shell wraps it, (c) which security profile is active.

## Shared prerequisite: something must serve the built SPA

Today the FastAPI backend serves **only `/api`** — nothing serves the built React bundle (`frontend/dist`);
Vite does that in dev. Both shapes need the SPA served, so the one shared code addition is a
**`StaticFiles` mount** in `backend/main.py` that serves `dist/` with an `index.html` fallback for client
routes. With that, a single uvicorn process is self-sufficient (desktop needs no Caddy/Vite; the LAN
server *can* still let Caddy serve `dist` directly if preferred).

## Shape A — LAN server + Caddy

Well-trodden, nothing exotic:

- **uvicorn** binds `127.0.0.1:8000` (not `0.0.0.0`) — only Caddy reaches it.
- **Caddy** terminates TLS (internal CA, or a real cert via DNS challenge if a domain points at the box),
  reverse-proxies `/api` → uvicorn, and serves `dist/`. Run uvicorn with `--proxy-headers` so
  `request.url.scheme` is correct behind the proxy.
- **systemd** unit keeps uvicorn alive across reboots.
- Cookie hardening: `SESSION_COOKIE_SECURE=true` (see the security doc's transport section).
- SQLite is fine at household concurrency; no DB change needed.

## Shape B — Single-user desktop shell

Goal (user's words): an app that is both frontend and backend, doesn't accept external connections, and
stops when you exit it. The **crux for every option is the same**: the backend is Python, so you must ship
a Python runtime + deps (including native ones like `cryptography`) as a self-contained bundle
(PyInstaller / PyOxidizer). The *window shell* is the smaller decision.

Options, best-fit first for a Python backend:

| Option | Shell | Fit | Notes |
| --- | --- | --- | --- |
| **pywebview** | native OS webview, driven from **Python** | best — one language | FastAPI in-process (a thread), window points at `127.0.0.1:<port>`. No Node/Rust, no cross-language IPC. |
| **Tauri + Python sidecar** | Rust shell, OS webview | good, more "native app" | first-class **sidecar** support ships the PyInstaller'd backend and manages its lifecycle; ~10 MB shell. |
| **Electron + Python sidecar** | bundled Chromium | works, heaviest | ships all of Chromium *and* you still bundle Python — little gain over Tauri here. |
| **Launcher → default browser** | none | simplest possible | a PyInstaller binary starts uvicorn on loopback, opens the browser, stops on exit. Not a "real window," but genuinely single-user. |

All bind to `127.0.0.1` (no external connections) and tie the backend's lifetime to the app (child-process
kill on window close, or in-process for pywebview). "Single-user but someone else could run it on my
machine" is already served by the **local profile chooser** (`local_preference_profile`) — pick an
identity, no passwords, one machine.

### pywebview — the Python-installation question (the open worry)

pywebview is a thin Python wrapper over a **platform webview backend**, which is the wrinkle for
"installation requirements":

- **Windows:** uses **WebView2** (Edge Chromium), whose runtime ships with current Win10/11. End users
  install nothing extra; a PyInstaller bundle carries Python + your code.
- **macOS:** uses **WKWebView**, part of the OS (via pyobjc). Same story — bundle carries Python, webview
  is already there.
- **Linux:** uses **WebKit2GTK** via PyGObject, which is a **system dependency** (`gir1.2-webkit2-4.x`,
  `python3-gi`, GTK libs) — *not* pip-installable in isolation. A PyInstaller bundle can carry Python and
  the pip deps, but the target still needs the WebKitGTK system libraries present. This is the one place
  the "single self-contained file" story is weakest.

So: **end users do not install Python separately** (PyInstaller embeds it) on any platform; the real
variable is the **OS webview backend** — free on Windows/macOS, a system-package dependency on Linux.
For a primarily-Linux self-host this nudges toward either (a) documenting the WebKitGTK dependency, (b)
the launcher-→-browser option (no webview backend needed at all — uses whatever browser is installed), or
(c) Tauri (same WebKitGTK dependency on Linux, so it doesn't dodge the issue). If cross-platform desktop
distribution matters, Windows/macOS are the smoother targets for pywebview; Linux wants the browser-launcher
fallback or a documented dependency.

## Recommendation

- **LAN server:** Caddy + uvicorn(`127.0.0.1`) + systemd + sign-in protection on + `SESSION_COOKIE_SECURE`.
- **Desktop:** **pywebview** (least friction for a Python backend), with the **browser-launcher** as the
  no-webview-dependency fallback (notably for Linux). Electron/Tauri only if a polished packaged native app
  is worth owning the sidecar packaging.
- **Shared, do first regardless:** the `StaticFiles` SPA mount, so one uvicorn process stands alone.

## Cross-refs

- [`security-and-deployment-model.md`](security-and-deployment-model.md) — the security profiles these map
  to, and the **transport-security policy** (HTTP-permitted-only-when-passwordless-and-no-aggregator, the
  `SESSION_COOKIE_SECURE` gate, why browser-side crypto is not an escape hatch from TLS).
