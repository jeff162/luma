# Smaller backups when there are many attached documents

## What it is

Every backup holds everything: the ledger, the accounts and every attached document. If someone attaches
a lot of documents, every backup carries all of them again and gets large. This project lets documents be
backed up separately, so each regular backup carries only the documents added since the last document
backup.

**Where it stands:** designed, not started, and not needed yet. Documents are expected to be a small share
of a backup (the sizing assumption in [`document-extraction.md`](document-extraction.md) → *The
sizing assumption*). The backup history on Backup / Restore splits each backup's size into ledger,
accounts and documents, so the signal to start is visible there: documents becoming the bulk of every
backup.

## Shape

- **Document-only backups**, each written as its own file.
- **A data backup carries only the documents added since the last document-only backup.** The ledger and
  the accounts part are always sent whole: the ledger is mutable anywhere in its history and small once
  zipped (`scale-and-limits.md` → *Obstacles*).
- **The document-only backups form a series**, each holding what was attached since the one before.

## Why it restores cleanly

Restore is wipe-and-rebuild with no merge mode. Documents still fit an incremental scheme because they
never change once written and are addressed by id:

- **The data backup decides which documents belong.** Its `document` rows name every file with its
  digest. The document backups are only a store to draw from, so the order they are applied in does not
  matter, and a file whose row is gone is ignored.
- **A deletion needs no tombstone.** A deleted document is absent from the data backup's rows, so its
  file in an older document backup is never used.
- **A missing piece can be named.** The rows say exactly which documents are needed, so a restore can
  list the document backups it still lacks instead of failing silently. The documents phase of a restore
  is already resumable on the same comparison.
- **A series belongs to one backup identifier.** Every restore gives the system a new `instance_id`, so a
  document backup made before a restore is not part of any later series, and the first data backup after
  a restore carries every document.

## Not a substitute

A date-windowed backup ("the past year") is a slice, useful for export or sharing, not for disaster
recovery. `txn` has no `updated_at`, so a window by transaction date misses an old row changed recently,
and an additive file cannot express a deletion.
