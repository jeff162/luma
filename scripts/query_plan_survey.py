"""
Survey the backend's SQL for queries that read a whole large table, against a copy of a real ledger.

    backend/venv/bin/python scripts/query_plan_survey.py --db <path to luma-data.db> [--out data/query-survey]

1. Copies the ledger twice with SQLite's backup API (safe against a running instance; the original is only
   read): one with no planner statistics, one with them gathered the way the app gathers them
   (`refresh_planner_statistics`).
2. Runs the backend suite with `query_plan_trace.py`, recording every distinct statement and its caller.
3. Runs `EXPLAIN QUERY PLAN` for each on both copies, flags a full scan of any table of at least
   `--big-rows` rows, and times the flagged reads and every read whose plan the statistics change.

The report lists the call sites whose full scans cost at least `--min-ms`, with their time on each copy,
and how many reads the statistics make faster or slower. `results.json` in `--out` holds every statement
with both plans and timings.

**The statements carry the test suite's values.** A whole-table read costs the same whatever it looks
for, so those timings are representative; a lookup by an id that does not exist in the copy returns at
once, so a query that seeks by id reads as faster than it is. Re-check a finding with real values before
acting on it. A full scan is not a defect by itself: a text search or an all-time report reads every row
by design. The finding to look for is a scan where an index could have started the query.
"""

import argparse
import collections
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
# Taken before the backend import below, which can load the developer's `.env` into the environment; the
# suite runs with the environment as the shell gave it, as it does run on its own.
_SHELL_ENV = dict(os.environ)

from backend.db.database import PLANNER_STATISTICS_ANALYSIS_LIMIT  # noqa: E402

_ALIAS = re.compile(r"\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?", re.I)
_NOT_ALIAS = {"where", "on", "join", "left", "inner", "cross", "group", "order", "limit", "using",
              "natural", "union", "select", "set", "values", "outer", "as"}
_FULL_SCAN = re.compile(r"^SCAN (\w+)(?: USING (?:COVERING )?INDEX \w+)?$")
_TIME_LIMIT_SECONDS = 3


def _copy(source: Path, target: Path, analyze: bool):
    target.unlink(missing_ok=True)
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(target, isolation_level=None)
    try:
        src.backup(dst)
        if analyze:
            dst.execute(f"PRAGMA analysis_limit = {PLANNER_STATISTICS_ANALYSIS_LIMIT}")
            dst.execute("ANALYZE")
        else:
            # A running app gathers statistics, so the ledger usually holds some; the baseline has none.
            stat_tables = [row[0] for row in dst.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sqlite_stat%'")]
            for table in stat_tables:
                dst.execute(f"DELETE FROM {table}")
    finally:
        src.close()
        dst.close()


def _trace(out: Path):
    trace_dir = out / "trace"
    trace_dir.mkdir(parents=True, exist_ok=True)
    for old in trace_dir.glob("trace-*.json"):
        old.unlink()
    env = dict(_SHELL_ENV, SQLTRACE_OUT=str(trace_dir), PYTHONPATH=str(REPO / "scripts"))
    subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "query_plan_trace", "-n", "auto"],
        cwd=REPO / "backend", env=env, check=True,
    )
    shapes: dict[str, list] = {}
    for path in glob.glob(str(trace_dir / "trace-*.json")):
        with open(path, encoding="utf-8") as trace:
            for key, (sql, calls, caller) in json.load(trace).items():
                if key in shapes:
                    shapes[key][1] += calls
                    shapes[key][2] = shapes[key][2] or caller
                else:
                    shapes[key] = [sql, calls, caller]
    return shapes


def _plan(conn, sql):
    try:
        return [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + sql)]
    except sqlite3.Error:
        return None


def _time(conn, sql, runs=3):
    # Aborted past the limit, so one runaway statement cannot stall the survey.
    deadline = [0.0]
    conn.set_progress_handler(lambda: 1 if time.perf_counter() > deadline[0] else 0, 10000)
    try:
        deadline[0] = time.perf_counter() + _TIME_LIMIT_SECONDS
        conn.execute(sql).fetchall()
        started = time.perf_counter()
        for _ in range(runs):
            deadline[0] = time.perf_counter() + _TIME_LIMIT_SECONDS
            conn.execute(sql).fetchall()
        return (time.perf_counter() - started) / runs * 1000
    except sqlite3.Error:
        return None
    finally:
        conn.set_progress_handler(None, 0)


