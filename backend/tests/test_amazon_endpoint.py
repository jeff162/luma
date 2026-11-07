"""
The Amazon import endpoint (`POST /api/import-export/amazon/import`): the multipart two-file upload
runs the parse → apply pipeline end to end through the real stack.

Seeds through the API (not direct DB writes), matching `test_api_contract` — a full-stack request
resolves its own DB path, so seeding by request is the only way that stays consistent under suite
ordering. The charge-match + exclusion + undo behavior is covered in-process by `test_amazon_enrich`
(there is no manual-transaction API to pre-seed a card charge here); this test pins the HTTP envelope,
file sniffing, and that items actually land.

Fabricated fixtures only.
"""

from __future__ import annotations

import unittest

from backend.tests._api_client import api_client

ORDERS_CSV = (
    "﻿order id,order url,items,to,date,total,shipping,shipping_refund,gift,tax,refund,payments\n"
    "111-0000000-0000042,https://x,Air Widget; Widget Picks; ,Test User,2024-11-19,37.32,0,,,2.19,,"
    "Test Card ending in 4321: 2024-11-19: $37.32; \n"
)
ITEMS_CSV = (
    "﻿order id,order url,order date,quantity,description,item url,price,subscribe & save,ASIN,category\n"
    "111-0000000-0000042,https://x,2024-11-19,1,Air Widget,https://u,$34.99,0,B0AAA,Electronics›Widgets\n"
    "111-0000000-0000042,https://x,2024-11-19,2,Widget Picks,https://u,$5.32,0,B0BBB,Health›Picks\n"
)


class AmazonEndpointTests(unittest.TestCase):
    def test_two_file_import_lands_one_order_row_with_item_evidence(self):
        with api_client() as (client, _):
            account = client.post("/api/accounts", json={"name": "Amazon", "type": "other"}).json()

            resp = client.post(
                "/api/import-export/amazon/import",
                files=[
                    ("files", ("orders.csv", ORDERS_CSV, "text/csv")),
                    ("files", ("items.csv", ITEMS_CSV, "text/csv")),
                ],
                data={"account_id": account["id"]},
            )
            self.assertEqual(resp.status_code, 200, resp.text)
            summary = resp.json()
            self.assertEqual(summary["order_count"], 1)
            self.assertEqual(summary["counts"]["orders_imported"], 1)

            # One row per order (orders-only model), amount = the order total, item detail folded in.
            txns = client.get("/api/transactions").json()["transactions"]
            self.assertEqual(len(txns), 1)
            self.assertAlmostEqual(txns[0]["amount"], 37.32, places=2)

    def test_unrecognized_file_is_rejected(self):
        with api_client() as (client, _):
            account = client.post("/api/accounts", json={"name": "Amazon", "type": "other"}).json()
            resp = client.post(
                "/api/import-export/amazon/import",
                files=[("files", ("random.csv", "a,b,c\n1,2,3\n", "text/csv"))],
                data={"account_id": account["id"]},
            )
            self.assertEqual(resp.status_code, 400)
            self.assertEqual(resp.json()["detail"]["code"], "unrecognized_files")


class AmazonSourceTests(unittest.TestCase):
    """Saved Amazon sources. They are `csv_import_profile` rows marked `marketplace:amazon`, which is
    what makes the watched-folder machinery theirs for free — so what is pinned here is that they stay
    out of the CSV side's listing (its editor has no mapping to show for one) and that the one setting
    an unattended import cannot ask about, the Amazon account, is checked where it is set. A source's
    cards come from its watched folder (`test_import_watch.AmazonWatchedFolderTests`)."""

    def test_a_source_names_an_amazon_account(self):
        with api_client() as (client, _):
            amazon = client.post("/api/accounts", json={"name": "Amazon", "type": "amazon"}).json()
            created = client.post("/api/import-export/amazon/profiles", json={
                "name": "Amazon household", "account_id": amazon["id"], "filename_pattern": "household",
            })
            self.assertEqual(created.status_code, 200, created.text)
            profile = created.json()["profile"]
            self.assertEqual((profile["name"], profile["account_name"]), ("Amazon household", "Amazon"))

    def test_a_source_is_refused_an_account_that_is_not_an_amazon_account(self):
        with api_client() as (client, _):
            checking = client.post("/api/accounts", json={"name": "Checking", "type": "depository"}).json()
            resp = client.post("/api/import-export/amazon/profiles", json={
                "name": "Wrong", "account_id": checking["id"],
            })
            self.assertEqual(resp.status_code, 400)
            self.assertIn("Amazon account", resp.json()["detail"])

    def test_an_amazon_source_is_not_listed_among_the_csv_data_sources(self):
        with api_client() as (client, _):
            amazon = client.post("/api/accounts", json={"name": "Amazon", "type": "amazon"}).json()
            client.post("/api/import-export/amazon/profiles",
                        json={"name": "Amazon household", "account_id": amazon["id"]})
            names = [p["name"] for p in client.get("/api/import-export/profiles").json()]
            self.assertNotIn("Amazon household", names)
            self.assertEqual([p["name"] for p in
                              client.get("/api/import-export/amazon/profiles").json()["profiles"]],
                             ["Amazon household"])


if __name__ == "__main__":
    unittest.main()
