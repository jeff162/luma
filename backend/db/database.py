# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Primary application database: schema and seeding for the financial database.

This file owns the durable model the routers and services share. Its key guarantees
are that fresh databases are created directly in the current shape, existing ones are
advanced in place by `run_migrations`, and core invariants like leaf-only transaction
categories and the built-in shared owner are re-established on startup. The migration
chain was reset to the baseline (v1) at the Luma rebrand and has grown from there; the
notes above `CURRENT_VERSION` say what the registered migrations do.
"""

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from backend.app_logging import log_info, log_warning
from backend.db import contention_trace
from backend.runtime_config import resolve_db_path

DB_PATH = resolve_db_path()
# Every request uses `DB_PATH`, the database the configuration names. The override exists so a caller can
# aim the code at another file for the length of a block, which is how the tests reach a database of their
# own; nothing in the server sets it.
_current_db_path: ContextVar[str | None] = ContextVar("luma_current_db_path", default=None)
SHARED_OWNER_ID = "shared-owner"
SHARED_OWNER_NAME = "shared"
SHARED_OWNER_COLOR = "#6366f1"


def _normalize_db_path(db_path: str | None = None) -> str:
    path = db_path or _current_db_path.get() or DB_PATH
    return str(Path(path))


def current_db_path() -> str:
    """The data DB path in force right now — the override when one is set, otherwise the configured
    database. Callers that need to put a file *beside* the database (a staged backup artifact, say)
    must use this rather than `DB_PATH` or `data_dir()`: `DB_PATH` can point outside the data directory,
    and neither reflects an override."""
    return _normalize_db_path()


def set_current_db_path(db_path: str):
    return _current_db_path.set(_normalize_db_path(db_path))


def reset_current_db_path(token):
    _current_db_path.reset(token)


def get_shared_owner_row(conn: sqlite3.Connection):
    return conn.execute(
        """
        SELECT id, name, color
        FROM owner
        WHERE LOWER(name) = LOWER(?)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, name
        LIMIT 1
        """,
        (SHARED_OWNER_NAME, SHARED_OWNER_ID),
    ).fetchone()


def get_shared_owner_id(conn: sqlite3.Connection) -> str | None:
    row = get_shared_owner_row(conn)
    return row["id"] if row else None


def ensure_shared_owner(conn: sqlite3.Connection) -> str:
    row = get_shared_owner_row(conn)
    if row:
        if row["name"] != SHARED_OWNER_NAME or row["id"] != SHARED_OWNER_ID:
            conn.execute(
                "UPDATE owner SET name = ?, color = ? WHERE id = ?",
                (SHARED_OWNER_NAME, SHARED_OWNER_COLOR, row["id"]),
            )
        return row["id"]
    conn.execute(
        "INSERT INTO owner (id, name, color, flag_new_for_review) VALUES (?, ?, ?, 1)",
        (SHARED_OWNER_ID, SHARED_OWNER_NAME, SHARED_OWNER_COLOR),
    )
    return SHARED_OWNER_ID


# How long a write waits for another writer before giving up with "database is locked".
#
# WAL lets readers run freely but still serializes writers, so this bounds how long one request's write can
# be delayed by another's. Python's default is 5 seconds, which was chosen for neither this workload nor
# any other — it was simply never set.
#
# It is defence in depth rather than the fix. What made contention long enough to matter was a transaction
# held open across work that is not writing: a sync across provider network calls, an edit across the
# recurring rescan it caused, a read endpoint across the listing after its cache write. Each now commits
# before the long part (`docs/architecture.md` → *Database concurrency*), so the window a writer can collide
# with is short. This value covers what remains: a large import or a backup restore writing in bulk while
# someone clicks something. Raising it further would only trade a visible error for an
# invisible stall, which is the worse failure for a request a user is waiting on.
_BUSY_TIMEOUT_SECONDS = 15


@contextmanager
def get_db(db_path: str | None = None, *, handed_between_threads: bool = False):
    """Open a connection for the length of the block, committing on the way out.

    Nothing written inside the block is visible to another request until it exits. A value another request
    has to see while a long operation is still running — a progress marker, a lock, a heartbeat — is
    therefore written through its own short `get_db()` before the long block opens, and cleared in a
    `finally` after it.

    `handed_between_threads` is for a connection held open across the steps of a streamed response body.
    Each step of a sync generator runs on whichever worker thread is free, so the thread that opens the
    connection is not reliably the one that reads the next row or closes it, and sqlite3 refuses a
    connection outside its creating thread unless told otherwise. It is safe only because such a generator
    is advanced one step at a time: the connection changes hands, it is never shared.
    """
    resolved_path = _normalize_db_path(db_path)
    Path(resolved_path).parent.mkdir(parents=True, exist_ok=True)
    traced = contention_trace.enabled()
    conn = sqlite3.connect(
        resolved_path, timeout=_BUSY_TIMEOUT_SECONDS, check_same_thread=not handed_between_threads,
        **({"factory": contention_trace.TracedConnection} if traced else {}),
    )
    if traced:
        conn.trace_start(resolved_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        if traced:
            conn.trace_finish()
        conn.close()


@contextmanager
def single_runner(name: str, *, lease_seconds: int = 1800, db_path: str | None = None):
    """Yield True to the one caller allowed to run `name` now, False to any other while it runs.

    For a request-driven catch-up that decides whether it is due and then does long work: two callers
    arriving together (app load and a page mount) would otherwise both read "due" before either stamps
    it, and both do the work. The claim is a `db_meta` row written in its own short immediate
    transaction, so the check and the claim cannot interleave, and it is visible to other requests
    while the long block runs (see `get_db`). It is cleared on the way out; `lease_seconds` lets a claim
    left by a process that died mid-run lapse rather than block the work for good.
    """
    key = f"running:{name}"
    with get_db(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        held = conn.execute(
            "SELECT 1 FROM db_meta WHERE key = ? AND (julianday('now') - julianday(value)) * 86400.0 < ?",
            (key, lease_seconds),
        ).fetchone()
        if not held:
            conn.execute(
                "INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, datetime('now'))", (key,),
            )
    if held:
        yield False
        return
    try:
        yield True
    finally:
        with get_db(db_path) as conn:
            conn.execute("DELETE FROM db_meta WHERE key = ?", (key,))


# Compaction rewrites the whole file, so it is worth running unprompted only when what it gives back is large
# both outright and against the file: 10 MB free in a 30 MB ledger, not 10 MB in a 2 GB one. Smaller slack is
# left on the free list, where SQLite reuses it for the next writes anyway.
COMPACT_MIN_FREE_BYTES = 10 * 1024 * 1024
COMPACT_MIN_FREE_FRACTION = 0.2


def _megabytes(byte_count: int) -> str:
    return f"{byte_count / (1024 * 1024):.1f} MB"


def database_bytes(conn) -> int:
    """The size of the database file this connection is on, free pages included."""
    return _free_and_total_bytes(conn)[1]


def _free_and_total_bytes(conn) -> tuple[int, int]:
    page_size = conn.execute("PRAGMA page_size").fetchone()[0]
    page_count = conn.execute("PRAGMA page_count").fetchone()[0]
    free_pages = conn.execute("PRAGMA freelist_count").fetchone()[0]
    return free_pages * page_size, page_count * page_size


def _on_disk_bytes(db_path: str) -> int:
    """The database file plus its write-ahead log, which is where a rebuild's pages sit until checkpointed."""
    wal = Path(f"{db_path}-wal")
    return Path(db_path).stat().st_size + (wal.stat().st_size if wal.exists() else 0)


def compact_database(db_path: str | None = None, *, reason: str) -> int:
    """Rebuild the file so the pages a deletion freed go back to the filesystem. Returns the bytes
    given back, or 0 if nothing was reclaimed or the rebuild could not run.

    SQLite keeps freed pages on a free list and reuses them, so a large deletion changes nothing a
    user can see: the file stays exactly the size it was. That is fine for a database that will grow
    back into the space, and wrong for a screen whose name is *Free up import space* — someone who
    clears 39 MB, looks at the file and finds it unchanged has been told something untrue.

    It must run on a connection of its own: VACUUM cannot execute inside a transaction, so it cannot
    be appended to the write it follows. It takes a brief exclusive lock (measured at 0.16s on an 88 MB
    database) and needs roughly twice the file's size in free disk while it rebuilds.

    **It is logged to `luma.log` before it starts as well as after**, with `reason` naming what asked
    for it: the lock is the one way it can be noticed, and a stall that coincides with an opening line
    and no closing one is then attributable. The free list it reports up front is a floor on what the
    rebuild gives back, which also packs partly empty pages.

    **The rebuild is checkpointed and the log truncated in the same connection.** VACUUM writes the new
    file through the write-ahead log, and with any other connection open — the normal state of a running
    server — the log is left holding a copy about the size of the rebuilt database, so the file shrinks and
    the disk does not. What it gives back is therefore measured over both files.

    **A failure here is never the caller's failure.** The deletion it follows has already committed;
    this only decides whether the filesystem hears about it today or the next time one runs. So a busy
    database or a full disk is logged and swallowed rather than turned into an error for work that
    actually succeeded.
    """
    resolved_path = _normalize_db_path(db_path)
    try:
        before = _on_disk_bytes(resolved_path)
        with get_db(resolved_path) as conn:
            free_bytes, total_bytes = _free_and_total_bytes(conn)
    except (OSError, sqlite3.Error):
        return 0
    log_info(
        f"[db] compacting {resolved_path} ({reason}): {_megabytes(free_bytes)} of "
        f"{_megabytes(total_bytes)} is on the free list",
        keep_in_file=True,
    )
    started = time.monotonic()
    try:
        with get_db(resolved_path) as conn:
            conn.execute("VACUUM")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.Error as exc:
        log_warning(f"[db] compaction of {resolved_path} did not run: {exc}")
        return 0
    try:
        after = _on_disk_bytes(resolved_path)
    except OSError:
        return 0
    freed = max(0, before - after)
    log_info(
        f"[db] compacted {resolved_path}: freed {_megabytes(freed)} in {time.monotonic() - started:.1f}s, "
        f"now {_megabytes(after)} on disk",
        keep_in_file=True,
    )
    return freed


def compact_if_worthwhile(db_path: str | None = None, *, reason: str) -> int:
    """Compact after a deletion only when the free space clears both thresholds above; otherwise 0.

    For the paths that delete in bulk as a side effect of something else — emptying the trash, undoing
    an import, removing an account or a connection's history, a restore, startup — where the user has
    not asked for space back, so a rebuild that would return a few kilobytes is a lock for nothing. The
    check reads three pragmas and costs nothing. *Free up import space* calls `compact_database`
    directly, because there the space is the point."""
    resolved_path = _normalize_db_path(db_path)
    try:
        Path(resolved_path).stat()
        with get_db(resolved_path) as conn:
            free_bytes, total_bytes = _free_and_total_bytes(conn)
    except (OSError, sqlite3.Error):
        return 0
    if free_bytes < COMPACT_MIN_FREE_BYTES or free_bytes < total_bytes * COMPACT_MIN_FREE_FRACTION:
        return 0
    return compact_database(resolved_path, reason=reason)


# Fresh installs are created directly at `CURRENT_VERSION` from the full schema in `init_db` and
# stamped there without replaying migrations. Existing databases are advanced in place by
# `run_migrations`, which applies every registered migration newer than the DB's recorded version.
#
# A migration has two halves: a *schema* change (ALTER/CREATE) and, for some, a *data-init* step that
# derives new fields from existing data (e.g. v6 display_name_source, v13 account types + money-movement
# consolidation, v15 last_effect_date + is_managed). These data-init steps are registered in
# `POST_RESTORE_DATA_INIT` and run again by `run_post_restore_data_init` after a **backup restore**: a
# restore loads the backup's rows into the already-current schema, so the schema half is a no-op, but the
# data-init half of every migration *newer than the backup* would otherwise be skipped — leaving derived
# fields empty. So restore runs exactly those (gated on the backup's recorded `schema_version`), in order.
#
# The migration chain was *reset* at the Luma rebrand: the historical v1..v32 migrations were dropped
# (there is no in-place upgrade path off a pre-rebrand database — those come across via backup/restore)
# and the baseline is `1`. Post-rebrand migrations register from v2 upward: v2 adds
# `category_rule.match_source_text`, v3 adds `txn.needs_review`, v4 adds `txn.recurring_series_id`
# (the recurring_series table itself is created by init_db's CREATE TABLE IF NOT EXISTS script), v5 adds
# rule-backed recurring series (`category_rule.is_recurring` + `recurring_series.rule_id`; the
# `recurring_membership_override` table is created by the same CREATE TABLE IF NOT EXISTS script).
# v14 adds `category_rule.match_expr` (multi-clause AND/contains merchant matcher). v15 adds
# `category_rule.last_effect_date` (stale-rule signal) + `category_rule.deleted_at` (rules trash).
# v18 adds the provider-agnostic `connection` credential store; v19 adds `provider_config` (app creds).
# v20 makes the account→connection link provider-neutral (external_account_id / connection_id / provider,
# drop plaid_item_id) and drops the vestigial `plaid_item` table. v23 adds the `connection_sync_log`
# diagnostics table (provider-sync log; see routers/sync.py). v24 adds the per-connection
# account mapping (`connection_account`, the input duplicate detection was missing for synced rows) plus
# `connection.captured_fields`, `txn.authorized_date`, and `csv_import_profile.terminal_window_days`.
# v25 flips that last column's default from 1 to 7 and rewrites the rows v24 wrote at 1 — a source is
# now assumed to lag its bank unless it says otherwise, since the reverse assumption silently drops real
# transactions (see the migration's own note). v31 adds `connection_sync_log.warnings`/`.advisories`, so a
# sync that succeeded while importing nothing stops looking identical to one that had nothing to import.
# v32 splits that log's `skipped` into the half that means data was lost and the half that is routine, and
# adds the per-account breakdown the connection card reads. v33 adds `connection.sync_started_at`, so a
# running sync stays visible after the page that started it is navigated away from. v61 stores each
# rejected duplicate's advisory sub-state (`import_batch_duplicate.review_substate`) instead of re-deriving
# it per read, so a file card can count the rejections still wanting a look. v62 adds
# `import_batch_rejected_row`, which keeps the rows an import refused rather than only counting them
# — the uploaded file is unrecoverable, so a count was the whole record of what a file left behind.
# v77 aligns every leaf category's `category_type` with its group's, the property a group's total
# depends on to equal the sum of its slices — enforced on every category write but not by a restore,
# which inserts verbatim.
# v63 lets a data source name a folder the server imports from unattended (`csv_import_profile.watch_*`
# plus `import_watch_file`, the per-file `(size, mtime)` watermark that keeps a scan off the disk).
# v65 records what period each import card covers (`import_batch.covers_*`) and backfills it, so the
# history organizes by the transactions a file carried rather than by when it was imported.
# v66 adds the marker for a card whose stored detail has been cleared, and v67 renames it to
# `import_batch.detail_cleared_at` once that action stopped removing the card from the history and
# became maintenance over the detail alone. Nothing to backfill in either. v68 adds `import_batch.updated_count`,
# the rows an import corrected rather than added — a source revising an amount between two exports was
# previously counted as neither imported nor deduped, so the ledger changed and nothing said so. v69 adds
# `import_batch.ignored_count` for the rows a source restated from its own prior import, which stop being
# written to the duplicate report at all. v70 adds `txn.source_transaction_id`, the identifier a file source
# gives each row, matched only within the data source that issued it. v71 moves Plaid's stored transaction
# ids under the `plaid:` prefix, the namespace every other provider's ids already had. v72 removes from
# every duplicate report the rows v69 stopped writing — a source restating its own prior import — so an
# older report reads as one written today, and compacts the file once afterwards. v73 adds
# `recurring_signal_dismissal.one_off`, an Amount changed finding dismissed as "fine this time". v74 adds
# `owner.flag_new_for_review`, which moves arrival flagging from one ledger-wide setting to each owner. v75
# removes from every stored rule-suggestion review the transactions that no longer exist. v76 adds
# `amazon_pending_item.consumed_batch_id`, so undoing an orders import returns the parked items it attached.
# v78 adds `recurring_rescan_owed`, so a recurring rescan a write owes survives the scan failing. v79 adds
# `recurring_series.rule_fingerprint`, so a scoped scan can leave a rule-backed series alone until an edit
# or its rule changes what it holds. v80 records on each Amazon card the Amazon account it imported
# into, which the import history groups a vendor's cards by; older cards are backfilled from their rows,
# and a card with none (an items-only card holding parked detail) is left unattributed. v81 adds
# `rule_conflict`, the rule pairs a categorization pass caught deciding a transaction arbitrarily. v82 adds
# `backup_history`, the backups this system made. v83 adds `backup_history.deleted_at`, the history's trash.
# v84 drops `merchant_rename`, a pattern → clean-name table nothing ever wrote or read; a category rule's
# `clean_name` is the rename. v85 adds `category_rule.priority_level`, the user's own precedence term.
# v86 adds `csv_import_profile.decimal_separator`, how a source's files write a number.
# v87 adds `backup_history.database_check`, whether the databases passed their check as a backup was made.
# v88 gives every user their own copy of the shared saved tag reports and saved filters, which became
# per-user preferences. v89 adds `connection.provider_request_budget_at`, when the request budget was last
# written, which a restore compares. v91 adds rule alerts: `category_rule.alert` and `.alert_message`, and
# `rule_alert_hit`, the transactions an alert caught as they arrived.

# Bumping this line is the activation step, so it is the *last* edit a migration gets. A dev server
# running under `--reload` applies the new version the moment this file is saved, against whichever
# database it is pointed at — including the developer's own. Land everything the migration reads or
# writes first, then come back here.
CURRENT_VERSION = 91

# Kept as a literal rather than imported from `services.duplicate_detection`, which imports this module.
# It must stay equal to that module's DEFAULT_TERMINAL_WINDOW_DAYS, which owns the reasoning; the same
# value is also the DDL default for both `csv_import_profile` and `connection_account`.
DEFAULT_CSV_TERMINAL_WINDOW_DAYS = 7

MIGRATIONS = {}


def migration(version):
    def decorator(fn):
        MIGRATIONS[version] = fn
        return fn
    return decorator


@migration(2)
def _add_rule_match_source_text(conn):
    # Opt-in per-rule flag to also match the keyword against a row's captured import source text
    # (description + extra evidence fields). Existing rules default to 0 (name-only), preserving
    # behavior. Fresh installs get the column from the baseline CREATE TABLE above.
    conn.execute("ALTER TABLE category_rule ADD COLUMN match_source_text INTEGER NOT NULL DEFAULT 0")


@migration(3)
def _add_txn_needs_review(conn):
    # Per-transaction "needs review" flag: freshly imported/synced rows start at 1 so the user can look
    # them over; existing rows default to 0 (out of the review pool). Fresh installs get the column from
    # the baseline CREATE TABLE; its partial index is (re)created in init_db just after migrations, where
    # the column is guaranteed to exist on both fresh and migrated databases.
    conn.execute("ALTER TABLE txn ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0")


@migration(4)
def _add_recurring_series(conn):
    # Recurring-series support. The recurring_series table itself is created by init_db's
    # `CREATE TABLE IF NOT EXISTS` script (which runs on both fresh and migrated databases before this
    # migration), so this migration only adds the txn membership column that an existing txn table lacks.
    # Default NULL so existing rows belong to no series until the next detector scan; its partial index
    # is (re)created in init_db just after migrations, where the column is guaranteed to exist.
    # ON DELETE SET NULL matches the fresh-install baseline CREATE TABLE, so a series can be deleted while
    # it still has linked rows on both paths. (Databases migrated before this action was added carry a
    # NO ACTION FK instead; delete_series unlinks members first so it works there regardless.)
    conn.execute("ALTER TABLE txn ADD COLUMN recurring_series_id TEXT REFERENCES recurring_series(id) ON DELETE SET NULL")


@migration(5)
def _add_rule_backed_recurring(conn):
    # Rule-backed recurring series: a rule flagged is_recurring owns a recurring_series whose membership
    # is the rule's matches (spanning payee-name variants the derived payee_key key can't). Both columns
    # are added here in one migration; fresh installs get them from the baseline CREATE TABLEs. The new
    # recurring_membership_override table (pin/exclude corrections) is created by init_db's CREATE TABLE
    # IF NOT EXISTS script on both paths, so it needs no ALTER here.
    # rule_id ON DELETE SET NULL matches the fresh baseline; delete_rule drops the linked series explicitly.
    conn.execute("ALTER TABLE category_rule ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE recurring_series ADD COLUMN rule_id TEXT REFERENCES category_rule(id) ON DELETE SET NULL")


@migration(6)
def _add_txn_display_name_source(conn):
    # Give display_name the provenance category_source already carries, so a rename can be attributed
    # (manual / rule / import / enrichment) and a deliberate manual rename protected from later rules
    # and reconciliation. Fresh installs get the column from the baseline CREATE TABLE.
    conn.execute("ALTER TABLE txn ADD COLUMN display_name_source TEXT")
    _backfill_display_name_source(conn)


def _backfill_display_name_source(conn):
    # `txn` stores no per-row rule_id (rule linkage exists only for recurring series/tags), so a name's
    # provenance has to be re-derived. Per row, in order: (1) a *currently-matching* rule whose
    # clean_name equals the row's display_name → 'rule' (a rule owns the name; a later re-apply may
    # refresh it); (2) else display_name differs from both merchant_name and raw_name → 'manual' (a
    # deliberate rename, protected forever); (3) else → 'import'. This attributes the name to a rule
    # where one is responsible and otherwise protects deliberate renames — more precise than a bare
    # "differs from raw" guess. Rows with no display_name are left NULL (no name to attribute).
    #
    # Reuses the live categorizer so step (1) matches exactly what an actual rule apply would do (no
    # drift). Imported lazily to keep database.py free of a service-layer import cycle; the pass is
    # one-time (only when advancing past v6) and mirrors recategorize_all's shape.
    from backend.services.categorizer import (
        categorize_transaction,
        load_categorization_rules,
        source_match_text_from_json,
    )

    rows = conn.execute(
        """SELECT t.id, t.merchant_name, t.display_name, t.raw_name, t.amount, t.owner_id,
                  t.account_id, COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                  t.import_evidence_json
           FROM   txn t
           JOIN   account a ON a.id = t.account_id"""
    ).fetchall()
    rules = load_categorization_rules(conn)
    needs_source_text = any(rule["match_source_text"] for rule in rules)

    def _norm(value):
        return (value or "").strip()

    for row in rows:
        display_name = row["display_name"]
        if not _norm(display_name):
            continue  # no name to attribute; leave source NULL
        source_text = source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None
        result = categorize_transaction(
            row["merchant_name"], row["raw_name"], row["amount"], conn,
            owner_id=row["owner_id"], account_id=row["account_id"],
            effective_account_id=row["effective_account_id"], rules=rules, source_text=source_text,
        )
        rule_clean = result.get("clean_name") if isinstance(result, dict) else None
        if _norm(rule_clean) and _norm(rule_clean) == _norm(display_name):
            source = "rule"
        elif _norm(display_name) != _norm(row["merchant_name"]) and _norm(display_name) != _norm(row["raw_name"]):
            source = "manual"
        else:
            source = "import"
        conn.execute("UPDATE txn SET display_name_source = ? WHERE id = ?", (source, row["id"]))


@migration(7)
def _add_import_batch_duplicate_enrichment(conn):
    # Enrich-on-duplicate: when an import row matches an existing transaction, its novel detail can be
    # folded into that row's import_evidence. These columns record the outcome on the duplicate report
    # so it can be surfaced and reversed: enriched_txn_id (the row that received detail),
    # enriched_delta_json (exactly what was added, for a clean undo), enriched_at. Fresh installs get
    # them from the baseline CREATE TABLE.
    conn.execute("ALTER TABLE import_batch_duplicate ADD COLUMN enriched_txn_id TEXT")
    conn.execute("ALTER TABLE import_batch_duplicate ADD COLUMN enriched_delta_json TEXT")
    conn.execute("ALTER TABLE import_batch_duplicate ADD COLUMN enriched_at TEXT")


@migration(8)
def _add_import_profile_enrich_from_source(conn):
    # Per-source auto-enrich opt-in: when set on a data source, importing from it folds each hard-rejected
    # duplicate's novel detail into the existing transaction it matched (silently, but reported and
    # reversible). Off by default. Fresh installs get the column from the baseline CREATE TABLE.
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN enrich_from_source INTEGER NOT NULL DEFAULT 0")


@migration(9)
def _add_import_batch_source_kind(conn):
    # Provenance class of an import batch, for history grouping: NULL = ordinary CSV import,
    # 'marketplace:<vendor>' marks a dedicated marketplace importer's batch (see the import_batch baseline
    # CREATE TABLE). Fresh installs get the column from that baseline; existing databases gain it here.
    conn.execute("ALTER TABLE import_batch ADD COLUMN source_kind TEXT")


