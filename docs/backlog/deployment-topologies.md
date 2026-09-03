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

## Shape A — LAN server: not started

The requirements are written down in [`../operations.md`](../operations.md) → *LAN server*. What does
not exist is anything shipped: **no Caddyfile, no systemd unit, and no documented install sequence.**
An operator following the requirements today is writing all three themselves.

Two things belong to this item rather than to the doc:

- **The mDNS service name.** One `Setting(...)` row with `stored=False`; the open part is the default
  name when two installations share a network. It is a prerequisite for passkeys over a LAN, not a
  convenience — see the transport pairing in `operations.md`.
- **Whether a `.local` name is accepted as a WebAuthn RP id.** It should be, since the RP id is set
  *equal* to the host rather than as a registrable suffix of it, but this is the one thing to verify
  empirically before building on it. Everything else about Shape A's passkey story depends on the
  answer.

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

**Windows and Linux installers are not in scope**; both platforms keep the portable zip. The
consequence to remember is that the Windows user-data directory is unreachable in any released
artifact, so no install has data under it — which stops being true the day an installer ships.

**Signing is deliberately not part of done.** Unsigned artifacts carry the OS warning, and someone
choosing to download one is choosing that. Notarization and code-signing certificates can be revisited
if the audience ever makes them worth their recurring cost.
