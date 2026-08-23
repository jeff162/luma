# Transaction attachments — receipts, invoices, and the text inside them

**Status: backlog, not started (2026-08-20).** A transaction records that money moved and where it went;
it does not record *what was bought*. For most rows nobody cares — nobody is going to attach a grocery
list. For the ones where it matters (a car repair bill, a service invoice, a warranty-relevant purchase)
the useful fact — what was actually done to the car — exists only on a document the app has never seen.
This is the note for letting that document be attached, viewed, and where possible searched.

## What this is, and the thing it is not

**One ingestion seam, many sources.** A receipt arrives as a phone photo, a PDF emailed by a garage, a
screenshot, or text pasted out of a mail client. After ingestion none of that matters: every path
produces *(bytes, mime type, original filename)* and the rest of the feature reads only that. The point
of listing the formats is that the seam has to be format-agnostic, **not** that several integrations are
needed.

**Email is copy/paste, not a mailbox.** Explicitly out of scope: IMAP polling, a receiving address,
OAuth against a mail provider, anything that stores mail credentials. Pasting an image or text from the
clipboard is a paste target on the attach control, and it is the whole of the email story. This keeps
the feature clear of the vault and of any background fetching subsystem.

## Tiers — and most of the value lands in the free ones

Extraction is not one capability; it is four with very different costs. The tiering matters because the
*searchability* the feature is for is mostly reachable without any network call or configuration.

| tier | what it does | cost | opt-in? |
| --- | --- | --- | --- |
| 0. Store | keep the file, show it, back it up | none | no — always on |
| 1. PDF text layer | pull the real text out of a digital PDF | pure-Python dep | no — nothing leaves the machine |
| 1b. Embedded e-invoice | read structured XML inside a Factur-X / ZUGFeRD PDF | trivial when present | no |
| 2. Local OCR | text out of a photographed receipt | a **system binary**, see below | yes |
| 3. Configured extractor | line items, structured | BYOK, per-call cost | yes, plus per-result approval |

**Tier 1 is the biggest single win and it is nearly free.** A digital invoice — the emailed garage bill,
most utility and service invoices — already carries a real text layer; no OCR is involved. `pypdf` /
`pdfplumber` are pure Python, small, and bundle cleanly into the frozen builds. This delivers "the
receipt text is searchable" for the whole class of documents that arrive as PDFs, with no configuration
and no privacy question to ask.

**Tier 1b is worth a capability check because it costs almost nothing.** The B2B e-invoicing standards
(Factur-X / ZUGFeRD embed an XML payload inside the PDF; UBL / PEPPOL are the interchange formats) give
perfect line items by reading an attachment rather than interpreting a layout. Adoption is B2B and
region-specific, so this will not be the common case for household documents — but where it is present
it is strictly better than any extraction, and detecting it is a file probe. Confirm current adoption
before investing beyond the probe.

**Tier 2's obstacle is packaging, not code.** Tesseract is a system binary plus language data, not a pip
install, so bundling it into the standalone macOS/Windows artifacts is genuinely painful. The honest
shape is a **declared capability**: available when the binary is present on the machine, absent
otherwise, with the UI saying which. Do not make the frozen build carry it.

**Local document-understanding models are out.** Donut / LayoutLM-class models want torch, which alone
would dwarf the entire application (the backend runtime is currently ten small packages) and is
incompatible with the standalone build shape. This is not a close call.

**Template-based open source is a maintenance trap.** `invoice2data`-style tooling is a template per
vendor: good where a template exists, useless on an unseen vendor, and the template set is unbounded
maintenance. Wrong end of the effort curve for arbitrary household documents.

So: for *structured* extraction from arbitrary receipts there is no good open standard. Format-agnostic
extraction is what vision LLMs are actually good at, which is why tier 3 is BYOK rather than a bundled
dependency — and why the tiering matters, since most users never need to reach it.

## Tier 3 shares a subsystem with the online categorizer

**This is the finding most worth not losing.** [`online-categorizer.md`](online-categorizer.md) is
already designed as: user-triggered because it hits an external API, opt-in and privacy-sensitive, an
LLM call with **structured output constrained to a schema**, results presented for review rather than
applied blindly, terminating in existing storage rather than inventing its own ("the rule is the cache").

