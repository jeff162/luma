"""
database.py — SQLite schema, migrations, and seed data

SCHEMA OVERVIEW:
  category        — Two-level hierarchy: groups (parent_id=NULL) and leaf categories.
                    Color remains in schema for compatibility, but seeded
                    categories no longer require a separately-maintained color map.
  category_rule   — Keyword rules for auto-categorization. Matched case-insensitively
                    as substrings of merchant_name+raw_name. Higher priority wins.
                    Optional amount_min/amount_max for amount-based routing.
  merchant_rename — Raw name → clean name mapping applied during sync before
                    categorization. Lets garbled Plaid names be fixed once and
                    automatically corrected on all future syncs.
  txn             — Transactions (table named 'txn' not 'transaction' — reserved
                    word in SQLite). category_overridden=1 means the user manually
                    set the category; the auto-categorizer skips these.
  account         — Linked Plaid accounts.
  plaid_item      — Plaid items (one per linked institution), stores access_token.
  db_meta         — Key/value store for database metadata (currently just 'version').

MIGRATION SYSTEM:
  Every schema change or data migration that needs to run on existing databases
  should be implemented as a migration function, not just in init_db().

  To add a new migration:
    1. Write a function decorated with @migration(N) where N = CURRENT_VERSION + 1
    2. Bump CURRENT_VERSION to N
    3. The function runs automatically on next startup for any DB below version N

  Migrations are idempotent by convention — use CREATE TABLE IF NOT EXISTS,
  ALTER TABLE wrapped in try/except, and UPDATE ... WHERE to avoid re-applying.

  init_db() also calls a few helper functions directly for fresh installs where
  the migration version baseline doesn't exist yet.

SEEDING:
  _seed_default_categories() uses upsert_cat() which INSERT OR IGNOREs, so it's
  safe to call on every startup — it won't overwrite user changes.
  seed_default_rules() in categorizer.py does the same for categorization rules.
  Both are called only when the respective tables are empty (first run).
"""

"""
database.py — SQLite setup, migrations, and seed data.

DESIGN PRINCIPLES:
- Single SQLite file, path controlled by DB_PATH env var (default: fintrack.db)
- All schema changes go through the migration system (see run_migrations).
  Never ALTER tables ad-hoc; add a new @migration(N) function and bump CURRENT_VERSION.
- The db_meta table stores key/value metadata, currently just the schema version.
- get_db() is a context manager that yields a Row-factory connection and commits
  on clean exit. All routers use this pattern — never manage connections manually.
- Categories are two-level only: top-level groups (parent_id IS NULL) and leaf
  categories (parent_id = group.id). Transactions are always assigned to leaves,
  never to groups directly. The UI and queries depend on this invariant.
- category_overridden=1 means the user manually set the category; the auto-
  categorizer will skip these transactions during re-categorization runs.
- merchant_rename rules are applied during sync BEFORE categorization, so a
  cleaned-up merchant name flows through to the category matching rules.
"""

import os
import sqlite3
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

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


# ── Database versioning ───────────────────────────────────────────────────────
#
# HOW TO ADD A MIGRATION:
#   1. Write a function that makes the change idempotently (use IF NOT EXISTS,
#      try/except on ALTER TABLE, etc.)
#   2. Update init_db() so fresh databases are created directly in the new
#      schema shape instead of relying on the migration chain.
#   3. Decorate the upgrade step with @migration(N) where N = CURRENT_VERSION + 1
#   4. Bump CURRENT_VERSION to N
#   5. If migration coverage is needed, add/update a historical test DB creator
#      under backend/db/test_fixtures/ that can build a database at the
#      pre-migration version for upgrade testing.
#   6. On next startup, run_migrations() will detect the version mismatch and
#      apply all pending migrations in order.
#
# Migrations run inside the same init_db() connection, so they can reference
# any helper functions defined in this file.

CURRENT_VERSION = 1

MIGRATIONS = {}


def migration(version):
    """Decorator to register a migration function."""
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
    """Apply any pending migrations in order, updating the version after each."""
    current = get_db_version(conn)
    if current >= CURRENT_VERSION:
        return
    for version in sorted(MIGRATIONS):
        if version > current:
            print(f"[db] applying migration v{version}...")
            MIGRATIONS[version](conn)
            set_db_version(conn, version)
    print(f"[db] database is now at version {CURRENT_VERSION}")


# ── Migrations ────────────────────────────────────────────────────────────────

@migration(1)
def m1_baseline(conn):
    """Baseline schema version for the current direct-bootstrap database."""
    pass


# ── Schema creation ───────────────────────────────────────────────────────────

def init_db(db_path: str | None = None):
    """
    Create all tables and indexes if they don't exist, seed default data,
    and run any pending migrations. Called once at application startup.
    """
    with get_db(db_path) as conn:
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

            -- Keyword-based auto-categorization rules.
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

        run_migrations(conn)
        ensure_shared_owner(conn)

        rule_count = conn.execute("SELECT COUNT(*) FROM category_rule").fetchone()[0]
        if rule_count == 0:
            from services.categorizer import seed_default_rules
            seed_default_rules(conn)


# ── Category seed data ────────────────────────────────────────────────────────

def _seed_default_categories(conn: sqlite3.Connection):
    """
    Insert the default group/category tree if it doesn't exist yet.
    Uses upsert-by-name so re-running is safe (idempotent).
    Groups and their children are defined here directly. Seeded categories now
    use the schema default color unless a color is explicitly chosen elsewhere.
    """
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

    # Top-level groups
    income_group  = upsert_cat("Income", category_type="income")
    finance       = upsert_cat("Finance", category_type="expense")
    food          = upsert_cat("Food & Drink", category_type="expense")
    gifts         = upsert_cat("Gifts & Donations", category_type="expense")
    health        = upsert_cat("Health & Fitness", category_type="expense")
    household     = upsert_cat("Household", category_type="expense")
    other         = upsert_cat("Other", category_type="expense")
    shopping      = upsert_cat("Shopping", category_type="expense")
    entertainment = upsert_cat("Entertainment", category_type="expense")
    transport     = upsert_cat("Transportation", category_type="expense")
    travel        = upsert_cat("Travel", category_type="expense")
    transfers     = upsert_cat("Transfers", category_type="expense", exclude_from_totals=1)

    upsert_cat("Dental", health)
    upsert_cat("Doctor & Medical", health)
    upsert_cat("Gym & Fitness", health)
    upsert_cat("Pharmacy", health)
    upsert_cat("Vision", health)

    upsert_cat("Alcohol", food)
    upsert_cat("Coffee & Drinks", food)
    upsert_cat("Dining Out", food)
    upsert_cat("Groceries", food)

    upsert_cat("Electricity", household)
    upsert_cat("Gas", household)
    upsert_cat("Home Improvement", household)
    upsert_cat("Home Insurance", household)
    upsert_cat("Home Repairs", household)
    upsert_cat("Internet", household)
    upsert_cat("Phone", household)
    upsert_cat("Property Tax", household)
    upsert_cat("Rent & Mortgage", household)
    upsert_cat("Water", household)

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


# ── Helper functions called by migrations ─────────────────────────────────────

def init_merchant_renames(conn: sqlite3.Connection):
    """
    Create merchant_rename table.
    raw_pattern is matched as a case-insensitive substring of raw_name during sync.
    When a match is found, merchant_name is set to clean_name before categorization runs.
    This lets you fix garbled Plaid names (e.g. 'WHOLEFDS #1234 MKT' -> 'Whole Foods')
    once and have the fix apply to all future transactions automatically.
    """
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
