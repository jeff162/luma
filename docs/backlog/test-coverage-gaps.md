# Test coverage gaps

**Status: running checklist (migrated from `TODO-TESTING.md` 2026-07-30).** Tests we want but
haven't built yet. When a test here is built, delete the entry (or move a note to the relevant
test file's docstring). Two tiers:

- **Python / HTTP** — buildable now, no browser. Unit tests (direct function
  calls) and FastAPI `TestClient` integration tests (real request/response,
  in-process).
- **End-to-end UI** — drives the real app in a real browser via Playwright
  (`npm run ui:test`), against an isolated, auto-seeded throwaway stack.
  Buildable now (see Harness).

---

## Known intermittent failure — unexplained

`test_transaction_splits.py::SplitProtectionTests::test_bulk_recategorize_declines_split_rows_and_reports_the_count`
failed **once**, in a full-suite run on 2026-09-03, and has not reproduced in five subsequent full runs.

Recorded because the obvious explanation is wrong and would waste the next person's time: **the suite is
not order-randomized** — no `pytest-randomly` is installed, so every run executes in the same order, and
"it was just an unlucky ordering" does not apply. That leaves a genuine intermittency. The test drives a
real `TestClient` against a temp database, so the candidates worth checking first are a SQLite lock
timeout under load (the run that failed was competing with other work on the machine) and shared state
in the `api_client()` fixture.

No output was captured beyond the test name. If it recurs, keep the full assertion text — that is the
missing piece, and it is what turns this from a rumour into a bug.

## Harness

### End-to-end UI runs on Playwright against an isolated stack

**Available now.** `npm run ui:test` (config: `frontend/playwright.config.js`)
boots its own throwaway backend + frontend on dedicated ports (5199 / 8099,
clear of the dev 5174 / 8001) and tears them down after. Playwright ships its
own browsers, so no system Chrome is needed.

- **Isolation.** `scripts/run-e2e-backend.sh` points the backend at a wiped temp
  dir via `LUMA_ENV_FILE` (data, control, and tenant DBs all throwaway), so
  E2E never touches the real `luma-data.db` / `luma-control.db`.
- **Seeding.** `frontend/tests/globalSetup.js` signs in (creating an identity if
  the stack has none — without a session every call, including the seed itself,
  answers 401), loads the demo dataset, and writes the session to disk for the
  specs to adopt via `use.storageState`. That last part is what makes a spec's
  `request` fixture as authenticated as a click.
- **Phases, not one flat run — and lanes are projects, not `--grep`.** One a11y
  spec clears the demo data to drive the import screen, which is fatal beside
  the specs reading that ledger, and `--grep` cannot separate them: Playwright
  does not apply command-line filters to a dependency project. The config
  sequences `app` → `demo-cleared` → `import` → `a11y` instead, and the npm
  scripts pass `--project`. A spec needing an empty tenant belongs in one of the
  last two phases. The chain is strict on purpose — no two phases run at once,
  because `import` and `a11y` both clear the saved data sources and would
  otherwise delete each other's.
- **Per-spec cleanliness.** Specs within a phase share one DB, so clear shared
  state in a `beforeEach` (see `import-mapping-controls.spec.js`, which clears
  saved data sources) — otherwise a sibling spec's residue bleeds in. Specs
  reading the demo baseline should leave it as they found it; where one must
  mutate, restore it (see `categorize.spec.js`).
- **Escape hatch.** Set `PLAYWRIGHT_BASE_URL` to run against an already-running
  stack instead of the managed one (skips the webServer + seed).

The chrome-devtools MCP is a *separate* tool that still has no browser in this
WSL distro, but E2E does not use it — Playwright is the path.

---

## Rule duplicate prevention & collision reconciliation

