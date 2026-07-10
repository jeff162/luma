# Shared components index

**Consult this before building any UI element.** The rule (see `ui-patterns.md` → General principles):
*reuse is the default; a new one-off requires explicit justification.* Before writing a list, table,
panel, dialog, picker, inline editor, or button, find the shared component here (or grep for the
concept) and reach for it. If none fits, say why in your summary — don't quietly diverge.

This is a **living, seeded** index — it starts with the transaction/table/detail/primitive surfaces and
is meant to be extended as more shared controls are identified. It doesn't replace `ui-patterns.md`
(the *why* and interaction rules live there); it's the fast "what shared thing do I use for X?" lookup.
Paths are under `frontend/src/`.

**What earns a row:** a shared control — either *proven by reuse* (imported by **two or more** real
call sites) **or** *built to be shared* (deliberately designed as the reusable, canonical seam for its
job, even if only one caller exists today). A component built for reuse earns its row on day one; tag
it *sole use* (in the "Reach for" cell) until a second consumer appears, then drop the tag (re-survey
import counts when in doubt). What stays **out** is the incidental one-off — a component written for a single surface with no
reuse intent — until a second use makes commonizing worthwhile (verify by import count, discounting
same-name collisions). This is a "what's the shared way to do X?" lookup, **not** an inventory of every
component. A recurring shape that has no shared control *yet* belongs in the watchlist at the bottom,
not in these tables.

## Transactions — lists, rows, editing

| Reach for | Instead of building | Where |
| --- | --- | --- |
| **`TransactionListTable`** — the shared transaction list: pill header, shared row cells, the row context menu, client sort, optional bulk-select | any report/detail list of transactions (a one-off table of rows) | `components/TransactionListTable.jsx` |
| **`TransactionRow.jsx` cells** — `CategoryCell` / `MerchantCell` / `TransactionAmountCell`, `getTxnMerchantLabel`, and the `ContextMenu` | per-row category/merchant/amount rendering or a custom row context menu | `components/TransactionRow.jsx` |
| **`useTransactionRowActions`** — controller for the right-click row menu + its note/tag/trash/rule editors | re-wiring row actions per surface | `lib/useTransactionRowActions.jsx` |
| **`useBulkTransactionEditing`** (+ `BulkEditPanel`, `useTransactionSelection`) — the bulk-edit controller (selection, apply, reconcile) | a page-local bulk-select/apply flow | `lib/useBulkTransactionEditing.jsx`, `components/BulkEditPanel.jsx`, `lib/useTransactionSelection.js` |
| **`txnMutations`** — shared transaction mutations + in-place row reconcilers (`setCategory`, `reconcileRowsAfterRuleApply`, `makeRowReconciler`) | ad-hoc fetch/patch after an edit | `lib/txnMutations.js` |
| **`moneyDisplay`** — amount formatting + color (`formatTransactionAmount`, `getTransactionAmountColor`, `formatCurrency`, `formatMoneyMagnitude`) | hand-formatting/coloring amounts | `lib/moneyDisplay.js` |
| **`OriginFields` + `importSourceFields`** — shared rendering of a row's captured import-source detail (`OriginRow` / `OriginFieldList` / `MerchantOriginHoverCard`, `getTxnOriginRows`) | re-deriving or rendering import evidence per surface | `components/OriginFields.jsx`, `lib/importSourceFields.js` |
| **`NoteEditor`** (+ `NotePopover` in `TransactionRow.jsx`) — the shared transaction-note editor and its row popover | a custom note textarea with save/cancel wiring | `components/NoteEditor.jsx` |
| **`TransactionListToolbar`** — the "Copy the shown rows + toggle Bulk Edit" row above a transaction list (pair it with `<BulkEditChrome>` just below) | re-building that copy/bulk toolbar per activity/drill surface | `components/TransactionListToolbar.jsx` |
| **`CopyTransactionsButton`** (+ `TransactionShareContext` / `useTransactionShare` / `TransactionShareDialog`) — the shared "copy for sharing" trigger for a single `txn` or a list of `rows` | a bespoke copy-/share-transactions affordance | `components/CopyTransactionsButton.jsx`, `contexts/TransactionShareContext.jsx` |

## Detail panels & tables

