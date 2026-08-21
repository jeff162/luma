# Deployment topologies

**Status: Shape B steps 1–2 done (2026-08-19); step 3 in progress from 2026-08-20 — all four targets
build and smoke-test green in CI; what remains is what CI cannot reach (Gatekeeper, and the
LaunchServices log path). Shape A not started (notes only).** How Luma
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
  (`%APPDATA%\Luma`, `~/Library/Application Support/Luma`, `$XDG_DATA_HOME` or `~/.local/share` plus
  `luma`). Because the portable form works off the plain default, telling the two apart needed a
  build-time signal rather than anything the user configures. **Settled:** `LUMA_DIST_FORM` selects the
  form at build time, `scripts/luma.spec` writes it into the bundle as a one-word file, and
  `runtime_config.distribution_form()` reads it back — a bundled file rather than a generated module, so
  the signal travels inside the artifact and a build cannot leave one behind in a checkout to change how
  a developer's copy resolves. A missing or unrecognized declaration falls back to what the platform can
  support, which is *installed* on macOS and portable elsewhere, and the spec refuses to build a
  portable macOS artifact at all. The same signal moves the optional `.env`, which an installed build
  has nowhere to keep beside the executable; it resolves from `user_data_dir()` rather than `data_dir()`
  because that file is one of the things that may *set* `DATA_DIR`. Details in
  [`architecture.md`](../architecture.md) under *Packaged builds*.

  Windows uses `%APPDATA%` (roaming) rather than `%LOCALAPPDATA%`, as first written here. Worth a second
  look before a Windows installer ships: SQLite on a roaming profile is a real hazard in a domain
  environment, and `platformdirs` treats local, not roaming, as the default for application data.

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
3. **Per-OS user-data default and OS installers**, macOS first. *In progress.* The platform-neutral
   spine is in place — `distribution_form()`, `user_data_dir()`, `default_data_dir()`, the
   `LUMA_DIST_FORM` build signal, `build_desktop.py --form`, the `.env` relocation, and a fix to the
   configuration report, which had been resolving a relative data directory against the working
   directory and so named a path a packaged build was not using. All three OS branches are exercised
   from one platform in `backend/tests/test_packaged_paths.py` by faking `sys.frozen` and `sys.platform`.
   The smoke harness is `scripts/smoke_artifact.py`, wired into every build job, which on Linux also
   builds an installed-form artifact so the per-OS directory is exercised for real rather than first on
   macOS. **Verified in CI on 2026-08-20:** the release workflow runs green on Linux and Windows —
   tests, both builds, the portable smoke on each, and the installed-form build and smoke on Linux.

   **The Dock work (2026-08-20) builds and launches.** The Swift wrapper compiles, the bundle assembles,
  and the app runs once ad-hoc signed (see the signing entry below — the first build failed as
  "damaged"). What has *not* been confirmed either way: whether the Dock icon appears without the
  launch bounce, whether Quit and Command-Q shut down cleanly, and whether the two death-watches behave
  — wrapper force-quit stopping the server, and the server exiting quitting the wrapper. **Shutdown
  behaviour is the open thread**, and this machine cannot check any of it: no Swift toolchain, no Mac.

  macOS builds and runs. All four targets — Linux, Windows, `macos-latest` (arm64) and `macos-15-intel`
   (x64) — go green, smoke tests included, which settles the one thing that could not be reasoned out in
   advance: PyInstaller puts `sys._MEIPASS` inside the `.app` where `bundle_root()` looks for it, so the
   bundled SPA and the distribution-form marker are both readable from within the bundle.

   The first macOS run found one real bug, of a kind only a packaged build on that platform can have:
   **no certificate store**. A frozen build carries an OpenSSL whose default CA path points at the build
   machine's layout, so every outbound HTTPS call failed with "unable to get local issuer certificate" —
   both providers, not just the one that surfaced it, since the Plaid SDK reaches the network through
   urllib3 and hits the same missing defaults. Fixed by verifying against the OS trust store
   (`truststore`) rather than shipping a pinned CA bundle; see *Packaged builds* in
   [`architecture.md`](../architecture.md). The smoke test now fails if a packaged build reports falling
   back, which costs no network call because the bootstrap already says so on stderr.

   Two things CI structurally **cannot** reach, and which the on-demand Mac still has to:

   - **Gatekeeper.** A locally built bundle is never quarantined, so the refusal and the "Open Anyway"
     path simply do not occur in CI. Only a browser-downloaded artifact carries the flag — and the
     quarantine has to survive being unarchived, which it does through Finder and does *not* through
     `unzip`, so testing with the wrong tool tests nothing.
   - **The log file.** It exists for a LaunchServices start, and the smoke harness launches the
     executable directly — which is deliberate, since it captures the output it would otherwise divert.
     So the redirect has never actually fired.

   Windows and Linux installers are **not** in this step's scope — both platforms keep the portable zip.

### macOS specifics

Four things that are decided rather than discoverable, and that a build has to get right the first time:

- **Both architectures are wanted, and the Intel runner label has moved.** The `macos-13` image — the
  last Intel one under that name — began deprecation on 22 September 2025 and was retired on 4 December
  2025. The Intel label is now `macos-15-intel`, and GitHub has stated x86_64 support on Actions ends
  when that image retires, around **August 2027**. So the matrix is `macos-latest` (arm64) plus
  `macos-15-intel` (x64), with a known expiry on half of it. `_platform_tag()` in `build_desktop.py`
  already names both correctly from `platform.machine()`.
