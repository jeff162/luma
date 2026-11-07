# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Per-connection setup and data lifecycle — everything about a connection that is *local* state rather
than a provider call (those live in `providers.py` / `sync.py`).

Its main job is account mapping, the data-source analog of a CSV import's account step: a connection
offers accounts; this router is where the user says what each one *is* locally. The mapping is durable
and revisitable (`connection_account`), which matters beyond convenience: it is the input duplicate
detection needs, and for a metered provider a re-link to "start over" may not be available. See
`services/connection_mapping.py` for the modes and what each buys the dedupe ladder. Its other job is
the reverse: removing what a connection has synced, and resetting the chain that describes it.
"""

import json

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

from backend.db.database import compact_if_worthwhile, get_db
from backend.routers.accounts import resolve_default_owner_id
from backend.routers.sync import SYNC_SOURCE_KIND
from backend.services.connection_dedupe import rescan_connection_duplicates
from backend.services.recurring_detection import settle_owed_rescans
from backend.services.connection_mapping import (
    MAPPING_MODES,
    apply_account_mapping,
    captured_field_keys,
    list_connection_accounts,
    unmapped_count,
)
from backend.services.providers import UnknownProviderError, get_adapter
from backend.services.providers.config import forget_synced_state

router = APIRouter()


class AccountMappingChoice(BaseModel):
    mode: str
    # The existing account this decision points at: adopted ('existing') or the parent to nest
    # under ('group'). Ignored for 'new' and 'skip'.
    target_account_id: Optional[str] = None
    # Only consulted when the mode creates an account, and only on first application.
    name: Optional[str] = None
    type: Optional[str] = None
    # Every existing account the row offered as a possible match and the user ruled out by giving this
    # provider account its own account. Each becomes a distinct-account assertion once the new account
    # exists, so an answer given while looking at the account names is not thrown away and re-asked
    # later, one flagged transaction at a time. Ignored unless the mode gives this provider account its
    # own account.
    #
    # A **list**, because "not any of these" is what the user actually answered. It was a single id back
    # when the row could only ever show one suggestion, and that had the user assert distinctness from
    # one arbitrarily-chosen account while its equally-plausible siblings went unrecorded — or, when the
    # candidates tied and the suggestion was suppressed entirely, assert nothing at all.
    distinct_from_account_ids: Optional[list[str]] = None


class AccountMappingRequest(BaseModel):
    mappings: dict[str, AccountMappingChoice]


class CapturedFieldsRequest(BaseModel):
    fields: list[str]


def _capture_field_state(conn, connection):
    """The provider's declared capture fields, each marked with whether it is currently on. Locked
    fields always report on — they are what duplicate detection reads, so they are not the user's to
    disable; the picker renders them checked and disabled with that reason."""
    try:
        adapter = get_adapter(connection["provider"])
    except UnknownProviderError:
        return []
    active = captured_field_keys(conn, connection["id"], adapter)
    return [
        {**f, "enabled": bool(f.get("locked") or f["key"] in active)}
        for f in adapter.capture_fields()
    ]


def _get_connection(conn, connection_id: str):
    row = conn.execute(
        "SELECT id, provider, external_id, institution, transactions_cursor FROM connection WHERE id = ?",
        (connection_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    return row


def _accounts_awaiting_history(conn, connection_id: str) -> list[str]:
    """Mapped accounts on this connection that hold no history yet.

    Read from coverage rather than tracked separately: every account present during a history pull came
    away with a `coverage_start_date`, so a mapped account that still has none either joined the connection
    later or has never been backfilled. Both want the same thing — the next history pull — and the sync
    builds its own targets from the same fact, so nothing has to be scheduled or remembered here. This is
    purely so the caller knows a pull is worth running now rather than leaving the account visibly empty.
    """
    return [r["external_account_id"] for r in conn.execute(
        """
        SELECT external_account_id FROM connection_account
        WHERE  connection_id = ? AND mapping_mode IN ('new', 'existing', 'group')
               AND account_id IS NOT NULL AND coverage_start_date IS NULL
        """,
        (connection_id,),
    ).fetchall()]


@router.get("/{connection_id}/accounts")
def get_connection_accounts(connection_id: str):
    """The connection's provider accounts and their current mapping. The likely-match suggestion is
    deliberately computed client-side (`lib/importExport/importAccountMatching.js`), so the CSV
    mapping step and this one suggest identically from one implementation."""
    with get_db() as conn:
        connection = _get_connection(conn, connection_id)
        accounts = list_connection_accounts(conn, connection_id)
        capture_fields = _capture_field_state(conn, connection)
    return {
        "connection": dict(connection),
        "accounts": accounts,
        "unmapped": sum(1 for a in accounts if not a["mapped"]),
        "capture_fields": capture_fields,
    }


@router.post("/{connection_id}/account-map")
def set_connection_account_map(connection_id: str, body: AccountMappingRequest):
    """Apply (or re-apply) the mapping. Idempotent, so the post-Link pass and a later edit from the
    connection card are the same call.

    A mapping change can newly qualify already-synced rows for the cross-account rules — an account
    just declared an alias of a CSV account has coverage it did not have a moment ago — so a change
    re-judges those rows here, on the spot. This is the only caller: a mapping decision is worth
    nothing until the rows already in the ledger are re-judged under it, and every *other* occasion
    that changes what those rows should be compared against already runs its own detection (a CSV
    import and a sync sweep their own batch; an account merge scans the newly-unified group), so
    there is no state left for a user-driven re-check to reach. Nothing is deleted by it: hits land
    in the duplicate report for review.
    """
    for external_id, choice in (body.mappings or {}).items():
        if choice.mode not in MAPPING_MODES:
            raise HTTPException(status_code=400, detail=f"Unknown mapping mode {choice.mode!r}")
        if choice.mode in ("existing", "group") and not (choice.target_account_id or "").strip():
            raise HTTPException(
                status_code=400,
                detail=f"Mapping mode {choice.mode!r} needs a target account (external id {external_id})",
            )

    with get_db() as conn:
        connection = _get_connection(conn, connection_id)
        result = apply_account_mapping(
            conn,
            connection_id=connection_id,
            provider=connection["provider"],
            institution=connection["institution"],
            mappings={k: v.model_dump() for k, v in (body.mappings or {}).items()},
            default_owner_id=resolve_default_owner_id(conn, None),
        )
        rescan = rescan_connection_duplicates(conn, connection) if result["changed"] else None
        awaiting_history = _accounts_awaiting_history(conn, connection_id)
        accounts = list_connection_accounts(conn, connection_id)
        remaining = unmapped_count(conn, connection_id)
    settle_owed_rescans()

    # `awaiting_history` names accounts with no history yet, so the caller knows a pull is worth running
    # now rather than leaving a just-mapped account looking empty until some later sync collects it.
    return {**result, "accounts": accounts, "unmapped": remaining, "rescan": rescan,
            "awaiting_history": awaiting_history}


# Manual edits that make removing a synced row destructive rather than merely undoing a fetch. Kept
# identical to the CSV Undo guard (import_export/core.py) so the preflight below can never warn about
# rows the unforced delete would have gone ahead and removed.
_EDITED_SYNCED_ROWS_SQL = """
    SELECT t.id, t.date, COALESCE(t.display_name, t.merchant_name, t.raw_name) AS merchant_name, t.amount,
           c.name AS category_name
    FROM   txn t
    LEFT JOIN category c ON c.id = t.category_id
    WHERE  t.import_batch_id IN ({placeholders})
      AND  t.category_overridden = 1
      AND  COALESCE(t.category_source, 'manual') = 'manual'
    ORDER  BY t.date DESC
