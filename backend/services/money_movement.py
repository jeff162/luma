# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Suppress a wallet's paired funding legs at import time.

A wallet-style source (PayPal, Venmo, …) records a single balance-funded purchase as **two** rows in
one export: the payment out to the merchant, and an equal-and-opposite deposit *into* the wallet balance
that covers it. The deposit is money movement — a transfer from a bank/card into the wallet — not income;
left alone it shows as a phantom inflow that cancels the purchase in totals while inflating both sides.

This pass pairs those two rows *within a single import batch* and moves only the **funding leg** (the
deposit) into an excluded "Money movement" category, linking it to its purchase via ``txn_link`` so the
association is recorded and reversible. The purchase stays as real spending.

Deliberately conservative, because suppression must never swallow a genuine inbound payment:

  * **Structural signal is primary.** A leg is a *nameless credit* (money into the wallet, no merchant)
    whose exact equal-and-opposite same-day twin is a *named debit* (a real purchase). A genuine payment
    *to* the user carries a merchant name and has no offsetting same-day purchase, so it can never match.
  * **Only an unambiguous 1:1 pair acts.** If two rows share the same date and magnitude on either side,
    the pairing is ambiguous and the whole group is left untouched (a safe miss, resolvable by hand).
  * **``Type`` is corroborating, not required** (see ``docs/backlog/paypal-amazon-enrichment.md``). PayPal's
    ``Type`` ("Bank Deposit to PP Account", "General Card Deposit", …) is captured as evidence and, when
    present, confirms the leg — but the pass still works when it wasn't captured. Its value is recorded on
    the link, and any *unrecognized* type seen on a suppressed leg is reported, so the recognized set (a
    code constant today) can be grown deliberately later.

Both legs of a pair are rows the batch owns, so ``undo_batch`` / re-import replace delete them directly;
the reverse pass exists to drop the now-orphaned link (``txn_link`` has no FK to ``txn``) and — for
robustness against a future cross-batch pairing — restore any surviving leg's prior category.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Optional

from backend.services import txn_links

LINK_KIND = "wallet_funding"
MONEY_MOVEMENT_CATEGORY = "Money movement"

# The seed vocabulary of PayPal money-movement `Type` values (casefolded). Corroborating only — an
# unrecognized value never blocks a structurally-clear pair, it is surfaced instead (see module docstring).
# Kept as a code constant for now; growing it from observed exports is a tracked follow-up.
_MONEY_MOVEMENT_TYPES = frozenset({
    "bank deposit to pp account",
    "general card deposit",
    "general withdrawal",
    "add money from a bank account",
    "general credit card deposit",
})


