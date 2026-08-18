# Optional `.env` & layered configuration

**Status: done (2026-08-18).** The `.env` file is optional: a plain single-user install needs none. The
system is described in [`architecture.md`](../architecture.md) → *Configuration layers*; this file keeps
the decisions and the rejected alternatives, plus the one follow-up that was deliberately left out.

## Principle: layered precedence

```text
hardcoded defaults  <  DB-backed app settings  <  environment variable
```

- **Defaults** make `.env` unnecessary out of the box (loopback, port 8000, `./luma-control.db`,
  `./data/`, an auto-generated session secret).
- **DB-backed settings** (`app_setting` in the control DB) hold the values that must persist across
  restarts.
- **Env** always wins, so an operator can force any value from outside the app. Because an override is
  invisible from inside, Settings → Configuration reports the layer each effective value came from.

## Decisions

**The session secret lives in a control-DB row** (decided 2026-08-18; the alternative was a sibling
secret file next to the control DB). One artifact to back up and no second file-permission story to get
right on three platforms outweighed the cost — reading the control DB during bootstrap, before
`SessionMiddleware` is constructed. That reordering is why `init_control_db()` runs at import in
`backend/main.py` rather than in the lifespan hook.

An install still carrying a **placeholder** secret from an old `.env` template is treated as having none,
so it generates a real one instead of signing cookies with a value that is public knowledge.

**`LUMA_USE_LOG_FILES` stays a launcher knob, not an in-app toggle** (decided 2026-08-18). It was the
only user-facing setting still living in `.env`, but its sole consumer is the shell launcher, which reads
it before Python starts; moving it into the DB would have meant teaching two launcher dialects to query
SQLite in order to preserve a toggle that only takes effect on the next restart anyway. The in-app toggle
and the `.env`-writing endpoint behind it were removed rather than migrated.

**The launchers no longer create `.env` or write secrets into it** (decided 2026-08-18). Four scripts
used to materialize it from `.env_example` before anything ran, which is what made the file feel
mandatory. An existing `.env` still works and still overrides everything.

**`SESSION_COOKIE_SECURE` stays env-first** with a `false` default — a transport guarantee set at the
deployment edge (the install sets it; the desktop launcher leaves it false), deliberately not derived
from app state and therefore not an in-app toggle either.

**`LUMA_DEVELOPER_OPTIONS` stays env-only — deliberately.** It is a *gate* that unlocks destructive dev
reset tools, not a user preference. The one legitimate in-app need that appeared (2026-08-08) was the
connection sync log, and it was met by taking that read-only surface *out* from behind the gate, not by
softening the gate. The precedent is narrow: anything destructive still belongs behind it.

**`LUMA_EXPERIMENTAL_SECURITY_SETTINGS` is gone** (2026-08-18). By the time the flag was reviewed it
gated exactly one thing — a "Local access mode" label on the identity chooser — because the Settings
sections it was created to hide now render unconditionally. A flag whose name promises "experimental
work in progress" but whose effect is one label is worse than no flag, so it was removed and the label
kept: that screen only appears with the perimeter off, so it is always accurate.

**Three path settings collapsed into `DATA_DIR`** (2026-08-18). Both databases live in one directory
under fixed filenames, so moving or duplicating an installation is one setting rather than two or three.
The repo's own `docker-compose.yml` and the Playwright harness moved to it.

**The per-file overrides are permanent, not a deprecation.** `DB_PATH` / `CONTROL_DB_PATH` still win for
their own file, and fixing the filenames is exactly what makes them load-bearing: a database that does
not use the default name — an install carrying files named before a rename, for instance — is reachable
*only* through them. Removing them would not force such an install to rename anything; it would silently
create empty databases beside data that still exists, which presents as total data loss. So they are
documented as "for a database that is not on the default filename" rather than as legacy syntax awaiting
cleanup, and `.env_example` mentions them without offering them as a setting to copy.

**`TENANT_DATA_ROOT` is gone** (2026-08-18) — multi-tenant leftover. Every identity-creating path passes
the one existing tenant, so only the first identity can create a tenant record, and it always resolved to
the configured `DB_PATH`. The per-tenant directory branch was unreachable in a running app.

