"""
Two-legged money movements: pairing the rows, and detecting the rhythm off the pairs.

A transfer between two tracked accounts is one movement the ledger records twice, once per account.
Grouped by payee it read as two unrelated things whose descriptors then drifted apart independently —
which on real data split one monthly card payment into three broken series and a couple of hundred
orphans. Grouping by *pair* removes the name from the identity entirely.

What is pinned here is what would silently regress: pairing on names (which loses the pair whose two
institutions word it differently), pairing across a gap that is really two separate movements, pairing
ordinary spending, guessing at a tie, and — the one that makes the rest worth having — letting the payee
pass fragment rows a movement already claimed.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.recurring import list_series
from backend.services.excluded_categories import find_reimbursable_group_id
from backend.services.recurring_detection import scan_and_store, transfer_review
from backend.services.transfer_pairs import pair_money_movements

# Invented institution names, per the repo's fixture convention.
PAYING = "Harborline Checking"
RECEIVING = "Riverstone Card"


class TransferSeriesTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transfer-pairs.db"
        init_db(str(self.db_path))
        self.paying_account = str(uuid.uuid4())
        self.receiving_account = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            for aid, name in ((self.paying_account, PAYING), (self.receiving_account, RECEIVING)):
                conn.execute(
                    "INSERT INTO account (id, provider, name, display_name) VALUES (?, 'fixture', ?, ?)",
                    (aid, name, name),
                )
            # The flag sits on the group, which is the shape the app seeds and the one the pairing gate
            # has to read through.
            self.group_id = str(uuid.uuid4())
            self.movement_cat = str(uuid.uuid4())
            self.spending_cat = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, exclude_from_totals) VALUES (?, NULL, 'Transfers', 1)",
                (self.group_id,),
            )
            conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, 'Card Payment')",
                         (self.movement_cat, self.group_id))
            unassigned = conn.execute(
                "SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
            conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, 'Groceries')",
                         (self.spending_cat, unassigned))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _row(self, *, account, payee, amount, when, category=None):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, category_id, amount, merchant_name, display_name,
                                    raw_name, date)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), account, category or self.movement_cat, amount,
                 payee, payee, payee, when.isoformat()),
            )

    def _movement(self, *, out_payee="Card Payment", in_payee="Card Payment", amount=120.0,
                  count=8, period_days=30, in_offset_days=0, category=None, end=None):
        """`count` movements, `period_days` apart, each recorded on both accounts."""
        end = end or date.today()
        for i in range(count):
            when = end - timedelta(days=period_days * i)
            self._row(account=self.paying_account, payee=out_payee, amount=amount,
                      when=when, category=category)
            self._row(account=self.receiving_account, payee=in_payee, amount=-amount,
                      when=when + timedelta(days=in_offset_days), category=category)

    def _scan(self):
        with self._use_db_path(), get_db() as conn:
            return scan_and_store(conn)

    def _series(self):
        with self._use_db_path(), get_db() as conn:
            return conn.execute("""
                SELECT s.*, (SELECT count(*) FROM txn t WHERE t.recurring_series_id = s.id) owned
                FROM recurring_series s ORDER BY s.occurrence_count DESC""").fetchall()

    def _transfers(self):
        return [r for r in self._series() if r["counterpart_account_id"]]

    # --- what makes a pair -------------------------------------------------------------------------

    def test_a_movement_becomes_one_series_owning_both_legs(self):
        self._movement(count=8)
        self._scan()
        transfers = self._transfers()
        self.assertEqual(len(transfers), 1)
        series = transfers[0]
        self.assertEqual(series["account_id"], self.paying_account)
        self.assertEqual(series["counterpart_account_id"], self.receiving_account)
        self.assertEqual(series["cadence"], "monthly")
        # Rows, not movements — the count beside a link is what the link opens.
        self.assertEqual(series["occurrence_count"], 16)
        self.assertEqual(series["owned"], 16)
        # And it is the *only* series: nothing was left for the payee pass to fragment.
        self.assertEqual(len(self._series()), 1)

    def test_pairing_is_structural_not_lexical(self):
        """Two institutions routinely word one payment differently — a withdrawal on one side, a payment
        received on the other, sharing no words. Any rule that reaches for the name loses exactly that
        pair, which on real data was the strongest one in the ledger."""
        self._movement(out_payee="WDRL ONLINE PMT", in_payee="ELECTRONIC PAYMENT RECEIVED")
        self._scan()
        self.assertEqual(len(self._transfers()), 1)

    def test_a_descriptor_that_drifts_still_makes_one_series(self):
        """The case this whole mechanism exists for. The same monthly payment, spelled four ways over
        its life on each side, is one movement — where payee grouping would cut it into eight slices,
        each too short and too stale to detect as anything but noise."""
        today = date.today()
        spellings = [("WDRL PMT", "ELEC PAYMENT"), ("Card Co", "Payment Thank You"),
                     ("WDRL-ACH PMT", "ELECTRONIC PAYMENT"), ("Card Company", "Payment Received")]
        for i in range(12):
            when = today - timedelta(days=30 * i)
            out_payee, in_payee = spellings[i // 3]
            self._row(account=self.paying_account, payee=out_payee, amount=100.0 + i, when=when)
            self._row(account=self.receiving_account, payee=in_payee, amount=-(100.0 + i), when=when)
        self._scan()
        transfers = self._transfers()
        self.assertEqual(len(transfers), 1)
        self.assertEqual(transfers[0]["occurrence_count"], 24)
        self.assertEqual(transfers[0]["cadence"], "monthly")

    def test_the_two_sides_may_post_a_few_days_apart(self):
        """Two institutions settle on their own schedules; on real data a third of one payment's pairs
        were one to three days apart, and an exact-date rule loses every one of them."""
        self._movement(in_offset_days=2)
        self._scan()
        self.assertEqual(len(self._transfers()), 1)

    def test_beyond_the_window_they_are_not_one_movement(self):
        self._movement(in_offset_days=9)
        self._scan()
        self.assertEqual(self._transfers(), [])

    def test_ordinary_spending_never_pairs(self):
        """The category gate is what makes this safe rather than merely plausible: two rows that offset
        outside a money-movement category are a shared bill or a refund, and pairing them would invent
        a relationship that is not there."""
        self._movement(category=self.spending_cat)
        self._scan()
        self.assertEqual(self._transfers(), [])

    def test_a_repaid_receivable_is_not_a_movement(self):
        """A bill paid on one account and repaid to the cent on another, both filed under Reimbursable, is
        excluded from totals like a transfer but is not one: the money left and came back. Read as
        movement, it became a transfer series between the two accounts, and its rows were lost to the
        payee pass and the series wore the money-movement badge."""
        with self._use_db_path(), get_db() as conn:
            leaf = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, 'Shared utilities')",
                         (leaf, find_reimbursable_group_id(conn)))
        self._movement(out_payee="Lakeside Power", in_payee="Housemate repayment", amount=60.0, category=leaf)
        self._scan()
        self.assertEqual(self._transfers(), [])
        with self._use_db_path():
            series = list_series()["series"]
        self.assertTrue(series)
        self.assertFalse(any(s["money_movement"] for s in series))

    def test_rows_on_one_account_never_pair(self):
        for i in range(8):
            when = date.today() - timedelta(days=30 * i)
            self._row(account=self.paying_account, payee="Card Payment", amount=120.0, when=when)
            self._row(account=self.paying_account, payee="Card Payment", amount=-120.0, when=when)
        self._scan()
        self.assertEqual(self._transfers(), [])

    # --- refusals ----------------------------------------------------------------------------------

    def test_a_tie_is_refused_and_reported(self):
        """Nothing in the ledger distinguishes two same-day, same-amount candidates, and guessing files
        real money against the wrong movement. The rows fall through to payee matching instead."""
        third = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO account (id, provider, name, display_name) VALUES (?, 'fixture', ?, ?)",
                (third, "Second Card", "Second Card"),
            )
        self._movement(count=8)
        for i in range(8):  # an identical receiving row on a third account, same day, same amount
            self._row(account=third, payee="Card Payment", amount=-120.0,
                      when=date.today() - timedelta(days=30 * i))
        self._scan()
        self.assertEqual(self._transfers(), [])
        with self._use_db_path(), get_db() as conn:
            review = transfer_review(conn)
        self.assertEqual(len(review["ambiguous"]), 8)
        self.assertEqual(len(review["ambiguous"][0]["candidates"]), 2)

    def test_the_nearest_candidate_wins_before_a_tie_is_declared(self):
        """A closer match is a decision the data supports, so only an actual tie refuses. Resolution is
        global rather than per-row, which is what keeps the outcome independent of pool order."""
        rows = [
            {"id": "out", "date": date(2026, 3, 1), "amount": 50.0, "account_id": "a",
             "category_id": "c", "money_movement": True},
            {"id": "near", "date": date(2026, 3, 1), "amount": -50.0, "account_id": "b",
             "category_id": "c", "money_movement": True},
            {"id": "far", "date": date(2026, 3, 3), "amount": -50.0, "account_id": "b",
             "category_id": "c", "money_movement": True},
        ]
        pairs, ambiguous = pair_money_movements(rows)
        self.assertEqual(ambiguous, [])
        self.assertEqual([(p["out_id"], p["in_id"]) for p in pairs], [("out", "near")])

    # --- against existing curation -----------------------------------------------------------------

    def test_a_payee_series_still_forms_for_everything_else(self):
        """Most series are not movements, and the payee pass is untouched: a one-sided subscription is
        detected exactly as it was."""
        self._movement(count=8)
        for i in range(8):
            self._row(account=self.paying_account, payee="Streamly", amount=15.99,
                      when=date.today() - timedelta(days=30 * i), category=self.spending_cat)
        self._scan()
        payee_series = [r for r in self._series() if not r["counterpart_account_id"]]
        self.assertEqual([r["display_name"] for r in payee_series], ["Streamly"])
        self.assertEqual(len(self._transfers()), 1)

    def _confirmed_payee_series(self, *, account_id):
        """A payee series over the paying leg, confirmed, exactly as a user would have had before any of
        this existed. Inserted directly so the movement cannot claim the rows first."""
        sid = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO recurring_series (id, payee_key, display_name, category_id, account_id,
                       cadence, period_days, expected_amount, amount_min, amount_max, last_txn_date,
                       next_due_date, occurrence_count, confidence, status, source, confirmed)
                   VALUES (?, 'card payment', 'Card Payment', ?, ?, 'monthly', 30, 120.0, 120.0, 120.0,
                           ?, ?, 8, 0.9, 'active', 'auto', 1)""",
                (sid, self.movement_cat, account_id,
                 date.today().isoformat(), (date.today() + timedelta(days=30)).isoformat()),
            )
        return sid

    def _owned(self, series_id):
        with self._use_db_path(), get_db() as conn:
            return conn.execute("SELECT count(*) c FROM txn WHERE recurring_series_id = ?",
                                (series_id,)).fetchone()["c"]

    def test_the_movement_takes_its_rows_from_a_confirmed_payee_series(self):
        """A payment between two tracked accounts under one category *is* the payment, and a payee series
        over those rows is the same thing read off two descriptions that drift apart. So the pair claims
        them outright — being confirmed first does not make the wrong reading the right one."""
        self._movement(count=8)
        sid = self._confirmed_payee_series(account_id=self.paying_account)
        self._scan()
        transfers = self._transfers()
        self.assertEqual(len(transfers), 1)
        self.assertEqual(transfers[0]["owned"], 16)       # both legs of all eight payments
        # Nothing is deleted: the series that held the paying leg survives, holding nothing.
        self.assertEqual(self._owned(sid), 0)

    def test_only_the_rows_in_the_movement_are_taken(self):
        """Membership is exclusive, one row to one series, so a movement never needs the series that held
        its rows to be removed. A confirmed series covering a payment *and* charges outside it keeps the
        charges outside it — the movement wants six rows, not the series."""
        third = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO account (id, provider, name, display_name) "
                         "VALUES (?, 'fixture', 'Northgate Card', 'Northgate Card')", (third,))
        self._movement(count=8)
        # Same payee and category on a third account, unpaired and at another price — the part of the
        # series that has nothing to do with this payment.
        for i in range(5):
            self._row(account=third, payee="Card Payment", amount=77.0,
                      when=date.today() - timedelta(days=30 * i + 11))
        sid = self._confirmed_payee_series(account_id=None)   # account-agnostic: it spans both
        self._scan()
        self.assertEqual(len(self._transfers()), 1)
        self.assertEqual(self._transfers()[0]["owned"], 16)
        self.assertEqual(self._owned(sid), 5)                 # the five that were never part of it

    def test_a_movement_with_no_rhythm_is_still_not_a_payee_series(self):
        """A pair that never settles into a rhythm is still a pair. "Not a series" is a fine answer for a
        card paid whenever it carries a balance; "a merchant" is not — so both legs are withheld from the
        payee pass even though no movement claimed them.

        The fixture is the shape that exposed this on real data: irregular as a movement, but one
        descriptor's share of the paying leg is perfectly monthly and formed a one-sided suggestion —
        the per-account fragment the pairing exists to remove, minus the rhythm that would have earned it.
        """
        end = date.today()
        for offset, payee, amount in [
            (0, "AUTOPAY", 120.0), (5, "EXTRA PMT", 61.0),
            (30, "AUTOPAY", 122.0), (35, "EXTRA PMT", 62.0),
            (60, "AUTOPAY", 124.0), (65, "EXTRA PMT", 63.0),
            (90, "AUTOPAY", 126.0), (95, "EXTRA PMT", 64.0),
        ]:
            when = end - timedelta(days=offset)
            self._row(account=self.paying_account, payee=payee, amount=amount, when=when)
            self._row(account=self.receiving_account, payee="PAYMENT RECEIVED", amount=-amount, when=when)
        self._scan()
        self.assertEqual([r["display_name"] for r in self._series()], [])

    def test_a_rule_backed_series_keeps_its_rows_and_the_movement_defers(self):
        """The one claim a movement yields to. A rule's membership is an instruction the user wrote —
        these rows, by this rule — so pairing them into a movement would make the rule stop meaning what
        it says. Whole movements defer, never half of one."""
        from backend.routers.rules import create_rule, RuleCreate
        self._movement(count=8)
        with self._use_db_path():
            rule = create_rule(RuleCreate(keyword="Card Payment", is_recurring=True, cadence="monthly"),
                               on_existing="reject")
        self._scan()
        with self._use_db_path(), get_db() as conn:
            series = conn.execute("SELECT * FROM recurring_series WHERE rule_id = ?",
                                  (rule["id"],)).fetchone()
        self.assertIsNotNone(series)
        self.assertEqual(self._transfers(), [])
        # Eight, not sixteen: a payee series holds one occurrence per date, and the two legs of a payment
        # share one. That is the ordinary rule-series shape, unchanged — the point here is that the
        # movement did not take them.
        self.assertEqual(self._owned(series["id"]), 8)

    # --- what the user answers is remembered -------------------------------------------------------

    def test_a_chosen_counterpart_is_taken_as_given(self):
        """The pairing pass never learns from a decision it made itself, only from one a person made —
        so a named counterpart is applied ahead of any inference, including the tie that raised the
        question."""
        third = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO account (id, provider, name, display_name) "
                         "VALUES (?, 'fixture', 'Second Card', 'Second Card')", (third,))
        self._movement(count=8)
        for i in range(8):
            self._row(account=third, payee="Card Payment", amount=-120.0,
                      when=date.today() - timedelta(days=30 * i))
        self._scan()
        self.assertEqual(self._transfers(), [])           # a tie, refused

        with self._use_db_path(), get_db() as conn:
            review = transfer_review(conn)
            for item in review["ambiguous"]:
                wanted = next(c for c in item["candidates"] if c["account_id"] == self.receiving_account)
                conn.execute("INSERT INTO transfer_pair_decision (paying_txn_id, receiving_txn_id) "
                             "VALUES (?, ?)", (item["row"]["id"], wanted["id"]))
        self._scan()
        transfers = self._transfers()
        self.assertEqual(len(transfers), 1)
        self.assertEqual(transfers[0]["counterpart_account_id"], self.receiving_account)
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(transfer_review(conn)["ambiguous"], [])

    def test_a_dismissed_row_stops_being_asked_about(self):
        third = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO account (id, provider, name, display_name) "
                         "VALUES (?, 'fixture', 'Second Card', 'Second Card')", (third,))
        self._movement(count=8)
        for i in range(8):
            self._row(account=third, payee="Card Payment", amount=-120.0,
                      when=date.today() - timedelta(days=30 * i))
        self._scan()
        with self._use_db_path(), get_db() as conn:
            for item in transfer_review(conn)["ambiguous"]:
                conn.execute("INSERT INTO transfer_pair_decision (paying_txn_id, receiving_txn_id) "
                             "VALUES (?, NULL)", (item["row"]["id"],))
            review = transfer_review(conn)
        self.assertEqual(review["ambiguous"], [])
        # Still nothing paired — a dismissal answers the question, it does not resolve it.
        self.assertEqual(self._transfers(), [])
        self.assertEqual(len(review["resolved"]), 8)

    def test_an_answer_is_listed_only_while_pairing_still_applies_it(self):
        """The resolved list offers Undo, so it holds only answers that taking back would change: a
        trashed row's answer drops off the list but stays stored, and returns with the row."""
        third = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO account (id, provider, name, display_name) "
                         "VALUES (?, 'fixture', 'Second Card', 'Second Card')", (third,))
        self._movement(count=1)
        self._row(account=third, payee="Card Payment", amount=-120.0, when=date.today())
        with self._use_db_path(), get_db() as conn:
            item = transfer_review(conn)["ambiguous"][0]
            receiving = next(c for c in item["candidates"] if c["account_id"] == self.receiving_account)
            conn.execute("INSERT INTO transfer_pair_decision (paying_txn_id, receiving_txn_id) "
                         "VALUES (?, ?)", (item["row"]["id"], receiving["id"]))
            [listed] = transfer_review(conn)["resolved"]
            self.assertEqual((listed["kind"], listed["counterpart"]["id"]), ("paired", receiving["id"]))

            conn.execute("UPDATE txn SET trashed_at = datetime('now') WHERE id = ?", (receiving["id"],))
            self.assertEqual(transfer_review(conn)["resolved"], [])
            self.assertEqual(conn.execute("SELECT count(*) FROM transfer_pair_decision").fetchone()[0], 1)

            conn.execute("UPDATE txn SET trashed_at = NULL WHERE id = ?", (receiving["id"],))
            self.assertEqual(len(transfer_review(conn)["resolved"]), 1)

    def test_a_dismissal_names_its_candidates_and_drops_off_once_none_remain(self):
        """A dismissal stores no candidates, so they are re-derived; with none left, a restore would ask
        nothing, so the answer is not offered for one."""
        third = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO account (id, provider, name, display_name) "
                         "VALUES (?, 'fixture', 'Second Card', 'Second Card')", (third,))
        self._movement(count=1)
        self._row(account=third, payee="Card Payment", amount=-120.0, when=date.today())
        with self._use_db_path(), get_db() as conn:
            item = transfer_review(conn)["ambiguous"][0]
            conn.execute("INSERT INTO transfer_pair_decision (paying_txn_id, receiving_txn_id) "
                         "VALUES (?, NULL)", (item["row"]["id"],))
            [listed] = transfer_review(conn)["resolved"]
            self.assertEqual({c["id"] for c in listed["candidates"]},
                             {c["id"] for c in item["candidates"]})

            conn.execute("UPDATE txn SET trashed_at = datetime('now') WHERE id IN (?, ?)",
                         tuple(c["id"] for c in item["candidates"]))
            self.assertEqual(transfer_review(conn)["resolved"], [])


if __name__ == "__main__":
    unittest.main()
