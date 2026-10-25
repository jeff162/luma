"""
The facet registry's coverage guard.

`services/transaction_facets.py` exists so that a filter axis is declared once and reaches every surface
that filters transactions. That property is only worth anything if it is *checked*, because its failure
mode is silent: an endpoint that never learned about a facet keeps answering, unfiltered, and the caller
sees a total that no longer matches the list it drills into.

So the first test here enumerates the endpoints from the live app and asserts each one accepts every
facet parameter. Adding a facet to the registry with an endpoint left behind fails here rather than in
someone's report six months later.

The rest guard the two things the registry has to get right beyond mere presence — that exclusion is the
NULL-safe negation of the *same* membership (so a row the include set misses survives its exclusion), and
that the synthetic uncategorized buckets are honored on the export, which is the case that was actually
broken before the registry existed: the export hand-rolled its own membership SQL and compared the
synthetic ids as though they were real category rows, so an Uncategorized chip produced an empty file.
"""

from __future__ import annotations

import asyncio
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import import_export, transactions as transactions_router
from backend.routers.import_export.backup import export_transactions_csv
from backend.routers.transactions import (
    _BULK_FILTER_KEYS, _build_transaction_filter, list_payee_names, list_transactions,
)
from backend.services.transaction_facets import (
    AMOUNT_PARAM_NAMES,
    FACET_PARAM_NAMES,
    FACETS,
    TransactionFacets,
    UNCATEGORIZED_EXPENSE_CATEGORY_ID,
)

# Every endpoint that filters transactions and is fed by the shared FilterBar. Listed by path rather
# than discovered, because "which endpoints should carry the facets" is a decision, not a fact about the
# code — a new reporting endpoint has to be added here deliberately.
FACETED_ENDPOINTS = (
    "/api/transactions",
    "/api/transactions/summary/by-category",
    "/api/transactions/summary/by-tag-signature",
    "/api/transactions/summary/by-group",
    "/api/transactions/summary/by-category-in-group",
    "/api/transactions/summary/monthly-trend",
    "/api/transactions/summary/range-trend",
    "/api/transactions/summary/monthly-cash-flow",
    "/api/transactions/summary/monthly-by-group",
    "/api/import-export/transactions.csv",
)


class FacetCoverageTests(unittest.TestCase):
    @staticmethod
    def _spec():
        # Mounted here rather than imported from `backend.main`, whose module-level init touches the
        # real control database (conftest refuses it, correctly). The prefixes mirror main.py.
        app = FastAPI()
        app.include_router(transactions_router.router, prefix="/api/transactions")
        app.include_router(import_export.router, prefix="/api/import-export")
        return app.openapi()

    def test_every_faceted_endpoint_accepts_every_facet(self):
        spec = self._spec()
        for path in FACETED_ENDPOINTS:
            with self.subTest(path=path):
                self.assertIn(path, spec["paths"], f"{path} is not a route any more")
                accepted = {p["name"] for p in spec["paths"][path]["get"].get("parameters", [])}
                missing = sorted(FACET_PARAM_NAMES - accepted)
                self.assertEqual(missing, [], f"{path} does not accept: {missing}")

    def test_every_faceted_endpoint_accepts_the_amount_filter(self):
        # The FilterBar's amount filter narrows the same surfaces its chips do, so an endpoint missing it
        # reports a figure its drill list does not match.
        spec = self._spec()
        for path in FACETED_ENDPOINTS:
            with self.subTest(path=path):
                accepted = {p["name"] for p in spec["paths"][path]["get"].get("parameters", [])}
                missing = sorted(AMOUNT_PARAM_NAMES - accepted)
                self.assertEqual(missing, [], f"{path} does not accept: {missing}")

    def test_bulk_allowlist_covers_every_facet(self):
        # A facet missing here does not fail closed. Every filter narrows, so bulk would resolve a
        # *wider* set than the count the user is looking at — which has happened before, with
        # `needs_review`. Deriving the set is the fix; this asserts the derivation still holds.
        self.assertTrue(FACET_PARAM_NAMES <= _BULK_FILTER_KEYS)

    def test_each_facet_declares_an_exclude_parameter(self):
        # "is not" is offered on every facet the FilterBar shows. A facet with no exclude param would
        # render an inert ≠ affordance rather than an error, so assert the pairing structurally.
        for facet in FACETS:
            with self.subTest(facet=facet.name):
                self.assertTrue(facet.exclude_param, f"{facet.name} has no exclude parameter")


