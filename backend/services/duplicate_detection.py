# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Duplicate detection for transactions — hard-reject (blocked at import) and soft-flag
(imported with a suspect pointer for user review).

The rules sort into confidence tiers, but among the HARD-REJECT rules the chain is evaluated
coverage-first, then exact-hash — deliberately NOT in confidence order. That ordering changes only
the *label*, never the verdict: a row can both fall in an already-imported date range and exactly
match an existing row, and both outcomes are hard-rejects, so which rule "wins" just decides the
reason shown in the duplicate report. Coverage is the more useful reason — a re-imported range is one
uniform story, whereas which individual rows happen to be exact content-hash matches is an incidental
artifact of whether two sources formatted the merchant string identically, and singling those out as
"exact match" splits a homogeneous re-import into a confusing "why are these special?" subset. Exact-
hash still hard-rejects on its own for any row OUTSIDE a covered range, so it catches exactly what it
did before; it just no longer claims the label when coverage already explains the row.

Hard-reject rules (blocked at import; the row never enters the ledger, and the rejection is recorded
in `import_batch_duplicate` so it can resurface if the rejecting batch is later undone), in evaluation
order:

  1-2. Coverage window — same-source (same csv_value, unconditional within the window), then in-scope
       (same linked group, different csv_value). The in-scope rule fires only when the receiving
       account already had prior history in the matching scope, or the import explicitly declared it
       an alias; a brand-new sibling that only inherits its linked-group's coverage doesn't satisfy
       the precondition and falls through.
  3-4. Exact content-hash match — same account, then same linked group. Unconditional (no prior-
       history precondition): same date+amount+payee is the same transaction regardless of which
       account it lands on. Reached only for rows not already inside a covered range.
  5.   Terminal-day reconciliation, then
  6.   a fuzzy-text fallback (medium confidence).

Soft-flag (imported with a suspect pointer for review): the cross-account match by (date, amount,
normalized payee) comes from the post-batch sweep (`mark_import_suspects`), not the ladder above; the
user resolves it with Keep (assert the two accounts are distinct) or Reject (confirm a duplicate).

Check-number discriminator (`are_distinct_checks`): two genuinely different checks can share
date+amount+description (often just "Check"), so they collide on the content hash AND on the
terminal-day rule's amount fallback. Wherever a match is keyed on the hash/amount — the exact-hash
rules and the terminal-day matcher — a match between rows carrying explicit, *different* check
numbers (folded into the merchant as "Check #<n>" at import) is discarded as a false positive, so
the row falls through to the lower-confidence rules (review) instead of being silently rejected. It
is conservative — the number must be present on both sides — so rows predating check capture dedupe
unchanged, and it only runs once a rule has already found a candidate (no cost on the common path).

Triggers:
  * Import-time per row (`evaluate_duplicate` via `DedupeContext`) — assigns hard-reject /
    soft-flag / passthrough verdicts as each row is inserted.
  * Post-batch sweep (`mark_import_suspects`) — runs against the just-inserted batch for the
    cross-account soft-flag case. Skips pairs the user has previously declared distinct via
    `account_pair_distinct`; that table is what keeps the report non-noisy after the user has
    reviewed each pair once.
  * Account merge AND import-into-an-already-merged-group (`promote_in_group_suspects_to_confirmed`)
    — when two accounts merge into one linked group, OR a batch imports rows whose just-flagged
    cross-account match lands on an account already merged with the receiving account, any such
    soft-flag between same-effective-root accounts gets promoted to
    `rejection_reason='duplicate_confirmed'` (tagged `dedupe_resolved_by='auto_merge'`). The
    import-finalize call (right after `mark_import_suspects`) is what makes import order-independent
    with merge order. Also
    performs a same-batch transitivity clear: a sibling row in the same CSV as a promoted row
    whose own suspect points at the *same canonical row* has its suspect flag cleared, because
    same-CSV-different-account asserts distinct, and the merge identifies the promoted row with
    that canonical (a sibling pointing at a *different* row in the merged group stays flagged).
  * Account detach (`restore_auto_merged_after_detach`) — reverses auto_merge promotions whose
    account pair straddles the detach boundary (one endpoint on the detaching account, the other
    in the remaining group), in either orientation: the trashed suspect row may sit on the
    detaching account OR on the account that stays (when the imported file holding the suspect was
    on the staying account and the row it duplicated was on the detaching account). Rows the user
    explicitly Rejected (dedupe_resolved_by='user') are left alone.

The cross-account soft-flag SQL joins on `(date, ROUND(amount, 2), normalized payee)`, indexed
via `idx_txn_date_amount`, so cost stays proportional to candidate pairs rather than N*N.

