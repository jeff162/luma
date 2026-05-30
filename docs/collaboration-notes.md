# Collaboration Notes

This document captures project-level working preferences that are broader than a single component or subsystem.

It is also the default home for agent-behavioral guidance — how to approach work on this repo — when a note does not clearly belong in `code-commenting-style.md`, `ui-patterns.md`, `architecture.md`, or `data-model.md`.

It is meant to help agents, and perhaps other contributors, make decisions that fit the direction of the project without needing the discussion history that led to them.

## Decision-Making Principles

- Prefer explicit user choice over hidden inference when a decision changes meaning.

- If there is exactly one strong likely match, surfacing it as a suggested default is fine. If there is real ambiguity, do not silently choose for the user.

- Avoid silent guesses that are hard for the user to notice later. Suggested values should be visible as suggestions, not disguised as confirmed choices.

- Favor workflows that are understandable and reversible. A user should usually be able to see what happened, back out of it, or correct it without needing cleanup work.

- Accept small asymmetries when two workflows are genuinely different. Consistency matters, but not at the cost of forcing every path into the same shape when the user intent is different.

- Do not add defensive complexity unless it has a clear payoff. Recovery behavior for unusual or corrupt states can be noted for future consideration without being implemented immediately.

-This project is still single-user/development-stage, so we should prefer clean implementations over compatibility work for hypothetical existing users

-schema changes should normally use migrations

-if schema history or migration becomes more costly than helpful, resetting the base schema and trimming old migrations is acceptable

## UI And Interaction Preferences

- Prefer in-app dialogs, confirmations, and editing panels over browser-native `alert()`, `confirm()`, and `prompt()` when the app already has a clear visual language.

- Shared UI behavior should come from shared components or shared logic, not from repeated page-specific copies that must be kept in sync manually.

- If a UI behavior is meant to be shared, implement the shared version rather than fixing one copy and planning to catch up later.

- Required user actions should be visually clear. If a screen is waiting on the user to make a choice, the next step should read naturally from the layout, not just from helper text.

- Overlay panels should feel deliberate: they should open in sensible positions, be visually distinct from panels behind them, and not disappear unless the user explicitly dismisses them when the decision matters.

- When a new screen introduces an existing domain object such as a user, account owner, category, or account, start by checking how that object already behaves elsewhere in the app. Reusing the established interaction is usually better than inventing a local variant.

- The reasoning matters here: users learn objects more than they learn pages. If the same object edits differently on each screen, the product feels less coherent and small “special case” implementations are more likely to drift into bugs or inconsistent fixes later.

## Import / Export Preferences

- Import mapping should help without overreaching. The system may infer likely mappings, date formats, and amount conventions, but ambiguous mappings should remain for the user to accept explicitly.

- When a selected data source does not match a file, recovery should start from the current file rather than forcing stale saved mappings onto it.

- Temporary drafts are real working state, not second-class placeholders. They should be visible, recoverable, and easy to distinguish from saved data sources.

- Long-lived import history should stay compact. Detailed per-row review data is useful, but it should be stored and loaded in a way that does not make ordinary history cards heavy.

## Agent Working Habits

- This project is aiming for high-quality code under the covers, not just something that works. Get it right the first time rather than landing a fix and iterating toward correct. If the right shape is not yet clear, investigate until it is before writing code.

- Before building a new surface — especially modals, detail panels, pill-header tables, selectors, or anything that touches a shared component — find the closest existing implementation and read it. The Import / Export duplicate-rows and rejected-rows dialogs are the reference for modal transaction viewers; `detailShared.jsx` is the reference for detail drawers; `PillGridTable` and its consumers are the reference for interactive tables. Matching the established shape is the normal path; diverging from it should be a deliberate, stated choice.

- Do not use shared components (`TransactionListTable`, `detailShared`, `PillGridTable`, `ui.jsx`, `TransactionRow.jsx`, shared interaction hooks) as workaround surface for a single page's problem. Changes there ripple across the app. If a page needs behavior the shared component does not support, either extend the shared component deliberately with a clear contract, or solve it at the page level — not by tweaking the shared internals until the one caller looks right.

- If a fix requires a patch to a shared component (new prop, overflow tweak, padding change, style override) to make one page behave, that is a signal the approach is wrong. Stop, re-read the reference implementation, and rework the page-level code instead.

## Code Structure Preferences

- Prefer shared components when multiple screens are intended to behave the same way. This is especially important for selectors, dialogs, mapping controls, and other interaction-heavy UI.

- Keep page-specific state where it belongs, but extract repeated rendering and interaction rules into shared helpers or components.

- Do not refactor purely for abstraction. Shared code should be introduced when it clearly reduces drift, repeated bug fixes, or inconsistent behavior.

- When a bug appears in one copy of a repeated interaction, treat that as a signal to check whether the behavior should be shared more centrally.

## Error Handling Preferences

- When refusing an action is the right behavior, prefer a clear in-app explanation over clever automatic renaming or silent repair.

- If a save fails but the user can fix the problem, keep the current screen open and explain what needs to change.

- Use backend validation for rules that must apply across multiple entry points.

## Documentation Expectations

- `CLAUDE.md` is the always-loaded entry point, so it must stay lean: a minimal *read-first* routing map — the trigger for consulting docs (work *and* questions touching shared systems, persistence, invariants, or shared UI) plus a one-line index of which doc covers what. Detailed rules and rationale belong in `AGENTS.md` and the `docs/`, never copied into `CLAUDE.md`. The routing index is filename + terse scope only (low-drift); when a doc's purpose changes, update the index line, not its content.

- Keep `AGENTS.md` focused on stable repo-wide instructions.

- Keep `architecture.md`, `data-model.md`, and `ui-patterns.md` aligned with real shared systems and invariants.

- Use this file for collaboration preferences and decision rules that affect implementation choices across the app but do not belong in the formal architecture or schema docs.
