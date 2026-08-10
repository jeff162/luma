# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Account records serve two related lifecycle models.

- Active root accounts are the selectable/reportable physical accounts the rest of the app works with.
- Child accounts keep historical account numbers visible on the Accounts page while sharing a parent display name elsewhere.
- Trashed child accounts stay recoverable until the trash is emptied, at which point their references are folded into the parent.

Attach / detach also coordinates with dedupe state — see
`backend/services/duplicate_detection.py`:
- attach declares two accounts as the same physical account, so it drops any prior
  "these accounts are distinct" assertion (`clear_account_pair_distinct_for_merge`) and
  promotes pre-existing cross-account soft-flags between the merged accounts to confirmed
  duplicates (`promote_in_group_suspects_to_confirmed`, tagged `dedupe_resolved_by='auto_merge'`).
- detach reverses the merge promotion: rows on the detaching account that were tagged
  `'auto_merge'` and point into the remaining group are restored to active-suspect state
  (`restore_auto_merged_after_detach`). User-Reject decisions (`'user'`) are preserved.
"""

import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import SHARED_OWNER_NAME, SHARED_OWNER_ID, get_db
from backend.json_utils import safe_json_dict
from backend.time_utils import utcnow_iso
from backend.routers.sync import SYNC_SOURCE_KIND
from backend.services.connection_mapping import apply_account_mapping, record_provider_accounts
from backend.services.duplicate_detection import (
    account_skipped_duplicate_summary,
    clear_account_pair_distinct_for_merge,
    forget_account_pair_distinct,
    list_distinct_account_pairs,
    promote_in_group_suspects_to_confirmed,
    restore_auto_merged_after_detach,
    scan_scope_for_cross_account_duplicates,
)

router = APIRouter()
IMPORT_SUMMARY_KEY = "import_summary"


class AccountCreate(BaseModel):
    name: str
    type: Optional[str] = None
    owner_id: Optional[str] = None


class AccountUpdate(BaseModel):
    owner_id: Optional[str] = None
    name: Optional[str] = None
    type: Optional[str] = None


class AccountAttachRequest(BaseModel):
    parent_account_id: str


class AccountTagsUpdate(BaseModel):
    tag_ids: list[str]


def _normalize_match_value(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def _serialize_account(row) -> dict:
    """Convert a db row to a dict, adding is_shared for the shared owner account."""
    d = dict(row)
    d["is_shared"] = d.get("owner_id") == SHARED_OWNER_ID
    return d


def _attach_account_tags(conn, accounts: list[dict]) -> list[dict]:
    # Each account carries its *own* attached tag ids (what it would contribute as a top-level
    # account). Whether those tags are effective is resolved per transaction through the effective
    # (top-level) account — a child's own tags stay dormant — so the frontend derives effective tags
    # from parent_account_id rather than this list claiming to be effective.
    if not accounts:
        return accounts
    tag_map: dict[str, list[str]] = {}
    for row in conn.execute("SELECT account_id, tag_id FROM account_tag").fetchall():
        tag_map.setdefault(row["account_id"], []).append(row["tag_id"])
    for account in accounts:
        account["tag_ids"] = tag_map.get(account["id"], [])
    return accounts


def _get_account_row(conn, account_id: str):
    return conn.execute(
        """
        SELECT
            a.id,
            a.name,
            a.display_name,
            a.institution,
            a.type,
            a.subtype,
            a.mask,
            a.owner_id,
            a.parent_account_id,
            a.trashed_at,
            a.connection_id,
            a.provider,
            (
                SELECT COUNT(*)
                FROM txn t
                WHERE t.account_id = a.id
            ) AS transaction_count,
            o.name AS owner_name,
            o.color AS owner_color
        FROM account a
        LEFT JOIN owner o ON o.id = a.owner_id
        WHERE a.id = ?
        """,
        (account_id,),
    ).fetchone()


def _list_account_rows(conn, *, include_children: bool, include_trashed: bool):
    clauses = []
    params: list[str] = []
    if not include_children:
        clauses.append("a.parent_account_id IS NULL")
    if not include_trashed:
        clauses.append("a.trashed_at IS NULL")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return conn.execute(
        f"""
        SELECT
            a.id,
            a.name,
            a.display_name,
            a.institution,
            a.type,
            a.subtype,
            a.mask,
            a.owner_id,
            a.parent_account_id,
            a.trashed_at,
            a.connection_id,
            a.provider,
            (
                SELECT COUNT(*)
                FROM txn t
                WHERE t.account_id = a.id
            ) AS transaction_count,
            o.name AS owner_name,
            o.color AS owner_color
        FROM account a
        LEFT JOIN owner o ON o.id = a.owner_id
        {where}
        ORDER BY
            CASE WHEN a.parent_account_id IS NULL THEN 0 ELSE 1 END,
            LOWER(COALESCE(a.display_name, a.name)),
            LOWER(a.name),
            a.id
        """,
        params,
    ).fetchall()


def _get_child_count(conn, account_id: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM account WHERE parent_account_id = ? AND trashed_at IS NULL",
        (account_id,),
    ).fetchone()[0]


def _assert_owner_exists(conn, owner_id: Optional[str]) -> Optional[str]:
    owner_val = owner_id.strip() if owner_id else None
    if not owner_val:
        return None
    owner = conn.execute("SELECT id FROM owner WHERE id = ?", (owner_val,)).fetchone()
    if not owner:
        raise HTTPException(status_code=404, detail="Owner not found")
    return owner_val


def _set_root_display_name(conn, account_id: str, display_name: str):
    conn.execute(
        "UPDATE account SET display_name = ? WHERE id = ?",
        (display_name, account_id),
    )
    conn.execute(
        "UPDATE account SET display_name = ? WHERE parent_account_id = ?",
        (display_name, account_id),
    )


def _list_group_member_ids(conn, account_id: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT id
        FROM account
        WHERE id = ? OR parent_account_id = ?
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
        """,
        (account_id, account_id, account_id),
    ).fetchall()
    return [row["id"] for row in rows]


