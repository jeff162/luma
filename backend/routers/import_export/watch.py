# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Watched import folders — the unattended half of the CSV import.

A data source may name a directory **on the server**; a file that appears there is imported without
anyone opening the Import page. Every outcome an unattended import can produce — duplicates, refused
rows, rows needing review, rule suggestions — already has a review surface on the file's card, so
this module adds a way in and a rule for when to refuse, not new places to report to.

**The refusal rule is about accounts.** A file whose account values do not all resolve to an existing
account is parked rather than imported. Everything else an unattended import gets wrong is visible and
reversible on the card; an invented account quietly splits a ledger. A parked file raises a Task, and
the answer to it is always the same — open this one by hand.

Parking is also how the source's setup gets proven before anything runs alone: a source imports
unattended only once it owns a completed batch, and a file whose header does not match the source's
fingerprint is parked rather than read through a column map built for a different layout.

**Scans are request-driven.** There is deliberately no scheduler — the app is multi-tenant with
per-identity database paths, so a timer thread would have no tenant to run as and no way to choose
one. `maybe_auto_scan` is the watermark-gated catch-up a client calls on app load and on entering
Import / Export, the same shape as `recurring_detection.maybe_auto_scan`; `scan_watched_sources` is
the explicit *Check now*. The nav badge reads the persisted parked count and never scans.

**What keeps a scan cheap** is the per-file `(size, mtime)` watermark in `import_watch_file`:
`os.scandir` yields both for about the cost of the syscall, so only an entry that is new or has moved
since the last pass is read, hashed and parsed. Comparing a file *count* instead would be cheaper and
wrong — a replacement that keeps the count is missed. A file edited in place gets a new mtime, is
re-hashed, and is then matched against `import_batch.file_content_hash`, which is the durable answer
to "have we taken this exact file".

