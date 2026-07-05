# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

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
from backend.services.categorizer import (
    categorize_transaction,
    load_categorization_rules,
    load_rule_tags_by_id,
    preview_recategorize_count,
    recategorize_all,
    rule_scalar_effects,
)
from backend.services.recurring_detection import payee_keys_for_ids, run_auto_scan, scan_imported_payees
from backend.services.transaction_tags import sync_rule_tags_for_transaction

router = APIRouter()


@router.post("")
def run_sync(days: int = 30, request: Request = None):
    start_date = date.today() - timedelta(days=days)
    added = updated = skipped = 0
    touched_ids: list[str] = []  # rows this sync added or advanced — the scope for the recurring rescan

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

        # Rules are stable across a sync; load once for the per-transaction matcher in the loops below.
        rules = load_categorization_rules(conn)
        rule_tags_by_id = load_rule_tags_by_id(conn)
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
                        touched_ids.append(existing["id"])
                    else:
                        skipped += 1
                    continue

                result = categorize_transaction(
                    t["merchant_name"], t["raw_name"], t["merchant_name"], t["amount"], conn,
                    owner_id=acc["owner_id"],
                    account_id=acc["id"],
                    rules=rules,
                    rule_tags_by_id=rule_tags_by_id,
                )
                cat_id       = result["category_id"] if isinstance(result, dict) else result
                rule_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
                name_effects = rule_scalar_effects(
                    result, fallback_name=t["merchant_name"] or t["raw_name"]
                )
                display_name = name_effects["display_name"]
                # 'rule' when a rule authored the name, else 'import' (the synced source name).
                display_name_source = "rule" if name_effects["renamed_by_rule"] else "import"
                txn_id = str(uuid.uuid4())

                conn.execute(
                    """
                    INSERT INTO txn
                        (id, plaid_transaction_id, account_id, owner_id, category_id,
                         amount, merchant_name, display_name, raw_name, date, is_pending, display_name_source, needs_review)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
                    """,
                    (
                        txn_id,
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
                        display_name_source,
                    ),
                )
                sync_rule_tags_for_transaction(conn, txn_id, rule_tag_ids)
                added += 1
                touched_ids.append(txn_id)

    # New/advanced rows change the recurring picture, so refresh detection now rather than waiting for a
    # manual scan. Cheap scoped path: reprocess only the payees this sync touched, not the whole ledger
    # (the daily app-load catch-up is the global safety net). Runs after the sync transaction commits, in
    # its own connection, and never lets a detection hiccup fail the sync itself.
    if touched_ids:
        try:
            with get_db() as conn:
                scan_imported_payees(conn, payee_keys_for_ids(conn, touched_ids))
        except Exception as e:
            log_warning(f"[sync] recurring auto-scan failed: {e}")

    return {"added": added, "updated": updated, "skipped": skipped}


@router.post("/recategorize")
def recategorize():
    with get_db() as conn:
        n = recategorize_all(conn)
    # Recategorization can move categories and rename payees (clean_name) across the whole ledger, both of
    # which reshape recurring grouping. It is also the one path that renames *existing* series members —
    # the case the scoped import/sync passes deliberately leave to a full rebuild (they skip payee-key
    # re-derivation). So run a FULL scan here, not a scoped one: it re-detects and re-derives keys. Guarded
    # so a detection hiccup never fails the recategorize that already committed.
    if n:
        try:
            with get_db() as conn:
                run_auto_scan(conn)
        except Exception as e:
            log_warning(f"[recategorize] recurring auto-scan failed: {e}")
    return {"updated": n}


@router.get("/recategorize-preview")
def recategorize_preview():
    with get_db() as conn:
        pending = preview_recategorize_count(conn)
    return {"pending": pending}
