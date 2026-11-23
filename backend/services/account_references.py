# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What happens to everything that named an account once that account goes away.

Removing an account is two questions, and only one of them is about the account row: where its
*transactions* go, and what becomes of every other record that pointed at it. `txn.account_id` is NOT
NULL, so a transaction without an account does not exist — the rows either follow an account the user
nominates or they are deleted with it, and both paths have to carry the rest of the references with
them.

**Why a declared table rather than a hand-written run of UPDATEs.** The reassignment already existed
for one path — emptying the account trash folds a merged child into its parent — and moved five of the
account's references while the schema has thirteen. The remainder were left to their foreign keys,
which is silent, and in two places wrong:

- `recurring_series.account_id` is `ON DELETE SET NULL`, and a NULL account scope is not a narrow scope
  but *no* scope: `services/recurring_detection.py` skips the account test entirely when it is NULL, so
  a series the user pinned to one card quietly began claiming rows on every account in the ledger.
- `amazon_funding_map` is `ON DELETE CASCADE`, so the instrument->account mapping was destroyed rather
  than following the history it describes.

Declaring a disposition per reference and deriving the statements from the declaration is what makes a
*missing* one a test failure rather than a behaviour nobody notices;
`tests/test_account_reference_disposition.py` asserts this table covers every foreign key into
`account(id)`. It is the deletion-time counterpart to `ACCOUNT_REFERENCE_KINDS` in
`tests/test_account_group_references.py`, which classifies the same references for the *merge*
question — a merge leaves them all in place and changes what they resolve to, where a removal has to
move or release each one.

