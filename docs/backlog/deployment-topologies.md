# Deployment topologies

**Status: Shape B steps 1–2 done (2026-08-19); step 3 deferred. Shape A not started (notes only).** How Luma
is *packaged and run* — distinct from the security model that governs *who may reach it*
([`security-and-deployment-model.md`](security-and-deployment-model.md)). Two target shapes, one
codebase. Transport-security (HTTP vs HTTPS) reasoning lives in the security doc's "Transport security"
section and is only referenced here.

## The two shapes (and the profile they map to)

| Shape | Who reaches it | Security profile | Transport |
| --- | --- | --- | --- |
| **A — LAN server**: headless box on the local network | multiple devices | Client-server (`network_private`), sign-in **on** | **HTTPS** (Caddy) — required once auth or an aggregator is in play |
| **B — Single-user desktop app**: starts/stops with the app, loopback-only | one machine (a couple of profiles ok) | `local_private`, perimeter off | plain HTTP on loopback (no wire) |

They are the *same app*; they differ only in (a) how uvicorn is launched/bound, (b) whether a
TLS-terminating front or a desktop launcher wraps it, (c) which security profile is active.

## Passkeys make the host name load-bearing in both shapes

`_passkey_context` in `backend/routers/auth.py` derives the WebAuthn Relying Party id from the request
hostname, and refuses two cases outright: a **bare IP address** (an RP id must be a domain, so no amount
of serving fixes it) and a **non-loopback cleartext** request (WebAuthn requires a secure context). In
both cases the answer is "use a passphrase on this host" — a silent capability loss rather than an
error, which is exactly why it has to be designed for rather than discovered.

That turns what looks like packaging trivia into a constraint on each shape:

- **Shape B:** bind loopback, but hand the browser `http://localhost:<port>` — **not**
  `http://127.0.0.1:<port>`, which is an address and disables passkey vault slots with nothing visible
  to explain why. The RP id is the host alone (ports are not part of it), so a dynamically chosen port
  does not invalidate an already-registered passkey, and sessions survive it too because cookies are
  not port-scoped.
- **Shape A:** an address like `192.168.x.x` can never host passkeys however it is served, and a
  hostname on its own still fails the secure-context check. **mDNS and HTTPS are therefore the pair
  that makes passkeys reachable over the LAN** — neither is optional polish and neither works without
  the other. The one thing to verify empirically before building on it is whether a `.local` name is
  accepted as an RP id; it should be, since the RP id is set *equal* to the host rather than as a
  registrable suffix of it.

## Shared prerequisite: something must serve the built SPA

Settled and in place — `backend/spa.py`, described under *High-level shape* in
[`architecture.md`](../architecture.md). A single uvicorn process is now self-sufficient, which is what
both shapes were waiting on: Shape B needs nothing else, and Shape A can either use it or let Caddy
serve `dist/` directly.

## Shape A — LAN server + Caddy

Well-trodden, nothing exotic:

- **uvicorn** binds `127.0.0.1:8000` (not `0.0.0.0`) — only Caddy reaches it.
- **Caddy** terminates TLS (internal CA, or a real cert via DNS challenge if a domain points at the box),
  reverse-proxies `/api` → uvicorn, and serves `dist/`. Run uvicorn with `--proxy-headers` so
  `request.url.scheme` is correct behind the proxy.
