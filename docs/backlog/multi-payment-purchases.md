# Multi-payment purchases

**Status: built 2026-08-24.** Grouping several transactions that are one purchase — a deposit and a
final payment, a three-instalment plan. The field semantics and invariants live in
[`../data-model.md`](../data-model.md) → *Multi-payment purchases*; the shared UI behavior in
[`../ui-patterns.md`](../ui-patterns.md). This file holds the depth: why the shape is what it is, what
was deliberately left out, and what a later phase would add.

## Where it came from

Two transactions turned up that were each half of one purchase — the first a deposit, the second the
final payment — and the only reason it was noticed at all was an invoice that itemized both. Nothing in
the ledger could say they belonged together. That is the whole problem: not a wrong number, a missing
relationship.

## Why the link primitive, unchanged

`txn_link` was written as a general association primitive and
[`../data-model.md`](../data-model.md) already named further clients as intended. This is one, and it
needed **no schema change at all** — the table carries a `kind`, a per-member `role`, an
`external_ref` and a metadata blob, and already rides in backups.

More importantly it is the *cheapest possible* client. The two existing ones (Amazon order
itemization, wallet funding-leg suppression) exist to stop the same money counting twice, so each one
mutates a transaction — recategorizing a leg into an excluded bucket — and has to stash the prior in
`metadata_json` to reverse it. A multi-payment purchase mutates nothing: both payments are genuinely
spent money on genuinely different dates. The link is pure association, which is what the primitive
already is by default. That is what makes the feature incapable of breaking a total.

## The three neighbours it is not

Each of these was considered and is a different axis. Naming them here so the next person does not
re-derive the comparison, or reach for the wrong one:

| | axis | why it does not fit |
| --- | --- | --- |
| **Splits** ([`transaction-splits.md`](transaction-splits.md)) | one transaction → N categories | Divides *one* payment across categories. This is the inverse: N payments → one purchase. They compose fine — a deposit can itself be split. |
| **Recurring series** ([`recurring-detection.md`](recurring-detection.md)) | an open-ended cadence | Carries `next_due_date`, an amount band, a lifecycle. A purchase is finite with a known total; detection would try to project a cadence that does not exist. Explicitly out of scope from the start: mortgages and monthly auto-payments are recurring series, not purchases. |
| **Reimbursable expenses** ([`reimbursable-expenses.md`](reimbursable-expenses.md)) | an offset crossing a period boundary | That design chose a holding *category* over pairing because the numbers were wrong and needed fixing, which made pairing optional and late. Here the numbers are already right, so the reverse choice applies: the link is the whole feature and no category machinery is warranted. |

## Decisions worth not re-litigating

- **Reporting is untouched, deliberately.** No summary, trend or drill knows about purchases. A
  grouped payment reports exactly as it did before. Anything that would make a purchase change a
  total is a different feature with a much larger blast radius, and the case for it has not been made.
- **A payment belongs to one purchase.** The constraint has a reason beyond convenience: a payment
  covering two invoices would count whole into both totals. The refusal points at splits, which is the
  honest mechanism for dividing one payment.
- **No cap on how many payments a purchase may have.** A twelve-instalment financing plan is a real
  thing, and a limit would be a constraint on what the user may record with nothing behind it. The
  bound that matters is on the *action*: the ledger's bulk link is ids-only (never "all matching") and
  the dialog lists every payment before saving, so an absurd selection is visible rather than
  prevented.
- **`unaccounted`, not "remaining" or "owed".** The gap may be a payment not made yet or one made and
  not linked. Nothing in the ledger distinguishes them, so the label does not claim to.
- **One member role.** The dates already say which payment is the deposit. A `deposit`/`final` role
  would be a second encoding of the same fact, free to drift from it.
- **The detail panel's section renders nothing when there is no purchase.** An always-present empty
  section would sit on every transaction in the ledger to advertise a feature that applies to a
  handful. Discoverability comes from the bulk action — which lives where someone actually notices two
  rows belong together — and from the row marker.

- **The row marker opens the editor; it is not inert.** It was built inert first, on the reasoning
  that the row's pencil already reached an editor in the detail panel, and that was wrong for the
  third time in this repo's history — the paperclip left as a counter and the `doc:` search prefix
  made mandatory are the other two, both reversed on first real use. The pattern is worth naming
  because the argument reads as restraint every time: *a marker that stands for something openable and
  does nothing reads as broken, and "another route exists" is not a reason to withhold the direct
  one.* **Don't re-impose it.** The practical payoff is the case that prompted it: a payment linked by
  accident is repaired from the ledger, where the mistake is visible, rather than only from a panel
  two clicks away.

- **One editor, two ways in — so it is a dialog.** `PurchaseEditorDialog` is opened by both the row
  marker and the panel's summary, which is the shape the split editor already uses. The alternatives
  were a row *popover* (the note/tag markers' shape) — rejected because this content is a three-field
  form plus a payments list plus two confirms, and nesting confirms inside an anchored popover is
  where it comes apart — and opening the whole detail panel from the marker, which spends a trend
  chart and a payee report on a small repair. It portals to the body because one host is a table row;
  see `DocumentViewerDialog` for the symptom that rule exists to prevent.

## Not built (and why)

- **Suggestion.** Nothing proposes a purchase; grouping is entirely manual. The plausible automatic
  signals — same payee, two-to-four payments within a few months, amounts summing to a round figure —
  are weak on their own, and the repo's own precedent for this shape (`matched_review`, the Amazon
  split suggestion) is *advisory only, never guessed at*. The genuinely strong signal is the invoice,
  and `document.text` + FTS5 already exist to search one; what is missing is tier-2 extraction, so a
  photographed invoice yields nothing to match on. **Revisit when OCR lands**
  ([`transaction-attachments.md`](transaction-attachments.md) → tier 2), not before.
- **A document attached to the purchase rather than to one payment.** The invoice that revealed the
  problem covers both payments and can currently hang off only one of them, arbitrarily. `document`
  keys on `txn_id`; letting it key on a link as well is a real change to that table's contract and was
  not worth taking on inside this one.
- **A Tasks entry for an unaccounted purchase.** It is exactly the "needs attention" shape, but a
  purchase legitimately part-paid for months would nag the whole time — the same objection
  [`reimbursable-expenses.md`](reimbursable-expenses.md) records against nagging an open receivable.
  If it is ever added it should be age-gated.
- **A purchases list page.** There is no surface listing every purchase; they are reached from their
  payments. One would be worth building only once there are enough of them to browse, which is a
  question about use rather than design.
- **A Help topic.** Owed, like attachments phase 1's. It should be written in the user's own voice per
  the existing topics in `help/content.jsx`.

## Cross-refs

- [`../data-model.md`](../data-model.md) — `txn_link` as a general primitive; the invariants and the
  prune trigger
- [`../ui-patterns.md`](../ui-patterns.md) — the row marker, the panel section, the bulk action
- [`transaction-splits.md`](transaction-splits.md) — the other axis, and the mechanism the
  one-purchase-per-payment refusal points at
- [`reimbursable-expenses.md`](reimbursable-expenses.md) — the neighbouring timing problem that chose
  the opposite shape
