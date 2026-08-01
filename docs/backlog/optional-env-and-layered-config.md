# Optional `.env` & layered configuration

**Status: parked, not started (2026-08-01). Independent of the security phases; not blocking.** Make
the `.env` file **optional** for the common case by moving most settings into DB-backed app settings
with sensible defaults, leaving `.env` as an *override/advanced* mechanism (custom DB paths, running two
instances on one host, custom ports, the TLS cookie flag). A plain single-user install should need **no
`.env` at all**.

## Principle: layered precedence

Three layers, highest wins:

```
hardcoded defaults  <  DB-backed app settings (admin-editable)  <  environment variable override
```

- **Defaults** make `.env` unnecessary out of the box (loopback, port 8000, `./luma-control.db`,
  `./data/`, an auto-generated session secret).
- **DB-backed settings** (the existing `app_setting` table + the Settings UI) become the normal home for
  user-facing config — no file editing.
- **Env** always wins, so an operator can still force any value. When an env override is present, the
  corresponding DB setting in the UI should render as **overridden/locked** (with the effective value and
  a note), so an admin isn't confused when toggling it does nothing.

## What must stay env-only (the irreducible core)

These are the "someone doing something special / two instances on one host" survivors — they *cannot*
move into the DB because they are needed before, or to find, the DB:

- **DB locations** — `CONTROL_DB_PATH`, `TENANT_DATA_ROOT`, `DB_PATH`. Chicken/egg: you can't store *where
  the database is* inside the database. This is the mechanism for running two separate instances on one
  host (distinct control/data paths + port + cookie name per instance).
- **Bind `BACKEND_PORT`** — must be known before the server binds.
- **Shell-launcher-time knobs** — read by `scripts/start_backend.sh` before Python starts:
  `LUMA_BACKEND_READY_TIMEOUT`, and `LUMA_USE_LOG_FILES` (partly — the launcher writes its own logs).

## What can move to DB-backed settings (env optional)

- `SESSION_COOKIE_NAME` — default/derived from the install directory (as today), env overrides.
- `CORS_ORIGINS` — derive from the configured ports; env overrides for exotic setups.
- Provider (Plaid) `client_id`/`secret`/`env` — move into the **vaulted DB** as part of security phase 6.
  **No migration** (decided 2026-08-01): the phase-6 "Configure" card just writes them going forward;
  re-entering once is acceptable (single Plaid user). `.env` remains a bootstrap/override only.

### `SESSION_SECRET` — movable, with two wrinkles

It can stop being a required `.env` field, but:

1. **Persistence.** It must be **auto-generated and persisted** on first run (control DB, or a sibling
   secret file next to the control DB) so restarts don't invalidate every session. Today
   `start_backend.sh` generates it into `.env`; this just relocates that behavior. Env still overrides.
2. **Startup ordering.** It is read at **app-construction time** from `os.getenv` — `SessionMiddleware`
   is added before the lifespan runs. DB-sourcing it means reading the control DB during bootstrap
   *before* middleware is wired: a real but contained restructure of `backend/main.py` (resolve config
   first, then build the app). The same applies to any other setting consumed at middleware-construction
   time (e.g. the cookie flags).

### `SESSION_COOKIE_SECURE` — keep env-first

Leave this an env value (with a `false` default), **not** a DB setting. It is a transport guarantee set
at the deployment edge (the Caddy/systemd install sets it; the desktop launcher leaves it false) — per
the phase-3 transport policy it is deliberately *not* derived from app state, so it shouldn't become an
in-app toggle either.

## The two developer/experimental flags (decided 2026-08-01)

- **`LUMA_DEVELOPER_OPTIONS` stays env-only — deliberately.** It is a *gate* that unlocks destructive dev
  reset tools, not a user preference; it should not be toggleable from the UI (not something to invite
  people to flip). A deliberate exception to the "move preferences into the DB" default.
- **`LUMA_EXPERIMENTAL_SECURITY_SETTINGS` is expected to go away** once the security project (phases 4–6)
  completes. If it survives, it does **not** become a normal DB setting either: keep it env-only if it
  must be defined early, **or** fold it under the developer-options card (gated by
  `LUMA_DEVELOPER_OPTIONS`). Never a plain admin-facing toggle.

## Net effect

A plain single-user install needs **zero `.env`**: loopback bind, port 8000, `./luma-control.db`,
`./data/`, an auto-generated+persisted session secret, defaults for the rest. `.env` survives only for:
custom DB paths, multiple instances on one host, custom ports, the TLS cookie flag, and the developer
gate.

## Scope / touch points

- `backend/runtime_config.py` — today the `.env`-centric config layer (`read/write_environment_settings`,
  `write_runtime_env`, the runtime-config-status gate). Reshape into the layered resolver.
- `backend/main.py` — bootstrap ordering so DB-backed config is resolved before middleware construction.
- `backend/db/control_database.py` — `app_setting` getters/setters already exist; add the ones that move.
- Settings UI — surface the now-DB-backed settings; show env-overridden ones as locked with their
  effective value.
- `scripts/start_backend.sh` / `.env_example` — stop auto-writing required secrets into `.env`; document
  `.env` as optional/override; keep the launcher-time knobs.

## Open questions

- **`LUMA_DEVELOPER_OPTIONS`** — confirmed env-only for now, but flagged as "somewhat undecided"; revisit
  if a legitimate in-app need appears (kept out deliberately for now).
- Where auto-generated `SESSION_SECRET` should live — control DB row vs. a sibling secret file (backup and
  file-permission implications differ).

## Cross-refs

- [`security-and-deployment-model.md`](security-and-deployment-model.md) — phase 6 moves provider creds
  out of `.env` into the vault (no migration); the `SESSION_COOKIE_SECURE`/transport reasoning is settled
  there. Retiring `LUMA_EXPERIMENTAL_SECURITY_SETTINGS` is tied to that project completing.
- [`deployment-topologies.md`](deployment-topologies.md) — the packaged desktop build and LAN-server
  install are the concrete consumers of "no `.env` needed by default" vs. "install sets a few env values."
