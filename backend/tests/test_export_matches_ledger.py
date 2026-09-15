"""
The CSV export resolves the rows the Transactions ledger lists, in the ledger's order.

The ledger offers a set too large to copy as this download, so a file that disagreed with the list would
hand over different transactions than the ones on screen — with nothing to tell anyone it had. Both halves
therefore go through `transaction_list_scope`; these tests guard that the export still does, and that its
filter dependency still names every filter the list feed accepts.
"""

from __future__ import annotations

import asyncio
import inspect
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.backup import export_transactions_csv
from backend.routers.transactions import list_transactions, transaction_list_filters
from backend.services.transaction_facets import TransactionFacets


def _defaults(fn) -> dict:
    # A direct call leaves each unset Query() as a FieldInfo, so resolve every parameter to its default.
    return {name: getattr(p.default, "default", p.default) for name, p in inspect.signature(fn).parameters.items()}


def _drain(resp) -> list[str]:
    async def collect():
        parts = []
        async for chunk in resp.body_iterator:
            parts.append(chunk if isinstance(chunk, str) else chunk.decode())
        return "".join(parts)

    text = asyncio.new_event_loop().run_until_complete(collect())
    return [line.strip() for line in text.splitlines()[1:] if line.strip()]


class ExportMatchesLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "export.db"
        init_db(str(self.db_path))
        self.account = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype, mask,
                   owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture_export', 'Checking', 'Checking', 'checking', 'checking', '4321', ?, NULL, NULL)
                """,
                (self.account, f"acct_{self.account}", SHARED_OWNER_ID),
            )
            for txn_id, merchant, amount, needs_review, trashed_at in (
                ("txn-small", "Corner Cafe", 12.0, 1, None),
                ("txn-large", "Harbor Books", 40.0, 1, None),
                ("txn-reviewed", "Corner Grocer", 55.0, 0, None),
                ("txn-below-bound", "Riverstone Bikes", 8.0, 1, None),
                ("txn-trashed", "Northgate Diner", 30.0, 1, "2026-05-11T00:00:00.000Z"),
            ):
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, date, amount, merchant_name, display_name, raw_name,
                       category_id, owner_id, is_pending, needs_review, trashed_at)
                    VALUES (?, ?, '2026-05-10', ?, ?, ?, ?, NULL, ?, 0, ?, ?)
                    """,
                    (txn_id, self.account, amount, merchant, merchant, merchant, SHARED_OWNER_ID, needs_review, trashed_at),
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

    def test_export_lists_the_ledger_rows_in_the_ledger_order(self):
        # The filters the Transactions page sends beyond the chips — its quick filter and amount popover —
        # and a non-default sort. The export used to read none of them, nor skip trashed rows.
        filters = dict(require_all_attribute_ids="needs-review", amount_min=10.0)
        sort = dict(sort_by="amount", sort_dir="desc")
        with self._use_db_path():
            ledger = list_transactions(**{
                **_defaults(list_transactions), **filters, **sort, "facets": TransactionFacets(), "limit": 0,
            })
            exported = _drain(export_transactions_csv(
                columns="merchant_name", facets=TransactionFacets(),
                filters={**_defaults(transaction_list_filters), **filters}, **sort,
            ))

        ledger_merchants = [txn["display_name"] for txn in ledger["transactions"]]
        self.assertEqual(ledger_merchants, ["Harbor Books", "Corner Cafe"])
        self.assertEqual(exported, ledger_merchants)

    def test_export_accepts_every_filter_the_list_feed_does(self):
        # A filter the dependency does not name is not an error over HTTP — it is ignored, and the download
        # silently holds more rows than the list it was taken from.
        list_filters = set(inspect.signature(list_transactions).parameters) - {
            "facets", "sort_by", "sort_dir", "limit", "offset",
        }
        self.assertEqual(set(inspect.signature(transaction_list_filters).parameters), list_filters)


if __name__ == "__main__":
    unittest.main()
