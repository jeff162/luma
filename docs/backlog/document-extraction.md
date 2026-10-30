# Reading receipts: searchable photos and itemized documents

## What it is

Receipts and invoices can be attached to a transaction, and the text of a digital PDF is searchable. A
photographed receipt is not, and nothing reads the line items out of a document. This project adds, in
stages:

- **Searchable photos and scans**, using OCR on the user's own machine.
- **Itemized documents**: line items read from an invoice (by an AI service the user configures, or
  exactly from the e-invoice data some PDFs carry), proposed for approval and able to pre-fill a split.
- **A storage view** showing what documents take up space, so the user can choose what to drop.

**Where it stands:** not started. The AI itemizer should be designed together with the online
categorizer, which needs the same plumbing.

What is built is in [`../data-model.md`](../data-model.md) → *Attached documents* and `architecture.md`
→ *Attached documents*.

## The tiers

Extraction is four capabilities with very different costs. Most of the searchability this feature
exists for comes from the first two, which need no network call and no configuration and are built.

| tier | what it does | cost | opt-in? |
| --- | --- | --- | --- |
| 0. Store | keep the file, show it, back it up | none | no (built) |
| 1. PDF text layer | the real text out of a digital PDF | pure-Python dependency | no (built) |
| 1b. Embedded e-invoice | read structured XML inside a Factur-X / ZUGFeRD PDF | trivial when present | no |
| 2. Local OCR | text out of a photographed receipt | a **system binary** | yes |
| 3. Configured extractor | structured line items | BYOK, per-call cost | yes, plus approval per result |

**Tier 1b is worth a probe because it costs almost nothing.** The B2B e-invoicing standards (Factur-X /
ZUGFeRD embed an XML payload in the PDF; UBL / PEPPOL are the interchange formats) give exact line items
by reading an attachment rather than interpreting a layout. Adoption is B2B and regional, so it will not
be the common household case, but where present it beats any extraction and detecting it is a file
probe. Confirm current adoption before going past the probe.

**Tier 2's obstacle is packaging, not code.** Tesseract is a system binary plus language data, not a pip
install, and bundling it into the standalone macOS and Windows builds is painful. Make it a **declared
capability**: available when the binary is present, absent otherwise, with the UI saying which. The
frozen build does not carry it.

**Two alternatives to tier 3 are closed.** Local document-understanding models (Donut / LayoutLM class)
need torch, which alone would dwarf the application and does not fit the standalone build.
Template-based tools (`invoice2data`-style) need a template per vendor: useless on an unseen vendor and
an unbounded maintenance set. There is no good open standard for structured extraction from arbitrary
receipts, which is why tier 3 is BYOK rather than a bundled dependency.

## Tier 3 shares a subsystem with the online categorizer

[`online-categorizer.md`](online-categorizer.md) is designed as: user-triggered because it calls an
external API, opt-in and privacy-sensitive, an LLM call with **structured output constrained to a
schema**, results reviewed rather than applied blindly, ending in existing storage.

Receipt itemization is the same design with a different schema. The two should share the opt-in surface,
credential storage, call plumbing, structured-output handling and review pattern, and be **designed
together**. Whichever is built first pays for the shared part, and the second is mostly a new schema and
a new review screen.

The adapter shape is the one data sources use ([`../building-a-connector.md`](../building-a-connector.md)):
a backend **declares its capabilities**, an unconfigured backend means the feature is simply not there,
and the user brings their own key. Opt-in then comes from the architecture instead of a check at every
call site.

**Approval needs no new design.** Extracted line items are proposed, never applied, and the import
rule-suggestion review, the money-movement review and the starter-rules approve-before-add list already
have that shape. Follow them rather than inventing a fourth review idiom.

**One decision comes first:** the extractor adapter's **capability vocabulary** (text only, line items,
or both, and how a partially capable backend degrades). It is the question `building-a-connector.md`
answered for providers, with the same trap: a capability that is really one backend's quirk.

## Phases

- **Phase 2: text and search.** Tier 2 as a declared capability. The search surface already exists (the
  `doc:` prefix in the Transactions search box), so this is extraction only.
- **Phase 3: itemization.** The tier-3 adapter and its approval screen, designed with the online
  categorizer.
- **Phase 4: feed the splits.** An approved itemization is the pre-fill
  [`../data-model.md`](../data-model.md) → *Transaction splits* wants, the way Amazon orders pre-fill from
  list prices. Last on purpose: splits are useful on their own, and coupling them to extraction early
  would hold a working feature hostage to an optional one. Tier 2 is also the precondition for
  suggesting multi-payment purchases automatically.

## The sizing assumption

The design assumes documents are attached *rarely*, for purchases worth looking back on (a car repair, a
house repair, an appliance under warranty), not a weekly grocery receipt. **Nothing enforces this and
nothing should**; someone will use it differently, and the design must not break for them.

The assumption explains several sizing decisions: no incremental backup, a full backup small enough to
upload on any schedule, a generous per-file cap, and ingest-time downscaling with no storage policy
behind it.

**The signal that it is wrong:** total document storage reaching a size where making or uploading a
backup is something to think about. The space-reclamation view below is where that should show.

**If it turns out wrong, nothing is redesigned.** Two items get promoted: incremental document backups
([`document-incremental-backups.md`](document-incremental-backups.md)) and the space-reclamation view.
The property to keep: a heavy user may be *inefficient*, never *broken*.

## Space reclamation: chosen, never scheduled

Show what storage is used and let the user decide: document storage broken down by age ("2.1 GB in
documents older than 10 years"), largest originals first, and which have extracted text that would
survive dropping the original. The action is explicit and per selection.

**Not on a timer** (delete originals after some age, keep the text). Digital PDFs are small with a
perfect text layer, so they are cheap to keep, and dropping one loses the layout that makes it evidence.
Photos and scans are the large files, but their text comes from OCR, the least reliable extraction, and
they are the documents whose original matters most for a warranty claim or a disputed charge. A timer
would delete exactly the originals whose text is least trustworthy. It also cuts against destructive
operations being rare, announced and reversible, and an older backup would restore files already
removed.

One piece is kept: **a choice at ingest**, for someone who knows when attaching that they only want the
document searchable: keep the original, or keep only the extracted text.

**Where the view lives is open.** It fits this feature, but it is equally database maintenance, and
Settings → Database already shows the state of the stored data (`../operations.md` → *Checking the
databases*), where it could sit beside the orphan-file reconciliation. Decide when either is built, and
build one, not two.

## Open questions

- **Can a document hang off an order or a link, not only a transaction?** `document.txn_id` covers
  transactions. The Amazon order model has a place where an invoice would fit, and the table can grow a
  second nullable reference.
- **Can one document cover several transactions** (one invoice, two card charges)? Not built. The digest
  recorded at ingest makes a second attach recognizable as the same file, so this can become a join table
  later without rewriting the store. Keep that property until someone wants it.
