# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Pair a refund with the payment it returns, where the source says which one that is.

A PayPal statement names, on each refund, the payment it refunds: the refund's ``Ref ID`` is that
payment's ``Transaction ID`` (the activity CSV's optional ``Reference Txn ID`` column says the same). A
reversal of a payment received refers to it the same way. Nothing is inferred — no amount-and-date
guessing — so a pair is made only where the reference is stated, and it may cross imports: a refund
may land in a later statement than its payment, and statements may be imported in any order.

**The refund takes the payment's category, and keeps following it.** Money back is not income; it offsets
what was spent (see ``docs/data-model.md`` → *Reporting assumptions*), which is only true in the totals
when the refund sits in the payment's category. So the refund is recategorized to the payment's category
with the feature-owned source ``refund``, and a trigger (``trg_refund_follows_payment``, created in
``init_db``) moves it whenever the payment's category changes — by a hand edit, bulk edit, a rule or
anything else, since a trigger is the one place no write path can go around. Automatic categorization
leaves a ``refund`` row alone (``FEATURE_OWNED_CATEGORY_SOURCES``), so no rule pulls it away from its
payment. Setting the refund's category by hand makes it the user's, and it stops following. A refund
already categorized by hand is linked but not moved, and so is the refund of a split payment, which has
no single category to follow.

**Reversal restores only what is still the pairing's.** Undoing the import that brought either row in
(``undo_batches`` runs ``reverse_batch_refund_links`` before the rows go), or losing the payment by any
other deletion (healed on the next pass), puts the refund's category back only while it is still
following; a category chosen since is the user's and is left alone.

