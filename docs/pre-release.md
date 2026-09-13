# Pre-release plan

**Started 2026-08-21.** The work to finish before the repository is made public. This is not backlog —
everything here is committed and blocking, which is why it lives outside `docs/backlog/`. Detail stays
in the backlog files; this is the ordered plan and the decisions still owed.

**Delete this file once the release ships.** It is a plan with an expiry date, not a record — anything
in it worth keeping belongs in the backlog file it came from, or in the main docs.

**This is a *minimum*, not a ceiling** (stated by the user, 2026-08-27). The named scope under each
feature is what has to ship, not a boundary on what may. Adjacent work that is clearly right and low
risk should be taken while the code is open rather than deferred to keep a scope line clean — the
rule-range signal and the Tasks dismissal both arrived that way. State what was added past the named
scope so it can be scoped back; do not ask permission to stay inside the line.

**It carries no deadline, and nothing here is a schedule.** A minimum is a list of what must be true
before the repository is public, not a claim about when that happens or a queue other work has to wait
behind. So new work is never "competing with the release" and never needs placing before or after it:
take it on its own merits and build it when it is right. Written down 2026-09-05 because the question
kept being re-asked — treating this file as a deadline is the misreading it most reliably invites, and
re-raising it is itself the thing to stop doing.

"Public" here means three things happening together: a tagged release with downloadable kits attached,
the repository visibility flipped, and the README describing what actually exists on that day.

## Already done

Landed in the working tree, uncommitted at the time of writing:

- `SECURITY.md` — reporting, supported versions, scope (including the deliberate design properties that
  are *not* vulnerabilities), and what a compromise means.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `.github/ISSUE_TEMPLATE/` (bug, feature, security routing) and `PULL_REQUEST_TEMPLATE.md`.
- `CHANGELOG.md` reset to start at the first public release.
- README restructured for one audience — identity, scope, install, pointers — with maintainer content
  moved to `docs/releasing.md` and developer content to `CONTRIBUTING.md`.
- `TODO.md` aligned with the backlog policy.
- Git history rewritten so every commit carries one author identity — **pushed 2026-08-21**, both
  branches, safety refs purged. All 256 commits now carry `jeff162@duck.com` alone.

## Features

Six, all with designs already written. Named scope is what ships for the release; anything else in
those files stays deferred.

### 1. Receipts and invoices — attachment phase 1  ✅ *built 2026-08-24*

[`backlog/transaction-attachments.md`](backlog/transaction-attachments.md) — phase 1, since folded into
`data-model.md` → *Attached documents*; the file now holds only the unbuilt tiers.

The ingestion seam (file drop, clipboard paste), storage, a viewer, an attachment indicator on the
transaction, and **tier-1 PDF text extraction** so an attached invoice is searchable. The backup half is
additive on top of feature 5's envelope: the table, the digest at ingest, and the files as zip members. Not in scope: OCR
(tier 2), line-item extraction (tier 3), or anything touching splits.

**This one is promised by the README already**, so it is the only feature whose absence would make a
shipped document wrong. Its scope was deliberately written to the free tiers for that reason.

**Storage decision settled 2026-08-21:** files on disk under `DATA_DIR/documents/`, carried inside the
backup zip as members, riding the **Financial data** backup. That also resolves portable-vs-installed
for free (`DATA_DIR` already anchors both databases). Images are downscaled at ingest (Pillow, accepted);
a ~25 MB per-file cap covers pathological scans. The `documents` section and the `documents/<id>` members took payload version **12** (feature 5 spent the 9 → 10 bump this was originally scoped against, and splits then took 11). Details and the rejected
alternatives are in the backlog file.

**It gained a prerequisite instead** — see feature 5, which landed 2026-08-23.

