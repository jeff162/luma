# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Shared transaction-tag contract.

Tags have two independent sources of truth:
- rule_present means the current rule set would apply the tag
- manual_state lets the user force a tag present or absent on one transaction

manual_state is a three-state override: +1 force-on, 0 neutral (follow rule_present), -1 block. A
block (-1) is authoritative across *every* source — direct, category, group, and account — so it also
serves as the per-transaction opt-out for inherited tags, suppressing a tag the user unchecked on one
row without touching the category/account it comes from.

This keeps retroactive rule reruns deterministic without taking manual add/remove
control away from the user.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable

from backend.services.account_groups import effective_account_id_sql


VISIBLE_TXN_TAG_SQL = "(tt.manual_state = 1 OR (tt.manual_state = 0 AND tt.rule_present = 1))"

# Source precedence when a tag reaches a transaction through more than one path.
# Direct (rule + manual) beats category-level beats group-level beats account-level — so a tag
# the user explicitly attached to a transaction is reported as 'direct' even if it would also be
# inherited from the category, its parent group, or its account. Account is the broadest scope,
# so it is the most general (lowest) source.
_SOURCE_PRIORITY = {"account": 0, "group": 1, "category": 2, "direct": 3}

# A transaction's account tags come from its *effective* (top-level) account: a child account
# resolves to its parent, so a parent's tags propagate to children's transactions while a child's
# own tags stay dormant while merged. Only the *row* side resolves here — `account_tag.account_id`
# names one specific account row and is deliberately left raw, which is what makes a child's tags
# dormant rather than merged into the parent's (see `services/account_groups.py`).
_EFFECTIVE_ACCOUNT_ID_SQL = effective_account_id_sql("t.account_id")


# Synthetic tag-filter selection: "rows with no effective tag at all" (the complement of having any
# tag). Recognized by tag_filter_membership_sql the way the category filter recognizes its synthetic
# Uncategorized ids and the owner filter recognizes 'unassigned'.
UNTAGGED_FILTER_ID = "__untagged__"

# "Recurring" used to ride this facet as a synthetic id, because doing so bought it every surface the
# tag filter already reached. It is now an *attribute* (services/transaction_attributes.py) along with
# the rest of the row's marker strip. The move was possible because the attribute facet reaches those
# same surfaces on its own, and necessary because facets AND with each other while values within one
# facet OR: as a pseudo-tag, "Business" plus "Recurring" meant *either*, where the combination people
# actually want is *both*. Do not re-add it here.

# A transaction's *effective* tags, unioned across the four paths a tag reaches a row — direct (a
# visible `txn_tag`), inherited from its leaf category, that category's parent group, or its effective
# (top-level) account. Correlates on the outer `t`; every effective-tag helper builds on this one union.
_EFFECTIVE_TAG_UNION_SQL = f"""
    SELECT tt.tag_id AS tag_id
    FROM txn_tag tt
    WHERE tt.txn_id = t.id AND {VISIBLE_TXN_TAG_SQL}
    UNION
    SELECT ct.tag_id
    FROM category_tag ct
    JOIN category cc ON cc.id = t.category_id
    WHERE ct.category_id = cc.id OR ct.category_id = cc.parent_id
    UNION
    SELECT atag.tag_id
    FROM account_tag atag
    WHERE atag.account_id = {_EFFECTIVE_ACCOUNT_ID_SQL}
"""

# ^ NOTE, because this comparison is the exception and copying it would be a bug elsewhere.
#
# `atag.account_id` — the *stored* side — is compared RAW against the resolved row side. Almost
# everywhere else that is the classic merged-account defect: nothing resolves to a merged child, so a
# raw child id matches no row, selects nothing, and reports no error. The correct shape is to resolve
# both sides (`_effective_account_membership` in the transactions router, `effective_account_ids` in
# `account_groups`), and a new account comparison should follow that one, not this one.
#
# Here the asymmetry IS the feature. A child account's own tags are meant to go **dormant** for as long
# as it is merged — the parent's tags govern the whole group — and to come back by themselves on detach.
# Leaving the stored side unresolved is precisely what produces that: the child's `account_tag` rows
# stop matching while `parent_account_id` is set, and start matching again the moment it is cleared,
# with nothing written or deleted either way. Resolving this side would silently reactivate every
# dormant tag and make detach unable to restore the prior state.
#
# Specified in docs/data-model.md → Tags; the promote-on-merge prompt on the
# Accounts page exists because tags going dormant is easy to miss.

