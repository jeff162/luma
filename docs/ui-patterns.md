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

- Treat recurring domain objects as shared product language too. When a user, account owner, category, account, or similar named thing appears on multiple screens, its basic add/edit/remove behavior should feel the same unless the workflow is genuinely different.

- The reason for this consistency is not only aesthetics. Reusing the same interaction language lowers relearning cost, makes the product feel more trustworthy, and avoids the impression that one screen is a lesser or temporary version of another.

- Shared form controls and dialog footers should come from shared primitives where possible so cancel/save rows and everyday input chrome do not drift across pages.

- **Native `title` tooltips are an acceptable choice, and sometimes the better one.** The shared `<Tooltip>` (`frontend/src/components/ui.jsx`) is the default whenever hover content needs theming, markup, links, or hover-into-it interaction. But a plain-text hint with none of those needs does not require it — a bare `title` attribute is fine. A native tooltip is also genuinely *better* in some cases: the browser draws it outside the page, so it auto-positions and can spill past the window edge, whereas the DOM `<Tooltip>` is viewport-clamped and can only ever stay inside the window. Where that edge behavior matters more than visual consistency — for example the Help page's section jump-nav — prefer native `title` and accept the look-and-feel mismatch as a deliberate trade.

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

- When column order or widths materially affect how a user works, that table geometry should persist through the shared per-user preference model instead of resetting every time the page or dialog opens. The shared `useColumnPreference(prefKey, defaultColumns)` hook (`frontend/src/lib/useColumnPreference.js`) is the one way to wire this: it returns `[columns, onColumnsChange]` to spread into `PillGridTable`, merging the saved order/widths over freshly-computed defaults (clamping persisted widths, dropping unknown keys, appending new columns). Both the duplicate-rows dialog and the matching-imported-transactions report consume it; a new resizable pill table should too rather than re-implementing the merge.

- Transaction troubleshooting can temporarily repurpose a less-critical column, such as Category, for debug context like the import-file source, but it should not displace the primary merchant label. Prefer a tucked-away header action such as a context menu over a persistent page-level button for these uncommon views, and reuse the same file-detail drill-in wherever an import file source is shown.

## Page structure

Most pages should follow this structure:

1. A `PageHeader` at the top.

2. One or more `Card` blocks or list/table regions underneath.

3. Primary actions placed near the data they affect.

4. Scroll inside long data regions when the list grows large, rather than making the whole page excessively tall.

Prefer page-local scrolling for long lists, with header and controls remaining visually stable above the scrolling region.

### Horizontal sizing of data regions

Two different surfaces respond to a narrowing pane in two different, deliberate ways, and the choice follows from what the region *is*:

- **Wide data tables** (the Transactions ledger, the Categories matching-transactions list) have columns with hard min-widths and **scroll horizontally inside their own clamped viewport** once the pane is narrower than that floor. The table chrome around them (titles, filters, action buttons) should wrap or reflow — only the table body scrolls.

- **Entity/management lists** (the Accounts list) use fluid `minmax(0, …fr)` columns that **compress and ellipsize** instead of scrolling. A horizontal scrollbar on a list the user navigates and drags would be worse than letting non-critical columns shrink; the fixed minimums stay small so the row never blows out at realistic widths.

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

## Transaction rows

Transaction tables should share the same row-level metadata treatment.

- Notes and transaction tags belong in a shared marker strip near the amount column rather than being rendered differently on each page.

- Tags should use one fixed shared glyph, with user-selected color carrying the visual identity.

- Hovering a tag marker should reveal its label, and clicking row markers should use the shared inline popover patterns instead of page-local dialogs.

- Note editing goes through one shared editor (`components/NoteEditor.jsx`) wherever a transaction note is edited — the row's note popover and the transaction detail panel both render it — so the interaction never diverges by surface: a multi-line field where ⌘/Ctrl+Enter saves (plain Enter inserts a newline), Escape cancels the edit, Save stays dimmed until there is an unsaved change, and a Remove action clears an existing note. Persistence (the API write and reconciling the host's row) stays with the host via the editor's `onSave`; any new surface that edits a note should reuse this editor rather than re-implementing the field and its shortcuts.

### Bulk select and edit

