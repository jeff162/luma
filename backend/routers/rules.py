# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Rules router — manage categorization rules by payee/keyword.
Rules are the bridge between merchants (payees) and categories.
This router also exposes previews and retroactive apply paths, so its matching
order needs to stay in lockstep with the categorizer used during sync/import.
"""
import uuid
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Literal, Optional
from backend.db.database import get_db
from backend.services.categorizer import _amount_rule_matches
from backend.services.transaction_tags import sync_rule_tags_for_transaction, would_sync_rule_tags_change, get_visible_transaction_tag_map

router = APIRouter()


def _load_rule_tag_map(conn, rule_ids: list[str]) -> dict[str, list[dict]]:
    if not rule_ids:
        return {}
    placeholders = ",".join("?" for _ in rule_ids)
    rows = conn.execute(
        f"""
        SELECT
            rt.rule_id,
            g.id,
            g.name,
            g.color
        FROM rule_tag rt
        JOIN tag g ON g.id = rt.tag_id
        WHERE rt.rule_id IN ({placeholders})
        ORDER BY g.sort_order, LOWER(g.name), g.name, g.id
        """,
        rule_ids,
    ).fetchall()
    tag_map: dict[str, list[dict]] = {rule_id: [] for rule_id in rule_ids}
    for row in rows:
        tag_map.setdefault(row["rule_id"], []).append({
            "id": row["id"],
            "name": row["name"],
            "color": row["color"],
        })
    return tag_map


def _find_matching_rule(conn, txn):
    text = " ".join(filter(None, [
        txn["display_name"],
        txn["merchant_name"],
        txn["raw_name"],
    ])).lower()
    if not text:
        return None

    # Mirror the engine's specificity ordering so "match this transaction" previews and
    # explicit apply flows agree with what future imports/syncs would pick automatically.
    rules = conn.execute(
        """
        SELECT id
        FROM   category_rule
        ORDER  BY
            CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END DESC,
            CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END DESC,
            LENGTH(keyword) DESC,
            (CASE WHEN amount_min IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN amount_max IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN COALESCE(debit_credit, 'both') <> 'both' THEN 1 ELSE 0 END +
             CASE WHEN owner_id   IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) DESC
        """
    ).fetchall()

    fallback_rule_id = None
    for rule in rules:
        full_rule = conn.execute(
            """
            SELECT id, keyword, amount_min, amount_max, debit_credit, owner_id, account_id, category_id, clean_name
            FROM category_rule
            WHERE id = ?
            """,
            (rule["id"],),
        ).fetchone()
        if full_rule["owner_id"] is not None and full_rule["owner_id"] != txn["owner_id"]:
            continue
        if full_rule["account_id"] is not None and full_rule["account_id"] != txn["effective_account_id"]:
            continue
        if full_rule["keyword"].lower() not in text:
            continue
        if not _amount_rule_matches(txn["amount"], full_rule["amount_min"], full_rule["amount_max"], full_rule["debit_credit"]):
            continue
        if full_rule["category_id"] is None and not full_rule["clean_name"]:
            fallback_rule_id = full_rule["id"]
            continue
        return full_rule["id"]
    return fallback_rule_id


def _rule_matches_txn(rule, txn) -> bool:
    if rule["owner_id"] is not None and rule["owner_id"] != txn["owner_id"]:
        return False
    if rule["account_id"] is not None and rule["account_id"] != txn["effective_account_id"]:
        return False
    text = " ".join(filter(None, [
        txn["display_name"],
        txn["merchant_name"],
        txn["raw_name"],
    ])).lower()
    if not text or rule["keyword"].lower() not in text:
        return False
    return _amount_rule_matches(txn["amount"], rule["amount_min"], rule["amount_max"], rule["debit_credit"])


def _apply_rule_to_existing(conn, rule_id: str, *, preserve_manual: bool = False, txn_ids: Optional[list[str]] = None) -> list[str]:
    # `preserve_manual` reclaims the rows a rule should own — including import-locked ones
    # (category_source = 'import') — while leaving a deliberate per-transaction manual edit
    # (category_source = 'manual') untouched. Used when a merge/replace changes the governing rule:
    # the rule's prior matches should follow it, but a manual override is the user's final say.
    # `txn_ids` restricts the apply to a specific set of rows (still subject to the matcher check) — used
    # when accepting an import-rule suggestion so the rule's outputs land on exactly the rows that
    # generated it, leaving conflicting rows for other suggestions alone.
    rule = conn.execute(
        """SELECT id, keyword, category_id, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id
           FROM category_rule
           WHERE id = ?""",
        (rule_id,),
    ).fetchone()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    where_clauses, where_params = [], []
    if preserve_manual:
        where_clauses.append("t.category_source IS NOT 'manual'")
    if txn_ids is not None:
        if not txn_ids:
            return []
        where_clauses.append(f"t.id IN ({','.join('?' * len(txn_ids))})")
        where_params.extend(txn_ids)
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    txns = conn.execute(
        f"""SELECT
               t.id,
               t.merchant_name,
               t.display_name,
               t.raw_name,
               t.amount,
               t.owner_id,
               t.account_id,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id
           FROM txn t
           JOIN account a ON a.id = t.account_id
           {where_sql}""",
        where_params,
    ).fetchall()

    rule_tag_ids = [
        row["tag_id"]
        for row in conn.execute(
            "SELECT tag_id FROM rule_tag WHERE rule_id = ?",
            (rule_id,),
        ).fetchall()
    ]

    affected_ids: list[str] = []
    for txn in txns:
        if not _rule_matches_txn(rule, txn):
            continue
        row_changed = False
        if rule["category_id"] is not None or rule["clean_name"]:
            params = []
            set_parts = []
            if rule["category_id"] is not None:
                # An explicit apply is the user asking the rule to own these matches, so any
                # prior auto state is replaced with the rule's category output when provided.
                set_parts.extend(["category_id = ?", "category_overridden = 0", "category_source = 'rule'"])
                params.append(rule["category_id"])
            if rule["clean_name"]:
                set_parts.append("display_name = ?")
                params.append(rule["clean_name"])
            params.append(txn["id"])
            conn.execute(
                f"UPDATE txn SET {', '.join(set_parts)} WHERE id = ?",
                params,
            )
            row_changed = True
        current_rule_tag_ids = {
            row["tag_id"]
            for row in conn.execute(
                "SELECT tag_id FROM txn_tag WHERE txn_id = ? AND rule_present = 1",
                (txn["id"],),
            ).fetchall()
        }
        merged_rule_tag_ids = current_rule_tag_ids | set(rule_tag_ids)
        if would_sync_rule_tags_change(conn, txn["id"], merged_rule_tag_ids, clear_manual_blocks=True):
            sync_rule_tags_for_transaction(conn, txn["id"], merged_rule_tag_ids, clear_manual_blocks=True)
            row_changed = True
        if row_changed:
            affected_ids.append(txn["id"])

    return affected_ids


class RulePreview(BaseModel):
    keyword:      str
    category_id:  Optional[str] = None
    amount_min:   Optional[float] = None
    amount_max:   Optional[float] = None
    debit_credit: Literal["both", "debit", "credit"] = "both"
    clean_name:   Optional[str] = None
    owner_id:     Optional[str] = None
    account_id:   Optional[str] = None
    tag_ids:      list[str] = []


@router.post("/preview")
def preview_rule(body: RulePreview):
    """Return transactions that would actually change if this rule were applied."""
    rule = {
        "keyword":     (body.keyword or "").lower().strip(),
        "category_id": body.category_id,
        "amount_min":  body.amount_min,
        "amount_max":  body.amount_max,
        "debit_credit": body.debit_credit,
        "clean_name":  body.clean_name,
        "owner_id":    body.owner_id,
        "account_id":  body.account_id,
    }
    rule_tag_ids = set(body.tag_ids)

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                t.id, t.date, t.amount, t.merchant_name, t.display_name, t.raw_name,
                t.is_pending, t.category_overridden, t.notes,
                COALESCE(a.parent_account_id, a.id) AS account_id,
                t.owner_id,
                COALESCE(a.display_name, a.name) AS account_name,
                COALESCE(p.mask, a.mask)         AS account_mask,
                t.import_batch_id,
                t.category_id,
                c.name        AS category_name,
                NULL          AS category_color,
                b.filename    AS import_batch_filename,
                b.imported_at AS import_batch_imported_at,
                o.name        AS owner_name,
                o.color       AS owner_color,
                COALESCE(a.parent_account_id, t.account_id) AS effective_account_id
            FROM txn t
            JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN owner o ON o.id = t.owner_id
            ORDER BY t.date DESC
            """
        ).fetchall()

        affected = []
        for row in rows:
            txn = dict(row)
            if not _rule_matches_txn(rule, txn):
                continue
            txn.pop("effective_account_id", None)

            would_change = False
            if rule["category_id"] is not None and txn["category_id"] != rule["category_id"]:
                would_change = True
            if not would_change and rule["clean_name"] and txn["display_name"] != rule["clean_name"]:
                would_change = True
            if not would_change and rule_tag_ids:
                current_rule_tag_ids = {
                    r["tag_id"]
                    for r in conn.execute(
                        "SELECT tag_id FROM txn_tag WHERE txn_id = ? AND rule_present = 1",
                        (txn["id"],),
                    ).fetchall()
                }
                if would_sync_rule_tags_change(conn, txn["id"], current_rule_tag_ids | rule_tag_ids, clear_manual_blocks=True):
                    would_change = True

            if would_change:
                affected.append(txn)

        tag_map = get_visible_transaction_tag_map(conn, [t["id"] for t in affected]) if affected else {}
        for txn in affected:
            txn["tags"] = tag_map.get(txn["id"], [])

    return {"count": len(affected), "transactions": affected}


