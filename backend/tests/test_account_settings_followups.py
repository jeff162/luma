"""
An account's owner or type change re-applies the rules to its rows (services/account_settings_followups.py),
keeping what was set by hand and what no rule claims any more. All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.accounts import AccountUpdate, update_account


class AccountSettingsFollowupTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "followups.db"
        init_db(str(self.db_path))
        self.token = set_current_db_path(str(self.db_path))
        with get_db() as conn:
            self.robin, self.sam = str(uuid.uuid4()), str(uuid.uuid4())
            conn.executemany("INSERT INTO owner (id, name) VALUES (?, ?)", [(self.robin, "Robin"), (self.sam, "Sam")])
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('chk', 'x_chk', 'fixture', 'Riverstone Checking', 'Riverstone Checking', 'depository', ?)""",
                (self.robin,),
            )
            self.lessons, self.gifts = str(uuid.uuid4()), str(uuid.uuid4())
            conn.executemany(
                "INSERT INTO category (id, name, category_type) VALUES (?, ?, 'expense')",
                [(self.lessons, "Lessons"), (self.gifts, "Gifts")],
            )
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, owner_id) VALUES (?, ?, 'studio', ?)",
                (str(uuid.uuid4()), self.lessons, self.sam),
            )

    def tearDown(self):
        reset_current_db_path(self.token)
        self.tempdir.cleanup()

    def _txn(self, *, category=None, overridden=0):
        txn_id = str(uuid.uuid4())
        with get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, date, amount, raw_name, merchant_name, category_id,
                                    category_source, category_overridden)
                   VALUES (?, 'chk', ?, '2026-03-02', 40.0, 'Cedar Studio', 'Cedar Studio', ?, ?, ?)""",
                (txn_id, self.robin, category, "manual" if overridden else None, overridden),
            )
        return txn_id

    def _category_of(self, txn_id):
        with get_db() as conn:
            return conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()["category_id"]

    def test_an_owner_change_applies_that_owners_rules_and_keeps_hand_set_and_unclaimed_categories(self):
        plain = self._txn()
        by_hand = self._txn(category=self.gifts, overridden=1)

        update_account("chk", AccountUpdate(owner_id=self.sam))
        self.assertEqual(self._category_of(plain), self.lessons)
        self.assertEqual(self._category_of(by_hand), self.gifts)

        update_account("chk", AccountUpdate(owner_id=self.robin))    # no rule claims it now; it keeps its category
        self.assertEqual(self._category_of(plain), self.lessons)


if __name__ == "__main__":
    unittest.main()