**Phase 1 is built and has had a first pass in the running app (2026-08-24).** Backend: the `document`
table and the on-disk store (atomic writes, ingest normalization, image downscaling, and the sweep that
derives file removal from the ledger); the backup half (the `documents` section plus each file as a
stored zip member, restored after the ledger commits and swept against it); `restore_state` and the
resumable documents phase, with the gate that refuses an import, a sync or a second restore while one is
outstanding; the attach/list/serve/detach endpoints; tier-1 PDF text extraction (`pypdf`); and the FTS5
index. UI: the shared `DropZone` (extracted on the `shared-components.md` watchlist trigger, with the
Amazon tab moved onto it), `DocumentsPanel` on the transaction detail panel, the ledger row's paperclip,
and `DocumentViewerDialog`. Documents follow their transaction through the trash, and the purge and the
demo-data clear both reclaim their files.

**What the first real-app pass changed**, all of it worth knowing because none of it was visible to a
green test suite:

- **Text and HTML became document kinds.** The design had always said a receipt may arrive as text
  pasted out of a mail client; only files had been built. Pasting also turned out to need a real
  `<textarea>` — a paste event reaches only the focused element and browsers offer right-click Paste
  only on editable ones, so the original handler was unreachable by keyboard *and* mouse.
- **A paste keeps the sender's layout.** The plain flavour of a copied email is its table flattened, one
  cell per line, with each amount under the item it prices. The `text/html` flavour is taken instead when
  the box is left unedited. A saved `.eml` is accepted too and converted at ingest.
- **Document text reaches the plain search box**, not only `doc:`, with matched rows flagged so the
  ledger can show *why* they came back. The prefix-only rule was reversed on first use — see the backlog
  file, which records it as a don't-re-impose.
- **The ledger's paperclip opens documents**, rather than only counting them.

The **Help topic** (`transaction-documents`) is written — filed under a new *Transaction detail* index
section, reached from an inline `?` on the Documents panel, and drafted against the voice of the existing
topics rather than in the author's own hand, so it is placed rather than finished.

**Exercised in the running app, 2026-08-24**, and nothing further is owed on it. The first pass had found
four defects in an hour, every one of them in how a component sits in the live tree rather than in its
logic — the reason that pass was treated as blocking rather than as a formality.

### 2. Recurring anomaly signals  ✅ *built 2026-08-27*

Scoped as the *anomaly / forecast signals* half of the recurring backlog, plus two additions taken
deliberately (see below). That half has since shipped and folded into
[`data-model.md`](data-model.md) → *Recurring series*, so the backlog file no longer carries it.

Detection, listing and curation were already live; this is the payoff for substrate that existed. The
four signals — **upcoming**, **missed**, **new series detected**, **price change** — plus a fifth,
**rule amount-range drift**, and dismissal on the Tasks page.

**The owed decision was settled: all four ship**, but *upcoming* is a **view**, not a task. It is a
forward-looking budgeting aid rather than an anomaly, some users will not care about it at all, and a
badge that counts ordinary life stops meaning anything. It lives as a tab on the Recurring page's review
section with no actions and no dismissal.

**Two things were added past the file's named scope**, both on the user's call that this plan is a
minimum rather than a limit:

- **Rule amount-range drift.** The user's actual use of amount ranges on rules is *disambiguation* —
  separating several bills from one biller by size — which makes the range a **matching gate**. When a
  bill drifts past the bound the row stops matching, so it loses the rule's category *and* its place in
  the rule's series, and nothing else in the app notices: the row is categorized, just not as intended.
  The finding reports a charge that missed by a little (and, more quietly, one sitting just inside a
  limit) and offers **Widen to include**, which moves the bound and re-applies the rule. It was built
  beside the recurring signals and **now lives on the Rules page**, in the *Rule checkup* panel beside the
  overlap findings: both of its actions edit a rule, and it never needed a series to exist at all.
