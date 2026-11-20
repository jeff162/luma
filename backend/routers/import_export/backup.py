# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Backup / restore, credentials, and CSV export.

This module covers the "data leaves the app" / "data comes back in" concerns that are otherwise
independent of the import-run workflow:

- **CSV export** (`/transactions.csv`) — a filtered, flattened dump of the ledger for spreadsheets.
- **Backup/restore** (`/backup?scope=`, `/restore`, `/restore-file`) — three backups named by what they
  protect: the financial data, the accounts (`services/accounts_backup.py`: identities, the perimeter,
  backup keys, and the data-source credentials as ciphertext with the vault that opens them), and both in
  one file. The financial data is everything in the data DB except credentials, and round-trips it: owners,
  accounts, categories, rules, import profiles/batches/history, transactions,
  the whole tag system (`tag` + every attachment: `txn_tag`/`category_tag`/`account_tag`/`rule_tag`),
  the account-pair distinct assertions, recurring series (`recurring_series` + the `txn` membership
  link), and UI/layout preferences (`ui_preference`). Restore wipes and rebuilds inside one
  transaction with foreign-key checks deferred, repairing dangling references at the end. The payload
  is stamped with the source `instance_id` + `access_mode`; restore's compatibility guard uses these
  to refuse a silent cross-system/cross-mode wipe (409 unless `force`) while still allowing an empty
  target or a same-instance self-restore. Every restore of the financial data gives the target a new
  `instance_id`, so a backup made before it reads as another system's. (Payload is version 10; versions 7-9 are still accepted,
  with their pre-rename columns translated on restore — v7's account columns
  `plaid_account_id`/`plaid_item_id` to the 6b-3 shape, and pre-v9's `plaid_transaction_id` to
  `external_transaction_id`. Older versions are no longer accepted.)
- **Standalone credentials restore** (`/restore/credentials`, `/restore/credentials-file`) — for files of
  the credentials backup that preceded the accounts part. It is no longer written.

Every backup optionally encrypts to one or more saved RSA recipients (`backup_recipient`):
a random AES-256-GCM content key encrypts the payload and is RSA-OAEP-wrapped per recipient, so a
backup can be decrypted by any holder of a matching private key. The crypto/zip helpers here own
that envelope format; restore inspects an upload, decrypts if needed, and replays it.

**Nothing here holds a backup in memory.** A data backup grows with the ledger, so the export streams
rows from their cursors into zip members and the restore streams them back a line at a time, both by
way of a staging file beside the database; the encrypted path runs the same bytes through an
incremental cipher rather than sealing a finished blob. The CSV export follows the same rule for the
same reason. The one deliberate exception is `build_backup_data`, which materializes a payload for
tests and for the JSON-body restore endpoint that older backups arrive through.

Depends only on `core`, the transactions router's list filter (which the CSV export shares), and shared
services; `core` never imports this module.
"""

import csv
import hashlib
import io
import json
import os
import shutil
import tempfile
import time
import uuid
import zipfile
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend import transport
from backend.authorization import require_admin_or_local
from backend.db.database import (
    CURRENT_VERSION,
    compact_if_worthwhile,
    current_db_path,
    get_db,
    get_db_instance_id,
    get_db_version,
    new_db_instance_id,
    redate_held_sync_duplicate,
    redate_txn_row_to_transaction_date,
    run_post_restore_data_init,
)
from backend.db.demo_data import is_demo_data_loaded
from backend.db import control_database
from backend.db.control_database import auth_required
from backend.app_logging import log_error
from backend.runtime_config import app_name
from backend.time_utils import utcnow_iso
from backend.services import accounts_backup, backup_history, crypto_service, database_health
from backend.services.preferences import SHARED_SCOPE_ID, forget_startup_routes, keep_preferences_of
from backend.services.documents import (
    copy_document_file_from,
    document_file_path,
    documents_dir,
    file_digest,
    is_safe_document_id,
    missing_document_ids,
    sweep_unreferenced_files,
)
from backend.services.providers.config import forget_synced_state, remove_connection, sync_marker_is_live
from backend.services.restore_state import (
    RESTORE_PHASE_DOCUMENTS,
    RESTORE_PHASE_STAGING,
    clear_restore_state,
    get_restore_state,
    require_no_pending_restore,
    set_restore_state,
)
from backend.routers.transactions import transaction_list_filters, transaction_list_scope
from backend.services.transaction_facets import TransactionFacets
from backend.services.txn_splits import txn_effective_sql

from .watch import disable_watching

router = APIRouter()


def _dated_backup_filename(stem: str, suffix: str) -> str:
    """Suggested download name stamped with the *local* date — this is a local-first app, so the
    server clock is the user's clock. Yields names like `luma_backup-2026-06-16.zip` that sort
    chronologically and disambiguate multiple backups without manual renaming.

    Intentionally LOCAL date (`date.today()`), not `utcnow_iso()`: this is a user-facing filename, not
    a stored UTC timestamp, so the naive-UTC convention the timestamp guard enforces does not apply —
    a UTC date would read as "tomorrow" for an evening backup west of UTC, which is exactly the
    surprise we want to avoid in a download name the user recognizes by date."""
    return f"{stem}-{date.today().isoformat()}{suffix}"


# What a split transaction's Category and Group say in an exported CSV. Visible rather than silent, so a
# file opened in a spreadsheet says why those cells are not category names.
SPLIT_EXPORT_MARKER = "--split--"

# Leading characters a spreadsheet reads as the start of a formula. Transaction text is largely written
# by others — a merchant name from a bank, the note on a PayPal payment someone sent — so a cell starting
# with one is prefixed with `'`, which every spreadsheet takes as "this is text". Only text is touched:
# a negative amount starts with `-` and has to stay a number.
SPREADSHEET_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def spreadsheet_safe(value):
    if isinstance(value, str) and value.startswith(SPREADSHEET_FORMULA_PREFIXES) and value != SPLIT_EXPORT_MARKER:
        return f"'{value}"
    return value

EXPORT_COLUMNS = {
    "date":          ("t.date",            "Date"),
    "merchant_name": ("COALESCE(t.display_name, t.merchant_name, t.raw_name)",   "Merchant"),
    "raw_name":      ("t.raw_name",        "Raw description"),
    "amount":        ("t.amount",          "Amount"),
    "account":       ("COALESCE(a.display_name, a.name)", "Account"),
    "category":      ("c.name",            "Category"),
    "group":         ("pc.name",           "Group"),
    "owner":         ("o.name",            "Owner"),
    "notes":         ("t.notes",           "Notes"),
    "is_pending":    ("t.is_pending",      "Pending"),
    "overridden":    ("t.category_overridden", "Manually categorized"),
    "import_batch":  ("t.import_batch_id", "Import batch"),
}


class BackupRecipientCreate(BaseModel):
    label: str
    public_key: str
    enabled: bool = True


class BackupRecipientUpdate(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None


class BackupKeypairRequest(BaseModel):
    # Optional: an empty passphrase yields an unencrypted PKCS8 key, which is a legitimate choice for a
    # file the user is putting somewhere already protected.
    passphrase: Optional[str] = None
    key_size: int = 4096


class RestoreRequest(BaseModel):
    data:             dict
    # Override the compatibility guard (restoring a different system's backup over existing data,
    # or a different access mode). The UI sets this only after an explicit user confirmation.
    force:            bool = False


class CredentialsRestoreRequest(BaseModel):
    data: dict
    # One secret of the member who *produced* the backup, opening one of the slots it carries. Needed only
    # when the file's credentials are not already valid here — a backup from another install, or from
    # before this one's key was replaced — whose ciphertext must be reopened with the key it was sealed
    # under before being re-keyed under this one. At most one is used, in this order.
    passphrase: str | None = None
    recovery_code: str | None = None
    passkey_credential_id: str | None = None
    passkey_prf_output: str | None = None


# --- Encryption envelope + archive (de)serialization -------------------------------------------
# Encrypted archives are ZIPs of {manifest.json, payload.bin}: payload.bin is the inner backup ZIP
# sealed with an AES-256-GCM content key, and manifest.json carries that content key RSA-OAEP-wrapped
# once per recipient. A version-10 plaintext archive is a ZIP of `meta.json` plus one NDJSON member
# per section; versions 7-9 wrote a single JSON object, zipped or bare, which restore still reads.

def _zip_json_bytes(filename: str, payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(filename, json.dumps(payload, indent=2, default=str))
    return buf.getvalue()


def _load_public_key(public_key_text: str):
    key_text = (public_key_text or "").strip().encode("utf-8")
    loaders = [serialization.load_ssh_public_key, serialization.load_pem_public_key]
    last_error = None
    for loader in loaders:
        try:
            return loader(key_text)
        except Exception as exc:
            last_error = exc
    raise HTTPException(status_code=400, detail=f"Invalid public key: {last_error}")


def _load_private_key(private_key_bytes: bytes, passphrase: Optional[str]):
    password = passphrase.encode("utf-8") if passphrase else None
    loaders = [serialization.load_ssh_private_key, serialization.load_pem_private_key]
    last_error = None
    for loader in loaders:
        try:
            return loader(private_key_bytes, password=password)
        except TypeError:
            try:
                return loader(private_key_bytes, password)
            except Exception as exc:
                last_error = exc
        except Exception as exc:
            last_error = exc
    raise HTTPException(status_code=400, detail=f"Invalid private key or passphrase: {last_error}")


def _rsa_fingerprint(public_key) -> str:
    der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    digest = hashes.Hash(hashes.SHA256())
    digest.update(der)
    fp = urlsafe_b64encode(digest.finalize()).decode("ascii").rstrip("=")
    return f"SHA256:{fp}"


# Key sizes offered by the generator and required of a pasted key. The floor is not ceremony: a backup
# is a long-lived artifact, so a key that is merely adequate today is the one that has to hold for the
# decade the file might sit on a drive. The upper end is bounded because the size is caller-supplied and
# generation is CPU-bound — an unbounded value is a request that ties up a worker for minutes.
BACKUP_KEY_SIZES = (2048, 3072, 4096)
MIN_BACKUP_KEY_BITS = 2048


def _validate_backup_recipient_key(public_key_text: str):
    public_key = _load_public_key(public_key_text)
    if not isinstance(public_key, rsa.RSAPublicKey):
        raise HTTPException(status_code=400, detail="Only RSA public keys are supported for encrypted backups")
    if public_key.key_size < MIN_BACKUP_KEY_BITS:
        raise HTTPException(
            status_code=400,
            detail=f"This key is {public_key.key_size}-bit. Backups are long-lived, so keys must be at "
                   f"least {MIN_BACKUP_KEY_BITS}-bit.",
        )
    return public_key, _rsa_fingerprint(public_key)


def _b64url_decode(value: str) -> bytes:
    value = (value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Encrypted backup metadata is missing required key material")
    padding_needed = (-len(value)) % 4
    return urlsafe_b64decode(value + ("=" * padding_needed))


def read_payload_bytes(content: bytes) -> dict:
    """Decode a single-payload backup's bytes — one JSON member in a zip, or bare JSON.

    Not the path any upload takes (those are staged to a file and identified first); this is for callers
    that already hold the bytes, such as a test reading back what an export endpoint returned.
    """
    if zipfile.is_zipfile(io.BytesIO(content)):
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                return _read_single_json_member(zf)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid ZIP backup: {exc}")
    try:
        return json.loads(content.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON backup: {exc}")


# --- Backup recipients (saved RSA public keys for encrypted archives) --------------------------

@router.get("/backup/recipients")
def list_backup_recipients():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, label, public_key, fingerprint, algorithm, enabled, created_at
            FROM   backup_recipient
            ORDER  BY created_at DESC, label
        """).fetchall()
    return [dict(row) for row in rows]


@router.post("/backup/keypair")
def generate_backup_keypair(body: BackupKeypairRequest):
    """Generate an RSA keypair for encrypting backups, and **store nothing**.

    Encrypted backups need a keypair the user owns, and producing one otherwise means knowing an
    `openssl` incantation — a barrier that has nothing to do with the decision being made. So the app
    can make one; what it must not do is keep it.

    This endpoint has no side effects at all: no recipient row, no file, no record that it was called.
    The public half is offered back for the caller to submit to `POST /backup/recipients` *after* the
    user has saved the private half, so a recipient can never exist whose private key was never kept —
    which would mean backups encrypted to a key nobody holds, discovered on the day they are needed.

    The private key is returned exactly once, in this response body. `no-store` keeps it out of any
    intermediary's cache; it is never written to either database.

    Generating server-side rather than in the browser is deliberate. The alternative's selling point —
    that the app never sees the private key — does not survive scrutiny, because the app is what serves
    the script that would do the generating. What it costs is real: hand-built PKCS8 encryption in
    JavaScript, whose failure mode is a key file that only proves unreadable at restore. Here the
    library that writes the key is the library that reads it back.
    """
    if body.key_size not in BACKUP_KEY_SIZES:
        raise HTTPException(
            status_code=400,
            detail=f"Key size must be one of {', '.join(str(size) for size in BACKUP_KEY_SIZES)}.",
        )
    passphrase = (body.passphrase or "").strip()
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=body.key_size)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        # `BestAvailableEncryption` is PKCS8 with the strongest scheme this build of the library offers,
        # so the file stays readable by `openssl pkcs8` and by the restore path's own
        # `load_pem_private_key` — and improves as the library does, which a hand-rolled wrapper could not.
        encryption_algorithm=(serialization.BestAvailableEncryption(passphrase.encode("utf-8"))
                              if passphrase else serialization.NoEncryption()),
    )
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return JSONResponse(
        {
            "public_key":  public_pem.decode("ascii"),
            "private_key": private_pem.decode("ascii"),
            "fingerprint": _rsa_fingerprint(public_key),
            "key_size":    body.key_size,
            "encrypted":   bool(passphrase),
        },
        headers={"Cache-Control": "no-store"},
    )


def _reject_duplicate_recipient_label(conn, label: str, exclude_id: Optional[str] = None) -> None:
    """Names are how a person tells one saved key from another — the fingerprints beside them are
    forty characters of base64 and settle nothing at a glance. Two recipients called the same thing
    therefore make the list unreadable at exactly the moment it matters (choosing which key a backup was
    sealed to). Compared case-insensitively on the trimmed value, because "Home NAS" and "home nas " are
    the same name to everyone except a string comparison."""
    clash = conn.execute(
        "SELECT id FROM backup_recipient WHERE LOWER(TRIM(label)) = LOWER(TRIM(?)) AND id IS NOT ?",
        (label, exclude_id),
    ).fetchone()
    if clash:
        raise HTTPException(status_code=400, detail=f'A backup key named "{label.strip()}" already exists.')


@router.post("/backup/recipients", dependencies=[Depends(require_admin_or_local)])
def create_backup_recipient(body: BackupRecipientCreate):
    public_key, fingerprint = _validate_backup_recipient_key(body.public_key)
    rid = str(uuid.uuid4())
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM backup_recipient WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="That public key is already saved")
        _reject_duplicate_recipient_label(conn, body.label)
        conn.execute("""
            INSERT INTO backup_recipient (id, label, public_key, fingerprint, algorithm, enabled)
            VALUES (?, ?, ?, ?, 'rsa-oaep-sha256', ?)
        """, (rid, body.label.strip(), body.public_key.strip(), fingerprint, 1 if body.enabled else 0))
    return {
        "id": rid,
        "label": body.label.strip(),
        "public_key": body.public_key.strip(),
        "fingerprint": fingerprint,
        "algorithm": "rsa-oaep-sha256",
        "enabled": 1 if body.enabled else 0,
    }


@router.patch("/backup/recipients/{recipient_id}", dependencies=[Depends(require_admin_or_local)])
def update_backup_recipient(recipient_id: str, body: BackupRecipientUpdate):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM backup_recipient WHERE id = ?",
            (recipient_id,),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Backup key not found")
        fields, params = [], []
        if body.label is not None:
            # A rename can collide just as an add can, and the list is no more readable for it.
            _reject_duplicate_recipient_label(conn, body.label, exclude_id=recipient_id)
            fields.append("label = ?")
            params.append(body.label.strip())
        if body.enabled is not None:
            fields.append("enabled = ?")
            params.append(1 if body.enabled else 0)
        if fields:
            params.append(recipient_id)
            conn.execute(f"UPDATE backup_recipient SET {', '.join(fields)} WHERE id = ?", params)
        row = conn.execute("""
            SELECT id, label, public_key, fingerprint, algorithm, enabled, created_at
            FROM backup_recipient WHERE id = ?
        """, (recipient_id,)).fetchone()
    return dict(row)


