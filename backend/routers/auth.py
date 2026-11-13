# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
This router serves one frontend in two modes:
- auth-enabled installs use control-db users and sessions
- local mode still exposes a user-shaped API, but preferences can be split into
  named local profiles instead of real accounts
"""

import json
import math
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from backend import app_config
from backend.runtime_config import build_stamp, env_file_path
from backend.db.control_database import (
    authenticate_user,
    begin_totp_setup,
    bootstrap_required,
    consume_totp_code,
    delete_app_passkey,
    credentials_exports_any,
    credentials_exports_for_fingerprint,
    enable_auth_mode,
    disable_auth_mode,
    auth_required,
    create_local_identity,
    consume_recovery_code,
    create_user,
    create_initial_user,
    disable_totp,
    delete_user,
    enable_totp,
    get_https_warning_suppressed,
    get_login_account,
    get_password_policy,
    list_all_app_passkey_credentials,
    set_https_warning_suppressed,
    get_user_by_id,
    enable_auth_with_admin,
    list_users,
    password_policy_label,
    record_credentials_reissued,
    recovery_code_count,
    replace_recovery_codes,
    set_password_policy,
    spend_password_check,
    update_user,
    user_password_matches,
    verify_totp_code,
)
from backend.routers.app_control import (
    bundled_license_available,
    shutdown_available,
    third_party_notices_scope,
)
from backend.services.preferences import (
    clear_preferences,
    get_preferences,
    set_preference,
)
from backend.db.database import (_seed_default_categories, compact_if_worthwhile, ensure_shared_owner, get_db,
                                 get_db_instance_id)
from backend.db.demo_data import load_demo_data, is_demo_data_loaded, is_demo_loadable
from backend.routers.import_export.backup import _wipe_user_data_tables
from backend.services.documents import INGEST_GRACE_SECONDS, sweep_unreferenced_files
from backend.services import app_passkey, attempt_limiter, crypto_service, sign_in_sessions
from backend.services.exposure_response import REISSUED, SyncInProgress, app_secrets_to_rotate, reissue_all_credentials
from backend.services.vault_reset import revoke_all_credentials, unfinished
from backend import password_strength, transport
from backend.authorization import require_admin, require_admin_or_local


router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


class BootstrapRequest(LoginRequest):
    display_name: str | None = None


class UserCreateRequest(BootstrapRequest):
    role: str = "member"


class UserUpdateRequest(BaseModel):
    username: str | None = None
    display_name: str | None = None
    password: str | None = None
    role: str | None = None
    status: str | None = None
    must_change_password: bool | None = None


class TotpVerifyRequest(BaseModel):
    code: str


class PasskeyRegisterRequest(BaseModel):
    # The credential exactly as `PublicKeyCredential.toJSON()` produced it. Passed through whole rather
    # than destructured into fields: every byte of it is covered by the checks the verifier runs, and a
    # model that picked out the parts this code happens to read now would have to be widened by anyone
    # adding an extension later.
    credential: dict
    label: str | None = None


class PasskeyLoginRequest(BaseModel):
    credential: dict


class TotpConfirmRequest(TotpVerifyRequest):
    secret: str


class VaultPassphraseRequest(BaseModel):
    passphrase: str


class VaultChangePassphraseRequest(BaseModel):
    old_passphrase: str
    new_passphrase: str


class VaultRecoverRequest(BaseModel):
    # Both halves arrive together on purpose: recovery is one operation, so there is no window in which
    # the code has been spent and the replacement passphrase has not yet been set. See
    # `crypto_service.recover_with_code`.
    code: str
    new_passphrase: str


class VaultPasskeyPassphraseRequest(BaseModel):
    # The passkey counterpart of `VaultRecoverRequest`, and one request for the same reason: the proof
    # and the replacement travel together, so no ceremony is ever spent with no passphrase set.
    credential_id: str
    prf_output: str
    new_passphrase: str


class VaultReenrolRequest(BaseModel):
    new_passphrase: str


class VaultResetRequest(BaseModel):
    # 'lost' or 'compromised'. The two paths differ in what they can promise — only a compromised
    # passphrase can still open the vault, and only an open vault can revoke anything — and in whether
    # another member's working slot is a reason to refuse. The user is the only one who knows which.
    reason: str
    # The typed confirmation. Checked server-side as well as in the dialog because this is the one
    # irreversible operation in the app and the endpoint is reachable without it.
    confirm: str = ""


class VaultPasskeyRegisterRequest(BaseModel):
    # `prf_output` is the authenticator's PRF result for `prf_salt`, base64. It is the unlock secret
    # itself — the exact counterpart of a passphrase in the request above — and is never stored.
    credential_id: str
    prf_output: str
    prf_salt: str
    label: str | None = None


class VaultPasskeyUnlockRequest(BaseModel):
    credential_id: str
    prf_output: str


class EnableAuthRequest(BaseModel):
    enabled: bool = True
    # When present, turning on sign-in protection claims an existing identity as admin: `claim_user_id`
    # is the identity the operator claims, `admin_password` is the password set for it, and
    # `initial_passwords` maps other user ids to an optional starting password (missing/blank => that
    # account is left claimable, forced to set one at next login). Absent => enable auth on an empty
    # workspace and bootstrap the first admin via the sign-in screen.
    claim_user_id: str | None = None
    admin_password: str | None = None
    initial_passwords: dict[str, str] | None = None
    # The operator may pick the password policy while enabling sign-in, rather than being locked to the
    # stored default; it is applied before claiming so the admin/starting passwords validate against it.
    password_policy: str | None = None


class PasswordChangeRequest(BaseModel):
    new_password: str


class OwnPasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class PasswordPolicyRequest(BaseModel):
    policy: str


class PasswordStrengthRequest(BaseModel):
    password: str


class HttpsWarningSuppressRequest(BaseModel):
    suppressed: bool


class UserPreferenceRequest(BaseModel):
    key: str
    value: object


class IdentityCreateRequest(BaseModel):
    name: str


class SelectIdentityRequest(BaseModel):
    user_id: str


def _session_can_manage_config(user: dict | None) -> bool:
    """Whether this session may be *told* the configuration, as opposed to being able to demand it.

    The same reach `require_admin_or_local` grants, phrased as a question rather than a guard: the
    status payload has to decide whether to include a field, and a 403 is not an answer it can use. Both
    must stay in step — the database locations are admin-or-local information, and a field that leaked
    them into a member's status payload would widen that boundary without any endpoint appearing to
    change."""
    if not auth_required():
        return True
    return bool(user and user.get("role") == "admin")


def _require_current_user(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


# Which secret an attempt is at (`attempt_limiter`). Kept apart so that wrong guesses at one kind of secret
# never pause another: a mistyped vault passphrase says nothing about the sign-in password.
_SIGN_IN = "sign_in"
_TWO_FACTOR = "two_factor"
_VAULT = "vault"


def _wait_phrase(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds} second{'' if seconds == 1 else 's'}"
    minutes = math.ceil(seconds / 60)
    return f"{minutes} minute{'' if minutes == 1 else 's'}"


def _too_many_attempts(retry_after: int, *, restart_sign_in: bool = False) -> HTTPException:
    """The refusal for a limited attempt: 429, with the wait both as `Retry-After` and in the body.

    `restart_sign_in` tells the sign-in screen that the two-factor challenge was dropped, so the next step
    is the password rather than another code."""
    detail = {
        "code": "too_many_attempts",
        "message": f"Too many attempts. Try again in {_wait_phrase(retry_after)}.",
        "retry_after": retry_after,
    }
    if restart_sign_in:
        detail["restart_sign_in"] = True
    return HTTPException(status_code=429, detail=detail, headers={"Retry-After": str(retry_after)})


def _begin_attempt(scope: str, subject: str) -> None:
    try:
        attempt_limiter.begin(scope, subject)
    except attempt_limiter.TooManyAttempts as exc:
        raise _too_many_attempts(exc.retry_after)


def _wrong_secret(scope: str, subject: str, refusal: HTTPException) -> HTTPException:
    """Count a wrong secret and return what to raise: `refusal`, or the lockout when this was the failure
    that started one — said at once, rather than left for the next attempt to discover."""
    if attempt_limiter.failed(scope, subject):
        return _too_many_attempts(attempt_limiter.LOCKOUT_SECONDS)
    return refusal


def _require_local_mode():
    if auth_required():
        raise HTTPException(status_code=400, detail="This action is only available while sign-in protection is off")


def _session_payload(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user.get("display_name") or user["username"],
        "role": user.get("role", "member"),
        # Vault status: whether the workspace DEK exists at all, whether *this* user can unlock it
        # (holds a slot that opens it), and whether it is unlocked in the current process for them.
        "vault_configured": crypto_service.vault_configured(),
        "vault_has_passphrase": crypto_service.user_has_slot(user["id"]),
        "vault_unlocked": crypto_service.is_unlocked(user["id"]),
        # A slot that exists but has not been granted the DEK. Distinct from "no slot" because the two
        # ask opposite things of the user — one offers to enrol, the other says who to wait for.
        "vault_access_pending": crypto_service.user_access_pending(user["id"]),
        # Whether this user could approve someone else, so the UI can offer the queue only to a member
        # who can act on it. Requires holding the DEK, not merely being an admin.
        "vault_can_grant": crypto_service.is_unlocked(user["id"]),
        "vault_passkeys": crypto_service.user_passkey_slots(user["id"]),
        # How long a recently presented secret still authorizes changes to the unlock methods
        # themselves; 0 when none. Served so a surface can ask for proof *before* the action instead of
        # only after a refusal — seconds remaining rather than an expiry instant, so the browser needs
        # no clock agreement with the server. Advisory only: the server decides, and a stale client copy
        # costs one redundant prompt rather than admitting anything.
        "vault_proof_seconds_remaining": crypto_service.proof_seconds_remaining(user["id"]),
        # Whether a vault recovery code is outstanding, and when it was issued. Never the code itself —
        # it exists in the clear only in the response that mints it. The date is the only honest thing
        # to say about a secret shown once, and is enough to recognize a code still on file.
        "vault_has_recovery_code": crypto_service.has_recovery_code(user["id"]),
        "vault_recovery_code_issued_at": crypto_service.recovery_code_issued_at(user["id"]),
        # The length half of the floor, which the dialog checks on every keystroke. Served rather than
        # duplicated in the client because the two must agree exactly: a client holding its own copy
        # either blocks a passphrase the server would take or offers one it refuses, and both read as a
        # broken vault. The guessability half is asked of the server (`/vault/passphrase-strength`).
        "vault_passphrase_min_length": crypto_service.VAULT_PRODUCTION_MIN_LEN,
        # This member's passphrase was judged under the current rule and failed it — at their last unlock,
        # since that is the only moment it can be judged. Drives the prompt to change it.
        "vault_passphrase_needs_change": crypto_service.passphrase_needs_change(user["id"]),
        # Not yet judged under the current rule and estimator, which only typing it can settle. Drives
        # the locked strip's request to unlock with the passphrase rather than a passkey.
        "vault_passphrase_needs_check": crypto_service.passphrase_needs_check(user["id"]),
        "must_change_password": bool(user.get("must_change_password")),
        # Login passkeys, which are not vault passkeys and are listed separately for that reason. No key
        # material rides along — only what the settings list renders.
        "app_passkeys": app_passkey.registered_passkeys(user["id"]),
        "two_factor_enabled": bool(user.get("totp_enabled")),
        "recovery_code_count": recovery_code_count(user["id"]),
        "tenant_id": user["tenant_id"],
        "tenant_name": user.get("tenant_name"),
    }


def _auth_status_payload(request: Request | None = None) -> dict:
    # App startup consumes one payload to choose the bootstrap/sign-in gates and the active identity,
    # so status folds runtime config, auth mode, and the current session identity into one round trip.
    # Identity is now uniform: whichever mode, the current user (if any) comes from the session.
    enabled = auth_required()
    password_policy = get_password_policy()
    with get_db() as conn:
        db_instance_id = get_db_instance_id(conn)
    developer_options_enabled = app_config.developer_options_enabled()
    payload = {
        "auth_enabled": enabled,
        "needs_bootstrap": enabled and bootstrap_required(),
        "password_policy": password_policy,
        "password_policy_label": password_policy_label(password_policy),
        "developer_options_enabled": developer_options_enabled,
        # Whether this process can stop itself, which only the desktop launcher arranges. Reported here
        # rather than probed separately because the UI has to decide whether to offer the control at all,
        # and this payload already exists to answer that class of question in one round trip.
        "app_shutdown_available": shutdown_available(),
        # Whether a local license copy exists to fall back on when the published one is unreachable.
        "bundled_license_available": bundled_license_available(),
        "third_party_notices_scope": third_party_notices_scope(),
        # Which commit a packaged build came from, for the About panel. Ungated, unlike the data
        # location below: a commit of a published repository describes the software rather than the
        # machine it is running on. Null in a checkout, where the row is left out.
        "build_stamp": build_stamp(),
        "db_instance_id": db_instance_id,
    }
    # The current identity always comes from the session (both modes). A perimeter-off session is
    # `pwless`; enabling auth invalidates it (the middleware clears it), so a stale pwless session is
    # not surfaced as the signed-in user here either.
    if request:
        session = request.scope.get("session") or {}
        user_id = session.get("user_id")
        if user_id and not (enabled and session.get("pwless")):
            user = get_user_by_id(user_id)
            if user:
                payload["user"] = _session_payload(user)
        # Where this copy's databases are, for the navigation pane's data-location line. Sent only to a
        # session that could already read it from the configuration report, so the line cannot widen who
        # knows the filesystem layout; every other session gets no field and renders nothing. It rides
        # this payload rather than a call of its own because the nav needs it at first paint, and the
        # answer cannot change while the process runs.
        if _session_can_manage_config(payload.get("user")):
            payload["data_location"] = app_config.data_location()
        # Detected transport facts (topology + HTTPS) are per-request, not stored presets. The frontend
        # uses these to steer HTTPS guidance and gate connect-time actions on real HTTPS availability.
        payload["transport"] = {
            "is_loopback": transport.request_is_loopback(request),
            "scheme": transport.request_scheme(request),
            "is_https": transport.request_is_https(request),
            # Whether this browser may send a vault secret; the interface refuses first on it.
            "vault_link_protected": transport.vault_link_is_protected(request),
            "https_expected": transport.https_expected(request, perimeter_on=enabled),
            "https_warning_suppressed": get_https_warning_suppressed(),
        }
    return payload


@router.get("/bootstrap-status")
def bootstrap_status():
    return _auth_status_payload()


@router.get("/status")
def auth_status(request: Request):
    return _auth_status_payload(request)


# Preferences are scoped to the current identity in both modes: the `user_id` the middleware resolved
# onto `request.state.user`. That id is the `scope_id` used in the data DB's ui_preference table.
def _resolve_preference_scope(request: Request) -> str:
    return _require_current_user(request)["id"]


@router.get("/preferences")
def auth_preferences(request: Request):
    scope_id = _resolve_preference_scope(request)
    prefs = get_preferences(scope_id)
    parsed = {}
    for key, value in prefs.items():
        try:
            parsed[key] = json.loads(value)
        except Exception:
            parsed[key] = value
    return {"preferences": parsed}


@router.post("/preferences")
def save_auth_preference(body: UserPreferenceRequest, request: Request):
    key = (body.key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Preference key is required")
    scope_id = _resolve_preference_scope(request)
    set_preference(scope_id, key, json.dumps(body.value))
    return {"ok": True}


@router.delete("/preferences")
def clear_auth_preferences(request: Request):
    scope_id = _resolve_preference_scope(request)
    clear_preferences(scope_id)
    return {"ok": True}


def _identity_view(user: dict, sole_vault_member: str | None) -> dict:
    # `username` is what the identity signs in with once sign-in protection is on, which the page that turns
    # it on has to be able to say — and hand a password manager, which files the new password under it.
    # Local mode only, where it is no secret: anyone reaching this can already select the identity.
    return {"id": user["id"], "display_name": user.get("display_name") or user["username"],
            "username": user["username"], "sole_vault_member": user["id"] == sole_vault_member}


@router.get("/identities")
def list_identities():
    # Perimeter-off identity chooser: names only, reachable before a session exists (there are no
    # secrets to protect while sign-in is off). In auth mode identities are managed through the admin
    # user endpoints instead, so this is local-mode only.
    _require_local_mode()
    sole = crypto_service.sole_vault_member_id()
    return {"identities": [_identity_view(u, sole) for u in list_users()]}


@router.post("/identities")
def create_identity(body: IdentityCreateRequest):
    _require_local_mode()
    try:
        user = create_local_identity(body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"identity": _identity_view(user, crypto_service.sole_vault_member_id())}


@router.post("/select-identity")
def select_identity(body: SelectIdentityRequest, request: Request):
    # Establish a perimeter-off session: pick an identity, no password checked. Marked `pwless` so
    # that enabling sign-in protection later invalidates it (see the middleware and _auth_status_payload).
    _require_local_mode()
    user = get_user_by_id(body.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Identity not found")
    sign_in_sessions.start(request.session, user["id"], pwless=True)
    return {"user": _session_payload(user)}


@router.patch("/identities/{user_id}")
def rename_identity(user_id: str, body: IdentityCreateRequest):
    _require_local_mode()
    try:
        user = update_user(user_id, username=body.name, display_name=body.name)
    except ValueError as exc:
        detail = str(exc)
        raise HTTPException(status_code=404 if detail == "user not found" else 400, detail=detail)
    return {"identity": _identity_view(user, crypto_service.sole_vault_member_id())}


def _delete_person(user_id: str) -> None:
    """Delete the user and their preferences, which are keyed by their id alone and could never be read
    again. The preferences go second because the deletion can refuse (the last administrator)."""
    delete_user(user_id)
    clear_preferences(user_id)


@router.delete("/identities/{user_id}")
def delete_identity(user_id: str):
    _require_local_mode()
    try:
        # Deleting the last vault member resets the vault (`crypto_service.remove_vault_member`).
        crypto_service.remove_vault_member(user_id, lambda: _delete_person(user_id))
    except ValueError as exc:
        detail = str(exc)
        raise HTTPException(status_code=404 if detail == "user not found" else 400, detail=detail)
    return {"ok": True}


@router.post("/demo-data")
def load_demo_data_endpoint(request: Request):
    """Populate an empty local tenant with the explorable demo dataset, scoped to the current identity.
    No-op if the tenant already has data; local-mode only (so it can never run against a real
    authenticated account)."""
    _require_local_mode()
    scope_id = _require_current_user(request)["id"]
    with get_db() as conn:
        return load_demo_data(conn, scope_id=scope_id)


@router.get("/demo-data")
def demo_data_status():
    """Demo-data state for this tenant. `loaded` drives the banner + the import/connect block; `loadable`
    (empty tenant) drives the "Load demo data" offer on the Import page so the demo is reachable
    after a skip or a clear, not only from first-run onboarding.

    Answered in both modes, unlike loading and clearing: it only reads, and demo data loaded before sign-in
    protection was turned on is still there and still blocks imports, so a signed-in session needs to know.
    `loadable` is false while protection is on, because loading is a protection-off action."""
    with get_db() as conn:
        return {
            "loaded": is_demo_data_loaded(conn),
            "loadable": not auth_required() and is_demo_loadable(conn),
        }


@router.post("/demo-data/clear")
def clear_demo_data_endpoint():
    """Erase the demo dataset and return the tenant to a clean first-run state. REFUSES (409) unless the
    demo marker is set, so it can never wipe real data — which never carries the marker, and which can
    never coexist with demo data because imports/connections are blocked while it is loaded. Scoped to
    the tenant data DB; local profiles and credentials are untouched. Local-mode only."""
    _require_local_mode()
    with get_db() as conn:
        if not is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "no_demo_data",
                "message": "No demo data is loaded, so there is nothing to clear.",
            })
        # Mirror restore's wipe: one transaction, FK checks deferred to commit. The wipe clears
        # import_workflow_state (so the demo marker goes with it); reseed the first-run skeleton.
        conn.execute("BEGIN")
        conn.execute("PRAGMA defer_foreign_keys = ON")
        _wipe_user_data_tables(conn)
        _seed_default_categories(conn)
        ensure_shared_owner(conn)
    # The wipe takes the `document` rows with the transactions they hang off (ON DELETE CASCADE), but
    # files are not in that transaction and would survive it as orphans. Swept after the commit, so a
    # failed wipe never costs a file: the ledger is the authority on what exists, and this derives the
    # store from it. The grace period spares a file whose ingest has written it but not yet committed
    # its row.
    with get_db() as conn:
        sweep_unreferenced_files(conn, min_age_seconds=INGEST_GRACE_SECONDS)
    compact_if_worthwhile(reason="cleared the demo data")
    return {"ok": True}


@router.post("/config/{key}/reset")
def reset_config_value(key: str, request: Request):
    """Forget a stored configuration value so its default applies again after a restart. Both settings
    this can reach (the session secret, the session cookie name) generate or derive themselves, so this
    is a reset rather than an edit."""
    require_admin_or_local(request)
    try:
        return app_config.clear_stored_value(key)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown setting")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/config")
def get_effective_config(request: Request):
    """The resolved configuration and, for each value, which layer supplied it. Read-only by design:
    the settings that can be changed in the app have their own endpoints, and the rest are consumed
    before the app exists (ports, database locations), so this exists to answer "what is in effect and
    where did it come from" rather than to edit anything."""
    require_admin_or_local(request)
    return {
        "settings": app_config.effective_config(),
        "env_file_path": str(env_file_path()),
        "env_file_present": env_file_path().exists(),
    }


