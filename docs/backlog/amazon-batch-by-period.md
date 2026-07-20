# Amazon import — batch by period, not by drop

**Status: noted, not started (2026-07-19).** A design wart surfaced while scoping the general CSV
multi-file selector; captured here so it isn't lost. Not blocking that work.

## The issue

`run_amazon_import` creates **one `import_batch` per drop** — a single batch and a single file card for
*every* file handed in at once, regardless of how many order-history periods they span
([`amazon.py` batch creation](../../backend/routers/import_export/amazon.py)). This is **correct** for the
core pairing it was built around: an **orders** file and its **items** file for the same period are two
halves of one dataset (joined on `order id`, the items file enriching the order rows), so they belong on
the same card. But the same "one batch per drop" rule also bundles *unrelated periods* onto one card:
drop 2023-orders + 2023-items + 2024-orders + 2024-items and you get a single card mixing two years.

So the batching key conflates two different groupings:

- the **legitimate** one — pair the two halves (orders + items) of a single period, and
- the **accidental** one — "everything I happened to drag in at once."

## Contrast with CSV (why this is Amazon-specific)

The general CSV importer batches by **file** — one `import_batch` per `run_import` call, so one card per
file, each with its own coverage window / dedup / undo / provenance. The multi-file CSV selector
(in progress) deliberately preserves that: N files → N cards. Amazon is the outlier because its unit was
taken to be the *drop* rather than the *coherent order-set*.

## Direction (not yet designed in detail)

Batch Amazon by **coherent period / order-set** instead of by drop: group the dropped files by their
period (pairing an orders file with the items file of the same span), and create **one batch per
period**, splitting distinct spans onto their own cards — while still keeping orders+items of the *same*
period together. Open questions when picked up:

- What defines a "period" for batching — the file's own year/range (AZAD exports one file per
  `kind × year`), or the actual date span of the rows it carries? The per-file year is the simpler,
  stable key and matches how AZAD exports.
- How the orders↔items pairing is expressed once a drop can span several periods (today both halves land
  in the one batch; period-batching needs each items file routed to its period's batch).
- Reconciliation, the import-detail report, per-file hashes, and undo are all currently keyed on the
  single batch — each would move to per-period batches (mostly mechanical, but the reconciliation report
  is batch-scoped today).
- Interaction with the existing per-file re-import skip (`amazon_file_hashes`) — already per-file, so it
  largely carries over.

## Reuse / where it lives

`routers/import_export/amazon.py` (`run_amazon_import`, `_read_amazon_uploads`, the reconciliation +
import-detail reports). No frontend model change beyond the history rendering, which already lists
marketplace batches as cards (`MarketplaceImportHistory`).
