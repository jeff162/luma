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

- [Ownership rules](#ownership-rules)

- [When to document a new pattern](#when-to-document-a-new-pattern)

## Product intent

FinTrack should feel polished, quiet, and immediately useful. The UI should support routine work in place rather than forcing separate admin or settings flows for common actions.

Polish is part of the feature, not a later cleanup step.

Baseline interaction expectations:

- overlays should open in the correct place on first paint

- menus and popovers should respect viewport edges and scroll containers

- controls should not jump, reflow, or visibly correct themselves after opening

- selectors and dialogs should render above surrounding content

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

- When a UI behavior is meant to be shared, implement the shared behavior first. Do not land a one-sided or page-specific version and plan to “sync it up” later unless the narrower scope is intentional and explicitly documented.

- Before changing a UI interaction, decide whether it is page-specific behavior or shared product language. Shared product language should be implemented and reviewed with parity across all affected surfaces from the start.

- Keep advanced and less-common settings below everyday workflows.

- Use inline editing for lightweight data changes; reserve dedicated forms or modals for multi-step or higher-risk actions.

- Treat transient edits as cancellable work. If a control enters a temporary edit state, the user should normally be able to back out without keeping the in-progress value, and similar transient controls should behave the same way across the app unless there is a strong reason to differ.

- Let the user control presentation where it materially helps them work. This includes things like panel placement, list scrolling, filtering, and other layout choices that improve usability without turning the app into a fully user-designed interface.

- Remember a user's working UI state across pages when it materially helps them resume work. Things like panel open/closed state, table layout, and similar view preferences should use the shared per-user/profile preference model with local cache plus best-effort backend sync, rather than one-off page-specific persistence.

- Prefer user control over hidden inference when the choice affects meaning. For example, ownership, mapping, and destructive actions should be explicit when there is more than one reasonable interpretation.

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

Inline row creation should usually happen inside the existing list, not in a detached panel above it.

## Pills and expanding selectors

Use compact pill-style controls for values like owner, account type, and other small categorical fields.

- Closed state: show the current value in a rounded pill sized to the text.

- Open state: expand into the space needed for the dropdown or selector.

- Avoid heavy full-width selects when the value itself is short.

- When open, overlays should render above nearby content rather than underneath it.

- Opening a selector should not change row height or shift surrounding rows.

For category assignment, prefer the shared category picker so transaction pages, import mapping, and any future category assignment flows behave the same way.

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

Do not rely on browser `confirm()` dialogs when the rest of the app has a clear UI style.

- Use in-app confirmation overlays for destructive actions like restore.

- Confirmation and completion steps in the same flow should use the same visual language.

- Avoid dismissing important confirmation modals by backdrop click if the user needs to make an explicit choice.

- Success dialogs should usually have one clear next step.

## Import-specific patterns

CSV import has a few special rules:

- If header rows start after line 1, show the raw file and make the skipped-row value match what the importer detected.

- If the file tail looks like footer or non-transaction data, force the user to review it before continuing.

- True validation errors should open the raw viewer as well; do not bury them only in summary counts.

- Use post-import mapping flows for imported category text instead of forcing everything into the initial import form.

- Mapping screens should allow partial completion when that is a valid workflow.

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

## Ownership rules

Ownership should be managed where it is most relevant:

- **Accounts page:** create, assign, rename, and delete account owners

- **Categories page:** manage category and group ownership

- **General rule:** avoid duplicate ownership editors in multiple places

Category ownership semantics differ from account ownership and should remain explicit:

- **Accounts:** explicit ownership only

- **Category groups:** can resolve to shared ownership when more than one personal owner exists

- **Child categories:** `owner\_id = NULL` means inheritance from the group

- **Explicit child ownership:** must not be rewritten when the group owner changes

## When to document a new pattern

Add to this document when:

- a pattern is used on more than one page

- a cleanup pass establishes a new “preferred” interaction

- repeated review comments or UI tweaks point to a missing convention

Do not add one-off exceptions unless they are likely to become reusable.

