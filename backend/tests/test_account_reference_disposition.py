# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Removing an account takes everything that named it with it.

The reported shape: a credit card is reissued, the new card gets an account of its own, and the old
account is merged into it rather than mapped onto it. Later the old account is removed — and its
transactions have to go somewhere, because `txn.account_id` is NOT NULL.

Three layers, matching `test_account_group_references.py`'s:

  * `AccountReferenceDispositionRegistryTests` derives every FK into `account(id)` from the schema and
    fails until each one is declared in `ACCOUNT_REFERENCES` with a disposition for both removal paths.
    It cannot tell whether a disposition is *right*, only that the decision was made.
  * `ReassignCarriesEveryReferenceTests` proves the `FOLLOW` declarations actually move.
  * The endpoint tests prove the question is asked at all.

There is no account trash to exercise: it was retired once removal moved behind the row's overflow
menu, because it could only ever defer the move rather than undo it (`AccountRemovalDialog`).

Each of the reassignment tests below fails on the pre-fix code, which moved five of the references and
left the rest to their foreign keys.

All data here is fabricated.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers import accounts as accounts_module
from backend.services import amazon_funding
from backend.services.account_references import ACCOUNT_REFERENCES


def _account_foreign_keys(conn) -> set:
    found = set()
    for table in [
        r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    ]:
        for fk in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall():
            if fk["table"] == "account":
                found.add((table, fk["from"]))
    return found


class _ReissuedCardFixture(unittest.TestCase):
    """The reported ledger: an old card merged into its replacement, with history on both."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "account-removal.db"
        init_db(str(self.db_path))
        self.replacement = self._insert_account("Harborline Rewards", mask="4455")
        self.retired = self._insert_account("Harborline Rewards", mask="1111")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name: str, *, mask: str | None = None, account_type: str = "credit") -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account
                     (id, external_account_id, provider, name, display_name, type, mask, owner_id)
                   VALUES (?, ?, 'fixture', ?, ?, ?, ?, ?)""",
                (account_id, f"ext_{account_id}", name, name, account_type, mask, SHARED_OWNER_ID),
            )
        return account_id

    def _merge_retired_into_replacement(self):
        """The state `POST /accounts/{id}/attach` leaves: the child stays, nothing else moves."""
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE account SET parent_account_id = ? WHERE id = ?",
                (self.replacement, self.retired),
            )

    def _insert_txn(self, *, account_id: str, name: str = "Fablemart", amount: float = 24.5,
                    date: str = "2026-04-02") -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name,
                      raw_name, date, is_pending, category_overridden)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0)""",
                (txn_id, account_id, SHARED_OWNER_ID, amount, name, name, name, date),
            )
        return txn_id

    def _insert_series(self, *, account_id: str, counterpart_account_id: str | None = None) -> str:
        series_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO recurring_series
                     (id, payee_key, display_name, category_id, account_id, counterpart_account_id,
                      cadence, period_days, expected_amount, status, source, confirmed, updated_at)
                   VALUES (?, 'fablegym', 'Fablegym', NULL, ?, ?, 'monthly', 30, 44.0,
                           'active', 'manual', 1, datetime('now'))""",
                (series_id, account_id, counterpart_account_id),
            )
        return series_id

    def _leaf_category(self, name: str) -> str:
        # A fresh ledger ships the top-level groups only (starter categories are opt-in), so a rule
        # needs a leaf of its own.
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE parent_id IS NULL LIMIT 1"
            ).fetchone()
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) "
                "VALUES (?, ?, ?, 'expense', 0)",
                (category_id, group["id"], name),
            )
        return category_id

    def _insert_rule(self, *, account_id: str) -> str:
        rule_id = str(uuid.uuid4())
        category_id = self._leaf_category("Streaming")
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO category_rule (id, category_id, keyword, owner_id, account_id)
                   VALUES (?, ?, 'fablestream', NULL, ?)""",
                (rule_id, category_id, account_id),
            )
        return rule_id

    def _insert_connection_mapping(self, *, account_id: str, target_account_id: str) -> str:
        connection_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, institution) VALUES (?, 'fixture', 'Harborline')",
                (connection_id,),
            )
            conn.execute(
                """INSERT INTO connection_account
                     (connection_id, external_account_id, account_id, mapping_mode, target_account_id)
                   VALUES (?, 'provider-acct-1', ?, 'existing', ?)""",
                (connection_id, account_id, target_account_id),
            )
        return connection_id

    def _insert_import_profile(self, *, account_id: str, also_mapping: str | None = None) -> str:
        profile_id = str(uuid.uuid4())
        assignments = {"1111": account_id}
        if also_mapping:
            assignments["4455"] = also_mapping
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO csv_import_profile (id, name, account_id, column_map)
                   VALUES (?, 'Harborline monthly', ?, ?)""",
                (profile_id, account_id, json.dumps({"account_assignments": assignments})),
            )
        return profile_id

    def _remove_retired(self, **kwargs):
        with self._use_db_path():
            return accounts_module.delete_account(self.retired, **kwargs)

    def _row(self, sql, params=()):
        with self._use_db_path(), get_db() as conn:
            return conn.execute(sql, params).fetchone()