class RuleCreate(BaseModel):
    keyword:     str
    category_id: Optional[str] = None
    priority:    int   = 5
    amount_min:  Optional[float] = None
    amount_max:  Optional[float] = None
    debit_credit: Literal["both", "debit", "credit"] = "both"
    clean_name:  Optional[str]   = None
    owner_id:    Optional[str]   = None
    account_id:  Optional[str]   = None
    tag_ids:     list[str]       = []


class RuleUpdate(BaseModel):
    keyword:     Optional[str]   = None
    category_id: Optional[str]   = None
    priority:    Optional[int]   = None
    amount_min:  Optional[float] = None
    amount_max:  Optional[float] = None
    debit_credit: Optional[Literal["both", "debit", "credit"]] = None
    clean_name:  Optional[str]   = None
    owner_id:    Optional[str]   = None
    account_id:  Optional[str]   = None
    tag_ids:     Optional[list[str]] = None
    clear_amount_min: bool = False
    clear_amount_max: bool = False
    clear_clean_name: bool = False
    clear_owner:      bool = False
    clear_account:    bool = False


@router.get("")
def list_rules(search: Optional[str] = Query(None)):
    where  = "WHERE cr.keyword LIKE ?" if search else ""
    params = [f"%{search}%"] if search else []
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                cr.id, cr.keyword, cr.priority,
                cr.amount_min, cr.amount_max, cr.debit_credit, cr.clean_name,
                cr.category_id,
                cr.owner_id,
                cr.account_id,
                c.name  AS category_name,
                NULL    AS category_color,
                p.name  AS parent_name,
                o.name  AS owner_name,
                o.color AS owner_color,
                COALESCE(a.display_name, a.name) AS account_name,
                COALESCE(ap.mask, a.mask)        AS account_mask
            FROM   category_rule cr
            LEFT JOIN category c  ON c.id  = cr.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            LEFT JOIN owner    o ON o.id = cr.owner_id
            LEFT JOIN account  a ON a.id = cr.account_id
            LEFT JOIN account ap ON ap.id = a.parent_account_id
            {where}
            ORDER BY
                cr.keyword ASC,
                -- Within the same keyword, list less-specific rules first
                -- (more-specific rules evaluate first but are listed last,
                --  so the list reads: general → specific, top → bottom)
                LENGTH(cr.keyword) ASC,
                (CASE WHEN cr.amount_min IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN cr.amount_max IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN COALESCE(cr.debit_credit, 'both') <> 'both' THEN 1 ELSE 0 END +
                 CASE WHEN cr.owner_id   IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN cr.account_id IS NOT NULL THEN 1 ELSE 0 END) ASC
            """,
            params,
        ).fetchall()
        rules = [dict(r) for r in rows]
        tag_map = _load_rule_tag_map(conn, [rule["id"] for rule in rules])
        for rule in rules:
            rule["tags"] = tag_map.get(rule["id"], [])
            rule["tag_ids"] = [tag["id"] for tag in rule["tags"]]
    return rules


@router.get("/match/transaction/{txn_id}")
def match_rule_for_transaction(txn_id: str):
    with get_db() as conn:
        txn = conn.execute(
            """
            SELECT
                t.id,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.amount,
                t.owner_id,
                t.account_id,
                COALESCE(a.parent_account_id, t.account_id) AS effective_account_id
            FROM txn t
            JOIN account a ON a.id = t.account_id
            WHERE t.id = ?
            """,
            (txn_id,),
        ).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
        rule_id = _find_matching_rule(conn, txn)
    return {"rule_id": rule_id}


def _normalize_clean_name(value: Optional[str]) -> str:
    return " ".join((value or "").strip().split()).lower()


def _existing_rule_for_matcher(conn, keyword: str, body: "RuleCreate"):
    # The matcher is keyword + the full scope (owner, account, amount range, direction). `IS` is
    # SQLite's null-safe comparison, so the nullable scope columns match NULL-to-NULL too.
    return conn.execute(
        """SELECT id, category_id, clean_name FROM category_rule
           WHERE keyword = ?
             AND owner_id     IS ?
             AND account_id   IS ?
             AND amount_min   IS ?
             AND amount_max   IS ?
             AND debit_credit IS ?""",
        (keyword, body.owner_id, body.account_id, body.amount_min, body.amount_max, body.debit_credit),
    ).fetchone()


def _classify_rule_collision(existing: dict, existing_tag_ids: set, *, category_id, clean_name, tag_ids) -> str:
    """Relationship of a proposed/edited rule's actions to an existing rule that shares its matcher.

    - 'conflict':  the actions set a category or rename that *disagrees* with the existing one;
                   merging would silently change behavior, so the user has to decide.
    - 'mergeable': the actions only *add* what the existing rule lacks (a missing category/rename, or
                   new tags), so they can fold into the existing rule.
    - 'duplicate': the actions contribute nothing the existing rule does not already do.
    """
    if category_id and existing["category_id"] and category_id != existing["category_id"]:
        return "conflict"
    if _normalize_clean_name(clean_name) and _normalize_clean_name(existing["clean_name"]) \
            and _normalize_clean_name(clean_name) != _normalize_clean_name(existing["clean_name"]):
        return "conflict"
    adds_category = bool(category_id) and not existing["category_id"]
    adds_clean_name = bool(_normalize_clean_name(clean_name)) and not _normalize_clean_name(existing["clean_name"])
    adds_tags = bool(set(tag_ids or []) - set(existing_tag_ids))
    if adds_category or adds_clean_name or adds_tags:
        return "mergeable"
    return "duplicate"


def _merge_actions_into_rule(conn, target: dict, *, category_id, clean_name, tag_ids) -> None:
    # Additive only: fill a category/rename the target rule is missing and union in new tags. We never
    # overwrite an action the target already has — a disagreement is a 'conflict', surfaced instead.
    fields, params = [], []
    if category_id and not target["category_id"]:
        fields.append("category_id = ?"); params.append(category_id)
    if _normalize_clean_name(clean_name) and not _normalize_clean_name(target["clean_name"]):
        fields.append("clean_name = ?"); params.append(clean_name)
    if fields:
        params.append(target["id"])
        conn.execute(f"UPDATE category_rule SET {', '.join(fields)} WHERE id = ?", params)
    for tag_id in (tag_ids or []):
        conn.execute("INSERT OR IGNORE INTO rule_tag (rule_id, tag_id) VALUES (?, ?)", (target["id"], tag_id))


@router.post("")
def create_rule(body: RuleCreate, on_existing: Literal["reject", "merge"] = "reject"):
    """Create a rule, reconciling against any existing rule with the same matcher.

    Two rules sharing a matcher can't coexist cleanly — whichever the engine orders first wins, and
    editing one leaves the other firing. So rather than fork a duplicate, a collision is classified
    (duplicate / mergeable / conflict) and, by default (`on_existing='reject'`), reported back without
    writing. Callers then decide: a single manual save prompts the user (merge, or open the existing
    rule); the bulk Generate Rules flow re-calls with `on_existing='merge'` to fold mergeable saves in
    and skip duplicates, surfacing only conflicts. A genuinely different matcher is not a collision and
    is created normally. `status` in the response is 'created' | 'merged' | 'duplicate' | 'mergeable'
    | 'conflict'.
    """
    if not body.category_id and not (body.clean_name or "").strip() and not body.tag_ids:
        raise HTTPException(status_code=400, detail="Rules need at least one action: category, rename, or tag")
    keyword = body.keyword.lower().strip()
    with get_db() as conn:
        existing = _existing_rule_for_matcher(conn, keyword, body)
        if existing:
            existing_tag_ids = {
                row["tag_id"] for row in
                conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (existing["id"],)).fetchall()
            }
            relation = _classify_rule_collision(
                existing, existing_tag_ids,
                category_id=body.category_id, clean_name=body.clean_name, tag_ids=body.tag_ids,
            )
            if on_existing == "merge" and relation in ("mergeable", "duplicate"):
                _merge_actions_into_rule(
                    conn, existing,
                    category_id=body.category_id, clean_name=body.clean_name, tag_ids=body.tag_ids,
                )
                return {"id": existing["id"], "status": "merged", "relation": relation}
            return {
                "id": existing["id"],
                "status": relation,
                "existing_rule_id": existing["id"],
                "existing_category_id": existing["category_id"],
                "existing_clean_name": existing["clean_name"],
            }
        rid = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO category_rule
               (id, category_id, keyword, priority, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (rid, body.category_id, keyword,
             body.priority, body.amount_min, body.amount_max, body.debit_credit, body.clean_name, body.owner_id, body.account_id),
        )
        for tag_id in body.tag_ids:
            conn.execute(
                "INSERT OR IGNORE INTO rule_tag (rule_id, tag_id) VALUES (?, ?)",
                (rid, tag_id),
            )
    return {"id": rid, "status": "created", **body.model_dump()}


def _resulting_rule_state(current: dict, body: RuleUpdate) -> dict:
    """The rule's field values after applying the patch — used to detect an edit-induced collision
    before writing. Mirrors update_rule's precedence below, where the clear_* flags win."""
    return {
        "keyword":      body.keyword.lower().strip() if body.keyword is not None else current["keyword"],
        "owner_id":     None if body.clear_owner      else (body.owner_id   if body.owner_id   is not None else current["owner_id"]),
        "account_id":   None if body.clear_account    else (body.account_id if body.account_id is not None else current["account_id"]),
        "amount_min":   None if body.clear_amount_min else (body.amount_min if body.amount_min is not None else current["amount_min"]),
        "amount_max":   None if body.clear_amount_max else (body.amount_max if body.amount_max is not None else current["amount_max"]),
        "debit_credit": body.debit_credit if body.debit_credit is not None else current["debit_credit"],
        "category_id":  body.category_id  if body.category_id  is not None else current["category_id"],
        "clean_name":   None if body.clear_clean_name else (body.clean_name if body.clean_name is not None else current["clean_name"]),
    }


