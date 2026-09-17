"""
Transaction splits — allocation invariants, the reporting expansion, and the paths that must refuse
to overwrite a split.

The expansion seam is the part worth pinning hardest: every category rollup in the app now reads a
row source that fans a split transaction into one row per allocation, so a regression here is a
*wrong total* on a screen that was previously correct rather than a missing feature. The tests
therefore assert against the real endpoints (full stack, so Query defaults resolve the way they do in
production) and check both halves of each rule — what a split contributes, and what an equivalent
un-split transaction contributes — since a seam that dropped every split would still look plausible
if only one side were asserted.
"""

from __future__ import annotations

import json
import sqlite3
import unittest
import uuid

from backend.db.database import SHARED_OWNER_ID
from backend.routers.import_export.amazon import _order_evidence
from backend.services.amazon_import import AmazonItem, AmazonOrder, parse_item_evidence
from backend.services.txn_splits import MAX_LABEL_LENGTH, proportional_allocation
from backend.tests._api_client import api_client

def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


class SplitFixtureMixin:
    """Seeds a small ledger directly, so a test states only the shape it depends on."""

    def _seed(self, path: str):
        conn = _connect(path)
        account = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO account (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id) "
            "VALUES (?, ?, 'fixture_splits', 'Everyday', 'Everyday', 'checking', 'checking', '0000', ?)",
            (account, f"acct_{account}", SHARED_OWNER_ID),
        )
        groups, leaves = {}, {}
        for group_name, leaf_names, ctype, excluded in (
            ("Household Fixture", ["Groceries Fixture", "Hardware Fixture"], "expense", 0),
            ("Earnings Fixture", ["Salary Fixture"], "income", 0),
            ("Moves Fixture", ["Transfer Fixture"], "expense", 1),
        ):
            gid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals) "
                "VALUES (?, NULL, ?, ?, 0, ?)",
                (gid, group_name, ctype, excluded),
            )
            groups[group_name] = gid
            for leaf_name in leaf_names:
                lid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, ?, 0)",
                    (lid, gid, leaf_name, ctype),
                )
                leaves[leaf_name] = lid
        conn.commit()
        conn.close()
        return account, groups, leaves

    def _add_txn(self, path, *, account, amount, date="2026-04-10", category=None, name="Fixture Store"):
        txn_id = str(uuid.uuid4())
        conn = _connect(path)
        conn.execute(
            "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, display_name, "
            "raw_name, date, is_pending, category_overridden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
            (txn_id, account, SHARED_OWNER_ID, category, amount, name, name, name, date),
        )
        conn.commit()
        conn.close()
        return txn_id

    def _row(self, path, txn_id):
        conn = _connect(path)
        row = conn.execute("SELECT * FROM txn WHERE id = ?", (txn_id,)).fetchone()
        conn.close()
        return row


class ProportionalAllocationTests(unittest.TestCase):
    """The pre-fill arithmetic. Its whole job is turning list prices — which do not sum to what was
    paid — into shares of what was paid, exactly."""

    def test_shares_sum_to_the_amount_exactly(self):
        # 100.00 over three equal items is the classic rounding trap: 33.33 × 3 = 99.99.
        parts = proportional_allocation(100.0, [10.0, 10.0, 10.0])
        self.assertEqual(round(sum(parts), 2), 100.0)

    def test_remainder_lands_on_the_largest_part(self):
        parts = proportional_allocation(100.0, [1.0, 1.0, 98.0])
        self.assertEqual(round(sum(parts), 2), 100.0)
        self.assertEqual(max(parts), parts[2])

    def test_distributes_the_paid_amount_not_the_list_prices(self):
        # List prices total 100 while 118.50 was actually paid (tax + shipping). Every part scales.
        parts = proportional_allocation(118.50, [25.0, 75.0])
        self.assertEqual(parts, [29.62, 88.88])
        self.assertEqual(round(sum(parts), 2), 118.50)

    def test_a_multi_quantity_line_is_weighted_by_what_it_cost_not_by_one_of_them(self):
        # The export prices *one* of a thing and counts them separately, so weighting by the unit price
        # alone gives a line the user bought six of the same share as a line they bought one of. Six at
        # $10 against one at $40 is 60/40 of the money, not 20/80.
        six_at_ten, one_at_forty = 10.0 * 6, 40.0
        parts = proportional_allocation(100.0, [six_at_ten, one_at_forty])
        self.assertEqual(parts, [60.0, 40.0])

    def test_unpriced_items_come_back_null_rather_than_guessed(self):
        parts = proportional_allocation(60.0, [10.0, None, 20.0])
        self.assertIsNone(parts[1])
        self.assertEqual(round(parts[0] + parts[2], 2), 60.0)

    def test_no_suggestion_when_there_is_nothing_to_distribute(self):
        # A points- or gift-card-funded order (no cash) and an order with no priced item at all.
        self.assertEqual(proportional_allocation(0.0, [10.0, 20.0]), [])
        self.assertEqual(proportional_allocation(50.0, [None, None]), [])
        self.assertEqual(proportional_allocation(50.0, []), [])

    def test_negative_amount_keeps_its_sign(self):
        parts = proportional_allocation(-40.0, [1.0, 3.0])
        self.assertEqual(parts, [-10.0, -30.0])
        self.assertEqual(round(sum(parts), 2), -40.0)


