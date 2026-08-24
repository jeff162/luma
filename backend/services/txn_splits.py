# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Transaction splits — allocating one transaction's amount across several categories.

A split keeps the ledger at **one row per purchase** and hangs a set of allocations off it
(``txn_split``), rather than exploding the purchase into child transactions. The parts must sum to the
transaction's amount and share its sign, and at most one part may name a given category. ``txn.is_split``
marks the transaction while ``txn.category_id`` retains the pre-split category as the stashed prior that
un-splitting restores.

Two things in here are load-bearing beyond the CRUD:

**The expansion seam** (``txn_effective_sql``). Every category rollup in the app is phrased against a
single alias — ``t.category_id``, ``t.amount``, ``t.id`` — so making splits count correctly is a matter of
substituting the *row source* rather than rewriting the aggregations. Expanded, a non-split transaction
yields itself and a split transaction yields one row per allocation carrying the part's category and
amount. Every facet helper, uncategorized sentinel, signed-total expression, and `exclude_from_totals`
guard then applies per allocation without being touched. Expansion is opt-in per query because the
ledger must still show one row per purchase: summaries always expand, the transaction list expands only
when a category-shaped facet scopes it, and everything else (dedupe, rules, import, export) reads plain
``txn``.

**Protection.** A split is *feature-owned* categorization (``category_source = 'split'``), the same shape
as an enrichment exclusion rather than a plain manual override: the automatic passes skip it by source,
and the one path that overwrites even a manual edit — a full-force rule apply — refuses it and reports a
count instead. The reason splits diverge from enrichment there is that an enrichment row's prior is
recoverable from its link metadata, while a split is hand-built work with no other record.

See ``docs/backlog/transaction-splits.md`` for the decisions and the alternatives that were rejected.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Iterable, Optional, Sequence

# Provenance value stamped on a split transaction's `category_source`. Automatic categorization skips
# rows by this value, exactly as it skips 'enrichment'.
SPLIT_CATEGORY_SOURCE = "split"

# Allocations are money, so they reconcile at cent precision. Comparing floats for exact equality would
# reject a perfectly good split whose parts were entered in the UI and round-tripped through JSON.
_CENT = 0.005

# The minimum number of parts a split can have. One part is not a split — it is a category assignment,
# and letting it through would leave a row flagged `is_split` that reports identically to an ordinary
# one while being skipped by every automatic pass.
MIN_PARTS = 2

# Marketplace item titles are routinely 200+ characters (a real one seen in the wild ran past 230),
# which is a paragraph rather than a label. Stored text is capped so a pasted title cannot bloat every
# read of the row; the display side truncates further and shows the whole value on hover.
MAX_LABEL_LENGTH = 200


class SplitValidationError(ValueError):
    """A proposed set of allocations is not a valid split. Carries a user-facing message."""


def _txn_columns(conn: sqlite3.Connection) -> list[str]:
    return [r["name"] for r in conn.execute("PRAGMA table_info(txn)")]


def txn_effective_sql(conn: sqlite3.Connection, *, expand: bool) -> str:
    """The row source a category-aware query selects `FROM`, aliased by the caller as `t`.

    Unexpanded this is just the table. Expanded it is `txn` left-joined to its allocations, with the
    allocation's `category_id` and `amount` standing in for the transaction's own wherever one matched:
    a non-split transaction joins to nothing and yields itself, a split one yields a row per part. The
    column list is read from the schema rather than written out, so a column added to `txn` flows
    through the seam automatically instead of silently vanishing from every expanded query.

    **Why a LEFT JOIN and not a UNION of the split and non-split branches.** The union reads `txn`
    twice, and measured on a real-scale ledger (~18.5k rows, no splits at all) that cost ~80% on top of
    every summary query, against ~6% for the join — an expansion nobody is using should be close to
    free. The join is also the more robust shape: the substitution keys on whether a part row *matched*
    (`s.txn_id`, NOT NULL in the table) rather than on its values, so a part whose category was deleted
    out from under it stays uncategorized instead of silently falling back to the transaction's own
    category, and neither of the two inconsistent states — a flag with no parts, parts with no flag —
    can make a transaction vanish from the totals or be counted twice.
    """
    if not expand:
        return "txn"
    cols = _txn_columns(conn)
    projected = ", ".join(
        _PART_OVERRIDE[c] if c in _PART_OVERRIDE else f"t.{c}" for c in cols
    )
    return f"(SELECT {projected} FROM txn t LEFT JOIN txn_split s ON s.txn_id = t.id)"


