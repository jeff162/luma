# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Control database for auth, tenant routing, security settings, and user-scoped state.

Unlike the app database, this file manages cross-tenant concerns: who can sign in,
which tenant DB a request should use, when auth becomes mandatory, and which local
preference profiles or secret material belong to each user.
"""

import base64
import hashlib
import hmac
import os
import re
import sqlite3
import struct
import time
import urllib.parse
import uuid

import segno
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import DB_PATH, get_db, init_db
from backend.runtime_config import APP_NAME


CONTROL_DB_PATH = str(Path(os.getenv("CONTROL_DB_PATH", "luma-control.db")))
TENANT_DATA_ROOT = Path(os.getenv("TENANT_DATA_ROOT", "data"))
PASSWORD_ITERATIONS = 600_000
TOTP_PERIOD = 30
RECOVERY_CODE_COUNT = 8
PASSWORD_POLICY_NONE = "none"
PASSWORD_POLICY_MIN_8 = "min_8"
PASSWORD_POLICY_STRONG = "strong"
PASSWORD_POLICY_VALUES = {
    PASSWORD_POLICY_NONE,
    PASSWORD_POLICY_MIN_8,
    PASSWORD_POLICY_STRONG,
}
# Two deployment shapes: standalone (this one machine, loopback) vs client-server (backend on a
# networked box, reached from other devices' browsers). The profile is a setup preset that steers
# recommendations (whether sign-in is recommended, and — later — the HTTP/HTTPS transport policy); it
# does not by itself enforce auth. The old `household_shared` and `multi_tenant` profiles are retired.
SECURITY_PROFILE_LOCAL_PRIVATE = "local_private"
SECURITY_PROFILE_NETWORK_PRIVATE = "network_private"
SECURITY_PROFILE_VALUES = {
    SECURITY_PROFILE_LOCAL_PRIVATE,
    SECURITY_PROFILE_NETWORK_PRIVATE,
}


def _tenant_slug(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned or "tenant"


def _unique_tenant_slug(conn, base_slug: str) -> str:
    slug = base_slug
    suffix = 2
    while conn.execute("SELECT 1 FROM tenant WHERE slug = ?", (slug,)).fetchone():
        slug = f"{base_slug}-{suffix}"
        suffix += 1
    return slug


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, password_hash: str) -> bool:
    try:
        algo, iterations, salt_b64, digest_b64 = password_hash.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64.encode("ascii"))
        expected = base64.b64decode(digest_b64.encode("ascii"))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


# An account with no usable password (e.g. a profile migrated into an account that the operator left
# blank) stores this sentinel instead of a hash. It is deliberately *not* a valid `pbkdf2_sha256$...`
# string, so `verify_password` can never match it — nothing anyone types authenticates against an
# unset account. Such an account is only reachable through the "claim" path (login recognizes the
# unset state and routes to a forced password-set), which is gated on `must_change_password`.
UNSET_PASSWORD_SENTINEL = "unset"


def password_is_set(password_hash: str | None) -> bool:
    return bool(password_hash) and password_hash != UNSET_PASSWORD_SENTINEL


def _hash_recovery_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> list[str]:
    codes = []
    for _ in range(count):
        raw = os.urandom(5).hex().upper()
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def _totp_normalize_secret(secret: str) -> bytes:
    padded = secret.upper().replace(" ", "")
    missing_padding = len(padded) % 8
    if missing_padding:
        padded += "=" * (8 - missing_padding)
    return base64.b32decode(padded.encode("ascii"))


def generate_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")


def _totp_code(secret: str, for_time: int | None = None) -> str:
    if for_time is None:
        for_time = int(time.time())
    counter = int(for_time // TOTP_PERIOD)
    key = _totp_normalize_secret(secret)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(binary % 1_000_000).zfill(6)


def verify_totp_code(secret: str, code: str, window: int = 1) -> bool:
    normalized = "".join(ch for ch in code if ch.isdigit())
    if len(normalized) != 6:
        return False
    now = int(time.time())
    for offset in range(-window, window + 1):
        if hmac.compare_digest(_totp_code(secret, now + offset * TOTP_PERIOD), normalized):
            return True
    return False


def build_totp_uri(username: str, secret: str, issuer: str = APP_NAME) -> str:
    label = urllib.parse.quote(f"{issuer}:{username}")
    issuer_q = urllib.parse.quote(issuer)
    return f"otpauth://totp/{label}?secret={secret}&issuer={issuer_q}&algorithm=SHA1&digits=6&period={TOTP_PERIOD}"


@contextmanager
def get_control_db():
    Path(CONTROL_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(CONTROL_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_control_db():
    with get_control_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_setting (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS tenant (
                id         TEXT PRIMARY KEY,
                slug       TEXT NOT NULL UNIQUE,
                name       TEXT NOT NULL,
                db_path    TEXT NOT NULL UNIQUE,
                status     TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS user_account (
                id             TEXT PRIMARY KEY,
                username       TEXT NOT NULL UNIQUE,
                display_name   TEXT,
                password_hash  TEXT NOT NULL,
                tenant_id      TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
                status         TEXT NOT NULL DEFAULT 'active',
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                last_login_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS user_recovery_code (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
                code_hash  TEXT NOT NULL,
                used_at    TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS user_secret_material (
                user_id             TEXT PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
                privacy_mode        TEXT NOT NULL DEFAULT 'off',
                key_mode            TEXT NOT NULL DEFAULT 'server_managed',
                wrapped_user_key    TEXT,
                wrapping_kdf_salt   TEXT,
                wrapping_kdf_iters  INTEGER,
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS local_preference_profile (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Preferences moved to the data DB's `ui_preference` table (so backups carry them);
            -- the control DB now keeps only identity/secrets + local-profile definitions. Drop the
            -- now-unused control-DB preference copies. (The lazy-relocation bridge that emptied them
            -- into the data DB has been removed.)
            DROP TABLE IF EXISTS user_preference;
            DROP TABLE IF EXISTS local_preference_value;
            """
        )
        try:
            conn.execute(
                "ALTER TABLE user_account ADD COLUMN role TEXT NOT NULL DEFAULT 'member'"
            )
        except Exception:
            pass
        try:
            conn.execute(
                "ALTER TABLE user_account ADD COLUMN totp_secret TEXT"
            )
        except Exception:
            pass
        try:
            conn.execute(
                "ALTER TABLE user_account ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0"
            )
        except Exception:
            pass
        try:
            conn.execute(
                "ALTER TABLE user_account ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"
            )
        except Exception:
            pass

        admin_count = conn.execute(
            "SELECT COUNT(*) FROM user_account WHERE role = 'admin'"
        ).fetchone()[0]
        if admin_count == 0:
            first_user = conn.execute(
                "SELECT id FROM user_account ORDER BY created_at, id LIMIT 1"
            ).fetchone()
            if first_user:
                conn.execute(
                    "UPDATE user_account SET role = 'admin' WHERE id = ?",
                    (first_user["id"],),
                )
        user_ids = [row["id"] for row in conn.execute("SELECT id FROM user_account").fetchall()]
        for user_id in user_ids:
            conn.execute(
                "INSERT OR IGNORE INTO user_secret_material (user_id) VALUES (?)",
                (user_id,),
            )


