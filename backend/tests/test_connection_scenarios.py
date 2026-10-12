"""
Connection sync driven as *sequences of events* against a simulated bank, with invariants checked after
every step.

The other connection tests assert individual behaviours. These assert that a **run of events** leaves the
ledger and its coverage claims consistent — connect, sync, the bank adds an account, sync, map it, sync,
deepen, run out of budget, come back tomorrow. That shape matters because every bug this subsystem has had
lived between two steps rather than inside one: coverage written from the wrong pull, a watermark advanced
by a pull that fetched nothing recent, a budget counted against the wrong day. A single-call test cannot
see any of them.

The rules live in `_connection_invariants.assert_invariants` and are checked after *every* sync here, so a
scenario only has to describe what happened; what must always be true is stated once, elsewhere.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.services import crypto_service
from backend.services.ledger_currency import set_ledger_currency
from backend.services.providers.simplefin import (
    REQUEST_BUDGET_CAPACITY,
    REQUEST_BUDGET_REFILL_PER_HOUR,
    WINDOW_DAYS,
    SimpleFinAdapter,
    SimpleFinError,
)
from backend.tests._connection_invariants import assert_invariants
from backend.tests._simplefin_sim import SimpleFinSim, Txn, build_ledger

CONNECTION_ID = "conn-sfin"
CHECKING = "simplefin:Demo Checking"
SAVINGS = "simplefin:Demo Savings"
TRAVEL = "simplefin:Demo Travel"


class ConnectionScenarioTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "scenarios.db"
        init_db(str(self.db_path))
        self.sim = SimpleFinSim(transactions=build_ledger(), today="2026-08-08")
        # Tracked alongside the DB value so the invariants are told what the ledger holds rather than
        # reading it from the code they are judging — see `assert_invariants`.
        self.ledger_currency = "USD"
        self.adapter = SimpleFinAdapter()
        with self._db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES (?, 'simplefin', 'sfin_x', '', 'SimpleFIN Bridge')", (CONNECTION_ID,),
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

    # ---- fixtures -------------------------------------------------------

    def _offer(self, external_account_id, *, mapped=True, mode="new"):
        """The bank offers an account, and (by default) the user maps it to a local one."""
        local = external_account_id.replace(":", "-")
        with self._db() as conn:
            if mapped:
                conn.execute(
                    "INSERT OR IGNORE INTO account (id, name, display_name, type, owner_id, "
                    "external_account_id, connection_id, provider) "
                    "VALUES (?,?,?, 'depository', ?, ?, ?, 'simplefin')",
                    (local, local, local, SHARED_OWNER_ID, external_account_id, CONNECTION_ID),
                )
            conn.execute(
                "INSERT INTO connection_account (connection_id, external_account_id, account_id, "
                "mapping_mode, provider_name, history_complete, history_empty_streak) "
                "VALUES (?,?,?,?,?,0,0) "
                "ON CONFLICT(connection_id, external_account_id) DO UPDATE SET "
                "account_id = excluded.account_id, mapping_mode = excluded.mapping_mode",
                (CONNECTION_ID, external_account_id, local if mapped else None,
                 mode if mapped else None, external_account_id),
            )
        return local

    def _sync(self, *, days=0, full_history=False, transport=None, credential_error=None):
        """One `POST /sync`, with the clock and the transport pointed at the simulator, then every
        invariant checked. Deliberately goes through `run_sync` and the database rather than calling the
        adapter — two of the three bugs this file exists for lived in the write, not the fetch.

        `transport` replaces the simulator as the HTTP layer, for a test that needs to observe the world
        *at the moment a provider call is in flight* — which is the only point at which "is a write
        transaction being held across this?" can be asked.

        `credential_error` makes the vault fail to produce the credential instead of returning it, for the
        one failure that happens *before* any provider call — see the `VaultDecryptError` scenario."""
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))

        class _Clock(date):
            @classmethod
            def today(cls):
                return self.sim.today

        sim = self.sim

        class _UtcClock(datetime):
            """Moves the *wall clock*, so `_utc_today` runs for real rather than being replaced.

            Stubbing `_utc_today` would make every scenario blind to which clock the budget is keyed to —
            the exact bug this subsystem had. Driving `now` instead leaves that logic under test, and
            subclassing keeps the rest of `datetime` (`fromtimestamp`, `combine`, `min`) intact rather
            than requiring every attribute the adapter happens to use to be listed here.
            """

            @classmethod
            def now(cls, tz=None):
                return sim.now if tz in (None, timezone.utc) else sim.now.astimezone(tz)

        token = set_current_db_path(str(self.db_path))
        try:
            with mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                 mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential",
                                   side_effect=credential_error,
                                   return_value="https://u:p@bridge.simplefin.org/simplefin"), \
                 mock.patch.object(sync_module, "get_adapter", return_value=self.adapter), \
                 mock.patch.object(sync_module, "date", _Clock), \
                 mock.patch("backend.services.providers.simplefin._http", transport or self.sim), \
                 mock.patch("backend.services.providers.simplefin.datetime", _UtcClock):
                result = sync_module.run_sync(days=days, connection_id=CONNECTION_ID, request=request,
                                              full_history=full_history)
        finally:
            reset_current_db_path(token)

        with self._db() as conn:
            assert_invariants(self, conn, self.sim, CONNECTION_ID,
                              window_days=WINDOW_DAYS, budget_capacity=REQUEST_BUDGET_CAPACITY,
                              budget_refill_per_hour=REQUEST_BUDGET_REFILL_PER_HOUR,
                              # Stated by the scenario, never read from the setting the code reads: an
                              # invariant that resolved it the same way the app does would agree with the
                              # app about a currency it had got wrong.
                              ledger_currency=self.ledger_currency)
        return result

    def _coverage(self):
        with self._db() as conn:
            return {r["external_account_id"]: dict(r) for r in conn.execute(
                "SELECT external_account_id, coverage_start_date, coverage_through_date, "
                "history_complete FROM connection_account WHERE connection_id = ?", (CONNECTION_ID,),
            )}

    def _request_budget(self):
        with self._db() as conn:
            stored = conn.execute("SELECT provider_request_budget FROM connection WHERE id = ?",
                                  (CONNECTION_ID,)).fetchone()["provider_request_budget"]
        return json.loads(stored) if stored else {}

    def _row_count(self):
        with self._db() as conn:
            return conn.execute(
                "SELECT COUNT(*) AS n FROM txn WHERE trashed_at IS NULL").fetchone()["n"]

    def _set_ledger_currency(self, code):
        """Denominate this ledger, for both the app and the invariants."""
        with self._db() as conn:
            set_ledger_currency(conn, code)
        self.ledger_currency = code

    def _connection_row(self):
        with self._db() as conn:
            return dict(conn.execute(
                "SELECT * FROM connection WHERE id = ?", (CONNECTION_ID,)).fetchone())

    # ---- scenarios ------------------------------------------------------

    def test_a_bounded_first_backfill_then_routine_syncs(self):
        self._offer(CHECKING)
        self._offer(SAVINGS)
        self._sync(days=90, full_history=True)
        after_backfill = self._row_count()
        self.assertGreater(after_backfill, 0)

        # Days pass with no new activity: syncing repeatedly must add nothing and must not drift.
        for _ in range(3):
            self.sim.advance_days(1)
            self._sync(days=90)
        self.assertEqual(self._row_count(), after_backfill, "routine syncs invented rows")

    def test_a_zero_amount_row_is_refused_and_reported_rather_than_imported(self):
        # The fixture's `zero-1` authorization, pinned end to end through a real pull. SimpleFIN declares
        # `zero_amount_rows = "reject"`: nothing it publishes can revise a held row into its settled
        # amount (no change feed, no pending pointer — a settling charge arrives under a new id), so the
        # placeholder is unreachable dead weight, exactly as in a CSV. The contrasting half lives in
        # `test_sync_period_cards`, where a cursor provider keeps it because a `modified` can land on it.
        self._offer(CHECKING)
        self._sync(days=90, full_history=True)
        with self._db() as conn:
            held = conn.execute(
                "SELECT COUNT(*) c FROM txn WHERE external_transaction_id LIKE '%:zero-1' "
                "AND trashed_at IS NULL").fetchone()["c"]
        self.assertEqual(held, 0, "a $0 SimpleFIN row was imported; nothing can ever settle it, so it "
                                  "would sit in the ledger forever (see source_capabilities.py)")

        # Refused, not silently dropped — the whole reason rejection is acceptable here.
        with self._db() as conn:
            summary = json.loads(conn.execute(
                "SELECT config_snapshot FROM import_batch WHERE connection_id = ? "
                "AND source_kind = 'connection_sync'", (CONNECTION_ID,),
            ).fetchone()["config_snapshot"])["import_summary"]
        self.assertEqual(summary["zero_amount_count"], 1)
        self.assertEqual(summary["rejected_count"], 1)
        with self._db() as conn:
            kinds = [r["kind"] for r in conn.execute(
                "SELECT r.kind FROM import_batch_rejected_row r JOIN import_batch b ON b.id = r.batch_id "
                "WHERE b.connection_id = ?", (CONNECTION_ID,),
            ).fetchall()]
        self.assertEqual(kinds, ["zero_amount"],
                         "the refused row must be on the card's rejected report, where a rejected CSV "
                         "row would be — a refusal the user cannot see is indistinguishable from a bug")

    def test_a_deep_backfill_pauses_on_budget_and_resumes_the_next_day(self):
        # The scenario the invariants were written for: a walk that cannot finish in one day must claim
        # only what it fetched, and must pick up where it stopped rather than restarting or forgetting.
        self._offer(CHECKING)
        self._offer(SAVINGS)
        first = self._sync(days=0, full_history=True)
        self.assertTrue(first["paused"], "a multi-year ledger cannot be walked in one day's budget")
        paused_at = self._coverage()[CHECKING]["coverage_start_date"]

        self.sim.advance_days(1)
        self._sync(days=0, full_history=True)
        resumed_at = self._coverage()[CHECKING]["coverage_start_date"]
        self.assertLess(resumed_at, paused_at, "the second day must reach further back, not restart")

    def test_an_account_the_bank_adds_later_is_discovered_mapped_and_caught_up(self):
        # The whole reason the per-account model exists, end to end.
        self._offer(CHECKING)
        self._sync(days=90, full_history=True)
        established = self._coverage()[CHECKING]["coverage_start_date"]

        # The bank starts offering a second account, whose transactions arrive with nowhere to go.
        self.sim.accounts.append("Demo Savings")
        self.sim.advance_days(1)
        discovered = self._sync(days=90)
        self.assertEqual(discovered["discovered"], 1)
        self.assertIsNone(self._coverage()[SAVINGS]["coverage_start_date"],
                          "recorded, but nothing is claimed for it until it has somewhere to go")

        # The user maps it; the next history pull brings it up to the others' depth.
        self._offer(SAVINGS)
        self._sync(days=90, full_history=True)
        after = self._coverage()
        self.assertIsNotNone(after[SAVINGS]["coverage_start_date"])
        # Compared as a *depth*, not a date. A requested depth is relative to the day it is asked on, so
        # the newcomer pulling 90 days a day later lands one day shallower — which is right, and asserting
        # equal dates would only pin the calendar. What matters is that it got a history pull at all
        # rather than the short recent window a routine sync would have given it.
        drift = (date.fromisoformat(after[SAVINGS]["coverage_start_date"])
                 - date.fromisoformat(established)).days
        self.assertLessEqual(abs(drift), 2,
                             "the newcomer should reach essentially as far back as its siblings")

    def test_two_accounts_issuing_the_same_transaction_ids_both_import(self):
        # The bug this guards against, seen against the Bridge's own demo server: it derives each
        # transaction id from the posting instant and runs every account on one schedule, so two accounts
        # issue byte-identical ids. The ledger treats `external_transaction_id` as globally unique (a UNIQUE
        # column, and every sync lookup queries it unscoped), which holds for Plaid but is not something
        # SimpleFIN promises — its ids are unique only *within* an account. So the second account's rows
        # each matched the first's on that lookup and were counted as already-held: the account imported
        # nothing, and the sync reported success. The adapter namespaces the id by account to keep the
        # ledger's invariant true (see `_normalize_txn`).
        #
        # The signature to recognize if this ever regresses is `added == skipped` exactly, with one account
        # empty — which is how it was found.
        collision_ids = ["shared-1", "shared-2", "shared-3"]
        self.sim.ledger = [
            Txn(txn_id=txn_id, account=account, posted="2026-08-01", amount="-10.00",
                description=f"{account} charge")
            for txn_id in collision_ids
            for account in ("Demo Checking", "Demo Savings")
        ]
        checking = self._offer(CHECKING)
        savings = self._offer(SAVINGS)
        self._sync(days=90, full_history=True)

        with self._db() as conn:
            held = {
                name: {r["external_transaction_id"] for r in conn.execute(
                    "SELECT external_transaction_id FROM txn WHERE account_id = ? AND trashed_at IS NULL",
                    (account_id,),
                )}
                for name, account_id in (("checking", checking), ("savings", savings))
            }
        self.assertEqual(len(held["checking"]), len(collision_ids), "the second account imported nothing")
        self.assertEqual(len(held["savings"]), len(collision_ids))
        # Namespaced, so the two accounts' copies of one bank id coexist rather than colliding.
        self.assertEqual(held["checking"] & held["savings"], set())

    def test_a_skipped_account_is_never_claimed_and_never_re_fetched(self):
        self._offer(CHECKING)
        self._offer(SAVINGS, mapped=False, mode="skip")
        with self._db() as conn:
            conn.execute("UPDATE connection_account SET mapping_mode = 'skip' "
                         "WHERE external_account_id = ?", (SAVINGS,))
        self._sync(days=90, full_history=True)
        before = len(self.sim.requests)
        self.sim.advance_days(1)
        self._sync(days=90)
        # One routine window, and no extra call to re-discover an account the user already declined.
        self.assertEqual(len(self.sim.requests) - before, 1)

    def test_late_posting_rows_arrive_on_the_sync_after_they_post(self):
        # A charge transacted inside a covered range but posted after it must still be collected, which is
        # what the incremental overlap exists for. Without it these rows are lost silently.
        self._offer(CHECKING)
        self._offer(SAVINGS)
        self._sync(days=90, full_history=True)
        for _ in range(6):
            self.sim.advance_days(3)
            self._sync(days=90)
        # Invariant 5 does the real work here: it fails if anything the bank holds inside the claimed
        # range never made it into the ledger.
        coverage = self._coverage()[CHECKING]
        expected = self.sim.expected_ids(
            CHECKING, coverage["coverage_start_date"], coverage["coverage_through_date"])
        self.assertGreater(len(expected), 0, "the fixture must actually span the claimed range")

    def test_a_history_pull_does_not_let_ongoing_activity_slip_through_the_gap(self):
        # The scenario that catches a watermark advanced without a fetch behind it. The shape is specific
        # and needs every part: a routine sync establishes where top-ups resume from, the bank keeps
        # posting, a deep history pull happens more than the overlap later, and the next routine sync then
        # starts from the watermark. If the history pull moved that watermark without fetching anything
        # recent, the days between are never requested by anything — and only transactions posted into
        # that gap make it visible.
        self._offer(CHECKING)
        self._offer(SAVINGS)
        self._sync(days=90, full_history=True)

        # Ten days of ongoing activity, well beyond the incremental overlap.
        for day in range(1, 11):
            self.sim.advance_days(1)
            self.sim.post("Demo Checking", self.sim.today.isoformat(), amount=f"-{day}.00")

        # A deep history pull, which fetches only old windows.
        self._sync(days=0, full_history=True)

        # …and then business as usual.
        self.sim.advance_days(1)
        self._sync(days=90)

        # Invariant 5 does the catching; this states the point in the open so a failure reads clearly.
        coverage = self._coverage()[CHECKING]
        expected = self.sim.expected_ids(
            CHECKING, coverage["coverage_start_date"], coverage["coverage_through_date"])
        with self._db() as conn:
            held = {r["external_transaction_id"] for r in conn.execute(
                "SELECT external_transaction_id FROM txn WHERE trashed_at IS NULL")}
        self.assertFalse(expected - held,
                         "activity posted between the last top-up and the claimed range was never fetched")

    def _wide_bank(self):
        """A connection whose walk can only ever be stopped by the allowance.

        Two properties, both needed, and both absent from the shared ledger fixture:

        - **More accounts than `FILTERED_WALK_MAX_ACCOUNTS`**, so the walk shares unfiltered windows and
          therefore spends the *shared* allowance. A narrower walk is fetched per account against each
          account's own allowance — right, and the wrong fixture for a test about the shared pool.
        - **Every account equally deep, and deeper than one full allowance can reach.** `build_ledger`
          staggers its accounts on purpose, which here would let some finish early, drop the walking set
          below the threshold, and quietly move the rest onto per-account allowances mid-test.
        """
        accounts = ["Demo Checking", "Demo Savings", "Demo Travel", "Demo Brokerage"]
        day, last, ledger, n = date(2012, 1, 1), date(2026, 8, 8), [], 0
        while day <= last:
            for account in accounts:
                n += 1
                ledger.append(Txn(txn_id=f"deep-{n}", account=account, posted=day.isoformat(),
                                  amount=f"-{10 + n % 90}.00", description="Grocery store",
                                  memo="LOCAL GROCER STORE #1133", payee="Grocery store"))
            day += timedelta(days=6)
        self.sim = SimpleFinSim(transactions=ledger, accounts=accounts, today="2026-08-08")
        for name in accounts:
            self._offer(f"simplefin:{name}")

    def test_an_exhausted_allowance_grants_nothing_more_until_it_refills(self):
        self._wide_bank()
        result = self._sync(days=0, full_history=True)
        spent = len(self.sim.requests)
        self.assertTrue(result["paused"], "this bank holds more history than one allowance can reach")
        self.assertEqual(spent, REQUEST_BUDGET_CAPACITY, "the first pull should exhaust the allowance")

        # Immediately again: nothing has been returned yet, so nothing more may be spent.
        self._sync(days=0, full_history=True)
        self.assertEqual(len(self.sim.requests), spent,
                         "an allowance that has refilled by nothing must grant nothing")

    def test_a_resumed_backfill_is_not_reported_as_needing_attention(self):
        """A metered provider's backfill spans many syncs, and every one of them is still `initial`.

        The connection card reserves `attention` for one thing: rows the provider says we already hold on a
        pull that cannot possibly hold anything yet. Keyed on the mode alone, that fired on every
        resumption of a paused backfill — each of which re-asks for a window it has already partly fetched,
        so already-held rows are exactly what it should produce. The card then read as a problem for as
        long as the backfill took, and the outcome that *was* true of it — more history to fetch — was
        masked by the alarm.
        """
        self._wide_bank()
        self._sync(days=0, full_history=True)
        # Refill some allowance and resume. The second call re-covers days the first one already imported.
        self.sim.advance_hours(6)
        self._sync(days=0, full_history=True)

        row = self._connection_row()
        summary = json.loads(row["last_sync_summary"])
        already_held = sum(
            int((c or {}).get("skipped_already_held") or 0) for c in (summary["accounts"] or {}).values()
        )
        self.assertGreater(already_held, 0, "this scenario is only meaningful if the resumption re-asks")
        self.assertEqual(summary["mode"], "initial",
                         "the backfill is unfinished, so the mode has not flipped — that is the trap")
        self.assertEqual(row["last_sync_outcome"], "incomplete",
                         "a resumed backfill re-asking for held days is not a problem; it has more to fetch")

    def test_a_first_pull_re_seeing_its_own_pages_is_not_a_contradiction(self):
        """The other innocent source of "already held", and the one `mode` and the cursor both miss.

        A walking adapter drains several pages whose windows overlap, so page 3 re-offers rows page 1 has
        already imported. That is the call re-seeing its own work on a connection with no cursor and no
        history — every signal that says "first pull" is true, and nothing is wrong. Only rows the ledger
        held *before* the call began can mean a transaction-id collision.
        """
        self._offer(CHECKING)
        self._offer(SAVINGS)
        self._sync(days=0, full_history=True)

        row = self._connection_row()
        summary = json.loads(row["last_sync_summary"])
        raw_held = sum(
            int((c or {}).get("skipped_already_held") or 0) for c in summary["accounts"].values()
        )
        self.assertGreater(raw_held, 0, "this walk must re-cover some of its own pages to be the case")
        self.assertEqual(summary["already_held_unexplained"], 0,
                         "rows this very call imported are not evidence of anything")
        self.assertNotEqual(row["last_sync_outcome"], "attention")

    def _plant_held_row(self, *, card_connection_id):
        """Put the one transaction the bank will offer into the ledger ahead of the sync, filed on an import
        card belonging to `card_connection_id` — which is what decides whether the sync's "already held" is
        this connection re-seeing its own row or a different connection's."""
        shallow = [Txn(txn_id="only-1", account="Demo Checking", posted="2026-07-20", amount="-12.00",
                       description="Grocery store", memo="LOCAL GROCER STORE #1133", payee="Grocery store")]
        self.sim = SimpleFinSim(transactions=shallow, accounts=["Demo Checking"], today="2026-08-08")
        local = self._offer(CHECKING)
        with self._db() as conn:
            if card_connection_id not in (None, CONNECTION_ID):
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential, institution) "
                    "VALUES (?, 'simplefin', 'sfin_other', '', 'Other Bridge')", (card_connection_id,),
                )
            conn.execute(
                "INSERT INTO import_batch (id, filename, source_kind, connection_id) "
                "VALUES ('planted-card', 'Planted card', 'connection_sync', ?)", (card_connection_id,),
            )
            # The id the adapter will derive for the same transaction: SimpleFIN ids are only unique
            # *within* an account, so the ledger's `external_transaction_id` is `<namespaced account>:<id>`
            # (see `_normalize_txn`). Built from the account constant so it stays honest if that changes.
            conn.execute(
                """INSERT INTO txn (id, external_transaction_id, account_id, owner_id, amount,
                                    merchant_name, display_name, raw_name, date, is_pending, import_batch_id)
                   VALUES ('planted', ?, ?, ?, -12.00, 'Grocery store', 'Grocery store',
                           'Grocery store', '2026-07-20', 0, 'planted-card')""",
                (f"{CHECKING}:only-1", local, SHARED_OWNER_ID),
            )

    def test_a_restored_ledger_is_not_a_contradiction_on_the_next_pull(self):
        """A restore puts a connection's own synced rows back and clears its resume point, so the next pull
        is a first pull that finds everything already held. Judged by timing, that read as the connection's
        whole history colliding with itself; judged by who brought the rows in, it is routine overlap."""
        self._plant_held_row(card_connection_id=CONNECTION_ID)
        self._sync(days=0, full_history=True)
        row = self._connection_row()
        summary = json.loads(row["last_sync_summary"])
        self.assertEqual(summary["mode"], "initial", "the resume point is gone, so this is a first pull")
        self.assertEqual(summary["already_held_unexplained"], 0)
        self.assertNotEqual(row["last_sync_outcome"], "attention")

    def test_a_row_another_connection_brought_in_does_raise_attention(self):
        # The case the alarm exists for, kept working while the innocent ones are stripped out: the
        # provider reports a transaction id the ledger already holds from a *different* connection — from
        # outside, indistinguishable from a transaction-id collision.
        self._plant_held_row(card_connection_id="other-connection")
        self._sync(days=0, full_history=True)
        row = self._connection_row()
        summary = json.loads(row["last_sync_summary"])
        self.assertEqual(summary["already_held_unexplained"], 1)
        self.assertEqual(row["last_sync_outcome"], "attention")

    def test_a_row_from_a_removed_connection_is_not_a_contradiction(self):
        # Removing a connection keeps its import cards and nulls their link to it. Reconnecting the same
        # bank re-offers those rows under the same ids, which is the account's earlier data coming round
        # again rather than two connections colliding.
        self._plant_held_row(card_connection_id=None)
        self._sync(days=0, full_history=True)
        row = self._connection_row()
        summary = json.loads(row["last_sync_summary"])
        self.assertEqual(summary["already_held_unexplained"], 0)
        self.assertNotEqual(row["last_sync_outcome"], "attention")

    def test_a_history_pull_with_nothing_left_to_walk_claims_nothing_new(self):
        # Once every account's history is complete, "Fetch more history" has no account left to walk — and
        # a pull that walked nothing must not record having reached anywhere. The tempting reading is that
        # a pull reporting no per-account coverage is a pull that keeps no per-account coverage, so the
        # depth *requested* applies; that is right for a cursor provider and badly wrong for a walking one,
        # which reports exactly that when it has nothing left to do. The connection then claims a decade it
        # never fetched, and duplicate detection hard-rejects genuine rows anywhere inside it.
        shallow = [Txn(txn_id="only-1", account="Demo Checking", posted="2026-07-20", amount="-12.00",
                       description="Grocery store", memo="LOCAL GROCER STORE #1133", payee="Grocery store")]
        self.sim = SimpleFinSim(transactions=shallow, accounts=["Demo Checking"], today="2026-08-08")
        self._offer(CHECKING)
        self._sync(days=0, full_history=True)
        self.assertTrue(self._coverage()[CHECKING]["history_complete"],
                        "this bank holds one transaction; its history must run out immediately")
        established = self._coverage()[CHECKING]["coverage_start_date"]

        self.sim.advance_days(1)
        self._sync(days=0, full_history=True)
        after = self._coverage()[CHECKING]
        self.assertEqual(after["coverage_start_date"], established,
                         "a pull with nothing to walk must not deepen the claim")
        # The trailing edge is the half that *should* move: the top-up did fetch today's activity for it.
        self.assertEqual(after["coverage_through_date"], self.sim.today.isoformat())

    def test_no_write_transaction_is_held_across_a_provider_call(self):
        """The rule the whole per-page commit restructure exists to enforce.

        SQLite serializes writers, so a transaction held open across a provider call blocks *every* other
        request that writes for as long as the network takes — which for a walking provider is minutes.
        The user-visible result was an app that routed but would not load: navigation is client-side, so
        clicks worked while anything writing (the recurring auto-scan on app load, preference saves) waited
        out the busy timeout and then failed with `database is locked`.

        Asserted from inside the transport, because the moment a request is in flight is the only moment
        the question can be asked. The probe is a second connection with a short timeout, standing in for
        the concurrent request a real user generates by clicking something.
        """
        blocked = []
        sim, db_path = self.sim, str(self.db_path)

        def probing_transport(url, *, method="GET", headers=None):
            probe = sqlite3.connect(db_path, timeout=0.25)
            try:
                # Any write will do; this one changes nothing, so the probe cannot affect the scenario it
                # is observing. What matters is that it has to *take the write lock* to do it.
                probe.execute("UPDATE db_meta SET value = value WHERE key = 'version'")
                probe.commit()
            except sqlite3.OperationalError as e:
                blocked.append(f"{e} (during {url.split('?')[0]})")
            finally:
                probe.close()
            return sim(url, method=method, headers=headers)

        self._offer(CHECKING)
        self._offer(SAVINGS)
        self._sync(days=90, full_history=True, transport=probing_transport)
        self.assertEqual(blocked, [], "a write transaction was open while the provider was being called")

    def test_the_duplicate_sweep_runs_after_the_sync_transaction_commits(self):
        """The same rule as the test above, applied to the *other* end of the call.

        The per-page commits kept the write lock free across provider calls, and then the post-import
        duplicate sweep — analysis over the whole ledger, not part of writing the rows — was run inside the
        very transaction that had just been kept short. On a real ledger that sweep took 109 seconds, so
        every other writer failed with `database is locked`, the sync's own request could not return, and
        the progress panel stayed frozen behind it because the running marker is only cleared once the
        response is on its way.

        Probed the same way, from inside the sweep: a second connection with a short timeout must be able
        to take the write lock while the sweep runs. What that proves is that the ingest transaction has
        already committed — which is the invariant, not the speed.
        """
        blocked = []
        db_path = str(self.db_path)
        real_sweep = sync_module.sweep_import_suspects

        def probing_sweep(conn, batch_id, **kwargs):
            probe = sqlite3.connect(db_path, timeout=0.25)
            try:
                probe.execute("UPDATE db_meta SET value = value WHERE key = 'version'")
                probe.commit()
            except sqlite3.OperationalError as e:
                blocked.append(str(e))
            finally:
                probe.close()
            return real_sweep(conn, batch_id, **kwargs)

        self._offer(CHECKING)
        self._offer(SAVINGS)
        with mock.patch.object(sync_module, "sweep_import_suspects", probing_sweep):
            self._sync(days=90, full_history=True)
        self.assertEqual(blocked, [],
                         "the sync's write transaction was still open while the duplicate sweep ran")

    def test_the_sweep_is_told_only_the_rows_this_call_added(self):
        """A connection's whole first backfill files into ONE card, and a metered provider delivers it over
        many calls — so a sweep scoped to the *card* re-examines everything imported so far to check what
        this call added, and every resumption costs more than the last. It is told the new rows instead.
        """
        swept: list[dict] = []
        real_sweep = sync_module.sweep_import_suspects

        def recording_sweep(conn, batch_id, *, txn_ids=None):
            swept.append({"batch_id": batch_id, "txn_ids": list(txn_ids or [])})
            return real_sweep(conn, batch_id, txn_ids=txn_ids)

        self._offer(CHECKING)
        with mock.patch.object(sync_module, "sweep_import_suspects", recording_sweep):
            self._sync(days=90, full_history=True)
            first = sum(len(s["txn_ids"]) for s in swept)
            self.assertEqual(first, self._row_count(), "the first call sweeps the rows it imported")

            # A later call adds a little; the card now holds everything. The sweep must be told the little.
            swept.clear()
            self.sim.advance_days(1)
            self.sim.ledger.append(
                Txn("late-1", "Demo Checking", self.sim.today.isoformat(), "-9.99", "Coffee",
                    memo="CORNER COFFEE", payee="Coffee")
            )
            self._sync(days=90)

        added_now = self._row_count() - first
        self.assertEqual(added_now, 1, "the scenario should have added exactly one row")
        told = sum(len(s["txn_ids"]) for s in swept)
        self.assertEqual(told, added_now,
                         "the sweep was handed the whole card rather than the rows this call added")

    def test_progress_is_readable_from_outside_while_the_sync_is_still_running(self):
        """A long backfill is one HTTP call, so its own response says nothing until it is over.

        That is fine for the tab that started it and useless for everything else — another tab, a reload,
        or the user navigating away and back. So progress is committed as the pull goes, and read from the
        connection like any other state. Checked from a second connection, which sees only committed data;
        reading through the sync's own would see uncommitted writes and prove nothing.
        """
        observed = []
        self._wide_bank()          # replaces self.sim, so bind the transport to it afterwards
        sim, db_path = self.sim, str(self.db_path)

        def transport(url, *, method="GET", headers=None):
            probe = sqlite3.connect(db_path, timeout=0.25)
            try:
                row = probe.execute(
                    "SELECT sync_started_at, sync_progress FROM connection WHERE id = ?",
                    (CONNECTION_ID,)).fetchone()
            finally:
                probe.close()
            observed.append((row[0], json.loads(row[1]) if row[1] else None))
            return sim(url, method=method, headers=headers)

        self._sync(days=0, full_history=True, transport=transport)

        self.assertTrue(all(started for started, _ in observed),
                        "the in-progress marker must be visible before any provider call, not after")
        progress = [p for _, p in observed if p]
        self.assertTrue(progress, "no progress was readable at any point during a multi-page walk")
        # Monotonic, and actually moving — a counter that never advances is indistinguishable from a stall,
        # which is the impression this whole change exists to remove.
        self.assertEqual([p["requests"] for p in progress], sorted(p["requests"] for p in progress))
        self.assertGreater(progress[-1]["requests"], progress[0]["requests"])

        # And it is cleared when the run ends: a finished sync is described by `last_sync`, and leaving
        # progress behind would make it read as one still going.
        with self._db() as conn:
            self.assertIsNone(conn.execute(
                "SELECT sync_progress FROM connection WHERE id = ?", (CONNECTION_ID,)).fetchone()[0])

    def test_each_call_reports_what_it_did_per_connection(self):
        """The response's own breakdown of its totals, which is what a client sums into a run total.

        The alternative — differencing the `sync_progress` a slow poll happens to catch — cannot see a call
        that begins and ends between two polls, and a routine top-up is exactly that. So the figures a
        client reports per connection come from here, and they have to add up to the call's own totals.
        """
        self._offer(CHECKING)
        self._offer(SAVINGS)
        result = self._sync(days=90, full_history=True)

        rows = result["connections"]
        self.assertEqual([r["connection_id"] for r in rows], [CONNECTION_ID],
                         "one row per connection the call touched")
        for field in ("added", "updated", "removed", "skipped"):
            self.assertEqual(sum(r[field] for r in rows), result[field],
                             f"the per-connection {field} figures must add up to the call's own")
        self.assertGreater(rows[0]["added"], 0, "this backfill imported rows; the breakdown must say so")
        self.assertIsNone(rows[0]["error"])
        # The cards those rows landed on, which is what a finished run links to in the import history.
        with self._db() as conn:
            cards = {r[0] for r in conn.execute(
                "SELECT DISTINCT import_batch_id FROM txn WHERE import_batch_id IS NOT NULL")}
        self.assertTrue(cards)
        self.assertEqual(set(rows[0]["card_ids"]), cards)

    def test_a_connection_that_could_not_sync_says_so_in_its_own_row(self):
        # A run is many calls over many connections, and a client showing a row each needs the failure
        # attached to the connection it belongs to — not inferred from a total that came up short.
        self._offer(CHECKING)
        self.sim.refuse_with = SimpleFinError("the bank hung up")
        result = self._sync(days=90, full_history=True)

        self.assertEqual(len(result["connections"]), 1)
        self.assertIn("hung up", result["connections"][0]["error"])
        self.assertEqual(result["connections"][0]["added"], 0)

    def test_a_requests_debit_is_durable_before_that_request_is_issued(self):
        """Write-ahead, and the asymmetry that forces it.

        Recording a spend *after* its request loses it if anything goes wrong in between, so the count
        reads low and the next sync over-spends a limit whose penalty is the provider disabling the token —
        which for this provider cannot be re-issued without re-linking at the Bridge. Recording first can
        only forfeit an allowance nothing used, and a refilling allowance heals that on its own.

        Read from a *second* connection, so it sees only what has actually been committed. Reading through
        the sync's own connection would see its uncommitted writes and pass against exactly the bug.
        """
        seen = []
        sim, db_path = self.sim, str(self.db_path)

        def transport(url, *, method="GET", headers=None):
            probe = sqlite3.connect(db_path, timeout=0.25)
            try:
                row = probe.execute("SELECT provider_request_budget FROM connection WHERE id = ?",
                                    (CONNECTION_ID,)).fetchone()
            finally:
                probe.close()
            pools = (json.loads(row[0]) if row and row[0] else {}).get("pools") or {}
            seen.append(sum(REQUEST_BUDGET_CAPACITY - p["tokens"] for p in pools.values()))
            return sim(url, method=method, headers=headers)

        self._offer(CHECKING)
        self._sync(days=90, full_history=True, transport=transport)

        self.assertTrue(seen, "the walk must have made requests for this to say anything")
        # At the moment request N is on the wire, the committed record must already account for it — so the
        # debit seen by the Nth call is at least N. Never fewer; one more is fine and is the safe direction.
        for issued, committed in enumerate(seen, start=1):
            self.assertGreaterEqual(
                committed, issued,
                f"request {issued} went out with only {committed} debited — a crash here would lose it",
            )

    def test_rows_committed_before_a_pull_dies_outright_survive(self):
        # A *caught* provider error is not the interesting case: `run_sync` handles it per connection, so
        # the pull returns normally and the outer transaction commits either way. What one transaction
        # spanning a whole pull could never survive is the pull **dying** — the process going away, or the
        # final commit itself failing on the very lock this work exists to release. Everything fetched
        # would roll back, including the metered requests spent to fetch it.
        #
        # Modelled with a BaseException, which `except Exception` deliberately does not catch, so it
        # escapes `run_sync` exactly as an interrupt or a hard failure would and the outer transaction is
        # never reached.
        self._wide_bank()
        self.sim.refuse_with = KeyboardInterrupt()
        self.sim.refuse_after = 5
        with self.assertRaises(KeyboardInterrupt):
            self._sync(days=0, full_history=True)

        self.assertEqual(len(self.sim.requests), 5, "the walk should have got some way in before it died")
        self.assertGreater(self._row_count(), 0,
                           "every row fetched before the pull died was discarded with it")
        # And the claim matches what survived: coverage is committed with the rows it describes, so a pull
        # that died partway cannot leave the ledger asserting a range it no longer holds.
        covered = [c for c in self._coverage().values() if c["coverage_start_date"]]
        self.assertTrue(covered, "the pages that did commit should have recorded how far they reached")

    def test_requests_spent_by_a_pull_that_then_failed_are_still_counted(self):
        # The one piece of sync state that must survive a failure. Everything else a pull writes is a claim
        # about data in the ledger and correctly vanishes with a pull that inserted nothing — but the
        # requests were made, and the provider is not going to forget them. A connection that fails is also
        # the one a user retries hardest, so forgetting here overruns the limit exactly where it hurts.
        self._wide_bank()
        self.sim.refuse_with = SimpleFinError("the bank hung up")
        self.sim.refuse_after = 5
        self._sync(days=0, full_history=True)

        served = len(self.sim.requests)
        self.assertEqual(served, 5, "the walk should have got some way in before the bank quit")
        pools = self._request_budget().get("pools") or {}
        self.assertTrue(pools, "a failed pull recorded no spending at all")
        # At least what the server answered, and in fact one more: the request that raised was spent too.
        # Stated as a floor rather than an exact figure so this asserts the property — nothing spent is
        # forgotten — rather than pinning where in the walk the failure happened to land.
        spent = REQUEST_BUDGET_CAPACITY - pools["shared"]["tokens"]
        self.assertGreaterEqual(spent, served,
                                "the allowance must account for every request that actually went out")

    def test_a_failed_pull_does_not_hand_the_next_one_a_fresh_allowance(self):
        # The consequence of the above, and the shape the overrun actually takes: retry after retry, each
        # believing it has spent nothing.
        self._wide_bank()
        self.sim.refuse_with = SimpleFinError("the bank hung up")
        self.sim.refuse_after = 5
        self._sync(days=0, full_history=True)
        self.sim.refuse_with = None
        self._sync(days=0, full_history=True)
        # Invariant 4 is what would fail if the second pull got a clean allowance; this states it in the
        # open so the failure reads as what it is.
        self.assertLessEqual(len(self.sim.requests), REQUEST_BUDGET_CAPACITY,
                             "the retry must continue the allowance, not restart it")

    def test_a_date_rolling_over_does_not_hand_back_the_whole_allowance(self):
        # The overrun a per-day counter cannot see, and the reason the allowance is modelled as a bucket.
        # A walk that empties the allowance late one evening and resumes two hours later has been given
        # back two requests, not twenty-two — but a counter keyed to the calendar sees a new day and grants
        # everything. Nothing about this is exotic: spending the allowance and coming back for the rest is
        # exactly what a deep backfill does, night after night, until it finishes.
        #
        # The hours are the whole test. Advancing a clean day would let a per-day counter and a bucket agree
        # (24h really does refill everything), so the boundary has to be crossed *narrowly* for the two
        # models to give different answers.
        self._wide_bank()
        self.sim.advance_hours(11)          # 23:00
        self._sync(days=0, full_history=True)
        spent = len(self.sim.requests)
        self.assertEqual(spent, REQUEST_BUDGET_CAPACITY, "the evening pull should exhaust the allowance")

        self.sim.advance_hours(2)           # 01:00 the next date, two hours later
        self._sync(days=0, full_history=True)
        self.assertEqual(len(self.sim.requests) - spent, 2,
                         "crossing midnight returns two hours' worth of requests, not a fresh allowance")

    def test_a_partly_refilled_allowance_grants_back_only_what_it_returned(self):
        # The case a per-day counter cannot express, and the reason this is a bucket. Coming back part-way
        # through must yield *some* of the allowance — a counter keyed to the calendar hands back all of it
        # the moment the date rolls, which is how a resuming backfill overruns a limit it never sees.
        self._wide_bank()
        self._sync(days=0, full_history=True)
        spent = len(self.sim.requests)

        self.sim.advance_hours(6)
        self._sync(days=0, full_history=True)
        returned = len(self.sim.requests) - spent
        # Six hours back is six requests' worth, and the walk takes every one of them — it still has years
        # of history to reach. Asserting the exact figure rather than "more than zero" is deliberate: the
        # failure that matters here is crediting too *fast*, which a lower bound would wave through.
        self.assertEqual(returned, int(6 * REQUEST_BUDGET_REFILL_PER_HOUR),
                         "six hours must return six requests — no more, and no fewer")

    def test_a_bank_reporting_a_problem_does_not_stop_the_others(self):
        # One institution needing re-authentication must not block every other account on the credential,
        # and the pull still counts as successful — it just says so.
        self._offer(CHECKING)
        self._offer(SAVINGS)
        self.sim.errlist_for = lambda params: [
            {"code": "con.auth", "msg": "Authentication required", "conn_id": "CON-OTHER"},
        ]
        result = self._sync(days=90, full_history=True)
        self.assertGreater(self._row_count(), 0, "the banks that worked still delivered")
        self.assertTrue(result["warned"], "and the one that did not is reported")

    def test_a_request_advisory_is_not_reported_as_a_bank_problem(self):
        # A note about our own request shape has no user action attached to it; surfacing it beside "your
        # bank needs attention" trains the user to ignore both.
        self._offer(CHECKING)
        self.sim.errlist_for = lambda params: [
            # The real code and wording, taken from the live server rather than invented. The code is
            # what the classifier keys on, so a made-up one tests a branch the server never exercises.
            {"code": "gen.api", "msg": "Requested date range exceeds limit of 90 days and was capped."},
        ]
        result = self._sync(days=90, full_history=True)
        self.assertFalse(result["warned"], "an advisory about the request is not a bank problem")

    def _offer_foreign_account(self, currency="EUR", *, mapped):
        """The bank starts offering an account held in another currency, with activity in it."""
        self.sim.accounts.append("Demo Travel")
        self.sim.currencies["Demo Travel"] = currency
        self.sim.ledger.append(
            Txn("eur-1", "Demo Travel", self.sim.today.isoformat(), "-40.00", "Museum",
                memo="MUSEE DES ARTS", payee="Museum")
        )
        local = self._offer(TRAVEL, mapped=mapped) if mapped else None
        with self._db() as conn:
            conn.execute("UPDATE connection_account SET provider_currency = ? "
                         "WHERE external_account_id = ?", (currency, TRAVEL))
        return local

    def test_an_account_in_another_currency_is_dropped_and_the_user_is_told(self):
        # The ledger holds one currency and `txn.amount` carries no denomination, so these rows cannot be
        # stored at face value. What makes this worth a scenario rather than an adapter test is the second
        # half: the account was *mapped*, so it now exists locally and will sit permanently empty. Silence
        # there is the worst available outcome — everything looks like it worked.
        self._offer(CHECKING)
        travel = self._offer_foreign_account(mapped=True)

        result = self._sync(days=90, full_history=True)

        with self._db() as conn:
            held = conn.execute("SELECT COUNT(*) AS n FROM txn WHERE account_id = ?",
                                (travel,)).fetchone()["n"]
        self.assertEqual(held, 0, "a EUR amount would be stored as if it were dollars")
        # This pull is *filtered* — only Checking still wants history, so the walk narrows the request to
        # it and the travel account appears in no response at all. A warning derived from what a pull
        # discarded would therefore be silent here and vocal on the next unfiltered one, which is the worse
        # failure: absence would stop meaning anything. It is read from the recorded currency instead.
        self.assertTrue(result["warned"], "an account that can never fill must say why")

        # And nothing is claimed for it: a target that can only ever be discarded would spend budget walking
        # a history it throws away, then record coverage over a range whose rows were dropped.
        self.assertIsNone(self._coverage()[TRAVEL]["coverage_start_date"])

    def test_a_foreign_account_with_no_recorded_currency_is_still_never_claimed(self):
        # The state a restore leaves behind: `connection_account` rows come back from a backup that predates
        # the currency column, so the sync's own exclusion has nothing to go on and the account becomes a
        # walk target. Its windows then return nothing (the adapter discards them), its empty-window streak
        # reaches the end-of-history rule, and it would record coverage plus `history_complete` over a range
        # where its transactions plainly exist — the over-claim, arriving by a route the stored currency
        # cannot guard. The adapter refuses the claim because it is the one place that knows it discarded.
        self._offer(CHECKING)
        self._offer_foreign_account(mapped=True)
        with self._db() as conn:
            conn.execute("UPDATE connection_account SET provider_currency = NULL "
                         "WHERE external_account_id = ?", (TRAVEL,))

        self._sync(days=90, full_history=True)

        travel = self._coverage()[TRAVEL]
        self.assertIsNone(travel["coverage_start_date"])
        self.assertFalse(travel["history_complete"],
                         "an account whose windows were discarded has not run out of history")

    def test_an_all_aud_ledger_imports_its_aud_accounts_normally(self):
        # The regression that motivated making this a setting. The check used to compare against a
        # hardcoded "USD", so a non-US user's accounts — entirely self-consistent, nothing wrong with them
        # — had every transaction discarded and every account left empty. The app's constraint is one
        # currency at a time, not dollars; on an AUD ledger, AUD is the supported case.
        self._set_ledger_currency("AUD")
        self.sim.currencies["Demo Checking"] = "AUD"
        self.sim.currencies["Demo Savings"] = "AUD"
        self._offer(CHECKING)
        self._offer(SAVINGS)

        result = self._sync(days=90, full_history=True)

        self.assertGreater(self._row_count(), 0, "an AUD ledger must accept its own AUD accounts")
        self.assertFalse(result["warned"], "nothing here is a problem to report")
        self.assertIsNotNone(self._coverage()[CHECKING]["coverage_start_date"])

    def test_on_an_aud_ledger_it_is_usd_that_is_rejected(self):
        # The mirror image, and what proves the comparison is against the setting rather than against a
        # privileged currency that merely moved.
        self._set_ledger_currency("AUD")
        self.sim.currencies["Demo Checking"] = "AUD"
        self._offer(CHECKING)
        self.sim.accounts.append("Demo Travel")
        self.sim.currencies["Demo Travel"] = "USD"
        self.sim.ledger.append(
            Txn("usd-1", "Demo Travel", self.sim.today.isoformat(), "-40.00", "Souvenirs",
                memo="AIRPORT SHOP", payee="Souvenirs")
        )
        travel = self._offer(TRAVEL)
        with self._db() as conn:
            conn.execute("UPDATE connection_account SET provider_currency = 'USD' "
                         "WHERE external_account_id = ?", (TRAVEL,))

        result = self._sync(days=90, full_history=True)

        with self._db() as conn:
            held = conn.execute("SELECT COUNT(*) AS n FROM txn WHERE account_id = ?",
                                (travel,)).fetchone()["n"]
        self.assertEqual(held, 0)
        self.assertTrue(result["warned"])
        self.assertIsNone(self._coverage()[TRAVEL]["coverage_start_date"])

    def test_an_unmapped_foreign_account_is_logged_rather_than_shown(self):
        # Its rows are discarded by the sync regardless of currency, so there is nothing here the user has
        # lost and nothing for them to decide. A permanent notice on the card for an account they never
        # asked for is how a warning surface stops being read.
        self._offer(CHECKING)
        self._offer_foreign_account(mapped=False)
        self.assertFalse(self._sync(days=90, full_history=True)["warned"])

    def test_a_revoked_access_url_asks_for_a_reconnect_rather_than_counting_failures(self):
        # SimpleFIN has no revocation API: revoking at the Bridge is the only way to revoke, and a refused
        # request is the only notice the app ever gets that it happened. Counting it as another sync failure
        # would leave the card advising patience for something that will never recover on its own.
        self._offer(CHECKING)
        self._sync(days=90, full_history=True)

        self.sim.advance_days(1)
        self.sim.refuse_with = SimpleFinError("SimpleFIN returned 403.", status=403)
        self._sync(days=90)
        self.assertTrue(self._connection_row()["reauth_required"])

        # And a working pull settles it: the credential demonstrably works, whatever was true before.
        self.sim.refuse_with = None
        self.sim.advance_days(1)
        self._sync(days=90)
        row = self._connection_row()
        self.assertFalse(row["reauth_required"])
        self.assertEqual(row["consecutive_sync_failures"], 0)

    def test_an_unreadable_stored_credential_asks_for_a_reconnect(self):
        # A DEK the stored ciphertext was not sealed under — a rebuilt or rotated vault over an older
        # credential. Retrying can never succeed, so counting it alongside network blips would leave the
        # card advising patience for the one failure that is purely the user's to fix, and would tell them
        # the connection "stopped working" when what they need to hear is "store a fresh credential".
        self._offer(CHECKING)
        self._sync(days=90, full_history=True)

        self.sim.advance_days(1)
        self._sync(days=90, credential_error=crypto_service.VaultDecryptError())
        row = self._connection_row()
        self.assertTrue(row["reauth_required"])
        self.assertIn("vault key", row["last_sync_error"])

    def test_a_row_for_an_unrecorded_provider_account_is_logged_not_hidden(self):
        # The card's source label falls back to the provider's opaque id when `connection_account` has no
        # row for an account that `account.external_account_id` nonetheless resolves — the two lookups
        # disagree, the row imports correctly, and only its label is unreadable. Observed once on a real
        # connection whose provider-account rows were missing for reasons that could not be recovered, so
        # what is pinned here is that a recurrence leaves evidence rather than a mystery.
        local = self._offer(CHECKING)
        with self._db() as conn:
            conn.execute("DELETE FROM connection_account WHERE external_account_id = ?", (CHECKING,))
        self._sync(days=90, full_history=True)

        with self._db() as conn:
            label = conn.execute(
                "SELECT csv_value FROM import_batch_account WHERE account_id = ?", (local,)
            ).fetchone()
            advisories = conn.execute(
                "SELECT advisories FROM connection_sync_log ORDER BY started_at DESC LIMIT 1"
            ).fetchone()["advisories"]
        # The symptom, reproduced: the raw provider id stands in for a readable account name.
        self.assertEqual(label["csv_value"], CHECKING)
        # …and the diagnostic that makes it explicable, recorded where a developer would look.
        self.assertIn("no record of", advisories or "")
        self.assertIn(CHECKING, advisories or "")

    def test_an_advisory_like_that_never_reaches_the_user_facing_warnings(self):
        # `last_sync_warnings` is shown on the connection card, so it is reserved for things the user can
        # act on. Luma's own bookkeeping being inconsistent is not one of them, and a permanent notice
        # about it is how a warning surface stops being read.
        self._offer(CHECKING)
        with self._db() as conn:
            conn.execute("DELETE FROM connection_account WHERE external_account_id = ?", (CHECKING,))
        self._sync(days=90, full_history=True)
        self.assertFalse(self._connection_row()["last_sync_warnings"])

    def test_an_ordinary_outage_does_not_ask_the_user_to_redo_their_setup(self):
        # The flag is sticky, so raising it on a transient failure would leave a working connection telling
        # the user to reconnect until the next success happened to clear it.
        self._offer(CHECKING)
        self.sim.refuse_with = SimpleFinError("SimpleFIN returned 503.", status=503)
        self._sync(days=90, full_history=True)
        row = self._connection_row()
        self.assertFalse(row["reauth_required"])
        self.assertEqual(row["consecutive_sync_failures"], 1, "it is still counted as a failure")


if __name__ == "__main__":
    unittest.main()
