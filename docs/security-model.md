# Security model

The assumptions the security design rests on: what is defended, what is deliberately not, and the
conditions under which a decision here has to be reopened. This is the **maintainer** record. It is
written to be read before changing anything that touches credentials, the login perimeter, transport, or
backups — including "I am only adding a provider".

**Three other surfaces describe security, each written for a different reader.**

| Surface | Audience | What it holds |
| --- | --- | --- |
| `README.md` → *Security* | someone deciding whether to run Luma | the model in plain terms: what protects what, what a leak means |
| `SECURITY.md` | someone reporting a vulnerability | reporting route, supported versions, what is in scope, and the deliberate design properties that are **not** vulnerabilities |
| `architecture.md` → *Identity, access & deployment model* / *Token vault & transport security* | someone changing the code | the mechanism **as built** — tables, endpoints, constants, call order |

What this document records is the reasoning underneath: why provider credentials are encrypted while the
ledger beside them is not, which risks are accepted rather than defended and what each one costs, what
the perimeter assumes about the network it sits on, where each secret lives and who can reach it, and
what recovery looks like when a passphrase is lost or a host is compromised. Its purpose is to put that
reasoning in front of whoever changes the design next, so a premise is abandoned deliberately rather than
by accident.

Where a fact is about *how it works*, this document links to `architecture.md` rather than repeating it:
two copies of a mechanism drift, and the copy that goes stale is the one nobody runs.

---

## What is defended, and what is deliberately not

The whole model follows from one premise: **the machine it runs on and the network it answers on are
controlled by the operator and closed to the public.** That is usually a personal machine or a box on a
home LAN, but the premise is those properties rather than the address — a private cloud instance nobody
else holds an account on or a route to satisfies it just as well, while a shared desktop or an instance
published to the internet does not.

- **The ledger is plaintext at rest, and that is accepted.** Transactions, categories, rules, tags,
  mappings and import history sit unencrypted in SQLite. Anyone with the database files or disk access
  can read them. Protecting the ledger at rest is explicitly not a goal: it would need pervasive field
  encryption or whole-database encryption, and both are out of scope.
- **The login perimeter is network-access control.** It governs who can reach a
  *running* instance.
- **The server is trusted, and the crypto runs server-side.** The unlock secret reaches the backend,
  which derives the KEK, unseals the DEK and uses it. This defends **theft of the data at rest**. It does
  not defend a compromised *running* host — and that is the correct trade here, because "someone owns the
  box this runs on" is a state in which the ledger is readable off disk anyway. **What is given up is
  more than the ledger, though:** while a user is unlocked the DEK sits in process memory, on a sliding
  idle window sized for a working day, so an attacker on the box reaches the provider credentials too.
  Nothing here defends that, and no passphrase floor can.
- **The backend is assumed not to be public-internet facing.** If an operator exposes it, the app
  password becomes far more load-bearing than this model assumes. That is the operator's call, and the
  onboarding copy says so.

The property the vault does buy is narrow and worth stating exactly: **a leaked database is not a leaked
credential.** No live unlock secret ⇒ no KEK ⇒ nothing opens.

## Why provider credentials are the only things encrypted

**The credential's reach is not known, and cannot be.** Luma only reads transaction data, but what the
credential is *authorized* for is the provider's to decide and is not visible from here — it may, and often does, reach
account and routing numbers, identity, or the ability to move money.

**So every provider credential is treated as though it carries full account and identity access**, and
protected accordingly with one unconditional passphrase floor.

Exactly two columns are encrypted under the workspace DEK — the per-connection credential and the
app-level provider secret. **The second is the wider of the two**: an app-level secret is not scoped to
one connection, so its loss reaches every connection made under it and the ability to authorize more.
They are registered in `crypto_service.ENCRYPTED_COLUMNS`, and that registry is an invariant rather than
a convenience: rotation, reset and the backup paths are all driven off it, so
**a third encrypted column that is not registered is silently unreachable by all three**. A test fails if
one is added without being listed. Add the registration in the same change as the column.

## Revocation, in both directions

**Whether disconnect actually revokes is a per-provider fact the app has to state rather than hide.**
Adapters declare `revokes_on_disconnect` and the disconnect confirmation reads it, because **a user who
believes access ended when it did not is worse off than one who knows to go and revoke it.** A provider
with no revocation call is an ordinary supported case — one live provider is exactly this — and the remedy
is unremarkable once known: revoke the token at the provider, rotate the vault passphrase and key, then
re-link.

### Responding to an exposure

**How a leaked credential is retired is the provider's to define, so each step follows that provider's
documentation on how its credentials are deactivated.** Nothing here generalizes from one provider to the
next: whether a credential can be replaced without the user authorizing again, and whether an old secret
dies when a new one is issued, are facts read from the provider, recorded as adapter capabilities where
code acts on them. A new provider's exposure handling is designed from its own documentation, never by
analogy with an existing one.

**A provider with an app credential holds two levels of authorization**, and they are retired separately.
Plaid's are the app's client id and secret, and the per-connection access token the bank login produced;
a token is usable only together with the secret. As its documentation describes them:

- **The token** can be replaced with no bank login (`/item/access_token/invalidate`: a new token, the old
  one dead at once), which the adapter declares as `reissues_credential`. Revoking it (`/item/remove`)
  retires it just as surely but ends the Item, so the connection has to be linked again.
- **The app secret** is not per-connection, and nothing done to a connection touches it. It is rotated on
  the provider's dashboard, and **the old one keeps working until it is deleted there** — so the step is
  rotate, enter the new one with Configure, then delete the old one. Rotating alone retires nothing.

