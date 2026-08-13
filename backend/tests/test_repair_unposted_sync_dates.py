"""
The epoch-date repair script.

The bug it cleans up after is described in `backend/scripts/repair_unposted_sync_dates.py`: a provider
publishes `posted: 0` for a charge that has not posted, the adapter converted that literally, and the row
entered the ledger dated 1970-01-01 on a card labelled "January 1970". The adapter no longer does that, so
what is tested here is the part with no other coverage — a one-off script that rewrites rows in the user's
real ledger, where being wrong is expensive and re-running has to be safe.

The card bookkeeping is what makes this more than an UPDATE: a card's row count and its per-account chips
are stored, not derived, so a move that misses either leaves the history page contradicting itself.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import make_hash
from backend.scripts.repair_unposted_sync_dates import repair


class RepairUnpostedSyncDatesTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "repair.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-1', 'simplefin', 'sf-1', '', 'Example Bridge')"
            )
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype,
                   mask, owner_id)
                VALUES ('a1', 'ext-1', 'conn-1', 'simplefin', 'Card', 'Card', 'credit', 'credit card',
                        '2741', ?)
                """,
                (SHARED_OWNER_ID,),
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

    # ---- fixture builders ------------------------------------------------

    def _card(self, batch_id, filename, snapshot, row_count=0, account_rows=1):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, status, source_kind, connection_id, "
                "config_snapshot, row_count) VALUES (?, ?, 'completed', 'connection_sync', 'conn-1', ?, ?)",
                (batch_id, filename, snapshot, row_count),
            )
            conn.execute(
                "INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count) "
                "VALUES (?, 'Card (2741)', 'a1', ?)",
                (batch_id, account_rows),
            )

    def _txn(self, txn_id, batch_id, day, authorized, amount=-10.0):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO txn (id, external_transaction_id, account_id, owner_id, amount, merchant_name,
                                 display_name, raw_name, date, authorized_date, is_pending, content_hash,
                                 import_batch_id)
                VALUES (?, ?, 'a1', ?, ?, 'Bakeshop', 'Bakeshop', 'BAKESHOP', ?, ?, 1, ?, ?)
                """,
                (txn_id, f"simplefin:ext-1:{txn_id}", SHARED_OWNER_ID, amount, day, authorized,
                 make_hash(day, amount, "BAKESHOP"), batch_id),
            )

    def _rows(self):
        with self._use_db_path(), get_db() as conn:
            return {r["id"]: dict(r) for r in conn.execute(
                "SELECT id, date, content_hash, import_batch_id FROM txn"
            ).fetchall()}

    def _cards(self):
        with self._use_db_path(), get_db() as conn:
            return {r["filename"]: dict(r) for r in conn.execute(
                "SELECT id, filename, row_count FROM import_batch"
            ).fetchall()}

    def _run(self, apply):
        with self._use_db_path(), get_db() as conn:
            return repair(conn, apply=apply)

    # ---- the repair ------------------------------------------------------

    def test_an_epoch_dated_row_is_re_dated_from_its_transaction_date(self):
        self._card("b-1970", "Example Bridge · January 1970", '{"sync_period": "1970-01"}', row_count=1)
        self._card("b-aug", "Example Bridge · August 2026", '{"sync_period": "2026-08"}', row_count=3,
                   account_rows=3)
        self._txn("t1", "b-1970", "1970-01-01", "2026-08-11")
        before = self._rows()["t1"]["content_hash"]

        self._run(apply=True)

        row = self._rows()["t1"]
        self.assertEqual(row["date"], "2026-08-11")
        self.assertEqual(row["import_batch_id"], "b-aug", "re-filed onto the card for its real month")
        self.assertNotEqual(row["content_hash"], before,
                            "the hash is derived from the date and would otherwise describe the old one")

    def test_the_emptied_period_card_and_its_counts_go_with_the_rows(self):
        self._card("b-1970", "Example Bridge · January 1970", '{"sync_period": "1970-01"}', row_count=2,
                   account_rows=2)
        self._card("b-aug", "Example Bridge · August 2026", '{"sync_period": "2026-08"}', row_count=3,
                   account_rows=3)
        self._txn("t1", "b-1970", "1970-01-01", "2026-08-11")
        self._txn("t2", "b-1970", "1970-01-01", "2026-08-12")

        self._run(apply=True)

        cards = self._cards()
        self.assertNotIn("Example Bridge · January 1970", cards, "an emptied sync card records nothing")
        self.assertEqual(cards["Example Bridge · August 2026"]["row_count"], 5)
        with self._use_db_path(), get_db() as conn:
            chips = conn.execute(
                "SELECT batch_id, row_count FROM import_batch_account WHERE account_id = 'a1'"
            ).fetchall()
        self.assertEqual([(c["batch_id"], c["row_count"]) for c in chips], [("b-aug", 5)],
                         "the per-account chip count follows the rows, and the emptied card's cascades away")

    def test_a_month_with_no_card_yet_gets_one_the_next_sync_will_reuse(self):
        # The corrected month need not be a month the connection has ever synced. The card this creates has
        # to carry the same identity the sync's own resolver keys on, or the next sync makes a second one.
        self._card("b-1970", "Example Bridge · January 1970", '{"sync_period": "1970-01"}', row_count=1)
        self._txn("t1", "b-1970", "1970-01-01", "2026-07-30")

        self._run(apply=True)

        cards = self._cards()
        self.assertIn("Example Bridge · July 2026", cards)
        with self._use_db_path(), get_db() as conn:
            period = conn.execute(
                "SELECT json_extract(config_snapshot, '$.sync_period') p FROM import_batch WHERE id = ?",
                (cards["Example Bridge · July 2026"]["id"],),
            ).fetchone()["p"]
        self.assertEqual(period, "2026-07")
        self.assertEqual(cards["Example Bridge · July 2026"]["row_count"], 1)

    def test_a_row_on_an_initial_import_card_is_re_dated_but_not_moved(self):
        # An initial-import card spans a whole backfill rather than a month, so it is not mislabelled by
        # holding an August row — only the row's date was ever wrong.
        self._card("b-init", "Example Bridge · Initial import", '{"initial_backfill": true}', row_count=1)
        self._txn("t1", "b-init", "1970-01-01", "2026-08-07")

        self._run(apply=True)

        row = self._rows()["t1"]
        self.assertEqual(row["date"], "2026-08-07")
        self.assertEqual(row["import_batch_id"], "b-init")
        self.assertIn("Example Bridge · Initial import", self._cards())

    def test_a_row_with_no_transaction_date_is_reported_rather_than_guessed_at(self):
        # Nothing local knows when this happened. Dating it from the import time or the card's period would
        # be indistinguishable from a real date, which is worse than leaving it visibly wrong.
        self._card("b-1970", "Example Bridge · January 1970", '{"sync_period": "1970-01"}', row_count=1)
        self._txn("t1", "b-1970", "1970-01-01", None)

        repaired, unrecoverable, _, _ = self._run(apply=True)

        self.assertEqual(len(repaired), 0)
        self.assertEqual([r["id"] for r in unrecoverable], ["t1"])
        self.assertEqual(self._rows()["t1"]["date"], "1970-01-01")
        self.assertIn("Example Bridge · January 1970", self._cards(),
                      "the card still holds a row, so it is not emptied")

    def test_a_dry_run_writes_nothing_while_reporting_the_same_work(self):
        self._card("b-1970", "Example Bridge · January 1970", '{"sync_period": "1970-01"}', row_count=1)
        self._card("b-aug", "Example Bridge · August 2026", '{"sync_period": "2026-08"}', row_count=1)
        self._txn("t1", "b-1970", "1970-01-01", "2026-08-11")

        repaired, unrecoverable, moves, dropped = self._run(apply=False)

        self.assertEqual(len(repaired), 1)
        self.assertEqual(unrecoverable, [])
        self.assertEqual(sum(len(v) for v in moves.values()), 1)
        self.assertEqual(dropped, ["Example Bridge · January 1970"],
                         "the dry run reports the card removal it would perform, not the pre-move state")
        self.assertEqual(self._rows()["t1"]["date"], "1970-01-01")
        self.assertEqual(self._cards()["Example Bridge · January 1970"]["row_count"], 1)

    def test_running_it_twice_is_a_no_op(self):
        # The script is kept re-runnable because this database is routinely restored from backup; a second
        # run must not re-file rows that are already right or invent a second card for their month.
        self._card("b-1970", "Example Bridge · January 1970", '{"sync_period": "1970-01"}', row_count=1)
        self._txn("t1", "b-1970", "1970-01-01", "2026-08-11")
        self._run(apply=True)
        after_first = (self._rows(), self._cards())

        repaired, unrecoverable, moves, dropped = self._run(apply=True)

        self.assertEqual((repaired, unrecoverable, dict(moves), dropped), ([], [], {}, []))
        self.assertEqual((self._rows(), self._cards()), after_first)


if __name__ == "__main__":
    unittest.main()