**Purging is opt-in and never guesses.** Only a file this app recorded as imported is eligible, and
the recorded content hash is re-checked against what is on disk immediately before the delete, so a
file swapped in under the same name is never removed. A delete that fails is recorded and reported
rather than swallowed.
"""

import os
import time
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.app_logging import log_error
from backend.authorization import require_admin_or_local
from backend.db.database import get_db
from backend.db.demo_data import is_demo_data_loaded
from backend.json_utils import safe_json_dict
from backend.services.recurring_detection import payee_keys_for_ids, scan_imported_payees
from backend.services.restore_state import require_no_pending_restore
from backend.time_utils import utcnow_iso

from .core import (
    IMPORTED_CATEGORY_SETTINGS_KEY,
    make_import_file_hash,
    parse_csv_text,
    run_import_parsed,
)

router = APIRouter()


# How the per-file record reads. `watching` is the only state a scan acts on; the rest are outcomes.
WATCH_STATE_WATCHING = "watching"
WATCH_STATE_IMPORTED = "imported"
WATCH_STATE_DUPLICATE = "duplicate"
WATCH_STATE_PARKED = "parked"
WATCH_STATE_ERROR = "error"
WATCH_STATE_PURGE_FAILED = "purge_failed"
# Put away by hand: reported once, then left alone until the file itself changes.
WATCH_STATE_DISMISSED = "dismissed"

# The states that mean "this file is waiting on a person", which is what the Task counts.
WATCH_ATTENTION_STATES = (WATCH_STATE_PARKED, WATCH_STATE_ERROR, WATCH_STATE_PURGE_FAILED)

PURGE_NEVER = "never"
PURGE_AFTER_DAYS = "after_days"
PURGE_ON_IMPORT = "on_import"
PURGE_MODES = (PURGE_NEVER, PURGE_AFTER_DAYS, PURGE_ON_IMPORT)

DEFAULT_PURGE_DAYS = 30
MIN_PURGE_DAYS = 1
MAX_PURGE_DAYS = 3650

# How long a scan stays a no-op for. Matches the cadence the value is for: a monthly export nobody is
# waiting on, against a trigger that fires on every app load.
AUTO_SCAN_MIN_INTERVAL_MINUTES = 60
WATCH_LAST_SCAN_META_KEY = "import_watch_last_scan_at"

# A file still being written parses as a truncated one, which is worse than not seeing it. Two
# conditions have to hold before a file is read, and they answer different halves of that: `(size,
# mtime)` unchanged since the previous pass catches a download that is still growing, and an mtime at
# least this old is what stops two rapid passes (two presses of Check now) from satisfying the first
# condition between two writes.
QUIET_SECONDS = 10

# Extensions a half-finished download carries, plus the lock files an office suite leaves beside an
# open document. Matched case-insensitively on the whole name for the lock prefixes.
IGNORED_SUFFIXES = (".part", ".crdownload", ".tmp", ".download", ".partial")
IGNORED_PREFIXES = (".", "~$", ".~lock.")

# Only a CSV is a candidate: a watched folder is a download destination, and the other things that
# land in one are not this source's to read.
CANDIDATE_SUFFIXES = (".csv",)

# An unattended path picks its own files, so it needs its own ceiling — the interactive import is
# bounded by what a person is willing to select. Read into memory whole, like every other import, so
# the cap is about the machine rather than about the format.
MAX_WATCHED_FILE_BYTES = 64 * 1024 * 1024


def clamped_purge_days(value) -> int:
    try:
        days = int(value)
    except (TypeError, ValueError):
        return DEFAULT_PURGE_DAYS
    return max(MIN_PURGE_DAYS, min(MAX_PURGE_DAYS, days))


def normalized_purge_mode(value) -> str:
    mode = str(value or "").strip()
    return mode if mode in PURGE_MODES else PURGE_NEVER


def _ignorable_name(name: str) -> bool:
    lowered = name.lower()
    if any(lowered.startswith(prefix) for prefix in IGNORED_PREFIXES):
        return True
    return any(lowered.endswith(suffix) for suffix in IGNORED_SUFFIXES)


def _is_candidate_name(name: str, filename_pattern: Optional[str]) -> bool:
    if _ignorable_name(name):
        return False
    lowered = name.lower()
    if not any(lowered.endswith(suffix) for suffix in CANDIDATE_SUFFIXES):
        return False
    # A source's filename pattern is not how two sources are told apart — a directory each is — but
    # it is what makes one directory shared by several sources work, and the field already exists and
    # already resolves a source in the preview. Substring, case-insensitive, matching that use.
    pattern = str(filename_pattern or "").strip().lower()
    return pattern in lowered if pattern else True


def _read_file_text(path: str) -> str:
    """Decode a watched file exactly as the upload path decodes a posted one, so the content hash of a
    file dropped in a folder equals the hash of the same file uploaded by hand."""
    with open(path, "rb") as handle:
        content = handle.read()
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return content.decode("latin-1")


def _live_account_ids(conn) -> set[str]:
    return {
        str(row["id"])
        for row in conn.execute("SELECT id FROM account WHERE trashed_at IS NULL").fetchall()
    }


def build_watch_import_config(conn, profile: dict, parsed) -> tuple[Optional[dict], Optional[str]]:
    """Turn a saved source into the config `run_import_parsed` takes, or say why it cannot be run
    unattended.

    The interactive import assembles this in the mapping UI; here it comes entirely from what the
    source already stores, because there is nobody to answer a question. Every refusal is about an
    account that would otherwise have to be invented or guessed — a mapping pointing at an account
    that no longer exists, a value the source has never been shown, or a `new account` entry, which is
    a standing instruction to create one and is exactly what must not happen with nobody watching.
    """
    column_map = safe_json_dict(profile.get("column_map"))
    account_column = str(column_map.get("account") or "").strip()
    live_account_ids = _live_account_ids(conn)

    if not account_column:
        if column_map.get("single_account_new"):
            return None, "This source creates a new account on import, which only a person can approve."
        account_id = str(profile.get("account_id") or "").strip()
        if not account_id:
            return None, "This source has no account set."
        if account_id not in live_account_ids:
            return None, "The account this source imports into no longer exists."
        account_config = {"account_id": account_id, "account_map": None, "skip_accounts": None}
    else:
        if account_column not in parsed.headers:
            return None, f'The file has no "{account_column}" column for this source to read accounts from.'
        assignments = {
            str(key): str(value)
            for key, value in safe_json_dict(column_map.get("account_assignments")).items()
            if key and value
        }
        skips = {str(value) for value in (column_map.get("account_skips") or []) if str(value or "").strip()}
        new_accounts = safe_json_dict(column_map.get("account_new"))
        # A blank cell is not an unmapped account — it is a row the file does not place, and the
        # import already refuses it row by row and records it on the card. Parking the whole file for
        # one would make every trailing footer line a Task.
        present_values = {
            str(row.get(account_column, "") or "").strip()
            for row in parsed.rows[int(profile.get("skip_rows") or 0):]
        }
        present_values.discard("")

        account_map = {}
        unresolved, needing_creation, stale = [], [], []
        for value in sorted(present_values):
            if value in skips:
                continue
            if value in new_accounts:
                needing_creation.append(value)
            elif value in assignments and assignments[value] in live_account_ids:
                account_map[value] = assignments[value]
            elif value in assignments:
                stale.append(value)
            else:
                unresolved.append(value)

        if needing_creation:
            return None, (
                f"{_quoted_list(needing_creation)} would create a new account, "
                "which only a person can approve."
            )
        if stale:
            return None, f"The account mapped for {_quoted_list(stale)} no longer exists."
        if unresolved:
            return None, f"This source has no account mapped for {_quoted_list(unresolved)}."
        account_config = {
            "account_id": None,
            "account_map": account_map,
            "skip_accounts": sorted(skips & present_values),
        }

    cfg = {
        "profile_id": profile["id"],
        "column_map": column_map,
        "date_format": profile.get("date_format") or "%m/%d/%Y",
        "amount_convention": profile.get("amount_convention") or "single_signed",
        "skip_rows": int(profile.get("skip_rows") or 0),
        "apply_categorization": bool(profile.get("apply_categorization")),
        "enrich_from_source": bool(profile.get("enrich_from_source")),
        "use_imported_categories": bool(profile.get("use_imported_categories")),
        "single_account_new": None,
        "new_accounts": None,
        **account_config,
    }
    # The imported-category settings ride inside the stored column map, and `_get_imported_category_settings`
    # already reads them from there, so they need no separate copy into the config.
    if IMPORTED_CATEGORY_SETTINGS_KEY in column_map:
        cfg[IMPORTED_CATEGORY_SETTINGS_KEY] = column_map[IMPORTED_CATEGORY_SETTINGS_KEY]
    return cfg, None


def _quoted_list(values: list[str], limit: int = 3) -> str:
    shown = [f'"{value}"' for value in values[:limit]]
    remaining = len(values) - len(shown)
    if remaining > 0:
        shown.append(f"{remaining} more")
    return ", ".join(shown)


def watched_sources(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT *
        FROM   csv_import_profile
        WHERE  watch_enabled = 1 AND watch_dir IS NOT NULL AND TRIM(watch_dir) != ''
        ORDER  BY name
        """
    ).fetchall()
    return [dict(row) for row in rows]