Receipt itemization is that same design with a different schema. The two should share the opt-in
surface, the credential storage, the call plumbing, the structured-output handling, and the review
pattern — and they should be designed together rather than growing two parallel versions. Whichever is
built first pays for the seam; the second becomes mostly a new schema and a new review screen. That
materially changes what the parked categorizer costs, and it is a reason to treat these as one
initiative when either comes into focus.

The adapter shape is the one the repo already uses for data providers (see
[`../building-a-connector.md`](../building-a-connector.md)): an extraction backend **declares its
capabilities**, an unconfigured backend means the feature quietly is not there, and the user brings
their own key. Opt-in falls out of the architecture instead of being a checkbox that has to be honored
by every call site.

## Approval — reference implementations already exist

Extracted line items are proposed, never applied. This does not need designing: the import
rule-suggestion review, the money-movement review, and the starter-rules approve-before-add list are all
the same shape — machine proposes, user approves, the approved result becomes durable local data — and
`data-model.md` states the stance outright for the bulk paths ("neither bulk path applies blindly").
Follow those; do not invent a fourth review idiom.

## Prerequisite decisions — settle these before writing code

1. ~~**Where attachments live: database blob or filesystem.**~~ **SETTLED 2026-08-21** — files on disk
   under `DATA_DIR`, carried inside the backup zip as members. See *Settled: storage, sizing, and what
   the backup carries* below, which also resolves the portable-vs-installed question for free.
2. **What "searchable" means concretely.** Extracted text has to be reachable from somewhere. There is
   no full-text search surface today beyond the quick-filter, so this is a real decision: extend the
   existing filter, or introduce FTS over attachment text as its own surface. Sizing this is part of
   scoping tier 1, not a later refinement.
3. **The extractor adapter's capability vocabulary** — text-only vs line-items vs both, and how a
   partially-capable backend degrades. Same question `building-a-connector.md` had to answer for
   providers, and the same trap: a capability that is really one backend's quirk.

## Settled: storage, sizing, and what the backup carries (2026-08-21)

Decision 1 below is resolved. The rest of this section records what fell out of settling it.

### The assumed usage — and what happens if it is wrong

**Recorded as an assumption, not a requirement.** The design intent is that documents are attached
*rarely*, for purchases worth looking back on: a car repair, a house repair, a jewellery purchase, a
warranty-relevant appliance. Not day-to-day living, and emphatically not a grocery receipt every week.

**Nothing enforces this and nothing should.** Somebody else will use it differently, and a design that
assumed rarity as a constraint would break for them. What the assumption does is explain the *sizing* of
several decisions that would otherwise look arbitrary, and it is the single thing they all rest on:

- no incremental or windowed backup is needed;
- a full backup stays small enough to upload on whatever schedule the user likes;
- a generous per-file cap is harmless, because the aggregate is small either way;
- ingest-time downscaling is sufficient on its own, with no storage policy behind it.

**What to watch for:** total document storage growing to a size where producing or uploading a backup is
something the user has to think about. That is the falsification signal, and it is worth surfacing in the
space-reclamation view below rather than waiting for a complaint.

**If it turns out wrong**, the architecture holds and three already-identified items get promoted rather
than anything being redesigned: the **streaming backup export** (which is being done regardless), the
**document delta** in
[`backup-restore-scope-and-secrets.md`](backup-restore-scope-and-secrets.md) — additive-only and
tractable precisely because documents are immutable — and the **space-reclamation view**. That is the
useful property to preserve when making further decisions here: let a heavy user be *inefficient*, never
*broken*.

### Files on disk under `DATA_DIR`, carried inside the backup zip

**Not blobs in the database.** The backup payload is JSON, so a blob would have to be base64'd into it —
a third larger, and a receipt that has to be held whole in memory to be encoded. Files on disk keep bytes
out of the JSON entirely, which is what lets both directions copy them straight between disk and zip
member with a fixed buffer, at any size.

**Not loose files outside the backup either.** The backup is *already* a zip of many members — one per
payload section since version 10, plus `manifest.json` + `payload.bin` on the encrypted path — so
documents ride as additional members. No new container, no base64, and the "your backup silently omits
your receipts" failure never exists.

Three things this settles for free:

