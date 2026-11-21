"""
A pytest plugin for `query_plan_survey.py`: records one example of every distinct SQL statement the
backend suite runs, with the backend function that issued it.

Loaded with `-p query_plan_trace` and `SQLTRACE_OUT` set to a directory. It wraps `sqlite3.connect` so
every connection reports its statements through SQLite's trace callback. Statements are grouped by shape
(literals and IN lists collapsed), and each worker process writes its shapes to
`<SQLTRACE_OUT>/trace-<pid>.json` on exit. A test that installs its own trace callback replaces this one
on that connection, so its statements are missed.
"""

import atexit
import json
import os
import re
import sqlite3
import sys

_OUT = os.environ["SQLTRACE_OUT"]
_STRING = re.compile(r"'(?:[^']|'')*'")
_NUMBER = re.compile(r"(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])")
_LIST = re.compile(r"\(\s*\?(?:\s*,\s*\?)+\s*\)")
_SPACE = re.compile(r"\s+")
_RECORDED = ("SELECT", "WITH", "UPDATE", "DELETE", "INSERT")
_seen: dict[str, list] = {}


def _shape(sql: str) -> str:
    collapsed = _NUMBER.sub("?", _STRING.sub("?", sql))
    return _SPACE.sub(" ", _LIST.sub("(?+)", collapsed)).strip()


def _caller():
    # The innermost backend frame outside the tests and the connection helper: the code that wrote the query.
    frame = sys._getframe(2)
    while frame:
        name = frame.f_code.co_filename
        if "/backend/" in name and "/tests/" not in name and "/venv/" not in name and not name.endswith("db/database.py"):
            return f"{name.split('/backend/', 1)[1]}:{frame.f_lineno}:{frame.f_code.co_name}"
        frame = frame.f_back
    return None


def _record(sql: str):
    if not sql.lstrip()[:6].upper().startswith(_RECORDED):
        return
    key = _shape(sql)
    entry = _seen.get(key)
    if entry is None:
        _seen[key] = [sql, 1, _caller()]
    else:
        entry[1] += 1


_connect = sqlite3.connect


def _traced_connect(*args, **kwargs):
    conn = _connect(*args, **kwargs)
    conn.set_trace_callback(_record)
    return conn


sqlite3.connect = _traced_connect


@atexit.register
def _write():
    with open(os.path.join(_OUT, f"trace-{os.getpid()}.json"), "w", encoding="utf-8") as out:
        json.dump(_seen, out)
