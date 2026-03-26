"""
database.py — SQLite schema, migrations, and seed data

SCHEMA OVERVIEW:
  category        — Two-level hierarchy: groups (parent_id=NULL) and leaf categories.
                    Color and icon are stored per-category. Groups have their own
                    color used as a fallback, but leaves should have distinct colors.
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

  init_db() also calls helper functions directly (e.g. update_category_colors)
  for fresh installs where the migration version baseline doesn't exist yet.

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
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

DB_PATH = os.getenv("DB_PATH", "fintrack.db")
_current_db_path: ContextVar[str | None] = ContextVar("fintrack_current_db_path", default=None)


def _normalize_db_path(db_path: str | None = None) -> str:
    path = db_path or _current_db_path.get() or DB_PATH
    return str(Path(path))


def set_current_db_path(db_path: str):
    return _current_db_path.set(_normalize_db_path(db_path))


def reset_current_db_path(token):
    _current_db_path.reset(token)


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
#   2. Decorate it with @migration(N) where N = CURRENT_VERSION + 1
#   3. Bump CURRENT_VERSION to N
#   4. On next startup, run_migrations() will detect the version mismatch and
#      apply all pending migrations in order.
#
# Migrations run inside the same init_db() connection, so they can reference
# any helper functions defined in this file.

CURRENT_VERSION = 13

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
def m1_initial(conn):
    """Baseline — tables already created by init_db for new installs."""
    pass


@migration(2)
def m2_merchant_renames(conn):
    """Add merchant_rename table for normalizing messy Plaid merchant names."""
    init_merchant_renames(conn)


@migration(3)
def m3_subcategory_colors(conn):
    """Give each seeded subcategory a distinct color within its parent group."""
    update_category_colors(conn)


@migration(4)
def m4_owners(conn):
    """
    Add multi-owner support.
    - owner table: named owners (e.g. Alice, Bob, Shared)
    - account.owner_id: which owner an account belongs to
    - category.owner_id: which owner a category group belongs to (leaves inherit)
    - category_rule.owner_id: scope a rule to a specific owner (NULL = applies to all)
    - txn.owner_id: denormalized from account for fast filtering; backfilled here
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS owner (
            id    TEXT PRIMARY KEY,
            name  TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL DEFAULT '#6366f1'
        )
    """)

    # Add owner_id to account (ON DELETE SET NULL so deleting an owner
    # gracefully disassociates rather than cascading deletes)
    try:
        conn.execute(
            "ALTER TABLE account ADD COLUMN owner_id TEXT REFERENCES owner(id) ON DELETE SET NULL"
        )
    except Exception:
        pass

    # Add owner_id to category (groups use it; leaves store it too for future use)
    try:
        conn.execute(
            "ALTER TABLE category ADD COLUMN owner_id TEXT REFERENCES owner(id) ON DELETE SET NULL"
        )
    except Exception:
        pass

    # Add owner_id to category_rule (NULL = applies regardless of owner)
    try:
        conn.execute(
            "ALTER TABLE category_rule ADD COLUMN owner_id TEXT REFERENCES owner(id) ON DELETE SET NULL"
        )
    except Exception:
        pass

    # Add owner_id to txn (denormalized from account; NULL = unassigned)
    try:
        conn.execute(
            "ALTER TABLE txn ADD COLUMN owner_id TEXT REFERENCES owner(id) ON DELETE SET NULL"
        )
    except Exception:
        pass

    # Backfill txn.owner_id from account.owner_id for existing transactions
    conn.execute("""
        UPDATE txn
        SET    owner_id = (
            SELECT a.owner_id
            FROM   account a
            WHERE  a.id = txn.account_id
        )
        WHERE  owner_id IS NULL
    """)

    # Index for fast owner-filtered queries
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_txn_owner ON txn(owner_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_owner ON account(owner_id)"
    )


@migration(5)
def m5_import_export(conn):
    """
    Add CSV import infrastructure:
    - csv_import_profile: saved column-mapping rules per source (Chase, Riverstone, etc.)
    - import_batch: one record per import run, enables undo
    - txn.content_hash: hash of (date+amount+description) for duplicate detection
    - txn.import_batch_id: links transaction to the batch that created it (NULL = Plaid)
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS csv_import_profile (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            filename_pattern    TEXT,
            header_fingerprint  TEXT,
            column_map          TEXT NOT NULL DEFAULT '{}',
            account_id          TEXT REFERENCES account(id) ON DELETE SET NULL,
            date_format         TEXT NOT NULL DEFAULT '%Y-%m-%d',
            amount_convention   TEXT NOT NULL DEFAULT 'single_signed',
            skip_rows           INTEGER NOT NULL DEFAULT 0,
            apply_categorization INTEGER NOT NULL DEFAULT 1,
            notes               TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS import_batch (
            id            TEXT PRIMARY KEY,
            profile_id    TEXT REFERENCES csv_import_profile(id) ON DELETE SET NULL,
            filename      TEXT NOT NULL,
            imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
            row_count     INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            status        TEXT NOT NULL DEFAULT 'completed'
        )
    """)

    try:
        conn.execute("ALTER TABLE txn ADD COLUMN content_hash TEXT")
    except Exception:
        pass

    try:
        conn.execute(
            "ALTER TABLE txn ADD COLUMN import_batch_id TEXT "
            "REFERENCES import_batch(id) ON DELETE SET NULL"
        )
    except Exception:
        pass

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_txn_batch  ON txn(import_batch_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_txn_hash   ON txn(content_hash)"
    )


@migration(6)
def m6_import_batch_accounts(conn):
    """
    Extend import tracking:
    - import_batch_account: which accounts were imported (or skipped) per batch.
      Enables duplicate detection — "has account X from file Y already been imported?"
    - import_batch.config_snapshot: full JSON of the import settings used, so
      re-importing the same file can restore all column and account mappings.
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS import_batch_account (
            batch_id    TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
            account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
            csv_value   TEXT NOT NULL,
            row_count   INTEGER NOT NULL DEFAULT 0,
            was_skipped INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (batch_id, account_id)
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_iba_account ON import_batch_account(account_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_iba_batch   ON import_batch_account(batch_id)"
    )
    try:
        conn.execute("ALTER TABLE import_batch ADD COLUMN config_snapshot TEXT")
    except Exception:
        pass


@migration(7)
def m7_import_batch_account_nullable(conn):
    """
    Rebuild import_batch_account with:
    - account_id nullable (skipped accounts may not have a FinTrack account mapped)
    - PRIMARY KEY (batch_id, csv_value) instead of (batch_id, account_id) so
      skipped-only entries can be stored without a real account reference
    """
    # Rename old table, create new one, migrate data, drop old
    try:
        conn.execute(
            "ALTER TABLE import_batch_account RENAME TO import_batch_account_old"
        )
    except Exception:
        return  # already migrated or doesn't exist

    conn.execute("""
        CREATE TABLE import_batch_account (
            batch_id    TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
            csv_value   TEXT NOT NULL,
            account_id  TEXT REFERENCES account(id) ON DELETE SET NULL,
            row_count   INTEGER NOT NULL DEFAULT 0,
            was_skipped INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (batch_id, csv_value)
        )
    """)
    # Migrate existing data
    conn.execute("""
        INSERT OR IGNORE INTO import_batch_account
            (batch_id, csv_value, account_id, row_count, was_skipped)
        SELECT batch_id, csv_value, account_id, row_count, was_skipped
        FROM   import_batch_account_old
    """)
    conn.execute("DROP TABLE import_batch_account_old")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_iba_account ON import_batch_account(account_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_iba_batch ON import_batch_account(batch_id)"
    )


@migration(8)
def m8_import_batch_deduped_count(conn):
    """
    Add deduped_count to import_batch so the Recent Imports list can show
    how many duplicate rows were skipped separately from account-skipped rows.
    Existing rows default to 0 (unknown — they predate this column).
    """
    try:
        conn.execute(
            "ALTER TABLE import_batch ADD COLUMN deduped_count INTEGER NOT NULL DEFAULT 0"
        )
    except Exception:
        pass  # column already exists


@migration(9)
def m9_category_exclude_from_totals(conn):
    """
    Add exclude_from_totals flag to category.
    When set on a top-level group, all transactions in that group are omitted
    from spending summaries, totals, and charts. Intended for groups like
    Transfers and Credit Card Payments that should not appear in reports.
    Defaults to 0 (included) for all existing categories.
    """
    try:
        conn.execute(
            "ALTER TABLE category ADD COLUMN exclude_from_totals INTEGER NOT NULL DEFAULT 0"
        )
    except Exception:
        pass  # column already exists


@migration(10)
def m10_plaid_item_access_token_enc(conn):
    """Add encrypted companion column for Plaid access tokens."""
    try:
        conn.execute("ALTER TABLE plaid_item ADD COLUMN access_token_enc TEXT")
    except Exception:
        pass


@migration(11)
def m11_category_type(conn):
    """
    Add category_type support for income-aware summaries.
    Also creates top-level Income and Transfers groups if needed and reparents
    the legacy Finance > Income / Transfer leaves under those groups.
    """
    import uuid

    try:
        conn.execute("ALTER TABLE category ADD COLUMN category_type TEXT")
    except Exception:
        pass

    def upsert_group(name, color, icon, cat_type=None, exclude=0):
        row = conn.execute(
            "SELECT id FROM category WHERE name = ? AND parent_id IS NULL",
            (name,),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE category SET category_type = ?, exclude_from_totals = ? WHERE id = ?",
                (cat_type, exclude, row["id"]),
            )
            return row["id"]
        new_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO category (id, parent_id, name, color, icon, category_type, exclude_from_totals)
            VALUES (?, NULL, ?, ?, ?, ?, ?)
            """,
            (new_id, name, color, icon, cat_type, exclude),
        )
        return new_id

    def ensure_leaf(parent_id, name, color, icon):
        row = conn.execute(
            "SELECT id FROM category WHERE name = ? AND parent_id = ?",
            (name, parent_id),
        ).fetchone()
        if row:
            return row["id"]
        new_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, color, icon) VALUES (?, ?, ?, ?, ?)",
            (new_id, parent_id, name, color, icon),
        )
        return new_id

    income_group = upsert_group("Income", "#22c55e", "💵", cat_type="income", exclude=0)
    transfers_group = upsert_group("Transfers", "#78909C", "🔄", cat_type=None, exclude=1)

    finance = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id IS NULL",
        ("Finance",),
    ).fetchone()
    if finance:
        conn.execute(
            "UPDATE category SET parent_id = ? WHERE name = ? AND parent_id = ?",
            (income_group, "Income", finance["id"]),
        )
        conn.execute(
            "UPDATE category SET parent_id = ? WHERE name = ? AND parent_id = ?",
            (transfers_group, "Transfer", finance["id"]),
        )

    ensure_leaf(income_group, "Salary", "#22c55e", "💼")
    ensure_leaf(income_group, "Freelance", "#16a34a", "🧑‍💻")
    ensure_leaf(income_group, "Investment", "#15803d", "📈")
    ensure_leaf(income_group, "Refund", "#4ade80", "↩️")
    ensure_leaf(income_group, "Other Income", "#86efac", "💵")
    ensure_leaf(transfers_group, "Credit Card Pay", "#78909C", "💳")
    ensure_leaf(transfers_group, "Bank Transfer", "#90A4AE", "🔄")


@migration(12)
def m12_category_sort_order(conn):
    """Add explicit ordering for categories and normalize top-level types."""
    try:
        conn.execute("ALTER TABLE category ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass

    top_level_rows = conn.execute(
        """
        SELECT id, name, COALESCE(category_type, 'expense') AS category_type
        FROM category
        WHERE parent_id IS NULL
        ORDER BY
            CASE COALESCE(category_type, 'expense')
                WHEN 'income' THEN 0
                ELSE 1
            END,
            sort_order,
            name
        """
    ).fetchall()
    for index, row in enumerate(top_level_rows):
        conn.execute(
            "UPDATE category SET sort_order = ?, category_type = ? WHERE id = ?",
            (index, row["category_type"], row["id"]),
        )

    child_rows = conn.execute(
        """
        SELECT id, parent_id
        FROM category
        WHERE parent_id IS NOT NULL
        ORDER BY parent_id, sort_order, name
        """
    ).fetchall()
    order_by_parent = {}
    for row in child_rows:
        next_order = order_by_parent.get(row["parent_id"], 0)
        conn.execute(
            "UPDATE category SET sort_order = ? WHERE id = ?",
            (next_order, row["id"]),
        )
        order_by_parent[row["parent_id"]] = next_order + 1


@migration(13)
def m13_category_rule_clean_name(conn):
    """Add optional clean_name to category rules for payee normalization hints."""
    try:
        conn.execute("ALTER TABLE category_rule ADD COLUMN clean_name TEXT")
    except Exception:
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
                id        TEXT PRIMARY KEY,
                parent_id TEXT REFERENCES category(id) ON DELETE SET NULL,
                name      TEXT NOT NULL,
                color     TEXT NOT NULL DEFAULT '#9E9E9E',
                icon      TEXT NOT NULL DEFAULT '📦',
                category_type TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0
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
                clean_name  TEXT
            );

            CREATE TABLE IF NOT EXISTS account (
                id              TEXT PRIMARY KEY,
                plaid_account_id TEXT UNIQUE,
                plaid_item_id    TEXT NOT NULL,
                name             TEXT NOT NULL,
                institution      TEXT,
                type             TEXT,
                subtype          TEXT,
                mask             TEXT
            );

            -- Core transaction table. `txn` not `transaction` (SQLite reserved word).
            -- merchant_name is the cleaned display name (may be updated by rename rules or user).
            -- raw_name is the original string from Plaid, never modified.
            -- category_overridden=1 means user manually set category; auto-categorizer skips these.
            CREATE TABLE IF NOT EXISTS txn (
                id                   TEXT PRIMARY KEY,
                plaid_transaction_id TEXT UNIQUE,
                account_id           TEXT NOT NULL REFERENCES account(id),
                category_id          TEXT REFERENCES category(id) ON DELETE SET NULL,
                amount               REAL NOT NULL,
                merchant_name        TEXT,
                raw_name             TEXT,
                date                 TEXT NOT NULL,
                is_pending           INTEGER NOT NULL DEFAULT 0,
                category_overridden  INTEGER NOT NULL DEFAULT 0,
                notes                TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_txn_date        ON txn(date);
            CREATE INDEX IF NOT EXISTS idx_txn_account     ON txn(account_id);
            CREATE INDEX IF NOT EXISTS idx_txn_category    ON txn(category_id);
            CREATE INDEX IF NOT EXISTS idx_rule_category   ON category_rule(category_id);
            CREATE INDEX IF NOT EXISTS idx_rule_keyword    ON category_rule(keyword);
        """)

        # Handle upgrades from old schema versions that predate the migration system
        try:
            conn.execute("ALTER TABLE category ADD COLUMN parent_id TEXT REFERENCES category(id) ON DELETE SET NULL")
        except Exception:
            pass
        for col in ["amount_min REAL", "amount_max REAL", "clean_name TEXT"]:
            try:
                conn.execute(f"ALTER TABLE category_rule ADD COLUMN {col}")
            except Exception:
                pass

        _seed_default_categories(conn)
        update_category_colors(conn)  # ensure fresh installs get correct colors

        rule_count = conn.execute("SELECT COUNT(*) FROM category_rule").fetchone()[0]
        if rule_count == 0:
            from services.categorizer import seed_default_rules
            seed_default_rules(conn)

        run_migrations(conn)


# ── Category seed data ────────────────────────────────────────────────────────

def _seed_default_categories(conn: sqlite3.Connection):
    """
    Insert the default group/category tree if it doesn't exist yet.
    Uses upsert-by-name so re-running is safe (idempotent).
    Groups and their children are defined here; colors are set by
    update_category_colors() so they can be updated via migration without
    wiping user customizations to other categories.
    """
    import uuid

    def upsert_cat(name, color, icon, parent_id=None):
        row = conn.execute("SELECT id FROM category WHERE name = ?", (name,)).fetchone()
        if row:
            return row["id"]
        new_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, color, icon) VALUES (?,?,?,?,?)",
            (new_id, parent_id, name, color, icon),
        )
        return new_id

    # Top-level groups
    health        = upsert_cat("Health & Fitness",  "#E53935", "🏥")
    food          = upsert_cat("Food & Drink",       "#FB8C00", "🍽️")
    home          = upsert_cat("Home",               "#8E24AA", "🏠")
    transport     = upsert_cat("Transportation",     "#1E88E5", "🚗")
    shopping      = upsert_cat("Shopping",           "#00ACC1", "🛍️")
    entertainment = upsert_cat("Entertainment",      "#F4511E", "🎬")
    finance       = upsert_cat("Finance",            "#7CB342", "💰")
    travel        = upsert_cat("Travel",             "#546E7A", "✈️")
    other         = upsert_cat("Other",              "#795548", "📦")

    # Health & Fitness children — red family, varied
    upsert_cat("Doctor & Medical",  "#E53935", "👨‍⚕️", health)
    upsert_cat("Pharmacy",          "#F06292", "💊", health)
    upsert_cat("Gym & Fitness",     "#FF7043", "🏋️", health)
    upsert_cat("Vision & Dental",   "#AB47BC", "🦷", health)

    # Food & Drink children — orange/amber family
    upsert_cat("Groceries",         "#FB8C00", "🛒", food)
    upsert_cat("Dining Out",        "#F4511E", "🍴", food)
    upsert_cat("Coffee & Drinks",   "#FFCA28", "☕", food)
    upsert_cat("Alcohol",           "#EF5350", "🍷", food)

    # Home children — purple family
    upsert_cat("Rent & Mortgage",   "#8E24AA", "🏡", home)
    upsert_cat("Utilities",         "#5E35B1", "💡", home)
    upsert_cat("Internet & Phone",  "#3949AB", "📡", home)
    upsert_cat("Home Improvement",  "#00897B", "🔧", home)

    # Transportation children — blue family
    upsert_cat("Gas",               "#1E88E5", "⛽", transport)
    upsert_cat("Parking & Tolls",   "#039BE5", "🅿️", transport)
    upsert_cat("Rideshare",         "#00ACC1", "🚕", transport)
    upsert_cat("Public Transit",    "#43A047", "🚌", transport)
    upsert_cat("Auto Insurance",    "#1565C0", "🚙", transport)

    # Shopping children — teal family
    upsert_cat("Clothing",          "#00ACC1", "👕", shopping)
    upsert_cat("Electronics",       "#0097A7", "💻", shopping)
    upsert_cat("Online Shopping",   "#00838F", "📦", shopping)

    # Entertainment children — deep orange family
    upsert_cat("Subscriptions",     "#F4511E", "📺", entertainment)
    upsert_cat("Movies & Events",   "#E91E63", "🎟️", entertainment)
    upsert_cat("Hobbies",           "#9C27B0", "🎨", entertainment)

    # Finance children
    upsert_cat("Income",            "#7CB342", "💵", finance)
    upsert_cat("Transfer",          "#78909C", "🔄", finance)
    upsert_cat("Savings",           "#26A69A", "🏦", finance)
    upsert_cat("Fees & Charges",    "#EF5350", "💸", finance)


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


