# Miscellaneous follow-ups

**Status: running catch-all (started 2026-07-30).** A home for genuine one-offs too small to
warrant their own backlog file. When an entry here grows into a real initiative, promote it to
its own file; when it ships, delete the entry.

## Whether the ledger's attribute quick filter should outlive the session

**Context.** The Transactions toolbar's attribute filter (`?only=` / `AttributeFilterControl`) keeps its
choice in the page's session state, alongside the search box and the amount filter — so it survives
navigation and resets on reload or relaunch. It was put there to match those two siblings rather than
because the question was settled.

**The question.** Should it instead be a durable `ui_preference`, remembered across launches? The user
assumed on first sight that it already was, which is evidence for durable; the argument against is that
opening the app to a silently filtered ledger, with no memory of having set it, is the failure mode the
session-scoped choice avoids for its siblings. Answering it for this control probably answers it for the
search box and the amount filter too, which is why it is worth deciding once rather than per control.

**Not blocking anything.** The current behavior is coherent; this is a preference decision, not a defect.

## CHANGELOG entry for tag-as-owner replacement

**Context.** The four-phase work that removed `owner_id` from `category`
and replaced category/group ownership with the tag inheritance model is
user-visible (the Categories panel UI changed, the Split-by-owner
dashboard panel is gone, tag reports replaced category-owner filtering).

**Why deferred.** Asked at the end of Phase 3 / Phase 4 and didn't get an
answer; held off rather than guess at the right tone. `CHANGELOG.md` now
exists with an `[Unreleased]` section that already documents adjacent
removals (the pre-auth security UI, the Merchant Renames tab), but it still
lists the old owner model under *Added* and never calls out the
category-owner → tag migration — so this entry is still unwritten.

**Suggested approach when picked up.** Standard CHANGELOG line under the
`[Unreleased]` section, calling out the migration of category ownership to
tags and pointing at the Help-page topic for users who want the model
explained.

## SimpleFIN's window limit rose to 90 days — and became a silent cap

**Context (2026-08-08).** `WINDOW_DAYS` is set from what the live Bridge *says* rather than from its
documentation, because only one of the two is enforced. What it says changed within a day:

```
2026-08-07  "exceeds recommended range of 45 days. In the future, this may be capped."
2026-08-08  "[gen.api] Requested date range exceeds limit of 90 days and was capped."
```

So the limit is now the published 90, and the future arrived: an over-wide request is no longer
tolerated with a notice, it is **silently truncated**. Doubling the window would roughly halve the
requests a full-history walk spends (~5.4 years/day against the 22-request budget, from ~2.7).

**Why deferred.** The cap is the dangerous shape, and nothing currently guards it: the walk advances
each account's frontier by the window it *asked for*, so a capped response would record coverage over
days nothing fetched — the over-claim that makes duplicate detection reject genuine transactions
(`data-model.md` → "coverage has two shapes"). At 45 days there is a wide margin and the cap cannot be
tripped, so the safe option was to leave it and write down why.

**Suggested approach when picked up.** Two parts, and the second is the real work: (1) raise the
window to **~88**, not 90 — a request is a range of *instants* and `_fetch_window` runs the end bound to
the close of its day, so a nominal N-day window is N days plus a further 23:59:59 on the wire, and a
literal 90 would trip the cap on every request; (2) validate the returned range against the requested
one before recording any coverage, so a cap becomes a visible short-fetch rather than a false claim.
Worth doing only if the request saving matters — 45 days already reaches further back than the Bridge's
upstreams actually hold.

## A request that stalls mid-interaction still hangs

**Context.** `lib/backendLiveness.js` catches a *refused* connection instantly, and its
visibility/gesture probes catch a machine that woke up to a dead socket. What nothing catches is a
request that is accepted and then stalls with no visibility change to trigger a probe — the page waits
on it indefinitely, as it always has.

**Why deferred.** A blanket `AbortSignal.timeout` on the api layer was considered and rejected on
2026-08-20: it would have to exempt every legitimately long request (sync, import, backup, demo load),
and that carve-out list breaks a real feature whenever it is wrong or goes stale. An opt-in `timeoutMs`
on `request()` is the shape that would work, added per-call where a caller knows its own duration.

**Trigger.** Worth doing if a stalled request is ever actually observed; not worth building the
machinery speculatively.

## Manual tagging vs inheritance: what checking a tag means

**Context (raised 2026-08-26, from a live observation).** A transaction sat in a category that
carries a tag *and* had a direct `txn_tag` row for the same tag. The API reports one winning source
(`direct` beats `category`, `_SOURCE_PRIORITY`), so the UI cannot show that both contribute, and it
cannot tell a rule-attached tag from a hand-attached one either — both read as `direct`.

**What the round trip actually does** (measured, not inferred — the two cases differ):

