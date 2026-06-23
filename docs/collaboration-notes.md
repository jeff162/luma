# Collaboration Notes

This document captures project-level working preferences that are broader than a single component or subsystem.

It is also the default home for agent-behavioral guidance — how to approach work on this repo — when a note does not clearly belong in `code-commenting-style.md`, `ui-patterns.md`, `architecture.md`, or `data-model.md`.

It is meant to help agents, and perhaps other contributors, make decisions that fit the direction of the project without needing the discussion history that led to them.

## Decision-Making Principles

**Calibrate care to blast radius.** How much rigor a decision warrants — how hard to verify it, whether to ask first, how conservative to be — scales with how reversible it is, how likely the user is to *notice* if it's wrong, and how costly it would be to undo later. Cheap + reversible + visible: act, and say what you did. Irreversible, *or* hard for the user to observe, *or* expensive to unwind: slow down — prefer the reversible option, surface the decision before committing, and verify to the point of *proof*. Confirm the change actually behaves; don't accept a result that is merely consistent with success (a passing check you have never watched fail proves little). This is the dial behind the more specific principles in this section — they are what "slow down" looks like in practice.

A key input to that dial: the user does not review most of the code directly and, even if they did, is unlikely to catch frontend/UI or backend problems even when looking. Changes the user can't easily observe or exercise are therefore **low-observability by default**, which by itself raises the bar — for those, the user's review cannot be the backstop, so you are. Prove the behavior and flag the non-obvious choices you made rather than relying on "they'll catch it."

- Prefer explicit user choice over hidden inference when a decision changes meaning.

- If there is exactly one strong likely match, surfacing it as a suggested default is fine. If there is real ambiguity, do not silently choose for the user.

- Avoid silent guesses that are hard for the user to notice later. Suggested values should be visible as suggestions, not disguised as confirmed choices.

- Favor workflows that are understandable and reversible. A user should usually be able to see what happened, back out of it, or correct it without needing cleanup work.

- Accept small asymmetries when two workflows are genuinely different. Consistency matters, but not at the cost of forcing every path into the same shape when the user intent is different.

- Do not add defensive complexity unless it has a clear payoff. Recovery behavior for unusual or corrupt states can be noted for future consideration without being implemented immediately.

- Schema changes currently land directly in `init_db` (fresh-install schema only); there is no in-place migration chain since the Luma rebrand break point. See "Schema evolution" in `docs/data-model.md` before reintroducing one.

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

- Treat an agreed decision as a *pattern*, not just the cases named while discussing it. When implementing it, sweep for analogous paths, handlers, or screens that fit the same intent and extend the decision to them — where it is a genuine match and low-risk (e.g. idempotent) — rather than wiring only the literal list. Then name those extensions in the change summary so they can be confirmed or scoped back. Do not use this to smuggle in behavior changes that were never reasoned about; the bar is "the same decision obviously applies here too."

- Before building a new surface — especially modals, detail panels, pill-header tables, selectors, or anything that touches a shared component — find the closest existing implementation and read it. The Import / Export duplicate-rows and rejected-rows dialogs are the reference for modal transaction viewers; `detailShared.jsx` is the reference for detail drawers; `PillGridTable` and its consumers are the reference for interactive tables. Matching the established shape is the normal path; diverging from it should be a deliberate, stated choice.

- Do not use shared components (`TransactionListTable`, `detailShared`, `PillGridTable`, `ui.jsx`, `TransactionRow.jsx`, shared interaction hooks) as workaround surface for a single page's problem. Changes there ripple across the app. If a page needs behavior the shared component does not support, either extend the shared component deliberately with a clear contract, or solve it at the page level — not by tweaking the shared internals until the one caller looks right.

- If a fix requires a patch to a shared component (new prop, overflow tweak, padding change, style override) to make one page behave, that is a signal the approach is wrong. Stop, re-read the reference implementation, and rework the page-level code instead.

## Testing

