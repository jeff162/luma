# Incremental backups for attached documents

**Design only, not started, and not needed yet.** Every backup today is everything: the ledger, the
accounts part and every attached document. That stays right while documents are a small share of a
backup, which is the sizing assumption in [`transaction-attachments.md`](transaction-attachments.md) →
*The sizing assumption*. The backup history on Backup / Restore records each backup's size split into
ledger, accounts and documents, so the signal to start this is visible there: documents becoming the
bulk of every backup, to the point where making or keeping one is something to think about.

## The shape

- **Document-only backups.** A backup of the documents alone, written as its own file.
- **A data backup carries only the documents added since the last document-only backup.** The ledger
  and the accounts part are always sent whole: the ledger is mutable anywhere in its history and small
  once zipped, so it needs no delta (`scale-and-limits.md` → *Obstacles*).
- **The document-only backups form a series**, each holding what was attached since the one before.

## Why it restores cleanly

Restore is wipe-and-rebuild with no merge mode, which is what made a general incremental chain
unbuildable. Documents avoid the problem because they never change once written and are addressed by id:

- **The data backup decides which documents belong.** Its `document` rows name every file with its
  digest. The document backups are only a store of files to draw from, so the order they are applied in
  does not matter, and a file whose row is gone is ignored.
- **A deletion needs no tombstone.** A deleted document is absent from the data backup's rows, so a copy
  of its file in an older document backup is simply never used.
- **A missing link can be named.** The rows say exactly which documents are needed, so a restore can list
  the document backups it still lacks instead of failing silently. The documents phase of a restore is
  already resumable on this same comparison ("what does the ledger name that the directory lacks").
- **A series belongs to one backup identifier.** Every restore gives the system a new `instance_id`, so a
  document backup made before a restore is not part of any series after it, and the first data backup
  after a restore has to carry every document.

## What is not a substitute

A date-windowed backup ("the past year") is a slice, useful for export or sharing, and not a basis for
disaster recovery. `txn` has no `updated_at`, so a window by transaction date misses an old row changed
recently, and an additive file cannot express a deletion.

## Cross-refs

- [`transaction-attachments.md`](transaction-attachments.md) — the sizing assumption this rests on, and
  the space-reclamation view that answers the same signal from the storage side