@migration(10)
def _add_amazon_funding_map(conn):
    # Amazon funding-source → account map: keys a payment instrument (card last-4 + network) to the
    # system account it charges, so the Amazon importer can constrain its card-charge search. Fresh
    # installs get the table + its partial unique indexes from the baseline CREATE TABLE above; existing
    # databases gain them here (the same DDL, so both paths converge).
    conn.execute("""
        CREATE TABLE IF NOT EXISTS amazon_funding_map (
            id                 TEXT PRIMARY KEY,
            last4              TEXT NOT NULL,
            network            TEXT,
            amazon_account_id  TEXT REFERENCES account(id) ON DELETE CASCADE,
            funding_account_id TEXT REFERENCES account(id) ON DELETE CASCADE,
            created_at         TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_funding_global
            ON amazon_funding_map(last4, COALESCE(network, ''))
            WHERE amazon_account_id IS NULL
    """)
    conn.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_funding_override
            ON amazon_funding_map(last4, COALESCE(network, ''), amazon_account_id)
            WHERE amazon_account_id IS NOT NULL
    """)


@migration(11)
def _add_import_profile_source_kind(conn):
    # Provenance class of a data source (import profile), mirroring import_batch.source_kind: NULL = an
    # ordinary user-created source, 'source:paypal' marks the auto-created system PayPal source that all
    # PayPal imports attach to (so PayPal imports group under one header and share one money-movement
    # review). Fresh installs get the column from the csv_import_profile baseline; existing databases here.
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN source_kind TEXT")


@migration(12)
def _add_import_batch_recon_cache(conn):
    # Cache for the Amazon reconciliation attention count (expensive to compute; read on every history load
    # and Tasks poll). recon_attention_count holds the last computed value; recon_epoch holds the global
    # recon epoch it was computed at, so a batch trailing the current epoch is recomputed lazily. Fresh
    # installs get both columns from the import_batch baseline CREATE TABLE; the epoch-bump triggers are
    # created for both paths after run_migrations (they reference tables that exist by then).
    conn.execute("ALTER TABLE import_batch ADD COLUMN recon_attention_count INTEGER")
    conn.execute("ALTER TABLE import_batch ADD COLUMN recon_epoch INTEGER")


@migration(13)
def _add_rule_account_type(conn):
    # Account *type* as a rule scope criterion ('paypal', 'amazon', …): a rule matches only rows whose
    # effective account is of this type, so one rule covers every account of the type. Fresh installs get
    # the column from the category_rule baseline CREATE TABLE. This migration also does the one-time data
    # move the criterion enables for its first consumer, the PayPal money-movement rules:
    #   1. mark accounts that already received PayPal imports as type='paypal' (only generic current types,
    #      so a deliberately-set type is never clobbered), and
    #   2. consolidate the existing per-account money-movement rules onto a single account_type='paypal'
    #      scope (dedup by keyword), the rule shape create_money_movement_rules now produces.
    conn.execute("ALTER TABLE category_rule ADD COLUMN account_type TEXT")
    _backfill_account_types_and_money_movement(conn)


def _backfill_account_types_and_money_movement(conn):
    # The *data* half of migration 13 (the ALTER lives in the migration). Also re-run after restoring a
    # backup older than v13, so pre-v13 data gets the same one-time transform. Idempotent-enough to run
    # once per DB: the type backfill only touches generic types, and the consolidation collapses per-account
    # money-movement rules to one per keyword (a no-op once already consolidated).
    # 1. Backfill PayPal account types from PayPal import provenance.
    conn.execute(
        """
        UPDATE account SET type = 'paypal'
        WHERE id IN (
            SELECT DISTINCT t.account_id FROM txn t
            JOIN import_batch b ON b.id = t.import_batch_id
            WHERE b.source_kind = 'source:paypal' AND t.account_id IS NOT NULL
        )
          AND (type IS NULL OR type IN ('depository', 'other', 'p2p'))
        """
    )

    # 2. Consolidate money-movement rules (match_source_text, pointing at the excluded "Money movement"
    #    leaf, account_id-scoped) onto account_type='paypal'. Resolve the leaf structurally (under the
    #    seeded Transfers group); a database with no money movement set up simply matches nothing.
    mm_leaf = conn.execute(
        """SELECT c.id FROM category c JOIN category p ON p.id = c.parent_id
           WHERE c.name = 'Money movement' AND p.name = 'Transfers' AND p.parent_id IS NULL"""
    ).fetchone()
    if mm_leaf:
        leaf_id = mm_leaf["id"]
        conn.execute(
            """UPDATE category_rule SET account_type = 'paypal', account_id = NULL
               WHERE match_source_text = 1 AND account_id IS NOT NULL AND category_id = ?""",
            (leaf_id,),
        )
        # Rows are now uniform except keyword — keep one rule per keyword (rule_tag cascades on delete).
        conn.execute(
            """DELETE FROM category_rule
               WHERE match_source_text = 1 AND account_type = 'paypal' AND category_id = ?
                 AND id NOT IN (
                    SELECT MIN(id) FROM category_rule
                    WHERE match_source_text = 1 AND account_type = 'paypal' AND category_id = ?
                    GROUP BY keyword
                 )""",
            (leaf_id, leaf_id),
        )


@migration(14)
def _add_rule_match_expr(conn):
    # Multi-clause merchant matching: an optional JSON expression that supersedes the single-substring
    # `keyword` when present. Shape `{"op":"and","clauses":[{"type":"contains","text":"…"}, …]}` — v1 fixes
    # op='and' and type='contains' (AND-only, contains-only). A rule with match_expr matches a row only
    # when *every* clause's text is a substring of the row's name text (or, for match_source_text rules, of
    # its source text). `keyword` stays populated as the sorted, space-joined clause texts so it remains the
    # LIKE-search target and its LENGTH keeps driving specificity ordering (≈ summed clause length, which
    # still ranks a subsuming rule above the one it subsumes). NULL = an ordinary single-keyword rule,
    # evaluated exactly as before. Fresh installs get the column from the category_rule baseline CREATE TABLE.
    conn.execute("ALTER TABLE category_rule ADD COLUMN match_expr TEXT")


@migration(15)
def _add_rule_last_effect_and_trash(conn):
    # Two columns supporting stale-rule cleanup:
    #   last_effect_date — the newest transaction *date* this rule has applied a live effect (category /
    #     rename / tag) to. A monotonic-forward "is this rule still doing anything" signal that drives the
    #     cleanup sweep and sort. Maintained incrementally at the apply sites going forward; seeded once
    #     here from the current owned state.
    #   deleted_at — soft-delete marker for the rules trash: a trashed rule is recoverable and is ignored by
    #     the categorizer and by matcher-identity, but its row (and rule_tag) survive for restore.
    #   is_managed — 1 = an app-managed rule (the auto-created PayPal money-movement Type rules), which the
    #     stale-rule cleanup pre-excludes so a sweep can't quietly remove infrastructure the app maintains.
    # Fresh installs get all three from the category_rule baseline CREATE TABLE.
    #
    # The ALTERs are guarded add-if-missing so this migration is *safe to re-run* — the migration runner only
    # stamps the version after this returns, so a mid-way failure re-runs cleanly on the next boot.
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(category_rule)")}
    if "last_effect_date" not in existing:
        conn.execute("ALTER TABLE category_rule ADD COLUMN last_effect_date TEXT")
    if "deleted_at" not in existing:
        conn.execute("ALTER TABLE category_rule ADD COLUMN deleted_at TEXT")
    if "is_managed" not in existing:
        conn.execute("ALTER TABLE category_rule ADD COLUMN is_managed INTEGER NOT NULL DEFAULT 0")
    _seed_rule_cleanup_data(conn)


def _seed_rule_cleanup_data(conn):
    # The *data* half of migration 15 (the ALTERs live in the migration). Also re-run after restoring a
    # backup older than v15, so restored data gets the same managed-flagging + last_effect_date seed.
    # Flag existing money-movement rules as managed (match_source_text, account_type-scoped, pointing at the
    # seeded Transfers → Money movement leaf) so they're excluded from cleanup like newly-created ones.
    mm_leaf = conn.execute(
        """SELECT c.id FROM category c JOIN category p ON p.id = c.parent_id
           WHERE c.name = 'Money movement' AND p.name = 'Transfers' AND p.parent_id IS NULL"""
    ).fetchone()
    if mm_leaf:
        conn.execute(
            "UPDATE category_rule SET is_managed = 1 WHERE match_source_text = 1 AND account_type IS NOT NULL AND category_id = ?",
            (mm_leaf["id"],),
        )
    # The seed is *best-effort*: a hiccup deriving the initial dates must never leave the migration
    # half-applied. A skipped seed self-heals — forward stamping and the next Run categorization populate
    # last_effect_date. NULL dates just read as "never used" until then.
    try:
        _backfill_rule_last_effect_date(conn)
    except Exception as exc:  # noqa: BLE001 — best-effort seed; the columns are what must land
        log_info(
            f"[db] rule last_effect_date backfill skipped ({exc}); will populate on next categorization",
            keep_in_file=True,
        )


def _backfill_rule_last_effect_date(conn):
    # Seed last_effect_date once: for each transaction, attribute its date to the rule(s) currently supplying
    # a *live* effect on it — the winning category rule (row is category_source='rule' and matches), the
    # winning rename rule (display_name_source='rule'), and any rule contributing a live tag — keeping the max
    # date per rule. Reuses the live categorizer so attribution matches what an apply would do (no drift).
    # One-time (only when advancing past v15); O(txns × rules), acceptable as an upgrade step.
    from backend.services.categorizer import (
        categorize_transaction,
        effect_rule_ids,
        load_categorization_rules,
        load_rule_tags_by_id,
        source_match_text_from_json,
    )

    # Skip on a partial/legacy schema (the isolated per-migration unit tests hand-build minimal tables):
    # the derived seed needs the full modern columns. A skipped seed is safe — forward stamping and the
    # next Run categorization populate last_effect_date anyway.
    txn_cols = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
    rule_cols = {r["name"] for r in conn.execute("PRAGMA table_info(category_rule)")}
    required_txn = {"date", "merchant_name", "display_name", "raw_name", "amount", "owner_id",
                    "account_id", "category_id", "category_source", "display_name_source", "import_evidence_json"}
    required_rule = {"amount_min", "amount_max", "debit_credit", "owner_id", "clean_name", "account_type", "match_expr"}
    if not (required_txn <= txn_cols and required_rule <= rule_cols):
        return

    rules = load_categorization_rules(conn)
    if not rules:
        return
    rules_by_id = {r["id"]: r for r in rules}
    rule_tags_by_id = load_rule_tags_by_id(conn)
    needs_source_text = any(r["match_source_text"] for r in rules)

    rows = conn.execute(
        """SELECT t.id, t.date, t.merchant_name, t.display_name, t.raw_name, t.amount, t.owner_id,
                  t.account_id, t.category_id, t.category_source, t.display_name_source, t.import_evidence_json,
                  COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                  COALESCE(p.type, a.type) AS effective_account_type
           FROM   txn t
           JOIN   account a ON a.id = t.account_id
           LEFT   JOIN account p ON p.id = a.parent_account_id"""
    ).fetchall()

    max_date: dict = {}

    def bump(rule_id, date):
        if date and (rule_id not in max_date or date > max_date[rule_id]):
            max_date[rule_id] = date

    for row in rows:
        date = row["date"]
        if not date:
            continue
        source_text = source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None
        result = categorize_transaction(
            row["merchant_name"], row["raw_name"], row["amount"], conn,
            owner_id=row["owner_id"], account_id=row["account_id"],
            effective_account_id=row["effective_account_id"], effective_account_type=row["effective_account_type"],
            rules=rules, rule_tags_by_id=rule_tags_by_id, source_text=source_text,
        )
        if not result:
            continue
        # Credit the rule(s) that *win* this row — the same "would this rule supply the effect" attribution
        # every live apply/import path uses (effect_rule_ids), so the seed agrees with incremental stamping.
        # Crucially this credits a row the rule wins even when import or an earlier manual set currently holds
        # the category/name (category_source != 'rule'): the rule is still what categorizes that merchant, so
        # it isn't stale. A row shadowed by a more-specific rule credits that winner, not this rule.
        for rid in effect_rule_ids(result, rules_by_id, rule_tags_by_id):
            bump(rid, date)

    for rid, date in max_date.items():
        conn.execute("UPDATE category_rule SET last_effect_date = ? WHERE id = ?", (date, rid))


@migration(16)
def _add_amazon_pending_item(conn):
    # Amazon items imported *before* their orders file: instead of discarding them, their per-item detail is
    # parked here keyed by order id, so a later import of the matching orders file auto-attaches it (no manual
    # re-import). One row per order id (upserted), holding the items as JSON. `parked_batch_id` ties the row
    # to the orphan import that created it, so undoing that import removes its parked items. Fresh installs get
    # the table from the baseline CREATE in init_db.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS amazon_pending_item (
            order_id         TEXT PRIMARY KEY,
            items_json       TEXT NOT NULL,
            source_file      TEXT,
            source_file_hash TEXT,
            parked_batch_id  TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


@migration(17)
def _add_amazon_charge_reviewed(conn):
    # Acknowledgments for the reconciliation report's reverse-scan ("Unaccounted charge") bucket: a charge the
    # user marked reviewed drops out of the batch's attention count while staying listed. One row per charge.
    # Fresh installs get the table from the baseline CREATE in init_db.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS amazon_charge_reviewed (
            txn_id      TEXT PRIMARY KEY REFERENCES txn(id) ON DELETE CASCADE,
            reviewed_at TEXT NOT NULL
        )
    """)


@migration(18)
def _add_connection_table(conn):
    # Provider-agnostic connections supersede plaid_item as the credential store. Fresh installs get the table from init_db's baseline
    # CREATE; existing databases get it here, then legacy plaid_item rows are folded into connection rows
    # (the data half, below). This runs before v20, which renames the account columns and finally drops the
    # plaid_item table — so the plaid_item_id references here operate on the still-legacy pre-v20 schema.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS connection (
            id             TEXT PRIMARY KEY,
            provider       TEXT NOT NULL,
            external_id    TEXT,
            credential     TEXT NOT NULL DEFAULT '',
            credential_enc TEXT,
            institution    TEXT,
            created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_provider_external ON connection(provider, external_id)"
    )
    _backfill_connections_from_plaid_items(conn)


def _backfill_connections_from_plaid_items(conn):
    # Fold each legacy plaid_item row into a provider='plaid' connection, carrying the encrypted credential
    # verbatim. The vault AAD for provider='plaid' is keyed on external_id == item_id (see
    # crypto_service._connection_aad), so the ciphertext still decrypts unchanged — no re-keying, no unlock
    # needed here. Idempotent: an item already represented by a connection is skipped, so this is safe to
    # re-run. Guarded on both tables existing (the isolated per-migration unit tests hand-build minimal
    # schemas). institution is best-effort from an account already linked to the item.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "plaid_item" not in tables or "connection" not in tables:
        return
    for item in conn.execute("SELECT item_id, access_token, access_token_enc FROM plaid_item").fetchall():
        already = conn.execute(
            "SELECT 1 FROM connection WHERE provider = 'plaid' AND external_id = ?",
            (item["item_id"],),
        ).fetchone()
        if already:
            continue
        inst = conn.execute(
            "SELECT institution FROM account WHERE plaid_item_id = ? AND institution IS NOT NULL LIMIT 1",
            (item["item_id"],),
        ).fetchone()
        conn.execute(
            """
            INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)
            VALUES (?, 'plaid', ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                item["item_id"],
                item["access_token"],
                item["access_token_enc"],
                inst["institution"] if inst else None,
            ),
        )


@migration(19)
def _add_provider_config_table(conn):
    # App-level provider credentials move out of `.env` into the vaulted DB. Fresh installs get the table from init_db's baseline CREATE; existing databases get it here.
    # There is **no data migration** (decided 2026-08-01): the app credential is re-entered once via the
    # provider Configure card, and `.env` remains a bootstrap/override the resolver still falls back to.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS provider_config (
            provider   TEXT PRIMARY KEY,
            client_id  TEXT NOT NULL DEFAULT '',
            secret     TEXT NOT NULL DEFAULT '',
            secret_enc TEXT,
            env        TEXT NOT NULL DEFAULT 'sandbox',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


@migration(20)
def _account_connection_columns(conn):
    # Make the account→connection link provider-neutral. Rename
    # plaid_account_id → external_account_id (the per-account provider handle); replace the plaid_item_id
    # string — a Plaid item_id, or the 'csv_import'/'manual' sentinels — with an explicit connection_id FK
    # (→ connection.id, NULL when an account isn't backed by a live connection) plus a provider
    # discriminator; then drop the now-vestigial plaid_item table (connection has been the credential store
    # since v18). Uses in-place ALTERs (SQLite ≥ 3.35 for DROP COLUMN) rather than a table rebuild, so the
    # account.id that every other table's FK references is never dropped. Fresh installs get the final shape
    # from init_db's baseline CREATE and never reach here.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(account)")}
    if "external_account_id" in cols or "plaid_account_id" not in cols:
        return  # already migrated, or a minimal hand-built fixture without the legacy column
    conn.execute("ALTER TABLE account RENAME COLUMN plaid_account_id TO external_account_id")
    conn.execute(
        "ALTER TABLE account ADD COLUMN connection_id TEXT REFERENCES connection(id) ON DELETE SET NULL"
    )
    conn.execute("ALTER TABLE account ADD COLUMN provider TEXT")
    # Backfill from the legacy plaid_item_id: a real item_id joins to its connection (id + provider), while
    # the sentinels map to an origin-only provider with no connection (connection_id stays NULL).
    conn.execute("""
        UPDATE account
           SET connection_id = (SELECT c.id FROM connection c WHERE c.external_id = plaid_item_id),
               provider = COALESCE(
                   (SELECT c.provider FROM connection c WHERE c.external_id = plaid_item_id),
                   CASE plaid_item_id WHEN 'csv_import' THEN 'csv'
                                      WHEN 'manual'     THEN 'manual'
                                      ELSE 'plaid' END)
    """)
    conn.execute("ALTER TABLE account DROP COLUMN plaid_item_id")
    conn.execute("DROP TABLE IF EXISTS plaid_item")


@migration(21)
def _add_import_batch_connection_id(conn):
    # A data-source sync now records its rows on a per-(connection, calendar-month) import_batch card
    # (source_kind='connection_sync'), so synced rows carry an import_batch_id and gain a duplicate-review
    # home like any imported file (record-first, then detection). connection_id links
    # the period card back to the connection that produced it; it is the indexed key sync uses to resolve
    # "the current period's card for this connection". NULL for ordinary CSV/marketplace batches. Fresh
    # installs get the column + index from the import_batch baseline CREATE TABLE; existing databases here.
    conn.execute(
        "ALTER TABLE import_batch ADD COLUMN connection_id TEXT REFERENCES connection(id) ON DELETE SET NULL"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_import_batch_connection ON import_batch(connection_id)"
    )


@migration(22)
def _add_connection_sync_cursor(conn):
    # Cursor-based incremental sync via the provider's /transactions/sync API (Plaid). `transactions_cursor`
    # persists the paging cursor per connection so routine syncs pull only deltas; `initial_sync_complete`
    # records whether the historical backfill has finished (HISTORICAL_UPDATE_COMPLETE), which decides
    # whether synced rows land on the connection's single "initial import" card or the monthly period cards.
    # Fresh installs get both columns from the connection baseline CREATE TABLE; existing databases here.
    # A database from before v18 has no `connection` table, so init_db's script creates it in today's
    # shape before this runs, columns included.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)").fetchall()}
    if "transactions_cursor" not in cols:
        conn.execute("ALTER TABLE connection ADD COLUMN transactions_cursor TEXT")
    if "initial_sync_complete" not in cols:
        conn.execute("ALTER TABLE connection ADD COLUMN initial_sync_complete INTEGER NOT NULL DEFAULT 0")


@migration(23)
def _add_connection_sync_log(conn):
    # Developer-options diagnostic log of provider sync calls, so a sync that under-fetches (e.g. only the
    # ~30-day Initial Update lands, never the historical backfill) can be explained from the recorded
    # transactions_update_status sequence rather than guessed at. Purely additive; captured only when
    # developer options are enabled (see routers/sync.py). Fresh installs get the table from the connection
    # baseline CREATE in init_db; existing databases gain it here. The started_at index is created in
    # init_db just after migrations, where the table is guaranteed to exist on both paths.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS connection_sync_log (
            id              TEXT PRIMARY KEY,
            connection_id   TEXT REFERENCES connection(id) ON DELETE SET NULL,
            provider        TEXT,
            institution     TEXT,
            started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            finished_at     TEXT,
            mode            TEXT,
            days_requested  INTEGER,
            cursor_before   TEXT,
            cursor_after    TEXT,
            pages           INTEGER NOT NULL DEFAULT 0,
            added           INTEGER NOT NULL DEFAULT 0,
            updated         INTEGER NOT NULL DEFAULT 0,
            removed         INTEGER NOT NULL DEFAULT 0,
            skipped         INTEGER NOT NULL DEFAULT 0,
            status_sequence TEXT,
            final_status    TEXT,
            became_complete INTEGER NOT NULL DEFAULT 0,
            error           TEXT
        )
    """)


@migration(24)
def _add_connection_account_mapping(conn):
    # Per-connection account mapping (the data-source analog of a CSV import's account step) plus the
    # fields a connection captures. `connection_account` itself is created by init_db's CREATE TABLE IF
    # NOT EXISTS script on both paths, so only the columns on *existing* tables are added here; its
    # account_id index is likewise in the baseline script, since the table is new and cannot predate it.
    #
    # The mapping is not merely UX: it is the missing input to duplicate detection. The ladder's
    # cross-account rules fire only when the receiving account already appears in the matching coverage or
    # was explicitly declared an alias, and a sync could satisfy neither — so a charge already imported
    # from a CSV came back from the provider as a second copy on a second account. See docs/data-model.md.
    # Already there when init_db's script created `connection` for a database from before v18 (see v22).
    if "captured_fields" not in {r["name"] for r in conn.execute("PRAGMA table_info(connection)").fetchall()}:
        conn.execute("ALTER TABLE connection ADD COLUMN captured_fields TEXT")
    # The transaction/authorization date, distinct from `date` (posted). Two sources routinely date the
    # same charge differently — one reports the transaction date, the other the posted date — so the
    # ladder tests both. NULL wherever the source publishes only one date, which is most CSVs.
    conn.execute("ALTER TABLE txn ADD COLUMN authorized_date TEXT")
    # How many trailing days of a source's covered range are SOFT (reconciled one-to-one rather than
    # blanket-rejected). See v25, which is what actually moves this off the original single-terminal-day
    # behavior — the two are split so a database that already ran v24 lands in the same place as one
    # migrating straight through.
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN terminal_window_days INTEGER NOT NULL DEFAULT 7")

    _backfill_connection_account_mapping(conn)


def _backfill_connection_account_mapping(conn):
    """Data half of v24 (also replayed after a restore from an older backup).

    Two fixes, both about existing connections looking like brand-new unmapped ones:

    1. Every account already linked to a connection gets a `connection_account` row recording what is
       already true — that this local account IS that provider account — as `mapping_mode='existing'`.
       Without it, a connection the user linked months ago would show every account as undecided and the
       ladder would treat none of them as an alias.
    2. Sync cards' `import_batch_account.csv_value` is rewritten from the provider's opaque external
       account id to the provider account label. Rows keyed on the opaque id are invisible to every
       source-scoped rule and read as noise in the import history.

    Coverage is deliberately NOT seeded here. It cannot be derived from schema alone — only from the
    ledger — and a connection with a hole in the middle of its history (a past disconnect or cursor reset)
    would claim a range it does not cover and hard-reject legitimate rows inside it. That derivation is a
    local, inspect-before-applying step, not a migration.
    """
    # Same guard, and same reason, as v20's: a minimal hand-built fixture may not carry the provider-link
    # columns v20 introduces, and there is nothing to backfill from without them. A real database always
    # has them by this point, so this never skips work that exists.
    account_cols = {r["name"] for r in conn.execute("PRAGMA table_info(account)")}
    if not {"connection_id", "external_account_id"} <= account_cols:
        return

    linked = conn.execute(
        """
        SELECT a.id, a.connection_id, a.external_account_id, a.name, a.display_name,
               a.type, a.subtype, a.mask
        FROM   account a
        WHERE  a.connection_id IS NOT NULL AND a.external_account_id IS NOT NULL
        """
    ).fetchall()
    for row in linked:
        conn.execute(
            """
            INSERT OR IGNORE INTO connection_account
                (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                 provider_name, provider_type, provider_subtype, provider_mask)
            VALUES (?,?,?,'existing',?,?,?,?,?)
            """,
            (row["connection_id"], row["external_account_id"], row["id"], row["id"],
             row["name"], row["type"], row["subtype"], row["mask"]),
        )

    # `csv_value` is half of import_batch_account's primary key, so a rewrite can collide with a row that
    # already carries the label. Update only where no such row exists, and drop the loser otherwise —
    # its counts have already been folded in by whichever row got there first.
    for row in conn.execute(
        """
        SELECT iba.rowid AS rid, iba.batch_id, iba.csv_value, ca.provider_name, ca.provider_mask
        FROM   import_batch_account iba
        JOIN   import_batch b  ON b.id = iba.batch_id
        JOIN   connection_account ca
               ON ca.connection_id = b.connection_id AND ca.external_account_id = iba.csv_value
        WHERE  b.connection_id IS NOT NULL
        """
    ).fetchall():
        name = str(row["provider_name"] or "").strip()
        mask = str(row["provider_mask"] or "").strip()
        if name and mask:
            label = f"{name} ···{mask}"
        elif name:
            label = name
        elif mask:
            label = f"···{mask}"
        else:
            continue  # nothing better to call it than the id it already has
        clash = conn.execute(
            "SELECT 1 FROM import_batch_account WHERE batch_id = ? AND csv_value = ?",
            (row["batch_id"], label),
        ).fetchone()
        if clash:
            conn.execute("DELETE FROM import_batch_account WHERE rowid = ?", (row["rid"],))
        else:
            conn.execute(
                "UPDATE import_batch_account SET csv_value = ? WHERE rowid = ?", (label, row["rid"])
            )


@migration(25)
def _widen_default_csv_terminal_window(conn):
    # v24 added `csv_import_profile.terminal_window_days` defaulted to 1 — "only the export day is
    # incomplete" — on the premise that widening should be opt-in per source. That premise was
    # backwards. **Most sources lag the thing they describe**: an aggregator waits on the bank, and
    # even a bank's own export waits on its pending pipeline. Only a first-party export of records the
    # source itself created (a store, a payment service) has no lag. Defaulting to "no lag" therefore
    # made the unusual case the default, and its failure mode is the bad one — a real transaction the
    # earlier export had not caught yet gets blanket-rejected as "already covered" and leaves the
    # ledger, discoverable only by opening that file's duplicate report. The opposite error costs one
    # extra one-to-one reconciliation pass, which still catches true duplicates and names them.
    #
    # Rewriting stored 1s is sound *only here*, and only once: the setting had no writer of any kind
    # until the data-source editor gained the field, so at this point every 1 in the table is v24's
    # column default rather than anyone's decision. After this migration a 1 IS a decision, and nothing
    # touches it again.
    _widen_unset_csv_terminal_window(conn)


def _widen_unset_csv_terminal_window(conn):
    """Data half of v25 (also replayed after a restore from a pre-v25 backup, whose profile rows carry
    the old default)."""
    conn.execute(
        "UPDATE csv_import_profile SET terminal_window_days = ? WHERE terminal_window_days = 1",
        (DEFAULT_CSV_TERMINAL_WINDOW_DAYS,),
    )


@migration(26)
def _rename_txn_provider_transaction_id(conn):
    # The column has held *any* provider's transaction id since the connection seam (6a) — the key that
    # makes a sync idempotent — but kept the name it was given when Plaid was the only provider. A second
    # provider makes that actively misleading, so it follows plaid_account_id → external_account_id (v20).
    # An in-place RENAME COLUMN carries the inline UNIQUE constraint's implicit index with it; nothing else
    # references the column by name. Fresh installs get the final name from init_db's baseline CREATE and
    # never reach here.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
    if "external_transaction_id" in cols or "plaid_transaction_id" not in cols:
        return  # already migrated, or a minimal hand-built fixture without the legacy column
    conn.execute("ALTER TABLE txn RENAME COLUMN plaid_transaction_id TO external_transaction_id")


