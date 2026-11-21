"""
Net worth: each group's balance on a past date, which groups count, and the owner filters.

The derivation is the property worth pinning. A balance taken from the wrong anchor, or counted before
the group's history begins, raises nothing; it moves the whole household's figure.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

from backend.db.database import init_db
from backend.services.account_balances import current_balances
from backend.services.net_worth import (
    HISTORY_FLAG_KIND, account_history_flag, history_flag_key, net_worth_by_month, net_worth_on,
)
from backend.services.signal_dismissals import dismiss


class _Ledger(unittest.TestCase):
    TODAY = date(2026, 8, 16)

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        path = str(Path(self.tempdir.name) / "net-worth.db")
        init_db(path)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        self.conn.executemany("INSERT INTO owner (id, name) VALUES (?, ?)", [("robin", "Robin"), ("sam", "Sam")])

    def _account(self, account_id, kind="depository", owner="robin", parent=None, excluded=0, trashed=None):
        self.conn.execute(
            "INSERT INTO account (id, name, display_name, type, owner_id, parent_account_id, "
            "exclude_from_net_worth, trashed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (account_id, account_id, account_id, kind, owner, parent, excluded, trashed))

    def _state(self, account_id, as_of, balance, source="manual", recorded_at="2026-08-01 00:00:00"):
        self.conn.execute(
            "INSERT INTO account_balance (account_id, as_of_date, source, balance, recorded_at) "
            "VALUES (?, ?, ?, ?, ?)", (account_id, as_of, source, balance, recorded_at))

    def _txn(self, account_id, day, amount, posted=None):
        self.conn.execute(
            "INSERT INTO txn (id, account_id, amount, merchant_name, display_name, raw_name, date, posted_date) "
            "VALUES (?, ?, ?, 'M', 'M', 'M', ?, ?)",
            (f"{account_id}-{day}-{amount}", account_id, amount, day, posted))

    def _on(self, date_start=None, date_end=None, owners=None):
        return net_worth_on(self.conn, date_start, date_end, owners, today=self.TODAY)

    def _balance(self, result, account_id):
        row = next(a for a in result["accounts"] if a["account_id"] == account_id)
        return row["balance"]["amount"] if row["balance"] else None


class NetWorthTests(_Ledger):
    def _opening(self, result, account_id):
        return next(a for a in result["accounts"] if a["account_id"] == account_id)["opening"]


    def test_a_past_date_counts_from_the_nearest_stated_balance_before_it(self):
        self._account("chk")
        self._state("chk", "2026-05-31", 1000.0)
        self._txn("chk", "2026-06-10", 200.0)   # money out
        # Stated a month later at a figure the rows do not explain, as a correction would be.
        self._state("chk", "2026-06-30", 500.0)
        self._txn("chk", "2026-07-05", -50.0)   # money in
        self.assertEqual(self._balance(self._on(date_end="2026-06-20"), "chk"), 800.0)
        self.assertEqual(self._balance(self._on(date_end="2026-07-31"), "chk"), 550.0)

    def test_a_date_before_the_first_stated_balance_is_worked_back_from_it(self):
        self._account("chk")
        self._txn("chk", "2026-03-01", -100.0)
        self._txn("chk", "2026-04-15", 30.0)
        self._state("chk", "2026-05-31", 1000.0)
        self.assertEqual(self._balance(self._on(date_end="2026-04-01"), "chk"), 1030.0)

    def test_a_group_is_left_out_before_its_coverage_begins(self):
        self._account("chk")
        self._txn("chk", "2026-03-01", -100.0)
        self._state("chk", "2026-05-31", 1000.0)
        result = self._on(date_start="2026-01-01", date_end="2026-02-28")
        self.assertIsNone(self._balance(result, "chk"))
        self.assertEqual(result["totals"]["net"], 0)

    def test_today_agrees_with_the_accounts_page(self):
        self._account("card", "credit")
        self._account("old-card", "credit", parent="card")
        self._state("card", "2026-08-10", -100.0, source="provider")
        self._txn("card", "2026-08-12", 25.0)
        self._txn("old-card", "2026-08-13", -40.0)
        current = current_balances(self.conn, today=self.TODAY)["card"]
        result = self._on()
        self.assertEqual(result["date"], self.TODAY.isoformat())
        self.assertEqual(self._balance(result, "card"), current["amount"])
        self.assertEqual([a["account_id"] for a in result["accounts"]], ["card"])

    def test_excluded_other_and_trashed_groups_do_not_count(self):
        self._account("chk")
        self._account("house", "other")
        self._account("joint", excluded=1)
        self._account("closed", trashed="2026-08-01")
        self._account("cash")
        for account_id in ("chk", "house", "joint", "closed"):
            self._state(account_id, "2026-08-01", 100.0)
        result = self._on()
        self.assertEqual({a["account_id"]: a["has_balance"] for a in result["accounts"]}, {"chk": True, "cash": False})
        self.assertEqual(result["totals"]["net"], 100.0)

    def test_assets_and_liabilities_split_by_sign_and_a_group_opened_in_the_period_starts_it_at_zero(self):
        self._account("chk")
        self._account("card", "credit")
        self._account("new-savings", "savings")
        self._state("chk", "2026-06-30", 1000.0)
        self._state("chk", "2026-07-31", 1200.0)
        self._state("card", "2026-06-30", -300.0)
        self._state("card", "2026-07-31", -250.0)
        # Opened inside the period: its whole balance is a change in it.
        self._state("new-savings", "2026-07-20", 5000.0)
        result = self._on(date_start="2026-07-01", date_end="2026-07-31")
        self.assertEqual(result["opening_date"], "2026-06-30")
        self.assertEqual(result["totals"], {"assets": 6200.0, "liabilities": -250.0, "net": 5950.0})
        self.assertEqual(self._opening(result, "new-savings"), 0.0)
        self.assertEqual(result["change"], 5250.0)

    def test_owner_filters_and_the_lens_read_the_group_owner(self):
        self._account("robin-chk", owner="robin")
        self._account("sam-chk", owner="sam")
        self._account("nobody-chk", owner=None)
        for account_id in ("robin-chk", "sam-chk", "nobody-chk"):
            self._state(account_id, "2026-08-01", 100.0)

        def counted(owners):
            return sorted(a["account_id"] for a in self._on(owners=owners)["accounts"])

        self.assertEqual(counted({"owner_ids": "sam,unassigned"}), ["nobody-chk", "sam-chk"])
        self.assertEqual(counted({"exclude_owner_ids": "sam"}), ["nobody-chk", "robin-chk"])
        # The lens ANDs with the chips: a chip outside it narrows to nothing rather than widening it.
        self.assertEqual(counted({"owner_lens": "robin"}), ["robin-chk"])
        self.assertEqual(counted({"owner_ids": "sam", "owner_lens": "robin"}), [])

    def test_monthly_points_run_from_the_first_coverage_through_today(self):
        self._account("chk")
        self._account("card", "credit")
        self._account("cash")
        self._state("chk", "2026-05-15", 1000.0)
        self._state("card", "2026-07-10", -200.0)
        self._txn("card", "2026-06-20", 30.0)
        self._txn("card", "2026-07-05", 50.0)
        result = net_worth_by_month(self.conn, today=self.TODAY)
        self.assertEqual({a["account_id"]: a["has_balance"] for a in result["accounts"]},
                         {"chk": True, "card": True, "cash": False})
        self.assertEqual(result["points"][0]["balances"], {"chk": 1000.0})
        self.assertEqual(
            [(p["date"], p["net"], p["uncovered"]) for p in result["points"]],
            [("2026-05-31", 1000.0, 1), ("2026-06-30", 850.0, 0), ("2026-07-31", 800.0, 0), ("2026-08-16", 800.0, 0)],
        )


    def test_colours_follow_the_account_whichever_owners_are_shown(self):
        self._account("a-card", "credit", owner="robin")
        self._account("b-card", "credit", owner="sam")
        indexes = {a["account_id"]: a["type_index"] for a in self._on(owners={"owner_ids": "sam"})["accounts"]}
        self.assertEqual(indexes, {"b-card": 1})


class HistoryFlagTests(_Ledger):
    """A balance worked back from the first stated one, landing clearly on the wrong side of zero."""

    def _flag(self, account_id, kind=None):
        return account_history_flag(self.conn, account_id)

    def test_a_held_account_worked_back_into_debt_is_flagged_at_its_worst(self):
        self._account("chk")
        self._txn("chk", "2026-03-01", 900.0)
        self._txn("chk", "2026-04-01", -400.0)  # a deposit, so before it the account held 400 less
        self._state("chk", "2026-06-30", 0.0)
        self.assertEqual(self._flag("chk", "depository"),
                         {"before": "2026-06-30", "date": "2026-03-01", "amount": -400.0,
                          "suggested_from": "2026-04-01", "seam": None, "balance_date": "2026-03-31"})
        # Shown wherever the account's figures are.
        self.assertEqual(self._on()["accounts"][0]["history_flag"]["before"], "2026-06-30")

    def test_a_small_overdraft_and_history_after_the_first_balance_are_not_flagged(self):
        self._account("chk")
        self._txn("chk", "2026-03-01", 50.0)
        self._state("chk", "2026-03-15", 0.0)
        self._txn("chk", "2026-04-01", 5000.0)  # after the first stated balance: checked, not worked back
        self.assertIsNone(self._flag("chk", "depository"))

    def test_a_wallet_far_from_zero_either_way_is_flagged(self):
        self._account("pp", "paypal")
        self._txn("pp", "2026-03-01", -500.0)   # received, with nothing recorded leaving
        self._state("pp", "2026-06-30", 0.0)
        self.assertEqual(self._flag("pp", "paypal")["amount"], -500.0)

    def test_a_dismissal_lasts_until_an_earlier_balance_is_stated(self):
        self._account("chk")
        self._txn("chk", "2026-03-01", 900.0)
        self._state("chk", "2026-06-30", 0.0)
        dismiss(self.conn, history_flag_key("chk", "2026-06-30"), HISTORY_FLAG_KIND)
        self.assertIsNone(self._flag("chk", "depository"))
        self.assertIsNone(self._on()["accounts"][0]["history_flag"])
        # A balance entered further back changes the history being judged.
        self._txn("chk", "2026-01-10", -900.0)  # a deposit, with nothing recorded before it
        self._state("chk", "2026-01-31", 0.0)
        self.assertEqual(self._flag("chk", "depository")["before"], "2026-01-31")


    def test_a_start_date_past_the_trouble_settles_it_and_counts_the_account_from_then(self):
        self._account("chk")
        self._txn("chk", "2026-03-01", 900.0)
        self._txn("chk", "2026-04-01", -400.0)
        self._state("chk", "2026-06-30", 0.0)
        self.conn.execute("UPDATE account SET net_worth_from = '2026-04-01' WHERE id = 'chk'")
        self.assertIsNone(self._flag("chk"))
        self.assertIsNone(self._balance(self._on(date_end="2026-03-31"), "chk"))
        self.assertEqual(self._balance(self._on(date_end="2026-04-01"), "chk"), 0.0)

    def test_the_switch_from_a_file_to_a_connection_is_offered_as_the_seam(self):
        self._account("chk")
        self.conn.execute("INSERT INTO import_batch (id, filename, source_kind) VALUES ('sync', 'sync', 'connection_sync')")
        self._txn("chk", "2026-03-01", -900.0)  # from a file, with its deposit's source never imported
        self.conn.execute("INSERT INTO txn (id, account_id, amount, merchant_name, display_name, raw_name, date, "
                          "import_batch_id) VALUES ('synced', 'chk', 20.0, 'M', 'M', 'M', '2026-05-10', 'sync')")
        self._state("chk", "2026-06-30", 0.0, source="provider")
        self.assertEqual(self._flag("chk")["seam"], "2026-05-09")
        self.assertEqual(self._flag("chk")["balance_date"], "2026-05-09")


if __name__ == "__main__":
    unittest.main()