def get_app_setting(key: str, default: str | None = None) -> str | None:
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT value FROM app_setting WHERE key = ?",
            (key,),
        ).fetchone()
    return row["value"] if row else default


def set_app_setting(key: str, value: str):
    with get_control_db() as conn:
        conn.execute(
            """
            INSERT INTO app_setting (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            """,
            (key, value),
        )


def list_local_preference_profiles() -> list[dict]:
    with get_control_db() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at FROM local_preference_profile ORDER BY name, created_at"
        ).fetchall()
    return [dict(row) for row in rows]


def get_local_preference_profile(profile_id: str) -> dict | None:
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT id, name, created_at FROM local_preference_profile WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return dict(row) if row else None


def create_local_preference_profile(name: str) -> dict:
    normalized = (name or "").strip()
    if not normalized:
        raise ValueError("Profile name is required")
    with get_control_db() as conn:
        existing = conn.execute(
            "SELECT id, name, created_at FROM local_preference_profile WHERE LOWER(name) = LOWER(?)",
            (normalized,),
        ).fetchone()
        if existing:
            return dict(existing)
        profile_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO local_preference_profile (id, name) VALUES (?, ?)",
            (profile_id, normalized),
        )
        row = conn.execute(
            "SELECT id, name, created_at FROM local_preference_profile WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return dict(row)


def update_local_preference_profile(profile_id: str, name: str) -> dict:
    normalized = (name or "").strip()
    if not normalized:
        raise ValueError("Profile name is required")
    with get_control_db() as conn:
        existing = conn.execute(
            "SELECT id FROM local_preference_profile WHERE id = ?",
            (profile_id,),
        ).fetchone()
        if not existing:
            raise ValueError("Preference profile not found")
        duplicate = conn.execute(
            "SELECT id FROM local_preference_profile WHERE LOWER(name) = LOWER(?) AND id != ?",
            (normalized, profile_id),
        ).fetchone()
        if duplicate:
            raise ValueError("A profile with that name already exists")
        conn.execute(
            "UPDATE local_preference_profile SET name = ? WHERE id = ?",
            (normalized, profile_id),
        )
        row = conn.execute(
            "SELECT id, name, created_at FROM local_preference_profile WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return dict(row)


def delete_local_preference_profile(profile_id: str):
    with get_control_db() as conn:
        existing = conn.execute(
            "SELECT id FROM local_preference_profile WHERE id = ?",
            (profile_id,),
        ).fetchone()
        if not existing:
            raise ValueError("Preference profile not found")
        conn.execute(
            "DELETE FROM local_preference_profile WHERE id = ?",
            (profile_id,),
        )


def clear_all_local_preference_profiles():
    with get_control_db() as conn:
        conn.execute("DELETE FROM local_preference_profile")


def get_password_policy() -> str:
    value = (get_app_setting("password_policy", PASSWORD_POLICY_MIN_8) or PASSWORD_POLICY_MIN_8).strip()
    return value if value in PASSWORD_POLICY_VALUES else PASSWORD_POLICY_MIN_8


def set_password_policy(policy: str):
    normalized = (policy or "").strip()
    if normalized not in PASSWORD_POLICY_VALUES:
        raise ValueError("Unsupported password policy")
    set_app_setting("password_policy", normalized)


def get_security_profile() -> str:
    value = (get_app_setting("security_profile", SECURITY_PROFILE_LOCAL_PRIVATE) or SECURITY_PROFILE_LOCAL_PRIVATE).strip()
    return value if value in SECURITY_PROFILE_VALUES else SECURITY_PROFILE_LOCAL_PRIVATE


def set_security_profile(profile: str):
    normalized = (profile or "").strip()
    if normalized not in SECURITY_PROFILE_VALUES:
        raise ValueError("Unsupported security profile")
    set_app_setting("security_profile", normalized)


# Declared intent to connect an aggregator/data provider, orthogonal to the deployment profile. It
# only *steers* setup guidance (and, later, the HTTPS-readiness task) — it does not enforce anything;
# the Connect-bank gate keys off actual HTTPS availability, not this flag.
def get_data_provider_intended() -> bool:
    return get_app_setting("data_provider_intended", "0") == "1"


def set_data_provider_intended(value: bool):
    set_app_setting("data_provider_intended", "1" if value else "0")


def security_profile_label(profile: str | None = None) -> str:
    normalized = profile or get_security_profile()
    if normalized == SECURITY_PROFILE_NETWORK_PRIVATE:
        return "Client-server"
    return "Standalone"


# `suggested_password_policy` is retained in the payload for the API contract but is no longer
# surfaced as a recommendation in the UI (we don't presume why a user wants a password).
def security_profile_guidance(profile: str | None = None) -> dict:
    normalized = profile or get_security_profile()
    if normalized == SECURITY_PROFILE_NETWORK_PRIVATE:
        return {
            "summary": f"The {APP_NAME} backend runs on a computer on your network, and you and anyone you allow reach it from a browser on another device.",
            "recommended_auth": True,
            "suggested_password_policy": PASSWORD_POLICY_MIN_8,
        }
    return {
        "summary": f"{APP_NAME} runs on this one computer and you use it right here. Nothing else connects to it.",
        "recommended_auth": False,
        "suggested_password_policy": PASSWORD_POLICY_NONE,
    }


def password_policy_label(policy: str | None = None) -> str:
    normalized = policy or get_password_policy()
    if normalized == PASSWORD_POLICY_NONE:
        return "No password restrictions"
    if normalized == PASSWORD_POLICY_STRONG:
        return "Strong password requirements"
    return "8 character minimum"


def validate_password_for_policy(password: str, policy: str | None = None):
    normalized = policy or get_password_policy()
    if normalized == PASSWORD_POLICY_NONE:
        if not password:
            raise ValueError("password is required")
        return
    if normalized == PASSWORD_POLICY_MIN_8:
        if len(password) < 8:
            raise ValueError("password must be at least 8 characters")
        return
    if len(password) < 16:
        raise ValueError("strong passwords must be at least 16 characters")
    checks = [
        re.search(r"[a-z]", password),
        re.search(r"[A-Z]", password),
        re.search(r"[0-9]", password),
        re.search(r"[^A-Za-z0-9]", password),
    ]
    if not all(checks):
        raise ValueError("strong passwords must include upper, lower, number, and symbol")


def user_count() -> int:
    with get_control_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM user_account").fetchone()[0]


def admin_count() -> int:
    with get_control_db() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM user_account WHERE role = 'admin' AND status = 'active'"
        ).fetchone()[0]


def bootstrap_required() -> bool:
    return user_count() == 0


def auth_required() -> bool:
    # More than one user implies shared access semantics even if an older install never
    # explicitly flipped the auth flag, so multi-user setups cannot silently run open.
    return get_app_setting("auth_enabled", "0") == "1" or user_count() > 1


def enable_auth_mode():
    set_app_setting("auth_enabled", "1")


def get_local_mode_user() -> dict | None:
    if auth_required():
        return None
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT id FROM user_account ORDER BY created_at, id LIMIT 1"
        ).fetchone()
    if not row:
        return None
    return get_user_by_id(row["id"])


