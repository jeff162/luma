"""The imported-category scope filter: *whose* rows take the categories a file carries.

Using a file's own categories is one switch, and restricting that to part of the ledger is a second.
A household where one person's bank exports useful categories and another's exports noise sets the
switch on and narrows it to the first person's accounts; every other row then imports uncategorized
with its label retained, exactly as if the switch were off.

Nothing exercised that narrowing, and it was inert: the settings were normalized through a helper that
only accepted stored *text*, while every caller handed it an already-parsed mapping, so the scope read
back as the default `all` and the file's categories were applied to everybody. The failure is
invisible from the switch itself — categories do get applied, just to more rows than were asked for.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import (
    IMPORTED_CATEGORY_SCOPE_FILTERED,
    IMPORTED_CATEGORY_SETTINGS_KEY,
    run_import_core,
)

# Deliberate nonsense merchants, so none of the seeded default rules claims a row and skews the result.
CSV = (
    "Date,Description,Amount,Category,Account\n"
    "2026-07-02,Zorbnix Supply,-21.00,Hobby Supplies,Riverstone\n"
    "2026-07-03,Quillvex Depot,-34.00,Yard Care,Northgate\n"
)

COLUMN_MAP = {
    "date": "Date", "description": "Description", "amount": "Amount",
    "category": "Category", "account": "Account",
}


class ImportedCategoryScopeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "scope.db"
        init_db(str(self.db_path))
        self.owner_in_scope = self._insert_owner("Alex")
        self.owner_out_of_scope = self._insert_owner("Robin")
        self.account_in_scope = self._insert_account("Riverstone", self.owner_in_scope)
        self.account_out_of_scope = self._insert_account("Northgate", self.owner_out_of_scope)

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_owner(self, name: str) -> str:
        owner_id = str(uuid.uuid4())
        with get_db(str(self.db_path)) as conn:
            conn.execute("INSERT INTO owner (id, name) VALUES (?, ?)", (owner_id, name))
        return owner_id

    def _insert_account(self, name: str, owner_id: str) -> str:
        account_id = str(uuid.uuid4())
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture', ?, ?, 'depository', 'checking', NULL, ?, NULL, NULL)
                """,
                (account_id, f"fixture_{account_id}", name, name, owner_id),
            )
        return account_id

    def _import(self, settings: dict | None) -> None:
        cfg = {
            "account_map": {"Riverstone": self.account_in_scope, "Northgate": self.account_out_of_scope},
            "column_map": dict(COLUMN_MAP),
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            # Rules off, so the only thing that can place a category is the file's own label.
            "apply_categorization": False,
            "use_imported_categories": True,
        }
        if settings is not None:
            cfg[IMPORTED_CATEGORY_SETTINGS_KEY] = settings
        with self._use_db_path():
            run_import_core(CSV, cfg, filename="july.csv")

    def _categories_by_account(self) -> dict[str, str | None]:
        with get_db(str(self.db_path)) as conn:
            rows = conn.execute(
                """
                SELECT t.account_id, c.name AS category_name
                FROM   txn t
                LEFT JOIN category c ON c.id = t.category_id
                """
            ).fetchall()
        return {row["account_id"]: row["category_name"] for row in rows}

    def test_a_filtered_scope_categorizes_only_the_owners_it_names(self):
        self._import({
            "scope_mode": IMPORTED_CATEGORY_SCOPE_FILTERED,
            "owner_ids": [self.owner_in_scope],
        })
        by_account = self._categories_by_account()
        self.assertEqual(by_account[self.account_in_scope], "Hobby Supplies")
        self.assertIsNone(
            by_account[self.account_out_of_scope],
            "a row outside the scope must import uncategorized, as if the switch were off",
        )

    def test_a_label_outside_the_scope_does_not_become_a_category(self):
        """The narrowing is also about the category tree, not only about the rows. A leaf minted for an
        out-of-scope label would be left behind with nothing in it, which is the mess the setting exists
        to avoid."""
        self._import({
            "scope_mode": IMPORTED_CATEGORY_SCOPE_FILTERED,
            "owner_ids": [self.owner_in_scope],
        })
        with get_db(str(self.db_path)) as conn:
            names = {row["name"] for row in conn.execute("SELECT name FROM category").fetchall()}
        self.assertIn("Hobby Supplies", names)
        self.assertNotIn("Yard Care", names)

    def test_the_label_is_still_retained_on_the_row_the_scope_excluded(self):
        """Excluded means *not categorized by the file*, not *the file never said anything*. The raw
        label stays on the row either way, which is what lets the scope be widened later."""
        self._import({
            "scope_mode": IMPORTED_CATEGORY_SCOPE_FILTERED,
            "owner_ids": [self.owner_in_scope],
        })
        with get_db(str(self.db_path)) as conn:
            row = conn.execute(
                "SELECT imported_category FROM txn WHERE account_id = ?", (self.account_out_of_scope,)
            ).fetchone()
        self.assertEqual(row["imported_category"], "Yard Care")

    def test_an_unnarrowed_import_categorizes_every_row(self):
        """The control. Without it the assertions above pass against a scope that excludes everything,
        which is the opposite defect and equally wrong."""
        self._import(None)
        by_account = self._categories_by_account()
        self.assertEqual(by_account[self.account_in_scope], "Hobby Supplies")
        self.assertEqual(by_account[self.account_out_of_scope], "Yard Care")


if __name__ == "__main__":
    unittest.main()
