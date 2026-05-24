# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Import rule suggestion review coverage.

These tests protect the review-state cleanup that happens when a user broadens
an accepted import suggestion. Covered sibling suggestions should move to the
discarded pile, but narrower owner/account/amount-scoped acceptances must not
discard broader suggestions they do not actually replace.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import (
    BatchRuleSuggestionReviewUpdateRequest,
    _get_system_rule_suggestion_review_state,
    _save_system_rule_suggestion_review_state,
    get_system_rule_suggestions,
    update_system_rule_suggestion_review,
)


class ImportRuleSuggestionReviewTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "import-rule-suggestion-review.db"
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

    def _save_review_state(self, review_state: dict) -> None:
        with self._use_db_path():
            with get_db() as conn:
                _save_system_rule_suggestion_review_state(conn, review_state)

    def _load_review_state(self) -> dict:
        with self._use_db_path():
            with get_db() as conn:
                return _get_system_rule_suggestion_review_state(conn)

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (
                        account_id,
                        f"plaid_{account_id}",
                        "fixture_import_rules",
                        name,
                        name,
                        "checking",
                        "checking",
                        "1234",
                        SHARED_OWNER_ID,
                    ),
                )
        return account_id

    def _insert_expense_leaf(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                expense_group = conn.execute(
                    "SELECT id FROM category WHERE category_type = 'expense' AND parent_id IS NULL ORDER BY sort_order, name LIMIT 1"
                ).fetchone()
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order)
                    VALUES (?, ?, ?, 'expense', 0)
                    """,
                    (category_id, expense_group["id"], name),
                )
        return category_id

    def _insert_import_batch(self) -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO import_batch
                      (id, filename, imported_at, row_count, skipped_count, deduped_count, config_snapshot, status, use_imported_categories)
                    VALUES (?, 'fixture.csv', '2026-04-27T12:00:00', 3, 0, 0, '{}', 'completed', 1)
                    """,
                    (batch_id,),
                )
        return batch_id

    def _insert_import_transaction(self, *, batch_id: str, account_id: str, category_id: str, merchant_name: str, amount: float) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, imported_category, date, is_pending, category_overridden, category_source, import_batch_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Groceries', '2026-04-27', 0, 0, 'import', ?)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, category_id, amount, merchant_name, merchant_name, merchant_name, batch_id),
                )
        return txn_id

    def _seed_monthly_import_transactions(self, *, batch_id: str, account_id: str, category_id: str, merchant_name: str, amounts: list[float], start_year: int = 2025) -> None:
        with self._use_db_path():
            with get_db() as conn:
                for index, amount in enumerate(amounts):
                    txn_id = str(uuid.uuid4())
                    year = start_year + (index // 12)
                    month = (index % 12) + 1
                    conn.execute(
                        """
                        INSERT INTO txn
                          (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, imported_category, date, is_pending, category_overridden, category_source, import_batch_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'import', ?)
                        """,
                        (
                            txn_id,
                            account_id,
                            SHARED_OWNER_ID,
                            category_id,
                            amount,
                            merchant_name,
                            merchant_name,
                            merchant_name,
                            merchant_name,
                            f"{year}-{month:02d}-15",
                            batch_id,
                        ),
                    )

    def test_accepting_broader_keyword_discards_covered_same_category_variants(self):
        self._save_review_state({
            "suggestions": {
                "wholefds": {
                    "keyword": "wholefds",
                    "target_category_id": "groceries",
                    "target_category_name": "Groceries",
                },
                "wholefds brklne": {
                    "keyword": "wholefds brklne",
                    "target_category_id": "groceries",
                    "target_category_name": "Groceries",
                },
                "wholefds newton": {
                    "keyword": "wholefds newton",
                    "target_category_id": "groceries",
                    "target_category_name": "Groceries",
                },
                "wholefds wine": {
                    "keyword": "wholefds wine",
                    "target_category_id": "alcohol",
                    "target_category_name": "Alcohol",
                },
            },
            "statuses": {},
        })

        with self._use_db_path():
            result = update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="wholefds",
                status="accepted",
                keyword="wholefds",
                target_category_id="groceries",
                target_category_name="Groceries",
            ))

        self.assertEqual(
            sorted(result["auto_discarded_suggestion_ids"]),
            ["wholefds brklne", "wholefds newton"],
        )

        review_state = self._load_review_state()
        self.assertEqual(review_state["statuses"]["wholefds"]["status"], "accepted")
        self.assertEqual(review_state["statuses"]["wholefds brklne"]["status"], "discarded")
        self.assertEqual(review_state["statuses"]["wholefds newton"]["status"], "discarded")
        self.assertNotIn("wholefds wine", review_state["statuses"])

    def test_accepting_narrower_account_scoped_keyword_does_not_discard_broader_match(self):
        self._save_review_state({
            "suggestions": {
                "wholefds acct1": {
                    "keyword": "wholefds acct1",
                    "target_category_id": "groceries",
                    "target_category_name": "Groceries",
                    "account_id": "acct-1",
                },
                "wholefds": {
                    "keyword": "wholefds",
                    "target_category_id": "groceries",
                    "target_category_name": "Groceries",
                },
            },
            "statuses": {},
        })

        with self._use_db_path():
            result = update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="wholefds acct1",
                status="accepted",
                keyword="wholefds acct1",
                target_category_id="groceries",
                target_category_name="Groceries",
                account_id="acct-1",
            ))

        self.assertEqual(result["auto_discarded_suggestion_ids"], [])

        review_state = self._load_review_state()
        self.assertEqual(review_state["statuses"]["wholefds acct1"]["status"], "accepted")
        self.assertNotIn("wholefds", review_state["statuses"])

    def test_accepting_stricter_amount_rule_creates_pending_follow_up_suggestion_for_leftover_rows(self):
        account_id = self._insert_account("Primary Checking")
        category_id = self._insert_expense_leaf("Groceries")
        batch_id = self._insert_import_batch()
        txn_ids = [
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=category_id, merchant_name="WHOLEFDS BRKLNE", amount=10.99),
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=category_id, merchant_name="WHOLEFDS BRKLNE", amount=20.00),
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=category_id, merchant_name="WHOLEFDS BRKLNE", amount=30.00),
        ]
        source_suggestion_id = "wholefds brklne:__global__:" + category_id
        self._save_review_state({
            "suggestions": {
                source_suggestion_id: {
                    "keyword": "wholefds brklne",
                    "merchant_label": "WHOLEFDS BRKLNE",
                    "target_category_id": category_id,
                    "target_category_name": "Groceries",
                    "source_row_ids": txn_ids,
                },
            },
            "statuses": {},
        })

        with self._use_db_path():
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id=source_suggestion_id,
                status="accepted",
                keyword="wholefds brklne",
                merchant_label="WHOLEFDS BRKLNE",
                target_category_id=category_id,
                target_category_name="Groceries",
                amount_min=10.99,
                amount_max=10.99,
            ))
            result = get_system_rule_suggestions("")

        follow_up = next(
            (
                suggestion for suggestion in result["suggestions"]
                if suggestion["id"] == f"{source_suggestion_id}:followup:{source_suggestion_id}"
            ),
            None,
        )
        self.assertIsNotNone(follow_up)
        self.assertEqual(follow_up["review_status"], "pending")
        self.assertEqual(follow_up["txn_count"], 2)
        self.assertIsNone(follow_up["amount_min"])
        self.assertIsNone(follow_up["amount_max"])

    def test_conflicting_sibling_below_threshold_still_surfaces_in_pending_conflict_set(self):
        account_id = self._insert_account("Primary Checking")
        trash_id = self._insert_expense_leaf("Trash removal")
        home_services_id = self._insert_expense_leaf("Home Services")
        batch_id = self._insert_import_batch()

        self._seed_monthly_import_transactions(
            batch_id=batch_id,
            account_id=account_id,
            category_id=trash_id,
            merchant_name="Black Earth Compost",
            amounts=[69.99, 30.79, 44.99, 69.99],
            start_year=2025,
        )
        self._seed_monthly_import_transactions(
            batch_id=batch_id,
            account_id=account_id,
            category_id=home_services_id,
            merchant_name="Black Earth Compost",
            amounts=[69.99, 30.79, 44.99],
            start_year=2025,
        )

        with self._use_db_path():
            result = get_system_rule_suggestions("")

        black_earth = [
            suggestion for suggestion in result["suggestions"]
            if suggestion["keyword"] == "black earth compost"
        ]
        self.assertEqual(len(black_earth), 2)
        self.assertTrue(all(suggestion["needs_resolution"] for suggestion in black_earth))
        self.assertEqual(
            sorted(suggestion["target_category_name"] for suggestion in black_earth),
            ["Home Services", "Trash removal"],
        )
        self.assertTrue(all(suggestion["review_status"] == "pending" for suggestion in black_earth))


if __name__ == "__main__":
    unittest.main()
