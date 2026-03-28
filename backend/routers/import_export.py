"""
import_export.py — CSV import/export and JSON backup/restore

IMPORT FLOW:
  1. POST /api/import/preview   — client uploads CSV, server returns first 5 rows +
                                  column headers + auto-detected profile (if any).
  2. POST /api/import/run       — client sends column mapping + options; server
                                  imports rows, creates import_batch record, returns
                                  batch id + counts.
  3. DELETE /api/import/batch/:id — undo: deletes all txns for that batch. If any
                                  were manually edited post-import, returns 409 with
                                  a list of affected transactions so the client can
                                  warn the user before a forced delete.
  DELETE /api/import/batch/:id?force=true — deletes unconditionally.

DUPLICATE DETECTION:
  content_hash = SHA-256 of "date|amount|raw_description" (lowercased, stripped).
  On import, if any row matches an existing batch's hash set, the server returns
  the previous batch info so the client can warn and offer to replace.

CSV EXPORT:
  GET /api/export/transactions — streams a CSV with user-chosen columns, respecting
  the same filter params as the transactions list endpoint.

BACKUP / RESTORE:
  GET /api/export/backup       — JSON dump of all non-sensitive tables.
  GET /api/export/backup/credentials — JSON dump of plaid_item table (sensitive).
  POST /api/import/restore     — destructive restore from backup JSON.
  POST /api/import/restore/credentials — restore plaid_item rows.

AMOUNT CONVENTIONS:
  single_signed   — one column, negative = debit (e.g. Chase)
  single_unsigned — one column, always positive; separate column indicates direction
  two_column      — separate debit and credit columns (both positive)
"""

import csv
import hashlib
import io
import json
import uuid
import zipfile
import os
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, date
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.database import get_db
from services.categorizer import categorize_transaction
from services import crypto_service

router = APIRouter()


# ── Pydantic models ───────────────────────────────────────────────────────────

class ColumnMap(BaseModel):
    date:         str
    amount:       Optional[str] = None
    debit:        Optional[str] = None
    credit:       Optional[str] = None
    direction:    Optional[str] = None   # column that says "debit"/"credit"
    description:  str
    category:     Optional[str] = None
    notes:        Optional[str] = None
    account:      Optional[str] = None   # CSV column containing account name/id

class ImportRunRequest(BaseModel):
    profile_id:           Optional[str] = None
    filename:             str
    account_id:           Optional[str] = None  # fallback when no account column mapped
    account_map:          Optional[dict] = None  # csv_value → account_id
    skip_accounts:        Optional[list] = None  # csv_values to skip entirely
    new_accounts:         Optional[list] = None  # [{csv_value, name, type}] to create
    date_format:          str = "%m/%d/%Y"
    amount_convention:    str = "single_signed"
    column_map:           ColumnMap
    skip_rows:            int = 0
    apply_categorization: bool = True
    replace_batch_id:     Optional[str] = None   # if set, delete this batch first
    rows:                 list[dict]              # parsed CSV rows from preview

class ProfileCreate(BaseModel):
    name:                 str
    filename_pattern:     Optional[str] = None
    header_fingerprint:   Optional[str] = None
    column_map:           dict
    account_id:           Optional[str] = None
    date_format:          str = "%m/%d/%Y"
    amount_convention:    str = "single_signed"
    skip_rows:            int = 0
    apply_categorization: bool = True
    notes:                Optional[str] = None

class ProfileUpdate(BaseModel):
    name:                 Optional[str] = None
    filename_pattern:     Optional[str] = None
    header_fingerprint:   Optional[str] = None
    column_map:           Optional[dict] = None
    account_id:           Optional[str] = None
    date_format:          Optional[str] = None
    amount_convention:    Optional[str] = None
    skip_rows:            Optional[int] = None
    apply_categorization: Optional[bool] = None
    notes:                Optional[str] = None


class BatchCategoryMappingApplyRequest(BaseModel):
    assignments: dict[str, str]


class BackupRecipientCreate(BaseModel):
    label: str
    public_key: str
    enabled: bool = True


