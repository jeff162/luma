# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Duplicate detection for data-connection rows: building a connection's dedupe context from its account
mapping, and re-running the ladder over rows already in the ledger.

The context builder is shared by the two moments a connection's rows meet the ladder — at sync, row by
row as they arrive, and in a re-scan, over rows that arrived before the mapping (or the ladder itself)
existed. Both ask the same question with the same inputs, so they build the same context.

The re-scan is the retroactive half of the account-mapping feature. Mapping a provider account onto an
existing one, or declaring it a compare-only alias, changes what the cross-account rules are permitted
to conclude — but only for rows ingested *after* the declaration. Every row already synced was judged
under the old, weaker premise. The re-scan re-judges them, and is what turns a mapping decision into a
cleanup of the duplicates that decision reveals.
"""

import sqlite3
from typing import Optional

from backend.services.connection_mapping import (
    captured_field_keys,
    dedupe_inputs_for_connection,
)
from backend.services.duplicate_detection import (
    build_dedupe_context,
    evaluate_duplicate,
    matched_existing_txn_ids,
    parse_import_evidence,
    promote_in_group_suspects_to_confirmed,
    scan_scope_for_cross_account_duplicates,
)

# `dedupe_resolved_by` marker for a row the re-scan confirmed as a duplicate. Distinct from
# 'auto_merge' (which account-detach reverses) and from 'user' (an explicit decision in the duplicate
# report): a re-scan removal is automatic but is NOT tied to a linked-group relationship, so detaching
# accounts must not undo it. Restore is the row-level path, from the card's duplicate report.
RESCAN_RESOLVED_BY = "connection_rescan"

# `suspect_duplicate_reason` for a row the re-scan confirmed. Classified and labelled in
# duplicate_detection's rule maps, so the duplicate report explains the occasion ("found by re-scan")
# rather than reporting an empty reason.
RESCAN_REASON_KEY = "connection_rescan"


class ConnectionDedupe:
    """A connection's dedupe context plus the lookups a row-by-row pass needs: what each provider
    account is called (the "source value" the ladder keys on) and which optional detail to capture."""

    def __init__(self, context, inputs: dict, captured_fields: set):
        self.context = context
        self.inputs = inputs
        self.label_by_external = inputs["label_by_external"]
        self.captured_fields = captured_fields

    @property
    def label_by_account(self) -> dict:
        """local account id → its provider account label. The inverse of the mapping's
        source-value index, for a pass that starts from stored rows rather than from the source."""
        return {
            str(account_id): label
            for label, account_id in self.inputs["account_by_source_value"].items()
            if account_id
        }


def own_card_ids(conn: sqlite3.Connection, connection_id: str) -> list[str]:
    """Every import card belonging to a connection — the batches a pass over that connection's rows
    must withhold from its own candidate pool."""
    return [
        r["id"] for r in conn.execute(
            "SELECT id FROM import_batch WHERE connection_id = ?", (connection_id,)
        ).fetchall()
    ]


def build_connection_dedupe(conn: sqlite3.Connection, connection, adapter=None) -> ConnectionDedupe:
    """Assemble the dedupe context for one connection, from its account mapping.

    The connection excludes **its own** coverage claim: a delta inside that range is a late-posting
    charge the provider has only now reported, not a re-import of a range we already asked for. Its own
    sync cards are excluded for the same reason — and, in a re-scan, because a row must not be compared
    against itself. Coverage from *other* sources — a Monarch CSV, another connection — is exactly what
    should reject these rows, and does.
    """
    inputs = dedupe_inputs_for_connection(conn, connection["id"])
    context = build_dedupe_context(
        conn,
        source_values=inputs["source_values"],
        account_by_source_value=inputs["account_by_source_value"],
        compare_targets=inputs["compare_targets"],
        alias_values=inputs["alias_values"],
        exclude_batch_ids=own_card_ids(conn, connection["id"]),
        exclude_connection_ids=[connection["id"]],
    )
    return ConnectionDedupe(
        context, inputs, captured_field_keys(conn, connection["id"], adapter),
    )


def _source_label_for_row(row, label_by_account: dict) -> str:
    """A re-scanned row's source value — the label the ladder keys every source-scoped lookup on.

    The **current mapping** wins over the row's own captured evidence, which is the opposite of the
    priority a candidate row gets. The rows a re-scan exists for were synced before any mapping
    existed, so their evidence records whatever the sync could name them at the time — for the oldest
    rows, the provider's opaque account id. Judging them under that label would key into coverage and
    terminal maps that hold nothing, and every rule that depends on the source value would silently
    find no candidates. Evidence remains the fallback for a row whose account is not in the mapping.
    """
    label = label_by_account.get(str(row["account_id"] or ""), "")
    if label:
        return label
    evidence = parse_import_evidence(row["import_evidence_json"])
    account = evidence.get("account") if isinstance(evidence, dict) else None
    return str((account or {}).get("value") or "").strip() if isinstance(account, dict) else ""


def _rescan_candidates(conn: sqlite3.Connection, card_ids: list[str]) -> list:
    """The connection's rows that a re-scan may act on: still in the ledger, posted, and not already
    resolved. Rows the user has already ruled on (`suspect_resolved_at`) are left alone — a re-scan
    must never re-open a decision, only make one where none was made."""
    if not card_ids:
        return []
    card_ph = ",".join("?" * len(card_ids))
    return conn.execute(
        f"""
        SELECT id, account_id, date, authorized_date, amount, content_hash, merchant_name,
               display_name, raw_name, import_evidence_json, import_batch_id
        FROM   txn
        WHERE  import_batch_id IN ({card_ph})
          AND  trashed_at IS NULL
          AND  is_pending = 0
          AND  content_hash IS NOT NULL
          AND  rejection_reason IS NULL
          AND  suspect_resolved_at IS NULL
        ORDER  BY date, id
        """,
        card_ids,
    ).fetchall()


def _confirm_duplicate(conn: sqlite3.Connection, txn_id: str, matched_id: Optional[str], reason_key) -> None:
    """Remove a re-scanned row as a confirmed duplicate.

    The row is trashed rather than deleted, and `suspect_duplicate_of` is kept as the audit pointer to
    the copy that survived — the same state an account merge or an explicit Reject produces. That is
    what makes the removal legible and reversible: the card's duplicate report lists it as a confirmed
    entry, and Restore brings it back with its categorization and edits intact. Nothing about the row
    is discarded, which is the whole point of re-judging rows in place instead of re-ingesting them.
    """
    conn.execute(
        """
        UPDATE txn
        SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               rejection_reason = 'duplicate_confirmed',
               dedupe_resolved_by = ?,
               suspect_duplicate_of = COALESCE(?, suspect_duplicate_of),
               suspect_duplicate_reason = COALESCE(suspect_duplicate_reason, ?)
        WHERE  id = ?
        """,
        (RESCAN_RESOLVED_BY, matched_id, reason_key, txn_id),
    )


def rescan_connection_duplicates(conn: sqlite3.Connection, connection) -> dict:
    """Re-run the full ladder over a connection's existing synced rows.

    Every row is compared against the ledger *minus this connection's own cards*, so a row can neither
    match itself nor be paired with another row from the same connection. Hard rejects are confirmed
    as duplicates (trashed, restorable); soft flags are recorded on the row for review. The sweep that
    follows is the same pair a merge runs — a fresh existing-vs-existing scan across the mapped
    accounts' groups, then promotion of the in-group flags it (or an earlier pass) raised — because a
    row that arrived before any of this ran was never compared against anything at all.
    """
    dedupe = build_connection_dedupe(conn, connection)
    context = dedupe.context
    card_ids = own_card_ids(conn, connection["id"])
    label_by_account = dedupe.label_by_account
    account_ids = {str(a) for a in label_by_account if a}

    scanned = hard_rejected = soft_flagged = stranded = unmatched = 0
    for row in _rescan_candidates(conn, card_ids):
        account_id = str(row["account_id"] or "")
        # A row on an account the mapping no longer points at. This happens when an 'existing' mapping
        # is re-pointed from one local account to another: the provider handle moves, future syncs
        # follow it, but rows already synced stay on the account that held it. Re-judging them here
        # would be meaningless — the ladder has no candidate set for an account outside the mapping —
        # so they are counted and reported instead of silently skipped. Moving that history is an
        # account merge, which is its own deliberate action.
        if account_id not in account_ids:
            stranded += 1
            continue
        source_label = _source_label_for_row(row, label_by_account)
        if not source_label:
            continue
        scanned += 1
        verdict = evaluate_duplicate(
            context=context,
            receiving_account_id=account_id,
            csv_value=source_label,
            content_hash=row["content_hash"],
            parsed_date=row["date"],
            amount=row["amount"],
            scope_id=context.scope_id_for(account_id, source_label),
            txn_payload={
                "merchant_name": row["merchant_name"],
                "display_name": row["display_name"],
                "raw_name": row["raw_name"],
                "import_evidence": parse_import_evidence(row["import_evidence_json"]),
            },
            authorized_date=row["authorized_date"],
        )
        if verdict.hard_reject:
            # A re-scan removes a row only when it can name the copy that survives. The ladder's
            # coverage rules can hard-reject on the range alone ("this date was already covered,
            # though nothing here matches it specifically"), which is the right answer for a row
            # nobody has seen yet — but retroactively it would delete a row already in the ledger,
            # possibly categorized, with nothing to point at and nothing for the duplicate report to
            # show. Those are left in place and counted; the sweeps below still get their chance.
            matched_id = next(iter(matched_existing_txn_ids(verdict.matched)), None)
            if not matched_id:
                unmatched += 1
                continue
            # `reason_key` is only populated for soft flags, so a re-scan confirmation is stamped with
            # its own key. That is the more useful label anyway: the report should say this row was
            # judged retroactively, not merely which rung of the ladder caught it.
            _confirm_duplicate(conn, row["id"], matched_id, RESCAN_REASON_KEY)
            hard_rejected += 1
        elif verdict.soft_flag and verdict.suspect_of:
            conn.execute(
                """
                UPDATE txn
                SET    suspect_duplicate_of = ?, suspect_duplicate_reason = ?
                WHERE  id = ? AND suspect_duplicate_of IS NULL
                """,
                (verdict.suspect_of, verdict.reason_key, row["id"]),
            )
            soft_flagged += 1

    # The merge-time pair, for the same reason a merge runs it: rows that both predate the comparison
    # are invisible to a ladder that only ever judges incoming rows against existing ones.
    group_account_ids = _mapped_group_accounts(conn, account_ids)
    swept = scan_scope_for_cross_account_duplicates(conn, group_account_ids)
    promoted = promote_in_group_suspects_to_confirmed(conn, group_account_ids)

    return {
        "scanned": scanned,
        "hard_rejected": hard_rejected,
        "soft_flagged": soft_flagged,
        "swept": swept,
        "promoted": promoted,
        "stranded": stranded,
        "unmatched": unmatched,
    }


def _mapped_group_accounts(conn: sqlite3.Connection, account_ids: set) -> list[str]:
    """The mapped accounts plus every sibling sharing their linked-group root. The cross-account sweep
    compares rows *between* accounts in a group, so handing it only the connection's own accounts would
    give it nothing to compare against — the CSV account the group was merged with is the other half."""
    if not account_ids:
        return []
    ph = ",".join("?" * len(account_ids))
    rows = conn.execute(
        f"""
        SELECT DISTINCT other.id AS id
        FROM   account a
        JOIN   account other
               ON COALESCE(other.parent_account_id, other.id) = COALESCE(a.parent_account_id, a.id)
        WHERE  a.id IN ({ph})
          AND  other.trashed_at IS NULL
        """,
        list(account_ids),
    ).fetchall()
    return [str(r["id"]) for r in rows]


__all__ = [
    "ConnectionDedupe",
    "RESCAN_REASON_KEY",
    "RESCAN_RESOLVED_BY",
    "build_connection_dedupe",
    "own_card_ids",
    "rescan_connection_duplicates",
]
