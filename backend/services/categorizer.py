# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Shared categorization contract for sync, imports, previews, and retroactive rule apply.

The important invariant is that every caller sees the same winner for the same
transaction text, owner, account, and amount window.
"""

import json
import sqlite3

from backend.services.transaction_tags import (
    load_rule_tag_sync_rows,
    sync_rule_tags_for_transaction,
    would_sync_rule_tags_change,
)


def extract_source_match_text(evidence) -> str:
    """The descriptive free text an import captured for a row, concatenated and lowercased into one
    haystack for `match_source_text` rules: the normalized description slot plus the source-specific
    `extra_text_fields` (e.g. an "Original Statement" column). The account label is deliberately
    excluded — it identifies the account, not the statement text — matching what the merchant origin
    surfaces show as `text`-scope. See `import_evidence_json` (data-model.md) and
    docs/import-source-fields-plan.md.
    """
    if not isinstance(evidence, dict):
        return ""
    parts = []
    description = evidence.get("description")
    if isinstance(description, dict) and description.get("value"):
        parts.append(str(description["value"]))
    for field in (evidence.get("extra_text_fields") or []):
        if isinstance(field, dict) and field.get("value"):
            parts.append(str(field["value"]))
    return " ".join(parts).lower()


def source_match_text_from_json(evidence_json) -> str:
    """`extract_source_match_text` over a stored `import_evidence_json` string; '' when absent/invalid."""
    if not evidence_json:
        return ""
    try:
        return extract_source_match_text(json.loads(evidence_json))
    except (ValueError, TypeError):
        return ""


def _amount_matches(amount: float, amount_min, amount_max) -> bool:
    if amount_min is not None and amount < amount_min:
        return False
    if amount_max is not None and amount > amount_max:
        return False
    return True


def _amount_side_matches(amount: float, debit_credit: str | None) -> bool:
    direction = str(debit_credit or "both").strip().lower()
    if direction == "debit":
        return amount > 0
    if direction == "credit":
        return amount < 0
    return True


def _amount_rule_matches(amount: float, amount_min, amount_max, debit_credit: str | None) -> bool:
    if not _amount_side_matches(amount, debit_credit):
        return False
    return _amount_matches(abs(amount), amount_min, amount_max)


def rule_matches_row(rule, row) -> bool:
    """Does `rule` match transaction `row`? The one shared predicate behind rule apply
    (rules._apply_rule_to_existing) and rule-backed recurring-series membership
    (recurring_detection.reconcile_series), so "which rows a rule owns" has a single definition.

    Both args are dict-like. `rule` provides keyword/owner_id/account_id/amount_min/amount_max/
    debit_credit/match_source_text; `row` provides display_name/merchant_name/raw_name/amount/owner_id/
    effective_account_id and (for match_source_text rules) import_evidence_json. A row whose SELECT omits
    import_evidence_json simply can't match on source text, which is safe.
    """
    if rule["owner_id"] is not None and rule["owner_id"] != row["owner_id"]:
        return False
    if rule["account_id"] is not None and rule["account_id"] != row["effective_account_id"]:
        return False
    text = " ".join(filter(None, [row["display_name"], row["merchant_name"], row["raw_name"]])).lower()
    keyword = rule["keyword"].lower()
    matched = bool(text) and keyword in text
    if not matched and rule["match_source_text"]:
        try:
            source_text = source_match_text_from_json(row["import_evidence_json"])
        except (KeyError, IndexError):
            source_text = ""
        matched = bool(source_text) and keyword in source_text
    if not matched:
        return False
    return _amount_rule_matches(row["amount"], rule["amount_min"], rule["amount_max"], rule["debit_credit"])


def _resolve_effective_account_id(
    conn: sqlite3.Connection,
    account_id: str | None,
    effective_account_id: str | None = None,
) -> str | None:
    if effective_account_id:
        return effective_account_id
    if not account_id:
        return None
    row = conn.execute(
        "SELECT COALESCE(parent_account_id, id) AS effective_account_id FROM account WHERE id = ?",
        (account_id,),
    ).fetchone()
    return row["effective_account_id"] if row else account_id


def load_categorization_rules(conn: sqlite3.Connection) -> list:
    """Load the ordered rule set ONCE so a per-transaction matcher can reuse it across a whole pass.

    The ORDER BY *is* the precedence contract (account/owner-scoped rules and longer keywords win), so any
    caller that preloads rules must use exactly this query. Hoisting this out of the per-row loop is the
    whole performance fix: re-querying it per row is cheap in isolation but, multiplied by thousands of
    rows and several concurrent requests, collapses SQLite/GIL/IO super-linearly (≈60s for 4 concurrent
    recategorize-preview calls vs ≈1s when the rules are loaded once).
    """
    return conn.execute(
        """SELECT cr.id, cr.category_id, cr.keyword, cr.amount_min, cr.amount_max,
                  cr.debit_credit, cr.owner_id, cr.account_id, cr.clean_name, cr.match_source_text
           FROM   category_rule cr
           LEFT   JOIN category c ON c.id = cr.category_id
           -- Deactivating a category prunes its rules, but stay defensive: a rule must never
           -- categorize into an inactive category. Tag-only rules (category_id NULL) still apply.
           WHERE  cr.category_id IS NULL OR c.is_active = 1
           ORDER  BY
               CASE WHEN cr.owner_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               CASE WHEN cr.account_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               LENGTH(cr.keyword) DESC,
               (CASE WHEN cr.amount_min IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN cr.amount_max IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN COALESCE(cr.debit_credit, 'both') <> 'both' THEN 1 ELSE 0 END +
                CASE WHEN cr.owner_id   IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN cr.account_id IS NOT NULL THEN 1 ELSE 0 END) DESC"""
    ).fetchall()


def load_rule_tags_by_id(conn: sqlite3.Connection) -> dict:
    """Map rule_id -> [tag_id], preloaded once so batch callers don't re-query rule_tag per matched row."""
    mapping: dict = {}
    for row in conn.execute("SELECT rule_id, tag_id FROM rule_tag").fetchall():
        mapping.setdefault(row["rule_id"], []).append(row["tag_id"])
    return mapping


