# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Primary application database: schema, seeding, and migrations for each tenant DB.

This file owns the durable model the routers and services share. Its key guarantees
are that fresh databases are created directly in the current shape, existing ones
advance through ordered migrations, and core invariants like leaf-only transaction
categories and the built-in shared owner are re-established on startup.
"""

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from backend.app_logging import log_info

DB_PATH = os.getenv("DB_PATH", "fintrack-data.db")
_current_db_path: ContextVar[str | None] = ContextVar("fintrack_current_db_path", default=None)
SHARED_OWNER_ID = "shared-owner"
SHARED_OWNER_NAME = "shared"
SHARED_OWNER_COLOR = "#6366f1"


def _normalize_db_path(db_path: str | None = None) -> str:
    path = db_path or _current_db_path.get() or DB_PATH
    return str(Path(path))


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
        "INSERT INTO owner (id, name, color) VALUES (?, ?, ?)",
        (SHARED_OWNER_ID, SHARED_OWNER_NAME, SHARED_OWNER_COLOR),
    )
    return SHARED_OWNER_ID


@contextmanager
def get_db(db_path: str | None = None):
    resolved_path = _normalize_db_path(db_path)
    Path(resolved_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(resolved_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# Migrations are additive startup upgrades for existing databases only; fresh installs
# are created directly at `CURRENT_VERSION` and should not replay the migration chain.

CURRENT_VERSION = 30

MIGRATIONS = {}


def migration(version):
    def decorator(fn):
        MIGRATIONS[version] = fn
        return fn
    return decorator


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
    instance_id = str(uuid.uuid4())
    conn.execute(
        "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('instance_id', ?)",
        (instance_id,),
    )
    return instance_id


def run_migrations(conn):
    current = get_db_version(conn)
    if current >= CURRENT_VERSION:
        return
    for version in sorted(MIGRATIONS):
        if version > current:
            log_info(f"[db] applying migration v{version}...")
            MIGRATIONS[version](conn)
            set_db_version(conn, version)
    log_info(f"[db] database is now at version {CURRENT_VERSION}")


def _normalize_category_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().split()).casefold()


def _is_uncategorized_import_placeholder(value: str | None) -> bool:
    return _normalize_category_name(value) in {"uncategorized", "uncategorised", "unassigned"}


def _claim_unique_category_name(base_name: str, used_names: set[str]) -> str:
    candidate = " ".join(str(base_name or "").strip().split())
    suffix = 2
    while _normalize_category_name(candidate) in used_names:
        candidate = f"{base_name} {suffix}"
        suffix += 1
    used_names.add(_normalize_category_name(candidate))
    return candidate


def _load_json_object(raw):
    if isinstance(raw, dict):
        return dict(raw)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    return dict(parsed) if isinstance(parsed, dict) else {}


def _rename_imported_category_metadata(payload):
    next_payload = dict(payload or {})

    if "categorization_is_clean" in next_payload and "use_imported_categories" not in next_payload:
        next_payload["use_imported_categories"] = bool(next_payload.pop("categorization_is_clean"))
    if "trust_scope_mode" in next_payload and "imported_category_scope_mode" not in next_payload:
        next_payload["imported_category_scope_mode"] = next_payload.pop("trust_scope_mode")
    if "trusted_owner_ids" in next_payload and "imported_category_owner_ids" not in next_payload:
        next_payload["imported_category_owner_ids"] = next_payload.pop("trusted_owner_ids")
    if "trusted_unassigned_account_tokens" in next_payload and "imported_category_unassigned_account_tokens" not in next_payload:
        next_payload["imported_category_unassigned_account_tokens"] = next_payload.pop("trusted_unassigned_account_tokens")

    if isinstance(next_payload.get("column_map"), dict):
        column_map = dict(next_payload["column_map"])
        if "trusted_categorization" in column_map and "imported_category_settings" not in column_map:
            column_map["imported_category_settings"] = column_map.pop("trusted_categorization")
        next_payload["column_map"] = column_map

    if "trusted_categorization" in next_payload and "imported_category_settings" not in next_payload:
        next_payload["imported_category_settings"] = next_payload.pop("trusted_categorization")

    return next_payload


def _dedupe_category_names(conn: sqlite3.Connection):
    rows = conn.execute(
        """
        SELECT
            c.id,
            c.parent_id,
            c.name,
            COALESCE(c.category_type, CASE WHEN c.parent_id IS NULL THEN 'expense' END) AS category_type,
            p.name AS parent_name
        FROM category c
        LEFT JOIN category p ON p.id = c.parent_id
        ORDER BY
            CASE WHEN c.parent_id IS NULL THEN 0 ELSE 1 END,
            c.sort_order,
            LOWER(c.name),
            c.name,
            c.id
        """
    ).fetchall()

    used_names: set[str] = set()
    for row in rows:
        normalized_name = _normalize_category_name(row["name"])
        if normalized_name and normalized_name not in used_names:
            used_names.add(normalized_name)
            continue

        original_name = " ".join(str(row["name"] or "").strip().split())
        parent_name = " ".join(str(row["parent_name"] or "").strip().split())
        candidate_bases: list[str] = []
        if row["parent_id"]:
            if _normalize_category_name(parent_name) and _normalize_category_name(parent_name) != normalized_name:
                candidate_bases.append(f"{original_name} ({parent_name})")
            else:
                candidate_bases.append(f"Other {original_name}")
                candidate_bases.append(f"{original_name} (subcategory)")
        else:
            type_label = "income" if row["category_type"] == "income" else "expense"
            candidate_bases.append(f"{original_name} ({type_label})")
            candidate_bases.append(f"{original_name} (group)")

        renamed = None
        for base_name in candidate_bases:
            if not _normalize_category_name(base_name):
                continue
            renamed = _claim_unique_category_name(base_name, used_names)
            break
        if renamed is None:
            renamed = _claim_unique_category_name(original_name, used_names)

        conn.execute(
            "UPDATE category SET name = ? WHERE id = ?",
            (renamed, row["id"]),
        )


@migration(1)
def m1_baseline(conn):
    pass


@migration(2)
def m2_import_batch_duplicates(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS import_batch_duplicate (
            batch_id                  TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
            row_number                INTEGER NOT NULL,
            reason                    TEXT NOT NULL,
            values_json               TEXT,
            matched_transaction_json  TEXT,
            txn_payload_json          TEXT,
            PRIMARY KEY (batch_id, row_number)
        );
        CREATE INDEX IF NOT EXISTS idx_import_batch_duplicate_batch ON import_batch_duplicate(batch_id);
    """)


