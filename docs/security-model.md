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

This document holds the reasoning underneath, so a premise is abandoned deliberately rather than by
accident. Where a fact is about *how it works*, it links to `architecture.md` rather than repeating it.

## Contents

- [What is defended, and what is deliberately not](#what-is-defended-and-what-is-deliberately-not)
- [Reading and deleting outside the data directory](#reading-and-deleting-outside-the-data-directory)
- [Why provider credentials are the only things encrypted](#why-provider-credentials-are-the-only-things-encrypted)
- [Revocation, in both directions](#revocation-in-both-directions)
  - [Responding to an exposure](#responding-to-an-exposure)
- [Identity and the network perimeter](#identity-and-the-network-perimeter)
- [Passkeys and the second factor](#passkeys-and-the-second-factor)
- [Secret custody](#secret-custody)
- [Enrollment, grant, revocation and rotation](#enrollment-grant-revocation-and-rotation)
- [Authorizing a change to how the vault opens](#authorizing-a-change-to-how-the-vault-opens)
- [Transport security](#transport-security)
- [Secrets in backup and export](#secrets-in-backup-and-export)
- [Recovery and compromise response](#recovery-and-compromise-response)
- [Obstacles](#obstacles)
- [Open](#open)

---

## What is defended, and what is deliberately not

The whole model follows from one premise: **the machine it runs on and the network it answers on are
controlled by the operator and closed to the public.** That is usually a personal machine or a box on a
home LAN, but the premise is those properties rather than the address — a private cloud instance nobody
else holds an account on or a route to satisfies it just as well, while a shared desktop or an instance
published to the internet does not.

- **The ledger is plaintext at rest, and that is accepted.** Transactions, categories, rules, tags,
  mappings and import history sit unencrypted in SQLite. Protecting them at rest would need pervasive
  field encryption or whole-database encryption, and both are out of scope.
- **The login perimeter is network-access control.** It governs who can reach a *running* instance.
- **The server is trusted, and the crypto runs server-side.** The unlock secret reaches the backend,
  which derives the KEK, unseals the DEK and uses it. This defends **theft of the data at rest**, not a
  compromised *running* host — someone who owns the box can read the ledger off disk anyway. **What is
  given up is more than the ledger, though:** while a user is unlocked the DEK sits in process memory, on
  a sliding idle window sized for a working day, so an attacker on the box reaches the provider
  credentials too. No passphrase floor defends that.
- **The app reads and writes only its own data directory, with one declared exception**: a watched import
  folder (*Reading and deleting outside the data directory*).
- **The backend is assumed not to be public-internet facing.** If an operator exposes it, the app
  password becomes far more load-bearing than this model assumes. That is the operator's call.

The property the vault does buy is narrow: **a leaked database is not a leaked credential.** No live
unlock secret ⇒ no KEK ⇒ nothing opens.

## Reading and deleting outside the data directory

Everything else the app touches on disk is its own. **A watched import folder is the one exception** — a
data source names a directory, and the server lists it, reads the CSVs in it and, if the source says so,
deletes the ones it imported. That is a new capability class, so what is defended is stated here.

**What is defended.** Setting the path is admin-or-local (`require_admin_or_local`): a directory on the
server is global app configuration, not ledger data a member edits. The delete is constrained further —
only a file this app recorded importing is eligible, and its recorded content hash is re-checked against
the bytes on disk immediately before the unlink, so a file swapped in under the same name is never
removed. A restore from another instance switches watching off rather than carrying another machine's
paths onto this one (`data-model.md` → *Watched import folders*).

**What is not.** There is no allow-list of directories and no confinement: an administrator may name any
path the server process can reach. Nothing here defends an administrator against themselves — on an
operator-controlled machine, an operator who can name a directory can already read it.

**The condition to reopen this.** If the login perimeter ever admits an account class that is neither
administrator nor trusted operator — a guest, a read-only sharer, an API token with narrowed scope —
"admin-or-local" stops describing who can point the server at a directory, and the delete in particular
needs re-grading before that class exists.

## Why provider credentials are the only things encrypted

**The credential's reach is not known, and cannot be.** Luma only reads transaction data, but what the
credential is *authorized* for is the provider's to decide — it may, and often does, reach account and
routing numbers, identity, or the ability to move money. **So every provider credential is treated as
though it carries full account and identity access**, and protected with one unconditional passphrase
floor.

Exactly two columns are encrypted under the workspace DEK — the per-connection credential and the
app-level provider secret. **The second is the wider of the two**: it is not scoped to one connection, so
its loss reaches every connection made under it and the ability to authorize more. Both are registered in
`crypto_service.ENCRYPTED_COLUMNS`, and rotation, reset and the backup paths are all driven off that
registry, so **an encrypted column that is not registered is silently unreachable by all three.** Add
the registration in the same change as the column.

## Revocation, in both directions

**Whether disconnect actually revokes is a per-provider fact the app states rather than hides.** Adapters
declare `revokes_on_disconnect` and the disconnect confirmation reads it, because **a user who believes
access ended when it did not is worse off than one who knows to go and revoke it.** A provider with no
revocation call is an ordinary supported case; the remedy is to revoke the token at the provider, rotate
the vault passphrase and key, then re-link.

### Responding to an exposure

**How a leaked credential is retired is the provider's to define, so each step follows that provider's
documentation.** Whether a credential can be replaced without the user authorizing again, and whether an
old secret dies when a new one is issued, are read from the provider and recorded as adapter capabilities
where code acts on them. A new provider's exposure handling is designed from its own documentation, never
by analogy with an existing one.

**A provider with an app credential holds two levels of authorization**, retired separately. Plaid's are
the app's client id and secret, and the per-connection access token; a token is usable only together with
the secret.

- **The token** can be replaced with no bank login (`/item/access_token/invalidate`), which the adapter
  declares as `reissues_credential`. Revoking it (`/item/remove`) ends the Item, so the connection has to
  be linked again.
- **The app secret** is rotated on the provider's dashboard, and **the old one keeps working until it is
  deleted there** — so the step is rotate, enter the new one with Configure, then delete the old one.
  Deleting the old secret stops existing Items syncing as well as new links; once the new secret is
  entered they sync again without being re-linked.

**With the vault open, the response replaces rather than revokes** (*Respond to an exposure*,
`services/exposure_response.py`): each connection's credential is reissued where the provider declares it
can, so the copied credentials die while every connection keeps syncing, and the rest is returned as steps
for the user (`architecture.md` has the list). It does not replace the vault reset, which remains the only
route for a **forgotten** passphrase: there nothing can be decrypted, so nothing can be sent to a provider.

**The app secret is always left to the user, on either path**, read from what is stored rather than from a
capability, since a secret never saved was never exposed.

**The reverse direction — the user revokes at the provider — is not symmetric either.** Nothing announces
it; Luma finds out only when a request is refused. A refused credential raises
`ProviderCredentialRejected` and sets `reauth_required`, so the card reads **reconnect needed** rather
than accumulating generic sync failures. For a provider with no revocation call this refusal is the only
notice there will ever be.

## Identity and the network perimeter

**Login is an authentication perimeter, not an authorization system.** Its only job is to keep *non-users*
out. Once inside, every user sees and edits the same data, and no data route checks role. **Admin gates
the install and the perimeter, not the ledger** — user management, provider and environment settings, and
the operations that replace the workspace wholesale: every restore path, and the backup keys that decide
who can read a backup. A restore swaps out every row, the connections and the provider configuration at
once, so it is a settings-scale act. Creating a backup is held to the same gate. The guards live in
`backend/authorization.py`; with sign-in protection off there is no role to hold, and they pass. An
authorization check at the data layer would have no scoping model behind it to enforce.

**The same gate sorts the interface**: what a member may do is on Settings, what is behind
`require_admin_or_local` is on Administration.

**"Password optional" is a workspace property, never per-user.** The data is shared, so if one identity
has a password and another does not, anyone on the LAN picks the passwordless one and reads the same
ledger. A per-user perimeter over shared data is incoherent.

**A protection that can be switched off must not destroy the state needed to switch it back on.**
Enabling and disabling sign-in are flag flips: disabling leaves password hashes dormant rather than
discarding them, so re-enabling is never a migration.

**Three concepts look like one and are not. Do not couple them.**

- *A user identity* scopes **per-person UI preferences** and carries that person's own **app-access
  credential**. It confers nothing about the vault.
- *A vault access grant* is what lets a person open the vault. The data sources are shared and visible to
  everyone; the grant confers the ability to **use** them — connect, sync, refresh, disconnect, reveal an
  app secret — because each has to decrypt a stored credential first.
- *An app password* is **network-access control** — it establishes who is at the browser, never authority
  over encrypted data.

A trusting household can therefore be entirely passwordless and still need vault grants, so **no design
may assume a member has an app password.** The vault is orthogonal to the perimeter in both directions.

**An unlock belongs to the browser session that presented the secret, not to the identity.** Picking an
identity takes no credential while sign-in protection is off, so an unlock filed under the user alone
would be inherited by anyone picking that name on another browser — and with it, inside the proof window,
the authority to add a passkey of their own to the owner's slot. With sign-in on, sharing would let a
stolen app password reach the vault while its owner was unlocked elsewhere. The unlock cache and the proof
stamp are therefore keyed by user *and* sign-in session id.

**A session is a row the server can delete, not only a cookie it can verify.** A signature says only that
the server once issued the cookie, so without a stored row a copy taken earlier stays good whatever its
owner does (`services/sign_in_sessions.py`). **The row holds a SHA-256 of the id, never the id**: unless
`SESSION_SECRET` is set, the signing secret is in the same database, so a copy of the file lets anyone sign
a cookie, and the digest is what stops it also supplying an id a row would accept. **Every sign-in path
goes through `sign_in_sessions.start`**; one that set `user_id` directly would produce a cookie that is
refused.

**Every secret a person types is limited against guessing** (`services/attempt_limiter.py`) — sign-in
passwords, authenticator and 2FA recovery codes, and the vault passphrase and recovery code. The perimeter
is optional, and a networked deployment is where it has to hold up. Limits are **per account**, because
behind a reverse proxy every request arrives from one address. A limited attempt is **refused at once,
never held open**, since held requests occupy server threads. A refusal for an unknown name costs the same
as a real check (`control_database.spend_password_check`), so timing does not reveal which names exist.

Left out, each for a reason:

- **Passkeys**, which verify a signature or a 32-byte PRF output and cannot be guessed. Sign-in by passkey
  stays open while the password is paused, which gives the owner a way in.
- **The code that confirms two-factor setup**, checked against a secret the same session was just given.
- **The passphrase that opens a credentials backup file**, which whoever holds the file attacks offline.
- **Guessing across many names.** A global limit would let one caller pause everyone's sign-in.

**Accepted cost: anyone who knows a username can keep that account's password sign-in paused.** A
registered passkey is the way around it.

**A lost sign-in is recovered from the files, with no other credential.** `--reset-password`
(`backend/account_recovery.py`) runs from a console and never serves. Sign-in is a perimeter around data
the files hold in the clear, so whoever can run it against the databases can already read the ledger. It
clears everything else that could keep the account out (`control_database.restore_admin_access`). **The
vault is the boundary it does not cross**: a slot opens only with its own secret.

## Passkeys and the second factor

**A passkey signs in, and it also stands in for the authenticator code.** The ceremony runs with user
verification *required*, so the authenticator demands a biometric or a PIN — possession **and** something
inherent or known, which is what the TOTP step establishes. `_USER_VERIFICATION` in
`services/app_passkey.py` is therefore load-bearing: relax it and sign-in silently becomes possession
alone.

**The convenience is the security argument.** What pushes a household into turning sign-in off is
friction, so a login that costs a fingerprint makes keeping the perimeter **on** cheaper than switching it
off. Measuring only credential strength misses this.

**A passkey is never the only credential.** A bare-IP host can never register one (*Obstacles*), so the
password remains the floor and every account keeps one.

**The two passkey features must not become one.** The vault's passkeys open encrypted credentials; these
cross the login perimeter. They keep separate endpoints, storage (`app_passkey` versus `vault_slot`) and
copy. Merging the ceremonies would make signing in imply vault authority — the coupling *Do not couple
them* forbids. A user who holds both is prompted twice, deliberately.

**Keeping them apart has to hold on the device too.** A device keeps one passkey list per *host*, so the
vault's passkeys, the sign-in passkeys and those of every other Luma database on the same host share it:

- **A sign-in passkey has its own user handle** (`sign_in_user_handle`). An authenticator may replace a
  stored passkey that arrives for the same site and handle, so a shared handle would let adding one kind
  delete the other.
- **Sign-in names its credentials** in `allowCredentials`, so the device offers only those. What that
  reveals — a count and opaque ids — is not what the perimeter protects. An empty list is never sent: to a
  browser it means *any* passkey.
- **Each kind is labelled as what it is**, since the device's chooser shows nothing else.

**Their reach differs in the direction people expect least.** Sign-in needs only a plain assertion, while
a vault slot needs the PRF extension, so the *login* feature works on more devices.

**Removing a login passkey takes no proof.** Nothing is stranded and the password still opens the account,
and the likeliest reason to remove one is a lost device — a gate demanding it would fire exactly when it
must not.

## Secret custody

The mechanism is in `architecture.md`. What belongs here is why the shape is what it is, and the rules a
change has to respect.

**A slot holds a keypair, not a wrapped DEK.** A wrap made from someone's own secret can only ever be made
*by* them, so under direct wrapping:

- **Rotation is impossible.** Re-wrapping a new DEK for every remaining member needs each of their secrets.
- **Access cannot be granted** without moving a *secret* between two people.

Sealing the DEK to a slot's public key dissolves both: anyone holding the DEK can seal it for anyone else
from their public key alone, so **nothing secret ever moves between people.**

**The passphrase floor is unconditional — there is no weak tier and no test-mode exemption.** A
conditional floor has to be right at every gate that guards it and stay right as providers are added; an
unconditional one cannot be got wrong. It is also a rule a user can hold. So **connecting a live data
source always requires a vault passphrase, even on a passwordless install.**

**One stored secret is readable back on request; the other never is.** An app-level credential is one the
operator already reads on the provider's dashboard, and a reveal answers a real diagnostic: does what Luma
holds match it. A per-connection credential has no such counterpart and no reason a human would read it.
Three properties keep that exception narrow:

- It is a **separate call**, never a field on a status payload.
- It **reuses the decryption path a sync takes**, so there is one way a stored credential becomes
  plaintext.
- It takes **no second challenge when the vault is already unlocked** — sync, disconnect and refresh all
  ride the same boundary.

**The vault is only as strong as its weakest slot**, which is why the floor is an all-slots property and a
high-entropy recovery code does not compensate for a weak passphrase.

**There is no escrow and no required fallback.** Losing every way in costs the data-source connections,
which are re-linkable; the ledger is untouched. But **"no escrow" is not "no exit"**: the app still owes
that user a way forward (*Recovery and compromise response*).

## Enrollment, grant, revocation and rotation

**The order is inverted from an invite.** The person who wants access enrolls first — writing their
keypair with no sealed DEK — and a member who holds the DEK approves. A grant addressed to a published
public key has **no window in which a third party could claim it**, so there are no bearer codes,
expiries or single-use rules. Standing at the same machine and approving later are the same flow.

**Removing a slot is not enough for a hostile departure.** The member may have seen the DEK while
unlocked. The response is **remove access, then rotate**, in that order, because rotation re-seals for the
slots present when it runs. Rotation cannot undo past access, so a hostile departure also implies
re-linking the affected sources.

**Rotation crosses two databases, so it cannot be a transaction.** Slots live in the control DB and the
ciphertext in the data DB. The three-phase order leaves every row readable under one of two keys at every
instant (*Obstacles*).

## Authorizing a change to how the vault opens

> Any method that opens the vault must also be able to set a new passphrase, and **only a method that
> proves itself at that moment** may add or replace one.

An unlocked vault is *not* sufficient authority. Minting a passphrase, a passkey, a recovery code or a
grant seals the real DEK into a new slot, converting **transient** access (someone at an unlocked machine)
into **durable, independent** access that survives lock and the owner's own attempts to get back in.
**The line is whether authority is derived from a cached DEK rather than proven.**

- **Removals need the same gate as additions.** Stripping every passkey and the recovery code grants
  nothing, but it leaves the owner one forgotten passphrase from rebuilding every connection.
- **Proof has a life** (`PROOF_TTL_SECONDS`, five minutes), because a secret demanded at every boundary
  gets answered by choosing a shorter one.
- **The stamp belongs to the session that presented the secret**, exactly like the unlock.
- **The stamp is absolute, not sliding.** The unlock cache's TTL slides on every read, so a proof riding
  on it would be renewed by ordinary decryption and never expire.

## Transport security

**TLS is a property of the deployment topology, not a mode the app toggles.** The backend always speaks
plain HTTP; a networked deployment terminates TLS at a reverse proxy, and loopback needs none.

**Topology is detected per request, not chosen**, because the same install is loopback from its own box
and networked from another. **Where a request came from is read from the connection, never from what the
request says** — the `Host` header is the client's to write (`backend/transport.py`).

**The permissible-HTTP rule.** Plain HTTP on a non-loopback bind is coherent **only when both** hold: no
data provider is configured, **and** the instance is passwordless. The reason to run a perimeter is
distrust of who can reach the box, and that same distrust makes a sniffable **session cookie**
unacceptable — protecting only the login exchange protects nothing, since the cookie is a bearer token on
every request.

**Only the provider secret is enforced; the rest is recommended.** Running plain HTTP on a network is a
statement of trust in that network, so the app states what it costs where it is met — passkeys report
themselves unavailable, and a dismissible *Set up HTTPS* task appears once there is a sign-in to protect —
and refuses nothing else. Nothing about the topology is asked ahead of time.

**What is enforced is enforced by the server.** `transport.require_protected_link` refuses a request from
another device over plain HTTP wherever it would carry a provider's secret: saving an app secret,
revealing one, connecting a source (the pasted token, or the exchange that ends a Link session), and
opening the Link session that leads to one. The interface refuses first for the sake of the explanation;
the server's refusal is the rule.

**What the gate leaves out:**

- **The vault passphrase.** Refusing the unlock would stop an install that chose plain HTTP from syncing
  at all, and a captured passphrase still cannot reach a provider secret through the app from the network.
- **Sign-in.** Recommended, never required.
- **The credentials backup, in both directions.** Its payload is ciphertext under the vault key.
- **Finishing a Link repair, syncing, refreshing accounts, disconnecting.** No secret travels between the
  browser and the server.

**Passkeys make the host name load-bearing, and the failure is silent.** WebAuthn needs a secure context
and an RP id must be a **domain**:

- Hand the browser `localhost`, **never** `127.0.0.1`, or every passkey vault slot is disabled with
  nothing visible to explain why. The RP id is the host alone, so a changing port does not invalidate a
  registered passkey.
- On a LAN, **mDNS and HTTPS are the pair that makes passkeys reachable** — neither works without the
  other (*Obstacles*).

Both are detected server-side and returned as *stated reasons*, because the answer is "use a passphrase on
this connection" and a raw browser exception would never say so.

**Every way of running the app listens to its own machine unless told otherwise.** A backend run from
source serves the whole application, so a wide bind should be chosen (`BACKEND_HOST`). The frontend dev
server stays on loopback because of a toolchain advisory (`frontend/vite.config.js`), with
`FRONTEND_HOST` for testing from another device.

**Trusting the proxy's certificate is trusting the server machine, not one address.** A device that
trusts the proxy's authority accepts anything it signs, for any site name, and its private key sits on the
server. That is the cost of a certificate nobody outside the network had to issue, which is why the
hand-out says so and offers removal steps and a fingerprint (`services/proxy_certificate.py`). A publicly
issued certificate for an owned domain avoids the trade.

## Secrets in backup and export

**The vault's design splits a backup in two.** The credential ciphertext lives in the data DB and the key
material that opens it in the control DB. That split *is* the leaked-DB-≠-leaked-credential property, so a
data-only backup carries credentials that are **dead on arrival** anywhere else. A snapshot that can sync
after restore needs the ciphertext, the vault slots, **and** someone who knows the passphrase then in
force.

**The data backup carries each connection's non-secret half, and nothing in it opens anything** — the
provider handle, the last sync's result and the resume point (`data-model.md` → *Backups*). Every request
to a provider needs the credential, which only the credentials backup carries, as ciphertext. So an
unencrypted data backup reveals which institutions are linked, which its transactions already reveal.

**A leaked secrets backup is a pair of offline brute-force exposures that reach different things.** Login
password hashes gate the *perimeter*; the credentials fall only if the **vault passphrase** is cracked.
That is why the strength requirement lives on the passphrase, and why the strength flag rides along in a
credentials export.

**A credentials export carries one slot — the exporter's.** Within the install that made it the live DEK
opens it whoever exported it; cross-install, only that person's passphrase does. Whether it should carry
every member's slot is **open**.

**Restore must never cost the operator their way in.** When a restore includes identity data, the current
admin is preserved and the backup's accounts are merged in. Overwriting the perimeter is an explicit
choice, never a side effect.

**An encrypted backup names its keys in the clear**, so someone restoring it can work out *which* private
key to find before they hold one. Keys are therefore named for what they are, not for who or where.
`SECURITY.md` states this as a scope item; `data-model.md` → *Backups* has the format.

## Recovery and compromise response

**The ladder is ordered by cost**, and the UI offers it in sequence rather than presenting destruction as
the only answer. Another member re-enrolling the stuck user moves nothing. A recovery code re-keys the
passphrase **against the same DEK**, so nothing is re-linked. A credentials backup opened with the
passphrase *it* was made under is a complete recovery. Only then, reset.

**Losing the passphrase costs the ability to keep syncing, not ledger data**, and the reset dialog leads
with that: only two columns are ever encrypted.

**Reset must not delete connections.** Mappings, per-account coverage and sync history are the expensive
state to rebuild, and none of it is lost with the credential. Reset clears the encrypted columns (driven
off `ENCRYPTED_COLUMNS`) and flags every connection for reconnection.

**Reset asks *lost or compromised*.** Revoking a credential requires decrypting it, so a forgotten
passphrase is exactly the case where **no revocation is possible for any provider**. A
compromised-but-known passphrase can revoke on the way out, driven by `revokes_on_disconnect` — and when
the vault can still be opened, *Respond to an exposure* needs no reset at all.

**A reset reports per-connection outcomes rather than aborting.** Disconnect keeps the local connection
when revocation fails so the user can retry; reset cannot, since clearing is the point, so it names the
connections the user has to finish by hand.

**A reset ends every member's access**, because there is one DEK per workspace. It says so.

**A single recovery code is safe because recovery is one request.** The replacement slot is written
*before* the recovery slot is deleted, so a failure leaves the code live, and a fresh code is issued on the
way out.

**Changing the passphrase and replacing the vault key are not interchangeable** — they retire different
artifacts, and after a leaked file both are needed. `SECURITY.md` → *What a compromise would mean* is the
statement of record.

---

## Obstacles

What a second attempt hits, whether or not it is planned.

- **A conditional passphrase floor has to be right at every gate and stay right as providers are added.**
  Any proposal to reintroduce conditionality inherits the problem.
- **Revocation needs an unlocked vault**, because the credential must be decrypted before it can be
  revoked. The forgotten-passphrase case can never satisfy it.
- **No transaction spans the control and data databases.** Rotation, reset, and any future operation that
  changes key material and ciphertext together has to be ordered so every intermediate state is readable.
- **A restore can leave state inconsistent across the same split**, which is why restore reconciles rather
  than overwrites.
- **WebAuthn's two preconditions are the browser's, not the app's.** A bare-IP host can never register a
  passkey however it is served. Any LAN passkey story needs a name *and* HTTPS.
- **Re-linking may land on a new connection row**, depending on how a provider derives its handle — see
  `building-a-connector.md` → where the connection handle comes from, before promising a user that a
  re-link is transparent.
- **An interrupted rotation must be resumed, not restarted.** Restarting pushes the key the ciphertext is
  under off the end of the two a slot can hold.

## Open

Decisions owed. Each names the live backlog item that will feed this topic when it is picked up.

- **Should a credentials backup carry every member's slot?** Only meaningful in a multi-member workspace
  where the exporter is unavailable. One slot makes the file as strong as its owner's passphrase; every
  member's slot makes it as strong as the least careful member's, which no member can audit — while "the
  person who made the backup has left" is an ordinary way to lose data. A middle option: let the exporter
  choose whose slots ride along. → `backlog/backup-restore-scope-and-secrets.md`
- **Whether `backup_recipient` belongs in an accounts-and-secrets backup** or stays machine-local.
  → `backlog/backup-restore-scope-and-secrets.md`
- **The wider accounts-and-secrets artifact.** The credentials half is settled — its payload is
  ciphertext, so there is no plaintext variant to permit. The wider artifact also carries password
  hashes, which have no such wrapping. → `backlog/backup-restore-scope-and-secrets.md`
- **One owed test**: reset → set a new passphrase → restore a credentials backup taken under the old one,
  the ladder's first real rung and the only one nothing exercises end to end.
  → `backlog/test-coverage-gaps.md`
