# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Per-connection account mapping — the data-source analog of a CSV import's account step.

A connection offers accounts; this router is where the user says what each one *is* locally. The
mapping is durable and revisitable (`connection_account`), which matters beyond convenience: it is
the input duplicate detection needs, and for a metered provider a re-link to "start over" may not be
available. See `services/connection_mapping.py` for the modes and what each buys the dedupe ladder.
"""

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from backend.db.database import get_db
from backend.routers.accounts import resolve_default_owner_id
from backend.services.connection_dedupe import rescan_connection_duplicates
from backend.services.connection_mapping import (
    MAPPING_MODES,
    apply_account_mapping,
    captured_field_keys,
    list_connection_accounts,
    unmapped_count,
)
from backend.services.providers import UnknownProviderError, get_adapter

router = APIRouter()


class AccountMappingChoice(BaseModel):
    mode: str
    # The existing account this decision points at: adopted ('existing') or the parent to nest
    # under ('group'). Ignored for 'new' and 'skip'.
    target_account_id: Optional[str] = None
    # Only consulted when the mode creates an account, and only on first application.
    name: Optional[str] = None
    type: Optional[str] = None


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
        "SELECT id, provider, external_id, institution FROM connection WHERE id = ?",
        (connection_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    return row


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
        accounts = list_connection_accounts(conn, connection_id)
        remaining = unmapped_count(conn, connection_id)

    return {**result, "accounts": accounts, "unmapped": remaining, "rescan": rescan}


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
            raise HTTPException(status_code=409, detail="This data source has no adapter")
        optional = {f["key"] for f in adapter.capture_fields() if not f.get("locked")}
        chosen = sorted(k for k in (body.fields or []) if k in optional)
        conn.execute(
            "UPDATE connection SET captured_fields = ? WHERE id = ?",
            (json.dumps(chosen), connection_id),
        )
        capture_fields = _capture_field_state(conn, connection)
    return {"capture_fields": capture_fields}