def attention_counts(conn) -> dict:
    """What is waiting on a person, for the Tasks list and the nav badge. A persisted count — reading
    it must never touch the filesystem."""
    placeholders = ",".join("?" * len(WATCH_ATTENTION_STATES))
    row = conn.execute(
        f"""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN state = ? THEN 1 ELSE 0 END) AS purge_failed
        FROM   import_watch_file
        WHERE  state IN ({placeholders})
        """,
        (WATCH_STATE_PURGE_FAILED, *WATCH_ATTENTION_STATES),
    ).fetchone()
    return {
        "total": int(row["total"] or 0),
        "purge_failed": int(row["purge_failed"] or 0),
    }


def _record_outcome(conn, file_id: str, state: str, *, reason: Optional[str] = None,
                    content_hash: Optional[str] = None, batch_id: Optional[str] = None) -> None:
    conn.execute(
        """
        UPDATE import_watch_file
        SET    state = ?, reason = ?, content_hash = COALESCE(?, content_hash),
               batch_id = ?, resolved_at = ?
        WHERE  id = ?
        """,
        (state, reason, content_hash, batch_id, utcnow_iso(), file_id),
    )


def _scan_directory(profile: dict) -> tuple[list[dict], Optional[str]]:
    """List a source's directory, or say why it could not be. A missing or unreadable directory is a
    source-level notice rather than a failure — removable media and network shares come and go, and a
    folder that is not mounted right now says nothing about whether the setting is still right.

    Each entry is flattened to what the watermark compares, while the directory handle is still open:
    `os.scandir` has the name, the size and the mtime in hand from the readdir, so this is the cheap
    half of a scan and the only part that runs for a folder with nothing new in it."""
    directory = str(profile.get("watch_dir") or "")
    listing = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                try:
                    if not entry.is_file():
                        continue
                    stat = entry.stat()
                except OSError:
                    continue
                listing.append({"name": entry.name, "path": entry.path,
                                "size": stat.st_size, "mtime": stat.st_mtime})
        return listing, None
    except FileNotFoundError:
        return [], "This folder is not there right now."
    except NotADirectoryError:
        return [], "This path is not a folder."
    except PermissionError:
        return [], "This folder cannot be read."
    except OSError as error:
        return [], f"This folder could not be read: {error.strerror or error}"


