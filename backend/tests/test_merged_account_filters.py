"""
Both sides of an account comparison resolve to the group root.

Merging is non-destructive: it sets `parent_account_id` and moves no rows, so a transaction keeps
living under the *child* account while every account-scoped filter resolves the row side through
`COALESCE(parent_account_id, id)`. An id held anywhere outside the `account` table — captured from a
row, stored on a mapping, remembered by a caller — can therefore become a child after it was written,
and comparing it raw against the resolved row side then matches **nothing at all** while raising no
error. That is the failure mode these tests exist for: not a wrong answer, an empty one.

So the API-parameter filters resolve the given ids too, which makes a child id mean "the group it
belongs to" — the only reading a caller ever wants. "Exactly this underlying account" is a different
question with its own parameter (`source_account_ids`), and the last test here pins that the two stay
distinct, since collapsing them would make a merged account's per-source report unbuildable.

Deliberately behavioral (real rows, real merge) rather than asserting SQL text: the defect this guards
is that a *shape* which reads fine selects nothing, which only shows up when rows are involved.
"""

from __future__ import annotations

import asyncio
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import _build_transaction_filter
from backend.services.transaction_facets import split_facets


class MergedAccountFilterTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "merged-filters.db"
        init_db(str(self.db_path))
        self.parent = self._account("Harborline Checking")
        self.child = self._account("Riverstone Checking")
        self.other = self._account("Northgate Savings")
        with self._db() as conn:
            conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (self.parent, self.child))
        self._txn("on-parent", self.parent)
        self._txn("on-child", self.child)
        self._txn("elsewhere", self.other)

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

    def _account(self, name):
        account_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id) VALUES (?,?,?,'depository',?)",
                (account_id, name, name, SHARED_OWNER_ID),
            )
        return account_id

    def _txn(self, merchant, account_id):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,"
                " date, is_pending) VALUES (?,?,?,-1.0,?,?,?,'2026-03-04',0)",
                (str(uuid.uuid4()), account_id, SHARED_OWNER_ID, merchant, merchant, merchant),
            )

    def _matching(self, **filter_kwargs) -> set:
        """The merchants the built filter actually selects — the question the SQL shape can't answer."""
        clauses, params = _build_transaction_filter(**filter_kwargs)
        where = " AND ".join(clauses) if clauses else "1=1"
        with self._db() as conn:
            rows = conn.execute(
                f"""SELECT t.merchant_name m FROM txn t JOIN account a ON a.id = t.account_id
                    LEFT JOIN account p ON p.id = a.parent_account_id WHERE {where}""",
                params,
            ).fetchall()
        return {r["m"] for r in rows}

    # ---- the include path ------------------------------------------------

    def test_a_child_id_selects_the_group_rather_than_nothing(self):
        # The defect in one line: before both sides resolved, this returned the empty set.
        self.assertEqual(self._matching(account_ids=self.child), {"on-parent", "on-child"})

    def test_a_parent_id_is_unchanged(self):
        self.assertEqual(self._matching(account_ids=self.parent), {"on-parent", "on-child"})

    def test_an_unmerged_account_is_unchanged(self):
        self.assertEqual(self._matching(account_ids=self.other), {"elsewhere"})

    def test_the_singular_account_id_form_resolves_too(self):
        # A second spelling of the same comparison; it carried the same defect independently.
        self.assertEqual(self._matching(account_id=self.child), {"on-parent", "on-child"})

    def test_several_ids_across_groups_compose(self):
        self.assertEqual(
            self._matching(account_ids=f"{self.child},{self.other}"),
            {"on-parent", "on-child", "elsewhere"},
        )

    def test_an_id_no_account_row_matches_selects_nothing(self):
        # An id that resolves to no account at all is genuinely a member of nothing, and stays that way.
        self.assertEqual(self._matching(account_ids="ghost-account"), set())

    # ---- the exclude path ------------------------------------------------

    def test_excluding_a_child_id_excludes_the_group(self):
        # Exclusion is the NULL-safe negation of the same membership test, so it moves with it: the
        # corrected include side would otherwise leave "is not <child>" excluding nothing.
        self.assertEqual(self._matching(exclude_account_ids=self.child), {"elsewhere"})

    def test_excluding_an_unknown_id_excludes_nothing(self):
        # An empty membership set negates to "everything survives" — unchanged, and the property that
        # keeps a stale id in a saved filter from silently emptying a report.
        self.assertEqual(
            self._matching(exclude_account_ids="ghost-account"),
            {"on-parent", "on-child", "elsewhere"},
        )

    # ---- the question that is NOT this one -------------------------------

    def test_source_account_ids_still_means_exactly_that_account(self):
        # The merged-account report narrows a group to one underlying source. Resolving this side too
        # would make every child in a group select the whole group, and the report could not be built.
        self.assertEqual(self._matching(source_account_ids=self.child), {"on-child"})

    def test_the_two_filters_compose_as_the_report_uses_them(self):
        self.assertEqual(
            self._matching(account_ids=self.parent, source_account_ids=self.child), {"on-child"})

    # ---- the export filter, which owns a second copy of this SQL ---------

    def _export_merchants(self, **query_kwargs) -> set:
        from backend.routers.import_export.backup import export_transactions_csv
        params = dict(
            columns="merchant_name", date_start=None, date_end=None,
            search=None,
        )
        params.update(query_kwargs)
        facets, rest = split_facets(params)
        token = set_current_db_path(str(self.db_path))
        try:
            resp = export_transactions_csv(**rest, facets=facets)
        finally:
            reset_current_db_path(token)

        async def _drain():
            parts = []
            async for chunk in resp.body_iterator:
                parts.append(chunk if isinstance(chunk, str) else chunk.decode())
            return "".join(parts)

        text = asyncio.new_event_loop().run_until_complete(_drain())
        return {ln.strip() for ln in text.splitlines()[1:] if ln.strip()}

    def test_the_export_filter_resolves_a_child_id_too(self):
        # The export inlines its own copy of the comparison instead of calling the router's builder, so
        # it needs its own coverage — a silently-short export is worse than a silently-empty report.
        self.assertEqual(self._export_merchants(account_ids=self.child), {"on-parent", "on-child"})

    def test_the_export_exclude_filter_resolves_a_child_id_too(self):
        self.assertEqual(self._export_merchants(exclude_account_ids=self.child), {"elsewhere"})


if __name__ == "__main__":
    unittest.main()
