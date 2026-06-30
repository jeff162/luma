# TODO

Deferred work and known follow-ups. Each entry is written to stand on its
own; pick any item and you should have enough context to start without
needing the conversation that produced it.

Convention: items are roughly grouped by area. When an item gets done,
delete it or move it to `CHANGELOG.md` if it was user-visible.

Tests we still owe (unit, HTTP, and end-to-end UI) live in `TODO-TESTING.md`.

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

**Context.** A high-level user-facing introduction: what Luma is for,
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

### Duplicate-resolution history (review what you did, and undo it)

**Context.** There is no chronological, reviewable record of the dedupe
decisions a user made (Keep / Discard / Replace / Import-anyway / Restore).
The *raw material* is already persisted, though: every action soft-deletes
(`trashed_at` + `rejection_reason`, even Replace), and each row records how/when
it was resolved (`suspect_resolved_at`, `dedupe_resolved_by`). So no decision is
lossy and recovery is already possible per-row from the duplicate report — what's
missing is a *view* of the decisions over time and a one-click *batch* undo.

**Why deferred (and split).** This is convenience/transparency, not safety —
data loss is already prevented by the soft-delete + per-row Restore/Import-anyway.
So it doesn't clear the "no complexity without a clear payoff" bar yet. Do it in
two steps:

- **v1 — flat history view (nearly free; worth doing later).** Read-only list of
  resolved rows derived from the existing fields — query by `suspect_resolved_at`,
  group by (batch, action, time-window), show action + affected rows. **No new
  table**, and per-row undo already exists (the report's Restore/Import-anyway).
  Delivers most of the transparency value.
- **v2 — action log + grouped/tree view + one-click batch-undo (heavier; only if
  v1 proves used).** A real `dedupe_action` log written at resolve-time
  (action, timestamp, batch, affected txn ids), a tree view (action → affected
  nodes), and undo of a whole action/group.

**Design notes when picked up.**

- Grouping is nearly free at log-time: the review dialog already applies bulk
  selections *as* bulk ("Keep both (N)…"), so a log row written then captures the
  grouping. Only the uncommon one-at-a-time path needs a time-window fallback —
  don't build a fragile post-hoc "these N individual actions were really a bulk"
  heuristic.
- Undo reuses existing inverses (`restore_rejected_duplicate`, remove the
  `account_pair_distinct` pair + re-flag, un-trash the replaced row) — it's
  replaying a soft-delete inverse, not new recovery logic.

---

## Import / input formats

The import pipeline has a sharp **parse seam**: a format-specific stage
(`bytes → decode → _detect_header_row_index → csv.DictReader → headers:list +
rows:list[dict]`) feeds a fully format-agnostic downstream (account resolution,
`ColumnMap`, amount/date parsing, dedupe, categorization, batch/undo, the
imported-category workspace). The parse is currently inlined and **duplicated**
in `backend/routers/import_export/preview.py::preview_csv` and
`core.py::run_import_core`. Extracting it behind a format dispatch (so preview
and run agree) is the shared prerequisite for any new *file* format below.
SimpleFIN is a different animal — see its own entry.

### Tier 1 — XLS / XLSX spreadsheet import

**Context.** Spreadsheets are tabular like CSV — just a binary container — so
once parsed they become the same `(headers, rows)` and the **entire** mapping
UI, account mapping, dedupe, and categorization apply unchanged. This is the
smallest, highest-ROI new format and the natural first step.

**Why deferred.** Nobody has needed it yet, and it's gated on the parse-seam
extraction above (not hard, but real).

**Suggested approach when picked up.**

- Add a parser (openpyxl for `.xlsx`, xlrd for legacy `.xls`) → first sheet →
  `headers + list[dict]`, behind the extracted format dispatch.
- Generalize the seam from "pass `text`, parse with csv inside" to "parse at the
  boundary, pass rows in."
- Edges to handle: a **format-agnostic content hash** (replace
  `make_import_file_hash(text)`, which drives re-import continuity + profile
  matching); **header-row detection over cell rows** (the spreadsheet analog of
  `_detect_header_row_index`); **cell→string normalization** (Excel numbers are
  floats, dates are datetimes — the amount/date parsers expect strings); pick the
  first sheet for v1; the "raw text preview" panel has no spreadsheet analog.
- Pure-python deps keep it cross-platform (Windows/Pi).

### Tier 2 — OFX / QFX / QBO import

**Context.** OFX is a structured financial-exchange format with a defined schema
(`<STMTTRN>`: `TRNTYPE`/`DTPOSTED`/`TRNAMT`/`FITID`/`NAME`/`MEMO`/`CHECKNUM`;
`<BANKACCTFROM>` with `BANKID`/`ACCTID`). QFX and QBO are Intuit's branded OFX
variants — supporting OFX gets ~90% of all three. Because the fields are known,
this does **not** go through column mapping; it needs a branched, mapping-free
import flow that maps OFX fields → internal transaction fields in code, then
feeds the existing construction/dedupe/categorize stages.

**Why deferred.** Bigger than Tier 1: it spans a new parser **plus** a new UX
path **plus** the dedupe subsystem, and no one has asked yet.

**Suggested approach when picked up.**

- Tolerant parser: OFX 1.x is SGML (unclosed tags, not valid XML), 2.x is XML;
  all carry a header block. Either a dependency (`ofxparse`, somewhat
  unmaintained) or a small hand-rolled tolerant parser.
- **Sign flip:** OFX `TRNAMT` is signed with negative = debit; Luma is
  `amount > 0 = money out` — the opposite. Invert exactly.
- **`FITID` is a high-confidence dedupe key** — a bank-assigned, per-account
  unique transaction id, far more reliable than the content-hash + heuristic
  ladder. Slotting it into `backend/services/duplicate_detection.py` (above
  content-hash, per-account) is the main design work and the main payoff.
- Optional: auto-identify/pre-fill the account from `BANKID`+`ACCTID`.
- Dates are OFX timestamps (`YYYYMMDDHHMMSS[.XXX][TZ]`); categories are usually
  absent, so the imported-category workspace mostly doesn't apply.

### SimpleFIN — connection/sync (NOT a file import)

**Context.** SimpleFIN is an open read-only **aggregation protocol** (SimpleFIN
Bridge), not a file format — so it parallels the existing **Plaid** integration
(`backend/routers/plaid.py` + `backend/routers/sync.py`), not the CSV parse
seam. Flow: a setup token → claim POST → an **access URL** with HTTP Basic creds
embedded → `GET {accessUrl}/accounts` → clean JSON (accounts + `transactions`:
`id`/`posted`(epoch)/`amount`(signed decimal)/`description`/`payee`/`memo`).
Strong philosophical fit for local-first/self-hosted: open, cheap, privacy-
friendly, no per-connection Plaid pricing.

**Why deferred.** It's a recurring-sync integration (connection-integration
sized), a distinct track from one-off file import, and Plaid itself isn't
exercised yet.

