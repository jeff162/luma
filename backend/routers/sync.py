# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Sync is the reconciliation path between Plaid's transaction stream and local state.

Its core invariants are idempotence by Plaid transaction id, pending-to-posted
advancement without rewriting local edits, and reuse of the shared categorization
engine so imported history and future syncs stay consistent with one another.
"""

import json
import uuid
from datetime import date, timedelta
from fastapi import APIRouter, HTTPException, Request

from backend.app_logging import log_warning
from backend.db.database import get_db
from backend.services import crypto_service
from backend.services.providers import UnknownProviderError, get_adapter, resolve_app_config
from backend.services.categorizer import (
    categorize_transaction,
    load_categorization_rules,
    load_rule_tags_by_id,
    preview_recategorize_count,
    recategorize_all,
    rule_scalar_effects,
)
from backend.services.duplicate_detection import (
    mark_import_suspects,
    promote_in_group_suspects_to_confirmed,
)
from backend.services.recurring_detection import payee_keys_for_ids, run_auto_scan, scan_imported_payees
from backend.services.transaction_tags import sync_rule_tags_for_transaction

router = APIRouter()

# import_batch.source_kind marker for a data-source sync's period card. A sync groups its rows into one
# card per (connection, calendar month), so synced rows get an import_batch_id and a duplicate-review home
# like any imported file (see docs/backlog/sync-import-records-and-dedupe.md — record-first, then detection).
SYNC_SOURCE_KIND = "connection_sync"

# The window used when a caller asks for "all available history" (days <= 0). Plaid's transactions/get
# returns up to ~24 months for most institutions, so a 2-year window is effectively "everything they
# have" while staying inside the documented range. The connection module's guiding principle is to pull
# as much history as possible by default (the initial connect/refresh backfill uses this); routine
# top-up syncs pass a small explicit window instead.
ALL_HISTORY_DAYS = 730


def resolve_sync_period_batch(conn, connection, on_date: date) -> str:
    """Return the id of the (connection, calendar-month) period card, creating it lazily on first use.

    The period is keyed on the fetch date's month, not each transaction's own date: a fetch's rows all
    land on the *current* period's card for the connection (mirroring how a CSV card is one import event),
    and later fetches in the same month reuse it, so a daily sync that pulls one or two rows extends the
    month's card instead of flooding the history with tiny per-fetch cards. `sync_period` in the config
    snapshot ('YYYY-MM') is the period identity; connection_id (indexed) narrows the lookup first.
    """
    period_key = on_date.strftime("%Y-%m")
    row = conn.execute(
        """
        SELECT id FROM import_batch
        WHERE  connection_id = ?
          AND  source_kind = ?
          AND  json_extract(config_snapshot, '$.sync_period') = ?
        """,
        (connection["id"], SYNC_SOURCE_KIND, period_key),
    ).fetchone()
    if row:
        return row["id"]
    batch_id = str(uuid.uuid4())
    institution = connection["institution"] or connection["provider"] or "Data source"
    filename = f"{institution} · {on_date.strftime('%B %Y')}"
    conn.execute(
        """
        INSERT INTO import_batch (id, filename, status, source_kind, connection_id, config_snapshot)
        VALUES (?, ?, 'completed', ?, ?, ?)
        """,
        (batch_id, filename, SYNC_SOURCE_KIND, connection["id"], json.dumps({"sync_period": period_key})),
    )
    return batch_id


@router.post("")
def run_sync(days: int = 30, connection_id: str = None, request: Request = None):
    # days <= 0 means "all available history" (the connect/refresh backfill); a positive value is an
    # explicit window (routine top-ups). connection_id scopes the sync to one connection so a backfill
    # for a just-connected/refreshed bank doesn't re-pull every other connection too; None syncs all.
    window_days = ALL_HISTORY_DAYS if days <= 0 else days
    start_date = date.today() - timedelta(days=window_days)
    added = updated = skipped = 0
    touched_ids: list[str] = []  # rows this sync added or advanced — the scope for the recurring rescan
    # Rows this sync lands on each connection's period card, tallied then flushed to the card's row_count
    # and per-account breakdown once the insert loop is done (a card is reused across fetches, so the
    # counts accumulate rather than overwrite).
    period_batch_added: dict[str, int] = {}                    # batch_id -> rows added this sync
    period_batch_accounts: dict[tuple[str, str], dict] = {}    # (batch_id, csv_value) -> {account_id, count}

    with get_db() as conn:
        if connection_id:
            connections = conn.execute(
                "SELECT id, provider, external_id, credential, credential_enc, institution "
                "FROM connection WHERE id = ?",
                (connection_id,),
            ).fetchall()
        else:
            connections = conn.execute(
                "SELECT id, provider, external_id, credential, credential_enc, institution FROM connection"
            ).fetchall()

        # Syncing decrypts each connection's credential under the workspace DEK, so the vault must be
        # unlocked. Fail the whole sync up front rather than silently skipping every connection in the loop.
        if connections and not crypto_service.is_unlocked(request.state.user["id"]):
            raise HTTPException(status_code=423, detail={
                "code": "vault_locked",
                "message": "Unlock the vault to sync.",
            })

        # Lazy import: content_hash uses the same helper CSV import does, kept as the single source of truth.
        # core.py is heavy and imports many services, so pull it in only when a sync actually runs.
        from backend.routers.import_export.core import make_hash

        # Rules are stable across a sync; load once for the per-transaction matcher in the loops below.
        rules = load_categorization_rules(conn)
        rule_tags_by_id = load_rule_tags_by_id(conn)
        for connection in connections:
            # The connection's period card, resolved lazily on the first row this fetch actually inserts,
            # so a fetch that lands nothing (all pending-advance or all skipped) creates no empty card.
            period_batch_id: str | None = None
            try:
                adapter = get_adapter(connection["provider"])
                app_config = resolve_app_config(request.state.user, connection["provider"])
                if not app_config:
                    log_warning(
                        f"[sync] skipping connection {connection['id']}: provider "
                        f"{connection['provider']!r} has no configured app credentials"
                    )
                    continue
                credential = crypto_service.decrypt_connection_credential(
                    request.state.user, connection["provider"], connection["external_id"],
                    connection["credential"], connection["credential_enc"],
                )
                txns = adapter.fetch_transactions(
                    app_config,
                    credential,
                    start_date=start_date,
                    end_date=date.today(),
                )
            except UnknownProviderError as e:
                log_warning(f"[sync] skipping connection {connection['id']}: {e}")
                continue
            except Exception as e:
                log_warning(f"[sync] error fetching connection {connection['id']}: {e}")
                continue

            for t in txns:
                acc = conn.execute(
                    "SELECT id, owner_id FROM account WHERE external_account_id = ?",
                    (t["external_account_id"],),
                ).fetchone()
                if not acc:
                    skipped += 1
                    continue

                existing = conn.execute(
                    "SELECT id, is_pending FROM txn WHERE plaid_transaction_id = ?",
                    (t["external_transaction_id"],),
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

                # First insert of this fetch → resolve (creating if needed) the connection's period card, so
                # the synced row carries an import_batch_id and gains a duplicate-review home like an import.
                if period_batch_id is None:
                    period_batch_id = resolve_sync_period_batch(conn, connection, date.today())

                # Same content-hash formula as CSV import (make_hash), so a synced row is a first-class dedupe
                # citizen — the exact-hash rules and the cross-account sweep can compare it against imported
                # rows in either direction. Previously synced rows had a NULL content_hash and were invisible
                # to detection.
                content_hash = make_hash(
                    t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or ""
                )

                conn.execute(
                    """
                    INSERT INTO txn
                        (id, plaid_transaction_id, account_id, owner_id, category_id,
                         amount, merchant_name, display_name, raw_name, date, is_pending, display_name_source,
                         content_hash, import_batch_id, needs_review)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
                    """,
                    (
                        txn_id,
                        t["external_transaction_id"],
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
                        content_hash,
                        period_batch_id,
                    ),
                )
                sync_rule_tags_for_transaction(conn, txn_id, rule_tag_ids)
                added += 1
                touched_ids.append(txn_id)
                # Tally toward the card's row_count and per-account breakdown. csv_value is the account's
                # provider handle (stable per account); the history join renders the account's name from it.
                period_batch_added[period_batch_id] = period_batch_added.get(period_batch_id, 0) + 1
                acct_key = (period_batch_id, t["external_account_id"])
                acct_entry = period_batch_accounts.setdefault(
                    acct_key, {"account_id": acc["id"], "count": 0}
                )
                acct_entry["count"] += 1

        # Flush the period-card tallies. Counts accumulate (a card is reused across fetches in its month),
        # so both updates add to the existing value rather than overwrite it.
        for batch_id, n in period_batch_added.items():
            conn.execute(
                "UPDATE import_batch SET row_count = row_count + ? WHERE id = ?", (n, batch_id)
            )
        for (batch_id, csv_value), info in period_batch_accounts.items():
            conn.execute(
                """
                INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(batch_id, csv_value)
                DO UPDATE SET row_count  = row_count + excluded.row_count,
                              account_id = excluded.account_id
                """,
                (batch_id, csv_value, info["account_id"], info["count"]),
            )

        # Duplicate detection on the freshly-synced rows, mirroring the import finalize (core.py). The gap
        # this closes: a CSV/manual row re-fetched via a data source is a *cross-account* duplicate (the sync
        # creates a new account record keyed on the provider handle, distinct from the CSV account until the
        # user merges them), which same-provider-id idempotence never sees.
        #   1. mark_import_suspects — soft-flag every cross-account (date, amount, payee) match against an
        #      existing row on a different account, unless the pair is already declared distinct. The suspect
        #      is attributed to the period card, so it surfaces on that card's standard duplicates report.
        #   2. promote_in_group_suspects_to_confirmed — if the synced row landed on an account already merged
        #      with the matched row's account, the user has already asserted they're the same account, so the
        #      just-flagged suspect is an in-group duplicate: promote it to confirmed exactly as a merge would.
        # (Same-account exact re-imports are handled by content_hash on a later CSV import and by provider-id
        # idempotence on re-sync; the dominant sync gap is the cross-account case above.)
        for batch_id in period_batch_added:
            mark_import_suspects(conn, batch_id)
            batch_account_ids = [
                str(r["account_id"]) for r in conn.execute(
                    "SELECT DISTINCT account_id FROM txn WHERE import_batch_id = ? AND account_id IS NOT NULL",
                    (batch_id,),
                ).fetchall()
            ]
            if batch_account_ids:
                promote_in_group_suspects_to_confirmed(conn, batch_account_ids)

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