- **Two DMGs rather than one universal2 binary.** A universal2 build needs universal2 wheels for
  `cryptography` and `pydantic-core`, which are not dependably published; the failure is an obscure link
  error rather than a clear one. The cost is a "which one?" line in the README.
- **A `.app` gets a onedir build, not onefile.** A onefile binary inside a bundle re-unpacks to a
  temporary directory on every launch — slow, and the same vanishing-path problem in a different guise.
- **No console when launched from Finder.** `backend/desktop.py` treats the printed URL as its contract
  and the browser opener as a convenience on top; on macOS neither stdout nor stderr goes anywhere a
  user will see, so a startup failure presents as a bouncing icon and nothing else. A log file in the
  data directory is what replaces it. The URL itself is already recoverable — `luma-desktop.lock`
  records the port.
- **A Python process cannot be a macOS application.** Two failed attempts established the shape.
  `console=True` makes PyInstaller write `LSBackgroundOnly=True`, so the app has no Dock icon, no sign
  it is running, and nothing to quit — findable only through `ps`. Turning it off produced a Dock icon
  that **bounced for minutes** and then offered only Force Quit, because LaunchServices expects a regular
  application to check in with the window server and this one never does; the bounce is the launch
  timeout, and the missing Quit is macOS knowing an Apple Event will not be answered. There is no
  setting between the two.

  The resolution is a small native wrapper (`macos/main.swift`) that *is* the application, with the
  Python build as its child; `scripts/build_desktop.py` assembles the bundle around it and PyInstaller
  emits a plain onedir tree. Rejected alternative: pyobjc inside the Python process, which would mean a
  large macOS-only dependency plus moving uvicorn off the main thread — where it sits precisely so
  Ctrl+C is clean — and would fork the one launcher all three platforms share. The wrapper confines
  every macOS-specific concern to the macOS artifact instead.
- **The application had no icon at all**, nor even a favicon. `assets/luma-icon.svg` is now the single
  source, with `scripts/build_icons.py` deriving the committed `.icns`, `.ico` and favicons — full-bleed
  for Windows and the browser, inset to Apple's 824-of-1024 grid for macOS, since an icon that fills its
  canvas sits visibly larger than its neighbours in the Dock.
- **The bundle has to be ad-hoc signed, and assembling it by hand loses that.** PyInstaller's `BUNDLE`
  signs what it produces (`sign_binary(..., deep=True)`, ad-hoc when no identity is given). Building the
  bundle around the native wrapper instead took that step with it, and the result was worse than a
  warning: on Apple Silicon an unsigned binary does not merely go untrusted, it will not load, and a
  quarantined bundle with no signature is reported as **"Luma is damaged and can't be opened"** — which
  reads as a corrupt download rather than an unsigned one. `scripts/build_desktop.py` now runs
  `codesign --force --deep --sign -` as the last step of assembly, since anything written afterwards
  invalidates the seal. This is *not* notarization: Gatekeeper still asks for approval, and the
  "Open Anyway" path in the README still applies. Invisible in CI, because a locally built artifact is
  never quarantined.

- **Quitting is answered twice over, in both directions.** In the app, "Shut down Luma" asks the server
  to stop — not a macOS consolation prize but the answer on Windows and Linux too, where the alternative
  was "find the terminal and press Ctrl+C"; see *Packaged builds* in
  [`architecture.md`](../architecture.md) for how the capability is gated so a LAN deployment never
  offers it. On macOS the wrapper adds Dock Quit and Command-Q, sending SIGTERM into that same path.

  Neither process is left behind when the other goes first. The wrapper holds the write end of a pipe
  whose read end is the child's stdin; a **zero-length** read there means every write end is closed,
  which the kernel guarantees even under SIGKILL — the case a force-quit wrapper cannot clean up after
  itself. In the other direction the wrapper's termination handler quits the app, so a server that
  exited on its own does not leave a dead icon in the Dock. Only end-of-file counts: treating any
  completed read as death would turn a stray byte into a shutdown, and the arrangement is declared by an
  environment variable rather than inferred, since `something | luma` also hands over a pipe — one
  already at EOF, which would exit instantly on startup.

**The quarantine step has to be documented, and the familiar gesture is wrong.** Control-click → Open no
longer bypasses Gatekeeper for unsigned applications on macOS 15 Sequoia. The path that works is to
attempt to open, be refused, then allow it under System Settings → Privacy & Security → "Open Anyway" —
or `xattr -dr com.apple.quarantine /Applications/Luma.app`. Documenting the old gesture would produce
exactly the outcome this step is trying to avoid: a tester concluding the build is broken.

Signing is deliberately **not** part of step 3's definition of done: unsigned artifacts carry the OS
warning, and someone choosing to download one is choosing that. Notarization and code-signing certs can
be revisited if the audience ever makes them worth their recurring cost.

## Cross-refs

- [`security-and-deployment-model.md`](security-and-deployment-model.md) — the security profiles these map
  to, and the **transport-security policy** (HTTP-permitted-only-when-passwordless-and-no-aggregator, the
  `SESSION_COOKIE_SECURE` gate, why browser-side crypto is not an escape hatch from TLS).
- [`optional-env-and-layered-config.md`](optional-env-and-layered-config.md) — the layered config these
  builds configure themselves through, and the mDNS follow-up Shape A depends on.
