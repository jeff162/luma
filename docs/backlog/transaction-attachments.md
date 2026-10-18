# Attached documents — extraction tiers 2–4

**Phase 1 shipped 2026-08-24; phases 2–4 have not started.** Attaching, viewing, storing, backing up
and searching a document — the `document` table, the on-disk store, the format-agnostic ingestion seam
(file, paste, the `text/html` flavour, a saved `.eml`), tier-1 PDF text extraction with its FTS5 index,
the shared `DropZone` / `DocumentsPanel` / `DocumentViewerDialog`, the ledger document marker, and the backup
and resumable-restore halves — are all live. The durable record is in
[`../data-model.md`](../data-model.md) → *Attached documents* (write order, the digest, downscaling, the
per-file cap, what the backup carries) and `architecture.md` → *Attached documents*, with the client-side
backup blob recorded as an obstacle in [`../scale-and-limits.md`](../scale-and-limits.md).

What remains is the extraction ladder above tier 1, and the storage view that goes with it.

## The tiers, and why most of the value is already banked

Extraction is not one capability but four with very different costs, which is the whole reason for the
tiering: the searchability this feature exists for is mostly reachable with no network call and no
configuration, and tiers 0–1 are shipped.

| tier | what it does | cost | opt-in? |
| --- | --- | --- | --- |
| 0. Store | keep the file, show it, back it up | none | no — always on (**shipped**) |
| 1. PDF text layer | pull the real text out of a digital PDF | pure-Python dep | no — nothing leaves the machine (**shipped**) |
| 1b. Embedded e-invoice | read structured XML inside a Factur-X / ZUGFeRD PDF | trivial when present | no |
| 2. Local OCR | text out of a photographed receipt | a **system binary** | yes |
| 3. Configured extractor | line items, structured | BYOK, per-call cost | yes, plus per-result approval |

**Tier 1b is worth a probe because it costs almost nothing.** The B2B e-invoicing standards (Factur-X /
ZUGFeRD embed an XML payload inside the PDF; UBL / PEPPOL are the interchange formats) give perfect line
items by reading an attachment rather than interpreting a layout. Adoption is B2B and region-specific so
it will not be the common household case, but where present it is strictly better than any extraction
and detecting it is a file probe. Confirm current adoption before investing past the probe.

**Tier 2's obstacle is packaging, not code.** Tesseract is a system binary plus language data, not a pip
install, so bundling it into the standalone macOS/Windows artifacts is genuinely painful. The honest
shape is a **declared capability** — available when the binary is present, absent otherwise, with the UI
saying which. Do not make the frozen build carry it.

**Two alternatives to tier 3 are closed.** *Local document-understanding models* (Donut / LayoutLM class)
want torch, which alone would dwarf the whole application — the backend runtime is ten small packages —
and is incompatible with the standalone build shape. *Template-based open source* (`invoice2data`-style)
is a template per vendor: good where one exists, useless on an unseen vendor, and an unbounded
maintenance set. For structured extraction from arbitrary receipts there is no good open standard, which
is exactly why tier 3 is BYOK rather than a bundled dependency.

## Tier 3 shares a subsystem with the online categorizer

**The finding most worth not losing.** [`online-categorizer.md`](online-categorizer.md) is already
designed as: user-triggered because it hits an external API, opt-in and privacy-sensitive, an LLM call
with **structured output constrained to a schema**, results presented for review rather than applied
blindly, terminating in existing storage rather than inventing its own.

Receipt itemization is that same design with a different schema. The two should share the opt-in surface,
the credential storage, the call plumbing, the structured-output handling and the review pattern, and
should be **designed together** rather than growing two parallel versions — whichever is built first pays
for the seam and the second is mostly a new schema and a new review screen. That materially changes what
the parked categorizer costs, and is the reason to treat these as one initiative when either comes into
focus.

The adapter shape is the one the repo already uses for data sources (see
[`../building-a-connector.md`](../building-a-connector.md)): a backend **declares its capabilities**, an
unconfigured backend means the feature quietly is not there, and the user brings their own key. Opt-in
then falls out of the architecture instead of being a checkbox every call site has to honor.

**Approval needs no design.** Extracted line items are proposed, never applied — and the import
rule-suggestion review, the money-movement review and the starter-rules approve-before-add list are all
already that shape. Follow them; do not invent a fourth review idiom.

