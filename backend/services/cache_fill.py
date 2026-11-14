# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One computation per stale cache at a time.

The derived caches kept in the database (the reconciliation attention counts, the owner lens's rule reach)
are recomputed on the read that finds them stale, and a start makes every one of them stale. The first page
load after a start asks for the same cache from several requests at once, a page mounted twice and the Tasks
badge among them, and each would run the whole computation. They share one interpreter lock, so three
copies of a four-second scan take twelve seconds of everyone's time. Here the first caller computes and the
others wait for it, then read what it stored.

**A caller with a transaction open computes on its own, without waiting.** Its snapshot would not show the
value another caller committed, and it may hold the write lock the computing caller needs in order to store
its result, so waiting could only deadlock or recompute anyway.

The locks are process-wide and kept for the life of the process, one per database and cache key, so their
number is bounded by the caches that exist (a few, plus one per Amazon import batch)."""

from __future__ import annotations

import sqlite3
import threading
from typing import Callable, TypeVar

T = TypeVar("T")

# What `read` returns when the cache is stale or absent, since a cached value may itself be None.
MISS = object()

_locks_guard = threading.Lock()
_locks: dict[tuple[str, str], threading.Lock] = {}


def _lock_for(conn: sqlite3.Connection, key: str) -> threading.Lock:
    # By index rather than by name, so a connection without `sqlite3.Row` works too. `main` is the first row.
    db_file = conn.execute("PRAGMA database_list").fetchone()[2]
    with _locks_guard:
        return _locks.setdefault((db_file, key), threading.Lock())


def fill_once(conn: sqlite3.Connection, key: str, read: Callable[[], object], fill: Callable[[], T]) -> T:
    """The cached value from `read`, or `fill`'s result when `read` returns `MISS`. `fill` computes and
    stores the value; only one caller per database and `key` runs it at a time, and a caller that waited
    reads the cache again before computing."""
    value = read()
    if value is not MISS:
        return value
    if conn.in_transaction:
        return fill()
    with _lock_for(conn, key):
        value = read()
        return value if value is not MISS else fill()
