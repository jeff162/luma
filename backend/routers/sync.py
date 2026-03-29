"""
sync.py — Plaid transaction sync and nightly pull.

DESIGN PRINCIPLES:
- Sync is idempotent: transactions are upserted by plaid_transaction_id, so
  running sync multiple times is safe.
- Categorization rules can carry an optional clean_name. When a rule matches,
  that clean_name is used as merchant_name on the new transaction, replacing
  the raw Plaid name. This consolidates rename + categorization into a single
  rule mechanism — no separate merchant_rename table lookup is needed.
  Order: fetch from Plaid → auto-categorize (with optional rename) → upsert.
- Pending transactions are stored but excluded from all spending summaries.
  They are updated to non-pending on subsequent syncs when Plaid finalizes them.
- category_overridden transactions keep their category across syncs. Only
  transactions with category_overridden=0 are auto-categorized on sync.
- The /recategorize endpoint re-runs the rules engine on all non-overridden
  transactions in the database. Use this after adding or changing rules.
"""

import uuid
from datetime import date, timedelta
from fastapi import APIRouter, Request
from db.database import get_db
from services import plaid_service, crypto_service
from services.categorizer import categorize_transaction, recategorize_all

router = APIRouter()


@router.post("")
def run_sync(days: int = 30, request: Request = None):
    """
    Pull the last N days of transactions for every linked Plaid item.
    Safe to run repeatedly — deduplicates via plaid_transaction_id.
    """
    start_date = date.today() - timedelta(days=days)
    added = updated = skipped = 0

    with get_db() as conn:
        # Ensure the plaid_item table exists (created on first token exchange)
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
                # Log and continue — don't let one bad item stop the rest
                print(f"[sync] Error fetching item {item['item_id']}: {e}")
                continue

            for t in txns:
                # Resolve account row — also grab owner_id for categorization
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
                    # Update pending → posted
                    if existing["is_pending"] and not t["is_pending"]:
                        conn.execute(
                            "UPDATE txn SET is_pending = 0 WHERE id = ?",
                            (existing["id"],),
                        )
                        updated += 1
                    else:
                        skipped += 1
                    continue

                # Auto-categorize — pass owner_id so owner-scoped rules fire correctly
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
    """Re-run the rules engine over all non-overridden transactions."""
    with get_db() as conn:
        n = recategorize_all(conn)
    return {"updated": n}