@migration(3)
def m3_drop_category_color(conn):
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(category)").fetchall()
    }
    if "color" in columns:
        conn.execute("ALTER TABLE category DROP COLUMN color")


@migration(4)
def m4_profile_template_file_metadata(conn):
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(csv_import_profile)").fetchall()
    }
    if "template_filename" not in columns:
        conn.execute("ALTER TABLE csv_import_profile ADD COLUMN template_filename TEXT")
    if "template_file_hash" not in columns:
        conn.execute("ALTER TABLE csv_import_profile ADD COLUMN template_file_hash TEXT")


@migration(5)
def m5_account_display_name_and_trash(conn):
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(account)").fetchall()
    }
    if "display_name" not in columns:
        conn.execute("ALTER TABLE account ADD COLUMN display_name TEXT")
    if "parent_account_id" not in columns:
        conn.execute("ALTER TABLE account ADD COLUMN parent_account_id TEXT REFERENCES account(id) ON DELETE SET NULL")
    if "trashed_at" not in columns:
        conn.execute("ALTER TABLE account ADD COLUMN trashed_at TEXT")
    conn.execute("UPDATE account SET display_name = name WHERE display_name IS NULL OR TRIM(display_name) = ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_account_parent ON account(parent_account_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_account_trashed ON account(trashed_at)")