class ItemEvidenceRoundTripTests(unittest.TestCase):
    """The pre-fill's only source of per-item prices is text the importer formatted into evidence, so
    the reader and the writer are coupled. This is the test that catches a change to either one."""

    def test_formatted_item_evidence_parses_back_to_its_numbers(self):
        order = AmazonOrder(
            order_id="ORD-1",
            items=[
                AmazonItem(description="Air Widget", price=12.34, quantity=2, asin="B01ABC"),
                AmazonItem(description="Cable", price=7.5, quantity=1),
                AmazonItem(description="Promotional Insert", price=None),
            ],
        )
        parsed = parse_item_evidence(_order_evidence(order))
        self.assertEqual(
            [(p["description"], p["price"], p["quantity"]) for p in parsed],
            [("Air Widget", 12.34, 2), ("Cable", 7.5, 1), ("Promotional Insert", None, 1)],
        )

    def test_extended_price_multiplies_the_unit_price_by_the_quantity(self):
        # `price` in the export is per unit — established against real exports, where a single-line
        # order's amount repeatedly equals price × quantity exactly and never falls below it. This is
        # the figure the pre-fill weights by; the raw unit price stays available beside it.
        order = AmazonOrder(
            order_id="ORD-3",
            items=[
                AmazonItem(description="Bolts", price=9.90, quantity=3),
                AmazonItem(description="Bracket", price=40.0, quantity=1),
                AmazonItem(description="Promo Insert", price=None, quantity=2),
            ],
        )
        parsed = parse_item_evidence(_order_evidence(order))
        self.assertEqual([p["extended_price"] for p in parsed], [29.70, 40.0, None])
        self.assertEqual([p["price"] for p in parsed], [9.90, 40.0, None])

    def test_order_without_item_detail_yields_nothing_to_suggest(self):
        parsed = parse_item_evidence(_order_evidence(AmazonOrder(order_id="ORD-2", items=[])))
        self.assertEqual(parsed, [])


class SplitValidationTests(SplitFixtureMixin, unittest.TestCase):
    def test_valid_split_saves_and_reads_back(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0)
            saved = client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 60.0},
                {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
            ]})
            self.assertEqual(saved.status_code, 200)

            fetched = client.get(f"/api/transactions/{txn}/split").json()
            self.assertTrue(fetched["is_split"])
            self.assertEqual([p["amount"] for p in fetched["parts"]], [60.0, 40.0])
            self.assertEqual(
                [p["category_name"] for p in fetched["parts"]],
                ["Groceries Fixture", "Hardware Fixture"],
            )
            # The pre-split category is retained, not overwritten — it is what un-splitting restores.
            self.assertEqual(self._row(path, txn)["category_source"], "split")

    def _reject(self, client, txn, parts):
        response = client.put(f"/api/transactions/{txn}/split", json={"parts": parts})
        self.assertEqual(response.status_code, 400, response.text)
        return response.json()["detail"]

    def test_the_invariants_are_enforced_with_a_reason_the_user_can_act_on(self):
        with api_client() as (client, path):
            account, groups, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0)
            groceries, hardware = leaves["Groceries Fixture"], leaves["Hardware Fixture"]

            with self.subTest("parts must sum to the amount"):
                detail = self._reject(client, txn, [
                    {"category_id": groceries, "amount": 60.0},
                    {"category_id": hardware, "amount": 30.0},
                ])
                self.assertIn("90.00", detail)

            with self.subTest("every part moves money the same direction"):
                self._reject(client, txn, [
                    {"category_id": groceries, "amount": 130.0},
                    {"category_id": hardware, "amount": -30.0},
                ])

            with self.subTest("a part cannot be zero"):
                self._reject(client, txn, [
                    {"category_id": groceries, "amount": 100.0},
                    {"category_id": hardware, "amount": 0.0},
                ])

            with self.subTest("one part is not a split"):
                self._reject(client, txn, [{"category_id": groceries, "amount": 100.0}])

            with self.subTest("a part cannot name a group"):
                self._reject(client, txn, [
                    {"category_id": groups["Household Fixture"], "amount": 60.0},
                    {"category_id": hardware, "amount": 40.0},
                ])

            # None of the rejections left a partial split behind.
            self.assertFalse(self._row(path, txn)["is_split"])

    def test_cents_round_trip_without_being_rejected_as_a_mismatch(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=118.50)
            response = client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 29.63},
                {"category_id": leaves["Hardware Fixture"], "amount": 88.87},
            ]})
            self.assertEqual(response.status_code, 200, response.text)