- **Task dismissal**, which applies to tasks predating this work. The mark is the count at dismissal and
  **ratchets down** to any lower count seen since — a mark that only held at its original value swallows
  new work precisely because the user cleared some. `txn` has no insertion timestamp, so the alternative
  ("members newer than the dismissal") would have meant a new column on the largest table and every
  insert site updated; the ratchet gets the same behavior for none of that.

**What the design as written could not have done** — both stated here, and carried in
[`data-model.md`](data-model.md) → *Recurring series* as the durable record:

- **"A charge outside the established `amount_min`/`amount_max` band" is not implementable.** That band
  is rewritten from exactly the rows the series owns, so a hiked charge is inside it by the time anything
  looks. Price change is measured against the occurrences *preceding* the latest charge.
- **"Missed" had to be judged against data freshness, not the calendar.** Against today, a month without
  an import reports every active series as missing.

The signals are **derived on read**, not fired from the import scan the seam had been marked for two
versions: an auto series is re-minted with a new id on every scan, so a stored finding is orphaned within
a day and stale on the next edit. The only durable state is the user's dismissals. Fixed on the way:
`recurring_series.created_at` now means *first detected* rather than *last rebuilt*.

**The amount-identity half was out of scope here and has since been taken anyway** (2026-09-01, on the
user's call that the release is not imminent) — `amount_mode`, amount-gated membership and the pinned
expectation band. The signals work had settled its design; what the build found was that it was covering
**two live defects** rather than a missing feature. See *Recurring series amount identity* under
*Landed alongside*.

**First real-app pass, 2026-08-27 — one defect, invisible to the suite by construction, and a structural
change behind it.** The findings section rendered into the Recurring page's pinned header (`flexShrink: 0`
over a `minHeight: 0` body) with no height cap, so nine real findings collapsed the series list and the
drill-down region to zero height: "Open series" drew its report into nothing and read as a dead button.

Capping the height was the patch. The diagnosis was that the page was carrying two things at once, so it
became **three peer views** on the shared `SegmentedToggle` — Series / Needs attention / Upcoming — each
owning the scrolling body, with the open-findings count as a badge on the control. Filter/sort/search
travel with the series view; Upcoming was promoted out of the findings panel, which is what its own
"not an anomaly" argument had implied all along. A finding's "Open series" opens the drill-down **in
place** under the findings — switching to the series view for it was tried and dropped, because it left
the list being worked through and could land on a filter that excluded the very series being opened. `SegmentedToggle` was extracted
from `Dashboard.jsx` into `ui.jsx` on the way (second instance = the `shared-components.md` watchlist
trigger), gaining optional count badges.

**Also from that pass:** the page carried three different left margins — header, cards and drill-down —
because `maxWidth` sat on the elements that also carried the page padding, which measures the column
*inside* the padding and leaves a centred header a padding's width in from a centred list. Fixed to one
named column per page, applied inside the padding; the Tasks page had the same latent mismatch (hidden
only because it is left-aligned) and was harmonized too. All three lessons are generalized into
`ui-patterns.md`.

**Second real-app pass, 2026-08-27 — a stale membership cache, found by using the feature to do real
work.** Recategorizing a charge so it would join the series it belonged to changed nothing: the row's
menu still opened the *old* series, the new series' drill-down never gained it, and the missed-charge
finding stayed open. All three read `txn.recurring_series_id`, which only a scan rewrites, and none of
the scan triggers covered a hand edit — import and sync scan the payees they touched, a global
recategorize scans everything, the app-load catch-up is watermark-gated to about a day. The edit
endpoints now run the scoped scan for the payees they touch (`rescan_edited_transactions`), for the
fields the detector actually reads. Two costs shaped it: a no-op re-save skips the scan, and bulk edits
scan once for the batch — a scoped scan loads the whole detection window before filtering, measured at
~125 ms on a 20,000-row ledger, which is what makes a per-row version untenable.

