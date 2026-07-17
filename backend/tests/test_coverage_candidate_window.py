"""
Coverage-window candidate display widening.

When a row is hard-rejected because its date falls in a covered range, the report tries to point at
the *specific* prior transaction. Two sources for the same transaction often disagree on the posting
day by one (timezone/settlement), which used to leave the row showing "no specific match" (→ the
Rejected · review state). The lookup checks the day before/after on the same amount and tags the hit
with `day_offset`; when exact/±1 finds nothing it widens once more to ±2 (a foreign transaction
posts a local calendar day ahead, turning the ±1 settlement drift into ±2). The ±2 reach is a
fallback only — it never fires when a closer match already exists. This is all display-only (the
hard-reject verdict is unchanged), so these tests exercise the candidate lookup directly with an
injected amount-key, no import needed.
"""

from __future__ import annotations

import unittest

from backend.services.duplicate_detection import (
    DedupeContext,
    _adjacent_date_offsets,
    _candidate_summary_rows_for_coverage,
)


def amount_key(date, amount):
    return (date, round(float(amount), 2))


class CoverageCandidateWindowTests(unittest.TestCase):
    def _context(self, rows_by_key):
        ctx = DedupeContext()
        ctx.existing_rows_by_account_amount = {"acct": rows_by_key}
        return ctx

    def _lookup(self, ctx, incoming_date, amount="12.34"):
        return _candidate_summary_rows_for_coverage(
            ctx, "acct", incoming_date, float(amount), amount_key, include_scope=False
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

    def test_two_day_fallback_does_not_fire_when_a_closer_match_exists(self):
        # A ±1 match is present, so the ±2 reach must not run and dilute it with a coincidental neighbor.
        near = {"id": "near", "date": "2026-01-11", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        far = {"id": "far", "date": "2026-01-12", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({
            amount_key("2026-01-11", 12.34): [near],
            amount_key("2026-01-12", 12.34): [far],
        })
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual([c["id"] for c in out], ["near"], "only the ±1 match; ±2 fallback stays dormant")

    def test_three_days_off_stays_no_specific_match(self):
        cand = {"id": "t1", "date": "2026-01-13", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-13", 12.34): [cand]})
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual(out, [], "beyond ±2 the row keeps 'no specific match' (stays in review)")

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

        def fake_find(acct_id, date_str, amt):
            calls.append((acct_id, date_str, amt))
            return [transfer]

        # Same-account match present → helper never consulted.
        same = {"id": "same", "date": "2026-01-10", "merchant_name": "X", "amount": 716.0, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-10", 716.0): [same]})
        ctx.helpers = {"find_cross_account_transfer": fake_find}
        out = self._lookup(ctx, "2026-01-10", amount="716.00")
        self.assertEqual([c["id"] for c in out], ["same"])
        self.assertEqual(calls, [], "same-account match must short-circuit the cross-account fallback")

        # No same-account match → helper consulted, its candidate surfaced with marker + account.
        ctx2 = self._context({})
        ctx2.helpers = {"find_cross_account_transfer": fake_find}
        out2 = self._lookup(ctx2, "2026-01-10", amount="716.00")
        self.assertEqual([c["id"] for c in out2], ["fund"])
        self.assertTrue(out2[0]["cross_account"])
        self.assertEqual(out2[0]["account_name"], "Northgate Checking")
        self.assertEqual(calls, [("acct", "2026-01-10", 716.0)])

    def test_cross_account_fallback_absent_helper_is_a_no_op(self):
        # A context without the helper (older callers / tests) simply keeps 'no specific match'.
        ctx = self._context({})
        out = self._lookup(ctx, "2026-01-10", amount="716.00")
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