def _default_money_movement_category(conn: sqlite3.Connection) -> str:
    """The excluded category funding legs are moved into: a leaf named "Money movement" under the seeded
    ``Transfers`` group (which carries ``exclude_from_totals = 1``). The leaf is created excluded in its own
    right too, so it drops out of spending totals even if the parent group is missing. Mirrors
    ``import_export.amazon._default_funding_category`` — a candidate for a shared "transfers leaf" helper if
    a third client appears."""
    transfers = conn.execute(
        "SELECT id FROM category WHERE name = 'Transfers' AND parent_id IS NULL"
    ).fetchone()
    parent_id = transfers["id"] if transfers else None
    existing = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id IS ?",
        (MONEY_MOVEMENT_CATEGORY, parent_id),
    ).fetchone()
    if existing:
        return existing["id"]
    new_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals)
           VALUES (?, ?, ?, 'expense', 1)""",
        (new_id, parent_id, MONEY_MOVEMENT_CATEGORY),
    )
    return new_id


def _resolved_name(row) -> str:
    """The merchant as the UI resolves it (display → merchant → raw); empty string when the row is
    nameless, which is the funding-leg signal."""
    for key in ("display_name", "merchant_name", "raw_name"):
        value = str(row[key] or "").strip()
        if value:
            return value
    return ""


def _leg_type(evidence_json: Optional[str]) -> Optional[str]:
    """The captured ``Type`` value from a row's import evidence, or None. Read from ``extra_text_fields``
    (where the categorical capture lands), matched case-insensitively on the header."""
    if not evidence_json:
        return None
    try:
        evidence = json.loads(evidence_json)
    except (ValueError, TypeError):
        return None
    if not isinstance(evidence, dict):
        return None
    for field in evidence.get("extra_text_fields") or []:
        if isinstance(field, dict) and str(field.get("header") or "").strip().casefold() == "type":
            value = str(field.get("value") or "").strip()
            return value or None
    return None


def suppress_batch_funding_legs(conn: sqlite3.Connection, batch_id: str) -> dict:
    """Pair and suppress the batch's wallet funding legs. Returns
    ``{"suppressed": [ {leg_id, purchase_id, amount, date, leg_type, recognized_type}, … ],
       "unrecognized_types": [sorted str]}`` — the count is ``len(suppressed)``.

    Each suppressed leg is recategorized into the excluded "Money movement" category and linked to its
    purchase; the leg's prior categorization is stashed in the link metadata for reversal."""
    rows = conn.execute(
        """SELECT id, account_id, date, amount, display_name, merchant_name, raw_name, import_evidence_json,
                  category_id, category_source, category_overridden
           FROM   txn
           WHERE  import_batch_id = ? AND trashed_at IS NULL""",
        (batch_id,),
    ).fetchall()

    # Group by the pairing key: same account, same date, same magnitude. A funding leg and its purchase
    # share all three; anything ambiguous within a group is left alone.
    groups: dict[tuple, dict[str, list]] = {}
    for row in rows:
        if row["amount"] is None:
            continue
        key = (row["account_id"], row["date"], round(abs(float(row["amount"])), 2))
        bucket = groups.setdefault(key, {"legs": [], "purchases": []})
        amount = float(row["amount"])
        named = bool(_resolved_name(row))
        if amount < 0 and not named:          # nameless credit → money into the wallet: a funding leg
            bucket["legs"].append(row)
        elif amount > 0 and named:            # named debit → a real purchase
            bucket["purchases"].append(row)

    suppressed: list[dict] = []
    unrecognized: set[str] = set()
    category_id: Optional[str] = None

    for bucket in groups.values():
        # Only an unambiguous 1:1 pair is safe to act on.
        if len(bucket["legs"]) != 1 or len(bucket["purchases"]) != 1:
            continue
        leg, purchase = bucket["legs"][0], bucket["purchases"][0]
        leg_type = _leg_type(leg["import_evidence_json"])
        recognized = bool(leg_type) and leg_type.casefold() in _MONEY_MOVEMENT_TYPES
        if leg_type and not recognized:
            unrecognized.add(leg_type)

        if category_id is None:
            category_id = _default_money_movement_category(conn)
        leg_prior = {
            "category_id": leg["category_id"],
            "category_source": leg["category_source"],
            "category_overridden": leg["category_overridden"],
        }
        conn.execute(
            "UPDATE txn SET category_id = ?, category_source = 'enrichment', category_overridden = 0 WHERE id = ?",
            (category_id, leg["id"]),
        )
        txn_links.create_link(
            conn, LINK_KIND,
            [(leg["id"], "leg"), (purchase["id"], "purchase")],
            metadata={"leg_prior": leg_prior, "leg_type": leg_type},
        )
        suppressed.append({
            "leg_id": leg["id"],
            "purchase_id": purchase["id"],
            "amount": round(abs(float(leg["amount"])), 2),
            "date": leg["date"],
            "leg_type": leg_type,
            "recognized_type": recognized,
        })

    return {"suppressed": suppressed, "unrecognized_types": sorted(unrecognized)}


def reverse_batch_money_movement_links(conn: sqlite3.Connection, batch_id: str) -> int:
    """Undo the funding-leg links a batch created: restore each leg's stashed prior category (a no-op when
    the leg is a batch row about to be deleted, but correct should a leg ever live outside the batch) and
    delete the link. Must run *before* the batch's own rows are deleted, so the member→txn join still
    resolves the links to drop. Returns the number of links reversed."""
    link_ids = [
        row["id"]
        for row in conn.execute(
            """SELECT DISTINCT l.id
               FROM   txn_link l
               JOIN   txn_link_member m ON m.link_id = l.id
               JOIN   txn t ON t.id = m.txn_id
               WHERE  l.kind = ? AND t.import_batch_id = ?""",
            (LINK_KIND, batch_id),
        ).fetchall()
    ]
    for link_id in link_ids:
        link = txn_links.get_link(conn, link_id)
        meta = (link.get("metadata") or {}) if link else {}
        prior = meta.get("leg_prior") if isinstance(meta, dict) else None
        if isinstance(prior, dict):
            for leg_id in txn_links.member_txn_ids(conn, link_id, role="leg"):
                conn.execute(
                    "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
                    (prior.get("category_id"), prior.get("category_source"),
                     int(prior.get("category_overridden") or 0), leg_id),
                )
        txn_links.delete_link(conn, link_id)
    return len(link_ids)
