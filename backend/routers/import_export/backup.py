# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Backup / restore, credentials, and CSV export.

This module covers the three "data leaves the app" / "data comes back in" concerns that are
otherwise independent of the import-run workflow:

- **CSV export** (`/transactions.csv`) — a filtered, flattened dump of the ledger for spreadsheets.
- **Regular backup/restore** (`/backup`, `/restore`, `/restore-file`) — a full app-data archive
  (everything except credentials) that can round-trip the database.
- **Credentials backup/restore** (`/backup/credentials`, `/restore/credentials`) — the Plaid
  access tokens, kept deliberately separate from the regular backup so an ordinary backup never
  carries secrets (see `docs/data-model.md` → Backups).

Both archive classes optionally encrypt to one or more saved RSA recipients (`backup_recipient`):
a random AES-256-GCM content key encrypts the payload and is RSA-OAEP-wrapped per recipient, so a
backup can be decrypted by any holder of a matching private key. The crypto/zip helpers here own
that envelope format; restore inspects an upload, decrypts if needed, and replays it.

Depends only on `core` (and shared services); `core` never imports this module.
"""

import csv
import io
import json
import os
import uuid
import zipfile
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend.db.database import get_db
from backend.services import crypto_service
from backend.services.transaction_tags import VISIBLE_TXN_TAG_SQL

router = APIRouter()


EXPORT_COLUMNS = {
    "date":          ("t.date",            "Date"),
    "merchant_name": ("COALESCE(t.display_name, t.merchant_name, t.raw_name)",   "Merchant"),
    "raw_name":      ("t.raw_name",        "Raw description"),
    "amount":        ("t.amount",          "Amount"),
    "account":       ("COALESCE(a.display_name, a.name)", "Account"),
    "category":      ("c.name",            "Category"),
    "group":         ("p.name",            "Group"),
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


class RestoreRequest(BaseModel):
    data:             dict


class CredentialsRestoreRequest(BaseModel):
    data: dict


# --- Encryption envelope + archive (de)serialization -------------------------------------------
# Encrypted archives are ZIPs of {manifest.json, payload.bin}: payload.bin is the inner backup ZIP
# sealed with a one-shot AES-256-GCM content key, and manifest.json carries that content key
# RSA-OAEP-wrapped once per recipient. Plaintext archives are a single JSON, optionally zipped.

def _zip_json_bytes(filename: str, payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(filename, json.dumps(payload, indent=2, default=str))
    return buf.getvalue()


def _zip_members_bytes(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, content in members.items():
            zf.writestr(name, content)
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


def _validate_backup_recipient_key(public_key_text: str):
    public_key = _load_public_key(public_key_text)
    if not isinstance(public_key, rsa.RSAPublicKey):
        raise HTTPException(status_code=400, detail="Only RSA public keys are supported for encrypted backups")
    return public_key, _rsa_fingerprint(public_key)


def _b64url_decode(value: str) -> bytes:
    value = (value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Encrypted backup metadata is missing required key material")
    padding_needed = (-len(value)) % 4
    return urlsafe_b64decode(value + ("=" * padding_needed))


def _build_encrypted_backup_bytes(payload_bytes: bytes, recipients: list[dict]) -> bytes:
    content_key = AESGCM.generate_key(bit_length=256)
    aesgcm = AESGCM(content_key)
    nonce = os.urandom(12)
    encrypted_payload = aesgcm.encrypt(nonce, payload_bytes, None)

    manifest = {
        "format": "fintrack-encrypted-backup",
        "version": 1,
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

    return _zip_members_bytes({
        "manifest.json": json.dumps(manifest, indent=2).encode("utf-8"),
        "payload.bin": encrypted_payload,
    })


def _inspect_backup_upload(content: bytes, upload_name: str, expected_member_prefix: str) -> dict:
    lower_name = (upload_name or "").lower()
    if not lower_name.endswith(".zip"):
        payload = _load_json_or_zip_payload(content, upload_name, expected_member_prefix)
        return {
            "encrypted": False,
            "container": "json",
            "version": payload.get("version"),
        }

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            members = [name for name in zf.namelist() if not name.endswith("/")]
            member_set = set(members)
            has_manifest = "manifest.json" in member_set
            has_payload = "payload.bin" in member_set
            if has_manifest or has_payload:
                if not (has_manifest and has_payload):
                    raise HTTPException(status_code=400, detail="Encrypted backup ZIP must include both manifest.json and payload.bin")
                manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
                if manifest.get("format") != "fintrack-encrypted-backup":
                    raise HTTPException(status_code=400, detail="Unsupported encrypted backup format")
                wrapped_keys = manifest.get("wrapped_keys")
                if not isinstance(wrapped_keys, list) or not wrapped_keys:
                    raise HTTPException(status_code=400, detail="Encrypted backup does not contain any wrapped recipient keys")
                recipients = []
                for wrapped in wrapped_keys:
                    if not isinstance(wrapped, dict):
                        continue
                    recipients.append({
                        "recipient_id": wrapped.get("recipient_id"),
                        "label": wrapped.get("label") or "Unnamed recipient",
                        "fingerprint": wrapped.get("fingerprint"),
                        "algorithm": wrapped.get("algorithm"),
                    })
                return {
                    "encrypted": True,
                    "container": "zip",
                    "version": manifest.get("version"),
                    "cipher": manifest.get("cipher"),
                    "recipient_count": len(recipients),
                    "recipients": recipients,
                }

        payload = _load_json_or_zip_payload(content, upload_name, expected_member_prefix)
        return {
            "encrypted": False,
            "container": "zip",
            "version": payload.get("version"),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid ZIP backup: {exc}")


def _load_json_or_zip_payload(content: bytes, upload_name: str, expected_member_prefix: str) -> dict:
    lower_name = (upload_name or "").lower()
    if lower_name.endswith(".zip"):
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                members = [name for name in zf.namelist() if not name.endswith("/")]
                if len(members) != 1:
                    raise HTTPException(status_code=400, detail="ZIP backup must contain exactly one file")
                member = members[0]
                if not member.lower().endswith(".json"):
                    raise HTTPException(status_code=400, detail="ZIP backup must contain a JSON file")
                if expected_member_prefix and expected_member_prefix not in member.lower():
                    raise HTTPException(status_code=400, detail="Unexpected backup file inside ZIP")
                return json.loads(zf.read(member).decode("utf-8"))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid ZIP backup: {exc}")
    try:
        return json.loads(content.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON backup: {exc}")


def _load_backup_payload_from_upload(
    content: bytes,
    upload_name: str,
    expected_member_prefix: str,
    private_key_bytes: Optional[bytes] = None,
    private_key_passphrase: Optional[str] = None,
) -> dict:
    inspection = _inspect_backup_upload(content, upload_name, expected_member_prefix)
    if not inspection.get("encrypted"):
        return _load_json_or_zip_payload(content, upload_name, expected_member_prefix)

    if not private_key_bytes:
        raise HTTPException(status_code=400, detail="Encrypted backup requires a private key file for restore")

    private_key = _load_private_key(private_key_bytes, private_key_passphrase)
    if not isinstance(private_key, rsa.RSAPrivateKey):
        raise HTTPException(status_code=400, detail="Only RSA private keys are supported for encrypted backups")

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            content_key = None
            for wrapped in manifest.get("wrapped_keys", []):
                wrapped_key = wrapped.get("wrapped_key")
                if not wrapped_key:
                    continue
                try:
                    content_key = private_key.decrypt(
                        _b64url_decode(wrapped_key),
                        padding.OAEP(
                            mgf=padding.MGF1(algorithm=hashes.SHA256()),
                            algorithm=hashes.SHA256(),
                            label=None,
                        ),
                    )
                    break
                except Exception:
                    continue
            if not content_key:
                raise HTTPException(status_code=400, detail="Private key does not match any recipient in this backup")
            nonce = _b64url_decode(manifest.get("nonce"))
            payload_bytes = AESGCM(content_key).decrypt(nonce, zf.read("payload.bin"), None)
            return _load_json_or_zip_payload(payload_bytes, "payload.zip", expected_member_prefix)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to decrypt encrypted backup: {exc}")


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


@router.get("/backup/credentials/status")
def get_credentials_backup_status():
    with get_db() as conn:
        row = conn.execute("SELECT COUNT(*) AS credential_count FROM plaid_item").fetchone()
    credential_count = int(row["credential_count"] or 0) if row else 0
    return {
        "has_credentials": credential_count > 0,
        "credential_count": credential_count,
    }


@router.post("/backup/recipients")
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


@router.patch("/backup/recipients/{recipient_id}")
def update_backup_recipient(recipient_id: str, body: BackupRecipientUpdate):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM backup_recipient WHERE id = ?",
            (recipient_id,),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Recipient not found")
        fields, params = [], []
        if body.label is not None:
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


@router.delete("/backup/recipients/{recipient_id}")
def delete_backup_recipient(recipient_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM backup_recipient WHERE id = ?", (recipient_id,))
    return {"ok": True}


# --- CSV export + full app-data and credentials backup/restore ---------------------------------

@router.get("/transactions.csv")
def export_transactions_csv(
    columns:      str           = Query("date,merchant_name,amount,account,category"),
    date_start:   Optional[str] = Query(None),
    date_end:     Optional[str] = Query(None),
    account_ids:  Optional[str] = Query(None),
    owner_ids:    Optional[str] = Query(None),
    group_ids:    Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    tag_ids:      Optional[str] = Query(None),
    search:       Optional[str] = Query(None),
):
    col_keys = [c.strip() for c in columns.split(",") if c.strip() in EXPORT_COLUMNS]
    if not col_keys:
        col_keys = ["date", "merchant_name", "amount", "account", "category"]

    select_exprs = [f"{EXPORT_COLUMNS[k][0]} AS {k}" for k in col_keys]
    headers      = [EXPORT_COLUMNS[k][1] for k in col_keys]

    clauses, params = [], []
    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?"); params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?"); params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?"); params.append(date_end)
    if account_ids:
        ids = [i.strip() for i in account_ids.split(",") if i.strip()]
        clauses.append(
            f"COALESCE((SELECT parent_account_id FROM account WHERE id = t.account_id), t.account_id) IN ({','.join('?'*len(ids))})"
        ); params.extend(ids)
    if owner_ids:
        ids = [i.strip() for i in owner_ids.split(",") if i.strip()]
        clauses.append(f"t.owner_id IN ({','.join('?'*len(ids))})"); params.extend(ids)
    if group_ids:
        ids = [i.strip() for i in group_ids.split(",") if i.strip()]
        clauses.append(
            f"t.category_id IN (SELECT id FROM category WHERE parent_id IN ({','.join('?'*len(ids))}))"
        ); params.extend(ids)
    if category_ids:
        ids = [i.strip() for i in category_ids.split(",") if i.strip()]
        clauses.append(f"t.category_id IN ({','.join('?'*len(ids))})"); params.extend(ids)
    if tag_ids:
        ids = [i.strip() for i in tag_ids.split(",") if i.strip()]
        clauses.append(
            f"""
            EXISTS (
                SELECT 1
                FROM txn_tag tt
                WHERE tt.txn_id = t.id
                  AND tt.tag_id IN ({','.join('?' * len(ids))})
                  AND {VISIBLE_TXN_TAG_SQL}
            )
            """
        )
        params.extend(ids)
    if search:
        clauses.append("(t.display_name LIKE ? OR t.merchant_name LIKE ? OR t.raw_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT {', '.join(select_exprs)}
            FROM   txn t
            JOIN   account   a ON a.id  = t.account_id
            LEFT JOIN account ap ON ap.id = a.parent_account_id
            LEFT JOIN category c ON c.id  = t.category_id
            LEFT JOIN category p ON p.id  = c.parent_id
            LEFT JOIN owner    o ON o.id  = t.owner_id
            {where}
            ORDER  BY t.date DESC, t.id DESC
        """, params).fetchall()

    def generate():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(headers)
        yield buf.getvalue(); buf.seek(0); buf.truncate()
        for row in rows:
            w.writerow([row[k] for k in col_keys])
            yield buf.getvalue(); buf.seek(0); buf.truncate()

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="fintrack_export.csv"'},
    )