- **systemd** unit keeps uvicorn alive across reboots.
- Cookie hardening: `SESSION_COOKIE_SECURE=true` (see the security doc's transport section).
- **mDNS name + HTTPS together**, per the passkey section above — this is the part that was previously
  filed as convenience and is not.
- SQLite is fine at household concurrency; no DB change needed.

The mDNS plumbing is already scoped in
[`optional-env-and-layered-config.md`](optional-env-and-layered-config.md) as one `Setting(...)` row
with `stored=False`; the open question there is the default name when two installations share a network.

## Shape B — Single-user desktop app

Goal (user's words): one thing to run, instead of starting a backend and a frontend and then pointing a
browser at them. A native window is explicitly *not* required — running in the browser is fine.

### The build environment is pinned to Python 3.12–3.13

Not a preference: `pydantic-core` (pinned exactly by `pydantic==2.8.2`) publishes no wheels for 3.14, so
a 3.14 environment falls back to compiling it from source and fails somewhere that says nothing about
the real cause. `cryptography` is fine — its wheels are `abi3` and forward-compatible — so pydantic is
the whole of the constraint.

Three things enforce it rather than describing it: `requires-python = ">=3.12,<3.14"` in
`pyproject.toml`, a version-checked interpreter choice when either launcher builds the venv (named
versions are tried first, so a machine whose default `python3` has moved on still gets a working
environment), and the stated requirement in `README.md`. Lifting the ceiling is a dependency-bump
project — upstream is ready, `pydantic-core` 2.48 ships cp314 — and it would move fastapi, pydantic and
cryptography off their current pins, which changes the runtime under a live install. Not a packaging
change.

### The shell decision is settled by passkeys, not by packaging

Every option shares the same crux — the backend is Python, so a Python runtime plus deps (including
native ones like `cryptography`) ships as a self-contained bundle (PyInstaller). What separates them is
which browser engine ends up rendering the app, and passkey vault slots need not just WebAuthn but the
`prf` extension (CTAP2 `hmac-secret`), which is a much narrower guarantee.

| Option | Engine | Passkey/PRF outlook | Verdict |
| --- | --- | --- | --- |
| **Launcher → default browser** | whatever browser the user already has | **works** — a real, current browser | **chosen** |
| pywebview | OS webview, driven from Python | uncertain; WebKitGTK on Linux is the weakest of the three engines | rejected |
| Tauri + Python sidecar | Rust shell, OS webview | same webview question, same Linux wrinkle | rejected |
| Electron + Python sidecar | bundled Chromium | historically no platform-authenticator support at all | rejected |

The earlier ranking here put pywebview first on packaging friction, before passkeys were a stated hard
requirement. Under that requirement the ranking inverts: the launcher is the only option whose engine is
a browser the user keeps updated themselves, and it is also the only one that avoids owning a webview
dependency (WebKitGTK on Linux) or a second heavy runtime. Losing the "real window" is the whole cost,
and it buys back the packaging story as well as the crypto one.

The launcher exists as `backend/desktop.py` (its behavior and the reasoning behind the loopback-bind /
localhost-URL split are in [`architecture.md`](../architecture.md)). Step 2 changes how it is *shipped*,
not what it does: the same entry point becomes the PyInstaller entry point.

### Distribution forms — the rule is per-form, not per-OS

Where the databases live is decided by *how the app was distributed*, not by which OS it runs on. One
branch, no platform matrix:

- **Portable** (a zip: binary plus its data beside it) — `DATA_DIR` resolves next to the executable, and
  the zip ships **no** configuration file. `runtime_config.anchor_relative` makes a relative setting mean
  "beside the executable" in a frozen build, so the existing `DATA_DIR = "."` default already lands in
  the right place; an `.env` was expected to be needed here and turned out not to be.
- **Installed** (an OS installer) — `DATA_DIR` defaults to the per-OS user-data directory
  (`%APPDATA%`, `~/Library/Application Support`, `~/.local/share`). Because the portable form now works
  off the plain default, telling the two apart is the open question step 3 has to answer — a build-time
  signal baked into the artifact, rather than anything the user configures.

macOS only supports the installed form. A `.app` bundle cannot hold its own writable data: writing
inside a notarized bundle invalidates the signature, and **App Translocation** mounts a quarantined app
at a randomized read-only path, so "beside the executable" resolves somewhere that disappears. That is
the same failure a PyInstaller *onefile* binary has anyway — it unpacks to a temp directory that is
deleted on exit — which is why "default to the installation directory" cannot be the universal rule even
though it is the intuitive one.

Both forms rest on the same change, which is in place: `bundle_root` and `install_root` in
`runtime_config.py`, described under *Packaged builds* in [`architecture.md`](../architecture.md). They
are the same directory in a checkout, which is why nothing needed the distinction until there was a
build to package.

Whichever form is in play, Settings → Configuration already reports the effective value and the layer it
came from, so the resolved data directory stays visible rather than inferred and hidden.

### Sequencing

1. **Serve the SPA from the backend, plus the launcher.** *Done.* No packaging involved — this is the
   feature itself, and it works from a checkout immediately. The durable design now lives in
   `architecture.md` (three topologies, the client-route fallback, the standalone run mode); what stays
   here is only what steps 2–3 still depend on.
2. **Frozen-aware roots, PyInstaller onefile, portable zip** for Windows and Linux. *Done.*
   `scripts/luma.spec` and `scripts/build_desktop.py` build it, `scripts/release.py` gates and
   checksums it, and `backend/requirements-build.txt` carries the build-only dependency.
   `.github/workflows/release.yml` runs the whole thing per platform on a `v*` tag — a matrix rather
   than a loop because PyInstaller cannot cross-build, and it stops at uploading artifacts because
   publishing is a person's decision. **Both the Linux x64 and Windows artifacts have been built and
   run**; what is still unexercised is the workflow itself, since no `v*` tag has been cut yet.
3. **Per-OS user-data default and OS installers**, macOS included. Deferred, and separable — nothing in
   steps 1–2 forecloses it.

Signing is deliberately **not** part of step 3's definition of done: unsigned artifacts carry the OS
warning, and someone choosing to download one is choosing that. Notarization and code-signing certs can
be revisited if the audience ever makes them worth their recurring cost.

## Cross-refs

- [`security-and-deployment-model.md`](security-and-deployment-model.md) — the security profiles these map
  to, and the **transport-security policy** (HTTP-permitted-only-when-passwordless-and-no-aggregator, the
  `SESSION_COOKIE_SECURE` gate, why browser-side crypto is not an escape hatch from TLS).
- [`optional-env-and-layered-config.md`](optional-env-and-layered-config.md) — the layered config these
  builds configure themselves through, and the mDNS follow-up Shape A depends on.