A "Bulk Edit" toggle puts a transaction table into bulk mode: a leading checkbox column appears with a select-all checkbox in its header, and a bulk action bar offers Edit… (a `BulkEditPanel` — category, tag add/remove, notes, merchant, date) and Move to trash.

**One shared controller owns the behavior** — `lib/useBulkTransactionEditing.jsx`. A host calls the hook with `{ rows, setRows, total, filterParams, categories, … }` and gets back `toggle`, `tableProps` (spread onto `TransactionListTable`), and a `<BulkEditChrome controller={…}/>` companion that renders the action bar plus the edit/confirm/notice dialogs. The host renders only its own toggle *button* (placement is page-contextual) and spreads `tableProps`; everything below — selection, the apply call, the in-place reconcile — lives in the controller, so a new surface is a prop-pass, not a re-implementation. Underneath it still composes the shared leaf pieces: selection state `lib/useTransactionSelection.js`, the editor `components/BulkEditPanel.jsx`, the header `SelectAllCheckbox` (`ui.jsx`), and the write `api.bulkUpdateTransactions`.

- **Select-all has two strategies.** Default (`'filter'`): the header checkbox switches to "all matching", and the API resolves the set server-side from the host's `filterParams` (passed via `toSelectionPayload`), so it covers rows past the loaded page. `'loaded'`: for a list whose visible rows are a *client-side* subset no server filter can re-resolve (TagDetail's exact tag-signature list), select-all instead checks every loaded row by id (ids mode) — the rows are already fully in memory, so "all" needs no server round-trip. Individually unchecking after select-all adds to an exclude set.
- **`filterParams` must mirror the host's list fetch exactly**, including any date/account/owner/tag scope. A select-all payload that omitted the date on a period-scoped list (the Dashboard drills, the month panels) would silently edit rows outside the visible scope — the same hidden-filter hazard called out for detail-panel date scope.
- The select column is injected at render only (never persisted into the user's column config) and is non-sortable/non-draggable/non-resizable; its header checkbox uses the pill header's per-column `render` hook (`PillTableHeader`) rather than a sort pill.
- Delete is soft-delete to the transaction trash (recoverable from Settings → Trash), confirmed before running — not a separate "hidden" state.
- **Apply reconciles the loaded rows in place** (hosts pass `setRows`), so the user's sort order and scroll position survive a bulk edit. Trashed rows drop; field changes (including recategorization that moves a row out of the current scope) are patched onto the visible rows and *linger* — a mis-tap stays correctable and a Refresh (where present) prunes rows that no longer match. A host whose source of truth is a paginated re-fetch (the Transactions ledger) passes `onReload` instead of `setRows`.
- **The edit panel is draggable** (`AppDialog draggable`): its backdrop is transparent and click-through and the header is a drag handle, so the form can be moved aside to read — and still act on — the ledger behind it. Position is session-only and re-centers on reopen.
- Wired on: the Transactions page, the Categories matching-transactions list, both Dashboard single-period drill tables (selected category, selected group), and the floating detail panels — MonthDetail, CategoryDetail, AccountDetail, ImportBatchDetail, and TagDetail (`'loaded'` strategy). The duplicate-detection dialog deliberately stays on its own `row_number`-keyed selection (its finite, non-server-filter selection doesn't fit this model).

**Applying a rule to existing rows reconciles the same way — in place, not by re-fetch.** When the per-row "create rule" toast (`RuleSuggestionToast`) applies a rule to existing transactions, the rows it recategorizes must update *on screen but stay on the list* — re-running a scoped query (e.g. an "uncategorized only" drill) would drop the now-recategorized rows out of view, which reads as the data silently vanishing or, worse, lingering with the old category. So the apply endpoint (`POST /rules/{id}/apply`) returns the **`transaction_ids` it changed**, threaded through the toast's `onSaved`, and the host calls the shared `reconcileRowsAfterRuleApply(rows, ids, setRows)` (`lib/txnMutations.js`): it re-fetches just the affected rows that are *currently on screen* by id (the transaction-list endpoint's `ids=` filter) and merges them back in place, so they keep their slot with the new category. Wired on the in-place surfaces that surface the toast — the Dashboard drills, the Categories matching list, and the payee `TransactionDetail`. The Transactions ledger is the deliberate exception: as the one paginated source of truth it stays on a full `load()` (matching its bulk-edit `onReload`).

If a list introduces the same kind of object the user already manages elsewhere, start from the existing row/chip behavior first. A lighter presentation is fine, but it should still preserve the same core expectations for clicking, editing, Enter/Escape, and removal.

## Pills and expanding selectors

Use compact pill-style controls for values like owner, account type, and other small categorical fields.

- Closed state: show the current value in a rounded pill sized to the text.

- Open state: expand into the space needed for the dropdown or selector.

- Avoid heavy full-width selects when the value itself is short.

- When open, overlays should render above nearby content rather than underneath it.

- Opening a selector should not change row height or shift surrounding rows.

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

- Recent-import file cards may use the same small `↗` detail affordance used elsewhere in the app to open a file-scoped ledger view of the transactions imported from that file. The same `↗` marks the other count pills that open a report (rejected rows, duplicates), so a pill that drills into a report is visually distinct from a static label pill (the account chips, which only describe what the file contained). Reuse the `↗` rather than restyling the whole pill; the glyph is the shared "opens a report" signal.

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

- **Inherited tag display:** tags inherited from a parent group render in italic without a remove `×` on the leaf's panel, since removing them at the leaf would not propagate; the user must edit the group's tags instead. On transaction rows, inherited tags use the outline tag glyph and a tooltip that names the source.

- **No transaction-level override of inherited tags yet:** if a transaction needs to opt out of an inherited tag, retag at the level the inheritance comes from. A future "block inherited" mechanism (parallel to the existing `manual_state` for direct tags) can be added when an actual case calls for it.

## Floating detail panels

Account, category, payee, single-month-transactions, and tag-signature detail drawers all share one shell (`DetailPanelShell` plus `useDetailPanelChrome` in `frontend/src/components/detailShared.jsx`). Anything new in the detail-panel family should plug into the same shell so the chrome and behavior stay consistent.

- **Open behavior.** Panels open docked at a sensible spot. The first drag converts them to floating, with a small stacking offset when more than one is open at once.

- **Resize.** Every edge and corner is a resize handle (the shared shell renders all eight; only the bottom-right corner carries a visible grip, the rest are cursor-advertised hit zones straddling the border in the exterior gutter so they don't sit over the body's scrollbar). Dragging a west or north edge also moves the panel's origin so the opposite edge stays anchored. The first resize gesture promotes the panel to floating geometry so size and position stay coherent. Min/max are clamped to keep the panel inside the viewport; size is session-only (not persisted).

- **Stacking and click-to-focus.** Z-index is managed by a single app-level registry in `frontend/src/contexts/PanelStackContext.jsx`. Every `DetailPanelShell` claims a slot via `usePanelStackSlot` on mount; the slot returns its current `zIndex`, an `isTopmost` flag for header styling, and a stable `bringToFront` callback. Clicking anywhere on a panel surface (`onMouseDownCapture` in the shell) lifts that panel to the front of the stack — works across panels rendered in different parts of the tree (e.g., the App-level duplicate-detection dialog and route-mounted batch/account/month panels coordinate through the same stack). Re-opening the same target focuses the existing panel rather than spawning a duplicate; if the target's payload differs from the existing panel's payload (e.g., the duplicate-report drill-through opens the same batch with vs. without a date filter), the existing panel's payload is replaced rather than ignored, so the second click reflects the new parameters.

- **A panel may open another panel.** A detail panel's inner transaction list can itself open a further detail panel — e.g. the merchant `↗` in `AccountDetail`'s month list opens the payee `TransactionDetail` (for the per-transaction origin/source info). It is hosted as a *child* of the opening panel, not by the page, so it lights up wherever that panel appears without per-page wiring and closes together with its parent; the shared stack registry still gives it its own z-order slot, so it stacks and focuses correctly despite being nested in the tree. Edits made in the child reconcile back into the parent's list. The deliberate trade-off is lifecycle coupling (closing the parent closes the child); use page-level sibling hosting instead when the opened panel must outlive its opener.

- **Edits inside a detail panel must reconcile back to whoever opened it — the full set, not a subset.** `TransactionDetail` (and the other editable drawers) only mutate their own local copy and the backend; the *host* is responsible for patching its on-screen row(s) via the panel's callbacks. The complete set is `onCategorized`, `onNotesSaved`, `onTagsChanged`, and `onTrashed` — a host that wires only some leaves the others silently stale (the page behind shows the old category/tag while the panel shows the new one, and reopening the panel re-passes the host's stale `txn` so even the panel's header goes stale while its re-fetched inner list looks correct). A host that holds the same row in more than one place (e.g. the Dashboard's two drill tables *and* its open-panel `txn` copies) must patch all of them in the callback. Every `TransactionDetail` host is expected to wire all four; add the matching callback whenever the panel gains a new editable field.

