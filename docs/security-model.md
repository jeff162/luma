# Security model

The assumptions the security design rests on: what is defended, what is deliberately not, and the
conditions under which a decision here has to be reopened. This is the **maintainer** record. It is
written to be read before changing anything that touches credentials, the login perimeter, transport, or
backups — including "I am only adding a provider".

**Three other surfaces describe security, and this one does not restate them.**

| Surface | Audience | What it holds |
| --- | --- | --- |
| `README.md` → *Security* | someone deciding whether to run Luma | the model in plain terms: what protects what, what a leak means |
| `SECURITY.md` | someone reporting a vulnerability | reporting route, supported versions, what is in scope, and the deliberate design properties that are **not** vulnerabilities |
| `architecture.md` → *Identity, access & deployment model* / *Token vault & transport security* | someone changing the code | the mechanism **as built** — tables, endpoints, constants, call order |

What is missing from all three is the layer below: the premises each of them is downstream of. A reader
of `architecture.md` learns that provider credentials are vault-encrypted and the ledger is not; they do
not learn that the asymmetry is conditioned on a property of the credential that a future provider can
break, or what has to be reopened when it does. That is this document.

**Nothing here is a summary of the mechanism.** Where a fact is about *how it works*, this document
links to `architecture.md` rather than repeating it, because two copies of a mechanism drift and the
copy that goes stale is the one nobody runs.

---

## What is defended, and what is deliberately not

The whole model follows from one premise: **the deployment is your own machine or your own LAN box.**
There is no multi-tenant hosting target, and dropping it is what makes the server trustworthy enough to
hold keys.

- **The ledger is plaintext at rest, and that is accepted.** Transactions, categories, rules, tags,
  mappings and import history sit unencrypted in SQLite. Anyone with the database files or disk access
  reads them. Protecting the ledger at rest is explicitly not a goal: it would need pervasive field
  encryption or whole-database encryption, and both are out of scope.
- **Whole-database file encryption is therefore redundant, not merely unimplemented.** The only secrets
  worth protecting are already ciphertext at the field level, and their keys are never stored in a form
  that can be opened without a live unlock secret. Encrypting the file would add a key-management story
  and protect nothing that is not already protected.
- **The login perimeter is network-access control, not disk encryption.** It governs who can reach a
  *running* instance. It does nothing about files copied off the disk.
- **The server is trusted, and the crypto runs server-side.** The unlock secret reaches the backend,
  which derives the KEK, unseals the DEK and uses it. This defends **theft of the database files at
  rest**. It does not defend a compromised *running* host — and that is the correct trade here, because
  "someone owns the box you run this on" is a state in which the ledger is readable off disk anyway.
- **The backend is assumed not to be public-internet facing.** If an operator exposes it, the app
  password becomes far more load-bearing than this model assumes. That is the operator's call, and the
  onboarding copy says so.

The property the vault does buy is narrow and worth stating exactly: **a leaked database is not a leaked
credential.** No live unlock secret ⇒ no KEK ⇒ nothing opens.

## Why the provider credential is the only thing encrypted

A leaked credential is worse than a leaked ledger in exactly one dimension — **duration**. The ledger a
thief copies is a static snapshot they already have; nothing done afterwards changes it. A credential
keeps pulling **new** data until it is revoked. That difference, and only that difference, is what earns
the credential at-rest protection the ledger does not get.

Exactly two columns are encrypted under the workspace DEK — the per-connection credential and the
app-level provider secret. They are registered in `crypto_service.ENCRYPTED_COLUMNS`, and that registry
is an invariant rather than a convenience: rotation, reset and the backup paths are all driven off it, so
**a third encrypted column that is not registered is silently unreachable by all three**. A test fails if
one is added without being listed. Add the registration in the same change as the column.

## The read-only / revocable conditioning

