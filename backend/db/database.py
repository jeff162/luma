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

CURRENT_VERSION = 20

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


def _table_sql_contains(conn, table_name: str, needle: str) -> bool:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    sql = row["sql"] if row and row["sql"] else ""
    return needle.lower() in sql.lower()


def _rebuild_category_foreign_key_tables(conn):
    """Repair tables whose FKs still point at category_old after the category rebuild."""
    needs_rule_rebuild = _table_sql_contains(conn, "category_rule", "category_old")
    needs_txn_rebuild = _table_sql_contains(conn, "txn", "category_old")

    if not needs_rule_rebuild and not needs_txn_rebuild:
        return

    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        if needs_rule_rebuild:
            conn.execute("ALTER TABLE category_rule RENAME TO category_rule_old")
            conn.execute("""
                CREATE TABLE category_rule (
                    id          TEXT PRIMARY KEY,
                    category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
                    keyword     TEXT NOT NULL,
                    priority    INTEGER NOT NULL DEFAULT 5,
                    amount_min  REAL,
                    amount_max  REAL,
                    clean_name  TEXT,
                    owner_id    TEXT REFERENCES owner(id) ON DELETE SET NULL,
                    account_id  TEXT REFERENCES account(id) ON DELETE SET NULL
                )
            """)
            conn.execute("""
                INSERT INTO category_rule (id, category_id, keyword, priority, amount_min, amount_max, clean_name, owner_id, account_id)
                SELECT id, category_id, keyword, priority, amount_min, amount_max, clean_name, owner_id, account_id
                FROM category_rule_old
            """)
            conn.execute("DROP TABLE category_rule_old")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_category ON category_rule(category_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_keyword ON category_rule(keyword)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_account ON category_rule(account_id)")

        if needs_txn_rebuild:
            conn.execute("ALTER TABLE txn RENAME TO txn_old")
            conn.execute("""
                CREATE TABLE txn (
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
                )
            """)
            conn.execute("""
                INSERT INTO txn (
                    id, plaid_transaction_id, account_id, category_id, amount,
                    merchant_name, display_name, raw_name, date, is_pending,
                    category_overridden, imported_category, notes, owner_id,
                    content_hash, import_batch_id
                )
                SELECT
                    id, plaid_transaction_id, account_id, category_id, amount,
                    merchant_name, display_name, raw_name, date, is_pending,
                    category_overridden, imported_category, notes, owner_id,
                    content_hash, import_batch_id
                FROM txn_old
            """)
            conn.execute("DROP TABLE txn_old")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_date ON txn(date)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_account ON txn(account_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_category ON txn(category_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_owner ON txn(owner_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_batch ON txn(import_batch_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_hash ON txn(content_hash)")
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


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
    """Legacy no-op: seeded category colors are no longer maintained separately."""
    pass


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
            file_content_hash TEXT,
            imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
            row_count     INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            status        TEXT NOT NULL DEFAULT 'completed'
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_import_batch_file_hash ON import_batch(file_content_hash)"
    )

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

    def upsert_group(name, color, cat_type=None, exclude=0):
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
            INSERT INTO category (id, parent_id, name, color, category_type, exclude_from_totals)
            VALUES (?, NULL, ?, ?, ?, ?)
            """,
            (new_id, name, color, cat_type, exclude),
        )
        return new_id

    def ensure_leaf(parent_id, name, color):
        row = conn.execute(
            "SELECT id FROM category WHERE name = ? AND parent_id = ?",
            (name, parent_id),
        ).fetchone()
        if row:
            return row["id"]
        new_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, color) VALUES (?, ?, ?, ?)",
            (new_id, parent_id, name, color),
        )
        return new_id

    income_group = upsert_group("Income", "#22c55e", cat_type="income", exclude=0)
    transfers_group = upsert_group("Transfers", "#78909C", cat_type=None, exclude=1)

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

    ensure_leaf(income_group, "Salary", "#22c55e")
    ensure_leaf(income_group, "Freelance", "#16a34a")
    ensure_leaf(income_group, "Investment", "#15803d")
    ensure_leaf(income_group, "Refund", "#4ade80")
    ensure_leaf(income_group, "Other Income", "#86efac")
    ensure_leaf(transfers_group, "Credit Card Payment", "#78909C")
    ensure_leaf(transfers_group, "Bank Transfer", "#90A4AE")


@migration(14)
def m14_txn_imported_category(conn):
    """Persist raw category text imported from CSV files for post-import mapping."""
    try:
        conn.execute("ALTER TABLE txn ADD COLUMN imported_category TEXT")
    except Exception:
        pass


@migration(15)
def m15_backup_recipients(conn):
    """Store optional public-key recipients for encrypted backups."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS backup_recipient (
            id          TEXT PRIMARY KEY,
            label       TEXT NOT NULL,
            public_key  TEXT NOT NULL,
            fingerprint TEXT NOT NULL UNIQUE,
            algorithm   TEXT NOT NULL DEFAULT 'rsa-oaep-sha256',
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


@migration(16)
def m16_txn_display_name(conn):
    """Preserve original merchant_name while storing a separate UI display name."""
    try:
        conn.execute("ALTER TABLE txn ADD COLUMN display_name TEXT")
    except Exception:
        pass

    conn.execute("""
        UPDATE txn
        SET    display_name = COALESCE(display_name, merchant_name, raw_name)
        WHERE  display_name IS NULL
    """)


@migration(17)
def m17_category_rule_account(conn):
    """Allow category rules to target a specific account."""
    try:
        conn.execute(
            "ALTER TABLE category_rule ADD COLUMN account_id TEXT REFERENCES account(id) ON DELETE SET NULL"
        )
    except Exception:
        pass

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rule_account ON category_rule(account_id)"
    )


@migration(18)
def m18_remove_category_icons(conn):
    """Drop the legacy category.icon column and rebuild the table without it."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(category)").fetchall()}
    if "icon" not in cols:
        return

    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        conn.execute("ALTER TABLE category RENAME TO category_old")
        conn.execute("""
            CREATE TABLE category (
                id                  TEXT PRIMARY KEY,
                parent_id           TEXT REFERENCES category(id) ON DELETE SET NULL,
                name                TEXT NOT NULL,
                color               TEXT NOT NULL DEFAULT '#9E9E9E',
                category_type       TEXT,
                sort_order          INTEGER NOT NULL DEFAULT 0,
                exclude_from_totals INTEGER NOT NULL DEFAULT 0,
                owner_id            TEXT REFERENCES owner(id) ON DELETE SET NULL
            )
        """)
        conn.execute("""
            INSERT INTO category (id, parent_id, name, color, category_type, sort_order, exclude_from_totals, owner_id)
            SELECT id, parent_id, name, color, category_type, sort_order, COALESCE(exclude_from_totals, 0), owner_id
            FROM category_old
        """)
        conn.execute("DROP TABLE category_old")
    finally:
        conn.execute("PRAGMA foreign_keys=ON")

    _rebuild_category_foreign_key_tables(conn)


@migration(19)
def m19_repair_category_fk_targets(conn):
    """Repair any tables whose category foreign keys still point at category_old."""
    _rebuild_category_foreign_key_tables(conn)


@migration(20)
def m20_import_batch_file_hash(conn):
    try:
        conn.execute("ALTER TABLE import_batch ADD COLUMN file_content_hash TEXT")
    except Exception:
        pass
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_import_batch_file_hash ON import_batch(file_content_hash)"
    )


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
                clean_name  TEXT,
                account_id  TEXT REFERENCES account(id) ON DELETE SET NULL
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
                notes                TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_txn_date        ON txn(date);
            CREATE INDEX IF NOT EXISTS idx_txn_account     ON txn(account_id);
            CREATE INDEX IF NOT EXISTS idx_txn_category    ON txn(category_id);
            CREATE INDEX IF NOT EXISTS idx_rule_category   ON category_rule(category_id);
            CREATE INDEX IF NOT EXISTS idx_rule_keyword    ON category_rule(keyword);

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
        try:
            conn.execute(
                "ALTER TABLE category_rule ADD COLUMN account_id TEXT REFERENCES account(id) ON DELETE SET NULL"
            )
        except Exception:
            pass
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rule_account ON category_rule(account_id)"
        )
        try:
            conn.execute("ALTER TABLE txn ADD COLUMN imported_category TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE txn ADD COLUMN display_name TEXT")
        except Exception:
            pass
        conn.execute("""
            UPDATE txn
            SET    display_name = COALESCE(display_name, merchant_name, raw_name)
            WHERE  display_name IS NULL
        """)

        _seed_default_categories(conn)

        run_migrations(conn)

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

    def upsert_cat(name, parent_id=None):
        row = conn.execute("SELECT id FROM category WHERE name = ?", (name,)).fetchone()
        if row:
            return row["id"]
        new_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name) VALUES (?,?,?)",
            (new_id, parent_id, name),
        )
        return new_id

    # Top-level groups
    finance       = upsert_cat("Finance")
    food          = upsert_cat("Food & Drink")
    gifts         = upsert_cat("Gifts & Donations")
    health        = upsert_cat("Health & Fitness")
    household     = upsert_cat("Household")
    income_group  = upsert_cat("Income")
    other         = upsert_cat("Other")
    shopping      = upsert_cat("Shopping")
    entertainment = upsert_cat("Entertainment")
    transport     = upsert_cat("Transportation")
    travel        = upsert_cat("Travel")

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
    upsert_cat("Transfer", finance)

    upsert_cat("Charity", gifts)
    upsert_cat("Charity (not deductible)", gifts)
    upsert_cat("Gifts", gifts)

    upsert_cat("Gifts", income_group)
    upsert_cat("Interest", income_group)
    upsert_cat("Investment Income", income_group)
    upsert_cat("Paycheck", income_group)


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
