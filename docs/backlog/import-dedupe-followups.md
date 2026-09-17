# Import / duplicate-detection follow-ups

**Status: deferred, not started (migrated from `TODO.md` 2026-07-30).** Two convenience
enhancements to the dedupe subsystem — neither is a safety gap (data loss is already
prevented by soft-delete + per-row restore).

## Auto-restore deduped rows when a contributing import is undone

**Context.** Exact-match (hard-reject) duplicates are dropped at import
time, never inserted into `txn`; only their payload is kept in
`import_batch_duplicate`. So if file B has rows that were skipped because
they matched file A, then undoing file A leaves those B rows absent even
though re-importing B fresh would now create them (A's rows are gone, so
they would no longer be duplicates). Today the only recovery is the manual
"Import duplicates" action on file B (`POST
/import-export/batches/{id}/duplicates/import`) or re-importing B. The idea
here is to automate it: when an import is undone, survey subsequent batches'
`import_batch_duplicate` records and re-materialize the rows whose only
reason for rejection was the batch being undone.

**Why deferred.** Unclear how often it actually matters, and it is not
trivial to do correctly. Rejections form a chain: files A, B, C may each
contain overlapping slices of earlier ones. A row in C that was dropped
because of A might *still* be a duplicate after A is undone — now because of
B. So "restore everything C deduped against A" is wrong; each candidate has
to be re-evaluated against the *current* ledger state (re-run through
`evaluate_duplicate`), not just blindly re-inserted because its original
matched-row disappeared. There is also an ordering question (process
candidates oldest-first so a restored B row can legitimately re-suppress a C
row) and a UX question (auto-restore silently vs. surface "N rows can be
restored" for confirmation).

**Suggested approach when picked up.**

- In `undo_batch`, after deleting the batch's rows, collect every *other*
  batch's `import_batch_duplicate` payloads and re-run each through
  `evaluate_duplicate` against the post-undo ledger.
- Re-insert only those that now pass (no longer hard-reject); leave the rest
  as duplicate records. Process oldest batch first so re-inserted rows can
  re-suppress later candidates within the same pass.
- Decide auto vs. confirm: likely surface a count ("Undoing this import lets
  N previously-skipped rows from later imports be restored — review?") rather
  than silently mutating other batches.
- Watch the interaction with soft-flags: a re-materialized row should also go
  through `mark_import_suspects`/the cross-account sweep, the same as the
  manual "Import duplicates" path already does.

## Duplicate-resolution history (review what you did, and undo it)

> **Partly supplied since this was written (2026-09-01).** `suspect_pair_distinct` now records each Keep as
> a durable, per-pair judgement naming both rows — so the "what did I decide" half has a real source of
> truth for the Keep case, where previously only `suspect_resolved_at` survived and it named no pair. The
> undo half exists as an endpoint (`DELETE /accounts/duplicate-pairs/{a}/{b}`) with no surface yet. What
> remains for this item is the chronological *view* across all five outcomes and the batch undo; the
> Keep row of that table is now readable rather than lost.


**Context.** There is no chronological, reviewable record of the dedupe
decisions a user made (Keep / Discard / Replace / Import-anyway / Restore).
The *raw material* is already persisted, though: every action soft-deletes
(`trashed_at` + `rejection_reason`, even Replace), and each row records how/when
it was resolved (`suspect_resolved_at`, `dedupe_resolved_by`). So no decision is
lossy and recovery is already possible per-row from the duplicate report — what's
missing is a *view* of the decisions over time and a one-click *batch* undo.

**Why deferred (and split).** This is convenience/transparency, not safety —
data loss is already prevented by the soft-delete + per-row Restore/Import-anyway.
So it doesn't clear the "no complexity without a clear payoff" bar yet. Do it in
two steps:

- **v1 — flat history view (nearly free; worth doing later).** Read-only list of
  resolved rows derived from the existing fields — query by `suspect_resolved_at`,
  group by (batch, action, time-window), show action + affected rows. **No new
  table**, and per-row undo already exists (the report's Restore/Import-anyway).
  Delivers most of the transparency value.
- **v2 — action log + grouped/tree view + one-click batch-undo (heavier; only if
  v1 proves used).** A real `dedupe_action` log written at resolve-time
  (action, timestamp, batch, affected txn ids), a tree view (action → affected
  nodes), and undo of a whole action/group.

**Design notes when picked up.**

- Grouping is nearly free at log-time: the review dialog already applies bulk
  selections *as* bulk ("Keep both (N)…"), so a log row written then captures the
  grouping. Only the uncommon one-at-a-time path needs a time-window fallback —
  don't build a fragile post-hoc "these N individual actions were really a bulk"
  heuristic.
- Undo reuses existing inverses (`restore_rejected_duplicate`, remove the
  `account_pair_distinct` pair + re-flag, un-trash the replaced row) — it's
  replaying a soft-delete inverse, not new recovery logic.

## Bank-side transaction-type prefixes — re-measured; still deferred, for a different reason

**Status update.** The precondition below ("revisit once a second provider feeds the same account") has
since been met, the re-measurement was done, and the item stays deferred — but the earlier reasoning no
longer describes why. The second provider does word those charges differently, and the resulting pair was
a genuine duplicate that reached the ledger. Stripping the leading token still would not have bridged it:
with `WDRL-ACH` removed, the two descriptors reduce to `<payee> / ins / debitpmt` against
`<payee> / insurance / debitpmt`, which is a 2-of-3 token overlap — the token that fails is `ins` against
`insurance`, blocked by the 4-character floor in `_duplicate_tokens_match`, not by the prefix. So the
prefix was never the obstacle in this case.

What closed the case instead was not a text change at all: the pair was reaching the text rules only
because a connection's trailing coverage window had no candidate slots (see `data-model.md`), and the
terminal-day rule now reconciles it on amount alone. The residual text-level need — surfacing a
differently-worded pair the coverage rules genuinely miss — is served by the `cross_account_weak` shared-
token tier rather than by normalizing prefixes away. **If this is picked up again, the question to ask is
about the 4-character prefix floor, not the leading token.**

---

## A coverage reject can be *justified* by a coincidence, not by the twin

**Status: deferred by scope decision (2026-09-01), not a defect.** Raised while fixing the report
half of this, which shipped; this is the half deliberately left out.

**Context.** A row inside a covered date range is hard-rejected by the coverage rule alone — it does
not need to find a match. The one exception is the named-payment escape hatch: a named row with **no**
same-account candidate consults the wider ledger, and imports when nothing corroborates it. That gate
reads the *unfiltered* candidate list, so an unrelated same-amount charge a few days away is enough to
count as a candidate and keep the escape hatch shut, even though the text tiering then discards it as
the coincidence it is.

Observed case: a row whose real twin sat on a sibling account under the same merged group, with a
coincidental same-amount charge five days out on the receiving account. The rejection was **correct** —
the row was a genuine duplicate — but the thing that produced it was the coincidence, not the twin.

**What shipped instead.** The *report* now names the twin: when the text tiering empties the displayed
list, the ledger payment probe runs a second time for display only, on both the import path
(`_coverage_reject_verdict`) and the read path (`refresh_unexplained_coverage_candidates`). That
removes the visible symptom — "covered, no specific match" over a row whose twin was one account-hop
away — and changes no verdict.

**Why the rest is deferred.** Making the *decision* rest on the twin rather than on whichever row
happened to fill the slot means changing what the escape hatch reads, and that flips rows between
rejected and imported. The scope of the reported issue was the report, not the ladder. Any future
attempt needs to answer what a named row with only a coincidental candidate should do — the honest
answer is probably "ask the ledger first, then decide", i.e. run the probe *before* the candidate test
rather than after it — and to size how many rows change verdict before touching it.

## Original entry: revisit once a second provider feeds the same account

**Context.** The cross-account text comparison drops a leading payment-processor tag (`<tag> *MERCHANT`)
before matching, because sources disagree about passing that tag through — see `data-model.md` for why
that disagreement is what makes it worth normalizing. A bank's own leading transaction-type token (a
withdrawal/ATM marker such as `WDRL`, `WDRL-ACH`, `WDRLATM`) looks like the same shape and is a natural
next candidate. It is deliberately not stripped.

**Why deferred.** Measured over a real ledger it bought nothing. Stripping the leading token changed no
pair's classification — not one new exact match, not even a new near-miss — and the generalized version
(dropping leading `GENERIC_DUPLICATE_TEXT_TOKENS`: `ach`, `atm`, `card`, `debit`, `payment`, `transfer`,
`withdrawal`, …) also recovered nothing while moving several more pairs into review. The asymmetry is
real — a sizeable minority of same-amount, in-window cross-account candidate pairs carried the prefix on
one side only — but in each of them the *rest* of the descriptor was what differed, so removing the
prefix bridged nothing. The prefix is applied by the institution rather than by the charge's originator,
so it rides along consistently with whatever that institution feeds.

**Why it may change.** The measurement describes one ledger fed by one connection provider. A second
provider syncing the same account may spell those charges differently, and the prefix could then sit
between two records of one charge the way a processor tag does. Two observations make that likely enough
to be worth re-checking:

- Rows arriving by sync are far barer than the docs imply: on the ledger measured, of 346 connection
  rows only 30 carried `import_evidence_json` and only 3 carried a second date (then `authorized_date`, now `posted_date`) — though
  `architecture.md` describes sync writing evidence in the same shape a CSV import writes, and
  `data-model.md` treats that second date as the real fix for the date-window tail. Whether that is
  provider-specific or a capture gap is itself worth settling.
- More captured text per row changes the input to every text tier, so the earlier null result does not
  carry over to a differently-shaped feed.

**How to re-measure (cheap, read-only).** Against a real ledger: collect each non-trashed row's
`source_match_texts`, group by rounded amount, pair rows on different accounts within
`CROSS_ACCOUNT_DATE_WINDOW_DAYS`, and tally `classify_text_match` for each pair — first as shipped, then
with a leading-token strip added as an *extra* comparison form (never in place; see the processor-tag
note in `data-model.md` for why in-place strips pull the bare-tag spelling apart). The number that
decides it is transitions into the exact tier, not the count of rows carrying the prefix. Compare only
figures from a single run: a live ledger changes between runs.
