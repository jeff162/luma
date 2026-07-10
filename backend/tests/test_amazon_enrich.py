"""
The Amazon enrich-via-link engine (`routers/import_export/amazon.py`): materialize a parsed order into
the ledger — item transactions, net-cash allocation, charge match + exclusion, the link — and reverse it.

All order data here is fabricated.
"""

from __future__ import annotations

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
from backend.routers.import_export.amazon import (
    BATCH_SOURCE_KIND,
    LINK_KIND,
    apply_amazon_order,
    find_or_create_funding_category,
    reverse_amazon_order,
    reverse_batch_amazon_links,
    run_amazon_import,
)
from backend.services.amazon_import import AmazonItem, AmazonOrder, PaymentLeg
from backend.services import amazon_funding, txn_links


def _cash_order(order_id="111-0000000-0000010", last4="4321", amount=37.32, refund=None):
    return AmazonOrder(
        order_id=order_id,
        order_date="2024-11-19",
        total=amount,
        tax=2.19,
        refund=refund,
        payment_legs=[PaymentLeg(method="Test Card", last4=last4, date="2024-11-19", amount=amount)],
        items=[
            AmazonItem(description="Air Widget", price=34.99, category="Electronics›Widgets", asin="B0AAA"),
            AmazonItem(description="Widget Picks", price=5.32, category="Health›Picks", asin="B0BBB", quantity=2),
        ],
        has_order_detail=True,
        has_item_detail=True,
    )


class AmazonEnrichTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "amz.db"
        init_db(str(self.db_path))
        self.batch_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
                   VALUES ('amazon', 'p_amazon', 'fixture', 'Amazon', 'Amazon', 'other', ?)""",
                (SHARED_OWNER_ID,),
            )
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, mask, owner_id)
                   VALUES ('card', 'p_card', 'fixture', 'Rewards Card', 'Rewards Card', 'credit', '4321', ?)""",
                (SHARED_OWNER_ID,),
            )
            conn.execute("INSERT INTO import_batch (id, filename) VALUES (?, 'amazon.csv')", (self.batch_id,))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _add_card_charge(self, amount=37.32, date="2024-11-19", account_id="card"):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                   VALUES (?, ?, ?, ?, 'AMAZON.COM', 'AMAZON.COM', 'AMAZON.COM', ?, 0)""",
                (txn_id, account_id, SHARED_OWNER_ID, amount, date),
            )
        return txn_id

    def _txn(self, txn_id):
        with self._use_db_path(), get_db() as conn:
            row = conn.execute("SELECT * FROM txn WHERE id = ?", (txn_id,)).fetchone()
        return dict(row) if row else None

    def _amazon_items(self):
        with self._use_db_path(), get_db() as conn:
            rows = conn.execute("SELECT * FROM txn WHERE account_id = 'amazon' ORDER BY amount DESC").fetchall()
        return [dict(r) for r in rows]

    # ---- cash order with a matching card charge ---------------------------------------------------

    def test_cash_order_creates_allocated_items_and_excludes_charge(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)

        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["disposition"], "cash")
        self.assertTrue(result["charge_linked"])

        items = self._amazon_items()
        self.assertEqual(len(items), 2)
        # Allocation ties out to the charge exactly, and cash items are counted (category NULL = Unassigned).
        self.assertAlmostEqual(sum(i["amount"] for i in items), 37.32, places=2)
        self.assertGreater(items[0]["amount"], items[1]["amount"])  # pricier item, larger share
        self.assertTrue(all(i["category_id"] is None for i in items))
        self.assertTrue(all(i["needs_review"] == 1 for i in items))

        # The charge is moved into the excluded funding category.
        with self._use_db_path(), get_db() as conn:
            funding_id = find_or_create_funding_category(conn)
            excl = conn.execute(
                "SELECT COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS ex "
                "FROM category c LEFT JOIN category pc ON pc.id = c.parent_id WHERE c.id = ?",
                (funding_id,),
            ).fetchone()["ex"]
        self.assertEqual(excl, 1)
        charge = self._txn(charge_id)
        self.assertEqual(charge["category_id"], funding_id)
        self.assertEqual(charge["category_source"], "enrichment")

        # The link ties charge↔items and records the prior category for undo.
        with self._use_db_path(), get_db() as conn:
            link = txn_links.find_link(conn, LINK_KIND, _cash_order().order_id)
        roles = sorted(m["role"] for m in link["members"])
        self.assertEqual(roles, ["charge", "item", "item"])
        self.assertIn("charge_prior", link["metadata"])
        self.assertIsNone(link["metadata"]["charge_prior"]["category_id"])

    def test_reverse_restores_charge_and_deletes_items(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            link_id = result["link_id"]
            reversed_result = reverse_amazon_order(conn, link_id)

        self.assertEqual(reversed_result["status"], "reversed")
        self.assertEqual(reversed_result["items_removed"], 2)
        self.assertEqual(self._amazon_items(), [])            # items gone
        charge = self._txn(charge_id)
        self.assertIsNone(charge["category_id"])              # prior (uncategorized) restored
        self.assertNotEqual(charge["category_source"], "enrichment")
        with self._use_db_path(), get_db() as conn:
            self.assertIsNone(txn_links.get_link(conn, link_id))

    def test_reverse_restores_a_manual_category(self):
        # A charge the user had manually categorized: we override it, but undo must restore it exactly.
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            leaf = conn.execute("INSERT INTO category (id, name, category_type) VALUES ('shop', 'Shopping', 'expense')")
            conn.execute("UPDATE txn SET category_id = 'shop', category_source = 'manual', category_overridden = 1 WHERE id = ?", (charge_id,))
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            # Overridden to funding while applied.
            self.assertNotEqual(self._txn(charge_id)["category_id"], "shop")
            reverse_amazon_order(conn, result["link_id"])
        restored = self._txn(charge_id)
        self.assertEqual(restored["category_id"], "shop")
        self.assertEqual(restored["category_source"], "manual")
        self.assertEqual(restored["category_overridden"], 1)

    # ---- non-cash and unmatched dispositions ------------------------------------------------------

    def test_non_cash_order_records_items_excluded_without_a_charge(self):
        order = _cash_order(order_id="points-1")
        order.payment_legs = [
            PaymentLeg(method="Test Card", last4="4321", date=None, amount=None),
            PaymentLeg(method="Rewards Points", last4=None, date=None, amount=None, is_non_cash=True),
        ]
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id)
            funding_id = find_or_create_funding_category(conn)
        self.assertEqual(result["disposition"], "non_cash")
        self.assertFalse(result["charge_linked"])
        items = self._amazon_items()
        self.assertEqual(len(items), 2)
        # Non-cash items are recorded in the excluded category so they don't count.
        self.assertTrue(all(i["category_id"] == funding_id for i in items))

    def test_cash_order_with_no_matching_charge_keeps_items_counted(self):
        # Untracked card: no ledger charge to match, so the items are the sole record and still count.
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(last4="9999"), account_id="amazon", batch_id=self.batch_id)
        self.assertEqual(result["disposition"], "cash")
        self.assertFalse(result["charge_linked"])
        items = self._amazon_items()
        self.assertAlmostEqual(sum(i["amount"] for i in items), 37.32, places=2)
        self.assertTrue(all(i["category_id"] is None for i in items))

    def test_ambiguous_charge_is_left_unmatched(self):
        # Two identical candidate charges → ambiguous → no auto-link (left for manual).
        self._add_card_charge(37.32)
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
        self.assertFalse(result["charge_linked"])

    def test_mapped_instrument_disambiguates_same_amount_charges(self):
        # Two same-amount charges on different accounts would be ambiguous → no auto-match. The funding
        # map names which account this instrument charges, constraining the search to it so the match
        # resolves. (setUp's 'card' carries mask '4321'; the order's leg is last4 '4321'/'Test Card'.)
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
                   VALUES ('card2', 'p_card2', 'fixture', 'Other Card', 'Other Card', 'credit', ?)""",
                (SHARED_OWNER_ID,),
            )
        on_card = self._add_card_charge(37.32, account_id="card")
        self._add_card_charge(37.32, account_id="card2")
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4321", network="Test Card",
                                                 funding_account_id="card")
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            funding_id = find_or_create_funding_category(conn)
        self.assertTrue(result["charge_linked"])
        self.assertEqual(result["funding_state"], "mapped")
        # The mapped account's charge is the one excluded; the same-amount decoy is untouched.
        self.assertEqual(self._txn(on_card)["category_id"], funding_id)

    def test_untracked_instrument_skips_charge_match(self):
        # An instrument the user marked "untracked" has no account of ours to charge, so the items are
        # the sole record and count directly — even when a same-amount ledger charge happens to exist.
        charge_id = self._add_card_charge(37.32, account_id="card")
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4321", network="Test Card", untracked=True)
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
        self.assertFalse(result["charge_linked"])
        self.assertEqual(result["funding_state"], "untracked")
        self.assertIsNone(self._txn(charge_id)["category_id"])   # the charge is left alone
        items = self._amazon_items()
        self.assertAlmostEqual(sum(i["amount"] for i in items), 37.32, places=2)  # items counted
        self.assertTrue(all(i["category_id"] is None for i in items))

    def test_maskless_account_still_matches_a_carded_order(self):
        # The common imported-ledger case: accounts carry no card mask. The order names a card last-4,
        # but a maskless account can't contradict it, so amount + date + uniqueness carries the match.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
                   VALUES ('nomask', 'p_nomask', 'fixture', 'Imported Card', 'Imported Card', 'credit', ?)""",
                (SHARED_OWNER_ID,),
            )
        charge_id = self._add_card_charge(37.32, account_id="nomask")
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(last4="4321"), account_id="amazon", batch_id=self.batch_id)
            funding_id = find_or_create_funding_category(conn)
        self.assertTrue(result["charge_linked"])
        self.assertEqual(self._txn(charge_id)["category_id"], funding_id)

    def test_zero_charge_order_does_not_self_match_its_own_item(self):
        # A $0 card leg (gift-card/points funded, reported as $0) has nothing to reconcile. It must never
        # match the order's own just-created $0 item — the charge search excludes the Amazon account and
        # short-circuits on a non-positive amount.
        order = _cash_order(order_id="zero-1", amount=0.0)
        order.total = 0.0
        order.payment_legs = [PaymentLeg(method="Test Card", last4="4321", date="2024-11-19", amount=0.0)]
        order.items = [AmazonItem(description="Freebie", price=0.0, category="Digital", asin="B0ZZZ")]
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id)
        self.assertFalse(result["charge_linked"])
        items = self._amazon_items()
        self.assertEqual(len(items), 1)
        # The $0 item stays an ordinary (uncategorized) item, not excluded into funding as a phantom charge.
        self.assertIsNone(items[0]["category_id"])
        self.assertNotEqual(items[0]["category_source"], "enrichment")

    def test_reimport_is_idempotent(self):
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            second = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
        self.assertEqual(second["status"], "already_applied")
        self.assertEqual(len(self._amazon_items()), 2)  # not duplicated

    # ---- batch-level run + undo -------------------------------------------------------------------

    def test_run_amazon_import_summary(self):
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="amazon.csv")
        self.assertEqual(summary["order_count"], 1)
        self.assertEqual(summary["counts"]["applied_full"], 1)
        self.assertEqual(summary["counts"]["charges_matched"], 1)
        # The batch exists, its item rows are attributed to it, and it carries the marketplace marker
        # the import history groups on.
        with self._use_db_path(), get_db() as conn:
            n = conn.execute("SELECT COUNT(*) FROM txn WHERE import_batch_id = ?", (summary["batch_id"],)).fetchone()[0]
            source_kind = conn.execute("SELECT source_kind FROM import_batch WHERE id = ?", (summary["batch_id"],)).fetchone()[0]
        self.assertEqual(n, 2)
        self.assertEqual(source_kind, BATCH_SOURCE_KIND)

    def test_orders_only_creates_one_coarse_counted_row(self):
        self._add_card_charge(37.32)
        order = _cash_order()
        order.items = []
        order.has_item_detail = False
        order.items_summary = "Air Widget; Widget Picks;"
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [order], account_id="amazon", filename="orders.csv")
        self.assertEqual(summary["counts"]["applied_coarse"], 1)
        self.assertEqual(summary["orphans"]["orders_without_items"], 1)
        items = self._amazon_items()
        self.assertEqual(len(items), 1)
        self.assertAlmostEqual(items[0]["amount"], 37.32, places=2)
        self.assertIsNone(items[0]["category_id"])  # counted
        self.assertEqual(items[0]["display_name"], "Air Widget; Widget Picks;")

    def test_reverse_batch_restores_charge_outside_the_batch(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="amazon.csv")
            # Simulate undo_batch's order: reverse links, then delete the batch's own rows.
            reversed_count = reverse_batch_amazon_links(conn, summary["batch_id"])
            conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (summary["batch_id"],))
        self.assertEqual(reversed_count, 1)
        self.assertIsNone(self._txn(charge_id)["category_id"])  # charge restored
        self.assertEqual(self._amazon_items(), [])              # items gone


if __name__ == "__main__":
    unittest.main()