The user-asserted "these two accounts are distinct" model (see `account_pair_distinct` table
and `resolve_suspect(action='keep')`) replaced an older proxy that fired only when the
receiving account was brand new to the database. The new model keeps detection running for
every cross-batch pair forever, with the per-pair table acting as the user's accumulated
filter of "I've already decided these are different accounts."
"""

import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable, Optional


_CHECK_NUMBER_RE = re.compile(r"#(\d+)")


def explicit_check_number(merchant_name: Optional[str]) -> Optional[str]:
    """The check number folded into a merchant like 'Check #1042' at import time, or None."""
    if not merchant_name:
        return None
    match = _CHECK_NUMBER_RE.search(str(merchant_name))
    return match.group(1) if match else None


def are_distinct_checks(merchant_a: Optional[str], merchant_b: Optional[str]) -> bool:
    """True only when both names carry an explicit, DIFFERENT check number.

    Two genuinely different checks can share date+amount+description (often just "Check"), so a
    content-hash match — or a terminal-day amount match — between them is a false positive. This is
    the discriminator that rescues that case. Deliberately conservative: a number must be present on
    BOTH sides, so absence never implies "different" and rows predating check-number capture keep
    deduping exactly as before. Cheap, and only consulted once a rule has already found a match.
    """
    left = explicit_check_number(merchant_a)
    right = explicit_check_number(merchant_b)
    return bool(left and right and left != right)


# The same normalized-payee expression is used on both sides of the join. The COALESCE chain
# matches the convention used elsewhere in the app for "what label do we show for this txn."
NORMALIZED_PAYEE_SQL = (
    "LOWER(TRIM(COALESCE(NULLIF({alias}.display_name, ''), "
    "NULLIF({alias}.merchant_name, ''), NULLIF({alias}.raw_name, ''), '')))"
)


def _placeholders(values) -> str:
    return ",".join("?" * len(values))


# ---------------------------------------------------------------------------
# Import-time per-row evaluator
# ---------------------------------------------------------------------------


@dataclass
class DedupeContext:
    """Precomputed lookups for a single import pass. Built once via `build_dedupe_context` so
    the per-row evaluator is just dict lookups."""

    existing_hashes_by_account: dict = field(default_factory=dict)
    existing_hashes_by_effective_account: dict = field(default_factory=dict)
    existing_rows_by_account_amount: dict = field(default_factory=dict)
    existing_rows_by_effective_account_amount: dict = field(default_factory=dict)
    import_coverage_by_csv_value: dict = field(default_factory=dict)
    import_coverage_by_scope_id: dict = field(default_factory=dict)
    terminal_day_candidates_by_csv_day: dict = field(default_factory=dict)
    terminal_day_candidates_by_scope_day: dict = field(default_factory=dict)
    accounts_with_prior_history: set = field(default_factory=set)
    explicit_alias_csv_values: set = field(default_factory=set)
    account_duplicate_compare_targets: dict = field(default_factory=dict)
    coverage_strategy_enabled: bool = True
    text_strategy_enabled: bool = True
    # Helpers live in the import-flow module today; importing them here would create a circular
    # dependency, so the caller passes them in. Moving the helpers into this module is a planned
    # follow-up cleanup; once that lands these fields drop out of the context.
    helpers: dict = field(default_factory=dict)


@dataclass
class DedupeVerdict:
    """Result of evaluating a single row. Exactly one of `hard_reject` / `soft_flag` / `passthrough`
    is true. When `hard_reject`, `matched` and `reason` describe why; the caller writes the row to
    `import_batch_duplicate` and skips insert. When `soft_flag`, `suspect_of` carries the existing
    row id and `reason_key` carries a stable code (e.g. `'import_new_account'`); the caller inserts
    the row with `suspect_duplicate_of` set. When `passthrough`, the row is inserted normally.

    `terminal_day_reconciled` is exposed separately because the text-strategy rule needs to know
    whether the terminal-day branch already considered the row, even when no terminal-day match
    was produced — preserves the existing precedence semantics.
    """

    hard_reject: bool = False
    soft_flag: bool = False
    passthrough: bool = True
    matched: Optional[dict] = None
    reason: str = ""
    suspect_of: Optional[str] = None
    reason_key: str = ""
    terminal_day_reconciled: bool = False


def _adjacent_date_offsets(parsed_date: str) -> list[tuple[str, int]]:
    """(date_string, day_offset) pairs for a ±1-day candidate-display window. Exact date first so it
    ranks ahead of the near-date fallbacks; falls back to just the exact date if it can't be parsed.
    Two sources for the same transaction routinely disagree on the posting day by one (timezone /
    settlement), which otherwise leaves a covered row with 'no specific match'."""
    try:
        d = datetime.strptime(parsed_date, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return [(parsed_date, 0)]
    return [
        (parsed_date, 0),
        ((d - timedelta(days=1)).isoformat(), -1),
        ((d + timedelta(days=1)).isoformat(), 1),
    ]


def _far_date_offsets(parsed_date: str) -> list[tuple[str, int]]:
    """±2-day candidate offsets, used ONLY as a fallback when the exact/±1 lookup finds nothing.
    A foreign transaction posts on its local calendar day (a day ahead of US), so the usual
    pending/posted ±1 disagreement becomes ±2 — e.g. a Sydney charge dated the 9th by one source
    and the 11th by the other. These are display-only candidates (they cannot change the already-
    made reject verdict) and are tagged with `day_offset` ±2 so the report can label them as a
    timezone-shifted match rather than 'no specific match'."""
    try:
        d = datetime.strptime(parsed_date, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return []
    return [
        ((d - timedelta(days=2)).isoformat(), -2),
        ((d + timedelta(days=2)).isoformat(), 2),
    ]


def _candidate_summary_rows_for_coverage(context: "DedupeContext", receiving_account_id: str,
                                          parsed_date: str, amount: float,
                                          duplicate_amount_key, include_scope: bool) -> list[dict]:
    """For a coverage-window hit, look up actual same-account candidate rows by (date, amount).
    Returns a list of compact dicts the unified report renders directly. Empty list means
    'covered date but no specific match' — the report flags those for manual review.

    This is display-only: the coverage rule has already returned its hard-reject verdict, so widening
    the lookup to the day before/after (same amount) cannot change a decision — it only lets the
    report point at the specific prior transaction when the two sources disagree on the posting day by
    one. Near-date hits carry a `day_offset` so the UI can label them. Exact-date matches still rank
    first. When exact/±1 finds nothing we widen once more to ±2 (still display-only) to catch a
    timezone-shifted foreign twin; those candidates are tagged `day_offset` ±2. Only when even ±2
    finds nothing does the row stay 'no specific match' for manual review.

    The lookup re-uses the per-account amount index that text-strategy already populates, so the
    cost is dict lookups, not extra queries. For in-scope coverage we also fold in candidates from
    sibling accounts in the linked group, since the rule's premise is that the prior import covered
    the whole effective-account scope.
    """
    seen_ids: set[str] = set()
    out: list[dict] = []

    def _append(candidate: dict, day_offset: int) -> None:
        cid = candidate.get("id")
        if not cid or cid in seen_ids:
            return
        seen_ids.add(cid)
        row = {
            "id":            cid,
            "date":          candidate.get("date"),
            "merchant_name": candidate.get("merchant_name"),
            "amount":        candidate.get("amount"),
            "account_id":    candidate.get("account_id"),
            "import_batch_id": candidate.get("import_batch_id"),
        }
        if day_offset:
            row["day_offset"] = day_offset  # candidate's date is this many days off the incoming row's
        if candidate.get("cross_account"):
            # A transfer twin on the funding account — carry the marker + account label so the report
            # can label it 'possible transfer match on <account>' rather than a same-account match.
            row["cross_account"] = True
            row["account_name"] = candidate.get("account_name")
        out.append(row)

    def _probe(offsets) -> None:
        for day, day_offset in offsets:
            key = duplicate_amount_key(day, amount)
            for candidate in context.existing_rows_by_account_amount.get(receiving_account_id, {}).get(key, []):
                _append(candidate, day_offset)
            if include_scope:
                # Linked-group rows too. We don't have compare_target_id at this point in the
                # signature, so we iterate the whole effective-account map looking up by amount-key
                # — cheap because the second-level dict is keyed by amount-key.
                for scope_map in context.existing_rows_by_effective_account_amount.values():
                    for candidate in scope_map.get(key, []):
                        _append(candidate, day_offset)

    _probe(_adjacent_date_offsets(parsed_date))
    # Only reach to ±2 when exact/±1 produced nothing, so a real exact/±1 match is never diluted
    # by a coincidental ±2 neighbor — the ±2 band is purely the timezone-shift fallback.
    if not out:
        _probe(_far_date_offsets(parsed_date))
    # Still nothing on this account or its linked group? A wallet funding/deposit leg's twin lives on
    # the *funding* account — cross-account, opposite-signed, so invisible above. Surface it (tagged
    # `cross_account`) as a reviewable 'possible transfer match' instead of a bare 'no specific match'.
    if not out:
        find_transfer = context.helpers.get("find_cross_account_transfer")
        if find_transfer:
            for candidate in find_transfer(receiving_account_id, parsed_date, amount):
                _append(candidate, 0)
    return out


def _coverage_matched(cov: dict, candidates: list[dict]) -> dict:
    """Build the verdict's `matched` dict for a coverage-window hit. We deliberately do NOT echo
    the incoming amount as a synthetic 'matched amount' (it implies a specific match we didn't
    make). Instead we describe the coverage and attach any actual candidates the lookup found.

    Shape:
      - covered: { start_date, end_date, source_batch_id }   (always present)
      - candidates: list of compact candidate dicts          (may be empty → no specific match)
      - candidate_count: len(candidates)                     (UI shortcut)
    """
    return {
        "covered": {
            "start_date": cov.get("start_date"),
            "end_date":   cov.get("end_date"),
            "source_batch_id": cov.get("batch_id"),
            "source_csv_value": cov.get("csv_value"),
        },
        "candidates":      candidates,
        "candidate_count": len(candidates),
    }


def _coverage_reject_verdict(context: "DedupeContext", cov: dict, receiving_account_id: str,
                             parsed_date: str, amount: float, duplicate_amount_key, include_scope: bool,
                             incoming_merchant, reason: str):
    """The verdict for a coverage-window hit: a hard-reject, carrying any same-account/transfer candidates
    for the report. One exception keeps real spending from being silently dropped: a **named** row (a real
    payment, not a nameless money-movement leg) with no such candidate is only treated as a duplicate when
    a corroborating charge actually exists elsewhere in the ledger (a ``PAYPAL <merchant>`` card charge,
    matched by merchant + amount). When none does, the payment is genuinely new — the covering import
    never saw it (it was funded from the wallet balance, so it never hit a card/bank) — and this returns
    ``None`` so the row falls through to import instead of being buried as 'covered, no specific match'.
    Nameless money-movement rows keep their existing coverage rejection unchanged."""
    candidates = _candidate_summary_rows_for_coverage(
        context, receiving_account_id, parsed_date, amount, duplicate_amount_key, include_scope,
    )
    find_payment = context.helpers.get("find_payment_match")
    if not candidates and incoming_merchant and find_payment is not None:
        payment_match = find_payment(receiving_account_id, parsed_date, amount, incoming_merchant)
        if payment_match is None:
            return None  # genuinely-new named payment → let it import
        candidates = [payment_match]
    return DedupeVerdict(
        hard_reject=True, passthrough=False,
        matched=_coverage_matched(cov, candidates), reason=reason,
    )


def evaluate_duplicate(
    *,
    context: DedupeContext,
    receiving_account_id: str,
    csv_value: str,
    content_hash: str,
    parsed_date: str,
    amount: float,
    scope_id: Optional[str],
    txn_payload: dict,
) -> DedupeVerdict:
    """Run the dedupe rule chain for a single incoming row. See module docstring for the rule
    ladder. The caller builds `context` once per import via `build_dedupe_context` (or constructs
    one directly for tests). `scope_id` is the receiving account's effective-account/linked-group
    scope id, used by the in-scope rules.
    """
    h = context.helpers
    date_in_window = h["date_in_window"]
    candidate_summary = h["candidate_summary"]
    match_terminal = h["match_terminal"]
    duplicate_amount_key = h["duplicate_amount_key"]
    find_textual = h["find_textual"]

    incoming_merchant = txn_payload.get("merchant_name")

    # Coverage rules run before the exact-hash rules below. When a row both falls in an already-
    # imported date range AND exactly matches an existing row, both verdicts are hard-rejects — the
    # order only decides which reason the duplicate report shows, and coverage is the more useful
    # label (see module docstring: a re-imported range is one uniform story; which rows happen to be
    # exact content-hash matches is an incidental artifact of merchant-string formatting). Exact-hash
    # still hard-rejects rows OUTSIDE any covered range, so nothing it caught before stops being
    # caught — it just no longer wins the label when coverage already explains the row.

    # Rule 1: coverage window from a prior import of the same source (csv_value). When the rule
    # fires we ALSO look for actual candidate rows by (receiving_account, date, amount) so the
    # report can show what we think the row matched (or flag "no specific match" if nothing
    # plausible exists). The lookup is free — we already index existing rows by amount-key.
    if context.coverage_strategy_enabled:
        cov = next(
            (entry for entry in context.import_coverage_by_csv_value.get(csv_value, [])
             if date_in_window(parsed_date, entry.get("start_date"), entry.get("end_date"))),
            None,
        )
        if cov:
            verdict = _coverage_reject_verdict(
                context, cov, receiving_account_id, parsed_date, amount, duplicate_amount_key,
                include_scope=False, incoming_merchant=incoming_merchant,
                reason="Falls within the fully covered date range from an earlier import for this source account",
            )
            if verdict is not None:
                return verdict

    # Rule 2: in-scope coverage window — same linked group, different csv_value. Precondition: the
    # entry must be for the receiving account itself (or for an account the user explicitly
    # aliased this csv to). A brand-new sibling inheriting only its group's coverage does NOT
    # satisfy the precondition; the row falls through to the soft-flag sweep instead.
    if context.coverage_strategy_enabled:
        eligible_account_ids = {receiving_account_id}
        if csv_value in context.explicit_alias_csv_values:
            alias_target = context.account_duplicate_compare_targets.get(csv_value)
            if alias_target:
                eligible_account_ids.add(alias_target)
        cov = next(
            (entry for entry in context.import_coverage_by_scope_id.get(scope_id or "", [])
             if entry.get("csv_value") != csv_value
             and entry.get("account_id") in eligible_account_ids
             and date_in_window(parsed_date, entry.get("start_date"), entry.get("end_date"))),
            None,
        )
        if cov:
            verdict = _coverage_reject_verdict(
                context, cov, receiving_account_id, parsed_date, amount, duplicate_amount_key,
                include_scope=True, incoming_merchant=incoming_merchant,
                reason="Falls within the fully covered date range from an earlier import in this account scope",
            )
            if verdict is not None:
                return verdict

    # Rule 3: exact content-hash match within the receiving account. Reached only when the row is
    # NOT inside a covered range above. Two different checks can share date+amount+description, so a
    # differing explicit check number means this is NOT the same row — let it fall through to the
    # lower-confidence rules (which route it to review) instead.
    matched = context.existing_hashes_by_account.get(receiving_account_id, {}).get(content_hash)
    if matched and are_distinct_checks(incoming_merchant, matched.get("merchant_name")):
        matched = None
    if matched:
        return DedupeVerdict(hard_reject=True, passthrough=False, matched=matched,
                             reason="Matches an existing transaction")

    # Rule 4: exact content-hash match across the linked-group scope (cross-account).
    compare_target_id = context.account_duplicate_compare_targets.get(csv_value)
    if compare_target_id:
        matched = context.existing_hashes_by_effective_account.get(compare_target_id, {}).get(content_hash)
        if matched and are_distinct_checks(incoming_merchant, matched.get("merchant_name")):
            matched = None
        if matched:
            return DedupeVerdict(hard_reject=True, passthrough=False, matched=matched,
                                 reason="Matches an existing transaction in the linked account group")

    # Rule 5: terminal-day reconciliation. Same-source candidates are always eligible; cross-account
    # candidates only when the receiving account has prior history or is an explicit alias (same
    # precondition as Rule 2 — see module docstring).
    terminal_day_reconciled = False
    if context.coverage_strategy_enabled:
        same_source = context.terminal_day_candidates_by_csv_day.get((csv_value, parsed_date), [])
        receiving_account_is_known = (
            receiving_account_id in context.accounts_with_prior_history
            or csv_value in context.explicit_alias_csv_values
        )
        scope_terminal = (
            context.terminal_day_candidates_by_scope_day.get((scope_id or "", parsed_date), [])
            if receiving_account_is_known else []
        )
        terminal_day_reconciled = bool(same_source) or any(
            c.get("csv_value") != csv_value for c in scope_terminal
        )
        if terminal_day_reconciled:
            matched_term = match_terminal(
                same_source, content_hash=content_hash, amount=amount, incoming_merchant=incoming_merchant,
            )
            if not matched_term:
                matched_term = match_terminal(
                    [c for c in scope_terminal if c.get("csv_value") != csv_value],
                    content_hash=content_hash, amount=amount, incoming_merchant=incoming_merchant,
                )
            if matched_term:
                return DedupeVerdict(
                    hard_reject=True, passthrough=False,
                    matched=candidate_summary(matched_term),
                    reason=(
                        "Matches a remaining transaction from the terminal covered day in an earlier import"
                        + (" for this source account" if matched_term.get("csv_value") == csv_value
                           else " in this account scope")
                    ),
                    terminal_day_reconciled=True,
                )

    # Rule 6: fuzzy text match on candidates with the same date+amount. Same precondition as Rule 2
    # for cross-account expansion; same-account candidates are always considered.
    if context.text_strategy_enabled and not terminal_day_reconciled:
        candidate_rows = list(
            context.existing_rows_by_account_amount.get(receiving_account_id, {})
            .get(duplicate_amount_key(parsed_date, amount), [])
        )
        receiving_account_is_known = (
            receiving_account_id in context.accounts_with_prior_history
            or csv_value in context.explicit_alias_csv_values
        )
        if compare_target_id and receiving_account_is_known:
            linked = context.existing_rows_by_effective_account_amount.get(compare_target_id, {}).get(
                duplicate_amount_key(parsed_date, amount), []
            )
            seen_ids = {c["id"] for c in candidate_rows}
            candidate_rows.extend(c for c in linked if c["id"] not in seen_ids)
        heuristic = find_textual(candidate_rows, txn_payload)
        if heuristic:
            return DedupeVerdict(
                hard_reject=True, passthrough=False, matched=heuristic,
                reason=(
                    "Possible cross-source match by date, amount, and source text"
                    + (" in the linked account group"
                       if heuristic.get("duplicate_scope") == "linked_account_group" else " in this account")
                    + " (medium confidence)"
                ),
                terminal_day_reconciled=terminal_day_reconciled,
            )

    return DedupeVerdict(passthrough=True, terminal_day_reconciled=terminal_day_reconciled)


def _sorted_pair(a: str, b: str) -> tuple[str, str]:
    """Return (a, b) sorted so the lower id comes first. Used everywhere account_pair_distinct
    is read or written — the table stores pairs canonically (account_id_low < account_id_high)
    so each pair has exactly one row regardless of which direction surfaced first."""
    a = str(a); b = str(b)
    return (a, b) if a < b else (b, a)


def list_distinct_account_pairs(conn: sqlite3.Connection) -> list[dict]:
    """Return every recorded distinct-account assertion the user has made via Keep, joined to
    the account display names so the management UI can render them without a follow-up fetch."""
    rows = conn.execute(
        """
        SELECT
            p.account_id_low, p.account_id_high, p.asserted_at,
            a_low.name           AS account_low_name,
            a_low.display_name   AS account_low_display_name,
            a_low.mask           AS account_low_mask,
            a_high.name          AS account_high_name,
            a_high.display_name  AS account_high_display_name,
            a_high.mask          AS account_high_mask
        FROM   account_pair_distinct p
        JOIN   account a_low  ON a_low.id  = p.account_id_low
        JOIN   account a_high ON a_high.id = p.account_id_high
        ORDER  BY p.asserted_at DESC
        """
    ).fetchall()
    return [dict(r) for r in rows]


def forget_account_pair_distinct(conn: sqlite3.Connection,
                                  account_id_a: str, account_id_b: str) -> dict:
    """Remove a recorded distinct-account assertion. The next import touching both accounts
    will re-evaluate matches between them and may surface fresh suspects. The user's prior
    transaction-level resolutions (Keep/Reject) on specific rows are not touched."""
    low, high = _sorted_pair(account_id_a, account_id_b)
    cursor = conn.execute(
        "DELETE FROM account_pair_distinct WHERE account_id_low = ? AND account_id_high = ?",
        (low, high),
    )
    return {"deleted": cursor.rowcount or 0}


def clear_account_pair_distinct_for_merge(conn: sqlite3.Connection,
                                           account_ids: Iterable[str]) -> int:
    """When two accounts are merged, the user is asserting they're the same physical account.
    That contradicts any prior 'distinct accounts' assertion between them — delete any such
    row so the new declaration is the truth of record."""
    account_id_list = [aid for aid in (account_ids or []) if aid]
    if len(account_id_list) < 2:
        return 0
    placeholders = _placeholders(account_id_list)
    cursor = conn.execute(
        f"""
        DELETE FROM account_pair_distinct
        WHERE  account_id_low  IN ({placeholders})
          AND  account_id_high IN ({placeholders})
        """,
        [*account_id_list, *account_id_list],
    )
    return cursor.rowcount or 0


def restore_auto_merged_after_detach(conn: sqlite3.Connection,
                                      detached_account_id: str,
                                      remaining_group_account_ids: Iterable[str]) -> int:
    """When an account is detached from its merged group, reverse the auto-promotion that
    `promote_in_group_suspects_to_confirmed` did during the original merge — but ONLY for rows
    the marker tags as automatic ('auto_merge'). User-explicit Reject decisions
    (dedupe_resolved_by='user') are left alone; the user's deliberate "yes, this is a duplicate"
    stays in effect even after the accounts are taken apart.

    A restored row goes back to its prior state: trashed_at/rejection_reason/suspect_resolved_at
    cleared, suspect_duplicate_of preserved as the audit pointer. It re-appears as an active
    suspect in the duplicate-detection dialog so the user can Keep, Reject, or leave alone.

    Symmetry matters here. Promotion graduates a soft-flag based on the *pair* — it trashes the
    suspect-holding row (`t1`, the one carrying `suspect_duplicate_of`) whenever either endpoint
    of the pair lands in the merged group. So the trashed `auto_merge` row can sit on *either*
    side of the detached↔remaining split: it might be on the detaching account pointing at a
    canonical in the remaining group, OR on a remaining-group account pointing at a canonical on
    the detaching account (this is exactly the case where the imported file that holds the
    suspect was on the account that stays, and the merge target it duplicated was the account
    being pulled out). Reversing only the first orientation strands the second permanently, so we
    undo both. In both orientations one endpoint is the detaching account and the other is in the
    remaining group — that constraint is what keeps the reversal scoped to the promotions this
    particular detach is splitting, leaving promotions wholly inside the remaining group alone.

    `remaining_group_account_ids` is the set of accounts still in the (formerly merged) group
    after the detach. Only pairs that straddle the detach boundary are reversed.

    Returns the count of rows restored.
    """
    remaining_ids = [aid for aid in (remaining_group_account_ids or []) if aid]
    if not detached_account_id or not remaining_ids:
        return 0
    placeholders = _placeholders(remaining_ids)
    cursor = conn.execute(
        f"""
        UPDATE txn
        SET    trashed_at = NULL,
               rejection_reason = NULL,
               suspect_resolved_at = NULL,
               dedupe_resolved_by = NULL
        WHERE  dedupe_resolved_by = 'auto_merge'
          AND  rejection_reason = 'duplicate_confirmed'
          AND  (
                 -- trashed row on the detaching account, its canonical in the remaining group
                 (account_id = ?
                  AND suspect_duplicate_of IN (
                        SELECT id FROM txn WHERE account_id IN ({placeholders})))
                 -- mirror: trashed row on a remaining-group account, its canonical on the detaching account
              OR (account_id IN ({placeholders})
                  AND suspect_duplicate_of IN (
                        SELECT id FROM txn WHERE account_id = ?))
               )
        """,
        [detached_account_id, *remaining_ids, *remaining_ids, detached_account_id],
    )
    return cursor.rowcount or 0


def mark_import_suspects(conn: sqlite3.Connection, batch_id: str) -> int:
    """After a batch's transactions have been inserted, flag every cross-batch cross-account
    same-(date, amount, normalized payee) match as a soft-flag suspect — unless the pair of
    accounts is already in `account_pair_distinct` (the user has previously declared them
    distinct). Returns the number of rows flagged.

    The check runs for ALL rows in the batch; there is no "brand-new account" gate. The
    `account_pair_distinct` filter is what keeps the output non-noisy after the user has
    reviewed each pair once. The reason value is always `'cross_account'`.

    Within-batch (same-batch) pairs are skipped: the source asserts via the CSV that two rows
    on different accounts in the same file are distinct transactions, even if they share
    date/amount/payee. Cross-batch pairs are candidates.
    """
    matches = conn.execute(
        f"""
        SELECT t1.id AS new_id, MIN(t2.id) AS existing_id
        FROM   txn t1
        JOIN   txn t2
          ON   t2.id != t1.id
          AND  t2.account_id != t1.account_id
          AND  t2.date = t1.date
          AND  ROUND(t2.amount, 2) = ROUND(t1.amount, 2)
          AND  {NORMALIZED_PAYEE_SQL.format(alias='t2')} = {NORMALIZED_PAYEE_SQL.format(alias='t1')}
          AND  {NORMALIZED_PAYEE_SQL.format(alias='t1')} != ''
          AND  t2.trashed_at IS NULL
          AND  (t2.import_batch_id IS NULL OR t2.import_batch_id != t1.import_batch_id)
          AND  NOT EXISTS (
                SELECT 1
                FROM   account_pair_distinct p
                WHERE  p.account_id_low  = MIN(t1.account_id, t2.account_id)
                  AND  p.account_id_high = MAX(t1.account_id, t2.account_id)
          )
        WHERE  t1.import_batch_id = ?
          AND  t1.trashed_at IS NULL
          AND  t1.suspect_duplicate_of IS NULL
        GROUP  BY t1.id
        """,
        (batch_id,),
    ).fetchall()
    if not matches:
        return 0
    conn.executemany(
        """
        UPDATE txn
        SET    suspect_duplicate_of = ?,
               suspect_duplicate_reason = 'cross_account',
               suspect_resolved_at = NULL
        WHERE  id = ?
        """,
        [(row["existing_id"], row["new_id"]) for row in matches],
    )
    return len(matches)


def list_suspects(conn: sqlite3.Connection, *, batch_id: str | None = None, limit: int = 500) -> list[dict]:
    """Return active suspect pairs (flagged, not yet resolved). Each row carries enough context
    for the review UI to render both sides without a follow-up fetch."""
    params: list = []
    clauses = [
        "t1.suspect_duplicate_of IS NOT NULL",
        "t1.suspect_resolved_at IS NULL",
        "t1.trashed_at IS NULL",
    ]
    if batch_id:
        clauses.append("t1.import_batch_id = ?")
        params.append(batch_id)
    where = " AND ".join(clauses)
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT
            t1.id                          AS new_id,
            t1.date                        AS new_date,
            t1.amount                      AS new_amount,
            COALESCE(NULLIF(t1.display_name, ''), NULLIF(t1.merchant_name, ''), NULLIF(t1.raw_name, ''))
                                           AS new_payee,
            a1.display_name                AS new_account_display_name,
            a1.name                        AS new_account_name,
            c1.name                        AS new_category_name,
            t1.import_batch_id             AS new_batch_id,
            t1.suspect_duplicate_reason    AS reason,
            t2.id                          AS existing_id,
            t2.date                        AS existing_date,
            t2.amount                      AS existing_amount,
            COALESCE(NULLIF(t2.display_name, ''), NULLIF(t2.merchant_name, ''), NULLIF(t2.raw_name, ''))
                                           AS existing_payee,
            a2.display_name                AS existing_account_display_name,
            a2.name                        AS existing_account_name,
            c2.name                        AS existing_category_name,
            t2.import_batch_id             AS existing_batch_id
        FROM   txn t1
        JOIN   txn t2                ON t2.id = t1.suspect_duplicate_of
        LEFT JOIN account  a1        ON a1.id = t1.account_id
        LEFT JOIN account  a2        ON a2.id = t2.account_id
        LEFT JOIN category c1        ON c1.id = t1.category_id
        LEFT JOIN category c2        ON c2.id = t2.category_id
        WHERE  {where}
        ORDER  BY t1.date DESC, t1.id
        LIMIT  ?
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def count_active_suspects(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM   txn
        WHERE  suspect_duplicate_of IS NOT NULL
          AND  suspect_resolved_at IS NULL
          AND  trashed_at IS NULL
        """,
    ).fetchone()
    return int(row["n"] if row else 0)


