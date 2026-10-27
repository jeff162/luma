"""
PayPal funding pairs: a tracked PayPal account's rows paired with the bank and card rows on the other side
of the same movement, so the money counts once (services/paypal_funding.py).

The fixtures are miniatures of the shapes a real household ledger showed: a payment a card paid directly,
counted on both sides; one the user had already fixed by excluding the PayPal side; a withdrawal to the bank
the user had netted by filing both halves alike; a wallet funding leg; two identical charges near one
payment; a second household member's PayPal-looking bank rows. Sign convention: positive is money out.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import list_batches, run_import
from backend.routers.import_export.core import undo_batch
from backend.routers.import_export.paypal_funding import PairRequest, paypal_funding_pair_endpoint
from backend.services import paypal_funding as pf
from backend.services.money_movement import money_movement_category_id_if_exists


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self):
        return self._content


PAYPAL_HEADER = ('"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total",'
                 '"Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"')


def paypal_line(day, name, type_value, amount, txn_id):
    return f'"{day}","10:00:00","EDT","{name}","{type_value}","Completed","USD","{amount}","0.00","{amount}","","","0.00","{txn_id}",""'


class PaypalFundingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "paypal-funding.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            self.owner = self._owner(conn, "Robin")
            self.other_owner = self._owner(conn, "Sam")
            self.paypal = self._account(conn, "PayPal", "paypal", self.owner)
            self.card = self._account(conn, "Harborline Card", "credit", self.owner)
            self.checking = self._account(conn, "Riverstone Checking", "depository", self.owner)
            self.joint = self._account(conn, "Northgate Joint", "depository", SHARED_OWNER_ID)
            self.sams_checking = self._account(conn, "Sam's Checking", "depository", self.other_owner)
            self.charity = self._category(conn, "Charity")
            self.fun = self._category(conn, "Entertainment")
            self.transfers = self._category(conn, "Own transfers", excluded=True)

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    # --- fixture helpers ------------------------------------------------------------------------------

    def _owner(self, conn, name):
        owner_id = str(uuid.uuid4())
        conn.execute("INSERT INTO owner (id, name) VALUES (?, ?)", (owner_id, name))
        return owner_id

    def _account(self, conn, name, type_, owner_id):
        account_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
               VALUES (?, ?, 'fixture', ?, ?, ?, ?)""",
            (account_id, f"x_{account_id}", name, name, type_, owner_id),
        )
        return account_id

    def _category(self, conn, name, excluded=False):
        category_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, name, category_type, exclude_from_totals) VALUES (?, ?, 'expense', ?)",
            (category_id, name, 1 if excluded else 0),
        )
        return category_id

    def _txn(self, account, day, amount, raw, *, category=None, source="manual", type_value=None, pending=False):
        txn_id = str(uuid.uuid4())
        evidence = None
        if type_value:
            evidence = json.dumps({"extra_text_fields": [{"header": "Type", "value": type_value, "role": "categorical"}]})
        with self._db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, date, amount, raw_name, merchant_name, category_id, category_source,
                                    category_overridden, import_evidence_json, is_pending)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (txn_id, account, day, amount, raw, raw, category, source, 1 if source == "manual" else 0,
                 evidence, 1 if pending else 0),
            )
        return txn_id

    def _pass(self):
        with self._db() as conn:
            return pf.pair_paypal_funding(conn)

    def _report(self, batch_id=None):
        with self._db() as conn:
            return pf.paypal_funding_report(conn, batch_id)

    def _category_of(self, txn_id):
        with self._db() as conn:
            row = conn.execute("SELECT category_id, category_source FROM txn WHERE id = ?", (txn_id,)).fetchone()
            return (row["category_id"], row["category_source"]) if row else None

    def _money_movement(self):
        with self._db() as conn:
            return money_movement_category_id_if_exists(conn)

    def _pair_links(self):
        with self._db() as conn:
            return [r["id"] for r in conn.execute("SELECT id FROM txn_link WHERE kind = ?", (pf.LINK_KIND,))]

    def test_pairing_clears_a_duplicate_flag_between_the_rows(self):
        # The post-ingest duplicate sweep runs before the pairing pass, so a flag between the two rows can
        # already exist. A pair is one movement on two accounts, which answers it.
        payment = self._txn(self.paypal, "2026-08-25", 50.0, "Harbor Relief Fund", category=self.charity)
        charge = self._txn(self.card, "2026-08-23", 50.0, "PAYPAL *HARBOR RELIEF", category=self.charity)
        with self._db() as conn:
            conn.execute(
                "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account_weak' WHERE id = ?",
                (charge, payment),
            )
        self.assertEqual(self._pass()["paired"], 1)
        with self._db() as conn:
            row = conn.execute("SELECT suspect_duplicate_of, suspect_resolved_at FROM txn WHERE id = ?",
                               (payment,)).fetchone()
        self.assertIsNone(row["suspect_duplicate_of"])
        self.assertIsNotNone(row["suspect_resolved_at"])

    # --- payment pairs ---------------------------------------------------------------------------------

    def test_a_payment_the_card_paid_counts_once_on_the_paypal_side(self):
        payment = self._txn(self.paypal, "2026-08-25", 50.0, "Harbor Relief Fund", category=self.charity)
        charge = self._txn(self.card, "2026-08-23", 50.0, "PAYPAL *HARBOR RELIEF", category=self.charity)
        self.assertEqual(self._pass()["paired"], 1)
        self.assertEqual(self._category_of(charge), (self._money_movement(), "enrichment"))
        self.assertEqual(self._category_of(payment), (self.charity, "manual"))

        report = self._report()
        self.assertEqual([(m["paypal"]["id"], m["counterpart"]["id"], m["matched_by"]) for m in report["matched"]],
                         [(payment, charge, "auto")])

    def test_unpairing_restores_the_card_row_and_is_not_redone(self):
        self._txn(self.paypal, "2026-08-25", 50.0, "Harbor Relief Fund", category=self.charity)
        charge = self._txn(self.card, "2026-08-23", 50.0, "PAYPAL *HARBOR RELIEF", category=self.charity)
        self._pass()
        with self._db() as conn:
            self.assertEqual(pf.unpair(conn, self._pair_links()), 1)
        self.assertEqual(self._category_of(charge), (self.charity, "manual"))
        self.assertEqual(self._pass()["paired"], 0)
        self.assertEqual(self._pair_links(), [])

    def test_a_payment_whose_paypal_side_is_already_excluded_changes_nothing(self):
        # The user had fixed the double count the other way round, by filing the PayPal row as a transfer:
        # the card row already counts it once, so excluding it too would drop the purchase entirely.
        payment = self._txn(self.paypal, "2026-08-25", 50.0, "Harbor Relief Fund", category=self.transfers)
        charge = self._txn(self.card, "2026-08-23", 50.0, "PAYPAL *HARBOR RELIEF", category=self.charity)
        self.assertEqual(self._pass()["paired"], 1)
        self.assertEqual(self._category_of(charge), (self.charity, "manual"))
        self.assertEqual(self._category_of(payment), (self.transfers, "manual"))

    def test_a_category_chosen_after_pairing_survives_unpairing(self):
        self._txn(self.paypal, "2026-08-25", 50.0, "Harbor Relief Fund", category=self.charity)
        charge = self._txn(self.card, "2026-08-23", 50.0, "PAYPAL *HARBOR RELIEF", category=self.charity)
        self._pass()
        with self._db() as conn:
            conn.execute("UPDATE txn SET category_id = ?, category_source = 'manual' WHERE id = ?", (self.fun, charge))
            pf.unpair(conn, self._pair_links())
        self.assertEqual(self._category_of(charge), (self.fun, "manual"))

    # --- transfer pairs --------------------------------------------------------------------------------

    def test_a_withdrawal_to_the_bank_is_money_movement_on_both_sides(self):
        # Filed alike so the two halves cancelled; paired, both leave the totals and the net is unchanged.
        withdrawal = self._txn(self.paypal, "2026-07-09", 196.0, "Withdrawal", category=self.fun,
                               type_value="User Initiated Withdrawal")
        deposit = self._txn(self.checking, "2026-07-10", -196.0, "Deposit ACH PAYPAL TRANSFER", category=self.fun)
        self.assertEqual(self._pass()["paired"], 1)
        mm = self._money_movement()
        self.assertEqual(self._category_of(withdrawal), (mm, "enrichment"))
        self.assertEqual(self._category_of(deposit), (mm, "enrichment"))
        with self._db() as conn:
            pf.unpair(conn, self._pair_links())
        self.assertEqual(self._category_of(withdrawal), (self.fun, "manual"))
        self.assertEqual(self._category_of(deposit), (self.fun, "manual"))

    def test_a_row_with_no_captured_type_can_pair_either_way(self):
        # A synced PayPal account carries no Type: an outgoing row facing a bank deposit is a withdrawal.
        outgoing = self._txn(self.paypal, "2026-07-09", 196.0, "Transfer to bank", category=self.fun)
        deposit = self._txn(self.checking, "2026-07-12", -196.0, "Deposit ACH PAYPAL TRANSFER", category=self.transfers)
        self.assertEqual(self._pass()["paired"], 1)
        self.assertEqual(self._category_of(outgoing)[0], self._money_movement())
        self.assertEqual(self._category_of(deposit), (self.transfers, "manual"))

    async def test_a_wallet_funding_leg_pairs_with_the_card_charge_and_the_purchase_still_counts(self):
        csv_text = "\n".join([
            PAYPAL_HEADER,
            paypal_line("2026-07-13", "Parts Depot", "Express Checkout Payment", "-129.57", "P1"),
            paypal_line("2026-07-13", "", "General Card Deposit", "129.57", "P2"),
        ])
        charge = self._txn(self.card, "2026-07-14", 129.57, "PAYPAL *PARTSDEPOT", category=self.fun)
        result = await self._import_paypal(csv_text)
        mm = self._money_movement()
        self.assertEqual(self._category_of(charge), (mm, "enrichment"))
        with self._db() as conn:
            purchase = conn.execute(
                "SELECT category_id FROM txn WHERE import_batch_id = ? AND amount > 0", (result["batch_id"],)
            ).fetchone()
        self.assertNotEqual(purchase["category_id"], mm)

    # --- what the pass will not decide -----------------------------------------------------------------

    def test_two_candidates_are_left_for_the_user(self):
        payment = self._txn(self.paypal, "2026-03-05", 75.0, "Trail Club")
        first = self._txn(self.card, "2026-03-04", 75.0, "PAYPAL *TRAILCLUB")
        second = self._txn(self.checking, "2026-03-06", 75.0, "PAYPAL TRAILCLUB")
        self.assertEqual(self._pass()["paired"], 0)
        report = self._report()
        self.assertEqual([c["paypal"]["id"] for c in report["choice"]], [payment])
        self.assertEqual({c["id"] for c in report["choice"][0]["candidates"]}, {first, second})
        with self._db() as conn:
            self.assertEqual(pf.ledger_attention_count(conn), 1)
            pf.pair_rows(conn, payment, second)
        self.assertEqual(self._report()["choice"], [])
        self.assertEqual(self._report()["matched"][0]["matched_by"], "user")
        self.assertEqual(self._category_of(first)[1], "manual")

    def test_none_of_these_leaves_a_payment_with_nothing_to_review(self):
        payment = self._txn(self.paypal, "2026-03-05", 75.0, "Trail Club")
        first = self._txn(self.card, "2026-03-04", 75.0, "PAYPAL *TRAILCLUB")
        second = self._txn(self.checking, "2026-03-06", 75.0, "PAYPAL TRAILCLUB")
        with self._db() as conn:
            pf.decline(conn, payment, [first, second])
        report = self._report()
        # A payment may have been paid from the balance, so with no candidate left it is not "unmatched".
        self.assertEqual((report["choice"], report["unmatched"]), ([], []))
        self.assertEqual(self._pass()["paired"], 0)

    def test_interchangeable_rows_pair_themselves(self):
        payments = [self._txn(self.paypal, "2026-06-15", 12.99, f"Stream Service {i}") for i in range(2)]
        charges = [self._txn(self.card, "2026-06-16", 12.99, "PAYPAL *STREAM") for _ in range(2)]
        self.assertEqual(self._pass()["paired"], 2)
        report = self._report()
        self.assertEqual({m["paypal"]["id"] for m in report["matched"]}, set(payments))
        self.assertEqual({m["counterpart"]["id"] for m in report["matched"]}, set(charges))

    def test_a_cornered_row_claims_its_only_candidate_and_the_rest_pairs_itself(self):
        # Two same-amount payments days apart: the earlier one's only bank row sits inside the later one's
        # window too. Nothing about the earlier row is in doubt, so it takes it, which settles the later one.
        early = self._txn(self.paypal, "2026-03-08", 10.0, "Rights Fund")
        late = self._txn(self.paypal, "2026-03-12", 10.0, "Adblocker")
        first = self._txn(self.checking, "2026-03-09", 10.0, "PAYPAL INST XFER")
        second = self._txn(self.checking, "2026-03-13", 10.0, "PAYPAL INST XFER")
        self.assertEqual(self._pass()["paired"], 2)
        self.assertEqual(self._report()["choice"], [])
        paired = {m["paypal"]["id"]: m["counterpart"]["id"] for m in self._report()["matched"]}
        self.assertEqual(paired, {early: first, late: second})

    def test_two_rows_cornered_on_one_transaction_are_left_for_the_user(self):
        # A shortage, not an ambiguity: at most one of them can have it and which is not deducible, so
        # neither claims it and both keep the one candidate they have.
        payments = [self._txn(self.paypal, "2026-04-02", 40.0, f"Donation {i}") for i in range(2)]
        charge = self._txn(self.checking, "2026-04-03", 40.0, "PAYPAL INST XFER")
        self.assertEqual(self._pass()["paired"], 0)
        choice = self._report()["choice"]
        self.assertEqual({c["paypal"]["id"] for c in choice}, set(payments))
        self.assertEqual([[x["id"] for x in c["candidates"]] for c in choice], [[charge], [charge]])
        # One decision, not two: settling either one settles both, and the review lists them as one row.
        with self._db() as conn:
            self.assertEqual(pf.ledger_attention_count(conn), 1)
        # Settling one of them leaves the other with nothing to pair with, rather than a second claim.
        with self._db() as conn:
            pf.pair_rows(conn, payments[0], charge)
        self.assertEqual((self._report()["choice"], self._pass()["paired"]), ([], 0))

    async def test_a_decision_pairs_what_it_leaves_unambiguous(self):
        # Two payments cornered on one charge — the shortage the pass will not settle — beside a third that
        # could take that charge or a later one. Picking for the first leaves the third with one candidate
        # nothing else wants, and the decision pairs it rather than waiting for the next import.
        first = self._txn(self.paypal, "2026-05-05", 60.0, "Bridge Fund")
        second = self._txn(self.paypal, "2026-05-05", 60.0, "Sidecar Fund")
        third = self._txn(self.paypal, "2026-05-07", 60.0, "Lamplight Fund")
        near = self._txn(self.checking, "2026-05-06", 60.0, "PAYPAL INST XFER")
        far = self._txn(self.checking, "2026-05-10", 60.0, "PAYPAL INST XFER")
        self.assertEqual(self._pass()["paired"], 0)
        self.assertEqual({c["paypal"]["id"] for c in self._report()["choice"]}, {first, second, third})

        token = set_current_db_path(str(self.db_path))
        try:
            answer = await paypal_funding_pair_endpoint(
                PairRequest(paypal_txn_id=first, counterpart_txn_id=near))
        finally:
            reset_current_db_path(token)

        self.assertEqual(answer["also_paired"], 1)
        # The second row is left with nothing to pair with, which is what a balance-funded payment looks
        # like, so nothing is asked about it either.
        self.assertEqual(self._report()["choice"], [])
        self.assertEqual({(m["paypal"]["id"], m["counterpart"]["id"]) for m in self._report()["matched"]},
                         {(first, near), (third, far)})

    def test_another_members_bank_row_never_pairs_but_a_shared_account_does(self):
        self._txn(self.paypal, "2026-06-01", 120.0, "Guitar Lessons")
        sams = self._txn(self.sams_checking, "2026-06-02", 120.0, "Transfer to paypal")
        self.assertEqual(self._pass()["paired"], 0)
        joint = self._txn(self.joint, "2026-06-02", 120.0, "Transfer to paypal")
        self.assertEqual(self._pass()["paired"], 1)
        self.assertEqual(self._report()["matched"][0]["counterpart"]["id"], joint)
        self.assertEqual(self._category_of(sams)[1], "manual")

    def test_a_pending_row_waits_until_it_posts(self):
        self._txn(self.paypal, "2026-06-01", 30.0, "Coffee Roasters")
        charge = self._txn(self.card, "2026-06-01", 30.0, "PAYPAL *ROASTERS", pending=True)
        self.assertEqual(self._pass()["paired"], 0)
        with self._db() as conn:
            conn.execute("UPDATE txn SET is_pending = 0 WHERE id = ?", (charge,))
        self.assertEqual(self._pass()["paired"], 1)

    def test_rows_outside_the_window_do_not_pair(self):
        self._txn(self.paypal, "2026-06-01", 30.0, "Coffee Roasters")
        self._txn(self.card, "2026-06-01", 30.0 + 0.01, "PAYPAL *ROASTERS")
        self._txn(self.card, f"2026-06-{1 + pf.PAIR_WINDOW_DAYS + 1:02d}", 30.0, "PAYPAL *ROASTERS")
        self.assertEqual(self._pass()["paired"], 0)

    # --- the review's other buckets --------------------------------------------------------------------

    def test_a_withdrawal_with_no_bank_row_is_unmatched_until_acknowledged(self):
        withdrawal = self._txn(self.paypal, "2026-03-27", 2100.0, "Withdrawal", type_value="User Initiated Withdrawal")
        report = self._report()
        self.assertEqual([(u["paypal"]["id"], u["reviewed"]) for u in report["unmatched"]], [(withdrawal, False)])
        with self._db() as conn:
            self.assertEqual(pf.ledger_attention_count(conn), 1)
            pf.set_reviewed(conn, [withdrawal], reviewed=True)
            self.assertEqual(pf.ledger_attention_count(conn), 0)
        self.assertEqual(self._report()["unmatched"][0]["reviewed"], True)

    def test_a_charge_with_no_paypal_record_is_listed_only_on_a_funding_account(self):
        self._txn(self.paypal, "2026-01-10", 20.0, "Bike Shop")
        self._txn(self.card, "2026-01-11", 20.0, "PAYPAL *BIKESHOP")
        self._txn(self.paypal, "2026-05-10", 5.0, "Later Row")
        self._pass()
        stray = self._txn(self.card, "2026-03-01", 44.0, "PAYPAL *UNKNOWN")
        self._txn(self.checking, "2026-03-01", 44.0, "PAYPAL *ELSEWHERE")    # never paired with PayPal
        self._txn(self.card, "2025-12-01", 9.0, "PAYPAL *BEFORE")             # before the PayPal rows begin
        self.assertEqual([u["id"] for u in self._report()["unaccounted"]], [stray])

    # --- lifecycle -------------------------------------------------------------------------------------

    def test_a_pairing_whose_paypal_row_is_gone_releases_the_card_row(self):
        payment = self._txn(self.paypal, "2026-08-25", 50.0, "Harbor Relief Fund", category=self.charity)
        charge = self._txn(self.card, "2026-08-23", 50.0, "PAYPAL *HARBOR RELIEF", category=self.charity)
        self._pass()
        with self._db() as conn:
            conn.execute("DELETE FROM txn WHERE id = ?", (payment,))
        self.assertEqual(self._pass()["healed"], 1)
        self.assertEqual(self._category_of(charge), (self.charity, "manual"))
        self.assertEqual(self._pair_links(), [])

    async def test_undoing_the_paypal_import_restores_the_card_row(self):
        charge = self._txn(self.card, "2026-08-23", 50.0, "PAYPAL *HARBOR RELIEF", category=self.charity)
        result = await self._import_paypal("\n".join([
            PAYPAL_HEADER, paypal_line("2026-08-25", "Harbor Relief Fund", "Website Payment", "-50.00", "P9"),
        ]))
        self.assertEqual(self._category_of(charge), (self._money_movement(), "enrichment"))
        token = set_current_db_path(str(self.db_path))
        try:
            undo_batch(result["batch_id"], force=False)
        finally:
            reset_current_db_path(token)
        self.assertEqual(self._category_of(charge), (self.charity, "manual"))
        with self._db() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM txn_link WHERE kind LIKE 'paypal_funding%'").fetchone()[0], 0)

    async def test_a_paypal_import_card_carries_its_attention_count(self):
        result = await self._import_paypal("\n".join([
            PAYPAL_HEADER, paypal_line("2026-03-27", "", "User Initiated Withdrawal", "-2100.00", "P5"),
        ]))
        token = set_current_db_path(str(self.db_path))
        try:
            batches = list_batches()
        finally:
            reset_current_db_path(token)
        card = next(b for b in batches if b["id"] == result["batch_id"])
        self.assertEqual(card["paypal_recon_rows"], 1)
        self.assertEqual(len(card["paypal_recon_attention_ids"]), 1)

    def test_a_sync_card_offers_the_review_only_when_its_share_lists_something(self):
        withdrawal_sync, balance_sync = self._sync_batch("July sync"), self._sync_batch("August sync")
        withdrawal = self._txn(self.paypal, "2026-03-27", 2100.0, "Withdrawal", type_value="General Withdrawal")
        # Paid from the PayPal balance: a PayPal row with no other side, so nothing to reconcile.
        payment = self._txn(self.paypal, "2026-08-10", 30.0, "Trail Club", type_value="Website Payment")
        with self._db() as conn:
            conn.execute("UPDATE txn SET import_batch_id = ? WHERE id = ?", (withdrawal_sync, withdrawal))
            conn.execute("UPDATE txn SET import_batch_id = ? WHERE id = ?", (balance_sync, payment))
        token = set_current_db_path(str(self.db_path))
        try:
            cards = {b["id"]: b for b in list_batches()}
        finally:
            reset_current_db_path(token)
        self.assertEqual(cards[withdrawal_sync]["paypal_recon_rows"], 1)
        self.assertEqual(cards[withdrawal_sync]["paypal_recon_attention_ids"], [withdrawal])
        self.assertNotIn("paypal_recon_rows", cards[balance_sync])

    def _sync_batch(self, label):
        batch_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, status, source_kind) VALUES (?, ?, 'completed', 'connection_sync')",
                (batch_id, label),
            )
        return batch_id

    async def _import_paypal(self, csv_text):
        config = {
            "filename": "paypal.csv",
            "account_id": self.paypal,
            "account_map": {},
            "column_map": {"date": "Date", "description": "Name", "amount": "Amount", "evidence_columns": ["Type"]},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
        }
        token = set_current_db_path(str(self.db_path))
        try:
            return await run_import(file=FakeUploadFile("paypal.csv", csv_text), config=json.dumps(config))
        finally:
            reset_current_db_path(token)
