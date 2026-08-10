# Backup/restore scope, the secrets backup & restore-time identity handling

**Status update (2026-08-10): the phase-6 gate is MET, and the credentials backup piece has landed.**
`security-and-deployment-model.md` records 6a, 6b-1, 6b-2 and 6b-3 as implemented; only phases 4–5
(passkey slots, enrollment/invite) remain and they were never the gate. What shipped is the *secrets*
half of the design below:

- The credentials backup is **payload v3: ciphertext + the wrapped DEK** (`export_vault_slot`), so it
  spans both databases as this document requires, and restores on another machine given the vault
  passphrase that made it. Export needs **no unlocked vault** (it copies wrapped material); the
  passphrase moved to restore, which re-keys every secret under the local DEK rather than adopting a
  foreign slot. A backup taken on *this* install restores verbatim with no prompt at all.
- **The plaintext credentials export is gone**, along with the RSA-encrypted variant — a payload that is
  already ciphertext has nothing to gain from a second layer. That answers two of the open questions
  below. v1/v2 files still *restore* (and are upgraded to ciphertext in the process).
- **Secrets stay where they are:** ciphertext in the data DB, keys in the control DB. Co-locating them
  would put the wrapped DEK beside the material it unwraps, collapsing the "leaked DB ≠ leaked tokens"
  property; and `connection` carries ledger-coupled sync state (`transactions_cursor`) that does not
  belong in the security DB.

**Still parked, unstarted:** the sectioned "back up all" artifact, the restore-time identity
reconciliation flow, `backup_recipient` inclusion, and the data-restore cursor reset noted below.

