# List virtualization (render windowing for large lists)

**Status:** effectively complete (2026-07-19). `MatchReport`, `TransactionListTable`, and the
**Transactions ledger** are windowed through the shared `WindowedRows` component.
`ImportRuleSuggestionReview` (a grouped card list, not a table) is **deliberately left unwindowed** —
it's the hard case with the weakest payoff; the obstacles and how a future attempt would tackle them are
recorded below as notes, not as a queued task.

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
- **`TransactionListTable` + the Transactions ledger are windowed (2026-07-19).** Both now render rows
  through the shared **`WindowedRows`** component (`components/WindowedRows.jsx`), extracted from
  `MatchReport` so all three share one windowing implementation (and the measurement/anchoring
  subtleties live in one place). Notes specific to these two:
  - **`content-visibility: auto` was removed from both.** Each row previously carried
    `content-visibility: auto` + `contain-intrinsic-size` to skip layout/paint for off-screen rows.
    That is redundant under windowing (unmounted rows aren't in layout at all) and actively harmful: an
    off-screen row reports its intrinsic-size *placeholder* instead of its true height, feeding the
    virtualizer a wrong measurement. Don't reintroduce it on a windowed row.
  - **The ledger's drag-select → Ctrl-C CSV copy was rebuilt on the bulk selection.** It used to read
    rows back out of the DOM (`data-txn-copy-row`) and intersect them with the browser's selection
    range, which only worked because every loaded row was a real node. It now runs off
    `useTransactionSelection` via a **Copy as CSV** button in the bulk bar (an opt-in `actions` slot on
    `BulkEditChrome`), and in all-matching mode re-fetches the full filtered result with the list's sort
    so the CSV order matches the screen — strictly more capable than the old drag (can copy every
    matching row, not just what fit on screen). `navigator.clipboard.writeText` only (the async
    clipboard API restricts writable MIME types, so the old parallel `text/csv` flavour is gone; CSV
    text pastes into spreadsheets fine).
- **Ledger fetch is already server-paginated** (`/transactions`, `limit` + incremental load, sorted
  server-side — see `ui-patterns.md` "Long transaction ledgers…"). That bounds the *fetch*; windowing
  now also bounds the DOM as loaded pages grow.

## The fix

**Windowing:** render only the rows in/near the viewport and recycle DOM nodes as the user scrolls, so
DOM node count stays ~constant regardless of dataset size.

**Build it into the shared table shells, not per page** (per `ui-patterns.md` "shared product
language" — virtualize once so every consumer benefits and behavior stays uniform):

- ~~`MatchReport`~~ — **done.** Was the worst offender and the spike surface. Sort/selection stay
  **controlled** by the consuming report: the windower drives `onHeaderClick` / `selectedIds` /
  select-all against the full entry list, never the mounted subset.
- ~~`TransactionListTable`~~ (+ shared `TransactionRow` cells) — **done.** The report/detail lists.
- ~~The **Transactions ledger**~~ — **done.** Its own page-specific shell, but rows now render through
  the same `WindowedRows`.
- `ImportRuleSuggestionReview` — the one surface left, and **deliberately not done.** See the section
  below for why it's the hard case and what a future attempt would have to solve first — this is a
  record of the obstacles, not a queued task.

## `ImportRuleSuggestionReview`: why it's the hard case (notes, not a plan)

This is the last unwindowed list, and it's excluded on purpose — meaningfully harder than the tables,
with a weaker payoff. If someone later decides it must be windowed, these are the obstacles in the way
and how each would have to be handled; none is a blocker alone, but together they mean this is a
restructure, not a drop-in of `WindowedRows`.

- **The list is grouped and heterogeneous, not a flat list of uniform rows.** In the normal (non-bulk)
  view, same-merchant suggestions collapse into one bordered container (`renderMerchantGroup`), and a
  top-level item can be any of four shapes: a single suggestion card, a conflict-set card, a
  settled-conflict *table*, or a merchant group wrapping several of those. Heights range from ~80px to
  1500px+. `WindowedRows` tolerates variable heights, but variance this extreme wrecks the total-size
  estimate and reintroduces the scroll-jump jitter windowing exists to prevent. *Handling:* window at
  the **merchant-group** granularity (the stable top-level unit), and give the virtualizer a per-item
  `estimateSize` derived from each group's member count rather than one global constant, so the
  estimate tracks reality before measurement corrects it. Bulk mode is already flat (one card each), so
  it's the easy path and could be windowed independently first.

- **It doesn't own a scroll container — it scrolls with the page.** Every windowed surface so far had a
  dedicated `overflow: auto` viewport with a sticky `PillTableHeader` inside it. This component instead
  walks up to `findNearestScrollParent`, and manually manages a sticky filter panel plus scroll
  compensation against that outer scroller. `WindowedRows` takes a `scrollRef` and assumes that element
  *is* the viewport. *Handling:* the honest prerequisite is giving the page a real bounded scroll
  viewport (its own `flex:1, minHeight:0, overflow:auto` region, like the ledger's Card) — that's the
  structural blocker and deserves its own decision, because it changes the page's scroll model and the
  sticky-panel math. The alternative — a document-scroller windowing mode in `WindowedRows` — is new
  surface area that was deliberately not built; don't add it for one consumer.

- **It reads its own rows out of the DOM** (the same footgun the ledger's CSV copy had, in more than
  one place). Bulk-anchor scroll restoration does
  `listTopRef.current.querySelectorAll('[data-rule-suggestion-id]')` to find and scroll a specific card
  into view; after windowing the target card is often not mounted. *Handling:* drive scroll-to-card
  from the virtualizer's `scrollToIndex` against the item's position in the data, not from a DOM query.
  Audit the whole file for other `querySelectorAll`/`getBoundingClientRect`-over-rows reads before
  starting — 3100 lines, likely more than one.

- **Cards mutate height in place** — inline category/tag/keyword editing and conflict-set expansion are
  the *primary* interactions here, not rare events. `WindowedRows` re-measures via ResizeObserver, so
  it copes, but each in-place growth can shift scroll position mid-edit. *Handling:* verify the
  expand/collapse animation doesn't fight the ResizeObserver (measure on animation *end*, or measure
  the final height and let CSS animate within it); accept that a card growing above the viewport will
  nudge scroll, or pin the edited card as the scroll anchor.

- **The payoff is smaller.** The tables could hit 6k+ rows; this is one card per *suggested rule*,
  grouped by merchant — realistically dozens to low hundreds of top-level groups. It's the surface
  least likely to actually stall. **If it ever does get slow, reach for memoization first:** wrap
  `renderSuggestionCard` in `React.memo` so a single edit stops re-rendering every card (same class of
  win as the `formatAmount` / `useDetailPanelChrome` fixes above), which is far less risky than
  fighting the grouping, the page-level scroll, and the DOM-reading scroll restoration all at once.

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
