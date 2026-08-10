"""
Import rule suggestion review coverage.

These tests protect the review-state cleanup that happens when a user broadens
an accepted import suggestion. Covered sibling suggestions should move to the
discarded pile, but narrower owner/account/amount-scoped acceptances must not
discard broader suggestions they do not actually replace.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import (
    BatchRuleSuggestionMatchRequest,
    BatchRuleSuggestionMatchRefineRequest,
    BatchRuleSuggestionReviewUpdateRequest,
    RuleSuggestionDebugTraceRequest,
    _get_system_rule_suggestion_review_state,
    _save_system_rule_suggestion_review_state,
    _set_batch_imported_category_usage,
    clear_system_rule_suggestions,
    get_batch_rule_suggestion_matches,
    get_profile_rule_suggestion_matches,
    get_system_rule_suggestion_matches,
    get_system_rule_suggestions,
    refine_system_rule_suggestion_match,
    restore_system_rule_suggestion_trash_set,
    RuleSuggestionClearRequest,
    update_system_rule_suggestion_review,
    write_rule_suggestion_debug_trace,
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

    def _insert_account(self, name: str, owner_id: str = SHARED_OWNER_ID) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
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
                        owner_id,
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

    def _insert_import_profile(self, name: str = "Fixture Profile") -> str:
        profile_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO csv_import_profile (id, name, column_map)
                    VALUES (?, ?, '{}')
                    """,
                    (profile_id, name),
                )
        return profile_id

    def _assign_batch_to_profile(self, batch_id: str, profile_id: str) -> None:
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE import_batch SET profile_id = ? WHERE id = ?", (profile_id, batch_id))

    def _insert_tag(self, name: str) -> str:
        tag_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, '#22c55e', 0)",
                    (tag_id, name),
                )
        return tag_id

    def _insert_import_transaction(
        self,
        *,
        batch_id: str,
        account_id: str,
        category_id: str,
        merchant_name: str,
        amount: float,
        owner_id: str = SHARED_OWNER_ID,
        imported_category: str = "Groceries",
        import_evidence_json: str | None = None,
    ) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, imported_category, date, is_pending, category_overridden, category_source, import_batch_id, import_evidence_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-04-27', 0, 0, 'import', ?, ?)
                    """,
                    (
                        txn_id,
                        account_id,
                        owner_id,
                        category_id,
                        amount,
                        merchant_name,
                        merchant_name,
                        merchant_name,
                        imported_category,
                        batch_id,
                        import_evidence_json,
                    ),
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

    # --- undo / data-less restore invariants -----------------------------------------------------
    # Undo replays only {suggestion_id, status} (no entry data). The review endpoints `setdefault` an
    # entry for whatever id they're given, so a data-less call could persist an empty `{}` card and
    # inflate total_count (the summary counts len(suggestions)). These pin the guard that prevents it.

    def test_dataless_status_update_does_not_create_phantom_entry(self):
        self._save_review_state({
            "suggestions": {"alpha": {"merchant_label": "Alpha", "keyword": "alpha", "source_row_ids": ["r1"]}},
            "statuses": {"alpha": {"status": "accepted"}},
        })
        with self._use_db_path():
            result = update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="ghost", status="accepted",
            ))
        self.assertEqual(result["review_summary"]["total_count"], 1)
        self.assertEqual(result["review_summary"]["accepted_count"], 1)
        state = self._load_review_state()
        self.assertNotIn("ghost", state["suggestions"])
        self.assertNotIn("ghost", state["statuses"])

    def test_returning_to_pending_drops_entry_back_to_generated_pool(self):
        # Undo of an accept returns the suggestion to pending; it must leave the persisted review so it
        # regenerates from live rows (real row count + sort position) instead of lingering as a pending
        # shell — the cause of the "doesn't come back to the top" report.
        self._save_review_state({
            "suggestions": {"alpha": {"merchant_label": "Alpha", "keyword": "alpha", "source_row_ids": ["r1"]}},
            "statuses": {"alpha": {"status": "accepted"}},
        })
        with self._use_db_path():
            result = update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="alpha", status="pending",
            ))
        self.assertEqual(result["review_summary"]["total_count"], 0)
        state = self._load_review_state()
        self.assertNotIn("alpha", state["suggestions"])
        self.assertNotIn("alpha", state["statuses"])

    def test_returning_synthetic_followup_to_pending_keeps_it(self):
        # A synthetic follow-up has no live rows to regenerate from, so unlike a normal suggestion it
        # must survive a return to pending rather than vanishing.
        self._save_review_state({
            "suggestions": {"syn": {"merchant_label": "Syn", "keyword": "syn", "synthetic": True, "source_row_ids": ["r2"]}},
            "statuses": {},
        })
        with self._use_db_path():
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="syn", status="pending",
            ))
        state = self._load_review_state()
        self.assertIn("syn", state["suggestions"])

    def test_accepted_review_state_persists_owned_rule_and_row_restore_snapshot(self):
        account_id = self._insert_account("Card")
        leaf = self._insert_expense_leaf("FixtureAcceptedOwnedRule")
        batch_id = self._insert_import_batch()
        row_id = self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_id,
            category_id=leaf,
            merchant_name="Owned Rule Merchant",
            amount=-12.34,
        )
        suggestion_id = f"owned rule merchant:__global__:{leaf}"
        prior_rows = [{
            "id": row_id,
            "category_id": leaf,
            "category_source": "import",
            "category_overridden": 0,
        }]
        rule_id = str(uuid.uuid4())
        self._save_review_state({
            "suggestions": {
                suggestion_id: {
                    "keyword": "owned rule merchant",
                    "merchant_label": "Owned Rule Merchant",
                    "target_category_id": leaf,
                    "target_category_name": "FixtureAcceptedOwnedRule",
                    "source_row_ids": [row_id],
                },
            },
            "statuses": {},
        })
        with self._use_db_path():
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id=suggestion_id,
                status="accepted",
                rule_id=rule_id,
                created_rule_id=rule_id,
                accepted_prior_rows=prior_rows,
                keyword="owned rule merchant",
                merchant_label="Owned Rule Merchant",
                target_category_id=leaf,
                target_category_name="FixtureAcceptedOwnedRule",
            ))
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_source = 'rule', category_overridden = 0 WHERE id = ?",
                    (row_id,),
                )
            result = get_system_rule_suggestions("")

        state = self._load_review_state()
        status = state["statuses"][suggestion_id]
        self.assertEqual(status["rule_id"], rule_id)
        self.assertEqual(status["created_rule_id"], rule_id)
        self.assertEqual(status["accepted_prior_rows"], prior_rows)
        accepted = [suggestion for suggestion in result["suggestions"] if suggestion["id"] == suggestion_id]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["review_status"], "accepted")
        self.assertEqual(accepted[0]["rule_id"], rule_id)
        self.assertEqual(accepted[0]["created_rule_id"], rule_id)
        self.assertEqual(accepted[0]["accepted_prior_rows"], prior_rows)

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

    def test_refining_pending_conflict_match_repartitions_the_card_and_persists_the_split(self):
        account_id = self._insert_account("Primary Checking")
        trash_id = self._insert_expense_leaf("FixtureTrashSplit")
        home_services_id = self._insert_expense_leaf("FixtureHomeServicesSplit")
        batch_id = self._insert_import_batch()
        for amount in [69.99, 69.99, 69.99, 69.99]:
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=trash_id, merchant_name="Black Earth Compost", amount=amount)
        for amount in [69.99, 44.99, 44.99]:
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=home_services_id, merchant_name="Black Earth Compost", amount=amount)

        with self._use_db_path():
            before = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "black earth compost"]
        self.assertEqual(len(before), 2)

        with self._use_db_path():
            refine_system_rule_suggestion_match(BatchRuleSuggestionMatchRefineRequest(
                source_suggestions=[
                    {
                        "id": suggestion["id"],
                        "merchant_label": suggestion["merchant_label"],
                        "target_category_id": suggestion["target_category_id"],
                        "target_category_name": suggestion["target_category_name"],
                        "source_row_ids": suggestion["source_row_ids"],
                    }
                    for suggestion in before
                ],
                keyword="black earth compost",
                amount_min=44.99,
                amount_max=44.99,
            ))
            after = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "black earth compost"]
            after_again = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "black earth compost"]

        unsuffixed = [s for s in after if ":followup:" not in s["id"]]
        self.assertEqual(len(unsuffixed), 2)
        refined = [
            s for s in unsuffixed
            if s["target_category_name"] == "FixtureHomeServicesSplit"
        ]
        self.assertEqual(len(refined), 1)
        self.assertEqual(refined[0]["txn_count"], 2)
        self.assertEqual(refined[0]["amount_min"], 44.99)
        self.assertEqual(refined[0]["amount_max"], 44.99)
        self.assertEqual(refined[0]["review_status"], "pending")

        followups = [s for s in after if ":followup:" in s["id"]]
        self.assertEqual(len(followups), 1)
        self.assertEqual(followups[0]["txn_count"], 1)
        self.assertTrue(all(s["review_status"] == "pending" for s in followups))
        self.assertTrue(all(s["conflict_group_id"] == "black earth compost:__global__" for s in followups))
        original_source_ids = set().union(*(set(suggestion["source_row_ids"]) for suggestion in before))
        refined_source_ids = set().union(*(set(suggestion["source_row_ids"]) for suggestion in unsuffixed))
        followup_source_ids = set().union(*(set(suggestion["source_row_ids"]) for suggestion in followups))
        self.assertFalse(refined_source_ids & followup_source_ids)
        self.assertEqual(refined_source_ids | followup_source_ids, original_source_ids)
        canonical_remainder = [
            s for s in after
            if s["target_category_name"] == "FixtureTrashSplit" and ":followup:" not in s["id"]
        ]
        self.assertEqual(len(canonical_remainder), 1)
        self.assertEqual(canonical_remainder[0]["txn_count"], 4)
        self.assertEqual(
            sorted(suggestion["id"] for suggestion in after),
            sorted(suggestion["id"] for suggestion in after_again),
        )

    def test_refined_owner_conflict_recombines_equivalent_remainders_across_owners(self):
        owner_a = str(uuid.uuid4())
        owner_b = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.executemany(
                "INSERT INTO owner (id, name) VALUES (?, ?)",
                [(owner_a, "Owner A"), (owner_b, "Owner B")],
            )
        account_a = self._insert_account("Owner A Card", owner_a)
        account_b = self._insert_account("Owner B Card", owner_b)
        payment = self._insert_expense_leaf("FixtureCardPayment")
        membership = self._insert_expense_leaf("FixtureMembership")
        batch_id = self._insert_import_batch()

        for _ in range(102):
            self._insert_import_transaction(
                batch_id=batch_id,
                account_id=account_a,
                owner_id=owner_a,
                category_id=payment,
                imported_category="FixtureCardPayment",
                merchant_name="Riverstone",
                amount=100,
            )
        for _ in range(54):
            self._insert_import_transaction(
                batch_id=batch_id,
                account_id=account_b,
                owner_id=owner_b,
                category_id=payment,
                imported_category="FixtureCardPayment",
                merchant_name="Riverstone",
                amount=100,
            )
        self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_b,
            owner_id=owner_b,
            category_id=membership,
            imported_category="FixtureMembership",
            merchant_name="Riverstone",
            amount=100,
            import_evidence_json=json.dumps({
                "description": {"value": "annual renewal membership fee"},
            }),
        )

        with self._use_db_path():
            before = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "riverstone"]
        owner_a_suggestions = [s for s in before if s["owner_id"] == owner_a]
        owner_b_suggestions = [s for s in before if s["owner_id"] == owner_b]
        self.assertEqual(len(owner_a_suggestions), 1)
        self.assertEqual(owner_a_suggestions[0]["txn_count"], 102)
        self.assertEqual(len(owner_b_suggestions), 2)
        self.assertTrue(all(s["needs_resolution"] for s in owner_b_suggestions))

        with self._use_db_path():
            refine_system_rule_suggestion_match(BatchRuleSuggestionMatchRefineRequest(
                source_suggestions=[
                    {
                        "id": suggestion["id"],
                        "merchant_label": suggestion["merchant_label"],
                        "target_category_id": suggestion["target_category_id"],
                        "target_category_name": suggestion["target_category_name"],
                        "owner_id": suggestion["owner_id"],
                        "owner_name": suggestion["owner_name"],
                        "source_row_ids": suggestion["source_row_ids"],
                    }
                    for suggestion in owner_b_suggestions
                ],
                keyword="renewal",
                owner_id=owner_b,
                match_source_text=True,
            ))
            after = get_system_rule_suggestions("")["suggestions"]

        payment_suggestions = [
            s for s in after
            if s["keyword"] == "riverstone" and s["target_category_id"] == payment
        ]
        self.assertEqual(len(payment_suggestions), 1)
        self.assertEqual(payment_suggestions[0]["txn_count"], 156)
        self.assertIsNone(payment_suggestions[0]["owner_id"])
        membership_suggestions = [
            s for s in after
            if s["keyword"] == "renewal" and s["target_category_id"] == membership
        ]
        self.assertEqual(len(membership_suggestions), 1)
        self.assertEqual(membership_suggestions[0]["txn_count"], 1)
        self.assertEqual(membership_suggestions[0]["owner_id"], owner_b)

    def test_accepting_refined_split_keeps_followup_pending_with_its_own_rows(self):
        owner_a = str(uuid.uuid4())
        owner_b = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.executemany(
                "INSERT INTO owner (id, name) VALUES (?, ?)",
                [(owner_a, "Owner A"), (owner_b, "Owner B")],
            )
        account_a = self._insert_account("Owner A Card", owner_a)
        account_b = self._insert_account("Owner B Card", owner_b)
        pharmacy = self._insert_expense_leaf("FixturePharmacy")
        batch_id = self._insert_import_batch()

        for _ in range(3):
            self._insert_import_transaction(
                batch_id=batch_id,
                account_id=account_a,
                owner_id=owner_a,
                category_id=pharmacy,
                imported_category="FixturePharmacy",
                merchant_name="Walgreens",
                amount=25,
            )
        for _ in range(2):
            self._insert_import_transaction(
                batch_id=batch_id,
                account_id=account_b,
                owner_id=owner_b,
                category_id=pharmacy,
                imported_category="FixturePharmacy",
                merchant_name="WALGREENS #13081",
                amount=25,
            )

        with self._use_db_path():
            before = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "walgreens"]
        self.assertEqual(len(before), 1)
        self.assertEqual(before[0]["txn_count"], 5)

        with self._use_db_path():
            refine_system_rule_suggestion_match(BatchRuleSuggestionMatchRefineRequest(
                source_suggestions=[
                    {
                        "id": before[0]["id"],
                        "merchant_label": before[0]["merchant_label"],
                        "target_category_id": before[0]["target_category_id"],
                        "target_category_name": before[0]["target_category_name"],
                        "source_row_ids": before[0]["source_row_ids"],
                    }
                ],
                keyword="walgreens",
                owner_id=owner_a,
            ))
            split = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "walgreens"]

        refined = [s for s in split if ":followup:" not in s["id"]]
        followups = [s for s in split if ":followup:" in s["id"]]
        self.assertEqual(len(refined), 1)
        self.assertEqual(len(followups), 1)
        self.assertEqual(refined[0]["owner_id"], owner_a)
        self.assertEqual(refined[0]["txn_count"], 3)
        self.assertEqual(followups[0]["txn_count"], 2)

        with self._use_db_path(), get_db() as conn:
            conn.executemany(
                "UPDATE txn SET category_source = 'rule', category_overridden = 0 WHERE id = ?",
                [(row_id,) for row_id in refined[0]["source_row_ids"]],
            )
            conn.commit()

        with self._use_db_path():
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id=refined[0]["id"],
                status="accepted",
                rule_id="fixture-rule-id",
                created_rule_id="fixture-rule-id",
                merchant_label=refined[0]["merchant_label"],
                target_category_id=refined[0]["target_category_id"],
                target_category_name=refined[0]["target_category_name"],
                keyword=refined[0]["keyword"],
                owner_id=refined[0]["owner_id"],
                source_row_ids=refined[0]["source_row_ids"],
                txn_count=refined[0]["txn_count"],
                latest_txn_date=refined[0]["latest_txn_date"],
            ))
            after = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "walgreens"]

        accepted = [s for s in after if s["review_status"] == "accepted"]
        pending = [s for s in after if s["review_status"] == "pending"]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["id"], refined[0]["id"])
        self.assertEqual(accepted[0]["owner_id"], owner_a)
        self.assertEqual(accepted[0]["txn_count"], 3)
        self.assertEqual(len(pending), 1)
        self.assertIn(":followup:", pending[0]["id"])
        self.assertEqual(pending[0]["txn_count"], 2)

    def test_broadening_refined_match_rejoins_canonical_conflict_generation(self):
        owner_a = str(uuid.uuid4())
        owner_b = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.executemany(
                "INSERT INTO owner (id, name) VALUES (?, ?)",
                [(owner_a, "Owner A"), (owner_b, "Owner B")],
            )
        account_a = self._insert_account("Owner A Card", owner_a)
        account_b = self._insert_account("Owner B Card", owner_b)
        payment = self._insert_expense_leaf("FixtureCardPaymentBroaden")
        membership = self._insert_expense_leaf("FixtureMembershipBroaden")
        batch_id = self._insert_import_batch()

        for _ in range(102):
            self._insert_import_transaction(
                batch_id=batch_id,
                account_id=account_a,
                owner_id=owner_a,
                category_id=payment,
                imported_category="FixtureCardPaymentBroaden",
                merchant_name="Riverstone",
                amount=100,
            )
        for _ in range(54):
            self._insert_import_transaction(
                batch_id=batch_id,
                account_id=account_b,
                owner_id=owner_b,
                category_id=payment,
                imported_category="FixtureCardPaymentBroaden",
                merchant_name="Riverstone",
                amount=100,
            )
        self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_b,
            owner_id=owner_b,
            category_id=membership,
            imported_category="FixtureMembershipBroaden",
            merchant_name="Riverstone",
            amount=100,
            import_evidence_json=json.dumps({
                "description": {"value": "annual renewal membership fee"},
            }),
        )

        with self._use_db_path():
            initial = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "riverstone"]
        owner_b_suggestions = [s for s in initial if s["owner_id"] == owner_b]
        self.assertEqual(len(owner_b_suggestions), 2)

        with self._use_db_path():
            refine_system_rule_suggestion_match(BatchRuleSuggestionMatchRefineRequest(
                source_suggestions=[
                    {
                        "id": suggestion["id"],
                        "merchant_label": suggestion["merchant_label"],
                        "target_category_id": suggestion["target_category_id"],
                        "target_category_name": suggestion["target_category_name"],
                        "owner_id": suggestion["owner_id"],
                        "owner_name": suggestion["owner_name"],
                        "source_row_ids": suggestion["source_row_ids"],
                    }
                    for suggestion in owner_b_suggestions
                ],
                keyword="renewal",
                owner_id=owner_b,
                match_source_text=True,
            ))
            narrowed = get_system_rule_suggestions("")["suggestions"]

        narrowed_membership = [
            s for s in narrowed
            if s["keyword"] == "renewal" and s["target_category_id"] == membership
        ]
        self.assertEqual(len(narrowed_membership), 1)
        self.assertEqual(narrowed_membership[0]["txn_count"], 1)
        self.assertTrue(narrowed_membership[0]["pending_override"])

        with self._use_db_path():
            refine_system_rule_suggestion_match(BatchRuleSuggestionMatchRefineRequest(
                source_suggestions=[
                    {
                        "id": narrowed_membership[0]["id"],
                        "merchant_label": narrowed_membership[0]["merchant_label"],
                        "target_category_id": narrowed_membership[0]["target_category_id"],
                        "target_category_name": narrowed_membership[0]["target_category_name"],
                        "owner_id": narrowed_membership[0]["owner_id"],
                        "owner_name": narrowed_membership[0]["owner_name"],
                        "source_row_ids": narrowed_membership[0]["source_row_ids"],
                    }
                ],
                keyword="riverstone",
                owner_id=owner_b,
            ))
            broadened = [s for s in get_system_rule_suggestions("")["suggestions"] if s["keyword"] == "riverstone"]

        self.assertEqual(len(broadened), 3)
        owner_a_payment = [
            s for s in broadened
            if s["target_category_id"] == payment and s["owner_id"] == owner_a
        ]
        owner_b_conflict = [s for s in broadened if s["owner_id"] == owner_b]
        self.assertEqual(len(owner_a_payment), 1)
        self.assertFalse(owner_a_payment[0]["needs_resolution"])
        self.assertEqual(owner_a_payment[0]["txn_count"], 102)
        self.assertEqual(len(owner_b_conflict), 2)
        self.assertTrue(all(s["needs_resolution"] for s in owner_b_conflict))
        self.assertEqual({s["target_category_id"] for s in owner_b_conflict}, {payment, membership})
        self.assertEqual({s["txn_count"] for s in owner_b_conflict}, {1, 54})

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

    def test_rule_create_preserves_all_editor_actions_and_match_scope(self):
        owner_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO owner (id, name) VALUES (?, ?)", (owner_id, "Rule Owner"))
        account_id = self._insert_account("Rule Card", owner_id)
        category_id = self._insert_expense_leaf("FixtureRuleActions")
        tag_id = self._insert_tag("FixtureRuleTag")

        with self._use_db_path():
            created = create_rule(RuleCreate(
                keyword="Example Merchant",
                category_id=category_id,
                amount_min=10.0,
                amount_max=25.0,
                debit_credit="debit",
                clean_name="Example Clean Name",
                owner_id=owner_id,
                account_id=account_id,
                tag_ids=[tag_id],
                match_source_text=True,
            ))
            with get_db() as conn:
                rule = conn.execute(
                    """
                    SELECT keyword, category_id, amount_min, amount_max, debit_credit, clean_name,
                           owner_id, account_id, match_source_text
                    FROM category_rule
                    WHERE id = ?
                    """,
                    (created["id"],),
                ).fetchone()
                rule_tag_ids = [
                    row["tag_id"]
                    for row in conn.execute("SELECT tag_id FROM rule_tag WHERE rule_id = ?", (created["id"],)).fetchall()
                ]

        self.assertEqual(created["status"], "created")
        self.assertEqual(rule["keyword"], "example merchant")
        self.assertEqual(rule["category_id"], category_id)
        self.assertEqual(rule["amount_min"], 10.0)
        self.assertEqual(rule["amount_max"], 25.0)
        self.assertEqual(rule["debit_credit"], "debit")
        self.assertEqual(rule["clean_name"], "Example Clean Name")
        self.assertEqual(rule["owner_id"], owner_id)
        self.assertEqual(rule["account_id"], account_id)
        self.assertEqual(rule["match_source_text"], 1)
        self.assertEqual(rule_tag_ids, [tag_id])


    def test_matches_report_scopes_to_row_ids_when_provided(self):
        # The report must show exactly the card's own rows when given row_ids, not every same-keyword row,
        # so a generic suggestion's report doesn't sweep in rows owned by other (e.g. discarded) suggestions.
        account_id = self._insert_account("Card")
        leaf = self._insert_expense_leaf("FixtureBillPay")
        batch_id = self._insert_import_batch()
        r1 = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=leaf, merchant_name="Zorptech Bill", amount=-10.0)
        r2 = self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=leaf, merchant_name="Zorptech Bill", amount=-20.0)
        self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=leaf, merchant_name="Zorptech Bill", amount=-30.0)

        with self._use_db_path():
            full = get_system_rule_suggestion_matches(BatchRuleSuggestionMatchRequest(keyword="Zorptech Bill"))
            scoped = get_system_rule_suggestion_matches(BatchRuleSuggestionMatchRequest(keyword="Zorptech Bill", row_ids=[r1, r2]))

        self.assertEqual(full["count"], 3)
        self.assertEqual(scoped["count"], 2)
        self.assertEqual({row["id"] for row in scoped["transactions"]}, {r1, r2})

    def test_matches_report_honors_source_text_matching(self):
        # A refined suggestion can use a keyword that appears only in imported source detail, not in the
        # merchant name. Accepted suggestion rows are rule-owned, so a scoped matching-row report must
        # use the stored row ids plus the same opt-in matcher or the card says "1 row" while the report
        # opens empty.
        account_id = self._insert_account("Card")
        leaf = self._insert_expense_leaf("FixtureMembershipReport")
        batch_id = self._insert_import_batch()
        row_id = self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_id,
            category_id=leaf,
            merchant_name="Example Card",
            amount=-95.0,
            import_evidence_json=json.dumps({
                "description": {"value": "annual renewal membership fee"},
            }),
        )

        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_source = 'rule', category_overridden = 0 WHERE id = ?",
                    (row_id,),
                )
            without_source_text = get_system_rule_suggestion_matches(BatchRuleSuggestionMatchRequest(
                keyword="renewal",
                row_ids=[row_id],
            ))
            with_source_text = get_system_rule_suggestion_matches(BatchRuleSuggestionMatchRequest(
                keyword="renewal",
                match_source_text=True,
                row_ids=[row_id],
            ))

        self.assertEqual(without_source_text["count"], 0)
        self.assertEqual(with_source_text["count"], 1)
        self.assertEqual(with_source_text["transactions"][0]["id"], row_id)

    def test_scoped_matches_report_includes_rule_owned_rows_for_system_batch_and_profile(self):
        account_id = self._insert_account("Card")
        leaf = self._insert_expense_leaf("FixtureMembershipAllContexts")
        profile_id = self._insert_import_profile()
        batch_id = self._insert_import_batch()
        self._assign_batch_to_profile(batch_id, profile_id)
        row_id = self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_id,
            category_id=leaf,
            merchant_name="Example Card",
            amount=-95.0,
            import_evidence_json=json.dumps({
                "description": {"value": "annual renewal membership fee"},
            }),
        )

        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_source = 'rule', category_overridden = 0 WHERE id = ?",
                    (row_id,),
                )
            request = BatchRuleSuggestionMatchRequest(
                keyword="renewal",
                match_source_text=True,
                row_ids=[row_id],
            )
            results = [
                get_system_rule_suggestion_matches(request),
                get_batch_rule_suggestion_matches(batch_id, request),
                get_profile_rule_suggestion_matches(profile_id, request),
            ]

        self.assertEqual([result["count"] for result in results], [1, 1, 1])
        self.assertEqual(
            [{row["id"] for row in result["transactions"]} for result in results],
            [{row_id}, {row_id}, {row_id}],
        )

    def test_generated_suggestion_carries_latest_txn_date(self):
        # The look-back lens hides stale suggestions by recency, so each suggestion must report the most
        # recent date among the rows it was generated from.
        account_id = self._insert_account("Card")
        leaf = self._insert_expense_leaf("Zorptech Monthly")
        batch_id = self._insert_import_batch()
        self._seed_monthly_import_transactions(
            batch_id=batch_id, account_id=account_id, category_id=leaf,
            merchant_name="Zorptech Monthly", amounts=[-9.99] * 6, start_year=2025,
        )

        with self._use_db_path():
            result = get_system_rule_suggestions("")

        sugg = [s for s in result["suggestions"] if s["keyword"] == "zorptech monthly"]
        self.assertEqual(len(sugg), 1)
        # 6 monthly rows from 2025-01-15 .. 2025-06-15 → newest is 2025-06-15.
        self.assertEqual(sugg[0]["latest_txn_date"], "2025-06-15")

    def test_accepted_suggestion_stays_in_list_after_rows_become_rule_sourced(self):
        # Regression: accepting a suggestion creates a rule and flips its rows to category_source='rule',
        # so they leave the candidate pool and _generate_rule_suggestions no longer rebuilds the
        # suggestion. It must still appear in the response under its accepted status — otherwise the
        # accepted/discarded filters show only the few suggestions whose rows happen to still regenerate
        # while the summary pills count the full reviewed set, so the list and the counts disagree.
        account_id = self._insert_account("Primary Checking")
        category_id = self._insert_expense_leaf("Groceries")
        batch_id = self._insert_import_batch()
        row_ids = [
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=category_id, merchant_name="WHOLEFDS BRKLNE", amount=10.99),
            self._insert_import_transaction(batch_id=batch_id, account_id=account_id, category_id=category_id, merchant_name="WHOLEFDS BRKLNE", amount=20.00),
        ]

        with self._use_db_path():
            pending = [s for s in get_system_rule_suggestions("")["suggestions"] if s["review_status"] == "pending"]
            self.assertEqual(len(pending), 1)
            suggestion = pending[0]

            # Accept it the way the UI does: create the rule, apply it to the rows (flipping them to
            # category_source='rule'), then record the acceptance.
            created = create_rule(RuleCreate(keyword=suggestion["keyword"], category_id=category_id))
            apply_rule_to_transactions(created["id"], ApplyToTransactionsBody(transaction_ids=row_ids))
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id=suggestion["id"],
                status="accepted",
                rule_id=created["id"],
                keyword=suggestion["keyword"],
                target_category_id=category_id,
                target_category_name="Groceries",
            ))

            after = get_system_rule_suggestions("")

        with self._use_db_path():
            with get_db() as conn:
                sources = {
                    row["id"]: row["category_source"]
                    for row in conn.execute("SELECT id, category_source FROM txn").fetchall()
                }
        # Guard the precondition: without rule-sourced rows the bug can't reproduce.
        self.assertEqual({sources[row_id] for row_id in row_ids}, {"rule"})

        returned_ids = {s["id"] for s in after["suggestions"]}
        self.assertIn(suggestion["id"], returned_ids)
        accepted = [s for s in after["suggestions"] if s["id"] == suggestion["id"]][0]
        self.assertEqual(accepted["review_status"], "accepted")
        # The accepted rule's id is surfaced so the editor updates that rule in place instead of
        # creating a duplicate when an already-accepted suggestion is edited.
        self.assertEqual(accepted["rule_id"], created["id"])

        # The returned list must match the summary pills the UI renders, status for status.
        status_counts = Counter(s["review_status"] for s in after["suggestions"])
        summary = after["review_summary"]
        self.assertEqual(len(after["suggestions"]), summary["total_count"])
        self.assertEqual(status_counts["accepted"], summary["accepted_count"])
        self.assertEqual(status_counts["pending"], summary["pending_count"])
        self.assertEqual(status_counts["discarded"], summary["discarded_count"])


    def test_clear_reviewed_suggestions_moves_whole_status_set_to_restorable_trash(self):
        self._save_review_state({
            "suggestions": {
                "accepted-1": {"keyword": "accepted one", "merchant_label": "Accepted One"},
                "accepted-2": {"keyword": "accepted two", "merchant_label": "Accepted Two"},
                "deferred-1": {"keyword": "deferred one", "merchant_label": "Deferred One"},
                "discarded-1": {"keyword": "discarded one", "merchant_label": "Discarded One"},
                "pending-1": {"keyword": "pending one", "merchant_label": "Pending One"},
            },
            "statuses": {
                "accepted-1": {"status": "accepted", "rule_id": "rule-a"},
                "accepted-2": {"status": "accepted", "rule_id": "rule-b"},
                "deferred-1": {"status": "skipped"},
                "discarded-1": {"status": "discarded"},
            },
        })

        with self._use_db_path():
            result = clear_system_rule_suggestions(RuleSuggestionClearRequest(status="accepted"))

        self.assertEqual(result["cleared_count"], 2)
        self.assertEqual(result["review_summary"]["accepted_count"], 0)
        self.assertEqual(result["review_summary"]["pending_count"], 1)
        self.assertEqual(result["review_summary"]["skipped_count"], 1)
        self.assertEqual(result["review_summary"]["discarded_count"], 1)
        self.assertEqual(len(result["trash_sets"]), 1)
        trash_set = result["trash_sets"][0]
        self.assertEqual(trash_set["status"], "accepted")
        self.assertEqual(trash_set["count"], 2)

        review_state = self._load_review_state()
        self.assertEqual(set(review_state["suggestions"]), {"deferred-1", "discarded-1", "pending-1"})
        self.assertEqual(set(review_state["statuses"]), {"deferred-1", "discarded-1"})
        self.assertEqual(len(review_state["trash_sets"]), 1)

        with self._use_db_path():
            restored = restore_system_rule_suggestion_trash_set(trash_set["id"])

        self.assertEqual(restored["restored_count"], 2)
        self.assertEqual(restored["review_summary"]["accepted_count"], 2)
        self.assertEqual(restored["trash_sets"], [])
        restored_state = self._load_review_state()
        self.assertEqual(set(restored_state["suggestions"]), {"accepted-1", "accepted-2", "deferred-1", "discarded-1", "pending-1"})
        self.assertEqual(restored_state["statuses"]["accepted-1"]["rule_id"], "rule-a")
        self.assertEqual(restored_state["statuses"]["accepted-2"]["rule_id"], "rule-b")

    def test_clearing_rule_suggestions_does_not_touch_live_rules_or_transactions(self):
        account_id = self._insert_account("Primary Checking")
        category_id = self._insert_expense_leaf("Fixture Groceries")
        batch_id = self._insert_import_batch()
        txn_id = self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_id,
            category_id=category_id,
            merchant_name="Fixture Market",
            amount=12.34,
        )
        rule_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category_rule (id, category_id, keyword)
                    VALUES (?, ?, 'fixture market')
                    """,
                    (rule_id, category_id),
                )
        self._save_review_state({
            "suggestions": {
                "fixture market": {
                    "keyword": "fixture market",
                    "merchant_label": "Fixture Market",
                    "target_category_id": category_id,
                    "source_row_ids": [txn_id],
                },
            },
            "statuses": {
                "fixture market": {"status": "accepted", "rule_id": rule_id},
            },
        })

        with self._use_db_path():
            clear_system_rule_suggestions(RuleSuggestionClearRequest(status="accepted"))
            with get_db() as conn:
                rule = conn.execute("SELECT id FROM category_rule WHERE id = ?", (rule_id,)).fetchone()
                txn = conn.execute(
                    "SELECT id, category_id, category_source FROM txn WHERE id = ?",
                    (txn_id,),
                ).fetchone()

        self.assertIsNotNone(rule)
        self.assertEqual(txn["category_id"], category_id)
        self.assertEqual(txn["category_source"], "import")

    def test_clear_reviewed_suggestions_can_scope_to_visible_suggestion_ids(self):
        self._save_review_state({
            "suggestions": {
                "visible-accepted": {"keyword": "visible", "merchant_label": "Visible"},
                "hidden-accepted": {"keyword": "hidden", "merchant_label": "Hidden"},
                "visible-discarded": {"keyword": "visible discarded", "merchant_label": "Visible Discarded"},
            },
            "statuses": {
                "visible-accepted": {"status": "accepted"},
                "hidden-accepted": {"status": "accepted"},
                "visible-discarded": {"status": "discarded"},
            },
        })

        with self._use_db_path():
            result = clear_system_rule_suggestions(RuleSuggestionClearRequest(
                status="accepted",
                suggestion_ids=["visible-accepted", "visible-discarded"],
            ))

        self.assertEqual(result["cleared_count"], 1)
        review_state = self._load_review_state()
        self.assertNotIn("visible-accepted", review_state["suggestions"])
        self.assertIn("hidden-accepted", review_state["suggestions"])
        self.assertIn("visible-discarded", review_state["suggestions"])
        self.assertEqual(review_state["summary"]["accepted_count"], 1)
        self.assertEqual(review_state["summary"]["discarded_count"], 1)

    def test_cleared_discarded_suggestions_do_not_regenerate_as_pending(self):
        account_id = self._insert_account("Primary Checking")
        category_id = self._insert_expense_leaf("Fixture Utilities")
        batch_id = self._insert_import_batch()
        self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_id,
            category_id=category_id,
            merchant_name="Fixture Power",
            amount=42.00,
            imported_category="Fixture Utilities",
        )

        with self._use_db_path():
            initial = get_system_rule_suggestions("")
            suggestion = next(s for s in initial["suggestions"] if s["keyword"] == "fixture power")
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id=suggestion["id"],
                status="discarded",
                keyword=suggestion["keyword"],
                target_category_id=suggestion["target_category_id"],
                target_category_name=suggestion["target_category_name"],
                merchant_label=suggestion["merchant_label"],
            ))
            clear_system_rule_suggestions(RuleSuggestionClearRequest(
                status="discarded",
                suggestion_ids=[suggestion["id"]],
            ))
            after = get_system_rule_suggestions("")

        returned = [item for item in after["suggestions"] if item["id"] == suggestion["id"]]
        self.assertEqual(returned, [])
        self.assertEqual(after["review_summary"]["pending_count"], 0)
        self.assertEqual(after["review_summary"]["discarded_count"], 0)
        self.assertEqual(after["review_summary"]["trash_set_count"], 1)

    def test_clearing_owner_on_accept_persists_to_suggestion_entry(self):
        # Generalizing a rule by removing its owner must be written back into the suggestion record. An
        # explicit null was previously dropped (only non-null owner_id was stored), so the accepted card
        # kept its old owner even though the created rule was unscoped.
        self._save_review_state({
            "suggestions": {
                "aji restaurant": {
                    "keyword": "aji restaurant",
                    "merchant_label": "AJI RESTAURANT",
                    "target_category_id": "restaurants",
                    "target_category_name": "Restaurants",
                    "owner_id": "owner-mark",
                    "owner_name": "Mark",
                },
            },
            "statuses": {},
        })

        with self._use_db_path():
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="aji restaurant",
                status="accepted",
                rule_id="rule-1",
                keyword="aji restaurant",
                target_category_id="restaurants",
                target_category_name="Restaurants",
                owner_id=None,
            ))

        review_state = self._load_review_state()
        entry = review_state["suggestions"]["aji restaurant"]
        self.assertIsNone(entry.get("owner_id"))
        self.assertEqual(review_state["statuses"]["aji restaurant"]["status"], "accepted")

    def test_accepted_edit_persists_refreshed_source_rows(self):
        self._save_review_state({
            "suggestions": {
                "fixture pharmacy": {
                    "keyword": "fixture pharmacy",
                    "merchant_label": "Fixture Pharmacy",
                    "target_category_id": "pharmacy",
                    "target_category_name": "Pharmacy",
                    "source_row_ids": ["old-row"],
                    "txn_count": 1,
                    "latest_txn_date": "2024-01-01",
                },
            },
            "statuses": {"fixture pharmacy": {"status": "accepted", "rule_id": "rule-1"}},
        })

        with self._use_db_path():
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="fixture pharmacy",
                status="accepted",
                rule_id="rule-1",
                keyword="fixture pharmacy",
                target_category_id="pharmacy",
                target_category_name="Pharmacy",
                source_row_ids=["new-row", "old-row", "new-row"],
                txn_count=2,
                latest_txn_date="2026-04-26",
            ))

        review_state = self._load_review_state()
        entry = review_state["suggestions"]["fixture pharmacy"]
        self.assertEqual(entry["source_row_ids"], ["new-row", "old-row"])
        self.assertEqual(entry["txn_count"], 2)
        self.assertEqual(entry["latest_txn_date"], "2026-04-26")

    def test_review_action_metadata_persists_with_settled_suggestion(self):
        self._save_review_state({
            "suggestions": {
                "fixture cafe": {
                    "keyword": "fixture cafe",
                    "merchant_label": "Fixture Cafe",
                    "target_category_id": "lunch",
                    "target_category_name": "Lunch",
                },
            },
            "statuses": {},
        })
        review_action = {
            "kind": "category_changes",
            "category_changes": [{
                "from_category_id": "food",
                "from_category_name": "Food & Dining",
                "to_category_id": "lunch",
                "to_category_name": "Lunch",
                "count": 79,
            }],
        }

        with self._use_db_path():
            update_system_rule_suggestion_review(BatchRuleSuggestionReviewUpdateRequest(
                suggestion_id="fixture cafe",
                status="discarded",
                keyword="fixture cafe",
                target_category_id="lunch",
                target_category_name="Lunch",
                review_action=review_action,
            ))

        review_state = self._load_review_state()
        self.assertEqual(review_state["suggestions"]["fixture cafe"]["review_action"], review_action)
        self.assertEqual(review_state["statuses"]["fixture cafe"]["review_action"], review_action)

    def test_debug_trace_enriches_identifiers_from_committed_database_state(self):
        account_id = self._insert_account("Primary Checking")
        category_id = self._insert_expense_leaf("Groceries")
        batch_id = self._insert_import_batch()
        txn_id = self._insert_import_transaction(
            batch_id=batch_id,
            account_id=account_id,
            category_id=category_id,
            merchant_name="Fixture Merchant",
            amount=12.34,
        )
        rule_id = str(uuid.uuid4())
        self._save_review_state({
            "suggestions": {
                "fixture merchant": {
                    "keyword": "fixture merchant",
                    "merchant_label": "Fixture Merchant",
                    "source_row_ids": [txn_id],
                },
            },
            "statuses": {},
        })
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category_rule (id, category_id, keyword)
                    VALUES (?, ?, 'fixture merchant')
                    """,
                    (rule_id, category_id),
                )

        trace_path = Path(self.tempdir.name) / "trace.jsonl"
        with patch.dict("os.environ", {"LUMA_RULE_SUGGESTION_TRACE_PATH": str(trace_path)}):
            with self._use_db_path():
                result = write_rule_suggestion_debug_trace(RuleSuggestionDebugTraceRequest(
                    correlation_id="trace-1",
                    client_sequence=1,
                    event="bulk-save",
                    phase="before",
                    context_type="system",
                    suggestion_ids=["fixture merchant"],
                    transaction_ids=[txn_id],
                    rule_ids=[rule_id],
                    keywords=["fixture merchant"],
                    undo_snapshot={"rows": [], "rule_ids": []},
                    details={"selected_count": 1},
                ))

        self.assertEqual(result, {"ok": True})
        record = json.loads(trace_path.read_text(encoding="utf-8").strip())
        self.assertEqual(record["correlation_id"], "trace-1")
        self.assertEqual(record["database"]["transactions"], [{
            "id": txn_id,
            "category_id": category_id,
            "category_source": "import",
            "category_overridden": 0,
            "import_batch_id": batch_id,
            "use_imported_categories": 1,
        }])
        self.assertEqual(record["database"]["rules"][0]["id"], rule_id)
        self.assertEqual(record["database"]["suggestions"]["fixture merchant"]["status"], "pending")
        self.assertEqual(record["database"]["suggestions"]["fixture merchant"]["source_row_count"], 1)


if __name__ == "__main__":
    unittest.main()