The link is ``kind='refund'``, roles ``payment`` / ``refund``, with the refund's prior categorization in
its metadata. See ``docs/data-model.md`` → *Refunds*.
"""

from __future__ import annotations

import sqlite3
from contextlib import AbstractContextManager
from typing import Iterable, Optional

from backend.app_logging import log_error
from backend.services import txn_links
from backend.services.categorizer import FEATURE_OWNED_CATEGORY_SOURCES, category_lock_for
from backend.services.money_movement import captured_field, captured_reference, captured_type, is_refund_type

LINK_KIND = "refund"
PAYMENT_ROLE = "payment"
REFUND_ROLE = "refund"
REFUND_CATEGORY_SOURCE = "refund"

# Half a cent: a refund may return part of a payment but never more than it.
_CENT = 0.005


def _refund_candidates(conn: sqlite3.Connection) -> list[dict]:
    """Refund rows carrying a stated reference that are not paired yet. The evidence text is narrowed by
    `LIKE` before anything is parsed, so a ledger with no referencing source costs one scan and nothing
    more."""
    rows = conn.execute(
        """SELECT t.id, t.amount, t.import_evidence_json, t.category_id, t.category_source,
                  t.category_overridden, COALESCE(a.parent_account_id, t.account_id) AS root_id
           FROM   txn t JOIN account a ON a.id = t.account_id
           WHERE  t.trashed_at IS NULL
             AND  (t.import_evidence_json LIKE '%"ref id"%' OR t.import_evidence_json LIKE '%"reference txn id"%')
             AND  NOT EXISTS (SELECT 1 FROM txn_link_member m JOIN txn_link l ON l.id = m.link_id
                              WHERE m.txn_id = t.id AND l.kind = ? AND m.role = ?)""",
        (LINK_KIND, REFUND_ROLE),
    ).fetchall()
    return [dict(r) for r in rows
            if is_refund_type(captured_type(r["import_evidence_json"])) and captured_reference(r["import_evidence_json"])]


def _payments_by_transaction_id(conn: sqlite3.Connection, root_ids: set[str]) -> dict[str, dict]:
    """Every row on the given account groups that carries a Transaction ID, keyed by it."""
    placeholders = ",".join("?" * len(root_ids))
    rows = conn.execute(
        f"""SELECT t.id, t.amount, t.is_split, t.category_id, COALESCE(a.parent_account_id, t.account_id) AS root_id,
                   t.import_evidence_json
            FROM   txn t JOIN account a ON a.id = t.account_id
            WHERE  t.trashed_at IS NULL
              AND  COALESCE(a.parent_account_id, t.account_id) IN ({placeholders})
              AND  t.import_evidence_json LIKE '%"transaction id"%'""",
        sorted(root_ids),
    ).fetchall()
    out: dict[str, dict] = {}
    for row in rows:
        transaction_id = captured_field(row["import_evidence_json"], "transaction id")
        if transaction_id:
            out[transaction_id] = dict(row)
    return out


def _returns(refund: dict, payment: dict) -> bool:
    """Whether `refund` can be money back on `payment`: the same account group, the other direction, and no
    more than was paid."""
    if refund["id"] == payment["id"] or refund["root_id"] != payment["root_id"]:
        return False
    refund_amount, payment_amount = float(refund["amount"] or 0), float(payment["amount"] or 0)
    return refund_amount * payment_amount < 0 and abs(refund_amount) <= abs(payment_amount) + _CENT


def _follow(conn: sqlite3.Connection, refund: dict, payment: dict) -> Optional[dict]:
    """Put the refund in the payment's category, returning what it held so a reversal can put it back —
    or None, leaving it alone, where the refund's category is the user's or another feature's, or the
    payment has no single category to follow."""
    if refund["category_overridden"] or refund["category_source"] in FEATURE_OWNED_CATEGORY_SOURCES:
        return None
    if payment["is_split"]:
        return None
    conn.execute(
        "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = 0 WHERE id = ?",
        (payment["category_id"], REFUND_CATEGORY_SOURCE, refund["id"]),
    )
    return {
        "category_id": refund["category_id"],
        "category_source": refund["category_source"],
        "category_overridden": refund["category_overridden"],
    }


def _release(conn: sqlite3.Connection, link_id: str) -> None:
    """Delete a pairing, putting the refund's category back if it survives and is still following."""
    link = txn_links.get_link(conn, link_id)
    if not link or link["kind"] != LINK_KIND:
        return
    prior = (link.get("metadata") or {}).get("refund_prior")
    if isinstance(prior, dict):
        for refund_id in (m["txn_id"] for m in link["members"] if m["role"] == REFUND_ROLE):
            conn.execute(
                """UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ?
                   WHERE id = ? AND category_source = ?""",
                (prior.get("category_id"), prior.get("category_source"),
                 category_lock_for(prior.get("category_source"), prior.get("category_overridden")),
                 refund_id, REFUND_CATEGORY_SOURCE),
            )
    txn_links.delete_link(conn, link_id)


def _heal(conn: sqlite3.Connection) -> int:
    """Drop the pairings that lost a row. A member cascades away with its transaction, but the link has no
    foreign key, so a refund whose payment was emptied from Trash or removed with an account merge would
    otherwise go on following nothing, out of every rule's reach."""
    stale = conn.execute(
        """SELECT l.id FROM txn_link l LEFT JOIN txn_link_member m ON m.link_id = l.id
           WHERE  l.kind = ? GROUP BY l.id HAVING COUNT(m.txn_id) < 2""",
        (LINK_KIND,),
    ).fetchall()
    for row in stale:
        _release(conn, row["id"])
    return len(stale)


def pair_stated_refunds(conn: sqlite3.Connection) -> dict:
    """Heal what lost its rows, then pair each unpaired refund with the payment it names. Returns
    ``{"paired": n, "healed": n}``."""
    healed = _heal(conn)
    refunds = _refund_candidates(conn)
    if not refunds:
        return {"paired": 0, "healed": healed}
    payments = _payments_by_transaction_id(conn, {r["root_id"] for r in refunds})
    paired = 0
    for refund in refunds:
        payment = payments.get(captured_reference(refund["import_evidence_json"]))
        if payment is None or not _returns(refund, payment):
            continue
        prior = _follow(conn, refund, payment)
        txn_links.create_link(
            conn, LINK_KIND,
            [(payment["id"], PAYMENT_ROLE), (refund["id"], REFUND_ROLE)],
            metadata={"refund_prior": prior},
        )
        paired += 1
    return {"paired": paired, "healed": healed}