def _legacy_db_path() -> str:
    return str(Path(DB_PATH))


def _tenant_db_filename() -> str:
    return Path(DB_PATH).name or "luma-data.db"


def _default_tenant_db_path(tenant_id: str) -> str:
    legacy_path = Path(_legacy_db_path())
    if legacy_path.exists():
        # Bootstrap can adopt the pre-auth single-user database in place so enabling auth
        # does not strand the user's existing data in an unused legacy file.
        return str(legacy_path)
    tenant_root = TENANT_DATA_ROOT / tenant_id
    tenant_root.mkdir(parents=True, exist_ok=True)
    return str(tenant_root / _tenant_db_filename())


def _create_user_with_tenant(
    username: str,
    password: str,
    display_name: str | None = None,
    role: str = "member",
    use_legacy_db_if_present: bool = False,
    tenant_id: str | None = None,
    must_change_password: bool = False,
) -> dict:
    if not username.strip():
        raise ValueError("username is required")
    # A blank password is only allowed when the account is created in a "must set a password on next
    # login" state (the profile-migration path). It stores the unset sentinel rather than a hash.
    password_provided = bool(password)
    if password_provided:
        validate_password_for_policy(password)
    elif not must_change_password:
        raise ValueError("password is required")
    password_hash = _hash_password(password) if password_provided else UNSET_PASSWORD_SENTINEL

    if role not in {"member", "admin"}:
        raise ValueError("role must be 'member' or 'admin'")

    clean_username = username.strip()
    user_display_name = display_name.strip() if display_name else clean_username

    with get_control_db() as conn:
        existing = conn.execute(
            "SELECT id FROM user_account WHERE lower(username) = lower(?)",
            (clean_username,),
        ).fetchone()
        if existing:
            raise ValueError("username already exists")

        resolved_tenant_id = tenant_id
        if resolved_tenant_id:
            tenant = conn.execute(
                "SELECT id, db_path FROM tenant WHERE id = ?",
                (resolved_tenant_id,),
            ).fetchone()
            if not tenant:
                raise ValueError("tenant not found")
        else:
            # Creating a user without an explicit tenant usually means bootstrap or the admin
            # is provisioning a new isolated workspace, so the tenant record and DB are created together.
            resolved_tenant_id = str(uuid.uuid4())
            tenant_name = user_display_name
            base_slug = _tenant_slug(clean_username)
            db_path = _default_tenant_db_path(resolved_tenant_id) if use_legacy_db_if_present else str(TENANT_DATA_ROOT / resolved_tenant_id / _tenant_db_filename())
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
            init_db(db_path)
            slug = _unique_tenant_slug(conn, base_slug)
            conn.execute(
                """
                INSERT INTO tenant (id, slug, name, db_path)
                VALUES (?, ?, ?, ?)
                """,
                (resolved_tenant_id, slug, tenant_name, db_path),
            )

        user_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO user_account (id, username, display_name, password_hash, tenant_id, role, must_change_password)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                clean_username,
                user_display_name,
                password_hash,
                resolved_tenant_id,
                role,
                1 if must_change_password else 0,
            ),
        )
        conn.execute(
            "INSERT INTO user_secret_material (user_id) VALUES (?)",
            (user_id,),
        )

    return get_user_by_id(user_id)


