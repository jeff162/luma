# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
An Amazon order's amount once a charge has been added to it.

Part of an order can be paid with card rewards. The export's total leaves that part out, while the card
records it as a charge of its own, paid back by a credit of the same amount. Adding that charge to the
order makes the order's amount its imported amount plus every added charge, so the purchase reads at
what it cost. The added charge joins the link as an ordinary ``charge`` member and is listed in the
link's ``added_charge_ids``; the imported amount is kept as ``order_base_amount``.

The amount is stored on the order row, so it is re-derived here after any change to the link's charges:
adding or removing one, unlinking, undoing the import that brought a charge, or deleting a charge.

A split order's parts must sum to its amount. Adding or removing a charge by hand is refused on a split
order; a change forced from outside (an undo, a delete) clears the split, since nothing else keeps that
invariant true.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable

from backend.services import txn_links
from backend.services.txn_splits import clear_split

LINK_KIND = "amazon_order"
ADDED_CHARGES_KEY = "added_charge_ids"
BASE_AMOUNT_KEY = "order_base_amount"


def added_charge_ids(meta: dict) -> list[str]:
    return [cid for cid in (meta or {}).get(ADDED_CHARGES_KEY) or [] if isinstance(cid, str)]


def refresh_order_amount(conn: sqlite3.Connection, link_id: str) -> None:
    """Set the order's amount to its imported amount plus the added charges still on the link, and drop
    the bookkeeping once none remain."""
    link = txn_links.get_link(conn, link_id)
    if not link or link.get("kind") != LINK_KIND:
        return
    meta = link.get("metadata") or {}
    if BASE_AMOUNT_KEY not in meta:
        return
    live = set(txn_links.member_txn_ids(conn, link_id, role="charge"))
    added = [cid for cid in added_charge_ids(meta) if cid in live]
    total = 0.0
    if added:
        placeholders = ",".join("?" * len(added))
        total = conn.execute(
            f"SELECT COALESCE(SUM(amount), 0) AS s FROM txn WHERE id IN ({placeholders})", added
        ).fetchone()["s"]
    amount = round(float(meta[BASE_AMOUNT_KEY]) + float(total), 2)
    for order_id in txn_links.member_txn_ids(conn, link_id, role="order"):
        row = conn.execute("SELECT amount, is_split FROM txn WHERE id = ?", (order_id,)).fetchone()
        if not row or round(row["amount"], 2) == amount:
            continue
        if row["is_split"]:
            clear_split(conn, order_id)
        conn.execute("UPDATE txn SET amount = ? WHERE id = ?", (amount, order_id))
    if added:
        meta[ADDED_CHARGES_KEY] = added
    else:
        meta.pop(ADDED_CHARGES_KEY, None)
        meta.pop(BASE_AMOUNT_KEY, None)
    txn_links.set_metadata(conn, link_id, meta)


def links_with_added_charges(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> list[str]:
    """The order links that hold any of these transactions as an added charge — the links whose amount a
    delete of those rows changes. Read before the delete, since the memberships cascade with the rows."""
    ids = [i for i in dict.fromkeys(txn_ids) if i]
    found: list[str] = []
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for row in conn.execute(
            f"""SELECT DISTINCT l.id
                FROM   txn_link l JOIN txn_link_member m ON m.link_id = l.id
                WHERE  l.kind = ? AND m.role = 'charge' AND m.txn_id IN ({",".join("?" * len(chunk))})""",
            (LINK_KIND, *chunk),
        ):
            link = txn_links.get_link(conn, row["id"])
            if link and set(added_charge_ids(link.get("metadata") or {})) & set(chunk):
                found.append(row["id"])
    return list(dict.fromkeys(found))
