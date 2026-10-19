# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The accounts part of a backup: who can sign in, how, and the data-source credentials with the vault
that opens them.

Every backup carries it beside the financial data, and the restore chooses which to apply. It exists as a
part of its own because the two halves of a working install live in different databases.
The credentials' ciphertext is in the data database and the key that opens it in the control database's
vault slots; that split is what keeps a leaked database from leaking credentials. A file that carried only
one half would restore and never sync, so the credentials, the vault and the people the vault belongs to
travel as one part and are restored as one.

**Restore replaces, it never merges.** Whatever install it lands on — an empty one, the one it came from,
or another — what was there is gone afterwards, so the ciphertext and the slots go back exactly as they
were exported, with no secret asked for and nothing re-encrypted. The slots are the exporter's own, the only
ones the export gate can vouch for (`crypto_service.credentials_export_refusal`); another member comes back
without vault access and asks for it again. A credential linked after the backup was taken is under a key
the restored vault does not hold, so it is cleared and its connection flagged for reconnection, as a vault
reset leaves one.

**The credentials are left out rather than the backup refused** when they could not travel safely or
usefully: the exporter's passphrase has not cleared the current rule, or the exporter cannot open the
vault. Every way into the vault a file carries has to resist offline guessing on its own, whatever else
protects the file, but a backup of the ledger must not wait on the vault — the ledger cannot be got back,
and a credential can be re-linked. A file without them restores the people and leaves the vault and the
credentials on the target alone.

The one thing a restore must not do is leave nobody able to sign in, so a file that turns sign-in on is
restored only by someone who can show the password of an administrator in it (`check_restoring_admin`).

Archive layout and the restore's sequencing are the backup router's (`routers/import_export/backup.py`);
this module holds what the part contains and what applying it means.
"""

import uuid

from backend.db import control_database
from backend.db.database import get_db
from backend.services import crypto_service

# The part's own format, beside the data payload's `version`. Recorded in `meta.json` as
# `accounts_version` whenever the part is present.
ACCOUNTS_PART_VERSION = 1
RESTORABLE_ACCOUNTS_PART_VERSIONS = (1,)

# The part's row lists, each an NDJSON member, in this order. `credentials` is the one JSON member, and is
# absent when the credentials were left out.
ROW_LISTS = ("users", "recovery_codes", "passkeys", "settings", "backup_keys")


class AdminPasswordRequired(Exception):
    """The file turns sign-in on and no matching administrator password came with the request."""

    def __init__(self, admins: list[str], *, attempted: bool):
        super().__init__("admin password required")
        self.admins = admins
        self.attempted = attempted


def _holds_ciphertext(conn) -> bool:
    return bool(
        conn.execute("SELECT 1 FROM connection WHERE credential_enc IS NOT NULL LIMIT 1").fetchone()
        or conn.execute("SELECT 1 FROM provider_config WHERE secret_enc IS NOT NULL LIMIT 1").fetchone()
    )


def _credentials(conn, user: dict | None) -> tuple[dict | None, dict | None]:
    """`(credentials, why_left_out)`. Both None when there is nothing to carry: no vault access and no
    stored credential."""
    user_id = (user or {}).get("id")
    slots = crypto_service.export_vault_slots(user_id) if user_id else []
    if not slots:
        if not _holds_ciphertext(conn):
            return None, None
        return None, {
            "code": "vault_access_required",
            "message": "This user cannot open the vault, so the backup will not contain the data provider "
                       "credentials. Someone who can open it can grant access.",
        }
    refusal = crypto_service.credentials_export_refusal(user_id)
    if refusal:
        return None, refusal
    return {
        "connections": [dict(r) for r in conn.execute(
            "SELECT id, provider, external_id, credential, credential_enc, institution FROM connection"
            " ORDER BY rowid"
        )],
        "provider_configs": [dict(r) for r in conn.execute(
            "SELECT provider, client_id, secret, secret_enc, env FROM provider_config ORDER BY rowid"
        )],
        "vault_slots": slots,
    }, None


def credentials_left_out(conn, user: dict | None) -> dict | None:
    """Why a backup `user` takes now would leave the credentials out, or None. `conn` is the data
    database. For the backup surface to say before the file is made."""
    return _credentials(conn, user)[1]


def collect(conn, user: dict | None) -> dict:
    """The accounts part as it stands now, for `user` to export. `conn` is the data database.

    `credentials` is None when they are left out, and `credentials_left_out` then says why."""
    credentials, left_out = _credentials(conn, user)
    part = control_database.export_identities()
    part["backup_keys"] = [dict(r) for r in conn.execute("SELECT * FROM backup_recipient ORDER BY rowid")]
    part["credentials"] = credentials
    part["credentials_left_out"] = left_out
    return part


def record_export(user: dict | None, part: dict, backup_id: str | None = None) -> None:
    """Note which passphrase wrapping went into the file, so a later passphrase change can name the
    backups it is about to strand, and what else opens it, for the reset dialog to say
    (`control_database.record_credentials_export`). `backup_id` names the file's backup history row."""
    if part["credentials"] is None:
        return
    slots = part["credentials"]["vault_slots"]
    fingerprint = crypto_service.exported_slots_fingerprint(slots)
    if user and user.get("id") and fingerprint:
        control_database.record_credentials_export(
            user["id"], fingerprint,
            recovery_issued_at=next((s.get("issued_at") for s in slots if s.get("method") == "recovery"), None),
            passkey_credential_ids=[s["credential_id"] for s in slots if s.get("method") == "passkey"],
            seal_digest=crypto_service.exported_slots_seal_digest(slots),
            backup_id=backup_id,
        )


