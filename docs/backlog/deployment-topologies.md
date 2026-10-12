# Deployment topologies — the unfinished half

**Status: what remains of the packaging/deployment work after the settled half was ingested
2026-09-02.** How Luma is packaged and run is now split across three stable docs, and this file holds
only what is genuinely unbuilt:

- [`../operations.md`](../operations.md) — the shapes, what each binds to, the data directory, restore
  as a destructive operation, and every rejected alternative (the native-window options, universal2,
  onefile in a `.app`, pyobjc, `%APPDATA%`).
- [`../releasing.md`](../releasing.md) — building the artifacts, the two distribution forms, macOS
  signing and the icon pipeline, CI and the release checklist.
- [`../architecture.md`](../architecture.md) → *Packaged builds* — bundle/install roots, the launcher,
  the shutdown signals, the macOS wrapper and the liveness watch.
- [`../security-model.md`](../security-model.md) — why the host name is load-bearing, and the transport
  policy each shape has to satisfy.

## Shape A — LAN server: the plan

**Designed 2026-10-12.** The shape is the downloaded kit run as a server, not a new artifact: the one
process already serves the interface and the API, so the proxy in front of it has nothing to do but
terminate TLS. What is built is described in [`../operations.md`](../operations.md) → *LAN server*; this
section holds what is not built yet, and the decisions behind all of it until the last piece lands and
they move there.

### Decisions

- **Server mode is a launcher mode, not a stored topology.** `SERVER_MODE` in `.env`, with `--server` /
  `--no-server` on the command line winning over it. The `.env` form is the only one that reaches a
  macOS app started from Finder. It changes what the process does at startup and nothing about how a
  request is judged — standalone versus networked stays detected per request.
- **Plain HTTP straight onto the network is supported, for whoever configures it.** Server mode stays
  on loopback behind the proxy unless `FRONTEND_HOST` widens it, and a source checkout does the same
  with `BACKEND_HOST`. It is the least setup there is — no proxy, and no certificate to trust on every
  device — and the app is expected to cope with it and to explain what it costs where the cost is met,
  not to refuse the configuration.
- **The server enforces one thing over plain HTTP: a provider secret does not cross the network.** The
  vault passphrase and the sign-in password are left to the operator's trust in their own network.
- **TLS is Caddy with its internal CA.** A `.local` name cannot get a publicly trusted certificate, and
  Caddy issues from its own CA for one with no configuration. The cost is that each client device trusts
  Caddy's root certificate once. A publicly registered domain with a DNS-challenge certificate, or a name
  served by the network's own DNS, are Caddyfile variants and need nothing different from Luma — but a
  name in local DNS does not avoid the trust step, since it cannot get a public certificate either, and
  it must not end in `.local`.
- **Luma advertises its own mDNS name**, so a device connects to `luma.local` without knowing which host
  the server is on. `MDNS_NAME` in `.env` overrides the default, which is how a second installation on
  one network is told apart; a name already answered on the network refuses the start and names the
  setting. Advertising a name other than the host's own needs a responder in the process (`zeroconf`),
  which is what makes it work on Windows and macOS as well.
- **Luma hands out Caddy's root certificate.** Caddy serves it on its loopback admin API, so Luma can
  fetch it on request with no file path or permission to configure. The download needs no sign-in — the
  certificate is public, and a device has to hold it before a password can safely be typed — and sits
  beside per-device install steps, reached from the sign-in screen and from the *Set up HTTPS* task.
- **Sign-in protection is steered, not required.** An operator who trusts their network may leave it
  off; the existing recommendation and task do the steering.
- **Windows and macOS can be the server.** The mode, the responder and Caddy are all cross-platform.
  What differs per OS is starting at boot, and systemd is the one recipe shipped and tested.

### To build

1. **The root-certificate download** and its install steps.
2. **A Caddyfile, a systemd unit and an install sequence**, with the Caddyfile generated for the
   configured name so the certificate and the advertised name cannot disagree.
3. **The topology UI**, collapsed from three radios to the one forward-looking question
   (`security-model.md` → *Open*), and the *Set up HTTPS* task pointed at instructions that exist.
4. **Containers** — the compose file publishes the backend port directly and its nginx forwards neither
   the scheme nor the client address, so every request there reads as cleartext from the network and
   the provider-secret operations are refused, from the same machine included. Accepted until this
   lands; separate from the rest.

### Open

- **Whether the download page shows the certificate's fingerprint**, to compare against the server's
  startup output. It answers a certificate swapped on a device's first visit; undecided.
- **Three things to verify on a real network**, none of which a development machine can show: that a
  `.local` name is accepted as a WebAuthn RP id (it should be, since the RP id is set *equal* to the
  host), that the client devices in use resolve `.local` at all, and that the responder coexists with
  the operating system's own on each platform — including a server whose host name equals `MDNS_NAME`,
  which is meant to pass as the same machine rather than be refused as a conflict.

## Shape B — desktop: step 3's remainder

Steps 1 and 2 are done. Step 3 (per-OS user-data default and OS installers, macOS first) is built and
green in CI on all four targets; what remains is **only what CI structurally cannot reach**, and none of
it can be closed without a Mac in front of somebody:

- **The Dock lifecycle.** Whether the icon appears without the launch bounce; whether Quit and
  Command-Q shut down cleanly *and* leave "Luma has stopped." in the log, which is the specific claim
  the signal handling makes; and whether the two death-watches behave in both directions — a
  force-quit wrapper stopping the server, and the server exiting quitting the wrapper.
- **Gatekeeper.** A locally built bundle is never quarantined, so the refusal and the "Open Anyway"
  path do not occur in CI at all. Only a browser-downloaded artifact carries the flag — and the
  quarantine survives being unarchived through Finder but **not** through `unzip`, so testing with the
  wrong tool tests nothing.
- **The log-file redirect.** It fires for a LaunchServices start, and the smoke harness launches the
  executable directly — deliberately, since that captures the output the redirect would otherwise
  divert. So the redirect has never actually run.

**Windows and Linux installers are not in scope**; both platforms keep the portable kit. The
consequence to remember is that the Windows user-data directory is unreachable in any released
artifact, so no install has data under it — which stops being true the day an installer ships.

**Signing is deliberately not part of done.** Unsigned artifacts carry the OS warning, and someone
choosing to download one is choosing that. Notarization and code-signing certificates can be revisited
if the audience ever makes them worth their recurring cost.
