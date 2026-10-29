"""
The AZAD export parser (`services/amazon_import.py`): compound `payments` parsing, footer skipping,
the orders/items join, and header-based source sniffing.

All fixtures here are *fabricated* — modeled on the AZAD export shape but carrying no real order data.
"""

from __future__ import annotations

import unittest

from backend.services.amazon_import import (
    AmazonItem,
    AmazonOrder,
    PaymentLeg,
    classify_order,
    is_footer_row,
    merge,
    parse_item_rows,
    parse_money,
    parse_order_rows,
    parse_payments,
    read_export,
    sniff_kind,
)

# Fabricated header rows matching the real export column order.
ORDERS_HEADER = "﻿order id,order url,items,to,date,total,shipping,shipping_refund,gift,tax,refund,payments"
ITEMS_HEADER = "﻿order id,order url,order date,quantity,description,item url,price,subscribe & save,ASIN,category"


class ParseMoneyTests(unittest.TestCase):
    def test_variants(self):
        self.assertEqual(parse_money("$8.99"), 8.99)
        self.assertEqual(parse_money("9.55"), 9.55)
        self.assertEqual(parse_money("1,234.00"), 1234.0)
        self.assertEqual(parse_money("0"), 0.0)

    def test_blank_and_formula_are_none(self):
        self.assertIsNone(parse_money(""))
        self.assertIsNone(parse_money(None))
        self.assertIsNone(parse_money("=SUBTOTAL(109,F2:F37)"))

    def test_a_comma_decimal_value_is_none_rather_than_misread(self):
        self.assertIsNone(parse_money("1.234,56"))
        self.assertIsNone(parse_money("9,55"))


class ParsePaymentsTests(unittest.TestCase):
    def test_single_card_leg(self):
        legs = parse_payments("Test Card ending in 4321: 2024-12-22: $9.55; ")
        self.assertEqual(len(legs), 1)
        self.assertEqual(legs[0], PaymentLeg(method="Test Card", last4="4321", date="2024-12-22", amount=9.55, is_non_cash=False))

    def test_card_plus_rewards_points(self):
        legs = parse_payments("Test Card ending in 4321; Rewards Points; ")
        self.assertEqual(len(legs), 2)
        card, points = legs
        self.assertEqual((card.method, card.last4, card.amount, card.is_non_cash), ("Test Card", "4321", None, False))
        self.assertEqual((points.method, points.amount, points.is_non_cash), ("Rewards Points", None, True))

    def test_gift_card_balance_is_non_cash(self):
        legs = parse_payments("Amazon gift card balance; Test Card ending in 4321; ")
        gift, card = legs
        self.assertTrue(gift.is_non_cash)
        self.assertEqual(gift.method, "Amazon gift card balance")
        self.assertFalse(card.is_non_cash)

    def test_off_card_leg_has_amount_but_no_card(self):
        legs = parse_payments("2024-01-06: $39.83; ")
        self.assertEqual(len(legs), 1)
        self.assertEqual((legs[0].method, legs[0].last4, legs[0].date, legs[0].amount), (None, None, "2024-01-06", 39.83))

    def test_empty(self):
        self.assertEqual(parse_payments(""), [])
        self.assertEqual(parse_payments(None), [])


class FooterTests(unittest.TestCase):
    def test_blank_order_id_is_footer(self):
        self.assertTrue(is_footer_row({"order id": "", "total": "=SUBTOTAL(109,F2:F37)"}))

    def test_formula_cell_is_footer(self):
        self.assertTrue(is_footer_row({"order id": "111-0000000-0000001", "total": "=SUBTOTAL(1)"}))

    def test_real_row_is_not_footer(self):
        self.assertFalse(is_footer_row({"order id": "111-0000000-0000001", "total": "9.55"}))


