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
reconciliation flow, and `backup_recipient` inclusion.

**Not parked, and now shipped:** *Streaming both directions*, below, was committed release work rather
than backlog — see [`../pre-release.md`](../pre-release.md), which owned its scope boundary. It landed
2026-08-23 and settled the payload-version-10 envelope that
[`transaction-attachments.md`](transaction-attachments.md) then built on (documents took **12**; splits
spent 11 in between). Its one deliberate omission — `restore_state` and the documents phase — **landed
with attachments on 2026-08-24**, so nothing in that section is outstanding.

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

~~Move (or mirror) the **backup-recipient management** from Settings onto the Backup page — it is used only
by backup, so co-locating it is the obvious home.~~ **Done 2026-08-23**: moved (not mirrored — two homes
for one control is drift), and it gained a **keypair generator**, since requiring an `openssl` incantation
to use encrypted backups is a barrier unrelated to the decision. See `docs/data-model.md` → Backups.

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

## ~~Discovered: a data restore leaves a connection's cursor ahead of the ledger~~ — fixed 2026-08-23

**Resolved.** A restore now clears `transactions_cursor` + `initial_sync_complete` for every connection
inside its own transaction, so the resume point rolls back with the rows; `provider_request_budget` and
the sync-health fields deliberately survive. The durable version is in `docs/data-model.md` → Backups.
The rest of this section is the original analysis, kept because it records why the two halves of the
assertion had to move together.

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

The fix was the one `Remove synced transactions` already uses: a data restore resets
`transactions_cursor` + `initial_sync_complete` for every connection, so the next sync re-backfills and
re-establishes both coverage and rows together. Flagged rather than folded into the mapping work because
it changes what a restore does to the credential side of the split, which is this document's subject and
has its own blast radius.

## Documents ride the data backup as zip members (settled 2026-08-21)

Receipts and invoices ([`transaction-attachments.md`](transaction-attachments.md)) are stored as files
under `DATA_DIR/documents/` and carried **inside the backup zip as additional members**, not base64'd
into the JSON payload. The container is built for it: since version 10 the payload is already one member
per section, and the encrypted path is `manifest.json` + `payload.bin`.

They belong to the **Financial data** bucket above: transaction detail, not credentials. That is
deliberate and load-bearing — it is the backup people actually take, and a backup that silently omitted
every receipt is precisely the failure this document exists to prevent.

Consequences: a payload version bump (a new table plus new members is an envelope change — it landed as **12**, since the streaming work below spent 10 and splits took 11), and
restore's destructive semantics extend to the documents directory. *How* they extend is settled below
rather than here — the directory is swept against the restored ledger at the end rather than cleared at
the start, so an interrupted restore leaves litter instead of losing originals.

## Streaming both directions, and the envelope that makes it possible (settled 2026-08-23)

**Built 2026-08-23; the documents half followed on 2026-08-24.** Everything below is implemented and in
the tree — version 10, the streaming export and restore, the incremental cipher, referential repair as
SQL, the CSV export — and the durable half of it now lives in `docs/data-model.md` → Backups. Measured on
the same ~18,500-transaction ledger as below: export peak fell from ~275 MB to ~9 MB, restore from ~178 MB
to under 2 MB, and all 36,935 rows across 27 tables round-tripped exactly.

`restore_state` and the documents phase were deliberately held back on 2026-08-23 — there were no
documents yet, so a phase marker would have had nothing to guard and a resume nothing to resume — and
they **shipped with [`transaction-attachments.md`](transaction-attachments.md) on 2026-08-24**, built as
the two sections below describe. What those sections now hold is the reasoning behind a structure that is
easy to simplify wrongly, not a design waiting to be built.

The defect this fixed: the export assembled the entire payload as a Python structure, serialized it to
one JSON string, zipped that into a `BytesIO`, and returned it as a single yield — so the streaming was
nominal and peak memory held all of them at once. Restore was the same defect mirrored: the upload read
whole, parsed whole, and filtered as ~25 in-memory lists before a row was inserted. **Neither was caused
by documents; both already scaled with the ledger.** Documents would have made them acute.

### What it costs today, measured

Against a real ledger of ~18,500 transactions (36,900 rows across every backed-up table, a 60 MB data
DB) producing a **4.9 MB** artifact:

| stage | peak RSS |
| --- | --- |
| baseline | 80 MB |
| payload dict assembled | 251 MB |
| serialized to JSON (`indent=2`) | 315 MB |
| zipped | 354 MB |

~275 MB of transient allocation for a 4.9 MB file, all live at once and linear in the ledger — a
200k-transaction ledger extrapolates to roughly 3 GB. Restore is not much better: loading that same
4.9 MB artifact in a fresh process peaks ~178 MB above baseline, 58 MB of which is the content-hash
check re-serializing the whole payload into a second canonical string purely to compare digests.

