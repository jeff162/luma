# Security & deployment model

**Status: COMPLETE (2026-08-13). Every phase is built.** Phases 1–3 implemented (identity unified to one `user_account` table,
session-based identity in both modes, enable/disable as flag flips; and the multi-wrap vault core +
transport-security policy — workspace DEK, passphrase slots, server-side unlock cache, `server_managed`/
master-key retired, Production passphrase gate, `SESSION_COOKIE_SECURE`/`--proxy-headers`/computed HTTPS
task), phase 6a (the provider-agnostic `connection`/adapter seam, Plaid retargeted onto it), phase 6b-1
(app-level provider creds into the vaulted `provider_config` table, `.env` demoted to a bootstrap fallback),
phase 6b-2 (the per-provider Connections-tab UI + the vault set/unlock UI; provider config removed from
Settings), and phase 6b-3 (the deferred account columns — migration v20: `external_account_id`/
`connection_id`/`provider`, `plaid_item` table dropped, backup payload v8 with v7 restore-translation),
6c (SimpleFIN as the second adapter and the seam generalizations it paid for), and finally **phases 4–5**
(passkey PRF slots; enrollment, grant, revocation and key rotation). The last of those replaced the
planned invite ceremony with **keypair slots** — see "A slot holds a keypair" for the rotation
impossibility that forced the change. This
is the design decision that
[`pre-auth-security-ui.md`](pre-auth-security-ui.md) was blocked on. It settles which deployments
Luma supports, what the login perimeter is (and isn't) for, and how Plaid credentials are protected
at rest. Supersedes the exploratory `server_managed`-only privacy mode as the *meaningful* protection
path. Pick-up-cold summary below; build phases at the end.

## Deployment model

- **No multi-tenant hosted.** Dropped as a target. The `multi_tenant` "preview" security profile and
  the pretense of per-tenant provisioning go away. Down to **two** deployment shapes:
  **Standalone** (this one machine, loopback) and **Client-server** (backend on a networked box,
  reached from other devices). `household_shared` is retired too (it collapses into Client-server; there
  were no stored `household_shared` installs, so no migration). **Refinement (2026-07-31): these two are
  a *detected topology*, not a user-chosen stored preset** — see "Topology is detected, not a chosen
  profile" below. The `security_profile` app-setting (`local_private`/`network_private`) is demoted to a
  stopgap until per-request detection (phase 3) lands.
- **One shared workspace, multiple login identities.** This is already the shape of the code — members
  are provisioned into the one admin tenant and share one data DB. Per-request DB routing
  (`set_current_db_path`, driven by the tenant row's `db_path`) stays as **dormant plumbing**; we stop
  offering to spin up new tenants but don't rip the routing out (excising it is risky, low-value). The
  per-tenant *directory* it once implied is gone — see `optional-env-and-layered-config.md`.
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
  LAN-reachable (`network_private`, i.e. client-server); the web port is assumed *not* public-internet
  facing. If someone did expose it, the app password becomes far more load-bearing than this model
  assumes — that's on the operator, and the onboarding profile copy should say so.
- **The ledger (transactions, categories) is plaintext at rest, and that's accepted.** Anyone with the
  DB file or disk access reads it. Protecting the ledger at rest is explicitly *not* a goal here (it
  would need pervasive field or whole-DB encryption). The app password guards *network* access, not
  disk access.
- **Only the provider access_tokens get real at-rest protection**, via the vault below — because a leaked
  token is *live and ongoing*, worse than the ledger in the **future/duration** dimension: the ledger is a
  static snapshot the thief already has, while a token keeps pulling **new** data until revoked.
  **Right-sizing this (refined 2026-08-01):** Luma requests Plaid's `transactions` product only, so the
  token is **read-only** (transaction history + balances; not payment-capable, and it doesn't even expose
  account/routing numbers — that's the `auth` product). So the realistic worst case is *ongoing read
  access to financial data*, **revocable** by disconnecting the connection (which calls the provider's
  item-remove; see the disconnect flow) — **not** "access to the actual bank." Framing the token as
  uniquely precious "crown jewels" overstated it; the honest framing is below. **This conditioning is on
  read-only** — adding a payment-capable token (Teller payments) or `auth`/`identity` would enlarge the
  blast radius past the ledger and this section must be revisited.
- **The two clauses are independent, and SimpleFIN breaks one of them (2026-08-07).** The conditioning
  above bundles *read-only* and *revocable in-app*; a second provider shows they vary separately. A
  SimpleFIN access URL is **read-only** — more robustly than Plaid's, since the protocol has no write side
  at all rather than merely not requesting one. But SimpleFIN publishes **no revocation call**: nothing
  Luma can send invalidates an access URL. Disconnecting deletes Luma's copy; the credential stays live
  until the user revokes it at the Bridge.

  What that changes: for such a provider the compromise playbook's "disconnect to revoke" step **does not
  apply**, and the mitigation becomes an action at the provider. What it does not change: the exposure is
  still ongoing *read* access, still narrower than the plaintext ledger already on disk. So it widens *who
  must act to stop it*, not *what a leak costs*.

  The rule this settles: **a provider may fail either clause independently, and the consequences differ.**
  Losing *read-only* enlarges the blast radius and reopens the custody design (the Teller-payments /
  `auth` case above, and [`ofx-direct-connect.md`](ofx-direct-connect.md), which fails **both**). Losing
  *revocable in-app* leaves the blast radius intact and becomes a **disclosure** obligation — the
  disconnect confirmation must say what it does and does not do, since a user who believes access ended
  when it did not is worse off than one who knows to go and revoke it. Adapters declare this
  (`revokes_on_disconnect`) rather than the UI assuming it.

  **The reverse direction also needs handling, and it is not symmetric (2026-08-08).** If the user *does*
  revoke at the provider, nothing announces it — Luma finds out only when a request is refused. So a refused
  credential raises `ProviderCredentialRejected` and sets `connection.reauth_required`, which the card
  reports as **reconnect needed** rather than as another failed sync. This matters more for a provider with
  no revocation call than for one with it: for Plaid, revocation normally happens *through* Luma and the
  connection is gone; for SimpleFIN, the revocation happens elsewhere and this refusal is the only notice
  there will ever be. A connection left counting failures after a deliberate revocation reads as broken
  rather than as closed, which is precisely the confusion the disclosure rule above exists to prevent.

- **A provider's own conformance checklist is part of its threat model, and gets read before the adapter is
  written (2026-08-08).** SimpleFIN publishes one, and it was consulted *after* its adapter shipped. Six of
  its nine items were already satisfied — but those were the ones the protocol forces on any working client.
  The three that were not are exactly the ones reasoning-from-the-protocol does not reach, because they are
  about the **user's** security posture rather than about making a correct request:
  a failed claim must be reported as a possible **interception** (a setup token is single-use; a claim that
  fails may mean someone else spent it, and only the user can disable it at the Bridge — the adapter's
  earlier "generate a new one" was the reassuring reading of identical evidence); a 403 on a data call is a
  condition of its own, not an outage; and displayed provider text must be bounded (escaping covers
  injection, so the live risk is volume). Generalized: **when a provider publishes conformance guidance,
  read it before writing the adapter — a checklist is a list of what the protocol's authors know goes wrong,
  and the security-posture items are the ones no amount of careful protocol reading substitutes for.**
- **Consequences & responsibilities (what a user must actually protect, and what a compromise means).**
  Because the ledger is plaintext at rest, an attacker who copies the **database files or an unencrypted
  backup** already has the full transaction history *without breaking anything* — so the user's real
  responsibility is guarding those files: don't scatter copies, and use the **encrypted backup** for
  anything that leaves the machine. The **app password** protects *network* access to the running app, not
  the files on disk. The **vault passphrase** protects only the provider token, and only against **future**
  pulls after a file theft — so if the DB leaks, the historical exposure is already done and the right
  action is to **revoke the connection** and, for a hostile exposure, rotate the vault. Where the provider
  supports it, Luma's **Disconnect** is that revocation; where it does not (SimpleFIN), disconnecting only
  removes the local copy and the revocation has to be done **at the provider** — the disconnect
  confirmation says which of the two it is. Losing the vault passphrase itself costs nothing but the
  connections (re-link). This is the plain-language content the README "Security" section (below) must
  convey.

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
3. ~~**Keep the two tables under the hood.**~~ **SUPERSEDED — see "Unified identity model" below.** The
   original call kept `local_preference_profile` and `user_account` as separate tables (collapsing them
   "a deep refactor for no user-visible gain"). That rationale turned out to be wrong: the gain is a
   *coherent single "user" concept* and a **trivial disable** (the two-table split is the only reason
   turning sign-in protection back off looked like a lossy reverse-migration). The settled direction is
   now to **unify to one `user_account` table** where the workspace flag toggles only *whether the
   password is checked*.

The Plaid vault stays **orthogonal**: a fully passwordless (perimeter-off) install can still have
vault-encrypted tokens, because the vault secret is per-user and independent of the app perimeter.

## Unified identity model (settled — supersedes "keep the two tables")

**Decision (2026-07-31):** there is **one identity concept — a user** — in a single `user_account`
table. The "Enable sign-in protection" flag decides *only whether the login password is verified*; it no
longer switches which table identities come from. This reverses point 3 above. The earlier "no
user-visible gain" reasoning missed two gains that matter: identities stop changing shape when auth is
toggled, and **disabling** sign-in protection becomes a flag flip instead of a lossy reverse-migration.

**How each operation behaves under one table:**

- **Perimeter off:** the login screen shows a **username chooser** (or the browser remembers who you
  are), *no password field* — pick your identity and you're in. This is exactly what local mode does
  today, just pointed at `user_account` rows instead of `local_preference_profile`. 2FA is skipped while
  off.
- **Perimeter on:** username + password (+ 2FA), as now.
- **Enable** = set the flag on; any user with no password is marked **`must_change_password`** (the claim
  flow already built in phase 2b) so they set one at next login. There is **no profile→account
  conversion** — users are already users.
- **Disable** = set the flag off. Users stay users; password hashes simply stop being consulted (they can
  sit unused so re-enabling is seamless), 2FA is skipped. **No migration, no credential loss, no
  re-keying.** Admin-gated, with a clear confirmation (it reopens network access and drops the perimeter).
- **Preferences** are always keyed by `user_id` — the profile-id vs user-id re-keying disappears
  entirely.
- The **`auth_required()` latch** (`user_count() > 1` forcing auth on) is **dropped**: multiple
  *passwordless* users become ordinary (many rows, flag off), which the current latch wrongly forbids.
  The flag alone governs the perimeter.

**What it touches / supersedes.** This reworks the middleware's local-vs-session branch (`main.py`),
`auth_required()` + the latch, the local-profile endpoints and the `App.jsx` chooser (retargeted to
users), and preference-scope keying. It **supersedes part of phase 2b**: `migrate_profiles_to_accounts`
(a profile→account converter) is replaced by a **one-time** "existing `local_preference_profile` rows
become `user_account` rows" unification, after which *enable* is trivial. The account model, the
`must_change_password`/unset-password **sentinel/claim** primitive, and the forced-change login flow all
carry over unchanged. Can be **staged**: first let auth-off mode authenticate against `user_account`
(no password) so disable works and nothing is lost, then retire `local_preference_profile` once nothing
reads it.

**Built (phase 2c, 2026-07-31).** One `user_account` table; `local_preference_profile` retired via a
one-time `_unify_local_profiles_into_users()` at startup (folds legacy rows into users, re-keys
`ui_preference`, drops the table). Identity is carried by the session in **both** modes — the middleware
reads a single `session['user_id']`; a perimeter-off session is stamped `pwless` and invalidated the
moment sign-in is enabled. Enable is `enable_auth_with_admin` (claim an admin, force the rest to
`must_change_password`); disable is `disable_auth_mode()` (a flag flip that preserves accounts/hashes).
The `auth_required()` `user_count() > 1` latch is gone. `migrate_profiles_to_accounts` is replaced.

## The Plaid credential model (so the two secrets don't get conflated)

Every aggregator has **two levels** of secret; only the *shapes* differ per provider:

1. **App-level credential** — identifies the *Luma app* to the provider; app-wide (same for every user
   and bank). Shapes differ: Plaid = `client_id` + `secret`; Teller = an **mTLS client cert + private
   key**; SimpleFIN = a setup token → **access URL**; GoCardless = `secret_id`/`secret_key`.
   **Correction (settled):** Plaid's free BYOK tier has **no approval gate** — any hobbyist signs up and
   can link a small number of live accounts (≈10) for free; production is a paid scale-up, not a
   permission wall. So Plaid is a fine *first* provider to actually test (see sequencing below).
2. **Per-connection credential** — one **per linked bank connection**, stored in the data DB. For Plaid
   it's the `access_token`; `access_token + client_id + secret` = pull that bank's transaction history +
   balances (read-only). **The most sensitive stored secret** — worth real at-rest protection because it's
   *live and revocable* — though see the tempered "Threat model" framing above: it's ongoing read access to
   financial data, not payment access.

**Where app-level credentials live (reversed from an earlier draft):** they move **out of `.env` and
into the DB**, DEK-encrypted under the vault, exactly like the per-connection secrets (there is no
plaintext path — see custody below). The earlier "keep them in env, they're lower
sensitivity" call is dropped: the only things you *do* with the app credential are connect and sync, and
both already require the vault unlocked (the per-connection token is under the DEK too), so "vaulting
makes it dead until unlock" costs nothing in practice — while env leaves a real secret sitting plaintext
on disk. This is **uniform across providers**: Plaid's `client_id`/`secret`, Teller's private key,
SimpleFIN's URL all live in the DB under the vault. `.env` may remain a bootstrap/override, but the DB is
the home. Admin-gated to *configure*; any vaulted user can *use*.

**The app secret is readable back, on request — the per-connection token is not.** The Configure dialog's
**Show** reveals the stored app secret (`GET /api/providers/{provider}/secret`, admin-gated, 423 while the
vault is locked). This is a deliberate exception to the otherwise write-only handling, and the asymmetry is
the point: an app credential is one the operator *owns and can already read on the provider's dashboard*,
and the only question the reveal answers — "does what Luma has match what the dashboard shows" — is a real
diagnostic that nothing else can settle. A per-connection `access_token` has no such counterpart: it is
live bank access with no dashboard to compare against and no reason a human would ever read it, so no
reveal exists for one and none should be added.

Three properties keep the exception narrow. It is a **separate call**, never a field on the status payload,
so plaintext can only appear in a response that explicitly asked for it. It **reuses `resolve_app_config`**,
the same decryption path a sync takes, so there is exactly one way a stored credential becomes plaintext.
And it takes **no second challenge when the vault is already unlocked** — an unlocked vault is this app's
authorization boundary and sync/disconnect/refresh all ride it, so re-prompting only here would add
friction without raising the bar. (A `.env`-sourced secret is returned without an unlock: nothing is
encrypted, and it is already readable by anyone who can read the file.)

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
  **Amended (2026-08-07): SimpleFIN went second, ahead of Teller.** The order above was a guess at
  difficulty; the useful ordering turned out to be *how differently a provider is shaped*. SimpleFIN
  differs from Plaid on every axis the seam had quietly assumed (Link-style connect, an app-level
  credential, a cursor API), so building it second forced those assumptions out into declared adapter
  capabilities while there were still only two providers to reconcile. Teller, which shares more of Plaid's
  shape, would have left them buried.
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

### Transport security: HTTP vs HTTPS is a per-topology decision (settled)

Server-side crypto has a direct transport consequence: **sensitive material crosses the wire.** The
unlock secret (vault passphrase, or the passkey PRF output posted from the browser), the app-login
password, and the invite secret on redemption all travel frontend→backend in the clear *at the
application layer* — so on any non-loopback link they must be protected by **TLS**. This is not
optional theater: a leaked vault-unlock secret is the key that unwraps the DEK and decrypts live bank
tokens (the doc's "leaked token ≫ leaked ledger").

**TLS is a property of the deployment topology, not a mode the app toggles.** The app always speaks
plain HTTP; whether that HTTP is *wrapped* is decided at the edge:

- **Desktop / loopback (`local_private`):** no wire leaves the machine → plain HTTP on `127.0.0.1`;
  TLS is pure friction (self-signed warnings, cert management) for zero gain.
- **Client-server / LAN server (`network_private`):** a reverse proxy (Caddy) terminates TLS and
  proxies to uvicorn over loopback. "The deployment is HTTPS" and "the app is HTTP" are both true.

**Why browser-side crypto is *not* an escape hatch from TLS here (settled).** It is tempting to think
"do the crypto in the browser and HTTP is fine." It is not, for two independent reasons:

1. **The backend is Plaid's API client.** Syncing requires an authenticated call to Plaid using the app
   `secret` + the plaintext `access_token`, and it must be the backend (Plaid isn't browser-callable —
   no CORS, and the app secret can't ship to browsers; there is no "blind relay" because the backend
   must hold the plaintext to make the TLS call *to Plaid*). So wherever the DEK is unwrapped, the
   backend must obtain the plaintext token/DEK at sync — cleartext key material on the wire regardless.
   Any scheme that protects it while still letting the backend call Plaid ends up **reinventing a secure
   channel = TLS.**
2. **The ledger itself crosses the wire in every API response.** Browser-side *token* crypto doesn't
   touch that; only pervasive end-to-end (browser-side field) ledger encryption would, which is an
   enormous lift and explicitly out of scope.

**The permissible-HTTP rule (settled).** Plain HTTP on a non-loopback bind is an acceptable *operator*
choice **only when both** hold: (1) **no aggregator/vault is configured** (no live bank secret ever on
the wire), **and** (2) the instance is **passwordless / perimeter-off** (no login credential or session
cookie to steal). The coupling is the point: the reason to run a password perimeter is distrust of who
can reach the box — and that same distrust makes a sniffable, replayable **session cookie** unacceptable
(the cookie is a bearer token on *every* authenticated request, so protecting only the login exchange
protects nothing). **Client-side password hashing does not rescue this** — a client-computed hash *is* a
replayable password-equivalent (pass-the-hash), and even a real PAKE (SRP/OPAQUE — decidedly not "easy")
still leaves the session cookie exposed. So HTTP is coherent only where there is *no perimeter to
defeat*; enabling sign-in protection or connecting an aggregator implies HTTPS.

Both gating conditions — `auth_required()` and "is a connection configured" — are known at runtime, so
this is **enforceable/warnable**, consistent with the profile's recommend-don't-force philosophy: default
the cookie's `Secure`/`SameSite` off (safe for the loopback default), and hard-warn when someone turns on
sign-in protection or connects an aggregator on a non-loopback bind ("credentials/bank secrets will cross
the network in cleartext — configure HTTPS"). A single explicit `SESSION_COOKIE_SECURE` env (set by the
Caddy/systemd install, left false by the desktop launcher) drives the cookie flag — **not** derived from
the security profile (a recommendation, not a transport guarantee: deriving `Secure` from it would lock
users out when a network-profile install runs plain HTTP) and **not** hardcoded (breaks one topology).
Behind Caddy, run uvicorn with `--proxy-headers` so `request.url.scheme` reflects the external scheme.

### What the two development servers bind to (settled 2026-08-20)

The dev backend and the dev frontend bind differently, and the reasons are not the same one. Recorded
because the backend's wide bind looks like an oversight and is not — a future reader "fixing" it would
remove the only way the networked half of the model gets exercised.

**The backend keeps `--host 0.0.0.0` in the launch scripts.** LAN reachability is a supported
deployment, not an accident: `network_private` is half the deployment model, and topology is a *detected
per-request fact* rather than a stored mode, so the same install has to be able to answer as loopback
from its own box and as networked from another. A socket pinned to loopback would make that case
unreachable and untestable. The exposure it creates is precisely the one the permissible-HTTP rule
governs and `transport.py` warns about at runtime, which is the layer where it belongs.

**The frontend dev server binds loopback by default** (`FRONTEND_HOST`, default `localhost`), where it
used to bind every interface from three places at once — `vite.config.js`, the `--host` flag in the
`dev` script, and another `--host` in `start_frontend.sh`. Nothing in this model asked for that. The
reason to narrow it is not Luma's perimeter at all: **GHSA-67mh-4wv8-2f99** is a flaw in esbuild that
lets any website the developer visits send requests to the Vite dev server and read the responses. That
is a third-party toolchain hole on the developer's machine, outside what this document reasons about,
and it is not fixable short of a major Vite upgrade — so the bind is the thing to narrow. Testing from a
phone stays available as `FRONTEND_HOST=0.0.0.0`, one env value rather than an edit.

`localhost` and not `127.0.0.1` is deliberate in both the dev default and the packaged launcher: the
browser's origin becomes the WebAuthn Relying Party id, an RP id must be a domain, and the numeric form
silently disables every passkey vault slot. See
[`deployment-topologies.md`](deployment-topologies.md) for the same constraint in the packaged build.


### Topology is detected, not a chosen profile (refinement, 2026-07-31)

Separate **detected facts** from **declared intent**; only the latter is a real question to put to the
user. Standalone-vs-client-server is a *detected fact*, so it shouldn't be a stored preset the user
picks at all:

- **Standalone vs client-server is detected — per request.** It is just *"did this request arrive over
  loopback or over the network?"* — the same `request.url` (scheme/host, via `--proxy-headers`) the HTTPS
  gate already reads in phase 3. The **packaged single-user build** (frontend+backend shell we ship) is
  simply the case where *every* request is loopback; it can self-declare via an env flag the launcher
  sets (see [`deployment-topologies.md`](deployment-topologies.md)), but that flag mainly drives defaults
  like `SESSION_COOKIE_SECURE=false` and suppressing network nags — the security-relevant signal is the
  per-request loopback/network fact, which is *more* correct than a static stored profile (the same
  install is loopback from its own box and networked from another).
- **The one genuine user choice is forward-looking: "will you connect a data source?"** That is what turns
  HTTPS from unnecessary (loopback / no live secret) into *required* (a bank/vault secret crossing a
  network link). It must be **asked and persisted ahead of time** (`data_provider_intended`) because
  standing up HTTPS isn't instantaneous — you can't first discover the requirement at connect-time. It
  only *matters* when networked (loopback + no provider needs nothing), so it's the only setting worth
  surfacing, and only in the client-server case.
- **It is not the only HTTPS trigger.** Enabling **sign-in protection** also puts a credential/session
  cookie on the wire, which the permissible-HTTP rule also requires HTTPS to protect on a network bind.
  So the runtime expectation stays *network link ∧ (perimeter on ∨ data source configured) ⇒ HTTPS* — the
  data-source declaration is the forward-looking half; enabling sign-in is the other trigger, surfaced
  when the user does it.
- **Consequence — `security_profile` is demoted.** The stored Standalone/Client-server preset stops being
  a user choice; what survives is (a) detected topology and (b) the one persisted `data_provider_intended`
  bit. The "Intended usage" UI collapses from three radios to a single "connecting a data source?"
  question, shown when networked — which is also the *only* topology-related thing worth putting on the
  first-run welcome screen (standalone has nothing to choose; sign-in stays a later conditional nudge).
- **Sequencing.** This depends on phase-3 per-request detection (`--proxy-headers` + scheme/host reading)
  and the packaging flag from `deployment-topologies.md`; until those land, the stored `security_profile`
  is the stopgap and the three-radio UI stays. So this is a decided *direction*, implemented with phase 3.

**Detecting "HTTPS is running" and the non-blocking setup flow (settled).** Because the backend always
speaks HTTP (Caddy terminates TLS), "is HTTPS running" is really *"did this request arrive over
HTTPS?"* — read from `request.url.scheme`, which reflects `X-Forwarded-Proto` once uvicorn runs with
`--proxy-headers` behind Caddy (it trusts your own proxy — acceptable in the trusted-server/LAN model).
Setting up HTTPS is not instantaneous (install Caddy, configure, restart the backend), so the first
connection attempt must **not** block on it out of nowhere. Instead:

- **A "data provider intended" declaration lives on the "Intended usage" section**, *not* on the
  Connections tab (that's too late). It is persisted as a `data_provider_intended` app-setting
  (`POST /auth/data-provider-intent`, surfaced in `/auth/status`), kept **orthogonal** to the deployment
  `security_profile` under the hood. In the UI the two are **projected onto three radios** — Standalone /
  Client-server / **Client-server with a data provider** — because the flag only *matters* for
  client-server (it flips HTTPS from recommended to required and drives the task/gate below), while
  standalone absorbs the "provider optional" case (a provider works over loopback with just a vault
  passphrase, so no declaration is needed there). Picking the third radio sets the flag and surfaces the
  HTTPS setup guidance early so the user can prepare ahead of time. **Built (guidance only) with the
  phase-2 card cleanup;** the *task* and *connect gate* that also read this flag come later (below).
  **Refined (see "Topology is detected, not a chosen profile"): with phase-3 detection this three-radio
  projection collapses to a single "connecting a data source?" question shown only when networked** —
  the Standalone/Client-server halves become detected, not chosen. The `data_provider_intended` mechanism
  itself (persisted, forward-looking, drives the early task/gate) is unchanged; only its UI shrinks.
- **The "Set up HTTPS" reminder rides the existing computed-task model** (`tasks.py` — tasks are live
  conditions, not stored/dismissible rows). Condition: *client-server mode ∧ `data_provider_intended` ∧
  request scheme ≠ https* → emit a task whose `link` points at the setup instructions. It **self-clears**
  the moment a request arrives over HTTPS — no dismiss state. The task is also where the user re-reads
  the instructions later.
- **Recommended-vs-required split — the plain client-server warning is *dismissible* (phase 3 detail).**
  For **client-server *with* a data provider**, HTTPS is *required* and enforced at connect (the gate
  below) — not dismissible. But for **plain client-server** (no provider), HTTPS is only *recommended*
  (it protects the login password/cookie — the operator's call on their own network), so its
  "HTTPS not configured" nag must be **suppressible without configuring HTTPS**: a "Don't warn about
  configuring HTTPS" checkbox, either on the client-server option in "Intended usage" **or** on the task
  message itself (a persisted suppression flag, unlike the provider task's self-clearing condition).
  Only the *recommended* case is dismissible; the *required* (provider) case never is. The Intended-usage
  recommendation copy already states this recommended-vs-required difference.
- **The Connect-bank button (Connections tab, phase 6) gates on HTTPS *availability*, not on the
  declaration.** In client-server mode it is disabled until `request.url.scheme == https` (with a tooltip
  explaining why); in standalone mode it's gated only on the vault passphrase (loopback needs no TLS).
  So the declaration drives *preparation* (instructions + task), while real HTTPS availability drives
  *enforcement* (the gate). The two are deliberately decoupled.

This spans phases: the `data_provider_intended` radio + inline HTTPS guidance shipped with the phase-2
card cleanup; `--proxy-headers` + scheme detection + `SESSION_COOKIE_SECURE` + the computed HTTPS task
land with **phase 3** (transport); the Connect-button gate (on HTTPS *availability*, not the declaration)
lands with **phase 6** (connections).

Deployment packaging (LAN-server vs single-user desktop shell) is tracked separately in
[`deployment-topologies.md`](deployment-topologies.md); this section is only the transport-security
policy that the vault phase must honor.

### A slot holds a keypair, not the DEK (settled 2026-08-13, supersedes direct wrapping)

The original design wrapped the DEK *directly* under each slot's KEK. That works for unlocking and for
nothing else, because a wrap made from someone's own secret can only ever be made **by** them. Two
consequences, one of which was recorded as a design and one as a plan:

- **Rotation as written was not implementable.** "Generate DEK′, re-encrypt all tokens under it, re-wrap
  DEK′ for every *remaining* slot" (see "Provisioning a new user") requires each remaining user's
  passphrase, which the rotating user does not have. Direct wrapping could only ever have **destroyed**
  every other slot and forced everyone to re-enroll.
- **The whole invite ceremony existed to work around it.** If access cannot be handed over
  cryptographically, a *secret* has to travel between two people instead — hence a 128-bit bearer code,
  an expiry, single-use, and a revoke path, all of it machinery to limit the damage of a secret in
  transit.

Both dissolve if the slot owns an **X25519 keypair**: `public_key` in the clear, `wrapped_private_key`
sealed under the KEK, and `sealed_dek` the DEK sealed *to that public key*. Anyone holding the DEK can
then seal it for anyone else from their public key alone. Enrollment becomes **enrol → approve** (the
joiner writes a slot with no `sealed_dek`; any member with the vault open seals the DEK to it), and
rotation re-seals for every remaining slot. Nothing secret moves between people at any point, so there is
no bearer code to intercept, expire, or revoke.

Cost: a second slot format. Legacy directly-wrapped slots (**format 1**) keep unlocking and convert in
place at the next unlock — the one moment both the KEK and the DEK exist in the process. The credentials
backup carries whichever format wrote it (payload **v4**; v3 and earlier still restore).

**"Co-present" and "invite" stop being two mechanisms.** They were two answers to "how does the secret
get there", and the secret no longer travels. What remains is one flow used at two tempos: standing over
the same machine, or approving later from anywhere.

### Unlock methods (key slots)

The vault secret is **separate from the login password** — a deliberate, settled decision. A slot's KEK
can come from either source:

- **Passphrase slot** — KEK = `scrypt(passphrase)`.
- **Passkey slot (WebAuthn PRF)** — KEK = `HKDF(PRF(salt))` from the passkey. NOTE: a *plain* passkey is
  auth-only and yields no stable key material; the **`prf` extension** (CTAP2 `hmac-secret`) is what
  returns a stable, secret, high-entropy value usable as a KEK. Must be enabled at *registration*, and
  the PRF output is only available during a live `get()` ceremony. No stretching — the output is already
  32 uniform bytes from the authenticator, so there is nothing weak to harden.

  The doc previously flagged a **"passkey twist"**: that a PRF KEK exists only during the enrollee's own
  live ceremony, so a co-present grant had to happen inside their session. Keypair slots remove it — a
  grant needs only the public key the registration already wrote, and can happen days later with nobody
  present. Passkey enrollment is therefore no different from passphrase enrollment.

**Several passkeys per user, one passphrase.** A person with a laptop and a phone registers both; the
partial unique index on `vault_slot` enforces the passphrase's singularity and permits the rest. Removing
the *last* method that opens the vault is refused, because there is no recovery behind it.

**Two preconditions belong to the browser, not the app, and are reported rather than hit.** WebAuthn needs
a **secure context**, and an RP id must be a **domain** — so a LAN server reached as `192.168.x.x` can
never host passkeys however it is served, and no amount of TLS changes that. Both are detected server-side
and returned as stated reasons, since the answer to each is "use a passphrase on this connection" and a
raw browser exception would never say so.

**No WebAuthn assertion is verified, deliberately.** The vault is not an authentication decision — the app
login is a separate perimeter. A PRF output that is wrong fails to open `wrapped_private_key` at the AEAD
tag, exactly as a wrong passphrase does, so the slot is self-verifying. Checking a signature on top would
mean storing credential public keys and running challenge state to prove what is already proven, and would
add a WebAuthn library to do it.

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

**"No escrow" is not "no exit."** This settles that the *keys* are unrecoverable, which is deliberate; it
does not settle what the app does when someone reaches that state. As built there is no way out at all —
unlocking needs the passphrase and replacing it needs the vault already unlocked — so a forgotten
passphrase leaves the vault permanently shut with nothing on screen to say so, and "re-link" is advice the
UI offers no way to act on. The reset path that turns this decision into something a user can actually
perform is [vault-passphrase-recovery.md](vault-passphrase-recovery.md).

### The vault is the only custody path — no `off`, no `server_managed` (settled)

`server_managed` privacy mode is **retired** (it let the server decrypt at rest, so it never delivered
"leaked DB ≠ leaked tokens"). And there is **no `off`/plaintext mode either** — a live token is never
stored in the clear. There's no legitimate need for one: **Production** plaintext is unacceptable (real,
ongoing bank access on disk), and **Sandbox** plaintext is harmless but pointless when a throwaway
passphrase costs nothing. Dropping `off` also removes the footgun where an install flips sandbox→
production while custody is off and silently leaks real tokens. Retire the `APP_MASTER_KEY` →
`SESSION_SECRET` fallback along with all this.

**Passphrase strength is unconditional — there is no weak tier and no test-mode exemption.** Every vault
passphrase must meet the minimum before *any* data connection can be configured, whatever the provider and
whatever environment it points at. (This is the *vault passphrase's* own minimum; separate from the
app-login password policy — `none`/`min_8`/`strong` — which governs the orthogonal network perimeter.)

This **strengthens** the settled decision above rather than qualifying it. The original design keyed
strength to provider mode: Sandbox accepted any passphrase, and switching a provider to Production was the
gate that demanded a real one. The reasoning was that a throwaway passphrase costs nothing when the
credentials are fake — but that premise dissolves once the passphrase lives in a password manager, where
entering a long one costs the same as a short one. Two things argued for removing the tier outright.

A conditional floor has to be **right at every gate that guards it, and stay right as providers are
added** — the connect path, the environment switch, and each adapter's judgment about whether its own
credentials are live. An unconditional floor cannot be got wrong, and it deletes the adapter capability
(`connect_requires_production_vault`) that existed only to answer that question.

And the tier's removal is what makes the model *say* something simple. "A strong passphrase protects your
data-source credentials" is a rule a user can hold; "your passphrase requirements depend on which
environment your provider is pointed at" is one they cannot, and it invited the exact confusion where
Sandbox credentials feel like a rehearsal for the real thing.

A **relaxed passphrase for test/sandbox use was considered and rejected** on the same grounds — see the
briefly-planned Plaid-sandbox-without-a-vault exemption, which would have introduced a plaintext
credential path and an encrypt-on-first-vault sweep to make it safe. Neither is needed once nothing weak
can exist: no plaintext credentials are written, so there is nothing for a sweep to find, and the
sandbox→production flip needs no special handling because a vault is required either way.

**Consequence:** connecting a live data source **always** requires setting a vault passphrase — even on a
passwordless-app (perimeter-off) install. That's correct: app-login and the vault are orthogonal, and
"store real bank tokens with zero secrets" is exactly what must be impossible.

## Provisioning a new user

Granting the DEK to user B needs B's **public key** and nothing else — no secret from B, and no secret
carried to them. B enrols by choosing an unlock method (which writes their keypair and leaves
`sealed_dek` empty), and any member holding the DEK approves it. The two acts are independent in time and
place, so what used to be two mechanisms is one:

- **Co-present** — B enrols at the machine and the member approves immediately. A tempo, not a mode.
- **Not co-present** — B enrols whenever; the member approves whenever. No code changes hands, so there
  is nothing to expire or intercept.

The **order is inverted** from the old invite design: B acts first and the member approves, rather than
the member minting something B redeems. That direction is what removes the bearer secret — a grant
addressed to an already-published public key has no window in which a third party could claim it, which
the invite's own "whoever holds `S` first can claim the slot" caveat had to accept.

An admin can still create B's *app account* without any of this (that needs admin and no DEK); it is the
vault grant that needs an unlocked member. The two stay separable, as they always were.

Removing a user = drop their slot. If the departure is **untrusted**, that isn't enough (they may have
seen the DEK while unlocked): **rotate** — generate DEK′, re-encrypt every stored credential under it, and
re-seal DEK′ for the slots that remain. Their old slot and any retained DEK copy are then dead for new
ciphertext. Rotation can't undo *past* access, so a genuinely hostile departure also implies **re-linking**
the affected banks. Revoke *then* rotate: rotation re-seals for whatever slots are present when it runs.

### Rotation crosses two databases, so it runs in three phases

Slots live in the control DB and the ciphertext in the data DB, and no transaction spans both. A failure
between the two writes would otherwise leave every credential sealed under a key no slot can produce —
the total loss the whole design exists to avoid. So the new key is sealed into every slot **first**, with
the outgoing key retained in `sealed_dek_prev`; then the ciphertext is rewritten; then the previous seals
are cleared. An interruption at any point leaves every row readable under one of the two keys.

An interrupted rotation is **resumed, not restarted** — starting a fresh one would push the key the
ciphertext is actually under off the end of the two a slot can hold, converting a recoverable state into
the unrecoverable one. Retaining the old key briefly does not weaken the rotation: it is sealed only to
the slots that survive, and a revoked slot was deleted before any of it ran.

### ~~Invite ceremony~~ — retired before it was built (2026-08-13)

The specified ceremony (128-bit `S` rendered as a Crockford-base32 code or a URL-fragment link, an
`HKDF`-derived throwaway slot in a `pending_invite` table, 48–72h expiry, single-use, revocable, the AEAD
tag as verifier, delivered by the human rather than by email) was a well-formed answer to a question that
keypair slots stop asking. Recorded here because the reasoning is worth not repeating: **every part of it
was machinery for limiting the damage of a secret in transit**, and there is now no secret in transit.
Expiry, single-use, revocation and the "bearer token until redeemed" caveat all existed only to bound
that window.

If a future provider or deployment ever reintroduces a case where access genuinely must be handed over
out of band, this is the design to return to — but it should not be rebuilt merely to have an "invite"
affordance, because approve-a-request covers the same journeys with strictly fewer moving parts.

## Where things live / why no DB-file encryption

- Credential **ciphertext** → data DB (`connection.credential_enc`, `provider_config.secret_enc`), so it
  travels with data backups.
- **Slot material** (public key, KEK-wrapped private key, the sealed DEK, KDF salt/params) → control DB
  (`vault_slot`).
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
= perimeter, admin gates settings not data; **topology is *detected* not a chosen profile** — Standalone
vs client-server falls out of per-request loopback/network, the only real user choice is the
forward-looking "connecting a data source?" declaration, and `security_profile` is demoted to a
pre-detection stopgap — see "Topology is detected, not a chosen profile"); trusted-server / server-side crypto (browser-side only if we
ever want an untrusted host); retire `server_managed`, the master-key fallback, **and any `off`/plaintext
token path** — the vault is the *only* custody, with an **unconditional** passphrase floor (the
sandbox-lax/Production-enforced tier was removed — see "Passphrase strength is unconditional"); no
required fallback slot / no recovery escrow (loss of the *last* slot = re-link, though another member's
slot is now a real way back — see [vault-passphrase-recovery.md](vault-passphrase-recovery.md)); passkeys
are vault-only, never app login; **identity & perimeter** — password optionality is an all-or-nothing *workspace* toggle
(the existing two modes), per-user auth when on; **unify to one `user_account` table** (the flag toggles
only password verification — reverses the earlier "keep two tables" call; makes disable a flag flip);
**enrollment by keypair slot** — a slot owns an X25519 keypair rather than wrapping the DEK, so access is
granted from a public key alone: enrol → approve, no bearer secret, no expiry, and a rotation that
preserves every remaining member (the invite ceremony this replaced is recorded, retired, under
"Provisioning a new user"); account-creation stays separable from vault-grant; revoke-then-rotate on an
untrusted departure; **provider-agnostic connections** — a
`connection` table with a `provider` discriminator + opaque encrypted credential blob and an adapter
interface, Plaid first then Teller then SimpleFIN, app-level credentials moved from `.env` into the DB
under the vault, per-provider **data-source cards** on the Accounts → Connections tab (provider config
moves there out of Settings; "+ Add data source" → configure / connect / sync / last-fetch per card).
Plaid BYOK has **no approval gate** (free tier ≈10 accounts) — the earlier "sandbox-only until approved"
premise was wrong.

## Build phases (rough, when unblocked)

1. **[DONE] Drop the multi-tenant pretense** — removed the `multi_tenant` profile; the single-workspace
   / perimeter model is documented in `architecture.md` → "Identity, access & deployment model".
2. **[DONE] Rebuild the three Settings forms** (per [`pre-auth-security-ui.md`](pre-auth-security-ui.md)) —
   security profile / sign-in protection / password policy, now session-wired via setters exposed from
   `useAppSession()`.
2b. **[DONE] Unify the identity presentation** — "enable sign-in protection" **migrates** existing local
   profiles into `user_account`s via `migrate_profiles_to_accounts`: the operator claims one profile as
   admin, others may be left password-unset and are forced to set one at next login
   (`must_change_password` + the unset-password sentinel; also the admin password-reset primitive).
   Preferences are re-keyed profile→user. The local-profile chooser already required a named identity
   (no anonymous default). *(The two tables are still live as of this build; see phase 2c.)*
2c. **[DONE]** **Unify to one `user_account` table** (see "Unified identity model") — retired
   `local_preference_profile` (one-time `_unify_local_profiles_into_users()` at startup); the sign-in flag
   toggles only password verification. Identity is session-carried in both modes (single `session['user_id']` + a `pwless` marker the middleware invalidates on enable). Disable is a flag flip (no reverse-migration);
   the `auth_required()` `user_count()>1` latch is dropped; `migrate_profiles_to_accounts` was replaced by
   `enable_auth_with_admin`. Supersedes the two-table parts of 2b.
3. **[DONE] Multi-wrap vault core** — workspace DEK, per-slot wrapped-DEK storage, passphrase-slot KDF path,
   session-scoped unlock caching, rework `crypto_service` from per-user DEK to one shared DEK + slots.
   **Retire `server_managed`, the `APP_MASTER_KEY`→`SESSION_SECRET` fallback, and the `off`/plaintext
   path** — the vault is the only custody; enforce a vault-passphrase minimum when a provider is set to
   Production (sandbox stays lax). **Transport-security policy**: because vault-unlock secrets now cross
   the wire, add the `SESSION_COOKIE_SECURE` env with `--proxy-headers` handling and the runtime
   warn-when-cleartext gate.

   **Built (phase 3, 2026-08-01).** New `vault_slot` control-DB table (per-(user, method) wrapped DEK +
   scrypt KDF params + a `meets_production_min` flag); `user_secret_material` and its `privacy_mode`/
   `server_managed`/`wrapped_user_key` columns dropped. `crypto_service` rewritten to one workspace DEK
   generated by the first passphrase slot, wrapped per slot under `KEK = scrypt(passphrase)` (AES-GCM;
   the AEAD tag is the passphrase verifier — cryptography 43 has no Argon2id, and the design permits
   scrypt). **The unlocked DEK lives in a server-side, in-process cache keyed by `user_id` with an idle
   TTL — never in the signed session cookie** (which serializes to the browser); dropped on logout and
   restart. `APP_MASTER_KEY` retired everywhere (`runtime_config`, `start_backend.sh`, `.env_example`).
   Endpoints `POST /auth/vault/{set-passphrase,change-passphrase,unlock,lock}`; `/auth/privacy-mode`
   removed; `/auth/status` + the session payload carry `vault_configured`/`vault_has_passphrase`/
   `vault_unlocked`. Plaid connect/sync and credential export/restore require an unlocked vault
   (`423 Locked`; connect on an unconfigured vault → `409`). Production gate: flipping `PLAID_ENV=production`
   requires every slot to meet the vault minimum (≥12 chars) — an all-slots property (the DEK is only as
   strong as its weakest wrap). Old `server_managed` ciphertext is unrecoverable by design (AEAD fails →
   re-link). **Transport:** `SESSION_COOKIE_SECURE`→`https_only` on the session cookie; `--proxy-headers`
   in the launch scripts; per-request loopback/scheme detection in `backend/transport.py`; a computed
   "Set up HTTPS" task (`tasks.py`) — *required*/non-dismissible when a provider is intended, *recommended*/
   suppressible (persisted `https_warning_suppressed`) for plain client-server — self-clearing over HTTPS;
   `/auth/status` gains a `transport` block; connecting a provider returns a `transport_warning` on a
   cleartext network bind. **Not** built here (deferred per scope): the passphrase/unlock **UI** (rode the
   phase-6 connection cards), the three-radio→single-question topology **UI collapse** (still outstanding;
   the detection primitive it needs exists), and **enrollment** — so as of phase 3 only the first user, or
   a user re-setting their own, could set a passphrase. Phase 5 lifted that.
4. **[DONE 2026-08-13]** **Passkey (PRF) slot.** Registration with the `prf` extension, the unlock
   ceremony, several passkeys per user (a labelled slot list; the partial unique index keeps the
   passphrase singular), and the "your authenticator lacks PRF → use a passphrase" fallback — returned as
   a *reason* the UI turns into advice rather than thrown as an error, since the vault has a real
   fallback to offer. The PRF output is read from a follow-up `get()` rather than from `create()`, whose
   results are not reliable across browsers; trusting it would produce a slot nothing could ever open.
   No WebAuthn assertion is verified and no WebAuthn library is used — see "Unlock methods" for why that
   is a decision rather than an omission. The two hard preconditions (secure context, RP id must be a
   domain) are detected server-side (`_passkey_context`) and reported as stated reasons.

   **Two ceremony lessons, both found in first use (2026-08-13).** Registration originally asked only to
   *enable* PRF at `create()` and always evaluated the salt in a second `get()`, because `create()`
   results are not universally returned. Correct, but it made the ordinary case cost **two prompts**, and
   the second is indistinguishable from a repeat of the first — so dismissing it was the natural response
   to a registration that appeared finished, and nothing was saved. Asking for `eval` *at creation* costs
   nothing where unsupported (the field is ignored and the fallback still runs) and removes the prompt
   where it is not. And the dialog **swallowed a cancelled ceremony**, on the reasoning that declining is
   the user's own answer. That only holds when they know what they declined: the silent version left the
   surface untouched, which reads as "press it again". Generalized: **a multi-step ceremony must report
   every non-success outcome, including the ones the user appears to have chosen.**
5. **[DONE 2026-08-13]** **Enrollment, grant, revocation and rotation.** Built on keypair slots (see "A
   slot holds a keypair"), which replaced the invite ceremony rather than implementing it: setting a
   passphrase as a user the vault does not know enrols them (`vault_access_pending`), any member holding
   the DEK approves (`POST /auth/vault/access-requests/{slot}/approve`), admin revokes, and
   `POST /auth/vault/rotate` re-keys in the three phases above. `VaultSettingsDialog` is the UI home for
   all of it — unlock methods, **who holds access** (`GET /auth/vault/members`, grouped per person) with
   Remove access, the approval queue, and Replace vault key. The Connections strip gained the
   request/pending/passkey-unlock states, and the pending queue also surfaces as a computed task for
   members who can act on it.

   **The member list was missing from the first build while the rotate copy already referred to it** —
   "do this after removing someone's access", with nowhere to see who had access or to take it away. The
   endpoint existed; only the surface did not. The general shape, worth stating rather than treating as a
   one-off: *copy that names a capability is a claim the UI has to honour*, and the moment to check is
   when the copy is written, not when someone tries to follow it.

   **Also landed here:** slot **format 2** with a lazy format-1 conversion at unlock (carrying the
   `credentials_export` fingerprint history across, since the passphrase that opens those backups has not
   changed); the export fingerprint moving to the *private-key wrap*, which is what a passphrase change
   actually replaces; and credentials backup payload **v4** (v1–v3 still restore).
6. **Generalize to provider-agnostic connections** — `connection` table (`provider` + opaque encrypted
   credential blob) replacing `plaid_item`; a provider-adapter interface refactored out of
   `plaid_service`/sync; move app-level credentials from `.env` into the DB under vault custody; extend
   the Accounts → Connections tab. Ship **Plaid** as the first adapter; Teller, then SimpleFIN, follow.

6a. **[DONE]** **The backend connection/adapter seam (Plaid only, no behavior change).** New `connection`
   data-DB table (`id`, `provider`, `external_id`, `credential`/`credential_enc`, `institution`), the
   vault-encrypted credential store that **supersedes `plaid_item`**; a startup
   migration (v18) folds legacy `plaid_item` rows into `provider='plaid'` connections **carrying the
   ciphertext verbatim** (the Plaid AAD is keyed on `external_id == item_id`, so nothing re-keys — no
   unlock needed to migrate). A `backend/services/providers/` package (`get_adapter` over a
   `ProviderAdapter` ABC; `PlaidAdapter` delegates to the thin `plaid_service`) normalizes to
   provider-neutral dict keys; `routers/plaid.py` (link-token/exchange), `routers/sync.py`, and the
   **credentials** backup (`export/restore_credentials`, status count, payload v2 `connections` — legacy
   v1 `plaid_items` still restored) all route through the seam + `connection`. `crypto_service` generalized
   to `encrypt/decrypt_connection_credential` (Plaid AAD continuity). **Built (2026-08-01):** all backend +
   unit-tested (`test_connection_seam.py`; `test_vault.py`/`test_vault_endpoints.py`/`test_backup_restore.py`/
   `test_demo_data.py` updated). **No frontend; Plaid behaves identically; app creds still read from `.env`.**
   **Deliberately deferred to 6b** (nothing in 6a reads them): explicit `provider`/`connection_id` account
   columns and renaming the `plaid_account_id`/`plaid_item_id` column *names* (accounts link implicitly by
   `plaid_item_id == connection.external_id`); dropping the now-vestigial `plaid_item` table.
6b. **App creds into the vault + the Connections-tab UI.** Move Plaid `client_id`/`secret`/`env` out of
   `.env`/Settings into the vaulted DB (**no migration** — the Configure card just writes them going
   forward; re-entering once is acceptable — decided 2026-08-01, see
   [`optional-env-and-layered-config.md`](optional-env-and-layered-config.md)); per-provider data-source
   cards on the Accounts → Connections tab (Configure/Connect/Sync per card, config moves out of Settings);
   the Connect-bank HTTPS-availability gate; fix the deprecated "development mode" copy; and the explicit
   account connection columns/renames deferred from 6a. Teller, then SimpleFIN, follow on the seam.

6b-1. **[DONE]** **App-level provider credentials into the vault (backend).** New data-DB `provider_config`
   table (`provider` PK, `client_id`/`env` plaintext, `secret_enc` vault-encrypted under an
   `app_credential|<provider>|secret` AAD). `crypto_service.encrypt/decrypt_app_credential`; a
   `providers.config` service with `resolve_app_config` (a saved row wins, and — until the fallback was
   retired on 2026-08-18 — else the `.env` `PLAID_*`
   **bootstrap fallback**, so pre-6b installs keep working untouched) + `set_provider_config`/
   `get_provider_config_status` (secret is **write-only** — status never returns it). Every adapter method
   now takes the resolved `app_config` (no adapter reads `os.environ`); `plaid_service` builds its client
   from it. Admin-gated CRUD `GET/POST /api/providers` + `/api/providers/{provider}/config`
   (`routers/providers.py`); saving a secret needs the vault unlocked (`423`), and the **Production
   all-slots vault gate** rides the env change here too. `routers/plaid.py` (link-token/exchange) and
   `routers/sync.py` resolve `app_config` (→ `409 provider_not_configured` / `423`). App creds ride the
   **credentials backup** (`provider_configs`). **No `.env` → DB migration** (re-enter once). **Built
   (2026-08-01):** backend + unit-tested (`test_provider_config.py`; `test_connection_seam.py` updated).
   **Left for 6b-2:** the Configure/Connections-tab UI still lives on the Settings environment form; the
   legacy `/auth/environment` Plaid write (to `.env`) is untouched and remains a coherent fallback until
   the UI moves.
6b-2. **[DONE]** **The Connections-tab UI.** `DataSourceConnections` (in `pages/Accounts.jsx`) replaces the
   single "Data Source Connections" card with a **card per provider** (from `GET /api/providers`): mode
   badge, admin-only **Configure** (app-credential entry — `ProviderConfigDialog`, secret write-only),
   **Connect bank**, **Sync now**, linked accounts, and the "+ Add data source" affordance for
   unconfigured providers. It also introduces the **vault set-passphrase / unlock UI** (`VaultStrip` +
   `VaultPassphraseDialog`; phase 3 had deferred the vault UI to the connection cards) posting to
   `/auth/vault/*` and refreshing the session vault flags. **Connect** gates on vault configured+unlocked
   and — on a networked bind — real HTTPS (`transport.is_https`). Plaid credential entry is **removed from
   the Settings `EnvironmentSection`** (which keeps only its log-files toggle and now points to
   Connections); the `/auth/environment` endpoint + `runtime_config` drop their Plaid fields, and the
   Production gate now lives on `POST /api/providers/{provider}/config`. Deprecated "development mode in
   `.env`" copy fixed. **Built (2026-08-01):** frontend + backend-endpoint cleanup; lint + production build
   clean; backend suite green (`test_vault_endpoints` Production-gate test repointed to the providers
   endpoint). **Not browser-verified by the agent** (per repo rule — handed to the user).
6b-3. **[DONE]** **Deferred account columns.** Migration **v20** (in-place ALTERs, not a table rebuild, so
   the `account.id` every FK references is never dropped): rename `plaid_account_id → external_account_id`;
   replace the `plaid_item_id` string (item_id / `csv_import` / `manual`) with an explicit
   `connection_id` FK (→ `connection.id`, `ON DELETE SET NULL` — matches the disconnect flow, which drops
   the connection row but keeps accounts) plus a `provider` discriminator; drop the vestigial `plaid_item`
   table. Backfill relinks real item_ids to their connection and maps the sentinels to `csv`/`manual`
   providers with a NULL connection. Frontend groups accounts by `connection_id == connection.id` (the
   `csv_import`/`manual` sentinel special-casing is gone; `list_connections` now returns each connection's
   `id`). Backup payload bumped **7 → 8** (accounts dump the new columns); **v7 restore translates** the
   legacy columns before insert (`_reconcile_restored_account_links`, also nulls any locally-absent
   `connection_id`). **Built (2026-08-01):** backend + frontend; full backend suite green (added a v20
   migration test + a v7-restore-translation test); lint + production build clean. **Not browser-verified
   by the agent** (per repo rule — handed to the user). Teller, then SimpleFIN, follow on the seam.

**6b refinements — [DONE 2026-08-01].** Two follow-ons landed with the 6b UI, after the threat-model
discussion above:

- **Vault-strength tuning.** `VAULT_PRODUCTION_MIN_LEN` 12 → **20** plus a **distinct-character guard**
  (`VAULT_PRODUCTION_MIN_DISTINCT = 6`) in `passphrase_meets_production_min`, so a long-but-degenerate
  passphrase (one char repeated) can't clear the Production gate. Length is the main lever precisely
  because the passphrase is meant to live in a password manager (the passkey/biometric daily unlock is
  phase 4), so a long floor costs no typing. The frontend adds an **advisory strength meter** on the vault
  set dialog that *blocks nothing* — the only hard gate stays the backend Production check. **Decided
  against a "choose your security level" question:** with a sensible fixed floor there's nothing meaningful
  to dial, and it cuts against the "detect facts, one forward-looking question" direction.
- **Disconnect / revoke flow.** The adapter gained a `remove(app_config, credential)` op (Plaid
  `/item/remove`); `POST /api/providers/{provider}/disconnect` revokes **provider-side** (so a leaked
  token dies too) then drops the local `connection` row, keeping accounts/transactions. `GET /api/providers`
  now returns each provider's `connections`; the card renders per-connection groups with a **Disconnect**
  action (confirm dialog). This is the in-app version of "revoke on the provider's website" the threat
  model relies on. Not admin-gated (symmetric with connect/sync); needs the vault unlocked.

6c. **[DONE 2026-08-07]** **SimpleFIN as the second adapter — and the seam generalizations it paid for.**
   The 6a/6b seam was Plaid-shaped in three ways that were never universal, all of which became declared
   **adapter capabilities** rather than branches on provider name (`services/providers/base.py`):

   - **Connect is not always Link.** `connect(app_config, payload)` is now the one abstract authorization
     op, with `connect_spec` describing what the UI must collect (a Link widget, or a pasted token). The
     whole tail after it — vault gates, credential encryption, the `(provider, external_id)` upsert,
     account recording — is one shared `providers.establish_connection`; `/plaid/exchange` and the new
     generic `POST /api/providers/{provider}/connect` converge on its first line, so the two paths cannot
     drift on credential custody or account adoption.
   - **Not every provider has a cursor.** `ProviderAdapter.fetch_transactions_sync` now *defaults* to a
     range pull, so a change-feed-less provider needs no special case in the sync loop. Its return grew
     three fields that were previously conflated into one: `backfill_complete` (is the history fetched to
     its end?) separate from the poll-stop signal, `resume_later` (stop polling but the backfill is
     unfinished — pick it up on a later sync), and `account_coverage` (how far back the pull *actually*
     reached, **per account**, as against what it asked for). Collapsing the first two strands un-fetched
     history behind a short routine look-back; overstating the third makes duplicate detection reject
     genuine rows.

     **Refined (6c-1).** History state — depth reached, and whether an account has any older data —
     originally lived per *connection* in the adapter's resume token, with a bolted-on "catch-up"
     instruction to cover accounts added on the provider's side later. Those facts are per *account*, and
     storing them a level up produced all three of: a coverage over-claim (one figure written to every
     account), a shared catch-up frontier that could not express two accounts at different depths, and the
     catch-up mechanism itself. They now live on `connection_account` (`history_complete`,
     `history_empty_streak`, migration v28); `run_sync` builds `account_targets` from them and the adapter
     holds no history state at all. The catch-up, its scheduling hook, and the connection-level flags were
     deleted rather than refactored. See `docs/architecture.md` → "Provider connections".
   - **Not every provider has an app-level credential.** `requires_app_config = False` stops "nothing
     configured" reading as "setup unfinished": such a provider counts as configured once *connected*,
     shows no Configure action and no environment badge, and — having no sandbox — is gated on a
     Production-strength vault at **connect** time, since it has no later moment at which to ask.

   Also: `run_sync` gained explicit `full_history` and `provider` parameters. `full_history` separates the
   initial/deepening pull from a routine top-up, which sent identical arguments — benign for Plaid, whose
   maintained window really did span the claimed range, but on a range-pull provider it both re-walked all
   history every sync and backdated the coverage claim. `provider` scopes a sync so one card's "Sync now"
   cannot spend a metered provider's request budget.

   **The SimpleFIN adapter itself** (`services/providers/simplefin.py`, stdlib only) is where the protocol
   facts live: the claim/access-URL handshake, the date-range window cap, the sign inversion, `transacted_at`
   → `authorized_date`, and the two things with no Plaid analog — a **backward walk** that must *discover*
   where history ends (the protocol reports no coverage start, so it takes two consecutive empty windows to
   conclude it, since one is indistinguishable from a quiet quarter) and a **request budget** whose penalty
   for being exceeded is token disablement (so the walk meters itself and pauses rather than pushing on).
   Its resume checkpoint lives in `connection.transactions_cursor`, which was always defined as an opaque
   provider resume token — a provider with no change feed simply resumes from something that is not a cursor.

   **Also landed here:** `txn.plaid_transaction_id` → `external_transaction_id` (migration **v26**,
   following `plaid_account_id` → `external_account_id` in v20 — it has held any provider's id since 6a),
   with backup payload **8 → 9** and pre-v9 translation on restore.

## Docs to write (deferred to after phase 3/6)

- **README "Security" section — [DONE 2026-08-01].** Written: covers the ledger being **plaintext at
  rest** (protect the DB files / use the **encrypted backup**); the sign-in password as a **network
  perimeter**, not disk encryption; provider tokens being **read-only + revocable** and the only thing
  vault-encrypted; and the compromise playbook (**disconnect to revoke**, rotate the vault). Still
  **to add when the HTTPS install lands**: the Caddy/`SESSION_COOKIE_SECURE`/`--proxy-headers` setup steps
  for client-server. The in-app Help topics **`data-and-backups`** and **`account-security`** should be
  reconciled against the tempered read-only framing next time they're touched.

## Cross-refs

- [`backup-restore-scope-and-secrets.md`](backup-restore-scope-and-secrets.md) — **depends on phase 6.**
  The vault's data-DB-ciphertext / control-DB-keys split (phase 3) reshapes what a backup must contain; that
  doc specs the explicit-scope Backup page, the coupled "accounts & secrets" backup, and restore-time
  identity reconciliation.
- [`pre-auth-security-ui.md`](pre-auth-security-ui.md) — the deferred Settings-UI rebuild this unblocks.
- [`merchant-rename-fate.md`](merchant-rename-fate.md) — revisits "when Plaid sync is exercised"; same
  trigger.
- `import-input-formats.md` — lists SimpleFIN as a "Plaid-parallel connection/sync track"; this doc's
  provider-agnostic connection model is the seam that item plugs into.
- [`ofx-direct-connect.md`](ofx-direct-connect.md) — **the revisit trigger the threat model names.** An
  OFX Direct Connect credential is the institution's own login: not read-only (it grants full web
  banking) and not revocable in-app (no item-remove analog, so disconnect deletes a local copy only).
  Adopting a provider of that shape invalidates the "ongoing *read* access, revocable by disconnecting"
  conditioning above, so the Threat-model section must be reopened before one is built — not after.
  Parked on coverage, not on this; the constraint stands whenever it is picked up.
- Memory `plaid-deferred-until-approval` — **superseded/corrected here:** Plaid BYOK has no approval gate
  (free tier ≈10 accounts), so Plaid is the intended *first* connection provider to test, not a deferred
  one. (Memory updated to match.)
