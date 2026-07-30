# Pre-auth security UI (Settings page)

**Status: deferred — blocked on a security-model decision (migrated from `TODO.md` 2026-07-30).**
Three small Settings forms were removed during a lint cleanup and are to be rebuilt once the
project commits to a security model. The backend endpoints and lib helpers were kept, so the
rebuild is mostly stitching.

**Context.** Three Settings sections were removed during a lint cleanup
because their `onChange`/`onEnabled` callbacks called setters
(`setSecurityProfile`, `setAuthEnabled`, `setPasswordPolicy`) that were
never wired up — they were vestiges of an in-progress security UI that
never made it across the finish line. The work was deferred because the
project hasn't decided which security model it wants to commit to. Plaid
integration will eventually force the question (token protection at rest
generally wants per-user authentication so a leaked DB doesn't equate to
leaked tokens).

**Why deferred.** Bigger architectural decision than fits in a cleanup
pass: deciding which security profiles to support, whether to require
2FA, how multi-user vs single-user modes interact, and how Plaid token
protection plugs in. The UI was three small forms; rebuilding them is
straightforward once the model is decided.

**What was removed.** Three sections in
[`frontend/src/pages/Settings.jsx`](../../frontend/src/pages/Settings.jsx) and
their internal components:

- **Security model** (radio picker over `SECURITY_PROFILES` from
  `lib/securityProfiles.js` — local_private / network_private /
  household_shared / multi_tenant). POSTed to `/auth/security-profile`.
  The component was `SecurityProfileSection`.
- **Sign-in protection** (single "Enable sign-in protection" button →
  `/auth/enable` → page reload → user is then on `AuthScreen`). The
  component was `AuthModeSection`.
- **Password policy** picker (radio over `PASSWORD_POLICIES` from
  `lib/passwordPolicy.js` — none / min_8 / strong). POSTed to
  `/auth/password-policy`. The component was `PasswordPolicyPanel`,
  rendered inside `AccountSecuritySection`.

**What was kept** (so rebuild is mostly stitching, not new authorship):

- `frontend/src/lib/securityProfiles.js` — the `SECURITY_PROFILES`
  list and `getSecurityProfile` helper. Still consumed by `AuthScreen`.
- `frontend/src/lib/passwordPolicy.js` — `PASSWORD_POLICIES`,
  `passwordPolicyHelpText`, `validatePasswordForPolicy`. Still consumed
  by `AuthScreen` and by `UserAdminSection` for new-user password
  validation.
- Backend endpoints `/auth/enable`, `/auth/security-profile`,
  `/auth/password-policy`, `/auth/status`. Untouched.
- `api.enableAuth`, `api.saveSecurityProfile`, `api.savePasswordPolicy`
  helpers in `frontend/src/lib/api.js`. Untouched.
- App-level session state (`authEnabled`, `securityProfile`,
  `passwordPolicy`) in `App.jsx` and exposed read-only through
  `useAppSession()`. The `experimentalSecuritySettings` flag is still
  threaded through to `AuthScreen` via `showModePill`.
- `AccountSecuritySection` (now just the 2FA management surface —
  authenticator app setup, disable, recovery code regen) and
  `PlaidTokenProtectionSection`. Both remain gated on `authEnabled`, so
  they are dormant in the current household mode but available when
  auth is turned on.

**To rebuild when the model is decided.** Three small Cards in
Settings, each with a radio list driven by the corresponding constant
array, an `onChange` that calls the existing API helper, and a status
callback that updates the session via setters that would need to be
exposed from `useAppSession()` (currently only getters are exposed —
adding the setters is the wiring this incomplete UI never finished).
