# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Suspect-duplicate detection coverage.

These tests exercise the service functions in `backend/services/suspect_duplicates.py`
directly so each branch of the detection logic (new-account guard, payee normalization,
trash exclusion, account-merge sweep) and the two resolution paths (keep / trash) can be
asserted without standing up a full CSV import for every case. The functions take a raw
connection, so the setup builds the minimum schema state needed for each scenario.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.suspect_duplicates import (
    count_active_suspects,
    list_suspects,
    mark_import_suspects,
    mark_merge_suspects,
    resolve_suspect,
)


class SuspectDuplicateTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "suspect-duplicates.db"
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

    # ---- factory helpers -------------------------------------------------

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype,
                       mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'credit', 'credit_card', NULL, ?, NULL, NULL)
                    """,
                    (account_id, f"plaid_{account_id}", "fixture", name, name, SHARED_OWNER_ID),
                )
        return account_id

    def _insert_batch(self, *, filename: str = "fixture.csv") -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO import_batch (id, filename, status, row_count, skipped_count, deduped_count)
                    VALUES (?, ?, 'completed', 0, 0, 0)
                    """,
                    (batch_id, filename),
                )
        return batch_id

    def _insert_txn(
        self,
        *,
        account_id: str,
        date: str,
        amount: float,
        merchant_name: str,
        display_name: str | None = None,
        raw_name: str | None = None,
        batch_id: str | None = None,
        trashed_at: str | None = None,
    ) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                       date, is_pending, import_batch_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (
                        txn_id,
                        account_id,
                        SHARED_OWNER_ID,
                        amount,
                        merchant_name,
                        display_name or merchant_name,
                        raw_name or merchant_name,
                        date,
                        batch_id,
                        trashed_at,
                    ),
                )
        return txn_id

    def _suspect_link(self, txn_id: str) -> dict | None:
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    """
                    SELECT id, suspect_duplicate_of, suspect_duplicate_reason,
                           suspect_resolved_at, trashed_at
                    FROM   txn
                    WHERE  id = ?
                    """,
                    (txn_id,),
                ).fetchone()
                return dict(row) if row else None

    # ---- import-time detection ------------------------------------------

    def test_import_flags_match_when_receiving_account_is_new(self):
        # Account A exists with a prior transaction; Account B is created brand new for this
        # batch and the imported row matches A's existing row on (date, amount, payee).
        account_a = self._insert_account("Freedom (Chase)")
        account_b = self._insert_account("Credit Card ...6612")
        batch = self._insert_batch()

        existing_id = self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="BIKEPACKING COLLECTIVE",
        )
        new_id = self._insert_txn(
            account_id=account_b,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="Bikepacking Collective",  # case-insensitive match
            batch_id=batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)

        self.assertEqual(marked, 1)
        link = self._suspect_link(new_id)
        self.assertEqual(link["suspect_duplicate_of"], existing_id)
        self.assertEqual(link["suspect_duplicate_reason"], "import_new_account")

        # The original (existing) row stays unflagged — only the new arrival gets the badge.
        existing_link = self._suspect_link(existing_id)
        self.assertIsNone(existing_link["suspect_duplicate_of"])

    def test_import_does_not_flag_when_account_already_has_prior_history(self):
        # Account A exists with a prior transaction and ALSO with a previous batch on it.
        # The new import on A is not on a "new" account, so the soft-dup check should be skipped.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        prior_batch = self._insert_batch(filename="prior.csv")
        new_batch = self._insert_batch(filename="new.csv")

        self._insert_txn(
            account_id=account_b,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
        )
        # Earlier import already populated account A.
        self._insert_txn(
            account_id=account_a,
            date="2024-01-01",
            amount=-12.00,
            merchant_name="OTHER",
            batch_id=prior_batch,
        )
        # New import adds another row on account A that matches B's existing row.
        new_id = self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            batch_id=new_batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, new_batch)

        self.assertEqual(marked, 0)
        self.assertIsNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_import_skips_when_existing_match_is_trashed(self):
        # A trashed row shouldn't anchor a new suspect — once you've decided it's gone, the
        # incoming row is the only live copy.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()

        self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            trashed_at="2026-05-01T00:00:00Z",
        )
        new_id = self._insert_txn(
            account_id=account_b,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            batch_id=batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)

        self.assertEqual(marked, 0)
        self.assertIsNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_import_does_not_flag_same_account_duplicate(self):
        # Exact same account + date + amount + payee is the *normal* duplicate the import-level
        # dedup catches. The soft check only cares about different accounts.
        account_a = self._insert_account("Account A")
        batch = self._insert_batch()
        self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
        )
        new_id = self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            batch_id=batch,
        )

        # Account A had a prior row outside the batch, so it isn't "new in this batch" → marker
        # returns zero by the new-account guard. The point of this test is that even if the
        # guard didn't apply, the same-account match shouldn't be flagged.
        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)

        self.assertEqual(marked, 0)
        self.assertIsNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_import_does_not_re_flag_existing_suspect(self):
        # An already-flagged row shouldn't get re-flagged when the import sweep runs again
        # (which it does for the "force import these duplicates" pathway).
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        existing = self._insert_txn(
            account_id=account_a, date="2025-10-30", amount=-10.00, merchant_name="X"
        )
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-10.00, merchant_name="X", batch_id=batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                first_pass = mark_import_suspects(conn, batch)
                second_pass = mark_import_suspects(conn, batch)

        self.assertEqual(first_pass, 1)
        self.assertEqual(second_pass, 0)
        self.assertEqual(self._suspect_link(new_id)["suspect_duplicate_of"], existing)

    # ---- account-merge detection ----------------------------------------

    def test_attach_merge_sweep_flags_overlapping_rows(self):
        # Two unrelated accounts each have a matching transaction. Merging A under B (or vice
        # versa) calls mark_merge_suspects against the now-grouped account ids; one side gets
        # flagged as suspect of the other.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        a_txn = self._insert_txn(
            account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="MERCHANT"
        )
        b_txn = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="MERCHANT"
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_merge_suspects(conn, [account_a, account_b])

        # Exactly one of the two rows gets flagged — symmetric pairs are recorded once.
        a_link = self._suspect_link(a_txn)
        b_link = self._suspect_link(b_txn)
        flagged = [link for link in (a_link, b_link) if link["suspect_duplicate_of"]]
        self.assertEqual(marked, len(flagged))
        self.assertEqual(len(flagged), 1)
        self.assertEqual(flagged[0]["suspect_duplicate_reason"], "account_merge")

    def test_attach_merge_sweep_ignores_empty_input(self):
        # Defensive: an empty merge group shouldn't error and shouldn't run a query.
        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(mark_merge_suspects(conn, []), 0)

    # ---- list / count / resolve -----------------------------------------

    def test_list_and_count_only_return_unresolved(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                pairs_before = list_suspects(conn)
                count_before = count_active_suspects(conn)
                resolve_suspect(conn, new_id, action="keep")
                pairs_after = list_suspects(conn)
                count_after = count_active_suspects(conn)

        self.assertEqual(count_before, 1)
        self.assertEqual(len(pairs_before), 1)
        self.assertEqual(pairs_before[0]["new_id"], new_id)
        self.assertEqual(count_after, 0)
        self.assertEqual(pairs_after, [])

    def test_resolve_keep_clears_flag_and_leaves_row(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                result = resolve_suspect(conn, new_id, action="keep")

        self.assertEqual(result, {"resolved": True, "action": "keep"})
        link = self._suspect_link(new_id)
        self.assertIsNone(link["suspect_duplicate_of"])
        self.assertIsNone(link["suspect_duplicate_reason"])
        self.assertIsNotNone(link["suspect_resolved_at"])
        # 'keep' must NOT trash the row.
        self.assertIsNone(link["trashed_at"])

    def test_resolve_trash_sets_trashed_at_and_marks_resolved(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                result = resolve_suspect(conn, new_id, action="trash")

        self.assertEqual(result, {"resolved": True, "action": "trash"})
        link = self._suspect_link(new_id)
        self.assertIsNotNone(link["trashed_at"])
        self.assertIsNotNone(link["suspect_resolved_at"])

    def test_resolve_invalid_action(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                result = resolve_suspect(conn, new_id, action="bogus")
        self.assertFalse(result["resolved"])
        self.assertEqual(result["reason"], "invalid_action")
        # Original flag is preserved.
        self.assertIsNotNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_resolve_rejects_non_suspect_row(self):
        account_a = self._insert_account("Account A")
        txn = self._insert_txn(
            account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X"
        )
        with self._use_db_path():
            with get_db() as conn:
                result = resolve_suspect(conn, txn, action="trash")
        self.assertEqual(result, {"resolved": False, "reason": "not_suspect"})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
