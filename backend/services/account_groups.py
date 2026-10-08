# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Account-group identity — resolving an account reference to the group it belongs to *now*.

Merging account B into account A is deliberately non-destructive: it sets `B.parent_account_id = A`
and moves nothing. B's rows stay on B, and every row elsewhere that named B still names B — which is
exactly what lets `detach` reverse the merge. The group's identity is therefore its **root**,
`COALESCE(parent_account_id, id)`, and any account id is a reference into a graph that can change
under it.

That gives every account comparison two sides, and they must be resolved the same way:

  * the **row side** — the account a transaction sits on — which queries resolve with
    :func:`effective_account_id_sql`;
  * the **stored side** — an account id persisted in some *other* table as a matching scope
    (`category_rule.account_id`, `recurring_series.account_id`, `amazon_funding_map.funding_account_id`)
    — which must be resolved at read time, through :func:`effective_account_id` or the same SQL.

Comparing a raw stored id against a resolved row side is the failure this module exists to prevent.
It does not raise, log, or show anything: after the merge no transaction resolves to the stored child
any more, so the reference simply stops selecting rows. A rule quietly stops firing; an Amazon order
quietly stops finding its charge. The damage is proportional to how long it goes unnoticed, and
nothing about the stored row looks wrong when you read it.

**Resolve at read time; never repoint stored ids at merge time.** Rewriting references when the merge
happens would make the merge irreversible in exactly the way the parent/child model was designed to
avoid — detach restores the account but could not restore references that were rewritten away. The
one place repointing *is* correct is `reassign_account_references` (`services/account_references.py`),
where the account row is about to be deleted for good and the merge is no longer reversible.

**Deliberate exception.** Not every stored account id is a matching scope. `account_tag` attaches a
tag to one specific account row, and a merged child's own tags are *meant* to lie dormant until it is
detached (see `docs/architecture.md` → tags); that reference is resolved on the row side only. The
distinction to apply when adding a column that holds an account id: does it name a **scope to match
rows against** (resolve it) or a **specific account row** (leave it raw)? `tests/test_account_group_
references.py` makes that choice explicit and fails until a new column is classified.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional


def effective_account_id_sql(account_expr: str) -> str:
    """The group root of `account_expr` as a SQL scalar — the canonical form of this comparison.

    `account_expr` is any SQL expression yielding an account id (`t.account_id`, `cr.account_id`, a
    bare `?`). Written as a correlated subquery rather than a join so it can be dropped into a WHERE
    clause, a projection, or a query that has no `account` join to hang `COALESCE(a.parent_account_id,
    a.id)` on. Where a query *does* already join the account it is comparing, that join form is
    equivalent and cheaper; both are the same one-level resolution, since the schema keeps groups one
    level deep (regrouping flattens rather than nesting — see `docs/data-model.md`).
    """
    return f"COALESCE((SELECT parent_account_id FROM account WHERE id = {account_expr}), {account_expr})"


def effective_account_id(conn: sqlite3.Connection, account_id: Optional[str]) -> Optional[str]:
    """The group root of one account id, or None for a blank id. An id with no `account` row is
    returned unchanged — a dangling reference is the caller's business, not this function's, and
    silently turning it into None would hide it.

    Walks the parent chain with a visited set rather than reading one level: the schema keeps groups
    flat, so the walk normally terminates in one step, but a corrupt parent loop must not hang a
    request.
    """
    current = str(account_id or "").strip()
    if not current:
        return None
    seen: set[str] = set()
    while current not in seen:
        seen.add(current)
        row = conn.execute("SELECT parent_account_id FROM account WHERE id = ?", (current,)).fetchone()
        if not row or not row["parent_account_id"]:
            return current
        current = str(row["parent_account_id"])
    return current


def effective_account_ids(conn: sqlite3.Connection, account_ids: Iterable[Optional[str]]) -> dict:
    """`{account id → group root}` for many ids in one query. Ids with no row map to themselves, as in
    :func:`effective_account_id`; blanks are dropped."""
    ids = [str(a).strip() for a in dict.fromkeys(account_ids) if str(a or "").strip()]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    resolved = {
        r["id"]: r["eff"]
        for r in conn.execute(
            f"""SELECT id, COALESCE(parent_account_id, id) AS eff
                FROM   account
                WHERE  id IN ({placeholders})""",
            ids,
        ).fetchall()
    }
    return {a: resolved.get(a, a) for a in ids}


def account_group_member_ids(conn: sqlite3.Connection, account_ids: Iterable[Optional[str]]) -> set:
    """Every account id in the groups the given ids belong to — each id's root plus that root's
    children. For the callers that must express the scope as `t.account_id IN (...)` (an id list built
    ahead of the query) rather than as an effective-account comparison in the WHERE clause. Prefer the
    comparison form where a query can use it: it needs no expansion and cannot go stale between the
    expansion and the query."""
    roots = set(effective_account_ids(conn, account_ids).values())
    if not roots:
        return set()
    placeholders = ",".join("?" * len(roots))
    rows = conn.execute(
        f"""SELECT id FROM account
            WHERE  id IN ({placeholders}) OR parent_account_id IN ({placeholders})""",
        [*roots, *roots],
    ).fetchall()
    return {r["id"] for r in rows} | roots
