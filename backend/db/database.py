# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Primary application database: schema, seeding, and migrations for each tenant DB.

This file owns the durable model the routers and services share. Its key guarantees
are that fresh databases are created directly in the current shape, existing ones
advance through ordered migrations, and core invariants like leaf-only transaction
categories and the built-in shared owner are re-established on startup.
"""

import os
import sqlite3
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from backend.app_logging import log_info

DB_PATH = os.getenv("DB_PATH", "fintrack.db")
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

CURRENT_VERSION = 1

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


@migration(1)
def m1_baseline(conn):
    pass


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
                color               TEXT NOT NULL DEFAULT '#9E9E9E',
                category_type       TEXT,
                sort_order          INTEGER NOT NULL DEFAULT 0,
                exclude_from_totals INTEGER NOT NULL DEFAULT 0,
                owner_id            TEXT REFERENCES owner(id) ON DELETE SET NULL
            );

            -- keyword is matched as a case-insensitive substring of merchant_name or raw_name.
            -- Higher priority wins when multiple rules match.
            -- amount_min/amount_max allow the same payee to map to different categories
            -- depending on transaction size (e.g. small Costco = groceries, large = shopping).
            CREATE TABLE IF NOT EXISTS category_rule (
                id          TEXT PRIMARY KEY,
                category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
                keyword     TEXT NOT NULL,
                priority    INTEGER NOT NULL DEFAULT 5,
                amount_min  REAL,
                amount_max  REAL,
                clean_name  TEXT,
                owner_id    TEXT REFERENCES owner(id) ON DELETE SET NULL,
                account_id  TEXT REFERENCES account(id) ON DELETE SET NULL
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
                institution      TEXT,
                type             TEXT,
                subtype          TEXT,
                mask             TEXT,
                owner_id         TEXT REFERENCES owner(id) ON DELETE SET NULL
            );

            -- Core transaction table. `txn` not `transaction` (SQLite reserved word).
            -- merchant_name is the preserved canonical/original merchant value.
            -- display_name is the user-facing label (may be updated by rules or user edits).
            -- raw_name is the original string from Plaid, never modified.
            -- category_overridden=1 means user manually set category; auto-categorizer skips these.
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
                imported_category    TEXT,
                notes                TEXT,
                owner_id             TEXT REFERENCES owner(id) ON DELETE SET NULL,
                content_hash         TEXT,
                import_batch_id      TEXT REFERENCES import_batch(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_txn_date        ON txn(date);
            CREATE INDEX IF NOT EXISTS idx_txn_account     ON txn(account_id);
            CREATE INDEX IF NOT EXISTS idx_txn_category    ON txn(category_id);
            CREATE INDEX IF NOT EXISTS idx_txn_owner       ON txn(owner_id);
            CREATE INDEX IF NOT EXISTS idx_txn_batch       ON txn(import_batch_id);
            CREATE INDEX IF NOT EXISTS idx_txn_hash        ON txn(content_hash);
            CREATE INDEX IF NOT EXISTS idx_rule_category   ON category_rule(category_id);
            CREATE INDEX IF NOT EXISTS idx_rule_keyword    ON category_rule(keyword);
            CREATE INDEX IF NOT EXISTS idx_rule_account    ON category_rule(account_id);
            CREATE INDEX IF NOT EXISTS idx_account_owner   ON account(owner_id);

            CREATE TABLE IF NOT EXISTS csv_import_profile (
                id                   TEXT PRIMARY KEY,
                name                 TEXT NOT NULL,
                filename_pattern     TEXT,
                header_fingerprint   TEXT,
                column_map           TEXT NOT NULL DEFAULT '{}',
                account_id           TEXT REFERENCES account(id) ON DELETE SET NULL,
                date_format          TEXT NOT NULL DEFAULT '%Y-%m-%d',
                amount_convention    TEXT NOT NULL DEFAULT 'single_signed',
                skip_rows            INTEGER NOT NULL DEFAULT 0,
                apply_categorization INTEGER NOT NULL DEFAULT 1,
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
                config_snapshot  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_import_batch_file_hash ON import_batch(file_content_hash);

            CREATE TABLE IF NOT EXISTS import_batch_account (
                batch_id    TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
                csv_value   TEXT NOT NULL,
                account_id  TEXT REFERENCES account(id) ON DELETE SET NULL,
                row_count   INTEGER NOT NULL DEFAULT 0,
                was_skipped INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (batch_id, csv_value)
            );
            CREATE INDEX IF NOT EXISTS idx_iba_account ON import_batch_account(account_id);
            CREATE INDEX IF NOT EXISTS idx_iba_batch   ON import_batch_account(batch_id);

            CREATE TABLE IF NOT EXISTS backup_recipient (
                id          TEXT PRIMARY KEY,
                label       TEXT NOT NULL,
                public_key  TEXT NOT NULL,
                fingerprint TEXT NOT NULL UNIQUE,
                algorithm   TEXT NOT NULL DEFAULT 'rsa-oaep-sha256',
                enabled     INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
        """)
        init_merchant_renames(conn)

        _seed_default_categories(conn)

        if is_fresh_db:
            # Fresh databases are stamped current immediately; the migration pipeline exists
            # to upgrade historical files, not to bootstrap brand-new ones step by step.
            set_db_version(conn, CURRENT_VERSION)
            log_info(f"[db] created new database at schema version {CURRENT_VERSION}")
        else:
            run_migrations(conn)
        ensure_shared_owner(conn)

        rule_count = conn.execute("SELECT COUNT(*) FROM category_rule").fetchone()[0]
        if rule_count == 0:
            from backend.services.categorizer import seed_default_rules
            seed_default_rules(conn)


