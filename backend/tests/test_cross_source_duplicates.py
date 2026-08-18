"""
Two independent sources reporting one charge into ONE account.

Duplicate detection has always rested on the premise that a single source does not report a charge
twice, so two rows from two sources describing the same amount on the same day are one transaction seen
twice. "Different accounts" was how that premise got tested, because until a provider account could be
mapped `existing` onto an account another source already fed, the two readings coincided. They no longer
do: two data connections can both point at one local account, and then the duplicate arrives *within* an
account where nothing was looking for it.

Three gaps let a real pair through, and all three are pinned here:

  trailing edge  A connection's coverage deliberately stops short of its last `terminal_window_days`,
                 because a provider lags the bank and those days are still filling in. Rule 5 is meant to
                 reconcile them one-to-one instead — but its candidate slots came only from a CSV card's
                 `terminal_date`, and a sync card records none. So a connection got the carve-out with
                 none of the compensation: a window-wide hole in which no rule could fire at all.
  the gate       The soft-flag sweep asked whether two rows were on different ACCOUNTS. It now asks
                 whether they came from different SOURCES, which is what that question always meant.
  the tiers      Two descriptors can name one payee while resembling each other barely at all as
                 strings ("WDRL-ACH <PAYEE> 599…" vs "<PAYEE> Insurance Debitpmt"). Character similarity
                 cannot see that; shared distinctive tokens can. That evidence is good enough to ask the
                 user about and never good enough to act on unseen.

The last point is the one to hold on to when tuning anything here: the same two-token agreement that
earns a review must NOT reach the hard-reject rung, or the row the user wanted to be asked about
disappears silently instead.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.duplicate_detection import (
    AUTO_CROSS_SOURCE_RESOLVED_BY,
    REVIEW_ONLY_SOFT_FLAG_REASONS,
    TEXT_DUPLICATE_MATCH_FLOOR,
    build_dedupe_context,
    classify_source_text_relation,
    classify_text_match,
    evaluate_duplicate,
    mark_import_suspects,
    promote_in_group_suspects_to_confirmed,
    resolve_suspect,
    row_match_texts,
    scan_scope_for_cross_account_duplicates,
    score_duplicate_text_match,
)

ACCOUNT = "acct-checking"
LABEL_A = "Everyday Checking ···4417"      # how connection A names the account
LABEL_B = "Everyday Checking (4417)"       # how connection B names the same account
COVERAGE_THROUGH = "2026-08-08"
INSIDE_WINDOW = "2026-08-03"               # inside A's trailing window, so outside its coverage


class _LedgerTestCase(unittest.TestCase):
    """A ledger with one local account fed by two data connections — the shape that made all of this
    reachable. Connection A has already synced; connection B is the one arriving."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "data.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id)"
                " VALUES (?, 'Everyday Checking', 'Everyday Checking', 'depository', ?)",
                (ACCOUNT, SHARED_OWNER_ID),
            )
            for cid, provider, label, mask in (
                ("conn-a", "plaid", "Everyday Checking", "4417"),
                ("conn-b", "simplefin", "Everyday Checking (4417)", None),
            ):
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential, institution)"
                    " VALUES (?,?,?,'','Northgate Bank')",
                    (cid, provider, f"item-{cid}"),
                )
                conn.execute(
                    "INSERT INTO connection_account (connection_id, external_account_id, account_id,"
                    " mapping_mode, provider_name, provider_mask, coverage_start_date,"
                    " coverage_through_date, terminal_window_days)"
                    " VALUES (?, ?, ?, 'existing', ?, ?, '2024-01-01', ?, 7)",
                    (cid, f"ext-{cid}", ACCOUNT, label, mask, COVERAGE_THROUGH),
                )

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

    def _sync_card(self, batch_id, connection_id):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, status, source_kind, connection_id)"
                " VALUES (?, 'sync card', 'completed', 'connection_sync', ?)",
                (batch_id, connection_id),
            )

    def _row(self, txn_id, batch_id, *, label, date, amount, text, account_id=ACCOUNT, hash_=None):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,"
                " raw_name, date, is_pending, content_hash, import_batch_id, import_evidence_json)"
                " VALUES (?,?,?,?,?,?,?,?,0,?,?,?)",
                (txn_id, account_id, SHARED_OWNER_ID, amount, text, text, text, date,
                 hash_ or f"hash-{txn_id}", batch_id,
                 json.dumps({"account": {"header": "Account", "value": label},
                             "description": {"header": "Description", "value": text}})),
            )

    def _suspect(self, txn_id):
        with self._db() as conn:
            return conn.execute(
                "SELECT suspect_duplicate_of, suspect_duplicate_reason, trashed_at, dedupe_resolved_by"
                " FROM txn WHERE id = ?", (txn_id,),
            ).fetchone()


