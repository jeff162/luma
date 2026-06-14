# Testing TODO

Tests we want but haven't built yet. Companion to `TODO.md`; same rule — each
entry should stand on its own. Two tiers:

- **Python / HTTP** — buildable now, no browser. Unit tests (direct function
  calls) and FastAPI `TestClient` integration tests (real request/response,
  in-process).
- **End-to-end UI** — drives the real app in a browser via the chrome-devtools
  MCP. Blocked until the MCP can reach an actual browser (see Prerequisites).

When a test here is built, delete the entry (or move a note to the relevant
test file's docstring).

---

## Prerequisites

### End-to-end UI tests need a browser inside WSL

**Context.** The chrome-devtools MCP server does not ship a browser — it
launches or attaches to one. This repo runs in a WSL distro with no
Chrome/Chromium installed, so the MCP tools are present but inert: there's
nothing for them to drive. This is why every "verified in-app" claim so far is
actually only "unit-tested + lint + build."

**What unlocks it.**

- Install a Linux Chromium/Chrome *inside* the WSL distro. **Headless** is
  enough for the MCP — no display/X server (so WSLg headful setup is not
  required).
- Point the MCP at it: depending on the server config, either set an
  `executablePath` to the binary or give it a remote-debugging URL. (Attaching
  to a Windows-side Chrome over a `--remote-debugging-port` across the
  WSL↔Windows boundary is the flakier alternative — prefer a browser in WSL.)
- Sanity check: launch the app, `navigate_page` to it, and confirm a single
  `take_snapshot` returns the accessibility tree before writing real flows.

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

### End-to-end UI flows — build when the MCP browser works

**Why.** The four interactive surfaces wire the statuses into dialogs/banners
that no unit or HTTP test exercises. These confirm the handlers fire, the
dialogs render, and the right API calls go out (`list_network_requests`) with
no console errors (`list_console_messages`).

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
Decide whether to seed via API calls before driving the UI or through the UI
itself.

---

## Migration / fresh-schema parity

**Context.** There are two ways a tenant DB's schema comes into existence, and
they don't share code. A **fresh** install runs `init_db`'s `CREATE TABLE`
script and is stamped straight to `CURRENT_VERSION` — the migration chain is
deliberately skipped (`db/database.py`, `is_fresh_db` branch: "Fresh databases
are stamped current immediately"). An **existing** file instead replays
`MIGRATIONS[1..N]` via `run_migrations`. So every schema object exists in two
places that must be kept in lockstep by hand: the canonical `CREATE TABLE`
block *and* the migration that introduced (or altered) it.

**Why it's worth a test.** Nothing currently asserts the two paths converge, so
they can silently drift: add a column to the `init_db` CREATE block and forget
the migration (or vice versa), and brand-new DBs and upgraded DBs end up with
different schemas — a bug only users with old files hit. This session's
`owner_id`-on-`category` crash was exactly this class: a migration dropped a
column the delete path still referenced. A parity guard turns "someone
remembers to edit both" into a failing test.

### Backend unit test — build now, no browser

**Shape.** Build the schema both ways into two temp DBs and diff the resulting
structure:

- [ ] **Fresh:** `init_db(fresh_path)` → reads at `CURRENT_VERSION`.
- [ ] **Migrated:** start from the true pre-migration baseline and run
      `run_migrations` up to `CURRENT_VERSION`, then compare.
- [ ] **Compare** the normalized schema of every user table: column names +
      types + NOT NULL + defaults (`PRAGMA table_info`), foreign keys
      (`PRAGMA foreign_key_list`), and indexes (`PRAGMA index_list` /
      `index_info`). Assert the two are identical table-by-table; a mismatch
      names the drifted object.
- [ ] **Coverage guard:** derive the table list from `sqlite_master` on both
      DBs and assert the *sets* match first, so "new table added to only one
      path" trips before the per-table column diff.

**The catch to resolve first (why this was deferred).** The migration chain may
not build a DB from absolute zero — historically migrations were *additive
deltas* on top of an original baseline schema, not a from-scratch sequence. If
migration v1 doesn't create the original base tables, replaying from an empty
DB won't reproduce the full schema, and the naive "empty → migrate" comparison
will spuriously fail. Before writing assertions, determine what the real v0
baseline is (the schema as it stood when the migration system was introduced)
and seed that, *then* migrate. If it turns out migrations genuinely can rebuild
from empty, the test is simpler — but confirm that rather than assuming it.

**Notes.** Mirror the temp-DB harness in `backend/tests/`. Compare schema
*structure* only — ignore `db_meta` version rows and any seeded data
(categories/rules), which differ legitimately. `sqlite_master.sql` text is too
brittle to diff directly (whitespace, `IF NOT EXISTS`, column order); normalize
via the `PRAGMA`s instead.

---

## (add future test gaps below)