class SplitRepeatedCategoryTests(SplitFixtureMixin, unittest.TestCase):
    """Two items in one order may classify alike, and the split exists to keep them apart.

    A record and another record are two purchases at two prices by two artists; folding them into one
    allocation because they share a category would discard exactly the detail a split is for. The only
    thing that cost is a bucket's row count, which is why every summary counts distinct transactions.
    """

    def _two_music_parts(self, client, path):
        account, _, leaves = self._seed(path)
        txn = self._add_txn(path, account=account, amount=44.07)
        response = client.put(f"/api/transactions/{txn}/split", json={"parts": [
            {"category_id": leaves["Groceries Fixture"], "amount": 13.80, "label": "First record"},
            {"category_id": leaves["Hardware Fixture"], "amount": 14.86, "label": "A cable"},
            {"category_id": leaves["Groceries Fixture"], "amount": 15.41, "label": "Second record"},
        ]})
        return response, txn, leaves

    def test_two_items_may_share_a_category(self):
        with api_client() as (client, path):
            response, txn, _ = self._two_music_parts(client, path)
            self.assertEqual(response.status_code, 200, response.text)

            parts = client.get(f"/api/transactions/{txn}/split").json()["parts"]
            self.assertEqual(
                [(p["label"], p["amount"]) for p in parts],
                [("First record", 13.80), ("A cable", 14.86), ("Second record", 15.41)],
            )

    def test_the_shared_category_totals_both_items_but_counts_one_transaction(self):
        with api_client() as (client, path):
            self._two_music_parts(client, path)
            rows = client.get("/api/transactions/summary/by-category", params={"month": "2026-04"}).json()
            by_name = {r["category_name"]: r for r in rows}

            # Both allocations land in the bucket...
            self.assertEqual(by_name["Groceries Fixture"]["total"], 29.21)
            # ...but one transaction contributed them, and the count says so rather than reporting rows.
            self.assertEqual(by_name["Groceries Fixture"]["count"], 1)
            self.assertEqual(by_name["Hardware Fixture"]["count"], 1)

    def test_the_group_rollup_counts_the_transaction_once_across_its_parts(self):
        with api_client() as (client, path):
            self._two_music_parts(client, path)
            groups = {r["group_name"]: r for r in
                      client.get("/api/transactions/summary/by-group", params={"month": "2026-04"}).json()}
            self.assertEqual(groups["Household Fixture"]["total"], 44.07)
            self.assertEqual(groups["Household Fixture"]["count"], 1)


class SplitLabelTests(SplitFixtureMixin, unittest.TestCase):
    """What each allocation covers, in the user's words. Descriptive only — no report reads it — but it
    is the only record of *why* a given amount was set, so it has to survive a save."""

    def test_a_label_survives_the_round_trip(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0)
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 60.0, "label": "Pantry restock"},
                {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
            ]})
            parts = client.get(f"/api/transactions/{txn}/split").json()["parts"]
            self.assertEqual([p["label"] for p in parts], ["Pantry restock", None])

    def test_a_label_reaches_the_ledger_row(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0)
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 60.0, "label": "Pantry restock"},
                {"category_id": leaves["Hardware Fixture"], "amount": 40.0, "label": "Shelf brackets"},
            ]})
            row = next(r for r in client.get("/api/transactions").json()["transactions"] if r["id"] == txn)
            self.assertEqual([p["label"] for p in row["split_parts"]], ["Pantry restock", "Shelf brackets"])

    def test_a_pasted_item_title_is_capped_rather_than_stored_whole(self):
        # Marketplace titles run to hundreds of characters; the stored value is bounded so a paste
        # cannot bloat every read of the row.
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0)
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 60.0, "label": "W" * 400},
                {"category_id": leaves["Hardware Fixture"], "amount": 40.0, "label": "   "},
            ]})
            parts = client.get(f"/api/transactions/{txn}/split").json()["parts"]
            self.assertEqual(len(parts[0]["label"]), MAX_LABEL_LENGTH)
            self.assertIsNone(parts[1]["label"])   # whitespace is not a label

    def test_the_suggestion_offers_the_item_name_as_the_label(self):
        with api_client() as (client, path):
            account, _, _ = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0)
            evidence = _order_evidence(AmazonOrder(order_id="ORD-9", items=[
                AmazonItem(description="Bolts", price=9.90, quantity=3),
                AmazonItem(description="Bracket", price=40.0, quantity=1),
            ]))
            conn = _connect(path)
            conn.execute("UPDATE txn SET import_evidence_json = ? WHERE id = ?", (json.dumps(evidence), txn))
            conn.commit(); conn.close()

            proposed = client.get(f"/api/transactions/{txn}/split/suggestion").json()
            self.assertTrue(proposed["available"])
            self.assertEqual([p["label"] for p in proposed["parts"]], ["Bolts", "Bracket"])
            # Weighted by extended price (29.70 : 40.00 of 69.70) rather than by the unit prices
            # (9.90 : 40.00 of 49.90), which would have produced 19.84 / 80.16 — so this asserts the
            # weighting, not merely that some allocation came back.
            self.assertEqual([p["amount"] for p in proposed["parts"]], [42.61, 57.39])
            self.assertEqual(round(sum(p["amount"] for p in proposed["parts"]), 2), 100.0)


