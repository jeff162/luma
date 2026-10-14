# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The stored rule-suggestion review, as far as anything outside the import router has to know it.

A review lives in three containers: a batch's `config_snapshot`, a data source's `column_map`, and the
system workflow state. Each holds `suggestions` (id → entry), `statuses` (id → the decision taken on it)
and `trash_sets`, cleared batches of both. An entry names the transactions it was built from in
`source_row_ids`; its count, its matching-rows report and its undo all work from those ids.

**A deleted transaction leaves every entry that named it**, in the same write as the delete
(`release_rule_suggestion_rows`). An entry left with no rows is removed with its decision: its report
would be empty and its undo would revert nothing, while the rule an accepted entry created stands on its
own on the Rules page. Trashing is not deletion, so a trashed row keeps its place until the trash is
emptied.
"""

from __future__ import annotations

import json
from typing import Callable, Iterable

RULE_SUGGESTION_REVIEW_KEY = "rule_suggestion_review"
SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY = "system_rule_suggestion_review"

# Bound on the ids in one `IN (...)` lookup.
_ID_CHUNK = 500


def summarize_rule_suggestion_review(review_state: dict) -> dict:
    suggestions = review_state.get("suggestions") or {}
    statuses = review_state.get("statuses") or {}

    accepted_count = 0
    skipped_count = 0
    discarded_count = 0
    pending_count = 0

    for suggestion_id in suggestions:
        status = (statuses.get(suggestion_id) or {}).get("status")
        if status == "accepted":
            accepted_count += 1
        elif status == "discarded":
            discarded_count += 1
        elif status == "skipped":
            skipped_count += 1
        else:
            pending_count += 1

    summary = {
        "total_count": len(suggestions),
        "reviewed_count": accepted_count + skipped_count + discarded_count,
        "discarded_count": discarded_count,
        "accepted_count": accepted_count,
        "skipped_count": skipped_count,
        "pending_count": pending_count,
        "trash_set_count": len(review_state.get("trash_sets") or []),
    }
    review_state["summary"] = summary
    return summary


def _prune_entries(suggestions: dict, statuses: dict, is_gone: Callable[[str], bool]) -> bool:
    """Drop gone ids from each entry in one `suggestions`/`statuses` pair, removing an entry left empty.
    The counts move with the ids: an entry's `txn_count`, and `conflict_group_total_rows` on every entry
    of a conflict group that lost rows, since that total is the sum of its members."""
    changed = False
    removed_by_group: dict[str, int] = {}
    for suggestion_id, entry in list(suggestions.items()):
        if not isinstance(entry, dict):
            continue
        row_ids = [str(row_id) for row_id in (entry.get("source_row_ids") or [])]
        kept = [row_id for row_id in row_ids if not is_gone(row_id)]
        if len(kept) == len(row_ids):
            continue
        changed = True
        removed = len(row_ids) - len(kept)
        group_id = entry.get("conflict_group_id")
        if group_id:
            removed_by_group[group_id] = removed_by_group.get(group_id, 0) + removed
        if not kept:
            suggestions.pop(suggestion_id, None)
            statuses.pop(suggestion_id, None)
            continue
        entry["source_row_ids"] = kept
        if isinstance(entry.get("txn_count"), int):
            entry["txn_count"] = max(0, entry["txn_count"] - removed)
        status = statuses.get(suggestion_id)
        if isinstance(status, dict) and status.get("accepted_prior_rows"):
            status["accepted_prior_rows"] = [
                row for row in status["accepted_prior_rows"]
                if not (isinstance(row, dict) and is_gone(str(row.get("id"))))
            ]
    for entry in suggestions.values():
        removed = removed_by_group.get(entry.get("conflict_group_id")) if isinstance(entry, dict) else None
        if removed and isinstance(entry.get("conflict_group_total_rows"), int):
            entry["conflict_group_total_rows"] = max(0, entry["conflict_group_total_rows"] - removed)
    return changed


def _prune_review_state(review_state, is_gone: Callable[[str], bool]) -> bool:
    if not isinstance(review_state, dict):
        return False
    suggestions = review_state.get("suggestions")
    statuses = review_state.get("statuses")
    changed = False
    if isinstance(suggestions, dict):
        changed = _prune_entries(suggestions, statuses if isinstance(statuses, dict) else {}, is_gone)
    trash_sets = []
    for trash_set in review_state.get("trash_sets") or []:
        if isinstance(trash_set, dict) and isinstance(trash_set.get("suggestions"), dict):
            trash_statuses = trash_set.get("statuses") if isinstance(trash_set.get("statuses"), dict) else {}
            if _prune_entries(trash_set["suggestions"], trash_statuses, is_gone):
                changed = True
                if not trash_set["suggestions"]:
                    continue
                trash_set["count"] = len(trash_set["suggestions"])
        trash_sets.append(trash_set)
    if changed:
        review_state["trash_sets"] = trash_sets
        summarize_rule_suggestion_review(review_state)
    return changed


def _prune_container(conn, table: str, key_column: str, payload_column: str, key, is_gone) -> None:
    row = conn.execute(f"SELECT {payload_column} AS payload FROM {table} WHERE {key_column} = ?", (key,)).fetchone()
    if not row:
        return
    try:
        container = json.loads(row["payload"] or "{}")
    except (TypeError, ValueError):
        return
    if isinstance(container, dict) and _prune_review_state(container.get(RULE_SUGGESTION_REVIEW_KEY), is_gone):
        conn.execute(
            f"UPDATE {table} SET {payload_column} = ? WHERE {key_column} = ?", (json.dumps(container), key),
        )


def release_rule_suggestion_rows(conn, txn_ids: Iterable[str]) -> None:
    """Take transactions about to be hard-deleted out of every review that names them. Call it before the
    delete and inside the same transaction: it finds the reviews to touch through the rows' own batches,
    which are gone once the rows are."""
    gone = {str(txn_id) for txn_id in txn_ids if txn_id}
    if not gone:
        return
    ids = sorted(gone)
    batches: set[str] = set()
    profiles: set[str] = set()
    for start in range(0, len(ids), _ID_CHUNK):
        chunk = ids[start:start + _ID_CHUNK]
        for row in conn.execute(
            f"""SELECT DISTINCT t.import_batch_id AS batch_id, b.profile_id
                FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
                WHERE  t.id IN ({",".join("?" * len(chunk))})""",
            chunk,
        ):
            batches.add(row["batch_id"])
            if row["profile_id"]:
                profiles.add(row["profile_id"])
    if not batches:
        return
    is_gone = gone.__contains__
    for batch_id in sorted(batches):
        _prune_container(conn, "import_batch", "id", "config_snapshot", batch_id, is_gone)
    for profile_id in sorted(profiles):
        _prune_container(conn, "csv_import_profile", "id", "column_map", profile_id, is_gone)
    _prune_container(
        conn, "import_workflow_state", "key", "payload_json", SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY, is_gone,
    )


def release_missing_rule_suggestion_rows(conn) -> int:
    """Remove from every stored review the ids of transactions that no longer exist: the repair for
    reviews written before deletions released their rows. Returns how many containers changed."""
    live = {row[0] for row in conn.execute("SELECT id FROM txn")}

    def is_gone(row_id: str) -> bool:
        return row_id not in live

    containers = [
        ("import_batch", "id", "config_snapshot", "SELECT id FROM import_batch"),
        ("csv_import_profile", "id", "column_map", "SELECT id FROM csv_import_profile"),
        ("import_workflow_state", "key", "payload_json",
         f"SELECT key AS id FROM import_workflow_state WHERE key = '{SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY}'"),
    ]
    changed = 0
    for table, key_column, payload_column, query in containers:
        for row in conn.execute(query).fetchall():
            before = conn.total_changes
            _prune_container(conn, table, key_column, payload_column, row["id"], is_gone)
            changed += conn.total_changes != before
    return changed
