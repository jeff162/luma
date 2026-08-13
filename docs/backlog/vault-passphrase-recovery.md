# Vault passphrase recovery — "I forgot my passphrase"

**Status: backlog, not started (2026-08-13).** A forgotten vault passphrase is currently a dead end with
no way out: `unlock` needs the passphrase, and `set_passphrase` on an already-configured vault takes the
`require_dek` path, so replacing it needs the vault *already unlocked*. There is no endpoint and no UI for
the one state a user is guaranteed to reach eventually. The security model has always said passphrase loss
is an acceptable outcome to be warned about rather than engineered around — but "acceptable" was meant as
*you re-link your data sources*, and today it means *the vault is bricked and the app never says so*.

This note covers what recovery costs, the one path that avoids that cost, and the two things that make a
reset less clean than it first appears.

## What is actually at stake

Exactly two columns are encrypted under the workspace DEK:

| column | what it holds | replaceable by |
| --- | --- | --- |
| `connection.credential_enc` | a data source's access credential | re-linking the source |
| `provider_config.secret_enc` | the app-level provider secret | re-entering it from the provider's dashboard |

**Nothing else is encrypted.** Accounts, transactions, mappings, coverage, cursors, rules, tags and import
cards are all plaintext in the data DB and survive untouched. This is the reassurance that should lead the
UI: losing the passphrase costs *the ability to keep syncing*, not any ledger data, and the accounts on
screen do not change. A dialog that leads with destruction will read as "my data is gone", which is wrong
and is the more likely reason someone abandons the app at that moment.

## The recovery ladder, in order

The order is load-bearing — the first rung is free and the second is irreversible, so the UI must offer
them in this sequence rather than presenting the reset as the only answer.

### 1. A credentials backup, opened with the passphrase *it* was made with

Restore asks for the passphrase the **backup** was made under, not the current one — a foreign slot is
unwrapped with its own passphrase (`unwrap_dek_from_slot`, AAD-bound to the exporting `user_id`) and each
secret is re-sealed under this workspace's DEK. So a backup from an era whose passphrase is remembered is
a *complete* recovery: no re-linking, connections keep working.

The sequence has to be reset-then-restore, because re-keying needs the local vault unlocked and there is
no unlocking the old one. So: reset → set a new passphrase → restore the credentials backup with the old
one. The reset clearing `credential_enc` costs nothing here, since the backup file is the source.

`credentials_export` (control DB) already records which wrapping each export carried, so the reset dialog
**can tell the user whether a backup that predates the current passphrase exists** rather than asking them
to remember. That record was built to warn about stranding backups; this is its second consumer, and the
more valuable one.

### 2. Reset — destructive, and the only other option

**Must do:**

1. Delete the user's vault slot(s), so `vault_configured()` goes false and a new passphrase mints a fresh
   DEK.
2. Clear both encrypted columns. Once the slot is gone the ciphertext is permanently unopenable, so
   leaving it is litter that yields `VaultDecryptError` forever.
3. Mark every connection `reauth_required = 1`, so cards read "reconnect needed" rather than accumulating
   generic sync failures.

**Must not do:** delete connections, accounts, or transactions. Deleting connection rows would discard the
account mappings, per-account coverage and sync history — which is the genuinely expensive part to rebuild
and is not lost with the credential.

The clean-break behaviour this rests on is already designed for and pinned by
`test_decrypt_under_a_different_dek_is_the_clean_break` in `test_vault.py`: a fresh DEK over old ciphertext
raises `VaultDecryptError`, which the model has always described as meaning *re-link*.

## The wrinkle: re-linking does not always reattach

`connect` upserts on `(provider, external_id)`, so whether a re-link lands on the **existing** connection
row — preserving its mappings and coverage — depends entirely on how that provider derives its handle:

- **A provider whose handle is issued by the provider** (Plaid's `item_id`) re-links onto the same row.
  The `ON CONFLICT ... DO UPDATE` path is a clean credential refresh and nothing is orphaned.
- **A provider whose handle is derived from the credential** — SimpleFIN's is
  `"sfin_" + sha256(access_url)`, because the access URL is the credential and cannot also be the public
  handle — gets a **new** `external_id` for a new token. Claiming a fresh setup token therefore creates a
  *second* connection row, leaves the original stranded, and requires re-mapping every provider account
  onto its existing local account.

So "keep the connection rows so the mappings survive" is only half true, and the half that fails is the
provider where a reset is most likely to be needed. Options, undecided:

- Accept it, and make the reset dialog say plainly that a re-link may arrive as a new connection needing
  its accounts re-mapped.
- Let a re-link **adopt** a stranded connection: on connect, offer any `reauth_required` connection of the
  same provider whose accounts match, and re-point the new credential at that row instead of inserting.
  Strictly better UX, materially more work, and it needs a rule for "match" that cannot mis-adopt.

The second is worth considering on its own merits — it is the same gap a user hits after any credential
rotation, not only after a forgotten passphrase.

## Open decisions

**Multi-user.** Slots are per-user but there is one DEK per workspace, so one member forgetting theirs is
not a reason to destroy the workspace's credentials — another member's slot still opens the same DEK. The
correct answer there is re-enrollment, which is phase 5 and not built (`set_passphrase` still refuses with
"enrollment for a new user is not yet available"). Until it is, the reset should probably **refuse** when
another slot exists and say that a member who can unlock is the way back, rather than silently wiping
credentials that are still reachable.

**How hard to make it.** Irreversible, so: a typed confirmation, a count of the connections that will need
re-linking, and — first, above the warning — the statement that transactions and accounts are kept.

**Placement.** The locked `VaultStrip` beside Unlock is where someone actually is when they are stuck; a
link inside the unlock dialog is the other candidate. Not the unlocked strip: someone who can unlock is
looking for **Change passphrase**, which is already there.

## Adjacent bug, worth fixing regardless

`VaultDecryptError` is caught nowhere. During a sync it falls into the generic `except Exception` handler
in `routers/sync.py`, which deliberately does *not* set `reauth_required` — that arm exists to avoid
drawing distinctions a user cannot act on. But this is precisely the distinction they can act on: a DEK
mismatch is unfixable by retrying and means re-link. Today it presents as an unexplained "this connection
has stopped working", which is the wrong story even before any reset feature exists.

## Tests owed

- reset deletes the slot, clears both encrypted columns, sets `reauth_required`, and leaves accounts and
  transactions untouched (count them before and after);
- a new passphrase after a reset mints a *different* DEK — the old ciphertext must not decrypt;
- reset → set → restore a credentials backup taken under the old passphrase re-keys the credentials and
  leaves the connections syncable, which is the whole first rung of the ladder;
- reset refuses (or does not) when a second slot exists, per the decision above;
- `VaultDecryptError` during a sync records `reauth_required`, not a generic failure.