@router.delete("/backup/recipients/{recipient_id}", dependencies=[Depends(require_admin_or_local)])
def delete_backup_recipient(recipient_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM backup_recipient WHERE id = ?", (recipient_id,))
    return {"ok": True}


# --- CSV export + backup/restore ---------------------------------------------------------------

@router.get("/transactions.csv")
def export_transactions_csv(
    columns:      str           = Query("date,merchant_name,amount,account,category"),
    facets:       TransactionFacets = Depends(),
    filters:      dict          = Depends(transaction_list_filters),
    sort_by:      Optional[str] = Query("date", description="date | merchant | category | account | amount"),
    sort_dir:     Optional[str] = Query("desc", description="asc | desc"),
):
    col_keys = [c.strip() for c in columns.split(",") if c.strip() in EXPORT_COLUMNS]
    if not col_keys:
        col_keys = ["date", "merchant_name", "amount", "account", "category"]

    headers      = [EXPORT_COLUMNS[k][1] for k in col_keys]

    # The filter, row source and order are the list feed's own rather than a reading of its parameters, so
    # the ledger can hand over a set too large to copy as this file and the file holds exactly those rows.
    # The export once restated its filters, and the copy drifted twice: it compared the synthetic
    # uncategorized bucket ids as though they were real category rows (an Uncategorized chip exported an
    # empty file), and it never learned the ledger's search, quick filter, amount filter or trash exclusion.
    # A direct (non-HTTP) caller that omits `filters` gets the dependency sentinel, read as no filters.
    where, params, expand_splits, order_by = transaction_list_scope(
        facets=facets, sort_by=sort_by, sort_dir=sort_dir,
        filters=filters if isinstance(filters, dict) else {},
    )

    # A split row that is the whole purchase has no one category a CSV row can carry — a file of one row
    # per transaction cannot hold several. Its `category_id` is only the pre-split category kept for
    # un-splitting, which the file would otherwise present as current, so Category and Group carry a
    # marker saying what happened: an empty cell would read as uncategorized, which is a different and
    # equally wrong claim. An expanded part row carries its own category.
    whole_split = "t.is_split = 1 AND t.split_part_id IS NULL" if expand_splits else "t.is_split = 1"

    def select_expr(key):
        expr = EXPORT_COLUMNS[key][0]
        if key in ("category", "group"):
            expr = f"CASE WHEN {whole_split} THEN '{SPLIT_EXPORT_MARKER}' ELSE {expr} END"
        # Quoted, because `group` is an SQL keyword: unquoted, choosing the Group column failed the export.
        return f'{expr} AS "{key}"'

    select_exprs = [select_expr(k) for k in col_keys]

    # The connection is opened *inside* the generator, not around it. A `with get_db()` block here would
    # close before the response body is consumed, which is why this used to fetchall() the entire filtered
    # ledger into a list first — the same "assemble it all, then pretend to stream" shape the backup export
    # had, for the same reason and with the same fix. Rows now come off the cursor as they are written.
    #
    # The database path is resolved *here* and handed to the generator, never re-resolved inside it. The
    # per-request path is a ContextVar that the auth middleware resets in a `finally` as soon as the
    # handler returns — which is before a streaming body is consumed — so a generator that called
    # `get_db()` with no argument would open whichever database happened to be the ambient default by
    # then. (The backup export does not have this problem: it finishes with the database before it returns
    # a response at all, and only a finished file is streamed.)
    db_path = current_db_path()

    def generate():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(headers)
        yield buf.getvalue(); buf.seek(0); buf.truncate()
        # Held open across yields, each of which may resume on a different worker thread.
        with get_db(db_path, handed_between_threads=True) as conn:
            for row in conn.execute(f"""
                SELECT {', '.join(select_exprs)}
                FROM   {txn_effective_sql(conn, expand=expand_splits)} t
                JOIN   account   a ON a.id  = t.account_id
                LEFT JOIN account  p ON p.id  = a.parent_account_id
                LEFT JOIN category c ON c.id  = t.category_id
                LEFT JOIN category pc ON pc.id = c.parent_id
                LEFT JOIN owner    o ON o.id  = t.owner_id
                {where}
                ORDER  BY {order_by}
            """, params):
                w.writerow([spreadsheet_safe(row[k]) for k in col_keys])
                yield buf.getvalue(); buf.seek(0); buf.truncate()

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="luma_export.csv"'},
    )

# Content integrity hash for the JSON backups. Embedded *in* the payload rather than added as a
# sidecar ZIP member (a pre-version-10 archive holds exactly one JSON member and no room for a second
# member) so it travels with both zipped and bare-`.json` uploads and rides into the encrypted inner
# `payload.bin` for free. Restore recomputes it over the payload minus this field and refuses a
# mismatch before the destructive wipe. The hash is computed over a canonical serialization
# (sorted keys, compact separators, `default=str`) so it round-trips identically through the
# export → file → `json.loads` → verify cycle. Encrypted backups are *additionally* protected by the
# AES-256-GCM auth tag at decrypt time (a stronger, keyed check), so this hash is primarily the
# integrity check for the plaintext path; it just comes along for the encrypted one at no cost.
CONTENT_HASH_FIELD = "content_sha256"


