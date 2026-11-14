# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The rows a link keeps out of the totals so that the same money counts once.

An Amazon order's card charge, a wallet funding leg, and the excluded side of a PayPal funding pair each
record money another row already counts (or, for a PayPal transfer, money that never left the
household). The owning feature moves the row into an excluded category when it links it. Two readers
need to know which rows those are, and they ask different questions:

- **`held_txn_ids_sql`: which rows must stay out of the totals.** A rule apply may not take one, because
  a rule's category un-excludes the row and counts the money twice. The judgement is the link plus the
  row's category being excluded *now*, not how it got there: a hand edit that files the row in an
  excluded category leaves it just as held, and a row the user has filed in a counted category is their
  decision, which the user makes by editing or unlinking it.
- **`second_record_txn_ids_sql`: which rows are a second record of money another row counts.** Recurring
  detection leaves these out, since the counted row carries the series. A PayPal transfer pair's legs are
  held but are not second records: the two opposite legs are the movement transfer pairing reads. A
  wallet leg is neither the counted purchase nor a duplicate of it, so it stays in the pool as well.

Each returns `(sql, params)` for a `t.id NOT IN (...)` clause.
"""

from __future__ import annotations

from backend.services.amazon_order_amount import LINK_KIND as AMAZON_ORDER_KIND
from backend.services.money_movement import LINK_KIND as WALLET_FUNDING_KIND

AMAZON_CHARGE_ROLE = "charge"
WALLET_LEG_ROLE = "leg"


def _paypal():
    # Imported here because paypal_funding reaches recurring_detection, a caller of this module, through
    # txn_trash.
    from backend.services import paypal_funding
    return paypal_funding


def held_txn_ids_sql() -> tuple[str, tuple]:
    paypal = _paypal()
    sql = """
        SELECT m.txn_id
        FROM   txn_link l
        JOIN   txn_link_member m ON m.link_id = l.id
        JOIN   txn ht ON ht.id = m.txn_id
        JOIN   category hc ON hc.id = ht.category_id
        LEFT   JOIN category hpc ON hpc.id = hc.parent_id
        WHERE  ((l.kind = ? AND m.role = ?) OR (l.kind = ? AND m.role = ?) OR (l.kind = ? AND m.role IN (?, ?)))
          AND  COALESCE(hpc.exclude_from_totals, hc.exclude_from_totals, 0) <> 0
    """
    return sql, (AMAZON_ORDER_KIND, AMAZON_CHARGE_ROLE, WALLET_FUNDING_KIND, WALLET_LEG_ROLE,
                 paypal.LINK_KIND, paypal.PAYPAL_ROLE, paypal.COUNTERPART_ROLE)


def second_record_txn_ids_sql() -> tuple[str, tuple]:
    # A PayPal payment pair has its two rows in the same direction; the card or bank side is the second
    # record only when the pairing excluded it (`enrichment`), since a pair whose PayPal row was already
    # excluded leaves the card row as the one that counts.
    paypal = _paypal()
    sql = """
        SELECT m.txn_id
        FROM   txn_link l
        JOIN   txn_link_member m ON m.link_id = l.id AND m.role = ?
        WHERE  l.kind = ?
        UNION ALL
        SELECT c.txn_id
        FROM   txn_link l
        JOIN   txn_link_member c  ON c.link_id = l.id AND c.role = ?
        JOIN   txn_link_member pm ON pm.link_id = l.id AND pm.role = ?
        JOIN   txn ct ON ct.id = c.txn_id
        JOIN   txn pt ON pt.id = pm.txn_id
        WHERE  l.kind = ?
          AND  (ct.amount > 0) = (pt.amount > 0)
          AND  ct.category_source = 'enrichment'
    """
    return sql, (AMAZON_CHARGE_ROLE, AMAZON_ORDER_KIND, paypal.COUNTERPART_ROLE, paypal.PAYPAL_ROLE,
                 paypal.LINK_KIND)
