"""Starter-set endpoints: categories and rules are opt-in (init seeds only the group skeleton), so these
cover that the catalog is offered, that generate-starter creates exactly the requested subset, that every
catalog rule resolves to a seeded leaf (no rule targets a missing category), and that re-running is a no-op."""

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.categories import GenerateStarterSet, generate_starter_set, list_starter_rules
from backend.routers.rules import RuleCreate, create_rule_core
from backend.services.categorizer import DEFAULT_RULE_SEEDS


class StarterSetTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "starter.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _counts(self):
        with self._use_db_path(), get_db() as conn:
            leaves = conn.execute("SELECT COUNT(*) FROM category WHERE parent_id IS NOT NULL").fetchone()[0]
            rules = conn.execute("SELECT COUNT(*) FROM category_rule").fetchone()[0]
        return leaves, rules

    def test_fresh_db_has_skeleton_but_no_starter_leaves_or_rules(self):
        leaves, rules = self._counts()
        self.assertEqual((leaves, rules), (0, 0))

    def test_catalog_lists_every_starter_rule(self):
        with self._use_db_path():
            payload = list_starter_rules()
        self.assertEqual(len(payload["rules"]), len(DEFAULT_RULE_SEEDS))
        sample = payload["rules"][0]
        self.assertEqual(set(sample), {"keyword", "category_name"})

    def test_generate_categories_only_adds_leaves_not_rules(self):
        with self._use_db_path():
            result = generate_starter_set(GenerateStarterSet(include_leaves=True))
        leaves, rules = self._counts()
        self.assertGreater(result["categories_added"], 0)
        self.assertEqual(result["rules_added"], 0)
        self.assertEqual(leaves, result["categories_added"])
        self.assertEqual(rules, 0)

    def test_every_catalog_rule_resolves_to_a_seeded_leaf(self):
        # Passing all catalog keywords must create all of them — proves no rule targets a missing leaf
        # (guards against a catalog rule whose target leaf isn't in the seed — it would be silently skipped).
        all_keywords = [keyword for keyword, *_rest in DEFAULT_RULE_SEEDS]
        with self._use_db_path():
            result = generate_starter_set(GenerateStarterSet(rule_keywords=all_keywords))
        self.assertEqual(result["rules_added"], len(DEFAULT_RULE_SEEDS))

    def test_rule_subset_creates_only_selected_and_seeds_their_leaves(self):
        with self._use_db_path():
            result = generate_starter_set(
                GenerateStarterSet(include_leaves=False, rule_keywords=["netflix", "spotify", "bogus"])
            )
        # Two real keywords created; the unknown is ignored. Leaves were seeded even though
        # include_leaves was False, because the selected rules need their target categories.
        self.assertEqual(result["rules_added"], 2)
        self.assertGreater(result["categories_added"], 0)
        with self._use_db_path(), get_db() as conn:
            created = conn.execute(
                "SELECT COUNT(*) FROM category_rule WHERE keyword IN ('netflix', 'spotify')"
            ).fetchone()[0]
        self.assertEqual(created, 2)

    def test_regenerating_is_idempotent(self):
        with self._use_db_path():
            generate_starter_set(GenerateStarterSet(include_leaves=True, rule_keywords=["netflix"]))
            again = generate_starter_set(GenerateStarterSet(include_leaves=True, rule_keywords=["netflix"]))
        self.assertEqual(again["categories_added"], 0)
        self.assertEqual(again["rules_added"], 0)

    def _live_rules(self, keyword):
        with self._use_db_path(), get_db() as conn:
            return conn.execute(
                "SELECT category_id FROM category_rule WHERE keyword = ? AND deleted_at IS NULL", (keyword,)
            ).fetchall()

    def test_a_users_rule_on_the_matcher_is_left_alone(self):
        # One live rule per matcher: a starter rule must not fork a second one beside the user's.
        with self._use_db_path():
            generate_starter_set(GenerateStarterSet(include_leaves=True))
            with get_db() as conn:
                other = conn.execute(
                    "SELECT id FROM category WHERE parent_id IS NOT NULL AND name <> 'Salary' LIMIT 1"
                ).fetchone()["id"]
                create_rule_core(conn, RuleCreate(keyword="payroll", category_id=other))
            result = generate_starter_set(GenerateStarterSet(rule_keywords=["payroll"]))
        self.assertEqual(result["rules_added"], 0)
        self.assertEqual([row["category_id"] for row in self._live_rules("payroll")], [other])

    def test_a_trashed_starter_rule_does_not_block_adding_it_again(self):
        with self._use_db_path():
            generate_starter_set(GenerateStarterSet(rule_keywords=["netflix"]))
            with get_db() as conn:
                conn.execute("UPDATE category_rule SET deleted_at = datetime('now') WHERE keyword = 'netflix'")
            result = generate_starter_set(GenerateStarterSet(rule_keywords=["netflix"]))
        self.assertEqual(result["rules_added"], 1)
        self.assertEqual(len(self._live_rules("netflix")), 1)


if __name__ == "__main__":
    unittest.main()
