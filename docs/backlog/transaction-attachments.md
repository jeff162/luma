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

1. **Where attachments live: database blob or filesystem.** This is not an implementation detail. It
   lands directly on [`backup-restore-scope-and-secrets.md`](backup-restore-scope-and-secrets.md), whose
   whole subject is making each backup's *scope* explicit — a backup that silently omits every receipt
   is exactly the data-loss surprise that file exists to prevent. That item's phase-6 gate is now met,
   so the sequencing is natural. Decide attachment storage **as part of** the backup-scope work, not
   after it. A filesystem store also raises where the directory lives under the portable-vs-installed
   rule in [`deployment-topologies.md`](deployment-topologies.md).
2. **What "searchable" means concretely.** Extracted text has to be reachable from somewhere. There is
   no full-text search surface today beyond the quick-filter, so this is a real decision: extend the
   existing filter, or introduce FTS over attachment text as its own surface. Sizing this is part of
   scoping tier 1, not a later refinement.
3. **The extractor adapter's capability vocabulary** — text-only vs line-items vs both, and how a
   partially-capable backend degrades. Same question `building-a-connector.md` had to answer for
   providers, and the same trap: a capability that is really one backend's quirk.

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