class AccountReferenceDispositionRegistryTests(_ReissuedCardFixture):
    def test_every_account_foreign_key_has_a_declared_disposition(self):
        with self._use_db_path(), get_db() as conn:
            found = _account_foreign_keys(conn)
        declared = {(r.table, r.column) for r in ACCOUNT_REFERENCES}
        self.assertEqual(
            found - declared,
            set(),
            "New foreign key(s) into account(id) must be declared in ACCOUNT_REFERENCES with a "
            "disposition for each removal path: left to the foreign key, a matching scope is nulled "
            "into a ledger-wide one and a map is destroyed. See services/account_references.py.",
        )

    def test_no_declaration_survives_its_column(self):
        with self._use_db_path(), get_db() as conn:
            found = _account_foreign_keys(conn)
        declared = {(r.table, r.column) for r in ACCOUNT_REFERENCES}
        self.assertEqual(declared - found, set())


class ReassignCarriesEveryReferenceTests(_ReissuedCardFixture):
    def test_transactions_and_import_coverage_follow(self):
        txn_id = self._insert_txn(account_id=self.retired)
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO import_batch (id, filename, status, row_count)
                   VALUES ('batch-1', 'harborline.csv', 'completed', 1)"""
            )
            conn.execute(
                """INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
                   VALUES ('batch-1', '', ?, 1)""",
                (self.retired,),
            )
        self._merge_retired_into_replacement()

        self._remove_retired(transactions="reassign", target_account_id=self.replacement)

        self.assertEqual(
            self._row("SELECT account_id FROM txn WHERE id = ?", (txn_id,))["account_id"],
            self.replacement,
        )
        self.assertEqual(
            self._row("SELECT account_id FROM import_batch_account WHERE batch_id = 'batch-1'")["account_id"],
            self.replacement,
        )

    def test_a_rule_pinned_to_the_removed_account_follows_instead_of_being_dropped(self):
        rule_id = self._insert_rule(account_id=self.retired)
        self._insert_txn(account_id=self.retired)
        self._merge_retired_into_replacement()

        self._remove_retired(transactions="reassign", target_account_id=self.replacement)

        self.assertEqual(
            self._row("SELECT account_id FROM category_rule WHERE id = ?", (rule_id,))["account_id"],
            self.replacement,
        )

    def test_a_recurring_series_follows_rather_than_becoming_unscoped(self):
        # The silent widening this guards: `recurring_series.account_id` is ON DELETE SET NULL, and
        # recurring_detection skips the account test when the scope is NULL — so a series pinned to one
        # card would start claiming rows on every account in the ledger.
        series_id = self._insert_series(account_id=self.retired)
        self._insert_txn(account_id=self.retired)
        self._merge_retired_into_replacement()

        self._remove_retired(transactions="reassign", target_account_id=self.replacement)

        row = self._row("SELECT account_id FROM recurring_series WHERE id = ?", (series_id,))
        self.assertIsNotNone(row, "the series should survive a reassignment")
        self.assertEqual(row["account_id"], self.replacement)

    def test_a_movements_far_account_follows_too(self):
        other = self._insert_account("Riverstone Checking", account_type="depository")
        series_id = self._insert_series(account_id=other, counterpart_account_id=self.retired)
        self._insert_txn(account_id=self.retired)
        self._merge_retired_into_replacement()

        self._remove_retired(transactions="reassign", target_account_id=self.replacement)

        self.assertEqual(
            self._row(
                "SELECT counterpart_account_id FROM recurring_series WHERE id = ?", (series_id,)
            )["counterpart_account_id"],
            self.replacement,
        )

    def test_the_amazon_funding_map_follows_instead_of_cascading_away(self):
        self._insert_txn(account_id=self.retired)
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(
                conn, last4="1111", network="Fablecard", funding_account_id=self.retired
            )
        self._merge_retired_into_replacement()

        self._remove_retired(transactions="reassign", target_account_id=self.replacement)

        row = self._row("SELECT funding_account_id FROM amazon_funding_map WHERE last4 = '1111'")
        self.assertIsNotNone(row, "the instrument mapping should survive the account it pointed at")
        self.assertEqual(row["funding_account_id"], self.replacement)

    def test_the_targets_own_amazon_override_wins_over_the_removed_accounts(self):
        # Both accounts carry an override for the same instrument, so re-pointing the source's would
        # trip `idx_amazon_funding_override`. The surviving account's own answer is the one to keep.
        amazon_old = self._insert_account("Fablemart", account_type="amazon")
        amazon_new = self._insert_account("Fablemart store", account_type="amazon")
        paying = self._insert_account("Northgate Card")
        self._insert_txn(account_id=amazon_old)
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(
                conn, last4="9900", network="Fablecard",
                funding_account_id=paying, amazon_account_id=amazon_old,
            )
            amazon_funding.upsert_funding_source(
                conn, last4="9900", network="Fablecard",
                funding_account_id=self.replacement, amazon_account_id=amazon_new,
            )

        with self._use_db_path():
            accounts_module.delete_account(
                amazon_old, transactions="reassign", target_account_id=amazon_new
            )

        with self._use_db_path(), get_db() as conn:
            rows = conn.execute(
                "SELECT funding_account_id FROM amazon_funding_map WHERE last4 = '9900'"
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["funding_account_id"], self.replacement)

    def test_an_import_profile_keeps_importing_into_the_account_that_holds_its_history(self):
        profile_id = self._insert_import_profile(account_id=self.retired)
        self._insert_txn(account_id=self.retired)
        self._merge_retired_into_replacement()

        self._remove_retired(transactions="reassign", target_account_id=self.replacement)

        row = self._row(
            "SELECT account_id, column_map FROM csv_import_profile WHERE id = ?", (profile_id,)
        )
        self.assertEqual(row["account_id"], self.replacement)
        self.assertIn(self.replacement, row["column_map"])
        self.assertNotIn(self.retired, row["column_map"])

    def test_a_connection_mapping_is_released_rather_than_handed_to_the_target(self):
        # Not moved on purpose: one provider handle belongs to one account
        # (`account.external_account_id` is UNIQUE), so re-pointing it would feed an account the user
        # never mapped it to. `mapping_mode` has to go with the ids or the row reads as decided while
        # nothing can act on it.
        self._insert_connection_mapping(account_id=self.retired, target_account_id=self.retired)
        self._insert_txn(account_id=self.retired)
        self._merge_retired_into_replacement()

        self._remove_retired(transactions="reassign", target_account_id=self.replacement)

        row = self._row("SELECT account_id, target_account_id, mapping_mode FROM connection_account")
        self.assertIsNone(row["account_id"])
        self.assertIsNone(row["target_account_id"])
        self.assertIsNone(row["mapping_mode"])


class DeleteDiscardsRatherThanWidensTests(_ReissuedCardFixture):
    def test_a_series_scoped_to_the_account_is_removed_not_left_ledger_wide(self):
        series_id = self._insert_series(account_id=self.retired)
        self._insert_txn(account_id=self.retired)

        self._remove_retired(transactions="delete")

        self.assertIsNone(self._row("SELECT id FROM recurring_series WHERE id = ?", (series_id,)))

    def test_the_transactions_are_gone_and_the_account_with_them(self):
        self._insert_txn(account_id=self.retired)

        result = self._remove_retired(transactions="delete")

        self.assertEqual(result["deleted"], 1)
        self.assertIsNone(self._row("SELECT id FROM account WHERE id = ?", (self.retired,)))
        self.assertEqual(self._row("SELECT COUNT(*) n FROM txn")["n"], 0)

    def test_an_import_profile_survives_unmapped(self):
        profile_id = self._insert_import_profile(account_id=self.retired)
        self._insert_txn(account_id=self.retired)

        self._remove_retired(transactions="delete")

        row = self._row("SELECT account_id FROM csv_import_profile WHERE id = ?", (profile_id,))
        self.assertIsNotNone(row)
        self.assertIsNone(row["account_id"])

    def test_the_per_value_map_loses_the_entry_rather_than_keeping_a_blank(self):
        # A blank reads as unmapped to every consumer, so this is tidiness rather than behaviour — but
        # a value nothing can act on and nothing will ever clear is not worth storing forever. With the
        # map's last entry gone, the key goes too, which is the shape the import screen saves.
        profile_id = self._insert_import_profile(account_id=self.retired)
        self._insert_txn(account_id=self.retired)

        self._remove_retired(transactions="delete")

        column_map = json.loads(
            self._row("SELECT column_map FROM csv_import_profile WHERE id = ?", (profile_id,))["column_map"]
        )
        self.assertNotIn("account_assignments", column_map)

    def test_an_entry_for_another_account_is_left_alone(self):
        profile_id = self._insert_import_profile(account_id=self.retired, also_mapping=self.replacement)
        self._insert_txn(account_id=self.retired)

        self._remove_retired(transactions="delete")

        column_map = json.loads(
            self._row("SELECT column_map FROM csv_import_profile WHERE id = ?", (profile_id,))["column_map"]
        )
        self.assertEqual(column_map["account_assignments"], {"4455": self.replacement})

    def test_a_past_imports_snapshot_loses_the_reference_too(self):
        self._insert_txn(account_id=self.retired)
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO import_batch (id, filename, status, config_snapshot)
                   VALUES ('batch-9', 'harborline.csv', 'completed', ?)""",
                (json.dumps({"account_id": self.retired, "account_map": {"1111": self.retired}, "skip_rows": 0}),),
            )

        self._remove_retired(transactions="delete")

        snapshot = json.loads(
            self._row("SELECT config_snapshot FROM import_batch WHERE id = 'batch-9'")["config_snapshot"]
        )
        self.assertNotIn("account_id", snapshot)
        self.assertNotIn("account_map", snapshot)
        self.assertEqual(snapshot["skip_rows"], 0, "the rest of the snapshot is untouched")


