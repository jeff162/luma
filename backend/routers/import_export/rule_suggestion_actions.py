# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Rule-suggestion review actions — one transaction per thing a reviewer does on the Generate Rules review.

Every review action moves three stores together: the rules table (a rule is created, merged into, edited,
or trashed), the transactions a rule claims or a disposition settles, and the review state
(`core.record_rule_suggestion_review`). Each endpoint does all three inside one `get_db()` block, so a
failure part way writes nothing: `get_db()` commits only when its block exits normally, and none of the
rule or transaction cores called here commits on its own. *Expected* outcomes are not failures — a
same-matcher rule that assigns something different leaves that suggestion pending and is named in the
response's `summary`, while the rest of the request still commits.

Every action answers with an `undo` payload (`null` when it changed nothing), which the page holds and
posts back to `/undo` to reverse rules, rows and review state in one transaction. The payload is exact
rather than replayed: the prior review-state entry and status of every suggestion the action touched —
including the covered siblings an accept discarded and the follow-ups it created — the first-captured
categorization of every row it changed, the rules it created (trashed on undo, never deleted, so they stay
recoverable) and the rules it trashed (restored on undo). Like `/transactions/restore-categorization`,
undo trusts the payload it is handed.

The recurring rescan runs after commit, outside the transaction, over every row an action changed —
membership is a cache only a scan rewrites (see `rules._rescan_recurring`).

