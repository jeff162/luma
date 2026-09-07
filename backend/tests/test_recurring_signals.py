"""
Recurring anomaly/forecast signals.

These are derived on every read rather than stored, which is what makes them worth pinning: the
behaviors that would silently regress are the ones that motivated deriving them in the first place.

- A price change is measured against the occurrences *preceding* the latest charge, because the
  stored `amount_min`/`amount_max` band is rewritten from the rows the series owns and therefore
  always contains the charge that would have violated it.
- A missed charge is judged against how current the data is, not against the calendar, or a ledger
  nobody has imported into for a month reports every active series as missing.
- "Newly detected" survives the rebuild that gives every auto series a fresh id, because `created_at`
  is carried across the re-mint; without that a daily catch-up would re-announce the whole list.
- A dismissal is keyed by a fingerprint, not a row id, for the same reason.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.recurring_detection import scan_and_store
from backend.services.recurring_signals import compute_signals
from backend.services.signal_dismissals import dismiss, restore


class RecurringSignalsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "recurring-signals.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        self.cats: dict[str, str] = {}
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO account (id, provider, name, display_name, type) "
                    "VALUES (?, 'fixture', 'Checking', 'Checking', 'depository')",
                    (self.account_id,),
                )
                unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
                for label in ("Streaming", "Water", "Insurance", "Misc"):
                    cid = str(uuid.uuid4())
                    conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)", (cid, unassigned, label))
                    self.cats[label] = cid

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    # --- fixtures ---------------------------------------------------------------------------------

    def _txn(self, *, payee, category, amount, when, category_id=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (txn_id, self.account_id, SHARED_OWNER_ID,
                     category_id if category_id is not None else self.cats[category],
                     amount, payee, payee, payee, when.isoformat()),
                )
        return txn_id

    def _monthly(self, *, payee, category, amounts, end=None):
        """Charges 30 days apart, oldest first, ending at `end` (default today)."""
        end = end or date.today()
        ids = []
        for i, amount in enumerate(reversed(amounts)):
            ids.append(self._txn(payee=payee, category=category, amount=amount,
                                 when=end - timedelta(days=30 * i)))
        return list(reversed(ids))

    def _make_ledger_current(self):
        """An unrelated charge dated today, so the freshness reference is current and lateness can be
        judged at all. Its payee is deliberately a one-off so it forms no series of its own."""
        self._txn(payee="Corner Store", category="Misc", amount=4.25, when=date.today())

    def _scan(self, *, confirm=True):
        """Detect, and by default accept what was detected.

        Almost everything in this file asks what the app should say about a series the user *tracks*,
        and only a user-owned series raises `missed`, `price_change` or `upcoming` at all — an
        unaccepted candidate is a hypothesis, and the app has no business reporting that its own
        unendorsed prediction failed. Confirming here is what makes these fixtures the case they mean.
        The `new_series` tests pass `confirm=False`, because that signal is by definition about a series
        the user has *not* taken on yet.
        """
        with self._use_db_path():
            with get_db() as conn:
                result = scan_and_store(conn)
                if confirm:
                    conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE source = 'auto'")
                return result

    def _signals(self, kind=None):
        with self._use_db_path():
            with get_db() as conn:
                result = compute_signals(conn)
        if kind is None:
            return result
        return [s for s in result["signals"] if s["kind"] == kind]

    def _series_row(self, name):
        with self._use_db_path():
            with get_db() as conn:
                return dict(conn.execute(
                    "SELECT * FROM recurring_series WHERE display_name = ?", (name,)).fetchone())

    # --- price change -----------------------------------------------------------------------------

    def test_price_increase_is_reported_even_though_the_stored_band_contains_it(self):
        # Six months at 15.99 then a hike to 19.99. The scan writes amount_max = 19.99, so a check
        # against the stored band could never fire — the signal has to look at the prior occurrences.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6 + [19.99])
        self._scan()

        stored = self._series_row("Streamly")
        self.assertEqual(stored["amount_max"], 19.99, "precondition: the band absorbed the new amount")

        signals = self._signals("price_change")
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["direction"], "increase")
        self.assertEqual(signals[0]["baseline_amount"], 15.99)
        self.assertEqual(signals[0]["amount"], 19.99)
        self.assertEqual(signals[0]["amount_kind"], "fixed")

    def test_every_signal_names_the_series_it_is_about(self):
        # The identification each signal carries is what its actions are built on: "Open series" looks the
        # series up by `series_id` and silently does nothing when it is absent, which is exactly how this
        # broke — a payload edit dropped the shared `_series_payload` spread instead of adding beside it,
        # and the button went dead with no error anywhere. Asserted across kinds so the next edit to any
        # one payload cannot lose it quietly.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6 + [19.99])
        self._scan()
        signals = self._signals()["signals"]
        self.assertTrue(signals, "precondition: something to check")
        for signal in signals:
            with self.subTest(kind=signal["kind"]):
                self.assertIsNotNone(signal.get("series_id"), "the action needs a series to open")
                self.assertIsNotNone(signal.get("series_name"))

    def test_a_price_change_carries_the_gate_it_would_have_to_move(self):
        # The finding offers to widen the series' matching range, so it has to say what that range is
        # and whether it is the user's pin or the scan's derived one — a proposal against the derived
        # band while a pin is in force would describe a bound nothing is reading.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6 + [19.99])
        self._scan()
        series = self._series_row("Streamly")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE recurring_series SET confirmed = 1, amount_mode = 'fixed', "
                    "expected_min = ?, expected_max = ? WHERE id = ?",
                    (-17.0, -15.0, series["id"]),
                )
        signal = self._signals("price_change")[0]
        self.assertEqual(signal["amount_mode"], "fixed")
        self.assertTrue(signal["band_pinned"])
        self.assertEqual((signal["band_min"], signal["band_max"]), (-17.0, -15.0))

    def test_an_ungated_series_reports_its_derived_band(self):
        # `amount_mode` and `amount_kind` answer different questions: a series can be judged fixed-price
        # by its history while gating on nothing, and the action is offered only for the gate.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6 + [19.99])
        self._scan()
        signal = self._signals("price_change")[0]
        self.assertEqual(signal["amount_kind"], "fixed")     # the history is tight
        self.assertEqual(signal["amount_mode"], "variable")  # but nothing gates on it
        self.assertFalse(signal["band_pinned"])

    def test_price_step_stops_being_reported_once_it_settles(self):
        # Two consecutive charges at the new price: the change was news once and is now the norm.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 5 + [19.99, 19.99])
        self._scan()
        self.assertEqual(self._signals("price_change"), [])

    def test_variable_bill_does_not_report_its_ordinary_swing(self):
        # A utility that has ranged 40-95 all year is not "changing price" when it lands at 88.
        self._monthly(payee="City Water", category="Water", amounts=[41.10, 92.40, 55.80, 47.20, 95.10, 88.30])
        self._scan()
        self.assertEqual(self._signals("price_change"), [])

    def test_variable_bill_reports_a_charge_beyond_anything_it_has_done(self):
        # The baseline itself swings (so the series reads as variable), and the last charge is well
        # past the top of everything it has ever done.
        self._monthly(payee="City Water", category="Water", amounts=[41.10, 92.40, 55.80, 47.20, 61.00, 150.00])
        self._scan()
        signals = self._signals("price_change")
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["amount_kind"], "variable")

    def test_a_seasonal_bill_is_not_classified_as_fixed_price(self):
        # Four consecutive winter bills look tight *in isolation*, so a series judged on a trailing
        # window reads as fixed-price — and then reports the following spring as a price collapse of
        # some absurd percentage. Tightness is judged on the whole history for exactly this reason.
        self._monthly(payee="Harborline Gas", category="Water",
                      amounts=[31.00, 96.00, 402.00, 780.00, 880.00, 905.00, 860.00, 240.00])
        self._scan()
        signals = self._signals("price_change")
        self.assertEqual([s["amount_kind"] for s in signals], ["variable"])

    def _seasonal_peak_accepted(self):
        """A gas bill that peaked last winter, was reported, and had its warning dismissed — then a
        summer's worth of ordinary months, so the peak has left the recent window entirely."""
        self._monthly(payee="Harborline Gas", category="Water",
                      amounts=[30.00, 45.00, 120.00] + [40.00] * 9)
        self._scan()
        self._txn(payee="Harborline Gas", category="Water", amount=910.00,
                  when=date.today() + timedelta(days=30))
        self._scan()
        peak = self._signals("price_change")
        self.assertEqual(len(peak), 1, "precondition: an unaccepted peak is reported once")
        with self._use_db_path():
            with get_db() as conn:
                dismiss(conn, peak[0]["key"], peak[0]["kind"])
        for i in range(5):  # ordinary months, pushing the peak out of the recent window
            self._txn(payee="Harborline Gas", category="Water", amount=40.00,
                      when=date.today() + timedelta(days=60 + 30 * i))
        self._scan()
        return peak[0]["key"]

    def test_dismissing_a_seasonal_high_stops_it_returning_next_year(self):
        # The reported nag: the peak has dropped out of the recent window by the next winter, so it
        # reads as new again unless the dismissal is remembered.
        self._seasonal_peak_accepted()
        self._txn(payee="Harborline Gas", category="Water", amount=880.00,
                  when=date.today() + timedelta(days=240))
        self._scan()
        self.assertEqual(self._signals("price_change"), [])

    def test_an_accepted_amount_does_not_silence_a_genuinely_larger_charge(self):
        # Learning widens the range to what has been accepted, not past it.
        self._seasonal_peak_accepted()
        self._txn(payee="Harborline Gas", category="Water", amount=4200.00,
                  when=date.today() + timedelta(days=240))
        self._scan()
        self.assertEqual(len(self._signals("price_change")), 1)

    def test_restoring_a_dismissal_narrows_the_range_again(self):
        # Nothing is stored but the dismissal itself, so undoing it takes the acceptance with it.
        key = self._seasonal_peak_accepted()
        self._txn(payee="Harborline Gas", category="Water", amount=880.00,
                  when=date.today() + timedelta(days=240))
        self._scan()
        self.assertEqual(self._signals("price_change"), [])

        with self._use_db_path():
            with get_db() as conn:
                restore(conn, key)
        self.assertEqual(len(self._signals("price_change")), 1)

    def test_a_fixed_series_does_not_learn_from_a_dismissal(self):
        # On a fixed series a dismissal means "yes, the price went up" — already silent by the next
        # charge under the settled rule. Widening its band would mask the *next* hike, which is the one
        # thing this signal exists to catch.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6 + [19.99])
        self._scan()
        first = self._signals("price_change")
        self.assertEqual(len(first), 1)
        with self._use_db_path():
            with get_db() as conn:
                dismiss(conn, first[0]["key"], first[0]["kind"])

        self._txn(payee="Streamly", category="Streaming", amount=19.99, when=date.today() + timedelta(days=30))
        self._txn(payee="Streamly", category="Streaming", amount=24.99, when=date.today() + timedelta(days=60))
        self._scan()
        self.assertEqual(len(self._signals("price_change")), 1, "the second hike must still be reported")

    # --- missed -----------------------------------------------------------------------------------

    def test_missed_charge_is_reported_when_the_data_is_current(self):
        # The series stopped two months ago while the ledger kept receiving other rows.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6,
                      end=date.today() - timedelta(days=70))
        self._make_ledger_current()
        self._scan()

        signals = self._signals("missed")
        self.assertEqual(len(signals), 1)
        self.assertGreaterEqual(signals[0]["periods_missed"], 2)
        self.assertTrue(signals[0]["presumed_ended"])

    def test_missed_is_not_reported_when_the_ledger_itself_is_stale(self):
        # Same series, but nothing at all has been imported since. The app cannot know a charge is
        # missing when it has not been told about anything else either.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6,
                      end=date.today() - timedelta(days=70))
        self._scan()
        self.assertEqual(self._signals("missed"), [])

    def test_a_charge_a_few_days_late_is_within_tolerance(self):
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6,
                      end=date.today() - timedelta(days=32))
        self._make_ledger_current()
        self._scan()
        self.assertEqual(self._signals("missed"), [])

    # --- upcoming ---------------------------------------------------------------------------------

    def test_upcoming_lists_the_next_charge_and_is_not_an_anomaly(self):
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6,
                      end=date.today() - timedelta(days=20))
        self._scan()
        result = self._signals()
        upcoming = [s for s in result["signals"] if s["kind"] == "upcoming"]
        self.assertEqual(len(upcoming), 1)
        self.assertLessEqual(upcoming[0]["days_until"], 30)
        # It must not reach the anomaly count, which is what the Tasks badge reads.
        self.assertEqual(result["anomaly_count"], sum(
            v for k, v in result["counts"].items() if k != "upcoming"))
        self.assertNotIn("upcoming", [s["kind"] for s in result["signals"] if s["severity"] == "warning"])

    # --- new series -------------------------------------------------------------------------------

    def test_new_series_survives_the_rescan_that_re_mints_it(self):
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6)
        self._scan(confirm=False)
        first = self._signals("new_series")
        self.assertEqual(len(first), 1)
        first_id = first[0]["series_id"]

        self._scan(confirm=False)  # the auto series is deleted and re-inserted with a new id
        second = self._signals("new_series")
        self.assertEqual(len(second), 1)
        self.assertNotEqual(second[0]["series_id"], first_id, "precondition: the series was re-minted")
        self.assertEqual(second[0]["first_seen"], first[0]["first_seen"])
        self.assertEqual(second[0]["key"], first[0]["key"], "the fingerprint must not move with the id")

    def test_a_suggestion_raises_nothing_but_its_own_proposal(self):
        # An unaccepted candidate is a hypothesis, so `missed`, `price_change` and `upcoming` — each of
        # which speaks about an established obligation — have nothing to say about it. The case that
        # motivated this had the app listing a series under Suggested while warning, beside it, that the
        # charge it had just predicted was missing. The gate is per-signal rather than central, which is
        # how three of the four came to be missing it, so this asserts on the whole set: a signal added
        # later fails here until it answers the question too.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6,
                      end=date.today() - timedelta(days=70))
        self._make_ledger_current()
        self._scan(confirm=False)

        kinds = {s["kind"] for s in self._signals()["signals"]}
        self.assertEqual(kinds, {"new_series"})

        # And accepting it is what lets the app speak: the same ledger, now a tracked series.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE source = 'auto'")
        self.assertTrue(self._signals("missed"), "a confirmed series reports the same missing charge")

    def test_new_series_ages_out(self):
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6)
        self._scan(confirm=False)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET created_at = datetime('now', '-60 days')")
        self.assertEqual(self._signals("new_series"), [])

    # --- dismissal --------------------------------------------------------------------------------

    def test_dismissal_hides_one_signal_and_survives_a_rescan(self):
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6 + [19.99])
        self._scan()
        signal = self._signals("price_change")[0]

        with self._use_db_path():
            with get_db() as conn:
                dismiss(conn, signal["key"], signal["kind"])

        self.assertEqual(self._signals("price_change"), [])
        self.assertEqual(self._signals()["dismissed_count"], 1)

        self._scan()  # the series is re-minted under a new id; the dismissal must still apply
        self.assertEqual(self._signals("price_change"), [])

    def test_restoring_a_dismissal_brings_the_signal_back(self):
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6 + [19.99])
        self._scan()
        signal = self._signals("price_change")[0]
        with self._use_db_path():
            with get_db() as conn:
                dismiss(conn, signal["key"], signal["kind"])
                restore(conn, signal["key"])
        self.assertEqual(len(self._signals("price_change")), 1)

    def test_a_dismissed_missed_date_does_not_hide_the_next_one(self):
        # The fingerprint carries the expected date, so a later miss is a different finding.
        self._monthly(payee="Streamly", category="Streaming", amounts=[15.99] * 6,
                      end=date.today() - timedelta(days=70))
        self._make_ledger_current()
        self._scan()
        first = self._signals("missed")[0]
        self.assertIn(first["expected_date"], first["key"])
