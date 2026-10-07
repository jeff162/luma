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
runs further — one charge dated the 17th by one export and the 20th by another — and at ±2 those
rows were correctly rejected and then reported as "no specific match",
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
    _display_candidates,
    duplicate_amount_key as amount_key,
    release_contested_candidates,
    row_match_texts,
)


class CoverageCandidateWindowTests(unittest.TestCase):
    def _context(self, rows_by_key):
        ctx = DedupeContext()
        ctx.existing_rows_by_account_amount = {"acct": rows_by_key}
        return ctx

    def _lookup(self, ctx, incoming_date, amount="12.34"):
        return _candidate_summary_rows_for_coverage(
            ctx, "acct", incoming_date, float(amount), scope_id=None
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
            "account_id": "checking", "account_name": "Everyday Checking", "cross_account": True,
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
            self.assertEqual(out2[0]["account_name"], "Everyday Checking")
            self.assertEqual(calls, [("acct", "2026-01-10", 716.0)])

    def test_a_scope_fold_reaches_a_sibling_account_the_receiving_account_cannot_see(self):
        # The in-scope coverage rule rejects on a whole linked group's coverage, so the twin it is
        # rejecting against is routinely filed under a SIBLING account — a second source's copy of the
        # same card. Without the fold the exact-date probe finds nothing on the receiving account and
        # the widened reach then names whatever same-amount row sits nearby instead.
        sibling = {"id": "sib", "date": "2026-01-10", "merchant_name": "Annual Fee", "amount": 12.34,
                   "account_id": "sibling-acct"}
        coincidence = {"id": "coincidence", "date": "2026-01-05", "merchant_name": "Rec Dept",
                       "amount": 12.34, "account_id": "acct"}
        ctx = self._context({amount_key("2026-01-05", 12.34): [coincidence]})
        ctx.existing_rows_by_effective_account_amount = {
            "group-root": {amount_key("2026-01-10", 12.34): [sibling]},
        }
        self.assertEqual([c["id"] for c in self._lookup(ctx, "2026-01-10")], ["coincidence"],
                         "no scope → the old behavior, reaching five days out for an unrelated row")
        out = _candidate_summary_rows_for_coverage(ctx, "acct", "2026-01-10", 12.34, scope_id="group-root")
        self.assertEqual([c["id"] for c in out], ["sib"], "the exact-date sibling wins outright")
        self.assertNotIn("day_offset", out[0])

    def test_a_scope_fold_reads_only_its_own_scope(self):
        # One pass indexes a map per scope. Reaching into all of them would let an unrelated account
        # group imported in the same run supply a candidate for this row.
        other = {"id": "other-group", "date": "2026-01-10", "merchant_name": "X", "amount": 12.34,
                 "account_id": "unrelated"}
        ctx = self._context({})
        ctx.existing_rows_by_effective_account_amount = {
            "other-root": {amount_key("2026-01-10", 12.34): [other]},
        }
        out = _candidate_summary_rows_for_coverage(ctx, "acct", "2026-01-10", 12.34, scope_id="group-root")
        self.assertEqual(out, [])

    # ---- text tiering of the widened band -------------------------------

    # A stored row's shape is not "one descriptor everywhere": both a data connection and an aggregator
    # export publish a CLEANED `merchant_name` — the payee, with the branch stripped — alongside the
    # as-delivered `raw_name`. Fixtures that put the full descriptor in both fields cannot reproduce the
    # case these tests exist for, because the payee-level agreement that outvotes a branch disagreement
    # never exists in them. Build every candidate the way the ledger actually holds one.
    def _texted(self, txn_id, date, statement, payee, amount=7.75):
        return {"id": txn_id, "date": date, "merchant_name": statement, "amount": amount,
                "account_id": "acct", "source_texts": row_match_texts(payee, statement, None)}

    def _tiered_lookup(self, ctx, incoming_date, statement, payee, amount=7.75):
        """The lookup plus the display filter, i.e. what the report actually receives."""
        return _display_candidates(_candidate_summary_rows_for_coverage(
            ctx, "acct", incoming_date, amount, None, row_match_texts(payee, statement, None),
        ))

    def test_the_widened_band_drops_a_row_that_only_shares_an_amount(self):
        # The reported case, in the shape the ledger actually holds it. Four same-amount rows inside ±7
        # of an incoming charge: two name the same shop and branch, one names the same shop at ANOTHER
        # branch, and one is an unrelated charge that happens to cost the same.
        #
        # Every one of these rows cleans to the same payee, so a union-of-texts comparison calls all
        # three shop rows 'exact' — the strongest tier, resting on the field that cannot tell branches
        # apart. Deciding on the precise text instead demotes the other-branch row to 'weak', which is
        # what it is: same payee, different wording, equally consistent with a second real visit.
        rows = {
            "2026-07-05": self._texted("creamery", "2026-07-05", "COUNTRY CREAMERY & COFFE", "Country Creamery"),
            "2026-07-12": self._texted("newton-a", "2026-07-12", "TST*JP LICKS - NEWTON", "Jp Licks"),
            "2026-07-14": self._texted("newton-b", "2026-07-14", "TST*JP LICKS - NEWTON", "Jp Licks"),
            "2026-07-16": self._texted("davis",    "2026-07-16", "TST*JP LICKS - DAVIS",  "Jp Licks"),
        }
        ctx = self._context({amount_key(d, 7.75): [r] for d, r in rows.items()})
        out = self._tiered_lookup(ctx, "2026-07-09", "TST*JP LICKS - NEWTON", "Jp Licks")

        self.assertEqual([c["id"] for c in out], ["newton-a", "newton-b", "davis"],
                         "the same-amount coincidence is dropped; order stays closest-day-first")
        self.assertEqual([c["text_relation"] for c in out], ["exact", "exact", "weak"],
                         "the other-branch row is real but weaker evidence, and must say so")

    def test_a_shared_payee_name_cannot_carry_a_branch_disagreement_to_exact(self):
        # The single assertion behind the tier split, stated without the surrounding lookup: these two
        # rows agree byte-for-byte on their cleaned payee and disagree on the only field that names the
        # branch. 'exact' here would be the report asserting identity from the coarser of two fields.
        newton = row_match_texts("Jp Licks", "TST*JP LICKS - NEWTON", None)
        davis = row_match_texts("Jp Licks", "TST*JP LICKS - DAVIS", None)
        self.assertIn("jp licks", newton.all & davis.all, "the payee agreement really is there")
        self.assertEqual(duplicate_detection.classify_source_text_relation(newton, davis), "weak")
        self.assertEqual(duplicate_detection.classify_source_text_relation(newton, newton), "exact")

    def test_the_internal_comparability_marker_never_reaches_the_report(self):
        # `_text_comparable` exists only to let the filter tell "no agreement" apart from "nothing to
        # compare". Persisting it would put matcher bookkeeping into every stored verdict.
        ctx = self._context({amount_key("2026-07-12", 7.75): [
            self._texted("newton-a", "2026-07-12", "TST*JP LICKS - NEWTON", "Jp Licks")]})
        out = self._tiered_lookup(ctx, "2026-07-09", "TST*JP LICKS - NEWTON", "Jp Licks")
        self.assertNotIn("_text_comparable", out[0])

    def test_an_exact_date_candidate_survives_with_no_text_agreement_at_all(self):
        # The near-band exemption. Two sources describing one charge with nothing in common is ordinary
        # (a terminal string against a cleaned merchant name); at the same date and amount that is the
        # case this lookup exists for, and the text test has no business overruling it.
        ctx = self._context({amount_key("2026-07-09", 7.75): [
            self._texted("same-day", "2026-07-09", "POS PURCHASE TERMINAL 4471", "Terminal 4471")]})
        out = self._tiered_lookup(ctx, "2026-07-09", "Corner Grocery", "Corner Grocery")
        self.assertEqual([c["id"] for c in out], ["same-day"])
        self.assertNotIn("text_relation", out[0], "kept on date evidence — no tier to claim")

    def test_a_one_day_candidate_is_exempt_too(self):
        ctx = self._context({amount_key("2026-07-10", 7.75): [
            self._texted("next-day", "2026-07-10", "POS PURCHASE TERMINAL 4471", "Terminal 4471")]})
        self.assertEqual(
            [c["id"] for c in self._tiered_lookup(ctx, "2026-07-09", "Corner Grocery", "Corner Grocery")],
            ["next-day"])

    def test_an_incoming_row_with_no_text_keeps_its_whole_list(self):
        # A nameless money-movement leg matches nothing by design. Silence is not disagreement, so the
        # filter must not read it as one and empty the list.
        ctx = self._context({amount_key("2026-07-14", 7.75): [
            self._texted("far", "2026-07-14", "COUNTRY CREAMERY & COFFE", "Country Creamery")]})
        out = _display_candidates(_candidate_summary_rows_for_coverage(
            ctx, "acct", "2026-07-09", 7.75, None, row_match_texts(None, None, None)))
        self.assertEqual([c["id"] for c in out], ["far"])

    def test_a_candidate_with_no_text_is_kept_in_the_widened_band(self):
        # The other half of the same rule: the untexted side may be the stored row instead.
        ctx = self._context({amount_key("2026-07-14", 7.75): [
            {"id": "nameless", "date": "2026-07-14", "merchant_name": "", "amount": 7.75,
             "account_id": "acct", "source_texts": row_match_texts(None, None, None)}]})
        out = self._tiered_lookup(ctx, "2026-07-09", "TST*JP LICKS - NEWTON", "Jp Licks")
        self.assertEqual([c["id"] for c in out], ["nameless"])

    # ---- the date exemption is relative, not absolute --------------------

    def _three_same_amount_charges(self):
        """Three same-amount charges on adjacent days, each on its own row — the shape that exposed this.

        Nothing here is unusual: a round amount repeating over two days is ordinary on a real ledger, and
        every one of these rows is a legitimate candidate on amount-and-date evidence alone."""
        return {
            "2026-07-22": [
                self._texted("cyclery", "2026-07-22", "HILLTOP CYCLERY", "Hilltop Cyclery", amount=500.0),
                self._texted("diner", "2026-07-22", "BLUE PLATE DINER", "Blue Plate Diner", amount=500.0),
            ],
            "2026-07-23": [
                self._texted("freight", "2026-07-23", "TARROW FREIGHT", "Tarrow Freight", amount=500.0),
            ],
        }

    def test_a_wordless_neighbour_is_dropped_once_something_agrees_textually(self):
        # The reported case. Three same-amount charges a day apart, each of which has an exact-wording
        # twin in the ledger — and every row listed all three, with its real twin buried among two
        # coincidences shown at equal confidence. The near-date exemption was written for a genuine case
        # (two sources describing one charge with no shared text) but stated absolutely, so it could not
        # tell that case from this one. Once a candidate for the same row agrees textually, a better
        # explanation is already present and the wordless neighbours are noise.
        rows = self._three_same_amount_charges()
        ctx = self._context({amount_key(d, 500.0): r for d, r in rows.items()})
        out = self._tiered_lookup(ctx, "2026-07-23", "TARROW FREIGHT", "Tarrow Freight", amount=500.0)
        self.assertEqual([c["id"] for c in out], ["freight"])
        self.assertEqual(out[0]["text_relation"], "exact")

    def test_each_of_the_three_resolves_to_its_own_twin(self):
        # Stated for all three rather than one, because the failure was symmetric: every row saw the same
        # three candidates, so fixing the case means each row now names a *different* one.
        rows = self._three_same_amount_charges()
        ctx = self._context({amount_key(d, 500.0): r for d, r in rows.items()})
        for date, statement, payee, expected in (
            ("2026-07-23", "TARROW FREIGHT", "Tarrow Freight", "freight"),
            ("2026-07-22", "HILLTOP CYCLERY", "Hilltop Cyclery", "cyclery"),
            ("2026-07-22", "BLUE PLATE DINER", "Blue Plate Diner", "diner"),
        ):
            with self.subTest(payee=payee):
                out = self._tiered_lookup(ctx, date, statement, payee, amount=500.0)
                self.assertEqual([c["id"] for c in out], [expected])

    def test_the_exemption_still_holds_when_nothing_agrees(self):
        # The counterfactual that keeps the rule honest, and the case the exemption exists for: with no
        # textual agreement anywhere in the list, the near-date candidates are all the evidence there is
        # and every one of them is kept. Filtering here would drop correct matches — a bank's terminal
        # string against an aggregator's cleaned merchant name shares nothing by design.
        rows = self._three_same_amount_charges()
        ctx = self._context({amount_key(d, 500.0): r for d, r in rows.items()})
        out = self._tiered_lookup(ctx, "2026-07-23", "POS PURCHASE TERMINAL 4471", "Terminal 4471",
                                  amount=500.0)
        self.assertEqual(sorted(c["id"] for c in out), ["cyclery", "diner", "freight"])
        self.assertTrue(all("text_relation" not in c for c in out))

    def test_a_pair_with_no_text_to_compare_is_never_outranked(self):
        # The one exemption that stays unconditional. A nameless money-movement leg agrees with nothing
        # because there is nothing to agree with, so it cannot be beaten by evidence it never had.
        ctx = self._context({amount_key("2026-07-23", 500.0): [
            self._texted("freight", "2026-07-23", "TARROW FREIGHT", "Tarrow Freight", amount=500.0),
            {"id": "nameless", "date": "2026-07-23", "merchant_name": "", "amount": 500.0,
             "account_id": "acct", "source_texts": row_match_texts(None, None, None)},
        ]})
        out = self._tiered_lookup(ctx, "2026-07-23", "TARROW FREIGHT", "Tarrow Freight", amount=500.0)
        self.assertEqual(sorted(c["id"] for c in out), ["freight", "nameless"])

    def test_the_strongest_explanation_is_listed_first(self):
        # Candidates arrive closest-day-first, which is the wrong order once the tiers differ: the real
        # twin could be listed below a nearer-dated row that merely shares a payee name. Order is by
        # tier, then by distance — so the row a reader checks first is the one most likely to be right.
        ctx = self._context({
            amount_key("2026-07-23", 500.0): [
                self._texted("same-day-weaker", "2026-07-23", "TARROW FREIGHT - DEPOT 12",
                             "Tarrow Freight", amount=500.0)],
            amount_key("2026-07-22", 500.0): [
                self._texted("day-before-exact", "2026-07-22", "TARROW FREIGHT", "Tarrow Freight",
                             amount=500.0)],
        })
        out = self._tiered_lookup(ctx, "2026-07-23", "TARROW FREIGHT", "Tarrow Freight", amount=500.0)
        self.assertEqual([c["id"] for c in out], ["day-before-exact", "same-day-weaker"])
        self.assertEqual(out[0]["text_relation"], "exact")

    def test_cross_account_fallback_without_a_connection_is_a_no_op(self):
        # A context with no connection (a pure-unit caller) skips the ledger fallback rather than
        # failing, and simply keeps 'no specific match'.
        ctx = self._context({})
        self.assertIsNone(ctx.conn)
        out = self._lookup(ctx, "2026-01-10", amount="716.00")
        self.assertEqual(out, [])

    def test_only_a_worded_same_account_claim_releases_a_candidate(self):
        # Measured on a real ledger, the two guards are what keep this to a handful of rows: a PayPal row
        # naming the card charge on another account as "the same payment" sits beside that charge's own
        # row in the same file, and a wordless same-day neighbour proves no more than a wordless guess.
        def covered(*candidates):
            return {"covered": {}, "candidates": list(candidates), "candidate_count": len(candidates)}
        claimant = covered({"id": "twin", "text_relation": "exact"})
        guess = covered({"id": "twin", "day_offset": 2})
        transfer = covered({"id": "twin", "cross_account": True})
        wordless_claimant = covered({"id": "other"})
        wordless_guess = covered({"id": "other", "day_offset": 2})
        release_contested_candidates([claimant, guess, transfer, wordless_claimant, wordless_guess])
        self.assertEqual(guess["candidates"], [])
        self.assertEqual([len(m["candidates"]) for m in (claimant, transfer, wordless_claimant, wordless_guess)],
                         [1, 1, 1, 1])


if __name__ == "__main__":
    unittest.main()
