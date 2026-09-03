"""
The measurement behind `CROSS_ACCOUNT_DATE_WINDOW_DAYS = 7`, kept as a fixture.

The window was widened from 3 to 7 on evidence, not intuition: pairing one real ledger's connection
rows against their CSV counterparts by amount and inspecting each pair by hand put genuine matches at
+1, +3, +3, +4 and +6 days. That measurement lived only in a comment, which meant the constant was
justified by prose and asserted by nothing — a later narrowing would have passed every test.

Two things are pinned here, and they are the two the measurement actually established:

  the tail       the +4 and +6 pairs are found at 7 and MISSED at 3, so the widening is justified by
                 a failing assertion rather than by the constant's own value
  the control    two distinct $44 Zelle receipts — same amount, adjacent dates, different recipients —
                 match at NO window at all. This is what makes widening cheap: the text is the
                 discriminator and the date is the weak signal, so relaxing the weak one costs
                 nothing. A window test without this half only proves the window catches more.

The rows are inserted directly rather than imported, so each pair is exactly the (amount, date gap,
source texts) triple that was measured, with nothing else in the ledger to confound it. Amounts are
stored positive because these are all charges (positive = money out).
"""

from __future__ import annotations

import os.path
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services import duplicate_detection
from backend.services.duplicate_detection import mark_import_suspects

# The date the CSV side of every pair carries. The connection side sits `gap` days later, which is the
# direction the skew ran: the aggregator publishes the transaction date, the bank the posted one.
CSV_DATE = date(2026, 7, 15)

# Each measured pair: (label, gap in days, the CSV's text, the connection's text, amount, tier).
# Amounts are distinct per pair so a row can only ever match its own twin.
MEASURED_PAIRS = [
    ("Netflix",       1, "NETFLIX.COM",          "NETFLIX.COM",         15.49, "cross_account"),
    ("CVS",           3, "CVS Caremark",         "CVS Caremark",        20.00, "cross_account"),
    ("CVS again",     3, "CVS Caremark",         "CVS Caremark",        32.15, "cross_account"),
    ("Whole Foods",   4, "WHOLE FOODS",          "WHOLE FOODS",          7.49, "cross_account"),
    # The provider truncated the descriptor mid-word. Hand-verified as the same charge when these pairs
    # were measured, and the matcher now reads it that way too: a text that is another with its tail
    # clipped is not a disagreement, so it lands in the exact tier rather than in review.
    ("Rancatore",     6, "Rancatores Ice Cream", "RANCATORES ICE CREA", 11.25, "cross_account"),
]

# The false positives at those same distances: two $44 Zelle payments to different people, one day
# apart. Same amount, well inside any window under discussion, and they are NOT the same transaction.
ZELLE_AMOUNT = 44.00
ZELLE_CSV_TEXT = "Zelle payment to Marcy 22781140388"
ZELLE_CONNECTION_TEXT = "Zelle payment to Devon 22913744021"


class CrossAccountWindowEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "window-evidence.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            for account_id, name in (("acct-csv", "Northgate Voyager"), ("acct-conn", "CREDIT CARD")):
                conn.execute(
                    "INSERT INTO account (id, name, display_name, type, owner_id) VALUES (?,?,?,'credit',?)",
                    (account_id, name, name, SHARED_OWNER_ID),
                )
            conn.execute("INSERT INTO import_batch (id, filename, status) VALUES ('b-csv','Monarch.csv','completed')")
            conn.execute("INSERT INTO import_batch (id, filename, status) VALUES ('b-conn','Northgate · July 2026','completed')")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    def _row(self, conn, *, account_id, batch_id, on_date, amount, text) -> str:
        txn_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,"
            " date, is_pending, content_hash, import_batch_id) VALUES (?,?,?,?,?,?,?,?,0,?,?)",
            (txn_id, account_id, SHARED_OWNER_ID, amount, text, text, text,
             on_date.isoformat(), f"hash-{txn_id}", batch_id),
        )
        return txn_id

    def _pair(self, *, gap, csv_text, connection_text, amount) -> str:
        """One measured pair: the CSV row already in the ledger, and the connection row that arrives
        `gap` days later. Returns the incoming row's id — the side the sweep flags."""
        with self._db() as conn:
            self._row(conn, account_id="acct-csv", batch_id="b-csv",
                      on_date=CSV_DATE, amount=amount, text=csv_text)
            return self._row(conn, account_id="acct-conn", batch_id="b-conn",
                             on_date=CSV_DATE + timedelta(days=gap), amount=amount, text=connection_text)

    def _sweep(self) -> dict:
        """Run the cross-account sweep over the connection's card. Returns incoming id → reason for
        every row it flagged."""
        with self._db() as conn:
            mark_import_suspects(conn, "b-conn")
            return {
                r["id"]: r["suspect_duplicate_reason"] for r in conn.execute(
                    "SELECT id, suspect_duplicate_reason FROM txn"
                    " WHERE import_batch_id = 'b-conn' AND suspect_duplicate_of IS NOT NULL"
                ).fetchall()
            }

    def _reset(self) -> None:
        """A clean ledger for the next case. Used where a test sweeps the same pair repeatedly and each
        run has to be the only thing in the database."""
        self.tearDown()
        self.setUp()

    def _measured_ids(self) -> dict:
        return {
            label: self._pair(gap=gap, csv_text=csv_text, connection_text=connection_text, amount=amount)
            for label, gap, csv_text, connection_text, amount, _tier in MEASURED_PAIRS
        }

    def test_every_measured_pair_is_found_at_the_shipped_window(self):
        ids = self._measured_ids()
        flagged = self._sweep()

        self.assertEqual(
            {label: flagged.get(txn_id) for label, txn_id in ids.items()},
            {label: tier for label, _gap, _csv, _conn, _amount, tier in MEASURED_PAIRS},
        )

    def test_the_measured_tail_is_missed_at_the_old_three_day_window(self):
        # The assertion that justifies the constant instead of restating it. At ±3 the two furthest
        # genuine pairs are not even considered as candidates, so they would have landed as silent
        # second copies — which is exactly what the hand-inspection found in the real ledger.
        ids = self._measured_ids()
        with mock.patch.object(duplicate_detection, "CROSS_ACCOUNT_DATE_WINDOW_DAYS", 3):
            flagged = self._sweep()

        self.assertEqual(
            {label for label, *_ in MEASURED_PAIRS if ids[label] in flagged},
            {"Netflix", "CVS", "CVS again"},
        )
        self.assertNotIn(ids["Whole Foods"], flagged, "the +4 pair needs a window wider than 3")
        self.assertNotIn(ids["Rancatore"], flagged, "the +6 pair needs a window wider than 3")

    def test_two_distinct_same_amount_zelle_receipts_never_match(self):
        # The negative control, swept at every gap the window can reach and then at a window far wider
        # than any under discussion. The pair is never flagged, because the text tiers reject it
        # regardless of date — so the date window is not what is holding the false positives back, and
        # widening it does not let them in.
        for gap in range(0, duplicate_detection.CROSS_ACCOUNT_DATE_WINDOW_DAYS + 1):
            with self.subTest(gap=gap):
                self._reset()
                incoming = self._pair(gap=gap, csv_text=ZELLE_CSV_TEXT,
                                      connection_text=ZELLE_CONNECTION_TEXT, amount=ZELLE_AMOUNT)
                self.assertNotIn(incoming, self._sweep())

        self._reset()
        incoming = self._pair(gap=1, csv_text=ZELLE_CSV_TEXT,
                              connection_text=ZELLE_CONNECTION_TEXT, amount=ZELLE_AMOUNT)
        with mock.patch.object(duplicate_detection, "CROSS_ACCOUNT_DATE_WINDOW_DAYS", 30):
            self.assertNotIn(incoming, self._sweep(), "no window makes these two payments the same one")

    def test_two_receipts_differing_only_in_their_last_digit_are_not_one_truncated_descriptor(self):
        # Why the truncation rule is written as "one text is the OTHER ENTIRE TEXT plus a short tail"
        # rather than "the two share a long common prefix". These two payments to the same person carry
        # consecutive reference numbers: 33 characters agree and each ends in a single differing digit.
        # A common-prefix reading sees a long agreement and a one-character tail — a truncation — and
        # promotes them to the tier a merge auto-removes. A prefix-of reading cannot, because neither
        # text is contained in the other.
        #
        # They stay eligible for REVIEW (a character ratio this high is worth a human look); the claim
        # here is only that nothing auto-removes one of two real payments.
        first  = "Zelle payment to Marcy 22781140388"
        second = "Zelle payment to Marcy 22781140389"
        self.assertEqual(len(os.path.commonprefix([first, second])), 33)
        self.assertFalse(first.startswith(second) or second.startswith(first))

        incoming = self._pair(gap=2, csv_text=first, connection_text=second, amount=61.00)
        self.assertNotEqual(self._sweep().get(incoming), "cross_account")

    def test_the_control_shares_everything_with_the_measured_pairs_except_its_text(self):
        # Guards the control against going vacuous: the Zelle rows must differ from a genuine pair ONLY
        # in their text. Swapping in identical text at the same gap and amount flags immediately, so a
        # future change that broke candidate generation would fail here rather than quietly turning the
        # negative control into a test of nothing.
        incoming = self._pair(gap=1, csv_text=ZELLE_CSV_TEXT,
                              connection_text=ZELLE_CSV_TEXT, amount=ZELLE_AMOUNT)
        self.assertEqual(self._sweep().get(incoming), "cross_account")


if __name__ == "__main__":
    unittest.main()
