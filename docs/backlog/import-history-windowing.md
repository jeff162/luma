# Import-history archive UX

**Status: the lossy cap was fixed 2026-07-30; the archive UX below has not started.** The retention
story — what the global `LIMIT 50` cost, why the display query is now unbounded, and why the
best-effort reconcile pass on the same endpoint stays capped — is in
[`../scale-and-limits.md`](../scale-and-limits.md) → *Import history: retention*. What stays here is
the design for the windowing that has not been built.

The history renders every completed import as a card: a data-source row per source, and per-file batch
rows inside it when expanded (marketplace vendors render through their own path). Someone feeding the
app monthly accumulates these for years, so it needs an intentional archive model rather than showing
everything forever. Until this lands the history is complete but unwindowed.

## What to build

- **A per-source recency window, not a global one.** Keep the last three or four plus anything newer
  than about a month expanded per source; collapse the rest into an **"Older imports"** disclosure under
  that source. This is also what fixes the crowding-out the old global cap caused — each source keeps
  its own recent cards regardless of how active its neighbours are.
- **Archive grouped by year** inside that disclosure, which reads naturally for someone importing
  monthly over years. Apply the same treatment to the marketplace card path.
- **Re-bound the fetch, reachably — and only after the archive exists.** Paging that hides rows with no
  way to load them recreates the lossy cap under a new name. Budget for the response-shape change
  (array → a paged envelope), which ripples through the many list callers.
- **A deletion strategy, as a separate explicit opt-in:** purge old batch *history records*, never the
  transactions they imported, consistent with the existing trash timeframe-chooser idiom. Decide whether
  deletion is per-source or global, and whether it archives-then-purges or deletes outright.

## Pointers

- Backend: `list_batches` in `backend/routers/import_export/core.py` (the two queries, and the note on
  the reconcile pass).
- Frontend: `dataSourceRows` assembly in `frontend/src/pages/ImportExport.jsx`; rendering in
  `components/importExport/ImportHistorySection.jsx` and `MarketplaceImportHistory.jsx`.
- This is *retention and organization*. Render-window performance for long lists is a different question
  and lives in [`../scale-and-limits.md`](../scale-and-limits.md).