| starting row | uncheck | re-check |
| --- | --- | --- |
| `rule_present=0, manual_state=1` | `-1` (blocked) | row **deleted** → tag reverts to inherited |
| `rule_present=1, manual_state=1` | `-1` (blocked) | `manual_state=0` → still reports `direct` |

**The open question.** The delete branch (`present=True` + inherited + no rule) normalizes away a
direct row on the grounds that a purely inherited tag needs none. The counter-argument, and the
reason this is filed: **checking a tag on a transaction is an act on the transaction**, so the tag
arguably should survive a later recategorization — which the deleted row would not. The two readings
correspond to two different user intents that the current API cannot distinguish: *"undo the hide I
just made"* (delete is right — it restores the prior state) versus *"tag this transaction"* (a
force-on row is right).

**Why it is not simply a bug.** In the row/detail picker an inherited-and-visible tag is rendered
checked-but-disabled, so the only way to reach `present=True` while the tag is inherited is by
un-blocking one — the undo case, where delete *is* correct. **Bulk `add_tags` has no such guard**:
it goes through the same `set_manual_transaction_tag`, so tagging a selection leaves no row on the
rows that already inherit the tag, and the tag silently drops off those when they are recategorized.
That is the concrete hole to look at first if this is picked up.

**Sketch of a fix, if wanted.** Report every contributing source rather than only the winner
(`sources: ['direct','category']`, with rule and manual told apart) — the merge loop in
`get_visible_transaction_tag_map` has both facts in hand at the point where it discards one, so the
data side is cheap. That would let the picker say "added here · also from Coffee Shops" and offer the
two intents as separate actions ("remove my copy, keep the inherited one" vs "hide here"), and would
let bulk add record a force-on without the ambiguity.


## A watched folder could take PayPal statement PDFs

**Context (raised 2026-10-16).** A watched folder takes `.csv` only (`watch.CANDIDATE_SUFFIXES`), so a
statement PDF saved into one is passed over and has to be dropped on the import page by hand. Nothing
about the statement importer requires a person, which is what makes this a gap rather than a decision:

- `read_statement` turns the PDF's bytes into rows and asks nothing.
- **The destination resolves itself.** A statement names its PayPal Account ID, and `_statement_accounts`
  reads the ID → ledger-account tie out of the batches already imported, so for an account with history
  there is no question to ask.
- **The refusals are already written for a person** (`_check_assignments`): an unseen PayPal ID, a
  statement that would land in the wrong account, an account already holding another ID's statements.
  Those are park reasons as they stand — the same shape as a CSV's unmapped account value.
- `_imported_hashes` keys on the statement's content hash, so "already taken" is durable.
- It ends in `run_import_parsed`, the function the watcher already calls, and the single system PayPal
  source is a `csv_import_profile` row that can carry a `watch_dir` like any other — one folder would
  then serve its activity CSVs too.

**Suggested approach when picked up.** Four parts:

1. `CANDIDATE_SUFFIXES` becomes per-source — the PayPal source takes `.csv` and `.pdf`, every other
   source keeps `.csv`, or each one starts trying to parse PDFs.
2. `_read_file_text` decodes to text; a PDF needs its bytes, so the read branches with the handler.
3. `_import_ready_file` would gain a third branch. Two is an `if`; **three is the point to make it a
   dispatch keyed on the source kind**, before a fourth is pasted in beside them.
4. **Leave zips alone.** The upload path expands a zip of statements; a watched folder should not —
   expanding an archive found on disk unattended is a wider capability than reading a file someone
   saved there, and a zip in a downloads folder is usually one nobody has opened.

**Follow-on.** The folder picker lists the files a folder would import, filtered server-side on
`CANDIDATE_SUFFIXES`, and the client is told *which files* rather than which extensions — so widening
the set widens the picker with no frontend change. The backend test asserting the picker offers nothing
the scan would pass over is what keeps the two from drifting.

## A rule action that stops later rules from applying

**Context.** Matching does not stop at the first rule: every matching rule contributes, with the category
and the rename each taken from the highest-ranked rule that sets one and the tags of every matching rule
added together (`docs/data-model.md` → *How matching rules combine*). There is no way to say that one rule
alone governs the transactions it matches.

**The idea.** A per-rule *stop matching* option, as mail filters have: once this rule matches, rules ranked
below it contribute nothing to that transaction, not their tags, rename or category.

**Open questions.**

- Precedence is computed, not ordered by hand, so "below" means below in `rule_specificity_order_sql`. The
  option cannot settle the rule checkup's arbitrary pairs, since in those the ranking between the two rules
  is itself the accident; it would only make a rule's ranking matter more.
- Every path that mirrors the engine would have to honour it: preview and single-rule apply in
  `routers/rules`, and rule-backed series membership, which tests each rule on its own
  (`recurring_detection._candidate_members`).
- The checkup's outcome test (`rule_overlaps._outcomes_agree`) would change: with a stopping rule in a pair,
  tags and a rename only one side carries would depend on which rule wins.