Scopes work as in the rest of the family (`core._RuleSuggestionReviewScope`): a route names its scope and
hands the opener to the one implementation.
"""

import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ValidationError

from backend.db.database import get_db
from backend.routers.rules import (
    RuleCreate,
    RuleUpdate,
    _apply_rule_to_existing,
    _rescan_recurring,
    _restore_trashed_rule,
    _trash_rule,
    create_rule_core,
    update_rule_core,
)
from backend.routers.transactions import (
    CategorizationSnapshot,
    restore_categorization_rows,
    settle_rejected_suggestion_rows,
)

from .core import (
    RULE_SUGGESTION_REVIEW_STATUSES,
    BatchRuleSuggestionMatchRequest,
    RuleSuggestionReviewUpdate,
    _ReviewScopeOpener,
    _open_batch_review_scope,
    _open_profile_review_scope,
    _open_system_review_scope,
    _rule_suggestion_matching_rows,
    record_rule_suggestion_review,
    summarize_rule_suggestion_review,
)

router = APIRouter()

_ID_CHUNK = 500
_SNAPSHOT_FIELDS = ("id", "category_id", "category_source", "category_overridden")


class RuleSuggestionAcceptItem(BaseModel):
    suggestion_id: str
    source_row_ids: list[str] = []
    merchant_label: Optional[str] = None
    # The rule editor's payload, validated as a `RuleCreate` for a new rule and as a `RuleUpdate` when the
    # suggestion is already accepted into one — so the editor's clear_* flags reach an edit unchanged.
    rule: dict[str, Any]
    apply_to_existing: bool = False
    # On a same-matcher rule that assigns something different, overwrite that rule's category and rename
    # with this suggestion's instead of leaving the suggestion pending.
    replace_existing: bool = False


class RuleSuggestionAcceptRequest(BaseModel):
    items: list[RuleSuggestionAcceptItem]


class RuleSuggestionStatusItem(BaseModel):
    suggestion_id: str
    source_row_ids: list[str] = []
    merchant_label: Optional[str] = None
    target_category_name: Optional[str] = None
    keyword: Optional[str] = None


class RuleSuggestionStatusRequest(BaseModel):
    items: list[RuleSuggestionStatusItem]
    status: str
    # Discarding only: also clear the covered rows' categories to the `cleared` source.
    clear_categories: bool = False


class RuleSuggestionConflictMember(BaseModel):
    suggestion_id: str
    source_row_ids: list[str] = []
    merchant_label: Optional[str] = None
    keyword: str
    target_category_id: Optional[str] = None
    target_category_name: Optional[str] = None
    owner_id: Optional[str] = None
    account_id: Optional[str] = None
    amount_min: Optional[float] = None
    amount_max: Optional[float] = None
    clean_name_suggestion: Optional[str] = None
    tag_ids: list[str] = []
    match_source_text: bool = False


class RuleSuggestionConflictSetRequest(BaseModel):
    members: list[RuleSuggestionConflictMember]
    winner_id: Optional[str] = None


class RuleSuggestionReviewSnapshot(BaseModel):
    entry: Optional[dict[str, Any]] = None
    status: Optional[dict[str, Any]] = None


class RuleSuggestionUndoRequest(BaseModel):
    review: dict[str, RuleSuggestionReviewSnapshot] = {}
    rows: list[CategorizationSnapshot] = []
    trash_rule_ids: list[str] = []
    restore_rule_ids: list[str] = []


def _json_copy(value):
    return json.loads(json.dumps(value))


class _ActionEffects:
    """What one action changed, gathered while its transaction is open, and the undo payload built from it."""

    def __init__(self, review_state: dict):
        self._suggestions_before = _json_copy(review_state.get("suggestions") or {})
        self._statuses_before = _json_copy(review_state.get("statuses") or {})
        self.rows: dict[str, dict] = {}
        self.created_rule_ids: list[str] = []
        self.trashed_rule_ids: list[str] = []
        self.rescan_ids: set[str] = set()
        self.rescan_prior_keys: set = set()

    def capture_rows(self, rows) -> None:
        # A row's first capture is its state before the action; a later one — the full "apply to existing"
        # after the scoped apply — would record a state this action produced.
        for row in rows:
            self.rows.setdefault(str(row["id"]), {field: row.get(field) for field in _SNAPSHOT_FIELDS})

    def undo_payload(self, review_state: dict) -> Optional[dict]:
        suggestions_after = _json_copy(review_state.get("suggestions") or {})
        statuses_after = _json_copy(review_state.get("statuses") or {})
        touched = sorted(
            suggestion_id
            for suggestion_id in {*self._suggestions_before, *suggestions_after, *self._statuses_before, *statuses_after}
            if self._suggestions_before.get(suggestion_id) != suggestions_after.get(suggestion_id)
            or self._statuses_before.get(suggestion_id) != statuses_after.get(suggestion_id)
        )
        if not (touched or self.rows or self.created_rule_ids or self.trashed_rule_ids):
            return None
        return {
            "review": {
                suggestion_id: {
                    "entry": self._suggestions_before.get(suggestion_id),
                    "status": self._statuses_before.get(suggestion_id),
                }
                for suggestion_id in touched
            },
            "rows": list(self.rows.values()),
            "trash_rule_ids": list(self.created_rule_ids),
            "restore_rule_ids": list(self.trashed_rule_ids),
        }


def _run_action(open_scope: _ReviewScopeOpener, perform) -> dict:
    """Open the scope, let `perform(conn, scope, effects)` make every write, then persist the review state and
    answer with its undo payload — all in one transaction, with the recurring rescan after commit."""
    with get_db() as conn:
        scope = open_scope(conn)
        effects = _ActionEffects(scope.review_state)
        extra = perform(conn, scope, effects) or {}
        undo = effects.undo_payload(scope.review_state)
        review_summary = summarize_rule_suggestion_review(scope.review_state)
        scope.save(conn)
    _rescan_recurring(effects.rescan_ids, prior_payee_keys=effects.rescan_prior_keys)
    return {
        "ok": True,
        "undo": undo,
        "review_summary": review_summary,
        "generated_at": scope.review_state.get("generated_at"),
        **extra,
    }


def _chunks(values: list[str]):
    for start in range(0, len(values), _ID_CHUNK):
        yield values[start:start + _ID_CHUNK]


def _unique_ids(values) -> list[str]:
    return list(dict.fromkeys(str(value) for value in (values or []) if str(value or "").strip()))


def _categorization_snapshots(conn, txn_ids) -> list[dict]:
    snapshots = []
    for chunk in _chunks(_unique_ids(txn_ids)):
        snapshots.extend(
            dict(row)
            for row in conn.execute(
                f"SELECT id, category_id, category_source, category_overridden FROM txn "
                f"WHERE id IN ({','.join('?' * len(chunk))})",
                chunk,
            ).fetchall()
        )
    return snapshots


def _latest_txn_date(conn, txn_ids: list[str]) -> Optional[str]:
    latest = None
    for chunk in _chunks(txn_ids):
        value = conn.execute(
            f"SELECT MAX(date) FROM txn WHERE id IN ({','.join('?' * len(chunk))})",
            chunk,
        ).fetchone()[0]
        if value and (latest is None or value > latest):
            latest = value
    return latest


def _category_names(conn, category_ids) -> dict[str, str]:
    names = {}
    for chunk in _chunks(_unique_ids(category_ids)):
        names.update(
            (row["id"], row["name"])
            for row in conn.execute(
                f"SELECT id, name FROM category WHERE id IN ({','.join('?' * len(chunk))})",
                chunk,
            ).fetchall()
        )
    return names


def _category_change_review_action(conn, prior_rows: list[dict], to_category_id: Optional[str], to_fallback_name: Optional[str] = None) -> Optional[dict]:
    """The `review_action` a settled conflict member keeps: how many of its rows moved from which category to
    which, so the settled view can show `Lunch (was Food & Dining)` after the rows themselves have moved."""
    if not prior_rows:
        return None
    to_category_id = to_category_id or None
    names = _category_names(conn, [to_category_id, *(row.get("category_id") for row in prior_rows)])

    def label(category_id, fallback=None):
        if not category_id:
            return fallback or "Uncategorized"
        return names.get(category_id) or fallback or "Unknown category"

    changes: dict[tuple, dict] = {}
    for row in prior_rows:
        from_category_id = row.get("category_id") or None
        change = changes.setdefault((from_category_id, to_category_id), {
            "from_category_id": from_category_id,
            "from_category_name": label(from_category_id),
            "to_category_id": to_category_id,
            "to_category_name": label(to_category_id, to_fallback_name),
            "count": 0,
        })
        change["count"] += 1
    category_changes = [
        change for change in changes.values()
        if str(change["from_category_id"] or "") != str(change["to_category_id"] or "")
    ]
    return {"kind": "category_changes", "category_changes": category_changes} if category_changes else None


def _validated_rule(model, payload: dict):
    try:
        return model.model_validate(payload)
    except ValidationError as err:
        raise HTTPException(status_code=422, detail=f"Invalid rule: {err}") from err


def _entry_fields(conn, rule: RuleCreate) -> dict:
    """The review-entry fields an accepted rule writes back, so the card shows the rule's real scope. A rule
    with no category leaves the entry's category as it was."""
    category_id = rule.category_id or None
    return {
        "keyword": rule.keyword,
        "target_category_id": category_id,
        "target_category_name": _category_names(conn, [category_id]).get(category_id) if category_id else None,
        "owner_id": rule.owner_id or None,
        "account_id": rule.account_id or None,
        "amount_min": rule.amount_min,
        "amount_max": rule.amount_max,
        "clean_name_suggestion": rule.clean_name or None,
        "match_source_text": bool(rule.match_source_text),
    }


