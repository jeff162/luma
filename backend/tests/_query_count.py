"""Shared test helper for asserting batch operations don't issue per-row (N+1) queries.

Wraps sqlite3's statement trace so a test can run a batch operation over N rows and assert the number
of times a given table is queried stays flat (the hoisted-once count) instead of scaling with N. Used
by the categorizer perf-contract test; reusable for any batch endpoint (dedupe sweep, summaries, …).
"""

from contextlib import contextmanager


@contextmanager
def trace_queries(conn):
    """Yield a list that collects every SQL statement executed on `conn` inside the block."""
    statements: list[str] = []
    conn.set_trace_callback(statements.append)
    try:
        yield statements
    finally:
        conn.set_trace_callback(None)

