# Running and operating Luma

How a copy of Luma is deployed, what it binds to, where it keeps its data, and what a running instance
offers for finding out what is wrong. **This is the maintainer's record**: what each way of running
relies on and why it is shaped that way, for whoever changes the launcher, the server setup, restore or
the logs.

**Setting a copy up is described elsewhere, for the person doing it.**

| Surface | What it holds |
| --- | --- |
| `README.md` → *Installing Luma*, *Running Luma as a server*, *Locked out* | the downloads, the Docker sequence, the password reset command |
| Help → *Running Luma as a server*, *Configuration settings*, *Backup / Restore*, *Database maintenance* | the Linux and Windows server sequences, each setting, backup and restore, the database check |
| [`architecture.md`](architecture.md) → *Cross-platform approach* | the launcher as built: the bind and the URL, the lockfile, opening a browser, stopping, liveness, packaged-build roots |
| [`security-model.md`](security-model.md) → *Transport security* | whether a topology may run over plain HTTP, and why the host name is load-bearing |
| [`releasing.md`](releasing.md) | building the artifacts, and the packaging decisions |

This document does not repeat a sequence any of those hold. It records what the sequence depends on.

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
- [Watched folders on a server](#watched-folders-on-a-server)
- [Where the data lives, and how the app decides](#where-the-data-lives-and-how-the-app-decides)
- [Restore is a destructive operation](#restore-is-a-destructive-operation)
- [Locked out](#locked-out)
- [Diagnosing a running instance](#diagnosing-a-running-instance)
  - [Checking the databases](#checking-the-databases)
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
wraps it. Standalone versus networked is not one of the differences: it is detected per request
(`security-model.md` → *Transport security*), and Settings → *Security checklist* compares the
result with the recommended practices (`security-model.md` → *Best practices*).

## Desktop

One process. `python -m backend.desktop` (or the packaged executable) serves the interface and the API
together and opens a browser at it. The bind, the port, the lockfile and the browser are in
`architecture.md` → *Standalone and server mode*; the one rule an operator meets from them is to use
the printed `localhost` URL, never the `127.0.0.1` form, or every passkey is silently unavailable.

**Stopping it.** Every way of stopping — *Shut down Luma*, the Dock's Quit, Ctrl+C, closing the terminal,
a system shutdown — converges on uvicorn's graceful path (`architecture.md` → *Stopping*). **Windows is
the exception**: it has no SIGHUP, so closing a console window there is not a graceful stop.

A graceful stop waits a bounded time for in-flight requests (`GRACEFUL_SHUTDOWN_SECONDS` in
`backend/desktop.py`) and then closes them. A stop can also be cut short by the macOS wrapper, which
allows 20 seconds after SIGTERM before SIGKILL, or by a supervisor's own timeout. **A cut-short stop
costs the in-flight transaction (rolled back) and can leave the lockfile behind**, both of which the next
launch already handles.

## Source checkout

The arrangement for working on Luma, and the only one with two processes: a Vite development server on
`FRONTEND_PORT`, which is what the browser opens, and the backend on `BACKEND_PORT` behind it.
`CONTRIBUTING.md` → *Local development* has the setup and the start scripts. A checkout can also be run
as the single process *Desktop* describes, and then behaves as that section says.

Where a checkout started with the scripts differs from a downloaded build:

- **Ports.** `BACKEND_PORT` and `BACKEND_HOST` are read only here. The start scripts refuse a busy
  port, naming it, where a downloaded build moves to a free one.
- **Configuration.** `.env` is read from the top of the checkout. The start scripts and
  `vite.config.js` read it directly for their ports, so `LUMA_ENV_FILE` redirects the backend only.
- **Data.** The data directory defaults to the folder the backend is started from, and a recorded
  database path is not adopted as a packaged build adopts it (*Where the data lives, and how the app
  decides*).
- **Identifying it.** There is no build stamp, and the data-location line in the navigation pane is on
  by default (*Diagnosing a running instance*).
- **Stopping it.** The in-app *Shut down Luma* is not offered, because the launcher is what registers
  it.
- **The built interface.** `frontend/dist` is a copy that nothing refreshes. It is what the
  single-process launcher serves, what the backend serves on `BACKEND_PORT`, and what a packaging run
  with `--skip-frontend` puts in the artifact; only the development server follows the source.

**A checkout can serve a network, without the name.** Given a wider `BACKEND_HOST`, the backend is the
direct form described under *LAN server*, run from a checkout: plain HTTP, the same refusals, and no
advertised name, since that belongs to the launcher.

## Logs

**Where startup output goes.** An application started from Finder on macOS has no terminal, and a
Windows start with `--tray` gives its console up, so both redirect their output to `luma-desktop.log`
beside the data. Everywhere else it goes to the terminal, the systemd journal or `docker logs`.

**The server also keeps its own log, in every topology.** `luma.log` beside the data database is a
*copy* of what the server logs, not a redirect, so whatever was receiving the output still does.
`backend/app_log_file.py` has what it keeps, what it leaves out, and why. The start line names the
version, the build and, where the launcher started the server, the address it settled on, which nothing
else records.

**Settings → Error log reads the errors back out of it**, for administrators only, since a
traceback can carry transaction details and paths. Each error is also counted into the control database
as it is logged, so the Tasks page can show administrators how many none of them has seen; opening the
Error log acknowledges them for the whole install. The count is kept rather than re-read because the
file rotates.

`LUMA_USE_LOG_FILES` is unrelated: it makes the start scripts save their terminals' output beside the
scripts.

## LAN server

**The same downloaded build as Desktop, started in server mode** — `SERVER_MODE=true` in `.env`, or
`luma --server`. The command line wins over the file in both directions (`--no-server`), and the file is
the only form that reaches a macOS app started from Finder.

Server mode takes away what assumed a person at the machine:

- **No browser is opened**, and the in-app *Shut down* is not offered: on a supervised box, stopping the
  process from a browser is either futile or a way for one user to take the service from everyone.
- **The port is fixed.** Whatever reaches the server is configured with `FRONTEND_PORT`, so a busy one
  refuses the start where Desktop would move to a free one.
- **A second launch fails** with a nonzero status rather than joining the first, so a supervisor sees it.
- **It answers for a name on the local network** — `MDNS_NAME`, without the `.local` ending
  (`backend/mdns.py`). The proxy's site address has to be that same name, since its certificate is
  issued for it. A name another machine already answers for refuses the start, so a second
  installation on the network needs its own `MDNS_NAME`. **The address advertised is read once, at
  startup**: a server whose address changes while it runs has to be restarted to advertise the new one.
- **Sign-in protection stays optional.** Server mode does not require it. Settings → *Security
  checklist* shows whether other devices can reach the installation and whether sign-in is on.

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

Both are supported configurations; what the direct form gives up, and why only that, is in
`security-model.md` → *Transport security*. Desktop is never on the network: outside server mode the
address setting is not read. A start given a widening address it will not use — `FRONTEND_HOST` outside
server mode, or `BACKEND_HOST` — says so on the console, since it would otherwise start normally and
simply not answer on the network.

### The proxy's certificate

**Each device has to trust the proxy's certificate once, and the server hands it out.** The server
fetches the root of the proxy's own authority from Caddy's admin API on the same machine and offers it
at `/api/app/proxy-certificate/download`, before sign-in, since a device needs it before a password can
safely be typed. `backend/services/proxy_certificate.py` has why a fingerprint matters on the first
visit only.

- **`luma --certificate-fingerprint` is the reading that does not pass through the browser.** It prints
  the SHA-256 fingerprint and the SHA-1 one, because the Windows certificate viewer shows only the
  latter, as *Thumbprint*.
- **Comparing a fingerprint is offered in Settings → Server certificate, not on the sign-in
  screen**, since only a page reached over an already-trusted connection can be believed about it. The
  sign-in screen links to the hand-out only.
- **The server remembers the first fingerprint it sees.** Caddy mints a new authority if its data
  directory is lost; a changed fingerprint then raises a task that stands until an administrator accepts
  the change, and every device needs the new certificate.

**The certificate comes from the proxy's own authority because a `.local` name cannot have a publicly
trusted one.** Caddy issues from its own authority for such a name with no configuration; the cost is
trusting its root once on each device. A name in the network's own DNS does not avoid that step, since it
cannot get a public certificate either, and it must not end in `.local`. A publicly registered domain
with a DNS-challenge certificate does avoid it, and needs only a different Caddyfile.

Neither surface appears on an installation with no proxy certificate to hand out.

### The proxy and the service

**On Linux, the proxy's site file and the supervisor's unit are printed by the build itself**
(`--caddyfile`, `--systemd-unit`; `backend/server_setup.py` has why). So a change to `MDNS_NAME` or
`FRONTEND_PORT` means printing the site file again, and moving the folder means printing the unit
again. The session cookie is marked `Secure` whenever it is set over HTTPS, so nothing has to be set for
it. A name the server is reached by other than its `.local` one, an IP address or a single label (a
router's `.lan` name, an owned domain) has to be listed in `ALLOWED_HOSTS`, or requests to it are refused.

What the two files rely on, for a proxy or supervisor other than these:

- **The proxy terminates TLS and passes every request to the port**, keeping the `Host` the browser sent,
  which the host check reads. It serves no files: the process serves the interface as well as the API.
- **The proxy states the scheme and the client address** (`X-Forwarded-Proto`, `X-Forwarded-For`), which
  Caddy does unasked. uvicorn honors them from a loopback peer only, which is where the proxy is;
  without them `request.url.scheme` reports the internal HTTP hop and every HTTPS-conditional behavior
  reads the deployment as cleartext.
- **The supervisor stops the process with SIGTERM**, which is a graceful stop, and restarts it on
  failure. A refused start — a busy port, a name another machine answers for — exits nonzero with the
  reason in the journal, and is retried.
- **The unit passes `--server`**, so the service is a server whatever `.env` says.
- **The unit runs as `User=` the account that printed it** (`getpass.getuser()`), which is why the
  install steps are run as the user the server should run as. That account owns what the server can
  read and write, the data directory and any watched folder included; editing `User=` and reloading the
  unit changes it, and the data directory has to follow.
- **SQLite is adequate at household concurrency.** No database change is needed for this shape.

**A proxy kept beside the executable is run by the server** (`backend/managed_proxy.py`). Placing a
`caddy` executable in the folder the build was unpacked into is the whole opt-in; a proxy installed for
the machine is never looked for, so the Linux arrangement above is unaffected. What the proxy reports
goes to `proxy.log` beside the data, and a proxy that does not come up refuses the start with that file
named. On Linux this needs the proxy able to open ports 80 and 443 as the server's user, which an
unprivileged user cannot by default — so there the packaged proxy under systemd is the arrangement.

### On Windows

**The executable is a console program**, because the recovery and setup commands need somewhere to
print, so a server started from a shortcut is a console window, and closing it is not a graceful stop.
`--tray` starts the server again with no console and puts it behind a notification-area icon
(`backend/tray.py`). Its *Stop* is graceful and *Start* is a new process, so nothing held in memory — an
unlocked vault above all — survives a stop; *Exit* ends the process, which is what replacing the
executable needs.

**`luma --start-at-sign-in` adds an entry that runs `--server --tray` when this user signs in**, with no
administrator rights and no stored password. The entry records where the executable is, so:

- replacing `luma.exe` in place leaves it correct;
- a copy unpacked or moved elsewhere goes on starting the old location — for a portable build, also the
  old location's data — until `--start-at-sign-in` is run again from the new one, which replaces the
  entry;
- the entry is named for `APP_NAME`, so a change of name leaves the old entry behind unless
  `--no-start-at-sign-in` removed it first.

The proxy is a `caddy.exe` beside `luma.exe`, run as described above.

**Two servers behind a proxy on one machine is not supported**; two *desktop* installations on one
machine are.

**Starting at boot, with nobody signed in, is a scheduled task** that the build does not set up (Help →
*Running Luma as a server* has its settings). It has no desktop, so it takes no `--tray`, and ending the
task is not a graceful stop.

### macOS

macOS can be the server as well — the mode, the name and Caddy are the same there — but the proxy and
starting at boot are left to the operator.

## Containers

`docker-compose.yml` runs the LAN server above with its two programs in containers: the application in
server mode, and Caddy in front of it. **Both use the host's network, and everything else follows from
that.** The application listens on the host's loopback, where the proxy reaches it; a browser on the host
is a loopback client; the name is advertised at the host's own address; and the proxy's root certificate
is fetched from its admin API on `localhost`. The application behaves exactly as it does outside a
container, so the *LAN server* section describes this shape too; the image's `RUNNING_IN_CONTAINER`
is read only to say so in Settings → About → **Copy details**.

- **A third service runs first and exits**, writing the proxy's site file with `--caddyfile`, so the
  name the proxy certifies is the name the application advertises without either being typed twice.
  `up -d` after a change to `MDNS_NAME` or `FRONTEND_PORT` rewrites it and restarts the proxy.
- **The compose file is the whole installation kit.** It names the image published for each release
  (`releasing.md` → *The container image*), so a folder holding that one file is enough.
- **The databases are in `./data` on the host**, bind-mounted as the data directory and owned by root,
  which is who the container runs as. **The proxy's certificate authority is in the `proxy-data`
  volume**: `docker compose down -v` deletes it, after which every device needs the new certificate.
- **`.dockerignore` names what an image build may read and excludes everything else**, because the top
  of a checkout, which is the build context, also holds a developer's databases and `.env`.
- **It is for a Linux host.** Under Docker Desktop on Windows and macOS the host's network is that of a
  virtual machine, so neither the advertised name nor another device's address arrives where the
  containers are.

## Watched folders on a server

A data source may watch a folder on the machine running Luma, which is the one place the app reads or
deletes outside its data directory (`security-model.md` → *Reading and deleting outside the data
directory*). **An installation other devices can reach watches only inside its own `imports` folder and
the folders named in `WATCH_FOLDER_ROOTS`.** An administrator in the app need not be anyone with a shell
on the machine, and `.env` is reached only by someone who is, so that is where filesystem reach beyond
the app's own data is granted. An installation only this computer can open watches anywhere unless the
setting is given, in which case it is confined the same way.

- **`imports/` sits beside the data database**, as `documents/` does, and is created when the server
  starts. It is always allowed, whatever `WATCH_FOLDER_ROOTS` says, and the picker starts there. It is
  added to the named folders rather than being the setting's default value: as a default it would
  confine an installation only this computer can open, which otherwise watches anywhere, and naming a
  folder on a server would drop it. It is not part of a backup, and a restore leaves it alone.

- **Several roots are separated by the system's path separator** (`:` on Linux, `;` on Windows). A folder
  is inside a root when its resolved path is, so a symbolic link inside a root that leads elsewhere is
  outside it.
- **The setting confines every way in**: the path a source can save, the folders the picker walks (it
  starts at the roots and goes no higher), the scan, and the delete after import. A folder saved before
  the roots changed is no longer read or deleted from; its source reports why.
- **The server's account has to be able to read the folder and the files in it**, and to delete files
  there when a source is set to delete them after import. That is the systemd unit's `User=` on Linux,
  the signed-in user or the scheduled task's account on Windows, and root in the container. `imports/`
  belongs to that account, so another user saving into it needs permission to. A folder it
  cannot read is reported on the source rather than failing the scan.
- **In a container `imports/` is `./data/imports` on the host**, reached through the existing data
  mount. Any other folder has to be mounted, and the root is named by its path inside the container: a
  `volumes:` line such as `/home/sam/statements:/statements` beside `./data:/data`, with
  `WATCH_FOLDER_ROOTS=/statements`.

## Where the data lives, and how the app decides

**One directory, fixed filenames.** `DATA_DIR` holds both databases. The two always travel together, so
a second installation wants a second directory rather than a path per file.

| In the data directory | What it is | Follows `DB_PATH` |
| --- | --- | --- |
| `luma-data.db` | the ledger | — |
| `luma-control.db` | users, sessions, and the credential vault | — |
| `documents/` | attached documents, one file per attachment (`services/documents.py`) | yes |
| `luma.log`, `luma.log.1` | the server's own log, read by Settings → **Error log** | yes |
| `luma-desktop.log` | startup output where there is no terminal | no |
| `luma-desktop.lock` | the port of an instance the launcher (`backend/desktop.py`) started | no |
| `proxy.log` | output of a proxy the server runs itself | no |

**The last column is the split `DB_PATH` makes.** Attached documents and `luma.log` are placed beside the
*data database*, so a per-file override takes them with it; the launcher's files stay in `DATA_DIR`. On
an install that uses the override, only the database's directory holds the documents.

**A manual copy needs `.backup`, not `cp`.** Both databases run in WAL mode, so each has `-wal` and `-shm`
files beside it while the app is open, and copying the `.db` alone yields a copy quietly missing recent
rows. `sqlite3 <source.db> ".backup <target.db>"` is correct against a running instance. This applies to
a snapshot taken before a restore; the app's own backup is a row-level export and is unaffected.

**Settings → Startup configuration is the authority on what is in force**, with the layer each
value came from (`architecture.md` → *Configuration layers*). Read it before believing anything about a
running instance — including which database it is open on.

**Every setting except two comes from the environment or its default.** The session signing secret and
the session cookie name are stored in the control database; everything else is read at startup and
cannot be set from inside the app. The registry in `backend/app_config.py` is the list, and
`env_example.txt` documents each setting for the person setting it, together with `VITE_API_PROXY_TARGET`,
which only the development server reads.

**The per-file overrides are permanent, not a deprecation.** `DB_PATH` and `CONTROL_DB_PATH` are the only
way to reach a database that does not use the default name. Removing them would silently create empty
databases beside data that still exists, which presents as total data loss.

**Two installations on one host** need a distinct data directory and a distinct port each. The cookie
name is seeded from the control-database path, so the two do not sign each other out.

**Give the second one an `APP_NAME`, or its passkeys are indistinguishable from the first's.** A device
keeps one passkey list per *host*, and the label in it — `username (AppName purpose)` — is all a user has
to go on when deciding which entry to keep. The collision is cosmetic, since the WebAuthn user handle is
minted per control database, but `APP_NAME=Luma Demo` is what makes the list readable.
`security-model.md` → *Passkeys and the second factor* covers the labelling rules themselves.

**A watched import folder is a directory on the server, not on the browser's machine.** The backend
resolves the path, so on a LAN server it is a folder on the server, and in a container it has to be a
**mounted volume** or it names nothing. It is the operator's to place, deliberately not inside the data
directory. A backup carries the paths of the machine it came from, so restoring onto a *different*
instance switches every watched folder off while keeping its path visible.

**A packaged copy resolves its data directory from how it was distributed, not from its OS** — portable
keeps it beside the executable, installed uses the per-OS user-data directory (`releasing.md` for which
artifact is which, `architecture.md` → *Packaged builds* for the mechanism). On a portable copy the folder
*is* the installation, and moving it moves the data.

**The control database records where the financial database is, and startup keeps that record true**
(`reconcile_workspace_db_path` in `backend/db/control_database.py`). A packaged build adopts its
configured location at every start, so a moved, renamed or copied portable folder keeps working. A
source checkout adopts it only when the recorded file is gone, and otherwise logs a warning naming both;
`DB_PATH` is how to say which is meant.

## Restore is a destructive operation

**Verification precedes destruction.** The staged artifact is verified in a pass of its own before
anything is wiped; on the encrypted path the authentication tag is checked before the inner archive is
opened, because nothing may act on unverified plaintext.

**The table phase is one transaction**, so a *failed* restore leaves the target completely untouched. A
half-restored ledger is not a valid state and has no defined recovery.

**A restore takes the backup's sync resume point with its rows.** Each connection's cursor was written in
the same export as the rows it claims, so a delta sync from it re-delivers everything since. A backup
too old to vouch for its cursor, or a connection whose provider handle has changed, resets the cursor
instead (`backend/routers/import_export/backup.py`). Per-account coverage rides the data backup for the
same reason.

**Files are not transactional, so the documents phase is resumable.** A restore that fails partway can
leave the database cleanly rolled back and the documents directory half-rewritten. A marker in the data
database carries the operation across that gap, and an import, a sync or adding a document refuses while
it is set, since the sweep that ends the phase would remove a file whose row it has not seen.

**Restoring requires admin**, as does creating a backup (`security-model.md` → *Identity and the network
perimeter*). With sign-in protection off there is no role to check, and any session may.

**What a restore replaces is what is chosen from the file.** A backup holds the financial data and the
accounts part, and the restore puts back either or both. The financial data alone touches only the data
database, so restored over an existing install it keeps sign-in protection exactly as it was, and onto
fresh databases it comes up at first run with sign-in off. The accounts part also replaces the identities,
the sign-in setting, the backup keys and the vault, so the same file gives the same system whether it
lands on an empty install, the one it came from, or another. The credentials and vault can be declined
within it, which keeps the ones here while someone restored can still open them. Restoring the accounts
signs everyone out, and a file that turns sign-in on is restored only with the password of an
administrator in it, so the operator keeps a way in: the administrator they then sign in as.

**Restoring the data and the credentials together leaves exactly the backup's data connections.** One this
install had and the backup does not is removed, and the result names it with a hint to revoke its access
at the provider, since removing it here does not end access granted there. A restore that leaves the
credentials out keeps every connection, because those credentials sit on the same rows
(`data-model.md` → *A connection is split across the two parts*). A data restore is refused while a sync
is running.

**A restore makes a new system.** Restoring the financial data gives the install a new backup identifier,
so every backup made before it, the restored file included, reads afterwards as another system's and
needs the different-system confirmation (`data-model.md` → *The compatibility guard*). The backup to rely
on after a restore is one taken after it.

**A restore rewrites the tables inside the existing files, so it does not mend a damaged file.** Both
databases are checked once it finishes and the result says whether they passed. The check runs after the
restore rather than before it, because restoring is how a damaged database is put right. Clean files come
from restoring into new, empty databases: stop the server, move the database files aside, start it again
and restore (*Checking the databases*).

## Locked out

**A forgotten password is reset from a terminal, by anyone who can reach the data directory**: the
launcher run with `--reset-password` (`backend/account_recovery.py`). It names the control database
before changing anything. The README → *Locked out* has the command for each kind of installation and
what it changes; why it needs no other credential is in `security-model.md` → *Identity and the network
perimeter*.

## Diagnosing a running instance

| Surface | Answers |
| --- | --- |
| `GET /api/health` | is a server listening and answering on this port |
| Settings → Startup configuration | every effective setting and the layer it came from |
| The data-location line in the navigation pane | which databases *this* copy is open on |
| Settings → About | the version, and for a packaged build the commit it was built from. **Copy details** copies those with how the copy runs, the platform and the browser, for a bug report, leaving out paths, host names and data |
| The connection sync log (**Sync log** on Import → Connections, for everything or on one provider's card) | what a data source did, and why a sync, connect or disconnect failed |
| `luma-desktop.log` | startup output where there is no terminal |
| `luma.log`, read by Settings → **Error log** | what went wrong in a running server, with tracebacks, in any topology |
| Settings → **Database** | whether either database file is damaged, the space each uses table by table, and compacting the data file |

**"Which database is this?" is a real question on a machine running more than one copy**, and nothing
else on screen distinguishes a checkout pointed at a restored backup from one pointed at real data. The
data-location line is shown by default where the question is live, and only to a session that could
read the paths in Settings anyway.

**"Which build is this?" is answered by the commit, not the version**, which is the same for every build
between two releases. The **Build** row in Settings → About and both log files' start lines carry it
(`releasing.md` → *What identifies a build*).

### Checking the databases

**The check is structural** (`backend/services/database_health.py`): SQLite's `integrity_check` and
`foreign_key_check`, against both databases, through a read-only connection. It says whether a file is
damaged and whether a row refers to one that is gone, never whether the ledger is coherent. At ledger
scale it takes about a tenth of a second, so it runs on demand and is never backgrounded. It is an
administrator's, like the rest of Settings → Database, because a repair or a compaction locks a database
for everyone.

**It runs at the two moments a damaged file does the most harm.** Before every backup, because a row
export over a damaged index can quietly come out short: the page asks before making one, the backup is
still made when asked, and its history row records the outcome (`backup_history.database_check`). After
every restore, for the reason under *Restore is a destructive operation*.

**Every failure names its next step.** When every problem is an index out of step with its table,
`REINDEX` repairs it completely, since an index holds no data of its own, and the section offers it.
Anything else is a backup: the section names the newest one made from databases that passed. Orphaned
rows are reported per table and parent, with no repair, because each case is a decision about what the
data means.

**The documents folder is checked with them**, as the third place the data lives: every attached
document's file has to open. A missing one is not reported here, since that drift is tolerated
(`data-model.md` → *Attached documents*). One that exists and cannot be opened is a failure, and it is the one
failure that stops a backup rather than asking first, because the backup cannot carry the file and the
server wrote every one. The usual cause is data moved across from another user and still owned by them;
the section names the folder and the user the server runs as.

---

## Obstacles

- **`integrity_check` does not check foreign keys.** They are separate passes, and a database can pass
  one with a table full of orphans. Any diagnostic worth having runs both.
- **A structural check answers "is the file corrupt", never "is the data coherent".** A cursor ahead of
  a restored ledger, a coverage claim disagreeing with the rows it covers, a mapping pointing at a
  merged account — all read as `ok`. A green diagnostic that implies more than it checked is worse than
  no diagnostic.
- **Per-table sizes come from SQLite's `dbstat` table, which not every build of SQLite includes.** Where
  it is missing, Settings → Database lists row counts only and says so.
- **SQLite's own salvage (`.recover`) lives in the `sqlite3` command-line program**, not in Python's
  `sqlite3` module, so a file damaged past a rebuild of its indexes cannot be salvaged from inside the
  app. A backup made from it carries every row the export can still read.

## Open

- **No check of the app's own invariants.** The structural check cannot see the cases under *Obstacles*.
  An invariant checker over them needs its own design: which invariants to assert, warning or error, and
  whether anything can be repaired or only reported.
  → [`backlog/data-consistency-checker.md`](backlog/data-consistency-checker.md)
