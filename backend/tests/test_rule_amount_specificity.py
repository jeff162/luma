"""
Rule precedence on the amount axis.

Two rules for one biller, split by size — bills over 300 are water, bills over 3000 are property tax —
is a natural way to model a town that sends several kinds of bill under one name. It used to categorize
the property tax as a water bill: the old specificity measure *counted* how many bounds a rule set, so
`>= 3000` and `>= 300` both scored one, every other term tied, and the winner fell out of whatever order
SQLite returned. Nothing in the app pinned it, so the same ledger could categorize differently after a
VACUUM.

The fix is to rank by the *span* of the range rather than the number of bounds, which is the same
argument the keyword rule already makes: `>= 3000` matches a strict subset of `>= 300`, exactly as a
longer keyword matches a strict subset of a shorter one. These tests pin the containment cases and the
deterministic tiebreak; ranges that merely overlap have no principled winner and are reported by the Rules
page's overlap check (`services/rule_overlaps.py`).
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.categorizer import categorize_transaction


class RuleAmountSpecificityTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-amount-specificity.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        self.cats: dict[str, str] = {}
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO account (id, provider, name, display_name, type) "
                    "VALUES (?, 'fixture', 'Checking', 'Checking', 'depository')",
                    (self.account_id,),
                )
                unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
                for label in ("Water", "Property Tax", "Parking"):
                    cid = str(uuid.uuid4())
                    conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)", (cid, unassigned, label))
                    self.cats[label] = cid

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _rule(self, *, category, amount_min=None, amount_max=None, keyword="town of harborline", rule_id=None):
        rule_id = rule_id or str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category_rule (id, category_id, keyword, amount_min, amount_max) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (rule_id, self.cats[category], keyword, amount_min, amount_max),
                )
        return rule_id

    def _categorize(self, amount, name="TOWN OF HARBORLINE"):
        with self._use_db_path():
            with get_db() as conn:
                result = categorize_transaction(name, name, amount, conn, owner_id=SHARED_OWNER_ID)
        if not result:
            return None
        for label, cid in self.cats.items():
            if cid == result["category_id"]:
                return label
        return result["category_id"]

    def test_the_narrower_open_range_wins(self):
        # The reported case. Both rules match a 3618.14 charge; only one of them is about property tax.
        self._rule(category="Water", amount_min=300)
        self._rule(category="Property Tax", amount_min=3000)
        self.assertEqual(self._categorize(-3618.14), "Property Tax")
        # ...and the water bill still lands in Water, which is the half a naive "narrowest always wins"
        # would break.
        self.assertEqual(self._categorize(-412.90), "Water")

    def test_insertion_order_does_not_decide_it(self):
        # Same pair, declared the other way round. The old ordering had no tiebreak below the condition
        # count, so which rule won depended on the order rows came back in.
        self._rule(category="Property Tax", amount_min=3000)
        self._rule(category="Water", amount_min=300)
        self.assertEqual(self._categorize(-3618.14), "Property Tax")

    def test_a_bounded_range_beats_the_open_one_containing_it(self):
        # The user's own fix for the case above: cap the broad rule so the two are disjoint. Capped or
        # not, the narrower rule must win where they still overlap.
        self._rule(category="Water", amount_min=300, amount_max=3000)
        self._rule(category="Property Tax", amount_min=3000)
        self.assertEqual(self._categorize(-3618.14), "Property Tax")
        self.assertEqual(self._categorize(-2900.00), "Water")

    def test_a_range_inside_another_wins_on_both_bounds(self):
        self._rule(category="Water", amount_min=100, amount_max=5000)
        self._rule(category="Parking", amount_min=200, amount_max=260)
        self.assertEqual(self._categorize(-225.00), "Parking")
        self.assertEqual(self._categorize(-900.00), "Water")

    def test_any_bounded_rule_beats_an_unbounded_one(self):
        self._rule(category="Water")
        self._rule(category="Property Tax", amount_min=3000)
        self.assertEqual(self._categorize(-3618.14), "Property Tax")
        self.assertEqual(self._categorize(-42.00), "Water")

    def test_a_longer_keyword_still_outranks_a_narrower_range(self):
        # Amount narrowness ranks *below* keyword length: the name stays the stronger discriminator, so
        # a rule naming the specific bill wins over a broad rule with a tight range.
        self._rule(category="Property Tax", amount_min=3600, amount_max=3700)
        self._rule(category="Water", keyword="town of harborline water")
        self.assertEqual(self._categorize(-3618.14, name="TOWN OF HARBORLINE WATER DEPT"), "Water")

    def test_a_genuine_tie_resolves_the_same_way_every_time(self):
        # Identical rules but for their category. Nothing distinguishes them, so the answer is arbitrary
        # — but it must be *stable*, or a VACUUM can silently recategorize a ledger.
        self._rule(category="Water", amount_min=300, rule_id="aaaa-rule")
        self._rule(category="Parking", amount_min=300, rule_id="bbbb-rule")
        first = self._categorize(-500.00)
        self.assertEqual(first, "Water")  # lowest id, deterministically
        for _ in range(3):
            self.assertEqual(self._categorize(-500.00), first)
