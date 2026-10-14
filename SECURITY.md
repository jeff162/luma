# Security policy

Luma handles financial transaction history and, when data sources are connected, credentials that grant
ongoing access to bank accounts (Luma only uses read access but the credentials may grant additional access). Security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately rather than in a public issue, using GitHub's **Report a vulnerability** button
under this repository's *Security* tab. That opens a private advisory visible only to the maintainer.

A useful report says what an attacker can reach, and how. Where possible include the affected version or
commit, the deployment shape (single-user desktop, or a LAN server behind a reverse proxy — these have
materially different exposure), whether the sign-in perimeter is enabled, and the steps to reproduce.
Proof-of-concept code is welcome but never required.

Expect an acknowledgement within a week. Luma is maintained by one person, so please allow reasonable
time for a fix before disclosing publicly. Credit is given in the release notes unless anonymity is
preferred.

## Supported versions

Luma is pre-1.0 and ships from `main`. Security fixes land there; there are no maintained release
branches, and no backports to earlier tags.

## Scope

**In scope** — these are the things a report should be about:

- Anything that exposes **vault-protected credentials**: the envelope encryption, the per-user key
  slots, the key-replacement path, or a route that returns a stored provider credential.
- **Authentication or session flaws** when the sign-in perimeter is enabled — bypass, fixation,
  privilege escalation between identities, or admin-gated settings reachable without admin.
- **Injection of any kind** — SQL injection, stored or reflected XSS, template injection, path traversal
  in the import, backup, or restore paths.
- **Weaknesses in backup encryption**, or a backup that carries more than it should.
- **Anything that causes an outbound network request the user did not initiate.** Luma's stated
  behavior is that it reaches the network only for user-driven actions; a violation of that is a
  security bug, not a feature request.
- Dependency vulnerabilities that are actually reachable through Luma's own code paths.

**Out of scope — known and deliberate design properties.** These are documented behavior, not
oversights, and reports about them will be closed with a pointer here:

- **Transaction data is stored unencrypted on disk.** The ledger is a local SQLite database in plain
  form. The database files and any unencrypted backup are the sensitive artifacts, and protecting them
  is the operator's responsibility — keep them off shared and cloud-synced locations, and use the
  encrypted backup for anything that leaves the machine.
- **The sign-in password is network-access control, not disk encryption.** It governs who can reach a
  running instance. It does not encrypt the database and does not protect files copied off the disk.
- **A local user with filesystem access can read the ledger.** There is no defense against an attacker
  who already has the account the app runs under.
- **Serving over plain HTTP on a trusted LAN** is a supported deployment shape. The transport-security
  policy per topology is documented in the model doc below; the risk of choosing HTTP is the operator's
  to accept.
- **An encrypted backup names its backup keys in the clear.** The manifest carries each key's name and
  fingerprint outside the ciphertext (as `recipient_id`/`label`, the field names the format has always
  used), so anyone holding the file can read them without any key at all. That is deliberate and
  load-bearing: it is what lets someone restoring a backup work out *which* private key to go and find,
  before they hold one — the alternative is a file that cannot say what would open it. The consequence to
  know is that those names are a disclosure: a key named after a person or a place reveals that name to
  anyone who obtains the file, while the ledger inside stays sealed. Name keys for what they are
  (`Offsite drive`) rather than for who or where.
- **The vault passphrase is unrecoverable by design** and is never stored — no unlock secret can be
  reconstructed from anything on disk, and that remains true of the recovery code, which is also stored
  only as the KEK it derives. What a recovery code changes is that a *forgotten* passphrase need not be
  a dead end: it opens the vault and re-keys the passphrase against the same DEK, so nothing is
  re-encrypted. Losing every way in — passphrase, passkeys and recovery code — still means re-linking
  data sources; the ledger is unaffected either way.
- Findings from automated scanners with no demonstrated path to impact, and vulnerabilities in
  dependencies that Luma does not actually exercise.