class RemovalAsksBeforeDestroyingTests(_ReissuedCardFixture):
    def test_an_account_holding_transactions_refuses_without_a_disposition(self):
        self._insert_txn(account_id=self.retired)

        with self.assertRaises(HTTPException) as caught:
            self._remove_retired()

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("1 transaction", caught.exception.detail)
        self.assertIsNotNone(self._row("SELECT id FROM account WHERE id = ?", (self.retired,)))
        self.assertEqual(self._row("SELECT COUNT(*) n FROM txn")["n"], 1)

    def test_an_empty_account_needs_no_question(self):
        self._remove_retired()

        self.assertIsNone(self._row("SELECT id FROM account WHERE id = ?", (self.retired,)))

    def test_an_unknown_disposition_is_refused(self):
        self._insert_txn(account_id=self.retired)

        with self.assertRaises(HTTPException) as caught:
            self._remove_retired(transactions="archive")

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self._row("SELECT COUNT(*) n FROM txn")["n"], 1)

    def test_reassign_without_a_target_is_refused(self):
        self._insert_txn(account_id=self.retired)

        with self.assertRaises(HTTPException) as caught:
            self._remove_retired(transactions="reassign")

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self._row("SELECT COUNT(*) n FROM txn")["n"], 1)

    def test_reassigning_to_itself_is_refused(self):
        self._insert_txn(account_id=self.retired)

        with self.assertRaises(HTTPException) as caught:
            self._remove_retired(transactions="reassign", target_account_id=self.retired)

        self.assertEqual(caught.exception.status_code, 400)

    def test_reassigning_to_a_trashed_account_is_refused(self):
        # Nothing sets `trashed_at` any more, but the column survives and an old backup carries it, so
        # the guard stays and is pinned here rather than being quietly dropped as unreachable.
        self._insert_txn(account_id=self.retired)
        self._merge_retired_into_replacement()
        spare = self._insert_account("Riverstone Spare")
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE account SET parent_account_id = ?, trashed_at = datetime('now') WHERE id = ?",
                (self.replacement, spare),
            )

        with self.assertRaises(HTTPException) as caught:
            self._remove_retired(transactions="reassign", target_account_id=spare)

        self.assertEqual(caught.exception.status_code, 400)

    def test_a_group_root_refuses_and_points_at_the_children(self):
        self._insert_txn(account_id=self.replacement)
        self._merge_retired_into_replacement()

        with self.assertRaises(HTTPException) as caught:
            with self._use_db_path():
                accounts_module.delete_account(self.replacement, transactions="delete")

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("merged child accounts first", caught.exception.detail)


if __name__ == "__main__":
    unittest.main()