**With the vault open, the response replaces rather than revokes.** *Vault settings → Respond to an
exposure* (`POST /auth/vault/reissue-credentials`, `services/exposure_response.py`) reissues each
connection's credential where the provider declares it can, so the copied credentials die while every
connection keeps syncing, and lists what is left: connections whose provider cannot reissue (revoke at the
provider, then reconnect), each stored app secret, a fresh credentials backup when an older one exists (it
would restore the retired credentials), and then the passphrase change and key replacement, which protect
the newly issued credentials. It is refused while a sync is running, since that pull holds the credential
being replaced, and it stores each replacement the moment it is issued, because the old one is already
dead. It does not replace the vault reset, which remains the only route for a **forgotten** passphrase:
there nothing can be decrypted, so nothing can be sent to a provider.

**The app secret is always left to the user, on either path.** The reset's *exposed* result lists each
stored secret under *Still to do at the provider* too. Both read the list from what is stored
(`exposure_response.app_secrets_to_rotate`) rather than from a capability, since a secret never saved was
never exposed. An ordinary disconnect exposes nothing and asks for none of this.

**Checked in the sandbox (2026-09-19): Items survive a secret rotation, and deleting the old secret stops
syncing as well as linking.** With the old secret deleted, both a sync of an existing Item and a new link
were refused (`INVALID_API_KEYS`). Once the new secret was entered with Configure, the same Item synced
again without being linked again. A copy holding the old secret therefore loses its existing connections
too, not only the ability to link new ones.

**The reverse direction — the user revokes at the provider — is not symmetric either.** Nothing announces
it; Luma finds out only when a request is refused. A refused credential raises
`ProviderCredentialRejected` and sets `reauth_required`, so the card reads **reconnect needed** rather
than accumulating generic sync failures. This matters *more* for a provider with no revocation call: where
revocation normally happens through Luma the connection is simply gone, but where it happens elsewhere
this refusal is the only notice there will ever be, and a connection left counting failures after a
deliberate revocation reads as broken rather than as closed.

## Identity and the network perimeter

**Login is an authentication perimeter, not an authorization system.** Its only job is to keep *non-users*
out. Once inside, every user sees and edits the same data with no row- or scope-level restriction, and no
data route checks role. **Admin gates settings, not data** — user management, provider/environment
settings, and the operations that replace the workspace wholesale: every restore path, and the backup keys
that decide who can read a backup. A restore is not a data edit. It swaps out every row, the connections
and the provider configuration at once, so it is a settings-scale act somebody has to be able to
authorize, and before it was gated any signed-in member could replace the global provider configuration
through the legacy credentials restore. The guards live in `backend/authorization.py`; with sign-in
protection off there is no role to hold, and they pass. Do not add an authorization check at the data
layer expecting it to mean something; there is no scoping model behind it for it to enforce.

**"Password optional" is a workspace property, never per-user.** The data is shared, so if one identity
has a password and another does not, anyone on the LAN picks the passwordless one and reads the same
ledger — the password would have protected only that person's *preferences*. A per-user perimeter over
shared data is incoherent, so the optionality lives one level up.

**Three concepts look like one and are not. Do not couple them.**

- *A user identity* scopes **per-person UI preferences** and carries that person's own **app-access
  credential**. Those are its only two jobs; it confers nothing about the vault.
- *A vault access grant* is what lets a person open the vault at all. The data sources themselves are
  shared and visible to everyone; what the grant confers is the ability to **use** them — connect one,
  sync it, refresh its accounts, disconnect it, reveal an app secret — because every one of those has to
  decrypt a stored credential first. A user without a grant sees the same connections as everyone else
  and can operate none of them.
- *An app password* is **network-access control** — it establishes who is at the browser, never authority
  over encrypted data.

**An unlock belongs to the browser session that presented the secret, not to the identity.** Picking an
identity takes no credential while sign-in protection is off, so an unlock filed under the user alone was
inherited by anyone who picked that name on another browser while its owner was unlocked — and inside the
five-minute proof window, with it the authority to add a passkey of their own to the owner's slot, which is
durable access. The unlock cache and the proof stamp are therefore keyed by user *and* the browser's
sign-in session id (`crypto_service` → the unlock cache; the id is described below), and selecting an
identity, signing in and signing out each start a new one. Each browser unlocks for itself and tabs share. Signing out or
locking affects only that browser; revoking someone's access, or re-enrolling them, ends it in every
session; a key rotation locks every session but the one that ran it, since the key they hold opens nothing
afterwards. The same keying applies with sign-in on, where sharing would let a stolen app password reach the
vault while its owner was unlocked elsewhere.

A trusting household can therefore be entirely passwordless and still need vault grants, so **no design
may assume a member has an app password.** The vault is orthogonal to the perimeter in both directions: a
passwordless install can hold vault-encrypted credentials, and an authenticated one can have no vault.

**A session is a row the server can delete, not only a cookie it can verify.** The cookie is signed, and
a signature says only that the server once issued it; with nothing stored, a copy taken earlier stayed
good for the cookie's whole two-week life, whatever its owner did. Each sign-in now records a
`sign_in_session` row in the control DB and puts its id in the cookie, and a cookie whose row is gone is
signed out (`services/sign_in_sessions.py`). Signing out deletes the browser's row, so it ends every copy of
the cookie at once. Setting an account's password or disabling it deletes all of that account's rows in
the same transaction as the change (`control_database.update_user`), because both are how somebody else's
access to an account is ended. The one exception is the session making the change when it is the account's
own, so changing a password does not sign out the browser it was changed from. **The row holds a SHA-256 of the id,
never the id.** Unless `SESSION_SECRET` is set, the signing secret is stored in the same database, so a
copy of the file lets anyone sign a cookie; the digest is what stops that copy also supplying an id a row
would accept. A signed cookie that names a user and no live row — one forged with a leaked secret, or one
issued before sessions were recorded — is refused like any other. **Every sign-in path goes through
`sign_in_sessions.start`**, and one that set `user_id` on the session directly would produce exactly that
refused cookie.

