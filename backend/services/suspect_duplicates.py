# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Suspect-duplicate detection for transactions.

We flag a transaction as a possible duplicate of another when they share the same date, amount,
and merchant text but live on different accounts. The detection is "soft" — flagged rows are
never auto-trashed; they surface in the review report and the user decides what to do.

Two triggers:
  * Import-time: when the receiving account is brand new to the database, same-day same-amount
    same-payee on any other account is far more likely to be the same real-world event entered
    through two CSVs than a real coincidence.
  * Account merge: when two accounts get rolled into one group, overlapping rows that previously
    looked legitimate (because they sat on different accounts) become suspect.

Both triggers use the same SQL join keyed on `(date, ROUND(amount, 2), normalized payee)`. The
join is indexed via `idx_txn_date_amount`, so even with hundreds of thousands of rows the cost is
proportional to candidate pairs, not to N*N.
"""

import sqlite3
from typing import Iterable


# The same normalized-payee expression is used on both sides of the join. The COALESCE chain
# matches the convention used elsewhere in the app for "what label do we show for this txn."
NORMALIZED_PAYEE_SQL = (
    "LOWER(TRIM(COALESCE(NULLIF({alias}.display_name, ''), "
    "NULLIF({alias}.merchant_name, ''), NULLIF({alias}.raw_name, ''), '')))"
)


def _placeholders(values) -> str:
    return ",".join("?" * len(values))


def find_new_accounts_in_batch(conn: sqlite3.Connection, batch_id: str) -> list[str]:
    """An account is 'new in this batch' when every transaction on that account so far belongs
    to this same batch. If anything earlier exists on the same account, the account isn't new
    — even if it was created during this import attempt, the user is layering on top of prior
    history and the soft-dup heuristic doesn't apply."""
    rows = conn.execute(
        """
        SELECT DISTINCT account_id
        FROM   txn
        WHERE  import_batch_id = ?
          AND  account_id IS NOT NULL
        """,
        (batch_id,),
    ).fetchall()
    candidate_ids = [row["account_id"] for row in rows]
    if not candidate_ids:
        return []
    placeholders = _placeholders(candidate_ids)
    existing = {
        row["account_id"]
        for row in conn.execute(
            f"""
            SELECT DISTINCT account_id
            FROM   txn
            WHERE  account_id IN ({placeholders})
              AND  (import_batch_id IS NULL OR import_batch_id != ?)
            """,
            (*candidate_ids, batch_id),
        ).fetchall()
    }
    return [aid for aid in candidate_ids if aid not in existing]


def mark_import_suspects(conn: sqlite3.Connection, batch_id: str) -> int:
    """After a batch's transactions have been inserted, flag any of them that land on a
    brand-new account and match an existing transaction on a different account by
    (date, amount, payee). Returns the number of rows flagged."""
    new_accounts = find_new_accounts_in_batch(conn, batch_id)
    if not new_accounts:
        return 0
    placeholders = _placeholders(new_accounts)
    # Pick exactly one existing match per new transaction. ORDER BY t2.id keeps the choice
    # stable across runs so re-imports don't shuffle the suspect target.
    matches = conn.execute(
        f"""
        SELECT t1.id AS new_id, MIN(t2.id) AS existing_id
        FROM   txn t1
        JOIN   txn t2
          ON   t2.id != t1.id
          AND  t2.account_id != t1.account_id
          AND  t2.date = t1.date
          AND  ROUND(t2.amount, 2) = ROUND(t1.amount, 2)
          AND  {NORMALIZED_PAYEE_SQL.format(alias='t2')} = {NORMALIZED_PAYEE_SQL.format(alias='t1')}
          AND  {NORMALIZED_PAYEE_SQL.format(alias='t1')} != ''
          AND  t2.trashed_at IS NULL
          AND  (
                t2.import_batch_id IS NULL
             OR t2.import_batch_id != t1.import_batch_id
             OR t2.id < t1.id
          )
        WHERE  t1.import_batch_id = ?
          AND  t1.account_id IN ({placeholders})
          AND  t1.trashed_at IS NULL
          AND  t1.suspect_duplicate_of IS NULL
        GROUP  BY t1.id
        """,
        (batch_id, *new_accounts),
    ).fetchall()
    if not matches:
        return 0
    conn.executemany(
        """
        UPDATE txn
        SET    suspect_duplicate_of = ?,
               suspect_duplicate_reason = 'import_new_account',
               suspect_resolved_at = NULL
        WHERE  id = ?
        """,
        [(row["existing_id"], row["new_id"]) for row in matches],
    )
    return len(matches)