def update_category_colors(conn: sqlite3.Connection):
    """
    Set distinct colors for seeded subcategories.
    Called on startup so existing databases get updated colors when this list changes.
    Only updates categories that match by name — user-created categories are unaffected.
    To change a seeded color in future: update the list here and add a new migration
    that calls this function, so existing installs pick up the change on next startup.
    """
    updates = [
        # Health & Fitness
        ("Doctor & Medical",  "#E53935"),
        ("Pharmacy",          "#F06292"),
        ("Gym & Fitness",     "#FF7043"),
        ("Vision & Dental",   "#AB47BC"),
        # Food & Drink
        ("Groceries",         "#FB8C00"),
        ("Dining Out",        "#F4511E"),
        ("Coffee & Drinks",   "#FFCA28"),
        ("Alcohol",           "#EF5350"),
        # Home
        ("Rent & Mortgage",   "#8E24AA"),
        ("Utilities",         "#5E35B1"),
        ("Internet & Phone",  "#3949AB"),
        ("Home Improvement",  "#00897B"),
        # Transportation
        ("Gas",               "#1E88E5"),
        ("Parking & Tolls",   "#039BE5"),
        ("Rideshare",         "#00ACC1"),
        ("Public Transit",    "#43A047"),
        ("Auto Insurance",    "#1565C0"),
        # Shopping
        ("Clothing",          "#00ACC1"),
        ("Electronics",       "#0097A7"),
        ("Online Shopping",   "#00838F"),
        # Entertainment
        ("Subscriptions",     "#F4511E"),
        ("Movies & Events",   "#E91E63"),
        ("Hobbies",           "#9C27B0"),
        # Finance
        ("Income",            "#7CB342"),
        ("Transfer",          "#78909C"),
        ("Savings",           "#26A69A"),
        ("Fees & Charges",    "#EF5350"),
    ]
    for name, color in updates:
        conn.execute("UPDATE category SET color = ? WHERE name = ?", (color, name))
