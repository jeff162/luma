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
fingerprint is parked rather than read through a column map built for a different layout. That one is
recoverable without touching the source's settings — an import by hand updates the stored fingerprint
(`core.run_import_parsed`), so the folder resumes once a person has seen the new columns.

**Scans are request-driven.** There is deliberately no scheduler — the app is multi-tenant with
per-identity database paths, so a timer thread would have no tenant to run as and no way to choose
one. `maybe_auto_scan` is the watermark-gated catch-up a client calls on app load and on entering
Import, the same shape as `recurring_detection.maybe_auto_scan`; `scan_watched_sources` is
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

**Where a source may watch is the operator's call, not the app's.** On an installation other devices
can reach, watching is confined to the folders named in `WATCH_FOLDER_ROOTS` and is off until some are,
because an administrator in the app need not be anyone with a shell on the machine, and the folder is
the machine's filesystem. Only an installation this computer alone can open watches anywhere by default.
Every path that touches the disk is checked against it — saving a folder, the picker, the scan and its
purge, handing a parked file back — so a folder saved before the setting changed stops being read rather
than slipping through (`security-model.md` → *Reading and deleting outside the data directory*).

**Which files a source takes, and how each is read, is one table** (`_FILE_KINDS_BY_SOURCE`): a CSV
through the source's column map, an Amazon export through the marketplace importer, a PayPal statement
PDF through the statement importer. The scan, the purge's re-hash, the folder picker and the hand-off
of a parked file all look a file up there, so none of them can disagree about what a file is.
"""

import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from backend import app_config
from backend.app_logging import log_error
from backend.authorization import require_admin_or_local
from backend.runtime_config import app_name, data_dir
from backend.db.database import get_db, single_runner
from backend.db.demo_data import is_demo_data_loaded
from backend.json_utils import safe_json_dict
from backend.services.ledger_currency import get_ledger_currency
from backend.services.paypal_statement import StatementError, read_statement
from backend.services.recurring_detection import settle_owed_rescans
from backend.services.restore_state import require_no_pending_restore
from backend.time_utils import utcnow_iso
from backend.transport import reachable_from_network

from .core import (
    IMPORTED_CATEGORY_SETTINGS_KEY,
    PAYPAL_SOURCE_KIND,
    make_import_file_hash,
    parse_csv_text,
    run_import_parsed,
)
from .paypal_statement import (
    _check_assignments,
    _config as _statement_config,
    _parsed as _statement_parsed,
    _statement_accounts,
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

# A marketplace source (`csv_import_profile.source_kind`) watches a folder exactly as a CSV source does,
# but its files go through the vendor's own importer rather than a column map. Spelled here rather than
# imported from `amazon` to keep this module's import of that one lazy (it imports `core`, as this does).
AMAZON_SOURCE_KIND = "marketplace:amazon"

# An unattended path picks its own files, so it needs its own ceiling — the interactive import is
# bounded by what a person is willing to select. Read into memory whole, like every other import, so
# the cap is about the machine rather than about the format.
MAX_WATCHED_FILE_BYTES = 64 * 1024 * 1024


WATCHING_NOT_ENABLED = (
    "Watching folders is not enabled on this server. It is turned on by naming the folders it may watch "
    "in WATCH_FOLDER_ROOTS, in the server's .env file."
)
OUTSIDE_WATCH_ROOTS = "This folder is outside the folders this server may watch (WATCH_FOLDER_ROOTS)."


def allowed_watch_roots() -> Optional[list[str]]:
    """The folders watching is confined to, resolved; `None` when any folder may be watched, and an empty
    list when none may. Resolved through symlinks, as the folders checked against them are, so a link
    inside a root that points outside it is outside."""
    roots = app_config.watch_folder_roots()
    if not roots and not reachable_from_network():
        return None
    return [os.path.realpath(os.path.expanduser(root)) for root in roots]


def _within(path: str, root: str) -> bool:
    path, root = os.path.normcase(path), os.path.normcase(root)
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:  # different drives on Windows
        return False


def watch_folder_refusal(path: str) -> Optional[str]:
    """Why this folder may not be watched here, or None when it may."""
    roots = allowed_watch_roots()
    if roots is None:
        return None
    if not roots:
        return WATCHING_NOT_ENABLED
    resolved = os.path.realpath(os.path.expanduser(path))
    return None if any(_within(resolved, root) for root in roots) else OUTSIDE_WATCH_ROOTS


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


def _is_candidate_name(name: str, profile: dict) -> bool:
    if _ignorable_name(name) or _file_kind(profile.get("source_kind"), name) is None:
        return False
    # A source's filename pattern is not how two sources are told apart — a directory each is — but
    # it is what makes one directory shared by several sources work, and the field already exists and
    # already resolves a source in the preview. Substring, case-insensitive, matching that use.
    pattern = str(profile.get("filename_pattern") or "").strip().lower()
    return pattern in name.lower() if pattern else True


def _read_file_bytes(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def _read_file_text(path: str) -> str:
    """Decode a watched file exactly as the upload path decodes a posted one, so the content hash of a
    file dropped in a folder equals the hash of the same file uploaded by hand."""
    content = _read_file_bytes(path)
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
    refusal = watch_folder_refusal(directory)
    if refusal:
        return [], refusal
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
        if not _is_candidate_name(entry["name"], profile):
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
    kind = _file_kind(profile.get("source_kind"), candidate["filename"])
    try:
        content = kind.read(candidate["path"])
    except OSError as error:
        return {"state": WATCH_STATE_ERROR, "reason": f"This file could not be read: {error.strerror or error}"}
    return kind.import_file(profile, candidate, content)


def _import_ready_csv_file(profile: dict, candidate: dict, text: str) -> dict:
    """A CSV read through the source's own column map — the ordinary case."""
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
        # The way out is stated because there is one and it is not obvious: an import by hand teaches
        # the source the columns it was shown, after which this folder resumes on its own.
        return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                "reason": "This file's columns are not the ones this source is set up for. "
                          "Import one of these files by hand and the source will learn the new "
                          "columns, after which this folder runs on its own again."}

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