def _empty_summary() -> dict:
    return {"created": 0, "merged": 0, "skipped": 0, "replaced": 0, "conflicts": [], "reconciled_rule_ids": []}


def _note_reconciled(summary: dict, rule_id: str) -> None:
    # An existing rule whose categorization changed, so the page can offer to re-categorize what it already matches.
    if rule_id and rule_id not in summary["reconciled_rule_ids"]:
        summary["reconciled_rule_ids"].append(rule_id)


def _note_merge(summary: dict, response: dict) -> None:
    if response.get("relation") == "duplicate":
        summary["skipped"] += 1
    else:
        summary["merged"] += 1
        _note_reconciled(summary, response["id"])


def _settle_rule_conflict(conn, suggestion_id: str, merchant_label: Optional[str], proposed: RuleCreate,
                          response: dict, *, replace_existing: bool, summary: dict) -> Optional[str]:
    """A same-matcher rule already assigns something different. Replacing overwrites that rule's category and
    rename and returns its id; otherwise the conflict is named in the summary and the suggestion stays
    pending (None)."""
    existing_rule_id = response.get("existing_rule_id")
    if not (replace_existing and existing_rule_id):
        summary["conflicts"].append({
            "suggestion_id": suggestion_id,
            "merchant_label": merchant_label or proposed.keyword,
            "keyword": proposed.keyword,
            "proposed_category_id": proposed.category_id or None,
            "proposed_clean_name": proposed.clean_name or None,
            "existing_rule_id": existing_rule_id,
            "existing_category_id": response.get("existing_category_id"),
            "existing_clean_name": response.get("existing_clean_name"),
        })
        return None
    updated, _, _ = update_rule_core(
        conn,
        existing_rule_id,
        RuleUpdate(category_id=proposed.category_id or None, clean_name=proposed.clean_name or None),
        on_existing="merge",
    )
    if updated.get("status") == "conflict":
        raise HTTPException(
            status_code=409,
            detail=f"Another rule also matches “{proposed.keyword}” with a different category. Resolve it from the Rules page first.",
        )
    rule_id = updated.get("id") or existing_rule_id
    summary["replaced"] += 1
    _note_reconciled(summary, rule_id)
    return rule_id