def _source_has_completed_batch(conn, profile_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM import_batch WHERE profile_id = ? AND status = 'completed' LIMIT 1",
        (profile_id,),
    ).fetchone() is not None


def _already_imported(conn, content_hash: str) -> Optional[str]:
    row = conn.execute(
        """
        SELECT id FROM import_batch
        WHERE  file_content_hash = ? AND status = 'completed'
        ORDER  BY imported_at DESC LIMIT 1
        """,
        (content_hash,),
    ).fetchone()
    return row["id"] if row else None


def _sync_seen_entries(conn, profile: dict, entries: list[dict], now: float) -> list[dict]:
    """Bring the per-file watermark up to date against what is on disk, and return the files a scan
    should act on: the ones that have settled, plus any parked file worth retrying.

    A parked file is retried on every pass because its refusal is about the *ledger* — a missing
    account, a source with nothing imported yet — and that is fixed somewhere else entirely, so
    retrying is what lets the Task clear itself. A file that *errored* is not retried: the cause is
    unknown by definition, and re-running an unknown failure on a timer is a loop with nobody
    watching. It waits for the file to change or for someone to act on it.
    """
    known = {
        row["filename"]: dict(row)
        for row in conn.execute(
            "SELECT * FROM import_watch_file WHERE profile_id = ?", (profile["id"],)
        ).fetchall()
    }
    seen_names = set()
    ready = []
    for entry in entries:
        if not _is_candidate_name(entry["name"], profile.get("filename_pattern")):
            continue
        seen_names.add(entry["name"])
        size, mtime = entry["size"], entry["mtime"]
        row = known.get(entry["name"])
        if row is None:
            conn.execute(
                """
                INSERT INTO import_watch_file (id, profile_id, filename, size, mtime, state)
                VALUES (?,?,?,?,?,?)
                """,
                (str(uuid.uuid4()), profile["id"], entry["name"], size, mtime, WATCH_STATE_WATCHING),
            )
            continue
        moved = int(row["size"] or 0) != size or abs(float(row["mtime"] or 0) - mtime) > 1e-6
        if moved:
            conn.execute(
                """
                UPDATE import_watch_file
                SET    size = ?, mtime = ?, state = ?, reason = NULL, content_hash = NULL,
                       batch_id = NULL, resolved_at = NULL
                WHERE  id = ?
                """,
                (size, mtime, WATCH_STATE_WATCHING, row["id"]),
            )
            continue
        if row["state"] not in (WATCH_STATE_WATCHING, WATCH_STATE_PARKED):
            continue
        if now - mtime < QUIET_SECONDS:
            continue
        ready.append({**row, "size": size, "mtime": mtime, "path": entry["path"]})

    # A file that is gone from the folder takes its watermark with it: nothing about it is worth
    # keeping once it cannot be looked at, and `import_batch.file_content_hash` is what remembers that
    # it was imported.
    for name, row in known.items():
        if name not in seen_names:
            conn.execute("DELETE FROM import_watch_file WHERE id = ?", (row["id"],))
    return ready


