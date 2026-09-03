# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Find-or-create an excluded leaf under a seeded, excluded top-level group.

Two seeded, excluded groups hold money that has to drop out of spending totals: ``Transfers``, whose
leaves the app creates and writes to (the Amazon importer's matched card charge, and wallet funding-leg
suppression), and ``Reimbursable``, which holds money owed back. This module owns finding either group
and creating leaves under ``Transfers``.

The invariant this exists to protect is the same for all of them: a transaction may only ever be
assigned to a **leaf**, never a group (``docs/data-model.md`` → Categories). The groups are seeded, but
a group can be deleted outright, and the naive "parent = whatever row I found, else NULL" fallback would
then create the excluded category as a *top-level* row — structurally a group — and start assigning
transactions to it. So a missing group is **recreated** rather than degraded to a parentless leaf. That
rule is the reason this is one shared helper rather than a copy per feature: it is subtle, it is silent
when broken, and a second hand-written copy is where it would drift.

A leaf created here also carries ``exclude_from_totals = 1`` in its own right, so it stays out of
totals even if the parent group is later changed.

**The two groups are identified differently, deliberately.** ``Transfers`` is found by name.
``Reimbursable`` carries a ``system_key`` as well, because its feature has to keep working after the
user renames the group, and because the empty-category sweep spares only system rows — a receivable
category is empty exactly when nothing is outstanding, which is its healthy state rather than a sign
that it is unused.

**Only ``Transfers`` gets leaves from here.** Its two are named by the app because the app is what puts
rows in them. The reimbursable group's leaves are the user's own, named for what the money is rather
than for where it is in its lifecycle, so there is nothing here to create.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Optional

TRANSFERS_GROUP = "Transfers"

# The reimbursable-expenses holding group. The key is the durable identity — see the module docstring —
# and the name is only what it is called today.
#
# **No leaf is seeded inside it, deliberately.** The group says the money is owed back; a leaf says what
# it is *for* ("Concert tickets", "Work expenses"), which only the user knows. A seeded leaf would have
# to be named for the state instead — and a state name goes stale the moment the state changes, which
# is what sent an earlier design looking for a second "Completed" leaf to move finished rows into. See
# `docs/data-model.md` → Reimbursable expenses.
REIMBURSABLE_GROUP = "Reimbursable"
REIMBURSABLE_SYSTEM_KEY = "reimbursable"


def _find_group_id(
    conn: sqlite3.Connection, name: str, system_key: Optional[str]
) -> Optional[str]:
    """The group's id if it exists. A keyed group is looked up by key first so a rename cannot lose it,
    then by name — which is what adopts a group seeded before it carried a key."""
    if system_key:
        row = conn.execute(
            "SELECT id FROM category WHERE system_key = ? AND parent_id IS NULL", (system_key,)
        ).fetchone()
        if row:
            return row["id"]
    row = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (name,)
    ).fetchone()
    return row["id"] if row else None


def _ensure_group(
    conn: sqlite3.Connection, name: str, *, system_key: Optional[str] = None
) -> str:
    """The id of the top-level excluded group, created if the user deleted it — never a parentless
    leaf, so the excluded category below always has a real group parent."""
    group_id = _find_group_id(conn, name, system_key)
    if group_id:
        return group_id
    group_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, system_key)
           VALUES (?, NULL, ?, 'expense', 1, ?)""",
        (group_id, name, system_key),
    )
    return group_id


def _ensure_leaf(
    conn: sqlite3.Connection, leaf_name: str, *, group_name: str, group_system_key: Optional[str] = None
) -> str:
    """The id of an excluded leaf named `leaf_name` under the named group, creating either the leaf or
    the group as needed."""
    parent_id = _ensure_group(conn, group_name, system_key=group_system_key)
    existing = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id = ?", (leaf_name, parent_id)
    ).fetchone()
    if existing:
        return existing["id"]
    leaf_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals)
           VALUES (?, ?, ?, 'expense', 1)""",
        (leaf_id, parent_id, leaf_name),
    )
    return leaf_id


def ensure_excluded_transfers_leaf(conn: sqlite3.Connection, leaf_name: str) -> str:
    """An excluded leaf under the ``Transfers`` group — the Amazon charge and money-movement path."""
    return _ensure_leaf(conn, leaf_name, group_name=TRANSFERS_GROUP)


def find_reimbursable_group_id(conn: sqlite3.Connection) -> Optional[str]:
    """The receivable group's id, or None — the **read** path, which must not create anything.

    Reporting asks this question far more often than anything writes, and a read that seeds a group as
    a side effect would put a category into the tree of every user who merely opened a report.
    """
    return _find_group_id(conn, REIMBURSABLE_GROUP, REIMBURSABLE_SYSTEM_KEY)


def reimbursable_leaf_ids(conn: sqlite3.Connection) -> list[str]:
    """Every leaf under the receivable group, which is what "a receivable allocation" means.

    The feature keys on the *group*, not on one blessed leaf: the user may rename the default leaf,
    delete it, or add their own beside it, and all of them are receivables. `exclude_from_totals` on
    the group covers each of them through `COALESCE(parent, leaf)` regardless of what the leaf carries.
    """
    group_id = find_reimbursable_group_id(conn)
    if not group_id:
        return []
    return [
        row["id"]
        for row in conn.execute(
            "SELECT id FROM category WHERE parent_id = ? AND is_active = 1 ORDER BY LOWER(name), id",
            (group_id,),
        )
    ]