def _import_ready_amazon_file(profile: dict, candidate: dict, text: str) -> dict:
    """The marketplace half of `_import_ready_file`: one AZAD export out of an Amazon source's folder.

    The shape is the CSV path's, and so is the refusal rule — *park anything the saved source does not
    answer* — but the questions differ. There is no column map to check a header against, because an
    AZAD export is recognized by its own header (`read_export`); what the saved source has to answer
    instead is which Amazon account the orders land in and which real account each paying card charges.
    An unmapped card is the exact analogue of an unmapped account value: resolving it wrong moves a
    charge into the wrong ledger account quietly, and the interactive form refuses to import until every
    card is mapped, so the unattended path must refuse too rather than take the looser option.

    Orders and items files are scanned independently, which is correct: the importer accepts either
    alone, parks an items file's detail until its orders arrive, and folds the two cards together
    whichever lands first.
    """
    # Lazy, like core.py's own: `amazon` imports `core`, which this module also imports from.
    from .amazon import (
        _imported_amazon_file_hashes,
        _scan_instruments,
        read_amazon_exports,
        run_amazon_import,
    )
    from backend.services.amazon_import import merge

    content_hash = make_import_file_hash(text)
    with get_db() as conn:
        taken = _imported_amazon_file_hashes(conn)
    if content_hash in taken:
        prior = taken[content_hash]
        return {"state": WATCH_STATE_DUPLICATE, "content_hash": content_hash,
                "batch_id": prior.get("batch_id"),
                "reason": "This exact file has been imported already."}

    try:
        orders, items_by_order, names, unrecognized, _skipped, file_hashes = read_amazon_exports(
            [(candidate["filename"], text)])
    except Exception as error:   # a malformed export is the file's problem, not this scan's
        return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                "reason": f"This file could not be read as an Amazon export: {error}"}
    if unrecognized or (not orders and not items_by_order):
        return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                "reason": "This file is not an Amazon orders or items export. Only the files this "
                          "source is for belong in its folder — set a filename pattern if it shares one."}

    account_id = str(profile.get("account_id") or "").strip()
    with get_db() as conn:
        if not _source_has_completed_batch(conn, profile["id"]):
            return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                    "reason": "Import one file from this source by hand first, so its setup is proven."}
        if not account_id:
            return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                    "reason": "This source has no Amazon account set."}
        account = conn.execute(
            "SELECT type FROM account WHERE id = ? AND trashed_at IS NULL", (account_id,)
        ).fetchone()
        if not account:
            return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                    "reason": "The Amazon account this source imports into no longer exists."}
        # Only an orders file names paying cards; an items file carries no instrument at all, so this
        # resolves to the empty list and the file goes straight through.
        unmapped = sorted({
            inst["last4"] for inst in _scan_instruments(conn, orders, account_id)
            if inst.get("state") == "unmapped"
        })
    if unmapped:
        return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                "reason": f"No funding account is mapped for the card{'' if len(unmapped) == 1 else 's'} "
                          f"ending {_quoted_list(unmapped)}. Import this file by hand to map them, after "
                          "which this folder runs on its own again."}

    try:
        with get_db() as conn:
            summary = run_amazon_import(
                conn, merge(orders, items_by_order), account_id=account_id,
                filename=", ".join(names) or candidate["filename"],
                apply_categorization=bool(profile.get("apply_categorization")),
                file_hashes=file_hashes, profile_id=profile["id"],
            )
    except HTTPException as error:
        detail = error.detail
        message = detail.get("message") if isinstance(detail, dict) else detail
        return {"state": WATCH_STATE_PARKED, "reason": str(message), "content_hash": content_hash}
    except Exception as error:
        log_error(f"[import-watch] Amazon import failed for {candidate['filename']}: {error}", exc_info=error)
        return {"state": WATCH_STATE_ERROR, "reason": f"The import failed: {error}",
                "content_hash": content_hash}

    counts = summary.get("counts") or {}
    # One file, so the drop produced one card and `batch_id` is it. `imported` is the order rows the
    # card carries, which is what the scan summary counts — an items file legitimately imports none.
    return {"state": WATCH_STATE_IMPORTED, "content_hash": content_hash,
            "batch_id": summary.get("batch_id"),
            "imported": int(counts.get("orders_imported") or 0) + int(counts.get("non_cash") or 0),
            "reason": None}


