"""
Re-checking a data connection's already-synced rows after its accounts are mapped.

A mapping decision changes what the cross-account rules are *allowed to conclude* — but only for rows
ingested after it. Everything synced beforehand was judged with no such premise available, which is
precisely how a ledger ends up holding a Plaid copy of every Monarch transaction. The re-scan re-judges
those rows under the mapping now in force.

Two properties matter more than the happy path, and both are load-bearing:

  self-exclusion   Every row is compared against the ledger MINUS the connection's own cards. Without
                   that, each row's own content hash is sitting in the candidate set and every single
                   row rejects itself.
  no mutual kills  Excluding the whole set, rather than just "self", is what stops two rows from the
                   same connection rejecting *each other* — which would trash both copies of a
                   transaction that has exactly one duplicate.

Removals are reversible by construction: the row is trashed with its audit pointer intact, not deleted,
so its category and edits survive and Restore brings it back whole.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import connections as connections_router
from backend.routers import sync as sync_module
from backend.services.connection_dedupe import RESCAN_RESOLVED_BY, rescan_connection_duplicates
from backend.services.duplicate_detection import list_unified_batch_duplicates
from backend.tests._fake_adapter import FakeCursorAdapter


class _FrozenDate(date):
    _today = date(2026, 8, 10)

    @classmethod
    def today(cls):
        return cls._today


class _Adapter(FakeCursorAdapter):
    """One batch of `added` rows, delivered on the first call and never again."""

    def __init__(self, added):
        super().__init__()
        self._added = added

    def fetch_transactions_sync(self, app_config, credential, *, cursor=None, days_requested=730,
                                account_targets=None, **kwargs):
        added, self._added = self._added, []
        return {**super().fetch_transactions_sync(app_config, credential, cursor=cursor,
                                                  days_requested=days_requested,
                                                  account_targets=account_targets, **kwargs),
                "added": added, "next_cursor": "c1"}


class ConnectionRescanTests(unittest.TestCase):
    CSV_ACCOUNT = "acct-csv"
    PLAID_ACCOUNT = "acct-plaid"
    EXTERNAL = "ext-card"

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rescan.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-1','plaid','item-1','','Northgate')"
            )
            for acct, name in ((self.CSV_ACCOUNT, "Northgate Voyager"), (self.PLAID_ACCOUNT, "CREDIT CARD")):
                conn.execute(
                    "INSERT INTO account (id, name, display_name, type, owner_id) VALUES (?,?,?, 'credit', ?)",
                    (acct, name, name, SHARED_OWNER_ID),
                )
            conn.execute(
                "UPDATE account SET external_account_id = ?, connection_id = 'conn-1', provider = 'plaid' WHERE id = ?",
                (self.EXTERNAL, self.PLAID_ACCOUNT),
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

    # ---- fixtures ------------------------------------------------------

    def _csv_batch(self, rows, *, account_id=None, coverage=("2024-03-18", "2026-07-26"),
                   terminal="2026-07-27"):
        """A completed Monarch-style CSV import, by default into the SAME account the connection feeds.

        That is the end state of mapping a provider account onto an account already holding file
        history — the thing the mapping step exists to let a user say. Coverage then applies
        same-account, which needs no alias at all: the rule only requires the coverage entry to be for
        the receiving account and to have come from a different source label.
        """
        account_id = account_id or self.PLAID_ACCOUNT
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, status) VALUES ('b-csv','Monarch.csv','completed')"
            )
            conn.execute(
                "INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count, was_skipped,"
                " coverage_start_date, coverage_end_date, terminal_date) VALUES"
                " ('b-csv','CREDIT CARD (...4103)',?,?,0,?,?,?)",
                (account_id, len(rows), coverage[0], coverage[1], terminal),
            )
            for i, (day, amount, text) in enumerate(rows):
                conn.execute(
                    "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,"
                    " raw_name, date, is_pending, content_hash, import_batch_id, import_evidence_json)"
                    " VALUES (?,?,?,?,?,?,?,?,0,?, 'b-csv', ?)",
                    (f"csv-{i}", account_id, SHARED_OWNER_ID, amount, text, text, text, day,
                     f"csvhash-{i}",
                     json.dumps({"account": {"header": "Account", "value": "CREDIT CARD (...4103)"}})),
                )

    def _map(self, mode, target=None, account_id=None):
        with self._db() as conn:
            conn.execute(
                """
                INSERT INTO connection_account
                  (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                   provider_name, provider_mask)
                VALUES ('conn-1', ?, ?, ?, ?, 'CREDIT CARD', '4103')
                ON CONFLICT(connection_id, external_account_id) DO UPDATE SET
                   account_id = excluded.account_id, mapping_mode = excluded.mapping_mode,
                   target_account_id = excluded.target_account_id
                """,
                (self.EXTERNAL, account_id or self.PLAID_ACCOUNT, mode, target),
            )

    def _sync(self, added, days=0):
        """Sync BEFORE any mapping exists — the state every already-connected ledger is in."""
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        adapter = _Adapter(added)
        token = set_current_db_path(str(self.db_path))
        try:
            with mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                 mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                 mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x"}), \
                 mock.patch.object(sync_module, "get_adapter", return_value=adapter), \
                 mock.patch.object(sync_module, "date", _FrozenDate):
                return sync_module.run_sync(days=days, connection_id="conn-1", request=request)
        finally:
            reset_current_db_path(token)

    def _synced(self, txn_id, day, amount, merchant, raw, authorized_date=None):
        return {
            "external_transaction_id": txn_id,
            "external_account_id": self.EXTERNAL,
            "amount": amount,
            "merchant_name": merchant,
            "raw_name": raw,
            "date": day,
            "authorized_date": authorized_date,
            "is_pending": False,
        }

    def _rescan(self):
        """The pass itself, driven at the service. Applying a mapping is its only caller (asserted
        below), so the tests that pin the pass's properties call it directly rather than through the
        one endpoint that happens to reach it."""
        with self._db() as conn:
            connection = conn.execute("SELECT * FROM connection WHERE id = 'conn-1'").fetchone()
            return rescan_connection_duplicates(conn, connection)

    def _txn(self, txn_id):
        with self._db() as conn:
            return dict(conn.execute("SELECT * FROM txn WHERE id = ?", (txn_id,)).fetchone())

    def _live_synced_rows(self):
        """The connection's own rows still in the ledger. Scoped to its cards rather than to an
        account, because the file and the connection now feed the same one."""
        with self._db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT t.* FROM txn t JOIN import_batch b ON b.id = t.import_batch_id"
                " WHERE b.connection_id = 'conn-1' AND t.trashed_at IS NULL ORDER BY t.date, t.id"
            ).fetchall()]

    def _synced_row_ids(self):
        with self._db() as conn:
            return [r["id"] for r in conn.execute(
                "SELECT t.id FROM txn t JOIN import_batch b ON b.id = t.import_batch_id"
                " WHERE b.connection_id = 'conn-1' ORDER BY t.date, t.id"
            ).fetchall()]

    # ---- the case the re-scan exists for -------------------------------

    def test_a_row_synced_before_the_mapping_is_confirmed_afterwards(self):
        # The whole point. The Northgate payment has zero text overlap with its CSV twin, so only coverage
        # can catch it — and coverage needs the mapping, which did not exist when the row arrived.
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self.assertEqual(self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])["added"], 1)
        self.assertEqual(len(self._live_synced_rows()), 1)

        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)
        result = self._rescan()

        self.assertEqual(result["hard_rejected"], 1)
        self.assertEqual(self._live_synced_rows(), [])

    def test_a_confirmed_row_is_trashed_not_deleted_and_keeps_what_the_user_did_to_it(self):
        # "Removed" must mean recoverable. The row keeps its category and its pointer to the copy that
        # survived, which is what makes the duplicate report able to show it and Restore able to undo.
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        synced_id = self._synced_row_ids()[0]
        with self._db() as conn:
            conn.execute("INSERT INTO category (id, name) VALUES ('cat-1','Bills')")
            conn.execute("UPDATE txn SET category_id = 'cat-1' WHERE id = ?", (synced_id,))

        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)
        self._rescan()

        row = self._txn(synced_id)
        self.assertIsNotNone(row["trashed_at"])
        self.assertEqual(row["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(row["dedupe_resolved_by"], RESCAN_RESOLVED_BY)
        self.assertEqual(row["suspect_duplicate_of"], "csv-0", "must point at the copy that survived")
        self.assertEqual(row["category_id"], "cat-1", "the user's categorization must survive the removal")

    def test_the_removal_shows_up_in_its_own_cards_duplicate_report(self):
        # The report is the recovery surface, so a re-scan removal has to be visible there — labelled
        # by the occasion (re-scan), not left as an unexplained "other".
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)
        self._rescan()

        with self._db() as conn:
            card_id = conn.execute(
                "SELECT id FROM import_batch WHERE connection_id = 'conn-1'"
            ).fetchone()["id"]
            entries = list_unified_batch_duplicates(conn, card_id)

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["rule_key"], "connection_rescan_confirmed")

    # ---- self-exclusion: the subtle part -------------------------------

    def test_a_row_never_matches_itself(self):
        # With no CSV row anywhere, the ONLY thing resembling each synced row is the row itself. If the
        # connection's own cards were in the candidate pool, every row would reject itself and the
        # re-scan would empty the ledger.
        self._sync([
            self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill"),
            self._synced("p2", "2026-07-14", -9.99, "Netflix", "NETFLIX.COM"),
        ])
        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)

        result = self._rescan()

        self.assertEqual(result["scanned"], 2)
        self.assertEqual(result["hard_rejected"], 0)
        self.assertEqual(len(self._live_synced_rows()), 2)

    def test_two_identical_rows_from_the_same_connection_do_not_reject_each_other(self):
        # Two genuinely identical charges the provider reported separately. Excluding only "self" would
        # let each match the other and trash BOTH — so the exclusion covers the whole connection.
        self._sync([
            self._synced("p1", "2026-07-13", -21.25, "Duplicate Charge", "DUPLICATE CHARGE"),
            self._synced("p2", "2026-07-13", -21.25, "Duplicate Charge", "DUPLICATE CHARGE"),
        ])
        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)

        result = self._rescan()

        self.assertEqual(result["hard_rejected"], 0)
        self.assertEqual(len(self._live_synced_rows()), 2)

    def test_running_it_twice_changes_nothing_the_second_time(self):
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)

        first = self._rescan()
        second = self._rescan()

        self.assertEqual(first["hard_rejected"], 1)
        self.assertEqual(second["hard_rejected"], 0)
        self.assertEqual(second["scanned"], 0, "the row it removed is no longer a candidate")
        self.assertEqual(second["promoted"], 0)

    # ---- what it must not touch ----------------------------------------

    def test_a_row_the_user_already_ruled_on_is_left_alone(self):
        # A re-scan makes decisions where none were made. It never re-opens one the user made.
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        synced_id = self._synced_row_ids()[0]
        with self._db() as conn:
            conn.execute(
                "UPDATE txn SET suspect_resolved_at = '2026-08-01T00:00:00Z' WHERE id = ?", (synced_id,)
            )

        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)
        result = self._rescan()

        self.assertEqual(result["scanned"], 0)
        self.assertIsNone(self._txn(synced_id)["trashed_at"])

    def test_an_unmapped_connection_scans_nothing(self):
        # No mapping means no premise for any cross-account conclusion — the same reason these rows
        # imported in the first place. The re-scan must not invent one.
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])

        result = self._rescan()

        self.assertEqual(result["scanned"], 0)
        self.assertEqual(result["hard_rejected"], 0)
        self.assertEqual(len(self._live_synced_rows()), 1)

    def test_rows_stranded_by_a_remapped_account_are_reported_not_silently_skipped(self):
        # Re-pointing an 'existing' mapping at a different local account moves the provider handle but
        # not the history already synced under the old one. Those rows are outside the mapping, so the
        # ladder has nothing to judge them against — they are counted so the number is visible rather
        # than the rows quietly ignored. Moving them is an account merge, a separate deliberate act.
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        self._map("existing", target=self.CSV_ACCOUNT, account_id=self.CSV_ACCOUNT)

        result = self._rescan()

        self.assertEqual(result["stranded"], 1)
        self.assertEqual(result["scanned"], 0)
        self.assertIsNone(self._txn(self._synced_row_ids()[0])["trashed_at"])

    # ---- the mapping step drives it ------------------------------------

    def test_applying_a_mapping_triggers_the_rescan(self):
        # A mapping decision that changes nothing to compare against is worth nothing until the rows
        # already in the ledger are re-judged, so the mapping call runs it rather than making the user
        # find a second button.
        self._csv_batch([("2026-07-13", -21.25, "Northgate")])
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        with self._db() as conn:
            conn.execute(
                "INSERT INTO connection_account (connection_id, external_account_id, provider_name, provider_mask)"
                " VALUES ('conn-1', ?, 'CREDIT CARD', '4103')",
                (self.EXTERNAL,),
            )

        token = set_current_db_path(str(self.db_path))
        try:
            body = connections_router.AccountMappingRequest(mappings={
                self.EXTERNAL: connections_router.AccountMappingChoice(
                    mode="existing", target_account_id=self.PLAID_ACCOUNT,
                ),
            })
            result = connections_router.set_connection_account_map("conn-1", body)
        finally:
            reset_current_db_path(token)

        self.assertTrue(result["changed"])
        self.assertIsNotNone(result["rescan"])
        self.assertEqual(result["rescan"]["hard_rejected"], 1)

    def test_an_unchanged_mapping_does_not_rescan(self):
        # Re-saving the same decisions is a no-op, and must stay one: re-running detection on every
        # dialog save would make an idempotent call quietly expensive.
        self._map("existing", target=self.PLAID_ACCOUNT, account_id=self.PLAID_ACCOUNT)

        token = set_current_db_path(str(self.db_path))
        try:
            body = connections_router.AccountMappingRequest(mappings={
                self.EXTERNAL: connections_router.AccountMappingChoice(
                    mode="existing", target_account_id=self.PLAID_ACCOUNT,
                ),
            })
            result = connections_router.set_connection_account_map("conn-1", body)
        finally:
            reset_current_db_path(token)

        self.assertFalse(result["changed"])
        self.assertIsNone(result["rescan"])


if __name__ == "__main__":
    unittest.main()
