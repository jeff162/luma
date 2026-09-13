"""
The Group Imported Categories workspace, where two tabs or two members can be arranging the same tree.

Two things were unsafe, and both are pinned here. The draft was one shared record overwritten by whichever save
arrived last, so concurrent arranging silently erased itself; a save now names the revision it was edited from,
and one based on an older revision is refused with the stored draft. And Apply was a run of separate calls from
the browser, so a failure partway left the tree half organized; it is now one transaction that lands whole or
changes nothing.

Driven over HTTP, because the revision travels in the request body and the refusals are status codes the
browser keys on.
"""

from __future__ import annotations

import sqlite3
import unittest
import uuid

from backend.tests._api_client import api_client

DRAFT_URL = "/api/import-export/category-workspace-draft"
APPLY_URL = "/api/categories/imported-workspace/apply"

MINE = {"snapshot": {"tree": {"income": [], "expense": []}, "sourceOrder": ["Coffee"], "setAsideOrder": []}}
THEIRS = {"snapshot": {"tree": {"income": [], "expense": []}, "sourceOrder": ["Tea"], "setAsideOrder": []}}


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


class DraftRevisionTests(unittest.TestCase):
    def test_a_save_based_on_the_stored_revision_is_kept_and_advances_it(self):
        with api_client() as (client, _):
            self.assertEqual(client.get(DRAFT_URL).json(), {"draft": None, "revision": 0})
            saved = client.put(DRAFT_URL, json={"draft": MINE, "base_revision": 0})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["revision"], 1)
            self.assertEqual(client.get(DRAFT_URL).json(), {"draft": MINE, "revision": 1})

    def test_a_save_based_on_an_older_revision_is_refused_with_what_is_stored(self):
        with api_client() as (client, _):
            client.put(DRAFT_URL, json={"draft": MINE, "base_revision": 0})
            stale = client.put(DRAFT_URL, json={"draft": THEIRS, "base_revision": 0})
            self.assertEqual(stale.status_code, 409, stale.text)
            detail = stale.json()["detail"]
            self.assertEqual(detail["code"], "draft_conflict")
            self.assertEqual(detail["draft"], MINE)
            self.assertEqual(detail["revision"], 1)
            self.assertEqual(client.get(DRAFT_URL).json(), {"draft": MINE, "revision": 1})

    def test_a_stale_save_of_what_is_already_stored_is_not_a_conflict(self):
        # Two windows that merely open the workspace each save the same arrangement. Asking which to keep
        # would be a question with no difference behind it.
        with api_client() as (client, _):
            client.put(DRAFT_URL, json={"draft": MINE, "base_revision": 0})
            same = client.put(DRAFT_URL, json={"draft": MINE, "base_revision": 0})
            self.assertEqual(same.status_code, 200, same.text)
            self.assertEqual(same.json()["revision"], 1)
            self.assertEqual(client.get(DRAFT_URL).json(), {"draft": MINE, "revision": 1})

    def test_the_refused_side_keeps_its_version_by_saving_against_the_revision_it_was_shown(self):
        with api_client() as (client, _):
            client.put(DRAFT_URL, json={"draft": MINE, "base_revision": 0})
            client.put(DRAFT_URL, json={"draft": THEIRS, "base_revision": 0})
            kept = client.put(DRAFT_URL, json={"draft": THEIRS, "base_revision": 1})
            self.assertEqual(kept.status_code, 200, kept.text)
            self.assertEqual(client.get(DRAFT_URL).json(), {"draft": THEIRS, "revision": 2})