def _payload_content_hash(payload: dict) -> str:
    material = {k: v for k, v in payload.items() if k != CONTENT_HASH_FIELD}
    encoded = json.dumps(material, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _stamp_content_hash(payload: dict) -> dict:
    payload[CONTENT_HASH_FIELD] = _payload_content_hash(payload)
    return payload


def _verify_payload_content_hash(payload: dict) -> None:
    # Absent hash = a backup written before the field existed; there is nothing to check, and the
    # restore proceeds (matching the additive treatment of `schema_version`).
    claimed = payload.get(CONTENT_HASH_FIELD)
    if not claimed:
        return
    if _payload_content_hash(payload) != claimed:
        raise HTTPException(
            status_code=400,
            detail="This backup failed its integrity check (content hash mismatch) — the file is corrupted, truncated, or was edited after export.",
        )


# --- The backup payload: one enumeration, two consumers -----------------------------------------
# (section, table, query). The *section* name is the payload's field name; it outlives the table name
# (`transactions` has been the section for `txn` across two renames), which is why both are recorded
# here rather than derived from each other. The writer walks this in order, so members land
# parents-first — convenient to read, though the restore transaction defers foreign-key checks and
# does not depend on it.
#
# A table missing from this list is a table that is not backed up. The coverage test derives its map
# from here and fails on any data table with no section, so adding one forces the wiring.
BACKUP_SECTIONS = (
    ("owners", "owner", "SELECT * FROM owner ORDER BY rowid"),
    # The non-secret half of each data connection. One row is split across the two backups by what each
    # column is: the credential rides the credentials backup, and what describes the ledger in *this* file
    # rides here — that the connection exists (so its accounts, mappings and import cards have something to
    # belong to, whichever backup is restored first), what its last sync did, and how far it had read. The
    # resume point belongs here for the same reason: written in the same export as the rows, it describes
    # exactly them. It is an opaque position in the provider's feed, not a way in — nothing can be fetched
    # with it without the credential. So does what the connection has spent against a metered provider's
    # limits, with when that was written: the spending belongs to the credential, and the restore keeps
    # whichever copy is newer (`_restore_connections`). Left behind on the target, and listed in the
    # coverage test: `credential`/`credential_enc` (secrets) and `sync_started_at`/`sync_progress` (a sync
    # running in the process that wrote them).
    ("connections", "connection",
     "SELECT id, provider, external_id, institution, nickname, created_at, captured_fields, realtime_balances, "
     "transactions_cursor, "
     "initial_sync_complete, last_synced_at, last_sync_error, last_sync_error_at, consecutive_sync_failures, "
     "last_sync_warnings, reauth_required, last_sync_outcome, last_sync_summary, provider_request_budget, "
     "provider_request_budget_at FROM connection ORDER BY rowid"),
    # Curated column list rather than SELECT *: these two tables carry columns that must not travel
    # (and have survived renames), so the payload names exactly what it means to include.
    ("accounts", "account",
     "SELECT id, external_account_id, connection_id, provider, name, display_name, "
     "institution, type, subtype, mask, owner_id, parent_account_id, trashed_at, wallet_match_text, "
     "exclude_from_net_worth "
     "FROM account ORDER BY rowid"),
    ("categories", "category", "SELECT * FROM category ORDER BY rowid"),
    ("category_rules", "category_rule", "SELECT * FROM category_rule ORDER BY rowid"),
    ("csv_profiles", "csv_import_profile", "SELECT * FROM csv_import_profile ORDER BY rowid"),
    # Provider-account mapping + the connection's coverage claim. This rides the DATA backup, not the
    # credentials one, even though it hangs off `connection`: it holds no secret, and its coverage MUST
    # move with the ledger. Restoring an older backup removes synced rows, so a coverage claim that
    # survived would hard-reject the very rows a re-sync brings back; exported alongside its
    # transactions, coverage is consistent with them by construction.
    ("connection_accounts", "connection_account", "SELECT * FROM connection_account ORDER BY rowid"),
    ("import_batches", "import_batch", "SELECT * FROM import_batch ORDER BY rowid"),
    ("import_batch_accounts", "import_batch_account", "SELECT * FROM import_batch_account ORDER BY rowid"),
    ("import_batch_duplicates", "import_batch_duplicate", "SELECT * FROM import_batch_duplicate ORDER BY rowid"),
    # What each file offered and the import did not take. It rides the backup for the same reason the
    # duplicates do: a restored ledger that could no longer say why an account is short of the file it
    # was fed would answer that question worse than the backup it came from.
    ("import_batch_rejected_rows", "import_batch_rejected_row", "SELECT * FROM import_batch_rejected_row ORDER BY rowid"),
    ("import_workflow_states", "import_workflow_state", "SELECT * FROM import_workflow_state ORDER BY rowid"),
    # Detected/curated recurring series. txn.recurring_series_id is the membership link back into these;
    # recurring_membership_override carries the user's per-transaction pin/exclude corrections that
    # survive scans.
    ("recurring_series", "recurring_series", "SELECT * FROM recurring_series ORDER BY rowid"),
    # Every column, named. A curated list that falls behind the schema restores the omitted columns at
    # their defaults, and for this table the defaults are not neutral: `trashed_at` and the dedupe
    # resolution columns defaulting to NULL bring every trashed row and every confirmed duplicate back into
    # the ledger as a live transaction. The coverage test compares this list with the table, column by
    # column, so a column added later fails the suite until it is named here.
    ("transactions", "txn",
     "SELECT id, external_transaction_id, source_transaction_id, account_id, owner_id, "
     "category_id, amount, merchant_name, display_name, display_name_source, raw_name, date, "
     "posted_date, is_pending, category_overridden, category_source, imported_category, notes, "
     "content_hash, import_evidence_json, needs_review, recurring_series_id, is_split, import_batch_id, "
     "trashed_at, rejection_reason, dedupe_resolved_by, "
     "suspect_duplicate_of, suspect_duplicate_reason, suspect_resolved_at FROM txn ORDER BY date DESC"),
    ("recurring_membership_overrides", "recurring_membership_override",
     "SELECT * FROM recurring_membership_override ORDER BY rowid"),
    # The user's "seen it, it's fine" dismissals of recurring anomaly signals. The signals themselves are
    # derived on read and carry nothing to back up; these are the whole of their durable state, and
    # without them a restore would re-raise every finding the user had already worked through.
    ("recurring_signal_dismissals", "recurring_signal_dismissal",
     "SELECT * FROM recurring_signal_dismissal ORDER BY rowid"),
    # The user's answers to the transfer review's one question — which transaction is the other half of
    # an ambiguous pair. Like the dismissals above, everything they qualify is derived on every scan, so
    # these are their whole durable state: without them a restore would re-ask questions the user had
    # already settled, and would silently re-pair rows against a counterpart they had rejected.
    ("transfer_pair_decisions", "transfer_pair_decision",
     "SELECT * FROM transfer_pair_decision ORDER BY rowid"),
    # The same thing for the rule-overlap check: its findings are derived from the rules on every run, so
    # these acknowledgements are their whole durable state. Without them a restore would re-raise every
    # deliberate rule pair the user had already waved through.
    ("rule_overlap_dismissals", "rule_overlap_dismissal",
     "SELECT * FROM rule_overlap_dismissal ORDER BY rowid"),
    # What each rule's alert caught as it arrived, and whether the alert has been dismissed since. Nothing
    # re-derives it: an alert records only an arrival, so a restore without these would drop every alert
    # still waiting to be seen.
    ("rule_alert_hits", "rule_alert_hit", "SELECT * FROM rule_alert_hit ORDER BY rowid"),
    # Split allocations. txn.is_split rides along in the transactions section above, but the parts are
    # the categorization itself: without these a restore would leave rows flagged as split with nothing
    # to expand into, and every category rollup would silently drop that money.
    ("txn_splits", "txn_split", "SELECT * FROM txn_split ORDER BY rowid"),
    # Typed transaction links (services/txn_links.py): the link rows plus their membership. Without
    # these a restore would silently drop every link (e.g. an Amazon order's charge<->item association),
    # the same failure the tag attachments guard against below.
    ("txn_links", "txn_link", "SELECT * FROM txn_link ORDER BY rowid"),
    ("txn_link_members", "txn_link_member", "SELECT * FROM txn_link_member ORDER BY rowid"),
    # Amazon funding-source -> account map (services/amazon_funding.py): the instrument->account
    # mappings the Amazon importer resolves charges against. Without these a restore would drop the
    # user's funding setup and re-imports would fall back to the graceful-last-4 match.
    ("amazon_funding_map", "amazon_funding_map", "SELECT * FROM amazon_funding_map ORDER BY rowid"),
    # Tag system: the tag definitions plus every attachment surface (transaction, category/group,
    # account, rule). Without these a restore silently dropped all tagging.
    ("tags", "tag", "SELECT * FROM tag ORDER BY rowid"),
    ("txn_tags", "txn_tag", "SELECT * FROM txn_tag ORDER BY rowid"),
    ("category_tags", "category_tag", "SELECT * FROM category_tag ORDER BY rowid"),
    ("account_tags", "account_tag", "SELECT * FROM account_tag ORDER BY rowid"),
    # Balances a source stated. A provider re-reports only today's, so a restore without these would lose
    # every earlier one.
    ("account_balances", "account_balance", "SELECT * FROM account_balance ORDER BY rowid"),
    ("rule_tags", "rule_tag", "SELECT * FROM rule_tag ORDER BY rowid"),
    # User's explicit "these two accounts are distinct" assertions (dedupe review state).
    ("account_pair_distinct", "account_pair_distinct", "SELECT * FROM account_pair_distinct ORDER BY rowid"),
    # User's "these two charges are distinct" assertions from the Amazon reconciliation's
    # unaccounted-duplicate grouping — same accumulated-filter role, charge-level.
    ("amazon_charge_distinct", "amazon_charge_distinct", "SELECT * FROM amazon_charge_distinct ORDER BY rowid"),
    ("suspect_pair_distinct", "suspect_pair_distinct", "SELECT * FROM suspect_pair_distinct ORDER BY rowid"),
    # User "Mark reviewed" acknowledgments on the reconciliation report's reverse-scan bucket, so a
    # restore keeps unaccounted charges the user already cleared out of the attention count.
    ("amazon_charge_reviewed", "amazon_charge_reviewed", "SELECT * FROM amazon_charge_reviewed ORDER BY rowid"),
    # Amazon items parked awaiting their orders file (per-item detail retained so a later orders import
    # auto-attaches it). Without these a restore would strand a not-yet-matched items import.
    ("amazon_pending_items", "amazon_pending_item", "SELECT * FROM amazon_pending_item ORDER BY rowid"),
    # UI/layout preferences (page layouts, dashboard tag reports, ...), keyed by scope_id.
    ("ui_preferences", "ui_preference", "SELECT * FROM ui_preference ORDER BY rowid"),
    # The backups this system made. Not restored like the rest: a restore of this system's own backup keeps
    # the live history, which already holds everything this copy does (see `_restore_backup_history`).
    ("backup_history", "backup_history", "SELECT * FROM backup_history ORDER BY rowid"),
    # Attached receipts and invoices — the rows only. Each row's *file* rides as its own
    # `documents/<id>` member (see `_write_document_members`), which is the whole reason documents are
    # files rather than blobs: the bytes never enter this JSON.
    ("documents", "document", "SELECT * FROM document ORDER BY rowid"),
)

BACKUP_SECTION_NAMES = tuple(section for section, _table, _query in BACKUP_SECTIONS)

# The payload generation. Two axes, as before: `version` is the payload format (this content and these
# section names), `schema_version` the DB migration level the rows conform to. Version 10 changed how
# the archive is laid out — `meta.json` + one NDJSON member per section, in place of one JSON object —
# so that neither writing nor reading a backup has to hold the whole thing in memory. The *content* of
# a section is unchanged from 9, which is why the restore's per-section handling is shared with the
# older versions rather than duplicated. Version 11 added the `txn_splits` section, 12 the
# `documents` section plus the `documents/<id>` file members beside it, and 13 the
# `recurring_signal_dismissals` section, 14 the `rule_overlap_dismissals` section, 15 the
# `connections` section, 16 the `import_batch_rejected_rows` section, 17 the `backup_history` section, 18
# the `rule_alert_hits` section, and 19 the `account_balances` section — all purely additive, which is why an older archive still restores through
# exactly the same path with the new section simply absent. A section can also be retired: restore reads only the sections listed
# above, so an older archive's retired section is ignored (`merchant_renames`, whose table was dropped).
BACKUP_PAYLOAD_VERSION = 19
RESTORABLE_PAYLOAD_VERSIONS = (7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19)

# How old a backup's resume points may be and still be handed back to a provider. Plaid documents a
# `/transactions/sync` cursor as valid for at least a year after it was issued; past that nothing vouches
# for it, and a resume point the provider refuses is worth less than the full backfill a reset buys.
RESTORED_CURSOR_MAX_AGE_DAYS = 365

# What a backup file holds. Stamped into every container the app writes and read back by the
# identification pass below, so the restore surface can route a file rather than asking the person holding
# it which kind they have. A backup is written `full`: the financial data and the accounts (identities, the
# perimeter, backup keys, and the data-source credentials with the vault that opens them —
# `services/accounts_backup.py`), and the restore chooses which to apply. `data` is a file of the financial
# data alone, as every backup was before the accounts part existed, and `credentials` the standalone
# credentials backup that preceded the accounts part. Neither is written any more, and both still restore.
BACKUP_KIND_DATA = "data"
BACKUP_KIND_FULL = "full"
BACKUP_KIND_CREDENTIALS = "credentials"

# The standalone credentials backup's format. 3 carried ciphertext and the exporter's directly-wrapped
# passphrase slot (`vault`), 4 the same for a keypair slot, and 5 every slot the exporter opens the vault
# with (`vault_slots`). 1 and 2 held plaintext. All still restore.
RESTORABLE_CREDENTIALS_VERSIONS = (1, 2, 3, 4, 5)

# Size of the buffer used everywhere bytes are moved between a file, a zip member and a cipher. Big
# enough that a large archive is not a syscall storm, small enough to be the whole of the memory this
# code holds at once.
STREAM_CHUNK_BYTES = 1 << 20

META_MEMBER = "meta.json"

# Attached files ride as one member each, addressed by document id — the same flat, extensionless
# layout the on-disk store uses, so a restore can copy a member straight to its path without
# reconstructing a name.
DOCUMENT_MEMBER_PREFIX = "documents/"

# The accounts part, where a file carries it: one NDJSON member per row list and the credentials as one
# JSON object. A prefix of its own so its names can never meet a data section's.
ACCOUNTS_CREDENTIALS_MEMBER = "accounts/credentials.json"


def _section_member(section: str) -> str:
    return f"sections/{section}.ndjson"


def _accounts_member(rows: str) -> str:
    return f"accounts/{rows}.ndjson"


def _document_member(document_id: str) -> str:
    return f"{DOCUMENT_MEMBER_PREFIX}{document_id}"


def _canonical_json(value) -> str:
    """The one serialization used for anything a digest is taken over: sorted keys, no incidental
    whitespace, `default=str` for the handful of types SQLite hands back that JSON has no literal for.
    Deliberately not pretty-printed — this is a machine-read artifact about to be compressed, and the
    indentation was inflating the largest string in the process for no reader's benefit."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _zip_member_info(name: str, compress_type: int) -> zipfile.ZipInfo:
    """A member with its own compression choice. Compression is per member because the archive mixes
    kinds: the NDJSON sections compress ~10:1 and must be deflated, while already-compressed content (the
    encrypted payload, and documents once they ride along) gains nothing and is stored.

    The timestamp is **local time, deliberately** — and is not a stored timestamp, so the naive-UTC
    convention the timestamp guard enforces does not apply here (same exception as
    `_dated_backup_filename`, for the same reason). A ZIP entry's date is MS-DOS date/time, which carries
    no timezone: every archive tool writes and reads it as local, so a UTC value would simply display as
    the wrong time. `time.localtime()` is what `ZipFile.writestr` itself uses when handed a plain member
    name, which is how these members were stamped before they needed per-member compression."""
    info = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
    info.compress_type = compress_type
    return info


def backup_temp_file():
    """A staging file for an archive being built or read, opened beside the data database.

    Deliberately not the system temp directory: on many Linux installs `/tmp` is `tmpfs`, which is
    RAM-backed, and staging there would put back exactly the memory this streaming exists to avoid. The
    data directory is also the volume the user has already sized for their data, and the one a portable
    install carries with it.

    `TemporaryFile` has no name on disk, so an export interrupted by a crash cannot strand one."""
    return tempfile.TemporaryFile(dir=os.path.dirname(current_db_path()) or None)


def restore_staging_file():
    """A *named* staging file for an uploaded backup, returned as `(fileobj, path)`.

    The export's staging file is deliberately unnamed, so a crash mid-export cannot strand one. A
    restore's has the opposite requirement: its documents phase runs after the ledger has committed, so
    an interruption there needs the source archive still to exist and still to be findable. Whoever
    opened it removes it — as soon as the phase completes, or immediately if the restore never reached
    it — because the phase itself runs with this handle still open and Windows will not delete a file
    that is.

    Beside the data database for the same reasons as every other staging file here — `/tmp` is
    RAM-backed on many Linux installs, and the data directory is the volume the user has sized.
    """
    directory = os.path.dirname(current_db_path()) or "."
    handle, path = tempfile.mkstemp(dir=directory, prefix=".restore-staging-", suffix=".zip")
    return os.fdopen(handle, "w+b"), path


def _discard_unclaimed_staging(path: str) -> None:
    """Remove a staged upload unless the restore's documents phase is holding it for a resume."""
    with get_db() as conn:
        state = get_restore_state(conn)
    if state and state.get("artifact_path") == path:
        return
    Path(path).unlink(missing_ok=True)


def _stream_file_out(fileobj):
    """Yield a staged artifact back to the client and close it afterwards — including when the client
    disconnects mid-download, which closes the generator."""
    try:
        while True:
            chunk = fileobj.read(STREAM_CHUNK_BYTES)
            if not chunk:
                return
            yield chunk
    finally:
        fileobj.close()


class DocumentFilesUnreadable(Exception):
    """Attached documents whose files exist but cannot be opened, as (filename, reason) pairs. The backup
    is refused rather than made without them: this server wrote every one, so a file it cannot read is a
    setup mistake to correct (an owner or permission left over from another user), not drift."""

    def __init__(self, files: list[tuple[str, str]]):
        super().__init__(f"{len(files)} document files cannot be read")
        self.files = files


def document_files_unreadable_message(count: int, names: list[str], folder: str, user: Optional[str]) -> str:
    shown = ", ".join(names[:3]) + (f" and {count - 3} more" if count > 3 else "")
    files = "the file" if count == 1 else f"{count} files"
    reader = f"the user the server runs as ({user})" if user else "the user the server runs as"
    return (f"The backup was not made: the server cannot read {files} for {shown}. Every file in {folder} "
            f"has to be readable by {reader}. Settings → Database lists them.")


def _write_document_members(conn, zf) -> None:
    """Add every attached document's file to the archive, one member per document.

    Each file streams from disk into its member with a fixed buffer, so a large attachment is never
    resident — the property that makes a backup's size a disk question rather than a memory one.
    Members are **stored, not deflated**: JPEG, PNG and PDF payloads are already compressed, so
    deflating them spends CPU for nothing while the NDJSON sections beside them still compress ~10:1.

    Their digests are deliberately not added to `meta.json`. A document's digest already lives on its
    `document` row, which is both the app's own record of the file and what lets a resumed restore tell
    a complete file from a torn one — listing it twice would create a second source of truth that could
    disagree with the first.

    **A row whose file is missing does not fail the export.** That drift is possible by construction (the
    store writes the file before the row, and nothing outside this app is stopped from deleting one), and
    refusing to produce a backup is the worst available response to it: it would withhold the ledger over
    one unreadable receipt. The row rides without its member and the restore reports it as missing.

    **A file that is there but cannot be opened does fail it** (`DocumentFilesUnreadable`), once every
    other file has been tried so the refusal can name them all.
    """
    unreadable = []
    for row in conn.execute("SELECT id, filename FROM document ORDER BY rowid"):
        path = document_file_path(row["id"])
        try:
            source = open(path, "rb")
        except FileNotFoundError:
            continue
        except OSError as exc:
            unreadable.append((row["filename"], exc.strerror or str(exc)))
            continue
        with source, zf.open(_zip_member_info(_document_member(row["id"]), zipfile.ZIP_STORED), "w") as member:
            shutil.copyfileobj(source, member, STREAM_CHUNK_BYTES)
    if unreadable:
        raise DocumentFilesUnreadable(unreadable)


def _write_ndjson_member(zf, name: str, rows) -> dict:
    digest = hashlib.sha256()
    count = 0
    with zf.open(_zip_member_info(name, zipfile.ZIP_DEFLATED), "w") as member:
        for row in rows:
            line = (_canonical_json(dict(row)) + "\n").encode("utf-8")
            digest.update(line)
            member.write(line)
            count += 1
    return {"sha256": digest.hexdigest(), "rows": count}


def write_backup_archive(conn, sink, kind: str = BACKUP_KIND_DATA, accounts_part: Optional[dict] = None,
                         made_by: Optional[str] = None) -> dict:
    """Write a backup of `kind` into `sink` (any writable binary file object), and return its
    `exported_at` with the sizes `archive_sizes` reports.

    `accounts_part` (`accounts_backup.collect`) is written when given. A `data` kind without it is for tests
    that build the older files. Data rows go straight from their cursor into the zip
    member, one JSON object per line, so no section is ever materialized as a list and the peak memory is
    one row plus the compressor's own buffers — whatever the ledger's size. The accounts part is a few rows
    per person and is handed over whole. `meta.json` is written last because it carries the digest of each
    member, which is only known once that member has been written.
    """
    members = {}
    exported_at = utcnow_iso()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for section, _table, query in BACKUP_SECTIONS:
            name = _section_member(section)
            members[name] = _write_ndjson_member(zf, name, conn.execute(query))
        _write_document_members(conn, zf)

        if accounts_part is not None:
            for rows in accounts_backup.ROW_LISTS:
                name = _accounts_member(rows)
                members[name] = _write_ndjson_member(zf, name, accounts_part.get(rows) or [])
            if accounts_part.get("credentials") is not None:
                body = _canonical_json(accounts_part["credentials"]).encode("utf-8")
                zf.writestr(_zip_member_info(ACCOUNTS_CREDENTIALS_MEMBER, zipfile.ZIP_DEFLATED), body)
                members[ACCOUNTS_CREDENTIALS_MEMBER] = {"sha256": hashlib.sha256(body).hexdigest()}

        zf.writestr(
            _zip_member_info(META_MEMBER, zipfile.ZIP_DEFLATED),
            _canonical_json({
                # What this file is, so a restore surface can route it without the person holding it
                # having to know how the backups differ. See "Identifying a backup file".
                "kind":           kind,
                # The accounts part's own format, and whether it carries the credentials, present exactly
                # when the part is.
                **({
                    "accounts_version": accounts_backup.ACCOUNTS_PART_VERSION,
                    "credentials_included": accounts_part.get("credentials") is not None,
                } if accounts_part is not None else {}),
                "version":        BACKUP_PAYLOAD_VERSION,
                # The DB migration level the rows conform to, recorded so restore can tell an older
                # backup (columns the schema has since added simply take their defaults) from one made
                # by a newer build (which may carry columns this build can't represent — the restore
                # guard refuses that downgrade unless forced).
                "schema_version": get_db_version(conn),
                "exported_at":    exported_at,
                # Who took it, by name rather than id: the history row a restore writes for this file
                # outlives the people of the system it came from.
                "made_by":        made_by,
                # System identity, so restore can tell "my own backup" from "a different system's", and
                # which access mode it came from. Used by the restore compatibility guard.
                "instance_id":    get_db_instance_id(conn),
                "access_mode":    "auth" if auth_required() else "local",
                # A digest per member, verified on the way back in. This replaces version 9's
                # `content_sha256` field *inside* the payload: same unsigned-checksum guarantee against
                # accidental corruption, but checkable while streaming rather than by re-serializing the
                # whole payload to compare one hash — and it extends to members that are not JSON at all.
                "members":        members,
            }).encode("utf-8"),
        )
        sizes = archive_sizes(zf)
    return {"exported_at": exported_at, **sizes}


def archive_sizes(zf) -> dict:
    """How much of an archive is the ledger, the accounts part and the attached documents, in bytes as
    stored, read from the zip's directory without opening a member. `meta.json` counts as ledger."""
    sizes = {"ledger_bytes": 0, "accounts_bytes": 0, "documents_bytes": 0, "document_count": 0}
    for info in zf.infolist():
        if info.filename.startswith(DOCUMENT_MEMBER_PREFIX):
            sizes["documents_bytes"] += info.compress_size
            sizes["document_count"] += 1
        elif info.filename.startswith("accounts/"):
            sizes["accounts_bytes"] += info.compress_size
        else:
            sizes["ledger_bytes"] += info.compress_size
    return sizes


def build_backup_data(conn) -> dict:
    """The backup payload materialized as a dict — the archive read back into memory.

    This is the shape versions 7-9 wrote as a single JSON object, and it remains what `POST /restore`
    accepts. It is deliberately produced by *reading what the writer just wrote* rather than by walking
    the tables a second time: there is one producer of a backup, so a test asserting over this dict is
    asserting over the real export. It holds the whole payload in memory by definition, which is why
    nothing on the export path uses it.

    The archive's per-member digests do not survive being materialized — they cover member *bytes*, and
    these are rows — so the dict carries `content_sha256` over itself instead, which is the integrity
    check that belongs to this container and the one `POST /restore` verifies.
    """
    staged = io.BytesIO()
    write_backup_archive(conn, staged)
    staged.seek(0)
    with zipfile.ZipFile(staged) as zf:
        payload = dict(_read_archive_meta(zf))
        payload.pop("members", None)
        for section in BACKUP_SECTION_NAMES:
            payload[section] = list(read_archive_section(zf, section))
    return _stamp_content_hash(payload)


def _build_encrypted_manifest(content_key: bytes, nonce: bytes, recipients: list[dict], kind: str,
                              credentials_included: Optional[bool] = None,
                              exported_at: Optional[str] = None) -> dict:
    manifest = {
        "format": "luma-encrypted-backup",
        "version": 1,
        # Outside the ciphertext deliberately: what the file holds decides which restore choices to offer,
        # and that has to be known before anyone has produced a private key. It discloses what the file
        # holds, not anything in it. The time it was taken is what the suggested filename already says,
        # and lets the restore confirmation say how far back the restore goes.
        "kind": kind,
        **({"credentials_included": credentials_included} if credentials_included is not None else {}),
        **({"exported_at": exported_at} if exported_at else {}),
        "cipher": "AES-256-GCM",
        "wrapped_keys": [],
        "nonce": urlsafe_b64encode(nonce).decode("ascii"),
    }
    for recipient in recipients:
        public_key, fingerprint = _validate_backup_recipient_key(recipient["public_key"])
        wrapped_key = public_key.encrypt(
            content_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        manifest["wrapped_keys"].append({
            "recipient_id": recipient["id"],
            "label": recipient["label"],
            "fingerprint": fingerprint,
            "algorithm": "rsa-oaep-sha256",
            "wrapped_key": urlsafe_b64encode(wrapped_key).decode("ascii"),
        })
    return manifest


def write_encrypted_archive(source, recipients: list[dict], sink, kind: str = BACKUP_KIND_DATA,
                            credentials_included: Optional[bool] = None,
                            exported_at: Optional[str] = None) -> None:
    """Seal an already-written archive into the encrypted envelope, streaming.

    The envelope format is untouched by the streaming: `AESGCM.encrypt()` is one-shot and needs both
    plaintext and ciphertext resident, but the incremental encryptor over the same cipher emits
    byte-identical output — the ciphertext followed by the 16-byte tag — so an archive written this way
    is indistinguishable from one written by the one-shot API and opens with it. No manifest version
    bump, and nothing to teach the restore side.
    """
    content_key = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(12)
    manifest = _build_encrypted_manifest(content_key, nonce, recipients, kind, credentials_included, exported_at)
    encryptor = Cipher(algorithms.AES(content_key), modes.GCM(nonce)).encryptor()

    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        zf.writestr(_zip_member_info("manifest.json", zipfile.ZIP_DEFLATED),
                    json.dumps(manifest, indent=2).encode("utf-8"))
        # Stored, not deflated: ciphertext is incompressible, so deflating it is pure CPU.
        with zf.open(_zip_member_info("payload.bin", zipfile.ZIP_STORED), "w") as member:
            while True:
                chunk = source.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                member.write(encryptor.update(chunk))
            member.write(encryptor.finalize())
            member.write(encryptor.tag)


def _recipients_for_export(conn, requested_ids: Optional[str]) -> list[dict]:
    """The keys this backup will be readable by.

    `enabled` is eligibility, not the selection: an omitted `recipients` list means "all of them", which
    is what a single-recipient install always wants and what every caller predating the parameter expects.
    Naming ids narrows it to those — the per-backup choice, for a file going somewhere that should not be
    openable by every key on the list.

    An id that is unknown or not enabled is an **error, not a silent omission**. Quietly encrypting to
    fewer keys than asked for produces a file the user believes one of their keys opens and none does,
    and they find out when they try to restore it.
    """
    eligible = [dict(r) for r in conn.execute("""
        SELECT id, label, public_key
        FROM   backup_recipient
        WHERE  enabled = 1
        ORDER  BY created_at DESC, label
    """).fetchall()]
    if requested_ids is None:
        return eligible

    wanted = [rid.strip() for rid in requested_ids.split(",") if rid.strip()]
    by_id = {r["id"]: r for r in eligible}
    missing = [rid for rid in wanted if rid not in by_id]
    if missing:
        raise HTTPException(
            status_code=400,
            detail="Some selected backup keys are no longer available — reload the page and try again.",
        )
    return [by_id[rid] for rid in wanted]


@router.get("/backup/status", dependencies=[Depends(require_admin_or_local)])
def backup_status(request: Request):
    """What a backup taken now would leave out, and why: said on the backup surface before the file is made
    rather than discovered at restore."""
    with get_db() as conn:
        return accounts_backup.backup_status(conn, getattr(request.state, "user", None))


@router.get("/backup/history", dependencies=[Depends(require_admin_or_local)])
def get_backup_history():
    """The backups this system made, newest first, with the history's retention."""
    with get_db() as conn:
        return {"backups": backup_history.list_rows(conn), "retention_days": backup_history.retention_days(conn)}


class BackupHistoryRetentionRequest(BaseModel):
    days: int


@router.put("/backup/history/retention", dependencies=[Depends(require_admin_or_local)])
def set_backup_history_retention(body: BackupHistoryRetentionRequest):
    """How many days the history keeps. Applied on the spot; the newest row is kept whatever its age."""
    with get_db() as conn:
        try:
            days = backup_history.set_retention_days(conn, body.days)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"retention_days": days, "backups": backup_history.list_rows(conn)}


class BackupHistoryFilenameRequest(BaseModel):
    filename: str


@router.patch("/backup/history/{backup_id}", dependencies=[Depends(require_admin_or_local)])
def rename_backup_history_entry(backup_id: str, body: BackupHistoryFilenameRequest):
    """Correct the filename a row records to the one the file was saved under."""
    with get_db() as conn:
        try:
            found = backup_history.rename(conn, backup_id, body.filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not found:
            raise HTTPException(status_code=404, detail="That backup is not in the history.")
        return {"backups": backup_history.list_rows(conn)}


def _move_backup_history_entry(backup_id: str, trashed: bool) -> None:
    # The ledger row first: the credentials record follows it, and a retry after the second write fails
    # finds the row already moved and writes the second again.
    with get_db() as conn:
        if not backup_history.set_trashed(conn, backup_id, trashed):
            raise HTTPException(status_code=404, detail="That backup is not in the history.")
    control_database.set_credentials_exports_withdrawn(backup_id, trashed)


@router.delete("/backup/history/{backup_id}", dependencies=[Depends(require_admin_or_local)])
def trash_backup_history_entry(backup_id: str):
    """Move a row to the trash: the backup it records was not kept, or not where the row says."""
    _move_backup_history_entry(backup_id, True)
    with get_db() as conn:
        return {"backups": backup_history.list_rows(conn)}


@router.get("/backup/history-trash", dependencies=[Depends(require_admin_or_local)])
def get_backup_history_trash():
    with get_db() as conn:
        return {"backups": backup_history.list_rows(conn, trashed=True)}


@router.post("/backup/history-trash/{backup_id}/restore", dependencies=[Depends(require_admin_or_local)])
def restore_backup_history_entry(backup_id: str):
    _move_backup_history_entry(backup_id, False)
    with get_db() as conn:
        return {"backups": backup_history.list_rows(conn, trashed=True)}


@router.post("/backup/history-trash/empty", dependencies=[Depends(require_admin_or_local)])
def empty_backup_history_trash():
    with get_db() as conn:
        backup_history.empty_trash(conn)
        return {"backups": []}


@router.get("/backup", dependencies=[Depends(require_admin_or_local)])
def export_backup(
    request: Request,
    encrypted: bool = Query(False),
    recipients: Optional[str] = Query(
        None, description="Comma-separated recipient ids; omitted means every enabled recipient."
    ),
    saved_as: Optional[str] = Query(
        None, description="The name the file is being saved under, when the browser chose it before asking."
    ),
):
    """Write a backup: the financial data and the accounts (`services/accounts_backup.py`), always both.
    What to put back is chosen at restore.

    Encrypting to backup keys is optional. It protects what the file holds in the clear (the ledger,
    password hashes and two-factor secrets) and adds a layer in front of the vault slots, so an encrypted
    backup carries every passphrase while an unencrypted one carries only those that pass the current
    strength rule (`accounts_backup._carried_slots`). When the file would carry no way into the vault, the
    credentials are left out and the file says so; the rest of the backup is never held back for them.

    A browser with a save picker has the file named before it asks (`saved_as`), so the history records that
    name rather than the suggested one. The response names the history row (`X-Backup-Id`), so a save that
    fails after the row is written can move it to the trash.

    The databases are checked first and the outcome goes on the history row (`services/database_health.py`).
    A failed check never stops the backup: the page has already warned, and a backup of a failing database
    is worth more than none. A document file the server cannot read does stop it, with a 409 naming the
    files (`DocumentFilesUnreadable`).
    """
    user = getattr(request.state, "user", None)
    if saved_as is not None:
        try:
            saved_as = backup_history.clean_filename(saved_as)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    selected = []
    with get_db() as conn:
        if encrypted:
            selected = _recipients_for_export(conn, recipients)
            if not selected:
                raise HTTPException(status_code=400, detail="No enabled backup keys are configured")
        accounts_part = accounts_backup.collect(conn, encrypted)

    made_by = (user or {}).get("display_name") or (user or {}).get("username")
    check_passed = database_health.check_passed()
    artifact = backup_temp_file()
    try:
        with get_db() as conn:
            try:
                written = write_backup_archive(conn, artifact, BACKUP_KIND_FULL, accounts_part, made_by)
            except DocumentFilesUnreadable as exc:
                raise HTTPException(status_code=409, detail={
                    "code": "documents_unreadable",
                    "message": document_files_unreadable_message(
                        len(exc.files), [name for name, _ in exc.files], str(documents_dir()),
                        database_health.server_user()),
                })
        if encrypted:
            # The plain archive becomes the plaintext of the encrypted one; the database is no longer
            # needed, so the connection is already closed by the time the cipher runs.
            plain, artifact = artifact, backup_temp_file()
            try:
                plain.seek(0)
                write_encrypted_archive(plain, selected, artifact, BACKUP_KIND_FULL,
                                        accounts_part["credentials"] is not None, written["exported_at"])
            finally:
                plain.close()
        size = artifact.tell()
        artifact.seek(0)
    except BaseException:
        artifact.close()
        raise

    filename = _dated_backup_filename("luma_backup", ".encrypted.zip" if encrypted else ".zip")
    # Deliberately not allowed to fail the export: the file is the valuable thing, the notes about it a
    # courtesy, and a database hiccup must not cost someone their backup.
    # One id for the two records of this file, so trashing its history row can withdraw the other.
    backup_id = str(uuid.uuid4())
    try:
        accounts_backup.record_export(accounts_part, backup_id)
    except Exception as exc:                                        # pragma: no cover - defensive
        log_error(f"[backup] could not record the backup: {exc}", exc_info=exc)
    try:
        with get_db() as conn:
            backup_history.record(
                conn, backup_id=backup_id, made_at=written["exported_at"], made_by=made_by,
                filename=saved_as or filename,
                encrypted=encrypted, key_labels=[r["label"] for r in selected] if encrypted else None,
                credentials_included=accounts_part["credentials"] is not None,
                credentials_left_out=(accounts_part.get("credentials_left_out") or {}).get("code"),
                total_bytes=size, ledger_bytes=written["ledger_bytes"], accounts_bytes=written["accounts_bytes"],
                documents_bytes=written["documents_bytes"], document_count=written["document_count"],
                database_check=None if check_passed is None else ("passed" if check_passed else "failed"),
            )
    except Exception as exc:                                        # pragma: no cover - defensive
        log_error(f"[backup] could not record the backup in the history: {exc}", exc_info=exc)

    return StreamingResponse(
        _stream_file_out(artifact),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Known because the artifact is complete before the first byte is sent, which is what lets a
            # download show progress instead of an indeterminate spinner.
            "Content-Length": str(size),
            "X-Backup-Id": backup_id,
        },
    )


def _target_has_data(conn) -> bool:
    """Whether the current data DB holds user data — accounts or transactions. A fresh install has
    neither (seeded categories/rules don't count). Drives both the restore compatibility guard and
    the UI's choice of confirmation wording."""
    return bool(
        conn.execute("SELECT 1 FROM account LIMIT 1").fetchone()
        or conn.execute("SELECT 1 FROM txn LIMIT 1").fetchone()
    )


@router.get("/restore/target-status")
def restore_target_status():
    """Lets the restore UI tailor its confirmation: a fresh (empty) system gets a light prompt, a
    system with real data gets the strong "this overwrites everything" warning.

    `relinked_since_reset` names the connections reconnected since the vault was last reset after a lost
    passphrase. Every credential here was cleared by that reset, so one held now was linked since, and
    restoring the accounts part of a backup older than the reset replaces it with the backup's or clears
    it. After a retirement as untrusted the restore asks about the backup's credentials itself
    (`credentials_retired`), so nothing is said here."""
    with get_db() as conn:
        status = {"has_data": _target_has_data(conn)}
        # A routine key replacement clears nothing, so it is not the retirement this asks about.
        retirement = control_database.latest_vault_key_retirement(("lost",) + crypto_service.UNTRUSTED_RETIREMENTS)
        if retirement and retirement["reason"] == "lost":
            names = [r["nickname"] or r["institution"] or r["provider"] for r in conn.execute(
                "SELECT nickname, institution, provider FROM connection WHERE COALESCE(credential_enc, '') != '' "
                "ORDER BY rowid"
            )]
            if names:
                status["relinked_since_reset"] = {"reset_at": retirement["retired_at"], "connections": names}
        return status


def _wipe_user_data_tables(conn):
    """Delete every user-data row in child→parent order. The single source of truth for the destructive
    wipe, shared by restore and the demo-data clear. The caller owns the transaction and must have
    foreign-key checks deferred (PRAGMA defer_foreign_keys = ON), since the order here is dependency-safe
    but not validated row-by-row. Tag attachment tables and `tag` go first: the attachments reference
    tag/txn/category/account/rule, and `tag` is not a child of anything else wiped below. This clears
    `import_workflow_state` too, so any demo-data marker is removed as part of the wipe."""
    conn.execute("DELETE FROM txn_tag")
    conn.execute("DELETE FROM category_tag")
    conn.execute("DELETE FROM account_tag")
    conn.execute("DELETE FROM account_balance")
    conn.execute("DELETE FROM rule_tag")
    conn.execute("DELETE FROM account_pair_distinct")
    conn.execute("DELETE FROM amazon_charge_distinct")
    conn.execute("DELETE FROM suspect_pair_distinct")
    conn.execute("DELETE FROM amazon_charge_reviewed")
    # Parked Amazon items (awaiting their orders file) have no FK to cascade them, so the wipe must clear
    # them explicitly — otherwise pre-restore parked rows would linger and wrongly auto-attach to restored
    # orders. (They are restored from the backup payload right after, like every other data table.)
    conn.execute("DELETE FROM amazon_pending_item")
    conn.execute("DELETE FROM ui_preference")
    conn.execute("DELETE FROM tag")
    # Membership overrides reference both txn and recurring_series, so clear them before either.
    conn.execute("DELETE FROM recurring_membership_override")
    # Signal dismissals hold no foreign key (their subject is a fingerprint, not a row id), so nothing
    # cascades them — the wipe has to name the table or pre-restore dismissals would survive it.
    conn.execute("DELETE FROM recurring_signal_dismissal")
    conn.execute("DELETE FROM rule_overlap_dismissal")
    # Recorded rule conflicts are not backed up, and the rows they name are about to go.
    conn.execute("DELETE FROM rule_conflict")
    conn.execute("DELETE FROM rule_alert_hit")
    # Link members reference txn (and link) via ON DELETE CASCADE; the link rows themselves have no FK
    # to txn, so they must be deleted explicitly or they'd survive the wipe as orphans.
    conn.execute("DELETE FROM txn_link_member")
    conn.execute("DELETE FROM txn_link")
    # Attached documents go with their transactions by cascade, but a *stored* one has no transaction to
    # take it, so the table is named. Only rows: the files are swept after the caller commits.
    conn.execute("DELETE FROM document")
    conn.execute("DELETE FROM txn")
    # After txn (which references recurring_series via recurring_series_id), before category/account
    # (which recurring_series references).
    conn.execute("DELETE FROM recurring_series")
    # Owed rescans name payees of the ledger being replaced. Not backed up (derived state), so the
    # restored ledger starts owing nothing; the daily full scan covers a debt the backup was taken with.
    conn.execute("DELETE FROM recurring_rescan_owed")
    conn.execute("DELETE FROM import_batch_duplicate")
    conn.execute("DELETE FROM import_batch_rejected_row")
    conn.execute("DELETE FROM import_batch_account")
    conn.execute("DELETE FROM import_batch")
    conn.execute("DELETE FROM import_workflow_state")
    conn.execute("DELETE FROM category_rule")
    # Named rather than left to its cascade from csv_import_profile: foreign keys are deferred for the
    # whole wipe, and a watched folder's per-file watermark describes *this* machine's filesystem, so
    # it must not outlive the sources it belongs to under any ordering.
    conn.execute("DELETE FROM import_watch_file")
    conn.execute("DELETE FROM csv_import_profile")
    # Amazon funding-source → account map references account (ON DELETE CASCADE), so clear it before
    # account so it doesn't survive as an orphan / rely on cascade during the deferred-FK wipe.
    conn.execute("DELETE FROM amazon_funding_map")
    conn.execute("DELETE FROM category")
    conn.execute("DELETE FROM connection_account")
    conn.execute("DELETE FROM account")
    conn.execute("DELETE FROM owner")


# What a data restore writes onto a connection row: everything the backup knows about it except its
# identity, and its resume point and request budget, which are each decided separately.
_RESTORED_CONNECTION_STATE = (
    "nickname", "captured_fields", "realtime_balances", "last_synced_at", "last_sync_error", "last_sync_error_at",
    "consecutive_sync_failures", "last_sync_warnings", "reauth_required", "last_sync_outcome",
    "last_sync_summary",
)


def _backup_age_days(header: dict) -> Optional[float]:
    """Days since the backup was written, or None when it does not say."""
    raw = str(header.get("exported_at") or "").strip()
    if not raw:
        return None
    try:
        exported = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if exported.tzinfo is None:
        exported = exported.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - exported) / timedelta(days=1)


