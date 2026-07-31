# Security & deployment model

**Status: decided (2026-07-30), not started.** This is the design decision that
[`pre-auth-security-ui.md`](pre-auth-security-ui.md) was blocked on. It settles which deployments
Luma supports, what the login perimeter is (and isn't) for, and how Plaid credentials are protected
at rest. Supersedes the exploratory `server_managed`-only privacy mode as the *meaningful* protection
path. Pick-up-cold summary below; build phases at the end.

## Deployment model

- **No multi-tenant hosted.** Dropped as a target. The `multi_tenant` "preview" security profile and
  the pretense of per-tenant provisioning go away. Down to three onboarding profiles
  (`local_private` / `network_private` / `household_shared`).
- **One shared workspace, multiple login identities.** This is already the shape of the code — members
  are provisioned into the one admin tenant and share one data DB. Per-tenant DB routing
  (`set_current_db_path`, `TENANT_DATA_ROOT/<tenant_id>/`) stays as **dormant plumbing**; we stop
  offering to spin up new tenants but don't rip the routing out (excising it is risky, low-value).
- **What the three concepts are actually *for* (they have unrelated causes — don't couple them):**
  *multiple users* exist to scope **per-user app preferences**, nothing more; *inviting* someone exists
  so each account holder personally authorizes **their own banks** (Plaid Link) into the shared vault;
  an *app password* exists purely for **network-access control** (others on your LAN you don't want
  reading or tampering with the data). A trusting multi-user household can therefore be **entirely
  passwordless** and still need invites — so **no design may assume an invitee has an app password.**
- **The login gate is an authentication *perimeter*, not an authorization system.** Its job is to keep
  *non-users* out. Once inside, every user sees and edits the **same** data with no row/scope
  restriction — this is already true (no data route checks role).
- **Admin role gates *settings*, not *data*.** Keep the existing `_require_admin` split (user
  management, environment/Plaid-key settings). Add nothing at the data layer.
- **App access uses a plain password — never a passkey.** A passkey for *app access* would be security
  theater: the ledger sits unencrypted on disk (see Threat model), so anyone with disk access reads it
  regardless of how fancy the login is. A password is the proportionate perimeter; **passkeys are
  reserved for the Plaid vault**, where they actually protect ciphertext (see Token custody). The
  password is **network-access control only** — see "Identity & the network perimeter" for how the
  "username always, password optional" model resolves against shared data.

## Threat model / assumptions

- **The backend is not exposed beyond the local network.** Deployments are local (`local_private`) or
  LAN-reachable (`network_private` / `household_shared`); the web port is assumed *not* public-internet
  facing. If someone did expose it, the app password becomes far more load-bearing than this model
  assumes — that's on the operator, and the onboarding profile copy should say so.
- **The ledger (transactions, categories) is plaintext at rest, and that's accepted.** Anyone with the
  DB file or disk access reads it. Protecting the ledger at rest is explicitly *not* a goal here (it
  would need pervasive field or whole-DB encryption). The app password guards *network* access, not
  disk access.
- **Only the Plaid access_tokens get real at-rest protection**, via the vault below — because a leaked
  token is materially worse than a leaked ledger (it's live, ongoing access to the actual bank).

## Identity & the network perimeter (settled)

"Username always required, password *optional*" can't be a **per-user** attribute, because the data is
**shared**. If A has a password but B doesn't, anyone on the LAN just picks B (no password) and sees the
same shared ledger — A's password protected only A's *preferences*, not the data. So a password perimeter
over shared data is inherently **all-or-nothing**: the "optional" lives at the **workspace** level, not
per user.

That maps directly onto **the two modes that already exist** — no new mode needed:

- **Perimeter off** = today's local mode: named identities with **no** passwords
  (`local_preference_profile`), picked from a chooser. The "don't care about local-network visibility"
  case.
- **Perimeter on** = today's auth mode: every identity is a real `user_account` with a password. Auth is
  **per-user** (decided) — reusing the existing accounts / 2FA / roles / password-policy machinery, so
  login means accountability and a user can be removed without disturbing others.

The toggle between them **is** the "Enable sign-in protection" switch (`enable_auth_mode()` / the old
`AuthModeSection`), one of the three Settings forms being rebuilt. The remaining work is **unification,
not a new mode**:

1. **Present both as "users."** Show local profiles *as usernames* (not a lesser "profile" concept) and
   **require picking/naming an identity** — no anonymous default — so "username always" holds even
   passwordless.
2. **Migrate on flip.** Turning sign-in protection *on* converts existing local profiles into
   `user_account`s (each sets a password then), rather than today's behavior of bootstrapping a fresh
   admin and orphaning the profiles.
3. **Keep the two tables under the hood.** The global `auth_required()` gate, the middleware's
   session-vs-local-user branch, preference-scope keying, and tenant routing are all wired to the split;
   collapsing them into one nullable-password table is a deep refactor for no user-visible gain.

The Plaid vault stays **orthogonal**: a fully passwordless (perimeter-off) install can still have
vault-encrypted tokens, because the vault secret is per-user and independent of the app perimeter.

## The Plaid credential model (so the two secrets don't get conflated)

Every aggregator has **two levels** of secret; only the *shapes* differ per provider:

1. **App-level credential** — identifies the *Luma app* to the provider; app-wide (same for every user
   and bank). Shapes differ: Plaid = `client_id` + `secret`; Teller = an **mTLS client cert + private
   key**; SimpleFIN = a setup token → **access URL**; GoCardless = `secret_id`/`secret_key`.
   **Correction (settled):** Plaid's free BYOK tier has **no approval gate** — any hobbyist signs up and
   can link a small number of live accounts (≈10) for free; production is a paid scale-up, not a
   permission wall. So Plaid is a fine *first* provider to actually test (see sequencing below).
2. **Per-connection credential** — one **per linked bank connection**, stored in the data DB. For Plaid
   it's the `access_token`; `access_token + client_id + secret` = pull that bank's full history. **These
   are the crown jewels.**

**Where app-level credentials live (reversed from an earlier draft):** they move **out of `.env` and
into the DB**, DEK-encrypted under the vault, exactly like the per-connection secrets (there is no
plaintext path — see custody below). The earlier "keep them in env, they're lower
sensitivity" call is dropped: the only things you *do* with the app credential are connect and sync, and
both already require the vault unlocked (the per-connection token is under the DEK too), so "vaulting
makes it dead until unlock" costs nothing in practice — while env leaves a real secret sitting plaintext
on disk. This is **uniform across providers**: Plaid's `client_id`/`secret`, Teller's private key,
SimpleFIN's URL all live in the DB under the vault. `.env` may remain a bootstrap/override, but the DB is
the home. Admin-gated to *configure*; any vaulted user can *use*.

**No provider imposes a per-user boundary** — the API only needs its credentials + a connection token and
has no notion of which human is calling. So *any* boundary between users is one **Luma** builds, entirely
via **who can decrypt which per-connection secret**.

## Provider-agnostic connections (settled)

The vault protects an **opaque secret** under the DEK — it doesn't care whether that's a Plaid
`access_token`, a Teller token/mTLS key, or a SimpleFIN URL — so the hard part is *already*
provider-neutral. Generalize the Plaid-specific edges into a connection abstraction:

- **Storage:** replace `plaid_item` (item_id/access_token) and the `plaid_account_id`/`plaid_item_id`
  account columns with a `connection` carrying a `provider` discriminator + an encrypted, provider-shaped
  credential blob, and `provider`/`external_account_id`/`connection_id` on accounts.
- **Adapter interface:** turn `plaid_service` + the sync path into a pluggable provider adapter
  (`connect`, `exchange`, `fetch_accounts`, `fetch_transactions`) normalized to the existing plain-dict
  contracts (the normalization seam already exists — it just becomes an interface).
- **Sequencing:** ship the seam with **Plaid as the first adapter**, then **Teller**, then **SimpleFIN**
  (already noted in `import-input-formats.md` as a Plaid-parallel connection track). Teller/SimpleFIN are
  more self-serve than Plaid but Plaid's free tier is enough to build against first.
- **UI home (settled): per-provider data-source cards on the Accounts → Connections tab.** Connections
  already live there (`Accounts / Owners / Connections`; the "+ Connect bank" / "Sync now" surface) — not
  Import/Export, not a new Settings card (connections *produce* accounts; edit where the data is viewed).
  Generalize today's single "Data Source Connections" card into a **card per configured provider** (reuse
  `SectionCard`):
  - a **"+ Add data source"** control picks a supported provider (Plaid / Teller / SimpleFIN) not yet
    configured, creating its card in a "needs configuration" state;
  - each card, top to bottom: **provider + mode badge** (Sandbox/Production); **Configure** (admin-gated)
    — the app-level credential + mode entry, which is where provider config **moves to, out of Settings
    entirely** (repurposing the `read/write_environment_settings` endpoints per-provider); **Connect bank**
    (Link/enroll, needs the vault unlocked); the **linked connections/accounts**; **Sync now + last-fetch
    status/timestamp**; and a locked-vault "unlock to connect/sync" state.
  - Admin gates *configure*; any vaulted user *connects/syncs* — matching the auth split. The current
    tab copy references a **deprecated Plaid "development mode" in `.env`** — fix that when building.
  - (Renaming the overloaded `Import / Export / Backup` page is a *separate*, optional cleanup —
    connections don't live there, so this doesn't force it.)

## Token custody: multi-wrap envelope encryption

Goal: **leaked DB ≠ leaked tokens**, while any authenticated user can still sync (pulling transactions
is just editing the shared data). Realized as **multi-recipient envelope encryption** — the same family
as LUKS key slots, PGP encrypt-to-many, and password-manager shared vaults:

- Generate **one** workspace Data Encryption Key (DEK).
- Encrypt each **per-connection secret** once, under the DEK (ciphertext in the data DB — `plaid_item`
  today, the generalized `connection` table going forward; see "Provider-agnostic connections").
- **Wrap the DEK separately per unlock method ("key slot")**, each wrap stored in the control DB. Every
  user unwraps their own slot → gets the DEK → decrypts the tokens. No unlock secret is ever stored.

### Trust model: the server is trusted; crypto runs server-side (settled)

All wrap/unwrap runs **server-side** (where `crypto_service` already lives). The unlock secret
(passphrase, or the passkey's PRF output posted from the browser) reaches the backend, which derives the
KEK, unwraps the DEK, and uses it. This protects against **theft of the DB file at rest** — an attacker
with the file but no live secret can't decrypt — but **not** against a compromised *running* host.

That's the right trade because we dropped multi-tenant hosting: the deployment is "you run Luma on your
own machine / LAN box," so the server *is* your trusted hardware. "Compromised running server" ≈ "someone
owns the box you run the app on," at which point the ledger is readable off disk anyway (see Threat
model). Browser-side (zero-knowledge) crypto would only add defense against an untrusted host, which this
model deliberately doesn't include. The ceremony below keeps the same *shape* if we ever wanted an
untrusted-host mode — every wrap/unwrap would just move into the browser — so this choice isn't a corner.

### Unlock methods (key slots)

The Plaid vault secret is **separate from the login password** — a deliberate, settled decision. A slot's
KEK can come from either source:

- **Passphrase slot** — KEK = `Argon2/scrypt(passphrase)`. (`user_secret_material` already has the unused
  `wrapping_kdf_salt` / `wrapping_kdf_iters` columns for this.)
- **Passkey slot (WebAuthn PRF)** — KEK = `PRF(salt)` from the passkey. NOTE: a *plain* passkey is
  auth-only and yields no stable key material; the **`prf` extension** (CTAP2 `hmac-secret`) is what
  returns a stable, secret, high-entropy value usable as a KEK. Must be enabled at *registration*, and
  the PRF output is only available during a live `get()` ceremony (matters for enrollment, below).

Intended default UX: the user keeps a **passkey in their password vault** (1Password / iCloud Keychain /
Google Password Manager — synced, so it survives device loss), and **fingerprint / Face ID** is the
day-to-day unlock because it's simpler than reopening the vault. Both resolve to the same PRF-derived
KEK; the biometric is the platform authenticator gate, not a separate crypto path.

### No required fallback; loss just means re-link (settled)

We do **not** require a fallback slot and build **no** recovery/escrow machinery. If a user loses their
only slot, the only thing lost is the **Plaid account connections**, which are re-linkable — an
acceptable outcome, so we don't engineer around it. Warn clearly; that's it. A synced passkey (the
intended default) makes loss unlikely anyway. Multi-wrap still *allows* a user to enroll more than one
slot (e.g. passphrase + passkey) if they want the convenience — it's just never mandatory, and no slot
exists purely as an escrow.

### The vault is the only custody path — no `off`, no `server_managed` (settled)

`server_managed` privacy mode is **retired** (it let the server decrypt at rest, so it never delivered
"leaked DB ≠ leaked tokens"). And there is **no `off`/plaintext mode either** — a live token is never
stored in the clear. There's no legitimate need for one: **Production** plaintext is unacceptable (real,
ongoing bank access on disk), and **Sandbox** plaintext is harmless but pointless when a throwaway
passphrase costs nothing. Dropping `off` also removes the footgun where an install flips sandbox→
production while custody is off and silently leaks real tokens. Retire the `APP_MASTER_KEY` →
`SESSION_SECRET` fallback along with all this.

**Passphrase strength is keyed to provider mode.** Sandbox accepts *any* vault passphrase (even trivial —
you type a throwaway once per session via the unlock cache). **Switching a provider to Production requires
the vault passphrase to meet a real minimum first**, so real tokens can never sit under a weak secret —
turning "definitely not plaintext/weak in Production" from a hope into an enforced gate. (This is the
*vault passphrase's* own minimum; separate from the app-login password policy — `none`/`min_8`/`strong` —
which governs the orthogonal network perimeter.)

**Consequence:** connecting a live data source **always** requires setting a vault passphrase — even on a
passwordless-app (perimeter-off) install. That's correct: app-login and the vault are orthogonal, and
"store real bank tokens with zero secrets" is exactly what must be impossible.

## Provisioning a new user (the one real cost of multi-wrap)

To wrap the DEK for a new user you must hold the DEK **in plaintext at that moment** — and it's only
recoverable by an existing member unlocking their own slot. So an admin creating user B **cannot** grant
B vault access alone (admin lacks B's secret; B lacks the DEK). Two paths, **both supported**:

- **Co-present enrollment** — an existing unlocked member is at the machine when B sets up their slot;
  the DEK is wrapped for B on the spot. (Passkey twist: the PRF KEK only exists during B's live `get()`,
  so this must happen inside B's active session.)
- **Invite** — for the not-co-present case. An existing member mints a one-time invite secret that the
  DEK is wrapped under; the new user redeems it and re-wraps under their own slot. Full ceremony below.

Removing a user = drop their slot. If the departure is **untrusted**, that isn't enough (they may have
seen the DEK while unlocked): **rotate** — generate DEK′, re-encrypt all tokens under it, re-wrap DEK′
for every *remaining* slot. Their old slot and any retained DEK copy are then dead for new ciphertext.
Rotation can't undo *past* access, so a genuinely hostile departure also implies **re-linking** the
affected banks. (This is the same rotation you'd run when rotating the vault after any secret exposure.)

## Invite ceremony

Purpose: let a not-co-present new user B get a vault slot so B can connect their own banks and sync. It's
just the multi-wrap pattern applied twice — a throwaway invite slot that exists only long enough to birth
B's real slot. Runs server-side (trusted-server model above).

**The invite secret `S`.** Machine-generated, **128 bits** of randomness, rendered as ~26 Crockford
base32 chars (no ambiguous `0/O`, `1/I/L`; case-insensitive; readable aloud), grouped for legibility
(`7K4W-9QMX-2TBR-8HN3-JCP5-DYG2-NF`) — or, as a link, the same 128 bits as a ~22-char base64url blob in
the URL **fragment** (`luma.local/invite/<invite_id>#<S>`), which the browser never sends to the server.
Because `S` is already high-entropy it feeds a cheap `HKDF`, not `Argon2` (nothing weak to harden). It
must resist *offline* brute force on its own, since a DB stolen during the live window exposes
`wrapped_DEK_S` — 128 bits covers that with room to spare.

**Delivery: the app mints, the human carries.** The app does **not** send email or any message itself
(no SMTP infra for a self-hosted LAN app; and it'd pin `S` into an inbox). It produces a **copy-able code
or link**; the granter delivers it over whatever channel they choose (aloud, ephemeral messenger, email).
This keeps `S` and `wrapped_DEK_S` in **separate trust domains** — an attacker needs both. And they must
coincide **in time**: `wrapped_DEK_S` is expiry-bounded and single-use, deleted on redemption, so a stale
`S` in an old inbox later is **inert**. If B already has an app account (the common household case), also
drop a *non-secret* "you've been invited → [Redeem]" notice in-app — pure UX, carries no secret.

### 1. Create (granter, while unlocked)

The granter must have an **unlocked session** (the server holds the DEK in their session cache — the same
cache that powers "first sync of the day"). The server:

- generates `S` (128-bit) and a non-secret `invite_id`;
- derives `KEK_S = HKDF(S)` and computes `wrapped_DEK_S = AEAD(KEK_S, DEK, aad=invite_id)`;
- stores a `pending_invite` row `{invite_id, wrapped_DEK_S, expiry, created_by}` — **`S` is never stored
  in any recoverable form**, and no separate verifier is needed because the **AEAD tag is the verifier**
  (a wrong `S` fails to decrypt);
- returns `S` to the granter **once** (as the code/link) to carry out-of-band.

Default expiry **48–72h**; single-use; granter/admin can revoke a pending invite before it's used.

### 2. Deliver (out of band)

Granter hands the code/link to B over any channel they like. `invite_id` is non-secret; `S` is the bearer
secret.

### 3. Redeem (B, live session)

- B opens the invite (`invite_id` + `S`). Server looks up by `invite_id`, checks not expired / not
  consumed, derives `KEK_S = HKDF(S)`, and **trial-decrypts** `wrapped_DEK_S` → DEK (failure = wrong `S`,
  reject; rate-limit redemption attempts).
- B chooses their **permanent** unlock method and the server writes B's slot `wrapped_DEK_B`:
  - **passphrase** → `KEK_B = Argon2(P, fresh_salt)`;
  - **passkey** → register with the `prf` extension in B's browser; PRF output → `KEK_B`. *(Must run in
    B's live session with the authenticator present — which redemption is.)*
- Server **deletes the `pending_invite`** (single-use); DEK leaves memory.

`S` is a **bearer token** until redeemed — whoever holds it first can claim the slot. Short expiry +
single-use + out-of-band delivery + revocability are the mitigations; acceptable for a household, and
worth stating in the invite copy.

### Account creation vs. vault grant are separable

Creating B's *app account* (username, optional password, role) needs **admin** and no DEK. Granting B's
*vault slot* needs an **unlocked member** and the DEK. When the granter is an unlocked admin it's one
"invite a person" flow; otherwise it splits (admin makes the account; any unlocked member sends the vault
invite). Build the combined flow, allow the split.

## Where things live / why no DB-file encryption

- Token **ciphertext** → data DB (`plaid_item.access_token_enc`), so it travels with data backups.
- **Wrapping material** (per-slot wrapped DEK, KDF salt/iters, `key_mode`) → control DB
  (`user_secret_material`).
- Unlock secrets (passphrase / passkey PRF) → **never at rest**.

Because the crown jewels are already ciphertext and the keys are never stored decryptable, **whole-DB
file encryption is redundant** for them — this is handled at the software (field) level. **Consequence
to keep conscious:** the **ledger itself (transactions, categories) stays plaintext at rest**, protected
by the login perimeter + host security, not crypto. Encrypting the ledger at rest would be a much bigger
lift (pervasive field encryption or whole-DB) and is **out of scope** for this initiative.

## Open questions

None substantive remain — the model is fully decided. Remaining unknowns are implementation-level
(exact table columns, endpoint shapes, UI copy) and belong to the build, not the design.

**Resolved:** deployment model (no multi-tenant hosted; one shared workspace, multiple identities; login
= perimeter, admin gates settings not data); trusted-server / server-side crypto (browser-side only if we
ever want an untrusted host); retire `server_managed`, the master-key fallback, **and any `off`/plaintext
token path** — the vault is the *only* custody, with passphrase strength keyed to provider mode (sandbox
lax, Production enforced); no required fallback slot / no recovery escrow (loss = re-link); passkeys are
Plaid-vault-only; **identity & perimeter** — password optionality is an all-or-nothing *workspace* toggle
(the existing two modes), per-user auth when on, unify presentation + migrate profiles→accounts on flip,
keep the two tables; **invite ceremony** — 128-bit HKDF bearer secret, app mints a copy-able code/link and
the human carries it (no email sending), 48–72h + single-use, AEAD-tag-as-verifier, account-creation
separable from vault-grant, rotate-on-untrusted-departure; **provider-agnostic connections** — a
`connection` table with a `provider` discriminator + opaque encrypted credential blob and an adapter
interface, Plaid first then Teller then SimpleFIN, app-level credentials moved from `.env` into the DB
under the vault, per-provider **data-source cards** on the Accounts → Connections tab (provider config
moves there out of Settings; "+ Add data source" → configure / connect / sync / last-fetch per card).
Plaid BYOK has **no approval gate** (free tier ≈10 accounts) — the earlier "sandbox-only until approved"
premise was wrong.

## Build phases (rough, when unblocked)

1. **Drop the multi-tenant pretense** — remove `multi_tenant` profile, doc the single-workspace model.
   Small; mostly copy/UI.
2. **Rebuild the three Settings forms** (per [`pre-auth-security-ui.md`](pre-auth-security-ui.md)) —
   security profile / sign-in protection / password policy. Backend + lib helpers already exist; only
   missing wiring is exposing setters from `useAppSession()`.
2b. **Unify the identity presentation** — show local profiles as "users," require a named identity (no
   anonymous default), and make "enable sign-in protection" **migrate** existing local profiles into
   `user_account`s (each sets a password) instead of bootstrapping a fresh admin. Keep the two tables.
3. **Multi-wrap vault core** — workspace DEK, per-slot wrapped-DEK storage, passphrase-slot KDF path
   (columns already present), session-scoped unlock caching, rework `crypto_service` from per-user DEK to
   one shared DEK + slots. **Retire `server_managed`, the `APP_MASTER_KEY`→`SESSION_SECRET` fallback, and
   the `off`/plaintext path** — the vault is the only custody; enforce a vault-passphrase minimum when a
   provider is set to Production (sandbox stays lax).
4. **Passkey (PRF) slot** — registration with the `prf` extension, unlock ceremony, biometric daily
   unlock, graceful "your authenticator lacks PRF → use a passphrase slot" fallback.
5. **Enrollment/invite** — co-present path first (simpler), then the invite ceremony (mint copy-able
   code/link, `pending_invite` table, redeem + re-wrap, expiry/single-use/revoke), then rotation-on-
   departure. No email sending.
6. **Generalize to provider-agnostic connections** — `connection` table (`provider` + opaque encrypted
   credential blob) replacing `plaid_item`; a provider-adapter interface refactored out of
   `plaid_service`/sync; move app-level credentials from `.env` into the DB under vault custody; extend
   the Accounts → Connections tab. Ship **Plaid** as the first adapter; Teller, then SimpleFIN, follow.

## Cross-refs

- [`pre-auth-security-ui.md`](pre-auth-security-ui.md) — the deferred Settings-UI rebuild this unblocks.
- [`merchant-rename-fate.md`](merchant-rename-fate.md) — revisits "when Plaid sync is exercised"; same
  trigger.
- `import-input-formats.md` — lists SimpleFIN as a "Plaid-parallel connection/sync track"; this doc's
  provider-agnostic connection model is the seam that item plugs into.
- Memory `plaid-deferred-until-approval` — **superseded/corrected here:** Plaid BYOK has no approval gate
  (free tier ≈10 accounts), so Plaid is the intended *first* connection provider to test, not a deferred
  one. (Memory updated to match.)
