# Surfacing rules that compete for the same transactions

**Shipped 2026-08-27** as the overlap half of *Rule checkup* on the Rules page (`GET /rules/overlaps`,
`services/rule_overlaps.py`, `components/RuleOverlapsDialog.jsx`). The mechanism and its rules live in
`data-model.md` → Category rules; this file keeps only what that section should not carry — the shapes
that were rejected, and the one case still deferred.

## What shipped, in one line each

Two findings with opposite intents, on demand from a button rather than a maintained count. An
**amount overlap** (warning) is a pair the precedence ordering can separate only by the span term, whose
ranges intersect with neither containing the other — named, never arbitrated, and carrying **Edit only**.
A **matcher nesting** (info) is one merchant matcher matching a strict subset of another's rows — nothing
is wrong, and it is reported both because the winner is not the one a reader predicts and because its
narrow half is often surplus. That half carries **Delete**.

**The delete is on the nesting finding, not the overlap one, and that is the reverse of how it reads.**
It was built on the overlap half first and moved. The user's reasoning, which is the durable part: on an
ambiguous pair the answer is to *refine the conditions until the rules are unambiguous* — deleting one
side picks a winner instead of removing the ambiguity, which is the same objection that killed the
one-click cap below. Whereas a nesting pair whose two rules file to one category under one scope has a
narrow half that changes no categorization at all, and clearing it out is the whole maintenance action.
Delete is offered on the **narrow** rule only; removing the broad one strands every row the narrow
matcher does not reach.

## Dismissal

`rule_overlap_dismissal` is the check's only durable state and `data-model.md` carries the contract. Two
things worth keeping here, both of which look like oversights from the outside.

**Only nesting findings are dismissible, and that is the user's line, not an omission.** Dismissal was
first built for both kinds and cut back. The reasoning: a nesting pair is information, so acknowledging
one is exactly right — but an amount overlap means *it is not deterministic which rule gets applied*, and
a rule set in that state needs refining rather than acknowledging. A dismissed overlap would leave the
ledger categorized by whichever range happened to be arithmetically smaller while the panel reported
nothing outstanding. `DISMISSIBLE_KINDS` is checked where findings are assembled rather than only in the
panel, so a hand-inserted or legacy row cannot hide a warning; there is a test for exactly that.

**Why the key is a fingerprint rather than the rule pair.** Keyed by the pair alone, "this is fine" would
silently also cover a materially different situation those two rules fall into later — most importantly a
narrow rule that becomes surplus and gains a delete offer nobody was asked about. Including the
redundancy verdict costs nothing and makes the dismissal mean what it says. The converse is deliberate
too: editing a rule's *rename* changes no key and re-raises nothing, because it changes nothing about the
finding.

## Deferred: two equal-length keywords that both match

The overlap finding requires an **identical** merchant matcher, because that is what leaves the ordering
with nothing above the span term. Where two matchers merely *nest*, the longer one wins on
`LENGTH(keyword)` before amount is ever consulted, so there is no ambiguity to report — which is why the
"substring containment between different keywords" item this file originally deferred turned out to be
moot for the warning half, and shipped as the informational half instead.

What is genuinely left is narrower than first written: two rules with **different keywords of equal
length** that both match one row (`delta` and `hertz` against "DELTA HERTZ"), whose ranges overlap
without containment. Every ordering term ties, so span decides arbitrarily — the same ambiguity, reached
by a different route. It is not implemented because detecting it needs the *transaction* text: whether
two unrelated keywords can co-occur in one merchant name is a fact about the ledger, not about the
rules, so unlike everything else here it cannot be answered from `category_rule` alone. Worth doing only
if it is ever observed; the pairwise pass would gain a "do any rows match both" probe.

## Related

- `data-model.md` → Category rules — the precedence contract and what the check reports.
- `recurring-detection.md` → §2 — the rule amount-range *drift* signal, the sibling problem: that one is
  a charge falling **outside** a range it used to match, this one is two ranges fighting over the same
  charge. Both are "the amount bounds need attention", and if the count question is ever reopened they
  should be surfaced together.
