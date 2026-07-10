# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The Amazon funding-source → account map (see ``docs/backlog/paypal-amazon-enrichment.md`` →
"funding-source → account mapping").

An Amazon order's ``payments`` field names the payment instrument (a card ``last-4`` + a network label,
e.g. "Fablecard ···4455"). Real imported ledgers rarely carry card masks, so keying the charge
match on a stored mask alone matches nothing. This map is the authoritative signal: the user tells us
which *system account* each instrument charges, and the importer constrains its card-charge search to
that account.

Three states per instrument:

  * **mapped** — a row with ``funding_account_id`` set: the charge lands on that account.
  * **untracked** — a row with ``funding_account_id`` NULL: an explicit "this card isn't an account I
    hold," so the order's items are the sole record and count directly (no charge to exclude).
  * **unmapped** — no row: the matcher falls back to the graceful-last-4 search.

Scope: ``amazon_account_id`` NULL is the **global default** (applies when importing for any Amazon
account); a non-NULL ``amazon_account_id`` is a **per-account override** that wins over the global row
for that one account. Resolution therefore prefers an override, then the global row.

This module is storage + resolution only; the charge search that consumes a resolution lives in the
import engine (:mod:`backend.routers.import_export.amazon`).
"""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from typing import Optional


@dataclass
class FundingResolution:
    """The outcome of resolving one instrument against the map. ``state`` is ``'mapped'`` (search the
    given ``funding_account_id``), ``'untracked'`` (skip the search — items count directly), or
    ``'unmapped'`` (fall back to the graceful-last-4 search)."""

    state: str
    funding_account_id: Optional[str] = None


def normalize_network(network: Optional[str]) -> Optional[str]:
    """The network label is part of the instrument identity; treat blank as absent so "" and NULL don't
    split into two rows for the same card."""
    return (network or "").strip() or None


def resolve_funding_account(
    conn: sqlite3.Connection,
    amazon_account_id: Optional[str],
    last4: Optional[str],
    network: Optional[str],
) -> FundingResolution:
    """Resolve an instrument to a funding disposition, preferring a per-account override over the global
    default. An instrument with no last-4 (a bare off-card leg) can't be keyed, so it is ``unmapped``."""
    if not last4:
        return FundingResolution("unmapped")
    net = normalize_network(network)
    scopes = []
    if amazon_account_id:
        scopes.append(("amazon_account_id = ?", (amazon_account_id,)))
    scopes.append(("amazon_account_id IS NULL", ()))
    for scope_clause, scope_params in scopes:
        row = conn.execute(
            f"""SELECT funding_account_id
                FROM   amazon_funding_map
                WHERE  last4 = ? AND COALESCE(network, '') = COALESCE(?, '') AND {scope_clause}
                LIMIT  1""",
            (last4, net, *scope_params),
        ).fetchone()
        if row is not None:
            state = "untracked" if row["funding_account_id"] is None else "mapped"
            return FundingResolution(state, row["funding_account_id"])
    return FundingResolution("unmapped")


def upsert_funding_source(
    conn: sqlite3.Connection,
    *,
    last4: str,
    network: Optional[str] = None,
    funding_account_id: Optional[str] = None,
    untracked: bool = False,
    amazon_account_id: Optional[str] = None,
) -> str:
    """Create or update the mapping for one instrument in one scope. ``untracked`` forces
    ``funding_account_id`` NULL (the explicit "not an account I hold" state). Idempotent per
    ``(last4, network, scope)`` — a repeat updates the funding account rather than inserting a duplicate.
    Returns the row id."""
    net = normalize_network(network)
    resolved_funding = None if untracked else funding_account_id
    if amazon_account_id:
        existing = conn.execute(
            """SELECT id FROM amazon_funding_map
               WHERE last4 = ? AND COALESCE(network, '') = COALESCE(?, '') AND amazon_account_id = ?""",
            (last4, net, amazon_account_id),
        ).fetchone()
    else:
        existing = conn.execute(
            """SELECT id FROM amazon_funding_map
               WHERE last4 = ? AND COALESCE(network, '') = COALESCE(?, '') AND amazon_account_id IS NULL""",
            (last4, net),
        ).fetchone()
    if existing:
        conn.execute(
            "UPDATE amazon_funding_map SET funding_account_id = ?, updated_at = datetime('now') WHERE id = ?",
            (resolved_funding, existing["id"]),
        )
        return existing["id"]
    new_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO amazon_funding_map (id, last4, network, amazon_account_id, funding_account_id)
           VALUES (?, ?, ?, ?, ?)""",
        (new_id, last4, net, amazon_account_id, resolved_funding),
    )
    return new_id


def delete_funding_source(conn: sqlite3.Connection, mapping_id: str) -> bool:
    """Remove a mapping (returning it to the unmapped state). Returns whether a row was deleted."""
    cur = conn.execute("DELETE FROM amazon_funding_map WHERE id = ?", (mapping_id,))
    return cur.rowcount > 0


def list_funding_map(conn: sqlite3.Connection) -> list[dict]:
    """All mappings, joined with account display names for the UI. Global rows first, then overrides;
    within each, by instrument."""
    rows = conn.execute(
        """SELECT m.id, m.last4, m.network, m.amazon_account_id, m.funding_account_id,
                  fa.display_name AS funding_account_display, fa.name AS funding_account_name,
                  aa.display_name AS amazon_account_display, aa.name AS amazon_account_name
           FROM   amazon_funding_map m
           LEFT   JOIN account fa ON fa.id = m.funding_account_id
           LEFT   JOIN account aa ON aa.id = m.amazon_account_id
           ORDER  BY m.amazon_account_id IS NOT NULL, m.last4, m.network"""
    ).fetchall()
    result = []
    for r in rows:
        untracked = r["funding_account_id"] is None
        result.append(
            {
                "id": r["id"],
                "last4": r["last4"],
                "network": r["network"],
                "amazon_account_id": r["amazon_account_id"],
                "amazon_account_name": r["amazon_account_display"] or r["amazon_account_name"],
                "funding_account_id": r["funding_account_id"],
                "funding_account_name": (r["funding_account_display"] or r["funding_account_name"]),
                "untracked": untracked,
            }
        )
    return result