class ConnectionTrailingWindowTests(_LedgerTestCase):
    """The root cause: a connection's soft trailing days had coverage withheld and nothing put back."""

    def _context(self, conn, *, ingesting="conn-b", label=LABEL_B):
        return build_dedupe_context(
            conn,
            source_values=[label],
            account_by_source_value={label: ACCOUNT},
            compare_targets={label: ACCOUNT},
            alias_values=[label],
            exclude_connection_ids=[ingesting],
        )

    def test_a_connections_rows_in_its_window_become_candidate_slots(self):
        # The whole gap in one assertion: before this, a connection contributed no terminal-day
        # candidates at all, so its trailing window was a hole rather than a reconciliation zone.
        self._sync_card("card-a", "conn-a")
        self._row("a1", "card-a", label=LABEL_A, date=INSIDE_WINDOW, amount=-388.89,
                  text="WDRL-ACH Arbormut Ins 5990 - debitpmt")
        with self._db() as conn:
            ctx = self._context(conn)
        self.assertIn((LABEL_A, INSIDE_WINDOW), ctx.terminal_day_candidates_by_csv_day)
        self.assertIn((ACCOUNT, INSIDE_WINDOW), ctx.terminal_day_candidates_by_scope_day)

    def test_a_second_sources_copy_reconciles_against_that_slot(self):
        # The user-visible consequence. The two sources word the charge completely differently, so no
        # text rule can bridge them — the terminal-day matcher's amount fallback is what identifies the
        # pair, bounded by one-to-one consumption of the slot.
        self._sync_card("card-a", "conn-a")
        self._row("a1", "card-a", label=LABEL_A, date=INSIDE_WINDOW, amount=-388.89,
                  text="WDRL-ACH Arbormut Ins 5990 - debitpmt")
        with self._db() as conn:
            ctx = self._context(conn)
            verdict = evaluate_duplicate(
                context=ctx, receiving_account_id=ACCOUNT, csv_value=LABEL_B,
                content_hash="different-hash", parsed_date=INSIDE_WINDOW, amount=-388.89,
                scope_id=ACCOUNT,
                txn_payload={"merchant_name": "Arbormut Insurance Debitpmt",
                             "display_name": None,
                             "raw_name": "Arbormut Insurance Debitpmt",
                             "import_evidence": None},
            )
        self.assertTrue(verdict.hard_reject)
        self.assertIn("terminal covered day", verdict.reason)
        self.assertEqual(verdict.matched["id"], "a1")

    def test_only_one_incoming_row_can_consume_a_slot(self):
        # The bound that makes an amount-only fallback safe: a second same-amount row on that day is a
        # genuinely new charge, and passes through once the historical copy is spoken for.
        self._sync_card("card-a", "conn-a")
        self._row("a1", "card-a", label=LABEL_A, date=INSIDE_WINDOW, amount=-388.89,
                  text="WDRL-ACH Arbormut Ins 5990 - debitpmt")
        with self._db() as conn:
            ctx = build_dedupe_context(
                conn, source_values=[LABEL_B], account_by_source_value={LABEL_B: ACCOUNT},
                compare_targets={LABEL_B: ACCOUNT}, alias_values=[LABEL_B],
                exclude_connection_ids=["conn-b"],
            )
            verdicts = [
                evaluate_duplicate(
                    context=ctx, receiving_account_id=ACCOUNT, csv_value=LABEL_B,
                    content_hash=f"h{i}", parsed_date=INSIDE_WINDOW, amount=-388.89, scope_id=ACCOUNT,
                    txn_payload={"merchant_name": "Arbormut Insurance Debitpmt",
                                 "display_name": None, "raw_name": "Arbormut Insurance Debitpmt",
                                 "import_evidence": None},
                )
                for i in range(2)
            ]
        self.assertTrue(verdicts[0].hard_reject)
        self.assertTrue(verdicts[1].passthrough, "the slot was already consumed; the second row is new")

    def test_a_connection_never_reconciles_against_its_own_window(self):
        # The asymmetry that must survive: a delta inside a connection's OWN trailing window is a
        # late-posting charge the provider has only now reported, not a re-import.
        self._sync_card("card-a", "conn-a")
        self._row("a1", "card-a", label=LABEL_A, date=INSIDE_WINDOW, amount=-388.89,
                  text="WDRL-ACH Arbormut Ins 5990 - debitpmt")
        with self._db() as conn:
            ctx = build_dedupe_context(
                conn, source_values=[LABEL_A], account_by_source_value={LABEL_A: ACCOUNT},
                compare_targets={LABEL_A: ACCOUNT}, alias_values=[LABEL_A],
                exclude_connection_ids=["conn-a"],
            )
        self.assertNotIn((LABEL_A, INSIDE_WINDOW), ctx.terminal_day_candidates_by_csv_day)

    def test_a_connection_inside_its_own_lag_still_registers_slots(self):
        # Coverage collapses to nothing when a connection has not outrun its own lag, and the code path
        # that computes coverage bails early on exactly that. Slots must be registered before that bail:
        # having proven no range is not the same as having no rows to reconcile against.
        with self._db() as conn:
            conn.execute(
                "UPDATE connection_account SET coverage_start_date = '2026-08-05' WHERE connection_id = 'conn-a'"
            )
        self._sync_card("card-a", "conn-a")
        self._row("a1", "card-a", label=LABEL_A, date="2026-08-06", amount=-20.0, text="Corner Market")
        with self._db() as conn:
            ctx = build_dedupe_context(
                conn, source_values=[LABEL_B], account_by_source_value={LABEL_B: ACCOUNT},
                compare_targets={LABEL_B: ACCOUNT}, alias_values=[LABEL_B],
                exclude_connection_ids=["conn-b"],
            )
        self.assertEqual(ctx.import_coverage_by_scope_id.get(ACCOUNT, []), [])
        self.assertIn((LABEL_A, "2026-08-06"), ctx.terminal_day_candidates_by_csv_day)


