# UI Patterns

This document records the UI patterns Luma should prefer. It is not a full design system; it is a working reference for visual and interaction consistency.

This document defines UI behavior and interaction patterns. For underlying data structures and system flow, see `architecture.md` and `data-model.md`.

## Contents

- [Product intent](#product-intent)

- [General principles](#general-principles)

- [Page structure](#page-structure)

- [Tree views](#tree-views)

- [Section toggles](#section-toggles)

- [Row editing](#row-editing)

- [Transaction rows](#transaction-rows)

- [Pills and expanding selectors](#pills-and-expanding-selectors)

- [Empty states](#empty-states)

- [Drop zones and file inputs](#drop-zones-and-file-inputs)

- [Enter in a small explicit-submit form](#enter-in-a-small-explicit-submit-form)

- [Confirmation and completion flows](#confirmation-and-completion-flows)

- [First-run onboarding](#first-run-onboarding)

- [Help and contextual explainers](#help-and-contextual-explainers)

- [Dismissing what the app is nagging about](#dismissing-what-the-app-is-nagging-about)

- [Import-specific patterns](#import-specific-patterns)

- [Ownership and tag-driven reporting](#ownership-and-tag-driven-reporting)

- [Floating detail panels](#floating-detail-panels)

- [Theming](#theming)

- [Charts and overlays](#charts-and-overlays)

- [When to document a new pattern](#when-to-document-a-new-pattern)

- [Open](#open)

## Product intent

Luma should feel polished, quiet, and immediately useful. The UI should support routine work in place rather than forcing separate admin or settings flows for common actions.

Polish is part of the feature, not a later cleanup step.

Baseline interaction expectations:

- overlays should open in the correct place on first paint

- menus and popovers should respect viewport edges and scroll containers

- controls should not jump, reflow, or visibly correct themselves after opening

- selectors and dialogs should render above surrounding content

- when multiple floating panels are open, the active/topmost one should carry the strongest edge and elevation while older panels remain readable but visually recede

- inline edit states should preserve layout stability whenever possible

If the user can already see the data they need to change, prefer enabling the change in place unless there is a strong reason to route it elsewhere.

Shared controls should be treated as finished product surfaces, not reused snippets. If a picker, menu, overlay, inline editor, or related control appears in more than one place, viewport behavior, scroll behavior, first-paint placement, and general polish should be handled as part of the shared control, not deferred to follow-up page-specific cleanup.

## General principles

- Keep layouts compact. Avoid large empty regions, oversized cards, and controls that read heavier than the data they edit.

- Treat the UI as the user's window into their data. If information is shown in its primary context, the user should usually be able to act on it there.

- Put editing where the data is primarily viewed. If a page is the natural place to inspect a thing, prefer editing it there instead of duplicating the same controls on Settings.

- **Creating is available wherever assigning is.** Anywhere the user picks a value from a managed set — a category, a group, a tag, a note, an owner, and so on — they can also create a *new* member of that set inline, in the same control, and have it applied immediately. The user is never bounced to a separate management screen just to mint the thing they want to assign: they invent it and assign it in one motion (create a category from the category picker, a tag from the tag picker). This is a deliberate stance that the UI must not get in the way of the user's actual intent. Only *creation in service of an assignment* has to be inline — deletion, renaming, reordering, and other maintenance can live on a dedicated screen, because that is not what the user is in the middle of doing. When adding a new picker/selector for any assignable thing, include its inline create affordance from the start rather than deferring it to "manage it in Settings."

- **Copy that names a capability is a claim the UI has to honour.** Text telling someone to do a thing
  ("replace the vault key after removing someone's access") asserts that the thing is reachable from
  where they are standing. The vault settings shipped exactly that sentence with no member list and no
  way to remove anyone — the endpoint existed, only the surface did not — which reads as a dead end
  rather than as a missing screen. The moment to check is when the copy is written, not when someone
  tries to follow it.

- Favor consistency over novelty. When a control already exists elsewhere in the app, reuse the same interaction and styling unless there is a strong reason not to.

- Keep look and feel consistent across pages. Similar data structures should use the same spacing, controls, and interaction patterns so the app feels like one coherent tool rather than a set of isolated screens.

- Treat repeated UI elements as shared product language. Trees, pills, menus, inline editors, overlays, tables, selectors, and other controls that appear on more than one page should keep the same look, spacing, and behavior unless there is a very strong reason to diverge.

- **Search first, then build — reuse is the default, a one-off needs justification.** *Before* writing any UI element (a list, table, panel, dialog, picker, inline editor, button), find the existing shared component — check [`shared-components.md`](shared-components.md) (the "what do I use for X?" index) or grep for the concept — and reach for it. Do this *at the moment you decide how to build*, not just once at session start; reading the docs earlier is not the same as consulting them at the build decision. If genuinely nothing fits, state why you are introducing a new component in your summary. And do not shape a bespoke backend endpoint to fit a quick UI — check whether the existing endpoint plus a filter already returns what the shared component needs. (This rule exists because a one-off transaction list was built when `TransactionListTable` already had several users — the failure was not consulting the pattern at build time, not missing knowledge.)

- Treat recurring domain objects as shared product language too. When a user, account owner, category, account, or similar named thing appears on multiple screens, its basic add/edit/remove behavior should feel the same unless the workflow is genuinely different.

- The reason for this consistency is not only aesthetics. Reusing the same interaction language lowers relearning cost, makes the product feel more trustworthy, and avoids the impression that one screen is a lesser or temporary version of another.

- Shared form controls and dialog footers should come from shared primitives where possible so cancel/save rows and everyday input chrome do not drift across pages.

- **Native `title` tooltips are an acceptable choice, and sometimes the better one.** The shared `<Tooltip>` (`frontend/src/components/ui.jsx`) is the default whenever hover content needs theming, markup, links, or hover-into-it interaction. But a plain-text hint with none of those needs does not require it — a bare `title` attribute is fine. A native tooltip is also genuinely *better* in some cases: the browser draws it outside the page, so it auto-positions and can spill past the window edge, whereas the DOM `<Tooltip>` is viewport-clamped and can only ever stay inside the window. Where that edge behavior matters more than visual consistency — for example the Help page's section jump-nav — prefer native `title` and accept the look-and-feel mismatch as a deliberate trade.

- **The shared `<Tooltip>` does not inherit native `title`'s accessibility, so a migration has to restore it.** A `title` attribute is announced by screen readers and is reachable on touch; a hover/focus tooltip built out of DOM is neither by default. Any site converted off `title` needs an `aria-label` (where the hint *is* the control's name) or `aria-describedby` (where it supplements a visible label) added in the same change, or the conversion is a net accessibility regression traded for visual consistency. This is the standing cost of the migration and the reason it proceeds in reviewed batches rather than as a find-and-replace.

- **A hint attached to a row of a scrolling list needs a dwell before it opens.** Pass `openDelay={ROW_HOVER_OPEN_DELAY_MS}` (from `ui.jsx`) to `<Tooltip>` there. With the cursor resting anywhere over the list and the rows moving under it — wheel, page-down — every row that passes counts as a fresh hover, so a zero-delay hint strobes a card per row. The dwell costs a user who deliberately stops on a row nothing and removes the flicker entirely for one who is just scrolling past. `Tooltip` also closes itself on any scroll: it is positioned once in fixed coordinates against where its trigger was, so without that it would hang detached in mid-air while the row scrolled away. It closes on a right-click for the same class of reason: a context menu opens at the pointer without the pointer moving, so no `mouseleave` ever fires, and a hint that outranks every other layer (its z-index has to clear the dialog stack) would paint over the menu — and, when `interactive`, keep pointer events and swallow the clicks meant for the items it covers. **Both dismissals are armed by the hover itself, not by an effect keyed on the open/armed state, and that distinction is the whole behaviour.** An effect cannot run until React has re-rendered, and these events race it: `mouseover` → `contextmenu` on a transaction row measures **2ms** end to end, so a listener registered from a render is still unattached when the right-click passes — the dwell is never cancelled and the card opens 300ms later over the menu, where (being `interactive`) it swallows every click aimed at the items beneath it. That shipped, and read as an intermittent Playwright failure for a while, because whether React flushes inside those 2ms depends on load; a person right-clicking a merchant loses the same race reliably. So the listeners go on in `show()` and come off when the hint actually closes, which also keeps the "idle tooltips in a list cost nothing" property the effect was there for. **Note this is only fixable for our `<Tooltip>`** — native `title` timing is entirely browser-owned, so a hint that needs a dwell cannot stay a `title`. The Amazon reconciliation and import-detail order/charge cells are the reference case. `openDelay` defaults to 0, which is right for the common case of a small button or icon.

- When a UI behavior is meant to be shared, implement the shared behavior first. Do not land a one-sided or page-specific version and plan to “sync it up” later unless the narrower scope is intentional and explicitly documented.

- Before changing a UI interaction, decide whether it is page-specific behavior or shared product language. Shared product language should be implemented and reviewed with parity across all affected surfaces from the start.

- When a screen has a dedicated close action in its header or panel chrome, prefer placing that close control at the upper right unless that surface already follows a stronger established pattern.

- Keep advanced and less-common settings below everyday workflows.

- Use inline editing for lightweight data changes; reserve dedicated forms or modals for multi-step or higher-risk actions.

- Treat transient edits as cancellable work. If a control enters a temporary edit state, the user should normally be able to back out without keeping the in-progress value, and similar transient controls should behave the same way across the app unless there is a strong reason to differ.

- Let the user control presentation where it materially helps them work. This includes things like panel placement, list scrolling, filtering, and other layout choices that improve usability without turning the app into a fully user-designed interface.

- Remember a user's working UI state across pages when it materially helps them resume work. Things like panel open/closed state, table layout, and similar view preferences should use the shared per-user/profile preference model with local cache plus best-effort backend sync, rather than one-off page-specific persistence.

- Prefer user control over hidden inference when the choice affects meaning. For example, ownership, mapping, and destructive actions should be explicit when there is more than one reasonable interpretation.

- Long transaction ledgers should let the user change sort directly from the column headers. When the list is paged or incrementally loaded, the sort should be applied by the backend so the whole filtered result stays in one consistent order.

- If a table header supports more than one interaction, the affordances should still read as one clean surface. Pill-style headers are a good fit when the label handles sort and move while the resize target remains visually tied to the column it changes. In scrollable tables, dragging a resize control should normally change that column's width directly instead of silently reallocating space into its neighbor.

- Pill-style multi-interaction headers should come from a shared header component rather than page-local copies. Sortability, drag-to-reorder, resize, and uncommon per-column actions such as a context menu should all be individually optional so quieter tables can reuse the same visual language without inheriting every behavior.

- When a screen needs the full pill-header table pattern, prefer a shared table shell that owns the header, column resize/reorder wiring, and shared grid template. Individual pages should still own row rendering, selection, sorting semantics, and data loading unless those behaviors become meaningfully shared too.

- When a pill-header table is hosted inside a modal or dialog, the dialog should own both axes of scrolling through a single outer scroll container (for example `flex: 1, min-height: 0, overflow: auto`) with the pill header pinned via `position: sticky`. A nested vertical scroll inside the table body will consume width from the grid's last column when the scrollbar appears and clip the rightmost cell. The duplicate-rows dialog on the Import / Export page is the reference implementation.

- When column order or widths materially affect how a user works, that table geometry should persist through the shared per-user preference model instead of resetting every time the page or dialog opens. The shared `useColumnPreference(prefKey, defaultColumns)` hook (`frontend/src/lib/useColumnPreference.js`) is the one way to wire this: it returns `[columns, onColumnsChange]`, merging the saved order/widths over freshly-computed defaults (clamping persisted widths, dropping unknown keys, appending new columns). The usual host is `PillGridTable` (the duplicate-rows dialog and the matching-imported-transactions report spread it straight in). A table that can't adopt the full `PillGridTable` shell can still reuse the hook for persistence and drive a plain `PillTableHeader` from its merged widths — the Accounts list does this (see the horizontal-sizing note below). Either way, reuse the hook rather than re-implementing the merge.

- **A list that can grow past a few hundred rows should be windowed, and windowing requires a column geometry that does not depend on the mounted rows.** Render only the rows in/near the viewport through the shared **`WindowedRows`** (`components/WindowedRows.jsx`, measured heights on `@tanstack/react-virtual`) so DOM node count is bounded by the viewport rather than the dataset — `MatchReport`, `TransactionListTable`, and the Transactions ledger all use it. The precondition is that column widths come from the shared grid template (`PillGridTable`'s `--pgt-grid`, fed by `useColumnPreference`) rather than from the browser auto-sizing a `<table>` against its content: an auto-sized table re-computes its widths from whichever rows are currently in the DOM, so columns visibly jump as the user scrolls. Three invariants a windowed list must not break: **sort and selection stay driven from the full entry list**, never the mounted subset (select-all must keep meaning "all filtered rows"); any per-row id helper must not scan the list to find a row's index — the windower calls it per mounted row, which turns an `indexOf` into O(n²); and **do not put `content-visibility: auto` on a windowed row** — windowing already keeps unmounted rows out of layout, and the `contain-intrinsic-size` placeholder feeds the virtualizer a wrong measured height. A corollary for anything that read rows out of the DOM (the ledger's old drag-select CSV copy did): after windowing only the mounted rows exist, so drive it from the selection/data instead. The one list deliberately left unwindowed, and the four obstacles in its way, are in `docs/scale-and-limits.md`.

- **A list of records *about* periods is organized by the period, not by when the record was made.** The import history is the reference. A card's `imported_at` answers "when was the button pressed", which stops being the useful question the moment historical data is loaded: a year of back-filled files all carry today's date and order by nothing meaningful. So the backend records the span each card covers (`import_batch.covers_*`, written by `services/import_batch_totals.refresh_batch_coverage`) and the history orders, windows and groups by that. Two refinements the data forced. A **statement declares its period** and that declaration beats the span of the rows inside it — a February statement covers February even where its four transactions fall across four days — so the stored span carries a `covers_source` saying which kind of answer it is, and the card names it on hover. And the span is read from the imported rows **and the deduplicated ones together**: a file whose every row matched an earlier import still covers those dates, and asking `txn` alone answers "nothing" for exactly the files a user most needs to place. Import time stays on the card, muted, because it is still the answer to "which of these did I just load" and the provenance Undo acts on.

- **A list that accumulates one row per event, forever, takes a per-source recency window with a reachable archive — never a cap.** Each expanded data source lists only its recent cards and files the rest into an **"Older imports"** disclosure grouped by the year they cover, newest archived year open and deeper years one click further (`lib/importExport/importHistoryWindow.js`, `components/importExport/ImportHistoryArchive.jsx`, shared by the generic data-source row and the marketplace vendor row). Four properties make this an archive rather than the silent cap it replaced (`docs/scale-and-limits.md` → *Import history: retention*). The window is **per source**, so an actively-fed source cannot crowd out a quiet neighbour's recent cards. **The recent list is a prefix of that order, never a subset of it with holes**: membership is the newest few by coverage (`RECENT_CARD_COUNT`) plus anything whose span starts within the last `RECENT_WINDOW_DAYS`, and it asks nothing about import time. The order runs on where each card's span **starts** (newest first, ties on its end), and the window and the archive's year groups test that same date, which is what makes the list a prefix without enforcing one. The start rather than the end because a span's start is how far back that pull reached: ordered by end, a connection's initial import — one card spanning every month its first pull fetched — rose above the later months it overlapped, and a long card running up to today stayed in the list beneath a shorter, older one already archived. A sync card whose every row was refused has no span and is placed by its month (`sync_period`), not its creation time. Keeping recently *imported* cards as well was tried, so that a backfill could not land straight in a collapsed archive, and it is the mistake to avoid — a card imported months ago whose period falls between two kept ones was lifted out of the middle of the list, so one year appeared both in the list and as an archive group, on a list that presents itself as ordered by period. It also bought little: when transactions are recent, which is the ordinary case, coverage already puts a fresh import at the top. If hiding a backfill ever does bite, expand the archive year that received it at the moment of import — do not make membership mean two things. The disclosure **carries the same attention pills as the collapsed row it sits inside** (`HistoryAttentionPill`), at both the archive and the year level, so work behind it still announces itself. And a tail shorter than `MIN_ARCHIVED_CARDS` is left in the list, since hiding one or two rows costs the reader more than it saves.

- **When a removal's object cannot be named on the control, the control is in the wrong place.** The import history's stored-detail screen is the reference. What is removed is a card's *duplicate report*, not its transactions — but on a row labelled with a filename, any verb for removing something reads as acting on that file's contents, whichever verb is chosen, so no label fixes it. Moving the action to a screen of its own does: the object can be named (the screen is titled *Free space from duplicate transaction entries*), what the record is **for** can be explained before it is offered for removal, the space can be attributed to where it actually is, and more than one import can be dealt with in a pass. Its entry point sits in the section heading's **action group** (*Group imported categories*, *Generate rules*, *Free up import space*) rather than beside the heading's own *Manage sources* chip: the two slots are not interchangeable, since the subscript chip belongs to the concept in the heading while the action group acts on the rows below. Where a control's object lives decides which group it joins — and where naming the object on the control is what was missing, the entry point's label can say the benefit (*Free up import space*) and leave the object to the screen's own title. One more thing the screen owes: a figure like "42 KB" against a row is ambiguous between what is held and what would be freed — identical here, since clearing takes all of it — so the column is **named** rather than left to be inferred. Two rules the screen keeps: the removal is **manual and never scheduled**, because an automatic retention policy would be the silent cap this surface exists to replace and the removal cannot be undone; and the confirmation's figures are **counted server-side by the same code that performs the write**, never assembled from what the client happens to hold, so the sentence agreed to is the one carried out. The screen now offers **two** removals, which is why neither button is a verb alone: *Remove rows already in the ledger* takes only what an import running today would never have written (`data-model.md` → `ignored_count`), and *Clear all detail* takes the report entire. Two buttons on one selection are worth the cost here because the objects genuinely differ and the narrower one is what almost every card wants — it frees most of the space while keeping every refusal that still needs a look. The narrower confirmation answers the same two questions in the same order, with one difference: **what stays is stated even when nothing does**, because "8 rows stay, including 3 still flagged for review" is the reason to choose it over the wider action, and an empty clause would drop exactly that. And when a selection holds nothing of the kind the screen says so in its own dialog rather than doing nothing visible, since a button that silently declines reads as broken. It answers both questions in order — what is lost, then what stays — with the reassurance last, where it is read rather than skimmed past on the way to the button.

- **One count, summed one way, wherever it appears.** A card's duplicates pill counts entries in the duplicate report still waiting for a verdict — soft-flag suspects **and** the rejections flagged amber (`advisory_review_count`) — but the collapsed source row and the archive disclosure above it originally summed only the suspects. A source whose entire outstanding workload was of the other kind therefore read as completely clean while every card inside it showed amber. The aggregates now come from one shared summarizer (`summarizeBatchAttention`), so a roll-up cannot disagree with the rows it rolls up; where a count is shown at more than one level, derive every level from the same function rather than re-summing per surface.

- **A surface that has lost its backing data says so, and stops offering itself.** Clearing a card's detail leaves its `deduped_count` intact and truthful, so the card goes on reporting what the import did — but the duplicates pill, whose contract is to open a report, is withdrawn rather than left to open an empty one, and a line on the card says the detail was cleared. Without the line a cleared card is indistinguishable from an import that refused nothing; without the withdrawal, a count on screen names rows nothing can show.

- **An outcome the reader would otherwise have to compute is stated.** A file that re-states a period an earlier import already covered lands nothing, and the card said so only by arithmetic — a row count sitting above a duplicates pill of the same size. It is the ordinary result of importing statements over an activity export, so the card says "No new transactions — every row was already in the ledger", and says what it *did* do in the same breath (the detail it folded into the rows it matched). Naming only the half that failed would be the more misleading summary.

- **A long, name-keyed list can be browsed with alphabetical sections + an A–Z jump rail, and it composes with windowing.** The Rules page is the reference: the (pre-sorted) list is flattened into one mixed `WindowedRows` stream of section-header items and row items (`buildSectionedRuleItems`), so a single windowed scroll container carries both. A horizontal **"Jump to:" A–Z strip** sits in the fixed header region (under the search box, so it stays put while the list scrolls) and shows every letter always — present letters are active (click jumps via the virtualizer's `scrollToIndex`, since the target header may be unmounted), absent ones dim, and the letter at the top of the viewport is highlighted (fed by `WindowedRows`' `onTopIndexChange`). Section dividers are **not** sticky — true sticky-in-a-virtualizer isn't worth its complexity, and the rail's running highlight already gives orientation. Prefer this over a collapsible letter tree for a *flat* set (rules aren't hierarchical; collapse/expand would add a toll between the user and every row).

- **The shared date filter separates a *setting* (persisted, per-page default) from a *filter* (ephemeral, explicit, shared).** The app-wide date chip starts **unset** (no seeded default — an earlier hardcoded "past 12 months" seed reappeared on every reload and leaked between pages, which is exactly the surprise to avoid). "Unset" is then reinterpreted **per page**: the **Dashboard** treats it as its own configurable **default period** (`ui.dashboard.defaultPeriod`: `ytd`/`last12m`/`all`, set via the ⚙ gear beside the title), while **Transactions** treats unset as all-time. This resolves the old tension — *different defaults, but a shared explicit choice*: once the user picks a date it's honored on both pages, and clearing returns to each page's default. The default never leaks because it's a **page-local reinterpretation of unset**, not a value written into the shared filter. Mechanism: `FilterContext` exposes `getDate()` (`filters.date || dashboardDefaultDate`, the read counterpart to `setDate` — prefer it over reading `filters.date` directly) and `dateIsDefault`; the Dashboard registers its resolved default via `setDefaultDate` on mount and clears it on unmount, so a default is only ever in effect on the page that set it. The chip renders the default **muted with a "· default" hint** so an in-effect default is never a hidden filter. There's no "Automatic" menu choice; instead the **first-visit seed** picks the initial concrete default — **Last 12 months if the current year has data, else All time** (a one-shot, session-cached probe, so loading old historical data doesn't open the Dashboard on an empty window) — and persists it as a normal choice, so it never re-evaluates behind the user's back. The Dashboard **holds its first paint** until that seed resolves rather than flashing all-time. An explicit **"All time"** preset (a truthy `{start:null,end:null}` sentinel) *overrides* a default, distinct from unset — so trend helpers that key on a concrete range treat it as no-window. **The Dashboard's single-period trend chart is deliberately independent** of this default: it covers the whole of its own **trend span** (a separate setting — see *The single-period trend* below) rather than the selected period, and highlights only an *explicit* pick, so under the default it opens monthly with nothing selected; only the totals/breakdown/drills follow `getDate()`. `lib/dashboardDefaultPeriod.js`, `lib/FilterContext.jsx`, `components/FilterBar.jsx`.

- **Search and structured filter are two separate tools, and a page-local filter must not couple to the app-wide `FilterContext`.** A free-text **search** box narrows by one obvious field (the Rules page searches *merchant only* — never the category/tags, so it can't flood), while a **Filter** popover narrows by structured facets (category, tag, owner, account, type, boolean flags) shown as removable chips; search runs within the faceted subset. The app-wide `FilterContext` (the Transactions/Dashboard `FilterBar`) deliberately *persists across pages* — a per-page filter like the Rules one must stay independent of it and is instead **session-scoped** (`sessionStorage`, like the Transactions `quickFilter`): it survives navigation but resets on next launch, so a user never returns to a mysteriously filtered page. Draw facet options only from values actually present in the data, so the filter never offers a choice that matches nothing.

- **The ledger search is one box with a small grammar, and it is served by one backend clause.** The Transactions search box and an import card's ledger search both send `quick_filter` (a parameter name that predates the *quick filter* control below and is unrelated to it), which `_build_quick_filter_clause` (`routers/transactions.py`) resolves; the user-facing statement of it is the `searching-transactions` help topic, and a change to either moves the other. Its rules, and why each holds:
  - **An unprefixed search ORs across every facet** — names, the import's captured free text, category, account, date, amount, and attachment text — so the box finds a transaction without the user knowing which field holds the term.
  - **Names means every name on the row, not the visible one**, and an unprefixed search adds the captured free text (`import_evidence_json`'s description slot and `extra_text_fields`, the set `match_source_text` rules read). A rule's clean name or a manual rename replaces what the bank sent, and a search for the bank's own wording has to keep finding the row. `merchant:` means names and leaves the free text out; `raw:` is the reverse — the raw name plus the free text, leaving out the rename and the cleaned name, so what the bank or file actually sent can be searched alone. The raw name is in both because it is both a name and imported text, and a row with no captured evidence (a manual entry, an older import) would otherwise be unreachable by `raw:`.
  - **A row found through text not on screen is marked, not hidden.** The list feed projects `matched_hidden_text` (a hidden name or free-text match whose visible name does *not* match) beside `matched_document`, and the row underlines the name, whose origin hover says the match is in the text it lists. Both flags are projected only when the filter has that component. This is the same resolution as the document search (`data-model.md` → *Attached documents*): explain the match rather than keep it behind a prefix.
  - **A keyword is recognized only at the start, and its value is everything after it**, so there is exactly one per search and `+5.00 merchant:x` is a single piece of text. Combining predicates precisely is what the page-local controls are for (the amount-filter bullet below), rather than a growing boolean grammar in the box.
  - **An amount's dollars are exact and only its cents narrow as they are typed**: `77` is $77.00–$77.99, `77.4` is $77.40–$77.49, `77.45` exactly that. Matching to the cent found nothing until the last digit was in, so a $77.35 charge stayed hidden at `77` beside a $77.00 one. The dollars are deliberately not a prefix — `7` never reaches $70 or $700, which would flood the list at every keystroke. The parser returns a range in whole cents and the clause compares with `BETWEEN`, whose edges are exact where float edges are not.
  - **An amount's sign is read as a person writes it**: `-42.10` money paid out, `+42.10` money received, bare either, parentheses as a minus. Storage runs the other way (`amount > 0` is money out) and the clause flips it; the parse is a strict pattern, never `Decimal(...)`, which accepts `inf`/`nan` (a server error while typing a name) and exponents.

- **Two-line "sentence" rows beat a fixed-column table when both sides are variable-length.** The Rules row puts the matcher on line 1 and the actions on line 2, both wrapping under the same rules — which removes the incoherence a 2-column grid produced (one cell clipped with an ellipsis while the other wrapped to three lines). Reach for this shape when a row's left and right content both grow unpredictably; keep the table only when columns genuinely align.

- **Bulk cleanup is opt-in, previewed, and reversible.** The Rules page's stale-rule cleanup is the reference: the user picks a timeframe that **starts unset ("—")** so nothing is ever swept by default; choosing one surfaces a count and a review panel listing the matching rules **each pre-selected with a per-row control to keep it**; confirming moves the set to a **trash** (recoverable), not a hard delete. Destructive intent is separated from safe intent — the batch is **retain-by-default** (leave the data the rules produced alone) with an explicit opt-in to also revert it. A "sort by X" that reorganizes the same list (here **Last used** vs the default **A–Z**) is a mode toggle that swaps the whole view (the alphabetical version's section rail hides in the chronological one), not an additive control. When you add a new kind of deletable object, give it a bucket in the existing Settings → Trash surface (restore + purge + empty), consistent with accounts/transactions — don't invent a separate recovery flow.

- **A filter's category picker must stay findable as the taxonomy grows — group it, make groups selectable, and add a type-to-filter box.** A flat category checklist is unusable at scale. Both filter surfaces follow the same shape: categories are **grouped under their parent group**, a **type-to-filter search** appears once a list passes a small threshold (~8), and a **group is itself selectable** (matches any leaf under it) so a user need not tick a dozen leaves. The app-wide `FilterBar` goes further — the old separate *Groups* and *Categories* tabs are now **one collapsible, selectable tree** (check a whole group, or expand and check leaves; default collapsed; a search force-expands the hits). This is the reference for a picker over a real hierarchy; the Rules popover uses the lighter grouped-checklist form of the same idea. When you fold two selection surfaces into one tree, preserve every selection token the old surfaces emitted (here: `type:'group'`, `type:'category'`, the super-group income/expense select-all, and the synthetic NULL-bucket ids) so downstream consumers are unaffected.

- **Any facet selection can be *include* or *exclude* ("is not"), and the primary click always means include.** In the app-wide `FilterBar` a facet row's main click adds/removes it as an **include** (the historical, unchanged gesture — zero relearning). Exclusion is a **single, quiet, always-present `≠`** on the row's right edge: persistent so the option is *discoverable*, but visually secondary (muted, low-opacity) so it never reads as a second competing button to aim between — the reference resolution when a per-row secondary action is needed but "two equal affordances" is the wrong feel. A `✓` marks an included row; the `≠` itself turns danger-colored to mark an excluded one. The **chip** is the second place to flip mode: clicking a chip body toggles include↔exclude (an excluded chip reads in the danger hue with a leading `≠`), mirroring the row. Each selection carries `mode: 'include' | 'exclude'` (default include) in `FilterContext`; **pages must split selections by both type and mode** — an exclude chip fed into an include param would silently invert its meaning. Exclusion is offered on **every** facet, tags included: excluding a tag is the inheritance- and block-aware inverse of including it (`NOT (effective_tag_match_sql)` — a row that has the tag directly *or* via its category/group/account is dropped, and a row that only inherits it but has it manually hidden survives). The tags tab also leads with a synthetic **Untagged** row (no effective tag at all, `'__untagged__'`) — the complement of "has any tag," so `≠ Untagged` filters to only-tagged rows; it's always present even before any tags exist and mirrors the category *Uncategorized* / owner *unassigned* buckets. Row-level flags that live in the marker strip — recurring, attachments, needs-review — are **not** tags and get their own **Attributes** tab (`data-model.md` → *Attributes*); `Recurring` briefly rode the tag facet as a synthetic `'__recurring__'` id to avoid threading a param through every summary endpoint, and that is the shape to avoid rather than copy: values within a facet OR, so a tag plus a pseudo-tag meant *either*, where the combination anyone wants is *both*. The facet registry is what makes the honest version cheap — a new axis is one row, not a param per endpoint. Semantics: includes within a facet OR; excludes AND on as NULL-safe negations (tags negate a null-free `EXISTS`, so plain `NOT`, not the COALESCE guard); across facets everything ANDs (see `data-model.md` → filter exclusion). When a filter feeds more than one surface, exclusion must reach **all** of them at once (the Transactions ledger, every Dashboard totals/trend/drill call via `summaryFilters`, and the CSV export) — a chip that filtered one page but not another would be a split-brain; that is why the exclude params ride the shared `summaryFilters` object rather than being wired per-call. **The tag filter (`effective_tag_match_sql`) is one shared definition** across the ledger, summaries, and export, so a tag chip means the same thing everywhere; the CSV export was quietly matching *direct tags only* before, silently omitting rows tagged via their category/account — a real bug the unification fixed. When an exclude chip removes a slice the active Dashboard spending report breaks down, a quiet inline note says so (see next bullet); the exclude is still honored, never suppressed.

- **Warn when a filter leaves out what a report is showing — quietly.** When the filter removes a slice the active Dashboard spending report would otherwise break down — `≠ Business` on a tag report built from Business, `≠ Groceries` on the category report, an excluded category inside the group you've drilled into — show the shared **`FilterConflictNote`** (`components/ui.jsx`) above the breakdown. The overlap is computed client-side by `computeReportSpendingConflicts`/`describeReportConflicts` (`lib/reportFilterConflicts.js`): the report axis and the chips both live in front-end state, so it's a set intersection with no server round-trip. Deliberate boundaries keep it from crying wolf: **like-for-like only** (tag chip↔report tag, category chip↔category slice, group chip↔group slice) so an *indirect* account/owner filter that happens to drop a category never triggers it; and **view- and totals-aware** (skip `exclude_from_totals` rows and the other income/expense view's groups, which the report never showed — so a standing `≠ Transfers` chip doesn't nag). **Tag reports flag two symmetric cases** (each conflict carries `reason: 'excluded' | 'missing'`): a report tag `≠`-excluded, *or* — when a tag *include* filter is active — a report tag missing from that include set, since including only tag A on a report built on {A,B} drops B's rows exactly as excluding B would. For **group/category** reports the include case is *not* flagged (a category has one group, so an include chip is ordinary focusing, not co-occurrence distortion) — see `docs/backlog/tag-report-exclude-warning.md`. The note names up to two slices then "and N more"; its action (`resolveConflictSelectionIds`) drops the offending exclude chip ("Clear exclusion(s)"), or for any tag-report conflict clears every tag chip ("Clear tag filter") — a missing tag has no chip of its own to drop, and the button is named after what it does rather than a report-outcome promise. The same `FilterConflictNote` is reused for the Transactions "your filter is hiding matches" zero-results note (next bullet).

- **A settings section is named for what it currently contains, not for the category it will eventually grow into.** A heading promises the settings under it: one named for a category it only partly covers reads as a section missing its other controls, and the user goes looking for something that was never built. The ledger-currency control therefore ships as **Currency** rather than *Internationalization* or *Locale*, even though those are where it is heading — the broader name becomes accurate on the day a date-format control joins it, and renaming it then is the cheaper error than promising it now. The same rule applies to a menu or a dialog title covering one case of several.

- **A page's primary create action is named for the verb, not the noun the page already supplies.** The
  Rules page's button is **+ New**, not *Add rule*: the heading above it says Rules, so repeating the noun
  buys nothing and costs header width the controls beside it need. This holds only where the page *is* one
  thing — a page listing several kinds of record still has to say which one it creates. The convention is
  settled and the other pages have not caught up yet (Accounts still says *Add account*); they follow when their headers are next touched, rather than as a sweep. A label a Help
  topic quotes moves with it, and so does the empty state that tells a first-time user which button to
  press.

- **When the ledger comes back empty, say whether a filter is *hiding* matches — but only when it truthfully is.** The Transactions list, on settling to zero rows, runs a lazy server **probe** (`lib/searchHidingProbe.js` → `planHidingProbes`): it re-issues the same query with one *subtractive* constraint dropped and checks whether rows appear. The order is date window, then exclude chips, then (if both are active) both together — first non-empty probe wins and sets the note via the shared `FilterConflictNote`, with an action that clears exactly that constraint. Only the **zero-results path** pays the cost (one or two `limit:1` calls), and a filter change cancels an in-flight probe. Two rules keep it from crying wolf: a probe **keeps the search text and every include facet** and drops only subtractive constraints, so a non-empty result means "things matching what you actually asked for exist outside the filter" — not just unrelated rows; and it **only probes when there's a narrowing intent to preserve** (a `quick_filter` search, an include facet, or the needs-review toggle) — with only a bare date/exclude active and no intent, dropping them surfaces unrelated transactions, which isn't a useful thing to announce, so it stays silent. Include facets are never dropped: an include that yields nothing is genuine emptiness, not the filter hiding data. This is the deliberate counterpart to the Dashboard report-overlap note — same component, opposite surface (a list that went empty vs. a breakdown missing a slice).

- **The Transactions ledger's amount filter is *page-local*, like the ledger search — not part of the shared FilterBar.** A compact toolbar popover (`components/AmountFilterControl.jsx`) reuses the **exact same `AmountCondition`** control the rule editor uses (`RuleForm.jsx`, now exported): Both/Debits/Credits, Range/Equals, a per-bound comparator (`>=`/`>`, `<=`/`<`). Semantics mirror the category-rule amount clause — the magnitude bounds compare against **`ABS(amount)`** while the debit/credit **side rides the existing `direction` param**, so the sign applies separately (e.g. "credit, ≥ $50" → `amount <= -50`). It is deliberately *not* a shared-FilterBar facet: the FilterBar persists across pages and feeds the Dashboard, but an amount slice is a ledger-only working filter, so it lives beside the ledger search as **session-scoped** page state (survives navigation, resets on next launch) and reaches the backend through the same `_build_transaction_filter` params (`amount_min`/`amount_max`/`amount_min_op`/`amount_max_op` + `direction`), so bulk "select all matching" resolves the exact filtered set. Because an amount filter that yields nothing is *genuine* emptiness (like an include facet, not a subtractive constraint), it registers as **narrowing intent** in `planHidingProbes` but is never a droppable probe — the date/exclude "hiding matches" note still fires correctly with an amount filter active. When a new precise, page-scoped predicate (that also exists as a rule condition) is needed on the ledger, prefer this shape — a page-local popover reusing the rule control — over extending the fuzzy OR-based search grammar or adding a shared-FilterBar facet. **The reuse is of a contract, not of a widget, so check the contract first.** The recurring series' pinned expectation band was the case that failed it: `AmountCondition` carries per-bound comparators and a debit/credit side, while a series band is inclusive at both ends and its direction is already settled by the series' own charges — so the shared control was the *wrong* contract rather than merely a heavier one, and reusing it would have offered two controls that cannot mean anything there. Where a candidate's extra dimensions have no answer in the new context, build the smaller control.

**Accepting a suggestion is reversible, and reversing it is not a judgement.** "Back to suggested"
(`POST /recurring/{id}/unconfirm`) returns an accepted series to the pile it came from. Before it, the
only ways off a confirmed card were Suppress and Mark ended — both of which record a *claim* ("not
recurring", "this has stopped") when the wanted state is no claim yet, which matters most when the
series is someone else's to judge. The card moves buckets with no scan, because the page derives a
card's bucket from `confirmed`/`status` rather than from a stored label. Offered only for an **auto**
series: the pile it returns to is the detector's, so there must be a detector candidate behind it — a
manual series is undone by deleting it and a rule-backed one by unchecking its rule, and the endpoint
refuses both rather than silently doing nothing. Paired with an Undo on the confirm toast, since the
slip it exists for is a single misplaced click and the card leaves Suggested the instant it happens.

- **One card for a two-legged money movement.** A transfer between two tracked accounts — or a card payment — is a single movement the ledger records twice, once per account. The detector pairs those rows and reads the rhythm off the pairs, so a movement arrives as **one series that owns both legs** (`counterpart_account_id` is what marks it — see `data-model.md`). There is no folding on the page and no reconciling of two readings: one series means one card, one count, one set of actions, by construction.
  - The card carries the accounts as a `from → to` block in place of the single account chip, and the chip is suppressed so the paying account is not named twice. The in/out word is dropped from the amount — money moving between two of the user's own accounts is neither, and the arrow already says which way. The count is **rows across both legs**, the same rule as everywhere else on this page: the number beside a link is what the link opens. How many times the money actually moved is `transfer_count`, on the block's tooltip rather than competing with the link.
  - **Transfer & payment review** (`GET /recurring/transfer-review`) is a header button opening `TransferReviewDialog`, and it carries the one case the detector refuses to settle on its own: *which transaction is the other half?* — a tie between two same-day, same-amount candidates, which nothing in the ledger distinguishes. A movement itself is never listed here, because it needs no permission: it claims its rows outright (see `data-model.md`).
  - **A report of refusals must not become a report of decisions already made.** The panel also carried a *split across two series* offer — accept the movement in place of the confirmed payee series holding its rows, or decline. It was withdrawn, and the shape of its failure is the durable lesson: it put the movement's own total beside a blocking series' total, two populations that do not subtract, and said nothing about how much of either overlapped. A user reading `44 transactions` against `23 transactions` cannot see that six rows are at stake, or that accepting would unlink seventeen rows on two unrelated accounts. **A card that offers a trade has to state the trade in the quantities being traded** — and where a trade turns out not to be needed at all (membership is exclusive, so the movement only ever wanted its own rows), the honest fix is deleting the card rather than wording it better.
  - **The question gets an answer *and* a refusal.** A list that offers only "accept" is a nag: its count never falls for a user who looked and decided no. So the item carries `Accept` beside `Dismiss`, the answers are stored (`transfer_pair_decision` — see `data-model.md`), and answered items drop out of the count. They do **not** drop out of reach: the button stays visible with no number while answers exist, because answering the last question must not hide the way to un-answer it, and an `N answered · show` list at the foot of the panel restores any of them — the same escape hatch `DismissedSignalsDialog` offers on this page. A disabled action has to say why it is disabled (the pair picker's `Accept` is off until a candidate is chosen, wrapped in `Tooltip` because a `title` on a disabled button renders nothing).
  - **Its strings name the effect, never the internals.** "Movement" is the code's name for a pair of rows; the reader has only ever seen these called transfers and credit-card payments, and the first version's *Use the movement instead* named neither what it did nor what "instead" replaced.
  - **It is a floating panel, not a modal** (`DetailPanelShell` + `useDetailPanelChrome` + `useRestorablePanelGeometry`, as `UnifiedDuplicatesDialog` uses). A report worked through wants drag, resize from any edge, geometry remembered across opens, and the ability to be parked while the user goes and looks at a series — which is also why it does not block the page behind it. Reaching for `AppDialog` here was the mistake `shared-components.md` exists to prevent.

- **The Recurring page's drill-down serves single-series, all-series and suppressed-series reports through one paged list.**- **The Recurring page's drill-down serves single-series, all-series and suppressed-series reports through one paged list.** The bottom drill-down (`ReportPanel` + `usePagedTransactions`) is keyed on `openSeries`, and the member fetch branches on it:
  - a real active/confirmed series → **`recurring_series_id`** (its linked members);
  - a **money movement** → the ordinary `recurring_series_id` fetch, which already covers both legs: one series owns them, which is the point of pairing the rows rather than the series;
  - the **all-series report** → a synthetic marker (`{ id: '__all_recurring__', _all: true }`) → **`recurring_only`** (every row linked to any series). It's launched by the **standard report `↗`** sitting in the `PageHeader` `titleAdornment` beside the "Recurring Transactions" title (not a header button — the ↗ is the app's report-launch affordance). The synthetic id matches no `SeriesCard`;
  - a **suppressed** series → it owns no rows (suppress nulls its members' `recurring_series_id`, because that column is the app-wide "is recurring" flag and a rejected series must not light up the `↻` marker or the recurring filter), so a `recurring_series_id` fetch would be empty and the "N transactions" link would look broken. Suppression therefore **records the ids it held** first (`recurring_series.suppressed_member_ids`) and the link opens exactly those, which is the only way the list can equal the count beside it: **membership is the detector's judgement — a periodicity fit over one charge per date — and no predicate restates it.** Re-deriving it was tried and failed in both directions at once: matching the series' visible payee label missed the members a bank had spelled differently (three charges, one row listed), while matching payee-plus-account swept in every unrelated charge to the same counterparty (three charges, eleven rows). A series suppressed before the snapshot existed has nothing to recover, so it falls back to matching on the series' **whole identity** — `payees` + `category_ids` + `account_ids` — and the count reconciles (see below). The amount band is deliberately not part of that fallback: it discriminates two price points of one payee, which answers *which series a row joins*, not *which rows this series concerns*.

  - **An opened report corrects the count that opened it.** The card's number is a stored statistic; the report's `total` is what the fetch actually found, and where they differ the rows on screen are the honest answer — so opening a series rewrites the count beside it rather than leaving a link that promises three and shows four. Local only: `occurrence_count` on the server is the detector's own stat, and a match count is not it. This is the safety net under the snapshot rather than a substitute for it — an exact snapshot makes the two agree before anything is clicked, and this catches what the snapshot cannot (a legacy suppression, or a payee whose rows have changed since).

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

4. Scroll inside long data regions when the list grows large, rather than making the whole page excessively tall.

Prefer page-local scrolling for long lists, with header and controls remaining visually stable above the scrolling region.

When a page hosts several distinct management surfaces that don't need to be seen at once, prefer **in-page tabs** over a stack of collapsible cards — each surface gets the full width/height of the content area and the page reads as one thing at a time. The Import/Export page (`Import / Export / Backup`) and the Accounts page (`Accounts / Owners / Connections`) both use this: a simple tab-button row under the `PageHeader` over conditionally-rendered content. The active tab is **session-scoped** (mirrored to `sessionStorage`, not the durable preference store), so it persists while the app is open but resets to the primary tab on next launch — a within-session convenience, not a saved preference. A surface that *is* the only thing on its tab should render its content directly (or in a non-collapsible panel), not in a collapsible card — there's nothing to collapse it away from.

**A page's content column is measured inside the padding, not on it.** `maxWidth` on the element that also carries the page padding yields a column `2 × padding` narrower than one measured on an inner element — so a centred header sits a padding's width in from a centred list of the same nominal width, which reads as a stray indent rather than as a bug. Put the padding on the outer element and the `maxWidth` on a child, everywhere on the page including a docked panel's header and body, and name the width once per page rather than repeating the number. The Recurring page had three different left margins stacked on each other for exactly this reason.

**A header's action row wraps; it does not squeeze.** `PageHeader`'s action cluster is a flex row, and a
flex row without `flexWrap` shrinks its children instead of moving them to a second line — so a page
that accumulates a fourth or fifth control degrades silently at narrow widths rather than reflowing. Both
the cluster and the outer row wrap, and the cluster keeps `marginLeft: auto` with `justifyContent:
flex-end` so a wrapped line still sits hard right: dropped flush left it would sit directly under the
`<h1>` and read as content belonging to the heading, which stops the title looking like a title. Note
that every one of those properties is inert until the row actually overflows, which is what made the
change safe to apply to a component every page uses. The related question — whether a control belongs in
the header at all — is answered by what it *does*: the header carries things that act on the whole
subject (run a pass, add one, open a review of findings), while a toolbar under it carries what shapes
which rows are listed (search, filter, sort). A control that opens a report is a header action even
though it changes nothing, and a control that takes a threshold parameter reads as a toolbar one even
though it ends in an action.

**Tabs or a segmented toggle?** Both switch the body of a page; the difference is what the options *are*. A **tab row** names several separate management surfaces that happen to live on one page (Accounts / Owners / Connections). The shared **`SegmentedToggle`** (`components/ui.jsx`) names peer *views of one subject* — the Dashboard's reporting frame and analysis mode, the Recurring page's Series / Needs attention / Upcoming. Where a view's contents are the reason to switch to it, put the count on the control as a `badge` (`badgeTone: 'warning'` where the number is what wants attention): a count only visible after switching cannot tell anyone to switch. Both follow the same persistence rule — session-scoped in `sessionStorage`, with a URL parameter winning over the stored value so a deep link from elsewhere (the Tasks page's `?signal=<kind>`) lands where it means to.

**A search above a view selector narrows every view; each view's own pills sit above its rows.** The Recurring page's search box is above Series / Needs attention / Upcoming rather than inside the Series view, so one search reaches all three, and the status pills (Series) and kind pills (Needs attention) sit directly over the rows they select. A finding or an upcoming charge matches when **its series** does — the same name, category and either account — since a finding does not carry a movement's second account itself. The search narrows rows, never counts: the selector's badges and every pill count still say what exists, so a search cannot make a view look empty of work. The one figure that does follow it is the Upcoming header's count and total, which describe the list beneath them. The status pills end in a small **Deselect all**, since no selection shows nothing and picking one status otherwise means unticking the rest; it stays in place and does nothing when nothing is selected, so the row does not shift. Within a status the series are in one order — name or next due — with money movements sorted in among the bills and marked by their badge, not clustered after them.

**Split a page into views when two things are competing for one viewport, rather than rationing the space between them.** Findings about recurring series and the series list itself were stacked on one screen; the findings crowded the list and the drill-down panel out of the viewport entirely. Capping the findings' height made the page survivable, but the two were never usefully read together — the fix was to make them peer views.

**Separating views must not cost the connection between them — and the way to keep it is usually to bring the detail to the user, not the user to the detail.** Acting on a finding first *switched* to the series view with that series' drill-down open, which was worse in both directions: it took the user out of the list of findings they were working through, and the series list carries its own filter, which can exclude the very series being opened — leaving a drill-down describing a card that is nowhere on screen. A docked detail panel belongs to the *page*, not to one view, so it opens in place under whichever view is showing. Where a shared panel can be opened from more than one view, mark the row that opened it (the findings row highlights the way a series card does): the panel's own title does not say which of several rows it belongs to.

**What an action produces belongs where the action is taken.** The stronger form of the rule above, and
the one that decides *which page* a surface lives on rather than how two views on one page relate: a
record of what an operation did is part of that operation, so putting it on another page means going
somewhere else to see the effect of what was just done. The connection sync log was the case — it sat in
Settings, deep-linked from the connection cards, because a read-only diagnostic *looked* administrative;
but it is read minutes after a sync that brought in less than expected, which is the moment the user is
still standing where they pressed the button. It belongs with the connection work product, not with the
install's configuration — so it now opens from the Data connections card on Import / Export
(`components/connections/ConnectionSyncLogDialog.jsx`), beside the sync it describes and the cards that
sync writes to; a connection card links to it with `?connection=<id>`, which opens it scoped to that one.
Accounts → Connections opens the same dialog in place too — a provider card's **Sync log** button and a
connection's outcome pill — because that page is where someone goes looking when a connection seems wrong,
and one shared dialog costs nothing to reach from a second surface. The provider card's button is there
even with no connections, since a first connect that failed is exactly when the log is wanted.

**But "belongs with" is not "permanently on screen."** Standing it under the import history was the same
mistake as Settings in the other direction: a diagnostic nobody needs most of the time occupied a
screenful of a page people visit to import files. It is read on the specific occasion that a sync brought
in less than expected, so it lives behind a button and opens as a report (`AppDialog`, the shape
`ReimbursementsReportDialog` uses). It is deliberately *not* one of the detached minimize-to-nav viewers:
those are for reports kept open while working elsewhere, and this one is opened, read and dismissed with
no state worth carrying across a navigation.

The corollary is about Settings specifically. **Settings is a permanent home for a few things and a
temporary one for a lot** — the configuration surfaces, About, and whatever genuinely describes the
install belong there for good; anything parked there because it was administrative-shaped, or because
nowhere else had a slot yet, is on loan. A diagnostic, a log, or a maintenance action that describes one
subsystem should be read as owing a debt back to that subsystem's own surface, and a new one should not
be added to Settings simply because it is the page with room.

**A recurring app-wide action can live in the navigation pane, as one control with several states — never
as a second control beside a transient one.** The sync affordance is the case. Syncing was reachable only
from the Accounts page's Connections tab, which made the routine operation a detour through a
configuration surface; the pane meanwhile already carried a *stashed-run* pill that appeared only while a
sync was minimized. Adding a permanent "Sync now" next to that pill would have put two sync things in the
nav that could disagree about whether anything was running. So there is one row
(`components/SyncNavItem.jsx`), and it reads its own status: idle it offers to sync and says how current
the data is, running it reports what has arrived, and once the run ends it restores the summary. Three
properties make it work. It is **permanent** — a control that appears and disappears is one nobody learns
to reach for, so it earns attention through its state rather than through its presence, and it hides only
when the action is impossible (no data connections at all). It is **styled as a nav row, not a chip**,
unlike the stashed-report pills beside it, because it belongs to the pane rather than being parked in it.
And it **starts the whole run**, not one provider's — which is why `SyncStatusContext` separates opening a
run (`beginRun`, once for the set) from driving one provider (`driveProvider`): per-provider setup run
twice in a tick races itself, since each call reads a `syncState` ref only as fresh as the last render and
each would conclude the other was not running and replace its roster.

**An app-wide action taken outside the page that owns it needs that page's gates lifted with it.** Sync is
vault-gated, and the gate's dialog was mounted inside the Connections tab — so the prompt could only
suspend an action started on that tab, and would unmount underneath a pending one anywhere else. The gate,
its flags and its dialog now live at App level (`contexts/VaultGateContext.jsx`) beside the sync state,
and the page keeps only what is genuinely its own: the vault *strip* (configuration), the
change-passphrase dialog (nothing waits on it), and the strip's own passkey button (whose refusal is a
page notice rather than an inline dialog error). The flags are **derived from `currentUser` rather than
fetched**, since the session already carries them and a second polled copy could only disagree; staleness
is answered where it surfaces, by the gate's `force` option and each call site's 423 retry, not by
keeping a fresher cache.

**Timestamps are absolute by default, and relative only where the question is staleness.** An absolute
timestamp is true whenever it is drawn and orders itself against its neighbours, which is why it stays the
rule for any timestamp sitting in a list beside other timestamps (the sync log's rows, an import card's
date). The exception is a single standing figure in narrow chrome, where the reader wants "how stale is
this?" rather than "when exactly?" and the pane has no room for `9/5/2026, 07:40 AM` regardless. Two
conditions make the exception safe, and both are required: the absolute value goes on **hover**, so the
exact moment is never actually lost, and the label **re-renders as it ages** (`lib/useRelativeTimestamp.js`),
because the drift a render-time label accumulates on a page left open is the real objection to relative
labels and not a hypothetical one. That hook steps its own interval down with the value's age and stops
entirely once the label has settled into a date, so an idle app is not woken every minute to redraw
"3d ago".

**Configuration and operation are different surfaces, and a routine action must not be reached through a
configuration one.** The connections work is the reference. Everything about a data connection lived on
one tab of the Accounts page — connecting a bank, mapping its accounts, *and* syncing it — while the
Accounts page's other tabs are all configuration. So the routine act of pulling new transactions was a
detour through a setup screen, and the record of what a sync had done was somewhere else again (Settings).
The split now runs along what the user is doing rather than along what the data is:

- **Accounts → Connections keeps configuration**: the vault strip, the provider credential, connect,
  reconnect, disconnect, the account mapping, and the new-connection history depth. Plaid Link in
  particular *cannot* move — its handler closure lives in that component, so navigating away mid-connect
  silently loses the in-flight connection, which is what the modal scrim exists to prevent.
- **Import / Export → Import gains the operations**: one **Sync now** covering every connected provider,
  fetch-more-history, refresh-accounts, remove-synced-transactions, and the sync log (which Accounts →
  Connections also opens in place, since it is read there too) — in a card that
  **shares a row with the file importer**, over the import history both routes land in. They are peers
  rather than one being a subsection of the other, because a sync and a dropped file are the same intent
  and produce the same artifact (an `import_batch` card).

  **One sync control per surface, not one per row.** The first cut gave each provider *and* each
  connection its own button, which at three connections under two providers put five on a page that also
  has one in the navigation pane — and they were not five different actions in any way a user cares
  about. "Bring in everything new" is a single intent and gets a single control. Syncing one connection
  is a different question — *did the thing I just configured work?* — which is why that one survives, on
  the Accounts card where the configuring happens, and nowhere else. The corollary for the card's density:
  sharing a row with the importer means it has to stay short, so each connection is one line (who, how
  stale, anything asking to be acted on, a menu) and the per-account breakdown of a pull lives on the
  import cards below, where those rows actually landed.

Three things make the split hold rather than merely relocate the problem. **The two halves share their
implementation, not just their vocabulary** — the actions are one hook (`lib/useConnectionOperations.js`),
the status rendering one module (`components/connections/ConnectionStatus.jsx`), the derived states one
tested function (`providerConnectionStates`). Two surfaces describing one connection must not be able to
describe it differently, and a confirmation for a destructive action written twice will eventually promise
two different things. **Neither half goes silent about the other**: the configuration card keeps a
compact last-synced line and its own small per-connection sync — because the changes made there (a
mapping, a reconnect) are only really confirmed by data arriving, and the effect of an action belongs
where the action was taken — and its ⋯ menu carries one pointer to the operational half rather than
repeating it. **And what was discovered by one half but fixed by the other becomes a Task**: reconnect
needed, connections failing, and accounts with no destination are raised in `routers/tasks.py`, so the
nav badge finds a user who visits neither page. They are deliberately not dismissible — unlike a backlog
count they do not fall on their own, and hiding one hides a connection that has stopped importing.

**A list can be the card's point and still belong behind an expander.** When the connection cards' height
was first raised, the recorded conclusion was that the accounts list "is the card's useful content, so it
should stay visible rather than move behind an expander." Living with it overturned that: at seven accounts
the list *was* the card, fifteen rows of reference material wrapped around three rows of state, and the
things a user actually returns to the card for — is it working, when did it last run, what still needs a
destination — were buried under it. Both surfaces now collapse it (`Accounts (7)` on the configuration card,
`Connections (3)` on the Import panel) with the actionable counts hoisted onto the summary line, which is
the rule that makes collapsing safe. The general lesson is that "this is the important content" argues for
making it *reachable and summarised*, not for making it permanently occupy the viewport — and that a
density judgement made before anyone has lived with the surface is worth re-testing rather than inheriting.

**A control that speaks for many things reports the one furthest behind.** The nav item's freshness is the
**oldest** `last_synced_at` across every connection, which is the same rule `providerSummary` already
applies to the connections under one provider card, one level down. Taking the newest would let a
connection synced two minutes ago report the whole app as current while another had not synced in a month
— exactly the state a standing freshness indicator exists to reveal. It is also **derived rather than
stored**: a remembered "last pressed" timestamp would be a second answer that can disagree with the first,
since a sync that ran and failed moves it though nothing arrived. A connection that has *never* synced is
kept out of the oldest date and counted separately, so adding one does not replace a readable date with
"never"; the count travels to the tooltip, which also breaks the headline down per provider so a stale
figure can be traced to the connection responsible for it.

### Horizontal sizing of data regions

Two different surfaces respond to a narrowing pane in two different, deliberate ways, and the choice follows from what the region *is*:

- **Wide data tables** (the Transactions ledger, the Categories matching-transactions list) have columns with hard min-widths and **scroll horizontally inside their own clamped viewport** once the pane is narrower than that floor. The table chrome around them (titles, filters, action buttons) should wrap or reflow — only the table body scrolls.

- **Entity/management lists** (the Accounts list) **never grow a horizontal scrollbar** — a scrollbar on a list the user navigates and drags would be worse than letting columns adjust. The Accounts list keeps **one fluid filler column** (the primary label, e.g. account Name, as `minmax(0, 1fr)`) that absorbs all slack, so the table always exactly fits its container. Its other data columns (Type/Owner/Tags) are **user-resizable fixed-pixel columns**: resizing one reflows the fluid Name column rather than widening the table, so resizing can never produce overflow. The fixed drag-handle and delete gutters stay constant. This is the deliberate counterpart to the wide-data-table pattern above: that one scrolls; this one reflows. Widths persist via `useColumnPreference` (keyed `ui.accounts.columns`); because the Accounts row is hand-rendered (drag-to-merge, child indentation, owner pills, inline tag picker) it keeps its own `PillTableHeader` + list rather than adopting `PillGridTable`, sharing one computed grid-template string between the header and every row. Now that the table is the sole content of its own tab (it no longer portions a width with the sparse Owners/Connections panels) it sits at a modestly wider fixed width, giving the fluid Name column more room by default. The truncated label still surfaces its full text via a hover tooltip, so narrowing a column never hides information. Name itself carries no resize grip — a fluid column has no fixed edge to drag (widen it by shrinking the others); making Name directly draggable would require giving it a pixel width and accepting horizontal scroll when over-widened (the wide-data-table model).

**A width measured from one surface and mirrored onto another must ignore zero.** The Accounts page measures its account-table panel with a `ResizeObserver` and passes that pixel width to the cards on the *other* tabs, so the page reads as one anchored column. The observed element exists only on the Accounts tab, so switching tabs unmounts it — and the observer reports a final size of **0** on the way out. Adopted literally, that becomes `width: 0px` on every card of the tab being switched *to*, which collapses each one to its borders while its contents spill out at min-content width. The rule: a zero from a `ResizeObserver` usually means the element is leaving, not that it measured nothing, and the last real measurement should stand until a real one replaces it.

The symptom is worth recognising because it impersonates a rendering bug convincingly. It survives first paint and appears only after a tab switch, a window resize does not clear it (nothing re-measures an unmounted element), and leaving the page and returning does clear it (the remount restores the default). Verified in both WebKit and Chromium — the engines behave identically, so a report that it happens in one browser and not another is a difference in *sequence*, not in engine.

When a flex/grid column *hosts* a horizontally-scrolling data table, that hosting column must clamp its own width or the table's min-width escapes it: use a `minmax(0, 1fr)` track (a bare `1fr` carries a `min-content` floor and will push the table past the viewport, where an ancestor `overflow: hidden` clips it with no scrollbar) and `min-width: 0` on the cell/flex item (whose default `min-width: auto` causes the same blowout). Only once the host is clamped does the table's own `overflow: auto` engage and produce the scrollbar.

**A path shown in the navigation pane elides from the *start*, in CSS.** The pane is user-resizable, so any truncation computed in JavaScript is correct at exactly one width; `direction: rtl` on a nowrap ellipsis moves the cut to the overflowing end, which keeps the tail — the leaf directory and the file name, the half that differs between two installations — while the shared home prefix is what goes. Four details make it work, and the first three are each enough to defeat it on their own — the failure looks identical every time, a path clipped mid-character by an ancestor's `overflow: hidden` with no ellipsis in sight, because the text never had a narrower box to elide against. The pane needs `min-width: 0` (a flex item's automatic minimum is content-based, so one long unbreakable string widens the pane past the width the user dragged it to, or refuses to be dragged narrower). A `Tooltip` around it needs `triggerStyle={{ display: 'block', minWidth: 0 }}`, since its default wrapper is `inline-flex` and shrink-wraps the text, leaving any `width: 100%` inside it measuring against a box already as wide as the path. The truncating styles belong on a block `<span>` **inside** a `<button>`, never on the button, whose contents sit in an anonymous box that sizes to them. And the value carries a leading left-to-right mark, or the direction switch reorders its own leading `~/` to the far end. The full value goes in the hover tooltip, and clicking copies the *absolute* path rather than the shortened one — `~` reads well and pastes badly. The font stays the size of the chrome around it: shrinking text to fit trades one unreadable thing for another and desynchronises it from the badge it sits with.

## Tree views

Tree views should use the same visual grammar wherever they appear.

- Each child level should begin under the first letter of the label above it.

- The hierarchy should read primarily through label alignment rather than heavy guide lines or decorative chrome.

- Controls that belong to a row may sit to the left of that label start, but the text alignment should define the structure of the tree.

- Expand/collapse controls should stay close to the label they affect.

- On the Accounts page, merged child accounts should read as a lightweight second level under the parent account rather than as a second flat table with repeated owner/type columns.

- Protected system groups, such as `Unassigned` on the Categories page, should behave like filtered fallback buckets rather than normal editable groups. They should stay at the bottom of their section. The transaction-presence filter applies only to **still-pending imported labels** (`import_pending`): an empty pending label is hidden as triage noise. A **settled system category** under `Unassigned` (`import_pending = 0` — recovered, user-created, or organized-then-emptied) is a real category the user chose to keep and surfaces regardless of transaction count; otherwise recovering an empty category would look like it vanished.

- Protected system rows should read differently from ordinary editable taxonomy rows. Use italic labels for immutable system buckets such as `Unassigned` and the synthetic `Uncategorized` child it can surface when uncategorized transactions exist.
- When uncategorized transactions need different debit/credit presentation, keep that split synthetic. Expense-side uncategorized rows may stay under `Unassigned`, while uncategorized credits may surface as a separate income-side system bucket such as `Other Income` without creating a real stored category.

### What a protected row may have done to it is a table, not a flag

"Protected" is not one property. The Categories tree gates six separate things — rename, delete, drag
out, accept a dropped leaf, hold tags, and change `exclude_from_totals` — and for a long time answered
all six from a single `isSystemCategory` predicate. That held only while every protected row answered
them the same way, and stopped the moment a third kind appeared: the reimbursable holding group may be
renamed and tagged and accepts dropped leaves, yet must never be deleted, moved, or counted. A single
boolean would have to be wrong in one direction or the other.

So capability lives in one table keyed by *kind* (`lib/categoryCapabilities.js`), and the JSX asks for
the capability it actually needs rather than for an identity. Two things this buys, both of which had
already gone wrong once:

- **Adding a protected kind is filling in a row**, not finding six predicates scattered through a page.
  The gap that motivated it was backend guards landing while the UI still rendered live controls for
  them — a checkbox that errored on click.
- **The kinds stay distinguishable.** `synthetic` rows are not database records at all, so nothing can
  be done to them for want of anything to act on; `unassigned` is a real row deliberately held still.
  Those are different reasons, and folding them together is what made the third kind hard to see.

Identity predicates (*which* group is `Unassigned`, is this row synthetic) stay as they are — they
answer real questions. What moved is only the use of identity as a stand-in for permission.

A capability that is withheld should still **render, disabled, saying why** where the control is the
only thing on screen explaining the behaviour — the reimbursable group's exclusion checkbox is checked
and greyed with "always, for this group" beside it, because hiding it would leave nothing to account for
why that group's money never reaches a total. Where the capability simply does not exist and nothing
needs explaining, remove the affordance instead: `Unassigned` and the reimbursable group both hide
Delete rather than offering one that refuses.

This governs **rendering only**. The backend refuses the same operations independently, since that is
what holds across every entry point; the table exists so the screen agrees with it.

**A control that is disabled by an unmet condition says which one, on hover.** Greying a control states
that something is wrong without saying what, and the user is left to find the unmet condition by
elimination — worst where the cause is invisible on screen, as when a confirm field one character short
greys the button beside two fields that both look filled in. The reason belongs on the shared `Tooltip`
rather than a native `title`: setting the DOM `disabled` attribute is what makes a control genuinely
inert, pointer events included, so its own `title` never opens — the hint has to hang off a wrapper
around it. Derive the reason and the disabling condition from **one expression**, so a control can never
be greyed for a reason the screen does not give; where several conditions are unmet at once, name the one
the user has to fix first, or the hint sends them to the wrong field. Note this is a different string
from the `title` an *enabled* button carries, which says what the action does — the two are not
interchangeable and a control may want both.

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

**A mode badge marks the exceptional state, never the expected one.** A provider's environment badge shows
for Sandbox and renders nothing for Production, because only one of the two answers a question the user
would otherwise be left with — sandbox is the state that makes a working app look broken, with the real
accounts absent and every balance invented, and nothing else on the card would say why. Badging the normal
case instead costs twice: it spends the alarm colour this UI reserves for real failures on the one
configuration that is correct, so the badge reads as an error and the colour stops meaning anything. The
same reasoning already drops the badge for a source with no test mode at all — an invented or empty one
would imply a distinction it does not have — which makes the general rule visible: the question is not
"what mode is this in" but "is there something here the user needs told".

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

- **Removing an account asks one question — where its transactions end up — and is prevented rather than reversed.** The row's ⋯ menu carries *Remove account…* last, separated and `danger`, and it opens `AccountRemovalDialog` (`components/accounts/`) with the same two answers for every row: move the transactions to another account (the parent preselected for a group member, *Create new account…* in the same picker), or delete them with the account. An account holding no transactions gets a plain confirmation instead of a question about nothing.

  **There is no undo, and the extra press is what replaces one.** Three designs were weighed. Reassigning immediately while keeping the account recoverable is not available at all: once the rows have moved nothing distinguishes them from the ones already on the target, so restoring would need a per-row record of what moved — the unbounded accumulation `scale-and-limits.md` forbids. Deferring the move until an **account trash** is emptied does work, and was built and then retired, because it turns the dialog's answer into a promise with no delivery date: nothing outside the accounts listing filters `account.trashed_at`, so the rows go on being reported under the old account until someone empties the trash, which may be never. That is invisible for a merged child only because those rows resolve to the parent either way — the one case that worked, and the reason it looked general. The economics point the same way: a trash earns its keep where the action is routine and the undo is one column, and this one is rare and spans eight tables, which is the shape the vault reset already answers with a typed phrase rather than an undo. So the × became a ⋯ menu, and the one-press accident the trash existed to absorb stopped happening.

  Three details are deliberate. The target is **preselected** to the parent for a group member but the dialog still opens, because "delete them instead" has to stay reachable — and because the preselected answer puts the rows exactly where they already displayed, a mis-click on the default does nothing visible. The picker is the import mapping's, not a new one: `selectableAccountOptions` + `getAccountOptionLabel` for the options and `ImportNewAccountFields` for the new account, so "which account?" behaves here as it does on the two mapping grids; creating the stand-in is a separate call before the removal, exactly as the import path does it, which is why the endpoint needs no create-and-reassign mode. And a **group root still refuses** until its children are removed or ungrouped (`data-model.md`), which is why the menu item disables itself with that reason rather than opening a dialog that would fail.

  What all of this replaced is the reason it reads this way: a root's inline confirm hard-deleted its transactions behind a count, and a child's trash confirm folded them into the parent. Neither said where the history went.

- **An account row's actions live in its ⋯ menu; the list's live in its right-click menu.** The row menu carries *Rename…*, *Edit tags…*, then *Remove account…*; the right-click menu over the list carries Collapse all / Expand all and nothing row-specific. Splitting them by scope is what retired a second menu implementation — the list menu is hand-rolled markup, so every row action added to it was another copy of `ActionMenu`'s chrome to keep in step, and the *actions* were never the drift risk.

  **The first two are duplicate routes on purpose, and that is not the redundancy it looks like.** Both are reachable inline — the name is click-to-edit, the tag cell opens its own picker — but each announces itself only through a hover `title`, which tells a touch user and a keyboard user nothing; a menu item is the first affordance that says the row is editable without the user already suspecting it. What is duplicated is the way in, never the action: *Rename…* drives the row's existing `useTransientTextEdit` editor rather than opening one of its own, through a **counter** rather than a flag (as the import picker's new-account field does it) so choosing it twice re-enters the editor instead of being swallowed as "no change". Two routes to one action are fine; two implementations of one action are how a thing comes to behave differently depending on how it was reached.

  **Parity between the two menus was never achievable anyway**, which is why *Edit tags…* moved rather than being listed twice: the right-click menu was bound to root rows only, so a merged child could not reach it at all. With nothing row-specific left in it, the rows no longer intercept the event, and a right-click anywhere in the list — child rows included — now reaches the list menu.

Inline row creation should usually happen inside the existing list, not in a detached panel above it.

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

The **amount editor** in the same panel (`TransactionAmountEditor.jsx`) is the second kind rather than
the first, despite looking like a single field: a magnitude and a direction control together decide one
value, so a click-away would save a figure whose direction the user had not finished choosing. It
therefore carries its own Save/Cancel, and Enter is gated on the same expression that disables Save so
the key can never accept what the button refuses. It is offered on **hand-entered rows only**, and on
one that is split or part of a reimbursement it renders the marker greyed with the reason on a
`Tooltip` — an imported row gets no marker and no hint at all. That three-way answer comes from one
expression (`lib/amountEdit.js`) so the hover and the greying cannot drift apart, and the backend
refuses the same three cases independently. See [`data-model.md`](data-model.md) → *Transactions*.

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
- **`SearchInput`** applies the same contract to a search box, where clearing is the local edit: Escape
  in a field holding text empties it and goes no further, and in an empty field passes through, so the
  page or panel still backs out on it. Its in-field × is the pointer path to the same clear.

Never add an app-wide/global `Esc` listener for this — each editor or layer owns its own Escape, gated
on being open/active, so legitimate behaviors elsewhere are never disturbed.

## Transaction rows

Transaction tables should share the same row-level metadata treatment.

- Notes and transaction tags belong in a shared marker strip near the amount column rather than being rendered differently on each page.

- Tags should use one fixed shared glyph, with user-selected color carrying the visual identity.

- Hovering a tag marker should reveal its label, and clicking row markers should use the shared inline popover patterns instead of page-local dialogs.

- **One registry decides what "the source said" means, everywhere it is shown.** The origin hover card,
  the transaction detail's Origin block and the rule editor's read-only source panel all render from
  `lib/importSourceFields.js`, which resolves each field from either a first-class `txn` column or a path
  into `import_evidence_json` and tags it with a scope (`name` / `text` / `meta`) saying which surfaces
  show it. Consuming the registry rather than parsing evidence per surface is what keeps three views of
  one row agreeing. It is deliberately **dynamic**: the evidence's `extra_text_fields` bag expands into
  rows labelled with the source file's own header, so a column only one source publishes appears without
  being hardcoded, and a resolver that finds nothing drops its row instead of rendering a blank. Present
  on some rows and absent on others is the intended behavior given how unlike each other sources are.

- **The origin hover card carries the copy affordance where it is showing a real transaction** (`copyable` on `MerchantOriginHoverCard`). The card is `interactive`, so its text was always selectable and `Ctrl+C` always worked — but nothing said so, which is indistinguishable from it not working. The button is the same shared `CopyTransactionsButton` the transaction editor uses, producing the same record through the same formatter. It is **opt-in** rather than automatic for two reasons: the card is also fed *partial* origin objects (the duplicate report's hard-rejected rows never became transactions), where a copy would hand back a half-record; and the button reads `useTransactionShare`, which throws where that provider is not mounted.

- **Needs-review marker.** A row still flagged `needs_review` (freshly imported/synced, not yet looked over) carries a quiet amber `R` in the same strip with a tooltip. It is a **distinct glyph**, not a colored dot, precisely so it doesn't read as another tag (tags use one fixed glyph with color carrying identity). Its color is the themeable `--review-marker-color` variable (per-theme so it stays legible on light surfaces); a future Settings → Appearance swatch will override it per user, which is why it is a variable from the start rather than a hardcoded value. **Clicking it marks the row reviewed** wherever the list wires the shared row actions (the ledger and every `TransactionListTable` with a row menu; not in bulk-select mode, and not in a list with no row menu, where it stays informational). It goes through the same `markReviewed` as the row menu's "Mark reviewed", and both raise a **"Marked reviewed · Undo"** toast that sets the flag back — reviewing is usually settled on the spot, but a charge sometimes needs checking elsewhere first. Only the latest press is undoable; an older one is re-flagged through bulk edit's *Set review status*. Like every row edit it lingers: a list filtered to Needs review does not drop or reorder the row until Refresh, which is what keeps clicking down a list safe. The other ways to clear it are a manual category edit, bulk Mark reviewed, and the per-batch "Mark all reviewed". See the `needs_review` field in `data-model.md`.

- **Recurring marker.** A row that belongs to a recurring series (its `recurring_series_id` is set) carries a quiet `↻` glyph in the same strip with a "Part of a recurring series" tooltip. Like the `R` marker it is a distinct glyph (not a tag) and always shown when the row carries the flag — it appears wherever the list feed supplies `recurring_series_id` (the Transactions ledger and the recurring drill-down, both backed by the `/transactions` endpoint); detail lists fed by summary endpoints that don't select the column simply omit it. It anticipates the planned "mark as recurring" row action and edit-screen checkbox, which will write that membership.

- **A row with no name shows what kind of transaction it is.** A wallet's funding deposit or withdrawal genuinely has no counterparty, and a bare "—" says nothing about what it was, so a nameless row shows the source's captured `Type` ("General Credit Card Withdrawal") in muted italics where the name would be (`NamelessMerchant`, in the merchant cell and the detail panel's header), falling back to "—" when none was captured. It is **display only**: the name stays empty — namelessness is what marks a funding leg (`data-model.md` → *Transaction links*), and it is what a CSV row of the same payment carries, which duplicate detection compares against — and the rename field opens empty (`getTxnName`) rather than pre-filled with the placeholder.

- **Multi-payment purchase marker.** A row that is one payment of a purchase spanning several transactions (`purchase` on the list feed) carries a `🔗` in the same strip, whose tooltip says which payment of how many, what the purchase is called, and the linked total against the expected one (`purchaseMarkerTooltip`, `lib/purchaseLinks.js`). **It opens the purchase**, like the note glyph, the tag chips and the document marker beside it open what they stand for — the shared `PurchaseEditorDialog`, which is also what the detail panel's purchase summary opens, so a payment linked by mistake is repaired from wherever it was noticed rather than only from the panel. It was first built inert on the reasoning that the row's pencil already reached an editor in the detail panel; **do not re-impose that.** It is the third time this repo has withheld a capability on the grounds that another route existed (the document marker left as a counter, the `doc:` search prefix made mandatory), and the third time the answer was that the marker should do the thing. Like the other strip markers it appears wherever the list feed supplies the field (the Transactions ledger); lists fed by summary endpoints that don't project it simply omit it, and nothing else changes about the row — grouping payments never alters a category, an amount, or a total. See `data-model.md` → *Multi-payment purchases*.

- **The same `🔗` stands for a refund pairing**, not a marker of its own — the strip is crowded, and both say one thing: this row has partners. A refund and the payment it returns (`refund_link` on the list feed; `data-model.md` → *Refunds*) each carry it, the hover naming the other side ("Refund of Harbor Cycle Works · Apr 22, 2026" / "Refunded $54.95 · Apr 24, 2026"). A pairing has nothing to edit, so the click **opens the transaction on the other side** in the detail panel, fetching it first since the row carries only enough to name it; where the host has no detail panel to open (no `onOpenDetail`) the glyph stays informational. A row that is both a purchase payment and one side of a pairing shows one `🔗`, hovering both facts, and opens the purchase — the one that can be edited.

- **Excluded-from-totals marker.** A row whose category (or its parent group) is `exclude_from_totals` — transfers, card payments — can carry a quiet `⊘` marker in that same strip plus a slightly dimmed amount, with a tooltip explaining it isn't counted in spending totals. It is driven by the list endpoint's per-row `excluded_from_totals` flag (`COALESCE(parent-group, leaf, 0)`) and is **opt-in per surface** (`markExcludedFromTotals` on `TransactionListTable`): it shows only where a list sits beside a total that omits those rows and would otherwise look wrong — the account-activity panel (`AccountDetail`), whose cash-flow list shows *all* the account's movement while its total and chart exclude transfers. Surfaces that list rows without any total (the Transactions and Categories ledgers) leave it off, and surfaces whose list is already view-filtered to spending/income (the Dashboard drills, `PeriodDetail`) never include an excluded row to mark. The deliberate choice is to keep the excluded rows visible and *explained* rather than dropping them — they are real transactions — or silently letting the count/total disagree with the visible rows.

- **Split rows read as "Split (N)", not as a category, and hovering shows the allocation.** A transaction whose amount is allocated across several categories has no single category to show, so the shared `CategoryCell` renders a quiet `Split (N)` chip in place of the category badge and routes a click to the split editor rather than the picker. Hovering the chip lists each part — category name and **signed** amount — through the same `RowTooltip` dwell the origin cards use. The amounts are the point of the hover rather than a nicety: in a category-scoped list the row shows only the *part* that matched, so this is where "why does this row say $60 when the purchase was $100?" is answered. The parts ride in the list payload (`split_parts`) rather than being fetched per hover, which would put a loading state inside a tooltip for a handful of rows. The tooltip deliberately does **not** describe the click — `cursor: pointer` carries that, and a hover is worth more spent on the row's content than on its gesture. The click target changes deliberately: the backend refuses a single-category assignment on a split row (it would orphan the allocations), and a control that opens and then fails is worse than one that leads where the user actually needs to go. A host that cannot open the editor — a display-only list — renders the chip read-only rather than offering the picker. The way *in* for a transaction that is not split yet is a `Split…` button beside the category in the transaction detail panel.

  **One editor per surface, two ways in.** The split editor is owned by `useTransactionRowActions`, not by each host: the row menu opens it, and a host hands the same `openSplitFromMenu` to its `CategoryCell` so clicking the marker lands in the identical dialog. Every way in goes through `openSplitFromMenu`, which is also where an expanded allocation is restored to the whole transaction (`wholeTransactionRow`) — the editor reconciles the parts against `txn.amount`, and a part row's amount is one allocation's, so without that it would open on a $10 transaction whose parts sum to $250 and refuse every save. The menu item is named for the row's resulting state (`Split…` on an ordinary row, `Edit split…` on one already split) rather than for the operation, and it is **withheld entirely** where the host has no category list to give the editor's pickers — an empty picker is not a usable editor, and offering a dead entry is worse than offering none.

  **In a category-scoped list a split row shows the part, not the purchase — and the cell names the part's own category.** The list endpoint expands splits whenever a category-shaped facet scopes it, so a drill-down into one category shows that transaction at its **allocation** amount, which is what makes the panel's visible rows sum to the total in its header. On those rows the cell renders that allocation's category as an ordinary badge with a quiet `◧` marker beside it, *not* the `Split (N)` chip: the chip claims the row is the whole purchase, and its hover would answer a question about a $10 row with the other part's $240. Badge and marker are **one control**, carrying "One of N parts of $250.00" on hover — the transaction total, summed from the allocations, since an expanded row does not carry it — above the same `SplitPartsHoverCard` the ledger uses. Clicking anywhere in it opens the split editor, which is the same destination the unexpanded row's chip has: a split's categories are edited in one place whether the row is expanded or not, and the editor shows the sibling allocation while the user decides. Repointing one allocation *in place* would be the lighter gesture and is the better end state — what stands in the way is not the backend but the reconcile identity: every surface merges an edited row by transaction id, which is right for a note or a tag and wrong here, since two allocations sharing a category would both take the new one. What tells the two cases apart is `split_part_id`, never `is_split` — see `lib/splitRows.js`, and *Transaction splits* in [`data-model.md`](data-model.md).

  **The detail panel opened from such a row describes the transaction, and fetches it to do so.** The panel reads its header off the row object it is handed but fetches Documents, Purchase and Reimbursement *by transaction id*, so an unresolved part row makes it describe a part in one half and the purchase in the other — the symptom was a $10 header above a line reporting a $250 receivable. It therefore re-fetches by id when `split_part_id` is set, and only then: every ordinary row still opens straight off the object, with no request and no loading state. Fetching rather than reconstructing from the row is deliberate — the transaction's own category is genuinely not in the expanded payload, and a field added to the seam's substitution list later would silently reintroduce the bug in any recovery written at the call site.

  Expect the dissonance that remains and leave it: the panel shows the *whole* transaction's amount, which is not the figure the row beside it shows, because that is what the transaction is.

  **A windowed transaction list keys its rows with `transactionRowKey`, not `txn.id`.** Expanded, the id is not unique — two allocations in one category arrive as two rows with the same id, and identical amounts leave nothing else to separate them — so the virtualizer, which caches measurements by key, folds the pair into one item. The helper appends the part id where there is one. The same rule applies to any list rendering allocations: `SplitPartsHoverCard` keys its rows by position rather than by `category_id` for exactly this reason.

- **The purchase editor is one dialog with two ways in**, the same rule the split editor follows above: the ledger row's `🔗` marker opens `PurchaseEditorDialog`, and so does the detail panel's purchase summary. It is a dialog rather than a section inlined in the panel *because* the row is one of its hosts — a row has nowhere to inline an editor, and building the panel's copy first and the row's second is exactly the drift this repo keeps finding in its own history. Two consequences worth knowing. It **portals to the body**: `AppDialog` renders where it is mounted, and a `position: fixed` overlay opened from inside a table stacks against whatever ancestor established a containing block — `DocumentViewerDialog` carries the symptom that taught this (opened from a row it surfaced under the page header with its title bar cut off). And the dialog is **owned by `TransactionMarkersCell` directly**, not threaded down from `useTransactionRowActions` the way the split editor is: the split editor needs `categories` from the host and appears in the row menu too, whereas this one needs nothing but somewhere to report its result, so a controller in between would be plumbing with no decision in it. The result travels back as `onUpdatePurchase(txnId, summary)` beside the existing `onUpdateNote` / `onUpdateTags`, so the marker follows an ungroup without the page refetching.

- **A per-transaction panel section that has nothing to say renders nothing.** `PurchasePanel` (the multi-payment purchase a transaction is part of) is absent from the detail panel for every transaction that is not grouped, which is nearly all of them. The alternative — an always-present empty section explaining the feature — would spend permanent vertical space on every row in the ledger to advertise something that applies to a handful, and the place someone realizes two rows belong together is the ledger, where the bulk action lives, not this panel. **This is deliberately not the `DocumentsPanel` rule**, and the difference is what each section is *for*: attaching a receipt is an action offered on any transaction, so its drop target must be there before there is anything to show; a purchase is a relationship that either exists or does not, and an empty one offers nothing to do. When adding a section here, ask which of those two it is rather than matching whichever neighbour is closest.

- **Grouping payments as one purchase is an ids-only bulk action.** "Link as one purchase" sits in the Transactions ledger's `BulkEditChrome` `actions` slot and is withheld in *all-matching* selection mode. Linking is a claim about specific transactions, and "all matching" reaches past the loaded pages by design — nobody means "every row this filter returns is one purchase" — so the action is not offered rather than silently re-resolving a set the dialog cannot show. The dialog (`LinkPurchaseDialog`) then **lists every payment with a running total** instead of reporting a count, because a bulk selection is easy to get wrong by one row and the total is what makes the extra one visible before saving rather than after. Which of its two operations runs is decided from the rows rather than asked: the list feed already carries each row's purchase, so a selection touching one existing purchase *adds* to it (finding a third instalment later is how a purchase grows), one touching none *creates*, and one spanning two is refused with the reason — merging two purchases is a decision nobody asked for. That decision lives in `planPurchaseLink` (`lib/purchaseLinks.js`), shared with anything else that later wants to offer the same action.

- Note editing goes through one shared editor (`components/NoteEditor.jsx`) wherever a transaction note is edited — the row's note popover and the transaction detail panel both render it — so the interaction never diverges by surface: a multi-line field where ⌘/Ctrl+Enter saves (plain Enter inserts a newline), Escape cancels the edit, Save stays dimmed until there is an unsaved change, and a Remove action clears an existing note. Persistence (the API write and reconciling the host's row) stays with the host via the editor's `onSave`; any new surface that edits a note should reuse this editor rather than re-implementing the field and its shortcuts.

### A surface that loads when it opens paints once, fully formed

A dialog or panel that fetches on open must not appear on a `Loading…` block and then swap in content
of a different height — it jumps under the cursor, twice where the content grows in two stages (the
split editor sized itself to the order's item count *and* then added its pre-fill strip). The standing
answer is to render nothing until there is something worth showing, bounded by `useBusyIndicator` so a
stalled load still surfaces eventually — a control that appears to do nothing forever is the worse
failure. Below the bound nothing has painted yet, so there is no flicker to have.

**Use `PAINT_GATE_DELAY_MS`, not `BUSY_INDICATOR_DELAY_MS`, for that bound.** They answer different
questions and conflating them put the flicker straight back. The short one asks "has this lasted long
enough to be worth mentioning"; a paint gate asks "has this gone wrong enough that a half-formed
surface beats nothing", and it is measured against **observed** latency rather than server time. A
local request answering in 22ms routinely takes several hundred milliseconds to *land* once it queues
behind the page's other requests (browsers cap connections per host), so the short threshold fired on
nearly every open. The loading state each surface falls back to should also carry roughly the
footprint of a small finished one, so the rare stalled case grows a little instead of unfolding from a
single line.

The same rule covers a control whose **label** resolves asynchronously — the transaction row menu holds
its paint until it knows whether it is offering *Create rule* or *Open matching rule*, since those are
different actions and a menu that silently becomes the other one is asserting something untrue. Where
the async value describes a *specific row*, gate on that row's identity and not merely on a loading
flag: the stored answer still describes the previously opened row for one render.

Wired on: `SplitEditorDialog`, `RuleActionModal`, `RuleSuggestionToast`, and the row menu
(`useTransactionRowActions`). `usePanelReveal` is the floating-panel form of the same idea, holding a
detail panel invisible until its geometry settles.

### An edited transaction lingers where it was found

Editing a transaction must never make it vanish from under the user's cursor. When a filtered or scoped list shows a row and an edit changes the row so it no longer matches that scope — categorizing while the ledger is filtered to Uncategorized, recategorizing a row out of the category the Categories panel is scoped to, etc. — the row is **patched in place and left visible**, restyled to show the new value, not removed. The reason is correction ergonomics: a mis-tap stays correctable, and the user can keep working the same row (add a tag, a note) before moving on. The list is reconciled to its filter only when the user asks, via the **Refresh** affordance the surface carries (`↻ Refresh`), which re-queries and drops the rows that no longer match.

**Every surface that lingers carries the Refresh, including the floating panels.** It is the second half of the model, not a nicety: without it a row edited out of its scope has no way off the screen at all, and the figures a panel header reads from the server sit behind the ledger with nothing the user can do about it. The panels went without one for a while on the reasoning that closing and reopening re-queries — which is true, and is not the same affordance, since it also discards the drill, the sort and the scroll position. It is wired once in the shared list toolbar (`TransactionListToolbar`'s `onRefresh`/`refreshing`, fed by `usePagedTransactions().reload`/`.reloading`), so a host turns it on by passing the pair: `AccountDetail`, `CategoryDetail`, `PeriodDetail`, `TagDetail`, the payee `TransactionDetail`, and the dashboard's category drill. The dashboard's group drill lays its toolbar out inline with the list title rather than using the shared one and renders the same `RefreshButton` directly. `reload` re-runs the first-page fetch for the query already on screen, and reports through its own `reloading` flag rather than `loading` — the hosts render a spinner *in place of* the table while `loading`, so reusing it would replace the rows the user is looking at with a spinner and lose their place.

This is the single principle behind several specific behaviors documented below and elsewhere: the bulk-edit in-place reconcile, the rule-apply reconcile (`reconcileRowsAfterRuleApply`), the per-row inline category edit, and clicking a row's needs-review marker all keep edited rows on screen and defer pruning to Refresh. A surface that lets the user edit rows inside a scope that the edit can fall out of should follow the same model — linger plus an explicit Refresh — rather than auto-pruning. (The one deliberate non-linger case is trashing a row, which drops immediately, and applying a *rule* to existing rows, which sweeps immediately because undoing it is heavier — everywhere but the Generate Rules review, where that apply is an undoable review action (`data-model.md` → the review's actions).)

**An in-place patch may only assert what the client actually knows.** A category edit is the cautionary case: the patch could set the category from the picker, but a row's **tags** are inherited from that category and its group, and which tags those are is resolved server-side (account scope and per-row blocks are in it too). Patching the category while leaving the tags alone left the row showing the *previous* category's inherited tag, and nothing on the page refetches to correct it — the staleness was only visible if the user opened the tag picker, whose own write does answer with the resolved set. So the category write answers with the tags too, and `applyCategoryChange` (`lib/txnMutations.js`) is the seam every surface goes through: it applies the optimistic patch, then re-applies it with the server's tags when the write lands. Both patches carry the category, so a caller that merges only one still shows the right one. **Bulk is the exception that proves the shape** — one response cannot carry per-row tags, so a bulk `set_category` refetches the loaded rows it touched by id instead (and only that action: the others patch exactly, and a refetch would cost a request for nothing).

**A write can move rows the surface did not touch, and says which.** A refund paired with the payment it returns follows that payment's category (`data-model.md` → *Refunds*), so recategorizing the payment moves the refund too — usually the row right beside it. The single-row and bulk category writes answer with `followed_ids`, and both paths refetch those rows by id: `applyCategoryChange` hands each fresh row to the surface's `applyPatch(patch, id)` — which is why that callback takes the row id rather than closing over the edited one — and bulk adds them to the rows it already refetches. A surface not showing a followed row matches nothing and is unaffected.

**What protects the linger is the load guard, and it has to count calls rather than queries.** A patched row survives only until the next list response overwrites it, so a surface that re-queries needs to drop every response but the newest. Keying that on the *query* — a hash of the resolved filter params — answers "did the filters change while this was in flight", and is blind to the case where they did not: two loads for the same query produce the same key, both pass the check, and whichever lands last wins by arrival order rather than recency. Overlapping loads for one query are ordinary (StrictMode runs the mount effect twice in dev; a sync callback, a Refresh click and a bulk reload all re-load with the filters unchanged), and against a ledger being written to at the same time the two answers differ — so the older one lands on top and the patch, or the row, disappears. The guard is therefore a counter incremented per call and compared after the await (`pages/Transactions.jsx` → `loadSeqRef`); it cannot collide, and it needs no knowledge of which facets exist.

### Per-row editing is shared by every transaction list

Every list of transactions should offer the **same** per-row editing affordances, so the user never has to learn which surface lets them do what. These all live in the shared cells (`components/TransactionRow.jsx`) and are wired once by the shared `TransactionListTable`; a host turns them on by passing the matching callback rather than re-implementing the interaction:

- **Merchant** — click-to-rename in place (commit-on-blur, the default inline-edit behavior) plus a `↗` that opens the **merchant activity report**. Always on for rename; the `↗` appears when the host passes `onTransactionOpenDetail` and `showMerchantReport` isn't turned off (it's off on a list already scoped to one merchant, where the `↗` would be self-referential — `TransactionDetail`'s own payee activity list).
- **Category** — click-to-edit through the shared `CategoryPicker` (`onCategorySave`) plus a `↗` to the category's spending history (`onCategoryOpenDetail`).
- **Amount strip** — the note and tag markers edit in place, and a trailing **pencil** opens the full transaction editor (the same `onTransactionOpenDetail`, but unmarked). The inline note/tag popovers portal to `<body>` (`RowPopoverPortal` in `TransactionRow.jsx`), positioned `fixed` against their anchor: transaction rows carry `content-visibility: auto` (paint containment), which makes each row its own stacking context, so a popover left in normal flow gets trapped behind the rows that follow it. Any new in-row popover must portal out the same way rather than relying on `position: absolute` + `z-index`.
- **Right-click menu** — the `ContextMenu` (Edit transaction · Create rule / Open matching rule · Split… / Edit split… · Add/Edit note · Tags… · Send to trash). **It waits for the rule lookup before painting.** Which of *Create rule* / *Open matching rule* applies is only known after an async check, and a menu that opens on one and rewrites itself into the other is asserting something untrue — usually too briefly to read, which leaves a menu that cannot be trusted and no visible reason why. Holding the paint costs nothing at that speed, because nothing is on screen yet to flicker. The readiness test is keyed on the **transaction id**, not just a loading flag: the stored verdict still describes the previously opened row for one render after a right-click. `useBusyIndicator` supplies the escape hatch on the app's usual ~150ms threshold — past that the menu opens anyway showing "Loading rule…", since an unresponsive right-click is the worse defect and a label the user has had time to read is allowed to change and its editors are one shared controller, `lib/useTransactionRowActions.jsx` (the `useTransactionRowActions` hook + its `TransactionRowActionsChrome` companion, mirroring `useBulkTransactionEditing`/`BulkEditChrome`). A host attaches the hook's `onContextMenu` to its rows and renders the chrome once; the host stays the source of truth for its rows, passing `onOpenDetail` (Edit transaction), `reconcileRow` (patch after a note/tag edit), and `removeRow` (drop a trashed row, adjusting any total/child panel). "Create rule / Open matching rule" routes through the shared `RuleActionModal` (`components/RuleActionModal.jsx`) after an async match lookup, so the menu offers the right verb. `TransactionListTable` wires this controller for all the report/detail lists (gated on `onTransactionOpenDetail` and off in bulk-select mode); the **Transactions ledger renders its own rows** — because it carries page-specific shell behavior the shared table deliberately doesn't (server-side pagination/sort, the search box, the Category↔Source column swap, the account `↗`, clipboard copy) — but it consumes the **same** `useTransactionRowActions` controller, so the row menu has a single implementation across both.

The deliberate stance is **completeness over context-minimalism**: where an affordance *can* exist it should, so the only reason one is absent is that the context genuinely can't support it — e.g. a `CategoryDetail`'s own list omits the category `↗` because every row already shares that panel's category, and the Dashboard category-drill omits it because the dashboard navigates categories by pie-drill rather than a category panel. A floating detail panel that gains row editing hosts the opened editor/report as a **child panel** (the `AccountDetail` → payee `TransactionDetail` pattern), so edits reconcile back into the parent list and the child closes with its parent.

**`TransactionDetail` is two surfaces in one, chosen by the trigger, not two components.** Its top is a single-transaction **editor** (category/tags/notes/origin for the clicked row); its bottom is the **merchant activity report** (payee trend + a month-scoped, fully editable transaction list with bulk edit). The **pencil / "Edit transaction"** opens it whole; the **merchant `↗`** opens it as the report by suppressing the editor card. The trigger conveys this by tagging the open payload (`_merchantReport: true`, set in `MerchantCell`) the same way the duplicate report carries `batch._dateFilter` — so no host plumbs an extra prop, and `openDetailPanel`/`setPayeeDetail` payload-replacement flips an open panel between the two modes. This is the deliberate alternative to a separate `MerchantDetail`: it would have been a near-verbatim clone of `CategoryDetail`/`AccountDetail` differing only in scope, so the merchant report reuses the payee machinery that already lives in `TransactionDetail`. (If a third report axis ever made the clone pressure real, the right move is extracting one `ScopedActivityReport` the three compose — not three near-duplicates.) The report's own activity list runs the full shared row actions and bulk edit, but turns off the merchant `↗` (self-referential here) and the category `↗` (a merchant report stays on the merchant axis — and it would also form a `CategoryDetail`↔`TransactionDetail` import cycle).

### Bulk select and edit

A "Bulk Edit" toggle puts a transaction table into bulk mode: a leading checkbox column appears with a select-all checkbox in its header, and a bulk action bar offers Edit… (a `BulkEditPanel` — category, tag add/remove, notes, merchant, date) and Move to trash.

**One shared controller owns the behavior** — `lib/useBulkTransactionEditing.jsx`. A host calls the hook with `{ rows, setRows, total, filterParams, categories, … }` and gets back `toggle`, `tableProps` (spread onto `TransactionListTable`), and a `<BulkEditChrome controller={…}/>` companion that renders the action bar plus the edit/confirm/notice dialogs. The host renders only its own toggle *button* (placement is page-contextual) and spreads `tableProps`; everything below — selection, the apply call, the in-place reconcile — lives in the controller, so a new surface is a prop-pass, not a re-implementation. Underneath it still composes the shared leaf pieces: selection state `lib/useTransactionSelection.js`, the editor `components/BulkEditPanel.jsx`, the header `SelectAllCheckbox` (`ui.jsx`), and the write `txnMutations.bulkUpdate`.

- **Select-all has two strategies.** Default (`'filter'`): the header checkbox switches to "all matching", and the API resolves the set server-side from the host's `filterParams` (passed via `toSelectionPayload`), so it covers rows past the loaded page. `'loaded'`: for a list whose visible rows are a *client-side* subset no server filter can re-resolve, select-all instead checks every loaded row by id (ids mode) — the rows are already fully in memory, so "all" needs no server round-trip. It fits only a fully-in-memory, **unpaginated** list; a paginated list must use `'filter'` (its loaded rows are only one page). No panel currently needs `'loaded'` — TagDetail used it while its slice was a client-side post-filter, but now that the slice is fully server-resolvable (`require_all_tag_ids` + `exclude_tag_ids`) it paginates and uses `'filter'` like the rest. Individually unchecking after select-all adds to an exclude set.
- **`filterParams` must mirror the host's list fetch exactly**, including any date/account/owner/tag scope. A select-all payload that omitted the date on a period-scoped list (the Dashboard drills, the month panels) would silently edit rows outside the visible scope — the same hidden-filter hazard called out for detail-panel date scope.
- The select column is injected at render only (never persisted into the user's column config) and is non-sortable/non-draggable/non-resizable; its header checkbox uses the pill header's per-column `render` hook (`PillTableHeader`) rather than a sort pill.
- Delete is soft-delete to the transaction trash (recoverable from Settings → Trash), confirmed before running — not a separate "hidden" state.
- **A large selection is confirmed before it runs** (`BULK_CONFIRM_THRESHOLD`, currently 500 rows). The gate lives in the controller's `runActions`, not in the action bar, so no host and no future action can route around it; the dialog names the count, what is about to happen, and whether the scope is "all matching" (rows the user cannot see) or the selected rows. The threshold sits above ordinary work — a merchant recategorization is tens of rows, a freshly imported batch marked reviewed is hundreds — because a gate that fires on routine edits trains the user to click through it. The trash path passes `confirmed` and keeps its own dialog, which already names the count: asking twice reads as a stutter, not as a check. Why it exists at all: "all matching" resolves server-side, so a selection that has quietly widened looks exactly like one that worked until the result notice lands, after the write.

- **Apply reconciles the loaded rows in place** (hosts pass `setRows`), so the user's sort order and scroll position survive a bulk edit. Trashed rows drop; field changes (including recategorization that moves a row out of the current scope) are patched onto the visible rows and *linger* — a mis-tap stays correctable and a Refresh (where present) prunes rows that no longer match. A host whose source of truth is a paginated re-fetch (the Transactions ledger) passes `onReload` instead of `setRows`.
- **The edit panel is draggable** (`AppDialog draggable`): its backdrop is transparent and click-through and the header is a drag handle, so the form can be moved aside to read — and still act on — the ledger behind it. Position is session-only and re-centers on reopen.
- Wired on: the Transactions page, the Categories matching-transactions list, both Dashboard single-period drill tables (selected category, selected group), and the floating detail panels — PeriodDetail, CategoryDetail, AccountDetail, ImportBatchDetail, and TagDetail. The duplicate-detection dialog deliberately stays on its own `row_number`-keyed selection (its finite, non-server-filter selection doesn't fit this model).

**Report dialogs use a lighter intersection bulk bar, not the transaction bulk controller.** The `MatchReport`-based reports (the duplicate-detection report and the Amazon reconciliation report) bulk-resolve via `MatchReport`'s built-in `selectable` checkbox column plus a report-owned bar below the filter pills: each bulk button shows the count of *selected rows that support that action* (the intersection — e.g. Merge only counts mergeable duplicate rows, Accept/Dismiss only split suggestions) and disables at zero. The intended workflow is filter-to-one-kind → select-all → apply. Actions that need a per-row choice (pick which duplicate copy survives, pick which charges cover an order) are deliberately not bulk actions; a per-row button should only be offered where it will actually succeed (the Merge button is gated on the backend's `mergeable` flag rather than letting a guarded call error). The reconciliation reports go one step further and share the whole dialog: `ReconciliationReportDialog` owns the pills, the kind column, the bar and the manual pairing window, and each vendor supplies only its buckets, columns and the call behind each action (`components/importExport/reconciliation/`), so a second vendor cannot drift from the first in how any of those behave. A report may be about one file or the whole ledger: Amazon's is per import, while the PayPal reconciliation opens either on one card's PayPal rows (the **Reconciliation** pill on a file or sync card whose share of the review lists anything — a card whose PayPal rows have no other side offers no way into an empty report) or on every PayPal row (the Tasks entry's `/import-export?review=paypal` link), because its matches are made after syncs as well as imports. A collapsed data source or connection totals its cards' attention in a **⚠ N to resolve** pill that expands it, like its duplicates and to-review pills; the total counts each row once, since a bank charge with no PayPal record is listed by every card whose dates cover it.

**The duplicate report describes a pair by the account grouping in force now, not by the premise that raised the flag.** A soft-flag's stored reason is a record of *why it was raised* — almost always "these are on different accounts" — and merging those accounts retires that premise without touching the flag. Left alone, the badge asserts a cross-account match on a report whose two sides print the same account name (a merge rewrites a child's `display_name` to the group root's), which reads as a bug and sends the user looking for one. So the rule badge, its filter pill, and the row's reason text all come from re-deriving the relationship at read time (`_IN_ACCOUNT_RULE_KEYS`, `list_unified_batch_duplicates`): a pair whose accounts share an effective root reads as *"Possible duplicate in this account"* / *"Duplicate in this account (confirmed)"*, and a detach puts it back. What is **not** re-derived is the tier: exact-vs-near-miss is evidence about the two rows, which a merge does not change, so an exact in-group match is still auto-confirmed on merge and a near-miss is still review-only — the merge changes how the flag reads, not whether it was decided. The general rule for any surface that replays a stored verdict: state the verdict as stored, but derive from current state anything the *user can still change*.

**Every transaction a match report names carries the ledger's origin hover.** A `MatchReport` row summarizes each side as "date · merchant · amount" — which is exactly the projection that hides *why* the two rows were paired, since the dedupe rules compare captured source text and a pair can match on a descriptor neither visible merchant shows. So each side of a duplicate-report entry (incoming, matched-existing, and every coverage candidate) carries an `origin` object — the same captured-field shape a ledger row exposes — and the dialog wraps the cell in the shared `MerchantOriginHoverCard` (`components/OriginFields.jsx`, the same card the transaction list and the Amazon reports use, at the same `ROW_HOVER_OPEN_DELAY_MS` dwell). Without it, auditing a flagged pair means leaving the report to find both rows in the register, which is where the answer was all along. Backend side: `_attach_origins` fills `origin` in one pass over the finished entries for anything with a `txn.id`; a hard-rejected row never became a `txn`, so its origin is rebuilt from the stored `txn_payload` plus the reporting batch's own provenance. A side with no captured detail renders no hover rather than an empty card (`hasFileOriginDetail`).

**Applying a rule to existing rows reconciles the same way — in place, not by re-fetch.** When the per-row "create rule" toast (`RuleSuggestionToast`) applies a rule to existing transactions, the rows it recategorizes must update *on screen but stay on the list* — re-running a scoped query (e.g. an "uncategorized only" drill) would drop the now-recategorized rows out of view, which reads as the data silently vanishing or, worse, lingering with the old category. So the apply endpoint (`POST /rules/{id}/apply`) returns the **`transaction_ids` it changed**, threaded through the toast's `onSaved`, and whoever mounts the toast — `TransactionListTable` for every list built on it, or a surface drawing its own category cell — calls the shared `reconcileRowsAfterRuleApply(rows, ids, setRows)` (`lib/txnMutations.js`): it re-fetches just the affected rows that are *currently on screen* by id (the transaction-list endpoint's `ids=` filter) and merges them back in place, so they keep their slot with the new category. Wired on the in-place surfaces that surface the toast — the Dashboard drills, the Categories matching list, and the payee `TransactionDetail`. The Transactions ledger is the deliberate exception: as the one paginated source of truth it stays on a full `load()` (matching its bulk-edit `onReload`).

### Copy for sharing

Any surface that shows a transaction or a list of them carries a small copy affordance (`CopyTransactionsButton`, a quiet copy glyph) so a user can lift the data out to paste into an email or notes without gathering fields by hand. It opens one app-wide read-only dialog (`TransactionShareDialog`, via the `useTransactionShare` context provider mounted at the App root) that shows a **dense, decoration-free preview** and a **Copy** button.

- **One transaction → a labeled record of every captured field** (date, amount, merchant, account, category, tags, notes, then the full from-the-file origin block the edit panel's "Show more" reveals). The single-transaction copy lives on the `TransactionDetail` **editor** header (next to the trash) — not the merchant-report mode, which offers the list copy instead, mirroring where the single-transaction trash lives.
- **A list → a compact table** of the standard ledger columns (date, merchant, category, account, amount) for the rows shown — on a paged list (the ledger, the detail panels, the Dashboard drills), every row matching its filters, not only the pages loaded so far. Wired on every transaction list: the merchant/category/account/tag/month detail panels (next to their Bulk Edit toggle), the Dashboard drills, and the Transactions ledger (whose older select-and-copy of the visible columns stays as the in-place complement).
- **The preview *is* the clipboard output.** Both come from one formatter (`lib/transactionShare.js`), so what the user sees is what they paste. Copy writes **both** a rich HTML `<table>`/record (so Gmail/Outlook/docs receive clean structure) **and** a plain-text fallback (labeled lines for one transaction, TSV for a list) — never app chrome or decorations. New transaction surfaces should reuse this button + context rather than re-implementing a copy path.
- **A list copy stops at 500 rows** (`TRANSACTION_COPY_ROW_LIMIT`). The copy is for pasting a handful of transactions into an email or notes, and every row lands on the clipboard twice. A surface that knows its list's size passes `total`, so a larger list is never fetched whole: the dialog says so and offers **Copy first 500** — the first rows in the list's order, straight to the clipboard, for when the filter was wider than meant — and, where the surface passes `onDownload`, the same rows as a CSV file. The download goes through the CSV export, which takes the list feed's whole filter and sort (`transaction_list_scope`), so the file holds exactly the rows the copy would have. Bulk edit's **Copy as CSV** is deliberately not capped — it is the path for a selection headed to a spreadsheet.

If a list introduces the same kind of object the user already manages elsewhere, start from the existing row/chip behavior first. A lighter presentation is fine, but it should still preserve the same core expectations for clicking, editing, Enter/Escape, and removal.

## Pills and expanding selectors

Use compact pill-style controls for values like owner, account type, and other small categorical fields.

- Closed state: show the current value in a rounded pill sized to the text.

- Open state: expand into the space needed for the dropdown or selector.

- Avoid heavy full-width selects when the value itself is short.

- When open, overlays should render above nearby content rather than underneath it.

- Opening a selector should not change row height or shift surrounding rows.

- A condition that can hold **repeated sub-values** expands in place rather than opening a separate editor: the rule editor's *Merchant Name Contains* chip (`RuleForm`) starts as one text box and grows an "and contains" row per added clause (capped, with a per-extra-clause remove and a "＋ and contains…" affordance), reading as one AND'd condition. The chip summary and the Rule Summary line render the clauses joined with "and". Keep the first clause un-removable (clearing the whole chip is the chip's own ×) so the primary value always has a stable home, mirroring how the fluid primary column works elsewhere.

For category assignment, prefer the shared category picker so transaction pages, import mapping, and any future category assignment flows behave the same way.

- Category pickers and the Categories page should reflect the same persisted group order so users do not learn one structure in the editor and see another while categorizing transactions.

- Top-level category groups should default into alphabetical order within their income or expense section until the user explicitly drags that section into a custom order.

### Two controls for one vocabulary

Filtering by what a row *is* (has an attachment, is recurring, needs review — see `data-model.md` →
*Attributes*) is offered twice on purpose, and the split is by **job**, not by capability:

- **The ledger's quick filter** (`AttributeFilterControl`, beside the search box and the amount
  popover) is **single-select** and page-local. It is the control for finding something quickly, so
  picking one attribute must never mean unpicking another first — and because only one can be in force,
  the button can be *named for what it filters on*, which is what the two toggles it replaced did.
- **The FilterBar's Attributes tab** is multi-select, takes "is not" like every other facet, and
  combines with accounts, categories, owners, payees and tags.

Overlap between the two is intended. The alternative — one control doing both jobs — costs the naming
(a multi-select button cannot be called "Needs review") and makes the common case, flipping to one
attribute and back, a multi-step interaction.

**A split button is what keeps "toggle" and "choose" separate.** The body switches the filter on and off
while *keeping* the choice, so the ledger flips between filtered and unfiltered in one click without
re-picking; the caret changes which attribute that is. Until something is picked there is nothing to
toggle, so the whole button opens the picker. Picking applies immediately — reaching into the menu is
itself the request to apply it, and landing on a chosen-but-inert filter reads as the control having
failed.

**The vocabulary is fetched, not hardcoded** (`GET /transactions/filter-attributes`), labels included, so
the two surfaces cannot drift from each other or from the predicates behind them. Both therefore render
from an empty list on first paint and must not claim a selection they cannot yet name.

**The quick filter has no "clear", and always carries a choice.** Switched off, it already shows
everything, so a clear would be a second control for a state the body button reaches in one click — and
an empty choice leaves the button with nothing to name itself after, which is the whole reason it is one
named button rather than a row of toggles. The page seeds a default (Uncategorized, switched off)
instead. The choice is remembered in the page's session state alongside the search box and the amount
filter, so it survives navigation and resets on relaunch like its siblings; a `?only=` link is an
explicit instruction and outranks both the seed and the remembered value.

**An import report carries the same quick filter, seeded by whoever opened it.** A card's *N to review*
pill opens the report with *Needs review* switched on; the ↗ and every drill-through open it with *Needs
review* chosen but off. Opening on only the rows to review with no way back would hide the rest of the file
they are being checked against, and sorting reviewed rows down would move each row the moment it was
marked. The seed rides the report's payload like its date filter, so re-opening an open report re-applies
it. A report remembers nothing across openings, and its header states the filtered count against the
file's (*Needs review: 12 of 240 imported transactions from this file*), since the filtered figure alone
reads as the size of the file. As on the ledger, a row marked reviewed stays until the report's ↻.

**Tabs in a facet popover size to their labels, not to equal `flex: 1` cells.** Equal cells give the
widest labels no breathing room while short ones sit in slack, so two long neighbours read as one run of
text — and it degrades with every tab added. Natural width plus real horizontal padding keeps the gap
where it is perceived, between the words.

**A quick filter is a value in a facet, not an override.** These narrow by ANDing like every other facet.
The toggles they replaced squatted on `category_id` and silently won over a category chip; ANDing is both
the rule everything else follows and the honest answer, since "Groceries and uncategorized" is empty.

## Empty states

Empty states should be brief and quiet.

- Prefer `None.` or `No accounts yet.` over long instructional copy.

- Keep the empty-state card close in width and height to nearby sections.

- Put the primary action inside or immediately adjacent to the empty state.

- Avoid oversized boxes for simple “nothing here yet” states.

- **Every marker in a transaction row's marker strip opens what it stands for.** The note glyph, the tag chips and the document marker all act on click; an inert marker sitting among them reads as broken rather than as restraint, which is exactly how the document indicator first shipped. It is a drawn page glyph (`DocumentGlyph`), not 📎: at row size the paperclip read as the purchase marker's `🔗`, and a colour emoji ignores the accent colour the search-match emphasis uses. The document marker opens the document when there is one and a small chooser when there are several — the count is on the icon, so which case you are in is visible before the click. Attaching still belongs to the detail panel, which has room to explain itself; the row only *opens*. The data this needs rides the list feed (`documents`, slim rows without the extracted text) rather than being fetched on click, the same call `split_parts` made: a marker that opens from a row must not put a loading state inside the interaction.

## Drop zones and file inputs

When a file-upload action is important, prefer a visible drop zone over a bare browser file input.

- Use the same visual pattern across the app where possible. **`components/DropZone.jsx` is that pattern** — reach for it rather than rebuilding the dashed box and its `dragOver` state (see `shared-components.md`, including why the CSV upload stage and the document attach box keep their own).

- The control should support both clicking to browse and dropping a file.

- Keep the text concise and task-specific.

- **Where a drop target and a paste target serve one action, make them one box.** Adding a document to a transaction was first a drop zone stacked above a paste box, two full-width controls standing on every transaction's panel for something done occasionally. They are one `DocumentAttachTarget` now: the paste box also accepts dropped files, and **Browse…** is a button beside it. The combination only works in that direction — a textarea can take a drop, but a drop zone cannot take a paste (below) — and it is why the box is not a `DropZone`: a click in a textarea has to place the caret, so it cannot also open the file picker. Only a drag carrying files is claimed; a dragged text selection is left to the textarea, which inserts it as text to review like a paste.

- **A paste target has to be a genuinely editable element.** This is not a styling preference and it is easy to get wrong: a `paste` event fires only at the *focused* element, and browsers offer "Paste" in the right-click menu only for `input` / `textarea` / `contenteditable`. A handler on a plain `div` — even a focusable one — is therefore unreachable by keyboard *and* by mouse, however clearly it is labelled, which is exactly how the document panel first shipped. Use a real textarea, and let it also be where pasted text is shown. (`navigator.clipboard.read()` is not the way out: `lib/transactionShare.js` records that `navigator.clipboard` is absent entirely in insecure contexts, which covers the ordinary LAN/WSL2 deployment.)

- **Read the clipboard's rich flavour, not only the plain one.** A `<textarea>` receives `text/plain` and nothing else, but `clipboardData.getData('text/html')` is right there on the same event — and for anything copied out of an email or a web page, the plain flavour is the rich one *flattened*, which for a table means every cell on its own line. Taking the markup is often the difference between storing a receipt and storing a scramble of it. `lib/transactionShare.js` already writes both flavours when copying; this is the same idea in the other direction. Only prefer the rich flavour when it actually contains markup, and only when the paste lands in an empty box — pasted into text already being edited, it is an insertion into that text rather than a new document.

- **Show the flavour that will be stored, never describe it.** A textarea can only display the plain flavour, so a rich paste reviewed there is a promise about something invisible — which is how the document panel first shipped, with a note saying the unseen layout would be kept unless the visible text was edited. A rich paste is instead shown **as formatted**, in place of the box, with only **Attach** and **Discard**. There is deliberately no route from it to editable text: converting the markup to text for trimming discards exactly the formatting that made the paste worth keeping, so a narrower selection in the source is the way to leave things out. The price is that a formatted receipt cannot be trimmed and keep its layout: editing markup would mean putting an email's HTML live in the app's own DOM behind a sanitizer, which is a security boundary out of proportion to removing a signature. The preview is a token-less `sandbox` iframe fed through `lib/pastedHtmlPreview.js`, which applies the stored document's own policy (`default-src 'none'`) and removes what a policy does not cover; it therefore renders exactly as plainly as the attached copy will, rather than promising a styled page the viewer will not show.

- **Let a paste that has something to review land before it commits.** Attaching a document takes both: a pasted *image* attaches at once, exactly like a dropped file, because there is nothing to look at first; pasted *text* — plain or formatted — is shown first, because a receipt copied out of an email arrives wrapped in signature and quoting and attaching it unseen would store all of that. Same machine-proposes / user-approves shape as the rest of the app.

- **A paste is named `documentation.<ext>`.** A pasted image arrives named `image.png` (Chromium) or `blob`, and pasted text has no file at all, so each is given a neutral name whose extension says what kind of document it is — not "receipt" or "invoice", since the app cannot know which it is. A real file copied in a file manager and pasted keeps its own name. Names are editable afterwards, so the date the older names carried is not needed to tell pastes apart (`lib/pastedDocuments.js`).

- **Taking a document away offers both an undoable and a permanent way, and styles them by that.** On a transaction's list, **×** moves the document to the stored documents without asking — the answer to "attached to the wrong transaction", undone by attaching it again — and the **bin** deletes it after a red confirm, because the file does not come back. The store's own list has only the bin. See *Calibrate destructive styling to reversibility* in `collaboration-notes.md`.

- **A stored document is attached from the transaction, never from the store.** The Transactions page's **Stored documents** dialog adds, renames, edits and deletes; the transaction's Documents section offers **Stored documents (N)** — shown only when there are some — which opens a picker whose one action is **Attach**. A transaction picker inside the store would be a second, worse way to find a row the ledger already finds, and the moment an invoice meets its charge is when the charge is on screen. The page button carries the count so a kept invoice is not forgotten once its charge arrives. A lone document added to the store opens its name for editing, since the name is what the picker will show.

- **An attached text document is edited from its viewer, and a save hands the host a new document.** `DocumentViewerDialog` offers **Edit** for `text/plain` only (a document list's own **Edit** opens the viewer straight into it), loads the text into a textarea, and on **Save** reports `onDocumentReplaced(previousId, replacement)`, because the server replaces rather than rewrites (see `data-model.md`). Each host swaps the id in the copy it opens from: the detail panel reloads its list, and the ledger row patches its own `documents` through `onUpdateDocuments`. A host that forgets opens a document that no longer exists on the next click, which is the same failure a count-only reconcile once produced. An unchanged save makes no request, and a failed one keeps the draft on screen.

- **Report uploads per file, not as one busy flag.** A drop can carry several files and each settles on its own; a single spinner turns "the big scan is still going" into "this looks stuck", and a failure message that does not name its file is not actionable when three things were dropped together.

- If the loaded file becomes editable text, switch to the editor after load rather than trying to keep two separate controls visible.

**One picker per *task*, not one per file format.** Where a surface accepts more than one kind of file for
the same user intent, read the file and route on what it is rather than presenting a control per kind.
Restore is the worked example: a data backup and a credentials backup are different artifacts with very
different consequences, but the person holding one has "my backup" and a goal, and asking which control
to use is asking them to know how the app is split internally. Two costs follow from getting this wrong,
both of which the Backup/Restore tab used to pay — the wrong choice fails with an error phrased in terms
of internals (there, the names of members inside a ZIP), and the inputs each kind needs are all on screen
at once whether or not they apply.

The shape that replaces it: one picker, an identification step, then the flow the answer implies —
revealing only the inputs that kind needs, labelling the action for what it will do, and **naming the
kind in the confirmation** so the routing is stated rather than assumed. This depends on the files being
self-describing, which is a format obligation, not a UI one: see `data-model.md` → Backups. Detection
must key on content, never on the file's name — the user renames files, and a name is not a fact about
what is inside.

### A secret shown once must be saved before whatever depends on it exists

Some values are displayed exactly once and are unrecoverable afterwards — 2FA recovery codes, and the
private key of a generated backup keypair. For those, the order of operations *is* the safety property:
offer the download/copy first, require an explicit acknowledgment that it was saved, and only then create
the thing that depends on it. Creating first and revealing after leaves a window where the dependent
object exists and its secret does not — a backup recipient whose private key was never kept means backups
encrypted to a key nobody holds, and that is discovered on the day they are needed.

The window has a second side. Once the secret has been saved, no exit may discard the dependent object:
a Cancel still on offer after the download leaves a kept private key whose public half was thrown away.
The backup key generator therefore treats the download or copy itself as the acknowledgment — saving
creates the recipient, and the dialog's only button from then on is **Done**.

Say plainly what losing it costs and that there is no reset. Offer both a download and a clipboard copy,
with a fallback message when the clipboard is unavailable (a non-secure context or a denied permission)
telling the user to select and copy manually — otherwise the failure is a button that silently does
nothing — and a copy made by hand has to count as a save as well. Drop the value from component state
when the dialog closes; keeping it until then is what allows a second copy after the first has created
the dependent object.

## Enter in a small explicit-submit form

**Enter advances through the fields and submits from the last one.** The sign-in screen has always worked
this way; the vault dialogs did not, so the app's most-typed secret — a 20-character vault passphrase —
had to be followed by a reach for the mouse. `lib/formKeys.js` (`onEnter`, `advanceOnEnter`) is the shared
version, so a fourth copy does not diverge again.

Two rules travel with it:

- **Gate Enter on the same condition as the button**, named once and used by both. A separately-written
  condition is how Enter comes to accept what the button refuses — and for a vault passphrase that means
  walking straight past the strength floor.
- **A destructive confirmation takes no Enter handler.** Where a typed phrase exists to make an
  irreversible action deliberate (the vault reset's `RESET VAULT`), firing it from the keyboard gives back
  exactly what the confirmation was added to take away. The button is the only way through, and that
  asymmetry is deliberate rather than an oversight to be tidied up later.

Note the mechanical prerequisite: fields carrying a `sensitiveFields.js` set (any but `ONE_TIME_CODE_PROPS`)
render with **no id or name** (see `shared-components.md`), so focus cannot be moved by querying for the
next field — `Input` and `PasswordInput` forward a ref for exactly this.

## Secret fields

**Every secret someone types or pastes gets a Show/Hide reveal** (`PasswordInput`): sign-in and user
passwords, vault passphrases, backup and key-file passphrases, provider secrets. A masked field with no
reveal leaves no way to check what actually landed in it.

**Password managers are welcome; the browser's form history is not.** A manager fills from a store the user
chose to save into, usually behind an unlock, and offering a strong generated value for a secret being
chosen is help. Form history replays whatever was once typed into a field the browser considers the same
one, and that is what the sets in `lib/sensitiveFields.js` suppress. So a field says which kind of secret it
holds rather than trying to keep managers away:

- **A new secret** is `new-password`, and a manager may generate it.
- **An existing secret** is `current-password`. Marking one as new is not harmless: a manager then offers,
  and can fill in, a freshly generated value for a field whose only correct content already exists.
- **A surface with no username field names the credential** with a hidden `username` field
  (`PasswordManagerUsername`), because managers file saved secrets by site and username. Without it a vault
  passphrase has nothing to tell it apart from the sign-in password for the same site — or a backup key's
  passphrase from the vault passphrase, which is how a key passphrase came to be offered at unlock. A
  distinct name labels the entry; it does not stop a manager listing it on another password field.

**A field that chooses a passphrase can suggest one** (`PasswordInput`'s `onSuggest`): the vault
passphrase wherever it is chosen (set, change, request access, both recovery rungs) and a generated backup
key's passphrase. It is six words drawn from the EFF large word list (`lib/passphraseGenerator.js`, about
77 bits), filled into the field and shown, while the confirm field is emptied and focused rather than
filled — typing the words back is what shows they were taken down, the same save-before-it-counts rule a
generated key follows. Words rather than random characters because the case it serves is someone without
a password manager, who has to type the passphrase at every unlock. The field keeps `new-password`, so a
manager can still offer its own.

**A field that chooses a secret is checked as it is typed, and its button is greyed for a stated reason.**
The vault passphrase dialog set the shape and every app-password form follows it — enabling sign-in, the
first account, a forced change at sign-in, adding and editing users. What is still wrong appears under the
field in the words of the unmet rule (`FieldIssue`), "do not match" appears from the first character of the
confirmation, and the disabled button's hover gives the same sentence, because one expression
(`passwordIssue` in `lib/passwordPolicy.js`, `newPassphraseIssue` in the vault dialog) feeds both. The
refused-on-submit shape it replaced had a failure beyond the wasted round trip: its message described the
attempt that produced it, so after a correction a valid password sat beside "does not meet the policy".
What is left in a form's error line is only what the server said, and any edit retires it. Signing in with
an *existing* password is deliberately not held to the policy client-side — the policy may have tightened
since that password was set.

### Import history outlives the connection that produced it

A sync card is the **provenance of transactions still in the ledger**, so it survives the connection being
removed — `import_batch.connection_id` is `ON DELETE SET NULL`, keeping the history and dropping only the
link. Two rules follow, both learned from getting them wrong:

- **Group orphaned cards by the identity they still carry** (the filename prefix), never into one bucket.
  Keyed together, a group takes its label from whichever card is newest and files every other source under
  it — which put a SimpleFIN import beneath a bank's name.
- **Say that the source is gone.** A disconnected group reads *"Disconnected · import history kept"*
  rather than falling through to the generic connection subtitle, which made history look like a second
  live connection sitting next to the real one.

### A source label that is an opaque provider id

A sync labels each card's source account from `connection_account`, and falls back to the provider's raw
account id when no record exists for an account the row nonetheless resolved to (the two lookups disagree:
`account.external_account_id` is durable and global, `connection_account` is per connection). **The stored
value cannot be corrected retroactively** — it is written into each row's evidence and feeds duplicate
matching — so the fix is presentational: the chip shows the account the rows landed in and keeps the id in
its tooltip. The backend records an advisory when the fallback fires, which is log-only on purpose;
`last_sync_warnings` is shown on the card and is reserved for things the user can act on, and Luma's own
bookkeeping being inconsistent is not one of them.

## Confirmation and completion flows

Do not rely on browser `confirm()`, `alert()`, or `prompt()` dialogs when the rest of the app has a clear UI style.

- Use in-app confirmation overlays for destructive actions like restore.

- Use the shared app dialog primitives for notice, confirmation, and short text-entry flows so copy, button layout, and dismissal behavior stay consistent.

- Confirmation and completion steps in the same flow should use the same visual language.

- Avoid dismissing important confirmation modals by backdrop click if the user needs to make an explicit choice.

- Success dialogs should usually have one clear next step.

- **A multi-step ceremony must report every non-success outcome — including the ones the user appears to
  have chosen.** A flow that spans several prompts (passkey registration is the reference: a WebAuthn
  `create()` followed by a `get()`) can end in cancellation, an unsupported authenticator, or a silent
  dismissal, and it is tempting to treat a cancel as self-explanatory — the user declined, so say
  nothing. That only holds if they know *what* they declined. Swallowing it leaves the surface unchanged,
  which reads as "the button did nothing, press it again", and the step they dismissed may be the one
  that actually saves the result. Report the outcome, name which step it belonged to, and where a
  capability is simply missing return it as a *reason* the UI can turn into advice rather than as an
  error — see the PRF fallback in `VaultSettingsDialog`.

- **Fewer prompts is a correctness property in a ceremony, not just polish.** Two consecutive
  authenticator prompts are indistinguishable to the person answering them, so the second reads as a
  repeat of the first and gets dismissed — taking the result with it. Where a step can be folded into an
  earlier one at no cost when unsupported (asking for PRF `eval` at creation, which is ignored where it
  is not implemented, leaving the fallback path intact), fold it.

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

Getting started is three beats: `how-luma-works` (what the app is for, and the facts that hold
everywhere), `parts-of-luma` (which part owns which job), `design-principles` (how it is meant to be
worked). The middle one is the only topic organized around the app rather than a subject, and it is a
**table** — one row per nav surface in the order data moves through them, the name linking to that page's
`page-*` hub, the second column saying what the part is *for*. That second column is the whole
justification for the topic: the Help index already lists every title and summary, so a row that only
restates its own title makes the tour a shorter copy of the index. Prose belongs in the hub, not here —
when the table replaced a paragraph-per-part tour, the one piece of guidance no hub carried (which
accounts are worth importing, and filing the card payment in a group excluded from totals) moved into
`page-accounts` rather than being dropped. A new page needs a table row as well as a hub, guarded in
`content.test.jsx`, since a tour that quietly stops covering the app is invisible from the inside. The
table's styling lives in `HELP_BODY_CSS` with the rest of the body rules, so both render targets get it.

Facts that hold for the whole ledger rather than one page are their own section — **General concepts**
(`general-concepts`), placed **last**: the single currency, the data on disk and its backups, and
sign-in protection. A topic that explains one *section of a page* stays with that page instead —
`configuration` is filed under Settings, where its `?` lives. A section holding a single topic is normal
and not a sign the index needs consolidating: `recurring`, `tasks` and `settings` each have one, because
the sections mirror the nav rather than balancing sizes.

A topic covers what the screen cannot say for itself. Where a control already carries a help line, a
button tooltip and a confirm dialog stating the consequence, a paragraph repeating all three is the
fourth telling and gets deleted rather than improved — what survives in the topic is what the reader
cannot get from the screen (what the thing *is*, and when it would ever be touched). Last because the index order is also a reading order, and none of these is
what a new reader should meet first; they are background to go looking for. Two rules keep it from being an appendix. A topic
here is one no page owns, so *where* it is surfaced is a `?` on the control it describes (the Currency
setting) rather than a page hub. And `how-luma-works` links every one of them, because before they were
grouped the same topics sat at the foot of the index with nothing pointing at them — a section of
whole-app facts that nothing references is indistinguishable from one that does not exist.

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
  of routing, and the overlay — which is the scroll container and outlives the switch — starts each new
  body at its own top. Each switch also pushes the topic being left, with its scroll position, onto a trail
  held in the dialog's own state, and the footer's left side offers `← Back to <topic>` to pop it and return
  the reader to where they followed the link, since a cross-link usually sits partway down a body. It sits
  at the foot, not the top, because a linked topic is read through before stepping back. The trail never
  touches browser history: the viewer does not route, so a history entry would make the browser's Back act
  on the page behind the overlay. It lives only as long as the dialog, and a `?` opening a different topic
  starts a new one. The viewer already shows the full body, so its footer links to the `/help` *index* (a
  distinct destination, not a repeat of the same text) and stamps the page behind the overlay as
  `state.from` so the index offers a `Return to <page>` link back. The overlay carries
  `data-modal-overlay` so a panel underneath yields Escape to it.

- **A cross-link may address a heading, not just a topic.** Several links name a part of a topic ("how
  rules come into being", two thirds of the way down "The parts of Luma"), and landing at the top of a
  long body hides the thing the link promised. Those links are written
  `to="/help/<topic>#<anchor>"` and the heading is authored as `<HelpHeading anchor="...">` rather than
  a bare `<h4>` (`help/HelpHeading.jsx`, mechanism in `help/helpAnchors.js`). Both render targets
  resolve it: the `/help` route reads `location.hash` in place of its reset-to-top, and the in-place
  viewer — which never routes, so never sees a hash — takes the anchor as a second argument to
  `HelpNavContext`'s `navigate(topicId, anchor)`. Two constraints shape the mechanism. An anchor is a
  **`data-help-anchor` attribute found by a query scoped to the element that rendered the body**, never
  a document-wide `id`: the viewer opens *over* the page behind it, which may be the same topic's
  `/help` page, so with two copies of one body mounted a document lookup would scroll whichever came
  first. And a **missing anchor falls back to the top** rather than erroring, so a renamed heading
  degrades to the old behavior — which is silent, and therefore guarded in `content.test.jsx`
  (every anchored link must resolve in its destination body; anchors must be unique and
  lowercase-hyphenated within a body).

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
  toggle) — those are not page-level and do not move to the title. A surface that swaps its whole body
  between states **swaps its topic with it**: the Amazon import card's `?` opens the AZAD export topic
  while the drop zone is showing and the import-settings topic once files are chosen, since a launcher
  that stays on the first state answers a question the reader already answered. The topic left behind
  stays one click away by cross-link, not by leaving the wrong launcher in place.

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

## Dismissing what the app is nagging about

Anything the app raises unprompted — a Tasks card, a recurring anomaly signal — needs an answer for "I
have seen this and it is fine". Which mechanism depends on whether the thing being dismissed is one
identifiable finding or a running count of work.

- **The app only raises an anomaly about a commitment the user has taken on.** `missed`, `price_change`
  and `upcoming` each speak as though the obligation were established — a charge that was owed did not
  arrive, one that is paid went up, the next one is due — and about an unaccepted suggestion none of
  those is a statement the app is in a position to make. Reporting that a hypothesis nobody endorsed
  failed to come true is noise, and it contradicts itself on screen: one candidate appeared under
  Suggested while warning, beside it, that the charge it had just predicted was missing. So those three
  are gated on the series being user-owned (confirmed, manual, or rule-backed), and `new_series` — whose
  whole purpose is to surface a suggestion — carries the inverse gate. **The gate is per-signal, which is
  how three of four came to be missing it**, so the test asserts on the whole emitted set rather than one
  kind: a fifth signal fails it until it answers the question too.

- **An individually identifiable finding is dismissed one at a time, by fingerprint.** A recurring
  signal names a specific charge, a specific missed date, or a specific rule, so "seen it" is an answer
  about *that*. The fingerprint must be stable across whatever rebuilds the underlying record — the
  recurring signals key on a transaction id or a series' derived identity, never on a series id, because
  an auto-detected series is re-minted with a new id on every scan. A new finding of the same kind is a
  new fingerprint and surfaces on its own, which is what makes this mechanism safe.

- **A fingerprint that is *too* stable is the same bug from the other side.** It must carry not only the
  finding's subject but what made the finding **actionable**, or "seen it" silently also covers a
  materially different situation that subject falls into later. The rule-overlap check keys a nesting
  pair on the two rule ids *plus* whether the narrow rule was redundant: acknowledged while that rule was
  doing work of its own, the pair returns if a later edit makes it surplus, because there is now an offer
  to delete it that nobody was ever asked about. The test to apply is not "is this the same subject" but
  "would the user's answer still be the same" — an edit that changes nothing about the finding (a rename,
  a tag) must not re-raise it, and one that changes what it says must.

- **A running count is dismissed with a high-water mark that ratchets *down*.** A task like
  "uncategorized transactions" has no individually addressable items on the surface that raises it, so
  what is stored is the count at dismissal and the card returns when the count rises above it. **The
  mark must also fall to any lower count observed since**, and that half is not an optimization: a mark
  that only held at its original value swallows new work precisely *because* the user did some. Dismiss
  at forty, clear ten, and five new ones arrive — thirty-five is still under forty, so five genuinely new
  items stay hidden forever. Ratcheting down means the comparison is always against the quietest the list
  has been since. A mark whose task has stopped applying entirely is dropped, so the dismissal expires on
  its own rather than covering the task's next appearance.

- **A Tasks card is a reminder, so every one is dismissible except a required one.** Dismissing a card
  puts the reminder away and nothing else: the state stays on the page the task links to, and a finding
  with its own per-item answer (a recurring signal, a snoozed reimbursement) keeps it. "Two of these are
  waiting on someone else" is a legitimate reason to hide a reminder even where it would not be a reason
  to answer the finding. The one exception is something *required* rather than advisory (the HTTPS warning
  with a data provider configured), which stays until fixed. The backend applies the rule in one place
  (`_with_dismiss_keys`, keyed on `required`) and the surface reads `dismiss_key`, never inferring it. The
  control is a muted **Dismiss** tab set into the card's bottom-right corner, over the card's border, so it
  is easy to find without competing with the task's link. This reverses an earlier rule that withheld
  dismissal from the connection, vault-access, recurring, rule-drift and reimbursement tasks for reasons
  about the underlying state; don't re-impose it. Note what dismissal buys where a count does not fall on
  its own (a broken connection): the card stays hidden until the count rises.

  **Nondeterminism is a reason a *finding* cannot be acknowledged, distinct from the Tasks reminder.** Where the app is reporting that it
  cannot tell what it will do — two category rules whose amount ranges overlap with no principled winner
  — acknowledging is not a legitimate answer, because the ledger goes on being categorized by an
  arithmetic accident while the surface reports nothing outstanding. Those stay listed until the *model*
  is corrected. This is why the same panel can have one section that offers dismissal and one that must
  not: what separates them is whether the finding is information or an undecidable state, not how severe
  it looks. As above, the backend declares it per finding (`dismissible`) and enforces the refusal where
  findings are assembled, so no stored row can hide one and no surface can grow its own opinion.

- **A dismissed item leaves a way back, in two places.** An immediate `UndoToast` for the press that was
  a mistake, and a durable collapsed list at the foot of the surface ("N dismissed") for the one noticed
  later. A card that vanishes with no trace is indistinguishable from work that was lost — the same
  reason a removal from a recurring series is recoverable three ways. **The toast half is what a
  self-contained surface can drop**: where the dismissal happens inside a panel that also carries the
  "N dismissed" reveal, the way back is already on screen and two clicks away, and it stays on screen
  because the user has not navigated anywhere. A toast earns its place when the surface that raised the
  item is one the user is passing through — a Tasks card dismissed on the way somewhere else.

- **A detail panel that persists an edit must reconcile the row behind it — and the reconcile belongs in
  the shared write path, not at each call site.** The panel re-seeds from the host's row when reopened, so
  a host left holding the old value does not merely look stale: the edit saved, displayed correctly, and
  came back wrong on the next open, which is indistinguishable from the write having been *rejected*. In
  `TransactionDetail` the note and tag writes each carried their own copy of the reconcile call, with a
  comment on each explaining why it was needed; the rename carried neither, and nothing in the shape of
  the code said a caller owed one. Two comments explaining the same invariant at two call sites is the
  signal that it belongs one level down.

- **A page's Refresh reloads what the page is showing, not one of the things it can show.** The Recurring
  page's Refresh called only its series-list loader, so from the *Needs attention* or *Upcoming* view it
  re-fetched something not on screen and left the findings untouched — which reads as the edit having
  failed, since findings are derived on read and were already correct on the server. A refresh control on
  a page with several views reloads every source the active view draws from, including an open drill-down.

- **A finding's headline opens a report of what it names.** Every recurring finding carries an arrow on
  its headline that opens the drill-down report on the series the headline is about, docked in place
  under the findings. It replaced an *Open series* button that only some kinds ever had, which left
  *Newly detected* asking for a Confirm with no way to look at the series. **Two affordances for one
  action, present on some rows and not others, is worse than either alone**; the arrow goes on the name
  because the name is what it opens, which is the same rule as the row markers above.

  This surface once also carried the rule range-drift findings, whose headline named a *transaction*
  rather than a series, and the arrow's target changed with the row it sat on. Those findings now live on
  the Rules page, where both of their actions already pointed — see *A finding belongs to the surface its
  actions edit* below.

  **Where the durable half lives depends on the scope of the decision, not the surface that raised it.**
  Keep on a flagged duplicate follows this pattern with the second half in **Settings** rather than at
  the foot of the duplicate report, because the report is scoped to one import batch while the judgement
  it records is global: a "N dismissed" reveal there could only ever show the subset that happened to
  come from the batch being viewed, which is a worse answer than none. It sits beside *Distinct account
  pairs*, whose reasoning it shares verbatim — a durable decision made in passing has to be inspectable
  somewhere. The toast still earns its place: the user is passing through the report on the way to an
  empty list.

- **Nothing variable-length belongs in a pinned header.** A page whose header block is `flexShrink: 0`
  over a body that is `flex: 1; minHeight: 0` will let the header grow without limit and collapse the
  body to nothing. The Recurring page's findings section did exactly that: a busy ledger's findings
  pushed the series list and the drill-down panel off the viewport, so opening a series drew its report
  into a region with no height and read as a dead button. Capping the section's height *rations* the
  symptom; the fix was that findings and the series they refer to had no business sharing a viewport at
  all, and they became peer views instead (next bullet). Where something variable genuinely must sit in
  a header, scroll it inside a capped box and keep its controls and counts *outside* that scroll so they
  stay reachable — but treat the need for that cap as a sign the surface is carrying two things.

- **Purely forward-looking information is not a nag and gets no badge.** Upcoming recurring charges are
  a budgeting view someone may want to consult; nothing about them is wrong, so they carry no actions, no
  dismissal, and never reach the Tasks page. A badge that counts ordinary life stops meaning anything.

- **A finding belongs to the surface its actions edit, not the one where it was first noticed.** The
  rule range-drift findings — a charge that missed an amount-gated rule's bound — were built beside the
  recurring signals, because a drifted range costs the row its place in the rule's series. But both
  actions they offer (*Widen to include*, *Edit rule*) edit a **rule**, the finding is derived without
  reference to any series, and a rule with no series at all raises it just the same. On the Recurring
  page they had to head their card with a transaction instead of a series, give the headline arrow a
  second kind of target, and take a name-plus-a-caveat in a filter row about series. On the Rules page
  they are one more thing wrong with the rule set. **The tell is a finding that needs an exception in
  every shared mechanism of the surface hosting it**; the consequence it names — here, the lost series —
  belongs in the finding's own sentence, not in its address. What follows from the fix follows on its
  own: widening re-applies the rule, and the detector returns the row to the series on its next pass.

- **Only the half that arrives on its own earns a badge.** The Rules page's *Rule checkup* runs three
  checks and badges one. Drifted ranges appear because a charge landed in the ledger and a rule quietly
  stopped claiming it — news, and worth a count on the control. The overlap and nesting findings are an
  **audit**: they change only when the user edits a rule, so a badge for them would sit at 3 for months
  over pairs already looked at and decided about, which is the same way a badge that counts ordinary life
  stops meaning anything. The unbadged half also stays *on demand* — its pairwise pass runs when the
  panel opens, while the badged half runs on page load.

## Import-specific patterns

CSV import has a few special rules:

- **The upload flow is drop-first, not pick-first.** The import screen opens to a plain CSV drop zone; the data source is *detected* from the dropped file by matching its header fingerprint against the saved data sources. Exactly one match applies automatically, several open a small chooser to pick among the matches, and none falls back to a temporary draft — so the common case is "drop the file and go," with no up-front data-source question. The explicit data-source picker still exists for the cases that need it, surfaced on demand: a "Choose a data source" link on the upload screen, "Start over" on the mapping screen, and "Change" once a source is selected. An *explicit* pick (not an auto-detected one) still runs the header-mismatch verification so a wrong choice is caught and changeable. **Detection waits for the page's initial load.** The drop zone is usable from the first render, but the saved sources and accounts a file is matched and mapped against arrive with that load, so a file dropped before it settles is held (the drop zone shows its busy state) and handled once it does. Handling it immediately matched it against empty lists and silently took a temporary draft even when its source existed, which CI caught as an intermittent failure. If the load fails, a drop says so instead of importing into a draft. This replaces the older model that asked the user to choose a data source (or Skip) before dropping a file, and the first-run-only variants of that prompt.

  - **Multiple files can be selected at once — a shortcut for importing them one at a time.** The drop zone / file picker accepts several CSVs. Each is previewed and grouped by data source (the same header-fingerprint signal), and **every file becomes its own batch / history card** — the natural per-file result, preserving each file's own coverage window, dedup, undo, and provenance (the importer runs the single-file path N times; nothing is merged). The mapping stage is driven by the first file's preview and that one mapping is applied to all files in the group. **The account column is the exception that unions across files:** when the file has an account column, the mapping UI shows the union of that column's distinct values across *every* file in the group (`unionPreviewColumnValues`), so a value that appears only in a later file is still mapped, not silently misrouted. At import, each file receives only the account config for the values it actually contains, so a "create new" account is created by the first file that holds it and reused by name for the rest (the backend's find-or-create-by-name), never duplicated. Requirement: **one data source per import** — if the selection spans more than one source, a chooser lists the files grouped by detected source and the user picks *which source to import now* (re-run for the others). All-same-source goes straight to the mapping screen (the import button reads "Import N files"), imports sequentially with a progress count, and finishes with a summary dialog rather than the single-file review screen — per-file detail (rejected rows, duplicates, rule suggestions) lives on each file's card below. The mapping screen is driven by the first group file that is **not** itself an already-imported duplicate (`previous_batch`), so a duplicate sitting first in the selection doesn't put the screen into the "already imported" state and block importing the others; if *every* selected file was already imported, a notice says so and no mapping screen opens. A file whose content was **already imported** (e.g. a duplicate copy in the selection, or a match to a prior batch) is **skipped, and the rest continue** — the backend returns a structured `409` (`reason: 'already_imported'` + the matched file's name) that the loop catches per file, and the summary names each skip ("`X` has already been imported [as `Y`] — Skipping"; `formatSkippedImportMessage`). Whole-file skip fires only when re-importing would add *nothing*: an account-column file re-used to import an account that was *skipped* the first time is **not** blocked — its new account imports and the already-imported accounts' rows fall to ordinary row-level dedup. A single-file selection is unchanged: it still uses the full single-file review flow. Grouping is `groupFilesBySource` (pure, in `importDraft.js`); the aggregate summary is `buildMultiFileResult` (`importOutcome.js`). Marketplace imports follow the same per-file rule — see the marketplace-account bullet below, where the per-file cards are ordered by data recency rather than import time.

  - **Why the "Data source: X" tag above the drop zone is still present but rarely seen.** It renders only when a source is *explicitly* selected and the chooser is closed — i.e. only after the user picks one through "Choose a data source" / "Start over" / "Change". It is deliberately **not** seeded by implicit/leftover state: there is no last-used-source preference re-applied on load, "save as data source" only adopts the new source while actively mapping the matching file (never from a completed import or the data-sources list), and `resetImport` ("Import another file", Cancel, undo) clears the selection so the next file returns to the drop-first auto-detect screen. The rule is **explicit pick → show the tag (it confirms which source the dropped file will use, with Change); auto/leftover → no tag**. Keeping the tag for the explicit case is why it stays in the UI even though most imports never show it.

- If header rows start after line 1, surface the detected skipped-row value immediately and offer the raw file as an explicit review step rather than forcing it open by default.

- If the file tail looks like footer or non-transaction data, force the user to review it before continuing.

- True validation errors should open the raw viewer as well; do not bury them only in summary counts.

- If a file already carries meaningful categories, the import mapping screen should let the user use the categories present in the data so imported transactions can keep those categories, missing categories can be added under `Unassigned`, and the file can contribute to system-wide rule suggestions.

- Controls for using categories present in the data should support partial filtering by owner and by unassigned-account bucket without changing which rows are imported. The scope changes only how imported categorization is applied and learned from.

- Organizing imported categories out of `Unassigned` should use the dedicated left-column/right-column workspace from Import / Export so users can sort categories into groups in bulk without working through the general category editor. There is a **single** organize surface — the system-level "Group Imported Categories" workspace, seeded from the live `Unassigned` leaves — not a per-source or per-batch variant. The left column is the pool of unassigned categories; the right column is the group layout.

- The workspace's right-hand group column is a draft, but it must always reflect the *live* top-level groups: groups created (or renamed/removed) on the Categories page after the draft was first seeded have to appear as drop targets. The draft is reconciled against the current category tree on open — new groups are surfaced, deleted groups drop out, and any categories the user had sorted into a now-deleted group return to the inbox rather than vanishing. A draft must never present a frozen, stale set of groups.

- **The Group Imported Categories workspace is a temporary landing spot for *imported* labels only.** Its columns show only pending imported categories (`import_pending = 1`) — never user-created categories, and never a category that has already left. A label leaves the workspace **permanently** the moment it is organized into a group or deleted; it never returns, even if it later ends up back under `Unassigned`. (So a user-created category, and a deleted-then-recovered one, live under `Unassigned` on the Categories page but do not reappear here.)
- **Set aside is parking, not deletion** — keep the two distinct. Parking a pending label in the Set Aside list (drag, or the "set aside" button) moves it out of the "needs sorting" pool but leaves the category fully **active**: its transactions keep it and future imports of the label still categorize to it, and it may stay parked forever. Set-aside and group placement are draft edits committed together on **Apply** (so the workspace's undo/redo covers both); on Apply the parked labels get their `set_aside` flag set (and anything restored to the pool or organized into a group is un-parked). A set-aside category is **never** shown in the Categories page "Inactive" list — only deleted categories are.
- **Delete** is the separate, explicit way to remove a category (a "delete" button + a "Delete…" item menu in the workspace, and the Categories-page delete dialog). It deactivates the category (its transactions clear or reassign), moves it to the "Inactive" recovery list, and suppresses the label from future imports. **Recovering** from "Inactive" returns the category to **the group it was deleted from** (or `Unassigned` if that group is gone) as a permanent system category — never back into the workspace. The workspace's Delete clears the transactions (they keep their imported label); use the Categories-page delete dialog when you want to reassign them to another category instead.

- **Two windows arranging the same draft are told, not overwritten.** The workspace draft is one shared record, so when a save is refused because another window or member saved first, saving stops and a dialog asks whether to keep this arrangement or load the other one. It has no dismissal, because each way out discards one of the two. A save that fails for any other reason is shown and retried with the next change; an Apply the server refuses changes nothing, reloads the tree, and says why. See `architecture.md` → Organize / inactive surface.
- The Import-page actions for organizing imported categories and generating rules should show the remaining actionable count. A set-aside (parked) label stops counting as still waiting without being removed.

- Mapping screens should allow partial completion when that is a valid workflow.

- The column-mapping field section should be shared between the import preview and saved data source editing so suggestion pills, required states, and account mapping behavior stay aligned.

- **A data source declares how far it lags its bank, as a plain day count.** The data-source editor's *Days this source lags the bank* field writes `csv_import_profile.terminal_window_days` (see `data-model.md` → the terminal *window*); it is the one dedupe knob exposed to the user, because it is the one fact only the user knows — whether a source relays another system's records (a bank, a budgeting app: the default of 7) or publishes its own (a store, a payment service: 1). It is deliberately framed as a **property of the source**, not as a matching tolerance: the field asks how the export behaves, and the coverage math derives what to do about it. The default assumes a lag, because most sources have one and the error is one-sided — assuming none when there is one deletes a real transaction from the ledger, while assuming one that isn't there only costs a reconciliation pass. Both ends are clamped rather than validated (1 to 30, backend and form alike) — 0 would push coverage past the source's own last date, and a value large enough to matter at the top end has already stopped doing anything useful. The setting is editable after the fact and patches independently of the rest of the form, since the right value is discovered by watching a source miss things rather than known when it is first saved.

- Recent-import file cards may use the same small `↗` detail affordance used elsewhere in the app to open a file-scoped ledger view of the transactions imported from that file. The same `↗` marks the other count pills that open a report (rejected rows, duplicates), so a pill that drills into a report is visually distinct from a static label pill (the account chips, which only describe what the file contained). Reuse the `↗` rather than restyling the whole pill; the glyph is the shared "opens a report" signal.

- **A data connection's history row speaks in cards and syncs, not files.** Its cards are one initial import plus one per transaction month (`data-model.md` → Sync import cards), so the collapsed row carries no "N imported files" count — how many months there are says nothing worth reading — and its recency is **Last synced** (`connection.last_synced_at`, exposed on each card as `connection_last_synced_at`), which also orders the row among the others. The newest card's `imported_at` is the wrong clock: it is when that card was created, and a monthly card keeps receiving rows for weeks after. A disconnected row shows neither, its sync record having gone with the connection. The card actions and tooltips likewise say "this card" rather than "this file".

- **Marketplace accounts get their own import surface, not the generic mapper.** A *marketplace* account — a shopping venue whose purchases arrive itemized through a dedicated importer (Amazon today; marked by `kind: 'marketplace'` in `lib/accountTypes.js`, see `architecture.md` → "Marketplace accounts — the extension pattern") — is deliberately **omitted** from the generic CSV import page: its type is not offered when creating an account, and its accounts are not offered when mapping a file, because those accounts are filled by their own flow rather than by pushing a CSV onto them. To keep the generic path frictionless anyway, a file dropped on the CSV importer is header-sniffed and, if it is a marketplace export (e.g. an AZAD Amazon file), routed to that vendor's tab with the file preloaded instead of forced through column mapping. A PayPal statement (a PDF, or a zip of them) is routed the same way by its name, to the statement import dialog — PayPal is not a marketplace, so its statements land under the PayPal data source with its CSVs rather than on a tab of their own. The dedicated tab is also the natural home for the vendor's setup help (how to produce the export). In the recent-import history these imports **group under their vendor** (an "Amazon" entry), driven by the batch's `source_kind = 'marketplace:<vendor>'` marker, rather than falling into the generic "unknown data source" bucket — and, since they are not CSV-profile imports, they carry no "assign to a data source" / "save as data source" affordances.
  - **File cards order by data recency, not import time.** Each marketplace file is its own card (per-file batching; see `architecture.md` → Amazon order import contract), and the vendor's cards are sorted by the period each covers (where its span starts), newest first — so a one-shot historical drop of many years reads the way it would have if each file had been imported as its purchases happened, instead of by import time (which ties for a single drop). This began as a marketplace-only rule and is now how the whole import history orders, through the shared `byCoverage` on each card's recorded span (see the recency-window pattern above). The collapsed vendor row's "Last used" stays the most-recent *import* time, not the period covered.
  - **Open question — a second marketplace vendor.** With only Amazon there is a single "Amazon" tab. When a second vendor (AliExpress, Temu, …) lands, the intended shape is one **"Marketplaces"** tab that hosts the vendors as either stacked sections or inner subtabs that flip between them, with the last-viewed vendor remembered (session-scoped, like the outer Import / Export tab). Choose the section-vs-subtab form when the second vendor actually arrives — noted here so the tab name and structure are a deliberate decision, not an accident of there being one vendor today.

- **A sync's status line reports what arrived, never a skipped total.** The sync panel's finished row and the Connections tab's result box say `N added, N updated` or `nothing new`. On a routine sync `skipped` is almost entirely rows already held — each sync re-asks for recent days on purpose — and the rest are the user's own choice (an account mapped to skip), already flagged elsewhere (the "N to map" badge), or declared adapter policy (zero amounts). A bare "14 skipped" beside "0 added" read as a failure and only raised questions; the per-bucket breakdown stays in the sync log, where someone investigating looks.

- **A connection card says what the last sync *did*, not only whether it failed** — and it says it in the *same form* the Import/Export history card uses, because the two answer the same question and a user reads them minutes apart. `Last sync` + an outcome pill (`Failed` / `Success · check the log` / `Success · more history to fetch` / a muted `Success`) + the row total, then a row of **`SourceAccountChip`s** — the component extracted from the import card so the two cannot drift, carrying the ✓ / − / ✕ vocabulary that already distinguishes "got rows" / "got none" / "skipped". Chips are driven from the accounts the connection *offers*, not from what landed, so **an account that received nothing still appears**; that is the row the whole thing exists for, and any breakdown built from imported rows structurally cannot contain it. A chip's number is rows **seen** for that account — `added` plus the two no-destination buckets — which is what an import card's chip has always meant, so `✕ Some Account 35` reads the same on both. Feeding it `added` alone let the *shared* component mean two different things on the two surfaces: a skipped account showed a bare `✕` here and a counted one there, leaving the connection card unable to say how much data a skipped account was turning away, and leaving a reader to mistake the count of `✕` chips for the "No destination" total when the two happened to agree. Only the two no-destination buckets join `added`, never the whole `skipped` total — they arise solely for accounts with no local account, so the routine already-held and zero-amount skips cannot flip a mapped account's `−` into a `✓`. **One `OutcomeChip` remains**, for rows reported already-imported on a first import, and it deep-links to the sync log. A second one totalling rows with no destination was removed: those counts now ride on the `✕` chips themselves, per account, which is both more informative and unambiguous — a lone total sitting beside a row of `✕` chips reads as a count *of* them whenever the two happen to agree, which is exactly how it was misread. The pill's wording names the effect on the user's data rather than the mechanism (`incomplete` reads as "more history to fetch", not "budget paused"), and the outcome is decided server-side by `sync_outcome` (`services/providers/config.py`) at sync time and stored on the connection — so the card survives the sync log being cleared, and the card and the log still cannot disagree about one call because both are written from the same recorded facts. The labels name the **result rather than the action**: rendered straight after the words "Last sync", `Synced` and `Sync failed` said the verb twice and left the reader hunting for a time where a status actually was.

**Where the two halves of that now live, after the configuration/operation split.** The per-account chips are the sync's own work product, so they sit with the sync: on the Import / Export connections card, behind a per-connection disclosure (short by default, since that card shares a row with the file importer), and on the import card the sync wrote, which renders the identical chips. The Accounts configuration card keeps only the outcome and the row total, plus a **relative last-synced line** beside the connection name (`LastSyncedLine`, absolute time on hover) — because "Success" alone cannot distinguish a check made thirty seconds ago from one made last week, which is exactly the question the Sync button next to it raises. Carrying the chips there as well had the card showing **two lists of the same accounts** — the provider's and the local ones — which needed a heading to tell them apart and made a seven-account connection about fifteen rows tall. The local-account list stays (it is configuration: what this connection feeds), and so does the list of provider accounts with no destination, which is the one place a skipped account is visible at all. With one list left, the heading that separated them is gone too.

- **A reload keeps what is on screen; a spinner replaces only what is not there yet.** `{loading ? <Spinner/> : rows}` is the wrong shape for anything that reloads: content → spinner → content moves everything below it twice, which is the most disruptive jitter the app produces. The right shape was already in the codebase (`AccountDetail`, `TransactionDetail`, `CategoryDetail`) and is now the rule — `{loading && rows.length === 0 ? <Spinner/> : rows}`, so the spinner is a *first-load* affordance and a refresh holds the previous list until the new one lands. It composes with `useBusyIndicator` for whatever inline "refreshing" hint remains, and it is strictly better than delaying the swap, because it removes the layout change rather than deferring it.

  **Two cases keep the swap, and the distinction is what the old content would be claiming.** Drilling into a *different* view (the Dashboard's group → category drill) has no stale content worth keeping — last level's rows under this level's heading would be wrong, not merely old. **Unless the swap would move the reader:** the Trends tab's drill is started from the averages table at the *bottom* of a long page and reloads every chart above it, so swapping the tab out collapsed the page and landed the reader back at the top. There the old view stays up under `StaleWhileRefreshing` until the new one lands — briefly old figures, dimmed and unclickable, cost less than losing the place — and it stays up **whole**: the drilled group is committed together with its series (`shownTrendGroup`), so the title, the breadcrumb and the category rows' report arrows switch in the same frame as the rows. Committing the group first drew the new level's heading and arrows over the previous level's rows — exactly the "wrong, not merely old" case above — and an arrow clicked there opened a category report for a group. Only the group picker answers at once, since it is the input; and only the newest request may land, so a quick second drill is not overwritten by the first one's slower answer. The tab renders **nothing** (no spinner, no empty charts) until its very first data arrives, since either would flash for a load that is almost always a few milliseconds. And a panel whose numbers answer a question the user has just changed — the Dashboard totals under a new date filter — must not leave the previous period's figures standing as if they were the new ones; keeping those needs a visible not-current treatment, which is what `StaleWhileRefreshing` (`components/ui.jsx`) is: the content stays, dimmed and non-interactive with `aria-busy` set, and a refresh quick enough to be imperceptible does not dim at all. Non-interactive matters as much as dimmed — a click on a stale bar would drill into figures that are already being replaced.

- **A busy indicator is delayed and then held; a raw `loading` flag must never drive one directly.** Most requests here are local and return in a few milliseconds, so a label or spinner bound straight to `loading` does not report anything — it repaints the screen for three frames, which reads as the UI twitching. `useBusyIndicator` (`lib/useBusyIndicator.js`) applies both halves of the rule, and both are needed: **late on** (nothing at all below ~150ms) and **then long enough to read** (~400ms minimum once shown), because a delay alone just relocates the flicker to whatever finishes either side of the threshold. It gates only the *announcement* — never the work, and never `disabled`, which must follow the raw flag so a control stops accepting presses immediately. The case that produced it: the sync log's Refresh button relabelled itself to "Loading…" and back every time a **filter pill** was clicked, putting a twitch on a control the user had not touched.

- **A press looks pressed, and a refresh always answers.** The shared `Button` carries a pressed state (the `ui-button` class in `index.html`, since an inline style cannot express `:active`), so a click is visible even when its action changes nothing on screen; before it, the only sign a press had landed was whatever the action happened to redraw. A refresh is the sharpest case — most reloads here return in milliseconds with the data already showing — so `RefreshButton` turns its icon for at least one full rotation on every press, ending at a rotation boundary rather than mid-turn, and ignores a second press meanwhile. That is a deliberate exception to the rule above and a narrow one: the busy-indicator rule keeps a control the user did *not* touch from twitching, while a control just pressed owes an answer. A load the button did not start still reaches it only through `useBusyIndicator`. An action long enough to be pressed twice with nothing saying the first press started — **Categorize**, which walks every transaction — disables itself for the run and names what it is doing once slow.

- **A refresh is an icon attached to the title of what it reloads.** One `RefreshButton` (↻, its tooltip saying what it re-queries), straight after the title: `PageHeader` and `AppDialog` take it as `refresh`, a Settings section takes it on its header, and a custom header — the detached reports, the Categories *Matching transactions* panel — places it after its title text. It had been a different thing in each place: first in one action row and last in another, mid-row among unrelated buttons, in a report's window chrome, labelled `↻ Refresh` or `Refresh`, or relabelling itself to `Reading…`. The title rather than the action row because a refresh acts on the view the title names rather than on the data, and the leading place in the action row belongs to the page's most common action; at the far right it floated apart from everything it related to.

- **A label driven by a *press* follows a different rule from one driven by a *load*, and the delay above must not be applied to it blindly.** `useBusyIndicator`'s late-on/hold-open shape is right for work the user did not start — a reload, a filter, a background fetch — where showing nothing under ~150ms removes a twitch. On the button the user just clicked (`Saving…`, `Deleting…`, `Applying…`, `Importing…`), suppressing the label for 150ms means a fast action shows **nothing at all**, and whether that is correct depends entirely on the rest of the screen. Ask the one question per site: *does anything else visibly change when this succeeds?* Where it does — the row vanishes, the dialog closes, the list re-sorts — the outcome is the feedback and the label can stay silent. Where the control just sits there afterwards, the label is the **only** evidence the press registered, and hiding it produces the press-it-again bug. Because the answer is per-site, these labels are deliberately **not** part of any blanket flicker sweep. The related deliberate exception is the Dashboard's group→category drill spinner: drilling loads *different* content, so there is no stale content worth holding — the previous level's rows under the new level's heading would be wrong rather than merely old.

- **The sync log filters itself, with multi-select pills.** Opening it from a connection starts it filtered to that connection, and from a provider card to **every row of that provider** — by provider rather than by the card's connection ids, so it takes in what has no live connection to name: a disconnected connection's record and the failed connects. It is also opened unscoped from Import / Export — so the scope is adjustable *there*, rather than by closing it to click a different card. One pill per **subject that has rows in the log** (never the configured list: a pill that filters to nothing is a dead end). A subject is a connection — live, or disconnected and remembered by its disconnect row, labelled *(disconnected)* — or a provider's **connect attempts**, the connects that failed before the provider issued a connection. Each has a real key (`connect:<provider>` for the last), which is what keeps a pill from looking pressed while filtering nothing: keeping rows with the id nulled once merged every disconnected connection into one such pill, since an empty id reads as no filter. Turning off one pill of a provider-wide selection keeps that provider's other pills on, named one by one. What opens the dialog passes a *starting* selection, re-applied only when that set changes, so the page behind it re-rendering never undoes a pill the user turned off. Pills are multi-select because a diagnostic log has a use radio cannot express — *everything except the chatty one* — and **no pill pressed means no filter**, never "match nothing". Each pill carries its row count, which is **rows in the log, not operations ever run**: `connection_sync_log` keeps only its retention window, so the number is a count of what clicking would show, which is the only meaning a filter's count should have. Two rules follow from it being a *filter's* count: it is computed **unfiltered** server-side and shipped beside the rows (counting the filtered set would collapse every unselected pill to zero the moment the first was clicked), and the pill row **replaces** the old "Showing only X" banner rather than joining it — two controls for one filter can disagree, and the banner could only ever report what the deep link had chosen. Filtering stays server-side: the log is bounded but its rows are not small (a deep walk records one entry per request, up to ~3.4 KB a row), so a filtered view has no reason to ship the whole thing — and the read is capped at the newest 200 matches, with the dialog saying so when there were more, rather than reading as the complete history. Anything that exports the visible list follows the same selection — **Copy for support** names the connections it covers, or a support reader assumes it is everything.

- **The sync log row splits "what happened to my data" from "what the sync machinery did".** The **connection sync log** puts the first in an always-visible half and the second behind a per-row **Details** toggle, collapsed always — including on an error row, since what that owes the reader is the error, which sits above the fold. The visible half is an interpreted status line, the counts, the coverage line, where the rows were filed, the error, and bank-level warnings; Details holds the checkpoint/cursor fingerprints and the advisories (what the provider said about our own *request*, which nobody can act on — the log is still their only home, just not their only visible one). The failure this corrects is a routine budget-paused walk rendering as a wall of alarming output because every line carried equal weight.

  **A consumable's level is always-visible, not filed under Details.** For a metered provider the allowance line is the reason the row looks the way it does — a pull that stopped early and one that had nothing left to fetch are indistinguishable without it — so the row states what is left, which buckets ran dry, and when the next request becomes available ("6 of 22 shared requests left · 2 accounts out of allowance · next request in ~1 hr"). Counts are **floored, never rounded up**: this is a spendable figure, and claiming a request the server has not granted is the error that costs a disabled token. Status wording follows from the same honesty — a budget pause "resumes once it refills", not "on the next sync", because a bucket refilling at one token an hour does not care that a sync ran ten minutes later. Which bucket paid for each request, and how far each account reached, sit under Details as the follow-up questions only a stuck connection asks.

  Three rules produce the rest of the visible half. **Status is read from `final_status`, in the effect vocabulary the connection card uses** ("paused on the provider's daily request limit — resumes on the next sync", not `BUDGET_PAUSED`, which is Luma's own marker rather than anything a provider said). The per-page `status_sequence` is deliberately *not* rendered — it holds one entry per drained page, so a walking adapter fills it with one identical value per request, redundant with `final_status` and the `became_complete` badge beside it; its one unique payload is a mid-drain anomaly, a debugging finding, so the raw sequence stays in the **Copy for support** text where that reader already is. **A figure appears once**: the request count lives in the counts line and `windowSummary` does not restate it, since both render `requested_windows.length` and two agreeing figures read as two different ones. **A stored number is reconciled, not just printed**: `days_requested` next to a fetched span is a contradiction a reader has to resolve unaided, so the coverage line states both as durations and names the shortfall ("asked for 10 years, reached 2 yr 7 mo"), and `skipped` is split into the three unrelated events it folds together, rendered as the connection card's own `OutcomeChip`s in the card's own wording — the card deep-links here for the detail behind those chips, so a reader arriving by that link must not meet different words for the same fact. Tone follows the card too: no-destination always reads as a problem, already-imported only where the call cannot account for it. **That judgement is made once, on the server** (`unexplained_already_held` in `services/providers/config.py`), and every surface reads the number it returns: the log row's tone, the connection card's "Already imported" chip, and the outcome pill via `sync_outcome`. It strips the two innocent sources of already-held rows — a connection that has fetched before (each resumption of a metered backfill re-asks for a window it partly holds), and a walking adapter's overlapping pages re-offering rows *this same call* just imported (`skipped_already_held_prior` counts the other half directly rather than recovering it by subtraction). What is left is a first pull being told it already holds something, which is what a transaction-id collision looks like from outside.

  The reason it is computed once is that it was not: each surface re-derived it from `mode`, and since `mode` stays `initial` for every call of a backfill spread over days, a connection resuming normally showed an orange chip beside a correct "more history to fetch" pill and a correctly-muted log row — three readings of one sync, disagreeing on screen. When a judgement is rendered in more than one place, ship the verdict, not the inputs.

  Underneath, `lib/syncLogSummary.js` returns `null` rather than a placeholder whenever it cannot interpret its input, which is what lets a row fall back to the raw value instead of a confidently wrong sentence — for a stalled sync the raw value *is* the evidence. The same rule governs rows predating a column, with a twist worth remembering: a skip breakdown derived from a row that recorded none would report every skip as zero-amount — but so would a *genuine* all-zero-amount sync, since both read 0/0 on the two stored counters. `account_counts` is what separates them (it arrived in the same migration), so its presence is the "a breakdown was recorded" signal and the counters are only ever read once that holds.

- **A running sync stays visible after the page that started it goes away.** The poll loop lives in component state, so navigating away used to lose the indicator *and* re-enable "Sync now", inviting a second concurrent pull; `connection.sync_started_at` is the server's own answer, so the card shows "Syncing…" and the button stays disabled across navigation, a reload, or a second tab. Two things make it work and both are easy to get wrong: it is written **outside** the pull's transaction (`get_db` commits on block exit, and the pull holds one open throughout — a marker written there is invisible until the sync it announces has finished), and it is bracketed by a `finally` and believed only for `_SYNC_MARKER_STALE_AFTER`, so neither a raised sync nor a killed process can leave a connection permanently busy.

- **Name a connect action for the provider, not "account".** `+ Connect SimpleFIN` / `+ Connect Plaid`, from `providerLabel` — what the action adds is a *connection*; the accounts belong to the provider and arrive with it. "Account" already means a ledger account everywhere else in the app, so the old "+ Connect account" named the wrong noun twice over.

- **User-facing copy says *data provider* and *connection*; *data source* means only a saved CSV import profile.** The two once shared "data source", so one word named two different objects on neighbouring surfaces, and a help link on it had no single correct destination. The service (Plaid, SimpleFIN Bridge) and the credentials that unlock it are a **data provider**; one link to it, and what that link syncs, is a **connection** ("accounts from this connection", "reconnect each connection"). Code identifiers and comments still say data-source in places (`DataSourceConnections`, "data-source sync"); those follow when next touched rather than as a sweep. The help topic defining both terms is `data-providers`.

- **Data-source sync cards group by connection, in two homes.** A sync's rows land on a `connection_sync` `import_batch` (see `data-model.md` → "Sync import cards": one **"Initial import"** card for the first backfill, then **monthly** cards), so in the recent-import history they group under a **per-connection row** (its cards as the expandable batches), distinct from the marketplace and "unknown data source" buckets, driven by `connection_id`. The per-connection row shows the **institution** as its headline (from the connection's own `institution`, not parsed out of a card filename) with a muted **"{Provider} connection"** cue beneath it (e.g. "Plaid connection"), so two connections at the same institution stay distinguishable; the same provider surfaces on a transaction's origin hover, whose source line is labeled **"Source"** (not "Source file" — a connection isn't a file) with a **"Connection: {Provider}"** row, letting a synced row be traced back to which connection produced it. Both are fed by `connection_provider`/`connection_institution` (batch listing) and `import_batch_provider` (transactions query); the frontend `providerLabel` maps the raw key to a display name. The provider is written onto the card itself (`import_batch.provider`), so a row whose connection has since been removed still reads **"Connection: {Provider} (removed)"** rather than losing the line. These rows are read-only records — no rename / description / "assign to a data source" / **Undo** affordances (a sync is not an undoable file event, and the cursor has advanced past the rows so a deletion isn't auto-recoverable) — but they carry the same per-card duplicate/needs-review pills as any import card, so a cross-source duplicate opens the standard `UnifiedDuplicatesDialog` unchanged. The **second home** is the Accounts → Connections tab: each connection shows a **"⚠ N to review"** badge when its sync cards hold unresolved suspects, jumping to the Import/Export history to resolve them — the same "route to the card, not a global cross-batch view" model the duplicate task uses.

- **The Connections tab drives sync with a client-driven completion poll.** Connecting a bank **auto-syncs** it (scoped to the new connection), and Refresh/Sync do too, via `syncUntilComplete`: it calls `/sync` repeatedly until the response reports the historical backfill is done (`transactions_update_status` → `historical_complete`), showing "Importing history… N so far" between polls — so the provider's async backfill is pulled to completion **without a webhook**, and a fast connect no longer races a slow backfill (the earlier "connected but history looks short" trap). A **"New connection fetches"** window `<Select>` (persisted as the `connection.historyDays` user preference; 0 = all available) sets the initial fetch depth (`days_requested`); routine "Sync now" pulls cursor deltas and never narrows it. Each connection also carries a per-connection **"↻ Refresh accounts"** — rebuilds its account rows from the still-valid credential (no re-link) then backfills — the one-click recovery when a restore rolled the ledger back but kept the (never-backed-up) connection, leaving accounts whose sync skips every row for lack of a match.

- **An action that needs the vault open prompts for the passphrase and then carries on — it is never disabled for being locked, and never asks twice.** Every such action on the Connections tab (connect, sync, fetch more history, refresh accounts, disconnect, revealing or saving an app secret, and the post-connect/post-mapping history pull) opens with `await ensureVault()` from the shared gate in `lib/useVaultGate.js`; the passphrase dialog resolves that promise and the action continues *in its own call frame*. The earlier shape — open the dialog and `return` — dropped the action, so every gated button took two presses, and it is the failure mode this pattern exists to prevent: a gate that ends an action rather than suspending it will always cost the user the second press. Two corollaries. **A locked vault must not disable a control**: what disables is only what no dialog on this page can clear (missing HTTPS on a networked bind, or a vault this user holds no slot in) — otherwise a locked vault greys one affordance while its neighbours stay live and prompt, which is the state that made the tab read as arbitrary. And **a 423 is the same gate arriving late**, not a failure to report: the client's "unlocked" is a cached answer that a backend restart or the idle timeout invalidates underneath it, so the response re-prompts (`ensureVault({ force: true })`) and re-runs the action. Where the prompt sits within a flow is a judgement about commitment, not mechanics: Disconnect asks *after* its confirmation (a passphrase is only worth requesting once the user has committed, and the confirm dialog stays open beneath the prompt so backing out returns to the decision), which is why the passphrase dialog renders above the standard dialog layer.

- **Connecting a bank has an account-mapping step, and it is required before the first backfill.** `ConnectionAccountMapDialog` (`components/accounts/`) opens after Link and is the CSV import's account grid — the same columns (`Account from provider → Maps To → Skip`) and, more importantly, **the same question in the same order**. The primary control is one select of existing accounts (`AccountMatchSelect` — possible matches hoisted to the top behind a "Possible" pill, a count on the closed trigger) with a `+New` beside it and a Skip checkbox; **grouping** is a refinement reached through `PossibleAccountMatchChooserDialog` and shown afterwards as a chip. It **reuses** that picker, that chooser, and the matching helpers in `lib/importExport/importAccountMatching.js`, so both surfaces suggest and classify identically from one implementation. **Picking from the list maps; it does not ask** — that is the whole interaction, and a "Possible match" chip is the same answer in one press for the single-candidate case. The chooser opens from `+New` instead, where creating a second account for something Luma may already hold is what earns a second look; with no candidates `+New` creates in one press, since there is nothing to look at. A candidate always names a group **root**, even when a merged child is what matched the source's label: candidates collapse onto their roots before anything counts them, because merging duplicates a name (the child keeps the name its new parent already has) and counting the pair as rivals both suppressed the suggestion for every account that had ever been grouped and would now list one account twice. `lib/connectionAccountMapping.js` holds the pure row-state ↔ mapping-mode translation (unit-tested for round-trip, since a reopen that restated a mapping would trigger a spurious duplicate re-scan).

  A first version instead led with a dropdown of the backend's mapping modes. **Don't reintroduce it**: it exposed the data model rather than the decision — grouping is a subtlety most mappings never need, so promoting it made every row look like a decision, and it asked the user to classify a relationship before naming the account it was with. Grouping earns its place in the chooser for a different reason: it is the same end state as creating the account and then merging it on the Accounts page, so offering it here collapses two steps into one. Two differences from the CSV grid are deliberate and should survive any later unification: connection `skip` is **remembered** (it stops "Refresh accounts" recreating a rejected account, where a CSV's skip is per-import), and a row whose account has *already been created* by an earlier save shows that account rather than a name/type editor, because the mapping call only names an account it is creating and the editor would offer edits it ignores.

  Ordering is the point: the historical pull runs only once the mapping resolves, because an unmapped provider account has nowhere to sync into and the mapping is what gives dedupe its cross-account alias — mapping after the backfill would mean the first and largest batch of rows is the one batch that never got the benefit. The same dialog reopens from the connection card's **"Connection settings…"** menu item as a plain edit (no backfill) — and it takes a different title in that mode, because reopened from the card it is a settings surface covering both the mapping and the captured-fields picker below, where post-Link the mapping genuinely *is* the whole job. An unmapped count shows as a **"N to map"** badge beside the existing "⚠ N to review".

- **An account-mapping picker offers roots, and carries a merged child only to render a mapping already on one.** A mapping — a connection's `connection_account`, a data source's single `account_id` — points at the account the user chose, and **merging that account into a group does not move it**. A picker built from top-level accounts alone is therefore missing precisely the accounts whose mappings are still in force: the stored id matches no option, the control renders empty, and a live decision reads as an absent one. That failure is worse than cosmetic, because the obvious repair — picking something from the list — silently re-points the mapping and strands the history already ingested under it. So these lists are fetched with `include_children: true` and passed the unfiltered set (`activeAccounts`, not `rootAccounts`), then narrowed for display by `selectableAccountOptions` (`lib/importExport/importAccountMatching.js`): roots, plus the one child the current value names. The narrowing is the other half of the rule and matters as much as the inclusion — offering *every* child doubles the list with entries indistinguishable from their own parents, because merging rewrites a child's display name to its parent's ("PayPal" merged into "PayPal"). On the child that does appear, `getAccountOptionLabel` appends "— in &lt;group&gt;" so it cannot be mistaken for the root beside it. The deliberate cost: a mapping can no longer be *newly* pointed at a merged child from the UI. That is the right trade — the group root is equivalent for dedupe scope and reporting, and choosing a child was never a considered act — but it means unmerging is the path if one is ever genuinely wanted. Applies equally to the connection card's own account list, whose empty state must distinguish "no provider accounts pulled yet" (→ *Refresh accounts*) from "pulled but undecided" (→ *Connection settings…*) — one message for both sends the second case to a control that cannot help it. Both messages name the **⋯** menu the two now live in, since neither is a visible button any more.

- **The field picker says what a connection captures, with the dedupe-critical fields locked.** A "Fields captured from this source" section on the same dialog mirrors the CSV evidence-column picker. Fields the adapter marks `locked` render **checked and disabled with a tooltip explaining why** rather than being hidden: hiding them would misrepresent what is stored, and making them togglable would let a user silently disable duplicate detection. Optional fields are free choices. The setting applies to **future syncs only** — it changes what is captured, not what was — which is stated in the dialog rather than left to be discovered.

- **"Import anyway" is an answer, and no later pass may re-ask it.** Forcing a held-back duplicate in tells the app that this row is not a duplicate of the transaction it was rejected against — so the post-import cross-source sweep excludes exactly that **pair** (`mark_import_suspects(exclude_pairs=…)`, fed from the `matched_transaction` the rejection recorded). Excluding the pair rather than skipping the row is the whole design, for two reasons. A forced row is an ordinary transaction that may well duplicate something *else*, and the import-time sweep is the only pass that ever compares it **backward** against rows that already existed — the merge-time scope scan reaches pre-existing pairs only inside a group that a merge or a mapping actually unified, so a row skipped here and never merged is never compared at all. And the exclusion *un-masks* that other match: selection keeps at most one match per new row, ranked strongest-text-then-closest-date, and an overridden pair is byte-identical and same-day, so it outranked and hid every other candidate. The promotion half of the sweep is **not** run on this path at all — it trashes what it promotes (`duplicate_confirmed`) and promotes same-account pairs as readily as cross-account ones, so it would trash the rows the user just insisted on importing, in the same request that imported them.

- **A connection card offers no "check for duplicates" action, deliberately.** Detection already runs at every moment that can change its answer, so a manual trigger has nothing to catch up on: applying a mapping re-judges the rows already in the ledger (that decision is worth nothing until it does, and making the user find a second button afterwards would be a trap), a sync sweeps its own card, a CSV import both reads the connection's coverage in its ladder *and* sweeps its own batch, and an account merge scans the newly-unified group. The one thing a standalone pass still did was change **which side** of an already-visible pair got flagged — removing the connection's older copy instead of flagging the file's newer one — and that is not a choice worth a control on the card. So the card's actions stay the ones that are genuinely per-connection — **Connection settings…**, **Fetch more history**, **Refresh accounts**, **Remove synced transactions**, **Disconnect** — and they live behind one **"⋯"** (below). A duplicate a user does need to act on reaches them where duplicates already live: the **"⚠ N to review"** badge on the card, linking to this connection's sync cards in the Import / Export history.

- **A connection card's actions live behind one "⋯", because state should outrank maintenance.** Five permanent buttons per card is a screenful at seven connections, and because the row wrapped at a point set by the institution name's length, no two cards broke in the same place. Worse, it inverted the card's own priorities: the actions are real but rare, while the **"⚠ N to review"** / **"N to map"** badges — the part actually asking for something — carried equal or less weight. The rule the card now follows: *what is actionable now stays on the surface; what is merely always possible moves into the menu.* Deleting affordances instead was the first thing considered (and is usually the better answer) but none survives it — Refresh accounts is the post-restore recovery, Fetch more history is occasional-but-real, and Connection settings… is the only way back to a mapping once its badge is gone. Rare-but-necessary is what a menu is for. That item's name is deliberately broader than its main grid: the dialog behind it also holds the captured-fields picker, so a label naming only the accounts (**"Accounts…"**) covers half of it and leaves the other half undiscoverable. Two alternatives are rejected. **"Manage source"** — *data source* names a saved CSV import profile, which has its own editor, so the label would point at the wrong object. **"Configure…"** — the provider card one level up already carries a **Configure** button for the app credential, and two identically-named controls at different scopes on one screen is worse than a vaguer word. *Connection settings* names the scope exactly, in the vocabulary the tab already uses ("N connections", "Disconnect"). The trigger is right-aligned so it lands in the same place on every card, and in-flight work ("Fetching…" / "Refreshing…") shows beside it, since the menu that started the work is closed while it runs.

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

- **Import profile/filter:** source of truth for provider-level reusable mapping behavior

- **Local draft:** fallback only for the no-profile/manual case

When a profile matches, it should carry reusable import workspace state, including:

- column mapping

- account mapping and skips

- category mappings

- collapsed/open bucket state

The local draft must not override a matched profile. It exists only so a manual/no-profile import session can resume later if the next file is still compatible.

**Continuing past the header warning applies the source whole, mapping included.** The warning fires
when a file's columns are not the ones the source recorded, which is nearly always the same export
with a column added — the same data source, not a different one. Continuing used to re-infer the
mapping from the file, so the account assignments and column picks the source exists to hold were
discarded while its name stayed in the header, which reads as applied and is not. "This is the wrong
source" already has its own exit: *Change data source → Skip* takes a temporary draft with an
inferred mapping. **A stored column the file no longer carries is the one thing dropped** — the
picker renders a mapped value verbatim, so restoring it would name a column that is not there and
read blank cells from it; cleared, the field falls to the suggestion engine, and the mapping
screen's column-change notice says why it went empty. Suggestions are built from what is actually
mapped afterwards, not from what the source stored, or a field just cleared reads as mapped and is
offered nothing. **The drop is for this file, not for the source**: saving the source after the import
keeps a stored mapping whose column the file did not carry (`keepMappingsForAbsentColumns`), since a file
without a column says nothing about it — typically an export from before the vendor added it. Taking the
file's empty field instead would let one older file quietly un-map a transaction-ID column, and every
later file would arrive without ids until someone noticed. A column the file does carry is the user's to
clear.

### Sections on the transaction detail panel

`DocumentsPanel`, `PurchasePanel` and `ReimbursementPanel` are the family, and they portion two rules and
diverge on a third that is worth understanding before a fourth is added.

- **A section renders only where it has something to say.** An always-present empty frame would sit on
  every row in the ledger to serve the handful it applies to. What "something to say" means is the
  divergence: the purchase panel needs *two* rows to have been grouped, so an ungrouped row gets
  nothing, and the realization that two payments belong together happens in the ledger where the bulk
  action lives. A receivable is different — money allocated to the `Reimbursable` group makes that one
  row a receivable on its own, and the gap between the purchase and the repayment is the state a
  reimbursement spends most of its life in rather than an unfinished step. So that panel speaks for an
  unlinked row too. The test is whether the row *by itself* already carries the state.

- **The panel is a summary; the editor is a dialog.** The dialog exists so a ledger row's marker can
  open the same one, and a row has nowhere to inline an editor — so an inline second implementation
  would be two editors for one thing, which is the drift this repo keeps rediscovering. The dialog
  portals to `<body>`, which is load-bearing rather than tidy: a `position: fixed` overlay mounted
  inside a table stacks against whatever ancestor established a containing block, not the viewport.

  It follows that **a record's terminal action lives in the dialog and nowhere else.** Putting
  *complete* on the row's right-click menu was proposed and rejected: the dialog already holds the
  guards, the write-off path and the copy that says what the click will do to an earlier month, and an
  action that ends a record while moving money between categories must not be reachable only by a
  gesture nobody discovers by looking.

- **The change-report callback must be a stable reference.** Each panel reports its record so the host
  can patch the ledger row without refetching the page, and the host re-renders on that report. A fetch
  effect that depends on the callback therefore refetches on every report and loops between loading and
  loaded — silently, and forever. Hold the callback in a ref and depend on nothing but the id. Test it
  with a deliberately *unstable* callback, since a stable `vi.fn()` passes against the broken version.

### A stored convention is never a question for the user

Amounts are stored with `amount > 0` meaning money *out* and displayed the other way round everywhere.
Any form that collects an amount therefore takes a **magnitude plus a direction control**, derives the
stored sign, and **shows the derived figure back** before saving — "Will be recorded as -$12.50" beside
the amount box on manual entry, the running expected total on the purchase editor. Two rules fall out
and both are load-bearing:

- **Never ask for a signed number.** Getting it backwards inverts half of what people enter while
  looking entirely plausible on the way in, and the mistake is invisible until a report is wrong.
- **Echo the inference rather than trusting it.** A derived value the user can see is a value they can
  correct; one they cannot is the app quietly deciding something on their behalf.

Where the direction is a control on screen, a sign typed into the amount box is ignored in favour of the
control — a stray "-" beside a toggle that already says "Received" is a typo, not a second opinion.
(`signedExpectedTotal` differs deliberately: it edits a stored figure with no direction control beside
it, so an explicit sign there is a real instruction.)

### Let the accent say which action is actually the right one

Where a dialog offers a terminal action beside its ordinary save, the accent moves to whichever is the
right answer for the record as it currently stands — it is not fixed to one button. A reimbursement
whose two sides balance accents **Complete**, because there is nothing left to decide; one with money
still unaccounted for keeps the accent on **Save**, because closing it is a judgement the user may not
want to make on this visit. The order stays put (Cancel · Complete · Save) so the buttons do not move
under the cursor; only the emphasis changes.

Where the terminal action is *possible but rarely what is wanted*, the emphasis is the discouragement —
not a block. Completing a reimbursement nothing has been repaid against is a real outcome (sometimes
nobody pays you back) that would be denied outright by greying the button, which was the first attempt
here and is the same withheld-capability mistake this repo keeps recording. What makes it safe instead
is that it is never the accented button, that the panel it opens states what it is really claiming — the
*whole* amount recorded as spending, not "the rest" — and that it cannot complete without a category
being chosen for the money. Two deliberate steps and honest copy do the work a disabled control was
being asked to do.

### Name what a reclassification will change, before the click

Where an action moves money between categories and a *previous period's* figures move with it, the
control says so where it is — not in a confirmation after the fact and not only in the Help topic.
Settling a reimbursement is the case: a shortfall settles onto the original expense, so February stops
saying one number and starts saying another. That is correct and deliberate, and it is also exactly the
kind of change that reads as a bug when it is discovered later rather than announced beforehand. The
sentence sits beside the button and changes with the direction of the residual, because a surplus does
*not* touch the earlier month and saying so is equally part of the explanation.

The same rule tells the surface what **not** to ask. Which side a residual settles against is decided by
its sign, so it is never offered as a choice — the user has no way to answer it correctly and an answer
that disagreed with the ledger would be a second truth. Only genuinely user-owned questions are asked,
and only when they are live: *which* expense fell short, and only when there is more than one.

## Ownership and tag-driven reporting

Ownership applies only to **accounts**. Categories and groups do not have owners; the dimensions a user wants to report by — personal/shared, essential/discretionary, business/personal, and similar — are expressed through **tags**, applied at whichever level fits:

- a tag on a **transaction** marks just that row (manually or via a rule)

- a tag on a **leaf category** marks every transaction in that category

- a tag on a **group** marks every transaction in any of the group's leaves

Tag attachment is additive: a transaction's effective tags are the union of its direct tags, its category's tags, and its category's parent group's tags. The dashboard "tag report" picker breaks the period down by user-selected tags, with combination wedges for transactions that match more than one selected tag and a synthetic "Other / Untagged" wedge for the rest.

**A tag is a reporting dimension, so writing one invalidates aggregates** — the tag report's own wedges, and, whenever the filter bar carries a tag, every other figure on the page, since the tag is what scopes those queries. Tag writes therefore go through `txnMutations.setTag` like the categorization writes, not `api.updateTransactionTag` (lint-guarded). Leaving one surface on the raw call is what let a tag removed from inside a drilled transaction panel leave an entire tag-filtered dashboard counting a row that no longer matched the filter: the row patched correctly everywhere it was *displayed*, and nothing re-queried a total. The same holds for the open `TagDetail` panel's header, which states the server's bucket for its wedge so the panel and the pie agree — it re-reads that wedge from the refreshed rows (`liveTagSignature` in `Dashboard.jsx`) rather than keeping the snapshot it opened with.

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

- **Clamp a panel's size on the way out, never back into the state that holds it.** The size a user asked for and the size the viewport can currently honour are two different numbers, and storing only the second one is lossy: the first window resize that narrows the viewport overwrites the request, and widening it again has nothing left to restore — the panel is stuck small until the user resizes it by hand. `useDetailPanelChrome` keeps the requested size in state, records the *viewport* on resize, and derives the rendered size from the two, so a panel gives room back as the window shrinks and takes it straight back as the window grows, never past what was asked for.

- **Gesture and reveal state stay off the consumer's render path.** Drag and resize are driven imperatively by `useDetailPanelChrome` — refs + direct-DOM writes (panel `left`/`top`, `user-select`, and a `<body>` grabbing cursor) plus window listeners attached on gesture start — and touch React state only once, at gesture *end* (drag commits the final `setPos`; resize reports via an `onGestureEnd({pos,size})` callback the caller uses to persist geometry). The hook deliberately does **not** return a `dragging`/`resizing` flag. It used to, and every consumer subscribed to it, so merely *starting and ending* a gesture re-rendered the whole panel body twice per header interaction — on the duplicate-detection report (thousands of rows) a single click on the `×` cost two multi-second full re-renders. The rule generalizes: transient UI state (drag/resize/hover/active) that only drives cosmetics must never live in a hook the heavy panel subscribes to — keep it in refs + direct DOM, or isolate the body behind a memo boundary. The reveal path applies the same instinct in reverse: `usePanelReveal(panelRef, dataReady)` holds the panel at `opacity: 0` (laid out, so it still measures) while its body reflows on open — async chart/list loads, the chart's second measure pass, and the resulting position clamp — then flips `revealed` true once a `ResizeObserver` sees the geometry hold still (hard-cap fallback so a slow body still appears), so the panel fades in fully formed instead of visibly growing and jumping.

- **Stacking and click-to-focus.** Z-index is managed by a single app-level registry in `frontend/src/contexts/PanelStackContext.jsx`. Every `DetailPanelShell` claims a slot via `usePanelStackSlot` on mount; the slot returns its current `zIndex`, an `isTopmost` flag for header styling, and a stable `bringToFront` callback. Clicking anywhere on a panel surface (`onMouseDownCapture` in the shell) lifts that panel to the front of the stack — works across panels rendered in different parts of the tree (e.g., the App-level duplicate-detection dialog and route-mounted batch/account/month panels coordinate through the same stack). Re-opening the same target focuses the existing panel rather than spawning a duplicate; if the target's payload differs from the existing panel's payload (e.g., the duplicate-report drill-through opens the same batch with vs. without a date filter), the existing panel's payload is replaced rather than ignored, so the second click reflects the new parameters.

- **A list panel fills the window; a chart-plus-list panel sizes to its content.** A panel whose body is one long list (`PeriodDetail`) passes `fillHeight` to both the shell and the table, so it takes the whole height the viewport allows and hands the leftover to the rows. Without that it cannot answer an enlarged window at all: a bounded list inside a content-sized panel is only ever as tall as the pixel cap it was handed (`DETAIL_LIST_MAX_HEIGHT`), so the panel's own viewport-relative max-height rises and nothing grows to meet it — and drag-resizing the panel taller just adds dead space under the table. Filling requires a *definite* panel height, which is also what lets the inner list resolve a percentage height and keep its own scroll — and the scroll has to stay with the list, since that is what drives its paging (an outer scroll would break infinite loading). The cost is empty room under a short list, which is why the panels that stack a trend chart above their list keep the fixed cap: there the cap is also what balances chart against list.

- **A panel may open another panel.** A detail panel's inner transaction list can itself open a further detail panel — e.g. the merchant `↗` in `AccountDetail`'s month list opens the payee `TransactionDetail` (for the per-transaction origin/source info). It is hosted as a *child* of the opening panel, not by the page, so it lights up wherever that panel appears without per-page wiring and closes together with its parent; the shared stack registry still gives it its own z-order slot, so it stacks and focuses correctly despite being nested in the tree. Edits made in the child reconcile back into the parent's list. The deliberate trade-off is lifecycle coupling (closing the parent closes the child); use page-level sibling hosting instead when the opened panel must outlive its opener.

- **Merged accounts surface their underlying sources.** `AccountDetail` for a *merged* account spans every underlying (source) account, since the report scopes by the **effective** account (`account_ids`, which resolves children → parent through `COALESCE(parent_account_id, account_id)`). To keep the merged children legible it adds, only when the account actually has children, a **source-account column** (the row's original account, from the always-returned `source_account_raw_name` — distinct from the effective-account `account` column, which is identical for every row here) and a **multi-select source-filter pill row** above the chart (no pills selected = all sources). The filter narrows both the trend chart and the transaction list, server-side, through a separate **`source_account_ids`** query param that filters the raw `t.account_id` rather than the effective account — the one filter that *can* isolate a single child, since every row in the report shares the same effective parent. It rides the shared transaction-filter builder, so the list feed, the monthly-trend endpoint, and bulk "select all matching" all honor it identically (a standalone account shows neither the column nor the pills).

- **Edits inside a detail panel must reconcile back to whoever opened it — through one callback.** `TransactionDetail` (and the other editable drawers) only mutate their own local copy and the backend; the *host* is responsible for patching its on-screen row(s). The panel reports every edit through a **single** `onReconcile(txnId, patch | null)` prop: the panel computes the changed fields (`patch` — category set, notes, tags/blocked-tags), or passes `null` when the row was trashed and should drop. The host merges the patch into its row(s) — almost always via the shared `makeRowReconciler(setRows, { onRemoved })` builder in `lib/txnMutations.js`, which does the id-match map (or a filter + optional count decrement on `null`). This one-callback shape is deliberate: adding a new reconciled field changes only the patch the panel emits, so **no host has to change** — the whole reason it replaced the previous four separate callbacks (`onCategorized`/`onNotesSaved`/`onTagsChanged`/`onTrashed`), where every new field rippled to ~10 hosts. A host that holds the same row in more than one place patches all of them in the one callback (the Dashboard's `reconcileDetailEdit` fans a single patch out to its two drill tables *and* its open-panel `txn` copies). A host whose rows live in nested state (`Transactions`' `{ transactions, total }`) or that needs an edit-specific side effect passes its own `(txnId, patch)` function of the same shape instead of the builder. A host that skips `onReconcile` leaves the page behind silently stale (old category/tag shown while the panel shows the new one, and reopening re-passes the stale `txn`).

- **Dismissal.** Panels close on `×` in the header or Escape. Escape dismisses only the topmost panel, and the shared chrome (`DetailPanelShell`) suppresses it in two cases so it never destroys more than the user intends: when focus is in a text field (the inline editor reverts its own edit instead, so a half-finished note/name edit is never lost) and when a modal dialog is open above the panel (detected via the `data-modal-overlay` marker on `OverlayBackdrop` — the dialog owns Escape). Escape does *not* require focus to be inside the panel, because opening a panel by click leaves focus on the trigger in the page behind. Backdrop-click dismissal is intentionally avoided so a half-finished edit is not lost to a stray click.

- **Minimize-to-nav-bar — via the shared detached-viewer seam.** Long-lived report dialogs that the user wants to keep open while working elsewhere offer Minimize instead of forcing a close: a `minimized` flag hides the floating panel without dropping loaded data; a nav-bar pill (shared `MinimizedReportPill`) shows the dialog's title plus an attention count; clicking it restores the panel at its prior position/size. The state machine is the shared `useDetachedReportViewer` hook (`lib/useDetachedReportViewer.js`) — open/reload/close/minimize/restore over an envelope the report's own App-level context wraps (state must live above the route tree so the dialog survives navigation). Four consumers use it: the duplicate-detection report (`UnifiedDuplicatesViewerContext`), the reconciliation reports (`ReconciliationViewerContext` — one viewer for every vendor, since only one report is worked at a time), the Amazon import-detail report, and the running-sync status panel (`SyncStatusContext`); a new detached report should be a fifth wrapper, not a bespoke context, and a new reconciliation report is a vendor of the existing one.

- **A long *operation* uses the same seam as a report, with three differences.** `SyncStatusContext` is the reference: a data-connection sync runs for minutes, and since the backend stopped holding its write transaction across provider calls the user is meant to keep working through it, so the panel is non-modal (`AppDialog`'s `draggable` mode — a click-through backdrop, not the heavier `DetailPanelShell`, which is for reports the user works *inside* rather than glances at) and stashes to a pill whose **label carries live status**, since the point of stashing it is to read the chip rather than restore the panel. What differs from a report: (1) the context owns the **poll loop**, not just the state — a report holds a snapshot, an operation has a driver, and while that driver lived in the page it kept running in a detached closure after navigation, writing to an unmounted component; (2) progress is read from **committed server state** rather than the operation's own response, because the operation is one HTTP call that returns only at the end — which is also what lets another tab, or the same one after a reload, adopt a run it did not start; (3) **Cancel means stop watching, not abort** — the backend work is resumable by design, so nothing is torn down and nothing is lost, and the control is labelled for that visible effect rather than for a cancellation that does not happen. A page holding its own copy of what a sync writes watches the context's **`runsFinished`** counter and reloads when it moves — Import/Export's history cards and the Accounts connection cards are the cases, whose counts otherwise stayed at the last load, which could be mid-run — so the reload follows every run however it was started (its own panel, the navigation pane, another tab) rather than only the runs a page's own controls launched. It is the *only* reload a run triggers: the shared connection operations (`lib/useConnectionOperations.js`) do not also notify their host after an action that ends in a run, which reloaded the Accounts page twice per sync. The pages that show *transactions* — Transactions, the Dashboard, Recurring — reload through `useAfterLedgerSync` instead, which follows a second counter, `ledgerRunsFinished`, moving only for a run that may have changed the ledger: their reload re-queries a list the user may be scrolled into or editing, so a sync that brought nothing in leaves them alone. Only the responses of a run this tab drove can establish that nothing changed; a run it merely watched counts as a change.

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

- **A file import shows its progress on the button that started it, not through the operation seam.** It
  runs for seconds rather than minutes, the page stays where it is (the review screen follows it), and there
  is no run to adopt after a reload — its progress exists in memory only while the upload's request is open
  (`architecture.md` → *Database concurrency*). So the Import button fills as the rows go
  (`Importing 1,240 / 3,500…`, or `File 2/4 · …` in a multi-file run; `runImportWithProgress`,
  `lib/importExport/importRunProgress.js`). The setup before the first row — reading the ledger for the
  duplicate checks — has no count and is deliberately not named as a phase: it measured about a second on a
  20,000-row ledger, so a label for it would flash past; the button reads `Importing…` until the rows start. When the import answers
  the bar is completed, since the last poll usually lands short of the end.
- **A live state supersedes a freshness statement; it does not sit beside it.** "Is anything happening right now?" and "how current is this data?" are different questions, and while an operation is in flight only the first one matters. The provider card's header is the reference (`providerSummaryLine`, `lib/connectionSummary.js`): during a sync it reads `1 connection · syncing…`, not `1 connection · never synced`. Stating both put two contradictory facts in one header row — `last_synced_at` is stamped on **successful** pulls only, so a connection's very first sync read as `never synced` immediately to the left of its own disabled `Syncing…` button. The connection card nested inside already did this correctly (`LastSyncSummary` short-circuits on `syncing` ahead of all its freshness logic), which is the tell: when a surface and the surface containing it describe the same operation, the outer one is the easy one to forget. Whatever expression the action control reads for "in progress", the summary beside it must read the same one — here `ss.syncing || serverSyncing`, the component's own optimistic memory **and** the server's marker, so the two cannot disagree in either direction.

- **An alternative credential must be offered wherever the credential is demanded, not on one screen that happens to also offer it.** Vault unlock is the reference. The passkey ceremony worked and was wired to the `VaultStrip` on the Connections tab — but every *gated* action (disconnect, sync, a credentials restore, and the 423 re-prompt that fires when the server drops the key on its idle timeout) raises `VaultPassphraseDialog` instead, which asked for the passphrase and nothing else. So the faster credential was reachable only by noticing the strip *before* triggering an action, and the 423 path could not be pre-empted at all, being invisible until it fires. A user who set up a passkey specifically to stop typing their passphrase typed it every time. The fix is structural rather than cosmetic: the whole sequence lives in one shared call (`runVaultPasskeyUnlock`), each host says what to do once the vault is open (`onUnlockedByPasskey`), and the prompt orders and tones the two options exactly as the strip does so the primary way in does not change depending on which surface asked. A refused or dismissed ceremony leaves the prompt open on the passphrase — the fallback is always still there — and a cancellation reports nothing, since the user closed it on purpose.

  **A ceremony the browser owns still has to look busy in the app, and be guarded twice.** A WebAuthn prompt is a separate window, so the surface underneath goes on looking idle and pressable while it is up — and a second press starts a second ceremony, which the browser refuses with an exception. That surfaced as an error dialog quoting the browser ("a request is already in progress") stacked on top of the prompt the user actually wanted, leaving them to dismiss a failure caused purely by pressing twice. Both guards are needed and neither makes the other redundant: **the control disables** for the duration (label flipping to "Waiting for passkey…"), which is the half the user can see; and **`runVaultPasskeyUnlock` refuses a concurrent call itself**, which is what holds for any caller added later.

  **The lesson was where the sharing stopped.** Only the *ceremony* had been extracted; the control around it — busy flag, disabled rule, label — was written twice in one commit and kept in agreement by a comment ("ordered and toned exactly as the Connections tab's vault strip does it"). That synced the two on appearance and left the state machine out of the bargain: the dialog had a busy flag from the start and the strip never did. All of it now lives in **`useVaultPasskeyUnlock`** (`lib/`), leaving each host only what genuinely differs — its own `<Button>` styling, and how it shows a refusal (the dialog inline, the strip as a notice). A hook rather than a component because both hosts also disable their *passphrase* control during a ceremony, so they need `busy` in hand. Two things inside it are load-bearing: the in-flight test is a **ref, not state**, since state does not change until a re-render and two presses in one tick would both read "not busy"; and `busy` clears on **every** path including success, because the host normally removes the surface but one that fails to would strand the control reading "Waiting for passkey…" with no way back short of a reload. The module-level refusal is **silent** (`reason: 'in_progress'`, empty `message`) because every caller raises a notice only when there is a message: nothing has gone wrong for the user to read, since the ceremony they asked for is already on screen. The flag clears in a `finally`, so a thrown ceremony cannot wedge the button for the rest of the session.

- **A decision about accounts is asked as a question about accounts.** When a report accumulates many row-level flags that all turn on one account-level fact, offer the account question rather than letting a row action imply it. The duplicate report is the reference: a stack of cross-account flags between one pair is one question — are these the same real-world account? — with two terminal answers (merge them, or record them distinct), each of which settles every flag between the pair. `AccountIdentityPrompt` renders it above the list, in the same words the "Possible duplicate account?" chooser uses at mapping time, because it *is* the same question reached later. Only the largest outstanding pair is prompted; stacking one per pair turns an answer into noise about the others, and "Not now" is component state, not a stored preference — dismissing means "leave me to it", and the two real answers remove the pair from the server's list anyway. The anti-pattern it replaced: **Keep both** used to write a durable account-level assertion and cascade-clear the pair, from a button labelled for its effect on one transaction — so a bulk selection of five resolved forty-two, and the user had no idea an account-level decision had been taken. A durable assertion made this way must also be listable and reversible somewhere (Settings → Distinct account pairs); an invisible one-way switch is the part that makes the pattern harmful rather than merely surprising.

- **A bulk action over N rows reports partial success as partial.** Use `Promise.allSettled` and the shared `summarizeBulkOutcome` (`lib/bulkRequestOutcome.js`), never `Promise.all`: the latter rejects on the first failure, which discards every result after it *and* whatever the caller does on success — typically the reload and the selection clear, i.e. exactly the two things that would have shown the user what actually happened. Rows that failed stay selected so a retry re-sends only those; the reload runs unconditionally, since a partly-applied bulk is precisely when the numbers on screen are least trustworthy. This is not hypothetical: a bulk "Keep both" over 42 flagged duplicates issues one request per row while a cross-account keep resolves the whole account pair in the first one, so the other 41 were refused, and a completely successful action rendered as a total failure with the stale rows still on screen. The server side of the same rule is in `docs/data-model.md` — an action that cascades must treat an already-resolved row as a success.

- **Auto-refresh on cross-page mutations.** Dialogs that show data that other pages can mutate (the duplicate-detection report's entries are affected by merges/renames on the Accounts page, etc.) should subscribe to a window-level event dispatched by the mutation site (`notifyAccountsChanged` in `App.jsx` is the pattern). Listeners debounce briefly and only refresh when the dialog is open *and* not currently loading. The `minimized` flag must survive these refreshes — minimize keeps the dialog stashed; an out-of-band refresh should never pop it back into view.

- **Date scope is caller-provided, never read from the global filter directly.** Detail panels (CategoryDetail, AccountDetail, the payee TransactionDetail, PeriodDetail, TagDetail) take their date scope as props from whoever opens them — they must not call `useFilters()` to reach into the global date filter themselves. Only Dashboard and Transactions show the filter bar (`shouldShowFilterBar` in `App.jsx`), so only they pass the global date down; pages without the bar (Categories, Accounts) pass nothing. A panel that grabbed the global filter on its own would silently scope its data on pages that don't show that filter — a hidden filter that disagrees with un-scoped counts (the symptom that motivated this rule). When no date scope is passed, a panel chooses a sensible unfiltered default: the category trend slides a 36-month window to end at the category's most recent activity (`anchor=latest` on `/summary/monthly-trend`), while account and payee trends fall back to full history. The header label must describe the window actually shown (the trend's month span), not the global filter.

- **The drill list has a Month · Year · All time range control.** The three activity drawers that drill a monthly trend chart into a scoped transaction list — `CategoryDetail`, `AccountDetail`, and the payee `TransactionDetail` — carry a shared segmented control (`DetailRangeControl`) on the list's section header. The clicked bar stays the **anchor** in every mode; the control only widens the window shown *below* it, leaving the chart as the monthly navigator (timeframe experimentation for the chart itself belongs on the Dashboard). **Month** is the default and the original behavior (the selected bar's calendar month). **Year** shows the anchor bar's calendar year — clicking any 2025 bar lists all of 2025. **All time** shows the chart's full charted span and its clicked-bar anchor is irrelevant (nothing changes when a bar is clicked). The shared helpers live in `detailShared.jsx`: `computeDetailRange(mode, anchorMonth, trend)` returns the fetch `params` (a `month`, a `date_start`/`date_end` calendar-year, or the trend's first..last span) plus the window `count`/`total` **summed from the same trend rows** (so the footer, list, and chart always agree even where the trend is capped below true history — category 36mo, account 60mo); `detailRangeStableKey` gives the memo/fetch a key that ignores same-window anchor clicks (so re-clicking a bar inside the selected year, or any bar in all-time mode, never reloads identical rows); and `detailRangeActiveMonth` highlights every bar in the active window, not just one. Widened ranges fetch through the paged `/transactions` endpoint (`usePagedTransactions`), so All time on a busy scope stays paged, not unbounded. The bulk-edit `filterParams` mirror the same window params, per the select-all hidden-filter rule.
- **The single-transaction trash lives only in editor mode.** `TransactionDetail`'s header trash targets the one entry-point transaction, so it renders only when the panel is the single-transaction **editor** (`showEditorCard`), not when it is opened as the merchant-activity **report** (the merchant `↗`, `_merchantReport`) — there the entry row may not even be in the visible window, so a header trash would be ambiguous. Report-mode rows keep their own trash via the row context menu and Bulk Edit.
- **An account that looks empty explains itself.** `AccountDetail` surfaces a note when an account has imported rows that were skipped or removed as duplicates of transactions already present elsewhere — the common reason an account shows little or no activity (e.g. the same card imported from two sources). The note names how many rows were skipped and which accounts/source files the matched existing transactions live on, computed by `GET /accounts/{id}/duplicate-summary` (`account_skipped_duplicate_summary`), which attributes both hard-rejected import rows — via the `account_id` stored in each `import_batch_duplicate` row's `txn_payload` — and confirmed-duplicate trashed `txn` rows. Its "View in duplicate report" link opens the unified duplicate viewer **scoped to that account**: the viewer takes an `accountFilter` ({id, name}) that filters report entries by the incoming side's `account_id` (now exposed on every entry), since an account's skipped rows are otherwise scattered across the batch's report. The scoped view shows a "Showing only duplicates for that account · Show all" banner that clears the filter in place.

- **A scoped list may drop a column that repeats — except the category one.** Hiding a value that is constant across the list is reasonable and `TransactionListTable` supports it (`showAccount={false}` on the account-scoped lists, `showSourceAccount` for a merged account's underlying names). The category column is the exception, because it is the only *interactive* cell in the table: the category picker, the split editor, the rule prompt and the drill into `CategoryDetail` all live in it. Hiding it as redundant silently removes those from the surface — the giveaway is a table still passing `onCategorySave`/`onRulePrompt` that nothing can now fire. The account and source-account columns carry no such cost: they are plain text.

- **Every scoped transaction list is paginated with server-side sort — never a one-shot capped fetch.** The floating drawers' lists, the Dashboard single-period drill tables (selected group, selected category), and the Recurring series drill-down's member list all go through the shared `usePagedTransactions` (`detailShared.jsx`): it infinite-scrolls `DETAIL_PAGE_SIZE` rows at a time and owns the **sort state**, folding it into each fetch as `sort_by`/`sort_dir` so the header's column clicks reorder the *whole* result, not just the loaded page. The Dashboard drills key the hook on the drill selection (`selectedGroup`/`selectedCat` + the global scope) — it fetches when a row is selected and clears on navigate-up — rather than fetching imperatively in the click handler; the drill handler now only sets the selection + level. Feed its `sortState`/`onSort` straight into `TransactionListTable`'s controlled-sort props (`onSort` being a function switches the table out of client-side sort). Server-side sort is not optional here: a client-side sort over an infinite-scroll list is broken by construction — a reversed sort parks the un-loaded rows past the fetch cursor at the *top* of the list, where scrolling to the bottom (what triggers the next page) can never reach them, so the oldest rows become unreachable. This is why a whole-year `PeriodDetail` (which replaced the single-month `MonthDetail`, whose one-shot `limit: 1000` grab silently dropped the oldest rows once a year exceeded 1000) and every other panel now page instead. `total`/`sumAmount` come back on the first page (server aggregates over the whole set) for a header count/total that stays correct past the loaded rows; panels that derive those from a trend (`CategoryDetail`/`AccountDetail`) ignore them. **Do not reintroduce a `limit: N` single fetch for any transaction list that can span a large scope** — reach for `usePagedTransactions`.
- **Scroll-container contract.** The actual scroll viewport for paginated transaction lists inside detail panels is the outer wrapper of `TransactionListTable` (the div `scrollRef` lands on) — the pill header pins inside it via `position: sticky; top: 0`. Under `fillHeight=true` that wrapper takes its height from the flex chain above it, so every ancestor between the panel shell and `TransactionListTable` must propagate height via a flex column — each wrapper needs either `flex: 1, minHeight: 0` or an explicit `height` that resolves against a flex parent. A plain block wrapper anywhere in the chain silently breaks percentage-height resolution for its descendants, the scroll viewport ends up sized to its content (no overflow), and wheel events bubble out through the floating-panel backdrop (`pointer-events: none`) into the page behind. If you add a new wrapper around `TransactionListTable`, give it `display: flex, flexDirection: column, flex: 1, minHeight: 0` and verify scroll still works in the BatchDetail panel against a large file.

## Theming

**`--muted` is for labels, not for body copy.** It clears 4.5:1 on every theme's surface (5.4:1 on dark, 4.8:1 on dim), so a *label* in it is fine — but a screen whose paragraphs and lists are all muted is both harder to read than it needs to be and has no hierarchy left, since nothing is emphasized when everything is de-emphasized. Prose is `--text`; `--muted` marks the secondary thing *beside* it. Two multipliers turn a passing token into an unreadable screen and both are easy to add by accident: a size below 13px, and no `line-height` (the browser default is tight for small text — the shared dialog description uses 13px/1.5, which is the floor to copy). The transfer-review dialog shipped with eight muted elements including whole paragraphs at 11.5–12.5px and had to be rebuilt; `--text` there is 13.6:1, two and a half times the contrast, for free.

The app offers five theme choices from the Appearance section at the top of Settings (the most-common single-user setting, so it leads the section list): two light-family palettes — **Light** (soft slate, bright) and **Soft light** (a muted grey, lower-glare) — two dark-family palettes — **Dim** (a soft charcoal) and **Dark** (the original near-black) — and **System**, which follows the OS `prefers-color-scheme` to the plain Light/Dark ends.

- **CSS custom properties are the theming mechanism.** All structural color flows through ~11 vars defined once in `frontend/index.html` — `:root` holds the dark theme (also the no-attribute default), and each `[data-theme="…"]` block (light / soft / dim) reassigns the same vars. A theme switch is purely a var swap; component logic never branches on the theme. Each block also sets `color-scheme` so native controls (scrollbars, date pickers) match. **Adding a palette is a new `[data-theme]` block plus an entry in `THEME_CHOICES`/`THEME_LABELS` in `src/lib/theme.js` — nothing else changes**, which is the payoff of routing every semantic color through a var.

- **Semantic color must reference a var, never a hardcoded copy.** `var(--danger)`, `var(--success)`, `var(--warning)`, `var(--accent)`, etc. — including inside `color-mix(in srgb, var(--warning) X%, var(--surface2))`, which adapts automatically because the mixed-in surface/border/text vars flip too. A literal like `#ef4444` for "danger" is a bug: it stays dark-slate-era red in light mode. White text *on a colored fill* (`color: '#fff'` on a `var(--accent)` button/pill) is the deliberate exception — it is correct on both themes.

- **Decorative palettes are the other deliberate exception** and stay as literals: the tag color palette (`TAG_COLOR_PALETTE`), category badge themes (`categoryAppearance.js`), and the chart-series palette (`Dashboard.jsx`). These are background-agnostic identity colors, not semantic state. Canvas drawing colors (`ctx.fillStyle`/`strokeStyle`) also stay literal — a canvas context cannot resolve CSS vars.

- **The choice is a user preference** (`ui.appearance.theme`, via `useUserPreference`), applied by `ThemeController` in `App.jsx`; a `system` choice tracks the OS `prefers-color-scheme` live through a `matchMedia` listener. The single source of truth for *applying* a theme is `src/lib/theme.js`.

- **Anti-FOUC cache.** Preferences round-trip from the backend (too slow to gate first paint), so `theme.js` mirrors the resolved choice into a `localStorage` cache (`luma.theme`) that a tiny inline script in `index.html` reads to set `data-theme` before React mounts. Without it, the pre-React paint and the "Loading preferences…" screen would flash dark before a light preference loads. The backend preference stays authoritative; the app reconciles the cache to it on load.

## Charts and overlays

Recharts is the visualization library. A few conventions keep charts consistent across the dashboard and detail panels.

- **Themed tooltips.** Use the shared `CHART_TOOLTIP_CONTENT_STYLE`, `CHART_TOOLTIP_LABEL_STYLE`, and `CHART_TOOLTIP_ITEM_STYLE` constants from `frontend/src/lib/moneyDisplay.js` on every `<Tooltip>`. Recharts colors each item's value text using the data series color by default, which is invisible against the dark surface for darkly-themed accents; the shared `itemStyle` forces value text back to `var(--text)`.

- **A placeholder name drops the noun its container already supplies.** An unnamed reimbursement is "Untitled reimbursement" standing alone — the editor dialog's title, where nothing else says what is being edited — and plain **"Untitled"** inside a list already headed *Reimbursements*, where repeating the noun on every row turns a list of records into a column of the same word. Two functions rather than one with a flag (`reimbursementDisplayLabel` / `reimbursementListLabel`), because the call site knows which it is and a boolean at the call site would not read as the reason. The ledger row's marker tooltip takes a third option: it omits the name entirely when there is none, rather than printing any placeholder.

- **A footer offering Cancel and Save implies a pending decision; show one Close when there isn't one.** A completed reimbursement has nothing to settle, and with nothing typed its Cancel and Save do the same thing as each other — so it renders a single **Close** until one of its fields is actually edited, then **Cancel · Save**. Its fields stay editable throughout on purpose: a name is documentation rather than an accounting fact, and the server deliberately allows renaming after completion. The state is derived by comparing the form against the stored record rather than by a dirty flag, so typing and undoing settles back to Close. An **open** record keeps its full `Cancel · Complete · Save` row at all times, because Complete is a decision that may be about to be made.

- **A review surface is offered where its rows live, not everywhere.** The Reimbursements report opens from the Transactions ledger and, on the Categories page, only while the reimbursable holding group or one of its leaves is selected — the one place there where "what is still owed back" is the question already being asked. The test keys on the group's `system_key`, never its name, since the group is the user's to rename (`isReimbursableSelection`).

- **A row patch must carry every field the row renders from, and cannot restate what the server computed.** A saved split reconciles `split_parts` as well as `split_part_count`: the row carries its allocations inline for the ledger's hover, so patching only the count left the hover listing the *previous* split's categories and amounts beside an editor showing the current ones, until something refetched. The second half is the limit of patching at all — in a **category-scoped** list the rows are the server's expanded allocations, and a rewritten split can move them to another category or out of the list entirely. No patch can express that, so the controller also calls `onSplitSaved` and such a host refetches its scope (the Categories page and the category detail panel each bump a reload nonce folded into their paging key). A host that renders whole transactions needs neither; where an expanded list supplies no handler, the table drops the stale allocation rows rather than leaving them showing figures that are no longer true.

- **A field that names the record gets a visible label, not a placeholder.** The reimbursement editor's counterparty field *is* the record's name — it is what the board, the row cards and the dialog heading all show — and it was labelled only by its placeholder, "Who owes it", which reads as a question rather than as a name and disappears the moment it is typed into. Once a record was named, nothing on screen identified which field held the name. It now carries a label above it, and the **dialog heading reads the form rather than the saved record**, so it follows the name as it is typed: that is the one place the connection between field and title can actually be seen.

- **Split a work list by what the money *is*, not by what the app has stored about it.** The reimbursements report is two columns — *Expected* (records and untracked expenses together, newest first) and *Received* (unclaimed repayments) — replacing an earlier *Tracked* / *Not tracked yet* split. Whether a row happens to carry a record is a fact about storage, and making the reader settle it first was the source of nearly every confusion the feature produced ("is it tracked, does it need to be, why can't I link it"). A record shows its members nested beneath it, so *tracked* reads as **has something under it** rather than as a category to reason about. The nesting hangs off the **record**, not off an expense: a reimbursement may hold several expenses and one payment may be split across two records, so an expense→payments tree would misstate both — and each nested row shows *that record's claim*, never the transaction's whole amount, or a shared payment would count twice on screen. **The two columns scroll independently**, each in the height the dialog has left: scrolled together, a long *Expected* column carried *Received* out of view on the way down to a target, so a payment and what it repays could not both be on screen for the drag. Where the board holds more than one owner, each *Expected* row leads with an `OwnerChip` (first name, full name on hover — ahead of the label so truncation cannot take it), and owner pills above the columns set the same narrowing a Tasks reminder link arrives with.

  **Drag is an accelerator over an operation that already works by clicking, never the only way.** A payment drags from the right column onto whatever it repays; the same pairing is reachable from the transaction panel's match picker, which is what keyboard and touch use and what remains usable in a long scrolling list. The drop applies the **same rules** as the click path (`dropRefusal` mirrors `matchCandidates`) — a second path that quietly does what the first refuses is worse than no second path — and a divided row hands off to the shared portion picker rather than assuming it whole. The dragged payload is component state, not `dataTransfer`, for the reason the category tree keeps its own: `dragover` cannot read `dataTransfer`, so the hover decision has nowhere else to come from.

- **A list of things that are not records yet opens the thing, not an editor for the record.** The reimbursements report's *Not tracked yet* pile has no reimbursement to edit — that is what makes those rows untracked — so a row opens its **transaction's detail panel**, where the reimbursable section already decides what to offer from the row's sign, its portions and what is unclaimed. Nothing about that flow is restated in the report. The row carries only date, payee and amount, so the transaction is fetched by id on the way. (This was a dead control for the life of the feature: the click stored `{ linkId: null }` into state that only rendered for a truthy `linkId`. A click that stores state nothing renders looks identical to a styling problem from the outside, which is why the failure path here says so rather than falling silent.)

- **Where a row's sign already decides its role, it should decide the offered action too.** The reimbursable panel's primary button is `Expect $333.00 back` on money out and `Match $250.00 to an expense` on money in, because those are different acts on different sides of the same debt — not one act ("track this") that happens to land either way. The cost of the single label was not cosmetic: a repayment tracked on its own became a record holding only a credit, and since a claim belongs to exactly one record, the expense could never be joined to it afterwards. The verb is also the reason the noun is avoidable in the common case — an expense is *reimbursable*, and only a record genuinely being named needs to be called a reimbursement.

- **A button that commits names what it commits; a button that opens a chooser does not.** The reimbursement panel's track button is one control with two jobs: on a row with a single portion the click *is* the claim, so it reads `Track $375.00` (or `Track remaining $240.00` where part of the row is already claimed — "remaining" earns its place only then), and the informational line above it is dropped, since the two would state the same figure twice. On a row with several portions the same click only opens the picker, so it reads `Track a reimbursement…` and the line stays: naming an amount there would promise a claim the button does not make, and that is the case where the arithmetic matters most because a selection can overshoot it.

- **A sentence that names the direction prints a magnitude, not a signed amount.** `-$375.00 still outstanding` reads as a double negative and, taken literally, asserts an over-repayment of $375 — the sign and the words are saying opposite things. Where prose already carries the direction ("outstanding", "extra", "awaiting reimbursement", "came back"), branch on the sign and render the magnitude: the direction belongs in exactly one place, and in a sentence that place is the words. This is **not** licence to strip a sign anywhere else — a ledger amount, a total, a chart value or a tooltip figure has nothing else stating direction, so it must show the true signed value (see *Accurate numbers*). The distinction is whether something other than the number is already saying which way the money went.

- **Signed axis labels.** Use `formatSignedAxisTick` from `moneyDisplay.js` for any y-axis whose data can span both sides of zero (monthly trends, account balances, refund-heavy months in an expense category). It renders `-$1.5k` instead of the raw `$-1500` Recharts would otherwise emit, and pairs with `formatSignedMoneyAmount` for the tooltip body.

- **Diverging bars need `stackOffset="sign"`.** A pair of bars sharing a `stackId` to form one column around a zero centerline — one series positive, the other negative — must set `stackOffset="sign"` on the chart. Recharts' default offset chains each layer from where the previous one *ended* regardless of sign, so the negative series is drawn downward from the top of the positive one and comes to rest on their sum: the chart then renders the total twice and the negative series nowhere, while every tooltip stays correct. Pass the downward series as a negative value and carry its magnitude alongside for the tooltip — and keep that shaping in a pure module (`lib/cashFlowTrend.js` is the example) so the sign contract can be asserted, since the chart half of it never can be. The cash-flow Trends chart is the worked example, and shipped with this defect precisely because the numbers around it all read right.

- **One outlier must not own the axis.** A ledger routinely produces a period that dwarfs the rest — a house purchase, a tax settlement, a run of miscategorised transfers — and an auto-scaled axis then draws every other period as a hairline against zero, which reads as "nothing happened". `computeClampedDomain` / `clampBarValue` (`lib/chartOutliers.js`) bound the axis to what the ordinary bars can be read against, and the shared `ClippedBar` shape draws anything past that bound **broken across its middle** with its true figure inside its value end. The break goes in the middle rather than at the clipped end because at the end it sits on the chart frame, where it reads as a rendering artefact rather than a deliberate mark, and on the zero side it collides with the baseline every other bar shares. Note that **recharts hands a bar below the axis a negative `height`** — it anchors every bar at zero and extends it toward the value, so `y` is the far edge and `y + height` is the zero line. Normalise to top/bottom before computing anything: reading that height as positive draws a falling bar end-for-end, which puts the break on the zero line and the label outside the bar on the card background, where white text is invisible. Same trade as the floored wedges and bands: **bound the geometry, keep every number true** — the tooltip and the label report the real value. **Judge the extreme against the bulk of the data, not against the next largest bar.** That was the first attempt and it is wrong for real ledgers, which have a *heavy tail* rather than a lone freak: measured on a real 136-month ledger the largest month was $222k and the next largest $142k — a ratio of 1.6 that any "one bar dwarfs the rest" test waves straight through — while the median month was $4.0k and 90% were under $16.2k. Ten Decembers carrying a bonus do not make each other ordinary. So the ordinary scale is a high percentile of the magnitudes (`ORDINARY_PERCENTILE`), which a handful of giants cannot move. Two properties then keep it safe to switch on everywhere: it is a no-op unless the largest magnitude clears that ordinary scale by `ENGAGE_MULTIPLE`, and **a chart can never become mostly torn edges** — which follows from the percentile rather than from a second rule policing it, since the bound sits above the 75th-percentile bar and at most a quarter of the bars can exceed it however the data is shaped. The bound also always covers the average reference line, which is itself dragged toward the extremes and would otherwise fall off the chart.

- **Average reference line.** When a chart shows a meaningful per-period average, render it as a `<ReferenceLine>` using the shared `AvgReferenceLabel` component (in `frontend/src/pages/Dashboard.jsx`). The label is split: a small "Avg" pill anchored inside the chart at the line's height, plus the formatted value rendered in the y-axis tick column (accent color, slightly bolder than regular ticks). The pill is `pointer-events: none` so it does not interfere with the chart's own hover tooltip.

- **A panning chart keeps its value axis out of the scroll.** An axis rendered inside the scrolling canvas pans away with the bars, leaving the reader with unlabelled columns — which is most of the time, since the whole point of panning is to be somewhere other than the start. Recharts cannot pin an axis inside a scroll container, so the trend chart is drawn as **two charts**: a fixed-width column carrying only the axis, and the scrolling plot with `<YAxis hide>`. Three things make that safe, and all three are silent when broken: the two must share one vertical geometry (height, top and bottom margins, and the height the category axis reserves) or the axis describes a scale the bars are not drawn to; `<YAxis hide>` still computes its scale, so the plot's geometry is unchanged by hiding it; and the column's series must be made *invisible* rather than `hide`, because `hide` drops it from the domain and the axis comes out blank. `TrendAxisAlignment.test.jsx` renders both and asserts the axis's zero tick lands on the plot's baseline.

- **A reference line's label belongs in the sticky column, and the pill moves rather than the ticks.** Once the axis is pinned, the average pill is the one labelled thing still drawn inside the panning plot, so on a long timeline it spends most of its life off screen. It moves to the axis column — where the collision with tick labels is the *normal* case, not an edge case: measured on this chart's geometry recharts lays out five ticks 41px apart, a pill needs ~15px of clearance, so roughly two thirds of positions overlap a label. The overlap is also biased toward the worst possible tick, because **a net cash-flow average sits near zero by its nature and zero is always a tick on an axis that straddles it** — measured, the average landed 1.8px and 2.8px from the `$0` tick on the two diverging shapes tried. So `placeAvgPillY` (`lib/axisLabelPlacement.js`) slides the *pill* to the nearest height that clears every label while the line stays exactly where it is and runs on underneath. A clear height always exists while the clearance fits inside half the tick spacing, and the slide is **capped at the clearance** rather than merely tending to be small: a pill further from its line than that stops reading as a label on the line and starts reading as a value of its own, so on an axis crowded past this design the pill stays put and overlaps instead — a legibility cost, where drifting would be a lie about where the average is. Two mechanics are worth knowing. Draw it through recharts' **`<Customized>`**, not a `<ReferenceLine label>`: in this column the axis takes nearly the whole width and the plot area is a sliver, so a label positioned off the plot's viewBox lands in that sliver and is clipped by the surface, while `<Customized>` renders into the chart root where `x` is just a coordinate in the column. And place the pill around **`yAxisMap[…].niceTicks`, which is the tick set actually drawn** — the scale's own `ticks()` looks like the same thing and is not: on an auto-scaled axis it returns a denser set (measured: 7 values against the 5 rendered), so dodging those steps aside from labels that were never drawn while sitting on ones that were. The column is sized to hold the pill, and the label drops the word "Avg" when a six-figure bucket pushes it past that width, since the column's SVG clips rather than merely crowds.

- **Give an explicit domain round ends.** Recharts pins ticks to the exact ends of a domain it is handed, so a computed domain like `[-27792, 27792]` yields an axis reading -27792 / -12792 / 2208 — arbitrary numbers, and no zero. Round the ends *outward* (never inward, which would hide a bar) before passing them; that restores the round ticks and the zero an auto-scaled axis would have had, and the extra headroom also lets a clipped bar stop short of the frame rather than pressing against it.

- **A chart whose width you already know must not be wrapped in `<ResponsiveContainer>`.** It does not compute a size — it measures its own box with a ResizeObserver and holds the result in React state, so the chart inside it draws first at whatever it measured *last* and is corrected only after paint. That is invisible while the box is stable and ugly the moment it is not: re-bucketing the trend chart (monthly → quarterly → yearly) replaces the series *and* the width in one commit, so the new buckets are painted at the old bucket set's width — squeezed or stretched depending on which way the grain went — and snap into place a frame or more later. Because an over-wide SVG extends its scroll container's `scrollWidth`, the stale frame also makes the container scrollable and the scrollbar then disappears when the correction lands, which is what the settling looks like from outside. The trend plot's width is `max(buckets × bar width, viewport, floor)` — a number the page computes in render — so both charts are handed explicit `width`/`height` and lay out in the same commit as their data. Keep **one** observer, on the scroll viewport, only for the case where the buckets do not fill it; that value does not change when the grain does. Guard the constructor with `typeof ResizeObserver === 'undefined'` as everywhere else in the app, and observe `clientWidth` rather than the reported content rect — a horizontal scrollbar costs height, not width, so the measurement cannot feed back into the width that decides whether the scrollbar is there. Recharts also warns about this itself when both dimensions are fixed numbers. Related: **turn the bar animation off on a chart whose data is replaced wholesale.** The default grows every bar from zero over 400ms on each change, and with the value axis in a separate chart (above) that animation runs against a scale that has already snapped.

- **A panning chart's scroll arithmetic must be derived from the width it was drawn at.** The offset that brings a bucket into view is `(index + ½) × pitch`, and the pitch is the bar width *only while the buckets are what set the width*. A plot stretched to fill a wider viewport spreads its bars over the extra room, and the two silently stop agreeing. It happens to be harmless in the ordinary stretched case — a plot that fits its viewport cannot scroll at all — but a minimum width makes it reachable: a few buckets in a narrow panel gives content wider than the viewport *and* a pitch that is not the bar width, and the chart then scrolls to the wrong place. `trendPlotLayout` returns the width and the pitch together for exactly that reason; take both from it rather than recomputing either.

- **Re-anchoring a panning chart needs to know *why* the data changed.** The Dashboard's trend replaces its bucket set for two different reasons, and the same scroll rule cannot serve both. When the set holds a **selection** — a bar was just clicked, or the grain changed under a picked period — the selection is what the reader is following, and it is brought into view (the middle bucket of a selection spanning several). **Changing the grain with nothing selected re-cuts the same data**: the reader is still looking at whatever they were looking at, and the only index-based answer available — the newest bucket — throws them to the far end of the chart on every switch. Carry the **month under the middle of the viewport** across instead, so month, quarter and year views of a period stay on that period. Two details that are wrong if guessed: anchor a bucket on its **middle** month rather than its first (anchoring the year 2019 on 2019-01 and centring a monthly plot there fills half the viewport with 2018), and make "which bucket covers this month" **total** — nearest bucket on that side when none does — because an anchor from a set that spanned more time than the new one is ordinary, not an error. The two cases need no new flag to tell apart: whether any bucket is selected decides it. Note that a bucket set narrower than its viewport cannot be scrolled at all, so "centre this bucket" is not something the plot can always do — and does not need to be, since everything is already visible.

- **A chart that pans must re-anchor when its data changes.** The Dashboard's single-period trend pans by native horizontal scroll over a canvas sized from the bucket count, and a grain change *replaces the bucket set* — an all-time monthly run of hundreds of buckets becomes a dozen years, thousands of pixels narrower. The scroll offset outlives that change, so the viewport is left pointing past the end of the new content and the card reads as blank until the scroll region catches up. Re-centre the selected bucket in a `useLayoutEffect` keyed on the bucket set (not on every render, or it fights the user's own scrolling), computing the offset from the bucket index and the fixed bar width rather than measuring the rendered chart.

- **Click-on-chart-element to drill.** On the dashboard **single-period** trend chart, a bar's click **re-pins the date filter onto that bar's exact range** — so every bar sets the selected period and refreshes the breakdown above consistently — and a **"View transactions" link** in the card header opens a range-scoped `PeriodDetail` for the whole selected period. A bar whose range already *is* the selection does nothing, rather than renaming a preset ("Year to date") to its dates and recording a step back to itself. On the **Trends-tab** monthly chart a month bar opens a one-month `PeriodDetail` directly — scoped to the drilled group when one is selected, since the bar is that group's total. The Trends tab's **Monthly averages** table drills the same way the rest of the page does: a **group row** opens that group's categories (the whole row is the target, marked `›` as on the Compare view, with a breadcrumb back), and a **category row's `↗`** opens a `PeriodDetail` scoped to that category over the table's window (`trendsWindowRange`, the same definition the charts slice by). The **group picker** above the charts offers the same population as the table at "All groups" — the groups with transactions in that window, under the page's filters, alphabetically — so the window is resolved by the page (`resolveTrendsWindowKey`) rather than inside the panel; a drilled group with nothing in a newly picked year stays listed rather than leaving the picker blank. It once listed the groups with spending in the *current month*, which read as an arbitrary subset. The tab's monthly charts and its **Avg/mo** run across **every month of the window** (`trendsWindowMonths`), a month with no rows included: drawing only months that had rows put a gap's neighbours side by side, and averaging over them overstated a sparse category (a year with eight months of shopping divided by eight, not twelve). The run stops at the current month and starts no earlier than the view's first month of data — the run rate's floor — since a month outside either end would read as a real zero. The shared date chip applies only in Single period — Compare picks its two periods with its own selectors, Trends its window with its year picker — and on both of those it is **inapplicable**, not just dimmed: it does not open, and an open picker closes, since a date set there would change nothing on screen and surface later on another view. A report opened from a figure must list exactly the rows behind it, so every such `PeriodDetail` carries the page's filters, and a slice *replaces* a category/group include filter rather than joining it — see `lib/periodReportScope.js` for why that is exact. Pie wedges on the Spending-by group/category/tag-report panels click through to either the next drill level (group → categories) or the appropriate transaction detail. Use the `cursor: 'pointer'` style on the clickable element so the drill affordance is discoverable; pair the chart click handler with the same handler the row legend uses so list and chart behave identically.

  *Why the click sets the period:* that is the thing the trend can do that nothing else on the page can, so the transaction report moved to the header link, where it covers the selected period at any bar width. The `PeriodDetail` panel is the generalization of the former single-month `MonthDetail`: it takes an inclusive `start`/`end` range plus a `label`, so months, quarters, whole periods, and years all share one drawer.

- **A chart that pans needs a tooltip placed against what is visible.** Recharts keeps a tooltip inside the chart's own box and flips it only at that box's edge — and for a chart drawn wider than its card and panned by scrolling, that box is the whole canvas. Once panned, a bar near the *visible* edge is nowhere near the canvas's, so its card opened into the part the scroll area hides. Such a chart passes `PanningChartTooltip` as its tooltip `content`: the same card, portaled out of the chart and flipped and clamped inside every clipping ancestor and the window, using the placement rule the app's hover `Tooltip` uses. It gives way to a scroll, as that tooltip does, since a card fixed in screen space would otherwise point at a bar that has moved. The Trends tab's "Total per month" avoided the problem instead by not scrolling.

- **Tooltip offset on dense charts.** Stacked area charts can have many elements clustered near the cursor; bump the `<Tooltip offset>` past the default 10 (the dashboard's "Monthly spending by group" uses 20) so the tooltip card does not obscure the column the user is reading.

### The single-period trend

The chart under the Dashboard's single-period breakdown shows the selected kind of slice over time, and
its card-header chooser cuts time two ways (`lib/trendBuckets.js`, the single-period section):

- **Calendar grains** — Monthly, Quarterly, Yearly — bucket all the history the span reaches, and the selected period is
  highlighted on **every bucket it overlaps**. A selection that is not itself a calendar unit (Past 12
  months, Year to date, Last 30 days, a custom range) lights up the run of bars it touches instead of
  being squeezed into one bar that covers different dates. The chart opens at the grain the selection
  *is*, or the one nearest its length.
- **Same span each month / quarter / year** repeats the selection exactly, shifted a step at a time —
  Jan 1 – Oct 7 in each prior year for Year to date, the 1st to the 7th of each month for Month to date,
  contiguous 30-day windows for Last 30 days. Offered only when the selection is not a calendar unit (it
  would duplicate that grain) and fits inside a year; the step is the smallest unit it fits. These bars
  are **day-precise** and read `/summary/range-trend`, because a span that does not start and end on
  month boundaries cannot be rebuilt from whole months.

**A bar equals what selecting it shows.** That is the invariant both modes keep. The model it replaced
sized each bar from the selection's length rounded to whole months and tiled from its start month, so
Past 12 months highlighted an October-to-September bar while the totals above ran to today, and a
to-date selection compared against whole earlier months. **Don't reintroduce month-rounded period-sized
buckets.** A selection exactly one step long (the Past 12 months preset runs from a date to the same
date a year later) shares its boundary day with the neighbouring bar; each bar is still exactly the
span it names.

**How far back it reaches is the second control in the header, and it is shared.** The *trend span* —
All data, Last 3 / 5 / 10 years, or `Since… | Jan | 2022`, spelled out across plain selects rather than
a native `<input type="month">` whose year must be scrolled with nothing saying so, and whose picker
panel is browser chrome that cannot be sized or styled — is one setting across this chart, the Trends tab's
annual totals and the cash-flow yearly trend, so the three cannot disagree about how much history an
average covers (`components/TrendSpanSelect.jsx`; the rule and its reasons are in `data-model.md` →
*Reporting assumptions*). It is a **floor on where the data starts, not a filter**: the selected period
is still drawn even when it is older than the span, because a chart captioned with a period it does not
contain is worse than one that reaches further back than asked. The month field appears only where a
month changes the answer — the two annual charts round the floor out to the year containing it, so they
offer the year alone, and the month picked here rides along unchanged through a visit to them. Switching grain re-counts it in whole
buckets of that grain — five years is 5 bars, 20 or 60 — so the oldest bar is never a fragment of a
period nobody asked for.

**The chooser never hides, and it never moves the period.** Choosing a grain only re-buckets, so the
date filter's back-step stays valid across it, and a year can be clicked and then opened into its months
by switching to Monthly. The pick survives the chart's own navigation — a bar click, the back-step — and
falls back to the default when the period is chosen any other way, where it would describe a different
selection; a same-span pick also falls back when the new selection does not support it. Same-span bars
are rebuilt from the selection each time, so clicking one yields the same family around it and the chart
stays put without a frozen anchor.

### Pie partition with Other-drill

Long-tail categorical breakdowns (the dashboard's Spending-by-group/category and tag-report wedges, and each side of the cash-flow diagram) use one adaptive slicing algorithm — `computeSlicePages` in `frontend/src/lib/longTailSlices.js` — so a chart stays clickable even when the underlying data has many small items. It lives in `lib/` rather than beside one chart because a second surface reads it; the caller owns the ordering, since what counts as a magnitude differs per surface (a pie floors its wedges at zero, a cash-flow side keys on the absolute value of a signed net).

- **Minimum named wedges** (`MIN_NAMED_SLICES`, currently 10). At least this many real items are shown before the long tail is collapsed.

- **Smallest-wedge threshold** (`SMALLEST_NAMED_SLICE_MIN_SHARE`, currently 3%). Beyond the minimum, items keep getting peeled out as long as the next one would still be at least this big a share of the current page's pool. Once the next item would drop below the threshold, the rest are collapsed into a synthetic `Other (N)` wedge.

- **No upper cap.** If a dataset has many items above the threshold, all of them render directly. The threshold (not an arbitrary cap) controls the cutoff.

- **Singleton absorption.** If peeling would leave exactly one item in Other, that item is added to the named wedges instead so we never show a one-item Other.

- **Other-drill.** Clicking Other re-renders the pie against just the remaining tail with the same algorithm. The threshold is recomputed against the smaller pool so deeper levels do not strand the user. A breadcrumb above the pie tracks the Other depth and clicking any crumb pops back to that level.

- **An opt-in `minShare` floor.** A bucket below this share of its pool is never named, even where naming it would have made up the minimum-named count. Off by default, because the two surfaces disagree about what a too-small bucket *costs*: a hairline pie wedge is invisible but harmless, since the legend list beside the chart still names the item, while a hairline Sankey band costs a **label row**, which is the scarce resource there. Without it a side holding fewer buckets than the minimum names every one of them however small — the case that motivated it was an inflow side of eight whose smallest was 0.0004% of the side and had no height at all, so its label was the entire node. At least one bucket is always named, or the paging could not advance.

- **One pool per drill.** The pie has one pool and therefore one depth. A surface with more than one — the cash-flow diagram, whose incoming and outgoing sides have very different tail lengths — pages each pool on its own depth rather than sharing one, and offers a back affordance per side that is depth > 0.

- **Peeled-Other vs. natural-Other.** In tag-report mode, transactions matching none of the selected report tags form a *natural* Other / Untagged signature. That is distinct from the synthetic peeled-Other wedge added at any given depth. Wedges added by the slicing algorithm carry a `_peeledOther` flag so the click handler can dispatch correctly: peeled-Other pages deeper; natural-Other opens the detail panel for that signature.

### The cash-flow diagram

The Dashboard's third frame draws a single period as a Sankey (`components/CashFlowSankey.jsx` over the graph built in `lib/cashFlowGraph.js`) and its Trends form as diverging bars around a zero centerline. Recharts ships `<Sankey>` but its stock node and link carry no labels, so both renderers are the app's own. What is worth knowing before touching it:

- **Cash flow is a *frame*, not a fourth top-level mode.** It sits in the Expenses/Income selector, widened to three, rather than beside Single/Compare/Trends — because it wants the same period, compare and trend machinery those modes already own, and promoting it would fork all of it. An earlier draft did propose the fourth-mode shape; what settled it is that compare and trends are valid *frames* for cash flow rather than alternatives to it. **Don't re-propose the fourth mode.**

- **The Trends form stacks a yearly chart above the monthly one, full width each.** Clicking a year sets the year picker the monthly chart follows, and that year's bars stay at full strength while the others dim. The Expenses and Income frames set their monthly and annual charts side by side instead, because a group picker, per-group charts and an averages table share their page; cash flow has nothing else on it, so a split would halve both charts' width for no gain. The year bars come from `/summary/monthly-cash-flow?granularity=year`, never from summing months — see *Cash-flow monthly split* in `architecture.md`.

- **A bucket's side is the sign of its own net, not its `category_type`.** An expense category that refunded more than it spent moved money *in* and sits on the incoming side; income clawed back sits on the outgoing side. This is what keeps the diagram honest under the signed-net reporting rule — the alternative is an `ABS()` somewhere, since no link can be drawn with a negative width. Both frames read the *same* summary rows the other frames read and re-project them onto one axis where positive means money in.

- **Magnitude draws, the label tells the truth** — the same split already applied to floored pie wedges and stacked bands.

- **Colour and order must not be keyed to which side a bucket landed on**, because a bucket changes sides between periods. Colours are assigned over the combined magnitude-sorted list *before* the split, so a bucket that crosses over keeps its colour and its comparison against the previous period stays readable.

- **The two sides never balance, and that difference is the period's net**, so the diagram is completed with one synthetic terminal — `Net saved` on the outgoing side, `Net drawdown` on the incoming one. Without it the hub's halves are visibly unequal and read as a rendering fault. It stands for an arithmetic remainder rather than for transactions, so it is the one node that does not open; every other node bottoms out in real transactions, which is a requirement of the design rather than a refinement.

- **A node's label adapts to the height the node actually has.** Node height is proportional to value, so any long tail puts several near-zero nodes in a row. A stacked name-over-amount label spans ~27px regardless, while consecutive nodes are only `nodePadding` apart — so below about 13px of node the stacked pair is guaranteed to overlap its neighbours'. `cashFlowLabelLayout` folds name and amount onto one line there, which needs roughly the padding alone and therefore always fits; the name takes whatever width the amount leaves, down to a floor. The `minShare` floor above and this rule are complementary and both are needed: the floor means a hairline node usually isn't drawn separately, and this means the diagram stays readable when one is anyway (a collapsed `Other`, or the balancing terminal, neither of which the floor governs).

- **A column's order is the graph's, not recharts'.** Each side reads top to bottom as the balancing terminal (the period's result, where it is found first), then the buckets largest first, then `Other`, which wraps up the smallest of them. Recharts' Sankey re-sorts every column by the position its relaxation passes leave each node in (`sort`, on by default), and with every link running to the one hub that put `Other` anywhere — so the diagram passes `sort={false}`. The passes themselves still run, since they are what centre the hub; skipping them (`iterations={0}`) keeps the order too but pins the hub to the top. Its tooltip is not animated: recharts slides a tooltip between positions, and this one starts in the top-left corner.

- **Read a node's column off the node, not off the depth recharts computed.** The layout is fixed at three columns, and deriving the hub from a computed depth breaks on exactly the period that has nothing on one side.

- **Recharts' tooltip payload differs between a node hover and a link hover** — a node nests the node object where a link nests `{...link, source, target}`. Reading it as a node either way looks correct and silently renders nothing for every link on the diagram; `nodeFromTooltipPayload` tells the two apart, and for a link resolves to the bucket end rather than the hub every link touches.

- **Tag reports are not offered in this frame.** A tag signature mixes categories from both directions, so it has no single direction to net and no `category_type` to read one from. The selection is left alone rather than rewritten, so switching back to Expenses restores the saved report.

## When to document a new pattern

Add to this document when:

- a pattern is used on more than one page

- a cleanup pass establishes a new “preferred” interaction

- repeated review comments or UI tweaks point to a missing convention

Do not add one-off exceptions unless they are likely to become reusable.

## Open

Decisions still owed on this document's subjects, each naming the live backlog item that will settle it.
Rejections and obstacles are **not** here — they sit inline beside the pattern they are about, which is
this doc's convention and the more findable one. See `AGENTS.md` → *Where rejections, obstacles and owed
decisions go*.

- **What is left of the import-history archive.** The per-source window, the by-year archive and the
  per-year purge are built (above); what is still owed is the re-bound on the fetch they unblock.
  → [`backlog/import-history-windowing.md`](backlog/import-history-windowing.md)
- **The include case of the report filter-conflict note.** The exclude case shipped; the parallel
  include case is parked for a larger tag-report pass rather than a one-off, and the behavior is already
  correct without it. → [`backlog/tag-report-exclude-warning.md`](backlog/tag-report-exclude-warning.md)
- **Saved tag reports** — four dashboard tag-report affordances, deferred together.
  → [`backlog/saved-tag-reports.md`](backlog/saved-tag-reports.md)
- **A button/design-system audit.** Unstarted.
  → [`backlog/button-consolidation.md`](backlog/button-consolidation.md)
- **Search on the Help topic list.** Parked, not started.
  → [`backlog/help-topic-search.md`](backlog/help-topic-search.md)
- **An "explain this" mode that outlines the controls on a page that have help topics**, and the
  post-data guided tour that would share its control-to-topic declarations. Not started.
  → [`backlog/in-page-help-explain-mode.md`](backlog/in-page-help-explain-mode.md)
- **The tooltip migration remainder and press-scoped labels**, batched with other small cleanups.
  → [`backlog/cleanup-pass.md`](backlog/cleanup-pass.md)
- **A Trends-tab semantics audit**, gated on that tab gaining a tag-report selector: its per-month and
  per-year totals sum across all series and can double-count depending on the series mix.
  → [`backlog/dashboard-reporting.md`](backlog/dashboard-reporting.md)
- **The UI half of attachment tiers 2 and 3.**
  → [`backlog/transaction-attachments.md`](backlog/transaction-attachments.md)
- **Whether the ledger's page-local filters should outlive the session.** The quick filter is
  session-scoped to match the search box and the amount filter; whether all three should instead be
  durable preferences is undecided, and is one decision rather than three.
  → [`backlog/misc-followups.md`](backlog/misc-followups.md)
