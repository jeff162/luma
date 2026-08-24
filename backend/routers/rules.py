# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

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
from backend.services.categorizer import (
    _amount_rule_matches,
    rule_matches_row,
    recategorize_all,
    source_match_text_from_json,
    build_match_expr,
    merchant_matcher_matches,
    match_expr_clause_texts,
    bump_rule_effect_dates,
    rule_scope_account_sql,
)
from backend.services.recurring_detection import CADENCES, link_series_members, _normalize_payee
from backend.services.transaction_tags import sync_rule_tags_for_transaction, would_sync_rule_tags_change, get_visible_transaction_tag_map

router = APIRouter()

# Cadence name -> period in whole days, for seeding a rule-backed series (mirrors recurring.py).
_CADENCE_DAYS = {name: int(round(days)) for name, days in CADENCES}


def _drop_recurring_series_for_rule(conn, rule_id: str) -> None:
    """Remove any recurring series backed by this rule (unlink its members and its override rows first, so
    nothing dangles). Used when a rule's recurring flag is cleared, the rule is deleted, or an edit merges
    the rule away."""
    for s in conn.execute("SELECT id FROM recurring_series WHERE rule_id = ?", (rule_id,)).fetchall():
        conn.execute("UPDATE txn SET recurring_series_id = NULL WHERE recurring_series_id = ?", (s["id"],))
        conn.execute("DELETE FROM recurring_membership_override WHERE series_id = ?", (s["id"],))
        conn.execute("DELETE FROM recurring_series WHERE id = ?", (s["id"],))