# ---------------------------------------------------------------------------
# Unified per-batch report
# ---------------------------------------------------------------------------
# Hard rejects (from `import_batch_duplicate`) and soft flags (from `txn.suspect_duplicate_of`)
# share a uniform response shape so the import-file card can render them in one place; the
# `kind` field plus a few optional fields in `incoming` distinguish the two cases.


# Maps a free-text reason produced by the import-time rule chain to a stable rule_key + confidence
# tag the UI can group/style on. New reason strings get a fallback of ('other_hard', 'medium')
# until the table is extended; this prevents silent grouping under "unknown" if a rule reason text
# is tweaked without updating the map.
_RULE_REASON_CLASSIFIERS = (
    ("Matches an existing transaction in the linked account group",
     "exact_hash_linked_group", "high"),
    ("Matches an existing transaction",
     "exact_hash_same_account", "high"),
    ("Falls within the fully covered date range from an earlier import for this source account",
     "coverage_same_source", "medium"),
    ("Falls within the fully covered date range from an earlier import in this account scope",
     "coverage_in_scope", "medium"),
    ("Matches a remaining transaction from the terminal covered day in an earlier import for this source account",
     "terminal_day_same_source", "medium"),
    ("Matches a remaining transaction from the terminal covered day in an earlier import in this account scope",
     "terminal_day_in_scope", "medium"),
    ("Possible cross-source match by date, amount, and source text in the linked account group",
     "text_strategy_linked_group", "medium"),
    ("Possible cross-source match by date, amount, and source text in this account",
     "text_strategy_same_account", "medium"),
)

