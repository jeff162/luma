# PayPal money-movement recognition + source-aware field capture

**Status: A + B + C landed (2026-07-20).** Motivated by a concrete bug: four 2019 PayPal *hold* rows
imported as spending. The design generalizes to all PayPal money-movement noise and answers two
objections to a naive fix (vocabulary staleness; the capture dependency).

**Landed (2026-07-20):**

- **Part A** — `sniff_paypal_activity(headers)` (core.py, header-marker subset + BOM strip);
  `preview` returns `is_paypal`; a recognized CSV batch is stamped `source_kind = 'source:paypal'`
  (`PAYPAL_SOURCE_KIND`).
- **Part B** — `_forced_evidence_headers(headers)` force-captures `Type` + `Item Title` for recognized
  PayPal files regardless of `evidence_columns`, wired through `_build_evidence_column_plan`; the capture
  panel shows them checked-and-disabled with an "always captured for PayPal" note
  (`ImportEvidenceColumnsSection` `forced` prop + `forcedEvidenceColumns` helper).
- **Part C** — money-movement recognition as **user-approved rules** (`services/money_movement.py`):
  `is_money_movement_type` (fragment-based, stale-resistant), `money_movement_type_proposals(batch)`,
  `create_money_movement_rules(types)` (idempotent `match_source_text` rules → the excluded Money movement
  category). Endpoints `GET/POST /import-export/batches/{id}/money-movement-{types,rules}`; the POST runs
  `recategorize_all`, so existing rows (the 2019 holds) are fixed too. The import result carries
  `is_paypal`, and a **dedicated post-import review** (`MoneyMovementReviewDialog`) proposes the batch's
  Types — money-movement pre-checked, payments unchecked — and the user approves. **Nothing is
  auto-applied.** Chosen over extending the generic suggestion engine (which clusters by merchant name) as
  the low-risk first cut; folding into that engine (clustering by `Type`) remains the deferred generalization.
- **Part C edit surface + account scoping** — the created rules are **scoped to the PayPal account(s)**
  (`account_id`), so a same-text transaction elsewhere can't match; multiple PayPal accounts get one
  auto-built rule each (nothing to maintain). The review is **re-openable and bidirectional**: it reflects
  each type's `already_ruled` state, and the apply endpoint takes `{add, remove}` —
  `create_money_movement_rules` / `delete_money_movement_rules`, then `recategorize_all`. (Account-*type*
  scoping — one rule across all PayPal accounts — is the cleaner long-term axis:
  `account-type-as-rule-criterion.md`.)
- **Single system PayPal data source + one source-level review.** Migration 11 adds `source_kind` to
  `csv_import_profile`; a recognized PayPal import with no source auto-attaches to the one
  `source:paypal` profile (`_get_or_create_paypal_profile`, named "PayPal"/"PayPal 2"…, `account_id` NULL,
  visible/renamable like any source but **not deletable**). So PayPal imports group under one header, and
  the money-movement review is **profile-scoped** (`money_movement_type_proposals_for_profile`,
  `apply_profile_money_movement_rules` over `profile_account_ids`) — one **"Money movement" button on the
  data-source header** covering *every* PayPal type across *all* imports, instead of one per card. Opens
  automatically post-import and from the header.
- Tests: `test_import_evidence_roles.py`, `test_import_evidence_capture.py`, `test_paypal_money_movement.py`
  (proposals + `already_ruled`, approval → excluded category, account scoping, add/remove round-trip,
  idempotency), `importColumnInference.test.js`.

**Deferred:** fold the Part-C review into the generic rule-suggestion engine (cluster by `Type`), per the
user's longer-term lean — see "Part C — option 2". Migrate money-movement rules from account-id to
account-type scope once that lands (`account-type-as-rule-criterion.md`).

## Problem

PayPal Activity rows that are **money movement, not spending** — holds and their reversals, bank
deposits/withdrawals into the wallet, card deposits, currency conversions — currently import as ordinary
(counted) transactions whenever they *aren't* caught by coverage rejection. Coverage only catches them in
a date range a prior aggregator already imported; outside that range (e.g. **2019**, before the user's
Mint coverage window of 2020-04-07…2023-12-03) they flow straight into the ledger as spend/income.