def _scanned_tables(sql, plan, big):
    aliases = {}
    for table, alias in _ALIAS.findall(sql):
        aliases[table.lower()] = table.lower()
        if alias and alias.lower() not in _NOT_ALIAS:
            aliases[alias.lower()] = table.lower()
    scanned = set()
    for step in plan:
        match = _FULL_SCAN.match(step)
        if match:
            table = aliases.get(match.group(1).lower(), match.group(1).lower())
            if table in big:
                scanned.add(table)
    return sorted(scanned)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    parser.add_argument("--db", required=True, type=Path, help="the ledger database to survey (only read)")
    parser.add_argument("--out", type=Path, default=REPO / "data" / "query-survey")
    parser.add_argument("--big-rows", type=int, default=2000, help="a table this size or larger is large")
    parser.add_argument("--min-ms", type=float, default=5.0, help="report call sites whose scans cost this much")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    plain, analyzed = args.out / "plain.db", args.out / "analyzed.db"
    _copy(args.db, plain, analyze=False)
    _copy(args.db, analyzed, analyze=True)
    shapes = _trace(args.out)

    a = sqlite3.connect(f"file:{plain}?mode=ro", uri=True)
    b = sqlite3.connect(f"file:{analyzed}?mode=ro", uri=True)
    big = {name for (name,) in a.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
           if a.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] >= args.big_rows}
    results = []
    for sql, calls, caller in shapes.values():
        plan_a = _plan(a, sql)
        if plan_a is None:
            continue  # a statement on another database (the control database), or a table the copy lacks
        plan_b = _plan(b, sql)
        scanned = _scanned_tables(sql, plan_a, big)
        is_read = sql.lstrip().upper().startswith(("SELECT", "WITH"))
        changed = plan_a != plan_b
        ms_a = ms_b = None
        if is_read and (scanned or changed):
            ms_a, ms_b = _time(a, sql), _time(b, sql)
        results.append(dict(caller=caller, sql=sql, calls=calls, scanned=scanned, changed=changed, read=is_read,
                            ms_plain=ms_a, ms_analyzed=ms_b, plan_plain=plan_a, plan_analyzed=plan_b))
    with open(args.out / "results.json", "w", encoding="utf-8") as out:
        json.dump(results, out, indent=1)

    print(f"\n{len(shapes)} distinct statements traced, {len(results)} explainable on the ledger copy")
    print(f"large tables (>= {args.big_rows} rows): {', '.join(sorted(big))}")
    flagged = [r for r in results if r["scanned"] and r["read"] and (r["ms_plain"] or 0) >= args.min_ms]
    by_site = collections.defaultdict(list)
    for row in flagged:
        caller = row["caller"] or "?:?:?"
        path, _, function = caller.rsplit(":", 2)
        by_site[f"{path}:{function}"].append(row)
    print(f"\nCall sites with full scans costing >= {args.min_ms} ms (summed over their statements):")
    print(f"{'site':72} {'shapes':>6} {'no stats':>9} {'stats':>9}")
    for site, rows in sorted(by_site.items(), key=lambda kv: -sum(r["ms_plain"] for r in kv[1])):
        plain_ms = sum(r["ms_plain"] for r in rows)
        analyzed_ms = sum(r["ms_analyzed"] or 0 for r in rows)
        print(f"{site:72} {len(rows):6} {plain_ms:8.0f}ms {analyzed_ms:8.0f}ms")
    timed = [r for r in results if r["changed"] and r["read"] and r["ms_plain"] is not None
             and r["ms_analyzed"] is not None]
    faster = [r for r in timed if r["ms_plain"] > r["ms_analyzed"] * 1.5 and r["ms_plain"] - r["ms_analyzed"] > 1]
    slower = [r for r in timed if r["ms_analyzed"] > r["ms_plain"] * 1.5 and r["ms_analyzed"] - r["ms_plain"] > 1]
    print(f"\nReads whose plan the statistics change: {len(timed)}; faster {len(faster)}, slower {len(slower)}")
    for row in sorted(slower, key=lambda r: r["ms_plain"] - r["ms_analyzed"]):
        print(f"  slower: {row['caller']}  {row['ms_plain']:.1f} -> {row['ms_analyzed']:.1f} ms")
    print(f"\nEvery statement, with both plans: {args.out / 'results.json'}")


if __name__ == "__main__":
    main()
