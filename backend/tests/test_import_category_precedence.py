"""
Import categorization precedence: mapping -> rule -> imported file label -> uncategorized.

The user's rules are the source of truth. A rule must win over the file's own category, and we must
NOT create a category from the file label for a row a rule has placed (it would be an empty, unused
category). The file label is only a bootstrap fallback for rows nothing else categorizes, and the
raw label is always retained as imported_category text. These tests pin that order and prove the
"don't mint an unused label category when a rule wins" guard fires. Merchant strings are deliberate
nonsense so the ~44 seeded default rules don't match and skew the result.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.import_export import run_import
from backend.routers.import_export.core import _set_batch_imported_category_usage, undo_batch


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self):
        return self._content


class ImportCategoryPrecedenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "import-precedence-tests.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name):
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", "fixture_import", name, name, SHARED_OWNER_ID),
                )
        return account_id

    def _add_rule(self, category_name, keyword, clean_name=None):
        """Create a top-level group + leaf named category_name with a rule keyword -> that leaf. An
        optional clean_name gives the rule a rename action."""
        group_id = str(uuid.uuid4())
        leaf_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, NULL, ?, 'expense', 0, 0, 1)",
                    (group_id, f"{category_name} Group"),
                )
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, ?, ?, 'expense', 0, 0, 1)",
                    (leaf_id, group_id, category_name),
                )
                conn.execute(
                    "INSERT INTO category_rule (id, category_id, keyword, clean_name) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), leaf_id, keyword, clean_name),
                )
        return leaf_id

    async def _run_import(self, csv_text, account_map, *, use_imported_categories=True, apply_categorization=True):
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": account_map,
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount", "category": "Category"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": apply_categorization,
            "use_imported_categories": use_imported_categories,
        }
        with self._use_db_path():
            return await run_import(file=FakeUploadFile("fixture.csv", csv_text), config=json.dumps(config))

    def _txn_by_merchant(self, merchant):
        with self._use_db_path():
            with get_db() as conn:
                return dict(conn.execute(
                    "SELECT id, category_id, category_source, imported_category, category_overridden FROM txn WHERE merchant_name = ?",
                    (merchant,),
                ).fetchone())

    def _unassigned_leaf_names(self):
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    "SELECT c.name FROM category c JOIN category p ON p.id = c.parent_id WHERE p.system_key = 'unassigned' ORDER BY c.name"
                ).fetchall()
        return [row["name"] for row in rows]

    def _latest_batch_id(self):
        with self._use_db_path():
            with get_db() as conn:
                return conn.execute("SELECT id FROM import_batch ORDER BY imported_at DESC, id DESC LIMIT 1").fetchone()["id"]

    async def test_rule_wins_and_file_label_fills_only_the_gaps(self):
        account_id = self._insert_account("Checking")
        rule_cat_id = self._add_rule("RuleCat", "zzqx")

        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants",   # matches the rule
                "2026-01-03,WBWB STORE,Checking,12.00,Gadgets",         # no rule -> file label
            ]),
            {"Checking": account_id},
        )

        ruled = self._txn_by_merchant("ZZQX MERCHANT")
        self.assertEqual(ruled["category_id"], rule_cat_id, "the rule's category wins over the file label")
        self.assertEqual(ruled["category_source"], "rule")
        self.assertEqual(ruled["imported_category"], "Restaurants", "raw label retained for audit")

        labeled = self._txn_by_merchant("WBWB STORE")
        self.assertEqual(labeled["category_source"], "import", "no rule matched, so the file label is adopted")
        self.assertEqual(labeled["imported_category"], "Gadgets")

        # The guard: a label category is minted only for the row that actually lands on it. "Gadgets"
        # exists (row had no rule); "Restaurants" must NOT, because the rule placed that row elsewhere.
        names = self._unassigned_leaf_names()
        self.assertIn("Gadgets", names)
        self.assertNotIn("Restaurants", names)

    async def test_enabling_imported_categories_later_respects_existing_rule_assignments(self):
        account_id = self._insert_account("Checking")
        rule_cat_id = self._add_rule("RuleCat", "zzqx")

        # Import rules-only (the source is not yet trusted for categories).
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,ZZQX MERCHANT,Checking,4.50,Restaurants",
                "2026-01-03,WBWB STORE,Checking,12.00,Gadgets",
            ]),
            {"Checking": account_id},
            use_imported_categories=False,
        )
        self.assertEqual(self._txn_by_merchant("ZZQX MERCHANT")["category_source"], "rule")
        self.assertIsNone(self._txn_by_merchant("WBWB STORE")["category_source"], "no rule, no labels yet")
        self.assertEqual(self._unassigned_leaf_names(), [])

        # Now flip the per-batch "use imported categories" toggle on.
        batch_id = self._latest_batch_id()
        with self._use_db_path():
            with get_db() as conn:
                _set_batch_imported_category_usage(conn, batch_id, True)

        # The rule row is untouched; only the gap row adopts its file label.
        ruled = self._txn_by_merchant("ZZQX MERCHANT")
        self.assertEqual(ruled["category_id"], rule_cat_id, "enabling labels must not override a rule")
        self.assertEqual(ruled["category_source"], "rule")
        labeled = self._txn_by_merchant("WBWB STORE")
        self.assertEqual(labeled["category_source"], "import")
        names = self._unassigned_leaf_names()
        self.assertIn("Gadgets", names)
        self.assertNotIn("Restaurants", names)


    async def test_rule_clean_name_is_applied_as_display_name_at_import(self):
        # A rule's rename action (clean_name) must be applied at import — like sync and recategorize do —
        # not just its category/tags. display_name becomes the canonical name while merchant_name keeps the
        # raw description. Regression for the CSV path silently dropping clean_name, which left rule-renamed
        # payees grouping by their raw description in recurring detection and reports.
        account_id = self._insert_account("Checking")
        self._add_rule("RuleCat", "zzqx", clean_name="Canonical Coffee")

        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,ZZQX MERCHANT 001,Checking,4.50,Restaurants",
            ]),
            {"Checking": account_id},
        )

        with self._use_db_path():
            with get_db() as conn:
                row = dict(conn.execute(
                    "SELECT merchant_name, display_name, raw_name FROM txn WHERE raw_name = ?",
                    ("ZZQX MERCHANT 001",),
                ).fetchone())
        self.assertEqual(row["display_name"], "Canonical Coffee")    # rename applied at import
        self.assertEqual(row["merchant_name"], "ZZQX MERCHANT 001")  # raw description kept on merchant_name

    async def test_undo_removes_label_categories_the_import_created_however_many_rows_use_them(self):
        # A label category the import mints belongs to that batch until something else claims it, so undo
        # takes it back out. A label used by more than one row of its own file must still count as the
        # batch's — the repeat is that same batch, not a second one adopting it.
        account_id = self._insert_account("Checking")

        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,WBWB STORE,Checking,12.00,Gadgets",
                "2026-01-09,WBWB STORE,Checking,15.00,Gadgets",
                "2026-01-10,QPQP SHOP,Checking,7.00,Widgets",
            ]),
            {"Checking": account_id},
        )
        self.assertEqual(self._unassigned_leaf_names(), ["Gadgets", "Widgets"])

        with self._use_db_path():
            undo_batch(self._latest_batch_id(), force=False)

        self.assertEqual(self._unassigned_leaf_names(), [])


if __name__ == "__main__":
    unittest.main()