## What a compromise would mean

Stated plainly, because it determines what is worth reporting and what a user should do:

- **A leaked database or unencrypted backup** exposes the transaction history it holds, permanently:
  it was never encrypted, and nothing done afterwards changes the contents of a file someone already
  has. The stored data-source credentials in that copy are encrypted, but they are protected only by
  how well the vault passphrase resists an **offline** attack against the copy — so the data-source credentials should be
  treated as reachable given enough time, and **revoked** on the provider side.
- **A leaked provider credential** grants whatever access the provider issued it for, for as long as it
  remains valid. Luma only ever *uses* read access — transactions, balances, and the account metadata
  that identifies them — and never requests a money-movement product. But what a credential *can* do is
  the provider's to define, not Luma's: depending on the provider and what the connection was created
  with, it may also reach account and routing numbers or identity details, and an app-level credential
  (a client id and secret) reaches every connection made with it rather than one. Treat the ceiling as
  whatever that provider's own dashboard says the credential can do, and check it there. Retiring it at
  the provider is the response — revoking it, or replacing it where the provider can issue a new one — and
  it is the *only* action that reaches a credential already sitting in someone else's copy. How a provider
  deactivates its credentials is its own to define, so each step follows that provider's documentation. Revocation differs by provider — a declared capability, `revokes_on_disconnect`: where the
  provider supports third-party revocation, disconnecting from Luma genuinely ends that connection's
  access; where it does not, disconnecting removes only Luma's copy and the credential must be revoked at
  the provider. The disconnect confirmation states which of the two is about to happen. **Neither retires
  an app-level secret**: revoking every connection leaves the secret they were authorized under valid, so
  after a leak it is rotated at the provider *and the old one deleted* — a provider may keep a rotated-away
  secret working until it is deleted (Plaid does). An ordinary disconnect, with nothing exposed, needs
  none of this.
- **After a leaked file, assume the vault secrets are recoverable and change them.** Nothing done
  afterwards protects the copy already taken — only revocation limits that. But whatever an offline
  attack against the copy yields (the passphrase, and through it the slot's private key and the DEK)
  stays valid against **anything encrypted afterwards** until it is deliberately retired — including the
  replacement credentials that retiring makes necessary. So the full response is, in order: **retire
  every credential** — each connection, replaced where its provider can so it keeps syncing (*Vault
  settings → Respond to an exposure*) and otherwise revoked, plus any app secret rotated and its old value
  deleted — then **change the vault passphrase**, then **replace the vault key**. That is one
  response to one incident rather than a schedule; whether the exposure can recur is a property of how
  the file escaped, and closing that path is a separate job from this one.
- **Those last two are not interchangeable — they retire different artifacts.** A passphrase change
  re-wraps the slot under a new key but leaves the DEK unchanged, so a recovered *DEK* would still
  decrypt a future copy's ciphertext without any passphrase at all. A key replacement re-encrypts
  everything under a new DEK but does not alter the passphrase, so a recovered *passphrase* would still
  open the slot. Retiring both recovered artifacts takes both actions.
- **Replacing the vault key also answers a separate threat: a DEK someone saw while the vault was
  unlocked** — a household member being removed, or anyone who had it open. Rotation means the key they
  hold stops opening anything from then on. Removing someone's slots does not do this on its own, since
  it cannot un-see a key already held, so a hostile departure is **remove access, then replace the vault
  key**, in that order.

## Further reading

- `README.md` → *Security* — the same model in user-facing terms.
- `docs/security-model.md` — the maintainer record: the assumptions this policy is downstream of, what
  is deliberately not defended, and the conditions under which a decision has to be reopened.
- `docs/architecture.md` — the mechanism as built: the multi-wrap envelope encryption, keypair-based
  key slots, the enrollment and rotation ceremonies, and the transport-security policy per deployment
  topology. `docs/data-model.md` covers backups and where the model meets the rest of the system.
