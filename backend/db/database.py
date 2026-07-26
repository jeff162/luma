# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Primary application database: schema and seeding for each tenant DB.

This file owns the durable model the routers and services share. Its key guarantees
are that fresh databases are created directly in the current shape, existing ones are
advanced in place by `run_migrations`, and core invariants like leaf-only transaction
categories and the built-in shared owner are re-established on startup. The migration
chain is currently empty — it was reset to the baseline (v1) at the Luma rebrand (see
CURRENT_VERSION); future schema changes register migrations from there.
"""

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from backend.app_logging import log_info

DB_PATH = os.getenv("DB_PATH", "luma-data.db")
_current_db_path: ContextVar[str | None] = ContextVar("luma_current_db_path", default=None)
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

CURRENT_VERSION = 17

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
            row["merchant_name"], row["raw_name"], row["display_name"], row["amount"], conn,
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
        log_info(f"[db] rule last_effect_date backfill skipped ({exc}); will populate on next categorization")


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
            row["merchant_name"], row["raw_name"], row["display_name"], row["amount"], conn,
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
            log_info(f"[db] applying migration v{version}...")
            MIGRATIONS[version](conn)
            set_db_version(conn, version)
    log_info(f"[db] database is now at version {CURRENT_VERSION}")


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


def get_tenant_workflow_state(conn, key: str) -> dict:
    """Read a shared (tenant-wide, not per-user) state blob from `import_workflow_state`. This is the
    one place app-wide *data state* lives that is neither a transaction-graph row nor a per-user
    preference — e.g. the demo marker, the category-workspace draft, and the dashboard tag-report
    catalog. Returns {} when absent or un-parseable."""
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
                -- Optional multi-clause merchant matcher (JSON) that supersedes the single-substring
                -- `keyword` when present: {"op":"and","clauses":[{"type":"contains","text":"…"}, …]}.
                -- v1 is AND-only / contains-only — every clause's text must be a substring of the row's
                -- name (or source text). `keyword` mirrors the sorted, joined clause texts so search and
                -- LENGTH-based specificity ordering keep working; NULL match_expr = a plain keyword rule.
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
                is_managed INTEGER NOT NULL DEFAULT 0
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
                recurring_series_id      TEXT REFERENCES recurring_series(id) ON DELETE SET NULL
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
            -- undoing that import removes its parked items. See routers/import_export/amazon.py.
            CREATE TABLE IF NOT EXISTS amazon_pending_item (
                order_id         TEXT PRIMARY KEY,
                items_json       TEXT NOT NULL,
                source_file      TEXT,
                source_file_hash TEXT,
                parked_batch_id  TEXT,
                created_at       TEXT NOT NULL DEFAULT (datetime('now'))
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
                enrich_from_source   INTEGER NOT NULL DEFAULT 0,
                use_imported_categories INTEGER NOT NULL DEFAULT 0,
                notes                TEXT,
                source_kind          TEXT,
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
                config_snapshot  TEXT,
                -- Provenance class of the import, for history grouping. NULL = an ordinary CSV import;
                -- 'marketplace:<vendor>' (e.g. 'marketplace:amazon') marks a dedicated marketplace
                -- importer's batch so the history groups it under that vendor instead of "unknown source".
                source_kind      TEXT,
                -- Cached Amazon reconciliation "attention" count (a duplicate/split to resolve), with the
                -- global recon epoch (db_meta 'recon_epoch') it was computed at. Recomputed lazily only when
                -- the batch's epoch trails the current one; see amazon.reconciliation_attention_count and the
                -- recon-epoch triggers created after run_migrations. NULL = never computed.
                recon_attention_count INTEGER,
                recon_epoch      INTEGER
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
                updated_at        TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_recurring_series_payee ON recurring_series(payee_key);
            -- Surgical, scan-durable membership corrections layered over the derived/rule matcher:
            -- 'pinned' forces a row into a series it wouldn't otherwise match; 'excluded' keeps a
            -- matched row out. Reconcile applies these every scan so they survive a rebuild.
            CREATE TABLE IF NOT EXISTS recurring_membership_override (
                txn_id     TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                series_id  TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
                state      TEXT NOT NULL,
                PRIMARY KEY (txn_id, series_id)
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

            -- Amazon funding-source → account map (see docs/backlog/paypal-amazon-enrichment.md →
            -- "funding-source → account mapping"). Keys an Amazon payment instrument (a card last-4 +
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
        init_merchant_renames(conn)

        _seed_default_categories(conn)

        if is_fresh_db:
            _alphabetize_top_level_category_groups(conn)
            set_db_version(conn, CURRENT_VERSION)
            log_info(f"[db] created new database at schema version {CURRENT_VERSION}")
        else:
            # Advance an existing database in place. init_db's schema is all `CREATE TABLE IF NOT
            # EXISTS`, so structural changes belong in registered migrations, which run here.
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
        # A transaction can be pinned to at most one series (membership is exclusive). Excludes are not
        # constrained — a row can be excluded from more than one candidate series.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_override_pin ON recurring_membership_override(txn_id) WHERE state = 'pinned'"
        )
        _create_recon_epoch_triggers(conn)
        ensure_shared_owner(conn)


# The Amazon reconciliation attention count (a duplicate charge to merge, or a split suggestion to
# confirm) is surfaced per batch in the import history and summed into the Tasks nag — both read paths, hit
# often. Computing it live per batch runs the whole reconciliation, so it is cached on the batch and
# recomputed lazily only when stale (see amazon.reconciliation_attention_count). "Stale" is a single
# monotonic epoch in db_meta ('recon_epoch'): any write to a table the reconciliation reads bumps it, and a
# batch whose stored recon_epoch trails it is recomputed on the next read.
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


def _create_recon_epoch_triggers(conn: sqlite3.Connection) -> None:
    """Create (idempotently) the triggers that bump db_meta 'recon_epoch' on any write to a table the
    Amazon reconciliation reads. Runs after run_migrations so every referenced table — including the ones a
    migration adds (amazon_funding_map, amazon_charge_distinct, amazon_charge_reviewed) — and db_meta exist
    on both fresh and migrated databases."""
    for table, events in _RECON_EPOCH_SOURCE_TABLES.items():
        for event in events:
            conn.execute(f"""
                CREATE TRIGGER IF NOT EXISTS trg_recon_epoch_{table}_{event.lower()}
                AFTER {event} ON {table}
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END
            """)


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
