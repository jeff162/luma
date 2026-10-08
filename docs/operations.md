# Running and operating Luma

How a copy of Luma is deployed, what it binds to, where it keeps its data, and what to do when
something is wrong. The audience is whoever is running an instance — which on a desktop install is the
same person using it, and on a networked one is not.

**This is the running half. Building is the other half and lives in [`releasing.md`](releasing.md)** —
producing the artifacts, the two distribution forms, macOS signing, CI, and the release checklist.
Nothing here needs a build; nothing there is needed to run one.

Two other boundaries, so nothing is stated twice:

- **[`security-model.md`](security-model.md)** owns *whether a topology may run over plain HTTP*, the
  permissible-HTTP rule, and why the host name is load-bearing. This document says what to configure;
  that one says what the configuration has to satisfy and why.
- **[`architecture.md`](architecture.md)** owns the mechanism — the launcher, packaged-build roots,
  shutdown signals, liveness detection, the configuration resolver. This document is the operator's
  view of the same code.

---

## The three ways Luma is run

| | Reached by | Serves the interface | Binds | Perimeter |
| --- | --- | --- | --- | --- |
| **Desktop** | one machine | the backend itself | loopback | usually off |
| **LAN server** | several devices | a TLS-terminating proxy, or the backend | loopback behind the proxy | on |
| **Containers** | one machine or a LAN | an nginx container proxying `/api` | the published ports | either |

They are the **same application**. What differs is only how uvicorn is launched, whether something
wraps it, and which security profile is in force.

**Standalone versus networked is detected per request, not configured.** The same install answers as
loopback from its own machine and as networked from another, so there is no stored mode to get wrong —
and no mode to set correctly either. What *is* declared is the forward-looking question of whether a
data source will be connected, because standing up HTTPS is not instantaneous and the requirement
cannot first be discovered at connect time. See `security-model.md` → *Transport security*.

## Desktop

One process. `python -m backend.desktop` (or the packaged executable) serves the interface and the API
together and opens a browser at it — no second process, no proxy.

**It binds `127.0.0.1` but hands out `http://localhost:<port>`, and the difference matters.** A
WebAuthn Relying Party id must be a domain, so opening the address form silently disables every passkey
vault slot with nothing on screen to explain why. Use the printed URL.

**The port is `FRONTEND_PORT`, and it is preferred, not guaranteed.** The browser's port has that one
name in every topology; here the single process *is* the frontend, so `BACKEND_PORT` — the internal hop
behind Vite or nginx elsewhere — is not read. A busy configured port falls back to an ephemeral one, and
says so rather than doing it silently — a separately started `uvicorn` on the same databases is usually
what that means. Nothing durable is keyed to the port: cookies are not port-scoped and an RP id is the
host alone, so a passkey registered on one port still works on the next.

**A second launch opens a tab, it does not start a second instance.** `luma-desktop.lock` in the data
directory records the port. It records a port and not a claim of liveness — it survives a crash — so
`/api/health` is what settles whether the recorded instance is actually there.

**Opening the browser is a convenience; the printed URL is the contract.** No opener on any platform
reports success usefully, so the outcome is never claimed. `--no-browser` skips the attempt.

**The launcher starts the opener itself on Linux, rather than through Python's `webbrowser`.** That
console is the whole interface at startup — it carries the address and the way to stop — so anything a
child process writes to it is read as Luma's, by someone who has just run an unsigned binary for the
first time. `webbrowser` starts the generic openers without redirecting their streams, which puts the
browser's own startup chatter directly under Luma's startup line; starting `xdg-open` directly discards
it, and gives the child a session of its own so the Ctrl+C that stops the server does not also close the
window being read. Under WSL the path is different again, because `xdg-open` there prints a failure for
each Linux browser the distribution does not have and that wall of errors reads as a crash while the
server runs normally. An explicit `BROWSER` in the environment defers to `webbrowser`, which is what
honors it, and every non-Linux platform does too — their openers already redirect what they start.