def _newer_request_budget(local: Optional[tuple], restored: tuple) -> tuple:
    """Which of two `(provider_request_budget, provider_request_budget_at)` copies to keep: the one written
    last. The spending belongs to the credential, so the current copy is on whichever system used it most
    recently, and an older copy has refilled since anyway. An unstamped copy loses to a stamped one."""
    if local is None:
        return restored
    if restored[1] and (not local[1] or restored[1] > local[1]):
        return restored
    return local


def _restore_connections(conn, rows, header: dict, *, replace: bool = False) -> tuple[dict[str, str], list[str]]:
    """Return every connection the backup names to the state the backup recorded. Answers which local row
    each backup id became, and the names of the connections removed.

    **`replace`** is for a restore that also brings back the credentials, the other half of each row.
    Nothing here then needs keeping, so the table is emptied and the backup's connections go in as
    recorded, for the credentials to be written onto. A connection the backup does not name is removed as a
    disconnect without revoking would remove it, and named in the result: access it was granted may still
    be live at the provider, and that is for the user to deal with.

    Otherwise `connection` is not wiped, because its credentials belong to the other half of the backup, and
    this reconciles:

    - **Known here** (same id, or the same provider handle under a different id): its recorded state is
      written over the live row, and the credential stays.
    - **Unknown here** (a fresh install, or credentials not restored yet): the row is created with no
      credential — the state a vault reset leaves, "waiting to be re-linked" — so the accounts, mappings and
      import cards that belong to it survive instead of being dropped for want of a parent. A credentials
      restore later fills the credential in on this same row.
    - **Either way, a row left with no credential is flagged `reauth_required`**, as a vault reset flags
      it: the backup's flag described a connection that had one, and without the flag the card reads as
      healthy until a sync fails on it.
    - **Here but not in the backup**: its synced rows were just wiped with the rest of the ledger, so it
      returns to its never-synced state (`forget_synced_state`), as *Remove synced transactions* leaves it.
      Its credential and spending stay. A backup older than this section names no connections, so every
      local one takes this path.

    **The resume point is the backup's own**, which is what makes this a return to the backed-up state
    rather than a fresh start: it was written in the same export as the rows, so it claims exactly the data
    just restored — and a delta sync from it re-delivers everything the provider reported since, including
    rows added after the backup. Two cases cannot vouch for it and reset instead: a backup older than
    `RESTORED_CURSOR_MAX_AGE_DAYS` (or with no date), and a live row whose handle has changed since, which
    names a different feed.

    **The request budget is whichever copy was written last** (`_newer_request_budget`), in both modes.
    """
    age = _backup_age_days(header)
    cursor_trusted = age is not None and age <= RESTORED_CURSOR_MAX_AGE_DAYS
    live_cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)").fetchall()}
    state_columns = [c for c in _RESTORED_CONNECTION_STATE if c in live_cols]
    # Bounded by the number of connections, and read twice in replace mode.
    rows = [row for row in rows if row.get("id") and row.get("provider")]
    id_map: dict[str, str] = {}
    removed: list[str] = []
    replaced_budgets: dict = {}
    if replace:
        named_ids = {row["id"] for row in rows}
        named_handles = {(row["provider"], row["external_id"]): row["id"] for row in rows if row.get("external_id")}
        for local in conn.execute(
                "SELECT id, provider, external_id, institution, nickname, provider_request_budget, "
                "provider_request_budget_at FROM connection").fetchall():
            handle = (local["provider"], local["external_id"])
            if local["id"] in named_ids or handle in named_handles:
                budget = (local["provider_request_budget"], local["provider_request_budget_at"])
                replaced_budgets[local["id"]] = replaced_budgets[handle] = budget
                conn.execute("DELETE FROM connection WHERE id = ?", (local["id"],))
                if local["id"] not in named_ids:
                    # The same connection under the backup's id: its log follows it.
                    conn.execute("UPDATE connection_sync_log SET connection_id = ? WHERE connection_id = ?",
                                 (named_handles[handle], local["id"]))
            else:
                remove_connection(conn, local, revoked=False, reason="restored")
                removed.append(local["nickname"] or local["institution"] or local["provider"])
    for row in rows:
        backup_id, provider, external_id = row["id"], row["provider"], row.get("external_id")
        local = conn.execute(
            "SELECT id, external_id, provider_request_budget, provider_request_budget_at FROM connection "
            "WHERE id = ?", (backup_id,)).fetchone()
        if local is None and external_id is not None:
            local = conn.execute(
                "SELECT id, external_id, provider_request_budget, provider_request_budget_at FROM connection "
                "WHERE provider = ? AND external_id = ?",
                (provider, external_id),
            ).fetchone()
        if local is not None:
            local_budget = (local["provider_request_budget"], local["provider_request_budget_at"])
        else:
            local_budget = replaced_budgets.get(backup_id) or replaced_budgets.get((provider, external_id))
        budget, budget_at = _newer_request_budget(
            local_budget, (row.get("provider_request_budget"), row.get("provider_request_budget_at")))
        keep_cursor = cursor_trusted and (local is None or local["external_id"] == external_id)
        values = {column: row.get(column) for column in state_columns}
        for column in ("consecutive_sync_failures", "reauth_required", "realtime_balances"):
            if column in values:
                values[column] = int(values[column] or 0)
        values["transactions_cursor"] = row.get("transactions_cursor") if keep_cursor else None
        values["initial_sync_complete"] = int(row.get("initial_sync_complete") or 0) if keep_cursor else 0
        values["provider_request_budget"], values["provider_request_budget_at"] = budget, budget_at
        if row.get("institution") is not None:
            values["institution"] = row["institution"]
        if local is None:
            values.update(id=backup_id, provider=provider, external_id=external_id, credential="",
                          credential_enc=None)
            if row.get("created_at"):
                values["created_at"] = row["created_at"]
            columns = list(values)
            conn.execute(
                f"INSERT INTO connection ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
                [values[c] for c in columns],
            )
            id_map[backup_id] = backup_id
        else:
            columns = list(values)
            conn.execute(
                f"UPDATE connection SET {', '.join(f'{c} = ?' for c in columns)} WHERE id = ?",
                [values[c] for c in columns] + [local["id"]],
            )
            id_map[backup_id] = local["id"]

    restored = sorted(set(id_map.values()))
    # Not in replace mode: there the credentials are written next, and the credentials restore flags each
    # connection the file holds none for.
    if restored and not replace:
        conn.execute(
            "UPDATE connection SET reauth_required = 1 "
            f"WHERE id IN ({', '.join('?' * len(restored))}) "
            "AND COALESCE(credential_enc, '') = '' AND COALESCE(credential, '') = ''",
            restored,
        )
    unnamed = conn.execute(
        "SELECT id FROM connection"
        + (f" WHERE id NOT IN ({', '.join('?' * len(restored))})" if restored else ""),
        restored,
    ).fetchall()
    forget_synced_state(conn, [r["id"] for r in unnamed])
    return id_map, removed


