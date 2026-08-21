# Pre-release plan

**Started 2026-08-21.** The work to finish before the repository is made public. This is not backlog —
everything here is committed and blocking, which is why it lives outside `docs/backlog/`. Detail stays
in the backlog files; this is the ordered plan and the decisions still owed.

**Delete this file once the release ships.** It is a plan with an expiry date, not a record — anything
in it worth keeping belongs in the backlog file it came from, or in the main docs.

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

Five, all with designs already written. Named scope is what ships for the release; anything else in
those files stays deferred.

### 1. Receipts and invoices — attachment phase 1

[`backlog/transaction-attachments.md`](backlog/transaction-attachments.md) → *Phase 1*.

The ingestion seam (file drop, clipboard paste), storage, a viewer, an attachment indicator on the
transaction, and **tier-1 PDF text extraction** so an attached invoice is searchable. Not in scope: OCR
(tier 2), line-item extraction (tier 3), or anything touching splits.

**This one is promised by the README already**, so it is the only feature whose absence would make a
shipped document wrong. Its scope was deliberately written to the free tiers for that reason.

**Storage decision settled 2026-08-21:** files on disk under `DATA_DIR/documents/`, carried inside the
backup zip as members, riding the **Financial data** backup. That also resolves portable-vs-installed
for free (`DATA_DIR` already anchors both databases). Images are downscaled at ingest (Pillow, accepted);
a ~25 MB per-file cap covers pathological scans. Payload version 9 → 10. Details and the rejected
alternatives are in the backlog file.

**It gained a prerequisite instead** — see feature 5.

### 2. Recurring anomaly signals

[`backlog/recurring-detection.md`](backlog/recurring-detection.md) → *§2 only*.

Detection, listing and curation are already live; this is the payoff for substrate that exists. The four
signals: **upcoming**, **missed**, **new series detected**, **price change**. Additive, low blast
radius, and the most demonstrable thing in the backlog for a stranger reading the README.

**Not in scope:** §4 (fixed-vs-variable series and its price-increase review), which is marked phase 2
and overlaps the price-change signal without being needed by it.

*Owed decision:* whether all four signals ship or only **missed** and **price change** — the two that
motivated this. *New series detected* is cheap once the surface exists and catches the forgotten free
trial; *upcoming* is a forward view rather than an anomaly.

### 3. Cash-flow reporting

[`backlog/dashboard-reporting.md`](backlog/dashboard-reporting.md) → *cash-flow half only*.

Cash flow as a third frame on the Expenses/Income selector: a **Sankey** for a single period, diverging
bars plus a net line for trends. The design is settled and rests on the existing `exclude_from_totals`
flag rather than any new transfer-pairing or per-view exclusion machinery.

**Not in scope:** the Trends-tab double-count audit in the same file. It is gated on the Trends tab
gaining a tag-report selector, which is not part of this release. The two items are unrelated despite
sharing a file. The deferred `cash_date` phase stays deferred.

### 4. Vault recovery

[`backlog/vault-passphrase-recovery.md`](backlog/vault-passphrase-recovery.md).

Today a forgotten vault passphrase is an unhandled dead end with no endpoint and no UI. **Shipping that
to strangers is the sharpest gap in this list**: the first public user who sets a passphrase and forgets
it has no path at all, and the app does not even say so.

Minimum: the **destructive reset**, with the two paths the file now distinguishes — lost passphrase
versus compromise — including revocation on the way out driven by `revokes_on_disconnect`, and the
refusal rule scoped so it only applies to the lost-passphrase path.

*Owed decision:* whether **vault recovery codes** ship with it. They are prevention rather than cure,
they are cheap (`vault_slot.method` already generalizes), and they would leave a single-user install a
rung above "destroy it". Argument for including: reset is a bad first experience to hand a new user, and
recovery codes mean most never reach it. Argument against: it is net-new surface on the release path.

Also in this file and worth taking regardless, being small: `VaultDecryptError` is unclassified and
reports as a generic sync failure instead of "reconnect needed".

### 5. Streaming backup export

[`backlog/backup-restore-scope-and-secrets.md`](backlog/backup-restore-scope-and-secrets.md) → *The
export builds the whole backup in memory*.

`export_backup` assembles the entire payload as a Python structure, serializes it to one JSON string,
zips that into a `BytesIO`, and returns it as a single yield — so peak memory holds all of them at once,
and the encrypted path adds the ciphertext on top. **This already scales with the ledger and always
has**; documents would make it acute rather than causing it.

It is on this list because *"nothing should degrade as the transaction count grows"* is a project
principle — the list windowing exists for that reason — and because shipping documents on top of it
would turn a latent problem into a reported one. Rework both paths to stream to a temp file instead of
assembling in RAM, and drop the `indent=2` that inflates the largest string for a machine reader.

**Prerequisite for feature 1**, and worth doing regardless of it.

## Release mechanics

- **Test the Windows and Linux kits.** Only macOS has been exercised. Both are portable zips, so the
  test is: unzip, run, confirm the databases land beside the executable and the app opens.
- **Screenshots.** The README has none, and it is a dashboard-driven visual application whose whole job
  is letting someone decide quickly. This will cost more prospective users than any missing document.
  **Deliberately last, after every feature lands** — cash-flow reporting adds a whole dashboard frame
  and recurring anomalies change what the surfaces show, so anything shot earlier would be reshot.
- **Cut the release.** `docs/releasing.md` has the checklist. Note that CI does **not** publish —
  attaching the four artifacts and their `.sha256` files to a written release is a manual step, and
  nothing is downloadable until it happens.
- **Enable Discussions**, or drop that entry from `.github/ISSUE_TEMPLATE/config.yml`, which currently
  links to a page that will 404.
- **Correct the README's compromise paragraph** — the "if a database or backup is lost" text still says
  replacing the vault key helps, which `SECURITY.md` now correctly contradicts.

## Sequencing

1. **Streaming backup export (5) before receipts (1).** The storage decision is settled, but shipping
   documents onto an in-memory export is what would make that defect user-visible. Nothing else waits on
   either.
2. **The other three in any order** — they do not touch each other. Recurring anomalies are the cheapest and
   most visible; vault recovery is the one whose absence is a real hazard; attachments are the one the
   README already promises.
3. **Kit testing** — independent of the features, so it can happen whenever a build is convenient.
4. **Screenshots**, once every feature is in. See above: the visual surfaces change under two of them.
5. **Cut the release, attach the artifacts, flip visibility.**

## Deliberately not in this release

Named so they are not re-litigated under deadline pressure: transaction splits and reimbursable
expenses (splits is invasive cross-cutting reporting surgery — the wrong thing to have in flight while
strangers start reading the code), attachment tiers 2 and 3, the online categorizer, and everything else
in `docs/backlog/`.