class OrderRowTests(unittest.TestCase):
    def test_parses_fields_and_skips_footer(self):
        rows = [
            {"﻿order id": "111-0000000-0000001", "order url": "https://example/x", "items": "Widget A; ",
             "to": "Test User", "date": "2024-12-22", "total": "9.55", "shipping": "0",
             "shipping_refund": "", "gift": "", "tax": "0.56", "refund": "",
             "payments": "Test Card ending in 4321: 2024-12-22: $9.55; "},
            {"order id": "", "total": "=SUBTOTAL(109,F2:F37)", "payments": ""},  # footer
        ]
        orders = parse_order_rows(rows)
        self.assertEqual(len(orders), 1)
        o = orders[0]
        self.assertEqual(o.order_id, "111-0000000-0000001")
        self.assertEqual(o.order_date, "2024-12-22")
        self.assertEqual(o.total, 9.55)
        self.assertEqual(o.tax, 0.56)
        self.assertTrue(o.has_order_detail)
        self.assertFalse(o.has_item_detail)
        self.assertEqual(o.payment_legs[0].last4, "4321")


class ItemRowTests(unittest.TestCase):
    def test_groups_by_order(self):
        rows = [
            {"﻿order id": "111-0000000-0000002", "order date": "2024-11-19", "quantity": "1",
             "description": "Air Widget", "price": "$34.99", "ASIN": "B0AAA",
             "category": "Electronics›Widgets", "item url": "u1"},
            {"order id": "111-0000000-0000002", "order date": "2024-11-19", "quantity": "2",
             "description": "Widget Picks", "price": "$5.32", "ASIN": "B0BBB",
             "category": "Health›Picks", "item url": "u2"},
        ]
        by_order = parse_item_rows(rows)
        self.assertEqual(set(by_order), {"111-0000000-0000002"})
        items = by_order["111-0000000-0000002"]
        self.assertEqual([i.description for i in items], ["Air Widget", "Widget Picks"])
        self.assertEqual(items[1].quantity, 2)
        self.assertEqual(items[1].price, 5.32)
        self.assertEqual(items[0].category, "Electronics›Widgets")
        self.assertEqual(items[0].order_date, "2024-11-19")


class MergeTests(unittest.TestCase):
    def test_matched_order_gets_both_flags(self):
        orders = parse_order_rows([{
            "﻿order id": "O1", "date": "2024-01-01", "total": "10.00",
            "payments": "Test Card ending in 4321: 2024-01-01: $10.00;",
        }])
        items = {"O1": [AmazonItem(description="Thing", price=10.0, category="Cat")]}
        merged = {o.order_id: o for o in merge(orders, items)}
        self.assertTrue(merged["O1"].has_order_detail)
        self.assertTrue(merged["O1"].has_item_detail)
        self.assertEqual(len(merged["O1"].items), 1)

    def test_orphan_items_create_order_without_order_detail(self):
        # Items arrived before (or without) the orders file — an order with detail but no charge yet.
        # The items file's order date is promoted to the orphan (it's the only date such an order has).
        items = {"O2": [AmazonItem(description="X", price=5.0, category=None, order_date="2024-11-19")]}
        merged = {o.order_id: o for o in merge([], items)}
        self.assertIn("O2", merged)
        self.assertFalse(merged["O2"].has_order_detail)
        self.assertTrue(merged["O2"].has_item_detail)
        self.assertEqual(merged["O2"].order_date, "2024-11-19")

    def test_orphan_order_without_items(self):
        orders = parse_order_rows([{"﻿order id": "O3", "date": "2024-01-01", "total": "5.00", "payments": ""}])
        merged = {o.order_id: o for o in merge(orders, {})}
        self.assertTrue(merged["O3"].has_order_detail)
        self.assertFalse(merged["O3"].has_item_detail)