- **Dismissal.** Panels close on `×` in the header or Escape. Escape dismisses only the topmost panel, and the shared chrome (`DetailPanelShell`) suppresses it in two cases so it never destroys more than the user intends: when focus is in a text field (the inline editor reverts its own edit instead, so a half-finished note/name edit is never lost) and when a modal dialog is open above the panel (detected via the `data-modal-overlay` marker on `OverlayBackdrop` — the dialog owns Escape). Escape does *not* require focus to be inside the panel, because opening a panel by click leaves focus on the trigger in the page behind. Backdrop-click dismissal is intentionally avoided so a half-finished edit is not lost to a stray click.

- **Minimize-to-nav-bar.** Long-lived dialogs that the user wants to keep open while working elsewhere can offer a Minimize affordance instead of forcing a close. The pattern (see `MinimizedDuplicatesNavItem` in `UnifiedDuplicatesViewerContext.jsx`) is: a `minimized: true` flag on the dialog's state hides the floating panel without dropping any loaded data; a small pill appears in the nav bar showing the dialog's title plus a count of items needing attention; clicking the pill flips `minimized` back to false and the panel reappears at its prior position/size with its prior sort/selection preserved. State must be lifted out of the route tree (typically to an App-level context) so the dialog survives route navigation while minimized.