class OriginNotAccountTests(_LedgerTestCase):
    """What the soft-flag sweep pairs. The distinction the origin gate buys is the whole safety margin:
    on one account, same-amount rows within a week are overwhelmingly legitimate repeats, and it is
    *only* the fact that two different sources reported them that makes a pair interesting."""

    def _seed_pair(self, *, second_connection):
        self._sync_card("card-a", "conn-a")
        self._sync_card("card-b", second_connection)
        self._row("a1", "card-a", label=LABEL_A, date=INSIDE_WINDOW, amount=-25.0, text="Corner Market")
        self._row("b1", "card-b", label=LABEL_B, date=INSIDE_WINDOW, amount=-25.0, text="Corner Market")

    def test_two_sources_on_one_account_are_paired(self):
        self._seed_pair(second_connection="conn-b")
        with self._db() as conn:
            self.assertEqual(mark_import_suspects(conn, "card-b"), 1)
        self.assertEqual(self._suspect("b1")["suspect_duplicate_of"], "a1")

    def test_one_source_on_one_account_is_never_paired(self):
        # Two cards of ONE connection: monthly period cards are routinely split this way, and a charge
        # legitimately repeating within the window must not read as a duplicate of itself.
        self._seed_pair(second_connection="conn-a")
        with self._db() as conn:
            self.assertEqual(mark_import_suspects(conn, "card-b"), 0)
        self.assertIsNone(self._suspect("b1")["suspect_duplicate_of"])

    def test_a_manual_row_does_not_pair_within_its_own_account(self):
        # A manual entry has no ingesting source, so it asserts nothing about another row on its
        # account — and treating "no origin" as "some other origin" would pair every hand-entered
        # transaction against its own account's history.
        self._sync_card("card-b", "conn-b")
        self._row("m1", None, label=LABEL_A, date=INSIDE_WINDOW, amount=-25.0, text="Corner Market")
        self._row("b1", "card-b", label=LABEL_B, date=INSIDE_WINDOW, amount=-25.0, text="Corner Market")
        with self._db() as conn:
            self.assertEqual(mark_import_suspects(conn, "card-b"), 0)

    def test_the_existing_vs_existing_sweep_pairs_on_origin_too(self):
        # Rows that both predate any comparison are invisible to the import-time sweep; the scope scan is
        # what reaches them. It used to require two accounts to have anything to compare.
        self._seed_pair(second_connection="conn-b")
        with self._db() as conn:
            self.assertEqual(scan_scope_for_cross_account_duplicates(conn, [ACCOUNT]), 1)

    def test_the_sweep_still_refuses_a_same_source_pair(self):
        self._seed_pair(second_connection="conn-a")
        with self._db() as conn:
            self.assertEqual(scan_scope_for_cross_account_duplicates(conn, [ACCOUNT]), 0)