**The dominant term is the Python payload dict — larger than the JSON string and the zip combined.**
That is what makes "stream the export to a temp file", the obvious reading of the defect, insufficient
on its own: it recovers about a third of the cost. Bounded memory requires that rows never accumulate
as lists at all, in either direction. (`indent=2` is worth dropping — a machine-read artifact about to
be compressed gains nothing from pretty-printing — but it is ~9% of the serialized size, not the
problem.)

The figures are *transient allocation during the operation*, not resting footprint. What they cost is a
backup or a restore that dies mid-operation on a small machine, which is also why fixing only the export
would be half an answer: a ledger that can be backed up and not restored has no backup.

### Payload version 10: sections as NDJSON members

The single giant JSON object is what forces whole-payload handling on the read side. Version 10 keeps
the same zip container and the same row contents, and changes only how they are laid out:

- `meta.json` — the envelope header (`version`, `schema_version`, `exported_at`, `instance_id`,
  `access_mode`) plus a digest per data member.
- `sections/<name>.ndjson` — one member per backup section, one row per line.
- `documents/<id>` — the attached files, once they exist (see
  [`transaction-attachments.md`](transaction-attachments.md)).

Both directions become line-at-a-time with no incremental JSON parser and no new dependency. Versions
7–9 still restore through the existing whole-payload path, unchanged; those keep today's memory profile,
which is the status quo and decays as backups are retaken.

**The bump belonged here rather than in the attachments feature**, which needed an envelope change anyway
for its table and its members. Splitting them would have meant two envelope changes and, worse, an
incremental JSON parser built for the monolithic format and deleted a feature later. One format change,
and attachments became purely additive to a container already shaped for them — which is what happened:
documents took a plain version **12** (splits spent 11 first) and added nothing to the container's shape.

### Integrity under the new layout

`meta.json`'s per-member digests replace the in-payload `content_sha256`, and are verified as each member
streams — the same guarantee, without materializing anything to check it, and reaching every member rather
than the JSON alone: the data members through `meta.json`, the documents through the digests the ledger
already carries. The property is unchanged and so is its limit: an unsigned checksum
detects **accidental** corruption, not tampering, since anyone editing a plaintext file can recompute the
digests. Authenticity remains the encrypted envelope's job.

Documents are deliberately **not** listed a second time in `meta.json`. Their digests live on the
`document` row, which is both the app's own record of the file and what makes a resumed restore able to
tell a complete file from a torn one — one source of truth, verified from the ledger as each file lands.

### Export

Rows stream from their cursors straight into the zip member; a document streams from disk into its member
with a fixed buffer, so a large attachment is never resident. Data members stay deflated (the ledger JSON
compresses ~10:1); **documents are stored, not deflated** — JPEG, PNG and PDF payloads are already
compressed, so deflating them spends CPU for nothing. Zip64 is explicit rather than incidental once a
member can exceed 4 GB.

The artifact is built into an unnamed temp file (`tempfile.TemporaryFile`) and streamed back from it, with
a real `Content-Length` the download progress can use. Two constraints on where that file goes: it belongs
under `DATA_DIR`, **not** the system temp directory, which is RAM-backed `tmpfs` on many Linux installs
and would put the artifact straight back into memory; and being unnamed, a crash mid-export can never
strand it.

**The encrypted path needs no format change.** `AESGCM.encrypt()` is one-shot and forces both plaintext
and ciphertext into memory, but the incremental `Cipher(AES, GCM)` encryptor produces byte-identical
output — verified: ciphertext‖tag matches the one-shot result exactly, and the one-shot API decrypts it.
So `payload.bin` is written through `encryptor.update()` with no manifest version bump, no chunked-AEAD
framing to design, and no restore-side compatibility work.

### Restore

Only `/restore-file` is reachable from the UI; `POST /restore` takes a parsed JSON body and is therefore
materialized before it arrives, so it stays as the programmatic entry point. Both feed one row-consuming
core, and the upload is spooled to a temp file rather than read whole.

**Referential integrity becomes SQL rather than Python sets.** Today the restore builds id sets from the
payload and filters child lists against them — inherently whole-payload. The transaction already runs
`PRAGMA defer_foreign_keys = ON`, so a transient orphan inside it is legal by construction: rows can be
inserted as they stream and the surviving rules expressed as statements before commit
(`DELETE FROM txn_tag WHERE txn_id NOT IN (SELECT id FROM txn)`,
`UPDATE account SET owner_id = NULL WHERE owner_id NOT IN (SELECT id FROM owner)`). Same end state, no
retained sets, and the rules become declarative and individually testable instead of sixty lines of list
comprehensions. `restored_counts` follows from `COUNT(*)` afterwards, which is also more honest than
today's list lengths — those count rows that were *offered*, including any that `INSERT OR IGNORE`
silently dropped.