**Every secret a person types is limited against guessing** (`services/attempt_limiter.py`). The
perimeter is optional, and a networked deployment is where it has to hold up. A six-digit authenticator
code is strong only because an attacker gets a handful of tries: three codes are accepted at any moment,
and each blind guess lands with about a 3-in-a-million chance whichever code is current, so rotation does
nothing to an unlimited stream of guesses. The rules are per account. Attempts are at least two seconds
apart, a spacing claimed before the secret is checked, so a burst of simultaneous requests is refused
rather than tried. Five wrong secrets in a row pause the account for five minutes, and the pause refuses
the *right* secret too, since answering it differently would tell a guesser which one it was. Together
they hold a guesser to about one attempt a minute. **A limited attempt is refused at once with the wait
(429, `Retry-After`), never held open**, because a held request occupies a server thread and enough of
them would lock everyone out. Counts live in process memory, which a restart clears and an attacker
cannot trigger.

The limit covers:

- **Sign-in passwords**, keyed by the name as typed, so a name with no account is limited exactly like a
  real one. A refusal with no password to check spends the same key stretching a real check would
  (`control_database.spend_password_check`), so the response time does not say which names are real
  either.
- **Authenticator and 2FA recovery codes**, at sign-in and on the signed-in changes to two-factor itself
  (turning it off, replacing the recovery codes), so a stolen session cannot guess its way to switching
  the second factor off. A pause at sign-in also drops the pending challenge, so continuing needs the
  password again, and the pause is the account's, so proving the password again does not restart the
  count. A code is accepted **once**: the step it belongs to is recorded, and a code from that step or an
  earlier one is refused, which closes the minute and a half in which a code read off a screen could be
  replayed.
- **The vault passphrase and the vault recovery code**, on unlock, on a passphrase change (the old one is
  checked) and on recovery. The main threat to a vault passphrase is still an offline attack on a copied
  control DB, which no online limit reaches; this closes the online route for a session left open.

Left out, each for a reason:

- **Passkeys**, for sign-in and for the vault. Neither can be guessed: sign-in verifies a signature, and a
  vault passkey presents a 32-byte PRF output. Sign-in by passkey also stays open while the account's
  password is paused, which is what gives its owner a way in while someone else keeps it paused.
- **The code that confirms two-factor setup**, checked against a secret the same session was just given.
  Guessing it gains nothing a caller does not already hold.
- **The passphrase that opens a credentials backup file.** Whoever holds the file can attack it offline.
- **Guessing across many names.** The limit is per account, so each name guessed gets its own five
  attempts. A limit across all accounts would let one caller pause everyone's sign-in, and a
  per-address limit is no limit at all behind the reverse proxy a networked install sits behind, where
  every request arrives from the proxy's address.

**Accepted cost: anyone who knows a username can keep that account's password sign-in paused.** That is
the price of keying by account, and a registered passkey is the way around it.

## Passkeys and the second factor

**A passkey signs in, and it also stands in for the authenticator code.** The ceremony runs with user
verification *required*, so the authenticator itself demands a biometric or a PIN before it will produce
an assertion — which establishes possession of the device **and** something inherent or known. That is
what the TOTP prompt after a password exists to establish, so asking for a code as well would charge
twice for the same guarantee. `_USER_VERIFICATION` in `services/app_passkey.py` is therefore the
load-bearing setting in that file rather than a hardening default: relax it and the sign-in silently
becomes possession alone, with the factor it replaced already gone.

**The convenience is the security argument, not a trade against it.** The perimeter is optional — see
*"Password optional" is a workspace property* above — and what pushes a household into turning sign-in
off is friction. A login that costs a fingerprint makes keeping the perimeter **on** cheaper than
switching it off, which is a real gain delivered through adoption rather than through credential
strength. An argument that measures only the strength of the credential cannot see it, which is how an
earlier rejection reached the wrong answer: *"a passkey would be security theater over a plaintext
ledger"* is sound about whether it is a *stronger* credential and says nothing about whether it is a
better way to sign in.

**A passkey is never the only credential.** A bare-IP host can never register one however it is served
(*Obstacles*), so an install reached at `192.168.x.x` would otherwise have no way in at all. The password
remains the floor, every account keeps one, and the passkey is strictly additional.

**The two passkey features must not become one.** The vault's passkeys and these look identical on
screen and mean entirely different things — one opens encrypted data-source credentials, the other
crosses the login perimeter — so they keep separate endpoints, separate storage (`app_passkey` versus
`vault_slot`) and separate copy. Merging the ceremonies is the tempting shortcut and it is the exact
coupling *Do not couple them* forbids: signing in would imply vault authority. A user who holds both is
prompted twice, deliberately.

**Keeping them apart has to hold on the device, not only on the server.** A device keeps one passkey list
per *host* — not per install, per port or per feature — so the vault's passkeys, the sign-in passkeys and
those of every other Luma database served on the same host all sit in one list. Three rules follow, each
learned from a chooser that offered four identical entries of which one worked:

