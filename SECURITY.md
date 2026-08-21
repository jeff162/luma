# Security policy

Luma handles financial transaction history and, when data sources are connected, credentials that grant
ongoing read access to bank accounts. Security reports are welcome and taken seriously.

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
- **The vault passphrase is unrecoverable by design** and is never stored. Losing every way into the
  vault means re-linking data sources; the ledger is unaffected.
- Findings from automated scanners with no demonstrated path to impact, and vulnerabilities in
  dependencies that Luma does not actually exercise.

## What a compromise would mean

Stated plainly, because it determines what is worth reporting and what a user should do:

- **A leaked database or unencrypted backup** exposes the transaction history it holds, permanently:
  it was never encrypted, and nothing done afterwards changes the contents of a file someone already
  has. The stored data-source credentials in that copy are encrypted, but they are protected only by
  how well the vault passphrase resists an **offline** attack against the copy — so they should be
  treated as reachable given enough time, and **revoked** rather than relied on.
- **A leaked provider credential** grants **read-only** access to transactions and balances for as long
  as it remains valid. It cannot move money. Revoking it is the response, and it is the *only* action
  that reaches a credential already sitting in someone else's copy. Revocation differs by provider —
  a declared capability, `revokes_on_disconnect`: where the provider supports third-party revocation,
  disconnecting from Luma genuinely ends the access; where it does not, disconnecting removes only
  Luma's copy and the credential must be revoked at the provider. The disconnect confirmation states
  which of the two is about to happen.
- **After a leaked file, assume the vault secrets are recoverable and change them.** Nothing done
  afterwards protects the copy already taken — only revocation limits that. But whatever an offline
  attack against the copy yields (the passphrase, and through it the slot's private key and the DEK)
  stays valid against **any future copy** until it is deliberately changed, and a leak that came from a
  synced folder or a backup routine is rarely a one-time event. So the full response is, in order:
  **revoke every credential**, then **change the vault passphrase**, then **replace the vault key**.
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
- `docs/backlog/security-and-deployment-model.md` — the full design: the multi-wrap envelope
  encryption, keypair-based key slots, the enrollment and rotation ceremonies, and the
  transport-security policy per deployment topology.
- `docs/architecture.md` and `docs/data-model.md` — where the security model meets the rest of the
  system.