- **Persisted geometry.** Dialogs that the user routinely re-opens should remember their last-dragged position and size via `useUserPreference`. The persisted snapshot should include the viewport size at save time (`{pos, size, viewport: {width, height}}`); on restore, scale both position and size proportionally against the current viewport so a dialog saved bottom-right on a 1920×1080 monitor lands bottom-right on a 1280×720 laptop. The chrome's existing `clampPanelPosition` guarantees enough of the panel stays on-screen to grab even if a saved geometry would otherwise place it past the new viewport edge.

- **Auto-refresh on cross-page mutations.** Dialogs that show data that other pages can mutate (the duplicate-detection report's entries are affected by merges/renames on the Accounts page, etc.) should subscribe to a window-level event dispatched by the mutation site (`notifyAccountsChanged` in `App.jsx` is the pattern). Listeners debounce briefly and only refresh when the dialog is open *and* not currently loading. The `minimized` flag must survive these refreshes — minimize keeps the dialog stashed; an out-of-band refresh should never pop it back into view.

- **Date scope is caller-provided, never read from the global filter directly.** Detail panels (CategoryDetail, AccountDetail, the payee TransactionDetail, MonthDetail, TagDetail) take their date scope as props from whoever opens them — they must not call `useFilters()` to reach into the global date filter themselves. Only Dashboard and Transactions show the filter bar (`shouldShowFilterBar` in `App.jsx`), so only they pass the global date down; pages without the bar (Categories, Accounts) pass nothing. A panel that grabbed the global filter on its own would silently scope its data on pages that don't show that filter — a hidden filter that disagrees with un-scoped counts (the symptom that motivated this rule). When no date scope is passed, a panel chooses a sensible unfiltered default: the category trend slides a 36-month window to end at the category's most recent activity (`anchor=latest` on `/summary/monthly-trend`), while account and payee trends fall back to full history. The header label must describe the window actually shown (the trend's month span), not the global filter.

- **Default panel width** is sized to fit the standard transaction table without clipping the Amount column. New detail panels that host a transaction table should not override that down to a narrower value.

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

- **Click-on-chart-element to drill.** Bars on the dashboard's monthly-trend chart click through to a `MonthDetail` for that month; pie wedges on the Spending-by group/category/tag-report panels click through to either the next drill level (group → categories) or the appropriate transaction detail. Use the `cursor: 'pointer'` style on the clickable element so the drill affordance is discoverable; pair the chart click handler with the same handler the row legend uses so list and chart behave identically.

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