@migration(27)
def _add_connection_sync_status(conn):
    # Sync health, so the Connections card can report it while collapsed — a failure a user must expand a
    # card to discover is one they will not discover. Four columns rather than one because they answer
    # different questions (see the baseline CREATE for what each means and why they are not collapsed).
    # Existing rows start with no history: NULL last_synced_at reads as "never synced here", which is the
    # honest answer — nothing recorded the time of syncs that happened before this column existed.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
    # An empty set means the table isn't there at all — a minimal hand-built fixture in the isolated
    # per-migration tests, which build only the table under test.
    if not cols or "last_synced_at" in cols:
        return
    conn.execute("ALTER TABLE connection ADD COLUMN last_synced_at TEXT")
    conn.execute("ALTER TABLE connection ADD COLUMN last_sync_error TEXT")
    conn.execute("ALTER TABLE connection ADD COLUMN last_sync_error_at TEXT")
    # A DDL default does not apply retroactively on an existing DB, so the backfill is explicit — and every
    # insert site states the value rather than relying on the default.
    conn.execute("ALTER TABLE connection ADD COLUMN consecutive_sync_failures INTEGER NOT NULL DEFAULT 0")
    conn.execute("UPDATE connection SET consecutive_sync_failures = 0 WHERE consecutive_sync_failures IS NULL")
    conn.execute("ALTER TABLE connection ADD COLUMN last_sync_warnings TEXT")


@migration(28)
def _per_account_history_state(conn):
    # Backfill depth and completeness move from the connection's opaque resume token onto the account they
    # actually describe. See the baseline CREATE for what each column means and why `history_complete` is
    # not derivable from `coverage_start_date`.
    #
    # Existing rows take the defaults, and both are right: `history_complete = 0` says only "we have not
    # established that this account's history has ended", which is the honest position for an account whose
    # end was previously concluded at the connection level. The cost of that conservatism is one extra
    # window fetched per account on the next deep pull; the cost of guessing the other way would be
    # history that is never fetched again.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_account)")}
    if not cols or "history_complete" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    # A DDL default does not apply retroactively on an existing DB, so both are set explicitly here — and
    # every insert site states the value rather than relying on the default.
    conn.execute("ALTER TABLE connection_account ADD COLUMN history_complete INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE connection_account ADD COLUMN history_empty_streak INTEGER NOT NULL DEFAULT 0")
    conn.execute("UPDATE connection_account SET history_complete = 0, history_empty_streak = 0")


@migration(29)
def _connection_account_currency(conn):
    # The provider account's denomination, so an account the ledger cannot hold is visible at mapping time
    # rather than discovered as an account that syncs cleanly and stays empty. See the baseline CREATE.
    #
    # Existing rows take NULL, which reads as "not stated" and therefore as supported — the right default:
    # every connection predating this column was syncing without complaint, so treating them as unsupported
    # would stop working connections on no evidence. The next connect or "Refresh accounts" fills the value
    # in from the provider.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_account)")}
    if not cols or "provider_currency" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE connection_account ADD COLUMN provider_currency TEXT")


@migration(30)
def _connection_reauth_required(conn):
    # Whether the provider has stopped accepting this connection's credential — the one sync failure the
    # user can act on, kept apart from the failure count. See the baseline CREATE.
    #
    # A DDL default does not apply retroactively on an existing DB, so the value is set explicitly here, and
    # every insert site states it. 0 is right for existing rows in both directions: a connection that is
    # working is unaffected, and one that is genuinely revoked raises the flag on its very next sync.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
    if not cols or "reauth_required" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE connection ADD COLUMN reauth_required INTEGER NOT NULL DEFAULT 0")
    conn.execute("UPDATE connection SET reauth_required = 0")


@migration(31)
def _sync_log_messages(conn):
    # The sync log recorded a hard `error` and nothing else, so a pull that *succeeded* while quietly
    # importing nothing — a bank reporting a problem alongside its siblings' data, an account whose rows
    # had nowhere to land — left a row that looked clean. Both message lists land here as JSON: `warnings`
    # (user-actionable, mirroring the connection card) and `advisories` ([{message, count}], nobody's to
    # act on and recorded nowhere else). See the baseline CREATE for the full note.
    #
    # Nullable with no DDL default, since a default would not apply to existing rows anyway: NULL reads as
    # "this call recorded none", which is exactly right for rows written before the columns existed. Every
    # insert site states both values (`_write_sync_diagnostics`).
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}
    if not cols:
        return  # a minimal hand-built fixture without the table
    if "warnings" not in cols:
        conn.execute("ALTER TABLE connection_sync_log ADD COLUMN warnings TEXT")
    if "advisories" not in cols:
        conn.execute("ALTER TABLE connection_sync_log ADD COLUMN advisories TEXT")


@migration(32)
def _sync_log_skip_breakdown(conn):
    # `skipped` was one number covering three unrelated events, only one of which means data was lost, so
    # it could not be surfaced anywhere without crying wolf on every routine sync (the incremental overlap
    # re-asks for days already held on purpose). Split into the alarming half, the routine half, and a
    # per-account breakdown — see the baseline CREATE. The total stays as it was.
    #
    # Counts default to 0 and the ALTER applies that to existing rows, which is the honest reading: rows
    # written before the split recorded no breakdown, and 0 is what "not recorded" looks like in a sum.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}
    if not cols:
        return  # a minimal hand-built fixture without the table
    if "skipped_no_account" not in cols:
        conn.execute("ALTER TABLE connection_sync_log ADD COLUMN skipped_no_account INTEGER NOT NULL DEFAULT 0")
    if "skipped_already_held" not in cols:
        conn.execute("ALTER TABLE connection_sync_log ADD COLUMN skipped_already_held INTEGER NOT NULL DEFAULT 0")
    if "account_counts" not in cols:
        conn.execute("ALTER TABLE connection_sync_log ADD COLUMN account_counts TEXT")


@migration(33)
def _connection_sync_in_progress(conn):
    # Marks a sync that is currently running, so the in-progress state survives the page that started it —
    # the poll loop lives in component state, so navigating away re-enabled "Sync now" and invited a second
    # concurrent pull. NULL means idle, which is the right value for every existing row: nothing was running
    # when this migration applied. See the baseline CREATE for why it is written outside the pull's own
    # transaction, and `sync_marker_is_live` for why it expires.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
    if not cols or "sync_started_at" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE connection ADD COLUMN sync_started_at TEXT")


@migration(34)
def _sync_log_destination_and_windows(conn):
    # Two facts a sync log row could not previously state: which import cards the rows landed on, and which
    # date ranges were actually requested to get them. Both are diagnostics with no reader before this
    # migration, so existing rows stay NULL — "not recorded", which is what they are. See the baseline
    # CREATE for why each is worth storing.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}
    if not cols:
        return  # a minimal hand-built fixture without the table
    if "card_counts" not in cols:
        conn.execute("ALTER TABLE connection_sync_log ADD COLUMN card_counts TEXT")
    if "requested_windows" not in cols:
        conn.execute("ALTER TABLE connection_sync_log ADD COLUMN requested_windows TEXT")


@migration(35)
def _connection_request_budget(conn):
    # What a connection has spent against a metered provider's published request limits, split out from
    # transactions_cursor because the two must persist under opposite rules — see the baseline CREATE.
    #
    # Existing rows stay NULL, which reads as "nothing recorded" and grants a full allowance on the next
    # sync. For the one provider this affects, that is not quite free: its allowance used to live inside the
    # resume token, so a connection could have spent today's already. The adapter reads those legacy fields
    # out of its own checkpoint on first use rather than having them copied here — the shape is the
    # adapter's private business, and this migration has no license to parse it.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
    if not cols or "provider_request_budget" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE connection ADD COLUMN provider_request_budget TEXT")


@migration(36)
def _connection_sync_progress(conn):
    # Live progress of a running sync, so a pull that takes minutes can be observed while it happens rather
    # than only reported once it ends — see the baseline CREATE. Existing rows stay NULL, which is exactly
    # right: nothing was running when this migration applied.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
    if not cols or "sync_progress" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE connection ADD COLUMN sync_progress TEXT")


@migration(37)
def _sync_log_request_allowance(conn):
    # The level of the metered allowance a pull left behind — see the baseline CREATE. Existing rows stay
    # NULL, which reads correctly: those syncs did not record their allowance, as distinct from having had
    # none. The UI has to keep the two apart, so the column carries no default.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}
    if not cols or "request_allowance" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE connection_sync_log ADD COLUMN request_allowance TEXT")


@migration(38)
def _connection_last_sync_summary(conn):
    # What the last sync did, stored on the connection instead of derived from the sync log on read — see
    # the baseline CREATE for why a user-facing summary cannot rest on a prunable, user-clearable
    # diagnostic. Existing rows are backfilled from each connection's newest surviving log row so no card
    # blanks out on upgrade; a connection whose rows have already aged out of the buffer stays NULL, which
    # reads as "no record yet" until its next sync.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
    if not cols or "last_sync_outcome" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE connection ADD COLUMN last_sync_outcome TEXT")
    conn.execute("ALTER TABLE connection ADD COLUMN last_sync_summary TEXT")
    if not {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}:
        return  # no log to backfill from
    for c in conn.execute("SELECT id FROM connection").fetchall():
        row = conn.execute(
            "SELECT * FROM connection_sync_log WHERE connection_id = ? "
            "ORDER BY started_at DESC, id DESC LIMIT 1",
            (c["id"],),
        ).fetchone()
        if row is None:
            continue
        keys = set(row.keys())
        try:
            accounts = json.loads(row["account_counts"] or "") if "account_counts" in keys else {}
        except (TypeError, ValueError):
            accounts = {}
        if not isinstance(accounts, dict):
            accounts = {}
        # Historic per-account counts use the pre-split key, and which kind of no-destination row they
        # were is not recoverable — the mapping that would answer it is today's, not the one in force when
        # the pull ran. Normalized to the unknown-account bucket so the card's chips keep their counts;
        # nothing alarms on the distinction, so the conservative label costs nothing here.
        for counts in accounts.values():
            if isinstance(counts, dict) and counts.get("skipped_no_account"):
                counts["skipped_unknown_account"] = (
                    int(counts.get("skipped_unknown_account") or 0)
                    + int(counts.pop("skipped_no_account") or 0)
                )
        already_held = int(row["skipped_already_held"] or 0) if "skipped_already_held" in keys else 0
        mode = row["mode"]
        if row["error"]:
            outcome = "failed"
        elif mode == "initial" and already_held > 0:
            outcome = "attention"
        elif mode == "initial" and not row["became_complete"]:
            outcome = "incomplete"
        else:
            outcome = "ok"
        conn.execute(
            "UPDATE connection SET last_sync_outcome = ?, last_sync_summary = ? WHERE id = ?",
            (outcome, json.dumps({
                "at": row["started_at"], "mode": mode, "added": row["added"] or 0,
                "updated": row["updated"] or 0, "removed": row["removed"] or 0, "accounts": accounts,
            }), c["id"]),
        )


@migration(39)
def _transaction_splits(conn):
    # Split allocations and the flag that marks a transaction as carrying them — see the baseline CREATE
    # for why the marker is a column rather than a derived EXISTS test. Existing rows take the DDL
    # default 0, which reads correctly: nothing was split before this table existed. The table is created
    # here as well as in the baseline script because an existing database never re-runs that script's
    # CREATE for a table it already has — but it has never seen txn_split at all.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
    if not cols:
        return  # a minimal hand-built fixture without the table
    if "is_split" not in cols:
        conn.execute("ALTER TABLE txn ADD COLUMN is_split INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS txn_split (
            id          TEXT PRIMARY KEY,
            txn_id      TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
            category_id TEXT REFERENCES category(id) ON DELETE SET NULL,
            amount      REAL NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0
        )
        """
    )


@migration(40)
def _transaction_split_labels(conn):
    # What each allocation covers, in the user's own words — see the baseline CREATE. Existing rows stay
    # NULL, which reads correctly: a split made before this column existed recorded no label, as
    # distinct from having had an empty one. Descriptive only, so nothing has to be backfilled for a
    # report to stay right.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(txn_split)")}
    if not cols or "label" in cols:
        return  # already migrated, or a minimal hand-built fixture without the table
    conn.execute("ALTER TABLE txn_split ADD COLUMN label TEXT")


@migration(41)
def _split_parts_may_repeat_a_category(conn):
    # A split records the *items* a payment covered, and two items bought together may classify into
    # the same category — two records from one order are two purchases, not one. The unique index that
    # forbade that is dropped; lookups reach a split's parts through idx_txn_split_txn, which stays.
    # Nothing has to be rewritten: no stored row can violate the looser rule, and the reporting side
    # already counts distinct transactions rather than allocation rows.
    conn.execute("DROP INDEX IF EXISTS idx_txn_split_txn_category")


@migration(42)
def _add_document(conn):
    # Attached receipts and invoices — see the baseline CREATE for the column semantics and
    # services/documents.py for the store. Created here as well as in the baseline script because an
    # existing database never re-runs that script's CREATE for a table it already has, and it has never
    # seen `document` at all. Nothing is backfilled: no document can predate the table.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS document (
            id          TEXT PRIMARY KEY,
            txn_id      TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
            filename    TEXT NOT NULL,
            mime_type   TEXT NOT NULL,
            byte_size   INTEGER NOT NULL,
            sha256      TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            text        TEXT,
            text_source TEXT
        )
        """
    )


@migration(43)
def _add_restore_state(conn):
    # Tracks a restore across the gap between its ledger commit and its document files — see the
    # baseline CREATE for why it is in this database and in a table of its own. Created here as well
    # because an existing database has never seen it; nothing is backfilled, since a restore that
    # predates the table cannot have been interrupted in a way this could describe.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS restore_state (
            id             INTEGER PRIMARY KEY CHECK (id = 1),
            phase          TEXT NOT NULL,
            started_at     TEXT NOT NULL,
            artifact_path  TEXT,
            artifact_id    TEXT
        )
        """
    )


@migration(44)
def _add_recurring_signal_dismissal(conn):
    # The user's dismissals of recurring anomaly signals — see the baseline CREATE for why the signals
    # themselves are derived and this is the whole of their durable state. Created here as well because
    # an existing database has never seen the table; nothing is backfilled, since no signal could have
    # been dismissed before there were any to dismiss.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS recurring_signal_dismissal (
            signal_key   TEXT PRIMARY KEY,
            kind         TEXT NOT NULL,
            dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )


@migration(45)
def _add_rule_overlap_dismissal(conn):
    # The user's acknowledgements of rule-overlap findings — see the baseline CREATE for why the findings
    # themselves are derived and this is the whole of their durable state. Nothing is backfilled: no
    # finding could have been dismissed before there were any to dismiss.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rule_overlap_dismissal (
            finding_key  TEXT PRIMARY KEY,
            kind         TEXT NOT NULL,
            dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )


@migration(46)
def _add_recurring_series_amount_mode(conn):
    # Whether a series carries its amount as part of its identity — see the baseline CREATE. Every
    # existing row takes 'variable', which is the behavior they were detected under (amount was never a
    # matching gate before this), so nothing changes until a scan re-mints a group that amount splits.
    #
    # `PRAGMA table_info` on a table that does not exist returns no rows, which is indistinguishable
    # from a table lacking the column — so the table itself is checked first. `ALTER TABLE` has no
    # `IF NOT EXISTS` form, and this is its equivalent: the migration chain runs in full against the
    # hand-built partial schemas the older migration tests stand up, which carry only the tables their
    # own migration touches. On any real database the table is always present.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(recurring_series)").fetchall()}
    if not cols:
        return
    if "amount_mode" not in cols:
        conn.execute(
            "ALTER TABLE recurring_series ADD COLUMN amount_mode TEXT NOT NULL DEFAULT 'variable'"
        )
    # The pinned expectation band — see the baseline CREATE for why it is not the derived band. Left
    # NULL everywhere: nothing can have been pinned before there was a way to pin it.
    for column in ("expected_min", "expected_max"):
        if column not in cols:
            conn.execute(f"ALTER TABLE recurring_series ADD COLUMN {column} REAL")

    # Riding along: the vestigial partial unique index guarding `recurring_membership_override.state =
    # 'pinned'`, the withdrawn feature that forced a row *into* a series it does not match. Nothing
    # writes that state — the endpoint rejects it and `_load_overrides` filters on 'excluded' — so the
    # index is inert and dropping it changes no behavior, which is exactly why it was queued for the
    # next migration written for another reason rather than given a version bump of its own. The `state`
    # column stays: 'excluded' still uses it.
    conn.execute("DROP INDEX IF EXISTS idx_recurring_override_pin")


@migration(47)
def _add_suspect_pair_distinct(conn):
    # Per-pair "not the same charge" judgements — see the baseline CREATE for why Keep needed one and
    # what breaks without it. Created here as well because an existing database has never seen the table.
    # **Nothing is backfilled and nothing can be**: Keep clears the pointer naming the pair, so a past
    # judgement records only that the row was resolved, not what against. The consequence is deliberate
    # and was chosen over guessing — the first version-gated re-scan re-raises historical Keeps once, and
    # the user's answers are recorded properly from then on.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS suspect_pair_distinct (
            txn_id_low  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
            txn_id_high TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
            asserted_at TEXT NOT NULL,
            PRIMARY KEY (txn_id_low, txn_id_high),
            CHECK (txn_id_low < txn_id_high)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_suspect_pair_distinct_high ON suspect_pair_distinct(txn_id_high)"
    )


@migration(48)
def _suspect_pair_distinct_remembers_the_flag(conn):
    # What the flag was before Keep cleared it, so an Undo restores that finding rather than whatever a
    # re-derivation would produce today — see the baseline CREATE. Nullable: rows written by v47 have no
    # record of it, and a judgement with no remembered flag simply cannot be undone, which is the honest
    # outcome rather than a guessed one.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(suspect_pair_distinct)").fetchall()}
    if not cols:
        return
    for column in ("flagged_txn_id", "reason"):
        if column not in cols:
            conn.execute(f"ALTER TABLE suspect_pair_distinct ADD COLUMN {column} TEXT")


@migration(49)
def _suppressed_series_remember_their_members(conn):
    # What a series held when it was suppressed — see the baseline CREATE for why re-deriving it does not
    # work. Nullable, and deliberately not backfilled: the links a v48 suppression dropped are gone, and
    # inventing a set by matching would recreate exactly the disagreement this removes. Those series keep
    # falling back to identity matching, and the drill-down reconciles its count to what that returns.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(recurring_series)").fetchall()}
    if cols and "suppressed_member_ids" not in cols:
        conn.execute("ALTER TABLE recurring_series ADD COLUMN suppressed_member_ids TEXT")


@migration(50)
def _series_can_span_two_accounts(conn):
    # The far account of a two-legged money movement — see the baseline CREATE. Additive and nullable, so
    # every existing series reads as what it is (a payee series) with no backfill. Transfer series appear
    # on the next scan, which re-derives auto series wholesale anyway; a confirmed payee series covering
    # rows a movement would now claim keeps them, because user curation always outranks a fresh reading.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(recurring_series)").fetchall()}
    if cols and "counterpart_account_id" not in cols:
        conn.execute("ALTER TABLE recurring_series ADD COLUMN counterpart_account_id TEXT")


@migration(51)
def _remember_transfer_pairing_answers(conn):
    # The user's answers to the one question the transfer review asks — see the baseline CREATE. Additive
    # and empty on an existing database: nothing has been asked yet, so there is nothing to backfill, and
    # an unanswered question behaves exactly as it did before this existed.
    conn.executescript("""
        -- What the user answered when the pairing pass could not tell which of two transactions
        -- was the other half of a movement. `receiving_txn_id` names the counterpart; NULL is the
        -- dismissal ("this one has none, stop asking") — one column for both answers, because they
        -- answer the same question. Applied ahead of any inference (`services/transfer_pairs.py`):
        -- the pass never learns from a decision it made itself, only from one a person made.
        CREATE TABLE IF NOT EXISTS transfer_pair_decision (
            paying_txn_id    TEXT PRIMARY KEY REFERENCES txn(id) ON DELETE CASCADE,
            receiving_txn_id TEXT REFERENCES txn(id) ON DELETE CASCADE,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)


@migration(52)
def _a_movement_no_longer_asks_permission(conn):
    # `transfer_movement_declined` recorded "keep the series I already have" for a movement whose rows a
    # confirmed payee series held. Movements now claim those rows outright — one payment recorded twice is
    # one thing, and a payee series over it is the same payment read off two descriptions that drift — so
    # there is no offer left to decline and nothing the table can mean. It exists only on databases that
    # ran an unreleased v51, hence IF EXISTS.
    conn.execute("DROP TABLE IF EXISTS transfer_movement_declined")


@migration(53)
def _transfers_group_gets_a_durable_identity(conn):
    # `Transfers` was found by name, so renaming it left the Amazon importer and wallet funding-leg
    # suppression unable to see it: the next import built a *second* "Transfers" group and filed new
    # money-movement leaves there, while the renamed group kept the old ones. Both stayed excluded, so
    # totals never looked wrong — the leaves and their history just quietly split in two. The key is the
    # fix (see `services/excluded_categories.py`), and it also makes the group undeletable, matching
    # `Reimbursable`.
    #
    # Stamped by name because that is what the group is still identified by on an existing database, and
    # only where nothing is keyed yet, so a tree that somehow already carries one is left alone. A user
    # who renamed the group before this ran has no row to match: they keep whatever groups they have, and
    # the first write after this creates a keyed `Transfers` for the app to use from then on — the same
    # outcome as before this migration, minus the further splitting.
    # Guarded on the table and the column existing: the isolated per-migration unit tests hand-build
    # minimal schemas and then run the whole chain, so a migration that assumes the full schema fails
    # there rather than in anything a real database would hit.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "category" not in tables:
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(category)")}
    if "system_key" not in columns:
        return
    conn.execute(
        """UPDATE category SET system_key = 'transfers'
           WHERE name = 'Transfers' AND parent_id IS NULL AND system_key IS NULL"""
    )


def _unlock_trusted_import_categories(conn):
    """A file's categories rank below the rules, so a trusted-import row is no longer locked against them.

    At import a rule already beat the file's label, but once a row had taken its label it carried
    `category_overridden = 1` — the manual lock — and Run categorization left it alone for good. The outcome
    therefore depended on whether a rule or the file arrived first. Writers now store `import` unlocked;
    this clears the bit on the rows written before that. Keyed on the source, so a manual edit or a split
    keeps its lock, and it is safe to run once on any data that predates it — a restore of an older backup
    brings the old bit back with it, which is why this is also a data-init step."""
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "txn" not in tables:
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
    if not {"category_source", "category_overridden"} <= columns:
        return
    conn.execute(
        "UPDATE txn SET category_overridden = 0 WHERE category_source = 'import' AND category_overridden <> 0"
    )


@migration(54)
def _trusted_imports_yield_to_rules(conn):
    # Guarded inside the step, like v53: the isolated per-migration tests hand-build minimal schemas.
    _unlock_trusted_import_categories(conn)


def _backfill_import_batch_provider(conn):
    """Copy each sync card's provider from its connection onto the card.

    A card used to name its provider only through `connection_id`, and removing a connection nulls that
    link, so every row the connection had synced lost its "Connection" line. Cards whose connection is
    still present are filled here; a card whose connection is already gone has nothing left to copy from
    and stays NULL. Also a data-init step, since a restored older backup carries cards without the column."""
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if not {"import_batch", "connection"} <= tables:
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if not {"connection_id", "provider"} <= columns:
        return
    conn.execute(
        """UPDATE import_batch
              SET provider = (SELECT c.provider FROM connection c WHERE c.id = import_batch.connection_id)
            WHERE provider IS NULL AND connection_id IS NOT NULL"""
    )


@migration(55)
def _add_import_batch_provider(conn):
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "import_batch" not in tables:
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if "provider" not in columns:
        conn.execute("ALTER TABLE import_batch ADD COLUMN provider TEXT")
    _backfill_import_batch_provider(conn)


# The v56 shape of `connection_sync_log`, which the baseline CREATE carries with a comment per column. Written
# out rather than read back from `sqlite_master`, because an upgraded database's stored CREATE is the v23
# one with every later ALTER appended, and rewriting SQL text is the fragile way to change a constraint.
_CONNECTION_SYNC_LOG_V56 = """
    CREATE TABLE connection_sync_log_v56 (
        id                   TEXT PRIMARY KEY,
        connection_id        TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
        provider             TEXT,
        institution          TEXT,
        started_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        finished_at          TEXT,
        mode                 TEXT,
        days_requested       INTEGER,
        cursor_before        TEXT,
        cursor_after         TEXT,
        pages                INTEGER NOT NULL DEFAULT 0,
        added                INTEGER NOT NULL DEFAULT 0,
        updated              INTEGER NOT NULL DEFAULT 0,
        removed              INTEGER NOT NULL DEFAULT 0,
        skipped              INTEGER NOT NULL DEFAULT 0,
        status_sequence      TEXT,
        final_status         TEXT,
        became_complete      INTEGER NOT NULL DEFAULT 0,
        error                TEXT,
        warnings             TEXT,
        advisories           TEXT,
        skipped_no_account   INTEGER NOT NULL DEFAULT 0,
        skipped_already_held INTEGER NOT NULL DEFAULT 0,
        account_counts       TEXT,
        card_counts          TEXT,
        requested_windows    TEXT,
        request_allowance    TEXT
    )
"""


@migration(56)
def _sync_log_rows_go_with_their_connection(conn):
    # A disconnect deletes the connection, and until now its log rows stayed behind with `connection_id`
    # nulled. Every disconnected connection's rows therefore shared one id-less group: the log offered it
    # as a single filter pill labelled with whichever institution SQLite picked, and the pill could not
    # filter, because an empty id reads as "no filter". Nothing reads the log of a connection that is gone,
    # so the rows now go with it. SQLite cannot change a foreign key in place, hence the rebuild; rows that
    # already lost their connection are left behind by it, which is the cleanup the old rule never did.
    # Guarded like v53: the isolated per-migration tests hand-build minimal schemas and run the whole chain.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if not {"connection_sync_log", "connection"} <= tables:
        return
    foreign_keys = conn.execute("PRAGMA foreign_key_list(connection_sync_log)").fetchall()
    if any(fk["from"] == "connection_id" and fk["on_delete"] == "CASCADE" for fk in foreign_keys):
        return  # already rebuilt
    if "event" in {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}:
        return  # already in v60's shape, which dropped this constraint again on purpose
    conn.execute("DROP TABLE IF EXISTS connection_sync_log_v56")
    conn.execute(_CONNECTION_SYNC_LOG_V56)
    # Only the columns both shapes have: a hand-built fixture carries a subset, and every column it lacks
    # has a default in the new shape.
    current = {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log_v56)")}
    shared = ", ".join(r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")
                       if r["name"] in current)
    conn.execute(
        f"INSERT INTO connection_sync_log_v56 ({shared}) SELECT {shared} FROM connection_sync_log "
        "WHERE connection_id IN (SELECT id FROM connection)"
    )
    conn.execute("DROP TABLE connection_sync_log")
    conn.execute("ALTER TABLE connection_sync_log_v56 RENAME TO connection_sync_log")
    # Dropped with the old table; the baseline script that creates it has already run by now.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_connection_sync_log_started ON connection_sync_log(started_at)")