def create_initial_user(username: str, password: str, display_name: str | None = None) -> dict:
    if not bootstrap_required():
        raise ValueError("bootstrap already completed")
    return _create_user_with_tenant(
        username=username,
        password=password,
        display_name=display_name,
        role="admin",
        use_legacy_db_if_present=True,
    )


def get_user_by_id(user_id: str) -> dict | None:
    with get_control_db() as conn:
        row = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.display_name,
                u.role,
                u.totp_secret,
                COALESCE(u.totp_enabled, 0) AS totp_enabled,
                COALESCE(u.must_change_password, 0) AS must_change_password,
                u.status,
                u.tenant_id,
                t.name AS tenant_name,
                t.db_path,
                usm.privacy_mode,
                usm.key_mode,
                usm.wrapped_user_key
            FROM user_account u
            JOIN tenant t ON t.id = u.tenant_id
            LEFT JOIN user_secret_material usm ON usm.user_id = u.id
            WHERE u.id = ?
            """,
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def authenticate_user(username: str, password: str) -> dict | None:
    with get_control_db() as conn:
        row = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.display_name,
                u.password_hash,
                u.role,
                COALESCE(u.totp_enabled, 0) AS totp_enabled,
                COALESCE(u.must_change_password, 0) AS must_change_password,
                u.totp_secret,
                u.status,
                u.tenant_id,
                t.name AS tenant_name,
                t.db_path,
                usm.privacy_mode,
                usm.key_mode,
                usm.wrapped_user_key
            FROM user_account u
            JOIN tenant t ON t.id = u.tenant_id
            LEFT JOIN user_secret_material usm ON usm.user_id = u.id
            WHERE lower(u.username) = lower(?)
            """,
            (username.strip(),),
        ).fetchone()
        if not row or row["status"] != "active":
            return None
        if not verify_password(password, row["password_hash"]):
            return None
        conn.execute(
            "UPDATE user_account SET last_login_at = datetime('now') WHERE id = ?",
            (row["id"],),
        )
    user = dict(row)
    user.pop("password_hash", None)
    return user