def pair_refunds_after_ingest(connection: AbstractContextManager) -> None:
    """Run the pass once an import's rows are committed, in the connection context manager given. Like the
    PayPal funding pass it runs after the ingest transaction, never inside it, since it reads beyond the
    batch; and a failure is logged rather than allowed to fail an import that already landed its rows."""
    try:
        with connection as conn:
            pair_stated_refunds(conn)
    except Exception as e:
        log_error(f"[refund-links] pairing pass failed: {e}", exc_info=e)


def reverse_batch_refund_links(conn: sqlite3.Connection, batch_id: str) -> int:
    """Undo the pairings that involve a batch's rows, before those rows are deleted: a refund outside the
    batch gets its category back, and the link goes. Returns the number of pairings reversed."""
    link_ids = [
        r["id"] for r in conn.execute(
            """SELECT DISTINCT l.id FROM txn_link l
               JOIN txn_link_member m ON m.link_id = l.id
               JOIN txn t ON t.id = m.txn_id
               WHERE l.kind = ? AND t.import_batch_id = ?""",
            (LINK_KIND, batch_id),
        ).fetchall()
    ]
    for link_id in link_ids:
        _release(conn, link_id)
    return len(link_ids)


def following_refund_ids(conn: sqlite3.Connection, payment_ids: Iterable[str]) -> list[str]:
    """The refunds currently following any of the given payments — the rows a category write on those
    payments also moved (through the trigger), for a caller that has to tell its client which rows to
    refresh."""
    ids = list(dict.fromkeys(payment_ids))
    found: list[str] = []
    # Chunked: a bulk edit over "all matching" can name more rows than one statement may bind.
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        found += [r["id"] for r in conn.execute(
            f"""SELECT DISTINCT t.id
                FROM   txn_link_member p
                JOIN   txn_link l ON l.id = p.link_id AND l.kind = ?
                JOIN   txn_link_member r ON r.link_id = p.link_id AND r.role = ?
                JOIN   txn t ON t.id = r.txn_id
                WHERE  p.role = ? AND p.txn_id IN ({",".join("?" * len(chunk))}) AND t.category_source = ?""",
            (LINK_KIND, REFUND_ROLE, PAYMENT_ROLE, *chunk, REFUND_CATEGORY_SOURCE),
        ).fetchall()]
    return list(dict.fromkeys(found))


def refund_map_for(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> dict[str, dict]:
    """Per transaction, the other side of its refund pairings as the ledger row's link marker shows them:
    ``{"role": "payment" | "refund", "others": [{id, name, date, amount}, …]}``. A payment may have been
    refunded more than once (in parts), so `others` is a list; a refund names one payment. The rows on the
    other side are carried whole enough to name and open, not to act on — the marker opens the other
    transaction, which is where anything is done. A trashed row on the other side is left out."""
    ids = [txn_id for txn_id in dict.fromkeys(txn_ids) if txn_id]
    mapped: dict[str, dict] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for row in conn.execute(
            f"""SELECT me.txn_id AS txn_id, me.role AS role, o.id AS other_id, o.date, o.amount,
                       COALESCE(o.display_name, o.merchant_name, o.raw_name) AS name
                FROM   txn_link_member me
                JOIN   txn_link l ON l.id = me.link_id AND l.kind = ?
                JOIN   txn_link_member other ON other.link_id = me.link_id AND other.txn_id <> me.txn_id
                JOIN   txn o ON o.id = other.txn_id AND o.trashed_at IS NULL
                WHERE  me.txn_id IN ({",".join("?" * len(chunk))})
                ORDER  BY o.date, o.id""",
            (LINK_KIND, *chunk),
        ):
            entry = mapped.setdefault(row["txn_id"], {"role": row["role"], "others": []})
            entry["others"].append(
                {"id": row["other_id"], "name": row["name"], "date": row["date"], "amount": row["amount"]}
            )
    return mapped