def _claim_rule(conn, suggestion_id: str, merchant_label: Optional[str], proposed: RuleCreate, effects: _ActionEffects,
                *, replace_existing: bool, summary: dict) -> Optional[tuple[str, Optional[str]]]:
    """Create the suggestion's rule, or fold it into the rule that already has its matcher. Returns
    `(rule_id, created_rule_id)` — the second only when this action created the rule, which is the only rule
    returning the suggestion to pending may trash — or None when a conflict leaves the suggestion pending."""
    response = create_rule_core(conn, proposed, on_existing="merge")
    if response["status"] == "created":
        summary["created"] += 1
        effects.created_rule_ids.append(response["id"])
        return response["id"], response["id"]
    if response["status"] == "merged":
        _note_merge(summary, response)
        return response["id"], None
    rule_id = _settle_rule_conflict(
        conn, suggestion_id, merchant_label, proposed, response, replace_existing=replace_existing, summary=summary,
    )
    return (rule_id, None) if rule_id else None


def _apply_rule(conn, effects: _ActionEffects, rule_id: str, *, preserve_manual: bool, txn_ids: Optional[list[str]] = None) -> tuple[list[str], list[dict]]:
    prior_rows: list[dict] = []
    affected = _apply_rule_to_existing(
        conn, rule_id, preserve_manual=preserve_manual, txn_ids=txn_ids,
        capture_prior=prior_rows, capture_prior_keys=effects.rescan_prior_keys,
    )
    effects.capture_rows(prior_rows)
    effects.rescan_ids.update(affected)
    return affected, prior_rows


def _restore_rows(conn, effects: _ActionEffects, rows: list[dict]) -> None:
    effects.capture_rows(_categorization_snapshots(conn, [row.get("id") for row in rows]))
    effects.rescan_ids.update(restore_categorization_rows(conn, rows))