- **A sign-in passkey has its own user handle**, derived from the account id rather than equal to it
  (`sign_in_user_handle`); the vault's passkeys keep the account id. The handle is how an authenticator
  decides two passkeys are the same account, and the authenticator protocol lets it replace a stored
  passkey when a new one arrives for the same site and handle — the synced password managers do exactly
  that. A shared handle would let adding one kind silently delete the other from the device. Sign-in also
  refuses an assertion whose returned handle is not its owner's, which is the WebAuthn verification
  procedure's owner check and the one the library leaves to the caller.
- **Sign-in names its credentials.** The sign-in ceremony's `allowCredentials` lists every sign-in passkey
  in the workspace, so the device offers only those, and with one registered skips the chooser entirely.
  This reverses a first choice to send no list, made so an unauthenticated caller could not learn how many
  sign-in passkeys exist. That is still what the list reveals — a count and some opaque ids, neither of
  which can produce an assertion — and hiding the size of the household is not what the perimeter is for;
  keeping non-users out is. An empty list is never sent: to a browser it means *any* passkey, which is the
  whole-host chooser the list exists to prevent.
- **Each kind is labelled as what it is** ("name (Luma sign-in)", "name (Luma vault)"), since the device's
  chooser and its saved-passkey list show that label and nothing else.

**Their reach differs in the direction people expect least.** Sign-in needs only a plain assertion,
while a vault slot needs the PRF extension — so an authenticator that cannot hold a vault slot at all can
still sign in, and the *login* feature is the one that works on more devices.

**Removing a login passkey takes no proof, and that is not an inconsistency.** Stripping a vault slot is
gated because it can strand encrypted credentials; nothing is stranded here, the password still opens the
account, and the likeliest reason anyone reaches this screen is a device they no longer have — so a gate
demanding the missing authenticator would fire exactly when it must not.

**A session's *timestamp* is not part of what secures it, and a clock is not a trustworthy witness.**
The session cookie is secured by its signature; the timestamp inside it is signed data, unforgeable
without the secret, and its only job is to bound how long a session lives. `itsdangerous` nonetheless
rejects a stamp in the **future** (`age < 0`) exactly as it rejects a stale one, and Starlette's
`SessionMiddleware` answers *either* failure with `session = {}` — which downstream is indistinguishable
from having sent no cookie at all, so the user is silently signed out with no explanation. A wall clock
that steps backwards therefore invalidates every session signed in the window it skipped, for exactly as
long as the step: a laptop resuming from sleep, a VM restored from a snapshot, any NTP correction. This
was live for months and was found only because the browser suite failed on it about one run in eleven.

`ClockSkewTolerantSigner` (`backend/session_signing.py`) accepts a stamp up to five minutes ahead, which
costs only that much extra session life and no security property whatsoever. Two things about it are
worth carrying rather than rediscovering: **the fix cannot be made by adjusting `get_timestamp`**, which
supplies both sides of the age subtraction and so cancels itself out — only the comparison can be
widened; and **`max_age=None` is not the cheap alternative**, because Starlette derives the browser's
own `Max-Age` attribute from the same parameter, so disabling the server-side check also surrenders the
cookie's declared lifetime.

**A diagnostic on the rejection path must use the same primitives as the path it explains.** The reason
this took eleven runs is that "no `user_id` on the session" named three unrelated causes at once — no
cookie, an unverifiable one, and one that verified but carried no identity — and reported them
identically. What resolved it was a verdict logged from *this process, with its own secret*
(`_reverified_here` in `backend/main.py`), and it answered on its first firing. It signs with the
middleware's signer for that reason: a diagnostic holding a different signer would report an expiry the
app never acted on.

**A protection that can be switched off must not destroy the state needed to switch it back on.**
Enabling and disabling sign-in are both flag flips: a user with no password is the same row as one with
a password, holding a deliberately unusable sentinel, so disabling leaves hashes dormant rather than
discarding them and re-enabling is never a migration. Anything else with an on state and an off state
inherits this — the off path may not consume what the on path needs.

## Secret custody

The mechanism is in `architecture.md`. What belongs here is why the shape is what it is, and the rules a
change has to respect.

**A slot holds a keypair, not a wrapped DEK.** Wrapping the DEK directly under each slot's KEK works for
unlocking and for nothing else, because a wrap made from someone's own secret can only ever be made *by*
them. Two things follow, and both are the reason the indirection exists:

- **Rotation is impossible under direct wrapping.** Re-wrapping a new DEK for every *remaining* member
  needs each of their secrets, which the rotating user does not have. It could only ever have destroyed
  every other slot and forced everyone to re-enroll.
- **Access cannot be granted.** Every hand-over scheme then has to move a *secret* between two people
  instead, which is where bearer codes, expiries, single-use and revoke paths come from.

Sealing the DEK to a slot's public key dissolves both. Anyone holding the DEK can seal it for anyone else
from their public key alone, so **nothing secret ever moves between people.**

**The passphrase floor is unconditional — there is no weak tier and no test-mode exemption.** An earlier
design keyed strength to provider mode, on the reasoning that a throwaway passphrase costs nothing when
the credentials are fake. Two things killed it. A conditional floor has to be right at *every* gate that
guards it and stay right as providers are added — the connect path, the environment switch, and each
adapter's judgment about whether its own credentials are live — while an unconditional floor cannot be got
wrong. And the tier's removal is what lets the model *say* something a user can hold: "a strong passphrase
protects your data-source credentials" is a rule; "your requirements depend on which environment your
provider is pointed at" is not, and it invited the exact confusion where sandbox credentials feel like a
rehearsal for the real thing. The consequence is deliberate: **connecting a live data source always
requires a vault passphrase, even on a passwordless install.** "Store real bank credentials with zero
secrets" is precisely what must be impossible.