class BackupRecipientUpdate(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_hash(date_str: str, amount: float, description: str) -> str:
    raw = f"{date_str.strip()}|{amount:.2f}|{description.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def parse_amount(row: dict, convention: str, col_map: ColumnMap) -> Optional[float]:
    """
    Parse an amount cell and return a signed float.
    Positive = debit (money out), negative = credit (money in).

    Handles common bank CSV formats:
      -50.00        standard negative
      (50.00)       accounting/parenthetical negative (debit in some exports)
      50.00 CR      trailing CR = credit (income)
      50.00 DR      trailing DR = debit (expense)
      $1,234.56     dollar sign and thousands separators
    """
    import re

    def clean(raw: str) -> Optional[float]:
        s = raw.strip().replace(",", "").replace("$", "").replace(" ", "")
        # Parenthetical negative: (50.00) → -50.00
        m = re.fullmatch(r'\(([0-9.]+)\)', s)
        if m:
            return -float(m.group(1))
        # Trailing CR (credit = income = negative stored value)
        if re.search(r'CR$', s, re.IGNORECASE):
            val = float(re.sub(r'CR$', '', s, flags=re.IGNORECASE))
            return -abs(val)
        # Trailing DR (debit = expense = positive stored value)
        if re.search(r'DR$', s, re.IGNORECASE):
            val = float(re.sub(r'DR$', '', s, flags=re.IGNORECASE))
            return abs(val)
        return float(s)

    try:
        if convention == "two_column":
            d_raw = str(row.get(col_map.debit,  "") or "")
            c_raw = str(row.get(col_map.credit, "") or "")
            debit  = clean(d_raw) if d_raw.strip() else 0.0
            credit = clean(c_raw) if c_raw.strip() else 0.0
            return debit if debit else -(credit or 0)

        raw = str(row.get(col_map.amount, "") or "").strip()
        val = clean(raw)

        if convention == "single_unsigned" and col_map.direction:
            direction = str(row.get(col_map.direction, "")).strip().lower()
            if direction in ("credit", "cr", "deposit", "income"):
                return -abs(val)
            return abs(val)

        # single_signed: Chase style stores debits as negative → negate to positive
        return -val

    except (ValueError, TypeError, AttributeError):
        return None


def parse_date(val: str, fmt: str) -> Optional[str]:
    """Parse a date string and return YYYY-MM-DD or None."""
    val = val.strip()
    for f in [fmt, "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%m-%d-%Y", "%b-%d-%Y", "%b %d, %Y"]:
        try:
            return datetime.strptime(val, f).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _detect_header_row_index(text: str) -> int:
    """Find header row by scanning the first up to 10 lines."""
    all_lines = text.splitlines()
    header_row_index = 0
    for i, line in enumerate(all_lines[:10]):
        fields = [f.strip().strip('"') for f in line.split(',')]
        if len(fields) >= 3:
            looks_like_header = sum(
                1 for f in fields
                if f and not f[0].isdigit() and not f.startswith('$')
            ) >= len(fields) * 0.6
            if looks_like_header:
                header_row_index = i
                break
    return header_row_index


def _summarize_tail_lines(all_lines: list[str], count: int = 20) -> tuple[list[str], int]:
    """Return the last `count` lines plus the 0-based line offset they start at."""
    if not all_lines:
        return [], 0
    start = max(0, len(all_lines) - count)
    return all_lines[start:], start


def normalize_import_category(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


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


# ── Profile CRUD ──────────────────────────────────────────────────────────────

@router.get("/profiles")
def list_profiles():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT p.*, a.name AS account_name
            FROM   csv_import_profile p
            LEFT JOIN account a ON a.id = p.account_id
            ORDER BY p.name
        """).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["column_map"] = json.loads(d["column_map"])
        except Exception:
            d["column_map"] = {}
        result.append(d)
    return result


@router.post("/profiles")
def create_profile(body: ProfileCreate):
    pid = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute("""
            INSERT INTO csv_import_profile
              (id, name, filename_pattern, header_fingerprint, column_map,
               account_id, date_format, amount_convention, skip_rows,
               apply_categorization, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (pid, body.name, body.filename_pattern, body.header_fingerprint,
              json.dumps(body.column_map), body.account_id, body.date_format,
              body.amount_convention, body.skip_rows,
              1 if body.apply_categorization else 0, body.notes))
    return {"id": pid}


@router.patch("/profiles/{profile_id}")
def update_profile(profile_id: str, body: ProfileUpdate):
    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM csv_import_profile WHERE id = ?", (profile_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        fields, params = [], []
        if body.name                 is not None: fields.append("name = ?");                 params.append(body.name)
        if body.filename_pattern     is not None: fields.append("filename_pattern = ?");     params.append(body.filename_pattern)
        if body.header_fingerprint   is not None: fields.append("header_fingerprint = ?");   params.append(body.header_fingerprint)
        if body.column_map           is not None: fields.append("column_map = ?");           params.append(json.dumps(body.column_map))
        if body.account_id           is not None: fields.append("account_id = ?");           params.append(body.account_id)
        if body.date_format          is not None: fields.append("date_format = ?");          params.append(body.date_format)
        if body.amount_convention    is not None: fields.append("amount_convention = ?");    params.append(body.amount_convention)
        if body.skip_rows            is not None: fields.append("skip_rows = ?");            params.append(body.skip_rows)
        if body.apply_categorization is not None: fields.append("apply_categorization = ?"); params.append(1 if body.apply_categorization else 0)
        if body.notes                is not None: fields.append("notes = ?");                params.append(body.notes)
        if fields:
            params.append(profile_id)
            conn.execute(f"UPDATE csv_import_profile SET {', '.join(fields)} WHERE id = ?", params)
    return {"ok": True}


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM csv_import_profile WHERE id = ?", (profile_id,))
    return {"ok": True}


@router.get("/backup/recipients")
def list_backup_recipients():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, label, public_key, fingerprint, algorithm, enabled, created_at
            FROM   backup_recipient
            ORDER  BY created_at DESC, label
        """).fetchall()
    return [dict(row) for row in rows]


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


# ── Preview (parse uploaded CSV, auto-detect profile) ─────────────────────────

@router.post("/preview")
async def preview_csv(file: UploadFile = File(...)):
    """
    Parse the uploaded CSV and return:
    - raw_lines: first 20 raw text lines (for the file preview panel)
    - header_row_index: which line index the header was detected on
    - headers: list of column names
    - rows: first 10 data rows as dicts
    - total_rows: total data row count
    - column_distinct_values: all distinct values per column (for account mapping)
    - suggested_profile_id: best matching saved profile, or null
    - previous_batch: most recent completed batch for this filename, or null
    - previous_batch_accounts: accounts imported in previous batch (for dup warning)
    - config_snapshot: column/account config from previous batch (to restore)
    """
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    try:
        # Capture raw lines for the file preview panel
        all_lines = text.splitlines()
        raw_lines  = all_lines[:20]
        raw_tail_lines, raw_tail_start_line = _summarize_tail_lines(all_lines)

        header_row_index = _detect_header_row_index(text)
        data_text = "\n".join(all_lines[header_row_index:])
        reader = csv.DictReader(io.StringIO(data_text))
        raw_headers = reader.fieldnames or []
        # Strip leading/trailing whitespace from header names — HTML option values
        # trim whitespace, so a header like " Amount" would cause a key mismatch.
        headers = [h.strip() for h in raw_headers]
        all_rows = []
        for row in reader:
            # Re-key each row using stripped header names (skip None keys from malformed rows).
            stripped = {k.strip(): v for k, v in row.items() if k}
            all_rows.append(stripped)
        rows       = all_rows[:10]
        total_rows = len(all_rows)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    filename  = file.filename or ""
    header_fp = "|".join(headers)

    # Collect distinct values per column across full file
    column_distinct_values: dict = {}
    for row in all_rows:
        for col, val in row.items():
            v = str(val or "").strip()
            if v:
                column_distinct_values.setdefault(col, set()).add(v)
    column_distinct_values = {
        col: sorted(vals)[:50]
        for col, vals in column_distinct_values.items()
    }

    try:
        with get_db() as conn:
            # Auto-detect profile
            profiles = conn.execute(
                "SELECT id, name, filename_pattern, header_fingerprint FROM csv_import_profile"
            ).fetchall()

            suggested_profile_id = None
            for p in profiles:
                if p["filename_pattern"] and p["filename_pattern"].lower() in filename.lower():
                    suggested_profile_id = p["id"]
                    break
            if not suggested_profile_id:
                for p in profiles:
                    if p["header_fingerprint"] and p["header_fingerprint"] == header_fp:
                        suggested_profile_id = p["id"]
                        break

            # Find most recent completed batch for this filename
            previous_batch = conn.execute("""
                SELECT id, imported_at, row_count, status, config_snapshot
                FROM   import_batch
                WHERE  filename = ? AND status = 'completed'
                ORDER  BY imported_at DESC LIMIT 1
            """, (filename,)).fetchone()

            previous_batch_accounts = []
            config_snapshot         = None
            if previous_batch:
                # Get which accounts were imported (not skipped) from that batch
                acc_rows = conn.execute("""
                    SELECT iba.csv_value, iba.row_count, iba.was_skipped,
                           a.id AS account_id, a.name AS account_name
                    FROM   import_batch_account iba
                    LEFT JOIN account a ON a.id = iba.account_id
                    WHERE  iba.batch_id = ? AND iba.was_skipped = 0
                """, (previous_batch["id"],)).fetchall()
                previous_batch_accounts = [dict(r) for r in acc_rows]

                if previous_batch["config_snapshot"]:
                    try:
                        config_snapshot = json.loads(previous_batch["config_snapshot"])
                    except Exception:
                        pass

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    return {
        "raw_lines":              raw_lines,
        "raw_tail_lines":         raw_tail_lines,
        "raw_tail_start_line":    raw_tail_start_line,
        "header_row_index":       header_row_index,
        "headers":                headers,
        "rows":                   rows,
        "total_rows":             total_rows,
        "filename":               filename,
        "header_fingerprint":     header_fp,
        "suggested_profile_id":   suggested_profile_id,
        "previous_batch":         dict(previous_batch) if previous_batch else None,
        "previous_batch_accounts":previous_batch_accounts,
        "config_snapshot":        config_snapshot,
        "column_distinct_values": column_distinct_values,
    }


# ── Import run ────────────────────────────────────────────────────────────────

@router.post("/run")
async def run_import(
    file:   UploadFile = File(...),
    config: str        = Form(...),   # JSON string of all mapping/account settings
):
    """
    Execute the import. Accepts the CSV file as a multipart upload so the full
    file is parsed server-side — the preview only returns 10 rows to the client,
    so we re-read the whole file here rather than relying on a rows list in the body.
    """
    try:
        cfg = json.loads(config)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid config JSON")

    # Re-parse the full CSV file
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    header_row_index = _detect_header_row_index(text)
    data_text = "\n".join(text.splitlines()[header_row_index:])

    reader   = csv.DictReader(io.StringIO(data_text))
    raw_hdrs = reader.fieldnames or []
    all_rows = []
    for row in reader:
        # Re-key each row using stripped header names (skip malformed None keys)
        all_rows.append({k.strip(): v for k, v in row.items() if k})

    skip_rows = int(cfg.get("skip_rows", 0))
    data_rows = all_rows[skip_rows:]

    cm_dict       = cfg.get("column_map", {})
    col = ColumnMap(
        date        = cm_dict.get("date", ""),
        amount      = cm_dict.get("amount"),
        debit       = cm_dict.get("debit"),
        credit      = cm_dict.get("credit"),
        direction   = cm_dict.get("direction"),
        description = cm_dict.get("description", ""),
        category    = cm_dict.get("category"),
        notes       = cm_dict.get("notes"),
        account     = cm_dict.get("account"),
    )

    date_format       = cfg.get("date_format", "%m/%d/%Y")
    amount_convention = cfg.get("amount_convention", "single_signed")
    apply_cat         = bool(cfg.get("apply_categorization", True))
    account_id        = cfg.get("account_id") or None
    single_account_new = cfg.get("single_account_new") or None
    category_assignments_cfg = cm_dict.get("category_assignments") or {}
    account_map_cfg   = cfg.get("account_map") or {}
    skip_accounts_cfg = cfg.get("skip_accounts") or []
    new_accounts_cfg  = cfg.get("new_accounts") or []
    profile_id        = cfg.get("profile_id") or None
    replace_batch_id  = cfg.get("replace_batch_id") or None
    filename          = file.filename or cfg.get("filename", "upload.csv")

    batch_id = str(uuid.uuid4())
    imported = 0
    skipped  = 0
    deduped  = 0
    errors   = []
    row_results = []
    imported_category_counts: dict[str, int] = {}
    skip_set = set(skip_accounts_cfg)

    with get_db() as conn:
        created_account_ids = {}
        if single_account_new:
            single_name = str(single_account_new.get("name", "")).strip()
            single_type = single_account_new.get("type", "depository")
            if single_name:
                existing = conn.execute(
                    "SELECT id FROM account WHERE LOWER(name) = LOWER(?)", (single_name,)
                ).fetchone()
                if existing:
                    created_account_ids["__single_account__"] = existing["id"]
                else:
                    new_acc_id = str(uuid.uuid4())
                    conn.execute("""
                        INSERT INTO account
                          (id, plaid_account_id, plaid_item_id, name, type, subtype, owner_id)
                        VALUES (?, ?, 'csv_import', ?, ?, ?, ?)
                    """, (new_acc_id, f"csv_{new_acc_id}", single_name, single_type, "checking",
                          None))
                    created_account_ids["__single_account__"] = new_acc_id
        for na in new_accounts_cfg:
            csv_val  = na.get("csv_value", "")
            acc_name = na.get("name", csv_val).strip()
            acc_type = na.get("type", "depository")
            if not acc_name:
                continue
            # Check if an account with this name already exists — use it rather
            # than creating a duplicate. Case-insensitive match.
            existing = conn.execute(
                "SELECT id FROM account WHERE LOWER(name) = LOWER(?)", (acc_name,)
            ).fetchone()
            if existing:
                created_account_ids[csv_val] = existing["id"]
                continue
            new_acc_id = str(uuid.uuid4())
            conn.execute("""
                INSERT INTO account
                  (id, plaid_account_id, plaid_item_id, name, type, subtype, owner_id)
                VALUES (?, ?, 'csv_import', ?, ?, ?, ?)
            """, (new_acc_id, f"csv_{new_acc_id}", acc_name, acc_type, "checking",
                  None))
            created_account_ids[csv_val] = new_acc_id

        effective_map = {}
        effective_map.update(account_map_cfg)
        effective_map.update(created_account_ids)

        fallback_acc = None
        if account_id:
            fallback_acc = conn.execute(
                "SELECT id, owner_id FROM account WHERE id = ?", (account_id,)
            ).fetchone()
            if not fallback_acc:
                raise HTTPException(status_code=400, detail="Account not found")
        elif created_account_ids.get("__single_account__"):
            fallback_acc = conn.execute(
                "SELECT id, owner_id FROM account WHERE id = ?",
                (created_account_ids["__single_account__"],)
            ).fetchone()

        account_cache: dict = {}
        def get_account(aid):
            if aid not in account_cache:
                r = conn.execute("SELECT id, owner_id FROM account WHERE id = ?", (aid,)).fetchone()
                account_cache[aid] = dict(r) if r else None
            return account_cache[aid]

        # Pre-load existing hashes for dedup
        relevant_account_ids = set()
        if account_id:
            relevant_account_ids.add(account_id)
        for aid in effective_map.values():
            if aid:
                relevant_account_ids.add(aid)
        existing_hashes: set = set()
        if relevant_account_ids:
            ph = ",".join("?" * len(relevant_account_ids))
            rows_db = conn.execute(
                f"SELECT account_id, content_hash FROM txn "
                f"WHERE account_id IN ({ph}) AND content_hash IS NOT NULL",
                list(relevant_account_ids)
            ).fetchall()
            existing_hashes = {(r["account_id"], r["content_hash"]) for r in rows_db}

        if replace_batch_id:
            conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (replace_batch_id,))
            conn.execute("UPDATE import_batch SET status = 'undone' WHERE id = ?", (replace_batch_id,))

        config_snap = json.dumps({
            "column_map":          cm_dict,
            "category_assignments": category_assignments_cfg,
            "account_map":         account_map_cfg,
            "skip_accounts":       list(skip_set),
            "date_format":         date_format,
            "amount_convention":   amount_convention,
            "skip_rows":           skip_rows,
            "apply_categorization":apply_cat,
            "account_id":          account_id,
            "single_account_new":  single_account_new,
        })
        conn.execute("""
            INSERT INTO import_batch
              (id, profile_id, filename, row_count, skipped_count, deduped_count, config_snapshot)
            VALUES (?, ?, ?, 0, 0, 0, ?)
        """, (batch_id, profile_id, filename, config_snap))

        # Use account column whenever it's mapped — effective_map may be empty
        # at this point if all entries are createNew (populated in created_account_ids)
        use_account_col = bool(col.account)
        account_counts: dict = {}   # account_id → {csv_value, count}
        skip_counts:    dict = {}   # csv_value → row count for skipped accounts
        account_deduped: dict = {}  # account_id → dedup count

        for i, row in enumerate(data_rows):
            row_num = header_row_index + skip_rows + i + 2

            if use_account_col:
                csv_val = str(row.get(col.account, "")).strip()
                if csv_val in skip_set:
                    skipped += 1
                    skip_counts[csv_val] = skip_counts.get(csv_val, 0) + 1
                    row_results.append({"row": row_num, "status": "skipped_account"})
                    continue
                row_account_id = effective_map.get(csv_val)
                if not row_account_id:
                    errors.append({"row": row_num, "reason": f"No account mapped for '{csv_val}'"})
                    skipped += 1
                    row_results.append({"row": row_num, "status": "error", "reason": f"No account mapped for '{csv_val}'"})
                    continue
                acc = get_account(row_account_id)
            elif fallback_acc:
                csv_val = ""
                acc     = dict(fallback_acc)
            else:
                errors.append({"row": row_num, "reason": "No account configured"})
                skipped += 1
                row_results.append({"row": row_num, "status": "error", "reason": "No account configured"})
                continue

            if not acc:
                errors.append({"row": row_num, "reason": "Account not found"})
                skipped += 1
                row_results.append({"row": row_num, "status": "error", "reason": "Account not found"})
                continue

            raw_date = str(row.get(col.date, "")).strip()
            parsed_date = parse_date(raw_date, date_format)
            if not parsed_date:
                errors.append({"row": row_num, "reason": f"Invalid date: {raw_date!r}"})
                skipped += 1
                row_results.append({"row": row_num, "status": "error", "reason": f"Invalid date: {raw_date!r}"})
                continue

            amount = parse_amount(row, amount_convention, col)
            if amount is None:
                errors.append({"row": row_num, "reason": "Invalid amount"})
                skipped += 1
                row_results.append({"row": row_num, "status": "error", "reason": "Invalid amount"})
                continue
            if amount == 0:
                skipped += 1
                row_results.append({"row": row_num, "status": "zero_amount"})
                continue

            raw_desc     = str(row.get(col.description, "")).strip()
            raw_imported_category = str(row.get(col.category, "")).strip() if col.category else ""
            notes_val    = str(row.get(col.notes, "")).strip() if col.notes else None
            content_hash = make_hash(parsed_date, amount, raw_desc)

            if (acc["id"], content_hash) in existing_hashes:
                deduped += 1
                account_deduped[acc["id"]] = account_deduped.get(acc["id"], 0) + 1
                row_results.append({"row": row_num, "status": "deduped"})
                continue

            if raw_imported_category:
                imported_category_counts[raw_imported_category] = imported_category_counts.get(raw_imported_category, 0) + 1

            cat_id = None
            if raw_imported_category:
                cat_id = category_assignments_cfg.get(raw_imported_category)
            elif apply_cat and not col.category:
                cat_id = categorize_transaction(
                    raw_desc, raw_desc, abs(amount), conn, owner_id=acc["owner_id"]
                )

            txn_id = str(uuid.uuid4())
            conn.execute("""
                INSERT INTO txn
                  (id, account_id, owner_id, category_id, amount, merchant_name,
                   raw_name, date, is_pending, content_hash, import_batch_id, imported_category, notes, category_overridden)
                VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)
            """, (txn_id, acc["id"], acc["owner_id"], cat_id, amount,
                  raw_desc, raw_desc, parsed_date, content_hash, batch_id,
                  raw_imported_category or None, notes_val or None, 1 if cat_id and raw_imported_category else 0))
            imported += 1
            row_results.append({"row": row_num, "status": "imported"})

            aid = acc["id"]
            if aid not in account_counts:
                account_counts[aid] = {"csv_value": csv_val, "count": 0}
            account_counts[aid]["count"] += 1

        conn.execute(
            "UPDATE import_batch SET row_count = ?, skipped_count = ?, deduped_count = ? WHERE id = ?",
            (imported + skipped + deduped, skipped, deduped, batch_id)
        )

        # If nothing was imported, remove the batch record entirely —
        # a zero-row import shouldn't appear in Recent imports
        if imported == 0:
            conn.execute("DELETE FROM import_batch WHERE id = ?", (batch_id,))
            batch_id = None
        else:
            for aid, info in account_counts.items():
                conn.execute("""
                    INSERT OR REPLACE INTO import_batch_account
                      (batch_id, csv_value, account_id, row_count, was_skipped)
                    VALUES (?, ?, ?, ?, 0)
                """, (batch_id, info["csv_value"], aid, info["count"]))
            for csv_val, row_ct in skip_counts.items():
                mapped_id = effective_map.get(csv_val)  # may be None if no account mapped
                conn.execute("""
                    INSERT OR IGNORE INTO import_batch_account
                      (batch_id, csv_value, account_id, row_count, was_skipped)
                    VALUES (?, ?, ?, ?, 1)
                """, (batch_id, csv_val, mapped_id or None, row_ct))

        account_skipped = sum(skip_counts.values())

    trailing_errors = []
    for result in reversed(row_results):
        if result["status"] != "error":
            break
        trailing_errors.append(result)
    trailing_errors.reverse()

    trailing_non_transaction_suspected = bool(
        trailing_errors and any(result["status"] != "error" for result in row_results[:-len(trailing_errors)])
    )
    trailing_non_transaction_message = None
    if trailing_non_transaction_suspected:
        start_row = trailing_errors[0]["row"]
        trailing_non_transaction_message = (
            f"Rows {start_row} onward could be footer or other non-transaction text at the end of the file."
        )

    return {
        "batch_id":             batch_id,
        "imported":             imported,
        "skipped":              skipped,
        "deduped":              deduped,
        "account_skipped":      account_skipped,
        "new_accounts_created": len(created_account_ids),
        "has_imported_categories": bool(imported_category_counts),
        "imported_category_value_count": len(imported_category_counts),
        "trailing_non_transaction_suspected": trailing_non_transaction_suspected,
        "trailing_non_transaction_message": trailing_non_transaction_message,
        "trailing_error_start_row": trailing_errors[0]["row"] if trailing_errors else None,
        "trailing_error_count": len(trailing_errors),
        "errors":               errors[:20],
    }



# ── Batch list and undo ───────────────────────────────────────────────────────

@router.get("/batches")
def list_batches():
    with get_db() as conn:
        batches = conn.execute("""
            SELECT b.id, b.filename, b.imported_at, b.row_count, b.skipped_count,
                   b.deduped_count, b.status, p.name AS profile_name
            FROM   import_batch b
            LEFT JOIN csv_import_profile p ON p.id = b.profile_id
            WHERE  b.status = 'completed'
            ORDER  BY b.imported_at DESC
            LIMIT  50
        """).fetchall()

        result = []
        for b in batches:
            d = dict(b)
            accs = conn.execute("""
                SELECT iba.csv_value, iba.row_count, iba.was_skipped,
                       COALESCE(a.name, iba.csv_value) AS account_name
                FROM   import_batch_account iba
                LEFT JOIN account a ON a.id = iba.account_id
                WHERE  iba.batch_id = ?
                ORDER BY iba.was_skipped, iba.csv_value
            """, (b["id"],)).fetchall()
            d["accounts"] = [dict(a) for a in accs]
            result.append(d)
    return result


@router.get("/batches/{batch_id}/edited")
def get_edited_transactions(batch_id: str):
    """
    Return transactions in this batch that were manually edited after import
    (category overridden or merchant renamed). Used for undo warning.
    """
    with get_db() as conn:
        rows = conn.execute("""
            SELECT t.id, t.date, t.merchant_name, t.amount,
                   c.name AS category_name
            FROM   txn t
            LEFT JOIN category c ON c.id = t.category_id
            WHERE  t.import_batch_id = ?
              AND  t.category_overridden = 1
            ORDER  BY t.date DESC
        """, (batch_id,)).fetchall()
    return [dict(r) for r in rows]


@router.get("/batches/{batch_id}/category-mappings")
def get_batch_category_mappings(batch_id: str):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = {}
        if batch["config_snapshot"]:
            try:
                snapshot = json.loads(batch["config_snapshot"])
            except Exception:
                snapshot = {}

        saved_assignments = (snapshot.get("category_assignments") or
                             (snapshot.get("column_map") or {}).get("category_assignments") or {})

        category_rows = conn.execute("""
            SELECT t.imported_category AS raw_value,
                   COUNT(*) AS row_count
            FROM   txn t
            WHERE  t.import_batch_id = ?
              AND  t.imported_category IS NOT NULL
              AND  TRIM(t.imported_category) <> ''
            GROUP  BY t.imported_category
            ORDER  BY COUNT(*) DESC, t.imported_category
        """, (batch_id,)).fetchall()

        existing_categories = conn.execute("""
            SELECT c.id, c.name, c.parent_id, p.name AS group_name
            FROM   category c
            LEFT JOIN category p ON p.id = c.parent_id
            WHERE  c.parent_id IS NOT NULL
            ORDER  BY p.name, c.name
        """).fetchall()
        by_normalized_name = {
            normalize_import_category(row["name"]): row["id"]
            for row in existing_categories
        }

        values = []
        for row in category_rows:
            raw_value = row["raw_value"]
            saved_id = saved_assignments.get(raw_value)
            suggested_id = saved_id or by_normalized_name.get(normalize_import_category(raw_value))
            values.append({
                "raw_value": raw_value,
                "row_count": row["row_count"],
                "saved_category_id": saved_id,
                "suggested_category_id": suggested_id,
            })

    return {
        "values": values,
        "saved_assignments": saved_assignments,
        "unmapped_count": sum(1 for value in values if not value["saved_category_id"]),
    }


@router.post("/batches/{batch_id}/category-mappings")
def apply_batch_category_mappings(batch_id: str, body: BatchCategoryMappingApplyRequest):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = {}
        if batch["config_snapshot"]:
            try:
                snapshot = json.loads(batch["config_snapshot"])
            except Exception:
                snapshot = {}

        current_assignments = (snapshot.get("category_assignments") or
                               (snapshot.get("column_map") or {}).get("category_assignments") or {})
        merged_assignments = {**current_assignments, **body.assignments}

        applied = 0
        for raw_value, category_id in body.assignments.items():
            result = conn.execute("""
                UPDATE txn
                SET    category_id = ?, category_overridden = 1
                WHERE  import_batch_id = ?
                  AND  imported_category = ?
            """, (category_id, batch_id, raw_value))
            applied += result.rowcount or 0

        snapshot["category_assignments"] = merged_assignments
        column_map = dict(snapshot.get("column_map") or {})
        column_map["category_assignments"] = merged_assignments
        snapshot["column_map"] = column_map
        config_snapshot = json.dumps(snapshot)
        conn.execute(
            "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
            (config_snapshot, batch_id),
        )

        saved_to_profile = False
        if batch["profile_id"]:
            profile = conn.execute(
                "SELECT column_map FROM csv_import_profile WHERE id = ?",
                (batch["profile_id"],),
            ).fetchone()
            if profile:
                try:
                    profile_map = json.loads(profile["column_map"] or "{}")
                except Exception:
                    profile_map = {}
                profile_map["category_assignments"] = {
                    **(profile_map.get("category_assignments") or {}),
                    **body.assignments,
                }
                conn.execute(
                    "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
                    (json.dumps(profile_map), batch["profile_id"]),
                )
                saved_to_profile = True

        categorized_by_rules = 0
        if snapshot.get("apply_categorization", True):
            uncategorized_rows = conn.execute("""
                SELECT id, owner_id, amount, merchant_name, raw_name
                FROM   txn
                WHERE  import_batch_id = ?
                  AND  category_id IS NULL
                  AND  category_overridden = 0
            """, (batch_id,)).fetchall()
            for row in uncategorized_rows:
                cat_id = categorize_transaction(
                    row["merchant_name"] or row["raw_name"] or "",
                    row["raw_name"] or row["merchant_name"] or "",
                    abs(row["amount"]),
                    conn,
                    owner_id=row["owner_id"],
                )
                if cat_id:
                    conn.execute(
                        "UPDATE txn SET category_id = ? WHERE id = ?",
                        (cat_id, row["id"]),
                    )
                    categorized_by_rules += 1

    return {
        "ok": True,
        "applied_count": applied,
        "categorized_by_rules": categorized_by_rules,
        "saved_to_profile": saved_to_profile,
        "saved_mapping_count": len(body.assignments),
    }


@router.delete("/batches/{batch_id}")
def undo_batch(batch_id: str, force: bool = Query(False)):
    """
    Undo an import batch. If any transactions were manually edited, returns 409
    with the list unless force=true.
    """
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, status FROM import_batch WHERE id = ?", (batch_id,)
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        if batch["status"] == "undone":
            raise HTTPException(status_code=400, detail="Batch already undone")

        if not force:
            edited = conn.execute("""
                SELECT t.id, t.date, t.merchant_name, t.amount,
                       c.name AS category_name
                FROM   txn t
                LEFT JOIN category c ON c.id = t.category_id
                WHERE  t.import_batch_id = ? AND t.category_overridden = 1
            """, (batch_id,)).fetchall()

            if edited:
                return JSONResponse(status_code=409, content={
                    "detail": "Some transactions were manually edited after import",
                    "edited_transactions": [dict(r) for r in edited],
                })

        conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (batch_id,))
        conn.execute(
            "UPDATE import_batch SET status = 'undone' WHERE id = ?", (batch_id,)
        )

    return {"ok": True}


# ── CSV Export ────────────────────────────────────────────────────────────────

EXPORT_COLUMNS = {
    "date":          ("t.date",            "Date"),
    "merchant_name": ("t.merchant_name",   "Merchant"),
    "raw_name":      ("t.raw_name",        "Raw description"),
    "amount":        ("t.amount",          "Amount"),
    "account":       ("a.name",            "Account"),
    "category":      ("c.name",            "Category"),
    "group":         ("p.name",            "Group"),
    "owner":         ("o.name",            "Owner"),
    "notes":         ("t.notes",           "Notes"),
    "is_pending":    ("t.is_pending",      "Pending"),
    "overridden":    ("t.category_overridden", "Manually categorized"),
    "import_batch":  ("t.import_batch_id", "Import batch"),
}


@router.get("/transactions.csv")
def export_transactions_csv(
    columns:      str           = Query("date,merchant_name,amount,account,category"),
    date_start:   Optional[str] = Query(None),
    date_end:     Optional[str] = Query(None),
    account_ids:  Optional[str] = Query(None),
    owner_ids:    Optional[str] = Query(None),
    group_ids:    Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
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
        clauses.append(f"t.account_id IN ({','.join('?'*len(ids))})"); params.extend(ids)
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
    if search:
        clauses.append("(t.merchant_name LIKE ? OR t.raw_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT {', '.join(select_exprs)}
            FROM   txn t
            JOIN   account   a ON a.id  = t.account_id
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


# ── JSON Backup / Restore ─────────────────────────────────────────────────────

@router.get("/backup")
def export_backup(encrypted: bool = Query(False)):
    """Export all non-sensitive data as a JSON backup."""
    with get_db() as conn:
        def dump(table, query=None):
            q = query or f"SELECT * FROM {table} ORDER BY rowid"
            return [dict(r) for r in conn.execute(q).fetchall()]

        payload = {
            "version":        2,
            "exported_at":    datetime.utcnow().isoformat(),
            "owners":         dump("owner"),
            "accounts":       dump("account",
                                   "SELECT id, plaid_account_id, plaid_item_id, name, "
                                   "institution, type, subtype, mask, owner_id FROM account"),
            "categories":     dump("category"),
            "category_rules": dump("category_rule"),
            "merchant_renames": dump("merchant_rename"),
            "csv_profiles":   dump("csv_import_profile"),
            "import_batches": dump("import_batch"),
            "import_batch_accounts": dump("import_batch_account"),
            "transactions":   dump("txn",
                                   "SELECT id, plaid_transaction_id, account_id, owner_id, "
                                   "category_id, amount, merchant_name, raw_name, date, "
                                   "is_pending, category_overridden, imported_category, notes, content_hash, "
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
def export_credentials(request: Request):
    """Export Plaid credentials — treat this file like a password."""
    with get_db() as conn:
        items = conn.execute("SELECT * FROM plaid_item").fetchall()
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
    content = _zip_json_bytes("fintrack_credentials.json", payload)
    return StreamingResponse(
        iter([content]),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="fintrack_credentials.zip"'},
    )


class RestoreRequest(BaseModel):
    data:             dict


@router.post("/restore")
def restore_backup(body: RestoreRequest):
    """
    Destructive restore. Wipes all non-credential data and replaces with backup.
    Plaid items / access tokens are NOT touched.
    """
    d = body.data
    if d.get("version") not in (1, 2):
        raise HTTPException(status_code=400, detail="Unrecognised backup version")

    owners = [dict(row) for row in d.get("owners", [])]
    accounts = [dict(row) for row in d.get("accounts", [])]
    categories = [dict(row) for row in d.get("categories", [])]
    category_rules = [dict(row) for row in d.get("category_rules", [])]
    merchant_renames = [dict(row) for row in d.get("merchant_renames", [])]
    csv_profiles = [dict(row) for row in d.get("csv_profiles", [])]
    import_batches = [dict(row) for row in d.get("import_batches", [])]
    import_batch_accounts = [dict(row) for row in d.get("import_batch_accounts", [])]
    transactions = [dict(row) for row in d.get("transactions", [])]

    owner_ids = {row.get("id") for row in owners if row.get("id")}
    account_ids = {row.get("id") for row in accounts if row.get("id")}
    category_ids = {row.get("id") for row in categories if row.get("id")}
    csv_profile_ids = {row.get("id") for row in csv_profiles if row.get("id")}
    import_batch_ids = {row.get("id") for row in import_batches if row.get("id")}

    def normalize_nullable_fk(rows, key, valid_ids):
        for row in rows:
            value = row.get(key)
            if value and value not in valid_ids:
                row[key] = None

    normalize_nullable_fk(accounts, "owner_id", owner_ids)
    normalize_nullable_fk(categories, "owner_id", owner_ids)
    normalize_nullable_fk(csv_profiles, "account_id", account_ids)
    normalize_nullable_fk(import_batches, "profile_id", csv_profile_ids)

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

    # Categories are a two-level hierarchy; insert groups before leaves so
    # self-referential parent_id constraints are satisfied during restore.
    categories.sort(key=lambda row: (0 if not row.get("parent_id") else 1, row.get("sort_order", 0), row.get("name", "")))

    with get_db() as conn:
        # Wipe in dependency order (children before parents)
        conn.execute("DELETE FROM txn")
        conn.execute("DELETE FROM import_batch_account")
        conn.execute("DELETE FROM import_batch")
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
            "transactions": len(transactions),
        },
    }


class CredentialsRestoreRequest(BaseModel):
    data: dict


@router.post("/restore-file/inspect")
async def inspect_backup_file(file: UploadFile = File(...)):
    content = await file.read()
    return _inspect_backup_upload(content, file.filename or "", "backup")


@router.post("/restore/credentials")
def restore_credentials(body: CredentialsRestoreRequest, request: Request):
    """Restore Plaid access tokens from a credentials backup."""
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
