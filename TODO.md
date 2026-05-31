# TODO

Deferred work and known follow-ups. Each entry is written to stand on its
own; pick any item and you should have enough context to start without
needing the conversation that produced it.

Convention: items are roughly grouped by area. When an item gets done,
delete it or move it to `CHANGELOG.md` if it was user-visible.

---

## Tag inheritance follow-ups

### Block inherited tag mechanism

**Context.** Tags now flow into a transaction from three sources additively:
the transaction itself (`txn_tag`, with the rule/manual visibility rules),
its leaf category (`category_tag`), and its parent group (`category_tag` on
the group). A transaction's effective tag set is the union. There is
currently no way for a single transaction (or a single leaf category) to
*opt out* of a tag that's reaching it through inheritance.

**Why deferred.** Day-one inheritance is additive only — we agreed to add
the block mechanism when an actual case calls for it, not preemptively.

**Suggested approach when picked up.**

- Add a `manual_state = -1` analog to `category_tag` (e.g. a
  `block_inherited` flag on `txn_tag`, or a separate `txn_tag_block` table
  recording per-transaction-per-tag suppressions of inherited tags).
- Same shape can be reused at the leaf level: a leaf can suppress a tag
  inherited from its group by storing a row in a parallel
  `category_tag_block(category_id, tag_id)` table.
- Update `get_visible_transaction_tag_map` in
  `backend/services/transaction_tags.py` to subtract blocked tags after the
  additive union.
- UI: in `TagPickerWithCreate`, allow an inherited tag's checkbox to be
  un-ticked, which posts a block. The pill marker on the transaction row
  should visually distinguish "inherited (active)" from "inherited
  (blocked here)".

### Bulk transaction editor

**Context.** Came up as the alternative to tag inheritance: select many
transactions and apply tag/category/notes/etc. in one pass. We picked
inheritance as the primary mechanism (less ongoing maintenance), but a
bulk editor is still useful for ad-hoc cleanup, retroactive corrections,
and one-off batch tagging that doesn't generalize to a rule.

**Why deferred.** Not blocking; inheritance + rules covers the everyday
case. Build when a cleanup workflow demands it.

**Suggested approach when picked up.**

- Likely lives on the Transactions page. Selection model: checkbox column +
  shift-click range select.
- Edit affordance: a small action bar that appears when any row is
  selected, with the same controls used inline (CategoryPicker,
  TagPickerWithCreate, notes field).
- Apply happens server-side via a new `/transactions/bulk` endpoint that
  takes `txn_ids` plus the per-field patch; reuse the same backend
  validation/normalization that the single-row endpoints use.
- Watch out for: pending transactions, transactions already manually
  overridden (decide whether bulk apply overrides existing manual
  overrides — probably yes, with confirmation), and rules that would
  re-apply automatically on the next sync.

---

## Saved tag reports

### Settings-page mirror of the report manager

**Context.** Tag reports are currently managed from the dashboard picker:
right-click or the `⋯` button on a saved report opens a small menu with
Rename / Delete. There is no Settings-page surface listing all saved
reports.

**Why deferred.** Right-click + the `⋯` menu is enough discoverability for
the small surface area today. Add the Settings mirror if the picker menu
turns out to be too easy to miss.

**Suggested approach when picked up.**

- Add a Settings section "Saved tag reports" that lists every preset stored
  under `ui.dashboard.tagReports` with rename/delete affordances and the
  tag composition shown inline.
- Useful as a single place to bulk-clean stale presets, which is harder to
  do one-by-one from the dashboard.

### Capture filters with a saved preset

**Context.** A saved preset today is just `{ id, name, tagIds,
dismissedMissingWarning? }` — only the tag selection. The dashboard's
current period, account filter, etc. are not part of the preset, so
loading a preset always uses whatever filters are currently active.

**Why deferred.** Tag-only was the simplest first slice and composes well
("any preset works against any current filter set"). The "I always look at
year-end essentials" use case wants filters frozen with the preset, but no
one has asked for it yet.

