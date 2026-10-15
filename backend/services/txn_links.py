# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Typed links between transactions — a general association primitive.

A link groups a set of transactions under a `kind` (e.g. ``'amazon_order'``), each member carrying a
`role` within the link (e.g. the funding ``'charge'`` vs the ``'item'`` rows it was split into). It
optionally carries an `external_ref` (the external entity the link represents — an Amazon order id) and
a free-form `metadata` blob (kind-specific data, such as what a reversal must restore).

The primitive is deliberately **pure association**: it never mutates the linked transactions (no
category flip, no `exclude_from_totals`, no amount change). Those belong to whatever feature owns the
link — the Amazon import adapter is the first client, wallet funding-leg suppression the second,
multi-payment purchases (``services/purchase_links.py``) the third, and reimbursements and PayPal funding
pairs (``services/paypal_funding.py``) after them; credit-card payment-leg pairing and a
cash-flow lens are intended future clients (see ``docs/mechanism-index.md``). Keeping the
table association-only is exactly what lets it serve all of them — the purchase client in particular
mutates nothing at all, so it uses the primitive exactly as it comes.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_metadata(raw) -> Optional[dict]:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def create_link(
    conn: sqlite3.Connection,
    kind: str,
    members: Iterable[tuple[str, str]],
    *,
    external_ref: Optional[str] = None,
    metadata: Optional[dict] = None,
    link_id: Optional[str] = None,
) -> str:
    """Create a link of `kind` over `members` (an iterable of ``(txn_id, role)``) and return its id.
    `external_ref` and `metadata` are optional. Members are attached via :func:`add_member`, so a
    repeated txn_id keeps its last role."""
    link_id = link_id or str(uuid.uuid4())
    conn.execute(
        "INSERT INTO txn_link (id, kind, external_ref, metadata_json, created_at) VALUES (?,?,?,?,?)",
        (link_id, kind, external_ref, json.dumps(metadata) if metadata is not None else None, _now()),
    )
    for txn_id, role in members:
        add_member(conn, link_id, txn_id, role)
    return link_id


def add_member(conn: sqlite3.Connection, link_id: str, txn_id: str, role: str) -> None:
    """Attach a transaction to a link with a role. Idempotent per ``(link_id, txn_id)``: re-adding the
    same transaction updates its role rather than raising."""
    conn.execute(
        """INSERT INTO txn_link_member (link_id, txn_id, role) VALUES (?,?,?)
           ON CONFLICT(link_id, txn_id) DO UPDATE SET role = excluded.role""",
        (link_id, txn_id, role),
    )


def remove_member(conn: sqlite3.Connection, link_id: str, txn_id: str) -> None:
    conn.execute(
        "DELETE FROM txn_link_member WHERE link_id = ? AND txn_id = ?", (link_id, txn_id)
    )


def set_metadata(conn: sqlite3.Connection, link_id: str, metadata: Optional[dict]) -> None:
    conn.execute(
        "UPDATE txn_link SET metadata_json = ? WHERE id = ?",
        (json.dumps(metadata) if metadata is not None else None, link_id),
    )


def _members(conn: sqlite3.Connection, link_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT txn_id, role FROM txn_link_member WHERE link_id = ? ORDER BY rowid", (link_id,)
    ).fetchall()
    return [{"txn_id": r["txn_id"], "role": r["role"]} for r in rows]


def get_link(conn: sqlite3.Connection, link_id: str) -> Optional[dict]:
    return get_links(conn, [link_id]).get(link_id)


def get_links(conn: sqlite3.Connection, link_ids: Iterable[str]) -> dict[str, dict]:
    """The given links with their members, keyed by id; an id with no link is absent.

    Two queries per chunk however many links are asked for, so a caller summarizing a page or a report
    never pays a query per link.
    """
    ids = [link_id for link_id in dict.fromkeys(link_ids) if link_id]
    links: dict[str, dict] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        places = ",".join("?" * len(chunk))
        for row in conn.execute(
            f"SELECT id, kind, external_ref, metadata_json, created_at FROM txn_link WHERE id IN ({places})",
            chunk,
        ):
            links[row["id"]] = {
                "id": row["id"],
                "kind": row["kind"],
                "external_ref": row["external_ref"],
                "metadata": _parse_metadata(row["metadata_json"]),
                "created_at": row["created_at"],
                "members": [],
            }
        for row in conn.execute(
            f"SELECT link_id, txn_id, role FROM txn_link_member WHERE link_id IN ({places}) ORDER BY rowid",
            chunk,
        ):
            if row["link_id"] in links:
                links[row["link_id"]]["members"].append({"txn_id": row["txn_id"], "role": row["role"]})
    return links


