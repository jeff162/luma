# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Control database for auth, the workspace record, security settings, and user-scoped state.

Unlike the app database, this file manages what the installation needs in order to run: who can sign
in, when auth becomes mandatory, which secret material belongs to each user, and which workspace the
financial database must belong to (`pairing_problem`).
"""

import base64
import functools
import hashlib
import hmac
import json
import os
import sqlite3
import struct
import time
import urllib.parse
import uuid

import segno
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from backend import password_strength
from backend.db.database import (
    DB_PATH, WRITE_TRANSACTION_ISOLATION, current_db_path, get_db, get_workspace_id, init_db, set_workspace_id,
)
from backend.app_logging import log_warning
from backend.runtime_config import app_name, is_frozen, resolve_control_db_path


CONTROL_DB_PATH = resolve_control_db_path()
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


@functools.cache
def _decoy_password_hash() -> str:
    return _hash_password(os.urandom(16).hex())


def spend_password_check(password: str) -> None:
    """Take as long as checking a real password, for a sign-in refused without one to check.

    A refusal that came back at once for a username naming no account, and only after the key
    stretching for one that does, would tell a caller which usernames are real. Built on first use rather
    than at import, where it would add the stretching's cost to every start."""
    verify_password(password, _decoy_password_hash())


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


def _matching_totp_step(secret: str, code: str, window: int = 1) -> int | None:
    """The time step `code` belongs to, or None. `window` steps either side absorb clock drift between
    the server and the authenticator, which is why three codes are accepted at any moment."""
    normalized = "".join(ch for ch in code if ch.isdigit())
    if len(normalized) != 6:
        return None
    now = int(time.time())
    for offset in range(-window, window + 1):
        at = now + offset * TOTP_PERIOD
        if hmac.compare_digest(_totp_code(secret, at), normalized):
            return at // TOTP_PERIOD
    return None


def verify_totp_code(secret: str, code: str, window: int = 1) -> bool:
    return _matching_totp_step(secret, code, window) is not None


def consume_totp_code(user_id: str, secret: str, code: str) -> bool:
    """Accept an authenticator code once. A code stays valid for up to a minute and a half, so one read off
    a screen or out of a log could otherwise be replayed inside that time; accepting only steps later than
    the last one used closes that. The conditional update is the check, so two requests racing with the
    same code cannot both pass."""
    step = _matching_totp_step(secret, code)
    if step is None:
        return False
    with get_control_db() as conn:
        cursor = conn.execute(
            """
            UPDATE user_account SET totp_last_step = ?
            WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)
            """,
            (step, user_id, step),
        )
    return cursor.rowcount == 1


def build_totp_uri(username: str, secret: str, issuer: str | None = None) -> str:
    issuer = issuer or app_name()
    label = urllib.parse.quote(f"{issuer}:{username}")
    issuer_q = urllib.parse.quote(issuer)
    return f"otpauth://totp/{label}?secret={secret}&issuer={issuer_q}&algorithm=SHA1&digits=6&period={TOTP_PERIOD}"