def _ensure_recurring_series(conn, rule_id: str, cadence: str | None) -> str:
    """Create (or refresh) the recurring series a rule with is_recurring=1 owns. The series is source='rule'
    and user-owned (confirmed), so scans preserve it; its membership is the rule's matches, filled right
    away via link_series_members so the card shows its charges immediately. `cadence` sets the initial
    rhythm on create and updates it on a later save; the series' amount band / next_due derive from the
    matched rows."""
    existing = conn.execute("SELECT id, cadence FROM recurring_series WHERE rule_id = ?", (rule_id,)).fetchone()
    cadence = cadence or (existing["cadence"] if existing else "monthly")
    if cadence not in _CADENCE_DAYS:
        cadence = "monthly"
    period_days = _CADENCE_DAYS[cadence]
    if existing is None:
        rule = conn.execute(
            "SELECT keyword, clean_name, category_id, account_id FROM category_rule WHERE id = ?", (rule_id,)
        ).fetchone()
        display_name = ((rule["clean_name"] or rule["keyword"] or "Recurring") if rule else "Recurring").strip()
        series_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO recurring_series
                 (id, payee_key, display_name, category_id, account_id, cadence, period_days,
                  occurrence_count, confidence, status, source, rule_id, confirmed, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'active', 'rule', ?, 1, datetime('now'))""",
            (series_id, _normalize_payee(display_name) or display_name.lower(), display_name,
             rule["category_id"] if rule else None, rule["account_id"] if rule else None,
             cadence, period_days, rule_id),
        )
    else:
        series_id = existing["id"]
        conn.execute(
            "UPDATE recurring_series SET cadence = ?, period_days = ?, updated_at = datetime('now') WHERE id = ?",
            (cadence, period_days, series_id),
        )
    link_series_members(conn, series_id)
    return series_id


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


def _txn_source_match_text(txn) -> str:
    """The row's captured import source text (lowercased), for `match_source_text` rules. Callers
    whose txn SELECT omits `import_evidence_json` get '' (no source-text match), which is safe."""
    try:
        return source_match_text_from_json(txn["import_evidence_json"])
    except (KeyError, IndexError):
        return ""


def _find_matching_rule(conn, txn):
    text = " ".join(filter(None, [
        txn["display_name"],
        txn["merchant_name"],
        txn["raw_name"],
    ])).lower()
    source_text = _txn_source_match_text(txn)
    if not text and not source_text:
        return None

    # Mirror the engine's specificity ordering so "match this transaction" previews and
    # explicit apply flows agree with what future imports/syncs would pick automatically.
    rules = conn.execute(
        """
        SELECT id
        FROM   category_rule
        WHERE  deleted_at IS NULL
        ORDER  BY
            CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END DESC,
            CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END DESC,
            CASE WHEN account_type IS NOT NULL THEN 1 ELSE 0 END DESC,
            LENGTH(keyword) DESC,
            (CASE WHEN amount_min IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN amount_max IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN COALESCE(debit_credit, 'both') <> 'both' THEN 1 ELSE 0 END +
             CASE WHEN owner_id     IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN account_id   IS NOT NULL THEN 1 ELSE 0 END +
             CASE WHEN account_type IS NOT NULL THEN 1 ELSE 0 END) DESC
        """
    ).fetchall()

    fallback_rule_id = None
    for rule in rules:
        full_rule = conn.execute(
            f"""
            SELECT id, keyword, match_expr, amount_min, amount_max, debit_credit, owner_id,
                   {rule_scope_account_sql()}, account_type, category_id, clean_name, match_source_text
            FROM category_rule
            WHERE id = ?
            """,
            (rule["id"],),
        ).fetchone()
        if full_rule["owner_id"] is not None and full_rule["owner_id"] != txn["owner_id"]:
            continue
        if full_rule["account_id"] is not None and full_rule["account_id"] != txn["effective_account_id"]:
            continue
        if full_rule["account_type"] is not None and full_rule["account_type"] != txn["effective_account_type"]:
            continue
        if not merchant_matcher_matches(full_rule, text, source_text, full_rule["match_source_text"]):
            continue
        if not _amount_rule_matches(txn["amount"], full_rule["amount_min"], full_rule["amount_max"], full_rule["debit_credit"]):
            continue
        if full_rule["category_id"] is None and not full_rule["clean_name"]:
            fallback_rule_id = full_rule["id"]
            continue
        return full_rule["id"]
    return fallback_rule_id


def _rule_matches_txn(rule, txn) -> bool:
    # Thin wrapper over the shared service predicate so rule apply and rule-backed recurring membership
    # can never diverge on "which rows a rule owns". `txn` here carries import_evidence_json when present.
    return rule_matches_row(rule, txn)


def _rule_affected_txn_ids(conn, rule) -> list[str]:
    """The `category_overridden = 0` transactions a rule currently matches — the candidate set for a scoped
    reconcile when the rule is deleted or its scope narrowed with the "re-evaluate this rule's
    transactions" opt-in. Uses the same shared matcher as apply, so "which rows a rule owns" has one
    definition. Gathered *before* the delete/edit so the old matcher is still in force; the reconcile then
    re-derives each row against the remaining rules (a fell-out row clears or moves to another rule; a
    still-matched row is unchanged)."""
    rows = conn.execute(
        """SELECT t.id, t.merchant_name, t.display_name, t.raw_name, t.amount, t.owner_id, t.account_id,
                  t.import_evidence_json, COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                  COALESCE(p.type, a.type) AS effective_account_type
           FROM   txn t JOIN account a ON a.id = t.account_id
           LEFT   JOIN account p ON p.id = a.parent_account_id
           WHERE  t.category_overridden = 0"""
    ).fetchall()
    return [r["id"] for r in rows if _rule_matches_txn(rule, r)]


def _apply_rule_to_existing(conn, rule_id: str, *, preserve_manual: bool = False, txn_ids: Optional[list[str]] = None, capture_prior: Optional[list] = None, skipped_splits: Optional[list] = None) -> list[str]:
    # `capture_prior` (optional): when given, the prior (category_id, category_source, category_overridden)
    # of each row whose category this apply changes is appended to it — the same snapshot shape
    # `/restore-categorization` consumes — so an accept can stash it for Undo and put the rows back.
    # `preserve_manual` reclaims the rows a rule should own — including import-locked ones
    # (category_source = 'import') — while leaving a deliberate per-transaction manual edit
    # (category_source = 'manual') untouched. Used when a merge/replace changes the governing rule:
    # the rule's prior matches should follow it, but a manual override is the user's final say.
    # `txn_ids` restricts the apply to a specific set of rows (still subject to the matcher check) — used
    # when accepting an import-rule suggestion so the rule's outputs land on exactly the rows that
    # generated it, leaving conflicting rows for other suggestions alone.
    # `skipped_splits` (optional): ids of rows whose *category* this apply declined to set because the
    # transaction is split. A split's allocations are hand-built work with no stashed copy anywhere, so
    # no rule apply — not even the full-force one that overwrites a manual edit — may silently replace
    # them; the caller reports the count instead. The refusal is scoped to the category effect only:
    # a rule's rename and tags describe the purchase, not its allocation, so those still apply.
    rule = conn.execute(
        f"""SELECT id, keyword, match_expr, category_id, amount_min, amount_max, debit_credit, clean_name,
                   owner_id, {rule_scope_account_sql()}, account_type, match_source_text
           FROM category_rule
           WHERE id = ?""",
        (rule_id,),
    ).fetchone()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    where_clauses, where_params = [], []
    if preserve_manual:
        # Preserve-manual reclaims import-locked rows but spares a deliberate manual edit — and,
        # for the same reason recategorize_all does, spares `enrichment` rows: a feature-owned
        # excluded Amazon charge / suppressed funding leg must not be pulled into a rule's category
        # by an automatic reclaim (it would un-exclude and double-count). The unscoped full-force
        # apply (preserve_manual=False) remains the only path that may take them.
        where_clauses.append("t.category_source IS NOT 'manual'")
        where_clauses.append("t.category_source IS NOT 'enrichment'")
    if txn_ids is not None:
        if not txn_ids:
            return []
        where_clauses.append(f"t.id IN ({','.join('?' * len(txn_ids))})")
        where_params.extend(txn_ids)
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    txns = conn.execute(
        f"""SELECT
               t.id,
               t.date,
               t.merchant_name,
               t.display_name,
               t.raw_name,
               t.amount,
               t.owner_id,
               t.account_id,
               t.import_evidence_json,
               t.category_id          AS prior_category_id,
               t.category_source      AS prior_category_source,
               t.category_overridden  AS prior_category_overridden,
               t.is_split,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               COALESCE(p.type, a.type) AS effective_account_type
           FROM txn t
           JOIN account a ON a.id = t.account_id
           LEFT JOIN account p ON p.id = a.parent_account_id
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
    effect_max_date = None  # newest date this rule applies an effect to (for last_effect_date)
    for txn in txns:
        if not _rule_matches_txn(rule, txn):
            continue
        if txn["date"] and (effect_max_date is None or txn["date"] > effect_max_date):
            effect_max_date = txn["date"]
        row_changed = False
        # A split transaction keeps its allocations: the category half of this rule is declined and
        # reported, while the rename half below still runs.
        split_blocked = bool(txn["is_split"]) and rule["category_id"] is not None
        if split_blocked and skipped_splits is not None:
            skipped_splits.append(txn["id"])
        if (rule["category_id"] is not None and not split_blocked) or rule["clean_name"]:
            params = []
            set_parts = []
            if rule["category_id"] is not None and not split_blocked:
                # An explicit apply is the user asking the rule to own these matches, so any
                # prior auto state is replaced with the rule's category output when provided.
                if capture_prior is not None:
                    capture_prior.append({
                        "id": txn["id"],
                        "category_id": txn["prior_category_id"],
                        "category_source": txn["prior_category_source"],
                        "category_overridden": txn["prior_category_overridden"],
                    })
                set_parts.extend(["category_id = ?", "category_overridden = 0", "category_source = 'rule'"])
                params.append(rule["category_id"])
            if rule["clean_name"]:
                # This apply is the explicit "let the rule own these rows" path (the preserve-manual
                # variant filters manual rows out upstream), so the rule's clean_name authors the name
                # and stamps its provenance 'rule'.
                set_parts.append("display_name = ?")
                set_parts.append("display_name_source = 'rule'")
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

    # The rule just applied its effect across these matches — advance its last_effect_date to the newest.
    if effect_max_date:
        bump_rule_effect_dates(conn, {rule_id: effect_max_date})
    return affected_ids