**One stored secret is readable back on request; the other never is, and the asymmetry is the point.**
An app-level credential is one the operator *owns and can already read on the provider's dashboard*,
and the only question a reveal answers — does what Luma holds match what the dashboard shows — is a real
diagnostic nothing else can settle. A per-connection credential has no such counterpart: it is live bank
access with no dashboard to compare against and no reason a human would ever read it. So there is a
reveal for one and there must never be one for the other.

Three properties keep that exception narrow, and a change that breaks any of them widens it:

- It is a **separate call**, never a field on a status payload, so plaintext can only appear in a
  response that explicitly asked for it.
- It **reuses the same decryption path a sync takes**, so there is exactly one way a stored credential
  becomes plaintext.
- It takes **no second challenge when the vault is already unlocked** — an unlocked vault is this app's
  authorization boundary and sync, disconnect and refresh all ride it, so re-prompting only here would
  add friction without raising the bar.

**The vault is only as strong as its weakest slot**, which is why the floor is an all-slots property and
why a high-entropy recovery code does not compensate for a weak passphrase. A generated code adds a path;
it does not raise the floor.

**There is no escrow and no required fallback.** Losing every way in costs the data-source connections,
which are re-linkable; the ledger is untouched. No slot exists purely as an escrow. But **"no escrow" is
not "no exit"**: what is unrecoverable is the *keys*, and that says nothing about what the app owes a user
who reaches that state. Conflating the two yields a vault that shuts permanently with nothing on screen to
say so, and "re-link" as advice the UI offers no way to act on. See *Recovery and compromise response*
below.

## Enrollment, grant, revocation and rotation

**The order is inverted from an invite.** The person who wants access acts first — enrolling writes their
keypair with no sealed DEK — and a member who holds the DEK approves. A grant addressed to an
already-published public key has **no window in which a third party could claim it**, which any
bearer-code scheme has to accept and then bound with expiry and single-use.

**"Co-present" and "invite" are not two mechanisms.** They were two answers to "how does the secret get
there", and no secret travels. What remains is one flow at two tempos: standing at the same machine, or
approving later from anywhere.

**Removing a slot is not enough for a hostile departure.** A departing member may have seen the DEK while
the vault was unlocked, and removing their slot cannot un-see it. The response is **remove access, then
rotate**, in that order, because rotation re-seals for whatever slots are present when it runs. Rotation
cannot undo *past* access, so a genuinely hostile departure also implies re-linking the affected sources.

**Rotation crosses two databases, so it cannot be a transaction.** Slots live in the control DB and the
ciphertext in the data DB, and no transaction spans both. A failure between the two writes would strand
every credential under a key no slot can produce — the total loss the whole design exists to avoid. The
three-phase order (seal the new key into every slot while retaining the outgoing one, rewrite the
ciphertext, then clear the previous seals) leaves every row readable under one of two keys at every
instant. **An interrupted rotation is resumed, never restarted:** starting fresh would push the key the
ciphertext is actually under off the end of the two a slot can hold, converting a recoverable state into
the unrecoverable one.

## Authorizing a change to how the vault opens

> Any method that opens the vault must also be able to set a new passphrase, and **only a method that
> proves itself at that moment** may add or replace one.

This rule was arrived at late and reverses an earlier deliberate decision, so it is worth stating why an
unlocked vault is *not* sufficient authority. Several operations mint a **durable** unlock method — a
passphrase, a passkey, a recovery code, a grant to somebody else. Each seals the real DEK into a new slot,
which converts **transient** access (someone at an unlocked machine, or holding the session) into
**durable, independent** access that survives lock, relock, and the owner's own attempts to get back in.
The DEK is unchanged, so every stored credential opens under the new secret.

**The safe/unsafe line is not the state of the passphrase slot.** Two narrower rules were tried and both
are wrong — see *Considered and rejected*. The line is whether authority is being **derived from a cached
DEK** rather than proven.

Two further findings generalize past the vault:

- **Removals need the same gate as additions.** Stripping every passkey and the recovery code grants
  nothing, so it sat outside the rule as first written — but it leaves the owner one forgotten passphrase
  from rebuilding every connection. A rule with a carve-out is the one that gets forgotten at the next
  call site.
- **Proof has to have a life, or it will be answered by weakening the secret.** Demanding a secret at
  every boundary is answered the way such prompts always are: by choosing something shorter, or by
  resenting the feature. A five-minute window (`PROOF_TTL_SECONDS`) covers a run of related actions in one
  sitting while leaving an unattended session two orders of magnitude less exposed than the unlock cache's
  own eight hours.
- **The stamp belongs to the session that presented the secret**, exactly like the unlock (see *Identity
  and the network perimeter*): a proof earned in one browser authorizes nothing in another, including a
  browser that has picked the same identity.
- **The stamp must be absolute, not sliding.** The unlock cache's TTL is pushed out on every read, so a
  proof stamp riding on it would be renewed by ordinary decryption and never expire at all. This is the
  property the whole control rests on.

## Transport security

**TLS is a property of the deployment topology, not a mode the app toggles.** The backend always speaks
plain HTTP; whether that HTTP is wrapped is decided at the edge. Loopback needs no TLS and gains nothing
from it but self-signed warnings. A networked deployment terminates TLS at a reverse proxy. "The
deployment is HTTPS" and "the app is HTTP" are both true at once.

**Topology is detected per request, not chosen.** Standalone versus client-server is just *"did this
request arrive over loopback or over the network?"* — which is strictly more correct than a stored preset,
because the same install is loopback from its own box and networked from another. The one genuine user
choice is forward-looking — *will you connect a data provider?* — and it has to be asked ahead of time
because standing up HTTPS is not instantaneous and the requirement cannot first be discovered at
connect-time.

