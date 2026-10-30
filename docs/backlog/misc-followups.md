# Miscellaneous follow-ups

One-offs too small for their own file. When an entry grows into a project, give it its own file; when it
ships, delete the entry.

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
