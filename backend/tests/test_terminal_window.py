"""
The terminal *window* — generalizing "the export day is incomplete" to "the last N days are".

The original rule assumed a source's only untrustworthy day was the day it was exported. That turned
out to be the special case: most sources lag the thing they describe. An aggregator (Monarch,
Fidelity, a data connection) is waiting on the bank, so an export dated the 27th can be missing a
transaction from the 25th it had not yet ingested; blanket-rejecting those days as "already covered"
loses real transactions with nothing but a duplicate-report entry to find them by. Only a first-party
export of records the source itself created (Amazon, PayPal) genuinely has no lag.

So the default is the lagging case and 1 is the opt-in, which is the reverse of how this landed. Two
things need pinning as a result: that a window of **1** still reproduces the original computation
exactly (the escape hatch has to actually work), and that the **default** is the wide one.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.db import control_database as cdb
from backend.db import database

from backend.services.duplicate_detection import (
    CROSS_ACCOUNT_DATE_WINDOW_DAYS,
    DEFAULT_TERMINAL_WINDOW_DAYS,
    build_dedupe_context,
    compute_import_coverage_window,
    terminal_window_dates,
    terminal_window_start,
)

DATES = ["2026-07-20", "2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27"]
TERMINAL = "2026-07-27"


class AWindowOfOneIsTheOriginalBehaviorTests(unittest.TestCase):
    """The escape hatch for a source that publishes its own records and cannot be behind."""

    def test_coverage_stops_the_day_before_the_terminal_date(self):
        # The original contract: covered dates are strictly < terminal_date.
        self.assertEqual(
            compute_import_coverage_window(DATES, TERMINAL, 1),
            ("2026-07-20", "2026-07-26"),
        )

    def test_window_start_is_the_terminal_date_itself(self):
        self.assertEqual(terminal_window_start(TERMINAL, 1), TERMINAL)

    def test_window_is_just_the_terminal_day(self):
        self.assertEqual(terminal_window_dates(TERMINAL, 1), [TERMINAL])

    def test_no_terminal_date_covers_everything(self):
        self.assertEqual(compute_import_coverage_window(DATES, None, 1), ("2026-07-20", "2026-07-27"))
        self.assertIsNone(terminal_window_start(None, 1))
        self.assertEqual(terminal_window_dates(None, 1), [])


class TheDefaultAssumesALagTests(unittest.TestCase):
    """The direction of error that decides the default: too small a window silently deletes a real
    transaction, too large one costs an extra reconciliation pass that still catches true duplicates
    by name. So absent a stated value, assume the source is behind."""

    def test_the_default_is_the_lagging_case_not_the_export_day(self):
        self.assertGreater(DEFAULT_TERMINAL_WINDOW_DAYS, 1)

    def test_it_matches_the_measured_cross_source_skew(self):
        # Same evidence as the soft-flag sweep's date window: observed posting skew between two
        # sources describing one charge reached +6 days. Sharing the bound keeps a row from being
        # blanket-rejected by coverage at a distance the sweep would still call a match.
        self.assertEqual(DEFAULT_TERMINAL_WINDOW_DAYS, CROSS_ACCOUNT_DATE_WINDOW_DAYS)

    def test_a_source_that_never_stated_a_window_gets_the_default(self):
        self.assertEqual(terminal_window_dates(TERMINAL), terminal_window_dates(TERMINAL, DEFAULT_TERMINAL_WINDOW_DAYS))
        self.assertEqual(compute_import_coverage_window(DATES, TERMINAL),
                         compute_import_coverage_window(DATES, TERMINAL, DEFAULT_TERMINAL_WINDOW_DAYS))

    def test_an_export_shorter_than_the_lag_therefore_covers_nothing(self):
        # The consequence worth stating outright: a file that does not outrun its own lag no longer
        # blanket-rejects anything. It has not proven a range, so its rows reconcile one-to-one
        # instead — which is the behavior a short export should have had all along.
        self.assertEqual(compute_import_coverage_window(DATES[1:], TERMINAL), (None, None))

    def test_coverage_resumes_as_soon_as_the_file_outruns_its_lag(self):
        # Not "short files are special-cased" — the same rule, applied to a range long enough to have
        # a trusted part. Only the 20th is clear of the 21st-27th trailing window.
        self.assertEqual(compute_import_coverage_window(DATES, TERMINAL), ("2026-07-20", "2026-07-20"))


class WidenedWindowTests(unittest.TestCase):
    def test_coverage_stops_short_by_the_whole_window(self):
        # At 3, the 25th/26th/27th are all soft, so trusted coverage ends on the 24th — which is what
        # lets a later import bring in the 25th-26th rows this source had not yet ingested.
        self.assertEqual(
            compute_import_coverage_window(DATES, TERMINAL, 3),
            ("2026-07-20", "2026-07-24"),
        )

    def test_every_day_in_the_window_gets_a_candidate_slot(self):
        self.assertEqual(
            terminal_window_dates(TERMINAL, 3),
            ["2026-07-25", "2026-07-26", "2026-07-27"],
        )

    def test_window_start_moves_back_by_window_minus_one(self):
        self.assertEqual(terminal_window_start(TERMINAL, 3), "2026-07-25")

    def test_a_range_entirely_inside_its_own_lag_covers_nothing(self):
        # Correct, not a bug: a source whose whole range sits inside its lag has proven nothing, so it
        # must not blanket-reject anything. Rows still reconcile one-to-one via the window.
        self.assertEqual(compute_import_coverage_window(["2026-07-26", "2026-07-27"], TERMINAL, 5), (None, None))

    def test_a_stated_window_below_one_is_clamped_not_widened(self):
        # 0 and negatives are stated-but-incoherent (a window under 1 would push coverage PAST the
        # source's own last date), so they clamp to the narrowest legal window. They must not be read
        # as "unset" and handed the default — that would silently give the widest window of all to
        # exactly the caller asking for the narrowest.
        for stated in (0, -3):
            self.assertEqual(terminal_window_dates(TERMINAL, stated), [TERMINAL],
                             f"a stated window of {stated!r} must clamp to the single terminal day")

    def test_an_absent_window_takes_the_default(self):
        self.assertEqual(terminal_window_dates(TERMINAL, None),
                         terminal_window_dates(TERMINAL, DEFAULT_TERMINAL_WINDOW_DAYS))

    def test_junk_tolerates_rather_than_raises(self):
        # Unreadable is "this source never said", same as absent.
        self.assertEqual(terminal_window_dates(TERMINAL, "seven"),
                         terminal_window_dates(TERMINAL, DEFAULT_TERMINAL_WINDOW_DAYS))
        # An unparseable terminal date can't be widened, so it degrades to itself rather than raising.
        self.assertEqual(terminal_window_dates("not-a-date", 3), ["not-a-date"])
        self.assertEqual(terminal_window_start("not-a-date", 3), "not-a-date")


class BuilderThreadsTheWindowThroughTests(unittest.TestCase):
    """The primitives above are only useful if `build_dedupe_context` actually reads a source's
    declared window. This drives the real builder against a real database."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = str(Path(self.tmp.name) / "data.db")
        self._orig = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
        database.DB_PATH = path
        cdb.DB_PATH = path
        cdb.CONTROL_DB_PATH = str(Path(self.tmp.name) / "control.db")
        database.init_db(path)

    def tearDown(self):
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = self._orig
        self.tmp.cleanup()

    def _seed(self, window_days):
        with database.get_db() as conn:
            owner = conn.execute("SELECT id FROM owner LIMIT 1").fetchone()["id"]
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id) VALUES ('a1','Checking','Checking','depository',?)",
                (owner,),
            )
            conn.execute(
                "INSERT INTO csv_import_profile (id, name, column_map, terminal_window_days) VALUES ('p1','Monarch','{}',?)",
                (window_days,),
            )
            conn.execute(
                "INSERT INTO import_batch (id, profile_id, filename, status) VALUES ('b1','p1','monarch.csv','completed')"
            )
            conn.execute(
                "INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count, was_skipped,"
                " coverage_start_date, coverage_end_date, terminal_date)"
                " VALUES ('b1','Checking','a1',5,0,'2026-07-20','2026-07-24','2026-07-27')"
            )
            # One prior row on each soft day, so a widened window has something to reconcile against.
            for i, day in enumerate(("2026-07-25", "2026-07-26", "2026-07-27")):
                conn.execute(
                    "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,"
                    " date, is_pending, content_hash, import_batch_id, import_evidence_json)"
                    " VALUES (?,?,?,?,?,?,?,?,0,?, 'b1', ?)",
                    (f"t{i}", "a1", owner, -10.0, "Store", "Store", "STORE",
                     day, f"hash-{i}",
                     json.dumps({"account": {"header": "Account", "value": "Checking"}})),
                )

    def _terminal_days(self):
        with database.get_db() as conn:
            ctx = build_dedupe_context(
                conn,
                source_values=["Checking"],
                account_by_source_value={"Checking": "a1"},
            )
        return {day for (_csv_value, day) in ctx.terminal_day_candidates_by_csv_day}

    def test_default_window_indexes_only_the_terminal_day(self):
        self._seed(1)
        self.assertEqual(self._terminal_days(), {"2026-07-27"})

    def test_widened_window_indexes_every_soft_day(self):
        # The behavior change: rows on the 25th and 26th become reconcilable candidates instead of
        # falling outside the rule entirely.
        self._seed(3)
        self.assertEqual(self._terminal_days(), {"2026-07-25", "2026-07-26", "2026-07-27"})


if __name__ == "__main__":
    unittest.main()
