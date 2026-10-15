# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tracing for contention between requests, off unless `TRACE_DB_CONTENTION` is set.

This is the instrument `npm run ui:stress` reads, and `docs/scale-and-limits.md` → *Many sessions on one
server* says what its lines mean. Three kinds of line, each written only when something was slow:

- `[db-hold]` — a connection block that wrote and kept the write lock for a second or more. One slow write
  that takes up the whole span is a block **waiting** for the lock; a long span with little SQL in it is a
  block **holding** the lock while it does other work.
- `[db-block]` — any connection block open three seconds or more, with the time spent in database calls
  beside it. A large gap between the two is Python work between the calls. A call's time includes waiting
  for Python's interpreter lock to hand back each row, so a block that is slow *inside* its calls is either
  slow SQL or rows queued behind other busy requests; running the same request alone tells which.
- `[slow-request]` — a request that took a second or more, with how many requests were in flight when it
  began.

**Every statement is timed around the call itself, fetches included.** A trace callback cannot be used: it
fires when a statement *begins*, so a statement blocked on the lock reads as time spent holding it. And a
fetch is timed as well as the `execute` that starts it, because a SELECT does most of its work while its
rows are fetched: timing `execute` alone once reported a 12-second request as 0.2 seconds of database
work.

`time.monotonic` throughout, because this host's wall clock has been seen to step backwards.
"""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

from backend.app_logging import log_info
from backend.runtime_config import truthy

TRACE_ENV = "TRACE_DB_CONTENTION"

# Below these a block or a request is ordinary and not worth a line.
_HOLD_FLOOR_SECONDS = 1.0
_BLOCK_FLOOR_SECONDS = 3.0
_REQUEST_FLOOR_SECONDS = 1.0

# What takes the write lock. `BEGIN` is absent: sqlite3 defers it to the first real write.
_WRITE_VERBS = ("INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER")


def enabled() -> bool:
    return truthy(os.getenv(TRACE_ENV))


def _is_write(statement) -> bool:
    return str(statement or "").lstrip().upper().startswith(_WRITE_VERBS)


def _short(statement) -> str:
    return " ".join(str(statement).split())[:160]


class TracedCursor(sqlite3.Cursor):
    """Times each fetch and charges it to the statement that produced the rows."""

    _trace_statement = None

    def _timed(self, fetch, *args):
        started = time.monotonic()
        try:
            return fetch(*args)
        finally:
            self.connection._trace_record(self._trace_statement, time.monotonic() - started, counts=False)

    def fetchone(self):
        return self._timed(super().fetchone)

    def fetchmany(self, *args):
        return self._timed(super().fetchmany, *args)

    def fetchall(self):
        return self._timed(super().fetchall)

    def __next__(self):
        return self._timed(super().__next__)


class TracedConnection(sqlite3.Connection):
    """A connection that times every statement and fetch, and reports blocks that were slow."""

    def trace_start(self, resolved_path: str) -> None:
        self._trace_path = resolved_path
        self._block_opened_at = time.monotonic()
        self._block_sql_seconds = 0.0
        self._block_statements = 0
        self._block_slowest = (0.0, None)
        self._hold_start()

    def _hold_start(self) -> None:
        self._hold_first_write_at = None
        self._hold_first_statement = None
        self._hold_writes = 0
        self._hold_write_seconds = 0.0
        self._hold_reads = 0
        self._hold_read_seconds = 0.0
        self._hold_slowest = (0.0, None)

    def _trace_record(self, statement, elapsed: float, *, counts: bool = True) -> None:
        self._block_sql_seconds += elapsed
        self._block_statements += counts
        if elapsed > self._block_slowest[0]:
            self._block_slowest = (elapsed, _short(statement))
        if not _is_write(statement):
            # A read inside a held write transaction keeps the lock exactly as a write does, so it is part of
            # the hold; before the first write it holds nothing.
            if self._hold_first_write_at is not None:
                self._hold_reads += counts
                self._hold_read_seconds += elapsed
            return
        self._hold_writes += counts
        self._hold_write_seconds += elapsed
        if self._hold_first_write_at is None:
            self._hold_first_write_at = time.monotonic() - elapsed
            self._hold_first_statement = _short(statement)
        if elapsed > self._hold_slowest[0]:
            self._hold_slowest = (elapsed, _short(statement))

    def execute(self, statement, *args, **kwargs):
        cursor = self.cursor(TracedCursor)
        cursor._trace_statement = statement
        started = time.monotonic()
        try:
            return cursor.execute(statement, *args, **kwargs)
        finally:
            self._trace_record(statement, time.monotonic() - started)

    def executemany(self, statement, *args, **kwargs):
        cursor = self.cursor(TracedCursor)
        cursor._trace_statement = statement
        started = time.monotonic()
        try:
            return cursor.executemany(statement, *args, **kwargs)
        finally:
            self._trace_record(statement, time.monotonic() - started)

    def commit(self) -> None:
        # A commit inside the block ends the hold, so it is reported and the tally starts over; otherwise the
        # reads after an early commit would be counted as time spent holding the lock.
        super().commit()
        self._report_hold()
        self._hold_start()

    def _report_hold(self) -> None:
        if self._hold_first_write_at is None:
            return
        span = time.monotonic() - self._hold_first_write_at
        if span < _HOLD_FLOOR_SECONDS:
            return
        slowest, slowest_statement = self._hold_slowest
        idle = span - self._hold_write_seconds - self._hold_read_seconds
        log_info(
            f"[db-hold] span {span:.2f}s write {self._hold_write_seconds:.2f}s read {self._hold_read_seconds:.2f}s "
            f"idle {idle:.2f}s slowest-stmt {slowest:.2f}s stmts {self._hold_writes}w/{self._hold_reads}r "
            f"on {Path(self._trace_path).name} | first: {self._hold_first_statement} | slowest: {slowest_statement}",
            keep_in_file=True,
        )

    def trace_finish(self) -> None:
        span = time.monotonic() - self._block_opened_at
        if span < _BLOCK_FLOOR_SECONDS:
            return
        slowest, statement = self._block_slowest
        log_info(
            f"[db-block] span {span:.2f}s sql {self._block_sql_seconds:.2f}s stmts {self._block_statements} "
            f"slowest {slowest:.2f}s | {statement}",
            keep_in_file=True,
        )


def install(app) -> None:
    """Add the request timer, and let a profiler attach to this process. A no-op unless tracing is on."""
    if not enabled():
        return
    _allow_profiler_attach()
    in_flight = [0]

    @app.middleware("http")
    async def _trace_slow_requests(request, call_next):
        started = time.monotonic()
        in_flight[0] += 1
        at_start = in_flight[0]
        try:
            return await call_next(request)
        finally:
            in_flight[0] -= 1
            elapsed = time.monotonic() - started
            if elapsed >= _REQUEST_FLOOR_SECONDS:
                log_info(
                    f"[slow-request] {elapsed:.2f}s {request.method} {request.url.path} in-flight {at_start}",
                    keep_in_file=True,
                )


def _allow_profiler_attach() -> None:
    # A profiler such as py-spy attaches with ptrace, which Linux (`ptrace_scope=1`, the usual default) allows
    # only from an ancestor of the process. `PR_SET_PTRACER_ANY` lifts that for this process alone, so the
    # profiler can be run from another shell while the lane runs. Linux only; elsewhere this does nothing.
    try:
        import ctypes

        pr_set_ptracer, ptracer_any = 0x59616D61, ctypes.c_ulong(-1 & 0xFFFFFFFFFFFFFFFF)
        ctypes.CDLL(None).prctl(pr_set_ptracer, ptracer_any, 0, 0, 0)
    except Exception:
        pass