@router.patch("/{rule_id}")
def update_rule(rule_id: str, body: RuleUpdate, on_existing: Literal["reject", "merge"] = "reject"):
    """Update a rule, guarding the case where the edit makes its matcher collide with *another* rule.

    Unlike create, both rules already exist, so reconciling means one has to go: by default
    (`on_existing='reject'`) the collision is classified and reported without writing; with 'merge' the
    edited rule's actions fold into the other rule and the edited rule is deleted. A 'conflict' (the
    edit would assign a different category than the other rule) is never auto-merged — the user
    resolves it (edit the other rule, delete one, or change scope). `status` is 'updated' | 'merged' |
    'duplicate' | 'mergeable' | 'conflict'.
    """
    with get_db() as conn:
        current = conn.execute(
            """SELECT id, keyword, category_id, clean_name, owner_id, account_id,
                      amount_min, amount_max, debit_credit
               FROM category_rule WHERE id = ?""",
            (rule_id,),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Rule not found")

        resulting = _resulting_rule_state(current, body)
        resulting_tag_ids = (
            list(body.tag_ids) if body.tag_ids is not None
            else [r["tag_id"] for r in conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (rule_id,)).fetchall()]
        )
        # Another rule (not this one) that the edited matcher would now collide with. `IS` is null-safe.
        other = conn.execute(
            """SELECT id, category_id, clean_name FROM category_rule
               WHERE id != ?
                 AND keyword = ?
                 AND owner_id     IS ?
                 AND account_id   IS ?
                 AND amount_min   IS ?
                 AND amount_max   IS ?
                 AND debit_credit IS ?""",
            (rule_id, resulting["keyword"], resulting["owner_id"], resulting["account_id"],
             resulting["amount_min"], resulting["amount_max"], resulting["debit_credit"]),
        ).fetchone()
        if other:
            other_tag_ids = {
                r["tag_id"] for r in
                conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (other["id"],)).fetchall()
            }
            relation = _classify_rule_collision(
                other, other_tag_ids,
                category_id=resulting["category_id"], clean_name=resulting["clean_name"], tag_ids=resulting_tag_ids,
            )
            if on_existing == "merge" and relation in ("mergeable", "duplicate"):
                _merge_actions_into_rule(
                    conn, other,
                    category_id=resulting["category_id"], clean_name=resulting["clean_name"], tag_ids=resulting_tag_ids,
                )
                conn.execute("DELETE FROM rule_tag WHERE rule_id = ?", (rule_id,))
                conn.execute("DELETE FROM category_rule WHERE id = ?", (rule_id,))
                return {"id": other["id"], "status": "merged", "relation": relation, "deleted_rule_id": rule_id}
            return {
                "status": relation,
                "existing_rule_id": other["id"],
                "existing_category_id": other["category_id"],
                "existing_clean_name": other["clean_name"],
                "edited_rule_id": rule_id,
            }

        # No collision — apply the patch.
        fields, params = [], []
        if body.keyword     is not None: fields.append("keyword = ?");     params.append(resulting["keyword"])
        if body.category_id is not None: fields.append("category_id = ?"); params.append(body.category_id)
        if body.priority    is not None: fields.append("priority = ?");    params.append(body.priority)
        if body.amount_min  is not None: fields.append("amount_min = ?");  params.append(body.amount_min)
        if body.amount_max  is not None: fields.append("amount_max = ?");  params.append(body.amount_max)
        if body.debit_credit is not None: fields.append("debit_credit = ?"); params.append(body.debit_credit)
        if body.owner_id    is not None: fields.append("owner_id = ?");    params.append(body.owner_id)
        if body.account_id  is not None: fields.append("account_id = ?");  params.append(body.account_id)
        if body.clear_amount_min:        fields.append("amount_min = NULL")
        if body.clear_amount_max:        fields.append("amount_max = NULL")
        if body.clear_clean_name:        fields.append("clean_name = NULL")
        if body.clear_owner:             fields.append("owner_id = NULL")
        if body.clear_account:           fields.append("account_id = NULL")
        if body.clean_name  is not None and not body.clear_clean_name:
            fields.append("clean_name = ?"); params.append(body.clean_name)
        if fields:
            params.append(rule_id)
            conn.execute(f"UPDATE category_rule SET {', '.join(fields)} WHERE id = ?", params)
        if body.tag_ids is not None:
            conn.execute("DELETE FROM rule_tag WHERE rule_id = ?", (rule_id,))
            for tag_id in body.tag_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO rule_tag (rule_id, tag_id) VALUES (?, ?)",
                    (rule_id, tag_id),
                )
        post = conn.execute(
            "SELECT category_id, clean_name FROM category_rule WHERE id = ?",
            (rule_id,),
        ).fetchone()
        post_tag_ids = [
            row["tag_id"]
            for row in conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (rule_id,)).fetchall()
        ]
        if post and post["category_id"] is None and not (post["clean_name"] or "").strip() and not post_tag_ids:
            raise HTTPException(status_code=400, detail="Rules need at least one action: category, rename, or tag")
    return {"ok": True, "status": "updated"}


