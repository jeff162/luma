# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Sync is the reconciliation path between a provider's transaction stream and local state.

It uses the provider's cursor-based incremental API (Plaid `/transactions/sync`): each call pulls the
`added` / `modified` / `removed` changes since a stored per-connection cursor and reports the backfill
readiness (`update_status`), so the client can poll to completion without a webhook. Core invariants:
idempotence by provider transaction id, pending-to-posted advancement without rewriting local edits,
reuse of the shared categorization engine, and — for a connection's first (historical) pull — one
"initial import" card, with routine top-up syncs accreting onto monthly period cards.

Zero-amount rows are the provider's call, not this loop's. A source often publishes a pending charge
before it carries an amount and revises it on settlement; that revision reaches us keyed on the provider
transaction id, as a `modified` or through `pending_external_transaction_id`. Both paths update a row
already held and ignore a revision naming one that is not (`_apply_modified` counts it `skipped_not_held`)
— so where a provider revises in place, the $0 row is precisely what the settled amount lands on and
filtering it would discard the charge rather than delay it. Where a provider *cannot* revise in place
(SimpleFIN: no change feed, no pending pointer, and a settling charge arrives under a new id) the
placeholder is unreachable and is refused instead, exactly as a CSV's is. Each adapter therefore declares
`zero_amount_rows` and `_insert_added` honors it; the rule for choosing, and the failure each way, is in
`services/source_capabilities.py` and `docs/building-a-connector.md`. A refusal is reported on the card
as a rejected row, never dropped silently.
"""

import json
import uuid
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request

from backend.app_logging import log_warning
from backend.db.database import get_db
from backend.db.demo_data import is_demo_data_loaded
from backend.services.restore_state import require_no_pending_restore
from backend.services import crypto_service
from backend.services.providers import UnknownProviderError, get_adapter, resolve_app_config
from backend.services.providers.config import (
    set_sync_running, sync_outcome, unexplained_already_held,
)
from backend.services.ledger_currency import currency_matches, get_ledger_currency
from backend.services.providers.base import ProviderCredentialRejected
from backend.services.categorizer import (
    categorize_transaction,
    load_categorization_rules,
    source_match_text_from_json,
    load_rule_tags_by_id,
    preview_recategorize_count,
    recategorize_all,
    rule_scalar_effects,
)
from backend.services.connection_dedupe import build_connection_dedupe
from backend.services.source_capabilities import (
    ZERO_AMOUNT_REJECTION_KIND,
    ZERO_AMOUNT_REJECTION_REASON,
    rejects_zero_amount,
)
from backend.services.connection_mapping import (
    build_sync_evidence, provider_account_index, record_provider_accounts,
)
from backend.services.duplicate_detection import (
    evaluate_duplicate,
    sweep_import_suspects,
)
from backend.services.recurring_detection import payee_keys_for_ids, run_auto_scan, scan_imported_payees
from backend.services.transaction_tags import sync_rule_tags_for_transaction

router = APIRouter()

# import_batch.source_kind marker for a data-source sync's period card. A sync groups its rows into one
# card per (connection, calendar month), so synced rows get an import_batch_id and a duplicate-review home
# like any imported file: record-first, then detection.
SYNC_SOURCE_KIND = "connection_sync"

# The fetch-depth (`days_requested`) used when a caller asks for "all available history" and the provider
# publishes no cap of its own. The connection module's guiding principle is to pull as much history as
# possible; the initial connect/refresh backfill uses this, while a user can pick a shallower window
# (persisted as their default) to bound the fetch. A provider that does publish a cap declares it as
# `max_history_days` — Plaid's ~24 months used to be hardcoded here, as though it were universal.
ALL_HISTORY_DAYS = 3650

# Ordering for the *display* status echoed back to the client, least→most complete. These are Plaid's
# `transactions_update_status` values: whether a backfill is finished is no longer read from them (the
# adapter answers that directly with `backfill_complete`), so an unrecognized or absent status simply
# sorts last and shows nothing.
_STATUS_ORDER = {"NOT_READY": 0, "INITIAL_UPDATE_COMPLETE": 1}


def _parse_txn_date(value):
    """A transaction's ISO date as a `date`, or None when the provider sent something unparseable."""
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _resolve_fetch_depth(adapter, *, days: int, is_range_pull: bool) -> int:
    """How far back this pull asks the provider to go.

    A routine sync on a provider with **no** cursor has to name a look-back window, because "everything"
    would re-walk the entire history on every sync — which for a metered provider is how a token gets
    disabled. A cursor provider is deliberately left alone: its `days_requested` defines the window the
    provider *maintains*, so substituting a small routine number there would discard history instead of
    fetching less of it.
    """
    cap = adapter.max_history_days or ALL_HISTORY_DAYS
    if not adapter.has_cursor and not is_range_pull:
        return min(adapter.routine_lookback_days, cap)
    return cap if days <= 0 else min(days, cap)


def resolve_initial_sync_batch(conn, connection) -> str:
    """The connection's single "initial import" card — one card for the whole first historical backfill
    (which can span up to ~24 months), rather than splitting it across monthly cards. Created lazily and
    reused across the paging/polling calls that make up the initial pull (keyed by the `initial_backfill`
    marker in config_snapshot). Once the backfill completes, later syncs use `resolve_sync_period_batch`."""
    row = conn.execute(
        """
        SELECT id FROM import_batch
        WHERE  connection_id = ?
          AND  source_kind = ?
          AND  json_extract(config_snapshot, '$.initial_backfill') = 1
        """,
        (connection["id"], SYNC_SOURCE_KIND),
    ).fetchone()
    if row:
        return row["id"]
    batch_id = str(uuid.uuid4())
    institution = connection["institution"] or connection["provider"] or "Data source"
    filename = f"{institution} · Initial import"
    conn.execute(
        """
        INSERT INTO import_batch (id, filename, status, source_kind, connection_id, config_snapshot)
        VALUES (?, ?, 'completed', ?, ?, ?)
        """,
        (batch_id, filename, SYNC_SOURCE_KIND, connection["id"], json.dumps({"initial_backfill": True})),
    )
    return batch_id


def resolve_sync_period_batch(conn, connection, on_date: date) -> str:
    """Return the id of the (connection, calendar-month) period card, creating it lazily on first use.

    The period is keyed on the **transaction's own month**, not the month the fetch happened in. A card
    labelled "July 2026" therefore holds July's transactions, which is the one thing a user reads
    straight off it; keying on the fetch date filed a July 30th charge arriving August 2nd under
    "August". One fetch may touch more than one card as a result — the tallies below are all keyed by
    card id, so that costs nothing.
    ``sync_period`` in the config snapshot ('YYYY-MM') is the period identity; connection_id (indexed)
    narrows the lookup first.

    Card volume is unchanged for the daily-sync case this scheme exists for: a fetch touches the current
    month, plus the tail of the previous one for a few days after rollover.
    """
    period_key = on_date.strftime("%Y-%m")
    row = conn.execute(
        """
        SELECT id FROM import_batch
        WHERE  connection_id = ?
          AND  source_kind = ?
          AND  json_extract(config_snapshot, '$.sync_period') = ?
        """,
        (connection["id"], SYNC_SOURCE_KIND, period_key),
    ).fetchone()
    if row:
        return row["id"]
    batch_id = str(uuid.uuid4())
    institution = connection["institution"] or connection["provider"] or "Data source"
    filename = f"{institution} · {on_date.strftime('%B %Y')}"
    # A card's transaction-month span is NOT a coverage claim: a delta card can span all of July while
    # holding only the three July rows that happened to arrive. Coverage for a connection lives on
    # connection_account, and these cards deliberately record none (see _record_sync_coverage).
    conn.execute(
        """
        INSERT INTO import_batch (id, filename, status, source_kind, connection_id, config_snapshot)
        VALUES (?, ?, 'completed', ?, ?, ?)
        """,
        (batch_id, filename, SYNC_SOURCE_KIND, connection["id"], json.dumps({"sync_period": period_key})),
    )
    return batch_id


_MAX_PAGES_PER_CALL = 50  # safety cap (≤ 25k txns/request) so a misbehaving has_more can't loop forever

# Cap on retained connection_sync_log rows: a diagnostic aid, not an audit trail — keep the most recent
# window and prune the rest so repeated dev syncs can't grow the table unbounded.
_SYNC_LOG_RETENTION = 500

# How many row ids a sync may record on `connection.last_sync_summary` for its "review what just arrived"
# report. Above this the ids are dropped and the connection card's arrow opens the import card itself
# instead — which is the right answer by construction rather than a degradation: the only pull that
# exceeds the cap is a first backfill, and a backfill already lands on ONE dedicated "Initial import"
# card that isolates it exactly. A routine sync is tens of rows and never comes near this.
#
# The cap is a judgement about the *report*, not a limit of the query: past a few hundred rows nobody is
# categorizing them one by one in a drawer, they want the card. It also bounds a blob that rides
# `GET /api/providers`, which is polled while a sync runs — which is why `list_connections` sends only
# the count, never the ids (see `_last_sync_summary`).
_SCOPED_SYNC_ROW_CAP = 250


def _utcnow_iso() -> str:
    # Note %S before the fractional %f: Python's %f is *microseconds*, not SQLite's seconds.fraction, so
    # omitting %S yields an unparseable "HH:MM:<micros>Z" string (renders as "Invalid Date" in the viewer).
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


# Nested counters for one sync call: `{subject: Counter(bucket -> n)}`. The subject is the **provider's**
# account id for the per-account tally — rather than the local one, because the account that most needs
# counting is the one with no local account at all, and any tally keyed on what the rows landed in can
# only ever count what landed — and a card id for the per-card one.
#
# `skipped` is deliberately several separate buckets rather than one number, because they carry unrelated
# meanings: a row whose account the user chose not to import, a row whose account has no mapping decision
# yet, a row we already hold (routine — the incremental overlap re-asks for recent days on purpose, so it
# is non-zero on every top-up), and a zero-amount row the provider's declared policy refuses. Summed into
# one figure it would cry wolf on every sync; kept apart, each reaches the surface that can act on it.
#
# **Nothing stores the sums.** They are added up wherever they are needed — the log row keeps the buckets
# and derives on read, and the card keeps its own totals in the CSV import vocabulary. A stored sum beside
# the thing it sums is what forced the sync log's zero-amount count to be recovered by subtraction in the
# browser, which in turn made every new bucket a breaking change.
def _bump(tally: dict | None, subject: str, key: str) -> None:
    if tally is None:
        return
    tally.setdefault(subject, Counter())[key] += 1


def _add_advisory(store: dict | None, message: str, *, count: int = 1, context: str | None = None) -> None:
    """Fold an advisory into a connection's running set, keyed on the message so the same remark from many
    requests is one entry with a count rather than many near-identical ones. The first `context` wins: it
    names a concrete request to go look at, and unlike a list it does not grow with the pull. Mirrors
    `_merge_advisories` in the SimpleFIN adapter, which does the same for one adapter's own windows."""
    if store is None or not message:
        return
    slot = store.get(message)
    if slot is None:
        store[message] = {"message": message, "count": count, "context": context}
    else:
        slot["count"] += count
        if slot.get("context") is None:
            slot["context"] = context


# How much of a resume token's value may be shown before it is elided. Anything longer than a date, a
# count, or a short status is assumed to be the opaque part and is never printed.
_FINGERPRINT_VALUE_CHARS = 24


def _cursor_fingerprint(cursor: str | None) -> str | None:
    """A short, non-reversible marker for a provider's resume token, so the log can show whether it was
    present and whether it advanced without persisting the token itself.

    Two shapes, because `transactions_cursor` holds two different things. Plaid's is an **opaque** paging
    token, where a length plus a leading slice is the only marker available and reads fine. A provider with
    no change feed stores its own **JSON checkpoint** there instead (see the SimpleFIN adapter), and slicing
    that yields `{"throug` — meaningless, and looking for all the world like a truncation bug, while hiding
    the fact actually worth having: how far the walk has reached. A checkpoint is therefore summarized as
    its own short scalars. What a metered provider has *spent* is not here and never was a cursor fact — it
    lives in `provider_request_budget`, which persists under the opposite rule (see the column comment).

    Values longer than `_FINGERPRINT_VALUE_CHARS` are elided rather than printed: a JSON token is not
    automatically non-secret just because it parses, so the "never store the whole token" rule holds for
    both shapes.
    """
    if not cursor:
        return None
    try:
        parsed = json.loads(cursor)
    except (TypeError, ValueError):
        parsed = None
    if not isinstance(parsed, dict):
        return f"len={len(cursor)}·{cursor[:8]}"
    parts = []
    for key, value in parsed.items():
        if not isinstance(value, (str, int, float, bool)):
            continue  # a nested structure has nothing short to say about itself
        text = str(value)
        parts.append(f"{key}={text}" if len(text) <= _FINGERPRINT_VALUE_CHARS else f"{key}=…")
    return ", ".join(parts) if parts else f"len={len(cursor)}"


