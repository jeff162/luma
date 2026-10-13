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
terminate TLS. What is built is described in [`../operations.md`](../operations.md) → *LAN server* and
*Containers*, and nothing is left to build; this section holds the decisions behind it and what has not
been seen working yet.

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
  beside per-device install steps, reached from the sign-in screen and from Administration. The page
  shows the certificate's fingerprint, and the server states the same one from a command on its own
  console and in Administration, so a certificate swapped on a device's first visit — the one moment it
  is fetched over a connection nothing vouches for — can be caught by comparing the two. That is once
  per device and optional; nothing is checked at startup. The server keeps the first fingerprint it
  sees, and a different one later is put to an administrator as a task, because every device then needs
  the new certificate.
- **Sign-in protection is steered, not required.** An operator who trusts their network may leave it
  off; the existing recommendation and task do the steering.
- **Windows and macOS can be the server.** The mode, the responder and Caddy are all cross-platform.
  What differs per OS is how it is started. Linux has the systemd unit; Windows starts at sign-in with a
  notification-area icon, and runs a proxy placed beside the executable itself; macOS is left to the
  operator.

### Open

- **The per-device install steps are checked for Windows only.** Those were followed on a real machine
  and corrected from it. The Mac, Linux, iPad and Android steps were written from how each platform is
  known to work, not from a run.
- **Verified on a real network, 2026-10-12**, with the server on Ubuntu behind Caddy and a Chromium-based
  browser on Windows: the advertised `.local` name resolves, the certificate installs and is trusted,
  and a `.local` name is accepted as a WebAuthn RP id — a vault passkey registered and unlocked there.
  The service comes back by itself after a reboot, and the files `--caddyfile` and `--systemd-unit`
  print match the ones written by hand for that machine.
- **Still to verify on a real server**:
  - the install sequence followed from the printed files on a machine that has neither yet;
  - a sign-in passkey on a `.local` name;
  - a tablet, for both resolving `.local` and the install steps (the pages are not built for a phone,
    so a tablet is the small end of what connects);
  - Administration → *Server certificate*, including the fingerprint check against a thumbprint read
    off a Windows machine, and the dialog the sign-in screen's link opens;
  - Administration → *Network access* over HTTPS and from the server's own browser — only the
    this-computer-only reading has been seen rendered;
  - that a signed-out page load no longer leaves an `[auth] rejected /api/auth/preferences` line in the
    journal;
  - the responder beside the operating system's own on Windows and macOS as the server;
  - a server whose host name equals `MDNS_NAME`, which is meant to pass as the same machine rather than
    be refused as a conflict;
  - Windows as the server from a real build: the proxy beside the executable started and stopped by it,
    the notification-area icon's *Open*, *Stop*, *Start* and *Exit*, the dialog when a start fails, and the entry
    actually firing at sign-in. The proxy as a child has run on Linux only.

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