**Observed (2019, PayPal account):** `Account Hold for Open Authorization` (+$7.00) and
`Reversal of General Account Hold` (−$7.00, −$4.00, −$38.43) — pure holds/reversals that net to zero,
counted as real transactions.

## Why `Type` is the signal (and structure is not)

The instinct to recognize money-movement *structurally* ("no external counterparty") was tested against
the live data and **fails**: money-movement rows frequently carry a name (Mint attaches the associated
merchant) — `Bank Deposit to PP Account` appeared 17× *with* a counterparty name vs 1× nameless;
`General Withdrawal` 20× named. The **`Type`** field is the semantically precise signal
(`Bank Deposit to PP Account` is unambiguously money-movement regardless of any name riding along), so
the design keys on `Type`. The two real objections to that, and how the design answers them:

1. **A hardcoded `Type` vocabulary goes stale** as PayPal renames/adds types. → Own the vocabulary as
   **editable rules + adaptive suggestions**, not a code constant (Parts C/D).
2. **It depends on `Type` being captured**, which the user can uncheck. `_build_evidence_column_plan`
   captures *exactly* `col.evidence_columns` when provided, so an unchecked `Type` is simply absent
   (default-checked ≠ guaranteed). → **Force-capture** `Type` (and `Item Title`) for recognized PayPal
   files (Part B).

## Part A — Recognize PayPal Activity files by header

A backend `sniff_paypal(headers) -> bool`, mirroring `services/amazon_import.sniff_kind` (a marker-subset
test over cleaned/lowercased headers). Frontend mirror `sniffPaypalActivity(headerLine)` in
`lib/` for preview-time routing, mirroring `lib/amazonDetect.js` — but **the backend sniff is
authoritative** for capture and seeding, since those happen server-side.

- **Marker set — confirmed against the user's files** (`data/paypal/`, 2019→2026, all identical). The
  header is `Date, Time, TimeZone, Name, Type, Status, Currency, Amount, Fees, Total, Exchange Rate,
  Receipt ID, Balance, Transaction ID, Item Title`. Use a distinctive, stable subset as markers, e.g.
  **`{timezone, type, status, currency, receipt id, transaction id}`** — no bank/card/Amazon CSV carries
  that combination. Strip the leading UTF-8 **BOM** on the first header (the AZAD sniff already does this —
  reuse `_clean_key`). All ten files share this one header, so it's solid for them; if PayPal's other
  export formats ever appear, they'd need their own marker check (flag, don't assume).
- **Uses:** (1) force field capture (B); (2) seed money-movement rules on first recognized PayPal import
  (C); (3) optionally stamp the batch `source_kind = 'source:paypal'` (the generic `import_batch` column
  already used for `marketplace:amazon`) so history can group/label PayPal imports. (3) is optional
  polish, not required by the fix.

## Part B — Force-capture `Type` + `Item Title` for recognized PayPal files

In `_build_evidence_column_plan` (or its caller in `run_import_core`, where `headers` are in scope):
when `sniff_paypal(headers)` is true, **union** `Type` and `Item Title` (matched case-insensitively on
header) into the capture plan with their inferred roles (`Type` → categorical, `Item Title` →
descriptive), **regardless of `col.evidence_columns`**. Only these two are forced; the user's other
capture choices are untouched. Keep it a small, testable helper:
`_forced_evidence_headers(headers) -> set[str]` returning the PayPal-forced headers (empty for non-PayPal).

- **Non-PayPal files are unaffected** — the forced set is empty, so the existing plan logic (explicit
  list or keyword auto-detect) is unchanged.
- **UI transparency (decision below):** show `Type`/`Item Title` in the capture panel as *always
  captured for PayPal* (checked + disabled, with a short note) so the user understands why they can't
  uncheck, rather than silently overriding.