**Suggested approach when picked up.**

- Add a "Capture current filters" checkbox in the save dialog.
- Extend the preset shape with optional `filters: { period?, accountId?,
  ownerSelections?, tagFilters? }`.
- When the user picks a preset with captured filters, push those filters
  through `FilterContext` instead of (or in addition to) the current ones.
  Decide whether the active filter pills should visually distinguish
  preset-driven filters from manually-applied ones.

### Cross-user sharing of tag reports

**Context.** Currently per-user via `useUserPreference` (key
`ui.dashboard.tagReports`). Each user has their own presets, no
cross-pollination.

**Why deferred.** Single-user development for now. Sharing model wasn't
fully decided — possible designs include opt-in per-preset (`shared: true`
flag), explicit copy-to-other-user, or path-prefix naming
(`alice/<report>`).

**Suggested approach when picked up.**

- Migrate preset storage out of user preferences into a small backend
  table: `tag_report(id, owner_id, name, tag_ids JSON, shared INTEGER,
  created_at)`.
- Frontend `getTagReports` returns the union of the caller's own presets
  plus any with `shared = 1`; the picker decorates shared presets so the
  user knows they aren't unique to them.
- Mutations (rename/delete) limited to the owner. Non-owners see read-only.
- The existing `useUserPreference`-backed list can be migrated in one shot
  on first run.

### Richer report builder

**Context.** Today's builder is a flat tag-checkbox list. Future ideas
discussed: drag-to-bucket for multi-bucket comparisons, or a
natural-language template where the user fills tags into a phrase
("compare [Alice] vs [Bob] for [Essential]").

**Why deferred.** Worth seeing how the simple version actually gets used
before investing in a richer one — the patterns users reach for will
inform the right next step.

---

## Dashboard / reporting

### Cash-flow Sankey diagram

**Context.** "Cash flow" is conceptually distinct from spending or income
— it's about how money moves through accounts and categories, not just
totals. Best visualized as a Sankey diagram (income sources on the left,
expense buckets on the right). We deliberately *removed* `cash_flow` from
the dashboard's Expenses/Income toggle to avoid conflating it with the
spending/income reports.

**Why deferred.** Sankey is its own visualization with its own data shape
(weighted edges between source and sink nodes). Wants its own dashboard
mode or page.

**Suggested approach when picked up.**

- Likely a new top-level dashboard mode alongside Single/Compare/Trends,
  or a sibling of the Dashboard accessible from the nav.
- Backend: a new summary endpoint that returns weighted edges (income
  category → bucket-of-spending, perhaps grouped by tag or by category) for
  a period.
- Frontend: use a Sankey library or render directly with d3-sankey. Click
  on a flow to drill into the transactions on that path.

### Dead `view='cash_flow'` branch on `/summary/monthly-trend`

**Context.** The endpoint at `backend/routers/transactions.py` accepts
`view='spending' | 'income' | 'cash_flow'`. After the Expenses/Income
toggle replaced the broader cash-flow concept on the dashboard, no
frontend caller passes `cash_flow` anymore.

**Why deferred.** Harmless dead code; might be useful when the Sankey
work lands.

**Suggested approach when picked up.** Either delete the `cash_flow`
branch (and adjust the default to `spending`) once it's clearly unused, or
leave it and use it from the Sankey work — decide at that point.

### Trends-tab semantics audit when the tag-report selector lands there

**Context.** The Trends tab's "Total per month" and "Annual totals" bar
charts aggregate across all series returned by `/summary/monthly-by-group`.
We filter income/expense in the per-series rendering, but the per-month
and per-year totals are sums of `r.total` across all rows — which can
double-count or produce misleading magnitudes depending on which series
mix is present.

**Why deferred.** The Trends tab today has no tag-report selector — adding
one is what would expose this latent issue. We patched the analogous
problem on Single mode during Phase 1 (filter to expense series before
summing); the same fix shape applies to Trends mode but needs to be
revisited in the context of whatever filter UI Trends mode gets.