def categorize_transaction(
    merchant_name: str | None,
    raw_name: str | None,
    display_name: str | None,
    amount: float,
    conn: sqlite3.Connection,
    owner_id: str | None = None,
    account_id: str | None = None,
    effective_account_id: str | None = None,
    rules: list | None = None,
    rule_tags_by_id: dict | None = None,
    source_text: str | None = None,
) -> dict | None:
    text = " ".join(filter(None, [display_name, merchant_name, raw_name])).lower()
    # `source_text` is the captured import free text (description + extra fields), consulted only for a
    # rule with `match_source_text` set — so a row whose visible merchant says nothing can still match
    # on its "Original Statement"-style detail. Callers pass it from the import row / stored evidence;
    # the Plaid sync path has none and passes None. See extract_source_match_text.
    source_text_lc = (source_text or "").lower()
    if not text and not source_text_lc:
        return None
    resolved_effective_account_id = _resolve_effective_account_id(conn, account_id, effective_account_id)

    # Callers that categorize many rows in a loop (recategorize, preview, import, sync) pass `rules` /
    # `rule_tags_by_id` in so they are loaded once; a lone single-row caller can omit them and we load
    # on demand. Either way the matching/ordering below is identical — see load_categorization_rules.
    if rules is None:
        rules = load_categorization_rules(conn)

    matched_rule_ids = []
    winning_category_id = None
    winning_clean_name = None

    for rule in rules:
        if rule["owner_id"] is not None and rule["owner_id"] != owner_id:
            continue
        if rule["account_id"] is not None and rule["account_id"] != resolved_effective_account_id:
            continue
        keyword = rule["keyword"].lower()
        if keyword not in text and not (rule["match_source_text"] and source_text_lc and keyword in source_text_lc):
            continue
        if not _amount_rule_matches(amount, rule["amount_min"], rule["amount_max"], rule["debit_credit"]):
            continue
        matched_rule_ids.append(rule["id"])
        if winning_category_id is None and rule["category_id"] is not None:
            winning_category_id = rule["category_id"]
        if winning_clean_name is None and rule["clean_name"]:
            winning_clean_name = rule["clean_name"]

    if not matched_rule_ids:
        return None

    if rule_tags_by_id is not None:
        tag_ids = []
        seen = set()
        for rule_id in matched_rule_ids:
            for tag_id in rule_tags_by_id.get(rule_id, ()):
                if tag_id not in seen:
                    seen.add(tag_id)
                    tag_ids.append(tag_id)
    else:
        placeholders = ",".join("?" for _ in matched_rule_ids)
        tag_rows = conn.execute(
            f"SELECT DISTINCT tag_id FROM rule_tag WHERE rule_id IN ({placeholders})",
            matched_rule_ids,
        ).fetchall()
        tag_ids = [row["tag_id"] for row in tag_rows]
    return {
        "category_id": winning_category_id,
        "clean_name": winning_clean_name,
        "tag_ids": tag_ids,
        "matched_rule_ids": matched_rule_ids,
    }