**Suggested approach when picked up.**

- Mirror the Plaid seams: a connect/claim flow; **credential storage** — the
  access URL is a secret, so encrypt via `services/crypto_service.py` and carry
  it in the **credentials** backup (not the regular backup), e.g. a
  `simplefin_connection` table; a sync path (≈ `sync.py::run_sync`) that pulls
  `/accounts` and feeds rows into the existing insert/dedupe/categorize
  pipeline; account linking.
- The per-transaction `id` is a **stable per-account dedupe key** (like `FITID`
  / `plaid_transaction_id`) — key off it.
- **Sign flip** (negative = money out → Luma positive) and **epoch
  timestamps**, same as OFX.
- Lighter than Plaid: no Link widget, no link-token endpoint, no paid SDK — two
  HTTP calls and JSON. Much of the account model, sync loop, credential crypto,
  and credentials backup is already proven by the Plaid path.

**Ranking.** XLSX first (small, reuses everything). OFX family second (parser +
mapping-free flow + FITID dedupe). SimpleFIN is its own track, but arguably the
best fit if live bank connectivity matters more than ingesting one-off exports.

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

---

## Internationalization (display formatting)

### Tier 1 — app-wide currency symbol + number/date format

**Context.** The app is hardwired to US display conventions: currency is a
literal `$` and an `Intl.NumberFormat('en-US', …)` in
[`moneyDisplay.js`](frontend/src/lib/moneyDisplay.js), and dates are a
hardcoded date-fns `'MMM d, yyyy'` in
[`utils.js`](frontend/src/lib/utils.js). The ask is *formatting* i18n —
currency symbol + decimal/thousands separators + date order — **not**
language translation. The intended shape is therefore a pair of explicit
**currency** and **date-format** settings (so the UI doesn't imply
translation it isn't doing), not a country/locale picker.

This is the cheap, high-value tier and is the realistic need for a
local-first personal-finance app. Deliberately *out of scope* here (recorded
so the boundary is clear):

- **Tier 2 — multi-currency** (a currency per account, mixed in one tenant).
  That's a data-model change (currency column on `account`, likely
  denormalized to `txn`, migrations, import mapping) plus the real problem:
  summaries/dashboard/trends all `SUM` amounts, and you can't meaningfully
  sum USD + EUR — so it needs either a one-currency-per-report rule or FX
  conversion (rates + as-of dates + a rate source). Don't fold this into
  Tier 1.
- **Tier 3 — language translation** (react-i18next + every UI string +
  ongoing translation upkeep). Fully separable; not part of this.

**Why deferred.** A feature nobody has asked for yet, and the formatting
work — while contained — isn't free. Tier 1 is worth doing as a unit when
someone actually wants non-US formatting; the bigger tiers should stay
gated behind real demand (a second-currency account; a non-English user).

