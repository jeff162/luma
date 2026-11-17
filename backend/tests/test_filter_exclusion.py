"""
Filter exclusion ("is not") coverage.

The shared FilterBar lets any facet be selected as include or exclude. Exclusion is the NULL-safe
negation of the same membership test the include path builds (`negate_membership` wraps membership in
`COALESCE((...), 0) = 0`). The NULL-safety is the whole point: a row whose membership is *unknown*
(a NULL category against an IN list, a NULL owner against an owner list) is not a member and must
survive the exclusion — a plain `NOT IN` would silently drop those rows. These tests run the shared
builder against a seeded DB so the semantics, not just the emitted SQL, are guarded.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import _build_transaction_filter, list_transactions
from backend.services.transaction_facets import split_facets


class FilterExclusionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "filter-exclusion.db"
        init_db(str(self.db_path))
        self.ids = {}
        self._seed()

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                """,
                (account_id, f"plaid_{account_id}", "fixture_exclusion", name, name, SHARED_OWNER_ID),
            )
        return account_id

    def _insert_category(self, *, name: str, parent_id: str | None, category_type: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, ?, 0)",
                (category_id, parent_id, name, category_type),
            )
        return category_id

    def _insert_txn(self, *, key: str, account_id: str, category_id: str | None, amount: float,
                    merchant: str, owner_id: str | None) -> None:
        txn_id = str(uuid.uuid4())
        self.ids[key] = txn_id
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO txn
                  (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-04-10', 0, 0)
                """,
                (txn_id, account_id, owner_id, category_id, amount, merchant, merchant, merchant),
            )

    def _insert_tag(self, name: str) -> str:
        tag_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO tag (id, name, color) VALUES (?, ?, '#888')", (tag_id, name))
        return tag_id

    def _attach_txn_tag(self, txn_key: str, tag_id: str, *, manual_state: int, rule_present: int = 0) -> None:
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, ?, ?)",
                (self.ids[txn_key], tag_id, rule_present, manual_state),
            )

    def _attach_category_tag(self, category_id: str, tag_id: str) -> None:
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (category_id, tag_id))

    def _attach_account_tag(self, account_id: str, tag_id: str) -> None:
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)", (account_id, tag_id))

    def _seed(self):
        self.a1 = self._insert_account("Checking One")
        self.a2 = self._insert_account("Checking Two")
        self.food = self._insert_category(name="Food", parent_id=None, category_type="expense")
        self.groceries = self._insert_category(name="Groceries", parent_id=self.food, category_type="expense")
        self.dining = self._insert_category(name="Dining", parent_id=self.food, category_type="expense")
        # groc/dining: account a1, owned; uncat: account a2, unowned, NULL category (expense side, amount > 0)
        self._insert_txn(key="groc", account_id=self.a1, category_id=self.groceries, amount=50.0,
                         merchant="Whole Foods", owner_id=SHARED_OWNER_ID)
        self._insert_txn(key="dining", account_id=self.a1, category_id=self.dining, amount=30.0,
                         merchant="Cafe", owner_id=SHARED_OWNER_ID)
        self._insert_txn(key="uncat", account_id=self.a2, category_id=None, amount=20.0,
                         merchant="Mystery", owner_id=None)

    def _matching_keys(self, **filter_kwargs) -> set[str]:
        clauses, params = _build_transaction_filter(**filter_kwargs)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._use_db_path(), get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT t.id
                FROM   txn t
                JOIN   account  a ON a.id = t.account_id
                LEFT JOIN account  p ON p.id = a.parent_account_id
                LEFT JOIN category c ON c.id = t.category_id
                LEFT JOIN category pc ON pc.id = c.parent_id
                {where}
                """,
                params,
            ).fetchall()
        found = {row["id"] for row in rows}
        return {key for key, txn_id in self.ids.items() if txn_id in found}

    # --- exclusion keeps NULL-membership rows ---------------------------------------------------

    def test_exclude_category_keeps_uncategorized(self):
        # "not Groceries" must keep the uncategorized row (a NULL category is not Groceries).
        self.assertEqual(self._matching_keys(exclude_category_ids=self.groceries), {"dining", "uncat"})

    def test_exclude_group_keeps_uncategorized(self):
        # "not in Food" drops both Food leaves but keeps the NULL-category row.
        self.assertEqual(self._matching_keys(exclude_group_ids=self.food), {"uncat"})

    def test_exclude_owner_keeps_unowned(self):
        # "not owned by the shared owner" keeps the unowned (NULL owner) row.
        self.assertEqual(self._matching_keys(exclude_owner_ids=SHARED_OWNER_ID), {"uncat"})

    def test_exclude_unassigned_owner_drops_only_unowned(self):
        self.assertEqual(self._matching_keys(exclude_owner_ids="unassigned"), {"groc", "dining"})

    def test_exclude_account(self):
        self.assertEqual(self._matching_keys(exclude_account_ids=self.a1), {"uncat"})

    def test_exclude_payee_keeps_nonmatching(self):
        self.assertEqual(self._matching_keys(exclude_payees="Whole Foods"), {"dining", "uncat"})

    # --- composition & include parity -----------------------------------------------------------

    def test_include_and_exclude_compose(self):
        # account a1 (include) AND not Dining (exclude) -> only groceries.
        self.assertEqual(self._matching_keys(account_ids=self.a1, exclude_category_ids=self.dining), {"groc"})

    def test_include_unchanged(self):
        self.assertEqual(self._matching_keys(category_ids=self.groceries), {"groc"})

    def _add_salary(self) -> None:
        income = self._insert_category(name="Income", parent_id=None, category_type="income")
        self.salary = self._insert_category(name="Salary", parent_id=income, category_type="income")
        self._insert_txn(key="salary", account_id=self.a2, category_id=self.salary, amount=-900.0,
                         merchant="Employer", owner_id=SHARED_OWNER_ID)

    def test_group_and_leaf_of_another_group_widen(self):
        # Groups and leaves are picked from one tree, so they are one selection and OR.
        self._add_salary()
        self.assertEqual(self._matching_keys(group_ids=self.food, category_ids=self.salary),
                         {"groc", "dining", "salary"})

    def test_excluded_leaf_carves_out_of_included_group(self):
        self.assertEqual(self._matching_keys(group_ids=self.food, exclude_category_ids=self.dining), {"groc"})

    def test_group_scope_narrows_the_category_selection(self):
        # A drill into one group lists that group's rows *under* the filter, never the filter's union.
        self._add_salary()
        self.assertEqual(
            self._matching_keys(group_id=self.food, group_ids=self.food, category_ids=self.salary),
            {"groc", "dining"},
        )
        self.assertEqual(self._matching_keys(group_id=self.food, category_ids=self.groceries), {"groc"})

    def test_group_scope_names_a_synthetic_bucket(self):
        from backend.routers.transactions import UNCATEGORIZED_EXPENSE_CATEGORY_ID
        self.assertEqual(self._matching_keys(group_id=UNCATEGORIZED_EXPENSE_CATEGORY_ID), {"uncat"})

    def test_exclude_synthetic_uncategorized_bucket(self):
        from backend.routers.transactions import UNCATEGORIZED_EXPENSE_CATEGORY_ID
        # Excluding the expense-side uncategorized bucket drops the NULL/positive row, keeps the rest.
        self.assertEqual(
            self._matching_keys(exclude_category_ids=UNCATEGORIZED_EXPENSE_CATEGORY_ID),
            {"groc", "dining"},
        )

    def test_exclude_emits_null_safe_negation(self):
        clauses, _ = _build_transaction_filter(exclude_category_ids=self.groceries)
        where = " AND ".join(clauses)
        self.assertIn("COALESCE(", where)
        self.assertIn(") = 0", where)

    # --- tag exclusion: inheritance-aware, block-aware -----------------------------------------

    def test_exclude_tag_honors_all_inheritance_paths(self):
        # "Business" reaches each row through a different path: groc directly, dining via its category,
        # uncat via its account. Excluding it must drop all three, proving inheritance is honored.
        biz = self._insert_tag("Business")
        self._attach_txn_tag("groc", biz, manual_state=1)
        self._attach_category_tag(self.dining, biz)
        self._attach_account_tag(self.a2, biz)
        self.assertEqual(self._matching_keys(tag_ids=biz), {"groc", "dining", "uncat"})
        self.assertEqual(self._matching_keys(exclude_tag_ids=biz), set())

    def test_exclude_tag_keeps_untagged_rows(self):
        biz = self._insert_tag("Business")
        self._attach_txn_tag("groc", biz, manual_state=1)
        # Only groc has the tag, so excluding it keeps the other two.
        self.assertEqual(self._matching_keys(exclude_tag_ids=biz), {"dining", "uncat"})

    def test_exclude_tag_respects_manual_block(self):
        # dining inherits Business via its category but the user hid it on that row (manual_state = -1),
        # so dining effectively does NOT have Business: it drops out of include and survives exclude.
        biz = self._insert_tag("Business")
        self._attach_category_tag(self.dining, biz)
        self._attach_txn_tag("dining", biz, manual_state=-1)
        self.assertEqual(self._matching_keys(tag_ids=biz), set())
        self.assertEqual(self._matching_keys(exclude_tag_ids=biz), {"groc", "dining", "uncat"})

    def test_require_all_tags_needs_every_tag(self):
        biz = self._insert_tag("Business")
        trav = self._insert_tag("Travel")
        self._attach_txn_tag("groc", biz, manual_state=1)
        self._attach_txn_tag("groc", trav, manual_state=1)   # groc has both
        self._attach_txn_tag("dining", biz, manual_state=1)  # dining has only Business
        self.assertEqual(self._matching_keys(require_all_tag_ids=f"{biz},{trav}"), {"groc"})
        # A single required tag behaves like plain has-that-tag.
        self.assertEqual(self._matching_keys(require_all_tag_ids=biz), {"groc", "dining"})

    def test_require_all_is_independent_of_or_tag_ids(self):
        # require_all (AND) and tag_ids (OR) compose: has BOTH biz+trav, AND has any of {other}.
        biz = self._insert_tag("Business")
        trav = self._insert_tag("Travel")
        other = self._insert_tag("Other")
        self._attach_txn_tag("groc", biz, manual_state=1)
        self._attach_txn_tag("groc", trav, manual_state=1)
        self._attach_txn_tag("groc", other, manual_state=1)   # groc: biz+trav+other
        self._attach_txn_tag("dining", biz, manual_state=1)
        self._attach_txn_tag("dining", trav, manual_state=1)  # dining: biz+trav (no other)
        self.assertEqual(
            self._matching_keys(require_all_tag_ids=f"{biz},{trav}", tag_ids=other),
            {"groc"},
        )

    def test_exclude_tag_emits_not_exists(self):
        biz = self._insert_tag("Business")
        clauses, _ = _build_transaction_filter(exclude_tag_ids=biz)
        where = " AND ".join(clauses)
        self.assertIn("NOT (", where)
        self.assertIn("EXISTS", where)

    # --- the synthetic "Untagged" bucket (no effective tag) ------------------------------------

    def test_untagged_include_when_nothing_tagged(self):
        from backend.services.transaction_tags import UNTAGGED_FILTER_ID
        self.assertEqual(self._matching_keys(tag_ids=UNTAGGED_FILTER_ID), {"groc", "dining", "uncat"})

    def test_untagged_excludes_directly_tagged(self):
        from backend.services.transaction_tags import UNTAGGED_FILTER_ID
        biz = self._insert_tag("Business")
        self._attach_txn_tag("groc", biz, manual_state=1)
        self.assertEqual(self._matching_keys(tag_ids=UNTAGGED_FILTER_ID), {"dining", "uncat"})

    def test_untagged_respects_inheritance(self):
        from backend.services.transaction_tags import UNTAGGED_FILTER_ID
        biz = self._insert_tag("Business")
        self._attach_account_tag(self.a1, biz)  # groc + dining inherit; uncat (a2) does not
        self.assertEqual(self._matching_keys(tag_ids=UNTAGGED_FILTER_ID), {"uncat"})

    def test_untagged_counts_blocked_only_row_as_untagged(self):
        from backend.services.transaction_tags import UNTAGGED_FILTER_ID
        biz = self._insert_tag("Business")
        self._attach_account_tag(self.a1, biz)          # groc + dining inherit Business
        self._attach_txn_tag("groc", biz, manual_state=-1)  # …but groc has it hidden -> effectively untagged
        self.assertEqual(self._matching_keys(tag_ids=UNTAGGED_FILTER_ID), {"groc", "uncat"})

    def test_exclude_untagged_returns_only_tagged(self):
        from backend.services.transaction_tags import UNTAGGED_FILTER_ID
        biz = self._insert_tag("Business")
        self._attach_txn_tag("dining", biz, manual_state=1)
        self.assertEqual(self._matching_keys(exclude_tag_ids=UNTAGGED_FILTER_ID), {"dining"})

    def test_list_sum_amount_covers_full_set_not_just_page(self):
        # The list response's sum_amount/total must aggregate the whole filtered set, not the returned
        # page — this is what lets a capped detail panel show a correct header without summing rows.
        with self._use_db_path():
            resp = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc",
                account_id=None, source_account_ids=None, category_id=None,
                direction=None, view=None, search=None, quick_filter=None, ids=None,
                recurring_series_id=None, recurring_excluded_series_id=None,
                import_evidence_type=None,
                needs_review=False, include_trashed=False, limit=1, offset=0,
            )
        self.assertEqual(len(resp["transactions"]), 1)       # page is capped…
        self.assertEqual(resp["total"], 3)                   # …but count is the full set
        self.assertEqual(resp["sum_amount"], 100.0)          # …and so is the sum (50 + 30 + 20)

    def test_untagged_ors_with_real_tag(self):
        from backend.services.transaction_tags import UNTAGGED_FILTER_ID
        biz = self._insert_tag("Business")
        self._attach_txn_tag("groc", biz, manual_state=1)
        # groc has Business; dining + uncat are untagged -> the OR covers all three.
        self.assertEqual(self._matching_keys(tag_ids=f"{biz},{UNTAGGED_FILTER_ID}"), {"groc", "dining", "uncat"})

    # --- CSV export now uses the same effective-tag membership (was direct-only) -----------------

    def _export_merchants(self, **query_kwargs) -> set[str]:
        import asyncio
        from backend.routers.import_export.backup import export_transactions_csv
        # Called directly, so the dependencies and sort that FastAPI would supply are passed explicitly.
        params = dict(date_start=None, date_end=None, search=None)
        params.update(query_kwargs)
        facets, rest = split_facets(params)
        with self._use_db_path():
            resp = export_transactions_csv(
                columns="merchant_name", facets=facets, filters=rest, sort_by="date", sort_dir="desc",
            )

        async def _drain():
            parts = []
            async for chunk in resp.body_iterator:
                parts.append(chunk if isinstance(chunk, str) else chunk.decode())
            return "".join(parts)

        text = asyncio.new_event_loop().run_until_complete(_drain())
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        return set(lines[1:])  # drop the header row

    def test_export_tag_include_sees_inherited_rows(self):
        # The old export filter matched direct tags only, so an account-inherited tag returned nothing.
        # After unification the account-tagged row (uncat → merchant "Mystery") must appear.
        biz = self._insert_tag("Business")
        self._attach_account_tag(self.a2, biz)
        self.assertEqual(self._export_merchants(tag_ids=biz), {"Mystery"})

    def test_export_tag_exclude_drops_inherited_rows(self):
        biz = self._insert_tag("Business")
        self._attach_account_tag(self.a2, biz)
        self.assertEqual(self._export_merchants(exclude_tag_ids=biz), {"Whole Foods", "Cafe"})


if __name__ == "__main__":
    unittest.main()