# The pre-v57 shape of a stored rule-suggestion review entry. An entry's partition — whether the entry owns
# its rows rather than regenerating them from the import pool — was carried as two booleans plus a
# back-reference, and the card a split remainder belonged beside had to be parsed back out of its id. These
# names are frozen copies rather than imports from the router, which is free to rename its own constants.
_LEGACY_RULE_SUGGESTION_REVIEW_KEY = "rule_suggestion_review"
_LEGACY_RULE_SUGGESTION_FOLLOWUP_ID_MARKER = ":followup:"
_LEGACY_RULE_SUGGESTION_PARTITION_KEYS = ("synthetic", "pending_override", "derived_from_suggestion_id")


def _legacy_rule_suggestion_partition(entry_id: str, entry: dict) -> dict | None:
    if entry.get("synthetic"):
        # The id of a remainder is `<the id its rows regenerate as>:followup:<origin>`, and the prefix is the
        # card it renders beside — which is what the old grouping parsed out of it on every read.
        origin_id = entry.get("derived_from_suggestion_id") or entry_id
        root_id, marker, _ = entry_id.partition(_LEGACY_RULE_SUGGESTION_FOLLOWUP_ID_MARKER)
        return {"kind": "remainder", "origin_id": origin_id, "split_root_id": root_id if marker else origin_id}
    if entry.get("pending_override"):
        return {"kind": "refined"}
    return None


def _rewrite_rule_suggestion_partitions(review_state) -> bool:
    if not isinstance(review_state, dict):
        return False
    entry_groups = [review_state.get("suggestions")]
    entry_groups.extend(
        trash_set.get("suggestions")
        for trash_set in (review_state.get("trash_sets") or [])
        if isinstance(trash_set, dict)
    )
    changed = False
    for suggestions in entry_groups:
        if not isinstance(suggestions, dict):
            continue
        for entry_id, entry in suggestions.items():
            if not isinstance(entry, dict) or not any(key in entry for key in _LEGACY_RULE_SUGGESTION_PARTITION_KEYS):
                continue
            partition = _legacy_rule_suggestion_partition(str(entry_id), entry)
            for key in _LEGACY_RULE_SUGGESTION_PARTITION_KEYS:
                entry.pop(key, None)
            entry["partition"] = partition
            changed = True
    return changed


@migration(57)
def _rule_suggestion_review_partitions_become_records(conn):
    """Convert every stored rule-suggestion review to explicit partition records.

    The review state lives in three containers — a batch's `config_snapshot`, a data source's `column_map`,
    and the system workflow state — and each can also hold entries inside a trash set, so all of them are
    walked. Deliberately **not** registered in `POST_RESTORE_DATA_INIT`: restoring a backup older than this
    leaves its flagged entries unrecognized, which costs the pending refinements and split remainders in that
    backup (their rows return to ordinary generation) and nothing else, and the alternative was carrying the
    old shape's reader forever for a case a fresh backup settles.
    """
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    containers = [
        ("import_batch", "id", "config_snapshot", "SELECT id, config_snapshot AS payload FROM import_batch"),
        ("csv_import_profile", "id", "column_map", "SELECT id, column_map AS payload FROM csv_import_profile"),
        ("import_workflow_state", "key", "payload_json",
         "SELECT key AS id, payload_json AS payload FROM import_workflow_state WHERE key = 'system_rule_suggestion_review'"),
    ]
    for table, key_column, payload_column, query in containers:
        # Guarded on the columns, not just the table: the isolated per-migration tests hand-build minimal
        # schemas holding only what the migration under test reads, and run the whole chain over them.
        if table not in tables:
            continue
        columns = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if not {key_column, payload_column} <= columns:
            continue
        for row in conn.execute(query).fetchall():
            try:
                container = json.loads(row["payload"] or "{}")
            except (TypeError, ValueError):
                continue
            if not isinstance(container, dict):
                continue
            if _rewrite_rule_suggestion_partitions(container.get(_LEGACY_RULE_SUGGESTION_REVIEW_KEY)):
                conn.execute(
                    f"UPDATE {table} SET {payload_column} = ? WHERE {key_column} = ?",
                    (json.dumps(container), row["id"]),
                )


@migration(58)
def _documents_may_wait_for_their_transaction(conn):
    # A document with no transaction is a *stored* one — an invoice kept before its charge arrives. SQLite
    # cannot drop NOT NULL in place, hence the rebuild. Rowids are carried across because `document_fts`
    # addresses documents by rowid; the index is dropped anyway and rebuilt by init_db's deferred block
    # (with its triggers, which went with the old table), so it can never describe the old table's rows.
    # Guarded like v56: the isolated per-migration tests hand-build minimal schemas and run the whole chain.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "document" not in tables:
        return
    columns = conn.execute("PRAGMA table_info(document)").fetchall()
    if not any(c["name"] == "txn_id" and c["notnull"] for c in columns):
        return  # already rebuilt, or a fresh database created in this shape
    conn.execute("DROP TABLE IF EXISTS document_v58")
    conn.execute(
        """
        CREATE TABLE document_v58 (
            id          TEXT PRIMARY KEY,
            txn_id      TEXT REFERENCES txn(id) ON DELETE CASCADE,
            filename    TEXT NOT NULL,
            mime_type   TEXT NOT NULL,
            byte_size   INTEGER NOT NULL,
            sha256      TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            text        TEXT,
            text_source TEXT
        )
        """
    )
    names = ", ".join(c["name"] for c in columns)
    conn.execute(f"INSERT INTO document_v58 (rowid, {names}) SELECT rowid, {names} FROM document")
    conn.execute("DROP TABLE document")
    conn.execute("DROP TABLE IF EXISTS document_fts")
    conn.execute("ALTER TABLE document_v58 RENAME TO document")


# What a zero posting timestamp converted to before adapters read it as "not posted yet". Never a posted date.
_UNPOSTED_EPOCH_DATE = "1970-01-01"


def _restamped_hash(row: dict, old_date: str, new_date: str):
    """The row's `content_hash` moved to `new_date`, or unchanged when it was not derived from `old_date` by
    the sync formula — a hash of unknown derivation is left alone rather than replaced by a guess."""
    # Lazy: core imports this module.
    from backend.routers.import_export.core import make_hash

    description = row.get("raw_name") or row.get("merchant_name") or ""
    amount = row.get("amount")
    if amount is None or row.get("content_hash") != make_hash(old_date, amount, description):
        return row.get("content_hash")
    return make_hash(new_date, amount, description)


def redate_txn_row_to_transaction_date(row: dict) -> dict:
    """Data half of v59 for one `txn` row, shared with the restore of a backup taken before it.

    Before v59 `date` was the posted date and `authorized_date` the transaction date; since, `date` is the
    transaction date wherever the source gave one and `posted_date` the posted date. A row still carrying
    `authorized_date` is in the old shape, which is the whole test — no version is needed. Only a row a
    provider delivered can name a posted date: a CSV publishes one undifferentiated date, and a pending row
    and a row dated at the epoch have not posted.
    """
    if "authorized_date" not in row:
        return row
    transacted = row.pop("authorized_date")
    old_date = row.get("date")
    from_provider = bool(transacted or row.get("external_transaction_id"))
    posted = (old_date if from_provider and old_date and old_date != _UNPOSTED_EPOCH_DATE
              and not row.get("is_pending") else None)
    row["posted_date"] = posted
    if transacted and transacted != old_date:
        row["content_hash"] = _restamped_hash(row, old_date, transacted)
        row["date"] = transacted
    return row


def redate_held_sync_duplicate(values: dict | None, payload: dict | None) -> tuple[dict | None, dict | None]:
    """The same change for a synced row held in a card's duplicate report, whose `txn_payload` is what
    "Import anyway" inserts and whose `values` is what the report shows. Returns them rewritten."""
    if not isinstance(payload, dict) or "authorized_date" not in payload:
        return values, payload
    transacted = payload.pop("authorized_date")
    old_date = payload.get("date")
    posted = old_date if old_date and old_date != _UNPOSTED_EPOCH_DATE else None
    payload["posted_date"] = posted
    if transacted and transacted != old_date:
        payload["content_hash"] = _restamped_hash(payload, old_date, transacted)
        payload["date"] = transacted
    if isinstance(values, dict):
        values.pop("Transaction date", None)
        values["Date"] = payload.get("date")
        if posted:
            values["Posted date"] = posted
    return values, payload


@migration(59)
def _date_synced_rows_by_transaction(conn):
    # A charge belongs to the day it was made, not the day the bank processed it: that is the day it is
    # looked for on a statement, remembered by, and whose month it counts in. The posted date is kept
    # beside it, and duplicate detection goes on testing both. Guarded like v56 for the isolated
    # per-migration tests' minimal schemas.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "txn" not in tables:
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
    if "authorized_date" not in columns:
        return  # already renamed, or a fresh database created in this shape
    conn.execute("ALTER TABLE txn RENAME COLUMN authorized_date TO posted_date")
    if not {"date", "is_pending", "external_transaction_id", "amount", "raw_name", "merchant_name",
            "content_hash"} <= columns:
        return
    rows = conn.execute(
        """
        SELECT id, date, posted_date AS authorized_date, is_pending, external_transaction_id, amount,
               raw_name, merchant_name, content_hash
        FROM   txn
        WHERE  external_transaction_id IS NOT NULL OR posted_date IS NOT NULL
        """
    ).fetchall()
    for r in rows:
        row = redate_txn_row_to_transaction_date(dict(r))
        conn.execute(
            "UPDATE txn SET date = ?, posted_date = ?, content_hash = ? WHERE id = ?",
            (row["date"], row["posted_date"], row["content_hash"], row["id"]),
        )

    if "import_batch_duplicate" not in tables:
        return
    held = conn.execute(
        """
        SELECT batch_id, row_number, values_json, txn_payload_json
        FROM   import_batch_duplicate
        WHERE  instr(txn_payload_json, '"authorized_date"') > 0
        """
    ).fetchall()
    for r in held:
        try:
            values = json.loads(r["values_json"]) if r["values_json"] else None
            payload = json.loads(r["txn_payload_json"])
        except (TypeError, ValueError):
            continue
        values, payload = redate_held_sync_duplicate(values, payload)
        conn.execute(
            "UPDATE import_batch_duplicate SET values_json = ?, txn_payload_json = ? "
            "WHERE batch_id = ? AND row_number = ?",
            (json.dumps(values) if values is not None else r["values_json"], json.dumps(payload),
             r["batch_id"], r["row_number"]),
        )


# The v60 shape of `connection_sync_log`, written out for the reason `_CONNECTION_SYNC_LOG_V56` is.
_CONNECTION_SYNC_LOG_V60 = """
    CREATE TABLE connection_sync_log_v60 (
        id                   TEXT PRIMARY KEY,
        connection_id        TEXT,
        provider             TEXT,
        institution          TEXT,
        event                TEXT NOT NULL DEFAULT 'sync',
        detail               TEXT,
        started_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        finished_at          TEXT,
        mode                 TEXT,
        days_requested       INTEGER,
        cursor_before        TEXT,
        cursor_after         TEXT,
        pages                INTEGER NOT NULL DEFAULT 0,
        added                INTEGER NOT NULL DEFAULT 0,
        updated              INTEGER NOT NULL DEFAULT 0,
        removed              INTEGER NOT NULL DEFAULT 0,
        skipped              INTEGER NOT NULL DEFAULT 0,
        status_sequence      TEXT,
        final_status         TEXT,
        became_complete      INTEGER NOT NULL DEFAULT 0,
        error                TEXT,
        warnings             TEXT,
        advisories           TEXT,
        skipped_no_account   INTEGER NOT NULL DEFAULT 0,
        skipped_already_held INTEGER NOT NULL DEFAULT 0,
        account_counts       TEXT,
        card_counts          TEXT,
        requested_windows    TEXT,
        request_allowance    TEXT
    )
"""


@migration(60)
def _sync_log_records_every_connection_event(conn):
    # The log now records every data-connection operation rather than only syncs (see
    # services/connection_log.py), and two of them cannot live under the constraint v56 added: a connect that
    # fails has no connection to reference, and a disconnect keeps its own row after the connection it
    # describes is deleted. So `connection_id` becomes nullable without a foreign key, and `event`/`detail`
    # say what a row records. SQLite cannot drop a constraint in place, hence the rebuild; every existing row
    # is a sync, which is the new column's default. Guarded like v56 for the isolated per-migration tests.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "connection_sync_log" not in tables:
        return
    if "event" in {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}:
        return  # already rebuilt, or a fresh database created in this shape
    conn.execute("DROP TABLE IF EXISTS connection_sync_log_v60")
    conn.execute(_CONNECTION_SYNC_LOG_V60)
    current = {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log_v60)")}
    shared = ", ".join(r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")
                       if r["name"] in current)
    conn.execute(f"INSERT INTO connection_sync_log_v60 ({shared}) SELECT {shared} FROM connection_sync_log")
    conn.execute("DROP TABLE connection_sync_log")
    conn.execute("ALTER TABLE connection_sync_log_v60 RENAME TO connection_sync_log")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_connection_sync_log_started ON connection_sync_log(started_at)")


@migration(61)
def _duplicate_rows_carry_their_review_substate(conn):
    # A coverage rejection's advisory sub-state was re-derived every time the duplicate report was read,
    # which left a file card unable to say how many of its rejections still wanted a look without parsing
    # every stored candidate list — tens of thousands of them on a real ledger. It is classified once at
    # import now and stored here, so the card can count it with an indexed query.
    #
    # Backfilled rather than left NULL, because the count needs NULL to mean *settled*: an unclassified
    # row would read as one asking for nothing. The re-derivation is exact — the same pure function the
    # writer uses, over the same stored shape it was written from.
    #
    # Guarded like v56: the isolated per-migration tests hand-build minimal schemas and run the chain.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "import_batch_duplicate" not in tables:
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch_duplicate)")}
    if "review_substate" not in columns:
        conn.execute("ALTER TABLE import_batch_duplicate ADD COLUMN review_substate TEXT")
    # Imported here rather than at module scope: `services.duplicate_detection` imports this module.
    from backend.services.duplicate_detection import coverage_review_substate
    updates = []
    for row in conn.execute(
        "SELECT batch_id, row_number, matched_transaction_json FROM import_batch_duplicate"
    ).fetchall():
        try:
            matched = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
        except (TypeError, ValueError):
            matched = {}
        substate = coverage_review_substate(matched)
        if substate:
            updates.append((substate, row["batch_id"], row["row_number"]))
    if updates:
        conn.executemany(
            "UPDATE import_batch_duplicate SET review_substate = ? WHERE batch_id = ? AND row_number = ?",
            updates,
        )


@migration(62)
def _rows_an_import_refused(conn):
    # See the baseline CREATE for what the table holds and why it is capped. Created here as well
    # because an existing database never re-runs that script for a table it already has — and it has
    # never seen this one. Nothing is backfilled: the rows are gone, and a batch that predates the
    # table falls back to the up-to-twenty its snapshot recorded, which is why there is no data-init
    # half registered for this version.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS import_batch_rejected_row (
            batch_id    TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
            row_number  INTEGER NOT NULL,
            kind        TEXT NOT NULL,
            reason      TEXT NOT NULL,
            values_json TEXT,
            row_date    TEXT,
            description TEXT,
            amount      REAL,
            PRIMARY KEY (batch_id, row_number)
        )
        """
    )


@migration(63)
def _add_watched_import_folders(conn):
    # A data source may name a directory the server reads unattended (routers/import_export/watch.py).
    # Fresh installs get the columns and the table from the baseline script; an existing database has
    # never seen either. Nothing is backfilled and nothing is enabled: a folder is opt-in per source,
    # which is also what makes this migration safe on the installs already in the wild.
    #
    # Guarded on the table existing: the per-migration unit tests hand-build a minimal schema and then run
    # the whole chain, so a migration that assumes the full schema fails there rather than anywhere a real
    # database reaches.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "csv_import_profile" not in tables:
        return
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN watch_dir TEXT")
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN watch_enabled INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN watch_purge_mode TEXT NOT NULL DEFAULT 'never'")
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN watch_purge_days INTEGER NOT NULL DEFAULT 30")

    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN watch_notice TEXT")
    conn.execute("ALTER TABLE csv_import_profile ADD COLUMN watch_last_scan_at TEXT")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS import_watch_file (
            id           TEXT PRIMARY KEY,
            profile_id   TEXT NOT NULL REFERENCES csv_import_profile(id) ON DELETE CASCADE,
            filename     TEXT NOT NULL,
            size         INTEGER NOT NULL,
            mtime        REAL NOT NULL,
            state        TEXT NOT NULL,
            reason       TEXT,
            content_hash TEXT,
            batch_id     TEXT,
            resolved_at  TEXT
        )
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_import_watch_file_name ON import_watch_file(profile_id, filename)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_import_watch_file_state ON import_watch_file(state)")


@migration(64)
def _release_accounts_left_in_the_retired_account_trash(conn):
    # Guarded on the column, for the same reason v63 guards on its table: the per-migration unit tests
    # hand-build a minimal schema and run the whole chain over it.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(account)")}
    if "trashed_at" not in columns:
        return
    _restore_trashed_accounts(conn)


def _restore_trashed_accounts(conn):
    """Make any account hidden in the account trash visible again, now that the trash is gone.

    The account trash was retired once removing an account moved behind the row's overflow menu: it
    could only ever *defer* the move of a child's transactions to its parent, never undo one, and
    deferring left the removal dialog promising a reassignment the ledger went on contradicting (see
    `routers/accounts.py`). With its Settings view and its endpoints gone, a
    row still carrying `trashed_at` would be unreachable forever while its transactions stayed live —
    so the rows come back rather than being cleaned up, and the user removes them deliberately or not
    at all.

    A trashed account is always a merged child (nothing else could be trashed), so clearing the flag
    restores exactly the state it had before: a child under its parent, already carrying the parent's
    display name. The column itself stays — every backup carries it and the read paths still honour it
    — which is also why this is registered for post-restore replay: restoring a backup taken before
    the retirement brings trashed rows back with it.
    """
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(account)")}
    if "trashed_at" not in columns:
        return
    conn.execute("UPDATE account SET trashed_at = NULL WHERE trashed_at IS NOT NULL")


def _table_names(conn) -> set[str]:
    return {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


@migration(65)
def _add_import_batch_coverage(conn):
    # Guarded for the same reason v63/v64 guard: the per-migration unit tests hand-build a minimal
    # schema and run the whole chain over it, so neither the table nor the rows this reads are a given.
    if "import_batch" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if "covers_start" not in columns:
        conn.execute("ALTER TABLE import_batch ADD COLUMN covers_start TEXT")
        conn.execute("ALTER TABLE import_batch ADD COLUMN covers_end TEXT")
        conn.execute("ALTER TABLE import_batch ADD COLUMN covers_source TEXT")
    _backfill_import_batch_coverage(conn)


def _backfill_import_batch_coverage(conn):
    """Derive what every existing card covers, so the history has something to order and group by.

    The reasoning for the field itself is in `services/import_batch_totals.refresh_batch_coverage`.
    Backfilling reads the rows a card still holds, which for a card that has had transactions deleted
    since is narrower than what the file actually contained — unavoidable, since the file is gone, and
    the duplicate report (never deleted) usually carries the span anyway.

    Registered for post-restore replay: restoring a backup taken before this version brings cards across
    with the columns empty, and a history with no coverage falls back to import time for every card.
    """
    if not {"import_batch", "txn", "import_batch_duplicate"} <= _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if not {"covers_start", "config_snapshot"} <= columns:
        return
    from backend.services.import_batch_totals import refresh_batch_coverage

    refresh_batch_coverage(conn, [row["id"] for row in conn.execute("SELECT id FROM import_batch")])


@migration(66)
def _add_import_batch_history_purge(conn):
    # Guarded like v65: the per-migration unit tests hand-build a minimal schema and run the chain.
    if "import_batch" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if "history_purged_at" not in columns:
        conn.execute("ALTER TABLE import_batch ADD COLUMN history_purged_at TEXT")


@migration(67)
def _rename_history_purge_marker(conn):
    """v66's marker hid the card from the history; the action it marks now only clears the card's detail
    records and leaves the card in place, so the old name describes something that no longer happens."""
    if "import_batch" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if "detail_cleared_at" in columns:
        return
    if "history_purged_at" in columns:
        conn.execute("ALTER TABLE import_batch RENAME COLUMN history_purged_at TO detail_cleared_at")
    else:
        conn.execute("ALTER TABLE import_batch ADD COLUMN detail_cleared_at TEXT")


@migration(68)
def _add_import_batch_updated_count(conn):
    """A row that corrected a transaction already held is neither imported nor deduped, and before this
    it was counted as neither — the ledger changed and nothing said so. Guarded like v65/v66: the
    per-migration unit tests hand-build a minimal schema and run the chain."""
    if "import_batch" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if "updated_count" not in columns:
        conn.execute("ALTER TABLE import_batch ADD COLUMN updated_count INTEGER NOT NULL DEFAULT 0")


@migration(69)
def _add_import_batch_ignored_count(conn):
    """Rows a source restated from its own prior import stop being stored as duplicate-report rows, so
    they need a count of their own: `deduped_count` has to go on meaning "rows the report can show".
    Nothing to backfill — reports written before this are still complete, and are the clearing screen's
    to remove. Guarded like v65-v68."""
    if "import_batch" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    if "ignored_count" not in columns:
        conn.execute("ALTER TABLE import_batch ADD COLUMN ignored_count INTEGER NOT NULL DEFAULT 0")


@migration(70)
def _add_txn_source_transaction_id(conn):
    """The identifier a file source gives each row, where its export carries one (see
    services/source_transaction_ids.py). Nothing to backfill: rows already held receive theirs the next
    time an import of the same source matches them. Guarded like v65-v69."""
    if "txn" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
    if "source_transaction_id" not in columns:
        conn.execute("ALTER TABLE txn ADD COLUMN source_transaction_id TEXT")


# Kept as a literal rather than imported from `services.providers.plaid`, which this module must not depend
# on. It must stay equal to that module's PLAID_TRANSACTION_ID_PREFIX.
_PLAID_TRANSACTION_ID_PREFIX = "plaid:"


def _namespace_plaid_transaction_ids(conn):
    """Move Plaid's stored transaction ids under the `plaid:` prefix its adapter now writes.

    `txn.external_transaction_id` is unique ledger-wide and every sync looks it up unscoped, so each
    provider's ids live under a prefix Luma assigns; Plaid's were the one set stored bare, unique only
    because nothing else happened to look like them. Every bare id is taken to be Plaid's — the only other
    provider has namespaced its ids from its first release but for one early build — except on a sync card
    known to be that other provider's, which is what keeps that build's rows from being relabelled.

    The duplicate report's stored payloads are rewritten the same way, so a held copy of a synced row
    names its transaction in the namespace a later sync will look it up under.

    Registered for post-restore replay: a backup taken before this version carries bare Plaid ids, and
    restored as they are, every one would read as new to the next sync and be added a second time."""
    # Guarded like v65-v70: the per-migration unit tests hand-build a minimal schema and run the chain.
    tables = _table_names(conn)
    if "txn" not in tables or "external_transaction_id" not in {
        r["name"] for r in conn.execute("PRAGMA table_info(txn)")
    }:
        return
    prefix = _PLAID_TRANSACTION_ID_PREFIX
    batch_columns = (
        {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")} if "import_batch" in tables else set()
    )
    other_provider = (
        "EXISTS (SELECT 1 FROM import_batch b WHERE b.id = txn.import_batch_id AND b.provider = 'simplefin')"
        if "provider" in batch_columns else "0"
    )
    conn.execute(
        f"""UPDATE txn SET external_transaction_id = ? || external_transaction_id
             WHERE external_transaction_id IS NOT NULL
               AND external_transaction_id NOT LIKE 'plaid:%'
               AND external_transaction_id NOT LIKE 'simplefin:%'
               AND NOT {other_provider}""",
        (prefix,),
    )
    if "import_batch_duplicate" not in tables or "txn_payload_json" not in {
        r["name"] for r in conn.execute("PRAGMA table_info(import_batch_duplicate)")
    }:
        return
    duplicate_other_provider = (
        "EXISTS (SELECT 1 FROM import_batch b WHERE b.id = import_batch_duplicate.batch_id"
        " AND b.provider = 'simplefin')"
        if "provider" in batch_columns else "0"
    )
    conn.execute(
        f"""UPDATE import_batch_duplicate
               SET txn_payload_json = json_set(
                     txn_payload_json, '$.external_transaction_id',
                     ? || json_extract(txn_payload_json, '$.external_transaction_id'))
             WHERE json_valid(txn_payload_json)
               AND json_extract(txn_payload_json, '$.external_transaction_id') IS NOT NULL
               AND json_extract(txn_payload_json, '$.external_transaction_id') NOT LIKE 'plaid:%'
               AND json_extract(txn_payload_json, '$.external_transaction_id') NOT LIKE 'simplefin:%'
               AND NOT {duplicate_other_provider}""",
        (prefix,),
    )


@migration(71)
def _add_plaid_transaction_id_namespace(conn):
    _namespace_plaid_transaction_ids(conn)


def _remove_stored_source_restatements(conn):
    """Take out of every duplicate report the rows an import no longer writes: a source's settled
    restatement of its own prior import (`services/import_detail_storage.remove_batch_restatements`).

    Done here rather than offered on the maintenance screen because there is nothing in such a row to
    keep — the transaction it duplicates is in the ledger and is the record — so asking would only be a
    chance to keep a second copy of it. On a real ledger it was 27,299 of 30,745 report rows. What the
    screen is left offering is the part that does hold something: rows still flagged for review, the
    record an enrichment is undone from, and other sources' claims on the same account.

    Registered for post-restore replay, since a backup taken before this version carries the rows back.
    Runs after v65's coverage backfill in that replay, which reads the report for a card's span."""
    # Guarded like v65-v71: the per-migration unit tests hand-build a minimal schema and run the chain.
    tables = _table_names(conn)
    if not {"import_batch", "import_batch_duplicate"} <= tables:
        return
    batch_columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    duplicate_columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch_duplicate)")}
    if not ({"config_snapshot", "deduped_count", "ignored_count"} <= batch_columns
            and {"review_substate", "enriched_at", "values_json", "matched_transaction_json"} <= duplicate_columns):
        return
    # Imported here rather than at module scope: the service reaches this module through
    # `services.duplicate_detection`.
    from backend.services.import_detail_storage import remove_batch_restatements

    batch_ids = [row["id"] for row in conn.execute(
        "SELECT DISTINCT batch_id AS id FROM import_batch_duplicate"
    )]
    done = remove_batch_restatements(conn, batch_ids)
    if done["rows"]:
        log_info(
            f"[db] removed {done['rows']} restated rows from {done['cards']} duplicate reports", keep_in_file=True,
        )


@migration(72)
def _drop_stored_source_restatements(conn):
    _remove_stored_source_restatements(conn)


@migration(73)
def _add_signal_dismissal_one_off(conn):
    """`recurring_signal_dismissal.one_off` — an Amount changed finding dismissed as "fine this time"
    (see services/recurring_signals._load_one_off_charges). Every existing dismissal was an ordinary
    one, which the 0 default states. Guarded like v65-v72."""
    if "recurring_signal_dismissal" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(recurring_signal_dismissal)")}
    if "one_off" not in columns:
        conn.execute("ALTER TABLE recurring_signal_dismissal ADD COLUMN one_off INTEGER NOT NULL DEFAULT 0")


@migration(74)
def _add_owner_review_flagging(conn):
    """`owner.flag_new_for_review` — whether an owner's transactions arrive flagged for review
    (services/review_flagging.py). Every owner starts flagging, which the 1 default states. The
    ledger-wide switch this replaces is dropped without being carried over: a ledger that had it off
    sets its owners by hand. Guarded like v65-v73."""
    tables = _table_names(conn)
    if "owner" in tables:
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(owner)")}
        if "flag_new_for_review" not in columns:
            conn.execute("ALTER TABLE owner ADD COLUMN flag_new_for_review INTEGER NOT NULL DEFAULT 1")
    if "ui_preference" in tables:
        conn.execute(
            "DELETE FROM ui_preference WHERE scope_id = '__ledger__' AND pref_key = 'transactions.flag_new_for_review'"
        )


def _release_missing_rule_suggestion_rows(conn):
    """Take from every stored rule-suggestion review the ids of transactions that no longer exist, removing
    the entries left with none. Deletions now do this as they happen
    (`services/rule_suggestion_review.py`); reviews written before that still name rows an undone import, an
    emptied trash or a removed account took away. Replayed after a restore, since an older backup carries
    the same entries. Guarded like v65-v74."""
    tables = _table_names(conn)
    if not {"txn", "import_batch", "csv_import_profile", "import_workflow_state"} <= tables:
        return
    # Imported here rather than at module scope, like v72's service.
    from backend.services.rule_suggestion_review import release_missing_rule_suggestion_rows

    changed = release_missing_rule_suggestion_rows(conn)
    if changed:
        log_info(f"[db] removed deleted transactions from {changed} rule-suggestion reviews", keep_in_file=True)


def _normalize_leaf_category_type(conn):
    """Give every leaf category its group's `category_type`.

    **A leaf's type is its group's**, which is what keeps a group's total equal to the sum of its own
    slices: selection and signing read `COALESCE(leaf, parent)` at the category level and
    `COALESCE(parent, leaf)` at the group level, so a leaf carrying the other side's type is selected by
    one rule and signed by the other. Nothing on a single screen looks wrong when that happens, which is
    why it is worth asserting rather than trusting.

    Every category write path already enforces it (`routers/categories.py` — a create takes the parent's
    type, a move rewrites it, a group retype carries its children). A **restore** does not: it inserts the
    payload verbatim, so a backup predating those rules, or one edited by hand, brings a mismatched leaf
    back. Registered in `POST_RESTORE_DATA_INIT` for exactly that, and run as a migration too so a
    database that has already drifted is repaired rather than waiting for a restore that may never come.

    Inactive leaves included, for the same reason a group retype carries them: a recovered category comes
    back on the side its group is on. A leaf whose `parent_id` is NULL is not a leaf and is left alone.
    """
    if "category" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(category)")}
    if not {"parent_id", "category_type"} <= columns:
        return
    changed = conn.execute(
        """
        UPDATE category
        SET    category_type = (
                   SELECT p.category_type FROM category p WHERE p.id = category.parent_id
               )
        WHERE  parent_id IS NOT NULL
          AND  category_type IS NOT (
                   SELECT p.category_type FROM category p WHERE p.id = category.parent_id
               )
        """
    ).rowcount
    if changed:
        log_info(f"[db] aligned {changed} categories with their group's type", keep_in_file=True)


@migration(75)
def _drop_deleted_rule_suggestion_rows(conn):
    _release_missing_rule_suggestion_rows(conn)


@migration(76)
def _add_amazon_pending_item_consumed_batch(conn):
    """`amazon_pending_item.consumed_batch_id` — the orders import that attached a parked item, so undoing
    that import returns the item to waiting instead of losing it. Nothing to backfill: an item attached
    before this column was deleted on attachment and cannot be recovered here. Guarded like v65-v74."""
    if "amazon_pending_item" not in _table_names(conn):
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(amazon_pending_item)")}
    if "consumed_batch_id" not in columns:
        conn.execute("ALTER TABLE amazon_pending_item ADD COLUMN consumed_batch_id TEXT")


@migration(77)
def _align_leaf_category_type(conn):
    _normalize_leaf_category_type(conn)


@migration(78)
def _record_owed_recurring_rescans(conn):
    # See the baseline CREATE. Empty on an existing database: nothing is owed until a write records it.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS recurring_rescan_owed (
            payee_key  TEXT PRIMARY KEY,
            generation INTEGER NOT NULL,
            owed_at    TEXT NOT NULL
        )
    """)


