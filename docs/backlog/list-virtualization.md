# List virtualization (render windowing for large lists)

**Status:** in progress. `MatchReport` is **done** (2026-07-19); the remaining surfaces below are still
unwindowed. Structural/perf work to do before transaction volume grows large.

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
- **`MatchReport` is windowed (2026-07-19).** It now renders through `PillGridTable` +
  `useColumnPreference` with `@tanstack/react-virtual` (measured heights) instead of its old hand-rolled
  `<table>`, so the duplicate-detection report, the Amazon reconciliation report, and the Amazon
  import-detail report all mount only the rows near the viewport. Three things learned here that the
  remaining surfaces will hit too:
  - **Windowing requires a content-independent column geometry.** The old `<table>` used
    `table-layout: auto`, sizing columns from whichever rows happened to be in the DOM — under windowing
    that makes widths jump while scrolling. Moving to `PillGridTable`'s `--pgt-grid` template fixed the
    widths first; windowing was only safe afterwards. `TransactionListTable` and the ledger already have
    this property, so they start from a better place.
  - **Row-id helpers must not scan the list.** `AmazonImportDetailDialog` resolved a row's index with
    `entries.indexOf(entry)`; a windower calls the id function per mounted row, making it O(n²). The
    `getRowId(entry, index)` signature now hands the index over.
  - **Each report needs its own column pref key** (`normalizeColumnConfig` drops unknown keys and appends
    defaults, so sharing one key across different column sets silently merges them). The Amazon
    import-detail dialog keys per *category tab* for the same reason.
- **Ledger fetch is already server-paginated** (`/transactions`, `limit` + incremental load, sorted
  server-side — see `ui-patterns.md` "Long transaction ledgers…"). That bounds the *fetch*, but loaded
  pages still accumulate as DOM nodes; the ledger is **not** DOM-virtualized.

## The fix

**Windowing:** render only the rows in/near the viewport and recycle DOM nodes as the user scrolls, so
DOM node count stays ~constant regardless of dataset size.

**Build it into the shared table shells, not per page** (per `ui-patterns.md` "shared product
language" — virtualize once so every consumer benefits and behavior stays uniform):

- ~~`MatchReport`~~ — **done, see "Already done" above.** Was the worst offender and the spike surface.
  Its sort and selection stay **controlled** by the consuming report: the windower drives
  `onHeaderClick` / `selectedIds` / select-all against the full entry list, never the mounted subset.
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

**Settled:** `@tanstack/react-virtual` (headless, measured heights), chosen over a hand-rolled hook
because the hard part is scroll anchoring — correcting the viewport when a row above it measures taller
than its estimate, which is the usual source of scroll jitter — plus a measurement cache that survives
unmount and `scrollToIndex`. It is already a dependency and already proven in `MatchReport`; reuse it for
the remaining surfaces rather than reopening the choice.

Remaining lift: `TransactionListTable` and the ledger, then `ImportRuleSuggestionReview`. Both transaction
surfaces already have persisted column geometry, which is the precondition `MatchReport` had to be given
first.

**Testing note.** jsdom does no layout, so a virtualizer under test renders nothing until the scroll
element and the rows are given real geometry. `MatchReport.test.jsx` stubs `ResizeObserver` plus
`offsetWidth`/`offsetHeight`/`getBoundingClientRect`, keyed off the row's `data-index` attribute so a row
never reports the viewport's height (which would make one row appear to fill the screen and silently
defeat the assertions). Reuse that harness for the next surface.

**Done when:** on a production build with DevTools closed, opening/closing the duplicate report and
scrolling a large ledger stay sub-100ms tasks, and DOM node count for these lists is bounded by the
viewport rather than the dataset.
