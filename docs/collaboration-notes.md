# Collaboration Notes

This document captures project-level working preferences that are broader than a single component or subsystem.

It is also the default home for agent-behavioral guidance — how to approach work on this repo — when a note does not clearly belong in `code-commenting-style.md`, `ui-patterns.md`, `architecture.md`, or `data-model.md`.

It is meant to help agents, and perhaps other contributors, make decisions that fit the direction of the project without needing the discussion history that led to them.

## Decision-Making Principles

**Calibrate care to blast radius.** How much *process* a decision warrants — how hard to verify it, whether to ask first, how much to surface before committing — scales with how reversible it is, how likely a wrong result is to be *noticed*, and how costly it would be to undo later. Cheap + reversible + visible: act, and say what you did. Irreversible, *or* hard to observe, *or* expensive to unwind: slow down — where two designs are otherwise equally sound prefer the one easier to unwind, surface the decision before committing, and verify to the point of *proof*. Confirm the change actually behaves; don't accept a result that is merely consistent with success (a passing check you have never watched fail proves little). This is the dial behind the more specific principles in this section — they are what "slow down" looks like in practice.

**The dial governs process, never quality.** Reversibility is a reason to ask less and verify less. It
is never a reason to accept a worse change: a change is right when it accomplishes the goal *and* is
clean and well-structured, and "easy to undo" substitutes for neither. Nor is "they will say if it's
wrong" a verification strategy. The inversion is the one to watch for, because it reads backwards — a
local patch is often easy to reverse *because* it doesn't integrate, which is the same property that
makes it the wrong change. Where the correct fix is large, deep, or crosses subsystems, that is a
reason to surface it and its scope, not a reason to prefer the shallow one.

A key input to that dial: most code here is not reviewed line by line, and UI or backend defects are unlikely to be caught by reading even when someone looks. Changes that cannot easily be observed or exercised are therefore **low-observability by default**, which by itself raises the bar — for those, review cannot be the backstop, so you are. Prove the behavior and flag the non-obvious choices you made rather than relying on "they'll catch it."

**"Verify to the point of proof" does not authorize a *headed* browser session.** This is the loophole to name explicitly: a high-blast-radius or low-observability *UI* change makes it tempting to read "prove it behaves" as "drive the app by hand to be sure." The headless suites are the opposite case and are expected — `npm run ui:test*`, `npm run ui:smoke` and a scripted headless session boot their own isolated stack and report results that can be read — so writing a spec and running it *is* the proof path for UI behavior. What waits for explicit permission is the headed form: `--headed`, `--debug`, `ui:codegen`, or a hand-driven `npm run dev` (hard rule in `CLAUDE.md` / `AGENTS.md`). What no suite can judge is whether a screen *looks* right, and for that the exercise goes to the user — say precisely what to click and what correct looks like. Rigor scales with blast radius; the method still never includes a headed session nobody agreed to.

**A term with both an everyday meaning and a narrower in-app one must signal which is in force**,
unless it plainly reads as a term of art. Writing to the application's internal definition is not a
defense when the ordinary sense is what a reader arrives with: "each account belongs to at most one
owner" is true of the `owner` table and false of people, because a Shared account really does belong to
two of them. Naming the set — "at most one of the defined owners" — is what makes it a claim about
configuration rather than about households. The discipline already holds for the term where a collision
would hurt most: a login identity is a **user**, or a **member** where the household is what is meant —
never an "account", which would collide with a bank account, and never a "profile", which on the import
side is a saved data source.

- Prefer explicit user choice over hidden inference when a decision changes meaning.

- If there is exactly one strong likely match, surfacing it as a suggested default is fine. If there is real ambiguity, do not silently choose for the user.

- Avoid silent guesses that are hard for the user to notice later. Suggested values should be visible as suggestions, not disguised as confirmed choices.

- Favor workflows that are understandable and reversible. It should usually be possible to see what happened, back out of it, or correct it without needing cleanup work.

- Accept small asymmetries when two workflows are genuinely different. Consistency matters, but not at the cost of forcing every path into the same shape when the user intent is different.

- Do not add defensive complexity unless it has a clear payoff. Recovery behavior for unusual or corrupt states can be noted for future consideration without being implemented immediately.