@router.post("/{rule_id}/apply")
def apply_rule(rule_id: str, preserve_manual: bool = False):
    with get_db() as conn:
        affected_ids = _apply_rule_to_existing(conn, rule_id, preserve_manual=preserve_manual)
    # `transaction_ids` lets an in-place caller reconcile exactly the rows the rule changed (re-fetch them
    # by id and merge them back) instead of re-running its scoped query, which would drop the now-
    # recategorized rows out of the view.
    return {"updated": len(affected_ids), "transaction_ids": affected_ids}


class ApplyToTransactionsBody(BaseModel):
    transaction_ids: list[str] = []


@router.post("/{rule_id}/apply-to-transactions")
def apply_rule_to_transactions(rule_id: str, body: ApplyToTransactionsBody):
    """Apply a rule's outputs (category/rename/tags) to a specific set of transactions — the rows that
    generated an accepted import-rule suggestion — so the user's review edits land on exactly those
    rows. Skips manual rows (deliberate exceptions) and rows the matcher no longer matches."""
    with get_db() as conn:
        affected_ids = _apply_rule_to_existing(
            conn, rule_id, preserve_manual=True, txn_ids=body.transaction_ids,
        )
    return {"updated": len(affected_ids), "transaction_ids": affected_ids}


@router.delete("/{rule_id}")
def delete_rule(rule_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM category_rule WHERE id = ?", (rule_id,))
    return {"ok": True}