def _accept_pending(conn, scope, effects: _ActionEffects, item: RuleSuggestionAcceptItem, summary: dict) -> None:
    """Accept: the rule's outputs land on exactly the suggestion's own rows (preserve-manual, so a manual
    exception is spared and rows other suggestions own are not in the set), and "apply to existing" then
    reaches every match."""
    proposed = _validated_rule(RuleCreate, item.rule)
    claimed = _claim_rule(
        conn, item.suggestion_id, item.merchant_label, proposed, effects,
        replace_existing=item.replace_existing, summary=summary,
    )
    if not claimed:
        return
    rule_id, created_rule_id = claimed
    _, prior_rows = _apply_rule(conn, effects, rule_id, preserve_manual=True, txn_ids=_unique_ids(item.source_row_ids))
    record_rule_suggestion_review(conn, scope, RuleSuggestionReviewUpdate(
        suggestion_id=item.suggestion_id,
        status="accepted",
        rule_id=rule_id,
        created_rule_id=created_rule_id,
        accepted_prior_rows=prior_rows,
        merchant_label=item.merchant_label,
        **_entry_fields(conn, proposed),
    ))
    if item.apply_to_existing:
        _apply_rule(conn, effects, rule_id, preserve_manual=False)


def _save_accepted(conn, scope, effects: _ActionEffects, item: RuleSuggestionAcceptItem, stored: dict, summary: dict) -> None:
    """Edit an accepted suggestion: update its rule in place, then redraw the accepted partition — rows the
    edited matcher now reaches join it, and rows that no longer match get their pre-accept categorization back
    so they regenerate as pending instead of staying stranded under the rule."""
    proposed = _validated_rule(RuleCreate, item.rule)
    rule_id = stored.get("rule_id")
    created_rule_id = stored.get("created_rule_id")
    stored_prior_rows = list(stored.get("accepted_prior_rows") or [])
    if rule_id:
        response, _, _ = update_rule_core(conn, rule_id, _validated_rule(RuleUpdate, item.rule), on_existing="merge")
        if response["status"] == "merged":
            _note_merge(summary, response)
            rule_id, created_rule_id = response["id"], None
        elif response["status"] != "updated":
            rule_id = _settle_rule_conflict(
                conn, item.suggestion_id, item.merchant_label, proposed, response,
                replace_existing=item.replace_existing, summary=summary,
            )
            if not rule_id:
                return
            created_rule_id = None
    else:
        claimed = _claim_rule(
            conn, item.suggestion_id, item.merchant_label, proposed, effects,
            replace_existing=item.replace_existing, summary=summary,
        )
        if not claimed:
            return
        rule_id, created_rule_id = claimed

    previous_ids = _unique_ids(item.source_row_ids)
    matching_ids = [row["id"] for row in _rule_suggestion_matching_rows(conn, scope, BatchRuleSuggestionMatchRequest(
        keyword=proposed.keyword,
        owner_id=proposed.owner_id or None,
        account_id=proposed.account_id or None,
        amount_min=proposed.amount_min,
        amount_max=proposed.amount_max,
        match_source_text=bool(proposed.match_source_text),
    ))]
    candidate_ids = _unique_ids([*previous_ids, *matching_ids])
    update = {
        "suggestion_id": item.suggestion_id,
        "status": "accepted",
        "rule_id": rule_id,
        "created_rule_id": created_rule_id,
        "merchant_label": item.merchant_label,
        **_entry_fields(conn, proposed),
    }
    if not candidate_ids:
        record_rule_suggestion_review(conn, scope, RuleSuggestionReviewUpdate(**update, accepted_prior_rows=stored_prior_rows))
        return

    affected, prior_rows = _apply_rule(conn, effects, rule_id, preserve_manual=True, txn_ids=candidate_ids)
    accepted_ids = _unique_ids(affected)
    accepted_id_set = set(accepted_ids)
    released_id_set = {row_id for row_id in previous_ids if row_id not in accepted_id_set}
    released_prior_rows = [row for row in stored_prior_rows if str(row.get("id")) in released_id_set]
    if released_prior_rows:
        _restore_rows(conn, effects, released_prior_rows)
    # A row's stored pre-accept snapshot outranks this apply's, which may only record the rule's own earlier state.
    accepted_prior_rows = {
        str(row["id"]): row
        for row in [*prior_rows, *stored_prior_rows]
        if str(row.get("id")) in accepted_id_set
    }
    record_rule_suggestion_review(conn, scope, RuleSuggestionReviewUpdate(
        **update,
        accepted_prior_rows=list(accepted_prior_rows.values()),
        source_row_ids=accepted_ids,
        txn_count=len(accepted_ids),
        latest_txn_date=_latest_txn_date(conn, accepted_ids),
    ))


