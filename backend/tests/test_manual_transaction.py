"""
Entering a transaction by hand — cash, a cheque, a charge on an account nothing syncs.

The insert itself is trivial; what is worth pinning is the provenance a hand-entered row has to carry to
behave like every other row afterwards. Two of those are invisible in the result and silent when wrong:

- the **content hash** must be the importers' own function, because that is the whole mechanism by which
  a later import of the same charge recognizes this row as its duplicate. A second implementation would
  compute a different digest for identical data and simply never match;
- an **uncategorized** entry runs through the rules, so a hand-entered row does not land in the
  uncategorized pile for no reason other than which door it came through.

Driven through the full stack, because a create endpoint is exactly where request-body parsing and
routing are the thing under test.
"""

from __future__ import annotations

import sqlite3
import unittest
import uuid

from backend.db.database import SHARED_OWNER_ID
from backend.routers.import_export.core import make_hash
from backend.tests._api_client import api_client


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


class ManualTransactionTests(unittest.TestCase):
    def _seed(self, path, *, owner=SHARED_OWNER_ID):
        conn = _connect(path)
        account = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO account (id, external_account_id, connection_id, provider, name, display_name,"
            " type, subtype, mask, owner_id) "
            "VALUES (?, NULL, NULL, 'manual', 'Wallet', 'Wallet', 'other', NULL, NULL, ?)",
            (account, owner),
        )
        group = conn.execute(
            "SELECT id FROM category WHERE name = 'Food & Drink' AND parent_id IS NULL"
        ).fetchone()["id"]
        leaf = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?,?,?,?,0)",
            (leaf, group, "Coffee & Drinks", "expense"),
        )
        conn.commit()
        conn.close()
        return {"account": account, "leaf": leaf, "group": group}

    def _row(self, path, txn_id):
        conn = _connect(path)
        row = conn.execute("SELECT * FROM txn WHERE id = ?", (txn_id,)).fetchone()
        conn.close()
        return row

    def test_records_the_transaction_with_hand_entered_provenance(self):
        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post("/api/transactions", json={
                "account_id": seeded["account"],
                "date": "2026-08-14",
                "amount": 12.5,
                "payee": "Corner Cafe",
                "category_id": seeded["leaf"],
                "notes": "Cash",
            })
            self.assertEqual(created.status_code, 200, created.text)
            row = self._row(path, created.json()["id"])

        self.assertEqual(row["amount"], 12.5)
        self.assertEqual(row["date"], "2026-08-14")
        self.assertEqual(row["display_name"], "Corner Cafe")
        self.assertEqual(row["notes"], "Cash")
        self.assertEqual(row["category_id"], seeded["leaf"])
        # A chosen category is a manual one, and locked against the automatic passes like any other.
        self.assertEqual(row["category_source"], "manual")
        self.assertEqual(row["category_overridden"], 1)
        self.assertEqual(row["display_name_source"], "manual")
        # No ingestion event produced it, and it is not new work to review.
        self.assertIsNone(row["import_batch_id"])
        self.assertIsNone(row["external_transaction_id"])
        self.assertEqual(row["needs_review"], 0)
        self.assertEqual(row["is_pending"], 0)

    def test_the_content_hash_is_the_importers_own_so_a_later_import_can_match_it(self):
        # The load-bearing one. Duplicate detection indexes existing rows by content_hash and explicitly
        # admits rows with no import batch as candidates; a hand-rolled hash here would be a different
        # digest for identical data, and the match this exists for would never fire.
        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post("/api/transactions", json={
                "account_id": seeded["account"], "date": "2026-08-14",
                "amount": 12.5, "payee": "Corner Cafe",
            })
            row = self._row(path, created.json()["id"])
        self.assertEqual(row["content_hash"], make_hash("2026-08-14", 12.5, "Corner Cafe"))

    def test_the_owner_follows_the_account(self):
        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post("/api/transactions", json={
                "account_id": seeded["account"], "date": "2026-08-14",
                "amount": 12.5, "payee": "Corner Cafe",
            })
            row = self._row(path, created.json()["id"])
        self.assertEqual(row["owner_id"], SHARED_OWNER_ID)

    def test_an_uncategorized_entry_is_run_through_the_rules(self):
        with api_client() as (client, path):
            seeded = self._seed(path)
            conn = _connect(path)
            conn.execute(
                "INSERT INTO category_rule (id, keyword, category_id) VALUES (?, ?, ?)",
                (str(uuid.uuid4()), "corner cafe", seeded["leaf"]),
            )
            conn.commit()
            conn.close()
            created = client.post("/api/transactions", json={
                "account_id": seeded["account"], "date": "2026-08-14",
                "amount": 12.5, "payee": "Corner Cafe",
            })
            row = self._row(path, created.json()["id"])
        self.assertEqual(row["category_id"], seeded["leaf"])
        # Rule-set, not manual: a future rule may still reclaim it, which is the point of the
        # distinction and would be lost by stamping every hand-entered row as manual.
        self.assertEqual(row["category_source"], "rule")
        self.assertEqual(row["category_overridden"], 0)

    def test_a_money_in_entry_is_stored_as_the_negative_the_ledger_expects(self):
        # The API carries signed amounts in the ledger's convention; the direction is chosen at the UI
        # boundary. Pinned because getting it backwards would invert every hand-entered deposit while
        # looking entirely plausible on the way in.
        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post("/api/transactions", json={
                "account_id": seeded["account"], "date": "2026-08-14",
                "amount": -400.0, "payee": "Refund",
            })
            row = self._row(path, created.json()["id"])
        self.assertEqual(row["amount"], -400.0)

    def test_it_shows_up_in_the_ledger_it_was_added_to(self):
        with api_client() as (client, path):
            seeded = self._seed(path)
            client.post("/api/transactions", json={
                "account_id": seeded["account"], "date": "2026-08-14",
                "amount": 12.5, "payee": "Corner Cafe",
            })
            listed = client.get("/api/transactions")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertIn("Corner Cafe", [row["display_name"] for row in listed.json()["transactions"]])

    def test_the_refusals_are_written_for_the_person_filling_the_form(self):
        with api_client() as (client, path):
            seeded = self._seed(path)
            base = {"account_id": seeded["account"], "date": "2026-08-14", "amount": 12.5, "payee": "Corner Cafe"}

            with self.subTest("a payee is required"):
                refused = client.post("/api/transactions", json={**base, "payee": "   "})
                self.assertEqual(refused.status_code, 400)
                self.assertIn("payee", refused.json()["detail"])

            with self.subTest("the date has to be a date"):
                refused = client.post("/api/transactions", json={**base, "date": "14/08/2026"})
                self.assertEqual(refused.status_code, 400)
                self.assertIn("YYYY-MM-DD", refused.json()["detail"])

            with self.subTest("zero is not an amount"):
                refused = client.post("/api/transactions", json={**base, "amount": 0})
                self.assertEqual(refused.status_code, 400)
                self.assertIn("amount", refused.json()["detail"])

            with self.subTest("the account has to exist"):
                refused = client.post("/api/transactions", json={**base, "account_id": "nope"})
                self.assertEqual(refused.status_code, 404)

            with self.subTest("a group is not a category"):
                refused = client.post("/api/transactions", json={**base, "category_id": seeded["group"]})
                self.assertEqual(refused.status_code, 400)
                self.assertIn("not a group", refused.json()["detail"])
