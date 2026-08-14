# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
This router serves one frontend in two modes:
- auth-enabled installs use control-db users and sessions
- local mode still exposes a user-shaped API, but preferences can be split into
  named local profiles instead of real accounts
"""

import json
import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.runtime_config import (
    read_environment_settings,
    runtime_config_defaults,
    runtime_config_status,
    write_environment_settings,
    write_runtime_env,
)
from backend.db.control_database import (
    authenticate_user,
    begin_totp_setup,
    bootstrap_required,
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
    get_data_provider_intended,
    get_https_warning_suppressed,
    get_login_account,
    get_password_policy,
    get_security_profile,
    set_https_warning_suppressed,
    get_user_by_id,
    enable_auth_with_admin,
    set_data_provider_intended,
    list_users,
    password_policy_label,
    recovery_code_count,
    security_profile_guidance,
    security_profile_label,
    replace_recovery_codes,
    set_security_profile,
    set_password_policy,
    update_user,
    verify_totp_code,
)
from backend.services.preferences import (
    clear_preferences,
    get_preferences,
    set_preference,
)
from backend.db.database import get_db, get_db_instance_id, ensure_shared_owner, _seed_default_categories
from backend.db.demo_data import load_demo_data, is_demo_data_loaded, is_demo_loadable
from backend.routers.import_export.backup import _wipe_user_data_tables
from backend.services import crypto_service
from backend import transport


router = APIRouter()


def _truthy_env(value: str | None, default: bool = False) -> bool:
    normalized = (value or "").strip().lower()
    if not normalized:
        return default
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


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


class TotpConfirmRequest(TotpVerifyRequest):
    secret: str


class VaultPassphraseRequest(BaseModel):
    passphrase: str


class VaultChangePassphraseRequest(BaseModel):
    old_passphrase: str
    new_passphrase: str


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


class RuntimeConfigRequest(BaseModel):
    session_secret: str | None = None
    session_cookie_name: str | None = None


class EnvironmentSettingsRequest(BaseModel):
    # Provider (Plaid) credentials moved to the vaulted per-provider config (see routers/providers.py,
    # security phase 6b); this endpoint now carries only the remaining `.env`-backed toggles.
    luma_use_log_files: bool | None = None


class PasswordPolicyRequest(BaseModel):
    policy: str


class SecurityProfileRequest(BaseModel):
    profile: str


class DataProviderIntentRequest(BaseModel):
    intended: bool


class HttpsWarningSuppressRequest(BaseModel):
    suppressed: bool


class UserPreferenceRequest(BaseModel):
    key: str
    value: object


class IdentityCreateRequest(BaseModel):
    name: str


class SelectIdentityRequest(BaseModel):
    user_id: str


def _require_admin(request: Request):
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _ensure_runtime_config_ok():
    status = runtime_config_status()
    if not status["ok"]:
        raise HTTPException(status_code=503, detail=status["message"])
    return status


def _require_admin_or_local(request: Request):
    if not auth_required():
        # Environment settings are global app config, not tenant data, so local
        # mode does not need a control-db user record just to read/write them.
        user = getattr(request.state, "user", None)
        return user or {"role": "admin", "local_mode": True}
    return _require_admin(request)


def _require_current_user(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


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
        # The floor the dialog gates its own submit button on. Served rather than duplicated in the
        # client because the two must agree exactly: a client holding its own copy either blocks a
        # passphrase the server would take or offers one it refuses, and both read as a broken vault.
        "vault_passphrase_min_length": crypto_service.VAULT_PRODUCTION_MIN_LEN,
        "vault_passphrase_min_distinct": crypto_service.VAULT_PRODUCTION_MIN_DISTINCT,
        "must_change_password": bool(user.get("must_change_password")),
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
    security_profile = get_security_profile()
    security_guidance = security_profile_guidance(security_profile)
    with get_db() as conn:
        db_instance_id = get_db_instance_id(conn)
    experimental_security_settings = _truthy_env(
        os.getenv("LUMA_EXPERIMENTAL_SECURITY_SETTINGS"),
        default=False,
    )
    developer_options_enabled = _truthy_env(
        os.getenv("LUMA_DEVELOPER_OPTIONS"),
        default=False,
    )
    payload = {
        "auth_enabled": enabled,
        "needs_bootstrap": enabled and bootstrap_required(),
        "runtime_config": runtime_config_status(),
        "password_policy": password_policy,
        "password_policy_label": password_policy_label(password_policy),
        "security_profile": security_profile,
        "data_provider_intended": get_data_provider_intended(),
        "security_profile_label": security_profile_label(security_profile),
        "security_profile_summary": security_guidance["summary"],
        "security_profile_recommended_auth": security_guidance["recommended_auth"],
        "security_profile_suggested_password_policy": security_guidance["suggested_password_policy"],
        "experimental_security_settings": experimental_security_settings,
        "developer_options_enabled": developer_options_enabled,
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
        # Detected transport facts (topology + HTTPS) are per-request, not stored presets. The frontend
        # uses these to steer HTTPS guidance and gate connect-time actions on real HTTPS availability.
        provider_intended = payload["data_provider_intended"]
        payload["transport"] = {
            "is_loopback": transport.request_is_loopback(request),
            "scheme": transport.request_scheme(request),
            "is_https": transport.request_is_https(request),
            "https_expected": transport.https_expected(
                request, perimeter_on=enabled, provider_intended=provider_intended
            ),
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


def _identity_view(user: dict) -> dict:
    return {"id": user["id"], "display_name": user.get("display_name") or user["username"]}


@router.get("/identities")
def list_identities():
    # Perimeter-off identity chooser: names only, reachable before a session exists (there are no
    # secrets to protect while sign-in is off). In auth mode identities are managed through the admin
    # user endpoints instead, so this is local-mode only.
    _require_local_mode()
    return {"identities": [_identity_view(u) for u in list_users()]}


@router.post("/identities")
def create_identity(body: IdentityCreateRequest):
    _require_local_mode()
    try:
        user = create_local_identity(body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"identity": _identity_view(user)}


@router.post("/select-identity")
def select_identity(body: SelectIdentityRequest, request: Request):
    # Establish a perimeter-off session: pick an identity, no password checked. Marked `pwless` so
    # that enabling sign-in protection later invalidates it (see the middleware and _auth_status_payload).
    _require_local_mode()
    user = get_user_by_id(body.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Identity not found")
    request.session.clear()
    request.session["user_id"] = user["id"]
    request.session["pwless"] = True
    return {"user": _session_payload(user)}


@router.patch("/identities/{user_id}")
def rename_identity(user_id: str, body: IdentityCreateRequest):
    _require_local_mode()
    try:
        user = update_user(user_id, username=body.name, display_name=body.name)
    except ValueError as exc:
        detail = str(exc)
        raise HTTPException(status_code=404 if detail == "user not found" else 400, detail=detail)
    return {"identity": _identity_view(user)}


@router.delete("/identities/{user_id}")
def delete_identity(user_id: str):
    _require_local_mode()
    try:
        delete_user(user_id)
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
    (empty tenant) drives the "Load demo data" offer on the Import/Export page so the demo is reachable
    after a skip or a clear, not only from first-run onboarding. Local-mode only."""
    _require_local_mode()
    with get_db() as conn:
        return {"loaded": is_demo_data_loaded(conn), "loadable": is_demo_loadable(conn)}


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
    return {"ok": True}