def _accept_rule_suggestions(open_scope: _ReviewScopeOpener, body: RuleSuggestionAcceptRequest) -> dict:
    summary = _empty_summary()

    def perform(conn, scope, effects):
        for item in body.items:
            stored = (scope.review_state.get("statuses") or {}).get(item.suggestion_id) or {}
            if stored.get("status") == "accepted":
                _save_accepted(conn, scope, effects, item, stored, summary)
            else:
                _accept_pending(conn, scope, effects, item, summary)
        return {"summary": summary}

    return _run_action(open_scope, perform)


def _set_rule_suggestion_status(open_scope: _ReviewScopeOpener, body: RuleSuggestionStatusRequest) -> dict:
    status = (body.status or "").strip().lower()
    if status not in ({"pending"} | RULE_SUGGESTION_REVIEW_STATUSES):
        raise HTTPException(status_code=400, detail="Invalid review status")
    if body.clear_categories and status != "discarded":
        raise HTTPException(status_code=400, detail="clear_categories is only valid when discarding")

    def perform(conn, scope, effects):
        statuses = scope.review_state.get("statuses") or {}
        for item in body.items:
            stored = statuses.get(item.suggestion_id) or {}
            if status == "pending" and stored.get("status") == "accepted":
                # Returning an accepted suggestion puts its rows back and trashes the rule only if this review
                # created it — a pre-existing rule it merged into is not the review's to remove.
                if stored.get("accepted_prior_rows"):
                    _restore_rows(conn, effects, list(stored["accepted_prior_rows"]))
                created_rule_id = stored.get("created_rule_id")
                if created_rule_id and conn.execute(
                    "SELECT 1 FROM category_rule WHERE id = ? AND deleted_at IS NULL", (created_rule_id,),
                ).fetchone():
                    _trash_rule(conn, created_rule_id)
                    effects.trashed_rule_ids.append(created_rule_id)
            if body.clear_categories and item.source_row_ids:
                prior_rows = settle_rejected_suggestion_rows(conn, _unique_ids(item.source_row_ids), "clear")
                effects.capture_rows(prior_rows)
                effects.rescan_ids.update(row["id"] for row in prior_rows)
            record_rule_suggestion_review(conn, scope, RuleSuggestionReviewUpdate(
                suggestion_id=item.suggestion_id,
                status=status,
                merchant_label=item.merchant_label,
                target_category_name=item.target_category_name,
                keyword=item.keyword,
            ))

    return _run_action(open_scope, perform)


