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
from typing import Optional

from backend.services import txn_links
from backend.services.transfer_categories import TRANSFERS_GROUP, ensure_excluded_transfers_leaf

LINK_KIND = "wallet_funding"
MONEY_MOVEMENT_CATEGORY = "Money movement"
# Money-movement rules are scoped by account *type* — one rule per Type covers every PayPal account,
# rather than one rule per (Type, account). See docs/backlog/account-type-as-rule-criterion.md.
PAYPAL_ACCOUNT_TYPE = "paypal"

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
    """The excluded category funding legs are moved into: a leaf named "Money movement" under the
    ``Transfers`` group (which carries ``exclude_from_totals = 1``). Shared with the Amazon importer via
    ``ensure_excluded_transfers_leaf``, which recreates the group if the user deleted it so the leaf is
    never a parentless (group-shaped) row."""
    return ensure_excluded_transfers_leaf(conn, MONEY_MOVEMENT_CATEGORY)


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


# --- Type-based money-movement categorization (user-approved rules) --------------------------------
# Lexical fragments that mark a PayPal `Type` as money movement, robust to PayPal renaming an exact
# string (a future "eCheck Deposit" still matches "deposit"). Used only to *pre-flag* proposals for the
# user's review — the user decides which types actually become rules. See
# docs/backlog/paypal-money-movement-recognition.md.
_MONEY_MOVEMENT_TYPE_FRAGMENTS = ("deposit", "withdrawal", "currency conversion", "hold")


def is_money_movement_type(type_value: Optional[str]) -> bool:
    """Whether a PayPal `Type` looks like money movement (deposits, withdrawals, conversions, holds) vs a
    real payment. Fragment-based so it survives PayPal renaming a specific type."""
    t = str(type_value or "").casefold()
    if not t:
        return False
    return t in _MONEY_MOVEMENT_TYPES or any(fragment in t for fragment in _MONEY_MOVEMENT_TYPE_FRAGMENTS)


def batch_account_ids(conn: sqlite3.Connection, batch_id: str) -> list[str]:
    """The distinct accounts a batch's rows landed on (a PayPal import lands on one account, so normally a
    single id) — the accounts to mark as the PayPal type when the user approves money-movement rules."""
    rows = conn.execute(
        "SELECT DISTINCT account_id FROM txn WHERE import_batch_id = ? AND trashed_at IS NULL AND account_id IS NOT NULL",
        (batch_id,),
    ).fetchall()
    return [row["account_id"] for row in rows]


def profile_account_ids(conn: sqlite3.Connection, profile_id: str) -> list[str]:
    """Every account the data source's imports landed on. A single PayPal source can span accounts (files
    carry no account column), so this can be several."""
    rows = conn.execute(
        """SELECT DISTINCT t.account_id
           FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
           WHERE  b.profile_id = ? AND t.trashed_at IS NULL AND t.account_id IS NOT NULL""",
        (profile_id,),
    ).fetchall()
    return [row["account_id"] for row in rows]


def ensure_paypal_account_type(conn: sqlite3.Connection, account_ids: list[str]) -> int:
    """Mark each given account as the PayPal account *type* when its current type is generic — so the
    now-type-scoped money-movement rules actually cover its rows. Called when the user **approves** PayPal
    money-movement types, which is itself a declaration that these are PayPal accounts. Only generic types
    (`depository`/`other`/`p2p`/NULL) are changed, so a deliberately-set type is never clobbered. Returns
    the number of accounts retyped."""
    if not account_ids:
        return 0
    placeholders = ",".join("?" for _ in account_ids)
    cursor = conn.execute(
        f"""UPDATE account SET type = ?
            WHERE id IN ({placeholders})
              AND (type IS NULL OR type IN ('depository', 'other', 'p2p'))""",
        (PAYPAL_ACCOUNT_TYPE, *account_ids),
    )
    return cursor.rowcount or 0


