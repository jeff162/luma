"""
Part C of PayPal money-movement recognition: the user-approved `Type` → Money movement rules.

`is_money_movement_type` pre-flags a Type; `money_movement_type_proposals` lists a batch's captured Types
with counts for review; `create_money_movement_rules` writes the approved match_source_text rules, and
recategorize routes matching rows (including already-imported ones) into the excluded Money movement
category. Nothing is auto-applied — the rules exist only for Types the caller passes.
"""

from __future__ import annotations

import json
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
from fastapi import HTTPException

from backend.routers.import_export import run_import
from backend.routers.import_export.core import (
    apply_money_movement_rules,
    get_money_movement_types,
    get_profile_money_movement_types,
    apply_profile_money_movement_rules,
    MoneyMovementRulesRequest,
)
from backend.routers.import_export.profiles import delete_profile
from backend.services.money_movement import is_money_movement_type


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self):
        return self._content


# A PayPal export with a hold (money movement), a currency conversion (money movement), and two real
# payments. Amount stored positive = money out (single_signed stores -raw).
PAYPAL_CSV = "\n".join([
    '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"',
    '"2019-12-25","1","PST","","Account Hold for Open Authorization","Completed","USD","-7.00","0","-7.00","","R1","0","T1",""',
    '"2019-12-20","1","PST","","General Currency Conversion","Completed","USD","-3.50","0","-3.50","","R2","0","T2",""',
    '"2019-11-02","1","PST","VeloViewer Ltd","Website Payment","Completed","USD","-10.00","0","-10.00","","R3","0","T3","Bike sub"',
    '"2019-11-05","1","PST","RANDONNEURS USA","General Payment","Completed","USD","-90.00","0","-90.00","","R4","0","T4",""',
])


class PaypalMoneyMovementTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "paypal-mm.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account("PayPal")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                   VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', NULL, ?, NULL, NULL)""",
                (account_id, f"p_{account_id}", name, name, SHARED_OWNER_ID),
            )
        return account_id

    async def _import(self, csv_text=PAYPAL_CSV, filename="Paypal-2019.csv", profile_id=None):
        config = {
            "filename": filename,
            "profile_id": profile_id,
            "account_id": self.account_id,
            "account_map": {},
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Name", "amount": "Amount", "evidence_columns": []},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        with self._use_db_path():
            return await run_import(file=FakeUploadFile(filename, csv_text), config=json.dumps(config))

    def _category_of(self, merchant_type_value):
        # Return (category_name, exclude_from_totals) for the row whose evidence Type == merchant_type_value.
        with self._use_db_path(), get_db() as conn:
            rows = conn.execute(
                "SELECT id, category_id, import_evidence_json FROM txn WHERE trashed_at IS NULL"
            ).fetchall()
            for r in rows:
                ev = json.loads(r["import_evidence_json"] or "{}")
                types = [f.get("value") for f in ev.get("extra_text_fields", []) if str(f.get("header", "")).lower() == "type"]
                if merchant_type_value in types:
                    if not r["category_id"]:
                        return (None, None)
                    cat = conn.execute(
                        "SELECT name, COALESCE((SELECT exclude_from_totals FROM category p WHERE p.id = c.parent_id), c.exclude_from_totals, 0) AS excl FROM category c WHERE c.id = ?",
                        (r["category_id"],),
                    ).fetchone()
                    return (cat["name"], cat["excl"])
        return ("__missing__", None)

    def test_is_money_movement_type_fragments(self):
        for t in ["Bank Deposit to PP Account", "General Withdrawal", "Account Hold for Open Authorization",
                  "Reversal of General Account Hold", "General Currency Conversion", "eCheck Deposit"]:
            self.assertTrue(is_money_movement_type(t), t)
        for t in ["Express Checkout Payment", "Website Payment", "General Payment", "Payment Refund", ""]:
            self.assertFalse(is_money_movement_type(t), t)

    async def test_proposals_flag_money_movement_types_first(self):
        result = await self._import()
        self.assertTrue(result["is_paypal"])
        with self._use_db_path(), get_db() as conn:
            data = get_money_movement_types(result["batch_id"])
        by_type = {p["type"]: p for p in data["proposals"]}
        self.assertTrue(by_type["Account Hold for Open Authorization"]["money_movement"])
        self.assertTrue(by_type["General Currency Conversion"]["money_movement"])
        self.assertFalse(by_type["Website Payment"]["money_movement"])
        self.assertFalse(by_type["General Payment"]["money_movement"])
        # Money-movement types sort ahead of payments.
        self.assertTrue(data["proposals"][0]["money_movement"])

    async def test_approved_types_route_rows_to_excluded_money_movement(self):
        result = await self._import()
        # Nothing is money-movement-categorized until the user approves.
        self.assertEqual(self._category_of("Account Hold for Open Authorization"), (None, None))

        with self._use_db_path():
            applied = apply_money_movement_rules(
                result["batch_id"],
                MoneyMovementRulesRequest(add=["Account Hold for Open Authorization", "General Currency Conversion"]),
            )
        self.assertEqual(applied["created"], 2)

        # The approved money-movement rows now sit in the excluded "Money movement" category...
        hold_cat, hold_excl = self._category_of("Account Hold for Open Authorization")
        self.assertEqual(hold_cat, "Money movement")
        self.assertEqual(hold_excl, 1)
        self.assertEqual(self._category_of("General Currency Conversion")[0], "Money movement")
        # ...and the real payments are untouched (not routed anywhere by these rules).
        self.assertNotEqual(self._category_of("Website Payment")[0], "Money movement")
        self.assertNotEqual(self._category_of("General Payment")[0], "Money movement")

    async def test_create_rules_is_idempotent(self):
        result = await self._import()
        with self._use_db_path():
            first = apply_money_movement_rules(result["batch_id"], MoneyMovementRulesRequest(add=["General Withdrawal"]))
            second = apply_money_movement_rules(result["batch_id"], MoneyMovementRulesRequest(add=["General Withdrawal"]))
        self.assertEqual(first["created"], 1)
        self.assertEqual(second["created"], 0)

    async def test_rules_are_scoped_to_the_paypal_account(self):
        # The created rule carries the PayPal account id, so a same-text transaction on another account
        # can never match it.
        result = await self._import()
        other_account = self._insert_account("Northgate Checking")
        with self._use_db_path(), get_db() as conn:
            # A checking transaction whose text contains the same Type string.
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending, import_evidence_json)
                   VALUES (?, ?, ?, 5.00, 'ACME', 'ACME', 'ACME', '2019-12-25', 0, ?)""",
                (str(uuid.uuid4()), other_account, SHARED_OWNER_ID,
                 json.dumps({"extra_text_fields": [{"header": "Type", "value": "General Withdrawal"}]})),
            )
        with self._use_db_path(), get_db() as conn:
            apply_money_movement_rules(result["batch_id"], MoneyMovementRulesRequest(add=["General Withdrawal"]))
            rule = conn.execute("SELECT account_id FROM category_rule WHERE keyword = 'general withdrawal'").fetchone()
            self.assertEqual(rule["account_id"], self.account_id)
        # The checking row (same Type text, different account) is not routed to Money movement.
        with self._use_db_path(), get_db() as conn:
            other = conn.execute(
                "SELECT category_id FROM txn WHERE account_id = ? AND merchant_name = 'ACME'", (other_account,)
            ).fetchone()
        self.assertIsNone(other["category_id"])

    async def test_paypal_import_attaches_to_a_single_system_data_source(self):
        first = await self._import()
        with self._use_db_path(), get_db() as conn:
            profile = conn.execute("SELECT id, name, source_kind FROM csv_import_profile WHERE source_kind = ?", ("source:paypal",)).fetchone()
            self.assertIsNotNone(profile)
            self.assertEqual(profile["name"], "PayPal")
            batch = conn.execute("SELECT profile_id FROM import_batch WHERE id = ?", (first["batch_id"],)).fetchone()
            self.assertEqual(batch["profile_id"], profile["id"])

        # A second, distinct PayPal import reuses the same source (not a second one).
        second_csv = PAYPAL_CSV.replace("2019-11-02", "2020-11-02").replace("VeloViewer Ltd", "Strava Inc")
        await self._import(csv_text=second_csv, filename="Paypal-2020.csv")
        with self._use_db_path(), get_db() as conn:
            count = conn.execute("SELECT COUNT(*) c FROM csv_import_profile WHERE source_kind = ?", ("source:paypal",)).fetchone()["c"]
        self.assertEqual(count, 1)

    async def test_profile_scoped_review_spans_all_imports(self):
        # Two distinct PayPal imports under the one source; the source-level review unions their Types and
        # approving routes rows from *both* imports to Money movement.
        await self._import()  # has the hold + currency conversion
        second_csv = "\n".join([
            '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"',
            '"2020-06-01","1","PST","","General Withdrawal","Completed","USD","-25.00","0","-25.00","","R9","0","T9",""',
        ])
        await self._import(csv_text=second_csv, filename="Paypal-2020.csv")
        with self._use_db_path(), get_db() as conn:
            profile_id = conn.execute("SELECT id FROM csv_import_profile WHERE source_kind = ?", ("source:paypal",)).fetchone()["id"]
            proposals = {p["type"]: p for p in get_profile_money_movement_types(profile_id)["proposals"]}
        # Types from both imports are present in the one review.
        self.assertIn("Account Hold for Open Authorization", proposals)   # from file 1
        self.assertIn("General Withdrawal", proposals)                    # from file 2

        with self._use_db_path():
            apply_profile_money_movement_rules(profile_id, MoneyMovementRulesRequest(add=["Account Hold for Open Authorization", "General Withdrawal"]))
        self.assertEqual(self._category_of("Account Hold for Open Authorization")[0], "Money movement")
        self.assertEqual(self._category_of("General Withdrawal")[0], "Money movement")

    async def test_user_selected_paypal_source_is_adopted_as_system(self):
        # A hand-created source (untagged) selected for a PayPal import is adopted — tagged source:paypal —
        # so it gets the same treatment as an auto-created one, and no second source is created.
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO csv_import_profile (id, name) VALUES ('u1', 'My PayPal')")
        await self._import(profile_id="u1")
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(conn.execute("SELECT source_kind FROM csv_import_profile WHERE id = 'u1'").fetchone()["source_kind"], "source:paypal")
            self.assertEqual(conn.execute("SELECT COUNT(*) c FROM csv_import_profile WHERE source_kind = 'source:paypal'").fetchone()["c"], 1)

    async def test_system_paypal_source_cannot_be_deleted(self):
        await self._import()
        with self._use_db_path(), get_db() as conn:
            profile_id = conn.execute("SELECT id FROM csv_import_profile WHERE source_kind = ?", ("source:paypal",)).fetchone()["id"]
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                delete_profile(profile_id)
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_empty_account_scope_creates_no_global_rule(self):
        # A rule with account_id NULL would be global — the opposite of the account-scoping intent. An empty
        # account set must create nothing rather than a silent global rule.
        from backend.services.money_movement import create_money_movement_rules
        with self._use_db_path(), get_db() as conn:
            created = create_money_movement_rules(conn, ["General Withdrawal"], [])
            self.assertEqual(created, 0)
            self.assertIsNone(conn.execute("SELECT 1 FROM category_rule WHERE keyword = 'general withdrawal'").fetchone())

    async def test_matcher_collision_with_a_user_rule_does_not_fork(self):
        # A user rule already owns the (keyword, account, source-text) matcher pointing at a different
        # category. Creating a money-movement rule for the same Type must NOT fork a second rule with that
        # matcher (which would make "which rule wins" order-dependent) — it skips instead.
        from backend.services.money_movement import create_money_movement_rules
        result = await self._import()
        account_ids = [self.account_id]
        with self._use_db_path(), get_db() as conn:
            # Seed a user rule with the same matcher (keyword+account+source-text) but a different category.
            other_leaf = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'Misc Grp', 'expense')", (str(uuid.uuid4()),))
            grp = conn.execute("SELECT id FROM category WHERE name = 'Misc Grp'").fetchone()["id"]
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'Misc Leaf', 'expense')", (other_leaf, grp))
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, account_id, match_source_text) VALUES (?, ?, 'general withdrawal', ?, 1)",
                (str(uuid.uuid4()), other_leaf, self.account_id),
            )
            created = create_money_movement_rules(conn, ["General Withdrawal"], account_ids)
            self.assertEqual(created, 0, "must not fork a second rule with an existing matcher")
            n = conn.execute(
                "SELECT COUNT(*) c FROM category_rule WHERE keyword = 'general withdrawal' AND account_id = ? AND match_source_text = 1",
                (self.account_id,),
            ).fetchone()["c"]
            self.assertEqual(n, 1, "the matcher still has exactly one rule")

    async def test_already_ruled_and_remove_round_trip(self):
        result = await self._import()
        with self._use_db_path():
            apply_money_movement_rules(result["batch_id"], MoneyMovementRulesRequest(add=["Account Hold for Open Authorization"]))
        # The proposal for that type now reports it's already ruled.
        with self._use_db_path(), get_db() as conn:
            proposals = {p["type"]: p for p in get_money_movement_types(result["batch_id"])["proposals"]}
        self.assertTrue(proposals["Account Hold for Open Authorization"]["already_ruled"])
        self.assertFalse(proposals["General Currency Conversion"]["already_ruled"])
        self.assertEqual(self._category_of("Account Hold for Open Authorization")[0], "Money movement")

        # Changed my mind: remove it → recategorized back out of Money movement.
        with self._use_db_path():
            removed = apply_money_movement_rules(result["batch_id"], MoneyMovementRulesRequest(remove=["Account Hold for Open Authorization"]))
        self.assertEqual(removed["deleted"], 1)
        self.assertNotEqual(self._category_of("Account Hold for Open Authorization")[0], "Money movement")


if __name__ == "__main__":
    unittest.main()
