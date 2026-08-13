"""
Data-source sync → cursor-based /transactions/sync, import cards, and cross-source dedup.

A sync uses the provider's cursor API: each call pulls added/modified/removed changes since a stored
per-connection cursor and reports the historical-backfill readiness (`update_status`). The first
(historical) pull lands on one "initial import" card; routine top-up syncs accrete onto monthly period
cards (source_kind='connection_sync'). These tests pin the card structure, the cursor/readiness
lifecycle, added/modified/removed handling, the fetch-depth window, connection scoping, and the
cross-source duplicate detection that rides the sync insert path.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import accounts as accounts_module
from backend.routers import sync as sync_module
from backend.routers import providers as providers_module

from backend.tests._fake_adapter import DONE as _DONE, FakeCursorAdapter as _FakeAdapter
from backend.services.source_capabilities import KEEP_ZERO_AMOUNT, REJECT_ZERO_AMOUNT


class SyncPeriodCardTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "sync-cards.db"
        init_db(str(self.db_path))
        self.connection_id = "conn-1"
        self.external_account_id = "acct-ext-1"
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES (?, 'plaid', 'item-1', '', 'Example Bank')",
                (self.connection_id,),
            )
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES ('a1', ?, ?, 'plaid', 'Joint Checking', 'Joint Checking', 'depository', 'checking',
                        '1188', ?, NULL, NULL)
                """,
                (self.external_account_id, self.connection_id, SHARED_OWNER_ID),
            )
            # Sync resolves rows through the connection's account mapping (Part A), so the fixture
            # states it explicitly: this provider account IS account a1.
            conn.execute(
                """
                INSERT INTO connection_account
                  (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                   provider_name, provider_mask)
                VALUES (?, ?, 'a1', 'existing', 'a1', 'Joint Checking', '1188')
                """,
                (self.connection_id, self.external_account_id),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _txn(self, txn_id, amount, name, day="2026-08-10", pending=False):
        return {
            "external_transaction_id": txn_id,
            "external_account_id": self.external_account_id,
            "amount": amount,
            "merchant_name": name,
            "raw_name": name,
            "date": day,
            "is_pending": pending,
        }

    def _complete_initial(self):
        """Flip the connection past its historical backfill so a following sync uses monthly cards."""
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET initial_sync_complete = 1, transactions_cursor = 'c0' WHERE id = ?",
                (self.connection_id,),
            )

    @contextmanager
    def _driven_sync(self, added=None, on_date="2026-08-10", *, days=0, connection_id=None, adapter=None,
                     pages=None, full_history=False):
        """Run run_sync with the provider seam mocked and the clock pinned. Pass `added` for a single
        terminal page, `pages` for a scripted multi-page/multi-status sequence, or `adapter` to inspect it."""
        if adapter is None:
            if pages is None:
                pages = [{"added": added or [], "has_more": False, "update_status": _DONE}]
            adapter = _FakeAdapter(pages=pages)
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x", "secret": "y"}), \
                mock.patch.object(sync_module, "get_adapter", return_value=adapter), \
                mock.patch.object(sync_module, "date", _FrozenDate(on_date)):
            yield sync_module.run_sync(days=days, connection_id=connection_id, request=request,
                                       full_history=full_history)

    def _cards(self):
        with self._use_db_path(), get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT id, filename, source_kind, connection_id, row_count, config_snapshot "
                "FROM import_batch WHERE source_kind = 'connection_sync' ORDER BY filename"
            ).fetchall()]

    def _connection(self):
        with self._use_db_path(), get_db() as conn:
            return dict(conn.execute(
                "SELECT transactions_cursor, initial_sync_complete, last_synced_at, last_sync_error, "
                "last_sync_error_at, consecutive_sync_failures, last_sync_warnings "
                "FROM connection WHERE id = ?",
                (self.connection_id,),
            ).fetchone())

    # ---- card structure -------------------------------------------------

    def test_initial_sync_creates_single_initial_card_and_stamps_rows(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee"), self._txn("t2", -20.0, "Lunch")]) as res:
            self.assertEqual(res["added"], 2)
            self.assertTrue(res["historical_complete"])
        cards = self._cards()
        self.assertEqual(len(cards), 1)
        self.assertIn("Initial import", cards[0]["filename"])
        self.assertEqual(cards[0]["row_count"], 2)
        conn_row = self._connection()
        self.assertEqual(conn_row["initial_sync_complete"], 1)
        self.assertIsNotNone(conn_row["transactions_cursor"])
        with self._use_db_path(), get_db() as conn:
            stamped = conn.execute(
                "SELECT COUNT(*) n FROM txn WHERE import_batch_id = ?", (cards[0]["id"],)
            ).fetchone()["n"]
            self.assertEqual(stamped, 2)

    def test_initial_backfill_polls_to_completion_on_one_card(self):
        # First poll: only the initial (30-day) pull is ready → rows land, but the connection stays "initial".
        with self._driven_sync(pages=[{
            "added": [self._txn("t1", -10.0, "Coffee")], "update_status": "INITIAL_UPDATE_COMPLETE",
        }]) as res:
            self.assertFalse(res["historical_complete"])
            self.assertEqual(res["update_status"], "INITIAL_UPDATE_COMPLETE")
        self.assertEqual(self._connection()["initial_sync_complete"], 0)
        # Second poll: backfill done → more rows on the SAME initial card, connection flips complete.
        with self._driven_sync(pages=[{"added": [self._txn("t2", -20.0, "Lunch")], "update_status": _DONE}]) as res:
            self.assertTrue(res["historical_complete"])
        cards = self._cards()
        self.assertEqual(len(cards), 1, "the whole backfill stays on one initial card across polls")
        self.assertIn("Initial import", cards[0]["filename"])
        self.assertEqual(cards[0]["row_count"], 2)
        self.assertEqual(self._connection()["initial_sync_complete"], 1)

    def test_routine_sync_after_initial_uses_monthly_card(self):
        self._complete_initial()
        with self._driven_sync([self._txn("t9", -5.0, "Snack", day="2026-08-15")], "2026-08-15") as res:
            self.assertEqual(res["added"], 1)
        cards = self._cards()
        self.assertEqual(len(cards), 1)
        self.assertIn("August 2026", cards[0]["filename"])

    def test_refetch_with_no_new_rows_creates_no_extra_card(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")]):
            pass
        # Re-serving the same id: idempotent skip, and (now a routine sync) no empty monthly card appears.
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")]) as res:
            self.assertEqual(res["added"], 0)
        cards = self._cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["row_count"], 1)

    def test_deleting_the_synced_account_takes_the_emptied_card_with_it(self):
        # The card resolvers key on (connection, backfill/period) without regard to row count, so a card
        # left at zero rows is not inert — the next backfill reuses it. And once the connection is
        # disconnected (`connection_id` is ON DELETE SET NULL) nothing that keys on the connection can
        # reach it, leaving an unremovable empty card on Import/Export. A CSV card is the deliberate
        # exception: it records a file, which stays true after its rows are gone.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, status, row_count) "
                "VALUES ('csv-1', 'statement.csv', 'completed', 1)"
            )
        with self._driven_sync([self._txn("t1", -10.0, "Coffee"), self._txn("t2", -20.0, "Lunch")]) as res:
            self.assertEqual(res["added"], 2)
        # One of the two rows re-filed onto the CSV card, so both cards hold a row on the same account
        # and the deletion below empties them together.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET import_batch_id = 'csv-1' WHERE external_transaction_id = 't2'"
            )
            csv_rows = conn.execute("SELECT COUNT(*) n FROM txn WHERE import_batch_id = 'csv-1'").fetchone()["n"]
        self.assertEqual(csv_rows, 1)  # the fixture is only meaningful if the CSV card really holds a row
        self.assertEqual(len(self._cards()), 1)

        with self._use_db_path():
            accounts_module.delete_account("a1")

        self.assertEqual(self._cards(), [])
        with self._use_db_path(), get_db() as conn:
            surviving = [r["id"] for r in conn.execute("SELECT id FROM import_batch").fetchall()]
        self.assertEqual(surviving, ["csv-1"])

    # ---- cursor / paging / readiness ------------------------------------

    def test_paging_drains_has_more_in_one_call(self):
        pages = [
            {"added": [self._txn("t1", -1.0, "A")], "has_more": True, "update_status": "NOT_READY"},
            {"added": [self._txn("t2", -2.0, "B")], "has_more": True, "update_status": "INITIAL_UPDATE_COMPLETE"},
            {"added": [self._txn("t3", -3.0, "C")], "has_more": False, "update_status": _DONE},
        ]
        with self._driven_sync(pages=pages) as res:
            self.assertEqual(res["added"], 3)
            self.assertTrue(res["historical_complete"])
        self.assertEqual(self._cards()[0]["row_count"], 3)

    def test_cursor_is_persisted_and_sent_back(self):
        adapter = _FakeAdapter(pages=[{"added": [self._txn("t1", -1.0, "A")], "next_cursor": "cur-XYZ"}])
        with self._driven_sync(adapter=adapter):
            pass
        self.assertEqual(self._connection()["transactions_cursor"], "cur-XYZ")
        adapter2 = _FakeAdapter(pages=[{}])
        with self._driven_sync(adapter=adapter2):
            pass
        self.assertEqual(adapter2.calls[0]["cursor"], "cur-XYZ", "the stored cursor is sent on the next sync")

    # ---- modified / removed ---------------------------------------------

    def test_modified_updates_provider_fields_preserving_name_edit(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")]):
            pass
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET display_name = 'My Coffee', display_name_source = 'manual' "
                "WHERE external_transaction_id = 't1'"
            )
        with self._driven_sync(pages=[{"modified": [self._txn("t1", -12.5, "Coffee Shop")]}]) as res:
            self.assertEqual(res["updated"], 1)
        with self._use_db_path(), get_db() as conn:
            r = conn.execute(
                "SELECT amount, merchant_name, display_name FROM txn WHERE external_transaction_id = 't1'"
            ).fetchone()
        self.assertEqual(r["amount"], -12.5)                # provider field refreshed
        self.assertEqual(r["merchant_name"], "Coffee Shop")
        self.assertEqual(r["display_name"], "My Coffee")    # user rename preserved

    def test_removed_trashes_the_row(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")]):
            pass
        with self._driven_sync(pages=[{"removed": ["t1"]}]) as res:
            self.assertEqual(res["removed"], 1)
        with self._use_db_path(), get_db() as conn:
            self.assertIsNotNone(
                conn.execute("SELECT trashed_at FROM txn WHERE external_transaction_id = 't1'").fetchone()["trashed_at"]
            )

    def test_pending_transaction_posts_in_place_preserving_edits(self):
        # A pending row lands and the user renames it.
        with self._driven_sync([self._txn("pend-1", -10.0, "Coffee", pending=True)]) as res:
            self.assertEqual(res["added"], 1)
        with self._use_db_path(), get_db() as conn:
            pk = conn.execute("SELECT id FROM txn WHERE external_transaction_id = 'pend-1'").fetchone()["id"]
            conn.execute(
                "UPDATE txn SET display_name = 'My Coffee', display_name_source = 'manual' WHERE id = ?", (pk,)
            )
        # It posts: the posted txn (new id, references the pending via pending_external_transaction_id) arrives
        # in a later page than the pending's `removed` — the drain-then-process order must still convert in
        # place, not trash-then-add.
        posted = self._txn("posted-1", -10.5, "Coffee Shop", pending=False)
        posted["pending_external_transaction_id"] = "pend-1"
        with self._driven_sync(pages=[
            {"removed": ["pend-1"], "has_more": True, "update_status": "NOT_READY"},
            {"added": [posted], "has_more": False, "update_status": _DONE},
        ]) as res:
            self.assertEqual(res["updated"], 1)
            self.assertEqual(res["added"], 0)
            self.assertEqual(res["removed"], 0, "the pending's removed is a no-op once converted in place")
        with self._use_db_path(), get_db() as conn:
            row = conn.execute(
                "SELECT external_transaction_id, amount, is_pending, display_name, trashed_at FROM txn WHERE id = ?",
                (pk,),
            ).fetchone()
            self.assertEqual(row["external_transaction_id"], "posted-1")   # same row, now the posted id
            self.assertEqual(row["amount"], -10.5)
            self.assertEqual(row["is_pending"], 0)
            self.assertEqual(row["display_name"], "My Coffee")          # user rename preserved
            self.assertIsNone(row["trashed_at"])
            total = conn.execute(
                "SELECT COUNT(*) c FROM txn WHERE external_transaction_id IN ('pend-1', 'posted-1')"
            ).fetchone()["c"]
            self.assertEqual(total, 1, "no duplicate row for the posted transaction")

    def test_a_pending_row_resent_under_its_own_id_re_dates_rather_than_only_unflagging(self):
        # The other shape of pending→posted, and the one a provider with no pending pointer produces: the
        # settled charge comes back as the *same* transaction id, so it lands on the already-held branch
        # rather than the in-place conversion above. That branch used to flip `is_pending` and nothing else,
        # which is invisible until the two versions disagree about something — and they always do about the
        # date, since a pending charge has no posted date to report and is filed under when it happened.
        with self._driven_sync([self._txn("s1", -20.24, "Bakeshop", day="2026-08-11", pending=True)]) as res:
            self.assertEqual(res["added"], 1)
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET display_name = 'My Bakery', display_name_source = 'manual' "
                "WHERE external_transaction_id = 's1'"
            )
            before = conn.execute("SELECT content_hash FROM txn WHERE external_transaction_id = 's1'").fetchone()
        settled = self._txn("s1", -21.00, "Bakeshop", day="2026-08-13", pending=False)
        with self._driven_sync([settled], on_date="2026-08-13") as res:
            self.assertEqual(res["added"], 0, "the same id is not a second transaction")
            self.assertEqual(res["updated"], 1)
        with self._use_db_path(), get_db() as conn:
            row = conn.execute(
                "SELECT date, amount, is_pending, display_name, content_hash FROM txn "
                "WHERE external_transaction_id = 's1'"
            ).fetchone()
        self.assertEqual(row["date"], "2026-08-13")     # the posted date now that there is one
        self.assertEqual(row["amount"], -21.00)         # a pending amount can be an estimate
        self.assertEqual(row["is_pending"], 0)
        self.assertEqual(row["display_name"], "My Bakery")  # user rename preserved
        self.assertNotEqual(row["content_hash"], before["content_hash"],
                            "the hash is derived from the date and must not keep describing the pending row")

    def test_a_zero_amount_row_is_kept_so_its_settlement_has_somewhere_to_land(self):
        # Why sync must NOT filter $0 rows, even though CSV import rejects them (core.py, and the
        # zero-amount invariant in the sync module docstring — read it before "cleaning this up").
        # A source often publishes a pending charge before it carries an amount; the settled amount
        # arrives later keyed on the provider transaction id. `_apply_modified` ignores a revision for
        # a row it does not hold, so filtering the placeholder does not delay the transaction — it
        # discards it. The two halves are asserted together because either alone reads as arbitrary.
        with self._driven_sync([self._txn("auth-1", 0.0, "Fuel Stop")]) as res:
            self.assertEqual(res["added"], 1,
                             "a $0 row must import: filtering it here leaves the later settlement with "
                             "no row to update, which drops the charge entirely (see sync.py docstring)")

        with self._driven_sync(pages=[{"modified": [self._txn("auth-1", -41.80, "Fuel Stop")]}]) as res:
            self.assertEqual(res["updated"], 1)
        with self._use_db_path(), get_db() as conn:
            rows = [dict(r) for r in conn.execute(
                "SELECT amount FROM txn WHERE external_transaction_id = 'auth-1' AND trashed_at IS NULL")]
        self.assertEqual([r["amount"] for r in rows], [-41.80],
                         "the settlement must land on the placeholder as one row carrying the real "
                         "amount — not a second row, and not a $0 row left behind")

    def test_the_adapters_declared_policy_is_what_decides_not_the_sync_path(self):
        # The same row, the same code path, opposite outcomes — so the behaviour is demonstrably driven by
        # the declaration rather than by anything hardcoded about $0 in `_insert_added`.
        rejecting = _FakeAdapter(pages=[{"added": [self._txn("auth-1", 0.0, "Fuel Stop")]}])
        rejecting.zero_amount_rows = REJECT_ZERO_AMOUNT
        with self._driven_sync(adapter=rejecting) as res:
            self.assertEqual(res["added"], 0)
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) c FROM txn WHERE external_transaction_id = 'auth-1'").fetchone()["c"], 0)

        keeping = _FakeAdapter(pages=[{"added": [self._txn("auth-2", 0.0, "Fuel Stop")]}])
        keeping.zero_amount_rows = KEEP_ZERO_AMOUNT
        with self._driven_sync(adapter=keeping) as res:
            self.assertEqual(res["added"], 1)

    def test_a_refused_row_is_reported_on_the_card_and_accumulates_across_syncs(self):
        # A rejected row the user cannot see is indistinguishable from a bug, so it lands on the card's
        # rejected report exactly as a CSV's would. The second sync is the point: a period card is added
        # to all month, and a summary that overwrote would report only the latest sync's refusals.
        # Past the backfill, so both syncs file onto the same monthly period card and the accumulation
        # being tested is a real one rather than two rows landing on two different cards.
        self._complete_initial()
        for txn_id in ("auth-1", "auth-2"):
            adapter = _FakeAdapter(pages=[{"added": [self._txn(txn_id, 0.0, "Fuel Stop")]}])
            adapter.zero_amount_rows = REJECT_ZERO_AMOUNT
            with self._driven_sync(adapter=adapter):
                pass

        cards = self._cards()
        self.assertEqual(len(cards), 1, "both refusals belong on the one period card for their month")
        summary = json.loads(cards[0]["config_snapshot"] or "{}")["import_summary"]
        self.assertEqual(summary["zero_amount_count"], 2, "the second sync's refusal overwrote the first")
        self.assertEqual(summary["rejected_count"], 2)
        self.assertEqual(len(summary["rejected_rows"]), 2)
        self.assertEqual(summary["rejected_headers"], ["Date", "Description", "Account", "Amount"])
        self.assertEqual(summary["rejected_rows"][0]["reason"], "Zero amount")

    def test_a_settlement_for_a_row_we_never_kept_is_lost_rather_than_imported(self):
        # The counterfactual that gives the test above its force, stated rather than implied: this is
        # exactly what a $0 filter on the insert path would cause. A revision naming a row we do not
        # hold is deliberately ignored — it is not an insert — so the charge never enters the ledger.
        with self._driven_sync(pages=[{"modified": [self._txn("never-held", -41.80, "Fuel Stop")]}]) as res:
            self.assertEqual(res["updated"], 0)
        with self._use_db_path(), get_db() as conn:
            held = conn.execute(
                "SELECT COUNT(*) c FROM txn WHERE external_transaction_id = 'never-held'").fetchone()["c"]
        self.assertEqual(held, 0,
                         "a revision cannot resurrect a row the sync declined to insert — which is why "
                         "the $0 placeholder is kept in the first place")

    # ---- sync health (what the collapsed connection card reports) --------

    def test_a_successful_sync_stamps_the_time_and_clears_any_failure_state(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET last_sync_error = 'boom', last_sync_error_at = '2026-08-01T00:00:00Z',"
                " consecutive_sync_failures = 3 WHERE id = ?", (self.connection_id,),
            )
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")]):
            pass
        row = self._connection()
        self.assertIsNotNone(row["last_synced_at"])
        self.assertIsNone(row["last_sync_error"], "one good pull settles whether it is still broken")
        self.assertIsNone(row["last_sync_error_at"])
        self.assertEqual(row["consecutive_sync_failures"], 0)

    def test_a_sync_that_finds_nothing_still_counts_as_synced(self):
        # The common case for a daily sync, and the one that makes last_synced_at worth storing at all:
        # nothing is inserted, so no import card is created, and any timestamp derived from cards would
        # report a connection that is working perfectly as weeks stale.
        with self._driven_sync([]):
            pass
        self.assertIsNotNone(self._connection()["last_synced_at"])
        self.assertEqual(self._cards(), [], "a no-op sync still leaves no empty card")

    def test_failures_accumulate_and_do_not_touch_the_last_synced_time(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")]):
            pass
        synced_at = self._connection()["last_synced_at"]

        adapter = _FakeAdapter()
        adapter.fetch_transactions_sync = mock.Mock(side_effect=RuntimeError("provider unavailable"))
        for expected in (1, 2, 3):
            with self._driven_sync(adapter=adapter):
                pass
            row = self._connection()
            self.assertEqual(row["consecutive_sync_failures"], expected)
        self.assertIn("provider unavailable", row["last_sync_error"])
        self.assertIsNotNone(row["last_sync_error_at"])
        # The point of the pair: last_synced_at is the freshness of the DATA, not the time of the last
        # attempt, so a failing connection reads as stale instead of looking recently synced.
        self.assertEqual(row["last_synced_at"], synced_at)

    def test_a_partial_provider_problem_is_recorded_without_failing_the_sync(self):
        # One institution on a multi-bank credential reporting a problem while the rest deliver: the pull
        # succeeds, so nothing else would ever tell the user that part of their data stopped arriving.
        adapter = _FakeAdapter(pages=[{
            "added": [self._txn("t1", -10.0, "Coffee")],
            "warnings": ["Other Bank: authentication required"],
        }])
        with self._driven_sync(adapter=adapter) as res:
            self.assertEqual(res["added"], 1)
            self.assertEqual(len(res["warned"]), 1)
            self.assertEqual(res["warned"][0]["warnings"], ["Other Bank: authentication required"])
        row = self._connection()
        self.assertEqual(json.loads(row["last_sync_warnings"]), ["Other Bank: authentication required"])
        self.assertEqual(row["consecutive_sync_failures"], 0, "a partial problem is not a failed sync")
        self.assertIsNotNone(row["last_synced_at"])

    def test_a_clean_sync_clears_a_previous_partial_problem(self):
        adapter = _FakeAdapter(pages=[{"warnings": ["Other Bank: authentication required"]}])
        with self._driven_sync(adapter=adapter):
            pass
        self.assertIsNotNone(self._connection()["last_sync_warnings"])
        with self._driven_sync([]):
            pass
        self.assertIsNone(self._connection()["last_sync_warnings"],
                          "a bank that starts working again must stop being reported, with nothing to dismiss")

    # ---- discovering accounts added on the provider's side ---------------

    def _txn_for(self, external_account_id, txn_id="n1", day="2026-08-10"):
        return {**self._txn(txn_id, -10.0, "New account charge", day=day),
                "external_account_id": external_account_id}

    def _connection_accounts(self):
        with self._use_db_path(), get_db() as conn:
            return {r["external_account_id"]: dict(r) for r in conn.execute(
                "SELECT external_account_id, mapping_mode, account_id FROM connection_account"
            )}

    def test_an_account_added_at_the_provider_is_recorded_when_its_data_arrives(self):
        # Sync never asks a provider what accounts it has, so without this an account added later is
        # invisible: its transactions match nothing, are skipped, and are dropped with no explanation.
        adapter = _FakeAdapter(
            pages=[{"added": [self._txn_for("acct-ext-2")]}],
            accounts=[{"external_account_id": "acct-ext-2", "name": "New Savings",
                       "official_name": "Some Bank", "type": None, "subtype": None, "mask": None}],
        )
        with self._driven_sync(adapter=adapter) as res:
            self.assertEqual(res["skipped"], 1, "nothing to map it to yet, so the row is still skipped")
            self.assertEqual(res["discovered"], 1)
        recorded = self._connection_accounts()
        self.assertIn("acct-ext-2", recorded)
        self.assertIsNone(recorded["acct-ext-2"]["mapping_mode"],
                          "discovery records the account; the mapping decision stays the user's")
        self.assertIsNone(recorded["acct-ext-2"]["account_id"],
                          "no local account is created — that is what the mapping step is for")

    def test_a_skipped_account_is_not_rediscovered_on_every_sync(self):
        # The guard is the connection_account row, not whether a local account exists. Those differ in
        # exactly this case, and keying off the account would re-fetch the provider's list forever.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection_account (connection_id, external_account_id, mapping_mode) "
                "VALUES (?, 'acct-ext-skipped', 'skip')", (self.connection_id,),
            )
        adapter = _FakeAdapter(pages=[{"added": [self._txn_for("acct-ext-skipped")]}])
        adapter.fetch_accounts = mock.Mock(return_value=[])
        with self._driven_sync(adapter=adapter) as res:
            self.assertEqual(res["skipped"], 1)
            self.assertEqual(res["discovered"], 0)
        adapter.fetch_accounts.assert_not_called()

    def test_a_sync_with_nothing_unfamiliar_never_asks_for_the_account_list(self):
        adapter = _FakeAdapter(pages=[{"added": [self._txn("t1", -10.0, "Coffee")]}])
        adapter.fetch_accounts = mock.Mock(return_value=[])
        with self._driven_sync(adapter=adapter):
            pass
        adapter.fetch_accounts.assert_not_called()

    # ---- fetch depth / scoping ------------------------------------------

    def test_all_history_uses_the_providers_own_cap(self):
        # days<=0 means "as far back as this provider goes", which is the adapter's published cap rather
        # than one number shared by every provider — Plaid's ~24 months is a Plaid fact.
        adapter = _FakeAdapter(pages=[{}])
        with self._driven_sync(adapter=adapter, days=0):
            pass
        self.assertEqual(adapter.calls[0]["days_requested"], adapter.max_history_days)

    def test_all_history_falls_back_to_the_global_depth_when_a_provider_publishes_no_cap(self):
        adapter = _FakeAdapter(pages=[{}])
        adapter.max_history_days = None
        with self._driven_sync(adapter=adapter, days=0):
            pass
        self.assertEqual(adapter.calls[0]["days_requested"], sync_module.ALL_HISTORY_DAYS)

    def test_positive_days_bounds_fetch_depth(self):
        adapter = _FakeAdapter(pages=[{}])
        with self._driven_sync(adapter=adapter, days=90):
            pass
        self.assertEqual(adapter.calls[0]["days_requested"], 90)

    def test_connection_id_scopes_the_sync(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-2', 'plaid', 'item-2', '', 'Other Bank')"
            )
        scoped = _FakeAdapter(pages=[{}])
        with self._driven_sync(adapter=scoped, connection_id=self.connection_id):
            pass
        self.assertEqual(len(scoped.calls), 1, "scoped sync fetches only the named connection")
        unscoped = _FakeAdapter(pages=[{}, {}])
        with self._driven_sync(adapter=unscoped):
            pass
        self.assertEqual(len(unscoped.calls), 2, "unscoped sync fetches every connection")

    # ---- cross-source dedup on the sync path ----------------------------

    def _seed_csv_row_on_other_account(self, *, account_id="a2", parent_id=None,
                                       amount=-10.0, name="Coffee", day="2026-08-10"):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, NULL, NULL, 'csv', 'CSV Checking', 'CSV Checking', 'depository', 'checking',
                        NULL, ?, ?, NULL)
                """,
                (account_id, SHARED_OWNER_ID, parent_id),
            )
            conn.execute(
                "INSERT INTO import_batch (id, filename, row_count, status) VALUES ('csvb', 'ledger.csv', 1, 'completed')"
            )
            conn.execute(
                """
                INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                                 date, import_batch_id)
                VALUES ('csv-txn', ?, ?, ?, ?, ?, ?, ?, 'csvb')
                """,
                (account_id, SHARED_OWNER_ID, amount, name, name, name, day),
            )

    def test_sync_soft_flags_a_cross_account_duplicate_on_its_card(self):
        self._seed_csv_row_on_other_account()
        with self._driven_sync([self._txn("t1", -10.0, "Coffee", day="2026-08-10")]) as res:
            self.assertEqual(res["added"], 1)
        with self._use_db_path(), get_db() as conn:
            synced = conn.execute(
                "SELECT suspect_duplicate_of, suspect_duplicate_reason, trashed_at "
                "FROM txn WHERE external_transaction_id = 't1'"
            ).fetchone()
            self.assertEqual(synced["suspect_duplicate_of"], "csv-txn")
            self.assertEqual(synced["suspect_duplicate_reason"], "cross_account")
            self.assertIsNone(synced["trashed_at"])

    def test_sync_into_already_merged_account_promotes_to_confirmed(self):
        self._seed_csv_row_on_other_account(account_id="a2", parent_id=None)
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE account SET parent_account_id = 'a2' WHERE id = 'a1'")
        with self._driven_sync([self._txn("t1", -10.0, "Coffee", day="2026-08-10")]):
            pass
        with self._use_db_path(), get_db() as conn:
            synced = conn.execute(
                "SELECT rejection_reason, dedupe_resolved_by, trashed_at, suspect_duplicate_of "
                "FROM txn WHERE external_transaction_id = 't1'"
            ).fetchone()
            self.assertEqual(synced["rejection_reason"], "duplicate_confirmed")
            self.assertEqual(synced["dedupe_resolved_by"], "auto_merge")
            self.assertIsNotNone(synced["trashed_at"])
            self.assertEqual(synced["suspect_duplicate_of"], "csv-txn")

    def test_synced_rows_get_a_content_hash(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")]):
            pass
        with self._use_db_path(), get_db() as conn:
            h = conn.execute("SELECT content_hash FROM txn WHERE external_transaction_id = 't1'").fetchone()["content_hash"]
            self.assertTrue(h)


class RefreshAccountsTests(unittest.TestCase):
    """POST /providers/{provider}/refresh-accounts rebuilds account rows from an existing connection's
    still-valid credential — the recovery when a restore rolls back the ledger but keeps the connection."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "refresh.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-1', 'plaid', 'item-1', '', 'Cambridge Savings Bank')"
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _refresh(self, request, fake):
        with self._use_db_path(), \
                mock.patch("backend.routers.providers.resolve_app_config", return_value={"client_id": "x"}), \
                mock.patch.object(providers_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch("backend.routers.providers.get_adapter", return_value=fake):
            return providers_module.refresh_accounts(
                "plaid", providers_module.RefreshAccountsRequest(external_id="item-1"), request
            )

    def test_refresh_records_provider_accounts_without_mapping_them(self):
        # Refresh discovers what the bank offers; it does not decide what any of them *is* locally.
        # An account nobody has mapped stays unmapped rather than silently becoming a new account.
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        fake = _FakeAdapter(accounts=[
            {"external_account_id": "acct-ext-1", "name": "Joint Checking",
             "type": "depository", "subtype": "checking", "mask": "1188"},
        ])
        self._refresh(request, fake)
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 0)
            row = conn.execute(
                "SELECT mapping_mode, provider_mask FROM connection_account WHERE external_account_id = 'acct-ext-1'"
            ).fetchone()
        self.assertIsNotNone(row, "the provider account must be recorded for the mapping step")
        self.assertIsNone(row["mapping_mode"])
        self.assertEqual(row["provider_mask"], "1188")

    def test_refresh_recreates_missing_accounts_from_the_connection(self):
        # The recovery case: a restore rolls the ledger back — accounts included — but never the live
        # connection. The *mapping* survives (it rides the data backup) with its account_id nulled,
        # which is what lets refresh rebuild the account from the still-valid credential, no re-link.
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection_account (connection_id, external_account_id, mapping_mode, "
                "provider_name, provider_mask) VALUES ('conn-1', 'acct-ext-1', 'new', 'Joint Checking', '1188')"
            )
        fake = _FakeAdapter(accounts=[
            {"external_account_id": "acct-ext-1", "name": "Joint Checking",
             "type": "depository", "subtype": "checking", "mask": "1188"},
        ])
        with self._use_db_path(), \
                mock.patch("backend.routers.providers.resolve_app_config", return_value={"client_id": "x"}), \
                mock.patch.object(providers_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch("backend.routers.providers.get_adapter", return_value=fake):
            res = providers_module.refresh_accounts(
                "plaid", providers_module.RefreshAccountsRequest(external_id="item-1"), request
            )
        self.assertEqual(res["accounts_added"], 1)
        self.assertEqual(res["connection_id"], "conn-1")
        with self._use_db_path(), get_db() as conn:
            acc = conn.execute(
                "SELECT connection_id, provider, name FROM account WHERE external_account_id = 'acct-ext-1'"
            ).fetchone()
        self.assertIsNotNone(acc, "refresh must recreate the account row")
        self.assertEqual(acc["connection_id"], "conn-1")
        self.assertEqual(acc["provider"], "plaid")

    def test_refresh_unknown_connection_is_404(self):
        from fastapi import HTTPException
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), self.assertRaises(HTTPException) as ctx:
            providers_module.refresh_accounts(
                "plaid", providers_module.RefreshAccountsRequest(external_id="does-not-exist"), request
            )
        self.assertEqual(ctx.exception.status_code, 404)


class _FrozenDate:
    """A stand-in for the `date` name inside sync.py that pins `date.today()`."""

    def __init__(self, iso):
        from datetime import date as _date
        self._today = _date.fromisoformat(iso)

    def today(self):
        return self._today


if __name__ == "__main__":
    unittest.main()