**The permissible-HTTP rule.** Plain HTTP on a non-loopback bind is an acceptable operator choice **only
when both** hold: no data provider is configured (no live credential on the wire), **and** the instance is
passwordless (no login credential or session cookie to steal). The coupling is the point — the reason to
run a perimeter is distrust of who can reach the box, and that same distrust makes a sniffable, replayable
**session cookie** unacceptable. Protecting only the login exchange protects nothing, because the cookie
is a bearer token on every authenticated request. So HTTP is coherent only where there is no perimeter to
defeat; enabling sign-in or connecting a source implies HTTPS.

**Enforcement is split from preparation, deliberately.** The declaration drives *preparation* (setup
guidance and a computed task); real HTTPS availability drives *enforcement* (the connect gate). Coupling
them would either block a user who has not declared anything or wave through one who declared and never
configured.

**Recommended versus required is a real distinction and the UI must keep it.** For plain client-server
HTTPS is only recommended — it protects the login credential, which is the operator's call on their own
network — so that reminder can be dismissed from Tasks without configuring anything, and it mentions that
passkeys need HTTPS too. Where a data source is involved it is required and never dismissible.

**Passkeys make the host name load-bearing, and the failure is silent.** WebAuthn needs a secure context,
and an RP id must be a **domain**. Two consequences that look like packaging trivia and are not:

- Hand the browser `localhost`, **never** `127.0.0.1`. An address is not a domain, so the numeric form
  disables every passkey vault slot with nothing visible to explain why. The RP id is the host alone, so a
  dynamically chosen port does not invalidate a registered passkey.
- On a LAN, an address like `192.168.x.x` can never host passkeys however it is served, and a hostname
  alone still fails the secure-context check. **mDNS and HTTPS are the pair that makes passkeys reachable
  over the LAN** — neither is optional polish and neither works without the other.

Both are detected server-side and returned as *stated reasons*, because the answer to each is "use a
passphrase on this connection" and a raw browser exception would never say so.

**The two development servers bind differently, and neither is an oversight.** The backend keeps a wide
bind because LAN reachability is a supported deployment and topology is a detected per-request fact — a
socket pinned to loopback would make the networked half of this model unreachable and untestable. The
frontend dev server binds loopback for an unrelated reason that is **not** about Luma's perimeter at all:
a known esbuild advisory (**GHSA-67mh-4wv8-2f99**) lets any page the developer visits reach the Vite dev
server and read the responses. That is a third-party toolchain hole on the developer's machine, not
fixable short of a major upgrade, so narrowing the bind is the mitigation. Testing from another device
stays available as one environment value (`FRONTEND_HOST`) rather than an edit.

## Secrets in backup and export

**The vault's own design splits a backup in two, and this is a design requirement rather than a naming
choice.** The credential ciphertext lives in the data DB; the key material that opens it lives in the
control DB. That split *is* the leaked-DB-≠-leaked-credential property, and it means a data-only backup
carries credentials that are **dead on arrival** anywhere else. A snapshot that can actually sync after
restore needs the ciphertext, the vault slots, **and** someone who knows the passphrase that was in force.

**The data backup carries each connection's non-secret half, and nothing in it opens anything.** It holds
the provider handle, what the last sync did, and the resume point, so a restore can return a connection to
its backed-up state (`data-model.md` → *Backups*). A handle and a resume point are positions, not access:
every request to a provider needs the credential, which only the credentials backup carries — and only as
ciphertext. So an unencrypted data backup reveals which institutions are linked, which its transactions
already reveal, and grants no way to fetch more.

**A leaked secrets backup is a pair of offline brute-force exposures, and they reach different things.**
Login password hashes gate the *perimeter*; they are not a path to the credentials. The credentials fall
only if the **vault passphrase** is cracked through the wrapped key material. This is why the passphrase
floor is where the strength requirement lives, and why a credentials export's security simply *is* that
passphrase's strength — which is why the strength flag rides along in the payload.

**A credentials export carries one slot — the exporter's.** Within the install that made it none of this
matters, because the live DEK opens its own backups whoever exported them. Cross-install, only that
person's passphrase opens the file. Whether it should carry every member's slot is **open** — see below.

**Restore must never cost the operator their way in.** When a restore includes identity data, the
invariant is that *the operator always retains a working admin login*: the current admin is preserved and
the backup's accounts are merged in. Overwriting the perimeter is an explicit, user-driven choice rather
than a silent side effect of restoring data.

**An encrypted backup names its keys in the clear**, and that is load-bearing rather than a leak to fix —
it is what lets someone restoring a backup work out *which* private key to go and find, before they hold
one. The consequence is a disclosure rule: name keys for what they are, not for who or where. `SECURITY.md`
states this as a scope item; `data-model.md` → *Backups* has the format.

## Recovery and compromise response

**The ladder is ordered by cost, and the order is load-bearing** — the cheap rungs are free and the last
one is irreversible, so the UI offers them in sequence rather than presenting destruction as the only
answer. Another member re-enrolling the stuck user moves nothing. A recovery code re-keys the passphrase
**against the same DEK**, so no ciphertext is rewritten and nothing is re-linked. A credentials backup
opened with the passphrase *it* was made under is a complete recovery. Only then, reset.

**A dialog that leads with destruction will read as "my data is gone"**, which is wrong and is the more
likely reason someone abandons the app at that moment. Only two columns are ever encrypted: accounts,
transactions, mappings, coverage, cursors, rules and tags are plaintext and survive untouched. Losing the
passphrase costs *the ability to keep syncing*, not ledger data. Lead with that.

