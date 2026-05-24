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


def _apply_rule_to_existing(conn, rule_id: str) -> int:
    rule = conn.execute(
        """SELECT id, keyword, category_id, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id
           FROM category_rule
           WHERE id = ?""",
        (rule_id,),
    ).fetchone()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    txns = conn.execute(
        """SELECT
               t.id,
               t.merchant_name,
               t.display_name,
               t.raw_name,
               t.amount,
               t.owner_id,
               t.account_id,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id
           FROM txn t
           JOIN account a ON a.id = t.account_id"""
    ).fetchall()

    rule_tag_ids = [
        row["tag_id"]
        for row in conn.execute(
            "SELECT tag_id FROM rule_tag WHERE rule_id = ?",
            (rule_id,),
        ).fetchall()
    ]

    updated = 0
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
            updated += 1

    return updated


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


@router.post("")
def create_rule(body: RuleCreate):
    if not body.category_id and not (body.clean_name or "").strip() and not body.tag_ids:
        raise HTTPException(status_code=400, detail="Rules need at least one action: category, rename, or tag")
    rid = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            """INSERT INTO category_rule
               (id, category_id, keyword, priority, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (rid, body.category_id, body.keyword.lower().strip(),
             body.priority, body.amount_min, body.amount_max, body.debit_credit, body.clean_name, body.owner_id, body.account_id),
        )
        for tag_id in body.tag_ids:
            conn.execute(
                "INSERT OR IGNORE INTO rule_tag (rule_id, tag_id) VALUES (?, ?)",
                (rid, tag_id),
            )
    return {"id": rid, **body.model_dump()}


@router.patch("/{rule_id}")
def update_rule(rule_id: str, body: RuleUpdate):
    with get_db() as conn:
        fields, params = [], []
        if body.keyword     is not None: fields.append("keyword = ?");     params.append(body.keyword.lower().strip())
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
        current = conn.execute(
            "SELECT category_id, clean_name FROM category_rule WHERE id = ?",
            (rule_id,),
        ).fetchone()
        current_tag_ids = [
            row["tag_id"]
            for row in conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (rule_id,)).fetchall()
        ]
        if current and current["category_id"] is None and not (current["clean_name"] or "").strip() and not current_tag_ids:
            raise HTTPException(status_code=400, detail="Rules need at least one action: category, rename, or tag")
    return {"ok": True}


@router.post("/{rule_id}/apply")
def apply_rule(rule_id: str):
    with get_db() as conn:
        updated = _apply_rule_to_existing(conn, rule_id)
    return {"updated": updated}


@router.delete("/{rule_id}")
def delete_rule(rule_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM category_rule WHERE id = ?", (rule_id,))
    return {"ok": True}
