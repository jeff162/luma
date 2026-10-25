# UI Patterns

The conventions that keep Luma's screens looking and behaving like one application: what to reach for
when building the next surface, and the reason behind each.

This document records conventions. It does not specify surfaces: what a particular page, dialog or card
looks like is whatever the code and the screen say, and is free to change. A convention here can change
too. When one stops fitting, change the code and this document together.

For the component that implements a pattern, [`shared-components.md`](shared-components.md) is the
lookup. Data semantics are in [`data-model.md`](data-model.md).

## Contents

- [Product intent](#product-intent)
- [Consistency and reuse](#consistency-and-reuse)
- [Page layout](#page-layout)
- [Buttons](#buttons)
- [Tables and lists](#tables-and-lists)
- [Tree views](#tree-views)
- [Editing in place](#editing-in-place)
- [Transaction lists](#transaction-lists)
- [Pickers and filters](#pickers-and-filters)
- [Loading and feedback](#loading-and-feedback)
- [Status, badges and timestamps](#status-badges-and-timestamps)
- [Empty states](#empty-states)
- [Dragging](#dragging)
- [Dropping and pasting files](#dropping-and-pasting-files)
- [Secret fields](#secret-fields)
- [Confirmation and dismissal](#confirmation-and-dismissal)
- [Help](#help)
- [Floating panels](#floating-panels)
- [Theming](#theming)
- [Charts](#charts)
- [What belongs here](#what-belongs-here)

## Product intent

Luma should feel polished, quiet, and immediately useful. The UI supports routine work in place rather
than forcing separate admin or settings flows for common actions. Polish is part of the feature, not a
later cleanup step.

Baseline expectations:

- Overlays open in the correct place on first paint, respect viewport edges and scroll containers, and
  render above surrounding content.
- Controls do not jump, reflow, or visibly correct themselves after opening.
- Inline edit states keep the layout stable.
- With several floating panels open, the topmost carries the strongest edge and elevation.

A control that appears in more than one place is a finished product surface: its viewport behavior,
scroll behavior and first-paint placement belong to the shared control, not to per-page cleanup.

## Consistency and reuse

- **Search before building.** Before writing a list, table, panel, dialog, picker, inline editor or
  button, look for the shared one in `shared-components.md` or by grep. A one-off needs a stated reason.
- **Shared behavior is built shared from the start.** A page-specific version with a plan to sync it up
  later is how surfaces drift.
- **The same object behaves the same everywhere.** An account, category, owner or tag that appears on
  several screens keeps the same add, edit and remove behavior, so nothing has to be relearned per page.
- **Edit where the data is viewed.** If the user can see a value in its primary context, they can change
  it there. Inline editing suits lightweight changes; a dialog suits multi-step or higher-risk ones.
- **Creating is available wherever assigning is.** Any picker over a managed set (category, group, tag,
  owner) also creates a new member inline and applies it. Renaming, deleting and reordering can live on a
  management screen.
- **Layouts are compact.** No large empty regions, oversized cards, or controls heavier than the data
  they edit. Advanced and less-common settings sit below everyday ones.
- **A label names the effect the user sees**, not the mechanism behind it, and does not repeat what the
  surrounding text already says. A page's primary create action is `+New` where the page heading
  already supplies the noun.
- **Money words are the app's own.** Money out is **Spent** and money in is **Received**, as the
  manual-entry direction selector names them, so one quantity reads the same on every screen.
- **Prefer the verb or the adjective to the abstract noun.** An expense is *reimbursable*; the noun is
  for where a record is genuinely being named, and reads as jargon elsewhere.
- **A control whose job is already done goes.** If it is kept "just in case", or a picker offers every
  choice the data model permits rather than the ones someone would make, drop it and say what that
  costs. A surface earns density by need.
- **A capability that is kept is explained, not made inert.** A control that stands for something
  openable and does nothing reads as broken, so give it a label, marker or tooltip rather than
  withholding it.
- **Working view state is remembered.** Column layout, panel geometry and similar preferences go through
  `useUserPreference`, not page-local persistence.

## Page layout

- **Structure.** A `PageHeader`, then `Card` blocks or list regions, with actions near the data they
  affect. Long lists scroll inside their own region so the header and controls stay put.
- **Tabs, a segmented toggle, or a section list.** A tab row names separate management surfaces sharing
  a page. `SegmentedToggle` names peer views of one subject, and carries a count as a `badge` where the
  count is the reason to switch. `SectionListPage` suits many unrelated sections each visited
  occasionally, grouped under headings by subject so a long list is scanned by group first. A surface
  that is alone on its tab is not wrapped in a collapsible card.
- **Which view is showing is session state.** The active tab or toggle is kept in `sessionStorage`, and
  a URL parameter wins over the stored value so a deep link lands where it means to.
- **Header or toolbar.** The header carries what acts on the whole subject (add one, run a pass, open a
  report). A toolbar under it carries what shapes which rows are listed (search, filter, sort).
- **Refresh sits on the title.** `RefreshButton` goes straight after the title of what it reloads:
  `PageHeader` and `AppDialog` take it as `refresh`.
- **Close is at the upper right** of a panel or dialog header.
- **Wide data tables scroll; management lists reflow.** A table with hard column minimums scrolls
  horizontally inside its own region while the chrome around it wraps. A list the user navigates and
  drags never grows a horizontal scrollbar: one fluid column absorbs the slack.

## Buttons

- **A button's look comes from its props.** `Button` is styled by `variant`, `tone`, `pressed` and
  `size`, and a caller's `style` places it (margin, flex, width) rather than colouring it. A need none of
  the props meets is a deliberate addition to the component, so the next surface gets it too.
- **One primary per surface.** `primary` is the action that commits what the surface is for (Save,
  Confirm, Import). Every other action is `secondary`; one that should not compete with the data around
  it is `quiet`.
- **Red follows *Confirmation and dismissal*.** `variant="danger"` is the final confirm of something that
  cannot be undone. `tone="danger"` reds the label of an irreversible action that is not itself that
  confirm, such as a row's permanent delete.
- **Two sizes.** `regular` is the default everywhere, so every Save, Cancel and Close is one size. An
  action repeated on every row or card is `compact`, so a run of them reads as a quiet toolbar rather
  than as the surface's main verbs.
- **A toggle shows its state.** A button that switches something on and off takes `pressed`, which draws
  the accent and sets `aria-pressed`.
- **A control that is only a glyph is an `IconButton`**: bare until hovered, and named by its
  `aria-label`, which is all a screen reader gets.
- **Other button shapes have one component each.** A chip that narrows a list is a `FilterChip`, a choice
  among peer views is a `SegmentedToggle`, an action that reads as text is a `LinkButton`, and a common
  action with its alternatives behind a caret is a `SplitButton`.

## Tables and lists

- **Pill headers.** Sortable, reorderable and resizable headers come from `PillTableHeader`, and a full
  table from `PillGridTable`. Each behavior is optional, so a quiet table reuses the same look.
- **Column order and widths persist** through `useColumnPreference`, whether or not the table uses
  `PillGridTable`.
- **Rows that read as columns share one template, and its end track is fixed.** A list whose rows are
  each their own grid only *looks* columnar: with an `auto` final track the metadata columns land
  wherever that row's buttons leave them, so one row carrying an extra control pulls its own cells out
  of line with every other row's. Fix the action track's width and give an oversized control a line of
  its own beneath it. Below the width where the tracks stop fitting, hold the list's width and scroll
  it rather than re-flowing, and truncate a long value with its full text in a `title`.
- **Long lists are windowed** with `WindowedRows`. Column widths must come from the shared grid template
  rather than from browser table auto-sizing, or the columns jump while scrolling. Sort and selection
  stay driven from the full list, never the mounted rows.
- **Acting on a row doesn't reorder the list.** An action often changes what a row sorts by, and a
  re-sort after the reload moves the next row under the cursor. `useStableOrder` keeps the order until
  the user picks a new sort, filter or scope.
- **A paged list sorts on the server.** A client-side sort over a partly loaded list orders only the rows
  that happen to be loaded. `usePagedTransactions` owns paging and sort for transaction lists; a one-shot
  capped fetch silently drops rows.
- **In a dialog, one outer container scrolls both axes** with the header pinned by `position: sticky`.
  A nested vertical scroll clips the last column when its scrollbar appears.
- **Two-line rows suit content that is variable-length on both sides.** Keep a table only when the
  columns genuinely align.

## Tree views

- Each child level begins under the first letter of the label above it. Alignment carries the hierarchy,
  not guide lines.
- Expand and collapse controls stay close to the label they affect.
- Protected system rows are in italics and stay at the bottom of their section.

## Editing in place

- **Click the value to edit it.** No separate Edit button for a simple text change. Row height is the
  same in display and edit states. A new row is created inside the list, not in a panel above it.
- **A failed save the user can fix keeps the screen open** and says what needs to change.
- **Renaming a saved value commits on blur.** Enter commits and Escape reverts. `useTransientTextEdit`
  and `TransientTextInput` provide this by default.
- **Creating something, or a multi-field form, uses an explicit submit** and does not commit on blur
  (`onBlurCommit={false}`), so clicking away never creates a half-specified thing.
- **Escape cancels the local edit and nothing else.** It restores the pre-edit value and does not close
  the surrounding popover, dialog or page. Each editor or layer owns its own Escape
  (`TransientTextInput`, `useDismissibleLayer`, `SearchInput`); there is no global listener.
- **Enter advances through a small form and submits from the last field** (`lib/formKeys.js`). Enter is
  gated on the same named condition as the button. A typed confirmation for an irreversible action takes
  no Enter handler.
- **An amount is entered as a magnitude plus a direction control**, never as a signed number, and the
  form shows the figure that will be recorded before saving.
- **Row actions live in the row's `⋯` menu** (`ActionMenu`), with the destructive item last and
  separated.

## Transaction lists

- **Every transaction list offers the same row editing.** `TransactionListTable` and the cells in
  `TransactionRow.jsx` provide merchant rename, the category picker, note and tag markers, the pencil and
  the right-click menu. A host turns each on by passing its callback. An affordance is absent only where
  the context cannot support it.
- **One controller per behavior.** `useTransactionRowActions` owns the row menu and its editors, and
  `useBulkTransactionEditing` with `BulkEditChrome` owns bulk select and edit. A new surface passes
  props rather than re-implementing either.
- **Bulk `filterParams` mirror the list's fetch exactly**, including any date, account or tag scope, or
  select-all edits rows outside what is shown. A large selection is confirmed first
  (`BULK_CONFIRM_THRESHOLD`).
- **Row markers share one strip beside the amount**, and every marker opens what it stands for. Tags use
  one glyph with color carrying identity; other markers are distinct glyphs so they do not read as tags.
- **An edited row lingers where it was found.** A row that no longer matches the list's filter is
  patched in place and stays until the user presses Refresh, so a mis-tap stays correctable. Every
  surface that lingers carries the Refresh. Trashing a row is the exception and drops it at once.
- **Edits reach the server through `lib/txnMutations.js`**, which also returns what the server resolved
  (inherited tags, rows that followed the edit) so the patched row does not go stale.
- **A popover opened from a row portals to `<body>`** (`RowPopoverPortal`). Rows are their own stacking
  contexts, so one left in flow is trapped behind the rows after it.
- **Any surface showing transactions carries `CopyTransactionsButton`**, whose preview is the clipboard
  output.

## Pickers and filters

- **Short categorical values use pills** that expand into their selector, rather than full-width
  selects. Opening one does not change row height or shift its neighbors.
- **Category and tag assignment use the shared pickers** (`CategoryPicker`, `TagPickerWithCreate`), and
  pickers show groups in the same order as the Categories page.
- **Search and filter are separate tools.** A search box narrows by one obvious field. A filter narrows
  by structured facets shown as removable chips, and offers only values present in the data.
- **A page-local filter stays out of `FilterContext`.** The app-wide filter persists across pages and
  feeds the Dashboard. A filter that belongs to one page is session-scoped state on that page.
- **Include and exclude.** A facet row's main click includes; the quiet `≠` at its right edge excludes.
  Pages translate chips to API parameters with `selectionsToParams`, which splits by mode.
- **Read the shared date with `getDate()`**, which applies a page's registered default.
- **A panel takes its date scope from whoever opens it** and never reads the global filter itself, since
  most pages do not show the filter bar and a hidden filter would disagree with the page behind it.

## Loading and feedback

- **A reload keeps what is on screen.** The spinner is for a first load:
  `{loading && rows.length === 0 ? <Spinner/> : rows}`. Where held content would claim to be current,
  wrap it in `StaleWhileRefreshing`.
- **A busy indicator is delayed, then held** (`useBusyIndicator`). Most requests are local and return in
  milliseconds, so an indicator bound straight to `loading` only flickers. `disabled` still follows the
  raw flag.
- **A surface that fetches on open paints once, fully formed.** It renders nothing until its content is
  ready, bounded by `PAINT_GATE_DELAY_MS` so a stalled load still appears.
- **A press looks pressed.** The shared buttons push in while held and `RefreshButton` always turns.
  On a button the user just clicked, a `Saving…` label is kept wherever nothing else on screen changes
  when the action succeeds.
- **A disabled control says why.** Wrap it in `Tooltip`, because a disabled button receives no pointer
  events and its own `title` never opens. Derive the reason and the disabling condition from one
  expression. Where a capability simply does not apply, remove the control instead.
- **Tooltips.** `Tooltip` is the default for hover content. A native `title` is fine for a plain-text
  hint. Converting a `title` to `Tooltip` needs an `aria-label` or `aria-describedby` added with it. A
  hint on a row of a scrolling list takes `openDelay={ROW_HOVER_OPEN_DELAY_MS}`.
- **A bulk action reports partial success as partial** (`Promise.allSettled` with
  `summarizeBulkOutcome`). Rows that failed stay selected and the reload runs regardless.

## Status, badges and timestamps

- **Timestamps are absolute** (`formatTimestamp`). A relative label is right only for a single standing
  "how stale is this?" figure, with the absolute time on hover and `useRelativeTimestamp` keeping it
  current.
- **A collapsed card still shows what needs attention and offers its routine action.** Attention counts
  go in the collapsed header. An action there is a sibling of the toggle (`SectionCard`'s
  `headerActions`), never nested inside it.
- **A badge marks the exception, not the expected state.** Where one state is a subset of another, the
  narrower badge replaces the broader one.
- **A count shown at more than one level comes from one function**, so a roll-up cannot disagree with
  the rows under it.
- **`↗` means "opens a report".** Reuse the glyph rather than restyling the control: an `IconButton` with
  `tone="accent"` on its own, or a `StatusPill` with `report` where a count opens the rows it counts.

## Empty states

- Brief and quiet: `None.` or `No accounts yet.` rather than instructions.
- Close in size to the sections around it, with the primary action inside or beside it.

## Dragging

- **Every press-and-move gesture goes through `lib/pointerDrag.js`**, never mouse events or the
  browser's drag-and-drop, because both are mouse-only in practice and the app is used on tablets.
- **A handle whose only job is the gesture** (a splitter, a resize grip, a panel header) follows the
  press at once with `trackPointer` and sets `touch-action: none`.
- **An item that is also clicked, or sits in a scrolling list,** is picked up with `startPointerDrag`:
  after a few pixels with a mouse, after a press-and-hold with a finger, so a swipe still scrolls. Its
  targets are `useDropZone`s, and a list it is dragged along scrolls only if it asks to.
- **A control inside a drag handle stops the pointer press** (`onPointerDown`), not the mouse press, to
  keep out of the drag.

## Dropping and pasting files

- **An important upload gets a visible drop zone** (`DropZone`) that accepts both a click and a drop,
  with short task-specific text.
- **A paste target is a real `textarea` or `input`.** A `paste` event fires only at a focused editable
  element, so a handler on a `div` is unreachable.
- **One picker per task, not one per file format.** Read the file and route on its content, never on its
  name.
- **Uploads report per file**, not as one busy flag.

## Secret fields

- **Every typed or pasted secret uses `PasswordInput`**, which carries the Show/Hide reveal.
- **The field says which kind of secret it holds**: spread `NEW_SECRET_PROPS` or `EXISTING_SECRET_PROPS`
  from `lib/sensitiveFields.js`. A surface with no username field adds `PasswordManagerUsername` so a
  password manager files the secret under its own name.
- **A field that chooses a secret is checked as it is typed.** `FieldIssue` shows the unmet rule under
  the field, and the same expression feeds the greyed button's `Tooltip`.
- **A secret shown once is saved before whatever depends on it is created.** Offer download and copy
  first; once saved, no exit discards the dependent object.

## Confirmation and dismissal

- **No browser `confirm()`, `alert()` or `prompt()`.** Use the shared `AppDialog` primitives.
- **A dialog that needs an explicit choice does not close on a backdrop click.**
- **Red is for what cannot be undone.** An action reversible with effort (re-linking a bank, re-syncing
  history) is not `danger` even when it deletes rows; its red goes on the confirm button. How alarming
  the name sounds is not the signal. Spending red on recoverable actions leaves nothing to mark the
  permanent ones.
- **A dismissed item leaves a way back**: an `UndoToast` for the mis-press, and a durable "N dismissed"
  list for the one noticed later.

## Help

- **Help text is authored once**, in `HELP_TOPICS` (`frontend/src/help/content.jsx`), and shown three
  ways: the `/help` page, the `?` popover (`FeatureExplainer`) and the in-place viewer
  (`HelpTopicDialog`).
- **A page-level `?` sits immediately left of the title** (`PageHeader`'s `help` slot). A `?` that
  explains one control sits beside that control.
- **Guidance that applies only in a recognized situation uses `ContextualExplainer`**: a dismissible tip
  that collapses to a `?`. The host decides when the situation is live.

## Floating panels

- **One shell.** Detail panels and worked-through reports use `DetailPanelShell` with
  `useDetailPanelChrome`: drag, resize from any edge, and viewport clamping. `AppDialog` is for a dialog
  that is opened, answered and closed.
- **Stacking** is managed by `PanelStackContext`. Clicking a panel brings it to the front, and
  re-opening the same target focuses the existing panel.
- **A panel may open a child panel**, which closes with its parent.
- **Edits reconcile to the host through one callback**, `onReconcile(txnId, patch | null)`, usually
  built with `makeRowReconciler`.
- **Escape closes only the topmost panel**, and not while focus is in a text field or a dialog is open
  above it. Panels do not close on a backdrop click.
- **A report kept open while working elsewhere minimizes to the navigation pane** through
  `useDetachedReportViewer` and `MinimizedReportPill`.
- **Geometry the user set is remembered** with `useRestorablePanelGeometry`.
- **A panel that reflows on open stays invisible until it settles** (`usePanelReveal`).

## Theming

- **Color comes from CSS custom properties** defined per theme in `frontend/index.html`. A theme switch
  is a variable swap; components never branch on the theme. `lib/theme.js` applies the choice.
- **Semantic color references a variable**, never a literal: `var(--danger)`, `var(--accent)`. White
  text on a colored fill and the decorative palettes (tags, category badges, chart series) are the
  exceptions.
- **`--muted` is for labels, not body copy.** Prose is `--text`.

## Charts

- **Tooltips use the shared styles** (`CHART_TOOLTIP_CONTENT_STYLE` and its siblings in
  `lib/moneyDisplay.js`).
- **Signed values use `formatSignedAxisTick` on the axis and `formatSignedMoneyAmount` in the
  tooltip.**
- **Geometry may floor; numbers stay true.** A wedge or band that cannot draw a negative is floored for
  drawing only. Every label, tooltip and total shows the real signed value.
- **One outlier does not own the axis.** `computeClampedDomain` bounds the axis and `ClippedBar` draws
  the broken bar with its true figure.
- **A clickable chart element has a pointer cursor** and shares its handler with the matching legend
  row.
- **Long-tail breakdowns use `computeSlicePages`** for the named slices and the drillable `Other`.
- **A chart wider than its card pans** inside `PanningChartFrame` and uses `PanningChartTooltip`.
- **A per-period average is drawn with `AvgReferenceLabel`.**

## What belongs here

An entry earns its place when it applies to more than one surface and tells someone what to do when
building the next one. Each is the rule, a short reason, and the component that implements it.

What does not belong: a description of one surface, the history of how a surface came to be, or a fact
about one component's internals. The first two are the code's to state, and the third is a comment at
the site.