class SplitLabelSearchTests(SplitFixtureMixin, unittest.TestCase):
    """The search box reads a part's label. Unscoped a split is the purchase, so any part's label finds it —
    and since the row shows no label, it is marked. Scoped to a category a row is one part, so only that
    part's own label counts."""

    def _labelled_split(self, client, path):
        account, _, leaves = self._seed(path)
        txn = self._add_txn(path, account=account, amount=100.0)
        client.put(f"/api/transactions/{txn}/split", json={"parts": [
            {"category_id": leaves["Groceries Fixture"], "amount": 60.0, "label": "Pantry restock"},
            {"category_id": leaves["Hardware Fixture"], "amount": 40.0, "label": "Shelf brackets"},
        ]})
        return leaves, txn

    def test_a_part_label_finds_the_purchase_and_marks_it(self):
        with api_client() as (client, path):
            _, txn = self._labelled_split(client, path)
            rows = client.get("/api/transactions", params={"quick_filter": "bracket"}).json()["transactions"]
            self.assertEqual([r["id"] for r in rows], [txn])
            self.assertTrue(rows[0]["matched_split_label"])

    def test_a_row_found_another_way_is_not_marked(self):
        with api_client() as (client, path):
            _, txn = self._labelled_split(client, path)
            rows = client.get("/api/transactions", params={"quick_filter": "Fixture Store"}).json()["transactions"]
            self.assertEqual([r["id"] for r in rows], [txn])
            self.assertFalse(rows[0]["matched_split_label"])

    def test_scoped_to_a_category_only_the_part_whose_label_matched_is_found(self):
        with api_client() as (client, path):
            leaves, txn = self._labelled_split(client, path)
            both = f"{leaves['Groceries Fixture']},{leaves['Hardware Fixture']}"
            rows = client.get("/api/transactions", params={
                "category_ids": both, "quick_filter": "bracket",
            }).json()["transactions"]
            self.assertEqual([(r["id"], r["amount"]) for r in rows], [(txn, 40.0)])
            groceries = client.get("/api/transactions", params={
                "category_ids": leaves["Groceries Fixture"], "quick_filter": "bracket",
            }).json()["transactions"]
            self.assertEqual(groceries, [])

    def test_a_prefixed_search_does_not_read_labels(self):
        with api_client() as (client, path):
            self._labelled_split(client, path)
            rows = client.get("/api/transactions", params={"quick_filter": "merchant:bracket"}).json()["transactions"]
            self.assertEqual(rows, [])


