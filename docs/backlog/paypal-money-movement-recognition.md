# PayPal money-movement recognition — the deferred generalization

**The feature shipped (2026-07-20), and so did the follow-on this file used to track.** PayPal source
recognition, force-capture of `Type` + `Item Title`, and the user-approved, bidirectional `Type` →
*Money movement* rules are live and documented as durable behavior — see
[`../data-model.md`](../data-model.md) → *PayPal source recognition*.

The rules are **account-type-scoped**, not per-account: migration v13 (2026-07-21) added
`category_rule.account_type`, consolidated the per-account rules onto one `account_type='paypal'` rule
per `Type`, and `create_money_movement_rules` has since routed through the shared `create_rule_core`.
This file previously listed that migration as deferred, which stopped being true the day it landed.

## Deferred — one item

**Fold the review into the generic rule-suggestion engine, clustering by `Type`.** The shipped review is
a dedicated, PayPal-specific surface — the deliberate low-risk first cut, and the only piece of the
original design left undone.

`_generate_rule_suggestions` clusters candidates by **merchant name** only, so money-movement rows never
cluster at all: their names vary, or are absent, or are just "PayPal". Teaching it to also cluster by a
captured **categorical** evidence field (`Type`) on a recognized source would fold money movement into
the ordinary rule-suggestion review, which is more general and is the eventual home.

The evidence-role machinery this needs already exists — `import_evidence.py` stamps each captured field
`descriptive` or `categorical`, and `Type` is exactly the categorical case (see
[`../data-model.md`](../data-model.md) → *Import batches and profiles*). What is missing is the
clustering key, not the data.