class SameAccountResolutionTests(_LedgerTestCase):
    """How a same-account pair is resolved once flagged."""

    def _flag(self, reason="cross_account"):
        self._sync_card("card-a", "conn-a")
        self._sync_card("card-b", "conn-b")
        self._row("a1", "card-a", label=LABEL_A, date=INSIDE_WINDOW, amount=-25.0, text="Corner Market")
        self._row("b1", "card-b", label=LABEL_B, date=INSIDE_WINDOW, amount=-25.0, text="Corner Market")
        with self._db() as conn:
            conn.execute(
                "UPDATE txn SET suspect_duplicate_of = 'a1', suspect_duplicate_reason = ? WHERE id = 'b1'",
                (reason,),
            )

    def test_an_exact_match_is_auto_confirmed_without_asking(self):
        self._flag()
        with self._db() as conn:
            self.assertEqual(promote_in_group_suspects_to_confirmed(conn, [ACCOUNT]), 1)
        row = self._suspect("b1")
        self.assertIsNotNone(row["trashed_at"])
        self.assertEqual(row["suspect_duplicate_of"], "a1", "the audit pointer survives, so Restore works")

    def test_it_is_not_marked_as_a_merge_it_never_was(self):
        # `auto_merge` means "a merge asserted this and a detach should take it back". Nothing merged
        # here — the rows share one account outright — so a detach elsewhere must not resurrect them.
        self._flag()
        with self._db() as conn:
            promote_in_group_suspects_to_confirmed(conn, [ACCOUNT])
        self.assertEqual(self._suspect("b1")["dedupe_resolved_by"], AUTO_CROSS_SOURCE_RESOLVED_BY)

    def test_review_only_tiers_are_left_for_the_user(self):
        for reason in REVIEW_ONLY_SOFT_FLAG_REASONS:
            with self.subTest(reason=reason):
                self.setUp()
                self._flag(reason)
                with self._db() as conn:
                    self.assertEqual(promote_in_group_suspects_to_confirmed(conn, [ACCOUNT]), 0)
                self.assertIsNone(self._suspect("b1")["trashed_at"])

    def test_keep_asserts_nothing_about_accounts_either_way(self):
        # Keep is per-row for a same-account pair and for a cross-account one alike — the mode switch is
        # gone along with the account-level meaning it used to carry. The same-account case was the
        # landmine that made the switch necessary: `account_pair_distinct` is keyed (low, high) and
        # matched with MIN/MAX, so an (X, X) row would match every future candidate pair on that account
        # and switch detection off there for good.
        for same_account in (True, False):
            with self.subTest(same_account=same_account):
                self.setUp()
                self._flag()
                with self._db() as conn:
                    if not same_account:
                        conn.execute(
                            "INSERT INTO account (id, name, display_name, type, owner_id)"
                            " VALUES ('acct-other','Other','Other','depository', ?)", (SHARED_OWNER_ID,),
                        )
                        conn.execute("UPDATE txn SET account_id = 'acct-other' WHERE id = 'a1'")
                    self.assertEqual(resolve_suspect(conn, "b1", action="keep")["action"], "keep")
                    pairs = conn.execute(
                        "SELECT COUNT(*) AS n FROM account_pair_distinct").fetchone()["n"]
                self.assertEqual(pairs, 0)
                self.assertIsNone(self._suspect("b1")["suspect_duplicate_of"],
                                  "the one row asked about is still cleared")


