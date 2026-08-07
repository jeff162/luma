"""
Coverage-window candidate display widening.

When a row is hard-rejected because its date falls in a covered range, the report tries to point at
the *specific* prior transaction. Two sources for the same transaction often disagree on the posting
day by one (timezone/settlement), which used to leave the row showing "no specific match" (→ the
Rejected · review state). The lookup checks the day before/after on the same amount and tags the hit
with `day_offset`; when exact/±1 finds nothing it widens out to `CROSS_ACCOUNT_DATE_WINDOW_DAYS`,
closest day first. The wider reach is a fallback only — it never fires when a closer match already
exists. This is all display-only (the hard-reject verdict is unchanged), so these tests exercise the
candidate lookup directly, no import needed.

The window used to stop at ±2, sized for the foreign-transaction case (a charge posts a local
calendar day ahead, turning ±1 settlement drift into ±2). Real settlement skew between two sources
runs further — a `TST BLACKBIRD DOUGHNUTS` charge dated the 17th by one export and the 20th by
another — and at ±2 those rows were correctly rejected and then reported as "no specific match",
which is the worst pairing: the row is out of the ledger AND the report can't say what replaced it.
"""

from __future__ import annotations

import unittest

from unittest import mock

from backend.services import duplicate_detection
from backend.services.duplicate_detection import (
    DedupeContext,
    _adjacent_date_offsets,
    _candidate_summary_rows_for_coverage,
    duplicate_amount_key as amount_key,
)