**The table phase stays one transaction.** Splitting it into committed chunks was considered and
rejected: there is no memory argument for it (an open SQLite write transaction spills to the WAL, which
is disk), and all-or-nothing is the property that makes a *failed* restore leave the target completely
untouched. Chunked commits would leave a half-restored ledger, which is not a valid state, has no defined
recovery, and undermines both the compatibility guard and the `instance_id` adoption — each of which
assumes a wholesale replacement.

**Verification precedes destruction**, as it does today. The staged artifact is verified in a pass of its
own before the wipe; on the encrypted path that means decrypting to a temp file and checking the GCM tag
*before* the inner zip is opened, because GCM authenticates only at the end and nothing may act on
unverified plaintext. Two passes over a local file is the honest price and it is disk I/O, not memory.

### `restore_state`: making the documents phase resumable — built 2026-08-24

`backend/services/restore_state.py` plus the two writes in `routers/import_export/backup.py`; an import
or a sync refuses while a marker is set (`require_no_pending_restore`), and the table is excluded from the
backup payload. Files are not transactional, which is the whole difficulty: a restore that fails partway
can leave the database cleanly rolled back and the documents directory half-rewritten, and built the obvious way it
would already have deleted the originals it was replacing. A small `restore_state` table in the data DB
carries the operation across that gap: a phase, a timestamp, the staged artifact's path, and enough of the
artifact's identity to recognize it again.

**Why the data DB and not the control DB.** The instinct is the control DB, on the `credentials_export`
precedent of state that must survive a data restore. But the requirement here is stronger than survival:
the marker must be *atomic with the committed ledger*. Written inside the restore transaction, it exists
exactly when the ledger it describes exists — a crash before commit leaves neither, a commit leaves both.
A control-DB row could land without the ledger, or the ledger without it.

**Why its own table and not a key in `import_workflow_state`.** The wipe clears
`import_workflow_state`, so a marker living there is inside the blast radius of the very operation it
tracks: written before the transaction, deleted by the wipe, and needing deliberate re-writing afterwards.
Getting that wrong ends a *successful* restore with no pending marker at all — silently losing the
attachment phase, which is the exact failure the structure exists to prevent. A dedicated table outside
the wipe list has no such coupling, and it stays out of the backup payload for free: this is machine-local
operational state and must never travel to another install.

It is a new table, so it landed in both places a schema change has to — the baseline `CREATE` in
`init_db` and a registered `@migration` — with `CURRENT_VERSION` bumped last, after the code that reads it
was in place.

Two writes to one row, deliberately in different transactions:

- **before the wipe, in its own short transaction** — `staging`, naming the artifact. This is what makes
  a restore visible while it runs (a `get_db()` block commits only on exit, so a marker written inside
  the long transaction is invisible to every other request until it ends) and what refuses a second
  concurrent restore. Cleared in a `finally`.
- **inside the restore transaction, after the wipe** — `documents_pending`, committed atomically with the
  ledger.

The two phases mean different things after an unclean shutdown, which is the point of recording a phase
rather than a flag: `staging` means the restore died before committing and **nothing was changed**, so the
row can be cleared and the attempt reported; `documents_pending` means the ledger is live and its files
are not all there yet, so the documents phase resumes.

**No progress cursor.** With digests on the `document` rows, "what is still missing" is a comparison
between the committed ledger and the directory — computable in one pass, self-correcting, and able to
catch a torn file that a position counter would skip straight past.

Resuming needs the source to still exist, which is why the staged artifact survives the ledger commit and
is deleted only when documents complete. If it is gone anyway, the recorded identity lets a re-upload be
confirmed as *the same backup* before it resumes, rather than silently filling a directory from a
different artifact.

### The documents phase itself — built 2026-08-24

Written **in place**, each file to a temporary name then `os.replace()` (atomic on both platforms within
a volume), so a torn write can never be mistaken for a complete file. Staging the whole set into a
sibling directory and swapping at the end was the first instinct and is worse: it costs 2× disk on
precisely the class of data that grows without bound, and buys nothing that a resumable phase does not
already provide. In-place is safe *because* documents are immutable and content-addressed — an id plus a
digest either matches or it does not.

**The directory is not cleared up front.** Restore is destructive, but the destructive half is derivable:
after every document from the artifact is written, files the restored ledger no longer references are
swept. Doing it last means an interrupted restore leaves inert litter rather than lost originals, and the
sweep is the same directory-versus-ledger comparison the resume uses.