class SplitExportTests(SplitFixtureMixin, unittest.TestCase):
    """A CSV row cannot hold a split. The whole purchase exports with Category and Group marked `--split--`
    rather than carrying the pre-split category kept for un-splitting — and rather than blank, which would
    read as uncategorized; a category-scoped export carries each part's own category."""

    def _export(self, client, **params):
        text = client.get("/api/import-export/transactions.csv", params={
            "columns": "amount,category,group", **params,
        }).text
        return [line.split(",") for line in text.splitlines()[1:] if line.strip()]

    def test_a_whole_split_exports_marked_rather_than_categorized(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0, category=leaves["Salary Fixture"])
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 60.0},
                {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
            ]})
            self.assertEqual(self._export(client), [["100.0", "--split--", "--split--"]])

    def test_a_category_scoped_export_carries_the_parts_own_category(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0, category=leaves["Salary Fixture"])
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 60.0},
                {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
            ]})
            self.assertEqual(self._export(client, category_ids=leaves["Hardware Fixture"]),
                             [["40.0", "Hardware Fixture", "Household Fixture"]])

    def test_an_unsplit_row_keeps_its_category(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            self._add_txn(path, account=account, amount=12.0, category=leaves["Groceries Fixture"])
            self.assertEqual(self._export(client), [["12.0", "Groceries Fixture", "Household Fixture"]])


class SplitSuggestionCategoryTests(SplitFixtureMixin, unittest.TestCase):
    """An order of a dozen things should not arrive as a dozen empty pickers.

    Each item's own description goes through the user's ordinary rules — their rules, not the
    marketplace's taxonomy, which this importer deliberately ignores everywhere. It stays a proposal:
    an item no rule claims comes back uncategorized rather than guessed at.
    """

    def _order(self, client, path, items, amount=100.0):
        account, _, leaves = self._seed(path)
        txn = self._add_txn(path, account=account, amount=amount)
        evidence = _order_evidence(AmazonOrder(order_id="ORD-CAT", items=items))
        conn = _connect(path)
        conn.execute("UPDATE txn SET import_evidence_json = ? WHERE id = ?", (json.dumps(evidence), txn))
        conn.commit(); conn.close()
        return txn, leaves

    def _rule(self, client, keyword, category_id):
        r = client.post("/api/rules", json={"keyword": keyword, "category_id": category_id})
        self.assertEqual(r.status_code, 200, r.text)

    def test_items_arrive_categorized_by_the_users_own_rules(self):
        with api_client() as (client, path):
            txn, leaves = self._order(client, path, [
                AmazonItem(description="Harborline Coffee Beans", price=25.0, quantity=1),
                AmazonItem(description="Riverstone Socket Set", price=25.0, quantity=1),
            ])
            self._rule(client, "COFFEE", leaves["Groceries Fixture"])
            self._rule(client, "SOCKET", leaves["Hardware Fixture"])

            parts = client.get(f"/api/transactions/{txn}/split/suggestion").json()
            self.assertEqual(parts["categorized"], 2)
            self.assertEqual(
                [p["category_id"] for p in parts["parts"]],
                [leaves["Groceries Fixture"], leaves["Hardware Fixture"]],
            )

    def test_an_item_no_rule_claims_is_left_for_the_user(self):
        with api_client() as (client, path):
            txn, leaves = self._order(client, path, [
                AmazonItem(description="Harborline Coffee Beans", price=50.0, quantity=1),
                AmazonItem(description="Something Unfamiliar", price=50.0, quantity=1),
            ])
            self._rule(client, "COFFEE", leaves["Groceries Fixture"])

            parts = client.get(f"/api/transactions/{txn}/split/suggestion").json()
            self.assertEqual(parts["categorized"], 1)
            self.assertEqual(
                [p["category_id"] for p in parts["parts"]],
                [leaves["Groceries Fixture"], None],
            )

    def test_two_items_may_be_proposed_into_the_same_category(self):
        # The repeated-category rule was lifted precisely so this can happen: two records in one order
        # are two purchases, and a proposal that had to collapse them would be unsaveable.
        with api_client() as (client, path):
            txn, leaves = self._order(client, path, [
                AmazonItem(description="Harborline Trio Record", price=20.0, quantity=1),
                AmazonItem(description="Northgate Quartet Record", price=30.0, quantity=1),
            ])
            self._rule(client, "RECORD", leaves["Groceries Fixture"])

            proposed = client.get(f"/api/transactions/{txn}/split/suggestion").json()["parts"]
            self.assertEqual([p["category_id"] for p in proposed],
                             [leaves["Groceries Fixture"], leaves["Groceries Fixture"]])

            saved = client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": p["category_id"], "amount": p["amount"], "label": p["label"]}
                for p in proposed
            ]})
            self.assertEqual(saved.status_code, 200, saved.text)

    def test_an_unpriced_item_is_not_matched_against_an_amount_it_does_not_have(self):
        with api_client() as (client, path):
            txn, leaves = self._order(client, path, [
                AmazonItem(description="Harborline Coffee Beans", price=100.0, quantity=1),
                AmazonItem(description="Coffee Promo Insert", price=None, quantity=1),
            ])
            self._rule(client, "COFFEE", leaves["Groceries Fixture"])

            parts = client.get(f"/api/transactions/{txn}/split/suggestion").json()["parts"]
            # The second line matches the keyword but has no share, so it is left alone rather than
            # run through a matcher that can filter on an amount.
            self.assertEqual([p["amount"] for p in parts], [100.0, None])
            self.assertEqual([p["category_id"] for p in parts], [leaves["Groceries Fixture"], None])


