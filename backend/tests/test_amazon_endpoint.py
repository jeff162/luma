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
    def test_two_file_import_lands_items_in_the_account(self):
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
            self.assertEqual(summary["counts"]["applied_full"], 1)

            # The item purchases persisted through the full stack and allocate to the charge total.
            txns = client.get("/api/transactions").json()["transactions"]
            amounts = [t["amount"] for t in txns]
            self.assertEqual(len(amounts), 2)
            self.assertAlmostEqual(sum(amounts), 37.32, places=2)

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


if __name__ == "__main__":
    unittest.main()