@contextmanager
def get_control_db():
    Path(CONTROL_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    # Writes take the lock when their transaction opens, as on the data database (`database.get_db`).
    conn = sqlite3.connect(CONTROL_DB_PATH, isolation_level=WRITE_TRANSACTION_ISOLATION)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# The one workspace record. Its `id` is the workspace id the financial database carries as well
# (`database.WORKSPACE_ID_KEY`), which is how a startup tells whether the two files belong together.
_TENANT_DDL = """
    CREATE TABLE IF NOT EXISTS {table} (
        id         TEXT PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
"""


def _retire_tenant_db_path() -> None:
    """Rebuild a `tenant` table from before the workspace id, dropping its `db_path` column.

    The column recorded where the financial database was and routed requests to it. Requests use the
    configured database, and the workspace id in both files is what says the two belong together. Before
    the column goes, the ledger requests were using is given the workspace id, so an upgraded installation
    keeps opening its own: the configured one in a packaged build, which adopted it at every start, and in
    a checkout the recorded one while that file still exists.

    The column is `UNIQUE`, which SQLite will not drop, so the table is copied into a new one and swapped.
    `user_account.tenant_id` refers to it with `ON DELETE CASCADE`, so foreign keys are off for the swap:
    dropping the old table with them on would delete every account. SQLite only changes that setting
    outside a transaction, which is why this has a connection of its own in autocommit mode.
    """
    if not Path(CONTROL_DB_PATH).is_file():
        return
    conn = sqlite3.connect(CONTROL_DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(tenant)")}
        if "db_path" not in columns:
            return
        rows = conn.execute("SELECT id, db_path FROM tenant").fetchall()
        if len(rows) == 1:
            _stamp_ledger_in_use(rows[0]["id"], rows[0]["db_path"])
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DROP TABLE IF EXISTS tenant_rebuilt")
            conn.execute(_TENANT_DDL.format(table="tenant_rebuilt"))
            conn.execute(
                "INSERT INTO tenant_rebuilt (id, slug, name, status, created_at) "
                "SELECT id, slug, name, status, created_at FROM tenant"
            )
            conn.execute("DROP TABLE tenant")
            conn.execute("ALTER TABLE tenant_rebuilt RENAME TO tenant")
            dangling = conn.execute("PRAGMA foreign_key_check").fetchall()
            if dangling:
                raise RuntimeError(f"rebuilding the workspace table left {len(dangling)} dangling references")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def _stamp_ledger_in_use(tenant_id: str, recorded: str) -> None:
    configured = Path(DB_PATH)
    recorded_path = Path(recorded)
    in_use = recorded_path if not is_frozen() and recorded_path.is_file() else configured
    if not in_use.is_file():
        return
    with get_db(str(in_use)) as data_conn:
        # Only a ledger the app has initialized: stamping an empty file would leave `init_db` reading it as
        # a database to migrate rather than one to create.
        initialized = data_conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'"
        ).fetchone()
        if initialized and get_workspace_id(data_conn) is None:
            set_workspace_id(data_conn, tenant_id)
    if in_use.resolve() != configured.resolve():
        log_warning(
            f"[db] this workspace's financial database is {in_use.resolve()}, but this installation is "
            f"configured for {configured.resolve()}. Set DB_PATH to the one that should be used."
        )


def init_control_db():
    _retire_tenant_db_path()
    with get_control_db() as conn:
        conn.execute(_TENANT_DDL.format(table="tenant"))
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_setting (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

            -- A passkey that crosses the *login* perimeter. Deliberately a separate table from
            -- `vault_slot`, which also holds passkeys: the two answer different questions and must never
            -- be reachable through one another. A vault slot holds key material and opens encrypted
            -- credentials; this row holds only a public key and authenticates a session. Signing in with
            -- one of these confers no vault authority whatsoever.
            --
            -- Everything here is public by construction. `public_key` is the COSE key the authenticator
            -- published, and a leak of this table lets an attacker verify assertions, never produce one —
            -- the private half never leaves the authenticator.
            --
            -- `sign_count` is the authenticator's own monotonic counter, stored so a regression can be
            -- refused: a counter that goes backwards is the documented signal of a cloned credential.
            -- Many modern authenticators (notably the platform ones backed by a synced keychain) report a
            -- permanent 0, which is why a 0 is not treated as a regression.
            CREATE TABLE IF NOT EXISTS app_passkey (
                id            TEXT PRIMARY KEY,
                user_id       TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
                credential_id TEXT NOT NULL UNIQUE,
                public_key    TEXT NOT NULL,
                sign_count    INTEGER NOT NULL DEFAULT 0,
                transports    TEXT,
                label         TEXT,
                -- The host name (WebAuthn RP id) it was registered under, the only name it answers at.
                -- NULL until a passkey registered before this was kept next signs in.
                rp_id         TEXT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                last_used_at  TEXT
            );

            -- One row per credentials backup taken and per member whose passphrase went into it
            -- (`user_id`), recording *which wrapping* that was.
            --
            -- A credentials backup carries the DEK wrapped under each passphrase in force when it was
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
            --
            -- Beside the wrapping, what else opened the file when it was written, so the reset dialog can
            -- say which secrets a backup needs: `recovery_issued_at` (the member's recovery code, by
            -- issue time, NULL when they had none) and `passkey_credential_ids` (a JSON list), plus
            -- `seal_digest`, the workspace key the file's credentials are under, which a retired key is
            -- matched against (`retired_vault_key`). All three are NULL on rows written before they
            -- existed, which say nothing either way.
            --
            -- `backup_id` is the data DB's `backup_history` row for the same file, and `withdrawn_at` is
            -- set while that row is in the trash: the record is written before the browser saves the file,
            -- and someone who cancelled the save says so by trashing the row. A withdrawn record is read
            -- by nothing.
            CREATE TABLE IF NOT EXISTS credentials_export (
                id                      TEXT PRIMARY KEY,
                user_id                 TEXT REFERENCES user_account(id) ON DELETE CASCADE,
                wrapped_dek_fingerprint TEXT NOT NULL,
                exported_at             TEXT NOT NULL DEFAULT (datetime('now')),
                recovery_issued_at      TEXT,
                passkey_credential_ids  TEXT,
                seal_digest             TEXT,
                backup_id               TEXT,
                withdrawn_at            TEXT
            );

            -- The workspace keys that stopped being this vault's, one row per slot seal that held one
            -- (`crypto_service.seal_digest`), and why: a reset after a `lost` or a `compromised`
            -- passphrase, or a key `replaced` by rotation. A backup's credentials sealed under a key
            -- retired for any reason but `lost` are not restored: they are exposed, or under a key someone
            -- who should no longer read them knew. Kept in the control DB, outside what an accounts
            -- restore replaces, since restoring an old file is exactly what this has to outlive.
            CREATE TABLE IF NOT EXISTS retired_vault_key (
                seal_digest TEXT PRIMARY KEY,
                reason      TEXT NOT NULL,
                retired_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- One row per signed-in browser, so the server can end a session rather than only ask the
            -- browser to forget it. The session cookie is signed, not stored, and until this table a copy
            -- of it stayed valid for its whole lifetime whatever happened to the original: signing out,
            -- changing the password or disabling the account ended nothing. The cookie now names a row,
            -- and a cookie whose row is gone is signed out (`services/sign_in_sessions.py`).
            --
            -- `id_digest` is a SHA-256 of the id the cookie carries, never the id itself. Unless
            -- `SESSION_SECRET` is set, the session signing secret is stored in this same database, so a
            -- copy of the file lets anyone sign a cookie; what it must not also hand them is an id that a
            -- row still accepts.
            CREATE TABLE IF NOT EXISTS sign_in_session (
                id_digest    TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_sign_in_session_user ON sign_in_session(user_id);

            -- The host names this install's pages have been opened under where a passkey could run
            -- (`transport.note_served_host`). A passkey answers only at the name it was registered for,
            -- and nothing inside the app can see a reverse proxy's site list, so this is how a restore or
            -- Vault settings tells a passkey that can work here from one that never can
            -- (`transport.passkey_host_names`). It describes this machine and survives a restore.
            CREATE TABLE IF NOT EXISTS served_host (
                host          TEXT PRIMARY KEY,
                first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        # The time step of the last authenticator code accepted, so the same code cannot be used twice.
        try:
            conn.execute(
                "ALTER TABLE user_account ADD COLUMN totp_last_step INTEGER"
            )
        except Exception:
            pass
        if "rp_id" not in {r["name"] for r in conn.execute("PRAGMA table_info(app_passkey)")}:
            conn.execute("ALTER TABLE app_passkey ADD COLUMN rp_id TEXT")
        export_columns = {r["name"] for r in conn.execute("PRAGMA table_info(credentials_export)")}
        for column in ("recovery_issued_at", "passkey_credential_ids", "seal_digest", "backup_id", "withdrawn_at"):
            if column not in export_columns:
                conn.execute(f"ALTER TABLE credentials_export ADD COLUMN {column} TEXT")

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

        _init_vault_slot_table(conn)

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


def delete_app_setting(key: str):
    with get_control_db() as conn:
        conn.execute("DELETE FROM app_setting WHERE key = ?", (key,))


# How many errors the server has logged, and how many of those an administrator has seen by opening
# Settings -> Error log (`backend/app_log_file.py`). Install-wide rather than per user, like the log itself:
# an error needs looking at once, by whoever looks. Counted as they are logged rather than re-derived from
# the file, which rotates — an error nobody had seen would drop out of the count along with its line.
_SERVER_ERRORS_RECORDED = "server_errors_recorded"
_SERVER_ERRORS_ACKNOWLEDGED = "server_errors_acknowledged"


def record_server_errors(count: int, busy_timeout_ms: int) -> None:
    """Add `count` to the recorded total. `busy_timeout_ms` is the caller's: the log handler runs inside a
    failing request, sometimes on the event loop, and must not wait out the ordinary lock timeout."""
    with get_control_db() as conn:
        conn.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
        conn.execute(
            """
            INSERT INTO app_setting (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER),
                                           updated_at = datetime('now')
            """,
            (_SERVER_ERRORS_RECORDED, int(count)),
        )


def server_error_counts() -> tuple[int, int]:
    """(recorded, acknowledged)."""
    with get_control_db() as conn:
        rows = dict(conn.execute(
            "SELECT key, value FROM app_setting WHERE key IN (?, ?)",
            (_SERVER_ERRORS_RECORDED, _SERVER_ERRORS_ACKNOWLEDGED),
        ).fetchall())
    return int(rows.get(_SERVER_ERRORS_RECORDED) or 0), int(rows.get(_SERVER_ERRORS_ACKNOWLEDGED) or 0)


def acknowledge_server_errors(through: int) -> None:
    """Mark the errors up to `through` as seen — the total the reader was shown alongside the entries, so
    one logged while the page was open stays unseen. Never moves backwards, and never past what exists."""
    with get_control_db() as conn:
        conn.execute(
            """
            INSERT INTO app_setting (key, value, updated_at)
            VALUES (?, MIN(?, COALESCE((SELECT CAST(value AS INTEGER) FROM app_setting WHERE key = ?), 0)),
                    datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)),
                                           updated_at = datetime('now')
            """,
            (_SERVER_ERRORS_ACKNOWLEDGED, int(through), _SERVER_ERRORS_RECORDED),
        )


def workspace_id() -> str | None:
    """The one shared workspace's id, if a workspace record exists. There is a single workspace, so a new
    identity adopts it rather than minting a second. Prefer a current user's tenant; fall back to any
    existing `tenant` row — the orphan case after every identity was deleted (e.g. the developer "reset to
    first-run") but the workspace record remained."""
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
    shared_tenant_id = workspace_id()

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
            tenant_id=shared_tenant_id,
        )
        if shared_tenant_id is None:
            shared_tenant_id = user["tenant_id"]
        existing[name.lower()] = user["id"]
        mapping[profile["id"]] = user["id"]

    if mapping and shared_tenant_id:
        with get_db(db_path=DB_PATH) as data_conn:
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
    shared_tenant_id = workspace_id()
    return _create_user_with_tenant(
        username=normalized,
        password="",
        display_name=normalized,
        role="member",
        allow_unset_password=True,
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


# A dismissal of the "Set up HTTPS" task recorded before tasks had a dismissal of their own. Still
# honored, so an operator who answered once is not asked again.
def get_https_warning_suppressed() -> bool:
    return get_app_setting("https_warning_suppressed", "0") == "1"


def set_https_warning_suppressed(value: bool):
    set_app_setting("https_warning_suppressed", "1" if value else "0")


def password_policy_label(policy: str | None = None) -> str:
    normalized = policy or get_password_policy()
    if normalized == PASSWORD_POLICY_NONE:
        return "No password restrictions"
    if normalized == PASSWORD_POLICY_STRONG:
        return "Strong"
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
    # "Strong" is the estimator's top score, the same test the vault passphrase is held to
    # (`backend/password_strength.py`). Length counts through the estimate, not as a rule of its own.
    estimate = password_strength.estimate(password)
    if estimate["score"] < password_strength.TOP_SCORE:
        raise ValueError(" ".join(filter(None, ["This password is too easy to guess.", estimate["warning"]])))


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


# What a startup finds when the two databases it was configured with do not belong together. Each is a
# refusal to open the ledger: requests would otherwise run one installation's sign-ins and vault against
# another's data, or against a file SQLite created empty because the configured path named nothing.
PAIRING_MISSING = "missing"            # no financial database at the configured path
PAIRING_UNREADABLE = "unreadable"      # a file is there, and it is not a database
PAIRING_UNPAIRED = "unpaired"          # a database with no workspace id, as a newly created file has
PAIRING_OTHER_WORKSPACE = "other_workspace"


@dataclass(frozen=True)
class PairingProblem:
    kind: str
    ledger_path: str
    control_path: str


def pairing_problem() -> PairingProblem | None:
    """Whether the configured financial database belongs to this control database's workspace.

    Only a control database with a workspace has anything to check: a new one adopts whatever ledger it
    is beside when its first identity is created (`_workspace_id_for_new_record`), which is how a lost
    control database is replaced. Reads without writing, and never creates the ledger file, so a wrong path
    is reported rather than answered with an empty database.
    """
    workspace = workspace_id()
    if workspace is None:
        return None
    ledger = Path(DB_PATH)

    def problem(kind: str) -> PairingProblem:
        return PairingProblem(kind, str(ledger.resolve()), str(Path(CONTROL_DB_PATH).resolve()))

    if not ledger.is_file():
        return problem(PAIRING_MISSING)
    try:
        with get_db(str(ledger)) as conn:
            recorded = get_workspace_id(conn)
    except sqlite3.DatabaseError:
        return problem(PAIRING_UNREADABLE)
    if recorded == workspace:
        return None
    return problem(PAIRING_UNPAIRED if recorded is None else PAIRING_OTHER_WORKSPACE)


def adopt_ledger() -> None:
    """Make the configured financial database this workspace's, creating an empty one if there is none.

    The deliberate answer to a `pairing_problem`, run from a console (`backend/ledger_adoption.py`), never
    from a request: re-pairing decides which ledger an installation's sign-ins open, which is not a
    question anyone who can reach the server should be able to answer."""
    workspace = workspace_id()
    if workspace is None:
        raise ValueError("there is no workspace to pair the financial database with")
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    init_db(DB_PATH)
    with get_db(DB_PATH) as conn:
        set_workspace_id(conn, workspace)


def _workspace_id_for_new_record() -> str:
    """The id for a workspace record being created: the configured ledger's own when it already has one,
    so a control database made fresh beside existing data adopts it, and otherwise a new id written into
    the ledger. The ledger is written first; if the record then fails, the next attempt finds the id there."""
    ledger = current_db_path()
    Path(ledger).parent.mkdir(parents=True, exist_ok=True)
    init_db(ledger)
    with get_db(ledger) as conn:
        existing = get_workspace_id(conn)
        if existing:
            return existing
        new_id = str(uuid.uuid4())
        set_workspace_id(conn, new_id)
        return new_id


def _create_user_with_tenant(
    username: str,
    password: str,
    display_name: str | None = None,
    role: str = "member",
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
                "SELECT id FROM tenant WHERE id = ?",
                (resolved_tenant_id,),
            ).fetchone()
            if not tenant:
                raise ValueError("tenant not found")
        else:
            # No workspace yet: this is the first identity on this control DB (bootstrap, or the first
            # local profile), and it creates the workspace record.
            resolved_tenant_id = _workspace_id_for_new_record()
            slug = _unique_tenant_slug(conn, _tenant_slug(clean_username))
            conn.execute(
                "INSERT INTO tenant (id, slug, name) VALUES (?, ?, ?)",
                (resolved_tenant_id, slug, user_display_name),
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
                t.name AS tenant_name
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
                t.name AS tenant_name
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


# --- Sign-in sessions (see the `sign_in_session` table and `services/sign_in_sessions.py`) ----------
#
# Thin storage: the ids, their digests and the lifetime policy belong to the service.

def create_sign_in_session(id_digest: str, user_id: str, *, prune_idle_seconds: int) -> None:
    """Record a new session, first dropping any idle past `prune_idle_seconds` — a browser that was
    closed and never came back never signs out, so this is where its row goes instead."""
    with get_control_db() as conn:
        conn.execute(
            "DELETE FROM sign_in_session WHERE last_seen_at < datetime('now', ?)",
            (f"-{int(prune_idle_seconds)} seconds",),
        )
        conn.execute(
            "INSERT INTO sign_in_session (id_digest, user_id) VALUES (?, ?)",
            (id_digest, user_id),
        )


def sign_in_session_is_live(
    id_digest: str, user_id: str, *, max_idle_seconds: int, touch_after_seconds: int,
) -> bool:
    """Whether the session exists, belongs to `user_id` and has been used within `max_idle_seconds`.

    Its last-seen time is written only once it is `touch_after_seconds` old, so an ordinary request
    reads here and does not write."""
    with get_control_db() as conn:
        row = conn.execute(
            """
            SELECT last_seen_at < datetime('now', ?) AS due
            FROM sign_in_session
            WHERE id_digest = ? AND user_id = ? AND last_seen_at >= datetime('now', ?)
            """,
            (f"-{int(touch_after_seconds)} seconds", id_digest, user_id, f"-{int(max_idle_seconds)} seconds"),
        ).fetchone()
        if not row:
            return False
        if row["due"]:
            conn.execute(
                "UPDATE sign_in_session SET last_seen_at = datetime('now') WHERE id_digest = ?",
                (id_digest,),
            )
    return True


def delete_sign_in_session(id_digest: str) -> None:
    with get_control_db() as conn:
        conn.execute("DELETE FROM sign_in_session WHERE id_digest = ?", (id_digest,))


# --- Vault key slots (see the `vault_slot` table and `crypto_service`) ---------------------------
#
# A slot is one user's way into the single workspace DEK. The control DB holds only material that is
# useless without the unlock secret; the secret itself and the DEK in the clear live only in the
# process at unlock time. These helpers are thin storage — all crypto (KDF, wrap/unwrap, sealing, the
# unlock cache) lives in `crypto_service`.
#
# Two slot formats coexist, because the first one cannot express what phase 5 needs:
#
#   format 1 — `wrapped_dek` = AEAD(KEK, DEK). The KEK comes from the user's own secret, so *only that
#              user* can ever produce their wrap. That makes granting a second person access require a
#              secret to travel between two humans, and makes key rotation unable to preserve anyone
#              else's slot (the rotator cannot compute a KEK they have no secret for).
#   format 2 — the slot owns an X25519 keypair: `public_key` in the clear, `wrapped_private_key` =
#              AEAD(KEK, private key), and `sealed_dek` = the DEK sealed *to that public key*. Anyone
#              holding the DEK can therefore seal it for anyone else without holding their secret,
#              which is what makes enrollment ("this user asked for access") and rotation possible.
#
# A format-2 slot with a NULL `sealed_dek` is a real, fully-formed slot that simply has not been
# granted the DEK yet — the pending state of the enrollment flow, not a half-written row.
#
# `sealed_dek_prev` exists only during a rotation. Rotation must write two databases (slots here, the
# re-encrypted ciphertext in the data DB) and no transaction spans both, so the previous DEK stays
# reachable until the new ciphertext is committed. See `crypto_service.rotate_dek`.

_VAULT_SLOT_DDL = """
    CREATE TABLE IF NOT EXISTS {table} (
        id                   TEXT PRIMARY KEY,
        user_id              TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        method               TEXT NOT NULL DEFAULT 'passphrase',
        label                TEXT,
        format               INTEGER NOT NULL DEFAULT 2,
        -- A typed secret's KDF and its parameters, stored per slot so the current choice can change
        -- without stranding a wrap made under an earlier one: `scrypt` reads n/r/p, `argon2id` reads
        -- m (KiB)/t/p. NULL on a passkey slot, whose secret is already key material.
        kdf_algo             TEXT,
        kdf_salt             TEXT,
        kdf_n                INTEGER,
        kdf_r                INTEGER,
        kdf_p                INTEGER,
        kdf_m                INTEGER,
        kdf_t                INTEGER,
        credential_id        TEXT,
        prf_salt             TEXT,
        -- The WebAuthn RP id (the host name) a passkey slot answers under. A passkey works only at the
        -- name it was registered for, so this is what lets a credentials backup say where one of its
        -- passkeys can be used. NULL until the slot is registered or next unlocks with this recorded.
        rp_id                TEXT,
        public_key           TEXT,
        wrapped_private_key  TEXT,
        sealed_dek           TEXT,
        sealed_dek_prev      TEXT,
        wrapped_dek          TEXT,
        meets_production_min INTEGER NOT NULL DEFAULT 0,
        -- What `meets_production_min` was judged under: the strength rule's version and the estimator
        -- release (`crypto_service.STRENGTH_BASIS`). A passphrase can only be judged while it is in
        -- hand, so a verdict taken under an earlier basis stays as it was until the owner next types
        -- it; NULL is a verdict from before the basis was recorded.
        strength_basis       TEXT,
        -- Set on a pending slot written by someone who ALREADY had vault access and lost the secret
        -- that opened it (the re-enrollment rung). The approval queue reads the same shape for a
        -- newcomer enrolling and for a locked-out member coming back, and the two ask very different
        -- things of the approver — the second replaces access that already existed, which is what
        -- someone at the locked-out user's keyboard would exploit. Stored rather than derived because
        -- writing the pending slot is what destroys the evidence it would be derived from.
        replaces_access      INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
"""

# One passphrase per user, any number of passkeys — a person may keep a laptop's platform
# authenticator and a phone's, and both must open the same vault. This replaces the original
# table-level UNIQUE(user_id, method), which allowed only one of each.
#
# One recovery code per user, for the same reason the code is single rather than a set: every slot is an
# independent path to the same DEK, so a second one doubles the exposure to buy redundancy that keeping
# two copies of one code already provides. Enforced here rather than left to the issuing code so a bug
# that forgets to retire the outgoing slot fails loudly instead of quietly leaving two codes live.
_VAULT_SLOT_INDEXES = """
    CREATE UNIQUE INDEX IF NOT EXISTS vault_slot_one_passphrase
        ON vault_slot(user_id) WHERE method = 'passphrase';
    CREATE UNIQUE INDEX IF NOT EXISTS vault_slot_one_recovery
        ON vault_slot(user_id) WHERE method = 'recovery';
    CREATE UNIQUE INDEX IF NOT EXISTS vault_slot_credential
        ON vault_slot(credential_id) WHERE credential_id IS NOT NULL;
"""


def _init_vault_slot_table(conn):
    """Create `vault_slot`, rebuilding a pre-phase-4 table in place.

    The old shape cannot be reached by ALTER: `wrapped_dek` and the KDF columns were NOT NULL (a
    passkey slot has no KDF parameters and a pending slot has no wrapped key at all), and the
    table-level UNIQUE(user_id, method) permitted only one passkey. Rows copy across as **format 1** —
    converting one needs the passphrase, so `crypto_service.unlock` does it lazily at the one moment
    both the KEK and the DEK are in hand.
    """
    conn.executescript(_VAULT_SLOT_DDL.format(table="vault_slot"))
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(vault_slot)").fetchall()}
    if "format" not in columns:
        # A partially-applied earlier attempt leaves the scratch table behind; start it clean.
        conn.execute("DROP TABLE IF EXISTS vault_slot_rebuilt")
        conn.executescript(_VAULT_SLOT_DDL.format(table="vault_slot_rebuilt"))
        conn.execute(
            """
            INSERT INTO vault_slot_rebuilt
                (id, user_id, method, format, kdf_algo, kdf_salt, kdf_n, kdf_r, kdf_p,
                 wrapped_dek, meets_production_min, created_at, updated_at)
            SELECT id, user_id, method, 1, kdf_algo, kdf_salt, kdf_n, kdf_r, kdf_p,
                   wrapped_dek, meets_production_min, created_at, updated_at
            FROM vault_slot
            """
        )
        conn.execute("DROP TABLE vault_slot")
        conn.execute("ALTER TABLE vault_slot_rebuilt RENAME TO vault_slot")
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(vault_slot)").fetchall()}
    # Purely additive, so it needs no rebuild: SQLite backfills the default into existing rows, and 0 is
    # the right answer for every slot written before re-enrollment existed.
    if "replaces_access" not in columns:
        conn.execute("ALTER TABLE vault_slot ADD COLUMN replaces_access INTEGER NOT NULL DEFAULT 0")
    # Additive the same way, and NULL is the honest value for every existing row: no slot written before
    # these columns used Argon2id, recorded where its passkey was registered, or was judged by a
    # versioned rule.
    for column, decl in (("kdf_m", "INTEGER"), ("kdf_t", "INTEGER"), ("rp_id", "TEXT"),
                         ("strength_basis", "TEXT")):
        if column not in columns:
            conn.execute(f"ALTER TABLE vault_slot ADD COLUMN {column} {decl}")
    conn.executescript(_VAULT_SLOT_INDEXES)


# A slot that can actually produce the DEK, as opposed to one still awaiting a grant. Written once
# here because three different questions ask it — who counts toward the vault existing, whose wrap the
# Production floor must hold for, and which slots a rotation has to re-seal.
_HOLDS_DEK = "((format = 1 AND wrapped_dek IS NOT NULL) OR (format = 2 AND sealed_dek IS NOT NULL))"


def get_vault_slot(user_id: str, method: str = "passphrase") -> dict | None:
    """One user's slot for a method. Passphrase slots are unique per user, so this is exact for them;
    for passkeys (several per user) it returns the oldest and callers wanting all of them use
    `list_vault_slots`."""
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT * FROM vault_slot WHERE user_id = ? AND method = ? ORDER BY created_at, id",
            (user_id, method),
        ).fetchone()
    return dict(row) if row else None


def rename_vault_passkey(user_id: str, slot_id: str, label: str | None) -> bool:
    """Change the name this install shows for one of this user's vault passkeys, scoped to the owner in
    the statement. It is not part of any wrap, so nothing is re-sealed."""
    with get_control_db() as conn:
        cursor = conn.execute(
            "UPDATE vault_slot SET label = ? WHERE id = ? AND user_id = ? AND method = 'passkey'",
            (label, slot_id, user_id),
        )
    return cursor.rowcount > 0


def get_vault_slot_by_id(slot_id: str) -> dict | None:
    with get_control_db() as conn:
        row = conn.execute("SELECT * FROM vault_slot WHERE id = ?", (slot_id,)).fetchone()
    return dict(row) if row else None


def get_vault_slot_by_credential(credential_id: str) -> dict | None:
    with get_control_db() as conn:
        row = conn.execute(
            "SELECT * FROM vault_slot WHERE credential_id = ?", (credential_id,)
        ).fetchone()
    return dict(row) if row else None


def list_vault_slots(user_id: str | None = None, *, method: str | None = None) -> list[dict]:
    clauses, params = [], []
    if user_id is not None:
        clauses.append("user_id = ?")
        params.append(user_id)
    if method is not None:
        clauses.append("method = ?")
        params.append(method)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with get_control_db() as conn:
        rows = conn.execute(
            f"SELECT * FROM vault_slot {where} ORDER BY created_at, id", params
        ).fetchall()
    return [dict(r) for r in rows]


def list_pending_vault_slots() -> list[dict]:
    """Slots awaiting a grant, with the identity behind each — the enrollment queue an unlocked member
    is asked to approve. Joined here rather than in the router because "who is waiting" is one
    question and a caller assembling it from two round trips would have to re-derive the join."""
    with get_control_db() as conn:
        rows = conn.execute(
            f"""
            SELECT s.*, u.username, u.display_name
            FROM vault_slot s
            JOIN user_account u ON u.id = s.user_id
            WHERE NOT {_HOLDS_DEK}
            ORDER BY s.created_at, s.id
            """
        ).fetchall()
    return [dict(r) for r in rows]


def list_vault_members() -> list[dict]:
    """One row per person who can open the vault, with how many ways in they have.

    Grouped by user rather than listed per slot because this answers a question about *people* — who
    holds the workspace's credentials — and someone with a passphrase and two passkeys is one person
    with access, not three."""
    with get_control_db() as conn:
        rows = conn.execute(
            f"""
            SELECT u.id AS user_id, u.username, u.display_name, u.role,
                   COUNT(*) AS method_count, MIN(s.created_at) AS since
            FROM vault_slot s
            JOIN user_account u ON u.id = s.user_id
            WHERE {_HOLDS_DEK}
            GROUP BY u.id, u.username, u.display_name, u.role
            ORDER BY MIN(s.created_at), u.username
            """
        ).fetchall()
    return [dict(r) for r in rows]


# The columns that say how a typed secret becomes a KEK. Written as one set everywhere a slot's KDF is
# set, because a column left out of an update keeps the previous KDF's value and the slot then reads as a
# mixture of two algorithms' parameters.
VAULT_SLOT_KDF_COLUMNS = ("kdf_algo", "kdf_salt", "kdf_n", "kdf_r", "kdf_p", "kdf_m", "kdf_t")


def _kdf_values(kdf: dict | None) -> tuple:
    kdf = kdf or {}
    return tuple(kdf.get(column) for column in VAULT_SLOT_KDF_COLUMNS)


def upsert_vault_slot(
    user_id: str,
    *,
    method: str,
    slot_id: str | None = None,
    label: str | None = None,
    kdf: dict | None = None,
    credential_id: str | None = None,
    prf_salt: str | None = None,
    rp_id: str | None = None,
    public_key: str,
    wrapped_private_key: str,
    sealed_dek: str | None,
    meets_production_min: bool,
    strength_basis: str | None = None,
    replaces_access: bool = False,
) -> str:
    """Write a format-2 slot, replacing the row `slot_id` names if it already exists.

    Identity is by slot id alone — never re-derived from (user, method) — because the caller has
    already bound that id into the AAD of the material being stored. A row written under one id and
    saved over another would be unopenable."""
    kdf_assignments = ", ".join(f"{column} = ?" for column in VAULT_SLOT_KDF_COLUMNS)
    with get_control_db() as conn:
        existing = conn.execute("SELECT id FROM vault_slot WHERE id = ?", (slot_id,)).fetchone() if slot_id else None
        # `replaces_access` is stated here rather than left to the column default: the default only
        # applies to an INSERT that omits the column, so the UPDATE arm below would otherwise carry a
        # stale flag from whatever the row held before.
        values = (
            method, label, *_kdf_values(kdf), credential_id, prf_salt, rp_id,
            public_key, wrapped_private_key, sealed_dek, 1 if meets_production_min else 0,
            strength_basis, 1 if replaces_access else 0,
        )
        if existing:
            conn.execute(
                f"""
                UPDATE vault_slot SET
                    method = ?, label = ?, format = 2,
                    {kdf_assignments},
                    credential_id = ?, prf_salt = ?, rp_id = ?,
                    public_key = ?, wrapped_private_key = ?, sealed_dek = ?,
                    sealed_dek_prev = NULL, wrapped_dek = NULL,
                    meets_production_min = ?, strength_basis = ?, replaces_access = ?,
                    updated_at = datetime('now')
                WHERE id = ?
                """,
                values + (existing["id"],),
            )
            return existing["id"]
        new_id = slot_id or str(uuid.uuid4())
        columns = ("id", "user_id", "method", "label", *VAULT_SLOT_KDF_COLUMNS, "credential_id", "prf_salt",
                   "rp_id", "public_key", "wrapped_private_key", "sealed_dek", "meets_production_min",
                   "strength_basis", "replaces_access")
        conn.execute(
            f"INSERT INTO vault_slot ({', '.join(columns)}, format) VALUES ({', '.join('?' * len(columns))}, 2)",
            (new_id, user_id) + values,
        )
        return new_id


def rewrap_vault_slot_secret(
    slot_id: str,
    *,
    wrapped_private_key: str,
    kdf: dict,
    meets_production_min: bool,
    strength_basis: str | None,
    keeps_secret: bool = False,
    old_fingerprint: str | None = None,
    new_fingerprint: str | None = None,
):
    """Re-guard an existing slot's private key under a new KEK, touching nothing else.

    A passphrase change replaces only the KEK, so the keypair and the DEK's seal stay exactly as they
    are — no other slot is disturbed, no credential is re-encrypted, and nothing mid-rotation is
    disrupted. Re-sealing here as well would be busywork that quietly discards `sealed_dek_prev`.

    `keeps_secret` marks the other reason to rewrap: the same passphrase under a stronger KDF. The
    credentials-export history then moves with the wrapping, for the reason it does on a format upgrade
    (`upgrade_vault_slot_to_format_2`) — the files it names still open with exactly the passphrase they
    did. After a real change those files need the *old* passphrase, so the history stays behind and the
    change dialog stops counting them as at stake."""
    kdf_assignments = ", ".join(f"{column} = ?" for column in VAULT_SLOT_KDF_COLUMNS)
    with get_control_db() as conn:
        conn.execute(
            f"""
            UPDATE vault_slot
               SET wrapped_private_key = ?, {kdf_assignments},
                   meets_production_min = ?, strength_basis = ?, updated_at = datetime('now')
             WHERE id = ?
            """,
            (wrapped_private_key, *_kdf_values(kdf), 1 if meets_production_min else 0,
             strength_basis, slot_id),
        )
        if keeps_secret and old_fingerprint and new_fingerprint:
            conn.execute(
                "UPDATE credentials_export SET wrapped_dek_fingerprint = ? WHERE wrapped_dek_fingerprint = ?",
                (new_fingerprint, old_fingerprint),
            )


def set_vault_slot_strength(slot_id: str, *, meets_production_min: bool, strength_basis: str):
    """Record a passphrase's verdict under the current rule, judged the moment it was typed.

    Leaves `updated_at` alone: nothing about how the slot opens has changed."""
    with get_control_db() as conn:
        conn.execute(
            "UPDATE vault_slot SET meets_production_min = ?, strength_basis = ? WHERE id = ?",
            (1 if meets_production_min else 0, strength_basis, slot_id),
        )


def clear_passphrase_strength_bases() -> int:
    """Forget what every passphrase verdict was judged under, so each reads as unchecked until typed.
    Leaves the verdict itself. Returns how many slots it touched."""
    with get_control_db() as conn:
        return conn.execute(
            "UPDATE vault_slot SET strength_basis = NULL WHERE method = 'passphrase'"
        ).rowcount


def set_vault_slot_rp_id(slot_id: str, rp_id: str):
    """Record the host name a passkey slot answered under. Leaves `updated_at` alone, like the above."""
    with get_control_db() as conn:
        conn.execute("UPDATE vault_slot SET rp_id = ? WHERE id = ?", (rp_id, slot_id))


def set_vault_slot_sealed_dek(slot_id: str, sealed_dek: str, *, keep_previous: bool = False):
    """Point a slot at a (new) DEK. `keep_previous` retains the outgoing seal in `sealed_dek_prev` so a
    rotation interrupted before the ciphertext is rewritten leaves both keys reachable."""
    with get_control_db() as conn:
        conn.execute(
            f"""
            UPDATE vault_slot
               SET sealed_dek_prev = {'sealed_dek' if keep_previous else 'NULL'},
                   sealed_dek = ?,
                   updated_at = datetime('now')
             WHERE id = ?
            """,
            (sealed_dek, slot_id),
        )


def clear_vault_slot_previous_deks():
    """Drop every retained previous seal — the last step of a rotation, once no ciphertext needs the
    old key. Workspace-wide because the DEK is workspace-wide: a rotation either finished for everyone
    or has not finished."""
    with get_control_db() as conn:
        conn.execute("UPDATE vault_slot SET sealed_dek_prev = NULL WHERE sealed_dek_prev IS NOT NULL")


def delete_vault_slot(slot_id: str):
    with get_control_db() as conn:
        conn.execute("DELETE FROM vault_slot WHERE id = ?", (slot_id,))


def delete_vault_slots(user_id: str, method: str | None = None):
    with get_control_db() as conn:
        if method is None:
            conn.execute("DELETE FROM vault_slot WHERE user_id = ?", (user_id,))
        else:
            conn.execute(
                "DELETE FROM vault_slot WHERE user_id = ? AND method = ?",
                (user_id, method),
            )


def delete_all_vault_slots():
    """Drop every slot in the workspace — the first step of a vault reset.

    Workspace-wide rather than per-user because the DEK is workspace-wide: leaving any slot behind would
    leave the old DEK reachable, and a reset whose whole purpose is that the old key stops opening
    anything would have done nothing. Distinct from `delete_vault_slots`, which ends *one person's*
    access to a vault that carries on existing.
    """
    with get_control_db() as conn:
        conn.execute("DELETE FROM vault_slot")


def vault_slot_count() -> int:
    """Slots that hold the DEK. A pending slot is deliberately not counted: the vault "exists" once
    some slot can open it, and counting a request to join as an existing vault would let the first
    user's own enrollment mint a second DEK over the top of the real one."""
    with get_control_db() as conn:
        return conn.execute(f"SELECT COUNT(*) FROM vault_slot WHERE {_HOLDS_DEK}").fetchone()[0]


def all_slots_meet_production_min() -> bool:
    # Production readiness is an *all-slots* property: the DEK is only as strong as its weakest wrap,
    # so a single weak passphrase slot would let an offline attacker recover the DEK (and every token).
    # Pending slots are exempt because they wrap nothing yet — the grant is where they start counting.
    with get_control_db() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM vault_slot WHERE {_HOLDS_DEK}").fetchone()[0]
        if total == 0:
            return False
        weak = conn.execute(
            f"SELECT COUNT(*) FROM vault_slot WHERE {_HOLDS_DEK} AND meets_production_min = 0"
        ).fetchone()[0]
    return weak == 0


def upgrade_vault_slot_to_format_2(
    slot_id: str,
    *,
    public_key: str,
    wrapped_private_key: str,
    sealed_dek: str,
    old_fingerprint: str | None,
    new_fingerprint: str,
):
    """Convert one legacy slot to the keypair format, carrying its credentials-export history with it.

    Re-pointing `credentials_export` is not bookkeeping: those rows answer "which backups would a
    passphrase change strand", keyed by the wrapping in force. The upgrade changes which value that is
    while changing *nothing* about which passphrase opens those files, so leaving the rows behind would
    silently stop the change dialog naming backups that are still perfectly restorable.
    """
    with get_control_db() as conn:
        conn.execute(
            """
            UPDATE vault_slot
               SET format = 2, public_key = ?, wrapped_private_key = ?, sealed_dek = ?,
                   wrapped_dek = NULL, updated_at = datetime('now')
             WHERE id = ?
            """,
            (public_key, wrapped_private_key, sealed_dek, slot_id),
        )
        if old_fingerprint:
            conn.execute(
                "UPDATE credentials_export SET wrapped_dek_fingerprint = ? WHERE wrapped_dek_fingerprint = ?",
                (new_fingerprint, old_fingerprint),
            )


def record_credentials_export(user_id: str | None, wrapped_dek_fingerprint: str, *,
                              recovery_issued_at: str | None = None,
                              passkey_credential_ids: list[str] | None = None,
                              seal_digest: str | None = None,
                              backup_id: str | None = None) -> None:
    """Note that a credentials backup carries this member's wrapping of the DEK, and what else of theirs
    opens it.

    Append-only and unbounded in principle, but bounded in practice by how often a person exports
    credentials by hand; pruning would cost the exact history the change warning reads."""
    with get_control_db() as conn:
        conn.execute(
            "INSERT INTO credentials_export (id, user_id, wrapped_dek_fingerprint, recovery_issued_at, "
            "passkey_credential_ids, seal_digest, backup_id) VALUES (?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), user_id, wrapped_dek_fingerprint, recovery_issued_at,
             json.dumps(passkey_credential_ids or []), seal_digest, backup_id),
        )


def set_credentials_exports_withdrawn(backup_id: str, withdrawn: bool) -> None:
    """Withdraw the credentials-export record made with a backup, or put it back, as its backup history
    row moves into or out of the trash. Withdrawing again keeps the first date."""
    with get_control_db() as conn:
        if withdrawn:
            conn.execute(
                "UPDATE credentials_export SET withdrawn_at = datetime('now') "
                "WHERE backup_id = ? AND withdrawn_at IS NULL",
                (backup_id,),
            )
        else:
            conn.execute("UPDATE credentials_export SET withdrawn_at = NULL WHERE backup_id = ?", (backup_id,))


def credentials_exports_for_fingerprint(fingerprint: str) -> list[dict]:
    """Every recorded export taken against one wrapping, newest first.

    Matching on the fingerprint rather than listing all exports is what makes the warning specific: a
    backup written under a *previous* passphrase was stranded by an earlier change and saying so again
    is noise, while one written under the current wrapping is precisely what the next change breaks."""
    if not fingerprint:
        return []
    with get_control_db() as conn:
        rows = conn.execute(
            "SELECT id, exported_at FROM credentials_export "
            "WHERE wrapped_dek_fingerprint = ? AND withdrawn_at IS NULL "
            "ORDER BY exported_at DESC, id DESC",
            (fingerprint,),
        ).fetchall()
    return [dict(r) for r in rows]


def credentials_exports_detail() -> list[dict]:
    """Every recorded export with what opens it and whose secrets those are (`user_name`), newest first.
    `passkey_credential_ids` is decoded to a list."""
    with get_control_db() as conn:
        rows = conn.execute(
            """
            SELECT e.*, COALESCE(u.display_name, u.username) AS user_name
            FROM   credentials_export e LEFT JOIN user_account u ON u.id = e.user_id
            WHERE  e.withdrawn_at IS NULL
            ORDER  BY e.exported_at DESC, e.rowid DESC
            """
        ).fetchall()
    exports = []
    for row in rows:
        entry = dict(row)
        try:
            entry["passkey_credential_ids"] = json.loads(entry["passkey_credential_ids"] or "[]")
        except (TypeError, ValueError):
            entry["passkey_credential_ids"] = []
        exports.append(entry)
    return exports


def record_retired_vault_seals(seal_digests: list[str], reason: str) -> None:
    """Record workspace-key seals that stopped being this vault's. A seal already recorded keeps its first
    reason and date: a resumed rotation passes the same ones again."""
    with get_control_db() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO retired_vault_key (seal_digest, reason) VALUES (?, ?)",
            [(digest, reason) for digest in seal_digests if digest],
        )


def retired_vault_seal_reasons(seal_digests: list[str]) -> set[str]:
    """Why any of these seals were retired; empty when none was."""
    wanted = [d for d in seal_digests if d]
    if not wanted:
        return set()
    with get_control_db() as conn:
        rows = conn.execute(
            f"SELECT DISTINCT reason FROM retired_vault_key WHERE seal_digest IN ({', '.join('?' * len(wanted))})",
            wanted,
        ).fetchall()
    return {r["reason"] for r in rows}


def retired_vault_seals(seal_digests: list[str]) -> list[dict]:
    """The recorded retirements among these seals, newest first, as `{reason, retired_at}`."""
    wanted = [d for d in seal_digests if d]
    if not wanted:
        return []
    with get_control_db() as conn:
        rows = conn.execute(
            f"SELECT reason, retired_at FROM retired_vault_key WHERE seal_digest IN ({', '.join('?' * len(wanted))}) "
            "ORDER BY retired_at DESC, rowid DESC",
            wanted,
        ).fetchall()
    return [dict(r) for r in rows]


def forget_retired_vault_seals(seal_digests: list[str]) -> None:
    """Drop the retirement records of these seals, for a key the operator has chosen to put back."""
    wanted = [d for d in seal_digests if d]
    if wanted:
        with get_control_db() as conn:
            conn.execute(
                f"DELETE FROM retired_vault_key WHERE seal_digest IN ({', '.join('?' * len(wanted))})", wanted)


def latest_vault_key_retirement(reasons: tuple[str, ...] | None = None) -> dict | None:
    """The most recent retirement, optionally of the given reasons, as `{reason, retired_at}`."""
    where = f"WHERE reason IN ({', '.join('?' * len(reasons))})" if reasons else ""
    with get_control_db() as conn:
        row = conn.execute(
            f"SELECT reason, retired_at FROM retired_vault_key {where} ORDER BY retired_at DESC, rowid DESC LIMIT 1",
            tuple(reasons or ()),
        ).fetchone()
    return dict(row) if row else None


# When the data provider credentials were last replaced at their providers (`exposure_response`), which
# leaves every credentials backup made before it holding credentials the providers no longer accept. Stored
# in the `datetime('now')` shape `credentials_export.exported_at` has, so the two compare as strings.
_CREDENTIALS_REISSUED_AT = "credentials_reissued_at"


def record_credentials_reissued() -> None:
    with get_control_db() as conn:
        conn.execute(
            """
            INSERT INTO app_setting (key, value, updated_at) VALUES (?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (_CREDENTIALS_REISSUED_AT,),
        )


def credentials_reissued_at() -> str | None:
    return get_app_setting(_CREDENTIALS_REISSUED_AT)


def credentials_exports_any() -> list[dict]:
    """Every recorded credentials export, newest first, whatever wrapping it carried: whether any backup
    holds credentials that reissuing them at their providers has just retired."""
    with get_control_db() as conn:
        rows = conn.execute(
            "SELECT id, exported_at FROM credentials_export WHERE withdrawn_at IS NULL "
            "ORDER BY exported_at DESC, id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


# --- App-login passkeys (see the `app_passkey` table and `services/app_passkey.py`) ---------------


def list_app_passkeys(user_id: str) -> list[dict]:
    """One user's registered login passkeys, oldest first. Never returns the public key: the settings
    list only ever needs to say which devices exist, where each works and when each was last used."""
    with get_control_db() as conn:
        rows = conn.execute(
            """
            SELECT id, label, transports, rp_id AS host, created_at, last_used_at
            FROM app_passkey WHERE user_id = ? ORDER BY created_at, id
            """,
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_app_passkey_credential_ids(user_id: str) -> list[str]:
    """Just the credential ids, for the `excludeCredentials` list a registration ceremony sends."""
    with get_control_db() as conn:
        rows = conn.execute(
            "SELECT credential_id FROM app_passkey WHERE user_id = ? ORDER BY created_at, id",
            (user_id,),
        ).fetchall()
    return [row["credential_id"] for row in rows]


def record_served_host(host: str) -> None:
    with get_control_db() as conn:
        # Read first: this runs on every page load, and a write lock is needed only the first time.
        if conn.execute("SELECT 1 FROM served_host WHERE host = ?", (host,)).fetchone() is None:
            conn.execute("INSERT OR IGNORE INTO served_host (host) VALUES (?)", (host,))


def list_served_hosts() -> list[str]:
    with get_control_db() as conn:
        return [r["host"] for r in conn.execute("SELECT host FROM served_host ORDER BY host")]


def list_all_app_passkey_credentials(rp_id: str | None) -> list[dict]:
    """Every active account's sign-in credential ids and transports that can answer at `rp_id`, for the
    sign-in screen's `allowCredentials`. A disabled account's passkeys are left out, and so is one
    registered under another host name: listing either would only offer a device prompt that cannot
    succeed. One whose name was never recorded may answer anywhere."""
    with get_control_db() as conn:
        rows = conn.execute(
            """
            SELECT p.credential_id, p.transports
            FROM app_passkey p JOIN user_account u ON u.id = p.user_id
            WHERE u.status = 'active' AND (p.rp_id IS NULL OR p.rp_id = ?)
            ORDER BY p.created_at, p.id
            """,
            (rp_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_app_passkey_by_credential(credential_id: str) -> dict | None:
    """The row a presented assertion belongs to, with the account it authenticates.

    Joined rather than looked up in two steps because a credential row whose user has since been
    deleted must not authenticate anything, and an inner join is what makes that unrepresentable."""
    with get_control_db() as conn:
        row = conn.execute(
            """
            SELECT p.*, u.status AS user_status
            FROM app_passkey p JOIN user_account u ON u.id = p.user_id
            WHERE p.credential_id = ?
            """,
            (credential_id,),
        ).fetchone()
    return dict(row) if row else None


def add_app_passkey(
    user_id: str,
    *,
    credential_id: str,
    public_key: str,
    sign_count: int = 0,
    transports: str | None = None,
    label: str | None = None,
    rp_id: str | None = None,
) -> dict:
    passkey_id = str(uuid.uuid4())
    with get_control_db() as conn:
        conn.execute(
            """
            INSERT INTO app_passkey (id, user_id, credential_id, public_key, sign_count, transports, label, rp_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (passkey_id, user_id, credential_id, public_key, sign_count, transports, label or None, rp_id),
        )
        row = conn.execute(
            "SELECT id, label, transports, rp_id AS host, created_at, last_used_at FROM app_passkey WHERE id = ?",
            (passkey_id,),
        ).fetchone()
    return dict(row)


def record_app_passkey_use(passkey_id: str, sign_count: int, rp_id: str):
    """A verified sign-in. It ran under `rp_id`, which proves that is the passkey's name."""
    with get_control_db() as conn:
        conn.execute(
            "UPDATE app_passkey SET sign_count = ?, rp_id = ?, last_used_at = datetime('now') WHERE id = ?",
            (sign_count, rp_id, passkey_id),
        )


def rename_app_passkey(user_id: str, passkey_id: str, label: str | None) -> bool:
    """Change the name this install shows for one of this user's passkeys. Scoped to the owner in the
    statement itself, as the delete is. The name the device's own passkey list shows was set at
    registration and is not this."""
    with get_control_db() as conn:
        cursor = conn.execute(
            "UPDATE app_passkey SET label = ? WHERE id = ? AND user_id = ?", (label, passkey_id, user_id),
        )
    return cursor.rowcount > 0


def delete_app_passkey(user_id: str, passkey_id: str) -> bool:
    """Remove one of this user's passkeys. Scoped to the owner in the statement itself, so a mistaken
    caller cannot delete somebody else's by id."""
    with get_control_db() as conn:
        cursor = conn.execute(
            "DELETE FROM app_passkey WHERE id = ? AND user_id = ?",
            (passkey_id, user_id),
        )
    return cursor.rowcount > 0



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


def user_password_matches(user_id: str, password: str) -> bool:
    """Whether `password` is this account's, for a signed-in user proving it before a change. Unlike
    `authenticate_user` it is not a sign-in, so it leaves the last-login time alone."""
    stored = _user_password_hash(user_id)
    return password_is_set(stored) and verify_password(password, stored)


def update_user(
    user_id: str,
    *,
    username: str | None = None,
    display_name: str | None = None,
    password: str | None = None,
    role: str | None = None,
    status: str | None = None,
    must_change_password: bool | None = None,
    keep_sign_in_session: str | None = None,
) -> dict:
    """Edit an account. **Setting a password or disabling the account signs it out everywhere**, in the
    same transaction as the change: either is how somebody else's access to the account is ended, and a
    session they already hold would otherwise outlive it. `keep_sign_in_session` is the digest of the
    session making the change, when it is the account's own, so changing a password does not sign out
    the browser that changed it."""
    current = get_user_by_id(user_id)
    if not current:
        raise ValueError("user not found")

    fields = []
    params = []
    ends_sessions = False

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
            ends_sessions = True
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
            ends_sessions = ends_sessions or normalized_status != "active"

        if not fields:
            return current

        params.append(user_id)
        conn.execute(
            f"UPDATE user_account SET {', '.join(fields)} WHERE id = ?",
            params,
        )
        if ends_sessions:
            conn.execute(
                "DELETE FROM sign_in_session WHERE user_id = ? AND id_digest IS NOT ?",
                (user_id, keep_sign_in_session),
            )

    return get_user_by_id(user_id)


def restore_admin_access(user_id: str, password: str) -> dict:
    """The command-line way back in (`backend/account_recovery.py`): set the password and remove
    everything else that could still keep this account out — a disabled status, a member role that cannot
    reach the settings, a second factor whose authenticator is gone — and sign it out everywhere. One
    transaction, so a failure leaves the account exactly as it was. The vault is untouched: a slot opens
    only with its own secret, which nothing here has."""
    validate_password_for_policy(password)
    # Hashed before the write begins, so the key stretching is not spent holding the write lock.
    password_hash = _hash_password(password)
    with get_control_db() as conn:
        updated = conn.execute(
            """
            UPDATE user_account
            SET password_hash = ?, must_change_password = 0, role = 'admin', status = 'active',
                totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL
            WHERE id = ?
            """,
            (password_hash, user_id),
        ).rowcount
        if not updated:
            raise ValueError("user not found")
        conn.execute("DELETE FROM user_recovery_code WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM sign_in_session WHERE user_id = ?", (user_id,))
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
            "UPDATE user_account SET totp_secret = ?, totp_enabled = 1, totp_last_step = NULL WHERE id = ?",
            (secret, user_id),
        )


def disable_totp(user_id: str):
    with get_control_db() as conn:
        conn.execute(
            "UPDATE user_account SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?",
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


# --- Identities as a backup carries them ----------------------------------------------------------
#
# The accounts part of a backup (`services/accounts_backup.py`) is the identities, the ways they sign in,
# and the two settings that make up the perimeter. Everything else in this database describes the machine
# rather than the people on it, and stays: the session signing secret and cookie name, the sessions
# themselves, the workspace record with its path to this machine's financial database, the error counters
# and the like. The coverage test lists each table left out with its reason.
#
# Restoring them is a replacement, never a merge. The file is the set of people to have, so whoever it
# does not name is gone and everyone is signed out — the replaced rows are what a live session was
# authenticated against.

PERIMETER_SETTING_KEYS = ("auth_enabled", "password_policy")

# (part name, table). The part name is what the backup calls the rows; it outlives the table's.
IDENTITY_TABLES = (
    ("users", "user_account"),
    ("recovery_codes", "user_recovery_code"),
    ("passkeys", "app_passkey"),
)

# Rewritten on the way in: there is one workspace, and its record belongs to this machine.
_MACHINE_COLUMNS = {"user_account": {"tenant_id"}}


def export_identities() -> dict:
    with get_control_db() as conn:
        part = {
            name: [
                {k: v for k, v in dict(row).items() if k not in _MACHINE_COLUMNS.get(table, ())}
                for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")
            ]
            for name, table in IDENTITY_TABLES
        }
        part["settings"] = [
            dict(row) for row in conn.execute(
                f"SELECT key, value FROM app_setting WHERE key IN ({', '.join('?' * len(PERIMETER_SETTING_KEYS))})"
                " ORDER BY key",
                PERIMETER_SETTING_KEYS,
            )
        ]
    return part


def _workspace_tenant_id(conn, users: list[dict]) -> str:
    """The workspace record restored identities belong to, created when no identity has ever existed here."""
    row = conn.execute("SELECT id FROM tenant ORDER BY created_at, id LIMIT 1").fetchone()
    if row:
        return row["id"]
    tenant_id = _workspace_id_for_new_record()
    first = next((u for u in users if u.get("role") == "admin"), users[0] if users else {})
    name = (first.get("display_name") or first.get("username") or "Workspace").strip() or "Workspace"
    conn.execute(
        "INSERT INTO tenant (id, slug, name) VALUES (?, ?, ?)",
        (tenant_id, _unique_tenant_slug(conn, _tenant_slug(first.get("username") or name)), name),
    )
    return tenant_id


def _insert_rows(conn, table: str, rows: list[dict], *, upsert: bool = False) -> None:
    """Insert backup rows, keeping only the columns this schema has: a column added since the backup takes
    its default, and one since dropped is skipped."""
    live = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for row in rows:
        columns = [c for c in row if c in live]
        sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})"
        if upsert:
            updates = ", ".join(f"{c} = excluded.{c}" for c in columns if c != "id")
            sql += f" ON CONFLICT(id) DO UPDATE SET {updates}"
        conn.execute(sql, [row[c] for c in columns])


def replace_identities(part: dict, vault_slots: list[dict] | None) -> None:
    """Make this database's people, their ways in and the perimeter exactly what `part` holds, with
    `vault_slots` (`crypto_service.vault_slot_rows`) as the whole vault. One transaction. With
    `vault_slots` None the vault is left as it is, less the slots of anyone the part does not name.

    A person in both keeps their row and its id, which is what this machine's own records of them hang
    off (`credentials_export`). Usernames are moved out of the way first, because two people can trade
    names between the backup and now and a row-by-row update would collide on the unique column midway.
    """
    users = list(part.get("users") or [])
    keep = [u["id"] for u in users]
    with get_control_db() as conn:
        tenant_id = _workspace_tenant_id(conn, users)
        conn.execute("DELETE FROM sign_in_session")
        if vault_slots is not None:
            conn.execute("DELETE FROM vault_slot")
        conn.execute("DELETE FROM user_recovery_code")
        conn.execute("DELETE FROM app_passkey")
        conn.execute(
            f"DELETE FROM user_account WHERE id NOT IN ({', '.join('?' * len(keep))})", keep,
        )
        conn.execute("UPDATE user_account SET username = 'restoring:' || id")
        _insert_rows(conn, "user_account", [{**u, "tenant_id": tenant_id} for u in users], upsert=True)
        _insert_rows(conn, "user_recovery_code", list(part.get("recovery_codes") or []))
        _insert_rows(conn, "app_passkey", list(part.get("passkeys") or []))
        if vault_slots is not None:
            _insert_rows(conn, "vault_slot", [s for s in vault_slots if s["user_id"] in set(keep)])

        settings = {
            s["key"]: s["value"] for s in part.get("settings") or [] if s.get("key") in PERIMETER_SETTING_KEYS
        }
        for key in PERIMETER_SETTING_KEYS:
            if key in settings:
                conn.execute(
                    """
                    INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
                    """,
                    (key, str(settings[key])),
                )
            else:
                # Absent from the file means the default was in force there, so it is here too.
                conn.execute("DELETE FROM app_setting WHERE key = ?", (key,))
