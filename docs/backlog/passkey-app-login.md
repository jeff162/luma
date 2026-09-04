# Passkey for app login

**Not started (2026-09-04).** Let a user sign in to the app with a passkey **in addition to** the app
password, for convenience. The vault already accepts passkeys; the perimeter does not, and typing a
password on a phone every time someone wants to check a balance is the friction this removes.

This reverses an earlier rejection, and the reason it was rejected is still true — it just answered a
different question. *"A passkey for app access would be security theater: the ledger sits unencrypted on
disk, so anyone with disk access reads it regardless of how strong the login is."* That is a sound
answer to **is this a stronger credential**, and no answer at all to **is this a better way to log in**.
A rejection is only as broad as the argument behind it.

## Why convenience is a security argument here

The perimeter is optional — *"Password optional" is a workspace property* (`security-model.md` →
*Identity and the network perimeter*). What pushes a household toward turning sign-in off is friction, and
a workspace with the perimeter off is one where anyone on the LAN reads the ledger. A login that costs a
fingerprint makes keeping the perimeter **on** cheaper than switching it off, which is a real gain
delivered through adoption rather than through credential strength. An argument that measures only the
strength of the credential cannot see it.

## What does not carry over from the vault's passkeys

The ceremony plumbing transfers. The verification half does not, and that is the bulk of the work.

`security-model.md` → *Considered and rejected* records that the vault deliberately **does not verify the
WebAuthn assertion**: a wrong PRF output fails at the AEAD tag exactly as a wrong passphrase does, so the
slot is self-verifying, and no credential public keys and no challenge state are stored anywhere. App
login is the opposite — it *is* an authentication decision, so it must verify the signature, which means
building precisely what that rejection avoided:

- stored credential public keys, per user, with their sign counters;
- server-issued challenges with expiry and single use;
- assertion verification (origin, RP id, type, signature, counter regression).

Budget the feature as "add WebAuthn authentication", not as "reuse the vault's passkeys".

## Constraints that shape the design

- **A passkey can never be the only credential.** A bare-IP host can never register a passkey however it
  is served (`security-model.md` → *Obstacles*), so an install reached at `192.168.x.x` would have no way
  in at all. The password stays as the floor, and the passkey is strictly additional — on a LAN, the
  feature is reachable only where mDNS + HTTPS already make vault passkeys reachable.
- **The reach is wider than the vault's, not narrower.** App login needs only a plain assertion, not the
  PRF extension, so it works on authenticators that cannot hold a vault slot at all.
- **Do not let one ceremony do both.** Two passkey ceremonies that look identical and mean different
  things — one crosses the perimeter, one opens the vault — is the conflation to design against. Merging
  them is the tempting shortcut and it is exactly the coupling *Do not couple them* forbids: signing in
  would imply vault authority. Distinct copy at minimum, and never a shared ceremony.
- **Registration needs a signed-in session**, and removal needs the same gate, so that losing a device
  cannot lock a user out of an account whose password they still know.

## Open questions

- Whether a passkey login satisfies "the workspace has a perimeter" for a user who has set no password at
  all, or whether a password remains mandatory per account with the passkey as a shortcut over it.
- Whether registered app-login passkeys belong in the same settings surface as vault passkeys. Together is
  discoverable and invites exactly the conflation above; apart is clearer and easier to miss.