class RulePreview(BaseModel):
    keyword:      str
    # Optional multi-clause (AND / contains) merchant matcher; when it resolves to >= 2 clauses it
    # supersedes `keyword` (which the backend then derives from the clause texts). See build_match_expr.
    clauses:      Optional[list[str]] = None
    category_id:  Optional[str] = None
    amount_min:   Optional[float] = None
    amount_max:   Optional[float] = None
    debit_credit: Literal["both", "debit", "credit"] = "both"
    clean_name:   Optional[str] = None
    owner_id:     Optional[str] = None
    account_id:   Optional[str] = None
    account_type: Optional[str] = None
    tag_ids:      list[str] = []
    match_source_text: bool = False


# The candidate-row query shared by the preview (would-change) and matches (all matcher hits) endpoints:
# every field `_rule_matches_txn` needs plus the columns the rules-page transaction report renders. Ordered
# newest-first so a capped matches result keeps the most recent rows.
_RULE_PREVIEW_ROW_SQL = """
    SELECT
        t.id, t.date, t.amount, t.merchant_name, t.display_name, t.raw_name,
        t.is_pending, t.category_overridden, t.notes, t.import_evidence_json,
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
        COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
        COALESCE(p.type, a.type) AS effective_account_type
    FROM txn t
    JOIN account a ON a.id = t.account_id
    LEFT JOIN account p ON p.id = a.parent_account_id
    LEFT JOIN category c ON c.id = t.category_id
    LEFT JOIN import_batch b ON b.id = t.import_batch_id
    LEFT JOIN owner o ON o.id = t.owner_id
    ORDER BY t.date DESC
"""

# Cap the rows a matches report returns (the true count is always reported separately) so a broad rule's
# hover/report can't pull a multi-thousand-row payload; newest rows win via the query's ORDER BY.
_RULE_MATCHES_ROW_LIMIT = 500


@router.post("/preview")
def preview_rule(body: RulePreview):
    """Return transactions that would actually change if this rule were applied."""
    keyword, match_expr = _resolve_matcher(body.clauses, body.keyword)
    rule = {
        "keyword":     keyword,
        "match_expr":  match_expr,
        "category_id": body.category_id,
        "amount_min":  body.amount_min,
        "amount_max":  body.amount_max,
        "debit_credit": body.debit_credit,
        "clean_name":  body.clean_name,
        "owner_id":    body.owner_id,
        "account_id":  body.account_id,
        "account_type": body.account_type,
        "match_source_text": body.match_source_text,
    }
    rule_tag_ids = set(body.tag_ids)

    with get_db() as conn:
        rows = conn.execute(_RULE_PREVIEW_ROW_SQL).fetchall()

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


@router.get("/{rule_id}/matches")
def rule_matches(rule_id: str):
    """Existing transactions this rule's matcher currently matches — *every* match, not only the rows an
    apply would change (that's `/preview`). Read-only; powers the per-rule count + report on the Rules
    page. Returns the true total `count` plus up to `_RULE_MATCHES_ROW_LIMIT` of the newest matched rows."""
    with get_db() as conn:
        rule = conn.execute(
            f"""SELECT id, keyword, match_expr, amount_min, amount_max, debit_credit, owner_id,
                      {rule_scope_account_sql()}, account_type, category_id, clean_name, match_source_text
               FROM category_rule WHERE id = ?""",
            (rule_id,),
        ).fetchone()
        if not rule:
            raise HTTPException(status_code=404, detail="Rule not found")
        rows = conn.execute(_RULE_PREVIEW_ROW_SQL).fetchall()
        matched = []
        count = 0
        for row in rows:
            txn = dict(row)
            if not _rule_matches_txn(rule, txn):
                continue
            count += 1
            if len(matched) < _RULE_MATCHES_ROW_LIMIT:
                txn.pop("effective_account_id", None)
                matched.append(txn)
        tag_map = get_visible_transaction_tag_map(conn, [t["id"] for t in matched]) if matched else {}
        for txn in matched:
            txn["tags"] = tag_map.get(txn["id"], [])
    return {"count": count, "transactions": matched}


