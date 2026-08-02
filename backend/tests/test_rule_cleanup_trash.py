"""
Stale-rule support: last_effect_date stamping, the rules trash (soft-delete/restore/purge), and the
cleanup-candidates query. All data is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path,
)
from backend.routers.rules import (
    RuleCreate, create_rule_core, delete_rule, restore_rule, purge_rule, list_rules,
    list_trashed_rules, cleanup_candidates, cleanup_rules, RuleCleanupBody, apply_rule,
)
from backend.services.categorizer import recategorize_all


class RuleCleanupTrashTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "cleanup.db"
        init_db(str(self.db_path))
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('acc', 'p_acc', 'fix', 'acc', 'acc', 'depository', ?)""",
                (SHARED_OWNER_ID,),
            )
            grp = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'G', 'expense')", (grp,))
            self.cat = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'A', 'expense')", (self.cat, grp))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _txn(self, merchant, d):
        tid = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                   VALUES (?, 'acc', ?, 5.00, ?, ?, ?, ?, 0)""",
                (tid, SHARED_OWNER_ID, merchant, merchant, merchant, d),
            )
        return tid

    def _rule(self, keyword, **kw):
        with self._use_db(), get_db() as conn:
            return create_rule_core(conn, RuleCreate(keyword=keyword, category_id=self.cat, **kw))

    def _rule_field(self, rule_id, field):
        with self._use_db(), get_db() as conn:
            row = conn.execute(f"SELECT {field} FROM category_rule WHERE id = ?", (rule_id,)).fetchone()
        return row[field] if row else None

    # --- last_effect_date stamping -------------------------------------------

    def test_recategorize_stamps_newest_owned_date(self):
        self._txn("Amazon Prime", "2023-01-10")
        self._txn("Amazon Fresh", "2024-06-20")  # newest
        rid = self._rule("amazon")["id"]
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        self.assertEqual(self._rule_field(rid, "last_effect_date"), "2024-06-20")

    def test_stamp_is_monotonic_forward(self):
        self._txn("Amazon Fresh", "2024-06-20")
        rid = self._rule("amazon")["id"]
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        # An older matching row must not pull the date backward.
        self._txn("Amazon Prime", "2019-01-01")
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        self.assertEqual(self._rule_field(rid, "last_effect_date"), "2024-06-20")

    def test_apply_stamps_last_effect_date(self):
        self._txn("Netflix", "2025-02-02")
        rid = self._rule("netflix")["id"]
        with self._use_db():
            apply_rule(rid)
        self.assertEqual(self._rule_field(rid, "last_effect_date"), "2025-02-02")

    # --- post-restore data-init (run the data half of newer migrations after a restore) ----------

    def _seed_then_wipe_date(self):
        self._txn("Amazon Prime", "2024-05-05")
        rid = self._rule("amazon")["id"]
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
            conn.execute("UPDATE category_rule SET last_effect_date = NULL WHERE id = ?", (rid,))
        return rid

    def test_post_restore_runs_v15_data_init_for_older_backup(self):
        from backend.db.database import run_post_restore_data_init
        rid = self._seed_then_wipe_date()
        with self._use_db(), get_db() as conn:
            run_post_restore_data_init(conn, 14)  # backup at v14 → only v15's data-init runs
        self.assertEqual(self._rule_field(rid, "last_effect_date"), "2024-05-05")

    def test_post_restore_skips_when_backup_is_current(self):
        from backend.db.database import run_post_restore_data_init
        rid = self._seed_then_wipe_date()
        with self._use_db(), get_db() as conn:
            run_post_restore_data_init(conn, 15)  # already current → nothing runs
        self.assertIsNone(self._rule_field(rid, "last_effect_date"))

    def test_post_restore_unknown_version_runs_all(self):
        from backend.db.database import run_post_restore_data_init
        rid = self._seed_then_wipe_date()
        with self._use_db(), get_db() as conn:
            run_post_restore_data_init(conn, None)  # pre-rebrand/unknown → treated as v1 → runs all
        self.assertEqual(self._rule_field(rid, "last_effect_date"), "2024-05-05")

    def test_backfill_credits_row_the_rule_wins_even_if_import_sourced(self):
        # The bug behind rules reading "never used" / a stale date: a row the rule *wins* but whose category
        # was set by import (not the rule firing) must still count toward last_effect_date.
        from backend.db.database import run_post_restore_data_init
        tid = self._txn("LAZ Parking", "2026-05-07")
        rid = self._rule("laz parking")["id"]
        with self._use_db(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET category_id = ?, category_source = 'import' WHERE id = ?", (self.cat, tid))
            conn.execute("UPDATE category_rule SET last_effect_date = NULL WHERE id = ?", (rid,))
        with self._use_db(), get_db() as conn:
            run_post_restore_data_init(conn, None)  # re-run the (corrected) backfill
        self.assertEqual(self._rule_field(rid, "last_effect_date"), "2026-05-07")

    def test_stamp_batch_rule_effects(self):
        # The per-batch stamp used by the two import re-categorize paths that don't stamp inline.
        from backend.routers.import_export.core import stamp_batch_rule_effects
        tid = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO import_batch (id, filename, imported_at, row_count, skipped_count, deduped_count, status, use_imported_categories)
                   VALUES ('b1', 'f.csv', datetime('now'), 1, 0, 0, 'complete', 0)""")
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending, import_batch_id)
                   VALUES (?, 'acc', ?, 5.00, 'Amazon Prime', 'Amazon Prime', 'Amazon Prime', '2025-03-03', 0, 'b1')""",
                (tid, SHARED_OWNER_ID))
        rid = self._rule("amazon")["id"]
        with self._use_db(), get_db() as conn:
            stamp_batch_rule_effects(conn, "b1")
        self.assertEqual(self._rule_field(rid, "last_effect_date"), "2025-03-03")

    # --- trash / restore / purge ---------------------------------------------

    def test_trash_soft_deletes_and_stops_categorizing(self):
        self._txn("Amazon Prime", "2024-01-01")
        rid = self._rule("amazon")["id"]
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        with self._use_db():
            delete_rule(rid)  # trash (no reconcile → categorizations retained)
        self.assertIsNotNone(self._rule_field(rid, "deleted_at"))
        # Excluded from the active list…
        with self._use_db():
            active = list_rules(search=None)
        self.assertEqual(active, [])
        # …and from categorization: a fresh matching row is left uncategorized.
        new_txn = self._txn("Amazon Later", "2024-08-08")
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
            cat = conn.execute("SELECT category_id FROM txn WHERE id = ?", (new_txn,)).fetchone()["category_id"]
        self.assertIsNone(cat)

    def test_trashed_matcher_is_free_to_recreate(self):
        a = self._rule("amazon")
        with self._use_db():
            delete_rule(a["id"])
        # Same matcher is no longer a collision (the trashed one is ignored) → created fresh.
        b = self._rule("amazon")
        self.assertEqual(b["status"], "created")
        self.assertNotEqual(a["id"], b["id"])

    def test_restore_brings_it_back(self):
        rid = self._rule("amazon")["id"]
        with self._use_db():
            delete_rule(rid)
            restore_rule(rid)
        self.assertIsNone(self._rule_field(rid, "deleted_at"))
        with self._use_db():
            self.assertEqual(len(list_rules(search=None)), 1)

    def test_restore_refused_on_active_matcher_clash(self):
        from fastapi import HTTPException
        a = self._rule("amazon")
        with self._use_db():
            delete_rule(a["id"])
        self._rule("amazon")  # recreate active same-matcher rule
        with self._use_db():
            with self.assertRaises(HTTPException) as ctx:
                restore_rule(a["id"])
        self.assertEqual(ctx.exception.status_code, 409)

    def test_purge_hard_deletes(self):
        rid = self._rule("amazon")["id"]
        with self._use_db():
            delete_rule(rid)
            purge_rule(rid)
        with self._use_db(), get_db() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM category_rule WHERE id = ?", (rid,)).fetchone())

    def test_trash_listing(self):
        rid = self._rule("amazon")["id"]
        with self._use_db():
            delete_rule(rid)
            trashed = list_trashed_rules()
        self.assertEqual([r["id"] for r in trashed], [rid])

    # --- cleanup candidates ---------------------------------------------------

    def test_cleanup_candidates_old_and_never_used(self):
        self._txn("Amazon Prime", "2020-01-01")
        old = self._rule("amazon")["id"]          # last effect 2020
        self._txn("Netflix", str(date.today()))
        fresh = self._rule("netflix")["id"]        # last effect today
        never = self._rule("nordstrom")["id"]      # never applied (no matching txn) → NULL
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        with self._use_db():
            res = cleanup_candidates(before="2022-01-01")
        ids = {r["id"] for r in res["rules"]}
        self.assertIn(old, ids)
        self.assertIn(never, ids)     # NULL last_effect_date counts as stale
        self.assertNotIn(fresh, ids)  # newer than the threshold
        self.assertEqual(res["count"], len(res["rules"]))

    def test_cleanup_excludes_managed_rules(self):
        self._txn("Amazon Prime", "2020-01-01")
        rid = self._rule("amazon")["id"]
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
            conn.execute("UPDATE category_rule SET is_managed = 1 WHERE id = ?", (rid,))
        with self._use_db():
            res = cleanup_candidates(before="2022-01-01")
        self.assertNotIn(rid, {r["id"] for r in res["rules"]})

    def test_cleanup_trashes_the_set_but_not_managed(self):
        self._txn("Amazon Prime", "2020-01-01")
        a = self._rule("amazon")["id"]
        b = self._rule("nordstrom")["id"]
        with self._use_db(), get_db() as conn:
            conn.execute("UPDATE category_rule SET is_managed = 1 WHERE id = ?", (b,))
        with self._use_db():
            result = cleanup_rules(RuleCleanupBody(rule_ids=[a, b]))
        self.assertEqual(result["trashed"], 1)  # only the non-managed one
        self.assertIsNotNone(self._rule_field(a, "deleted_at"))
        self.assertIsNone(self._rule_field(b, "deleted_at"))


if __name__ == "__main__":
    unittest.main()
