# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Sync is the reconciliation path between Plaid's transaction stream and local state.

Its core invariants are idempotence by Plaid transaction id, pending-to-posted
advancement without rewriting local edits, and reuse of the shared categorization
engine so imported history and future syncs stay consistent with one another.
"""

import uuid
from datetime import date, timedelta
from fastapi import APIRouter, Request

from backend.app_logging import log_warning
from backend.db.database import get_db
from backend.services import crypto_service, plaid_service
from backend.services.categorizer import categorize_transaction, recategorize_all

router = APIRouter()


@router.post("")
def run_sync(days: int = 30, request: Request = None):
    start_date = date.today() - timedelta(days=days)
    added = updated = skipped = 0

    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plaid_item (
                item_id           TEXT PRIMARY KEY,
                access_token      TEXT NOT NULL DEFAULT '',
                access_token_enc  TEXT
            )
            """
        )
        items = conn.execute("SELECT item_id, access_token, access_token_enc FROM plaid_item").fetchall()

        for item in items:
            try:
                access_token = crypto_service.decrypt_plaid_access_token(
                    request.state.user, item["item_id"], item["access_token"], item["access_token_enc"]
                )
                txns = plaid_service.fetch_transactions(
                    access_token,
                    start_date=start_date,
                    end_date=date.today(),
                )
            except Exception as e:
                log_warning(f"[sync] error fetching item {item['item_id']}: {e}")
                continue

            for t in txns:
                acc = conn.execute(
                    "SELECT id, owner_id FROM account WHERE plaid_account_id = ?",
                    (t["plaid_account_id"],),
                ).fetchone()
                if not acc:
                    skipped += 1
                    continue

                existing = conn.execute(
                    "SELECT id, is_pending FROM txn WHERE plaid_transaction_id = ?",
                    (t["plaid_transaction_id"],),
                ).fetchone()

                if existing:
                    # Existing Plaid ids are only allowed to advance pending state here;
                    # category/name edits on already-known rows stay owned by local logic.
                    if existing["is_pending"] and not t["is_pending"]:
                        conn.execute(
                            "UPDATE txn SET is_pending = 0 WHERE id = ?",
                            (existing["id"],),
                        )
                        updated += 1
                    else:
                        skipped += 1
                    continue

                result = categorize_transaction(
                    t["merchant_name"], t["raw_name"], t["merchant_name"], t["amount"], conn,
                    owner_id=acc["owner_id"],
                    account_id=acc["id"],
                )
                cat_id       = result["category_id"] if isinstance(result, dict) else result
                display_name = (
                    result.get("clean_name") if isinstance(result, dict) else None
                ) or t["merchant_name"] or t["raw_name"]

                conn.execute(
                    """
                    INSERT INTO txn
                        (id, plaid_transaction_id, account_id, owner_id, category_id,
                         amount, merchant_name, display_name, raw_name, date, is_pending)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        str(uuid.uuid4()),
                        t["plaid_transaction_id"],
                        acc["id"],
                        acc["owner_id"],
                        cat_id,
                        t["amount"],
                        t["merchant_name"],
                        display_name,
                        t["raw_name"],
                        t["date"],
                        1 if t["is_pending"] else 0,
                    ),
                )
                added += 1

    return {"added": added, "updated": updated, "skipped": skipped}


@router.post("/recategorize")
def recategorize():
    with get_db() as conn:
        n = recategorize_all(conn)
    return {"updated": n}
