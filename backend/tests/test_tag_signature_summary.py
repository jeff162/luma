"""
Server-side tag-report aggregation (`/summary/by-tag-signature`).

The tag-report pie buckets scoped spending by *tag signature* — which of the report's selected tags a
transaction effectively carries. It is computed entirely in SQL so it can't truncate the way the old
client-side aggregation over a 1000-row `/transactions` fetch did (which silently undercounted every
slice on any period with more transactions than the cap). These tests pin the bucketing, inheritance,
the Other bucket, refund netting, filter scoping, and that a >1000-row period is summed in full.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import spending_by_tag_signature
from backend.services.transaction_facets import split_facets


class TagSignatureSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "tag-signature.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            self.food = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, NULL, 'Food', 'expense', 0)",
                (self.food,),
            )
            self.t1 = self._tag(conn, "T1")
            self.t2 = self._tag(conn, "T2")
            self.acct_a = self._account(conn, "A")
            self.acct_b = self._account(conn, "B")
            # Account B carries tag T1, so its rows inherit T1 without a direct attachment.
            conn.execute("INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)", (self.acct_b, self.t1))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _tag(self, conn, name: str) -> str:
        tag_id = str(uuid.uuid4())
        conn.execute("INSERT INTO tag (id, name, color) VALUES (?, ?, '#888')", (tag_id, name))
        return tag_id

    def _account(self, conn, name: str) -> str:
        account_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO account
              (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
            VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
            """,
            (account_id, f"plaid_{account_id}", "fixture_tag_sig", name, name, SHARED_OWNER_ID),
        )
        return account_id

    def _txn(self, *, account_id: str, amount: float, direct_tags=(), category_id=None) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO txn
                  (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                VALUES (?, ?, ?, ?, ?, 'M', 'M', 'M', '2026-04-10', 0, 0)
                """,
                (txn_id, account_id, SHARED_OWNER_ID, category_id or self.food, amount),
            )
            for tag_id in direct_tags:
                conn.execute(
                    "INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, 0, 1)",
                    (txn_id, tag_id),
                )
        return txn_id

    def _signatures(self, **overrides) -> dict[frozenset, tuple]:
        params = dict(
            selected_tag_ids=f"{self.t1},{self.t2}",
            month=None, date_start=None, date_end=None,
            account_id=None, exclude_income=True, exclude_expense=False,
        )
        params.update(overrides)
        facets, rest = split_facets(params)
        with self._use_db_path():
            rows = spending_by_tag_signature(**rest, facets=facets)
        return {frozenset(r["signature_tag_ids"]): (round(r["total"], 2), r["count"]) for r in rows}

    def test_buckets_by_signature_including_inheritance_and_other(self):
        self._txn(account_id=self.acct_a, amount=100.0, direct_tags=[self.t1])
        self._txn(account_id=self.acct_a, amount=50.0, direct_tags=[self.t2])
        self._txn(account_id=self.acct_a, amount=30.0, direct_tags=[self.t1, self.t2])
        self._txn(account_id=self.acct_a, amount=70.0)                       # Other / Untagged
        self._txn(account_id=self.acct_b, amount=40.0)                       # inherits T1 from account B
        sigs = self._signatures()
        self.assertEqual(sigs[frozenset({self.t1})], (140.0, 2))            # 100 direct + 40 inherited
        self.assertEqual(sigs[frozenset({self.t2})], (50.0, 1))
        self.assertEqual(sigs[frozenset({self.t1, self.t2})], (30.0, 1))
        self.assertEqual(sigs[frozenset()], (70.0, 1))                       # Other
        # The four buckets reconcile to the full scoped spending.
        self.assertEqual(sum(v[0] for v in sigs.values()), 290.0)

    def test_refund_nets_within_bucket(self):
        self._txn(account_id=self.acct_a, amount=100.0, direct_tags=[self.t1])
        self._txn(account_id=self.acct_a, amount=-20.0, direct_tags=[self.t1])  # return on a T1 purchase
        self.assertEqual(self._signatures()[frozenset({self.t1})], (80.0, 2))

    def test_net_refund_signature_reads_negative(self):
        # When a signature's refunds outweigh its spend the bucket nets negative and stays that way — the
        # server no longer ABSes it, so the refund isn't hidden as positive "spending".
        self._txn(account_id=self.acct_a, amount=40.0, direct_tags=[self.t1])
        self._txn(account_id=self.acct_a, amount=-100.0, direct_tags=[self.t1])
        self.assertEqual(self._signatures()[frozenset({self.t1})], (-60.0, 2))

    def test_income_signature_reads_positive(self):
        # Income is stored negative; in an income-scoped report each row is negated so received income
        # reads as a positive bucket total (mirroring the category/group summaries).
        with self._use_db_path(), get_db() as conn:
            income_cat = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, NULL, 'Salary', 'income', 0)",
                (income_cat,),
            )
        self._txn(account_id=self.acct_a, amount=-300.0, direct_tags=[self.t1], category_id=income_cat)
        sigs = self._signatures(exclude_income=False, exclude_expense=True)
        self.assertEqual(sigs[frozenset({self.t1})], (300.0, 1))

    def test_exclude_tag_filter_applies(self):
        self._txn(account_id=self.acct_a, amount=100.0, direct_tags=[self.t1])
        self._txn(account_id=self.acct_a, amount=50.0, direct_tags=[self.t2])
        # Excluding T1 drops the T1 row entirely; only the T2 bucket remains.
        sigs = self._signatures(exclude_tag_ids=self.t1)
        self.assertNotIn(frozenset({self.t1}), sigs)
        self.assertEqual(sigs[frozenset({self.t2})], (50.0, 1))

    def test_account_filter_applies(self):
        self._txn(account_id=self.acct_a, amount=100.0, direct_tags=[self.t1])
        self._txn(account_id=self.acct_b, amount=40.0)  # inherits T1
        sigs = self._signatures(account_ids=self.acct_b)
        self.assertEqual(sigs[frozenset({self.t1})], (40.0, 1))
        self.assertEqual(sum(v[1] for v in sigs.values()), 1)

    def test_sums_full_period_beyond_old_1000_row_cap(self):
        # The bug this endpoint fixes: 1200 T1 rows must all count, not just the first 1000.
        for _ in range(1200):
            self._txn(account_id=self.acct_a, amount=1.0, direct_tags=[self.t1])
        self.assertEqual(self._signatures()[frozenset({self.t1})], (1200.0, 1200))


if __name__ == "__main__":
    unittest.main()
