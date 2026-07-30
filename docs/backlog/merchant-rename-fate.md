# Decide fate of `merchant_rename` / `merchants.py`

**Status: dormant code, decision pending (migrated from `TODO.md` 2026-07-30).** Keep-or-drop
call on a full-but-unwired CRUD router, deferred until Plaid sync is exercised in real use.

**Context.** `backend/routers/merchants.py` defines a full CRUD router for
the `merchant_rename` table (raw_pattern → clean_name mappings) but is not
registered in `backend/main.py`, has no frontend callers, and nothing in
sync/import reads the table to apply renames. The original design (see the
docstring at the top of the file) was a two-pass pipeline: rename garbled
Plaid merchant names *before* categorization runs, with the `/apply`
endpoint walking existing rows so retroactive cleanup matched what new
imports would produce. That role got absorbed into `category_rule.clean_name`,
which is the live rename mechanism today —
[`categorizer.py`](../../backend/services/categorizer.py) collects
`winning_clean_name` from the matching rule, and
[`sync.py`](../../backend/routers/sync.py) writes it to `display_name`.
The category-rule path also gets account/owner scoping for free, which
`merchant_rename` doesn't have (the table is just `id, raw_pattern,
clean_name`). The table is still serialized by backup/restore in
[`backup.py`](../../backend/routers/import_export/backup.py) — the import/export
router is now a package, so `merchant_renames` is dumped (~L617) and
restored (~L800/868/1041/1098) there, not in a single `import_export.py`.

**Why deferred.** Plaid integration hasn't been exercised yet, and the
original two-pass pipeline was aimed specifically at Plaid's garbled
merchant strings (e.g. `WHOLEFDS #1234 MKT`). Wiring `merchant_rename` back
in may turn out to be the right answer once Plaid sync is in real use, so
the dormant code is left as a reminder to make that call deliberately.
Easy to delete later if the category-rule path proves sufficient.

**Suggested approach when picked up.**

- If keeping: register `merchants.router` in `backend/main.py` (`prefix="/api/merchants"`),
  add a Transaction-detail affordance to create a rename from a row's
  `raw_name`, and have sync/import consult `merchant_rename` before the
  categorizer runs so cleaned names feed into rule matching. The existing
  `/apply` endpoint already covers retroactive application.
- If dropping: delete `backend/routers/merchants.py`, add a migration that
  drops the `merchant_rename` table, and remove the `merchant_renames`
  entries from backup dump/restore in
  `backend/routers/import_export/backup.py` (~L617 dump; ~L800/868/1041/1098
  restore). The frontend `api.js` merchant-rename helpers are already gone
  (see CHANGELOG's Removed section).
