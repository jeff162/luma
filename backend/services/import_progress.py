# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
How far a running file import has got, for the browser to poll while the upload's request is open.

A file import is one request holding one write transaction from its first row to its commit, so nothing
it does is visible to another request until it is over — the sync's progress, which is committed per page
and read back from the database, has no equivalent here. This registry is the other half of that bargain:
progress lives in process memory, outside any transaction, so a second request can read it mid-run. It is
transient by design — an entry exists only while its import runs and is never persisted, so a restart or
a finished run leaves nothing behind, and a poll that finds no entry just means "nothing to report".

The client names the run (`progress_id`, sent with the upload), since it has to know what to poll for
before the response that would otherwise carry an id comes back. Entries are keyed by the requesting
tenant's database path as well, so one tenant cannot read another's progress by guessing the name.
"""

import threading
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

from backend.db.database import current_db_path

# A client-chosen name is bounded so the registry cannot be used to park arbitrary data in memory.
MAX_PROGRESS_ID_LENGTH = 64

_lock = threading.Lock()
_runs: dict[tuple[str, str], dict] = {}


def _key(progress_id: str) -> tuple[str, str]:
    return (current_db_path(), progress_id)


@contextmanager
def tracked_import(progress_id: Optional[str]) -> Iterator[Optional[Callable[[int, int], None]]]:
    """Register a run for the duration of the block and yield the `(done, total)` callback the import
    reports through; yields None when the caller named no run (or an unusable name), so an untracked
    import is the same code path with nothing listening. The entry is removed however the block exits."""
    if not isinstance(progress_id, str) or not progress_id or len(progress_id) > MAX_PROGRESS_ID_LENGTH:
        yield None
        return
    key = _key(progress_id)
    entry = {"done": 0, "total": None}
    with _lock:
        _runs[key] = entry

    def report(done: int, total: int) -> None:
        entry["total"] = total
        entry["done"] = done

    try:
        yield report
    finally:
        with _lock:
            _runs.pop(key, None)


def import_progress(progress_id: str) -> Optional[dict]:
    """The named run's `{done, total}`, or None when no such run is in flight for this tenant. `total` is
    None until the import has parsed the file and reached its first row."""
    with _lock:
        entry = _runs.get(_key(progress_id))
        return dict(entry) if entry is not None else None