@migration(79)
def _add_recurring_series_rule_fingerprint(conn):
    # See the baseline CREATE. Nothing to backfill: NULL differs from every rule, so the next scan that
    # reaches a rule-backed series reconciles it and records the value.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(recurring_series)").fetchall()}
    if cols and "rule_fingerprint" not in cols:
        conn.execute("ALTER TABLE recurring_series ADD COLUMN rule_fingerprint TEXT")


def _backfill_amazon_batch_account(conn):
    # The Amazon account a card imported into is now recorded on the card (`config_snapshot
    # .amazon_account_id`), because the import history groups a vendor's cards by account and a card
    # need not have rows to derive one from. Older cards are backfilled from the rows they created:
    # every order in a drop lands in the one chosen account, so a card's transactions name it exactly.
    # A card with no rows — an items-only card holding parked detail, every row discarded — has nothing
    # to read, and is left unattributed rather than guessed at.
    #
    # Guarded on the tables and the columns, not just the tables: the isolated per-migration tests
    # hand-build minimal schemas holding only what the migration under test reads, and run the whole
    # chain over them.
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if not {"import_batch", "txn"} <= tables:
        return
    batch_columns = {r["name"] for r in conn.execute("PRAGMA table_info(import_batch)")}
    txn_columns = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
    if not {"config_snapshot", "source_kind"} <= batch_columns or not {"account_id", "import_batch_id"} <= txn_columns:
        return
    rows = conn.execute(
        """
        SELECT b.id, b.config_snapshot,
               (SELECT t.account_id FROM txn t
                WHERE  t.import_batch_id = b.id AND t.account_id IS NOT NULL
                LIMIT  1) AS account_id
        FROM   import_batch b
        WHERE  b.source_kind = 'marketplace:amazon'
        """
    ).fetchall()
    for row in rows:
        if not row["account_id"]:
            continue
        try:
            snapshot = json.loads(row["config_snapshot"]) if row["config_snapshot"] else {}
        except (TypeError, ValueError):
            snapshot = {}
        if not isinstance(snapshot, dict) or snapshot.get("amazon_account_id"):
            continue
        snapshot["amazon_account_id"] = row["account_id"]
        conn.execute(
            "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
            (json.dumps(snapshot), row["id"]),
        )


@migration(80)
def _record_amazon_batch_account(conn):
    _backfill_amazon_batch_account(conn)


@migration(81)
def _add_rule_conflict(conn):
    # See the baseline CREATE. Empty on an existing database: a pair is recorded by the next pass that
    # applies the rules to a transaction showing it.
    #
    # Skipped when either table it references is absent, which happens only on the partial schemas the
    # older migration tests build (see v46): there, a foreign key to a missing table makes every delete
    # from `txn` fail. On any real database both are always present.
    tables = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('txn', 'category_rule')")}
    if len(tables) < 2:
        return
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rule_conflict (
            rule_id_low  TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
            rule_id_high TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
            txn_id       TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
            PRIMARY KEY (rule_id_low, rule_id_high)
        )
    """)


@migration(82)
def _add_backup_history(conn):
    # See the baseline CREATE. Empty on an existing database: no backup made before it was recorded.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS backup_history (
            id                   TEXT PRIMARY KEY,
            made_at              TEXT NOT NULL,
            made_by              TEXT,
            filename             TEXT,
            encrypted            INTEGER,
            key_labels           TEXT,
            credentials_included INTEGER,
            credentials_left_out TEXT,
            total_bytes          INTEGER,
            ledger_bytes         INTEGER,
            accounts_bytes       INTEGER,
            documents_bytes      INTEGER,
            document_count       INTEGER,
            restored_at          TEXT
        )
    """)


@migration(83)
def _add_backup_history_trash(conn):
    # See the baseline CREATE. NULL, the history as it was, on every existing row.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(backup_history)")}
    if "deleted_at" not in columns:
        conn.execute("ALTER TABLE backup_history ADD COLUMN deleted_at TEXT")


@migration(84)
def _drop_merchant_rename(conn):
    # Pattern → clean-name renames were never wired up: nothing could write a row or read one, so the table
    # is empty everywhere, and a category rule's `clean_name` is what renames a merchant. Its index goes
    # with it.
    conn.execute("DROP TABLE IF EXISTS merchant_rename")


@migration(85)
def _add_rule_priority_level(conn):
    # See the baseline CREATE. Every existing rule is normal priority, which is the order it already had.
    # An empty column set is the partial schema of an older migration test (see v81), with no rule table.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(category_rule)")}
    if columns and "priority_level" not in columns:
        conn.execute("ALTER TABLE category_rule ADD COLUMN priority_level INTEGER NOT NULL DEFAULT 0")


@migration(86)
def _add_profile_decimal_separator(conn):
    # See the baseline CREATE. Every existing source was read point-decimal, so that is what each states.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(csv_import_profile)")}
    if columns and "decimal_separator" not in columns:
        conn.execute("ALTER TABLE csv_import_profile ADD COLUMN decimal_separator TEXT NOT NULL DEFAULT 'point'")


@migration(87)
def _add_backup_history_database_check(conn):
    # See the baseline CREATE. NULL on every existing row: no backup made before it was checked.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(backup_history)")}
    if columns and "database_check" not in columns:
        conn.execute("ALTER TABLE backup_history ADD COLUMN database_check TEXT "
                     "CHECK (database_check IN ('passed', 'failed'))")


# The saved dashboard tag reports, and briefly the saved filters, were once one list shared by every user,
# kept in `import_workflow_state`. Each is now a per-user preference: (state key, list field, preference key).
_SHARED_VIEW_LISTS = (
    ("system_dashboard_tag_reports", "reports", "ui.dashboard.tagReports"),
    ("system_saved_filters", "filters", "ui.filterBar.savedFilters"),
)


def _copy_shared_views_to_users(conn):
    """Give every user of this ledger their own copy of each shared list, then drop the shared one.

    The users are the preference scopes already present, the reserved ledger scope aside: the data database
    does not hold the user list, and anyone who has opened the app has written preferences. A user who
    already has the per-user list keeps it. Registered in `POST_RESTORE_DATA_INIT`, so a restored backup
    older than this has its shared lists handed out to the users it carries."""
    from backend.services.preferences import SHARED_SCOPE_ID

    tables = _table_names(conn)
    if "import_workflow_state" not in tables or "ui_preference" not in tables:
        return
    scopes = [row["scope_id"] for row in conn.execute(
        "SELECT DISTINCT scope_id FROM ui_preference WHERE scope_id != ?", (SHARED_SCOPE_ID,),
    )]
    for state_key, field, pref_key in _SHARED_VIEW_LISTS:
        row = conn.execute("SELECT payload_json FROM import_workflow_state WHERE key = ?", (state_key,)).fetchone()
        if row is None:
            continue
        try:
            items = json.loads(row["payload_json"]).get(field)
        except (TypeError, ValueError, AttributeError):
            items = None
        if isinstance(items, list) and items:
            value = json.dumps(items)
            conn.executemany(
                """
                INSERT INTO ui_preference (scope_id, pref_key, pref_value, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(scope_id, pref_key) DO NOTHING
                """,
                [(scope, pref_key, value) for scope in scopes],
            )
        conn.execute("DELETE FROM import_workflow_state WHERE key = ?", (state_key,))


@migration(88)
def _move_shared_views_to_users(conn):
    _copy_shared_views_to_users(conn)


@migration(89)
def _add_connection_request_budget_at(conn):
    # See the baseline CREATE. NULL on every existing row: the next sync of each connection stamps it.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
    if columns and "provider_request_budget_at" not in columns:
        conn.execute("ALTER TABLE connection ADD COLUMN provider_request_budget_at TEXT")


def _backfill_amazon_charge_text(conn):
    """Copy each linked charge's text onto its Amazon order (`services/amazon_order_charges.py`), so a
    `match_source_text` rule written for the charge reaches orders linked before the copy existed. Changes
    no category: the user runs the rules when they choose. Registered in `POST_RESTORE_DATA_INIT`, so a
    restored backup older than this gets the same text. A missing link table is the partial schema of an
    older migration test."""
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'txn_link'").fetchone():
        return
    from backend.services.amazon_order_charges import backfill_charge_text
    backfill_charge_text(conn)


@migration(90)
def _copy_amazon_charge_text(conn):
    _backfill_amazon_charge_text(conn)


@migration(91)
def _add_rule_alerts(conn):
    # See the baseline CREATE. Every existing rule raises no alert, and no transaction has been caught by
    # one. Skipped on the partial schemas of the older migration tests, as v81 is.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(category_rule)")}
    if not columns or not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'txn'").fetchone():
        return
    for name, ddl in (("alert", "INTEGER NOT NULL DEFAULT 0"), ("alert_message", "TEXT")):
        if name not in columns:
            conn.execute(f"ALTER TABLE category_rule ADD COLUMN {name} {ddl}")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rule_alert_hit (
            rule_id TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
            txn_id  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
            PRIMARY KEY (rule_id, txn_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_alert_hit_txn ON rule_alert_hit(txn_id)")


def get_db_version(conn) -> int:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS db_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    row = conn.execute("SELECT value FROM db_meta WHERE key = 'version'").fetchone()
    return int(row["value"]) if row else 0


def set_db_version(conn, version: int):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS db_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.execute(
        "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('version', ?)",
        (str(version),)
    )


# The *data-initialization* half of each migration that transforms data (as opposed to migrations that only
# add columns/tables with sensible defaults), keyed by migration version. A migration runs its own entry
# after its schema change; a restore runs the entries newer than the backup (see run_post_restore_data_init).
# Order matters — later steps may depend on earlier ones' output (e.g. v15's date seed reads the rename
# provenance v6 sets) — so callers iterate in ascending version order.
POST_RESTORE_DATA_INIT = {
    6:  _backfill_display_name_source,
    13: _backfill_account_types_and_money_movement,
    15: _seed_rule_cleanup_data,
    24: _backfill_connection_account_mapping,
    25: _widen_unset_csv_terminal_window,
    54: _unlock_trusted_import_categories,
    55: _backfill_import_batch_provider,
    64: _restore_trashed_accounts,
    65: _backfill_import_batch_coverage,
    71: _namespace_plaid_transaction_ids,
    72: _remove_stored_source_restatements,
    75: _release_missing_rule_suggestion_rows,
    77: _normalize_leaf_category_type,
    80: _backfill_amazon_batch_account,
    88: _copy_shared_views_to_users,
    90: _backfill_amazon_charge_text,
}


def run_post_restore_data_init(conn, backup_schema_version) -> None:
    """After a backup is restored into the current schema, run the data-init half of every migration newer
    than the backup, in ascending order — so derived fields the backup predates (rename provenance,
    account types + money-movement consolidation, last_effect_date + is_managed) get computed against the
    restored data. The schema DDL is skipped: the target is already at CURRENT_VERSION, so those ALTERs
    would be no-ops; only the data transforms are missing.

    A backup with no/unknown `schema_version` — including pre-rebrand backups, per the design decision to
    treat those as Luma v1 — runs *all* registered (post-rebrand) steps. A backup newer than us runs none
    (empty range). Each step is written to be safe to run once on data that predates it, which is exactly
    when it runs here."""
    effective = backup_schema_version if isinstance(backup_schema_version, int) and backup_schema_version >= 1 else 1
    for version in sorted(POST_RESTORE_DATA_INIT):
        if version > effective:
            POST_RESTORE_DATA_INIT[version](conn)


def run_migrations(conn):
    # Advance an existing database to `CURRENT_VERSION` by applying each registered migration newer than
    # its recorded version, in order, stamping the version as it goes. Fresh installs never reach here —
    # they are created at the current schema and stamped directly (see init_db). The chain was reset at
    # the Luma rebrand (baseline 1); post-rebrand migrations register from v2 upward.
    current = get_db_version(conn)
    if current >= CURRENT_VERSION:
        log_info(f"[db] database is at version {current}")
        return
    for version in sorted(MIGRATIONS):
        if version > current:
            log_info(f"[db] applying migration v{version}...", keep_in_file=True)
            MIGRATIONS[version](conn)
            set_db_version(conn, version)
    log_info(f"[db] database is now at version {CURRENT_VERSION}", keep_in_file=True)


def get_db_instance_id(conn) -> str:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS db_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    row = conn.execute("SELECT value FROM db_meta WHERE key = 'instance_id'").fetchone()
    if row and row["value"]:
        return row["value"]
    return new_db_instance_id(conn)


def new_db_instance_id(conn) -> str:
    """Give the database a fresh `instance_id`, the identifier its backups carry. A restore calls this, so
    a backup made before it reads as another system's (`data-model.md` → *Backups*)."""
    instance_id = str(uuid.uuid4())
    conn.execute(
        "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('instance_id', ?)",
        (instance_id,),
    )
    return instance_id


# Which workspace this financial database belongs to: the id of the control database's one `tenant` row,
# written into both files so a startup can tell whether the two it was configured with belong together
# (`control_database.pairing_problem`). Unlike `instance_id` it never changes, a restore included, and it
# is never carried in a backup: `db_meta` is not exported and a restore does not wipe it.
WORKSPACE_ID_KEY = "workspace_id"


def get_workspace_id(conn) -> str | None:
    """The workspace this database belongs to, or None when it has not been given one. Writes nothing, so
    it is safe on a database that may belong to another installation."""
    has_meta = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'"
    ).fetchone()
    if not has_meta:
        return None
    row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (WORKSPACE_ID_KEY,)).fetchone()
    return row[0] if row and row[0] else None


def set_workspace_id(conn, workspace_id: str) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS db_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.execute(
        "INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)", (WORKSPACE_ID_KEY, workspace_id),
    )


def get_tenant_workflow_state(conn, key: str) -> dict:
    """Read a shared (tenant-wide, not per-user) state blob from `import_workflow_state`. This is the
    one place app-wide *data state* lives that is neither a transaction-graph row nor a per-user
    preference — e.g. the demo marker and the category-workspace draft. Returns {} when absent or
    un-parseable."""
    row = conn.execute(
        "SELECT payload_json FROM import_workflow_state WHERE key = ?", (key,)
    ).fetchone()
    if not row:
        return {}
    try:
        value = json.loads(row["payload_json"])
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def set_tenant_workflow_state(conn, key: str, payload: dict) -> None:
    conn.execute(
        """
        INSERT INTO import_workflow_state (key, payload_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json
        """,
        (key, json.dumps(payload or {})),
    )


def _alphabetize_top_level_category_groups(conn: sqlite3.Connection):
    for category_type in ("income", "expense"):
        rows = conn.execute(
            """
            SELECT id
            FROM category
            WHERE parent_id IS NULL
              AND COALESCE(category_type, 'expense') = ?
            ORDER BY LOWER(name), name, id
            """,
            (category_type,),
        ).fetchall()
        for index, row in enumerate(rows):
            conn.execute(
                "UPDATE category SET sort_order = ? WHERE id = ?",
                (index, row["id"]),
            )


