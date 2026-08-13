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

            -- Vault key slots (multi-wrap envelope encryption). One workspace DEK protects every
            -- per-connection provider secret; it is wrapped once per user "slot" under a KEK derived
            -- from that user's unlock secret. A slot stores only the *wrapped* DEK and the public KDF
            -- parameters — never the unlock secret and never the DEK in the clear. `method` is
            -- 'passphrase' today; a 'passkey' (WebAuthn PRF) method joins in a later phase, which is
            -- why this is a per-(user, method) table rather than one column on user_account.
            CREATE TABLE IF NOT EXISTS vault_slot (
                id                   TEXT PRIMARY KEY,
                user_id              TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
                method               TEXT NOT NULL DEFAULT 'passphrase',
                wrapped_dek          TEXT NOT NULL,
                kdf_algo             TEXT NOT NULL DEFAULT 'scrypt',
                kdf_salt             TEXT NOT NULL,
                kdf_n                INTEGER NOT NULL,
                kdf_r                INTEGER NOT NULL,
                kdf_p                INTEGER NOT NULL,
                meets_production_min INTEGER NOT NULL DEFAULT 0,
                created_at           TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(user_id, method)
            );

            -- One row per credentials backup taken, recording *which wrapping* went into the file.
            --
            -- A credentials backup carries the DEK wrapped under the passphrase in force when it was
            -- written. Changing the passphrase rewraps the same DEK under a new salt, so the stored
            -- ciphertext is untouched but every previously exported file is thereafter restorable only
            -- with the *old* passphrase — permanently, and with nothing on screen to say so. This table is
            -- what lets the change dialog name the backups it is about to strand, by date, instead of
            -- offering a generic caution the user cannot act on.
            --
            -- `wrapped_dek_fingerprint` is a salted digest of the wrapped DEK, never the passphrase, never
            -- the DEK, and not the wrap itself: it only ever has to answer "is this the same wrapping the
            -- current slot has", so a value that cannot be turned back into key material is enough.
            --
            -- It lives in the control DB beside `vault_slot` because it describes vault state and must
            -- survive a *data* restore — the event most likely to be followed by wondering which backup
            -- still opens.
            CREATE TABLE IF NOT EXISTS credentials_export (
                id                      TEXT PRIMARY KEY,
                user_id                 TEXT REFERENCES user_account(id) ON DELETE CASCADE,
                wrapped_dek_fingerprint TEXT NOT NULL,
                exported_at             TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Retired with the vault rework: the old `user_secret_material` held a per-user DEK wrapped
            -- under an app master key (the `server_managed` model), which never delivered
            -- leaked-DB != leaked-tokens. Its ciphertext is unrecoverable under the new model by design
            -- (clean break; any live connection re-links). Superseded by `vault_slot` above.
            DROP TABLE IF EXISTS user_secret_material;

            -- Preferences moved to the data DB's `ui_preference` table (so backups carry them);
            -- the control DB now keeps only identity/secrets. Drop the now-unused control-DB preference
            -- copies. (The lazy-relocation bridge that emptied them into the data DB has been removed.)
            -- The legacy `local_preference_profile` table (retired in favor of the unified `user_account`
            -- identity) is deliberately *not* declared here: `_unify_local_profiles_into_users()` reads
            -- any physical rows left by an older version, folds them into accounts, then drops the table.
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

    # After the schema transaction commits (so `_create_user_with_tenant`'s own connection can write),
    # fold any legacy local preference profiles into unified `user_account` identities.
    _unify_local_profiles_into_users()


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


def _existing_shared_tenant_id() -> str | None:
    """The one shared workspace tenant, if any exists. There is a single workspace, so a new identity
    must adopt it rather than mint a second tenant (which would collide on the unique `tenant.db_path`).
    Prefer a current user's tenant; fall back to any existing `tenant` row — the orphan case after every
    identity was deleted (e.g. the developer "reset to first-run") but the tenant/data DB remained."""
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT tenant_id FROM user_account ORDER BY created_at, id LIMIT 1"
        ).fetchone()
        if row:
            return row["tenant_id"]
        tenant = conn.execute(
            "SELECT id FROM tenant ORDER BY created_at, id LIMIT 1"
        ).fetchone()
        return tenant["id"] if tenant else None


