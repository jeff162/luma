# Backup scope: restoring an incremental chain

**What is left is the incremental chain.** The backup — always everything, the financial data and the
accounts & secrets, with the restore choosing which to put back — is built, and what a backup is and how
it moves is in the topic docs: the archive
layout, streaming, the encrypted envelope, referential repair and the resumable documents phase in
[`../data-model.md`](../data-model.md) → *Backups*; restore as a destructive operation in
[`../operations.md`](../operations.md); why a bulk operation must not hold rows as a list in
[`../scale-and-limits.md`](../scale-and-limits.md); and what a backup exposes, why the accounts part
replaces rather than merges, and why the passphrase rule holds for every copy in
[`../security-model.md`](../security-model.md) → *Secrets in backup and export*.

## Restoring an incremental chain

The **document delta** — send only the ids the target lacks — is the tractable half, and both its
prerequisites already exist (members addressed by id, a digest each); the ledger needs no delta because it
is small once zipped and is always sent in full. What is unsolved is restoring the *chain*: the
compatibility guard's `instance_id` / `schema_version` checks would have to apply across files, and restore
is wipe-and-rebuild with **no merge mode** — "restore on top" today means restoring into a non-empty
database, which still replaces it. The reasoning behind the ledger-vs-documents decomposition is in
[`../scale-and-limits.md`](../scale-and-limits.md) → *Obstacles*.

A date-windowed backup is **not** a substitute and must not be sold as one. `txn` has no `updated_at`, so
a "past year" backup slices by *transaction date*, not by when a row changed: a 2019 charge recategorized
this morning is absent from it, so full-plus-incremental restores the stale 2019 categorization, and a 2019
row trashed today is absent too — an additive incremental cannot express a deletion at all. Date-windowed
is a **slice**, useful for export or sharing, and not a basis for disaster recovery.

## Cross-refs

- [`transaction-attachments.md`](transaction-attachments.md) — the document delta's other consumer, and
  the sizing assumption that decides whether it is ever needed
- [`import-history-windowing.md`](import-history-windowing.md) — unrelated scope, same page
