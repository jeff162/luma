"""
Multi-payment purchases (`services/purchase_links.py`): several transactions that are one purchase.

Pins the invariants the feature's figures depend on — a payment belongs to one purchase, a purchase
has at least two payments, totals count live payments only — and the two properties that make it safe
to reach for: the link never touches the transactions it groups, and it does not outlive them.
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
from backend.services.purchase_links import (
    PurchaseLinkError,
    add_payments,
    create_purchase,
    delete_purchase,
    get_purchase,
    purchase_for_txn,
    purchase_map_for,
    remove_payment,
    update_purchase,
)


class PurchaseLinkTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "purchases.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('acct', 'p_acct', 'fixture', 'Rewards Card', 'Rewards Card', 'credit', ?)""",
                (SHARED_OWNER_ID,),
            )
            conn.execute(
                "INSERT INTO category (id, name, parent_id) VALUES ('cat_home', 'Home Improvement', NULL)"
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

    def _txn(self, amount=100.0, name="Riverstone Joinery", date="2026-03-04", category_id=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,
                                    raw_name, date, is_pending, category_id)
                   VALUES (?, 'acct', ?, ?, ?, ?, ?, ?, 0, ?)""",
                (txn_id, SHARED_OWNER_ID, amount, name, name, name, date, category_id),
            )
        return txn_id

    def _trash(self, txn_id):
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE txn SET trashed_at = '2026-05-01T00:00:00Z' WHERE id = ?", (txn_id,))

    # --- Shape -----------------------------------------------------------------------------------

    def test_create_groups_payments_oldest_first_with_totals(self):
        deposit = self._txn(amount=2400.0, date="2026-03-04")
        balance = self._txn(amount=3600.0, date="2026-05-19")
        with self._use_db_path(), get_db() as conn:
            purchase = create_purchase(
                conn, [balance, deposit],  # deliberately out of order: date is what orders them
                label="Kitchen counters", reference="INV-4471", expected_total=6000.0,
            )
        self.assertEqual([p["txn_id"] for p in purchase["payments"]], [deposit, balance])
        self.assertEqual(purchase["label"], "Kitchen counters")
        self.assertEqual(purchase["reference"], "INV-4471")
        self.assertEqual(purchase["expected_total"], 6000.0)
        self.assertEqual(purchase["linked_total"], 6000.0)
        self.assertEqual(purchase["unaccounted"], 0.0)
        self.assertEqual(purchase["payment_count"], 2)

    def test_unaccounted_reports_the_gap_and_is_none_without_an_expected_total(self):
        deposit = self._txn(amount=2400.0, date="2026-03-04")
        balance = self._txn(amount=1000.0, date="2026-05-19")
        other_a = self._txn(amount=5.0)
        other_b = self._txn(amount=6.0, date="2026-06-01")
        with self._use_db_path(), get_db() as conn:
            short = create_purchase(conn, [deposit, balance], expected_total=6000.0)
            self.assertEqual(short["unaccounted"], 2600.0)
            silent = create_purchase(conn, [other_a, other_b])
            self.assertIsNone(silent["unaccounted"])
            self.assertEqual(silent["linked_total"], 11.0)

    def test_a_refund_member_nets_against_the_purchase(self):
        # Signs are deliberately not constrained: a refund on a purchase is part of what it cost, and
        # the honest total is the net rather than the gross.
        deposit = self._txn(amount=2400.0, date="2026-03-04")
        balance = self._txn(amount=3600.0, date="2026-05-19")
        refund = self._txn(amount=-500.0, date="2026-06-02")
        with self._use_db_path(), get_db() as conn:
            purchase = create_purchase(conn, [deposit, balance, refund], expected_total=6000.0)
        self.assertEqual(purchase["linked_total"], 5500.0)
        self.assertEqual(purchase["unaccounted"], 500.0)

    def test_purchase_for_txn_finds_it_from_either_payment(self):
        deposit = self._txn(date="2026-03-04")
        balance = self._txn(date="2026-05-19")
        unlinked = self._txn()
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [deposit, balance], label="Deck")
            for txn_id in (deposit, balance):
                found = purchase_for_txn(conn, txn_id)
                self.assertEqual(found["id"], created["id"])
            self.assertIsNone(purchase_for_txn(conn, unlinked))

    # --- Invariants ------------------------------------------------------------------------------

    def test_a_payment_belongs_to_only_one_purchase(self):
        deposit = self._txn(date="2026-03-04")
        balance = self._txn(date="2026-05-19")
        other = self._txn(date="2026-07-01")
        with self._use_db_path(), get_db() as conn:
            create_purchase(conn, [deposit, balance])
            with self.assertRaises(PurchaseLinkError) as caught:
                create_purchase(conn, [balance, other])
        self.assertIn("only belong to one purchase", str(caught.exception))

    def test_one_payment_is_not_a_purchase(self):
        with self._use_db_path(), get_db() as conn:
            with self.assertRaises(PurchaseLinkError):
                create_purchase(conn, [self._txn()])
            # A repeated id is a selection artifact, not a second payment.
            single = self._txn()
            with self.assertRaises(PurchaseLinkError):
                create_purchase(conn, [single, single])

    def test_a_trashed_row_cannot_be_linked(self):
        deposit = self._txn(date="2026-03-04")
        balance = self._txn(date="2026-05-19")
        self._trash(balance)
        with self._use_db_path(), get_db() as conn:
            with self.assertRaises(PurchaseLinkError) as caught:
                create_purchase(conn, [deposit, balance])
        self.assertIn("trash", str(caught.exception))

    def test_a_payment_trashed_after_linking_stays_listed_but_leaves_the_total(self):
        deposit = self._txn(amount=2400.0, date="2026-03-04")
        balance = self._txn(amount=3600.0, date="2026-05-19")
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [deposit, balance], expected_total=6000.0)
        self._trash(balance)
        with self._use_db_path(), get_db() as conn:
            after = get_purchase(conn, created["id"])
        self.assertEqual([p["txn_id"] for p in after["payments"]], [deposit, balance])
        self.assertTrue(next(p for p in after["payments"] if p["txn_id"] == balance)["trashed"])
        self.assertEqual(after["linked_total"], 2400.0)
        self.assertEqual(after["payment_count"], 1)
        self.assertEqual(after["unaccounted"], 3600.0)

    def test_linking_never_touches_the_transactions(self):
        deposit = self._txn(amount=2400.0, date="2026-03-04", category_id="cat_home")
        balance = self._txn(amount=3600.0, date="2026-05-19", category_id="cat_home")

        def snapshot():
            with self._use_db_path(), get_db() as conn:
                return [
                    dict(row)
                    for row in conn.execute(
                        "SELECT * FROM txn WHERE id IN (?, ?) ORDER BY id", (deposit, balance)
                    )
                ]

        before = snapshot()
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [deposit, balance], label="Kitchen counters")
        self.assertEqual(snapshot(), before)
        with self._use_db_path(), get_db() as conn:
            delete_purchase(conn, created["id"])
        self.assertEqual(snapshot(), before)

    # --- Editing ---------------------------------------------------------------------------------

    def test_add_payments_grows_an_existing_purchase(self):
        first = self._txn(amount=1000.0, date="2026-03-04")
        second = self._txn(amount=1000.0, date="2026-04-04")
        third = self._txn(amount=1000.0, date="2026-05-04")
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [first, second], expected_total=3000.0)
            grown = add_payments(conn, created["id"], [third])
        self.assertEqual([p["txn_id"] for p in grown["payments"]], [first, second, third])
        self.assertEqual(grown["linked_total"], 3000.0)
        self.assertEqual(grown["unaccounted"], 0.0)

    def test_add_payments_is_idempotent_for_a_row_already_in_this_purchase(self):
        first = self._txn(date="2026-03-04")
        second = self._txn(date="2026-04-04")
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [first, second])
            again = add_payments(conn, created["id"], [second])
        self.assertEqual(len(again["payments"]), 2)

    def test_update_replaces_every_field_so_one_can_be_cleared(self):
        first = self._txn(date="2026-03-04")
        second = self._txn(date="2026-04-04")
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(
                conn, [first, second], label="Kitchen", reference="INV-1", expected_total=200.0
            )
            cleared = update_purchase(conn, created["id"], label="Kitchen counters")
        self.assertEqual(cleared["label"], "Kitchen counters")
        self.assertIsNone(cleared["reference"])
        self.assertIsNone(cleared["expected_total"])
        self.assertIsNone(cleared["unaccounted"])

    def test_removing_a_payment_keeps_a_purchase_that_still_has_two(self):
        first = self._txn(amount=1000.0, date="2026-03-04")
        second = self._txn(amount=1000.0, date="2026-04-04")
        third = self._txn(amount=1000.0, date="2026-05-04")
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [first, second, third])
            remaining = remove_payment(conn, created["id"], second)
        self.assertIsNotNone(remaining)
        self.assertEqual([p["txn_id"] for p in remaining["payments"]], [first, third])
        self.assertEqual(remaining["linked_total"], 2000.0)

    def test_removing_a_payment_that_would_leave_one_drops_the_whole_purchase(self):
        first = self._txn(date="2026-03-04")
        second = self._txn(date="2026-04-04")
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [first, second])
            self.assertIsNone(remove_payment(conn, created["id"], second))
            self.assertIsNone(purchase_for_txn(conn, first))
            with self.assertRaises(PurchaseLinkError):
                get_purchase(conn, created["id"])
        # Both transactions survive it — the link was never what held them.
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) c FROM txn WHERE id IN (?, ?)", (first, second)).fetchone()["c"],
                2,
            )

    def test_a_purchase_does_not_outlive_its_payments(self):
        # `txn_link` has no FK to `txn`, so nothing cascades the link away when the last payment is
        # hard-deleted. The prune trigger is what stops an invisible row accumulating forever.
        first = self._txn(date="2026-03-04")
        second = self._txn(date="2026-04-04")
        with self._use_db_path(), get_db() as conn:
            created = create_purchase(conn, [first, second])
            conn.execute("DELETE FROM txn WHERE id = ?", (first,))
            self.assertEqual(
                conn.execute("SELECT COUNT(*) c FROM txn_link WHERE id = ?", (created["id"],)).fetchone()["c"],
                1,
                "one payment left is still a link with a member",
            )
            conn.execute("DELETE FROM txn WHERE id = ?", (second,))
            self.assertEqual(
                conn.execute("SELECT COUNT(*) c FROM txn_link WHERE id = ?", (created["id"],)).fetchone()["c"],
                0,
            )

    def test_the_prune_trigger_leaves_other_link_kinds_alone(self):
        # Other kinds run multi-step reversals of their own; a link swept out from under one would take
        # the metadata its undo depends on with it.
        from backend.services.txn_links import create_link

        charge = self._txn()
        with self._use_db_path(), get_db() as conn:
            link_id = create_link(
                conn, "amazon_order", [(charge, "charge")], metadata={"charge_priors": {charge: "cat"}}
            )
            conn.execute("DELETE FROM txn WHERE id = ?", (charge,))
            self.assertEqual(
                conn.execute("SELECT COUNT(*) c FROM txn_link WHERE id = ?", (link_id,)).fetchone()["c"], 1
            )

    # --- The ledger row's summary ----------------------------------------------------------------

    def test_purchase_map_numbers_each_payment_within_its_purchase(self):
        first = self._txn(amount=1000.0, date="2026-03-04")
        second = self._txn(amount=1500.0, date="2026-04-04")
        third = self._txn(amount=500.0, date="2026-05-04")
        unlinked = self._txn(amount=9.0, date="2026-05-05")
        with self._use_db_path(), get_db() as conn:
            create_purchase(conn, [first, second, third], label="Deck", expected_total=3000.0)
            mapped = purchase_map_for(conn, [first, second, third, unlinked])
        self.assertNotIn(unlinked, mapped)
        self.assertEqual([mapped[t]["position"] for t in (first, second, third)], [1, 2, 3])
        self.assertEqual(mapped[first]["payment_count"], 3)
        self.assertEqual(mapped[first]["label"], "Deck")
        self.assertEqual(mapped[first]["linked_total"], 3000.0)
        self.assertEqual(mapped[first]["expected_total"], 3000.0)

    def test_purchase_map_counts_the_whole_purchase_from_one_visible_payment(self):
        # A ledger page usually shows one payment of a purchase, not all of them: the ordinal and the
        # count still have to describe the purchase rather than the page.
        first = self._txn(amount=1000.0, date="2026-03-04")
        second = self._txn(amount=1500.0, date="2026-04-04")
        with self._use_db_path(), get_db() as conn:
            create_purchase(conn, [first, second])
            mapped = purchase_map_for(conn, [second])
        self.assertEqual(mapped[second]["position"], 2)
        self.assertEqual(mapped[second]["payment_count"], 2)
        self.assertEqual(mapped[second]["linked_total"], 2500.0)

    def test_purchase_map_gives_a_trashed_payment_no_ordinal(self):
        first = self._txn(amount=1000.0, date="2026-03-04")
        second = self._txn(amount=1500.0, date="2026-04-04")
        third = self._txn(amount=500.0, date="2026-05-04")
        with self._use_db_path(), get_db() as conn:
            create_purchase(conn, [first, second, third])
        self._trash(second)
        with self._use_db_path(), get_db() as conn:
            mapped = purchase_map_for(conn, [first, second, third])
        self.assertEqual(mapped[first]["position"], 1)
        self.assertIsNone(mapped[second]["position"], "a trashed payment is not one of the N")
        self.assertEqual(mapped[third]["position"], 2)
        self.assertEqual(mapped[third]["payment_count"], 2)
        self.assertEqual(mapped[third]["linked_total"], 1500.0)

    def test_purchase_map_is_empty_for_an_empty_page(self):
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(purchase_map_for(conn, []), {})
            self.assertEqual(purchase_map_for(conn, [None]), {})


if __name__ == "__main__":
    unittest.main()