def _replace_account_reference_in_profile_column_maps(conn, source_account_id: str, target_account_id: str):
    rows = conn.execute(
        "SELECT id, column_map FROM csv_import_profile"
    ).fetchall()
    for row in rows:
        column_map = {}
        try:
            parsed = json.loads(row["column_map"] or "{}")
            if isinstance(parsed, dict):
                column_map = parsed
        except Exception:
            continue
        assignments = column_map.get("account_assignments")
        if not isinstance(assignments, dict):
            continue
        changed = False
        next_assignments = {}
        for csv_value, account_id in assignments.items():
            if account_id == source_account_id:
                next_assignments[csv_value] = target_account_id
                changed = True
            else:
                next_assignments[csv_value] = account_id
        if changed:
            column_map["account_assignments"] = next_assignments
            conn.execute(
                "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
                (json.dumps(column_map), row["id"]),
            )


def _replace_account_reference_in_batch_snapshots(conn, source_account_id: str, target_account_id: str):
    rows = conn.execute(
        "SELECT id, config_snapshot FROM import_batch WHERE config_snapshot IS NOT NULL AND TRIM(config_snapshot) <> ''"
    ).fetchall()
    for row in rows:
        snapshot = {}
        try:
            parsed = json.loads(row["config_snapshot"] or "{}")
            if isinstance(parsed, dict):
                snapshot = parsed
        except Exception:
            continue

        changed = False
        if snapshot.get("account_id") == source_account_id:
            snapshot["account_id"] = target_account_id
            changed = True
        account_map = snapshot.get("account_map")
        if isinstance(account_map, dict):
            next_account_map = {}
            map_changed = False
            for csv_value, account_id in account_map.items():
                if account_id == source_account_id:
                    next_account_map[csv_value] = target_account_id
                    map_changed = True
                else:
                    next_account_map[csv_value] = account_id
            if map_changed:
                snapshot["account_map"] = next_account_map
                changed = True

        if changed:
            conn.execute(
                "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                (json.dumps(snapshot), row["id"]),
            )


