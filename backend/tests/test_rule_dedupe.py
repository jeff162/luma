# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Rule creation reconciles against an existing same-matcher rule instead of forking a duplicate.

Two rules sharing a matcher (keyword + owner + account + amount range + direction) can't coexist
cleanly, so create_rule classifies a collision as duplicate / mergeable / conflict and, by default,
reports it without writing. The bulk Generate Rules flow re-calls with on_existing='merge' to fold
mergeable saves in. A genuinely different matcher is not a collision and is created normally.

Fixture keywords avoid the seeded default rules so each case starts from a known matcher.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.rules import RuleCreate, RuleUpdate, create_rule, update_rule

KW = "fixture dedupe co"


class RuleDedupeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-dedupe.db"
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

    def _leaf(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE name = 'Food & Drink' AND parent_id IS NULL"
            ).fetchone()
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, 'expense', 0)",
                (category_id, group["id"], name),
            )
        return category_id

    def _tag(self, name: str) -> str:
        tag_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            sort_order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag").fetchone()[0]
            conn.execute("INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, '#22c55e', ?)", (tag_id, name, sort_order))
        return tag_id

    def _rule_count(self) -> int:
        with self._use_db_path(), get_db() as conn:
            return conn.execute("SELECT COUNT(*) FROM category_rule WHERE keyword = ?", (KW,)).fetchone()[0]

    def _rule_state(self, rule_id: str):
        with self._use_db_path(), get_db() as conn:
            row = conn.execute("SELECT category_id, clean_name FROM category_rule WHERE id = ?", (rule_id,)).fetchone()
            tags = {r["tag_id"] for r in conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (rule_id,)).fetchall()}
            return dict(row), tags

    def test_exact_duplicate_is_reported_not_created(self):
        coffee = self._leaf("Coffee")
        with self._use_db_path():
            first = create_rule(RuleCreate(keyword=KW, category_id=coffee))
            second = create_rule(RuleCreate(keyword=KW, category_id=coffee))
        self.assertEqual(first["status"], "created")
        self.assertEqual(second["status"], "duplicate")
        self.assertEqual(second["existing_rule_id"], first["id"])
        self.assertEqual(self._rule_count(), 1, "a pure duplicate must not insert a second row")

    def test_conflicting_category_is_reported_not_created(self):
        coffee = self._leaf("Coffee")
        dining = self._leaf("Dining")
        with self._use_db_path():
            first = create_rule(RuleCreate(keyword=KW, category_id=coffee))
            second = create_rule(RuleCreate(keyword=KW, category_id=dining))
        self.assertEqual(second["status"], "conflict")
        self.assertEqual(second["existing_rule_id"], first["id"])
        self.assertEqual(self._rule_count(), 1, "a conflicting save must not silently fork a rule")

    def test_added_tag_is_mergeable_and_merges_on_request(self):
        coffee = self._leaf("Coffee")
        essential = self._tag("Essential")
        with self._use_db_path():
            first = create_rule(RuleCreate(keyword=KW, category_id=coffee))
            # Default reject only classifies — it does not write the new tag.
            classified = create_rule(RuleCreate(keyword=KW, category_id=coffee, tag_ids=[essential]))
            self.assertEqual(classified["status"], "mergeable")
            # Re-call with merge to fold the tag into the existing rule.
            merged = create_rule(RuleCreate(keyword=KW, category_id=coffee, tag_ids=[essential]), on_existing="merge")
        self.assertEqual(merged["status"], "merged")
        self.assertEqual(merged["id"], first["id"])
        self.assertEqual(self._rule_count(), 1)
        _, tags = self._rule_state(first["id"])
        self.assertEqual(tags, {essential}, "merge must union the new tag into the existing rule")

    def test_merge_fills_a_missing_category(self):
        coffee = self._leaf("Coffee")
        with self._use_db_path():
            first = create_rule(RuleCreate(keyword=KW, clean_name="Fixture Dedupe Co"))
            merged = create_rule(RuleCreate(keyword=KW, category_id=coffee), on_existing="merge")
        self.assertEqual(merged["status"], "merged")
        state, _ = self._rule_state(first["id"])
        self.assertEqual(state["category_id"], coffee, "merge fills a category the existing rule lacked")

    def test_different_matcher_creates_distinct_rule(self):
        coffee = self._leaf("Coffee")
        with self._use_db_path():
            base = create_rule(RuleCreate(keyword=KW, category_id=coffee))
            scoped = create_rule(RuleCreate(keyword=KW, category_id=coffee, amount_min=10.0))
        self.assertEqual(scoped["status"], "created")
        self.assertNotEqual(scoped["id"], base["id"])
        self.assertEqual(self._rule_count(), 2, "an added amount constraint is a different matcher")

    def _exists(self, rule_id: str) -> bool:
        with self._use_db_path(), get_db() as conn:
            return conn.execute("SELECT 1 FROM category_rule WHERE id = ?", (rule_id,)).fetchone() is not None

    def test_edit_into_mergeable_collision_reports_then_merges_and_deletes(self):
        coffee = self._leaf("Coffee")
        essential = self._tag("Essential")
        with self._use_db_path():
            b = create_rule(RuleCreate(keyword="bbb merch", category_id=coffee))
            a = create_rule(RuleCreate(keyword="aaa merch", category_id=coffee, tag_ids=[essential]))
            # Edit A's keyword to collide with B; B has the category, A only adds a tag → mergeable.
            reported = update_rule(a["id"], RuleUpdate(keyword="bbb merch"))
            self.assertEqual(reported["status"], "mergeable")
            self.assertEqual(reported["existing_rule_id"], b["id"])
        self.assertTrue(self._exists(a["id"]), "a rejected edit must not delete the edited rule")
        with self._use_db_path():
            merged = update_rule(a["id"], RuleUpdate(keyword="bbb merch"), on_existing="merge")
        self.assertEqual(merged["status"], "merged")
        self.assertEqual(merged["id"], b["id"])
        self.assertEqual(merged["deleted_rule_id"], a["id"])
        self.assertFalse(self._exists(a["id"]), "merge folds the edited rule into the other and deletes it")
        _, tags_b = self._rule_state(b["id"])
        self.assertEqual(tags_b, {essential}, "the edited rule's tag is unioned into the surviving rule")

    def test_edit_into_conflict_is_reported_not_written(self):
        coffee = self._leaf("Coffee")
        dining = self._leaf("Dining")
        with self._use_db_path():
            b = create_rule(RuleCreate(keyword="bbb merch", category_id=coffee))
            a = create_rule(RuleCreate(keyword="aaa merch", category_id=dining))
            reported = update_rule(a["id"], RuleUpdate(keyword="bbb merch"))
        self.assertEqual(reported["status"], "conflict")
        self.assertEqual(reported["existing_rule_id"], b["id"])
        self.assertTrue(self._exists(a["id"]))
        state_a, _ = self._rule_state(a["id"])
        self.assertEqual(state_a["category_id"], dining, "a conflicting edit must not be written")

    def test_edit_without_collision_updates_normally(self):
        coffee = self._leaf("Coffee")
        dining = self._leaf("Dining")
        with self._use_db_path():
            a = create_rule(RuleCreate(keyword="aaa merch", category_id=coffee))
            res = update_rule(a["id"], RuleUpdate(category_id=dining))
        self.assertEqual(res["status"], "updated")
        state_a, _ = self._rule_state(a["id"])
        self.assertEqual(state_a["category_id"], dining)


if __name__ == "__main__":
    unittest.main()
