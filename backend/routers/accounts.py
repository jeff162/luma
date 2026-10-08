# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Account records serve two related lifecycle models.

- Active root accounts are the selectable/reportable physical accounts the rest of the app works with.
- Child accounts keep historical account numbers visible on the Accounts page while sharing a parent display name elsewhere.
- Removing an account is irreversible and says so; what it asks instead is where its transactions go (`delete_account`).
  `account.trashed_at` survives as a column — old backups carry it and the read paths still honour it — but nothing
  sets it any more: the account trash was retired once removal moved behind a deliberate menu (`ui-patterns.md`).

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

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import SHARED_OWNER_NAME, SHARED_OWNER_ID, get_db
from backend.services.connection_mapping import apply_account_mapping, record_provider_accounts
from backend.services.duplicate_detection import (
    account_skipped_duplicate_summary,
    clear_account_pair_distinct_for_merge,
    forget_account_pair_distinct,
    forget_suspect_pair_distinct,
    list_suspect_pair_distinct,
    maybe_rescan_for_detection_change,
    reopen_suspect_pair,
    list_distinct_account_pairs,
    promote_in_group_suspects_to_confirmed,
    record_account_pair_distinct,
    restore_auto_merged_after_detach,
    scan_scope_for_cross_account_duplicates,
)
from backend.services.account_references import (
    discard_account_references,
    reassign_account_references,
    replace_account_reference_in_batch_snapshots,
    replace_account_reference_in_profile_column_maps,
)
from backend.services.import_batch_totals import delete_transactions

router = APIRouter()


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


class DistinctPairRequest(BaseModel):
    account_id_a: str
    account_id_b: str


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


def _delete_account_and_import_history(conn, source_account_id: str):
    # Through the shared delete so each card these rows came from is kept true: the rows come off the
    # per-account entries that counted them (which may name another account, for a row moved since it
    # arrived) and the cards' totals are re-derived, dropping a sync card left with nothing.
    delete_transactions(conn, "account_id = ?", (source_account_id,))
    conn.execute(
        "DELETE FROM import_batch_account WHERE account_id = ? AND was_skipped = 0",
        (source_account_id,),
    )
    conn.execute(
        "UPDATE import_batch_account SET account_id = NULL WHERE account_id = ? AND was_skipped = 1",
        (source_account_id,),
    )
    # Everything else that named the account, by its declared disposition — rules and series removed,
    # write targets and mapping decisions released. Without this the foreign keys decide, and two of
    # them decide wrongly (see services/account_references.py).
    discard_account_references(conn, source_account_id)
    # None, not "": the reference is removed rather than blanked, so a saved source carries no entry
    # that every reader has to treat as absent anyway (`services/account_references.py`).
    replace_account_reference_in_profile_column_maps(conn, source_account_id, None)
    replace_account_reference_in_batch_snapshots(conn, source_account_id, None)
    conn.execute("DELETE FROM account WHERE id = ?", (source_account_id,))


def _reassign_account_and_delete(conn, source_account_id: str, target_account_id: str):
    """Hand the source's transactions and every reference that names it to the target, then remove it."""
    reassign_account_references(conn, source_account_id, target_account_id)
    conn.execute("DELETE FROM account WHERE id = ?", (source_account_id,))


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


# Distinct-account-pair assertions: the user's explicit "these two accounts are different physical
# accounts" decisions. Made in exactly two places, and both ask it as a question about *accounts*: the
# "Possible duplicate account?" chooser at mapping time (Keep separate), and the duplicate report's
# prompt after resolving flags between one pair. It used to be a side effect of clicking Keep on a
# transaction row, which is why it could be made without the user knowing an account-level decision was
# being taken. See `backend/services/duplicate_detection.py` for the detection-side logic.
@router.get("/distinct-pairs")
def list_distinct_account_pairs_endpoint():
    with get_db() as conn:
        return {"pairs": list_distinct_account_pairs(conn)}


@router.post("/distinct-pairs")
def assert_distinct_account_pair(body: DistinctPairRequest):
    """Record "these two accounts are different physical accounts", and clear the cross-account flags
    the assertion has just made meaningless.

    The counterpart of merging the two accounts, and the report offers them as the two answers to one
    question. Refused for a same-account pair, which would switch detection off for that account for
    good."""
    with get_db() as conn:
        result = record_account_pair_distinct(conn, body.account_id_a, body.account_id_b)
    if not result.get("recorded"):
        raise HTTPException(status_code=400, detail="Two different accounts are needed to assert a pair")
    return result


@router.post("/duplicate-rescan")
def rescan_duplicates_for_detection_change():
    """App-load catch-up for a matcher that has since improved: re-scan every account once when this
    database was last examined under older matching rules, then stamp the current version.

    A no-op on every load but the first after a rule change, so it is safe to call unconditionally. Pairs
    the user has already judged are skipped, so a bump surfaces what was never examined without re-asking
    anything that was."""
    with get_db() as conn:
        return maybe_rescan_for_detection_change(conn)


class ReopenPairsRequest(BaseModel):
    pairs: list[list[str]]


