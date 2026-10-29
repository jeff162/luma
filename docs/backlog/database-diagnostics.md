# Database invariant checker

**Status: backlog, not started (2026-10-29).** The structural check is built: Settings → Database runs
`integrity_check` and `foreign_key_check` against both databases, before every backup and after every
restore (`../operations.md` → *Checking the databases*). What it cannot see is whether the data is
coherent, and that is this note.

## The half a structural check does not cover

The pragmas verify *SQLite's* structures, not the app's invariants. Everything in `data-model.md` that makes
the data mean something is invisible to them. A database can be structurally perfect and still hold:

- a connection whose `transactions_cursor` sits ahead of a restored ledger, so those rows are never
  re-fetched — a real defect that was found and fixed, and the worked example of an inconsistency the
  pragmas call `ok` (see [`../operations.md`](../operations.md) → restore);
- a coverage claim (`import_batch_account`, `connection_account.coverage_*`) disagreeing with the rows it
  claims to cover;
- a mapping pointing at an account that has since been merged into a group;
- a suspect-duplicate pointer whose counterpart was trashed.

## Shape

Its own design, not an extension of the structural check:

- **Which invariants are worth asserting.** Each one is a query over the ledger that names the rows that
  break it; the list above is the starting set.
- **Warning or error, per invariant.** Some are harmless drift, some mean data is quietly wrong.
- **Report or repair.** The hard part. A repair is a decision about what the data means, so each one needs
  to be stated as plainly as a migration would be, and some may only ever be reported.

## Open questions

- **Who sees it?** The structural check is an administrator's, in Settings → Database. An invariant
  checker reports things most people cannot act on, which may argue for `LUMA_DEVELOPER_OPTIONS`
  (`runtime_config.py`) instead.
- **When does it run?** On demand beside the structural check, or also after a restore, where the cursor
  case comes from.

## Cross-refs

- [`../operations.md`](../operations.md) → *Checking the databases* — the structural check this sits beside.
- `docs/data-model.md` — the invariants a checker would assert.