**Suggested approach when picked up.**

- Introduce the same Expenses/Income toggle (and eventually the tag-report
  picker) on Trends mode.
- Derive an `expenseSeriesIds` (or active-selection equivalent) and have
  `monthlyTotal` and `annualData` filter against it before summing.
- Possibly add an `Avg` reference line to `Annual totals` (already done
  for `Total per month` and `Monthly spending by group`).

---

## Docs / onboarding

### Getting-started guide

**Context.** A high-level user-facing introduction: what FinTrack is for,
how the main concepts (accounts → transactions → categories → rules →
tags) compose, the order operations usually go in for a new user.

**Why deferred.** Content authoring is the long pole; framework first.

**Suggested approach when picked up.**

- Add a new entry to `frontend/src/help/content.jsx` with `id:
  'getting-started'` and a longer-form body.
- The Help page index already lists every topic; the getting-started entry
  will naturally show up first if it sorts alphabetically or we pin it.
- Cross-link liberally into the existing topics (tags, categories-tags,
  dashboard-tag-reports) using `<HelpLink>`.

### CHANGELOG entry for tag-as-owner replacement

**Context.** The four-phase work that removed `owner_id` from `category`
and replaced category/group ownership with the tag inheritance model is
user-visible (the Categories panel UI changed, the Split-by-owner
dashboard panel is gone, tag reports replaced category-owner filtering).

**Why deferred.** Asked at the end of Phase 3 / Phase 4 and didn't get an
answer; I held off rather than guess at the right tone for a CHANGELOG.

**Suggested approach when picked up.** Standard CHANGELOG line under the
next release section, calling out the migration of category ownership to
tags and pointing at the Help-page topic for users who want the model
explained.

---

## Cleanup

### Decide fate of `merchant_rename` / `merchants.py`