- **Portable versus installed needs no answer.** `DATA_DIR` already anchors both databases, so
  `DATA_DIR/documents/` inherits the rule — beside the executable in a portable kit, in the per-OS user
  directory on macOS — and **Settings → Configuration** already reports the directory in force.
- **Which backup they ride is unambiguous.** Documents are transaction detail, not credentials, so they
  belong to the **Financial data** bucket in
  [`backup-restore-scope-and-secrets.md`](backup-restore-scope-and-secrets.md) — the backup people
  actually take.
- **Destructive restore already has the right shape.** Restore wipes and rebuilds; clearing and
  rewriting the documents directory from the zip is consistent with that, not a special case.

Consequences to handle when building:

- **Write order.** File and row cannot be one transaction. Write the file first, then the row: a file
  with no row is inert litter, a row with no file is a broken link on screen. Write to a temporary name
  and `os.replace()` into place, so a torn write is never mistaken for a complete file — the same rule
  the restore's documents phase depends on. Drift is still possible
  in both directions, which makes this a second consumer of
  [`database-diagnostics.md`](database-diagnostics.md) — precisely the class of semantic inconsistency
  the SQLite pragmas call "ok".
- **A digest per document, recorded at ingest.** `document.sha256` is not bookkeeping — it is what lets a
  restore tell a complete file from a torn one and resume the documents phase after a failure, what makes
  the backup's integrity check cover the files rather than only the JSON, and what the parked document
  delta needs to ask whether the far side's copy is intact. Settled with the backup work
  (2026-08-23) because that work depends on it; recorded here because this is the code that must produce
  it. It is also the natural key for noticing that the same receipt was attached twice.
- **Payload version 9 → 10 is bumped by the streaming backup work, not by this feature.** That work
  restructures the envelope into `meta.json` + `sections/<name>.ndjson` + `documents/<id>` for its own
  reasons (see [`backup-restore-scope-and-secrets.md`](backup-restore-scope-and-secrets.md) → *Streaming
  both directions*), and lands the container documents were always going to need. What remains here is
  additive: the table, and the files as members. Register the migration last, per the usual sequencing.
- **Documents are stored in the zip, not deflated.** JPEG, PNG and PDF payloads are already compressed;
  deflating them spends CPU for nothing while the ledger sections keep compressing ~10:1.
- **Restore's documents phase is resumable and sweeps last.** Files are outside the SQL transaction, so
  the restore carries a `restore_state` marker committed atomically with the ledger, writes each document
  in place, and only then removes files the restored ledger no longer references. An interrupted restore
  therefore leaves litter rather than lost originals, and resumes by comparing the ledger's digests
  against the directory. The design is in the backup file; what this feature owes it is the digest above.
- **The browser is the last place a whole backup is resident, and documents are what make that matter.**
  Both server directions stream, but `downloadUrl` (`lib/api.js`) fetches the artifact into a Blob before
  saving it, so the client holds the whole thing. That is irrelevant for a ledger-only backup — measured at
  4.9 MB for ~18,500 transactions, and roughly 50 MB extrapolated to 200k — and becomes the binding
  constraint only once documents dominate the size. Browsers page large blobs to disk, so the curve is
  sluggish before it is fatal, but a tab dying while saving a backup is *broken* rather than merely
  inefficient, which is the line this feature's sizing assumption promises not to cross.
  **The blob is deliberate and the fix is not simply "navigate instead":** a plain navigation hands the
  response to the browser, so an error status renders as raw JSON with the app gone from under it — which
  is why the fetch-and-save exists. The way out is to *preflight* the conditions this endpoint can fail on
  (no enabled recipients being the main one) and then navigate, letting the browser stream to disk with its
  own progress UI; or to pipe the response body through the File System Access API, which is better still
  and Chromium-only. Note that until one of those lands, the `Content-Length` the export now sends buys
  nothing visible: saving a finished blob gives the browser no streaming download to draw a bar for.
- **The noun "attachment" is taken.** It already means *tag attachment* in the restore-ordering prose in
  `data-model.md` ("tag definitions before any attachment"). Call these **documents** — it also reads
  better for a repair invoice. This file keeps its name for continuity; the code should not.

### Downscale images at ingest