def _reconcile_restored_connection_accounts(conn, connection_accounts, accounts):
    """Reconcile restored `connection_account` rows against the live `connection` table.

    The mapping points at `account` (restored from this payload) and at `connection`, as
    `_restore_connections` left it. A backup older than the connections section names no connection,
    so it can carry mappings for connections that do not exist here. Those rows are **dropped** rather than inserted with a
    dangling FK.

    Account ids survive a restore as-is (the payload carries them), so the FKs only need validating,
    not re-resolving; a target that didn't survive is nulled, matching how the account table's own
    link reconciliation treats an absent connection.
    """
    valid_conn_ids = {r["id"] for r in conn.execute("SELECT id FROM connection")}
    valid_account_ids = {row.get("id") for row in accounts if row.get("id")}
    kept = []
    for row in connection_accounts:
        if row.get("connection_id") not in valid_conn_ids:
            continue
        for key in ("account_id", "target_account_id"):
            if row.get(key) and row[key] not in valid_account_ids:
                row[key] = None
        kept.append(row)
    return kept


def _reconcile_restored_account_links(conn, accounts, backup_version):
    """Reconcile each restored account's connection link against the live `connection` table, as
    `_restore_connections` left it. Two jobs:

    - **v7 → 6b-3 translation.** A v7 backup carries the pre-6b-3 columns `plaid_account_id` and
      `plaid_item_id`; the current schema has `external_account_id` / `connection_id` / `provider`.
      `insert_rows` would silently drop the unknown v7 keys, so map them here: the per-account handle
      becomes `external_account_id`; a real `plaid_item_id` (an item_id) resolves to its live connection's
      id + provider, while the `'csv_import'`/`'manual'` sentinels become an origin-only provider with no
      connection.
    - **Dangling-FK normalization (any version).** `connection_id` references the live connection table,
      which a cross-system restore won't share — a stale id would fail the deferred FK check. Null out any
      `connection_id` not present locally. v7-derived ids come straight from the live table so always pass;
      this guards v8 backups carried in from another system.
    """
    conn_by_external = {}
    valid_conn_ids = set()
    for r in conn.execute("SELECT id, external_id, provider FROM connection"):
        valid_conn_ids.add(r["id"])
        if r["external_id"] is not None:
            conn_by_external[r["external_id"]] = (r["id"], r["provider"])
    for row in accounts:
        if backup_version == 7:
            if row.get("external_account_id") is None and "plaid_account_id" in row:
                row["external_account_id"] = row.get("plaid_account_id")
            legacy_item = row.get("plaid_item_id")
            if row.get("connection_id") is None and legacy_item not in (None, "", "csv_import", "manual"):
                match = conn_by_external.get(legacy_item)
                row["connection_id"] = match[0] if match else None
            if row.get("provider") is None:
                if legacy_item == "csv_import":
                    row["provider"] = "csv"
                elif legacy_item == "manual":
                    row["provider"] = "manual"
                elif legacy_item not in (None, ""):
                    match = conn_by_external.get(legacy_item)
                    row["provider"] = match[1] if match else "plaid"
        if row.get("connection_id") and row["connection_id"] not in valid_conn_ids:
            row["connection_id"] = None


# --- Reading an archive back --------------------------------------------------------------------
# The mirror of the writer: `meta.json` for the header and the per-member digests, one NDJSON member
# per section read a line at a time. Nothing here materializes a section, which is what lets a restore
# cost the same for a ledger of any size.

def _read_archive_meta(zf) -> dict:
    try:
        meta = json.loads(zf.read(META_MEMBER).decode("utf-8"))
    except KeyError:
        raise HTTPException(status_code=400, detail="This backup is missing its meta.json — the file is not a Luma backup archive, or it is truncated.")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable backup metadata: {exc}")
    if not isinstance(meta, dict):
        raise HTTPException(status_code=400, detail="Unreadable backup metadata")
    return meta


def read_archive_section(zf, section: str):
    """Yield a section's rows. An absent member yields nothing rather than failing: sections are added
    over time, and a backup written before one existed is missing it in exactly this way."""
    name = _section_member(section)
    try:
        member = zf.open(name)
    except KeyError:
        return
    with io.TextIOWrapper(member, encoding="utf-8") as lines:
        for line in lines:
            line = line.strip()
            if line:
                yield json.loads(line)


def verify_archive_members(zf, meta: dict) -> None:
    """Recompute every member digest recorded in `meta.json` and refuse a mismatch.

    Runs to completion *before* anything destructive, which is the whole point: a corrupted or truncated
    download must not get as far as wiping the target. Streaming the members to hash them costs a second
    pass over a local file — disk, not memory — and is the price of not holding the archive in RAM to
    check it. Like the version-9 hash it replaces, this is an unsigned checksum: it detects accidental
    corruption, not tampering.
    """
    members = meta.get("members")
    if not isinstance(members, dict):
        return
    for name, recorded in members.items():
        expected = (recorded or {}).get("sha256") if isinstance(recorded, dict) else None
        if not expected:
            continue
        digest = hashlib.sha256()
        try:
            with zf.open(name) as member:
                while True:
                    chunk = member.read(STREAM_CHUNK_BYTES)
                    if not chunk:
                        break
                    digest.update(chunk)
        except KeyError:
            raise HTTPException(status_code=400, detail=f"This backup is missing {name}, which its own manifest lists — the file is incomplete.")
        if digest.hexdigest() != expected:
            raise HTTPException(
                status_code=400,
                detail="This backup failed its integrity check (content hash mismatch) — the file is corrupted, truncated, or was edited after export.",
            )


# --- Restore ------------------------------------------------------------------------------------
# One core, two front doors: an archive streamed member by member, and a payload handed over as a dict
# (`POST /restore`, and every version-7-to-9 backup, whose whole payload is a single JSON object). The
# core consumes a `section_rows(section) -> iterable of row dicts` callable so neither front door needs
# to know how the other one gets its rows.

# Rows per executemany. The batch is the only thing the insert path holds, so this is the memory
# ceiling of a restore; large enough that the per-statement overhead disappears.
INSERT_BATCH_ROWS = 500


def _insert_section(conn, table, rows, transform=None) -> None:
    """Insert a section's rows in batches, taking the column list from the first row.

    Restore must survive schema drift across versions: a backup taken before a column was dropped still
    carries that column in its payload (e.g. `category_rule.priority`, removed once rule ordering became
    automatic). Intersecting the payload's keys with the columns the live table actually has skips a
    since-removed column instead of failing the whole restore with "no column named ...". The inverse — a
    backup predating a column the schema has since gained — already works: the column is simply absent
    and takes its default.
    """
    live_cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    columns = None
    statement = None
    batch = []
    for row in rows:
        if transform is not None:
            row = transform(row)
        if columns is None:
            columns = [key for key in row.keys() if key in live_cols]
            if not columns:
                return
            statement = (f"INSERT OR IGNORE INTO {table} ({','.join(columns)}) "
                         f"VALUES ({','.join('?' * len(columns))})")
        batch.append([row.get(column) for column in columns])
        if len(batch) >= INSERT_BATCH_ROWS:
            conn.executemany(statement, batch)
            batch.clear()
    if batch:
        conn.executemany(statement, batch)


# Referential repair, expressed as SQL over the restored tables rather than as set membership over the
# payload in memory. A backup can outlive the deletions and schema tightening that happened after it was
# taken, so restore is best-effort: rather than failing an entire archive over one dangling reference, it
# nulls what is optional and drops what is meaningless, then commits a consistent database.
#
# This runs inside the restore transaction, which defers foreign-key enforcement to commit — so rows may
# be inserted in any order and repaired afterwards, and only the final state has to be valid. Doing it in
# SQL is what removes the last thing a restore held in memory: the id sets it used to build per table.
#
# Three kinds, and the difference between the last two is a product decision, not a technicality:
#   nullify   - the reference is optional; a broken one becomes "none" and the row stays.
#   require   - the row is meaningless without the reference (an attachment with no transaction, a rule
#               with no category), so it goes. A NULL counts as broken here for the same reason.
#   drop_link - NULL is a legitimate state but a *broken* reference is not, so the row goes rather than
#               being silently downgraded to the NULL state, which would mean something different (an
#               Amazon funding mapping with no account is "untracked", which is not what a lost account
#               should turn into).
_RESTORE_NULLIFY = (
    ("account", "owner_id", "owner"),
    ("account", "parent_account_id", "account"),
    ("category", "parent_id", "category"),
    ("csv_import_profile", "account_id", "account"),
    ("import_batch", "profile_id", "csv_import_profile"),
    # A sync card from a backup that predates the `connections` section names a connection this install may
    # not have. The card stays; it simply stops belonging to a live connection, as after a disconnect.
    ("import_batch", "connection_id", "connection"),
    ("recurring_series", "category_id", "category"),
    ("recurring_series", "account_id", "account"),
    ("txn", "owner_id", "owner"),
    ("txn", "category_id", "category"),
    ("txn", "import_batch_id", "import_batch"),
    ("txn", "recurring_series_id", "recurring_series"),
    # The row a duplicate was matched against. A pointer at a row the backup no longer holds names nothing,
    # which is how the dangling-pointer sweep after an undo treats it too.
    ("txn", "suspect_duplicate_of", "txn"),
    # The orders import that took a parked Amazon item. Without that import nothing holds the order, so the
    # item is waiting again, as undoing the import would leave it.
    ("amazon_pending_item", "consumed_batch_id", "import_batch"),
)

# Parents first: most of these children declare ON DELETE CASCADE, so dropping an orphaned rule or
# transaction takes its attachments with it, and the sweeps that follow only have to catch children whose
# parent was never inserted at all.
_RESTORE_REQUIRE = (
    ("category_rule", "category_id", "category"),
    ("txn", "account_id", "account"),
    ("import_batch_account", "batch_id", "import_batch"),
    ("import_batch_duplicate", "batch_id", "import_batch"),
    ("import_batch_rejected_row", "batch_id", "import_batch"),
    ("txn_tag", "txn_id", "txn"),
    ("txn_tag", "tag_id", "tag"),
    ("category_tag", "category_id", "category"),
    ("category_tag", "tag_id", "tag"),
    ("account_tag", "account_id", "account"),
    ("account_tag", "tag_id", "tag"),
    ("account_balance", "account_id", "account"),
    ("rule_tag", "rule_id", "category_rule"),
    ("rule_tag", "tag_id", "tag"),
    ("rule_alert_hit", "rule_id", "category_rule"),
    ("rule_alert_hit", "txn_id", "txn"),
    ("account_pair_distinct", "account_id_low", "account"),
    ("account_pair_distinct", "account_id_high", "account"),
    ("amazon_charge_distinct", "txn_id_low", "txn"),
    ("amazon_charge_distinct", "txn_id_high", "txn"),
    ("suspect_pair_distinct", "txn_id_low", "txn"),
    ("suspect_pair_distinct", "txn_id_high", "txn"),
    ("amazon_charge_reviewed", "txn_id", "txn"),
    ("recurring_membership_override", "txn_id", "txn"),
    ("recurring_membership_override", "series_id", "recurring_series"),
    ("txn_link_member", "link_id", "txn_link"),
    ("txn_link_member", "txn_id", "txn"),
)

_RESTORE_DROP_LINK = (
    ("import_batch_account", "account_id", "account"),
    # order_id is an external Amazon reference and carries no ledger FK; only the batch that parked the
    # item can strand it, and an orphan without its batch is unreachable.
    ("amazon_pending_item", "parked_batch_id", "import_batch"),
    ("amazon_funding_map", "funding_account_id", "account"),
    ("amazon_funding_map", "amazon_account_id", "account"),
)


def _apply_referential_rules(conn) -> None:
    # Each rule is skipped when the live schema has no such column, for the same reason the insert path
    # intersects payload keys with `PRAGMA table_info`: a reference these rules name can be dropped by a
    # later migration, and a restore must not start failing on SQL about a column that no longer exists.
    def has_column(table, column):
        return column in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}

    for table, column, parent in _RESTORE_NULLIFY:
        if has_column(table, column):
            conn.execute(
                f"UPDATE {table} SET {column} = NULL "
                f"WHERE {column} IS NOT NULL AND {column} NOT IN (SELECT id FROM {parent})"
            )
    for table, column, parent in _RESTORE_REQUIRE:
        if has_column(table, column):
            conn.execute(
                f"DELETE FROM {table} "
                f"WHERE {column} IS NULL OR {column} NOT IN (SELECT id FROM {parent})"
            )
    for table, column, parent in _RESTORE_DROP_LINK:
        if has_column(table, column):
            conn.execute(
                f"DELETE FROM {table} "
                f"WHERE {column} IS NOT NULL AND {column} NOT IN (SELECT id FROM {parent})"
            )


def _legacy_transaction_transform(backup_version):
    """Map a pre-v9 backup's `plaid_transaction_id` onto the current `external_transaction_id`.

    The column was renamed once it stopped being Plaid-specific (v26, following `plaid_account_id` ->
    `external_account_id` in v20). The insert path silently drops keys the schema does not have, so
    without this every restored transaction would come back with no provider id at all — and since that id
    is what makes a sync idempotent, the next sync would re-add every one of them as a fresh row.
    """
    if backup_version is None or backup_version >= 9:
        return None

    def translate(row):
        if "plaid_transaction_id" in row and row.get("external_transaction_id") is None:
            row["external_transaction_id"] = row.pop("plaid_transaction_id")
        return row

    return translate


def _transaction_transform(backup_version):
    """Every per-row translation a restored transaction may need, in the order its format changed.

    Re-dating (v59) cannot wait for the post-restore data-init that other migrations use: the insert drops
    `authorized_date`, which the current table no longer has, so it has to be read before the row lands.
    """
    legacy = _legacy_transaction_transform(backup_version)

    def translate(row):
        if legacy is not None:
            row = legacy(row)
        return redate_txn_row_to_transaction_date(row)

    return translate


def _redate_held_duplicate(row):
    """A held synced row in a pre-v59 backup, moved to the transaction date like the ledger's own rows."""
    if '"authorized_date"' not in (row.get("txn_payload_json") or ""):
        return row
    try:
        values = json.loads(row["values_json"]) if row.get("values_json") else None
        payload = json.loads(row["txn_payload_json"])
    except (TypeError, ValueError):
        return row
    values, payload = redate_held_sync_duplicate(values, payload)
    if values is not None:
        row["values_json"] = json.dumps(values)
    row["txn_payload_json"] = json.dumps(payload)
    return row


def _restore_preflight(header: dict, force: bool, *, restores_data: bool = True,
                       perimeter_follows: bool = False) -> None:
    """Everything that can refuse a restore, run before a single row is touched.

    `restores_data` is false for a restore of the accounts part alone. The compatibility guard is
    about the ledger — whether data here would be erased, whether columns would be lost — so it does not
    apply, and the confirmation the restore surface asks names what the file replaces. `perimeter_follows`
    is true when the restore brings the file's identities and sign-in setting with it, so the access mode
    the backup was made in is the one the install will be in."""
    # Demo data must be cleared first: a restore would replace it but leave the demo marker stale, and
    # mixing real data into a demo tenant breaks the "clear is always safe" contract. Refuse outright.
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before restoring a backup.",
            })
        require_no_pending_restore(conn, "restoring another backup")
        # A sync writes each page against the connection and the ledger a data restore is about to replace,
        # so the two cannot overlap.
        if restores_data and any(sync_marker_is_live(row["sync_started_at"])
                                 for row in conn.execute("SELECT sync_started_at FROM connection")):
            raise HTTPException(status_code=409, detail={
                "code": "sync_running",
                "message": "A data connection is syncing. Wait for it to finish before restoring.",
            })

    # Compatibility guard: a restore unconditionally wipes the target, so refuse to silently replace a
    # *different* system's existing data, or load across access modes, unless the user has explicitly
    # confirmed (force). Allowed without confirmation: an empty target (fresh install) or restoring this
    # system's own backup (matching instance_id) in the same mode.
    if force or not restores_data:
        return
    backup_mode = header.get("access_mode")
    backup_instance = header.get("instance_id")
    backup_schema = header.get("schema_version")
    target_mode = "auth" if auth_required() else "local"
    with get_db() as conn:
        target_instance = get_db_instance_id(conn)
        has_data = _target_has_data(conn)
    reasons = []
    if backup_mode and backup_mode != target_mode and not perimeter_follows:
        reasons.append("mode_mismatch")
    if has_data and backup_instance != target_instance:
        reasons.append("different_system")
    # A backup from a *newer* schema than this build is the one direction that can lose data: restore
    # drops columns this schema doesn't know (see _insert_section), so a column the newer build added with
    # real content would vanish silently. Warn before that downgrade. The reverse — an older backup (or one
    # with no schema_version) — is safe and never flagged.
    if isinstance(backup_schema, int) and backup_schema > CURRENT_VERSION:
        reasons.append("newer_schema")
    if reasons:
        raise HTTPException(status_code=409, detail={
            "code": "restore_incompatible",
            "reasons": sorted(set(reasons)),
            "backup_mode": backup_mode,
            "target_mode": target_mode,
            "backup_schema_version": backup_schema,
            "target_schema_version": CURRENT_VERSION,
        })


