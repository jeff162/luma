# Account type as a selection criterion (rules, filtering, search) + PayPal as an account type

**Status: backlog, not started (2026-07-20).** Came out of the PayPal money-movement work: the
money-movement rules are scoped to a specific PayPal **account id**, which means one rule per PayPal
account (auto-built, so nothing to maintain — see `paypal-money-movement-recognition.md`). A cleaner
long-term primitive is to scope by **account *type*** ("this is a PayPal / Amazon wallet") so **one** rule
covers all accounts of that type. This item is that generalization. **Deliberately punts on existing
data** — no backfill required.

## Why account type, not `source_kind`

Both could express "restrict to PayPal", but account type is the better axis:

- **Intrinsic, not provenance.** An account *is* a PayPal wallet; `source_kind` is an incidental fact
  about which importer produced a *batch* (one join away on `import_batch`, only two thin values today —
  `marketplace:amazon`, `source:paypal`, else NULL).
- **Retroactive by nature.** A type on the account applies to every transaction on it, regardless of how
  or when it was imported. (`source_kind` only exists on batches stamped after that feature — a real gap.)
- **One rule covers all accounts of the type** — dissolves the per-account-rule duplication.

The account table already has a `type`/`subtype` column, and Amazon accounts already carry a marketplace
kind, so this axis is partially modeled — it's an extension, not a new invention.

## Scope

1. **Add PayPal as an account type.** Designate PayPal accounts a first-class type (as Amazon's
   marketplace kind already is). Decide the taxonomy: is "PayPal" a `type`, a `subtype`, or a `kind`
   alongside the existing marketplace kind? Auto-assign it when a PayPal Activity file is imported into a
   new account (the sniff already exists — `sniff_paypal_activity`), and allow the user to set/clear it on
   the Accounts page.
2. **Account type as a rule criterion.** A rule gains an optional account-*type* scope (alongside the
   existing account-*id* scope). `rule_matches_row` already scopes by `account_id`; add a parallel
   `account_type` clause (the row already carries its account, so join/resolve the type). Thread through
   the rule model, the matcher, `recategorize_all`, and the rule editor UI (a structured picker — **no**
   free-text ambiguity, unlike search below). Money-movement rules then migrate from per-account-id to a
   single account-type scope (a small, clean change once this lands).
3. **Account type in filtering / search.** Let the transaction filters and search scope by account type.
   **Structured filters** (a chip / dropdown) are unambiguous and the safe first step. **Free-text search
   is the hard part** — bare "amazon" collides across account *type*, account *name*, and merchant text.
   If free-text scoping is wanted, that argues for a **metadata-tag query grammar** (`accttype:amazon`,
   `acctname:amazon`, …) — a real UX investment worth its own design pass; don't fold it in casually. The
   structured-filter path can ship without it.

## Reuse / where it lives

- Account type/kind — the existing `account.type`/`subtype` + the marketplace-kind precedent
  (`ACCOUNT_TYPES`, `architecture.md` → "Marketplace accounts — the extension pattern").
- Rule matching — `services/categorizer.rule_matches_row` (already has the `account_id` clause to mirror),
  `recategorize_all`, the rule model in `routers/rules.py`, and `RuleForm.jsx`.
- The money-movement rules (`services/money_movement.create_money_movement_rules`) are the first consumer
  ready to migrate from account-id to account-type scope.

## First consumer detail — the PayPal money-movement rules (as shipped)

The single system PayPal data source has `account_id` NULL — one source spans accounts (provenance, not
content, as data sources should). But the money-movement **rules underneath are still per-account**
(`account_id`-scoped), which is why the source-level review has to gather *all* the source's accounts
(`profile_account_ids`) and create/delete a rule per account per `Type`. When account-*type* scoping lands,
those **collapse to one rule per `Type`** (scoped to the PayPal account type), and the review no longer has
to enumerate accounts — the review + apply just target the type. That migration is the concrete first win
of this item.

Interim note (until this lands): `create_money_movement_rules` writes into `category_rule` directly rather
than through `rules.create_rule`'s reconciliation, so it carries its own guards — it refuses an empty
account set (which would fork a *global* rule) and skips a `Type` whose (keyword, account, source-text)
matcher already exists (idempotent for ours, and it won't fork past a user rule pointing elsewhere). The
account-type migration should fold these rules onto the shared `create_rule` path so the one-matcher
reconciliation is inherited rather than re-implemented.

## Open questions

- PayPal as `type` vs `subtype` vs a new `kind` dimension (and how it coexists with marketplace).
- Whether to denormalize account type onto the transaction for cheap matching/search, vs join at read.
- Free-text search: structured filter only, or commit to the `accttype:`/`acctname:` tag grammar.
