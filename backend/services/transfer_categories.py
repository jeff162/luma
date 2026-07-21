# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Find-or-create an excluded leaf under the seeded ``Transfers`` group.

Two features move a row into an excluded category as part of a reversible link: the Amazon importer's
matched card charge ("Amazon purchase") and wallet funding-leg suppression ("Money movement"). Both want
the same shape — a leaf under the top-level ``Transfers`` group, itself flagged
``exclude_from_totals = 1`` so the row drops out of spending totals whether exclusion is read off the leaf
or inherited from the group (``COALESCE(parent, leaf)``).

The one invariant this protects: a transaction may only ever be assigned to a **leaf**, never a
group (see ``data-model.md`` → Categories). ``Transfers`` is a seeded reporting group, but groups can be
deleted outright, and if it were gone the naive "parent = whatever row I found, else NULL" fallback would
create the excluded category as a *top-level* row — structurally a group — and then assign transactions to
it. So this helper **recreates the ``Transfers`` group** when it is missing rather than degrading to a
parentless leaf.
"""

from __future__ import annotations

import sqlite3
import uuid

TRANSFERS_GROUP = "Transfers"


def _ensure_transfers_group(conn: sqlite3.Connection) -> str:
    """The id of the top-level excluded ``Transfers`` group, created if the user deleted it — never a
    parentless leaf, so the excluded category below always has a real group parent."""
    row = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (TRANSFERS_GROUP,)
    ).fetchone()
    if row:
        return row["id"]
    group_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals)
           VALUES (?, NULL, ?, 'expense', 1)""",
        (group_id, TRANSFERS_GROUP),
    )
    return group_id


def ensure_excluded_transfers_leaf(conn: sqlite3.Connection, leaf_name: str) -> str:
    """The id of an excluded leaf named ``leaf_name`` under the ``Transfers`` group, creating either the
    leaf or the group as needed. The leaf carries ``exclude_from_totals = 1`` in its own right, so it
    drops out of totals even if the parent group is later changed."""
    parent_id = _ensure_transfers_group(conn)
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