**Rejected in the same pass:** pinning a transaction into a series it would not otherwise match. The API,
`reconcile_series` and `data-model.md` all supported it and the Help topic promised it, but no UI ever
sent it — and the user's judgement is that it misrepresents what a series *is* (a late fee on a tax
payment shares the category without being part of the series). The docs and Help text were corrected to
match; see the backlog file.

**Built after that pass and not yet exercised at all:** the seasonal amount-range learning (a dismissal
on a variable series widens the range a later charge is judged against) and the re-evaluation on edit
itself. Both are under test, and neither has been seen in the app.

**Otherwise not exercised in the running app.** Backend and component contracts are under test (18 backend signal
tests, 6 task-dismissal tests, 12 frontend), but the review section's placement, its copy at real
density, and the Tasks dismiss/undo flow are the class of thing a green unit suite cannot see. Worth a
pass before screenshots.

### 3. Cash-flow reporting  ✅ *built 2026-08-25*

[`backlog/dashboard-reporting.md`](backlog/dashboard-reporting.md) → *cash-flow half only*.

Cash flow as a third frame on the Expenses/Income selector: a **Sankey** for a single period, diverging
bars plus a net line for trends. The design is settled and rests on the existing `exclude_from_totals`
flag rather than any new transfer-pairing or per-view exclusion machinery.

**Not in scope:** the Trends-tab double-count audit in the same file. It is gated on the Trends tab
gaining a tag-report selector, which is not part of this release. The two items are unrelated despite
sharing a file. The deferred `cash_date` phase stays deferred.

**What landed.** The frame selector widened to three; the single-period Sankey (custom node and link
renderers over `recharts`'s bare `<Sankey>`, with each side's long tail paged through the same adaptive
slicing the pies use, now shared from `lib/longTailSlices.js`); the Trends form as diverging bars with a
net line and the usual average reference line; drill-through from every node into the existing
group → categories → transactions drill; and a `dashboard-cash-flow` Help topic.

Two things turned out differently from the design as written, both now in
[`data-model.md`](data-model.md) → *Reporting assumptions* → *Cash flow*:

- **The Sankey needed no new endpoint** — `/summary/by-category` already returns the node set, so the
  single-period diagram is a re-projection of a call the dashboard already makes.
- **The Trends form did**, and could not be built from `view=spending` + `view=income`: those filter on
  `category_type` and drop type-less categorized rows, so their difference would not equal the
  `cash_flow` net and the net line would contradict its own bars. `/summary/monthly-cash-flow` reports
  the two sides netted per category, which is what makes a month's bars equal that month's diagram.
  `/transactions?view=cash_flow` was added with it, because the list endpoint's `exclude_from_totals`
  guard was gated on the other two views and a drill would have listed transfers its total excluded.

**Owed decision left open, deliberately:** Compare has no cash-flow form. The frame selector was already
hidden there and stays hidden. Specifying a two-period cash-flow comparison is open work, not an
oversight.

**First real-app pass, 2026-08-25** — three defects, all of them invisible to the unit suite by
construction, since neither chart can be rendered under the unit runner. Two were label legibility on the
Sankey: a fixed-height label stack that overlapped its neighbours on any node under ~13px, and a side too
short to reach the shared named-slice floor naming every bucket it had, down to 0.0004% of the side.
Labels now fold onto one line where two will not fit, and the shared slicing gained an opt-in `minShare`
the cash-flow sides pass at 1%. The third was the Trends chart drawing the wrong thing entirely: the
diverging bars were missing `stackOffset="sign"`, so money out was stacked down from the top of the
money-in bar rather than from zero, putting the net on screen twice and money out not at all — with
correct tooltips the whole time. All three are in [`ui-patterns.md`](ui-patterns.md) → *Charts and
overlays* as don't-re-impose.

