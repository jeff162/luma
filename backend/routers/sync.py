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
"""

import json
import uuid
from datetime import date, datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException, Request

from backend.app_logging import log_warning
from backend.db.database import get_db
from backend.runtime_config import developer_options_enabled
from backend.services import crypto_service
from backend.services.providers import UnknownProviderError, get_adapter, resolve_app_config
from backend.services.ledger_currency import currency_matches, get_ledger_currency
from backend.services.providers.base import ProviderCredentialRejected
from backend.services.categorizer import (
    categorize_transaction,
    load_categorization_rules,
    load_rule_tags_by_id,
    preview_recategorize_count,
    recategorize_all,
    rule_scalar_effects,
)
from backend.services.connection_dedupe import build_connection_dedupe
from backend.services.connection_mapping import build_sync_evidence, record_provider_accounts
from backend.services.duplicate_detection import (
    evaluate_duplicate,
    mark_import_suspects,
    promote_in_group_suspects_to_confirmed,
)
from backend.services.recurring_detection import payee_keys_for_ids, run_auto_scan, scan_imported_payees
from backend.services.transaction_tags import sync_rule_tags_for_transaction

router = APIRouter()

# import_batch.source_kind marker for a data-source sync's period card. A sync groups its rows into one
# card per (connection, calendar month), so synced rows get an import_batch_id and a duplicate-review home
# like any imported file (see docs/backlog/sync-import-records-and-dedupe.md — record-first, then detection).
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


def _utcnow_iso() -> str:
    # Note %S before the fractional %f: Python's %f is *microseconds*, not SQLite's seconds.fraction, so
    # omitting %S yields an unparseable "HH:MM:<micros>Z" string (renders as "Invalid Date" in the viewer).
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _cursor_fingerprint(cursor: str | None) -> str | None:
    """A short, non-reversible marker for a provider cursor — its length plus a leading slice — so the
    diagnostics log can show whether the cursor was present and whether it advanced, without persisting the
    full opaque paging token."""
    if not cursor:
        return None
    return f"len={len(cursor)}·{cursor[:8]}"


def _write_sync_diagnostics(conn, rows: list[dict]) -> None:
    """Persist this sync's per-connection diagnostic rows and prune to the retention window. Called only
    when developer options are enabled; never lets a logging failure affect the sync itself."""
    for r in rows:
        conn.execute(
            """
            INSERT INTO connection_sync_log
                (id, connection_id, provider, institution, started_at, finished_at, mode, days_requested,
                 cursor_before, cursor_after, pages, added, updated, removed, skipped, status_sequence,
                 final_status, became_complete, error)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                str(uuid.uuid4()), r["connection_id"], r["provider"], r["institution"], r["started_at"],
                r["finished_at"], r["mode"], r["days_requested"], r["cursor_before"], r["cursor_after"],
                r["pages"], r["added"], r["updated"], r["removed"], r["skipped"],
                json.dumps(r["status_sequence"]), r["final_status"], 1 if r["became_complete"] else 0,
                r["error"],
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