class FacetSemanticsTests(unittest.TestCase):
    """Behavioral guards, run against a seeded database rather than against the emitted SQL."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "facets.db"
        init_db(str(self.db_path))
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

    def _seed(self):
        self.account = str(uuid.uuid4())
        self.group = str(uuid.uuid4())
        self.leaf = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype, mask,
                   owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture_facets', 'Checking', 'Checking', 'checking', 'checking', '4321', ?, NULL, NULL)
                """,
                (self.account, f"acct_{self.account}", SHARED_OWNER_ID),
            )
            conn.execute(
                "INSERT INTO category (id, name, parent_id, category_type) VALUES (?, 'Food', NULL, 'expense')",
                (self.group,),
            )
            conn.execute(
                "INSERT INTO category (id, name, parent_id, category_type) VALUES (?, 'Groceries', ?, 'expense')",
                (self.leaf, self.group),
            )
            # One categorized row and one deliberately uncategorized expense row — the latter is the
            # only one the synthetic bucket should select.
            for txn_id, merchant, category_id in (
                ("txn-cat", "Whole Foods", self.leaf),
                ("txn-uncat", "Mystery", None),
            ):
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, date, amount, merchant_name, display_name, raw_name,
                       category_id, owner_id, is_pending, needs_review)
                    VALUES (?, ?, '2026-05-10', 25.0, ?, ?, ?, ?, ?, 0, 0)
                    """,
                    (txn_id, self.account, merchant, merchant, merchant, category_id, SHARED_OWNER_ID),
                )

    def _ledger_ids(self, *, require_all_attribute_ids=None, **facet_kwargs) -> set[str]:
        with self._use_db_path():
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc", account_id=None, category_id=None,
                facets=TransactionFacets(**facet_kwargs),
                require_all_attribute_ids=require_all_attribute_ids,
                direction=None, search=None, quick_filter=None, limit=200, offset=0,
            )
        return {txn["id"] for txn in result["transactions"]}

    def _export_merchants(self, **facet_kwargs) -> set[str]:
        with self._use_db_path():
            resp = export_transactions_csv(
                columns="merchant_name", facets=TransactionFacets(**facet_kwargs),
                filters={}, sort_by="date", sort_dir="desc",
            )

        async def _drain():
            parts = []
            async for chunk in resp.body_iterator:
                parts.append(chunk if isinstance(chunk, str) else chunk.decode())
            return "".join(parts)

        text = asyncio.new_event_loop().run_until_complete(_drain())
        rows = [line.strip() for line in text.splitlines() if line.strip()]
        return set(rows[1:])  # drop the header

    def test_export_honors_the_synthetic_uncategorized_bucket(self):
        # The regression this whole module exists for: the export used to compare
        # `__uncategorized_expense__` against `category_id` as though it were a real category row, so
        # this returned an empty file while the ledger showed the row.
        self.assertEqual(self._export_merchants(category_ids=UNCATEGORIZED_EXPENSE_CATEGORY_ID), {"Mystery"})

    def test_ledger_and_export_agree_on_the_same_selection(self):
        # The property the registry is for: one chip, one meaning, whichever surface reads it.
        self.assertEqual(self._ledger_ids(category_ids=UNCATEGORIZED_EXPENSE_CATEGORY_ID), {"txn-uncat"})

    def test_excluding_a_category_keeps_the_uncategorized_row(self):
        # NULL-safe negation: `category_id NOT IN (leaf)` is SQL-unknown for a NULL category, which
        # would drop the uncategorized row even though it plainly is not Groceries.
        self.assertEqual(self._ledger_ids(exclude_category_ids=self.leaf), {"txn-uncat"})
        self.assertEqual(self._export_merchants(exclude_category_ids=self.leaf), {"Mystery"})

    def test_a_payee_fragment_ors_with_exact_payees_and_can_be_excluded(self):
        self.assertEqual(self._ledger_ids(payee_contains="hole fo"), {"txn-cat"})
        # One facet, so its two forms widen each other. As separate facets they would AND to nothing.
        self.assertEqual(self._ledger_ids(payees="Mystery", payee_contains="hole fo"), {"txn-cat", "txn-uncat"})
        self.assertEqual(self._ledger_ids(exclude_payee_contains="hole fo"), {"txn-uncat"})
        # What was typed is text, not a pattern.
        self.assertEqual(self._ledger_ids(payee_contains="%"), set())

    def test_payee_names_are_distinct_names_containing_the_fragment(self):
        # The list this replaces read names off ten *transactions* found by the ledger search, so one
        # busy payee hid the rest and a row matching on its category offered an unrelated name.
        with self._use_db_path(), get_db() as conn:
            for index in range(12):
                conn.execute(
                    "INSERT INTO txn (id, account_id, date, amount, display_name, category_id, owner_id, "
                    "is_pending, needs_review) VALUES (?, ?, '2026-05-11', 5.0, 'Corner Grocer', ?, ?, 0, 0)",
                    (f"txn-busy-{index}", self.account, self.leaf, SHARED_OWNER_ID),
                )
            conn.execute(
                "INSERT INTO txn (id, account_id, date, amount, display_name, owner_id, is_pending, needs_review) "
                "VALUES ('txn-once', ?, '2026-05-12', 5.0, 'GROCERY Outlet', ?, 0, 0)",
                (self.account, SHARED_OWNER_ID),
            )
        with self._use_db_path():
            # "Whole Foods" is filed under Groceries and does not contain the fragment.
            self.assertEqual(list_payee_names(q="grocer", limit=20), ["Corner Grocer", "GROCERY Outlet"])

    def test_an_unknown_facet_kwarg_is_refused(self):
        # The builder takes facets as **kwargs so that adding one touches only the registry. That must
        # not cost the typo-safety an explicit signature gave: a misspelled facet has to raise rather
        # than be silently dropped, because a dropped filter *widens* the result it was meant to narrow.
        with self.assertRaises(TypeError):
            _build_transaction_filter(atribute_ids="recurring")

    def test_an_unknown_attribute_key_narrows_to_nothing_rather_than_raising(self):
        # A key is a value, not a parameter name: a stale one from an old link should express what it
        # still can instead of failing the request. Alone, it selects no predicate at all.
        self.assertEqual(self._ledger_ids(attribute_ids="not-an-attribute"), {"txn-cat", "txn-uncat"})

    def test_attribute_include_and_exclude(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE txn SET notes = 'check this' WHERE id = 'txn-uncat'")
        self.assertEqual(self._ledger_ids(attribute_ids="note"), {"txn-uncat"})
        self.assertEqual(self._ledger_ids(exclude_attribute_ids="note"), {"txn-cat"})

    def test_attributes_within_the_facet_or_together(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE txn SET notes = 'check this' WHERE id = 'txn-uncat'")
            conn.execute("UPDATE txn SET is_split = 1 WHERE id = 'txn-cat'")
        # Within one facet values OR — the rule every other facet follows.
        self.assertEqual(self._ledger_ids(attribute_ids="note,split"), {"txn-cat", "txn-uncat"})

    def test_attributes_and_another_facet_and_together(self):
        # Across facets everything ANDs, which is the whole reason "recurring" stopped being a pseudo-tag.
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE txn SET notes = 'check this' WHERE id = 'txn-uncat'")
        self.assertEqual(self._ledger_ids(attribute_ids="note", category_ids=self.leaf), set())

    def test_the_toolbar_constraint_narrows_rather_than_widening(self):
        # The ledger's toolbar filter is a separate control from the FilterBar's attribute chips, so
        # applying it on top of one has to narrow. Were it folded into the facet's OR list instead,
        # this would return *both* rows — a second filter widening the result, which is the one thing a
        # filter must never do. That is the mistake this parameter exists to prevent.
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE txn SET notes = 'check this' WHERE id = 'txn-uncat'")
            conn.execute("UPDATE txn SET is_split = 1 WHERE id = 'txn-cat'")
        both = self._ledger_ids(attribute_ids="split", require_all_attribute_ids="note")
        self.assertEqual(both, set())
        self.assertEqual(
            self._ledger_ids(attribute_ids="note", require_all_attribute_ids="note"),
            {"txn-uncat"},
        )

    def test_the_toolbar_constraint_ands_several_keys(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE txn SET notes = 'check this', is_split = 1 WHERE id = 'txn-uncat'")
            conn.execute("UPDATE txn SET is_split = 1 WHERE id = 'txn-cat'")
        self.assertEqual(self._ledger_ids(require_all_attribute_ids="note,split"), {"txn-uncat"})

    def test_facets_are_optional_on_a_direct_call(self):
        # Direct (non-HTTP) callers may omit the dependency entirely; the FastAPI sentinel must read as
        # "nothing selected" rather than filtering on a FieldInfo object.
        clauses, params = _build_transaction_filter()
        self.assertEqual(clauses, ["t.trashed_at IS NULL"])
        self.assertEqual(params, [])


class AccountTypeFacetTests(unittest.TestCase):
    """The account facet named by type: every account of a type, by its group's type when merged."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "account-types.db"
        init_db(str(self.db_path))
        self.accounts = {}
        with self._use_db_path(), get_db() as conn:
            # `merged` is a checking-typed account merged into card A, so it reads as a credit card.
            for key, account_type, parent in (
                ("card_a", "credit", None),
                ("card_b", "credit", None),
                ("checking", "depository", None),
                ("merged", "depository", "card_a"),
            ):
                account_id = str(uuid.uuid4())
                self.accounts[key] = account_id
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask,
                       owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, 'fixture_facets', ?, ?, ?, NULL, NULL, ?, ?, NULL)
                    """,
                    (account_id, f"acct_{account_id}", key, key, account_type, SHARED_OWNER_ID,
                     self.accounts[parent] if parent else None),
                )
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, date, amount, merchant_name, display_name, raw_name,
                       owner_id, is_pending, needs_review)
                    VALUES (?, ?, '2026-05-10', 10.0, 'Shop', 'Shop', 'Shop', ?, 0, 0)
                    """,
                    (f"txn-{key}", account_id, SHARED_OWNER_ID),
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

    def _ledger_keys(self, **facet_kwargs) -> set[str]:
        with self._use_db_path():
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc", account_id=None, category_id=None,
                facets=TransactionFacets(**facet_kwargs),
                direction=None, search=None, quick_filter=None, limit=200, offset=0,
            )
        return {txn["id"].removeprefix("txn-") for txn in result["transactions"]}

    def test_a_type_selects_every_account_of_it_including_merged_children(self):
        self.assertEqual(self._ledger_keys(account_types="credit"), {"card_a", "card_b", "merged"})

    def test_a_type_ors_with_named_accounts(self):
        self.assertEqual(
            self._ledger_keys(account_types="credit", account_ids=self.accounts["checking"]),
            {"card_a", "card_b", "merged", "checking"},
        )

    def test_excluding_a_type_drops_every_account_of_it(self):
        self.assertEqual(self._ledger_keys(exclude_account_types="credit"), {"checking"})

    def test_an_excluded_account_is_carved_out_of_an_included_type(self):
        self.assertEqual(
            self._ledger_keys(account_types="credit", exclude_account_ids=self.accounts["card_b"]),
            {"card_a", "merged"},
        )
