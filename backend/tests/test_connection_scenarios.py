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

import tempfile
import unittest
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.services.ledger_currency import set_ledger_currency
from backend.services.providers.simplefin import (
    DAILY_REQUEST_BUDGET,
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

    def _sync(self, *, days=0, full_history=False):
        """One `POST /sync`, with the clock and the transport pointed at the simulator, then every
        invariant checked. Deliberately goes through `run_sync` and the database rather than calling the
        adapter — two of the three bugs this file exists for lived in the write, not the fetch."""
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
                return datetime(sim.today.year, sim.today.month, sim.today.day, 12, 0,
                                tzinfo=tz or timezone.utc)

        token = set_current_db_path(str(self.db_path))
        try:
            with mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                 mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential",
                                   return_value="https://u:p@bridge.example/simplefin"), \
                 mock.patch.object(sync_module, "get_adapter", return_value=self.adapter), \
                 mock.patch.object(sync_module, "date", _Clock), \
                 mock.patch("backend.services.providers.simplefin._http", self.sim), \
                 mock.patch("backend.services.providers.simplefin.datetime", _UtcClock):
                result = sync_module.run_sync(days=days, connection_id=CONNECTION_ID, request=request,
                                              full_history=full_history)
        finally:
            reset_current_db_path(token)

        with self._db() as conn:
            assert_invariants(self, conn, self.sim, CONNECTION_ID,
                              window_days=WINDOW_DAYS, daily_budget=DAILY_REQUEST_BUDGET,
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

    def test_the_budget_resets_on_the_utc_day_not_the_hosts_local_one(self):
        # The bug this scenario is built around had nothing to do with the network: the counter was keyed
        # to the server's local date while the limit it protects is the provider's. A host behind UTC then
        # gets a second allowance partway through the provider's day, and overrunning gets a token
        # disabled. Only a test owning the clock can see it.
        self._offer(CHECKING)
        self._offer(SAVINGS)
        self._sync(days=0, full_history=True)
        spent = self.sim.requests_on(self.sim.today.isoformat())
        self.assertEqual(spent, DAILY_REQUEST_BUDGET, "the first day should exhaust the allowance")

        # Same UTC day, another attempt: nothing more may be spent.
        self._sync(days=0, full_history=True)
        self.assertEqual(self.sim.requests_on(self.sim.today.isoformat()), DAILY_REQUEST_BUDGET)

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
