# Import-history windowing / archive

**Status: partially addressed — the lossy cap is fixed; the archive UX is deferred (2026-07-30).**

The Data-sources import history renders every completed import as a card: a data-source row per source,
and per-file batch rows inside it when expanded (marketplace vendors — Amazon — render through their own
`MarketplaceImportHistory` path). Someone who feeds the app monthly accumulates lots of these over the
years, so the history needs an intentional windowing/archive model rather than showing everything forever.

## What was fixed now (the lossy cap)

`GET /import-export/batches` (`list_batches`) used to `LIMIT 50` globally, most-recent-first. That was a
*silent, lossy* window: imports past the newest 50 vanished from the UI with no indication (their
`import_batch` rows and transactions stayed in the DB — only the card, and its Undo/rename/review
affordances, disappeared). Worse, because the cap was global-most-recent, an actively-fed source could
push another source's cards entirely out of the window, so that source showed "0 imported files" while its
history was intact underneath.

The display query is now **unbounded** — the full completed history comes back, so nothing is silently
dropped. Cardinality is one row per imported *file* (not per transaction), which makes this tolerable in
the interim. The best-effort per-batch reconcile pass on the same endpoint stays capped to a recent window
(it *writes* on every load; running it over all history would rewrite every batch each call and worsen
lock contention). Regression test: `test_batch_listing_is_not_capped_at_fifty`.

This means the page can now grow long for a heavy importer — which is exactly what the archive UX below is
for. Until it lands, the history is complete but unwindowed.

## What remains — the archive UX

- **Per-source recency window, not global.** Keep the last N (≈3–4) plus anything newer than ~1 month
  expanded per source; collapse the rest into an **"Older imports" disclosure** under that source. This
  also fixes the crowding-out that the old global cap caused — each source keeps its own recent cards.
- **Archive grouped by year** inside that disclosure — reads naturally for someone importing monthly for
  years. Apply the same treatment to the marketplace (`MarketplaceImportHistory`) card path.
- **Re-bound the fetch, reachably.** Reintroduce a bound on `list_batches` (paging, or per-source fetch)
  so the endpoint isn't unbounded forever — but only once the archive makes the older entries *reachable*
  (paging that hides rows with no way to load them would just recreate the lossy cap). Response-shape
  change (array → `{batches, total}` or a paged envelope) ripples through the many `api.listBatches()`
  callers in `ImportExport.jsx`, so budget for that.
- **Deletion strategy** as a separate, explicit opt-in: purge old batch *history records* (not the
  transactions they imported), consistent with the Settings → Trash timeframe-chooser idiom
  (`empty_transaction_trash(older_than=…)`). Decide whether deletion is per-source or global, and whether
  it archives-then-purges or deletes outright.

## Pointers

- Backend: `list_batches` in `backend/routers/import_export/core.py` (the two queries + the reconcile note).
- Frontend: `dataSourceRows` assembly in `frontend/src/pages/ImportExport.jsx`; rendering in
  `frontend/src/components/importExport/ImportHistorySection.jsx` (per-source expand + per-file batch rows)
  and `MarketplaceImportHistory.jsx` (vendor card path).
- Distinct from `list-virtualization.md` (that's render-window *perf* for large lists; this is
  *retention/organization* of the import history).