**Context.** `create_rule`/`update_rule` enforce one rule per *matcher*
(keyword + owner + account + amount range + debit/credit) and reconcile a
collision instead of forking a duplicate. See the invariant in
`docs/data-model.md` (Rules → "at most one rule per matcher" and the edit-path
bullet). Statuses: `created` | `updated` | `merged` | `duplicate` | `mergeable`
| `conflict`. `on_existing` = `reject` (classify, don't write) | `merge`.

**Already covered (don't rebuild).** `backend/tests/test_rule_dedupe.py` —
direct-call unit tests for: exact duplicate reported not created; conflicting
category reported not created; added tag mergeable then merges; merge fills a
missing category; different matcher creates; edit into mergeable reports then
merges-and-deletes; edit into conflict not written; edit without collision
updates. Plus the seeded-default-rules gotcha is documented (use fixture
keywords, not real merchant names).

### Backend HTTP integration via FastAPI `TestClient` — build now, no browser

**Why.** The unit tests call the router functions directly, so they skip the
HTTP layer the frontend actually hits: FastAPI parsing `?on_existing=` as a
query param, and the exact JSON shape the frontend reads. A `TestClient` test
exercises that contract in-process (no uvicorn, no browser).

**To build.**

- [ ] `POST /rules` with a body that duplicates an existing rule → `200`, body
      `status == "duplicate"`, `existing_rule_id` present, and **no** new row.
- [ ] `POST /rules?on_existing=merge` for a mergeable case → `status == "merged"`,
      `relation` present, the existing rule gains the new tag/category.
- [ ] `POST /rules` conflicting category → `status == "conflict"`, no write.
- [ ] `PATCH /rules/{id}` whose edit collides with another rule → default
      `status` in {duplicate, mergeable, conflict}, no write; the edited row
      still exists.
- [ ] `PATCH /rules/{id}?on_existing=merge` for a mergeable/duplicate edit →
      `status == "merged"`, response carries `deleted_rule_id == {id}`, and that
      row is gone while the other rule survives with the merged actions.
- [ ] Confirm query-param defaulting: omitting `on_existing` behaves as
      `reject` (the contract the single-save UIs depend on).

**Notes.** Mirror the temp-DB + `set_current_db_path` harness already used in
`backend/tests/`. Watch the seeded default rules — use fixture keywords.

### End-to-end UI flows — buildable now (Playwright)

**Why.** The four interactive surfaces wire the statuses into dialogs/banners
that no unit or HTTP test exercises. These confirm the handlers fire, the
dialogs render, the right API calls go out (assert via `page.waitForResponse`),
and no console errors occur (attach a `page.on('console')` listener).

**To build (one flow each).**

- [ ] **Rules page — create collision.** Add a rule matching an existing one →
      collision dialog appears (assert it doesn't fork a second row).
      "Add to existing rule" merges; "Open the other rule" switches the editor;
      "Cancel" leaves both untouched. Cover the mergeable / duplicate / conflict
      copy variants.
- [ ] **Rules page — edit collision.** Edit a rule's keyword to collide with
      another → "Merge & remove this rule" deletes the edited rule and keeps the
      other (verify the row count drops); conflict shows "Open the other rule"
      and writes nothing.
- [ ] **Import page — Generate Rules bulk accept.** With suggestions that
      collide with existing rules, accept in bulk → no duplicates created, and
      the summary banner reports merged / already-existed / conflicts; conflicts
      stay pending.
- [ ] **Transactions page — rule modal.** Create and edit collisions surface the
      inline conflict message / "fold into existing (this rule will be removed)"
      confirm bar.
- [ ] **Rule toast.** Categorize a transaction so the toast appears; a matcher
      that collides prompts merge / shows the conflict message.

**Setup each flow needs.** A seeded rule to collide with, and — for the Import
flow — an import batch with categorized transactions so suggestions generate.
The demo dataset (loaded by `globalSetup`, see `backend/db/demo_data.py`) now
provides this baseline — owners, accounts, per-account import batches, rules,
tags, and ~80 transactions — so these specs can build on it; use the
`beforeEach`-clear pattern for any rule mutations so parallel specs don't collide.

**What is already covered (so these five are not re-derived).** The demo
dataset's worked examples each have a spec: splits, reimbursables, attached
documents, recurring signals, cash flow, and the rule-overlap check
(`splits` / `reimbursements` / `documents` / `recurring` / `cash-flow` /
`rule-overlaps`), alongside tag inheritance, inline categorize, dashboard
render and cross-account duplicate review. The five rule-*collision* flows above
are what remains — they need a rule set built for the collision, which the demo
deliberately does not carry.

### Frontend component tests (jsdom) — buildable now

**Why.** Only two shared interactive components have jsdom coverage
(`CategoryPicker`, `TransientTextInput`); the rest are low-observability,
heavily reused, and refactor-fragile. Same harness as the existing component
tests (`// @vitest-environment jsdom` + `@testing-library/react`).

**To build (highest value first).**

- [ ] **TagPickerWithCreate** — the direct analog of CategoryPicker
      (search / create / select); near-copy of that test.
- [ ] **TransactionRow / TransactionListTable** — the core row: inline edits,
      embedded category/tag pickers, selection. Used by many pages.
- [ ] **UnifiedDuplicatesDialog** — the dedupe-review modal.

---

## Migration / fresh-schema parity

**Context.** A tenant DB's schema can come into existence two ways, and they
don't share code. A **fresh** install runs `init_db`'s `CREATE TABLE` script and
is stamped straight to `CURRENT_VERSION`, skipping migrations (`db/database.py`,
`is_fresh_db` branch). An **existing** file is advanced in place by
`run_migrations`, which applies each registered `MIGRATIONS[v]` newer than its
recorded version. So once migrations exist, each schema change lives in two
places that must stay in lockstep by hand: the canonical `CREATE TABLE` block
*and* the migration that introduces (or alters) it.

**Status: OWED — the precondition passed long ago (corrected 2026-09-02).** This
entry used to read "dormant until the first post-rebrand migration: `MIGRATIONS`
is empty and the baseline is `v1`, so there is nothing for the two paths to
disagree about *yet*". That has not been true for a long time — `CURRENT_VERSION`
is well past v1 with dozens of registered migrations, and no parity test exists.
The guard was meant to be built alongside the **first** new migration precisely so
it would not be built after a drift bug; it is now the most consequential open gap
in this file. The durable *why* is in `CONTRIBUTING.md` → *Migration and
fresh-schema parity*.

**Why it's worth a test (once migrations exist).** Nothing asserts the two paths
converge, so they can silently drift: add a column to the `init_db` CREATE block
and forget the migration (or vice versa) and brand-new vs upgraded DBs end up
with different schemas — a bug only users with old files hit.

### Backend unit test — owed now

**Shape.** Build the schema both ways into two temp DBs and diff the structure:

- [ ] **Fresh:** `init_db(fresh_path)` → at `CURRENT_VERSION`.
- [ ] **Migrated:** seed the **v1 baseline** (a snapshot of `init_db`'s schema as
      it stood at the rebrand reset), then run `run_migrations` to
      `CURRENT_VERSION`.
- [ ] **Compare** the normalized schema of every user table: column names +
      types + NOT NULL + defaults (`PRAGMA table_info`), foreign keys
      (`PRAGMA foreign_key_list`), and indexes (`PRAGMA index_list` /
      `index_info`). Identical table-by-table; a mismatch names the drifted object.
- [ ] **Coverage guard:** derive the table list from `sqlite_master` on both DBs
      and assert the *sets* match first, so "new table added to only one path"
      trips before the per-table column diff.

**Baseline to capture.** The baseline is well-defined: the **complete** `v1`
schema, i.e. `init_db` as of the rebrand reset. Snapshot that DDL once as a fixture
and migrate forward from it; a fresh `init_db` at the same version must match.
Recovering that snapshot now means reading it out of history rather than off the
current tree, which is part of what the delay has cost.

**Notes.** Mirror the temp-DB harness in `backend/tests/`. Compare schema
*structure* only — ignore `db_meta` version rows and seeded data
(categories/rules), which differ legitimately. `sqlite_master.sql` text is too
brittle to diff directly (whitespace, `IF NOT EXISTS`, column order); normalize
via the `PRAGMA`s instead.

---

## Rule-suggestion owner-scope stability across accepts

**Context.** The Generate Rules generator (`_generate_rule_suggestions` in
`backend/routers/import_export/core.py`) decides whether a keyword's suggestions
are owner-scoped from `owner_targets`, which now folds in existing owner-scoped
rules for the keyword (`rule_owner_targets`), not just the un-ruled candidate
rows. That keeps a shared keyword "multi-owner" after one owner's rows are
claimed by an accepted rule, so the remaining owner's suggestion keeps its owner
filter instead of collapsing to a global (`__global__`) rule.

**Why a test.** Real bug: accepting owner A's rule for a keyword silently dropped
owner B's `owner=` filter (a global rule that overlaps A's). The fix is subtle
and easy to regress — it lives in one `needs_owner_scope` expression. Verified
manually this session via a DB-copy repro; not yet pinned by a test (the setup —
two owners' candidate rows + a real rule — is more involved than the existing
review-state-seeding tests).

**To build (backend unit — no browser).**

- [ ] Two owners share a keyword mapped to *different* categories, both with
      candidate rows → generator owner-scopes both (each suggestion carries its
      `owner_id`; `conflict_group_id` is owner-qualified, not `__global__`).
- [ ] Owner A holds an owner-scoped *rule* for the keyword and has no remaining
      candidate rows; owner B still has candidate rows → B's suggestion stays
      owner-scoped (`owner_id` set), NOT global. (The regression guard.)
- [ ] Single owner only (no sibling rows or rules) → suggestion is global
      (`__global__`), confirming the fix doesn't over-scope.

**Notes.** Build candidate rows + an inserted `category_rule` against the temp-DB
harness; call `get_system_rule_suggestions` (or `_generate_rule_suggestions`
directly). Watch seeded default rules — use fixture keywords.

## Settings.jsx has no component-test harness

`Settings.jsx` is one of the largest surfaces in the app and has no component test of any kind, so
interactive behavior added there ships unpinned.

Standing one up is the real work; the sections are large and lean on `UserPreferencesContext`,
`AppSessionContext`, and a lot of `api` surface. Worth doing as its own task rather than as a rider on
whatever feature lands there next. `VaultSettingsDialog.test.jsx` is the closest existing example of
mounting one of this file's dialogs with mocked `api`.


## Credentials backup restored across a vault reset

**Owed.** The recovery ladder's cheapest real rung is *a credentials backup, opened with the passphrase
it was made with* — see [`../security-model.md`](../security-model.md) → *Recovery and compromise
response* — and nothing exercises it end to end. Every other rung is covered
(`backend/tests/test_vault_recovery.py`, `test_vault_endpoints.py`,
`frontend/src/components/__tests__/VaultRecoveryDialog.test.jsx`); this one is the gap.

**Shape** — a backend test against the temp-DB harness:

- [ ] Take a **credentials backup** while the vault is open under passphrase A.
- [ ] **Reset** the vault (the lost-passphrase path — every slot deleted, both encrypted columns
      cleared, `reauth_required` set) and **set** a new passphrase B. The reset mints a *different* DEK,
      so nothing written under A opens any more; that much is already pinned.
- [ ] **Restore** the backup, giving passphrase A. Assert it re-keys the credentials under the live DEK
      rather than adopting a foreign slot, and that the connections come back **syncable** — the
      credential decrypts and `reauth_required` clears.

**Why it is worth its own test rather than a rider.** The rung's whole claim is that a reset is
recoverable *if a backup exists*, and that claim spans both databases and two DEK generations. Each half
is tested alone and their composition is not — which is exactly the shape of thing that stops working
without any single test going red.
