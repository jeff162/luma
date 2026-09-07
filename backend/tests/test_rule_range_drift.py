"""
Charges an amount-gated rule nearly claimed.

The finding is cheap to state and easy to get subtly wrong, so what is pinned here is the set of
judgments that decide whether it is *useful*: near enough to be drift rather than a different bill,
still worth reporting once the row landed somewhere else, and said once per drifted range rather than
once per row that hit it.

Two of these exist because the surface moved to the Rules page. A rule that gates on amount is worth
maintaining whether or not it feeds a recurring series, and a dismissal must not consume the per-rule
cap — dismissing what is on screen would otherwise silence the rule while further drifted charges sat
behind it.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.rule_range_drift import PER_RULE_CAP, find_range_drift
from backend.services.signal_dismissals import dismiss, restore


class RuleRangeDriftTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-range-drift.db"
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
                for label in ("Insurance", "Water", "Misc"):
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

    # --- fixtures ---------------------------------------------------------------------------------

    def _txn(self, *, payee, category, amount, when=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (txn_id, self.account_id, SHARED_OWNER_ID, self.cats[category], amount,
                     payee, payee, payee, (when or date.today()).isoformat()),
                )
        return txn_id

    def _ranged_rule(self, *, keyword, category, amount_min=None, amount_max=None, is_managed=0):
        rule_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category_rule (id, category_id, keyword, amount_min, amount_max, is_managed) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (rule_id, self.cats[category], keyword, amount_min, amount_max, is_managed),
                )
        return rule_id

    def _rule_series(self, rule_id, *, name):
        series_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO recurring_series (id, payee_key, display_name, category_id, cadence,
                                                  period_days, source, rule_id, confirmed)
                    VALUES (?, ?, ?, ?, 'monthly', 30, 'rule', ?, 1)
                    """,
                    (series_id, name.lower(), name, self.cats["Insurance"], rule_id),
                )
        return series_id

    def _findings(self, kind=None, *, include_dismissed=False):
        with self._use_db_path():
            with get_db() as conn:
                result = find_range_drift(conn, include_dismissed=include_dismissed)
        if kind is None:
            return result
        return [f for f in result["findings"] if f["kind"] == kind]

    def _dismiss(self, finding):
        with self._use_db_path():
            with get_db() as conn:
                dismiss(conn, finding["key"], finding["kind"])

    # --- what qualifies ---------------------------------------------------------------------------

    def test_charge_just_over_a_rules_maximum_is_reported(self):
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0)

        findings = self._findings("rule_range")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["bound"], "max")
        self.assertEqual(findings[0]["severity"], "warning")
        self.assertEqual(findings[0]["current_category_name"], "Misc")
        self.assertEqual(findings[0]["percent"], 12.0)

    def test_a_charge_far_outside_the_range_is_not_a_drifted_range(self):
        # 3x the limit is a different bill, not a range that needs widening.
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=600.0)
        self.assertEqual(self._findings("rule_range"), [])

    def test_a_row_already_carrying_the_rules_category_is_not_reported(self):
        # Whatever the range says, nothing about this row went wrong.
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Insurance", amount=224.0)
        self.assertEqual(self._findings("rule_range"), [])

    def test_a_charge_inside_but_near_the_limit_is_the_quieter_warning(self):
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=195.0)

        findings = self._findings("rule_range_edge")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["severity"], "info")

    def test_a_stale_near_miss_is_not_a_task(self):
        # A range that drifted last year is history; only recent rows are actionable.
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0,
                  when=date.today() - timedelta(days=200))
        self.assertEqual(self._findings("rule_range"), [])

    def test_an_app_managed_rules_bounds_are_not_the_users_to_maintain(self):
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0, is_managed=1)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0)
        self.assertEqual(self._findings()["count"], 0)

    def test_only_the_most_recent_few_near_misses_of_one_rule_are_reported(self):
        # One drifted range says one thing; it should not say it once per matching row.
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        for i in range(6):
            self._txn(payee="Harborline Mutual", category="Misc", amount=224.0,
                      when=date.today() - timedelta(days=i))
        findings = self._findings("rule_range")
        self.assertEqual(len(findings), PER_RULE_CAP)
        # Most recent first, so the cap keeps the charges worth acting on rather than the oldest three.
        self.assertEqual([f["txn_date"] for f in findings],
                         [(date.today() - timedelta(days=i)).isoformat() for i in range(PER_RULE_CAP)])

    # --- a rule finding, not a series one ---------------------------------------------------------

    def test_a_rule_with_no_series_still_reports(self):
        # The whole reason this lives with the rules: an amount range is a matching gate whether or not
        # anything recurs behind it, and both actions the finding offers edit the rule.
        self._ranged_rule(keyword="metro water", category="Water", amount_max=60.0)
        self._txn(payee="Metro Water", category="Misc", amount=63.40)

        findings = self._findings("rule_range")
        self.assertEqual(len(findings), 1)
        self.assertIsNone(findings[0]["series_name"])

    def test_a_finding_names_the_series_its_rule_feeds(self):
        # Display only, and the reason the finding matters beyond one category: the charge fell out of
        # that series too.
        rule_id = self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._rule_series(rule_id, name="Harborline Mutual")
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0)

        findings = self._findings("rule_range")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["series_name"], "Harborline Mutual")

    # --- dismissal --------------------------------------------------------------------------------

    def test_dismissal_hides_one_finding_and_counts_it(self):
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0)
        self._dismiss(self._findings("rule_range")[0])

        result = self._findings()
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["dismissed_count"], 1)

    def test_show_dismissed_returns_it_flagged_without_counting_it_as_work(self):
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0)
        self._dismiss(self._findings("rule_range")[0])

        result = self._findings(include_dismissed=True)
        self.assertEqual(len(result["findings"]), 1)
        self.assertTrue(result["findings"][0]["dismissed"])
        self.assertEqual(result["count"], 0, "an acknowledged finding is not open work while it is shown")

    def test_restoring_a_dismissal_brings_the_finding_back(self):
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0)
        finding = self._findings("rule_range")[0]
        self._dismiss(finding)
        with self._use_db_path():
            with get_db() as conn:
                restore(conn, finding["key"])
        self.assertEqual(len(self._findings("rule_range")), 1)

    def test_a_dismissal_does_not_use_up_the_per_rule_cap(self):
        # Dismissing what is on screen must not silence the rule: the cap limits how much one drifted
        # range says at once, and acknowledging three charges is not acknowledging the fourth.
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        for i in range(PER_RULE_CAP + 2):
            self._txn(payee="Harborline Mutual", category="Misc", amount=224.0,
                      when=date.today() - timedelta(days=i))

        for finding in self._findings("rule_range"):
            self._dismiss(finding)

        still_open = self._findings("rule_range")
        self.assertEqual(len(still_open), 2)
        self.assertEqual(self._findings()["dismissed_count"], PER_RULE_CAP)

    def test_a_dismissal_is_keyed_to_the_one_charge(self):
        # Two charges of the same amount against the same rule are two findings; acknowledging one says
        # nothing about the other.
        self._ranged_rule(keyword="harborline", category="Insurance", amount_max=200.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0)
        self._txn(payee="Harborline Mutual", category="Misc", amount=224.0,
                  when=date.today() - timedelta(days=30))
        self._dismiss(self._findings("rule_range")[0])
        self.assertEqual(len(self._findings("rule_range")), 1)


if __name__ == "__main__":
    unittest.main()
