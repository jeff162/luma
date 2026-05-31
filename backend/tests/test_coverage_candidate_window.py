# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Coverage-window candidate display widening.

When a row is hard-rejected because its date falls in a covered range, the report tries to point at
the *specific* prior transaction. Two sources for the same transaction often disagree on the posting
day by one (timezone/settlement), which used to leave the row showing "no specific match" (→ the
Rejected · review state). The lookup now also checks the day before/after on the same amount and tags
the hit with `day_offset`. This is display-only — the hard-reject verdict is unchanged — so these
tests exercise the candidate lookup directly with an injected amount-key, no import needed.
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

    def test_two_days_off_stays_no_specific_match(self):
        cand = {"id": "t1", "date": "2026-01-12", "merchant_name": "X", "amount": 12.34, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-12", 12.34): [cand]})
        out = self._lookup(ctx, "2026-01-10")
        self.assertEqual(out, [], "beyond ±1 the row keeps 'no specific match' (stays in review)")

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


if __name__ == "__main__":
    unittest.main()