_SOFT_FLAG_CLASSIFIERS = {
    # New unified reason in the per-pair-distinct model.
    "cross_account":      ("cross_account",      "low"),
    # Legacy reasons kept in the map for forward-compatibility while old data is being
    # migrated; both map to the same rule_key for UI purposes since they represent the
    # same logical case (cross-account same-(date, amount, payee) match).
    "import_new_account": ("cross_account",      "low"),
    "account_merge":      ("cross_account",      "low"),
}

# User-facing labels keyed by rule_key. Short label is what shows up in the badge; long label is
# the tooltip. These are intentionally not derived from the reason text so labels can be tuned
# independently of the rule chain's own wording. Keep keys here in sync with the classifiers
# above and with the `_confirmed` suffix used for graduated soft-flags.
_RULE_LABELS = {
    "exact_hash_same_account":         ("Exact match (same account)",
                                        "Identical date, amount, and payee already exist on the receiving account."),
    "exact_hash_linked_group":         ("Exact match (linked group)",
                                        "Identical date, amount, and payee already exist on a sibling account in the same linked group."),
    "coverage_same_source":            ("Date covered (same source)",
                                        "This date falls inside a date range already fully imported from this same source."),
    "coverage_in_scope":               ("Date covered (account)",
                                        "This date falls inside a date range already fully imported for this account from a different source."),
    "terminal_day_same_source":        ("Boundary day (same source)",
                                        "Matches a reserved slot on the boundary day of a prior import from this same source."),
    "terminal_day_in_scope":           ("Boundary day (account)",
                                        "Matches a reserved slot on the boundary day of a prior import for this account."),
    "text_strategy_same_account":      ("Likely match by text (same account)",
                                        "Same date and amount, with similar source text, on the receiving account."),
    "text_strategy_linked_group":      ("Likely match by text (linked group)",
                                        "Same date and amount, with similar source text, on a sibling account in the same linked group."),
    "cross_account":                   ("Cross-account match",
                                        "Same date, amount, and payee as a transaction on a different account. Surfaced for review so you can decide whether the two accounts are actually distinct."),
    "cross_account_confirmed":         ("Cross-account match (confirmed)",
                                        "You confirmed this is the same real-world transaction as one already on a different account; the row stays out of the active ledger."),
    # Legacy keys retained so labels still render correctly for old rows that may exist before
    # the migration sweep has touched them. New rows use the cross_account key above.
    "import_new_account":              ("Cross-account match",
                                        "Same date, amount, and payee as a transaction on a different account."),
    "account_merge":                   ("Cross-account match",
                                        "Same date, amount, and payee as a transaction on a different account."),
    "import_new_account_confirmed":    ("Cross-account match (confirmed)",
                                        "Confirmed duplicate of a transaction on a different account."),
    "account_merge_confirmed":         ("Cross-account match (confirmed)",
                                        "Confirmed duplicate of a transaction on a different account."),
    "other_hard":                      ("Other (hard-reject)", "Hard-rejected with a reason this report does not yet have a friendly label for."),
    "other_soft":                      ("Other (review)",     "Soft-flagged with a reason this report does not yet have a friendly label for."),
}


