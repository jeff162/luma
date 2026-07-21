# PayPal money-movement recognition — deferred generalization

**The feature shipped (2026-07-20).** PayPal source recognition, force-capture of `Type` + `Item Title`,
and the user-approved `Type` → *Money movement* rules (with the source-scoped, bidirectional review) are
all live and documented as durable behavior — see `data-model.md` → wallet funding-leg suppression
("PayPal source recognition + `Type`-based money-movement categorization") and `ui-patterns.md` →
"PayPal money-movement review". This file keeps only what was **not** built.

## Deferred

- **Fold the review into the generic rule-suggestion engine (cluster by `Type`).** The shipped review is
  a dedicated, PayPal-specific surface — the deliberate low-risk first cut. `_generate_rule_suggestions`
  today clusters candidates by *merchant name* only, so money-movement rows (whose names vary or are
  nameless/"PayPal") never cluster. Teaching it to also cluster by a captured **categorical** evidence
  field (`Type`) for recognized sources would fold money-movement into the normal rule-suggestion review —
  more general, and the eventual home. This is the only piece of the original design left undone.
- **Migrate the created rules from account-id to account-type scope.** The rules are scoped per PayPal
  `account_id` today (one auto-built rule per account, nothing to maintain). Account-*type* scoping — one
  rule across all PayPal accounts — is the cleaner long-term axis and is tracked in
  `account-type-as-rule-criterion.md`; migrate once that lands.
