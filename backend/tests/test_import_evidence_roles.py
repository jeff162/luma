"""
Evidence-column roles: which unmapped columns get captured as import evidence, and how each is
classified so the fuzzy duplicate text-matcher stays clean.

A captured column is one of two shapes:
  * descriptive free text (memos, item titles, counterparty names) — high cardinality; an exact/near
    match between two rows is meaningful, so it may feed the duplicate text-matcher.
  * categorical vocabulary (transaction type, status, currency) — a small repeated set; two unrelated
    rows share the identical value, so it must NOT feed the matcher (it would manufacture duplicates),
    though it still feeds the hover, rules, and enrich.

The role is inferred from the column's cardinality across the file and stamped on each captured field;
collect_duplicate_match_texts consumes only descriptive fields. Columns are captured from the keyword
auto-detect (capped) plus the user's explicit `evidence_columns` picks (honored over the cap).
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
from backend.routers.import_export import run_import
from backend.services.duplicate_detection import collect_duplicate_match_texts
from backend.routers.import_export.core import (
    EVIDENCE_ROLE_CATEGORICAL,
    EVIDENCE_ROLE_DESCRIPTIVE,
    MAX_IMPORT_EVIDENCE_TEXT_FIELDS,
    ColumnMap,
    _build_evidence_column_plan,
    _classify_evidence_column_role,
    _forced_evidence_headers,
    sniff_paypal_activity,
)

# The real PayPal Activity export header (data/paypal/, identical across years). The leading BOM on the
# first column is deliberately included — the sniff must tolerate it.
PAYPAL_HEADERS = [
    "﻿Date", "Time", "TimeZone", "Name", "Type", "Status", "Currency", "Amount", "Fees",
    "Total", "Exchange Rate", "Receipt ID", "Balance", "Transaction ID", "Item Title",
]


def _plan(rows, headers, col):
    """The plan for a file, recognized as PayPal the way the CSV front end recognizes it."""
    return _build_evidence_column_plan(rows, headers, col, is_paypal=sniff_paypal_activity(headers))


class ClassifyEvidenceColumnRoleTests(unittest.TestCase):
    def test_low_cardinality_repeated_column_is_categorical(self):
        # PayPal "Type" shape: many rows, few heavily-repeated values.
        values = (["Bank Deposit to PP Account"] * 13) + (["General Withdrawal"] * 13) + (["Mobile Payment"] * 32)
        self.assertEqual(_classify_evidence_column_role(values), EVIDENCE_ROLE_CATEGORICAL)

    def test_all_distinct_column_is_descriptive(self):
        # PayPal "Item Title" shape: every populated value distinct.
        values = [f"Order item {n}" for n in range(9)]
        self.assertEqual(_classify_evidence_column_role(values), EVIDENCE_ROLE_DESCRIPTIVE)

    def test_moderate_cardinality_column_is_descriptive(self):
        # "Name" shape: 16 distinct across 28 nonempty — above the categorical distinct ceiling.
        values = [f"Person {n}" for n in range(16)] + [f"Person {n}" for n in range(12)]
        self.assertEqual(len(values), 28)
        self.assertEqual(_classify_evidence_column_role(values), EVIDENCE_ROLE_DESCRIPTIVE)

    def test_tiny_sample_defaults_to_descriptive(self):
        # Two distinct in three rows barely repeats; too little signal to call it a vocabulary.
        self.assertEqual(_classify_evidence_column_role(["A", "A", "B"]), EVIDENCE_ROLE_DESCRIPTIVE)

    def test_empty_column_is_descriptive(self):
        self.assertEqual(_classify_evidence_column_role(["", "", ""]), EVIDENCE_ROLE_DESCRIPTIVE)


class BuildEvidenceColumnPlanTests(unittest.TestCase):
    def _col(self, **kw):
        base = {"date": "Date", "description": "Description", "amount": "Amount"}
        base.update(kw)
        return ColumnMap(**base)

    def test_keyword_columns_auto_captured_when_no_explicit_list(self):
        # evidence_columns is None (legacy/API path) -> zero-effort keyword auto-detect.
        headers = ["Date", "Description", "Amount", "Memo", "Notes"]
        rows = [{"Memo": "streaming", "Notes": "cancel soon"}]
        plan = _plan(rows, headers, self._col())
        self.assertEqual({h for h, _ in plan}, {"Memo", "Notes"})

    def test_explicit_list_is_authoritative(self):
        # An explicit list captures exactly its columns and nothing else — a keyword column left off
        # the list (the user unchecked it) is not captured.
        headers = ["Date", "Description", "Amount", "Memo", "Item Title"]
        rows = [{"Memo": "streaming", "Item Title": "Concert tix"}]
        plan = _plan(rows, headers, self._col(evidence_columns=["Item Title"]))
        captured = {h for h, _ in plan}
        self.assertEqual(captured, {"Item Title"})
        self.assertNotIn("Memo", captured, "an unchecked keyword column must not sneak back in")

    def test_empty_explicit_list_captures_nothing(self):
        # The user unchecked everything -> capture nothing (distinct from None, which auto-detects).
        headers = ["Date", "Description", "Amount", "Memo", "Notes"]
        rows = [{"Memo": "x", "Notes": "y"}]
        self.assertEqual(_plan(rows, headers, self._col(evidence_columns=[])), [])

    def test_explicit_list_is_not_capped(self):
        # Explicit picks are the user's resolved choice, so the keyword cap doesn't apply.
        picks = ["Memo", "Notes", "Narrative", "Particulars", "Remittance", "Reference", "Payee"]
        headers = ["Date", "Description", "Amount", *picks]
        rows = [{h: f"val {h}" for h in picks}]
        plan = _plan(rows, headers, self._col(evidence_columns=picks))
        self.assertEqual(len(plan), len(picks))
        self.assertGreater(len(plan), MAX_IMPORT_EVIDENCE_TEXT_FIELDS)

    def test_reserved_headers_never_captured(self):
        headers = ["Date", "Description", "Amount", "Notes"]
        # Even if the user names a mapped column, it isn't duplicated into evidence.
        plan = _plan([{"Notes": "x"}], headers, self._col(notes="Notes", evidence_columns=["Notes", "Amount"]))
        self.assertEqual(plan, [])

    def test_explicit_categorical_pick_gets_categorical_role(self):
        headers = ["Date", "Description", "Amount", "Type"]
        rows = [{"Type": v} for v in (["Deposit"] * 4 + ["Withdrawal"] * 4)]
        plan = dict(_plan(rows, headers, self._col(evidence_columns=["Type"])))
        self.assertEqual(plan.get("Type"), EVIDENCE_ROLE_CATEGORICAL)

    def test_paypal_type_and_item_title_forced_even_when_unchecked(self):
        # The user unchecked everything for a PayPal file — Type/Item Title are still captured, because
        # money-movement categorization + enrichment depend on them.
        rows = [{"Type": "Bank Deposit to PP Account", "Item Title": "Concert tix", "Name": "x"}]
        plan = dict(_plan(rows, PAYPAL_HEADERS, self._col(evidence_columns=[])))
        self.assertIn("Type", plan)
        self.assertIn("Item Title", plan)

    def test_paypal_type_forced_even_when_keyword_autodetect_misses_it(self):
        # None path (keyword auto-detect): Type isn't a keyword, but a PayPal file still captures it.
        rows = [{"Type": "General Withdrawal", "Item Title": ""}]
        plan = dict(_plan(rows, PAYPAL_HEADERS, self._col()))
        self.assertIn("Type", plan)
        self.assertIn("Item Title", plan)

    def test_non_paypal_file_does_not_force_type(self):
        # A bank CSV that happens to have a Type column, unchecked, must NOT get it forced in.
        headers = ["Date", "Description", "Amount", "Type"]
        rows = [{"Type": "DEBIT"}]
        plan = dict(_plan(rows, headers, self._col(evidence_columns=[])))
        self.assertEqual(plan, {})

    def test_forced_transaction_id_is_categorical_although_every_value_differs(self):
        # Measured, a column unique on every row reads as descriptive text and would feed duplicate
        # matching; an opaque identifier names nothing, so its role is declared.
        rows = [{"Type": "Mobile Payment", "Transaction ID": f"{i}AB00000CD000000{i}"} for i in range(8)]
        plan = dict(_plan(rows, PAYPAL_HEADERS, self._col(evidence_columns=[])))
        self.assertEqual(plan.get("Transaction ID"), EVIDENCE_ROLE_CATEGORICAL)

    def test_forced_type_keeps_its_categorical_role(self):
        rows = [{"Type": v, "Item Title": f"t{i}"} for i, v in enumerate(["Deposit"] * 4 + ["Withdrawal"] * 4)]
        plan = dict(_plan(rows, PAYPAL_HEADERS, self._col(evidence_columns=[])))
        self.assertEqual(plan.get("Type"), EVIDENCE_ROLE_CATEGORICAL)


class PaypalSourceRecognitionTests(unittest.TestCase):
    def test_sniffs_the_paypal_activity_header(self):
        self.assertTrue(sniff_paypal_activity(PAYPAL_HEADERS))

    def test_rejects_a_bank_or_amazon_header(self):
        self.assertFalse(sniff_paypal_activity(["Date", "Description", "Account", "Amount", "Category"]))
        self.assertFalse(sniff_paypal_activity(["order id", "items", "total", "payments"]))
        self.assertFalse(sniff_paypal_activity([]))

    def test_forced_evidence_headers_only_for_paypal(self):
        self.assertEqual(_forced_evidence_headers(PAYPAL_HEADERS, True), ["Type", "Transaction ID", "Item Title"])
        self.assertEqual(_forced_evidence_headers(["Date", "Type", "Item Title", "Amount"], False), [])


class CollectDuplicateMatchTextsTests(unittest.TestCase):
    def test_categorical_field_excluded_descriptive_and_unmarked_included(self):
        evidence = {
            "description": {"header": "Name", "value": "Robin Vale"},
            "extra_text_fields": [
                {"header": "Item Title", "value": "Concert tix"},                       # descriptive (unmarked)
                {"header": "Memo", "value": "gift", "role": "descriptive"},           # explicit descriptive
                {"header": "Type", "value": "Bank Deposit", "role": "categorical"},   # excluded
            ],
        }
        texts = collect_duplicate_match_texts(
            merchant_name="Robin Vale", display_name="Robin Vale", raw_name=None, import_evidence=evidence
        )
        self.assertIn("Concert tix", texts)
        self.assertIn("gift", texts)
        self.assertNotIn("Bank Deposit", texts)


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self, size: int = -1):
        return self._content


class ExplicitCaptureEndToEndTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "evidence-roles.db"
        init_db(str(self.db_path))

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
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", "fixture_import", name, name, SHARED_OWNER_ID),
                )
        return account_id

    async def _run_import(self, csv_text, account_map, evidence_columns=None):
        column_map = {"date": "Date", "description": "Name", "account": "Account", "amount": "Amount"}
        if evidence_columns is not None:
            column_map["evidence_columns"] = evidence_columns
        config = {
            "filename": "fixture.csv",
            "account_map": account_map,
            "column_map": column_map,
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
        }
        with self._use_db_path():
            return await run_import(file=FakeUploadFile("fixture.csv", csv_text), config=json.dumps(config))

    def _all_evidence(self):
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute("SELECT import_evidence_json FROM txn").fetchall()
        return [json.loads(r["import_evidence_json"]) for r in rows if r["import_evidence_json"]]

    async def test_explicit_pick_captured_and_categorical_role_stamped(self):
        account_id = self._insert_account("Checking")
        # A descriptive "Item Title" (all distinct) and a categorical "Type" (repeated) are both picked.
        lines = ["Date,Name,Account,Amount,Type,Item Title"]
        for n in range(6):
            kind = "Bank Deposit" if n % 2 == 0 else "General Withdrawal"
            lines.append(f"2026-01-0{n + 1},Party {n},Checking,{10 + n}.00,{kind},Item {n}")
        await self._run_import("\n".join(lines), {"Checking": account_id}, evidence_columns=["Type", "Item Title"])

        evidences = self._all_evidence()
        self.assertEqual(len(evidences), 6)
        for evidence in evidences:
            fields = {f["header"]: f for f in evidence.get("extra_text_fields", [])}
            self.assertIn("Item Title", fields)
            self.assertIn("Type", fields)
            # Descriptive stays unmarked (lean shape); categorical is stamped so the matcher skips it.
            self.assertNotIn("role", fields["Item Title"])
            self.assertEqual(fields["Type"].get("role"), EVIDENCE_ROLE_CATEGORICAL)


if __name__ == "__main__":
    unittest.main()
