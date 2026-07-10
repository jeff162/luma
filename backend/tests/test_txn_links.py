"""
The transaction-link primitive (`services/txn_links.py`): a typed, pure association between
transactions.

Pins the general contract the Amazon adapter (and future credit-card / cash-flow clients) build on:
create/query links by kind + external_ref, roles per member, idempotent membership, reversible delete
that frees but never deletes the transactions, and cascade cleanup when a linked transaction is removed.
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
from backend.services.txn_links import (
    add_member,
    create_link,
    delete_link,
    find_link,
    get_link,
    links_for_txn,
    member_txn_ids,
    remove_member,
    set_metadata,
)


class TxnLinkTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "links.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
                   VALUES ('acct', 'p_acct', 'fixture', 'Amazon', 'Amazon', 'checking', ?)""",
                (SHARED_OWNER_ID,),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _txn(self, amount=10.0, name="row"):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,
                                    raw_name, date, is_pending)
                   VALUES (?, 'acct', ?, ?, ?, ?, ?, '2024-11-19', 0)""",
                (txn_id, SHARED_OWNER_ID, amount, name, name, name),
            )
        return txn_id

    def _txn_exists(self, txn_id):
        with self._use_db_path(), get_db() as conn:
            return conn.execute("SELECT 1 FROM txn WHERE id = ?", (txn_id,)).fetchone() is not None

    def test_create_and_read_back(self):
        charge = self._txn(amount=37.32, name="AMAZON.COM")
        item_a = self._txn(amount=34.99, name="Air Widget")
        item_b = self._txn(amount=2.33, name="Widget Picks")
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(
                conn, "amazon_order",
                [(charge, "charge"), (item_a, "item"), (item_b, "item")],
                external_ref="111-0000000-0000010",
                metadata={"prior_category_id": "shopping"},
            )
            link = get_link(conn, link_id)
        self.assertEqual(link["kind"], "amazon_order")
        self.assertEqual(link["external_ref"], "111-0000000-0000010")
        self.assertEqual(link["metadata"], {"prior_category_id": "shopping"})
        roles = {m["txn_id"]: m["role"] for m in link["members"]}
        self.assertEqual(roles, {charge: "charge", item_a: "item", item_b: "item"})

    def test_find_link_by_external_ref(self):
        charge = self._txn()
        with self._use_db_path(), get_db() as conn:
            create_link(conn, "amazon_order", [(charge, "charge")], external_ref="ORDER-1")
            found = find_link(conn, "amazon_order", "ORDER-1")
            self.assertIsNotNone(found)
            self.assertEqual([m["txn_id"] for m in found["members"]], [charge])
            # A different kind or ref does not match.
            self.assertIsNone(find_link(conn, "cc_payment", "ORDER-1"))
            self.assertIsNone(find_link(conn, "amazon_order", "ORDER-2"))

    def test_add_member_is_idempotent_and_updates_role(self):
        charge = self._txn()
        item = self._txn()
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(conn, "amazon_order", [(charge, "charge")])
            add_member(conn, link_id, item, "item")
            add_member(conn, link_id, item, "item")  # re-add: no duplicate
            self.assertEqual(len(get_link(conn, link_id)["members"]), 2)
            add_member(conn, link_id, item, "charge")  # same txn, new role wins
            roles = {m["txn_id"]: m["role"] for m in get_link(conn, link_id)["members"]}
            self.assertEqual(roles[item], "charge")

    def test_member_txn_ids_role_filter(self):
        charge = self._txn()
        item_a = self._txn()
        item_b = self._txn()
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(
                conn, "amazon_order",
                [(charge, "charge"), (item_a, "item"), (item_b, "item")],
            )
            self.assertEqual(member_txn_ids(conn, link_id, role="charge"), [charge])
            self.assertEqual(set(member_txn_ids(conn, link_id, role="item")), {item_a, item_b})
            self.assertEqual(len(member_txn_ids(conn, link_id)), 3)

    def test_links_for_txn(self):
        shared = self._txn()
        other = self._txn()
        with self._use_db_path(), get_db() as conn:
            l1 = create_link(conn, "amazon_order", [(shared, "charge")], external_ref="A")
            l2 = create_link(conn, "cc_payment", [(shared, "leg"), (other, "leg")], external_ref="B")
            ids = {link["id"] for link in links_for_txn(conn, shared)}
            self.assertEqual(ids, {l1, l2})
            self.assertEqual([link["id"] for link in links_for_txn(conn, other)], [l2])

    def test_set_metadata_round_trip(self):
        charge = self._txn()
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(conn, "amazon_order", [(charge, "charge")])
            self.assertIsNone(get_link(conn, link_id)["metadata"])
            set_metadata(conn, link_id, {"a": 1})
            self.assertEqual(get_link(conn, link_id)["metadata"], {"a": 1})
            set_metadata(conn, link_id, None)
            self.assertIsNone(get_link(conn, link_id)["metadata"])

    def test_remove_member(self):
        charge = self._txn()
        item = self._txn()
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(conn, "amazon_order", [(charge, "charge"), (item, "item")])
            remove_member(conn, link_id, item)
            self.assertEqual([m["txn_id"] for m in get_link(conn, link_id)["members"]], [charge])
        # Removing a member does not delete the transaction.
        self.assertTrue(self._txn_exists(item))

    def test_delete_link_returns_members_and_keeps_txns(self):
        charge = self._txn()
        item = self._txn()
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(conn, "amazon_order", [(charge, "charge"), (item, "item")])
            freed = delete_link(conn, link_id)
            self.assertEqual({m["txn_id"] for m in freed}, {charge, item})
            self.assertIsNone(get_link(conn, link_id))
        # The transactions themselves survive a link deletion.
        self.assertTrue(self._txn_exists(charge))
        self.assertTrue(self._txn_exists(item))

    def test_deleting_a_txn_cascades_its_membership_but_not_the_link(self):
        charge = self._txn()
        item = self._txn()
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(conn, "amazon_order", [(charge, "charge"), (item, "item")])
            conn.execute("DELETE FROM txn WHERE id = ?", (item,))
            link = get_link(conn, link_id)
        self.assertEqual([m["txn_id"] for m in link["members"]], [charge])


if __name__ == "__main__":
    unittest.main()