**Second real-app pass, 2026-08-25** — three more, all on the *shared* single-period trend chart rather
than on anything cash-flow specific: one outlier period owning the whole Y axis (no chart in the app set
a `domain`, so this was latent across all seven of them), a bar click leaving the chart apparently blank
because the pan offset outlived the bucket set it was scrolled over, and no way back from a trend click,
which re-pins the shared date filter. Fixed by `lib/chartOutliers.js` + a shared `ClippedBar` shape, a
layout effect that re-centres the selected bucket, and a bounded date history in `FilterContext` with a
"← Back to …" control that names its destination. That history records **chart pins only** — an explicit
FilterBar pick resets it rather than becoming a step, so the control never offers to step back over a
period the user chose themselves. The clamping is applied to the single-period trend
chart only so far; the other charts are noted in [`ui-patterns.md`](ui-patterns.md) → *Charts and
overlays*. Two follow-ons from the same pass:
that chart's value axis was pulled out of the horizontal scroll so it stays readable at any pan
position, and the average pill moved into that column, where it steps aside from any tick label it
would otherwise bury.

**Third real-app pass, 2026-08-25** — changing the trend grain took seconds to settle. Two mechanical
causes (the bars still carried recharts' default grow-in, and both charts sat in a `<ResponsiveContainer>`
that measures its own box after the fact, so a re-bucket painted at the previous bucket set's width) and
one behavioural: the re-centring rule targets the *selected* bucket, and the grain selector only appears
when nothing is selected, so every grain change fell through to "scroll to the newest bucket". Both
charts are now handed explicit sizes, and the month under the middle of the viewport is carried across a
re-cut. Details and the don't-re-impose notes are in [`ui-patterns.md`](ui-patterns.md) → *Charts and
overlays*.

**Fourth real-app pass, 2026-08-25 — one data-correctness bug, found by using the ledger rather than the
dashboard.** "Needs review" + select-all + Mark reviewed reported 18,278 rows changed against a filter
showing 28. The bulk endpoint's filter allowlist did not name `needs_review`, and an unrecognized key was
*dropped*: every filter there narrows, so losing one widened the selection to the whole ledger. Harmless
by luck — the action rewrites `needs_review = 0` on rows that already held it — and destructive under any
other action. Fixed by naming the key and by making an unrecognized key a 400 instead of a silent drop,
and a selection over 500 rows is now confirmed before it runs. The lesson generalizes past this endpoint:
a validation step that discards what it does not understand is only safe when discarding is the
conservative direction, and for a filter it is the opposite one.

**Not otherwise exercised in the running app.** The backend contracts and the graph rules are under test (14
backend, 17 frontend), but the diagram's placement, labelling and hit targets are exactly the class of
thing a green unit suite cannot see — the same class that produced four defects in an hour on feature 1.
This one is worth a pass before screenshots.

### 4. Vault recovery  ✅ *done 2026-08-31; second pass 2026-09-01*

The settled record is [`security-model.md`](security-model.md) → *Recovery and compromise response* and
*Authorizing a change to how the vault opens*, with the rejected shapes in its tail sections.

A forgotten vault passphrase was an unhandled dead end with no endpoint and no UI — **the sharpest gap on
this list**, since the first public user who sets a passphrase and forgets it had no path at all and the
app did not even say so.

Shipped: the **destructive reset** with both paths (lost versus compromise), revocation on the way out
driven by `revokes_on_disconnect` and reported per connection, and the refusal scoped to the lost path.
The *owed decision* on **vault recovery codes** was settled in favour of shipping them — one code per
user, in one atomic recover-and-re-key request, which is what makes a single code as safe as a set. Also
taken: the `VaultDecryptError` classification. `VaultRecoveryDialog` presents the whole ladder in order
off the locked vault strip.

**Second pass 2026-09-01 — two defects in what shipped, and one wider finding, all now closed.** The ladder's *other member
can help* rung never executed: it instructs the stuck user to set a new passphrase, which `set_passphrase`
refuses for exactly that user because their slot still holds the DEK. And a passkey opens the vault but
cannot set a new passphrase, so a passkey holder who forgets it must lock themselves out to reach the
recovery code. Behind both: `set_passphrase`, `register_passkey_slot` and `issue_recovery_code` each mint
a **durable** unlock method from a DEK merely found in the 8-hour unlock cache, turning transient access
to an unlocked session into permanent independent access. Scope, decisions and rejected alternatives are
in [`security-model.md`](security-model.md) → *Authorizing a change to how the vault opens* and
*Considered and rejected*. Not a regression from the 2026-08-31 work — the mint-from-cache behaviour predates it. Shipped
as a five-minute proof window on all three doors, `POST /auth/vault/passkey/set-passphrase`, and a
re-enrollment rung that submits from inside the recovery dialog and is marked as replacing existing access
where the approver can see it.

**Re-link adoption landed too, with a correction to what it is for.** The claim that a SimpleFIN re-link
strands the account mappings was **wrong**: `record_provider_accounts` and sync both key on
`account.external_account_id`, which is UNIQUE and durable, so mappings and routing survive on their own.
What is actually lost is per-account **coverage** and the connection's cursor — a full history re-walk
under the provider's rate budget, plus a duplicate card. Connect now asks *what is this connecting?* and
**re-points the surviving row** rather than inserting a second one, driven by a new declared capability
(`stable_external_id`) so a future provider inherits the behaviour by declaring the trait. The question is
asked **before** the provider call because a claim is single-use — see `building-a-connector.md`.

### 5. Streaming backup — export *and* restore  ✅ *done 2026-08-23, less the documents phase*

The settled design is in `data-model.md` → *Backups* (the envelope) and `scale-and-limits.md` →
*Bulk operations must not accumulate* (the measurement that shaped it).

The export assembles the whole payload as a Python structure, serializes it to one JSON string, zips that
into a `BytesIO` and returns it as a single yield; restore is the same defect mirrored — read whole,
parsed whole, filtered as ~25 in-memory lists. Measured on a ~18,500-transaction ledger: **~275 MB of
transient allocation to produce a 4.9 MB file**, ~178 MB to read one back, linear in the ledger. **This
already scales and always has**; documents would make it acute rather than causing it.

It is on this list because *"nothing should degrade as the transaction count grows"* is a project
principle — the list windowing exists for that reason — and because shipping documents on top of it would
turn a latent problem into a reported one.

**Scope, settled 2026-08-23 and wider than first written.** Three things moved into it, each for a
reason that made the alternative worse:

- **Restore, not just export.** A ledger that can be backed up and not restored has no backup.
- **The payload version 9 → 10 envelope** (`meta.json` + `sections/<name>.ndjson` + `documents/<id>`),
  which feature 1 needed anyway. Taking it here is what makes the restore side streamable without an
  incremental JSON parser that feature 1 would then delete — and it shrinks feature 1 to adding a table
  and some members to a container already shaped for them. Versions 7–9 still restore, unchanged.
- **The CSV export**, same defect on the same page, small.

Two decisions this hands to feature 1 rather than leaving open: a **digest per document recorded at
ingest**, and a resumable documents phase driven by a `restore_state` marker, because files are not
transactional and a half-written restore must not cost the user their originals.

**What landed:** version 10, streaming export and restore, the incremental cipher (envelope unchanged),
referential repair as SQL, the CSV export, and — found on the way — the `POST /restore` route, whose
decorator had drifted onto the wipe helper, leaving the JSON-body restore unrouted. Export peak on a
~18,500-transaction ledger fell from ~275 MB to ~9 MB, restore from ~178 MB to under 2 MB.

**Also fixed here, off-plan:** a data restore left every connection's `transactions_cursor` ahead of the
ledger it had just rolled back, so the removed rows sat behind the resume point and no later sync would
ever re-offer them — silent, permanent loss on the exact path this release hands to strangers. It was a
parked item in the same backlog file; it is a handful of lines and was not worth shipping around.

**What did not, deliberately:** `restore_state` and the resumable documents phase, which have nothing to
guard until documents exist. They stay designed in the backlog file and belong to feature 1, along with
the digest at ingest.

**Prerequisite for feature 1**, and worth doing regardless of it.

### 6. Transaction splits  ✅ *built; exercised in the running app 2026-08-24*

The mechanism is in [`data-model.md`](data-model.md) → *Transaction splits*; the rejected shapes and
the neighbouring mechanisms it is not are in [`mechanism-index.md`](mechanism-index.md). Its decisions
were settled 2026-08-23 and the project file was disposed of 2026-09-02.

Allocating one transaction's amount across several categories: the `txn_split` table, the
effective-category-rows expansion seam that every summary and category-scoped list reads through, the
split editor, and the pre-fill that proposes an allocation from a marketplace order's captured per-item
list prices. In scope for the release because it is the terminal dependency of two other initiatives —
reimbursable expenses cannot start without it, and attachments phase 4 feeds into it — so deferring it
defers them.

**Not in scope:** rules that author splits, mixed-sign allocations, and the attachment phase-4 hand-off,
which stays behind tiers 2 and 3 regardless.

**Blast radius, stated plainly:** this is the one feature that changes numbers on surfaces that were
already correct. Every category rollup and every category-scoped drill-down reads through the new seam,
so a regression here is a wrong total rather than a missing feature. That is what the backup omission
guard, the summary-endpoint tests, and a before/after comparison over a real-data copy are for.

## Landed alongside, off-plan

Not one of the six, and not scoped here. These two are recorded for a specific reason — each moved a
**schema or payload version** the release notes have to name — and **not as an inventory of what
shipped**: plenty has landed that is named nowhere in this document, and keeping a complete list here
was never the intent.

**Recurring series amount identity** (shipped 2026-09-01; the durable record is
[`data-model.md`](data-model.md) → *Recurring series*). Amount becomes part of a series' identity where it is the only thing telling two
series apart. It was picked up as backlog rather than under any feature above, and it closed two defects
that were live in shipped code: confirming one of a biller's two subscriptions **orphaned the other** (the
candidate-coverage check could not tell two price points apart), and two subscriptions billing a fortnight
apart **merged into one bogus biweekly series** at an average price neither one costs. Both defects, and
the shapes not to re-impose, are in [`data-model.md`](data-model.md) → *Recurring series*.

