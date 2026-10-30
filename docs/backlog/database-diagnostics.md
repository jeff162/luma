# Database invariant checker

Not started. Settings → Database runs `integrity_check` and `foreign_key_check` on both databases
([`../operations.md`](../operations.md) → *Checking the databases*). Those verify SQLite's structures,
not the app's invariants, so a database can pass and still hold data that means the wrong thing. This
project is a checker for that half.

## What it would catch

The starting set:

- a connection whose `transactions_cursor` sits ahead of a restored ledger, so those rows are never
  re-fetched (see [`../operations.md`](../operations.md) → restore);
- a coverage claim (`import_batch_account`, `connection_account.coverage_*`) disagreeing with the rows it
  claims to cover;
- a mapping pointing at an account that has since been merged into a group;
- a suspect-duplicate pointer whose counterpart was trashed.

## Shape

Its own design, not an extension of the structural check:

- **Which invariants to assert.** Each is a query over the ledger naming the rows that break it. The
  invariants themselves come from `docs/data-model.md`.
- **Warning or error, per invariant.** Some are harmless drift, some mean data is quietly wrong.
- **Report or repair.** The hard part. A repair is a decision about what the data means, so each needs
  to be stated as plainly as a migration would be, and some may only ever be reported.

## Open questions

- **Who sees it?** The structural check is an administrator's. An invariant checker reports things most
  people cannot act on, which may argue for `LUMA_DEVELOPER_OPTIONS` (`runtime_config.py`) instead.
- **When does it run?** On demand beside the structural check, or also after a restore, where the cursor
  case comes from.