# A tag counts for a row only if not hidden on it (`manual_state = -1`). `eff.tag_id` refers to the
# union alias above.
_TAG_NOT_BLOCKED_SQL = (
    "NOT EXISTS (SELECT 1 FROM txn_tag b "
    "WHERE b.txn_id = t.id AND b.tag_id = eff.tag_id AND b.manual_state = -1)"
)


# `{extra}` is spliced into the eff WHERE so callers can add a tag-set restriction; the block filter is
# always applied.
def _effective_tag_exists_sql(extra: str = "") -> str:
    return f"EXISTS (SELECT 1 FROM ({_EFFECTIVE_TAG_UNION_SQL}) eff WHERE {extra}{_TAG_NOT_BLOCKED_SQL})"


def effective_selected_tag_signature_sql(placeholder_count: int) -> str:
    """A scalar subquery yielding a transaction's *tag signature*: the sorted, comma-joined ids of the
    selected tags (supplied as `placeholder_count` `?` params) it *effectively* has (block-aware), or
    NULL when it has none of them. Drives the server-side tag-report aggregation — grouping rows by this
    value buckets them by which of the report's tags they carry, exactly as the client used to do over a
    capped fetch. Callers must canonicalize (sort) the ids again when splitting, since SQLite does not
    formally guarantee GROUP_CONCAT ordering."""
    placeholders = ",".join("?" * placeholder_count)
    return f"""(
        SELECT GROUP_CONCAT(tag_id) FROM (
            SELECT DISTINCT eff.tag_id AS tag_id
            FROM ({_EFFECTIVE_TAG_UNION_SQL}) eff
            WHERE eff.tag_id IN ({placeholders}) AND {_TAG_NOT_BLOCKED_SQL}
            ORDER BY eff.tag_id
        )
    )"""


def effective_tag_match_sql(placeholder_count: int) -> str:
    """A SQL boolean matching a transaction (which must be aliased `t` in the caller's query) against a
    set of tag ids supplied as `placeholder_count` positional `?` params. True when the txn's *effective*
    tags (see `_effective_tag_exists_sql`) include any of them. This is the single definition of "has
    this tag" shared by the transaction filter/summaries and the CSV export. For exclusion ("is not")
    wrap it in `NOT (...)`: `EXISTS` never yields NULL, so no COALESCE guard is needed."""
    placeholders = ",".join("?" * placeholder_count)
    return _effective_tag_exists_sql(f"eff.tag_id IN ({placeholders})\n              AND ")


def effective_tag_any_sql() -> str:
    """True when the transaction has ANY effective tag (block-aware). Its negation `NOT (...)` is the
    'Untagged' bucket — a row with no direct or inherited tag at all."""
    return _effective_tag_exists_sql()


def effective_tag_match_all_sql(placeholder_count: int) -> str:
    """A SQL boolean true when the txn *effectively* has **all** of the tag ids (AND), unlike
    `effective_tag_match_sql`'s any-of (OR). Counts its distinct matched effective tags and requires the
    count to equal the number requested. Lets a caller compose two independent tag constraints in one
    query (the OR `tag_ids` param and this one) — e.g. the tag-report drill scopes rows to an exact
    signature (has-all these tags, none of the others) while the app-wide filter's own OR tag_ids still
    applies. `placeholder_count` must be > 0."""
    placeholders = ",".join("?" * placeholder_count)
    return (
        f"(SELECT COUNT(DISTINCT eff.tag_id) FROM ({_EFFECTIVE_TAG_UNION_SQL}) eff "
        f"WHERE eff.tag_id IN ({placeholders}) AND {_TAG_NOT_BLOCKED_SQL}) = {placeholder_count}"
    )


def tag_filter_membership_sql(ids: list[str]) -> tuple[str, list] | None:
    """Build one membership expression for a tag-filter selection that may mix real tag ids with the
    synthetic UNTAGGED_FILTER_ID. Real ids match via `effective_tag_match_sql`; UNTAGGED matches rows
    with no effective tag (`NOT effective_tag_any_sql`). The parts OR together (within-facet OR), exactly
    as the category filter ORs real categories with its synthetic Uncategorized buckets. Returns
    `(expr, params)` or None when nothing is selected. Callers append `expr` for include and
    `NOT (expr)` for exclude, so include/exclude share one definition. One builder feeds the list feed,
    the summaries, and the CSV export so a tag chip means the same thing on every surface."""
    real = [i for i in ids if i and i != UNTAGGED_FILTER_ID]
    want_untagged = UNTAGGED_FILTER_ID in ids
    parts: list[str] = []
    params: list = []
    if real:
        parts.append(effective_tag_match_sql(len(real)))
        params.extend(real)
    if want_untagged:
        parts.append(f"NOT ({effective_tag_any_sql()})")
    if not parts:
        return None
    return f"({' OR '.join(parts)})", params