**Stopping it.** *Shut down Luma* in the navigation panel, the Dock's Quit or Command-Q on macOS,
Ctrl+C, **closing the terminal a portable build was started from**, and a system shutdown all converge on
uvicorn's graceful path, so in-flight requests finish and the lockfile is released. The last two are not
special-cased: a system shutdown reaches the process as an ordinary SIGTERM, and a closing terminal as
SIGHUP. Neither is graceful by default — SIGTERM would be delivered a second time to `SIG_DFL` after
uvicorn's own handler stands down, and SIGHUP is not in uvicorn's handled set at all — so the launcher
installs handlers for both (`_install_stop_signal_handlers`), and for SIGINT. **Windows is the exception**:
it has no SIGHUP, so closing a console window there is not a graceful stop. A second Ctrl+C does not
force a quit — one keypress can reach a packaged build twice — so a stop waits at most five seconds for
in-flight requests and then closes them.

The grace is bounded from outside and unbounded from inside: the server waits on in-flight requests
indefinitely, while the macOS wrapper allows 20 seconds after SIGTERM before SIGKILL, and a supervisor
elsewhere allows whatever its unit specifies. A stop during a long operation can therefore be cut short —
which costs the in-flight transaction (rolled back) and leaves the lockfile behind, both of which the
next launch already handles. The in-app control is **registered by the launcher**, so an instance started with
plain uvicorn does not offer it: on a supervised box, stopping the process from a browser is either
futile or a way for one signed-in user to take the service from everyone else.

**Where the output goes.** An application started from Finder on MacOS has no terminal, so both streams are
redirected to `luma-desktop.log` beside the data. That is detected from the environment LaunchServices
sets rather than by asking whether stdout is a terminal — that question also answers "no" for a pipe,
and diverting output whenever something captures it would take the diagnostics away from the smoke
harness, which captures them precisely to explain a failed launch.