class SplitReportingTests(SplitFixtureMixin, unittest.TestCase):
    """The expansion seam: what a split contributes to each rollup."""

    def _split_100(self, client, path):
        account, groups, leaves = self._seed(path)
        txn = self._add_txn(path, account=account, amount=100.0)
        client.put(f"/api/transactions/{txn}/split", json={"parts": [
            {"category_id": leaves["Groceries Fixture"], "amount": 60.0},
            {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
        ]})
        return account, groups, leaves, txn

    def test_by_category_reports_each_part_in_its_own_bucket(self):
        with api_client() as (client, path):
            _, _, leaves, _ = self._split_100(client, path)
            rows = client.get("/api/transactions/summary/by-category", params={"month": "2026-04"}).json()
            totals = {r["category_name"]: r["total"] for r in rows}
            self.assertEqual(totals["Groceries Fixture"], 60.0)
            self.assertEqual(totals["Hardware Fixture"], 40.0)
            # And the whole amount is still accounted for exactly once.
            self.assertEqual(round(sum(totals.values()), 2), 100.0)

    def test_group_and_trend_rollups_agree_with_the_parts(self):
        with api_client() as (client, path):
            self._split_100(client, path)
            groups = client.get("/api/transactions/summary/by-group", params={"month": "2026-04"}).json()
            self.assertEqual({r["group_name"]: r["total"] for r in groups}["Household Fixture"], 100.0)

            # `view` is a category-shaped scope (spending/income resolve through the category's type),
            # so this also covers the list/trend path that expands on the view rather than on an
            # explicit category filter. Unscoped, monthly-trend is a cash-flow frame and negates.
            spending = client.get("/api/transactions/summary/monthly-trend", params={
                "months": 3, "date_start": "2026-04-01", "date_end": "2026-04-30", "view": "spending",
            }).json()
            self.assertEqual(spending[0]["total"], 100.0)

            cash_flow = client.get("/api/transactions/summary/monthly-trend", params={
                "months": 3, "date_start": "2026-04-01", "date_end": "2026-04-30",
            }).json()
            self.assertEqual(cash_flow[0]["total"], -100.0)

    def test_an_excluded_part_drops_out_while_its_sibling_still_counts(self):
        # The half of a purchase moved into a transfer-style excluded group must leave the totals, and
        # the other half must not follow it. Exclusion is per allocation, not per transaction.
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0)
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 70.0},
                {"category_id": leaves["Transfer Fixture"], "amount": 30.0},
            ]})
            rows = client.get("/api/transactions/summary/by-category", params={"month": "2026-04"}).json()
            totals = {r["category_name"]: r["total"] for r in rows}
            self.assertEqual(totals.get("Groceries Fixture"), 70.0)
            self.assertNotIn("Transfer Fixture", totals)

    def test_an_income_part_negates_the_way_an_income_category_does(self):
        # A refund allocated to an income leaf follows the reporting sign convention (income reads
        # positive), which is only true if the expansion carries the part's own category type.
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=-200.0)
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Salary Fixture"], "amount": -150.0},
                {"category_id": leaves["Groceries Fixture"], "amount": -50.0},
            ]})
            totals = {
                r["category_name"]: r["total"]
                for r in client.get("/api/transactions/summary/by-category", params={"month": "2026-04"}).json()
            }
            self.assertEqual(totals["Salary Fixture"], 150.0)    # income negates
            self.assertEqual(totals["Groceries Fixture"], -50.0)  # a credit in an expense branch stays negative

    def test_an_unsplit_transaction_is_unaffected_by_the_seam(self):
        # The control: the expansion must be invisible to everything that is not split.
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            self._add_txn(path, account=account, amount=42.0, category=leaves["Groceries Fixture"])
            rows = client.get("/api/transactions/summary/by-category", params={"month": "2026-04"}).json()
            self.assertEqual({r["category_name"]: r["total"] for r in rows}["Groceries Fixture"], 42.0)
            self.assertEqual([r["count"] for r in rows if r["category_name"] == "Groceries Fixture"], [1])

    def test_category_usage_counts_see_a_category_used_only_by_a_part(self):
        # Deletion offers to rewrite what points at a category, so a category in use by one allocation
        # must not read as unused.
        with api_client() as (client, path):
            _, _, leaves, _ = self._split_100(client, path)
            summary = client.get("/api/categories/usage-summary").json()
            entry = summary[leaves["Hardware Fixture"]]
            self.assertGreaterEqual(entry["txn_count"], 1)