class ApplyTests(unittest.TestCase):
    """Four imported labels waiting under Unassigned, one of them already parked."""

    def _seed(self, path: str) -> tuple[str, dict[str, str]]:
        conn = _connect(path)
        unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
        food = conn.execute(
            "SELECT id FROM category WHERE name = 'Food & Drink' AND parent_id IS NULL"
        ).fetchone()["id"]
        ids = {}
        for name, parked in (("Coffee", 0), ("Tea", 0), ("Parking", 1), ("Tolls", 0)):
            ids[name] = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order, import_pending, set_aside)"
                " VALUES (?, ?, ?, 'expense', 0, 1, ?)",
                (ids[name], unassigned, name, parked),
            )
        conn.commit()
        conn.close()
        return food, ids

    def _row(self, path: str, category_id: str) -> dict:
        conn = _connect(path)
        try:
            return dict(conn.execute("SELECT * FROM category WHERE id = ?", (category_id,)).fetchone())
        finally:
            conn.close()

    def _group_named(self, path: str, name: str):
        conn = _connect(path)
        try:
            return conn.execute("SELECT * FROM category WHERE name = ? AND parent_id IS NULL", (name,)).fetchone()
        finally:
            conn.close()

    def test_a_draft_lands_whole(self):
        with api_client() as (client, path):
            food, ids = self._seed(path)
            applied = client.post(APPLY_URL, json={
                "groups": [
                    {"name": "Food & Drink", "category_type": "expense",
                     "categories": [{"id": ids["Coffee"], "name": "Coffee shops"}]},
                    {"name": "Side income", "category_type": "income",
                     "categories": [{"id": ids["Tea"], "name": "Tea"}]},
                ],
                "set_aside_ids": [ids["Tolls"]],
            })
            self.assertEqual(applied.status_code, 200, applied.text)

            coffee = self._row(path, ids["Coffee"])
            self.assertEqual((coffee["parent_id"], coffee["name"]), (food, "Coffee shops"))
            self.assertEqual((coffee["import_pending"], coffee["set_aside"]), (0, 0))

            side_income = self._group_named(path, "Side income")
            self.assertIsNotNone(side_income, "a group the draft named is created")
            self.assertEqual(side_income["category_type"], "income")
            tea = self._row(path, ids["Tea"])
            self.assertEqual((tea["parent_id"], tea["category_type"]), (side_income["id"], "income"))

            self.assertEqual(self._row(path, ids["Tolls"])["set_aside"], 1)
            self.assertEqual(self._row(path, ids["Parking"])["set_aside"], 0, "a parked label no longer listed returns to the pool")
            self.assertEqual(applied.json()["categories"], client.get("/api/categories/flat").json())

    def test_a_refusal_partway_through_changes_nothing(self):
        with api_client() as (client, path):
            _, ids = self._seed(path)
            refused = client.post(APPLY_URL, json={
                "groups": [
                    {"name": "Hobbies", "category_type": "expense", "categories": [{"id": ids["Coffee"]}]},
                    # Renaming Tea onto a name another category holds is refused — after the group above was
                    # already created and Coffee already moved inside the same transaction.
                    {"name": "Food & Drink", "category_type": "expense",
                     "categories": [{"id": ids["Tea"], "name": "Parking"}]},
                ],
                "set_aside_ids": [],
            })
            self.assertEqual(refused.status_code, 400, refused.text)
            self.assertIsNone(self._group_named(path, "Hobbies"))
            coffee = self._row(path, ids["Coffee"])
            self.assertEqual(coffee["import_pending"], 1)
            self.assertEqual(self._row(path, ids["Parking"])["set_aside"], 1)

    def test_a_plan_naming_a_category_organized_elsewhere_is_refused(self):
        with api_client() as (client, path):
            food, ids = self._seed(path)
            conn = _connect(path)
            conn.execute("UPDATE category SET parent_id = ?, import_pending = 0 WHERE id = ?", (food, ids["Coffee"]))
            conn.commit()
            conn.close()

            refused = client.post(APPLY_URL, json={
                "groups": [{"name": "Hobbies", "category_type": "expense",
                            "categories": [{"id": ids["Coffee"]}, {"id": ids["Tea"]}]}],
                "set_aside_ids": [],
            })
            self.assertEqual(refused.status_code, 409, refused.text)
            self.assertEqual(refused.json()["detail"]["code"], "workspace_stale")
            self.assertIsNone(self._group_named(path, "Hobbies"))
            self.assertEqual(self._row(path, ids["Tea"])["import_pending"], 1)


if __name__ == "__main__":
    unittest.main()