def rule_label_for(rule_key: str) -> tuple[str, str]:
    """Return (short_label, long_description) for a rule_key. Falls back to (rule_key, '') if the
    key is unknown — keeps the UI rendering instead of blowing up when a new rule lands."""
    return _RULE_LABELS.get(rule_key, (rule_key, ""))


def _classify_hard_reject_reason(reason_text: str) -> tuple[str, str]:
    text = (reason_text or "").strip()
    for needle, key, confidence in _RULE_REASON_CLASSIFIERS:
        if needle in text:
            return key, confidence
    return "other_hard", "medium"


def _classify_soft_flag_reason(reason_key: str) -> tuple[str, str]:
    return _SOFT_FLAG_CLASSIFIERS.get((reason_key or "").strip(), ("other_soft", "low"))


def _matched_existing_txn_ids(matched) -> list[str]:
    """Pull the existing-transaction id(s) out of a stored `matched_transaction_json`, across the
    rule shapes: exact-hash carries a top-level `id`; coverage carries `candidates: [{id, …}]` (and
    sometimes a `covered` block). Used to resolve what an account's skipped rows matched against."""
    ids: list[str] = []
    if not isinstance(matched, dict):
        return ids
    if matched.get("id"):
        ids.append(matched["id"])
    covered = matched.get("covered")
    if isinstance(covered, dict) and covered.get("id"):
        ids.append(covered["id"])
    for candidate in (matched.get("candidates") or []):
        if isinstance(candidate, dict) and candidate.get("id"):
            ids.append(candidate["id"])
    return ids


def account_skipped_duplicate_summary(conn: sqlite3.Connection, account_id: str) -> dict:
    """Summarize transactions that belonged to `account_id` but never entered (or were trashed from)
    the active ledger because they were duplicates — the explanation for an account that looks empty.

    Two pools contribute: hard-rejected import rows (`import_batch_duplicate`, attributed via the
    stored `txn_payload`'s `account_id`) and confirmed-duplicate rows (soft-flags accepted as real
    duplicates, kept as trashed `txn` rows). Returns the skipped count, the distinct accounts and
    source files the matched (existing) transactions live on, and the importing batch(es) — with a
    `primary_batch_id` for a deep-link into the duplicate report scoped to this account.
    """
    hard_reject_count = 0
    confirmed_count = 0
    batch_counts: dict[str, int] = {}
    matched_ids: set[str] = set()

    for row in conn.execute(
        "SELECT batch_id, txn_payload_json, matched_transaction_json FROM import_batch_duplicate"
    ).fetchall():
        try:
            payload = json.loads(row["txn_payload_json"]) if row["txn_payload_json"] else {}
        except Exception:
            payload = {}
        if not isinstance(payload, dict) or payload.get("account_id") != account_id:
            continue
        hard_reject_count += 1
        batch_counts[row["batch_id"]] = batch_counts.get(row["batch_id"], 0) + 1
        try:
            matched = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
        except Exception:
            matched = {}
        matched_ids.update(_matched_existing_txn_ids(matched))

    for row in conn.execute(
        """
        SELECT import_batch_id, suspect_duplicate_of
        FROM   txn
        WHERE  account_id = ?
          AND  trashed_at IS NOT NULL
          AND  rejection_reason = 'duplicate_confirmed'
        """,
        (account_id,),
    ).fetchall():
        confirmed_count += 1
        if row["import_batch_id"]:
            batch_counts[row["import_batch_id"]] = batch_counts.get(row["import_batch_id"], 0) + 1
        if row["suspect_duplicate_of"]:
            matched_ids.add(row["suspect_duplicate_of"])

    skipped_count = hard_reject_count + confirmed_count
    if skipped_count == 0:
        return {
            "account_id": account_id,
            "skipped_count": 0,
            "hard_reject_count": 0,
            "confirmed_count": 0,
            "matched_accounts": [],
            "matched_sources": [],
            "batch_ids": [],
            "primary_batch_id": None,
            "primary_batch_filename": None,
        }

    matched_accounts: set[str] = set()
    matched_sources: set[str] = set()
    if matched_ids:
        id_list = [mid for mid in matched_ids if mid]
        placeholders = ",".join("?" * len(id_list))
        for row in conn.execute(
            f"""
            SELECT COALESCE(NULLIF(p.display_name, ''), p.name, NULLIF(a.display_name, ''), a.name) AS account_label,
                   b.filename AS filename
            FROM   txn t
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN import_batch b ON b.id = t.import_batch_id
            WHERE  t.id IN ({placeholders})
            """,
            id_list,
        ).fetchall():
            if row["account_label"]:
                matched_accounts.add(row["account_label"])
            if row["filename"]:
                matched_sources.add(row["filename"])

    primary_batch_id = max(batch_counts, key=batch_counts.get) if batch_counts else None
    primary_batch_filename = None
    if primary_batch_id:
        r = conn.execute("SELECT filename FROM import_batch WHERE id = ?", (primary_batch_id,)).fetchone()
        primary_batch_filename = r["filename"] if r else None

    return {
        "account_id": account_id,
        "skipped_count": skipped_count,
        "hard_reject_count": hard_reject_count,
        "confirmed_count": confirmed_count,
        "matched_accounts": sorted(matched_accounts),
        "matched_sources": sorted(matched_sources),
        "batch_ids": sorted(batch_counts.keys()),
        "primary_batch_id": primary_batch_id,
        "primary_batch_filename": primary_batch_filename,
    }


