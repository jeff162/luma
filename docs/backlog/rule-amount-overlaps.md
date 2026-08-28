# Surfacing rules whose amount ranges conflict

**Parked, not started (2026-08-27).** Split out of the recurring-signals work, where it was noticed but
does not belong — this is a rules problem, not a recurring one.

## What is already fixed

Rule precedence now ranks by the **span** of a rule's amount range rather than by how many bounds it
sets, so a range *contained* in another wins: `>= 3000` beats `>= 300` for a $3,618 charge. A final
tiebreak on rule id makes a genuine tie resolve the same way every time. The contract lives in one
place, `categorizer.rule_specificity_order_sql`, shared by the engine, the preview/apply mirror and the
rules list; `data-model.md` → Category rules carries the *why*. Regression coverage is in
`backend/tests/test_rule_amount_specificity.py`.

That closes containment. **It does not close overlap**, which is what this file is for.

## The case ordering cannot answer

`[300, 4000]` against `[3000, ∞)`. A $3,500 charge matches both; neither range contains the other. The
span comparison will pick one, but only by arithmetic accident — there is no reading of the two rules
under which one is more specific than the other. It is a modelling ambiguity in the rules themselves,
so no ordering can resolve it, and inventing a tiebreak would dress a coin flip as a decision.

The right response is to make the pair **visible** and let the user decide, usually by making the ranges
disjoint (capping the broad rule is what the user did when they hit this).

## Shape, as discussed

**A button, not a maintained count.** The user's call: a control on the Rules page that runs the check
on demand and lists the conflicting pairs. An always-current badge was left open — it may be cheap
enough to compute alongside the rules list, but it was explicitly not required, and a count that nags
about a modelling choice someone made deliberately is worse than one they ask for.

The check itself is a pairwise pass over rules that could match the same row:

- Same effective merchant matcher — for a first cut, an identical `keyword`, since that is the case that
  actually bites (several bills from one biller). Substring containment between different keywords is the
  more thorough version and can come later.
- Compatible scopes (owner / account / account type / direction) — two rules scoped to different
  accounts can never contend.
- Amount intervals that **intersect without one containing the other**. Containment is not a conflict:
  precedence answers it correctly now, and flagging it would cry wolf on the two-rule split that is the
  recommended pattern.

## Worth saying in the UI

The finding is not "these rules are wrong" but "these two could both claim a charge and nothing decides
which". The useful action is *make them disjoint* — offer to cap the broader rule at the narrower one's
floor, which is the same one-click shape as the recurring **Widen to include** action, in reverse.

## Related

- `data-model.md` → Category rules — the precedence contract as it now stands.
- `recurring-detection.md` → §2 — the rule amount-range *drift* signal, which is the sibling problem:
  that one is a charge falling **outside** a range it used to match, this one is two ranges fighting
  over the same charge. Both are "the amount bounds need attention", and if the count question is ever
  reopened they should probably be surfaced together.