def _batch_has_duplicates(conn, batch_id: str) -> bool:
    """Whether the card still holds a duplicate report — asked of the rows rather than of
    `deduped_count`, so a counter that has drifted low cannot take a real report down with the card."""
    return conn.execute(
        "SELECT 1 FROM import_batch_duplicate WHERE batch_id = ? LIMIT 1", (batch_id,)
    ).fetchone() is not None


def _refresh_import_batch_summaries(conn, batch_ids: set[str]):
    for batch_id in sorted(batch_id for batch_id in batch_ids if batch_id):
        batch = conn.execute(
            "SELECT id, skipped_count, deduped_count, source_kind, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            continue

        imported_count = int(conn.execute(
            "SELECT COUNT(*) FROM txn WHERE import_batch_id = ?",
            (batch_id,),
        ).fetchone()[0] or 0)
        skipped_count = int(batch["skipped_count"] or 0)
        deduped_count = int(batch["deduped_count"] or 0)
        total_rows = imported_count + skipped_count + deduped_count

        # A data-source card that recomputes to nothing is deleted rather than left at zero rows, on the
        # same reasoning `connections.remove_synced_transactions` deletes cards instead of leaving
        # tombstones: a sync card records *rows*, so with its last row gone it records nothing, and the
        # card resolvers key on (connection, backfill/period) without regard to status — a survivor would
        # simply be reused by the next backfill. Deleting the accounts a connection synced into used to
        # strand one of these, and disconnecting afterwards (`connection_id` is ON DELETE SET NULL) left
        # it unreachable by every cleanup path that keys on the connection, showing up on Import/Export
        # as an empty card labelled "Data connection" for a source that no longer exists.
        #
        # A CSV card is deliberately not treated this way: it records a file the user supplied, which
        # remains true — and re-importable — after its rows are gone.
        if total_rows == 0 and batch["source_kind"] == SYNC_SOURCE_KIND and not _batch_has_duplicates(conn, batch_id):
            conn.execute("DELETE FROM import_batch WHERE id = ?", (batch_id,))
            continue

        conn.execute(
            "UPDATE import_batch SET row_count = ? WHERE id = ?",
            (total_rows, batch_id),
        )

        snapshot = safe_json_dict(batch["config_snapshot"])
        summary = snapshot.get(IMPORT_SUMMARY_KEY)
        if isinstance(summary, dict):
            summary["imported_count"] = imported_count
            summary["total_rows"] = total_rows
            snapshot[IMPORT_SUMMARY_KEY] = summary
            conn.execute(
                "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                (json.dumps(snapshot), batch_id),
            )


def _delete_account_and_import_history(conn, source_account_id: str):
    affected_batch_ids = {
        row["import_batch_id"]
        for row in conn.execute(
            """
            SELECT DISTINCT import_batch_id
            FROM txn
            WHERE account_id = ?
              AND import_batch_id IS NOT NULL
            """,
            (source_account_id,),
        ).fetchall()
        if row["import_batch_id"]
    }

    conn.execute("DELETE FROM txn WHERE account_id = ?", (source_account_id,))
    conn.execute("DELETE FROM category_rule WHERE account_id = ?", (source_account_id,))
    conn.execute("UPDATE csv_import_profile SET account_id = NULL WHERE account_id = ?", (source_account_id,))
    conn.execute(
        "DELETE FROM import_batch_account WHERE account_id = ? AND was_skipped = 0",
        (source_account_id,),
    )
    conn.execute(
        "UPDATE import_batch_account SET account_id = NULL WHERE account_id = ? AND was_skipped = 1",
        (source_account_id,),
    )
    _replace_account_reference_in_profile_column_maps(conn, source_account_id, "")
    _replace_account_reference_in_batch_snapshots(conn, source_account_id, "")
    _refresh_import_batch_summaries(conn, affected_batch_ids)
    conn.execute("DELETE FROM account WHERE id = ?", (source_account_id,))


def _finalize_trashed_account(conn, account_row):
    source_account_id = account_row["id"]
    target_account_id = account_row["parent_account_id"]
    if target_account_id:
        conn.execute(
            "UPDATE txn SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        conn.execute(
            "UPDATE category_rule SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        conn.execute(
            "UPDATE csv_import_profile SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        conn.execute(
            "UPDATE import_batch_account SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        _replace_account_reference_in_profile_column_maps(conn, source_account_id, target_account_id)
        _replace_account_reference_in_batch_snapshots(conn, source_account_id, target_account_id)
        conn.execute("DELETE FROM account WHERE id = ?", (source_account_id,))
    else:
        _delete_account_and_import_history(conn, source_account_id)


def resolve_default_owner_id(conn, owner_id: Optional[str]) -> Optional[str]:
    # New accounts only inherit an owner automatically when the choice is unambiguous.
    # Once a household has multiple personal owners, leaving the account unassigned is
    # safer than guessing and backfilling the wrong owner across imported history.
    explicit_owner_id = owner_id.strip() if owner_id else None
    if explicit_owner_id:
        owner = conn.execute("SELECT id FROM owner WHERE id = ?", (explicit_owner_id,)).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Owner not found")
        return explicit_owner_id

    owners = conn.execute(
        "SELECT id FROM owner WHERE LOWER(name) <> LOWER(?) ORDER BY name",
        (SHARED_OWNER_NAME,),
    ).fetchall()
    if len(owners) == 1:
        return owners[0]["id"]
    return None


def upsert_connection_accounts(conn, *, connection_id: str, provider: str,
                               institution: Optional[str], accounts: list[dict],
                               default_owner_id: Optional[str]) -> int:
    """Record the connection's provider accounts and re-apply whatever mapping they already carry.

    This does **not** create a local account per provider account. Connecting records what the bank
    offers (`connection_account`) and leaves the mapping decision to the user; only
    `apply_account_mapping` materializes accounts. That indirection is what lets a provider account be
    mapped onto an existing account, skipped, or declared an alias — and the alias is what the dedupe
    ladder's cross-account rules need (see `services/connection_mapping.py`).

    Shared by the initial connect (token exchange) and the standalone "Refresh accounts" recovery: a
    restore rolls back the ledger — including account rows — but never the live connection (see
    import_export/backup.py), leaving a connection whose accounts are gone. Refresh re-records the
    provider list and re-applies the surviving mapping decisions, rebuilding the accounts from the
    still-valid credential without a re-link. Re-application is idempotent — an account already linked
    to a handle is adopted, never duplicated — and never touches the user-editable
    name/display_name/owner/type. Returns the number of provider accounts processed.
    """
    record_provider_accounts(conn, connection_id=connection_id, accounts=accounts)
    decided = {
        r["external_account_id"]: {
            "mode": r["mapping_mode"],
            "target_account_id": r["target_account_id"],
        }
        for r in conn.execute(
            "SELECT * FROM connection_account WHERE connection_id = ? AND mapping_mode IS NOT NULL",
            (connection_id,),
        ).fetchall()
    }
    if decided:
        apply_account_mapping(
            conn, connection_id=connection_id, provider=provider, institution=institution,
            mappings=decided, default_owner_id=default_owner_id,
        )
    return len(accounts)


@router.get("")
def list_accounts(include_children: bool = False, include_trashed: bool = False):
    with get_db() as conn:
        rows = _list_account_rows(conn, include_children=include_children, include_trashed=include_trashed)
        accounts = _attach_account_tags(conn, [_serialize_account(r) for r in rows])
    return accounts


@router.get("/trash")
def list_trashed_accounts():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                a.id,
                a.name,
                a.display_name,
                a.type,
                a.owner_id,
                a.parent_account_id,
                a.trashed_at,
                p.name AS parent_name,
                p.display_name AS parent_display_name,
                o.name AS owner_name
            FROM account a
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN owner o ON o.id = a.owner_id
            WHERE a.trashed_at IS NOT NULL
            ORDER BY a.trashed_at DESC, LOWER(a.name), a.id
            """
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_account(body: AccountCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Account name is required")

    account_type = (body.type or "other").strip() or "other"
    with get_db() as conn:
        owner_id = resolve_default_owner_id(conn, body.owner_id)

        account_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO account
                (id, external_account_id, connection_id, provider, name, display_name, institution, type, subtype, mask, owner_id, parent_account_id, trashed_at)
            VALUES (?, NULL, NULL, 'manual', ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL)
            """,
            (account_id, name, name, account_type, owner_id),
        )
        row = _get_account_row(conn, account_id)
    return _serialize_account(row)


@router.patch("/{account_id}")
def update_account(account_id: str, body: AccountUpdate):
    with get_db() as conn:
        acc = _get_account_row(conn, account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")

        has_children = _get_child_count(conn, account_id) > 0
        grouped = bool(acc["parent_account_id"]) or has_children

        if body.name is not None and body.name.strip():
            next_name = body.name.strip()
            conn.execute(
                "UPDATE account SET name = ? WHERE id = ?",
                (next_name, account_id),
            )
            if not acc["parent_account_id"]:
                _set_root_display_name(conn, account_id, next_name)

        if body.type is not None and body.type.strip():
            if grouped:
                raise HTTPException(status_code=400, detail="Ungroup this account before changing its type")
            conn.execute(
                "UPDATE account SET type = ? WHERE id = ?",
                (body.type.strip(), account_id),
            )

        if body.owner_id is not None:
            owner_val = _assert_owner_exists(conn, body.owner_id if body.owner_id != "" else None)
            conn.execute(
                "UPDATE account SET owner_id = ? WHERE id = ?",
                (owner_val, account_id),
            )
            # Account ownership is the default source of truth for imported rows, so
            # historical transactions stay aligned when the account owner changes.
            conn.execute(
                "UPDATE txn SET owner_id = ? WHERE account_id = ?",
                (owner_val, account_id),
            )
    return {"ok": True}


# Account tag attachments. Mirrors the category tag endpoints: tags applied to an account
# propagate to its transactions, resolved through the effective (top-level) account (see
# services/transaction_tags.py and _append_tag_filter). The list shape mirrors the transaction
# tag pill UI so the same component can render it.
@router.get("/{account_id}/tags")
def list_account_tags(account_id: str):
    with get_db() as conn:
        acc = conn.execute("SELECT id FROM account WHERE id = ?", (account_id,)).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        rows = conn.execute(
            """
            SELECT g.id, g.name, g.color
            FROM account_tag at
            JOIN tag g ON g.id = at.tag_id
            WHERE at.account_id = ?
            ORDER BY g.sort_order, LOWER(g.name), g.name, g.id
            """,
            (account_id,),
        ).fetchall()
    return [dict(r) for r in rows]


# Explains an account with little/no visible activity: how many of its imported rows were skipped or
# removed as duplicates of transactions already present, and on which accounts/source files those live.
# The account-detail panel surfaces this and deep-links into the duplicate report scoped to the account.
@router.get("/{account_id}/duplicate-summary")
def get_account_duplicate_summary(account_id: str):
    with get_db() as conn:
        acc = conn.execute("SELECT id FROM account WHERE id = ?", (account_id,)).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        return account_skipped_duplicate_summary(conn, account_id)


@router.put("/{account_id}/tags")
def set_account_tags(account_id: str, body: AccountTagsUpdate):
    cleaned = [str(tag_id).strip() for tag_id in body.tag_ids if tag_id and str(tag_id).strip()]
    with get_db() as conn:
        acc = conn.execute("SELECT id FROM account WHERE id = ?", (account_id,)).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        if cleaned:
            placeholders = ",".join("?" * len(cleaned))
            valid_ids = {row["id"] for row in conn.execute(f"SELECT id FROM tag WHERE id IN ({placeholders})", cleaned).fetchall()}
        else:
            valid_ids = set()
        conn.execute("DELETE FROM account_tag WHERE account_id = ?", (account_id,))
        for tag_id in valid_ids:
            conn.execute(
                "INSERT OR IGNORE INTO account_tag (account_id, tag_id) VALUES (?, ?)",
                (account_id, tag_id),
            )
    return {"ok": True}


# Distinct-account-pair assertions: the user's explicit "these two accounts are different
# physical accounts" decisions, recorded via Keep on a cross-account soft-flag suspect. The
# `account_pair_distinct` table is read here for the management UI and written by the dedupe
# service when the user clicks Keep. See `backend/services/duplicate_detection.py` for the
# detection-side logic and the design rationale.
@router.get("/distinct-pairs")
def list_distinct_account_pairs_endpoint():
    with get_db() as conn:
        return {"pairs": list_distinct_account_pairs(conn)}


@router.delete("/distinct-pairs/{account_id_a}/{account_id_b}")
def forget_distinct_account_pair(account_id_a: str, account_id_b: str):
    """Forget a recorded distinct-account assertion. Future imports touching both accounts will
    re-evaluate cross-account matches between them as normal; any matches that previously got
    suppressed by this assertion will resurface as soft-flag suspects again."""
    with get_db() as conn:
        return forget_account_pair_distinct(conn, account_id_a, account_id_b)


@router.post("/{account_id}/attach")
def attach_account(account_id: str, body: AccountAttachRequest):
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        parent = _get_account_row(conn, body.parent_account_id)
        if not account or not parent:
            raise HTTPException(status_code=404, detail="Account not found")
        if account["trashed_at"] or parent["trashed_at"]:
            raise HTTPException(status_code=400, detail="Restore trashed accounts before regrouping them")
        if account["id"] == parent["id"]:
            raise HTTPException(status_code=400, detail="An account cannot be merged into itself")
        if parent["parent_account_id"]:
            raise HTTPException(status_code=400, detail="Only top-level accounts can accept merged children")

        # Owners are compatible if they match exactly, or if either account belongs to the shared owner.
        source_owner = (account["owner_id"] or "").strip()
        parent_owner = (parent["owner_id"] or "").strip()
        owners_compatible = (
            source_owner == parent_owner
            or source_owner == SHARED_OWNER_ID
            or parent_owner == SHARED_OWNER_ID
        )
        if not owners_compatible:
            raise HTTPException(status_code=400, detail="Only accounts with the same owner can be merged")
        if _normalize_match_value(account["type"]) != _normalize_match_value(parent["type"]):
            raise HTTPException(status_code=400, detail="Only accounts with the same type can be merged")

        group_member_ids = _list_group_member_ids(conn, account["id"])
        if parent["id"] in group_member_ids:
            raise HTTPException(status_code=400, detail="An account group cannot be merged into itself")

        target_display_name = parent["display_name"] or parent["name"]
        conn.executemany(
            "UPDATE account SET parent_account_id = ?, display_name = ? WHERE id = ?",
            [(parent["id"], target_display_name, member_id) for member_id in group_member_ids],
        )
        # On merge we have three responsibilities:
        #   1. Fresh-scan the newly-unified group for cross-account duplicates that were never compared at
        #      import time (existing-vs-existing) — e.g. a pre-existing synced row that ran no detection.
        #      This soft-flags them so step 2 can graduate them alongside any pre-existing soft-flags.
        #   2. Promote any in-group soft-flag (fresh or pre-existing) whose two sides now share an effective
        #      root to a confirmed duplicate. The merge is the user's assertion that the two accounts are the
        #      same physical account; a same (date, amount, payee) match across them is the same case that
        #      exact_hash_linked_group would have hard-rejected at import time.
        #   3. Delete any `account_pair_distinct` rows between the merging accounts. The user may have
        #      previously asserted these accounts were distinct; the merge contradicts that, so it wins.
        affected_ids = group_member_ids + [parent["id"]]
        scan_scope_for_cross_account_duplicates(conn, affected_ids)
        promote_in_group_suspects_to_confirmed(conn, affected_ids)
        clear_account_pair_distinct_for_merge(conn, affected_ids)
    return {"ok": True}


@router.post("/{account_id}/detach")
def detach_account(account_id: str):
    """Detach an account from its parent group. Two things happen:

    1. The account itself: parent_account_id cleared, display_name reset to its own name,
       trashed_at cleared (a previously soft-deleted child can come back live on detach).
    2. Dedupe state: any confirmed_duplicate rows on the detaching account that were
       auto-promoted by the original merge (dedupe_resolved_by='auto_merge') and that point at
       canonical rows on accounts still in the now-shrunk group are restored to active-suspect
       state. Rows the user explicitly Rejected (dedupe_resolved_by='user') are left alone —
       the user's deliberate decision survives the un-merge.

    Cross-account soft-flags (not auto-promoted, still active suspects) are untouched by detach
    — they reflect import-time facts, not group membership.
    """
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        # Capture the remaining-group accounts BEFORE clearing parent_account_id, so we know
        # which canonicals the auto-promoted rows on the detaching account were promoted
        # against. Group = parent + all of parent's children except the one being detached.
        remaining_group_ids: list[str] = []
        parent_id = account["parent_account_id"]
        if parent_id:
            remaining_group_ids.append(parent_id)
            sibling_rows = conn.execute(
                "SELECT id FROM account WHERE parent_account_id = ? AND id != ?",
                (parent_id, account_id),
            ).fetchall()
            remaining_group_ids.extend(str(row["id"]) for row in sibling_rows)
        conn.execute(
            "UPDATE account SET parent_account_id = NULL, display_name = name, trashed_at = NULL WHERE id = ?",
            (account_id,),
        )
        restored = restore_auto_merged_after_detach(conn, account_id, remaining_group_ids)
    return {"ok": True, "restored_count": restored}


@router.post("/{account_id}/trash")
def trash_account(account_id: str):
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        if account["trashed_at"]:
            return {"ok": True}
        if not account["parent_account_id"]:
            raise HTTPException(status_code=400, detail="Only merged child accounts can be sent to trash")
        conn.execute(
            "UPDATE account SET trashed_at = ? WHERE id = ?",
            (utcnow_iso(), account_id),
        )
    return {"ok": True}


@router.post("/{account_id}/restore")
def restore_account(account_id: str):
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        if not account["trashed_at"]:
            return {"ok": True}

        if account["parent_account_id"]:
            parent = _get_account_row(conn, account["parent_account_id"])
            if parent and not parent["trashed_at"]:
                conn.execute(
                    "UPDATE account SET trashed_at = NULL, display_name = ? WHERE id = ?",
                    (parent["display_name"] or parent["name"], account_id),
                )
                return {"ok": True}

        conn.execute(
            "UPDATE account SET parent_account_id = NULL, display_name = name, trashed_at = NULL WHERE id = ?",
            (account_id,),
        )
    return {"ok": True}


@router.post("/trash/empty")
def empty_account_trash():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, parent_account_id
            FROM account
            WHERE trashed_at IS NOT NULL
            ORDER BY trashed_at ASC, id ASC
            """
        ).fetchall()
        for row in rows:
            _finalize_trashed_account(conn, row)
    return {"ok": True, "emptied": len(rows)}


@router.delete("/{account_id}")
def delete_account(account_id: str):
    with get_db() as conn:
        acc = _get_account_row(conn, account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        if _get_child_count(conn, account_id) > 0:
            raise HTTPException(status_code=400, detail="Ungroup or trash child accounts before deleting this account")
        _delete_account_and_import_history(conn, account_id)
    return {"ok": True}
