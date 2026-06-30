"""
`account_skipped_duplicate_summary` explains why an account can look empty: it attributes the rows
that were skipped or removed as duplicates back to the account they would have belonged to, and names
the accounts/source files the matched (existing) transactions live on. Covers both pools — hard-rejected
import rows (`import_batch_duplicate`, attributed via the stored payload's account_id) and confirmed
soft-flag duplicates (trashed `txn` rows) — plus the deep-link batch selection.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.db.database import get_db, init_db, set_current_db_path
from backend.services.duplicate_detection import account_skipped_duplicate_summary


def _account(conn, account_id, name, display_name):
    conn.execute(
        """
        INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type,
                             subtype, mask, owner_id, parent_account_id, trashed_at)
        VALUES (?, ?, 'manual', ?, ?, 'credit', NULL, NULL, NULL, NULL, NULL)
        """,
        (account_id, account_id, name, display_name),
    )


def _batch(conn, batch_id, filename):
    conn.execute("INSERT INTO import_batch (id, filename) VALUES (?, ?)", (batch_id, filename))


def _txn(conn, txn_id, account_id, batch_id, **extra):
    conn.execute(
        """
        INSERT INTO txn (id, account_id, amount, date, import_batch_id, suspect_duplicate_of,
                         trashed_at, rejection_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            txn_id, account_id, extra.get("amount", 10.0), extra.get("date", "2024-01-01"),
            batch_id, extra.get("suspect_duplicate_of"), extra.get("trashed_at"),
            extra.get("rejection_reason"),
        ),
    )


class AccountDuplicateSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "summary-tests.db"
        init_db(str(self.db_path))
        self.token = set_current_db_path(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    def _seed(self):
        with get_db() as conn:
            _account(conn, "acc_empty", "CREDIT CARD", "CREDIT CARD")
            _account(conn, "acc_real", "CREDIT CARD", "Northgate Voyager")
            _batch(conn, "b_fid", "Fidelity.csv")     # holds the existing (matched) rows
            _batch(conn, "b_monarch", "Monarch.csv")  # the import whose rows were skipped
            # Existing transactions the duplicates matched against.
            _txn(conn, "e1", "acc_real", "b_fid")
            _txn(conn, "e2", "acc_real", "b_fid")
            # Two hard-rejected Monarch rows that would have imported into acc_empty.
            for row_number, matched_id in ((1, "e1"), (2, "e2")):
                conn.execute(
                    """
                    INSERT INTO import_batch_duplicate
                      (batch_id, row_number, reason, values_json, matched_transaction_json, txn_payload_json)
                    VALUES (?, ?, 'Matches an existing transaction', '{}', ?, ?)
                    """,
                    (
                        "b_monarch", row_number,
                        json.dumps({"id": matched_id, "import_batch_id": "b_fid"}),
                        json.dumps({"account_id": "acc_empty", "amount": 10.0, "date": "2024-01-01"}),
                    ),
                )
            # One confirmed soft-flag duplicate trashed off acc_empty.
            _txn(conn, "c1", "acc_empty", "b_monarch", suspect_duplicate_of="e1",
                 trashed_at="2024-02-01T00:00:00Z", rejection_reason="duplicate_confirmed")
            conn.commit()

    def test_summary_attributes_and_names_matches(self):
        self._seed()
        with get_db() as conn:
            summary = account_skipped_duplicate_summary(conn, "acc_empty")
        self.assertEqual(summary["skipped_count"], 3)
        self.assertEqual(summary["hard_reject_count"], 2)
        self.assertEqual(summary["confirmed_count"], 1)
        self.assertEqual(summary["matched_accounts"], ["Northgate Voyager"])
        self.assertEqual(summary["matched_sources"], ["Fidelity.csv"])
        self.assertEqual(summary["primary_batch_id"], "b_monarch")
        self.assertEqual(summary["primary_batch_filename"], "Monarch.csv")

    def test_account_with_no_skipped_duplicates(self):
        self._seed()
        with get_db() as conn:
            summary = account_skipped_duplicate_summary(conn, "acc_real")
        self.assertEqual(summary["skipped_count"], 0)
        self.assertEqual(summary["matched_accounts"], [])
        self.assertIsNone(summary["primary_batch_id"])


if __name__ == "__main__":
    unittest.main()
