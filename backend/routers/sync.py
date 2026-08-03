# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Sync is the reconciliation path between a provider's transaction stream and local state.

It uses the provider's cursor-based incremental API (Plaid `/transactions/sync`): each call pulls the
`added` / `modified` / `removed` changes since a stored per-connection cursor and reports the backfill
readiness (`update_status`), so the client can poll to completion without a webhook. Core invariants:
idempotence by provider transaction id, pending-to-posted advancement without rewriting local edits,
reuse of the shared categorization engine, and — for a connection's first (historical) pull — one
"initial import" card, with routine top-up syncs accreting onto monthly period cards.
"""

import json
import uuid
from datetime import date
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

# The fetch-depth (`days_requested`) used when a caller asks for "all available history" (days <= 0).
# Plaid caps transaction history at ~24 months, so 730 is "everything they have". The connection module's
# guiding principle is to pull as much history as possible; the initial connect/refresh backfill uses this,
# while a user can pick a shallower window (persisted as their default) to bound the fetch.
ALL_HISTORY_DAYS = 730

# Plaid's transactions_update_status values, least→most complete. The sync loop marks a connection's
# historical backfill done at HISTORICAL_UPDATE_COMPLETE; UNKNOWN is treated as terminal so a status the
# API can't determine never traps the client in an endless poll.
_HISTORICAL_COMPLETE = "HISTORICAL_UPDATE_COMPLETE"
_STATUS_UNKNOWN = "TRANSACTIONS_UPDATE_STATUS_UNKNOWN"
_STATUS_ORDER = {"NOT_READY": 0, "INITIAL_UPDATE_COMPLETE": 1, _HISTORICAL_COMPLETE: 2, _STATUS_UNKNOWN: 2, None: 2}


def _is_terminal_status(status) -> bool:
    """True once a connection's historical pull is complete (or the provider can't report status)."""
    return status in (_HISTORICAL_COMPLETE, _STATUS_UNKNOWN, None)


def resolve_initial_sync_batch(conn, connection) -> str:
    """The connection's single "initial import" card — one card for the whole first historical backfill
    (which can span up to ~24 months), rather than splitting it across monthly cards. Created lazily and
    reused across the paging/polling calls that make up the initial pull (keyed by the `initial_backfill`
    marker in config_snapshot). Once the backfill completes, later syncs use `resolve_sync_period_batch`."""
    row = conn.execute(
        """
        SELECT id FROM import_batch
        WHERE  connection_id = ?
          AND  source_kind = ?
          AND  json_extract(config_snapshot, '$.initial_backfill') = 1
        """,
        (connection["id"], SYNC_SOURCE_KIND),
    ).fetchone()
    if row:
        return row["id"]
    batch_id = str(uuid.uuid4())
    institution = connection["institution"] or connection["provider"] or "Data source"
    filename = f"{institution} · Initial import"
    conn.execute(
        """
        INSERT INTO import_batch (id, filename, status, source_kind, connection_id, config_snapshot)
        VALUES (?, ?, 'completed', ?, ?, ?)
        """,
        (batch_id, filename, SYNC_SOURCE_KIND, connection["id"], json.dumps({"initial_backfill": True})),
    )
    return batch_id


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


_MAX_PAGES_PER_CALL = 50  # safety cap (≤ 25k txns/request) so a misbehaving has_more can't loop forever


@router.post("")
def run_sync(days: int = 0, connection_id: str = None, request: Request = None):
    # `days` is the provider fetch depth (`days_requested`): <= 0 means "all available history" (the
    # connect/refresh backfill), a positive value bounds it (the user's shallower window). connection_id
    # scopes the sync to one connection so a just-connected bank's backfill doesn't re-pull the others.
    # One call drains the currently-available pages (has_more) then returns `update_status`; the client
    # re-calls until `historical_complete`, so the async historical backfill is polled to completion.
    days_requested = ALL_HISTORY_DAYS if days <= 0 else min(days, ALL_HISTORY_DAYS)
    added = updated = removed = skipped = 0
    touched_ids: list[str] = []  # rows this sync added or advanced — the scope for the recurring rescan
    cards_touched: set[str] = set()          # cards that received added rows (for the post-sync dedup sweep)
    card_added: dict[str, int] = {}          # card_id -> rows added this call
    card_accounts: dict[tuple[str, str], dict] = {}  # (card_id, csv_value) -> {account_id, count}
    synced_statuses: list = []               # each synced connection's final update_status

    with get_db() as conn:
        if connection_id:
            connections = conn.execute(
                "SELECT id, provider, external_id, credential, credential_enc, institution, "
                "transactions_cursor, initial_sync_complete FROM connection WHERE id = ?",
                (connection_id,),
            ).fetchall()
        else:
            connections = conn.execute(
                "SELECT id, provider, external_id, credential, credential_enc, institution, "
                "transactions_cursor, initial_sync_complete FROM connection"
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

        # Rules are stable across a sync; load once for the per-transaction matcher below.
        rules = load_categorization_rules(conn)
        rule_tags_by_id = load_rule_tags_by_id(conn)

        def _account_for(external_account_id):
            return conn.execute(
                "SELECT id, owner_id FROM account WHERE external_account_id = ?",
                (external_account_id,),
            ).fetchone()

        def _insert_added(t, get_card) -> bool:
            """Insert one `added` transaction. `get_card` lazily resolves (and creates) the connection's
            card only when a row is actually inserted, so a no-op sync leaves no empty card. Idempotent on
            provider id: a row we already have advances pending state instead of duplicating."""
            nonlocal added, updated, skipped
            acc = _account_for(t["external_account_id"])
            if not acc:
                skipped += 1
                return False
            # Pending → posted: this posted transaction supersedes a pending row we already hold. Convert
            # that row in place (new posted id + refreshed provider fields), preserving its category/name
            # edits, tags, card, and identity — rather than trashing the pending (via the matching `removed`)
            # and inserting a fresh posted row. Processing all `added` before all `removed` (below) makes the
            # subsequent removed of the pending id a no-op, since its provider id has changed to the posted one.
            pending_id = t.get("pending_external_transaction_id")
            if pending_id:
                pend = conn.execute(
                    "SELECT id FROM txn WHERE plaid_transaction_id = ? AND trashed_at IS NULL",
                    (pending_id,),
                ).fetchone()
                if pend:
                    content_hash = make_hash(t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or "")
                    conn.execute(
                        """
                        UPDATE txn SET plaid_transaction_id = ?, amount = ?, date = ?, is_pending = ?,
                                       merchant_name = ?, raw_name = ?, content_hash = ?
                        WHERE  id = ?
                        """,
                        (t["external_transaction_id"], t["amount"], t["date"], 1 if t["is_pending"] else 0,
                         t["merchant_name"], t["raw_name"], content_hash, pend["id"]),
                    )
                    updated += 1
                    touched_ids.append(pend["id"])
                    return False
            existing = conn.execute(
                "SELECT id, is_pending FROM txn WHERE plaid_transaction_id = ?",
                (t["external_transaction_id"],),
            ).fetchone()
            if existing:
                if existing["is_pending"] and not t["is_pending"]:
                    conn.execute("UPDATE txn SET is_pending = 0 WHERE id = ?", (existing["id"],))
                    updated += 1
                    touched_ids.append(existing["id"])
                else:
                    skipped += 1
                return False

            card_id = get_card()
            result = categorize_transaction(
                t["merchant_name"], t["raw_name"], t["merchant_name"], t["amount"], conn,
                owner_id=acc["owner_id"], account_id=acc["id"], rules=rules, rule_tags_by_id=rule_tags_by_id,
            )
            cat_id       = result["category_id"] if isinstance(result, dict) else result
            rule_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
            name_effects = rule_scalar_effects(result, fallback_name=t["merchant_name"] or t["raw_name"])
            display_name = name_effects["display_name"]
            display_name_source = "rule" if name_effects["renamed_by_rule"] else "import"
            content_hash = make_hash(t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or "")
            txn_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO txn
                    (id, plaid_transaction_id, account_id, owner_id, category_id,
                     amount, merchant_name, display_name, raw_name, date, is_pending, display_name_source,
                     content_hash, import_batch_id, needs_review)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
                """,
                (txn_id, t["external_transaction_id"], acc["id"], acc["owner_id"], cat_id, t["amount"],
                 t["merchant_name"], display_name, t["raw_name"], t["date"], 1 if t["is_pending"] else 0,
                 display_name_source, content_hash, card_id),
            )
            sync_rule_tags_for_transaction(conn, txn_id, rule_tag_ids)
            added += 1
            touched_ids.append(txn_id)
            cards_touched.add(card_id)
            card_added[card_id] = card_added.get(card_id, 0) + 1
            entry = card_accounts.setdefault((card_id, t["external_account_id"]), {"account_id": acc["id"], "count": 0})
            entry["count"] += 1
            return True

        def _apply_modified(t) -> None:
            """A provider-side revision to a known transaction: refresh the provider-owned fields and the
            content hash, but leave the user's category and display-name edits intact. A modification for a
            row we don't have locally (outside our window, or dedup-dropped) is ignored."""
            nonlocal updated, skipped
            existing = conn.execute(
                "SELECT id FROM txn WHERE plaid_transaction_id = ?", (t["external_transaction_id"],),
            ).fetchone()
            if not existing:
                skipped += 1
                return
            content_hash = make_hash(t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or "")
            conn.execute(
                """
                UPDATE txn SET amount = ?, date = ?, is_pending = ?, merchant_name = ?, raw_name = ?,
                               content_hash = ?
                WHERE  id = ?
                """,
                (t["amount"], t["date"], 1 if t["is_pending"] else 0, t["merchant_name"], t["raw_name"],
                 content_hash, existing["id"]),
            )
            updated += 1
            touched_ids.append(existing["id"])

        def _apply_removed(external_transaction_id) -> None:
            """The provider dropped a transaction (a canceled pending charge, or a correction): trash the
            local row so it leaves the active ledger. No-op if we never had it."""
            nonlocal removed
            cur = conn.execute(
                "UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
                "WHERE plaid_transaction_id = ? AND trashed_at IS NULL",
                (external_transaction_id,),
            )
            removed += cur.rowcount or 0

        for connection in connections:
            initial = not connection["initial_sync_complete"]
            cursor = connection["transactions_cursor"]
            final_status = None
            # The card is created lazily on the first actually-inserted row (a no-op sync leaves no empty
            # card): the initial historical pull → one "initial import" card; a routine sync (backfill
            # already complete) → the current monthly period card. Defaults bind the per-connection values.
            card_state = {"id": None}

            def _get_card(connection=connection, initial=initial, card_state=card_state):
                if card_state["id"] is None:
                    card_state["id"] = (resolve_initial_sync_batch(conn, connection) if initial
                                        else resolve_sync_period_batch(conn, connection, date.today()))
                return card_state["id"]
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
                # Drain the pages available right now (has_more) into one change set, then apply added →
                # modified → removed. Draining first guarantees every `added` is processed before any
                # `removed` even when a pending→posted pair straddles a page boundary, so the pending row is
                # converted in place (in _insert_added) before its `removed` entry would trash it. The cursor
                # advances per page and is persisted at the end, so a mid-loop failure rolls back the whole
                # call and the next retry resumes from the last committed cursor.
                page_added, page_modified, page_removed = [], [], []
                for _ in range(_MAX_PAGES_PER_CALL):
                    page = adapter.fetch_transactions_sync(
                        app_config, credential, cursor=cursor, days_requested=days_requested,
                    )
                    page_added.extend(page["added"])
                    page_modified.extend(page["modified"])
                    page_removed.extend(page["removed"])
                    cursor = page["next_cursor"]
                    final_status = page["update_status"]
                    if not page["has_more"]:
                        break
                for t in page_added:
                    _insert_added(t, _get_card)
                for t in page_modified:
                    _apply_modified(t)
                for ext_id in page_removed:
                    _apply_removed(ext_id)
            except UnknownProviderError as e:
                log_warning(f"[sync] skipping connection {connection['id']}: {e}")
                continue
            except NotImplementedError as e:
                log_warning(f"[sync] skipping connection {connection['id']}: {e}")
                continue
            except Exception as e:
                log_warning(f"[sync] error fetching connection {connection['id']}: {e}")
                continue

            # Persist the advanced cursor, and flip the connection out of "initial" once the historical
            # backfill is done — subsequent syncs then accrete onto monthly cards instead of the one card.
            became_complete = initial and _is_terminal_status(final_status)
            conn.execute(
                "UPDATE connection SET transactions_cursor = ?, initial_sync_complete = ? WHERE id = ?",
                (cursor, 1 if (connection["initial_sync_complete"] or became_complete) else 0, connection["id"]),
            )
            synced_statuses.append(final_status)

        # Flush the card tallies (a card is reused across calls, so counts accumulate).
        for card_id, n in card_added.items():
            conn.execute("UPDATE import_batch SET row_count = row_count + ? WHERE id = ?", (n, card_id))
        for (card_id, csv_value), info in card_accounts.items():
            conn.execute(
                """
                INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(batch_id, csv_value)
                DO UPDATE SET row_count  = row_count + excluded.row_count,
                              account_id = excluded.account_id
                """,
                (card_id, csv_value, info["account_id"], info["count"]),
            )

        # Duplicate detection on the freshly-synced rows, mirroring the import finalize (core.py): a
        # CSV/manual row re-fetched via a data source is a *cross-account* duplicate (the sync creates a new
        # account record, distinct from the CSV account until merged), which provider-id idempotence never
        # sees. mark_import_suspects soft-flags those on the card; promote_in_group_suspects_to_confirmed
        # confirms the ones whose accounts are already merged. Only cards that received rows are swept.
        for card_id in cards_touched:
            mark_import_suspects(conn, card_id)
            card_account_ids = [
                str(r["account_id"]) for r in conn.execute(
                    "SELECT DISTINCT account_id FROM txn WHERE import_batch_id = ? AND account_id IS NOT NULL",
                    (card_id,),
                ).fetchall()
            ]
            if card_account_ids:
                promote_in_group_suspects_to_confirmed(conn, card_account_ids)

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

    # `historical_complete` is the client's stop-polling signal: true once every synced connection's
    # backfill is terminal. `update_status` echoes the least-advanced status for display.
    historical_complete = all(_is_terminal_status(s) for s in synced_statuses)
    overall_status = min(synced_statuses, key=lambda s: _STATUS_ORDER.get(s, 2), default=None)
    return {
        "added": added, "updated": updated, "removed": removed, "skipped": skipped,
        "update_status": overall_status, "historical_complete": historical_complete,
    }


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