class WeakTierTests(unittest.TestCase):
    """Shared distinctive tokens as the weakest review tier — and why the same evidence must not reach
    the hard-reject rung."""

    # Built the way a real row is: the descriptor lands in `raw_name`, so it is *precise* text and
    # decides the tier on its own. A bare set would exercise the payee-only path instead.
    A = row_match_texts(None, "wdrl-ach arbormut ins 5990 - debitpmt", None)
    B = row_match_texts(None, "arbormut insurance debitpmt", None)

    def test_two_shared_tokens_earn_a_review(self):
        # Character similarity puts these two at ~0.57, nowhere near the fuzzy tier, yet they name one
        # payee. This is the case the tier exists for — and `classify_text_match`, which the hard-reject
        # rules use, correctly still sees nothing.
        self.assertIsNone(classify_text_match(self.A.all, self.B.all))
        self.assertEqual(classify_source_text_relation(self.A, self.B), "weak")

    def test_one_shared_boilerplate_token_does_not(self):
        # The measured false positive: two unrelated rows joined only by a generic word that happens to
        # have escaped the blocklist.
        self.assertIsNone(classify_source_text_relation(
            row_match_texts(None, "general hold paypal", None),
            row_match_texts(None, "from general fund", None)))

    def test_an_exact_overlap_still_outranks_it(self):
        self.assertEqual(classify_source_text_relation(
            row_match_texts(None, "corner market", None),
            row_match_texts(None, "corner market", None)), "exact")

    def test_the_same_evidence_does_not_hard_reject(self):
        # The hard-reject rung sees a 2-of-3 token overlap and must stay below its floor: two matched
        # tokens where one may be un-blocklisted boilerplate is not grounds to drop a row unseen. This
        # is the assertion to read before "fixing" the 0.7 constant to 2/3.
        score, signals = score_duplicate_text_match(
            "Arbormut Insurance Debitpmt", "WDRL-ACH Arbormut Ins 5990 - debitpmt",
        )
        self.assertEqual(signals["matched_tokens"], 2)
        self.assertLess(score, TEXT_DUPLICATE_MATCH_FLOOR)

    def test_three_of_four_tokens_still_does(self):
        # The boost is not disabled, only bounded: stronger agreement still hard-rejects as before.
        score, signals = score_duplicate_text_match(
            "Corner Market Newton Store", "Corner Market Newton Shop",
        )
        self.assertGreaterEqual(signals["matched_tokens"], 3)
        self.assertGreaterEqual(score, TEXT_DUPLICATE_MATCH_FLOOR)