@router.post("/password-strength")
def password_strength_check(body: PasswordStrengthRequest, request: Request):
    """Whether a sign-in password being chosen meets the "Strong" policy, asked while it is typed.

    The estimate comes from dictionaries on the server, so the form asks here rather than running a second
    estimator that would disagree at the margin. Public in the middleware, because two of the forms that
    set a password come before any session exists: the first account, and the change forced at sign-in.
    Answered only to someone setting a password at that moment, so it is not an estimator for anyone who
    can reach the server. Nothing is stored: the same password reaches the server when it is submitted."""
    session = request.session
    if not (session.get("user_id") or session.get("pending_password_change_user_id")
            or (auth_required() and bootstrap_required())):
        raise HTTPException(status_code=401, detail="Not authenticated")
    estimate = password_strength.estimate(body.password)
    return {"strong": estimate["score"] >= password_strength.TOP_SCORE, **estimate}


@router.post("/password-policy")
def save_password_policy(body: PasswordPolicyRequest, request: Request):
    require_admin_or_local(request)
    try:
        set_password_policy(body.policy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    policy = get_password_policy()
    return {
        "password_policy": policy,
        "password_policy_label": password_policy_label(policy),
    }


@router.post("/https-warning-suppress")
def suppress_https_warning(body: HttpsWarningSuppressRequest, request: Request):
    require_admin_or_local(request)
    set_https_warning_suppressed(bool(body.suppressed))
    return {"https_warning_suppressed": get_https_warning_suppressed()}


@router.post("/enable")
def enable_auth(body: EnableAuthRequest, request: Request):
    if not body.enabled:
        raise HTTPException(status_code=400, detail="Use /auth/disable to turn sign-in protection off")
    if auth_required():
        return _auth_status_payload(request)
    if body.claim_user_id:
        # Claim an existing identity as admin (sets its password), mark every other passwordless
        # identity must_change_password (claimable at next login), and flip the perimeter on — signing
        # the operator straight in as the protected admin.
        try:
            admin = enable_auth_with_admin(
                body.claim_user_id,
                body.admin_password or "",
                body.initial_passwords,
                body.password_policy,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        sign_in_sessions.start(request.session, admin["id"])
        return _auth_status_payload(request)
    # No claim: enable on an empty workspace (bootstrap the first admin at the sign-in screen). If any
    # passwordless identities happen to exist, mark them claimable so enabling can never lock anyone out.
    if body.password_policy is not None:
        try:
            set_password_policy(body.password_policy)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    for user in list_users():
        if not get_login_account(user["username"])["password_set"]:
            update_user(user["id"], must_change_password=True)
    enable_auth_mode()
    return _auth_status_payload(request)


@router.post("/disable")
def disable_auth(request: Request):
    # Turning the perimeter off reopens network access and drops sign-in, so it is admin-gated. Identities
    # and their password hashes are preserved (dormant), so re-enabling is seamless. The acting admin
    # stays signed in as a now-perimeter-off (pwless) identity.
    if not auth_required():
        return _auth_status_payload(request)
    require_admin(request)
    disable_auth_mode()
    session = request.scope.get("session")
    if session is not None and session.get("user_id"):
        session["pwless"] = True
    return _auth_status_payload(request)


@router.post("/bootstrap")
def bootstrap(body: BootstrapRequest, request: Request):
    if not auth_required():
        raise HTTPException(status_code=400, detail="Auth is not enabled for this instance")
    try:
        user = create_initial_user(body.username, body.password, body.display_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    sign_in_sessions.start(request.session, user["id"])
    return {"user": _session_payload(user)}


@router.post("/login")
def login(body: LoginRequest, request: Request):
    if not auth_required():
        # Perimeter off: there is no password login — identities are chosen via /auth/select-identity.
        raise HTTPException(status_code=400, detail="Sign-in protection is off; choose an identity instead")

    # Limited by the name as typed, before anything is looked up, so a name with no account behind it is
    # limited exactly like one with an account — a difference would say which names are real.
    subject = body.username.strip().lower()
    _begin_attempt(_SIGN_IN, subject)

    # Auth mode. A password-set account verifies normally; an unset (sentinel) account is claimable —
    # login accepts it without a password *only* when it is flagged must_change_password, then routes
    # straight into the forced password-set. Either way a must_change_password account cannot complete
    # login until it sets a new password.
    account = get_login_account(body.username)
    usable = bool(account) and account["status"] == "active"
    user = None
    if usable and account["password_set"]:
        user = authenticate_user(body.username, body.password)
    elif usable and account["must_change_password"]:
        user = get_user_by_id(account["id"])
    else:
        spend_password_check(body.password)
    if not user:
        raise _wrong_secret(
            _SIGN_IN, subject, HTTPException(status_code=401, detail="Invalid username or password"),
        )
    attempt_limiter.succeeded(_SIGN_IN, subject)

    sign_in_sessions.end(request.session)
    if user.get("must_change_password"):
        request.session["pending_password_change_user_id"] = user["id"]
        return {"requires_password_change": True}
    if user.get("totp_enabled"):
        request.session["pending_user_id"] = user["id"]
        return {"requires_2fa": True, "recovery_code_count": recovery_code_count(user["id"])}
    sign_in_sessions.start(request.session, user["id"])
    return {"user": _session_payload(user)}


@router.post("/change-password")
def change_password(body: PasswordChangeRequest, request: Request):
    # Completes a forced password change begun at login (must_change_password / claim). The pending user
    # is held in the session between the two calls; setting a valid password clears the flag and either
    # continues to 2FA or completes sign-in.
    pending_user_id = request.session.get("pending_password_change_user_id")
    if not pending_user_id:
        raise HTTPException(status_code=400, detail="No pending password change")
    user = get_user_by_id(pending_user_id)
    if not user:
        request.session.clear()
        raise HTTPException(status_code=400, detail="No pending password change")
    try:
        update_user(user["id"], password=body.new_password, must_change_password=False)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    request.session.clear()
    updated = get_user_by_id(user["id"])
    if updated.get("totp_enabled"):
        request.session["pending_user_id"] = updated["id"]
        return {"requires_2fa": True, "recovery_code_count": recovery_code_count(updated["id"])}
    sign_in_sessions.start(request.session, updated["id"])
    return {"user": _session_payload(updated)}


@router.post("/password")
def change_own_password(body: OwnPasswordChangeRequest, request: Request):
    """A signed-in user replacing their own password.

    The current password is the proof, because the session alone is not: whoever is at an unattended
    browser would otherwise turn a few minutes at it into the account. It is limited as a sign-in
    attempt on the same account, so guessing here and guessing at the sign-in screen spend one count.
    The change signs the account out everywhere else (`control_database.update_user`) and keeps the
    browser that made it."""
    if not auth_required():
        raise HTTPException(status_code=400, detail="Auth is not enabled for this instance")
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    subject = user["username"].strip().lower()
    _begin_attempt(_SIGN_IN, subject)
    if not user_password_matches(user["id"], body.current_password):
        raise _wrong_secret(
            _SIGN_IN, subject, HTTPException(status_code=401, detail="The current password is not correct"),
        )
    attempt_limiter.succeeded(_SIGN_IN, subject)
    try:
        updated = update_user(
            user["id"],
            password=body.new_password,
            keep_sign_in_session=sign_in_sessions.digest_of(request.session),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    request.state.user = updated
    return {"user": _session_payload(updated)}


@router.post("/logout")
def logout(request: Request):
    session = request.scope.get("session")
    if session is not None:
        # Drop any unlocked vault DEK for this identity so logging out re-locks the vault.
        user_id = session.get("user_id")
        if user_id:
            crypto_service.lock(user_id)
        # Ends the session on the server as well as in this browser, so a copy of the cookie taken
        # earlier stops working too.
        sign_in_sessions.end(session)
    return {"ok": True}


@router.post("/2fa/verify")
def verify_2fa(body: TotpVerifyRequest, request: Request):
    if not auth_required():
        raise HTTPException(status_code=400, detail="Auth is not enabled for this instance")
    pending_user_id = request.session.get("pending_user_id")
    if not pending_user_id:
        raise HTTPException(status_code=400, detail="No pending two-factor challenge")
    user = get_user_by_id(pending_user_id)
    if not user or not user.get("totp_enabled") or not user.get("totp_secret"):
        request.session.clear()
        raise HTTPException(status_code=400, detail="Two-factor authentication is not configured")
    # A lockout also drops the challenge, so continuing means proving the password again — which is
    # limited on its own, and is what keeps a known password from buying unlimited guesses at the code.
    try:
        attempt_limiter.begin(_TWO_FACTOR, user["id"])
    except attempt_limiter.TooManyAttempts as exc:
        if exc.locked:
            request.session.clear()
        raise _too_many_attempts(exc.retry_after, restart_sign_in=exc.locked)
    if not (
        consume_totp_code(user["id"], user["totp_secret"], body.code)
        or consume_recovery_code(user["id"], body.code)
    ):
        if attempt_limiter.failed(_TWO_FACTOR, user["id"]):
            request.session.clear()
            raise _too_many_attempts(attempt_limiter.LOCKOUT_SECONDS, restart_sign_in=True)
        raise HTTPException(status_code=401, detail="Invalid authentication code")
    attempt_limiter.succeeded(_TWO_FACTOR, user["id"])

    sign_in_sessions.start(request.session, user["id"])
    return {"user": _session_payload(user)}


@router.get("/me")
def me(request: Request):
    # Identity is uniform now: the middleware resolved the session identity onto request.state in both
    # modes, so /me just reflects it.
    return {"user": _session_payload(_require_current_user(request))}


@router.post("/2fa/setup")
def start_2fa_setup(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    setup = begin_totp_setup(user["id"])
    request.session["pending_totp_secret"] = setup["secret"]
    return setup


@router.post("/2fa/confirm")
def confirm_2fa_setup(body: TotpConfirmRequest, request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    pending_secret = request.session.get("pending_totp_secret")
    if not pending_secret or pending_secret != body.secret:
        raise HTTPException(status_code=400, detail="No pending two-factor setup")
    if not verify_totp_code(body.secret, body.code):
        raise HTTPException(status_code=401, detail="Invalid authentication code")
    enable_totp(user["id"], body.secret)
    recovery_codes = replace_recovery_codes(user["id"])
    request.session.pop("pending_totp_secret", None)
    updated = get_user_by_id(user["id"])
    request.state.user = updated
    return {"user": _session_payload(updated), "recovery_codes": recovery_codes}


def _require_authenticator_code(user: dict, code: str) -> None:
    """The authenticator check for a signed-in change to two-factor itself, limited like the sign-in one:
    a stolen session must not be able to guess its way to turning the second factor off."""
    _begin_attempt(_TWO_FACTOR, user["id"])
    if not consume_totp_code(user["id"], user["totp_secret"], code):
        raise _wrong_secret(
            _TWO_FACTOR, user["id"], HTTPException(status_code=401, detail="Invalid authentication code"),
        )
    attempt_limiter.succeeded(_TWO_FACTOR, user["id"])


@router.post("/2fa/disable")
def turn_off_2fa(body: TotpVerifyRequest, request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not user.get("totp_enabled") or not user.get("totp_secret"):
        raise HTTPException(status_code=400, detail="Two-factor authentication is not enabled")
    _require_authenticator_code(user, body.code)
    disable_totp(user["id"])
    updated = get_user_by_id(user["id"])
    request.state.user = updated
    return {"user": _session_payload(updated)}


@router.post("/2fa/recovery-codes")
def regenerate_recovery_codes(body: TotpVerifyRequest, request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not user.get("totp_enabled") or not user.get("totp_secret"):
        raise HTTPException(status_code=400, detail="Two-factor authentication is not enabled")
    _require_authenticator_code(user, body.code)
    recovery_codes = replace_recovery_codes(user["id"])
    updated = get_user_by_id(user["id"])
    request.state.user = updated
    return {"user": _session_payload(updated), "recovery_codes": recovery_codes}


# --- Passkeys for the login perimeter -------------------------------------------------------------
#
# The vault's passkeys are a *different feature* that happens to use the same browser API: these cross
# the perimeter, those open encrypted credentials. Separate endpoints, separate storage and separate
# copy, deliberately — see `services/app_passkey.py`. Signing in with one of these confers nothing about
# the vault, and a user who holds both is prompted twice.

# A challenge is one ceremony's, and it belongs to the browser that asked for it — the same rule the
# vault applies to an unlock and to a proof stamp. Holding it in the signed session gets both properties
# with no table: it cannot be replayed from another browser, and popping it on use makes it single-use.
_REGISTER_CHALLENGE_KEY = "passkey_register_challenge"
_LOGIN_CHALLENGE_KEY = "passkey_login_challenge"


def _require_passkey_context(request: Request) -> dict:
    context = transport.passkey_context(request)
    if not context["available"]:
        raise HTTPException(status_code=400, detail={
            "code": context["reason"],
            "message": "Passkeys need an HTTPS connection to a named host",
        })
    return context


def _expected_origin(request: Request, rp_id: str) -> str:
    """Which origin this deployment will accept an assertion from.

    The port is deliberately not pinned, and that is a decision rather than laziness. Luma's frontend
    and backend ports are both configurable, a dev session serves the app from Vite while the API answers
    elsewhere, and the browser test harness picks its own pair per run — so a hardcoded origin would
    break passkeys in most of the configurations this repo supports. What matters is already enforced:
    the browser will not offer a credential whose RP id does not match the page's host, so an accepted
    origin is always *this host*, and a different port on the same host is another server on the
    operator's own machine, which the deployment model already trusts (`security-model.md` → *What is
    defended*).

    The scheme is not taken on trust, though: anything but loopback has to be HTTPS, which is the same
    secure-context rule `transport.passkey_context` applies before a ceremony is offered at all.
    """
    origin = request.headers.get("origin") or ""
    parsed = urllib.parse.urlparse(origin)
    if parsed.hostname != rp_id:
        raise HTTPException(status_code=400, detail="This page cannot run a passkey ceremony")
    if parsed.scheme != "https" and not transport.page_is_secure_context(request):
        raise HTTPException(status_code=400, detail="Passkeys need an HTTPS connection")
    return origin


@router.get("/passkey/params")
def passkey_params(request: Request):
    """Whether this connection can run a passkey ceremony, and whether there is any point offering one.

    Public, because the sign-in screen has to decide whether to show the button before anyone has said
    who they are. `any_registered` asks the same question the sign-in ceremony's credential list does —
    an active account's passkey — so the button is never offered for a list that would come back empty.
    """
    context = transport.passkey_context(request)
    return {**context, "any_registered": bool(list_all_app_passkey_credentials())}


@router.post("/passkey/register/begin")
def passkey_register_begin(request: Request):
    user = _require_current_user(request)
    if not auth_required():
        raise HTTPException(
            status_code=400,
            detail="Turn on sign-in protection before adding a passkey; there is no sign-in to use it for",
        )
    context = _require_passkey_context(request)
    options, challenge = app_passkey.registration_options(user, context["rp_id"])
    request.session[_REGISTER_CHALLENGE_KEY] = challenge
    return {"options": json.loads(options)}


@router.post("/passkey/register/complete")
def passkey_register_complete(body: PasskeyRegisterRequest, request: Request):
    user = _require_current_user(request)
    context = _require_passkey_context(request)
    challenge = request.session.pop(_REGISTER_CHALLENGE_KEY, None)
    if not challenge:
        raise HTTPException(status_code=400, detail="That passkey registration expired. Try again.")
    try:
        app_passkey.register_credential(
            user,
            credential=body.credential,
            challenge=challenge,
            rp_id=context["rp_id"],
            origin=_expected_origin(request, context["rp_id"]),
            label=body.label,
        )
    except app_passkey.PasskeyRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.post("/passkey/login/begin")
def passkey_login_begin(request: Request):
    if not auth_required():
        raise HTTPException(status_code=400, detail="Sign-in protection is off; choose an identity instead")
    context = _require_passkey_context(request)
    try:
        options, challenge = app_passkey.authentication_options(context["rp_id"])
    except app_passkey.PasskeyRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    request.session[_LOGIN_CHALLENGE_KEY] = challenge
    return {"options": json.loads(options)}


@router.post("/passkey/login/complete")
def passkey_login_complete(body: PasskeyLoginRequest, request: Request):
    """Complete a passkey sign-in.

    **This deliberately skips the two-factor step**, and that is the feature rather than a shortcut. The
    ceremony is run with user verification *required*, so the authenticator has already demanded a
    biometric or a PIN: the holder proved possession of the device and something inherent or known, which
    is what the TOTP prompt after a password exists to establish. Asking for a code as well would be
    charging twice for the same guarantee — and the friction it adds is exactly what this feature exists
    to remove (`security-model.md` → *Passkeys and the second factor*).
    """
    if not auth_required():
        raise HTTPException(status_code=400, detail="Sign-in protection is off; choose an identity instead")
    context = _require_passkey_context(request)
    origin = _expected_origin(request, context["rp_id"])
    challenge = request.session.pop(_LOGIN_CHALLENGE_KEY, None)
    if not challenge:
        raise HTTPException(status_code=400, detail="That sign-in attempt expired. Try again.")
    try:
        stored = app_passkey.verify_assertion(
            credential=body.credential,
            challenge=challenge,
            rp_id=context["rp_id"],
            origin=origin,
        )
    except app_passkey.PasskeyRejected as exc:
        raise HTTPException(status_code=401, detail=str(exc))

    user = get_user_by_id(stored["user_id"])
    if not user:
        raise HTTPException(status_code=401, detail="That passkey is not registered here")
    sign_in_sessions.end(request.session)
    if user.get("must_change_password"):
        # The same gate a password sign-in hits. A passkey proves who is at the browser; it says nothing
        # about an account whose password an admin has just reset, and letting one route around the
        # forced change would leave the account holding an unusable sentinel indefinitely.
        request.session["pending_password_change_user_id"] = user["id"]
        return {"requires_password_change": True}
    sign_in_sessions.start(request.session, user["id"])
    return {"user": _session_payload(user)}


@router.delete("/passkey/{passkey_id}")
def passkey_remove(passkey_id: str, request: Request):
    """Remove one of this user's login passkeys.

    Needs a signed-in session and nothing more. The vault's removals take a proof of the passphrase
    because stripping a slot there can strand encrypted credentials; nothing is stranded here, the
    password remains the floor, and a lost device is the most likely reason anyone reaches this — so a
    gate that demanded the missing authenticator would fire exactly when it must not.
    """
    user = _require_current_user(request)
    if not delete_app_passkey(user["id"], passkey_id):
        raise HTTPException(status_code=404, detail="No such passkey")
    return {"user": _session_payload(user)}


def _weak_passphrase_error(exc: crypto_service.WeakPassphrase) -> HTTPException:
    """The floor stated as data, not only as prose.

    Which part failed (`reason`), the length a client gates on, and the estimator's own advice, so a
    client can say what to change rather than parse a sentence — and a client that fell out of step with
    the server would either block a passphrase the server accepts or offer one it refuses, both of which
    look like a bug in the vault. `code` is what the UI keys on; the message is for anything that only
    shows text."""
    return HTTPException(status_code=400, detail={
        "code": "weak_passphrase",
        **exc.shortfall,
        "min_length": crypto_service.VAULT_PRODUCTION_MIN_LEN,
    })


@router.post("/vault/passphrase-strength", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_passphrase_strength(body: VaultPassphraseRequest, request: Request):
    """Whether a passphrase being chosen clears the floor, asked while it is typed.

    The guessability half of the floor is an estimate from dictionaries that live only on the server, and
    a second estimator in the browser would disagree with it at the margin — the drift the served length
    exists to prevent. So the dialog asks here. Nothing is stored or limited: this verifies no secret, and
    the same passphrase reaches the server anyway when it is submitted."""
    _require_current_user(request)
    assessment = crypto_service.passphrase_assessment(body.passphrase)
    return {"acceptable": assessment["shortfall"] is None, **assessment}


def _proof_required_error(exc: Exception) -> HTTPException:
    """The refusal that asks for a secret to be presented again.

    Its own code rather than `423 vault_locked`: the vault is open, and an unlock dialog would have
    nothing to do. The client answers this by proving — a passphrase or a passkey — and retrying.
    """
    return HTTPException(status_code=403, detail={
        "code":    "proof_required",
        "message": str(exc) or "Confirm your passphrase or passkey to change how this vault is opened",
    })


@router.post("/vault/set-passphrase", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_set_passphrase(body: VaultPassphraseRequest, request: Request):
    # Set (or replace) this user's vault passphrase. The first passphrase in the workspace mints the
    # DEK; re-setting your own re-seals it (requires being unlocked). For anyone else this is an
    # *enrollment* — the slot is written and waits for a member to grant it, which the response reports
    # as `vault_access_pending` rather than as a failure.
    user = _require_current_user(request)
    try:
        crypto_service.set_passphrase(user["id"], body.passphrase)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "The vault could not be opened")
    # Before the ValueError arm below, which it subclasses — reversed, the typed body would never be sent.
    except crypto_service.WeakPassphrase as exc:
        raise _weak_passphrase_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.get("/vault/credentials-backups")
def vault_credentials_backups(request: Request):
    """Credentials backups written against the wrapping the vault has *now* — the ones a passphrase
    change is about to strand, newest first.

    Only these, never the full export history: a backup taken under a previous passphrase was already
    stranded by an earlier change, and repeating that is noise at the moment a user is being asked to
    weigh a decision. An empty list is not "no backups exist" — it is "none that this change would
    break, as far as anything recorded knows" — which is why the dialog keeps a general caution for
    files that predate this record.
    """
    user = _require_current_user(request)
    fingerprint = crypto_service.current_wrapped_dek_fingerprint(user["id"])
    exports = credentials_exports_for_fingerprint(fingerprint) if fingerprint else []
    return {"backups": [{"exported_at": e["exported_at"]} for e in exports]}


@router.post("/vault/change-passphrase", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_change_passphrase(body: VaultChangePassphraseRequest, request: Request):
    user = _require_current_user(request)
    _begin_attempt(_VAULT, user["id"])
    try:
        crypto_service.change_passphrase(user["id"], body.old_passphrase, body.new_passphrase)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "No vault passphrase is set")
    except crypto_service.IncorrectSecret as exc:
        raise _wrong_secret(_VAULT, user["id"], HTTPException(status_code=400, detail=str(exc)))
    except crypto_service.WeakPassphrase as exc:
        raise _weak_passphrase_error(exc)
    except ValueError as exc:
        # An empty new passphrase.
        raise HTTPException(status_code=400, detail=str(exc))
    attempt_limiter.succeeded(_VAULT, user["id"])
    return {"user": _session_payload(user)}


@router.post("/vault/unlock", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_unlock(body: VaultPassphraseRequest, request: Request):
    user = _require_current_user(request)
    _begin_attempt(_VAULT, user["id"])
    try:
        crypto_service.unlock(user["id"], body.passphrase)
    except crypto_service.VaultAccessPending as exc:
        # The passphrase was right; there is simply nothing granted to it yet.
        attempt_limiter.succeeded(_VAULT, user["id"])
        raise _access_pending_error(exc)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "No vault passphrase is set")
    except crypto_service.IncorrectSecret as exc:
        raise _wrong_secret(_VAULT, user["id"], HTTPException(status_code=400, detail=str(exc)))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    attempt_limiter.succeeded(_VAULT, user["id"])
    return {"user": _session_payload(user)}


@router.post("/vault/lock")
def vault_lock(request: Request):
    user = _require_current_user(request)
    crypto_service.lock(user["id"])
    return {"user": _session_payload(user)}


@router.post("/vault/developer/mark-passphrases-unchecked")
def vault_mark_passphrases_unchecked(request: Request):
    """Developer options: mark every member's passphrase as not yet checked under the current strength
    rule and lock every session (`crypto_service.mark_passphrases_unchecked`). Every member's, so
    administrator-only."""
    if not app_config.developer_options_enabled():
        raise HTTPException(status_code=404, detail="Developer options are not enabled")
    require_admin_or_local(request)
    user = _require_current_user(request)
    marked = crypto_service.mark_passphrases_unchecked()
    return {"marked": marked, "user": _session_payload(user)}


# --- Recovery: the rung between "ask another member" and "destroy it" -----------------------------
#
# On a multi-user workspace a forgotten passphrase was already survivable — another member re-enrols the
# stuck user and no credential moves. A single-user install had nothing between that and the destructive
# reset below, which is the gap a recovery code closes.

RESET_CONFIRM_PHRASE = "RESET VAULT"


@router.post("/vault/recovery-code", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_issue_recovery_code(request: Request):
    """Mint a recovery code, replacing any current one, and return it **once**.

    The only response that ever carries the code in the clear: it is stretched into a KEK and stored as a
    slot, never as anything the server can read back, so a user who loses it regenerates rather than
    retrieves. Requires the vault unlocked, like enrollment and rotation, because the code has to carry
    the DEK and only an unlocked member holds it.
    """
    user = _require_current_user(request)
    try:
        code = crypto_service.issue_recovery_code(user["id"])
    except crypto_service.ProofRequired as exc:
        raise _proof_required_error(exc)
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code":    "vault_locked",
            "message": "Unlock the vault to issue a recovery code.",
        })
    return {"recovery_code": code, "user": _session_payload(user)}


@router.post("/vault/recover", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_recover(body: VaultRecoverRequest, request: Request):
    """Open the vault with a recovery code and set a new passphrase, in one step.

    One request rather than unlock-then-change so there is no window in which the code has been consumed
    and no replacement passphrase exists yet — the failure that would otherwise leave a user with neither.
    The DEK is unchanged, so nothing is re-encrypted and **no connection needs re-linking**; a fresh code
    comes back, so forgetting the replacement is not a return to the dead end.
    """
    user = _require_current_user(request)
    _begin_attempt(_VAULT, user["id"])
    try:
        code = crypto_service.recover_with_code(user["id"], body.code, body.new_passphrase)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail={
            "code":    "no_recovery_code",
            "message": str(exc) or "No recovery code has been issued for this vault.",
        })
    # Before the ValueError arm it subclasses, exactly as in `set-passphrase` — reversed, the typed body
    # carrying the two numbers the dialog gates on would never be sent.
    except crypto_service.WeakPassphrase as exc:
        raise _weak_passphrase_error(exc)
    except crypto_service.IncorrectSecret:
        # Deliberately not echoed back with its internal wording ("incorrect passphrase"), which would
        # send the user looking for the wrong field.
        raise _wrong_secret(_VAULT, user["id"], HTTPException(status_code=400, detail={
            "code":    "bad_recovery_code",
            "message": "That recovery code was not recognized.",
        }))
    except ValueError as exc:
        # An empty new passphrase.
        raise HTTPException(status_code=400, detail=str(exc))
    attempt_limiter.succeeded(_VAULT, user["id"])
    return {"recovery_code": code, "user": _session_payload(user)}


# --- The destructive reset ------------------------------------------------------------------------

@router.post("/vault/passkey/set-passphrase", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_passkey_set_passphrase(body: VaultPasskeyPassphraseRequest, request: Request):
    """Prove with a passkey and set a new passphrase, in one step.

    The passkey sibling of `/vault/recover`, and the answer to a gap the ladder had: a passkey opened
    the vault but could not replace the passphrase, so a passkey holder who had forgotten theirs had to
    lock themselves out on purpose to reach a recovery code. It also serves a passkey-only member
    setting a *first* passphrase, which `set-passphrase` no longer does.

    The DEK is unchanged, so nothing is re-encrypted and **no connection needs re-linking**.
    """
    user = _require_current_user(request)
    try:
        owner_id = crypto_service.set_passphrase_with_passkey(
            body.credential_id, body.prf_output, body.new_passphrase,
        )
    except crypto_service.VaultAccessPending as exc:
        raise _access_pending_error(exc)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "That passkey is not registered")
    # Before the ValueError arm it subclasses, exactly as in `set-passphrase`.
    except crypto_service.WeakPassphrase as exc:
        raise _weak_passphrase_error(exc)
    except ValueError:
        # A wrong PRF output is the only ValueError `_open_slot` raises here, and its internal wording
        # ("incorrect passphrase") would send the user looking at the wrong thing entirely.
        raise HTTPException(status_code=400, detail={
            "code":    "bad_passkey",
            "message": "That passkey did not open the vault.",
        })
    if owner_id != user["id"]:
        # Same rule as the passkey unlock: the credential opened someone else's slot, and a signed-in
        # user must not end up operating the vault as a different identity.
        crypto_service.lock(owner_id)
        raise HTTPException(status_code=403, detail="That passkey belongs to a different user")
    return {"user": _session_payload(user)}


@router.post("/vault/reenrol", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_reenrol(body: VaultReenrolRequest, request: Request):
    """Ask to be let back in: replace an unopenable passphrase slot with a pending one.

    The rung for a member whose access is intact but whose secret is gone. Nothing here can seal the
    DEK — nothing here can reach it — so the new slot opens nothing until an unlocked member approves
    it, at which point the DEK is unchanged and no data source is reconnected.
    """
    user = _require_current_user(request)
    try:
        crypto_service.request_reenrolment(user["id"], body.new_passphrase)
    except crypto_service.VaultLocked as exc:
        # Nobody else could ever grant it, so this would be a self-brick rather than a request.
        raise HTTPException(status_code=409, detail={
            "code":    "no_one_can_grant",
            "message": str(exc),
        })
    except crypto_service.WeakPassphrase as exc:
        raise _weak_passphrase_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.get("/vault/reset-preview")
def vault_reset_preview(request: Request):
    """Everything the reset dialog must say *before* the user commits, gathered in one call.

    Assembled server-side because it is one decision: what it costs, and — first — the free alternatives
    that mean it should not happen at all. A client stitching this together from four endpoints could
    render the warning while still waiting on the rung that makes it unnecessary.
    """
    user = _require_current_user(request)
    with get_db() as conn:
        connections = conn.execute("SELECT COUNT(*) FROM connection").fetchone()[0]
    return {
        "connections": connections,
        # The ladder's rungs, in the order the dialog must offer them. Each is a reason *not* to reset —
        # a reason, not a bar: the reset proceeds if the user says none of them apply.
        #
        # Named rather than counted. "Somebody else can open this vault" is not something a user can act
        # on; "frances can" is, and the whole content of this rung is who to go and ask.
        "other_members_can_unlock": [
            {"user_id": m["user_id"], "display_name": m["display_name"]}
            for m in crypto_service.vault_members() if m["user_id"] != user["id"]
        ],
        # The caller's *own* other ways in, which are the rung above asking anyone else at all — and the
        # one most easily forgotten, since somebody reaching this dialog is thinking about the passphrase.
        "own_passkeys": [p for p in crypto_service.user_passkey_slots(user["id"]) if not p["pending"]],
        "has_recovery_code": crypto_service.has_recovery_code(user["id"]),
        # Not limited to the current passphrase: a backup taken under a *previous* one is precisely the one
        # that still opens, which is the opposite of what the passphrase-change warning wants.
        "credentials_backups": crypto_service.credentials_backups_by_passphrase(),
        "confirm_phrase": RESET_CONFIRM_PHRASE,
    }


@router.post("/vault/reset")
def vault_reset(body: VaultResetRequest, request: Request):
    """Destroy the vault and every credential sealed under it. Irreversible.

    **Admin-gated**, unlike unlocking or granting: those need the DEK and are therefore self-limiting,
    while this destroys shared workspace state and is exactly the control the model's "admin gates
    settings, not data" rule is about. Transactions, accounts, mappings and coverage are untouched —
    only the two encrypted columns are lost, and the connection rows that carry the expensive state
    survive so a re-link lands back on them.

    The compromise path revokes first, while the vault is still open, and reports per connection rather
    than aborting: the credentials are being cleared regardless, so a provider that refuses leaves the
    user with something to finish, not a reason to stop.

    **Another member holding a slot does not block this.** It is a redirect the dialog leads with, by
    name, and a consequence reported back (`also_locked_out`) — not a refusal. See the note above
    `reset_vault` for why the block was removed.
    """
    user = require_admin_or_local(request)
    if body.confirm.strip().upper() != RESET_CONFIRM_PHRASE:
        raise HTTPException(status_code=400, detail={
            "code":    "confirmation_required",
            "message": f"Type {RESET_CONFIRM_PHRASE} to confirm.",
        })
    if body.reason not in ("lost", "compromised"):
        raise HTTPException(status_code=400, detail="Say whether the passphrase was lost or compromised")

    revocations: list[dict] = []
    app_secrets: list[dict] = []
    if body.reason == "compromised":
        # Refused rather than degraded to the lost path. This path exists *so that* the revocations can
        # run, and running it locked would retire every credential without attempting the one thing the
        # user came here for — while reporting success.
        if not crypto_service.is_unlocked(user["id"]):
            raise HTTPException(status_code=423, detail={
                "code":    "vault_locked",
                "message": "Unlock the vault first so each credential can be revoked at its provider "
                           "before it is destroyed.",
            })
        revocations = revoke_all_credentials(user)
        app_secrets = app_secrets_to_rotate()

    # Who else this is about to lock out, captured before the slots are deleted — afterwards there is no
    # way to say whose access was destroyed, and it is the one consequence the caller cannot see coming
    # from their own screen.
    others = [m["display_name"] for m in crypto_service.vault_members() if m["user_id"] != user["id"]]
    try:
        result = crypto_service.reset_vault(user["id"], reason=body.reason)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {
        **result,
        "revocations": revocations,
        "unfinished": unfinished(revocations),
        "app_secrets_to_rotate": app_secrets,
        "also_locked_out": others,
        "user": _session_payload(user),
    }


@router.post("/vault/reissue-credentials")
def vault_reissue_credentials(request: Request):
    """Respond to an exposed database without destroying anything: replace every connection's credential
    where its provider can, and report what is left for the user to do at each provider.

    Not admin-gated — it is the authority of connecting or syncing, and it cannot grant anyone anything: the
    connections keep working and only a copied credential stops. It needs the vault open, both to read each
    credential and to seal its replacement. See `services/exposure_response.py`.
    """
    user = _require_current_user(request)
    locked = HTTPException(status_code=423, detail={
        "code":    "vault_locked",
        "message": "Unlock the vault so each credential can be replaced at its provider.",
    })
    if not crypto_service.is_unlocked(user["id"]):
        raise locked
    try:
        outcomes = reissue_all_credentials(user)
    except crypto_service.VaultLocked:
        # The vault locked part-way. Whatever was already reissued is stored, and running this again
        # simply reissues those once more.
        raise locked
    except SyncInProgress as exc:
        raise HTTPException(status_code=409, detail={"code": "sync_running", "message": str(exc)})
    # For the backup task (`routers/tasks.py` → `_backup_due_task`), only when something was replaced.
    if any(o["outcome"] == REISSUED for o in outcomes):
        record_credentials_reissued()
    return {
        "outcomes": outcomes,
        "app_secrets_to_rotate": app_secrets_to_rotate(),
        # A credentials backup made before now restores the credentials just retired, so the connections
        # it brings back would fail at their next sync. Worth a new one, and the result screen says so.
        "has_credentials_backups": bool(credentials_exports_any()),
    }


def _access_pending_error(exc: Exception) -> HTTPException:
    """A correct secret against a slot nobody has approved yet.

    Coded rather than folded into the generic locked/refused arms because it is the one vault failure a
    user cannot act on alone, and the two neighbouring stories both send them somewhere useless — "wrong
    passphrase" invites retyping something that was never wrong, and "vault locked" invites unlocking a
    slot that has nothing in it."""
    return HTTPException(status_code=409, detail={
        "code":    "vault_access_pending",
        "message": str(exc) or "Vault access has not been approved yet.",
    })


# --- Vault access: enrollment, grant, revoke, rotate ----------------------------------------------
#
# Granting is deliberately **not** admin-gated: it is the same authority as connecting or syncing a data
# source (any member with the vault open), and gating it on admin would mean a household's only unlocked
# member could be unable to let anyone else in. Admin still governs *accounts*; this governs credentials.

@router.get("/vault/access-requests")
def vault_access_requests(request: Request):
    """Who is waiting for vault access. Readable by any signed-in user — it names people already in the
    workspace and carries no key material — so the UI can show a waiting user their own request as well
    as show a member the queue."""
    _require_current_user(request)
    return {"requests": crypto_service.pending_access_requests()}


@router.get("/vault/members")
def vault_members(request: Request):
    """Who can open the vault. Readable by any signed-in user, like the request queue: it names people
    already in the workspace and carries no key material, and "who holds the credentials" is a question
    a household member is entitled to an answer to."""
    _require_current_user(request)
    return {"members": crypto_service.vault_members()}


@router.post("/vault/access-requests/{slot_id}/approve")
def vault_approve_access(slot_id: str, request: Request):
    user = _require_current_user(request)
    try:
        granted = crypto_service.grant_access(user["id"], slot_id)
    except crypto_service.ProofRequired as exc:
        raise _proof_required_error(exc)
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code":    "vault_locked",
            "message": "Unlock the vault to approve access for someone else.",
        })
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"granted": granted, "requests": crypto_service.pending_access_requests()}


@router.post("/vault/access/{user_id}/revoke")
def vault_revoke_access(user_id: str, request: Request):
    """Remove someone's vault access. Admin-gated, unlike granting: this is the removal half of user
    management, and it is the one direction that can be performed against a person who is not present.
    Perimeter-off installs fall through the usual `require_admin_or_local` seam — with no sign-in there
    is no admin boundary to enforce, since anyone can already select any identity."""
    admin = require_admin_or_local(request)
    if admin.get("id") == user_id:
        # Revoking your own last slot is the "remove my only unlock method" footgun wearing another
        # label, and there is no recovery path behind it.
        raise HTTPException(status_code=400, detail="Use Vault settings to manage your own unlock methods")
    crypto_service.revoke_access(user_id)
    return {"ok": True}


@router.post("/vault/rotate")
def vault_rotate(request: Request):
    """Replace the workspace key and re-encrypt every stored credential under it.

    Not admin-gated, for the same reason approving is not: it needs the DEK, and only an unlocked member
    has it. What it *does* need is for revocations to have happened first — rotation re-seals for the
    slots that remain, so removing access and then rotating is the order that ends a departed member's
    reach."""
    user = _require_current_user(request)
    try:
        result = crypto_service.rotate_dek(user["id"])
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code":    "vault_locked",
            "message": "Unlock the vault to replace its key.",
        })
    except crypto_service.VaultDecryptError:
        raise HTTPException(status_code=409, detail={
            "code":    "vault_rotation_blocked",
            "message": "A stored credential could not be read with the current key, so it cannot be "
                       "re-encrypted. Reconnect the affected connection, then try again.",
        })
    # Every credentials backup made before now is under the key just retired, so its credentials will
    # not be restored (`crypto_service.UNTRUSTED_RETIREMENTS`); the result panel says a new one is needed.
    return {"result": result, "user": _session_payload(user),
            "has_credentials_backups": bool(credentials_exports_any())}


# --- Passkey slots (WebAuthn PRF) -----------------------------------------------------------------
#
# The browser runs the ceremony; the backend only ever sees the PRF output, which it treats exactly as
# it treats a passphrase (see `crypto_service` for why no assertion is verified). What the backend does
# own is the two preconditions the browser can only report as opaque failures (`transport.passkey_context`).

@router.get("/vault/passkey/params")
def vault_passkey_params(request: Request):
    """Everything the browser needs to run a registration or unlock ceremony.

    The registration salt is minted per call and echoed back by the client on register, rather than
    stored ahead of time: a salt only becomes meaningful once a credential exists to pair it with, and a
    ceremony the user abandons should leave nothing behind.
    """
    user = _require_current_user(request)
    context = transport.passkey_context(request)
    # Labelled as the vault's, because a device shows one passkey list per host and sign-in keeps its own
    # passkeys there too; see `app_passkey.passkey_account_names`. The handle stays the account id: it is
    # what every existing vault passkey was registered under, and sign-in is the one that moved off it.
    user_name, display_name = app_passkey.passkey_account_names(user, "vault")
    return {
        **context,
        "user_handle":   user["id"],
        "user_name":     user_name,
        "display_name":  display_name,
        "register_salt": crypto_service.new_passkey_salt(),
        # Registered credentials, so `get()` can scope itself and the UI can list what exists.
        "credentials":   crypto_service.passkey_credentials(user["id"]),
    }


@router.post("/vault/passkey/register", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_passkey_register(body: VaultPasskeyRegisterRequest, request: Request):
    user = _require_current_user(request)
    context = transport.passkey_context(request)
    if not context["available"]:
        raise HTTPException(status_code=400, detail="Passkeys need an HTTPS connection to a named host")
    try:
        result = crypto_service.register_passkey_slot(
            user["id"], credential_id=body.credential_id, prf_output=body.prf_output,
            prf_salt=body.prf_salt, rp_id=context["rp_id"], label=body.label,
        )
    except crypto_service.ProofRequired as exc:
        raise _proof_required_error(exc)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked", "message": str(exc) or "Unlock the vault first",
        })
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"passkey": result, "user": _session_payload(user)}


@router.post("/vault/passkey/unlock", dependencies=[Depends(transport.require_protected_vault_link)])
def vault_passkey_unlock(body: VaultPasskeyUnlockRequest, request: Request):
    user = _require_current_user(request)
    try:
        owner_id, _ = crypto_service.unlock_with_passkey(
            body.credential_id, body.prf_output, rp_id=transport.passkey_context(request)["rp_id"],
        )
    except crypto_service.VaultAccessPending as exc:
        raise _access_pending_error(exc)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "That passkey is not registered")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if owner_id != user["id"]:
        # The credential opened a slot belonging to someone else. Its DEK was cached against its owner,
        # so nothing leaks to this session — but a signed-in user must not end up operating the vault as
        # a different identity, so this is refused rather than quietly honoured.
        crypto_service.lock(owner_id)
        raise HTTPException(status_code=403, detail="That passkey belongs to a different user")
    return {"user": _session_payload(user)}


@router.delete("/vault/passkey/{slot_id}")
def vault_passkey_remove(slot_id: str, request: Request):
    user = _require_current_user(request)
    try:
        crypto_service.remove_slot(user["id"], slot_id)
    except crypto_service.ProofRequired as exc:
        raise _proof_required_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.delete("/vault/recovery-code")
def vault_discard_recovery_code(request: Request):
    """Delete the recovery code without minting a replacement.

    The counterpart to the `POST` that issues one, which always *replaces* — so invalidating a code that
    was written down could only be expressed as replace-and-forget, leaving `vault_has_recovery_code`
    true and the recovery ladder offering a rung the user deliberately does not have.
    """
    user = _require_current_user(request)
    try:
        crypto_service.discard_recovery_code(user["id"])
    except crypto_service.ProofRequired as exc:
        raise _proof_required_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.get("/users")
def users(request: Request):
    require_admin(request)
    sole = crypto_service.sole_vault_member_id()
    return {"users": [{**u, "sole_vault_member": u["id"] == sole} for u in list_users()]}


@router.post("/users")
def add_user(body: UserCreateRequest, request: Request):
    admin = require_admin(request)
    try:
        user = create_user(
            body.username,
            body.password,
            body.display_name,
            body.role,
            tenant_id=admin["tenant_id"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.patch("/users/{user_id}")
def edit_user(user_id: str, body: UserUpdateRequest, request: Request):
    admin = require_admin(request)
    if admin["id"] == user_id:
        # Do not let the currently signed-in admin remove their own ability to finish
        # the session; role/status changes require a second admin for recoverability.
        current = get_user_by_id(user_id)
        if not current:
            raise HTTPException(status_code=404, detail="User not found")
        if body.role is not None and body.role != current.get("role"):
            raise HTTPException(status_code=400, detail="Use another admin account to change your own role")
        if body.status is not None and body.status != current.get("status"):
            raise HTTPException(status_code=400, detail="Use another admin account to change your own status")
    try:
        user = update_user(
            user_id,
            username=body.username,
            display_name=body.display_name,
            password=body.password,
            role=body.role,
            status=body.status,
            must_change_password=body.must_change_password,
            # A password change signs the account out everywhere; an admin changing their own keeps the
            # session they changed it from.
            keep_sign_in_session=sign_in_sessions.digest_of(request.session) if admin["id"] == user_id else None,
        )
    except ValueError as exc:
        detail = str(exc)
        if detail == "user not found":
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)
    return {"user": _session_payload(user)}


@router.delete("/users/{user_id}")
def remove_user(user_id: str, request: Request):
    admin = require_admin(request)
    if admin["id"] == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete the account you are currently signed into")
    try:
        # Deleting the last vault member resets the vault (`crypto_service.remove_vault_member`).
        crypto_service.remove_vault_member(user_id, lambda: _delete_person(user_id))
    except ValueError as exc:
        detail = str(exc)
        if detail == "user not found":
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)
    return {"ok": True}