One thing it moved that matters below: **schema version 46** — three additive columns on
`recurring_series` (`amount_mode`, `expected_min`, `expected_max`), no backup payload change, since the
restore intersects a payload's keys with the live table's columns in both directions. It also changes
what the Recurring page shows (a card can now say it is matched by amount, and carries an *Amount*
control), which is relevant to **Screenshots**.

**Rule overlap surfacing** ([`backlog/rule-amount-overlaps.md`](backlog/rule-amount-overlaps.md), shipped
2026-08-27). *Rule checkup* on the Rules page reports rule pairs that compete for the same
transactions: amount ranges overlapping with no deterministic winner (a warning, not dismissible, no
delete — the answer is to refine the conditions), and nested merchant matchers (information, dismissible,
with a delete on the surplus half where the pair files identically). It was picked up as parked backlog
rather than under any feature above.

Two things it moved that matter to the steps below:

- **Schema version 45 and backup payload version 14**, both purely additive — a `rule_overlap_dismissal`
  table and its backup section. Anything in the release notes that names a payload version needs the new
  number, and the kit test now exercises a migration on top of everything else.
- **The Rules page header changed** — a new control, a rename of the categorize button, and
  `PageHeader`'s action row now wraps instead of squeezing. That last one is shared by every page, though
  it is inert until a header actually overflows. The header moved again when the rule range-drift
  findings arrived there (below), so it now reads *Categorize* / *Generate rules from imported data* /
  *Rule checkup* / *+ New*. Relevant to **Screenshots**, which is the step that assumes surfaces have
  stopped moving.