def _seed_default_categories(conn: sqlite3.Connection):
    import uuid

    def upsert_cat(name, parent_id=None, category_type=None, exclude_from_totals=0):
        if parent_id is None:
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
        conn.execute(
            """
            INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals)
            VALUES (?,?,?,?,?)
            """,
            (new_id, parent_id, name, category_type, exclude_from_totals),
        )
        return new_id

    income_group  = upsert_cat("Income", category_type="income")
    finance       = upsert_cat("Finance", category_type="expense")
    food          = upsert_cat("Food & Drink", category_type="expense")
    gifts         = upsert_cat("Gifts & Donations", category_type="expense")
    health        = upsert_cat("Health & Fitness", category_type="expense")
    household     = upsert_cat("Household", category_type="expense")
    medical       = upsert_cat("Medical", category_type="expense")
    other         = upsert_cat("Miscellaneous", category_type="expense")
    shopping      = upsert_cat("Shopping", category_type="expense")
    entertainment = upsert_cat("Entertainment", category_type="expense")
    transport     = upsert_cat("Transportation", category_type="expense")
    travel        = upsert_cat("Vacation & Travel", category_type="expense")
    utilities     = upsert_cat("Utilities", category_type="expense")
    transfers     = upsert_cat("Transfers", category_type="expense", exclude_from_totals=1)

    upsert_cat("Fitness Classes", health)
    upsert_cat("Gym Membership", health)

    upsert_cat("Doctor", medical)
    upsert_cat("Medical", medical)
    upsert_cat("Dental", medical)
    upsert_cat("Pharmacy", medical)
    upsert_cat("Vision", medical)

    upsert_cat("Alcohol", food)
    upsert_cat("Coffee & Drinks", food)
    upsert_cat("Dining Out", food)
    upsert_cat("Groceries", food)

    upsert_cat("Home Improvement", household)
    upsert_cat("Home Insurance", household)
    upsert_cat("Home Repairs", household)
    upsert_cat("Property Tax", household)
    upsert_cat("Rent & Mortgage", household)

    upsert_cat("Electricity", utilities)
    upsert_cat("Gas", utilities)
    upsert_cat("Internet", utilities)
    upsert_cat("Phone", utilities)
    upsert_cat("Water", utilities)

    upsert_cat("Auto Insurance", transport)
    upsert_cat("Gas", transport)
    upsert_cat("Parking & Tolls", transport)
    upsert_cat("Public Transit", transport)
    upsert_cat("Rideshare", transport)

    upsert_cat("Clothing", shopping)
    upsert_cat("Electronics", shopping)
    upsert_cat("Online Shopping", shopping)

    upsert_cat("Hobbies", entertainment)
    upsert_cat("Movies & Events", entertainment)
    upsert_cat("Subscriptions", entertainment)

    upsert_cat("Fees & Charges", finance)
    upsert_cat("Savings", finance)
    upsert_cat("Credit Card Payment", transfers)
    upsert_cat("Bank Transfer", transfers)

    upsert_cat("Charity", gifts)
    upsert_cat("Charity (not deductible)", gifts)
    upsert_cat("Gifts", gifts)

    upsert_cat("Salary", income_group)
    upsert_cat("Freelance", income_group)
    upsert_cat("Investment", income_group)
    upsert_cat("Refund", income_group)
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