def check_restoring_admin(part: dict, username: str | None, password: str | None) -> None:
    """Refuse a restore that would turn sign-in on unless the person restoring can sign in afterwards.

    The proof is the password of an active administrator in the file, checked against the file's own hash.
    It is not held to the sign-in attempt limit: whoever has the file can test guesses against that hash
    offline, so a limit here would protect nothing.
    """
    settings = {s.get("key"): s.get("value") for s in part.get("settings") or []}
    if str(settings.get("auth_enabled")) != "1":
        return
    admins = [
        u for u in part.get("users") or []
        if u.get("role") == "admin" and (u.get("status") or "active") == "active"
        and control_database.password_is_set(u.get("password_hash"))
    ]
    wanted = (username or "").strip().lower()
    match = next((u for u in admins if u["username"].lower() == wanted), None)
    if match and password and control_database.verify_password(password, match["password_hash"]):
        return
    raise AdminPasswordRequired([u["username"] for u in admins], attempted=bool(wanted or password))


def write_credentials(conn, connections, provider_configs, connection_secret, provider_secret) -> int:
    """Make the stored credentials exactly the given set. `conn` is the data database, inside the caller's
    transaction.

    Credentials are written onto the connection rows rather than the rows being replaced: a row is shared
    with the financial data — its account links, mappings, import cards and sync state hang off it, and
    `connection_account` cascades from it — so replacing it would erase every account mapping. A row is
    matched by id, then by provider handle; one the install never had is created. A connection the set does
    not hold keeps its row and loses its credential, flagged for reconnection, as a vault reset leaves one.

    `connection_secret(c)` and `provider_secret(pc)` give the `(plaintext column, ciphertext column)` pair to
    store for one incoming row, which is where a caller decides between copying and re-keying.
    """
    restored_ids: list[str] = []
    for c in connections:
        credential, credential_enc = connection_secret(c)
        local = None
        if c.get("id"):
            local = conn.execute("SELECT id FROM connection WHERE id = ?", (c["id"],)).fetchone()
        if local is None:
            local = conn.execute(
                "SELECT id FROM connection WHERE provider = ? AND external_id = ?",
                (c["provider"], c["external_id"]),
            ).fetchone()
        if local is None:
            connection_id = c.get("id") or str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (connection_id, c["provider"], c["external_id"], credential, credential_enc,
                 c.get("institution")),
            )
        else:
            connection_id = local["id"]
            # The handle travels with the credential: the ciphertext is bound to (provider, external_id),
            # so a credential written back under a different handle would never open.
            conn.execute(
                """
                UPDATE connection
                SET    provider = ?, external_id = ?, credential = ?, credential_enc = ?,
                       institution = COALESCE(?, institution)
                WHERE  id = ?
                """,
                (c["provider"], c["external_id"], credential, credential_enc, c.get("institution"),
                 connection_id),
            )
        restored_ids.append(connection_id)
    placeholders = ", ".join("?" * len(restored_ids))
    conn.execute(
        "UPDATE connection SET credential = '', credential_enc = NULL, reauth_required = 1"
        + (f" WHERE id NOT IN ({placeholders})" if restored_ids else ""),
        restored_ids,
    )
    conn.execute("DELETE FROM provider_config")
    for pc in provider_configs:
        secret, secret_enc = provider_secret(pc)
        conn.execute(
            """
            INSERT OR IGNORE INTO provider_config (provider, client_id, secret, secret_enc, env)
            VALUES (?, ?, ?, ?, ?)
            """,
            (pc["provider"], pc.get("client_id") or "", secret, secret_enc, pc.get("env") or "sandbox"),
        )
    return len(connections) + len(provider_configs)


def apply(part: dict) -> dict:
    """Replace this install's accounts with the part's. The caller has already run `check_restoring_admin`.

    Two databases and no transaction spanning them, so the order is chosen for what an interruption leaves.
    The data database goes first — the credentials, copied as exported, and the backup keys — then the
    control database's people and vault in one transaction. Stopping between the two leaves credentials
    sealed under the backup's key beside the old vault; restoring the same file again completes it, since
    every step is a replacement.

    A part without credentials leaves the vault and the credentials here as they are, except that the
    people it does not name take their vault access with them. If nobody who can open the vault is left,
    the credentials could never be opened again, and they are cleared as a vault reset clears them.
    """
    credentials = part.get("credentials")
    kept = {u["id"] for u in part.get("users") or []}
    with get_db() as conn:
        if credentials is not None:
            restored = write_credentials(
                conn,
                [dict(c) for c in credentials.get("connections") or []],
                [dict(pc) for pc in credentials.get("provider_configs") or []],
                lambda c: (c.get("credential") or "", c.get("credential_enc")),
                lambda pc: (pc.get("secret") or "", pc.get("secret_enc")),
            )
        else:
            restored = 0
            vault_survives = any(
                crypto_service.slot_holds_dek(s) and s["user_id"] in kept
                for s in control_database.list_vault_slots()
            )
            if not vault_survives:
                crypto_service.clear_stored_secrets(conn)
        conn.execute("DELETE FROM backup_recipient")
        live = {r["name"] for r in conn.execute("PRAGMA table_info(backup_recipient)").fetchall()}
        for row in part.get("backup_keys") or []:
            columns = [c for c in row if c in live]
            conn.execute(
                f"INSERT INTO backup_recipient ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
                [row[c] for c in columns],
            )
    control_database.replace_identities(
        part, crypto_service.vault_slot_rows(credentials["vault_slots"]) if credentials is not None else None,
    )
    # Every unlock and proof in this process was taken against the people and vault just replaced.
    crypto_service.lock_all()
    return {
        "users": len(part.get("users") or []),
        "credentials": restored,
        "backup_keys": len(part.get("backup_keys") or []),
    }
