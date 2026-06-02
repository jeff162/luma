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
    BatchRuleSuggestionMatchRequest,
    BatchRuleSuggestionReviewUpdateRequest,
    _get_system_rule_suggestion_review_state,
    _save_system_rule_suggestion_review_state,
    _set_batch_imported_category_usage,
    get_system_rule_suggestion_matches,
    get_system_rule_suggestions,
    update_system_rule_suggestion_review,
)
from backend.routers.rules import (
    ApplyToTransactionsBody,
    RuleCreate,
    apply_rule_to_transactions,
    create_rule,
)
from backend.routers.transactions import CategoryOverride, set_imported_category


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

    def test_matches_report_includes_manually_reconciled_rows_unflagged(self):
        account_id = self._insert_account("Card")
        streaming = self._insert_expense_leaf("Streaming Services")
        entertainment = self._insert_expense_leaf("Entertainment & Recreation")
        batch_id = self._insert_import_batch()
        # Majority Streaming (from file); one still-Entertainment (from file); and one the user has
        # deliberately kept on Entertainment, now category_source = 'manual'. The manual one differs from
        # the Streaming reference on purpose, so it exercises the manual-not-flagged path.
        self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=streaming, merchant_name="Paramount+", amount=-11.99)
        from_file_entertainment = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=entertainment, merchant_name="Paramount+", amount=-11.99)
        reconciled_id = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=entertainment, merchant_name="Paramount+", amount=-11.99)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_source = 'manual', category_overridden = 1 WHERE id = ?",
                    (reconciled_id,),
                )

        with self._use_db_path():
            result = get_system_rule_suggestion_matches(
                BatchRuleSuggestionMatchRequest(keyword="Paramount+", reference_target_category_id=streaming)
            )

        rows = {row["id"]: row for row in result["transactions"]}
        # The manually-decided row stays in the report rather than vanishing...
        self.assertEqual(result["count"], 3)
        self.assertIn(reconciled_id, rows)
        self.assertEqual(rows[reconciled_id]["category_source"], "manual")
        # ...and is not flagged as a conflict even though it differs from the reference (it's settled),
        # while the still-from-file row on the same category remains flagged.
        self.assertFalse(rows[reconciled_id]["conflicts_with_reference"])
        self.assertTrue(rows[from_file_entertainment]["conflicts_with_reference"])

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

    def test_reconciled_manual_rows_reinforce_import_backed_suggestion_count(self):
        account_id = self._insert_account("Card")
        streaming = self._insert_expense_leaf("FixtureStreaming")
        batch_id = self._insert_import_batch()
        # Three file-derived Streaming rows, plus two the user reconciled onto Streaming (now 'manual').
        for _ in range(3):
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=streaming, merchant_name="Paramount Plus", amount=-11.99)
        reconciled = [
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=streaming, merchant_name="Paramount Plus", amount=-11.99)
            for _ in range(2)
        ]
        with self._use_db_path():
            with get_db() as conn:
                conn.executemany(
                    "UPDATE txn SET category_source = 'manual', category_overridden = 1 WHERE id = ?",
                    [(rid,) for rid in reconciled],
                )

        with self._use_db_path():
            result = get_system_rule_suggestions("")

        streaming_suggestions = [s for s in result["suggestions"] if s["target_category_name"] == "FixtureStreaming"]
        self.assertEqual(len(streaming_suggestions), 1)
        self.assertFalse(streaming_suggestions[0]["needs_resolution"])
        # The reconciled manual rows count toward the suggestion, not just the file-derived ones.
        self.assertEqual(streaming_suggestions[0]["txn_count"], 5)

    def test_preserved_manual_only_category_does_not_create_a_conflict(self):
        account_id = self._insert_account("Card")
        rideshare = self._insert_expense_leaf("FixtureRideshare")
        travel = self._insert_expense_leaf("FixtureTravel")
        batch_id = self._insert_import_batch()
        # Majority Rideshare from the file; one row the user Preserved on a different category (manual).
        for _ in range(3):
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=rideshare, merchant_name="Uber Trip", amount=-23.40)
        preserved = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=travel, merchant_name="Uber Trip", amount=-23.40)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_source = 'manual', category_overridden = 1 WHERE id = ?",
                    (preserved,),
                )

        with self._use_db_path():
            result = get_system_rule_suggestions("")

        # The Preserved row's category has no file-derived backing, so it neither spawns its own
        # suggestion nor re-creates a conflict — only the file-derived Rideshare suggestion stands.
        self.assertEqual(len(result["suggestions"]), 1)
        self.assertEqual(result["suggestions"][0]["target_category_name"], "FixtureRideshare")
        self.assertFalse(result["suggestions"][0]["needs_resolution"])


    def test_recategorizing_import_rows_collapses_the_conflict(self):
        account_id = self._insert_account("Primary Checking")
        trash_id = self._insert_expense_leaf("FixtureTrash")
        home_services_id = self._insert_expense_leaf("FixtureHomeServices")
        batch_id = self._insert_import_batch()
        for _ in range(4):
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=trash_id, merchant_name="Black Earth Compost", amount=-69.99)
        home_rows = [
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=home_services_id, merchant_name="Black Earth Compost", amount=-44.99)
            for _ in range(3)
        ]

        with self._use_db_path():
            before = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "black earth compost"]
        # The same merchant is split across two competing import-backed categories — a conflict.
        self.assertEqual(len(before), 2)
        self.assertEqual(
            sorted(s["target_category_name"] for s in before),
            ["FixtureHomeServices", "FixtureTrash"],
        )

        with self._use_db_path():
            for row_id in home_rows:
                set_imported_category(row_id, CategoryOverride(category_id=trash_id))
            after = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "black earth compost"]

        # Re-pinning the minority rows as a corrected file categorization (kept as import) collapses the
        # conflict onto the single surviving suggestion, which now covers every matching row.
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0]["target_category_name"], "FixtureTrash")
        self.assertFalse(after[0]["needs_resolution"])
        self.assertEqual(after[0]["txn_count"], 7)

    def test_recategorized_import_row_survives_trust_flag_retoggle(self):
        account_id = self._insert_account("Primary Checking")
        trash_id = self._insert_expense_leaf("FixtureTrash")
        home_services_id = self._insert_expense_leaf("FixtureHomeServices")
        batch_id = self._insert_import_batch()
        row_id = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=home_services_id, merchant_name="Black Earth Compost", amount=-44.99)

        with self._use_db_path():
            set_imported_category(row_id, CategoryOverride(category_id=trash_id))
            # Re-deriving import rows from their recorded file label (what toggling "trust this batch"
            # does) must land on the recategorized target, not the original file category — because the
            # recategorize rewrote imported_category to match.
            with get_db() as conn:
                _set_batch_imported_category_usage(conn, batch_id, True)
                row = conn.execute("SELECT category_id, category_source FROM txn WHERE id = ?", (row_id,)).fetchone()

        self.assertEqual(row["category_id"], trash_id)
        self.assertEqual(row["category_source"], "import")

    def test_apply_rule_to_transactions_scopes_to_listed_rows_and_skips_manual(self):
        account_id = self._insert_account("Card")
        streaming = self._insert_expense_leaf("FixtureStreaming2")
        other = self._insert_expense_leaf("FixtureOther")
        batch_id = self._insert_import_batch()
        src1 = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=other, merchant_name="Zorptech Widgets", amount=-15.99)
        src2 = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=other, merchant_name="Zorptech Widgets", amount=-15.99)
        preserved = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=other, merchant_name="Zorptech Widgets", amount=-15.99)
        bystander = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=other, merchant_name="Zorptech Widgets", amount=-15.99)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_source = 'manual', category_overridden = 1 WHERE id = ?",
                    (preserved,),
                )

        with self._use_db_path():
            created = create_rule(RuleCreate(keyword="zorptech widgets", category_id=streaming))
            self.assertEqual(created["status"], "created")
            # Accept applies to exactly the suggestion's own rows — and even though we list the preserved
            # row, preserve_manual leaves it alone; the bystander row isn't listed at all.
            apply_rule_to_transactions(
                created["id"],
                ApplyToTransactionsBody(transaction_ids=[src1, src2, preserved]),
            )
            with get_db() as conn:
                cats = {
                    row["id"]: (row["category_id"], row["category_source"])
                    for row in conn.execute("SELECT id, category_id, category_source FROM txn").fetchall()
                }

        self.assertEqual(cats[src1], (streaming, "rule"))
        self.assertEqual(cats[src2], (streaming, "rule"))
        # The Preserved (manual) row is untouched even though it was in the apply set.
        self.assertEqual(cats[preserved], (other, "manual"))
        # The row that wasn't part of this suggestion is left alone, not reassigned.
        self.assertEqual(cats[bystander], (other, "import"))


if __name__ == "__main__":
    unittest.main()
