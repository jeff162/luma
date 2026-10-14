# Mechanism index

**Consult this before recording a relationship between transactions, or before building anything that
groups, divides, offsets or hides money.** Several mechanisms in this ledger look alike from a distance
and are not interchangeable; picking the wrong one does not fail loudly, it puts wrong data in the
ledger and reports it confidently.

This is the domain-model counterpart to [`shared-components.md`](shared-components.md) — a fast "which
mechanism is this?" lookup. The *why*, the invariants and the schema live in
[`data-model.md`](data-model.md); this does not replace them.

**What earns a row: has this pair actually been confused, or could it plausibly be, in a way that puts
wrong data in the ledger?** That test is deliberately narrow. *Splits versus multi-payment purchases*
passes — they are inverse axes and both group money. *Tags versus splits* does not: a tag is
cross-cutting metadata and never divides an amount, so nobody reaches for one expecting the other's
effect. Do not add a row because two things are merely adjacent.

## The mechanisms

| Mechanism | The axis | Reach for it when | Where |
| --- | --- | --- | --- |
| **Transaction split** | one payment → **N categories** | One real movement of money bought things belonging in different buckets. The amount must be divided. | `data-model.md` → *Transaction splits*; `services/txn_splits.py` |
| **Multi-payment purchase** | **N payments** → one purchase | Several real movements of money — a deposit and a balance, an instalment plan — together bought one thing. Each is already recorded correctly; only the *relationship* is missing. | `data-model.md` → *Multi-payment purchases*; `services/purchase_links.py` |
| **Recurring series** | an **open-ended cadence** | The payments repeat on a schedule with no known end and no total — a subscription, a bill, a mortgage. Carries a next-due date, an amount band and a lifecycle. | `data-model.md` → *Recurring series* |
| **Reimbursable expense** | an **offset crossing a period boundary** | Money went out and is expected back, and the two sides may land in different reporting periods — which is what makes the untreated numbers *wrong* rather than merely unrelated. | `data-model.md` → *Reimbursable expenses* |
| **PayPal funding pair** | **one movement, two accounts** — PayPal and the card or bank on the other side | A tracked PayPal account's row and the "PAYPAL…" row the same money left on a card or bank. Made automatically after imports and syncs; decides which side counts. Not a duplicate (two different accounts really did move money) and not a split. | `data-model.md` → *PayPal funding pairs*; `services/paypal_funding.py` |
| **Refund pair** | **money back → the payment it returns** | A source states which payment a refund returns (a PayPal statement's `Ref ID`). Made automatically after imports; the refund takes and follows the payment's category so the two net inside it. | `data-model.md` → *Refunds*; `services/refund_links.py` |
| **`txn_link`** | the general **association primitive** | You need to say "these transactions belong together" under some new `kind`. Purchases, reimbursements, marketplace order itemization, wallet funding-leg suppression, PayPal funding pairs and refund pairs are its clients. | `data-model.md` → *Transaction links and Amazon order import* |
| **`exclude_from_totals`** | **money movement, not activity** | The money did not enter or leave the household — a transfer between own accounts, a credit-card payment. Set on the category (or its group), never per transaction. | `data-model.md` → *Categories*, *Reporting assumptions* |

## The pairs that actually get confused

**Splits vs. multi-payment purchases — inverse axes, and they compose.** A split divides *one* payment
across categories; a purchase groups *N* payments into one thing. They are not alternatives and a
deposit can itself be split. If the amount needs dividing, it is a split; if the transactions need
associating, it is a purchase.

**Recurring series vs. multi-payment purchase — a cadence is not an instalment plan.** A purchase is
**finite with a known total**; a series is open-ended and carries a next-due date, an amount band and a
lifecycle. **A mortgage and a monthly auto-payment are recurring series, not purchases** — this was
explicitly out of scope for purchases from the start, because detection would try to project a cadence
that does not exist.

**Reimbursable vs. multi-payment purchase — opposite problems, hence opposite designs.** With a
reimbursement the numbers are *wrong* across a period boundary, so a holding category is what fixes
them and the pairing is optional and late. With a purchase the numbers are already right and only the
relationship is missing, so the link is the whole feature. **No category machinery belongs on a
purchase** — do not add one by analogy with reimbursements.

**Refund pair vs. multi-payment purchase vs. reimbursable — three ways money comes back.** A refund pair
is money *returned* on a payment the source names: the refund belongs in the payment's category, so the
pair moves it there and keeps it there. A purchase may also hold a refund as a member, but only as
association — it changes no category, and it is the hand-made grouping for when no source said so. A
reimbursable is money *owed* back by someone else across a period boundary, and is fixed by a holding
category, not by pairing. Reach for the refund pair only where a source states the reference; nothing
infers one from amounts.

**A `txn_link` is pure association by default, and several of its clients are not.** Creating or
deleting a link never mutates the transactions it links — no category change, no exclusion, no amount
change. That is what makes grouping a purchase incapable of breaking a total that was already right.
But marketplace itemization, wallet funding-leg suppression and PayPal funding pairs exist to stop the
*same* money counting twice, and a refund pair to make money back net against its payment, so each
**recategorizes a row and must stash the prior in `metadata_json` to reverse it**. A new client must
decide which of those two shapes it is, and say so.

**A split is feature-owned; a rule may never author one.** A split transaction's categorization *is*
its set of parts, so `split` is the one category source no rule apply may take. Rules set one category;
splitting stays a manual act.

## Deliberately not rows here

- **Tags vs. splits** — a tag is cross-cutting metadata and does not divide an amount, so tagging an
  order cannot move money into a category total. Nobody reaches for one expecting the other.
- **Trash vs. exclusion** — soft-delete and "money movement" are not confusable; one removes a row from
  the ledger, the other classifies it.
- **A recurring movement's two legs vs. `txn_link`** — a transfer series owns both rows of every
  movement it claims, but no *link* is recorded between them: the pairing is re-derived from the pool on
  each scan, exactly as membership is (`services/transfer_pairs.py`). Reaching for a `txn_link` kind to
  "record that these two are one transfer" would store what the rows already say — same amount, opposite
  directions, days apart — and would then need maintaining as they change.

---

## Obstacles

- **`unaccounted` cannot tell you which kind of gap it is.** It is `expected_total − linked_total`, and
  the gap may be a payment not yet made or one made and not linked — nothing in the ledger
  distinguishes them. That is why it is not called "remaining" or "owed", and why NULL (no expected
  total stated) is a real answer distinct from zero.
- **No SQLite constraint reaches across the two tables** that express these relationships, so every
  invariant here is enforced in a service on save. A new write path that bypasses the service bypasses
  the invariants with it.
- **Split pre-fill has refusal edges that must not be guessed around.** An item with no list price is
  excluded from the proportional weighting and lands as a **zero part for the user to fill**, rather
  than being dropped or estimated; pre-fill is refused outright when net cash is zero (a fully
  gift-carded or points order) or when the list prices sum to zero.
- **Expansion is opt-in per query.** Summaries and trends always expand a split into its parts because
  rollup is their job; a list may not. A new aggregation gets the behavior by selecting from the
  effective-rows seam and **silently loses it** by selecting from `txn` directly.

## Open

- **Attachment tier 2 (extraction)** is the named precondition for automatic purchase suggestion above.
  → [`backlog/transaction-attachments.md`](backlog/transaction-attachments.md)
