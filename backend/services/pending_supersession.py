# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Retiring a held pending row that a provider without a change feed has stopped sending.

A provider with a change feed says when a pending charge is superseded: Plaid names the pending row a
posted one replaces (`pending_external_transaction_id`) and lists a cancelled one in `removed`. SimpleFIN
says neither. A charge that settles at its pending amount keeps its id and is refreshed in place, but one
whose amount changes as it settles (a tip added to a restaurant charge, observed live) posts under a
**new** id, and the pending row is simply no longer in the response. Duplicate detection cannot pair the
two either, the amounts differing, so the pending row stayed in the ledger indefinitely.

The evidence used instead is absence. An adapter may report a **complete listing**: an account and a date
range for which the response holds every transaction the provider has, pending ones included. A pending
row this connection holds, dated inside such a range and missing from the response, is gone at the
provider. What happens to it:

- **Paired** with the posted row that replaced it, when exactly one arriving posted row qualifies and that
  row qualifies for no other vanished pending row: the pairing is written as the
  `pending_external_transaction_id` a change feed would have sent, so the sync's existing in-place
  conversion keeps the user's category, name and tags.
- **Removed** otherwise (a cancelled hold, or a settlement with no clear replacement), through the same
  deferred `removed` path a change feed's removals take. A pending row that a duplicate resolution kept
  over a posted copy is the charge's only live record, so that posted copy is restored first and takes
  over the pending row's edits (`reinstate_displaced_posted`).

An adapter that reports no listing changes nothing here; the default is that absence proves nothing.
"""

from __future__ import annotations

from datetime import date
from typing import Callable

from backend.services.duplicate_detection import (
    classify_text_match,
    reinstate_displaced_posted,
    source_match_texts,
)

# How far the posted row's date may sit from the pending row's. A charge's transaction date can move by a
# day between its pending and posted forms, so equal dates alone would miss some settlements.
PAIRING_MAX_DAY_GAP = 2

# The largest posted amount, as a multiple of the pending one, still read as that charge settling. A
# settlement that changes the amount adds a tip, which can be a large share of a small charge; a posted row
# below the pending amount is not paired, since a smaller settlement is a hold released, not this charge.
PAIRING_MAX_GROWTH = 2.0


def oldest_held_pending_date(conn, connection_id: str) -> str | None:
    """The date of the oldest live pending row this connection brought in, so an adapter can reach back to
    it and list its range completely. None when the connection holds no pending row."""
    row = conn.execute(
        """
        SELECT MIN(t.date) AS oldest
        FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
        WHERE  b.connection_id = ? AND t.is_pending = 1 AND t.trashed_at IS NULL
          AND  t.external_transaction_id IS NOT NULL
        """,
        (connection_id,),
    ).fetchone()
    return row["oldest"] if row else None


def settle_vanished_pending(conn, connection_id: str, added: list[dict], listings: list[dict] | None, *,
                            account_for: Callable) -> list[str]:
    """Pair or remove the pending rows a page's complete listings show are gone at the provider.

    Pairings are written onto the arriving rows in `added` (as `pending_external_transaction_id`), so this
    must run before the page is applied. Returns the external ids of the vanished rows nothing replaced,
    for the caller to apply as removals after the drain."""
    removed: list[str] = []
    for listing in listings or []:
        external_account_id = listing.get("external_account_id")
        account = account_for(external_account_id) if external_account_id else None
        if not (account and listing.get("start") and listing.get("end")):
            continue
        arriving = [t for t in added if t["external_account_id"] == external_account_id]
        arriving_ids = {t["external_transaction_id"] for t in arriving}
        vanished = [
            dict(r) for r in conn.execute(
                """
                SELECT t.id, t.external_transaction_id, t.date, t.amount, t.merchant_name, t.raw_name
                FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
                WHERE  b.connection_id = ? AND t.account_id = ? AND t.is_pending = 1
                  AND  t.trashed_at IS NULL AND t.external_transaction_id IS NOT NULL
                  AND  t.date BETWEEN ? AND ?
                """,
                (connection_id, account["id"], listing["start"], listing["end"]),
            )
            if r["external_transaction_id"] not in arriving_ids
        ]
        if not vanished:
            continue
        candidates = _unheld(conn, [
            t for t in arriving if not t["is_pending"] and not t.get("pending_external_transaction_id")
        ])
        pairs = _unambiguous_pairs(vanished, candidates)
        for pending in vanished:
            replacement = pairs.get(pending["external_transaction_id"])
            if replacement is not None:
                replacement["pending_external_transaction_id"] = pending["external_transaction_id"]
            else:
                reinstate_displaced_posted(conn, pending["id"])
                removed.append(pending["external_transaction_id"])
    return removed


def _unheld(conn, rows: list[dict]) -> list[dict]:
    """The rows whose provider id the ledger does not hold yet. A held one is a settlement already
    recorded, and pairing it would give a pending row an id another row owns."""
    if not rows:
        return []
    ids = [t["external_transaction_id"] for t in rows]
    held = {r["external_transaction_id"] for r in conn.execute(
        f"SELECT external_transaction_id FROM txn WHERE external_transaction_id IN ({','.join('?' * len(ids))})",
        ids,
    )}
    return [t for t in rows if t["external_transaction_id"] not in held]


def _unambiguous_pairs(vanished: list[dict], candidates: list[dict]) -> dict[str, dict]:
    """{pending external id: the arriving row that replaced it}, only where each side has exactly one
    qualifying partner. Two same-merchant charges near each other are ordinary, and choosing between them
    would carry one charge's edits onto another."""
    matches = {
        p["external_transaction_id"]: [c for c in candidates if _supersedes(p, c)] for p in vanished
    }
    claimants: dict[str, int] = {}
    for found in matches.values():
        for c in found:
            claimants[c["external_transaction_id"]] = claimants.get(c["external_transaction_id"], 0) + 1
    return {
        pending_id: found[0] for pending_id, found in matches.items()
        if len(found) == 1 and claimants[found[0]["external_transaction_id"]] == 1
    }


def _supersedes(pending: dict, posted: dict) -> bool:
    """Whether `posted` reads as `pending` settling: same direction, the same or a somewhat larger amount,
    a date within `PAIRING_MAX_DAY_GAP`, and descriptors that agree at the exact tier (identical once a
    processor tag is set aside, or one a truncation of the other)."""
    before, after = float(pending["amount"] or 0), float(posted["amount"] or 0)
    if before * after <= 0 or not abs(before) <= abs(after) <= abs(before) * PAIRING_MAX_GROWTH:
        return False
    try:
        gap = abs((date.fromisoformat(posted["date"]) - date.fromisoformat(pending["date"])).days)
    except (TypeError, ValueError):
        return False
    if gap > PAIRING_MAX_DAY_GAP:
        return False
    return classify_text_match(
        source_match_texts(pending["merchant_name"], pending["raw_name"], None),
        source_match_texts(posted["merchant_name"], posted["raw_name"], None),
    ) == "exact"