def _currency_warnings(conn, connection_id: str, unsupported: dict, ledger_currency: str) -> list[str]:
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
        log_warning(
            f"[sync] connection {connection_id}: unmapped non-{ledger_currency} accounts, "
            f"nothing imported: {', '.join(unmapped)}"
        )
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
    if account_coverage:
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
    card_dupes: dict[str, int] = {}          # card_id -> rows hard-rejected as duplicates this call
    card_accounts: dict[tuple[str, str], dict] = {}  # (card_id, csv_value) -> {account_id, count}
    synced_statuses: list = []               # each synced connection's final update_status
    more_to_poll: list[bool] = []            # per connection: is there more to deliver by polling now?
    paused: list[dict] = []                  # connections that stopped early and will resume on a later sync
    warned: list[dict] = []                  # connections that synced but reported a partial problem
    sync_diagnostics: list[dict] = []        # per-connection diagnostic rows (persisted only in dev mode)

    _SELECT_CONNECTIONS = (
        "SELECT id, provider, external_id, credential, credential_enc, institution, "
        "transactions_cursor, initial_sync_complete FROM connection"
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

        def _account_for(external_account_id):
            return conn.execute(
                "SELECT id, owner_id FROM account WHERE external_account_id = ?",
                (external_account_id,),
            ).fetchone()

        def _discover_new_provider_accounts(connection, adapter, app_config, credential, seen_unknown) -> int:
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
                log_warning(
                    f"[sync] connection {connection['id']}: discovered {len(newly_recorded)} new provider "
                    f"account(s); their transactions are skipped until mapped"
                )
            return len(newly_recorded)

        def _insert_added(t, get_card, dedupe, seen_unknown=None) -> bool:
            """Insert one `added` transaction. `get_card` lazily resolves (and creates) the connection's
            card only when a row is actually inserted, so a no-op sync leaves no empty card. Idempotent on
            provider id: a row we already have advances pending state instead of duplicating."""
            nonlocal added, updated, skipped, deduped
            acc = _account_for(t["external_account_id"])
            if not acc:
                skipped += 1
                # Noted rather than merely counted: an id with no local account is either an account the
                # user skipped or one the provider has added since — and only the second is worth acting
                # on. `_discover_new_provider_accounts` tells them apart after the page is applied.
                if seen_unknown is not None:
                    seen_unknown.add(t["external_account_id"])
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
                    touched_ids.append(pend["id"])
                    return False
            existing = conn.execute(
                "SELECT id, is_pending FROM txn WHERE external_transaction_id = ?",
                (t["external_transaction_id"],),
            ).fetchone()
            if existing:
                if existing["is_pending"] and not t["is_pending"]:
                    conn.execute("UPDATE txn SET is_pending = 0 WHERE id = ?", (existing["id"],))
                    updated += 1
                    touched_ids.append(existing["id"])
                else:
                    skipped += 1
                return False

            # A check number folded into the merchant as "Check #<n>", matching the CSV convention, so
            # the check discriminator can tell two same-amount checks apart on synced rows too.
            merchant_name = t.get("merchant_name")
            if t.get("check_number"):
                merchant_name = f"Check #{t['check_number']}"
            source_label = dedupe.label_by_external.get(t["external_account_id"], t["external_account_id"])
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
            touched_ids.append(txn_id)
            cards_touched.add(card_id)
            card_added[card_id] = card_added.get(card_id, 0) + 1
            entry = card_accounts.setdefault((card_id, source_label), {"account_id": acc["id"], "count": 0})
            entry["count"] += 1
            entry.setdefault("dates", set()).add(t["date"])
            return True

        def _apply_modified(t) -> None:
            """A provider-side revision to a known transaction: refresh the provider-owned fields and the
            content hash, but leave the user's category and display-name edits intact. A modification for a
            row we don't have locally (outside our window, or dedup-dropped) is ignored."""
            nonlocal updated, skipped
            existing = conn.execute(
                "SELECT id FROM txn WHERE external_transaction_id = ?", (t["external_transaction_id"],),
            ).fetchone()
            if not existing:
                skipped += 1
                return
            content_hash = make_hash(t["date"], t["amount"], t["raw_name"] or t["merchant_name"] or "")
            conn.execute(
                """
                UPDATE txn SET amount = ?, date = ?, is_pending = ?, merchant_name = ?, raw_name = ?,
                               content_hash = ?
                WHERE  id = ?
                """,
                (t["amount"], t["date"], 1 if t["is_pending"] else 0, t["merchant_name"], t["raw_name"],
                 content_hash, existing["id"]),
            )
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
            final_status = None
            backfill_complete = True
            resume_later = False
            account_coverage: dict = {}
            connection_warnings: list[str] = []   # non-fatal provider problems, for the card's badge
            days_requested = ALL_HISTORY_DAYS
            # Per-connection diagnostics (persisted only in dev mode): the status sequence across drained
            # pages is what tells whether the historical backfill actually completed or the call stopped at
            # the Initial Update. Count deltas are snapshotted here and differenced after the connection runs.
            started_at = _utcnow_iso()
            cursor_before = connection["transactions_cursor"]
            status_sequence: list = []
            pages = 0
            added0, updated0, removed0, skipped0 = added, updated, removed, skipped

            def _record(*, error=None, became_complete=False):
                sync_diagnostics.append({
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
                })

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
                # Drain the pages available right now (has_more) into one change set, then apply added →
                # modified → removed. Draining first guarantees every `added` is processed before any
                # `removed` even when a pending→posted pair straddles a page boundary, so the pending row is
                # converted in place (in _insert_added) before its `removed` entry would trash it. The cursor
                # advances per page and is persisted at the end, so a mid-loop failure rolls back the whole
                # call and the next retry resumes from the last committed cursor.
                # What still wants older data, decided here because the mapping and coverage live here. Only
                # a range pull asks for history; a routine top-up passes none, which is what tells the
                # adapter to fetch its recent window instead.
                account_targets = _build_account_targets(
                    conn, connection, target_start=date.today() - timedelta(days=days_requested),
                    ledger_currency=ledger_currency,
                ) if is_range_pull else None

                page_added, page_modified, page_removed = [], [], []
                for _ in range(_MAX_PAGES_PER_CALL):
                    page = adapter.fetch_transactions_sync(
                        app_config, credential, cursor=cursor, days_requested=days_requested,
                        account_targets=account_targets, ledger_currency=ledger_currency,
                    )
                    page_added.extend(page["added"])
                    page_modified.extend(page["modified"])
                    page_removed.extend(page["removed"])
                    cursor = page["next_cursor"]
                    final_status = page["update_status"]
                    # Defaulted rather than required so an adapter written before this field still reads as
                    # "done when the status says so", which is what it meant.
                    backfill_complete = page.get("backfill_complete", True)
                    resume_later = page.get("resume_later", False)
                    account_coverage = page.get("account_coverage") or {}
                    for w in page.get("warnings") or []:
                        if w not in connection_warnings:
                            connection_warnings.append(w)
                    for w in _currency_warnings(
                        conn, connection["id"], page.get("unsupported_currency") or {}, ledger_currency
                    ):
                        if w not in connection_warnings:
                            connection_warnings.append(w)
                    pages += 1
                    status_sequence.append(page["update_status"])
                    if not page["has_more"]:
                        break
                seen_unknown: set[str] = set()
                for t in page_added:
                    _insert_added(t, _get_card, dedupe, seen_unknown)
                for t in page_modified:
                    _apply_modified(t)
                for ext_id in page_removed:
                    _apply_removed(ext_id)
                discovered += _discover_new_provider_accounts(
                    connection, adapter, app_config, credential, seen_unknown,
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

            # Persist the advanced resume token, and flip the connection out of "initial" once its history
            # has actually been fetched to the end — subsequent syncs then accrete onto monthly cards
            # instead of the one backfill card. This reads `backfill_complete` and NOT the poll-stop
            # signal: a pull can legitimately stop early while more history remains (a metered provider
            # pausing a multi-window walk), and flipping the flag then would strand that history behind a
            # short routine look-back with nothing left to go back for it.
            became_complete = initial and backfill_complete
            conn.execute(
                "UPDATE connection SET transactions_cursor = ?, initial_sync_complete = ? WHERE id = ?",
                (cursor, 1 if (connection["initial_sync_complete"] or became_complete) else 0, connection["id"]),
            )
            # Per account where the adapter reports it, so a pull that reached different depths for
            # different accounts — or touched only some of them — records exactly that.
            _record_sync_coverage(
                conn, connection,
                is_range_pull=is_range_pull,
                requested_start=date.today() - timedelta(days=days_requested) if is_range_pull else None,
                synced_accounts=dedupe.label_by_external,
                account_coverage=account_coverage,
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
        for (card_id, csv_value), info in card_accounts.items():
            # `csv_value` is the provider account's LABEL (e.g. "CREDIT CARD ···6612"), not its opaque
            # provider id: it is the connection's "source value", it reads like a CSV card's account
            # column, and it is what a row's evidence records so the terminal-window matcher can identify
            # a synced row's source account.
            #
            # No coverage columns are written. A card holds whatever a delta happened to deliver, which
            # proves nothing about the dates it spans; the connection's coverage claim lives on
            # connection_account (see _record_sync_coverage).
            conn.execute(
                """
                INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(batch_id, csv_value)
                DO UPDATE SET row_count  = row_count + excluded.row_count,
                              account_id = excluded.account_id
                """,
                (card_id, csv_value, info["account_id"], info["count"]),
            )

        # Duplicate detection on the freshly-synced rows, mirroring the import finalize (core.py): a
        # CSV/manual row re-fetched via a data source is a *cross-account* duplicate (the sync creates a new
        # account record, distinct from the CSV account until merged), which provider-id idempotence never
        # sees. mark_import_suspects soft-flags those on the card; promote_in_group_suspects_to_confirmed
        # confirms the ones whose accounts are already merged. Only cards that received rows are swept.
        for card_id in cards_touched:
            mark_import_suspects(conn, card_id)
            card_account_ids = [
                str(r["account_id"]) for r in conn.execute(
                    "SELECT DISTINCT account_id FROM txn WHERE import_batch_id = ? AND account_id IS NOT NULL",
                    (card_id,),
                ).fetchall()
            ]
            if card_account_ids:
                promote_in_group_suspects_to_confirmed(conn, card_account_ids)

        # Persist the sync diagnostics (dev-mode only). Best-effort: a logging failure must never fail the
        # sync that already did its work, so it is guarded and swallowed.
        if sync_diagnostics and developer_options_enabled():
            try:
                _write_sync_diagnostics(conn, sync_diagnostics)
            except Exception as e:
                log_warning(f"[sync] could not write sync diagnostics: {e}")

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
        # Provider accounts seen for the first time in this sync's data. Their transactions were skipped
        # (nothing to map them to yet), so this is what turns "N skipped" from an unexplained number into
        # the "N to map" nudge on the connection card.
        "discovered": discovered,
        "update_status": overall_status, "historical_complete": historical_complete,
        "paused": paused, "warned": warned,
    }


def _require_developer_options():
    # The sync diagnostics log is a developer/testing aid; its endpoints 404 (rather than 403) when the
    # feature is off, so the surface is invisible unless LUMA_DEVELOPER_OPTIONS is set — matching how the
    # rest of the developer-options surface behaves (import_export/core._require_developer_access).
    if not developer_options_enabled():
        raise HTTPException(status_code=404, detail="Developer options are not enabled")


@router.get("/diagnostics")
def sync_diagnostics(limit: int = 100):
    """Recent connection-sync diagnostic rows, newest first (developer options only). One row per connection
    per /sync call: the status sequence, cursor fingerprints, count deltas, and whether the call completed
    the initial backfill — enough to see whether a sync stopped at the Initial Update or ran to HISTORICAL_
    UPDATE_COMPLETE, and why an under-fetch happened."""
    _require_developer_options()
    limit = max(1, min(limit, _SYNC_LOG_RETENTION))
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM connection_sync_log ORDER BY started_at DESC, id DESC LIMIT ?", (limit,),
        ).fetchall()

    def _entry(r):
        d = dict(r)
        try:
            d["status_sequence"] = json.loads(r["status_sequence"]) if r["status_sequence"] else []
        except (TypeError, ValueError):
            d["status_sequence"] = []
        d["became_complete"] = bool(r["became_complete"])
        return d

    return {"entries": [_entry(r) for r in rows]}


@router.delete("/diagnostics")
def clear_sync_diagnostics():
    """Empty the connection-sync diagnostics log (developer options only)."""
    _require_developer_options()
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
