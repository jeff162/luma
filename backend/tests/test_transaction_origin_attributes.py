# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Filtering by where a transaction came from, and the cleanup it exists for.

The asked-for shape is "delete everything before <date>, from imported files only" — a date the ledger
could already express and an origin it could not. These attributes are the missing half, and the test
that matters is the last one: the two together, resolved by the *bulk* endpoint, since that is what
"select all matching" acts on and a filter the builder drops does not fail, it silently widens.

`external_transaction_id` is the discriminator (see `services/transaction_attributes.py`), so the
fixture writes it directly rather than driving a sync: it is the provider's own id, the one column a
file import never sets.

All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import (
    BulkAction,
    BulkSelection,
    BulkUpdateRequest,
    bulk_update_transactions,
    list_filter_attributes,
)

CUTOFF = "2015-01-01"


class TransactionOriginAttributeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "origin-attributes.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account("Riverstone Checking")
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

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES (?, ?, 'fixture', ?, ?, 'checking', ?)""",
                (account_id, f"acct_{account_id}", name, name, SHARED_OWNER_ID),
            )
        return account_id

    def _insert_batch(self) -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename) VALUES (?, 'statement.csv')", (batch_id,)
            )
        return batch_id

    def _insert_txn(self, *, merchant: str, date: str, external_id: str | None = None,
                    batch_id: str | None = None) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name,
                      raw_name, date, is_pending, external_transaction_id, import_batch_id)
                   VALUES (?, ?, ?, NULL, 12.5, ?, ?, ?, ?, 0, ?, ?)""",
                (txn_id, self.account_id, SHARED_OWNER_ID, merchant, merchant, merchant, date,
                 external_id, batch_id),
            )
        return txn_id

    def _synced(self, merchant: str, date: str) -> str:
        # A synced row carries its per-period sync card too, which is why the file predicate has to
        # exclude the provider id rather than merely asking for a batch.
        return self._insert_txn(merchant=merchant, date=date,
                                external_id=f"ext_{uuid.uuid4()}", batch_id=self.batch_id)

    def _from_file(self, merchant: str, date: str) -> str:
        return self._insert_txn(merchant=merchant, date=date, batch_id=self.batch_id)

    def _by_hand(self, merchant: str, date: str) -> str:
        return self._insert_txn(merchant=merchant, date=date)

    def _select(self, flt: dict) -> set:
        """The ids `select all matching` would act on for this filter."""
        with self._use_db_path():
            result = bulk_update_transactions(BulkUpdateRequest(
                selection=BulkSelection(mode="filter", filter=flt),
                actions=[BulkAction(type="set_notes", notes="selected")],
            ))
        self.assertIsNotNone(result)
        with self._use_db_path(), get_db() as conn:
            rows = conn.execute("SELECT id FROM txn WHERE notes = 'selected'").fetchall()
            conn.execute("UPDATE txn SET notes = NULL")
        return {row["id"] for row in rows}

    def _trashed_ids(self) -> set:
        with self._use_db_path(), get_db() as conn:
            rows = conn.execute("SELECT id FROM txn WHERE trashed_at IS NOT NULL").fetchall()
        return {row["id"] for row in rows}

    def test_each_origin_selects_only_its_own_rows(self):
        synced = self._synced("Fablestream", "2026-03-01")
        imported = self._from_file("Fablemart", "2026-03-02")
        manual = self._by_hand("Cash", "2026-03-03")

        self.assertEqual(self._select({"attribute_ids": "from-connection"}), {synced})
        self.assertEqual(self._select({"attribute_ids": "from-file"}), {imported})
        # A hand-entered row is neither, which is the honest answer rather than a third bucket.
        self.assertEqual(self._select({}), {synced, imported, manual})

    def test_excluding_an_origin_keeps_every_row_that_is_not_it(self):
        synced = self._synced("Fablestream", "2026-03-01")
        imported = self._from_file("Fablemart", "2026-03-02")
        manual = self._by_hand("Cash", "2026-03-03")

        self.assertEqual(self._select({"exclude_attribute_ids": "from-file"}), {synced, manual})
        self.assertEqual(self._select({"exclude_attribute_ids": "from-connection"}), {imported, manual})

    def test_both_origins_reach_the_filter_vocabulary(self):
        keys = {entry["key"] for entry in list_filter_attributes()}

        self.assertIn("from-connection", keys)
        self.assertIn("from-file", keys)

    def test_old_imported_rows_can_be_trashed_without_touching_the_synced_ones(self):
        # The cleanup this exists for, end to end: everything from a file before the cutoff, and
        # nothing else. A dropped filter key does not error here — it widens the selection — so the
        # rows that must survive are asserted as carefully as the ones that go.
        old_imported = self._from_file("Fablemart", "2012-06-04")
        old_synced = self._synced("Fablestream", "2012-06-05")
        old_manual = self._by_hand("Cash", "2012-06-06")
        recent_imported = self._from_file("Fablemart", "2026-06-07")

        with self._use_db_path():
            result = bulk_update_transactions(BulkUpdateRequest(
                selection=BulkSelection(
                    mode="filter",
                    filter={"date_end": CUTOFF, "attribute_ids": "from-file"},
                ),
                actions=[BulkAction(type="trash")],
            ))

        self.assertEqual(result["updated_count"], 1)
        self.assertEqual(self._trashed_ids(), {old_imported})
        for survivor in (old_synced, old_manual, recent_imported):
            self.assertNotIn(survivor, self._trashed_ids())


if __name__ == "__main__":
    unittest.main()