Two account references are not foreign keys and so cannot be derived from the schema: the per-value
account map inside `csv_import_profile.column_map` and the `import_batch.config_snapshot` of a past
import. They are rewritten alongside, by the two helpers at the end.
"""

import json
from dataclasses import dataclass
from typing import Optional

from backend.services.recurring_detection import owe_full_recurring_scan

# What to do with a reference when its account is removed.
#
# FOLLOW    - re-point it at the account taking the history over. These are the references whose
#             meaning survives the move: a matching scope, a write target, a stored map.
# CLEAR     - release it (set NULL) rather than move it, because moving it would hand a decision to an
#             account the user never made that decision about.
# DELETE_ROW- the record cannot mean anything once the account is gone, and leaving it behind would
#             widen what it matches rather than narrow it.
# CASCADE   - the row is a statement *about this account row*, so it has nothing left to say; its
#             foreign key already removes it. Declared rather than executed, so the decision is on the
#             record and the guard can see it was made.
# CALLER    - handled by the caller because it needs more than one statement (the transactions
#             themselves, whose deletion also has to keep each import card's totals true).
# STRUCTURAL- the grouping relation itself, resolved before any of this runs.
FOLLOW = "follow"
CLEAR = "clear"
DELETE_ROW = "delete_row"
CASCADE = "cascade"
CALLER = "caller"
STRUCTURAL = "structural"


@dataclass(frozen=True)
class AccountReference:
    table: str
    column: str
    on_reassign: str
    on_delete: str


ACCOUNT_REFERENCES: tuple[AccountReference, ...] = (
    # The grouping relation. Attach/detach/trash own it; a removal has already resolved the group.
    AccountReference("account", "parent_account_id", STRUCTURAL, STRUCTURAL),

    # The transactions. On a reassign a plain re-point; on a delete they go through the shared
    # `delete_transactions` so every import card they came off stops counting them.
    AccountReference("txn", "account_id", FOLLOW, CALLER),

    # Matching scopes: each names a set of transactions, so it follows the transactions.
    AccountReference("category_rule", "account_id", FOLLOW, DELETE_ROW),
    # A series scoped to a removed account has no members left, and clearing the column would make it
    # ledger-wide instead of dead - see the module docstring.
    AccountReference("recurring_series", "account_id", FOLLOW, DELETE_ROW),
    # The far account of a two-legged movement, for the same reason the near one follows: pairing
    # compares it against the row side's resolved account, and a movement missing one side is not one.
    AccountReference("recurring_series", "counterpart_account_id", FOLLOW, DELETE_ROW),
    # Dedupe coverage per imported file. Follows so the coverage claim keeps applying to the account
    # that now holds the rows it describes.
    AccountReference("import_batch_account", "account_id", FOLLOW, CALLER),
    # The Amazon instrument -> paying account map, and its per-Amazon-account override.
    AccountReference("amazon_funding_map", "funding_account_id", FOLLOW, CASCADE),
    AccountReference("amazon_funding_map", "amazon_account_id", FOLLOW, CASCADE),

    # A data source's write target: where this file's rows land next time. Follows, so a saved profile
    # keeps importing into the account that holds its history.
    AccountReference("csv_import_profile", "account_id", FOLLOW, CLEAR),

    # A connection's mapping decision. Deliberately *not* moved: `account.external_account_id` is
    # UNIQUE, so one provider handle belongs to one account, and silently re-pointing the handle at
    # whichever account inherited the history would start feeding an account the user never mapped it
    # to. Released instead, which is a state the mapping UI already has a reading for - "pulled but
    # undecided" - and the next connection-settings visit asks again. `mapping_mode` is cleared with
    # them (see `release_connection_mapping`), because a mode left set with no target is a decision
    # pointing at nothing: `apply_account_mapping` skips it and "Refresh accounts" cannot re-apply it.
    AccountReference("connection_account", "account_id", CLEAR, CLEAR),
    AccountReference("connection_account", "target_account_id", CLEAR, CLEAR),

    # Statements about the account row itself, with nothing left to say once it is gone.
    AccountReference("account_tag", "account_id", CASCADE, CASCADE),
    # A balance describes one physical account, so the account taking the history has its own.
    AccountReference("account_balance", "account_id", CASCADE, CASCADE),
    AccountReference("account_pair_distinct", "account_id_low", CASCADE, CASCADE),
    AccountReference("account_pair_distinct", "account_id_high", CASCADE, CASCADE),
)


# The mapping table is cleared as a unit rather than column by column, because `mapping_mode` has to go
# with the two ids and is not an account reference at all. Named once so the generic CLEAR walk can skip
# exactly what `release_connection_mapping` owns.
_MAPPING_TABLE = "connection_account"


def _references_with(disposition: str, *, on: str) -> tuple[AccountReference, ...]:
    return tuple(r for r in ACCOUNT_REFERENCES if getattr(r, on) == disposition)


def _clear_references(conn, source_account_id: str, *, on: str) -> None:
    for reference in _references_with(CLEAR, on=on):
        if reference.table == _MAPPING_TABLE:
            continue
        conn.execute(
            f"UPDATE {reference.table} SET {reference.column} = NULL WHERE {reference.column} = ?",
            (source_account_id,),
        )
    release_connection_mapping(conn, source_account_id)


def _repoint(conn, reference: AccountReference, source_account_id: str, target_account_id: str) -> None:
    # The table and column come from ACCOUNT_REFERENCES, never from a request, so interpolating them is
    # not a parameterization gap - the two *values* are bound.
    conn.execute(
        f"UPDATE {reference.table} SET {reference.column} = ? WHERE {reference.column} = ?",
        (target_account_id, source_account_id),
    )


def _drop_colliding_amazon_overrides(conn, source_account_id: str, target_account_id: str) -> None:
    """Make room for the Amazon override rows about to be re-pointed at the target.

    `amazon_funding_map` carries a unique index per instrument per scope
    (`idx_amazon_funding_override` on last4 + network + amazon_account_id), so moving the source's
    override rows onto the target trips it wherever the target already has a row for the same
    instrument. The target's own row is the one the user set against the account that survives, so the
    source's duplicate is dropped rather than overwriting it.
    """
    conn.execute(
        """
        DELETE FROM amazon_funding_map
        WHERE  amazon_account_id = ?
          AND  EXISTS (
                 SELECT 1 FROM amazon_funding_map other
                 WHERE  other.amazon_account_id = ?
                   AND  other.last4 = amazon_funding_map.last4
                   AND  COALESCE(other.network, '') = COALESCE(amazon_funding_map.network, '')
               )
        """,
        (source_account_id, target_account_id),
    )


def release_connection_mapping(conn, source_account_id: str) -> None:
    """Return every provider account that fed this account to "pulled but undecided".

    Both columns are released and `mapping_mode` with them. The foreign keys would null the two ids on
    their own, but not the mode, and a mode set with no target is worse than no mode at all - it reads
    as decided while `apply_account_mapping` skips it, so neither a sync nor "Refresh accounts" can act
    on it and nothing on screen says why.
    """
    conn.execute(
        f"""
        UPDATE {_MAPPING_TABLE}
        SET    account_id = NULL, target_account_id = NULL, mapping_mode = NULL
        WHERE  account_id = ? OR target_account_id = ?
        """,
        (source_account_id, source_account_id),
    )


def reassign_account_references(conn, source_account_id: str, target_account_id: str) -> None:
    """Hand everything the source account held over to the target, short of the account row itself.

    Used by deleting an account with its transactions reassigned. The rows change account, which recurring
    detection reads as a series' account scope and as the test that a movement runs between two accounts,
    so the move owes a full recurring scan, settled by the caller after commit.
    """
    owe_full_recurring_scan(conn)
    _drop_colliding_amazon_overrides(conn, source_account_id, target_account_id)
    for reference in _references_with(FOLLOW, on="on_reassign"):
        _repoint(conn, reference, source_account_id, target_account_id)
    _clear_references(conn, source_account_id, on="on_reassign")
    replace_account_reference_in_profile_column_maps(conn, source_account_id, target_account_id)
    replace_account_reference_in_batch_snapshots(conn, source_account_id, target_account_id)
    # Keys that embed the source as its group's root are text, not references, so the loop above cannot see
    # them; they take the target's root, as a merged group's do (`services/group_root_change.py`). Imported
    # here: that module reaches this one through `recurring_detection`.
    from backend.services.account_groups import effective_account_id
    from backend.services.group_root_change import move_series_keys
    move_series_keys(conn, source_account_id, effective_account_id(conn, target_account_id))


def discard_account_references(conn, source_account_id: str) -> None:
    """Release or remove everything that named the account, for the path that deletes its transactions.

    The transactions and their import-card entries are the caller's (`CALLER` above): they need the
    shared delete, which keeps each card's counts true. Everything here is what would otherwise be left
    to a foreign key that either nulls a matching scope into a ledger-wide one or says nothing at all.
    """
    for reference in _references_with(DELETE_ROW, on="on_delete"):
        conn.execute(
            f"DELETE FROM {reference.table} WHERE {reference.column} = ?",
            (source_account_id,),
        )
    _clear_references(conn, source_account_id, on="on_delete")


def replace_account_reference_in_profile_column_maps(conn, source_account_id: str,
                                                     target_account_id: Optional[str]):
    """Re-point a saved import profile's per-value account map, which is JSON rather than a column.

    `target_account_id` None **removes** the entry rather than blanking it, and removes
    `account_assignments` itself once nothing is left in it — which is what the import screen writes
    when a map empties out (`ImportExport.jsx`, "else delete cm.account_assignments"), so a profile
    rewritten here is shaped like one the user saved.
    """
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
            if account_id != source_account_id:
                next_assignments[csv_value] = account_id
                continue
            changed = True
            if target_account_id is not None:
                next_assignments[csv_value] = target_account_id
        if changed:
            if next_assignments:
                column_map["account_assignments"] = next_assignments
            else:
                column_map.pop("account_assignments", None)
            conn.execute(
                "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
                (json.dumps(column_map), row["id"]),
            )


def replace_account_reference_in_batch_snapshots(conn, source_account_id: str,
                                                 target_account_id: Optional[str]):
    """Re-point the account ids recorded in a past import's config snapshot.

    `target_account_id` None removes each reference, on the same reasoning as the profile map above: a
    snapshot is replayed through the import screen's restore path, which reads a key that is present
    and empty exactly as it reads an absent one, so leaving a blank behind would be a value nothing can
    act on and nothing will ever clear.
    """
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
            if target_account_id is None:
                snapshot.pop("account_id", None)
            else:
                snapshot["account_id"] = target_account_id
            changed = True
        account_map = snapshot.get("account_map")
        if isinstance(account_map, dict):
            next_account_map = {}
            map_changed = False
            for csv_value, account_id in account_map.items():
                if account_id != source_account_id:
                    next_account_map[csv_value] = account_id
                    continue
                map_changed = True
                if target_account_id is not None:
                    next_account_map[csv_value] = target_account_id
            if map_changed:
                if next_account_map:
                    snapshot["account_map"] = next_account_map
                else:
                    snapshot.pop("account_map", None)
                changed = True

        if changed:
            conn.execute(
                "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                (json.dumps(snapshot), row["id"]),
            )


__all__ = [
    "ACCOUNT_REFERENCES",
    "AccountReference",
    "CALLER",
    "CASCADE",
    "CLEAR",
    "DELETE_ROW",
    "FOLLOW",
    "STRUCTURAL",
    "discard_account_references",
    "reassign_account_references",
    "release_connection_mapping",
    "replace_account_reference_in_batch_snapshots",
    "replace_account_reference_in_profile_column_maps",
]