def _import_ready_file(profile: dict, candidate: dict) -> dict:
    """Read, judge and (if it passes) import one settled file. Returns the outcome to record.

    Each database touch is its own short transaction: the import owns a long one of its own, and a
    connection held open across it would make this scan's own bookkeeping invisible to the request
    that is running it.
    """
    if int(candidate["size"] or 0) > MAX_WATCHED_FILE_BYTES:
        return {"state": WATCH_STATE_PARKED,
                "reason": f"This file is larger than {MAX_WATCHED_FILE_BYTES // (1024 * 1024)} MB."}
    try:
        text = _read_file_text(candidate["path"])
    except OSError as error:
        return {"state": WATCH_STATE_ERROR, "reason": f"This file could not be read: {error.strerror or error}"}

    content_hash = make_import_file_hash(text)
    with get_db() as conn:
        existing_batch_id = _already_imported(conn, content_hash)
    if existing_batch_id:
        return {"state": WATCH_STATE_DUPLICATE, "reason": "This exact file has been imported already.",
                "content_hash": content_hash, "batch_id": existing_batch_id}

    try:
        parsed = parse_csv_text(text)
    except Exception as error:  # a malformed CSV is the file's problem, not this scan's
        return {"state": WATCH_STATE_PARKED, "reason": f"This file could not be read as a CSV: {error}",
                "content_hash": content_hash}

    fingerprint = str(profile.get("header_fingerprint") or "").strip()
    if fingerprint and fingerprint != parsed.fingerprint:
        return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                "reason": "This file's columns are not the ones this source is set up for."}

    with get_db() as conn:
        if not _source_has_completed_batch(conn, profile["id"]):
            return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                    "reason": "Import one file from this source by hand first, so its setup is proven."}
        cfg, refusal = build_watch_import_config(conn, profile, parsed)
    if refusal:
        return {"state": WATCH_STATE_PARKED, "reason": refusal, "content_hash": content_hash}

    try:
        result = run_import_parsed(parsed, cfg, filename=candidate["filename"])
    except HTTPException as error:
        detail = error.detail
        message = detail.get("message") if isinstance(detail, dict) else detail
        return {"state": WATCH_STATE_PARKED, "reason": str(message), "content_hash": content_hash}
    except Exception as error:
        log_error(f"[import-watch] import failed for {candidate['filename']}: {error}", exc_info=error)
        return {"state": WATCH_STATE_ERROR, "reason": f"The import failed: {error}",
                "content_hash": content_hash}

    return {"state": WATCH_STATE_IMPORTED, "content_hash": content_hash,
            "batch_id": result.get("batch_id"), "imported": int(result.get("imported") or 0),
            "reason": None}


def _purge_pass(conn, profile: dict) -> list[dict]:
    """Delete the files this source is configured to clean up, and only those.

    Eligibility is never "everything older than N days in that folder": a row has to name a file this
    app itself recorded as imported, and the content on disk is re-hashed immediately before the
    delete so that a file replaced under the same name since is left alone.
    """
    mode = normalized_purge_mode(profile.get("watch_purge_mode"))
    if mode == PURGE_NEVER:
        return []
    params = [profile["id"], WATCH_STATE_IMPORTED, WATCH_STATE_DUPLICATE]
    age_clause = ""
    if mode == PURGE_AFTER_DAYS:
        age_clause = "AND julianday('now') - julianday(resolved_at) >= ?"
        params.append(clamped_purge_days(profile.get("watch_purge_days")))
    rows = conn.execute(
        f"""
        SELECT * FROM import_watch_file
        WHERE  profile_id = ? AND state IN (?, ?) AND content_hash IS NOT NULL
               AND resolved_at IS NOT NULL {age_clause}
        """,
        params,
    ).fetchall()

    purged = []
    directory = str(profile.get("watch_dir") or "")
    for row in rows:
        path = os.path.join(directory, row["filename"])
        try:
            if make_import_file_hash(_read_file_text(path)) != row["content_hash"]:
                _record_outcome(
                    conn, row["id"], WATCH_STATE_PURGE_FAILED, content_hash=row["content_hash"],
                    reason="This file changed after it was imported, so it was left in place.",
                )
                continue
            os.remove(path)
        except FileNotFoundError:
            conn.execute("DELETE FROM import_watch_file WHERE id = ?", (row["id"],))
            continue
        except OSError as error:
            _record_outcome(
                conn, row["id"], WATCH_STATE_PURGE_FAILED, content_hash=row["content_hash"],
                reason=f"This file could not be deleted: {error.strerror or error}",
            )
            continue
        conn.execute("DELETE FROM import_watch_file WHERE id = ?", (row["id"],))
        purged.append({"filename": row["filename"]})
    return purged


