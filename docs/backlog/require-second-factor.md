# An administrator can require a second factor

## What it is

A **Require a second factor** switch in Administration's sign-in section, next to the password policy.
While it is on, every account signs in with a password plus either an authenticator code or a sign-in
passkey. An account with neither sets one up straight after its password at its next sign-in, before it
reaches anything else. While it is off, nothing changes: each person decides for themselves, as today.

It is wanted because how strong sign-in must be is already the operator's call (the password policy),
and today an administrator who wants everyone on two-factor can only ask.

**Where it stands:** agreed, not started. One design pass is owed before building: the setup step (see
*The setup step*). The switch is off by default and stays an addition to the per-user choice, never a
replacement, because friction is what pushes a household to turn sign-in off altogether
(`security-model.md` → *Passkeys and the second factor*).

## What counts as the second factor

**An authenticator or a sign-in passkey.** A passkey already stands in for the authenticator code, since
its ceremony requires user verification (`services/app_passkey.py`, `_USER_VERIFICATION`). So on a server
opened by name over HTTPS the requirement costs most people a fingerprint. Over a bare IP address or plain
HTTP no passkey can be registered (`security-model.md` → *Obstacles*), so there it means an authenticator
for everyone; the switch's description says so.

Vault passkeys do not count. They are a separate feature with separate storage (`vault_slot`), and
letting one satisfy sign-in would couple the two (`security-model.md` → *Passkeys and the second factor*).

## The setup step

The one part that needs care: a session whose password has been accepted but which must not reach any
data until a second factor exists.

- **Precedent:** the forced password change at sign-in already works this way. `routers/auth.py` → `login`
  parks the user in `pending_password_change_user_id` and `change-password` finishes the sign-in. A third
  pending state (for example `pending_second_factor_user_id`) follows the same pattern, and the forced
  password change, when both apply, comes first.
- **What the pending state may reach:** only the calls that set up a factor — authenticator setup and
  confirmation, and passkey registration. Today these act on `request.state.user`, which a pending session
  does not have, and passkey registration refuses without a signed-in user. Deciding how they act on the
  pending user without widening what a pending session can reach is the design pass.
- **Finishing:** confirming the authenticator, or registering the passkey, starts the session
  (`sign_in_sessions.start`). An authenticator set up here issues recovery codes as it does from Settings.
- **Abandoning:** leaving the step leaves the account without a factor; the next sign-in asks again.

## Turning a factor off while it is required

- **Authenticator:** turning it off is refused while it is required, unless the account has a sign-in
  passkey.
- **Passkeys:** removing one still takes no proof (`security-model.md` → *Passkeys and the second factor*:
  the likeliest reason is a lost device). Removing the last one with no authenticator leaves the account to
  set one up at its next sign-in.

## What does not change

- **2FA recovery codes** still sign in in place of a code.
- **`--reset-password`** (`backend/account_recovery.py`) still clears the authenticator and recovery codes
  (`control_database.restore_admin_access`), so a lost phone never locks anyone out for good. The account
  then sets up a factor at its next sign-in, like any other.
- **Sign-in protection off:** the switch does not apply and is not shown, since there is no sign-in.

## Work

- Setting: stored like the password policy (`control_database.get_password_policy` /
  `set_password_policy`), returned with it from the auth config, saved by an admin-only route.
- Sign-in: `login` and `change-password` route an account without a factor into the setup step while
  the switch is on. Passkey sign-in already presents a factor, so it is unaffected.
- Frontend: the switch in `components/administration/AccountSecuritySection.jsx`; the setup step on the
  sign-in screen, reusing the authenticator and passkey setup already in
  `components/settings/SignInFactorsSection.jsx`.
- Help: the `account-security` topic and the switch's own description, including the bare-IP / plain-HTTP
  case.
- Docs: `security-model.md` → *Passkeys and the second factor* gains the requirement and the setup step's
  boundary; remove the *Open* entry that points here.
- Tests: the pending state reaches nothing but setup; each sign-in path routes correctly with the switch on
  and off; turning the authenticator off is refused only when it would leave no factor.