| Reach for | Instead of building | Where |
| --- | --- | --- |
| **`DetailPanelShell` + `useDetailPanelChrome`** — the draggable/resizable/stacking floating panel chrome behind every detail report | a bespoke floating/detail panel | `components/detailShared.jsx` |
| **`DetailTrendChart`** — the shared monthly-trend bar chart every activity report drills into (click a bar to scope the list below) | a bespoke per-report month/trend chart | `components/detailShared.jsx` |
| **`DetailRangeControl` + `computeDetailRange`** — the Month / Year / All-time selector for a drill list and the window + count/total helper behind it (`detailRangeStableKey`, `detailRangeActiveMonth`) | a per-panel range toggle or ad-hoc month/year/all-time windowing | `components/detailShared.jsx` |
| **`usePagedTransactions`** — the shared infinite-scroll paging hook for a detail panel's transaction list (offset/`hasMore`/scroll-to-load, keyed by an `activeKey`) | a hand-rolled offset/hasMore/scroll fetch loop | `components/detailShared.jsx` |
| **`usePanelReveal`** — hold a detail panel invisible until its geometry settles, then fade it in fully formed | letting a panel visibly grow/reposition as async content lands | `components/detailShared.jsx` |
| **`TransactionDetail`** — the payee/transaction detail panel (chart + list + editors) | a custom per-transaction or per-payee detail view | `components/TransactionDetail.jsx` |
| **`PillGridTable` / `PillTableHeader`** — the pill-header sortable/re-orderable/resizable grid-table shell | a one-off table with a custom sortable/resizable header | `components/PillGridTable.jsx`, `components/PillTableHeader.jsx` |
| **`useColumnPreference`** — persisted per-user column order/width | re-implementing column persistence | `lib/useColumnPreference.js` |
| **`useTransactionTableLayout`** — the transaction-list column layout (order/width) built on `useColumnPreference`, wired for `TransactionListTable`'s columns | hand-wiring transaction column prefs | `lib/transactionTablePreferences.js` |

## Primitives, dialogs, interactions

| Reach for | Instead of building | Where |
| --- | --- | --- |
| **`ui.jsx` primitives** — `Card`, `Button`, `Select`, `Input`, `Badge`, `Spinner`, `EmptyState`, `Tooltip`, `PageHeader`, `Toggle`, `SelectAllCheckbox`, `CategoryMarker`, plus `getFormControlStyle` / `getFloatingPanelSurfaceStyle` | bespoke buttons/inputs/cards/badges/empty-states (note: a shared-`Button` audit is deferred — see `backlog/button-consolidation.md`) | `components/ui.jsx` |
| **`AppDialog` / `AppConfirmDialog` / `AppNoticeDialog` / `AppTextEntryDialog` (+ `DialogActions`)** — the standard dialog shells | a hand-built modal | `components/ui.jsx` |
| **`FloatingPanel` / `OverlayBackdrop`** — floating surface + backdrop primitives | positioning a popover/overlay from scratch | `components/ui.jsx` |
| **`TransientTextInput`** — single-field inline edit (Enter/blur commits, Esc cancels to the pre-edit value) | a custom inline text editor | `components/TransientTextInput.jsx` |
| **`UndoToast`** — the timed "…done · Undo" toast for a reversible destructive action (bulk category move/delete, remove-from-recurring-series) | a bespoke undo snackbar | `components/CategoryTreePrimitives.jsx` *(shared control in a category-named file — belongs in `ui.jsx`; not yet moved to avoid import churn)* |
| **`uiInteractions`** — `useDismissibleLayer`, `useEscapeAction`, `useTransientTextEdit` (dismiss/escape/popup rules) | per-page click-away / escape handling | `lib/uiInteractions.js` |

## Pickers, help, shared state