def _restore_sections(conn, header: dict, section_rows, backup_version, source: Optional[dict] = None, *,
                      preference_owners: set[str], replaces_connections: bool = False) -> tuple[dict, list[str]]:
    """Wipe and rebuild every data table from `section_rows`, inside one transaction. Answers the count of
    each section that landed, and the names of the connections removed.

    `source` describes the uploaded file, for the history row a restore from another system writes for
    it (`_restore_backup_history`). `preference_owners` are the users who exist once the restore is done
    (`_restore_preferences`). `replaces_connections` is true when the credentials are restored as well, so
    the connections are replaced rather than reconciled (`_restore_connections`).

    All-or-nothing on purpose. The restore has many cross-table and self-referential foreign keys, and a
    single correct insert order would be brittle, so the whole wipe+reload runs with foreign-key checks
    DEFERRED to commit: rows go in in any order, dangling references are repaired afterwards, and the
    fully-populated final state is validated as a whole when the transaction commits. One transaction is
    also what makes a *failed* restore leave the target untouched, and its size costs no memory: an open
    write transaction spills to the WAL.

    Two sections are materialized rather than streamed, both bounded by the size of the chart of accounts
    rather than by the ledger: `accounts`, because its connection links are reconciled against the live
    `connection` table as a set, and `connection_accounts`, which is reconciled against the accounts.
    """
    # Whether the backup is this system's own has to be decided *before* anything is touched, because the
    # restore gives the system a new `instance_id` further down and the question is unanswerable
    # afterwards. It decides whose backup history survives, and whether these are still this machine's
    # watched folders, where an empty target also counts as another system: nothing about a fresh install
    # says another machine's paths still mean what they meant there.
    backup_instance = header.get("instance_id")
    same_system = bool(backup_instance) and backup_instance == get_db_instance_id(conn)
    restoring_onto_another_instance = not same_system or not _target_has_data(conn)

    conn.execute("BEGIN IMMEDIATE")
    conn.execute("PRAGMA defer_foreign_keys = ON")
    previous_preferences = [dict(row) for row in conn.execute(
        "SELECT * FROM ui_preference WHERE scope_id != ?", (SHARED_SCOPE_ID,))]
    _wipe_user_data_tables(conn)

    _insert_section(conn, "owner", section_rows("owners"))

    # Before anything that references a connection: accounts, their mappings and the sync cards all name
    # one, and each is kept only if that connection exists here once this has run.
    connection_ids, removed_connections = _restore_connections(
        conn, section_rows("connections"), header, replace=replaces_connections)

    def _local_connection(row):
        if row.get("connection_id") in connection_ids:
            row["connection_id"] = connection_ids[row["connection_id"]]
        return row

    accounts = [_local_connection(dict(row)) for row in section_rows("accounts")]
    for row in accounts:
        row["display_name"] = (row.get("display_name") or row.get("name") or "").strip() or (row.get("name") or "")
    # Resolve account→connection links against the live connection table: translate a v7 payload's legacy
    # plaid_* columns and null out any connection_id absent locally.
    _reconcile_restored_account_links(conn, accounts, backup_version)
    _insert_section(conn, "account", accounts)

    # connection_account references both `account` (restored just above) and `connection` (reconciled or
    # replaced above): rows whose connection is absent locally are dropped rather than inserted dangling.
    connection_accounts = _reconcile_restored_connection_accounts(
        conn, [_local_connection(dict(row)) for row in section_rows("connection_accounts")], accounts
    )
    _insert_section(conn, "connection_account", connection_accounts)
    del accounts, connection_accounts

    reconciled = {"owners", "connections", "accounts", "connection_accounts", "backup_history", "ui_preferences"}
    transforms = {
        "transactions": _transaction_transform(backup_version),
        "import_batches": _local_connection,
        "import_batch_duplicates": _redate_held_duplicate,
    }
    for section, table, _query in BACKUP_SECTIONS:
        if section in reconciled:
            continue
        _insert_section(conn, table, section_rows(section), transforms.get(section))
    _restore_preferences(conn, section_rows("ui_preferences"), preference_owners, previous_preferences)

    _apply_referential_rules(conn)
    # After the preferences, which hold the history's retention.
    _restore_backup_history(conn, same_system, section_rows("backup_history"), header, source)

    # Every restore makes a new system: the data has gone back in time or come from elsewhere, so a backup
    # made before it, here or on the system the file came from, is no longer this system's own and has to
    # pass the compatibility guard's `different_system` question. Restoring the same file twice therefore
    # asks the second time, which is correct, since the second restore would erase whatever the first one
    # was followed by.
    new_db_instance_id(conn)

    # A restored source carries the paths of the machine the backup came from, and a path that resolves
    # here may mean something else — the installs in use include a source checkout and a portable build
    # with their own layouts. Watching is switched off rather than repointed or guessed at, keeping the
    # paths so the person can say per source whether each is right on this machine or should be cleared.
    if restoring_onto_another_instance:
        disable_watching(conn)

    # The data restored verbatim, but it's only as migrated as the backup was. The target schema is
    # already current, so re-running migrations would be schema-only no-ops — what's missing is the
    # *data-init* half of every migration newer than the backup (rename provenance, account types +
    # money-movement consolidation, last_effect_date + is_managed). Run exactly those, in order, so
    # restored data ends up equivalent to an in-place upgrade. A backup with no/unknown schema_version
    # (incl. pre-rebrand) is treated as Luma v1 → all post-rebrand data-init runs.
    run_post_restore_data_init(conn, header.get("schema_version"))

    # Hand the restore over to its documents phase, atomically with the ledger this marker describes.
    # Written here rather than after the commit because that is the whole point of the phase: a crash
    # before commit must leave neither the ledger nor the marker, and a commit must leave both. The
    # earlier `staging` row is replaced in place, so its artifact path — the thing a resume needs —
    # carries forward. Rewritten unconditionally, including when the payload named no documents at all:
    # the phase still owes the directory sweep that removes the previous ledger's files.
    staging = get_restore_state(conn)
    set_restore_state(
        conn, RESTORE_PHASE_DOCUMENTS,
        staging["artifact_path"] if staging else None,
        staging["artifact_id"] if staging else None,
    )

    # Counted from the tables rather than from what the payload offered, so the report is what actually
    # landed — net of rows dropped as unreferenced, and of any the unique constraints ignored.
    return {
        section: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for section, table, _query in BACKUP_SECTIONS
    }, removed_connections


def _restore_backup_history(conn, same_system: bool, rows, header: dict, source: Optional[dict]) -> None:
    """Decide whose backup history the restored system keeps (`services/backup_history.py`).

    Restoring this system's own backup keeps the live history, which already holds every row the file's
    copy does and every backup made since; the table is not in the wipe for that reason. Anything else
    takes the file's history, as a restore onto an empty system does, and adds a row for the file itself,
    since a backup never holds its own row."""
    if same_system:
        return
    conn.execute("DELETE FROM backup_history")
    _insert_section(conn, "backup_history", rows)
    source = source or {}
    backup_history.record(
        conn, made_at=header.get("exported_at"), made_by=header.get("made_by"), filename=source.get("filename"),
        encrypted=source.get("encrypted"), key_labels=source.get("key_labels"),
        credentials_included=header.get("credentials_included"), total_bytes=source.get("total_bytes"),
        ledger_bytes=source.get("ledger_bytes"), accounts_bytes=source.get("accounts_bytes"),
        documents_bytes=source.get("documents_bytes"), document_count=source.get("document_count"),
        restored_at=utcnow_iso(),
    )


# --- restore_state: carrying a restore across the gap between the ledger and the files ------------
# A restore commits the ledger atomically and then writes files, which are not transactional. This
# marker is what makes that gap survivable rather than silent. It records a *phase*, because the two
# possible states mean opposite things about the data:
#
#   staging           — the restore has not committed. NOTHING was changed, so finding this after a
#                       crash means the attempt can simply be reported and the row cleared.
#   documents_pending — the ledger is live and its files are not all there yet, so the documents phase
#                       has work left and the app should say so rather than serve broken links.
#
# The two writes are deliberately in different transactions. `staging` goes in its own short one, which
# is what makes a running restore *visible* to other requests at all — a `get_db()` block commits on
# exit, so a marker written inside the long restore transaction would stay invisible until it ended, by
# which point it has nothing left to guard. `documents_pending` goes inside the restore transaction, so
# it exists exactly when the ledger it describes exists.

def _artifact_identity(header: dict) -> str:
    """Enough of a backup's identity to recognize the same artifact again — which system it came from
    and when it was taken. Used only when the staged file is gone and a resume needs to confirm that a
    re-uploaded backup is *this* one, rather than filling the document directory from a different one."""
    return f"{header.get('instance_id') or ''}@{header.get('exported_at') or ''}"


def _begin_restore(header: dict, artifact_path: Optional[str]) -> None:
    """Claim the restore slot, refusing a second one. Its own transaction, so it is visible immediately.

    A concurrent restore is refused rather than queued: two of them wiping and rebuilding the same
    ledger has no coherent outcome, and the second would be racing the first's document phase over the
    same files.
    """
    with get_db() as conn:
        existing = get_restore_state(conn)
        if existing:
            raise HTTPException(status_code=409, detail={
                "code": "restore_in_progress",
                "message": (
                    "A restore is already in progress."
                    if existing["phase"] == RESTORE_PHASE_STAGING
                    else "A previous restore still has documents to write. Finish or clear it first."
                ),
            })
        set_restore_state(conn, RESTORE_PHASE_STAGING, artifact_path, _artifact_identity(header))


def _abandon_restore_if_staging() -> None:
    """Release the slot if the restore never committed.

    Only `staging` is cleared. A `documents_pending` marker means the ledger *did* commit and its files
    are still owed, which is exactly the state that must survive to be resumed — clearing it here would
    throw away the only record that anything is outstanding.
    """
    with get_db() as conn:
        state = get_restore_state(conn)
        if state and state["phase"] == RESTORE_PHASE_STAGING:
            clear_restore_state(conn)


@router.get("/restore/state")
def restore_state_status():
    """Whether a restore is running or has documents outstanding, for the surfaces that must say so.

    While documents are pending the ledger is correct but some attachments have no file yet, so this is
    what lets the app explain that instead of showing a broken link with no reason.
    """
    with get_db() as conn:
        state = get_restore_state(conn)
        if not state:
            return {"phase": None}
        pending = missing_document_ids(conn) if state["phase"] == RESTORE_PHASE_DOCUMENTS else []
        return {
            "phase": state["phase"],
            "started_at": state["started_at"],
            "documents_pending": len(pending),
            "artifact_available": bool(state["artifact_path"] and os.path.exists(state["artifact_path"])),
        }


@router.post("/restore/resume-documents", dependencies=[Depends(require_admin_or_local)])
def resume_restore_documents():
    """Finish the documents phase of a restore that was interrupted after its ledger committed.

    The staged artifact is re-read and every document the ledger still lacks is written. There is no
    progress cursor anywhere in this design: with a digest on each `document` row, "what is missing" is
    a comparison between the committed ledger and the directory, which is computable in one pass,
    self-correcting, and able to catch a *torn* file that a position counter would skip straight past.
    """
    with get_db() as conn:
        state = get_restore_state(conn)
    if not state or state["phase"] != RESTORE_PHASE_DOCUMENTS:
        raise HTTPException(status_code=409, detail={
            "code": "no_documents_pending",
            "message": "No restore is waiting to finish writing documents.",
        })
    path = state["artifact_path"]
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=409, detail={
            "code": "artifact_missing",
            "message": (
                "The backup this restore came from is no longer staged, so its documents cannot be "
                "recovered here. Restore the same backup again to finish them."
            ),
        })
    with open(path, "rb") as staged, zipfile.ZipFile(staged) as zf:
        documents = _restore_documents(zf)
    # Outside the `with`, because the handle above has to be closed before the file can be deleted on
    # Windows. The phase cleared the marker, so nothing claims it any more; a phase that raised instead
    # never reaches this and leaves the artifact for the next attempt.
    Path(path).unlink(missing_ok=True)
    return {"ok": True, "documents": documents}


@router.post("/restore", dependencies=[Depends(require_admin_or_local)])
def restore_backup(body: RestoreRequest):
    """Destructive restore from a payload held in memory: version 7-9 backups, whose entire payload is one
    JSON object, and any caller posting one directly. Credentials are never touched.

    Version 10 archives have their own entry point (`restore_from_archive`) that streams instead; this one
    is bounded by whatever the caller already materialized.
    """
    return restore_payload(body.data, body.force)


def _restore_preferences(conn, rows, owners: set[str], previous: list[dict]) -> None:
    """Put back preferences only for the users who exist once the restore is done: the backup's users when
    its accounts part is restored too, this install's users when only the data is. Each of them takes their
    settings from the backup where it has some and keeps their own where it has none. A row for anyone else
    would belong to no one, since preferences are keyed by user id alone. The ledger-wide scope belongs to
    the ledger and always comes from the backup."""
    keep = {SHARED_SCOPE_ID, *owners}
    _insert_section(conn, "ui_preference", (row for row in rows if row.get("scope_id") in keep))
    restored = {row["scope_id"] for row in conn.execute("SELECT DISTINCT scope_id FROM ui_preference")}
    _insert_section(conn, "ui_preference",
                    (row for row in previous if row["scope_id"] in owners and row["scope_id"] not in restored))


def _current_user_ids() -> set[str]:
    return {user["id"] for user in control_database.list_users()}


def restore_payload(payload: dict, force: bool = False, source: Optional[dict] = None) -> dict:
    """`restore_backup` for a payload already in hand, with the uploaded file's `source` description when
    there was one."""
    backup_version = payload.get("version")
    if backup_version not in RESTORABLE_PAYLOAD_VERSIONS:
        raise HTTPException(status_code=400, detail="Unrecognized or unsupported backup version")
    # Integrity check before anything destructive: a corrupted/truncated file must not get as far as
    # wiping the target. No-op for backups that predate the hash field.
    _verify_payload_content_hash(payload)
    _restore_preflight(payload, force)

    def section_rows(section):
        return (dict(row) for row in payload.get(section) or [])

    # No artifact path: this payload arrived as a parsed body and there is no staged file to resume
    # from, so the documents phase here is one-shot by nature.
    _begin_restore(payload, None)
    try:
        with get_db() as conn:
            counts, _removed = _restore_sections(conn, payload, section_rows, backup_version, source,
                                                 preference_owners=_current_user_ids())
    finally:
        _abandon_restore_if_staging()
    documents = _restore_documents(None)
    forget_startup_routes()
    compact_if_worthwhile(reason="restored a backup")
    return {"ok": True, "restored_at": utcnow_iso(), "restored_counts": counts, "documents": documents,
            "database_check_passed": database_health.check_passed()}


# Typed to restore credentials under a key this system retired as untrusted (`restore_from_archive`).
RETIRED_CREDENTIALS_CONFIRM_PHRASE = "RESTORE ANYWAY"


