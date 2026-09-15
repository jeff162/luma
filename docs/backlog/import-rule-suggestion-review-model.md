# Import rule-suggestion review — making the review model explicit

> **Status: in progress.** Stage 1 is done; stages 2–4 remain, in order. Stage 2's decisions are
> settled (below); stage 4 still owes one. Supersedes
> [import-rule-suggestion-review-extraction.md](import-rule-suggestion-review-extraction.md) as the next
> work on this surface — stage 2 removes most of the page code that item would have split up.

The Generate Rules review behaves correctly and its behavior is the thing to preserve. What is wrong is
the shape: the model of *which rows are being worked together, and what owns them* is implicit, so
several places rediscover it independently — `pending_override` and `synthetic` flags in the stored
review state, `:followup:` / `:refined` suffixes parsed back out of ids by the frontend, merchant labels
as grouping keys — and every user action is orchestrated from the browser as a sequence of independent
requests with no atomicity.

Read first: `docs/data-model.md` → the rule-suggestion sections (*Conflict-set matcher refinement*,
*Rejecting a rule suggestion*, the conflict-set card, merchant containers, *Look-back lens*, *Bulk
disposition*), `docs/ui-patterns.md` → *Rule suggestion review — bulk select alongside per-card actions*,
and `docs/collaboration-notes.md` → the design-pass habit and "edit selection criteria is a persisted
partition operation".

## Where stage 1 left things

