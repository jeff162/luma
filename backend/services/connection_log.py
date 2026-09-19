# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The data-connection log — `connection_sync_log`, which the app shows as the **Sync log**.

The name predates the scope. Every operation that talks to a provider on a connection's behalf writes one
row here: a sync, a connect (including one that failed before any connection existed), a reconnect, an
account refresh, a disconnect, and each connection's outcome when credentials are reissued after an exposure
or revoked by a vault reset. One place for all of them because they are one story — a sync that fails the
morning after a secret was rotated is explained by the rows beside it — and a second log for the rest would
leave each half unreadable without the other.

**What is recorded is the provider's answer, not the app's own refusals.** A connect refused before the
provider is called (a locked vault, demo data loaded, no credentials configured) already tells the user
why, in place, and involves no provider; logging it would bury the rows that do.

**Rows describe connections that may no longer exist.** A disconnect deletes the connection's other rows and
leaves its own, under the same `connection_id`, so the log can still say when a connection was removed and
whether access was revoked at the provider. Nothing enforces the reference any more — the table carries no
foreign key — which is why `delete_for_connection` exists and why the disconnect endpoint is the one place
a connection is deleted.

**Retention is by age**, a ledger setting defaulting to `DEFAULT_RETENTION_DAYS`, pruned on every write. It
replaced a 500-row cap, which let one busy connection push every other connection's history out of the log
with nothing to say it had happened. The log is still prunable and clearable, so nothing user-facing may be
derived from it: the connection card's own state lives on `connection`.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

from backend.app_logging import log_warning
from backend.db.database import get_db
from backend.services.preferences import get_shared_preference, set_shared_preference

# The `event` column's vocabulary. `sync` is what every row written before the column existed was.
SYNC = "sync"
CONNECT = "connect"
RECONNECT = "reconnect"
REFRESH_ACCOUNTS = "refresh_accounts"
DISCONNECT = "disconnect"
REISSUE = "reissue"
REVOKE = "revoke"

DEFAULT_RETENTION_DAYS = 30
RETENTION_PREF_KEY = "connections.log_retention_days"
# A sanity bound rather than a policy: the log is a diagnostic, and a year of it is already more than anyone
# reads. At least a day, since zero would empty the log on the write that was meant to record something.
MIN_RETENTION_DAYS = 1
MAX_RETENTION_DAYS = 365

# How much of a provider's error text a row keeps. Messages are single sentences once translated (see
# `plaid_service.PlaidError`); the bound is for whatever an adapter passes through untranslated.
_ERROR_CHARS = 500


def timestamp() -> str:
    """The log's own timestamp shape. `%S` before the fraction matters: Python's `%f` is microseconds, not
    SQLite's seconds-and-fraction, and leaving `%S` out yields a string no date parser reads."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def retention_days(conn: sqlite3.Connection) -> int:
    """The ledger's retention, clamped. An unreadable stored value falls back to the default rather than
    raising: this runs on every log write, and a bad preference must not take a sync down with it."""
    raw = get_shared_preference(conn, RETENTION_PREF_KEY)
    if raw is None:
        return DEFAULT_RETENTION_DAYS
    try:
        days = int(str(raw).strip().strip('"'))
    except (TypeError, ValueError):
        return DEFAULT_RETENTION_DAYS
    return max(MIN_RETENTION_DAYS, min(days, MAX_RETENTION_DAYS))


def set_retention_days(conn: sqlite3.Connection, days) -> int:
    """Store a new retention and apply it at once, so a shortened window is visible on the next read."""
    try:
        value = int(days)
    except (TypeError, ValueError):
        raise ValueError("That is not a number of days.")
    if value < MIN_RETENTION_DAYS or value > MAX_RETENTION_DAYS:
        raise ValueError(f"Choose between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS} days.")
    set_shared_preference(conn, RETENTION_PREF_KEY, str(value))
    prune(conn)
    return value


def prune(conn: sqlite3.Connection) -> None:
    """Drop rows older than the retention window.

    Compared as strings, which is sound because every writer stamps the same ISO shape: this module's
    `timestamp()`, and the column default's `strftime('%Y-%m-%dT%H:%M:%fZ')`, which agree up to the
    fraction's length and so order identically at the precision a day boundary needs."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days(conn))).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    conn.execute("DELETE FROM connection_sync_log WHERE started_at < ?", (cutoff,))


