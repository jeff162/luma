# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

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
    enable_auth_mode,
    auth_required,
    create_local_preference_profile,
    clear_all_local_preference_profiles,
    delete_local_preference_profile,
    consume_recovery_code,
    create_user,
    create_initial_user,
    disable_totp,
    delete_user,
    enable_totp,
    get_local_preference_profile,
    get_password_policy,
    get_local_mode_user,
    get_security_profile,
    get_user_by_id,
    list_local_preference_profiles,
    list_users,
    password_policy_label,
    recovery_code_count,
    security_profile_guidance,
    security_profile_label,
    replace_recovery_codes,
    set_security_profile,
    set_password_policy,
    update_local_preference_profile,
    update_user,
    update_user_secret_material,
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
from backend.services.crypto_service import reencrypt_plaid_items


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


class TotpVerifyRequest(BaseModel):
    code: str


class TotpConfirmRequest(TotpVerifyRequest):
    secret: str


class PrivacyModeRequest(BaseModel):
    privacy_mode: str


class EnableAuthRequest(BaseModel):
    enabled: bool = True


class RuntimeConfigRequest(BaseModel):
    session_secret: str | None = None
    app_master_key: str | None = None
    session_cookie_name: str | None = None


class EnvironmentSettingsRequest(BaseModel):
    plaid_client_id: str | None = None
    plaid_secret: str | None = None
    plaid_env: str | None = None
    fintrack_use_log_files: bool | None = None


class PasswordPolicyRequest(BaseModel):
    policy: str


class SecurityProfileRequest(BaseModel):
    profile: str


class UserPreferenceRequest(BaseModel):
    key: str
    value: object


class LocalPreferenceProfileCreateRequest(BaseModel):
    name: str


class LocalPreferenceProfileUpdateRequest(BaseModel):
    name: str


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
        raise HTTPException(status_code=400, detail="Local preference profiles are only available in local access mode")


def _require_local_preference_profile(request: Request):
    _require_local_mode()
    profile_id = (request.headers.get("X-Fintrack-Preference-Profile") or "").strip()
    if not profile_id:
        raise HTTPException(status_code=400, detail="Preference profile is required")
    profile = get_local_preference_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Preference profile not found")
    return profile


def _session_payload(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user.get("display_name") or user["username"],
        "role": user.get("role", "member"),
        "privacy_mode": user.get("privacy_mode", "off"),
        "two_factor_enabled": bool(user.get("totp_enabled")),
        "recovery_code_count": recovery_code_count(user["id"]),
        "tenant_id": user["tenant_id"],
        "tenant_name": user.get("tenant_name"),
    }


def _auth_status_payload(request: Request | None = None) -> dict:
    # App startup consumes one payload to choose bootstrap/auth gates and the active
    # preference identity, so status has to fold together runtime config, auth mode,
    # and the current session/profile in a single round trip.
    enabled = auth_required()
    password_policy = get_password_policy()
    security_profile = get_security_profile()
    security_guidance = security_profile_guidance(security_profile)
    with get_db() as conn:
        db_instance_id = get_db_instance_id(conn)
    experimental_security_settings = _truthy_env(
        os.getenv("FINTRACK_EXPERIMENTAL_SECURITY_SETTINGS"),
        default=False,
    )
    developer_options_enabled = _truthy_env(
        os.getenv("FINTRACK_DEVELOPER_OPTIONS"),
        default=False,
    )
    payload = {
        "auth_enabled": enabled,
        "needs_bootstrap": enabled and bootstrap_required(),
        "runtime_config": runtime_config_status(),
        "password_policy": password_policy,
        "password_policy_label": password_policy_label(password_policy),
        "security_profile": security_profile,
        "security_profile_label": security_profile_label(security_profile),
        "security_profile_summary": security_guidance["summary"],
        "security_profile_recommended_auth": security_guidance["recommended_auth"],
        "security_profile_suggested_password_policy": security_guidance["suggested_password_policy"],
        "experimental_security_settings": experimental_security_settings,
        "developer_options_enabled": developer_options_enabled,
        "db_instance_id": db_instance_id,
    }
    if request and enabled:
        user_id = request.session.get("user_id")
        if user_id:
            user = get_user_by_id(user_id)
            if user:
                payload["user"] = _session_payload(user)
    elif not enabled:
        user = get_local_mode_user()
        if user:
            payload["user"] = _session_payload(user)
        if request:
            profile_id = (request.headers.get("X-Fintrack-Preference-Profile") or "").strip()
            if profile_id:
                profile = get_local_preference_profile(profile_id)
                if profile:
                    payload["preference_profile"] = {
                        "id": profile["id"],
                        "name": profile["name"],
                    }
    return payload


@router.get("/bootstrap-status")
def bootstrap_status():
    return _auth_status_payload()


@router.get("/status")
def auth_status(request: Request):
    return _auth_status_payload(request)


# Preferences are scoped to the authenticated user (auth mode) or the local-preference-profile
# (local mode). The id of that scope is the `scope_id` used in the data DB's ui_preference table.
def _resolve_preference_scope(request: Request) -> tuple[str, bool]:
    if auth_required():
        return _require_current_user(request)["id"], True
    return _require_local_preference_profile(request)["id"], False