@router.post("/runtime-config")
def configure_runtime_config(body: RuntimeConfigRequest):
    if runtime_config_status()["ok"]:
        raise HTTPException(status_code=403, detail="Runtime config is already initialized")
    try:
        result = write_runtime_env(
            session_secret=body.session_secret,
            session_cookie_name=body.session_cookie_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


@router.get("/runtime-config/defaults")
def get_runtime_config_defaults():
    if runtime_config_status()["ok"]:
        raise HTTPException(status_code=403, detail="Runtime config is already initialized")
    return runtime_config_defaults()


@router.get("/environment")
def get_environment_settings(request: Request):
    _require_admin_or_local(request)
    return read_environment_settings()


@router.post("/environment")
def save_environment_settings(body: EnvironmentSettingsRequest, request: Request):
    _require_admin_or_local(request)
    # Provider credentials + the Production vault gate moved to the per-provider Configure card
    # (POST /api/providers/{provider}/config); this endpoint now carries only the `.env`-backed toggles.
    try:
        result = write_environment_settings(
            luma_use_log_files=body.luma_use_log_files,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


@router.post("/password-policy")
def save_password_policy(body: PasswordPolicyRequest, request: Request):
    _require_admin_or_local(request)
    try:
        set_password_policy(body.policy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    policy = get_password_policy()
    return {
        "password_policy": policy,
        "password_policy_label": password_policy_label(policy),
    }


@router.post("/security-profile")
def save_security_profile(body: SecurityProfileRequest, request: Request):
    _require_admin_or_local(request)
    try:
        set_security_profile(body.profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    profile = get_security_profile()
    guidance = security_profile_guidance(profile)
    return {
        "security_profile": profile,
        "security_profile_label": security_profile_label(profile),
        "security_profile_summary": guidance["summary"],
        "security_profile_recommended_auth": guidance["recommended_auth"],
        "security_profile_suggested_password_policy": guidance["suggested_password_policy"],
    }


@router.post("/data-provider-intent")
def save_data_provider_intent(body: DataProviderIntentRequest, request: Request):
    _require_admin_or_local(request)
    set_data_provider_intended(bool(body.intended))
    return {"data_provider_intended": get_data_provider_intended()}


@router.post("/https-warning-suppress")
def suppress_https_warning(body: HttpsWarningSuppressRequest, request: Request):
    # Only the *recommended* (plain client-server, no provider) HTTPS nag is suppressible — the
    # required (provider configured) case ignores this and self-clears only over real HTTPS.
    _require_admin_or_local(request)
    set_https_warning_suppressed(bool(body.suppressed))
    return {"https_warning_suppressed": get_https_warning_suppressed()}


@router.post("/enable")
def enable_auth(body: EnableAuthRequest, request: Request):
    _ensure_runtime_config_ok()
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
        request.session.clear()
        request.session["user_id"] = admin["id"]
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
    _ensure_runtime_config_ok()
    if not auth_required():
        return _auth_status_payload(request)
    _require_admin(request)
    disable_auth_mode()
    session = request.scope.get("session")
    if session is not None and session.get("user_id"):
        session["pwless"] = True
    return _auth_status_payload(request)


@router.post("/bootstrap")
def bootstrap(body: BootstrapRequest, request: Request):
    _ensure_runtime_config_ok()
    if not auth_required():
        raise HTTPException(status_code=400, detail="Auth is not enabled for this instance")
    try:
        user = create_initial_user(body.username, body.password, body.display_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    request.session.clear()
    request.session["user_id"] = user["id"]
    return {"user": _session_payload(user)}


@router.post("/login")
def login(body: LoginRequest, request: Request):
    _ensure_runtime_config_ok()
    if not auth_required():
        # Perimeter off: there is no password login — identities are chosen via /auth/select-identity.
        raise HTTPException(status_code=400, detail="Sign-in protection is off; choose an identity instead")

    # Auth mode. A password-set account verifies normally; an unset (sentinel) account is claimable —
    # login accepts it without a password *only* when it is flagged must_change_password, then routes
    # straight into the forced password-set. Either way a must_change_password account cannot complete
    # login until it sets a new password.
    account = get_login_account(body.username)
    if not account or account["status"] != "active":
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if account["password_set"]:
        user = authenticate_user(body.username, body.password)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid username or password")
    else:
        if not account["must_change_password"]:
            raise HTTPException(status_code=401, detail="Invalid username or password")
        user = get_user_by_id(account["id"])

    request.session.clear()
    if user.get("must_change_password"):
        request.session["pending_password_change_user_id"] = user["id"]
        return {"requires_password_change": True}
    if user.get("totp_enabled"):
        request.session["pending_user_id"] = user["id"]
        return {"requires_2fa": True, "recovery_code_count": recovery_code_count(user["id"])}
    request.session["user_id"] = user["id"]
    return {"user": _session_payload(user)}


@router.post("/change-password")
def change_password(body: PasswordChangeRequest, request: Request):
    # Completes a forced password change begun at login (must_change_password / claim). The pending user
    # is held in the session between the two calls; setting a valid password clears the flag and either
    # continues to 2FA or completes sign-in.
    _ensure_runtime_config_ok()
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
    request.session["user_id"] = updated["id"]
    return {"user": _session_payload(updated)}


@router.post("/logout")
def logout(request: Request):
    session = request.scope.get("session")
    if session is not None:
        # Drop any unlocked vault DEK for this identity so logging out re-locks the vault.
        user_id = session.get("user_id")
        if user_id:
            crypto_service.lock(user_id)
        session.clear()
    return {"ok": True}


@router.post("/2fa/verify")
def verify_2fa(body: TotpVerifyRequest, request: Request):
    _ensure_runtime_config_ok()
    if not auth_required():
        raise HTTPException(status_code=400, detail="Auth is not enabled for this instance")
    pending_user_id = request.session.get("pending_user_id")
    if not pending_user_id:
        raise HTTPException(status_code=400, detail="No pending two-factor challenge")
    user = get_user_by_id(pending_user_id)
    if not user or not user.get("totp_enabled") or not user.get("totp_secret"):
        request.session.clear()
        raise HTTPException(status_code=400, detail="Two-factor authentication is not configured")
    if not (
        verify_totp_code(user["totp_secret"], body.code)
        or consume_recovery_code(user["id"], body.code)
    ):
        raise HTTPException(status_code=401, detail="Invalid authentication code")

    request.session.clear()
    request.session["user_id"] = user["id"]
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


@router.post("/2fa/disable")
def turn_off_2fa(body: TotpVerifyRequest, request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not user.get("totp_enabled") or not user.get("totp_secret"):
        raise HTTPException(status_code=400, detail="Two-factor authentication is not enabled")
    if not verify_totp_code(user["totp_secret"], body.code):
        raise HTTPException(status_code=401, detail="Invalid authentication code")
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
    if not verify_totp_code(user["totp_secret"], body.code):
        raise HTTPException(status_code=401, detail="Invalid authentication code")
    recovery_codes = replace_recovery_codes(user["id"])
    updated = get_user_by_id(user["id"])
    request.state.user = updated
    return {"user": _session_payload(updated), "recovery_codes": recovery_codes}


def _weak_passphrase_error(exc: crypto_service.WeakPassphrase) -> HTTPException:
    """The floor stated as data, not only as prose.

    The dialog disables its submit button on the same two numbers, so it has to be able to read them
    rather than parse them back out of a sentence — and a client that fell out of step with the server
    would either block a passphrase the server accepts or offer one it refuses, both of which look like a
    bug in the vault. `code` is what the UI keys on; the message is for anything that only shows text."""
    return HTTPException(status_code=400, detail={
        "code": "weak_passphrase",
        "message": str(exc),
        "min_length": crypto_service.VAULT_PRODUCTION_MIN_LEN,
        "min_distinct": crypto_service.VAULT_PRODUCTION_MIN_DISTINCT,
    })


@router.post("/vault/set-passphrase")
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


@router.post("/vault/change-passphrase")
def vault_change_passphrase(body: VaultChangePassphraseRequest, request: Request):
    user = _require_current_user(request)
    try:
        crypto_service.change_passphrase(user["id"], body.old_passphrase, body.new_passphrase)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "No vault passphrase is set")
    except crypto_service.WeakPassphrase as exc:
        raise _weak_passphrase_error(exc)
    except ValueError as exc:
        # Wrong old passphrase, or an empty new one.
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.post("/vault/unlock")
def vault_unlock(body: VaultPassphraseRequest, request: Request):
    user = _require_current_user(request)
    try:
        crypto_service.unlock(user["id"], body.passphrase)
    except crypto_service.VaultAccessPending as exc:
        raise _access_pending_error(exc)
    except crypto_service.VaultLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc) or "No vault passphrase is set")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.post("/vault/lock")
def vault_lock(request: Request):
    user = _require_current_user(request)
    crypto_service.lock(user["id"])
    return {"user": _session_payload(user)}


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
    Perimeter-off installs fall through the usual `_require_admin_or_local` seam — with no sign-in there
    is no admin boundary to enforce, since anyone can already select any identity."""
    admin = _require_admin_or_local(request)
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
                       "re-encrypted. Reconnect the affected data source, then try again.",
        })
    return {"result": result, "user": _session_payload(user)}


# --- Passkey slots (WebAuthn PRF) -----------------------------------------------------------------
#
# The browser runs the ceremony; the backend only ever sees the PRF output, which it treats exactly as
# it treats a passphrase (see `crypto_service` for why no assertion is verified). What the backend does
# own is the two preconditions the browser can only report as opaque failures.

def _passkey_context(request: Request) -> dict:
    """The Relying Party id a ceremony must run under, or why one cannot run here.

    Two constraints, both outside the app's control. WebAuthn requires a **secure context**, so a
    cleartext network bind cannot register or use a passkey at all. And an RP id must be a *domain* —
    a bare IP address is not one, so a LAN server reached as `192.168.x.x` can never host passkeys
    however it is served. Both are reported as stated reasons rather than left to surface as an
    unexplained browser exception, because in both cases the answer is "use a passphrase here".
    """
    host = (request.url.hostname or "").strip("[]")
    # A hostname made only of digits and dots, or containing a colon, is an address rather than a name.
    is_address = bool(host) and (":" in host or all(part.isdigit() for part in host.split(".") if part))
    # The address check comes first because the two reasons differ in whether anything can be done: an
    # address can never host passkeys however it is served, while cleartext is fixed by configuring
    # HTTPS. Reporting the fixable one on a host where the fix would not help sends the user to set up
    # TLS and arrive back at the same refusal.
    if is_address:
        return {"available": False, "reason": "ip_address_host", "rp_id": None}
    if not (transport.request_is_https(request) or transport.request_is_loopback(request)):
        return {"available": False, "reason": "insecure_context", "rp_id": None}
    return {"available": True, "reason": None, "rp_id": host}


@router.get("/vault/passkey/params")
def vault_passkey_params(request: Request):
    """Everything the browser needs to run a registration or unlock ceremony.

    The registration salt is minted per call and echoed back by the client on register, rather than
    stored ahead of time: a salt only becomes meaningful once a credential exists to pair it with, and a
    ceremony the user abandons should leave nothing behind.
    """
    user = _require_current_user(request)
    context = _passkey_context(request)
    return {
        **context,
        "user_handle":   user["id"],
        "user_name":     user["username"],
        "display_name":  user.get("display_name") or user["username"],
        "register_salt": crypto_service.new_passkey_salt(),
        # Registered credentials, so `get()` can scope itself and the UI can list what exists.
        "credentials":   crypto_service.passkey_credentials(user["id"]),
    }


@router.post("/vault/passkey/register")
def vault_passkey_register(body: VaultPasskeyRegisterRequest, request: Request):
    user = _require_current_user(request)
    if not _passkey_context(request)["available"]:
        raise HTTPException(status_code=400, detail="Passkeys need an HTTPS connection to a named host")
    try:
        result = crypto_service.register_passkey_slot(
            user["id"], credential_id=body.credential_id, prf_output=body.prf_output,
            prf_salt=body.prf_salt, label=body.label,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"passkey": result, "user": _session_payload(user)}


@router.post("/vault/passkey/unlock")
def vault_passkey_unlock(body: VaultPasskeyUnlockRequest, request: Request):
    user = _require_current_user(request)
    try:
        owner_id, _ = crypto_service.unlock_with_passkey(body.credential_id, body.prf_output)
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
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}


@router.get("/users")
def users(request: Request):
    _require_admin(request)
    return {"users": list_users()}


@router.post("/users")
def add_user(body: UserCreateRequest, request: Request):
    admin = _require_admin(request)
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
    admin = _require_admin(request)
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
        )
    except ValueError as exc:
        detail = str(exc)
        if detail == "user not found":
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)
    return {"user": _session_payload(user)}


@router.delete("/users/{user_id}")
def remove_user(user_id: str, request: Request):
    admin = _require_admin(request)
    if admin["id"] == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete the account you are currently signed into")
    try:
        delete_user(user_id)
    except ValueError as exc:
        detail = str(exc)
        if detail == "user not found":
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)
    return {"ok": True}