**The server also keeps its own log, in every topology.** `luma.log` beside the data database is a *copy*
of what the server logs (`backend/app_log_file.py`): a handler added next to uvicorn's rather than a
redirect, so the terminal, the systemd journal and `docker logs` keep everything they received before. It
holds warnings and errors, a crashed request's traceback included, a line each time the server starts, and
access lines only for requests that failed; successful requests stay out, or routine polling would soon
rotate a failure out of the file. So does what a client can cause without signing in (a 401, a 404, and
uvicorn's warnings about malformed traffic), since on a networked install a flood of those would push
genuine failures out the same way. **The start line names the version**, and in the desktop shape the
address that launch settled on — a busy configured port falls back to an ephemeral one, and nothing else
records which one a given run ended up on. The other topologies omit the address rather than guess at it:
running from source the browser is on the frontend's port with this server as an internal hop behind it,
and a container's published port is a mapping made outside the process. It rotates at 1 MB and keeps one
previous file (`luma.log.1`).
What it cannot hold is anything before the application starts, such as a missing dependency or a crash
during import: that stays in the output alone, which on macOS means `luma-desktop.log`. A start that fails later,
in the application's own startup (a migration raising), is held — the log is set up before the data
database is readied. Settings → **Error log** reads the errors back out of it, for administrators only,
since a traceback can carry transaction details and paths; each message and traceback it shows is cut at a fixed length, and the file keeps the rest.
`LUMA_USE_LOG_FILES` is a different thing: it makes the start scripts save their terminals'
output beside the scripts.

**Errors raise a task for administrators.** Each error the file keeps is also counted into the control
database as it is logged, and the Tasks page shows how many no administrator has seen yet, to exactly the
people who can open the Error log. Opening it acknowledges them for the whole install. The count is kept
rather than re-read from the file because the file rotates, which would take an unseen error with it; so
nothing scans the log at startup. An error is a failure someone should look at — a crashed request, or a
step that failed after the work around it had succeeded — and a warning is something the server coped
with, which stays in the file and raises nothing.

## LAN server

**This shape is documented, not shipped.** No Caddyfile and no systemd unit are in the repository; the
operator writes both. What follows is what they have to satisfy.

- **uvicorn binds `127.0.0.1`**, not every interface — only the proxy reaches it.
- **A TLS-terminating reverse proxy** (Caddy is the assumed one) serves the built interface and
  reverse-proxies `/api` to uvicorn.
- **Run uvicorn with `--proxy-headers`**, or `request.url.scheme` reports the internal HTTP hop and
  every HTTPS-conditional behavior reads the deployment as cleartext.
- **Set `SESSION_COOKIE_SECURE=true`** at the deployment edge. It is deliberately not derived from the
  security profile — see `security-model.md` → *Considered and rejected*.
- **A supervisor** (systemd) keeps uvicorn alive across reboots.
- **SQLite is adequate at household concurrency.** No database change is needed for this shape.

**An mDNS name and HTTPS are a pair, not two conveniences.** A LAN address like `192.168.x.x` can never
host passkeys however it is served, and a name without HTTPS still fails WebAuthn's secure-context
requirement. Neither alone makes passkeys reachable over the LAN. The mDNS name itself is not built —
see *Open*.

## Containers

`docker-compose.yml` runs two services: the backend with `DATA_DIR=/data` over a bind-mounted `./data`,
and an nginx container that serves the built interface and proxies `/api/` to `backend:8000`. `.env` is
honored when present and not required.

This is a **third** topology rather than a variant of the other two, and it is the one where the
data-directory question has an answer that is not the default: the databases live in the mounted
volume, so backing up the host directory is backing up the installation.

## Where the data lives, and how the app decides

**One directory, fixed filenames.** `DATA_DIR` holds both databases. The two always travel together, so
a second installation wants a second directory rather than a path per file.

The databases are not all that lives there:

| In the data directory | What it is | Follows `DB_PATH` |
| --- | --- | --- |
| `luma-data.db` | the ledger | — |
| `luma-control.db` | users, sessions, and the credential vault | — |
| `documents/` | attached documents, one file per attachment (`services/documents.py`) | yes |
| `luma.log`, `luma.log.1` | the server's own log, read by Settings → **Error log** | yes |
| `luma-desktop.log` | startup output where there is no terminal — today, the macOS app started from Finder | no |
| `luma-desktop.lock` | the port of an instance the launcher (`backend/desktop.py`) started, so a second launch opens a tab on it | no |

Both databases run in WAL mode, so each also has `-wal` and `-shm` files beside it while the app is open;
committed data can still be sitting in the `-wal`, which is why a copy of a live database is taken with
SQLite's `.backup` rather than by copying the file. **The last column is the split `DB_PATH` makes.**
Attached documents and `luma.log` are placed beside the *data database*, so a per-file override takes them
with it; the launcher's two files are placed in `DATA_DIR` itself and stay there. On an install that
uses the override, the data directory and the database's directory are two different places, and only
the second holds the documents.

**Settings → Configuration is the authority on what is actually in force.** It reports every effective
value *and the layer it came from*, because an environment override is invisible from inside the app.
Read it before believing anything about a running instance — including which database it is open on.

**The layer order is `default < stored < environment`.** Environment wins so an operator can force a
value from outside; a broken stored setting would otherwise be unreachable. Only two values are stored
at all — the session signing secret and the session cookie name — and the panel's single write is to
**clear** one so its default applies again at the next start. Clearing is refused while an environment
override is in force, since the write would succeed and change nothing.

**The irreducible environment core** — needed before, or in order to find, the database, so there is
nowhere earlier to read them from:

| | |
| --- | --- |
| **Data location** | `DATA_DIR`, with `DB_PATH` / `CONTROL_DB_PATH` honored per file |
| **Ports** | `BACKEND_PORT`, `FRONTEND_PORT`, `FRONTEND_DOCKER_PORT`, `VITE_API_PROXY_TARGET` |
| **Launcher knobs** | `LUMA_USE_LOG_FILES`, `LUMA_BACKEND_READY_TIMEOUT` |
| **Deployment gates** | `SESSION_COOKIE_SECURE`, `LUMA_DEVELOPER_OPTIONS` |

**The per-file overrides are permanent, not a deprecation.** Fixing the default filenames is exactly
what makes them load-bearing: a database that does not use the default name is reachable *only* through them. Removing them would not force such an install
to rename anything; it would silently create empty databases beside data that still exists, which
presents as total data loss.

**Two installations on one host** is configured entirely from outside the app: a distinct directory and
a distinct port each. The cookie name follows the control-database path on its own, so the two do not
sign each other out.

**Give the second one an `APP_NAME`, or its passkeys are indistinguishable from the first's.** A device
keeps one passkey list per *host*, and the label in that list is all a user has to go on when deciding
which entry to keep — it is `username (AppName purpose)`, so two default-configured instances both read
`name (Luma vault)`. Nothing is at risk of being overwritten: the WebAuthn user handle derives from an
account id minted per control database, which is what an authenticator compares, so the collision is
cosmetic and shows up only when cleaning the list out. `APP_NAME` is a display setting with no effect on
where data lives (the data directory name is a fixed literal for exactly that reason), which makes it the
cheap discriminator: `APP_NAME=Luma Demo` turns the entries into `name (Luma Demo vault)`. The instance
identifier is deliberately not used — it is long, opaque, and tells the user nothing at the moment they
are choosing. `security-model.md` → *Do not couple them* covers the labelling rules themselves.

**A watched import folder is a directory on the server, not on the browser's machine.** A data source
may name one, and the path is resolved by the backend process — so on Desktop it is the user's own
machine and the distinction never arises, on a LAN server it is a folder on the server, and in a
container it has to be a **mounted volume** or it names nothing. "The folder on my computer" is the
natural reading and is wrong in two of the three topologies, which is why the in-app copy says so at the
point the path is typed. The folder is the operator's to choose and lives wherever they want it; it is
deliberately not inside the data directory, and nothing prunes it unless the source is set to.

A restored backup carries the paths of the machine it came from. Restoring onto a *different* instance
therefore switches every watched folder off while keeping its path visible, rather than letting the app
start reading a path that resolves here and means something else — see *Restore is a destructive
operation*.

**A packaged copy resolves its data directory from how it was distributed, not from its OS** — portable
keeps it beside the executable, installed uses the per-OS user-data directory. `releasing.md` covers
which artifact is which; `architecture.md` → *Packaged builds* covers the mechanism. The consequence
for an operator is only this: on a portable copy the folder *is* the installation, and moving it moves
the data.

## Restore is a destructive operation

**Verification precedes destruction.** The staged artifact is verified in a pass of its own before
anything is wiped; on the encrypted path that means decrypting to a temp file and checking the
authentication tag *before* the inner archive is opened, because nothing may act on unverified
plaintext.

**The table phase is one transaction, deliberately.** All-or-nothing is what makes a *failed* restore
leave the target completely untouched. A half-restored ledger is not a valid state, has no defined
recovery, and would undermine the compatibility guard.

**A restore rolls the resume point back with the rows.** Clearing `transactions_cursor` and
`initial_sync_complete` for every connection is not housekeeping — without it the next sync resumes
from a checkpoint *past* the rows the restore just removed, and those rows are never re-fetched. The
provider considers them delivered and nothing local knows to ask again. Per-account coverage rides the
data backup for the same reason, so the two halves of the same assertion move together.

**Files are not transactional, so the documents phase is resumable.** A restore that fails partway can
leave the database cleanly rolled back and the documents directory half-rewritten. A marker in the data
DB carries the operation across that gap, and an import or a sync refuses while it is set.

**The staged upload is released by whoever opened it, once its handle is closed.** The uploaded archive
is kept on disk past the ledger commit precisely so an interrupted documents phase has something to
resume from, and clearing the marker is what releases it — but the phase runs *inside* the caller's open
handle on that same file, so the delete belongs to the caller, after the close. Deleting it from inside
the phase is correct on POSIX and fails on Windows, which refuses to unlink a file any handle is holding,
the process's own included: the restore commits in full and then reports itself as a server error, which
is the worst possible way for it to be wrong. `test_restore_documents_phase.py` emulates the Windows rule
so a Linux run still catches it.

**The operator always retains a working admin login.** Where a restore includes identity data, the
current admin is preserved and the backup's accounts merged in, rather than the perimeter being
silently overwritten. Restoring requires admin in the first place — it is a destructive act somebody
has to be able to authorize. That covers every restore route, resuming an interrupted one, and changing
the backup keys; with sign-in protection off there is no role to check, and any session may.

**A restore covers one of the two databases, so its outcome depends on state it never touched.** The
regular backup is the *data* database; identities, the sign-in perimeter and the vault slots live in the
control database and are neither read nor written by it. The separation is deliberate — a data backup
shared between people or machines must not carry or overwrite a machine's security posture — but it
means restoring the same file **over an existing install** and **onto fresh databases** give different
end states: over an existing install the control DB survives, so sign-in protection stays exactly as it
was; onto fresh databases there is no control DB, so the instance comes up at first-run with sign-in
off. Nothing on the restore surface says so, which is the rough edge rather than the separation. The
concrete confusion it produces is a restore of a pre-perimeter backup that leaves sign-in still on —
**and the fix there is a flag flip, not a reinstall**: disabling sign-in protection is an admin-gated
setting (`disable_auth_mode()`), so deleting both databases to reach it is a far heavier workaround than
the situation needs.

**A manual copy needs `.backup`, not `cp`.** Both databases run in WAL mode, so copying the `.db` file
alone leaves behind anything committed but not yet checkpointed and yields a copy quietly missing recent
rows. Take it with `sqlite3 <source.db> ".backup <target.db>"`, which is correct against a running
instance; copying by hand means copying the `-wal` alongside the `.db`, with nothing writing meanwhile.
This applies to a snapshot taken for safety before a restore — the app's own backup is a row-level export
and is unaffected.

**Nothing checks the database being overwritten.** The backup's own integrity is verified; the target's
is not. See *Open*.

## Locked out/Lost password

**A forgotten password can be reset from a terminal window, by anyone who can reach the data directory.** Run the app
with `--reset-password`, optionally followed by a username:

| Topology | Command |
| --- | --- |
| Portable or installed (Windows, Linux) | `luma --reset-password` beside the executable |
| macOS app | `Luma.app/Contents/Resources/server/luma --reset-password` from Terminal |
| Development | `backend/venv/bin/python -m backend.desktop --reset-password` |
| Containers | `docker compose exec backend python -m backend.desktop --reset-password` |

The name of the control database is displayed. A list of account is displayed for the user to choose from and then the new password is entered. It is safe to run beside a running instance. The
account selected ends up as an active administrator with two-factor sign-in off and current browser sessions are signed out. The vault passphrase is untouched; why this needs no other credential is described in `security-model.md` →
*Identity and the network perimeter*.

## Diagnosing a running instance

What exists today, and what each actually tells you:

| Surface | Answers |
| --- | --- |
| `GET /api/health` | is a server listening and answering on this port |
| Settings → Configuration | every effective setting and the layer it came from |
| The data-location line in the navigation pane | which databases *this* copy is open on |
| The connection sync log (**Sync log** on Import / Export → Import → Data connections, or on a provider's card in Accounts → Connections) | what a data source did, and why a sync, connect or disconnect failed |
| `luma-desktop.log` | startup output where there is no terminal |
| `luma.log`, read by Settings → **Error log** | what went wrong in a running server, with tracebacks, in any topology |

**"Which database is this?" is a real question on a machine running more than one copy**, and nothing
else on screen distinguishes a checkout pointed at a restored backup from one pointed at real data. The
line reports the paths read from the modules that hold them, so it cannot name a file the process never
opened. It arms itself by default where the question is live — the databases are somewhere other than
this build's default, or this copy is a checkout, or developer options are on — and the paths are shown
only to a session that could read them in Settings anyway.

**Every open browser learns that the backend stopped, without polling.** A request to a port nothing is
listening on is refused immediately, so every call the app makes is already its own liveness check. One
failure is not proof — a graceful shutdown closes idle connections under requests that would retry fine
— so a failure probes `/api/health` and only a failure of *that* is reported. Route chunks are a third
source of the same news and easy to miss, since a lazily loaded page uses dynamic `import()` rather
than the api layer.

**The state latches, and coming back is a reload rather than an unlatching**, because every piece of
state on screen belongs to a process that no longer exists — a restart may be on a different port,
under a different session, against a different database.

**There is no integrity check of either database.** No health check, no startup check, and none before
a destructive restore. See *Open*.

---

## Considered and rejected

- **A native window (pywebview, Tauri, Electron).** The decision was made on passkeys, not on
  packaging. A vault passkey slot needs not just WebAuthn but the `prf` extension, which is a much
  narrower guarantee than WebAuthn itself; a launcher into the user's own browser is the only option
  whose engine is one they keep updated. It also avoids owning a webview dependency or a second heavy
  runtime. Losing the "real window" is the whole cost.
- **A universal2 macOS binary.** It needs universal2 wheels for two native dependencies that are not
  dependably published, and the failure is an obscure link error rather than a clear one. Two
  architecture-specific builds instead, at the cost of a "which one?" line in the README.
- **A onefile build inside a macOS `.app`.** It re-unpacks to a temporary directory on every launch —
  slow, and the same vanishing-path problem that rules out "beside the executable" on macOS.
- **pyobjc inside the Python process**, instead of a native wrapper. A large macOS-only dependency plus
  moving uvicorn off the main thread — where it sits precisely so Ctrl+C is clean — and it would fork
  the one launcher all three platforms share. The wrapper confines every macOS-specific concern to the
  macOS artifact.
- **A pinned CA bundle shipped in the artifact.** Certificate verification goes through the OS trust
  store instead. A shipped snapshot ages, ignores roots the user installed, and keeps trusting roots
  the OS has since distrusted.
- **A blanket request timeout in the api layer.** It catches a stalled connection rather than a refused
  one, and would need a carve-out for every legitimately long request — sync, import, backup, demo load
  — a list that breaks a feature whenever it is wrong.
- **Probing the repository to decide which license link to show.** One outbound request per render,
  contradicting the promise that the app reaches the network only for actions the user asked for.
- **Chunked commits during a restore.** No memory argument for it (an open SQLite write transaction
  spills to the WAL, which is disk), and it would give up the all-or-nothing property above.
- **`%APPDATA%` for the Windows user-data directory.** A roaming profile synchronises at logon and
  logoff, and a SQLite database diverged across two machines resolves last-writer-wins on a binary file
  — silent loss, not a visible conflict. `%LOCALAPPDATA%` instead.
- **Making `LUMA_USE_LOG_FILES` an in-app setting.** Its only consumer is the shell launcher, which
  reads it before Python starts; moving it into the database would mean teaching two launcher dialects
  to query SQLite in order to preserve a toggle that takes effect on the next restart anyway.
- **Making `LUMA_DEVELOPER_OPTIONS` a preference.** It is a *gate* on destructive tooling, not a user
  choice. The one legitimate in-app need that appeared was met by taking that read-only surface out
  from behind the gate, not by softening the gate.
- **Editing stored settings, rather than resetting them.** The only two stored values derive or
  generate themselves, so there is nothing worth typing; and everything here is consumed at startup, so
  a field that accepts input and changes nothing until a restart reads as broken.
- **A default `CORS_ORIGINS`.** Every shipped topology serves the app and the API on one origin, so the
  previous default was a standing credentialed grant bought for nothing. It survives as the escape
  hatch for a split-origin deployment.
- **Renaming or removing `LUMA_ENV_FILE`.** Nothing else defeats `load_dotenv(override=True)`, which is
  what the Playwright harness needs defeated to run against throwaway databases. Renaming it to
  something test-prefixed would misdescribe it: it selects an override file, and being test-only is a
  fact about its current caller rather than about the variable.
- **Offering `quick_check` alongside `integrity_check`, or backgrounding the check.** `quick_check`
  exists because the full check is slow on multi-gigabyte databases; at this scale it is around 100 ms.
  Run the real one.

## Obstacles

- **A `.app` bundle cannot hold its own writable data.** Writing inside a notarized bundle invalidates
  the signature, and App Translocation mounts a quarantined app at a randomized read-only path that
  disappears afterwards. This is why the distribution form, not the OS, decides where data lives — and
  why a portable macOS build is refused outright rather than merely discouraged.
- **A Python process cannot be a macOS application.** Declaring it a console app gives it no Dock icon
  and nothing to quit; declaring it a regular app makes LaunchServices wait for a window-server check-in
  that never comes, so the icon bounces for the length of the launch timeout and then offers only Force
  Quit. There is no setting between the two — hence the native wrapper.
- **The build environment is pinned below Python 3.14** because one pinned native dependency publishes
  no wheels for it, and the fallback is a source build that fails somewhere saying nothing about the
  real cause. Lifting the ceiling is a dependency-bump project that moves several pins at once, which
  changes the runtime under a live install. It is not a packaging change.
- **Gatekeeper cannot be exercised in CI.** A locally built bundle is never quarantined, so the refusal
  and the "Open Anyway" path do not occur at all. Only a browser-downloaded artifact carries the flag —
  and the quarantine survives unarchiving through Finder but **not** through `unzip`, so testing with
  the wrong tool tests nothing.
- **The familiar Gatekeeper gesture is wrong.** Control-click → Open no longer bypasses Gatekeeper for
  unsigned applications on macOS 15. Documenting it would produce exactly the outcome it is meant to
  avoid — a tester concluding the build is broken.
- **`integrity_check` does not check foreign keys.** They are separate passes, and a database can pass
  one with a table full of orphans. Any diagnostic worth having runs both.
- **A structural check answers "is the file corrupt", never "is the data coherent".** A cursor ahead of
  a restored ledger, a coverage claim disagreeing with the rows it covers, a mapping pointing at a
  merged account — all read as `ok`. A green diagnostic that implies more than it checked is worse than
  no diagnostic.
- **PyInstaller cannot cross-build**, so each platform's artifact must be produced on that platform.
  See `releasing.md`.

## Open

- **The LAN-server shape is notes, not an implementation.** No Caddyfile, no systemd unit, no
  documented install sequence. → [`backlog/deployment-topologies.md`](backlog/deployment-topologies.md)
- **An mDNS service name**, env-only alongside the ports. Not merely convenience: with HTTPS it is what
  makes passkeys reachable on a LAN at all. The plumbing is one `Setting(...)` row in
  `backend/app_config.py` with `stored=False`, after which it appears in the configuration report on its
  own; the open part is the **default name** when two installations share a network. No separate backlog
  item — this topic owns it.
- **Database diagnostics are not built.** The structural half is small and unambiguous — both pragmas
  against both databases, reported next to the connection sync log — but four things need deciding
  first: whether it is user-facing or developer-gated; what a failure tells someone to *do*, given a
  structural failure is not user-repairable; whether the pre-restore check refuses or warns-with-force;
  and whether anything periodic is wanted. A semantic **invariant checker** over the cases a structural
  check cannot see is a separate and much larger project — do not fold it in.
  → [`backlog/database-diagnostics.md`](backlog/database-diagnostics.md)
- **The macOS Dock lifecycle has never been verified end to end** — the icon appearing without a
  bounce, Quit and Command-Q shutting down cleanly *and* logging it, and the two death-watches in both
  directions. CI cannot reach any of it.
  → [`backlog/deployment-topologies.md`](backlog/deployment-topologies.md)
- **The release workflow has never run on a real tag.** No `v*` has been cut.
  → [`pre-release.md`](pre-release.md)
- **Windows and Linux installers** are out of scope; both platforms ship the portable kit. The Windows
  user-data directory is therefore unreachable in any released artifact — which stops being true the
  day an installer ships. → [`backlog/deployment-topologies.md`](backlog/deployment-topologies.md)
