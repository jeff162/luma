"""
The Amazon orders-only engine (`routers/import_export/amazon.py`): materialize a parsed order as a single
spending transaction in the Amazon account, match + exclude + link its funding card charge, fold a later
items file's detail into evidence, and reverse it all.

All order data here is fabricated.
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
from backend.routers.import_export.amazon import (
    BATCH_SOURCE_KIND,
    LINK_KIND,
    amazon_reconciliation,
    apply_amazon_order,
    find_or_create_funding_category,
    manual_link_charge,
    reverse_amazon_order,
    reverse_batch_amazon_links,
    run_amazon_import,
)
from backend.services.amazon_import import AmazonItem, AmazonOrder, PaymentLeg, merge
from backend.services import amazon_funding, txn_links


def _cash_order(order_id="111-0000000-0000010", last4="4321", amount=37.32, refund=None):
    return AmazonOrder(
        order_id=order_id,
        order_date="2024-11-19",
        total=amount,
        tax=2.19,
        refund=refund,
        items_summary="Air Widget; Widget Picks;",
        payment_legs=[PaymentLeg(method="Test Card", last4=last4, date="2024-11-19", amount=amount)],
        items=[
            AmazonItem(description="Air Widget", price=34.99, asin="B0AAA"),
            AmazonItem(description="Widget Picks", price=5.32, asin="B0BBB", quantity=2),
        ],
        has_order_detail=True,
        has_item_detail=True,
    )


class AmazonOrdersTests(unittest.TestCase):
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

    def _amazon_orders(self):
        with self._use_db_path(), get_db() as conn:
            rows = conn.execute("SELECT * FROM txn WHERE account_id = 'amazon' ORDER BY date DESC").fetchall()
        return [dict(r) for r in rows]

    # ---- cash order with a matching card charge ---------------------------------------------------

    def test_cash_order_creates_one_txn_and_excludes_charge(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)

        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["disposition"], "cash")
        self.assertTrue(result["charge_linked"])

        # Exactly one order transaction, amount = net cash, counted (category NULL), memo = item list.
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        self.assertAlmostEqual(orders[0]["amount"], 37.32, places=2)
        self.assertIsNone(orders[0]["category_id"])
        self.assertEqual(orders[0]["needs_review"], 1)
        self.assertEqual(orders[0]["display_name"], "Air Widget; Widget Picks;")
        # Item detail rides in evidence (not as rows): the item names + reference bits are captured.
        evidence = json.loads(orders[0]["import_evidence_json"])
        item_fields = [f["value"] for f in evidence["extra_text_fields"] if f["header"] == "Item"]
        self.assertEqual(len(item_fields), 2)
        self.assertIn("B0AAA", item_fields[0])  # ASIN captured as reference

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

        # The link ties charge↔order and records the prior category for undo.
        with self._use_db_path(), get_db() as conn:
            link = txn_links.find_link(conn, LINK_KIND, _cash_order().order_id)
        roles = sorted(m["role"] for m in link["members"])
        self.assertEqual(roles, ["charge", "order"])
        self.assertIn("charge_prior", link["metadata"])
        self.assertIsNone(link["metadata"]["charge_prior"]["category_id"])

    def test_refund_reduces_counted_amount(self):
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(refund=10.0), account_id="amazon", batch_id=self.batch_id)
        # net cash = 37.32 − 10.00 refund
        self.assertAlmostEqual(self._amazon_orders()[0]["amount"], 27.32, places=2)

    def test_reverse_restores_charge_and_deletes_order(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            link_id = result["link_id"]
            reversed_result = reverse_amazon_order(conn, link_id)

        self.assertEqual(reversed_result["status"], "reversed")
        self.assertEqual(reversed_result["orders_removed"], 1)
        self.assertEqual(self._amazon_orders(), [])           # order row gone
        charge = self._txn(charge_id)
        self.assertIsNone(charge["category_id"])              # prior (uncategorized) restored
        self.assertNotEqual(charge["category_source"], "enrichment")
        with self._use_db_path(), get_db() as conn:
            self.assertIsNone(txn_links.get_link(conn, link_id))

    def test_reverse_restores_a_manual_category(self):
        # A charge the user had manually categorized: we override it, but undo must restore it exactly.
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO category (id, name, category_type) VALUES ('shop', 'Shopping', 'expense')")
            conn.execute("UPDATE txn SET category_id = 'shop', category_source = 'manual', category_overridden = 1 WHERE id = ?", (charge_id,))
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            self.assertNotEqual(self._txn(charge_id)["category_id"], "shop")  # overridden while applied
            reverse_amazon_order(conn, result["link_id"])
        restored = self._txn(charge_id)
        self.assertEqual(restored["category_id"], "shop")
        self.assertEqual(restored["category_source"], "manual")
        self.assertEqual(restored["category_overridden"], 1)

    # ---- non-cash and unmatched dispositions ------------------------------------------------------

    def test_non_cash_order_recorded_excluded_without_a_charge(self):
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
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        # A non-cash order is recorded in the excluded category so it doesn't count.
        self.assertEqual(orders[0]["category_id"], funding_id)

    def test_cash_order_with_no_matching_charge_counts_directly(self):
        # Untracked card: no ledger charge to match, so the order is the sole record and still counts.
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(last4="9999"), account_id="amazon", batch_id=self.batch_id)
        self.assertEqual(result["disposition"], "cash")
        self.assertFalse(result["charge_linked"])
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        self.assertAlmostEqual(orders[0]["amount"], 37.32, places=2)
        self.assertIsNone(orders[0]["category_id"])

    def test_ambiguous_charge_is_left_unmatched(self):
        # Two identical candidate charges → ambiguous → no auto-link (left for manual).
        self._add_card_charge(37.32)
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
        self.assertFalse(result["charge_linked"])

    def test_mapped_instrument_disambiguates_same_amount_charges(self):
        # Two same-amount charges on different accounts would be ambiguous → no auto-match. The funding
        # map names which account this instrument charges, constraining the search to it so it resolves.
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
        self.assertEqual(self._txn(on_card)["category_id"], funding_id)

    def test_untracked_instrument_skips_charge_match(self):
        # An instrument marked "untracked" has no account of ours to charge, so the order counts directly
        # — even when a same-amount ledger charge happens to exist.
        charge_id = self._add_card_charge(37.32, account_id="card")
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4321", network="Test Card", untracked=True)
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
        self.assertFalse(result["charge_linked"])
        self.assertEqual(result["funding_state"], "untracked")
        self.assertIsNone(self._txn(charge_id)["category_id"])   # the charge is left alone
        self.assertAlmostEqual(self._amazon_orders()[0]["amount"], 37.32, places=2)

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

    def test_zero_charge_order_does_not_self_match(self):
        # A $0 card leg (gift-card/points funded, reported as $0) has nothing to reconcile. It must never
        # match its own just-created $0 order row.
        order = _cash_order(order_id="zero-1", amount=0.0)
        order.total = 0.0
        order.payment_legs = [PaymentLeg(method="Test Card", last4="4321", date="2024-11-19", amount=0.0)]
        order.items = [AmazonItem(description="Freebie", price=0.0, asin="B0ZZZ")]
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id)
        self.assertFalse(result["charge_linked"])
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        self.assertIsNone(orders[0]["category_id"])
        self.assertNotEqual(orders[0]["category_source"], "enrichment")

    def test_reimport_is_idempotent(self):
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            second = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
        self.assertEqual(second["status"], "already_applied")
        self.assertEqual(len(self._amazon_orders()), 1)  # not duplicated

    # ---- orders-only, items-file enrichment, discard ----------------------------------------------

    def test_orders_only_creates_one_counted_row(self):
        # An orders file alone (no items file) is the normal complete case: one counted row, memo from
        # the orders file's own item list, charge matched + excluded.
        self._add_card_charge(37.32)
        order = _cash_order()
        order.items = []
        order.has_item_detail = False
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [order], account_id="amazon", filename="orders.csv")
        self.assertEqual(summary["counts"]["orders_imported"], 1)
        self.assertEqual(summary["counts"]["charges_matched"], 1)
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        self.assertAlmostEqual(orders[0]["amount"], 37.32, places=2)
        self.assertEqual(orders[0]["display_name"], "Air Widget; Widget Picks;")

    def test_items_only_is_discarded_not_staged(self):
        # An items file with no imported order to attach to: discarded (not staged, not in the ledger).
        items_by_order = {"111-0000000-0000099": [AmazonItem(description="Widget", price=5.0, asin="B0XXX")]}
        merged = merge([], items_by_order)  # no orders → has_order_detail=False
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, merged, account_id="amazon", filename="items.csv")
        self.assertEqual(summary["counts"]["items_discarded"], 1)
        self.assertEqual(self._amazon_orders(), [])  # nothing created
        with self._use_db_path(), get_db() as conn:
            self.assertIsNone(txn_links.find_link(conn, LINK_KIND, "111-0000000-0000099"))

    def test_items_file_enriches_existing_order(self):
        # Orders file first (one row, memo from its item list), then an items-only import folds the item
        # reference detail (ASIN/price) into that existing order's evidence — no new row.
        self._add_card_charge(37.32)
        oid = _cash_order().order_id
        orders_only = _cash_order()
        orders_only.items = []
        orders_only.has_item_detail = False
        items_by_order = {oid: [
            AmazonItem(description="Air Widget", price=34.99, asin="B0AAA"),
            AmazonItem(description="Widget Picks", price=5.32, asin="B0BBB", quantity=2),
        ]}
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [orders_only], account_id="amazon", filename="orders.csv")
            summary = run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="items.csv")
        self.assertEqual(summary["counts"]["items_enriched"], 1)
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)  # still one row, enriched not duplicated
        evidence = json.loads(orders[0]["import_evidence_json"])
        item_fields = [f["value"] for f in evidence["extra_text_fields"] if f["header"] == "Item"]
        self.assertEqual(len(item_fields), 2)
        self.assertIn("B0AAA", item_fields[0])

    def test_items_enrichment_is_idempotent(self):
        self._add_card_charge(37.32)
        oid = _cash_order().order_id
        orders_only = _cash_order()
        orders_only.items = []
        orders_only.has_item_detail = False
        items_by_order = {oid: [AmazonItem(description="Air Widget", price=34.99, asin="B0AAA")]}
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [orders_only], account_id="amazon", filename="orders.csv")
            run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="items.csv")
            second = run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="items.csv")
        self.assertEqual(second["counts"]["items_enriched"], 0)   # already enriched → no-op
        self.assertEqual(second["counts"]["already_applied"], 1)

    # ---- batch-level run + undo -------------------------------------------------------------------

    def test_run_amazon_import_summary(self):
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="amazon.csv")
        self.assertEqual(summary["order_count"], 1)
        self.assertEqual(summary["counts"]["orders_imported"], 1)
        self.assertEqual(summary["counts"]["charges_matched"], 1)
        with self._use_db_path(), get_db() as conn:
            n = conn.execute("SELECT COUNT(*) FROM txn WHERE import_batch_id = ?", (summary["batch_id"],)).fetchone()[0]
            source_kind = conn.execute("SELECT source_kind FROM import_batch WHERE id = ?", (summary["batch_id"],)).fetchone()[0]
        self.assertEqual(n, 1)  # one row per order
        self.assertEqual(source_kind, BATCH_SOURCE_KIND)

    # ---- reconciliation report --------------------------------------------------------------------

    def test_reconciliation_matched_and_amazon_unmatched(self):
        self._add_card_charge(37.32)  # will match the first order
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(
                conn,
                [_cash_order(), _cash_order(order_id="no-charge", last4="9999", amount=12.00)],
                account_id="amazon", filename="orders.csv",
            )
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(len(recon["matched"]), 1)
        self.assertIsNotNone(recon["matched"][0]["charge"])
        self.assertAlmostEqual(recon["matched"][0]["order"]["amount"], 37.32, places=2)
        # The second cash order found no card charge → surfaced for a manual link.
        self.assertEqual(len(recon["amazon_unmatched"]), 1)
        self.assertEqual(recon["amazon_unmatched"][0]["order"]["amount"], 12.00)

    def test_reconciliation_reverse_scan_finds_unaccounted_amazon_charge(self):
        # One order matches its charge; a *second* Amazon charge on the same card in range is accounted
        # for by no order → the reverse scan surfaces it (informational).
        self._add_card_charge(37.32)
        stray = self._add_card_charge(19.99, date="2024-11-20")  # AMAZON.COM, no order
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
        ids = [c["id"] for c in recon["payment_unmatched"]]
        self.assertIn(stray, ids)
        # The matched charge is not double-reported in the reverse scan (it's linked).
        self.assertEqual(len(recon["payment_unmatched"]), 1)

    def test_apply_categorization_runs_rules_on_order_rows(self):
        # "Apply categorizations" runs the user's rules over the new order rows; off leaves them blank.
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO category (id, name, category_type) VALUES ('shop', 'Shopping', 'expense')")
            conn.execute(
                "INSERT INTO category_rule (id, keyword, category_id) VALUES ('r1', 'widget', 'shop')"
            )
            run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv",
                              apply_categorization=True)
        order = self._amazon_orders()[0]
        self.assertEqual(order["category_id"], "shop")   # rule matched "Air Widget; Widget Picks"
        self.assertEqual(order["category_source"], "rule")

    def test_apply_categorization_off_leaves_rows_uncategorized(self):
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO category (id, name, category_type) VALUES ('shop', 'Shopping', 'expense')")
            conn.execute("INSERT INTO category_rule (id, keyword, category_id) VALUES ('r1', 'widget', 'shop')")
            run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv",
                              apply_categorization=False)
        self.assertIsNone(self._amazon_orders()[0]["category_id"])

    def test_scan_instruments_reports_map_state(self):
        # The pre-import scan lists each card the files use, with its current funding-map state, so the
        # UI can get unmapped cards mapped before the import runs.
        from backend.routers.import_export.amazon import _scan_instruments
        with self._use_db_path(), get_db() as conn:
            instruments = _scan_instruments(conn, [_cash_order()], "amazon")
        self.assertEqual(len(instruments), 1)
        self.assertEqual(instruments[0]["last4"], "4321")
        self.assertEqual(instruments[0]["state"], "unmapped")
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4321", network="Test Card", funding_account_id="card")
            instruments = _scan_instruments(conn, [_cash_order()], "amazon")
        self.assertEqual(instruments[0]["state"], "mapped")
        self.assertEqual(instruments[0]["funding_account_name"], "Rewards Card")

    def test_manual_link_charge_excludes_and_links(self):
        # An order that auto-matching couldn't pair (untracked card), plus a charge that exists but wasn't
        # matched. A manual link excludes the charge and pairs it — moving the order from unmatched to
        # matched — and it reverses through batch undo like an auto-match.
        stray = self._add_card_charge(37.32, account_id="card")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(last4="9999")], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
            self.assertEqual(len(recon["amazon_unmatched"]), 1)
            link_id = recon["amazon_unmatched"][0]["link_id"]

            manual_link_charge(conn, link_id, stray)
            funding_id = find_or_create_funding_category(conn)
            recon2 = amazon_reconciliation(conn, summary["batch_id"])

        self.assertEqual(self._txn(stray)["category_id"], funding_id)   # excluded
        self.assertEqual(self._txn(stray)["category_source"], "enrichment")
        self.assertEqual(len(recon2["matched"]), 1)                     # now matched
        self.assertEqual(len(recon2["amazon_unmatched"]), 0)

        # Reverses through the batch-undo path (charge_prior stashed in the link).
        with self._use_db_path(), get_db() as conn:
            reverse_batch_amazon_links(conn, summary["batch_id"])
        self.assertIsNone(self._txn(stray)["category_id"])

    def test_manual_link_rejects_already_linked_charge(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            # First order auto-matches the charge.
            run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            # A second unmatched order can't steal that already-linked charge.
            summary = run_amazon_import(conn, [_cash_order(order_id="other", last4="9999")], account_id="amazon", filename="orders.csv")
            link_id = amazon_reconciliation(conn, summary["batch_id"])["amazon_unmatched"][0]["link_id"]
            with self.assertRaises(ValueError):
                manual_link_charge(conn, link_id, charge_id)

    def test_funding_category_setting_overrides_default(self):
        # A global funding-category choice is honored at import time (so it affects future imports only).
        from backend.db.database import set_tenant_workflow_state
        from backend.routers.import_export.amazon import FUNDING_CATEGORY_STATE_KEY
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            transfers = conn.execute("SELECT id FROM category WHERE name='Transfers' AND parent_id IS NULL").fetchone()
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals) VALUES ('amz', ?, 'My Amazon', 'expense', 1)",
                (transfers["id"],),
            )
            set_tenant_workflow_state(conn, FUNDING_CATEGORY_STATE_KEY, {"category_id": "amz"})
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
        self.assertEqual(self._txn(charge_id)["category_id"], "amz")

    def test_funding_category_falls_back_when_choice_deleted(self):
        # If the chosen category no longer exists, the engine falls back to the default (never crashes).
        from backend.db.database import set_tenant_workflow_state
        from backend.routers.import_export.amazon import FUNDING_CATEGORY_STATE_KEY
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            set_tenant_workflow_state(conn, FUNDING_CATEGORY_STATE_KEY, {"category_id": "ghost"})
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id)
            default_id = find_or_create_funding_category(conn)
        self.assertEqual(self._txn(charge_id)["category_id"], default_id)

    def test_reverse_batch_restores_charge_outside_the_batch(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="amazon.csv")
            # Simulate undo_batch's order: reverse links, then delete the batch's own rows.
            reversed_count = reverse_batch_amazon_links(conn, summary["batch_id"])
            conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (summary["batch_id"],))
        self.assertEqual(reversed_count, 1)
        self.assertIsNone(self._txn(charge_id)["category_id"])  # charge restored
        self.assertEqual(self._amazon_orders(), [])             # order row gone


if __name__ == "__main__":
    unittest.main()