def _resolve_rule_suggestion_conflict_set(open_scope: _ReviewScopeOpener, body: RuleSuggestionConflictSetRequest) -> dict:
    """Resolve a conflict set as one action, driven by each member's target category. With a winner, its
    target becomes the rule; each other member whose target is the winner's category joins the rule's rows,
    one re-pointed elsewhere becomes a manual exception there, one left at its imported category stays
    `import`, and an emptied target clears. With no winner every member settles to its target."""
    members = body.members
    winner = next((member for member in members if member.suggestion_id == body.winner_id), None)
    if body.winner_id and not winner:
        raise HTTPException(status_code=400, detail="The winner is not a member of this conflict set")
    summary = _empty_summary()

    def perform(conn, scope, effects):
        rule_id = created_rule_id = None
        if winner:
            proposed = RuleCreate(
                keyword=winner.keyword,
                category_id=winner.target_category_id,
                amount_min=winner.amount_min,
                amount_max=winner.amount_max,
                clean_name=winner.clean_name_suggestion or None,
                owner_id=winner.owner_id or None,
                account_id=winner.account_id or None,
                tag_ids=winner.tag_ids,
                match_source_text=winner.match_source_text,
            )
            claimed = _claim_rule(
                conn, winner.suggestion_id, winner.merchant_label, proposed, effects,
                replace_existing=False, summary=summary,
            )
            if not claimed:
                return {"summary": summary}
            rule_id, created_rule_id = claimed

        others = [member for member in members if member is not winner]
        review_actions: dict[str, dict] = {}
        rule_row_ids = list(winner.source_row_ids) if winner else []
        for member in others:
            target_id = member.target_category_id or None
            if winner and str(target_id or "") == str(winner.target_category_id or ""):
                rule_row_ids.extend(member.source_row_ids)
                continue
            if not member.source_row_ids:
                continue
            prior_rows = settle_rejected_suggestion_rows(
                conn, _unique_ids(member.source_row_ids), "keep" if target_id else "clear", target_id,
            )
            effects.capture_rows(prior_rows)
            effects.rescan_ids.update(row["id"] for row in prior_rows)
            review_action = _category_change_review_action(conn, prior_rows, target_id)
            if review_action:
                review_actions[member.suggestion_id] = review_action

        winner_prior_rows: list[dict] = []
        if rule_id and rule_row_ids:
            _, winner_prior_rows = _apply_rule(conn, effects, rule_id, preserve_manual=True, txn_ids=_unique_ids(rule_row_ids))
            for member in members:
                member_row_ids = set(member.source_row_ids)
                review_action = _category_change_review_action(
                    conn,
                    [row for row in winner_prior_rows if str(row["id"]) in member_row_ids],
                    winner.target_category_id,
                    winner.target_category_name,
                )
                if review_action:
                    review_actions[member.suggestion_id] = review_action

        if winner:
            record_rule_suggestion_review(conn, scope, RuleSuggestionReviewUpdate(
                suggestion_id=winner.suggestion_id,
                status="accepted",
                rule_id=rule_id,
                created_rule_id=created_rule_id,
                accepted_prior_rows=winner_prior_rows,
                merchant_label=winner.merchant_label,
                target_category_name=winner.target_category_name,
                target_category_id=winner.target_category_id,
                keyword=winner.keyword,
                owner_id=winner.owner_id or None,
                account_id=winner.account_id or None,
                amount_min=winner.amount_min,
                amount_max=winner.amount_max,
                clean_name_suggestion=winner.clean_name_suggestion or None,
                match_source_text=winner.match_source_text,
                review_action=review_actions.get(winner.suggestion_id),
            ))
        for member in others:
            record_rule_suggestion_review(conn, scope, RuleSuggestionReviewUpdate(
                suggestion_id=member.suggestion_id,
                status="discarded",
                merchant_label=member.merchant_label,
                target_category_name=member.target_category_name,
                target_category_id=member.target_category_id,
                keyword=member.keyword,
                review_action=review_actions.get(member.suggestion_id),
            ))
        return {"summary": summary}

    return _run_action(open_scope, perform)


