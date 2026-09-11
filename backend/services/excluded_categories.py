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

A leaf created here also carries ``exclude_from_totals = 1`` in its own right. That is a fallback for
the parentless case above, not a second opinion: exclusion resolves as ``COALESCE(parent, leaf, 0)`` over
a NOT NULL column, so a leaf that *has* a parent always takes the group's answer and cannot opt itself
back into totals (``routers/categories.py`` says the same from the other end). Turning the exclusion off
on the group is therefore what brings its leaves back into totals, and is the intended control.

**Both groups carry a ``system_key``**, which is their durable identity: the app has to keep finding
them after a rename, and neither can be deleted. Lookup tries the key first and falls back to the name,
which is what adopts a group that predates its key — one seeded before the key existed, or one the user
built by hand under the same name. The key also spares ``Reimbursable`` from the empty-category sweep,
which skips system rows: a receivable category is empty exactly when nothing is outstanding, which is
its healthy state rather than a sign that it is unused.

**Only ``Transfers`` gets leaves from here.** Its two are named by the app because the app is what puts
rows in them. The reimbursable group's leaves are the user's own, named for what the money is rather
than for where it is in its lifecycle, so there is nothing here to create.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Optional

# The money-movement holding group. Keyed for the same reason ``Reimbursable`` is: the Amazon importer
# and wallet funding-leg suppression both write leaves into it, and a lookup by name alone would miss a
# renamed group and silently build a *second* "Transfers" beside it — both excluded, so totals stay
# right while the leaves and their history split across two groups with nothing visibly wrong.
#
# Unlike ``Reimbursable``, its exclusion **is** the user's to turn off. The group is a convention about
# where money movement is filed rather than a mechanism anything computes against, so counting it is a
# coherent view; what is locked is only deleting it or moving it inside another group.
TRANSFERS_GROUP = "Transfers"
TRANSFERS_SYSTEM_KEY = "transfers"

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
    return _ensure_leaf(
        conn, leaf_name, group_name=TRANSFERS_GROUP, group_system_key=TRANSFERS_SYSTEM_KEY
    )


def find_transfers_group_id(conn: sqlite3.Connection) -> Optional[str]:
    """The money-movement group's id, or None — the **read** path, which must not create anything.

    Shares ``_find_group_id`` with the write path so both survive a rename identically; a reader that
    matched on the name alone would start reporting "not set up" the moment the group was renamed.
    """
    return _find_group_id(conn, TRANSFERS_GROUP, TRANSFERS_SYSTEM_KEY)


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