- **Test harnesses available (use the lightest one that exercises the behavior).**
  - *Frontend — vitest, colocated in a `__tests__/` folder beside the code* (`src/lib/__tests__/foo.test.js` for `src/lib/foo.js`; keeps tests out of the module listing, keeps imports short; the `include` glob is broad so a misplaced test still runs). Default env is Node for pure `src/lib` decision logic; a test that needs the DOM opts in per-file with `// @vitest-environment jsdom` and renders via `@testing-library/react` (see `components/__tests__/TransientTextInput.test.jsx`). React hooks with no DOM can also use `react-test-renderer` in the Node env (see `UserPreferencesContext.test.jsx`).
  - *Frontend — Playwright* (`tests/ui/*.spec.js`, `npm run ui:test`) for full end-to-end browser flows. Self-contained: `playwright.config.js` boots an isolated throwaway backend+frontend on dedicated ports (temp DBs via `LUMA_ENV_FILE` — never touches real data), and `tests/globalSetup.js` seeds one preference profile to clear onboarding. Specs share one DB per run, so clear shared state in a `beforeEach`. Convention: `.test.*` = vitest, `.spec.*` = Playwright.
  - *Backend — pytest under `backend/tests`* (run with the backend venv). Two styles: **direct router/service calls** scoped with `set_current_db_path` for business logic (fast, the default), and a **full-stack `TestClient` harness** (`tests/_api_client.py`) for things only the real stack does — routing, the tenant-session middleware, `Query()` default resolution, request-body/response serialization (see `test_api_contract.py`). `tests/_query_count.py` traces SQL so a test can assert a batch op stays O(1) queries, not N+1 (see `test_categorizer_perf_contract.py`).
  - Backend test deps (`pytest`, `httpx`) are pinned in `pyproject.toml` under `[project.optional-dependencies].test` and mirrored in `requirements-test.txt`. The backend runs from source (not an installed package, so `pip install -e ".[test]"` doesn't apply); `requirements.txt` + `requirements-test.txt` are the real install path — `pip install -r requirements-test.txt`.

- Test by value, not reflexively: cover recurrence-prone bugs, invariants/contracts, tricky conditions, and cross-component interactions — not every one-off fix. But when a test *is* worth writing, its fixture and assertions must actually exercise what it claims. **A fixture smaller than the behavior under test is a false sense of safety, not coverage** — a minimal hand-built dataset only catches the shapes you happened to insert.

- For **round-trip / serialization / backup / migration** tests, completeness is the whole point. Populate every relevant table/field and the awkward shapes that break on real data — self-referential FKs (a merged child account), forward-reference FKs (an imported category pointing at its import batch), nullable-but-set FKs, nested/merged rows — or build the fixture by driving the real creation flows. Assert the full result (counts/rows, or a golden-file snapshot) rather than a single field. `backend/tests/test_import_duplicate_detection.py` (drives real imports + asserts expected-ledger snapshots) is the reference; `backend/tests/test_backup_restore.py` shows the complete-fixture pattern.

- Add a guard that fails on omission wherever one is possible — e.g. derive the table list from `sqlite_master` and assert every data table is represented in the backup payload, so "added a table, forgot to back it up" trips the suite instead of relying on someone remembering.

- Prove a new check actually fires: before trusting a guard or test to pass, confirm it *fails* on the known-bad input (revert the fix and watch it go red), then restore.

## Code Structure Preferences

- Prefer shared components when multiple screens are intended to behave the same way. This is especially important for selectors, dialogs, mapping controls, and other interaction-heavy UI.

- Keep page-specific state where it belongs, but extract repeated rendering and interaction rules into shared helpers or components.

- Do not refactor purely for abstraction. Shared code should be introduced when it clearly reduces drift, repeated bug fixes, or inconsistent behavior.

- When a bug appears in one copy of a repeated interaction, treat that as a signal to check whether the behavior should be shared more centrally.

## Naming And Brand Hygiene

There are two different bars here, one stricter than the other:

- **UI copy, comments, docstrings:** keep specific real product/company/bank names out — use generic wording ("most banks", "a debit/credit type column") rather than naming "Chase", "Mint", "Fidelity" as flavor. The one exception is a real integration the code actually talks to, where the name *is* the technical fact (e.g. Plaid) — naming Plaid is correct.

- **Test data / fixtures:** large, well-established, generic-type vendors are fine and can make fixtures readable (Amazon, Starbucks, Netflix, etc.). What to avoid is **PII** and **very niche or personal-specific vendors** — a specific local business, a government office tied to a real place, or a product name that mirrors the user's own accounts. Genericize those personal-specific parts ("Rewards Card" / "Cashback Card" for cards, "Credit Card" / "Legacy Card" for an umbrella account) and describe the scenario's *shape* generically in comments ("a legacy umbrella account that physically maps to two real cards") rather than naming the real products involved.

## Error Handling Preferences

- When refusing an action is the right behavior, prefer a clear in-app explanation over clever automatic renaming or silent repair.

- If a save fails but the user can fix the problem, keep the current screen open and explain what needs to change.

- Use backend validation for rules that must apply across multiple entry points.

## Documentation Expectations

- `CLAUDE.md` is the always-loaded entry point, so it must stay lean: a minimal *read-first* routing map — the trigger for consulting docs (work *and* questions touching shared systems, persistence, invariants, or shared UI) plus a one-line index of which doc covers what. Detailed rules and rationale belong in `AGENTS.md` and the `docs/`, never copied into `CLAUDE.md`. The routing index is filename + terse scope only (low-drift); when a doc's purpose changes, update the index line, not its content.

- Keep `AGENTS.md` focused on stable repo-wide instructions.

- Keep `architecture.md`, `data-model.md`, and `ui-patterns.md` aligned with real shared systems and invariants.

- Use this file for collaboration preferences and decision rules that affect implementation choices across the app but do not belong in the formal architecture or schema docs.