def delete_for_connection(conn: sqlite3.Connection, connection_id: str) -> None:
    """A disconnected connection's rows, which the table's lack of a foreign key leaves to be removed here.
    Run in the disconnect's own transaction, before the disconnect row is written."""
    conn.execute("DELETE FROM connection_sync_log WHERE connection_id = ?", (connection_id,))


def write_event(conn: sqlite3.Connection, *, event: str, provider: str, connection_id: str | None = None,
                institution: str | None = None, error: str | None = None, detail: dict | None = None) -> None:
    """Record one non-sync operation on the caller's connection, inside its transaction.

    `connection_id` is None only for a connect that failed before the provider issued a connection. `detail`
    is the event's own small facts (how many accounts a connect offered, whether a disconnect revoked, what
    the provider said about a failure — see `error_detail`), kept as JSON because each event has different
    ones and none of them is ever queried.

    Never raises. The operation being recorded has already happened at the provider by the time this runs —
    a revoked token is dead — so a logging failure must not roll back or fail the local half of it.
    """
    try:
        now = timestamp()
        conn.execute(
            """
            INSERT INTO connection_sync_log
                (id, connection_id, provider, institution, started_at, finished_at, event, error, detail)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (str(uuid.uuid4()), connection_id, provider, institution, now, now, event,
             str(error)[:_ERROR_CHARS] if error else None,
             json.dumps(detail) if detail else None),
        )
        prune(conn)
    except sqlite3.Error as exc:
        log_warning(f"[connection-log] could not record {event} for {provider}: {exc}")


def record_event(**fields) -> None:
    """`write_event` in a transaction of its own — for an operation that holds none open, or one whose own
    transaction is about to fail and would take the row down with it (a refused connect)."""
    try:
        with get_db() as conn:
            write_event(conn, **fields)
    except sqlite3.Error as exc:
        log_warning(f"[connection-log] could not record {fields.get('event')}: {exc}")


def error_detail(exc: BaseException | None) -> dict | None:
    """What the provider itself said about a failure, as a row's `detail` — `{"provider_error": {...}}`.

    Kept beside the readable message the row shows because it holds what that message leaves out, above all
    the request id a provider's support asks for. Read from `provider_detail` on the exception or on any it
    was raised from, since an adapter may re-raise a provider error as the seam's own
    (`ProviderCredentialRejected`). None for a failure that carries no such body."""
    seen = exc
    while seen is not None:
        body = getattr(seen, "provider_detail", None)
        if body:
            return {"provider_error": body}
        seen = seen.__cause__
    return None


def record_outcomes(event: str, outcomes: list[dict], connections: list[dict], *, failed: str,
                    errors: dict | None = None) -> None:
    """One row per connection for a credential sweep — the exposure response's reissue, or the vault reset's
    revoke — so the log beside a connection's syncs says when its credential was replaced or revoked, which
    is what explains the next sync behaving differently. `outcomes` is the sweep's own per-connection result
    list (`connection_id`, `provider`, `outcome`, `detail`); the one outcome named `failed` carries its
    provider's message as the row's error, and `errors` maps a failed connection to the exception behind it,
    for what the provider said (`error_detail`)."""
    institutions = {c["id"]: c["institution"] for c in connections}
    for o in outcomes:
        failure = (errors or {}).get(o["connection_id"])
        record_event(
            event=event, provider=o["provider"], connection_id=o["connection_id"],
            institution=institutions.get(o["connection_id"]),
            error=o["detail"] if o["outcome"] == failed else None,
            detail={"outcome": o["outcome"], **(error_detail(failure) or {})},
        )