| Reach for | Instead of building | Where |
| --- | --- | --- |
| **`TagPickerWithCreate`** — the one tag browse-and-create picker (creating is available wherever assigning is; supports the per-transaction inherited-tag opt-out via `blockedTagIds`) | a page-local tag selector | `components/TagPickerWithCreate.jsx` |
| **`useTags`** — the shared, cached tag list for pickers (one `GET /tags` app-wide; `addTagToCache` folds in an inline-created tag, `invalidateTags` refreshes after a Settings edit). **Not** for per-row use — see the hook's header | each surface fetching tags into its own `useState` + effect | `lib/useTags.js` |
| **`TagUi`** — shared tag rendering: `TagGlyph`, `TagBadge`, and the canonical `TAG_COLOR_PALETTE` | hand-rendering a tag chip/dot or redefining the palette | `components/TagUi.jsx` |
| **`CategoryPicker`** — leaf-category selection | a custom category dropdown | `components/CategoryPicker.jsx` |
| **`CategoryDisplay`** — the read-only category chip (the render-side pair to `CategoryPicker`) | hand-rendering a category label/color | `components/CategoryDisplay.jsx` |
| **`RuleForm`** — the reusable rule editor (match conditions + actions, live match/preview, `amountConditionSummary`); `RuleActionModal` is one host of it | a bespoke rule-editing form | `components/RuleForm.jsx` |
| **`RuleActionModal`** — create / open-matching rule from a transaction (wraps `RuleForm` with the collision/merge + apply handling) | a bespoke "make a rule" flow | `components/RuleActionModal.jsx` |
| **`RuleSuggestionToast`** — the "create a rule from this categorization?" prompt (create/edit + apply-to-existing) fired after a manual recategorize | a bespoke post-categorization rule prompt | `components/RuleSuggestionToast.jsx` |
| **`RecategorizeControl`** — the shared "re-run categorization" control kit (hook + button/banner) for the global, override-skipping recategorize pass | a page-local recategorize button/flow | `components/RecategorizeControl.jsx` |
| **Help registry (`content.jsx`) + `FeatureExplainer` / `ContextualExplainer` / `HelpLink`** — in-app help topics with an always-present inline `?` (`FeatureExplainer`) and a two-stage first-use tip that collapses to that `?` (`ContextualExplainer`); one registry powers the popovers and the `/help` page | ad-hoc help text, a one-off explainer, or a hand-rolled first-run tip | `help/content.jsx`, `help/FeatureExplainer.jsx`, `help/ContextualExplainer.jsx` |
| **`FilterContext` / `FilterBar`** — shared date/account/owner/group filtering | re-deriving global filter state | `lib/FilterContext.jsx` |
| **`useUnifiedDuplicatesViewer` (`UnifiedDuplicatesViewerContext` + `UnifiedDuplicatesDialog`)** — the app-level duplicate-report viewer, opened from any surface (a row's ⚠, an account, the import report), with minimize-to-nav | opening a bespoke duplicates report | `contexts/UnifiedDuplicatesViewerContext.jsx`, `components/UnifiedDuplicatesDialog.jsx` |
| **`useUserPreference` (`UserPreferencesContext`)** — persisted per-user UI preferences | storing UI prefs ad-hoc | `lib/UserPreferencesContext.jsx` |

## Recurring patterns without a shared control yet (watchlist)

Shapes that recur but haven't crossed the bar to commonize — either still too small to be worth a
control, or too divergent to unify without a leaky abstraction. They are **not** in the tables above
(nothing to reach for yet). The point of listing them: **when a new instance of one of these shows up,
surface it to the user** — one more copy may be the tipping point where extracting a shared control
becomes worthwhile. Deeper analysis + the audit process live in `backlog/refactor-audits.md`.

| Pattern | Where it recurs | Why not commonized yet | Surface to the user when… |
| --- | --- | --- | --- |
| **Row-patch idiom** — `setX(prev => prev.map(t => t.id === id ? { ...t, …patch } : t))` | ~10 sites across pages/detail panels | each is a single line; some patch different row shapes (txns vs tags) | a new copy pushes it well past a dozen, or a bug traces to one copy drifting → extract a tiny `updateById(list, id, patch)` |
| **Reference-data fetch** — `useState(null)` + a cancelled-flag `getX()` effect for a whole-list lookup | categories / accounts / owners fetched this way in `FilterBar`, `Accounts`, the Amazon import tab (`AmazonImportTab`, accounts), and several pages | each entity differs slightly; only tags got a cache (`useTags`) so far | a 3rd+ surface starts refetching the same reference list → add a `useTags`-style cached hook for that entity (or a generic one) |
| **The four drill detail panels' skeleton** — trend chart + drill list + child `TransactionDetail` + bulk | `CategoryDetail` / `AccountDetail` / `MonthDetail` / `TagDetail` | genuine divergence (e.g. `AccountDetail`'s source-account column/filter) makes a full unify leaky | a 5th such panel appears, or the divergence resolves → prefer growing `detailShared.jsx` incrementally over one mega-component |
| **File drop zone** — a click-to-browse + drag-and-drop upload target | `ImportUploadStage` (the CSV import upload stage) and the Amazon tab's local drop zone (`AmazonImportTab`) | `ImportUploadStage` is entangled with the CSV data-source / header-fingerprint flow (~25 props); the Amazon one is a bare dashed-box target — a shared control would have to separate "drop target" from "CSV source detection" | a 3rd drop zone appears, or the two visibly drift (`ui-patterns.md` wants drop zones consistent) → extract a small shared `DropZone` (click + drop, multi-file) that each caller wraps with its own logic |