@router.get("/backup")
def export_backup(encrypted: bool = Query(False)):
    with get_db() as conn:
        def dump(table, query=None):
            q = query or f"SELECT * FROM {table} ORDER BY rowid"
            return [dict(r) for r in conn.execute(q).fetchall()]

        payload = {
            "version":        5,
            "exported_at":    datetime.utcnow().isoformat(),
            "owners":         dump("owner"),
            "accounts":       dump("account",
                                   "SELECT id, plaid_account_id, plaid_item_id, name, display_name, "
                                   "institution, type, subtype, mask, owner_id, parent_account_id, trashed_at FROM account"),
            "categories":     dump("category"),
            "category_rules": dump("category_rule"),
            "merchant_renames": dump("merchant_rename"),
            "csv_profiles":   dump("csv_import_profile"),
            "import_batches": dump("import_batch"),
            "import_batch_accounts": dump("import_batch_account"),
            "import_batch_duplicates": dump("import_batch_duplicate"),
            "import_workflow_states": dump("import_workflow_state"),
            "transactions":   dump("txn",
                                   "SELECT id, plaid_transaction_id, account_id, owner_id, "
                                   "category_id, amount, merchant_name, display_name, raw_name, date, "
                                   "is_pending, category_overridden, category_source, imported_category, notes, content_hash, "
                                   "import_evidence_json, "
                                   "import_batch_id FROM txn ORDER BY date DESC"),
        }
        recipients = []
        if encrypted:
            recipients = [dict(r) for r in conn.execute("""
                SELECT id, label, public_key
                FROM   backup_recipient
                WHERE  enabled = 1
                ORDER  BY created_at DESC, label
            """).fetchall()]

    if encrypted:
        if not recipients:
            raise HTTPException(status_code=400, detail="No enabled backup recipients are configured")
        content = _build_encrypted_backup_bytes(
            _zip_json_bytes("fintrack_backup.json", payload),
            recipients,
        )
        filename = "fintrack_backup.encrypted.zip"
    else:
        content = _zip_json_bytes("fintrack_backup.json", payload)
        filename = "fintrack_backup.zip"
    return StreamingResponse(
        iter([content]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/backup/credentials")
def export_credentials(request: Request, encrypted: bool = Query(False)):
    """Export Plaid credentials — treat this file like a password."""
    with get_db() as conn:
        items = conn.execute("SELECT * FROM plaid_item").fetchall()
        recipients = []
        if encrypted:
            recipients = [dict(r) for r in conn.execute("""
                SELECT id, label, public_key
                FROM   backup_recipient
                WHERE  enabled = 1
                ORDER  BY created_at DESC, label
            """).fetchall()]
    user = getattr(request.state, "user", None)
    exported_items = []
    for row in items:
        item = dict(row)
        item["access_token"] = crypto_service.decrypt_plaid_access_token(
            user,
            item["item_id"],
            item.get("access_token"),
            item.get("access_token_enc"),
        )
        item.pop("access_token_enc", None)
        exported_items.append(item)
    payload = {
        "version":     1,
        "exported_at": datetime.utcnow().isoformat(),
        "warning":     "This file contains sensitive Plaid access tokens. Store securely.",
        "plaid_items": exported_items,
    }
    if encrypted:
        if not recipients:
            raise HTTPException(status_code=400, detail="No enabled backup recipients are configured")
        content = _build_encrypted_backup_bytes(
            _zip_json_bytes("fintrack_credentials.json", payload),
            recipients,
        )
        filename = "fintrack_credentials.encrypted.zip"
    else:
        content = _zip_json_bytes("fintrack_credentials.json", payload)
        filename = "fintrack_credentials.zip"
    return StreamingResponse(
        iter([content]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/restore")
def restore_backup(body: RestoreRequest):
    """
    Destructive restore. Wipes all non-credential data and replaces with backup.
    Plaid items / access tokens are NOT touched.
    """
    d = body.data
    if d.get("version") not in (1, 2, 3, 4, 5):
        raise HTTPException(status_code=400, detail="Unrecognised backup version")

    owners = [dict(row) for row in d.get("owners", [])]
    accounts = [dict(row) for row in d.get("accounts", [])]
    categories = [dict(row) for row in d.get("categories", [])]
    category_rules = [dict(row) for row in d.get("category_rules", [])]
    merchant_renames = [dict(row) for row in d.get("merchant_renames", [])]
    csv_profiles = [dict(row) for row in d.get("csv_profiles", [])]
    import_batches = [dict(row) for row in d.get("import_batches", [])]
    import_batch_accounts = [dict(row) for row in d.get("import_batch_accounts", [])]
    import_batch_duplicates = [dict(row) for row in d.get("import_batch_duplicates", [])]
    import_workflow_states = [dict(row) for row in d.get("import_workflow_states", [])]
    transactions = [dict(row) for row in d.get("transactions", [])]

    owner_ids = {row.get("id") for row in owners if row.get("id")}
    account_ids = {row.get("id") for row in accounts if row.get("id")}
    category_ids = {row.get("id") for row in categories if row.get("id")}
    csv_profile_ids = {row.get("id") for row in csv_profiles if row.get("id")}
    import_batch_ids = {row.get("id") for row in import_batches if row.get("id")}

    # Backups can outlive later deletions or schema tightening. Normalize broken foreign
    # keys to NULL so restore stays best-effort instead of failing the entire archive.
    def normalize_nullable_fk(rows, key, valid_ids):
        for row in rows:
            value = row.get(key)
            if value and value not in valid_ids:
                row[key] = None

    normalize_nullable_fk(accounts, "owner_id", owner_ids)
    normalize_nullable_fk(accounts, "parent_account_id", account_ids)
    normalize_nullable_fk(categories, "owner_id", owner_ids)
    normalize_nullable_fk(csv_profiles, "account_id", account_ids)
    normalize_nullable_fk(import_batches, "profile_id", csv_profile_ids)

    for row in accounts:
        row["display_name"] = (row.get("display_name") or row.get("name") or "").strip()
        if not row["display_name"]:
            row["display_name"] = row.get("name") or ""

    for row in categories:
        parent_id = row.get("parent_id")
        if parent_id and parent_id not in category_ids:
            row["parent_id"] = None

    category_rules = [
        row for row in category_rules
        if row.get("category_id") in category_ids
    ]

    normalize_nullable_fk(transactions, "owner_id", owner_ids)
    normalize_nullable_fk(transactions, "category_id", category_ids)
    normalize_nullable_fk(transactions, "import_batch_id", import_batch_ids)
    transactions = [
        row for row in transactions
        if row.get("account_id") in account_ids
    ]

    import_batch_accounts = [
        row for row in import_batch_accounts
        if row.get("batch_id") in import_batch_ids
        and (not row.get("account_id") or row.get("account_id") in account_ids)
    ]
    import_batch_duplicates = [
        row for row in import_batch_duplicates
        if row.get("batch_id") in import_batch_ids
    ]

    # Categories are a two-level hierarchy; insert groups before leaves so
    # self-referential parent_id constraints are satisfied during restore.
    categories.sort(key=lambda row: (0 if not row.get("parent_id") else 1, row.get("sort_order", 0), row.get("name", "")))

    with get_db() as conn:
        # Wipe in dependency order (children before parents)
        conn.execute("DELETE FROM txn")
        conn.execute("DELETE FROM import_batch_duplicate")
        conn.execute("DELETE FROM import_batch_account")
        conn.execute("DELETE FROM import_batch")
        conn.execute("DELETE FROM import_workflow_state")
        conn.execute("DELETE FROM category_rule")
        conn.execute("DELETE FROM merchant_rename")
        conn.execute("DELETE FROM csv_import_profile")
        conn.execute("DELETE FROM category")
        conn.execute("DELETE FROM account")
        conn.execute("DELETE FROM owner")

        def insert_rows(table, rows, exclude=()):
            if not rows:
                return
            sample = {k: v for k, v in rows[0].items() if k not in exclude}
            cols = list(sample.keys())
            placeholders = ",".join("?" * len(cols))
            for row in rows:
                vals = [row.get(c) for c in cols]
                conn.execute(
                    f"INSERT OR IGNORE INTO {table} ({','.join(cols)}) VALUES ({placeholders})",
                    vals
                )

        insert_rows("owner",            owners)
        insert_rows("account",          accounts)
        insert_rows("category",         categories)
        insert_rows("category_rule",    category_rules)
        insert_rows("merchant_rename",  merchant_renames)
        insert_rows("csv_import_profile", csv_profiles)
        insert_rows("import_batch", import_batches)
        insert_rows("import_batch_account", import_batch_accounts)
        insert_rows("import_batch_duplicate", import_batch_duplicates)
        insert_rows("import_workflow_state", import_workflow_states)
        insert_rows("txn",          transactions)

    return {
        "ok": True,
        "restored_at": datetime.utcnow().isoformat(),
        "restored_counts": {
            "owners": len(owners),
            "accounts": len(accounts),
            "categories": len(categories),
            "category_rules": len(category_rules),
            "merchant_renames": len(merchant_renames),
            "csv_profiles": len(csv_profiles),
            "import_batches": len(import_batches),
            "import_batch_accounts": len(import_batch_accounts),
            "import_batch_duplicates": len(import_batch_duplicates),
            "import_workflow_states": len(import_workflow_states),
            "transactions": len(transactions),
        },
    }


@router.post("/restore-file/inspect")
async def inspect_backup_file(file: UploadFile = File(...)):
    content = await file.read()
    return _inspect_backup_upload(content, file.filename or "", "backup")


@router.post("/restore/credentials")
def restore_credentials(body: CredentialsRestoreRequest, request: Request):
    d = body.data
    if d.get("version") != 1:
        raise HTTPException(status_code=400, detail="Unrecognised credentials backup version")
    items = d.get("plaid_items", [])
    user = getattr(request.state, "user", None)
    with get_db() as conn:
        conn.execute("DELETE FROM plaid_item")
        for item in items:
            access_token, access_token_enc = crypto_service.encrypt_plaid_access_token(
                user,
                item["item_id"],
                item["access_token"],
            )
            conn.execute(
                "INSERT OR IGNORE INTO plaid_item (item_id, access_token, access_token_enc) VALUES (?, ?, ?)",
                (item["item_id"], access_token, access_token_enc)
            )
    return {"ok": True, "restored": len(items)}


@router.post("/restore-file")
async def restore_backup_file(
    file: UploadFile = File(...),
    private_key_file: UploadFile | None = File(None),
    private_key_passphrase: str | None = Form(None),
):
    content = await file.read()
    private_key_bytes = await private_key_file.read() if private_key_file else None
    payload = _load_backup_payload_from_upload(
        content,
        file.filename or "",
        "backup",
        private_key_bytes=private_key_bytes,
        private_key_passphrase=private_key_passphrase,
    )
    return restore_backup(RestoreRequest(data=payload))


@router.post("/restore/credentials-file")
async def restore_credentials_file(request: Request, file: UploadFile = File(...)):
    content = await file.read()
    payload = _load_json_or_zip_payload(content, file.filename or "", "credentials")
    return restore_credentials(CredentialsRestoreRequest(data=payload), request)
