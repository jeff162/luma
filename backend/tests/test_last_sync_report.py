"""
The connection card's "review what just arrived" report — what a sync records so its own rows can be
listed, and what reaches the client.

The report exists because a synced row's only lasting provenance is its import card, and a card is
per-(connection, calendar month): it accretes across every sync of that month, so filtering by it can
never answer "what did *this* pull bring". The rows a pull touched are known only while it runs, so the
sync now stores them — capped — on `connection.last_sync_summary`.

Three properties are pinned here, and each one is a mistake this design is deliberately avoiding.

**The ids never reach the client.** They back a report served by connection id, and the query expands the
list server-side. Publishing them instead would put kilobytes on `GET /api/providers`, which is *polled*
for the duration of every sync, for every connection, whether or not anyone opens the report.

**Past the cap the list is dropped whole, not truncated.** A partial list is a report that lies about its
own extent. The fallback — the card itself — is the better report at that size anyway, since the only
pull that exceeds the cap is a first backfill and a backfill already has one dedicated card.

**Every missing case collapses to zero rows rather than to the unfiltered set.** No summary, an older
summary written before this existed, a dropped list, a connection that has never synced: a scope that
silently widens to the whole card would misreport the pull, which is precisely what the report is for.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.routers.transactions import list_transactions
from backend.services.providers import config as provider_config

from backend.tests._fake_adapter import DONE as _DONE, FakeCursorAdapter as _FakeAdapter


class _FrozenDate(sync_module.date):
    """Pins `date.today()` inside the sync module; everything else on `date` behaves normally."""
    _today = "2026-08-10"

    @classmethod
    def today(cls):
        return sync_module.date.fromisoformat(cls._today)


class LastSyncReportTests(unittest.TestCase):
    CONNECTION_ID = "conn-report-1"
    EXTERNAL_ACCOUNT_ID = "acct-ext-report-1"

    def setUp(self):
        # Pinned rather than assumed, for the same reason the sync-log tests pin it: importing
        # `backend.main` anywhere in the session runs `load_dotenv()`, so a developer's own flag would
        # otherwise decide what these tests exercise.
        self._env = mock.patch.dict(os.environ, {"LUMA_DEVELOPER_OPTIONS": ""})
        self._env.start()
        self.addCleanup(self._env.stop)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = Path(self.tempdir.name) / "last-sync-report.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES (?, 'plaid', 'item-report-1', '', 'Example Bank')",
                (self.CONNECTION_ID,),
            )
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES ('a1', ?, ?, 'plaid', 'Everyday', 'Everyday', 'depository', 'checking',
                        '0000', ?, NULL, NULL)
                """,
                (self.EXTERNAL_ACCOUNT_ID, self.CONNECTION_ID, SHARED_OWNER_ID),
            )
            conn.execute(
                """
                INSERT INTO connection_account
                  (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                   provider_name, provider_mask)
                VALUES (?, ?, 'a1', 'existing', 'a1', 'Everyday', '0000')
                """,
                (self.CONNECTION_ID, self.EXTERNAL_ACCOUNT_ID),
            )

    # ---- harness ---------------------------------------------------------

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    @contextmanager
    def _driven_sync(self, *, pages):
        """`run_sync` with the provider seam mocked and the clock pinned."""
        adapter = _FakeAdapter(pages=pages)
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x", "secret": "y"}), \
                mock.patch.object(sync_module, "get_adapter", return_value=adapter), \
                mock.patch.object(sync_module, "date", _FrozenDate):
            yield sync_module.run_sync(days=0, connection_id=self.CONNECTION_ID, request=request)

    def _txn(self, txn_id, *, date="2026-08-09", amount=12.34, name="Coffee"):
        return {
            "external_transaction_id": txn_id,
            "external_account_id": self.EXTERNAL_ACCOUNT_ID,
            "amount": amount,
            "merchant_name": name,
            "raw_name": name.upper(),
            "date": date,
            "is_pending": False,
        }

    def _page(self, **kwargs):
        return {"has_more": False, "update_status": _DONE, **kwargs}

    def _stored_summary(self) -> dict:
        with self._use_db_path(), get_db() as conn:
            row = conn.execute(
                "SELECT last_sync_summary FROM connection WHERE id = ?", (self.CONNECTION_ID,),
            ).fetchone()
        return json.loads(row["last_sync_summary"])

    def _published_summary(self) -> dict:
        with self._use_db_path():
            connections = provider_config.list_connections("plaid")
        return next(c for c in connections if c["id"] == self.CONNECTION_ID)["last_sync"]

    def _mark_backfill_complete(self):
        """Routine mode. The first pull is a backfill and files everything onto ONE 'Initial import' card;
        the monthly period cards — and with them the reason the report exists — only begin after it."""
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET initial_sync_complete = 1 WHERE id = ?", (self.CONNECTION_ID,))

    def _scoped_ids(self, connection_id=None) -> list[str]:
        with self._use_db_path():
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sync_connection_id=connection_id or self.CONNECTION_ID,
                sort_by="date", sort_dir="desc",
                account_id=None, category_id=None,
                direction=None, view=None,
                search=None, quick_filter=None,
                include_trashed=False, limit=200, offset=0,
            )
        return [row["id"] for row in result["transactions"]]

    def _all_ids(self) -> list[str]:
        with self._use_db_path(), get_db() as conn:
            return [r["id"] for r in conn.execute("SELECT id FROM txn WHERE trashed_at IS NULL")]

    # ---- what a sync records --------------------------------------------

    def test_a_sync_records_the_rows_it_touched_and_the_cards_it_wrote_to(self):
        with self._driven_sync(pages=[self._page(added=[self._txn("t1"), self._txn("t2")])]):
            pass
        summary = self._stored_summary()
        self.assertEqual(sorted(summary["row_ids"]), sorted(self._all_ids()))
        # The card reference carries the id, because opening the ledger in place is the entire point —
        # a label alone would still mean going to the history page to find the card it names.
        self.assertEqual(len(summary["cards"]), 1)
        card = summary["cards"][0]
        with self._use_db_path(), get_db() as conn:
            batch_ids = {r["import_batch_id"] for r in conn.execute("SELECT import_batch_id FROM txn")}
            filename = conn.execute(
                "SELECT filename FROM import_batch WHERE id = ?", (card["id"],)).fetchone()["filename"]
        self.assertEqual(batch_ids, {card["id"]})
        self.assertEqual(card["label"], filename)
        self.assertEqual(card["added"], 2)

    def test_a_revised_row_is_in_the_report_and_a_withdrawn_one_is_not(self):
        # `removed` trashes the row. A report cannot show it, and offering to categorize a transaction
        # that has left the ledger would be nonsense — so the scope is added + revised, nothing else.
        with self._driven_sync(pages=[self._page(added=[self._txn("t1"), self._txn("t2")])]):
            pass
        self._mark_backfill_complete()
        with self._use_db_path(), get_db() as conn:
            kept = conn.execute(
                "SELECT id FROM txn WHERE external_transaction_id = 't1'").fetchone()["id"]
        with self._driven_sync(pages=[self._page(
            modified=[self._txn("t1", amount=99.0, name="Coffee Revised")],
            removed=["t2"],
        )]):
            pass
        self.assertEqual(self._stored_summary()["row_ids"], [kept])
        self.assertEqual(self._scoped_ids(), [kept])

    def test_a_later_sync_replaces_the_report(self):
        # The summary describes the LAST sync, so the report is always about the most recent pull. A row
        # from the earlier one is still on its card; it is simply no longer what this report is about.
        with self._driven_sync(pages=[self._page(added=[self._txn("t1")])]):
            pass
        self._mark_backfill_complete()
        with self._driven_sync(pages=[self._page(added=[self._txn("t2", date="2026-08-10")])]):
            pass
        with self._use_db_path(), get_db() as conn:
            second = conn.execute(
                "SELECT id FROM txn WHERE external_transaction_id = 't2'").fetchone()["id"]
        self.assertEqual(self._scoped_ids(), [second])
        self.assertEqual(len(self._all_ids()), 2)

    # ---- the cap ---------------------------------------------------------

    def test_a_pull_past_the_cap_records_no_row_list_but_still_names_its_cards(self):
        # Dropped whole rather than truncated, and the card reference survives — that is what lets the
        # connection card fall back to opening the card itself instead of losing the launcher entirely.
        with mock.patch.object(sync_module, "_SCOPED_SYNC_ROW_CAP", 2):
            with self._driven_sync(pages=[self._page(
                added=[self._txn("t1"), self._txn("t2"), self._txn("t3")],
            )]):
                pass
        summary = self._stored_summary()
        self.assertIsNone(summary["row_ids"])
        self.assertEqual(len(summary["cards"]), 1)
        self.assertEqual(self._published_summary()["scoped_rows"], 0)
        self.assertEqual(self._scoped_ids(), [])

    def test_a_pull_at_the_cap_still_records_its_rows(self):
        # The boundary itself, so a `<` that should be `<=` cannot silently cost the report its most
        # common non-trivial case.
        with mock.patch.object(sync_module, "_SCOPED_SYNC_ROW_CAP", 2):
            with self._driven_sync(pages=[self._page(added=[self._txn("t1"), self._txn("t2")])]):
                pass
        self.assertEqual(len(self._stored_summary()["row_ids"]), 2)
        self.assertEqual(self._published_summary()["scoped_rows"], 2)

    # ---- what reaches the client ----------------------------------------

    def test_the_connection_listing_publishes_the_count_and_never_the_ids(self):
        with self._driven_sync(pages=[self._page(added=[self._txn("t1"), self._txn("t2")])]):
            pass
        published = self._published_summary()
        self.assertEqual(published["scoped_rows"], 2)
        self.assertNotIn("row_ids", published)
        self.assertEqual(len(published["cards"]), 1)
        self.assertIn("id", published["cards"][0])

    def test_a_failing_connection_publishes_the_same_projection(self):
        # The failure branch used to spread the stored blob wholesale, which is exactly how a field meant
        # to stay server-side leaks: it reaches the client through the one path nobody re-reads.
        with self._driven_sync(pages=[self._page(added=[self._txn("t1")])]):
            pass
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET last_sync_error = 'boom', last_sync_error_at = '2026-08-11T00:00:00Z' "
                "WHERE id = ?", (self.CONNECTION_ID,),
            )
        published = self._published_summary()
        self.assertNotIn("row_ids", published)
        self.assertEqual(published["outcome"], "failed")
        self.assertEqual(published["scoped_rows"], 1)

    # ---- the scope filter -------------------------------------------------

    def test_the_scope_matches_nothing_rather_than_everything_when_no_list_was_stored(self):
        # Every one of these reaches the same clause with nothing to expand: a connection that has never
        # synced, and an id that names no connection at all. Widening to the unfiltered set here would
        # turn "the rows from that sync" into "every transaction in the ledger".
        with self._driven_sync(pages=[self._page(added=[self._txn("t1")])]):
            pass
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET last_sync_summary = NULL WHERE id = ?", (self.CONNECTION_ID,))
        self.assertEqual(self._scoped_ids(), [])
        self.assertEqual(self._scoped_ids("no-such-connection"), [])
        self.assertEqual(len(self._all_ids()), 1)

    def test_a_summary_from_before_this_existed_is_not_an_error(self):
        # An installation syncing on the old code has summaries with no `row_ids` key at all. The report
        # is simply unavailable until the next sync writes one — it must not fail the listing or the query.
        with self._driven_sync(pages=[self._page(added=[self._txn("t1")])]):
            pass
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET last_sync_summary = ? WHERE id = ?",
                (json.dumps({"at": "2026-08-01T00:00:00Z", "added": 1}), self.CONNECTION_ID),
            )
        published = self._published_summary()
        self.assertEqual(published["scoped_rows"], 0)
        self.assertEqual(published["cards"], [])
        self.assertEqual(self._scoped_ids(), [])


if __name__ == "__main__":
    unittest.main()