def _safe_json_list(raw) -> list:
    try:
        value = json.loads(raw) if raw else []
        return value if isinstance(value, list) else []
    except (ValueError, TypeError):
        return []


def list_unified_batch_duplicates(conn: sqlite3.Connection, batch_id: str) -> list[dict]:
    """Return the combined list of hard-reject and soft-flag dedupe entries for a single batch.
    Each entry has the same outer shape; `kind` distinguishes the two pools. Hard rejects carry
    the CSV row number and full CSV values; soft flags carry the resulting `txn` id.

    Every matched-existing row is enriched with `source_batch_id`, `source_filename`, and
    `source_imported_at` so the UI can show where the row came from and offer a drill-through
    into the source file's transactions. Coverage-rule hard-rejects already carry source info on
    their `covered` block (the prior import whose date range caused the rejection).
    """
    # Load a batch_id → filename/imported_at map once. Used to enrich every matched-existing
    # reference (specific rows AND coverage entries) with human-readable source context.
    batch_meta: dict[str, dict] = {}
    for row in conn.execute(
        "SELECT id, filename, imported_at FROM import_batch"
    ).fetchall():
        batch_meta[str(row["id"])] = {
            "source_filename":     row["filename"],
            "source_imported_at":  row["imported_at"],
        }

    def enrich_with_source(target: dict, source_batch_id: Optional[str]) -> dict:
        """Merge filename/imported_at into target if we know the source batch. No-op if unknown."""
        if not source_batch_id:
            return target
        meta = batch_meta.get(str(source_batch_id))
        if not meta:
            return target
        out = dict(target)
        out["source_batch_id"]     = source_batch_id
        out["source_filename"]     = meta.get("source_filename")
        out["source_imported_at"]  = meta.get("source_imported_at")
        return out

    entries: list[dict] = []

    # Hard rejects (never made it into the ledger).
    for row in conn.execute(
        """
        SELECT row_number, reason, values_json, matched_transaction_json, txn_payload_json, reviewed_at,
               enriched_at, enriched_delta_json
        FROM   import_batch_duplicate
        WHERE  batch_id = ?
        ORDER  BY row_number
        """,
        (batch_id,),
    ).fetchall():
        try:
            values = json.loads(row["values_json"]) if row["values_json"] else {}
        except Exception:
            values = {}
        try:
            matched = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
        except Exception:
            matched = {}
        try:
            txn_payload = json.loads(row["txn_payload_json"]) if row["txn_payload_json"] else {}
        except Exception:
            txn_payload = {}
        rule_key, confidence = _classify_hard_reject_reason(row["reason"])
        rule_label, rule_description = rule_label_for(rule_key)
        # Hard-reject incoming side comes from the CSV — the row never became a txn — so we surface
        # both the parsed payload fields (date/amount/merchant) and the raw CSV columns the user
        # would recognize, plus the source account string straight from the CSV.
        incoming_account = (
            (values.get("Account") if isinstance(values, dict) else None)
            or txn_payload.get("csv_value")
            or ""
        )

        # Enrich the matched dict with source filename info. The shape varies by rule:
        #   - coverage hard-reject (newer):  matched = {covered: {source_batch_id, ...},
        #                                                candidates: [{id, import_batch_id, ...}], ...}
        #   - exact-hash hard-reject:        matched = {id, date, merchant_name, amount,
        #                                                import_batch_id, ...}
        #   - legacy entries (pre-upgrade):  matched = {date, merchant_name, amount}
        # The newer shapes carry import_batch_id; we add filename lookup. Legacy entries get the
        # raw matched dict unchanged.
        enriched_matched: dict = matched if isinstance(matched, dict) else {}
        if isinstance(enriched_matched, dict):
            if "covered" in enriched_matched:
                covered = enriched_matched.get("covered") or {}
                enriched_matched = dict(enriched_matched)
                enriched_matched["covered"] = enrich_with_source(covered, covered.get("source_batch_id"))
                enriched_matched["candidates"] = [
                    enrich_with_source(c, c.get("import_batch_id"))
                    for c in (enriched_matched.get("candidates") or [])
                ]
            elif enriched_matched.get("import_batch_id"):
                enriched_matched = enrich_with_source(enriched_matched, enriched_matched.get("import_batch_id"))

        # Advisory-review sub-state, only meaningful for coverage-window rejects (the rule that can
        # fire without a specific matching row). `reviewed_at` set → the user has acknowledged it,
        # so it leaves the review bucket regardless. Otherwise: a coverage reject whose only
        # candidates are the ±2 timezone fallback is `matched_2d`; one with no candidate at all is
        # `no_match` (the genuinely-needs-a-look case); a coverage reject that DID match at exact/±1
        # is a settled rejection with no sub-state.
        reviewed = bool(row["reviewed_at"])
        review_substate = None
        if isinstance(enriched_matched, dict) and "covered" in enriched_matched and not reviewed:
            candidates = enriched_matched.get("candidates") or []
            if not candidates:
                review_substate = "no_match"
            elif all(c.get("cross_account") for c in candidates):
                # A funding/deposit leg whose only twin is the cross-account transfer counterpart —
                # surfaced to confirm (correctly not re-imported) or reject (separate → import anyway).
                # The cross-account fallback only runs when no same-account candidate exists, so a
                # candidate set is never a mix of the two.
                review_substate = "transfer_match"
            elif min(abs(c.get("day_offset", 0)) for c in candidates) >= 2:
                review_substate = "matched_2d"

        entries.append({
            "kind": "hard_reject",
            "rule_key": rule_key,
            "rule_label": rule_label,
            "rule_description": rule_description,
            "confidence": confidence,
            "reason_text": row["reason"] or "",
            "reviewed": reviewed,
            "review_substate": review_substate,
            # Enrich-on-duplicate: whether this row's incoming detail was folded into its matched
            # transaction, and what was added — so the report can show the state and offer undo.
            "enriched": bool(row["enriched_at"]),
            "enriched_detail": _safe_json_list(row["enriched_delta_json"]) if row["enriched_at"] else [],
            "incoming": {
                "row_number": row["row_number"],
                "date": txn_payload.get("date"),
                "amount": txn_payload.get("amount"),
                "merchant": txn_payload.get("display_name") or txn_payload.get("merchant_name") or txn_payload.get("raw_name"),
                "account_name": incoming_account,
                # The account the row would have been imported into (resolved at import time). Lets the
                # report be scoped to one account — e.g. opened from an empty account's detail panel.
                "account_id": txn_payload.get("account_id"),
                "csv_values": values if isinstance(values, dict) else {},
            },
            "matched": enriched_matched,
        })

    # Soft flags (in the ledger with suspect_duplicate_of set) AND confirmed-duplicate rows
    # (soft flags that were resolved as real duplicates — rejection_reason='duplicate_confirmed').
    # Both share the same base shape; the WHERE clause distinguishes their state:
    #   * unresolved soft flag: suspect_duplicate_of set, rejection_reason NULL, trashed_at NULL
    #   * confirmed duplicate:  suspect_duplicate_of set (kept as audit trail),
    #                           rejection_reason='duplicate_confirmed', trashed_at set
    for row in conn.execute(
        f"""
        SELECT
            t1.id                       AS new_id,
            t1.date                     AS new_date,
            t1.amount                   AS new_amount,
            COALESCE(NULLIF(t1.display_name, ''), NULLIF(t1.merchant_name, ''), NULLIF(t1.raw_name, '')) AS new_merchant,
            t1.account_id               AS new_account_id,
            a1.name                     AS new_account_name,
            COALESCE(NULLIF(a1p.display_name, ''), a1p.name) AS new_account_merged_into,
            t1.suspect_duplicate_reason AS reason_key,
            t1.suspect_resolved_at      AS resolved_at,
            t1.rejection_reason         AS rejection_reason,
            t2.id                       AS existing_id,
            t2.date                     AS existing_date,
            t2.amount                   AS existing_amount,
            COALESCE(NULLIF(t2.display_name, ''), NULLIF(t2.merchant_name, ''), NULLIF(t2.raw_name, '')) AS existing_merchant,
            a2.name                     AS existing_account_name,
            COALESCE(NULLIF(a2p.display_name, ''), a2p.name) AS existing_account_merged_into,
            t2.import_batch_id          AS existing_batch_id
        FROM   txn t1
        JOIN   txn t2                ON t2.id = t1.suspect_duplicate_of
        LEFT JOIN account a1         ON a1.id = t1.account_id
        LEFT JOIN account a2         ON a2.id = t2.account_id
        LEFT JOIN account a1p        ON a1p.id = a1.parent_account_id
        LEFT JOIN account a2p        ON a2p.id = a2.parent_account_id
        WHERE  t1.suspect_duplicate_of IS NOT NULL
          AND  t1.import_batch_id = ?
          AND  (
                (t1.trashed_at IS NULL)
             OR (t1.rejection_reason = 'duplicate_confirmed')
          )
        ORDER  BY t1.date DESC, t1.id
        """,
        (batch_id,),
    ).fetchall():
        is_confirmed = row["rejection_reason"] == "duplicate_confirmed"
        base_rule_key, confidence = _classify_soft_flag_reason(row["reason_key"])
        rule_key = f"{base_rule_key}_confirmed" if is_confirmed else base_rule_key
        rule_label, rule_description = rule_label_for(rule_key)
        # Account labels here are the as-imported account names (`account.name`), NOT the merged
        # effective `display_name`. This report exists to explain what each *file* contained, so a
        # source account later merged under a parent must still read as its own file label (e.g. a
        # "Credit Card" account merged under a parent still shows "Credit Card", with the parent
        # surfaced separately as `account_merged_into` so the UI can annotate the mapping).
        incoming = {
            "txn_id": row["new_id"],
            "date": row["new_date"],
            "amount": row["new_amount"],
            "merchant": row["new_merchant"],
            "account_name": row["new_account_name"],
            "account_id": row["new_account_id"],
            "account_merged_into": row["new_account_merged_into"],
        }
        matched = enrich_with_source({
            "id": row["existing_id"],
            "date": row["existing_date"],
            "amount": row["existing_amount"],
            "merchant": row["existing_merchant"],
            "account_name": row["existing_account_name"],
            "account_merged_into": row["existing_account_merged_into"],
            "import_batch_id": row["existing_batch_id"],
        }, row["existing_batch_id"])
        if is_confirmed:
            # Confirmed soft-flags graduate into `kind: 'hard_reject'` so the unified report
            # routes them through the same UI path as import-time rejects. The rule_key keeps
            # `_confirmed` so the badge text can distinguish the two histories; the confidence
            # band is overridden to 'medium' so the pill renders in the "settled" blue family
            # rather than the "needs attention" orange used for unresolved soft-flags.
            entries.append({
                "kind": "hard_reject",
                "rule_key": rule_key,
                "rule_label": rule_label,
                "rule_description": rule_description,
                "confidence": "medium",
                "reason_text": "Confirmed duplicate of a transaction on a different account (resolved from soft-flag review)",
                "resolved": True,
                "incoming": incoming,
                "matched": matched,
            })
        else:
            entries.append({
                "kind": "soft_flag",
                "rule_key": rule_key,
                "rule_label": rule_label,
                "rule_description": rule_description,
                "confidence": confidence,
                "reason_text": "Suspect duplicate of a transaction on a different account",
                "resolved": False,
                "incoming": incoming,
                "matched": matched,
            })

    return entries


