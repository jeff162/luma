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
- [Other websites in the same browser](#other-websites-in-the-same-browser)
- [Known vulnerabilities in what ships](#known-vulnerabilities-in-what-ships)
- [Reading and deleting outside the data directory](#reading-and-deleting-outside-the-data-directory)
- [Rendering documents a user supplied](#rendering-documents-a-user-supplied)
- [Text from others in a spreadsheet](#text-from-others-in-a-spreadsheet)
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
- [Best practices](#best-practices)
- [Obstacles](#obstacles)

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

## Other websites in the same browser

The browser that opens the app also opens arbitrary websites, so a page elsewhere is an attacker the app
meets on every topology, including a loopback install with sign-in off, where nothing else stands in the
way. Each defence below closes a different way in (`backend/http_hardening.py`):

- **A request addressed to a name that is not this server's is refused.** This is what stops DNS
  rebinding: a page re-points its own domain at 127.0.0.1, and its same-origin requests then reach a
  loopback install, which with sign-in off would answer anything. The request still carries the page's
  domain in `Host`, so only names no public DNS could serve are answered without being listed: IP
  literals, `localhost`, single labels, and the private-network suffixes. Any other name an install is
  reached by has to be listed in `ALLOWED_HOSTS`. The header is read only to refuse; where a request came
  from is still read from the connection (*Transport security*).
- **The session cookie is `SameSite=Strict`**, so no request another site starts carries it, and with
  JSON bodies that only a same-origin page can send, a forged write has nothing to ride on. It costs
  nothing because the interface loads without the cookie and every request it then makes is same-site.
- **A cookie set over HTTPS is marked `Secure`**, so it never goes back over the cleartext hop a `.local`
  name takes before the proxy redirects.
- **The app can be framed only by itself**, which stops another page overlaying it to steer clicks. Its
  own document viewer is the one frame it needs.
- **The content policy lets a page run only the app's own script and Plaid Link's.** It is a second line
  behind React's escaping, should markup ever reach the page. Inline styles stay allowed because the
  interface is styled inline throughout. The development server does not send the policy, so a change
  that would break it shows only in a built copy.
- **Responses stay out of the browser's disk cache, and a followed link sends no address of the app's.**
  The bundle's hashed assets are the one exception to the first, being code that is renamed whenever it
  changes.
- **There are no generated API pages.** FastAPI's `/docs`, `/redoc` and `/openapi.json` would sit outside
  `/api`, where the sign-in check never reaches.

**What is deliberately not sent: HSTS.** A LAN install's HTTPS rests on a `.local` name and a certificate
from its own proxy's authority. Telling browsers to refuse plain HTTP to that name for months would turn a
change of proxy into a lock-out, for little gain on a network the model already assumes is the operator's.

## Known vulnerabilities in what ships

The Python packages a kit carries and the npm packages in the bundle are audited for published
vulnerabilities on every push, and so before every release (the *Dependency audit* job in
`.github/workflows/ci.yml`). A newly published advisory fails the build until the pin moves; development
tooling is left out, since it never reaches an install. The parsers of files from outside — Pillow for
images, pypdf for PDFs — are where advisories cluster, so they are the ones to move first.

## Reading and deleting outside the data directory

Everything else the app touches on disk is its own. **A watched import folder is the one exception** — a
data source names a directory, and the server lists it, reads the files of the kinds that source takes
(CSVs, and for the PayPal source statement PDFs) and, if the source says so, deletes the ones it
imported. That is a new capability class, so what is defended is stated here. The installation's own
`imports/` folder sits beside the data database, so watching it reaches nothing outside the app's data.

**What is defended.** Setting the path is admin-or-local (`require_admin_or_local`): a directory on the
server is global app configuration, not ledger data a member edits. **On an installation other devices
can reach, where it may be is the operator's**: watching is confined to `imports/` and the folders named
in `WATCH_FOLDER_ROOTS`, because an administrator in the app need not have a shell on the machine, and
with sign-in protection off the admin check passes everyone. The confinement is
checked on every way in — saving a path, the picker, the scan, the delete, handing a parked file back —
against the path resolved through symbolic links (`operations.md` → *Watched folders on a server*). The delete is constrained further —
only a file this app recorded importing is eligible, and its recorded content hash is re-checked against
the bytes on disk immediately before the unlink, so a file swapped in under the same name is never
removed. A restore from another instance switches watching off rather than carrying another machine's
paths onto this one (`data-model.md` → *Watched import folders*).

**What is not.** An installation only this computer can open has no confinement unless the setting is
given: there, whoever can open the app is at the machine and can already read what it can. Inside the
roots nothing is narrower — any folder under one may be named — and the roots themselves are the
operator's to choose; nothing stops naming `/`.

**The folder picker is the same capability, not a wider one.** `GET /import-export/watch/browse` lists
one directory's subdirectories behind the same `require_admin_or_local` gate, so that a path on a machine
the person cannot see need not be typed blind. It is read-only and creates nothing, which is strictly
less than naming that path and scanning it already does — that lists the directory *and* attempts imports
from it. What it does change is *reach without intent*: it enumerates directories nobody named, where the
path field only ever listed one that was. Where watching is confined, so is the walk: it starts at the
roots and goes no higher.

**The condition to reopen this.** If the login perimeter ever admits an account class that is neither
administrator nor trusted operator — a guest, a read-only sharer, an API token with narrowed scope —
"admin-or-local" stops describing who can point the server at a directory. The delete needs re-grading
before that class exists, and the picker is the first thing to withhold from it, being the sharpest tool
here for someone who should not be reading the filesystem at all.

## Rendering documents a user supplied

Stored and pasted HTML usually comes from an email, which is content written by a third party, so it is
rendered as untrusted:

- **A stored document is served with `Content-Security-Policy: sandbox; default-src 'none'`**: no script,
  no subresource, no origin (`backend/routers/documents.py`).
- **A paste being reviewed has no URL to carry that header**, so its preview rebuilds the same policy as a
  `<meta>` and strips whatever could navigate the frame (`frontend/src/lib/pastedHtmlPreview.js`).
- **The preview frame is sandboxed with `allow-same-origin` and nothing else.** Same origin is what lets
  the app read back edits made in place, and it is safe only because no script runs in the frame. Adding
  `allow-scripts` alongside it would hand the pasted markup the app's origin, including the ability to lift
  its own sandbox — the two tokens are never combined.
- **A stored image is decoded only by the decoder for the type its bytes were identified as**
  (`IMAGE_DECODERS` in `services/documents.py`), so a file cannot reach Pillow's other parsers by what it
  claims to be. Image and PDF parsers are where these libraries' published vulnerabilities cluster.

## Text from others in a spreadsheet

Merchant names, raw descriptions and payment notes are largely written by someone else — a bank, a
marketplace, whoever sent a PayPal payment. A spreadsheet runs a cell that opens with `=`, `+`, `-` or `@`
as a formula, which can fetch addresses or, in older Excel, start programs. So the CSV export and the
plain-text list copy write such a text cell with a leading `'`, which a spreadsheet takes as text
(`spreadsheet_safe` in `routers/import_export/backup.py`, mirrored in `frontend/src/lib/transactionShare.js`).
Numbers are left alone, since a negative amount opens with `-` and has to stay a number. The rich-text
copy is left alone too: it is pasted into an email or a document, where a stray `'` would only be noise.

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

**A refused revocation keeps the connection until the user removes it anyway.** A refusal may pass, so
disconnect stops and says what the provider answered rather than dropping a token that may still be live.
Some never pass: the app credentials moved to another environment, or the provider account ended. So the
refusal offers removal without revoking, stating that the access may still be live and where to end it,
and the Sync log records the disconnect as not revoked.

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
once, so it is a settings-scale act. Creating a backup is held to the same gate, and so is checking,
repairing and compacting the database files, which act on the install's files rather than the ledger's
rows and lock them for everyone while they run. Clearing the record imports keep of the rows they refused
(Settings → Database → Import storage) is the one ledger operation held to the same gate: it cannot be
undone, it removes what every member's imports kept rather than one member's work, and it closes the
duplicate report's restore path for all of them, so it is a decision about the installation's data rather
than an edit within it. The guards live in
`backend/authorization.py`; with sign-in protection off there is no role to hold, and they pass. An
authorization check at the data layer would have no scoping model behind it to enforce.

**The same gate decides what the interface lists.** Settings groups its sections by subject, not by
role, and a section behind `require_admin_or_local` is listed only for someone who passes it, so a member
is never shown controls that would all be refused. With sign-in protection off everyone passes, and a
per-user preference (Settings → Administration) can still hide those controls and their reminders. It is a
display choice and defends nothing: the routes enforce the gate whatever it says, and it is read only while
sign-in is off, so it can never hide anything from an administrator once roles exist.

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

**A sign-in password guards the network door and nothing else.** Guessing it means asking the server,
which the limits below slow to a handful of tries per account every few minutes, and a copy of the files
needs no password, since the ledger in it is in the clear. So how strong it must be is the operator's
policy, and a suggested password is four random words where a vault passphrase is six. **"Strong" is the
vault's strength estimator at its top score** (`backend/password_strength.py`), so the app has one meaning
of strong: a character-class rule, which NIST SP 800-63B advises against, accepts `Password1234567!`.

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
- **The secrets a backup file is checked against** — the vault secret that opens an older credentials
  backup, and the administrator password a restore of the accounts asks for — which whoever holds the file
  can test offline anyway.
- **Guessing across many names.** A global limit would let one caller pause everyone's sign-in.

**Accepted cost: anyone who knows a username can keep that account's password sign-in paused.** A
registered passkey is the way around it.

**A lost sign-in is recovered from the files, with no other credential.** `--reset-password`
(`backend/account_recovery.py`) runs from a console and never serves. Sign-in is a perimeter around data
the files hold in the clear, so whoever can run it against the databases can already read the ledger. It
clears everything else that could keep the account out (`control_database.restore_admin_access`). **The
vault is the boundary it does not cross**: a slot opens only with its own secret.

**Pairing a ledger with a control database is the same kind of action.** `--adopt-ledger`
(`backend/ledger_adoption.py`) decides which ledger an installation's sign-ins open, so it is a console
tool and never a page: the page a refused start serves is reached before anyone signs in, and it shows the
paths and the command only to a browser on the server itself (`operations.md` → *When the two databases
do not belong together*).

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

**The floor has two halves: length, and how guessable the passphrase is.** Length is the main lever, since
a passphrase lives in a password manager where a long one costs nothing more to enter. Guessability is an
estimate (zxcvbn, which runs offline from the dictionaries it ships with) held to its top score, the band
it describes as strong against an offline slow-hash attack — the attack a slot's wrap faces. It catches
the long passphrase that dictionary words, repeats or a keyboard run make quick to guess. A composition
rule would not: NIST SP 800-63B advises against them, and a repeated phrase clears one. The estimate lives
on the server, so the dialog asks it rather than carrying a second estimator that would disagree at the
margin.

**Every typed secret is stretched with Argon2id**, at parameters sized for a wrap attacked offline
(`crypto_service.ARGON2_*`). Each slot records the KDF and parameters it was written with, so they can be
raised without stranding a slot written under older ones. Guidance on both moves — hardware gets faster,
and a weakness is found in an algorithm — so checking them against it is a release step
(`releasing.md` → *Reviewing the vault's cryptography*).

**A passphrase can be judged, and its wrap strengthened, only while it is in hand**, so both happen when it
is typed to unlock. The verdict is re-taken under the current rule and stored with what it was taken
under — the rule's version and the estimator's release (`STRENGTH_BASIS`), since a new release can move a
score as surely as a new threshold — and a slot on an outdated KDF is rewrapped under the current one,
keeping its keypair. A passphrase that fails a tightened rule **keeps opening the vault**: refusing the unlock would
stop that member syncing over a passphrase nobody has shown to be exposed. What it loses is what a weak
wrap would put at risk — connecting a data source, and taking a backup that would carry it — until its
owner, the only person who can, changes it. A verdict from an earlier basis stands until the passphrase is
next typed, except that a backup carrying it waits for a current one. Meanwhile its owner is
asked, dismissably, to unlock once by typing it: nothing is known to be wrong, and it is the only way the
question reaches someone who unlocks with a passkey, which cannot judge a passphrase.

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

**Removing the last member resets the vault.** Deleting the only user who can open it, or revoking their
access, leaves ciphertext nobody can read and a vault that a new passphrase can only join pending, with
nobody to approve it. The removal is therefore followed by a reset (`crypto_service.remove_vault_member`),
which retires the key as `lost`: nobody here holds it, so the backups carrying it stay the way back. The
deletion is warned about and never refused; the confirmation names the consequence and the way to keep the
credentials, which is to have that user approve someone else first.

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
request says** — the `Host` header is the client's to write (`backend/transport.py`). It is read only to
refuse a name that is not this server's (*Other websites in the same browser*).

**The permissible-HTTP rule.** Plain HTTP on a non-loopback bind is coherent **only when both** hold: no
data provider is configured, **and** the instance is passwordless. The reason to run a perimeter is
distrust of who can reach the box, and that same distrust makes a sniffable **session cookie**
unacceptable — protecting only the login exchange protects nothing, since the cookie is a bearer token on
every request.

**Provider secrets and vault secrets are enforced; the rest is recommended.** Running plain HTTP on a
network is a statement of trust in that network, so the app states what it costs where it is met —
passkeys report themselves unavailable, and a dismissible *Set up HTTPS* task appears once there is a
sign-in to protect — and refuses nothing else. Nothing about the topology is asked ahead of time.

**What is enforced is enforced by the server**, for a request from another device over plain HTTP:

- **A provider's secret** (`transport.require_protected_link`): saving an app secret, revealing one,
  connecting a source (the pasted token, or the exchange that ends a Link session), and opening the Link
  session that leads to one.
- **A secret that opens the vault** (`transport.require_protected_vault_link`): judging, setting or
  changing a passphrase, unlocking with one, issuing or using a recovery code, re-enrolling, and a
  passkey's registration and unlock.

**A vault secret never crosses the network unencrypted.** The passphrase is held to a strength rule
because it guards the key the provider credentials are encrypted under, in the database and in every copy
and backup of it; one read off the network makes that rule pointless. An unlock belongs to the browser
session that made it, so the consequence is the whole rule a plain-HTTP install runs under: **the vault
opens only from a browser on the server**, and connecting, syncing, refreshing accounts and anything else
that needs the vault open is done there. The ledger itself is unaffected and is used from any device.
This replaced an earlier design that let the passphrase through so such an install could sync from
anywhere; that traded the vault's protection for a convenience HTTPS already provides. Someone building
from source who wants that trade sets `transport.VAULT_OVER_PLAIN_HTTP`; it is a constant and not a
setting, so no shipped build and no `.env` line turns the protection off. Provider secrets stay refused
either way.

The interface refuses first, before a secret is typed, since a refusal after the request has been sent is
too late for the secret in it (`VaultGateContext`). The server's refusal is the rule.

**What the gate leaves out:**

- **Sign-in.** Recommended, never required.
- **Backups, in both directions.** The credentials in one are ciphertext under the vault key, and what it
  holds in the clear is protected by encrypting the file, as at rest.
- **Finishing a Link repair, syncing, refreshing accounts, disconnecting.** No secret travels between the
  browser and the server, so none is refused on its own account; each needs the vault open.

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
material that opens it in the control DB. That split *is* the leaked-DB-≠-leaked-credential property, so
ciphertext copied without the slots is **dead on arrival** anywhere else. A snapshot that can sync
after restore needs the ciphertext, the vault slots, **and** someone who knows the passphrase then in
force.

So the credentials and the vault slots that open them ride one part of a backup, the accounts part, and
are restored together.

**The data part carries each connection's non-secret half, and nothing in it opens anything** — the
provider handle, the last sync's result and the resume point (`data-model.md` → *Backups*). Every request
to a provider needs the credential, which only the accounts part carries, as ciphertext. So an unencrypted
data backup reveals which institutions are linked, which its transactions already reveal.

**What an accounts backup holds falls into two groups, protected for different reasons.**

- **The perimeter's material** — password hashes, two-factor secrets, the sign-in setting. It lets someone
  sign in to the running app, which matters only to someone who can also reach it over the network, and
  whoever holds a full backup already holds the ledger the perimeter guards. The database on disk holds it
  in the same form. So it is protected the way the ledger is: by encrypting the backup, which is the
  owner's choice.
- **The credentials.** Protected by the vault slots that travel with them. A backup is kept somewhere the
  app cannot see, and anyone holding it can guess at its slots offline without limit. The file is as hard
  to break as its weakest slot.

**A backup carries every member's slots that hold up.** Recovery codes and passkeys always go in. A
recovery code is generated at full key strength and a passkey's secret never leaves its authenticator, so
neither weakens the file. Passphrases depend on whether the backup is encrypted:

- **Unencrypted:** a passphrase goes in only when it has been validated against the current strength rule
  and passes. Nothing else stands between the file and offline guessing, so each passphrase has to hold up
  on its own. A passphrase is judged when its owner types it, so one not typed since the rule or the
  estimator changed is left out until it is.
- **Encrypted:** every passphrase goes in. Guessing at one first needs the backup's private key, which is
  stored apart from the backup. Protecting that key is the owner's job, as protecting a passphrase is.

After a restore, every member with a slot in the file opens the vault as before. Members without one ask
for access again. Any member's passphrase, recovery code or passkey in the file opens it, so recovery from
a backup does not depend on the one person who took it.

**When the credentials cannot travel, they are left out and the backup is written.** That happens when
the file would carry no way into the vault: nobody can open the vault, or every way in is a passphrase an
unencrypted backup leaves out. The ledger cannot be got back once lost, and a credential can be re-linked,
so a backup of the ledger never waits on the vault. The file says it holds no credentials, and the backup
surface says so before it is made, along with any passphrase an unencrypted backup would leave out.

**A passkey answers only at the host name it was registered under**, so each passkey slot in a file
carries a salted digest of that name. The slots are readable without any key, so a digest rather than the
name; a common name is still guessable from it, which is why it is a courtesy and not a secret. A
passkey's label rides along in the clear, so a restore can name it, and discloses whatever the user named
it, as a backup key's name does.

**A restore of the accounts replaces them; it never merges.** A merge would have to decide, person by
person, whose password and second factor win, and a merged vault would hold two keys for one set of
credentials. Replacing has one answer on every target: an empty install, the one the file came from, or
another, which once replaced is no different from an empty one. The slots are adopted as they were, so
nothing is re-encrypted and no secret is asked for, and the file's people come back with their ids, so
what hangs off those ids reattaches.

**Restore must never cost the operator their way in.** So a file that turns sign-in on is restored only
with the password of an administrator in it, checked against the file before anything changes. Everyone
is signed out, because the identities their sessions were checked against have been replaced.

**The backup keys travel with the accounts.** They decide who can read a backup, which is the perimeter's
concern rather than the ledger's, and a list left behind costs a keypair that has to be generated and
distributed again.

**An older standalone credentials file restores into the vault that is there**, since it carries no
identities its slots could belong to. Whether its credentials are already valid here is read from the
key's seal, never from the wrapping a passphrase change or a KDF upgrade replaces: rotation replaces the
key and leaves every wrapping alone, so a file matched on its wrapping would be copied back verbatim under
a key nothing opens.

**An encrypted backup names its keys in the clear**, so someone restoring it can work out *which* private
key to find before they hold one. Keys are therefore named for what they are, not for who or where.
`SECURITY.md` states this as a scope item; `data-model.md` → *Backups* has the format.

## Recovery and compromise response

**The ladder is ordered by cost**, and the UI offers it in sequence rather than presenting destruction as
the only answer. Another member re-enrolling the stuck user moves nothing. A recovery code re-keys the
passphrase **against the same DEK**, so nothing is re-linked. Restoring a backup's accounts part puts the
vault back as it was, opened by the passphrase or recovery code in force when *it* was taken: a complete
recovery. Only then, reset.

**A backup is a way back only from a lost passphrase.** After a reset for a compromised passphrase, or a
replaced key, a backup's credentials are exposed or under a key someone who should no longer read them
knew, so a restore leaves them out and the reset dialog stops offering those backups. The record of
retired keys is local, so a copy of an old file restored on another install is not caught; revoking at the
provider is what covers that case.

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

## Best practices

**The practices an installation is compared against**, in Settings → *Security checklist*
(`services/security_checklist.py`). The checklist reports each one that applies as met or not, and
refuses nothing: every practice here is one an operator may decide against for their own network.
Adding a practice means adding it here and to the checklist together, and a practice is added only
where the server can tell whether it is met.

- **Sign-in is required once other devices can connect.** The perimeter is what keeps non-users out
  (*Identity and the network perimeter*). Where only its own computer can open the installation, who
  can reach it is decided by who can use that computer, so the practice is not applied there.
- **Other devices connect over HTTPS.** Without it the session cookie and every typed secret cross the
  network readable, and passkeys are unavailable (*Transport security*). Whether another device can
  connect in cleartext is read from what the launcher started — a bind wider than loopback is the
  network reaching plain HTTP — and from any such request actually seen. Three cases get their own
  message:
  - **A wide bind with a proxy in use is elevated**, because devices can skip the proxy and HTTPS is
    bypassed. A proxy counts as in use if a device has connected over HTTPS since startup or the proxy
    answers on this machine now. An old certificate record does not count, since the operator may have
    switched to plain HTTP since.
  - **A wide bind with no proxy** is the supported plain-HTTP setup, so it is an ordinary *not met*.
  - **A source checkout on the network** is told to use server mode behind HTTPS instead.
- **The server is opened by name.** A browser allows passkeys only on a domain, never on an IP address
  (*Obstacles*), and without passkeys the password is the only factor most people will use.
- **The vault passphrase meets the strength rule, backups carry the vault as it is now, devices trust
  the proxy's current certificate, and the running copy is the latest release.** Each of these is also
  a task, and the checklist takes its reading from the task so the two never disagree.

---

## Obstacles

What a second attempt hits, whether or not it is planned.

- **A conditional passphrase floor has to be right at every gate and stay right as providers are added.**
  Any proposal to reintroduce conditionality inherits the problem.
- **Revocation needs an unlocked vault**, because the credential must be decrypted before it can be
  revoked. The forgotten-passphrase case can never satisfy it.
- **No transaction spans the control and data databases.** Rotation, reset, and any future operation that
  changes key material and ciphertext together has to be ordered so every intermediate state is readable.
- **A restore of the accounts writes both databases**, so it is ordered: the credentials first, then the
  people and the vault in one transaction. An interruption between leaves credentials under a key the
  vault does not hold yet, and restoring the same file again completes it, since every step replaces.
- **WebAuthn's two preconditions are the browser's, not the app's.** A bare-IP host can never register a
  passkey however it is served. Any LAN passkey story needs a name *and* HTTPS.
- **Re-linking may land on a new connection row**, depending on how a provider derives its handle — see
  `building-a-connector.md` → where the connection handle comes from, before promising a user that a
  re-link is transparent.
- **An interrupted rotation must be resumed, not restarted.** Restarting pushes the key the ciphertext is
  under off the end of the two a slot can hold.
- **Tightening the strength rule or the KDF reaches a slot only when its passphrase is next typed.** A
  member who never unlocks keeps the old verdict and the old wrap, and a backup already written keeps the
  wrap it was written with for good — only a new backup carries the stronger one.