def find_link(conn: sqlite3.Connection, kind: str, external_ref: Optional[str]) -> Optional[dict]:
    """The reconciliation lookup: the link of `kind` for a given `external_ref`, or None. The primitive
    does not enforce one-link-per-ref, so if several exist the most recent is returned — clients that
    want find-or-create semantics build on this."""
    row = conn.execute(
        """SELECT id FROM txn_link WHERE kind = ? AND external_ref IS ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1""",
        (kind, external_ref),
    ).fetchone()
    return get_link(conn, row["id"]) if row else None


def links_for_txn(conn: sqlite3.Connection, txn_id: str) -> list[dict]:
    """Every link this transaction participates in (each with the role it plays), newest first."""
    rows = conn.execute(
        """SELECT l.id FROM txn_link l
           JOIN   txn_link_member m ON m.link_id = l.id
           WHERE  m.txn_id = ?
           ORDER  BY l.created_at DESC, l.rowid DESC""",
        (txn_id,),
    ).fetchall()
    return [get_link(conn, r["id"]) for r in rows]


def member_txn_ids(conn: sqlite3.Connection, link_id: str, role: Optional[str] = None) -> list[str]:
    """The transaction ids in a link, optionally filtered to a single role."""
    if role is None:
        rows = conn.execute(
            "SELECT txn_id FROM txn_link_member WHERE link_id = ? ORDER BY rowid", (link_id,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT txn_id FROM txn_link_member WHERE link_id = ? AND role = ? ORDER BY rowid",
            (link_id, role),
        ).fetchall()
    return [r["txn_id"] for r in rows]


def partners_map(conn: sqlite3.Connection, kind: str, txn_ids: Iterable[str]) -> dict[str, dict]:
    """Per transaction, the other side of its links of one `kind`, as a ledger row's link marker shows them:
    ``{"role": <this row's role>, "others": [{id, name, date, amount}, …]}``. The other side is the members
    in a *different* role — a split-shipment order's charges are each other's siblings, not partners — and
    is carried whole enough to name and open, not to act on. A trashed row on the other side is left out."""
    ids = [txn_id for txn_id in dict.fromkeys(txn_ids) if txn_id]
    mapped: dict[str, dict] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for row in conn.execute(
            f"""SELECT me.txn_id AS txn_id, me.role AS role, o.id AS other_id, o.date, o.amount,
                       COALESCE(o.display_name, o.merchant_name, o.raw_name) AS name
                FROM   txn_link_member me
                JOIN   txn_link l ON l.id = me.link_id AND l.kind = ?
                JOIN   txn_link_member other ON other.link_id = me.link_id AND other.role <> me.role
                JOIN   txn o ON o.id = other.txn_id AND o.trashed_at IS NULL
                WHERE  me.txn_id IN ({",".join("?" * len(chunk))})
                ORDER  BY o.date, o.id""",
            (kind, *chunk),
        ):
            entry = mapped.setdefault(row["txn_id"], {"role": row["role"], "others": []})
            entry["others"].append(
                {"id": row["other_id"], "name": row["name"], "date": row["date"], "amount": row["amount"]}
            )
    return mapped


def delete_link(conn: sqlite3.Connection, link_id: str) -> list[dict]:
    """Delete a link and its memberships (members cascade). Returns the member list as it was, so a
    caller unwinding a feature can act on the freed transactions (e.g. un-exclude the charge). Does
    **not** delete the transactions themselves."""
    members = _members(conn, link_id)
    conn.execute("DELETE FROM txn_link WHERE id = ?", (link_id,))  # members cascade via FK
    return members
