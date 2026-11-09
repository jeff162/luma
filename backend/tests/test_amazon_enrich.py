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
    add_order_charge,
    amazon_reconciliation,
    apply_amazon_order,
    dismiss_split_suggestion,
    find_or_create_funding_category,
    link_amazon_charges,
    link_orders_to_new_charges,
    manual_link_charge,
    mark_charges_distinct,
    mark_orders_no_charge_reviewed,
    mark_unaccounted_charges_reviewed,
    unlink_order_charges,
    merge_duplicate_charges,
    merge_unaccounted_charges,
    reconciliation_attention_count,
    remove_order_charge,
    reverse_amazon_order,
    reverse_batch_amazon_links,
    run_amazon_import,
    trash_duplicate_charge,
)
from backend.routers.import_export.amazon import (
    _group_unaccounted_duplicates,
    _pair_equal_amount_clusters,
    payee_family,
    _txn_summary,
)
from backend.services.amazon_import import AmazonItem, AmazonOrder, PaymentLeg, merge
from backend.services import amazon_funding, txn_links
from backend.services.categorizer import recategorize_all


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
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('amazon', 'p_amazon', 'fixture', 'Amazon', 'Amazon', 'other', ?)""",
                (SHARED_OWNER_ID,),
            )
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, mask, owner_id)
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

    def _add_card_charge(self, amount=37.32, date="2024-11-19", account_id="card", name="AMAZON.COM"):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                (txn_id, account_id, SHARED_OWNER_ID, amount, name, name, name, date),
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
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)

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
            apply_amazon_order(conn, _cash_order(refund=10.0), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        # net cash = 37.32 − 10.00 refund
        self.assertAlmostEqual(self._amazon_orders()[0]["amount"], 27.32, places=2)

    def test_reverse_restores_charge_and_deletes_order(self):
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
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
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
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
            result = apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            funding_id = find_or_create_funding_category(conn)
        self.assertEqual(result["disposition"], "non_cash")
        self.assertFalse(result["charge_linked"])
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        # A non-cash order is recorded in the excluded category so it doesn't count.
        self.assertEqual(orders[0]["category_id"], funding_id)

    def test_bare_card_order_upgrades_to_cash_when_full_total_charge_exists(self):
        # The bare-card probe: "Visa ending in 5093; Rewards Points;" (2024+ shape) names a
        # card but discloses no amounts, so classification alone says non-cash — but a unique ledger
        # charge equal to the full total proves the card paid everything. The order imports as ordinary
        # cash: counted at its total, the charge matched + excluded.
        charge = self._add_card_charge(37.32)
        order = _cash_order(order_id="points-2")
        order.payment_legs = [
            PaymentLeg(method="Test Card", last4="4321", date=None, amount=None),
            PaymentLeg(method="Rewards Points", last4=None, date=None, amount=None, is_non_cash=True),
        ]
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            funding_id = find_or_create_funding_category(conn)
        self.assertEqual(result["disposition"], "cash")
        self.assertTrue(result["charge_linked"])
        orders = self._amazon_orders()
        self.assertEqual(orders[0]["amount"], 37.32)                     # counted at the real total
        self.assertIsNone(orders[0]["category_id"])                     # categorizable, like any cash order
        self.assertEqual(self._txn(charge)["category_id"], funding_id)  # the charge is excluded, like any match

    def test_bare_card_order_stays_non_cash_when_full_total_charge_is_ambiguous(self):
        # Two same-amount charges: the probe demands a *unique* full-total charge — never guess.
        self._add_card_charge(37.32)
        self._add_card_charge(37.32)
        order = _cash_order(order_id="points-3")
        order.payment_legs = [
            PaymentLeg(method="Test Card", last4="4321", date=None, amount=None),
            PaymentLeg(method="Rewards Points", last4=None, date=None, amount=None, is_non_cash=True),
        ]
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        self.assertEqual(result["disposition"], "non_cash")
        self.assertFalse(result["charge_linked"])
        self.assertEqual(self._amazon_orders()[0]["amount"], 0.0)

    def test_cash_order_with_no_matching_charge_counts_directly(self):
        # Untracked card: no ledger charge to match, so the order is the sole record and still counts.
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(last4="9999"), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        self.assertEqual(result["disposition"], "cash")
        self.assertFalse(result["charge_linked"])
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        self.assertAlmostEqual(orders[0]["amount"], 37.32, places=2)
        self.assertIsNone(orders[0]["category_id"])

    def test_a_digital_order_matches_a_charge_billed_under_an_amazon_service_name(self):
        # A digital order names no card, so its charge must read as Amazon; Amazon's own services bill
        # under their brand names, and a lookalike name that is not one of them still does not match.
        digital = AmazonOrder(order_id="D01-0000000-0000001", order_date="2024-11-19", total=8.99,
                              items_summary="Streaming Channel;",
                              payment_legs=[PaymentLeg(method=None, last4=None, date="2024-11-19", amount=8.99)],
                              has_order_detail=True)
        self._add_card_charge(8.99, name="Prime Motor Group")
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, digital, account_id="amazon", batch_id=self.batch_id, flag_for_review=False)
        self.assertFalse(result["charge_linked"])

        service = self._add_card_charge(8.99, date="2024-12-19", name="Prime Video")
        later = AmazonOrder(order_id="D01-0000000-0000002", order_date="2024-12-19", total=8.99,
                            items_summary="Streaming Channel;",
                            payment_legs=[PaymentLeg(method=None, last4=None, date="2024-12-19", amount=8.99)],
                            has_order_detail=True)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, later, account_id="amazon", batch_id=self.batch_id, flag_for_review=False)
            link = txn_links.find_link(conn, LINK_KIND, later.order_id)
            charges = txn_links.member_txn_ids(conn, link["id"], role="charge")
        self.assertTrue(result["charge_linked"])
        self.assertEqual(charges, [service])

    def test_a_charge_is_labelled_with_its_payee_family_service_first(self):
        # A service is named before the generic Amazon match would take it ("Amazon Music" says Amazon).
        family = lambda name: payee_family({"merchant_name": name, "raw_name": name})
        self.assertEqual(family("AMAZON MARKETPLACE NAMZN.COM BILL WA"), "Amazon")
        self.assertEqual(family("AMZN DIGITAL WA"), "Amazon")
        self.assertEqual(family("Amazon Music"), "Amazon Music")
        self.assertEqual(family("Prime Video"), "Prime Video")
        self.assertEqual(family("Corner Market"), "Other")
        charge = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=False)
            [matched] = amazon_reconciliation(conn, self.batch_id)["matched"]
        self.assertEqual([(c["id"], c["payee_family"]) for c in matched["charges"]], [(charge, "Amazon")])

    def test_ambiguous_charge_is_left_unmatched(self):
        # Two identical candidate charges → ambiguous → no auto-link (left for manual).
        self._add_card_charge(37.32)
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        self.assertFalse(result["charge_linked"])

    # ---- reconciliation: duplicate-charge detection + trash-to-resolve ----------------------------

    def test_reconciliation_reports_duplicate_charges_not_unmatched(self):
        # Two identical charges make the order ambiguous. Reconciliation must file it under `duplicate`
        # (both copies carried) — not `amazon_unmatched` — and keep those copies out of the reverse scan.
        c1 = self._add_card_charge(37.32)
        c2 = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            report = amazon_reconciliation(conn, self.batch_id)
        self.assertEqual(len(report["duplicate"]), 1)
        self.assertEqual(report["amazon_unmatched"], [])
        self.assertEqual(report["matched"], [])
        entry = report["duplicate"][0]
        self.assertEqual({c["id"] for c in entry["charges"]}, {c1, c2})
        self.assertTrue(all(c["matched"] is False for c in entry["charges"]))
        # The order side carries provenance from its own import file.
        self.assertEqual(entry["order"]["source"]["filename"], "amazon.csv")
        # Item lines, not units: the second line's quantity of two is still one thing to categorize.
        self.assertEqual(entry["order"]["item_count"], 2)
        # The duplicated copies are not double-shown as unaccounted charges.
        self.assertEqual([c["id"] for c in report["payment_unmatched"] if c["id"] in (c1, c2)], [])

    def test_trashing_a_duplicate_lets_the_order_match(self):
        # Resolve the ambiguity by trashing one copy → the survivor auto-links → the order is now matched.
        c1 = self._add_card_charge(37.32)
        c2 = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            applied = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            outcome = trash_duplicate_charge(conn, c1, applied["link_id"])
            report = amazon_reconciliation(conn, self.batch_id)
            funding_id = find_or_create_funding_category(conn)
        self.assertTrue(outcome["matched"])
        self.assertIsNotNone(self._txn(c1)["trashed_at"])           # the copy we trashed is gone
        self.assertEqual(len(report["matched"]), 1)
        self.assertEqual(report["duplicate"], [])
        self.assertEqual(report["matched"][0]["charges"][0]["id"], c2)  # linked to the survivor
        self.assertEqual(self._txn(c2)["category_id"], funding_id)  # and excluded, like any match

    def test_matched_charge_with_a_duplicate_copy_is_flagged(self):
        # Point 3: a cleanly-matched order later gains a duplicate charge. Reconciliation surfaces every
        # copy (the matched one included) so the user can trash the redundant one; the match survives.
        c1 = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            applied = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            self.assertTrue(applied["charge_linked"])
        c2 = self._add_card_charge(37.32)   # a duplicate arrives after the match
        with self._use_db_path(), get_db() as conn:
            report = amazon_reconciliation(conn, self.batch_id)
        self.assertEqual(len(report["duplicate"]), 1)
        charges = {c["id"]: c["matched"] for c in report["duplicate"][0]["charges"]}
        self.assertEqual(charges, {c1: True, c2: False})
        with self._use_db_path(), get_db() as conn:
            trash_duplicate_charge(conn, c2, applied["link_id"])   # trash the redundant copy
            report2 = amazon_reconciliation(conn, self.batch_id)
        self.assertEqual(report2["duplicate"], [])
        self.assertEqual(report2["matched"][0]["charges"][0]["id"], c1)   # original match intact

    def test_equal_count_orders_auto_pair_at_import(self):
        # Two distinct same-amount purchases + two charges: the matcher can't tell which pairs with which,
        # but the assignment is immaterial, so the equal-count pass pairs them 1:1 at import rather than
        # flagging false duplicates.
        self._add_card_charge(37.32, date="2024-11-19")
        self._add_card_charge(37.32, date="2024-11-20")
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [_cash_order(order_id="A-1"), _cash_order(order_id="A-2")],
                              account_id="amazon", apply_categorization=False)
            batch = conn.execute("SELECT id FROM import_batch ORDER BY rowid DESC LIMIT 1").fetchone()["id"]
            report = amazon_reconciliation(conn, batch)
        self.assertEqual(len(report["matched"]), 2)
        self.assertEqual(report["duplicate"], [])
        self.assertEqual(report["amazon_unmatched"], [])

    def test_surplus_charge_is_not_auto_paired(self):
        # One order, two same-amount charges: a *surplus* is a real duplicate, so the equal-count pass leaves
        # it alone for the reconciliation report to resolve.
        self._add_card_charge(37.32)
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [_cash_order(order_id="A-1")], account_id="amazon", apply_categorization=False)
            batch = conn.execute("SELECT id FROM import_batch ORDER BY rowid DESC LIMIT 1").fetchone()["id"]
            report = amazon_reconciliation(conn, batch)
        self.assertEqual(report["matched"], [])
        self.assertEqual(len(report["duplicate"]), 1)

    def _digital_order(self, order_id, date, amount, name):
        # Names no card, as a digital order does, so every Amazon-looking charge of its amount is a candidate.
        return AmazonOrder(order_id=order_id, order_date=date, total=amount, items_summary=name,
                           payment_legs=[PaymentLeg(method=None, last4=None, date=date, amount=amount)],
                           has_order_detail=True)

    def test_a_balanced_pair_pairs_despite_a_surplus_of_that_amount_months_away(self):
        # Balance is judged per group of orders competing for the same charges: a surplus charge in
        # September is that month's duplicate question, and must not block July's two-orders-two-charges.
        self._add_card_charge(11.99, date="2026-07-28")
        self._add_card_charge(11.99, date="2026-07-28")
        self._add_card_charge(11.99, date="2026-09-06")
        self._add_card_charge(11.99, date="2026-09-07")
        orders = [self._digital_order("J-1", "2026-07-27", 11.99, "Capri Leggings;"),
                  self._digital_order("J-2", "2026-07-27", 11.99, "Capri Leggings;"),
                  self._digital_order("S-1", "2026-09-06", 11.99, "Garden Hose;")]
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, orders, account_id="amazon", apply_categorization=False)
            batch = conn.execute("SELECT id FROM import_batch ORDER BY rowid DESC LIMIT 1").fetchone()["id"]
            report = amazon_reconciliation(conn, batch)
        self.assertEqual(sorted(m["order"]["date"] for m in report["matched"]), ["2026-07-27", "2026-07-27"])
        self.assertEqual([d["order"]["date"] for d in report["duplicate"]], ["2026-09-06"])

    def _carded_order(self, order_id, date, amount=33.97):
        return AmazonOrder(order_id=order_id, order_date=date, total=amount, items_summary="Espresso Cans;",
                           payment_legs=[PaymentLeg(method="Test Card", last4="4321", date=date, amount=amount)],
                           has_order_detail=True)

    def _import_and_reconcile(self, orders):
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, orders, account_id="amazon", apply_categorization=False)
            return amazon_reconciliation(conn, summary["batch_id"])

    def test_orders_held_to_ship_together_pair_with_their_later_charges(self):
        # Amazon charges on shipment: three same-amount orders placed over two days, billed together four
        # and five days later. Three orders, three charges, so they are distinct purchases, not duplicates.
        charges = {self._add_card_charge(33.97, date="2026-06-17") for _ in range(3)}
        report = self._import_and_reconcile([self._carded_order("S-1", "2026-06-12"),
                                             self._carded_order("S-2", "2026-06-13"),
                                             self._carded_order("S-3", "2026-06-13")])
        self.assertEqual(report["duplicate_review"], [])
        self.assertEqual({c["id"] for m in report["matched"] for c in m["charges"]}, charges)

    def test_a_surplus_charge_outside_the_match_window_still_needs_review(self):
        # One charge more than orders is a duplicate somewhere in the group, so nothing is paired.
        for _ in range(4):
            self._add_card_charge(33.97, date="2026-06-17")
        report = self._import_and_reconcile([self._carded_order("S-1", "2026-06-12"),
                                             self._carded_order("S-2", "2026-06-13"),
                                             self._carded_order("S-3", "2026-06-13")])
        self.assertEqual(report["matched"], [])
        self.assertEqual(len(report["duplicate_review"]), 3)

    def test_equal_count_pairing_prefers_the_charge_its_order_names(self):
        # Both pairings are possible; the one where the order names the charge's service is taken.
        kindle = self._add_card_charge(11.99, date="2026-08-05", name="Kindle")
        music = self._add_card_charge(11.99, date="2026-08-06", name="Amazon Music")
        orders = [self._digital_order("K-1", "2026-08-06", 11.99, "Kindle+;"),
                  self._digital_order("M-1", "2026-08-06", 11.99, "Amazon Music Unlimited;")]
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, orders, account_id="amazon", apply_categorization=False)
            paired = {ref: txn_links.member_txn_ids(conn, txn_links.find_link(conn, LINK_KIND, ref)["id"], role="charge")
                      for ref in ("K-1", "M-1")}
        self.assertEqual(paired, {"K-1": [kindle], "M-1": [music]})

    def test_merge_keeps_richest_and_trashes_the_rest(self):
        # Same purchase imported twice, the later sync richer. Merge keeps that copy and trashes the plainer
        # one, then links the survivor to the order.
        plain = self._add_card_charge(37.32)   # raw_name 'AMAZON.COM'
        detailed = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                   VALUES (?, 'card', ?, 37.32, 'AMAZON.COM', 'AMAZON.COM', 'AMAZON MKTPLACE PMTS AMZN.COM/BILL WA — LONGER DETAIL', '2024-11-19', 0)""",
                (detailed, SHARED_OWNER_ID),
            )
            applied = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            result = merge_duplicate_charges(conn, applied["link_id"])
            report = amazon_reconciliation(conn, self.batch_id)
        self.assertEqual(result["survivor_id"], detailed)          # richer copy kept
        self.assertIsNotNone(self._txn(plain)["trashed_at"])       # plainer copy trashed
        self.assertIsNone(self._txn(detailed)["trashed_at"])
        self.assertEqual(len(report["matched"]), 1)
        self.assertEqual(report["matched"][0]["charges"][0]["id"], detailed)
        self.assertEqual(report["duplicate"], [])

    def _insert_charge(self, txn_id, raw_name, amount=37.32, date="2024-11-19"):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                   VALUES (?, 'card', ?, ?, 'AMAZON.COM', 'AMAZON.COM', ?, ?, 0)""",
                (txn_id, SHARED_OWNER_ID, amount, raw_name, date),
            )

    def _folded_detail(self, txn_id):
        raw = self._txn(txn_id)["import_evidence_json"]
        fields = json.loads(raw).get("extra_text_fields", []) if raw else []
        return [f["value"] for f in fields if f.get("header") == "Merged duplicate detail"]

    def test_merge_drops_a_near_duplicate_restating(self):
        # The losing copy only restates the survivor's charge in different words — an abbreviation
        # (AMAZON MARKETPLACE vs the survivor's AMAZON MKTPLACE …). It adds no new token, so the merge
        # keeps the survivor and folds nothing in as "extra" detail.
        survivor, loser = str(uuid.uuid4()), str(uuid.uuid4())
        self._insert_charge(survivor, "AMAZON MKTPLACE PMTSAMZN.COM/BILL WA SEATTLE")   # richest → kept
        self._insert_charge(loser, "AMAZON MARKETPLACE")
        with self._use_db_path(), get_db() as conn:
            applied = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            result = merge_duplicate_charges(conn, applied["link_id"])
        self.assertEqual(result["survivor_id"], survivor)
        self.assertIsNotNone(self._txn(loser)["trashed_at"])
        self.assertEqual(self._folded_detail(survivor), [])

    def test_merge_folds_a_copy_that_adds_a_novel_reference(self):
        # A losing copy carrying a token the survivor lacks (a distinct order reference) is real detail —
        # it is folded in so the merge keeps a composite rather than dropping it.
        survivor, loser = str(uuid.uuid4()), str(uuid.uuid4())
        self._insert_charge(survivor, "AMAZON MKTPLACE PMTSAMZN.COM/BILL WA SEATTLE")   # richest → kept
        self._insert_charge(loser, "AMAZON MKTPLACE ORDER 112-9988776")
        with self._use_db_path(), get_db() as conn:
            applied = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            result = merge_duplicate_charges(conn, applied["link_id"])
        self.assertEqual(result["survivor_id"], survivor)
        self.assertEqual(self._folded_detail(survivor), ["AMAZON MKTPLACE ORDER 112-9988776"])

    def test_merge_drops_a_generic_descriptor_with_new_words(self):
        # The losing copy adds new *words* (NA, PAYMENTS) but no distinguishing identifier — a generic
        # Amazon payment descriptor. It's dropped as noise, not folded in, even though the words are new.
        survivor, loser = str(uuid.uuid4()), str(uuid.uuid4())
        self._insert_charge(survivor, "AMAZON MKTPLACE PMTSAMZN.COM/BILL WA SEATTLE")   # richest → kept
        self._insert_charge(loser, "AMAZON MARKETPLACE NA - PAYMENTS")
        with self._use_db_path(), get_db() as conn:
            applied = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            result = merge_duplicate_charges(conn, applied["link_id"])
        self.assertEqual(result["survivor_id"], survivor)
        self.assertIsNotNone(self._txn(loser)["trashed_at"])
        self.assertEqual(self._folded_detail(survivor), [])

    def test_merge_refuses_when_orders_share_the_amount(self):
        # Two distinct same-amount orders + a surplus charge: not duplicates of one purchase, so merge refuses
        # (it would steal a charge) and steers the user to per-row Discard.
        for _ in range(3):
            self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            a1 = apply_amazon_order(conn, _cash_order(order_id="A-1"), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            apply_amazon_order(conn, _cash_order(order_id="A-2"), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            with self.assertRaises(ValueError):
                merge_duplicate_charges(conn, a1["link_id"])

    def test_duplicate_is_mergeable_when_order_amount_is_unique(self):
        # One order, two identical charges → the extra is a redundant copy, so the report offers Merge.
        self._add_card_charge(37.32)
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            recon = amazon_reconciliation(conn, self.batch_id)
        self.assertEqual(len(recon["duplicate"]), 1)
        self.assertTrue(recon["duplicate"][0]["mergeable"])

    def test_duplicate_not_mergeable_when_orders_share_the_amount(self):
        # Two distinct same-amount orders + surplus charges → merging one would steal the other's charge, so
        # Merge must not be offered (the flag mirrors the guard in test_merge_refuses_when_orders_share_the_amount).
        for _ in range(3):
            self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(order_id="A-1"), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            apply_amazon_order(conn, _cash_order(order_id="A-2"), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            recon = amazon_reconciliation(conn, self.batch_id)
        self.assertTrue(len(recon["duplicate"]) >= 1)
        self.assertTrue(all(not d["mergeable"] for d in recon["duplicate"]))

    def test_mapped_instrument_disambiguates_same_amount_charges(self):
        # Two same-amount charges on different accounts would be ambiguous → no auto-match. The funding
        # map names which account this instrument charges, constraining the search to it so it resolves.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('card2', 'p_card2', 'fixture', 'Other Card', 'Other Card', 'credit', ?)""",
                (SHARED_OWNER_ID,),
            )
        on_card = self._add_card_charge(37.32, account_id="card")
        self._add_card_charge(37.32, account_id="card2")
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4321", network="Test Card",
                                                 funding_account_id="card")
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
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
            result = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        self.assertFalse(result["charge_linked"])
        self.assertEqual(result["funding_state"], "untracked")
        self.assertIsNone(self._txn(charge_id)["category_id"])   # the charge is left alone
        self.assertAlmostEqual(self._amazon_orders()[0]["amount"], 37.32, places=2)

    def test_maskless_account_still_matches_a_carded_order(self):
        # The common imported-ledger case: accounts carry no card mask. The order names a card last-4,
        # but a maskless account can't contradict it, so amount + date + uniqueness carries the match.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('nomask', 'p_nomask', 'fixture', 'Imported Card', 'Imported Card', 'credit', ?)""",
                (SHARED_OWNER_ID,),
            )
        charge_id = self._add_card_charge(37.32, account_id="nomask")
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, _cash_order(last4="4321"), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            funding_id = find_or_create_funding_category(conn)
        self.assertTrue(result["charge_linked"])
        self.assertEqual(self._txn(charge_id)["category_id"], funding_id)

    def test_zero_charge_order_does_not_self_match(self):
        # A $0 card leg (a free/promo order, or gift-card/points funded reported as $0) has nothing to
        # reconcile: it classifies as non-cash, so no charge match is attempted — in particular it must
        # never match its own just-created $0 order row — and it's recorded in the excluded category
        # like any other non-cash order.
        order = _cash_order(order_id="zero-1", amount=0.0)
        order.total = 0.0
        order.payment_legs = [PaymentLeg(method="Test Card", last4="4321", date="2024-11-19", amount=0.0)]
        order.items = [AmazonItem(description="Freebie", price=0.0, asin="B0ZZZ")]
        with self._use_db_path(), get_db() as conn:
            result = apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            funding_id = find_or_create_funding_category(conn)
        self.assertEqual(result["disposition"], "non_cash")
        self.assertFalse(result["charge_linked"])
        orders = self._amazon_orders()
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0]["category_id"], funding_id)
        self.assertNotEqual(orders[0]["category_source"], "enrichment")

    def test_reimport_is_idempotent(self):
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            second = apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
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
        self.assertEqual(second["counts"]["items_enriched"], 0)     # already enriched → no-op
        self.assertEqual(second["counts"]["already_enriched"], 1)   # a re-imported items file (not a duplicate order)
        self.assertEqual(second["counts"]["already_applied"], 0)

    def test_import_detail_items_matched_and_already_enriched(self):
        # An items-only import creates no order rows (they live in the orders file's batch), but the
        # import-detail report still shows the orders it enriched — looked up by the recorded txn id — with
        # the items file as their source. A re-import of the items file shows under "already enriched".
        from backend.routers.import_export.amazon import amazon_import_detail
        self._add_card_charge(37.32)
        oid = _cash_order().order_id
        orders_only = _cash_order(); orders_only.items = []; orders_only.has_item_detail = False
        items_by_order = {oid: [AmazonItem(description="Air Widget", price=34.99, asin="B0AAA", source_file="2016-items.csv")]}
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [orders_only], account_id="amazon", filename="2016-orders.csv")
            items = run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="2016-items.csv")
            detail = amazon_import_detail(conn, items["batch_id"])
            again = run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="2016-items.csv")
            detail_again = amazon_import_detail(conn, again["batch_id"])
        self.assertEqual(len(detail["items_matched"]), 1)
        self.assertEqual(detail["items_matched"][0]["source_file"], "2016-items.csv")
        self.assertEqual(detail["counts"]["items_enriched"], 1)
        self.assertEqual(len(detail_again["already_enriched"]), 1)
        self.assertEqual(detail_again["counts"]["already_enriched"], 1)
        self.assertEqual(detail_again["duplicate_orders"], [])

    # ---- per-file hashing / re-import detection ----------------------------------------------------

    _ORDERS_CSV = (
        "order id,order url,items,to,date,total,shipping,shipping_refund,gift,tax,refund,payments\n"
        '111-000,,Air Widget; ,J,2024-11-19,37.32,0,,,2.19,,"Test Card ending in 4321: 2024-11-19: $37.32; "\n'
    )

    class _Upload:
        def __init__(self, filename, text):
            self.filename = filename
            self._data = text.encode("utf-8")

        async def read(self, size: int = -1):
            return self._data

    def test_reimported_file_is_skipped_by_hash(self):
        # A file a completed import already took is recognized by content hash on a later upload — skipped
        # (no re-parse, no new all-duplicates card) and reported as already imported, whatever its name.
        # The skip names the card that covers it, which is what the notice tells the reader to look at.
        import asyncio
        from backend.routers.import_export.amazon import _imported_amazon_file_hashes, _read_amazon_uploads
        orders, _items, names, _unrec, skipped, hashes = asyncio.run(
            _read_amazon_uploads([self._Upload("2016-orders.csv", self._ORDERS_CSV)]))
        self.assertEqual((names, skipped, len(hashes)), (["2016-orders.csv"], [], 1))
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, orders, account_id="amazon", filename="2016-orders.csv",
                                        file_hashes=hashes)
            known = _imported_amazon_file_hashes(conn)
        self.assertEqual(set(known), {hashes[0]["hash"]})
        orders2, _i2, names2, _u2, skipped2, hashes2 = asyncio.run(
            _read_amazon_uploads([self._Upload("2016-orders copy.csv", self._ORDERS_CSV)], known))
        self.assertEqual((orders2, names2, hashes2), ([], [], []))
        self.assertEqual(skipped2, [{"filename": "2016-orders copy.csv", "reason": "already_imported",
                                     "matched_filename": "2016-orders.csv",
                                     "matched_batch_id": summary["batch_id"]}])

    def test_same_file_twice_in_one_upload_is_skipped_as_a_duplicate_in_the_drop(self):
        # Two copies of the same file in a single upload: the first is taken, the second skipped. The skip
        # is reported as a duplicate *within this drop*, not as "already imported" — nothing was imported
        # before, so there is no card to look at and no rows to go looking for in the ledger. This is what
        # an export saved twice under two names (an items file holding the orders export) looks like.
        import asyncio
        from backend.routers.import_export.amazon import _read_amazon_uploads
        _orders, _items, names, _unrec, skipped, hashes = asyncio.run(
            _read_amazon_uploads([self._Upload("a.csv", self._ORDERS_CSV), self._Upload("a (1).csv", self._ORDERS_CSV)]))
        self.assertEqual(names, ["a.csv"])
        self.assertEqual(skipped, [{"filename": "a (1).csv", "reason": "duplicate_in_drop",
                                    "matched_filename": "a.csv", "matched_batch_id": None}])
        self.assertEqual(len(hashes), 1)

    def test_a_card_with_no_rows_still_records_the_account_it_was_imported_into(self):
        # An items-only card creates no transactions, so the account cannot be read back from the ledger
        # — and the import history groups cards by account. Recording it at import is what keeps such a
        # card under the account it belongs to instead of in the leftovers.
        import json
        oid = _cash_order().order_id
        items_by_order = {oid: [AmazonItem(description="Air Widget", price=34.99, asin="B0AAA",
                                           source_file="2016-items.csv", source_file_hash="H-ITEMS")]}
        with self._use_db_path(), get_db() as conn:
            result = run_amazon_import(conn, merge([], items_by_order), account_id="amazon",
                                       filename="2016-items.csv",
                                       file_hashes=[{"filename": "2016-items.csv", "hash": "H-ITEMS"}])
            batch_id = result["batches"][0]["batch_id"]
            row_count, snapshot = conn.execute(
                "SELECT row_count, config_snapshot FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
        self.assertEqual(row_count, 0)
        self.assertEqual(json.loads(snapshot)["amazon_account_id"], "amazon")

    def test_items_before_orders_are_parked_and_auto_attached(self):
        # An items file imported before its orders file: its per-item detail is **parked** (not lost), and its
        # hash stays un-persisted so nothing is stranded. Importing the matching orders file later — *without*
        # re-dropping the items file — auto-attaches the parked detail: the order row is created already
        # enriched, and the parked row is consumed.
        from backend.routers.import_export.amazon import _imported_amazon_file_hashes
        oid = _cash_order().order_id
        items_by_order = {oid: [AmazonItem(description="Air Widget", price=34.99, asin="B0AAA",
                                           source_file="2016-items.csv", source_file_hash="H-ITEMS")]}
        items_hashes = [{"filename": "2016-items.csv", "hash": "H-ITEMS"}]
        orders_only = _cash_order()
        orders_only.items = []
        orders_only.has_item_detail = False
        with self._use_db_path(), get_db() as conn:
            first = run_amazon_import(conn, merge([], items_by_order), account_id="amazon",
                                      filename="2016-items.csv", file_hashes=items_hashes)
            self.assertEqual(first["counts"]["items_discarded"], 1)   # parked, shown as "no matching order" on its card
            self.assertEqual([b["filename"] for b in first["batches"]], ["2016-items.csv"])
            self.assertEqual(set(_imported_amazon_file_hashes(conn)), set())   # items file stays re-importable
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM amazon_pending_item WHERE order_id = ?", (oid,)).fetchone()[0], 1)

            # The orders file arrives (without the items file): the parked detail attaches automatically.
            orders = run_amazon_import(conn, [orders_only], account_id="amazon", filename="2016-orders.csv",
                                       file_hashes=[{"filename": "2016-orders.csv", "hash": "H-ORDERS"}])
            self.assertEqual(orders["counts"]["items_attached_from_parked"], 1)
            # Both files are now remembered (the items file's hash moved onto the orders card on consolidation).
            self.assertEqual(set(_imported_amazon_file_hashes(conn)), {"H-ORDERS", "H-ITEMS"})
            row = conn.execute(
                """SELECT t.import_evidence_json FROM txn t
                   JOIN txn_link_member m ON m.txn_id = t.id
                   JOIN txn_link l ON l.id = m.link_id
                   WHERE l.kind = 'amazon_order' AND l.external_ref = ? AND m.role = 'order'""",
                (oid,)).fetchone()
            self.assertIn("B0AAA", row["import_evidence_json"])   # the parked item's ASIN folded into the order
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM amazon_pending_item").fetchone()[0], 0)
            # The items-only card is folded into the orders card: one card, labeled with both files.
            cards = conn.execute(
                "SELECT filename FROM import_batch WHERE source_kind = ? ORDER BY imported_at", (BATCH_SOURCE_KIND,)
            ).fetchall()
            self.assertEqual([c["filename"] for c in cards], ["2016-orders.csv, 2016-items.csv"])

    def test_undo_parking_batch_removes_parked_items(self):
        # Undoing the items-only (parking) import removes what it parked, so it can't later attach to an order.
        from backend.routers.import_export.amazon import reverse_batch_amazon_links
        oid = _cash_order().order_id
        items_by_order = {oid: [AmazonItem(description="Air Widget", asin="B0AAA",
                                           source_file="2016-items.csv", source_file_hash="H-ITEMS")]}
        with self._use_db_path(), get_db() as conn:
            first = run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="2016-items.csv")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM amazon_pending_item").fetchone()[0], 1)
            reverse_batch_amazon_links(conn, first["batches"][0]["batch_id"])   # the undo hook
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM amazon_pending_item").fetchone()[0], 0)

    def test_unmatched_count_resolves_after_orders_import(self):
        # The orphan card's live "still waiting" count is zero once its parked items attach to a later orders
        # import (and it re-flags if that import is undone) — derived from the ledger, not the static snapshot.
        from backend.routers.import_export.amazon import unmatched_parked_order_count, reverse_batch_amazon_links
        oid = _cash_order().order_id
        items_by_order = {oid: [AmazonItem(description="Air Widget", asin="B0AAA",
                                           source_file="2016-items.csv", source_file_hash="H-ITEMS")]}
        orders_only = _cash_order(); orders_only.items = []; orders_only.has_item_detail = False
        snapshot = {"discarded_items": [{"order_id": oid}]}
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="2016-items.csv")
            self.assertEqual(unmatched_parked_order_count(conn, snapshot), 1)   # waiting
            orders = run_amazon_import(conn, [orders_only], account_id="amazon", filename="2016-orders.csv")
            self.assertEqual(unmatched_parked_order_count(conn, snapshot), 0)   # resolved
            reverse_batch_amazon_links(conn, orders["batches"][0]["batch_id"])   # undo the orders import
            self.assertEqual(unmatched_parked_order_count(conn, snapshot), 1)   # re-flags

    def test_list_batches_reports_newest_txn_date_per_card(self):
        # Each marketplace card exposes its newest transaction date, so the history can order a multi-year
        # drop by data recency (the frontend sorts on it) rather than by import time.
        from backend.routers.import_export.core import list_batches
        o_old = _cash_order(order_id="OLD"); o_old.order_date = "2019-03-01"
        o_old.source_file = "2019.csv"; o_old.source_file_hash = "H19"
        o_new = _cash_order(order_id="NEW"); o_new.order_date = "2021-07-01"
        o_new.source_file = "2021.csv"; o_new.source_file_hash = "H21"
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [o_old, o_new], account_id="amazon", filename="drop")
        with self._use_db_path():
            cards = {b["filename"]: b for b in list_batches() if b.get("source_kind") == BATCH_SOURCE_KIND}
        self.assertEqual(cards["2019.csv"]["newest_txn_date"], "2019-03-01")
        self.assertEqual(cards["2021.csv"]["newest_txn_date"], "2021-07-01")

    def test_partial_consumption_keeps_the_items_card_separate(self):
        # An items file covering two orders, only one later imported: the items card still has a waiting item,
        # so it is NOT folded into the orders card (folding would hide the still-unresolved item).
        items_by_order = {
            "A-1": [AmazonItem(description="Widget One", asin="B01", source_file="items.csv", source_file_hash="H-I")],
            "A-2": [AmazonItem(description="Widget Two", asin="B02", source_file="items.csv", source_file_hash="H-I")],
        }
        order1 = _cash_order(order_id="A-1"); order1.items = []; order1.has_item_detail = False
        order1.source_file = "orders.csv"; order1.source_file_hash = "H-O"
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="items.csv")
            run_amazon_import(conn, [order1], account_id="amazon", filename="orders.csv")
            cards = conn.execute(
                "SELECT filename FROM import_batch WHERE source_kind = ?", (BATCH_SOURCE_KIND,)).fetchall()
            self.assertEqual(sorted(c["filename"] for c in cards), ["items.csv", "orders.csv"])   # both remain
            self.assertEqual(conn.execute(
                "SELECT order_id FROM amazon_pending_item WHERE consumed_batch_id IS NULL").fetchall()[0][0], "A-2")

    def test_undoing_orders_returns_the_items_it_took_to_waiting(self):
        # The orders import that took parked items can be undone, and the items wait again: importing those
        # orders a second time attaches the same detail. Were taking them to delete them, the second import
        # would come back without item detail while the items card still counted the orders as waiting.
        from backend.routers.import_export.core import undo_batches
        items_by_order = {
            "A-1": [AmazonItem(description="Widget One", asin="B01", source_file="items.csv", source_file_hash="H-I")],
            "A-2": [AmazonItem(description="Widget Two", asin="B02", source_file="items.csv", source_file_hash="H-I")],
        }

        def order_one():
            order = _cash_order(order_id="A-1"); order.items = []; order.has_item_detail = False
            order.source_file = "orders.csv"; order.source_file_hash = "H-O"
            return order

        def waiting(conn):
            return sorted(r[0] for r in conn.execute(
                "SELECT order_id FROM amazon_pending_item WHERE consumed_batch_id IS NULL"))

        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="items.csv")
            first = run_amazon_import(conn, [order_one()], account_id="amazon", filename="orders.csv")
            self.assertEqual(waiting(conn), ["A-2"])
            undo_batches(conn, [first["batch_id"]])
            self.assertEqual(waiting(conn), ["A-1", "A-2"])
            again = run_amazon_import(conn, [order_one()], account_id="amazon", filename="orders.csv")
            self.assertEqual(again["counts"]["items_attached_from_parked"], 1)
            evidence = conn.execute(
                "SELECT import_evidence_json FROM txn WHERE import_batch_id = ?", (again["batch_id"],)).fetchone()[0]
            self.assertIn("B01", evidence)

    def test_items_taken_by_two_orders_cards_stay_separate(self):
        # An items card whose orders arrived in two separate imports is not folded into the second: undoing
        # the first must find the items card again to return its items to.
        items_by_order = {
            "A-1": [AmazonItem(description="Widget One", asin="B01", source_file="items.csv", source_file_hash="H-I")],
            "A-2": [AmazonItem(description="Widget Two", asin="B02", source_file="items.csv", source_file_hash="H-I")],
        }
        order1 = _cash_order(order_id="A-1"); order1.items = []; order1.has_item_detail = False
        order1.source_file = "orders-1.csv"; order1.source_file_hash = "H-O1"
        order2 = _cash_order(order_id="A-2"); order2.items = []; order2.has_item_detail = False
        order2.source_file = "orders-2.csv"; order2.source_file_hash = "H-O2"
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, merge([], items_by_order), account_id="amazon", filename="items.csv")
            run_amazon_import(conn, [order1], account_id="amazon", filename="orders-1.csv")
            run_amazon_import(conn, [order2], account_id="amazon", filename="orders-2.csv")
            cards = conn.execute(
                "SELECT filename FROM import_batch WHERE source_kind = ?", (BATCH_SOURCE_KIND,)).fetchall()
            self.assertEqual(sorted(c["filename"] for c in cards), ["items.csv", "orders-1.csv", "orders-2.csv"])

    def test_orders_then_items_folds_into_one_card(self):
        # The mirror of the parked case: orders imported first, then a *separate* items file that enriches
        # those existing orders. The empty items card folds into the orders card — one card, both files,
        # both hashes remembered — the same end state as a combined drop.
        from backend.routers.import_export.amazon import _imported_amazon_file_hashes
        order = _cash_order(order_id="A-1"); order.items = []; order.has_item_detail = False
        order.source_file = "orders.csv"; order.source_file_hash = "H-O"
        items = {"A-1": [AmazonItem(description="Air Widget", asin="B0AAA", source_file="items.csv", source_file_hash="H-I")]}
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [order], account_id="amazon", filename="orders.csv",
                              file_hashes=[{"filename": "orders.csv", "hash": "H-O"}])
            result = run_amazon_import(conn, merge([], items), account_id="amazon", filename="items.csv",
                                       file_hashes=[{"filename": "items.csv", "hash": "H-I"}])
            self.assertEqual(result["counts"]["items_enriched"], 1)
            self.assertEqual([b["filename"] for b in result["batches"]], ["orders.csv, items.csv"])
            cards = conn.execute("SELECT filename FROM import_batch WHERE source_kind = ?", (BATCH_SOURCE_KIND,)).fetchall()
            self.assertEqual([c["filename"] for c in cards], ["orders.csv, items.csv"])   # one card
            self.assertEqual(set(_imported_amazon_file_hashes(conn)), {"H-O", "H-I"})   # both files remembered

    def test_items_enriching_two_orders_cards_stays_separate(self):
        # An items file that enriches orders spread across two separate orders cards can't be folded into a
        # single one, so it keeps its own card (the multi-card guard, mirroring the parked partial case).
        o1 = _cash_order(order_id="A-1"); o1.items = []; o1.has_item_detail = False; o1.source_file = "o1.csv"; o1.source_file_hash = "H1"
        o2 = _cash_order(order_id="A-2"); o2.items = []; o2.has_item_detail = False; o2.source_file = "o2.csv"; o2.source_file_hash = "H2"
        items = {"A-1": [AmazonItem(description="W1", source_file="items.csv", source_file_hash="HI")],
                 "A-2": [AmazonItem(description="W2", source_file="items.csv", source_file_hash="HI")]}
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [o1], account_id="amazon", filename="o1.csv")
            run_amazon_import(conn, [o2], account_id="amazon", filename="o2.csv")
            result = run_amazon_import(conn, merge([], items), account_id="amazon", filename="items.csv")
            self.assertEqual(result["counts"]["items_enriched"], 2)
            cards = sorted(c["filename"] for c in conn.execute(
                "SELECT filename FROM import_batch WHERE source_kind = ?", (BATCH_SOURCE_KIND,)).fetchall())
            self.assertEqual(cards, ["items.csv", "o1.csv", "o2.csv"])   # items card stays separate

    def test_drop_splits_into_one_card_per_orders_file(self):
        # Two orders files dropped at once land on their own cards — the same effect as importing each alone —
        # so unrelated periods get independent coverage / undo instead of one bundled card, and each file's
        # hash is remembered on its own card.
        from backend.routers.import_export.amazon import _imported_amazon_file_hashes
        o1 = _cash_order(order_id="A-1"); o1.source_file = "2016-orders.csv"; o1.source_file_hash = "H1"
        o2 = _cash_order(order_id="B-2"); o2.source_file = "2017-orders.csv"; o2.source_file_hash = "H2"
        file_hashes = [{"filename": "2016-orders.csv", "hash": "H1"}, {"filename": "2017-orders.csv", "hash": "H2"}]
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [o1, o2], account_id="amazon", filename="two files", file_hashes=file_hashes)
            rows = {b["filename"]: b for b in summary["batches"]}
            row_counts = {f: conn.execute("SELECT COUNT(*) FROM txn WHERE import_batch_id = ?",
                                          (b["batch_id"],)).fetchone()[0] for f, b in rows.items()}
            known = _imported_amazon_file_hashes(conn)
        self.assertEqual(set(rows), {"2016-orders.csv", "2017-orders.csv"})
        self.assertIsNone(summary["batch_id"])   # a multi-card drop has no single top-level batch id
        self.assertEqual(summary["order_count"], 2)
        self.assertEqual(row_counts, {"2016-orders.csv": 1, "2017-orders.csv": 1})
        self.assertEqual(set(known), {"H1", "H2"})

    def test_orders_and_items_of_one_period_share_a_card(self):
        # An orders file and its items file (same period) are two halves of one dataset — they fold into a
        # single card (the order enriched with item detail), labeled with both files, with both hashes
        # remembered there.
        from backend.routers.import_export.amazon import _imported_amazon_file_hashes
        order = _cash_order(order_id="A-1"); order.source_file = "2016-orders.csv"; order.source_file_hash = "H-O"
        order.items = []; order.has_item_detail = False
        items = {"A-1": [AmazonItem(description="Air Widget", price=34.99, asin="B0AAA",
                                    source_file="2016-items.csv", source_file_hash="H-I")]}
        merged = merge([order], items)
        file_hashes = [{"filename": "2016-orders.csv", "hash": "H-O"}, {"filename": "2016-items.csv", "hash": "H-I"}]
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, merged, account_id="amazon", filename="drop", file_hashes=file_hashes)
            known = _imported_amazon_file_hashes(conn)
        self.assertEqual(len(summary["batches"]), 1)
        self.assertEqual(summary["batches"][0]["filename"], "2016-orders.csv, 2016-items.csv")
        self.assertEqual(summary["counts"]["orders_imported"], 1)
        self.assertEqual(set(known), {"H-O", "H-I"})

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
        self.assertIsNotNone(recon["matched"][0]["charges"][0])
        self.assertAlmostEqual(recon["matched"][0]["order"]["amount"], 37.32, places=2)
        # The second cash order found no card charge → surfaced for a manual link.
        self.assertEqual(len(recon["amazon_unmatched"]), 1)
        self.assertEqual(recon["amazon_unmatched"][0]["order"]["amount"], 12.00)
        # It defaults to unreviewed, so it counts toward the batch's attention tally.
        self.assertFalse(recon["amazon_unmatched"][0]["reviewed"])
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(reconciliation_attention_count(conn, summary["batch_id"]), 1)

    def test_no_charge_found_acknowledgment_drops_out_of_attention(self):
        # A no-charge-found order counts toward attention until acknowledged; Mark reviewed keeps it in the
        # bucket but clears its attention weight, and un-acknowledging restores it.
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(
                conn, [_cash_order(order_id="no-charge", last4="9999", amount=12.00)],
                account_id="amazon", filename="orders.csv")
            batch_id = summary["batch_id"]
            link_id = amazon_reconciliation(conn, batch_id)["amazon_unmatched"][0]["link_id"]
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1)

            mark_orders_no_charge_reviewed(conn, [link_id])
            recon = amazon_reconciliation(conn, batch_id)
            self.assertEqual(len(recon["amazon_unmatched"]), 1, "acknowledged order stays visible in the bucket")
            self.assertTrue(recon["amazon_unmatched"][0]["reviewed"])
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 0, "acknowledged → no attention")

            mark_orders_no_charge_reviewed(conn, [link_id], reviewed=False)
            self.assertFalse(amazon_reconciliation(conn, batch_id)["amazon_unmatched"][0]["reviewed"])
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1, "un-acknowledged → back to attention")

    def test_linking_a_charge_clears_a_no_charge_acknowledgment(self):
        # Acknowledging then hand-linking a charge leaves the order matched, and the stale acknowledgment is
        # cleared — so if the charge is ever unlinked the order re-surfaces for a fresh review.
        stray = self._add_card_charge(12.00, date="2024-11-05")  # AMAZON.COM, no order — a link candidate
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(
                conn, [_cash_order(order_id="no-charge", last4="9999", amount=12.00)],
                account_id="amazon", filename="orders.csv")
            batch_id = summary["batch_id"]
            link_id = amazon_reconciliation(conn, batch_id)["amazon_unmatched"][0]["link_id"]
            mark_orders_no_charge_reviewed(conn, [link_id])
            manual_link_charge(conn, link_id, stray)
            unlink_order_charges(conn, link_id)   # order returns to no-charge-found
            recon = amazon_reconciliation(conn, batch_id)
            self.assertEqual(len(recon["amazon_unmatched"]), 1)
            self.assertFalse(recon["amazon_unmatched"][0]["reviewed"], "linking cleared the stale acknowledgment")

    # ---- a charge added to an order (the part paid with card rewards) -----------------------------

    def _order_with_rewards_charge(self, *, credit=True):
        """A matched order, plus the second charge and same-day credit a card records for the part of the
        order its rewards paid for."""
        self._add_card_charge(37.32)
        rewards = self._add_card_charge(5.81)
        if credit:
            self._add_card_charge(-5.81, name="Rewards redemption credit")
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=False)
            link_id = txn_links.find_link(conn, LINK_KIND, _cash_order().order_id)["id"]
        return link_id, rewards

    def _order_amount(self):
        return round(self._amazon_orders()[0]["amount"], 2)

    def test_a_rewards_charge_is_suggested_and_adding_it_raises_the_order(self):
        link_id, rewards = self._order_with_rewards_charge()
        with self._use_db_path(), get_db() as conn:
            [entry] = amazon_reconciliation(conn, self.batch_id)["payment_unmatched"]
            self.assertEqual(entry["id"], rewards)
            self.assertEqual(entry["suggested_link_id"], link_id)
            self.assertIsNotNone(entry["rewards_credit"])
            add_order_charge(conn, link_id, rewards)
            funding_id = find_or_create_funding_category(conn)
            [matched] = amazon_reconciliation(conn, self.batch_id)["matched"]
        self.assertEqual(self._order_amount(), 43.13)
        self.assertEqual(self._txn(rewards)["category_id"], funding_id)
        self.assertEqual(sorted((c["amount"], c["added"]) for c in matched["charges"]), [(5.81, True), (37.32, False)])

        with self._use_db_path(), get_db() as conn:
            remove_order_charge(conn, link_id, rewards)
            meta = txn_links.get_link(conn, link_id)["metadata"]
        self.assertEqual(self._order_amount(), 37.32)
        self.assertIsNone(self._txn(rewards)["category_id"])
        self.assertNotIn("added_charge_ids", meta)
        self.assertNotIn("order_base_amount", meta)

    def test_without_a_rewards_credit_the_order_is_offered_but_not_suggested(self):
        link_id, _rewards = self._order_with_rewards_charge(credit=False)
        with self._use_db_path(), get_db() as conn:
            [entry] = amazon_reconciliation(conn, self.batch_id)["payment_unmatched"]
        self.assertIsNone(entry["suggested_link_id"])
        self.assertEqual([o["link_id"] for o in entry["order_candidates"]], [link_id])

    def test_undoing_the_card_that_brought_the_charges_keeps_the_order_and_its_link(self):
        from backend.routers.import_export.core import undo_batches
        link_id, rewards = self._order_with_rewards_charge()
        with self._use_db_path(), get_db() as conn:
            add_order_charge(conn, link_id, rewards)
            conn.execute("INSERT INTO import_batch (id, filename) VALUES ('sync-card', 'card sync')")
            conn.execute("UPDATE txn SET import_batch_id = 'sync-card' WHERE account_id = 'card'")
            undo_batches(conn, ["sync-card"])
            link = txn_links.get_link(conn, link_id)
        self.assertIsNotNone(link, "the order's link belongs to the order's import, not the charge's")
        self.assertEqual([m["role"] for m in link["members"]], ["order"])
        self.assertEqual(self._order_amount(), 37.32)

    def test_deleting_an_added_charge_returns_the_order_to_its_imported_amount(self):
        from backend.services.import_batch_totals import delete_transactions
        link_id, rewards = self._order_with_rewards_charge()
        with self._use_db_path(), get_db() as conn:
            add_order_charge(conn, link_id, rewards)
            delete_transactions(conn, "id = ?", (rewards,))
        self.assertEqual(self._order_amount(), 37.32)

    def test_a_split_order_takes_no_added_charge_until_its_split_is_cleared(self):
        from backend.services.txn_splits import save_split
        link_id, rewards = self._order_with_rewards_charge()
        order_id = self._amazon_orders()[0]["id"]
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO category (id, name, category_type) VALUES ('grp', 'Shopping', 'expense')")
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES ('leaf', 'grp', 'Gadgets', 'expense')")
            save_split(conn, order_id, [{"category_id": "leaf", "amount": 30.00}, {"category_id": "leaf", "amount": 7.32}])
            with self.assertRaisesRegex(ValueError, "split"):
                add_order_charge(conn, link_id, rewards)
        self.assertEqual(self._order_amount(), 37.32)

    def test_order_rows_follow_their_owners_review_flagging(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE owner SET flag_new_for_review = 0 WHERE id = ?", (SHARED_OWNER_ID,))
            run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            flags = [r[0] for r in conn.execute("SELECT needs_review FROM txn WHERE account_id = 'amazon'")]
        self.assertEqual(flags, [0])

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

    def test_unaccounted_charge_counts_toward_attention_until_reviewed(self):
        # A reverse-scan ('Unaccounted charge') charge counts toward attention until acknowledged; Mark
        # reviewed keeps it listed but clears its attention weight, and un-acknowledging restores it.
        self._add_card_charge(37.32)                              # matches the order
        stray = self._add_card_charge(19.99, date="2024-11-20")  # AMAZON.COM, no order → reverse scan
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            batch_id = summary["batch_id"]
            recon = amazon_reconciliation(conn, batch_id)
            self.assertEqual(len(recon["payment_unmatched"]), 1)
            self.assertFalse(recon["payment_unmatched"][0]["reviewed"])
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1)

            mark_unaccounted_charges_reviewed(conn, [stray])
            recon = amazon_reconciliation(conn, batch_id)
            self.assertEqual(len(recon["payment_unmatched"]), 1, "acknowledged charge stays listed")
            self.assertTrue(recon["payment_unmatched"][0]["reviewed"])
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 0, "acknowledged → no attention")

            mark_unaccounted_charges_reviewed(conn, [stray], reviewed=False)
            self.assertFalse(amazon_reconciliation(conn, batch_id)["payment_unmatched"][0]["reviewed"])
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1, "un-acknowledged → back to attention")

    def test_linking_an_unaccounted_charge_clears_its_review(self):
        # Acknowledge a reverse-scan charge, then hand-link it to a no-charge-found order: it leaves the
        # reverse scan, and its stale acknowledgment is cleared so an unlink returns it for a fresh look.
        # The stray's amount (19.99) differs from the order's (12.00) so it isn't an auto-match candidate —
        # it stays a reverse-scan charge until we link it by hand.
        self._add_card_charge(37.32)                             # matches _cash_order(), seeds the reverse scan's account
        stray = self._add_card_charge(19.99, date="2024-11-20")  # AMAZON.COM, in window, no order
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(
                conn, [_cash_order(), _cash_order(order_id="no-charge", last4="9999", amount=12.00)],
                account_id="amazon", filename="orders.csv")
            batch_id = summary["batch_id"]
            self.assertEqual({c["id"] for c in amazon_reconciliation(conn, batch_id)["payment_unmatched"]}, {stray})
            mark_unaccounted_charges_reviewed(conn, [stray])
            self.assertTrue(conn.execute("SELECT 1 FROM amazon_charge_reviewed WHERE txn_id = ?", (stray,)).fetchone())
            link_id = amazon_reconciliation(conn, batch_id)["amazon_unmatched"][0]["link_id"]
            manual_link_charge(conn, link_id, stray)   # sum mismatch warns but is allowed
            self.assertIsNone(conn.execute("SELECT 1 FROM amazon_charge_reviewed WHERE txn_id = ?", (stray,)).fetchone(),
                              "linking cleared the stale acknowledgment")
            unlink_order_charges(conn, link_id)
            recon = amazon_reconciliation(conn, batch_id)
            self.assertEqual(len(recon["payment_unmatched"]), 1)
            self.assertFalse(recon["payment_unmatched"][0]["reviewed"])

    def test_zero_dollar_order_never_shows_no_charge_found(self):
        # A free/promo order (its cash legs sum to $0.00) is classified non-cash: recorded but not counted,
        # and absent from the reconciliation buckets — there is no charge to find, so it must not be
        # flagged "No charge found".
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(amount=0.0)], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(summary["counts"]["non_cash"], 1)
        self.assertEqual(recon["amazon_unmatched"], [])
        self.assertEqual(recon["matched_review"], [])

    # ---- split-charge reconciliation (Matched · review) -------------------------------------------

    def _split_batch(self, extra_charges):
        """A batch with one normal matched order (seeds the card account for the reverse scan) plus a $40
        'split' order with no single matching charge. `extra_charges` are (amount, date) shipment pieces,
        added first. Returns (batch_id, split_link_id_or_None, recon, [extra_charge_ids])."""
        self._add_card_charge(37.32)                       # matches _cash_order(), seeds the 'card' account
        ids = [self._add_card_charge(a, date=d) for a, d in extra_charges]
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(
                conn, [_cash_order(), _cash_order(order_id="split", amount=40.00)],
                account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
        split = [r for r in recon["matched_review"]] or None
        link_id = split[0]["link_id"] if split else None
        return summary["batch_id"], link_id, recon, ids

    def test_unaccounted_copies_group_as_duplicates(self):
        # Two same-amount strays a day apart on one card (bank post-date vs. aggregator date) group as
        # Unaccounted·duplicate; a same-amount stray too far off stays informational, as does a different
        # amount. Attention = the 1 duplicate group + the 2 unacknowledged informational singles (far, lone),
        # which now each count until Mark reviewed'd.
        self._add_card_charge(37.32)   # matches _cash_order(), seeds the account
        a = self._add_card_charge(12.50, date="2024-11-20")
        b = self._add_card_charge(12.50, date="2024-11-21")
        far = self._add_card_charge(12.50, date="2024-11-26")
        lone = self._add_card_charge(5.25, date="2024-11-20")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
            self.assertEqual(reconciliation_attention_count(conn, summary["batch_id"]), 3)
        self.assertEqual(len(recon["unaccounted_duplicate"]), 1)
        self.assertEqual({c["id"] for c in recon["unaccounted_duplicate"][0]["charges"]}, {a, b})
        self.assertEqual({c["id"] for c in recon["payment_unmatched"]}, {far, lone})

    def test_merge_unaccounted_copies_keeps_richest_and_trashes_the_rest(self):
        self._add_card_charge(37.32)
        a = self._add_card_charge(12.50, date="2024-11-20")
        b = self._add_card_charge(12.50, date="2024-11-21")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            result = merge_unaccounted_charges(conn, [a, b])
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(result["status"], "merged")
        self.assertIn(result["survivor_id"], {a, b})
        loser = b if result["survivor_id"] == a else a
        self.assertEqual(result["trashed"], [loser])
        self.assertIsNotNone(self._txn(loser)["trashed_at"])
        # The survivor returns to the informational unaccounted list; the group is gone.
        self.assertEqual(recon["unaccounted_duplicate"], [])
        self.assertEqual([c["id"] for c in recon["payment_unmatched"]], [result["survivor_id"]])

    def test_not_duplicates_assertion_unflags_the_group(self):
        # "Not duplicates" persists the pair assertion, so the grouping never re-flags them — both
        # copies return to the informational unaccounted list on the next refresh, and stay there.
        self._add_card_charge(37.32)
        a = self._add_card_charge(12.50, date="2024-11-20")
        b = self._add_card_charge(12.50, date="2024-11-21")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            self.assertEqual(len(amazon_reconciliation(conn, summary["batch_id"])["unaccounted_duplicate"]), 1)
            mark_charges_distinct(conn, [a, b])
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(recon["unaccounted_duplicate"], [])
        self.assertEqual({c["id"] for c in recon["payment_unmatched"]}, {a, b})

    def test_merged_copy_carries_provenance_and_restore_clears_it(self):
        # A merge loser is tagged with the dedupe flow's provenance (pointing at the kept copy), shows
        # in the Trash view, and Restore clears the tags — after which the group simply re-derives,
        # making a mistaken merge fully undoable.
        from backend.routers.transactions import list_trashed_transactions, restore_transaction
        self._add_card_charge(37.32)
        a = self._add_card_charge(12.50, date="2024-11-20")
        b = self._add_card_charge(12.50, date="2024-11-21")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            result = merge_unaccounted_charges(conn, [a, b])
        loser = result["trashed"][0]
        row = self._txn(loser)
        self.assertEqual(row["suspect_duplicate_of"], result["survivor_id"])
        self.assertEqual(row["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(row["dedupe_resolved_by"], "amazon_merge")
        with self._use_db_path():
            # Visible in the Trash view (unlike the unified dedupe flow's hidden confirmed rows)…
            self.assertIn(loser, [t["id"] for t in list_trashed_transactions(limit=200)])
            # …and Restore clears the provenance tags along with the untrash.
            restore_transaction(loser)
        row = self._txn(loser)
        self.assertIsNone(row["trashed_at"])
        self.assertIsNone(row["rejection_reason"])
        self.assertIsNone(row["dedupe_resolved_by"])
        self.assertIsNone(row["suspect_duplicate_of"])
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(len(amazon_reconciliation(conn, summary["batch_id"])["unaccounted_duplicate"]), 1)

    def test_plain_trash_files_as_an_ordinary_delete(self):
        # The row-level Trash on an unaccounted charge means "this shouldn't be in my ledger", not "this is
        # a redundant copy" — so it carries no dedupe provenance and lands in the Trash page's ordinary
        # Deleted transactions section rather than Duplicate transactions.
        from backend.routers.transactions import list_trashed_transactions
        stray = self._add_card_charge(12.34, date="2024-11-19")
        with self._use_db_path(), get_db() as conn:
            trash_duplicate_charge(conn, stray, None, as_duplicate=False)
        row = self._txn(stray)
        self.assertIsNotNone(row["trashed_at"])
        self.assertIsNone(row["rejection_reason"])
        self.assertIsNone(row["dedupe_resolved_by"])
        with self._use_db_path():
            listed = next(t for t in list_trashed_transactions(limit=200) if t["id"] == stray)
        self.assertIsNone(listed["dedupe_resolved_by"], "must group under Deleted transactions, not Duplicate")

    def test_discarded_copy_carries_provenance_without_kept_pointer(self):
        # A per-copy Discard tags the row like a merge loser (so the Trash page groups it under
        # import reconciliation) — minus the kept-copy pointer, which a discard doesn't always know.
        batch_id, _link, recon, ids = self._split_batch([(40.00, "2024-11-24"), (40.00, "2024-11-25")])
        link_id = recon["duplicate_review"][0]["link_id"]
        with self._use_db_path(), get_db() as conn:
            trash_duplicate_charge(conn, ids[1], link_id)
        row = self._txn(ids[1])
        self.assertEqual(row["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(row["dedupe_resolved_by"], "amazon_discard")
        self.assertIsNone(row["suspect_duplicate_of"])

    def test_merge_unaccounted_copies_validates_the_group(self):
        # The client sends explicit ids, so the server re-checks they're plausible copies.
        self._add_card_charge(37.32)
        a = self._add_card_charge(12.50, date="2024-11-20")
        b = self._add_card_charge(13.50, date="2024-11-21")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            linked = amazon_reconciliation(conn, summary["batch_id"])["matched"][0]["charges"][0]["id"]
            with self.assertRaises(ValueError):
                merge_unaccounted_charges(conn, [a])            # need at least two
            with self.assertRaises(ValueError):
                merge_unaccounted_charges(conn, [a, b])         # different amounts — not copies
            with self.assertRaises(ValueError):
                merge_unaccounted_charges(conn, [a, linked])    # an order's linked charge is off-limits

    def test_not_duplicates_on_in_window_group_resuggests_the_on_date_charge(self):
        # Two in-window equal charges → Duplicate detected. Marking them Not duplicates removes the
        # duplicate claim but not the "which one is the order's?" question — the order falls to the
        # suggestion pass, whose exact-date tie-break nominates the copy dated on the order itself.
        batch_id, _link, recon, ids = self._split_batch([(40.00, "2024-11-19"), (40.00, "2024-11-20")])
        self.assertEqual(len(recon["duplicate"]), 1)
        link_id = recon["duplicate"][0]["link_id"]
        with self._use_db_path(), get_db() as conn:
            mark_charges_distinct(conn, ids)
            recon2 = amazon_reconciliation(conn, batch_id)
        self.assertEqual(recon2["duplicate"], [])
        self.assertEqual(len(recon2["matched_review"]), 1)
        review = recon2["matched_review"][0]
        self.assertEqual(review["link_id"], link_id)
        self.assertEqual([c["id"] for c in review["charges"]], [ids[0]])   # the 2024-11-19 (order-date) copy
        self.assertIn("only charge dated on the order itself", review["reason"])
        # The off-date sibling stays an ordinary unaccounted charge — never re-grouped as a duplicate.
        self.assertIn(ids[1], [c["id"] for c in recon2["payment_unmatched"]])
        self.assertEqual(recon2["unaccounted_duplicate"], [])

    def test_not_duplicates_on_review_group_with_no_on_date_charge_goes_unmatched(self):
        # A Duplicate·review pair (both copies off-date) marked Not duplicates: no date evidence favors
        # either copy, so the order lands in No charge found and both copies stay plain unaccounted.
        batch_id, _link, recon, ids = self._split_batch([(40.00, "2024-11-24"), (40.00, "2024-11-25")])
        self.assertEqual(len(recon["duplicate_review"]), 1)
        with self._use_db_path(), get_db() as conn:
            mark_charges_distinct(conn, ids)
            recon2 = amazon_reconciliation(conn, batch_id)
        self.assertEqual(recon2["duplicate_review"], [])
        self.assertEqual(recon2["matched_review"], [])
        self.assertEqual(len(recon2["amazon_unmatched"]), 1)
        self.assertEqual({c["id"] for c in recon2["payment_unmatched"]} & set(ids), set(ids))
        self.assertEqual(recon2["unaccounted_duplicate"], [])

    def test_not_duplicates_on_matched_order_with_extra_copy_keeps_the_match_clean(self):
        # A matched order with an extra same-amount candidate marked Not duplicates: the match stands
        # (no duplicate row), and the extra flows to the reverse scan as a distinct purchase. The extra
        # copy arrives after the import — at import time the charge was unique, so the order matched.
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
        extra = self._add_card_charge(37.32, date="2024-11-20")
        with self._use_db_path(), get_db() as conn:
            recon = amazon_reconciliation(conn, summary["batch_id"])
            self.assertEqual(len(recon["duplicate"]), 1)
            linked = next(c["id"] for c in recon["duplicate"][0]["charges"] if c["matched"])
            mark_charges_distinct(conn, [linked, extra])
            recon2 = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(recon2["duplicate"], [])
        self.assertEqual(len(recon2["matched"]), 1)
        self.assertIn(extra, [c["id"] for c in recon2["payment_unmatched"]])

    def test_instrument_less_order_ignores_a_charge_that_does_not_look_like_amazon(self):
        # An order whose payments string names no card has no account/last-4 constraint, so amount+date
        # alone would drag in any coincidental charge. With no account signal the payee is the only one
        # left: a non-Amazon descriptor is not a candidate, so the order reports No charge found (a miss
        # the user can fix with Link charges…) rather than excluding someone else's payment.
        stray = self._add_card_charge(37.32, name="PayPal")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(last4=None)], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(recon["matched"], [])
        self.assertEqual(recon["duplicate"], [])
        self.assertEqual(recon["duplicate_review"], [])
        self.assertEqual(len(recon["amazon_unmatched"]), 1)
        self.assertIsNone(self._txn(stray)["trashed_at"])

    def test_instrument_less_order_picks_the_amazon_charge_over_a_coincidence(self):
        # The real case: a digital order's charge (AMZN DIGITAL WA) sits on one account while an unrelated
        # same-amount PayPal payment sits on another. The payee constraint leaves exactly one candidate,
        # so the order auto-matches correctly instead of flagging a bogus duplicate.
        self._add_second_funding_account()
        real = self._add_card_charge(9.99, account_id="card", name="AMZN DIGITAL WA")
        coincidence = self._add_card_charge(9.99, account_id="card2", name="PayPal")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(last4=None, amount=9.99)],
                                        account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(len(recon["matched"]), 1)
        self.assertEqual([c["id"] for c in recon["matched"][0]["charges"]], [real])
        self.assertEqual(recon["duplicate"], [])
        self.assertEqual(recon["duplicate_review"], [])
        self.assertIsNone(self._txn(coincidence)["trashed_at"])

    def test_carded_order_still_matches_a_non_amazon_descriptor(self):
        # The payee fallback applies ONLY when there's no account signal. An order carrying a last-4 keeps
        # matching on the mask, so a bank's odd descriptor doesn't break a legitimate match.
        charge = self._add_card_charge(37.32, name="SQ *SOME MERCHANT")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(len(recon["matched"]), 1)
        self.assertEqual([c["id"] for c in recon["matched"][0]["charges"]], [charge])

    def test_unlink_restores_the_charge_and_returns_the_order_to_unmatched(self):
        # The correction path for a wrong pairing: Unlink detaches the charge, restores the category it
        # had before being excluded into the funding category, and the order goes back to needing a
        # match (where Link charges… can pair it correctly).
        charge = self._add_card_charge(37.32)
        prior_category = self._txn(charge)["category_id"]
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
            funding_id = find_or_create_funding_category(conn)
        self.assertEqual(len(recon["matched"]), 1)
        link_id = recon["matched"][0]["link_id"]
        self.assertEqual(self._txn(charge)["category_id"], funding_id)   # excluded while linked
        with self._use_db_path(), get_db() as conn:
            result = unlink_order_charges(conn, link_id)
        with self._use_db_path(), get_db() as conn:
            recon2 = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(result["detached"], [charge])
        self.assertEqual(self._txn(charge)["category_id"], prior_category)   # category restored
        self.assertEqual(recon2["matched"], [])
        # The order needs a charge again — surfaced either as a review suggestion or No charge found.
        self.assertEqual(len(recon2["matched_review"]) + len(recon2["amazon_unmatched"]), 1)

    # ---- a charge that arrives after its order --------------------------------------------------

    def _import_order_without_charge(self, order=None):
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [order or _cash_order()], account_id="amazon", filename="orders.csv")
            self.assertEqual(len(amazon_reconciliation(conn, summary["batch_id"])["amazon_unmatched"]), 1)
        return summary["batch_id"]

    def test_a_charge_synced_after_the_order_links_to_it(self):
        # The Amazon file imported first: nothing to match then, so the order sat unmatched. The card
        # charge arriving later is the order's only candidate, so it pairs as it would have at import.
        batch_id = self._import_order_without_charge()
        charge = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(link_orders_to_new_charges(conn, [charge]), 1)
            recon = amazon_reconciliation(conn, batch_id)
            funding_id = find_or_create_funding_category(conn)
        self.assertEqual([c["id"] for c in recon["matched"][0]["charges"]], [charge])
        self.assertEqual(self._txn(charge)["category_id"], funding_id)

    def test_a_card_csv_imported_after_the_order_links_to_it(self):
        # The same through the CSV import, which runs the pass on its own.
        from backend.routers.import_export.core import run_import_core
        batch_id = self._import_order_without_charge()
        with self._use_db_path():
            run_import_core(
                "Date,Description,Amount\n2024-11-20,AMAZON MKTPL,-37.32\n",
                {"account_id": "card", "column_map": {"date": "Date", "description": "Description", "amount": "Amount"},
                 "date_format": "%Y-%m-%d", "amount_convention": "single_signed"},
                filename="card.csv",
            )
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(len(amazon_reconciliation(conn, batch_id)["matched"]), 1)

    def test_two_orders_wanting_one_new_charge_are_left_for_the_user(self):
        # Which of two same-amount orders the charge paid is not deducible, so neither takes it.
        self._import_order_without_charge(_cash_order("111-0000000-0000011"))
        self._import_order_without_charge(_cash_order("111-0000000-0000012"))
        charge = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(link_orders_to_new_charges(conn, [charge]), 0)
        self.assertIsNone(self._txn(charge)["category_id"])

    def test_charges_synced_days_after_orders_held_to_ship_together_pair(self):
        # The shipped-together case arriving the other way round: orders first, their later charges by sync.
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [self._carded_order("S-1", "2026-06-12"),
                                     self._carded_order("S-2", "2026-06-13"),
                                     self._carded_order("S-3", "2026-06-13")],
                              account_id="amazon", apply_categorization=False)
        charges = [self._add_card_charge(33.97, date="2026-06-17") for _ in range(3)]
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(link_orders_to_new_charges(conn, charges), 3)

    def _card_charge_fields(self, order_ref):
        with self._use_db_path(), get_db() as conn:
            link = txn_links.find_link(conn, LINK_KIND, order_ref)
            order_id = txn_links.member_txn_ids(conn, link["id"], role="order")[0]
            evidence = json.loads(conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?",
                                               (order_id,)).fetchone()[0] or "{}")
        return [f for f in evidence.get("extra_text_fields") or [] if f.get("header") == "Card charge"]

    def test_a_rule_on_the_charge_text_categorizes_the_order_once_the_charge_links(self):
        # The order's own text is its items; the charge says what the purchase was. Once linked, the
        # charge's text is on the order, so a source-text rule written for it categorizes the order, and
        # unlinking takes the text away again.
        order = self._digital_order("K-1", "2024-11-19", 11.99, "The Long Novel;")
        self._import_order_without_charge(order)
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO category (id, name, category_type) VALUES ('books', 'Books', 'expense')")
            conn.execute("""INSERT INTO category_rule (id, keyword, category_id, match_source_text)
                            VALUES ('r1', 'kindle svcs', 'books', 1)""")
        charge = self._add_card_charge(11.99, name="Kindle Svcs*AB12")
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(link_orders_to_new_charges(conn, [charge]), 1)
        fields = self._card_charge_fields("K-1")
        self.assertEqual([(f["value"], f["role"], f["txn_id"]) for f in fields],
                         [("Kindle Svcs*AB12", "linked", charge)])
        order_row = next(o for o in self._amazon_orders() if o["merchant_name"] == "The Long Novel;")
        self.assertEqual((order_row["category_id"], order_row["category_source"]), ("books", "rule"))
        with self._use_db_path(), get_db() as conn:
            unlink_order_charges(conn, txn_links.find_link(conn, LINK_KIND, "K-1")["id"])
        self.assertEqual(self._card_charge_fields("K-1"), [])

    def test_an_order_is_not_a_duplicate_of_its_own_charge_through_the_copied_text(self):
        from backend.services.duplicate_detection import scan_scope_for_cross_account_duplicates
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [_cash_order()], account_id="amazon", apply_categorization=False)
        self.assertEqual(len(self._card_charge_fields("111-0000000-0000010")), 1)
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(scan_scope_for_cross_account_duplicates(conn, ["amazon", "card"]), 0)

    def test_orders_linked_before_the_copy_existed_get_it_from_the_backfill(self):
        from backend.db.database import _backfill_amazon_charge_text
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [_cash_order()], account_id="amazon", apply_categorization=False)
            # As an order linked before this change stored it: no copied text.
            for row in conn.execute("SELECT id, import_evidence_json FROM txn WHERE account_id = 'amazon'").fetchall():
                evidence = json.loads(row["import_evidence_json"])
                evidence["extra_text_fields"] = [f for f in evidence.get("extra_text_fields") or []
                                                 if f.get("role") != "linked"]
                conn.execute("UPDATE txn SET import_evidence_json = ? WHERE id = ?", (json.dumps(evidence), row["id"]))
        self.assertEqual(self._card_charge_fields("111-0000000-0000010"), [])
        with self._use_db_path(), get_db() as conn:
            _backfill_amazon_charge_text(conn)
        self.assertEqual([f["value"] for f in self._card_charge_fields("111-0000000-0000010")], ["AMAZON.COM"])

    def test_a_pending_charge_waits_until_it_posts(self):
        self._import_order_without_charge()
        charge = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE txn SET is_pending = 1 WHERE id = ?", (charge,))
            self.assertEqual(link_orders_to_new_charges(conn, [charge]), 0)
            conn.execute("UPDATE txn SET is_pending = 0 WHERE id = ?", (charge,))
            self.assertEqual(link_orders_to_new_charges(conn, [charge]), 1)

    def test_a_charge_the_user_unlinked_is_not_paired_again(self):
        batch_id = self._import_order_without_charge()
        charge = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            link_orders_to_new_charges(conn, [charge])
            link_id = amazon_reconciliation(conn, batch_id)["matched"][0]["link_id"]
            unlink_order_charges(conn, link_id)
            # The next sync brings another row of that amount; the declined charge stays declined.
            other = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, raw_name, date, is_pending)
                   VALUES (?, 'card', ?, 37.32, 'CORNER CAFE', 'CORNER CAFE', '2024-12-30', 0)""",
                (other, SHARED_OWNER_ID),
            )
            self.assertEqual(link_orders_to_new_charges(conn, [other, charge]), 0)
            # Linking it by hand is the user's choice, and clears the decline.
            manual_link_charge(conn, link_id, charge)
            meta = txn_links.get_link(conn, link_id)["metadata"]
        self.assertNotIn("declined_charge_ids", meta)

    def test_the_list_feed_names_each_side_of_an_order_pairing(self):
        # The ledger row's link marker: the charge names its order, the order names each of its charges —
        # and a split order's shipment charges name the order, not each other.
        first, second = self._add_card_charge(20.00), self._add_card_charge(17.32, date="2024-11-21")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            link_id = amazon_reconciliation(conn, summary["batch_id"])["amazon_unmatched"][0]["link_id"]
            link_amazon_charges(conn, link_id, [first, second])
            order = txn_links.member_txn_ids(conn, link_id, role="order")[0]
            mapped = txn_links.partners_map(conn, LINK_KIND, [order, first, second])
        self.assertEqual({k: (v["role"], [o["id"] for o in v["others"]]) for k, v in mapped.items()},
                         {order: ("order", [first, second]), first: ("charge", [order]), second: ("charge", [order])})

    def test_unlink_refuses_an_order_with_no_linked_charge(self):
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
            link_id = amazon_reconciliation(conn, summary["batch_id"])["amazon_unmatched"][0]["link_id"]
            with self.assertRaises(ValueError):
                unlink_order_charges(conn, link_id)

    def test_order_evidence_captures_the_amazon_order_url(self):
        # The order's own Amazon page — often the only place a thin digital order's detail exists. Kept
        # out of extra_text_fields so it can't pollute rule source-text matching / merge text ranking.
        order = _cash_order()
        order.order_url = "https://www.amazon.com/your-orders/order-details?orderID=111-0000000-0000010"
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        evidence = json.loads(self._amazon_orders()[0]["import_evidence_json"])
        self.assertEqual(evidence["source_url"], order.order_url)
        self.assertNotIn(order.order_url, json.dumps(evidence["extra_text_fields"]))

    def test_order_evidence_rejects_a_non_http_order_url(self):
        # Captured URLs are rendered as real links, so a crafted export must not be able to smuggle a
        # javascript: URL into the ledger. The render side validates too; this keeps it out of the DB.
        hostile_urls = ("javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>x</script>",
                        "/relative/path", "   ")
        for i, hostile in enumerate(hostile_urls):
            order = _cash_order(order_id=f"url-{i}")
            order.order_url = hostile
            with self._use_db_path(), get_db() as conn:
                apply_amazon_order(conn, order, account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        # Every one of those orders exists, and not one of them captured a URL.
        stored = self._amazon_orders()
        self.assertEqual(len(stored), len(hostile_urls))
        for row in stored:
            self.assertNotIn("source_url", json.loads(row["import_evidence_json"]),
                             f"a non-http(s) order url must never be captured (row {row['id']})")

    def _add_second_funding_account(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('card2', 'p_card2', 'fixture', 'Other Card', 'Other Card', 'credit', ?)""",
                (SHARED_OWNER_ID,),
            )

    def test_charges_paying_two_different_orders_are_never_a_duplicate_pair(self):
        # Two same-amount Amazon charges on two cards, days apart, read as one charge on two linked accounts
        # until the orders arrive. Once each pays a different order they are two payments: the flag raised
        # before the link clears, and neither sweep raises it again.
        from backend.services.duplicate_detection import scan_scope_for_cross_account_duplicates
        self._add_second_funding_account()
        first = self._add_card_charge(9.55, date="2026-10-11", account_id="card2", name="Amazon")
        second = self._add_card_charge(9.55, date="2026-10-14", account_id="card", name="Amazon")

        def open_flags(conn):
            return {frozenset((r["id"], r["suspect_duplicate_of"])) for r in conn.execute(
                """SELECT id, suspect_duplicate_of FROM txn
                   WHERE suspect_duplicate_of IS NOT NULL AND suspect_resolved_at IS NULL""")}

        with self._use_db_path(), get_db() as conn:
            scan_scope_for_cross_account_duplicates(conn, ["card", "card2"])
            self.assertEqual(open_flags(conn), {frozenset((first, second))})
            run_amazon_import(conn, [self._digital_order("C-1", "2026-10-10", 9.55, "Cuticle Oil Pen Set;"),
                                     self._digital_order("E-1", "2026-10-11", 9.55, "Headset Ear Cushions;")],
                              account_id="amazon", apply_categorization=False)
            linked = {cid for ref in ("C-1", "E-1")
                      for cid in txn_links.member_txn_ids(conn, txn_links.find_link(conn, LINK_KIND, ref)["id"], role="charge")}
            self.assertEqual(linked, {first, second})
            self.assertEqual(open_flags(conn), set())
            scan_scope_for_cross_account_duplicates(conn, ["card", "card2"])
            self.assertEqual(open_flags(conn), set())
        # A charge no order explains is still checked against a linked one.
        stray = self._add_card_charge(9.55, date="2026-10-13", account_id="card2", name="Amazon")
        with self._use_db_path(), get_db() as conn:
            scan_scope_for_cross_account_duplicates(conn, ["card", "card2"])
            self.assertTrue(any(stray in pair for pair in open_flags(conn)))

    def test_same_amount_charges_on_different_accounts_are_not_duplicates(self):
        # An order whose payments string names no card (a D01 digital order → instrument null) has no
        # last-4/account constraint, so EVERY same-amount charge in the window is a candidate, on any
        # account. Two such charges on *different* accounts are distinct transactions, not two copies of
        # one charge — they must never be grouped as duplicates, because a Merge would trash a real
        # transaction on the other account.
        self._add_second_funding_account()
        a = self._add_card_charge(37.32, account_id="card")
        b = self._add_card_charge(37.32, account_id="card2")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(last4=None)], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(recon["duplicate"], [])
        self.assertEqual(recon["duplicate_review"], [])
        self.assertEqual(len(recon["amazon_unmatched"]), 1)   # ambiguous, but not a duplicate
        self.assertIsNone(self._txn(a)["trashed_at"])
        self.assertIsNone(self._txn(b)["trashed_at"])

    def test_merge_refuses_a_group_marked_not_duplicates(self):
        # Merge routes through the same _duplicate_group the report does, so a group the user settled as
        # distinct purchases can't be merged even by a direct API call with a stale link id.
        a = self._add_card_charge(37.32, account_id="card")
        b = self._add_card_charge(37.32, account_id="card")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(last4=None)], account_id="amazon", filename="orders.csv")
            link_id = amazon_reconciliation(conn, summary["batch_id"])["duplicate"][0]["link_id"]
            mark_charges_distinct(conn, [a, b])
        with self._use_db_path(), get_db() as conn:
            with self.assertRaisesRegex(ValueError, "not duplicates"):
                merge_duplicate_charges(conn, link_id)
        self.assertIsNone(self._txn(a)["trashed_at"])
        self.assertIsNone(self._txn(b)["trashed_at"])

    def test_merge_refuses_a_split_reconciliation(self):
        # A split order's linked charges are all real shipments, so none of them is a redundant "copy".
        # Merge must refuse rather than keep the richest and trash the other shipments — the row's
        # resolution is the per-copy Discard, which names what to remove.
        self._add_card_charge(37.32)                    # matches _cash_order() at import
        split_a = self._add_card_charge(30.00, date="2024-11-19")
        split_b = self._add_card_charge(10.00, date="2024-11-20")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(
                conn, [_cash_order(), _cash_order(order_id="split", amount=40.00)],
                account_id="amazon", filename="orders.csv")
            review = amazon_reconciliation(conn, summary["batch_id"])["matched_review"][0]
            link_amazon_charges(conn, review["link_id"], [split_a, split_b])   # accept the split
        with self._use_db_path(), get_db() as conn:
            with self.assertRaisesRegex(ValueError, "several shipment charges"):
                merge_duplicate_charges(conn, review["link_id"])
        # Both shipment charges survive and stay linked to the order.
        self.assertIsNone(self._txn(split_a)["trashed_at"])
        self.assertIsNone(self._txn(split_b)["trashed_at"])
        with self._use_db_path(), get_db() as conn:
            still_linked = txn_links.member_txn_ids(conn, review["link_id"], role="charge")
        self.assertEqual(set(still_linked), {split_a, split_b})

    def test_merge_refuses_a_cross_account_copy(self):
        # The matched order gains a same-amount charge on another account after the import. It is not a
        # redundant copy, so the row stays Matched and merge refuses server-side (the guard is re-derived
        # in merge_duplicate_charges, not trusted from the report).
        self._add_card_charge(37.32, account_id="card")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(last4=None)], account_id="amazon", filename="orders.csv")
        self._add_second_funding_account()
        other = self._add_card_charge(37.32, account_id="card2")
        with self._use_db_path(), get_db() as conn:
            recon = amazon_reconciliation(conn, summary["batch_id"])
            self.assertEqual(recon["duplicate"], [])
            self.assertEqual(len(recon["matched"]), 1)
            link_id = recon["matched"][0]["link_id"]
            with self.assertRaises(ValueError):
                merge_duplicate_charges(conn, link_id)
        self.assertIsNone(self._txn(other)["trashed_at"], "a real transaction on another account survives")

    def test_same_account_copies_still_group_and_merge(self):
        # Regression guard for the fix above: the genuine double-import case (both copies on ONE
        # account) must still surface as a duplicate and merge normally.
        a = self._add_card_charge(37.32, account_id="card")
        b = self._add_card_charge(37.32, account_id="card")
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order(last4=None)], account_id="amazon", filename="orders.csv")
            recon = amazon_reconciliation(conn, summary["batch_id"])
            self.assertEqual(len(recon["duplicate"]), 1)
            self.assertEqual({c["id"] for c in recon["duplicate"][0]["charges"]}, {a, b})
            result = merge_duplicate_charges(conn, recon["duplicate"][0]["link_id"])
        self.assertEqual(result["status"], "merged")

    def test_equal_charges_outside_match_window_surface_as_duplicate_review(self):
        # Two same-amount copies at +5/+6 days: too far for the strict (±3) duplicate bucket, but the
        # wider review window sees the ambiguity — surfaced as Duplicate·review for per-row resolution,
        # never as a plain duplicate, a split suggestion, or a silent "No charge found".
        batch_id, _link, recon, ids = self._split_batch([(40.00, "2024-11-24"), (40.00, "2024-11-25")])
        self.assertEqual(recon["duplicate"], [])
        self.assertEqual(recon["matched_review"], [])
        self.assertEqual(recon["amazon_unmatched"], [])
        self.assertEqual(len(recon["duplicate_review"]), 1)
        review = recon["duplicate_review"][0]
        self.assertEqual({c["id"] for c in review["charges"]}, set(ids))
        self.assertTrue(review["mergeable"])
        # It needs the user to act, so it counts toward the batch's attention tally.
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1)

    def test_duplicate_review_merge_uses_the_review_window(self):
        # Merge must sweep exactly the ±14-day copy set the report row displayed; the plain (±3)
        # derivation sees no copies here and refuses — the two populations never cross-contaminate.
        batch_id, _link, recon, ids = self._split_batch([(40.00, "2024-11-24"), (40.00, "2024-11-25")])
        link_id = recon["duplicate_review"][0]["link_id"]
        with self._use_db_path(), get_db() as conn:
            with self.assertRaises(ValueError):
                merge_duplicate_charges(conn, link_id)
            result = merge_duplicate_charges(conn, link_id, review_window=True)
            recon2 = amazon_reconciliation(conn, batch_id)
        self.assertEqual(result["status"], "merged")
        self.assertIn(result["survivor_id"], ids)
        loser = next(t for t in ids if t != result["survivor_id"])
        self.assertEqual(result["trashed"], [loser])
        self.assertIsNotNone(self._txn(loser)["trashed_at"])
        # The survivor is the order's linked charge now, so the row reconciles as matched.
        self.assertEqual(recon2["duplicate_review"], [])
        self.assertIn(result["survivor_id"],
                      [c["id"] for m in recon2["matched"] for c in m["charges"]])

    def test_duplicate_review_discard_pairs_the_surviving_later_charge(self):
        # Discarding the extra copy leaves one order and one charge five days after it, which is how Amazon
        # bills an order that shipped later, so the survivor links without an Accept.
        batch_id, _link, recon, ids = self._split_batch([(40.00, "2024-11-24"), (40.00, "2024-11-25")])
        link_id = recon["duplicate_review"][0]["link_id"]
        with self._use_db_path(), get_db() as conn:
            result = trash_duplicate_charge(conn, ids[1], link_id)
            recon2 = amazon_reconciliation(conn, batch_id)
        self.assertTrue(result["matched"])
        self.assertEqual(recon2["duplicate_review"], [])
        self.assertEqual(recon2["matched_review"], [])
        self.assertIn(ids[0], [c["id"] for m in recon2["matched"] for c in m["charges"]])

    def test_split_order_surfaces_as_matched_review(self):
        # No single charge equals the $40 order, but two unaccounted charges sum to it → a Matched·review
        # suggestion carrying both, their total, and their day-span; the order leaves "No charge found".
        _batch, link_id, recon, ids = self._split_batch([(30.00, "2024-11-19"), (10.00, "2024-11-20")])
        self.assertEqual(recon["amazon_unmatched"], [])
        self.assertEqual(len(recon["matched_review"]), 1)
        review = recon["matched_review"][0]
        self.assertEqual({c["id"] for c in review["charges"]}, set(ids))
        self.assertEqual(review["total"], 40.00)
        self.assertEqual(review["spans_days"], 1)
        self.assertIsNone(review["reason"])   # a genuine split — the charge count is the story

    def test_lone_charge_before_the_order_is_suggested_with_a_reason(self):
        # A single $40 charge 5 days before the order: exact amount, but Amazon bills on shipment, so only
        # the ±3-day matcher may reach back and this one is only suggested, with a note saying why.
        _batch, _link, recon, ids = self._split_batch([(40.00, "2024-11-14")])
        self.assertEqual(len(recon["matched_review"]), 1)
        review = recon["matched_review"][0]
        self.assertEqual([c["id"] for c in review["charges"]], ids)
        self.assertEqual(review["reason"],
                         "The charge is 5 days before the order — outside the automatic match's ±3-day window.")

    def test_lone_charge_days_after_the_order_pairs(self):
        _batch, _link, recon, ids = self._split_batch([(40.00, "2024-11-28")])
        self.assertEqual(recon["matched_review"], [])
        self.assertIn(ids[0], [c["id"] for m in recon["matched"] for c in m["charges"]])

    def test_lone_charge_a_cent_off_carries_a_reason(self):
        # A single charge within the 2¢ suggestion tolerance but not exactly equal — the auto-matcher
        # requires the exact amount, so the note names the discrepancy.
        _batch, _link, recon, _ids = self._split_batch([(40.01, "2024-11-19")])
        self.assertEqual(len(recon["matched_review"]), 1)
        self.assertEqual(recon["matched_review"][0]["reason"],
                         "The charge is 1¢ off the order total — the automatic match requires the exact amount.")

    def test_lone_charge_imported_after_the_order_carries_a_reason(self):
        # The charge passes every matcher rule *now* but arrived after the import — the note says the match
        # simply wasn't available at import time. (A matched first order seeds the card account, as in
        # _split_batch — the suggestion pool only scans accounts the batch or funding map already implicates.)
        self._add_card_charge(37.32)   # matches _cash_order()
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(
                conn, [_cash_order(), _cash_order(order_id="late", amount=40.00)],
                account_id="amazon", filename="orders.csv")
        self._add_card_charge(40.00)   # the late order's charge — lands after the import
        with self._use_db_path(), get_db() as conn:
            recon = amazon_reconciliation(conn, summary["batch_id"])
        self.assertEqual(len(recon["matched_review"]), 1)
        self.assertEqual(recon["matched_review"][0]["reason"],
                         "This charge qualifies for an automatic match now, but wasn't available (or wasn't "
                         "the only candidate) when the order was imported.")

    def test_split_flags_charges_more_than_a_week_apart(self):
        # A wider (±14d) window than the auto-matcher, but a >7-day spread is flagged for the user to eyeball.
        _batch, _link, recon, _ids = self._split_batch([(30.00, "2024-11-19"), (10.00, "2024-11-29")])
        self.assertEqual(len(recon["matched_review"]), 1)
        self.assertEqual(recon["matched_review"][0]["spans_days"], 10)

    def test_ambiguous_split_stays_unmatched(self):
        # Two distinct subsets sum to the total (30+10 and 20+20) → we never guess; the order stays unmatched.
        _batch, link_id, recon, _ids = self._split_batch(
            [(30.00, "2024-11-19"), (10.00, "2024-11-19"), (20.00, "2024-11-19"), (20.00, "2024-11-20")])
        self.assertEqual(recon["matched_review"], [])
        self.assertEqual(len(recon["amazon_unmatched"]), 1)

    def test_accept_split_links_all_and_undo_restores_each_charge(self):
        # Accepting links every suggested charge (each excluded), and undo restores each to its *own* prior
        # category — the per-charge `charge_priors` path, not one prior applied to all.
        batch_id, link_id, _recon, ids = self._split_batch([(30.00, "2024-11-19"), (10.00, "2024-11-20")])
        c1, c2 = ids
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO category (id, name, category_type) VALUES ('cat-a','Cat A','expense')")
            conn.execute("INSERT INTO category (id, name, category_type) VALUES ('cat-b','Cat B','expense')")
            conn.execute("UPDATE txn SET category_id='cat-a' WHERE id=?", (c1,))
            conn.execute("UPDATE txn SET category_id='cat-b' WHERE id=?", (c2,))
            link_amazon_charges(conn, link_id, [c1, c2])
            recon2 = amazon_reconciliation(conn, batch_id)
            funding = find_or_create_funding_category(conn)
        # The order is now matched, carrying both charges; both were moved to the funding category.
        self.assertEqual(recon2["matched_review"], [])
        matched = [m for m in recon2["matched"] if m["link_id"] == link_id]
        self.assertEqual({c["id"] for c in matched[0]["charges"]}, {c1, c2})
        self.assertEqual(self._txn(c1)["category_id"], funding)
        self.assertEqual(self._txn(c2)["category_id"], funding)
        with self._use_db_path(), get_db() as conn:
            reverse_batch_amazon_links(conn, batch_id)
        self.assertEqual(self._txn(c1)["category_id"], "cat-a")
        self.assertEqual(self._txn(c2)["category_id"], "cat-b")

    def test_dismiss_split_suppresses_the_suggestion(self):
        # Dismiss persists (link metadata), so the suggestion doesn't come back; the order returns to unmatched.
        batch_id, link_id, _recon, _ids = self._split_batch([(30.00, "2024-11-19"), (10.00, "2024-11-20")])
        with self._use_db_path(), get_db() as conn:
            dismiss_split_suggestion(conn, link_id)
            recon2 = amazon_reconciliation(conn, batch_id)
        self.assertEqual(recon2["matched_review"], [])
        self.assertEqual(len(recon2["amazon_unmatched"]), 1)

    def test_actionable_reconciliation_surfaces_a_task(self):
        # Two identical charges make an order's charge ambiguous → a duplicate to resolve. That's actionable,
        # so the Tasks nag surfaces an "amazon_reconciliation" warning counting it.
        from backend.routers.tasks import get_tasks
        self._add_card_charge(37.32)
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
        with self._use_db_path():
            tasks = {t["id"]: t for t in get_tasks()["tasks"]}
        self.assertIn("amazon_reconciliation", tasks)
        self.assertEqual(tasks["amazon_reconciliation"]["count"], 1)
        self.assertEqual(tasks["amazon_reconciliation"]["severity"], "warning")

    def test_clean_reconciliation_has_no_task(self):
        # One order cleanly matched to its single charge → nothing actionable → no reconciliation task.
        from backend.routers.tasks import get_tasks
        self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
        with self._use_db_path():
            task_ids = {t["id"] for t in get_tasks()["tasks"]}
        self.assertNotIn("amazon_reconciliation", task_ids)

    # ---- import-detail report --------------------------------------------------------------------

    def test_import_detail_records_duplicates_and_discards_with_source_file(self):
        # The exact file mix-up that motivated this: the same order re-imported from a second orders file
        # (a duplicate) and an items file for an order that was never imported (discarded) — each traceable
        # back to the file it came from.
        from backend.routers.import_export.amazon import amazon_import_detail
        first = _cash_order(order_id="A-1"); first.source_file = "2016-orders.csv"; first.source_file_hash = "H-2016O"
        with self._use_db_path(), get_db() as conn:
            run_amazon_import(conn, [first], account_id="amazon", filename="2016-orders.csv")
        # A drop mixing a bare re-import of an already-imported orders file (a duplicate) and an items file for
        # an order that was never imported (a discard). Per-file batching splits them onto their own cards.
        dup = _cash_order(order_id="A-1"); dup.source_file = "2017-orders.csv"; dup.source_file_hash = "H-2017O"
        dup.items = []; dup.has_item_detail = False   # a bare re-import, so it's already_applied not enriched
        orphan = AmazonItem(description="Ghost Widget", order_date="2017-03-04",
                            source_file="2017-items.csv", source_file_hash="H-2017I")
        merged = merge([dup], {"A-2": [orphan]})
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, merged, account_id="amazon", filename="2017 drop")
            by_file = {b["filename"]: b["batch_id"] for b in summary["batches"]}
            orders_detail = amazon_import_detail(conn, by_file["2017-orders.csv"])
            items_detail = amazon_import_detail(conn, by_file["2017-items.csv"])
        self.assertEqual(set(by_file), {"2017-orders.csv", "2017-items.csv"})
        # The duplicate lands on the orders-file card; the discard on the items-file card — each isolated.
        self.assertEqual([(d["order_id"], d["source_file"]) for d in orders_detail["duplicate_orders"]], [("A-1", "2017-orders.csv")])
        self.assertEqual(orders_detail["items_discarded"], [])
        self.assertEqual([(d["order_id"], d["date"], d["source_file"]) for d in items_detail["items_discarded"]],
                         [("A-2", "2017-03-04", "2017-items.csv")])
        self.assertEqual(items_detail["duplicate_orders"], [])

    def test_import_detail_duplicates_resolve_to_the_ledger_order(self):
        # A duplicate row shows the order it duplicates (date, description, amount, account), keeping this
        # import's order id + source file; once that order is gone it falls back to the recorded id + date.
        from backend.routers.import_export.amazon import amazon_import_detail
        first = _cash_order(order_id="A-1"); first.source_file = "2016-orders.csv"; first.source_file_hash = "H-2016O"
        dup = _cash_order(order_id="A-1"); dup.source_file = "2017-orders.csv"; dup.source_file_hash = "H-2017O"
        dup.items = []; dup.has_item_detail = False
        with self._use_db_path(), get_db() as conn:
            original = run_amazon_import(conn, [first], account_id="amazon", filename="2016-orders.csv")
            again = run_amazon_import(conn, [dup], account_id="amazon", filename="2017-orders.csv")
            [ledger_order] = amazon_import_detail(conn, original["batch_id"])["orders"]
            [row] = amazon_import_detail(conn, again["batch_id"])["duplicate_orders"]
            self.assertEqual((row["id"], row["amount"], row["name"], row["account"]),
                             (ledger_order["id"], ledger_order["amount"], ledger_order["name"], ledger_order["account"]))
            self.assertEqual((row["order_id"], row["source_file"]), ("A-1", "2017-orders.csv"))
            conn.execute("DELETE FROM txn_link_member WHERE txn_id = ?", (ledger_order["id"],))
            [fallback] = amazon_import_detail(conn, again["batch_id"])["duplicate_orders"]
        self.assertEqual(fallback, {"order_id": "A-1", "date": dup.order_date, "source_file": "2017-orders.csv"})

    def test_import_detail_orders_and_payments(self):
        # The orders view carries each order's source file + item-detail flag; the payments view tallies the
        # matched card charges by the ledger account they landed on.
        from backend.routers.import_export.amazon import amazon_import_detail
        self._add_card_charge(37.32)   # the order's matching charge, on the 'Rewards Card' account
        order = _cash_order(); order.source_file = "2016-orders.csv"
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [order], account_id="amazon", filename="2016-orders.csv")
            detail = amazon_import_detail(conn, summary["batch_id"])
        self.assertEqual(len(detail["orders"]), 1)
        self.assertEqual(detail["orders"][0]["source_file"], "2016-orders.csv")
        self.assertTrue(detail["orders"][0]["has_item_detail"])   # _cash_order carries items
        self.assertEqual(detail["payments"], [{"account": "Rewards Card", "count": 1, "total": 37.32}])

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
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
        self.assertEqual(self._txn(charge_id)["category_id"], "amz")

    def test_funding_category_falls_back_when_choice_deleted(self):
        # If the chosen category no longer exists, the engine falls back to the default (never crashes).
        from backend.db.database import set_tenant_workflow_state
        from backend.routers.import_export.amazon import FUNDING_CATEGORY_STATE_KEY
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            set_tenant_workflow_state(conn, FUNDING_CATEGORY_STATE_KEY, {"category_id": "ghost"})
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
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

    # ---- an excluded charge is feature-owned: automatic categorization must not touch it (#1) --------

    def _add_rule(self, keyword, leaf_name):
        """A simple keyword→leaf rule, creating the leaf under a plain (non-excluded) group."""
        with self._use_db_path(), get_db() as conn:
            grp = conn.execute("SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (leaf_name + " Grp",)).fetchone()
            grp_id = grp["id"] if grp else str(uuid.uuid4())
            if not grp:
                conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, ?, 'expense')", (grp_id, leaf_name + " Grp"))
            leaf_id = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, ?, 'expense')", (leaf_id, grp_id, leaf_name))
            conn.execute("INSERT INTO category_rule (id, category_id, keyword) VALUES (?, ?, ?)", (str(uuid.uuid4()), leaf_id, keyword))
        return leaf_id

    def test_recategorize_all_leaves_an_excluded_charge_excluded_with_no_rule(self):
        # With no matching rule, recategorize_all clears rule/uncategorized rows to NULL — but the excluded
        # funding charge is `enrichment`, feature-owned, and must stay excluded (else it re-enters totals).
        charge_id = self._add_card_charge(37.32)
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            funding_id = find_or_create_funding_category(conn)
            recategorize_all(conn)
        charge = self._txn(charge_id)
        self.assertEqual(charge["category_id"], funding_id, "excluded charge must survive recategorize")
        self.assertEqual(charge["category_source"], "enrichment")

    def test_recategorize_all_does_not_let_a_rule_reclaim_an_excluded_charge(self):
        # A rule matching the charge's Amazon merchant must NOT pull the excluded charge into its category —
        # that would un-exclude it and double-count the order's spend.
        charge_id = self._add_card_charge(37.32, name="AMAZON.COM")
        shopping_leaf = self._add_rule("amazon", "Online Shopping")
        with self._use_db_path(), get_db() as conn:
            apply_amazon_order(conn, _cash_order(), account_id="amazon", batch_id=self.batch_id, flag_for_review=True)
            funding_id = find_or_create_funding_category(conn)
            recategorize_all(conn)
        charge = self._txn(charge_id)
        self.assertEqual(charge["category_id"], funding_id, "a rule must not reclaim an enrichment row")
        self.assertNotEqual(charge["category_id"], shopping_leaf)
        self.assertEqual(charge["category_source"], "enrichment")

    # ---- effective-account grouping of unaccounted duplicates across a merge (#3) --------------------

    def _merge_child_under(self, parent_id, *, mask, name):
        """Insert a child account merged under `parent_id` (its effective account is the parent)."""
        child_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, mask, owner_id, parent_account_id)
                   VALUES (?, ?, 'fixture', ?, ?, 'credit', ?, ?, ?)""",
                (child_id, f"p_{child_id}", name, name, mask, SHARED_OWNER_ID, parent_id),
            )
        return child_id

    def test_unaccounted_copies_across_a_merge_group_and_merge(self):
        # Two copies of one Amazon charge that straddle a parent/child account merge share an *effective*
        # account, so they must group as one unaccounted-duplicate (and be mergeable) — a raw account_id
        # comparison would wrongly treat them as distinct.
        child_id = self._merge_child_under("card", mask="9999", name="Rewards Card (old)")
        copy_a = self._add_card_charge(50.00, date="2024-03-01", account_id="card", name="AMZN Mktp US")
        copy_b = self._add_card_charge(50.00, date="2024-03-02", account_id=child_id, name="AMAZON.COM")
        with self._use_db_path(), get_db() as conn:
            charges = [_txn_summary(conn, copy_a), _txn_summary(conn, copy_b)]
            singles, groups = _group_unaccounted_duplicates(conn, charges)
        self.assertEqual(singles, [])
        self.assertEqual(len(groups), 1)
        self.assertEqual({c["id"] for c in groups[0]["charges"]}, {copy_a, copy_b})

        with self._use_db_path(), get_db() as conn:
            result = merge_unaccounted_charges(conn, [copy_a, copy_b])
        self.assertEqual(result["status"], "merged")
        self.assertEqual(len(result["trashed"]), 1)

    # ---- equal-count pairing links each order to its OWN card, never a swap (#5) ---------------------

    def _order_link_no_charge(self, *, order_date, last4, amount):
        """A cash order link with no charge yet (as the equal-count pass finds them), carrying the
        instrument in metadata so `_order_charge_candidates` reconstructs the matcher's candidate set."""
        order_txn = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending, import_batch_id)
                   VALUES (?, 'amazon', ?, ?, 'Amazon order', 'Amazon order', 'Amazon order', ?, 0, ?)""",
                (order_txn, SHARED_OWNER_ID, amount, order_date, self.batch_id),
            )
            link_id = txn_links.create_link(
                conn, LINK_KIND, [(order_txn, "order")], external_ref=str(uuid.uuid4()),
                metadata={"disposition": "cash", "charge_amount": amount,
                          "instrument": {"last4": last4, "network": "Visa"}},
            )
        return link_id

    def test_equal_count_pairing_matches_each_order_to_its_own_card(self):
        # Two same-amount orders on different cards, each with exactly one eligible charge on its own card,
        # left unmatched for the equal-count pass. A blind date-sort zip would cross them (order A's charge
        # is dated later than order B's); the perfect matching must link each order to ITS card's charge.
        card1 = self._merge_child_under_top(mask="1111", name="Card One")
        card2 = self._merge_child_under_top(mask="2222", name="Card Two")
        # Crossed dates: order A earlier, its charge later; order B later, its charge earlier.
        link_a = self._order_link_no_charge(order_date="2024-05-10", last4="1111", amount=50.00)
        link_b = self._order_link_no_charge(order_date="2024-05-11", last4="2222", amount=50.00)
        charge_x = self._add_card_charge(50.00, date="2024-05-12", account_id=card1, name="AMZN Mktp")
        charge_y = self._add_card_charge(50.00, date="2024-05-09", account_id=card2, name="AMZN Mktp")

        with self._use_db_path(), get_db() as conn:
            paired = _pair_equal_amount_clusters(conn, self.batch_id, recategorize=False)
            a_charges = txn_links.member_txn_ids(conn, link_a, role="charge")
            b_charges = txn_links.member_txn_ids(conn, link_b, role="charge")
        self.assertEqual(paired, 2)
        self.assertEqual(a_charges, [charge_x], "order A (last4 1111) must link its own card's charge")
        self.assertEqual(b_charges, [charge_y], "order B (last4 2222) must link its own card's charge")

    def _merge_child_under_top(self, *, mask, name):
        """A standalone top-level card account with a mask — its own effective account."""
        acct_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, mask, owner_id)
                   VALUES (?, ?, 'fixture', ?, ?, 'credit', ?, ?)""",
                (acct_id, f"p_{acct_id}", name, name, mask, SHARED_OWNER_ID),
            )
        return acct_id

    # ---- reconciliation attention count is cached and invalidated by charge edits ------------------

    def _recon_epoch(self):
        from backend.services.reconciliation_attention import recon_epoch as _recon_epoch
        with self._use_db_path(), get_db() as conn:
            return _recon_epoch(conn)

    def _batch_with_a_duplicate(self):
        """An Amazon batch whose order has a duplicated charge → attention count 1."""
        self._add_card_charge(37.32)
        dup = self._add_card_charge(37.32)  # a second same-amount copy makes the auto-match ambiguous
        with self._use_db_path(), get_db() as conn:
            summary = run_amazon_import(conn, [_cash_order()], account_id="amazon", filename="orders.csv")
        return summary["batch_id"], dup

    def test_attention_count_is_cached_until_a_charge_edit(self):
        batch_id, _dup = self._batch_with_a_duplicate()
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1)
            # The value is now cached on the batch at the current epoch.
            row = conn.execute("SELECT recon_attention_count, recon_epoch FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
            self.assertEqual(row["recon_attention_count"], 1)
            self.assertIsNotNone(row["recon_epoch"])
        # Corrupt the cached value *without* bumping the epoch (a bare import_batch write fires no trigger).
        # A clean read must return the cached value — proving it did not recompute.
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE import_batch SET recon_attention_count = 999 WHERE id = ?", (batch_id,))
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 999, "a clean read serves the cache, not a recompute")

    def test_a_restart_invalidates_the_cache(self):
        # A cached value is stamped only with the data it came from, so one written by earlier code must not
        # outlive a start: new code may compute it differently.
        batch_id, _dup = self._batch_with_a_duplicate()
        with self._use_db_path(), get_db() as conn:
            reconciliation_attention_count(conn, batch_id)
            conn.execute("UPDATE import_batch SET recon_attention_count = 999 WHERE id = ?", (batch_id,))
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1)

    def test_a_charge_edit_invalidates_the_cache(self):
        batch_id, dup = self._batch_with_a_duplicate()
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 1)
        epoch_before = self._recon_epoch()
        # Resolve the ambiguity through the report's Discard: it trashes the redundant copy (a txn edit that
        # bumps the epoch) and re-runs the pairing pass so the order links to the survivor — now matched.
        with self._use_db_path(), get_db() as conn:
            link_id = amazon_reconciliation(conn, batch_id)["duplicate"][0]["link_id"]
            trash_duplicate_charge(conn, dup, link_id)
        self.assertGreater(self._recon_epoch(), epoch_before, "a charge edit must advance the epoch")
        # The stale cache is recomputed on the next read: the order now matches cleanly, attention 0.
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(reconciliation_attention_count(conn, batch_id), 0)
            self.assertEqual(
                conn.execute("SELECT recon_attention_count FROM import_batch WHERE id = ?", (batch_id,)).fetchone()["recon_attention_count"], 0)

    def test_an_unrelated_charge_edit_still_invalidates(self):
        # Strict invalidation: even an edit to a charge on another account bumps the epoch, so the cached
        # count is recomputed rather than trusted. (Over-invalidation is safe — the recompute yields the
        # same 1 here; the point is the cache never goes stale.)
        batch_id, _dup = self._batch_with_a_duplicate()
        with self._use_db_path(), get_db() as conn:
            reconciliation_attention_count(conn, batch_id)
            cached_epoch = conn.execute("SELECT recon_epoch FROM import_batch WHERE id = ?", (batch_id,)).fetchone()["recon_epoch"]
        _unrelated = self._add_card_charge(5.00, name="Grocery Store")
        with self._use_db_path(), get_db() as conn:
            reconciliation_attention_count(conn, batch_id)
            new_epoch = conn.execute("SELECT recon_epoch FROM import_batch WHERE id = ?", (batch_id,)).fetchone()["recon_epoch"]
        self.assertGreater(new_epoch, cached_epoch, "the cache was refreshed at a newer epoch after an unrelated charge insert")


if __name__ == "__main__":
    unittest.main()
