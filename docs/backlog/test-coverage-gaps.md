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

## Harness

### End-to-end UI runs on Playwright against an isolated stack

**Available now.** `npm run ui:test` (config: `frontend/playwright.config.js`)
boots its own throwaway backend + frontend on dedicated ports (5199 / 8099,
clear of the dev 5174 / 8001) and tears them down after. Playwright ships its
own browsers, so no system Chrome is needed.

- **Isolation.** `scripts/run-e2e-backend.sh` points the backend at a wiped temp
  dir via `LUMA_ENV_FILE` (data, control, and tenant DBs all throwaway), so
  E2E never touches the real `luma-data.db` / `luma-control.db`.
- **Seeding.** `frontend/tests/globalSetup.js` creates one local preference
  profile so specs land past the "Getting Started" onboarding gate. A richer
  demo dataset (owners/accounts/transactions) is a planned follow-up that will
  double as this seed.
- **Per-spec cleanliness.** Specs share one DB per run, so clear shared state in
  a `beforeEach` (see `import-mapping-controls.spec.js`, which clears saved data
  sources) — otherwise a sibling spec's residue bleeds in.
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

**Tier-1 status (done — for reference).** The other high-value flows the demo
unblocked are built: tag inheritance, inline categorize, dashboard render, and
the cross-account duplicate review (`transactions` / `categorize` / `dashboard` /
`duplicates` specs). The five rule-collision flows above are what remains.

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
- [ ] **UnifiedDuplicatesDialog** — the dedupe-review modal (the reference
      modal per `docs/collaboration-notes.md`).

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
interactive behavior added there ships unpinned — the sync log's multi-select connection filter pills
(2026-08-19) are the current example: the backend contract is tested, the pill behavior is not.

Standing one up is the real work; the sections are large and lean on `UserPreferencesContext`,
`AppSessionContext`, and a lot of `api` surface. Worth doing as its own task rather than as a rider on
whatever feature lands there next. `VaultSettingsDialog.test.jsx` is the closest existing example of
mounting one of this file's dialogs with mocked `api`.