def _unify_local_profiles_into_users():
    """One-time: collapse legacy `local_preference_profile` rows into unified passwordless
    `user_account` identities, then drop the table. Preferences (data DB `ui_preference`, keyed by
    scope_id = the profile id in the old local mode) are re-keyed to each new user id so layouts/views
    survive. Idempotent: a no-op once the table is gone (fresh installs never had it).

    All identities share one workspace/tenant (the deployment model's "one shared workspace, multiple
    login identities"), so the first migrated user adopts the legacy data DB and the rest join its
    tenant. A profile whose name already matches an account (a re-run, or a name collision) is folded
    into that account rather than duplicated.
    """
    with get_control_db() as conn:
        has_table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='local_preference_profile'"
        ).fetchone()
        if not has_table:
            return
        profiles = [
            dict(row)
            for row in conn.execute(
                "SELECT id, name FROM local_preference_profile ORDER BY created_at, id"
            ).fetchall()
        ]
        existing = {
            row["username"].lower(): row["id"]
            for row in conn.execute("SELECT id, username FROM user_account").fetchall()
        }
    shared_tenant_id = _existing_shared_tenant_id()

    mapping: dict[str, str] = {}
    for profile in profiles:
        name = profile["name"]
        match_id = existing.get(name.lower())
        if match_id:
            mapping[profile["id"]] = match_id
            continue
        user = _create_user_with_tenant(
            username=name,
            password="",
            display_name=name,
            role="member",
            allow_unset_password=True,
            use_legacy_db_if_present=(shared_tenant_id is None),
            tenant_id=shared_tenant_id,
        )
        if shared_tenant_id is None:
            shared_tenant_id = user["tenant_id"]
        existing[name.lower()] = user["id"]
        mapping[profile["id"]] = user["id"]

    if mapping and shared_tenant_id:
        with get_control_db() as conn:
            tenant = conn.execute(
                "SELECT db_path FROM tenant WHERE id = ?", (shared_tenant_id,)
            ).fetchone()
        if tenant:
            with get_db(db_path=tenant["db_path"]) as data_conn:
                for old_id, new_id in mapping.items():
                    if old_id != new_id:
                        data_conn.execute(
                            "UPDATE ui_preference SET scope_id = ? WHERE scope_id = ?",
                            (new_id, old_id),
                        )

    with get_control_db() as conn:
        conn.execute("DROP TABLE IF EXISTS local_preference_profile")


def create_local_identity(name: str) -> dict:
    """Create a passwordless `user_account` for perimeter-off mode (the first-run identity, or an
    added identity from the chooser). Replaces the retired local-preference-profile creation; the
    account is selectable without a password while sign-in protection is off."""
    normalized = (name or "").strip()
    if not normalized:
        raise ValueError("Name is required")
    shared_tenant_id = _existing_shared_tenant_id()
    return _create_user_with_tenant(
        username=normalized,
        password="",
        display_name=normalized,
        role="member",
        allow_unset_password=True,
        use_legacy_db_if_present=(shared_tenant_id is None),
        tenant_id=shared_tenant_id,
    )


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


# Persisted suppression of the "Set up HTTPS" nag for the *recommended* (plain client-server, no
# provider) case only — HTTPS there protects the login cookie, which is the operator's call on their
# own network. The *required* (provider configured) case is never suppressible; it self-clears only
# when a request actually arrives over HTTPS.
def get_https_warning_suppressed() -> bool:
    return get_app_setting("https_warning_suppressed", "0") == "1"


def set_https_warning_suppressed(value: bool):
    set_app_setting("https_warning_suppressed", "1" if value else "0")


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
    # The workspace-level sign-in flag is the *only* thing that governs the perimeter. Multiple
    # passwordless identities are ordinary in perimeter-off mode, so an account count never forces
    # auth on (the old `user_count() > 1` latch wrongly forbade a passwordless multi-user household).
    return get_app_setting("auth_enabled", "0") == "1"


