# UI Patterns

This document records the UI patterns Luma should prefer. It is not a full design system; it is a working reference for visual and interaction consistency.

This document defines UI behavior and interaction patterns. For underlying data structures and system flow, see `architecture.md` and `data-model.md`.

## Contents

- [Product intent](#product-intent)

- [General principles](#general-principles)

- [Page structure](#page-structure)

- [Tree views](#tree-views)

- [Section toggles](#section-toggles)

- [Row editing](#row-editing)

- [Pills and expanding selectors](#pills-and-expanding-selectors)

- [Empty states](#empty-states)

- [Drop zones and file inputs](#drop-zones-and-file-inputs)

- [Confirmation and completion flows](#confirmation-and-completion-flows)

- [Import-specific patterns](#import-specific-patterns)

- [Ownership and tag-driven reporting](#ownership-and-tag-driven-reporting)

- [Floating detail panels](#floating-detail-panels)

- [Theming](#theming)

- [Charts and overlays](#charts-and-overlays)

- [When to document a new pattern](#when-to-document-a-new-pattern)

## Product intent

Luma should feel polished, quiet, and immediately useful. The UI should support routine work in place rather than forcing separate admin or settings flows for common actions.

Polish is part of the feature, not a later cleanup step.

Baseline interaction expectations:

- overlays should open in the correct place on first paint

- menus and popovers should respect viewport edges and scroll containers

- controls should not jump, reflow, or visibly correct themselves after opening

- selectors and dialogs should render above surrounding content

- when multiple floating panels are open, the active/topmost one should carry the strongest edge and elevation while older panels remain readable but visually recede

- inline edit states should preserve layout stability whenever possible

If the user can already see the data they need to change, prefer enabling the change in place unless there is a strong reason to route it elsewhere.

Shared controls should be treated as finished product surfaces, not reused snippets. If a picker, menu, overlay, inline editor, or related control appears in more than one place, viewport behavior, scroll behavior, first-paint placement, and general polish should be handled as part of the shared control, not deferred to follow-up page-specific cleanup.

## General principles

- Keep layouts compact. Avoid large empty regions, oversized cards, and controls that read heavier than the data they edit.

- Treat the UI as the user's window into their data. If information is shown in its primary context, the user should usually be able to act on it there.

- Put editing where the data is primarily viewed. If a page is the natural place to inspect a thing, prefer editing it there instead of duplicating the same controls on Settings.

- **Creating is available wherever assigning is.** Anywhere the user picks a value from a managed set — a category, a group, a tag, a note, an owner, and so on — they can also create a *new* member of that set inline, in the same control, and have it applied immediately. The user is never bounced to a separate management screen just to mint the thing they want to assign: they invent it and assign it in one motion (create a category from the category picker, a tag from the tag picker). This is a deliberate stance that the UI must not get in the way of the user's actual intent. Only *creation in service of an assignment* has to be inline — deletion, renaming, reordering, and other maintenance can live on a dedicated screen, because that is not what the user is in the middle of doing. When adding a new picker/selector for any assignable thing, include its inline create affordance from the start rather than deferring it to "manage it in Settings."

- Favor consistency over novelty. When a control already exists elsewhere in the app, reuse the same interaction and styling unless there is a strong reason not to.

- Keep look and feel consistent across pages. Similar data structures should use the same spacing, controls, and interaction patterns so the app feels like one coherent tool rather than a set of isolated screens.

- Treat repeated UI elements as shared product language. Trees, pills, menus, inline editors, overlays, tables, selectors, and other controls that appear on more than one page should keep the same look, spacing, and behavior unless there is a very strong reason to diverge.

- **Search first, then build — reuse is the default, a one-off needs justification.** *Before* writing any UI element (a list, table, panel, dialog, picker, inline editor, button), find the existing shared component — check [`shared-components.md`](shared-components.md) (the "what do I use for X?" index) or grep for the concept — and reach for it. Do this *at the moment you decide how to build*, not just once at session start; reading the docs earlier is not the same as consulting them at the build decision. If genuinely nothing fits, state why you are introducing a new component in your summary. And do not shape a bespoke backend endpoint to fit a quick UI — check whether the existing endpoint plus a filter already returns what the shared component needs. (This rule exists because a one-off transaction list was built when `TransactionListTable` already had several users — the failure was not consulting the pattern at build time, not missing knowledge.)

- Treat recurring domain objects as shared product language too. When a user, account owner, category, account, or similar named thing appears on multiple screens, its basic add/edit/remove behavior should feel the same unless the workflow is genuinely different.

- The reason for this consistency is not only aesthetics. Reusing the same interaction language lowers relearning cost, makes the product feel more trustworthy, and avoids the impression that one screen is a lesser or temporary version of another.

- Shared form controls and dialog footers should come from shared primitives where possible so cancel/save rows and everyday input chrome do not drift across pages.

- **Native `title` tooltips are an acceptable choice, and sometimes the better one.** The shared `<Tooltip>` (`frontend/src/components/ui.jsx`) is the default whenever hover content needs theming, markup, links, or hover-into-it interaction. But a plain-text hint with none of those needs does not require it — a bare `title` attribute is fine. A native tooltip is also genuinely *better* in some cases: the browser draws it outside the page, so it auto-positions and can spill past the window edge, whereas the DOM `<Tooltip>` is viewport-clamped and can only ever stay inside the window. Where that edge behavior matters more than visual consistency — for example the Help page's section jump-nav — prefer native `title` and accept the look-and-feel mismatch as a deliberate trade.

- **A hint attached to a row of a scrolling list needs a dwell before it opens.** Pass `openDelay={ROW_HOVER_OPEN_DELAY_MS}` (from `ui.jsx`) to `<Tooltip>` there. With the cursor resting anywhere over the list and the rows moving under it — wheel, page-down — every row that passes counts as a fresh hover, so a zero-delay hint strobes a card per row. The dwell costs a user who deliberately stops on a row nothing and removes the flicker entirely for one who is just scrolling past. `Tooltip` also closes itself on any scroll: it is positioned once in fixed coordinates against where its trigger was, so without that it would hang detached in mid-air while the row scrolled away. **Note this is only fixable for our `<Tooltip>`** — native `title` timing is entirely browser-owned, so a hint that needs a dwell cannot stay a `title`. The Amazon reconciliation and import-detail order/charge cells are the reference case. `openDelay` defaults to 0, which is right for the common case of a small button or icon.

- When a UI behavior is meant to be shared, implement the shared behavior first. Do not land a one-sided or page-specific version and plan to “sync it up” later unless the narrower scope is intentional and explicitly documented.

- Before changing a UI interaction, decide whether it is page-specific behavior or shared product language. Shared product language should be implemented and reviewed with parity across all affected surfaces from the start.

- When a screen has a dedicated close action in its header or panel chrome, prefer placing that close control at the upper right unless that surface already follows a stronger established pattern.

- Keep advanced and less-common settings below everyday workflows.

- Use inline editing for lightweight data changes; reserve dedicated forms or modals for multi-step or higher-risk actions.

- Treat transient edits as cancellable work. If a control enters a temporary edit state, the user should normally be able to back out without keeping the in-progress value, and similar transient controls should behave the same way across the app unless there is a strong reason to differ.

- Let the user control presentation where it materially helps them work. This includes things like panel placement, list scrolling, filtering, and other layout choices that improve usability without turning the app into a fully user-designed interface.

- Remember a user's working UI state across pages when it materially helps them resume work. Things like panel open/closed state, table layout, and similar view preferences should use the shared per-user/profile preference model with local cache plus best-effort backend sync, rather than one-off page-specific persistence.

- Prefer user control over hidden inference when the choice affects meaning. For example, ownership, mapping, and destructive actions should be explicit when there is more than one reasonable interpretation.

- Long transaction ledgers should let the user change sort directly from the column headers. When the list is paged or incrementally loaded, the sort should be applied by the backend so the whole filtered result stays in one consistent order.

- If a table header supports more than one interaction, the affordances should still read as one clean surface. Pill-style headers are a good fit when the label handles sort and move while the resize target remains visually tied to the column it changes. In scrollable tables, dragging a resize control should normally change that column's width directly instead of silently reallocating space into its neighbor.

- Pill-style multi-interaction headers should come from a shared header component rather than page-local copies. Sortability, drag-to-reorder, resize, and uncommon per-column actions such as a context menu should all be individually optional so quieter tables can reuse the same visual language without inheriting every behavior.

- When a screen needs the full pill-header table pattern, prefer a shared table shell that owns the header, column resize/reorder wiring, and shared grid template. Individual pages should still own row rendering, selection, sorting semantics, and data loading unless those behaviors become meaningfully shared too.

- When a pill-header table is hosted inside a modal or dialog, the dialog should own both axes of scrolling through a single outer scroll container (for example `flex: 1, min-height: 0, overflow: auto`) with the pill header pinned via `position: sticky`. A nested vertical scroll inside the table body will consume width from the grid's last column when the scrollbar appears and clip the rightmost cell. The duplicate-rows dialog on the Import / Export page is the reference implementation.

- When column order or widths materially affect how a user works, that table geometry should persist through the shared per-user preference model instead of resetting every time the page or dialog opens. The shared `useColumnPreference(prefKey, defaultColumns)` hook (`frontend/src/lib/useColumnPreference.js`) is the one way to wire this: it returns `[columns, onColumnsChange]`, merging the saved order/widths over freshly-computed defaults (clamping persisted widths, dropping unknown keys, appending new columns). The usual host is `PillGridTable` (the duplicate-rows dialog and the matching-imported-transactions report spread it straight in). A table that can't adopt the full `PillGridTable` shell can still reuse the hook for persistence and drive a plain `PillTableHeader` from its merged widths — the Accounts list does this (see the horizontal-sizing note below). Either way, reuse the hook rather than re-implementing the merge.

- **A list that can grow past a few hundred rows should be windowed, and windowing requires a column geometry that does not depend on the mounted rows.** Render only the rows in/near the viewport through the shared **`WindowedRows`** (`components/WindowedRows.jsx`, measured heights on `@tanstack/react-virtual`) so DOM node count is bounded by the viewport rather than the dataset — `MatchReport`, `TransactionListTable`, and the Transactions ledger all use it. The precondition is that column widths come from the shared grid template (`PillGridTable`'s `--pgt-grid`, fed by `useColumnPreference`) rather than from the browser auto-sizing a `<table>` against its content: an auto-sized table re-computes its widths from whichever rows are currently in the DOM, so columns visibly jump as the user scrolls. Three invariants a windowed list must not break: **sort and selection stay driven from the full entry list**, never the mounted subset (select-all must keep meaning "all filtered rows"); any per-row id helper must not scan the list to find a row's index — the windower calls it per mounted row, which turns an `indexOf` into O(n²); and **do not put `content-visibility: auto` on a windowed row** — windowing already keeps unmounted rows out of layout, and the `contain-intrinsic-size` placeholder feeds the virtualizer a wrong measured height. A corollary for anything that read rows out of the DOM (the ledger's old drag-select CSV copy did): after windowing only the mounted rows exist, so drive it from the selection/data instead. See `docs/backlog/list-virtualization.md`.

- **A long, name-keyed list can be browsed with alphabetical sections + an A–Z jump rail, and it composes with windowing.** The Rules page is the reference: the (pre-sorted) list is flattened into one mixed `WindowedRows` stream of section-header items and row items (`buildSectionedRuleItems`), so a single windowed scroll container carries both. A horizontal **"Jump to:" A–Z strip** sits in the fixed header region (under the search box, so it stays put while the list scrolls) and shows every letter always — present letters are active (click jumps via the virtualizer's `scrollToIndex`, since the target header may be unmounted), absent ones dim, and the letter at the top of the viewport is highlighted (fed by `WindowedRows`' `onTopIndexChange`). Section dividers are **not** sticky — true sticky-in-a-virtualizer isn't worth its complexity, and the rail's running highlight already gives orientation. Prefer this over a collapsible letter tree for a *flat* set (rules aren't hierarchical; collapse/expand would add a toll between the user and every row).

- **The shared date filter separates a *setting* (persisted, per-page default) from a *filter* (ephemeral, explicit, shared).** The app-wide date chip starts **unset** (no seeded default — an earlier hardcoded "past 12 months" seed reappeared on every reload and leaked between pages, which is exactly the surprise to avoid). "Unset" is then reinterpreted **per page**: the **Dashboard** treats it as its own configurable **default period** (`ui.dashboard.defaultPeriod`: `ytd`/`last12m`/`all`, set via the ⚙ gear beside the title), while **Transactions** treats unset as all-time. This resolves the old tension — *different defaults, but a shared explicit choice*: once the user picks a date it's honored on both pages, and clearing returns to each page's default. The default never leaks because it's a **page-local reinterpretation of unset**, not a value written into the shared filter. Mechanism: `FilterContext` exposes `getDate()` (`filters.date || dashboardDefaultDate`, the read counterpart to `setDate` — prefer it over reading `filters.date` directly) and `dateIsDefault`; the Dashboard registers its resolved default via `setDefaultDate` on mount and clears it on unmount, so a default is only ever in effect on the page that set it. The chip renders the default **muted with a "· default" hint** so an in-effect default is never a hidden filter. There's no "Automatic" menu choice; instead the **first-visit seed** picks the initial concrete default — **Last 12 months if the current year has data, else All time** (a one-shot, session-cached probe, so loading old historical data doesn't open the Dashboard on an empty window) — and persists it as a normal choice, so it never re-evaluates behind the user's back. The Dashboard **holds its first paint** until that seed resolves rather than flashing all-time. An explicit **"All time"** preset (a truthy `{start:null,end:null}` sentinel) *overrides* a default, distinct from unset — so trend helpers that key on a concrete range treat it as no-window. **The Dashboard trend chart is deliberately independent** of this default (it has its own rolling window); only the totals/breakdown/drills follow `getDate()`. `lib/dashboardDefaultPeriod.js`, `lib/FilterContext.jsx`, `components/FilterBar.jsx`.

- **Search and structured filter are two separate tools, and a page-local filter must not couple to the app-wide `FilterContext`.** A free-text **search** box narrows by one obvious field (the Rules page searches *merchant only* — never the category/tags, so it can't flood), while a **Filter** popover narrows by structured facets (category, tag, owner, account, type, boolean flags) shown as removable chips; search runs within the faceted subset. The app-wide `FilterContext` (the Transactions/Dashboard `FilterBar`) deliberately *persists across pages* — a per-page filter like the Rules one must stay independent of it and is instead **session-scoped** (`sessionStorage`, like the Transactions `quickFilter`): it survives navigation but resets on next launch, so a user never returns to a mysteriously filtered page. Draw facet options only from values actually present in the data, so the filter never offers a choice that matches nothing.

- **Two-line "sentence" rows beat a fixed-column table when both sides are variable-length.** The Rules row puts the matcher on line 1 and the actions on line 2, both wrapping under the same rules — which removes the incoherence a 2-column grid produced (one cell clipped with an ellipsis while the other wrapped to three lines). Reach for this shape when a row's left and right content both grow unpredictably; keep the table only when columns genuinely align.

- **Bulk cleanup is opt-in, previewed, and reversible.** The Rules page's stale-rule cleanup is the reference: the user picks a timeframe that **starts unset ("—")** so nothing is ever swept by default; choosing one surfaces a count and a review panel listing the matching rules **each pre-selected with a per-row control to keep it**; confirming moves the set to a **trash** (recoverable), not a hard delete. Destructive intent is separated from safe intent — the batch is **retain-by-default** (leave the data the rules produced alone) with an explicit opt-in to also revert it. A "sort by X" that reorganizes the same list (here **Last used** vs the default **A–Z**) is a mode toggle that swaps the whole view (the alphabetical version's section rail hides in the chronological one), not an additive control. When you add a new kind of deletable object, give it a bucket in the existing Settings → Trash surface (restore + purge + empty), consistent with accounts/transactions — don't invent a separate recovery flow.

- **A filter's category picker must stay findable as the taxonomy grows — group it, make groups selectable, and add a type-to-filter box.** A flat category checklist is unusable at scale. Both filter surfaces follow the same shape: categories are **grouped under their parent group**, a **type-to-filter search** appears once a list passes a small threshold (~8), and a **group is itself selectable** (matches any leaf under it) so a user need not tick a dozen leaves. The app-wide `FilterBar` goes further — the old separate *Groups* and *Categories* tabs are now **one collapsible, selectable tree** (check a whole group, or expand and check leaves; default collapsed; a search force-expands the hits). This is the reference for a picker over a real hierarchy; the Rules popover uses the lighter grouped-checklist form of the same idea. When you fold two selection surfaces into one tree, preserve every selection token the old surfaces emitted (here: `type:'group'`, `type:'category'`, the super-group income/expense select-all, and the synthetic NULL-bucket ids) so downstream consumers are unaffected.

- **Any facet selection can be *include* or *exclude* ("is not"), and the primary click always means include.** In the app-wide `FilterBar` a facet row's main click adds/removes it as an **include** (the historical, unchanged gesture — zero relearning). Exclusion is a **single, quiet, always-present `≠`** on the row's right edge: persistent so the option is *discoverable*, but visually secondary (muted, low-opacity) so it never reads as a second competing button to aim between — the reference resolution when a per-row secondary action is needed but "two equal affordances" is the wrong feel. A `✓` marks an included row; the `≠` itself turns danger-colored to mark an excluded one. The **chip** is the second place to flip mode: clicking a chip body toggles include↔exclude (an excluded chip reads in the danger hue with a leading `≠`), mirroring the row. Each selection carries `mode: 'include' | 'exclude'` (default include) in `FilterContext`; **pages must split selections by both type and mode** — an exclude chip fed into an include param would silently invert its meaning. Exclusion is offered on **every** facet, tags included: excluding a tag is the inheritance- and block-aware inverse of including it (`NOT (effective_tag_match_sql)` — a row that has the tag directly *or* via its category/group/account is dropped, and a row that only inherits it but has it manually hidden survives). The tags tab also leads with a synthetic **Untagged** row (no effective tag at all, `'__untagged__'`) — the complement of "has any tag," so `≠ Untagged` filters to only-tagged rows; it's always present even before any tags exist and mirrors the category *Uncategorized* / owner *unassigned* buckets. Beside it sits a synthetic **Recurring** row (`'__recurring__'`, `recurring_series_id IS NOT NULL`): recurring membership isn't a tag but shares the row's tag marker strip and rides the tag facet, so `tag_filter_membership_sql` carries it to **every** surface the tag filter reaches — the ledger, the Dashboard totals/trends/drills, and the CSV export — with no per-endpoint plumbing, and `≠ Recurring` (its NULL-safe complement) scopes to one-off rows. This is the reference for folding a non-tag row-level flag that lives in the tag strip into the tag facet rather than threading a new param through every summary endpoint. Semantics: includes within a facet OR; excludes AND on as NULL-safe negations (tags negate a null-free `EXISTS`, so plain `NOT`, not the COALESCE guard); across facets everything ANDs (see `data-model.md` → filter exclusion). When a filter feeds more than one surface, exclusion must reach **all** of them at once (the Transactions ledger, every Dashboard totals/trend/drill call via `summaryFilters`, and the CSV export) — a chip that filtered one page but not another would be a split-brain; that is why the exclude params ride the shared `summaryFilters` object rather than being wired per-call. **The tag filter (`effective_tag_match_sql`) is one shared definition** across the ledger, summaries, and export, so a tag chip means the same thing everywhere; the CSV export was quietly matching *direct tags only* before, silently omitting rows tagged via their category/account — a real bug the unification fixed. When an exclude chip removes a slice the active Dashboard spending report breaks down, a quiet inline note says so (see next bullet); the exclude is still honored, never suppressed.

- **Warn when a filter leaves out what a report is showing — quietly.** When the filter removes a slice the active Dashboard spending report would otherwise break down — `≠ Business` on a tag report built from Business, `≠ Groceries` on the category report, an excluded category inside the group you've drilled into — show the shared **`FilterConflictNote`** (`components/ui.jsx`) above the breakdown. The overlap is computed client-side by `computeReportSpendingConflicts`/`describeReportConflicts` (`lib/reportFilterConflicts.js`): the report axis and the chips both live in front-end state, so it's a set intersection with no server round-trip. Deliberate boundaries keep it from crying wolf: **like-for-like only** (tag chip↔report tag, category chip↔category slice, group chip↔group slice) so an *indirect* account/owner filter that happens to drop a category never triggers it; and **view- and totals-aware** (skip `exclude_from_totals` rows and the other income/expense view's groups, which the report never showed — so a standing `≠ Transfers` chip doesn't nag). **Tag reports flag two symmetric cases** (each conflict carries `reason: 'excluded' | 'missing'`): a report tag `≠`-excluded, *or* — when a tag *include* filter is active — a report tag missing from that include set, since including only tag A on a report built on {A,B} drops B's rows exactly as excluding B would. For **group/category** reports the include case is *not* flagged (a category has one group, so an include chip is ordinary focusing, not co-occurrence distortion) — see `docs/backlog/tag-report-exclude-warning.md`. The note names up to two slices then "and N more"; its action (`resolveConflictSelectionIds`) drops the offending exclude chip ("Clear exclusion(s)"), or for any tag-report conflict clears every tag chip ("Clear tag filter") — a missing tag has no chip of its own to drop, and the button is named after what it does rather than a report-outcome promise. The same `FilterConflictNote` is reused for the Transactions "your filter is hiding matches" zero-results note (next bullet).

- **When the ledger comes back empty, say whether a filter is *hiding* matches — but only when it truthfully is.** The Transactions list, on settling to zero rows, runs a lazy server **probe** (`lib/searchHidingProbe.js` → `planHidingProbes`): it re-issues the same query with one *subtractive* constraint dropped and checks whether rows appear. The order is date window, then exclude chips, then (if both are active) both together — first non-empty probe wins and sets the note via the shared `FilterConflictNote`, with an action that clears exactly that constraint. Only the **zero-results path** pays the cost (one or two `limit:1` calls), and a filter change cancels an in-flight probe. Two rules keep it from crying wolf: a probe **keeps the search text and every include facet** and drops only subtractive constraints, so a non-empty result means "things matching what you actually asked for exist outside the filter" — not just unrelated rows; and it **only probes when there's a narrowing intent to preserve** (a `quick_filter` search, an include facet, or the needs-review toggle) — with only a bare date/exclude active and no intent, dropping them surfaces unrelated transactions, which isn't a useful thing to announce, so it stays silent. Include facets are never dropped: an include that yields nothing is genuine emptiness, not the filter hiding data. This is the deliberate counterpart to the Dashboard report-overlap note — same component, opposite surface (a list that went empty vs. a breakdown missing a slice).

- **The Transactions ledger's amount filter is *page-local*, like the quick filter — not part of the shared FilterBar.** A compact toolbar popover (`components/AmountFilterControl.jsx`) reuses the **exact same `AmountCondition`** control the rule editor uses (`RuleForm.jsx`, now exported): Both/Debits/Credits, Range/Equals, a per-bound comparator (`>=`/`>`, `<=`/`<`). Semantics mirror the category-rule amount clause — the magnitude bounds compare against **`ABS(amount)`** while the debit/credit **side rides the existing `direction` param**, so the sign applies separately (e.g. "credit, ≥ $50" → `amount <= -50`). It is deliberately *not* a shared-FilterBar facet: the FilterBar persists across pages and feeds the Dashboard, but an amount slice is a ledger-only working filter, so it lives beside the ledger's quick filter as **session-scoped** page state (survives navigation, resets on next launch) and reaches the backend through the same `_build_transaction_filter` params (`amount_min`/`amount_max`/`amount_min_op`/`amount_max_op` + `direction`), so bulk "select all matching" resolves the exact filtered set. Because an amount filter that yields nothing is *genuine* emptiness (like an include facet, not a subtractive constraint), it registers as **narrowing intent** in `planHidingProbes` but is never a droppable probe — the date/exclude "hiding matches" note still fires correctly with an amount filter active. When a new precise, page-scoped predicate (that also exists as a rule condition) is needed on the ledger, prefer this shape — a page-local popover reusing the rule control — over extending the fuzzy OR-based quick-filter grammar or adding a shared-FilterBar facet.

- **The Recurring page's drill-down serves single-series, all-series, and suppressed-series reports through one paged list.** The bottom drill-down (`ReportPanel` + `usePagedTransactions`) is keyed on `openSeries`, and the member fetch branches on it:
  - a real active/confirmed series → **`recurring_series_id`** (its linked members);
  - the **all-series report** → a synthetic marker (`{ id: '__all_recurring__', _all: true }`) → **`recurring_only`** (every row linked to any series). It's launched by the **standard report `↗`** sitting in the `PageHeader` `titleAdornment` beside the "Recurring Transactions" title (not a header button — the ↗ is the app's report-launch affordance). The synthetic id matches no `SeriesCard`;
  - a **suppressed** series → it owns no rows (suppress nulls its members' `recurring_series_id`), so a `recurring_series_id` fetch would be empty and the "N transactions" link would look broken. It falls back to the series' **`payees` (+ `account_ids` when account-scoped)** so the link still surfaces the transactions the series would cover, without re-linking them. (This matches by the exact visible payee label, so a user-renamed suppressed series may under-match — acceptable for a "not recurring" bucket.)

  The per-series **removed-from-series** section only applies to a single real series (an `excluded` override is per-series). The drill-down **sizes to fill**: the series list above shrinks to its content (capped at ~50%) while the report takes all remaining space (`flex: 1`), so a short list — even one series — yields a large report rather than a fixed strip. A recurring **filter** that also reaches the Dashboard is a separate mechanism — see the tag-filter `Recurring` bucket above.

- Transaction troubleshooting can temporarily repurpose a less-critical column, such as Category, for debug context like the import-file source, but it should not displace the primary merchant label. Prefer a tucked-away header action such as a context menu over a persistent page-level button for these uncommon views, and reuse the same file-detail drill-in wherever an import file source is shown.

- **A rare action must not outweigh the state it sits beside.** Where a row carries both a status and an
  action, the status is what every row has and the reason the row is read at all; the action is often one
  most installations will never take. Give the action *less* visual weight than the status — same shape,
  smaller — rather than reaching for the shared `Button`, whose default size makes the rarest thing in the
  row the loudest. Two things follow. A control taller than the status chip beside it also sets the row's
  baseline, so an action added to some rows and not others silently knocks those rows' text out of
  alignment with the rest. And a verb alone (**Reset**, **Regenerate**) rarely says *when* someone would
  want it, so carry the reason in a hint rather than in the label. The Settings → Configuration rows are
  the reference.

- **Columns only line up across rows if the rows share a track definition.** A list of independently
  styled row "cards" — each its own `display: grid` so it can carry its own background, padding, and
  indent — computes `max-content` per row, so every row places its second column wherever *its* label
  happens to end, and the list reads as ragged. Either give the rows one shared width (a named constant,
  sized for the longest label, with `minmax(0, …)` so a narrow container shrinks them together) or use
  the content-sized template only where a single grid spans every row (the tag rows on Settings). An
  indented child row must give back exactly its indent from the label column, or everything to its right
  sits one indent off the lines the rest of the list shares.

## Page structure

Most pages should follow this structure:

1. A `PageHeader` at the top.

2. One or more `Card` blocks or list/table regions underneath.

3. Primary actions placed near the data they affect.

4. Scroll inside long data regions when the list grows large, rather than making the whole page excessively tall.

Prefer page-local scrolling for long lists, with header and controls remaining visually stable above the scrolling region.

When a page hosts several distinct management surfaces that don't need to be seen at once, prefer **in-page tabs** over a stack of collapsible cards — each surface gets the full width/height of the content area and the page reads as one thing at a time. The Import/Export page (`Import / Export / Backup`) and the Accounts page (`Accounts / Owners / Connections`) both use this: a simple tab-button row under the `PageHeader` over conditionally-rendered content. The active tab is **session-scoped** (mirrored to `sessionStorage`, not the durable preference store), so it persists while the app is open but resets to the primary tab on next launch — a within-session convenience, not a saved preference. A surface that *is* the only thing on its tab should render its content directly (or in a non-collapsible panel), not in a collapsible card — there's nothing to collapse it away from.

### Horizontal sizing of data regions

Two different surfaces respond to a narrowing pane in two different, deliberate ways, and the choice follows from what the region *is*:

- **Wide data tables** (the Transactions ledger, the Categories matching-transactions list) have columns with hard min-widths and **scroll horizontally inside their own clamped viewport** once the pane is narrower than that floor. The table chrome around them (titles, filters, action buttons) should wrap or reflow — only the table body scrolls.

- **Entity/management lists** (the Accounts list) **never grow a horizontal scrollbar** — a scrollbar on a list the user navigates and drags would be worse than letting columns adjust. The Accounts list keeps **one fluid filler column** (the primary label, e.g. account Name, as `minmax(0, 1fr)`) that absorbs all slack, so the table always exactly fits its container. Its other data columns (Type/Owner/Tags) are **user-resizable fixed-pixel columns**: resizing one reflows the fluid Name column rather than widening the table, so resizing can never produce overflow. The fixed drag-handle and delete gutters stay constant. This is the deliberate counterpart to the wide-data-table pattern above: that one scrolls; this one reflows. Widths persist via `useColumnPreference` (keyed `ui.accounts.columns`); because the Accounts row is hand-rendered (drag-to-merge, child indentation, owner pills, inline tag picker) it keeps its own `PillTableHeader` + list rather than adopting `PillGridTable`, sharing one computed grid-template string between the header and every row. Now that the table is the sole content of its own tab (it no longer shares a width with the sparse Owners/Connections panels) it sits at a modestly wider fixed width, giving the fluid Name column more room by default. The truncated label still surfaces its full text via a hover tooltip, so narrowing a column never hides information. Name itself carries no resize grip — a fluid column has no fixed edge to drag (widen it by shrinking the others); making Name directly draggable would require giving it a pixel width and accepting horizontal scroll when over-widened (the wide-data-table model).

When a flex/grid column *hosts* a horizontally-scrolling data table, that hosting column must clamp its own width or the table's min-width escapes it: use a `minmax(0, 1fr)` track (a bare `1fr` carries a `min-content` floor and will push the table past the viewport, where an ancestor `overflow: hidden` clips it with no scrollbar) and `min-width: 0` on the cell/flex item (whose default `min-width: auto` causes the same blowout). Only once the host is clamped does the table's own `overflow: auto` engage and produce the scrollbar.

## Tree views

Tree views should use the same visual grammar wherever they appear.

- Each child level should begin under the first letter of the label above it.

- The hierarchy should read primarily through label alignment rather than heavy guide lines or decorative chrome.

- Controls that belong to a row may sit to the left of that label start, but the text alignment should define the structure of the tree.

- Expand/collapse controls should stay close to the label they affect.

- On the Accounts page, merged child accounts should read as a lightweight second level under the parent account rather than as a second flat table with repeated owner/type columns.

- Protected system groups, such as `Unassigned` on the Categories page, should behave like filtered fallback buckets rather than normal editable groups. They should stay at the bottom of their section. The transaction-presence filter applies only to **still-pending imported labels** (`import_pending`): an empty pending label is hidden as triage noise. A **settled system category** under `Unassigned` (`import_pending = 0` — recovered, user-created, or organized-then-emptied) is a real category the user chose to keep and surfaces regardless of transaction count; otherwise recovering an empty category would look like it vanished.

- Protected system rows should read differently from ordinary editable taxonomy rows. Use italic labels for immutable system buckets such as `Unassigned` and the synthetic `Uncategorized` child it can surface when uncategorized transactions exist.
- When uncategorized transactions need different debit/credit presentation, keep that split synthetic. Expense-side uncategorized rows may stay under `Unassigned`, while uncategorized credits may surface as a separate income-side system bucket such as `Other Income` without creating a real stored category.

## Section toggles

Settings uses collapsible top-level sections.

- Collapsed controls should be compact rounded drops, not full-width bars.

- The expanded content should be slightly indented beneath the toggle.

- The most common single-user sections should appear first.

- Multi-user, auth, and tenant-oriented sections should appear lower on the page.

- When collapsed, descriptions should be very short.

- Longer explanatory text belongs inside the expanded pane, near the controls it explains.

### What a collapsed card must still be able to say

Collapsing is only worth offering when what it hides is routine detail. Two kinds of thing therefore have
to survive it, or collapsing quietly costs the user something:

- **Anything asking to be acted on.** Attention counts, failure states, "N to map", "N to review" — a nudge
  that only appears once a card is expanded is a nudge that will not be seen, and a card people collapse to
  get it out of the way is exactly the one they will stop expanding. These belong in the collapsed header,
  not merely inside.

- **The routine action itself.** If the thing a user comes to the card to do most often (the connection
  cards' "Sync now") requires expanding first, collapsing has a recurring cost and stops being used. Note a
  mechanical constraint here: a collapsible header is itself a `<button>`, so an action placed in it must
  be rendered as a **sibling** of the toggle rather than inside it — a nested button is invalid HTML and
  would also toggle the card on every click. `SectionCard`'s `headerActions` slot is that seam.

The counterpart is what a collapsed header should *not* carry: context that answers no question and asks
for nothing (a mode badge, a provider's environment) can sit last or be dropped entirely.

**Two badges must not describe the same thing at two levels of usefulness.** A connection needing to be
reconnected is also, technically, a failing connection — but showing "1 failing" beside "reconnect needed"
adds a count of attempts for something that will never succeed on its own, and the reader has to work out
that both refer to one connection. The specific, actionable pill wins and *suppresses* the generic one
(`providerSummary` excludes `reauth_required` connections from `failing`). The rule generalizes: when one
state is a strict subset of another, the narrower badge replaces the broader one rather than joining it.

**A per-card notice earns its place beside a header badge when it names which item.** The collapsed header
has to summarize across everything under it, so with several connections it can only say "2 need
reconnecting" and put the names in a tooltip. Restating it on each card is not duplication — it is where
the user is standing when they act, and the only place that identifies the one they are looking at.

### Show a past moment as an absolute timestamp, not as "5 minutes ago"

A relative label is computed when the component renders, so it is only correct at that instant. On a page
left open — or one whose data has since been refetched without a re-render — it drifts silently: "5m ago"
can be an hour old, and nothing about it says so. Worse, the reader has no way to distinguish a fresh
label from a stale one, so the friendlier-looking format is the less trustworthy one.

An absolute date and time is true whenever it happens to be drawn, which removes the whole class of
problem rather than papering over it with a refresh timer. Use `formatTimestamp` (`lib/utils.js`);
callers supply their own empty-state wording ("Never synced", "Never used"). This is what the connection
cards and the import-profile list both show.

## Row editing

For account rows, owner rows, and similar editable lists:

- Each item should read as a single row.

- Clicking the visible value should enter edit mode when practical.

- Avoid separate `Edit` buttons for simple text changes.

- Keep row height stable between display and edit states so the list does not jump.

- Destructive actions should stay near the row they affect and use the same red `x` pattern used elsewhere.

- Account merge behavior should stay in-place on the Accounts page: drag handles start the regrouping gesture, eligible drop targets stay visually clear, and child rows hide owner/type fields instead of duplicating parent metadata.

- Dragging a grouped parent onto another top-level account or account group should flatten the dragged group's visible members under the new parent instead of preserving a nested merge tree.

- Child accounts should remain detachable from a merged group through the same in-place drag model. Pulling a child into a visible top-level gutter is preferable to forcing a separate unmerge action elsewhere.

- Sending a merged child account away should use the app trash flow rather than immediate hard deletion, with recovery managed from Settings.

Inline row creation should usually happen inside the existing list, not in a detached panel above it.

### Inline edit commit behavior

Inline editors share two intents that must stay distinguishable so the same gesture means the
same thing everywhere:

- **Renaming an existing, already-saved value in place** (a merchant, account, owner, category,
  data-source name or description, etc.) commits on blur. Enter commits, Escape reverts to the
  pre-edit value, and clicking away saves. This is the least-surprising default and is what
  users expect when they click a value to change it. The shared primitives
  (`useTransientTextEdit` + `TransientTextInput`) provide this as the default; an editor opts in
  simply by not overriding `onBlurCommit`.

- **Naming a brand-new thing or a multi-field form** (create / add / save-as boxes, login and
  setup forms) uses an explicit submit and does **not** commit on blur (`onBlurCommit={false}`).
  Click-away must not silently create a half-specified entity or fire a partial form, and these
  surfaces carry their own Add / Save / Cancel affordances.

The one deliberate exception is the payee rename in the transaction detail panel
(`TransactionDetail.jsx`), which keeps explicit Save/Cancel buttons; commit-on-blur there would
make Cancel dead, so it stays button-driven even though it edits the same field as the row.

#### Escape cancels the local edit — and only that

Across the app, `Esc` follows one rule: it **cancels the current local edit, restores the pre-edit
value, and does not bubble up to close the surrounding popover, dialog, or page**. If there is no
active local edit, `Esc` does nothing at that layer. This is enforced by the shared primitives, not
per-page handlers:

- **`TransientTextInput`** owns Escape for a focused field: it `stopPropagation()`s so the key never
  reaches a container's Escape handler, then either reverts-and-blurs (`CANCEL_EDIT`, the default) or
  reverts-and-returns-focus-to-its-trigger (`REVERT_DRAFT_AND_RESTORE_FOCUS` + `restoreFocusRef`, for a
  chip/expanding editor). A container that *should* close on the same Escape does so through the
  editor's `onCancel` callback — never by catching the raw bubbling event.
- **`useDismissibleLayer` / `useDismissiblePopup`** own Escape for a popover/menu/picker (close on
  Escape). A layer that wraps a *raw* editable field (not a `TransientTextInput`) and must not close
  mid-edit passes `ignoreEditableTarget: true`.
- **Chip / expanding editors that revert component state** (open/collapsed) or a **non-scalar draft**
  (e.g. the Rules editor's multi-clause keyword list, which reverts a whole array snapshot) can't be
  modeled by the single-field primitive, so they orchestrate their own Escape — but to the same
  contract: capture a snapshot on open, revert + restore focus to the trigger + `stopPropagation` on
  Escape. `RuleForm`'s clause chip is the reference; its single-value *rename* chip uses
  `TransientTextInput`'s `REVERT_DRAFT_AND_RESTORE_FOCUS` directly.

Never add an app-wide/global `Esc` listener for this — each editor or layer owns its own Escape, gated
on being open/active, so legitimate behaviors elsewhere are never disturbed.

## Transaction rows

Transaction tables should share the same row-level metadata treatment.

- Notes and transaction tags belong in a shared marker strip near the amount column rather than being rendered differently on each page.

- Tags should use one fixed shared glyph, with user-selected color carrying the visual identity.

- Hovering a tag marker should reveal its label, and clicking row markers should use the shared inline popover patterns instead of page-local dialogs.

- **Needs-review marker.** A row still flagged `needs_review` (freshly imported/synced, not yet looked over) carries a quiet amber `R` in the same strip with a tooltip. It is a **distinct glyph**, not a colored dot, precisely so it doesn't read as another tag (tags use one fixed glyph with color carrying identity). Its color is the themeable `--review-marker-color` variable (per-theme so it stays legible on light surfaces); a future Settings → Appearance swatch will override it per user, which is why it is a variable from the start rather than a hardcoded value. The marker is non-interactive — clearing happens via a manual category edit, the row context-menu "Mark reviewed", bulk Mark reviewed, or the per-batch "Mark all reviewed". See the `needs_review` field in `data-model.md`.

- **Recurring marker.** A row that belongs to a recurring series (its `recurring_series_id` is set) carries a quiet `↻` glyph in the same strip with a "Part of a recurring series" tooltip. Like the `R` marker it is a distinct glyph (not a tag) and always shown when the row carries the flag — it appears wherever the list feed supplies `recurring_series_id` (the Transactions ledger and the recurring drill-down, both backed by the `/transactions` endpoint); detail lists fed by summary endpoints that don't select the column simply omit it. It anticipates the planned "mark as recurring" row action and edit-screen checkbox, which will write that membership.

- **Excluded-from-totals marker.** A row whose category (or its parent group) is `exclude_from_totals` — transfers, card payments — can carry a quiet `⊘` marker in that same strip plus a slightly dimmed amount, with a tooltip explaining it isn't counted in spending totals. It is driven by the list endpoint's per-row `excluded_from_totals` flag (`COALESCE(parent-group, leaf, 0)`) and is **opt-in per surface** (`markExcludedFromTotals` on `TransactionListTable`): it shows only where a list sits beside a total that omits those rows and would otherwise look wrong — the account-activity panel (`AccountDetail`), whose cash-flow list shows *all* the account's movement while its total and chart exclude transfers. Surfaces that list rows without any total (the Transactions and Categories ledgers) leave it off, and surfaces whose list is already view-filtered to spending/income (the Dashboard drills, `PeriodDetail`) never include an excluded row to mark. The deliberate choice is to keep the excluded rows visible and *explained* rather than dropping them — they are real transactions — or silently letting the count/total disagree with the visible rows.

- Note editing goes through one shared editor (`components/NoteEditor.jsx`) wherever a transaction note is edited — the row's note popover and the transaction detail panel both render it — so the interaction never diverges by surface: a multi-line field where ⌘/Ctrl+Enter saves (plain Enter inserts a newline), Escape cancels the edit, Save stays dimmed until there is an unsaved change, and a Remove action clears an existing note. Persistence (the API write and reconciling the host's row) stays with the host via the editor's `onSave`; any new surface that edits a note should reuse this editor rather than re-implementing the field and its shortcuts.

### An edited transaction lingers where it was found

Editing a transaction must never make it vanish from under the user's cursor. When a filtered or scoped list shows a row and an edit changes the row so it no longer matches that scope — categorizing while "Uncategorized only" is active, recategorizing a row out of the category the Categories panel is scoped to, etc. — the row is **patched in place and left visible**, restyled to show the new value, not removed. The reason is correction ergonomics: a mis-tap stays correctable, and the user can keep working the same row (add a tag, a note) before moving on. The list is reconciled to its filter only when the user asks, via the **Refresh** affordance the surface carries (`↻ Refresh`), which re-queries and drops the rows that no longer match.

This is the single principle behind several specific behaviors documented below and elsewhere: the bulk-edit in-place reconcile, the rule-apply reconcile (`reconcileRowsAfterRuleApply`), and the per-row inline category edit all keep edited rows on screen and defer pruning to Refresh. A surface that lets the user edit rows inside a scope that the edit can fall out of should follow the same model — linger plus an explicit Refresh — rather than auto-pruning. (The one deliberate non-linger case is trashing a row, which drops immediately, and applying a *rule* to existing rows, which sweeps immediately because undoing it is heavier.)

### Per-row editing is shared by every transaction list

Every list of transactions should offer the **same** per-row editing affordances, so the user never has to learn which surface lets them do what. These all live in the shared cells (`components/TransactionRow.jsx`) and are wired once by the shared `TransactionListTable`; a host turns them on by passing the matching callback rather than re-implementing the interaction:

- **Merchant** — click-to-rename in place (commit-on-blur, the default inline-edit behavior) plus a `↗` that opens the **merchant activity report**. Always on for rename; the `↗` appears when the host passes `onTransactionOpenDetail` and `showMerchantReport` isn't turned off (it's off on a list already scoped to one merchant, where the `↗` would be self-referential — `TransactionDetail`'s own payee activity list).
- **Category** — click-to-edit through the shared `CategoryPicker` (`onCategorySave`) plus a `↗` to the category's spending history (`onCategoryOpenDetail`).
- **Amount strip** — the note and tag markers edit in place, and a trailing **pencil** opens the full transaction editor (the same `onTransactionOpenDetail`, but unmarked). The inline note/tag popovers portal to `<body>` (`RowPopoverPortal` in `TransactionRow.jsx`), positioned `fixed` against their anchor: transaction rows carry `content-visibility: auto` (paint containment), which makes each row its own stacking context, so a popover left in normal flow gets trapped behind the rows that follow it. Any new in-row popover must portal out the same way rather than relying on `position: absolute` + `z-index`.
- **Right-click menu** — the `ContextMenu` (Edit transaction · Create rule / Open matching rule · Add/Edit note · Tags… · Send to trash) and its editors are one shared controller, `lib/useTransactionRowActions.jsx` (the `useTransactionRowActions` hook + its `TransactionRowActionsChrome` companion, mirroring `useBulkTransactionEditing`/`BulkEditChrome`). A host attaches the hook's `onContextMenu` to its rows and renders the chrome once; the host stays the source of truth for its rows, passing `onOpenDetail` (Edit transaction), `reconcileRow` (patch after a note/tag edit), and `removeRow` (drop a trashed row, adjusting any total/child panel). "Create rule / Open matching rule" routes through the shared `RuleActionModal` (`components/RuleActionModal.jsx`) after an async match lookup, so the menu offers the right verb. `TransactionListTable` wires this controller for all the report/detail lists (gated on `onTransactionOpenDetail` and off in bulk-select mode); the **Transactions ledger renders its own rows** — because it carries page-specific shell behavior the shared table deliberately doesn't (server-side pagination/sort, the quick-filter, the Category↔Source column swap, the account `↗`, clipboard copy) — but it consumes the **same** `useTransactionRowActions` controller, so the row menu has a single implementation across both.

The deliberate stance is **completeness over context-minimalism**: where an affordance *can* exist it should, so the only reason one is absent is that the context genuinely can't support it — e.g. a `CategoryDetail`'s own list omits the category `↗` because every row already shares that panel's category, and the Dashboard category-drill omits it because the dashboard navigates categories by pie-drill rather than a category panel. A floating detail panel that gains row editing hosts the opened editor/report as a **child panel** (the `AccountDetail` → payee `TransactionDetail` pattern), so edits reconcile back into the parent list and the child closes with its parent.

**`TransactionDetail` is two surfaces in one, chosen by the trigger, not two components.** Its top is a single-transaction **editor** (category/tags/notes/origin for the clicked row); its bottom is the **merchant activity report** (payee trend + a month-scoped, fully editable transaction list with bulk edit). The **pencil / "Edit transaction"** opens it whole; the **merchant `↗`** opens it as the report by suppressing the editor card. The trigger conveys this by tagging the open payload (`_merchantReport: true`, set in `MerchantCell`) the same way the duplicate report carries `batch._dateFilter` — so no host plumbs an extra prop, and `openDetailPanel`/`setPayeeDetail` payload-replacement flips an open panel between the two modes. This is the deliberate alternative to a separate `MerchantDetail`: it would have been a near-verbatim clone of `CategoryDetail`/`AccountDetail` differing only in scope, so the merchant report reuses the payee machinery that already lives in `TransactionDetail`. (If a third report axis ever made the clone pressure real, the right move is extracting one `ScopedActivityReport` the three compose — not three near-duplicates.) The report's own activity list runs the full shared row actions and bulk edit, but turns off the merchant `↗` (self-referential here) and the category `↗` (a merchant report stays on the merchant axis — and it would also form a `CategoryDetail`↔`TransactionDetail` import cycle).

### Bulk select and edit

A "Bulk Edit" toggle puts a transaction table into bulk mode: a leading checkbox column appears with a select-all checkbox in its header, and a bulk action bar offers Edit… (a `BulkEditPanel` — category, tag add/remove, notes, merchant, date) and Move to trash.

**One shared controller owns the behavior** — `lib/useBulkTransactionEditing.jsx`. A host calls the hook with `{ rows, setRows, total, filterParams, categories, … }` and gets back `toggle`, `tableProps` (spread onto `TransactionListTable`), and a `<BulkEditChrome controller={…}/>` companion that renders the action bar plus the edit/confirm/notice dialogs. The host renders only its own toggle *button* (placement is page-contextual) and spreads `tableProps`; everything below — selection, the apply call, the in-place reconcile — lives in the controller, so a new surface is a prop-pass, not a re-implementation. Underneath it still composes the shared leaf pieces: selection state `lib/useTransactionSelection.js`, the editor `components/BulkEditPanel.jsx`, the header `SelectAllCheckbox` (`ui.jsx`), and the write `api.bulkUpdateTransactions`.

- **Select-all has two strategies.** Default (`'filter'`): the header checkbox switches to "all matching", and the API resolves the set server-side from the host's `filterParams` (passed via `toSelectionPayload`), so it covers rows past the loaded page. `'loaded'`: for a list whose visible rows are a *client-side* subset no server filter can re-resolve, select-all instead checks every loaded row by id (ids mode) — the rows are already fully in memory, so "all" needs no server round-trip. It fits only a fully-in-memory, **unpaginated** list; a paginated list must use `'filter'` (its loaded rows are only one page). No panel currently needs `'loaded'` — TagDetail used it while its slice was a client-side post-filter, but now that the slice is fully server-resolvable (`require_all_tag_ids` + `exclude_tag_ids`) it paginates and uses `'filter'` like the rest. Individually unchecking after select-all adds to an exclude set.
- **`filterParams` must mirror the host's list fetch exactly**, including any date/account/owner/tag scope. A select-all payload that omitted the date on a period-scoped list (the Dashboard drills, the month panels) would silently edit rows outside the visible scope — the same hidden-filter hazard called out for detail-panel date scope.
- The select column is injected at render only (never persisted into the user's column config) and is non-sortable/non-draggable/non-resizable; its header checkbox uses the pill header's per-column `render` hook (`PillTableHeader`) rather than a sort pill.
- Delete is soft-delete to the transaction trash (recoverable from Settings → Trash), confirmed before running — not a separate "hidden" state.
- **Apply reconciles the loaded rows in place** (hosts pass `setRows`), so the user's sort order and scroll position survive a bulk edit. Trashed rows drop; field changes (including recategorization that moves a row out of the current scope) are patched onto the visible rows and *linger* — a mis-tap stays correctable and a Refresh (where present) prunes rows that no longer match. A host whose source of truth is a paginated re-fetch (the Transactions ledger) passes `onReload` instead of `setRows`.
- **The edit panel is draggable** (`AppDialog draggable`): its backdrop is transparent and click-through and the header is a drag handle, so the form can be moved aside to read — and still act on — the ledger behind it. Position is session-only and re-centers on reopen.
- Wired on: the Transactions page, the Categories matching-transactions list, both Dashboard single-period drill tables (selected category, selected group), and the floating detail panels — PeriodDetail, CategoryDetail, AccountDetail, ImportBatchDetail, and TagDetail. The duplicate-detection dialog deliberately stays on its own `row_number`-keyed selection (its finite, non-server-filter selection doesn't fit this model).

**Report dialogs use a lighter intersection bulk bar, not the transaction bulk controller.** The `MatchReport`-based reports (the duplicate-detection report and the Amazon reconciliation report) bulk-resolve via `MatchReport`'s built-in `selectable` checkbox column plus a report-owned bar below the filter pills: each bulk button shows the count of *selected rows that support that action* (the intersection — e.g. Merge only counts mergeable duplicate rows, Accept/Dismiss only split suggestions) and disables at zero. The intended workflow is filter-to-one-kind → select-all → apply. Actions that need a per-row choice (pick which duplicate copy survives, pick which charges cover an order) are deliberately not bulk actions; a per-row button should only be offered where it will actually succeed (the Merge button is gated on the backend's `mergeable` flag rather than letting a guarded call error).

**The duplicate report describes a pair by the account grouping in force now, not by the premise that raised the flag.** A soft-flag's stored reason is a record of *why it was raised* — almost always "these are on different accounts" — and merging those accounts retires that premise without touching the flag. Left alone, the badge asserts a cross-account match on a report whose two sides print the same account name (a merge rewrites a child's `display_name` to the group root's), which reads as a bug and sends the user looking for one. So the rule badge, its filter pill, and the row's reason text all come from re-deriving the relationship at read time (`_IN_ACCOUNT_RULE_KEYS`, `list_unified_batch_duplicates`): a pair whose accounts share an effective root reads as *"Possible duplicate in this account"* / *"Duplicate in this account (confirmed)"*, and a detach puts it back. What is **not** re-derived is the tier: exact-vs-near-miss is evidence about the two rows, which a merge does not change, so an exact in-group match is still auto-confirmed on merge and a near-miss is still review-only — the merge changes how the flag reads, not whether it was decided. The general rule for any surface that replays a stored verdict: state the verdict as stored, but derive from current state anything the *user can still change*.

**Every transaction a match report names carries the ledger's origin hover.** A `MatchReport` row summarizes each side as "date · merchant · amount" — which is exactly the projection that hides *why* the two rows were paired, since the dedupe rules compare captured source text and a pair can match on a descriptor neither visible merchant shows. So each side of a duplicate-report entry (incoming, matched-existing, and every coverage candidate) carries an `origin` object — the same captured-field shape a ledger row exposes — and the dialog wraps the cell in the shared `MerchantOriginHoverCard` (`components/OriginFields.jsx`, the same card the transaction list and the Amazon reports use, at the same `ROW_HOVER_OPEN_DELAY_MS` dwell). Without it, auditing a flagged pair means leaving the report to find both rows in the register, which is where the answer was all along. Backend side: `_attach_origins` fills `origin` in one pass over the finished entries for anything with a `txn.id`; a hard-rejected row never became a `txn`, so its origin is rebuilt from the stored `txn_payload` plus the reporting batch's own provenance. A side with no captured detail renders no hover rather than an empty card (`hasFileOriginDetail`).

**Applying a rule to existing rows reconciles the same way — in place, not by re-fetch.** When the per-row "create rule" toast (`RuleSuggestionToast`) applies a rule to existing transactions, the rows it recategorizes must update *on screen but stay on the list* — re-running a scoped query (e.g. an "uncategorized only" drill) would drop the now-recategorized rows out of view, which reads as the data silently vanishing or, worse, lingering with the old category. So the apply endpoint (`POST /rules/{id}/apply`) returns the **`transaction_ids` it changed**, threaded through the toast's `onSaved`, and the host calls the shared `reconcileRowsAfterRuleApply(rows, ids, setRows)` (`lib/txnMutations.js`): it re-fetches just the affected rows that are *currently on screen* by id (the transaction-list endpoint's `ids=` filter) and merges them back in place, so they keep their slot with the new category. Wired on the in-place surfaces that surface the toast — the Dashboard drills, the Categories matching list, and the payee `TransactionDetail`. The Transactions ledger is the deliberate exception: as the one paginated source of truth it stays on a full `load()` (matching its bulk-edit `onReload`).

### Copy for sharing

Any surface that shows a transaction or a list of them carries a small copy affordance (`CopyTransactionsButton`, a quiet copy glyph) so a user can lift the data out to paste into an email or notes without gathering fields by hand. It opens one app-wide read-only dialog (`TransactionShareDialog`, via the `useTransactionShare` context provider mounted at the App root) that shows a **dense, decoration-free preview** and a **Copy** button.

- **One transaction → a labeled record of every captured field** (date, amount, merchant, account, category, tags, notes, then the full from-the-file origin block the edit panel's "Show more" reveals). The single-transaction copy lives on the `TransactionDetail` **editor** header (next to the trash) — not the merchant-report mode, which offers the list copy instead, mirroring where the single-transaction trash lives.
- **A list → a compact table** of the standard ledger columns (date, merchant, category, account, amount) for the rows currently shown. Wired on every transaction list: the merchant/category/account/tag/month detail panels (next to their Bulk Edit toggle), the Dashboard drills, and the Transactions ledger (whose older select-and-copy of the visible columns stays as the in-place complement).
- **The preview *is* the clipboard output.** Both come from one formatter (`lib/transactionShare.js`), so what the user sees is what they paste. Copy writes **both** a rich HTML `<table>`/record (so Gmail/Outlook/docs receive clean structure) **and** a plain-text fallback (labeled lines for one transaction, TSV for a list) — never app chrome or decorations. New transaction surfaces should reuse this button + context rather than re-implementing a copy path.

If a list introduces the same kind of object the user already manages elsewhere, start from the existing row/chip behavior first. A lighter presentation is fine, but it should still preserve the same core expectations for clicking, editing, Enter/Escape, and removal.

## Pills and expanding selectors

Use compact pill-style controls for values like owner, account type, and other small categorical fields.

- Closed state: show the current value in a rounded pill sized to the text.

- Open state: expand into the space needed for the dropdown or selector.

- Avoid heavy full-width selects when the value itself is short.

- When open, overlays should render above nearby content rather than underneath it.

- Opening a selector should not change row height or shift surrounding rows.

- A condition that can hold **repeated sub-values** expands in place rather than opening a separate editor: the rule editor's *Merchant Name Contains* chip (`RuleForm`) starts as one text box and grows an "and contains" row per added clause (capped, with a per-extra-clause remove and a "＋ and contains…" affordance), reading as one AND'd condition. The chip summary and the Rule Summary line render the clauses joined with "and". Keep the first clause un-removable (clearing the whole chip is the chip's own ×) so the primary value always has a stable home, mirroring how the fluid primary column works elsewhere.

For category assignment, prefer the shared category picker so transaction pages, import mapping, and any future category assignment flows behave the same way.

- Category pickers and the Categories page should reflect the same persisted group order so users do not learn one structure in the editor and see another while categorizing transactions.

- Top-level category groups should default into alphabetical order within their income or expense section until the user explicitly drags that section into a custom order.

## Empty states

Empty states should be brief and quiet.

- Prefer `None.` or `No accounts yet.` over long instructional copy.

- Keep the empty-state card close in width and height to nearby sections.

- Put the primary action inside or immediately adjacent to the empty state.

- Avoid oversized boxes for simple “nothing here yet” states.

## Drop zones and file inputs

When a file-upload action is important, prefer a visible drop zone over a bare browser file input.

- Use the same visual pattern across the app where possible.

- The control should support both clicking to browse and dropping a file.

- Keep the text concise and task-specific.

- If the loaded file becomes editable text, switch to the editor after load rather than trying to keep two separate controls visible.

## Confirmation and completion flows

Do not rely on browser `confirm()`, `alert()`, or `prompt()` dialogs when the rest of the app has a clear UI style.

- Use in-app confirmation overlays for destructive actions like restore.

- Use the shared app dialog primitives for notice, confirmation, and short text-entry flows so copy, button layout, and dismissal behavior stay consistent.

- Confirmation and completion steps in the same flow should use the same visual language.

- Avoid dismissing important confirmation modals by backdrop click if the user needs to make an explicit choice.

- Success dialogs should usually have one clear next step.

## First-run onboarding

First-run setup should feel like a guided welcome, not a blank admin prompt.

- If the app is waiting on the first user decision, the screen should explain what each choice means instead of only presenting raw fields.

- It is acceptable to use the application name on this screen and related auth/setup entry points, but it should come from the shared build-time app-name setting rather than hardcoded copy.

- When local mode is active and no user profiles exist yet, setup may collect several related defaults at once if they help the user get started: who uses the app, optional account owners, and what setup screen to open next.

- First-run setup should not feel like a wall of options. Prefer compact collapsed decision blocks for secondary choices, with the minimum required action remaining clear.

- Deeper onboarding guidance should be available from the same screen, but tucked behind a deliberate `More information` or similar affordance so users who only want to get started are not forced to read it first.

## Help and contextual explainers

Feature guidance is authored once in a single content registry (`frontend/src/help/content.jsx`,
`HELP_TOPICS`) and surfaced three ways from that one source, so the popover, the standalone Help page,
and the in-context tip can never drift in copy. Each topic is `{ id, title, surfaces, summary, body }`:
a one-line `summary` sized for a popover and a longer `body` for the `/help` page.

- **Standalone Help (`/help`, `/help/:topic`).** `pages/Help.jsx` renders the topic index and each
  full body. A reached-from path is carried in `Link` `state.from` and surfaced as a `Return to <page>`
  link on both the index and a topic page; `HelpLink` (not a bare `<Link>`) and the index/topic links
  forward it so the affordance survives hops within the Help section. The left-nav Help item carries no
  `from`, so arriving that way shows no return link. `labelForPath` (`help/navigation.js`) maps the path
  to a human label — sub-routes (e.g. `…/rule-suggestions`) get their own name ahead of the top-level
  section.

- **In-place viewer (`HelpTopicDialog`).** "Read more" from an inline explainer opens the topic's full
  body in a portal'd overlay rendered above everything (z-index past the floating-panel stack) rather
  than navigating the page. This is what lets a `?` or tip *inside a floating panel* (e.g. the
  duplicate-detection report) show its full guidance on top of that panel instead of behind it — the
  user keeps their place and closing the overlay returns them to exactly what they were doing. Inside
  the viewer, `HelpLink` cross-links switch the dialog's topic in place (via `HelpNavContext`) instead
  of routing. The viewer already shows the full body, so its footer links to the `/help` *index* (a
  distinct destination, not a repeat of the same text) and stamps the page behind the overlay as
  `state.from` so the index offers a `Return to <page>` link back. The overlay carries
  `data-modal-overlay` so a panel underneath yields Escape to it.

- **Always-present `?` (`FeatureExplainer`).** A small `?` button next to a stable feature surface that
  opens the topic's `summary` plus a "Read more" link to `/help/:id`. Use it where the surface is always
  present and the guidance is always relevant (e.g. the amount-convention picker, the duplicate-report
  header, the Group Imported Categories title, the Accounts merge area).

- **Placement convention — page-level vs feature-level `?`.** A page or surface that has a single
  *overview* topic ("what is this page") puts its `?` in one consistent launcher spot: **immediately to
  the left of the page/surface title**, so the launcher is a stable anchor regardless of title length.
  `PageHeader` exposes a `help` slot for exactly this; surfaces with their own header (the Accounts
  `<h1>`, the Group Imported Categories modal, the duplicate-report panel header) place the `?` left of
  their title the same way. A `?` that explains *one control* instead stays next to that control (the
  amount-convention picker, the Transactions search box, a Categories group's exclude-from-totals
  toggle) — those are not page-level and do not move to the title.

- **Context-triggered "explain this" (`ContextualExplainer`).** The counterpart for guidance that is only
  relevant when the app *recognizes a situation* — a two-stage affordance so it informs without nagging.
  While the host surface reports the situation as live (`active`), it first shows a quiet inline **tip
  callout** (the same registry summary + "Read more"); once dismissed it collapses to the persistent `?`
  popover so the guidance stays one click away for re-reading. The persistent popover reuses
  `FeatureExplainer`'s panel, so the callout and the `?` are the same content. The host decides when the
  situation is live and passes `active` — the help layer never reaches into domain state itself (e.g. the
  duplicate report passes its own ±2-day / cross-account counts; the rule-suggestion review passes whether
  a conflict set exists).

- **Dismissal is per-tip and persisted.** It uses the shared user-preference model
  (`ui.help.dismissedTips`, a `{ [tipKey]: true }` map via `useUserPreference`) — local cache plus
  best-effort backend sync, and covered by backup like other ui preferences. `tipKey` defaults to the
  topic id but is set explicitly when one topic anchors several surfaces, so each surface's tip dismisses
  independently. The reason dismissal persists rather than living in component state is that a tip the
  user has read and dismissed should stay dismissed across sessions, while still leaving the `?` behind
  for the rare re-read.

- **Global on/off + reset.** A single `ui.help.hintsEnabled` preference (default true) gates the
  proactive callouts: when off, `ContextualExplainer` skips the callout stage and shows only the
  persistent `?`, so turning hints off never hides the guidance — it just stops pushing it. The Help
  page (`/help` index) carries the manage control: a "Show first-use hints" toggle plus a "Reset hints"
  action that turns hints back on and clears `ui.help.dismissedTips` so every tip shows again on its
  next encounter. The first-run welcome screen also offers a "Skip first-use hints" toggle; because it
  runs before a preference profile exists, the choice is written to the new profile's
  `ui.help.hintsEnabled` right after it's created (the keys live in `frontend/src/help/preferences.js`).

The import/reconciliation guidance is authored from `docs/import-reconciliation-playbook.md`, which
stays the content source of truth; keep the topics in step with it as the tools evolve.

## Import-specific patterns

CSV import has a few special rules:

- **The upload flow is drop-first, not pick-first.** The import screen opens to a plain CSV drop zone; the data source is *detected* from the dropped file by matching its header fingerprint against the saved data sources. Exactly one match applies automatically, several open a small chooser to pick among the matches, and none falls back to a temporary draft — so the common case is "drop the file and go," with no up-front data-source question. The explicit data-source picker still exists for the cases that need it, surfaced on demand: a "Choose a data source" link on the upload screen, "Start over" on the mapping screen, and "Change" once a source is selected. An *explicit* pick (not an auto-detected one) still runs the header-mismatch verification so a wrong choice is caught and changeable. This replaces the older model that asked the user to choose a data source (or Skip) before dropping a file, and the first-run-only variants of that prompt.

  - **Multiple files can be selected at once — a shortcut for importing them one at a time.** The drop zone / file picker accepts several CSVs. Each is previewed and grouped by data source (the same header-fingerprint signal), and **every file becomes its own batch / history card** — the natural per-file result, preserving each file's own coverage window, dedup, undo, and provenance (the importer runs the single-file path N times; nothing is merged). The mapping stage is driven by the first file's preview and that one mapping is applied to all files in the group. **The account column is the exception that unions across files:** when the file has an account column, the mapping UI shows the union of that column's distinct values across *every* file in the group (`unionPreviewColumnValues`), so a value that appears only in a later file is still mapped, not silently misrouted. At import, each file receives only the account config for the values it actually contains, so a "create new" account is created by the first file that holds it and reused by name for the rest (the backend's find-or-create-by-name), never duplicated. Requirement: **one data source per import** — if the selection spans more than one source, a chooser lists the files grouped by detected source and the user picks *which source to import now* (re-run for the others). All-same-source goes straight to the mapping screen (the import button reads "Import N files"), imports sequentially with a progress count, and finishes with a summary dialog rather than the single-file review screen — per-file detail (rejected rows, duplicates, rule suggestions) lives on each file's card below. The mapping screen is driven by the first group file that is **not** itself an already-imported duplicate (`previous_batch`), so a duplicate sitting first in the selection doesn't put the screen into the "already imported" state and block importing the others; if *every* selected file was already imported, a notice says so and no mapping screen opens. A file whose content was **already imported** (e.g. a duplicate copy in the selection, or a match to a prior batch) is **skipped, and the rest continue** — the backend returns a structured `409` (`reason: 'already_imported'` + the matched file's name) that the loop catches per file, and the summary names each skip ("`X` has already been imported [as `Y`] — Skipping"; `formatSkippedImportMessage`). Whole-file skip fires only when re-importing would add *nothing*: an account-column file re-used to import an account that was *skipped* the first time is **not** blocked — its new account imports and the already-imported accounts' rows fall to ordinary row-level dedup. A single-file selection is unchanged: it still uses the full single-file review flow. Grouping is `groupFilesBySource` (pure, in `importDraft.js`); the aggregate summary is `buildMultiFileResult` (`importOutcome.js`). (Amazon imports batch differently — one card per *drop* — which is a known wart; see `docs/backlog/amazon-batch-by-period.md`.)

  - **Why the "Data source: X" tag above the drop zone is still present but rarely seen.** It renders only when a source is *explicitly* selected and the chooser is closed — i.e. only after the user picks one through "Choose a data source" / "Start over" / "Change". It is deliberately **not** seeded by implicit/leftover state: there is no last-used-source preference re-applied on load, "save as data source" only adopts the new source while actively mapping the matching file (never from a completed import or the data-sources list), and `resetImport` ("Import another file", Cancel, undo) clears the selection so the next file returns to the drop-first auto-detect screen. The rule is **explicit pick → show the tag (it confirms which source the dropped file will use, with Change); auto/leftover → no tag**. Keeping the tag for the explicit case is why it stays in the UI even though most imports never show it.

- If header rows start after line 1, surface the detected skipped-row value immediately and offer the raw file as an explicit review step rather than forcing it open by default.

- If the file tail looks like footer or non-transaction data, force the user to review it before continuing.

- True validation errors should open the raw viewer as well; do not bury them only in summary counts.

- If a file already carries meaningful categories, the import mapping screen should let the user use the categories present in the data so imported transactions can keep those categories, missing categories can be added under `Unassigned`, and the file can contribute to system-wide rule suggestions.

- Controls for using categories present in the data should support partial filtering by owner and by unassigned-account bucket without changing which rows are imported. The scope changes only how imported categorization is applied and learned from.

- Organizing imported categories out of `Unassigned` should use the dedicated left-column/right-column workspace from Import / Export so users can sort categories into groups in bulk without working through the general category editor. There is a **single** organize surface — the system-level "Group Imported Categories" workspace, seeded from the live `Unassigned` leaves — not a per-source or per-batch variant. The left column is the pool of unassigned categories; the right column is the group layout.

- The workspace's right-hand group column is a draft, but it must always reflect the *live* top-level groups: groups created (or renamed/removed) on the Categories page after the draft was first seeded have to appear as drop targets. The draft is reconciled against the current category tree on open — new groups are surfaced, deleted groups drop out, and any categories the user had sorted into a now-deleted group return to the inbox rather than vanishing. A draft must never present a frozen, stale set of groups.

- **The Group Imported Categories workspace is a temporary landing spot for *imported* labels only.** Its columns show only pending imported categories (`import_pending = 1`) — never user-created categories, and never a category that has already left. A label leaves the workspace **permanently** the moment it is organized into a group or deleted; it never returns, even if it later ends up back under `Unassigned`. (So a user-created category, and a deleted-then-recovered one, live under `Unassigned` on the Categories page but do not reappear here.)
- **Set aside is parking, not deletion** — keep the two distinct. Parking a pending label in the Set Aside list (drag, or the "set aside" button) moves it out of the "needs sorting" pool but leaves the category fully **active**: its transactions keep it and future imports of the label still categorize to it, and it may stay parked forever. Set-aside and group placement are draft edits committed together on **Apply** (so the workspace's undo/redo covers both); on Apply the parked labels get their `set_aside` flag set (and anything restored to the pool or organized into a group is un-parked). A set-aside category is **never** shown in the Categories page "Inactive" list — only deleted categories are.
- **Delete** is the separate, explicit way to remove a category (a "delete" button + a "Delete…" item menu in the workspace, and the Categories-page delete dialog). It deactivates the category (its transactions clear or reassign), moves it to the "Inactive" recovery list, and suppresses the label from future imports. **Recovering** from "Inactive" returns the category to **the group it was deleted from** (or `Unassigned` if that group is gone) as a permanent system category — never back into the workspace. The workspace's Delete clears the transactions (they keep their imported label); use the Categories-page delete dialog when you want to reassign them to another category instead.

- The Import-page actions for organizing imported categories and generating rules should show the remaining actionable count. A set-aside (parked) label stops counting as still waiting without being removed.

- Mapping screens should allow partial completion when that is a valid workflow.

- The column-mapping field section should be shared between the import preview and saved data source editing so suggestion pills, required states, and account mapping behavior stay aligned.

- **A data source declares how far it lags its bank, as a plain day count.** The data-source editor's *Days this source lags the bank* field writes `csv_import_profile.terminal_window_days` (see `data-model.md` → the terminal *window*); it is the one dedupe knob exposed to the user, because it is the one fact only the user knows — whether a source relays another system's records (a bank, a budgeting app: the default of 7) or publishes its own (a store, a payment service: 1). It is deliberately framed as a **property of the source**, not as a matching tolerance: the field asks how the export behaves, and the coverage math derives what to do about it. The default assumes a lag, because most sources have one and the error is one-sided — assuming none when there is one deletes a real transaction from the ledger, while assuming one that isn't there only costs a reconciliation pass. Both ends are clamped rather than validated (1 to 30, backend and form alike) — 0 would push coverage past the source's own last date, and a value large enough to matter at the top end has already stopped doing anything useful. The setting is editable after the fact and patches independently of the rest of the form, since the right value is discovered by watching a source miss things rather than known when it is first saved.

- Recent-import file cards may use the same small `↗` detail affordance used elsewhere in the app to open a file-scoped ledger view of the transactions imported from that file. The same `↗` marks the other count pills that open a report (rejected rows, duplicates), so a pill that drills into a report is visually distinct from a static label pill (the account chips, which only describe what the file contained). Reuse the `↗` rather than restyling the whole pill; the glyph is the shared "opens a report" signal.

- **Marketplace accounts get their own import surface, not the generic mapper.** A *marketplace* account — a shopping venue whose purchases arrive itemized through a dedicated importer (Amazon today; marked by `kind: 'marketplace'` in `lib/accountTypes.js`, see `architecture.md` → "Marketplace accounts — the extension pattern") — is deliberately **omitted** from the generic CSV import page: its type is not offered when creating an account, and its accounts are not offered when mapping a file, because those accounts are filled by their own flow rather than by pushing a CSV onto them. To keep the generic path frictionless anyway, a file dropped on the CSV importer is header-sniffed and, if it is a marketplace export (e.g. an AZAD Amazon file), routed to that vendor's tab with the file preloaded instead of forced through column mapping. The dedicated tab is also the natural home for the vendor's setup help (how to produce the export). In the recent-import history these imports **group under their vendor** (an "Amazon" entry), driven by the batch's `source_kind = 'marketplace:<vendor>'` marker, rather than falling into the generic "unknown data source" bucket — and, since they are not CSV-profile imports, they carry no "assign to a data source" / "save as data source" affordances.
  - **File cards order by data recency, not import time.** Each marketplace file is its own card (per-file batching; see `architecture.md` → Amazon order import contract), and the vendor's cards are sorted by the **newest transaction each covers**, descending (`byMarketplaceCardRecency`, on the `newest_txn_date` `list_batches` exposes) — so a one-shot historical drop of many years reads the way it would have if each file had been imported as its purchases happened, instead of by import time (which ties for a single drop). The collapsed vendor row's "Last used" stays the most-recent *import* time, not the newest transaction.
  - **Open question — a second marketplace vendor.** With only Amazon there is a single "Amazon" tab. When a second vendor (AliExpress, Temu, …) lands, the intended shape is one **"Marketplaces"** tab that hosts the vendors as either stacked sections or inner subtabs that flip between them, with the last-viewed vendor remembered (session-scoped, like the outer Import / Export tab). Choose the section-vs-subtab form when the second vendor actually arrives — noted here so the tab name and structure are a deliberate decision, not an accident of there being one vendor today.

- **A connection card says what the last sync *did*, not only whether it failed** — and it says it in the *same form* the Import/Export history card uses, because the two answer the same question and a user reads them minutes apart. `Last sync` + an outcome pill (`Sync failed` / `Synced · check the log` / `Synced · more history to fetch` / a muted `Synced`) + the row total, then a row of **`SourceAccountChip`s** — the component extracted from the import card so the two cannot drift, carrying the ✓ / − / ✕ vocabulary that already distinguishes "got rows" / "got none" / "skipped". Chips are driven from the accounts the connection *offers*, not from what landed, so **an account that received nothing still appears**; that is the row the whole thing exists for, and any breakdown built from imported rows structurally cannot contain it. A chip's number is rows **seen** for that account — `added` plus the two no-destination buckets — which is what an import card's chip has always meant, so `✕ Some Account 35` reads the same on both. Feeding it `added` alone let the *shared* component mean two different things on the two surfaces: a skipped account showed a bare `✕` here and a counted one there, leaving the connection card unable to say how much data a skipped account was turning away, and leaving a reader to mistake the count of `✕` chips for the "No destination" total when the two happened to agree. Only the two no-destination buckets join `added`, never the whole `skipped` total — they arise solely for accounts with no local account, so the routine already-held and zero-amount skips cannot flip a mapped account's `−` into a `✓`. **One `OutcomeChip` remains**, for rows reported already-imported on a first import, and it deep-links to the sync log. A second one totalling rows with no destination was removed: those counts now ride on the `✕` chips themselves, per account, which is both more informative and unambiguous — a lone total sitting beside a row of `✕` chips reads as a count *of* them whenever the two happen to agree, which is exactly how it was misread. The pill's wording names the effect on the user's data rather than the mechanism (`incomplete` reads as "more history to fetch", not "budget paused"), and the outcome is decided server-side by `sync_outcome` (`services/providers/config.py`) at sync time and stored on the connection — so the card survives the sync log being cleared, and the card and the log still cannot disagree about one call because both are written from the same recorded facts. Below it, a **"Connected accounts"** heading separates the local accounts from the sync's per-account outcome above — without it the two read as one confusing run of names — and each carries the same `↗` detail launcher the Accounts tab uses, on the same handler.

- **The sync log row splits "what happened to my data" from "what the sync machinery did".** Settings → **Connection sync log** puts the first in an always-visible half and the second behind a per-row **Details** toggle, collapsed always — including on an error row, since what that owes the reader is the error, which sits above the fold. The visible half is an interpreted status line, the counts, the coverage line, where the rows were filed, the error, and bank-level warnings; Details holds the checkpoint/cursor fingerprints and the advisories (what the provider said about our own *request*, which nobody can act on — the log is still their only home, just not their only visible one). The failure this corrects is a routine budget-paused walk rendering as a wall of alarming output because every line carried equal weight.

  **A consumable's level is always-visible, not filed under Details.** For a metered provider the allowance line is the reason the row looks the way it does — a pull that stopped early and one that had nothing left to fetch are indistinguishable without it — so the row states what is left, which buckets ran dry, and when the next request becomes available ("6 of 22 shared requests left · 2 accounts out of allowance · next request in ~1 hr"). Counts are **floored, never rounded up**: this is a spendable figure, and claiming a request the server has not granted is the error that costs a disabled token. Status wording follows from the same honesty — a budget pause "resumes once it refills", not "on the next sync", because a bucket refilling at one token an hour does not care that a sync ran ten minutes later. Which bucket paid for each request, and how far each account reached, sit under Details as the follow-up questions only a stuck connection asks.

  Three rules produce the rest of the visible half. **Status is read from `final_status`, in the effect vocabulary the connection card uses** ("paused on the provider's daily request limit — resumes on the next sync", not `BUDGET_PAUSED`, which is Luma's own marker rather than anything a provider said). The per-page `status_sequence` is deliberately *not* rendered — it holds one entry per drained page, so a walking adapter fills it with one identical value per request, redundant with `final_status` and the `became_complete` badge beside it; its one unique payload is a mid-drain anomaly, a debugging finding, so the raw sequence stays in the **Copy for support** text where that reader already is. **A figure appears once**: the request count lives in the counts line and `windowSummary` does not restate it, since both render `requested_windows.length` and two agreeing figures read as two different ones. **A stored number is reconciled, not just printed**: `days_requested` next to a fetched span is a contradiction a reader has to resolve unaided, so the coverage line states both as durations and names the shortfall ("asked for 10 years, reached 2 yr 7 mo"), and `skipped` is split into the three unrelated events it folds together, rendered as the connection card's own `OutcomeChip`s in the card's own wording — the card deep-links here for the detail behind those chips, so a reader arriving by that link must not meet different words for the same fact. Tone follows the card too: no-destination always reads as a problem, already-imported only where the call cannot account for it. **That judgement is made once, on the server** (`unexplained_already_held` in `services/providers/config.py`), and every surface reads the number it returns: the log row's tone, the connection card's "Already imported" chip, and the outcome pill via `sync_outcome`. It strips the two innocent sources of already-held rows — a connection that has fetched before (each resumption of a metered backfill re-asks for a window it partly holds), and a walking adapter's overlapping pages re-offering rows *this same call* just imported (`skipped_already_held_prior` counts the other half directly rather than recovering it by subtraction). What is left is a first pull being told it already holds something, which is what a transaction-id collision looks like from outside.

  The reason it is computed once is that it was not: each surface re-derived it from `mode`, and since `mode` stays `initial` for every call of a backfill spread over days, a connection resuming normally showed an orange chip beside a correct "more history to fetch" pill and a correctly-muted log row — three readings of one sync, disagreeing on screen. When a judgement is rendered in more than one place, ship the verdict, not the inputs.

  Underneath, `lib/syncLogSummary.js` returns `null` rather than a placeholder whenever it cannot interpret its input, which is what lets a row fall back to the raw value instead of a confidently wrong sentence — for a stalled sync the raw value *is* the evidence. The same rule governs rows predating a column, with a twist worth remembering: a skip breakdown derived from a row that recorded none would report every skip as zero-amount — but so would a *genuine* all-zero-amount sync, since both read 0/0 on the two stored counters. `account_counts` is what separates them (it arrived in the same migration), so its presence is the "a breakdown was recorded" signal and the counters are only ever read once that holds.

- **A running sync stays visible after the page that started it goes away.** The poll loop lives in component state, so navigating away used to lose the indicator *and* re-enable "Sync now", inviting a second concurrent pull; `connection.sync_started_at` is the server's own answer, so the card shows "Syncing…" and the button stays disabled across navigation, a reload, or a second tab. Two things make it work and both are easy to get wrong: it is written **outside** the pull's transaction (`get_db` commits on block exit, and the pull holds one open throughout — a marker written there is invisible until the sync it announces has finished), and it is bracketed by a `finally` and believed only for `_SYNC_MARKER_STALE_AFTER`, so neither a raised sync nor a killed process can leave a connection permanently busy.

- **Name a connect action for the data source, not "account".** `+ Connect SimpleFIN` / `+ Connect Plaid`, from `providerLabel` — what the action adds is a *connection*; the accounts belong to the provider and arrive with it. "Account" already means a ledger account everywhere else in the app, so the old "+ Connect account" named the wrong noun twice over.

- **Data-source sync cards group by connection, in two homes.** A sync's rows land on a `connection_sync` `import_batch` (see `data-model.md` → "Sync import cards": one **"Initial import"** card for the first backfill, then **monthly** cards), so in the recent-import history they group under a **per-connection row** (its cards as the expandable batches), distinct from the marketplace and "unknown data source" buckets, driven by `connection_id`. The per-connection row shows the **institution** as its headline (from the connection's own `institution`, not parsed out of a card filename) with a muted **"{Provider} connection"** cue beneath it (e.g. "Plaid connection"), so two connections at the same institution stay distinguishable; the same provider surfaces on a transaction's origin hover, whose source line is labeled **"Source"** (not "Source file" — a connection isn't a file) with a **"Connection: {Provider}"** row, letting a synced row be traced back to which connection produced it. Both are fed by `connection_provider`/`connection_institution` (batch listing) and `import_batch_provider` (transactions query); the frontend `providerLabel` maps the raw key to a display name. These rows are read-only records — no rename / description / "assign to a data source" / **Undo** affordances (a sync is not an undoable file event, and the cursor has advanced past the rows so a deletion isn't auto-recoverable) — but they carry the same per-card duplicate/needs-review pills as any import card, so a cross-source duplicate opens the standard `UnifiedDuplicatesDialog` unchanged. The **second home** is the Accounts → Connections tab: each connection shows a **"⚠ N to review"** badge when its sync cards hold unresolved suspects, jumping to the Import/Export history to resolve them — the same "route to the card, not a global cross-batch view" model the duplicate task uses.

- **The Connections tab drives sync with a client-driven completion poll.** Connecting a bank **auto-syncs** it (scoped to the new connection), and Refresh/Sync do too, via `syncUntilComplete`: it calls `/sync` repeatedly until the response reports the historical backfill is done (`transactions_update_status` → `historical_complete`), showing "Importing history… N so far" between polls — so the provider's async backfill is pulled to completion **without a webhook**, and a fast connect no longer races a slow backfill (the earlier "connected but history looks short" trap). A **"New connection fetches"** window `<Select>` (persisted as the `connection.historyDays` user preference; 0 = all available) sets the initial fetch depth (`days_requested`); routine "Sync now" pulls cursor deltas and never narrows it. Each connection also carries a per-connection **"↻ Refresh accounts"** — rebuilds its account rows from the still-valid credential (no re-link) then backfills — the one-click recovery when a restore rolled the ledger back but kept the (never-backed-up) connection, leaving accounts whose sync skips every row for lack of a match.

- **An action that needs the vault open prompts for the passphrase and then carries on — it is never disabled for being locked, and never asks twice.** Every such action on the Connections tab (connect, sync, fetch more history, refresh accounts, disconnect, revealing or saving an app secret, and the post-connect/post-mapping history pull) opens with `await ensureVault()` from the shared gate in `lib/useVaultGate.js`; the passphrase dialog resolves that promise and the action continues *in its own call frame*. The earlier shape — open the dialog and `return` — dropped the action, so every gated button took two presses, and it is the failure mode this pattern exists to prevent: a gate that ends an action rather than suspending it will always cost the user the second press. Two corollaries. **A locked vault must not disable a control**: what disables is only what no dialog on this page can clear (missing HTTPS on a networked bind, or a vault this user holds no slot in) — otherwise a locked vault greys one affordance while its neighbours stay live and prompt, which is the state that made the tab read as arbitrary. And **a 423 is the same gate arriving late**, not a failure to report: the client's "unlocked" is a cached answer that a backend restart or the idle timeout invalidates underneath it, so the response re-prompts (`ensureVault({ force: true })`) and re-runs the action. Where the prompt sits within a flow is a judgement about commitment, not mechanics: Disconnect asks *after* its confirmation (a passphrase is only worth requesting once the user has committed, and the confirm dialog stays open beneath the prompt so backing out returns to the decision), which is why the passphrase dialog renders above the standard dialog layer.

- **Connecting a bank has an account-mapping step, and it is required before the first backfill.** `ConnectionAccountMapDialog` (`components/accounts/`) opens after Link and is the CSV import's account grid — the same columns (`Account from data source → Maps To → Skip`) and, more importantly, **the same question in the same order**. The primary control is one select of existing accounts with a `+New` beside it and a Skip checkbox; **grouping** is a refinement reached through `PossibleAccountMatchChooserDialog` and shown afterwards as a chip. It **reuses** that chooser and the suggestion helpers in `lib/importExport/importAccountMatching.js`, so both surfaces suggest and classify identically from one implementation. **A "Possible match" chip maps; it does not ask.** Clicking it selects the suggested account outright — agreeing with a suggestion is the shortest path on both grids — and the chooser opens from `+New` instead, where creating a second account for something Luma may already hold is what earns a second look. A suggestion always names a group **root**, even when a merged child is what matched the source's label: candidates collapse onto their roots before the "exactly one match" test, because merging duplicates a name (the child keeps the name its new parent already has) and counting the pair as rivals suppressed the suggestion for every account that had ever been grouped. `lib/connectionAccountMapping.js` holds the pure row-state ↔ mapping-mode translation (unit-tested for round-trip, since a reopen that restated a mapping would trigger a spurious duplicate re-scan).

  A first version instead led with a dropdown of the backend's mapping modes. **Don't reintroduce it**: it exposed the data model rather than the decision — grouping is a subtlety most mappings never need, so promoting it made every row look like a decision, and it asked the user to classify a relationship before naming the account it was with. Grouping earns its place in the chooser for a different reason: it is the same end state as creating the account and then merging it on the Accounts page, so offering it here collapses two steps into one. Two differences from the CSV grid are deliberate and should survive any later unification: connection `skip` is **remembered** (it stops "Refresh accounts" recreating a rejected account, where a CSV's skip is per-import), and a row whose account has *already been created* by an earlier save shows that account rather than a name/type editor, because the mapping call only names an account it is creating and the editor would offer edits it ignores.

  Ordering is the point: the historical pull runs only once the mapping resolves, because an unmapped provider account has nowhere to sync into and the mapping is what gives dedupe its cross-account alias — mapping after the backfill would mean the first and largest batch of rows is the one batch that never got the benefit. The same dialog reopens from the connection card's **"Connection settings…"** menu item as a plain edit (no backfill) — and it takes a different title in that mode, because reopened from the card it is a settings surface covering both the mapping and the captured-fields picker below, where post-Link the mapping genuinely *is* the whole job. An unmapped count shows as a **"N to map"** badge beside the existing "⚠ N to review".

- **An account-mapping picker offers roots, and carries a merged child only to render a mapping already on one.** A mapping — a connection's `connection_account`, a data source's single `account_id` — points at the account the user chose, and **merging that account into a group does not move it**. A picker built from top-level accounts alone is therefore missing precisely the accounts whose mappings are still in force: the stored id matches no option, the control renders empty, and a live decision reads as an absent one. That failure is worse than cosmetic, because the obvious repair — picking something from the list — silently re-points the mapping and strands the history already ingested under it. So these lists are fetched with `include_children: true` and passed the unfiltered set (`activeAccounts`, not `rootAccounts`), then narrowed for display by `selectableAccountOptions` (`lib/importExport/importAccountMatching.js`): roots, plus the one child the current value names. The narrowing is the other half of the rule and matters as much as the inclusion — offering *every* child doubles the list with entries indistinguishable from their own parents, because merging rewrites a child's display name to its parent's ("PayPal" merged into "PayPal"). On the child that does appear, `getAccountOptionLabel` appends "— in &lt;group&gt;" so it cannot be mistaken for the root beside it. The deliberate cost: a mapping can no longer be *newly* pointed at a merged child from the UI. That is the right trade — the group root is equivalent for dedupe scope and reporting, and choosing a child was never a considered act — but it means unmerging is the path if one is ever genuinely wanted. Applies equally to the connection card's own account list, whose empty state must distinguish "no provider accounts pulled yet" (→ *Refresh accounts*) from "pulled but undecided" (→ *Connection settings…*) — one message for both sends the second case to a control that cannot help it. Both messages name the **⋯** menu the two now live in, since neither is a visible button any more.

- **The field picker says what a connection captures, with the dedupe-critical fields locked.** A "Fields captured from this source" section on the same dialog mirrors the CSV evidence-column picker. Fields the adapter marks `locked` render **checked and disabled with a tooltip explaining why** rather than being hidden: hiding them would misrepresent what is stored, and making them togglable would let a user silently disable duplicate detection. Optional fields are free choices. The setting applies to **future syncs only** — it changes what is captured, not what was — which is stated in the dialog rather than left to be discovered.

- **"Import anyway" is an answer, and no later pass may re-ask it.** Forcing a held-back duplicate in tells the app that this row is not a duplicate of the transaction it was rejected against — so the post-import cross-source sweep excludes exactly that **pair** (`mark_import_suspects(exclude_pairs=…)`, fed from the `matched_transaction` the rejection recorded). Excluding the pair rather than skipping the row is the whole design, for two reasons. A forced row is an ordinary transaction that may well duplicate something *else*, and the import-time sweep is the only pass that ever compares it **backward** against rows that already existed — the merge-time scope scan reaches pre-existing pairs only inside a group that a merge or a mapping actually unified, so a row skipped here and never merged is never compared at all. And the exclusion *un-masks* that other match: selection keeps at most one match per new row, ranked strongest-text-then-closest-date, and an overridden pair is byte-identical and same-day, so it outranked and hid every other candidate. The promotion half of the sweep is **not** run on this path at all — it trashes what it promotes (`duplicate_confirmed`) and promotes same-account pairs as readily as cross-account ones, so it would trash the rows the user just insisted on importing, in the same request that imported them.

- **A connection card offers no "check for duplicates" action, deliberately.** Detection already runs at every moment that can change its answer, so a manual trigger has nothing to catch up on: applying a mapping re-judges the rows already in the ledger (that decision is worth nothing until it does, and making the user find a second button afterwards would be a trap), a sync sweeps its own card, a CSV import both reads the connection's coverage in its ladder *and* sweeps its own batch, and an account merge scans the newly-unified group. The one thing a standalone pass still did was change **which side** of an already-visible pair got flagged — removing the connection's older copy instead of flagging the file's newer one — and that is not a choice worth a control on the card. So the card's actions stay the ones that are genuinely per-connection — **Connection settings…**, **Fetch more history**, **Refresh accounts**, **Remove synced transactions**, **Disconnect** — and they live behind one **"⋯"** (below). A duplicate a user does need to act on reaches them where duplicates already live: the **"⚠ N to review"** badge on the card, linking to this connection's sync cards in the Import / Export history.

- **A connection card's actions live behind one "⋯", because state should outrank maintenance.** Five permanent buttons per card is a screenful at seven connections, and because the row wrapped at a point set by the institution name's length, no two cards broke in the same place. Worse, it inverted the card's own priorities: the actions are real but rare, while the **"⚠ N to review"** / **"N to map"** badges — the part actually asking for something — carried equal or less weight. The rule the card now follows: *what is actionable now stays on the surface; what is merely always possible moves into the menu.* Deleting affordances instead was the first thing considered (and is usually the better answer) but none survives it — Refresh accounts is the post-restore recovery, Fetch more history is occasional-but-real, and Connection settings… is the only way back to a mapping once its badge is gone. Rare-but-necessary is what a menu is for. That item's name is deliberately broader than its main grid: the dialog behind it also holds the captured-fields picker, so a label naming only the accounts (**"Accounts…"**) covers half of it and leaves the other half undiscoverable. Two alternatives are rejected. **"Manage source"** — *data source* already names two different objects here (a saved CSV import profile, which has its own editor, and a connection), so it is ambiguous about which one it edits. **"Configure…"** — the provider card one level up already carries a **Configure** button for the app credential, and two identically-named controls at different scopes on one screen is worse than a vaguer word. *Connection settings* names the scope exactly, in the vocabulary the tab already uses ("N connections", "Disconnect"). The trigger is right-aligned so it lands in the same place on every card, and in-flight work ("Fetching…" / "Refreshing…") shows beside it, since the menu that started the work is closed while it runs.

  Menu items group by purpose: the mapping decision, then the two provider re-pulls, then the two that take something away. **Only Disconnect is styled danger**, and the calibration is deliberate: `danger` marks an action with no way back, and *Remove synced transactions* reads more destructive than it is — the cursor reset is precisely what lets the next sync pull the same history back, so its red belongs on the confirm button, where the click that does the thing lives. Disconnect revokes the token provider-side, so returning needs a fresh Link the bank or the plan may not grant. Spending the color on the reversible items would leave nothing to distinguish the permanent ones (the Dashboard's saved-report **Delete**, which has no restore path, is the shared menu's other consumer and the contrast that keeps the flag meaningful).

- **"Remove synced transactions" is connection-level because the recovery is.** A sync card carries no Undo (`data-model.md` → "Sync import cards"), and the reason is not squeamishness about deleting rows: a routine sync only pulls changes *since* the cursor, so rows deleted while the cursor stayed advanced past them would be beyond the reach of any later sync. Removal therefore belongs where the cursor does — the connection — and resets it along with `initial_sync_complete` and the coverage claim, which is what makes the action recoverable rather than destructive. The label names **the effect the user sees**, not that internal reset and not the re-pull it enables: the re-fetch is deferred and may never be asked for, so "& re-pull" would promise something the click does not do. The dialog states the count of what goes, that the connection/accounts/mapping are kept, and that the next sync re-imports the history — and it opens on a **preflight** rather than on the counts the page already has, since those numbers are the thing being confirmed. The manual-edit guard is the file Undo's, shared to the row: rows whose category the user set by hand are listed before anything is deleted, and confirming past that list is what sends `force` (`EditedTransactionsWarning` is the shared block, used by both). A no-CSV-export-first decision is deliberate — the provider's ~24-month window plus backups cover the realistic cases, and the CSV Undo offers no export either.

- **PayPal money-movement review — the user decides which `Type`s are money movement.** A PayPal data source (`source_kind = 'source:paypal'`, recognized on import — see `data-model.md` → wallet funding-leg suppression) carries a **"Money movement"** button on its import-history header, and the same review (`MoneyMovementReviewDialog`) opens automatically after a PayPal import. It lists the source's distinct transaction `Type`s with per-type row counts; types that *look like* money movement (deposit / withdrawal / currency conversion / hold) are **pre-checked** and tagged `suggested`, but nothing is applied until the user confirms — the checkbox is the decision, the tag is only a hint (its earlier "money movement" label read as a redundant restatement of the row and was renamed). The dialog is **bidirectional/idempotent**: re-opened, it reflects each type's current `already_ruled` state, so it doubles as the edit surface — unchecking a ruled type removes its rule. Apply sends the `{add, remove}` delta (not the whole set), the button shows the change count, and because applying re-runs categorization the effect reaches rows already in the ledger, not just the just-imported ones. The single system PayPal source is renamable but its delete affordance is a **🔒** (a system source can't be deleted); a category column being unmapped disables the "apply imported categories" checkbox rather than letting it be set with nothing to apply.

### Rule suggestion review — bulk select alongside per-card actions

The Generate Rules review (`ImportRuleSuggestionReview`) lets the user build a selection of suggestion
cards. The "Bulk Select" toggle enters *bulk mode* (and becomes "Cancel" while active); a per-card
checkbox feeds `selectedSuggestionIds`. The model deliberately keeps two channels separate:

- **Bulk dispositions live only in a sticky bulk-actions bar.** While in bulk mode the header shows a
  bulk-actions row with visible buttons for the active view (pending/older: Save · Defer · Discard-keep ·
  Discard-clear; deferred: Resume · Save; discarded: Restore; etc.) plus Select all / Clear and the
  selection count. Labels omit "selected" — the bar already scopes them. (A right-click context menu over
  the list mirrors the same set as a power-user accelerator.) Running a bulk action settles the selection
  and exits bulk mode (`resetBulkMode`).
- **A card's own row buttons always act on just that card** — even when the card is part of the
  selection — and never touch `selectedSuggestionIds`. This is the deliberate invariant: it lets the user
  assemble a batch *and* pick off outliers individually at the same time, without the per-card actions
  disturbing the in-progress selection. (An earlier design made a *selected* card's button act on the
  whole selection, gated by a Ctrl escape hatch; that ambiguity was the "odd" behavior this model
  removed.) Per-card edits and the per-card reject-with-disposition menu are likewise always single-card.
- **Entering bulk mode preserves the user's place by suggestion identity, not scroll distance.** The
  ordinary review can combine related suggestions into merchant and conflict cards, while bulk mode
  intentionally expands them into individually selectable cards. Before either transition, a card clipped
  by the sticky controls is skipped and the first fully visible card is captured by suggestion id; after
  the list is rebuilt, that same suggestion occupies the first slot below the resized controls. Fixed
  pixel compensation cannot preserve position across this structural change.
- **Clearing a settled pile is not bulk selection.** Accepted, deferred, and discarded views expose a
  small Clear action for the suggestions currently visible in that settled view, including any merchant,
  owner, or look-back filtering. It moves those entries into one restorable Trash set and then shows the
  Trash view; Restore brings the entire set back to the status it came from. This is cleanup of review
  artifacts only — it does not reverse accepted rules, reapply categories, or mutate transaction rows.
- **Settled conflict tables preserve category-change context.** If resolving a conflict set re-pointed a
  member's rows to another category, the settled table should show the current category with its former
  category hint, e.g. `Lunch (was Food & Dining)`. This is display history for understanding the review
  action; row categories remain as edited unless the user uses Undo.
- **Merchant grouping follows the displayed merchant identity, not the exact keyword.** Selection edits
  can deliberately narrow a suggestion's keyword or opt into source-text matching while the rule still
  belongs to the same merchant work area. The outer review grouping and `# rows` ordering should keep
  those refined variants beside their broader merchant siblings so saving a selection edit does not bury
  the new one-row rule at the bottom of the review.
- **Aggregate rule editors use the matching-rows report for source-file detail.** A suggested rule can
  cover many imported rows whose captured source text differs. The rule editor may show a single source
  row only when the suggestion is truly one-row; otherwise it should expose the existing matching-row
  report as a reference surface, preserving the table/hover model instead of inventing a misleading
  "representative" source detail inside the editor. In the import rule editor this is an attached panel:
  a floating report would require shared focus/stacking/window-management behavior that this page should
  not hand-roll locally. Because that panel is reference material for the rule being edited, it is
  read-only there: row/category reconciliation remains in the standalone matching-rows report. Source-file
  merchant detail should be pinnable in the reference panel so the user can keep it visible while editing
  the selection criteria. In match-only selection editing, the editor should label the report affordance as
  the current suggestion/reference rows and suppress RuleForm's generic live match count. Saving the
  match regenerates the real suggestion world, where rows can split, merge, or move to other cards; the
  editor should not imply that its snapshot count is a live prediction of that regenerated state.
  A refined pending override can later render as a single suggestion card, but selection edits still need
  the same refinement endpoint so the review can release rows back to canonical generation, coalesce
  equivalent suggestions, and persist the partition. Do not expose parallel "edit rule" and "edit
  selection" buttons on that card; the existing editor entry point should route refined override saves
  through the selection-refinement flow.
  For a normal pending suggestion opened in full-rule mode, the editor's primary header action should be
  Close, not immediate rule creation: Close keeps the edited draft on the suggestion card so the user can
  continue resolving the surrounding merchant group before saving. Creating the rule from inside the
  editor may remain available as a secondary action, but it should not be the dominant path.

So: **row buttons = this card only; the bulk-actions bar = the selection.** Anything refactoring this
surface must keep that split — do not make a row button operate on the selection.

The selection survives navigation: it is mirrored to **`sessionStorage`** (scoped by review context —
import source + owner filter + view) and restored when Generate Rules reopens that same context, with
stale ids dropped by intersecting against the suggestions currently visible. It is deliberately *not*
written to the durable `ui_preference` store — an in-progress selection is a within-session convenience
that should not outlive the session or land in a data backup.

### Import mapping persistence

Import mapping persistence has two layers:

- **Import profile/filter:** source of truth for provider-level reusable mapping behavior

- **Local draft:** fallback only for the no-profile/manual case

When a profile matches, it should carry reusable import workspace state, including:

- column mapping

- account mapping and skips

- category mappings

- collapsed/open bucket state

The local draft must not override a matched profile. It exists only so a manual/no-profile import session can resume later if the next file is still compatible.

## Ownership and tag-driven reporting

Ownership applies only to **accounts**. Categories and groups do not have owners; the dimensions a user wants to report by — personal/shared, essential/discretionary, business/personal, and similar — are expressed through **tags**, applied at whichever level fits:

- a tag on a **transaction** marks just that row (manually or via a rule)

- a tag on a **leaf category** marks every transaction in that category

- a tag on a **group** marks every transaction in any of the group's leaves

Tag attachment is additive: a transaction's effective tags are the union of its direct tags, its category's tags, and its category's parent group's tags. The dashboard "tag report" picker breaks the period down by user-selected tags, with combination wedges for transactions that match more than one selected tag and a synthetic "Other / Untagged" wedge for the rest.

Ownership-related rules:

- **Accounts:** explicit owner per account, managed on the Accounts page.

- **Categories / groups:** no owner field. The Categories page right-hand panel surfaces a tags row for the selected category or group, with the shared inline `+ New tag` affordance for both creating and attaching tags.

- **Tags follow the "creating is available wherever assigning is" rule** (see General principles). Every tag-attachment surface uses the shared `TagPickerWithCreate` (existing tags as checkboxes plus an inline "+ New tag"): transaction rows, the payee `TransactionDetail`, the Categories panel, rule editing, and the bulk-edit "Add tags" section. The two exceptions are the bulk-edit "Remove tags" chips (you cannot create a tag in order to strip it) and the tag *filter* surfaces such as the filter bar (selection, not assignment).

- **Inherited tag display:** tags inherited from a parent group render in italic without a remove `×` on the leaf's *Categories* panel, since removing them at the leaf would not propagate; the user must edit the group's tags instead. On transaction rows, inherited tags use the outline tag glyph and a tooltip that names the source.

- **Transaction-level override of inherited tags:** in a transaction's tag picker (row popover, `TransactionDetail` editor, or the right-click Tags modal) an inherited tag can be unchecked to hide it on just that transaction — the picker sends `present: false`, which writes a universal block (`manual_state = -1`; see data-model.md). A blocked tag then renders unchecked with a struck-through name and a muted "hidden here" label; re-checking restores it. This mode is on wherever the picker is given `blockedTagIds` (the transaction surfaces); the Categories/Rules pickers omit it, so inherited tags stay read-only there. The block is per-transaction, so sibling transactions under the same category keep the tag.

## Floating detail panels

Account, category, payee, single-month-transactions, and tag-signature detail drawers all share one shell (`DetailPanelShell` plus `useDetailPanelChrome` in `frontend/src/components/detailShared.jsx`). Anything new in the detail-panel family should plug into the same shell so the chrome and behavior stay consistent.

- **Open behavior.** Panels open docked at a sensible spot. The first drag converts them to floating, with a small stacking offset when more than one is open at once.

- **Resize.** Every edge and corner is a resize handle (the shared shell renders all eight; only the bottom-right corner carries a visible grip, the rest are cursor-advertised hit zones straddling the border in the exterior gutter so they don't sit over the body's scrollbar). Dragging a west or north edge also moves the panel's origin so the opposite edge stays anchored. The first resize gesture promotes the panel to floating geometry so size and position stay coherent. Min/max are clamped to keep the panel inside the viewport; size is session-only (not persisted).

- **Gesture and reveal state stay off the consumer's render path.** Drag and resize are driven imperatively by `useDetailPanelChrome` — refs + direct-DOM writes (panel `left`/`top`, `user-select`, and a `<body>` grabbing cursor) plus window listeners attached on gesture start — and touch React state only once, at gesture *end* (drag commits the final `setPos`; resize reports via an `onGestureEnd({pos,size})` callback the caller uses to persist geometry). The hook deliberately does **not** return a `dragging`/`resizing` flag. It used to, and every consumer subscribed to it, so merely *starting and ending* a gesture re-rendered the whole panel body twice per header interaction — on the duplicate-detection report (thousands of rows) a single click on the `×` cost two multi-second full re-renders. The rule generalizes: transient UI state (drag/resize/hover/active) that only drives cosmetics must never live in a hook the heavy panel subscribes to — keep it in refs + direct DOM, or isolate the body behind a memo boundary. The reveal path applies the same instinct in reverse: `usePanelReveal(panelRef, dataReady)` holds the panel at `opacity: 0` (laid out, so it still measures) while its body reflows on open — async chart/list loads, the chart's second measure pass, and the resulting position clamp — then flips `revealed` true once a `ResizeObserver` sees the geometry hold still (hard-cap fallback so a slow body still appears), so the panel fades in fully formed instead of visibly growing and jumping.

- **Stacking and click-to-focus.** Z-index is managed by a single app-level registry in `frontend/src/contexts/PanelStackContext.jsx`. Every `DetailPanelShell` claims a slot via `usePanelStackSlot` on mount; the slot returns its current `zIndex`, an `isTopmost` flag for header styling, and a stable `bringToFront` callback. Clicking anywhere on a panel surface (`onMouseDownCapture` in the shell) lifts that panel to the front of the stack — works across panels rendered in different parts of the tree (e.g., the App-level duplicate-detection dialog and route-mounted batch/account/month panels coordinate through the same stack). Re-opening the same target focuses the existing panel rather than spawning a duplicate; if the target's payload differs from the existing panel's payload (e.g., the duplicate-report drill-through opens the same batch with vs. without a date filter), the existing panel's payload is replaced rather than ignored, so the second click reflects the new parameters.

- **A panel may open another panel.** A detail panel's inner transaction list can itself open a further detail panel — e.g. the merchant `↗` in `AccountDetail`'s month list opens the payee `TransactionDetail` (for the per-transaction origin/source info). It is hosted as a *child* of the opening panel, not by the page, so it lights up wherever that panel appears without per-page wiring and closes together with its parent; the shared stack registry still gives it its own z-order slot, so it stacks and focuses correctly despite being nested in the tree. Edits made in the child reconcile back into the parent's list. The deliberate trade-off is lifecycle coupling (closing the parent closes the child); use page-level sibling hosting instead when the opened panel must outlive its opener.

- **Merged accounts surface their underlying sources.** `AccountDetail` for a *merged* account spans every underlying (source) account, since the report scopes by the **effective** account (`account_ids`, which resolves children → parent through `COALESCE(parent_account_id, account_id)`). To keep the merged children legible it adds, only when the account actually has children, a **source-account column** (the row's original account, from the always-returned `source_account_raw_name` — distinct from the effective-account `account` column, which is identical for every row here) and a **multi-select source-filter pill row** above the chart (no pills selected = all sources). The filter narrows both the trend chart and the transaction list, server-side, through a separate **`source_account_ids`** query param that filters the raw `t.account_id` rather than the effective account — the one filter that *can* isolate a single child, since every row in the report shares the same effective parent. It rides the shared transaction-filter builder, so the list feed, the monthly-trend endpoint, and bulk "select all matching" all honor it identically (a standalone account shows neither the column nor the pills).

- **Edits inside a detail panel must reconcile back to whoever opened it — through one callback.** `TransactionDetail` (and the other editable drawers) only mutate their own local copy and the backend; the *host* is responsible for patching its on-screen row(s). The panel reports every edit through a **single** `onReconcile(txnId, patch | null)` prop: the panel computes the changed fields (`patch` — category set, notes, tags/blocked-tags), or passes `null` when the row was trashed and should drop. The host merges the patch into its row(s) — almost always via the shared `makeRowReconciler(setRows, { onRemoved })` builder in `lib/txnMutations.js`, which does the id-match map (or a filter + optional count decrement on `null`). This one-callback shape is deliberate: adding a new reconciled field changes only the patch the panel emits, so **no host has to change** — the whole reason it replaced the previous four separate callbacks (`onCategorized`/`onNotesSaved`/`onTagsChanged`/`onTrashed`), where every new field rippled to ~10 hosts. A host that holds the same row in more than one place patches all of them in the one callback (the Dashboard's `reconcileDetailEdit` fans a single patch out to its two drill tables *and* its open-panel `txn` copies). A host whose rows live in nested state (`Transactions`' `{ transactions, total }`) or that needs an edit-specific side effect passes its own `(txnId, patch)` function of the same shape instead of the builder. A host that skips `onReconcile` leaves the page behind silently stale (old category/tag shown while the panel shows the new one, and reopening re-passes the stale `txn`).

- **Dismissal.** Panels close on `×` in the header or Escape. Escape dismisses only the topmost panel, and the shared chrome (`DetailPanelShell`) suppresses it in two cases so it never destroys more than the user intends: when focus is in a text field (the inline editor reverts its own edit instead, so a half-finished note/name edit is never lost) and when a modal dialog is open above the panel (detected via the `data-modal-overlay` marker on `OverlayBackdrop` — the dialog owns Escape). Escape does *not* require focus to be inside the panel, because opening a panel by click leaves focus on the trigger in the page behind. Backdrop-click dismissal is intentionally avoided so a half-finished edit is not lost to a stray click.

- **Minimize-to-nav-bar — via the shared detached-viewer seam.** Long-lived report dialogs that the user wants to keep open while working elsewhere offer Minimize instead of forcing a close: a `minimized` flag hides the floating panel without dropping loaded data; a nav-bar pill (shared `MinimizedReportPill`) shows the dialog's title plus an attention count; clicking it restores the panel at its prior position/size. The state machine is the shared `useDetachedReportViewer` hook (`lib/useDetachedReportViewer.js`) — open/reload/close/minimize/restore over an envelope the report's own App-level context wraps (state must live above the route tree so the dialog survives navigation). Four consumers use it: the duplicate-detection report (`UnifiedDuplicatesViewerContext`), the Amazon reconciliation report, the Amazon import-detail report, and the running-sync status panel (`SyncStatusContext`); a new detached report should be a fifth wrapper, not a bespoke context.

- **A long *operation* uses the same seam as a report, with three differences.** `SyncStatusContext` is the reference: a data-connection sync runs for minutes, and since the backend stopped holding its write transaction across provider calls the user is meant to keep working through it, so the panel is non-modal (`AppDialog`'s `draggable` mode — a click-through backdrop, not the heavier `DetailPanelShell`, which is for reports the user works *inside* rather than glances at) and stashes to a pill whose **label carries live status**, since the point of stashing it is to read the chip rather than restore the panel. What differs from a report: (1) the context owns the **poll loop**, not just the state — a report holds a snapshot, an operation has a driver, and while that driver lived in the page it kept running in a detached closure after navigation, writing to an unmounted component; (2) progress is read from **committed server state** rather than the operation's own response, because the operation is one HTTP call that returns only at the end — which is also what lets another tab, or the same one after a reload, adopt a run it did not start; (3) **Cancel means stop watching, not abort** — the backend work is resumable by design, so nothing is torn down and nothing is lost, and the control is labelled for that visible effect rather than for a cancellation that does not happen.

  **The row set is the run's roster, fixed from the first frame — a progress panel must never shrink.** The
  tempting implementation renders whatever the server reports as running right now, and it produces a panel
  that grows and collapses on a rhythm the user cannot account for: the driver is a *sequence* of calls with
  a wait between them, each one clearing the sync marker on its way out, so "running right now" is honestly
  empty for several seconds of every cycle — and at the end the per-connection rows give way to a single
  provider total, shrinking once more just as the user starts reading. So the panel is handed a roster
  instead: every connection the run covers, seeded when it starts (scoped exactly as the backend scopes the
  run — one connection when the caller named one, else all of that provider's), each row filling in as it
  goes and **holding its final figures afterwards**. The same panel that answers "how is it going" answers
  "what happened" once it is over, without ever changing size, and a connection whose whole call fits
  between two polls still gets a row. A row's live/settled state follows its **provider**, not its own
  reporting: between calls no connection reports anything, and a row keyed on that would settle and
  un-settle every few seconds while the sync went on regardless.

  **A per-item total for a driven run is summed from the responses, not differenced from polled progress.**
  This is the correction to (2) above, not an exception to it: polled state is what makes a run *watchable*
  from anywhere, and it is still the only source for the call in flight — but as an accounting basis it
  silently drops any call that begins and ends between two polls, which a routine top-up usually does. So
  `POST /sync` reports its own per-connection breakdown (`connections[]`, built from the same facts as the
  sync log and the connection card, so the three cannot disagree), the driver sums those across the run, and
  the poll contributes only the in-flight call's partial count — cleared the moment that call's response
  lands, which would otherwise double-count it for a whole poll interval. A run this tab is *not* driving
  has no responses to read and falls back to the last progress observed: second-hand and possibly a page
  short, which is the honest ceiling for a run being watched rather than driven. A watcher also cannot read
  "nothing is running" as "the run has ended" — that is equally the quiet between two of the driver's calls
  — so it waits out a few of those gaps before settling, where the tab holding the driver settles the moment
  its last call returns. Reading the first gap as the end is what used to stop a watcher's own poll a few
  seconds into a backfill it had correctly adopted.

  Three shapes were rejected building it, and each would be a tempting re-invention. A **blocking modal** was the original request and treats the symptom: once the backend releases its lock between requests there is nothing to protect the user from, so blocking costs usability for no safety. **Producer/consumer threading** (a fetch thread feeding a processing thread) targets the wrong constraint — the threads need separate connections and contend for the very write lock the work exists to free, the GIL gives no CPU parallelism, and the queue only helps if durable. A **raw staging table** for provider payloads duplicates what per-page commits already achieve, adding a second write path to guard only against a processing bug costing re-fetched requests.

  What survived those rejections is the **staging itself, kept logically**: receiving-and-storing and the analysis over what was stored are separate stages in one process, and the transaction boundary is where they separate — see `architecture.md` → Database concurrency, which now states it as an invariant. Recording only the three rejections here is what let the duplicate sweep be added *inside* the sync's ingest transaction later: "we decided we didn't need threads" does not fire when someone adds a post-processing step, where "the ingest transaction ends before analysis begins" does. It cost 109 seconds of held write lock on a real ledger.

- **Persisted geometry.** Dialogs that the user routinely re-opens should remember their last-dragged position and size — use the shared `useRestorablePanelGeometry(prefKey)` (in `detailShared.jsx`), which persists `{pos, size, viewport: {width, height}}` via `useUserPreference` and on restore scales both proportionally against the current viewport, so a dialog saved bottom-right on a 1920×1080 monitor lands bottom-right on a 1280×720 laptop. It returns the `initialPosition`/`initialSize`/`onGestureEnd` trio to feed `useDetailPanelChrome`; the chrome's existing `clampPanelPosition` remains the safety net if a saved geometry would land past the new viewport edge.

- **A detached report's `version` counter must advance on *every* load, including the first.** The host page watches `viewer.data.version` to re-fetch its own pill counts after the report changes something, and treats 0 as "no report has loaded". A loader numbering its first load 0 therefore makes *opening* the report the one load that refreshes nothing — invisible until a count goes stale by some other route, and then unfixable by the gesture a user naturally reaches for: clicking a "42 duplicates" pill, reading "all duplicates resolved" in the dialog the click just loaded, closing it, and finding the pill still saying 42. Counting from 1 costs one list fetch per open and makes the page's counts self-correct against the report every time it is opened.

- **A live state supersedes a freshness statement; it does not sit beside it.** "Is anything happening right now?" and "how current is this data?" are different questions, and while an operation is in flight only the first one matters. The provider card's header is the reference (`providerSummaryLine`, `lib/connectionSummary.js`): during a sync it reads `1 connection · syncing…`, not `1 connection · never synced`. Stating both put two contradictory facts in one header row — `last_synced_at` is stamped on **successful** pulls only, so a connection's very first sync read as `never synced` immediately to the left of its own disabled `Syncing…` button. The connection card nested inside already did this correctly (`LastSyncSummary` short-circuits on `syncing` ahead of all its freshness logic), which is the tell: when a surface and the surface containing it describe the same operation, the outer one is the easy one to forget. Whatever expression the action control reads for "in progress", the summary beside it must read the same one — here `ss.syncing || serverSyncing`, the component's own optimistic memory **and** the server's marker, so the two cannot disagree in either direction.

- **An alternative credential must be offered wherever the credential is demanded, not on one screen that happens to also offer it.** Vault unlock is the reference. The passkey ceremony worked and was wired to the `VaultStrip` on the Connections tab — but every *gated* action (disconnect, sync, a credentials restore, and the 423 re-prompt that fires when the server drops the key on its idle timeout) raises `VaultPassphraseDialog` instead, which asked for the passphrase and nothing else. So the faster credential was reachable only by noticing the strip *before* triggering an action, and the 423 path could not be pre-empted at all, being invisible until it fires. A user who set up a passkey specifically to stop typing their passphrase typed it every time. The fix is structural rather than cosmetic: the whole sequence lives in one shared call (`runVaultPasskeyUnlock`), each host says what to do once the vault is open (`onUnlockedByPasskey`), and the prompt orders and tones the two options exactly as the strip does so the primary way in does not change depending on which surface asked. A refused or dismissed ceremony leaves the prompt open on the passphrase — the fallback is always still there — and a cancellation reports nothing, since the user closed it on purpose.

- **A decision about accounts is asked as a question about accounts.** When a report accumulates many row-level flags that all turn on one account-level fact, offer the account question rather than letting a row action imply it. The duplicate report is the reference: a stack of cross-account flags between one pair is one question — are these the same real-world account? — with two terminal answers (merge them, or record them distinct), each of which settles every flag between the pair. `AccountIdentityPrompt` renders it above the list, in the same words the "Possible duplicate account?" chooser uses at mapping time, because it *is* the same question reached later. Only the largest outstanding pair is prompted; stacking one per pair turns an answer into noise about the others, and "Not now" is component state, not a stored preference — dismissing means "leave me to it", and the two real answers remove the pair from the server's list anyway. The anti-pattern it replaced: **Keep both** used to write a durable account-level assertion and cascade-clear the pair, from a button labelled for its effect on one transaction — so a bulk selection of five resolved forty-two, and the user had no idea an account-level decision had been taken. A durable assertion made this way must also be listable and reversible somewhere (Settings → Distinct account pairs); an invisible one-way switch is the part that makes the pattern harmful rather than merely surprising.

- **A bulk action over N rows reports partial success as partial.** Use `Promise.allSettled` and the shared `summarizeBulkOutcome` (`lib/bulkRequestOutcome.js`), never `Promise.all`: the latter rejects on the first failure, which discards every result after it *and* whatever the caller does on success — typically the reload and the selection clear, i.e. exactly the two things that would have shown the user what actually happened. Rows that failed stay selected so a retry re-sends only those; the reload runs unconditionally, since a partly-applied bulk is precisely when the numbers on screen are least trustworthy. This is not hypothetical: a bulk "Keep both" over 42 flagged duplicates issues one request per row while a cross-account keep resolves the whole account pair in the first one, so the other 41 were refused, and a completely successful action rendered as a total failure with the stale rows still on screen. The server side of the same rule is in `docs/data-model.md` — an action that cascades must treat an already-resolved row as a success.

- **Auto-refresh on cross-page mutations.** Dialogs that show data that other pages can mutate (the duplicate-detection report's entries are affected by merges/renames on the Accounts page, etc.) should subscribe to a window-level event dispatched by the mutation site (`notifyAccountsChanged` in `App.jsx` is the pattern). Listeners debounce briefly and only refresh when the dialog is open *and* not currently loading. The `minimized` flag must survive these refreshes — minimize keeps the dialog stashed; an out-of-band refresh should never pop it back into view.

- **Date scope is caller-provided, never read from the global filter directly.** Detail panels (CategoryDetail, AccountDetail, the payee TransactionDetail, PeriodDetail, TagDetail) take their date scope as props from whoever opens them — they must not call `useFilters()` to reach into the global date filter themselves. Only Dashboard and Transactions show the filter bar (`shouldShowFilterBar` in `App.jsx`), so only they pass the global date down; pages without the bar (Categories, Accounts) pass nothing. A panel that grabbed the global filter on its own would silently scope its data on pages that don't show that filter — a hidden filter that disagrees with un-scoped counts (the symptom that motivated this rule). When no date scope is passed, a panel chooses a sensible unfiltered default: the category trend slides a 36-month window to end at the category's most recent activity (`anchor=latest` on `/summary/monthly-trend`), while account and payee trends fall back to full history. The header label must describe the window actually shown (the trend's month span), not the global filter.

- **The drill list has a Month · Year · All time range control.** The three activity drawers that drill a monthly trend chart into a scoped transaction list — `CategoryDetail`, `AccountDetail`, and the payee `TransactionDetail` — carry a shared segmented control (`DetailRangeControl`) on the list's section header. The clicked bar stays the **anchor** in every mode; the control only widens the window shown *below* it, leaving the chart as the monthly navigator (timeframe experimentation for the chart itself belongs on the Dashboard). **Month** is the default and the original behavior (the selected bar's calendar month). **Year** shows the anchor bar's calendar year — clicking any 2025 bar lists all of 2025. **All time** shows the chart's full charted span and its clicked-bar anchor is irrelevant (nothing changes when a bar is clicked). The shared helpers live in `detailShared.jsx`: `computeDetailRange(mode, anchorMonth, trend)` returns the fetch `params` (a `month`, a `date_start`/`date_end` calendar-year, or the trend's first..last span) plus the window `count`/`total` **summed from the same trend rows** (so the footer, list, and chart always agree even where the trend is capped below true history — category 36mo, account 60mo); `detailRangeStableKey` gives the memo/fetch a key that ignores same-window anchor clicks (so re-clicking a bar inside the selected year, or any bar in all-time mode, never reloads identical rows); and `detailRangeActiveMonth` highlights every bar in the active window, not just one. Widened ranges fetch through the paged `/transactions` endpoint (`usePagedTransactions`), so All time on a busy scope stays paged, not unbounded. The bulk-edit `filterParams` mirror the same window params, per the select-all hidden-filter rule.
- **The single-transaction trash lives only in editor mode.** `TransactionDetail`'s header trash targets the one entry-point transaction, so it renders only when the panel is the single-transaction **editor** (`showEditorCard`), not when it is opened as the merchant-activity **report** (the merchant `↗`, `_merchantReport`) — there the entry row may not even be in the visible window, so a header trash would be ambiguous. Report-mode rows keep their own trash via the row context menu and Bulk Edit.
- **An account that looks empty explains itself.** `AccountDetail` surfaces a note when an account has imported rows that were skipped or removed as duplicates of transactions already present elsewhere — the common reason an account shows little or no activity (e.g. the same card imported from two sources). The note names how many rows were skipped and which accounts/source files the matched existing transactions live on, computed by `GET /accounts/{id}/duplicate-summary` (`account_skipped_duplicate_summary`), which attributes both hard-rejected import rows — via the `account_id` stored in each `import_batch_duplicate` row's `txn_payload` — and confirmed-duplicate trashed `txn` rows. Its "View in duplicate report" link opens the unified duplicate viewer **scoped to that account**: the viewer takes an `accountFilter` ({id, name}) that filters report entries by the incoming side's `account_id` (now exposed on every entry), since an account's skipped rows are otherwise scattered across the batch's report. The scoped view shows a "Showing only duplicates for that account · Show all" banner that clears the filter in place.

- **Every scoped transaction list is paginated with server-side sort — never a one-shot capped fetch.** The floating drawers' lists, the Dashboard single-period drill tables (selected group, selected category), and the Recurring series drill-down's member list all go through the shared `usePagedTransactions` (`detailShared.jsx`): it infinite-scrolls `DETAIL_PAGE_SIZE` rows at a time and owns the **sort state**, folding it into each fetch as `sort_by`/`sort_dir` so the header's column clicks reorder the *whole* result, not just the loaded page. The Dashboard drills key the hook on the drill selection (`selectedGroup`/`selectedCat` + the global scope) — it fetches when a row is selected and clears on navigate-up — rather than fetching imperatively in the click handler; the drill handler now only sets the selection + level. Feed its `sortState`/`onSort` straight into `TransactionListTable`'s controlled-sort props (`onSort` being a function switches the table out of client-side sort). Server-side sort is not optional here: a client-side sort over an infinite-scroll list is broken by construction — a reversed sort parks the un-loaded rows past the fetch cursor at the *top* of the list, where scrolling to the bottom (what triggers the next page) can never reach them, so the oldest rows become unreachable. This is why a whole-year `PeriodDetail` (which replaced the single-month `MonthDetail`, whose one-shot `limit: 1000` grab silently dropped the oldest rows once a year exceeded 1000) and every other panel now page instead. `total`/`sumAmount` come back on the first page (server aggregates over the whole set) for a header count/total that stays correct past the loaded rows; panels that derive those from a trend (`CategoryDetail`/`AccountDetail`) ignore them. **Do not reintroduce a `limit: N` single fetch for any transaction list that can span a large scope** — reach for `usePagedTransactions`.
- **Scroll-container contract.** The actual scroll viewport for paginated transaction lists inside detail panels is the outer wrapper of `TransactionListTable` (the div `scrollRef` lands on) — the pill header pins inside it via `position: sticky; top: 0`. Under `fillHeight=true` that wrapper takes its height from the flex chain above it, so every ancestor between the panel shell and `TransactionListTable` must propagate height via a flex column — each wrapper needs either `flex: 1, minHeight: 0` or an explicit `height` that resolves against a flex parent. A plain block wrapper anywhere in the chain silently breaks percentage-height resolution for its descendants, the scroll viewport ends up sized to its content (no overflow), and wheel events bubble out through the floating-panel backdrop (`pointer-events: none`) into the page behind. If you add a new wrapper around `TransactionListTable`, give it `display: flex, flexDirection: column, flex: 1, minHeight: 0` and verify scroll still works in the BatchDetail panel against a large file.

## Theming

The app offers five theme choices from the Appearance section at the top of Settings (the most-common single-user setting, so it leads the section list): two light-family palettes — **Light** (soft slate, bright) and **Soft light** (a muted grey, lower-glare) — two dark-family palettes — **Dim** (a soft charcoal) and **Dark** (the original near-black) — and **System**, which follows the OS `prefers-color-scheme` to the plain Light/Dark ends.

- **CSS custom properties are the theming mechanism.** All structural color flows through ~11 vars defined once in `frontend/index.html` — `:root` holds the dark theme (also the no-attribute default), and each `[data-theme="…"]` block (light / soft / dim) reassigns the same vars. A theme switch is purely a var swap; component logic never branches on the theme. Each block also sets `color-scheme` so native controls (scrollbars, date pickers) match. **Adding a palette is a new `[data-theme]` block plus an entry in `THEME_CHOICES`/`THEME_LABELS` in `src/lib/theme.js` — nothing else changes**, which is the payoff of routing every semantic color through a var.

- **Semantic color must reference a var, never a hardcoded copy.** `var(--danger)`, `var(--success)`, `var(--warning)`, `var(--accent)`, etc. — including inside `color-mix(in srgb, var(--warning) X%, var(--surface2))`, which adapts automatically because the mixed-in surface/border/text vars flip too. A literal like `#ef4444` for "danger" is a bug: it stays dark-slate-era red in light mode. White text *on a colored fill* (`color: '#fff'` on a `var(--accent)` button/pill) is the deliberate exception — it is correct on both themes.

- **Decorative palettes are the other deliberate exception** and stay as literals: the tag color palette (`TAG_COLOR_PALETTE`), category badge themes (`categoryAppearance.js`), and the chart-series palette (`Dashboard.jsx`). These are background-agnostic identity colors, not semantic state. Canvas drawing colors (`ctx.fillStyle`/`strokeStyle`) also stay literal — a canvas context cannot resolve CSS vars.

- **The choice is a user preference** (`ui.appearance.theme`, via `useUserPreference`), applied by `ThemeController` in `App.jsx`; a `system` choice tracks the OS `prefers-color-scheme` live through a `matchMedia` listener. The single source of truth for *applying* a theme is `src/lib/theme.js`.

- **Anti-FOUC cache.** Preferences round-trip from the backend (too slow to gate first paint), so `theme.js` mirrors the resolved choice into a `localStorage` cache (`luma.theme`) that a tiny inline script in `index.html` reads to set `data-theme` before React mounts. Without it, the pre-React paint and the "Loading preferences…" screen would flash dark before a light preference loads. The backend preference stays authoritative; the app reconciles the cache to it on load.

## Charts and overlays

Recharts is the visualization library. A few conventions keep charts consistent across the dashboard and detail panels.

- **Themed tooltips.** Use the shared `CHART_TOOLTIP_CONTENT_STYLE`, `CHART_TOOLTIP_LABEL_STYLE`, and `CHART_TOOLTIP_ITEM_STYLE` constants from `frontend/src/lib/moneyDisplay.js` on every `<Tooltip>`. Recharts colors each item's value text using the data series color by default, which is invisible against the dark surface for darkly-themed accents; the shared `itemStyle` forces value text back to `var(--text)`.

- **Signed axis labels.** Use `formatSignedAxisTick` from `moneyDisplay.js` for any y-axis whose data can span both sides of zero (monthly trends, account balances, refund-heavy months in an expense category). It renders `-$1.5k` instead of the raw `$-1500` Recharts would otherwise emit, and pairs with `formatSignedMoneyAmount` for the tooltip body.

- **Average reference line.** When a chart shows a meaningful per-period average, render it as a `<ReferenceLine>` using the shared `AvgReferenceLabel` component (in `frontend/src/pages/Dashboard.jsx`). The label is split: a small "Avg" pill anchored inside the chart at the line's height, plus the formatted value rendered in the y-axis tick column (accent color, slightly bolder than regular ticks). The pill is `pointer-events: none` so it does not interfere with the chart's own hover tooltip.

- **Click-on-chart-element to drill.** On the dashboard **single-period** trend chart, a bar's **primary (single) click re-pins the date filter onto that bar's range** — so every bar width sets the selected period and refreshes the middle spending breakdown consistently — while a **double-click opens a range-scoped `PeriodDetail`** (the transaction list) for that bar. A **"View transactions" link** in the trend card header opens the same `PeriodDetail` for the whole selected period (day-precise, not a single bar). (Recharts gives `Bar` no dblclick event, so the double-click is detected manually with a short two-click window; the single click still fires as the first half, which is intended — a double-click both focuses the period and opens it.) On the **Trends-tab** monthly chart a month bar opens a one-month `PeriodDetail` directly. Pie wedges on the Spending-by group/category/tag-report panels click through to either the next drill level (group → categories) or the appropriate transaction detail. Use the `cursor: 'pointer'` style on the clickable element so the drill affordance is discoverable; pair the chart click handler with the same handler the row legend uses so list and chart behave identically.

  *Why the split:* clicking a trend bar must set the timeframe for the breakdown (the thing you can't get any other way), so the transaction report moved to the double-click + header link and became available at every bar width — where it was previously reachable only for single-month bars. The `PeriodDetail` panel is the generalization of the former single-month `MonthDetail`: it takes an inclusive `start`/`end` range plus a `label`, so months, quarters, whole periods, and years all share one drawer.

- **Tooltip offset on dense charts.** Stacked area charts can have many elements clustered near the cursor; bump the `<Tooltip offset>` past the default 10 (the dashboard's "Monthly spending by group" uses 20) so the tooltip card does not obscure the column the user is reading.

### Pie partition with Other-drill

Long-tail categorical pies (the dashboard's Spending-by-group/category and tag-report wedges) use an adaptive slicing algorithm in `frontend/src/pages/Dashboard.jsx` so the chart stays clickable even when the underlying data has many small items.

- **Minimum named wedges** (`MIN_NAMED_SLICES`, currently 10). At least this many real items are shown before the long tail is collapsed.

- **Smallest-wedge threshold** (`SMALLEST_NAMED_SLICE_MIN_SHARE`, currently 3%). Beyond the minimum, items keep getting peeled out as long as the next one would still be at least this big a share of the current page's pool. Once the next item would drop below the threshold, the rest are collapsed into a synthetic `Other (N)` wedge.

- **No upper cap.** If a dataset has many items above the threshold, all of them render directly. The threshold (not an arbitrary cap) controls the cutoff.

- **Singleton absorption.** If peeling would leave exactly one item in Other, that item is added to the named wedges instead so we never show a one-item Other.

- **Other-drill.** Clicking Other re-renders the pie against just the remaining tail with the same algorithm. The threshold is recomputed against the smaller pool so deeper levels do not strand the user. A breadcrumb above the pie tracks the Other depth and clicking any crumb pops back to that level.

- **Peeled-Other vs. natural-Other.** In tag-report mode, transactions matching none of the selected report tags form a *natural* Other / Untagged signature. That is distinct from the synthetic peeled-Other wedge added at any given depth. Wedges added by the slicing algorithm carry a `_peeledOther` flag so the click handler can dispatch correctly: peeled-Other pages deeper; natural-Other opens the detail panel for that signature.

## When to document a new pattern

Add to this document when:

- a pattern is used on more than one page

- a cleanup pass establishes a new “preferred” interaction

- repeated review comments or UI tweaks point to a missing convention

Do not add one-off exceptions unless they are likely to become reusable.