class SourceSniffTests(unittest.TestCase):
    def test_sniff_kind(self):
        self.assertEqual(sniff_kind(ORDERS_HEADER.split(",")), "orders")
        self.assertEqual(sniff_kind(ITEMS_HEADER.split(",")), "items")
        self.assertIsNone(sniff_kind(["date", "amount", "description"]))

    def test_read_export_orders(self):
        text = ORDERS_HEADER + "\n" + \
            '111-0000000-0000001,https://x,Widget A; ,Test User,2024-12-22,9.55,0,,,0.56,,Test Card ending in 4321: 2024-12-22: $9.55; \n'
        kind, rows = read_export(text)
        self.assertEqual(kind, "orders")
        self.assertEqual(len(rows), 1)
        # BOM on the first header is stripped so the key is usable.
        orders = parse_order_rows(rows)
        self.assertEqual(orders[0].order_id, "111-0000000-0000001")

    def test_read_export_items(self):
        text = ITEMS_HEADER + "\n" + \
            "111-0000000-0000002,https://x,2024-11-19,1,Air Widget,https://u,$34.99,0,B0AAA,Electronics›Widgets\n"
        kind, rows = read_export(text)
        self.assertEqual(kind, "items")
        by_order = parse_item_rows(rows)
        self.assertEqual(by_order["111-0000000-0000002"][0].price, 34.99)


class ClassifyOrderTests(unittest.TestCase):
    def _order(self, payments, refund=None):
        legs = parse_payments(payments)
        return AmazonOrder(order_id="O", order_date="2024-01-01", total=None, refund=refund, payment_legs=legs)

    def test_card_charge_is_cash(self):
        d = classify_order(self._order("Test Card ending in 4321: 2024-01-01: $37.32;"))
        self.assertEqual(d.kind, "cash")
        self.assertEqual(d.charge_amount, 37.32)
        self.assertEqual(d.net_cash, 37.32)
        self.assertEqual(d.match_last4, "4321")
        self.assertEqual(d.match_date, "2024-01-01")

    def test_points_only_is_non_cash(self):
        d = classify_order(self._order("Test Card ending in 4321; Rewards Points;"))
        self.assertEqual(d.kind, "non_cash")
        self.assertEqual(d.net_cash, 0.0)
        self.assertIsNone(d.charge_amount)
        # The amount-less card mention rides along for the importer's bare-card ledger probe.
        self.assertEqual(d.bare_card_last4, "4321")
        self.assertEqual(d.bare_card_network, "Test Card")

    def test_instrument_only_order_carries_no_bare_card(self):
        d = classify_order(self._order("Rewards Points;"))
        self.assertEqual(d.kind, "non_cash")
        self.assertIsNone(d.bare_card_last4)
        self.assertIsNone(d.bare_card_network)

    def test_gift_card_only_is_non_cash(self):
        d = classify_order(self._order("Amazon gift card balance;"))
        self.assertEqual(d.kind, "non_cash")

    def test_zero_dollar_cash_leg_is_non_cash(self):
        # A $0.00 card leg (a free/promo order): no cash moved, so there is no charge to find — same
        # handling as a non-cash instrument, keeping it out of "No charge found" downstream.
        d = classify_order(self._order("Test Card ending in 4321: 2024-01-01: $0.00;"))
        self.assertEqual(d.kind, "non_cash")
        self.assertEqual(d.net_cash, 0.0)
        self.assertIsNone(d.charge_amount)

    def test_refund_reduces_net(self):
        d = classify_order(self._order("Test Card ending in 4321: 2024-01-01: $50.00;", refund=20.0))
        self.assertEqual(d.charge_amount, 50.0)
        self.assertEqual(d.net_cash, 30.0)

    def test_full_refund_nets_zero(self):
        d = classify_order(self._order("Test Card ending in 4321: 2024-01-01: $50.00;", refund=50.0))
        self.assertEqual(d.net_cash, 0.0)

    def test_off_card_amount_is_cash_without_last4(self):
        d = classify_order(self._order("2024-01-06: $39.83;"))
        self.assertEqual(d.kind, "cash")
        self.assertEqual(d.charge_amount, 39.83)
        self.assertIsNone(d.match_last4)


if __name__ == "__main__":
    unittest.main()