# The two columns an allocation speaks for. `s.txn_id IS NULL` is the "no part matched" test — the join
# key is NOT NULL in txn_split, so it distinguishes a missing row from a part whose own value is NULL.
_PART_OVERRIDE = {
    "category_id": "CASE WHEN s.txn_id IS NULL THEN t.category_id ELSE s.category_id END AS category_id",
    "amount": "CASE WHEN s.txn_id IS NULL THEN t.amount ELSE s.amount END AS amount",
}


def get_split_parts(conn: sqlite3.Connection, txn_id: str) -> list[dict]:
    """One split's allocations, with their category names resolved for display."""
    rows = conn.execute(
        """
        SELECT s.id, s.category_id, s.amount, s.sort_order, s.label,
               c.name AS category_name, p.name AS group_name
        FROM   txn_split s
        LEFT JOIN category c ON c.id = s.category_id
        LEFT JOIN category p ON p.id = c.parent_id
        WHERE  s.txn_id = ?
        ORDER BY s.sort_order, s.rowid
        """,
        (txn_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_split_parts_map(conn: sqlite3.Connection, txn_ids: Sequence[str]) -> dict[str, list[dict]]:
    """The allocations of each of these transactions, keyed by transaction id.

    Feeds a list's split rows in **one** query for the whole page rather than one per row — and callers
    pass only the ids already flagged `is_split`, so the key set is a handful even on a full page. The
    parts ride in the list payload rather than being fetched when a row is hovered: the ledger shows
    them in the row's hover, and a per-hover round trip would put a loading state inside a tooltip for
    data this small.
    """
    ids = [i for i in txn_ids if i]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"""
        SELECT s.txn_id, s.category_id, s.amount, s.label, c.name AS category_name
        FROM   txn_split s
        LEFT JOIN category c ON c.id = s.category_id
        WHERE  s.txn_id IN ({placeholders})
        ORDER BY s.txn_id, s.sort_order, s.rowid
        """,
        ids,
    ).fetchall()
    out: dict[str, list[dict]] = {}
    for row in rows:
        out.setdefault(row["txn_id"], []).append({
            "category_id": row["category_id"],
            "category_name": row["category_name"],
            "amount": row["amount"],
            "label": row["label"],
        })
    return out


def is_split(conn: sqlite3.Connection, txn_id: str) -> bool:
    row = conn.execute("SELECT is_split FROM txn WHERE id = ?", (txn_id,)).fetchone()
    return bool(row and row["is_split"])


def split_txn_ids(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> set[str]:
    """Which of these transactions are split. Used by the bulk paths that must refuse them."""
    ids = [i for i in txn_ids if i]
    if not ids:
        return set()
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT id FROM txn WHERE id IN ({placeholders}) AND is_split = 1", ids
    ).fetchall()
    return {r["id"] for r in rows}


def validate_parts(conn: sqlite3.Connection, amount: float, parts: Sequence[dict]) -> list[dict]:
    """Check a proposed allocation set against the split invariants and return it normalized.

    Raises `SplitValidationError` with a message written for the user, since every one of these is
    something they can see and fix on the editor rather than an internal inconsistency.
    """
    if len(parts) < MIN_PARTS:
        raise SplitValidationError("A split needs at least two categories.")

    normalized: list[dict] = []
    for index, part in enumerate(parts):
        category_id = part.get("category_id")
        if not category_id:
            raise SplitValidationError("Every amount in a split needs a category.")

        row = conn.execute(
            "SELECT parent_id, is_active FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not row:
            raise SplitValidationError("A category used by this split no longer exists.")
        if row["parent_id"] is None:
            raise SplitValidationError(
                "A split can only use categories, not groups."
            )
        if "is_active" in row.keys() and not row["is_active"]:
            raise SplitValidationError("A split cannot use a deleted category.")

        try:
            part_amount = round(float(part.get("amount")), 2)
        except (TypeError, ValueError):
            raise SplitValidationError("Every category in a split needs an amount.")
        if abs(part_amount) < _CENT:
            raise SplitValidationError("An amount in a split cannot be zero.")
        # Same sign as the transaction. A mixed-sign split (one part representing a refunded item) is a
        # coherent idea but it breaks the reporting sign convention, where a bucket's type is what
        # decides whether its total negates — see docs/data-model.md, Reporting assumptions.
        if (part_amount > 0) != (amount > 0):
            raise SplitValidationError(
                "Every amount in a split has to move money the same direction as the transaction."
            )
        # A free-text note naming what this allocation covers — an imported order's item description
        # by default, which the user is expected to cut down to something readable. Purely descriptive:
        # it never reaches a category or an amount, so nothing in reporting depends on it. Capped
        # because a marketplace item title can run to several hundred characters.
        label = (part.get("label") or "").strip() or None
        if label and len(label) > MAX_LABEL_LENGTH:
            label = label[:MAX_LABEL_LENGTH].rstrip()
        normalized.append(
            {"category_id": category_id, "amount": part_amount, "sort_order": index, "label": label}
        )

    total = round(sum(p["amount"] for p in normalized), 2)
    if abs(total - round(amount, 2)) >= _CENT:
        raise SplitValidationError(
            f"The amounts add up to {total:.2f}, but the transaction is {round(amount, 2):.2f}."
        )
    return normalized


def save_split(conn: sqlite3.Connection, txn_id: str, parts: Sequence[dict]) -> list[dict]:
    """Replace a transaction's allocations wholesale and mark it split.

    `category_id` is deliberately left alone: while `is_split` is set it is not what any report reads,
    and keeping it is what lets `clear_split` put the transaction back exactly where it was.
    """
    txn = conn.execute(
        "SELECT id, amount, category_source FROM txn WHERE id = ?", (txn_id,)
    ).fetchone()
    if not txn:
        raise SplitValidationError("Transaction not found.")

    normalized = validate_parts(conn, float(txn["amount"]), parts)

    conn.execute("DELETE FROM txn_split WHERE txn_id = ?", (txn_id,))
    conn.executemany(
        "INSERT INTO txn_split (id, txn_id, category_id, amount, sort_order, label) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (str(uuid.uuid4()), txn_id, p["category_id"], p["amount"], p["sort_order"], p["label"])
            for p in normalized
        ],
    )
    # `category_overridden` is set alongside the source so the lock-bit readers that predate the split
    # source (and any future one) still treat the row as spoken for; the passes that matter skip it by
    # source. needs_review clears for the same reason a manual category edit clears it — the row has
    # plainly been looked at.
    conn.execute(
        "UPDATE txn SET is_split = 1, category_source = ?, category_overridden = 1, needs_review = 0 "
        "WHERE id = ?",
        (SPLIT_CATEGORY_SOURCE, txn_id),
    )
    return get_split_parts(conn, txn_id)


def clear_split(conn: sqlite3.Connection, txn_id: str) -> None:
    """Un-split a transaction, returning it to the category it carried before the split.

    The restored `category_source` is derived rather than stored: a retained `category_id` came from
    whatever set it originally, and the honest reading of "the user split this and then undid it" is a
    manual categorization. A transaction that was uncategorized before the split goes back to
    uncategorized with no source at all.
    """
    row = conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()
    if not row:
        return
    conn.execute("DELETE FROM txn_split WHERE txn_id = ?", (txn_id,))
    if row["category_id"]:
        conn.execute(
            "UPDATE txn SET is_split = 0, category_source = 'manual', category_overridden = 1 "
            "WHERE id = ?",
            (txn_id,),
        )
    else:
        conn.execute(
            "UPDATE txn SET is_split = 0, category_source = NULL, category_overridden = 0 "
            "WHERE id = ?",
            (txn_id,),
        )


def proportional_allocation(amount: float, weights: Sequence[Optional[float]]) -> list[Optional[float]]:
    """Distribute `amount` across `weights` in proportion, exact to the cent.

    The motivating case is a marketplace order whose captured item detail carries **list prices** while
    the transaction carries **net cash** (total − refund, folding in tax, shipping and any promo), so the
    item figures do not sum to what was paid. Reallocating the real amount by list-price share spreads
    those adjustments across the items proportionally, which is a defensible default for the user to
    then adjust — it is offered as a starting suggestion, never applied on its own.

    A weight of None (an item the export gave no price for) is *not* guessed at: it comes back None so
    the caller can surface it as a part awaiting an amount. Returns an empty list when there is nothing
    to weight by, which the caller reads as "no pre-fill available" — a points- or gift-card-funded order
    has no cash to distribute and a zero total has no shares.
    """
    priced = [(i, w) for i, w in enumerate(weights) if w is not None and w > 0]
    total_weight = sum(w for _, w in priced)
    if not priced or total_weight <= 0 or abs(amount) < _CENT:
        return []

    out: list[Optional[float]] = [None] * len(weights)
    running = 0.0
    for i, w in priced:
        share = round(amount * w / total_weight, 2)
        out[i] = share
        running = round(running + share, 2)
    # Rounding remainder goes to the largest part, where it is proportionally least visible, so the
    # allocations sum to the amount exactly rather than "nearly".
    remainder = round(amount - running, 2)
    if abs(remainder) >= _CENT:
        largest = max(priced, key=lambda pair: abs(pair[1]))[0]
        out[largest] = round(out[largest] + remainder, 2)
    return out