@migration(6)
def m6_import_learning_state_and_unassigned_group(conn):
    category_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(category)").fetchall()
    }
    if "system_key" not in category_columns:
        conn.execute("ALTER TABLE category ADD COLUMN system_key TEXT")
    if "import_source_batch_id" not in category_columns:
        conn.execute("ALTER TABLE category ADD COLUMN import_source_batch_id TEXT REFERENCES import_batch(id) ON DELETE SET NULL")

    profile_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(csv_import_profile)").fetchall()
    }
    if "categorization_is_clean" not in profile_columns:
        conn.execute("ALTER TABLE csv_import_profile ADD COLUMN categorization_is_clean INTEGER NOT NULL DEFAULT 0")

    batch_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(import_batch)").fetchall()
    }
    if "categorization_is_clean" not in batch_columns:
        conn.execute("ALTER TABLE import_batch ADD COLUMN categorization_is_clean INTEGER NOT NULL DEFAULT 0")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS import_workflow_state (
            key          TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL DEFAULT '{}'
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category_system_key ON category(system_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category_import_source_batch ON category(import_source_batch_id)")


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


@migration(7)
def m7_alphabetize_top_level_category_groups(conn):
    # The persisted tree order is shared across category pickers and the editor, so
    # older databases need a one-time normalization to stop picker-created groups from
    # sitting permanently after the seeded defaults.
    _alphabetize_top_level_category_groups(conn)


@migration(8)
def m8_dedupe_category_names(conn):
    # Category and group names now have to be globally unique so pickers, import review,
    # and rule suggestions can resolve a label to exactly one branch.
    _dedupe_category_names(conn)


@migration(9)
def m9_transaction_category_source(conn):
    txn_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(txn)").fetchall()
    }
    if "category_source" not in txn_columns:
        conn.execute("ALTER TABLE txn ADD COLUMN category_source TEXT")

    # Older databases did not distinguish imported, manual, and rule-owned categories.
    # Backfill enough source context for rerun protection and batch undo to behave
    # sensibly, then let newer writes keep the field precise.
    conn.execute(
        """
        UPDATE txn
        SET    category_source = 'manual'
        WHERE  category_source IS NULL
          AND  category_overridden = 1
        """
    )
    conn.execute(
        """
        UPDATE txn
        SET    category_source = 'rule'
        WHERE  category_source IS NULL
          AND  category_overridden = 0
          AND  category_id IS NOT NULL
        """
    )


@migration(10)
def m10_imported_category_terminology(conn):
    profile_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(csv_import_profile)").fetchall()
    }
    if "categorization_is_clean" in profile_columns and "use_imported_categories" not in profile_columns:
        conn.execute(
            "ALTER TABLE csv_import_profile RENAME COLUMN categorization_is_clean TO use_imported_categories"
        )

    batch_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(import_batch)").fetchall()
    }
    if "categorization_is_clean" in batch_columns and "use_imported_categories" not in batch_columns:
        conn.execute(
            "ALTER TABLE import_batch RENAME COLUMN categorization_is_clean TO use_imported_categories"
        )

    profile_rows = conn.execute(
        "SELECT id, column_map FROM csv_import_profile"
    ).fetchall()
    for row in profile_rows:
        column_map = _rename_imported_category_metadata(_load_json_object(row["column_map"]))
        conn.execute(
            "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
            (json.dumps(column_map), row["id"]),
        )

    batch_rows = conn.execute(
        "SELECT id, config_snapshot FROM import_batch"
    ).fetchall()
    for row in batch_rows:
        snapshot = _rename_imported_category_metadata(_load_json_object(row["config_snapshot"]))
        conn.execute(
            "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
            (json.dumps(snapshot), row["id"]),
        )


@migration(11)
def m11_transaction_import_evidence(conn):
    txn_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(txn)").fetchall()
    }
    if "import_evidence_json" not in txn_columns:
        conn.execute("ALTER TABLE txn ADD COLUMN import_evidence_json TEXT")


@migration(12)
def m12_import_batch_account_coverage(conn):
    batch_account_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(import_batch_account)").fetchall()
    }
    if "coverage_start_date" not in batch_account_columns:
        conn.execute("ALTER TABLE import_batch_account ADD COLUMN coverage_start_date TEXT")
    if "coverage_end_date" not in batch_account_columns:
        conn.execute("ALTER TABLE import_batch_account ADD COLUMN coverage_end_date TEXT")
    if "terminal_date" not in batch_account_columns:
        conn.execute("ALTER TABLE import_batch_account ADD COLUMN terminal_date TEXT")


@migration(13)
def m13_import_batch_account_terminal_date(conn):
    batch_account_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(import_batch_account)").fetchall()
    }
    if "terminal_date" not in batch_account_columns:
        conn.execute("ALTER TABLE import_batch_account ADD COLUMN terminal_date TEXT")


