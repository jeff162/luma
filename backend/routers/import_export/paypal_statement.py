# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""PayPal statement import's HTTP surface: read dropped statements (PDFs, or zips of them), then import
each into the PayPal account it belongs to. Reading a statement is `services/paypal_statement.py`; the
import is the ordinary one (`core.run_import_parsed`), so each statement becomes a card under the PayPal
data source beside the activity CSVs, with their duplicate detection, undo and money-movement review.

**Each statement belongs to one PayPal account, and that is remembered.** A statement names the PayPal
account it is for (its PayPal Account ID). The first statement imported for an ID decides which account
in the ledger holds that ID's statements, and from then on the two are tied both ways: a statement is
refused if it would go into a different account, and an account holding one ID's statements refuses
another's. That catches importing one household member's statements into another's PayPal account, which
would otherwise look like any other import. The tie is read from the statements imported before (each
batch keeps the header it was read from), so undoing them undoes it; nothing else stores it.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from backend.db.database import get_db
from backend.db.demo_data import is_demo_data_loaded
from backend.json_utils import safe_json_dict
from backend.services.account_groups import effective_account_id
from backend.services.import_evidence import EVIDENCE_ROLE_CATEGORICAL
from backend.services.ledger_currency import currency_matches, get_ledger_currency
from backend.services.money_movement import PAYPAL_ACCOUNT_TYPE, is_money_movement_type
from backend.services.paypal_statement import STATEMENT_HEADERS, Statement, StatementError, is_pdf, read_statement
from backend.services.recurring_detection import settle_owed_rescans
from backend.services.restore_state import require_no_pending_restore
from backend.services.source_capabilities import SOURCE_PAYPAL_STATEMENT

from .core import (
    PAYPAL_SOURCE_KIND,
    STATEMENT_SNAPSHOT_KEY,
    ParsedFile,
    _get_or_create_paypal_profile,
    run_import_parsed,
)

router = APIRouter()

# A zip of statements is a year of months at most; the caps only keep a hostile archive from expanding
# without bound.
MAX_ZIP_MEMBERS = 240
MAX_EXPANDED_BYTES = 64 * 1024 * 1024

COLUMN_MAP = {
    "date": "Date",
    "description": "Name",
    "amount": "Total",
    "currency": "Currency",
    "evidence_columns": ["Type", "Transaction ID", "Ref ID", "Bank account"],
}
# Declared rather than measured: a month's statement is a handful of rows, too few for the cardinality a
# CSV's columns are classified by, and every one of these describes a row without naming it.
EVIDENCE_ROLES = {header: EVIDENCE_ROLE_CATEGORICAL for header in COLUMN_MAP["evidence_columns"]}


@dataclass(frozen=True)
class _Found:
    filename: str
    statement: Statement


async def _read_uploads(files: list[UploadFile]) -> tuple[list[_Found], list[str], list[dict]]:
    """The statements in the dropped files — each PDF, and each PDF inside a zip — once each, however many
    times the same month was dropped; plus the files that are not PayPal statements, and the ones that
    look like one but could not be read."""
    found: list[_Found] = []
    unrecognized: list[str] = []
    unreadable: list[dict] = []
    seen: set[str] = set()
    for upload in files:
        name = upload.filename or "statement.pdf"
        data = await upload.read()
        for member_name, member in _documents(name, data, unrecognized, unreadable):
            try:
                statement = read_statement(member)
            except StatementError as e:
                unreadable.append({"name": member_name, "reason": str(e)})
                continue
            if statement is None:
                unrecognized.append(member_name)
            elif statement.content_hash not in seen:
                seen.add(statement.content_hash)
                found.append(_Found(member_name, statement))
    return found, unrecognized, unreadable


def _documents(name: str, data: bytes, unrecognized: list[str], unreadable: list[dict]) -> list[tuple[str, bytes]]:
    if is_pdf(data):
        return [(name, data)]
    if not zipfile.is_zipfile(io.BytesIO(data)):
        unrecognized.append(name)
        return []
    out, total = [], 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = [m for m in archive.infolist() if not m.is_dir()]
            if len(members) > MAX_ZIP_MEMBERS:
                unreadable.append({"name": name, "reason": "The zip holds too many files."})
                return []
            for member in members:
                member_name = member.filename.rsplit("/", 1)[-1]
                total += member.file_size
                if total > MAX_EXPANDED_BYTES:
                    unreadable.append({"name": name, "reason": "The zip is too large."})
                    return []
                content = archive.read(member)
                if is_pdf(content):
                    out.append((member_name, content))
                else:
                    unrecognized.append(member_name)
    except (zipfile.BadZipFile, OSError) as e:
        unreadable.append({"name": name, "reason": f"The zip could not be read: {e}"})
        return []
    return out