**`CORS_ORIGINS` defaults to empty** (2026-08-18). It had defaulted to the two localhost frontend ports
with `allow_credentials=True`, which is a standing credentialed grant to any page served on those ports —
and unused, because the browser never makes a cross-origin call in any shipped topology. The setting
survives as the escape hatch for a split-origin deployment.

**Reset, not edit** (2026-08-18). Whether the panel should allow editing the settings that do not need
`.env` was asked and mostly answered "no": after the collapse, the only settings with a control-DB row are
the session secret and the cookie name, and neither wants a text field. What was missing was a way to
*undo* a stored value — write-once with no UI meant a cookie name stored under the old install-directory
derivation could never pick up the current one. So each stored row offers a single reset (labelled
"Regenerate" for the secret), confirmed, taking effect at the next start. Rows under an environment
override are not offered it, and the endpoint enforces the same rule rather than trusting the client.

**The Plaid `.env` bootstrap is gone** (2026-08-18). `PLAID_CLIENT_ID` / `_SECRET` / `_ENV` were still
consulted when no `provider_config` row existed — the migration path from before app credentials moved
into the vault. It was retired once nothing depended on it: it kept a plaintext app secret readable in a
file for exactly the credential the vault exists to protect, and it handed a *locked* vault an
unlock-free path to a secret (the reveal endpoint deliberately skipped the gate for env-sourced values).
The Configure card is now the only way in, and re-entering a credential once is the whole of the setup.

**`LUMA_ENV_FILE` stays, under that name** (2026-08-18). It points the backend at a different override
file and exists because `load_dotenv(override=True)` would otherwise let a repo `.env` clobber exported
variables — which is precisely what the Playwright harness needs defeated to run against throwaway
databases. Two things were considered and rejected: **removing it** (nothing else defeats the override,
so the E2E isolation would have to be rebuilt or the precedence flipped — a separate decision), and
**renaming it to something `TEST_`-prefixed** (it selects an override file; being test-only is a fact
about its current caller, not about the variable, and the name would then look wrong for a systemd unit
or a packaged build pointing at a config file elsewhere). Its real limitation is documented instead: it
redirects the **backend only**, since the launchers and `vite.config.js` each read the repo-root `.env`
for their ports — so it isolates a database rather than switching between whole configurations.

## The irreducible env core

Needed before, or in order to find, the database — so there is nowhere earlier to read them from:

- **Data location** — `DATA_DIR` (with `CONTROL_DB_PATH` / `DB_PATH` honored as legacy per-file
  overrides). This is also the mechanism for running two installations on one host (distinct directory +
  port per instance; the cookie name follows the control DB path on its own).
- **Ports** — `BACKEND_PORT` (before the server binds), `FRONTEND_PORT` / `FRONTEND_DOCKER_PORT` /
  `VITE_API_PROXY_TARGET` (before or outside the app process).
- **Launcher knobs** — `LUMA_BACKEND_READY_TIMEOUT`, `LUMA_USE_LOG_FILES`.
- **Deployment/gate flags** — `SESSION_COOKIE_SECURE`, `LUMA_DEVELOPER_OPTIONS`.

## Follow-up: mDNS service name

**Raised 2026-08-17, not built.** A discoverable mDNS name (default `luma`, or a `luma-<something>`
variant) for reaching the app on a LAN without an IP address. The name is needed before the app is
serving, so it belongs in the env-only core alongside the ports — one `Setting(...)` row in
`backend/app_config.py`'s registry with `stored=False`, after which it appears in the configuration
report automatically. The open part is the *default name* when two installations share a network, not the
plumbing.

## Cross-refs

- [`security-and-deployment-model.md`](security-and-deployment-model.md) — phase 6 moved provider creds
  out of `.env` into the vault; the `SESSION_COOKIE_SECURE`/transport reasoning is settled there.
- [`deployment-topologies.md`](deployment-topologies.md) — the packaged desktop build and LAN-server
  install are the concrete consumers of "no `.env` needed by default" vs. "install sets a few env values".
