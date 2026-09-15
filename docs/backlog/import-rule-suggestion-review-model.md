# Import rule-suggestion review — making the review model explicit

> **Status: in progress.** Stages 1–3 are done; stage 4 remains. Stage 2 left two questions open and
> stage 4 still owes a decision (below). Supersedes
> [import-rule-suggestion-review-extraction.md](import-rule-suggestion-review-extraction.md) as the next
> work on this surface — stage 2 removed most of the page code that item would have split up.

The Generate Rules review behaves correctly and its behavior is the thing to preserve. What is wrong is
the shape: the model of *which rows are being worked together, and what owns them* is implicit, so
several places rediscover it independently — `pending_override` and `synthetic` flags in the stored
review state, `:followup:` / `:refined` suffixes parsed back out of ids, merchant labels as grouping keys — and every user action is orchestrated from the browser as a sequence of independent
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

## Where stage 2 left things

Every page action is one request to `backend/routers/import_export/rule_suggestion_actions.py`, a leaf
module beside `core` whose endpoints each take a scope opener, and each commits whole or not at all:

| Endpoint (per scope) | Page actions it serves |
| --- | --- |
| `…/rule-suggestions/accept` | save, save as-is, bulk save, editing an accepted card (told apart by the stored status), and *Replace existing* (`replace_existing`) |
| `…/rule-suggestions/status` | defer, resume, restore, return to pending (restores `accepted_prior_rows`, trashes `created_rule_id`), discard keep / clear (`clear_categories`), *Keep existing* |
| `…/rule-suggestions/resolve-conflict-set` | the conflict-set card's Apply |
| `…/rule-suggestions/undo` | Undo |

- **Undo is exact, not replayed.** The payload holds the prior entry and status of every suggestion whose
  review state the action changed — found by diffing the review state before and after, so covered
  siblings and synthetic follow-ups need no enumeration — plus each changed row's first capture, the rules
  the action created (trashed on undo) and the rules it trashed (restored on undo). Replaying statuses
  through the review write re-ran an accept's side effects and could not reinstate a trashed rule.
- **There is no raw review-write route.** Its logic is `core.record_rule_suggestion_review`, the
  review-state half every action calls; a route writing review state apart from rules and rows is the
  non-atomic primitive this stage retired. Tests of the review-state rules call it through `_record_review`.
- Conn-taking cores: `rules.update_rule_core`, `rules._restore_trashed_rule`,
  `transactions.settle_rejected_suggestion_rows`, `transactions.restore_categorization_rows`, and
  `core._rule_suggestion_matching_rows` (the matching-rows report's row selection, reused by the accepted-card
  partition redraw).
- The trace and its test, `getCoveredSuggestionIds`, `ruleSuggestionReviewStatus.js`, and the client
  wrappers for apply-to-transactions, the rejected-suggestion disposition and restore-categorization are gone.

### Open from stage 2

- **Undo does not reverse a change to a rule that already existed.** Editing an accepted card updates its
  rule in place (a collision merge also hard-deletes the edited rule), and accepting into a pre-existing
  rule fills that rule's actions; undo restores rows and review state around both but leaves the rule as
  edited, as the page did before. Reversing it means snapshotting the rule row and its tags in the payload.
- **Three routes lost their only caller.** `POST /rules/{id}/apply-to-transactions`,
  `/transactions/rejected-suggestion-disposition` and `/transactions/restore-categorization` remain as thin
  wrappers over the cores, with their tests. Keep them as API, or remove them.

## Where stage 3 left things

Every suggestion in the review response carries `review_group_id`, stamped over the final list by
`core._assign_rule_suggestion_review_groups` at the end of `_build_rule_suggestion_response`, with the
precedence the page used (split root, canonical conflict keyword, normalized merchant label, keyword). The
merchant containers, their `# rows` ordering and the look-back lens read it; the page parses no ids. The
page never edits the suggestion list in place — every action reloads — so a server-computed group cannot
go stale on screen.

That function is now the only reader of the `:followup:` / `:refined` id formats, which are minted with
`RULE_SUGGESTION_FOLLOWUP_ID_MARKER` / `RULE_SUGGESTION_REFINED_CONFLICT_GROUP_SUFFIX`. Its split root is
the follow-up's *remainder* id, not `derived_from_suggestion_id`: for a refinement's collision follow-up
the remainder id is the refined card's id, which the seed id need not be.

## Stage 4 — explicit partition records

Replace the `pending_override` and `synthetic` flags with explicit partition records. The flags are
special-cased in five places today — the entry builder (`_build_rule_suggestion_review_entry`),
`_prune_phantom_rule_suggestion_entry`, `refresh_rule_suggestion_review`, `_merge_review_state_suggestions`,
and the row exclusion in `_build_rule_suggestion_response` — plus `_refine_pending_conflict_group` and
`_build_synthetic_rule_suggestion_entries`, which create them. A partition record gives
`_assign_rule_suggestion_review_groups` a real split root in place of the parsed id — which matters for a
partial accept, where the follow-up's remainder id equals the accepted card's id only if the leftover rows
regenerate under the same keyword, scope and target. Where they do not (say they come back owner-scoped),
the follow-up presumably renders in a container of its own, apart from its merchant; not yet reproduced.

**Owed decision:** the stored review state lives in batch `config_snapshot`, profile `column_map` and the
system workflow state, and older backups carry the flag shape. Choose between normalizing on read (in
`get_rule_suggestion_review_state`, which already normalizes older snapshots "without migrations") and a
migration — a restore of an older backup has to keep working either way.
