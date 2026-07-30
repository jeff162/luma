# Import / duplicate-detection follow-ups

**Status: deferred, not started (migrated from `TODO.md` 2026-07-30).** Two convenience
enhancements to the dedupe subsystem — neither is a safety gap (data loss is already
prevented by soft-delete + per-row restore).

## Auto-restore deduped rows when a contributing import is undone

**Context.** Exact-match (hard-reject) duplicates are dropped at import
time, never inserted into `txn`; only their payload is kept in
`import_batch_duplicate`. So if file B has rows that were skipped because
they matched file A, then undoing file A leaves those B rows absent even
though re-importing B fresh would now create them (A's rows are gone, so
they would no longer be duplicates). Today the only recovery is the manual
"Import duplicates" action on file B (`POST
/import-export/batches/{id}/duplicates/import`) or re-importing B. The idea
here is to automate it: when an import is undone, survey subsequent batches'
`import_batch_duplicate` records and re-materialize the rows whose only
reason for rejection was the batch being undone.

**Why deferred.** Unclear how often it actually matters, and it is not
trivial to do correctly. Rejections form a chain: files A, B, C may each
contain overlapping slices of earlier ones. A row in C that was dropped
because of A might *still* be a duplicate after A is undone — now because of
B. So "restore everything C deduped against A" is wrong; each candidate has
to be re-evaluated against the *current* ledger state (re-run through
`evaluate_duplicate`), not just blindly re-inserted because its original
matched-row disappeared. There is also an ordering question (process
candidates oldest-first so a restored B row can legitimately re-suppress a C
row) and a UX question (auto-restore silently vs. surface "N rows can be
restored" for confirmation).

**Suggested approach when picked up.**

- In `undo_batch`, after deleting the batch's rows, collect every *other*
  batch's `import_batch_duplicate` payloads and re-run each through
  `evaluate_duplicate` against the post-undo ledger.
- Re-insert only those that now pass (no longer hard-reject); leave the rest
  as duplicate records. Process oldest batch first so re-inserted rows can
  re-suppress later candidates within the same pass.
- Decide auto vs. confirm: likely surface a count ("Undoing this import lets
  N previously-skipped rows from later imports be restored — review?") rather
  than silently mutating other batches.
- Watch the interaction with soft-flags: a re-materialized row should also go
  through `mark_import_suspects`/the cross-account sweep, the same as the
  manual "Import duplicates" path already does.

## Duplicate-resolution history (review what you did, and undo it)

**Context.** There is no chronological, reviewable record of the dedupe
decisions a user made (Keep / Discard / Replace / Import-anyway / Restore).
The *raw material* is already persisted, though: every action soft-deletes
(`trashed_at` + `rejection_reason`, even Replace), and each row records how/when
it was resolved (`suspect_resolved_at`, `dedupe_resolved_by`). So no decision is
lossy and recovery is already possible per-row from the duplicate report — what's
missing is a *view* of the decisions over time and a one-click *batch* undo.

**Why deferred (and split).** This is convenience/transparency, not safety —
data loss is already prevented by the soft-delete + per-row Restore/Import-anyway.
So it doesn't clear the "no complexity without a clear payoff" bar yet. Do it in
two steps:

- **v1 — flat history view (nearly free; worth doing later).** Read-only list of
  resolved rows derived from the existing fields — query by `suspect_resolved_at`,
  group by (batch, action, time-window), show action + affected rows. **No new
  table**, and per-row undo already exists (the report's Restore/Import-anyway).
  Delivers most of the transparency value.
- **v2 — action log + grouped/tree view + one-click batch-undo (heavier; only if
  v1 proves used).** A real `dedupe_action` log written at resolve-time
  (action, timestamp, batch, affected txn ids), a tree view (action → affected
  nodes), and undo of a whole action/group.

**Design notes when picked up.**

- Grouping is nearly free at log-time: the review dialog already applies bulk
  selections *as* bulk ("Keep both (N)…"), so a log row written then captures the
  grouping. Only the uncommon one-at-a-time path needs a time-window fallback —
  don't build a fragile post-hoc "these N individual actions were really a bulk"
  heuristic.
- Undo reuses existing inverses (`restore_rejected_duplicate`, remove the
  `account_pair_distinct` pair + re-flag, un-trash the replaced row) — it's
  replaying a soft-delete inverse, not new recovery logic.
