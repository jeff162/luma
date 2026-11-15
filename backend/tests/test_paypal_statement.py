"""
PayPal statement import: a monthly statement PDF read into rows (services/paypal_statement.py) and imported
into the PayPal account it belongs to, under the PayPal data source (routers/import_export/paypal_statement.py).

The statements here are generated with the layout PayPal prints — a date that wraps its last digit, a
description that wraps, the bank a payment drew on indented under it, `ID:` and `Ref ID:` lines — and the
second "PayPal Balance account" statement after the first. Names are invented. Sign convention in the
ledger: positive is money out; in a statement, as in PayPal's CSV, negative is money out.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import PAYPAL_SOURCE_KIND, run_import_core, undo_batch
from backend.routers.transactions import CategoryOverride, override_category
from backend.routers.import_export.paypal_statement import import_paypal_statements, scan_paypal_statements
from backend.routers.import_export.profiles import list_profiles
from backend.services import wallet_pairs
from backend.services.wallet_accounts import fill_wallet_match_text
from backend.services.categorizer import recategorize_all
from backend.services.money_movement import money_movement_category_id_if_exists
from backend.services.paypal_statement import StatementError, read_statement
from backend.services.refund_links import refund_map_for
from backend.services.transaction_attributes import attribute_membership
from backend.tests._pdf_fixture import make_positioned_pdf, make_text_pdf

COLUMNS = {"date": 20, "description": 110, "currency": 330, "amount": 400, "fees": 470, "total": 540}


def txn(date, description, amount, txn_id, *, currency="USD", ref=None, wrap=None, bank=None, date_wraps=False,
        exchange=None):
    return {"date": date, "description": description, "amount": amount, "id": txn_id, "currency": currency,
            "ref": ref, "wrap": wrap, "bank": bank or [], "date_wraps": date_wraps, "exchange": exchange}


def statement_pdf(transactions, *, account="robin@example.com", holder="Vale, Robin",
                  period=("Apr 1, 2026 - Apr 30,", "2026"), balance_rows=(), footnote="*For each transaction, the Total equals the amount plus or minus any Fees."):
    """A two-statement PDF as PayPal prints it: the PayPal account statement, then the Balance one."""
    def activity(title, rows):
        placed = [(20, 770, "ACCOUNT STATEMENTS"), (20, 758, holder),
                  (30, 735, "Statement Period"), (200, 735, "PayPal Account ID"),
                  (30, 722, period[0]), (30, 712, period[1]), (200, 722, account),
                  (20, 690, title), (20, 670, "ACCOUNT ACTIVITY"),
                  *[(x, 655, label) for label, x in zip(("DATE", "DESCRIPTION", "CURRENCY", "AMOUNT", "FEES", "TOTAL*"),
                                                         COLUMNS.values())]]
        y = 635
        for t in rows:
            date = t["date"][:-1] if t["date_wraps"] else t["date"]
            placed += [(COLUMNS["date"], y, date), (COLUMNS["description"], y, t["description"]),
                       (COLUMNS["currency"], y, t["currency"]), (COLUMNS["amount"], y, t["amount"]),
                       (COLUMNS["fees"], y, "0.00"), (COLUMNS["total"], y, t["amount"])]
            y -= 10
            if t["date_wraps"]:
                placed.append((COLUMNS["date"], y, t["date"][-1]))
            if t["wrap"]:
                placed.append((COLUMNS["description"], y, t["wrap"]))
                y -= 10
            for line in t["bank"]:
                placed.append((COLUMNS["description"] + 10, y, line))
                y -= 10
            if t["bank"]:
                placed.append((COLUMNS["description"], y, t["currency"]))
                y -= 10
            if t["exchange"]:
                # As PayPal prints it: the rate indented, the amount converted into to its right, and
                # that amount's currency wrapped onto the next line.
                rate, converted, converted_currency = t["exchange"]
                placed += [(COLUMNS["description"] + 10, y, rate), (COLUMNS["currency"] - 40, y, converted)]
                y -= 10
                placed.append((COLUMNS["description"], y, converted_currency))
                y -= 10
            if t["id"]:
                placed.append((COLUMNS["description"], y, f"ID: {t['id']}"))
                y -= 10
            if t["ref"]:
                placed.append((COLUMNS["description"], y, f"Ref ID: {t['ref']}"))
                y -= 10
            y -= 15
        placed += [(20, 200, footnote), (450, 40, "Page  1")]
        return placed

    return make_positioned_pdf([activity("PAYPAL ACCOUNT", transactions),
                                activity("PAYPAL BALANCE ACCOUNT", list(balance_rows))])


PAYMENT = txn("04/22/2026", "Express Checkout Payment: Harbor", "-54.95", "1AA00000AA0000001",
              wrap="Cycle Works", date_wraps=True)
DEPOSIT = txn("04/22/2026", "General Credit Card Deposit", "54.95", "2BB00000BB0000002", ref="1AA00000AA0000001")
# The purchase above refunded two days later: the refund lands in the balance and a withdrawal carries it
# straight back to the card, both naming the payment.
REFUND = txn("04/24/2026", "Payment Refund: Harbor Cycle Works", "54.95", "3RR00000RR0000003", ref="1AA00000AA0000001")
RETURNED = txn("04/24/2026", "General Credit Card Withdrawal", "-54.95", "4WW00000WW0000004", ref="1AA00000AA0000001")


class StatementReadingTests(unittest.TestCase):
    def test_reads_each_transaction_with_its_wrapped_parts(self):
        bank_paid = txn("04/25/2026", "Mobile Payment: Sam Okafor", "-35.00", "3CC00000CC0000003",
                        bank=["RIVERSTONE BANK -", "Checking x-0000     35.00"])
        statement = read_statement(statement_pdf([PAYMENT, DEPOSIT, bank_paid]))
        self.assertEqual((statement.paypal_account_id, statement.holder), ("robin@example.com", "Vale, Robin"))
        self.assertEqual((statement.period_start, statement.period_end), ("2026-04-01", "2026-04-30"))
        payment, deposit, bank_row = statement.rows
        self.assertEqual((payment["Date"], payment["Type"], payment["Name"], payment["Total"]),
                         ("04/22/2026", "Express Checkout Payment", "Harbor Cycle Works", "-54.95"))
        self.assertEqual((deposit["Name"], deposit["Ref ID"]), ("", "1AA00000AA0000001"))
        self.assertEqual(bank_row["Bank account"], "RIVERSTONE BANK - Checking x-0000")

    def test_reads_only_the_paypal_account_statement(self):
        # The Balance account statement repeats the rows that touched the balance.
        statement = read_statement(statement_pdf([PAYMENT, DEPOSIT], balance_rows=[DEPOSIT]))
        self.assertEqual(len(statement.rows), 2)

    def test_the_same_month_downloaded_again_is_recognized(self):
        first = read_statement(statement_pdf([PAYMENT, DEPOSIT]))
        again = read_statement(statement_pdf([PAYMENT, DEPOSIT], footnote="*Totals include any fees."))
        self.assertEqual(first.content_hash, again.content_hash)

    def test_a_pdf_that_is_not_a_statement_is_not_read(self):
        self.assertIsNone(read_statement(make_text_pdf(["INVOICE", "Harbor Cycle Works", "Total 54.95"])))

    def test_a_transaction_without_its_id_refuses_the_whole_statement(self):
        with self.assertRaises(StatementError):
            read_statement(statement_pdf([dict(PAYMENT, id=None), DEPOSIT]))


class FakeUpload:
    def __init__(self, filename, data):
        self.filename = filename
        self._data = data

    async def read(self, size: int = -1):
        return self._data


def zipped(**members):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return buffer.getvalue()


class StatementImportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "statements.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            self.owner = str(uuid.uuid4())
            conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Robin')", (self.owner,))
            self.paypal = self._account(conn, "PayPal", "paypal")
            self.second_paypal = self._account(conn, "PayPal (Sam)", "paypal")
            self.card = self._account(conn, "Harborline Card", "credit")

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

    def _account(self, conn, name, type_):
        account_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
               VALUES (?, ?, 'fixture', ?, ?, ?, ?)""",
            (account_id, f"x_{account_id}", name, name, type_, self.owner),
        )
        fill_wallet_match_text(conn, [account_id])
        return account_id

    async def _call(self, endpoint, *args):
        token = set_current_db_path(str(self.db_path))
        try:
            return await endpoint(*args)
        finally:
            reset_current_db_path(token)

    async def _import(self, files, assignments):
        return await self._call(import_paypal_statements, files, json.dumps(assignments))

    def _rows(self, account_id):
        with self._db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT id, date, amount, merchant_name, category_id, import_evidence_json, import_batch_id "
                "FROM txn WHERE account_id = ? AND trashed_at IS NULL ORDER BY date, amount", (account_id,))]

    def _card_charge(self, day, amount, raw):
        charge_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, date, amount, raw_name, merchant_name) VALUES (?, ?, ?, ?, ?, ?)",
                (charge_id, self.card, day, amount, raw, raw),
            )
        return charge_id

    def _category(self, txn_id):
        with self._db() as conn:
            return conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()["category_id"]

    async def test_the_paypal_source_lists_which_account_each_paypal_accounts_statements_go_into(self):
        # The pairing is read back from past imports rather than stored as a setting, so the data source
        # listing is the one place it can be seen; it has to follow the imports, undo included.
        result = await self._import([FakeUpload("s.pdf", statement_pdf([PAYMENT, DEPOSIT]))],
                                    {"robin@example.com": self.paypal})

        def listed():
            token = set_current_db_path(str(self.db_path))
            try:
                (source,) = [p for p in list_profiles() if p["source_kind"] == PAYPAL_SOURCE_KIND]
            finally:
                reset_current_db_path(token)
            return source["statement_accounts"]

        self.assertEqual(listed(), [{"paypal_account_id": "robin@example.com", "account_id": self.paypal,
                                     "account_name": "PayPal"}])
        with self._db():
            undo_batch(result["batches"][0]["batch_id"])
        self.assertEqual(listed(), [])

    async def test_a_statement_lands_in_its_paypal_account_under_the_paypal_source(self):
        pdf = statement_pdf([PAYMENT, DEPOSIT])
        scan = await self._call(scan_paypal_statements, [FakeUpload("statement-Apr-2026.pdf", pdf)])
        self.assertEqual([(s["paypal_account_id"], s["transaction_count"]) for s in scan["statements"]],
                         [("robin@example.com", 2)])

        result = await self._import([FakeUpload("statement-Apr-2026.pdf", pdf)], {"robin@example.com": self.paypal})
        (batch,) = result["batches"]
        self.assertEqual(batch["imported"], 2)
        with self._db() as conn:
            row = conn.execute(
                "SELECT b.source_kind, p.source_kind AS profile_kind FROM import_batch b "
                "JOIN csv_import_profile p ON p.id = b.profile_id WHERE b.id = ?", (batch["batch_id"],)).fetchone()
        self.assertEqual((row["source_kind"], row["profile_kind"]), (PAYPAL_SOURCE_KIND, PAYPAL_SOURCE_KIND))
        deposit, payment = self._rows(self.paypal)
        self.assertEqual((payment["amount"], payment["merchant_name"]), (54.95, "Harbor Cycle Works"))
        fields = {f["header"]: f for f in json.loads(deposit["import_evidence_json"])["extra_text_fields"]}
        self.assertEqual(fields["Ref ID"], {"header": "Ref ID", "value": "1AA00000AA0000001", "role": "categorical"})

    async def test_a_named_card_deposit_is_the_leg_of_the_payment_its_ref_id_names(self):
        # A deposit carrying the merchant's name reads as a real inflow to the structural pairing; the Ref
        # ID says otherwise. The card charge it drew then pairs with it, so the donation counts once.
        charge = self._card_charge("2026-04-20", 50.0, "PAYPAL *HARBOR RELIEF")
        donation = txn("04/22/2026", "Website Payment: Harbor Relief Fund", "-50.00", "4DD00000DD0000004")
        deposit = txn("04/22/2026", "General Credit Card Deposit: Harbor Relief Fund", "50.00", "5EE00000EE0000005",
                      ref="4DD00000DD0000004")
        # A refund refers to its payment the same way, and is real money back, not a leg.
        from_balance = txn("04/23/2026", "Website Payment: Trail Club", "-30.00", "6FF00000FF0000006")
        refund = txn("04/24/2026", "Payment Refund: Trail Club", "30.00", "7FF00000FF0000007", ref="6FF00000FF0000006")
        await self._import([FakeUpload("s.pdf", statement_pdf([donation, deposit, from_balance, refund]))],
                           {"robin@example.com": self.paypal})
        with self._db() as conn:
            links = conn.execute(
                "SELECT m.txn_id, m.role FROM txn_link l JOIN txn_link_member m ON m.link_id = l.id "
                "WHERE l.kind = 'wallet_funding'").fetchall()
            money_movement = money_movement_category_id_if_exists(conn)
        by_amount = {(r["date"], r["amount"]): r["id"] for r in self._rows(self.paypal)}
        self.assertEqual({(r["txn_id"], r["role"]) for r in links},
                         {(by_amount[("2026-04-22", -50.0)], "leg"), (by_amount[("2026-04-22", 50.0)], "purchase")})
        self.assertEqual(self._category(charge), money_movement)
        self.assertNotEqual(self._category(by_amount[("2026-04-24", -30.0)]), money_movement)

    def _new_category(self, name):
        group_id, category_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._db() as conn:
            conn.execute("INSERT INTO category (id, name, category_type) VALUES (?, ?, 'expense')", (group_id, f"{name} group"))
            conn.execute("INSERT INTO category (id, name, category_type, parent_id) VALUES (?, ?, 'expense', ?)",
                         (category_id, name, group_id))
        return category_id

    def _categorize(self, txn_id, category_id):
        token = set_current_db_path(str(self.db_path))
        try:
            return override_category(txn_id, CategoryOverride(category_id=category_id))
        finally:
            reset_current_db_path(token)

    def _source(self, txn_id):
        with self._db() as conn:
            return conn.execute("SELECT category_source FROM txn WHERE id = ?", (txn_id,)).fetchone()["category_source"]

    def _links(self, kind):
        with self._db() as conn:
            return {(r["txn_id"], r["role"]) for r in conn.execute(
                "SELECT m.txn_id, m.role FROM txn_link l JOIN txn_link_member m ON m.link_id = l.id WHERE l.kind = ?",
                (kind,))}

    async def test_a_refund_follows_its_payment_and_its_return_to_the_card_is_money_movement(self):
        bikes, gifts = self._new_category("Bikes"), self._new_category("Gifts")
        with self._db() as conn:
            conn.execute("INSERT INTO category_rule (id, category_id, keyword) VALUES (?, ?, 'harbor')",
                         (str(uuid.uuid4()), bikes))
        await self._import([FakeUpload("s.pdf", statement_pdf([PAYMENT, DEPOSIT, REFUND, RETURNED]))],
                           {"robin@example.com": self.paypal})
        rows = {(r["date"], r["amount"]): r["id"] for r in self._rows(self.paypal)}
        payment, deposit = rows[("2026-04-22", 54.95)], rows[("2026-04-22", -54.95)]
        refund, returned = rows[("2026-04-24", -54.95)], rows[("2026-04-24", 54.95)]
        with self._db() as conn:
            money_movement = money_movement_category_id_if_exists(conn)

        self.assertEqual(self._links("wallet_funding"),
                         {(deposit, "leg"), (payment, "purchase"), (returned, "leg"), (refund, "refund")})
        self.assertEqual((self._category(deposit), self._category(returned)), (money_movement, money_movement))
        self.assertEqual(self._links("refund"), {(payment, "payment"), (refund, "refund")})
        self.assertEqual((self._category(payment), self._category(refund), self._source(refund)), (bikes, bikes, "refund"))
        # Each side names the other for the row's link marker.
        with self._db() as conn:
            summaries = refund_map_for(conn, [payment, refund, deposit])
        self.assertEqual({k: (v["role"], [o["id"] for o in v["others"]]) for k, v in summaries.items()},
                         {payment: ("payment", [refund]), refund: ("refund", [payment])})
        # The Refunded filter finds both sides, and nothing else in the statement.
        refunded_sql, _ = attribute_membership(["refund"])
        with self._db() as conn:
            self.assertEqual({r["id"] for r in conn.execute(f"SELECT t.id FROM txn t WHERE {refunded_sql}")},
                             {payment, refund})

        # Recategorizing the payment moves the refund with it, and says so for the client to refresh it.
        self.assertEqual(self._categorize(payment, gifts)["followed_ids"], [refund])
        self.assertEqual(self._category(refund), gifts)
        # The rule that matches the refund's name does not pull it back.
        with self._db() as conn:
            recategorize_all(conn)
        self.assertEqual(self._category(refund), gifts)

        # A category set on the refund itself is the user's; it no longer follows.
        self._categorize(refund, bikes)
        self.assertEqual(self._categorize(payment, bikes)["followed_ids"], [])
        self._categorize(payment, gifts)
        self.assertEqual(self._category(refund), bikes)

    async def test_a_refund_in_a_later_statement_pairs_whichever_arrives_first_and_undoes_cleanly(self):
        gifts = self._new_category("Gifts")
        may = statement_pdf([txn("05/03/2026", "Payment Refund: Harbor Cycle Works", "20.00", "5RR00000RR0000005",
                                 ref="1AA00000AA0000001")], period=("May 1, 2026 - May 31,", "2026"))
        await self._import([FakeUpload("may.pdf", may)], {"robin@example.com": self.paypal})
        (refund,) = [r["id"] for r in self._rows(self.paypal)]
        self.assertEqual(self._links("refund"), set())

        result = await self._import([FakeUpload("april.pdf", statement_pdf([PAYMENT]))], {"robin@example.com": self.paypal})
        payment = next(r["id"] for r in self._rows(self.paypal) if r["id"] != refund)
        self.assertEqual(self._links("refund"), {(payment, "payment"), (refund, "refund")})
        self._categorize(payment, gifts)
        self.assertEqual((self._category(refund), self._source(refund)), (gifts, "refund"))

        # Undoing the payment's import puts the refund back as it was and drops the link.
        token = set_current_db_path(str(self.db_path))
        try:
            undo_batch(result["batches"][0]["batch_id"], force=True)
        finally:
            reset_current_db_path(token)
        self.assertEqual((self._category(refund), self._source(refund)), (None, None))
        self.assertEqual(self._links("refund"), set())

    async def test_a_statement_refund_pairs_with_a_payment_only_the_activity_csv_brought_in(self):
        # The Transaction ID is the one identifier both files carry, so the CSV captures it whether or not
        # the column was picked — as an identifier, kept out of duplicate matching.
        header = ('"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total",'
                  '"Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"')
        line = ('"03/10/2026","10:00:00","EDT","Harbor Cycle Works","Express Checkout Payment","Completed","USD",'
                '"-54.95","0.00","-54.95","","","0.00","1AA00000AA0000001","Chain lube"')
        token = set_current_db_path(str(self.db_path))
        try:
            run_import_core(f"{header}\n{line}\n", {
                "account_id": self.paypal, "date_format": "%m/%d/%Y", "amount_convention": "single_signed",
                "column_map": {"date": "Date", "description": "Name", "amount": "Total"},
            }, filename="activity.csv")
        finally:
            reset_current_db_path(token)
        (payment,) = self._rows(self.paypal)
        fields = {f["header"]: f for f in json.loads(payment["import_evidence_json"])["extra_text_fields"]}
        self.assertEqual(fields["Transaction ID"]["role"], "categorical")

        april = statement_pdf([txn("04/02/2026", "Payment Refund: Harbor Cycle Works", "54.95", "3RR00000RR0000003",
                                   ref="1AA00000AA0000001")])
        await self._import([FakeUpload("april.pdf", april)], {"robin@example.com": self.paypal})
        refund = next(r["id"] for r in self._rows(self.paypal) if r["id"] != payment["id"])
        self.assertEqual(self._links("refund"), {(payment["id"], "payment"), (refund, "refund")})

    async def test_a_payment_in_another_currency_is_refused_with_its_card_deposit(self):
        # Imported alone, the deposit would pair the card charge away and leave nothing counting the
        # purchase; refused together, the card charge stays its record.
        charge = self._card_charge("2026-04-09", 31.75, "PAYPAL *CHARTWORKS")
        payment = txn("04/09/2026", "Subscription Payment: Chartworks Ltd", "-25.00", "7GG00000GG0000007",
                      currency="GBP")
        deposit = txn("04/09/2026", "General Credit Card Deposit", "31.75", "8HH00000HH0000008", ref="7GG00000GG0000007")
        result = await self._import([FakeUpload("s.pdf", statement_pdf([payment, deposit, PAYMENT]))],
                                    {"robin@example.com": self.paypal})
        self.assertEqual(result["batches"][0]["rejected"], 2)
        self.assertEqual([r["amount"] for r in self._rows(self.paypal)], [54.95])
        self.assertIsNone(self._category(charge))
        with self._db() as conn:
            self.assertEqual(wallet_pairs.wallet_pair_report(conn)["matched"], [])

    async def test_a_payment_paypal_converted_currency_to_pay_is_imported_at_what_it_cost(self):
        # Restated in dollars from the conversion printed under it, the payment is an ordinary one: the
        # deposit is its leg and the card charge pairs away, so the purchase counts once, here.
        charge = self._card_charge("2026-04-15", 25.40, "PAYPAL *CHARTWORKS")
        payment = txn("04/15/2026", "Subscription Payment: Chartworks Ltd", "-20.00", "7GG00000GG0000007",
                      currency="GBP", exchange=("25.40 USD X 0.7874 (Exchange Rate)", "20.00", "GBP"))
        deposit = txn("04/15/2026", "General Credit Card Deposit", "25.40", "8HH00000HH0000008", ref="7GG00000GG0000007")
        pdf = statement_pdf([payment, deposit])
        scan = await self._call(scan_paypal_statements, [FakeUpload("s.pdf", pdf)])
        self.assertEqual(scan["statements"][0]["foreign_count"], 0)

        result = await self._import([FakeUpload("s.pdf", pdf)], {"robin@example.com": self.paypal})
        self.assertEqual((result["batches"][0]["imported"], result["batches"][0]["rejected"]), (2, 0))
        rows = {r["amount"]: r for r in self._rows(self.paypal)}
        self.assertEqual(rows[25.40]["merchant_name"], "Chartworks Ltd")
        fields = {f["header"]: f["value"] for f in json.loads(rows[25.40]["import_evidence_json"])["extra_text_fields"]}
        self.assertEqual(fields["Currency conversion"], "20.00 GBP = 25.40 USD")
        with self._db() as conn:
            money_movement = money_movement_category_id_if_exists(conn)
        self.assertEqual((self._category(rows[-25.40]["id"]), self._category(charge)), (money_movement, money_movement))
        self.assertNotEqual(self._category(rows[25.40]["id"]), money_movement)

    async def test_a_converted_refund_pairs_with_its_payment_though_it_returns_more_than_was_paid(self):
        # Each side converts at its own day's rate. Paired, the refund sits in the payment's category and
        # the difference shows there as a small credit; unpaired, the whole refund would be income.
        subscriptions = self._new_category("Subscriptions")
        with self._db() as conn:
            conn.execute("INSERT INTO category_rule (id, category_id, keyword) VALUES (?, ?, 'chartworks')",
                         (str(uuid.uuid4()), subscriptions))
        payment = txn("04/15/2026", "Subscription Payment: Chartworks Ltd", "-20.00", "7GG00000GG0000007",
                      currency="GBP", exchange=("25.40 USD X 0.7874 (Exchange Rate)", "20.00", "GBP"))
        refund = txn("04/28/2026", "Payment Refund: Chartworks Ltd", "20.00", "6RR00000RR0000006", currency="GBP",
                     ref="7GG00000GG0000007", exchange=("20.00 GBP X 1.2950 (Exchange Rate)", "25.90", "USD"))
        await self._import([FakeUpload("s.pdf", statement_pdf([payment, refund]))], {"robin@example.com": self.paypal})
        rows = {r["amount"]: r["id"] for r in self._rows(self.paypal)}
        self.assertEqual(self._links("refund"), {(rows[25.40], "payment"), (rows[-25.90], "refund")})
        self.assertEqual((self._category(rows[-25.90]), self._source(rows[-25.90])), (subscriptions, "refund"))

    async def test_an_activity_csv_payment_takes_the_amount_of_the_conversion_that_paid_it(self):
        # The CSV records the conversion as two rows of its own at the payment's timestamp; they are carried
        # by the payment, not imported. One payment is card-funded, one paid from the balance; a payout
        # received in another currency and never converted stays refused.
        charge = self._card_charge("2026-04-15", 25.40, "PAYPAL *CHARTWORKS")
        header = ('"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total",'
                  '"Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"')

        def line(time, name, kind, currency, amount, txn_id):
            return (f'"04/15/2026","{time}","EDT","{name}","{kind}","Completed","{currency}","{amount}","0.00",'
                    f'"{amount}","","","0.00","{txn_id}",""')

        lines = [
            line("09:15:00", "Chartworks Ltd", "Subscription Payment", "GBP", "-20.00", "7GG00000GG0000007"),
            line("09:15:00", "", "General Card Deposit", "USD", "25.40", "8HH00000HH0000008"),
            line("09:15:00", "", "General Currency Conversion", "USD", "-25.40", "9CC00000CC0000009"),
            line("09:15:00", "", "General Currency Conversion", "GBP", "20.00", "1CC00000CC0000010"),
            line("14:30:00", "Trail Club", "Donation Payment", "EUR", "-8.50", "2DD00000DD0000011"),
            line("14:30:00", "", "General Currency Conversion", "USD", "-9.35", "3CC00000CC0000012"),
            line("14:30:00", "", "General Currency Conversion", "EUR", "8.50", "4CC00000CC0000013"),
            line("20:00:00", "Robin Vale", "Mass Pay Payment", "HUF", "500.00", "5MM00000MM0000014"),
        ]
        token = set_current_db_path(str(self.db_path))
        try:
            result = run_import_core("\n".join([header, *lines]) + "\n", {
                "account_id": self.paypal, "date_format": "%m/%d/%Y", "amount_convention": "single_signed",
                "column_map": {"date": "Date", "description": "Name", "amount": "Total", "currency": "Currency"},
            }, filename="activity.csv")
        finally:
            reset_current_db_path(token)
        self.assertEqual((result["imported"], result["currency_rejected_count"]), (3, 1))
        rows = {r["amount"]: r for r in self._rows(self.paypal)}
        self.assertEqual(sorted(rows), [-25.40, 9.35, 25.40])
        for amount, conversion in ((25.40, "20.00 GBP = 25.40 USD"), (9.35, "8.50 EUR = 9.35 USD")):
            fields = {f["header"]: f["value"] for f in json.loads(rows[amount]["import_evidence_json"])["extra_text_fields"]}
            self.assertEqual(fields["Currency conversion"], conversion)
        with self._db() as conn:
            money_movement = money_movement_category_id_if_exists(conn)
        self.assertEqual((self._category(rows[-25.40]["id"]), self._category(charge)), (money_movement, money_movement))

    async def test_a_statement_imported_before_is_skipped_however_it_arrives(self):
        pdf = statement_pdf([PAYMENT, DEPOSIT])
        await self._import([FakeUpload("statement-Apr-2026.pdf", pdf)], {"robin@example.com": self.paypal})
        again = await self._import(
            [FakeUpload("statements.zip", zipped(**{"2026/statement-Apr-2026.pdf": pdf, "copy.pdf": pdf}))],
            {"robin@example.com": self.paypal},
        )
        self.assertEqual(again["batches"], [])
        self.assertEqual(again["skipped"], [{"filename": "statement-Apr-2026.pdf", "reason": "already_imported"}])

    async def test_a_month_with_no_activity_makes_no_card(self):
        result = await self._import([FakeUpload("statement-Feb-2026.pdf", statement_pdf([]))],
                                    {"robin@example.com": self.paypal})
        self.assertEqual((result["batches"], result["skipped"]),
                         ([], [{"filename": "statement-Feb-2026.pdf", "reason": "no_activity"}]))

    async def test_statements_stay_with_the_account_they_went_into(self):
        april = statement_pdf([PAYMENT, DEPOSIT])
        await self._import([FakeUpload("april.pdf", april)], {"robin@example.com": self.paypal})
        may = statement_pdf([txn("05/02/2026", "Mobile Payment: Sam Okafor", "-20.00", "9JJ00000JJ0000009")],
                            period=("May 1, 2026 - May 31,", "2026"))
        with self.assertRaises(HTTPException) as other_account:
            await self._import([FakeUpload("may.pdf", may)], {"robin@example.com": self.second_paypal})
        self.assertIn("go into PayPal", other_account.exception.detail["message"])

        sams = statement_pdf([txn("05/03/2026", "Mobile Payment: Robin Vale", "-5.00", "1KK00000KK0000010")],
                             account="sam@example.com", holder="Okafor, Sam", period=("May 1, 2026 - May 31,", "2026"))
        with self.assertRaises(HTTPException) as other_statements:
            await self._import([FakeUpload("sams.pdf", sams)], {"sam@example.com": self.paypal})
        self.assertIn("holds the statements of PayPal account robin@example.com", other_statements.exception.detail["message"])

        scan = await self._call(scan_paypal_statements, [FakeUpload("may.pdf", may)])
        self.assertEqual(scan["accounts"]["robin@example.com"]["account_id"], self.paypal)

    async def test_only_a_paypal_account_takes_statements(self):
        with self.assertRaises(HTTPException) as refused:
            await self._import([FakeUpload("s.pdf", statement_pdf([PAYMENT]))], {"robin@example.com": self.card})
        self.assertIn("not a PayPal account", refused.exception.detail["message"])

    async def test_the_first_activity_csv_gives_a_statement_made_source_its_header(self):
        await self._import([FakeUpload("s.pdf", statement_pdf([PAYMENT, DEPOSIT]))], {"robin@example.com": self.paypal})
        header = ('"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total",'
                  '"Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"')
        line = '"05/02/2026","10:00:00","EDT","Sam Okafor","Mobile Payment","Completed","USD","-20.00","0.00","-20.00","","","0.00","9JJ00000JJ0000009",""'
        token = set_current_db_path(str(self.db_path))
        try:
            run_import_core(f"{header}\n{line}\n", {
                "account_id": self.paypal, "date_format": "%m/%d/%Y", "amount_convention": "single_signed",
                "column_map": {"date": "Date", "description": "Name", "amount": "Total"},
            }, filename="activity.csv")
        finally:
            reset_current_db_path(token)
        with self._db() as conn:
            profiles = conn.execute(
                "SELECT header_fingerprint FROM csv_import_profile WHERE source_kind = ?", (PAYPAL_SOURCE_KIND,)).fetchall()
        self.assertEqual([p["header_fingerprint"].split("|")[0] for p in profiles], ["Date"])
        self.assertIn("Transaction ID", profiles[0]["header_fingerprint"])


if __name__ == "__main__":
    unittest.main()