def _import_ready_paypal_statement(profile: dict, candidate: dict, data: bytes) -> dict:
    """A PayPal statement PDF out of the PayPal source's folder, imported as the statement import does
    it (`paypal_statement.py`).

    The question the saved source has to answer is which ledger account a statement's PayPal account
    goes into. That is already answered for any PayPal account with a statement imported by hand — the
    tie `_statement_accounts` reads back from those cards — and is the only thing a statement needs, so
    that tie is also what proves the setup. A statement for a PayPal account with no tie yet parks: the
    interactive import asks which account it goes into, and picking one unattended is exactly the guess
    an unmapped CSV account value is refused for. The interactive refusals (`_check_assignments`) still
    apply, so an account trashed or retyped since parks too.
    """
    try:
        statement = read_statement(data)
    except StatementError as error:
        return {"state": WATCH_STATE_PARKED, "reason": f"This PDF could not be read as a PayPal statement: {error}"}
    if statement is None:
        return {"state": WATCH_STATE_PARKED,
                "reason": "This PDF is not a PayPal statement. Only the files this source is for belong in "
                          "its folder — set a filename pattern if it shares one."}

    content_hash = statement.content_hash
    with get_db() as conn:
        existing_batch_id = _already_imported(conn, content_hash)
    if existing_batch_id:
        return {"state": WATCH_STATE_DUPLICATE, "reason": "This exact statement has been imported already.",
                "content_hash": content_hash, "batch_id": existing_batch_id}
    if not statement.rows:
        # Nothing to import is a finished outcome rather than a question, so it is not parked; the file
        # is done with, and a purge setting may remove it like any imported one.
        return {"state": WATCH_STATE_IMPORTED, "content_hash": content_hash, "batch_id": None, "imported": 0,
                "reason": "This statement has no activity, so there was nothing to import."}

    paypal_id = statement.paypal_account_id
    with get_db() as conn:
        tied_account = _statement_accounts(conn)[0].get(paypal_id)
        if not tied_account:
            return {"state": WATCH_STATE_PARKED, "content_hash": content_hash,
                    "reason": f"No statement for PayPal account {paypal_id} has been imported yet. Import "
                              "this one by hand to choose its account, after which this folder takes that "
                              "account's statements on its own."}
        try:
            accounts = _check_assignments(conn, [statement], {paypal_id: tied_account})
        except HTTPException as error:
            detail = error.detail
            message = detail.get("message") if isinstance(detail, dict) else detail
            return {"state": WATCH_STATE_PARKED, "reason": str(message), "content_hash": content_hash}
        ledger_currency = get_ledger_currency(conn)

    try:
        result = run_import_parsed(
            _statement_parsed(statement, ledger_currency),
            _statement_config(profile, accounts[paypal_id], statement),
            filename=candidate["filename"],
        )
    except HTTPException as error:
        detail = error.detail
        message = detail.get("message") if isinstance(detail, dict) else detail
        return {"state": WATCH_STATE_PARKED, "reason": str(message), "content_hash": content_hash}
    except Exception as error:
        log_error(f"[import-watch] statement import failed for {candidate['filename']}: {error}", exc_info=error)
        return {"state": WATCH_STATE_ERROR, "reason": f"The import failed: {error}",
                "content_hash": content_hash}

    return {"state": WATCH_STATE_IMPORTED, "content_hash": content_hash,
            "batch_id": result.get("batch_id"), "imported": int(result.get("imported") or 0),
            "reason": None}


