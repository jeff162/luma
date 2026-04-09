# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Runtime environment setup and validation.

This module backs the frontend's first-run setup flow by treating `.env` as part
of the application's persisted state: it can generate safe defaults, detect when
a restart is still required, and separate bootstrap-critical secrets from ordinary
environment settings like Plaid credentials.
"""

import os
import secrets
import shutil
from base64 import b64encode
from pathlib import Path

from dotenv import dotenv_values, set_key


DEFAULT_SESSION_SECRET = "dev-session-secret-change-me"
PLACEHOLDER_SESSION_SECRET = "change_me_to_a_long_random_value"


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def env_file_path() -> Path:
    return project_root() / ".env"


def env_example_path() -> Path:
    return project_root() / ".env_example"


def default_session_cookie_name() -> str:
    base = "".join(ch.lower() if ch.isalnum() else "_" for ch in project_root().name).strip("_")
    return f"{base or 'fintrack'}_session"


def _invalid_session_secret(value: str | None) -> bool:
    normalized = (value or "").strip()
    return normalized in {DEFAULT_SESSION_SECRET, PLACEHOLDER_SESSION_SECRET, ""}


def generate_session_secret() -> str:
    return secrets.token_urlsafe(48)


def generate_app_master_key() -> str:
    return b64encode(secrets.token_bytes(32)).decode("ascii")


def runtime_config_defaults() -> dict:
    return {
        "session_secret": generate_session_secret(),
        "app_master_key": generate_app_master_key(),
        "session_cookie_name": default_session_cookie_name(),
    }


def runtime_config_status() -> dict:
    env_path = env_file_path()
    configured_secret = os.getenv("SESSION_SECRET", DEFAULT_SESSION_SECRET).strip()
    env_exists = env_path.exists()
    env_values = dotenv_values(str(env_path)) if env_exists else {}
    env_secret = (env_values.get("SESSION_SECRET") or "").strip()
    # The backend can already see a valid secret written to `.env` while still running
    # with the old placeholder in memory, which is why setup needs an explicit restart state.
    pending_restart = _invalid_session_secret(configured_secret) and not _invalid_session_secret(env_secret)

    if _invalid_session_secret(configured_secret):
        return {
            "ok": False,
            "code": "session_secret_not_configured",
            "title": "Finish environment setup",
            "message": (
                "FinTrack needs a unique SESSION_SECRET before this instance should be used. "
                + (
                    "Restart the backend to load the new settings from .env."
                    if pending_restart else
                    ("Create the .env file from .env.example and set SESSION_SECRET." if not env_exists else "Update SESSION_SECRET in .env to a long random value.")
                )
            ),
            "env_file_present": env_exists,
            "env_file_path": str(env_path),
            "pending_restart": pending_restart,
        }

    return {
        "ok": True,
        "env_file_present": env_exists,
        "env_file_path": str(env_path),
        "pending_restart": False,
    }


def write_runtime_env(
    *,
    session_secret: str | None,
    app_master_key: str | None = None,
    session_cookie_name: str | None = None,
) -> dict:
    env_path = env_file_path()
    if not env_path.exists():
        # First-run setup prefers copying the example file so any non-secret defaults and
        # documentation comments survive instead of starting from an empty `.env`.
        example_path = env_example_path()
        if example_path.exists():
            shutil.copyfile(example_path, env_path)
        else:
            env_path.write_text("", encoding="utf-8")

    existing = dotenv_values(str(env_path))

    existing_session_secret = (existing.get("SESSION_SECRET") or "").strip()
    final_session_secret = (session_secret or "").strip() or existing_session_secret or generate_session_secret()
    if _invalid_session_secret(final_session_secret):
        raise ValueError("SESSION_SECRET must not be blank or use the example placeholder")

    existing_app_master_key = (existing.get("APP_MASTER_KEY") or "").strip()
    final_app_master_key = (app_master_key or "").strip() or existing_app_master_key or generate_app_master_key()

    existing_session_cookie_name = (existing.get("SESSION_COOKIE_NAME") or "").strip()
    final_session_cookie_name = (
        (session_cookie_name or "").strip()
        or existing_session_cookie_name
        or default_session_cookie_name()
    )

    set_key(str(env_path), "SESSION_SECRET", final_session_secret)
    set_key(str(env_path), "APP_MASTER_KEY", final_app_master_key)
    set_key(str(env_path), "SESSION_COOKIE_NAME", final_session_cookie_name)

    return {
        "ok": True,
        "env_file_path": str(env_path),
        "restart_required": True,
    }


def _ensure_env_file_exists() -> Path:
    env_path = env_file_path()
    if not env_path.exists():
        example_path = env_example_path()
        if example_path.exists():
            shutil.copyfile(example_path, env_path)
        else:
            env_path.write_text("", encoding="utf-8")
    return env_path


def _truthy_env(value: str | None, default: bool = False) -> bool:
    normalized = (value or "").strip().lower()
    if not normalized:
        return default
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def read_environment_settings() -> dict:
    env_path = env_file_path()
    values = dotenv_values(str(env_path)) if env_path.exists() else {}

    plaid_client_id = (values.get("PLAID_CLIENT_ID") or os.getenv("PLAID_CLIENT_ID") or "").strip()
    plaid_secret = (values.get("PLAID_SECRET") or os.getenv("PLAID_SECRET") or "").strip()
    plaid_env = (values.get("PLAID_ENV") or os.getenv("PLAID_ENV") or "sandbox").strip() or "sandbox"
    log_value = values.get("FINTRACK_USE_LOG_FILES")
    if log_value is None:
        log_value = os.getenv("FINTRACK_USE_LOG_FILES")

    return {
        "plaid_client_id": plaid_client_id,
        "plaid_secret": plaid_secret,
        "plaid_env": plaid_env,
        "fintrack_use_log_files": _truthy_env(log_value, default=False),
        "env_file_present": env_path.exists(),
        "env_file_path": str(env_path),
    }


def write_environment_settings(
    *,
    plaid_client_id: str | None,
    plaid_secret: str | None,
    plaid_env: str | None,
    fintrack_use_log_files: bool | None,
) -> dict:
    env_path = _ensure_env_file_exists()

    if plaid_env is not None:
        normalized_plaid_env = plaid_env.strip() or "sandbox"
        if normalized_plaid_env not in {"sandbox", "development", "production"}:
            raise ValueError("PLAID_ENV must be sandbox, development, or production")
    else:
        normalized_plaid_env = None

    if plaid_client_id is not None:
        set_key(str(env_path), "PLAID_CLIENT_ID", plaid_client_id.strip())
    if plaid_secret is not None:
        set_key(str(env_path), "PLAID_SECRET", plaid_secret.strip())
    if normalized_plaid_env is not None:
        set_key(str(env_path), "PLAID_ENV", normalized_plaid_env)
    if fintrack_use_log_files is not None:
        set_key(str(env_path), "FINTRACK_USE_LOG_FILES", "true" if fintrack_use_log_files else "false")

    return {
        "settings": read_environment_settings(),
        "restart_required": True,
    }
