# Security policy

Luma handles financial transaction history and, when data sources are connected, credentials that grant
ongoing access to bank accounts. Luma only reads through them, but a credential may allow more than
reading. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately rather than in a public issue, using GitHub's **Report a vulnerability** button
under this repository's *Security* tab. That opens a private advisory visible only to the maintainer.

A useful report says what an attacker can reach, and how. Where possible include the affected version or
commit, the deployment type (single-user desktop, or a LAN server behind a reverse proxy — these have
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
  privilege escalation between identities, or admin-gated settings reachable without admin rights.
- **Injection of any kind** — SQL injection, stored or reflected XSS, template injection, path traversal
  in the import, backup, or restore paths.
- **Weaknesses in backup encryption**, or a backup that carries more than it should.
- **Anything that causes an outbound network request the user did not initiate.** Luma's stated
  behavior is that it reaches the network only for user-driven actions; a violation of that is a
  security bug, not a feature request.
- Dependency vulnerabilities that are actually reachable through Luma's own code paths.

**Out of scope — known and deliberate design properties.** These are documented behavior, not
oversights, and reports about them will be closed with a pointer here:

- **Transaction data is stored unencrypted on disk.** The ledger is a plain SQLite database.
  Protecting the database files and any unencrypted backups is the operator's responsibility: keep them
  out of shared and cloud-synced folders, or use encrypted backups.
- **The sign-in password is network-access control, nothing else.** It governs who can reach a
  running instance. It does not encrypt the database and does not protect files copied off the disk.
- **A local user with filesystem access can read the ledger.** There is no defense against an attacker
  who already has the account the app runs under.
- **Serving over plain HTTP on a trusted LAN** is a supported deployment type. The transport-security
  policy for each deployment type is in the model doc below, and the risks and limitations of plain HTTP
  are the operator's to accept. Setting up HTTPS takes a few steps; see the README.
- **An encrypted backup names its backup keys in the clear.** The manifest stores each backup key's name
  and fingerprint outside the ciphertext, so anyone holding the file can read them. That is deliberate:
  whoever restores a backup can tell which private key it needs. Name keys for what they are
  (`Offsite drive`), not for who holds them or where.
- **The vault passphrase cannot be recovered.** Without a passphrase, a passkey or the recovery code the
  vault cannot be opened, and every data connection has to be set up again.
- Findings from automated scanners with no demonstrated path to impact, and vulnerabilities in
  dependencies that Luma does not actually exercise.

## What a compromise would mean

Stated plainly, because it determines what is worth reporting and what a user should do.

The vault's contents are encrypted with a data-encryption key (DEK). Each way into the vault (a
passphrase, a passkey or the recovery code) is a key slot: a keypair whose private key is protected by
that secret, with the DEK sealed to the slot's public key.

- **A leaked database or unencrypted backup** exposes the transaction history it holds, permanently:
  it was never encrypted, and nothing done afterwards changes the contents of a file someone already
  has. The stored data-source credentials in that copy are encrypted, but they are protected only by
  how well the vault passphrase resists an **offline** attack against the copy — so treat them as
  reachable given enough time, and **replace** the provider connection credentials.
- **A leaked provider credential** grants whatever access the provider issued it for, for as long as it
  remains valid. Luma only ever *uses* read access — transactions, balances, and the account metadata
  that identifies them — and never initiates money-movement. However what a credential *can* do is
  the provider's to define, not Luma's: depending on the provider and what the connection was created
  with, it may also reach account and routing numbers or identity details. Treat the ceiling as
  whatever that provider's own dashboard says the credential can do. Revoke it at the provider, or
  replace it where the provider can issue a new one, following that provider's documentation. That is
  the only action that affects a credential in a copy someone already has.
- **After a leaked file, assume the vault secrets are recoverable and change them.** Nothing done
  afterwards protects the copy already taken — only replacing the credentials limits that. But whatever an offline
  attack against the copy yields (the passphrase, and through it the slot's private key and the DEK)
  stays valid against **anything encrypted afterwards** until it is deliberately retired — including
  the replacement credentials that retiring makes necessary. So the full response is, in order:
  **replace every provider connection credential** — an app secret rotated and its old value deleted, or
  a credential with no app secret revoked and reissued (*Vault settings → Respond to an exposure* lists
  them) — then **change the vault passphrase**, then **replace the vault key**.
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
