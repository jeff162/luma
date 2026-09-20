"""What an import refused, kept per row so the file's report can still show it.

A file is gone the moment its upload ends, so a count of what was dropped is the whole record unless
the rows themselves are stored. These pin the three properties that record is worth having for: every
class of refusal is kept (not only the parse failures), the cap prefers the rows that indicate a
problem over the ones the user chose, and a suspected footer collapses to one row instead of burying
them. The endpoint's fallback for batches older than the table is pinned too, since that is the case
nothing else exercises."""

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import (
    MAX_STORED_REJECTED_ROWS,
    get_batch_not_imported,
    run_import_core,
)


class ImportNotImportedReportTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "not-imported.db"
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            for account_id, name in (("acc-chk", "Checking"), ("acc-save", "Savings")):
                conn.execute(
                    """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
                       VALUES (?, NULL, 'manual', ?, ?, 'depository')""",
                    (account_id, name, name),
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

    def _cfg(self, skip_accounts=()):
        return {
            "account_map": {"Checking": "acc-chk", "Savings": "acc-save"},
            "skip_accounts": list(skip_accounts),
            "column_map": {"date": "Date", "amount": "Amount", "description": "Description", "account": "Account"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
            "use_imported_categories": False,
        }

    def _run(self, csv, skip_accounts=()):
        with self._use_db_path():
            return run_import_core(csv, self._cfg(skip_accounts), filename="bank.csv")

    def _report(self, batch_id):
        with self._use_db_path():
            return get_batch_not_imported(batch_id)

    def test_rows_from_a_skipped_account_are_kept_not_just_counted(self):
        # The class the old record had no rows for at all: skipping an account left a per-value count,
        # which cannot answer "what was in the part I left out" once the file is gone.
        csv = (
            "Date,Description,Amount,Account\n"
            "2026-01-05,Hardware store,54.20,Checking\n"
            "2026-01-06,Interest,-1.12,Savings\n"
        )
        result = self._run(csv, skip_accounts=["Savings"])
        report = self._report(result["batch_id"])
        # The amount is the one the ledger would have stored (money out positive), not the file's text,
        # so the column reads the same way as the imported list beside it; the cell as written stays in
        # `values`.
        self.assertEqual([(row["kind"], row["description"], row["amount"]) for row in report["rows"]],
                         [("account_skipped", "Interest", 1.12)])
        self.assertEqual(report["rows"][0]["values"]["Amount"], "-1.12")
        self.assertEqual(report["totals"]["account_skipped"], 1)
        self.assertEqual(report["rows"][0]["values"]["Account"], "Savings")

    def test_the_cap_keeps_parse_failures_over_rows_the_user_chose_to_skip(self):
        # A deliberate skip is the most numerous refusal and the least informative one, so it must not
        # be able to push a parse failure out of a capped record. Interleaved rather than consecutive:
        # five unparseable rows in a row are read as a footer, which is a different mechanism.
        lines = ["Date,Description,Amount,Account", "2026-01-01,Opening,10.00,Checking"]
        for index in range(MAX_STORED_REJECTED_ROWS + 20):
            lines.append(f"2026-02-{(index % 28) + 1:02d},Transfer {index},{index}.00,Savings")
            if index % 100 == 7:
                lines.append(f"not-a-date,Broken {index},12.00,Checking")
        result = self._run("\n".join(lines) + "\n", skip_accounts=["Savings"])
        report = self._report(result["batch_id"])
        kinds = [row["kind"] for row in report["rows"]]
        self.assertEqual(len(report["rows"]), MAX_STORED_REJECTED_ROWS)
        self.assertEqual(kinds.count("validation_error"), report["totals"]["validation_error"])
        self.assertGreater(kinds.count("validation_error"), 0)
        # …and the report still reports the true size of what it is showing a slice of.
        self.assertGreater(report["total_count"], len(report["rows"]))

    def test_a_suspected_footer_is_one_row_naming_the_range(self):
        # The tail was excluded on a single judgement, so it is a single fact. Listing each line would
        # crowd out the rows a reader opened the report to find.
        csv = (
            "Date,Description,Amount,Account\n"
            "2026-01-05,Hardware store,54.20,Checking\n"
            "2026-01-06,Coffee,6.50,Checking\n"
            "Totals,,60.70,\n"
            "Generated by account export,,,\n"
            "End of report,,,\n"
            "Page 1 of 1,,,\n"
            "Questions? See the help centre,,,\n"
        )
        result = self._run(csv)
        report = self._report(result["batch_id"])
        trailing = [row for row in report["rows"] if row["kind"] == "trailing_text"]
        self.assertEqual(len(trailing), 1)
        self.assertIn("4", trailing[0]["reason"])
        self.assertEqual(report["totals"]["trailing_text"], result["trailing_error_count"])
        # The footer's own lines are not also listed as individual validation errors.
        self.assertEqual([row["kind"] for row in report["rows"]], ["trailing_text"])

    def test_a_batch_older_than_the_table_falls_back_to_its_snapshot(self):
        # Every import before this table has only the up-to-twenty rows its snapshot recorded. Reading
        # those is worth more than reporting that the file dropped nothing.
        batch_id = str(uuid.uuid4())
        snapshot = {
            "import_summary": {
                "validation_error_count": 2,
                "rejected_headers": ["Date", "Description", "Amount"],
                "rejected_rows": [
                    {"row": 4, "kind": "validation_error", "reason": "Invalid date: 'n/a'",
                     "values": {"Date": "n/a", "Description": "Refund", "Amount": "-9.99"}},
                ],
            }
        }
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, row_count, config_snapshot) VALUES (?, ?, ?, ?)",
                (batch_id, "old.csv", 12, json.dumps(snapshot)),
            )
        report = self._report(batch_id)
        self.assertEqual([row["reason"] for row in report["rows"]], ["Invalid date: 'n/a'"])
        self.assertEqual(report["headers"], ["Date", "Description", "Amount"])
        self.assertEqual(report["totals"]["validation_error"], 2)


if __name__ == "__main__":
    unittest.main()
