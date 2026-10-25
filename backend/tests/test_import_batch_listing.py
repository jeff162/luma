"""
Batch-listing contract.

The "Save as data source" flow only auto-adopts the most-recent profileless batch into a new
source when that batch's file shape matches the source. That guard runs client-side, so it
depends on `GET /batches` exposing each batch's `header_fingerprint`. This pins that field so a
future payload trim can't silently reintroduce the bug where an unrelated earlier import got
filed under a freshly-created data source.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.import_export import run_import
from backend.routers.import_export.core import (
    get_batch_removed_duplicates,
    get_rule_suggestion_work,
    list_batches,
)
from backend.services.duplicate_detection import restore_rejected_duplicate


class FakeUploadFile:
    def __init__(self, filename: str, content: str):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self) -> bytes:
        return self._content


class ImportBatchListingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "batch-listing-tests.db"
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

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", "fixture_import", name, name, "checking", "checking", "1234", SHARED_OWNER_ID),
                )
        return account_id

    async def test_batch_listing_exposes_header_fingerprint(self):
        account_id = self._insert_account("Checking")
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": {"Checking": account_id},
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        with self._use_db_path():
            await run_import(
                file=FakeUploadFile("fixture.csv", "Date,Description,Account,Amount\n2026-01-02,Coffee,Checking,4.50"),
                config=json.dumps(config),
            )
            batches = list_batches()

        self.assertEqual(len(batches), 1)
        # The fingerprint is the pipe-joined header row — what the client compares against a new
        # data source's fingerprint before adopting the batch.
        self.assertEqual(batches[0]["header_fingerprint"], "Date|Description|Account|Amount")

    async def test_batch_listing_exposes_an_account_the_import_created(self):
        """A file with no account column may create its account as it imports, and the client needs the
        created account's *name* back: it is how an imported-category scope selection is keyed for an
        account that had no id to be chosen by when the scope was set.

        The field is nested inside the batch's parsed `config_snapshot`, and the helper that read it only
        accepted stored text, so it came back `{}` — a shape indistinguishable from "this import created
        no account", which is why nothing noticed.
        """
        config = {
            "filename": "created.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": None,
            "skip_accounts": None,
            "new_accounts": [{"csv_value": "__single_account__", "name": "Harborline Savings", "type": "depository"}],
            "single_account_new": {"name": "Harborline Savings", "type": "depository"},
            "column_map": {"date": "Date", "description": "Description", "amount": "Amount"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        with self._use_db_path():
            await run_import(
                file=FakeUploadFile("created.csv", "Date,Description,Amount\n2026-01-02,Coffee,4.50"),
                config=json.dumps(config),
            )
            batches = list_batches()

        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["single_account_new"], {"name": "Harborline Savings", "type": "depository"})

    async def test_a_batch_that_created_no_account_says_so(self):
        """The control: the field has to be empty where no account was created, or the assertion above
        would pass against a reader that simply echoes something for every batch."""
        account_id = self._insert_account("Checking")
        config = {
            "filename": "plain.csv",
            "profile_id": None,
            "account_id": account_id,
            "account_map": None,
            "skip_accounts": None,
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "amount": "Amount"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        with self._use_db_path():
            await run_import(
                file=FakeUploadFile("plain.csv", "Date,Description,Amount\n2026-01-02,Coffee,4.50"),
                config=json.dumps(config),
            )
            batches = list_batches()
        self.assertEqual(batches[0]["single_account_new"], {})

    def _insert_completed_batch(self, filename: str, imported_at: str) -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO import_batch (id, filename, imported_at, status) VALUES (?, ?, ?, 'completed')",
                    (batch_id, filename, imported_at),
                )
        return batch_id

    async def test_batch_listing_is_not_capped_at_fifty(self):
        # Regression: the listing used to `LIMIT 50` globally, so a heavy importer silently lost older
        # cards (and an actively-fed source could crowd another source's history out of the window
        # entirely). The full completed history must come back. See the per-source archive backlog item.
        count = 60
        for i in range(count):
            # Zero-padded month/day so lexical imported_at order matches chronological order.
            self._insert_completed_batch(f"file-{i:03d}.csv", f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}")
        with self._use_db_path():
            batches = list_batches()
        self.assertEqual(len(batches), count)

    async def test_rows_removed_after_import_are_counted_on_the_card_and_uncounted_by_restore(self):
        # A card whose duplicates were all decided after its import — here, another file's Replace removed
        # this file's older copy — had no duplicates pill, so its report and that report's Restore were
        # unreachable from the card. The count must name exactly the rows the report lists.
        batch_id = self._insert_completed_batch("harborline-march.csv", "2026-03-31T09:00:00")
        account_id = self._insert_account("Harborline Checking")
        with self._use_db_path(), get_db() as conn:
            def txn(txn_id, *, batch=None, removed_in_favor_of=None):
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, raw_name, date, is_pending,
                                     import_batch_id, suspect_duplicate_of, trashed_at, rejection_reason,
                                     dedupe_resolved_by)
                    VALUES (?, ?, ?, 12.5, 'Corner Cafe', 'Corner Cafe', '2026-03-14', 0, ?, ?, ?, ?, ?)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, batch, removed_in_favor_of,
                     "2026-04-01T00:00:00Z" if removed_in_favor_of else None,
                     "duplicate_confirmed" if removed_in_favor_of else None,
                     "user" if removed_in_favor_of else None),
                )
            txn("kept")                                              # the other file's copy that replaced it
            txn("removed", batch=batch_id, removed_in_favor_of="kept")
            txn("untouched", batch=batch_id)
        with self._use_db_path():
            card = next(b for b in list_batches() if b["id"] == batch_id)
            self.assertEqual(card["removed_duplicate_count"], 1)
            self.assertEqual(get_batch_removed_duplicates(batch_id)["count"], 1)
            with get_db() as conn:
                restore_rejected_duplicate(conn, "removed")
            card = next(b for b in list_batches() if b["id"] == batch_id)
            self.assertEqual(card["removed_duplicate_count"], 0, "a restored row is an ordinary transaction again")

    async def test_each_card_counts_only_its_own_flagged_rows(self):
        # The counts are taken for the whole history in one grouped pass, so a mistake there lands a
        # figure on the wrong card, or counts a row its predicate excludes, without failing anything else.
        # Two cards with different figures in every count pin both.
        first = self._insert_completed_batch("first.csv", "2026-03-01T09:00:00")
        second = self._insert_completed_batch("second.csv", "2026-04-01T09:00:00")
        account_id = self._insert_account("Checking")
        trashed = "2026-04-02T00:00:00Z"
        with self._use_db_path(), get_db() as conn:
            def txn(batch, *, needs_review=0, suspect=False, resolved=False, removed=False, is_trashed=False):
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, raw_name, date, is_pending,
                                     import_batch_id, needs_review, suspect_duplicate_of, suspect_resolved_at,
                                     rejection_reason, trashed_at)
                    VALUES (?, ?, ?, 5, 'Corner Cafe', 'Corner Cafe', '2026-03-14', 0, ?, ?, ?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), account_id, SHARED_OWNER_ID, batch, needs_review,
                     "other" if suspect or removed else None, trashed if resolved else None,
                     "duplicate_confirmed" if removed else None, trashed if removed or is_trashed else None),
                )

            def report_row(batch, number, *, enriched=False, substate=None, reviewed=False):
                conn.execute(
                    """
                    INSERT INTO import_batch_duplicate (batch_id, row_number, reason, enriched_at, review_substate,
                                                        reviewed_at)
                    VALUES (?, ?, 'duplicate', ?, ?, ?)
                    """,
                    (batch, number, trashed if enriched else None, substate, trashed if reviewed else None),
                )

            for _ in range(3):
                txn(first, needs_review=1)
            txn(first, needs_review=1, is_trashed=True)          # trashed: not counted as needing review
            txn(first, suspect=True)
            txn(first, suspect=True, resolved=True)              # resolved: no longer a suspect
            txn(first, removed=True)
            txn(second, needs_review=1)
            for _ in range(2):
                txn(second, suspect=True)
            txn(second, suspect=True, is_trashed=True)           # trashed: no longer a suspect
            for _ in range(3):
                txn(second, removed=True)
            report_row(first, 1, enriched=True)
            report_row(first, 2, substate="no_match")
            report_row(first, 3, substate="no_match", reviewed=True)   # reviewed: nothing left to ask
            report_row(second, 1, substate="matched_near_date")
            report_row(second, 2, substate="matched_near_date")
            report_row(second, 3, substate="cross_account")      # settled: not an advisory sub-state
            report_row(second, 4, enriched=True)
            report_row(second, 5, enriched=True)
        with self._use_db_path():
            cards = {b["id"]: b for b in list_batches()}
        keys = ("needs_review_count", "suspect_duplicate_count", "removed_duplicate_count",
                "duplicate_row_count", "enriched_duplicate_count", "advisory_review_count")
        self.assertEqual({key: cards[first][key] for key in keys}, dict(zip(keys, (3, 1, 1, 3, 1, 1))))
        self.assertEqual({key: cards[second][key] for key in keys}, dict(zip(keys, (1, 2, 3, 5, 2, 2))))

    async def test_rule_suggestion_work_agrees_with_the_history_it_summarizes(self):
        # The Rules page reads these two figures from their own endpoint while the Import page sums them
        # from the history; both must apply the same rule — only an import marked to use its categories
        # that actually carried some feeds the suggester.
        account_id = self._insert_account("Checking")

        def batch(name, *, use_categories, carries_categories, pending):
            batch_id = self._insert_completed_batch(name, "2026-03-01T09:00:00")
            snapshot = {"rule_suggestion_review": {"summary": {"pending_count": pending}}}
            with self._use_db_path(), get_db() as conn:
                conn.execute(
                    "UPDATE import_batch SET use_imported_categories = ?, config_snapshot = ? WHERE id = ?",
                    (int(use_categories), json.dumps(snapshot), batch_id),
                )
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, raw_name, date, is_pending,
                                     import_batch_id, imported_category)
                    VALUES (?, ?, ?, 5, 'Corner Cafe', 'Corner Cafe', '2026-03-14', 0, ?, ?)
                    """,
                    (str(uuid.uuid4()), account_id, SHARED_OWNER_ID, batch_id,
                     "Dining" if carries_categories else None),
                )

        with self._use_db_path():
            self.assertEqual(get_rule_suggestion_work(), {"has_work": False, "pending_count": 0})
        batch("not-marked.csv", use_categories=False, carries_categories=True, pending=7)
        batch("no-categories.csv", use_categories=True, carries_categories=False, pending=11)
        with self._use_db_path():
            self.assertEqual(get_rule_suggestion_work(), {"has_work": False, "pending_count": 0})
        batch("feeds-a.csv", use_categories=True, carries_categories=True, pending=2)
        batch("feeds-b.csv", use_categories=True, carries_categories=True, pending=3)
        with self._use_db_path():
            work = get_rule_suggestion_work()
            history = list_batches()
        self.assertEqual(work, {"has_work": True, "pending_count": 5})
        # The Import page's rule (`lib/importExport/ruleSuggestionWork.js`) over the same history.
        self.assertEqual(work["pending_count"], sum(
            b["rule_suggestion_review"]["pending_count"] for b in history
            if b["use_imported_categories"] and b["has_imported_categories"]
        ))


if __name__ == "__main__":
    unittest.main()