def scan_watched_sources(*, profile_id: Optional[str] = None) -> dict:
    """Walk every watched source once. The whole unattended path, and the body of both triggers."""
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            return {"skipped": "demo_data_loaded", "sources": []}
        require_no_pending_restore(conn, "importing")
        sources = [p for p in watched_sources(conn) if not profile_id or p["id"] == profile_id]

    summaries = []
    imported_batch_ids = []
    for profile in sources:
        entries, notice = _scan_directory(profile)
        with get_db() as conn:
            conn.execute(
                "UPDATE csv_import_profile SET watch_notice = ?, watch_last_scan_at = ? WHERE id = ?",
                (notice, utcnow_iso(), profile["id"]),
            )
            ready = [] if notice else _sync_seen_entries(conn, profile, entries, time.time())

        imported, parked = 0, 0
        for candidate in ready:
            outcome = _import_ready_file(profile, candidate)
            with get_db() as conn:
                _record_outcome(
                    conn, candidate["id"], outcome["state"], reason=outcome.get("reason"),
                    content_hash=outcome.get("content_hash"), batch_id=outcome.get("batch_id"),
                )
            if outcome["state"] == WATCH_STATE_IMPORTED:
                imported += 1
                if outcome.get("batch_id"):
                    imported_batch_ids.append(outcome["batch_id"])
            elif outcome["state"] in WATCH_ATTENTION_STATES:
                parked += 1

        with get_db() as conn:
            purged = _purge_pass(conn, profile)
        summaries.append({
            "profile_id": profile["id"], "name": profile["name"], "notice": notice,
            "imported": imported, "parked": parked, "purged": len(purged),
        })

    _rescan_recurring_for(imported_batch_ids)
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)",
            (WATCH_LAST_SCAN_META_KEY, utcnow_iso()),
        )
        counts = attention_counts(conn)
    return {"sources": summaries, "attention": counts}


def _rescan_recurring_for(batch_ids: list[str]) -> None:
    """New data means recurring detection is behind, exactly as it is after an interactive import. Kept
    out of the import itself for the same reason `POST /run` keeps it out: a detection hiccup must
    never fail an import that already committed."""
    if not batch_ids:
        return
    try:
        with get_db() as conn:
            placeholders = ",".join("?" * len(batch_ids))
            ids = [
                row["id"] for row in conn.execute(
                    f"SELECT id FROM txn WHERE import_batch_id IN ({placeholders})", batch_ids
                ).fetchall()
            ]
            scan_imported_payees(conn, payee_keys_for_ids(conn, ids))
    except Exception as error:
        log_error(f"[import-watch] recurring auto-scan failed: {error}", exc_info=error)


def maybe_auto_scan() -> dict:
    """The app-load / page-entry catch-up: scan only if one is due. Cheap enough to call
    unconditionally, which is the point — no caller has to know when the last scan was."""
    with get_db() as conn:
        if not watched_sources(conn):
            return {"skipped": "no_watched_sources"}
        row = conn.execute(
            "SELECT value FROM db_meta WHERE key = ?", (WATCH_LAST_SCAN_META_KEY,)
        ).fetchone()
        last = row["value"] if row else None
        if last:
            # julianday() parses the stored datetime; a malformed value yields NULL → treat as due.
            due = conn.execute(
                "SELECT ((julianday('now') - julianday(?)) * 1440.0 >= ?) IS NOT 0 AS due",
                (last, AUTO_SCAN_MIN_INTERVAL_MINUTES),
            ).fetchone()["due"]
            if not due:
                return {"skipped": "recent", "last_scan_at": last}
    return scan_watched_sources()


def disable_watching(conn, reason: str) -> int:
    """Switch every watched folder off, keeping the paths. Called when a restore has brought another
    machine's settings in (see `backup.py`): the paths are the previous machine's, and a path that
    resolves here means something else. The count is what the Task reports."""
    rows = conn.execute(
        "SELECT id FROM csv_import_profile WHERE watch_enabled = 1"
    ).fetchall()
    if not rows:
        return 0
    conn.execute(
        "UPDATE csv_import_profile SET watch_enabled = 0, watch_notice = ? WHERE watch_enabled = 1",
        (reason,),
    )
    conn.execute("DELETE FROM import_watch_file")
    return len(rows)


# ---------------------------------------------------------------------------------------------
# Endpoints


class WatchSettings(BaseModel):
    watch_dir: Optional[str] = None
    watch_enabled: Optional[bool] = None
    watch_purge_mode: Optional[str] = None
    watch_purge_days: Optional[int] = None


