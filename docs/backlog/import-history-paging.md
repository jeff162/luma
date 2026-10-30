# Import history that stays fast as it grows

## What it is

Every import and sync adds a card to the import history, and the Import page loads the whole history
every time it opens. The page already shows only recent cards per source, with older ones in a by-year
archive, but the server still sends all of them. This project makes the server send a page at a time, so
opening the Import page costs the same after ten years of imports as after one.

**Where it stands:** not started. Not urgent until the history is long enough to slow the page. Blocked
on four other screens that use the same request to answer "across all history" questions (below).

Why the display query is unbounded today, and why the reconcile pass on the same endpoint stays capped,
is in [`../scale-and-limits.md`](../scale-and-limits.md) → *Import history: retention*.

## What blocks it

`GET /import-export/batches` returns the whole history. Four callers read it as an aggregate over all
history, not as a page of it. Paging under them
turns a complete answer into a first-page one. They are listed in
[`../scale-and-limits.md`](../scale-and-limits.md) → *Obstacles*. The data-source manager's set of known
template hashes is the one that becomes wrong rather than merely stale, since it guards against
re-importing a file.

## The work

1. Give each aggregate caller an endpoint that answers its own question.
2. Change the list's response from an array to a paged envelope, and budget for the remaining callers on
   the Import page.

The Connections panel's rollup sits on the Import page, which holds the whole history anyway, so moving
it ahead of the paging only adds a second fetch that has to be refreshed with the first. It moves with
the paging.

## Pointers

- Backend: `list_batches` in `backend/routers/import_export/core.py` (the two queries, and the note on
  the reconcile pass).
- Frontend: `dataSourceRows` in `frontend/src/pages/ImportExport.jsx`; the window and archive in
  `lib/importExport/importHistoryWindow.js` and `components/importExport/ImportHistoryArchive.jsx`,
  rendered by `ImportHistorySection.jsx` and `MarketplaceImportHistory.jsx`.
- Render windowing for long lists is a separate question, in
  [`../scale-and-limits.md`](../scale-and-limits.md).