class SplitListContractTests(SplitFixtureMixin, unittest.TestCase):
    """Unscoped the ledger shows the purchase; scoped to a category it shows the part."""

    def _split_100(self, client, path):
        account, _, leaves = self._seed(path)
        txn = self._add_txn(path, account=account, amount=100.0)
        client.put(f"/api/transactions/{txn}/split", json={"parts": [
            {"category_id": leaves["Groceries Fixture"], "amount": 60.0},
            {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
        ]})
        return leaves, txn

    def test_unscoped_list_shows_one_row_at_the_full_amount(self):
        with api_client() as (client, path):
            _, txn = self._split_100(client, path)
            body = client.get("/api/transactions").json()
            rows = [r for r in body["transactions"] if r["id"] == txn]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["amount"], 100.0)
            self.assertTrue(rows[0]["is_split"])
            self.assertEqual(rows[0]["split_part_count"], 2)
            self.assertEqual(body["total"], 1)

    def test_rows_carry_their_allocations_for_the_ledger_hover(self):
        # The parts ride in the list payload rather than being fetched per hover, so a row that renders
        # a "Split (N)" chip already holds what the hover lists. Category names come along because the
        # hover shows names, not ids.
        with api_client() as (client, path):
            leaves, txn = self._split_100(client, path)
            body = client.get("/api/transactions").json()
            row = next(r for r in body["transactions"] if r["id"] == txn)

            self.assertEqual(row["split_part_count"], 2)
            self.assertEqual(
                [(p["category_name"], p["amount"]) for p in row["split_parts"]],
                [("Groceries Fixture", 60.0), ("Hardware Fixture", 40.0)],
            )
            self.assertEqual(row["split_parts"][0]["category_id"], leaves["Groceries Fixture"])

    def test_an_unsplit_row_carries_no_allocations(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            plain = self._add_txn(path, account=account, amount=12.0, category=leaves["Groceries Fixture"])
            row = next(r for r in client.get("/api/transactions").json()["transactions"] if r["id"] == plain)
            self.assertEqual(row["split_parts"], [])
            self.assertEqual(row["split_part_count"], 0)

    def test_category_scoped_list_shows_the_part_amount(self):
        # This is what makes a drill-down's visible rows sum to the total its summary reported.
        with api_client() as (client, path):
            leaves, txn = self._split_100(client, path)
            body = client.get("/api/transactions", params={
                "category_ids": leaves["Groceries Fixture"],
            }).json()
            rows = [r for r in body["transactions"] if r["id"] == txn]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["amount"], 60.0)
            self.assertEqual(rows[0]["sum_amount"] if "sum_amount" in rows[0] else body["sum_amount"], 60.0)

            other = client.get("/api/transactions", params={"category_ids": leaves["Hardware Fixture"]}).json()
            self.assertEqual([r["amount"] for r in other["transactions"] if r["id"] == txn], [40.0])

    def test_the_ledger_row_names_no_allocation(self):
        # Unscoped the row *is* the purchase, so there is no part for it to be. The renderer reads this
        # field to decide whether it is holding a whole split or one of its allocations.
        with api_client() as (client, path):
            _, txn = self._split_100(client, path)
            row = next(r for r in client.get("/api/transactions").json()["transactions"] if r["id"] == txn)
            self.assertIsNone(row["split_part_id"])

    def test_an_expanded_row_names_the_allocation_it_came_from(self):
        with api_client() as (client, path):
            leaves, txn = self._split_100(client, path)
            parts = client.get(f"/api/transactions/{txn}/split").json()["parts"]
            by_category = {p["category_id"]: p["id"] for p in parts}

            groceries = client.get("/api/transactions", params={
                "category_ids": leaves["Groceries Fixture"],
            }).json()["transactions"]
            row = next(r for r in groceries if r["id"] == txn)
            self.assertEqual(row["split_part_id"], by_category[leaves["Groceries Fixture"]])

    def test_two_parts_in_one_category_are_told_apart_by_their_allocation(self):
        # The case a list cannot render without this: the split rules allow two allocations to name the
        # same category, so scoped to it the transaction comes back as two rows with one id — and two
        # parts alike in category *and* amount are not distinguishable by value either. Only the part id
        # separates them, which is what the ledger keys its rows by.
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=20.0)
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 10.0},
                {"category_id": leaves["Groceries Fixture"], "amount": 10.0},
            ]})
            rows = [
                r for r in client.get("/api/transactions", params={
                    "category_ids": leaves["Groceries Fixture"],
                }).json()["transactions"]
                if r["id"] == txn
            ]
            self.assertEqual(len(rows), 2)
            self.assertEqual({r["amount"] for r in rows}, {10.0})
            self.assertEqual(len({r["split_part_id"] for r in rows}), 2)
            self.assertEqual(
                {r["split_part_id"] for r in rows},
                {p["id"] for p in client.get(f"/api/transactions/{txn}/split").json()["parts"]},
            )

    def test_an_unsplit_row_names_no_allocation_even_when_the_source_is_expanded(self):
        # The expanded source matches no part for it, so the field stays null and the row renders as the
        # ordinary transaction it is.
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            plain = self._add_txn(path, account=account, amount=12.0, category=leaves["Groceries Fixture"])
            row = next(
                r for r in client.get("/api/transactions", params={
                    "category_ids": leaves["Groceries Fixture"],
                }).json()["transactions"]
                if r["id"] == plain
            )
            self.assertIsNone(row["split_part_id"])
            self.assertFalse(row["is_split"])

    def test_a_split_appears_once_per_matching_part_not_once_per_part(self):
        # Scoped to both of its categories the transaction is genuinely two allocation rows; the page
        # total must agree with that rather than counting the purchase twice at its full amount.
        with api_client() as (client, path):
            leaves, txn = self._split_100(client, path)
            body = client.get("/api/transactions", params={
                "category_ids": f"{leaves['Groceries Fixture']},{leaves['Hardware Fixture']}",
            }).json()
            self.assertEqual(len([r for r in body["transactions"] if r["id"] == txn]), 2)
            self.assertEqual(body["sum_amount"], 100.0)


