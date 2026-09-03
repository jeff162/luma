# Tooling — lint strictness & ruff

**Status: deferred, not started (migrated from `TODO.md` 2026-07-30).** Three deferred tooling
tasks: two "enable, measure, triage, then gate" linter projects (frontend eslint, backend ruff) and a
vitest matcher setup. None is blocking.

The **posture** these follow — narrow by design, enable one rule as a warning, measure before deciding,
promote to error only once the existing hits are cleared, and count before conviction — is in
[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) → *Lint posture*. What stays here is the specific work
each project needs.

## Raise lint strictness to a reasonable baseline and triage the results

**Context.** `frontend/eslint.config.js` keeps its rule set deliberately
narrow (react-hooks, react-refresh, a couple of project-specific guards, and —
recently — `jsx-a11y/label-has-associated-control`). There is a backlog of
stricter-but-reasonable rules that flag real-ish issues and were left off only
to avoid flooding. Worth a deliberate pass: enable candidate rules, measure,
fix the cheap/genuine hits, and decide error/warn/off per rule rather than
adopting a recommended preset wholesale.

Concrete starting data (measured when the a11y label rule went in):

- `jsx-a11y/control-has-associated-label` — **~89 hits**, currently `off`.
  Most are placeholder-only inputs. The browser counts a placeholder as the
  field's accessible name (so DevTools flags ~1), but this rule does not — so
  the count is inflated and chasing all 89 is *not* obviously worth it for a
  single-user, local-first app. Triage before enabling.
- Chrome DevTools "**A form field element should have an `id` or `name`**" —
  **~24** in the console. This is an autofill/tooling check, *not* an eslint
  rule, so the linter won't enforce it; addressing it means adding `id`/`name`
  to form controls, which has low value for this app's inline editors. Decide
  whether to bother at all.
- Beyond a11y: consider whether to tighten `react-hooks/exhaustive-deps`
  (currently `warn`), turn on more of `eslint-plugin-react`, or add rules like
  `react/no-unstable-nested-components`.

**Why deferred.** Each rule needs case-by-case triage (genuine bug vs. false
positive vs. not-worth-it here), and several would require touching many files.
None of it is blocking. The narrow-by-design philosophy means we add strictness
only where it earns its keep.

**Suggested approach when picked up.**

- Enable one candidate rule at a time as `warn`, run `npm run lint:frontend`,
  and read the count/locations before deciding.
- Fix the genuine, cheap hits; for false positives prefer tuning the rule's
  options (e.g. the `depth` bump already used for
  `label-has-associated-control`) over restructuring correct markup.
- Promote a rule to `error` only once its existing hits are cleared, so it
  becomes a real regression gate; leave noisy/low-value rules `off` with a
  one-line comment saying why (the config already documents this pattern).
- Watch the placeholder-vs-label and autofill-id semantics above so the count
  doesn't get chased blindly.

## Add `@testing-library/jest-dom` to the vitest setup

**Context.** `package.json` carries `@testing-library/dom` / `/react` / `/user-event` but **not**
`/jest-dom`, and the vitest block in `vite.config.js` has no `setupFiles`. So the DOM matchers
everyone reaches for by default — `toBeInTheDocument`, `toHaveStyle`, `toBeDisabled`,
`toBeEmptyDOMElement` — don't exist, and using one fails with `Invalid Chai property: <name>`.
The jsdom specs assert on raw DOM properties instead (`el.style.color`, `container.innerHTML`),
which is correct but wordier, and the wall gets hit fresh by whoever writes the next DOM test.

**Why it's a papercut, not a risk.** The failure mode is loud: an unknown matcher throws rather
than silently no-opping, so no test can go green because an assertion quietly did nothing. That
is the version of this that would actually matter, and it isn't the situation.

**Why deferred (2026-08-07).** Only 7 of 29 test files are jsdom today, so the payoff scales with
how much DOM testing gets added later. Judged worth folding into the next frontend test work rather
than made its own errand. Existing raw assertions should be left alone when it lands — they are
correct, and rewriting them is churn.

**Suggested approach when picked up.** Add the devDependency, a one-line setup file importing
`@testing-library/jest-dom/vitest`, and `setupFiles` in the vitest config. One wrinkle to decide:
the default environment is `node` with per-file jsdom opt-in, so a global setup file loads for the
22 pure-logic files too. jest-dom only extends `expect` and touches no DOM at import time, so it is
harmless — either accept the small import cost or scope it with `environmentMatchGlobs`.

## Wire up ruff (and replace the bespoke timestamp guard with `flake8-datetimez`)

**Context.** `backend/pyproject.toml` configures ruff (`[tool.ruff]`, selecting
`E`/`F`/`W`/`I`), but ruff is **never actually run** — not in
`scripts/pre-commit.sh`, not installed in the venv, and not invoked by
`.github/workflows/release.yml` (which runs the test suite before building, so
there is now a CI job to hang a lint step on — this note used to say no workflow
existed at all). So the config is currently aspirational. The one enforced backend
gate is the comment check in the pre-commit hook, alongside a small bespoke
timestamp guard (`scripts/check-backend-timestamps.js`) that bans
`datetime.utcnow()` and no-arg `datetime.now()` so stored timestamps keep
flowing through `backend/time_utils.py`'s `utcnow_iso()`.

**Why deferred.** Making ruff real means installing it (a dev dep, like
pytest — track it in `[project.optional-dependencies].test` or a new `dev`
group + a requirements mirror), wiring it into the pre-commit hook / a CI
check, and triaging the first run. Enabling the `flake8-datetimez` (`DTZ`)
rule family — the proper, general version of the bespoke timestamp guard —
also flags existing legitimate-but-naive usage (e.g. `datetime.strptime` at
`backend/routers/import_export/core.py:1618`), each of which needs a real fix
or a justified `# noqa`. None of this is blocking; the bespoke guard already
covers the specific regressions we care about today.

**Suggested approach when picked up.**

- Pin ruff in the dev/test deps + mirror, and add `ruff check backend` to
  `scripts/pre-commit.sh` (staged-file scoped) and/or a CI job.
- Turn on `DTZ` and triage; once its hits are clean and it's enforced, the
  bespoke `check-backend-timestamps.js` becomes redundant and can be retired
  (or kept as a fast, dependency-free pre-commit guard — decide which).
- Same pattern as the eslint item above: enable, measure, fix the cheap/genuine
  hits, `# noqa` the justified ones, and only then make it a hard gate.
