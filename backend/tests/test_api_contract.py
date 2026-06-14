"""Full-stack API contract smoke tests via FastAPI's TestClient.

Every other backend test calls router functions directly, which bypasses three things only the real
stack does: (1) FastAPI resolving unset Query() params to their defaults — call a router as a plain
function and those params arrive as FieldInfo objects instead, a real bug class; (2) the tenant-session
middleware; (3) request-body parsing + response serialization. These tests cover that gap with a few
high-value endpoints rather than re-testing business logic (which the direct tests already own).
"""

import unittest

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

    def test_seeded_data_is_served_from_the_temp_db(self):
        # init_db seeds the default category tree (incl. the protected Unassigned group) and rules; if
        # this returned the real DB or an empty one, the harness/routing would be wrong.
        with api_client() as (client, _):
            categories = client.get("/api/categories/flat").json()
            self.assertTrue(any(c.get("system_key") == "unassigned" for c in categories))
            self.assertGreater(len(client.get("/api/rules").json()), 0)

    def test_owner_create_round_trips_through_the_full_stack(self):
        # Exercises request-body parsing + a write + read-back + serialization end to end.
        with api_client() as (client, _):
            created = client.post("/api/owners", json={"name": "Alice", "color": "#112233"})
            self.assertEqual(created.status_code, 200)
            names = [o["name"] for o in client.get("/api/owners").json()]
            self.assertIn("Alice", names)


if __name__ == "__main__":
    unittest.main()
