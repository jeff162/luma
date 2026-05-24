# UI Patterns

This document records the UI patterns FinTrack should prefer. It is not a full design system; it is a working reference for visual and interaction consistency.

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

- [When to document a new pattern](#when-to-document-a-new-pattern)

## Product intent

FinTrack should feel polished, quiet, and immediately useful. The UI should support routine work in place rather than forcing separate admin or settings flows for common actions.

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

- Favor consistency over novelty. When a control already exists elsewhere in the app, reuse the same interaction and styling unless there is a strong reason not to.

- Keep look and feel consistent across pages. Similar data structures should use the same spacing, controls, and interaction patterns so the app feels like one coherent tool rather than a set of isolated screens.

- Treat repeated UI elements as shared product language. Trees, pills, menus, inline editors, overlays, tables, selectors, and other controls that appear on more than one page should keep the same look, spacing, and behavior unless there is a very strong reason to diverge.

- Treat recurring domain objects as shared product language too. When a user, account owner, category, account, or similar named thing appears on multiple screens, its basic add/edit/remove behavior should feel the same unless the workflow is genuinely different.

- The reason for this consistency is not only aesthetics. Reusing the same interaction language lowers relearning cost, makes the product feel more trustworthy, and avoids the impression that one screen is a lesser or temporary version of another.

- Shared form controls and dialog footers should come from shared primitives where possible so cancel/save rows and everyday input chrome do not drift across pages.

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

- When column order or widths materially affect how a user works, that table geometry should persist through the shared per-user preference model instead of resetting every time the page or dialog opens.

- Transaction troubleshooting can temporarily repurpose a less-critical column, such as Category, for debug context like the import-file source, but it should not displace the primary merchant label. Prefer a tucked-away header action such as a context menu over a persistent page-level button for these uncommon views, and reuse the same file-detail drill-in wherever an import file source is shown.

## Page structure

Most pages should follow this structure:

1. A `PageHeader` at the top.

2. One or more `Card` blocks or list/table regions underneath.

3. Primary actions placed near the data they affect.

4. Scroll inside long data regions when the list grows large, rather than making the whole page excessively tall.

Prefer page-local scrolling for long lists, with header and controls remaining visually stable above the scrolling region.

## Tree views

Tree views should use the same visual grammar wherever they appear.

- Each child level should begin under the first letter of the label above it.

- The hierarchy should read primarily through label alignment rather than heavy guide lines or decorative chrome.

- Controls that belong to a row may sit to the left of that label start, but the text alignment should define the structure of the tree.

- Expand/collapse controls should stay close to the label they affect.

- On the Accounts page, merged child accounts should read as a lightweight second level under the parent account rather than as a second flat table with repeated owner/type columns.

- Protected system groups, such as `Unassigned` on the Categories page, should behave like filtered fallback buckets rather than normal editable groups. They should stay at the bottom of their section and only surface children that currently have assigned transactions.

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

## Transaction rows

Transaction tables should share the same row-level metadata treatment.

- Notes and transaction tags belong in a shared marker strip near the amount column rather than being rendered differently on each page.

- Tags should use one fixed shared glyph, with user-selected color carrying the visual identity.

- Hovering a tag marker should reveal its label, and clicking row markers should use the shared inline popover patterns instead of page-local dialogs.

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

- When local mode is active and no user profiles exist yet, setup may collect several related defaults at once if they help the user get started: who uses the app, optional account owners, default imported-category behavior, and what setup screen to open next.

- First-run setup should not feel like a wall of options. Prefer compact collapsed decision blocks for secondary choices, with the minimum required action remaining clear.

- Deeper onboarding guidance should be available from the same screen, but tucked behind a deliberate `More information` or similar affordance so users who only want to get started are not forced to read it first.

## Import-specific patterns

CSV import has a few special rules:

- If header rows start after line 1, surface the detected skipped-row value immediately and offer the raw file as an explicit review step rather than forcing it open by default.

- If the file tail looks like footer or non-transaction data, force the user to review it before continuing.

- True validation errors should open the raw viewer as well; do not bury them only in summary counts.

- If a file already carries meaningful categories, the import mapping screen should let the user use the categories present in the data so imported transactions can keep those categories, missing categories can be added under `Unassigned`, and the file can contribute to system-wide rule suggestions.

- Controls for using categories present in the data should support partial filtering by owner and by unassigned-account bucket without changing which rows are imported. The scope changes only how imported categorization is applied and learned from.

- Organizing imported categories out of `Unassigned` should use the dedicated left-column/right-column workspace from Import / Export so users can sort categories into groups in bulk without working through the general category editor.

- The Import-page actions for organizing imported categories and generating rules should show the remaining actionable count. Categories moved to `Set Aside` in the imported-category workspace should stop counting as still waiting in `Unassigned`.

- Mapping screens should allow partial completion when that is a valid workflow.

- The column-mapping field section should be shared between the import preview and saved data source editing so suggestion pills, required states, and account mapping behavior stay aligned.

- Recent-import file cards may use the same small `↗` detail affordance used elsewhere in the app to open a file-scoped ledger view of the transactions imported from that file.

### Import mapping persistence

Import mapping persistence has two layers:

- **Import profile/filter:** source of truth for provider-level reusable mapping behavior

- **Local draft:** fallback only for the no-profile/manual case

When a profile matches, it should carry reusable import workspace state, including:

- column mapping

- account mapping and skips

- category mappings

- category mapping workspace state such as `Set Aside`

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

- **Inherited tag display:** tags inherited from a parent group render in italic without a remove `×` on the leaf's panel, since removing them at the leaf would not propagate; the user must edit the group's tags instead. On transaction rows, inherited tags use the outline tag glyph and a tooltip that names the source.

- **No transaction-level override of inherited tags yet:** if a transaction needs to opt out of an inherited tag, retag at the level the inheritance comes from. A future "block inherited" mechanism (parallel to the existing `manual_state` for direct tags) can be added when an actual case calls for it.

## When to document a new pattern

Add to this document when:

- a pattern is used on more than one page

- a cleanup pass establishes a new “preferred” interaction

- repeated review comments or UI tweaks point to a missing convention

Do not add one-off exceptions unless they are likely to become reusable.