def _card_counts(conn, card_added: dict, baseline: dict) -> list[dict]:
    """What this connection's pull wrote, per import card.

    `added` is one number for a whole call, but a sync files each row under its **own transaction month**,
    so one pull routinely lands on two or three cards — while the history page shows one card at a time. A
    total that reconciles against no card on screen reads as rows having gone missing, and the only way to
    tell that story straight is to name the cards and what each received.

    Differenced against a baseline snapshot rather than read directly, because the tallies accumulate across
    every connection in the call and this row describes one of them."""
    out = []
    for card_id, n in card_added.items():
        delta = n - baseline.get(card_id, 0)
        if delta <= 0:
            continue
        row = conn.execute(
            "SELECT filename, imported_at FROM import_batch WHERE id = ?", (card_id,)).fetchone()
        # The filename is the card's user-visible label ("SimpleFIN Bridge · August 2026"), which is the
        # whole point: this has to be matchable by eye against the history page. The id is a last resort for
        # a card deleted between the write and the read.
        #
        # `id`/`imported_at` ride along for the connection card's summary, which opens these cards directly
        # in the shared import-card ledger rather than sending the user to the history page to find them.
        # `imported_at` is the CARD's creation — when its month first received rows — not this sync's time:
        # a monthly card outlives the pull that opens it, and the ledger's header states the card's own age.
        out.append({
            "card":        row["filename"] if row else card_id,
            "added":       delta,
            "id":          card_id,
            "imported_at": row["imported_at"] if row else None,
        })
    return sorted(out, key=lambda c: (-c["added"], c["card"]))


