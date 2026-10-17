# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Rule pairs a categorization pass caught deciding a transaction arbitrarily.

The rule checkup finds these pairs too, but only when someone runs it, and early on there is too little
history for it to find much. So the passes that apply rules to transactions (import, sync, Run
categorization, a rule's own apply) record each pair as they meet it: a transaction two rules both match,
where precedence picks between them on nothing about the two rules and the pick changes what happens to
it. Both are the checkup's own tests (`rule_overlaps.conflict_kind`), so every pair recorded here is one
the checkup lists as a warning.

**Recorded at match time, checked again on read.** The record is a note that the pair was seen, not a
verdict: a rule edit, a deleted rule or a trashed transaction can resolve it without any pass running, so
`open_conflicts` re-tests each pair against the current rules and its example transaction, and drops the
ones that no longer hold. That is one pair and one row each, which is what makes a stored note affordable
where the checkup's whole-ledger scan is not.

**One row per pair**, carrying the newest transaction that showed it. What the user acts on is the pair;
how many transactions it touched is the checkup's to say.

Only rows the rules decide are evidence: live, posted, and without a category the user set by hand. A
pending row is skipped because it is replaced when it posts, and the checkup does not read one either.

The Tasks entry built on the count is dismissed the way every task is, by its count: it returns when a new
pair is recorded. The pair itself cannot be acknowledged; it stays until the rules stop conflicting.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable

from backend.services import rule_overlaps
from backend.services.categorizer import (
    categorize_transaction,
    load_categorization_rules,
    load_rule_tags_by_id,
    rule_matches_row,
    source_match_text_from_json,
)

# Ids per statement, since one statement can bind only so many values.
_ID_CHUNK = 500

_ROW_COLUMNS = """t.id, t.date, t.amount, t.owner_id, t.account_id, t.merchant_name, t.raw_name,
                  t.import_evidence_json,
                  COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                  COALESCE(p.type, a.type)                    AS effective_account_type"""


def _evidence_rows(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> dict[str, sqlite3.Row]:
    """The rows among `txn_ids` that can show a conflict, by id: live, posted, and decided by the rules."""
    ids = list(dict.fromkeys(i for i in txn_ids if i))
    found: dict[str, sqlite3.Row] = {}
    for start in range(0, len(ids), _ID_CHUNK):
        chunk = ids[start:start + _ID_CHUNK]
        for row in conn.execute(
            f"""SELECT {_ROW_COLUMNS}
                FROM   txn t
                JOIN   account a ON a.id = t.account_id
                LEFT   JOIN account p ON p.id = a.parent_account_id
                WHERE  t.trashed_at IS NULL AND t.is_pending = 0 AND t.category_overridden = 0
                  AND  t.id IN ({','.join('?' * len(chunk))})""",
            chunk,
        ):
            found[row["id"]] = row
    return found


def record(conn: sqlite3.Connection, matches: Iterable[tuple[str, dict | None]]) -> None:
    """Record the conflicting pairs among `(txn_id, categorize result)` from a pass that has just applied
    the rules, inside its transaction. A result is what `categorize_transaction` returned for that row;
    only one naming two or more rules can show a conflict, so a pass may hand over every row it saw."""
    candidates = {
        txn_id: result["matched_rule_ids"]
        for txn_id, result in matches
        if isinstance(result, dict) and len(result.get("matched_rule_ids") or ()) >= 2
    }
    if not candidates:
        return
    rows = _evidence_rows(conn, candidates)
    if not rows:
        return
    rules = {rule["id"]: rule for rule in rule_overlaps.eligible_rules(conn)}
    for txn_id, row in rows.items():
        matched = [rules[rule_id] for rule_id in candidates[txn_id] if rule_id in rules]
        if len(matched) > rule_overlaps.MAX_RULES_PER_ROW:
            continue
        for index, first in enumerate(matched):
            for second in matched[index + 1:]:
                if rule_overlaps.conflict_kind(first, second) is None:
                    continue
                low, high = sorted((first["id"], second["id"]))
                conn.execute(
                    """INSERT INTO rule_conflict (rule_id_low, rule_id_high, txn_id) VALUES (?, ?, ?)
                       ON CONFLICT (rule_id_low, rule_id_high) DO UPDATE SET txn_id = excluded.txn_id
                       WHERE (SELECT date FROM txn WHERE id = excluded.txn_id)
                          >= (SELECT date FROM txn WHERE id = rule_conflict.txn_id)""",
                    (low, high, txn_id),
                )


def record_for_txns(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> None:
    """`record` for a pass that does not keep each row's categorize result: the rows are matched against
    the rules again here, the same way the pass matched them."""
    rows = _evidence_rows(conn, txn_ids)
    if not rows:
        return
    rules = load_categorization_rules(conn)
    if len(rules) < 2:
        return
    rule_tags_by_id = load_rule_tags_by_id(conn)
    needs_source_text = any(rule["match_source_text"] for rule in rules)
    record(conn, (
        (row["id"], categorize_transaction(
            row["merchant_name"], row["raw_name"], row["amount"], conn,
            owner_id=row["owner_id"], account_id=row["account_id"],
            effective_account_id=row["effective_account_id"],
            effective_account_type=row["effective_account_type"],
            rules=rules, rule_tags_by_id=rule_tags_by_id,
            source_text=source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None,
        ))
        for row in rows.values()
    ))


def open_conflicts(conn: sqlite3.Connection) -> list[dict]:
    """The recorded pairs that still conflict, as `{rule_ids, txn_id, kind}`. A pair that no longer does —
    a rule edited, trashed or deleted, or its example transaction no longer one the rules decide — is
    removed here, so the table only ever holds what this returns plus whatever a pass has recorded since."""
    stored = conn.execute("SELECT rule_id_low, rule_id_high, txn_id FROM rule_conflict").fetchall()
    if not stored:
        return []
    rules = {rule["id"]: rule for rule in rule_overlaps.eligible_rules(conn)}
    rows = _evidence_rows(conn, (entry["txn_id"] for entry in stored))
    found, stale = [], []
    for entry in stored:
        first, second = rules.get(entry["rule_id_low"]), rules.get(entry["rule_id_high"])
        row = rows.get(entry["txn_id"])
        kind = None
        if first and second and row and rule_matches_row(first, row) and rule_matches_row(second, row):
            kind = rule_overlaps.conflict_kind(first, second)
        if kind is None:
            stale.append((entry["rule_id_low"], entry["rule_id_high"]))
        else:
            found.append({"rule_ids": [first["id"], second["id"]], "txn_id": row["id"], "kind": kind})
    if stale:
        conn.executemany("DELETE FROM rule_conflict WHERE rule_id_low = ? AND rule_id_high = ?", stale)
    return found


def open_count(conn: sqlite3.Connection) -> int:
    """How many recorded pairs still conflict: the Tasks entry and the Rules page's checkup badge."""
    return len(open_conflicts(conn))