- Schema changes land in **two** places, and omitting either one breaks a real install: the baseline `CREATE` in `init_db` (what a fresh database is built from) *and* a registered `@migration(version)` (what advances an existing one). The migration runner is active — see "Schema evolution" in `docs/data-model.md`. What was dropped at the Luma rebrand break point was the *pre-rebrand* chain, not migrations as such. Register the migration and bump `CURRENT_VERSION` **last**, after the code that uses the column is in place, so a reloading dev server cannot half-apply it.

## UI And Interaction Preferences

- **Settings is a staging area, not a home.** A few things genuinely belong there, but for the most part it is where work-in-progress is parked while a feature is built — so when a surface has a natural home beside the thing it affects, put it there rather than in Settings. The worked example: backup-key management moved from Settings onto the Backup page, next to the button it is a precondition for, because it is used by nothing else and a precondition two pages from its action reads as unrelated configuration. Prefer moving over mirroring — two homes for one control is exactly the drift the code-structure preferences below warn about.

- Prefer in-app dialogs, confirmations, and editing panels over browser-native `alert()`, `confirm()`, and `prompt()` when the app already has a clear visual language.

- Shared UI behavior should come from shared components or shared logic, not from repeated page-specific copies that must be kept in sync manually.

- If a UI behavior is meant to be shared, implement the shared version rather than fixing one copy and planning to catch up later.

- Required user actions should be visually clear. If a screen is waiting on a choice, the next step should read naturally from the layout, not just from helper text.

- Overlay panels should feel deliberate: they should open in sensible positions, be visually distinct from panels behind them, and not disappear unless explicitly dismissed when the decision matters.

- **Flicker and layout jitter are defects, not cosmetics — they are actively distracting, and belong removed wherever they appear or, better, not created in the first place.** Most operations here are local and return in a few milliseconds, so an indicator bound straight to a `loading` flag reports nothing and just repaints the screen. Two rules follow, both in `ui-patterns.md` with the components that implement them: an announcement waits until the work has outlasted a delay and then stays long enough to be read (`useBusyIndicator`), and a reload keeps what is on screen rather than swapping it for a spinner (`{loading && rows.length === 0 ? <Spinner/> : rows}`, or `StaleWhileRefreshing` where the held content would otherwise claim to be current). Prefer removing the layout change over deferring it. When a fix in this area is asked for, look for the same shape elsewhere rather than patching the one instance reported.

- **Calibrate destructive styling to reversibility, not to how alarming the action sounds.** Reserve `danger` (red) for what cannot be undone; an action that is reversible with effort — re-linking a bank, re-syncing history that a cursor reset will pull back — is not danger even when it deletes rows, and its red belongs on the *confirm button*, where the click that actually does the thing lives. Spending the color on recoverable actions leaves nothing to mark the permanent ones. The name is not the signal: "Remove synced transactions" reads worse than "Disconnect" and is the more recoverable of the two.

- Removing an affordance is a real answer, and usually the preferred one. When a control's job is already done automatically at the moment that matters, the control should go rather than be kept "just in case" or relocated — and a picker should offer the choices someone would actually make, not every choice the data model permits. Ask what the affordance still uniquely accomplishes; if the honest answer is a corner case or a variation nobody would deliberately choose, drop it and say what capability that costs. A surface earns density by need, not by completeness.

- When a new screen introduces an existing domain object such as a user, account owner, category, or account, start by checking how that object already behaves elsewhere in the app. Reusing the established interaction is usually better than inventing a local variant.

- The reasoning matters here: users learn objects more than they learn pages. If the same object edits differently on each screen, the product feels less coherent and small “special case” implementations are more likely to drift into bugs or inconsistent fixes later.

## Import / Export Preferences

- Import mapping should help without overreaching. The system may infer likely mappings, date formats, and amount conventions, but ambiguous mappings should remain for the user to accept explicitly.

- When a selected data source does not match a file, recovery should start from the current file rather than forcing stale saved mappings onto it.

- Temporary drafts are real working state, not second-class placeholders. They should be visible, recoverable, and easy to distinguish from saved data sources.

- Long-lived import history should stay compact. Detailed per-row review data is useful, but it should be stored and loaded in a way that does not make ordinary history cards heavy.

## Agent Working Habits

- This project is aiming for high-quality code under the covers, not just something that works. Get it right the first time rather than landing a fix and iterating toward correct. If the right shape is not yet clear, investigate until it is before writing code.