@migration(14)
def m14_uncategorized_import_placeholders(conn):
    placeholder_category_ids = [
        row["id"]
        for row in conn.execute(
            """
            SELECT c.id, c.name
            FROM   category c
            JOIN   category p ON p.id = c.parent_id
            WHERE  p.system_key = ?
            """,
            ("unassigned",),
        ).fetchall()
        if _is_uncategorized_import_placeholder(row["name"])
    ]

    if placeholder_category_ids:
        placeholders = ",".join("?" for _ in placeholder_category_ids)
        conn.execute(
            f"""
            UPDATE txn
            SET    category_id = NULL,
                   category_overridden = 0,
                   category_source = NULL
            WHERE  category_id IN ({placeholders})
            """,
            placeholder_category_ids,
        )
        conn.execute(
            f"DELETE FROM category WHERE id IN ({placeholders})",
            placeholder_category_ids,
        )

    placeholder_txn_ids = [
        row["id"]
        for row in conn.execute(
            "SELECT id, imported_category FROM txn WHERE imported_category IS NOT NULL"
        ).fetchall()
        if _is_uncategorized_import_placeholder(row["imported_category"])
    ]
    if placeholder_txn_ids:
        placeholders = ",".join("?" for _ in placeholder_txn_ids)
        conn.execute(
            f"UPDATE txn SET imported_category = NULL WHERE id IN ({placeholders})",
            placeholder_txn_ids,
        )


@migration(15)
def m15_rule_debit_credit_scope(conn):
    rule_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(category_rule)").fetchall()
    }
    if "debit_credit" not in rule_columns:
        conn.execute("ALTER TABLE category_rule ADD COLUMN debit_credit TEXT NOT NULL DEFAULT 'both'")
    conn.execute(
        """
        UPDATE category_rule
        SET debit_credit = 'both'
        WHERE debit_credit IS NULL
           OR TRIM(debit_credit) = ''
        """
    )