A receipt photographed at 12 MP is ~4 MB; re-encoded at ~1600px on the long edge at JPEG q80 it is
~300 KB, still legible and still fine for OCR, which gains nothing above roughly 300 DPI at text size.
That is better than a 10× reduction and it is worth doing **on its own merits** — there is no reason to
keep a 12 MP original of a receipt — independently of any storage pressure.

Adds **Pillow** as a dependency (accepted). It bundles with PyInstaller, so the kits are unaffected. The
re-encode is deliberately lossy and one-way at ingest.

PDFs pass through unchanged: re-rendering needs far more machinery, and digital invoices are small
anyway. The per-file cap is what covers a pathological scan.

### A per-file cap, generous rather than rationing

Around 25 MB, applied to everything, mostly biting scanned PDFs. It exists to stop pathology, not to
ration — **a cap that rejects is a dead end** for someone photographing a receipt with the phone they
own, which is the other reason images are downscaled rather than refused.

### Do not sunset originals on a timer

Considered and rejected: deleting originals after some age, keeping the extracted text. **The economics
run backwards.** Digital PDFs are 100–500 KB with a *perfect* text layer — cheap to keep, and discarding
one loses the itemization layout and letterhead that make it evidence rather than a paraphrase. Photos
and scans are the megabyte files, but their text comes from OCR, the least reliable extraction, and they
are exactly the documents whose original matters most for a warranty claim or a disputed charge. A
timer would preferentially delete the originals whose text substitutes are least trustworthy.

It also collides with a stated design principle — destructive operations are rare, announced and
reversible — and interacts badly with backups, since an older backup restores files that were already
sunset.

Two things are kept from the idea:

- **A choice at ingest**, for someone who knows at the moment of attaching that they only want it
  searchable: keep the original, or keep only the extracted text. Explicit, and costs nothing.
- **A user-driven cleanup view**, on the user's own schedule rather than a policy — see below.

### Space reclamation, chosen not scheduled

Show what storage is actually being used and let the user decide: total document storage, broken down
by age ("2.1 GB in documents older than 10 years"), largest originals first, and which ones have
extracted text that would survive dropping the original. The action is explicit and per-selection.
Maybe they want to keep everything, which is fine; maybe they do not, which is also fine.

**Where it lives is open.** It fits this feature, but it is equally a *database maintenance* surface,
and [`database-diagnostics.md`](database-diagnostics.md) is already the home for "what is the state of
the stored data" — which would also let it sit beside the orphan reconciliation the write-order note
above requires. Decide when either is built; do not build two.

## Phases

- **Phase 1 — attach and view.** The ingestion seam (file drop, clipboard paste), storage per the
  decision above, a viewer, attachment count/indicator on the transaction, and the backup story. Plus
  tier 1 PDF text extraction, which is cheap enough to belong here rather than in a later phase.
- **Phase 2 — text and search.** Tier 2 as a declared capability; the search surface from decision 2.
- **Phase 3 — itemization.** The tier-3 adapter with its approval screen, designed jointly with the
  online categorizer.
- **Phase 4 — feed the splits.** An approved itemization is exactly the pre-fill
  [`transaction-splits.md`](transaction-splits.md) wants, the same way Amazon orders pre-fill from list
  prices. Deliberately last: splits are independently useful, and coupling them to extraction early
  would hold a working feature hostage to an optional one.

## Open questions

- Multiple attachments per transaction, or one? (Assume many; a repair can arrive as an estimate plus a
  final invoice.)
- Do attachments survive the transaction being trashed, and what does restore-from-trash bring back?
- Size caps, and what the app does with a 40 MB scan — refuse, downscale, or accept.
- Does an attachment belong to a transaction only, or can it hang off an order/link (the Amazon
  order model already has a place where an invoice would fit)?
- Is there a path for the same document to cover several transactions (one invoice, two card charges)?

## Cross-refs

- [`online-categorizer.md`](online-categorizer.md) — the shared opt-in/LLM/approval subsystem
- [`backup-restore-scope-and-secrets.md`](backup-restore-scope-and-secrets.md) — blocks decision 1
- [`transaction-splits.md`](transaction-splits.md) — the phase-4 consumer
- [`../building-a-connector.md`](../building-a-connector.md) — the adapter/capability pattern to copy
- [`deployment-topologies.md`](deployment-topologies.md) — where a filesystem store would live