def rule_scalar_effects(result, *, fallback_name: str) -> dict:
    """The transaction fields a matched rule sets through its *scalar* actions, in one place. Today that
    is only the rename: ``display_name`` = the rule's clean_name if it set one, else ``fallback_name``
    (the row's existing/raw name). Every rule-apply site consumes this identically — CSV import, Plaid
    sync, ``recategorize_all``, and its preview count — so the derivation can't drift between them (the
    CSV path once silently dropped clean_name; that class of bug ends here), and a future scalar action
    such as a rule-set note is added *here* rather than at each site. ``result`` may be the dict
    ``categorize_transaction`` returns, a bare category_id from its legacy shape, or ``None`` when no
    categorization ran — the latter two carry no rename and yield just the fallback. Category assignment
    and tags stay out of this: category_source policy differs per site, and tags already have their own
    shared apply (``sync_rule_tags_for_transaction``)."""
    clean_name = result.get("clean_name") if isinstance(result, dict) else None
    return {"display_name": clean_name or fallback_name}


def recategorize_all(conn: sqlite3.Connection) -> int:
    # Retroactive recategorization is intentionally opt-in and skips manual overrides,
    # so user edits remain the final authority even after rules evolve.
    txns = conn.execute(
        """SELECT
               t.id,
               t.merchant_name,
               t.display_name,
               t.raw_name,
               t.amount,
               t.owner_id,
               t.account_id,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               t.category_id,
               t.category_source,
               t.import_evidence_json
           FROM   txn t
           JOIN   account a ON a.id = t.account_id
           WHERE  category_overridden = 0"""
    ).fetchall()

    rules = load_categorization_rules(conn)
    rule_tags_by_id = load_rule_tags_by_id(conn)
    tag_rows_by_txn = load_rule_tag_sync_rows(conn)
    # Only pay the per-row evidence parse when at least one rule actually opts into source-text
    # matching; the common case (no such rules) stays exactly as cheap as before.
    needs_source_text = any(rule["match_source_text"] for rule in rules)
    updated = 0
    for txn in txns:
        source_text = source_match_text_from_json(txn["import_evidence_json"]) if needs_source_text else None
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["display_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
            account_id=txn["account_id"],
            effective_account_id=txn["effective_account_id"],
            rules=rules,
            rule_tags_by_id=rule_tags_by_id,
            source_text=source_text,
        )
        cat_id = result["category_id"] if isinstance(result, dict) else result
        matched_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
        display_name = rule_scalar_effects(result, fallback_name=txn["merchant_name"] or txn["raw_name"])["display_name"]
        category_changed = cat_id != txn["category_id"]
        display_name_changed = display_name != (txn["display_name"] or txn["merchant_name"] or txn["raw_name"])
        tags_changed = would_sync_rule_tags_change(conn, txn["id"], matched_tag_ids, existing_rows=tag_rows_by_txn.get(txn["id"], {}))
        if category_changed or display_name_changed:
            # When a rule assigns a category the row becomes rule-owned; when none does it falls back to
            # uncategorized (NULL) — EXCEPT a user-`cleared` row, which keeps its `cleared` marker so a
            # rename/tag-only rule match can clean its name without silently dropping the marker (which
            # would re-expose it to the trust-flag re-grab). See set_rejected_suggestion_disposition.
            next_source = "rule" if cat_id else ("cleared" if txn["category_source"] == "cleared" else None)
            conn.execute(
                "UPDATE txn SET category_id = ?, display_name = ?, category_source = ? WHERE id = ?",
                (cat_id, display_name, next_source, txn["id"]),
            )
        if sync_rule_tags_for_transaction(conn, txn["id"], matched_tag_ids):
            tags_changed = True
        if category_changed or display_name_changed or tags_changed:
            updated += 1

    return updated


def preview_recategorize_count(conn: sqlite3.Connection) -> int:
    # The Rules page uses this to decide whether "re-run categorization" is the
    # likely next action, so the preview must mirror the same override-skipping
    # and rule-matching contract as the real recategorize pass.
    txns = conn.execute(
        """SELECT
               t.id,
               t.merchant_name,
               t.display_name,
               t.raw_name,
               t.amount,
               t.owner_id,
               t.account_id,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               t.category_id,
               t.import_evidence_json
           FROM   txn t
           JOIN   account a ON a.id = t.account_id
           WHERE  category_overridden = 0"""
    ).fetchall()

    rules = load_categorization_rules(conn)
    rule_tags_by_id = load_rule_tags_by_id(conn)
    tag_rows_by_txn = load_rule_tag_sync_rows(conn)
    needs_source_text = any(rule["match_source_text"] for rule in rules)
    pending = 0
    for txn in txns:
        source_text = source_match_text_from_json(txn["import_evidence_json"]) if needs_source_text else None
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["display_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
            account_id=txn["account_id"],
            effective_account_id=txn["effective_account_id"],
            rules=rules,
            rule_tags_by_id=rule_tags_by_id,
            source_text=source_text,
        )
        cat_id = result["category_id"] if isinstance(result, dict) else result
        matched_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
        display_name = rule_scalar_effects(result, fallback_name=txn["merchant_name"] or txn["raw_name"])["display_name"]
        display_name_changed = display_name != (txn["display_name"] or txn["merchant_name"] or txn["raw_name"])
        if (
            cat_id != txn["category_id"]
            or display_name_changed
            or would_sync_rule_tags_change(conn, txn["id"], matched_tag_ids, existing_rows=tag_rows_by_txn.get(txn["id"], {}))
        ):
            pending += 1

    return pending


