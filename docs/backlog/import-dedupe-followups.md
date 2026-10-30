# Import and duplicate-detection follow-ups

Convenience and precision items for the dedupe subsystem. None is a safety gap: every resolution
soft-deletes, and per-row restore prevents data loss.

## Duplicate-resolution history and batch undo

There is no chronological record of the dedupe decisions a user made across all five outcomes (Keep /
Discard / Replace / Import-anyway / Restore), and no one-click undo of a whole bulk action. The raw
material is stored: every action soft-deletes (`trashed_at` + `rejection_reason`, Replace included),
each row records when and how it was resolved (`suspect_resolved_at`, `dedupe_resolved_by`), and Keep
judgements are durable pairs in `suspect_pair_distinct`, already listed with an undo in Settings
(`DuplicateExceptionSections.jsx`). What is missing is the view over everything else and batch undo.

Two steps, the second only if the first gets used:

- **v1: a flat history view.** A read-only list of resolved rows from the existing fields: query by
  `suspect_resolved_at`, group by batch, action and time window, show the action and the rows. No new
  table; per-row undo already exists in the duplicate report.
- **v2: an action log, a grouped view and batch undo.** A `dedupe_action` log written at resolve time
  (action, timestamp, batch, affected ids), a tree view (action → rows), and undo of a whole action.

Design notes:

- Grouping comes almost free at log time: the review dialog already applies bulk selections as one bulk
  action ("Keep both (N)…"), so a log row written then captures the group. Only the one-at-a-time path
  needs a time-window fallback. Do not build a post-hoc heuristic that guesses which individual actions
  were really one bulk.
- Undo reuses the existing inverses (`restore_rejected_duplicate`, reopening a `suspect_pair_distinct`
  pair, un-trashing the replaced row). It replays a soft-delete inverse, not new recovery logic.

## A coverage reject can rest on a coincidence instead of the twin

A row inside a covered date range is hard-rejected by the coverage rule alone. The exception is a named
row with **no** same-account candidate: it consults the wider ledger and imports when nothing there
corroborates it. That gate reads the *unfiltered* candidate list, so an unrelated same-amount charge a few
days away counts as a candidate and keeps the exception shut, even though the text tiering then discards
it as a coincidence. The report already names the real twin (see `_coverage_reject_verdict` in
`services/duplicate_detection.py`); the verdict still rests on the coincidence.

Making the verdict rest on the twin changes what the exception reads, which flips rows between rejected
and imported. Before touching it:

- decide what a named row with only a coincidental candidate should do. The likely answer is to ask the
  ledger first and then decide, running the probe *before* the candidate test rather than after;
- measure how many rows change verdict.

## Bank-side transaction-type prefixes stay unstripped

The cross-account text comparison drops a leading payment-processor tag (`<tag> *MERCHANT`); the
comment above `_PROCESSOR_TAG_RE` in `services/duplicate_detection.py` says why. A bank's own leading type token (`WDRL`, `WDRL-ACH`, `WDRLATM`) looks like the
same shape but is deliberately not stripped:

- Measured over a real ledger, stripping it changed no pair's classification. The generalized version
  (dropping leading `GENERIC_DUPLICATE_TEXT_TOKENS`: `ach`, `atm`, `card`, `debit`, …) recovered nothing
  and moved several more pairs into review. Where the prefix appeared on one side only, the rest of the
  descriptor was what differed.
- A second provider feeding the same account was checked too. The one duplicate that reached the ledger
  would not have been bridged by a strip: without the prefix the descriptors still differ on `ins`
  against `insurance`, which the 4-character floor in `_duplicate_tokens_match` blocks. That case is now
  caught by the coverage rules and the `cross_account_weak` tier.

**If this comes up again, the question is the 4-character token floor, not the leading token.**

To re-measure (cheap, read-only): against a copy of a real ledger, collect each non-trashed row's
`source_match_texts`, group by rounded amount, pair rows on different accounts within
`CROSS_ACCOUNT_DATE_WINDOW_DAYS`, and tally `classify_text_match` for each pair, first as shipped and then
with the candidate strip added as an *extra* comparison form, never in place, as the processor-tag strip
is (`_processor_tag_stripped`). What decides it is pairs moving into the exact tier. Compare figures from one run
only, since a live ledger changes between runs.

## Is sync capturing less than the docs imply?

On the ledger measured, few connection rows carried `import_evidence_json` or a second date
(`posted_date`), although `architecture.md` describes sync writing evidence in the same shape as a CSV
import and `data-model.md` treats the second date as the fix for the date-window tail. Whether that is
provider-specific or a capture gap is unsettled. More captured text per row changes the input to every
text tier, so the null results above may not hold for a richer feed.