"""


def _sync_card_ids(conn, connection_id: str) -> list[str]:
    """Every import card this connection's syncs have written to — the initial backfill card plus each
    monthly period card (`routers/sync.py`)."""
    return [row["id"] for row in conn.execute(
        "SELECT id FROM import_batch WHERE connection_id = ? AND source_kind = ?",
        (connection_id, SYNC_SOURCE_KIND),
    ).fetchall()]


def _edited_synced_rows(conn, card_ids: list[str]) -> list[dict]:
    if not card_ids:
        return []
    placeholders = ",".join("?" * len(card_ids))
    return [dict(r) for r in conn.execute(
        _EDITED_SYNCED_ROWS_SQL.format(placeholders=placeholders), card_ids
    ).fetchall()]


@router.get("/{connection_id}/synced-transactions")
def get_synced_transactions_summary(connection_id: str):
    """What removing this connection's synced data would take with it — the transaction and card counts
    the confirm dialog states, plus the manually-edited rows it must warn about before proceeding."""
    with get_db() as conn:
        _get_connection(conn, connection_id)
        card_ids = _sync_card_ids(conn, connection_id)
        count = 0
        if card_ids:
            placeholders = ",".join("?" * len(card_ids))
            count = int(conn.execute(
                f"SELECT COUNT(*) AS n FROM txn WHERE import_batch_id IN ({placeholders})", card_ids
            ).fetchone()["n"] or 0)
        edited = _edited_synced_rows(conn, card_ids)
    return {"transaction_count": count, "card_count": len(card_ids), "edited_transactions": edited}


@router.delete("/{connection_id}/synced-transactions")
def remove_synced_transactions(connection_id: str, force: bool = Query(False)):
    """Remove everything this connection has synced and put it back to its pre-sync state.

    The rows go through the same path a file's Undo does (`undo_batches`), and the connection's sync
    cards are then **deleted** rather than left as 'undone' tombstones: a sync card records rows, not a
    user-supplied file, so with its rows gone and the cursor reset it records nothing — and the card
    resolvers key on (connection, backfill/period) without regard to status, so a tombstone would be
    silently reused by the re-backfill and its rows would land on a card the history filters out.

    Resetting `transactions_cursor` + `initial_sync_complete` is what makes this recoverable rather than
    destructive, and is the reason the action is connection-level in the first place: a routine sync only
    pulls changes *since* the cursor, so deleting synced rows while leaving the cursor advanced past them
    would put them beyond the reach of any later sync. The paired clear of the connection's
    `coverage_start_date` / `coverage_through_date` is the same invariant seen from the dedupe side — a
    coverage claim outliving the rows that backed it would blanket-reject the very transactions the
    re-backfill pulls back (`docs/data-model.md` → "coverage has two shapes").

    Manual edits are guarded exactly as a file Undo guards them: 409 with the edited rows unless
    `force`. No provider call and no credential are involved, so this works with the vault locked.
    """
    with get_db() as conn:
        _get_connection(conn, connection_id)
        card_ids = _sync_card_ids(conn, connection_id)

        if not force:
            edited = _edited_synced_rows(conn, card_ids)
            if edited:
                return JSONResponse(status_code=409, content={
                    "detail": "Some synced transactions were manually edited",
                    "edited_transactions": edited,
                })

        # Lazy, as elsewhere for this module: core.py pulls in many services, and a connection with
        # nothing synced never needs it.
        from backend.routers.import_export.core import (
            finish_restored_rejections,
            rejudge_orphaned_rejections,
            undo_batches,
        )

        result = undo_batches(conn, card_ids)
        if card_ids:
            placeholders = ",".join("?" * len(card_ids))
            conn.execute(f"DELETE FROM import_batch WHERE id IN ({placeholders})", card_ids)
        forget_synced_state(conn, [connection_id])
        conn.execute(
            """
            UPDATE connection_account
            SET    coverage_start_date = NULL, coverage_through_date = NULL
            WHERE  connection_id = ?
            """,
            (connection_id,),
        )
        # After the coverage clear: rows other sources rejected against this connection's are judged again
        # against the ledger without them.
        restored = rejudge_orphaned_rejections(conn)
    finish_restored_rejections(restored)
    settle_owed_rescans()
    compact_if_worthwhile(reason="removed a connection's synced transactions")

    return {
        "ok": True,
        "removed": result["deleted"],
        "restored": result["restored"],
        "cards_removed": len(card_ids),
    }


@router.post("/{connection_id}/captured-fields")
def set_captured_fields(connection_id: str, body: CapturedFieldsRequest):
    """Choose which OPTIONAL per-transaction detail this connection captures. Locked keys are ignored
    rather than rejected — the client renders them as fixed, and silently dropping them keeps a
    round-tripped payload from having to strip them first.

    Applies to future syncs only: this changes what is captured, not what was.
    """
    with get_db() as conn:
        connection = _get_connection(conn, connection_id)
        try:
            adapter = get_adapter(connection["provider"])
        except UnknownProviderError:
            raise HTTPException(status_code=409, detail="This connection's provider is not supported")
        optional = {f["key"] for f in adapter.capture_fields() if not f.get("locked")}
        chosen = sorted(k for k in (body.fields or []) if k in optional)
        conn.execute(
            "UPDATE connection SET captured_fields = ? WHERE id = ?",
            (json.dumps(chosen), connection_id),
        )
        capture_fields = _capture_field_state(conn, connection)
    return {"capture_fields": capture_fields}