def money_movement_category_id_if_exists(conn: sqlite3.Connection) -> Optional[str]:
    """The Money movement leaf id if it has been created (read-only — never creates it), else None. Looks
    only under the ``Transfers`` group, mirroring where ``ensure_excluded_transfers_leaf`` creates it, so a
    missing group means the leaf can't exist yet."""
    transfers = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (TRANSFERS_GROUP,)
    ).fetchone()
    if not transfers:
        return None
    row = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id = ?", (MONEY_MOVEMENT_CATEGORY, transfers["id"])
    ).fetchone()
    return row["id"] if row else None


def _ruled_keywords(conn: sqlite3.Connection, category_id: Optional[str]) -> set[str]:
    """The Type keywords already routed to Money movement (scoped to the PayPal account *type*) — so a
    proposal can show which types are currently ruled (the review's checked state). One rule per Type now
    covers every PayPal account, so this is a type-scoped lookup, not per-account."""
    if not category_id:
        return set()
    rows = conn.execute(
        """SELECT keyword FROM category_rule
           WHERE category_id = ? AND match_source_text = 1 AND account_type = ?""",
        (category_id, PAYPAL_ACCOUNT_TYPE),
    ).fetchall()
    return {row["keyword"] for row in rows}


def _type_row_counts_for_accounts(conn: sqlite3.Connection, account_ids: list[str]) -> dict[str, dict]:
    """Per captured `Type`, the rows on the review's (data source's) accounts split by whether a
    money-movement rule can affect them: **affected** (`category_overridden = 0` — rule-eligible, what the
    rule moves to Money movement) vs **extra** (`category_overridden = 1` — import/manual-locked, which the
    rule deliberately leaves alone; e.g. a category a cross-source import fixed onto the row). Keyed by
    lowercased Type. Scoped to the source's *effective* accounts (not `account_type='paypal'`) so the count
    is right even before approval types those accounts, and so it catches rows on the same account that
    arrived via another import. The review's count is the affected count; the extras surface in the report."""
    if not account_ids:
        return {}
    placeholders = ",".join("?" for _ in account_ids)
    effective = [
        r["eff"] for r in conn.execute(
            f"SELECT DISTINCT COALESCE(parent_account_id, id) AS eff FROM account WHERE id IN ({placeholders})",
            account_ids,
        ).fetchall()
    ]
    if not effective:
        return {}
    eff_placeholders = ",".join("?" for _ in effective)
    rows = conn.execute(
        f"""SELECT t.import_evidence_json, t.category_overridden
            FROM   txn t JOIN account a ON a.id = t.account_id
            WHERE  t.trashed_at IS NULL
              AND  COALESCE(a.parent_account_id, t.account_id) IN ({eff_placeholders})""",
        effective,
    ).fetchall()
    counts: dict[str, dict] = {}
    for r in rows:
        type_value = _leg_type(r["import_evidence_json"])
        if not type_value:
            continue
        bucket = counts.setdefault(type_value.strip().lower(), {"affected": 0, "extra": 0})
        bucket["extra" if r["category_overridden"] else "affected"] += 1
    return counts


def _proposals_from_evidence(evidence_rows, ruled: set[str], type_counts: dict[str, dict]) -> list[dict]:
    """Build the ranked proposal list: the distinct captured `Type`s present in the source's rows (for the
    list + display casing), each with its **affected** `count` and **extra_count** (see
    `_paypal_type_row_counts`), the money-movement pre-flag, and whether it is already ruled. Money-movement
    first, then by total row count."""
    seen: dict[str, str] = {}   # lowercased Type -> first-seen original casing
    for row in evidence_rows:
        type_value = _leg_type(row["import_evidence_json"])
        if type_value:
            seen.setdefault(type_value.strip().lower(), type_value)
    proposals = [
        {
            "type": original,
            "count": type_counts.get(key, {}).get("affected", 0),
            "extra_count": type_counts.get(key, {}).get("extra", 0),
            "money_movement": is_money_movement_type(original),
            "already_ruled": key in ruled,
        }
        for key, original in seen.items()
    ]
    proposals.sort(key=lambda p: (not p["money_movement"], -(p["count"] + p["extra_count"]), p["type"].casefold()))
    return proposals