class RuleCreate(BaseModel):
    keyword:     str
    # Optional multi-clause (AND / contains) merchant matcher; a request that resolves to >= 2 clauses
    # supersedes `keyword` and the stored keyword is derived from the clause texts (see build_match_expr).
    clauses:     Optional[list[str]] = None
    category_id: Optional[str] = None
    amount_min:  Optional[float] = None
    amount_max:  Optional[float] = None
    debit_credit: Literal["both", "debit", "credit"] = "both"
    clean_name:  Optional[str]   = None
    owner_id:    Optional[str]   = None
    account_id:  Optional[str]   = None
    account_type: Optional[str]  = None
    tag_ids:     list[str]       = []
    match_source_text: bool      = False
    # Declare this rule a recurring series: its matches become members of a source='rule' series (cadence
    # seeds the rhythm). is_recurring counts as a valid rule action on its own (track-recurrence-only rule).
    is_recurring: bool           = False
    cadence:     Optional[str]   = None


class RuleUpdate(BaseModel):
    keyword:     Optional[str]   = None
    # When provided, replaces the merchant matcher: >= 2 clauses store a match_expr (keyword derived from
    # them); 0/1 clause clears any existing match_expr back to a plain keyword. None leaves it unchanged.
    clauses:     Optional[list[str]] = None
    category_id: Optional[str]   = None
    amount_min:  Optional[float] = None
    amount_max:  Optional[float] = None
    debit_credit: Optional[Literal["both", "debit", "credit"]] = None
    clean_name:  Optional[str]   = None
    owner_id:    Optional[str]   = None
    account_id:  Optional[str]   = None
    account_type: Optional[str]  = None
    tag_ids:     Optional[list[str]] = None
    match_source_text: Optional[bool] = None
    is_recurring:     Optional[bool] = None
    cadence:          Optional[str] = None
    clear_amount_min: bool = False
    clear_amount_max: bool = False
    clear_clean_name: bool = False
    clear_owner:      bool = False
    clear_account:    bool = False
    clear_account_type: bool = False


@router.get("")
def list_rules(search: Optional[str] = Query(None)):
    # Active (non-trashed) rules only; trashed rules live behind /rules/trash.
    where  = "WHERE cr.deleted_at IS NULL" + (" AND cr.keyword LIKE ?" if search else "")
    params = [f"%{search}%"] if search else []
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                cr.id, cr.keyword, cr.match_expr,
                cr.amount_min, cr.amount_max, cr.debit_credit, cr.clean_name,
                cr.category_id,
                cr.owner_id,
                cr.account_id,
                cr.account_type,
                cr.match_source_text,
                cr.is_recurring,
                cr.last_effect_date,
                cr.is_managed,
                (SELECT rs.cadence FROM recurring_series rs WHERE rs.rule_id = cr.id) AS recurring_cadence,
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
            # A uniform clause list for the client: the multi-clause texts when match_expr is set, else the
            # single keyword as a one-element list (so the editor and list render one way for both shapes).
            rule["clauses"] = match_expr_clause_texts(rule.get("match_expr")) or (
                [rule["keyword"]] if rule["keyword"] else []
            )
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
                t.import_evidence_json,
                COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                COALESCE(p.type, a.type) AS effective_account_type
            FROM txn t
            JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
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


def _resolve_matcher(clauses, keyword_field) -> tuple[str, Optional[str]]:
    """Resolve a request's `(keyword_to_store, match_expr_json_or_None)` from its optional `clauses` list and
    its plain `keyword` field. >= 2 clauses derive the keyword from the canonical clause texts and store a
    match_expr; 0/1 clause (or no `clauses` at all) is a plain single-substring rule with no expr."""
    if clauses is not None:
        match_expr, derived = build_match_expr(clauses)
        if match_expr is not None:
            return derived, match_expr
        return (derived or (keyword_field or "").lower().strip()), None
    return (keyword_field or "").lower().strip(), None