def get_visible_transaction_tag_map(
    conn: sqlite3.Connection,
    txn_ids: Iterable[str],
) -> dict[str, list[dict]]:
    txn_ids = [str(txn_id) for txn_id in txn_ids if txn_id]
    if not txn_ids:
        return {}
    placeholders = ",".join("?" for _ in txn_ids)

    direct_rows = conn.execute(
        f"""
        SELECT
            tt.txn_id,
            g.id,
            g.name,
            g.color,
            g.sort_order
        FROM txn_tag tt
        JOIN tag g ON g.id = tt.tag_id
        WHERE tt.txn_id IN ({placeholders})
          AND {VISIBLE_TXN_TAG_SQL}
        """,
        txn_ids,
    ).fetchall()

    # Inherited tags: pulled additively from the transaction's leaf category and its
    # parent group. The CASE on category_id picks the most specific source so we can
    # mark each tag with where it came from for downstream UI affordances.
    inherited_rows = conn.execute(
        f"""
        SELECT
            t.id  AS txn_id,
            g.id  AS id,
            g.name,
            g.color,
            g.sort_order,
            CASE
                WHEN ct.category_id = t.category_id THEN 'category'
                ELSE 'group'
            END AS source
        FROM txn t
        JOIN category c ON c.id = t.category_id
        JOIN category_tag ct
          ON ct.category_id = t.category_id
          OR ct.category_id = c.parent_id
        JOIN tag g ON g.id = ct.tag_id
        WHERE t.id IN ({placeholders})
        """,
        txn_ids,
    ).fetchall()

    # Account-level tags, resolved through the effective (top-level) account.
    account_rows = conn.execute(
        f"""
        SELECT
            t.id  AS txn_id,
            g.id  AS id,
            g.name,
            g.color,
            g.sort_order,
            'account' AS source
        FROM txn t
        JOIN account_tag at ON at.account_id = {_EFFECTIVE_ACCOUNT_ID_SQL}
        JOIN tag g ON g.id = at.tag_id
        WHERE t.id IN ({placeholders})
        """,
        txn_ids,
    ).fetchall()

    # Merge per transaction, keyed by tag id so a tag contributed via more than one
    # path collapses into one entry tagged with the highest-priority source.
    merged: dict[str, dict[str, dict]] = {txn_id: {} for txn_id in txn_ids}
    for row in list(account_rows) + list(inherited_rows):
        bucket = merged[row["txn_id"]]
        existing = bucket.get(row["id"])
        if existing is None or _SOURCE_PRIORITY[row["source"]] > _SOURCE_PRIORITY[existing["source"]]:
            bucket[row["id"]] = {
                "id": row["id"],
                "name": row["name"],
                "color": row["color"],
                "source": row["source"],
                "_sort": row["sort_order"] or 0,
            }
    for row in direct_rows:
        merged[row["txn_id"]][row["id"]] = {
            "id": row["id"],
            "name": row["name"],
            "color": row["color"],
            "source": "direct",
            "_sort": row["sort_order"] or 0,
        }

    # A per-transaction block (manual_state = -1) suppresses the tag no matter which source contributed
    # it. Applied last, so it also removes an inherited copy that direct-visibility never overwrote (a
    # blocked row is not in direct_rows). This is the inherited-tag opt-out; see set_manual_transaction_tag.
    for row in conn.execute(
        f"""
        SELECT txn_id, tag_id
        FROM txn_tag
        WHERE txn_id IN ({placeholders}) AND manual_state = -1
        """,
        txn_ids,
    ).fetchall():
        merged[row["txn_id"]].pop(row["tag_id"], None)

    tag_map: dict[str, list[dict]] = {}
    for txn_id, bucket in merged.items():
        sorted_tags = sorted(
            bucket.values(),
            key=lambda t: (t["_sort"], (t["name"] or "").lower(), t["name"] or "", t["id"]),
        )
        tag_map[txn_id] = [
            {"id": t["id"], "name": t["name"], "color": t["color"], "source": t["source"]}
            for t in sorted_tags
        ]
    return tag_map