- For workflow changes that touch generated state, persisted review state, rules, imports, categorization, or undo/return paths, do a short design pass before implementation. This is not ceremony; it is how to avoid local fixes in a state machine. The pass should name every affected surface (for example pending cards, conflict cards, accepted/saved cards, rule editors, selection/match editors, matching reports, save/apply flows, undo, and return-to-pending), then write the lifecycle table in plain language: each state, what owns the rows, what owns any created rule, what `source_row_ids` mean in that state, and what should happen when criteria are broadened or narrowed, or the flow is backed out. If this model cannot be stated crisply, stop and ask or keep investigating before changing code.

- If an implementation limitation would make a UI action mean less, more, or something different from what its label naturally implies, stop and surface the semantic choice. Do not silently hide, narrow, broaden, or reroute the action as a workaround. If choosing a conservative interim behavior, name it in the final summary as a product decision and explain the omitted alternative.

- Treat "edit selection criteria" / "edit match" on imported rule suggestions as a persisted partition/regeneration operation, not a UI-only edit. It can split a conflict set, orphan rows into follow-up suggestions, merge formerly scoped suggestions back into canonical generation, affect matching reports, and change what save/undo/return-to-pending must restore. Backend tests should cover those transitions before or alongside UI work; do not rely on browser inspection to discover the state model.

- Treat an agreed decision as a *pattern*, not just the cases named while discussing it. When implementing it, sweep for analogous paths, handlers, or screens that fit the same intent and extend the decision to them — where it is a genuine match and low-risk (e.g. idempotent) — rather than wiring only the literal list. Then name those extensions in the change summary so they can be confirmed or scoped back. Do not use this to smuggle in behavior changes that were never reasoned about; the bar is "the same decision obviously applies here too."

- Before building a new surface — especially modals, detail panels, pill-header tables, selectors, or anything that touches a shared component — find the closest existing implementation and read it. The Import / Export duplicate-rows and rejected-rows dialogs are the reference for modal transaction viewers; `detailShared.jsx` is the reference for detail drawers; `PillGridTable` and its consumers are the reference for interactive tables. Matching the established shape is the normal path; diverging from it should be a deliberate, stated choice.

- Do not use shared components (`TransactionListTable`, `detailShared`, `PillGridTable`, `ui.jsx`, `TransactionRow.jsx`, shared interaction hooks) as workaround surface for a single page's problem. Changes there ripple across the app. If a page needs behavior the shared component does not support, either extend the shared component deliberately with a clear contract, or solve it at the page level — not by tweaking the shared internals until the one caller looks right.

- If a fix requires a patch to a shared component (new prop, overflow tweak, padding change, style override) to make one page behave, that is a signal the approach is wrong. Stop, re-read the reference implementation, and rework the page-level code instead.

## Testing