# Built-in starter rule catalog: (keyword, leaf category name, amount_min, amount_max).
# Single source of truth for the opt-in starter rule set — surfaced for selection (the starter-rules
# catalog endpoint) and seeded on demand (generate-starter, demo). Rules target leaf categories by
# NAME, so the matching starter leaves must already exist (_seed_default_categories(include_leaves=True)).
DEFAULT_RULE_SEEDS: list[tuple[str, str, float | None, float | None]] = [
        ("whole foods",  "Groceries",        None, None),
        ("trader joe",   "Groceries",        None, None),
        ("kroger",       "Groceries",        None, None),
        ("safeway",      "Groceries",        None, None),
        ("aldi",         "Groceries",        None, None),
        ("costco",       "Groceries",        None, None),
        ("doordash",     "Dining Out",       None, None),
        ("uber eats",    "Dining Out",       None, None),
        ("grubhub",      "Dining Out",       None, None),
        ("mcdonald",     "Dining Out",       None, None),
        ("starbucks",    "Coffee & Drinks",  None, None),
        ("chipotle",     "Dining Out",       None, None),
        ("restaurant",   "Dining Out",       None, None),
        ("cafe",         "Coffee & Drinks",  None, None),
        ("uber",         "Rideshare",        None, None),
        ("lyft",         "Rideshare",        None, None),
        ("shell",        "Gas",              None, None),
        ("chevron",      "Gas",              None, None),
        ("exxon",        "Gas",              None, None),
        ("bp",           "Gas",              None, None),
        ("parking",      "Parking & Tolls",  None, None),
        ("netflix",      "Streaming Services", None, None),
        ("spotify",      "Streaming Services", None, None),
        ("hulu",         "Streaming Services", None, None),
        ("apple.com",    "Streaming Services", None, None),
        ("amazon prime", "Streaming Services", None, None),
        ("youtube",      "Streaming Services", None, None),
        ("electric",     "Electricity",      None, None),
        ("water bill",   "Water",            None, None),
        ("comcast",      "Internet",         None, None),
        ("verizon",      "Phone",            None, None),
        ("at&t",         "Phone",            None, None),
        ("cvs",          "Pharmacy",         None, None),
        ("walgreen",     "Pharmacy",         None, None),
        ("amazon",       "Online Shopping",  None, None),
        ("target",       "Household Supplies", None, None),
        ("walmart",      "Household Supplies", None, None),
        ("best buy",     "Electronics",      None, None),
        ("airbnb",       "Hotel",            None, None),
        ("hotel",        "Hotel",            None, None),
        ("delta",        "Air Travel",       None, None),
        ("united",       "Air Travel",       None, None),
        ("payroll",      "Salary",           None, None),
        ("direct dep",   "Salary",           None, None),
]


def seed_default_rules(conn: sqlite3.Connection, *, keywords: list[str] | None = None) -> int:
    """Seed built-in starter rules (opt-in). `keywords` optionally restricts seeding to a subset by
    keyword (the user's checkbox selection); None seeds the whole catalog. Existing keyword+category
    pairs are left untouched, so this is safe to re-run. Returns the number of rules actually created."""
    import uuid

    def cat_id(name: str) -> str | None:
        # Rules target leaf categories; restrict to leaves so a group sharing a leaf's name isn't picked.
        row = conn.execute(
            "SELECT id FROM category WHERE name = ? AND parent_id IS NOT NULL", (name,)
        ).fetchone()
        return row["id"] if row else None

    wanted = None if keywords is None else {str(k).strip().lower() for k in keywords}
    created = 0
    for keyword, cat_name, amt_min, amt_max in DEFAULT_RULE_SEEDS:
        if wanted is not None and keyword.lower() not in wanted:
            continue
        cid = cat_id(cat_name)
        if not cid:
            continue
        existing = conn.execute(
            "SELECT id FROM category_rule WHERE keyword = ? AND category_id = ?",
            (keyword, cid),
        ).fetchone()
        if not existing:
            conn.execute(
                """INSERT INTO category_rule
                   (id, category_id, keyword, amount_min, amount_max)
                   VALUES (?,?,?,?,?)""",
                (str(uuid.uuid4()), cid, keyword, amt_min, amt_max),
            )
            created += 1
    return created
