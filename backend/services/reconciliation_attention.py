# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""How much of a reconciliation report needs the user, cached so the places that ask often can afford it.

The import history tints each file card by its report's attention count, and the Tasks nag sums them —
both read paths, hit on every history load and task poll, while computing a count runs the whole report.
So a count is cached and recomputed only when stale, and "stale" is one monotonic epoch in `db_meta`
(`recon_epoch`): a trigger bumps it on any write to a table a report reads (see
`database._create_recon_epoch_triggers`), and a cached count stamped with an older epoch is recomputed on
its next read. A clean read is then a single indexed lookup, and a stale count is impossible because no
write can dodge a trigger. Callers asking for the same stale count together share one computation
(`services/cache_fill.py`). The epoch also moves once at every start (`database._bump_recon_epoch`), so a
value cached by earlier code is never served to the code that replaced it.

Two scopes share the mechanism: a count per import batch, cached on the batch row, and a value derived
from the whole ledger — for a report that is not about one file, such as the PayPal reconciliation —
cached in `db_meta`. Neither cache write touches a table with a trigger, so a write never invalidates itself.

**A cache write commits at once when the caller had no transaction open**, which is the case on the read
paths that ask. It is a write, so it takes the write lock, and left to the caller's block the lock would be
held across every read after it — the rest of a history listing or a Tasks poll. A caller already
mid-write keeps its transaction whole, since committing it would split the caller's own work."""

from __future__ import annotations

import json
import sqlite3
from typing import Callable

from backend.services.cache_fill import MISS, fill_once


def recon_epoch(conn: sqlite3.Connection) -> int:
    """The current reconciliation epoch; absent is 0 (nothing a report reads has been written yet)."""
    row = conn.execute("SELECT value FROM db_meta WHERE key = 'recon_epoch'").fetchone()
    try:
        return int(row["value"]) if row else 0
    except (TypeError, ValueError):
        return 0


def _store(conn: sqlite3.Connection, sql: str, params: tuple) -> None:
    held = conn.in_transaction
    conn.execute(sql, params)
    if not held:
        conn.commit()


def batch_attention(conn: sqlite3.Connection, batch_id: str, compute: Callable[[sqlite3.Connection, str], int]) -> int:
    """A batch's attention count, from its cache when the cache is current."""
    def read():
        row = conn.execute(
            "SELECT recon_attention_count, recon_epoch FROM import_batch WHERE id = ?", (batch_id,)
        ).fetchone()
        if row and row["recon_epoch"] is not None and int(row["recon_epoch"]) == recon_epoch(conn) \
                and row["recon_attention_count"] is not None:
            return int(row["recon_attention_count"])
        return MISS

    def fill() -> int:
        epoch = recon_epoch(conn)
        count = compute(conn, batch_id)
        _store(
            conn,
            "UPDATE import_batch SET recon_attention_count = ?, recon_epoch = ? WHERE id = ?",
            (count, epoch, batch_id),
        )
        return count

    return fill_once(conn, f"recon_attention:{batch_id}", read, fill)


def ledger_cached(conn: sqlite3.Connection, key: str, compute: Callable[[sqlite3.Connection], object]):
    """A whole-ledger report's derived value (any JSON value), cached in `db_meta` under `key`."""
    def read():
        row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (key,)).fetchone()
        try:
            cached = json.loads(row["value"]) if row else None
        except (TypeError, ValueError):
            cached = None
        if isinstance(cached, dict) and cached.get("epoch") == recon_epoch(conn) and "value" in cached:
            return cached["value"]
        return MISS

    def fill():
        epoch = recon_epoch(conn)
        value = compute(conn)
        _store(
            conn,
            "INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps({"epoch": epoch, "value": value})),
        )
        return value

    return fill_once(conn, key, read, fill)


def ledger_attention(conn: sqlite3.Connection, key: str, compute: Callable[[sqlite3.Connection], int]) -> int:
    """A whole-ledger report's attention count, cached in `db_meta` under `key`."""
    return int(ledger_cached(conn, key, compute))