def list_visible_transaction_tags(conn: sqlite3.Connection, txn_id: str) -> list[dict]:
    return get_visible_transaction_tag_map(conn, [txn_id]).get(txn_id, [])


def get_blocked_transaction_tag_map(
    conn: sqlite3.Connection,
    txn_ids: Iterable[str],
) -> dict[str, list[dict]]:
    """Tags the user has explicitly hidden on a transaction (manual_state = -1). These are excluded
    from the visible map above; the tag picker surfaces them separately so a hidden inherited/rule tag
    can be restored. Block rows only ever exist for tags that would otherwise show (see
    set_manual_transaction_tag), so every entry here is a genuine 'hidden here' the UI can re-enable."""
    txn_ids = [str(txn_id) for txn_id in txn_ids if txn_id]
    if not txn_ids:
        return {}
    placeholders = ",".join("?" for _ in txn_ids)
    blocked: dict[str, list[dict]] = {txn_id: [] for txn_id in txn_ids}
    for row in conn.execute(
        f"""
        SELECT tt.txn_id, g.id, g.name, g.color, g.sort_order
        FROM txn_tag tt
        JOIN tag g ON g.id = tt.tag_id
        WHERE tt.txn_id IN ({placeholders}) AND tt.manual_state = -1
        ORDER BY g.sort_order, LOWER(g.name), g.name, g.id
        """,
        txn_ids,
    ).fetchall():
        blocked[row["txn_id"]].append(
            {"id": row["id"], "name": row["name"], "color": row["color"]}
        )
    return blocked


def _tag_is_inherited(conn: sqlite3.Connection, txn_id: str, tag_id: str) -> bool:
    """Whether the tag reaches this transaction through its leaf category, that category's parent
    group, or its effective (top-level) account — i.e. any non-direct source. Mirrors the inherited/
    account joins in get_visible_transaction_tag_map so the toggle can tell 'block an inherited tag'
    (leave a suppression row) from 'remove a purely manual add' (delete the row)."""
    row = conn.execute(
        f"""
        SELECT 1
        FROM txn t
        WHERE t.id = ?
          AND (
            EXISTS (
                SELECT 1
                FROM category_tag ct
                JOIN category cc ON cc.id = t.category_id
                WHERE ct.tag_id = ?
                  AND (ct.category_id = cc.id OR ct.category_id = cc.parent_id)
            )
            OR EXISTS (
                SELECT 1
                FROM account_tag atag
                WHERE atag.tag_id = ?
                  AND atag.account_id = {_EFFECTIVE_ACCOUNT_ID_SQL}
            )
          )
        """,
        (txn_id, tag_id, tag_id),
    ).fetchone()
    return row is not None


