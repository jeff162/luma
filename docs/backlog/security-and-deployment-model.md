# Security & deployment model

**Status: decided (2026-07-30). Phases 1–3 implemented (identity unified to one `user_account` table,
session-based identity in both modes, enable/disable as flag flips; and the multi-wrap vault core +
transport-security policy — workspace DEK, passphrase slots, server-side unlock cache, `server_managed`/
master-key retired, Production passphrase gate, `SESSION_COOKIE_SECURE`/`--proxy-headers`/computed HTTPS
task), phase 6a (the provider-agnostic `connection`/adapter seam, Plaid retargeted onto it), phase 6b-1
(app-level provider creds into the vaulted `provider_config` table, `.env` demoted to a bootstrap fallback),
and phase 6b-2 (the per-provider Connections-tab UI + the vault set/unlock UI; provider config removed from
Settings); phases 4–5 (passkey slots, enrollment/invite) and phase 6b-3 (the deferred account columns) not
started.** This
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
- **Consequences & responsibilities (what a user must actually protect, and what a compromise means).**
  Because the ledger is plaintext at rest, an attacker who copies the **database files or an unencrypted
  backup** already has the full transaction history *without breaking anything* — so the user's real
  responsibility is guarding those files: don't scatter copies, and use the **encrypted backup** for
  anything that leaves the machine. The **app password** protects *network* access to the running app, not
  the files on disk. The **vault passphrase** protects only the provider token, and only against **future**
  pulls after a file theft — so if the DB leaks, the historical exposure is already done and the right
  action is to **disconnect/revoke the connection** (kills any stolen token) and, for a hostile exposure,
  rotate the vault. Losing the vault passphrase itself costs nothing but the connections (re-link). This is
  the plain-language content the README "Security" section (below) must convey.

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
= perimeter, admin gates settings not data; **topology is *detected* not a chosen profile** — Standalone
vs client-server falls out of per-request loopback/network, the only real user choice is the
forward-looking "connecting a data source?" declaration, and `security_profile` is demoted to a
pre-detection stopgap — see "Topology is detected, not a chosen profile"); trusted-server / server-side crypto (browser-side only if we
ever want an untrusted host); retire `server_managed`, the master-key fallback, **and any `off`/plaintext
token path** — the vault is the *only* custody, with passphrase strength keyed to provider mode (sandbox
lax, Production enforced); no required fallback slot / no recovery escrow (loss = re-link); passkeys are
Plaid-vault-only; **identity & perimeter** — password optionality is an all-or-nothing *workspace* toggle
(the existing two modes), per-user auth when on; **unify to one `user_account` table** (the flag toggles
only password verification — reverses the earlier "keep two tables" call; makes disable a flag flip);
**invite ceremony** — 128-bit HKDF bearer secret, app mints a copy-able code/link and
the human carries it (no email sending), 48–72h + single-use, AEAD-tag-as-verifier, account-creation
separable from vault-grant, rotate-on-untrusted-departure; **provider-agnostic connections** — a
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
   cleartext network bind. **Not** built here (deferred per scope): the passphrase/unlock **UI** (rides
   phase-6 connection cards), the three-radio→single-question topology **UI collapse** (the detection
   primitive it needs now exists), and co-present/invite **enrollment** (phase 5) — so today only the first
   user, or a user re-setting their own, can set a passphrase.
4. **Passkey (PRF) slot** — registration with the `prf` extension, unlock ceremony, biometric daily
   unlock, graceful "your authenticator lacks PRF → use a passphrase slot" fallback.
5. **Enrollment/invite** — co-present path first (simpler), then the invite ceremony (mint copy-able
   code/link, `pending_invite` table, redeem + re-wrap, expiry/single-use/revoke), then rotation-on-
   departure. No email sending.
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
   `providers.config` service with `resolve_app_config` (a saved row wins, else the `.env` `PLAID_*`
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
6b-3. **Deferred account columns.** Explicit `provider`/`connection_id` account columns, rename the
   `plaid_account_id`/`plaid_item_id` column *names* to be provider-neutral, and drop the vestigial
   `plaid_item` table (accounts link implicitly by `plaid_item_id == connection.external_id` until then).
   Teller, then SimpleFIN, follow on the seam.

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
- Memory `plaid-deferred-until-approval` — **superseded/corrected here:** Plaid BYOK has no approval gate
  (free tier ≈10 accounts), so Plaid is the intended *first* connection provider to test, not a deferred
  one. (Memory updated to match.)