def restore_from_archive(zf, force: bool = False, artifact_path: Optional[str] = None, *,
                         include_data: bool = True, include_accounts: bool = False,
                         include_credentials: bool = True,
                         restore_retired_credentials: Optional[bool] = None,
                         retired_credentials_confirm: Optional[str] = None,
                         admin_username: Optional[str] = None, admin_password: Optional[str] = None,
                         page_rp_id: Optional[str] = None, leave_passkeys_elsewhere: bool = False,
                         source: Optional[dict] = None) -> dict:
    """Destructive restore straight from an opened version-10-or-later archive, one member at a time.

    `artifact_path` is where the staged copy of this archive lives, when it has one. Recording it is
    what makes the documents phase resumable: the ledger commits before a single file is written, so an
    interruption after that point needs the source still to exist.

    `source` describes the uploaded file (`_restore_backup_history`); the sizes are read here.

    `include_data` and `include_accounts` choose which of the parts the file holds to apply; a part the file
    does not hold is not applied whatever is asked. `include_credentials` false restores the accounts part
    as a file without credentials restores (`accounts_backup.apply`).

    Credentials under a key this install retired as untrusted (`crypto_service.UNTRUSTED_RETIREMENTS`) are
    put back only on the restorer's say: `restore_retired_credentials` None refuses with
    `credentials_retired`, naming the retirement, so the dialog can ask; False withholds them, and True
    restores them and forgets the retirement, since the key is this vault's again. True needs
    `retired_credentials_confirm` to be the typed `RETIRED_CREDENTIALS_CONFIRM_PHRASE`, as a vault reset
    needs its phrase. Withholding cannot be absolute: stopping the app, deleting both databases and
    restoring the same file puts them back too.

    Vault and sign-in passkeys registered under a host name this install is never opened at are not
    restored (`accounts_backup.passkeys_elsewhere`), and the restore says so first: `leave_passkeys_elsewhere`
    False refuses with `passkeys_elsewhere`, naming them, the people left without vault access and this
    install's names, so the restorer can serve it under the name they need before restoring. `page_rp_id`
    is the name the restoring page was opened under (`transport.passkey_host_names`).

    Everything that can refuse — the digests, the compatibility guard, the restoring administrator's
    password, the retired key and the passkeys left behind — runs before anything is touched.
    The financial data then commits and the accounts part follows (`accounts_backup.apply`). With both the
    data and the credentials restored, the connections are replaced outright rather than reconciled, and
    `removed_connections` names those this install had and the backup does not.

    A restore rewrites the tables inside the existing files rather than replacing them, so a file that was
    damaged before can still be damaged after. Both databases are checked once it is done, and the result
    says whether they passed (`database_check_passed`, None when the check could not run).
    """
    meta = _read_archive_meta(zf)
    kind = meta.get("kind") or BACKUP_KIND_DATA
    restores_data = include_data
    restores_accounts = include_accounts and kind == BACKUP_KIND_FULL
    if not (restores_data or restores_accounts):
        raise HTTPException(status_code=400, detail="Nothing was chosen that this backup holds.")
    backup_version = meta.get("version")
    if restores_data and backup_version not in RESTORABLE_PAYLOAD_VERSIONS:
        raise HTTPException(status_code=400, detail="Unrecognized or unsupported backup version")
    verify_archive_members(zf, meta)
    _restore_preflight(meta, force, restores_data=restores_data, perimeter_follows=restores_accounts)
    accounts_part = read_accounts_part(zf, meta) if restores_accounts else None
    withheld = None
    if accounts_part is not None:
        _check_restoring_admin(accounts_part, admin_username, admin_password)
        if not include_credentials:
            accounts_part["credentials"] = None
        retired_slots = None
        if accounts_part["credentials"] is not None:
            slots = accounts_part["credentials"].get("vault_slots")
            retirement = crypto_service.exported_slots_retirement(slots)
            if retirement and restore_retired_credentials is None:
                raise HTTPException(status_code=409, detail={
                    "code": "credentials_retired",
                    "message": "This backup's data provider credentials are under a vault key this system "
                               "retired.",
                    "reason": retirement["reason"],
                    "retired_at": retirement["retired_at"],
                    "confirm_phrase": RETIRED_CREDENTIALS_CONFIRM_PHRASE,
                })
            if (retirement and restore_retired_credentials
                    and (retired_credentials_confirm or "").strip().upper() != RETIRED_CREDENTIALS_CONFIRM_PHRASE):
                raise HTTPException(status_code=400, detail={
                    "code": "confirmation_required",
                    "message": f"Type {RETIRED_CREDENTIALS_CONFIRM_PHRASE} to confirm.",
                })
            if retirement and restore_retired_credentials:
                retired_slots = slots
            elif retirement:
                # The rest of the part restores as a file without credentials does.
                withheld = retirement["reason"]
                accounts_part["credentials"] = None
        passkey_hosts = transport.passkey_host_names(page_rp_id)
        left_behind = accounts_backup.passkeys_elsewhere(accounts_part, passkey_hosts)
        if left_behind and not leave_passkeys_elsewhere:
            raise HTTPException(status_code=409, detail={
                "code": "passkeys_elsewhere",
                "message": "Some of this backup's passkeys were registered under a host name this system "
                           "is not opened at, so they cannot be restored.",
                **left_behind,
            })

    # Who exists once this is done: the backup's users when its accounts part goes back, this install's
    # otherwise. Only their preferences are kept.
    owners = ({user["id"] for user in accounts_part.get("users") or []} if accounts_part is not None
              else _current_user_ids())
    result = {"ok": True}
    if restores_data:
        _begin_restore(meta, artifact_path)
        try:
            with get_db() as conn:
                counts, removed_connections = _restore_sections(
                    conn, meta, lambda section: read_archive_section(zf, section),
                    backup_version, {**(source or {}), **archive_sizes(zf)},
                    preference_owners=owners,
                    # With the credentials coming back too, both halves of every connection row are the
                    # backup's, so nothing on this install's rows is left to keep.
                    replaces_connections=accounts_part is not None and accounts_part["credentials"] is not None,
                )
        finally:
            # Clears the slot only if the ledger never committed. A successful restore has already moved
            # the marker to `documents_pending` inside its own transaction, and that one has to survive.
            _abandon_restore_if_staging()
        result["documents"] = _restore_documents(zf)
        result["restored_counts"] = counts
        result["removed_connections"] = removed_connections
        compact_if_worthwhile(reason="restored a backup")
    if accounts_part is not None:
        result["accounts"] = accounts_backup.apply(accounts_part, passkey_hosts)
        if left_behind:
            result["passkeys_elsewhere"] = left_behind
        if retired_slots is not None:
            crypto_service.forget_exported_slots_retirement(retired_slots)
        # With the data left as it was, the preferences of users the accounts part removed would belong to
        # no one. After a data restore too this changes nothing, since that kept only these users already.
        with get_db() as conn:
            keep_preferences_of(conn, owners)
        # The identities every session was authenticated against have just been replaced.
        result["signed_out"] = True
        if withheld:
            result["credentials_withheld"] = withheld
    forget_startup_routes()
    result["restored_at"] = utcnow_iso()
    result["database_check_passed"] = database_health.check_passed()
    return result


def read_accounts_part(zf, meta: dict) -> dict:
    """The accounts part of an archive whose members have already been verified."""
    if meta.get("accounts_version") not in accounts_backup.RESTORABLE_ACCOUNTS_PART_VERSIONS:
        raise HTTPException(status_code=400, detail="This backup's accounts are in a format this version cannot read")
    part = {}
    for rows in accounts_backup.ROW_LISTS:
        try:
            member = zf.open(_accounts_member(rows))
        except KeyError:
            part[rows] = []
            continue
        with io.TextIOWrapper(member, encoding="utf-8") as lines:
            part[rows] = [json.loads(line) for line in lines if line.strip()]
    # Absent when the backup left the credentials out; the part then restores without them.
    part["credentials"] = (
        json.loads(zf.read(ACCOUNTS_CREDENTIALS_MEMBER).decode("utf-8")) if meta.get("credentials_included") else None
    )
    return part


def _check_restoring_admin(part: dict, username: Optional[str], password: Optional[str]) -> None:
    try:
        accounts_backup.check_restoring_admin(part, username, password)
    except accounts_backup.AdminPasswordRequired as required:
        raise HTTPException(status_code=400, detail={
            "code": "incorrect_admin_password" if required.attempted else "admin_password_required",
            "message": (
                "That is not the password of an administrator in this backup."
                if required.attempted else
                "This backup turns sign-in on. Enter the username and password of an administrator in it, "
                "so the restore cannot leave this system with no one able to sign in."
            ),
            "admins": required.admins,
        })


def _restore_documents(zf) -> dict:
    """Rebuild the document store from the archive, after the ledger has committed.

    `zf` is None on the JSON-body restore path, which carries rows but can carry no files. That is not a
    special case to guard: every document the payload named is then simply missing, and the sweep still
    has to run, because the ledger was replaced and the files behind the old one must not survive it.

    **Tables first, then documents**, which is why this runs outside the restore transaction rather than
    inside it. The reverse order would leave, on a crash, new files beside the old ledger whose own
    documents had already been replaced — strictly worse than the window this creates, in which an
    attachment indicator exists for a file not yet on disk.

    Written **in place**, each file through the store's atomic temp-and-replace. Staging the whole set
    into a sibling directory and swapping at the end was the first instinct and is worse: it costs 2x
    disk on precisely the class of data that grows without bound, and buys nothing, because documents are
    immutable and content-addressed — an id plus a digest either matches or it does not.

    **The directory is not cleared up front.** Restore is destructive, but the destructive half is
    derivable: once every document from the archive is written, files the restored ledger no longer
    references are swept. Doing it last means an interrupted restore leaves inert litter rather than lost
    originals.

    **A document that fails its digest does not fail the restore.** The ledger is already committed and
    correct; one unreadable receipt is one missing file, reported here, rather than costing the user
    their entire ledger. A file that arrives corrupt is removed rather than left in place, so what
    remains on disk is always either complete or absent — the invariant every later digest comparison
    (including a resumed restore) depends on.

    **A document the archive did not carry is decided by the digest, not by the id.** Ids are stable
    across backups of the same install, so a file for that id may already be sitting in the store — from
    an earlier restore, or because this backup was taken here. It cannot simply be *left*: the restored
    ledger now references that id, so the sweep will not reclaim it, and the app would treat whatever is
    there as the document. Compared against the row's digest it is either genuinely the right file, in
    which case the archive's gap costs nothing and it is **retained**, or it is a stale file from the
    ledger this restore just replaced, in which case it is deleted. Nothing survives unverified, which
    is the same rule the corrupt branch follows.
    """
    restored, retained, missing, corrupt = 0, [], [], []
    with get_db() as conn:
        rows = [dict(row) for row in conn.execute("SELECT id, sha256 FROM document ORDER BY rowid")]
        for row in rows:
            # An id that cannot name a file is treated as a document that did not arrive, not as a
            # failure: a restore must never let a hand-edited archive decide where bytes are written.
            if not is_safe_document_id(row["id"]):
                missing.append(row["id"])
                continue
            try:
                source = zf.open(_document_member(row["id"])) if zf is not None else None
            except KeyError:
                source = None
            if source is None:
                path = document_file_path(row["id"])
                if file_digest(path) == row["sha256"]:
                    retained.append(row["id"])
                else:
                    path.unlink(missing_ok=True)
                    missing.append(row["id"])
                continue
            with source:
                digest = copy_document_file_from(row["id"], source)
            if digest == row["sha256"]:
                restored += 1
            else:
                # Deliberately deleted rather than kept: a file that does not match its digest is not the
                # document, and leaving it would make "present on disk" stop meaning "intact".
                document_file_path(row["id"]).unlink(missing_ok=True)
                corrupt.append(row["id"])
        swept = sweep_unreferenced_files(conn)
        # The phase is over: every document the archive could supply has been written and the directory
        # has been reconciled against the ledger. `missing` and `corrupt` are *reported*, not retried —
        # rerunning would produce the same answer, since neither the archive nor the ledger will change.
        #
        # Clearing the marker un-claims the staged artifact, but **deleting it is the caller's job, not
        # this function's**: every caller is still inside the `with` that holds that same file open, and
        # Windows refuses to delete a file any handle is holding — including one this process opened
        # itself (WinError 32). Deleting it here worked on POSIX and turned a completed restore into a
        # 500 on Windows. Each caller unlinks after closing; see `restore_backup_file` and
        # `resume_restore_documents`.
        clear_restore_state(conn)
    return {
        "restored": restored,
        "retained": len(retained),
        "missing": len(missing),
        "corrupt": len(corrupt),
        "swept": len(swept),
    }


# --- Uploads: staging, decryption, and dispatch --------------------------------------------------
# A data backup can be arbitrarily large, so an upload is spooled to a staging file beside the database
# and read from there — never `await file.read()`, which would put the whole artifact back in memory and
# undo the streaming on the other side of the round trip.

async def _spool_upload(upload: UploadFile, sink) -> None:
    while True:
        chunk = await upload.read(STREAM_CHUNK_BYTES)
        if not chunk:
            break
        sink.write(chunk)


def _is_encrypted_archive(zf) -> bool:
    names = {name for name in zf.namelist() if not name.endswith("/")}
    has_manifest = "manifest.json" in names
    has_payload = "payload.bin" in names
    if has_manifest != has_payload:
        raise HTTPException(status_code=400, detail="Encrypted backup ZIP must include both manifest.json and payload.bin")
    return has_manifest


def _unwrap_content_key(manifest: dict, private_key_bytes: Optional[bytes], passphrase: Optional[str]) -> bytes:
    if not private_key_bytes:
        raise HTTPException(status_code=400, detail="Encrypted backup requires a private key file for restore")
    private_key = _load_private_key(private_key_bytes, passphrase)
    if not isinstance(private_key, rsa.RSAPrivateKey):
        raise HTTPException(status_code=400, detail="Only RSA private keys are supported for encrypted backups")
    for wrapped in manifest.get("wrapped_keys", []):
        wrapped_key = (wrapped or {}).get("wrapped_key")
        if not wrapped_key:
            continue
        try:
            return private_key.decrypt(
                _b64url_decode(wrapped_key),
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            )
        except Exception:
            continue
    raise HTTPException(status_code=400, detail="This private key does not match any of the keys this backup was encrypted to")


def decrypt_archive_to_temp(zf, private_key_bytes: Optional[bytes], passphrase: Optional[str]):
    """Decrypt `payload.bin` into a staging file and return it, positioned at the start.

    GCM authenticates only at the very end, so the decision this makes is deliberate: the plaintext is
    written to a local staging file as it is decrypted, but the tag is verified before the caller is given
    anything back, and a failure raises rather than returning a handle. Nothing acts on unverified
    plaintext — the file exists but is never opened as an archive, and is discarded on the way out.

    The tag is the last 16 bytes of the member. Since a zip member is read forwards, the trailing 16 bytes
    are held back in a rolling window rather than sought to.
    """
    try:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable encrypted backup manifest: {exc}")
    if manifest.get("format") not in {"luma-encrypted-backup", "fintrack-encrypted-backup"}:
        raise HTTPException(status_code=400, detail="Unsupported encrypted backup format")

    content_key = _unwrap_content_key(manifest, private_key_bytes, passphrase)
    nonce = _b64url_decode(manifest.get("nonce"))
    decryptor = Cipher(algorithms.AES(content_key), modes.GCM(nonce)).decryptor()

    plaintext = backup_temp_file()
    try:
        tail = b""
        with zf.open("payload.bin") as sealed:
            while True:
                chunk = sealed.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                buffered = tail + chunk
                tail = buffered[-16:]
                body = buffered[:-16]
                if body:
                    plaintext.write(decryptor.update(body))
        if len(tail) < 16:
            raise HTTPException(status_code=400, detail="This encrypted backup is truncated — it does not carry a complete authentication tag.")
        try:
            plaintext.write(decryptor.finalize_with_tag(tail))
        except InvalidTag:
            raise HTTPException(
                status_code=400,
                detail="This backup failed its integrity check — the file is corrupted, truncated, or was edited after export.",
            )
    except BaseException:
        plaintext.close()
        raise
    plaintext.seek(0)
    return plaintext


def _restore_from_zip(zf, force: bool, artifact_path: Optional[str] = None, source: Optional[dict] = None,
                      **accounts_options) -> dict:
    """Restore an opened backup zip, whichever generation it is: version 10 streams from its members,
    older versions are a single JSON object that has to be read whole. `accounts_options` are
    `restore_from_archive`'s, and mean nothing to the older versions, which never carried accounts."""
    if META_MEMBER in set(zf.namelist()):
        return restore_from_archive(zf, force, artifact_path=artifact_path, source=source, **accounts_options)
    return restore_payload(_read_single_json_member(zf), force, source)


def _single_json_member_name(zf) -> str:
    """The sole JSON member of a pre-version-10 archive. What the member is *called* no longer decides
    which backup it is — the payload does — so this only has to find it."""
    members = [name for name in zf.namelist() if not name.endswith("/")]
    if len(members) != 1:
        raise _unrecognized_backup("A zipped backup should contain a single JSON file.")
    if not members[0].lower().endswith(".json"):
        raise _unrecognized_backup("A zipped backup should contain a single JSON file.")
    return members[0]


def _read_single_json_member(zf) -> dict:
    member = _single_json_member_name(zf)
    try:
        return json.loads(zf.read(member).decode("utf-8"))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid ZIP backup: {exc}")


# --- Identifying a backup file --------------------------------------------------------------------
# The backups are different artifacts with different consequences — the financial data, the accounts, both,
# or an older standalone credentials file — but to the person holding the file they are all "my backup",
# and being asked which kind it is means being asked to know how the app is split internally. So the file
# says what it is and the app reads it, rather than the choice of upload control deciding.
#
# The declaration lives in three places, one per container, and in every case *outside* any ciphertext:
# `meta.json` for a version-10-or-later archive, the payload itself for a credentials backup, and
# `manifest.json` for an encrypted archive — the last of which is the point, since an encrypted backup
# has to be identifiable before anyone has produced a private key for it. Naming the kind reveals
# nothing the filename did not already say.
#
# Files written before the field exists are identified by shape instead: the section names a payload
# carries are as good a fingerprint as a declaration, and every older format has distinctive ones.

_KIND_MARKERS = (
    # Data first, because its markers are the unambiguous ones: no credentials payload has ever carried a
    # ledger section, while a data payload carries a `connections` section of its own (the non-secret half
    # of each connection, from payload version 15). Credentials: `plaid_items` is the v1 shape,
    # `connections`/`provider_configs` v2+, and `vault` rides v3+.
    (BACKUP_KIND_DATA, ("owners", "transactions", "accounts", "categories")),
    (BACKUP_KIND_CREDENTIALS, ("connections", "provider_configs", "plaid_items", "vault")),
)


def _payload_kind(payload: dict, member_name: str = "") -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    declared = payload.get("kind")
    if declared in (BACKUP_KIND_DATA, BACKUP_KIND_CREDENTIALS):
        return declared
    for kind, markers in _KIND_MARKERS:
        if any(marker in payload for marker in markers):
            return kind
    # Last resort for a file whose payload is unrecognizable but whose member name is not: both exports
    # have always named their member, and an empty ledger's backup carries little else to go on.
    lowered = (member_name or "").lower()
    if "credential" in lowered:
        return BACKUP_KIND_CREDENTIALS
    if "backup" in lowered:
        return BACKUP_KIND_DATA
    return None


def _unrecognized_backup(detail: str = "") -> HTTPException:
    suffix = f" {detail}" if detail else ""
    return HTTPException(
        status_code=400,
        detail=f"This file does not look like a {app_name()} backup.{suffix}",
    )


def _credentials_flag(header: dict) -> dict:
    """Whether a file's accounts part carries the credentials, for a file that has one."""
    flag = header.get("credentials_included")
    return {} if flag is None else {"credentials_included": bool(flag)}


