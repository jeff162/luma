# Cleanup pass (batched low-priority items)

> **Status: backlog.** Small, non-urgent cleanups to do together in a dedicated pass — none block
> current work. Verify with `cd frontend && npm run lint` + the browser console per page.
> Reconciled against the tree on 2026-10-29.

## The file report's *Not imported* view, on batches older than it

Three small things the view cannot do well for a batch imported before `import_batch_rejected_row`
existed, where its rows come from the up-to-twenty sample in the snapshot instead (`data-model.md` →
*Import batches and profiles*). All three are invisible on anything imported since.

- **The Date / Description / Amount columns read `—`** on those rows, because the snapshot stored only
  the file's raw cells and not the parsed fields. The cells themselves are there — a row shows its
  `Original Description` while the Description column is blank, which reads as a defect. Fill the three
  from `values` using the batch's saved `column_map` when a row has no parsed field, in
  `get_batch_not_imported` (`routers/import_export/core.py`).
- **A reason pill whose rows were never stored filters to nothing**, and the empty state then says "No
  rows match the current search or filter", which blames the filter for an absence that is about the
  record. Seen as *Skipped account (17)* on a pre-migration batch holding five zero-amount rows and
  nothing else. Either say that case plainly or drop the pill when no row of that kind was kept —
  dropping it loses the count, which is true and worth showing, so the message is probably the better
  half.
- **The card's pill and the view's count are about different sets** — the pill counts the three
  *rejected* kinds it always has, while *Not imported (N)* adds account-skipped and trailing rows, so a
  card can read "3 rejected" and open on twelve. Both numbers are honest and the mismatch is still odd
  on screen. Changing what the pill counts changes what the card reports, so it is a decision rather
  than a fix.

## Schema leftovers to fold into the next migration

*(Empty — `idx_recurring_override_pin` rode along with migration 46 on 2026-09-01. Kept as a heading
because the pattern recurs: an inert schema leftover is worth queueing rather than version-bumping for,
and the queue only works if something is checked when the next migration is written.)*

## Press-scoped transient labels (from the 2026-08-19 flicker sweep)

**Unstarted, and deliberately not sweepable.** The 2026-08-19 sweep converted the busy indicators driven
by a **load** and the spinners that replaced content on reload; it left the ~61 labels driven by a
**press** (`Saving…`, `Deleting…`, `Applying…`, `Importing…`). Why they are a different judgement — and
the one question each site has to answer — is in [`../ui-patterns.md`](../ui-patterns.md) → *Loading and
feedback*. What is left here is the pass itself: visit each site, answer the question, and convert only
the ones where something else on screen already reports success.

Find them with `grep -rn "? '[A-Z][a-z]*…'" frontend/src --include=*.jsx`.
