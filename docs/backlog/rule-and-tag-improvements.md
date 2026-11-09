# Small rule and tag improvements

## What it is

One-offs too small for their own file:

- **Show where a transaction's tag comes from.** A tag can be added by hand, by a rule and by the
  category all at once, but the tag picker shows only one source, so unchecking it cannot offer "remove
  my copy, keep the inherited one".
- **A rule option that stops lower rules from applying**, as mail filters have, so one rule can fully
  govern the transactions it matches.
- **Whether saving a rule overrides hand-set categories.** *Apply to existing* in the rule editor
  recategorizes every match, including rows categorized by hand. A decision is owed on whether it should
  spare them by default and let them be opted in one by one from the affected-transactions report.

**Where it stands:** ideas, not started; the hand-set categories entry needs a decision first. When an
entry grows into a project, give it its own file; when it ships, delete the entry.

## Showing every source of a transaction's tag

A tag can reach a transaction from several sources at once (attached by hand, by a rule, or inherited
from its category), but the API reports only the winner (`direct` beats `category`, `_SOURCE_PRIORITY`),
and a rule-attached tag and a hand-attached one both read as `direct`. So the picker cannot say that a
tag checked here is also inherited, and unchecking it offers only "hide here" where someone may mean
"remove my copy, keep the inherited one".

**The idea.** Report every contributing source (`sources: ['direct', 'category']`, with rule and manual
told apart). The merge loop in `get_visible_transaction_tag_map` has both facts at the point where it
discards one, so the data side is cheap. The picker could then show "added here · also from Coffee
Shops" and offer the two intents as separate actions.

**Not a defect today.** Checking a tag on a transaction with no row writes a force-on row
(`set_manual_transaction_tag`), from the picker and from bulk `add_tags` alike, so a hand-checked tag
survives a later recategorization. Two cases deliberately keep no force-on row: re-checking a tag that
was hidden only removes the hide, and re-checking a rule's tag returns it to following the rule.

## A rule action that stops later rules from applying

Every matching rule contributes: the category and the rename come from the highest-ranked rule that sets
one, and the tags of every matching rule are added together (`docs/data-model.md` → *How matching rules
combine*). There is no way to say that one rule alone governs what it matches.

**The idea.** A per-rule *stop matching* option, as mail filters have: once this rule matches, rules
ranked below it contribute nothing to that transaction.

**Open questions.**

- Precedence is computed, not hand-ordered, so "below" means below in `rule_specificity_order_sql`. The
  option cannot settle the rule checkup's arbitrary pairs, where the ranking between two rules is itself
  the accident; it would only make ranking matter more.
- Every path that mirrors the engine would have to honour it: preview and single-rule apply in
  `routers/rules`, and rule-backed series membership, which tests each rule on its own
  (`recurring_detection._candidate_members`).
- The checkup's outcome test (`rule_overlaps._outcomes_agree`) would change: with a stopping rule in a
  pair, tags and a rename that only one side carries would depend on which rule wins.

## Whether saving a rule overrides hand-set categories

**Decision owed.** Saving a rule with *Apply to existing* ticked, from the Rules page, the rule toast's
editor or the rule action dialog, calls the full-force apply (`_apply_rule_to_existing` with
`preserve_manual=False`, `routers/rules.py`). It recategorizes every matching row, including a row whose
category was set by hand (`category_source = 'manual'`). Every other path a rule reaches existing rows
by spares those rows: rules running on import and sync, a merge or replace, widening a rule's amount
range, and accepting a suggestion on the review page. Split transactions keep their categories under
both modes.

So the editor's *Transactions affected by this rule* report (`RulePreviewDialog`) lists hand-set rows,
and categorizing one of them by hand from the report does not take it out of the list, because the
apply would still change it.

Sometimes overriding hand-set categories is the point: a rule written to correct a merchant that was
categorized by hand inconsistently. Sometimes it is not: a few deliberate exceptions should survive.

**The user's idea.** Spare hand-set rows by default (`preserve_manual=True`). The affected-transactions
report also lists the hand-set matches the apply would skip, with a checkbox on each to include it, so
correcting earlier hand edits is a deliberate, row-by-row choice.

**What it would touch.**

- The preview endpoint the editor calls would report the spared hand-set rows separately from the rows
  that would change, so the editor's "N would change" count and the report agree with what the apply
  does.
- The apply would take the ids opted in, on top of the gentle apply. `_apply_rule_to_existing` already
  takes `txn_ids` to restrict an apply; one call could do the gentle apply and a second, full-force one
  restricted to the opted-in rows.
- The report needs a selection column on those rows. `TransactionListTable` has none today, so either it
  gains one or the spared rows get a section of their own.
- Every editor caller of `txnMutations.applyRule` changes together (`pages/Rules.jsx`,
  `RuleSuggestionToast.jsx`, `RuleActionModal.jsx`), along with the help text that describes *Apply to
  existing*.
