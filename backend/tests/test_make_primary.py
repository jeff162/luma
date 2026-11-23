"""
Making a group member the primary (`account_groups.make_root`), and the suggestion to do so when the primary
has gone quiet (`services/group_primary.py`). The swap keeps the group's settings with the group, which is the
property a careless re-root breaks. All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.accounts import (
    AccountAttachRequest, AccountUpdate, attach_account, delete_account, dismiss_closed_balance_flag, list_accounts,
    make_primary, update_account,
)
from backend.services.group_primary import quiet_primaries
from backend.tests.test_balance_totals import _Ledger

_SETTINGS = "parent_account_id, display_name, exclude_from_balance_totals, balance_totals_from, wallet_match_text, closed_on"


class MakePrimaryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        path = str(Path(self.tempdir.name) / "primary.db")
        init_db(path)
        self.token = set_current_db_path(path)
        self.addCleanup(reset_current_db_path, self.token)
        with get_db() as conn:
            conn.executemany(
                "INSERT INTO account (id, name, display_name, type, parent_account_id, exclude_from_balance_totals, "
                "balance_totals_from, wallet_match_text) VALUES (?, ?, 'Old', 'credit', ?, ?, ?, ?)",
                [("old", "Old", None, 1, "2025-01-01", "group text"),
                 ("new", "New", "old", 0, None, "own text"),
                 ("spare", "Spare", "old", 0, None, None)])
            conn.executemany("INSERT INTO tag (id, name, color) VALUES (?, ?, ?)", [("t1", "Travel", "#336699"), ("t2", "Work", "#996633")])
            conn.executemany("INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)",
                             [("old", "t1"), ("new", "t2")])
            conn.execute("INSERT INTO account_balance (account_id, as_of_date, source, balance, recorded_at) "
                         "VALUES ('new', '2026-05-31', 'manual', -12.5, '2026-06-01 00:00:00')")

    def _state(self):
        with get_db() as conn:
            rows = {r["id"]: tuple(r)[1:] for r in conn.execute(f"SELECT id, {_SETTINGS} FROM account")}
            tags = {r["account_id"]: r["tag_id"] for r in conn.execute("SELECT * FROM account_tag")}
        return rows, tags

    def test_the_group_keeps_its_settings_and_tags_and_the_swap_undoes_itself(self):
        before = self._state()
        self.assertEqual(make_primary("new")["previous_primary_id"], "old")
        rows, tags = self._state()
        self.assertEqual(rows["new"], (None, "New", 1, "2025-01-01", "group text", None))
        self.assertEqual(rows["old"], ("new", "New", 0, None, "own text", None))
        self.assertEqual(rows["spare"][:2], ("new", "New"))
        self.assertEqual(tags, {"new": "t1", "old": "t2"})
        make_primary("old")
        self.assertEqual(self._state(), before)

    def test_refused_for_the_primary_itself_and_for_a_closed_member(self):
        with self.assertRaises(HTTPException):
            make_primary("old")
        update_account("new", AccountUpdate(closed_on="2026-06-30"))
        with self.assertRaises(HTTPException):
            make_primary("new")

    def test_a_closed_group_stays_closed_and_its_dismissed_flag_stays_dismissed(self):
        update_account("old", AccountUpdate(closed_on="2026-06-30"))
        dismiss_closed_balance_flag("old")
        make_primary("new")
        rows = {a["id"]: a for a in list_accounts(include_children=True)}
        self.assertEqual((rows["new"]["closed_on"], rows["old"]["closed_on"]), ("2026-06-30", None))
        self.assertIsNone(rows["new"]["closed_balance_flag"])


class RootChangeKeysTests(unittest.TestCase):
    """Keys that embed a group's root id follow the group when its root changes
    (`services/group_root_change.py`)."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        path = str(Path(self.tempdir.name) / "root-change.db")
        init_db(path)
        self.token = set_current_db_path(path)
        self.addCleanup(reset_current_db_path, self.token)
        with get_db() as conn:
            conn.executemany("INSERT INTO account (id, name, display_name, type, parent_account_id) "
                             "VALUES (?, ?, ?, 'credit', ?)",
                             [("old", "Old", "Old", None), ("new", "New", "Old", "old"), ("chk", "Chk", "Chk", None)])
            conn.execute("INSERT INTO recurring_series (id, payee_key, account_id, cadence, period_days, confirmed) "
                         "VALUES ('s1', 'transfer:chk:old', 'chk', 'monthly', 30, 1)")
            conn.executemany("INSERT INTO recurring_signal_dismissal (signal_key, kind, dismissed_at) "
                             "VALUES (?, ?, '2026-08-01 00:00:00')",
                             [("new_series:streamco|c1|old", "new_series"),
                              ("upcoming:transfer:chk:old|c2|chk:2026-09-01", "upcoming"),
                              ("missed:old navy|c3|chk:2026-08-01", "missed"),
                              ("balance_history:old:2026-01-31", "balance_history")])

    def _state(self):
        with get_db() as conn:
            keys = {r["signal_key"] for r in conn.execute("SELECT signal_key FROM recurring_signal_dismissal")}
            payee = conn.execute("SELECT payee_key FROM recurring_series WHERE id = 's1'").fetchone()["payee_key"]
        return keys, payee

    def test_making_a_member_the_root_moves_every_key_naming_the_old_root(self):
        make_primary("new")
        self.assertEqual(self._state(), ({"new_series:streamco|c1|new",
                                          "upcoming:transfer:chk:new|c2|chk:2026-09-01",
                                          "missed:old navy|c3|chk:2026-08-01",
                                          "balance_history:new:2026-01-31"}, "transfer:chk:new"))

    def test_removing_an_account_into_another_moves_its_series_keys_to_that_group(self):
        delete_account("chk", transactions="reassign", target_account_id="new")
        self.assertEqual(self._state(), ({"new_series:streamco|c1|old",
                                          "upcoming:transfer:old:old|c2|old:2026-09-01",
                                          "missed:old navy|c3|old:2026-08-01",
                                          "balance_history:old:2026-01-31"}, "transfer:old:old"))

    def test_merging_a_group_moves_its_series_keys_but_not_its_balance_flags(self):
        attach_account("old", AccountAttachRequest(parent_account_id="chk"))
        self.assertEqual(self._state(), ({"new_series:streamco|c1|chk",
                                          "upcoming:transfer:chk:chk|c2|chk:2026-09-01",
                                          "missed:old navy|c3|chk:2026-08-01",
                                          "balance_history:old:2026-01-31"}, "transfer:chk:chk"))


