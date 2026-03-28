from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from runtime_config import (
    read_environment_settings,
    runtime_config_defaults,
    runtime_config_status,
    write_environment_settings,
    write_runtime_env,
)
from db.control_database import (
    authenticate_user,
    begin_totp_setup,
    bootstrap_required,
    enable_auth_mode,
    auth_required,
    consume_recovery_code,
    create_user,
    create_initial_user,
    disable_totp,
    enable_totp,
    get_password_policy,
    get_local_mode_user,
    get_user_by_id,
    list_users,
    password_policy_label,
    recovery_code_count,
    replace_recovery_codes,
    set_password_policy,
    update_user_secret_material,
    verify_totp_code,
)
from db.database import get_db
from services.crypto_service import reencrypt_plaid_items


router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


class BootstrapRequest(LoginRequest):
    display_name: str | None = None


class UserCreateRequest(BootstrapRequest):
    role: str = "member"


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
    enabled = auth_required()
    password_policy = get_password_policy()
    payload = {
        "auth_enabled": enabled,
        "needs_bootstrap": enabled and bootstrap_required(),
        "runtime_config": runtime_config_status(),
        "password_policy": password_policy,
        "password_policy_label": password_policy_label(password_policy),
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
    return payload


@router.get("/bootstrap-status")
def bootstrap_status():
    return _auth_status_payload()


@router.get("/status")
def auth_status(request: Request):
    return _auth_status_payload(request)


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
    _require_admin(request)
    try:
        user = create_user(body.username, body.password, body.display_name, body.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": _session_payload(user)}
