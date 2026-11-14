"""Full-stack API contract smoke tests via FastAPI's TestClient.

Every other backend test calls router functions directly, which bypasses three things only the real
stack does: (1) FastAPI resolving unset Query() params to their defaults — call a router as a plain
function and those params arrive as FieldInfo objects instead, a real bug class; (2) the sign-in session
middleware; (3) request-body parsing + response serialization. These tests cover that gap with a few
high-value endpoints rather than re-testing business logic (which the direct tests already own).
"""

import sqlite3
import unittest

from backend.db.database import SHARED_OWNER_ID
from backend.tests._api_client import api_client


class ApiContractTests(unittest.TestCase):
    def test_public_health_passes_through_middleware(self):
        with api_client() as (client, _):
            r = client.get("/api/health")
            self.assertEqual(r.status_code, 200)

    def test_transactions_list_resolves_query_defaults_with_no_params(self):
        # The guard that matters: hitting this with NO query string must resolve every optional Query()
        # to its default (not leave it as a FieldInfo). A fresh temp DB has no transactions, proving the
        # harness is isolated from the real database too.
        with api_client() as (client, _):
            r = client.get("/api/transactions")
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertIn("transactions", body)
            self.assertEqual(body["transactions"], [])

    def test_transactions_list_parses_supplied_query_params(self):
        with api_client() as (client, _):
            r = client.get("/api/transactions", params={"view": "spending", "month": "2026-03"})
            self.assertEqual(r.status_code, 200)
            self.assertIn("transactions", r.json())

    def test_storage_summary_answers_for_the_session_s_own_database(self):
        # Settings reads these before any section opens; an empty ledger still has a size to compare with.
        with api_client() as (client, _):
            r = client.get("/api/app/storage-summary")
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertGreater(body["database_bytes"], 0)
            self.assertEqual(body["import_detail"], {"rows": 0, "bytes": 0})
            # Local mode answers as an administrator, so the backup history trash is counted too.
            self.assertEqual(body["trash"], {"transactions": 0, "duplicates": 0, "rules": 0, "backup_history": 0})

    def test_seeded_data_is_served_from_the_temp_db(self):
        # init_db seeds the category group skeleton (incl. the protected Unassigned group); starter
        # leaves and rules are opt-in, so they aren't present on a fresh temp DB. The served skeleton
        # still proves wiring — if this returned the real DB or an empty one, routing would be wrong.
        with api_client() as (client, _):
            categories = client.get("/api/categories/flat").json()
            self.assertTrue(any(c.get("system_key") == "unassigned" for c in categories))
            top_level_groups = [c for c in categories if not c.get("parent_id")]
            self.assertGreater(len(top_level_groups), 1)

    def test_owner_create_round_trips_through_the_full_stack(self):
        # Exercises request-body parsing + a write + read-back + serialization end to end.
        with api_client() as (client, _):
            created = client.post("/api/owners", json={"name": "Alice", "color": "#112233"})
            self.assertEqual(created.status_code, 200)
            names = [o["name"] for o in client.get("/api/owners").json()]
            self.assertIn("Alice", names)


    def test_purchase_link_round_trips_and_reaches_the_ledger_row(self):
        """The multi-payment purchase router end to end: create, the 400 its invariant produces, and the
        summary the transaction list carries back for the row marker.

        Worth a full-stack test rather than only the service's: the ordinal and totals on a ledger row
        are assembled in the list endpoint, and a body or serialization mistake between the two would
        leave the marker silently absent on a page where the service is perfectly correct.
        """
        with api_client() as (client, data_path):
            with sqlite3.connect(data_path) as conn:
                conn.execute(
                    """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                       VALUES ('acct', 'p_acct', 'fixture', 'Rewards Card', 'Rewards Card', 'credit', ?)""",
                    (SHARED_OWNER_ID,),
                )
                for txn_id, amount, date in (
                    ("dep", 2400.0, "2026-03-04"), ("bal", 3600.0, "2026-05-19"), ("other", 12.0, "2026-05-20"),
                ):
                    conn.execute(
                        """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,
                                            raw_name, date, is_pending)
                           VALUES (?, 'acct', ?, ?, 'Riverstone Joinery', 'Riverstone Joinery',
                                   'Riverstone Joinery', ?, 0)""",
                        (txn_id, SHARED_OWNER_ID, amount, date),
                    )

            created = client.post("/api/purchases", json={
                "txn_ids": ["bal", "dep"], "label": "Kitchen counters",
                "reference": "INV-4471", "expected_total": 6000.0,
            })
            self.assertEqual(created.status_code, 200)
            purchase = created.json()
            self.assertEqual([p["txn_id"] for p in purchase["payments"]], ["dep", "bal"])
            self.assertEqual(purchase["unaccounted"], 0.0)

            # The invariant surfaces as a 400 the dialog can show, not a 500.
            refused = client.post("/api/purchases", json={"txn_ids": ["bal", "other"]})
            self.assertEqual(refused.status_code, 400)
            self.assertIn("one purchase", refused.json()["detail"])

            rows = {row["id"]: row for row in client.get("/api/transactions").json()["transactions"]}
            self.assertEqual(rows["dep"]["purchase"]["position"], 1)
            self.assertEqual(rows["bal"]["purchase"]["position"], 2)
            self.assertEqual(rows["bal"]["purchase"]["payment_count"], 2)
            self.assertEqual(rows["bal"]["purchase"]["label"], "Kitchen counters")
            self.assertIsNone(rows["other"]["purchase"])

            # The transaction-scoped read the detail panel opens with.
            panel = client.get("/api/transactions/dep/purchase").json()["purchase"]
            self.assertEqual(panel["id"], purchase["id"])
            self.assertEqual(panel["reference"], "INV-4471")

            self.assertEqual(client.delete(f"/api/purchases/{purchase['id']}").status_code, 200)
            self.assertIsNone(client.get("/api/transactions/dep/purchase").json()["purchase"])


if __name__ == "__main__":
    unittest.main()