The custody design above is conditioned on the per-connection credential being **read-only** and
**revocable from inside the app**. Both clauses are load-bearing, and this is the single assumption most
likely to be broken by future work.

**The two clauses are independent, and the consequences of failing them are not symmetric.**

| Clause that fails | What it changes | What it costs |
| --- | --- | --- |
| **not read-only** | the blast radius grows past the ledger — a credential that can move money, or reach account/routing numbers or identity, is no longer "narrower than what is already plaintext on disk" | **reopen this document.** The custody design's justification does not survive it |
| **not revocable in-app** | the blast radius is unchanged; what changes is *who must act to stop it* | a **disclosure** obligation, not a redesign |

A provider that fails only the second clause is an ordinary supported case, not a defect — one live
provider is exactly this. What makes it safe is that the disconnect confirmation states which of the two
things is about to happen, because **a user who believes access ended when it did not is worse off than
one who knows to go and revoke it.** Adapters declare this as `revokes_on_disconnect` rather than the UI
branching on a provider name, so a new provider inherits the disclosure by declaring its capability. See
`building-a-connector.md` for the declaration rule.

**The reverse direction — the user revokes at the provider — is not symmetric either.** Nothing announces
it; Luma finds out only when a request is refused. A refused credential raises
`ProviderCredentialRejected` and sets `reauth_required`, so the card reads **reconnect needed** rather
than accumulating generic sync failures. This matters *more* for a provider with no revocation call: where
revocation normally happens through Luma the connection is simply gone, but where it happens elsewhere
this refusal is the only notice there will ever be, and a connection left counting failures after a
deliberate revocation reads as broken rather than as closed.

**A credential that is the institution's own login fails both clauses**, which is the case to recognize
before writing an adapter rather than after. It grants full web banking rather than scoped read access,
and there is no revocation call, so disconnect would delete a local copy only. Two consequences follow
immediately if such a provider is ever built: the disconnect confirmation must say what it does and does
not do, and the passphrase floor applies unconditionally, since such a credential is never anything less
than live bank access and there is no sandbox mode at which to ask later.
(`backlog/ofx-direct-connect.md` is the worked example, parked on coverage rather than on this.)

**When a provider publishes conformance guidance, read it before writing the adapter.** This was learned
the expensive way: a published checklist was consulted after an adapter shipped, and six of its nine items
were already satisfied — but those six were the ones the protocol forces on any working client. The three
that were missed were the security-posture items, which reasoning from the protocol does not reach because
they are about the *user's* exposure rather than about making a correct request. A failed single-use claim
had to be reported as possible **interception** rather than as "generate a new one" (the reassuring reading
of identical evidence); a 403 on a data call is a condition of its own rather than an outage; and displayed
provider text must be bounded, since escaping covers injection and the live risk is volume. A conformance
checklist is a list of what the protocol's authors know goes wrong.

## Identity and the network perimeter

**Login is an authentication perimeter, not an authorization system.** Its only job is to keep *non-users*
out. Once inside, every user sees and edits the same data with no row- or scope-level restriction, and no
data route checks role. **Admin gates settings, not data** — user management and provider/environment
settings only. Do not add an authorization check at the data layer expecting it to mean something; there
is no scoping model behind it for it to enforce.

**"Password optional" is a workspace property, never per-user.** The data is shared, so if one identity
has a password and another does not, anyone on the LAN picks the passwordless one and reads the same
ledger — the password would have protected only that person's *preferences*. A per-user perimeter over
shared data is incoherent, so the optionality lives one level up.

**Three concepts look related and have unrelated causes. Do not couple them.**

- *Multiple users* exist to scope **per-person UI preferences**. That is all they are for.
- *Vault access grants* exist so each person can personally authorize their own data sources into the
  shared vault.
- *An app password* exists purely for **network-access control**.

A trusting household can therefore be entirely passwordless and still need vault grants, so **no design
may assume a member has an app password.** The vault is orthogonal to the perimeter in both directions: a
passwordless install can hold vault-encrypted credentials, and an authenticated one can have no vault.

