# Import-history archive UX

**Status: the lossy cap was fixed 2026-07-30; the per-source window, the by-year archive and the move
onto transaction coverage were all built 2026-10-08.** What is left is the fetch re-bound the archive
unblocks, and a deletion strategy. The
retention story — what the global `LIMIT 50` cost, why the display query is unbounded, and why the
best-effort reconcile pass on the same endpoint stays capped — is in
[`../scale-and-limits.md`](../scale-and-limits.md) → *Import history: retention*; the window and
archive as built, and the rules that make an archive different from a cap, are in
[`../ui-patterns.md`](../ui-patterns.md); what a card's recorded span means is in
[`../data-model.md`](../data-model.md) → *Import batches and profiles*.

## What is left to build

### Re-bound the fetch

Paging that hides rows with no way to load them recreates the lossy cap under a new name, which is why
this waited on the archive. It is no longer blocked there, but it is blocked on something larger:
**five consumers read `GET /import-export/batches` as an aggregate over all history**, not as a page of
it, and paging the endpoint under them turns a complete answer into a first-page one. They are
enumerated in [`../scale-and-limits.md`](../scale-and-limits.md) → *Import history: retention*; the
data-source manager's known-template-hash set is the one that becomes wrong rather than merely stale.
Give each an endpoint that answers its own question, then change the list's response shape (array → a
paged envelope) and budget for the remaining callers on the Import / Export page.

### A deletion strategy, as a separate explicit opt-in

Purge old batch *history records*, never the transactions they imported, consistent with the existing
trash timeframe-chooser idiom — the Rules page's stale-rule cleanup is the closer reference, since its
chooser starts unset and sweeps nothing by default. Per-source is the natural placement, inside the
archive disclosure where the reader is already looking at exactly the set being offered.

**What makes this harder than it reads, and has to be decided before it is built:** deleting an
`import_batch` row is not free for the transactions that survive it.

- `txn.import_batch_id` is `ON DELETE SET NULL`, and the presence of that column is how the ledger
  knows a row was **not manually entered** — it is the amount-edit refusal in
  `backend/routers/transactions.py`, and it feeds the imported-vs-connection load filter. A purge would
  silently make a CSV import's transactions amount-editable and reclassify them as manual. A synced row
  is unaffected, since it also carries `external_transaction_id`.
- The cascade takes `import_batch_account`, `import_batch_duplicate` and `import_batch_rejected_row`
  with it — and the duplicate and rejected-row records are the **restore surface** for rows rejected at
  import or confirmed as duplicates (`../data-model.md`). Purging history therefore destroys recovery
  paths, which "never the transactions" does not convey.

The shape that answers both is a **stub rather than a delete**: cascade away the bulky children, drop
`config_snapshot`, and keep a minimal row that still carries the provenance — excluded from the history
list, so the user gets the shortening they asked for without the ledger quietly changing meaning
underneath. Decide that against outright deletion, and decide whether the purge skips batches that
still hold restorable rows (and says so) or warns and proceeds.

## Pointers

- Backend: `list_batches` in `backend/routers/import_export/core.py` (the two queries, and the note on
  the reconcile pass).
- Frontend: `dataSourceRows` assembly in `frontend/src/pages/ImportExport.jsx`; the window and archive in
  `lib/importExport/importHistoryWindow.js` and `components/importExport/ImportHistoryArchive.jsx`,
  rendered by `ImportHistorySection.jsx` and `MarketplaceImportHistory.jsx`.
- This is *retention and organization*. Render-window performance for long lists is a different question
  and lives in [`../scale-and-limits.md`](../scale-and-limits.md).