def _get_txn_tag_rows(conn: sqlite3.Connection, txn_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT txn_id, tag_id, rule_present, manual_state
        FROM txn_tag
        WHERE txn_id = ?
        """,
        (txn_id,),
    ).fetchall()


def _predict_rule_tag_sync_change(
    rows: dict[str, sqlite3.Row],
    next_rule_tag_ids: set[str],
    *,
    clear_manual_blocks: bool,
) -> bool:
    for tag_id, row in rows.items():
        next_rule_present = 1 if tag_id in next_rule_tag_ids else 0
        next_manual_state = row["manual_state"]
        if clear_manual_blocks and next_rule_present and next_manual_state == -1:
            next_manual_state = 0
        if next_rule_present != row["rule_present"] or next_manual_state != row["manual_state"]:
            return True
        if next_rule_present == 0 and next_manual_state == 0:
            return True
    return any(tag_id not in rows for tag_id in next_rule_tag_ids)


def load_rule_tag_sync_rows(conn: sqlite3.Connection) -> dict:
    """Preload {txn_id: {tag_id: row}} from txn_tag so a batch preview/recategorize can hand each
    transaction's existing direct-tag rows to would_sync_rule_tags_change instead of querying per row.
    Each transaction's rows are read at most once before that transaction is (re)written, so a write to
    one row never staling another's preloaded entry."""
    rows_by_txn: dict = {}
    for row in conn.execute(
        "SELECT txn_id, tag_id, rule_present, manual_state FROM txn_tag"
    ).fetchall():
        rows_by_txn.setdefault(row["txn_id"], {})[row["tag_id"]] = row
    return rows_by_txn


def would_sync_rule_tags_change(
    conn: sqlite3.Connection,
    txn_id: str,
    tag_ids: Iterable[str],
    *,
    clear_manual_blocks: bool = False,
    existing_rows: dict | None = None,
) -> bool:
    if existing_rows is None:
        existing_rows = {row["tag_id"]: row for row in _get_txn_tag_rows(conn, txn_id)}
    next_rule_tag_ids = {str(tag_id) for tag_id in tag_ids if tag_id}
    return _predict_rule_tag_sync_change(existing_rows, next_rule_tag_ids, clear_manual_blocks=clear_manual_blocks)


def sync_rule_tags_for_transaction(
    conn: sqlite3.Connection,
    txn_id: str,
    tag_ids: Iterable[str],
    *,
    clear_manual_blocks: bool = False,
) -> bool:
    existing_rows = {row["tag_id"]: row for row in _get_txn_tag_rows(conn, txn_id)}
    next_rule_tag_ids = {str(tag_id) for tag_id in tag_ids if tag_id}
    changed = False

    for tag_id, row in existing_rows.items():
        next_rule_present = 1 if tag_id in next_rule_tag_ids else 0
        next_manual_state = row["manual_state"]
        if clear_manual_blocks and next_rule_present and next_manual_state == -1:
            next_manual_state = 0
        if next_rule_present == row["rule_present"] and next_manual_state == row["manual_state"]:
            if next_rule_present == 0 and next_manual_state == 0:
                conn.execute(
                    "DELETE FROM txn_tag WHERE txn_id = ? AND tag_id = ?",
                    (txn_id, tag_id),
                )
                changed = True
            continue
        if next_rule_present == 0 and next_manual_state == 0:
            conn.execute(
                "DELETE FROM txn_tag WHERE txn_id = ? AND tag_id = ?",
                (txn_id, tag_id),
            )
        else:
            conn.execute(
                """
                UPDATE txn_tag
                SET rule_present = ?, manual_state = ?
                WHERE txn_id = ? AND tag_id = ?
                """,
                (next_rule_present, next_manual_state, txn_id, tag_id),
            )
        changed = True

    for tag_id in next_rule_tag_ids:
        if tag_id in existing_rows:
            continue
        conn.execute(
            """
            INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state)
            VALUES (?, ?, 1, 0)
            """,
            (txn_id, tag_id),
        )
        changed = True

    return changed


def set_manual_transaction_tag(
    conn: sqlite3.Connection,
    txn_id: str,
    tag_id: str,
    *,
    present: bool,
) -> None:
    row = conn.execute(
        """
        SELECT rule_present, manual_state
        FROM txn_tag
        WHERE txn_id = ? AND tag_id = ?
        """,
        (txn_id, tag_id),
    ).fetchone()
    ruled = bool(row and row["rule_present"])
    # Whether the tag reaches this transaction via a source the user can't remove here (rule or
    # inheritance). Inheritance is only queried when it can change the outcome — turning a tag off, or
    # unblocking one — not on the common "add a fresh tag" path.
    inherited = _tag_is_inherited(conn, txn_id, tag_id) if (not present or (row and row["manual_state"] == -1)) else False

    def _write(manual_state: int) -> None:
        if row:
            if row["manual_state"] != manual_state:
                conn.execute(
                    "UPDATE txn_tag SET manual_state = ? WHERE txn_id = ? AND tag_id = ?",
                    (manual_state, txn_id, tag_id),
                )
        else:
            conn.execute(
                "INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, 0, ?)",
                (txn_id, tag_id, manual_state),
            )

    def _delete() -> None:
        if row:
            conn.execute("DELETE FROM txn_tag WHERE txn_id = ? AND tag_id = ?", (txn_id, tag_id))

    if present:
        # Show / unblock. A ruled tag returns to neutral (follows the rule); a purely inherited tag needs
        # no direct row at all; anything else is a manual force-on.
        if ruled:
            _write(0)
        elif inherited:
            _delete()
        else:
            _write(1)
        return

    # Hide / block. If the tag would otherwise show via rule or inheritance, leave a suppression row so
    # it stays hidden on this transaction; a purely manual add just goes away ("no opinion").
    if ruled or inherited:
        _write(-1)
    else:
        _delete()