**One prerequisite decision is still open:** the extractor adapter's **capability vocabulary** —
text-only vs line-items vs both, and how a partially-capable backend degrades. It is the same question
`building-a-connector.md` had to answer for providers, and carries the same trap: a capability that is
really one backend's quirk.

## Phases

- **Phase 2 — text and search.** Tier 2 as a declared capability. The search surface already exists (the
  `doc:` prefix in the Transactions search box), so this is extraction only.
- **Phase 3 — itemization.** The tier-3 adapter and its approval screen, designed jointly with the
  online categorizer.
- **Phase 4 — feed the splits.** An approved itemization is exactly the pre-fill
  [`../data-model.md`](../data-model.md) → *Transaction splits* wants, the way Amazon orders pre-fill
  from list prices. Deliberately last: splits are independently useful, and coupling them to extraction
  early would hold a working feature hostage to an optional one. Tier 2 is also the named precondition
  for automatic multi-payment suggestion.

## The sizing assumption, and the signal that it is wrong

**Recorded as an assumption, not a requirement.** The design intent is that documents are attached
*rarely*, for purchases worth looking back on — a car repair, a house repair, a warranty-relevant
appliance — not for a weekly grocery receipt. **Nothing enforces this and nothing should**; somebody will
use it differently, and a design that assumed rarity as a constraint would break for them.

What the assumption does is explain the sizing of decisions that would otherwise look arbitrary, and it
is the single thing they all rest on: no incremental or windowed backup is needed, a full backup stays
small enough to upload on any schedule, a generous per-file cap is harmless because the aggregate is
small either way, and ingest-time downscaling suffices with no storage policy behind it.

**What to watch for:** total document storage reaching a size where producing or uploading a backup is
something the user has to think about. That is the falsification signal, and it belongs in the
space-reclamation view below rather than waiting for a complaint.

**If it turns out wrong, nothing is redesigned** — three already-identified items get promoted: the
streaming backup export (done), **incremental document backups** in
[`document-incremental-backups.md`](document-incremental-backups.md) (additive-only, and tractable
precisely because documents are immutable), and the space-reclamation view. The property worth
preserving in any further decision here: let a heavy user be *inefficient*, never *broken*.

## Space reclamation — chosen, never scheduled

Show what storage is being used and let the user decide: total document storage broken down by age
("2.1 GB in documents older than 10 years"), largest originals first, and which ones have extracted text
that would survive dropping the original. The action is explicit and per-selection. Maybe they keep
everything, which is fine.

**Rejected: sunsetting originals on a timer** (delete after some age, keep the extracted text). The
economics run backwards. Digital PDFs are 100–500 KB with a *perfect* text layer — cheap to keep, and
discarding one loses the itemization layout and letterhead that make it evidence rather than a
paraphrase. Photos and scans are the megabyte files, but their text comes from OCR, the least reliable
extraction, and they are exactly the documents whose original matters most for a warranty claim or a
disputed charge. A timer preferentially deletes the originals whose text substitutes are least
trustworthy. It also collides with the stated principle that destructive operations are rare, announced
and reversible, and it interacts badly with backups, since an older backup restores files already
sunset.

One thing is kept from the idea: **a choice at ingest**, for someone who knows at the moment of
attaching that they only want the document searchable — keep the original, or keep only the extracted
text. Explicit, and costs nothing.

**Where the view lives is open.** It fits this feature, but it is equally a *database maintenance*
surface, and [`database-diagnostics.md`](database-diagnostics.md) is already the home for "what is the
state of the stored data" — which would also let it sit beside the orphan reconciliation that the
file-versus-row write order makes possible. Decide when either is built; do not build two.

## Open questions

- **Can a document hang off an order or a link, not only a transaction?** Phase 1 answered the first half
  (`document.txn_id`) and left the order case unbuilt rather than refused. The Amazon order model has a
  place where an invoice would fit, and the table can grow a second nullable reference.
- **Can one document cover several transactions** (one invoice, two card charges)? Deliberately not
  built. The digest recorded at ingest means a second attach is *recognizable* as the same file, so this
  can become a join table later without rewriting the store — which is the property worth preserving
  until someone actually wants it.

## Cross-refs

- [`online-categorizer.md`](online-categorizer.md) — the shared opt-in / LLM / approval subsystem
- [`document-incremental-backups.md`](document-incremental-backups.md) — incremental document backups
- [`database-diagnostics.md`](database-diagnostics.md) — the other candidate home for reclamation
- [`../building-a-connector.md`](../building-a-connector.md) — the capability-declaration pattern to copy