def money_movement_type_proposals(conn: sqlite3.Connection, batch_id: str) -> list[dict]:
    """One batch's `Type` proposals (see `_proposals_from_evidence`)."""
    ruled = _ruled_keywords(conn, money_movement_category_id_if_exists(conn))
    rows = conn.execute(
        "SELECT import_evidence_json FROM txn WHERE import_batch_id = ? AND trashed_at IS NULL", (batch_id,)
    ).fetchall()
    return _proposals_from_evidence(rows, ruled, _type_row_counts_for_accounts(conn, batch_account_ids(conn, batch_id)))


def money_movement_type_proposals_for_profile(conn: sqlite3.Connection, profile_id: str) -> list[dict]:
    """`Type` proposals across **all** of a data source's imports — the single, source-level review so the
    user sees every PayPal type at once (not one card at a time), with each type's current rule state."""
    ruled = _ruled_keywords(conn, money_movement_category_id_if_exists(conn))
    rows = conn.execute(
        """SELECT t.import_evidence_json
           FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
           WHERE  b.profile_id = ? AND t.trashed_at IS NULL""",
        (profile_id,),
    ).fetchall()
    return _proposals_from_evidence(rows, ruled, _type_row_counts_for_accounts(conn, profile_account_ids(conn, profile_id)))


def create_money_movement_rules(conn: sqlite3.Connection, type_values) -> int:
    """Create `match_source_text` rules routing each `Type` to the excluded Money movement category,
    **scoped to the PayPal account *type*** so one rule per Type covers every PayPal account — a same-text
    transaction on a non-PayPal account can't match. Returns the number of rules newly created or changed
    (so the caller knows whether to recategorize).

    These route through `rules.create_rule_core` rather than a direct INSERT, so they inherit the shared
    one-matcher reconciliation: a `Type` whose (keyword, account-type, source-text) matcher already exists
    is a no-op (idempotent); a matcher owned by a rename/tag-only rule folds the Money-movement category in;
    and a matcher owned by a rule pointing at a *different* category is a conflict left for the user to
    resolve on the Rules page rather than silently forked into a second same-matcher rule."""
    # Lazy import: this service is loaded by the import router at module load, and `rules` is a router, so
    # a top-level import risks a service→router cycle. Mirrors amazon._categorize_batch_orders.
    from backend.routers.rules import RuleCreate, create_rule_core

    category_id = _default_money_movement_category(conn)
    changed = 0
    for raw in type_values or []:
        keyword = str(raw or "").strip().lower()
        if not keyword:
            continue
        result = create_rule_core(
            conn,
            RuleCreate(keyword=keyword, category_id=category_id, account_type=PAYPAL_ACCOUNT_TYPE, match_source_text=True),
            on_existing="merge",
        )
        # A brand-new rule, or a merge that actually added the category to a rule that lacked it, is a
        # change worth recategorizing for; a no-op duplicate/conflict is not.
        if result["status"] == "created" or (result["status"] == "merged" and result.get("relation") == "mergeable"):
            changed += 1
    return changed


def delete_money_movement_rules(conn: sqlite3.Connection, type_values) -> int:
    """Remove the money-movement rules for each `Type` (scoped to the PayPal account type) — the "changed my
    mind" path. Returns the count deleted; the caller runs recategorize so the rows fall out of Money
    movement."""
    category_id = money_movement_category_id_if_exists(conn)
    if not category_id:
        return 0
    deleted = 0
    for raw in type_values or []:
        keyword = str(raw or "").strip().lower()
        if not keyword:
            continue
        cursor = conn.execute(
            "DELETE FROM category_rule WHERE keyword = ? AND category_id = ? AND account_type = ? AND match_source_text = 1",
            (keyword, category_id, PAYPAL_ACCOUNT_TYPE),
        )
        deleted += cursor.rowcount or 0
    return deleted


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
