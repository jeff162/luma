"""Performance + equivalence guards for the categorizer — a cross-system chokepoint (sync, import,
preview, and retroactive recategorize all flow through `categorize_transaction`).

Two regressions this pins, both of which are silent (correct results, just slow or divergent) and so
would otherwise only surface as a mysterious slowdown like the one that prompted this:

  1. **No N+1.** A batch pass must load the rule set — and the rule/txn tag rows — ONCE, not re-query
     per transaction. Re-querying per row is cheap in isolation but collapses super-linearly under
     concurrent requests (≈60s for 4 concurrent recategorize-preview calls vs sub-second when hoisted).
     This asserts the per-row query count stays flat no matter how many transactions are scanned.

  2. **Preloaded == on-demand.** `categorize_transaction` must return the SAME verdict whether the rules
     are preloaded (the batch path) or loaded on demand (a lone caller). The preload is an optimization
     and must never diverge from the canonical match — that is the "same winner for every caller"
     contract the categorizer docstring promises.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    _seed_default_categories,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.services.categorizer import (
    categorize_transaction,
    load_categorization_rules,
    load_rule_tags_by_id,
    preview_recategorize_count,
    seed_default_rules,
)
from backend.tests._query_count import count_matching, trace_queries

# A mix that exercises both rule hits (the seeded defaults target these) and misses.
MERCHANTS = [
    "WHOLE FOODS MARKET", "STARBUCKS STORE 123", "TRADER JOE'S", "DOORDASH*DINNER",
    "UBER TRIP 9F2", "SHELL OIL 4471", "ACME HARDWARE", "LOCAL BUSINESS XYZ",
]
TXN_COUNT = 40


def _normalize(result):
    # tag_ids are a set semantically; the on-demand and preloaded paths may list them in a different
    # order, so compare order-insensitively.
    if not isinstance(result, dict):
        return result
    return {**result, "tag_ids": sorted(result.get("tag_ids") or [])}


class CategorizerPerfContractTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "cat.db"
        init_db(str(self.db_path))
        # Starter leaves + rules are opt-in now (init only seeds the group skeleton); this perf
        # contract needs a realistic populated rule set, so seed it explicitly.
        with self._use_db_path(), get_db() as conn:
            _seed_default_categories(conn, include_leaves=True)
            seed_default_rules(conn)
        self.account = self._insert_account()
        for i in range(TXN_COUNT):
            self._insert_txn(self.account, MERCHANTS[i % len(MERCHANTS)], -(10 + i), f"2026-03-{(i % 27) + 1:02d}")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type,
                   subtype, mask, owner_id, parent_account_id, trashed_at)
                   VALUES (?, ?, 'fixture', 'Acct', 'Acct', 'credit', 'credit_card', NULL, ?, NULL, NULL)""",
                (account_id, f"plaid_{account_id}", SHARED_OWNER_ID),
            )
        return account_id

    def _insert_txn(self, account_id, merchant, amount, date):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                   display_name, raw_name, date, is_pending, category_overridden, trashed_at)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, NULL)""",
                (txn_id, account_id, SHARED_OWNER_ID, amount, merchant, merchant, merchant, date),
            )
        return txn_id

    def test_batch_preview_loads_rules_once_not_per_transaction(self):
        with self._use_db_path(), get_db() as conn, trace_queries(conn) as statements:
            preview_recategorize_count(conn)

        rule_queries = count_matching(statements, "category_rule")
        # `_get_txn_tag_rows` (the per-row path) is keyed `WHERE txn_id = ?`; the hoisted preload is not.
        per_txn_tag_queries = sum(
            1 for s in statements if "txn_tag" in s.lower() and "txn_id = ?" in s.lower()
        )

        # 40 transactions are scanned; the old N+1 issued ~40 of each. The hoist keeps both flat.
        self.assertLessEqual(
            rule_queries, 2,
            f"category_rule re-queried per transaction (N+1 regression): {rule_queries} queries for {TXN_COUNT} txns",
        )
        self.assertEqual(
            per_txn_tag_queries, 0,
            f"txn_tag re-queried per transaction (tag-check N+1 regression): {per_txn_tag_queries}",
        )

    def test_preloaded_rules_match_on_demand(self):
        with self._use_db_path(), get_db() as conn:
            rules = load_categorization_rules(conn)
            rule_tags_by_id = load_rule_tags_by_id(conn)
            txns = conn.execute(
                "SELECT merchant_name, raw_name, display_name, amount, owner_id, account_id FROM txn"
            ).fetchall()
            self.assertEqual(len(txns), TXN_COUNT)
            for t in txns:
                on_demand = categorize_transaction(
                    t["merchant_name"], t["raw_name"], t["display_name"], t["amount"], conn,
                    owner_id=t["owner_id"], account_id=t["account_id"],
                )
                preloaded = categorize_transaction(
                    t["merchant_name"], t["raw_name"], t["display_name"], t["amount"], conn,
                    owner_id=t["owner_id"], account_id=t["account_id"],
                    rules=rules, rule_tags_by_id=rule_tags_by_id,
                )
                self.assertEqual(_normalize(on_demand), _normalize(preloaded))


if __name__ == "__main__":
    unittest.main()