def enable_auth_mode():
    set_app_setting("auth_enabled", "1")


def disable_auth_mode():
    # Turning the perimeter off is a flag flip: identities stay `user_account` rows and password hashes
    # simply stop being consulted (they sit unused so re-enabling is seamless). No migration, no
    # credential loss, no re-keying — the whole point of the unified single-table model.
    set_app_setting("auth_enabled", "0")


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
    allow_unset_password: bool = False,
) -> dict:
    if not username.strip():
        raise ValueError("username is required")
    # A blank password is only allowed for a deliberately passwordless account: a perimeter-off local
    # identity (`allow_unset_password`) or one created in a "must set a password on next login" state
    # (`must_change_password`). Either way it stores the unset sentinel rather than a hash.
    password_provided = bool(password)
    if password_provided:
        validate_password_for_policy(password)
    elif not (must_change_password or allow_unset_password):
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
                t.db_path
            FROM user_account u
            JOIN tenant t ON t.id = u.tenant_id
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
                t.db_path
            FROM user_account u
            JOIN tenant t ON t.id = u.tenant_id
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
                t.name AS tenant_name
            FROM user_account u
            JOIN tenant t ON t.id = u.tenant_id
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


# --- Vault key slots (see the `vault_slot` table and `crypto_service`) ---------------------------
#
# A slot is one wrapping of the single workspace DEK under one user's unlock method. The control DB
# only ever holds the *wrapped* DEK plus public KDF parameters; the unlock secret and the DEK in the
# clear live only in the process at unlock time. These helpers are thin storage — all crypto (KDF,
# wrap/unwrap, the unlock cache) lives in `crypto_service`.

def get_vault_slot(user_id: str, method: str = "passphrase") -> dict | None:
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT * FROM vault_slot WHERE user_id = ? AND method = ?",
            (user_id, method),
        ).fetchone()
    return dict(row) if row else None


def upsert_vault_slot(
    user_id: str,
    *,
    method: str,
    wrapped_dek: str,
    kdf_algo: str,
    kdf_salt: str,
    kdf_n: int,
    kdf_r: int,
    kdf_p: int,
    meets_production_min: bool,
):
    with get_control_db() as conn:
        conn.execute(
            """
            INSERT INTO vault_slot
                (id, user_id, method, wrapped_dek, kdf_algo, kdf_salt, kdf_n, kdf_r, kdf_p, meets_production_min)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, method) DO UPDATE SET
                wrapped_dek          = excluded.wrapped_dek,
                kdf_algo             = excluded.kdf_algo,
                kdf_salt             = excluded.kdf_salt,
                kdf_n                = excluded.kdf_n,
                kdf_r                = excluded.kdf_r,
                kdf_p                = excluded.kdf_p,
                meets_production_min = excluded.meets_production_min,
                updated_at           = datetime('now')
            """,
            (
                str(uuid.uuid4()), user_id, method, wrapped_dek, kdf_algo, kdf_salt,
                kdf_n, kdf_r, kdf_p, 1 if meets_production_min else 0,
            ),
        )


def delete_vault_slots(user_id: str, method: str | None = None):
    with get_control_db() as conn:
        if method is None:
            conn.execute("DELETE FROM vault_slot WHERE user_id = ?", (user_id,))
        else:
            conn.execute(
                "DELETE FROM vault_slot WHERE user_id = ? AND method = ?",
                (user_id, method),
            )


def vault_slot_count() -> int:
    with get_control_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM vault_slot").fetchone()[0]


def all_slots_meet_production_min() -> bool:
    # Production readiness is an *all-slots* property: the DEK is only as strong as its weakest wrap,
    # so a single weak passphrase slot would let an offline attacker recover the DEK (and every token).
    with get_control_db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM vault_slot").fetchone()[0]
        if total == 0:
            return False
        weak = conn.execute(
            "SELECT COUNT(*) FROM vault_slot WHERE meets_production_min = 0"
        ).fetchone()[0]
    return weak == 0