def _imported_hashes(conn) -> set[str]:
    return {r["file_content_hash"] for r in conn.execute(
        "SELECT file_content_hash FROM import_batch WHERE status = 'completed' AND file_content_hash IS NOT NULL"
    ).fetchall()}


def _statement_accounts(conn) -> tuple[dict[str, str], dict[str, str]]:
    """Which account each PayPal Account ID's statements went into, and which ID each such account holds —
    read from the statements imported before, as the account group each landed in."""
    by_paypal_id: dict[str, str] = {}
    by_account: dict[str, str] = {}
    for row in conn.execute(
        "SELECT config_snapshot FROM import_batch WHERE status = 'completed' AND source_kind = ? ORDER BY imported_at",
        (PAYPAL_SOURCE_KIND,),
    ).fetchall():
        snapshot = safe_json_dict(row["config_snapshot"])
        header = snapshot.get(STATEMENT_SNAPSHOT_KEY)
        if not isinstance(header, dict) or not header.get("paypal_account_id") or not snapshot.get("account_id"):
            continue
        root = effective_account_id(conn, snapshot["account_id"])
        if root:
            by_paypal_id[header["paypal_account_id"]] = root
            by_account[root] = header["paypal_account_id"]
    return by_paypal_id, by_account


def statement_account_pairs(conn) -> list[dict]:
    """Each PayPal Account ID with the account its statements go into, for showing on the PayPal data
    source — the pairing `_statement_accounts` reads back, which nothing else displays."""
    by_paypal_id, _ = _statement_accounts(conn)
    names = _account_names(conn, list(by_paypal_id.values()))
    return [{"paypal_account_id": pid, "account_id": aid, "account_name": names.get(aid)}
            for pid, aid in sorted(by_paypal_id.items())]


def _currency_refusals(statement: Statement, ledger_currency: str) -> dict[int, str]:
    """The rows in the ledger's currency that only moved money for a row in another currency — a card
    deposit that paid for a payment in pounds, say. The payment is refused for its currency, and its card
    or bank charge then stays the record of it; the deposit, imported, would pair that charge away."""
    foreign = {row["Transaction ID"]: row["Currency"] for row in statement.rows
               if row["Currency"] and not currency_matches(ledger_currency, row["Currency"])}
    return {
        index: f"Moved money for a payment in {foreign[row['Ref ID']]}, which is not imported"
        for index, row in enumerate(statement.rows)
        if row["Ref ID"] in foreign and row["Transaction ID"] not in foreign and is_money_movement_type(row["Type"])
    }


def _describe(found: _Found, imported: set[str], ledger_currency: str) -> dict:
    statement = found.statement
    return {
        "key": statement.content_hash,
        "filename": found.filename,
        "paypal_account_id": statement.paypal_account_id,
        "holder": statement.holder,
        "period_start": statement.period_start,
        "period_end": statement.period_end,
        "transaction_count": len(statement.rows),
        "foreign_count": sum(1 for row in statement.rows if not currency_matches(ledger_currency, row["Currency"])),
        "already_imported": statement.content_hash in imported,
    }


def _account_names(conn, account_ids) -> dict[str, str]:
    ids = [a for a in set(account_ids) if a]
    if not ids:
        return {}
    rows = conn.execute(
        f"SELECT id, COALESCE(display_name, name) AS name FROM account WHERE id IN ({','.join('?' * len(ids))})", ids
    ).fetchall()
    return {r["id"]: r["name"] for r in rows}


@router.post("/paypal-statements/scan")
async def scan_paypal_statements(files: list[UploadFile] = File(...)):
    """What the dropped files hold, before anything is imported: each statement's PayPal account and
    period, whether it was imported before, and which account each PayPal account's statements already go
    into. Read-only."""
    found, unrecognized, unreadable = await _read_uploads(files)
    with get_db() as conn:
        imported = _imported_hashes(conn)
        ledger_currency = get_ledger_currency(conn)
        by_paypal_id, by_account = _statement_accounts(conn)
        names = _account_names(conn, list(by_paypal_id.values()))
    return {
        "statements": sorted((_describe(f, imported, ledger_currency) for f in found),
                             key=lambda s: (s["paypal_account_id"], s["period_start"])),
        "accounts": {pid: {"account_id": aid, "account_name": names.get(aid)} for pid, aid in by_paypal_id.items()},
        "claimed_accounts": by_account,
        "unrecognized_files": unrecognized,
        "unreadable_files": unreadable,
    }


def _refuse(message: str) -> HTTPException:
    return HTTPException(status_code=409, detail={"code": "statement_account", "message": message})


