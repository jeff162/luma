"""
A trusted import's categories rank below the rules — at import *and* afterwards.

At import a rule already beat a file's label. Once a row had taken its label, though, it was locked like a
manual edit, so Run categorization never let a later rule in: the ledger's categories depended on whether
the rule or the file arrived first. These tests pin that the order no longer matters, and the pieces that
keep it true:

  - a scoped reconcile ("re-evaluate this rule's transactions") that lets go of a row falls back to the
    row's file category where its batch is trusted, which is what import would have done, and to
    uncategorized only where it is not;
  - that reconcile never clears an `import` row nothing claimed;
  - putting a stashed categorization back cannot re-lock an `import` row;
  - adopting a batch's file labels after the fact leaves feature-owned rows alone.

Merchant strings are deliberate nonsense so the seeded default rules can't match. All data is fabricated.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import run_import
from backend.routers.import_export.core import _set_batch_imported_category_usage
from backend.routers.rules import delete_rule
from backend.routers.transactions import CategorizationRestore, CategorizationSnapshot, restore_categorization
from backend.services.categorizer import recategorize_all


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self):
        return self._content


HEADER = "Date,Description,Account,Amount,Category"


class TrustedImportYieldsToRulesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "trusted-import-yields.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES (?, ?, 'fixture_import', 'Checking', 'Checking', 'depository', ?)""",
                (self.account_id, f"test_{self.account_id}", SHARED_OWNER_ID),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    # --- fixtures ---------------------------------------------------------------------------------

    async def _import(self, *rows, trusted=True):
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": {"Checking": self.account_id},
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account",
                           "amount": "Amount", "category": "Category"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": True,
            "use_imported_categories": trusted,
        }
        with self._use_db():
            result = await run_import(file=FakeUploadFile("fixture.csv", "\n".join([HEADER, *rows])),
                                      config=json.dumps(config))
        return result["batch_id"]

    def _rule(self, keyword, category_name):
        group_id, leaf_id, rule_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, NULL, ?, 'expense', 0)",
                (group_id, f"{category_name} Group"),
            )
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, 'expense', 0)",
                (leaf_id, group_id, category_name),
            )
            conn.execute("INSERT INTO category_rule (id, category_id, keyword) VALUES (?, ?, ?)",
                         (rule_id, leaf_id, keyword))
        return leaf_id, rule_id

    def _row(self, merchant):
        with self._use_db(), get_db() as conn:
            return dict(conn.execute(
                """SELECT t.id, t.category_id, t.category_source, t.category_overridden, c.name AS category_name
                   FROM txn t LEFT JOIN category c ON c.id = t.category_id WHERE t.merchant_name = ?""",
                (merchant,),
            ).fetchone())

    def _recategorize(self):
        with self._use_db(), get_db() as conn:
            return recategorize_all(conn)

    # --- order independence -----------------------------------------------------------------------

    async def test_a_rule_created_after_a_trusted_import_lands_the_same_as_one_created_before(self):
        # File first: the row takes its file category, unlocked.
        await self._import("2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants")
        before = self._row("ZZQX MERCHANT")
        self.assertEqual((before["category_source"], before["category_overridden"]), ("import", 0))
        self.assertEqual(before["category_name"], "Restaurants")

        # Then the rule, then Categorize.
        rule_leaf, _ = self._rule("zzqx", "Coffee")
        self._recategorize()

        # Rule first: the same kind of row arriving now is claimed by the rule at import.
        await self._import("2026-02-03,ZZQX OUTLET,Checking,7.25,Restaurants")

        file_first, rule_first = self._row("ZZQX MERCHANT"), self._row("ZZQX OUTLET")
        self.assertEqual(file_first["category_id"], rule_leaf)
        self.assertEqual(
            (file_first["category_id"], file_first["category_source"], file_first["category_overridden"]),
            (rule_first["category_id"], rule_first["category_source"], rule_first["category_overridden"]),
        )

    async def test_categorize_still_leaves_a_manual_category_alone(self):
        # The guard: unlocking imports must not unlock the edit the lock exists for.
        await self._import("2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants")
        self._rule("zzqx", "Coffee")
        manual_leaf, _ = self._rule("unmatched-keyword-qpqp", "Handpicked")
        row = self._row("ZZQX MERCHANT")
        with self._use_db(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET category_id = ?, category_source = 'manual', category_overridden = 1 WHERE id = ?",
                (manual_leaf, row["id"]),
            )
        self._recategorize()
        after = self._row("ZZQX MERCHANT")
        self.assertEqual((after["category_id"], after["category_source"]), (manual_leaf, "manual"))

    # --- scoped reconcile -------------------------------------------------------------------------

    async def test_re_evaluating_a_deleted_rule_returns_its_rows_to_their_file_category(self):
        await self._import("2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants")
        # The same merchant from a file that was never trusted for its categories.
        await self._import("2026-01-09,ZZQX DINER,Checking,9.75,Snacks", trusted=False)
        _, rule_id = self._rule("zzqx", "Coffee")
        self._recategorize()
        self.assertEqual(self._row("ZZQX MERCHANT")["category_source"], "rule")
        self.assertEqual(self._row("ZZQX DINER")["category_source"], "rule")

        with self._use_db():
            delete_rule(rule_id, reconcile=True)

        trusted = self._row("ZZQX MERCHANT")
        self.assertEqual(trusted["category_name"], "Restaurants", "falls back to what import would have given it")
        self.assertEqual((trusted["category_source"], trusted["category_overridden"]), ("import", 0))
        untrusted = self._row("ZZQX DINER")
        self.assertIsNone(untrusted["category_id"], "an untrusted file has no category to fall back to")
        self.assertIsNone(untrusted["category_source"])

    async def test_re_evaluating_a_rule_never_clears_an_import_row_nothing_claimed(self):
        await self._import("2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants")
        imported = self._row("ZZQX MERCHANT")
        # The user renamed the label's category after the import. Clearing the row and re-adopting its
        # label would mint a fresh "Restaurants" leaf and move the row there, so the outcome shows whether
        # the reconcile left the row alone.
        with self._use_db(), get_db() as conn:
            conn.execute("UPDATE category SET name = 'Dining Out' WHERE id = ?", (imported["category_id"],))
        # A rule that matches the row, deleted with re-evaluate before any Categorize ran: the row is in
        # the reconcile's candidate set but no remaining rule claims it.
        _, rule_id = self._rule("zzqx", "Coffee")
        with self._use_db():
            delete_rule(rule_id, reconcile=True)

        after = self._row("ZZQX MERCHANT")
        self.assertEqual(after["category_id"], imported["category_id"])
        self.assertEqual(after["category_source"], "import")
        with self._use_db(), get_db() as conn:
            minted = conn.execute("SELECT COUNT(*) AS n FROM category WHERE name = 'Restaurants'").fetchone()["n"]
        self.assertEqual(minted, 0)

    # --- stashed categorizations and label adoption ------------------------------------------------

    async def test_restoring_a_stashed_import_categorization_does_not_re_lock_it(self):
        await self._import("2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants",
                           "2026-01-03,WBWB STORE,Checking,12.00,Gadgets")
        imported, other = self._row("ZZQX MERCHANT"), self._row("WBWB STORE")
        # An Undo snapshot taken before trusted imports were unlocked still says `import` + locked.
        with self._use_db():
            restore_categorization(CategorizationRestore(rows=[
                CategorizationSnapshot(id=imported["id"], category_id=imported["category_id"],
                                       category_source="import", category_overridden=1),
                CategorizationSnapshot(id=other["id"], category_id=other["category_id"],
                                       category_source="manual", category_overridden=1),
            ]))
        self.assertEqual(self._row("ZZQX MERCHANT")["category_overridden"], 0)
        self.assertEqual(self._row("WBWB STORE")["category_overridden"], 1, "a manual snapshot keeps its lock")

    async def test_trusting_a_batch_later_leaves_feature_owned_rows_alone(self):
        batch_id = await self._import("2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants",
                                      "2026-01-03,WBWB STORE,Checking,12.00,Gadgets", trusted=False)
        split_row, enriched_row = self._row("ZZQX MERCHANT"), self._row("WBWB STORE")
        with self._use_db(), get_db() as conn:
            conn.execute("UPDATE txn SET is_split = 1, category_source = 'split', category_overridden = 1 WHERE id = ?",
                         (split_row["id"],))
            conn.execute("UPDATE txn SET category_source = 'enrichment' WHERE id = ?", (enriched_row["id"],))
        with self._use_db(), get_db() as conn:
            _set_batch_imported_category_usage(conn, batch_id, True)
        self.assertEqual(self._row("ZZQX MERCHANT")["category_source"], "split")
        self.assertEqual(self._row("WBWB STORE")["category_source"], "enrichment")


if __name__ == "__main__":
    unittest.main()
