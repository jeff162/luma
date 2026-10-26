"""A row one file rejected against another file's import is judged again when that import leaves the ledger.

Each scenario imports single-account files with no data source behind them, so two files describing one
account are two sources and a later file's row inside an earlier file's covered range is refused against it.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import UploadFile

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.accounts import rescan_duplicates_for_detection_change
from backend.routers.import_export import run_import, undo_batch

# CORNER DELI on the 3rd is inside the covered range the file claims: the last date it carries, the 20th,
# opens the trailing window the default leaves uncovered, and the 3rd is the last date before it.
AGGREGATOR_EXPORT = (
    "Date,Description,Amount\n"
    "2025-11-03,CORNER DELI,-14.50\n"
    "2025-11-20,CITY POWER,-88.00\n"
)
# The same deli charge as the bank words it — too differently for a text match, so only coverage refuses it.
BANK_EXPORT = (
    "Date,Description,Amount\n"
    "2025-11-03,POS PURCHASE 0042,-14.50\n"
    "2025-11-21,WATER UTILITY,-30.00\n"
)
# Two wallet exports funding the charge from the bank: nameless legs, which a covered date rejects
# outright, since a named payment would be let through on finding nothing to match.
WALLET_EXPORT = (
    "Date,Description,Amount\n"
    "2025-11-03,,-14.50\n"
    "2025-11-21,WATER UTILITY,-30.00\n"
)
WALLET_RE_EXPORT = (
    "Date,Description,Amount\n"
    "2025-11-03,,-14.50\n"
    "2025-11-22,BOOKSHOP,-12.00\n"
)


class RejudgeOrphanedRejectionsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rejudge.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, subtype, owner_id)
                   VALUES (?, ?, 'fixture_import', 'Everyday Checking', 'Everyday Checking', 'depository', 'checking', ?)""",
                (self.account_id, f"test_{self.account_id}", SHARED_OWNER_ID),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    async def _import(self, filename: str, text: str, **extra) -> str:
        config = {
            "filename": filename, "profile_id": None, "account_id": self.account_id,
            "single_account_new": None, "account_map": {}, "skip_accounts": [], "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "amount": "Amount"},
            "date_format": "%Y-%m-%d", "amount_convention": "single_signed", "skip_rows": 0,
            "apply_categorization": False, "use_imported_categories": False, **extra,
        }
        upload = UploadFile(filename=filename, file=io.BytesIO(text.encode("utf-8")))
        with self._use_db_path():
            return (await run_import(file=upload, config=json.dumps(config)))["batch_id"]

    def _undo(self, batch_id: str) -> None:
        with self._use_db_path():
            undo_batch(batch_id)

    def _deli_rows(self) -> list[tuple[str, str]]:
        """Every live ledger row for the deli charge, as (description, batch id)."""
        with self._use_db_path(), get_db() as conn:
            return [
                (r["raw_name"], r["import_batch_id"]) for r in conn.execute(
                    "SELECT raw_name, import_batch_id FROM txn "
                    "WHERE date = '2025-11-03' AND trashed_at IS NULL ORDER BY rowid"
                )
            ]

    def _held(self, batch_id: str) -> list[dict]:
        with self._use_db_path(), get_db() as conn:
            return [
                {"row": r["row_number"], "matched": json.loads(r["matched_transaction_json"])}
                for r in conn.execute(
                    "SELECT row_number, matched_transaction_json FROM import_batch_duplicate WHERE batch_id = ?",
                    (batch_id,),
                )
            ]

    async def test_undo_imports_a_row_nothing_else_accounts_for(self):
        aggregator = await self._import("aggregator.csv", AGGREGATOR_EXPORT)
        bank = await self._import("bank.csv", BANK_EXPORT)
        self.assertEqual(len(self._held(bank)), 1)

        self._undo(aggregator)

        self.assertEqual(self._deli_rows(), [("POS PURCHASE 0042", bank)])
        self.assertEqual(self._held(bank), [])

    async def test_the_oldest_file_comes_back_and_a_later_one_stays_rejected_against_it(self):
        # Both wallet files refused the leg against the aggregator, and each covers the 3rd itself. The
        # first file's leg comes back; the second's is then its duplicate, not a second copy. Judged with the
        # second file's claim in force, the first would be refused against it and neither would return.
        aggregator = await self._import("aggregator.csv", AGGREGATOR_EXPORT)
        wallet = await self._import("wallet.csv", WALLET_EXPORT)
        re_export = await self._import("wallet-again.csv", WALLET_RE_EXPORT)

        self._undo(aggregator)

        self.assertEqual(self._deli_rows(), [("", wallet)])
        held = self._held(re_export)
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]["matched"]["covered"]["source_batch_id"], wallet)
        self.assertEqual([c["import_batch_id"] for c in held[0]["matched"]["candidates"]], [wallet])

    async def test_a_replacement_file_takes_over_the_rejection(self):
        # Re-importing the aggregator in place of itself removes the rows the bank's rejection named, then
        # supplies them again; the rejection is judged after the new rows are in, so it moves onto them.
        aggregator = await self._import("aggregator.csv", AGGREGATOR_EXPORT)
        bank = await self._import("bank.csv", BANK_EXPORT)

        replacement = await self._import("aggregator.csv", AGGREGATOR_EXPORT, replace_batch_id=aggregator)

        self.assertEqual(self._deli_rows(), [("CORNER DELI", replacement)])
        held = self._held(bank)
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]["matched"]["covered"]["source_batch_id"], replacement)

    async def test_a_purged_match_does_not_bring_its_duplicate_back(self):
        # The aggregator is still imported; the user deleted its deli row outright. That is a decision
        # about the transaction, and undoing an unrelated file must not reopen the bank's rejection.
        aggregator = await self._import("aggregator.csv", AGGREGATOR_EXPORT)
        bank = await self._import("bank.csv", BANK_EXPORT)
        unrelated = await self._import("other.csv", "Date,Description,Amount\n2025-12-15,HARDWARE,-9.00\n")
        with self._use_db_path(), get_db() as conn:
            conn.execute("DELETE FROM txn WHERE import_batch_id = ? AND date = '2025-11-03'", (aggregator,))

        self._undo(unrelated)

        self.assertEqual(self._deli_rows(), [])
        self.assertEqual(len(self._held(bank)), 1)

    async def test_the_app_load_catch_up_judges_rejections_orphaned_before_it_existed(self):
        # An undo that left the bank's rejection behind, as every undo did before rejections were re-judged.
        aggregator = await self._import("aggregator.csv", AGGREGATOR_EXPORT)
        bank = await self._import("bank.csv", BANK_EXPORT)
        with self._use_db_path(), get_db() as conn:
            conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (aggregator,))
            conn.execute("DELETE FROM import_batch_account WHERE batch_id = ?", (aggregator,))
            conn.execute("UPDATE import_batch SET status = 'undone' WHERE id = ?", (aggregator,))
            conn.execute("DELETE FROM db_meta WHERE key = 'duplicate_detection_version'")

        with self._use_db_path():
            rescan_duplicates_for_detection_change()

        self.assertEqual(self._deli_rows(), [("POS PURCHASE 0042", bank)])
        self.assertEqual(self._held(bank), [])


if __name__ == "__main__":
    unittest.main()