def _write_sync_diagnostics(conn, rows: list[dict]) -> None:
    """Persist this sync's per-connection diagnostic rows and prune to the retention window.

    Written on every sync, not only under developer options — see the call site for why. Never lets a
    logging failure affect the sync itself.

    This table is a **diagnostic ring buffer**: capped at `_SYNC_LOG_RETENTION`, pruned on every write and
    emptied wholesale by `DELETE /sync/diagnostics`. Nothing user-facing may derive from it, because all
    three of those can remove the row it would be reading. The connection card's own summary lives on
    `connection` for exactly that reason (`services/providers/config.py`); this row is what a *developer*
    reads to explain a pull after the fact.
    """
    for r in rows:
        conn.execute(
            """
            INSERT INTO connection_sync_log
                (id, connection_id, provider, institution, started_at, finished_at, mode, days_requested,
                 cursor_before, cursor_after, pages, added, updated, removed, skipped, status_sequence,
                 final_status, became_complete, error, warnings, advisories,
                 skipped_no_account, skipped_already_held, account_counts, card_counts, requested_windows,
                 request_allowance)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                str(uuid.uuid4()), r["connection_id"], r["provider"], r["institution"], r["started_at"],
                r["finished_at"], r["mode"], r["days_requested"], r["cursor_before"], r["cursor_after"],
                r["pages"], r["added"], r["updated"], r["removed"], r["skipped"],
                json.dumps(r["status_sequence"]), r["final_status"], 1 if r["became_complete"] else 0,
                r["error"],
                # Stated at the insert rather than left to a column default: the ALTER that added these to
                # an existing database carries no default, so every write has to supply the value.
                json.dumps(r["warnings"]) if r.get("warnings") else None,
                json.dumps(r["advisories"]) if r.get("advisories") else None,
                # Vestigial, written 0 and read by nothing. They held sums of `account_counts` — a column
                # summarizing another column in the same row — which is the shape this restructure exists
                # to remove; the breakdown is derived on read by `_skipped_breakdown` instead. Still
                # supplied rather than dropped from the INSERT because they are NOT NULL, and still
                # present rather than dropped from the table because a DDL rebuild of a prunable buffer
                # is the riskiest, least valuable step available here.
                0,
                0,
                json.dumps(r["account_counts"]) if r.get("account_counts") else None,
                json.dumps(r["card_counts"]) if r.get("card_counts") else None,
                json.dumps(r["requested_windows"]) if r.get("requested_windows") else None,
                json.dumps(r["request_allowance"]) if r.get("request_allowance") else None,
            ),
        )
    conn.execute(
        """
        DELETE FROM connection_sync_log
        WHERE id NOT IN (
            SELECT id FROM connection_sync_log ORDER BY started_at DESC, id DESC LIMIT ?
        )
        """,
        (_SYNC_LOG_RETENTION,),
    )


def record_sync_duplicate(conn, *, batch_id: str, txn: dict, merchant_name, content_hash: str,
                          evidence_json, verdict, account_id: str, source_label: str) -> None:
    """Persist a hard-rejected synced row into its card's duplicate report, through the *same* writer a
    CSV import uses — so the existing per-batch report, "Import anyway", and Restore all work on a sync
    card with no changes.

    `row_number` is a running per-batch ordinal rather than a file line: a sync has no lines, but the
    column is half the report's primary key, so arrivals are counted instead.
    """
    # Lazy, like `make_hash` above: core.py pulls in many services, so it is imported only when a sync
    # actually has a duplicate to record.
    from backend.routers.import_export.core import save_batch_duplicate_rows

    next_row = int(conn.execute(
        "SELECT COALESCE(MAX(row_number), 0) + 1 AS n FROM import_batch_duplicate WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()["n"])
    save_batch_duplicate_rows(conn, batch_id, [{
        "row": next_row,
        "reason": verdict.reason,
        # `values` is what the report shows as "the row that was rejected". A CSV puts its raw columns
        # here; a sync has no columns, so it puts the fields the provider actually supplied.
        "values": {
            "Account": source_label,
            "Date": txn["date"],
            "Amount": txn["amount"],
            "Description": txn["raw_name"] or "",
            **({"Transaction date": txn["authorized_date"]} if txn.get("authorized_date") else {}),
        },
        "matched_transaction": verdict.matched or {},
        # Enough to re-materialize the row if the user imports it anyway.
        "txn_payload": {
            "account_id": account_id,
            "date": txn["date"],
            "authorized_date": txn.get("authorized_date"),
            "amount": txn["amount"],
            "merchant_name": merchant_name,
            "raw_name": txn["raw_name"],
            "content_hash": content_hash,
            "import_evidence_json": evidence_json,
            "external_transaction_id": txn["external_transaction_id"],
            "display_name_source": "import",
        },
    }])


# The columns a synced rejected row is shown under. A CSV names the file's own headers here; a sync has
# none, so it publishes the same four fields `record_sync_duplicate` reports a rejected duplicate with —
# one vocabulary for both reports, and the dialog renders them without knowing which produced it.
_SYNC_REJECTED_HEADERS = ["Date", "Description", "Account", "Amount"]

# Matches the CSV importer's own cap: the report is a sample that shows the user *what kind* of row was
# refused, not a second copy of the feed.
_MAX_REJECTED_ROWS = 20


def record_sync_zero_amount_rejection(conn, *, batch_id: str, txn: dict, source_label: str) -> None:
    """File a refused $0 row onto its card's rejected-row report, in the shape CSV import already writes.

    The counts **accumulate** rather than being written once. A CSV summarizes one file at the end of one
    import; a monthly sync period card is added to by every top-up for the rest of the month, so a summary
    that overwrote would silently reset the count on each sync and report only the latest one's rejects.
    """
    # Lazy for the same reason `record_sync_duplicate` is: core.py pulls in many services, and the key is
    # taken from it rather than restated here so the two reports cannot drift onto different snapshot keys.
    from backend.routers.import_export.core import IMPORT_SUMMARY_KEY

    snapshot = _card_config_snapshot(conn, batch_id)
    summary = snapshot.get(IMPORT_SUMMARY_KEY) or {}

    rejected_rows = list(summary.get("rejected_rows") or [])
    if len(rejected_rows) < _MAX_REJECTED_ROWS:
        rejected_rows.append({
            # A running ordinal, not a file line — the same substitution `record_sync_duplicate` makes,
            # and for the same reason: a sync has no lines but the report is keyed by row.
            "row": int(summary.get("zero_amount_count") or 0) + 1,
            "kind": ZERO_AMOUNT_REJECTION_KIND,
            "reason": ZERO_AMOUNT_REJECTION_REASON,
            "values": {
                "Date": txn["date"],
                "Description": txn["raw_name"] or txn.get("merchant_name") or "",
                "Account": source_label,
                "Amount": txn["amount"],
            },
        })

    zero_amount_count = int(summary.get("zero_amount_count") or 0) + 1
    validation_error_count = int(summary.get("validation_error_count") or 0)
    summary.update({
        "zero_amount_count": zero_amount_count,
        "validation_error_count": validation_error_count,
        "rejected_count": zero_amount_count + validation_error_count,
        "rejected_rows": rejected_rows,
        "rejected_headers": _SYNC_REJECTED_HEADERS,
    })
    snapshot[IMPORT_SUMMARY_KEY] = summary
    conn.execute("UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                 (json.dumps(snapshot), batch_id))


def record_sync_card_totals(conn, *, batch_id: str, imported: int, deduped: int,
                            account_skipped: int, rejected: int) -> None:
    """Fold one sync's contribution into a card's headline `import_summary` counts.

    A sync card is the same kind of record as a file card — "here is a bundle of transactions and where
    each one went" — so it reports in the same vocabulary rather than a sync-specific one. Every key here
    already exists on a CSV card (`core.py`, `_finalize_import`), and `account_skipped_count` in
    particular already means exactly what a sync's no-destination rows are: rows dropped because the
    account they name has nowhere to go. Writing a parallel set of sync-only counters was what left the
    two cards answering the same question in two different dialects, with `summarizeImportOutcome` papering
    over the difference by reconstructing the missing figures from whatever it could find.

    **Accumulates, never overwrites.** A monthly period card is added to by every top-up for the rest of
    the month, so a summary written whole would report only the latest sync's figures — the same reason
    `record_sync_zero_amount_rejection` accumulates, and the totals are re-derived from the accumulated
    values rather than added to independently so they cannot drift from their own parts.

    `rejected` counts refused rows toward `skipped_count` only. The rejected-row report itself — the
    count, the rows, the headers — belongs to `record_sync_zero_amount_rejection`, which is the writer
    that has the row in hand; splitting one summary between two writers is safe precisely because they
    own disjoint keys.
    """
    from backend.routers.import_export.core import IMPORT_SUMMARY_KEY

    snapshot = _card_config_snapshot(conn, batch_id)
    summary = snapshot.get(IMPORT_SUMMARY_KEY) or {}
    imported_count = int(summary.get("imported_count") or 0) + imported
    deduped_count = int(summary.get("deduped_count") or 0) + deduped
    account_skipped_count = int(summary.get("account_skipped_count") or 0) + account_skipped
    skipped_count = int(summary.get("skipped_count") or 0) + account_skipped + rejected
    summary.update({
        "imported_count": imported_count,
        "deduped_count": deduped_count,
        "account_skipped_count": account_skipped_count,
        "skipped_count": skipped_count,
        "total_rows": imported_count + skipped_count + deduped_count,
    })
    snapshot[IMPORT_SUMMARY_KEY] = summary
    conn.execute("UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                 (json.dumps(snapshot), batch_id))


def _card_config_snapshot(conn, batch_id: str) -> dict:
    """A card's `config_snapshot` as a dict. The card's identity markers (`initial_backfill`,
    `sync_period`) live in the same blob and are resolved by `json_extract`, so it is read and rewritten
    whole rather than replaced — dropping them would orphan the card from its own lookup."""
    row = conn.execute("SELECT config_snapshot FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
    if not row or not row["config_snapshot"]:
        return {}
    try:
        snapshot = json.loads(row["config_snapshot"])
    except (TypeError, ValueError):
        return {}
    return snapshot if isinstance(snapshot, dict) else {}


def _record_sync_success(conn, connection_id: str, warnings: list) -> None:
    """Stamp a successful pull, and clear the failure state it disproves.

    `last_synced_at` records only *successful* pulls, so a connection erroring for a week honestly reads
    as stale rather than looking freshly synced because something was attempted. `consecutive_failures`
    resets here rather than being decremented: what the UI needs to distinguish is a one-off blip from a
    connection that has stopped working, and a single success settles that question.

    `last_sync_warnings` is replaced, never appended to — it describes the most recent pull. A bank that
    fixed its login should stop being reported the moment it delivers, without anyone dismissing anything.
    `reauth_required` clears for the same reason: a pull that returned data is proof the credential works,
    whatever was true before it.
    """
    conn.execute(
        """
        UPDATE connection
        SET    last_synced_at = ?, last_sync_error = NULL, last_sync_error_at = NULL,
               consecutive_sync_failures = 0, last_sync_warnings = ?, reauth_required = 0
        WHERE  id = ?
        """,
        (_utcnow_iso(), json.dumps(warnings) if warnings else None, connection_id),
    )


def _record_connection_last_sync(conn, entry: dict) -> None:
    """Store what this call did on the **connection**, from the same facts the log row is built from.

    The connection card reads this; `connection_sync_log` is a diagnostic that may be pruned or cleared at
    any moment, and a user-facing summary cannot rest on something a debugging action deletes. Fed the
    already-assembled diagnostic dict rather than the individual figures precisely so the two records
    cannot disagree about one call — the guarantee the card and the log had when both read the log row,
    kept now that only one of them does.

    Only the facts a card renders are kept. Everything else the pull knows — cursor fingerprints, request
    windows, the allowance it left behind, the status sequence — is diagnostic, belongs to the log, and is
    deliberately not copied here.
    """
    accounts = entry.get("account_counts") or {}
    # Computed once, here, and stored beside the outcome it decided. The card renders its chip from this
    # number and the outcome pill comes from the same call, so the two surfaces cannot disagree — they did,
    # for exactly as long as each re-derived the judgement from `mode`.
    unexplained = unexplained_already_held(accounts=accounts, cursor_before=entry.get("cursor_before"))
    outcome = sync_outcome(
        error=entry.get("error"), mode=entry.get("mode"),
        already_held=unexplained, became_complete=bool(entry.get("became_complete")),
    )
    # The cards this pull wrote to, so the connection card can open the import ledger in place. Kept as a
    # list because ONE pull routinely writes to two cards: a sync files each row under its own transaction
    # month, so for a few days after a rollover the tail of last month arrives alongside this month.
    cards = [
        {"id": c["id"], "label": c["card"], "added": c["added"], "imported_at": c.get("imported_at")}
        for c in (entry.get("card_counts") or []) if c.get("id")
    ]
    # The rows this pull added or revised, so the ledger can be scoped to "what just arrived" and the user
    # can categorize them where they are standing. Dropped wholesale past the cap rather than truncated: a
    # partial list is a report that quietly lies about its own extent, and the card it falls back to is the
    # better answer at that size anyway (see `_SCOPED_SYNC_ROW_CAP`).
    #
    # Deliberately NOT copied to `connection_sync_log`. That table is a 500-row ring buffer, so the ids
    # would be retained 500 times over for a report only the newest pull can serve; and a user-facing
    # report may not rest on something `DELETE /sync/diagnostics` erases — the same reason the outcome
    # word lives here rather than being derived from the log.
    #
    # Deduped: a walking adapter's overlapping pages can add a row and then revise it within one call, so
    # the same id reaches `touched_ids` twice. `dict.fromkeys` keeps arrival order, which is the order the
    # rows are most usefully read in.
    row_ids = list(dict.fromkeys(entry.get("row_ids") or []))
    summary = {
        "at":       entry.get("started_at"),
        "mode":     entry.get("mode"),
        "added":    entry.get("added") or 0,
        "updated":  entry.get("updated") or 0,
        "removed":  entry.get("removed") or 0,
        "accounts": accounts,
        # The one figure the card's "Already imported" chip is allowed to warn on. Stored rather than
        # re-derived because the card reads this summary and nothing else: it has no cursor, no per-call
        # row set, and no way to tell routine overlap from a collision on its own.
        "already_held_unexplained": unexplained,
        "cards":    cards,
        "row_ids":  row_ids if len(row_ids) <= _SCOPED_SYNC_ROW_CAP else None,
    }
    conn.execute(
        "UPDATE connection SET last_sync_outcome = ?, last_sync_summary = ? WHERE id = ?",
        (outcome, json.dumps(summary), entry["connection_id"]),
    )


def _record_sync_failure(conn, connection_id: str, message: str, *, reauth_required: bool = False) -> None:
    """Count a failed pull. `last_synced_at` is deliberately untouched — it is the freshness of the data,
    not the time of the last attempt — so the pair together says "last good data at X, failing since
    then, N times running", which is what the card needs to show without anyone opening it.

    `reauth_required` marks the one failure retrying cannot fix: the provider has stopped accepting the
    stored credential. It is kept apart from the failure *count* because they answer different questions —
    the count says how long something has been wrong, this says the user has to do something, and only one
    of the two can be acted on. Sticky until a pull succeeds (`_record_sync_success` clears it), so it
    survives the network errors that will follow it.
    """
    conn.execute(
        """
        UPDATE connection
        SET    last_sync_error = ?, last_sync_error_at = ?,
               consecutive_sync_failures = COALESCE(consecutive_sync_failures, 0) + 1,
               reauth_required = CASE WHEN ? THEN 1 ELSE reauth_required END
        WHERE  id = ?
        """,
        (str(message)[:500], _utcnow_iso(), 1 if reauth_required else 0, connection_id),
    )


def _currency_warnings(conn, connection_id: str, unsupported: dict, ledger_currency: str,
                       advisories: dict | None = None) -> list[str]:
    """Tell the user about mapped accounts whose transactions cannot be imported for their currency.

    Driven primarily by the **stored** `provider_currency`, recorded when the connection listed its
    accounts, rather than by what this particular pull happened to discard. The adapter's report
    (`unsupported`) is merged in but cannot be the source on its own: the walk narrows a request to a
    single account whenever only one still wants history, so an account excluded from that filter is simply
    absent from the response and nothing was discarded *this time*. A warning that appears or not depending
    on the shape of an unrelated fetch is worse than one that always appears — the user cannot tell whether
    its absence means the problem went away.

    Only mapped accounts produce a message. An unmapped or skipped provider account's rows are dropped
    regardless of currency, so there is nothing here its owner has lost and nothing to decide; those go to
    the log, which is where the question "why is this account empty" gets answered. A **mapped** account is
    the opposite case: the user asked for it, and it will sit permanently empty with nothing to say why.

    `advisories` is that log. The unmapped case used to reach the server console only, which answered the
    question for whoever could read the console and nobody else; it now also lands in the sync card's
    record. The card/log split is unchanged — this is still not a message, because there is still nothing
    for the user to act on — but "not worth a card" was never a reason to leave it unrecorded.
    """
    rows = conn.execute(
        """
        SELECT external_account_id, provider_name, provider_currency, mapping_mode, account_id
        FROM   connection_account WHERE connection_id = ?
        """,
        (connection_id,),
    ).fetchall()
    messages, unmapped = [], []
    for r in rows:
        external_account_id = r["external_account_id"]
        # The stored currency where there is one, the pull's own finding otherwise — which covers an
        # account discovered mid-sync, or one whose stored value predates the column.
        currency = (r["provider_currency"] or "").strip() or unsupported.get(external_account_id)
        if not currency or currency_matches(ledger_currency, currency):
            continue
        if r["mapping_mode"] in (None, "skip") or not r["account_id"]:
            unmapped.append(f"{external_account_id} ({currency})")
            continue
        messages.append(
            f"{r['provider_name'] or external_account_id} is held in {currency}, so its transactions "
            f"were not imported — every amount in Luma is {ledger_currency}."
        )
    if unmapped:
        detail = (
            f"Unmapped non-{ledger_currency} accounts, nothing imported: {', '.join(unmapped)}"
        )
        log_warning(f"[sync] connection {connection_id}: {detail}")
        _add_advisory(advisories, detail)
    return messages


def _build_account_targets(conn, connection, *, target_start: date, ledger_currency: str) -> list[dict]:
    """Which of a connection's accounts still want older data, and how far back each needs to go.

    This is the whole of the history decision, and it lives here because the database is here. An account
    is a target unless it is already known to have **no** older data (`history_complete`) or its coverage
    already reaches the requested depth. Each target carries its own `reached` and `empty_streak`, so a pull
    resumes each account exactly where that account stopped — one further along does not re-fetch what it
    holds while another catches up.

    An account that joined the connection later needs nothing special: it simply has no coverage, so it is
    a target like any other. That is what makes a separate catch-up mechanism unnecessary.

    An account denominated in a currency the ledger cannot hold is excluded, and the exclusion has to be
    here rather than left to the adapter's drop. A target that can never receive rows would spend requests
    walking a history it discards, and — worse — would come back with `coverage_start_date` set and its
    empty-window streak climbing to `history_complete`, both of which assert the account has no data over a
    range where it plainly does. That is the over-claim shape that makes duplicate detection hard-reject
    genuine transactions later (`docs/data-model.md`). No target means no coverage claim, which is the
    honest record: nothing was fetched for it, so nothing is claimed about it.
    """
    rows = conn.execute(
        """
        SELECT external_account_id, coverage_start_date, history_complete, history_empty_streak,
               provider_currency
        FROM   connection_account
        WHERE  connection_id = ? AND mapping_mode IS NOT NULL AND mapping_mode != 'skip'
               AND account_id IS NOT NULL
        """,
        (connection["id"],),
    ).fetchall()
    targets = []
    for r in rows:
        if r["history_complete"] or not currency_matches(ledger_currency, r["provider_currency"]):
            continue
        reached = r["coverage_start_date"]
        if reached and reached <= target_start.isoformat():
            continue
        targets.append({
            "external_account_id": r["external_account_id"],
            "from_date":    target_start.isoformat(),
            "reached":      reached,
            "empty_streak": r["history_empty_streak"] or 0,
        })
    return targets


def _record_sync_coverage(conn, connection, *, is_range_pull: bool, requested_start: date | None,
                          synced_accounts: dict, account_coverage: dict | None = None) -> None:
    """Advance the connection's coverage claim after a successful pull.

    The claim belongs to the *chain*, not to any card: `transactions_cursor` + `initial_sync_complete`
    together assert "every change the provider has reported, back to the backfill window, is in the
    ledger". A **range pull** (the initial backfill, or Fetch more history) establishes or extends
    `coverage_start_date` backward; a **delta** only advances `coverage_through_date`. A failed sync calls
    none of this, so its coverage simply stops advancing — self-correcting, with no staleness flag.

    `account_coverage` is what the adapter reports **per account**, and where it is present it governs:
    each account records the date that account actually reached, and only accounts the pull touched are
    written at all. Both halves matter. A single figure spread across every account over-claims the moment
    a pull covers some and not others, and coverage that overstates itself makes duplicate detection
    hard-reject genuine transactions — a later CSV import of that period discarded as duplicates of rows
    nothing ever fetched. Absent (a cursor provider), the requested depth applies to everything synced,
    which for that provider is accurate: it maintains one window across the whole item.
    """
    today = date.today().isoformat()
    if account_coverage is not None:
        for external_account_id, reported in account_coverage.items():
            conn.execute(
                """
                UPDATE connection_account
                SET    coverage_start_date = CASE
                           WHEN coverage_start_date IS NULL OR coverage_start_date > ?
                           THEN ? ELSE coverage_start_date END,
                       coverage_through_date = ?,
                       history_complete = ?,
                       history_empty_streak = ?
                WHERE  connection_id = ? AND external_account_id = ?
                """,
                (reported["reached"], reported["reached"], today,
                 1 if reported.get("complete") else 0, reported.get("empty_streak", 0),
                 connection["id"], external_account_id),
            )
        # A pull routinely touches accounts the walk had nothing to say about: once every account's history
        # is complete there is no walk left, yet the recent top-up still fetched current rows for all of
        # them. Their trailing edge advanced even though their start did not, and only the trailing edge is
        # written here — extending a claim that was never established is what over-claims.
        for external_account_id in synced_accounts:
            if external_account_id in account_coverage:
                continue
            conn.execute(
                """
                UPDATE connection_account
                SET    coverage_through_date = ?
                WHERE  connection_id = ? AND external_account_id = ?
                  AND  coverage_start_date IS NOT NULL
                """,
                (today, connection["id"], external_account_id),
            )
        return
    for external_account_id in synced_accounts:
        if is_range_pull and requested_start:
            conn.execute(
                """
                UPDATE connection_account
                SET    coverage_start_date = CASE
                           WHEN coverage_start_date IS NULL OR coverage_start_date > ?
                           THEN ? ELSE coverage_start_date END,
                       coverage_through_date = ?
                WHERE  connection_id = ? AND external_account_id = ?
                """,
                (requested_start.isoformat(), requested_start.isoformat(), today,
                 connection["id"], external_account_id),
            )
        else:
            # A delta extends the trailing edge only where a range pull already established a start;
            # without one there is no claim to extend.
            conn.execute(
                """
                UPDATE connection_account
                SET    coverage_through_date = ?
                WHERE  connection_id = ? AND external_account_id = ?
                  AND  coverage_start_date IS NOT NULL
                """,
                (today, connection["id"], external_account_id),
            )


@router.post("")
def run_sync(days: int = 0, connection_id: str = None, provider: str = None,
             full_history: bool = False, request: Request = None):
    """Announce the run, do it, and always take the announcement back down.

    The marker is set and cleared **outside** the pull's own transaction, and the bracket is a `finally`
    rather than a trailing line: a sync that raises must not leave every connection it touched looking
    permanently busy, which would disable "Sync now" until the staleness bound expired — a worse failure
    than the concurrent sync the marker exists to prevent.
    """
    # Demo data blocks bringing new data in, and a sync is the most direct form of it. Nothing should be
    # able to reach here with the marker set — a demo tenant cannot have had a connection to begin with,
    # and the paths that could create one are all refused — so this is the backstop for that reasoning
    # rather than a live case, and it belongs beside the other four gates instead of being the one
    # new-data path that assumed it could never happen.
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before syncing a data source.",
            })
        require_no_pending_restore(conn, "syncing a data source")

    marked = _connections_in_scope(connection_id, provider)
    set_sync_running(marked, True)
    try:
        return _run_sync(days=days, connection_id=connection_id, provider=provider,
                         full_history=full_history, request=request)
    finally:
        set_sync_running(marked, False)


def _connections_in_scope(connection_id: str | None, provider: str | None) -> list[str]:
    """The connection ids this call will touch. Read in its own short transaction, before the pull opens
    the long one — the ids are needed to announce the run, and the pull's own connection cannot publish
    anything until it commits."""
    where, params = "", []
    if connection_id:
        where, params = "WHERE id = ?", [connection_id]
    elif provider:
        where, params = "WHERE provider = ?", [provider]
    with get_db() as conn:
        return [r["id"] for r in conn.execute(f"SELECT id FROM connection {where}", params).fetchall()]


def _run_sync(days: int = 0, connection_id: str = None, provider: str = None,
              full_history: bool = False, request: Request = None):
    # `days` is the provider fetch depth (`days_requested`): <= 0 means "as far back as this provider
    # goes", a positive value bounds it (the user's shallower window). `connection_id` scopes the sync to
    # one connection so a just-connected bank's backfill doesn't re-pull the others; `provider` scopes it to
    # one data source, which matters once a metered provider is connected alongside an unmetered one —
    # syncing one card should not spend another provider's request budget.
    #
    # `full_history` distinguishes "fetch everything available" (the initial backfill, and Fetch more
    # history) from a routine top-up. They were previously told apart by `days <= 0`, which both send, so a
    # routine sync looked like a deep range pull: harmless for a cursor provider whose maintained window
    # really does span that range, but for a range-pull provider it is both a false coverage claim and a
    # re-fetch of the whole history on every sync.
    added = updated = removed = skipped = deduped = discovered = 0
    touched_ids: list[str] = []  # rows this sync added or advanced — the scope for the recurring rescan
    cards_touched: set[str] = set()          # cards that received added rows (for the post-sync dedup sweep)
    card_added: dict[str, int] = {}          # card_id -> rows added this call
    # card_id -> the ids of the rows added this call. The duplicate sweep is told exactly these, because a
    # connection's first backfill files every call into ONE card: swept by card, each resumption re-examines
    # everything imported so far to check what this call added, and the cost climbs with the card.
    card_added_ids: dict[str, list[str]] = {}
    # Every row id this call inserted. A walking adapter drains pages whose windows overlap, so page 3
    # routinely re-offers what page 1 just imported; without this the call cannot tell its own work from
    # rows that were in the ledger before it started, and only the latter mean anything is wrong.
    inserted_ids: set[str] = set()
    card_dupes: dict[str, int] = {}          # card_id -> rows hard-rejected as duplicates this call
    # (card_id, csv_value) -> {account_id, count, skipped}. `count` is rows that landed, `skipped` is rows
    # dropped for having no local account to land in; a source value is one or the other within a sync,
    # but a card outlives a sync and can see both once an account is mapped after the fact.
    card_accounts: dict[tuple[str, str], dict] = {}
    # card_id -> Counter of the skip buckets attributable to that card, for its headline totals. Only the
    # skips a card can *report* are here: a dropped row is nowhere else, and a refused zero-amount row is
    # on the card's rejected report, but an already-held row is in the ledger already and the card would
    # only be restating the transaction list (see `_insert_added`).
    card_skipped: dict[str, Counter] = {}
    synced_statuses: list = []               # each synced connection's final update_status
    more_to_poll: list[bool] = []            # per connection: is there more to deliver by polling now?
    paused: list[dict] = []                  # connections that stopped early and will resume on a later sync
    warned: list[dict] = []                  # connections that synced but reported a partial problem
    sync_diagnostics: list[dict] = []        # per-connection diagnostic rows, persisted at the end of the run

    _SELECT_CONNECTIONS = (
        "SELECT id, provider, external_id, credential, credential_enc, institution, "
        "transactions_cursor, initial_sync_complete, provider_request_budget FROM connection"
    )

    with get_db() as conn:
        if connection_id:
            connections = conn.execute(f"{_SELECT_CONNECTIONS} WHERE id = ?", (connection_id,)).fetchall()
        elif provider:
            connections = conn.execute(f"{_SELECT_CONNECTIONS} WHERE provider = ?", (provider,)).fetchall()
        else:
            connections = conn.execute(_SELECT_CONNECTIONS).fetchall()

        # Syncing decrypts each connection's credential under the workspace DEK, so the vault must be
        # unlocked. Fail the whole sync up front rather than silently skipping every connection in the loop.
        if connections and not crypto_service.is_unlocked(request.state.user["id"]):
            raise HTTPException(status_code=423, detail={
                "code": "vault_locked",
                "message": "Unlock the vault to sync.",
            })

        # Lazy import: content_hash uses the same helper CSV import does, kept as the single source of truth.
        # core.py is heavy and imports many services, so pull it in only when a sync actually runs.
        from backend.routers.import_export.core import make_hash

        # Rules are stable across a sync; load once for the per-transaction matcher below.
        rules = load_categorization_rules(conn)
        rule_tags_by_id = load_rule_tags_by_id(conn)
        # A sync captures the same evidence shape an import does (`capture_fields`), so a
        # `match_source_text` rule has to see it here too — otherwise such a rule reaches synced rows only
        # on a later recategorize pass, and the same rule behaves differently by how the row arrived. The
        # parse is gated on a source-text rule actually existing, matching `recategorize_all`, so a ledger
        # with none pays nothing.
        needs_source_text = any(rule["match_source_text"] for rule in rules)

        def _account_for(external_account_id):
            return conn.execute(
                "SELECT id, owner_id FROM account WHERE external_account_id = ?",
                (external_account_id,),
            ).fetchone()

        def _discover_new_provider_accounts(connection, adapter, app_config, credential, seen_unknown,
                                            connection_advisories) -> int:
            """Record provider accounts that showed up in the data but that this connection has never
            offered — the case of an account added on the provider's side after the connection was built.

            Sync never asks a provider what accounts it has; it matches incoming transactions to accounts
            by external id. So without this, an account added later is invisible: its transactions match
            nothing, are counted as skipped, and are dropped, with no badge and no row to explain it.

            The guard is `connection_account`, **not** whether a local account exists. Those differ in
            exactly the case that matters: a provider account the user chose to `skip` has a row but no
            local account, so keying off the account would re-fetch the provider's list on every sync
            forever. Keyed off the row, the fetch happens once per genuinely new account.

            Deliberately stops at *recording*. The mapping decision is the user's — auto-creating a local
            account is the behaviour `services/connection_mapping.py` exists to replace, and it is what
            duplicate detection needs stated rather than guessed.
            """
            if not seen_unknown:
                return 0
            known = {
                r["external_account_id"] for r in conn.execute(
                    "SELECT external_account_id FROM connection_account WHERE connection_id = ?",
                    (connection["id"],),
                )
            }
            if not (seen_unknown - known):
                return 0
            # One extra request, and only when an unfamiliar account actually appears. Not metered against
            # a provider's request budget: doing that would mean threading per-connection state through
            # `fetch_accounts`, which every adapter implements, to bound a call that by construction
            # happens once per new account rather than once per sync.
            offered = adapter.fetch_accounts(app_config, credential)
            record_provider_accounts(conn, connection_id=connection["id"], accounts=offered)
            newly_recorded = {a["external_account_id"] for a in offered} & (seen_unknown - known)
            if newly_recorded:
                # Recorded as well as logged: "the provider started offering an account you have not
                # mapped" is one of the two stock answers to "why did this sync import nothing", and until
                # now it was only ever visible to whoever could read the server console.
                detail = (
                    f"Discovered {len(newly_recorded)} new provider account(s); their transactions are "
                    f"skipped until mapped"
                )
                log_warning(f"[sync] connection {connection['id']}: {detail}")
                _add_advisory(connection_advisories, detail)
            return len(newly_recorded)

        def _refresh_provider_fields(txn_id, t) -> None:
            """Re-stamp the provider-owned fields of a row already held, leaving the user's category,
            display-name and tag edits untouched.

            Shared by the two paths that learn something new about a held row — an explicit `modified`, and
            a pending row the provider re-sends once it has settled — because both revise the same facts
            about the same charge. Keeping the second one narrower than the first was a real defect rather
            than an economy: it flipped `is_pending` alone, so a row whose date could only have come from
            the pending version kept that date permanently, and its `content_hash` went on describing a
            state the provider had already superseded. A provider with no pending→posted pointer reaches
            here rather than through the in-place conversion above, since for it the settled charge is the
            same transaction id, not a new one pointing back."""
            conn.execute(
                """
                UPDATE txn SET amount = ?, date = ?, is_pending = ?, merchant_name = ?, raw_name = ?,
                               content_hash = ?
                WHERE  id = ?
                """,
                (t["amount"], t["date"], 1 if t["is_pending"] else 0, t["merchant_name"], t["raw_name"],
                 make_hash(t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or ""), txn_id),
            )

        def _insert_added(t, get_card, dedupe, seen_unknown=None, tally=None) -> bool:
            """Insert one `added` transaction. `get_card` lazily resolves (and creates) the connection's
            card only when a row is actually inserted, so a no-op sync leaves no empty card. Idempotent on
            provider id: a row we already have advances pending state instead of duplicating.

            `tally` is this connection's per-account bookkeeping (see `_bump`). It is what lets the card
            distinguish the one skip that means data was lost from the two that are routine."""
            nonlocal added, updated, skipped, deduped
            acc = _account_for(t["external_account_id"])
            if not acc:
                skipped += 1
                known = provider_accounts.get(t["external_account_id"]) or {}
                # Split where it is counted, because the two carry opposite meanings and only one is worth
                # a reader's attention. `skip` is a decision the user made and the sync is honouring; every
                # other case — a row awaiting a mapping decision, or an account the provider added since —
                # is a gap, and one the "N to map" badge already reports from `connection_account`. Folding
                # them into a single count is what made a correctly-configured connection report a problem
                # on every sync, permanently, with nothing the user could do to clear it.
                _bump(tally, t["external_account_id"],
                      "skipped_by_choice" if known.get("mapping_mode") == "skip"
                      else "skipped_unknown_account")
                # Noted rather than merely counted: an id with no local account is either an account the
                # user skipped or one the provider has added since — and only the second is worth acting
                # on. `_discover_new_provider_accounts` tells them apart after the page is applied.
                if seen_unknown is not None:
                    seen_unknown.add(t["external_account_id"])
                # Recorded on the card as a skipped source account, in exactly the shape a CSV import
                # writes for a source value the user chose not to map (`was_skipped = 1` plus the row
                # count it dropped). Without this the card lists only the accounts that contributed rows,
                # so a connection's card cannot answer "what arrived and where did it go" the way a file's
                # card already does — the accounts with nothing to show are the ones the question is about.
                #
                # The card is resolved here, which means a pull whose only content is skipped rows still
                # creates one. Same call the zero-amount refusal above makes, for the same reason: a sync
                # that received data and imported none of it has something to tell the user, and a card is
                # the only surface that says so per account.
                #
                # The label falls back to the opaque provider id for an account this connection has never
                # recorded — a provider-side addition, discovered only after the page is applied. That is
                # the honest name: at the moment these rows were dropped, nothing here knew any other.
                card_id = get_card(t["date"])
                entry = card_accounts.setdefault(
                    (card_id, known.get("label") or t["external_account_id"]),
                    {"account_id": None, "count": 0, "skipped": 0},
                )
                entry["skipped"] += 1
                # The card's own headline count, in the CSV vocabulary: `account_skipped_count` already
                # means "rows dropped because their account had no destination" on a file card, and this
                # is the same fact. Both kinds of no-destination row land in it — the card reports what
                # arrived and where it went, and on that question the reason is the per-account chip's
                # business, not the headline's.
                _bump(card_skipped, card_id, "account_skipped")
                return False
            # Refused before any lookup or write, so a $0 row from a rejecting provider never touches
            # ledger state. See the zero-amount invariant in this module's docstring for why the answer
            # differs by provider, and `services/source_capabilities.py` for the rule that decides it.
            # Reported on the card exactly as a rejected CSV row is, rather than silently dropped — which
            # is also why the card is resolved here: a sync whose only content is refusals still has
            # something to tell the user. (Tentative: if an otherwise-empty card proves more noise than
            # signal in practice, suppressing it is the intended alternative — see the doc.)
            if rejects_zero_amount(adapter.zero_amount_rows) and t["amount"] == 0:
                skipped += 1
                # Its own bucket, never folded into the no-destination ones: those are about an account
                # with nowhere to put rows, and a refusal we chose is routine. Rides in `account_counts`.
                _bump(tally, t["external_account_id"], "skipped_zero_amount")
                card_id = get_card(t["date"])
                record_sync_zero_amount_rejection(
                    conn, batch_id=card_id, txn=t,
                    source_label=dedupe.label_by_external.get(
                        t["external_account_id"], t["external_account_id"]),
                )
                # Counted toward the card's `skipped_count` but NOT its `account_skipped_count`: the row's
                # account had a destination, so this is a rejected row, and the card already reports it as
                # one. `record_sync_zero_amount_rejection` keeps the rejected-row half of the summary.
                _bump(card_skipped, card_id, "rejected")
                # Deliberately not added to `cards_touched`: that drives the post-sync duplicate sweep,
                # and nothing was inserted for it to examine.
                return False
            # Pending → posted: this posted transaction supersedes a pending row we already hold. Convert
            # that row in place (new posted id + refreshed provider fields), preserving its category/name
            # edits, tags, card, and identity — rather than trashing the pending (via the matching `removed`)
            # and inserting a fresh posted row. Processing all `added` before all `removed` (below) makes the
            # subsequent removed of the pending id a no-op, since its provider id has changed to the posted one.
            pending_id = t.get("pending_external_transaction_id")
            if pending_id:
                pend = conn.execute(
                    "SELECT id FROM txn WHERE external_transaction_id = ? AND trashed_at IS NULL",
                    (pending_id,),
                ).fetchone()
                if pend:
                    content_hash = make_hash(t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or "")
                    conn.execute(
                        """
                        UPDATE txn SET external_transaction_id = ?, amount = ?, date = ?, is_pending = ?,
                                       merchant_name = ?, raw_name = ?, content_hash = ?
                        WHERE  id = ?
                        """,
                        (t["external_transaction_id"], t["amount"], t["date"], 1 if t["is_pending"] else 0,
                         t["merchant_name"], t["raw_name"], content_hash, pend["id"]),
                    )
                    updated += 1
                    _bump(tally, t["external_account_id"], "updated")
                    touched_ids.append(pend["id"])
                    return False
            existing = conn.execute(
                "SELECT id, is_pending FROM txn WHERE external_transaction_id = ?",
                (t["external_transaction_id"],),
            ).fetchone()
            if existing:
                if existing["is_pending"] and not t["is_pending"]:
                    _refresh_provider_fields(existing["id"], t)
                    updated += 1
                    _bump(tally, t["external_account_id"], "updated")
                    touched_ids.append(existing["id"])
                else:
                    skipped += 1
                    # Routine on a top-up — the incremental overlap re-asks for days already held, so this
                    # is non-zero by design. On an *initial* pull it is a contradiction, and that is the
                    # signal `sync_outcome` reads: nothing can already be held before the first import.
                    #
                    # Deliberately not attributed to a card, and deliberately not allowed to create one.
                    # The other two skips are reported on a card because a card is the only place they
                    # appear at all — a dropped row is nowhere, a refused row is in no ledger. This row IS
                    # in the ledger; a card entry would restate what the transaction list already shows.
                    # It is also the single most routine event a sync has (every top-up re-asks for recent
                    # days on purpose), so resolving a card here would mint an empty one every month.
                    _bump(tally, t["external_account_id"], "skipped_already_held")
                    # Counted apart, not derived by subtraction: `_prior` is the half that was in the
                    # ledger *before this call*, and it is the only half that can mean a transaction-id
                    # collision. The rest is this call re-seeing its own pages. Storing it directly is the
                    # same rule the skip breakdown already follows — a bucket recovered by subtracting the
                    # others is silently corrupted by the next bucket anyone adds.
                    if existing["id"] not in inserted_ids:
                        _bump(tally, t["external_account_id"], "skipped_already_held_prior")
                return False

            # A check number folded into the merchant as "Check #<n>", matching the CSV convention, so
            # the check discriminator can tell two same-amount checks apart on synced rows too.
            merchant_name = t.get("merchant_name")
            if t.get("check_number"):
                merchant_name = f"Check #{t['check_number']}"
            # The fallback is the provider's opaque account id, and it reaching a card means two lookups
            # disagreed: `_account_for` resolved this row to a local account through the durable
            # `account.external_account_id`, while `label_by_external` — built from `connection_account`,
            # per connection — had no entry for it. The row imports correctly either way; only its source
            # label is unreadable, which is why this records rather than refuses.
            #
            # Recorded as an **advisory**, not a warning: advisories are log-only, and this is a developer
            # diagnostic about Luma's own bookkeeping that the user cannot act on — `last_sync_warnings`
            # is shown on the card and must stay for things they can. Observed once on a connection whose
            # `connection_account` rows were missing for reasons that could not be recovered afterwards
            # (the connection was deleted, cascading them away), so this exists to make a recurrence
            # diagnosable rather than to assert a cause.
            source_label = dedupe.label_by_external.get(t["external_account_id"])
            if source_label is None:
                source_label = t["external_account_id"]
                _add_advisory(
                    connection_advisories,
                    "A transaction was imported for a provider account this connection has no record of, "
                    "so its import card shows the raw provider id as the source. The row itself landed in "
                    "the right account.",
                    context=f"external_account_id={t['external_account_id']} account_id={acc['id']}",
                )
            evidence_json = build_sync_evidence(
                t, source_label=source_label, captured_fields=dedupe.captured_fields,
            )
            content_hash = make_hash(t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or "")
            txn_payload = {
                "merchant_name": merchant_name,
                "display_name": merchant_name or t["raw_name"],
                "raw_name": t["raw_name"],
                "import_evidence": json.loads(evidence_json) if evidence_json else None,
            }

            # The same ladder a CSV import runs. Before this, a sync only checked provider-transaction-id
            # idempotence, which by construction can never see a row that arrived from another source —
            # so a charge already imported from a CSV came back as a second copy on a different account.
            verdict = evaluate_duplicate(
                context=dedupe.context,
                receiving_account_id=acc["id"],
                csv_value=source_label,
                content_hash=content_hash,
                parsed_date=t["date"],
                amount=t["amount"],
                scope_id=dedupe.context.scope_id_for(acc["id"], source_label),
                txn_payload=txn_payload,
                authorized_date=t.get("authorized_date"),
            )
            card_id = get_card(t["date"])
            if verdict.hard_reject:
                # Recorded, not discarded: the payload lands in the card's duplicate report where the
                # existing "Import anyway" and Restore actions govern it, exactly as for a CSV.
                record_sync_duplicate(
                    conn, batch_id=card_id, txn=t, merchant_name=merchant_name,
                    content_hash=content_hash, evidence_json=evidence_json, verdict=verdict,
                    account_id=acc["id"], source_label=source_label,
                )
                deduped += 1
                cards_touched.add(card_id)
                card_dupes[card_id] = card_dupes.get(card_id, 0) + 1
                return False

            result = categorize_transaction(
                t["merchant_name"], t["raw_name"], t["merchant_name"], t["amount"], conn,
                owner_id=acc["owner_id"], account_id=acc["id"], rules=rules, rule_tags_by_id=rule_tags_by_id,
                source_text=source_match_text_from_json(evidence_json) if needs_source_text else None,
            )
            cat_id       = result["category_id"] if isinstance(result, dict) else result
            rule_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
            name_effects = rule_scalar_effects(result, fallback_name=merchant_name or t["raw_name"])
            display_name = name_effects["display_name"]
            display_name_source = "rule" if name_effects["renamed_by_rule"] else "import"
            txn_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO txn
                    (id, external_transaction_id, account_id, owner_id, category_id,
                     amount, merchant_name, display_name, raw_name, date, authorized_date, is_pending,
                     display_name_source, content_hash, import_evidence_json, import_batch_id,
                     suspect_duplicate_of, suspect_duplicate_reason, needs_review)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
                """,
                (txn_id, t["external_transaction_id"], acc["id"], acc["owner_id"], cat_id, t["amount"],
                 merchant_name, display_name, t["raw_name"], t["date"], t.get("authorized_date"),
                 1 if t["is_pending"] else 0, display_name_source, content_hash, evidence_json, card_id,
                 verdict.suspect_of if verdict.soft_flag else None,
                 verdict.reason_key if verdict.soft_flag else None),
            )
            sync_rule_tags_for_transaction(conn, txn_id, rule_tag_ids)
            added += 1
            _bump(tally, t["external_account_id"], "added")
            touched_ids.append(txn_id)
            cards_touched.add(card_id)
            card_added[card_id] = card_added.get(card_id, 0) + 1
            card_added_ids.setdefault(card_id, []).append(txn_id)
            inserted_ids.add(txn_id)
            entry = card_accounts.setdefault(
                (card_id, source_label), {"account_id": acc["id"], "count": 0, "skipped": 0})
            entry["account_id"] = acc["id"]
            entry["count"] += 1
            entry.setdefault("dates", set()).add(t["date"])
            return True

        def _apply_modified(t, tally=None) -> None:
            """A provider-side revision to a known transaction: refresh the provider-owned fields and the
            content hash, but leave the user's category and display-name edits intact. A modification for a
            row we don't have locally (outside our window, or dedup-dropped) is ignored."""
            nonlocal updated, skipped
            existing = conn.execute(
                "SELECT id FROM txn WHERE external_transaction_id = ?", (t["external_transaction_id"],),
            ).fetchone()
            if not existing:
                skipped += 1
                # Its own bucket rather than folded into either above: the row is not held and never was
                # (it fell outside our window, or dedupe dropped it), so ignoring the revision is correct
                # and it is neither a blocked import nor a re-fetch.
                _bump(tally, t["external_account_id"], "skipped_not_held")
                return
            _refresh_provider_fields(existing["id"], t)
            updated += 1
            touched_ids.append(existing["id"])

        def _apply_removed(external_transaction_id) -> None:
            """The provider dropped a transaction (a canceled pending charge, or a correction): trash the
            local row so it leaves the active ledger. No-op if we never had it."""
            nonlocal removed
            cur = conn.execute(
                "UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
                "WHERE external_transaction_id = ? AND trashed_at IS NULL",
                (external_transaction_id,),
            )
            removed += cur.rowcount or 0

        for connection in connections:
            initial = not connection["initial_sync_complete"]
            # A RANGE PULL is a call that asked for bounded history and drained it — the first backfill, and
            # equally "Fetch more history" on an already-complete connection. Declared by the caller rather
            # than inferred from `days`, which a routine top-up sends identically.
            is_range_pull = initial or full_history
            cursor = connection["transactions_cursor"]
            # A metered adapter's spend record, handed down mutable and written back in the `finally` below
            # whatever happens to the pull. Unreadable JSON resets to empty rather than failing the sync —
            # the cost is one over-generous allowance, where refusing to sync at all would leave a
            # connection permanently stuck behind a corrupt diagnostic field.
            try:
                request_budget = json.loads(connection["provider_request_budget"] or "{}")
            except (TypeError, ValueError):
                request_budget = {}
            if not isinstance(request_budget, dict):
                request_budget = {}

            def _checkpoint_budget(connection=connection, request_budget=request_budget):
                """Make a debit durable before the request it paid for is issued.

                Called by a metered adapter the moment it spends, never afterwards, because the two
                orderings fail differently and only one of them is survivable. Recording after the request
                loses it on a crash in between, so the count reads *low* and the next sync over-spends a
                limit whose penalty may be the provider cutting the connection off. Recording first can
                only forfeit an allowance nothing used — and this provider's refills, so that heals itself.
                """
                conn.execute(
                    "UPDATE connection SET provider_request_budget = ? WHERE id = ?",
                    (json.dumps(request_budget) if request_budget else None, connection["id"]),
                )
                conn.commit()
            final_status = None
            backfill_complete = True
            resume_later = False
            account_coverage: dict | None = None
            connection_warnings: list[str] = []   # non-fatal provider problems, for the card's badge
            # Everything that is not a failure and not the user's to act on: what the provider said about
            # our own requests, and the sync layer's own "nothing could be imported because…" notices.
            # Counted, because the same remark on every request of a walk means the whole walk, not a blip.
            # Log-only by design — see `_currency_warnings` for why these are not card messages.
            connection_advisories: dict[str, dict] = {}
            # {provider account id: Counter(added/updated/skipped_*)} for this call — see `_bump`.
            account_tally: dict[str, Counter] = {}
            days_requested = ALL_HISTORY_DAYS
            # Per-connection diagnostics: the status sequence across drained pages is what tells whether the
            # historical backfill actually completed or the call stopped at the Initial Update. Count deltas
            # are snapshotted here and differenced after the connection runs.
            started_at = _utcnow_iso()
            cursor_before = connection["transactions_cursor"]
            status_sequence: list = []
            requested_windows: list = []
            # The metered allowance the pull left behind, from whichever page reported last — see
            # `request_allowance` in the adapter contract. The buckets themselves live on `connection` and
            # are overwritten by the next sync, so without this snapshot a paused row can never say how
            # close to the limit it was or when it could resume.
            request_allowance: dict | None = None
            # How far back each account actually reached on THIS call, accumulated across pages. The same
            # figures go to `connection_account`, but that row holds only the current position: it is
            # overwritten every sync, so it can answer "where is this account now" and never "what did that
            # pull achieve". A per-call record needs its own copy.
            account_reach: dict[str, dict] = {}
            pages = 0
            added0, updated0, removed0, skipped0 = added, updated, removed, skipped
            # The card tallies are call-wide and accumulate across connections, so this row's share of them
            # is a difference, exactly as the count deltas above are.
            card_added0 = dict(card_added)
            # Same reason, as a slice rather than a difference: `touched_ids` is append-only within a call,
            # so this connection's share is everything appended from here on.
            touched0 = len(touched_ids)

            def _record(*, error=None, became_complete=False):
                entry = {
                    "connection_id":  connection["id"],
                    "provider":       connection["provider"],
                    "institution":    connection["institution"],
                    "started_at":     started_at,
                    "finished_at":    _utcnow_iso(),
                    "mode":           "initial" if initial else "routine",
                    "days_requested": days_requested,
                    "cursor_before":  _cursor_fingerprint(cursor_before),
                    "cursor_after":   _cursor_fingerprint(cursor),
                    "pages":          pages,
                    "added":          added - added0,
                    "updated":        updated - updated0,
                    "removed":        removed - removed0,
                    "skipped":        skipped - skipped0,
                    "status_sequence": list(status_sequence),
                    "final_status":   final_status,
                    "became_complete": became_complete,
                    "error":          error,
                    # The card shows only `warnings`, and only the most recent pull's. The log keeps both
                    # lists per call, which is what makes "it started failing three syncs ago" answerable.
                    "warnings":       list(connection_warnings),
                    "advisories":     list(connection_advisories.values()),
                    # Row counts per account, merged with the depth each one reached on this call. They are
                    # kept in one structure because they answer one question together: an account with no
                    # rows and no advance is idle, one with no rows but a moved frontier genuinely had
                    # nothing in the window, and telling those apart is the whole point of a per-account
                    # breakdown. Accounts appear here if they had either.
                    #
                    # This is the *only* copy of the skip breakdown. The connection-level totals used to be
                    # stored beside it as their own columns, which is to say the row stored sums of another
                    # column in the same row — and the one bucket that never got a column had to be
                    # reconstructed by subtracting the others in the browser, so adding a bucket silently
                    # corrupted it. Every consumer now sums these on read (`_skipped_breakdown`).
                    "account_counts": {
                        a: {**dict(account_tally.get(a) or {}), **(account_reach.get(a) or {})}
                        for a in {*account_tally, *account_reach}
                    },
                    # See the declaration: the level of a consumable, which nothing else retains.
                    "request_allowance": request_allowance,
                    # Where the rows went, and what was asked for to get them — the two facts a reader needs
                    # to reconcile this row against the history page and against the provider's own limits.
                    "card_counts":      _card_counts(conn, card_added, card_added0),
                    "requested_windows": list(requested_windows),
                    # The rows this connection added or revised, for the connection card's "review what
                    # just arrived" report. `touched_ids` is exactly added + advanced-pending + modified —
                    # the same scope the recurring rescan uses — and deliberately excludes `removed`, which
                    # trashes rows: a report cannot show them, and offering to categorize a row that has
                    # left the ledger would be nonsense. Consumed only by the connection summary; the log
                    # does not store it (see `_record_connection_last_sync`).
                    "row_ids":          touched_ids[touched0:],
                }
                sync_diagnostics.append(entry)
                # The durable half, written now rather than with the log at the end of the run: the log is
                # best-effort and its write is swallowed on failure, while this is what the connection card
                # reads. Both are built from `entry`, so one call can only ever be described one way.
                _record_connection_last_sync(conn, entry)

            # The card is created lazily on the first actually-inserted row (a no-op sync leaves no empty
            # card): the initial historical pull → one "initial import" card; a routine sync (backfill
            # already complete) → the current monthly period card. Defaults bind the per-connection values.
            card_state = {"id": None}

            def _get_card(txn_date=None, connection=connection, initial=initial, card_state=card_state):
                """The card a row belongs on. The initial backfill keeps ONE card for the whole
                historical pull (it is a single user-visible event, not 24 monthly ones); a routine
                delta files each row under its own transaction month, so a card's label matches what it
                holds even when a row arrives after its month has rolled over."""
                if initial:
                    if card_state["id"] is None:
                        card_state["id"] = resolve_initial_sync_batch(conn, connection)
                    return card_state["id"]
                on_date = _parse_txn_date(txn_date) or date.today()
                key = on_date.strftime("%Y-%m")
                if key not in card_state:
                    card_state[key] = resolve_sync_period_batch(conn, connection, on_date)
                return card_state[key]
            try:
                adapter = get_adapter(connection["provider"])
                # Resolved per connection rather than hoisted out of the loop: a sync is a long operation
                # and re-reading is one indexed lookup, whereas a stale value would silently judge later
                # connections against the currency the ledger had when the run started.
                ledger_currency = get_ledger_currency(conn)
                days_requested = _resolve_fetch_depth(adapter, days=days, is_range_pull=is_range_pull)
                dedupe = build_connection_dedupe(conn, connection, adapter)
                # Every provider account's label and mapping decision, including the ones `dedupe` drops.
                # Read alongside it because both are per-connection and both describe source accounts;
                # kept separate because they answer opposite questions — dedupe needs the accounts that
                # have a destination, reporting needs the ones that do not.
                provider_accounts = provider_account_index(conn, connection["id"])
                # A provider with no app-level credential resolves to an empty config rather than a missing
                # one — "unconfigured" is its permanent normal state, not a setup step left undone.
                app_config = {} if not adapter.requires_app_config else resolve_app_config(
                    request.state.user, connection["provider"]
                )
                if app_config is None:
                    message = "This data source has no configured app credentials."
                    log_warning(
                        f"[sync] skipping connection {connection['id']}: provider "
                        f"{connection['provider']!r} has no configured app credentials"
                    )
                    _record_sync_failure(conn, connection["id"], message)
                    _record(error="no configured app credentials")
                    continue
                credential = crypto_service.decrypt_connection_credential(
                    request.state.user, connection["provider"], connection["external_id"],
                    connection["credential"], connection["credential_enc"],
                )
                # **A page at a time, applied and committed before the next fetch.**
                #
                # The provider call is the slow part of a sync — a walking provider can spend a minute in
                # one request and does many of them — and holding the write transaction across it is what
                # made the rest of the app unusable while a sync ran: SQLite serializes writers, so every
                # other request that writes waited out the busy timeout and then failed outright. Committing
                # per page collapses that hold from minutes to milliseconds.
                #
                # It also bounds what a failure can discard. A pull used to roll back entirely, so failing
                # on the last window of a walk threw away every row before it *and* the metered requests
                # spent to fetch them; now a failure costs one page.
                #
                # `removed` is the one thing that cannot be applied per page. Processing every `added`
                # before any `removed` is what converts a pending→posted pair in place rather than trashing
                # and re-adding it (see `_insert_added`), and that pair can straddle a page boundary — so
                # removals accumulate across the drain and are applied once it finishes. They are rare and
                # tiny next to `added`, so deferring them costs nothing that matters.
                page_removed: list = []
                # Accumulated across pages, not per page: it feeds account discovery after the drain, and an
                # unknown account seen on page 1 must still be discovered if page 3 is where the drain ends.
                seen_unknown: set[str] = set()
                # Accounts whose rows are being discarded for being in another currency, remembered for the
                # whole drain. The adapter keeps them out of the coverage *it* reports, but it can only
                # speak for the page it just fetched — an account whose rows were dropped on page 1 appears
                # in page 3's coverage as an ordinary account that simply had no activity. Only the caller
                # spans the pages, so only the caller can keep the claim off it for the rest of the pull.
                unsupported_accounts: set[str] = set()
                for _ in range(_MAX_PAGES_PER_CALL):
                    # Nothing may be held open across the fetch below. This is the commit the restructure
                    # exists for; on the first pass it also flushes the in-progress marker so the rest of
                    # the app can see that a sync is running.
                    conn.commit()
                    # Re-derived per page, from coverage this loop just committed, because that is what a
                    # walking adapter resumes from. Built once per connection it would freeze at the depths
                    # held before the first page, and every later page would re-fetch the same window
                    # forever. Only a range pull asks for history; a routine top-up passes none, which is
                    # what tells the adapter to fetch its recent window instead.
                    account_targets = _build_account_targets(
                        conn, connection, target_start=date.today() - timedelta(days=days_requested),
                        ledger_currency=ledger_currency,
                    ) if is_range_pull else None
                    page = adapter.fetch_transactions_sync(
                        app_config, credential, cursor=cursor, days_requested=days_requested,
                        account_targets=account_targets, ledger_currency=ledger_currency,
                        request_budget=request_budget,
                        # False on the first call, True on every page after it — see the contract. Some
                        # work belongs to a pull rather than a page and must not repeat per page.
                        continuing=pages > 0,
                        budget_checkpoint=_checkpoint_budget,
                    )
                    page_removed.extend(page["removed"])
                    cursor = page["next_cursor"]
                    final_status = page["update_status"]
                    # Defaulted rather than required so an adapter written before this field still reads as
                    # "done when the status says so", which is what it meant.
                    backfill_complete = page.get("backfill_complete", True)
                    resume_later = page.get("resume_later", False)
                    # `None` and `{}` mean different things and must not be collapsed. `None` is "this
                    # provider does not report per-account coverage", which licenses recording the depth
                    # that was *requested*; `{}` is a provider that does report it saying this pull reached
                    # nothing new — which licenses recording nothing. Reading them as one claimed the full
                    # requested depth for a walking provider whenever its accounts had all finished, since
                    # a pull with no history left to fetch reports exactly `{}`.
                    account_coverage = page.get("account_coverage")
                    # Last page wins: the allowance is cumulative state, so the final page's reading is
                    # what the pull actually left. An adapter that meters nothing omits the key, and the
                    # row then stores nothing rather than an empty structure that would read as "measured,
                    # and the answer is none".
                    if page.get("request_allowance"):
                        request_allowance = page["request_allowance"]
                    # Merged rather than replaced, because coverage describes only the accounts the page in
                    # hand touched — a walk that spends its last page on one account would otherwise erase
                    # what the earlier pages recorded for its siblings.
                    for external_account_id, reported in (account_coverage or {}).items():
                        account_reach[external_account_id] = {
                            "reached": reported.get("reached"),
                            "history_complete": bool(reported.get("complete")),
                        }
                    for w in page.get("warnings") or []:
                        if w not in connection_warnings:
                            connection_warnings.append(w)
                    # An adapter with nothing to say omits the key entirely, which is why this reads
                    # defensively rather than requiring the contract's default to have been copied.
                    for entry in page.get("advisories") or []:
                        if isinstance(entry, dict) and entry.get("message"):
                            _add_advisory(connection_advisories, entry["message"],
                                          count=int(entry.get("count") or 1),
                                          context=entry.get("context"))
                    unsupported_accounts.update(page.get("unsupported_currency") or {})
                    for w in _currency_warnings(
                        conn, connection["id"], page.get("unsupported_currency") or {}, ledger_currency,
                        connection_advisories,
                    ):
                        if w not in connection_warnings:
                            connection_warnings.append(w)
                    for window in page.get("requested_windows") or []:
                        if isinstance(window, dict) and window.get("start") and window.get("end"):
                            requested_windows.append({"start": window["start"], "end": window["end"]})
                    pages += 1
                    status_sequence.append(page["update_status"])

                    for t in page["added"]:
                        _insert_added(t, _get_card, dedupe, seen_unknown, account_tally)
                    for t in page["modified"]:
                        _apply_modified(t, account_tally)
                    # This page's rows and the claims that describe them land together, so what the ledger
                    # holds and what it says it holds can never disagree across a crash. Coverage is
                    # deliberately written per page rather than once at the end: it is the durable record of
                    # how far the walk has reached, which is both the resume point and the progress a client
                    # reads while the sync is still running.
                    conn.execute(
                        "UPDATE connection SET transactions_cursor = ?, sync_progress = ? WHERE id = ?",
                        (cursor, json.dumps({
                            "started_at": started_at,
                            "added": added - added0,
                            "requests": len(requested_windows),
                            "pages": pages,
                        }), connection["id"]),
                    )
                    _record_sync_coverage(
                        conn, connection,
                        is_range_pull=is_range_pull,
                        requested_start=(date.today() - timedelta(days=days_requested)
                                         if is_range_pull else None),
                        synced_accounts=dedupe.label_by_external,
                        account_coverage=(
                            {a: c for a, c in account_coverage.items() if a not in unsupported_accounts}
                            if account_coverage is not None else None
                        ),
                    )
                    if not page["has_more"]:
                        break

                for ext_id in page_removed:
                    _apply_removed(ext_id)
                # Account discovery talks to the provider, so the drain's last page has to be committed
                # before it — same rule as the fetch above.
                conn.commit()
                discovered += _discover_new_provider_accounts(
                    connection, adapter, app_config, credential, seen_unknown, connection_advisories,
                )
            except ProviderCredentialRejected as e:
                # The one failure a user can act on, and the one retrying cannot fix. Flagged separately so
                # the card can say "reconnect this" instead of counting it alongside network blips as
                # another "sync failed" — a distinction the generic handler below deliberately does not
                # draw, because for every *other* cause it would be a distinction without a difference.
                log_warning(f"[sync] connection {connection['id']} needs reconnecting: {e}")
                _record_sync_failure(conn, connection["id"], str(e), reauth_required=True)
                _record(error=str(e))
                continue
            except crypto_service.MissingCredential:
                # Nothing is stored to authenticate with — the state a vault reset leaves behind, since it
                # clears the credentials and keeps the connection rows so a re-link lands back on them.
                # `reauth_required` is already set by whatever cleared it, and is set again here so a row
                # that arrived in this state by any other route says the same thing.
                message = ("This connection has no stored credential. Connect the data source again to "
                           "store a fresh one.")
                log_warning(f"[sync] connection {connection['id']} has no stored credential")
                _record_sync_failure(conn, connection["id"], message, reauth_required=True)
                _record(error=message)
                continue
            except crypto_service.VaultDecryptError:
                # The stored credential will not open under the DEK this unlock produces — a rotated or
                # rebuilt vault over ciphertext sealed to the old key. Classified with the rejection above
                # rather than left to the generic arm, because it is the same *user* situation: retrying
                # can never succeed and the only way forward is to re-link. Left to fall through it read as
                # "this connection has stopped working", which sends the user looking for an outage.
                #
                # The message is written here because the exception carries none: it is raised bare, having
                # no context at the point it is detected (see `crypto_service.decrypt_secret`).
                message = ("This connection's stored credential can no longer be read with the current "
                           "vault key. Reconnect the data source to store a fresh credential.")
                log_warning(f"[sync] connection {connection['id']} credential is unreadable under the current DEK")
                _record_sync_failure(conn, connection["id"], message, reauth_required=True)
                _record(error=message)
                continue
            except UnknownProviderError as e:
                log_warning(f"[sync] skipping connection {connection['id']}: {e}")
                _record_sync_failure(conn, connection["id"], f"Unknown data source: {e}")
                _record(error=f"unknown provider: {e}")
                continue
            except NotImplementedError as e:
                log_warning(f"[sync] skipping connection {connection['id']}: {e}")
                _record_sync_failure(conn, connection["id"], str(e))
                _record(error=str(e))
                continue
            except Exception as e:
                # Every failure is counted, whatever its cause: what the card needs to say is "this
                # connection has stopped working", and a user cannot act on the distinction between a
                # network blip and a revoked credential — only on how long it has been going on.
                log_warning(f"[sync] error fetching connection {connection['id']}: {e}")
                _record_sync_failure(conn, connection["id"], str(e))
                _record(error=str(e))
                continue
            finally:
                # What the pull spent at the provider, recorded whether it succeeded or raised — the one
                # piece of sync state that must survive a failure. Everything else written here is a claim
                # about data in the ledger and correctly disappears with a pull that inserted nothing; the
                # requests themselves were still made, and a provider that meters them is not going to
                # forget. Without this, a walk that fails after twenty requests starts the next attempt
                # believing it has spent nothing — and the connection a user retries most is exactly the one
                # that would overrun. `finally` rather than a line in each handler so a failure mode added
                # later cannot silently opt out.
                conn.execute(
                    "UPDATE connection SET provider_request_budget = ? WHERE id = ?",
                    (json.dumps(request_budget) if request_budget else None, connection["id"]),
                )

            # Flip the connection out of "initial" once its history has actually been fetched to the end —
            # subsequent syncs then accrete onto monthly cards instead of the one backfill card. This reads
            # `backfill_complete` and NOT the poll-stop signal: a pull can legitimately stop early while
            # more history remains (a metered provider pausing a multi-window walk), and flipping the flag
            # then would strand that history behind a short routine look-back with nothing left to go back
            # for it.
            #
            # Unlike the cursor and the coverage claims, this is a conclusion about the *whole* pull rather
            # than about a page, so it is the one piece of connection state still written here. A pull that
            # dies partway leaves it un-flipped, which is correct: its history is not finished.
            became_complete = initial and backfill_complete
            conn.execute(
                "UPDATE connection SET initial_sync_complete = ? WHERE id = ?",
                (1 if (connection["initial_sync_complete"] or became_complete) else 0, connection["id"]),
            )
            # The pull itself succeeded, whatever it did or did not find — a paused walk included, since
            # pausing is the adapter doing the right thing rather than a failure.
            _record_sync_success(conn, connection["id"], connection_warnings)
            if connection_warnings:
                warned.append({
                    "connection_id": connection["id"],
                    "institution": connection["institution"] or connection["provider"],
                    "warnings": connection_warnings,
                })
            synced_statuses.append(final_status)
            # More polling helps only where the backfill is unfinished *and* the adapter did not ask to be
            # resumed later instead.
            more_to_poll.append(not backfill_complete and not resume_later)
            if resume_later:
                paused.append({
                    "connection_id": connection["id"],
                    "institution": connection["institution"] or connection["provider"],
                })
            _record(became_complete=became_complete)

        # Flush the card tallies (a card is reused across calls, so counts accumulate).
        for card_id, n in card_added.items():
            conn.execute("UPDATE import_batch SET row_count = row_count + ? WHERE id = ?", (n, card_id))
        for card_id, n in card_dupes.items():
            conn.execute("UPDATE import_batch SET deduped_count = deduped_count + ? WHERE id = ?", (n, card_id))
        # `skipped_count` on the card itself, which a sync never wrote — so a sync card reported 0 skipped
        # however much it had turned away, and every consumer that derives from the column (notably
        # `summarizeImportOutcome`'s imported-count fallback) was working from a figure that was not true.
        for card_id, counts in card_skipped.items():
            conn.execute("UPDATE import_batch SET skipped_count = skipped_count + ? WHERE id = ?",
                         (sum(counts.values()), card_id))
        # The headline summary, in the CSV card's own vocabulary. Every card this pull touched is covered,
        # including one that only turned rows away: `card_skipped` and `card_added` need not name the same
        # cards, and a card that imported nothing is exactly the case a summary of zero would misreport.
        for card_id in {*card_added, *card_dupes, *card_skipped}:
            counts = card_skipped.get(card_id) or Counter()
            record_sync_card_totals(
                conn, batch_id=card_id,
                imported=card_added.get(card_id, 0), deduped=card_dupes.get(card_id, 0),
                account_skipped=counts.get("account_skipped", 0), rejected=counts.get("rejected", 0),
            )
        for (card_id, csv_value), info in card_accounts.items():
            # `csv_value` is the provider account's LABEL (e.g. "CREDIT CARD ···6612"), not its opaque
            # provider id: it is the connection's "source value", it reads like a CSV card's account
            # column, and it is what a row's evidence records so the terminal-window matcher can identify
            # a synced row's source account.
            #
            # No coverage columns are written. A card holds whatever a delta happened to deliver, which
            # proves nothing about the dates it spans; the connection's coverage claim lives on
            # connection_account (see _record_sync_coverage). A skipped row has no coverage claim to make
            # for the further reason that it was never held — matching the CSV skip path, which writes the
            # three coverage columns NULL for the same reason.
            #
            # `row_count` counts rows *seen* for this source account, landed or dropped, which is what
            # makes the CSV card's `✕ Some Account 35` and a sync card's read the same. The two are
            # summed rather than kept apart because `was_skipped` already says which kind they are, and a
            # pair can only hold both across syncs — the case the two clauses below exist for:
            #
            #   account_id  COALESCE, so a later sync's skipped rows (account_id NULL) cannot erase the
            #               destination an earlier sync recorded.
            #   was_skipped MIN, so mapping an account the user had skipped clears the flag on the next
            #               sync that lands a row, and nothing can set it back. "Skipped" is a claim about
            #               the whole pair, and one row landing disproves it.
            conn.execute(
                """
                INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count, was_skipped)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(batch_id, csv_value)
                DO UPDATE SET row_count   = row_count + excluded.row_count,
                              account_id  = COALESCE(excluded.account_id, import_batch_account.account_id),
                              was_skipped = MIN(import_batch_account.was_skipped, excluded.was_skipped)
                """,
                (card_id, csv_value, info["account_id"], info["count"] + info["skipped"],
                 1 if info["skipped"] and not info["count"] else 0),
            )

        # Persist the sync diagnostics. Written unconditionally: a diagnostic that only records while a
        # flag is on cannot explain a failure that already happened — enabling the flag afterwards yields
        # an empty table and the user has to reproduce the problem to see anything, which is backwards for
        # the one case this log exists for. Best-effort: a logging failure must never fail the sync that
        # already did its work, so it is guarded and swallowed.
        if sync_diagnostics:
            try:
                _write_sync_diagnostics(conn, sync_diagnostics)
            except Exception as e:
                log_warning(f"[sync] could not write sync diagnostics: {e}")

    # Duplicate detection on the freshly-synced rows, mirroring the import finalize (core.py): a CSV/manual
    # row re-fetched via a data source is a *cross-account* duplicate (the sync creates a new account
    # record, distinct from the CSV account until merged), which provider-id idempotence never sees. Only
    # cards that received rows are swept, and each is told the rows this call gave it.
    #
    # **After the sync transaction, in its own connection** — the same rule the recurring rescan below
    # follows, and for a stronger reason. This is analysis over the whole ledger, not part of writing the
    # rows; run inside the ingest transaction it held the write lock for as long as it took to read, which
    # on one real backfill was 109 seconds — no other writer could proceed, the sync's own request could not
    # return, and the progress panel sat frozen behind it because the sync marker is only cleared once the
    # response is on its way.
    if cards_touched:
        try:
            with get_db() as conn:
                for card_id in cards_touched:
                    sweep_import_suspects(conn, card_id, txn_ids=card_added_ids.get(card_id, []))
        except Exception as e:
            log_warning(f"[sync] duplicate sweep failed: {e}")

    # New/advanced rows change the recurring picture, so refresh detection now rather than waiting for a
    # manual scan. Cheap scoped path: reprocess only the payees this sync touched, not the whole ledger
    # (the daily app-load catch-up is the global safety net). Runs after the sync transaction commits, in
    # its own connection, and never lets a detection hiccup fail the sync itself.
    if touched_ids:
        try:
            with get_db() as conn:
                scan_imported_payees(conn, payee_keys_for_ids(conn, touched_ids))
        except Exception as e:
            log_warning(f"[sync] recurring auto-scan failed: {e}")

    # `historical_complete` is the client's stop-polling signal: true once no connection has more to deliver
    # *right now*. A paused connection counts as nothing-more-right-now even though its history is
    # unfinished — polling a provider that just declined to serve us is the opposite of what it asked for.
    # `paused` is what tells the user that case apart from a genuine finish, and `initial_sync_complete`
    # (left unset per connection above) is what makes the outstanding history resume on a later sync.
    historical_complete = not any(more_to_poll)
    overall_status = min(synced_statuses, key=lambda s: _STATUS_ORDER.get(s, 2), default=None)
    return {
        "added": added, "updated": updated, "removed": removed, "skipped": skipped, "deduped": deduped,
        # This call's totals split per connection, from the same `entry` dicts the log and the connection
        # card are built from — so the three cannot disagree about one call. It exists because the client
        # drives a *sequence* of these calls and wants a per-connection total for the whole run: summing
        # responses is exact, where the alternative (differencing the `sync_progress` a slow poll happens
        # to observe) silently loses any call that begins and ends between two polls.
        "connections": [
            {
                "connection_id": e["connection_id"],
                "institution":   e["institution"] or e["provider"],
                "added":         e["added"],
                "updated":       e["updated"],
                "removed":       e["removed"],
                "skipped":       e["skipped"],
                "error":         e["error"],
            }
            for e in sync_diagnostics
        ],
        # Provider accounts seen for the first time in this sync's data. Their transactions were skipped
        # (nothing to map them to yet), so this is what turns "N skipped" from an unexplained number into
        # the "N to map" nudge on the connection card.
        "discovered": discovered,
        "update_status": overall_status, "historical_complete": historical_complete,
        "paused": paused, "warned": warned,
    }