def _undo_rule_suggestion_action(open_scope: _ReviewScopeOpener, body: RuleSuggestionUndoRequest) -> dict:
    with get_db() as conn:
        scope = open_scope(conn)
        for rule_id in body.trash_rule_ids:
            _trash_rule(conn, rule_id)
        for rule_id in body.restore_rule_ids:
            if conn.execute(
                "SELECT 1 FROM category_rule WHERE id = ? AND deleted_at IS NOT NULL", (rule_id,),
            ).fetchone():
                _restore_trashed_rule(conn, rule_id)
        restored_ids = restore_categorization_rows(conn, [row.model_dump() for row in body.rows])
        review_state = scope.review_state
        for suggestion_id, snapshot in body.review.items():
            for key, value in (("suggestions", snapshot.entry), ("statuses", snapshot.status)):
                if value is None:
                    review_state[key].pop(suggestion_id, None)
                else:
                    review_state[key][suggestion_id] = value
        review_summary = summarize_rule_suggestion_review(review_state)
        scope.save(conn)
    _rescan_recurring(restored_ids)
    return {"ok": True, "review_summary": review_summary, "generated_at": review_state.get("generated_at")}


@router.post("/batches/{batch_id}/rule-suggestions/accept")
def accept_batch_rule_suggestions(batch_id: str, body: RuleSuggestionAcceptRequest):
    return _accept_rule_suggestions(lambda conn: _open_batch_review_scope(conn, batch_id), body)


@router.post("/batches/{batch_id}/rule-suggestions/status")
def set_batch_rule_suggestion_status(batch_id: str, body: RuleSuggestionStatusRequest):
    return _set_rule_suggestion_status(lambda conn: _open_batch_review_scope(conn, batch_id), body)


@router.post("/batches/{batch_id}/rule-suggestions/resolve-conflict-set")
def resolve_batch_rule_suggestion_conflict_set(batch_id: str, body: RuleSuggestionConflictSetRequest):
    return _resolve_rule_suggestion_conflict_set(lambda conn: _open_batch_review_scope(conn, batch_id), body)


@router.post("/batches/{batch_id}/rule-suggestions/undo")
def undo_batch_rule_suggestion_action(batch_id: str, body: RuleSuggestionUndoRequest):
    return _undo_rule_suggestion_action(lambda conn: _open_batch_review_scope(conn, batch_id), body)


@router.post("/profiles/{profile_id}/rule-suggestions/accept")
def accept_profile_rule_suggestions(profile_id: str, body: RuleSuggestionAcceptRequest):
    return _accept_rule_suggestions(lambda conn: _open_profile_review_scope(conn, profile_id), body)


@router.post("/profiles/{profile_id}/rule-suggestions/status")
def set_profile_rule_suggestion_status(profile_id: str, body: RuleSuggestionStatusRequest):
    return _set_rule_suggestion_status(lambda conn: _open_profile_review_scope(conn, profile_id), body)


@router.post("/profiles/{profile_id}/rule-suggestions/resolve-conflict-set")
def resolve_profile_rule_suggestion_conflict_set(profile_id: str, body: RuleSuggestionConflictSetRequest):
    return _resolve_rule_suggestion_conflict_set(lambda conn: _open_profile_review_scope(conn, profile_id), body)


@router.post("/profiles/{profile_id}/rule-suggestions/undo")
def undo_profile_rule_suggestion_action(profile_id: str, body: RuleSuggestionUndoRequest):
    return _undo_rule_suggestion_action(lambda conn: _open_profile_review_scope(conn, profile_id), body)


@router.post("/rule-suggestions/accept")
def accept_system_rule_suggestions(body: RuleSuggestionAcceptRequest):
    return _accept_rule_suggestions(_open_system_review_scope, body)


@router.post("/rule-suggestions/status")
def set_system_rule_suggestion_status(body: RuleSuggestionStatusRequest):
    return _set_rule_suggestion_status(_open_system_review_scope, body)


@router.post("/rule-suggestions/resolve-conflict-set")
def resolve_system_rule_suggestion_conflict_set(body: RuleSuggestionConflictSetRequest):
    return _resolve_rule_suggestion_conflict_set(_open_system_review_scope, body)


@router.post("/rule-suggestions/undo")
def undo_system_rule_suggestion_action(body: RuleSuggestionUndoRequest):
    return _undo_rule_suggestion_action(_open_system_review_scope, body)