def resolve_suspect(conn: sqlite3.Connection, txn_id: str, *, action: str) -> dict:
    """Resolve a soft-flagged suspect.

    Actions:
      - 'keep' / 'not_duplicate': clears the suspect flag; the row stays in the active ledger as
        a confirmed-distinct transaction.
      - 'reject' / 'trash': confirms the suspect as a real duplicate; the row is hidden from
        active ledger queries (`trashed_at` set) and tagged with `rejection_reason =
        'duplicate_confirmed'` so the unified duplicate report can surface it alongside the
        import-time hard-rejects. The `suspect_duplicate_of` pointer is intentionally kept as
        an audit trail of *which* existing row the user accepted as the canonical copy.
        ('trash' is preserved as an alias of 'reject' for back-compat with the existing API.)
      - 'replace': the inverse survivor of 'reject'. The incoming (new-file) row is the correct
        record — it carries the account the user trusts — so it SURVIVES, and the existing matched
        row is removed as a confirmed duplicate (restorable from its own batch's report). Used to
        fix an account when one source labeled a transaction under the wrong account (e.g. a legacy
        umbrella "Credit Card" account vs. the real card from a newer statement). Categorization on the surviving row
        follows each file's "use imported categories" choice: keep the incoming row's own category
        ONLY when the incoming file is the sole one with that flag set; otherwise adopt the existing
        row's category (covers existing-only and the both/neither tie). The adopted category is
        written as a manual override so rule reruns don't undo it, and a NULL existing category is
        never copied (we don't downgrade a categorized row to uncategorized). Unlike 'keep',
        'replace' does NOT assert the two accounts are distinct and does not cascade — it is a
        per-row "these are the same transaction" decision.
    """
    row = conn.execute(
        "SELECT id, suspect_duplicate_of, trashed_at FROM txn WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if not row:
        return {"resolved": False, "reason": "not_found"}
    if not row["suspect_duplicate_of"]:
        return {"resolved": False, "reason": "not_suspect"}
    if action == "replace":
        existing = conn.execute(
            "SELECT id, category_id, import_batch_id FROM txn WHERE id = ?",
            (row["suspect_duplicate_of"],),
        ).fetchone()
        if not existing:
            return {"resolved": False, "reason": "matched_missing"}
        incoming = conn.execute(
            "SELECT id, import_batch_id FROM txn WHERE id = ?", (txn_id,),
        ).fetchone()

        def _batch_uses_imported_categories(batch_id) -> bool:
            if not batch_id:
                return False
            r = conn.execute(
                "SELECT use_imported_categories FROM import_batch WHERE id = ?", (batch_id,),
            ).fetchone()
            return bool(r["use_imported_categories"]) if r else False

        incoming_uses = _batch_uses_imported_categories(incoming["import_batch_id"])
        existing_uses = _batch_uses_imported_categories(existing["import_batch_id"])
        # Adopt the existing row's categorization onto the surviving incoming row in every case
        # except where the incoming file is the SOLE file flagged to use its imported categories.
        keep_incoming_category = incoming_uses and not existing_uses
        if not keep_incoming_category and existing["category_id"] is not None:
            conn.execute(
                """
                UPDATE txn
                SET    category_id = ?, category_overridden = 1, category_source = 'manual'
                WHERE  id = ?
                """,
                (existing["category_id"], txn_id),
            )
        # Remove the existing row as a confirmed duplicate, pointing its audit at the incoming row
        # that replaced it (so its own batch's report can show + Restore it), then clear the
        # surviving incoming row's suspect flag so it stays as an active, distinct transaction.
        conn.execute(
            """
            UPDATE txn
            SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   rejection_reason = 'duplicate_confirmed',
                   dedupe_resolved_by = 'user',
                   suspect_duplicate_of = ?
            WHERE  id = ?
            """,
            (txn_id, existing["id"]),
        )
        conn.execute(
            """
            UPDATE txn
            SET    suspect_duplicate_of = NULL,
                   suspect_duplicate_reason = NULL,
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE  id = ?
            """,
            (txn_id,),
        )
        return {"resolved": True, "action": "replace"}
    if action in ("reject", "trash"):
        # `dedupe_resolved_by='user'` records that this resolution is the user's explicit decision,
        # not an automatic side effect. The marker is what protects this row from being auto-
        # restored when accounts are detached — see detach_account / restore_auto_merged_after_detach.
        conn.execute(
            """
            UPDATE txn
            SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   rejection_reason = 'duplicate_confirmed',
                   dedupe_resolved_by = 'user'
            WHERE  id = ?
            """,
            (txn_id,),
        )
        return {"resolved": True, "action": "reject"}
    if action in ("keep", "not_duplicate"):
        # Broad-reading Keep: the user is asserting the two ACCOUNTS are distinct, not just
        # this one row. Record that assertion in account_pair_distinct so the cross-account
        # check skips this pair on all future imports, then cascade-resolve every other
        # unresolved soft-flag suspect between the same pair — the user shouldn't have to
        # click Keep N times for N coincidences when one click conveys the whole assertion.
        matched_row = conn.execute(
            "SELECT account_id FROM txn WHERE id = ?",
            (row["suspect_duplicate_of"],),
        ).fetchone()
        suspect_account = conn.execute(
            "SELECT account_id FROM txn WHERE id = ?", (txn_id,),
        ).fetchone()
        if matched_row and suspect_account and matched_row["account_id"] and suspect_account["account_id"]:
            low, high = _sorted_pair(suspect_account["account_id"], matched_row["account_id"])
            conn.execute(
                """
                INSERT OR IGNORE INTO account_pair_distinct
                  (account_id_low, account_id_high, asserted_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                """,
                (low, high),
            )
            # Cascade: clear suspect flags on every other unresolved row whose endpoints are
            # the same account pair (in either direction).
            conn.execute(
                """
                UPDATE txn
                SET    suspect_duplicate_of = NULL,
                       suspect_duplicate_reason = NULL,
                       suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE  id IN (
                    SELECT t1.id
                    FROM   txn t1
                    JOIN   txn t2 ON t2.id = t1.suspect_duplicate_of
                    WHERE  t1.suspect_duplicate_of IS NOT NULL
                      AND  t1.suspect_resolved_at IS NULL
                      AND  t1.trashed_at IS NULL
                      AND  ((t1.account_id = ? AND t2.account_id = ?)
                         OR (t1.account_id = ? AND t2.account_id = ?))
                )
                """,
                (low, high, high, low),
            )
        else:
            # No account info available (shouldn't normally happen, but be defensive); just
            # clear the single flag we were asked about.
            conn.execute(
                """
                UPDATE txn
                SET    suspect_duplicate_of = NULL,
                       suspect_duplicate_reason = NULL,
                       suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE  id = ?
                """,
                (txn_id,),
            )
        return {"resolved": True, "action": "keep"}
    return {"resolved": False, "reason": "invalid_action"}


def promote_in_group_suspects_to_confirmed(conn: sqlite3.Connection,
                                            account_ids: Iterable[str]) -> int:
    """After accounts are attached into a linked group, any pre-existing soft-flag whose suspect
    and matched-existing rows are now on accounts that share the same effective root has had
    its 'cross-account' premise invalidated by the merge — the user just declared the two
    accounts as the same physical account, so an exact (date, amount, payee) match across them
    is the same case that `exact_hash_linked_group` would have hard-rejected at import time.

    Promote each such flag to a confirmed duplicate: set `trashed_at` +
    `rejection_reason='duplicate_confirmed'` + `suspect_resolved_at`, matching what
    `resolve_suspect(action='reject')` does. The audit pointer `suspect_duplicate_of` stays so
    the user can still see what was matched and Restore if the auto-promotion was wrong.

    Soft-flag suspects in the new dedupe model all carry `'cross_account'` as their reason and
    are created at import time only. This function is the merge-time resolution sweep.
    """
    account_id_list = [aid for aid in (account_ids or []) if aid]
    if not account_id_list:
        return 0
    ph = _placeholders(account_id_list)
    rows = conn.execute(
        f"""
        SELECT t1.id
        FROM   txn t1
        JOIN   txn t2 ON t2.id = t1.suspect_duplicate_of
        JOIN   account a1 ON a1.id = t1.account_id
        JOIN   account a2 ON a2.id = t2.account_id
        WHERE  t1.suspect_duplicate_of IS NOT NULL
          AND  t1.suspect_resolved_at IS NULL
          AND  t1.rejection_reason IS NULL
          AND  t1.trashed_at IS NULL
          AND  COALESCE(a1.parent_account_id, a1.id) = COALESCE(a2.parent_account_id, a2.id)
          AND  (t1.account_id IN ({ph}) OR t2.account_id IN ({ph}))
        """,
        [*account_id_list, *account_id_list],
    ).fetchall()
    if not rows:
        return 0
    ids = [r["id"] for r in rows]
    # `dedupe_resolved_by='auto_merge'` marks this as an automatic, undoable resolution. If the
    # user subsequently detaches the accounts, `restore_auto_merged_after_detach` looks for this
    # marker and reverses these promotions. Rows the user explicitly Reject (with
    # `dedupe_resolved_by='user'`) are left alone on detach.
    conn.executemany(
        """
        UPDATE txn
        SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               rejection_reason = 'duplicate_confirmed',
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               dedupe_resolved_by = 'auto_merge'
        WHERE  id = ?
        """,
        [(i,) for i in ids],
    )
    # Same-batch transitive clear: a single CSV asserts (via account-column) that rows on
    # different accounts in that file are distinct transactions. If a promoted row Y (now
    # identified with its canonical target X via the merge) had a same-batch sibling Z on a
    # different account, and Z's own suspect points at the *same* canonical X, then Z's suspect
    # is necessarily a false positive: Z ≠ Y (CSV assertion) and Y ≡ X (merge), so Z ≠ X. Clear
    # Z's suspect flag. (Must be the same X, not merely a row in the same merged group — see the
    # helper docstring.)
    _clear_same_batch_siblings_after_promotion(conn, ids)
    return len(ids)


def _clear_same_batch_siblings_after_promotion(conn: sqlite3.Connection, promoted_ids: list[str]) -> int:
    """Helper for promote_in_group_suspects_to_confirmed. Clears a freshly-promoted row's
    same-batch siblings that are guaranteed false positives.

    The transitivity argument is exact: a sibling Z is a guaranteed false positive ONLY when it
    points at the *same canonical row X* that a promoted row Y was confirmed against. The CSV
    asserts Z != Y (Z and Y are on different accounts in the same file), and the merge identifies
    Y ≡ X, so Z != X — Z's flag against X is spurious and is cleared.

    The match must be on the *exact* canonical row, not merely its merged group/effective root.
    A sibling pointing at a *different* row that happens to live on an account now in the same
    merged group proves nothing: that other row is a different transaction Z may genuinely
    duplicate. (Concretely: merging a legacy umbrella "Credit Card" account into one real card R
    promotes R's rows, but a same-batch row on a *different* card C whose suspect points at a
    *different* Credit-Card transaction must stay flagged — it is a real cross-account suspect of
    a row that simply shares the merged account, not of any row on card R.)
    """
    if not promoted_ids:
        return 0
    placeholders = _placeholders(promoted_ids)
    cleared = conn.execute(
        f"""
        SELECT DISTINCT z.id
        FROM   txn z
        JOIN   txn y
          ON   y.import_batch_id = z.import_batch_id
          AND  y.account_id != z.account_id
          AND  y.suspect_duplicate_of = z.suspect_duplicate_of
        WHERE  y.id IN ({placeholders})
          AND  z.suspect_duplicate_of IS NOT NULL
          AND  z.suspect_resolved_at IS NULL
          AND  z.rejection_reason IS NULL
          AND  z.trashed_at IS NULL
        """,
        promoted_ids,
    ).fetchall()
    cleared_ids = [str(r["id"]) for r in cleared]
    if not cleared_ids:
        return 0
    conn.executemany(
        """
        UPDATE txn
        SET    suspect_duplicate_of = NULL,
               suspect_duplicate_reason = NULL,
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE  id = ?
        """,
        [(i,) for i in cleared_ids],
    )
    return len(cleared_ids)


def restore_rejected_duplicate(conn: sqlite3.Connection, txn_id: str) -> dict:
    """Reverse a 'reject' on a previously-resolved soft-flag suspect. Clears `trashed_at` and
    `rejection_reason` so the row returns to the active ledger. The `suspect_duplicate_of`
    pointer stays NULL (the suspect was already resolved); the user is asserting this is a real,
    distinct transaction after all."""
    row = conn.execute(
        "SELECT id, rejection_reason, trashed_at FROM txn WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if not row:
        return {"restored": False, "reason": "not_found"}
    if row["rejection_reason"] != "duplicate_confirmed":
        return {"restored": False, "reason": "not_rejected"}
    # Clear `dedupe_resolved_by` too: the row is no longer in a resolved state, so the
    # provenance marker is moot. If the user re-rejects via the dialog later, it'll be set
    # back to 'user' at that point.
    conn.execute(
        """
        UPDATE txn
        SET    trashed_at = NULL,
               rejection_reason = NULL,
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               dedupe_resolved_by = NULL
        WHERE  id = ?
        """,
        (txn_id,),
    )
    return {"restored": True}