# The sync log is deliberately NOT behind `LUMA_DEVELOPER_OPTIONS`. That flag gates *destructive* dev
# reset tools and is env-only so it can't be casually flipped; this is a read-only record of what each
# sync did, and it is the only in-app answer to "why did this connection import nothing?" — which every
# user needs, and needs without an env var or a reproduction.


# The buckets a reader is owed, named rather than positional, summed from the per-account tally at read
# time. Naming them here is the point: the four are unrelated events, and the two the user can act on read
# as opposite advice — a `skip` account is working as configured, an unmapped one is waiting on a decision.
# Folding those two together is what made a correctly-configured connection report a problem forever.
_SKIP_BUCKETS = ("skipped_by_choice", "skipped_unknown_account", "skipped_already_held",
                 "skipped_zero_amount")


def _skipped_breakdown(account_counts: dict | None, row: dict) -> dict | None:
    """One row's `skipped` total split into its named buckets, or None when the row recorded no breakdown.

    Summed on read from `account_counts`, which is the only place the buckets are stored. Nothing derives a
    bucket by subtracting the others: that was how the zero-amount count used to be recovered, and it made
    every added bucket a silent corruption of the one computed last.

    Rows written before the split carry the legacy columns instead, and are reported under a single
    `skipped_no_account` key so a log that spans the change still reads truthfully rather than showing an
    old row's skips as zero. `None` (no breakdown recorded at all) stays distinct from all-zero.
    """
    if not isinstance(account_counts, dict):
        legacy = int(row.get("skipped_no_account") or 0) + int(row.get("skipped_already_held") or 0)
        return None if not legacy else {
            "skipped_no_account":   int(row.get("skipped_no_account") or 0),
            "skipped_already_held": int(row.get("skipped_already_held") or 0),
        }
    out = {b: 0 for b in _SKIP_BUCKETS}
    for counts in account_counts.values():
        if not isinstance(counts, dict):
            continue
        for bucket in _SKIP_BUCKETS:
            out[bucket] += int(counts.get(bucket) or 0)
        # A row from before the split has its no-destination count under the old key and no way to say
        # which kind it was. Reported as unknown rather than as the user's choice: the wording for an
        # unmapped account ("map it to import them") is the one that is merely unhelpful if wrong, while
        # calling a genuine gap a deliberate exclusion would hide it.
        out["skipped_unknown_account"] += int(counts.get("skipped_no_account") or 0)
    return out


