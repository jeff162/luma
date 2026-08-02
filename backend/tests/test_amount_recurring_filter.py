"""
Amount-magnitude and recurring-only filter coverage.

The Transactions ledger's amount popover narrows by ABS(amount) against a lower/upper bound with a
per-bound comparator (>=/> and <=/<), while the debit/credit *side* rides the existing `direction`
param — so the sign is applied separately from the magnitude, mirroring the category-rule amount
condition. The Recurring page's all-series report narrows by `recurring_only` (linked to any series).
These tests run the shared builder against a seeded DB so the semantics, not just the emitted SQL, are
guarded.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import _build_transaction_filter


class AmountRecurringFilterTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "amount-recurring-filter.db"
        init_db(str(self.db_path))
        self.ids = {}
        self._seed()

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                """,
                (account_id, f"plaid_{account_id}", "fixture_amount", name, name, SHARED_OWNER_ID),
            )
        return account_id

    def _insert_series(self, name: str) -> str:
        series_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO recurring_series (id, payee_key, display_name, cadence, period_days)
                VALUES (?, ?, ?, 'monthly', 30)
                """,
                (series_id, name.lower(), name),
            )
        return series_id

    def _insert_txn(self, *, key: str, account_id: str, amount: float, merchant: str,
                    recurring_series_id: str | None = None) -> None:
        txn_id = str(uuid.uuid4())
        self.ids[key] = txn_id
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO txn
                  (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name,
                   date, is_pending, category_overridden, recurring_series_id)
                VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '2026-04-10', 0, 0, ?)
                """,
                (txn_id, account_id, SHARED_OWNER_ID, amount, merchant, merchant, merchant, recurring_series_id),
            )

    def _seed(self):
        self.acct = self._insert_account("Checking")
        self.series = self._insert_series("Netflix")
        # Expense amounts are stored positive, income negative. Magnitudes span the bounds under test.
        self._insert_txn(key="d20", account_id=self.acct, amount=20.0, merchant="Small Debit")
        self._insert_txn(key="d50", account_id=self.acct, amount=50.0, merchant="Mid Debit")
        self._insert_txn(key="d200", account_id=self.acct, amount=200.0, merchant="Big Debit")
        self._insert_txn(key="c50", account_id=self.acct, amount=-50.0, merchant="Mid Credit")
        self._insert_txn(key="c200", account_id=self.acct, amount=-200.0, merchant="Big Credit")
        # A recurring debit of magnitude 50 (also exercises recurring + amount composition).
        self._insert_txn(key="rec50", account_id=self.acct, amount=50.0, merchant="Netflix",
                         recurring_series_id=self.series)

    def _matching_keys(self, **filter_kwargs) -> set[str]:
        clauses, params = _build_transaction_filter(**filter_kwargs)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._use_db_path(), get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT t.id
                FROM   txn t
                JOIN   account  a ON a.id = t.account_id
                LEFT JOIN account  p ON p.id = a.parent_account_id
                LEFT JOIN category c ON c.id = t.category_id
                LEFT JOIN category pc ON pc.id = c.parent_id
                {where}
                """,
                params,
            ).fetchall()
        found = {row["id"] for row in rows}
        return {key for key, txn_id in self.ids.items() if txn_id in found}

    # --- amount magnitude uses ABS, so a credit matches by its magnitude -------------------------

    def test_amount_min_matches_by_magnitude(self):
        # >= $50 keeps every row whose magnitude is at least 50 (both debits and credits).
        self.assertEqual(
            self._matching_keys(amount_min=50.0),
            {"d50", "d200", "c50", "c200", "rec50"},
        )

    def test_amount_max_matches_by_magnitude(self):
        self.assertEqual(
            self._matching_keys(amount_max=50.0),
            {"d20", "d50", "c50", "rec50"},
        )

    def test_amount_range(self):
        # A between-band: 50 <= |amount| <= 200 drops only the $20 debit.
        self.assertEqual(
            self._matching_keys(amount_min=50.0, amount_max=200.0),
            {"d50", "d200", "c50", "c200", "rec50"},
        )

    # --- comparators: strict vs inclusive --------------------------------------------------------

    def test_strict_lower_bound_excludes_boundary(self):
        # > $50 drops the exact-50 rows but keeps the 200s.
        self.assertEqual(self._matching_keys(amount_min=50.0, amount_min_op=">"), {"d200", "c200"})

    def test_strict_upper_bound_excludes_boundary(self):
        # < $50 keeps only the $20 debit.
        self.assertEqual(self._matching_keys(amount_max=50.0, amount_max_op="<"), {"d20"})

    def test_default_lower_bound_is_inclusive(self):
        # An unspecified/default op is inclusive (>=).
        self.assertIn("d50", self._matching_keys(amount_min=50.0, amount_min_op=">="))

    # --- side (direction) applies independently of magnitude -------------------------------------

    def test_debit_side_with_bound(self):
        # Debits only, >= $50 -> positive amounts with magnitude >= 50.
        self.assertEqual(
            self._matching_keys(amount_min=50.0, direction="debit"),
            {"d50", "d200", "rec50"},
        )

    def test_credit_side_with_bound(self):
        # Credits only, >= $50 -> negative amounts with magnitude >= 50.
        self.assertEqual(
            self._matching_keys(amount_min=50.0, direction="credit"),
            {"c50", "c200"},
        )

    def test_equals_via_matching_bounds(self):
        # The "Equals" mode sends min == max; = $50 across both sides.
        self.assertEqual(
            self._matching_keys(amount_min=50.0, amount_max=50.0),
            {"d50", "c50", "rec50"},
        )

    # --- recurring_only + composition ------------------------------------------------------------

    def test_recurring_only(self):
        self.assertEqual(self._matching_keys(recurring_only=True), {"rec50"})

    def test_recurring_only_false_is_noop(self):
        # A direct call with recurring_only=False (or unset) must not narrow anything.
        self.assertEqual(self._matching_keys(recurring_only=False), set(self.ids))

    def test_recurring_composes_with_amount(self):
        # Recurring AND > $100 has no member (the only recurring row is $50).
        self.assertEqual(self._matching_keys(recurring_only=True, amount_min=100.0), set())

    # --- recurring as a synthetic tag-filter selection (rides the shared tag facet) --------------

    def test_recurring_via_tag_filter_include(self):
        from backend.services.transaction_tags import RECURRING_FILTER_ID
        # Selecting the synthetic "Recurring" bucket in the tag filter matches only series-linked rows.
        self.assertEqual(self._matching_keys(tag_ids=RECURRING_FILTER_ID), {"rec50"})

    def test_recurring_via_tag_filter_exclude(self):
        from backend.services.transaction_tags import RECURRING_FILTER_ID
        # "≠ Recurring" is the NULL-safe complement — every non-recurring (one-off) row.
        self.assertEqual(
            self._matching_keys(exclude_tag_ids=RECURRING_FILTER_ID),
            {"d20", "d50", "d200", "c50", "c200"},
        )


if __name__ == "__main__":
    unittest.main()