@router.get("/preferences")
def auth_preferences(request: Request):
    scope_id, _ = _resolve_preference_scope(request)
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
    scope_id, _ = _resolve_preference_scope(request)
    set_preference(scope_id, key, json.dumps(body.value))
    return {"ok": True}


@router.delete("/preferences")
def clear_auth_preferences(request: Request):
    scope_id, _ = _resolve_preference_scope(request)
    clear_preferences(scope_id)
    return {"ok": True}


@router.get("/local-preference-profiles")
def local_preference_profiles():
    _require_local_mode()
    return {"profiles": list_local_preference_profiles()}


@router.post("/local-preference-profiles")
def create_local_profile(body: LocalPreferenceProfileCreateRequest):
    _require_local_mode()
    try:
        profile = create_local_preference_profile(body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"profile": profile}


@router.post("/demo-data")
def load_demo_data_endpoint():
    """Populate an empty local tenant with the explorable demo dataset, ensuring a preference profile
    exists so the app leaves onboarding. No-op if the tenant already has data; local-mode only (so it
    can never run against a real authenticated account)."""
    _require_local_mode()
    profiles = list_local_preference_profiles()
    if not profiles:
        profiles = [create_local_preference_profile("Demo")]
    with get_db() as conn:
        return load_demo_data(conn, scope_id=profiles[0]["id"])


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


@router.patch("/local-preference-profiles/{profile_id}")
def update_local_profile(profile_id: str, body: LocalPreferenceProfileUpdateRequest):
    _require_local_mode()
    try:
        profile = update_local_preference_profile(profile_id, body.name)
    except ValueError as exc:
        detail = str(exc)
        if detail == "Preference profile not found":
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)
    return {"profile": profile}


@router.delete("/local-preference-profiles/{profile_id}")
def delete_local_profile(profile_id: str):
    _require_local_mode()
    try:
        delete_local_preference_profile(profile_id)
    except ValueError as exc:
        detail = str(exc)
        if detail == "Preference profile not found":
            raise HTTPException(status_code=404, detail=detail)
        raise HTTPException(status_code=400, detail=detail)
    return {"ok": True}


@router.delete("/local-preference-profiles")
def clear_local_profiles(request: Request):
    if not _truthy_env(
        os.getenv("FINTRACK_DEVELOPER_OPTIONS"),
        default=False,
    ):
        raise HTTPException(status_code=404, detail="Developer options are not enabled")
    _require_local_mode()
    clear_all_local_preference_profiles()
    return {"ok": True}


@router.post("/runtime-config")
def configure_runtime_config(body: RuntimeConfigRequest):
    if runtime_config_status()["ok"]:
        raise HTTPException(status_code=403, detail="Runtime config is already initialized")
    try:
        result = write_runtime_env(
            session_secret=body.session_secret,
            app_master_key=body.app_master_key,
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
    try:
        return write_environment_settings(
            plaid_client_id=body.plaid_client_id,
            plaid_secret=body.plaid_secret,
            plaid_env=body.plaid_env,
            fintrack_use_log_files=body.fintrack_use_log_files,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


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


@router.post("/enable")
def enable_auth(body: EnableAuthRequest):
    _ensure_runtime_config_ok()
    if not body.enabled:
        raise HTTPException(status_code=400, detail="Disabling auth is not supported here")
    if auth_required():
        return _auth_status_payload()
    enable_auth_mode()
    return _auth_status_payload()


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
        local_user = get_local_mode_user()
        user = authenticate_user(body.username, body.password)
        if not local_user or not user or user["id"] != local_user["id"]:
            raise HTTPException(status_code=401, detail="Invalid username or password")
        request.session.clear()
        return {"user": _session_payload(user)}
    user = authenticate_user(body.username, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    request.session.clear()
    if user.get("totp_enabled"):
        request.session["pending_user_id"] = user["id"]
        return {"requires_2fa": True, "recovery_code_count": recovery_code_count(user["id"])}
    request.session["user_id"] = user["id"]
    return {"user": _session_payload(user)}


@router.post("/logout")
def logout(request: Request):
    session = request.scope.get("session")
    if session is not None:
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
    if not auth_required():
        user = get_local_mode_user()
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return {"user": _session_payload(user)}
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = get_user_by_id(user_id)
    if not user:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"user": _session_payload(user)}


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


@router.post("/privacy-mode")
def set_privacy_mode(body: PrivacyModeRequest, request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    privacy_mode = (body.privacy_mode or "").strip()
    if privacy_mode not in ("off", "server_managed"):
        raise HTTPException(status_code=400, detail="Unsupported privacy mode")

    with get_db() as conn:
        reencrypt_plaid_items(conn, user, enable_privacy=(privacy_mode == "server_managed"))

    update_user_secret_material(
        user["id"],
        privacy_mode=privacy_mode,
        key_mode="server_managed",
    )
    updated = get_user_by_id(user["id"])
    request.state.user = updated
    return {"user": _session_payload(updated)}


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