class QuietPrimaryTests(_Ledger):
    TODAY = date(2026, 8, 16)

    def setUp(self):
        super().setUp()
        self._account("old", kind="credit")
        self._account("new", kind="credit", parent="old")
        self._account("older", kind="credit", parent="old")
        self._txn("old", "2026-04-01", 10.0)    # before the 90 days
        self._txn("new", "2026-08-01", 20.0)

    def _suggested(self):
        return [(e["root_id"], e["member_id"]) for e in quiet_primaries(self.conn, today=self.TODAY)]

    def test_a_quiet_primary_with_one_active_member_is_suggested(self):
        self.assertEqual(self._suggested(), [("old", "new")])

    def test_nothing_is_suggested_when_the_primary_or_a_second_member_is_active_or_either_is_closed(self):
        self._txn("older", "2026-08-02", 5.0)
        self.assertEqual(self._suggested(), [])
        self.conn.execute("DELETE FROM txn WHERE account_id = 'older'")
        self.conn.execute("UPDATE account SET closed_on = '2026-08-10' WHERE id = 'new'")
        self.assertEqual(self._suggested(), [])
        self.conn.execute("UPDATE account SET closed_on = NULL WHERE id = 'new'")
        self.conn.execute("UPDATE account SET closed_on = '2026-08-10' WHERE id = 'old'")
        self.assertEqual(self._suggested(), [])
        self.conn.execute("UPDATE account SET closed_on = NULL WHERE id = 'old'")
        self._txn("old", "2026-08-03", 1.0)
        self.assertEqual(self._suggested(), [])


if __name__ == "__main__":
    unittest.main()
