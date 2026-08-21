# Vault passphrase recovery — "I forgot my passphrase"

**Status: backlog, not started (2026-08-13).** A forgotten vault passphrase is currently a dead end with
no way out: `unlock` needs the passphrase, and `set_passphrase` on an already-configured vault takes the
`require_dek` path, so replacing it needs the vault *already unlocked*. There is no endpoint and no UI for
the one state a user is guaranteed to reach eventually. The security model has always said passphrase loss
is an acceptable outcome to be warned about rather than engineered around — but "acceptable" was meant as
*you re-link your data sources*, and today it means *the vault is bricked and the app never says so*.

This note covers what recovery costs, the one path that avoids that cost, and the two things that make a
reset less clean than it first appears. A 2026-08-21 pass added three more: **compromise** as a second,
independent reason to want the same reset; how it should **revoke on the way out** (and why the case that
motivated this file is the one where it cannot); and **recovery codes**, which the vault lacks entirely
and which would make the destructive reset rare rather than routine.

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

## A second motivation: reset as a compromise response (2026-08-21)

This file was written around a **forgotten passphrase** — the dead end where no unlock secret survives.
A leaked database or backup is a second, independent reason to want the same operation, and it argues
the feature is worth more than the original framing suggests.

For a leaked file the response is *revoke every credential, change the passphrase, replace the vault
key* (see `SECURITY.md`). A reset does the last two implicitly and forces the first: re-linking replaces
every credential with a **newly issued** one, which kills a stolen credential by making it obsolete
rather than by trusting a revocation call to have worked. That is a stronger guarantee than the
three-step sequence, at the cost of the re-linking the reset already requires.

### Revoke on the way out, driven by the capability — not by naming a provider

Reset should attempt provider-side revocation before clearing anything. There is no reason not to: the
encrypted columns are cleared and every connection is flagged `reauth_required`, so the credentials are
unusable to Luma afterwards regardless, and a re-link is mandatory either way. Revoking costs nothing
that was not already being paid.

Drive it off the existing declared capability, `revokes_on_disconnect` (`services/providers/base.py`),
so a future provider inherits the behavior by declaring it rather than by anyone editing the reset path
— the rule `building-a-connector.md` already sets for capabilities:

- **`revokes_on_disconnect = True`** (Plaid): call `adapter.remove()` per connection. The access
  genuinely ends and there is nothing for the user to do.
- **`revokes_on_disconnect = False`** (SimpleFIN): nothing to call. The dialog must say so plainly —
  the access URL stays live until the user deletes Luma's authorization at the Bridge and re-adds it.

**Do not copy `disconnect`'s failure behavior.** `routers/providers.py` deliberately *keeps* the local
connection when revocation fails, "so the user can retry rather than believe the token is dead when it
may still be live." A reset cannot honor that — clearing the credentials is the point. So a reset
reports **per-connection outcomes** and names the ones the user has to finish by hand, rather than
aborting the way disconnect does.

### The constraint that splits reset in two: revocation needs an unlocked vault

`routers/providers.py` decrypts the credential *before* handing it to `adapter.remove()`, returning
`423 vault_locked` when it cannot. Revoking needs the token, the token needs the DEK, the DEK needs an
open vault — so the original motivating case is exactly the one where **no revocation is possible at
all**:

| reset because… | vault unlockable? | what reset can do |
| --- | --- | --- |
| the passphrase was **compromised** (still known) | yes | revoke automatically wherever `revokes_on_disconnect`; instruct manually elsewhere |
| the passphrase is **lost** (the original case) | no | revoke nothing, for any provider — instruct manually for all of them |

The user knows which situation they are in, so **the reset dialog asks**, and the two paths differ in
what they promise. In the compromised case the vault should be unlocked first precisely so the
revocations can run. In the lost case the "go revoke it at the provider" note becomes the general
instruction rather than the SimpleFIN exception.

## Recovery codes would shrink this feature's role — and are cheap here

**The project already has recovery codes, but only for sign-in.** The 2FA path issues them, counts them
(`recovery_code_count`), regenerates them invalidating the old set, and states they are single-use and
shown once (`pages/Settings.jsx`, and the Help topic on sign-in protection). **The vault has no
equivalent**, which is why the ladder in this file drops from "another member re-enrolls you" straight
to a destructive reset — leaving the *single-user install* with no rung at all. That is the gap worth
closing, and it would make the destructive reset genuinely rare rather than the routine answer.

The architecture already generalizes to it. `vault_slot.method` is a column, not an enum baked into the
code; passphrase and passkey slots coexist today, with `vault_slot_one_passphrase` constraining only the
passphrase kind. A recovery-code slot is a third method with the same shape — `_derive_kek` does not
care whether the secret it is fed is typed by a human or generated. Two properties follow:

- A generated code carries **real entropy**, so the offline-attack question that hangs over a passphrase
  slot does not arise for it, and the scrypt hardening is belt-and-braces rather than load-bearing.
- But the vault is only as strong as its **weakest** slot. A strong recovery code does not compensate
  for a weak passphrase; it adds a path, it does not raise the floor.

### Open: single-use, and what "used" means here

The convention is single-use, and it is worth being explicit about why, because the reasons transfer
unevenly to a vault slot:

1. **Replay containment** — a code is a bearer secret typed into a machine, where it can reach logs,
   clipboards, autofill, screenshots and shoulders. Consuming it on use bounds that exposure.
2. **Consumption is a signal** — a code the owner did not use being spent is evidence. Reusable codes
   produce no such signal.
3. **It stops the code becoming a de facto password.** This is the least obvious and probably the most
   important: a reusable code is *more convenient* than the real credential, so it starts getting used
   routinely — while being stored far less securely, printed in a drawer or photographed.
4. **It forces regeneration**, refreshing the secret rather than letting one code live forever.

The wrinkle specific to this design: a vault recovery code cannot be checked against a stored hash the
way a 2FA code can — it must actually derive a KEK that unwraps a slot's private key. So "consumed"
means **the slot is deleted**, a real destructive step rather than a flag. Which raises the questions to
settle before building:

- One code (one slot) or a set of N (N slots)? A set is redundancy against losing one copy; it is also
  N independent paths to the same DEK.
- Does using one delete just that slot, or invalidate the whole set as the 2FA regenerate does?
- Is the natural flow *unlock with code → set a new passphrase → issue a fresh set*, with the used slot
  dropped at the end? That mirrors what the user actually came to do.
- Does a recovery-code slot count as "another granted slot" for the rule below that a reset must refuse
  while one exists? It should not — it is the user's own rung, not another member's.

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

**Multi-user — settled by phase 5 (2026-08-13).** Slots are per-user but there is one DEK per workspace,
so one member forgetting theirs was never a reason to destroy the workspace's credentials — another
member's slot still opens the same DEK. That escape now exists and is cheap: the stuck user removes their
own slot (or an admin revokes it via `/auth/vault/access/{user}/revoke`), sets a new passphrase — which
enrols them, since they no longer hold a slot — and any unlocked member approves it. **No credential is
touched and nothing is re-linked.**

So the reset below **must refuse while another granted slot exists**, and say that a member who can unlock
is the way back. Wiping credentials that are still perfectly reachable would be the worse outcome, and the
alternative is now a real flow rather than advice. The destructive reset is only for the genuine dead end:
the *last* slot in the workspace forgotten, with no other member who can open the vault.

**Corrected 2026-08-21 — that refusal belongs to the *path*, not to reset itself.** The rule above was
written when a forgotten passphrase was the only motivation, and scoped to that path it holds. The
compromise motivation added earlier in this file inverts it: when the worry is that the key material is
known to someone it should not be, another member still being able to unlock is not a reason to hold
back — it is closer to a reason to proceed. Nobody is being asked to agree; the question is only whether
a *free* alternative exists, and for a compromise it does not.

The same question the reset dialog already asks (lost, or compromised?) decides this too:

| situation | what should happen |
| --- | --- |
| Passphrase lost, **another granted slot exists** | **Not a reset at all.** Raise a fresh authorization request: the stuck user drops their own slot and sets a new passphrase, which re-enrols them, and any unlocked member approves it. Reset should not be offered — the credentials are still reachable and nothing needs re-linking. |
| Passphrase lost, **no other slot and no recovery code** | **Rebuild.** The genuine dead end this file was written for, and the row that vault **recovery codes** would remove almost entirely. |
| **Database or backup stolen**, regardless of who else holds a slot | **Rebuild, and allow it.** The point is to retire every credential by re-issuing it; another member's working slot does not make the old ones any less exposed. |

Two things follow. The first row is a *redirect*, not an error — the UI should start the request rather
than explain why the button is disabled. And reset stays **admin-gated** in every row, consistent with
the model's "admin gates settings, not data": it destroys shared workspace state, so it is not a control
any member should reach alone.

A second consequence: **a passkey is now the cheapest insurance against this whole scenario.** A user with
both a passphrase and a passkey has two independent ways in, and `remove_slot` refuses to leave them with
none — so the "I forgot it and there is no way out" state takes losing both.

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
- reset refuses when another granted slot exists, and points at re-enrollment instead (per the decision
  above, now settled);
- `VaultDecryptError` during a sync records `reauth_required`, not a generic failure.