def init_db(db_path: str | None = None):
    resolved_path = _normalize_db_path(db_path)
    migrated_from = None
    with get_db(resolved_path) as conn:
        existing_tables = {
            row["name"]
            for row in conn.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name NOT LIKE 'sqlite_%'
                """
            ).fetchall()
        }
        is_fresh_db = len(existing_tables) == 0

        conn.executescript("""
            -- Provider-agnostic data-source connections (Plaid, SimpleFIN, and any adapter after). One row per
            -- linked connection, carrying a `provider` discriminator and the opaque per-connection
            -- credential vault-encrypted under the workspace DEK (`credential_enc`; the plaintext column is
            -- always ''). `external_id` is the provider's stable handle (Plaid's item_id); accounts link
            -- back via account.connection_id (see the account table). The credential store — superseded the
            -- old `plaid_item` table, dropped in migration v20.
            CREATE TABLE IF NOT EXISTS connection (
                id             TEXT PRIMARY KEY,
                provider       TEXT NOT NULL,
                external_id    TEXT,
                credential     TEXT NOT NULL DEFAULT '',
                credential_enc TEXT,
                institution    TEXT,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                -- Cursor for the provider's incremental transaction API (Plaid /transactions/sync). NULL
                -- until the first cursor-based sync; advanced each page. Lets routine syncs pull only deltas.
                transactions_cursor TEXT,
                -- 1 once the provider reports the historical backfill is complete (HISTORICAL_UPDATE_COMPLETE).
                -- Rows synced while 0 land on the connection's single "initial import" card; after 1, on the
                -- normal monthly period cards. See routers/sync.py.
                initial_sync_complete INTEGER NOT NULL DEFAULT 0,
                -- JSON list of optional per-transaction capture-field keys the user turned on for this
                -- connection (see ProviderAdapter.capture_fields). NULL = the adapter's defaults. Locked
                -- fields are always captured and never appear here.
                captured_fields TEXT,
                -- Sync health, so the Connections card can report it without being expanded. These four
                -- describe DIFFERENT things and are deliberately not collapsed into one:
                --   last_synced_at            the last *successful* pull — the freshness of the data, not
                --                             the time of the last attempt, so a failing connection reads
                --                             as stale rather than as recently synced.
                --   last_sync_error(_at)      the most recent failure; cleared by any success.
                --   consecutive_sync_failures how many in a row — what separates a transient blip from a
                --                             connection that has stopped working. Reset (not decremented)
                --                             on success: one good pull settles the question.
                --   last_sync_warnings        JSON list of problems reported by a pull that otherwise
                --                             SUCCEEDED (one bank on a multi-bank credential needing
                --                             re-auth). Replaced each pull, so a fixed bank stops being
                --                             reported without anyone dismissing anything.
                last_synced_at            TEXT,
                last_sync_error           TEXT,
                last_sync_error_at        TEXT,
                consecutive_sync_failures INTEGER NOT NULL DEFAULT 0,
                last_sync_warnings        TEXT,
                -- 1 when the provider has stopped accepting the stored credential and the user must
                -- connect again. Deliberately NOT derived from consecutive_sync_failures: that counts how
                -- long something has been wrong, while this says retrying cannot fix it, and a card should
                -- lead with the second. Sticky until a pull succeeds, so the network errors that follow a
                -- revocation don't bury it. For a provider with no revocation API (SimpleFIN) the user
                -- revokes at the provider's own site, and the refusal recorded here is the ONLY notice
                -- this app ever gets that they did.
                reauth_required           INTEGER NOT NULL DEFAULT 0,
                -- When a sync of this connection started, or NULL when none is running. Written and
                -- cleared **outside** the pull's own transaction (see `_set_sync_running`), because a
                -- marker announcing a sync is worthless if it only becomes visible once that sync has
                -- finished. It exists so the in-progress state outlives the page that started it: the poll
                -- loop lives in component state, so navigating away used to re-enable "Sync now" and invite
                -- a second concurrent pull. Believed only for `_SYNC_MARKER_STALE_AFTER`, so a process that
                -- dies mid-sync cannot leave a connection looking permanently busy.
                sync_started_at           TEXT,
                -- What this connection has already spent against a metered provider's published request
                -- limits, in whatever shape that provider's adapter needs (SimpleFIN keeps refilling token
                -- buckets here; see its module docstring). Opaque to everything but the adapter.
                --
                -- Deliberately NOT part of transactions_cursor, though both are adapter-owned state, because
                -- the two have opposite persistence rules. A cursor is a claim about data held, so it must
                -- roll back with the rows a failed pull never inserted; spending must never roll back, since
                -- the requests were made whatever became of the pull. Sharing one column would force a
                -- single rule on both, and each one's correct rule is the other's bug — a budget that
                -- forgets a failed pull's requests overruns the limit precisely when a user is retrying a
                -- broken connection hardest, and the penalty for overrunning is a disabled token.
                provider_request_budget   TEXT,
                -- Live progress of the sync currently running, as JSON, or NULL when none is. Written at
                -- every page commit and cleared when the run ends, so it is readable by any request while
                -- a pull is still in flight — which is the whole point: a long backfill is one HTTP call,
                -- so its own response says nothing until it is over, and a client that navigated away or
                -- reloaded has nothing to reconnect to. Paired with `sync_started_at`, which says a run
                -- exists; this says how far it has got.
                sync_progress             TEXT,
                -- What the most recent sync of this connection DID, as the connection card reports it:
                -- one outcome word ('ok'/'attention'/'incomplete'/'failed', see `sync_outcome` in
                -- services/providers/config.py) plus a JSON summary of its counts and the per-account
                -- breakdown the card's chips render.
                --
                -- Here rather than derived from `connection_sync_log` on read, because that table is a
                -- diagnostic ring buffer: capped, pruned on every write, and emptied outright by
                -- `DELETE /sync/diagnostics`. A card reading it lost its whole "Last sync" block — on a
                -- perfectly healthy connection — the moment anyone cleared a debugging view. This is the
                -- durable record; the log keeps the diagnostic detail (cursor fingerprints, request
                -- windows, allowance, status sequence) that no card renders. Both are written from the
                -- same assembled facts in one call, so they cannot describe one pull two ways.
                --
                -- NULL means "never synced", which the card reads as "no record yet" rather than as a
                -- zero-count success. Distinct from `last_sync_error`, which says the connection is broken
                -- *right now* and outranks the stored word when the card renders.
                last_sync_outcome         TEXT,
                last_sync_summary         TEXT,
                -- When `provider_request_budget` was last written. The budget belongs to the credential,
                -- not to the machine, so after a restore the copy that matters is whichever was written
                -- last, here or on the system the backup came from; its contents are the adapter's, so
                -- this is what the restore compares. NULL means unknown and loses to any stamped copy.
                provider_request_budget_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_provider_external
                ON connection(provider, external_id);

            -- One row per account a connection offers — the connection's *data source* record, and the
            -- durable answer to "what does this provider account map to locally?". It is the direct analog
            -- of a CSV import's account-mapping step: a provider account may be mapped onto an existing
            -- account, created as a new one, grouped under an existing one, or skipped entirely.
            -- Without this the mapping was implicit (one new account per provider
            -- account, no way to revisit) and duplicate detection had no alias to work from.
            --
            -- Two things only this table can hold: a provider account the user chose to SKIP (no local
            -- account row exists to carry that decision, so a refresh would recreate it forever), and the
            -- provider-reported name/mask/type, kept separately so the mapping UI can still show what the
            -- *bank* calls an account after it has been mapped onto a locally-renamed one.
            --
            -- Coverage lives here rather than on a sync's import_batch card because a cursor delta is not a
            -- date range — it is "everything new since a checkpoint", scattered across arbitrary dates. The
            -- *sync chain* is what carries a coverage claim: a range pull establishes coverage_start_date,
            -- each successful delta advances coverage_through_date, a failed sync simply leaves it unmoved,
            -- and a cursor reset clears both. See docs/data-model.md.
            CREATE TABLE IF NOT EXISTS connection_account (
                connection_id       TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
                external_account_id TEXT NOT NULL,
                -- The local account this provider account feeds. NULL while unmapped, and for 'skip'.
                account_id          TEXT REFERENCES account(id) ON DELETE SET NULL,
                -- NULL = not yet mapped (the UI badges these); otherwise
                -- 'new' | 'existing' | 'group' | 'skip'.
                mapping_mode        TEXT,
                -- The existing account this decision points at, per mode: the account adopted
                -- ('existing') or the parent to nest under ('group'). NULL for 'new' and 'skip'.
                -- Kept on the mapping row rather than
                -- inferred from the resulting account so the decision survives the account being rebuilt
                -- (a restore wipes accounts but not connections), and so re-applying a mapping restores
                -- the same relationship. Only 'existing' feeds the dedupe ladder's explicit-alias
                -- precondition — 'group' is a *different* physical account and must not.
                target_account_id   TEXT REFERENCES account(id) ON DELETE SET NULL,
                provider_name          TEXT,
                provider_official_name TEXT,
                provider_type          TEXT,
                provider_subtype       TEXT,
                provider_mask          TEXT,
                -- The account's denomination as the provider states it, NULL when it states none. The
                -- ledger holds one currency at a time (a user setting; services/ledger_currency.py) and `txn.amount`
                -- carries no denomination beside it, so an account in another currency has its transactions
                -- DISCARDED rather than imported at face value — otherwise its amounts would silently join
                -- every total. Recorded at connect/refresh time, before any mapping decision, so the
                -- mapping UI can warn instead of letting the user create an account that can never fill.
                -- NULL means "not stated", never "not the ledger's": the field is optional in the
                -- protocols, and rejecting an account over a missing field would discard real data.
                provider_currency      TEXT,
                coverage_start_date    TEXT,
                coverage_through_date  TEXT,
                -- How many trailing days of the covered range are treated as SOFT (reconciled one-to-one
                -- rather than blanket-rejected). An aggregator lags the bank by several days, so its most
                -- recent days are incomplete; 7 covers the observed posting lag. See duplicate_detection.
                terminal_window_days   INTEGER NOT NULL DEFAULT 7,
                -- History-fetch state, per account, because that is the level the facts are true at. A
                -- connection's accounts do not advance together: one added on the provider's side later
                -- starts with no history while its siblings are years deep.
                --   history_complete      this account has no OLDER data — a different claim from
                --                         coverage_start_date, which says only how far back we fetched and
                --                         cannot tell "history ran out" from "we stopped where asked" or
                --                         "we ran out of request budget". Only the first may stop a later,
                --                         deeper request from looking again.
                --   history_empty_streak  consecutive empty windows for THIS account, the per-account form
                --                         of the two-empty-windows stop (one empty window is a quiet
                --                         quarter; two is the end of history). Persisted so a walk that
                --                         pauses resumes counting rather than starting the streak over.
                history_complete       INTEGER NOT NULL DEFAULT 0,
                history_empty_streak   INTEGER NOT NULL DEFAULT 0,
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT,
                PRIMARY KEY (connection_id, external_account_id)
            );
            CREATE INDEX IF NOT EXISTS idx_connection_account_account
                ON connection_account(account_id);

            -- Diagnostic log of provider sync calls (one row per connection per /sync call), captured only
            -- when developer options are enabled. Provider-agnostic by construction: it records the neutral
            -- fields every adapter speaks (see services/providers/base.py), so it serves Plaid today and any
            -- future aggregator unchanged. Its purpose is to explain *why* a sync fetched what it did —
            -- chiefly the historical-backfill readiness: `status_sequence` is the JSON list of the adapter's
            -- update_status signal (Plaid's transactions_update_status today) seen across the drained pages,
            -- and `became_complete` records the call that flipped the connection out of its initial pull.
            -- Cursors are stored only as a short fingerprint (length + prefix), never the full opaque token.
            -- Despite the name it is the log of every data-connection operation, not only syncs: `event`
            -- says which, and a non-sync row fills only the columns that describe it plus `detail`. See
            -- services/connection_log.py. connection_id is NULL only for a connect that failed before the
            -- provider issued a connection, and carries no foreign key: a disconnect deletes the
            -- connection's other rows and keeps its own, under the id of a connection that is gone (see
            -- migration v60). provider/institution are a snapshot that labels a row without a join.
            CREATE TABLE IF NOT EXISTS connection_sync_log (
                id              TEXT PRIMARY KEY,
                connection_id   TEXT,
                provider        TEXT,
                institution     TEXT,
                -- 'sync' | 'connect' | 'reconnect' | 'refresh_accounts' | 'disconnect' | 'reissue' | 'revoke'
                event           TEXT NOT NULL DEFAULT 'sync',
                -- JSON object of the event's own facts for a non-sync row (accounts offered, whether a
                -- disconnect revoked at the provider); NULL for a sync, whose facts have columns.
                detail          TEXT,
                started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                finished_at     TEXT,
                mode            TEXT,     -- 'initial' (historical backfill) | 'routine' (cursor deltas)
                days_requested  INTEGER,
                cursor_before   TEXT,
                cursor_after    TEXT,
                pages           INTEGER NOT NULL DEFAULT 0,
                added           INTEGER NOT NULL DEFAULT 0,
                updated         INTEGER NOT NULL DEFAULT 0,
                removed         INTEGER NOT NULL DEFAULT 0,
                skipped         INTEGER NOT NULL DEFAULT 0,
                status_sequence TEXT,     -- JSON array of transactions_update_status, one per drained page
                final_status    TEXT,
                became_complete INTEGER NOT NULL DEFAULT 0,
                error           TEXT,
                -- Non-fatal messages from this call, both JSON arrays. `warnings` are the user-actionable
                -- ones (a bank needing re-auth) and mirror what the connection card shows; `advisories`
                -- are [{message, count}] for things nobody can act on — what the provider said about our
                -- own request, and the sync's own "nothing importable because…" notices. The card
                -- deliberately shows only the former; the log keeps both, per call.
                warnings        TEXT,
                advisories      TEXT,
                -- The half of `skipped` that means data was lost (no local account to put a row in) kept
                -- apart from the half that is routine (a row already held — the incremental overlap
                -- re-asks for days on purpose). One number could not be shown anywhere without crying
                -- wolf on every sync; `already_held` on an *initial* pull is separately a contradiction.
                skipped_no_account   INTEGER NOT NULL DEFAULT 0,
                skipped_already_held INTEGER NOT NULL DEFAULT 0,
                -- {provider account id: {added, updated, skipped_*}} for this call. Keyed by the provider's
                -- id, not the local account's, so an account with no local destination still appears —
                -- a breakdown built from what landed can never mention the account that received nothing.
                account_counts  TEXT,
                -- [{card, added}] — which import cards this pull's rows landed on. A sync files each row
                -- under its own transaction month, so one call routinely writes to several cards while
                -- `added` reports a single total; without this the total reconciles against nothing the
                -- Import/Export page shows, and reads as rows having disappeared.
                card_counts     TEXT,
                -- [{start, end}] — the date ranges actually requested, in order. A walking, budgeted
                -- adapter makes many requests per call and can stop partway, so neither the rows returned
                -- nor the resume checkpoint can reconstruct what was looked at. Empty for a cursor
                -- provider, which asks for "everything since this token" and names no window.
                requested_windows TEXT,
                -- Vestigial: the metered allowance a pull left behind, written by older builds. What is
                -- left is now reported on the connection listing, read from
                -- `connection.provider_request_budget`; the log records what a call spent.
                request_allowance TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_connection_sync_log_started
                ON connection_sync_log(started_at);

            -- App-level provider credentials (one row per provider): the app secret that identifies the
            -- Luma app to the aggregator (Plaid's client_id + secret), moved out of `.env` into the DB.
            -- Only `secret` is sensitive — it is vault-encrypted
            -- under the workspace DEK (`secret_enc`; the plaintext column is always ''); `client_id`/`env`
            -- are semi-public and stored plaintext. Distinct from `connection` (the per-bank credential).
            CREATE TABLE IF NOT EXISTS provider_config (
                provider   TEXT PRIMARY KEY,
                client_id  TEXT NOT NULL DEFAULT '',
                secret     TEXT NOT NULL DEFAULT '',
                secret_enc TEXT,
                env        TEXT NOT NULL DEFAULT 'sandbox',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Two-level category hierarchy: groups (parent_id NULL) and leaves.
            -- Transactions are assigned to leaves only.
            CREATE TABLE IF NOT EXISTS category (
                id                  TEXT PRIMARY KEY,
                parent_id           TEXT REFERENCES category(id) ON DELETE SET NULL,
                name                TEXT NOT NULL,
                category_type       TEXT,
                sort_order          INTEGER NOT NULL DEFAULT 0,
                exclude_from_totals INTEGER NOT NULL DEFAULT 0,
                system_key          TEXT,
                import_source_batch_id TEXT REFERENCES import_batch(id) ON DELETE SET NULL,
                is_active           INTEGER NOT NULL DEFAULT 1,
                set_aside           INTEGER NOT NULL DEFAULT 0,
                import_pending      INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_category_active ON category(is_active);

            -- keyword is matched as a case-insensitive substring of merchant_name or raw_name.
            -- When several rules match a transaction the most specific wins, by the categorizer's
            -- precedence order (owner-scoped, then account-scoped, then longer keyword, then more
            -- conditions — see services/categorizer.load_categorization_rules).
            -- amount_min/amount_max allow the same payee to map to different categories
            -- depending on transaction size (e.g. small Costco = groceries, large = shopping).
            CREATE TABLE IF NOT EXISTS category_rule (
                id           TEXT PRIMARY KEY,
                category_id  TEXT REFERENCES category(id) ON DELETE CASCADE,
                keyword      TEXT NOT NULL,
                amount_min   REAL,
                amount_max   REAL,
                debit_credit TEXT NOT NULL DEFAULT 'both',
                clean_name   TEXT,
                owner_id     TEXT REFERENCES owner(id) ON DELETE SET NULL,
                account_id   TEXT REFERENCES account(id) ON DELETE SET NULL,
                -- Optional scope by account *type* (e.g. 'paypal', 'amazon'): the rule matches only rows
                -- whose effective account is of this type. Parallel to account_id but covers every account
                -- of the type with one rule. Part of the matcher identity; precedence account_id > type.
                account_type TEXT,
                -- 1 = also match the rule's keyword against the row's captured import source text
                -- (description + extra evidence fields like "Original Statement"), not just the
                -- merchant/raw/display name. Opt-in per rule; part of the rule's matcher identity.
                match_source_text INTEGER NOT NULL DEFAULT 0,
                -- Optional merchant matcher (JSON) that supersedes the single-substring `keyword` when
                -- present: filters alone as {"op":"and","clauses":[{"type":"contains","text":"…"}, …]},
                -- or alternatives with filters as {"op":"any_and","any":[…],"all":[…]} — at least one
                -- alternative and every filter must be a substring of the row's name (or source text).
                -- `keyword` mirrors the joined texts so search keeps working; NULL = a plain keyword rule.
                -- See categorizer.build_match_expr for the canonical form.
                match_expr TEXT,
                -- 1 = this rule declares a recurring series: its matches are members of the
                -- recurring_series row that points back here via rule_id (see recurring_series).
                is_recurring INTEGER NOT NULL DEFAULT 0,
                -- The newest transaction *date* this rule has applied a live effect (category/rename/tag) to,
                -- kept as a monotonic-forward max. Powers the stale-rule cleanup + sort. NULL = never applied.
                last_effect_date TEXT,
                -- Soft-delete marker for the rules trash: non-NULL = trashed (recoverable). The categorizer
                -- and matcher-identity ignore trashed rules; the row survives for restore/purge.
                deleted_at TEXT,
                -- 1 = app-managed rule (auto-created money-movement Type rules); excluded from stale-rule cleanup.
                is_managed INTEGER NOT NULL DEFAULT 0,
                -- The user's precedence term, read before every inferred one (higher wins; levels in
                -- categorizer.RULE_PRIORITY_LEVELS). Not part of the matcher identity. Not named `priority`
                -- because older backups still carry a column of that name with another meaning, and
                -- restore copies any payload column the table has.
                priority_level INTEGER NOT NULL DEFAULT 0,
                -- 1 = a matching transaction that arrives raises a Task (services/rule_alerts.py), titled
                -- with `alert_message` when one is set.
                alert        INTEGER NOT NULL DEFAULT 0,
                alert_message TEXT
            );

            -- `flag_new_for_review`: whether this owner's transactions arrive flagged `needs_review`
            -- (services/review_flagging.py).
            CREATE TABLE IF NOT EXISTS owner (
                id    TEXT PRIMARY KEY,
                name  TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#6366f1',
                flag_new_for_review INTEGER NOT NULL DEFAULT 1
            );

            -- `external_account_id` is the provider's stable per-account handle (Plaid's account_id, a
            -- synthetic `csv_{uuid}` for CSV imports, NULL for manual accounts); it's the upsert key on
            -- connect/sync. `connection_id` links to the backing connection (NULL = not backed by a live
            -- connection: CSV/manual accounts, or an account whose connection was disconnected). `provider`
            -- records origin ('plaid'/'csv'/'manual', matching connection.provider when linked).
            CREATE TABLE IF NOT EXISTS account (
                id                  TEXT PRIMARY KEY,
                external_account_id TEXT UNIQUE,
                connection_id       TEXT REFERENCES connection(id) ON DELETE SET NULL,
                provider            TEXT,
                name                TEXT NOT NULL,
                display_name        TEXT NOT NULL,
                institution         TEXT,
                type                TEXT,
                subtype             TEXT,
                mask                TEXT,
                owner_id            TEXT REFERENCES owner(id) ON DELETE SET NULL,
                parent_account_id   TEXT REFERENCES account(id) ON DELETE SET NULL,
                trashed_at          TEXT
            );

            -- Core transaction table. `txn` not `transaction` (SQLite reserved word).
            -- merchant_name is the preserved canonical/original merchant value.
            -- display_name is the user-facing label (may be updated by rules or user edits).
            -- raw_name is the original string from Plaid, never modified.
            -- category_overridden=1 means recategorize should leave this row alone.
            -- category_source records whether the current category came from a rule,
            -- imported categories already present in the data, or explicit user action.
            CREATE TABLE IF NOT EXISTS txn (
                id                   TEXT PRIMARY KEY,
                -- The provider's own id for this transaction, for any data-source provider — the key that
                -- makes a sync idempotent. Named for Plaid when Plaid was the only one (renamed in v26,
                -- following plaid_account_id -> external_account_id in v20); NULL for rows from a file
                -- import or entered by hand.
                external_transaction_id TEXT UNIQUE,
                -- The identifier a *file* source gave this row, where its export carries one. Unlike the
                -- provider id above it is unique only within the data source that issued it, so it is
                -- deliberately not UNIQUE and is only ever matched through the row's batch
                -- (import_batch.profile_id) — see services/source_transaction_ids.py. NULL for synced
                -- and hand-entered rows, and for files whose source names no id column.
                source_transaction_id TEXT,
                account_id           TEXT NOT NULL REFERENCES account(id),
                category_id          TEXT REFERENCES category(id) ON DELETE SET NULL,
                amount               REAL NOT NULL,
                merchant_name        TEXT,
                display_name         TEXT,
                raw_name             TEXT,
                date                 TEXT NOT NULL,
                is_pending           INTEGER NOT NULL DEFAULT 0,
                category_overridden  INTEGER NOT NULL DEFAULT 0,
                category_source      TEXT,
                -- Provenance of display_name, mirroring category_source: 'manual' (a deliberate
                -- rename — protected forever, never overwritten by rules/enrichment), 'rule' (a rule's
                -- clean_name owns the name), 'import' (the imported/synced name), 'enrichment' (a
                -- reconciliation source filled it). NULL = unknown/legacy, treated as non-manual
                -- (can be enriched). This gives display_name the provenance category_source already has.
                display_name_source  TEXT,
                imported_category    TEXT,
                notes                TEXT,
                owner_id             TEXT REFERENCES owner(id) ON DELETE SET NULL,
                content_hash         TEXT,
                -- When the charge POSTED, where `date` is when it was made wherever the source says so.
                -- Providers supply both; a CSV usually carries only one, and which one differs by source.
                -- Duplicate detection matches when EITHER date lines up, which is what turns a genuine
                -- cross-source duplicate separated by settlement lag into an exact match rather than a
                -- near-miss. NULL when the source doesn't distinguish them, and while a charge is pending.
                -- Reporting and filtering always use `date`.
                posted_date          TEXT,
                import_evidence_json TEXT,
                import_batch_id      TEXT REFERENCES import_batch(id) ON DELETE SET NULL,
                trashed_at           TEXT,
                suspect_duplicate_of     TEXT,
                suspect_duplicate_reason TEXT,
                suspect_resolved_at      TEXT,
                rejection_reason         TEXT,
                dedupe_resolved_by       TEXT,
                -- 1 = freshly imported/synced and not yet looked over. A user convenience for
                -- reviewing newly arrived transactions; cleared by a manual category edit or an
                -- explicit "mark reviewed". Default 0 keeps existing and hand-created rows out of
                -- the review pool. Not a tag: review is workflow lifecycle, not a reporting label.
                needs_review             INTEGER NOT NULL DEFAULT 0,
                -- Membership link to a detected/confirmed recurring series (see recurring_series).
                -- NULL = not part of any recurring series. Recomputed by the recurring detector on
                -- each scan; a match cache, not user-authored.
                recurring_series_id      TEXT REFERENCES recurring_series(id) ON DELETE SET NULL,
                -- 1 = this transaction's amount is allocated across several categories in `txn_split`
                -- rather than sitting in the single `category_id`. The reporting expansion does not
                -- read it (it left-joins the parts directly); the flag exists for everything that has
                -- to know a row is split *without* reaching for its parts — the ledger's "Split (N)"
                -- rendering, and the guards that make automatic categorization and bulk edits decline
                -- these rows. While it is set, `category_id` retains the pre-split category as the
                -- stashed prior that un-splitting restores.
                is_split                 INTEGER NOT NULL DEFAULT 0
            );

            -- One category allocation of a split transaction's amount. The parts of a split must sum to
            -- the transaction's amount and share its sign; that is enforced on save (see
            -- services/txn_splits.py), not by the DB, because no SQLite constraint can express a
            -- cross-row sum. Several parts may share a category: the parts record *items*, and two
            -- items bought together may classify alike. Summary buckets count DISTINCT transactions
            -- so that costs nothing in reporting.
            CREATE TABLE IF NOT EXISTS txn_split (
                id          TEXT PRIMARY KEY,
                txn_id      TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                category_id TEXT REFERENCES category(id) ON DELETE SET NULL,
                amount      REAL NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                -- Free text naming what this allocation covers, defaulted from an imported order's
                -- item description and meant to be cut down by the user. Descriptive only: no report,
                -- filter or total reads it, which is why it can be edited freely without any of the
                -- protection the category and amount carry.
                label       TEXT
            );

            -- A receipt or invoice attached to a transaction: the paperwork saying *what was bought*,
            -- which the ledger row itself never records. The bytes are a file under `documents/` beside
            -- this database, not a blob here — see services/documents.py for why, and for the file-first
            -- write order that decides which way a crash can fail.
            --
            -- Several documents may hang off one transaction (a repair arrives as an estimate and then a
            -- final invoice, a scan as two images), so there is deliberately no unique index on txn_id.
            CREATE TABLE IF NOT EXISTS document (
                id          TEXT PRIMARY KEY,
                -- NULL for a *stored* document: kept before the transaction it belongs to has arrived (an
                -- invoice that precedes its charge), and attached later by setting this. Nothing cascades
                -- one away, so every wipe of the ledger has to name this table.
                txn_id      TEXT REFERENCES txn(id) ON DELETE CASCADE,
                -- The upload's own name, kept for display and for the download filename. Never used to
                -- locate the file: the store is keyed by id precisely so a user-supplied name is not
                -- filesystem input.
                filename    TEXT NOT NULL,
                mime_type   TEXT NOT NULL,
                -- Both describe the *stored* bytes rather than the upload, which differ whenever an
                -- oversized image was downscaled at ingest. The digest is load-bearing: it is what tells
                -- a complete file from a torn one when a restore resumes, what extends a backup's
                -- integrity check to cover the files, and how the same receipt attached twice is spotted.
                byte_size   INTEGER NOT NULL,
                sha256      TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                -- Text pulled out of the document, and which tier produced it ('pdf_text' for a digital
                -- PDF's own text layer). NULL means no text was obtained — a photograph before OCR is
                -- offered, or a PDF with no text layer — which is distinct from a document whose text is
                -- genuinely empty. Search reads this; nothing else depends on it, so a document with no
                -- text is fully functional.
                text        TEXT,
                text_source TEXT
            );

            -- One row at most, tracking a restore that is in flight or unfinished. It exists because a
            -- restore spans two things that cannot be one transaction: the ledger, which commits
            -- atomically, and the document files, which do not. A crash between them would otherwise
            -- leave a live ledger whose paperwork is half-written, with nothing recording that.
            --
            -- It lives in the *data* DB rather than the control DB on purpose. The instinct is the
            -- control DB, on the precedent of state that must survive a data restore — but the
            -- requirement here is stronger than survival: the marker must be *atomic with the committed
            -- ledger*. Written inside the restore transaction, it exists exactly when the ledger it
            -- describes exists. A control-DB row could land without the ledger, or the ledger without it.
            --
            -- It is also its own table rather than a key in `import_workflow_state`, which the restore
            -- *wipes* — a marker living there would be inside the blast radius of the operation it
            -- tracks. Staying outside the wipe list also keeps it out of the backup for free: this is
            -- machine-local operational state and must never travel to another install.
            CREATE TABLE IF NOT EXISTS restore_state (
                -- Single-row table; the CHECK is what makes that a schema fact rather than a convention.
                id             INTEGER PRIMARY KEY CHECK (id = 1),
                -- 'staging'           — a restore is running and has NOT committed. Nothing was changed,
                --                       so finding this after an unclean shutdown means report and clear.
                -- 'documents_pending' — the ledger is live and its files are not all there yet, so the
                --                       documents phase can resume. These mean opposite things about the
                --                       data, which is why a phase is recorded rather than a flag.
                phase          TEXT NOT NULL,
                started_at     TEXT NOT NULL,
                -- Where the staged artifact was left. It outlives the ledger commit precisely so a
                -- resume has something to read; it is deleted when the documents phase completes.
                artifact_path  TEXT,
                -- Enough of the backup's identity to recognize it again if the staged file is gone, so a
                -- re-upload can be confirmed as *the same backup* rather than silently filling the
                -- document directory from a different one.
                artifact_id    TEXT
            );

            CREATE TABLE IF NOT EXISTS tag (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                color      TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS rule_tag (
                rule_id TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
                tag_id  TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                PRIMARY KEY (rule_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS txn_tag (
                txn_id       TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                tag_id       TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                rule_present INTEGER NOT NULL DEFAULT 0,
                manual_state INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (txn_id, tag_id)
            );

            -- Category-level tag attachments. A category can be a leaf or a group
            -- (parent_id NULL); transactions inherit additively from their leaf
            -- category and that category's parent group, so a tag on a group
            -- propagates to every leaf under it without per-leaf duplication.
            CREATE TABLE IF NOT EXISTS category_tag (
                category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
                tag_id      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                PRIMARY KEY (category_id, tag_id)
            );

            -- Account-level tag attachments. Transactions inherit their account's tags resolved
            -- through the effective (top-level) account: a top-level account's tags propagate to
            -- its own and its children's transactions; a child's own tags stay dormant while merged.
            CREATE TABLE IF NOT EXISTS account_tag (
                account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
                tag_id     TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                PRIMARY KEY (account_id, tag_id)
            );

            -- Records account pairs the user has explicitly declared distinct via Keep on a
            -- soft-flag suspect. The cross-account suspect check filters out pairs present
            -- here. Pair is stored sorted (low, high) so each pair has a single row regardless
            -- of which side surfaced first.
            CREATE TABLE IF NOT EXISTS account_pair_distinct (
                account_id_low  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
                account_id_high TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
                asserted_at     TEXT NOT NULL,
                PRIMARY KEY (account_id_low, account_id_high),
                CHECK (account_id_low < account_id_high)
            );

            CREATE INDEX IF NOT EXISTS idx_account_pair_distinct_high ON account_pair_distinct(account_id_high);

            -- Charge pairs the user declared "not duplicates" on the Amazon reconciliation report's
            -- Unaccounted·duplicate grouping (same account + amount, days apart — but genuinely
            -- distinct purchases). The grouping skips pairs present here, so the assertion sticks
            -- across refreshes. Same sorted-pair shape as account_pair_distinct above.
            -- Transaction pairs the user judged "not the same charge" by resolving a soft-flag suspect
            -- with Keep. Keep clears the flag on its row and records `suspect_resolved_at`, but neither
            -- says *which* pair was judged — so a later re-scan could not tell "never examined" from
            -- "examined and kept", and re-raised the finding while erasing the resolution stamp. That was
            -- harmless while an account merge was the only thing that ever re-scanned; it stops being so
            -- once a matcher change does. Same sorted-pair shape as the two tables around it.
            -- `flagged_txn_id` and `reason` are what the flag *was*, kept so undoing the judgement can
            -- put it back exactly rather than re-deriving it: a re-derivation could reach a different
            -- tier (the rules may have moved since) and would restore a finding the user never saw.
            CREATE TABLE IF NOT EXISTS suspect_pair_distinct (
                txn_id_low     TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                txn_id_high    TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                flagged_txn_id TEXT,
                reason         TEXT,
                asserted_at    TEXT NOT NULL,
                PRIMARY KEY (txn_id_low, txn_id_high),
                CHECK (txn_id_low < txn_id_high)
            );

            CREATE INDEX IF NOT EXISTS idx_suspect_pair_distinct_high ON suspect_pair_distinct(txn_id_high);

            CREATE TABLE IF NOT EXISTS amazon_charge_distinct (
                txn_id_low  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                txn_id_high TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                asserted_at TEXT NOT NULL,
                PRIMARY KEY (txn_id_low, txn_id_high),
                CHECK (txn_id_low < txn_id_high)
            );

            CREATE INDEX IF NOT EXISTS idx_amazon_charge_distinct_high ON amazon_charge_distinct(txn_id_high);

            -- Unaccounted charges the user acknowledged ("Mark reviewed") on the Amazon reconciliation
            -- report's reverse-scan bucket: an Amazon-looking ledger charge no order accounts for that the
            -- user has looked at and is fine with. The reconciliation report drops acknowledged charges out
            -- of its attention count (they stay listed), so the informational bucket can be surfaced for a
            -- look without nagging forever. One row per charge; cascades away if the charge is hard-deleted.
            CREATE TABLE IF NOT EXISTS amazon_charge_reviewed (
                txn_id      TEXT PRIMARY KEY REFERENCES txn(id) ON DELETE CASCADE,
                reviewed_at TEXT NOT NULL
            );

            -- Per-item detail from an Amazon items file imported *before* its orders file: parked here
            -- (keyed by order id) instead of being discarded, so importing the matching orders file later
            -- auto-attaches it. `parked_batch_id` ties the row to the orphan import that created it, so
            -- undoing that import removes its parked items. `consumed_batch_id` names the orders import that
            -- attached them (NULL while they wait), so undoing *that* import returns them to waiting. See
            -- routers/import_export/amazon.py.
            CREATE TABLE IF NOT EXISTS amazon_pending_item (
                order_id          TEXT PRIMARY KEY,
                items_json        TEXT NOT NULL,
                source_file       TEXT,
                source_file_hash  TEXT,
                parked_batch_id   TEXT,
                consumed_batch_id TEXT,
                created_at        TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Non-sensitive UI/layout preferences, keyed by scope_id (auth user id or local
            -- preference-profile id). Lives in the data DB so it travels with the data it describes
            -- and is captured by data backups; the control DB keeps only identity/secrets.
            CREATE TABLE IF NOT EXISTS ui_preference (
                scope_id   TEXT NOT NULL,
                pref_key   TEXT NOT NULL,
                pref_value TEXT NOT NULL,
                updated_at TEXT,
                PRIMARY KEY (scope_id, pref_key)
            );
            CREATE INDEX IF NOT EXISTS idx_ui_preference_scope ON ui_preference(scope_id);

            CREATE INDEX IF NOT EXISTS idx_txn_date        ON txn(date);
            CREATE INDEX IF NOT EXISTS idx_txn_account     ON txn(account_id);
            CREATE INDEX IF NOT EXISTS idx_txn_category    ON txn(category_id);
            CREATE INDEX IF NOT EXISTS idx_txn_owner       ON txn(owner_id);
            CREATE INDEX IF NOT EXISTS idx_txn_batch       ON txn(import_batch_id);
            CREATE INDEX IF NOT EXISTS idx_txn_hash        ON txn(content_hash);
            -- An EXPRESSION index, and it has to be: the cross-account duplicate sweep pairs rows on
            -- `ROUND(t2.amount, 2) = ROUND(t1.amount, 2)`, and a function over the column makes a plain
            -- index on `amount` unusable — so the sweep's inner side was a full scan of `txn` for every
            -- row it checked, and the pairing is quadratic in the ledger. On a 17.8k-row ledger, sweeping
            -- a 7.3k-row card took 109 seconds; with this index, 1.0. Partial on `trashed_at IS NULL`
            -- because every consumer excludes trashed rows, which keeps it to the live ledger.
            CREATE INDEX IF NOT EXISTS idx_txn_amount_round
                ON txn(ROUND(amount, 2)) WHERE trashed_at IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_name_unique ON tag(LOWER(TRIM(name)));
            CREATE INDEX IF NOT EXISTS idx_tag_sort_order  ON tag(sort_order);
            CREATE INDEX IF NOT EXISTS idx_rule_category   ON category_rule(category_id);
            CREATE INDEX IF NOT EXISTS idx_rule_keyword    ON category_rule(keyword);
            CREATE INDEX IF NOT EXISTS idx_rule_account    ON category_rule(account_id);
            CREATE INDEX IF NOT EXISTS idx_rule_tag_tag    ON rule_tag(tag_id);
            CREATE INDEX IF NOT EXISTS idx_account_owner   ON account(owner_id);
            CREATE INDEX IF NOT EXISTS idx_txn_tag_tag     ON txn_tag(tag_id);
            CREATE INDEX IF NOT EXISTS idx_category_tag_tag ON category_tag(tag_id);
            CREATE INDEX IF NOT EXISTS idx_account_tag_tag ON account_tag(tag_id);

            CREATE TABLE IF NOT EXISTS csv_import_profile (
                id                   TEXT PRIMARY KEY,
                name                 TEXT NOT NULL,
                filename_pattern     TEXT,
                header_fingerprint   TEXT,
                template_filename    TEXT,
                template_file_hash   TEXT,
                column_map           TEXT NOT NULL DEFAULT '{}',
                account_id           TEXT REFERENCES account(id) ON DELETE SET NULL,
                date_format          TEXT NOT NULL DEFAULT '%Y-%m-%d',
                amount_convention    TEXT NOT NULL DEFAULT 'single_signed',
                -- How the source's files write a number: 'point' (1,234.56) or 'comma' (1.234,56). Read
                -- strictly by services/amount_text.py, so a cell malformed in it is refused, not guessed.
                decimal_separator    TEXT NOT NULL DEFAULT 'point',
                skip_rows            INTEGER NOT NULL DEFAULT 0,
                apply_categorization INTEGER NOT NULL DEFAULT 1,
                enrich_from_source   INTEGER NOT NULL DEFAULT 0,
                use_imported_categories INTEGER NOT NULL DEFAULT 0,
                notes                TEXT,
                source_kind          TEXT,
                -- How many trailing days of this source's exports are treated as SOFT — reconciled
                -- one-to-one instead of blanket-rejected as already-covered. Most sources lag the thing
                -- they describe (an aggregator waits on the bank; a bank waits on its own pending
                -- pipeline), so the default is the lagging case. Lowering it to 1 — just the export
                -- day — is the opt-in for a first-party export (Amazon, PayPal) that publishes its own
                -- records and has no lag. See duplicate_detection.DEFAULT_TERMINAL_WINDOW_DAYS.
                terminal_window_days INTEGER NOT NULL DEFAULT 7,
                -- Watched import folder (see routers/import_export/watch.py). The path is read by the
                -- *server*, so on a LAN server or in a container it names a folder there rather than on
                -- the browser's machine. `watch_enabled` is separate from the path on purpose: a restore
                -- from another instance switches watching off while keeping the path, so the person can
                -- see what it was set to before deciding what it should be here. `watch_notice` is the
                -- source-level "this folder is not there right now", which is a notice rather than an
                -- error because removable media and network shares come and go.
                watch_dir            TEXT,
                watch_enabled        INTEGER NOT NULL DEFAULT 0,
                watch_purge_mode     TEXT NOT NULL DEFAULT 'never',
                watch_purge_days     INTEGER NOT NULL DEFAULT 30,
                watch_notice         TEXT,
                watch_last_scan_at   TEXT,
                created_at           TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- The per-file watermark behind a watched folder, and the record of what each file's scan
            -- decided. `(size, mtime)` is what os.scandir hands back for the cost of the syscall, so an
            -- entry that matches its row is never read, hashed or parsed again; anything else is. The
            -- durable answer to "have we taken this exact file" stays import_batch.file_content_hash —
            -- this table is a cache of the cheap half plus the reason a file is waiting on someone.
            CREATE TABLE IF NOT EXISTS import_watch_file (
                id           TEXT PRIMARY KEY,
                profile_id   TEXT NOT NULL REFERENCES csv_import_profile(id) ON DELETE CASCADE,
                filename     TEXT NOT NULL,
                size         INTEGER NOT NULL,
                mtime        REAL NOT NULL,
                state        TEXT NOT NULL,
                reason       TEXT,
                content_hash TEXT,
                batch_id     TEXT,
                resolved_at  TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_import_watch_file_name
                ON import_watch_file(profile_id, filename);
            CREATE INDEX IF NOT EXISTS idx_import_watch_file_state ON import_watch_file(state);

            CREATE TABLE IF NOT EXISTS import_batch (
                id               TEXT PRIMARY KEY,
                profile_id       TEXT REFERENCES csv_import_profile(id) ON DELETE SET NULL,
                filename         TEXT NOT NULL,
                file_content_hash TEXT,
                imported_at      TEXT NOT NULL DEFAULT (datetime('now')),
                row_count        INTEGER NOT NULL DEFAULT 0,
                skipped_count    INTEGER NOT NULL DEFAULT 0,
                deduped_count    INTEGER NOT NULL DEFAULT 0,
                -- Rows that corrected a transaction already held rather than adding one: the source
                -- revised an amount between two exports (see `match_terminal_amount_revision`). Counted
                -- apart from imported and deduped because it is neither — the ledger changed, but no row
                -- was created — and because a silent amount change is exactly what wants reporting.
                updated_count    INTEGER NOT NULL DEFAULT 0,
                -- Rows refused as this source restating its own prior import: counted, but holding no
                -- report row, because the transaction each duplicates is in the ledger and is the record
                -- (see `is_settled_source_restatement`). Kept apart from `deduped_count`, whose contract
                -- is that it counts rows the duplicate report can actually show.
                ignored_count    INTEGER NOT NULL DEFAULT 0,
                status           TEXT NOT NULL DEFAULT 'completed',
                use_imported_categories INTEGER NOT NULL DEFAULT 0,
                config_snapshot  TEXT,
                -- Provenance class of the import, for history grouping. NULL = an ordinary CSV import;
                -- 'marketplace:<vendor>' (e.g. 'marketplace:amazon') marks a dedicated marketplace
                -- importer's batch so the history groups it under that vendor instead of "unknown source";
                -- 'connection_sync' marks a data-source sync's per-(connection, month) period card.
                source_kind      TEXT,
                -- The connection whose sync produced this card (source_kind='connection_sync'); the indexed
                -- key sync uses to resolve the current period's card. NULL for CSV/marketplace batches.
                connection_id    TEXT REFERENCES connection(id) ON DELETE SET NULL,
                -- The provider key of that connection ('plaid', 'simplefin'), written with the card rather
                -- than read through connection_id, which removing the connection nulls. It is what lets a
                -- synced row still name its connection afterwards. NULL for CSV/marketplace batches.
                provider         TEXT,
                -- Cached Amazon reconciliation "attention" count (a duplicate/split to resolve), with the
                -- global recon epoch (db_meta 'recon_epoch') it was computed at. Recomputed lazily only when
                -- the batch's epoch trails the current one; see amazon.reconciliation_attention_count and the
                -- recon-epoch triggers created after run_migrations. NULL = never computed.
                recon_attention_count INTEGER,
                recon_epoch      INTEGER,
                -- The period this card covers and which kind of answer that is ('statement' = a
                -- statement's declared period, 'rows' = the span of the dates its rows carried,
                -- 'items' = a marketplace items-only card's parked items). Written when the card's rows
                -- are, by services/import_batch_totals.refresh_batch_coverage, because it is a fact
                -- about the file rather than about the ledger's current contents. It is what the import
                -- history orders and groups by.
                covers_start     TEXT,
                covers_end       TEXT,
                covers_source    TEXT,
                -- When this card's detail records (its duplicate report and its stored rejected rows)
                -- were cleared by the maintenance screen — see services/import_detail_storage.py. The
                -- card itself stays in the history and says so; what the marker is for is telling a
                -- card that refused nothing from one whose record of refusing has been freed.
                detail_cleared_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_import_batch_file_hash ON import_batch(file_content_hash);

            CREATE TABLE IF NOT EXISTS import_batch_account (
                batch_id    TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
                csv_value   TEXT NOT NULL,
                account_id  TEXT REFERENCES account(id) ON DELETE SET NULL,
                row_count   INTEGER NOT NULL DEFAULT 0,
                was_skipped INTEGER NOT NULL DEFAULT 0,
                coverage_start_date TEXT,
                coverage_end_date   TEXT,
                terminal_date       TEXT,
                PRIMARY KEY (batch_id, csv_value)
            );
            CREATE INDEX IF NOT EXISTS idx_iba_account ON import_batch_account(account_id);
            CREATE INDEX IF NOT EXISTS idx_iba_batch   ON import_batch_account(batch_id);

            CREATE TABLE IF NOT EXISTS import_batch_duplicate (
                batch_id                  TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
                row_number                INTEGER NOT NULL,
                reason                    TEXT NOT NULL,
                values_json               TEXT,
                matched_transaction_json  TEXT,
                txn_payload_json          TEXT,
                reviewed_at               TEXT,
                -- Enrich-on-duplicate outcome (see migration 7): the existing row this duplicate's novel
                -- detail was folded into, exactly what was added (for undo), and when. NULL = not enriched.
                enriched_txn_id           TEXT,
                enriched_delta_json       TEXT,
                enriched_at               TEXT,
                -- Which advisory sub-state this rejection amounts to (see migration 61 and
                -- `services/duplicate_detection.coverage_review_substate`). NULL = a settled rejection,
                -- not an unclassified one: the writer sets it on every row.
                review_substate           TEXT,
                PRIMARY KEY (batch_id, row_number)
            );
            CREATE INDEX IF NOT EXISTS idx_import_batch_duplicate_batch ON import_batch_duplicate(batch_id);

            -- Rows a file offered that the import did not take, other than duplicates (those are
            -- `import_batch_duplicate`, which carries a review state these rows have no use for). The
            -- file is gone as soon as the upload ends, so without this the only record of what was
            -- dropped is a count, and "why is this account short" has no answer a month later.
            --
            -- `kind` is why it was dropped: 'validation_error', 'currency', 'zero_amount',
            -- 'account_skipped' (the user's own choice, so the least diagnostic), or 'trailing_text'
            -- — one synthetic row standing for a whole suspected footer, whose `reason` names the
            -- range, since a hundred rows of address block are one fact rather than a hundred.
            --
            -- **Capped per batch, and deliberately lossy** (`MAX_STORED_REJECTED_ROWS`): a
            -- misconfigured mapping can reject every row of a large file, and this is a diagnostic
            -- record rather than a second ledger. What is stored is filled by kind priority, so the
            -- rows that indicate a problem survive a cap that a deliberate account skip would
            -- otherwise fill. The true totals stay exact in the batch's `import_summary`, which is
            -- what tells a reader the stored set is partial — there is no truncation flag to drift.
            --
            -- `row_date` / `description` / `amount` are the sortable columns, best-effort: a row that
            -- failed to parse keeps whatever the file's cells said, so the column shows the text that
            -- was rejected. `values_json` is always the whole row as written.
            CREATE TABLE IF NOT EXISTS import_batch_rejected_row (
                batch_id    TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
                row_number  INTEGER NOT NULL,
                kind        TEXT NOT NULL,
                reason      TEXT NOT NULL,
                values_json TEXT,
                row_date    TEXT,
                description TEXT,
                amount      REAL,
                PRIMARY KEY (batch_id, row_number)
            );

            CREATE TABLE IF NOT EXISTS backup_recipient (
                id          TEXT PRIMARY KEY,
                label       TEXT NOT NULL,
                public_key  TEXT NOT NULL,
                fingerprint TEXT NOT NULL UNIQUE,
                algorithm   TEXT NOT NULL DEFAULT 'rsa-oaep-sha256',
                enabled     INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS import_workflow_state (
                key          TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL DEFAULT '{}'
            );

            -- Recurring transaction series: an ongoing obligation (subscription, bill, tax) whose
            -- charges recur on a cadence. Detected on demand by services/recurring_detection.py and
            -- curated by the user. Identity for the detector is (payee_key, category_id, account_id):
            -- one payee can host several series distinguished by category (e.g. a town billing
            -- property tax quarterly, excise annually, water monthly). `status`/`source`/`confirmed`
            -- record user curation: auto+unconfirmed rows are the detector's to rewrite each scan,
            -- while manual, confirmed, and suppressed rows are user-owned and never overwritten or
            -- re-proposed. amount_min/max/expected describe the observed amount band (a booster and a
            -- forecast hint, not a matching gate — variable bills still recur on schedule).
            CREATE TABLE IF NOT EXISTS recurring_series (
                id                TEXT PRIMARY KEY,
                payee_key         TEXT NOT NULL,
                display_name      TEXT,
                category_id       TEXT REFERENCES category(id) ON DELETE SET NULL,
                account_id        TEXT REFERENCES account(id) ON DELETE SET NULL,
                cadence           TEXT NOT NULL,
                period_days       INTEGER NOT NULL,
                expected_amount   REAL,
                amount_min        REAL,
                amount_max        REAL,
                -- 'variable' (default) or 'fixed'. Fixed means the series' price point is part of its
                -- identity, so it matches only charges near its band — what keeps two same-payee,
                -- same-category subscriptions at different prices from collapsing into one another.
                -- Set by the detector where amount actually discriminates; see recurring_detection.py.
                amount_mode       TEXT NOT NULL DEFAULT 'variable',
                -- The user's pinned expectation band. NULL means "derive it" (the usual case), and the
                -- derived band lives in amount_min/amount_max, which every scan rewrites from the rows
                -- the series owns. They are separate columns precisely so a scan cannot erase a pin:
                -- a derived band self-adjusts and needs no maintenance, a pinned one is a claim the user
                -- made about what this series costs and only the user retracts it.
                expected_min      REAL,
                expected_max      REAL,
                last_txn_date     TEXT,
                next_due_date     TEXT,
                occurrence_count  INTEGER NOT NULL DEFAULT 0,
                confidence        REAL NOT NULL DEFAULT 0,
                status            TEXT NOT NULL DEFAULT 'active',
                -- 'auto' (detector), 'manual' (anchor-created), or 'rule' (rule-backed: membership is
                -- the linked rule's matches rather than the derived payee_key key).
                source            TEXT NOT NULL DEFAULT 'auto',
                -- Set only for source='rule' series: the category_rule whose matches are this series'
                -- members. ON DELETE SET NULL as a safety net; delete_rule drops the series explicitly.
                rule_id           TEXT REFERENCES category_rule(id) ON DELETE SET NULL,
                confirmed         INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at        TEXT,
                -- JSON array of the txn ids this series held when it was suppressed, written by the
                -- suppress endpoint just before it nulls their `recurring_series_id`. It exists because
                -- that drop is not reversible by query: membership is the detector's judgement (a
                -- periodicity fit over one charge per date), and re-deriving it from the payee label
                -- disagreed with the stored `occurrence_count` in both directions — too few where the
                -- bank spelled the payee inconsistently, far too many where the same payee also had
                -- unrelated charges. NULL for an unsuppressed series, and for one suppressed before this
                -- column existed; both fall back to matching, and the drill-down reconciles the count it
                -- displays to whatever that actually returns.
                suppressed_member_ids TEXT,
                -- The far account of a two-legged money movement. Set only on a transfer series, where
                -- `account_id` is the paying side and this is the receiving side; NULL on every ordinary
                -- payee series, which is also what tells the two apart everywhere.
                --
                -- A transfer series exists because one movement between two tracked accounts is recorded
                -- twice, once per account, and grouping those rows by payee reads them as two unrelated
                -- things whose descriptors then drift apart independently. Its identity is the pair of
                -- accounts plus the category, so its `payee_key` is a synthetic `transfer:<from>:<to>`
                -- rather than a name, and it owns BOTH legs of every occurrence it claims. See
                -- `services/transfer_pairs.py`.
                counterpart_account_id TEXT REFERENCES account(id) ON DELETE SET NULL,
                -- Set only on a rule-backed series: the rule's matcher as the series was last reconciled
                -- against it. A scoped scan reconciles a rule-backed series only when an edit touches it
                -- or this no longer matches the rule, so a rule edit on any path is picked up without the
                -- path owing it. NULL = never reconciled, which always differs.
                rule_fingerprint TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_recurring_series_payee ON recurring_series(payee_key);
            -- Payees owed a recurring rescan: recorded in the transaction of the write that made it
            -- necessary, cleared by the scan that settles it (`docs/data-model.md` -> *When a scan runs*).
            -- `generation` moves on each re-owe, so a scan settles only the debt it read. Derived
            -- state: not backed up, and wiped with the ledger it describes.
            CREATE TABLE IF NOT EXISTS recurring_rescan_owed (
                payee_key  TEXT PRIMARY KEY,
                generation INTEGER NOT NULL,
                owed_at    TEXT NOT NULL
            );
            -- What the user answered when the pairing pass could not tell which of two transactions
            -- was the other half of a movement. `receiving_txn_id` names the counterpart; NULL is the
            -- dismissal ("this one has none, stop asking") — one column for both answers, because they
            -- answer the same question. Applied ahead of any inference (`services/transfer_pairs.py`):
            -- the pass never learns from a decision it made itself, only from one a person made.
            CREATE TABLE IF NOT EXISTS transfer_pair_decision (
                paying_txn_id    TEXT PRIMARY KEY REFERENCES txn(id) ON DELETE CASCADE,
                receiving_txn_id TEXT REFERENCES txn(id) ON DELETE CASCADE,
                created_at       TEXT NOT NULL DEFAULT (datetime('now'))
            );
            -- Surgical, scan-durable membership corrections layered over the derived/rule matcher:
            -- 'excluded' keeps a matched row out of its series. Reconcile applies these every scan so
            -- they survive a rebuild. A 'pinned' state (forcing a row *in*) existed and was withdrawn:
            -- a series is defined by what recurs, so a charge that merely shares a payee and category
            -- is not part of it, and forcing it in misrepresents the series and every total read from
            -- it. The endpoint rejects the state and reconcile filters on 'excluded', so no row can
            -- carry it; the partial index below is therefore vestigial and kept only because dropping
            -- it would cost a migration for nothing.
            CREATE TABLE IF NOT EXISTS recurring_membership_override (
                txn_id     TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                series_id  TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
                state      TEXT NOT NULL,
                PRIMARY KEY (txn_id, series_id)
            );
            -- "I have seen this and it is fine": the user's dismissal of one anomaly signal
            -- (services/recurring_signals.py). Signals themselves are derived on read and never
            -- stored, so this is the whole of their durable state. The key is the signal's own
            -- fingerprint -- a transaction id, or a series' derived identity plus the date concerned --
            -- deliberately NOT a recurring_series id, which an auto series loses on every scan. It is
            -- therefore not a foreign key: a dismissal whose subject is later trashed or deleted simply
            -- stops matching anything, which costs a row and no correctness. `one_off` marks an
            -- Amount changed finding dismissed as "fine this time": the charge is then left out of the
            -- history later charges are judged against, so a repeat of it is reported again.
            CREATE TABLE IF NOT EXISTS recurring_signal_dismissal (
                signal_key   TEXT PRIMARY KEY,
                kind         TEXT NOT NULL,
                one_off      INTEGER NOT NULL DEFAULT 0,
                dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            -- The same shape for the rule-overlap check (services/rule_overlaps.py): "this pair of rules
            -- is deliberate". Its findings are recomputed from the rules on every run, so these are their
            -- whole durable state. The key is the finding's fingerprint -- the rule pair plus what made
            -- it actionable (the contested amount band, or whether the narrow rule was redundant) -- so an
            -- edit that changes the situation produces a different key and surfaces again rather than
            -- staying acknowledged. Not a foreign key, for the same reason as above: a dismissal whose
            -- pair later dissolves stops matching anything, which costs a row and no correctness.
            CREATE TABLE IF NOT EXISTS rule_overlap_dismissal (
                finding_key  TEXT PRIMARY KEY,
                kind         TEXT NOT NULL,
                dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            -- Rule pairs a categorization pass caught deciding a transaction arbitrarily
            -- (services/rule_conflicts.py): one row per pair, ids sorted, with the newest transaction that
            -- showed it. A note rather than a verdict -- every read re-tests the pair and drops it when it
            -- no longer holds -- so it is not backed up: the next pass that meets the pair records it again.
            CREATE TABLE IF NOT EXISTS rule_conflict (
                rule_id_low  TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
                rule_id_high TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
                txn_id       TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                PRIMARY KEY (rule_id_low, rule_id_high)
            );
            -- The transactions a rule's alert caught as they arrived (services/rule_alerts.py). Recorded
            -- only for a row new to the ledger, so nothing re-derives one: it is backed up.
            CREATE TABLE IF NOT EXISTS rule_alert_hit (
                rule_id TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
                txn_id  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                PRIMARY KEY (rule_id, txn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_rule_alert_hit_txn ON rule_alert_hit(txn_id);
            -- The backups this system made, and the file its data was last restored from
            -- (services/backup_history.py). Sizes are bytes as stored in the archive; `key_labels` is a
            -- JSON list of the backup keys an encrypted file was sealed to. `restored_at` is set only on the
            -- row for the file a restore came from. `deleted_at` is the history's trash. `database_check` is
            -- how the check of both databases came out as the backup was made: 'passed', 'failed', or NULL
            -- when it was not run (a row older than the check, or the file a restore came from).
            CREATE TABLE IF NOT EXISTS backup_history (
                id                   TEXT PRIMARY KEY,
                made_at              TEXT NOT NULL,
                made_by              TEXT,
                filename             TEXT,
                encrypted            INTEGER,
                key_labels           TEXT,
                credentials_included INTEGER,
                credentials_left_out TEXT,
                total_bytes          INTEGER,
                ledger_bytes         INTEGER,
                accounts_bytes       INTEGER,
                documents_bytes      INTEGER,
                document_count       INTEGER,
                restored_at          TEXT,
                deleted_at           TEXT,
                database_check       TEXT CHECK (database_check IN ('passed', 'failed'))
            );

            -- Typed links between transactions: a general association primitive (services/txn_links.py).
            -- A link groups transactions under a `kind` (e.g. 'amazon_order'), each member carrying a
            -- `role` within the link (e.g. the funding 'charge' vs the 'item' rows it was split into).
            -- `external_ref` is the external entity the link represents (an Amazon order id);
            -- `metadata_json` is kind-specific (e.g. what a reversal must restore). The primitive only
            -- *associates* rows — it never mutates the linked transactions; the owning feature does that.
            CREATE TABLE IF NOT EXISTS txn_link (
                id            TEXT PRIMARY KEY,
                kind          TEXT NOT NULL,
                external_ref  TEXT,
                metadata_json TEXT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_txn_link_ref ON txn_link(kind, external_ref);

            CREATE TABLE IF NOT EXISTS txn_link_member (
                link_id TEXT NOT NULL REFERENCES txn_link(id) ON DELETE CASCADE,
                txn_id  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                role    TEXT NOT NULL,
                PRIMARY KEY (link_id, txn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_txn_link_member_txn ON txn_link_member(txn_id);

            -- Amazon funding-source → account map (see docs/data-model.md → "Transaction links and
            -- Amazon order import"). Keys an Amazon payment instrument (a card last-4 +
            -- network label) to the system account it charges, so the Amazon importer can constrain its
            -- card-charge search to that account. Three states: a row with funding_account_id set = mapped;
            -- a row with funding_account_id NULL = "untracked" (an explicit "this card isn't an account I
            -- hold" — items count directly, no charge); no row = unmapped (falls to the graceful-last-4
            -- match). amazon_account_id NULL = the global default (applies when importing for any Amazon
            -- account); non-NULL = a per-account override that wins over the global row for that account.
            CREATE TABLE IF NOT EXISTS amazon_funding_map (
                id                 TEXT PRIMARY KEY,
                last4              TEXT NOT NULL,
                network            TEXT,
                amazon_account_id  TEXT REFERENCES account(id) ON DELETE CASCADE,
                funding_account_id TEXT REFERENCES account(id) ON DELETE CASCADE,
                created_at         TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
            );
            -- One row per instrument per scope. Split in two because SQLite treats NULLs as distinct in a
            -- unique index, so the global (amazon_account_id IS NULL) rows need their own partial index to
            -- be deduped on (last4, network); the override rows dedupe on all three columns.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_funding_global
                ON amazon_funding_map(last4, COALESCE(network, ''))
                WHERE amazon_account_id IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_funding_override
                ON amazon_funding_map(last4, COALESCE(network, ''), amazon_account_id)
                WHERE amazon_account_id IS NOT NULL;
        """)

        _seed_default_categories(conn)

        if is_fresh_db:
            _alphabetize_top_level_category_groups(conn)
            set_db_version(conn, CURRENT_VERSION)
            # A new database holds no transactions, so the duplicate matcher has nothing to re-examine:
            # stamping the version keeps the first app load from opening a write transaction to reach
            # that conclusion. After `set_db_version`, which is what creates `db_meta`. Imported
            # locally, like the services the migrations reach for.
            from backend.services.duplicate_detection import stamp_detection_version

            stamp_detection_version(conn)
            log_info(f"[db] created new database at schema version {CURRENT_VERSION}", keep_in_file=True)
        else:
            # Advance an existing database in place. init_db's schema is all `CREATE TABLE IF NOT
            # EXISTS`, so structural changes belong in registered migrations, which run here.
            migrated_from = get_db_version(conn)
            run_migrations(conn)
        # Partial index over just the small set of still-un-reviewed rows (the filter/count always
        # selects needs_review = 1). It lives here rather than in the schema script above because on a
        # pre-v3 database the column is only added by migration v3 (run_migrations, just above); creating
        # it inside the CREATE TABLE script would reference a not-yet-existing column. By this point the
        # column exists in both paths — fresh (baseline CREATE TABLE) and migrated — so IF NOT EXISTS is
        # safe for both.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_txn_needs_review ON txn(needs_review) WHERE needs_review = 1"
        )
        # Same deferral as idx_txn_needs_review: txn.recurring_series_id only exists after migration v4
        # on a pre-v4 database, so its partial index is created here (after the migrate branch) where the
        # column is present on both fresh and migrated paths.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_txn_recurring ON txn(recurring_series_id) WHERE recurring_series_id IS NOT NULL"
        )
        # Same deferral again: import_batch.connection_id only exists after migration v21 on a pre-v21
        # database, so its index is created here (after run_migrations) rather than in the baseline schema
        # script, where it would reference a not-yet-existing column on an in-place upgrade.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_import_batch_connection ON import_batch(connection_id)"
        )
        # Same deferral as idx_txn_needs_review: txn.is_split is only added by its migration on an
        # existing database. Partial, because only a small minority of rows carry the flag and every
        # reader asks the same question — which of these rows are split (`split_txn_ids`, the bulk and
        # rule-apply guards).
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_txn_is_split ON txn(is_split) WHERE is_split = 1"
        )
        # Every expansion of a split reaches its parts through txn_id. Deliberately *not* unique on
        # (txn_id, category_id): a split records the items a payment covered, and two of them may
        # classify into the same category — two records from one order are two purchases, and folding
        # them together would throw away the per-item detail the split exists to hold.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_split_txn ON txn_split(txn_id)")
        # Same deferral as the indexes above: `document` only exists after its migration on an existing
        # database. Every read reaches a transaction's documents through txn_id — the detail panel's
        # list, and the indicator the ledger draws — and deliberately *not* unique, since a transaction
        # may carry several.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_document_txn ON document(txn_id)")
        # Same deferral as the indexes above: import_batch_duplicate.review_substate is only added by
        # migration v61 on an existing database. Partial, because the card's count asks only for the rows
        # still wanting a look — a handful against a table that reaches tens of thousands of settled
        # rejections on a real ledger.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_import_batch_duplicate_review"
            " ON import_batch_duplicate(batch_id) WHERE review_substate IS NOT NULL AND reviewed_at IS NULL"
        )
        # The import history's duplicate counts per card, taken in one grouped pass over the whole history
        # (`_history_card_counts`), and the removed-duplicates count of one card. Partial, so the pass reads
        # only rows that ever matched a duplicate rather than every imported row; its needs-review
        # counterpart is served by idx_txn_needs_review above.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_txn_batch_suspect"
            " ON txn(import_batch_id) WHERE suspect_duplicate_of IS NOT NULL"
        )
        _create_recon_epoch_triggers(conn)
        _bump_recon_epoch(conn)
        _create_epoch_triggers(conn, "ledger_epoch", _LEDGER_EPOCH_SOURCE_TABLES)
        # Once per start as well: a database swapped in from a backup can hold any value, including the
        # one a client last saw, and the cost is one reload on each client's next return.
        _bump_epoch(conn, "ledger_epoch")
        _create_rule_reach_epoch_triggers(conn)
        # Once per start, for the reason `_bump_recon_epoch` gives: a cached reach is stamped only with
        # the data it came from, so a start is what keeps one from outliving the code that computed it.
        _bump_epoch(conn, RULE_REACH_EPOCH_KEY)
        _create_purchase_link_prune_trigger(conn)
        _create_refund_follow_trigger(conn)
        _create_document_search_index(conn)
        ensure_shared_owner(conn)
    # v72 deletes most of what the duplicate reports held (39 MB of an 88 MB file, measured), and SQLite
    # keeps freed pages for reuse rather than returning them. Compacted once, on the upgrade that crossed
    # it, so the file shrinks when the data did; outside the block because VACUUM cannot run inside the
    # transaction the migrations ran in.
    if migrated_from is not None and migrated_from < 72:
        compact_database(resolved_path, reason="upgrade across v72")
    else:
        # Whatever a deletion path that does not compact left behind, given back while nothing else
        # holds the database.
        compact_if_worthwhile(resolved_path, reason="startup")


# The reconciliation reports' attention counts (Amazon's per import batch, the PayPal reconciliation over the
# whole ledger) are surfaced in the import history and the Tasks nag — both read paths, hit often.
# Computing one runs the whole report, so it is cached and recomputed lazily only when stale (see
# services/reconciliation_attention.py). "Stale" is a single monotonic epoch in db_meta ('recon_epoch'):
# any write to a table a report reads bumps it, and a count stamped with an older epoch is recomputed on the
# next read. Every table the PayPal review's buckets depend on (txn, txn_link and its members, account) is
# already here.
#
# These are triggers, not Python bump calls at each mutation, on purpose: the charge-affecting writes are
# scattered across many endpoints (every transaction edit, link/unlink, account merge/detach, funding-map
# change, "not duplicates" assertion), and a single missed site would silently show a stale count — the bug
# a persisted cache is most prone to. A trigger on each source table makes a miss impossible. Over-
# invalidation (e.g. a category or tag edit that can't change the count still touches `txn`) is harmless:
# it only forces one recompute on the next read. The accessor's own cache write targets import_batch, which
# has no trigger, so there is no feedback loop.
_RECON_EPOCH_SOURCE_TABLES = {
    "txn":                    ("INSERT", "UPDATE", "DELETE"),
    "txn_link":               ("INSERT", "UPDATE", "DELETE"),
    "txn_link_member":        ("INSERT", "UPDATE", "DELETE"),
    "account":                ("INSERT", "UPDATE", "DELETE"),
    "amazon_funding_map":     ("INSERT", "UPDATE", "DELETE"),
    "amazon_charge_distinct": ("INSERT", "DELETE"),
    "amazon_charge_reviewed": ("INSERT", "DELETE"),
}


def _create_epoch_triggers(conn: sqlite3.Connection, key: str, tables: dict) -> None:
    """Create (idempotently) the triggers that bump db_meta `key` on each listed write to each table."""
    for table, events in tables.items():
        for event in events:
            conn.execute(f"""
                CREATE TRIGGER IF NOT EXISTS trg_{key}_{table}_{event.lower()}
                AFTER {event} ON {table}
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('{key}', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END
            """)


def _bump_epoch(conn: sqlite3.Connection, key: str) -> None:
    conn.execute(
        f"""INSERT INTO db_meta (key, value) VALUES ('{key}', 1)
           ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1"""
    )


def _create_recon_epoch_triggers(conn: sqlite3.Connection) -> None:
    """Create (idempotently) the triggers that bump db_meta 'recon_epoch' on any write to a table a
    reconciliation report reads. Runs after run_migrations so every referenced table — including the ones a
    migration adds (amazon_funding_map, amazon_charge_distinct, amazon_charge_reviewed) — and db_meta exist
    on both fresh and migrated databases."""
    _create_epoch_triggers(conn, "recon_epoch", _RECON_EPOCH_SOURCE_TABLES)


def _bump_recon_epoch(conn: sqlite3.Connection) -> None:
    """Make every cached reconciliation count stale, once per start. A cache is stamped only with the data
    it was computed from, not the code that computed it, so without this a value cached by an earlier
    version — in a shape or with a meaning that has since changed — would be served to the new code until
    the next data write. New code only runs after a start, so a cache can never outlive the code that
    wrote it; the cost is one recompute of each count on its next read."""
    _bump_epoch(conn, "recon_epoch")


# Whether the ledger a page shows may have changed since a client last looked: one more monotonic epoch in
# db_meta ('ledger_epoch'), bumped by trigger on any write to a table the Transactions, Dashboard or
# Recurring pages read. A client left in the background compares it on its return and reloads those pages
# only when it moved, which is how an edit made on another device reaches a page already open. Triggers for
# the reason the recon epoch gives: writes are scattered and one missed site would leave a page stale.
#
# Kept apart from 'recon_epoch' because the two invalidate different things. That epoch forces the
# reconciliation reports to be recomputed, which is costly, so it watches only what they read; this one
# costs a client one re-query, so it watches everything those pages display — tags, splits, category and
# tag names, recurring series. Each bump is a row update inside the write that caused it, never a commit
# of its own.
_LEDGER_EPOCH_SOURCE_TABLES = {
    table: ("INSERT", "UPDATE", "DELETE")
    for table in (
        "txn", "txn_tag", "txn_split", "txn_link", "txn_link_member",
        "account", "account_tag", "category", "category_tag", "tag", "owner",
        "recurring_series", "recurring_membership_override", "recurring_signal_dismissal",
        "transfer_pair_decision", "rule_alert_hit",
    )
}


# Whose transactions each rule reaches (`services/rule_owner_reach.py`) is a scan of the whole ledger, so
# it is cached and recomputed only when one more epoch ('rule_reach_epoch') has moved. It watches only
# what that answer reads: the rules, the account fields a rule's scope and a row's owner come from, and
# the transaction fields the matcher compares. Categorizing or tagging a row, the edits made most often,
# leave it alone. The column-scoped triggers are dropped and created again at each start, so a change to
# a column list here takes effect, which `CREATE TRIGGER IF NOT EXISTS` alone would not do.
RULE_REACH_EPOCH_KEY = "rule_reach_epoch"
_RULE_REACH_EPOCH_SOURCES = {
    "category_rule": None,
    "account": ("owner_id", "parent_account_id", "type"),
    "txn": ("merchant_name", "raw_name", "amount", "owner_id", "account_id", "trashed_at", "import_evidence_json"),
}


def _create_rule_reach_epoch_triggers(conn: sqlite3.Connection) -> None:
    key = RULE_REACH_EPOCH_KEY
    for table, columns in _RULE_REACH_EPOCH_SOURCES.items():
        for event in ("INSERT", "UPDATE", "DELETE"):
            name = f"trg_{key}_{table}_{event.lower()}"
            on = f"UPDATE OF {', '.join(columns)}" if event == "UPDATE" and columns else event
            conn.execute(f"DROP TRIGGER IF EXISTS {name}")
            conn.execute(f"""
                CREATE TRIGGER {name}
                AFTER {on} ON {table}
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('{key}', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END
            """)


def db_meta_epoch(conn: sqlite3.Connection, key: str) -> int:
    """An epoch kept in db_meta; absent is 0."""
    row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (key,)).fetchone()
    try:
        return int(row["value"]) if row else 0
    except (TypeError, ValueError):
        return 0


def ledger_epoch(conn: sqlite3.Connection) -> int:
    """The current ledger epoch; absent is 0."""
    row = conn.execute("SELECT value FROM db_meta WHERE key = 'ledger_epoch'").fetchone()
    try:
        return int(row["value"]) if row else 0
    except (TypeError, ValueError):
        return 0


# A `txn_link` row has no foreign key to `txn` — deliberately, since a link may outlive the rows it
# joined and the owning feature is what knows whether it should. For a **multi-payment purchase** the
# answer is unambiguous: a purchase whose payments have all been hard-deleted is not a purchase any
# more, and nothing in the app will ever show it again. Left alone it is an invisible row that
# accumulates forever.
#
# A trigger rather than a prune call at each deletion site, for the reason the recon-epoch triggers
# above give: transactions are hard-deleted from five scattered places (empty-trash, batch undo, account
# merge, an Amazon order's removal, a restore's wipe) and a single missed one would leak silently. The
# `WHEN` clause keeps it to this feature's own links — the other kinds' owners have their own reversal
# discipline and must not have rows swept out from under a multi-step operation.
def _create_purchase_link_prune_trigger(conn: sqlite3.Connection) -> None:
    """Create (idempotently) the trigger that drops a purchase link once its last payment is gone.
    Runs after run_migrations so both tables exist on fresh and migrated databases alike."""
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS trg_purchase_link_prune
        AFTER DELETE ON txn_link_member
        WHEN (SELECT kind FROM txn_link WHERE id = OLD.link_id) = 'purchase'
         AND NOT EXISTS (SELECT 1 FROM txn_link_member WHERE link_id = OLD.link_id)
        BEGIN
            DELETE FROM txn_link WHERE id = OLD.link_id;
        END
    """)

# A refund paired with the payment it returns carries that payment's category, and must keep carrying it
# when the payment is recategorized (services/refund_links.py). A trigger rather than a call at each write
# site, for the reason the triggers above give: a transaction's category is written from many places —
# a hand edit, bulk edit, every rule apply, Run categorization, an import's file labels, a split undone — and a missed one would leave the refund quietly counting against a category
# its payment has left. Only a refund still following (`category_source = 'refund'`) moves, and not while
# the payment is split, when its `category_id` is only the value the allocations replaced.
def _create_refund_follow_trigger(conn: sqlite3.Connection) -> None:
    """Create (idempotently) the trigger that moves a following refund with its payment's category. Runs
    after run_migrations so every table it reads exists on fresh and migrated databases alike."""
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS trg_refund_follows_payment
        AFTER UPDATE OF category_id ON txn
        WHEN NEW.category_id IS NOT OLD.category_id AND NEW.is_split = 0
        BEGIN
            UPDATE txn SET category_id = NEW.category_id
            WHERE  category_source = 'refund'
              AND  id IN (SELECT r.txn_id
                          FROM   txn_link_member p
                          JOIN   txn_link l ON l.id = p.link_id AND l.kind = 'refund'
                          JOIN   txn_link_member r ON r.link_id = p.link_id AND r.role = 'refund'
                          WHERE  p.txn_id = NEW.id AND p.role = 'payment');
        END
    """)

# Full-text index over the text pulled out of attached documents, reached from the Transactions page's
# quick filter as `doc:<terms>`. FTS5 rather than a LIKE over `document.text`: a substring scan grows with
# the stored text and is the wrong instrument for prose anyway, where word matching is what someone means
# by searching a receipt. FTS5 ships inside SQLite, so this costs no dependency.
#
# **External content** (`content='document'`) — the index stores terms, not a second copy of the text, so
# a 200 KB invoice is not held twice.
#
# **Maintained by triggers, and that is not a style preference.** A document row is most often removed by
# `ON DELETE CASCADE` when its transaction is purged, and a restore rebuilds the whole table by streaming
# rows in — neither of which is a place application code could hook even if every endpoint remembered to.
# An index that missed those would keep returning transactions that no longer exist, which is worse than
# no search at all. Triggers make a miss impossible, the same reasoning the recon-epoch triggers above
# record. It also means the restore needs no FTS awareness whatsoever: rows land, the index follows.
#
# The index is derived state and is deliberately **not** backed up — `test_backup_restore.py` excludes it
# and its shadow tables for that reason. It is rebuilt from `document.text` whenever it is created here,
# so an install that somehow lost it gets a correct index on the next start rather than a silent gap.
def _create_document_search_index(conn: sqlite3.Connection) -> None:
    """Create (idempotently) the document text index and the triggers that keep it in step with
    `document`. Runs after run_migrations so the table exists on both fresh and migrated databases."""
    existed = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_fts'"
    ).fetchone()
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS document_fts "
        "USING fts5(text, content='document', content_rowid='rowid')"
    )
    # The 'delete' command is how an external-content table is told a row is going away; it needs the
    # *old* text to remove the right terms, which is why the update trigger deletes before inserting.
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS trg_document_fts_insert AFTER INSERT ON document BEGIN
            INSERT INTO document_fts (rowid, text) VALUES (new.rowid, new.text);
        END
    """)
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS trg_document_fts_delete AFTER DELETE ON document BEGIN
            INSERT INTO document_fts (document_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END
    """)
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS trg_document_fts_update AFTER UPDATE ON document BEGIN
            INSERT INTO document_fts (document_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
            INSERT INTO document_fts (rowid, text) VALUES (new.rowid, new.text);
        END
    """)
    if not existed:
        # Populate from whatever `document` already holds. Empty on a fresh install and on any database
        # that predates documents; the case this covers is an index rebuilt after being lost.
        conn.execute("INSERT INTO document_fts (document_fts) VALUES ('rebuild')")


def _seed_default_categories(conn: sqlite3.Connection, *, include_leaves: bool = False):
    # Seeding model: the top-level reporting groups (plus the system Unassigned group) are seeded for
    # every tenant so the import "Group Imported Categories" workspace always has visible buckets to
    # drop imported labels into — even for a user who brings their own categories and never wants ours.
    # The starter *leaf* categories are an explicit opt-in (include_leaves=True), used by the onboarding
    # "Add starter categories" action, its Categories-page equivalent, and the demo dataset. Keeping
    # leaves opt-in means a bring-your-own user's tree stays free of categories they didn't choose, and
    # — since the built-in rules target these leaves by name — no data-mutating starter rules can exist
    # for them either.
    import uuid

    from backend.services.excluded_categories import (
        REIMBURSABLE_GROUP,
        REIMBURSABLE_SYSTEM_KEY,
        TRANSFERS_GROUP,
        TRANSFERS_SYSTEM_KEY,
    )

    category_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(category)").fetchall()
    }
    has_system_key = "system_key" in category_columns

    def upsert_cat(name, parent_id=None, category_type=None, exclude_from_totals=0, system_key=None):
        if parent_id is None:
            if has_system_key:
                row = conn.execute(
                    """
                    SELECT id
                    FROM category
                    WHERE (
                        (? IS NOT NULL AND system_key = ?)
                        OR (? IS NULL AND name = ? AND parent_id IS NULL)
                    )
                    LIMIT 1
                    """,
                    (system_key, system_key, system_key, name),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT id FROM category WHERE name = ? AND parent_id IS NULL",
                    (name,),
                ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM category WHERE name = ? AND parent_id = ?",
                (name, parent_id),
            ).fetchone()
        if row:
            if has_system_key:
                conn.execute(
                    """
                    UPDATE category
                    SET category_type = COALESCE(?, category_type),
                        exclude_from_totals = COALESCE(?, exclude_from_totals),
                        system_key = COALESCE(?, system_key)
                    WHERE id = ?
                    """,
                    (category_type, exclude_from_totals, system_key, row["id"]),
                )
            else:
                conn.execute(
                    """
                    UPDATE category
                    SET category_type = COALESCE(?, category_type),
                        exclude_from_totals = COALESCE(?, exclude_from_totals)
                    WHERE id = ?
                    """,
                    (category_type, exclude_from_totals, row["id"]),
                )
            return row["id"]
        new_id = str(uuid.uuid4())
        if has_system_key:
            conn.execute(
                """
                INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, system_key)
                VALUES (?,?,?,?,?,?)
                """,
                (new_id, parent_id, name, category_type, exclude_from_totals, system_key),
            )
        else:
            conn.execute(
                """
                INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals)
                VALUES (?,?,?,?,?)
                """,
                (new_id, parent_id, name, category_type, exclude_from_totals),
            )
        return new_id

    income_group  = upsert_cat("Income", category_type="income")
    upsert_cat("Unassigned", category_type=None, system_key="unassigned")
    finance       = upsert_cat("Finance", category_type="expense")
    food          = upsert_cat("Food & Drink", category_type="expense")
    gifts         = upsert_cat("Gifts & Donations", category_type="expense")
    health        = upsert_cat("Health & Fitness", category_type="expense")
    household     = upsert_cat("Household", category_type="expense")
    medical       = upsert_cat("Medical", category_type="expense")
    other         = upsert_cat("Miscellaneous", category_type="expense")
    shopping      = upsert_cat("Shopping", category_type="expense")
    entertainment = upsert_cat("Entertainment", category_type="expense")
    transport     = upsert_cat("Auto & Transportation", category_type="expense")
    travel        = upsert_cat("Vacation & Travel", category_type="expense")
    utilities     = upsert_cat("Utilities", category_type="expense")
    # Keyed like the reimbursable group, and stamped the same way for the same reason: adoption. Without
    # it, upsert_cat matches a keyed group by key alone and would build a *second* top-level "Transfers"
    # beside the one already holding the user's money-movement leaves.
    if has_system_key:
        conn.execute(
            """UPDATE category SET system_key = ?
               WHERE name = ? AND parent_id IS NULL AND system_key IS NULL""",
            (TRANSFERS_SYSTEM_KEY, TRANSFERS_GROUP),
        )
    transfers     = upsert_cat(
        TRANSFERS_GROUP, category_type="expense", exclude_from_totals=1, system_key=TRANSFERS_SYSTEM_KEY
    )
    # The reimbursable-expenses holding group. Seeded for everyone, like the other top-level reporting
    # groups; its leaves are created on first use (services/excluded_categories.py), so someone who
    # never records a reimbursable is left with one empty group and no stray category.
    #
    # The stamp below adopts a same-named group the user built by hand before this existed. Without it
    # the tree would gain a *second* top-level "Reimbursable", because upsert_cat matches a keyed group
    # by key alone and would not see theirs. Adoption then asserts exclude_from_totals the same way
    # seeding does for every other group that is already present under its own name.
    if has_system_key:
        conn.execute(
            """UPDATE category SET system_key = ?
               WHERE name = ? AND parent_id IS NULL AND system_key IS NULL""",
            (REIMBURSABLE_SYSTEM_KEY, REIMBURSABLE_GROUP),
        )
    upsert_cat(
        REIMBURSABLE_GROUP,
        category_type="expense",
        exclude_from_totals=1,
        system_key=REIMBURSABLE_SYSTEM_KEY,
    )

    if not include_leaves:
        return

    upsert_cat("Fitness Classes", health)
    upsert_cat("Gym Membership", health)

    upsert_cat("Doctor", medical)
    # Canonical name is "Medical Services", not "Medical": a leaf named "Medical" would collide with the
    # "Medical" group and make rule suggestions and category pickers ambiguous.
    upsert_cat("Medical Services", medical)
    upsert_cat("Dental", medical)
    upsert_cat("Pharmacy", medical)
    upsert_cat("Vision", medical)

    upsert_cat("Alcohol", food)
    upsert_cat("Coffee & Drinks", food)
    upsert_cat("Dining Out", food)
    upsert_cat("Groceries", food)
    upsert_cat("Take-out", food)


    upsert_cat("Home Improvement", household)
    upsert_cat("Home Insurance", household)
    upsert_cat("Home Repairs", household)
    upsert_cat("Property Tax", household)
    upsert_cat("Rent & Mortgage", household)
    upsert_cat("Household Supplies", household)

    upsert_cat("Electricity", utilities)
    upsert_cat("Natural Gas", utilities)
    upsert_cat("Internet", utilities)
    upsert_cat("Phone", utilities)
    upsert_cat("Water", utilities)

    upsert_cat("Auto Insurance", transport)
    upsert_cat("Gas", transport)
    upsert_cat("Parking & Tolls", transport)
    upsert_cat("Public Transit", transport)
    upsert_cat("Rideshare", transport)

    upsert_cat("Hotel", travel)
    upsert_cat("Air Travel", travel)
    upsert_cat("Rental Car", travel)
    upsert_cat("Vacation Food", travel)
    upsert_cat("Vacation Transportation", travel)

    upsert_cat("Clothing", shopping)
    upsert_cat("Electronics", shopping)
    upsert_cat("Online Shopping", shopping)

    upsert_cat("Hobbies", entertainment)
    upsert_cat("Movies & Events", entertainment)
    upsert_cat("Streaming Services", entertainment)

    upsert_cat("Fees & Charges", finance)
    upsert_cat("ATM Fees", finance)

    upsert_cat("Credit Card Payment", transfers)
    upsert_cat("Bank Transfer", transfers)

    upsert_cat("Charity", gifts)
    upsert_cat("Charity (non-deductible)", gifts)
    upsert_cat("Gifts Given", gifts)

    upsert_cat("Other", other)

    upsert_cat("Salary", income_group)
    upsert_cat("Freelance", income_group)
    upsert_cat("Gifts Received", income_group)
    upsert_cat("Investment", income_group)
    upsert_cat("Refund", income_group)
    upsert_cat("Interest Income", income_group)
    upsert_cat("Other Income", income_group)