**Reset must not delete connections.** Clearing the credential is the point; discarding the connection row
would also discard account mappings, per-account coverage and sync history — the genuinely expensive state
to rebuild, and none of it is lost with the credential. Clear the encrypted columns (driven off
`ENCRYPTED_COLUMNS`, so a column added later is reached without anyone remembering) and flag every
connection for reconnection.

**Reset asks *lost or compromised*, because the two paths can promise different things.** Revoking a
credential requires decrypting it, which requires an open vault — so the original motivating case, a
forgotten passphrase, is exactly the one where **no revocation is possible for any provider**. A
compromised-but-known passphrase can revoke on the way out, driven by `revokes_on_disconnect`. The user
knows which situation they are in, so the dialog asks rather than guessing — and its *exposed* option
points at *Respond to an exposure* (above), which needs no reset at all when the vault can be opened.

**A reset reports per-connection outcomes rather than aborting.** Disconnect deliberately *keeps* the
local connection when revocation fails, so the user can retry rather than believe a credential is dead
when it may still be live. Reset cannot honor that — clearing is the point — so it names the connections
the user has to finish by hand instead.

**A reset ends every member's access**, because there is one DEK per workspace. It says so.

**A single recovery code is safe because recovery is one request, not two.** The apparent hazard is the
gap between entering the code and setting the replacement: a crash there would leave the code spent and
the vault still shut. The answer is ordering rather than redundancy — the replacement slot is written
*before* the recovery slot is deleted, so any failure before that point leaves the code live and the
attempt repeatable, and a failure *at* it leaves the user holding both a working passphrase and a live
code, which costs nothing. A fresh code is issued on the way out, so forgetting the *replacement* is not
back at the dead end.

**A vault recovery code must not reuse the sign-in code generator.** A 2FA code is checked against a hash
by a server that can rate-limit and lock out; 40 bits is sound there. A vault slot is the opposite
situation — its wrap is offline-attackable by anyone holding the control DB, which is the exact threat the
vault exists to answer. A vault code needs its own generator at **≥ 128 bits**. Reusing the sign-in one
would quietly reintroduce the weak wrap the passphrase floor was raised to eliminate.

**Changing the passphrase and replacing the vault key are not interchangeable** — they retire different
artifacts, and after a leaked file both are needed. `SECURITY.md` → *What a compromise would mean* is the
statement of record; do not paraphrase it into a second copy.

---

## Considered and rejected

Recorded so they are not re-proposed. Each names the reason, not just the verdict.

- **Multi-tenant hosting.** Dropped as a target, and the drop is what licenses the trusted-server
  assumption everything else rests on. Reintroducing it invalidates server-side crypto, not just the
  provisioning UI.
- **Whole-database file encryption** (SQLCipher and the like). Not redundant — it genuinely would protect
  the ledger at rest — but the key has to be available *before* anyone can be asked for it: the app serves
  its own sign-in screen out of the control database, so the file must be readable before there is a user
  to prompt. That leaves two shapes and both are worse than what exists. A key sitting on the same disk
  protects nothing against the theft-of-files case this model is built around, and a passphrase typed at
  every process start makes unattended running impossible — which is exactly what a LAN box or a
  double-clicked desktop launcher is for. The field-level vault sits where the trade works: its unlock
  secret comes from a person who is already present, and only for the operations that need it.
- **A `server_managed` custody mode, and a plaintext `off` mode.** `server_managed` let the server decrypt
  at rest, so it never delivered leaked-DB-≠-leaked-credentials. `off` had no legitimate case — plaintext
  live credentials are unacceptable, plaintext sandbox ones are pointless when a passphrase costs nothing
  — and it carried a footgun where an install flips sandbox→live with custody off and silently writes a
  real credential in the clear.
- **A relaxed passphrase for sandbox or test use.** See *Secret custody*. It would have introduced a
  plaintext credential path plus an encrypt-on-first-vault sweep to make it safe; neither is needed once
  nothing weak can exist.
- **Keeping app-level provider credentials in a `.env` file**, with a bootstrap fallback that read one
  from there. The only things anyone *does* with an app credential are connect and
  sync, and both already require an unlocked vault because the per-connection credential is under the
  DEK — so vaulting it costs nothing in practice, while a file leaves a real secret plaintext on disk.
  The bootstrap fallback was worse than the original arrangement: it also handed a **locked** vault an
  unlock-free path to a secret, since the reveal deliberately skips the gate for a value that is not
  encrypted at all. Re-entering a credential once is the whole of the setup.
- **A "choose your security level" question.** With a sensible fixed floor there is nothing meaningful to
  dial, and it cuts against detecting facts rather than asking about them.
- **The invite ceremony** (a 128-bit bearer code, expiry, single-use, revocable, the AEAD tag as
  verifier). It was a well-formed answer to a question keypair slots stop asking: **every part of it was
  machinery for limiting the damage of a secret in transit**, and no secret is now in transit. Return to
  it only if a future provider genuinely requires out-of-band hand-over — not merely to have an "invite"
  affordance, since approve-a-request covers the same journeys with fewer moving parts.
- **Browser-side crypto as an escape hatch from TLS.** Two independent reasons it is not one. The backend
  is the provider's API client and must hold the plaintext credential to make the call, so cleartext key
  material is on the wire wherever the unwrap happens — any scheme that avoids it ends up reinventing a
  secure channel. And the ledger itself crosses the wire in every API response, which browser-side
  *credential* crypto does not touch.
- **Client-side password hashing, and PAKE, as a rescue for plain HTTP.** A client-computed hash *is* a
  replayable password-equivalent, and even a real PAKE leaves the session cookie exposed.