## Release mechanics

- **Test the ARM64 / Raspberry Pi kit.** The Windows, Linux x64 and macOS kits have been exercised; the
  ARM64 build was added afterwards and has never run anywhere. It is a portable zip, so the test is the
  same one: unzip, run, confirm the databases land beside the executable and the app opens.
- **Screenshots.** The README has none, and it is a dashboard-driven visual application whose whole job
  is letting someone decide quickly. This will cost more prospective users than any missing document.
  **Deliberately last, after every feature lands** — a feature that adds a dashboard frame or changes
  what a surface shows makes anything shot earlier a reshoot.

  **Do not take this document as the inventory of what moved.** It is a plan for what had to happen, not
  a log of what did, and plenty has landed that is named nowhere in it. Work out what needs an image
  from the app and the diff at the time of shooting.
- **Cut the release.** `docs/releasing.md` has the checklist. Note that CI does **not** publish —
  attaching the five artifacts and their `.sha256` files to a written release is a manual step, and
  nothing is downloadable until it happens.

## Pre-public audit closure

The 2026-09-07 security review found the issue below, which still has to be closed before a client-server
install is made public. When it lands, keep `security-model.md` → *Transport security* accurate to the
enforced rule and delete this section.

**Enforce secure transport before any provider-secret operation.** A network HTTP request can configure a
provider app secret, start a credential-bearing connection, or reveal a decrypted secret; the current
transport check only warns after accepting the value. Reject non-loopback cleartext requests in a
server-side dependency shared by all provider and credential-bearing vault operations, and derive loopback
from the trusted peer/proxy boundary rather than the Host header.

