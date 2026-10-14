# Running and operating Luma

How a copy of Luma is deployed, what it binds to, where it keeps its data, and what a running instance
offers for finding out what is wrong. **This is the maintainer's record**: what each way of running
relies on and why it is shaped that way, for whoever changes the launcher, the server setup, restore or
the logs.

**Setting a copy up is described elsewhere, for the person doing it.**

| Surface | Audience | What it holds |
| --- | --- | --- |
| `README.md` → *Installing Luma*, *Running Luma as a server*, *Locked out* | someone installing or running a copy | the downloads, the Docker sequence, the password reset command |
| Help → *Running Luma as a server*, *Configuration settings*, *Data on disk, and backups* | the same person, with the app open | the Linux and Windows server sequences, each setting, backup and restore |
| [`architecture.md`](architecture.md) → *Cross-platform approach* | someone changing the code | the launcher as built: the bind and the URL, the lockfile, opening a browser, stop signals, liveness, packaged-build roots |
| [`security-model.md`](security-model.md) → *Transport security* | someone changing the design | whether a topology may run over plain HTTP, and why the host name is load-bearing |
| [`releasing.md`](releasing.md) | whoever cuts a release | building the artifacts, and the packaging decisions |

Where one of the first two holds a step-by-step sequence, this document does not repeat it. It records
what the sequence depends on.

## Contents