**Tables first, then documents.** The reverse would leave, on a crash, new files beside the old ledger
whose own documents had already been replaced — strictly worse. The consequence is a window in which
attachment indicators exist for files not yet on disk; the marker is what lets the app say so instead of
failing mysteriously, and it gates the same operations the demo-data marker does (another restore, an
import, a sync) while it is set.

A document that fails its digest check does not fail the restore. The ledger is already committed and
correct; one unreadable receipt leaves one missing file, reported through the same surface as the
write-order drift in [`database-diagnostics.md`](database-diagnostics.md), rather than costing the user
their ledger.

### The CSV export has the same shape

`export_transactions_csv` fetches the whole filtered ledger into a list and then yields from it, for no
reason beyond a connection that closes before the generator runs. It gets the same treatment — the
generator owns the connection and iterates the cursor — since it is the same defect, on the same page,
with a smaller blast radius.

### Deliberately not in this work

Streaming the *legacy* v7–v9 restore path (they keep the whole-payload reader), and the document delta
below — for which this work nonetheless landed the two prerequisites it always needed: an id-addressed
document member layout, and a digest per document. Both remain untaken; the *documents phase* named
above is a separate thing and did ship, with attachments, the day after.

## Windowed and incremental backups — what is cheap and what is not

**Proposed:** rather than a full backup every time, allow a date-scoped one (year to date, past year) so
a full encrypted backup can sit on a cloud server with small increments layered on top.

**The blocker is that there is no change tracking.** `txn` has no `updated_at` — its only timestamps are
`date`, `authorized_date`, `trashed_at` and `suspect_resolved_at`. So a "past year" backup slices by
*transaction date*, not by *when the row changed*:

- a 2019 charge recategorized this morning is absent from it, so full + incremental restores the stale
  2019 categorization;
- a 2019 row trashed today is likewise absent, and an additive incremental cannot express a deletion at
  all.

Date-windowed is therefore a **slice**, useful for export or sharing, and *not* a basis for disaster
recovery. True incrementality needs `updated_at` on every table plus delete tombstones, with every write
site maintaining them — a real schema change with a permanent maintenance burden.

**The decomposition that avoids all of it:** the two halves have opposite properties, and only one needs
incrementality.

| half | mutable? | size | approach |
| --- | --- | --- | --- |
| Ledger | yes, anywhere in history | small once zipped | **always full** — cheap enough to upload on any schedule |
| Documents | **no** — immutable once written | large, grows forever | **delta** — send only ids the target lacks |

A document never changes after ingest, so "which files does this backup already have" is answerable by
id alone, with no change tracking and no correctness risk. That delivers the cloud story — one big
encrypted full backup, then increments that are mostly just new receipts — while the ledger stays a
full, always-correct snapshot.

Both prerequisites this needs are landed by the streaming work above for its own reasons: documents are
members addressed by id, and each carries a digest. A delta therefore reduces to omitting the members the
target already holds, and the digest answers the second question an id alone cannot — whether the copy on
the far side is intact.

Restoring a chain still needs design (the compatibility guard's `instance_id` / `schema_version` checks
would have to apply across files, and restore is currently wipe-and-rebuild with **no merge mode** —
"restore on top" today means restoring into a non-empty database, which still replaces). But the
document delta is additive-only, which is the tractable half.

## Should a credentials backup carry every member's passphrase slot?

**Open, and only meaningful once a workspace has more than one member.** The file carries one vault slot —
the exporting user's passphrase slot — so **cross-install**, only that person's passphrase opens it. Within
the install that made it, none of this applies: the live DEK opens its own backups, whoever exported them
and whatever the passphrase has since become (see `data-model.md` → Backups).

So the question is narrow: a shared workspace, a backup being restored somewhere else, and the person who
exported it unavailable — gone, or having forgotten the passphrase that was in force at the time. Today
that file is unrecoverable even though every other member holds a key to the same DEK.

| | one slot (today) | every member's passphrase slot |
| --- | --- | --- |
| Cross-install restore | only the exporter can | any member can |
| File's strength | that one passphrase | the **weakest** passphrase among members |
| Attackable wraps in the file | one | one per member |

The trade is real in both directions. Each slot is an independently offline-crackable wrap of the *same*
DEK, so adding slots strictly widens the offline attack surface, and the file stops being as strong as its
owner's passphrase and becomes as strong as the least careful member's — which no member can see or audit.
Against that, "the person who made the backup has left" is an ordinary way to lose data, and the current
design has no answer to it beyond taking a fresh backup while you still can.

Two things worth noting before deciding. The Production vault floor already constrains how weak any
member's passphrase can be, which narrows the weakest-link cost. And a middle option exists: let the
*exporter choose* whose slots ride along, which keeps the default strong while making a deliberately
shareable file possible — at the cost of a decision on a screen that currently has none.

Not urgent: single-user installs are unaffected, and multi-user vaults are themselves phase 4–5 work.

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