## Part C — Money-movement as user-*approved* rules on `Type` (not auto-seeded)

Categorization is expressed as **`match_source_text` rules** keyed on the money-movement `Type` value,
targeting the excluded **"Money movement"** category
(`services/money_movement.find_or_create_money_movement_category`). This is a *different rule shape* from
`DEFAULT_RULE_SEEDS` (merchant-name rules): these set `match_source_text = True` so they match the
captured `Type` in `import_evidence_json`, not the merchant name.

**Decision (user, 2026-07-20): the rules are *proposed*, never auto-created — the user must approve.**
"Things tend to be better if the user is involved." The open question was *how to surface the need*; the
answer is the app's existing **"algorithm proposes, user disposes"** idiom, applied to `Type`:

- After a **recognized PayPal import**, present a small **money-movement review** listing the `Type`
  values seen and their counts, each with a proposed target of **Money movement** — pre-checked for the
  recognized money-movement types, shown but unchecked for anything else. The user reviews and **Adds
  selected rules** (or dismisses). Creating a rule is the user's click, not the importer's.
- This is *also* the answer to unknown/renamed types (the old "Part D"): a `Type` the code doesn't
  recognize simply appears in the **same review, unchecked**, for the user to route once. So the
  vocabulary **grows from the user's data** with no frozen list doing the deciding — the code's known-set
  only pre-checks the obvious ones; the user owns the rest. Staleness dissolves: a renamed type shows up
  as a new unchecked line, not a silent misclassification.

**The recognized money-movement types (curated from all of `data/paypal/`, for the pre-check default):**
`Bank Deposit to PP Account`, `General Card Deposit`, `General Withdrawal`, `User Initiated Withdrawal`,
`General Card Withdrawal`, `General Currency Conversion`, `Account Hold for Open Authorization`,
`Reversal of General Account Hold`. Everything else observed is a real payment/refund
(`* Payment`, `Payment Refund`) and stays **unchecked**. Note the clean lexical split — money-movement
types all carry **Deposit / Withdrawal / Currency Conversion / Hold**, payments carry **Payment** — so
the pre-check can key on those *fragments* (more stale-resistant than exact strings: a future
`eCheck Deposit` still pre-checks), while the created rule can use the exact `Type` value the user
approved. (`Mass Pay Reversal` reverses a real payment — treat as income/refund, left unchecked.)

Because these are ordinary rules once approved, they **categorize at import** (so the rows don't count)
*and* apply **retroactively** via `recategorize_all` — which fixes the already-imported 2019 holds
(answers "move the existing ones": yes, approve the rules + recategorize).

**No false duplicates:** `Type` is a categorical evidence field; the duplicate text-matcher already skips
categorical-role fields (`_collect_duplicate_match_texts`), so rules matching on `Type` can't spuriously
pair unrelated rows. (See the role-tagging in `paypal-amazon-enrichment.md`.)

**Where the review surface comes from — two options (decision open):**

1. **A dedicated post-PayPal-import money-movement review** (recommended first cut): contained,
   PayPal-specific, low-risk, keyed on the captured `Type`. Reuses the import result screen + the shared
   review/undo patterns.
2. **Extend the generic rule-suggestion engine to cluster by `Type`** for recognized sources: today
   `_generate_rule_suggestions` clusters candidates by *merchant name* only, so money-movement rows (whose
   names vary or are nameless/"PayPal") never cluster. Teaching it to also cluster by a captured
   categorical field (`Type`) would fold money-movement into the normal rule-suggestion review — more
   general, more work, and the eventual home. Start with (1); grow into (2).

## Relationship to the existing structural suppression

`services/money_movement.py` already suppresses the **paired funding legs** (a same-day *nameless* credit
and its equal-and-opposite *named* debit) structurally. That stays. This Type-rule approach covers the rest
of the money-movement vocabulary that *isn't* a clean same-day pair (standalone holds/reversals across
days, lone deposits/withdrawals/conversions). They're complementary — **suppression for the structural
pairs, rules for the `Type`-identified singletons** — and both route to the same excluded "Money
movement" category.

