"""
Balance totals: each group's balance on a past date, which groups count, and the owner filters.

The derivation is the property worth pinning. A balance taken from the wrong anchor, or counted before
the group's history begins, raises nothing; it moves the whole household's figure.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from backend.db.database import init_db
from backend.services.account_balances import current_balances
from backend.services import balance_totals
from backend.services.balance_totals import (
    HISTORY_FLAG_KIND, account_history_flag, balance_totals_by_day, balance_totals_by_month, balance_totals_on,
    history_flag_key,
)
from backend.services.signal_dismissals import dismiss


class _Ledger(unittest.TestCase):
    TODAY = date(2026, 8, 16)

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        path = str(Path(self.tempdir.name) / "balance-totals.db")
        init_db(path)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        self.conn.executemany("INSERT INTO owner (id, name) VALUES (?, ?)", [("robin", "Robin"), ("sam", "Sam")])

    def _account(self, account_id, kind="depository", owner="robin", parent=None, excluded=0, trashed=None):
        self.conn.execute(
            "INSERT INTO account (id, name, display_name, type, owner_id, parent_account_id, "
            "exclude_from_balance_totals, trashed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
        return balance_totals_on(self.conn, date_start, date_end, owners, today=self.TODAY)

    def _balance(self, result, account_id):
        row = next(a for a in result["accounts"] if a["account_id"] == account_id)
        return row["balance"]["amount"] if row["balance"] else None


class BalanceTotalsTests(_Ledger):
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
        result = balance_totals_by_month(self.conn, today=self.TODAY)
        self.assertEqual({a["account_id"]: a["has_balance"] for a in result["accounts"]},
                         {"chk": True, "card": True, "cash": False})
        self.assertEqual(result["points"][0]["balances"], {"chk": 1000.0})
        self.assertEqual(
            [(p["date"], p["net"], p["uncovered"]) for p in result["points"]],
            [("2026-05-31", 1000.0, 1), ("2026-06-30", 850.0, 0), ("2026-07-31", 800.0, 0), ("2026-08-16", 800.0, 0)],
        )


    def test_existing_ids_name_every_root_whatever_the_totals_count_or_the_filters_show(self):
        # The table's arrangement drops a saved place for an id missing here, so an account the totals or
        # the filters leave out must still be named, and a merged member must not be.
        self._account("chk", owner="robin")
        self._account("sams", owner="sam")
        self._account("kept-out", excluded=1)
        self._account("misc", "other")
        self._account("member", parent="chk")
        result = balance_totals_by_month(self.conn, {"owner_ids": "robin"}, today=self.TODAY)
        self.assertEqual([a["account_id"] for a in result["accounts"]], ["chk"])
        self.assertEqual(result["existing_account_ids"], ["chk", "kept-out", "misc", "sams"])

    def test_the_curve_runs_from_the_bridges_opening_total_to_its_closing_one(self):
        # The curve is drawn under the bridge, so its two ends must be the bridge's two totals.
        self._account("chk")
        self._account("new-savings", "savings")
        self._state("chk", "2026-06-30", 1000.0)
        self._txn("chk", "2026-07-10", 200.0)
        self._state("new-savings", "2026-07-20", 5000.0)
        points = balance_totals_by_day(self.conn, "2026-07-01", "2026-07-31", today=self.TODAY)["points"]
        bridge = self._on(date_start="2026-07-01", date_end="2026-07-31")
        self.assertEqual((points[0]["date"], points[0]["net"]), ("2026-06-30", bridge["totals"]["net"] - bridge["change"]))
        self.assertEqual((points[-1]["date"], points[-1]["net"]), ("2026-07-31", bridge["totals"]["net"]))
        self.assertEqual(points[-1]["balances"], {"chk": 800.0, "new-savings": 5000.0})
        self.assertEqual(len(points), 32)
        by_date = {p["date"]: p["net"] for p in points}
        # Before its coverage begins a group counts as zero, as the bridge opens it.
        self.assertEqual((by_date["2026-07-10"], by_date["2026-07-19"], by_date["2026-07-20"]), (800.0, 800.0, 5800.0))

    def test_a_period_past_a_year_is_drawn_a_week_apart_from_its_end(self):
        self._account("chk")
        self._state("chk", "2024-01-01", 1000.0)
        points = balance_totals_by_day(self.conn, "2024-06-01", None, today=self.TODAY)["points"]
        dates = [p["date"] for p in points]
        self.assertEqual((dates[0], dates[-1], dates[-2]), ("2024-05-31", "2026-08-16", "2026-08-09"))
        self.assertTrue(all(p["net"] == 1000.0 for p in points))


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

    def test_excluding_a_group_from_the_totals_hides_its_flag_until_it_counts_again(self):
        self._account("chk", excluded=1)
        self._txn("chk", "2026-03-01", -900.0)  # a deposit, with nothing recorded before it
        self._state("chk", "2026-06-30", 0.0)
        self.assertIsNone(self._flag("chk"))
        self.conn.execute("UPDATE account SET exclude_from_balance_totals = 0 WHERE id = 'chk'")
        self.assertEqual(self._flag("chk")["before"], "2026-06-30")

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
        self.conn.execute("UPDATE account SET balance_totals_from = '2026-04-01' WHERE id = 'chk'")
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


class HistoryFlagCacheTests(_Ledger):
    """The flags are judged once and served until a write they depend on, which a trigger records."""

    def setUp(self):
        super().setUp()
        self._account("chk")
        self._txn("chk", "2026-03-01", -900.0)  # a deposit, with nothing recorded before it
        self._state("chk", "2026-06-30", 0.0)
        self.conn.commit()
        self.assertEqual(account_history_flag(self.conn, "chk")["amount"], -900.0)

    def _judged_again(self):
        """Whether the next read works the flags out again rather than serving the cache."""
        with mock.patch.object(balance_totals, "load_group_balances", wraps=balance_totals.load_group_balances) as load:
            account_history_flag(self.conn, "chk")
        return load.called

    def test_a_flag_is_served_from_the_cache_until_its_history_changes(self):
        self.assertFalse(self._judged_again())
        self.conn.execute("UPDATE txn SET amount = -1200.0 WHERE account_id = 'chk'")
        self.conn.commit()
        self.assertEqual(account_history_flag(self.conn, "chk")["amount"], -1200.0)

    def test_categorizing_a_row_leaves_the_cache_alone(self):
        self.conn.execute("INSERT INTO category (id, name) VALUES ('food', 'Food')")
        self.conn.execute("UPDATE txn SET category_id = 'food' WHERE account_id = 'chk'")
        self.conn.commit()
        self.assertFalse(self._judged_again())

    def test_dismissing_the_flag_takes_it_off_at_once_and_other_dismissals_do_not_recompute(self):
        dismiss(self.conn, "range_drift:some-rule:some-row", "range_drift")
        self.conn.commit()
        self.assertFalse(self._judged_again())
        dismiss(self.conn, history_flag_key("chk", "2026-06-30"), HISTORY_FLAG_KIND)
        self.conn.commit()
        self.assertIsNone(account_history_flag(self.conn, "chk"))


class AnyBalanceStatedTests(_Ledger):
    """Whether the totals have anything to show, which decides whether the Balances frame may hide itself."""

    def test_only_a_balance_the_totals_count_answers_yes(self):
        self._account("house", "other")
        self._account("joint", excluded=1)
        self._account("gone", trashed="2026-08-01 00:00:00")
        for account_id in ("house", "joint", "gone"):
            self._state(account_id, "2026-07-31", 100.0)
        self.assertFalse(balance_totals.any_balance_stated(self.conn))
        self._account("chk", owner="sam")
        self._account("old-chk", parent="chk")
        self._state("old-chk", "2026-07-31", 100.0)
        self.assertTrue(balance_totals.any_balance_stated(self.conn))

    def test_the_owner_filters_do_not_change_the_answer(self):
        self._account("chk", owner="sam")
        self._state("chk", "2026-07-31", 100.0)
        result = balance_totals_by_month(self.conn, {"owner_ids": "robin"}, today=self.TODAY)
        self.assertEqual(result["accounts"], [])
        self.assertTrue(result["any_balance"])


class GroupBalancesCacheTests(_Ledger):
    """The totals' per-day ledger is read once and served until a write it depends on moves the epoch."""

    def setUp(self):
        super().setUp()
        self._account("chk")
        self._state("chk", "2026-06-30", 1000.0)
        self._txn("chk", "2026-07-10", 200.0)
        self.conn.commit()
        self.assertEqual(self._balance(self._on(), "chk"), 800.0)

    def _read_again(self):
        """Whether the next totals read goes back to the ledger rather than serving the cache."""
        with mock.patch.object(balance_totals, "_read_group_balances", wraps=balance_totals._read_group_balances) as read:
            self._on()
        return read.called

    def test_the_ledger_is_served_from_the_cache_until_a_row_it_counts_changes(self):
        self.assertFalse(self._read_again())
        self.conn.execute("UPDATE txn SET amount = 300.0 WHERE account_id = 'chk'")
        self.conn.commit()
        self.assertEqual(self._balance(self._on(), "chk"), 700.0)

    def test_figures_read_inside_a_transaction_that_rolls_back_are_not_kept(self):
        # Read inside the transaction, the uncommitted row counts and the epoch has moved by one. Rolled back,
        # a different committed write then moves the epoch to that same value.
        self._txn("chk", "2026-07-11", 50.0)
        self.assertEqual(self._balance(self._on(), "chk"), 750.0)
        self.conn.rollback()
        self._txn("chk", "2026-07-12", 10.0)
        self.conn.commit()
        self.assertEqual(self._balance(self._on(), "chk"), 790.0)