def _existing_rule_for_matcher(conn, keyword: str, match_expr: Optional[str], body: "RuleCreate"):
    # The matcher is keyword + match_expr + the full scope (owner, account, account *type*, amount range,
    # direction) + whether the rule also matches source text. match_expr distinguishes a multi-clause rule
    # from a single-keyword one that happens to share the derived keyword; it is a canonical JSON string
    # (clauses sorted) so clause order never forks a phantom duplicate. `IS` is SQLite's null-safe compare.
    return conn.execute(
        """SELECT id, category_id, clean_name FROM category_rule
           WHERE keyword = ?
             AND match_expr   IS ?
             AND owner_id     IS ?
             AND account_id   IS ?
             AND account_type IS ?
             AND amount_min   IS ?
             AND amount_max   IS ?
             AND debit_credit IS ?
             AND match_source_text IS ?
             AND deleted_at IS NULL""",
        (keyword, match_expr, body.owner_id, body.account_id, body.account_type, body.amount_min,
         body.amount_max, body.debit_credit, int(bool(body.match_source_text))),
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


def create_rule_core(conn, body: "RuleCreate", on_existing: str = "reject") -> dict:
    """Create a rule against an already-open connection, reconciling against any existing rule with the
    same matcher. This is the reusable core of the POST endpoint below (a thin ``get_db()`` wrapper) and of
    any in-process caller that already owns a transaction — e.g. the PayPal money-movement Type rules
    (`services/money_movement.create_money_movement_rules`), which route here so they inherit the
    one-matcher reconciliation rather than re-implementing a slice of it.

    Two rules sharing a matcher can't coexist cleanly — whichever the engine orders first wins, and
    editing one leaves the other firing. So rather than fork a duplicate, a collision is classified
    (duplicate / mergeable / conflict) and, by default (`on_existing='reject'`), reported back without
    writing. Callers then decide: a single manual save prompts the user (merge, or open the existing
    rule); the bulk Generate Rules flow and the money-movement apply pass `on_existing='merge'` to fold
    mergeable saves in and skip duplicates, surfacing only conflicts. A genuinely different matcher is not
    a collision and is created normally. `status` is 'created' | 'merged' | 'duplicate' | 'mergeable'
    | 'conflict'; a 'merged' result also carries `relation` ('mergeable' vs. a no-op 'duplicate') so a
    caller can tell whether anything actually changed.
    """
    if not body.category_id and not (body.clean_name or "").strip() and not body.tag_ids and not body.is_recurring:
        raise HTTPException(status_code=400, detail="Rules need at least one action: category, rename, tag, or recurring")
    keyword, match_expr = _resolve_matcher(body.clauses, body.keyword)
    if not keyword:
        raise HTTPException(status_code=400, detail="Rules need a merchant keyword or at least one match clause")
    existing = _existing_rule_for_matcher(conn, keyword, match_expr, body)
    if existing:
        existing_tag_ids = {
            row["tag_id"] for row in
            conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (existing["id"],)).fetchall()
        }
        relation = _classify_rule_collision(
            existing, existing_tag_ids,
            category_id=body.category_id, clean_name=body.clean_name, tag_ids=body.tag_ids,
        )
        # Turning an existing matcher recurring is always an additive, non-conflicting action, so a save
        # that only adds is_recurring should merge rather than be reported as a bare duplicate.
        if on_existing == "merge" and (relation in ("mergeable", "duplicate") or body.is_recurring):
            _merge_actions_into_rule(
                conn, existing,
                category_id=body.category_id, clean_name=body.clean_name, tag_ids=body.tag_ids,
            )
            if body.is_recurring:
                conn.execute("UPDATE category_rule SET is_recurring = 1 WHERE id = ?", (existing["id"],))
                _ensure_recurring_series(conn, existing["id"], body.cadence)
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
           (id, category_id, keyword, match_expr, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id, account_type, match_source_text, is_recurring)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (rid, body.category_id, keyword, match_expr,
         body.amount_min, body.amount_max, body.debit_credit, body.clean_name, body.owner_id, body.account_id,
         body.account_type, int(bool(body.match_source_text)), int(bool(body.is_recurring))),
    )
    for tag_id in body.tag_ids:
        conn.execute(
            "INSERT OR IGNORE INTO rule_tag (rule_id, tag_id) VALUES (?, ?)",
            (rid, tag_id),
        )
    if body.is_recurring:
        _ensure_recurring_series(conn, rid, body.cadence)
    return {"id": rid, "status": "created", **body.model_dump()}


@router.post("")
def create_rule(body: RuleCreate, on_existing: Literal["reject", "merge"] = "reject"):
    """Create a rule, reconciling against any existing rule with the same matcher — the HTTP wrapper around
    :func:`create_rule_core` (see it for the reconciliation contract and `status` values)."""
    with get_db() as conn:
        return create_rule_core(conn, body, on_existing)


def _resulting_matcher(current: dict, body: RuleUpdate) -> tuple[str, Optional[str]]:
    """The `(keyword, match_expr)` the rule will have after the patch: a provided `clauses` list replaces
    the merchant matcher; an explicit `keyword` with no `clauses` becomes a plain single-substring matcher
    (clearing any existing expr); otherwise both are left as they are."""
    if body.clauses is not None:
        return _resolve_matcher(body.clauses, body.keyword)
    if body.keyword is not None:
        return body.keyword.lower().strip(), None
    return current["keyword"], current["match_expr"]


def _resulting_rule_state(current: dict, body: RuleUpdate) -> dict:
    """The rule's field values after applying the patch — used to detect an edit-induced collision
    before writing. Mirrors update_rule's precedence below, where the clear_* flags win."""
    resulting_keyword, resulting_match_expr = _resulting_matcher(current, body)
    return {
        "keyword":      resulting_keyword,
        "match_expr":   resulting_match_expr,
        "owner_id":     None if body.clear_owner      else (body.owner_id   if body.owner_id   is not None else current["owner_id"]),
        "account_id":   None if body.clear_account    else (body.account_id if body.account_id is not None else current["account_id"]),
        "account_type": None if body.clear_account_type else (body.account_type if body.account_type is not None else current["account_type"]),
        "amount_min":   None if body.clear_amount_min else (body.amount_min if body.amount_min is not None else current["amount_min"]),
        "amount_max":   None if body.clear_amount_max else (body.amount_max if body.amount_max is not None else current["amount_max"]),
        "debit_credit": body.debit_credit if body.debit_credit is not None else current["debit_credit"],
        "category_id":  body.category_id  if body.category_id  is not None else current["category_id"],
        "clean_name":   None if body.clear_clean_name else (body.clean_name if body.clean_name is not None else current["clean_name"]),
        "match_source_text": int(bool(body.match_source_text)) if body.match_source_text is not None else current["match_source_text"],
    }


