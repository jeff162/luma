# List virtualization (render windowing for large lists)

**Status:** deferred, not blocking. Structural/perf work to do before transaction volume grows large.

## Why

Luma is built to accumulate **many** transactions over time. Several lists currently render every
loaded row as a real DOM node, so main-thread render/unmount cost and layout/hit-test cost scale with
node count — O(rows), not O(visible rows). At scale this shows up as multi-second freezes.

A performance trace (2026-06-30, **dev** build) showed several multi-second long tasks while large
lists rendered, plus a several-second delay just **closing** the duplicate report. Dev-mode React and
the React DevTools extension amplified that trace (installHook.js was ~55% of busy time), but the
underlying per-node cost is real and will bite in a production build once datasets are large.
Re-baseline any measurement with the **DevTools Components panel closed** on a **production build**.

> **Correction (2026-06-30, follow-up trace):** the "closing is slow" part was *not* unmount/DOM
> removal (that measured ~160 ms). Clicking the panel's × ran **two full re-renders of the entire
> row list** — the panel header's drag handle toggled a `dragging`/`resizing` state on mousedown and
> mouseup, and because those flags lived in `useDetailPanelChrome` (consumer scope) every consumer
> re-rendered its whole body twice per header click. Fixed by making gesture state internal to the
> hook (refs + imperative listeners + direct-DOM cosmetics), so drag/resize start/stop no longer
> re-renders any of the seven detail panels; a plain header click now costs zero re-renders. Also
> cached `formatAmount`'s `Intl.NumberFormat` (was ~725 ms of re-render self-time). Windowing is still
> needed to bound *initial mount* and the row count itself, and to make sort/filter/select-all
> O(visible) rather than O(rows).

## Already done (don't redo)

- **Truncation reflow storm removed.** `TransactionRow` no longer installs a per-row `ResizeObserver`
  or reads `scrollWidth` in a `useLayoutEffect` per row (that was thousands of forced reflows on a long
  list). Measurement is now a read-only post-paint effect plus an on-hover re-check. This reduced
  per-row cost but does **not** bound DOM node count — windowing still needed.
- **Ledger fetch is already server-paginated** (`/transactions`, `limit` + incremental load, sorted
  server-side — see `ui-patterns.md` "Long transaction ledgers…"). That bounds the *fetch*, but loaded
  pages still accumulate as DOM nodes; the ledger is **not** DOM-virtualized.

## The fix

**Windowing:** render only the rows in/near the viewport and recycle DOM nodes as the user scrolls, so
DOM node count stays ~constant regardless of dataset size.

**Build it into the shared table shells, not per page** (per `ui-patterns.md` "shared product
language" — virtualize once so every consumer benefits and behavior stays uniform):

- `MatchReport` (`components/importExport/MatchReport.jsx`) — the **duplicate-rows dialog** and the
  Amazon **reconciliation** report, which since 2026-07-13 both render through this new shared table
  (extracted from the duplicate dialog's old hand-rolled table). The worst offender (a single 6k-row
  bucket = ~100k+ DOM nodes; switching buckets, header-click re-sort, and even a single checkbox toggle
  — a new `selectedIds` Set re-maps all rows, which aren't individually memoized — all lag) and a
  contained surface, so **spike here first.** Note its sort and selection are **controlled** by the
  consuming report, so a windower must keep driving `onHeaderClick` / `selectedIds` / select-all against
  the full entry list, not just the mounted rows.
- `TransactionListTable` (+ shared `TransactionRow` cells) — the report/detail lists.
- The **Transactions ledger** renders its own rows (page-specific shell) but shares the row
  cells/controllers; it needs windowing too as loaded pages grow.
- `ImportRuleSuggestionReview` — many suggestion/merchant cards.

## Constraints the virtualization must preserve (why it's non-trivial)

- **Sticky pill header + single outer scroll container.** Per `ui-patterns.md`, the dialog owns both
  scroll axes through one container with the `PillTableHeader` pinned `position: sticky`; a nested body
  scroll clips the last column. The windowed body must live inside that one scroll container.
- **Column resize/reorder persistence** via `useColumnPreference` + the shared grid-template string
  (header and every row share one template). Windowed rows must keep using it.
- **Select-all-matching bulk edit** (`useBulkTransactionEditing`): selection resolves server-side from
  the filter, not from loaded DOM — compatible with windowing, but the per-row checkbox render and the
  in-place `setRows` reconcile/"linger" pattern must keep working as rows mount/unmount on scroll.
- **Server-side sort stays authoritative** (`ui-patterns.md`).
- **Variable / measured row heights** — notes, wrapped tags, merchant rename, child-account indentation
  on Accounts. Use a windowing approach that supports dynamic measured heights, not fixed-height-only.
- **Row popovers portal to `<body>`** (`RowPopoverPortal`) and must close when their row scrolls out
  (unmounts).
- The `'loaded'` select-all strategy (TagDetail) assumes all rows are in memory — verify its
  interaction with windowing.

## Approach

Prefer a **headless, measured-height** windower (e.g. TanStack Virtual) over a fixed-height list lib,
given variable rows; or a small hand-rolled windowing hook if the dependency isn't wanted. Spike inside
`MatchReport` against the duplicate dialog, prove the sticky-header + controlled-sort/selection +
select-all constraints hold, then lift into `PillGridTable` / `TransactionListTable` and the ledger.

**Done when:** on a production build with DevTools closed, opening/closing the duplicate report and
scrolling a large ledger stay sub-100ms tasks, and DOM node count for these lists is bounded by the
viewport rather than the dataset.