- **Test harnesses available (use the lightest one that exercises the behavior).**
  - *Frontend — vitest, colocated in a `__tests__/` folder beside the code* (`src/lib/__tests__/foo.test.js` for `src/lib/foo.js`; keeps tests out of the module listing, keeps imports short; the `include` glob is broad so a misplaced test still runs). Default env is Node for pure `src/lib` decision logic; a test that needs the DOM opts in per-file with `// @vitest-environment jsdom` and renders via `@testing-library/react` (see `components/__tests__/TransientTextInput.test.jsx`). React hooks with no DOM can also use `react-test-renderer` in the Node env (see `UserPreferencesContext.test.jsx`).
  - *Frontend — Playwright* (`tests/ui/*.spec.js`, `npm run ui:test`) for full end-to-end browser flows. **Headless, and expected to be run** — writing a spec and not running it is how unverified specs ship; the hard rule now gates only the *headed* forms. Self-contained: `playwright.config.js` boots an isolated throwaway backend+frontend on dedicated ports (temp DBs via `LUMA_ENV_FILE` — never touches real data), and `tests/globalSetup.js` signs in and loads the demo dataset, parking the session in `tests/.auth/` for `use.storageState` so a spec's `request` fixture is as authenticated as a click. The run is ordered phases (`app` → `demo-cleared` → `import` → `a11y`) because two of the lanes clear shared state; specs share one DB within a phase, so clear what you need in a `beforeEach` and leave the demo baseline as you found it. Convention: `.test.*` = vitest, `.spec.*` = Playwright.
  - *Backend — pytest under `backend/tests`* (run with the backend venv). Two styles: **direct router/service calls** scoped with `set_current_db_path` for business logic (fast, the default), and a **full-stack `TestClient` harness** (`tests/_api_client.py`) for things only the real stack does — routing, the tenant-session middleware, `Query()` default resolution, request-body/response serialization (see `test_api_contract.py`). `tests/_query_count.py` traces SQL so a test can assert a batch op stays O(1) queries, not N+1 (see `test_categorizer_perf_contract.py`).
  - Backend test deps (`pytest`, `httpx`) are pinned in `pyproject.toml` under `[project.optional-dependencies].test` and mirrored in `requirements-test.txt`. The backend runs from source (not an installed package, so `pip install -e ".[test]"` doesn't apply); `requirements.txt` + `requirements-test.txt` are the real install path — `pip install -r requirements-test.txt`.

- **A surface that loads when it opens should be tested under `StrictMode`, because that is what the app runs.** `main.jsx` wraps the tree in it, so in development every effect is mounted, torn down, and mounted again — while a plain `render()` in vitest mounts once and cannot see the difference. The failure that motivates this is silent and total: an effect guarded by *both* a "fetch only once" ref **and** a cancel flag deadlocks, because the teardown cancels the first run's closure and the ref turns the second run into a no-op, leaving the surface on its loading state forever holding a response it was told to ignore. Every test passed against it. Pick one guard — the cancel flag — and let a remount re-fetch; a duplicate GET in development is the trade StrictMode exists to make. `SplitEditorDialog.test.jsx` carries the regression test in the form worth copying: render inside `<StrictMode>` and assert the loaded content appears.

- Test by value, not reflexively: cover recurrence-prone bugs, invariants/contracts, tricky conditions, and cross-component interactions — not every one-off fix.

- **Weigh value and cost separately, and keep the two kinds of cost apart.** Value stands on its own terms: is the property recurrence-prone, is it an invariant, would a silent regression be expensive to discover later. *Build* cost is one-time and a genuinely valuable property justifies paying it however awkward the instrumentation — difficulty observing something is not evidence it is not worth pinning, and some of the most valuable properties are exactly the ones that need a probe to see. *Run* cost recurs forever, on every suite run and every wait for it, so that is the one to be stingy about: a slow or flaky test is a tax that keeps being charged. The failure mode to avoid is letting build cost quietly stand in for low value, which argues away precisely the tests that are hard to write because they matter.

- Well-structured code and tests are not substitutes. Careful structure can make a property evident enough that a test adds little — but that is a judgment about *that property*, not a general discount, and it does not apply to properties whose violation would be silent. But when a test *is* worth writing, its fixture and assertions must actually exercise what it claims. **A fixture smaller than the behavior under test is a false sense of safety, not coverage** — a minimal hand-built dataset only catches the shapes you happened to insert.

- For **round-trip / serialization / backup / migration** tests, completeness is the whole point. Populate every relevant table/field and the awkward shapes that break on real data — self-referential FKs (a merged child account), forward-reference FKs (an imported category pointing at its import batch), nullable-but-set FKs, nested/merged rows — or build the fixture by driving the real creation flows. Assert the full result (counts/rows, or a golden-file snapshot) rather than a single field. `backend/tests/test_import_duplicate_detection.py` (drives real imports + asserts expected-ledger snapshots) is the reference; `backend/tests/test_backup_restore.py` shows the complete-fixture pattern.

- Add a guard that fails on omission wherever one is possible — e.g. derive the table list from `sqlite_master` and assert every data table is represented in the backup payload, so "added a table, forgot to back it up" trips the suite instead of relying on someone remembering.

- Prove a new check actually fires: before trusting a guard or test to pass, confirm it *fails* on the known-bad input (revert the fix and watch it go red), then restore.

## Code Structure Preferences

- Prefer shared components when multiple screens are intended to behave the same way. This is especially important for selectors, dialogs, mapping controls, and other interaction-heavy UI.

- Keep page-specific state where it belongs, but extract repeated rendering and interaction rules into shared helpers or components.

- Do not refactor purely for abstraction. Shared code should be introduced when it clearly reduces drift, repeated bug fixes, or inconsistent behavior.

- Build efficiency in up front, where it is *also* the simpler design. Prefer the more efficient approach from the start rather than treating performance as a later pass — not as license for premature micro-optimization, but because the efficient design and the elegant one usually coincide: the version that avoids redundant work tends to have fewer moving parts, and fewer moving parts is more maintainable and less error-prone. When an efficiency concern points toward a cleaner structure — one shared core fed different-sized inputs, an index that removes a scan, a single pass replacing two — that alignment is a positive signal to act on, and it is not the "purely for abstraction" case above. The guard still applies in the other direction: when efficiency would *add* complexity for a payoff you cannot yet measure, defer it and note it. The recurring scan is the worked example, and it since ran to completion: the enabling refactor was worth doing because it also removed duplication, the scoped fast path was wired when the import path needed it, and a measurement then showed the scoping saves nothing — a scoped scan costs 126 ms against a full scan's 124 ms on a 20,000-row ledger, because the pool loads whole and is filtered afterwards. **That is the deferral paying off, not failing:** the remaining optimization (materializing `payee_key` so the filter reaches SQL) would have been speculative work when it was first proposed, and is now backed by a number and a caller that makes it matter — see `docs/backlog/recurring-detection.md`, which is now that one deferred optimization and nothing else. Prefer measuring the thing before restructuring for it.

- When a bug appears in one copy of a repeated interaction, treat that as a signal to check whether the behavior should be shared more centrally.

## Naming And Brand Hygiene

There are two different bars here, one stricter than the other:

- **UI copy, comments, docstrings:** keep specific real product/company/bank names out — use generic wording ("most banks", "a debit/credit type column") rather than naming "Wells Fargo", "Mint", "Fidelity" as flavor. The one exception is a real integration the code actually talks to, where the name *is* the technical fact (e.g. Plaid) — naming Plaid is correct.

- **Test data / fixtures:** large, well-established, generic-type vendors are fine and can make fixtures readable (Amazon, Starbucks, Netflix, etc.). What to avoid is **PII** and **very niche or personal-specific vendors** — a specific local business, a government office tied to a real place, or a product name that mirrors the user's own accounts. Genericize those personal-specific parts ("Rewards Card" / "Cashback Card" / "Legacy Card" for cards) and describe the scenario's *shape* generically in comments rather than naming the real products involved. The `data/` directory holds the user's **real** data — read it to understand shapes if useful, but **never copy any of it into a checked-in test or fixture** (real card last-4s, account names, merchant/instrument strings are PII); reproduce the *shape* with fabricated values instead.

### UI Vocabulary

- **Reuse the app's own money words rather than inventing per-feature ones.** Money out is **Spent**,
  money in is **Received** — set by the manual-entry direction selector and now used by the reimbursement
  summaries too. A feature that coins its own ("came back", "paid out", "money in") makes the same
  quantity read differently on two screens.

- **Prefer the verb or the adjective to the abstract noun.** An expense is *reimbursable*; the button
  says **Expect $375.00 back**, not "track this reimbursement". The noun is kept only where a record is
  genuinely being named. Nouns like this read as jargon to the person using the app even when they are
  exactly right in the code.

- **Say the thing, not the mechanism, and don't repeat what the surrounding text already said.** A
  column under a subtitle reading "…is expected back" is headed *Expected*, not "Expected back"; an
  instruction above a picker is not restated under it. Ambiguous direction words are worse than plain
  ones — "Owed back" can be read as money *owed by* the reader.

## Error Handling Preferences

- When refusing an action is the right behavior, prefer a clear in-app explanation over clever automatic renaming or silent repair.

- If a save fails but the user can fix the problem, keep the current screen open and explain what needs to change.

- Use backend validation for rules that must apply across multiple entry points.

## Documentation Expectations

- `CLAUDE.md` is the always-loaded entry point, so it must stay lean: a minimal *read-first* routing map — the trigger for consulting docs (work *and* questions touching shared systems, persistence, invariants, or shared UI) plus a one-line index of which doc covers what. Detailed rules and rationale belong in `AGENTS.md` and the `docs/`, never copied into `CLAUDE.md`. The routing index is filename + terse scope only (low-drift); when a doc's purpose changes, update the index line, not its content.

- Keep `AGENTS.md` focused on stable repo-wide instructions.

- `docs/agent-profile.md` is the place for distilled cross-session agent habits and operational footguns that are worth preserving, but do not belong in the always-read entry points or the product/system docs.

- Keep `architecture.md`, `data-model.md`, and `ui-patterns.md` aligned with real shared systems and invariants.

- Use this file for collaboration preferences and decision rules that affect implementation choices across the app but do not belong in the formal architecture or schema docs.
