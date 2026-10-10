"""Clearing an import card's detail records without touching the ledger it produced.

These assert the survivors rather than the removals, because every one of them is something the clear
could plausibly have taken and whose loss would be silent: a transaction that starts reading as manually
entered, a file that stops being recognised on re-import, a covered period that a later import brings in
again, a trashed row with no screen left that can reach it.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path,
)
from backend.routers.import_export.core import list_batches
from backend.services.import_detail_storage import (
    clear_batch_detail,
    detail_storage,
    summarize_detail_clearing,
)


class ImportDetailClearingTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "purge.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account()
        self.batch_id = self._insert_batch()

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account (id, name, display_name, type, subtype, owner_id)
                VALUES (?, 'Harborline Checking', 'Harborline Checking', 'depository', 'checking', ?)
                """,
                (account_id, SHARED_OWNER_ID),
            )
        return account_id

    def _insert_batch(self, *, filename: str = "harborline-2019.csv", file_hash: str = "hash-2019") -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO import_batch (id, filename, file_content_hash, status, row_count,
                                          skipped_count, deduped_count, config_snapshot)
                VALUES (?, ?, ?, 'completed', 3, 0, 2, '{"account_id": "acct-1"}')
                """,
                (batch_id, filename, file_hash),
            )
            conn.execute(
                """
                INSERT INTO import_batch_account
                  (batch_id, csv_value, account_id, row_count, was_skipped,
                   coverage_start_date, coverage_end_date, terminal_date)
                VALUES (?, '', NULL, 3, 0, '2019-07-05', '2019-12-31', '2019-12-31')
                """,
                (batch_id,),
            )
        return batch_id

    def _insert_txn(self, *, trashed: bool = False, resolved_by: str | None = None,
                    external_id: str | None = None) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO txn (id, account_id, date, amount, raw_name, owner_id, import_batch_id,
                                 external_transaction_id, trashed_at, rejection_reason, dedupe_resolved_by)
                VALUES (?, ?, '2019-08-01', -12.5, 'Riverstone Market', ?, ?, ?, ?, ?, ?)
                """,
                (txn_id, self.account_id, SHARED_OWNER_ID, self.batch_id, external_id,
                 '2026-01-01 00:00:00' if trashed else None,
                 'duplicate_confirmed' if trashed else None, resolved_by),
            )
        return txn_id

    def _insert_duplicate(self, row_number: int, *, enriched: bool = False,
                          substate: str | None = None):
        """`substate` is what makes a row count as flagged for review: NULL (and `transfer_match`) are
        settled labels the cards never ask anyone to look at."""
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO import_batch_duplicate
                  (batch_id, row_number, reason, values_json, matched_transaction_json,
                   txn_payload_json, enriched_at, review_substate)
                VALUES (?, ?, 'Matches an existing transaction', '{}', '{}', '{"date": "2019-08-01"}', ?, ?)
                """,
                (self.batch_id, row_number, '2026-01-01 00:00:00' if enriched else None, substate),
            )

    def _clear(self):
        with self._use_db_path(), get_db() as conn:
            return clear_batch_detail(conn, [self.batch_id], cleared_at="2026-10-09 09:00:00")

    def _column(self, sql, params=()):
        with self._use_db_path(), get_db() as conn:
            return conn.execute(sql, params).fetchone()

    # ---- what the ledger keeps -------------------------------------------

    def test_the_transactions_it_imported_stay_and_still_name_their_batch(self):
        """`import_batch_id` is how the ledger knows a row was not entered by hand; losing it would
        quietly make a CSV import's transactions amount-editable."""
        txn_id = self._insert_txn()
        self._clear()

        row = self._column("SELECT import_batch_id, trashed_at FROM txn WHERE id = ?", (txn_id,))
        self.assertEqual(row["import_batch_id"], self.batch_id)
        self.assertIsNone(row["trashed_at"])

    def test_the_file_is_still_recognised_on_re_import(self):
        """Four readers ask whether a hash has been imported before, all of them gated on
        `status = 'completed'`. A cleared card has to keep answering yes."""
        self._clear()

        row = self._column(
            "SELECT status, file_content_hash FROM import_batch WHERE id = ?", (self.batch_id,),
        )
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["file_content_hash"], "hash-2019")

    def test_the_period_it_covered_is_still_claimed_for_duplicate_detection(self):
        """`import_batch_account.coverage_*` is the terminal-window claim. Dropping it would let a later
        import of an already-covered period bring those rows in again as new."""
        self._clear()

        row = self._column(
            "SELECT coverage_start_date, coverage_end_date FROM import_batch_account WHERE batch_id = ?",
            (self.batch_id,),
        )
        self.assertEqual((row["coverage_start_date"], row["coverage_end_date"]),
                         ("2019-07-05", "2019-12-31"))

    def test_the_snapshot_that_routes_later_imports_survives(self):
        self._clear()

        row = self._column("SELECT config_snapshot FROM import_batch WHERE id = ?", (self.batch_id,))
        self.assertIn("acct-1", row["config_snapshot"])

    # ---- what it removes --------------------------------------------------

    def test_the_duplicate_report_goes_and_the_card_stays_in_the_history(self):
        """The card staying is the point: what is cleared is the detail it stored, not the import, so
        nothing disappears from the screen and the action needs no destructive vocabulary."""
        self._insert_duplicate(1)
        self._insert_duplicate(2, enriched=True)
        self._clear()

        self.assertEqual(
            self._column("SELECT COUNT(*) AS n FROM import_batch_duplicate WHERE batch_id = ?",
                         (self.batch_id,))["n"], 0)
        with self._use_db_path():
            cards = {card["id"]: card for card in list_batches()}
        self.assertIn(self.batch_id, cards)
        self.assertEqual(cards[self.batch_id]["detail_cleared_at"], "2026-10-09 09:00:00")

    def test_a_card_cleared_twice_is_counted_once(self):
        self._insert_duplicate(1)
        first = self._clear()
        second = self._clear()

        self.assertEqual(first["cards"], 1)
        self.assertEqual(second["cards"], 0)

    def test_the_storage_listing_says_where_the_space_is(self):
        self._insert_duplicate(1)
        self._insert_duplicate(2)
        with self._use_db_path(), get_db() as conn:
            stored = detail_storage(conn)

        self.assertEqual(stored[self.batch_id]["report_rows"], 2)
        # Both are settled, so neither is "still flagged for review" — the figure means what the cards'
        # amber count means, not "has nobody clicked this".
        self.assertEqual(stored[self.batch_id]["unreviewed_rows"], 0)
        self.assertGreater(stored[self.batch_id]["bytes"], 0)

    # ---- nothing is left stranded ----------------------------------------

    def test_a_row_whose_only_undo_was_the_report_is_handed_to_the_trash(self):
        """Trash hides a confirmed duplicate while its report exists, because that is where it is
        restorable from. With the report gone it would be invisible everywhere and restorable nowhere."""
        txn_id = self._insert_txn(trashed=True, resolved_by="user")
        self._clear()

        row = self._column(
            "SELECT trashed_at, rejection_reason, dedupe_resolved_by FROM txn WHERE id = ?", (txn_id,))
        self.assertIsNotNone(row["trashed_at"])
        self.assertIsNone(row["rejection_reason"])
        self.assertIsNone(row["dedupe_resolved_by"])

    def test_a_row_restorable_by_detaching_accounts_is_left_alone(self):
        """An `auto_merge` row comes back by detaching the accounts, a path this does not disturb, so
        moving it to the Trash would imply a deletion nobody performed."""
        txn_id = self._insert_txn(trashed=True, resolved_by="auto_merge")
        self._clear()

        row = self._column("SELECT rejection_reason, dedupe_resolved_by FROM txn WHERE id = ?", (txn_id,))
        self.assertEqual(row["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(row["dedupe_resolved_by"], "auto_merge")

    # ---- the confirmation's figures ---------------------------------------

    def test_the_preview_counts_what_the_clear_then_carries_out(self):
        self._insert_txn()
        self._insert_txn()
        self._insert_txn(trashed=True, resolved_by="user")
        self._insert_duplicate(1, substate="no_match")
        self._insert_duplicate(2, enriched=True)
        self._insert_duplicate(3, substate="transfer_match")

        with self._use_db_path(), get_db() as conn:
            preview = summarize_detail_clearing(conn, [self.batch_id])

        self.assertEqual(preview["cards"], 1)
        self.assertEqual(preview["transactions_kept"], 2)
        self.assertEqual(preview["report_rows"], 3)
        # Only the `no_match` row. The sentence this feeds is the last thing read before an
        # irreversible delete, so it counts what the cards call flagged — not every row nobody clicked.
        # Counted the other way this said 30,632 on a real ledger where the answer was 75.
        self.assertEqual(preview["unreviewed_rows"], 1)
        self.assertEqual(preview["enrichment_undos"], 1)
        self.assertEqual(preview["trashed_released"], 1)
        self.assertGreater(preview["bytes"], 0)
        self.assertEqual(self._clear(), preview)


if __name__ == "__main__":
    unittest.main()
