# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Rule alerts: a rule action that raises a Task when a matching transaction arrives.

Made for watching something that should stay quiet, such as a card that has been closed, where nothing a
rule writes onto the row gets anyone's attention.

**An alert reports an arrival, not a match.** Every other Task recounts a state on each read. This one says
something new showed up, so a match is recorded only for a row new to the ledger: an import, a sync, a held
duplicate brought in (`record_arrivals`, called by those paths inside their own transaction). Running the
rules again over rows already in the ledger never records one, or saving an alert rule would report the
account's whole history, and so would every Categorize after it. A rule edit leaves what it already caught
in place, since those rows did match when they arrived.

**Every matching rule's alert fires**, as every matching rule's tags apply: precedence decides a category
or a rename, and an alert is neither.

**One Task per rule, counting every live transaction it caught.** It is dismissed as every Task is, per
person and by count (`routers/tasks.py`), so a dismissed alert returns with the next arrival. It can also be
muted, which keeps it hidden however high the count goes until it is dismissed or restored. A rule whose alert
is turned off forgets what it caught.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional

from backend.services.categorizer import (
    PreparedRules,
    bump_rule_effect_dates,
    categorize_transaction,
    load_categorization_rules,
    merchant_matcher,
    source_match_text_from_json,
)
from backend.services.transaction_facets import owner_membership

# Ids per statement, since one statement can bind only so many values.
_ID_CHUNK = 500


def normalize_alert_message(value: Optional[str]) -> Optional[str]:
    text = " ".join((value or "").split())
    return text or None


def record_arrivals(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> None:
    """Record the alerts these newly arrived rows set off, inside the caller's transaction. A row already
    recorded for a rule stays as it is, so a path that hands over a row twice (a pending row settling, a
    batch re-applied) raises nothing new. Costs one rules read when no rule has an alert."""
    rules = [rule for rule in load_categorization_rules(conn) if rule["alert"]]
    ids = list(dict.fromkeys(i for i in txn_ids if i))
    if not rules or not ids:
        return
    prepared = PreparedRules(rules)
    needs_source_text = any(rule["match_source_text"] for rule in rules)
    hits: list[tuple[str, str]] = []
    newest_by_rule: dict[str, str] = {}
    for start in range(0, len(ids), _ID_CHUNK):
        chunk = ids[start:start + _ID_CHUNK]
        rows = conn.execute(
            f"""SELECT t.id, t.date, t.amount, t.owner_id, t.account_id, t.merchant_name, t.raw_name,
                       t.import_evidence_json,
                       COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                       COALESCE(p.type, a.type)                    AS effective_account_type
                FROM   txn t
                JOIN   account a ON a.id = t.account_id
                LEFT   JOIN account p ON p.id = a.parent_account_id
                WHERE  t.trashed_at IS NULL AND t.id IN ({','.join('?' * len(chunk))})""",
            chunk,
        ).fetchall()
        for row in rows:
            result = categorize_transaction(
                row["merchant_name"], row["raw_name"], row["amount"], conn,
                owner_id=row["owner_id"], account_id=row["account_id"],
                effective_account_id=row["effective_account_id"],
                effective_account_type=row["effective_account_type"],
                rules=prepared, rule_tags_by_id={},
                source_text=source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None,
            )
            for rule_id in (result or {}).get("matched_rule_ids", ()):
                hits.append((rule_id, row["id"]))
                if row["date"] and row["date"] > newest_by_rule.get(rule_id, ""):
                    newest_by_rule[rule_id] = row["date"]
    if hits:
        conn.executemany("INSERT OR IGNORE INTO rule_alert_hit (rule_id, txn_id) VALUES (?, ?)", hits)
        # An alert that fired is the rule in use, which the stale-rule cleanup reads.
        bump_rule_effect_dates(conn, newest_by_rule)


def open_alerts(conn: sqlite3.Connection, lens: Optional[list[str]] = None) -> list[dict]:
    """Each live alerting rule with live transactions caught, as `{rule, count}`, rules in keyword order.
    `lens` narrows the count to those owners' transactions; a rule left with none drops out."""
    clauses = ["t.trashed_at IS NULL", "cr.alert = 1", "cr.deleted_at IS NULL"]
    params: list = []
    member = owner_membership(lens or [])
    if member:
        clauses.append(member[0])
        params.extend(member[1])
    rows = conn.execute(
        f"""SELECT cr.id, cr.keyword, cr.match_expr, cr.amount_min, cr.amount_max, cr.debit_credit,
                   cr.account_type, cr.match_source_text, cr.alert_message,
                   o.name AS owner_name,
                   COALESCE(a.display_name, a.name) AS account_name,
                   COALESCE(ap.mask, a.mask)        AS account_mask,
                   COUNT(*) AS n
            FROM   rule_alert_hit h
            JOIN   txn t            ON t.id  = h.txn_id
            JOIN   category_rule cr ON cr.id = h.rule_id
            LEFT   JOIN owner   o  ON o.id  = cr.owner_id
            LEFT   JOIN account a  ON a.id  = cr.account_id
            LEFT   JOIN account ap ON ap.id = a.parent_account_id
            WHERE  {' AND '.join(clauses)}
            GROUP  BY cr.id
            ORDER  BY cr.keyword, cr.id""",
        params,
    ).fetchall()
    return [{"rule": dict(row), "count": row["n"]} for row in rows]


def forget(conn: sqlite3.Connection, rule_id: str) -> None:
    """A rule's alert turned off: what it caught goes with it, so turning it on again starts from the next
    arrival."""
    conn.execute("DELETE FROM rule_alert_hit WHERE rule_id = ?", (rule_id,))


def _amount_text(value) -> str:
    return f"{abs(float(value)):,.2f}"


def alert_condition_text(rule) -> str:
    """The rule's condition in words, for an alert with no message of its own: the matcher, then the scope
    in the order the rule editor lists it."""
    matcher = merchant_matcher(rule["keyword"], rule["match_expr"])
    any_of = " or ".join(f'"{text}"' for text in matcher.alternatives)
    if any_of and matcher.filters and len(matcher.alternatives) > 1:
        any_of = f"({any_of})"
    terms = [any_of] if any_of else []
    terms += [f'"{text}"' for text in matcher.filters if text]
    parts = [" and ".join(terms)] if terms else []
    side = rule["debit_credit"]
    low, high = rule["amount_min"], rule["amount_max"]
    noun = {"debit": "debits", "credit": "credits"}.get(side, "")
    if low is not None and high is not None:
        parts.append(f"{noun or 'amount'} {'of ' + _amount_text(low) if low == high else _amount_text(low) + ' to ' + _amount_text(high)}")
    elif low is not None:
        parts.append(f"{noun or 'amount'} of at least {_amount_text(low)}")
    elif high is not None:
        parts.append(f"{noun or 'amount'} up to {_amount_text(high)}")
    elif noun:
        parts.append(noun)
    if rule["owner_name"]:
        parts.append(f"owner {rule['owner_name']}")
    if rule["account_name"]:
        mask = f" ••{rule['account_mask']}" if rule["account_mask"] else ""
        parts.append(f"on {rule['account_name']}{mask}")
    if rule["account_type"]:
        parts.append(f"on {rule['account_type']} accounts")
    return ", ".join(parts)