def get_login_account(username: str) -> dict | None:
    # Lightweight lookup for the login flow: enough to branch verify-vs-claim and pick the next step,
    # without exposing the stored hash to callers. `password_set` is False for an unset (sentinel)
    # account, which — combined with `must_change_password` — is the only case login accepts without a
    # password (the claim path).
    with get_control_db() as conn:
        row = conn.execute(
            """
            SELECT id, status, password_hash,
                   COALESCE(totp_enabled, 0) AS totp_enabled,
                   COALESCE(must_change_password, 0) AS must_change_password
            FROM user_account WHERE lower(username) = lower(?)
            """,
            (username.strip(),),
        ).fetchone()
    if not row:
        return None
    account = dict(row)
    account["password_set"] = password_is_set(account.pop("password_hash"))
    return account


def list_users() -> list[dict]:
    with get_control_db() as conn:
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.display_name,
                u.role,
                COALESCE(u.totp_enabled, 0) AS totp_enabled,
                u.status,
                u.created_at,
                u.last_login_at,
                u.tenant_id,
                t.name AS tenant_name,
                usm.privacy_mode
            FROM user_account u
            JOIN tenant t ON t.id = u.tenant_id
            LEFT JOIN user_secret_material usm ON usm.user_id = u.id
            ORDER BY u.created_at, u.username
            """
        ).fetchall()
    return [dict(row) for row in rows]


def recovery_code_count(user_id: str) -> int:
    with get_control_db() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM user_recovery_code WHERE user_id = ? AND used_at IS NULL",
            (user_id,),
        ).fetchone()[0]


def get_user_secret_material(user_id: str) -> dict:
    with get_control_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO user_secret_material (user_id) VALUES (?)",
            (user_id,),
        )
        row = conn.execute(
            "SELECT * FROM user_secret_material WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    return dict(row)


def update_user_secret_material(
    user_id: str,
    *,
    privacy_mode: str | None = None,
    key_mode: str | None = None,
    wrapped_user_key: str | None = None,
):
    fields = []
    params = []
    if privacy_mode is not None:
        fields.append("privacy_mode = ?")
        params.append(privacy_mode)
    if key_mode is not None:
        fields.append("key_mode = ?")
        params.append(key_mode)
    if wrapped_user_key is not None:
        fields.append("wrapped_user_key = ?")
        params.append(wrapped_user_key)
    fields.append("updated_at = datetime('now')")
    with get_control_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO user_secret_material (user_id) VALUES (?)",
            (user_id,),
        )
        params.append(user_id)
        conn.execute(
            f"UPDATE user_secret_material SET {', '.join(fields)} WHERE user_id = ?",
            params,
        )


def create_user(
    username: str,
    password: str,
    display_name: str | None = None,
    role: str = "member",
    tenant_id: str | None = None,
) -> dict:
    return _create_user_with_tenant(
        username=username,
        password=password,
        display_name=display_name,
        role=role,
        use_legacy_db_if_present=False,
        tenant_id=tenant_id,
    )


def migrate_profiles_to_accounts(
    claim_profile_id: str,
    admin_password: str,
    initial_passwords: dict | None = None,
) -> dict:
    """Turn on sign-in protection by converting every local preference profile into a `user_account`,
    preserving each profile's UI preferences — instead of the old behavior of bootstrapping a fresh
    admin and orphaning the profiles.

    The operator claims one profile as the **admin** and sets a real password for it. Every other
    profile becomes an account the operator may leave password-unset; an unset account is claimable and
    forced to set a password on next login (`must_change_password`). Preference rows in the data DB are
    re-keyed from profile id to the new user id, the migrated profiles are deleted, and auth mode is
    enabled **last** (a single-profile migration yields one account, so `auth_required()` would stay off
    without the explicit flag). Everything is validated up front so a bad password never leaves a
    partially migrated workspace. Returns the new admin user.
    """
    if auth_required():
        raise ValueError("sign-in protection is already enabled")
    initial_passwords = initial_passwords or {}
    profiles = list_local_preference_profiles()
    if not profiles:
        raise ValueError("no local profiles to migrate")
    claim = next((p for p in profiles if p["id"] == claim_profile_id), None)
    if not claim:
        raise ValueError("claim profile not found")

    validate_password_for_policy(admin_password)
    others = [p for p in profiles if p["id"] != claim_profile_id]
    for profile in others:
        candidate = initial_passwords.get(profile["id"]) or ""
        if candidate:
            validate_password_for_policy(candidate)

    admin = _create_user_with_tenant(
        username=claim["name"],
        password=admin_password,
        display_name=claim["name"],
        role="admin",
        use_legacy_db_if_present=True,
    )
    mapping = {claim["id"]: admin["id"]}
    for profile in others:
        candidate = initial_passwords.get(profile["id"]) or ""
        member = _create_user_with_tenant(
            username=profile["name"],
            password=candidate,
            display_name=profile["name"],
            role="member",
            tenant_id=admin["tenant_id"],
            must_change_password=True,
        )
        mapping[profile["id"]] = member["id"]

    # Preferences live in the data DB keyed by scope_id (the profile id in local mode); re-key them to
    # the new user ids so each migrated user keeps their layout/view state. Open the tenant's data DB by
    # explicit path because auth_required() has already flipped true (2+ accounts) and there is no
    # request-scoped tenant routing inside this call.
    with get_db(db_path=admin["db_path"]) as data_conn:
        for old_id, new_id in mapping.items():
            data_conn.execute(
                "UPDATE ui_preference SET scope_id = ? WHERE scope_id = ?",
                (new_id, old_id),
            )
    for old_id in mapping:
        delete_local_preference_profile(old_id)

    enable_auth_mode()
    return admin


def update_user(
    user_id: str,
    *,
    username: str | None = None,
    display_name: str | None = None,
    password: str | None = None,
    role: str | None = None,
    status: str | None = None,
    must_change_password: bool | None = None,
) -> dict:
    current = get_user_by_id(user_id)
    if not current:
        raise ValueError("user not found")

    fields = []
    params = []

    with get_control_db() as conn:
        if username is not None:
            clean_username = username.strip()
            if not clean_username:
                raise ValueError("username is required")
            existing = conn.execute(
                "SELECT id FROM user_account WHERE lower(username) = lower(?) AND id != ?",
                (clean_username, user_id),
            ).fetchone()
            if existing:
                raise ValueError("username already exists")
            fields.append("username = ?")
            params.append(clean_username)

        if display_name is not None:
            clean_display_name = display_name.strip()
            if not clean_display_name:
                raise ValueError("display name is required")
            fields.append("display_name = ?")
            params.append(clean_display_name)

        # Password reset doubles as the migration/force-change primitive. A blank password stores the
        # unset sentinel (account becomes claimable) and implies must_change_password; a real password
        # is validated, hashed, and clears the flag unless the caller forces it (temp-password reset).
        if password is not None:
            if password == "":
                fields.append("password_hash = ?")
                params.append(UNSET_PASSWORD_SENTINEL)
                if must_change_password is None:
                    must_change_password = True
            else:
                validate_password_for_policy(password)
                fields.append("password_hash = ?")
                params.append(_hash_password(password))
                if must_change_password is None:
                    must_change_password = False

        if must_change_password is not None:
            fields.append("must_change_password = ?")
            params.append(1 if must_change_password else 0)

        if role is not None:
            normalized_role = role.strip()
            if normalized_role not in {"member", "admin"}:
                raise ValueError("role must be 'member' or 'admin'")
            if current["role"] == "admin" and normalized_role != "admin" and admin_count() <= 1:
                raise ValueError("at least one active admin is required")
            fields.append("role = ?")
            params.append(normalized_role)

        if status is not None:
            normalized_status = status.strip()
            if normalized_status not in {"active", "disabled"}:
                raise ValueError("status must be 'active' or 'disabled'")
            if (
                current["role"] == "admin"
                and current["status"] == "active"
                and normalized_status != "active"
                and admin_count() <= 1
            ):
                raise ValueError("at least one active admin is required")
            fields.append("status = ?")
            params.append(normalized_status)

        if not fields:
            return current

        params.append(user_id)
        conn.execute(
            f"UPDATE user_account SET {', '.join(fields)} WHERE id = ?",
            params,
        )

    return get_user_by_id(user_id)


def delete_user(user_id: str):
    current = get_user_by_id(user_id)
    if not current:
        raise ValueError("user not found")
    if current["role"] == "admin" and current["status"] == "active" and admin_count() <= 1:
        raise ValueError("at least one active admin is required")

    with get_control_db() as conn:
        conn.execute("DELETE FROM user_account WHERE id = ?", (user_id,))


def begin_totp_setup(user_id: str) -> dict:
    user = get_user_by_id(user_id)
    if not user:
        raise ValueError("user not found")
    secret = generate_totp_secret()
    otpauth_uri = build_totp_uri(user["username"], secret)
    # A scannable QR of the same provisioning URI, rendered server-side as an inline SVG data URI so
    # the frontend just drops it into an <img> (no client QR dependency; the secret is already in this
    # response either way). The manual key/URI remain for authenticators that can't scan.
    return {
        "secret": secret,
        "otpauth_uri": otpauth_uri,
        "qr_svg": segno.make(otpauth_uri).svg_data_uri(),
    }


def enable_totp(user_id: str, secret: str):
    with get_control_db() as conn:
        conn.execute(
            "UPDATE user_account SET totp_secret = ?, totp_enabled = 1 WHERE id = ?",
            (secret, user_id),
        )


def disable_totp(user_id: str):
    with get_control_db() as conn:
        conn.execute(
            "UPDATE user_account SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?",
            (user_id,),
        )
        conn.execute(
            "DELETE FROM user_recovery_code WHERE user_id = ?",
            (user_id,),
        )


def replace_recovery_codes(user_id: str) -> list[str]:
    codes = generate_recovery_codes()
    with get_control_db() as conn:
        conn.execute("DELETE FROM user_recovery_code WHERE user_id = ?", (user_id,))
        conn.executemany(
            """
            INSERT INTO user_recovery_code (id, user_id, code_hash)
            VALUES (?, ?, ?)
            """,
            [(str(uuid.uuid4()), user_id, _hash_recovery_code(code)) for code in codes],
        )
    return codes


def consume_recovery_code(user_id: str, code: str) -> bool:
    code_hash = _hash_recovery_code(code.strip().upper())
    with get_control_db() as conn:
        row = conn.execute(
            """
            SELECT id
            FROM user_recovery_code
            WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
            """,
            (user_id, code_hash),
        ).fetchone()
        if not row:
            return False
        conn.execute(
            "UPDATE user_recovery_code SET used_at = datetime('now') WHERE id = ?",
            (row["id"],),
        )
    return True
