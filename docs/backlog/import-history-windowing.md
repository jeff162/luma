# Import-history archive UX

**Status: the lossy cap was fixed 2026-07-30; the per-source window, the by-year archive, the move onto
transaction coverage and the stored-detail maintenance screen were all built 2026-10-08/09.** What is left is the
fetch re-bound the archive unblocks. The
retention story — what the global `LIMIT 50` cost, why the display query is unbounded, and why the
best-effort reconcile pass on the same endpoint stays capped — is in
[`../scale-and-limits.md`](../scale-and-limits.md) → *Import history: retention*; the window and
archive as built are in `frontend/src/lib/importExport/importHistoryWindow.js`; what a card's recorded span means is in
[`../data-model.md`](../data-model.md) → *Import batches and profiles*, which also owns what clearing a
card's stored detail keeps and why each survivor has to survive.

## What is left to build: re-bound the fetch

Paging that hides rows with no way to load them recreates the lossy cap under a new name, which is why
this waited on the archive. It is no longer blocked there, but it is blocked on something larger:
**five consumers read `GET /import-export/batches` as an aggregate over all history**, not as a page of
it, and paging the endpoint under them turns a complete answer into a first-page one. They are
enumerated in [`../scale-and-limits.md`](../scale-and-limits.md) → *Import history: retention*; the
data-source manager's known-template-hash set is the one that becomes wrong rather than merely stale.
Give each an endpoint that answers its own question, then change the list's response shape (array → a
paged envelope) and budget for the remaining callers on the Import page.

## Pointers

- Backend: `list_batches` in `backend/routers/import_export/core.py` (the two queries, and the note on
  the reconcile pass).
- Frontend: `dataSourceRows` assembly in `frontend/src/pages/ImportExport.jsx`; the window and archive in
  `lib/importExport/importHistoryWindow.js` and `components/importExport/ImportHistoryArchive.jsx`,
  rendered by `ImportHistorySection.jsx` and `MarketplaceImportHistory.jsx`.
- This is *retention and organization*. Render-window performance for long lists is a different question
  and lives in [`../scale-and-limits.md`](../scale-and-limits.md).
