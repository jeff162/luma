# Tooling — lint strictness & ruff

**Status: one item left (migrated from `TODO.md` 2026-07-30).** Three tooling tasks: two
"enable, measure, triage, then gate" linter projects (frontend eslint, backend ruff) and a vitest
matcher setup. Both linter passes ran on 2026-09-05 and are recorded below for the measurements rather
than as work outstanding; **only the jest-dom item is still to do**, and none of it is blocking.

The **posture** these follow — narrow by design, enable one rule as a warning, measure before deciding,
promote to error only once the existing hits are cleared, and count before conviction — is in
[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) → *Lint posture*. What stays here is the specific work
each project needs.

## Raise lint strictness to a reasonable baseline  ✅ *pass run 2026-09-05*

**The pass ran.** Every rule choice and its reason now lives in `frontend/eslint.config.js` itself,
which is the right home — the config is the document for what is enforced and why. What stays here is
the measurement, so the next pass starts from numbers rather than re-deriving them.

**The baseline that made this cheap:** the tree lints at **0 errors, 0 warnings**. That is what turns
"promote to error" from a project into a free move — a `warn` in a zero-warning tree is not a gate,
because nothing is watching the warning stream.

Measured (`eslint src --rule ...`, config untouched), and what each was worth:

| rule | hits | outcome |
| --- | --- | --- |
| `react-hooks/exhaustive-deps` (was `warn`) | **0** | → **`error`**. Free; nothing to clear |
| `react/no-unstable-nested-components` | 2 | → **`error`** with `allowAsProps: true`, which clears both. They are Recharts `Sankey` render props (`link` / `node`), a library API rather than the mistake the rule is for |
| `react/jsx-no-useless-fragment` | 4 | **off**. Pure formatting, no bug it can prevent; the autofix dedents parents without reindenting children, so adopting it means misleading markup or a ~150-line reindent |
| `react/no-array-index-key` | 31 | **off**. A real bug class only in reorderable lists; the rest are static renders where the index is stable. Needs per-site judgment, not a sweep |
| `jsx-a11y/control-has-associated-label` | **101** | **off**, unchanged. Was ~89 when first measured, so it grows with the UI — confirming it floods rather than isolating anything |

Both adopted rules were checked against known-bad input (a probe file with a missing dep and a
component defined during render) and fail as errors, so they are gates rather than decoration.

**Still open, and deliberately not done here:**

- Chrome DevTools "**A form field element should have an `id` or `name`**" — ~24 in the console. An
  autofill/tooling check, *not* an eslint rule, so the linter cannot enforce it. Addressing it means
  adding `id`/`name` to form controls, which is low value for this app's inline editors. Decide whether
  to bother at all.
- `no-array-index-key`'s 31 hits, if the reorderable-list subset is ever worth isolating from the rest.

## Add `@testing-library/jest-dom` to the vitest setup

**Context.** `package.json` carries `@testing-library/dom` / `/react` / `/user-event` but **not**
`/jest-dom`. So the DOM matchers
everyone reaches for by default — `toBeInTheDocument`, `toHaveStyle`, `toBeDisabled`,
`toBeEmptyDOMElement` — don't exist, and using one fails with `Invalid Chai property: <name>`.
The jsdom specs assert on raw DOM properties instead (`el.style.color`, `container.innerHTML`),
which is correct but wordier, and the wall gets hit fresh by whoever writes the next DOM test.

**Why it's a papercut, not a risk.** The failure mode is loud: an unknown matcher throws rather
than silently no-opping, so no test can go green because an assertion quietly did nothing. That
is the version of this that would actually matter, and it isn't the situation.

**Why it was deferred (2026-08-07), and why that reason has since expired.** The deferral rested on
only 7 of 29 test files being jsdom, so the payoff would scale with DOM testing added later. Re-measured
2026-09-05: **57 of 101** test files are jsdom. The payoff is banked.

The cost fell too. That note also said the vitest block had no `setupFiles`, which is no longer true —
`frontend/vitest.setup.js` exists (added for `IS_REACT_ACT_ENVIRONMENT`) and is already wired as
`setupFiles`, so this is now **one import line in a file that exists**, plus the devDependency. The
wrinkle the note raised is moot for the same reason: that setup file already loads in the default Node
environment for every test, so jest-dom would add nothing new to the pure-logic files beyond an
`expect` extension that touches no DOM at import time.

**Suggested approach when picked up.** Add the devDependency and
`import '@testing-library/jest-dom/vitest'` to `vitest.setup.js`. Existing raw assertions should be
left alone — they are correct, and rewriting them is churn.

## Wire up ruff  ✅ *adopted 2026-09-05*

**Done, narrowly.** ruff is pinned in `[project.optional-dependencies].dev` with a
`requirements-dev.txt` mirror, runs as `lint:ruff` inside `npm run lint` (so it gates CI, which calls
that script, and any manual run), and reaches its executable through `scripts/run_ruff.js`. The tree is
clean of the selection. The reasoning for each rule family is in `backend/pyproject.toml` beside the
`select` line, which is where it stays useful; what follows is what the measurement decided and why the
obvious plan was wrong.

**The selection is `F` + `DTZ003` + `DTZ005`, out of a measured 310 hits.** `E`/`W` and `I` were
measured and rejected: 140 of `E`/`W`'s 144 hits are the deliberate column-aligned one-liners in
`routers/categories.py`, so enforcing them would mean reformatting correct code, and `I`'s 119 hits
rewrite imports across the tree to catch nothing. `ruff check --select I --fix` is still there as a
manual pass if the ordering is ever worth one.

**Cleared to get there:** 21 `F401` unused imports (autofixed, after checking that none was a re-export
— `import_export/__init__.py` does `from .core import *` with no `__all__` to constrain it, so an
"unused" import there can still be somebody's public name; none of the 21 were) and 15 `F841` unused
variables, by hand rather than with `--unsafe-fixes`. **The hand pass is why that matters:** the
bindings fell into three groups that a blind fix would have flattened — dead `.rowcount` reads where
only the name was unused and the statement still had to run, one `_require_open(...)` whose *call* is a
validation that raises (deleting it would have removed a guard), and eleven test fixtures whose creation
is the point of the line, now `_`-prefixed so the name still documents what was made.

**The plan this file used to carry was wrong in one specific way**, and it is worth keeping: `DTZ` is
**not** the general form of `scripts/check-backend-timestamps.js`, so adopting it does not retire that
guard. `DTZ003`/`DTZ005` — the two calls the bespoke guard actually bans — measured **zero** hits,
because the guard has been keeping them out; they are a free gate. The other 67 `DTZ` hits are a
different subject: `DTZ011` (`date.today()`) alone is 56 of them, and a local calendar date is usually
correct in a ledger. Both guards are kept, for reasons now recorded in `CONTRIBUTING.md` → *The
timestamp guard*.

**Deliberately not done:** ruff is not in `scripts/pre-commit.sh`. It is the only check with an install
prerequisite, and it is whole-tree rather than staged-file scoped — the wrong shape for that hook. CI
is where it gates.