**Deferred to the client-server deployment work (decided 2026-09-13).** That topology has not been built
yet, and the decisions this needs — which proxy is trusted, and how loopback is recognized behind it —
belong to it.

## Sequencing

1. **Streaming backup (5) before receipts (1).** The storage decision is settled, but shipping documents
   onto an in-memory export and restore is what would make that defect user-visible — and 5 now also owns
   the envelope and the two document decisions that 1 builds on, so the order is a dependency rather than
   a preference. Nothing else waits on either.
2. **The other three in any order** — they do not touch each other. Recurring anomalies (done) were the
   cheapest and most visible; vault recovery (done, second pass 2026-09-01) was the one whose absence was
   a real hazard; attachments are the one the README already promises.
3. **Splits (6) can run alongside any of them** — it shares no surface with the other five. It should
   land before screenshots for the same reason cash-flow reporting does: a category drill-down looks
   different once a split renders in it.
4. **Kit testing** — independent of the features, so it can happen whenever a build is convenient.
5. **Screenshots**, once every feature is in. See above: the visual surfaces change under two of them.
6. **Cut the release, attach the artifacts, flip visibility.**

## Deliberately not in this release

Named so they are not re-litigated under deadline pressure: attachment tiers 2 and 3, the online
categorizer, and everything else in `docs/backlog/`.

**Reimbursable expenses was on this list and is not any more** — it was built anyway, and completed
2026-09-03. The list is corrected rather than annotated, because a "deliberately not" entry that has
shipped is a false statement about the plan, and the next reader has no way to tell which entries are
still true.

**Transaction splits was moved back in, 2026-08-23.** It was deferred here on the grounds that invasive
cross-cutting reporting surgery is the wrong thing to have in flight while strangers start reading the
code. That concern was answered rather than overruled: the surgery turned out to be a *row-source*
substitution — every summary and list query is already phrased against one alias, so the expansion seam
replaces `FROM txn t` and leaves every facet helper, sentinel, and exclusion guard untouched. What moved
the decision is that splits is the terminal dependency of two other initiatives (reimbursable expenses
outright, attachments at phase 4), so deferring it defers them as well. Scope and the settled decisions
are in [`data-model.md`](data-model.md) → *Transaction splits* and
[`mechanism-index.md`](mechanism-index.md).