@migration(16)
def m16_transaction_tags(conn):
    rule_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(category_rule)").fetchall()
    }
    category_id_info = next(
        (row for row in conn.execute("PRAGMA table_info(category_rule)").fetchall() if row["name"] == "category_id"),
        None,
    )
    category_id_is_not_null = bool(category_id_info and category_id_info["notnull"])

    if "category_id" in rule_columns and category_id_is_not_null:
        # Tags can be rule actions on their own, so older databases need the
        # rules table rebuilt with a nullable category_id before tag-only rules can be saved.
        conn.executescript(
            """
            ALTER TABLE category_rule RENAME TO category_rule_legacy_tags;

            CREATE TABLE category_rule (
                id           TEXT PRIMARY KEY,
                category_id  TEXT REFERENCES category(id) ON DELETE CASCADE,
                keyword      TEXT NOT NULL,
                priority     INTEGER NOT NULL DEFAULT 5,
                amount_min   REAL,
                amount_max   REAL,
                debit_credit TEXT NOT NULL DEFAULT 'both',
                clean_name   TEXT,
                owner_id     TEXT REFERENCES owner(id) ON DELETE SET NULL,
                account_id   TEXT REFERENCES account(id) ON DELETE SET NULL
            );

            INSERT INTO category_rule
              (id, category_id, keyword, priority, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id)
            SELECT
              id, category_id, keyword, priority, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id
            FROM category_rule_legacy_tags;

            DROP TABLE category_rule_legacy_tags;
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_category   ON category_rule(category_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_keyword    ON category_rule(keyword)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_account    ON category_rule(account_id)")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tag (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            color      TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_name_unique
        ON tag(LOWER(TRIM(name)))
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rule_tag (
            rule_id TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
            tag_id  TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
            PRIMARY KEY (rule_id, tag_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS txn_tag (
            txn_id        TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
            tag_id        TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
            rule_present  INTEGER NOT NULL DEFAULT 0,
            manual_state  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (txn_id, tag_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_tag_tag ON rule_tag(tag_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_tag_tag ON txn_tag(tag_id)")


@migration(19)
def m19_drop_category_owner_id(conn):
    # Category ownership has been replaced by category-level tags (see m18). Drop the
    # now-unused owner_id column so the schema cannot drift back to a dual-ownership
    # model. SQLite 3.35+ supports DROP COLUMN directly.
    cols = conn.execute("PRAGMA table_info(category)").fetchall()
    if any(col["name"] == "owner_id" for col in cols):
        conn.execute("ALTER TABLE category DROP COLUMN owner_id")


@migration(18)
def m18_category_tags(conn):
    # Tags can now be attached to categories (leaves or groups) so transactions
    # inherit additive tags from their leaf category and its parent group. The
    # owner_id column on category stays in place for now; a later migration
    # drops it once the frontend stops referencing it.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS category_tag (
            category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
            tag_id      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
            PRIMARY KEY (category_id, tag_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category_tag_tag ON category_tag(tag_id)")


@migration(23)
def m23_account_pair_distinct(conn):
    """Replaces the "brand-new account" proxy for cross-account suspect detection with explicit
    per-pair user assertions. See `docs/architecture.md` (Dedupe state lifecycle) for the model.

    Two pieces:
      1. New `account_pair_distinct` table — sparse record of which account pairs the user has
         declared distinct via Keep. The cross-account suspect check filters out pairs present
         in this table.
      2. Existing soft-flag suspect reason values (`'import_new_account'`, `'account_merge'`)
         are functionally equivalent in the new model — both signify a cross-account suspect.
         Migrated forward to a single neutral name, `'cross_account'`.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_pair_distinct (
            account_id_low  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
            account_id_high TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
            asserted_at     TEXT NOT NULL,
            PRIMARY KEY (account_id_low, account_id_high),
            CHECK (account_id_low < account_id_high)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_pair_distinct_high ON account_pair_distinct(account_id_high)"
    )
    conn.execute(
        """
        UPDATE txn
        SET    suspect_duplicate_reason = 'cross_account'
        WHERE  suspect_duplicate_reason IN ('import_new_account', 'account_merge')
        """
    )


@migration(28)
def m28_ui_preferences(conn):
    """Non-sensitive UI/layout preferences (page layouts, dashboard tag reports, collapse state,
    import drafts, etc.) move from the control DB into the data DB, keyed by `scope_id` — the
    authenticated user id (auth mode) or the local-preference-profile id (local mode). They belong
    with the data they describe (e.g. tag reports reference tag ids), so a data backup carries them
    and there is no cross-DB/scope plumbing. The control DB keeps only identity/secrets. Existing
    values are relocated lazily on first read (see services/preferences.py); the old control-DB
    pref tables are left in place until that bridge is removed.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ui_preference (
            scope_id   TEXT NOT NULL,
            pref_key   TEXT NOT NULL,
            pref_value TEXT NOT NULL,
            updated_at TEXT,
            PRIMARY KEY (scope_id, pref_key)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ui_preference_scope ON ui_preference(scope_id)")


@migration(30)
def m30_category_import_pending(conn):
    """Distinguish *pending imported* categories (the Group Imported Categories workspace's landing
    spot) from permanent system categories.

    `import_pending = 1` marks an active Unassigned leaf that arrived via import and has not yet left
    the workspace. The workspace's pool/set-aside columns show ONLY these. A category leaves the
    workspace — permanently — when it is organized into a group or deleted (both clear the flag), and
    it is never re-set on recover, so a deleted-then-recovered category, and any user-created
    category, never appear in the workspace. User-created categories default to 0 (not imported).
    Backfill marks existing import-sourced Unassigned leaves as pending so the current workspace
    contents survive the upgrade.
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(category)").fetchall()}
    if "import_pending" not in columns:
        conn.execute("ALTER TABLE category ADD COLUMN import_pending INTEGER NOT NULL DEFAULT 0")
    unassigned = conn.execute(
        "SELECT id FROM category WHERE system_key = 'unassigned'"
    ).fetchone()
    if unassigned:
        conn.execute(
            """
            UPDATE category SET import_pending = 1
            WHERE  parent_id = ?
              AND  is_active = 1
              AND  import_source_batch_id IS NOT NULL
            """,
            (unassigned["id"],),
        )


@migration(29)
def m29_category_set_aside(conn):
    """Set-aside is a parked-but-active state, distinct from deletion.

    A category set aside in the imported-category workspace stays ACTIVE: its transactions keep it
    and new imports of that label still categorize to it. Set-aside only parks the category out of
    the "still needs sorting" pool (set_aside = 1 on an active Unassigned leaf). Deletion
    (is_active = 0) remains the only thing that suppresses a label from future imports. Reactivating
    a deleted category clears set_aside back to 0 so it returns to the pool, not the set-aside list.
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(category)").fetchall()}
    if "set_aside" not in columns:
        conn.execute("ALTER TABLE category ADD COLUMN set_aside INTEGER NOT NULL DEFAULT 0")


@migration(27)
def m27_account_tags(conn):
    """Tags can be attached to accounts, mirroring category tags. A transaction inherits its
    account's tags resolved through the *effective* (top-level) account: a top-level account's
    tags propagate to its own and its child accounts' transactions, while a child account's own
    tags are not consulted while it is merged (they go dormant, and reactivate on detach). See
    docs/data-model.md (Tags) for the effective-account resolution and merge behavior.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_tag (
            account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
            tag_id     TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
            PRIMARY KEY (account_id, tag_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_account_tag_tag ON account_tag(tag_id)")


@migration(26)
def m26_category_is_active(conn):
    """First-class inactive categories.

    A category can be deactivated (soft) by Set aside or Delete instead of being hard-deleted.
    Inactive categories drop out of the active income/expense trees and surface in a separate
    flat "Inactive" recovery list; imports never recreate or reassign an inactive label (a
    matching label imports uncategorized, raw `imported_category` retained). `is_active = 0`
    means deactivated; deactivation NULLs the category's transactions, so an inactive category
    is referentially empty and an active-only default read path is safe. Existing rows backfill
    to active.
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(category)").fetchall()}
    if "is_active" not in columns:
        conn.execute("ALTER TABLE category ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category_active ON category(is_active)")


@migration(25)
def m25_import_batch_duplicate_reviewed_at(conn):
    """Acknowledgment marker for advisory import-time rejections.

    A coverage-window hard-reject that can't point at a specific matching row surfaces in the
    duplicate report as "Rejected · review" — already rejected (never imported), but flagged
    because the system couldn't fully explain the match. `reviewed_at` lets the user mark such a
    row as deliberately reviewed, clearing it from the "needs attention" count without changing
    the rejection. NULL = not yet acknowledged.
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(import_batch_duplicate)").fetchall()}
    if "reviewed_at" not in columns:
        conn.execute("ALTER TABLE import_batch_duplicate ADD COLUMN reviewed_at TEXT")


@migration(24)
def m24_dedupe_resolved_by(conn):
    """Provenance marker on dedupe resolutions so detach can safely auto-restore promoted rows
    without trampling user decisions.

    Values:
      NULL          — row is not in a resolved state (active suspect, or never was a suspect)
      'user'        — the user explicitly resolved this row via the dialog (Reject / Trash)
      'auto_merge'  — promote_in_group_suspects_to_confirmed promoted this row when its
                      cross-account pair was merged together

    On detach, only `'auto_merge'` rows are restored — user decisions are preserved. Pre-existing
    confirmed_duplicate rows have NULL after this migration; the safe interpretation is "treat
    as user" (don't auto-restore). If you need to roll back a specific pre-marker merge, use
    the one-off restore-by-account-pair path (added in the same change).
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(txn)").fetchall()}
    if "dedupe_resolved_by" not in columns:
        conn.execute("ALTER TABLE txn ADD COLUMN dedupe_resolved_by TEXT")


@migration(22)
def m22_rejection_reason(conn):
    """Discriminator that distinguishes user-driven trash (cleanup) from a row that was excluded
    because a soft-duplicate suspect was confirmed as a real duplicate. Both states set
    `trashed_at` (the row is hidden from active ledger queries either way) but only the second
    sets `rejection_reason='duplicate_confirmed'`, which is what the unified duplicate-detection
    report uses to surface confirmed soft-flags alongside import-time hard-rejects."""
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(txn)").fetchall()
    }
    if "rejection_reason" not in columns:
        conn.execute("ALTER TABLE txn ADD COLUMN rejection_reason TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_rejection_reason ON txn(rejection_reason) WHERE rejection_reason IS NOT NULL")


@migration(21)
def m21_suspect_duplicates(conn):
    """Suspect-duplicate bookkeeping. A transaction can be flagged as a possible duplicate of
    another (across accounts) at two trigger points:
      - import time, when the receiving account is brand new to the database — same date/amount/
        payee on a different account is likely the same event entered through two CSVs;
      - account merge, when two accounts get rolled together and overlapping rows surface.
    The columns sit on `txn` rather than a side table so the existence of a suspect can be
    detected with a single index lookup at row-render time."""
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(txn)").fetchall()
    }
    if "suspect_duplicate_of" not in columns:
        conn.execute("ALTER TABLE txn ADD COLUMN suspect_duplicate_of TEXT")
    if "suspect_duplicate_reason" not in columns:
        conn.execute("ALTER TABLE txn ADD COLUMN suspect_duplicate_reason TEXT")
    if "suspect_resolved_at" not in columns:
        conn.execute("ALTER TABLE txn ADD COLUMN suspect_resolved_at TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_suspect ON txn(suspect_duplicate_of) WHERE suspect_duplicate_of IS NOT NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_date_amount ON txn(date, amount)")


@migration(20)
def m20_txn_trash(conn):
    """Soft-delete column for transactions. Mirrors the existing account-trash pattern so the
    UI can let users send a row to the trash and recover it later, with periodic cleanup
    handled the same way (manual "empty trash" action from Settings)."""
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(txn)").fetchall()
    }
    if "trashed_at" not in columns:
        conn.execute("ALTER TABLE txn ADD COLUMN trashed_at TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_trashed ON txn(trashed_at)")


@migration(17)
def m17_fix_rule_tag_fk(conn):
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='rule_tag'"
    ).fetchone()
    if row and "category_rule_legacy_tags" in (row["sql"] or ""):
        conn.executescript(
            """
            ALTER TABLE rule_tag RENAME TO rule_tag_legacy_fk;
            CREATE TABLE rule_tag (
                rule_id TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
                tag_id  TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                PRIMARY KEY (rule_id, tag_id)
            );
            INSERT INTO rule_tag SELECT * FROM rule_tag_legacy_fk;
            DROP TABLE rule_tag_legacy_fk;
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_tag_tag ON rule_tag(tag_id)")


def init_db(db_path: str | None = None):
    resolved_path = _normalize_db_path(db_path)
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
            CREATE TABLE IF NOT EXISTS plaid_item (
                item_id          TEXT PRIMARY KEY,
                access_token     TEXT NOT NULL DEFAULT '',
                access_token_enc TEXT
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
            -- Higher priority wins when multiple rules match.
            -- amount_min/amount_max allow the same payee to map to different categories
            -- depending on transaction size (e.g. small Costco = groceries, large = shopping).
            CREATE TABLE IF NOT EXISTS category_rule (
                id           TEXT PRIMARY KEY,
                category_id  TEXT REFERENCES category(id) ON DELETE CASCADE,
                keyword      TEXT NOT NULL,
                priority     INTEGER NOT NULL DEFAULT 5,
                amount_min   REAL,
                amount_max   REAL,
                debit_credit TEXT NOT NULL DEFAULT 'both',
                clean_name   TEXT,
                owner_id     TEXT REFERENCES owner(id) ON DELETE SET NULL,
                account_id   TEXT REFERENCES account(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS owner (
                id    TEXT PRIMARY KEY,
                name  TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#6366f1'
            );

            CREATE TABLE IF NOT EXISTS account (
                id               TEXT PRIMARY KEY,
                plaid_account_id TEXT UNIQUE,
                plaid_item_id    TEXT NOT NULL,
                name             TEXT NOT NULL,
                display_name     TEXT NOT NULL,
                institution      TEXT,
                type             TEXT,
                subtype          TEXT,
                mask             TEXT,
                owner_id         TEXT REFERENCES owner(id) ON DELETE SET NULL,
                parent_account_id TEXT REFERENCES account(id) ON DELETE SET NULL,
                trashed_at       TEXT
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
                plaid_transaction_id TEXT UNIQUE,
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
                imported_category    TEXT,
                notes                TEXT,
                owner_id             TEXT REFERENCES owner(id) ON DELETE SET NULL,
                content_hash         TEXT,
                import_evidence_json TEXT,
                import_batch_id      TEXT REFERENCES import_batch(id) ON DELETE SET NULL,
                trashed_at           TEXT,
                suspect_duplicate_of     TEXT,
                suspect_duplicate_reason TEXT,
                suspect_resolved_at      TEXT,
                rejection_reason         TEXT,
                dedupe_resolved_by       TEXT
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
                skip_rows            INTEGER NOT NULL DEFAULT 0,
                apply_categorization INTEGER NOT NULL DEFAULT 1,
                use_imported_categories INTEGER NOT NULL DEFAULT 0,
                notes                TEXT,
                created_at           TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS import_batch (
                id               TEXT PRIMARY KEY,
                profile_id       TEXT REFERENCES csv_import_profile(id) ON DELETE SET NULL,
                filename         TEXT NOT NULL,
                file_content_hash TEXT,
                imported_at      TEXT NOT NULL DEFAULT (datetime('now')),
                row_count        INTEGER NOT NULL DEFAULT 0,
                skipped_count    INTEGER NOT NULL DEFAULT 0,
                deduped_count    INTEGER NOT NULL DEFAULT 0,
                status           TEXT NOT NULL DEFAULT 'completed',
                use_imported_categories INTEGER NOT NULL DEFAULT 0,
                config_snapshot  TEXT
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
                PRIMARY KEY (batch_id, row_number)
            );
            CREATE INDEX IF NOT EXISTS idx_import_batch_duplicate_batch ON import_batch_duplicate(batch_id);

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
        """)
        init_merchant_renames(conn)

        _seed_default_categories(conn)

        if is_fresh_db:
            _alphabetize_top_level_category_groups(conn)
            # Fresh databases are stamped current immediately; the migration pipeline exists
            # to upgrade historical files, not to bootstrap brand-new ones step by step.
            set_db_version(conn, CURRENT_VERSION)
            log_info(f"[db] created new database at schema version {CURRENT_VERSION}")
        else:
            run_migrations(conn)
        ensure_shared_owner(conn)


def _seed_default_categories(conn: sqlite3.Connection, *, include_leaves: bool = False):
    # Seeding model: the top-level reporting groups (plus the system Unassigned group) are seeded for
    # every tenant so the import "Group Imported Categories" workspace always has visible buckets to
    # drop imported labels into — even for a user who brings their own categories and never wants ours.
    # The starter *leaf* categories are an explicit opt-in (include_leaves=True), used by the onboarding
    # "Add starter categories" action, its Categories-page equivalent, and the demo dataset. Keeping
    # leaves opt-in means a bring-your-own user's tree stays free of categories they didn't choose, and
    # — since the built-in rules target these leaves by name — no data-mutating starter rules can exist
    # for them either. The legacy leaf renames below are idempotent migrations that must still run for
    # existing databases that already have the leaves, so they sit before the include_leaves guard.
    import uuid
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
    transfers     = upsert_cat("Transfers", category_type="expense", exclude_from_totals=1)

    # Older defaults reused a few top-level names inside the same tree, which makes
    # rule suggestions and category pickers ambiguous. Seed upgrades those legacy rows
    # in place before the rest of the defaults are reconciled.
    conn.execute(
        """
        UPDATE category
        SET name = 'Medical Services'
        WHERE name = 'Medical'
          AND parent_id = ?
          AND NOT EXISTS (
              SELECT 1
              FROM category
              WHERE parent_id = ?
                AND name = 'Medical Services'
          )
        """,
        (medical, medical),
    )
    conn.execute(
        """
        UPDATE category
        SET name = 'Natural Gas'
        WHERE name = 'Gas'
          AND parent_id = ?
          AND NOT EXISTS (
              SELECT 1
              FROM category
              WHERE parent_id = ?
                AND name = 'Natural Gas'
          )
        """,
        (utilities, utilities),
    )

    if not include_leaves:
        return

    upsert_cat("Fitness Classes", health)
    upsert_cat("Gym Membership", health)

    upsert_cat("Doctor", medical)
    # Canonical name is "Medical Services" (the legacy rename above disambiguates a leaf that collided
    # with the "Medical" group); seeding "Medical" here would re-create that collision and, on re-seed,
    # the rename would fork it back into two leaves.
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





def init_merchant_renames(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS merchant_rename (
            id          TEXT PRIMARY KEY,
            raw_pattern TEXT NOT NULL UNIQUE,
            clean_name  TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_rename_pattern ON merchant_rename(raw_pattern)
    """)