`backend/routers/import_export/core.py` has one implementation per endpoint family (get, review, clear,
restore, refine-match, matches). `_RuleSuggestionReviewScope` carries the only three things that differ
between the batch, profile and system scopes — the review-state store, the row population
(`batch_join` + `txn_filter`, shared by the generator's row query and the matching-rows report), and the
report's identity fields — built by `_open_batch_review_scope` / `_open_profile_review_scope` /
`_open_system_review_scope`. Routes are one line each. New endpoints in stages 2–4 take a scope opener
the same way rather than adding per-scope copies.

`test_every_review_scope_reads_its_own_rows_and_writes_its_own_store` drives every family through all
three scopes over deliberately different populations; extend it when a new endpoint joins the family.

## The lifecycle the refactor must preserve

| State | What owns the rows | Rule | What `source_row_ids` means |
| --- | --- | --- | --- |
| pending, generated | nothing — rows stay `import` | none | rows the generator grouped on this read (recomputed every read) |
| pending, refined (`pending_override`) | the persisted entry; its rows are excluded from canonical generation | none | rows matched by the refined matcher at refine time |
| pending, follow-up (`synthetic`, `…:followup:<root>`) | the persisted entry | none | the remainder of a partial accept, or of a refinement whose remainder id collided |
| accepted | the rule — rows reclaimed to `rule` by a scoped preserve-manual apply | `rule_id`; `created_rule_id` only if this review created it | rows the accept applied to; `accepted_prior_rows` is their pre-apply snapshot |
| deferred (`skipped`) | unchanged | none | rows as they stood at deferral |
| discarded | `import` (keep) / `manual` (re-pointed) / `cleared` | none | rows settled; `review_action` records the category transition |
| trashed | review-state only | untouched | preserved so Restore brings the set back |

Transitions:

- **Narrow or broaden a pending card's criteria** → re-partition (`_refine_pending_conflict_group`).
  Broadening back to the merchant's ordinary matcher releases the rows to canonical generation.
- **Accept with a stricter matcher than the entry's rows** → a synthetic follow-up holds the leftover rows.
- **Edit an accepted card** → redraw its partition: newly matching rows join, rows that no longer match
  get `accepted_prior_rows` restored so they regenerate as pending.
- **Return an accepted card to pending** → restore `accepted_prior_rows`, trash `created_rule_id` (never a
  pre-existing rule it merged into).
- **Undo** → reverse rules, rows and review state together.

## Stage 2 — one transactional endpoint per action, and an undo endpoint

### What each page action does today

All in `frontend/src/pages/ImportRuleSuggestions.jsx`; each arrow is a separate request.

| Action | Sequence |
| --- | --- |
| `saveSuggestion` | create rule → scoped apply → push undo → review update → optional full-force apply ("apply to existing") |
| `saveAcceptedSuggestion` | update or create rule → load matches → scoped apply → restore released rows → load snapshots → push undo → review update |
| `applyConflictSet` | create rule → accept winner → per member: disposition + discard → apply to rule rows → re-accept winner → re-discard members with `review_action` |
| `saveSuggestionsAsIsBulk` | per suggestion: create rule → scoped apply → review update |
| `rejectSuggestionWithDisposition` / `bulkRejectWithDisposition` | disposition → push undo → review update(s) |
| `replaceConflictingRule` / `keepExistingRule` | update existing rule → scoped apply → review update / review update to `skipped` |
| return to pending (`applySuggestionStatus`, `setSuggestionStatusBulk`) | restore prior rows → trash created rule → review update |
| `performUndo` | trash rules → restore rows → replay each status — every step `.catch(() => {})` |

### Defects this fixes, found while mapping the above

- **Partial writes.** A failure mid-sequence leaves, for example, a created rule with its suggestion still
  pending. Several steps are deliberately best-effort (a failed scoped apply or disposition still records
  the accept/discard).
- **Undo can half-succeed silently**, because every undo step swallows its own error.
- **Undo misses "apply to existing".** `saveSuggestion` pushes the undo entry before the full-force
  `txnMutations.applyRule`, and that call's result is discarded — undo then trashes the rule, but the rows
  it claimed keep its category.
- **Covered-suggestion detection is implemented twice**: `getCoveredSuggestionIds` on the page and
  `_rule_suggestion_entry_covers` / `_discard_covered_rule_suggestions` on the backend.

### Decisions (settled)

1. **Roll back everything on failure.** An action is one transaction; a failure writes nothing. The
   best-effort steps go away. *Expected* outcomes are not failures: a rule `conflict` still leaves that
   suggestion pending and is named in the summary, and in a bulk save the non-conflicting suggestions
   still commit. This is a deliberate behavior change from today.
2. **Undo stays client-held.** The action returns an undo payload; the page keeps its stack (session-local,
   lost on reload, as today) and posts the payload to a single undo endpoint that reverses rules, rows and
   review state in one transaction. `restore-categorization` already accepts client-supplied snapshots, so
   this adds no new trust.
3. **"Apply to existing" rows join the undo payload.** When an accept opts into the full-force apply, its
   prior-row snapshot is captured and restored on undo.
4. **Delete the debug trace.** `traceRuleSuggestionAction` and its correlation plumbing on the page,
   `POST /rule-suggestions/debug-trace`, `_build_rule_suggestion_trace_record` and friends,
   `RuleSuggestionDebugTraceRequest`, `LUMA_RULE_SUGGESTION_TRACE_PATH`, and
   `test_debug_trace_enriches_identifiers_from_committed_database_state`. It was a temporary diagnostic;
   with actions server-side the per-step client trail describes nothing useful.

### Building blocks and gaps

Conn-taking cores that already exist: `create_rule_core(conn, body, on_existing)` and
`_apply_rule_to_existing(conn, rule_id, preserve_manual=…, txn_ids=…, capture_prior=…)` and
`_trash_rule(conn, rule_id)` in `backend/routers/rules.py`. Route handlers that open their own `get_db()`
and need a conn-taking core extracted first: `update_rule` (rules.py), `set_rejected_suggestion_disposition`
and `restore_categorization` (transactions.py).

Obstacles to respect:

- **`_rescan_recurring` runs after commit**, outside the transaction, with the affected ids and prior payee
  keys collected during it — every action endpoint must do the same, or recurring membership goes stale.
- **An action is one `with get_db()` block.** `get_db()` commits only when the block exits normally; an
  exception skips the commit and closing the connection discards the uncommitted writes, which is the
  rollback decision 1 relies on. It holds only while nothing inside the block calls `conn.commit()` —
  none of the rules/transactions cores do today — so pin it in the rollback test rather than trusting it.
- **The frontend's transaction-change notification.** `txnMutations.js` is the only sanctioned caller of
  transaction writes (an eslint `no-restricted-properties` rule enforces it) because it fires
  `luma:transactions-changed`. The new action calls change transactions, so route them through
  `txnMutations` rather than calling `api.*` from the page.
- **Undo trashes rather than deletes** a created rule (`api.deleteRule` → `_trash_rule`, soft delete); keep
  that, so an undone accept's rule is still recoverable from Settings.

### Tests first

Backend tests in `backend/tests/test_import_rule_suggestion_review.py`, one per transition in the lifecycle
table, each asserting rules, rows and review state together — plus one test that forces a failure
partway through an action and asserts nothing was written, and one for undo of an accept that used "apply
to existing". Drive each through at least one non-system scope. Then remove the page orchestration,
`getCoveredSuggestionIds`, and the trace, and run the full gate plus
`npx playwright test tests/ui/a11y-rule-suggestions.spec.js --config=playwright.config.js --project=a11y --no-deps`
(the only browser spec that loads this page; the default gate does not run the a11y lane).

## Stage 3 — the backend sends the grouping

The frontend reconstructs "same working set" by parsing ids: `getRuleSuggestionSplitRootId`,
`getRuleSuggestionSplitRootIds` and `getRuleSuggestionMerchantGroupKey` in
`frontend/src/lib/importRuleSuggestions.js` look for `:followup:`, split `conflict_group_id` at its last
`:`, and special-case a `:refined` suffix. The look-back lens (`getInWindowPendingSuggestionGroups`, used
by `ImportRuleSuggestionReview.jsx`) and merchant-container ordering key on the result.

Send a `review_group_id` (and whatever partition identity the UI needs) on each suggestion from
`_build_rule_suggestion_response` / `_merge_review_state_suggestions`, computed with today's precedence —
split root, then canonical conflict keyword, then normalized merchant label, then keyword — so grouping is
unchanged. Move the lens and the container ordering onto it and delete the id parsing. Additive: no stored
state changes. The lens stays a view filter (a documented decision in `data-model.md` → *Look-back
lens*); only its grouping source moves.

## Stage 4 — explicit partition records

Replace the `pending_override` and `synthetic` flags with explicit partition records. The flags are
special-cased in five places today — the entry builder (`_build_rule_suggestion_review_entry`),
`_prune_phantom_rule_suggestion_entry`, `refresh_rule_suggestion_review`, `_merge_review_state_suggestions`,
and the row exclusion in `_build_rule_suggestion_response` — plus `_refine_pending_conflict_group` and
`_build_synthetic_rule_suggestion_entries`, which create them.

**Owed decision:** the stored review state lives in batch `config_snapshot`, profile `column_map` and the
system workflow state, and older backups carry the flag shape. Choose between normalizing on read (in
`get_rule_suggestion_review_state`, which already normalizes older snapshots "without migrations") and a
migration — a restore of an older backup has to keep working either way. Design this once stages 2–3 have
landed.