def _statement_hash(data: bytes) -> Optional[str]:
    """A statement's identity is over what was read rather than its bytes (`Statement.content_hash`), so
    the purge has to re-read a PDF to re-check it; one that no longer reads has changed."""
    try:
        statement = read_statement(data)
    except StatementError:
        return None
    return statement.content_hash if statement else None


@dataclass(frozen=True)
class _FileKind:
    """How one kind of watched file is read, identified and imported. `content_hash` is the identity
    recorded on the watermark and in `import_batch.file_content_hash`; `media_type` is what a parked file
    is handed back to the import page as."""
    read: Callable[[str], Any]
    content_hash: Callable[[Any], Optional[str]]
    import_file: Callable[[dict, dict, Any], dict]
    media_type: str


_CSV_FILE = _FileKind(_read_file_text, make_import_file_hash, _import_ready_csv_file, "text/csv")
_AMAZON_EXPORT = _FileKind(_read_file_text, make_import_file_hash, _import_ready_amazon_file, "text/csv")
_PAYPAL_STATEMENT = _FileKind(_read_file_bytes, _statement_hash, _import_ready_paypal_statement, "application/pdf")

# Keyed on `csv_import_profile.source_kind`, then on the file's extension. A watched folder is a download
# destination, so a source takes only the extensions listed for it and passes over everything else that
# lands there. A zip of statements is deliberately absent although the upload accepts one: expanding an
# archive found on disk with nobody present is a wider capability than reading a file someone saved, and
# a zip in a downloads folder is usually one nobody has opened.
_DEFAULT_FILE_KINDS = {".csv": _CSV_FILE}
_FILE_KINDS_BY_SOURCE = {
    AMAZON_SOURCE_KIND: {".csv": _AMAZON_EXPORT},
    PAYPAL_SOURCE_KIND: {".csv": _CSV_FILE, ".pdf": _PAYPAL_STATEMENT},
}


def candidate_suffixes(source_kind: Optional[str]) -> tuple[str, ...]:
    return tuple(_FILE_KINDS_BY_SOURCE.get(source_kind or "", _DEFAULT_FILE_KINDS))


def _file_kind(source_kind: Optional[str], filename: str) -> Optional[_FileKind]:
    kinds = _FILE_KINDS_BY_SOURCE.get(source_kind or "", _DEFAULT_FILE_KINDS)
    return kinds.get(os.path.splitext(filename)[1].lower())


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
        kind = _file_kind(profile.get("source_kind"), row["filename"])
        if kind is None:
            continue
        try:
            if kind.content_hash(kind.read(path)) != row["content_hash"]:
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
    """Walk every watched source once. The whole unattended path, and the body of both triggers.

    One scan at a time: app load and the Import page's mount both trigger one, and two scans walking the
    same folder together would each find a new file ready and import it twice."""
    with single_runner("watch_scan") as claimed:
        if not claimed:
            return {"skipped": "scan_in_progress", "sources": []}
        return _scan_watched_sources(profile_id=profile_id)