**Original status: parked, do after phase 6 (2026-08-01).** A backup/restore redesign that makes the *scope* of
each backup explicit on the Backup page, adds a coherent "accounts & secrets" backup (the control DB +
the data DB's vaulted tokens, which are now cryptographically coupled), a "back up all" option, and a
restore flow that asks the user how to reconcile identities. Deliberately deferred until **after phase 6**
of [`security-and-deployment-model.md`](security-and-deployment-model.md), because phase 6 moves
app-level provider credentials out of `.env` into the DB under the vault — until then the "connection
secrets" story is incomplete, so finalizing the secrets backup now would bake in a half-picture.

## Why this exists (the trigger)

Restoring a backup **over an existing install** and restoring it **onto freshly created databases** give
different end states, which is surprising. A user turned sign-in protection on, restored a pre-phase-1
backup, and found auth still on; the only way they found to turn it off was to delete both databases and
restore fresh.

**Root cause — a backup covers one of two databases.** Luma has `luma-data.db` (financial data) and
`luma-control.db` (identities + perimeter + vault keys). The restore path (`_wipe_user_data_tables` +
`restore_backup` in `backend/routers/import_export/backup.py`) touches **only data-DB tables**; it never
reads or writes the control DB. `auth_enabled`, `user_account`, `security_profile`, and (post-phase-3)
`vault_slot` all live in the control DB. So:

- restore **over existing** → control DB preserved → `auth_enabled` survives → auth stays on;
- delete both DBs, then restore → control DB recreated empty → first-run → auth off.

The separation is intentional and correct (a data backup should not carry or overwrite a machine's
security posture and credentials — password hashes, 2FA secrets, the perimeter flag — especially a backup
shared between people or machines). The rough edge is only that "restore a backup" silently restores just
one database, so the *overall* outcome depends on pre-existing control-DB state, and that isn't surfaced.
(Note: turning auth off never actually required deleting databases — **disabling sign-in protection is an
admin-gated flag flip in Settings** (`disable_auth_mode()`); the deletion was a heavier workaround than
needed.)

## What lives where (three buckets, not two)

| Bucket | Physical home | Contents |
| --- | --- | --- |
| Financial data | `luma-data.db` | txn, accounts, categories, rules, `ui_preference`, import history |
| **Per-connection tokens** | **`luma-data.db`** (`plaid_item.access_token_enc`) | Plaid access tokens — *ciphertext* |
| **Vault keys** | **`luma-control.db`** (`vault_slot`) | the wrapped DEK that decrypts those tokens |
| Identity & perimeter | `luma-control.db` | `user_account` (password hashes, 2FA), `auth_enabled`, `security_profile` |
| App-level provider creds | `.env` today → DB under vault in **phase 6** | Plaid `client_id`/`secret` |
| Backup recipients | `luma-data.db` (`backup_recipient`) | public keys for encrypted backups |

The bank tokens are in the **data DB**, not the control DB — so "credentials backup = control DB" is
wrong; today's credentials backup *is* those `plaid_item` tokens.

## The coupling phase 3 introduced (the crux to design around)

Before phase 3 the credentials backup was self-contained: it held decryptable tokens. Post-phase-3 it is
not. **The token ciphertext is in the data DB; the key that decrypts it (`vault_slot`) is in the control
DB.** That split *is* the "leaked DB ≠ leaked tokens" property, but it means:

- a **data-only** backup carries tokens that are **dead on arrival** elsewhere (no matching `vault_slot`
  → no DEK → cannot decrypt);
- a snapshot that can actually **sync after restore** needs the token ciphertext **and** the vault slots
  **and** a user who still knows their vault passphrase.

So the "secrets" backup must pull the vault wrapping material (control DB) **together with** the token
ciphertext (data DB), or restoring it is useless. This is a design requirement, not a naming choice.

## Correcting the risk model (matters for the encrypt-or-not call)

The vault passphrase is **separate from the login password** (a settled phase-3 decision). So in an
"accounts & secrets" file:

- the **login password hashes** (`user_account`) are offline-crackable → they gate the *perimeter*, not
  the tokens;
- the **vault `wrapped_dek`** (`vault_slot`) is offline-crackable *only if the vault passphrase is weak* →
  that is the path to the tokens;
- the tokens are **not** directly unlockable from a password hash. They fall only if the *vault
  passphrase* is cracked via the wrapped DEK — which is exactly why the phase-3 Production gate forces a
  strong vault passphrase.

Net: a leaked secrets backup is a pair of *offline brute-force* exposures (perimeter via password hashes;
tokens via the wrapped DEK). That argues for **recommending encryption** on this backup while still
**allowing plaintext** when it never leaves the machine/house. (Open lean below.)

## Proposed shape

On the Backup page, backups **named by what they protect, referencing the DB file(s)**:

- **Financial data** (`luma-data.db`, minus tokens) — the shareable, low-sensitivity one.
- **Accounts & secrets** — control DB (identities, sign-in settings, `vault_slot`) **plus** the data DB's
  token ciphertext, restorable-and-syncable as a unit. May also include `backup_recipient` (the recipient
  list is otherwise not backed up). **Recommends encryption; allows unencrypted** for stay-at-home use.
- **Back up all** / **all (encrypted)** — one **sectioned file** (`data` / `identity` / `vault+tokens`
  sections) rather than separate files, so the pieces that must travel together stay in one artifact and
  selective restore is still possible. Encrypted is the recommended default given the contents; a plain
  "backup all" is the widest-blast-radius artifact (hashes + 2FA + vault material in cleartext).

Move (or mirror) the **backup-recipient management** from Settings onto the Backup page — it is used only
by backup, so co-locating it is the obvious home.

## Restore-time identity handling (decided in discussion)

When a restore includes identity/control data, **restore asks the user how to reconcile identities**
rather than silently overwriting the perimeter. Concretely:

- Restoring a backup requires the current user to be an **admin** (they must be able to authorize a
  destructive restore).
- The flow **lists the accounts in the backup file** and lets the user decide.
- Default reconciliation **preserves the current admin** so a restore can never lock the operator out:
  remove all identities except the current admin, then merge the backup's accounts in — equivalently,
  restore everything from the backup and then recreate the current admin. Same end state either way; the
  invariant is *the operator always retains a working admin login*.

This resolves the two guardrails raised earlier: **self-lockout** (the current admin is always kept) and
**perimeter overwrite** (it becomes an explicit, user-driven choice, not a silent side effect) — and it
gives the original complaint its fix: with control data in scope, restore-all onto an existing install and
onto a fresh one converge.

## Why after phase 6

Phase 6 moves app-level provider credentials (Plaid `client_id`/`secret`) from `.env` into the DB under
vault custody. Until then the "connection secrets" bucket is incomplete (the app creds sit in `.env`,
outside both databases and outside any backup). Building the secrets backup before phase 6 would either
omit app creds or special-case `.env`, both of which get cleaner once phase 6 lands — so this waits.

## Discovered: a data restore leaves a connection's cursor ahead of the ledger

Not introduced by the connection-mapping work, but that work made it visible and it belongs here rather
than in the feature that surfaced it.

A data restore rolls the ledger back while the live `connection` row — which the restore deliberately
never wipes, since it is credential data on the other side of the split — **keeps its current
`transactions_cursor`**. So the next sync resumes from a checkpoint *past* the rows the restore just
removed, and those rows are never re-fetched. They are simply gone: the provider considers them already
delivered, and nothing local knows to ask again.

The mapping work sharpened the contradiction rather than causing it. `connection_account.coverage_*`
rides the **data** backup precisely so a restore moves coverage backward in step with the ledger (a
surviving claim would hard-reject the very rows a re-sync brings back). Coverage now moves correctly and
the cursor does not — the two halves of the same assertion disagree after a restore.

The fix is the one `Remove synced transactions` already uses: a data restore should reset
`transactions_cursor` + `initial_sync_complete` for every connection, so the next sync re-backfills and
re-establishes both coverage and rows together. Flagged rather than folded into the mapping work because
it changes what a restore does to the credential side of the split, which is this document's subject and
has its own blast radius.

## Open questions

- **Restore-all and the perimeter:** offer-with-confirmation (recommended) vs. an automatic reset. The
  identity-reconciliation flow above is offer-with-confirmation; confirm that's the final call.
- ~~**Unencrypted "accounts & secrets"**~~ — **settled for the credentials half (2026-08-10).** The
  question dissolved once the payload became ciphertext: there is no plaintext variant to permit, and no
  encryption toggle, because the sensitive part is already sealed under the vault passphrase. The file's
  security *is* that passphrase's strength, which is why `meets_production_min` rides along in the
  payload. The same reasoning should carry to the wider "accounts & secrets" artifact when it is built —
  though that one additionally contains password hashes, which have no such wrapping.
- **`backup_recipient` inclusion:** include it in the accounts & secrets backup, or keep it machine-local?

## Cross-refs

- [`security-and-deployment-model.md`](security-and-deployment-model.md) — the vault/perimeter model this
  builds on; its phase 6 (provider-agnostic connections, app creds into the vault) is the gate. Its "Docs
  to write" README-Security section overlaps and should be written alongside this.
- [`import-input-formats.md`](import-input-formats.md), [`import-history-windowing.md`](import-history-windowing.md)
  — other Import/Export-page work (unrelated scope, same page).
