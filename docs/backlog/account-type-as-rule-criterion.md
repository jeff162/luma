# Account type as a filtering and search axis

**Parts 1–2 shipped 2026-07-21 (migration v13); part 3 has not started.** The account-*type* axis
itself exists and is durable behavior: PayPal is a first-class `account.type`, `category_rule.account_type`
matches a row's *effective* account type, precedence runs account_id > account_type > global, and the
type joins the one-rule-per-matcher identity. That model — including why the axis is the account's type
rather than the batch's `source_kind` — is in [`../data-model.md`](../data-model.md) → *Accounts* and
*Rules*, with the mechanism in `architecture.md` → *Rules and categorization*. The money-movement rules
were migrated onto it and now collapse to one `account_type='paypal'` rule per `Type`.

This file keeps only part 3: letting the **transaction filters and search** scope by account type.

## The two halves, and why they are not one task

**Structured filters are the safe half.** A chip or dropdown that scopes the transaction list by account
type is unambiguous, mirrors the rule editor's scope picker, and can ship on its own. Nothing here was
built.

**Free-text search is the hard half, and it is a design pass rather than a feature.** A bare `amazon`
typed into search collides across three facets at once — account *type*, account *name*, and merchant
text — and there is no reading of the bare term that is right in every case. Scoping by type in free text
therefore argues for a metadata-tag query grammar (`accttype:amazon`, `acctname:amazon`, …), which is a
real UX investment: reserved delimiters, discoverability, and an error model for a malformed term. Don't
fold it in casually alongside the structured filters.

## The constraint any grammar has to respect

If a multi-term merchant grammar is ever built (something like `:foo: :bar:` for "contains foo AND bar"),
it must **compile into the representation the rule matcher already uses** — `category_rule.match_expr`
(`{op:"and", clauses:[{type:"contains", text}]}`) — and evaluate through the shared
`merchant_matcher_matches` predicate, rather than growing a second matcher beside it. The rule side
(AND-only, contains-only, ≤3 clauses) was deliberately shaped to leave that room. Two matchers that are
meant to agree and are written twice will diverge, and the divergence shows up as a rule that previews
differently from how it fires.

## Open

- **Structured filter only, or commit to the `accttype:` / `acctname:` grammar.** The structured path can
  ship without ever answering this; committing to the grammar is what needs deciding before either is
  built, since a structured-only chip set is not a stepping stone to it.
- **Denormalize account type onto the transaction, or join at read.** Rule matching joins today and the
  cost is invisible; a search facet is a different access pattern and may not be. Measure before
  denormalizing — a copied type is a second thing to keep correct when an account is re-typed or merged.