def mark_merge_suspects(conn: sqlite3.Connection, account_ids: Iterable[str]) -> int:
    """After two or more accounts have been rolled together, search transactions on the listed
    accounts for any same-day same-amount same-payee match on a different account. Used by the
    account-attach flow. Returns the number of rows newly flagged."""
    account_id_list = [aid for aid in (account_ids or []) if aid]
    if not account_id_list:
        return 0
    placeholders = _placeholders(account_id_list)
    matches = conn.execute(
        f"""
        SELECT t1.id AS new_id, MIN(t2.id) AS existing_id
        FROM   txn t1
        JOIN   txn t2
          ON   t2.id != t1.id
          AND  t2.account_id != t1.account_id
          AND  t2.date = t1.date
          AND  ROUND(t2.amount, 2) = ROUND(t1.amount, 2)
          AND  {NORMALIZED_PAYEE_SQL.format(alias='t2')} = {NORMALIZED_PAYEE_SQL.format(alias='t1')}
          AND  {NORMALIZED_PAYEE_SQL.format(alias='t1')} != ''
          AND  t2.trashed_at IS NULL
          AND  t1.id > t2.id
        WHERE  t1.account_id IN ({placeholders})
          AND  t1.trashed_at IS NULL
          AND  t1.suspect_duplicate_of IS NULL
        GROUP  BY t1.id
        """,
        account_id_list,
    ).fetchall()
    if not matches:
        return 0
    conn.executemany(
        """
        UPDATE txn
        SET    suspect_duplicate_of = ?,
               suspect_duplicate_reason = 'account_merge',
               suspect_resolved_at = NULL
        WHERE  id = ?
        """,
        [(row["existing_id"], row["new_id"]) for row in matches],
    )
    return len(matches)


def list_suspects(conn: sqlite3.Connection, *, batch_id: str | None = None, limit: int = 500) -> list[dict]:
    """Return active suspect pairs (flagged, not yet resolved). Each row carries enough context
    for the review UI to render both sides without a follow-up fetch."""
    params: list = []
    clauses = [
        "t1.suspect_duplicate_of IS NOT NULL",
        "t1.suspect_resolved_at IS NULL",
        "t1.trashed_at IS NULL",
    ]
    if batch_id:
        clauses.append("t1.import_batch_id = ?")
        params.append(batch_id)
    where = " AND ".join(clauses)
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT
            t1.id                          AS new_id,
            t1.date                        AS new_date,
            t1.amount                      AS new_amount,
            COALESCE(NULLIF(t1.display_name, ''), NULLIF(t1.merchant_name, ''), NULLIF(t1.raw_name, ''))
                                           AS new_payee,
            a1.display_name                AS new_account_display_name,
            a1.name                        AS new_account_name,
            c1.name                        AS new_category_name,
            t1.import_batch_id             AS new_batch_id,
            t1.suspect_duplicate_reason    AS reason,
            t2.id                          AS existing_id,
            t2.date                        AS existing_date,
            t2.amount                      AS existing_amount,
            COALESCE(NULLIF(t2.display_name, ''), NULLIF(t2.merchant_name, ''), NULLIF(t2.raw_name, ''))
                                           AS existing_payee,
            a2.display_name                AS existing_account_display_name,
            a2.name                        AS existing_account_name,
            c2.name                        AS existing_category_name,
            t2.import_batch_id             AS existing_batch_id
        FROM   txn t1
        JOIN   txn t2                ON t2.id = t1.suspect_duplicate_of
        LEFT JOIN account  a1        ON a1.id = t1.account_id
        LEFT JOIN account  a2        ON a2.id = t2.account_id
        LEFT JOIN category c1        ON c1.id = t1.category_id
        LEFT JOIN category c2        ON c2.id = t2.category_id
        WHERE  {where}
        ORDER  BY t1.date DESC, t1.id
        LIMIT  ?
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def count_active_suspects(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM   txn
        WHERE  suspect_duplicate_of IS NOT NULL
          AND  suspect_resolved_at IS NULL
          AND  trashed_at IS NULL
        """,
    ).fetchone()
    return int(row["n"] if row else 0)


def resolve_suspect(conn: sqlite3.Connection, txn_id: str, *, action: str) -> dict:
    """Mark a suspect as resolved. `action` is 'keep' (clears the flag, row remains) or 'trash'
    (sends the suspect row to the trash and clears the flag). Returns a summary describing what
    happened so the caller can update its UI."""
    row = conn.execute(
        "SELECT id, suspect_duplicate_of, trashed_at FROM txn WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if not row:
        return {"resolved": False, "reason": "not_found"}
    if not row["suspect_duplicate_of"]:
        return {"resolved": False, "reason": "not_suspect"}
    if action == "trash":
        conn.execute(
            """
            UPDATE txn
            SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE  id = ?
            """,
            (txn_id,),
        )
        return {"resolved": True, "action": "trash"}
    if action == "keep":
        conn.execute(
            """
            UPDATE txn
            SET    suspect_duplicate_of = NULL,
                   suspect_duplicate_reason = NULL,
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE  id = ?
            """,
            (txn_id,),
        )
        return {"resolved": True, "action": "keep"}
    return {"resolved": False, "reason": "invalid_action"}