def record_credentials_export(user_id: str | None, wrapped_dek_fingerprint: str) -> None:
    """Note that a credentials backup was written against this wrapping of the DEK.

    Append-only and unbounded in principle, but bounded in practice by how often a person exports
    credentials by hand; pruning would cost the exact history the change warning reads."""
    with get_control_db() as conn:
        conn.execute(
            "INSERT INTO credentials_export (id, user_id, wrapped_dek_fingerprint) VALUES (?,?,?)",
            (str(uuid.uuid4()), user_id, wrapped_dek_fingerprint),
        )


def credentials_exports_for_fingerprint(fingerprint: str) -> list[dict]:
    """Every recorded export taken against one wrapping, newest first.

    Matching on the fingerprint rather than listing all exports is what makes the warning specific: a
    backup written under a *previous* passphrase was stranded by an earlier change and saying so again
    is noise, while one written under the current wrapping is precisely what the next change breaks."""
    if not fingerprint:
        return []
    with get_control_db() as conn:
        rows = conn.execute(
            "SELECT id, exported_at FROM credentials_export WHERE wrapped_dek_fingerprint = ? "
            "ORDER BY exported_at DESC, id DESC",
            (fingerprint,),
        ).fetchall()
    return [dict(r) for r in rows]


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


def enable_auth_with_admin(
    claim_user_id: str,
    admin_password: str,
    initial_passwords: dict | None = None,
    password_policy: str | None = None,
) -> dict:
    """Turn on sign-in protection over the already-unified `user_account` identities. The operator
    claims one existing identity as the **admin** and sets a real password for it (so the perimeter has
    a protected owner the instant it comes up). Every other password-unset identity is marked
    `must_change_password`, so it stays claimable and is forced to set a password at next login. An
    identity that already has a password keeps it.

    No accounts are created and no preferences are re-keyed — identities are already users; this only
    assigns passwords/roles and flips the flag. `initial_passwords` optionally seeds specific members'
    passwords up front (keyed by user id). Everything is validated before any write, so a bad password
    never leaves the workspace half-configured. Returns the admin user.
    """
    if auth_required():
        raise ValueError("sign-in protection is already enabled")
    initial_passwords = initial_passwords or {}

    # Apply the chosen policy first so the admin/seeded passwords validate against it.
    if password_policy is not None:
        set_password_policy(password_policy)

    claim = get_user_by_id(claim_user_id)
    if not claim:
        raise ValueError("claimed identity not found")

    validate_password_for_policy(admin_password)
    for user_id, candidate in initial_passwords.items():
        if candidate:
            validate_password_for_policy(candidate)

    # Admin gets a real password + the admin role and is no longer claimable.
    update_user(
        claim_user_id,
        password=admin_password,
        role="admin",
        must_change_password=False,
    )

    for user in list_users():
        if user["id"] == claim_user_id:
            continue
        candidate = initial_passwords.get(user["id"]) or ""
        if candidate:
            # A seeded starting password is still a temp credential — force a change at next login.
            update_user(user["id"], password=candidate, must_change_password=True)
        elif not password_is_set(_user_password_hash(user["id"])):
            # Leave the account password-unset but claimable: forced to set one at next login.
            update_user(user["id"], must_change_password=True)

    enable_auth_mode()
    return get_user_by_id(claim_user_id)


def _user_password_hash(user_id: str) -> str | None:
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT password_hash FROM user_account WHERE id = ?", (user_id,)
        ).fetchone()
    return row["password_hash"] if row else None


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
    # The "keep at least one admin" invariant only matters when the perimeter is on (admin gates
    # settings). Perimeter-off, admin is meaningless — everyone is effectively admin — so the guard
    # would only get in the way (e.g. it would block clearing the local identities down to none, which
    # should land back on the first-run chooser).
    if (
        auth_required()
        and current["role"] == "admin"
        and current["status"] == "active"
        and admin_count() <= 1
    ):
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