def _check_assignments(conn, statements: list[Statement], assignments: dict) -> dict[str, str]:
    """The account group each PayPal account's statements go into, refused where that contradicts what
    earlier statements established or is not a PayPal account."""
    by_paypal_id, by_account = _statement_accounts(conn)
    resolved: dict[str, str] = {}
    for paypal_id in sorted({s.paypal_account_id for s in statements}):
        chosen = assignments.get(paypal_id)
        if not chosen:
            raise _refuse(f"Choose the account for the statements of PayPal account {paypal_id}.")
        root = effective_account_id(conn, chosen)
        account = conn.execute(
            "SELECT COALESCE(display_name, name) AS name, type FROM account WHERE id = ? AND trashed_at IS NULL", (root,)
        ).fetchone() if root else None
        if not account:
            raise _refuse("That account no longer exists.")
        if (account["type"] or "") != PAYPAL_ACCOUNT_TYPE:
            raise _refuse(f"{account['name']} is not a PayPal account.")
        remembered = by_paypal_id.get(paypal_id)
        if remembered and remembered != root:
            other = _account_names(conn, [remembered]).get(remembered, "another account")
            raise _refuse(f"Statements for PayPal account {paypal_id} go into {other}, not {account['name']}.")
        holder = by_account.get(root)
        if holder and holder != paypal_id:
            raise _refuse(f"{account['name']} holds the statements of PayPal account {holder}, not {paypal_id}.")
        if root in resolved.values():
            raise _refuse(f"{account['name']} can hold the statements of only one PayPal account.")
        resolved[paypal_id] = root
    return resolved


def _parsed(statement: Statement, ledger_currency: str) -> ParsedFile:
    return ParsedFile(
        headers=list(STATEMENT_HEADERS),
        rows=[dict(row) for row in statement.rows],
        content_hash=statement.content_hash,
        source=SOURCE_PAYPAL_STATEMENT,
        source_kind=PAYPAL_SOURCE_KIND,
        evidence_roles=EVIDENCE_ROLES,
        currency_refusals=_currency_refusals(statement, ledger_currency),
    )


def _config(profile: dict, account_id: str, statement: Statement) -> dict:
    return {
        "column_map": COLUMN_MAP,
        "date_format": "%m/%d/%Y",
        "amount_convention": "single_signed",
        "apply_categorization": bool(profile["apply_categorization"]),
        # A statement row that is already in the ledger — from a sync or an earlier CSV — gives it the
        # statement's detail, as a PayPal CSV import does.
        "enrich_from_source": True,
        "account_id": account_id,
        "profile_id": profile["id"],
        STATEMENT_SNAPSHOT_KEY: {
            "paypal_account_id": statement.paypal_account_id,
            "holder": statement.holder,
            "period_start": statement.period_start,
            "period_end": statement.period_end,
        },
    }


@router.post("/paypal-statements/import")
async def import_paypal_statements(files: list[UploadFile] = File(...), assignments: str = Form(...)):
    """Import the dropped statements, each into the account chosen for its PayPal account, oldest first.
    A statement imported before, or with no activity, is skipped and reported."""
    try:
        chosen = json.loads(assignments)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid assignments")
    if not isinstance(chosen, dict):
        raise HTTPException(status_code=400, detail="Invalid assignments")
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before importing your own data.",
            })
        require_no_pending_restore(conn, "importing")

    found, unrecognized, unreadable = await _read_uploads(files)
    with get_db() as conn:
        imported_before = _imported_hashes(conn)
        ledger_currency = get_ledger_currency(conn)
        pending = [f for f in found if f.statement.content_hash not in imported_before and f.statement.rows]
        accounts = _check_assignments(conn, [f.statement for f in pending], chosen)
        profile_id = _get_or_create_paypal_profile(
            conn, header_fingerprint="", column_map=COLUMN_MAP, date_format="%m/%d/%Y",
            amount_convention="single_signed",
        )
        profile = dict(conn.execute(
            "SELECT id, apply_categorization FROM csv_import_profile WHERE id = ?", (profile_id,)
        ).fetchone())

    batches, skipped = [], []
    for f in found:
        if f.statement.content_hash in imported_before:
            skipped.append({"filename": f.filename, "reason": "already_imported"})
        elif not f.statement.rows:
            skipped.append({"filename": f.filename, "reason": "no_activity"})
    for f in sorted(pending, key=lambda f: (f.statement.paypal_account_id, f.statement.period_start)):
        statement = f.statement
        result = run_import_parsed(
            _parsed(statement, ledger_currency),
            _config(profile, accounts[statement.paypal_account_id], statement),
            filename=f.filename,
        )
        batches.append({
            "batch_id": result.get("batch_id"),
            "filename": f.filename,
            "period_start": statement.period_start,
            "period_end": statement.period_end,
            "imported": result.get("imported", 0),
            "duplicates": result.get("deduped", 0),
            "rejected": result.get("rejected_count", 0),
            "enriched": result.get("enriched_count", 0),
        })
    # Each statement's import owed its payees a recurring rescan; one scan settles them all.
    if batches:
        settle_owed_rescans()
    return {"batches": batches, "skipped": skipped, "unrecognized_files": unrecognized, "unreadable_files": unreadable}