- **Precedence to define:** a funding-leg deposit could be both a suppression pair member *and* match a
  money-movement rule. Suppression runs post-insert (links + recategorizes the leg); rule categorization
  runs during `apply_categorization`. Both target "Money movement", so the destination agrees; spec the
  order so the leg isn't double-handled (suppression's link/category is authoritative; a rule hit on an
  already-excluded/linked leg is a no-op).

## Part E — Stamp the batch `source_kind = 'source:paypal'`

**Decision (user, 2026-07-20): yes.** When `sniff_paypal` recognizes the file, stamp the CSV batch's
`source_kind = 'source:paypal'` (the generic `import_batch` column already carrying `marketplace:amazon`),
so import history can group/label PayPal imports distinctly. Small, and it gives the money-movement review
(Part C) and any future PayPal-specific surfaces a durable "this batch is PayPal" signal to key on rather
than re-sniffing.

## Build order

1. `sniff_paypal` (backend) + `sniffPaypalActivity` (frontend) — small, header-only, testable — and
   stamp `source_kind = 'source:paypal'` (Part E).
2. Force-capture `Type` + `Item Title` for recognized files (`_forced_evidence_headers`), surfaced in the
   capture panel as checked-and-disabled with a note (decision below).
3. The money-movement **review**: after a recognized PayPal import, propose `Type` → Money movement rules
   (pre-checked for the known set), user approves; approved rules apply at import and via `recategorize_all`
   for existing rows. **No auto-seeding.**

(The old "phase 2 adaptive suggestions" folds into step 3 — unknown types just appear unchecked in the
same review — so there is no separate phase. Growing the *generic* suggestion engine to cluster by `Type`,
Part C option 2, is the only deferred piece.)

## Tests

- `sniff_paypal`: recognizes the header; rejects bank/card/Amazon headers; strips the BOM.
- Force-capture: `Type`/`Item Title` captured even when `evidence_columns` omits them; a non-PayPal file
  is unchanged; other capture choices preserved.
- Money-movement rules: once approved, hold/reversal/deposit/withdrawal/currency rows land in the excluded
  category; real payments (`Express Checkout`, `Website`, `Mobile`, `General Payment`, refunds) are
  untouched.
- Retroactive `recategorize_all` moves already-imported holds to Money movement.
- Precedence: a suppressed funding leg isn't disturbed by a money-movement rule.

## Reuse map (don't reinvent)

- File recognition → `amazon_import.sniff_kind` / `lib/amazonDetect.js` pattern.
- Evidence capture → `_build_evidence_column_plan` (+ role classifier); force via a small union helper.
- Rule seeding → `seed_default_rules` / `POST /categories/generate-starter` (idempotent).
- Excluded category → `money_movement.find_or_create_money_movement_category` ("Money movement" under
  the seeded `Transfers` group).
- Adaptive surfacing → existing `rule_suggestion_review`.
- Retroactive apply → `recategorize_all`.

## Decisions (settled 2026-07-20)

1. **Header marker set** — ✅ confirmed against `data/paypal/` (all ten files identical). Markers +
   BOM-strip in Part A.
2. **Rule creation** — ✅ **user-approved, never auto-seeded** (Part C). Surfaced via a post-import
   money-movement review ("algorithm proposes, user disposes"); unknown types appear unchecked in the same
   review, which is also the staleness answer.
3. **Force-capture UI** — ✅ **surface it**: `Type`/`Item Title` shown checked-and-disabled with a
   "always captured for PayPal" note.
4. **Adaptive suggestions** — ✅ folded into the Part C review (no separate phase). Growing the *generic*
   suggestion engine to cluster by `Type` (Part C option 2) is deferred.
5. **`source_kind = 'source:paypal'`** — ✅ **yes** (Part E).

## Remaining open question

- **Review surface home (Part C):** a dedicated post-PayPal-import money-movement review (recommended
  first cut) vs extending the generic rule-suggestion engine to cluster by `Type`. Start dedicated, grow
  generic.