@router.get("/diagnostics")
def sync_diagnostics(limit: int = 100,
                     connection_id: Annotated[list[str] | str | None, Query()] = None):
    """Recent connection-sync diagnostic rows, newest first. One row per connection per /sync call: the
    status sequence, cursor fingerprints, count deltas, any warnings/advisories the pull produced, and
    whether the call completed the initial backfill — enough to see whether a sync stopped at the Initial
    Update or ran to HISTORICAL_UPDATE_COMPLETE, and why an under-fetch happened.

    `connection_id` may be repeated to scope the list to several connections (one is the deep link from a
    connection card). Filtered here rather than in the browser: the retention window is bounded but its
    rows are not small — a deep walk records one entry per request — so the whole buffer is worth several
    hundred KB that a filtered view has no use for.

    `counts` rides along, and is deliberately **not** filtered: it feeds the log's own per-connection
    filter pills, which have to keep saying how many rows each connection has while some of them are
    filtered out. Counting the filtered rows would collapse every unselected pill to zero the moment the
    first one was clicked. Each count is rows currently in the buffer, not syncs ever run — the table is a
    ring buffer capped at `_SYNC_LOG_RETENTION`, so it is a count of what this log can show."""
    limit = max(1, min(limit, _SYNC_LOG_RETENTION))
    # A bare string is accepted beside the list because this is called directly as a function as well as
    # over HTTP, and iterating a string here would scope the query to its characters.
    raw = [connection_id] if isinstance(connection_id, str) else (connection_id or [])
    ids = [c for c in raw if c]
    where, params = "", []
    if ids:
        where = f"WHERE connection_id IN ({','.join('?' * len(ids))})"
        params.extend(ids)
    params.append(limit)
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT * FROM connection_sync_log {where} ORDER BY started_at DESC, id DESC LIMIT ?",
            params,
        ).fetchall()
        # Labels come from the log's own denormalized columns, not from the connection table: a connection
        # the user has since disconnected still has rows here, and they must stay filterable and named.
        count_rows = conn.execute(
            """
            SELECT   connection_id, provider, institution, COUNT(*) AS count
            FROM     connection_sync_log
            GROUP BY connection_id
            ORDER BY COUNT(*) DESC, institution, connection_id
            """
        ).fetchall()

    def _json_list(value):
        try:
            parsed = json.loads(value) if value else []
        except (TypeError, ValueError):
            return []
        return parsed if isinstance(parsed, list) else []

    def _json_obj(value):
        try:
            parsed = json.loads(value) if value else None
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def _entry(r):
        d = dict(r)
        d["status_sequence"] = _json_list(r["status_sequence"])
        # Older rows predate these columns, so a missing key reads as "none recorded" rather than absent.
        d["warnings"] = _json_list(d.get("warnings"))
        d["advisories"] = _json_list(d.get("advisories"))
        d["card_counts"] = _json_list(d.get("card_counts"))
        d["requested_windows"] = _json_list(d.get("requested_windows"))
        # Objects rather than lists, and parsed here so the browser is never handed a JSON string to
        # re-parse. A row predating either column, or one from an adapter that reports neither, reads as
        # `None`, which is a different fact from an empty structure: `None` is "nothing was recorded",
        # `{}` is "measured, and the answer is none". Collapsing them renders an unmetered provider as a
        # connection with no allowance left, which is the opposite of what it means.
        d["request_allowance"] = _json_obj(d.get("request_allowance"))
        d["account_counts"] = _json_obj(d.get("account_counts"))
        d["became_complete"] = bool(r["became_complete"])
        d["skipped_breakdown"] = _skipped_breakdown(d["account_counts"], d)
        # The same number the connection card warns on, from the same function, so a reader following the
        # card's deep-link into this log cannot meet a different verdict about the call they just clicked.
        d["already_held_unexplained"] = unexplained_already_held(
            accounts=d["account_counts"], cursor_before=r["cursor_before"],
        )
        return d

    return {
        "entries": [_entry(r) for r in rows],
        "counts": [
            {
                "connection_id": r["connection_id"],
                "provider":      r["provider"],
                "institution":   r["institution"] or r["provider"],
                "count":         r["count"],
            }
            for r in count_rows
        ],
    }


@router.delete("/diagnostics")
def clear_sync_diagnostics():
    """Empty the connection-sync diagnostics log."""
    with get_db() as conn:
        conn.execute("DELETE FROM connection_sync_log")
    return {"ok": True}


@router.post("/recategorize")
def recategorize():
    with get_db() as conn:
        n = recategorize_all(conn)
    # Recategorization can move categories and rename payees (clean_name) across the whole ledger, both of
    # which reshape recurring grouping. It is also the one path that renames *existing* series members —
    # the case the scoped import/sync passes deliberately leave to a full rebuild (they skip payee-key
    # re-derivation). So run a FULL scan here, not a scoped one: it re-detects and re-derives keys. Guarded
    # so a detection hiccup never fails the recategorize that already committed.
    if n:
        try:
            with get_db() as conn:
                run_auto_scan(conn)
        except Exception as e:
            log_warning(f"[recategorize] recurring auto-scan failed: {e}")
    return {"updated": n}


@router.get("/recategorize-preview")
def recategorize_preview():
    with get_db() as conn:
        pending = preview_recategorize_count(conn)
    return {"pending": pending}
