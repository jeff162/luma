"""The searcher's date order and number format, read from their stored preferences, through the full stack.

`test_quick_filter.py` pins the parsing. This covers what only the HTTP layer can show: that the stored
preference reaches the list, and that a bulk action over "everything matching" and the CSV export resolve
the same rows the list showed, since a disagreement there acts on rows nobody was shown.
"""

from __future__ import annotations

import csv
import io
import json
import unittest

from backend.db.database import get_db
from backend.tests._api_client import api_client


def _seed():
    with get_db() as conn:
        conn.execute("INSERT INTO account (id, name, display_name) VALUES ('acct', 'Everyday', 'Everyday')")
        for txn_id, date, amount in (
            ("jan-2", "2026-01-02", 12.00),
            ("feb-1", "2026-02-01", 1234.56),
            ("other", "2026-03-01", 1.23),
        ):
            conn.execute(
                "INSERT INTO txn (id, account_id, amount, date, merchant_name, display_name, raw_name) "
                "VALUES (?, 'acct', ?, ?, 'Northgate Supply', 'Northgate Supply', 'NORTHGATE SUPPLY')",
                (txn_id, amount, date),
            )


class StoredInputFormatTests(unittest.TestCase):
    def _found(self, client, quick_filter):
        response = client.get("/api/transactions", params={"quick_filter": quick_filter})
        self.assertEqual(response.status_code, 200, response.text)
        return sorted(row["id"] for row in response.json()["transactions"])

    def _choose(self, client, date_order, number_format):
        for key, value in (("ui.format.dateOrder", date_order), ("ui.format.number", number_format)):
            self.assertEqual(client.post("/api/auth/preferences", json={"key": key, "value": value}).status_code, 200)

    def test_the_list_reads_the_quick_filter_in_the_stored_format(self):
        with api_client() as (client, _):
            _seed()
            self.assertEqual(self._found(client, "date:01/02/2026"), ["jan-2"])
            self.assertEqual(self._found(client, "amount:1.234,56"), [])
            self._choose(client, "dmy", "comma")
            self.assertEqual(self._found(client, "date:01/02/2026"), ["feb-1"])
            self.assertEqual(self._found(client, "amount:1.234,56"), ["feb-1"])
            self.assertEqual(self._found(client, "date:2026-01-02"), ["jan-2"])

    def test_bulk_and_export_resolve_the_rows_the_list_showed(self):
        with api_client() as (client, _):
            _seed()
            self._choose(client, "dmy", "comma")
            shown = self._found(client, "date:01/02/2026")
            response = client.post("/api/transactions/bulk", json={
                "selection": {"mode": "filter", "filter": {"quick_filter": "date:01/02/2026"}},
                "actions": [{"type": "set_notes", "notes": "picked"}],
            })
            self.assertEqual(response.status_code, 200, response.text)
            with get_db() as conn:
                noted = sorted(r["id"] for r in conn.execute("SELECT id FROM txn WHERE notes = 'picked'"))
            self.assertEqual(noted, shown)

            exported = client.get("/api/import-export/transactions.csv", params={
                "quick_filter": "date:01/02/2026", "columns": "date",
            })
            self.assertEqual(exported.status_code, 200, exported.text)
            dates = [row["Date"] for row in csv.DictReader(io.StringIO(exported.text))]
            self.assertEqual(dates, ["2026-02-01"])

    def test_an_unreadable_stored_value_reads_as_the_default(self):
        with api_client() as (client, _):
            _seed()
            self._choose(client, "sideways", json.dumps({"not": "a format"}))
            self.assertEqual(self._found(client, "date:01/02/2026"), ["jan-2"])