- **Deriving the cookie `Secure` flag from the security profile.** The profile is a recommendation, not a
  transport guarantee; deriving from it locks out a network-profile install that runs plain HTTP.
  Hardcoding it breaks the other topology. It stays an explicit environment value set at the deployment
  edge.
- **Verifying the WebAuthn assertion for a vault ceremony.** The vault is not an authentication decision.
  A wrong PRF output fails at the AEAD tag exactly as a wrong passphrase does, so the slot is
  self-verifying; checking a signature would mean storing credential public keys and running challenge
  state to prove what is already proven. **This is scoped to the vault and always was.** Passkey *sign-in*
  is an authentication decision with no such backstop — nothing downstream would notice a forged assertion
  — so it verifies in full, and the WebAuthn library this entry declined to add for the vault is a
  dependency now. The rejection still holds where it was made: `crypto_service` imports none of it.
- **A set of N vault recovery codes.** N codes are N slot rows and therefore N independent
  offline-attackable paths to the same DEK. The redundancy only helps if the copies are kept in N places,
  which is not how recovery codes are stored. The 2FA set-of-ten answers a different question: a sign-in
  code is spent at every login, a vault code once in a disaster.
- **Two narrower rules for the mint-a-method gate.** *"Refuse only when a passphrase slot that already
  opens would be replaced"* misses a **pending** slot sitting beside a granted passkey — overwriting it
  seals the live DEK into a slot of the caller's choosing with nothing "replaced". *"Only the first
  passphrase is safe"* misses a passkey-only member adding a first passphrase, which takes the same path
  to the same durable credential.
- **Refusing the lost-passphrase reset while another member holds a slot.** A slot row cannot prove its
  holder is reachable, the admin gate already settles who may do this, and the compromise path permits
  the identical destruction — so a refusal only stops the users who describe their situation accurately.
  The gate is a **redirect** instead: name the cheaper rungs, and report that a reset also ends every
  other member's access.
- **Replace-and-forget as a way to discard a recovery code.** It leaves the "has a recovery code" flag
  true, so the app goes on offering that rung to somebody who deliberately has none — a phantom rung in a
  ladder whose whole value is being ordered by what the user can actually do. It also renders a fresh code
  on screen before abandoning it.

## Obstacles

What a second attempt hits, whether or not it is planned.

- **A conditional passphrase floor has to be right at every gate and stay right as providers are added.**
  This is why the floor is unconditional. Any proposal to reintroduce conditionality inherits the problem.
- **Revocation needs an unlocked vault**, because the credential must be decrypted before it can be
  revoked. Anything that wants to "revoke on the way out" of a destructive path is constrained by this,
  and the forgotten-passphrase case can never satisfy it.
- **No transaction spans the control and data databases.** Rotation, reset, and any future operation that
  must change key material and ciphertext together has to be ordered so every intermediate state is
  readable. Assume no atomicity across the two files.
- **A restore can leave state inconsistent across the split.** The same two-database seam that constrains
  rotation applies to restore, which is why restore reconciles rather than overwrites.
- **WebAuthn's two preconditions are the browser's, not the app's.** A bare-IP host can never register a
  passkey however it is served; no amount of TLS changes it. Any LAN passkey story needs a name *and*
  HTTPS.
- **Re-linking may land on a new connection row**, depending on how a provider derives its handle. What
  survives and what is stranded differs by provider — see `building-a-connector.md` → where the connection
  handle comes from, and check it before promising a user that a re-link is transparent.
- **An interrupted rotation must be resumed, not restarted.** Restarting pushes the key the ciphertext is
  under off the end of what a slot can hold.

## Open

Decisions owed. Each names the live backlog item that will feed this topic when it is picked up.

- **Should a credentials backup carry every member's slot?** Only meaningful in a multi-member workspace
  where the exporter is unavailable. The trade is real in both directions: one slot means the file is as
  strong as its owner's passphrase, every member's slot means it is as strong as the least careful
  member's — which no member can see or audit — while "the person who made the backup has left" is an
  ordinary way to lose data. A middle option exists: let the exporter choose whose slots ride along.
  → `backlog/backup-restore-scope-and-secrets.md`
- **Whether `backup_recipient` belongs in an accounts-and-secrets backup** or stays machine-local.
  → `backlog/backup-restore-scope-and-secrets.md`
- **The wider accounts-and-secrets artifact.** The credentials half is settled — the payload is ciphertext,
  so there is no plaintext variant to permit and no encryption toggle. The wider artifact additionally
  carries password hashes, which have no such wrapping, so the same reasoning does not simply carry over.
  → `backlog/backup-restore-scope-and-secrets.md`
- **The three-radio topology UI has not collapsed to the single forward-looking question**, though the
  per-request detection it needs exists. Standalone-vs-client-server is a *detected* fact, so only the
  data-source declaration is a real question to put to anyone, and only when networked. No backlog item —
  this topic owns it.
- **An mDNS service name.** Env-only, alongside the ports. Not merely convenience: with HTTPS it is what
  makes passkeys reachable on a LAN at all. The open part is the default name when two installations share
  a network. → [`operations.md`](operations.md) → *Open*
- **One owed test**: reset → set a new passphrase → restore a credentials backup taken under the old one,
  which is the ladder's first real rung and the only one nothing exercises end to end.
  → `backlog/test-coverage-gaps.md`
- **In-app Help topics** (`data-and-backups`, `account-security`) predate the current custody framing —
  every credential treated as though it carried full account and identity access — and may still describe
  provider access as read-only. Reconcile them next time they are touched.