def identify_backup_zip(zf) -> dict:
    """What this archive is, without decrypting anything or reading a whole payload."""
    names = {name for name in zf.namelist() if not name.endswith("/")}
    if "manifest.json" in names or "payload.bin" in names:
        if not ("manifest.json" in names and "payload.bin" in names):
            raise _unrecognized_backup("An encrypted backup must contain both manifest.json and payload.bin.")
        try:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Unreadable encrypted backup manifest: {exc}")
        if manifest.get("format") not in {"luma-encrypted-backup", "fintrack-encrypted-backup"}:
            raise HTTPException(status_code=400, detail="Unsupported encrypted backup format")
        wrapped_keys = manifest.get("wrapped_keys")
        if not isinstance(wrapped_keys, list) or not wrapped_keys:
            raise HTTPException(status_code=400, detail="Encrypted backup does not contain any wrapped keys")
        recipients = [{
            "recipient_id": wrapped.get("recipient_id"),
            "label": wrapped.get("label") or "Unnamed recipient",
            "fingerprint": wrapped.get("fingerprint"),
            "algorithm": wrapped.get("algorithm"),
        } for wrapped in wrapped_keys if isinstance(wrapped, dict)]
        return {
            # Older manifests predate the field, and only data backups have ever had an encrypted
            # variant — a credentials payload is already ciphertext and gains nothing from a second layer.
            "kind": manifest.get("kind") or BACKUP_KIND_DATA,
            **_credentials_flag(manifest),
            "exported_at": manifest.get("exported_at"),
            "encrypted": True,
            "container": "zip",
            "version": manifest.get("version"),
            "cipher": manifest.get("cipher"),
            "recipient_count": len(recipients),
            "recipients": recipients,
        }

    if META_MEMBER in names:
        meta = _read_archive_meta(zf)
        return {
            "kind": meta.get("kind") or BACKUP_KIND_DATA,
            **_credentials_flag(meta),
            "exported_at": meta.get("exported_at"),
            "encrypted": False,
            "container": "zip",
            "version": meta.get("version"),
        }

    payload = _read_single_json_member(zf)
    kind = _payload_kind(payload, _single_json_member_name(zf))
    if not kind:
        raise _unrecognized_backup()
    return {"kind": kind, "exported_at": payload.get("exported_at"), "encrypted": False, "container": "zip",
            "version": payload.get("version")}


def identify_backup_file(fileobj) -> dict:
    """Identify a staged upload, whatever container it arrived in."""
    fileobj.seek(0)
    if zipfile.is_zipfile(fileobj):
        fileobj.seek(0)
        try:
            with zipfile.ZipFile(fileobj) as zf:
                return identify_backup_zip(zf)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid ZIP backup: {exc}")
    fileobj.seek(0)
    payload = _read_bare_json(fileobj)
    kind = _payload_kind(payload)
    if not kind:
        raise _unrecognized_backup()
    return {"kind": kind, "exported_at": payload.get("exported_at"), "encrypted": False, "container": "json",
            "version": payload.get("version")}


_KIND_NAMES = {
    BACKUP_KIND_DATA: "data backup",
    BACKUP_KIND_FULL: "full backup",
    BACKUP_KIND_CREDENTIALS: "credentials backup",
}


def _require_kind(identification: dict, *expected: str) -> None:
    """Refuse a backup an endpoint does not handle.

    The unified picker routes by `kind`, so reaching this means an API caller sent the wrong file — but
    it is also the case a person hits first when the kinds are confusable, and "unexpected file inside ZIP"
    told them nothing about what they had actually chosen.
    """
    found = identification.get("kind")
    if found in expected:
        return
    names = [_KIND_NAMES[kind].removesuffix(" backup") for kind in expected]
    wanted = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} or {names[-1]}"
    raise HTTPException(
        status_code=400,
        detail=f"This is a {_KIND_NAMES.get(found, 'different kind of backup')}, not a {wanted} backup.",
    )


@router.post("/restore-file/inspect")
async def inspect_backup_file(file: UploadFile = File(...)):
    """What the selected file is, so the restore surface can present the right flow for it rather than
    asking the user to classify their own backup."""
    with backup_temp_file() as staged:
        await _spool_upload(file, staged)
        return identify_backup_file(staged)


def _read_bare_json(fileobj) -> dict:
    try:
        return json.loads(fileobj.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON backup: {exc}")


def _payload_opens_with_local_dek(user, connections: list[dict], provider_configs: list[dict]) -> bool:
    """Whether this file's secrets are already sealed under the live workspace DEK.

    One sample settles it: every secret in a file was sealed under the same DEK, so if one opens they all
    do, and if one does not the file belongs to some other workspace key. A file with no ciphertext at all
    (a v1/v2 plaintext payload) answers False — there is nothing to copy verbatim.
    """
    for c in connections:
        if c.get("credential_enc"):
            try:
                crypto_service.decrypt_connection_credential(
                    user, c["provider"], c["external_id"], c.get("credential"), c["credential_enc"],
                )
                return True
            except Exception:
                return False
    for pc in provider_configs:
        if pc.get("secret_enc"):
            try:
                crypto_service.decrypt_app_credential(
                    user, pc["provider"], pc.get("secret"), pc["secret_enc"],
                )
                return True
            except Exception:
                return False
    return False


def _foreign_backup_prompt(slots: list[dict], user) -> str:
    """Whose secret to ask for, said in terms of where the file came from.

    Reaching here means the live DEK does not open this file, so the secret wanted is never simply
    "yours" — and "enter the passphrase this was created with" leaves someone guessing which of their own
    passphrases that was. The slots name the account they were written for, which separates the two cases
    worth telling apart.
    """
    if user and any(s.get("user_id") == user.get("id") for s in slots):
        return ("This backup was made under a different vault key on this account — open it with the "
                "vault passphrase, recovery code or passkey that was in force when it was created.")
    return ("This backup came from another install — open it with the vault passphrase, recovery code or "
            "passkey of the member who made it.")


def _exported_slots(d: dict, version: int) -> list[dict]:
    """The slots a credentials payload carries, whatever its version: v5 lists them, v3/v4 carried one."""
    if version >= 5:
        return [dict(s) for s in d.get("vault_slots") or []]
    return [dict(d["vault"])] if d.get("vault") else []


def _unlock_options(slots: list[dict], request: Request) -> dict:
    """Which of the exporter's secrets this page can use to open the file.

    A passkey is offered only where it can work: a passkey answers at the host name it was registered
    under and nowhere else, and a ceremony offered anywhere else fails with nothing to say why. So it needs
    a page the browser will run a ceremony on, at the name recorded with the slot."""
    context = transport.passkey_context(request) if request is not None else {"available": False, "rp_id": None}
    recovery = next((s for s in slots if s.get("method") == "recovery"), None)
    return {
        "passphrase":    any(s.get("method", "passphrase") == "passphrase" for s in slots),
        "recovery_code": {"issued_at": recovery.get("issued_at")} if recovery else None,
        "passkeys": [
            {"credential_id": s["credential_id"], "prf_salt": s["prf_salt"], "label": s.get("label") or "Passkey"}
            for s in slots
            if s.get("method") == "passkey" and context["available"]
            and crypto_service.exported_passkey_answers_at(s, {context["rp_id"]})
        ],
        "rp_id": context["rp_id"],
    }


def _backup_deks(body: CredentialsRestoreRequest, slots: list[dict]) -> list[bytes] | None:
    """The workspace keys the secret in this request opens from the file's slots, or None when the request
    carries none. Raises `ValueError` when the secret is wrong or names a slot the file does not hold."""
    if body.passphrase:
        method, secret, match = "passphrase", body.passphrase, None
    elif body.recovery_code:
        method, secret, match = "recovery", body.recovery_code, None
    elif body.passkey_credential_id and body.passkey_prf_output:
        method, secret, match = "passkey", body.passkey_prf_output, body.passkey_credential_id
    else:
        return None
    slot = next(
        (s for s in slots
         if s.get("method", "passphrase") == method and (match is None or s.get("credential_id") == match)),
        None,
    )
    if slot is None:
        raise ValueError("this backup does not carry that kind of vault key")
    return crypto_service.deks_from_exported_slot(slot, secret)


@router.post("/restore/credentials", dependencies=[Depends(require_admin_or_local)])
def restore_credentials(body: CredentialsRestoreRequest, request: Request):
    """Restore a standalone credentials backup, the kind written before the accounts part replaced it.

    Such a file carries no identities, so its slots may belong to no one here and are never adopted: the
    credentials are copied when they are already valid under this install's key, and otherwise reopened
    with one of the exporter's secrets and re-sealed under it, into whatever vault is here."""
    # Blocked while demo data is loaded, like every other path that brings data in. This one is not merely
    # for consistency: it inserts `connection` rows, and a linked connection is exactly what
    # `is_demo_loadable` treats as disqualifying, so restoring here would produce the one state the demo
    # design says cannot exist — a demo tenant with a live data source. Since "clear demo data" is allowed
    # to wipe the whole tenant precisely because nothing non-demo can have been added, anything that
    # connection then synced would be erased as though it were demo data.
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before restoring credentials.",
            })

    d = body.data
    version = d.get("version")
    if version not in RESTORABLE_CREDENTIALS_VERSIONS:
        raise HTTPException(status_code=400, detail="Unrecognized credentials backup version")
    _verify_payload_content_hash(d)
    # v3+ carry ciphertext + the exporting member's own key material (`_exported_slots`); v2 carries
    # provider-agnostic connections in plaintext; v1 (legacy) carried plaintext Plaid items — fold those
    # into provider='plaid' connections so an older credentials export still restores after the cutover.
    encrypted = version >= 3
    if version >= 2:
        connections = [dict(c) for c in d.get("connections", [])]
    else:
        connections = [
            {
                "provider":    "plaid",
                "external_id": item["item_id"],
                "credential":  item["access_token"],
                "institution": item.get("institution"),
            }
            for item in d.get("plaid_items", [])
        ]
    # App-level provider credentials ride the same credentials backup (v2+; legacy v1 had none).
    provider_configs = [dict(pc) for pc in d.get("provider_configs", [])] if version >= 2 else []
    slots = _exported_slots(d, version) if encrypted else []
    user = getattr(request.state, "user", None)
    if encrypted and crypto_service.exported_slots_retired(slots):
        raise HTTPException(status_code=409, detail={
            "code": "credentials_retired",
            "message": "These credentials were sealed under a vault key that was replaced or reset after an "
                       "exposure, so they are not restored. Reconnect the data sources instead.",
        })

    # A file whose ciphertext is already valid here needs nothing: the rows go back verbatim — no
    # secret, no re-encryption. Two ways to establish that, and the second exists because the first
    # answers a narrower question than the one that matters.
    #
    #   1. One of the file's slots seals the key this install holds now (`exported_slots_hold_live_dek`).
    #      Cheap, and works with the vault still locked, since it compares stored material rather than
    #      using it. The common case: a backup taken here, restored here, whatever has happened to anyone's
    #      passphrase since — short of the key itself being replaced.
    #   2. The file's ciphertext opens under the live DEK. Needs the vault unlocked — it uses the key —
    #      but it tests the property directly, so it also covers a file whose slots no longer exist here.
    verbatim = False
    if encrypted:
        verbatim = crypto_service.exported_slots_hold_live_dek(slots)
        if not verbatim and user and crypto_service.is_unlocked(user["id"]):
            verbatim = _payload_opens_with_local_dek(user, connections, provider_configs)

    # Otherwise every secret has to be reopened with the key that sealed it and re-sealed under this
    # workspace's own. For an encrypted file that key comes from one of the file's slots, opened with the
    # secret that goes with it; for v1/v2 the payload is already plaintext and there is nothing to reopen.
    backup_dek = None
    if encrypted and not verbatim and (connections or provider_configs):
        if not slots:
            raise HTTPException(status_code=400, detail={
                "code": "vault_material_missing",
                "message": "This credentials backup carries no vault key, so its contents cannot be reopened.",
            })
        try:
            backup_dek = _backup_deks(body, slots)
        except ValueError:
            raise HTTPException(status_code=400, detail={
                "code": "incorrect_backup_secret",
                "message": "That does not open this backup's vault key.",
                "unlock_options": _unlock_options(slots, request),
            })
        if backup_dek is None:
            raise HTTPException(status_code=400, detail={
                "code": "backup_secret_required",
                "message": _foreign_backup_prompt(slots, user),
                "unlock_options": _unlock_options(slots, request),
            })

    # Re-encrypting restored credentials under the workspace DEK needs the local vault unlocked.
    if not verbatim and (connections or provider_configs) and not (user and crypto_service.is_unlocked(user["id"])):
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to restore credentials.",
        })

    def _connection_secret(c: dict) -> tuple[str, str | None]:
        """The (credential, credential_enc) pair to store for one incoming row."""
        if verbatim:
            return c.get("credential") or "", c.get("credential_enc")
        plain = (
            crypto_service.decrypt_connection_credential_with_dek(
                backup_dek, c["provider"], c["external_id"], c.get("credential"), c.get("credential_enc"),
            )
            if backup_dek else c.get("credential") or ""
        )
        return crypto_service.encrypt_connection_credential(user, c["provider"], c["external_id"], plain)

    def _provider_secret(pc: dict) -> tuple[str, str | None]:
        if verbatim:
            return pc.get("secret") or "", pc.get("secret_enc")
        plain = (
            crypto_service.decrypt_app_credential_with_dek(
                backup_dek, pc["provider"], pc.get("secret"), pc.get("secret_enc"),
            )
            if backup_dek else pc.get("secret") or ""
        )
        # Only a non-empty app secret is vaulted; a config with just client_id/env stores no ciphertext.
        return crypto_service.encrypt_app_credential(user, pc["provider"], plain) if plain else ("", None)

    with get_db() as conn:
        accounts_backup.write_credentials(conn, connections, provider_configs, _connection_secret, _provider_secret)
    return {"ok": True, "restored": len(connections) + len(provider_configs)}


@router.post("/restore-file", dependencies=[Depends(require_admin_or_local)])
async def restore_backup_file(
    request: Request,
    file: UploadFile = File(...),
    private_key_file: UploadFile | None = File(None),
    private_key_passphrase: str | None = Form(None),
    force: bool = Form(False),
    # Which of the parts the file holds to restore. The defaults restore the financial data, which is all an
    # older file holds; a part the file does not hold is ignored.
    include_data: bool = Form(True),
    include_accounts: bool = Form(False),
    # Within the accounts part: false leaves the vault and the credentials here as they are.
    include_credentials: bool = Form(True),
    # Whether credentials under a key this system retired go back; unset refuses with
    # `credentials_retired` so the restorer can choose (`restore_from_archive`).
    restore_retired_credentials: bool | None = Form(None),
    retired_credentials_confirm: str | None = Form(None),
    # An administrator of the backup, when it turns sign-in on (`accounts_backup.check_restoring_admin`).
    admin_username: str | None = Form(None),
    admin_password: str | None = Form(None),
    # Restore without the vault passkeys registered under a name this system is not opened at, once the
    # restorer has been told which (`passkeys_elsewhere`).
    leave_passkeys_elsewhere: bool = Form(False),
):
    private_key_bytes = await private_key_file.read() if private_key_file else None
    accounts_options = {
        "include_data": include_data, "include_accounts": include_accounts,
        "include_credentials": include_credentials,
        "restore_retired_credentials": restore_retired_credentials,
        "retired_credentials_confirm": retired_credentials_confirm,
        "admin_username": admin_username, "admin_password": admin_password,
        "page_rp_id": transport.passkey_context(request)["rp_id"],
        "leave_passkeys_elsewhere": leave_passkeys_elsewhere,
    }
    # Named, unlike every other staging file here, because the documents phase may need to read it again
    # after the ledger has committed. Removed below unless that phase claimed it.
    staged, staged_path = restore_staging_file()
    try:
        await _spool_upload(file, staged)
        # Identify before anything else: a credentials backup reaching this endpoint should be told what
        # it is, not met with a complaint about the names of the members inside it.
        identification = identify_backup_file(staged)
        _require_kind(identification, BACKUP_KIND_DATA, BACKUP_KIND_FULL)
        source = {
            "filename": file.filename, "total_bytes": staged.seek(0, os.SEEK_END),
            "encrypted": identification.get("encrypted", False),
            "key_labels": [r["label"] for r in identification.get("recipients") or []] or None,
        }
        staged.seek(0)
        if not zipfile.is_zipfile(staged):
            staged.seek(0)
            return restore_payload(_read_bare_json(staged), force, source)
        staged.seek(0)
        with zipfile.ZipFile(staged) as zf:
            if not _is_encrypted_archive(zf):
                return _restore_from_zip(zf, force, artifact_path=staged_path, source=source, **accounts_options)
            plaintext = decrypt_archive_to_temp(zf, private_key_bytes, private_key_passphrase)
            try:
                with zipfile.ZipFile(plaintext) as inner:
                    # **No artifact path on the encrypted path, deliberately.** Resuming would mean
                    # keeping the *decrypted* archive on disk after the request, which is the one thing
                    # an encrypted backup exists to avoid — the staged file beside it is ciphertext and
                    # cannot be reopened without the private key. An interrupted documents phase here is
                    # finished by restoring the same backup again, which the marker's recorded identity
                    # lets the app confirm.
                    return _restore_from_zip(inner, force, source=source, **accounts_options)
            finally:
                plaintext.close()
    finally:
        # Closed *then* deleted, and that order is the requirement rather than tidiness: Windows refuses
        # to unlink a file this process still holds open.
        staged.close()
        _discard_unclaimed_staging(staged_path)


@router.post("/restore/credentials-file", dependencies=[Depends(require_admin_or_local)])
async def restore_credentials_file(request: Request, file: UploadFile = File(...),
                                   passphrase: str | None = Form(None),
                                   recovery_code: str | None = Form(None),
                                   passkey_credential_id: str | None = Form(None),
                                   passkey_prf_output: str | None = Form(None)):
    with backup_temp_file() as staged:
        await _spool_upload(file, staged)
        _require_kind(identify_backup_file(staged), BACKUP_KIND_CREDENTIALS)
        staged.seek(0)
        if zipfile.is_zipfile(staged):
            staged.seek(0)
            with zipfile.ZipFile(staged) as zf:
                payload = _read_single_json_member(zf)
        else:
            staged.seek(0)
            payload = _read_bare_json(staged)
    return restore_credentials(CredentialsRestoreRequest(
        data=payload, passphrase=passphrase, recovery_code=recovery_code,
        passkey_credential_id=passkey_credential_id, passkey_prf_output=passkey_prf_output,
    ), request)