class CoverageCandidateWindowTests(unittest.TestCase):
    def _context(self, rows_by_key):
        ctx = DedupeContext()
        ctx.existing_rows_by_account_amount = {"acct": rows_by_key}
        return ctx

    def _lookup(self, ctx, incoming_date, amount="12.34"):
        return _candidate_summary_rows_for_coverage(
            ctx, "acct", incoming_date, float(amount), include_scope=False
        )

    def test_adjacent_date_offsets(self):
        self.assertEqual(
            _adjacent_date_offsets("2026-01-10"),
            [("2026-01-10", 0), ("2026-01-09", -1), ("2026-01-11", 1)],
        )
        # Exact date first so it ranks ahead of the near-date fallbacks; unparseable → just itself.
        self.assertEqual(_adjacent_date_offsets("not-a-date"), [("not-a-date", 0)])

    def test_exact_date_match_has_no_offset(self):
        cand = {"id": "t1", "date": "2026-01-10", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-10", 12.34): [cand]})
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual([c["id"] for c in out], ["t1"])
        self.assertNotIn("day_offset", out[0])

    def test_one_day_off_is_matched_and_tagged(self):
        # Incoming at t-1; the matching prior transaction is at t with the same amount.
        cand = {"id": "t1", "date": "2026-01-10", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-10", 12.34): [cand]})
        out = self._lookup(ctx, "2026-01-09")
        self.assertEqual([c["id"] for c in out], ["t1"], "a ±1-day same-amount row must now be found")
        self.assertEqual(out[0]["day_offset"], 1, "candidate's date is one day later than the incoming row")

    def test_two_days_off_is_matched_via_fallback(self):
        # Timezone-shifted foreign twin: nothing at exact/±1, but a same-amount row sits at ±2.
        cand = {"id": "t1", "date": "2026-01-12", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-12", 12.34): [cand]})
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual([c["id"] for c in out], ["t1"], "the ±2 fallback must find the timezone twin")
        self.assertEqual(out[0]["day_offset"], 2, "candidate's date is two days later than the incoming row")

    def test_the_wider_reach_does_not_fire_when_a_closer_match_exists(self):
        # A ±1 match is present, so the widened reach must not run and dilute it with a coincidental
        # neighbor. This is what keeps widening from making the common case worse.
        near = {"id": "near", "date": "2026-01-11", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        far = {"id": "far", "date": "2026-01-12", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({
            amount_key("2026-01-11", 12.34): [near],
            amount_key("2026-01-12", 12.34): [far],
        })
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual([c["id"] for c in out], ["near"], "only the ±1 match; the wider reach stays dormant")

    def test_three_days_off_is_matched_rather_than_left_unexplained(self):
        # The reported case: same amount, same account, dated three days apart by two exports. The
        # rejection was right; reporting it as "no specific match" was not.
        cand = {"id": "t1", "date": "2026-01-13", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-13", 12.34): [cand]})
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual([c["id"] for c in out], ["t1"])
        self.assertEqual(out[0]["day_offset"], 3)

    def test_the_window_reaches_the_measured_skew_but_no_further(self):
        # Sized to CROSS_ACCOUNT_DATE_WINDOW_DAYS, the same evidence-derived bound the soft-flag sweep
        # uses. One day past it, the row keeps 'no specific match' and stays in review.
        window = duplicate_detection.CROSS_ACCOUNT_DATE_WINDOW_DAYS
        for gap, expected in ((window, True), (window + 1, False)):
            with self.subTest(gap=gap):
                day = f"2026-02-{10 + gap:02d}"
                cand = {"id": "t1", "date": day, "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
                ctx = self._context({amount_key(day, 12.34): [cand]})
                out = self._lookup(ctx, "2026-02-10")
                self.assertEqual(bool(out), expected)

    def test_a_nearer_candidate_is_never_displaced_by_a_farther_one(self):
        # Widening only helps if it stays ordered: the closest day must still be offered first, or a
        # coincidental week-old row could outrank the actual twin.
        near = {"id": "near", "date": "2026-01-13", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        far = {"id": "far", "date": "2026-01-16", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({
            amount_key("2026-01-13", 12.34): [near],
            amount_key("2026-01-16", 12.34): [far],
        })
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual([c["id"] for c in out], ["near", "far"])
        self.assertEqual([c["day_offset"] for c in out], [3, 6])

    def test_exact_date_ranks_before_near_date(self):
        exact = {"id": "exact", "date": "2026-01-10", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        near = {"id": "near", "date": "2026-01-11", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({
            amount_key("2026-01-10", 12.34): [exact],
            amount_key("2026-01-11", 12.34): [near],
        })
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual([c["id"] for c in out], ["exact", "near"])
        self.assertNotIn("day_offset", out[0])
        self.assertEqual(out[1]["day_offset"], 1)

    def test_cross_account_transfer_fallback_runs_only_when_same_account_empty(self):
        # The cross-account transfer helper is consulted only after same-account/scope finds nothing —
        # and its results are carried through with the cross_account marker + account label intact.
        transfer = {
            "id": "fund", "date": "2026-01-11", "merchant_name": "PayPal", "amount": 716.0,
            "account_id": "checking", "account_name": "Northgate Checking", "cross_account": True,
        }
        calls = []

        def fake_find(conn, acct_id, date_str, amt):
            calls.append((acct_id, date_str, amt))
            return [transfer]

        with mock.patch.object(duplicate_detection, "find_cross_account_transfer_candidates", fake_find):
            # Same-account match present → the ledger lookup is never consulted.
            same = {"id": "same", "date": "2026-01-10", "merchant_name": "X", "amount": 716.0, "account_id": "acct"}
            ctx = self._context({amount_key("2026-01-10", 716.0): [same]})
            ctx.conn = object()
            out = self._lookup(ctx, "2026-01-10", amount="716.00")
            self.assertEqual([c["id"] for c in out], ["same"])
            self.assertEqual(calls, [], "same-account match must short-circuit the cross-account fallback")

            # No same-account match → consulted, its candidate surfaced with marker + account.
            ctx2 = self._context({})
            ctx2.conn = object()
            out2 = self._lookup(ctx2, "2026-01-10", amount="716.00")
            self.assertEqual([c["id"] for c in out2], ["fund"])
            self.assertTrue(out2[0]["cross_account"])
            self.assertEqual(out2[0]["account_name"], "Northgate Checking")
            self.assertEqual(calls, [("acct", "2026-01-10", 716.0)])

    def test_cross_account_fallback_without_a_connection_is_a_no_op(self):
        # A context with no connection (a pure-unit caller) skips the ledger fallback rather than
        # failing, and simply keeps 'no specific match'.
        ctx = self._context({})
        self.assertIsNone(ctx.conn)
        out = self._lookup(ctx, "2026-01-10", amount="716.00")
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