@router.get("/duplicate-pairs")
def list_distinct_transaction_pairs():
    """The pairs the user has judged "not the same charge", newest first — the row-level counterpart of
    the distinct-account list, and inspectable for the same reason: it is a durable decision made in
    passing that nothing else on screen reveals."""
    with get_db() as conn:
        return {"pairs": list_suspect_pair_distinct(conn)}


@router.post("/duplicate-pairs/reopen")
def reopen_distinct_transaction_pairs(body: ReopenPairsRequest):
    """Undo one or more Keeps: forget each judgement and put its finding back.

    Takes a list because a bulk Keep is one action to the user and its Undo has to be one too — undoing
    N judgements as N requests would let a partial failure leave half the operation reversed with nothing
    saying which half."""
    results = []
    with get_db() as conn:
        for pair in body.pairs:
            if len(pair) != 2:
                raise HTTPException(status_code=400, detail="Each pair needs exactly two transaction ids")
            results.append(reopen_suspect_pair(conn, pair[0], pair[1]))
    return {"reopened": sum(1 for r in results if r.get("reopened")), "results": results}


@router.delete("/duplicate-pairs/{txn_id_a}/{txn_id_b}")
def forget_distinct_transaction_pair(txn_id_a: str, txn_id_b: str):
    """Forget one "these two rows are not the same charge" judgement, so detection may raise the pair
    again. The row-level counterpart of forgetting a distinct-account assertion, and the escape hatch for
    a misclick — the judgement is otherwise permanent, which is the point of recording it."""
    with get_db() as conn:
        return forget_suspect_pair_distinct(conn, txn_id_a, txn_id_b)


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


# What becomes of the account's transactions. There is no third answer: `txn.account_id` is NOT NULL,
# so the rows either move to an account the caller names or they are deleted with the account.
TRANSACTION_DISPOSITIONS = ("reassign", "delete")


@router.delete("/{account_id}")
def delete_account(account_id: str, transactions: Optional[str] = None,
                   target_account_id: Optional[str] = None):
    """Remove an account, having been told what to do with its transactions.

    `transactions` is **required once the account holds any**, and that is the point of the parameter
    rather than a validation detail: the disposition used to be implicit, and the implicit answer was
    `delete` — so removing an account silently destroyed its history with nothing to restore from. An
    account holding nothing needs no question, which is also why the parameter stays optional rather
    than becoming mandatory for every caller.

    `reassign` moves the rows, and every other reference that named this account, onto
    `target_account_id` (`services/account_references.py`); `delete` removes them.

    **Every answer here is permanent, and the protection is the path rather than an undo.** Once the
    rows have moved, nothing distinguishes them from the ones already on the target, so unwinding would
    need a per-row record of what moved — an unbounded one, which `scale-and-limits.md` rules out. An
    account trash was tried and retired for the same reason: it could only defer the move, leaving the
    dialog promising a reassignment the ledger went on contradicting until someone emptied it. So the
    accident is prevented at the point of action instead — removal lives behind the row's ⋯ menu, not a
    one-press ×.
    """
    with get_db() as conn:
        acc = _get_account_row(conn, account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        if _get_child_count(conn, account_id) > 0:
            # Deliberately not offered as a disposition in the dialog: removing a group root means
            # promoting one of its members in its place, which moves the group's dedupe scope and
            # reverses the merge's duplicate promotions (see `restore_auto_merged_after_detach`). That
            # is a separate decision about which account is the real one, not a question about where
            # these transactions go. The message says what the children's own removal does, because the
            # order of operations is otherwise only discoverable by trying it.
            raise HTTPException(
                status_code=400,
                detail="Remove or ungroup the merged child accounts first. Removing a child offers this "
                       "account as the place to keep its transactions.",
            )
        transaction_count = int(acc["transaction_count"] or 0)
        disposition = (transactions or "").strip().lower() or None
        if disposition is not None and disposition not in TRANSACTION_DISPOSITIONS:
            raise HTTPException(
                status_code=400,
                detail=f"transactions must be one of: {', '.join(TRANSACTION_DISPOSITIONS)}",
            )
        if disposition is None:
            if transaction_count:
                raise HTTPException(
                    status_code=400,
                    detail=f"This account holds {transaction_count} transaction(s); say what to do with "
                           f"them ({' or '.join(TRANSACTION_DISPOSITIONS)}).",
                )
            disposition = "delete"

        if disposition == "reassign":
            target_id = (target_account_id or "").strip()
            if not target_id:
                raise HTTPException(status_code=400, detail="target_account_id is required to reassign")
            if target_id == account_id:
                raise HTTPException(status_code=400, detail="Pick a different account to reassign to")
            target = _get_account_row(conn, target_id)
            if not target:
                raise HTTPException(status_code=404, detail="Target account not found")
            if target["trashed_at"]:
                raise HTTPException(status_code=400, detail="Target account is in the trash")
            _reassign_account_and_delete(conn, account_id, target_id)
            return {"ok": True, "reassigned": transaction_count, "target_account_id": target_id}

        _delete_account_and_import_history(conn, account_id)
    return {"ok": True, "deleted": transaction_count}
