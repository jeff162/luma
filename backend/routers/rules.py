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
from typing import Optional
from backend.db.database import get_db
from backend.services.categorizer import _amount_matches

router = APIRouter()


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
             CASE WHEN owner_id   IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) DESC
        """
    ).fetchall()

    abs_amount = abs(txn["amount"])
    for rule in rules:
        full_rule = conn.execute(
            """
            SELECT id, keyword, amount_min, amount_max, owner_id, account_id
            FROM category_rule
            WHERE id = ?
            """,
            (rule["id"],),
        ).fetchone()
        if full_rule["owner_id"] is not None and full_rule["owner_id"] != txn["owner_id"]:
            continue
        if full_rule["account_id"] is not None and full_rule["account_id"] != txn["account_id"]:
            continue
        if full_rule["keyword"].lower() not in text:
            continue
        if not _amount_matches(abs_amount, full_rule["amount_min"], full_rule["amount_max"]):
            continue
        return full_rule["id"]
    return None


def _rule_matches_txn(rule, txn) -> bool:
    if rule["owner_id"] is not None and rule["owner_id"] != txn["owner_id"]:
        return False
    if rule["account_id"] is not None and rule["account_id"] != txn["account_id"]:
        return False
    text = " ".join(filter(None, [
        txn["display_name"],
        txn["merchant_name"],
        txn["raw_name"],
    ])).lower()
    if not text or rule["keyword"].lower() not in text:
        return False
    return _amount_matches(abs(txn["amount"]), rule["amount_min"], rule["amount_max"])


def _apply_rule_to_existing(conn, rule_id: str) -> int:
    rule = conn.execute(
        """SELECT id, keyword, category_id, amount_min, amount_max, clean_name, owner_id, account_id
           FROM category_rule
           WHERE id = ?""",
        (rule_id,),
    ).fetchone()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    txns = conn.execute(
        """SELECT id, merchant_name, display_name, raw_name, amount, owner_id, account_id
           FROM txn"""
    ).fetchall()

    updated = 0
    for txn in txns:
        if not _rule_matches_txn(rule, txn):
            continue
        params = [rule["category_id"]]
        # An explicit apply is the user asking the rule to own these matches, so any
        # prior auto state is replaced with the rule's category/clean name output.
        set_parts = ["category_id = ?", "category_overridden = 0"]
        if rule["clean_name"]:
            set_parts.append("display_name = ?")
            params.append(rule["clean_name"])
        params.append(txn["id"])
        conn.execute(
            f"UPDATE txn SET {', '.join(set_parts)} WHERE id = ?",
            params,
        )
        updated += 1

    return updated


class RuleCreate(BaseModel):
    keyword:     str
    category_id: str
    priority:    int   = 5
    amount_min:  Optional[float] = None
    amount_max:  Optional[float] = None
    clean_name:  Optional[str]   = None
    owner_id:    Optional[str]   = None
    account_id:  Optional[str]   = None


class RuleUpdate(BaseModel):
    keyword:     Optional[str]   = None
    category_id: Optional[str]   = None
    priority:    Optional[int]   = None
    amount_min:  Optional[float] = None
    amount_max:  Optional[float] = None
    clean_name:  Optional[str]   = None
    owner_id:    Optional[str]   = None
    account_id:  Optional[str]   = None
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
                cr.amount_min, cr.amount_max, cr.clean_name,
                cr.category_id,
                cr.owner_id,
                cr.account_id,
                c.name  AS category_name,
                NULL    AS category_color,
                p.name  AS parent_name,
                o.name  AS owner_name,
                o.color AS owner_color,
                a.name  AS account_name,
                a.mask  AS account_mask
            FROM   category_rule cr
            JOIN   category c  ON c.id  = cr.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            LEFT JOIN owner    o ON o.id = cr.owner_id
            LEFT JOIN account  a ON a.id = cr.account_id
            {where}
            ORDER BY
                cr.keyword ASC,
                -- Within the same keyword, list less-specific rules first
                -- (more-specific rules evaluate first but are listed last,
                --  so the list reads: general → specific, top → bottom)
                LENGTH(cr.keyword) ASC,
                (CASE WHEN cr.amount_min IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN cr.amount_max IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN cr.owner_id   IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN cr.account_id IS NOT NULL THEN 1 ELSE 0 END) ASC
            """,
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/match/transaction/{txn_id}")
def match_rule_for_transaction(txn_id: str):
    with get_db() as conn:
        txn = conn.execute(
            """
            SELECT id, merchant_name, display_name, raw_name, amount, owner_id, account_id
            FROM txn
            WHERE id = ?
            """,
            (txn_id,),
        ).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
        rule_id = _find_matching_rule(conn, txn)
    return {"rule_id": rule_id}


@router.post("")
def create_rule(body: RuleCreate):
    rid = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            """INSERT INTO category_rule
               (id, category_id, keyword, priority, amount_min, amount_max, clean_name, owner_id, account_id)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (rid, body.category_id, body.keyword.lower().strip(),
             body.priority, body.amount_min, body.amount_max, body.clean_name, body.owner_id, body.account_id),
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