**Where the setting lives.** Use the existing per-user/profile preference
infra (`ui_preference` + `useUserPreference` + `UserPreferencesContext`) —
the same model tag reports and panel geometry already use. One wrinkle: the
money/date helpers are module-level constants/functions today, so they need
to read the *active* setting rather than a baked-in constant. The four money
helpers (`formatMoneyMagnitude`, `formatSignedMoneyAmount`,
`formatTransactionAmount`, `formatSignedAxisTick`) already accept a
`currencySymbol` option and are the single chokepoint (~48 call sites funnel
through them), so the change concentrates there — feed them the active
currency/locale from context (or a set-once module config the preference
provider updates) instead of `MONEY_DISPLAY_CONFIG`'s defaults.

**The work splits cleanly into two buckets — keep them distinct.**

*Bucket A — display formatting (cosmetic; no correctness risk).*

- Currency: replace the `'$'` + `en-US` formatter with
  `Intl.NumberFormat(locale, { style: 'currency', currency })`. Prefer this
  over a bare symbol swap — it also gets decimal/thousands separators and
  symbol placement right (e.g. `1.234,56 €`), which swapping only the glyph
  would get wrong. The hand-rolled `k`-abbreviation in `formatSignedAxisTick`
  is the one spot that stays locale-naive and needs a small rethink.
- Dates: thread the chosen format into `formatDate`/`monthLabel` in
  `utils.js` (date-fns with a locale/format, or `Intl.DateTimeFormat`).
- **Audit beyond the central helpers.** A grep for `formatDate` *misses* a
  class of ~9 spots that render a raw `{x.date}` ISO string directly —
  clustered in the duplicate/import surfaces (`UnifiedDuplicatesDialog`,
  `ImportBatchDetail`, `DuplicateRowsDialog`, `TransactionDetail`, plus
  `Settings`/`Transactions`/`ImportExport`). These need routing through
  `formatDate` or they'll keep showing ISO after the user picks a format —
  exactly where "I set my format and half the app ignored it" bugs hide.

*Bucket B — human free-text input parsing (the only correctness risk).*

- The **Transactions quick filter** (`quick_filter`) is matched
  **server-side** in
  [`transactions.py`](backend/routers/transactions.py) (`_parse_quick_filter_date`,
  `_parse_quick_filter_year_month`, `_parse_quick_filter_amount`). Two
  locale-sensitive spots:
  - **Date order ambiguity** — the parser tries `%m/%d/%Y` *first*, so
    `02/01/2023` reads as Feb 1 (US), silently wrong for a DMY user who meant
    1 Feb. A format-string swap isn't enough; the *parse order* (MDY/DMY/YMD)
    must follow the chosen format. Keep ISO `%Y-%m-%d` always-accepted as the
    unambiguous fallback in every format, and document the rule for the
    ambiguous `01/02` case (follow the format order; ISO always works).
  - **Amount separators** — `_parse_quick_filter_amount` strips `,` as
    thousands and parses `.` as decimal; those roles flip in a `1.234,56`
    locale. Same input, wrong number. Needs locale-aware separator handling.
  - **Architectural note:** because this filter resolves in SQL, the locale
    has to reach the backend (pass it alongside `quick_filter`, or have the
    backend read the same stored preference). This is the one place Tier 1
    isn't purely frontend.

**What is *not* a hazard (verified, so it doesn't get over-engineered).**

- The **duplicate-resolution report's date drill-through** looks like a date
  filter but is safe: `UnifiedDuplicatesDialog` passes a row's *stored ISO*
  date (`matched.date` / `c.date`) as `dateStart`/`dateEnd` →
  `ImportBatchDetail` → backend `date_start`/`date_end` vs `t.date`. It's a
  machine-to-machine ISO round-trip with no human-format parsing, so it has
  **no ambiguity risk**. Its only Tier-1 touch is *display* — the raw ISO it
  renders (the matched-row dates and the `(filtered: 2023-02-01 …)` label)
  falls under Bucket A.
- The **FilterBar date range** is a picker whose stored value is ISO —
  locale-independent.
- **Import column date parsing** is a separate, already-format-inferring
  system — not part of this.

**Suggested order when picked up.**

- Add the currency + date-format preferences and the Settings controls.
- Bucket A first (cosmetic, low-risk): money helpers, then `utils.js`, then
  sweep the ~9 raw `{x.date}` renders.
- Bucket B second (correctness): thread the format to the backend, make the
  quick-filter date/amount parsers format-aware with ISO always accepted, and
  add tests for the ambiguous `01/02` and `1.234,56` cases.

---

## Tooling

### Raise lint strictness to a reasonable baseline and triage the results

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

### Wire up ruff (and replace the bespoke timestamp guard with `flake8-datetimez`)

**Context.** `backend/pyproject.toml` configures ruff (`[tool.ruff]`, selecting
`E`/`F`/`W`/`I`), but ruff is **never actually run** — it's not in CI (there is
no `.github/workflows`), not in `scripts/pre-commit.sh`, and not installed in
the venv. So the config is currently aspirational. The one enforced backend
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