def _scan_watched_sources(*, profile_id: Optional[str]) -> dict:
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

        # Not for a folder that could not be listed: one this server may no longer watch must not be
        # deleted from either, and one that is not there has nothing to delete.
        with get_db() as conn:
            purged = [] if notice else _purge_pass(conn, profile)
        summaries.append({
            "profile_id": profile["id"], "name": profile["name"], "notice": notice,
            "imported": imported, "parked": parked, "purged": len(purged),
        })

    # Each import owed its payees a recurring rescan; one scan settles them all.
    if imported_batch_ids:
        settle_owed_rescans()
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)",
            (WATCH_LAST_SCAN_META_KEY, utcnow_iso()),
        )
        counts = attention_counts(conn)
    return {"sources": summaries, "attention": counts}


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
        # By name, not by `resolved_at`: a parked file is re-stamped on every retry, so that column
        # only replays the last scan's directory order, which is whatever the filesystem returned.
        files = conn.execute(
            """
            SELECT f.id, f.profile_id, f.filename, f.state, f.reason, f.batch_id, f.resolved_at
            FROM   import_watch_file f
            JOIN   csv_import_profile p ON p.id = f.profile_id
            WHERE  f.state != ?
            ORDER  BY p.name, f.filename
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


# A directory listing is read into a response whole, so it needs a ceiling like every other unbounded
# list. A folder with more subdirectories than this is one nobody is picking from by eye anyway; the
# response says it was cut so the UI can tell the reader to type the path instead of scrolling.
MAX_BROWSE_ENTRIES = 500


def _browse_roots() -> list[dict]:
    """Where the folder picker starts. Not a confinement — anywhere reachable can still be walked to or
    typed — but dropping someone at `/` makes them navigate down through directories that are nothing to
    do with them. These are the three places a watched folder actually tends to be — or, where watching
    is confined, the folders it is confined to, since nothing outside them can be chosen."""
    allowed = allowed_watch_roots()
    if allowed is not None:
        return [{"label": root, "path": root} for root in allowed]
    roots = [{"label": "Home", "path": str(Path.home())}]
    try:
        roots.append({"label": f"{app_name()} data", "path": str(data_dir().resolve())})
    except OSError:
        pass
    if os.name == "nt":
        # A drive each, since Windows has no single root to walk down from. Only the ones that answer:
        # an empty optical or card reader slot raises rather than listing.
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = f"{letter}:\\"
            if os.path.isdir(drive):
                roots.append({"label": drive, "path": drive})
    else:
        roots.append({"label": "Filesystem root", "path": "/"})
    seen, unique = set(), []
    for root in roots:
        if root["path"] not in seen:
            seen.add(root["path"])
            unique.append(root)
    return unique


@router.get("/watch/browse", dependencies=[Depends(require_admin_or_local)])
def browse_directories(path: Optional[str] = None, profile_id: Optional[str] = None):
    """List the subdirectories of one directory on the **server**, for the folder picker.

    Read-only and admin-or-local, the same gate as naming the folder — and deliberately no more
    capability than that gate already carries: an administrator can point a source at any path the
    process can reach and press *Check now*, which lists that directory *and* tries to import from it.
    This only lists, and creates nothing (`security-model.md` → *Reading and deleting outside the data
    directory*).

    **The files are listed, not just counted**, because that is what answers "is this the folder?" — a
    name like last year's export sitting in it settles the question that a path cannot. Which files
    those are depends on the source (`profile_id`) and is decided *here*, from `candidate_suffixes`, the
    same table the scan itself filters on: the picker must never offer a file the folder would not take.
    The client is told *which files*, never *which extensions*, so the table growing does not reach it.

    An unreadable or missing directory is a notice rather than an error, in the same words
    `_scan_directory` uses, because removable media and network shares come and go.
    """
    target = (path or "").strip()
    if not target:
        roots = _browse_roots()
        not_enabled = allowed_watch_roots() == []
        return {"path": None, "parent": None, "entries": [], "files": [], "file_count": 0,
                "truncated": False, "notice": WATCHING_NOT_ENABLED if not_enabled else None,
                "roots": roots, "watching_enabled": not not_enabled}
    refusal = watch_folder_refusal(target)
    if refusal:
        return _browse_notice(os.path.abspath(os.path.expanduser(target)), refusal)
    source_kind = None
    if profile_id:
        with get_db() as conn:
            row = conn.execute("SELECT source_kind FROM csv_import_profile WHERE id = ?", (profile_id,)).fetchone()
        source_kind = row["source_kind"] if row else None
    suffixes = candidate_suffixes(source_kind)
    resolved = os.path.abspath(os.path.expanduser(target))
    entries, files, file_count, truncated = [], [], 0, False
    try:
        with os.scandir(resolved) as scan:
            for entry in scan:
                try:
                    if entry.is_dir():
                        if len(entries) >= MAX_BROWSE_ENTRIES:
                            truncated = True
                            continue
                        entries.append({"name": entry.name, "path": entry.path,
                                        "hidden": entry.name.startswith(".")})
                    elif entry.is_file() and entry.name.lower().endswith(suffixes):
                        # Counted whole and listed up to the cap, so a folder holding more exports than
                        # fit still reports how many are really in it.
                        file_count += 1
                        if len(files) < MAX_BROWSE_ENTRIES:
                            files.append({"name": entry.name})
                        else:
                            truncated = True
                except OSError:
                    # A dangling symlink or an entry that vanished mid-walk is not worth failing over.
                    continue
    except FileNotFoundError:
        return _browse_notice(resolved, "This folder is not there right now.")
    except NotADirectoryError:
        return _browse_notice(resolved, "This path is not a folder.")
    except PermissionError:
        return _browse_notice(resolved, "This folder cannot be read.")
    except OSError as error:
        return _browse_notice(resolved, f"This folder could not be read: {error.strerror or error}")
    entries.sort(key=lambda e: e["name"].lower())
    files.sort(key=lambda f: f["name"].lower())
    return {"path": resolved, "parent": _parent_of(resolved), "entries": entries, "files": files,
            "file_count": file_count, "truncated": truncated, "notice": None, "roots": _browse_roots()}


def _browse_notice(resolved: str, notice: str) -> dict:
    return {"path": resolved, "parent": _parent_of(resolved), "entries": [], "files": [],
            "file_count": 0, "truncated": False, "notice": notice, "roots": _browse_roots()}


def _parent_of(resolved: str) -> Optional[str]:
    """The directory above, or None at a root — `os.path.dirname` of a root returns the root itself,
    which would render as an *Up* that goes nowhere — and None above a watch root too, where the folder
    above could not be chosen."""
    parent = os.path.dirname(resolved.rstrip(os.sep)) or os.sep
    if os.path.abspath(parent) == os.path.abspath(resolved):
        return None
    return None if watch_folder_refusal(parent) else parent


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
        # Resolved once rather than appended as it is decided, because clearing the path and setting the
        # switch are two reasons to write the same column and a request may carry both. Two assignments
        # to one column is not an error in SQLite — the last simply wins — so appending each would have
        # left `watch_dir` NULL with the switch still on: a source the status view no longer lists, armed
        # for the next request that names a folder.
        enabled = None if body.watch_enabled is None else (1 if body.watch_enabled else 0)
        # Refused before anything is written: a folder this server may not watch is not saved, and an
        # existing one that has since fallen outside cannot be switched back on.
        stored_dir = conn.execute(
            "SELECT watch_dir FROM csv_import_profile WHERE id = ?", (profile_id,)).fetchone()["watch_dir"]
        target_dir = (body.watch_dir if body.watch_dir is not None else stored_dir or "").strip()
        if target_dir and (body.watch_dir is not None or enabled == 1):
            refusal = watch_folder_refusal(target_dir)
            if refusal:
                raise HTTPException(status_code=400, detail=refusal)
        if body.watch_dir is not None:
            directory = body.watch_dir.strip()
            fields += ["watch_dir = ?", "watch_notice = NULL"]
            params.append(directory or None)
            # Clearing the path clears the switch, and wins over an enable in the same request: there is
            # nothing left to watch.
            if not directory:
                enabled = 0
        if enabled is not None:
            fields.append("watch_enabled = ?")
            params.append(enabled)
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


@router.get("/watch/files/{file_id}/content")
def watch_file_content(file_id: str):
    """The parked file itself, so the ordinary import flow can be opened with it pre-seeded. A parked
    file is one this app already decided it cannot take unattended; handing it back to the flow that
    *can* ask questions is the whole answer to a parked file.

    The bytes go back as they are on disk, so the upload path decodes and hashes them exactly as it would
    the same file dropped by hand; the media type is the file kind's."""
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT w.filename, w.state, p.watch_dir, p.source_kind
            FROM   import_watch_file w
            JOIN   csv_import_profile p ON p.id = w.profile_id
            WHERE  w.id = ?
            """,
            (file_id,),
        ).fetchone()
    kind = _file_kind(row["source_kind"], row["filename"]) if row else None
    if not kind:
        raise HTTPException(status_code=404, detail="File not found")
    refusal = watch_folder_refusal(str(row["watch_dir"] or ""))
    if refusal:
        raise HTTPException(status_code=403, detail=refusal)
    path = os.path.join(str(row["watch_dir"] or ""), row["filename"])
    try:
        return Response(_read_file_bytes(path), media_type=kind.media_type)
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