class SplitProtectionTests(SplitFixtureMixin, unittest.TestCase):
    """Nothing automatic may replace a hand-built allocation, and every path that declines says so."""

    def _split_100(self, client, path, name="Fixture Store"):
        account, _, leaves = self._seed(path)
        txn = self._add_txn(path, account=account, amount=100.0, name=name)
        client.put(f"/api/transactions/{txn}/split", json={"parts": [
            {"category_id": leaves["Groceries Fixture"], "amount": 60.0},
            {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
        ]})
        return account, leaves, txn

    def test_setting_a_single_category_on_a_split_is_refused(self):
        with api_client() as (client, path):
            _, leaves, txn = self._split_100(client, path)
            response = client.patch(
                f"/api/transactions/{txn}/category", json={"category_id": leaves["Groceries Fixture"]}
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("split", response.json()["detail"].lower())
            self.assertTrue(self._row(path, txn)["is_split"])

    def test_bulk_recategorize_declines_split_rows_and_reports_the_count(self):
        with api_client() as (client, path):
            account, leaves, txn = self._split_100(client, path)
            plain = self._add_txn(path, account=account, amount=10.0)
            body = client.post("/api/transactions/bulk", json={
                "selection": {"mode": "ids", "ids": [txn, plain]},
                "actions": [{"type": "set_category", "category_id": leaves["Groceries Fixture"]}],
            }).json()

            self.assertEqual(body["skipped_splits"], 1)
            self.assertTrue(self._row(path, txn)["is_split"])
            # The rows it could act on were acted on — declining is not aborting.
            self.assertEqual(self._row(path, plain)["category_id"], leaves["Groceries Fixture"])

    def test_full_force_rule_apply_keeps_the_split_but_still_renames(self):
        # The refusal is scoped to the category effect: a rule's rename describes the purchase, which a
        # split says nothing about, so it still applies.
        with api_client() as (client, path):
            _, leaves, txn = self._split_100(client, path, name="SPLITSTORE 123")
            rule = client.post("/api/rules", json={
                "keyword": "SPLITSTORE",
                "category_id": leaves["Groceries Fixture"],
                "clean_name": "Split Store",
            })
            self.assertEqual(rule.status_code, 200, rule.text)
            rule_id = rule.json().get("id") or rule.json().get("rule", {}).get("id")

            applied = client.post(f"/api/rules/{rule_id}/apply").json()
            self.assertEqual(applied["skipped_splits"], 1)

            row = self._row(path, txn)
            self.assertTrue(row["is_split"])
            self.assertEqual(row["category_source"], "split")
            self.assertEqual(row["display_name"], "Split Store")

    def test_run_categorization_leaves_a_split_alone(self):
        with api_client() as (client, path):
            _, leaves, txn = self._split_100(client, path, name="SPLITSTORE 123")
            client.post("/api/rules", json={
                "keyword": "SPLITSTORE", "category_id": leaves["Groceries Fixture"],
            })
            client.post("/api/sync/recategorize")
            row = self._row(path, txn)
            self.assertTrue(row["is_split"])
            self.assertEqual(row["category_source"], "split")

    def test_un_splitting_restores_the_category_the_row_carried_before(self):
        with api_client() as (client, path):
            account, _, leaves = self._seed(path)
            txn = self._add_txn(path, account=account, amount=100.0, category=leaves["Groceries Fixture"])
            client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": leaves["Groceries Fixture"], "amount": 60.0},
                {"category_id": leaves["Hardware Fixture"], "amount": 40.0},
            ]})
            client.delete(f"/api/transactions/{txn}/split")

            row = self._row(path, txn)
            self.assertFalse(row["is_split"])
            self.assertEqual(row["category_id"], leaves["Groceries Fixture"])
            self.assertEqual(client.get(f"/api/transactions/{txn}/split").json()["parts"], [])
            # And the money is back in one bucket.
            totals = {
                r["category_name"]: r["total"]
                for r in client.get("/api/transactions/summary/by-category", params={"month": "2026-04"}).json()
            }
            self.assertEqual(totals["Groceries Fixture"], 100.0)

    def test_allocations_are_removed_with_their_transaction(self):
        with api_client() as (client, path):
            _, _, txn = self._split_100(client, path)
            conn = _connect(path)
            conn.execute("DELETE FROM txn WHERE id = ?", (txn,))
            conn.commit()
            remaining = conn.execute("SELECT COUNT(*) AS n FROM txn_split WHERE txn_id = ?", (txn,)).fetchone()["n"]
            conn.close()
            self.assertEqual(remaining, 0)


if __name__ == "__main__":
    unittest.main()
