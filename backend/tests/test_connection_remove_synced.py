"""
Connection-level "Remove synced transactions" — DELETE /connections/{id}/synced-transactions.

A sync's rows are not undoable per card: the cursor has advanced past them, so deleting them without
resetting it would put them beyond the reach of any later sync. Removal is therefore connection-level
and resets the whole chain that describes what has been pulled — cursor, initial_sync_complete, and the
connection's coverage claim — so a later sync re-backfills cleanly. These tests drive real syncs through
the provider seam first, so what gets removed is real card/coverage/dedupe state rather than a hand-built
approximation of it, and then pin: what the removal deletes, what it resets, what it restores, the
manual-edit guard, and that a re-sync afterwards backfills onto a fresh initial card.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import connections as connections_module
from backend.routers import sync as sync_module

_DONE = "HISTORICAL_UPDATE_COMPLETE"


class _FakeAdapter:
    """Serves scripted `/transactions/sync` pages in order across calls (same seam as
    test_sync_period_cards.py), recording the cursor each call was made with."""

    def __init__(self, pages=None):
        self._pages = list(pages or [])
        self.calls = []
        self._idx = 0

    def fetch_transactions_sync(self, app_config, credential, *, cursor=None, days_requested=730):
        self.calls.append({"cursor": cursor, "days_requested": days_requested})
        page = self._pages[self._idx] if self._idx < len(self._pages) else {}
        self._idx += 1
        return {
            "added":         page.get("added", []),
            "modified":      page.get("modified", []),
            "removed":       page.get("removed", []),
            "next_cursor":   page.get("next_cursor", f"cur-{self._idx}"),
            "has_more":      page.get("has_more", False),
            "update_status": page.get("update_status", _DONE),
        }

    def capture_fields(self):
        return []


class _FrozenDate:
    """A stand-in for the `date` name inside sync.py that pins `date.today()`."""

    def __init__(self, iso):
        from datetime import date as _date
        self._today = _date.fromisoformat(iso)

    def today(self):
        return self._today


class RemoveSyncedTransactionsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "remove-synced.db"
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

    # ---- fixture drivers -------------------------------------------------

    def _txn(self, txn_id, amount, name, day="2026-08-10"):
        return {
            "external_transaction_id": txn_id,
            "external_account_id": self.external_account_id,
            "amount": amount,
            "merchant_name": name,
            "raw_name": name,
            "date": day,
            "is_pending": False,
        }

    @contextmanager
    def _driven_sync(self, added=None, on_date="2026-08-10", *, days=0, adapter=None):
        if adapter is None:
            adapter = _FakeAdapter(pages=[{"added": added or [], "has_more": False, "update_status": _DONE}])
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x", "secret": "y"}), \
                mock.patch.object(sync_module, "get_adapter", return_value=adapter), \
                mock.patch.object(sync_module, "date", _FrozenDate(on_date)):
            yield sync_module.run_sync(days=days, connection_id=self.connection_id, request=request)

    def _seed_history(self):
        """An initial backfill plus a routine delta, so the connection owns two cards, a cursor, a
        completed backfill, and a coverage claim — the state the removal has to unwind."""
        with self._driven_sync([self._txn("t1", -10.0, "Coffee", day="2026-07-05"),
                                self._txn("t2", -20.0, "Lunch", day="2026-07-06")], "2026-07-10"):
            pass
        with self._driven_sync([self._txn("t3", -5.0, "Snack", day="2026-08-09")], "2026-08-10"):
            pass

    def _remove(self, force=False):
        with self._use_db_path():
            return connections_module.remove_synced_transactions(self.connection_id, force=force)

    def _summary(self):
        with self._use_db_path():
            return connections_module.get_synced_transactions_summary(self.connection_id)

    # ---- state readers ---------------------------------------------------

    def _cards(self):
        with self._use_db_path(), get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT id, filename FROM import_batch WHERE connection_id = ? ORDER BY filename",
                (self.connection_id,),
            ).fetchall()]

    def _connection(self):
        with self._use_db_path(), get_db() as conn:
            return dict(conn.execute(
                "SELECT transactions_cursor, initial_sync_complete FROM connection WHERE id = ?",
                (self.connection_id,),
            ).fetchone())

    def _coverage(self):
        with self._use_db_path(), get_db() as conn:
            return dict(conn.execute(
                "SELECT coverage_start_date, coverage_through_date, terminal_window_days "
                "FROM connection_account WHERE connection_id = ?",
                (self.connection_id,),
            ).fetchone())

    def _synced_txn_count(self):
        with self._use_db_path(), get_db() as conn:
            return conn.execute(
                "SELECT COUNT(*) AS n FROM txn WHERE plaid_transaction_id IS NOT NULL"
            ).fetchone()["n"]

    # ---- what the removal takes and resets -------------------------------

    def test_removal_deletes_the_rows_and_their_cards(self):
        self._seed_history()
        self.assertEqual(len(self._cards()), 2, "fixture must have both an initial and a period card")
        res = self._remove()
        self.assertEqual(res["removed"], 3)
        self.assertEqual(res["cards_removed"], 2)
        self.assertEqual(self._synced_txn_count(), 0)
        # Deleted, not left as 'undone' tombstones: with the rows gone and the cursor reset a sync card
        # records nothing, and the card resolvers key on (connection, backfill/period) without regard to
        # status — a tombstone would be silently reused by the re-backfill.
        self.assertEqual(self._cards(), [])

    def test_removal_resets_the_cursor_and_the_backfill_marker(self):
        self._seed_history()
        before = self._connection()
        self.assertIsNotNone(before["transactions_cursor"], "fixture must have advanced the cursor")
        self.assertEqual(before["initial_sync_complete"], 1)
        self._remove()
        after = self._connection()
        self.assertIsNone(after["transactions_cursor"])
        self.assertEqual(after["initial_sync_complete"], 0)

    def test_removal_clears_the_connections_coverage_claim(self):
        # The invariant this action is the first writer of: coverage outliving the rows that backed it
        # would blanket-reject the very transactions the re-backfill pulls back.
        self._seed_history()
        before = self._coverage()
        self.assertIsNotNone(before["coverage_start_date"], "fixture must have established coverage")
        self.assertIsNotNone(before["coverage_through_date"])
        self._remove()
        after = self._coverage()
        self.assertIsNone(after["coverage_start_date"])
        self.assertIsNone(after["coverage_through_date"])
        # The lag window is a property of the source, not a coverage claim, so it survives.
        self.assertEqual(after["terminal_window_days"], before["terminal_window_days"])

    def test_removal_keeps_the_connection_its_accounts_and_their_mapping(self):
        self._seed_history()
        self._remove()
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM connection").fetchone()["n"], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 1)
            mapping = conn.execute(
                "SELECT mapping_mode, account_id FROM connection_account WHERE connection_id = ?",
                (self.connection_id,),
            ).fetchone()
        self.assertEqual(mapping["mapping_mode"], "existing")
        self.assertEqual(mapping["account_id"], "a1")

    def test_resync_after_removal_backfills_onto_a_fresh_initial_card(self):
        self._seed_history()
        self._remove()
        adapter = _FakeAdapter(pages=[{"added": [self._txn("t1", -10.0, "Coffee", day="2026-07-05")]}])
        with self._driven_sync(adapter=adapter, on_date="2026-08-11") as res:
            self.assertEqual(res["added"], 1, "a reset cursor re-pulls history the removal deleted")
        self.assertIsNone(adapter.calls[0]["cursor"], "the reset cursor means a full backfill, not a delta")
        cards = self._cards()
        self.assertEqual(len(cards), 1)
        self.assertIn("Initial import", cards[0]["filename"])

    # ---- rows removed elsewhere in favor of these ------------------------

    def test_removal_restores_rows_trashed_as_duplicates_of_synced_rows(self):
        # A CSV row that was removed as a duplicate of a synced copy comes back: the copy it deferred
        # to is being deleted, so "the same transaction is already here" is no longer true. Both an
        # explicit user Reject and a merge-time auto-promotion are restored — unlike a detach, this
        # removes the canonical row itself, so neither decision keeps a referent.
        self._seed_history()
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, subtype, owner_id) "
                "VALUES ('a2', 'CSV Checking', 'CSV Checking', 'depository', 'checking', ?)",
                (SHARED_OWNER_ID,),
            )
            conn.execute(
                "INSERT INTO import_batch (id, filename, row_count, status) "
                "VALUES ('csvb', 'ledger.csv', 2, 'completed')"
            )
            synced = [r["id"] for r in conn.execute(
                "SELECT id FROM txn WHERE plaid_transaction_id IN ('t1', 't2') ORDER BY plaid_transaction_id"
            ).fetchall()]
            for csv_id, canonical, marker in (("csv-1", synced[0], "user"),
                                              ("csv-2", synced[1], "auto_merge")):
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,
                                     raw_name, date, import_batch_id, trashed_at, rejection_reason,
                                     dedupe_resolved_by, suspect_duplicate_of, suspect_duplicate_reason,
                                     suspect_resolved_at)
                    VALUES (?, 'a2', ?, -10.0, 'Coffee', 'Coffee', 'Coffee', '2026-07-05', 'csvb',
                            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'duplicate_confirmed', ?, ?,
                            'cross_account', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    """,
                    (csv_id, SHARED_OWNER_ID, marker, canonical),
                )

        res = self._remove()
        self.assertEqual(res["restored"], 2)
        with self._use_db_path(), get_db() as conn:
            rows = {r["id"]: dict(r) for r in conn.execute(
                "SELECT id, trashed_at, rejection_reason, dedupe_resolved_by, suspect_duplicate_of "
                "FROM txn WHERE import_batch_id = 'csvb'"
            ).fetchall()}
        self.assertEqual(len(rows), 2, "the other import's rows are not deleted, only restored")
        for row in rows.values():
            self.assertIsNone(row["trashed_at"])
            self.assertIsNone(row["rejection_reason"])
            self.assertIsNone(row["dedupe_resolved_by"])
            self.assertIsNone(row["suspect_duplicate_of"])

    # ---- the manual-edit guard -------------------------------------------

    def _edit_a_synced_category(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET category_overridden = 1, category_source = 'manual' "
                "WHERE plaid_transaction_id = 't1'"
            )

    def test_manually_edited_rows_block_removal_until_forced(self):
        self._seed_history()
        self._edit_a_synced_category()
        response = self._remove()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self._synced_txn_count(), 3, "nothing is deleted while the guard holds")
        self.assertIsNotNone(self._connection()["transactions_cursor"], "and nothing is reset either")

        res = self._remove(force=True)
        self.assertEqual(res["removed"], 3)
        self.assertEqual(self._synced_txn_count(), 0)

    def test_preflight_reports_what_would_go_and_what_was_edited(self):
        self._seed_history()
        self._edit_a_synced_category()
        summary = self._summary()
        self.assertEqual(summary["transaction_count"], 3)
        self.assertEqual(summary["card_count"], 2)
        self.assertEqual(len(summary["edited_transactions"]), 1)
        self.assertEqual(summary["edited_transactions"][0]["merchant_name"], "Coffee")

    def test_a_rule_categorization_is_not_a_manual_edit(self):
        # The guard is about work the user would lose. A rule-assigned category is reproducible by
        # re-running the rules after the re-backfill, so it must not stand in the way.
        self._seed_history()
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET category_overridden = 1, category_source = 'rule' "
                "WHERE plaid_transaction_id = 't1'"
            )
        self.assertEqual(self._summary()["edited_transactions"], [])
        self.assertEqual(self._remove()["removed"], 3)

    # ---- degenerate shapes -----------------------------------------------

    def test_removal_with_nothing_synced_still_resets_the_cursor(self):
        # The recovery case that motivates allowing this on an empty connection: a sync whose rows were
        # all skipped (unmapped accounts) advances the cursor without inserting anything, putting those
        # transactions out of reach until the cursor is reset.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET transactions_cursor = 'c9', initial_sync_complete = 1 WHERE id = ?",
                (self.connection_id,),
            )
        res = self._remove()
        self.assertEqual(res["removed"], 0)
        self.assertEqual(res["cards_removed"], 0)
        self.assertIsNone(self._connection()["transactions_cursor"])
        self.assertEqual(self._connection()["initial_sync_complete"], 0)

    def test_unknown_connection_is_404(self):
        from fastapi import HTTPException
        with self._use_db_path(), self.assertRaises(HTTPException) as ctx:
            connections_module.remove_synced_transactions("does-not-exist", force=False)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
