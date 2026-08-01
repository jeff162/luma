"""Demo dataset builder: completeness + the safety guard.

The demo data is a shared fixture (the E2E baseline and a future onboarding feature), so it's worth
pinning that it builds the expected shape — and, critically, that the guard refuses to touch a
non-empty database (it must never overwrite real data).
"""

import json
import tempfile
import unittest
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db
from backend.db.demo_data import (
    DISCRETIONARY_TAG,
    ESSENTIAL_TAG,
    is_demo_loadable,
    load_demo_data,
)


class DemoDataTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "demo.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    def _conn(self):
        return get_db(str(self.db_path))

    def test_loads_expected_shape(self):
        with self._conn() as conn:
            summary = load_demo_data(conn, scope_id="demo-profile")
        self.assertFalse(summary["skipped"])

        with self._conn() as conn:
            owners = conn.execute(
                "SELECT COUNT(*) FROM owner WHERE id != ?", (SHARED_OWNER_ID,)
            ).fetchone()[0]
            self.assertEqual(owners, 2)

            # Four accounts spanning four distinct types.
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM account").fetchone()[0], 4)
            types = {r[0] for r in conn.execute("SELECT type FROM account")}
            self.assertEqual(types, {"depository", "savings", "credit", "investment"})

            n_txn = conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0]
            self.assertGreater(n_txn, 60)
            self.assertEqual(n_txn, summary["transactions"])

            # Custom category + a rule onto it.
            self.assertTrue(conn.execute("SELECT 1 FROM category WHERE name = 'Pet Care'").fetchone())
            pet_rule = conn.execute(
                """SELECT c.name FROM category_rule r JOIN category c ON c.id = r.category_id
                   WHERE LOWER(r.keyword) = 'petco'"""
            ).fetchone()
            self.assertEqual(pet_rule["name"], "Pet Care")

            # Both tags exist and are applied at the category level (the inheritance source).
            for tag_name in (ESSENTIAL_TAG, DISCRETIONARY_TAG):
                tag = conn.execute("SELECT id FROM tag WHERE name = ?", (tag_name,)).fetchone()
                self.assertIsNotNone(tag)
                links = conn.execute(
                    "SELECT COUNT(*) FROM category_tag WHERE tag_id = ?", (tag["id"],)
                ).fetchone()[0]
                self.assertGreater(links, 0)
            # Essential Expenses is on Groceries specifically (a leaf with transactions → inheritance).
            groceries = conn.execute(
                "SELECT id FROM category WHERE name = 'Groceries' AND parent_id IS NOT NULL"
            ).fetchone()["id"]
            ess = conn.execute("SELECT id FROM tag WHERE name = ?", (ESSENTIAL_TAG,)).fetchone()["id"]
            self.assertTrue(
                conn.execute(
                    "SELECT 1 FROM category_tag WHERE category_id = ? AND tag_id = ?", (groceries, ess)
                ).fetchone()
            )

            # The inter-account transfer: two legs, two accounts, opposite signs netting zero.
            legs = conn.execute(
                "SELECT account_id, amount FROM txn WHERE merchant_name LIKE 'Transfer %'"
            ).fetchall()
            self.assertEqual(len(legs), 2)
            self.assertEqual(len({r["account_id"] for r in legs}), 2)
            self.assertEqual(round(sum(r["amount"] for r in legs), 2), 0.0)

            # Two import files (one per data source), produced through the real import pipeline — so every
            # row has provenance, both files land under a saved data source, and the cards get coverage.
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM import_batch").fetchone()[0], 2)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM txn WHERE import_batch_id IS NULL").fetchone()[0], 0
            )
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM csv_import_profile").fetchone()[0], 2)
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(DISTINCT account_id) FROM import_batch_account WHERE account_id IS NOT NULL"
                ).fetchone()[0],
                4,
            )
            # Several novel (non-starter) expense categories land in Unassigned so the "Group imported
            # categories" workspace has real items to organize, not just one.
            unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
            self.assertGreaterEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM category WHERE parent_id = ? AND import_pending = 1", (unassigned,)
                ).fetchone()[0],
                4,
            )

            # The cross-account duplicate pair shares a content_hash...
            dup_groups = conn.execute(
                "SELECT COUNT(*) c FROM txn WHERE content_hash IS NOT NULL "
                "GROUP BY content_hash HAVING c > 1"
            ).fetchall()
            self.assertTrue(any(r["c"] == 2 for r in dup_groups))

            # ...and the REAL post-import sweep flagged exactly one of them as a cross-account suspect.
            self.assertEqual(summary["suspects_flagged"], 1)
            flagged = conn.execute(
                "SELECT COUNT(*) FROM txn WHERE suspect_duplicate_of IS NOT NULL "
                "AND suspect_duplicate_reason = 'cross_account'"
            ).fetchone()[0]
            self.assertEqual(flagged, 1)

            # Sign convention sanity: income stored negative, spending positive.
            salary = conn.execute(
                "SELECT amount FROM txn WHERE merchant_name = 'Acme Corp Payroll' LIMIT 1"
            ).fetchone()["amount"]
            self.assertLess(salary, 0)
            rent = conn.execute(
                "SELECT amount FROM txn WHERE merchant_name = 'Parkside Apartments' LIMIT 1"
            ).fetchone()["amount"]
            self.assertGreater(rent, 0)

            # UI preference seeded (JSON-encoded) so the demo opens with the accounts list expanded.
            pref = conn.execute(
                "SELECT pref_value FROM ui_preference "
                "WHERE scope_id = 'demo-profile' AND pref_key = 'ui.accounts.sections'"
            ).fetchone()
            self.assertIsNotNone(pref)
            self.assertTrue(json.loads(pref["pref_value"])["accountList"])

    def test_guard_refuses_a_non_empty_db(self):
        with self._conn() as conn:
            first = load_demo_data(conn)
        self.assertFalse(first["skipped"])

        with self._conn() as conn:
            self.assertFalse(is_demo_loadable(conn))
            second = load_demo_data(conn)
            txns_after = conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0]

        self.assertTrue(second["skipped"])
        # Second load must not duplicate anything.
        self.assertEqual(txns_after, first["transactions"])

    def test_saved_data_source_suppresses_loadable(self):
        # A fresh tenant (only the seeded category skeleton) is a blank slate.
        with self._conn() as conn:
            self.assertTrue(is_demo_loadable(conn))
            # Saving a data source is engagement even before any file is imported.
            conn.execute("INSERT INTO csv_import_profile (id, name) VALUES ('p1', 'My Bank')")
        with self._conn() as conn:
            self.assertFalse(is_demo_loadable(conn))

    def test_linked_connection_suppresses_loadable(self):
        with self._conn() as conn:
            self.assertTrue(is_demo_loadable(conn))
            # A linked connection counts even before any transactions have synced.
            conn.execute("INSERT INTO connection (id, provider, external_id) VALUES ('c1', 'plaid', 'item-1')")
        with self._conn() as conn:
            self.assertFalse(is_demo_loadable(conn))


if __name__ == "__main__":
    unittest.main()
