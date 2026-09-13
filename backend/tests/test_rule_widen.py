"""
*Widen to include*: the Rule checkup's one-click fix for a charge that drifted past a rule's amount range.

It moves the bound and re-applies the rule as **one** request. As a rule update followed by a separate
apply it could stop between the two. That is one explanation, never confirmed, for a state a user once
found: the bound moved, the charge still unclaimed, and the panel showing it as a near-edge warning at 0%.
The test that matters most here is therefore the one that breaks the apply and checks that the bound did
not move, since that half-done state is what the single request exists to rule out.

Driven through the API rather than the router function, because the transaction boundary is the property
under test and only a real request exercises it.
"""

from __future__ import annotations

import unittest
import uuid
from datetime import date
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db
from backend.tests._api_client import api_client


class RuleWidenTests(unittest.TestCase):
    def setUp(self):
        context = api_client()
        self.client, self.data_path = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        self.account_id = str(uuid.uuid4())
        self.cats: dict[str, str] = {}
        with get_db(db_path=self.data_path) as conn:
            conn.execute(
                "INSERT INTO account (id, provider, name, display_name, type) "
                "VALUES (?, 'fixture', 'Checking', 'Checking', 'depository')",
                (self.account_id,),
            )
            unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
            for label in ("Water", "Misc"):
                cid = str(uuid.uuid4())
                conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)", (cid, unassigned, label))
                self.cats[label] = cid

    # --- fixtures ---------------------------------------------------------------------------------

    def _rule(self, *, keyword="metro water", category="Water", amount_min=None, amount_max=None):
        rule_id = str(uuid.uuid4())
        with get_db(db_path=self.data_path) as conn:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, amount_min, amount_max) VALUES (?, ?, ?, ?, ?)",
                (rule_id, self.cats[category], keyword, amount_min, amount_max),
            )
        return rule_id

    def _txn(self, *, amount, payee="Metro Water", category=None, source=None):
        txn_id = str(uuid.uuid4())
        with get_db(db_path=self.data_path) as conn:
            conn.execute(
                """
                INSERT INTO txn (id, account_id, owner_id, category_id, category_source, amount, merchant_name,
                                 display_name, raw_name, date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (txn_id, self.account_id, SHARED_OWNER_ID, self.cats[category] if category else None, source,
                 amount, payee, payee, payee, date.today().isoformat()),
            )
        return txn_id

    def _rule_row(self, rule_id):
        with get_db(db_path=self.data_path) as conn:
            return conn.execute("SELECT amount_min, amount_max FROM category_rule WHERE id = ?", (rule_id,)).fetchone()

    def _txn_row(self, txn_id):
        with get_db(db_path=self.data_path) as conn:
            return conn.execute("SELECT category_id, category_source FROM txn WHERE id = ?", (txn_id,)).fetchone()

    def _widen(self, rule_id, bound, amount):
        return self.client.post(f"/api/rules/{rule_id}/widen", json={"bound": bound, "amount": amount})

    # --- the fix ----------------------------------------------------------------------------------

    def test_widening_moves_the_bound_and_claims_the_charge_in_one_request(self):
        rule_id = self._rule(amount_max=60.0)
        # The float a file's 63.40 can arrive as, which is what the demo's Metro Water charge carried.
        txn_id = self._txn(amount=63.39999999999999)
        self.assertEqual(self.client.get("/api/rules/range-drift").json()["counts"], {"rule_range": 1})

        response = self._widen(rule_id, "max", 63.4)
        self.assertEqual(response.status_code, 200, response.text)

        self.assertEqual(self._rule_row(rule_id)["amount_max"], 63.4)
        row = self._txn_row(txn_id)
        self.assertEqual((row["category_id"], row["category_source"]), (self.cats["Water"], "rule"))
        self.assertEqual(self.client.get("/api/rules/range-drift").json()["count"], 0,
                         "nothing is left for the checkup to report, not even a near-edge warning")

    def test_a_failure_part_way_leaves_the_rule_as_it_was(self):
        # All or nothing. Were the bound written in its own transaction, it would survive a failed apply,
        # leaving the half-done state a user once found by some route.
        rule_id = self._rule(amount_max=60.0)
        txn_id = self._txn(amount=63.40)
        with mock.patch("backend.routers.rules._apply_rule_to_existing", side_effect=RuntimeError("apply failed")):
            try:
                response = self._widen(rule_id, "max", 63.40)
            except RuntimeError:
                response = None
        if response is not None:
            self.assertEqual(response.status_code, 500)

        self.assertEqual(self._rule_row(rule_id)["amount_max"], 60.0, "the bound must not move without the re-apply")
        self.assertIsNone(self._txn_row(txn_id)["category_id"])

    def test_the_bound_is_rounded_outwards_so_the_charge_is_inside_it(self):
        max_rule = self._rule(keyword="harborline", amount_max=200.0)
        self.assertEqual(self._widen(max_rule, "max", 224.005).status_code, 200)
        self.assertEqual(self._rule_row(max_rule)["amount_max"], 224.01)

        min_rule = self._rule(keyword="northgate", amount_min=300.0)
        self.assertEqual(self._widen(min_rule, "min", -245.845).status_code, 200)
        self.assertEqual(self._rule_row(min_rule)["amount_min"], 245.84)

    def test_a_hand_categorization_is_left_alone(self):
        # Widening says which rows the rule should claim, not that a per-row decision was wrong.
        rule_id = self._rule(amount_max=60.0)
        manual = self._txn(amount=63.40, category="Misc", source="manual")
        self.assertEqual(self._widen(rule_id, "max", 63.40).status_code, 200)
        self.assertEqual(self._txn_row(manual)["category_id"], self.cats["Misc"])

    # --- what is refused --------------------------------------------------------------------------

    def test_narrowing_is_refused_and_writes_nothing(self):
        rule_id = self._rule(amount_max=60.0)
        self.assertEqual(self._widen(rule_id, "max", 50.0).status_code, 400)
        self.assertEqual(self._rule_row(rule_id)["amount_max"], 60.0)

    def test_a_widening_that_would_duplicate_another_rule_is_refused(self):
        # Two rules with one matcher is the collision a rule edit reports; this endpoint cannot resolve it.
        rule_id = self._rule(amount_max=60.0)
        self._rule(amount_max=63.4, category="Misc")
        self.assertEqual(self._widen(rule_id, "max", 63.40).status_code, 409)
        self.assertEqual(self._rule_row(rule_id)["amount_max"], 60.0)

    def test_an_unknown_rule_is_not_found(self):
        self.assertEqual(self._widen(str(uuid.uuid4()), "max", 10.0).status_code, 404)


if __name__ == "__main__":
    unittest.main()
