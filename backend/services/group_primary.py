# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Groups whose primary has been replaced (`docs/data-model.md` -> *Account groups*).

A group's primary, its root, is where the group's name and settings are read from, and closing it closes the
whole group. When a card is replaced, the new number is typically merged into the group and the old one, often
the root, falls silent. Nothing is wrong with leaving it so, but the old card cannot then be closed on its own,
so the group is suggested for `make_root` when its root has had no transactions for `QUIET_DAYS` while exactly
one other member has. The suggestion is a Task, put away per group like any other; nothing is stored here.
"""

from datetime import date, timedelta
from typing import Optional

# How long a primary must be silent, while one other member is not, before the group is suggested. Longer than
# a statement cycle or two, so a card that is merely used rarely is not taken for a replaced one.
QUIET_DAYS = 90


def quiet_primaries(conn, today: Optional[date] = None) -> list[dict]:
    """Open groups whose root has had no live transaction for `QUIET_DAYS` while exactly one other member,
    itself open, has. Each entry names the root, the member to suggest and the root's owner."""
    since = ((today or date.today()) - timedelta(days=QUIET_DAYS)).isoformat()
    rows = conn.execute(
        """
        SELECT a.id, a.name, a.mask, a.owner_id, a.closed_on, a.parent_account_id,
               EXISTS (SELECT 1 FROM txn t
                       WHERE t.account_id = a.id AND t.trashed_at IS NULL AND t.date >= ?) AS active
        FROM account a
        WHERE a.parent_account_id IS NOT NULL
           OR a.id IN (SELECT parent_account_id FROM account WHERE parent_account_id IS NOT NULL)
        ORDER BY a.id
        """, (since,)).fetchall()
    roots = {row["id"]: row for row in rows if not row["parent_account_id"]}
    members: dict[str, list] = {}
    for row in rows:
        if row["parent_account_id"]:
            members.setdefault(row["parent_account_id"], []).append(row)
    found = []
    for root_id, root in roots.items():
        if root["closed_on"] or root["active"]:
            continue
        active = [m for m in members.get(root_id, []) if m["active"]]
        if len(active) != 1 or active[0]["closed_on"]:
            continue
        found.append({
            "root_id": root_id,
            "root_label": _label(root),
            "member_id": active[0]["id"],
            "member_label": _label(active[0]),
            "owner_id": root["owner_id"],
        })
    return sorted(found, key=lambda entry: entry["root_label"].casefold())


def _label(row) -> str:
    return f"{row['name']} ···{row['mask']}" if row["mask"] else row["name"]
