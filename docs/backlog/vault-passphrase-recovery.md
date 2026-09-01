# Vault passphrase recovery — "I forgot my passphrase"

**Status: complete (2026-09-01)** — the 2026-08-31 work (the destructive reset, vault recovery codes,
the `VaultDecryptError` classification and re-link adoption) plus the second pass below: the proof window
on all three doors that mint an unlock method, the passkey route to a new passphrase, and the
re-enrollment rung that had never executed. The decisions this file left open are settled inline, each
under a dated heading. The system as built is described in
`architecture.md` ("Token vault & transport security") and, for the connection handle,
`building-a-connector.md` ("Where the connection handle comes from"); what stays here is the *why* and
the rejected alternatives.

**Original framing (2026-08-13).** A forgotten vault passphrase is currently a dead end with
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

### Settled 2026-08-31: one code, and "used" means the slot is deleted last

The convention is single-use, and it is worth recording why, because the reasons transfer unevenly to a
vault slot:

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
means **the slot is deleted**, a real destructive step rather than a flag.

**One code, in one slot.** Each code derives its own KEK, so a set of N is N slot rows and therefore N
independent paths to the same DEK. The redundancy that buys is against losing a stored copy — but N
codes are written down together and lost together, so a set only helps where the copies are kept in N
places, which is not how recovery codes are actually stored. The 2FA set-of-ten answers a different
question: a sign-in code is spent at every login, a vault code once in a disaster.

**The hazard a single code appears to carry is real, and is designed out rather than padded around.**
The worry is the gap between entering the code and setting the replacement passphrase: if the slot were
consumed at unlock, a crash, a dropped connection or a distracted user in that window would leave the
code spent and the vault still shut — with a set, they could simply try again. The answer is that
recovery is **one request, not two**: `{code, new_passphrase}` arrive together and the steps run in an
order where every failure is safe.

1. Open the recovery slot with the code, recovering the DEK.
2. Write the new passphrase slot, sealed to that same DEK.
3. **Then** delete the recovery slot.
4. Issue and return a fresh code, shown once.

Ordering is what makes this safe, so no cross-database transaction is needed: a failure anywhere before
step 3 leaves the code untouched and the whole operation retryable, and a failure *at* step 3 leaves the
user holding both a working passphrase and a still-live code, which costs nothing. Step 4 closes the
other version of the same worry — someone who forgets the *replacement* passphrase is not back at the
dead end, because recovery hands them a new code on the way out.

### The code is generated material, and must not reuse the sign-in generator

`control_database.generate_recovery_codes` produces `os.urandom(5)` — 40 bits. That is sound for a 2FA
code, which is checked against a hash by a server that can rate-limit and lock out. A vault slot is the
opposite situation: its wrap is offline-attackable by anyone holding the control DB, which is the exact
threat the vault exists to answer. A vault recovery code therefore needs **at least 128 bits** of its
own entropy and its own generator. Reusing the sign-in one would quietly reintroduce the weak wrap that
`VAULT_PRODUCTION_MIN_LEN` was raised to eliminate.

Two properties follow from the code being generated rather than chosen:

- It carries **real entropy**, so the passphrase floor does not apply to it and the scrypt hardening is
  belt-and-braces rather than load-bearing.
- But the vault is only as strong as its **weakest** slot. A strong recovery code does not compensate
  for a weak passphrase; it adds a path, it does not raise the floor.

## The wrinkle: re-linking lands on a new connection row — but the mappings do survive

`connect` upserts on `(provider, external_id)`, so whether a re-link lands on the **existing** connection
row depends entirely on how that provider derives its handle:

- **A provider whose handle is issued by the provider** (Plaid's `item_id`) re-links onto the same row.
  The `ON CONFLICT ... DO UPDATE` path is a clean credential refresh and nothing is orphaned — **but only
  through Link update mode**, which the app did not have when this was written. A plain Link session mints
  a *new* Item, so Plaid was silently in the second category below until update mode was implemented
  (2026-08-31); see `building-a-connector.md`.
- **A provider whose handle is derived from the credential** — SimpleFIN's is
  `"sfin_" + sha256(access_url)`, because the access URL is the credential and cannot also be the public
  handle — gets a **new** `external_id` for a new token, so claiming a fresh setup token inserts a
  *second* connection row and strands the original.

**Corrected 2026-08-31.** This file previously said that stranding "requires re-mapping every provider
account onto its existing local account." That is wrong, and the correction changes what an adoption
feature is even for. Two mechanisms already carry the mapping across, and neither is keyed to the
connection:

- `record_provider_accounts` adopts on `account.external_account_id`, which is UNIQUE and durable, and
  writes `mapping_mode = 'existing'` on insert. A provider account whose handle is already held by a
  local account is therefore re-attached without the user deciding anything.
- Sync resolves each incoming row to a local account by `account.external_account_id` as well, not
  through the connection — so transactions land in the right accounts immediately.

Both depend on the provider reusing its **account** ids across a new credential, which for SimpleFIN
means the Bridge's account ids being stable across access URLs. That is expected but is not stated by
the protocol, and it has not been verified against a live bridge.

What a re-link genuinely loses is the state keyed to `connection_id`:

| survives | lost |
| --- | --- |
| account mappings (auto-adopted) | per-account coverage — `coverage_start_date`, `history_complete`, walk state, all on `connection_account` and keyed to the **new** connection id |
| transaction routing at sync | the connection's cursor, sync history and advisories |
| | `account.connection_id`, still pointing at the stranded row |

So the cost is not re-mapping: it is a **full history re-walk under the provider's rate budget**, plus a
duplicate connection card and a stale `account.connection_id`. For a metered provider that walk is the
expensive part, which is what makes the fix worth building rather than documenting.

**Decided and built 2026-08-31 — re-point the surviving row, and let the user confirm it.** The
existing row is `UPDATE`d in place — only its `external_id` and `credential_enc` are swapped — instead of
a new row being inserted. Everything keyed to `connection_id` survives untouched, because nothing keyed
to it ever moved.

Two alternatives were rejected. **Inserting the new row and migrating state onto it** does the same job
with more moving parts and a partial-copy failure mode. **Adopting silently, without asking**, was
rejected on the project's prefer-explicit-choice rule: which connection a fresh credential belongs to is
a decision that changes meaning, and mis-adopting would attach a credential to the wrong institution's
history.

**The constraint that shaped the implementation, found while building it: the question has to be asked
*before* the provider is called.** The original sketch had connect return candidates and a second call
commit the choice — which cannot work, because a claim or exchange is **single-use**. SimpleFIN says so
in its own error copy ("A setup token can only be claimed once"), and by the time the new handle is known
the authorization is spent, so there is no second attempt to act on a different answer. Three things
follow, and all three are in the code:

- The **connect dialog** asks up front, driven by a new declared capability, `stable_external_id`, so a
  future provider inherits the question by declaring the trait rather than by anyone editing the dialog.
- The answer rides the connect request as `adopt_connection_id`; the server takes a *decision*, never
  returns candidates for one.
- A **stale answer is absorbed, never refused** — a named connection since disconnected, or a handle that
  turns out to belong to another row, falls through to the ordinary upsert and reports `adopted: false`,
  which the UI states plainly. Refusing would be tidier and would cost the user their token.

One consequence worth knowing: `reauth_required` is deliberately **not** cleared by an adopting connect,
matching the ordinary upsert. The flag is retired by proof — a pull that returned data — and clearing it
on one connect path but not the other would leave the two disagreeing about what it means.

This is the same gap a user hits after any credential rotation, not only after a reset, which is why it
was worth building on its own merits.

## Open decisions

**Multi-user — settled by phase 5 (2026-08-13).** Slots are per-user but there is one DEK per workspace,
so one member forgetting theirs was never a reason to destroy the workspace's credentials — another
member's slot still opens the same DEK. That escape now exists and is cheap: the stuck user removes their
own slot (or an admin revokes it via `/auth/vault/access/{user}/revoke`), sets a new passphrase — which
enrols them, since they no longer hold a slot — and any unlocked member approves it. **No credential is
touched and nothing is re-linked.**

So the reset below **must refuse while another granted slot exists**, and say that a member who can unlock
is the way back. *(Superseded twice — scoped to the lost path on 2026-08-21, and downgraded from a refusal
to a named redirect on 2026-08-31. Both corrections are below; this paragraph is the original reasoning,
kept because the part about which path is **better** still holds.)* Wiping credentials that are still perfectly reachable would be the worse outcome, and the
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
| Passphrase lost, **another granted slot exists** | **Start with re-enrollment, but do not enforce it** *(revised — see the second pass below; as first written this row said reset "should not be offered", which is what produced the contradiction the dialog shipped with)*. Raise a fresh authorization request: the stuck user drops their own slot and sets a new passphrase, which re-enrols them, and any unlocked member approves it. Lead with it and name the member; proceed with the rebuild if the user says it does not apply. |
| Passphrase lost, **no other slot and no recovery code** | **Rebuild.** The genuine dead end this file was written for, and the row that vault **recovery codes** would remove almost entirely. |
| **Database or backup stolen**, regardless of who else holds a slot | **Rebuild, and allow it.** The point is to retire every credential by re-issuing it; another member's working slot does not make the old ones any less exposed. |

Two things follow. The first row is a *redirect*, not an error — the UI should start the request rather
than explain why the button is disabled, and (revised below) rather than refusing it outright. And reset
stays **admin-gated** in every row, consistent with the model's "admin gates settings, not data": it
destroys shared workspace state, so it is not a control any member should reach alone — which is also
why a second guard on top of that gate turned out to be redundant.

A second consequence: **a passkey is now the cheapest insurance against this whole scenario.** A user with
both a passphrase and a passkey has two independent ways in, and `remove_slot` refuses to leave them with
none — so the "I forgot it and there is no way out" state takes losing both.

**How hard to make it.** Irreversible, so: a typed confirmation, a count of the connections that will need
re-linking, and — first, above the warning — the statement that transactions and accounts are kept.

**Placement.** The locked `VaultStrip` beside Unlock is where someone actually is when they are stuck; a
link inside the unlock dialog is the other candidate. Not the unlocked strip: someone who can unlock is
looking for **Change passphrase**, which is already there.

### Revised 2026-08-31 (second pass): the other-member rule is a redirect, not a refusal

Found by using the dialog. The table above says a lost-passphrase reset must **refuse** while another
member holds a slot. Built that way, it produced this: the user reads "somebody else can open this
vault", presses a button labelled **"None of these — rebuild the vault…"**, types the confirmation, and
is told *someone else can still open this vault*. The UI offers "none of these" and the server answers
"yes, one of them does."

The wording was the symptom. Three things say the refusal itself was wrong:

- **It asserts something the system cannot know.** A `vault_slot` row proves someone *could* open the
  vault, not that they are reachable, still hold their secret, or are willing. This file already makes
  exactly that argument about the stuck user's *own* leftover slots — "a passkey on a lost phone, a
  recovery code they no longer have" — and it applies with equal force to another person's slot. The
  reasoning was applied to one case and not the other.
- **The authority question is settled elsewhere.** Reset is admin-gated *because* it destroys shared
  workspace state. A second guard that overrules the admin adds nothing to that boundary.
- **It was never a safety property.** The compromise path permits the identical destruction with other
  members present, deliberately. So the block only ever stopped a user who reported their situation
  accurately; anyone else selects the other reason and proceeds. A check that filters on honesty is not
  protecting the credentials.

**What replaces it.** The alternative is led with and, crucially, **named** — "frances can open this
vault", never "somebody else", because a name is actionable and a count is not. The rebuild proceeds if
the user says none of the rungs apply, and states the consequence they cannot see from their own screen:
there is one DEK per workspace, so it ends *every* member's access, and the result names who has to
re-enrol. `VaultResetRefused` and `users_who_can_unlock` are gone; the preview reads `vault_members()`
directly, which already carries display names.

A rung was also missing entirely: **the user's own passkeys**. Anyone reaching this dialog is thinking
about a passphrase, and a passkey opens the vault from a different button — so a user with one was being
offered a destructive reset while holding a free, immediate way in. `own_passkeys` on the preview now
leads the ladder.

### Settled 2026-08-31: the remaining reset questions

**A recovery code redirects, it does not block.** A recovery-code slot is not "another granted slot" for
the refusal rule above — it is the user's own rung, not another member's grant, and the person holding
it is not being asked to get anyone's agreement. So the lost-passphrase dialog names it first and points
at it, exactly as it redirects to re-enrollment when another member can unlock, but leaves reset
reachable: someone may have lost the code as well, and a hard refusal would rebuild the dead end one
level up.

**Reset clears `provider_config.secret_enc` too, not only connection credentials.** Both columns sit
under the same DEK, so once the slots are gone the app-level secret is as unopenable as the connection
credentials and leaving it behind is litter that yields `VaultDecryptError` forever. It is also the
cheaper of the two to replace — re-entered from the provider's dashboard, with no re-linking. The reset
must therefore drive off the `ENCRYPTED_COLUMNS` registry rather than naming columns inline, so a column
added later is cleared without anyone remembering to come back here; that registry already carries a
test that fails when a new column is not reached.

**The compromised path requires an unlocked vault, and says so rather than silently degrading.** Its
whole reason to exist is that revocation can run, and revocation needs the DEK. Asked for while locked,
it returns `423 vault_locked` and tells the user to unlock first — it must not quietly fall through to
the lost-passphrase path, which promises less and would retire the credentials without ever attempting
the revocations the user came for.

**The backup hint needs a new, unfiltered query.** The ladder's first rung wants to know whether *any*
credentials backup exists, because a backup taken under a **previous** passphrase is precisely the one
that still opens. The existing `credentials_exports_for_fingerprint` deliberately does the opposite — it
filters to the wrapping in force, and its docstring records why older exports are noise *for the
passphrase-change warning*. Both rules are right for their own caller, so this is a second query rather
than a change to the first.

## Reopened 2026-09-01: an unlocked session can mint unlock methods

The ladder above answers "the vault cannot be opened at all". It does not answer the case one step
short of that — **the vault opens, by some method, but the passphrase is gone** — and following that
gap turned up a wider one in how new unlock methods are authorized.

### The rule this section adopts

> Any method that opens the vault must also be able to set a new passphrase, and *only* a method that
> proves itself at that moment may add or replace one.

Measured against it, one half was missing and the other was too permissive.

| method | opens the vault | can set a new passphrase |
| --- | --- | --- |
| passphrase | yes | yes — the Change panel |
| passkey | yes | **no — no surface offers it** |
| recovery code | yes | yes, but only from the *locked* strip |

`VaultPassphraseDialog` gates its passkey button on `mode === 'unlock'`, and change mode hard-requires
the current passphrase. The comment there justifies the gate as "the other modes choose a NEW
passphrase, which a passkey cannot stand in for" — true of the *new* passphrase, but it also stops a
passkey standing in for the *old* one, which is the thing being proven. A passkey holder who has
forgotten the passphrase must therefore lock the vault on purpose to reach the recovery code, and a
passkey holder with no recovery code has no route at all.

### Rung 1 never executed

The other-member rung tells the stuck user to "set a new vault passphrase from the Connections tab —
that enrols you again". Nothing behind that instruction works:

- `set_passphrase` branches on `user_has_slot`, which is **true** for a forgotten passphrase — the slot
  still *holds* the DEK, it simply cannot be opened — so the call takes the `require_dek` path and
  raises `VaultLocked`. No enrollment is written and no request is queued.
- The locked strip offers Unlock and "Can't open it?" only. There is no control to press even before
  the refusal.
- `/vault/access/{user_id}/revoke`, which *would* clear the way, is admin-gated and refuses
  self-revocation — so where the only other member is not an admin, the rung is unreachable entirely.

The rung was reasoning about the *enrollment* case (a user who never had access) and was offered for the
*lockout* case (a user whose access is intact but unopenable), which are opposite branches of the same
function.

### The wider finding: three doors, one cached DEK

Hardening `set_passphrase` alone would have closed the loudest door and left two quieter ones. Three
operations mint a durable unlock method from nothing but a DEK found in the unlock cache:

| door | what an unlocked session can mint | how visible to the owner |
| --- | --- | --- |
| `set_passphrase` | a passphrase of the caller's choosing | **loud** — the owner's passphrase stops working |
| `register_passkey_slot` | the caller's own passkey | **silent** — the owner's methods are untouched |
| `issue_recovery_code` | a recovery code | near-silent — quietly retires the owner's code |

Each seals the real DEK into the new slot, so each converts **transient** access — someone at an
unlocked machine, or holding the session — into **durable, independent** access that survives lock,
relock and the owner's attempts to get back in. The DEK is unchanged, so every stored credential opens
under the new secret. The exposure window is `UNLOCK_TTL_SECONDS` (8 hours, sliding on use).

**Two narrower rules were considered and both are wrong**, which is why the decision below removes a
case rather than qualifying one:

- *"Refuse only when a passphrase slot that already opens would be replaced."* Misses a **pending**
  passphrase slot sitting beside a granted passkey: overwriting it seals the live DEK into a slot of the
  caller's choosing, with nothing "replaced".
- *"Only the first passphrase is safe."* A passkey-only member adding a first passphrase takes the same
  path, and the result is the same durable credential. Nothing is replaced there either.

The safe/unsafe line is not the state of the passphrase slot at all. It is whether authority is being
**derived from a cached DEK** rather than proven.

### Settled 2026-09-01

**Extended 2026-09-01 (third pass): four doors, plus removals.** The audit that followed asked what
*else* changes the unlock methods without proof, and found two things the mint-only framing had missed.
**`grant_access`** mints a durable method for somebody *else*, and has the shortest path to abuse of any
of them — with sign-in protection off: create an identity, set a passphrase on it (pending), approve it
from a session left unlocked, and walk away holding a permanent slot. **`remove_slot`** grants nothing,
so it sat outside the rule as written; but stripping every passkey and the recovery code leaves the owner
one forgotten passphrase from rebuilding every connection, and a rule with a carve-out is the one that
gets forgotten at the next call site. Both are now gated, each *after* its existing refusal (the DEK
check, the last-way-in check) so the answer names the step the user can act on.

Deliberately still ungated, each for a reason that survives the audit: `set_passphrase` (neither
surviving branch has existing access to escalate from), `rotate_dek` (re-seals the slots that already
exist and grants nothing new), `reset_vault` (admin-gated *and* behind a typed confirm phrase, a
deliberate act in a way a click is not), and the credentials export (copies ciphertext, never decrypts,
and the passphrase is asked for at restore).

**A recovery code can be discarded, not only replaced.** `issue_recovery_code` always replaces, so
"invalidate the one I wrote down" was only expressible as replace-and-then-don't-record — which leaves
`has_recovery_code` true, and that flag drives rung 2 of the ladder. The app would go on offering "use
your recovery code" as the free rung above rebuilding, to somebody who deliberately has none: a phantom
rung in a ladder whose whole value is being ordered by what the user can actually do. Replace-and-forget
also *renders* a fresh code on screen before abandoning it. `DELETE /auth/vault/recovery-code` routes
through `remove_slot`, so the last-way-in guard covers the reachable case where the code is the only
remaining access (issue a code, then remove the passphrase slot). Confirmed in the UI, unlike removing a
passkey — a passkey is usually one of several ways in, where the code is often the only rung left.

**1. Fresh proof to add or replace any unlock method — all four doors, and removals.** A passphrase or a passkey
ceremony, presented recently rather than at the instant of the change — see the five-minute window in the
second pass below, which is what keeps the cost to roughly one prompt per sitting.

**2. `set_passphrase` loses its `require_dek` branch outright.** Two cases remain, and neither derives
anything from the cache: the vault is unconfigured (mint the DEK — the first passphrase in the
workspace), or the caller holds no working slot (write the slot **pending**, opening nothing until a
member grants it). Everything else routes through a path that carries proof — `change_passphrase`, the
passkey endpoint below, or `recover_with_code`.

This **reverses a deliberate decision**, not an oversight: `test_resetting_own_passphrase_preserves_the_dek`
pins the removed behaviour and its comment reads *"unlocked, so this re-wraps"*. The test inverts to a
refusal that leaves the existing passphrase working. Recording it here so the reversal is not later read
as a regression.

**3. A passkey route to a new passphrase**, mirroring `/vault/recover` — `{credential_id, prf_output,
new_passphrase}` in one request, so there is no window in which the proof is spent and no passphrase
exists yet. The ceremony runs at that moment, making it a *fresher* proof than the typed old passphrase
it replaces. With decision 2 in force this endpoint is load-bearing rather than convenience: it is also
how a passkey-only member sets a first passphrase.

**4. Rung 1 becomes executable**, by letting a locked-out slot-holder write their passphrase slot
**pending** — the state the enrollment queue and the approve flow already serve, so no new endpoint and
no new member-side surface. Two conditions:

- The **server** refuses when no other member could grant it. Without that check the rung is a
  self-brick: the only working slot is destroyed and nobody can seal a DEK back into it. `reset-preview`
  already computes `other_members_can_unlock`; the check has to be enforced, not merely drawn.
- The request must say it **replaces an existing member's access**. A re-enrollment is indistinguishable
  from a new person enrolling in the queue as it stands, so someone at a locked-out user's session could
  put their own passphrase in the pending slot and wait for a routine approval. The escalation is
  inherent to "a locked-out person asks to be let back in" and cannot be designed away; what makes it
  safe is that the approver can see what is being approved.

The rung's fields belong **inline in the dialog**, as rung 2's recovery-code fields already are, rather
than as prose directing the user to a control that does not exist in that state.

### Settled 2026-09-01 (second pass): proof has a five-minute life

Requiring a secret at *every* boundary would be answered the way such prompts always are — by choosing a
weaker secret, or by resenting the feature. So proof carries a **five-minute window**
(`PROOF_TTL_SECONDS`): once presented, the three doors above stop asking until it lapses. Five minutes is
long enough to cover a run of related actions in Vault settings and short enough that an unattended
session is not an open door — against the unlock cache's own eight hours, the exposure drops by two
orders of magnitude.

**The stamp must not slide, and this is the property the whole control rests on.** `_cache_get_all`
refreshes `expires_at` on every read — that is what makes the unlock an *idle* window rather than a fixed
one. A proof stamp riding on that same field would be renewed by ordinary use and would never expire,
leaving a control that reads as enforced and is not. `proved_at` is therefore a separate absolute stamp,
written only where a secret is genuinely verified — `unlock`, `unlock_with_passkey`, `change_passphrase`,
`recover_with_code` — and never touched by a cache read.

**Unlocking counts as proof, which is what keeps the friction honest.** The ordinary path — unlock, open
Vault settings, add a passkey — falls inside the window and is never prompted. What gets prompted is
action taken on a session left sitting, which is exactly the case the doors are being closed against.

**The prompt accepts a passphrase or a passkey, never a recovery code.** A recovery code is single-use
and re-keys the passphrase on redemption; spending one to authorize adding a passkey would cost the user
their last rung to buy a routine action.

**Both sides track it; only one decides.** The split is safe because the two answer different questions:

| | question it answers | consequence of being wrong |
| --- | --- | --- |
| backend | *is this allowed?* | none — it is the decision |
| frontend | *should proof be asked for first?* | one redundant prompt |

- **Backend, definitive.** `require_recent_proof(user_id)` guards the three doors and raises a typed
  error carrying its **own** HTTP code. Deliberately not a reuse of `423 vault_locked`: the vault is
  open, and what is missing is recency, so the remedy differs — and `retriedAfterUnlock` already keys on
  423, so overloading it would make an unlock dialog the answer to a question unlocking does not ask.
- **Frontend, advisory.** `_session_payload` carries `vault_proof_seconds_remaining` (0 when none), so a
  surface can ask up front rather than only after a refusal. **Seconds remaining rather than an absolute
  timestamp**, so no clock agreement between server and browser is required and the client can run its
  own countdown. The client never judges sufficiency; a stale local copy costs one extra prompt and
  cannot produce a bypass.

**Proof is per user, not per session** — inherited from the unlock cache, which is keyed on `user_id`
and has no session dimension. So proof presented in one browser satisfies the doors in another for the
same person. Recorded as a decision rather than left as an accident: per-session proof would mean giving
the cache a dimension it has never had, for a distinction that does not match how the vault's own unlock
already behaves.

### Rejected 2026-09-01

**Another member's passphrase, typed into the stuck user's change dialog.** Cryptographically it would
work — every member's slot seals the same DEK. It is refused because it inverts the property
`grant_access` exists to provide: that call needs only the public key already in the row, so neither
person ever learns the other's secret. Typing member B's passphrase into member A's session puts B's
unlock secret into a browser A controls, and B's passphrase is not a one-time approval — it opens the
whole vault, permanently. Approval stays asynchronous and stays on B's own screen.

**A member's recovery code as approval authority.** Granting needs `require_dek(granter)`, and routing a
granter through `recover_with_code` would **consume their code and re-key their passphrase** — an
enormous side effect for approving somebody else. A granter unlocks however they normally unlock. The
stuck user's *own* recovery code is a different matter and is already rung 2, which needs nobody else.

**Adding the recovery code to the change panel.** Redundant once decision 3 lands: a user who can prove
with a passkey uses that, and a user with only a recovery code is served by the existing locked-strip
route. Worth revisiting only if the "lock yourself out to get back in" path is observed in practice.

### Tests

Service and HTTP in `test_vault_recovery.py` (`ProofWindowTests`, `PasskeyPassphraseTests`,
`ReenrolmentTests`), `test_vault.py` and `test_vault_endpoints.py` (`VaultProofEndpointTests`); the UI in
`VaultPassphraseDialog.test.jsx`, `VaultSettingsDialog.test.jsx` and `VaultRecoveryDialog.test.jsx`:

- a passkey sets a new passphrase in one request; the old one stops working, the DEK is unchanged and a
  stored connection credential still decrypts — the property that means nothing re-links;
- each of the three doors refuses a caller holding only a cached DEK and accepts the same caller with
  fresh proof — **one test per door**, since a single shared test would not notice the rule being lost
  on one of them;
- **proof expires on schedule and is not renewed by use**: still refused after repeated DEK reads that
  slide the unlock cache, with the vault asserted still open so the test cannot pass for the wrong
  reason. *Confirmed to fail against a deliberately broken build* — refreshing the stamp inside
  `_cache_get_all` turns three of these red, which is the regression the ordering exists to prevent;
- unlocking stamps proof, so the unlock → add-a-passkey sitting is never prompted twice;
- a passkey-only member can still set a **first** passphrase, by proof rather than from the cache — the
  flow decision 2 must not break;
- a weak replacement leaves the old passphrase working, on both the passkey and the recovery-code
  routes: the ordering property that makes a single-use proof safe;
- re-enrollment lands pending and marked `replaces_access`, is refused when nobody else could grant it,
  is refused for an open vault and for a user with no access to replace; after approval the DEK is
  unchanged;
- the UI asks for proof before the ceremony when its countdown has lapsed, **and** answers the server's
  `403 proof_required` when its own copy was wrong, running the held action once the secret is given;
- rung 1 submits from inside the dialog and names who must approve; it is absent when nobody could.

The `replaces_access` column is additive (`ALTER TABLE … DEFAULT 0`), so an existing control DB keeps
every slot row and reads `0` — verified against a table built from the pre-column DDL.

## Adjacent bug, worth fixing regardless

`VaultDecryptError` is caught nowhere. During a sync it falls into the generic `except Exception` handler
in `routers/sync.py`, which deliberately does *not* set `reauth_required` — that arm exists to avoid
drawing distinctions a user cannot act on. But this is precisely the distinction they can act on: a DEK
mismatch is unfixable by retrying and means re-link. Today it presents as an unexplained "this connection
has stopped working", which is the wrong story even before any reset feature exists.

## Tests

Covered by `backend/tests/test_vault_recovery.py` (service), `test_vault_endpoints.py` (HTTP), and
`frontend/src/components/__tests__/VaultRecoveryDialog.test.jsx` (the ladder's ordering and gates):

- reset deletes every slot, clears both encrypted columns, sets `reauth_required`, and leaves accounts,
  transactions and connections untouched (counted before and after);
- every `ENCRYPTED_COLUMNS` entry is reached, derived from the registry rather than listed — so a column
  added to the vault later fails this test instead of being left behind as unopenable litter;
- a new passphrase after a reset mints a *different* DEK, and ciphertext written before it never opens;
- a reset proceeds on **both** paths while another member can unlock, and reports whose access it also
  ended — the block having been removed in the second pass above;
- a reset ends *every* member's access, not only the caller's, since there is one DEK per workspace;
- the preview **names** the members who can unlock, and never names the caller;
- a recovery code opens the vault, re-keys the passphrase, leaves the DEK and every stored credential
  intact, and reissues; the spent code stops working and the reissued one works;
- **a rejected replacement passphrase leaves the code live** — the ordering property that makes a single
  code safe, and the one whose violation would be silent;
- `VaultDecryptError` during a sync records `reauth_required` with an actionable message, not a generic
  failure.

Three of these were confirmed to fail on the corresponding broken implementation before being trusted:
the ordering property (consume-then-write), the registry sweep (clearing only the first column), and the
sync classification (with the arm removed).

Re-link adoption is covered by `backend/tests/test_connection_relink.py` and the
`relinkCandidates` / `connectionAccountsLabel` cases in `connectionSummary.test.js`:

- a re-link without adoption still lands as a second connection, and the new row starts with **no**
  coverage — the defect pinned, since it stays correct for a user genuinely adding a second source;
- adoption re-points the surviving row: one connection row, the new handle and credential on it, and the
  coverage, cursor, mapping and `account.connection_id` all untouched;
- both staleness cases fall through to an ordinary connect rather than refusing, because the
  authorization is already spent by the time either is known;
- the two real adapters declare opposite answers, so a new adapter inheriting the default lands in the
  safe direction (no question asked).

**Still owed:**

- reset → set → restore a credentials backup taken under the old passphrase re-keys the credentials and
  leaves the connections syncable, which is the whole first rung of the ladder.
