# Backup scope & the accounts-and-secrets artifact

**The secrets half shipped; the scope/UX half has not started.** Everything about *what a backup is and
how it moves* is settled and lives in the topic docs: the payload-version-12 envelope, streaming in both
directions, the incremental cipher, referential repair, `restore_state` and the resumable documents phase
are in [`../data-model.md`](../data-model.md) → *Backups*; restore as a destructive operation — including
why a restore covers one of the two databases and what that does to the perimeter — is in
[`../operations.md`](../operations.md); why a bulk operation must not hold rows as a list and the
ledger-vs-documents decomposition are in [`../scale-and-limits.md`](../scale-and-limits.md); and secret custody, the coupling between the two
databases, and what a leaked backup actually exposes are in
[`../security-model.md`](../security-model.md).

What remains is one artifact that does not exist and one flow that was decided but never built.

## The artifact: back up by what it protects

Today's Backup page offers backups whose *scope* is implicit, which is what makes the two-database split
surprising. The proposed shape names each backup by what it protects and says which database file(s) it
covers:

- **Financial data** — the data DB minus tokens. The shareable, low-sensitivity one. **Exists.**
- **Accounts & secrets** — the control DB (identities, sign-in settings, `vault_slot`) **plus** the data
  DB's token ciphertext, restorable *and syncable* as a unit. The credentials half of this exists; the
  identity half does not.
- **Back up all** — one **sectioned file** (`data` / `identity` / `vault+tokens` sections) rather than
  several files, so pieces that must travel together stay in one artifact while selective restore stays
  possible.

**Why it must be one artifact rather than two, and why that is a requirement rather than a naming
choice:** the token ciphertext lives in the data DB and the key that decrypts it (`vault_slot`) lives in
the control DB. That split *is* the leaked-DB-≠-leaked-tokens property. A data-only backup therefore
carries tokens that are **dead on arrival** anywhere else, and a snapshot that can actually sync after
restore needs the ciphertext **and** the vault slots **and** a user who still knows the vault passphrase.
Any design that separates them produces a file that restores and cannot sync.

## The flow: restore-time identity reconciliation

Decided in discussion, never built. Where a restore includes identity/control data, restore **asks how to
reconcile identities** rather than silently overwriting the perimeter: restoring requires the current user
to be an **admin**, the flow **lists the accounts in the backup file**, and the default reconciliation
**preserves the current admin** — remove all identities except the current admin, then merge the backup's
accounts in (equivalently: restore everything, then recreate the current admin; same end state).

Two guardrails are what the flow exists for: **self-lockout** (the operator always retains a working admin
login — this invariant is already stated in [`../operations.md`](../operations.md)) and **perimeter
overwrite** (an explicit, user-driven choice rather than a silent side effect). With control data in
scope, restore-all over an existing install and onto a fresh one finally converge — which was the original
complaint.

## Open

- **Restore-all and the perimeter: offer-with-confirmation, or an automatic reset?** The flow above is
  offer-with-confirmation; that is the lean, not a settled call.
- **Does `backup_recipient` ride the accounts-and-secrets backup, or stay machine-local?** The recipient
  list is otherwise not backed up at all. Note it now has a keypair generator attached to it on the Backup
  page, so a lost list costs more than it did.
- **Is the wider artifact allowed unencrypted?** The question dissolved for the *credentials* half in
  2026-08-10 — the payload is already ciphertext, so there is no plaintext variant to permit and no
  toggle to offer, and the file's strength is its weakest slot's (which, for the passphrase, is why the
  export waits for it to clear the current rule). The wider artifact additionally carries **password hashes, which have no such
  wrapping**, so the reasoning does not simply carry over.
- **Restoring an incremental chain.** The **document delta** — send only the ids the target lacks — is
  the tractable half and both its prerequisites already exist (members addressed by id, a digest each);
  the ledger needs no delta because it is small once zipped and is always sent in full. What is unsolved
  is restoring the *chain*: the compatibility guard's `instance_id` / `schema_version` checks would have
  to apply across files, and restore is wipe-and-rebuild with **no merge mode** — "restore on top" today
  means restoring into a non-empty database, which still replaces it. The reasoning behind the
  ledger-vs-documents decomposition is in [`../scale-and-limits.md`](../scale-and-limits.md) →
  *Obstacles*.

  A date-windowed backup is **not** a substitute and must not be sold as one. `txn` has no `updated_at`,
  so a "past year" backup slices by *transaction date*, not by when a row changed: a 2019 charge
  recategorized this morning is absent from it, so full-plus-incremental restores the stale 2019
  categorization, and a 2019 row trashed today is absent too — an additive incremental cannot express a
  deletion at all. Date-windowed is a **slice**, useful for export or sharing, and not a basis for
  disaster recovery.

## Cross-refs

- [`transaction-attachments.md`](transaction-attachments.md) — the document delta's other consumer, and
  the sizing assumption that decides whether it is ever needed
- [`import-history-windowing.md`](import-history-windowing.md) — unrelated scope, same page