**Context.** `backend/routers/merchants.py` defines a full CRUD router for
the `merchant_rename` table (raw_pattern → clean_name mappings) but is not
registered in `backend/main.py`, has no frontend callers, and nothing in
sync/import reads the table to apply renames. The original design (see the
docstring at the top of the file) was a two-pass pipeline: rename garbled
Plaid merchant names *before* categorization runs, with the `/apply`
endpoint walking existing rows so retroactive cleanup matched what new
imports would produce. That role got absorbed into `category_rule.clean_name`,
which is the live rename mechanism today —
[`categorizer.py`](backend/services/categorizer.py#L73-L103) collects
`winning_clean_name` from the matching rule, and
[`sync.py`](backend/routers/sync.py#L90-L92) writes it to `display_name`.
The category-rule path also gets account/owner scoping for free, which
`merchant_rename` doesn't have (the table is just `id, raw_pattern,
clean_name`). The table is still serialized by backup/restore at
[`import_export.py`](backend/routers/import_export.py#L5091).

**Why deferred.** Plaid integration hasn't been exercised yet, and the
original two-pass pipeline was aimed specifically at Plaid's garbled
merchant strings (e.g. `WHOLEFDS #1234 MKT`). Wiring `merchant_rename` back
in may turn out to be the right answer once Plaid sync is in real use, so
the dormant code is left as a reminder to make that call deliberately.
Easy to delete later if the category-rule path proves sufficient.

**Suggested approach when picked up.**

- If keeping: register `merchants.router` in `backend/main.py` (`prefix="/api/merchants"`),
  add a Transaction-detail affordance to create a rename from a row's
  `raw_name`, and have sync/import consult `merchant_rename` before the
  categorizer runs so cleaned names feed into rule matching. The existing
  `/apply` endpoint already covers retroactive application.
- If dropping: delete `backend/routers/merchants.py`, add a migration that
  drops the `merchant_rename` table, and remove the `merchant_renames`
  entries from backup dump/restore in `backend/routers/import_export.py`
  (lines ~5091, ~5198, ~5271, ~5294).

---

## Security model

### Pre-auth security UI (Settings page)

**Context.** Three Settings sections were removed during a lint cleanup
because their `onChange`/`onEnabled` callbacks called setters
(`setSecurityProfile`, `setAuthEnabled`, `setPasswordPolicy`) that were
never wired up — they were vestiges of an in-progress security UI that
never made it across the finish line. The work was deferred because the
project hasn't decided which security model it wants to commit to. Plaid
integration will eventually force the question (token protection at rest
generally wants per-user authentication so a leaked DB doesn't equate to
leaked tokens).

**Why deferred.** Bigger architectural decision than fits in a cleanup
pass: deciding which security profiles to support, whether to require
2FA, how multi-user vs single-user modes interact, and how Plaid token
protection plugs in. The UI was three small forms; rebuilding them is
straightforward once the model is decided.

**What was removed.** Three sections in
[`frontend/src/pages/Settings.jsx`](frontend/src/pages/Settings.jsx) and
their internal components:

- **Security model** (radio picker over `SECURITY_PROFILES` from
  `lib/securityProfiles.js` — local_private / network_private /
  household_shared / multi_tenant). POSTed to `/auth/security-profile`.
  The component was `SecurityProfileSection`.
- **Sign-in protection** (single "Enable sign-in protection" button →
  `/auth/enable` → page reload → user is then on `AuthScreen`). The
  component was `AuthModeSection`.
- **Password policy** picker (radio over `PASSWORD_POLICIES` from
  `lib/passwordPolicy.js` — none / min_8 / strong). POSTed to
  `/auth/password-policy`. The component was `PasswordPolicyPanel`,
  rendered inside `AccountSecuritySection`.

**What was kept** (so rebuild is mostly stitching, not new authorship):

- `frontend/src/lib/securityProfiles.js` — the `SECURITY_PROFILES`
  list and `getSecurityProfile` helper. Still consumed by `AuthScreen`.
- `frontend/src/lib/passwordPolicy.js` — `PASSWORD_POLICIES`,
  `passwordPolicyHelpText`, `validatePasswordForPolicy`. Still consumed
  by `AuthScreen` and by `UserAdminSection` for new-user password
  validation.
- Backend endpoints `/auth/enable`, `/auth/security-profile`,
  `/auth/password-policy`, `/auth/status`. Untouched.
- `api.enableAuth`, `api.saveSecurityProfile`, `api.savePasswordPolicy`
  helpers in `frontend/src/lib/api.js`. Untouched.
- App-level session state (`authEnabled`, `securityProfile`,
  `passwordPolicy`) in `App.jsx` and exposed read-only through
  `useAppSession()`. The `experimentalSecuritySettings` flag is still
  threaded through to `AuthScreen` via `showModePill`.
- `AccountSecuritySection` (now just the 2FA management surface —
  authenticator app setup, disable, recovery code regen) and
  `PlaidTokenProtectionSection`. Both remain gated on `authEnabled`, so
  they are dormant in the current household mode but available when
  auth is turned on.

**To rebuild when the model is decided.** Three small Cards in
Settings, each with a radio list driven by the corresponding constant
array, an `onChange` that calls the existing API helper, and a status
callback that updates the session via setters that would need to be
exposed from `useAppSession()` (currently only getters are exposed —
adding the setters is the wiring this incomplete UI never finished).

---

## Import / duplicate detection

### Auto-restore deduped rows when a contributing import is undone

**Context.** Exact-match (hard-reject) duplicates are dropped at import
time, never inserted into `txn`; only their payload is kept in
`import_batch_duplicate`. So if file B has rows that were skipped because
they matched file A, then undoing file A leaves those B rows absent even
though re-importing B fresh would now create them (A's rows are gone, so
they would no longer be duplicates). Today the only recovery is the manual
"Import duplicates" action on file B (`POST
/import-export/batches/{id}/duplicates/import`) or re-importing B. The idea
here is to automate it: when an import is undone, survey subsequent batches'
`import_batch_duplicate` records and re-materialize the rows whose only
reason for rejection was the batch being undone.

**Why deferred.** Unclear how often it actually matters, and it is not
trivial to do correctly. Rejections form a chain: files A, B, C may each
contain overlapping slices of earlier ones. A row in C that was dropped
because of A might *still* be a duplicate after A is undone — now because of
B. So "restore everything C deduped against A" is wrong; each candidate has
to be re-evaluated against the *current* ledger state (re-run through
`evaluate_duplicate`), not just blindly re-inserted because its original
matched-row disappeared. There is also an ordering question (process
candidates oldest-first so a restored B row can legitimately re-suppress a C
row) and a UX question (auto-restore silently vs. surface "N rows can be
restored" for confirmation).

**Suggested approach when picked up.**

- In `undo_batch`, after deleting the batch's rows, collect every *other*
  batch's `import_batch_duplicate` payloads and re-run each through
  `evaluate_duplicate` against the post-undo ledger.
- Re-insert only those that now pass (no longer hard-reject); leave the rest
  as duplicate records. Process oldest batch first so re-inserted rows can
  re-suppress later candidates within the same pass.
- Decide auto vs. confirm: likely surface a count ("Undoing this import lets
  N previously-skipped rows from later imports be restored — review?") rather
  than silently mutating other batches.
- Watch the interaction with soft-flags: a re-materialized row should also go
  through `mark_import_suspects`/the cross-account sweep, the same as the
  manual "Import duplicates" path already does.

---

## Frontend data freshness

### Dependency-based cache invalidation (only if derived views proliferate)

**Context.** Writes that change a transaction's categorization/trashed state
now go through the `txnMutations` layer (`src/lib/txnMutations.js`), which
fires a single `notifyTransactionsChanged()` after each write. Today that
notify just calls `refreshTaskBadge()`. As more views come to depend on
transaction data (dashboard totals, the Categories page's uncategorized
counts, reports), the natural move is to add their refreshes inside that one
function — callers stay unaware. This is the imperative "mutation announces,
listeners re-fetch" model, and it scales fine for a handful of consumers.

This item is the *next* step beyond that, and is **not** something that needs
doing — only worth it if the number of derived views (and the cost of
hand-maintaining "which mutation refreshes which view") grows enough to hurt.

**The idea.** Replace the hand-wired notify→refresh map with
dependency-based invalidation: each view declares the data it depends on
(e.g. a query key like `transactions` or `tasks`), and a mutation simply
says "transactions changed." Anything keyed on that re-derives; nobody
maintains an explicit list of consumers. This is what a query-cache library
(TanStack Query / SWR) gives you out of the box (`queryClient.invalidate
Queries(['transactions'])`), or it can be a small in-house key→subscribers
registry if pulling in a dependency isn't wanted.

**Why deferred / why maybe never.** The current event-bus + `txnMutations`
seam already removed the real pain (callers forgetting to notify — now
impossible, enforced by the `no-restricted-properties` eslint rule). The
remaining benefit is only "stop hand-maintaining the invalidation set inside
`notifyTransactionsChanged`," which is cheap while that set is small. A
query-cache is a real architectural shift: a new dependency (or a hand-rolled
cache), every data-loading screen migrated onto it, and a different mental
model for the whole app. For a single-user app with a few derived views, the
cost outweighs the gain. Revisit if/when: (a) `notifyTransactionsChanged`
grows a long, easy-to-forget list of refreshes, (b) multiple unrelated
domains need the same pattern, or (c) over-refetching from broad broadcasts
becomes a measurable performance problem.

**If picked up.** Prefer TanStack Query unless bundle size rules it out;
migrate read paths to query keys first (leaving `txnMutations` as the write
seam), then switch `notifyTransactionsChanged` to invalidate keys instead of
calling refreshers directly. The `txnMutations` boundary is deliberately the
right place to make this swap — callers won't need to change.
