"""
Duplicate-detection integration coverage for CSV import.

These tests run anonymized fixture CSVs through the real import endpoint logic so
coverage-window dedupe, terminal-day reconciliation, exact-match blocking, and
cross-source text matching are exercised together. The assertions combine batch
counts/reasons with a normalized export-style ledger snapshot so regressions show
up even when the high-level counts still look plausible.
"""

from __future__ import annotations

import csv
import io
import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import UploadFile

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from fastapi import HTTPException

from backend.routers.import_export import (
    BatchCreateProfileRequest,
    BatchDuplicateReviewRequest,
    create_profile_from_batch,
    get_batch_duplicates,
    make_hash,
    mark_batch_duplicates_reviewed,
    run_import,
    undo_batch,
)
from backend.services.duplicate_detection import list_unified_batch_duplicates


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "import_duplicates"


class ImportDuplicateDetectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "duplicate-tests.db"
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

    def _fixture_text(self, name: str) -> str:
        return (FIXTURE_DIR / name).read_text(encoding="utf-8")

    async def _run_import_fixture(self, fixture_name: str, config: dict) -> dict:
        content = self._fixture_text(fixture_name).encode("utf-8")
        upload = UploadFile(filename=fixture_name, file=io.BytesIO(content))
        with self._use_db_path():
            return await run_import(file=upload, config=json.dumps(config))

    def _get_duplicates(self, batch_id: str) -> dict:
        with self._use_db_path():
            return get_batch_duplicates(batch_id)

    def _undo_batch(self, batch_id: str) -> dict:
        with self._use_db_path():
            return undo_batch(batch_id)

    def _insert_account(
        self,
        name: str,
        *,
        account_type: str,
        mask: str | None = None,
        display_name: str | None = None,
        parent_account_id: str | None = None,
    ) -> str:
        account_id = str(uuid.uuid4())
        subtype = {
            "credit": "credit_card",
            "savings": "savings",
            "investment": "brokerage",
            "loan": "loan",
            "p2p": "p2p",
            "other": "other",
        }.get(account_type, "checking")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        account_id,
                        f"test_{account_id}",
                        "fixture_import",
                        name,
                        display_name or name,
                        account_type,
                        subtype,
                        mask,
                        SHARED_OWNER_ID,
                        parent_account_id,
                    ),
                )
        return account_id

    def _insert_existing_transaction(
        self,
        *,
        account_id: str,
        date: str,
        amount: float,
        merchant_name: str,
        raw_name: str | None = None,
        display_name: str | None = None,
    ) -> str:
        txn_id = str(uuid.uuid4())
        raw_value = raw_name or merchant_name
        display_value = display_name or merchant_name
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending, content_hash, import_batch_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)
                    """,
                    (
                        txn_id,
                        account_id,
                        SHARED_OWNER_ID,
                        amount,
                        merchant_name,
                        display_value,
                        raw_value,
                        date,
                        make_hash(date, amount, merchant_name),
                    ),
                )
        return txn_id

    def _account_mapping_config(
        self,
        *,
        headers: dict[str, str],
        account_map: dict[str, str],
    ) -> dict:
        column_map = {
            "date": headers["date"],
            "description": headers["description"],
            "account": headers["account"],
            "amount": headers["amount"],
        }
        if headers.get("category"):
            column_map["category"] = headers["category"]
        if headers.get("notes"):
            column_map["notes"] = headers["notes"]
        return {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "single_account_new": None,
            "account_map": account_map,
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": column_map,
            "date_format": headers.get("date_format", "%Y-%m-%d"),
            "amount_convention": headers.get("amount_convention", "single_signed"),
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }

    def _ledger_snapshot(self) -> list[dict[str, str]]:
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    """
                    SELECT
                      t.date AS date,
                      COALESCE(t.display_name, t.merchant_name, t.raw_name) AS merchant,
                      printf('%.2f', t.amount) AS amount,
                      COALESCE(a.display_name, a.name) AS account
                    FROM txn t
                    JOIN account a ON a.id = t.account_id
                    WHERE t.is_pending = 0
                    ORDER BY t.date, account, merchant, t.amount, t.id
                    """
                ).fetchall()
        return [dict(row) for row in rows]

    def _expected_snapshot(self, fixture_name: str) -> list[dict[str, str]]:
        with (FIXTURE_DIR / fixture_name).open("r", encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))

    def _imported_dedupe_states(self, batch_id: str) -> dict[str, dict]:
        """Dedupe state of every row this batch inserted, keyed by account_id (one row per
        account in the fixtures below)."""
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    """
                    SELECT account_id, suspect_duplicate_of, suspect_duplicate_reason,
                           suspect_resolved_at, trashed_at, rejection_reason, dedupe_resolved_by
                    FROM   txn
                    WHERE  import_batch_id = ?
                    """,
                    (batch_id,),
                ).fetchall()
        return {row["account_id"]: dict(row) for row in rows}

    async def test_coverage_window_and_terminal_day_reconciliation(self):
        # The base file spans 11/25–12/08 so that it has BOTH halves to exercise: a fully-covered
        # stretch (through 12/01) and a soft trailing window (12/02–12/08, the source's declared lag).
        # A file shorter than its own lag establishes no coverage at all — correct, and the subject of
        # its own test below — but it cannot exercise the interaction between the two halves.
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")

        prior_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )
        result_one = await self._run_import_fixture("duplicate_prior_base.csv", prior_config)
        self.assertEqual(result_one["imported"], 10)
        self.assertEqual(result_one["deduped"], 0)

        new_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CREDIT CARD (...1234)": rewards_id},
        )
        result_two = await self._run_import_fixture("duplicate_new_overlap.csv", new_config)
        self.assertEqual(result_two["imported"], 1)
        self.assertEqual(result_two["deduped"], 4)

        duplicates = self._get_duplicates(result_two["batch_id"])
        reasons = [row["reason"] for row in duplicates["rows"]]
        self.assertEqual(sum("Falls within the fully covered date range" in reason for reason in reasons), 2)
        self.assertEqual(sum("terminal covered day" in reason for reason in reasons), 2)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_coverage_terminal_ledger.csv"))

    async def test_covered_day_beats_exact_match(self):
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")

        base_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )
        await self._run_import_fixture("duplicate_prior_base.csv", base_config)

        exact_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CREDIT CARD (...1234)": rewards_id},
        )
        result = await self._run_import_fixture("duplicate_new_exact.csv", exact_config)
        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["deduped"], 1)

        duplicates = self._get_duplicates(result["batch_id"])
        self.assertEqual(len(duplicates["rows"]), 1)
        # Coverage runs before exact-hash: the row is both an exact match and inside the account's
        # already-covered range (re-imported under a different source label), both hard-rejects, so
        # coverage wins the broader, more useful label rather than "exact match".
        self.assertEqual(
            duplicates["rows"][0]["reason"],
            "Falls within the fully covered date range from an earlier import in this account scope",
        )
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_prior_base_ledger.csv"))

    async def test_a_late_arriving_row_near_a_prior_files_last_date_still_imports(self):
        # The behavior the trailing window exists for, stated as the user meets it: a source's last
        # days are the ones it is most likely to be behind on, so a row turning up there in a later
        # file is more likely to be one the first export had not caught yet than a duplicate.
        #
        # The row here is deliberately one the *other* safeguard cannot rescue, since otherwise this
        # would pass with or without the window and prove nothing. A named row inside a covered range
        # that matches nothing at all already falls through and imports (`_coverage_reject_verdict`).
        # What that escape does not cover is a row colliding with a **coincidental same-amount** row —
        # here a $41.02 gas fill a day earlier — which is enough to reject it and file it under
        # "covered, no specific match". Verified against the old default: at a window of 1 this row is
        # hard-rejected, and only the $41.02 collision makes it so.
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")
        prior_config = self._account_mapping_config(
            headers={"date": "Date", "description": "Description", "account": "Account",
                     "amount": "Amount", "category": "Category", "date_format": "%m/%d/%Y"},
            account_map={"Travel Rewards": rewards_id},
        )
        await self._run_import_fixture("duplicate_prior_base.csv", prior_config)

        late_row = (
            "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner\n"
            "2025-12-04,Corner Deli,Dining,CREDIT CARD (...1234),CORNER DELI,,-41.02,,Alex\n"
        )
        upload = UploadFile(filename="late_arrival.csv", file=io.BytesIO(late_row.encode("utf-8")))
        new_config = self._account_mapping_config(
            headers={"date": "Date", "description": "Merchant", "account": "Account",
                     "amount": "Amount", "category": "Category", "notes": "Notes",
                     "date_format": "%Y-%m-%d"},
            account_map={"CREDIT CARD (...1234)": rewards_id},
        )
        with self._use_db_path():
            result = await run_import(file=upload, config=json.dumps(new_config))

        self.assertEqual(result["imported"], 1, "a row the earlier export had not caught yet must import")
        self.assertEqual(result["deduped"], 0)

    async def test_a_genuine_duplicate_inside_that_window_is_still_caught(self):
        # The other half, and the reason widening is cheap: the trailing window does not stop checking,
        # it stops rejecting *on the date alone*. A row that really does match a prior one is still
        # reconciled against it one-to-one — by name, which is a better answer than "date covered".
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")
        prior_config = self._account_mapping_config(
            headers={"date": "Date", "description": "Description", "account": "Account",
                     "amount": "Amount", "category": "Category", "date_format": "%m/%d/%Y"},
            account_map={"Travel Rewards": rewards_id},
        )
        await self._run_import_fixture("duplicate_prior_base.csv", prior_config)

        repeat = (
            "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner\n"
            "2025-12-05,Blue Bottle Coffee,Dining,CREDIT CARD (...1234),BLUE BOTTLE,,-6.75,,Alex\n"
        )
        upload = UploadFile(filename="repeat.csv", file=io.BytesIO(repeat.encode("utf-8")))
        new_config = self._account_mapping_config(
            headers={"date": "Date", "description": "Merchant", "account": "Account",
                     "amount": "Amount", "category": "Category", "notes": "Notes",
                     "date_format": "%Y-%m-%d"},
            account_map={"CREDIT CARD (...1234)": rewards_id},
        )
        with self._use_db_path():
            result = await run_import(file=upload, config=json.dumps(new_config))

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["deduped"], 1)

    async def test_cross_source_text_match_without_coverage_window(self):
        checking_id = self._insert_account("Home Checking", account_type="depository", mask="4321")
        self._insert_existing_transaction(
            account_id=checking_id,
            date="2025-12-03",
            amount=125.00,
            merchant_name="PAYPAL INST XFER CLEANING CREW",
            raw_name="PAYPAL INST XFER CLEANING CREW",
            display_name="PAYPAL INST XFER CLEANING CREW",
        )

        config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CHECKING (...4321)": checking_id},
        )
        result = await self._run_import_fixture("duplicate_new_text_match.csv", config)
        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["deduped"], 1)

        duplicates = self._get_duplicates(result["batch_id"])
        self.assertEqual(len(duplicates["rows"]), 1)
        self.assertIn("Possible cross-source match by date, amount, and source text", duplicates["rows"][0]["reason"])
        self.assertEqual(
            self._ledger_snapshot(),
            [
                {
                    "date": "2025-12-03",
                    "merchant": "PAYPAL INST XFER CLEANING CREW",
                    "amount": "125.00",
                    "account": "Home Checking",
                }
            ],
        )

    # ---- coverage from a data connection, applied to a CSV import -------
    # `build_dedupe_context` reads the UNION of the two coverage shapes, so a file and a connection
    # reject each other's re-ingested rows symmetrically. The sync direction (a synced row rejected by a
    # file's coverage) is pinned in test_sync_dedupe; this is the other direction, where the claim lives
    # on connection_account and the incoming rows come from a CSV.

    def _connection_with_coverage(self, account_id, *, mode="existing", covers=("2025-11-01", "2025-12-08")):
        """A connection that has already backfilled `account_id` and claims coverage over `covers`.

        The mode is what decides whether that claim can bear on a CSV import at all: 'existing' says
        this provider account IS the local account the file is landing in, which is the alias the
        cross-account coverage rule requires. 'new' points the connection at an account of its own.
        """
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential, institution)"
                    " VALUES ('conn-1', 'plaid', 'item-1', '', 'Example Bank')"
                )
                conn.execute(
                    """
                    INSERT INTO connection_account
                      (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                       provider_name, provider_mask, coverage_start_date, coverage_through_date)
                    VALUES ('conn-1', 'ext-card', ?, ?, ?, 'CREDIT CARD', '6612', ?, ?)
                    """,
                    (account_id, mode, account_id if mode == "existing" else None, covers[0], covers[1]),
                )

    def _connection_covered_config(self, card_id):
        return self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CREDIT CARD (...6612)": card_id},
        )

    def _seed_synced_rows(self, card_id):
        """The two rows the connection already pulled, and the twins the rejected CSV rows must name.
        Stored positive because these are charges — the file's `-19.99` lands here as `19.99`."""
        return {
            "amazon": self._insert_existing_transaction(
                account_id=card_id, date="2025-11-20", amount=19.99, merchant_name="AMAZON MKTPLACE"),
            "netflix": self._insert_existing_transaction(
                account_id=card_id, date="2025-11-28", amount=7.99, merchant_name="NETFLIX.COM"),
        }

    async def test_a_csv_row_inside_a_connections_covered_range_is_rejected(self):
        # Coverage runs 11/01–12/08, and the connection's own 7-day lag makes 12/02–12/08 soft, so the
        # fully-covered stretch ends 12/01. The file's 11/20 and 11/28 rows are inside it and are the
        # provider's rows arriving a second time through a file; 12/05 (inside the soft trailing edge)
        # and 12/12 (past the claim entirely) are not covered and must land.
        card_id = self._insert_account("Northgate Voyager", account_type="credit", mask="6612")
        synced = self._seed_synced_rows(card_id)
        self._connection_with_coverage(card_id)

        result = await self._run_import_fixture(
            "duplicate_connection_covered.csv", self._connection_covered_config(card_id))
        self.assertEqual(result["imported"], 2)
        self.assertEqual(result["deduped"], 2)

        duplicates = self._get_duplicates(result["batch_id"])
        for row in duplicates["rows"]:
            self.assertEqual(
                row["reason"],
                "Falls within the fully covered date range from an earlier import in this account scope",
            )
        # Each rejection names the synced row it duplicates rather than reading "no specific match":
        # the connection's rows are ordinary ledger rows, so the candidate lookup finds them normally.
        matched_ids = {
            c["id"] for row in duplicates["rows"]
            for c in (row["matched_transaction"].get("candidates") or [])
        }
        self.assertEqual(matched_ids, set(synced.values()))

        self.assertEqual(
            [(r["date"], r["amount"]) for r in self._ledger_snapshot()],
            [("2025-11-20", "19.99"), ("2025-11-28", "7.99"),
             ("2025-12-05", "6.75"), ("2025-12-12", "41.02")],
        )

    async def test_the_same_file_imports_when_the_connection_feeds_an_account_of_its_own(self):
        # The control that shows the mapping does the work, not the mere existence of coverage: mapped
        # 'new', the provider account is a different physical account, its claim says nothing about the
        # file's account, and all four rows import. Same precondition the sync direction has.
        card_id = self._insert_account("Northgate Voyager", account_type="credit", mask="6612")
        connection_account_id = self._insert_account("CREDIT CARD", account_type="credit", mask="6612")
        self._seed_synced_rows(connection_account_id)
        self._connection_with_coverage(connection_account_id, mode="new")

        result = await self._run_import_fixture(
            "duplicate_connection_covered.csv", self._connection_covered_config(card_id))
        self.assertEqual(result["imported"], 4)
        self.assertEqual(result["deduped"], 0)

    async def test_import_into_merged_group_auto_confirms_in_group_overlap_only(self):
        # Pre-existing merge / import-order independence. A legacy umbrella "Credit Card" account
        # is already merged under "Rewards Card"; "Cashback Card" is a separate, unmerged card.
        # The umbrella holds two transactions that physically belong to the two different real
        # cards. Importing the statement file (mapped to the real cards) must:
        #   - auto-confirm the Rewards Card row as an in-group duplicate — the merge already
        #     declared Credit Card == Rewards Card, so it settles like an import-then-merge
        #     (auto_merge, restorable on a later detach), NOT as an open cross-account review item;
        #   - leave the Cashback Card row as an active cross-account suspect, since it was never
        #     merged with the umbrella and its match is a genuine cross-account coincidence/dupe.
        rewards_id = self._insert_account("Rewards Card", account_type="credit", mask="1111")
        credit_card_id = self._insert_account(
            "Credit Card", account_type="credit", parent_account_id=rewards_id,
        )
        cashback_id = self._insert_account("Cashback Card", account_type="credit", mask="2222")

        # Stored positive (money-out): the `single_signed` import convention flips the CSV's
        # negative charge to a positive debit, so these pre-existing rows — themselves imported
        # under the same convention — must match that sign for the (date, amount, payee) sweep.
        cc_rewards_txn = self._insert_existing_transaction(
            account_id=credit_card_id, date="2023-12-14", amount=3.65, merchant_name="PARKS DEPT",
        )
        cc_cashback_txn = self._insert_existing_transaction(
            account_id=credit_card_id, date="2023-10-30", amount=68.00, merchant_name="OUTDOOR CO",
        )

        config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "date_format": "%Y-%m-%d",
            },
            account_map={"Rewards Card": rewards_id, "Cashback Card": cashback_id},
        )
        result = await self._run_import_fixture("duplicate_merged_group_overlap.csv", config)
        # Neither receiving account had prior same-account rows and no alias/compare target was
        # declared, so nothing hard-rejects at import time; both rows insert and dedupe is decided
        # by the post-insert sweep + in-group promotion.
        self.assertEqual(result["imported"], 2)
        self.assertEqual(result["deduped"], 0)

        states = self._imported_dedupe_states(result["batch_id"])
        rewards_state = states[rewards_id]
        self.assertEqual(rewards_state["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(rewards_state["dedupe_resolved_by"], "auto_merge")
        self.assertIsNotNone(rewards_state["trashed_at"])
        self.assertEqual(rewards_state["suspect_duplicate_of"], cc_rewards_txn)

        cashback_state = states[cashback_id]
        self.assertEqual(cashback_state["suspect_duplicate_of"], cc_cashback_txn)
        self.assertEqual(cashback_state["suspect_duplicate_reason"], "cross_account")
        self.assertIsNone(cashback_state["trashed_at"])
        self.assertIsNone(cashback_state["rejection_reason"])

    async def test_duplicate_rows_within_same_csv_are_allowed(self):
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")
        config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )
        result = await self._run_import_fixture("duplicate_same_file_allowed.csv", config)
        self.assertEqual(result["imported"], 2)
        self.assertEqual(result["deduped"], 0)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_same_file_allowed_ledger.csv"))

    async def test_group_with_existing_account_dedupes_against_three_account_group(self):
        parent_id = self._insert_account("Merged Checking", account_type="depository", mask="0000")
        child_a_id = self._insert_account(
            "Merged Checking (...1111)",
            account_type="depository",
            mask="1111",
            display_name="Merged Checking",
            parent_account_id=parent_id,
        )
        child_b_id = self._insert_account(
            "Merged Checking (...2222)",
            account_type="depository",
            mask="2222",
            display_name="Merged Checking",
            parent_account_id=parent_id,
        )

        base_a_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"CHECKING (...1111)": child_a_id},
        )
        result_a = await self._run_import_fixture("duplicate_grouped_base_a.csv", base_a_config)
        self.assertEqual(result_a["imported"], 3)
        self.assertEqual(result_a["deduped"], 0)

        base_b_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"CHECKING (...2222)": child_b_id},
        )
        result_b = await self._run_import_fixture("duplicate_grouped_base_b.csv", base_b_config)
        self.assertEqual(result_b["imported"], 3)
        self.assertEqual(result_b["deduped"], 0)

        self._insert_existing_transaction(
            account_id=child_b_id,
            date="2025-10-20",
            amount=125.00,
            merchant_name="PAYPAL INST XFER CLEANING CREW",
            raw_name="PAYPAL INST XFER CLEANING CREW",
            display_name="PAYPAL INST XFER CLEANING CREW",
        )

        grouped_config = {
            "filename": "duplicate_grouped_compare.csv",
            "profile_id": None,
            "account_id": None,
            "single_account_new": None,
            "account_map": {},
            "skip_accounts": [],
            "new_accounts": [
                {
                    "csv_value": "CHECKING (...3333)",
                    "name": "Merged Checking (...3333)",
                    "type": "depository",
                    "group_with_account_id": parent_id,
                }
            ],
            "column_map": {
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
            },
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        result_grouped = await self._run_import_fixture("duplicate_grouped_compare.csv", grouped_config)
        self.assertEqual(result_grouped["imported"], 2)
        self.assertEqual(result_grouped["deduped"], 2)

        duplicates = self._get_duplicates(result_grouped["batch_id"])
        reasons = [row["reason"] for row in duplicates["rows"]]
        self.assertEqual(sum(reason == "Matches an existing transaction in the linked account group" for reason in reasons), 2)
        self.assertEqual(sum("Falls within the fully covered date range from an earlier import in this account scope" in reason for reason in reasons), 0)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_grouped_compare_ledger.csv"))

    async def test_terminal_day_reconciliation_consumes_only_prior_same_amount_rows(self):
        checking_id = self._insert_account("House Checking", account_type="depository", mask="4321")

        base_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"House Checking": checking_id},
        )
        result_one = await self._run_import_fixture("duplicate_terminal_same_amount_base.csv", base_config)
        self.assertEqual(result_one["imported"], 3)
        self.assertEqual(result_one["deduped"], 0)

        overlap_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CHECKING (...4321)": checking_id},
        )
        result_two = await self._run_import_fixture("duplicate_terminal_same_amount_overlap.csv", overlap_config)
        self.assertEqual(result_two["imported"], 1)
        self.assertEqual(result_two["deduped"], 2)

        duplicates = self._get_duplicates(result_two["batch_id"])
        reasons = [row["reason"] for row in duplicates["rows"]]
        self.assertEqual(sum("terminal covered day" in reason for reason in reasons), 2)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_terminal_same_amount_ledger.csv"))

    async def test_undo_cleans_up_dedupe_state_left_by_the_batch(self):
        # When a batch is undone we expect three pieces of dedupe state to be cleaned up:
        #   1. The batch's own import_batch_duplicate rows (decisions about a now-defunct import).
        #   2. The batch's import_batch_account coverage records (otherwise future imports would
        #      spuriously hard-reject rows on those dates).
        #   3. Any soft-flag (suspect_duplicate_of) pointers from OTHER batches that referenced
        #      a row in this batch — those pointers go dangling when the rows are deleted.
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")
        config = self._account_mapping_config(
            headers={
                "date": "Date", "description": "Description", "account": "Account",
                "amount": "Amount", "category": "Category", "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )

        # Run a real import so import_batch_account coverage records get written naturally.
        result = await self._run_import_fixture("duplicate_prior_base.csv", config)
        batch_id = result["batch_id"]

        # Manually plant the other two pieces of state we want to verify the undo cleans up:
        #   - a hard-reject record FOR this batch (simulating a row that would have been rejected
        #     against an earlier import in a real flow), and
        #   - a soft-flag from a row on a different account pointing AT a row in this batch.
        other_account = self._insert_account("Other", account_type="credit", mask="9999")
        with self._use_db_path():
            with get_db() as conn:
                this_batch_txn_id = conn.execute(
                    "SELECT id, date, amount, raw_name FROM txn WHERE import_batch_id = ? LIMIT 1",
                    (batch_id,),
                ).fetchone()
                conn.execute(
                    """
                    INSERT INTO import_batch_duplicate
                      (batch_id, row_number, reason, values_json, matched_transaction_json, txn_payload_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (batch_id, 99, "Matches an existing transaction", "{}", "{}", "{}"),
                )

        other_txn_id = self._insert_existing_transaction(
            account_id=other_account,
            date=this_batch_txn_id["date"],
            amount=this_batch_txn_id["amount"],
            merchant_name=this_batch_txn_id["raw_name"] or "X",
        )
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'import_new_account' WHERE id = ?",
                    (this_batch_txn_id["id"], other_txn_id),
                )

                # Sanity: all three pieces of state are present before undo.
                self.assertGreater(
                    conn.execute("SELECT COUNT(*) FROM import_batch_account WHERE batch_id = ?",
                                  (batch_id,)).fetchone()[0], 0,
                )
                self.assertGreater(
                    conn.execute("SELECT COUNT(*) FROM import_batch_duplicate WHERE batch_id = ?",
                                  (batch_id,)).fetchone()[0], 0,
                )
                self.assertEqual(
                    conn.execute("SELECT suspect_duplicate_of FROM txn WHERE id = ?", (other_txn_id,)).fetchone()["suspect_duplicate_of"],
                    this_batch_txn_id["id"],
                )

        self._undo_batch(batch_id)

        with self._use_db_path():
            with get_db() as conn:
                # 1. The batch's hard-reject records are gone.
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM import_batch_duplicate WHERE batch_id = ?",
                                  (batch_id,)).fetchone()[0], 0,
                )
                # 2. The batch's coverage records are gone.
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM import_batch_account WHERE batch_id = ?",
                                  (batch_id,)).fetchone()[0], 0,
                )
                # 3. The dangling soft-flag pointer was cleared (the row it pointed at is gone).
                cleared = conn.execute(
                    "SELECT suspect_duplicate_of FROM txn WHERE id = ?", (other_txn_id,),
                ).fetchone()
                self.assertIsNone(cleared["suspect_duplicate_of"])

    async def test_undo_then_reimport_same_file_imports_again_cleanly(self):
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")
        config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )

        first_result = await self._run_import_fixture("duplicate_prior_base.csv", config)
        self.assertEqual(first_result["imported"], 10)
        self.assertEqual(first_result["deduped"], 0)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_prior_base_ledger.csv"))

        undo_result = self._undo_batch(first_result["batch_id"])
        self.assertEqual(undo_result, {"ok": True})
        self.assertEqual(self._ledger_snapshot(), [])

        second_result = await self._run_import_fixture("duplicate_prior_base.csv", config)
        self.assertEqual(second_result["imported"], 10)
        self.assertEqual(second_result["deduped"], 0)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_prior_base_ledger.csv"))

    async def test_already_imported_409_names_the_matched_file(self):
        # The multi-file selector relies on this structured 409 to skip a duplicate copy and name the file
        # it duplicates. A second file with identical *content* (but a different name) must 409 with
        # reason='already_imported' and the first file's name, so the UI can say "X already imported as Y".
        # This is the whole-file (single-account) path — no account column, so it hits the file-wide 409,
        # not the per-account variant.
        checking_id = self._insert_account("House Checking", account_type="depository", mask="4321")
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": checking_id,
            "single_account_new": None,
            "account_map": {},
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "amount": "Amount", "category": "Category"},
            "date_format": "%m/%d/%Y",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        first = await self._run_import_fixture("already_imported_original.csv", config)
        self.assertEqual(first["imported"], 2)

        with self.assertRaises(HTTPException) as ctx:
            await self._run_import_fixture("already_imported_copy.csv", config)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIsInstance(ctx.exception.detail, dict)
        self.assertEqual(ctx.exception.detail["reason"], "already_imported")
        self.assertEqual(ctx.exception.detail["already_imported_filename"], "already_imported_original.csv")

    async def _two_account_config(self, id_a, id_b, *, skip=(), map_b=True):
        account_map = {"Checking A": id_a}
        if map_b:
            account_map["Checking B"] = id_b
        return {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "single_account_new": None,
            "account_map": account_map,
            "skip_accounts": list(skip),
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount", "category": "Category"},
            "date_format": "%m/%d/%Y",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }

    async def test_reimport_adds_previously_skipped_account_without_blocking(self):
        # An account-column file re-used to import an account that was *skipped* the first time must not be
        # blocked: the new account imports, and the already-imported account's identical rows are caught by
        # ordinary row-level dedup — no special treatment.
        id_a = self._insert_account("Checking A", account_type="depository", mask="1111")
        id_b = self._insert_account("Checking B", account_type="depository", mask="2222")

        first = await self._run_import_fixture(
            "two_account_scopes.csv", await self._two_account_config(id_a, id_b, skip=["Checking B"], map_b=False)
        )
        self.assertEqual(first["imported"], 2)  # Checking A's two rows; Checking B skipped

        second = await self._run_import_fixture(
            "two_account_scopes.csv", await self._two_account_config(id_a, id_b)
        )
        self.assertEqual(second["imported"], 1)   # Checking B's row is new
        self.assertEqual(second["deduped"], 2)    # Checking A's rows are ordinary duplicates

    async def test_reimport_when_nothing_new_is_skipped_as_duplicate(self):
        # Same file, both accounts already imported: re-importing would add nothing, so it is treated as a
        # duplicate and blocked with the structured skip 409 (so a multi-file import passes over it).
        id_a = self._insert_account("Checking A", account_type="depository", mask="1111")
        id_b = self._insert_account("Checking B", account_type="depository", mask="2222")

        first = await self._run_import_fixture("two_account_scopes.csv", await self._two_account_config(id_a, id_b))
        self.assertEqual(first["imported"], 3)

        with self.assertRaises(HTTPException) as ctx:
            await self._run_import_fixture("two_account_scopes.csv", await self._two_account_config(id_a, id_b))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail["reason"], "already_imported")

    async def test_two_file_labels_creating_same_named_new_account_merge(self):
        # Contract the import account-mapping UI relies on: two distinct CSV account labels both
        # mapped to "create new account" with the SAME name collapse into ONE account (the first
        # creates it, the second reuses it by name). This is what lets several file labels target a
        # single in-flight new account without any label-to-label reference.
        config = {
            "filename": "two_labels_one_new_account.csv",
            "profile_id": None, "account_id": None, "single_account_new": None,
            "account_map": {}, "skip_accounts": [],
            "new_accounts": [
                {"csv_value": "CARD A", "name": "Shared Card", "type": "credit"},
                {"csv_value": "CARD B", "name": "Shared Card", "type": "credit"},
            ],
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount"},
            "date_format": "%Y-%m-%d", "amount_convention": "single_signed", "skip_rows": 0,
            "apply_categorization": False, "use_imported_categories": False,
        }
        result = await self._run_import_fixture("two_labels_one_new_account.csv", config)
        self.assertEqual(result["imported"], 2)
        with self._use_db_path():
            with get_db() as conn:
                named = conn.execute("SELECT COUNT(*) AS n FROM account WHERE name = 'Shared Card'").fetchone()["n"]
                accounts_with_txns = conn.execute(
                    "SELECT COUNT(DISTINCT account_id) AS n FROM txn WHERE trashed_at IS NULL"
                ).fetchone()["n"]
        self.assertEqual(named, 1, "the two same-named new-account entries must collapse to one account")
        self.assertEqual(accounts_with_txns, 1, "both rows land on the single shared account")

    async def test_create_data_source_from_profileless_batch(self):
        # The unknown-source "+ New data source from this file" path: a profileless batch becomes a
        # saved data source built from its own import mapping, and the file links to it.
        rewards = self._insert_account("Rewards Card", account_type="credit", mask="1234")
        config = self._account_mapping_config(
            headers={"date": "Date", "description": "Description", "account": "Account",
                     "amount": "Amount", "category": "Category", "date_format": "%m/%d/%Y"},
            account_map={"Travel Rewards": rewards},
        )
        result = await self._run_import_fixture("duplicate_prior_base.csv", config)
        batch_id = result["batch_id"]

        with self._use_db_path():
            created = create_profile_from_batch(
                batch_id, BatchCreateProfileRequest(name="My Bank", filename_pattern="duplicate_prior_base"))
        pid = created["id"]
        with self._use_db_path():
            with get_db() as conn:
                profile = conn.execute(
                    "SELECT name, filename_pattern, date_format, amount_convention, template_filename, header_fingerprint FROM csv_import_profile WHERE id = ?", (pid,)
                ).fetchone()
                linked = conn.execute("SELECT profile_id FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
        self.assertEqual(profile["name"], "My Bank")
        self.assertEqual(linked["profile_id"], pid, "the file must move under the new data source")
        # The mapping is carried from the file's own import config; the filename pattern from the caller.
        self.assertEqual(profile["date_format"], "%m/%d/%Y")
        self.assertEqual(profile["amount_convention"], config["amount_convention"])
        self.assertEqual(profile["filename_pattern"], "duplicate_prior_base")
        self.assertEqual(profile["template_filename"], "duplicate_prior_base.csv")
        # Header fingerprint is now persisted at import time and carried through, so the source
        # auto-matches future files by column structure too (parity with "Save as data source").
        self.assertTrue(profile["header_fingerprint"], "header fingerprint should be carried from the batch")

        # Already linked → cannot create another from it.
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                create_profile_from_batch(batch_id, BatchCreateProfileRequest(name="Another"))
        self.assertEqual(ctx.exception.status_code, 400)

    # ---- advisory-review classification + acknowledgment -----------------

    def _insert_coverage_reject(self, *, batch_id: str, filename: str, row_number: int, candidates: list[dict]):
        """Insert an import_batch_duplicate row shaped like a coverage-window hard-reject. `candidates`
        carry `day_offset` like the real candidate lookup, so we can drive the substate logic."""
        import json
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("INSERT OR IGNORE INTO import_batch (id, filename, status) VALUES (?, ?, 'completed')",
                             (batch_id, filename))
                conn.execute(
                    """
                    INSERT INTO import_batch_duplicate
                      (batch_id, row_number, reason, values_json, matched_transaction_json, txn_payload_json)
                    VALUES (?, ?, ?, '{}', ?, ?)
                    """,
                    (batch_id, row_number,
                     "Falls within the fully covered date range from an earlier import in this account scope",
                     json.dumps({"covered": {"start_date": "2023-01-01", "end_date": "2023-12-31"},
                                 "candidates": candidates, "candidate_count": len(candidates)}),
                     json.dumps({"date": "2023-08-11", "amount": 20.22, "merchant_name": "TOLL CO"})),
                )

    def _entry_for_row(self, batch_id: str, row_number: int):
        with self._use_db_path():
            with get_db() as conn:
                entries = list_unified_batch_duplicates(conn, batch_id)
        return next(e for e in entries if e["incoming"].get("row_number") == row_number)

    def test_coverage_reject_substate_classification(self):
        batch = "batch-substate"
        # row 1: a twin found only on a nearby day → "matched nearby date"; row 2: no candidate → "no specific
        # match"; row 3: only a cross-account transfer twin → "possible transfer match".
        self._insert_coverage_reject(batch_id=batch, filename="f.csv", row_number=1,
                                     candidates=[{"id": "x", "date": "2023-08-09", "amount": 20.22, "day_offset": -2}])
        self._insert_coverage_reject(batch_id=batch, filename="f.csv", row_number=2, candidates=[])
        self._insert_coverage_reject(batch_id=batch, filename="f.csv", row_number=3,
                                     candidates=[{"id": "y", "date": "2023-08-12", "amount": 20.22,
                                                  "cross_account": True, "account_name": "Northgate Checking"}])
        self.assertEqual(self._entry_for_row(batch, 1)["review_substate"], "matched_near_date")
        self.assertEqual(self._entry_for_row(batch, 2)["review_substate"], "no_match")
        self.assertEqual(self._entry_for_row(batch, 3)["review_substate"], "transfer_match")

    def test_mark_reviewed_clears_substate(self):
        batch = "batch-ack"
        self._insert_coverage_reject(batch_id=batch, filename="f.csv", row_number=1, candidates=[])
        self.assertEqual(self._entry_for_row(batch, 1)["review_substate"], "no_match")
        self.assertFalse(self._entry_for_row(batch, 1)["reviewed"])
        with self._use_db_path():
            mark_batch_duplicates_reviewed(batch, BatchDuplicateReviewRequest(row_numbers=[1], reviewed=True))
        acked = self._entry_for_row(batch, 1)
        self.assertTrue(acked["reviewed"])
        self.assertIsNone(acked["review_substate"])  # leaves the needs-attention pills
        # Un-review puts it back.
        with self._use_db_path():
            mark_batch_duplicates_reviewed(batch, BatchDuplicateReviewRequest(row_numbers=[1], reviewed=False))
        self.assertEqual(self._entry_for_row(batch, 1)["review_substate"], "no_match")


if __name__ == "__main__":
    unittest.main()