class InScopeCoverageExplanationTests(_LedgerTestCase):
    """The same charge, two sources, but filed under two accounts of one linked group.

    In-scope coverage rejects on the whole group's claim, so the row it is rejecting against is
    routinely the sibling's copy. Naming that copy is the entire job of the report entry — a rejected
    row whose replacement cannot be named is what makes auditing rejections impossible.
    """

    CHILD = "acct-checking-child"
    CSV_LABEL = "Everyday Checking"        # a file's own name for the account — a third source
    IN_COVERAGE = "2026-07-01"             # inside the connections' coverage, well clear of the window

    def setUp(self):
        super().setUp()
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id, parent_account_id)"
                " VALUES (?, 'EVERYDAY CHECKING ···4417', 'Everyday Checking', 'depository', ?, ?)",
                (self.CHILD, SHARED_OWNER_ID, ACCOUNT),
            )

    def _context(self, conn):
        # No `compare_targets`: the ordinary import, mapping onto accounts that already exist. Only an
        # import that CREATES an account and groups it ever recorded one, and building the linked-group
        # index from compare targets alone is exactly what left this case with nothing to point at.
        return build_dedupe_context(
            conn,
            source_values=[self.CSV_LABEL],
            account_by_source_value={self.CSV_LABEL: ACCOUNT},
        )

    def _verdict(self, ctx):
        return evaluate_duplicate(
            context=ctx, receiving_account_id=ACCOUNT, csv_value=self.CSV_LABEL,
            content_hash="incoming-hash", parsed_date=self.IN_COVERAGE, amount=-95.0,
            scope_id=ACCOUNT,
            txn_payload={"merchant_name": "Annual Membership Fee", "display_name": None,
                         "raw_name": "ANNUAL MEMBERSHIP FEE", "import_evidence": None},
        )

    def test_the_group_index_is_built_without_an_explicit_compare_target(self):
        # The regression guard one level down from the behavior below: an empty index is silent, and a
        # scope fold over an empty index looks exactly like a scope fold that found nothing.
        self._sync_card("card-a", "conn-a")
        self._row("sibling", "card-a", label=LABEL_A, date=self.IN_COVERAGE, amount=-95.0,
                  text="ANNUAL MEMBERSHIP FEE", account_id=self.CHILD)
        with self._db() as conn:
            ctx = self._context(conn)
        self.assertIn(ACCOUNT, ctx.existing_rows_by_effective_account_amount,
                      "the receiving account's own linked-group root must be indexed")

    def test_a_coverage_reject_names_the_siblings_copy(self):
        self._sync_card("card-a", "conn-a")
        self._row("sibling", "card-a", label=LABEL_A, date=self.IN_COVERAGE, amount=-95.0,
                  text="ANNUAL MEMBERSHIP FEE", account_id=self.CHILD)
        with self._db() as conn:
            verdict = self._verdict(self._context(conn))
        self.assertTrue(verdict.hard_reject)
        self.assertIn("account scope", verdict.reason)
        self.assertEqual([c["id"] for c in verdict.matched["candidates"]], ["sibling"])
        # Naming the right row by the wrong route is its own defect: with the group unreachable, the
        # transfer fallback can reach the same row and tag it `cross_account`, which the report renders
        # as "possible transfer match" — a funding leg to confirm or reject, not the duplicate it is.
        self.assertNotIn("cross_account", verdict.matched["candidates"][0])

    def test_the_sibling_outranks_a_coincidental_same_amount_row_days_away(self):
        # The reported failure. With the group unreachable, the exact-date probe found nothing and the
        # widened ±N-day reach then named an unrelated charge that merely shared the amount — an
        # explanation confident enough to act on ("Enrich existing" folds the incoming detail into the
        # named row) and wrong.
        self._sync_card("card-a", "conn-a")
        self._row("sibling", "card-a", label=LABEL_A, date=self.IN_COVERAGE, amount=-95.0,
                  text="ANNUAL MEMBERSHIP FEE", account_id=self.CHILD)
        self._row("coincidence", "card-a", label=LABEL_A, date="2026-06-26", amount=-95.0,
                  text="Parks & Recreation Dept")
        with self._db() as conn:
            verdict = self._verdict(self._context(conn))
        self.assertEqual([c["id"] for c in verdict.matched["candidates"]], ["sibling"],
                         "an exact-date sibling must never lose to a five-day-old same-amount row")
        self.assertNotIn("day_offset", verdict.matched["candidates"][0])

    def test_a_reject_survives_its_only_candidate_being_filtered_out(self):
        # The load-bearing test for where the text filter is wired. `_coverage_reject_verdict` treats an
        # EMPTY candidate list as a signal: a named row with nothing to point at goes down the
        # find_ledger_payment_match escape hatch and, finding no corroborating charge, IMPORTS instead of
        # being rejected. So the filter has to run after that check, on the reported list only. Wire it
        # one line earlier and this row silently enters the ledger — the failure this pins.
        self._sync_card("card-a", "conn-a")
        self._row("coincidence", "card-a", label=LABEL_A, date="2026-06-27", amount=-95.0,
                  text="Parks & Recreation Dept", account_id=self.CHILD)
        with self._db() as conn:
            verdict = self._verdict(self._context(conn))
        self.assertTrue(verdict.hard_reject, "the coverage rejection must not become an import")
        self.assertIn("account scope", verdict.reason)
        self.assertEqual(verdict.matched["candidates"], [],
                         "a same-amount row sharing no wording is not an explanation")
        self.assertEqual(verdict.matched["candidate_count"], 0)

    def test_same_source_coverage_still_does_not_reach_the_group(self):
        # Rule 1's premise is narrower — THIS source already covered this range for this account — so it
        # keeps its same-account-only lookup. Widening it would let a sibling's row explain a rejection
        # the sibling had no part in.
        self._sync_card("card-a", "conn-a")
        self._row("sibling", "card-a", label=LABEL_A, date=self.IN_COVERAGE, amount=-95.0,
                  text="ANNUAL MEMBERSHIP FEE", account_id=self.CHILD)
        with self._db() as conn:
            # Ingesting under connection A's own label makes A's coverage same-source rather than
            # in-scope, which is the distinction Rule 1 turns on.
            ctx = build_dedupe_context(
                conn, source_values=[LABEL_A], account_by_source_value={LABEL_A: ACCOUNT},
            )
            verdict = evaluate_duplicate(
                context=ctx, receiving_account_id=ACCOUNT, csv_value=LABEL_A,
                content_hash="incoming-hash", parsed_date=self.IN_COVERAGE, amount=-95.0,
                scope_id=ACCOUNT,
                txn_payload={"merchant_name": None, "display_name": None,
                             "raw_name": "ANNUAL MEMBERSHIP FEE", "import_evidence": None},
            )
        self.assertTrue(verdict.hard_reject)
        self.assertIn("this source account", verdict.reason)
        self.assertEqual(verdict.matched["candidates"], [])


if __name__ == "__main__":
    unittest.main()