**App access uses a password, never a passkey — and that is a decision, not an omission.** A passkey for
*app access* would be security theater: the ledger sits unencrypted on disk, so anyone with disk access
reads it regardless of how strong the login is. Passkeys are reserved for the vault, where they protect
actual ciphertext.

**One identity concept, in one table.** Two tables — a "profile" and an "account" — is the shape to avoid,
and the reason is worth keeping: identities would change shape as the perimeter is toggled, which makes
*disabling* sign-in protection a lossy reverse migration rather than a flag flip. With one table, enable
and disable are both flag flips and nothing is re-keyed. See `architecture.md` for how each operation
behaves.

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
choice is forward-looking — *will you connect a data source?* — and it has to be asked ahead of time
because standing up HTTPS is not instantaneous and the requirement cannot first be discovered at
connect-time.

**The permissible-HTTP rule.** Plain HTTP on a non-loopback bind is an acceptable operator choice **only
when both** hold: no data source is configured (no live credential on the wire), **and** the instance is
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
network — so that nag is suppressible without configuring anything. Where a data source is involved it is
required and never dismissible.

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
knows which situation they are in, so the dialog asks rather than guessing.

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
- **A `server_managed` custody mode, and a plaintext `off` mode.** `server_managed` let the server decrypt
  at rest, so it never delivered leaked-DB-≠-leaked-credentials. `off` had no legitimate case — plaintext
  live credentials are unacceptable, plaintext sandbox ones are pointless when a passphrase costs nothing
  — and it carried a footgun where an install flips sandbox→live with custody off and silently writes a
  real credential in the clear.
- **A relaxed passphrase for sandbox or test use.** See *Secret custody*. It would have introduced a
  plaintext credential path plus an encrypt-on-first-vault sweep to make it safe; neither is needed once
  nothing weak can exist.
- **Keeping app-level provider credentials in a `.env` file.** Reversed from an earlier draft, then the
  migration fallback retired too. The only things anyone *does* with an app credential are connect and
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
- **Two identity tables** (profile and account). See *Identity and the network perimeter*: it makes
  disabling the perimeter a lossy reverse migration.
- **A passkey for app login.** Security theater over a plaintext ledger. Passkeys are for the vault.
- **Verifying the WebAuthn assertion for a vault ceremony.** The vault is not an authentication decision.
  A wrong PRF output fails at the AEAD tag exactly as a wrong passphrase does, so the slot is
  self-verifying; checking a signature would mean storing credential public keys and running challenge
  state to prove what is already proven, and would add a WebAuthn library to do it.
- **A set of N vault recovery codes.** N codes are N slot rows and therefore N independent
  offline-attackable paths to the same DEK. The redundancy only helps if the copies are kept in N places,
  which is not how recovery codes are stored. The 2FA set-of-ten answers a different question: a sign-in
  code is spent at every login, a vault code once in a disaster.
- **Two narrower rules for the mint-a-method gate.** *"Refuse only when a passphrase slot that already
  opens would be replaced"* misses a **pending** slot sitting beside a granted passkey — overwriting it
  seals the live DEK into a slot of the caller's choosing with nothing "replaced". *"Only the first
  passphrase is safe"* misses a passkey-only member adding a first passphrase, which takes the same path
  to the same durable credential.
- **Refusing the lost-passphrase reset while another member holds a slot.** Dropped: a slot row cannot
  prove its holder is reachable, the admin gate already settles who may do this, and the compromise path
  permitted the identical destruction — so it only stopped users who described their situation
  accurately. It became a **redirect** (name the cheaper rungs, and report that a reset also ends every
  other member's access) rather than a refusal.
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
- **In-app Help topics** (`data-and-backups`, `account-security`) predate the tempered read-only framing
  and should be reconciled against it next time they are touched.