@router.patch("/{rule_id}")
def update_rule(rule_id: str, body: RuleUpdate, on_existing: Literal["reject", "merge"] = "reject",
                reconcile: bool = False):
    """Update a rule, guarding the case where the edit makes its matcher collide with *another* rule.

    Unlike create, both rules already exist, so reconciling means one has to go: by default
    (`on_existing='reject'`) the collision is classified and reported without writing; with 'merge' the
    edited rule's actions fold into the other rule and the edited rule is deleted. A 'conflict' (the
    edit would assign a different category than the other rule) is never auto-merged — the user
    resolves it (edit the other rule, delete one, or change scope). `status` is 'updated' | 'merged' |
    'duplicate' | 'mergeable' | 'conflict'.

    `reconcile` (opt-in, default off) re-evaluates the transactions this rule *used* to match: rows that
    the edit pushes out of scope are recomputed against the remaining rules (falling to another rule or to
    uncategorized) instead of retaining their old category. It is captured from the pre-edit matcher, so it
    catches exactly the rows a narrowed keyword/scope drops. Only applied on a clean update (not a
    collision merge/report).
    """
    with get_db() as conn:
        current = conn.execute(
            """SELECT id, keyword, match_expr, category_id, clean_name, owner_id, account_id, account_type,
                      amount_min, amount_max, debit_credit, match_source_text, is_recurring
               FROM category_rule WHERE id = ?""",
            (rule_id,),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Rule not found")

        # Capture the rows the *old* rule owned before the edit changes its matcher, so a scoped reconcile
        # below can re-evaluate exactly the rows an edit drops from scope.
        affected = _rule_affected_txn_ids(conn, current) if reconcile else []

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
                 AND match_expr   IS ?
                 AND owner_id     IS ?
                 AND account_id   IS ?
                 AND account_type IS ?
                 AND amount_min   IS ?
                 AND amount_max   IS ?
                 AND debit_credit IS ?
                 AND match_source_text IS ?
                 AND deleted_at IS NULL""",
            (rule_id, resulting["keyword"], resulting["match_expr"], resulting["owner_id"], resulting["account_id"],
             resulting["account_type"], resulting["amount_min"], resulting["amount_max"],
             resulting["debit_credit"], resulting["match_source_text"]),
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
                # The edited rule is about to be deleted; drop any recurring series it backed so it doesn't
                # dangle at a now-gone rule (the surviving rule keeps its own recurring status, if any).
                _drop_recurring_series_for_rule(conn, rule_id)
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
        # `clauses` or `keyword` redefines the merchant matcher; write keyword + match_expr together so the
        # derived keyword and the stored expr can never drift (a clauses→single or single→clauses edit flips
        # match_expr on or off). `resulting` already resolved both under _resulting_matcher's precedence.
        if body.clauses is not None or body.keyword is not None:
            fields.append("keyword = ?");    params.append(resulting["keyword"])
            fields.append("match_expr = ?"); params.append(resulting["match_expr"])
        if body.category_id is not None: fields.append("category_id = ?"); params.append(body.category_id)
        if body.amount_min  is not None: fields.append("amount_min = ?");  params.append(body.amount_min)
        if body.amount_max  is not None: fields.append("amount_max = ?");  params.append(body.amount_max)
        if body.debit_credit is not None: fields.append("debit_credit = ?"); params.append(body.debit_credit)
        if body.owner_id    is not None: fields.append("owner_id = ?");    params.append(body.owner_id)
        if body.account_id  is not None: fields.append("account_id = ?");  params.append(body.account_id)
        if body.account_type is not None: fields.append("account_type = ?"); params.append(body.account_type)
        if body.match_source_text is not None: fields.append("match_source_text = ?"); params.append(int(bool(body.match_source_text)))
        if body.is_recurring is not None: fields.append("is_recurring = ?"); params.append(int(bool(body.is_recurring)))
        if body.clear_amount_min:        fields.append("amount_min = NULL")
        if body.clear_amount_max:        fields.append("amount_max = NULL")
        if body.clear_clean_name:        fields.append("clean_name = NULL")
        if body.clear_owner:             fields.append("owner_id = NULL")
        if body.clear_account:           fields.append("account_id = NULL")
        if body.clear_account_type:      fields.append("account_type = NULL")
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
            "SELECT category_id, clean_name, is_recurring FROM category_rule WHERE id = ?",
            (rule_id,),
        ).fetchone()
        post_tag_ids = [
            row["tag_id"]
            for row in conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (rule_id,)).fetchall()
        ]
        if post and post["category_id"] is None and not (post["clean_name"] or "").strip() and not post_tag_ids and not post["is_recurring"]:
            raise HTTPException(status_code=400, detail="Rules need at least one action: category, rename, tag, or recurring")
        # Reconcile the rule's recurring series with the post-edit state: create/refresh it when the rule is
        # (now or still) recurring — picking up a cadence change or a matcher edit that shifts membership —
        # and drop it when the flag was turned off. Skipped entirely when the edit never touched recurring
        # and the rule isn't recurring, so ordinary rule edits pay nothing.
        if post and post["is_recurring"]:
            _ensure_recurring_series(conn, rule_id, body.cadence)
        elif body.is_recurring is False:
            _drop_recurring_series_for_rule(conn, rule_id)
        # Opt-in reconcile: re-evaluate the rows the pre-edit rule owned. Rows still matching the edited
        # rule are unchanged; rows the edit dropped from scope clear or fall to another rule. Union with the
        # rows the edited rule now matches so a broadened edit also stamps the newly-covered rows.
        if reconcile:
            affected_ids = set(affected)
            post_rule = conn.execute(
                f"""SELECT id, keyword, match_expr, category_id, amount_min, amount_max, debit_credit, clean_name,
                          owner_id, {rule_scope_account_sql()}, account_type, match_source_text
                   FROM category_rule WHERE id = ?""",
                (rule_id,),
            ).fetchone()
            if post_rule:
                affected_ids.update(_rule_affected_txn_ids(conn, post_rule))
            if affected_ids:
                recategorize_all(conn, txn_ids=list(affected_ids), retain_unmatched=False)
    return {"ok": True, "status": "updated"}


@router.post("/{rule_id}/apply")
def apply_rule(rule_id: str, preserve_manual: bool = False):
    skipped_splits: list = []
    with get_db() as conn:
        affected_ids = _apply_rule_to_existing(
            conn, rule_id, preserve_manual=preserve_manual, skipped_splits=skipped_splits,
        )
    # `transaction_ids` lets an in-place caller reconcile exactly the rows the rule changed (re-fetch them
    # by id and merge them back) instead of re-running its scoped query, which would drop the now-
    # recategorized rows out of the view.
    # `skipped_splits` is how many matches kept their split allocations instead of taking the rule's
    # category — surfaced rather than silent, because an apply that reports "updated 12" while quietly
    # declining 3 rows is telling the user something that is not true.
    return {
        "updated": len(affected_ids),
        "transaction_ids": affected_ids,
        "skipped_splits": len(skipped_splits),
    }


class ApplyToTransactionsBody(BaseModel):
    transaction_ids: list[str] = []


@router.post("/{rule_id}/apply-to-transactions")
def apply_rule_to_transactions(rule_id: str, body: ApplyToTransactionsBody):
    """Apply a rule's outputs (category/rename/tags) to a specific set of transactions — the rows that
    generated an accepted import-rule suggestion — so the user's review edits land on exactly those
    rows. Skips manual rows (deliberate exceptions) and rows the matcher no longer matches."""
    prior_rows: list = []
    skipped_splits: list = []
    with get_db() as conn:
        affected_ids = _apply_rule_to_existing(
            conn, rule_id, preserve_manual=True, txn_ids=body.transaction_ids, capture_prior=prior_rows,
            skipped_splits=skipped_splits,
        )
    # `prior_rows` is the pre-apply categorization snapshot of the changed rows (restore-categorization
    # shape), so an accepted suggestion's Undo can put the rows back before deleting the rule.
    return {
        "updated": len(affected_ids),
        "transaction_ids": affected_ids,
        "prior_rows": prior_rows,
        "skipped_splits": len(skipped_splits),
    }


@router.delete("/{rule_id}")
def delete_rule(rule_id: str, reconcile: bool = False):
    """Move a rule to the trash (soft-delete: recoverable from Settings until purged), so it stops
    categorizing while it can still be restored. `reconcile` (opt-in, default off) additionally
    re-evaluates the transactions this rule categorized: because `recategorize_all` retains a category
    when no rule matches, trashing a rule normally leaves its past categorizations in place. Passing
    `reconcile=true` is the "this rule was wrong — revert its rows" path: the rows it matched are recomputed
    against the remaining rules (falling to another matching rule or to uncategorized). Scoped to this
    rule's rows, so it never touches categorizations left behind by other rules."""
    with get_db() as conn:
        _trash_rule(conn, rule_id, reconcile=reconcile)
    return {"ok": True}


def _trash_rule(conn, rule_id: str, *, reconcile: bool = False) -> None:
    """Soft-delete one rule (shared by the single delete and the bulk cleanup). The row and its rule_tag
    survive for restore; the categorizer/matcher-identity already ignore a `deleted_at` row. A rule-backed
    recurring series is dropped (it has no matcher without its rule) and re-created on restore."""
    affected: list[str] = []
    if reconcile:
        rule = conn.execute(
            f"""SELECT id, keyword, match_expr, category_id, amount_min, amount_max, debit_credit, clean_name,
                      owner_id, {rule_scope_account_sql()}, account_type, match_source_text
               FROM category_rule WHERE id = ? AND deleted_at IS NULL""",
            (rule_id,),
        ).fetchone()
        if rule:
            affected = _rule_affected_txn_ids(conn, rule)
    _drop_recurring_series_for_rule(conn, rule_id)
    conn.execute("UPDATE category_rule SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL", (rule_id,))
    if reconcile and affected:
        recategorize_all(conn, txn_ids=affected, retain_unmatched=False)


_TRASH_DISPLAY_SQL = """
    SELECT cr.id, cr.keyword, cr.match_expr, cr.amount_min, cr.amount_max, cr.debit_credit, cr.clean_name,
           cr.category_id, cr.owner_id, cr.account_id, cr.account_type, cr.match_source_text, cr.is_recurring,
           cr.last_effect_date, cr.is_managed, cr.deleted_at,
           c.name AS category_name, NULL AS category_color, p.name AS parent_name,
           o.name AS owner_name, o.color AS owner_color,
           COALESCE(a.display_name, a.name) AS account_name, COALESCE(ap.mask, a.mask) AS account_mask
    FROM   category_rule cr
    LEFT JOIN category c  ON c.id  = cr.category_id
    LEFT JOIN category p  ON p.id  = c.parent_id
    LEFT JOIN owner    o  ON o.id  = cr.owner_id
    LEFT JOIN account  a  ON a.id  = cr.account_id
    LEFT JOIN account  ap ON ap.id = a.parent_account_id
"""


def _decorate_rule_rows(conn, rows):
    rules = [dict(r) for r in rows]
    tag_map = _load_rule_tag_map(conn, [rule["id"] for rule in rules])
    for rule in rules:
        rule["tags"] = tag_map.get(rule["id"], [])
        rule["tag_ids"] = [tag["id"] for tag in rule["tags"]]
        rule["clauses"] = match_expr_clause_texts(rule.get("match_expr")) or ([rule["keyword"]] if rule["keyword"] else [])
    return rules


@router.get("/trash")
def list_trashed_rules():
    """Trashed (soft-deleted) rules, newest-trashed first — the rules bucket in the app trash."""
    with get_db() as conn:
        rows = conn.execute(_TRASH_DISPLAY_SQL + " WHERE cr.deleted_at IS NOT NULL ORDER BY cr.deleted_at DESC").fetchall()
        return _decorate_rule_rows(conn, rows)


@router.post("/{rule_id}/restore")
def restore_rule(rule_id: str):
    """Restore a trashed rule. Refused if an *active* rule now shares its matcher (restoring would violate
    one-rule-per-matcher); the user resolves that by editing or purging."""
    with get_db() as conn:
        rule = conn.execute(
            """SELECT id, keyword, match_expr, owner_id, account_id, account_type, amount_min, amount_max,
                      debit_credit, match_source_text, is_recurring
               FROM category_rule WHERE id = ? AND deleted_at IS NOT NULL""",
            (rule_id,),
        ).fetchone()
        if not rule:
            raise HTTPException(status_code=404, detail="Trashed rule not found")
        clash = conn.execute(
            """SELECT id FROM category_rule
               WHERE id != ? AND deleted_at IS NULL
                 AND keyword = ? AND match_expr IS ? AND owner_id IS ? AND account_id IS ?
                 AND account_type IS ? AND amount_min IS ? AND amount_max IS ? AND debit_credit IS ?
                 AND match_source_text IS ?""",
            (rule_id, rule["keyword"], rule["match_expr"], rule["owner_id"], rule["account_id"],
             rule["account_type"], rule["amount_min"], rule["amount_max"], rule["debit_credit"], rule["match_source_text"]),
        ).fetchone()
        if clash:
            raise HTTPException(status_code=409, detail="An active rule with the same matcher already exists")
        conn.execute("UPDATE category_rule SET deleted_at = NULL WHERE id = ?", (rule_id,))
        if rule["is_recurring"]:
            # The rule-backed series was dropped on trash; re-create it. The exact cadence isn't preserved
            # across a trash/restore (a minor edge) — it resets to monthly and the user can adjust.
            _ensure_recurring_series(conn, rule_id, "monthly")
    return {"ok": True}


@router.delete("/{rule_id}/purge")
def purge_rule(rule_id: str):
    """Permanently delete a trashed rule (hard delete; rule_tag cascades). Only a trashed rule can be purged."""
    with get_db() as conn:
        row = conn.execute("SELECT id FROM category_rule WHERE id = ? AND deleted_at IS NOT NULL", (rule_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Trashed rule not found")
        _drop_recurring_series_for_rule(conn, rule_id)
        conn.execute("DELETE FROM category_rule WHERE id = ?", (rule_id,))
    return {"ok": True}


@router.post("/trash/purge-all")
def purge_all_trashed_rules():
    """Permanently delete every trashed rule."""
    with get_db() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM category_rule WHERE deleted_at IS NOT NULL").fetchall()]
        for rid in ids:
            _drop_recurring_series_for_rule(conn, rid)
        conn.execute("DELETE FROM category_rule WHERE deleted_at IS NOT NULL")
    return {"purged": len(ids)}


@router.get("/cleanup-candidates")
def cleanup_candidates(before: str = Query(...)):
    """Active, non-managed rules whose newest applied effect is older than `before` (YYYY-MM-DD) — or that
    never applied one — i.e. the stale-rule cleanup set. App-managed (money-movement) and trashed rules are
    excluded. Same row shape as the rules list, oldest/never-used first."""
    with get_db() as conn:
        rows = conn.execute(
            _TRASH_DISPLAY_SQL + """
            WHERE cr.deleted_at IS NULL AND cr.is_managed = 0
              AND (cr.last_effect_date IS NULL OR cr.last_effect_date < ?)
            ORDER BY (cr.last_effect_date IS NULL) DESC, cr.last_effect_date ASC, cr.keyword ASC""",
            (before,),
        ).fetchall()
        rules = _decorate_rule_rows(conn, rows)
    return {"count": len(rules), "rules": rules}


class RuleCleanupBody(BaseModel):
    rule_ids: list[str] = []
    # Default off: cleanup's intent is to remove obsolete rules while *leaving their categorizations alone*.
    # On = also revert each rule's rows (the "these rules were wrong" batch variant).
    reconcile: bool = False


@router.post("/cleanup")
def cleanup_rules(body: RuleCleanupBody):
    """Trash a reviewed set of stale rules at once (soft-delete; recoverable). Managed rules are skipped
    even if an id is passed."""
    trashed = 0
    with get_db() as conn:
        for rid in body.rule_ids:
            row = conn.execute("SELECT is_managed FROM category_rule WHERE id = ? AND deleted_at IS NULL", (rid,)).fetchone()
            if not row or row["is_managed"]:
                continue
            _trash_rule(conn, rid, reconcile=body.reconcile)
            trashed += 1
    return {"trashed": trashed}