@router.get("/watch/status")
def watch_status():
    """What every watched source is doing, without touching the filesystem."""
    with get_db() as conn:
        sources = conn.execute(
            """
            SELECT id, name, watch_dir, watch_enabled, watch_notice, watch_last_scan_at,
                   watch_purge_mode, watch_purge_days
            FROM   csv_import_profile
            WHERE  watch_dir IS NOT NULL AND TRIM(watch_dir) != ''
            ORDER  BY name
            """
        ).fetchall()
        files = conn.execute(
            """
            SELECT id, profile_id, filename, state, reason, batch_id, resolved_at
            FROM   import_watch_file
            WHERE  state != ?
            ORDER  BY resolved_at DESC, filename
            """,
            (WATCH_STATE_WATCHING,),
        ).fetchall()
        last_scan = conn.execute(
            "SELECT value FROM db_meta WHERE key = ?", (WATCH_LAST_SCAN_META_KEY,)
        ).fetchone()
        counts = attention_counts(conn)
    return {
        "sources": [dict(row) for row in sources],
        "files": [dict(row) for row in files],
        "last_scan_at": last_scan["value"] if last_scan else None,
        "attention": counts,
    }


@router.post("/watch/scan")
def watch_scan(profile_id: Optional[str] = None):
    """Check now."""
    return scan_watched_sources(profile_id=profile_id)


@router.post("/watch/auto-scan")
def watch_auto_scan():
    return maybe_auto_scan()


@router.patch("/profiles/{profile_id}/watch", dependencies=[Depends(require_admin_or_local)])
def set_profile_watch(profile_id: str, body: WatchSettings):
    """Point a data source at a folder, or change what happens to the files in it.

    Admin-or-local, unlike the rest of a data source: naming a directory is a statement about the
    *server's* filesystem rather than about the ledger, which is the same line `require_admin_or_local`
    already draws around environment settings. Everyone can see that a source is watched; only an
    administrator can say which folder. A route dependency rather than a call in the body, so the refusal
    lands before the path is even looked up and the guard is testable the way the restore paths' is.
    """
    with get_db() as conn:
        row = conn.execute("SELECT id FROM csv_import_profile WHERE id = ?", (profile_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Data source not found")
        fields, params = [], []
        if body.watch_dir is not None:
            directory = body.watch_dir.strip()
            fields += ["watch_dir = ?", "watch_notice = NULL"]
            params.append(directory or None)
            if not directory:
                fields.append("watch_enabled = 0")
        if body.watch_enabled is not None:
            fields.append("watch_enabled = ?")
            params.append(1 if body.watch_enabled else 0)
        if body.watch_purge_mode is not None:
            fields.append("watch_purge_mode = ?")
            params.append(normalized_purge_mode(body.watch_purge_mode))
        if body.watch_purge_days is not None:
            fields.append("watch_purge_days = ?")
            params.append(clamped_purge_days(body.watch_purge_days))
        if fields:
            params.append(profile_id)
            conn.execute(f"UPDATE csv_import_profile SET {', '.join(fields)} WHERE id = ?", params)
        # A folder that has just changed says nothing about the files judged against the old one.
        if body.watch_dir is not None:
            conn.execute("DELETE FROM import_watch_file WHERE profile_id = ?", (profile_id,))
    return {"ok": True}


@router.get("/watch/files/{file_id}/content", response_class=PlainTextResponse)
def watch_file_content(file_id: str):
    """The parked file itself, so the ordinary import flow can be opened with it pre-seeded. A parked
    file is one this app already decided it cannot take unattended; handing it back to the flow that
    *can* ask questions is the whole answer to a parked file."""
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT w.filename, w.state, p.watch_dir
            FROM   import_watch_file w
            JOIN   csv_import_profile p ON p.id = w.profile_id
            WHERE  w.id = ?
            """,
            (file_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="File not found")
    path = os.path.join(str(row["watch_dir"] or ""), row["filename"])
    try:
        return PlainTextResponse(_read_file_text(path), media_type="text/csv")
    except OSError as error:
        raise HTTPException(status_code=404, detail=f"This file could not be read: {error.strerror or error}")


@router.delete("/watch/files/{file_id}")
def dismiss_watch_file(file_id: str):
    """Stop reporting a file without touching it. The file stays where it is and the watermark row
    stays with it, marked dismissed — deleting the row would only invite the next scan to rediscover
    the file and report it again. Editing the file clears the mark, since that is a new question."""
    with get_db() as conn:
        conn.execute(
            "UPDATE import_watch_file SET state = ?, reason = NULL, resolved_at = ? WHERE id = ?",
            (WATCH_STATE_DISMISSED, utcnow_iso(), file_id),
        )
    return {"ok": True}