- [The ways Luma is run](#the-ways-luma-is-run)
- [Desktop](#desktop)
- [Source checkout](#source-checkout)
- [Logs](#logs)
- [LAN server](#lan-server)
  - [Behind a proxy, or directly](#behind-a-proxy-or-directly)
  - [The proxy's certificate](#the-proxys-certificate)
  - [The proxy and the service](#the-proxy-and-the-service)
  - [On Windows](#on-windows)
  - [macOS](#macos)
- [Containers](#containers)
- [Where the data lives, and how the app decides](#where-the-data-lives-and-how-the-app-decides)
- [Restore is a destructive operation](#restore-is-a-destructive-operation)
- [Locked out](#locked-out)
- [Diagnosing a running instance](#diagnosing-a-running-instance)
- [Obstacles](#obstacles)
- [Open](#open)

---

## The ways Luma is run

| | Reached by | Serves the interface | Binds | Perimeter |
| --- | --- | --- | --- | --- |
| **Desktop** | one machine | the backend itself | loopback | usually off |
| **LAN server** | several devices | the backend, behind a TLS-terminating proxy or directly | loopback behind the proxy, or the network | on |
| **Containers** | several devices, on a Linux host | the backend, behind a proxy container | loopback on the host, behind the proxy | on |
| **Source checkout** | one machine, for working on Luma | a development server, with the backend behind it | loopback | usually off |

They are the **same application**. What differs is only how uvicorn is launched and whether something
wraps it.

**Standalone versus networked is detected per request, not configured.** The same install answers as
loopback from its own machine and as networked from another, so there is no stored mode to get wrong —
and no mode to set correctly either. Administration → *Network access* states the reading for the
browser in hand. See `security-model.md` → *Transport security*.

## Desktop

One process. `python -m backend.desktop` (or the packaged executable) serves the interface and the API
together and opens a browser at it — no second process, no proxy. `architecture.md` → *Cross-platform
approach* has the mechanism; what someone running it meets is this:

- **It binds `127.0.0.1` but hands out `http://localhost:<port>`, and the difference matters.** A
  WebAuthn Relying Party id must be a domain, so opening the address form silently disables every passkey
  vault slot with nothing on screen to explain why. Use the printed URL.
- **The port is `FRONTEND_PORT`, and it is preferred, not guaranteed.** The browser's port has that one
  name in every topology; here the single process *is* the frontend, so `BACKEND_PORT` — the internal hop
  behind Vite when running from source — is not read. A busy configured port falls back to an ephemeral one, and
  says so rather than doing it silently — a separately started `uvicorn` on the same databases is usually
  what that means. Nothing durable is keyed to the port: cookies are not port-scoped and an RP id is the
  host alone, so a passkey registered on one port still works on the next.
- **A second launch opens a tab, it does not start a second instance.** `luma-desktop.lock` in the data
  directory records the port. It records a port and not a claim of liveness — it survives a crash — so
  `/api/health` is what settles whether the recorded instance is actually there.
- **Opening the browser is a convenience; the printed URL is the contract.** No opener on any platform
  reports success usefully, so the outcome is never claimed. `--no-browser` skips the attempt.

**Stopping it.** *Shut down Luma* in the navigation panel, the Dock's Quit or Command-Q on macOS,
Ctrl+C, **closing the terminal a portable build was started from**, and a system shutdown all converge on
uvicorn's graceful path, so in-flight requests finish and the lockfile is released. **Windows is the
exception**: it has no SIGHUP, so closing a console window there is not a graceful stop. A second Ctrl+C
does not force a quit; a stop waits a bounded time for in-flight requests (`GRACEFUL_SHUTDOWN_SECONDS`)
and then closes them.

A stop during a long operation can therefore be cut short — by that bound, by the macOS wrapper, which
allows 20 seconds after SIGTERM before SIGKILL, or by whatever a supervisor's unit specifies. That costs
the in-flight transaction (rolled back) and can leave the lockfile behind, both of which the next launch
already handles. The in-app control is **registered by the launcher, and only as a desktop
application**, so neither server mode nor an instance started with plain uvicorn offers it: on a
supervised box, stopping the process from a browser is either futile or a way for one signed-in user to
take the service from everyone else.

## Source checkout

The arrangement for working on Luma, and the only one with two processes: a Vite development server on
`FRONTEND_PORT`, which is what the browser opens, and the backend on `BACKEND_PORT` behind it.
`CONTRIBUTING.md` → *Local development* has the setup and the start scripts. A checkout can also be run
as the single process *Desktop* describes (`python -m backend.desktop`, once the interface is built),
and then behaves as that section says.

Where a checkout started with the scripts differs from a downloaded build:

- **Ports.** `BACKEND_PORT` and `BACKEND_HOST` are read only here. The start scripts refuse a busy
  port, naming it, where a downloaded build moves to a free one.
- **Configuration.** `.env` is read from the top of the checkout. The start scripts and
  `vite.config.js` read it directly for their ports, so `LUMA_ENV_FILE` redirects the backend only.
- **Data.** The data directory defaults to the folder the backend is started from. A recorded database
  path that still names a real file is left alone, with a warning, where a packaged build adopts its
  configured location at every start (see *Where the data lives, and how the app decides*).
- **Logs.** The start line in `luma.log` omits the address, and `LUMA_USE_LOG_FILES` makes the start
  scripts save their terminals' output beside the scripts (see *Logs*).
- **Identifying it.** There is no build stamp, since the commit is a `git` command away, and the
  data-location line in the navigation pane is on by default (see *Diagnosing a running instance*).
- **Stopping it.** The in-app *Shut down Luma* is not offered, because the launcher is what registers
  it.
- **The built interface.** `frontend/dist` is a copy, made by `npm run build` in `frontend/`, and
  nothing refreshes it. It is what the single-process launcher serves (which refuses to start without
  one), what the backend serves when it is reached directly on `BACKEND_PORT`, and what a packaging run
  with `--skip-frontend` puts in the artifact. The development server does not read it: it serves the
  source as it is edited. So after a frontend change those three go on serving the old interface, with
  nothing to say so, until it is built again.
- **Containers.** `docker compose up -d --build` builds the image from the checkout (see *Containers*).
  The image builds its own interface from the source and never reads the checkout's `frontend/dist`,
  so a stale copy does not reach it.

**A checkout can serve a network, without the name.** The backend serves the built interface
(`frontend/dist`) on `BACKEND_PORT` as well as the API, and listens to its own machine unless
`BACKEND_HOST` widens it. Widened, it is the direct form described under *LAN server*, run from a
checkout: plain HTTP, the same refusals, and no advertised name, since that belongs to the launcher.
What it serves is the last *build* — it does not follow edits to the source the way the development
server does.

## Logs

**Where startup output goes.** An application started from Finder on macOS has no terminal, so both
streams are redirected to `luma-desktop.log` beside the data (`architecture.md` has how that is
detected). A Windows start with `--tray` has none either, by its own doing, and writes to the same file
(see *On Windows* under *LAN server*).

**The server also keeps its own log, in every topology.** `luma.log` beside the data database is a
*copy* of what the server logs (`backend/app_log_file.py`): a handler added next to uvicorn's rather
than a redirect, so the terminal, the systemd journal and `docker logs` keep everything they received
before. It rotates at 1 MB and keeps one previous file (`luma.log.1`).

- **What it holds:** warnings and errors, a crashed request's traceback included; a line each time the
  server starts; a line before and after each database compaction; the rare events that change what the
  installation is (a database created, a migration applied, the database location adopted after a
  move); and access lines for requests that failed.
- **What it leaves out:** successful requests, or routine polling would soon rotate a failure out of the
  file; and what a client can cause without signing in (a 401, a 404, uvicorn's warnings about malformed
  traffic), since on a networked install a flood of those would push genuine failures out the same way.
- **The start line names the version**, and wherever the launcher started the server, the address that
  launch settled on — a busy configured port falls back to an ephemeral one, and nothing else records
  which one a given run ended up on. Running from source omits the address rather than guess at it: the
  browser is on the frontend's port with this server as an internal hop behind it.
- **What it cannot hold** is anything before the application starts, such as a missing dependency or a
  crash during import: that stays in the output alone, which on macOS means `luma-desktop.log`. A start
  that fails later, in the application's own startup (a migration raising), is held — the log is set up
  before the data database is readied.
- **Administration → Error log reads the errors back out of it**, for administrators only, since a
  traceback can carry transaction details and paths. Each message and traceback it shows is cut at a
  fixed length, and the file keeps the rest.

`LUMA_USE_LOG_FILES` is a different thing: it makes the start scripts save their terminals' output
beside the scripts.

**Errors raise a task for administrators.** Each error the file keeps is also counted into the control
database as it is logged, and the Tasks page shows how many no administrator has seen yet, to exactly the
people who can open the Error log. Opening it acknowledges them for the whole install. The count is kept
rather than re-read from the file because the file rotates, which would take an unseen error with it; so
nothing scans the log at startup. An error is a failure someone should look at — a crashed request, or a
step that failed after the work around it had succeeded — and a warning is something the server coped
with, which stays in the file and raises nothing.

## LAN server

**The same downloaded build as Desktop, started in server mode** — `SERVER_MODE=true` in `.env`, or
`luma --server`. The command line wins over the file in both directions (`--no-server`), and the file is
the only form that reaches a macOS app started from Finder. It is a way of starting the process, not a
stored topology: how a request is judged is still detected per request.

Server mode takes away what assumed a person at the machine:

- **No browser is opened**, and the in-app *Shut down* is not offered.
- **The port is fixed.** Whatever reaches the server is configured with `FRONTEND_PORT`, so a busy one
  refuses the start where Desktop would move to a free one — an instance on another port would be
  running and unreachable.
- **A second launch fails** with a nonzero status rather than joining the first, so a supervisor sees it.
- **It answers for a name on the local network** — `MDNS_NAME`, without the `.local` ending — so a
  device reaches `https://<name>.local` without knowing which
  machine the server is on. The proxy's site address has to be that same name, since its certificate is
  issued for it. A name another machine already answers for refuses the start, which is how two
  installations on one network are kept apart: give the second its own `MDNS_NAME`. The address
  advertised is the one this machine reaches the local network from, read at startup.

### Behind a proxy, or directly

**It reaches the network one of two ways, and the bind address says which.**

| | Behind a proxy | Directly |
| --- | --- | --- |
| `FRONTEND_HOST` | unset — the process stays on `127.0.0.1` | `0.0.0.0`, or one address of the machine |
| Other devices open | `https://<name>.local` | `http://<name>.local:<port>` |
| On the wire | TLS, terminated by the proxy | cleartext |
| Passkeys | available | not available — a browser will not run one over HTTP |
| Connecting a data source, saving or revealing a provider secret | from any device | from a browser on the server only |
| Extra setup | the proxy, and its certificate trusted on each device | none |

The second column is a real configuration, not a degraded one: it is the least setup there is, and for
a ledger fed by imported files on a network its owner trusts it gives up little. What it gives up is
enforced and explained by the app as it is met — `security-model.md` → *Transport security* has the
rule and the reasoning — so nothing here has to be remembered at install time. Desktop is never on the
network: outside server mode the address setting is not read. A start that is given a widening
address it will not use — `FRONTEND_HOST` outside server mode, or `BACKEND_HOST`, which belongs to a
source checkout's scripts — says so on the console, since it would otherwise start normally and simply
not answer on the network.

**An mDNS name and HTTPS are a pair, not two conveniences.** A LAN address like `192.168.x.x` can never
host passkeys however it is served, and a name without HTTPS still fails WebAuthn's secure-context
requirement. Neither alone makes passkeys reachable over the LAN.

### The proxy's certificate

**Each device has to trust the proxy's certificate once, and the server hands it out.** Caddy issues
the server's certificate from an authority of its own, which no device trusts until its root is
installed there. The server fetches that root from Caddy's admin API on the same machine and offers it
at `/api/app/proxy-certificate/download`, before sign-in, since a device needs it before a password can
safely be typed. The fingerprint is for the first visit only — the one time the certificate arrives over
a connection nothing vouches for — and the place to read it without going through that connection is
the server's own console:

```sh
luma --certificate-fingerprint
```

It prints the SHA-256 fingerprint and the SHA-1 one, because the Windows certificate viewer shows only
the latter, as *Thumbprint*. Administration → **Server certificate** also takes a fingerprint read off
another device and says whether it is this certificate's; that check is offered there and not on the
sign-in screen, since only a page reached over an already-trusted connection can be believed about it.

The server remembers the first fingerprint it sees. Caddy mints a new authority if its data directory is
lost, and a fingerprint that no longer matches is how that is told apart from an attack or a
misconfiguration: every device needs the new certificate, and an administrator accepts the change — raised as a task
that stands until they do. In the interface this is one panel in two places: a link on the sign-in
screen, for a device that trusts nothing yet, and Administration → **Server certificate**, which also
carries the acceptance. Neither appears on an installation with no proxy certificate to hand out.

### The proxy and the service

**The sequences are not repeated here.** Help → *Running Luma as a server* has the Linux one and the
Windows one, and the README has the Docker one. What follows is what they depend on.

**On Linux, the proxy's site file and the supervisor's unit are printed by the build itself**
(`--caddyfile`, `--systemd-unit`), from its own configuration, because two things in them have to agree
with it exactly: the proxy issues its certificate for the name in its site file, which has to be the
name the server advertises, and the unit names an executable and a user. So a change to `MDNS_NAME` or
`FRONTEND_PORT` means printing the site file again, and moving the folder means printing the unit again.
`--systemd-unit` refuses to run under `sudo`, since the unit would name root and the databases would be
created as root's. `SESSION_COOKIE_SECURE=true` is set by hand in `.env` and deliberately not derived
from anything. A firewall on the server has to
admit TCP 443 for the proxy and UDP 5353 for the name, and the address a start settled on is in
`journalctl -u luma`, which carries the same line a terminal start prints.

What the two files rely on, for a proxy or supervisor other than these:

- **The proxy terminates TLS and passes every request to the port.** It serves no files: the process
  serves the interface as well as the API.
- **The proxy states the scheme and the client address** (`X-Forwarded-Proto`, `X-Forwarded-For`), which
  Caddy does unasked. uvicorn honors them from a loopback peer only, which is where the proxy is;
  without them `request.url.scheme` reports the internal HTTP hop and every HTTPS-conditional behavior
  reads the deployment as cleartext.
- **The supervisor stops the process with SIGTERM**, which is a graceful stop (see *Stopping it*), and
  restarts it on failure. A start that is refused — a busy port, a name another machine answers for —
  exits nonzero with the reason in the journal, and is retried.
- **The unit passes `--server`**, so the service is a server whatever `.env` says.
- **SQLite is adequate at household concurrency.** No database change is needed for this shape.

**A proxy kept beside the executable is run by the server.** Where a `caddy` executable (`caddy.exe` on
Windows) sits in the folder the build was unpacked into, a server behind a proxy starts it, hands it
the site file `--caddyfile` would print, and stops it on the way out (`backend/managed_proxy.py`) — one
program to start instead of two, and no site file to keep in step. Placing it there is the whole
opt-in: a proxy installed for the machine is never looked for, so the Linux arrangement above is
unaffected. One already answering on the proxy's admin port is used as it is, neither joined by a second
nor stopped at exit. What the proxy reports goes to `proxy.log` beside the data, rewritten at each start,
and a proxy that does not come up refuses the start with that file named. The proxy is told not to
install its root certificate into the server machine's own trust store, which it otherwise asks about
at every start; the server's browser gets it from the hand-out like any other device. On Linux this
needs the proxy able to open ports 80 and 443 as the user the server runs as, which an unprivileged
user cannot by default — the packaged proxy under systemd is the arrangement there for that reason.

### On Windows

The executable is a console program, because the recovery and setup
commands need somewhere to print, so a server started from a shortcut is a console window that stops
the server when it is closed. `--tray` is the way round that: the command starts itself again with no
console and exits. A window that was opened for it closes; a command prompt it was typed into gets its
prompt back and stays open. The server is then seen and controlled through an icon in the notification
area: the address other devices use, *Open*, *Stop* and *Exit*. *Stop* is the same graceful stop as
everywhere else and leaves the icon in place offering *Start*, since at a sign-in start there is nowhere
else to start it again from. *Start* is a new process, exactly as a sign-in gives, so nothing held in
memory — an unlocked vault above all — survives a stop. *Exit* ends the process, which is what
replacing the executable needs. A start and a stop each take some seconds — a packaged build unpacks
itself first, and a stop waits for open connections — so the icon is up before the slow part of a start
and says which of the two is under way. Its output goes to `luma-desktop.log` beside the data, and a start that fails
says so in a dialog naming that file, since nothing else would show it.

`luma --start-at-sign-in` adds this installation to the programs Windows starts for the current user
(`--server --tray`), with no administrator rights and no stored password, and Windows lists it under
*Startup apps*; `luma --no-start-at-sign-in` removes it. The proxy is a `caddy.exe` beside `luma.exe`,
run as described above. Windows asks about the firewall the first time each program runs — once for the
proxy, which other devices connect to on TCP 80 and 443, and once for the server, which answers for its
name on UDP 5353. It classes a network as public until told otherwise, a home one included, and devices
on a network classed that way are kept out by a private-only answer.

**The sign-in entry records where the executable is, under the installation's name.** Replacing
`luma.exe` in place — an upgrade, after *Exit* — leaves it correct. A copy unpacked or moved somewhere else does not:
the entry goes on starting the old location, which for a portable build is also the old location's
data, until `luma --start-at-sign-in` is run again from the new one. That replaces the entry; nothing
has to be removed first. The entry is named for `APP_NAME`, so a change of name leaves the old entry
behind unless it was removed beforehand.

**Two servers behind a proxy on one machine is not supported.** Sharing one proxy between them is
possible but adds complexity, and there is no known need for it. Two *desktop* installations on one
machine are supported.

A server started this way runs while that user is signed in. **Starting at boot instead, with nobody
signed in, is a scheduled task** and not something the build sets up; Help → *Running Luma as a server*
has its settings. Such a task has no desktop, so it takes no `--tray`; its start line is in `luma.log`,
and ending the task is not a graceful stop, which costs what any cut-short stop does (see *Stopping
it*).

### macOS

macOS can be the server as well — the mode, the name and Caddy are the same there — but the proxy and
starting at boot are left to the operator.

## Containers

`docker-compose.yml` runs the LAN server above with its two programs in containers: the application,
started in server mode from an image that carries the built interface, and Caddy in front of it for
HTTPS. **Both use the host's network, and everything else follows from that.** The application listens
on the host's loopback, where the proxy reaches it; a browser on the host is a loopback client; the
name is advertised at the host's own address; and the proxy's root certificate is fetched from its admin
API on `localhost`. Nothing in the application knows it is in a container, so the *LAN server* section
describes this shape too — the certificate hand-out, the fingerprint, what the proxy has to state.

A third service runs first and exits: it writes the proxy's site file with `--caddyfile`, so the name
the proxy certifies is the name the application advertises without either being typed twice. `.env`
beside `docker-compose.yml` is honored when present and not required, and `SESSION_COOKIE_SECURE=true`
belongs in it as it does for any server behind a proxy.

**The compose file is the whole installation kit.** It names the image published for each release
(`releasing.md` → *The container image*), so a folder holding that one file is enough and no checkout is
involved; the README has the sequence.

```sh
docker compose up -d
docker compose logs app
docker compose exec app python -m backend.desktop --certificate-fingerprint
```

The second line carries the address, and the third is the console reading of the fingerprint. After a
change to `MDNS_NAME` or `FRONTEND_PORT`, `docker compose up -d` again rewrites the site file and
restarts the proxy on it. The host's firewall has to admit the same two ports as any LAN server, and
ports 80 and 443 have to be free for the proxy. `docker compose pull` fetches a newer release, which the
next `up -d` starts.

**A checkout builds its own image with `--build`.** The file carries `build: .` beside the image name,
so `docker compose up -d --build` at the top of a checkout runs the source that is there. Without the
flag a checkout pulls the published image like any other folder.

**Where it keeps things.** The databases are in `./data` on the host, bind-mounted as the data
directory, so backing up that directory is backing up the installation; the files in it belong to root,
which is who the container runs as. The proxy's certificate authority is in the `proxy-data` volume.
`docker compose down` keeps it and `docker compose down -v` deletes it, after which the proxy mints a
new authority and every device needs the new certificate.

**An image is built from the top of a checkout, which is also where a developer's databases and
`.env` sit.** `.dockerignore` names what the build may read and excludes everything else, so neither
can reach an image, published or local.

**It is for a Linux host.** Under Docker Desktop on Windows and macOS the host's network is that of a
virtual machine, so neither the advertised name nor another device's address arrives where the
containers are.

## Where the data lives, and how the app decides

**One directory, fixed filenames.** `DATA_DIR` holds both databases. The two always travel together, so
a second installation wants a second directory rather than a path per file.

The databases are not all that lives there:

| In the data directory | What it is | Follows `DB_PATH` |
| --- | --- | --- |
| `luma-data.db` | the ledger | — |
| `luma-control.db` | users, sessions, and the credential vault | — |
| `documents/` | attached documents, one file per attachment (`services/documents.py`) | yes |
| `luma.log`, `luma.log.1` | the server's own log, read by Administration → **Error log** | yes |
| `luma-desktop.log` | startup output where there is no terminal — today, the macOS app started from Finder | no |
| `luma-desktop.lock` | the port of an instance the launcher (`backend/desktop.py`) started, so a second launch opens a tab on it | no |

Both databases run in WAL mode, so each also has `-wal` and `-shm` files beside it while the app is open.
**The last column is the split `DB_PATH` makes.**
Attached documents and `luma.log` are placed beside the *data database*, so a per-file override takes them
with it; the launcher's two files are placed in `DATA_DIR` itself and stay there. On an install that
uses the override, the data directory and the database's directory are two different places, and only
the second holds the documents.

**A manual copy needs `.backup`, not `cp`.** Both databases run in WAL mode, so copying the `.db` file
alone leaves behind anything committed but not yet checkpointed and yields a copy quietly missing recent
rows. Take it with `sqlite3 <source.db> ".backup <target.db>"`, which is correct against a running
instance; copying by hand means copying the `-wal` alongside the `.db`, with nothing writing meanwhile.
This applies to a snapshot taken for safety before a restore — the app's own backup is a row-level export
and is unaffected.

**Administration → Startup configuration is the authority on what is actually in force.** It reports every effective
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
| **Ports and addresses** | `BACKEND_PORT`, `BACKEND_HOST`, `FRONTEND_PORT`, `FRONTEND_HOST`, `VITE_API_PROXY_TARGET` |
| **Launcher knobs** | `SERVER_MODE`, `MDNS_NAME`, `LUMA_USE_LOG_FILES`, `LUMA_BACKEND_READY_TIMEOUT` |
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
natural reading and is wrong on a LAN server and in a container, which is why the in-app copy says so at the
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

**The control database records where the financial database is, and startup keeps that record true.**
Requests are routed by the record while startup readies the configured database, so the two must not
disagree — and they would after a portable folder is moved, renamed or copied, or a control database is
carried to another installation. A packaged build therefore adopts its configured location at every
start. A source checkout does the same when the recorded file is gone, but leaves a recorded path that
still names a real file alone and logs a warning naming both, since switching would put an installation
that has been running on the recorded database onto an empty one; `DB_PATH` is how to say which is
meant.

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
the backup keys. Creating a backup is held to the same gate so the server agrees with the Administration
page that offers it. With sign-in protection off there is no role to check, and any session may.

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

**Nothing checks the database being overwritten.** The backup's own integrity is verified; the target's
is not. See *Open*.

## Locked out

**A forgotten password is reset from a terminal, by anyone who can reach the data directory**: the
launcher run with `--reset-password`, optionally followed by a username (`backend/account_recovery.py`).
The README → *Locked out* has the command for each kind of installation.

It names the control database before changing anything, lists the accounts to choose from, and is safe
to run beside a running instance. The account selected ends up as an active administrator with
two-factor sign-in off, and current browser sessions are signed out. The vault passphrase is untouched;
why this needs no other credential is described in `security-model.md` → *Identity and the network
perimeter*.

## Diagnosing a running instance

What exists today, and what each actually tells you:

| Surface | Answers |
| --- | --- |
| `GET /api/health` | is a server listening and answering on this port |
| Administration → Startup configuration | every effective setting and the layer it came from |
| The data-location line in the navigation pane | which databases *this* copy is open on |
| Settings → About | the version, and for a packaged build the commit it was built from |
| The connection sync log (**Sync log** on Import → Connections, for everything or on one provider's card) | what a data source did, and why a sync, connect or disconnect failed |
| `luma-desktop.log` | startup output where there is no terminal |
| `luma.log`, read by Administration → **Error log** | what went wrong in a running server, with tracebacks, in any topology |

**"Which database is this?" is a real question on a machine running more than one copy**, and nothing
else on screen distinguishes a checkout pointed at a restored backup from one pointed at real data. The
data-location line is shown by default where the question is live, and only to a session that could
read the paths in Settings anyway.

**"Which build is this?" is the other question a report has to answer**, and the version does not: it
is set by hand at release time, so every build made between two releases claims the same one. The
**Build** row in Settings → About names the commit instead, and both log files repeat it on their
startup line, so a report that arrives as a log answers it too. A copy run from source has no such row:
its commit is a `git` command away. See `releasing.md` → *What identifies a build*.

**A browser left open is told when the server stops**, and reloads when it is back, since everything on
screen belonged to a process that no longer exists. `architecture.md` → *Cross-platform approach* has
how that is detected without polling.

**There is no integrity check of either database.** No health check, no startup check, and none before
a destructive restore. See *Open*.

---

## Obstacles

- **`integrity_check` does not check foreign keys.** They are separate passes, and a database can pass
  one with a table full of orphans. Any diagnostic worth having runs both.
- **A structural check answers "is the file corrupt", never "is the data coherent".** A cursor ahead of
  a restored ledger, a coverage claim disagreeing with the rows it covers, a mapping pointing at a
  merged account — all read as `ok`. A green diagnostic that implies more than it checked is worse than
  no diagnostic.

## Open

- **The advertised address does not follow the machine.** It is read once at startup, so a server whose
  address changes while it runs goes on answering with the old one until it is restarted.
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
