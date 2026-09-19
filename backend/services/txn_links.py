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
    row = conn.execute(
        "SELECT id, kind, external_ref, metadata_json, created_at FROM txn_link WHERE id = ?",
        (link_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "kind": row["kind"],
        "external_ref": row["external_ref"],
        "metadata": _parse_metadata(row["metadata_json"]),
        "created_at": row["created_at"],
        "members": _members(conn, link_id),
    }


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


def delete_link(conn: sqlite3.Connection, link_id: str) -> list[dict]:
    """Delete a link and its memberships (members cascade). Returns the member list as it was, so a
    caller unwinding a feature can act on the freed transactions (e.g. un-exclude the charge). Does
    **not** delete the transactions themselves."""
    members = _members(conn, link_id)
    conn.execute("DELETE FROM txn_link WHERE id = ?", (link_id,))  # members cascade via FK
    return members
