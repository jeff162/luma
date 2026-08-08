"""
Data-source sync runs the same duplicate ladder a CSV import does.

Before this, a sync checked only provider-transaction-id idempotence — which by construction can never
see a row that arrived from a *different* source. So a charge already imported from a Monarch CSV came
back from Plaid as a second copy on a second account, and nothing in the pipeline noticed.

The cases below are the ones actually observed in a real ledger, kept concrete on purpose:

  CVS Caremark   Plaid `CAREMARK MAIL` on the 5th vs. CSV `CVS Caremark` on the 2nd — the texts DO
                 overlap, but the dates are three days apart because one source reports the posted
                 date and the other the transaction date.
  Whole Foods    identical text, four days apart — outside the old ±3 soft-flag window entirely.
  Chase payment  Plaid `Payment Thank You Bill` vs. CSV `Chase` — ZERO text overlap on the same day.
                 No text tier can ever match these; only coverage can.

The third is the important one: it is why the mapping exists at all. Coverage only rejects a row when
the receiving account is in that coverage or was explicitly declared an alias of an account that is —
which a sync could not satisfy until an account mapping could say so.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.tests._fake_adapter import FakeCursorAdapter


class _FrozenDate(date):
    """Pin `date.today()` inside the sync module so card months and coverage dates are deterministic."""

    _today = date(2026, 8, 10)

    @classmethod
    def today(cls):
        return cls._today


class _Adapter(FakeCursorAdapter):
    """One batch of `added` rows, delivered on the first call and never again — so a test can sync twice
    and see the second pull bring nothing new."""

    def __init__(self, added):
        super().__init__()
        self._added = added
        # Set by a test that wants the per-account reporting a range-pull provider does; left None to
        # behave like a cursor provider, which reports none.
        self.account_coverage = None

    def fetch_transactions_sync(self, app_config, credential, *, cursor=None, days_requested=730,
                                account_targets=None, **kwargs):
        added, self._added = self._added, []
        return {**super().fetch_transactions_sync(app_config, credential, cursor=cursor,
                                                  days_requested=days_requested,
                                                  account_targets=account_targets, **kwargs),
                "added": added, "next_cursor": "c1",
                "account_coverage": self.account_coverage}


class _FailingAdapter(_Adapter):
    """A provider call that raises. `run_sync` catches it per connection and moves on, which is the
    whole mechanism behind "a failed sync advances nothing"."""

    def __init__(self):
        super().__init__([])

    def fetch_transactions_sync(self, app_config, credential, **kwargs):
        raise RuntimeError("provider unavailable")


class SyncDedupeTests(unittest.TestCase):
    CSV_ACCOUNT = "acct-csv"
    PLAID_ACCOUNT = "acct-plaid"
    EXTERNAL = "ext-card"
    LABEL = "CREDIT CARD ···6612"

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "sync-dedupe.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-1','plaid','item-1','','Chase')"
            )
            for acct, name in ((self.CSV_ACCOUNT, "Northgate Voyager"), (self.PLAID_ACCOUNT, "CREDIT CARD")):
                conn.execute(
                    "INSERT INTO account (id, name, display_name, type, owner_id) VALUES (?,?,?, 'credit', ?)",
                    (acct, name, name, SHARED_OWNER_ID),
                )
            conn.execute(
                "UPDATE account SET external_account_id = ?, connection_id = 'conn-1', provider = 'plaid' WHERE id = ?",
                (self.EXTERNAL, self.PLAID_ACCOUNT),
            )

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

    # ---- fixtures ------------------------------------------------------

    def _map(self, mode, target=None):
        """Record the connection's account mapping — the input the cross-account rules gate on."""
        with self._db() as conn:
            conn.execute(
                """
                INSERT INTO connection_account
                  (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                   provider_name, provider_mask)
                VALUES ('conn-1', ?, ?, ?, ?, 'CREDIT CARD', '6612')
                """,
                (self.EXTERNAL,
                 self.CSV_ACCOUNT if mode == "existing" else self.PLAID_ACCOUNT,
                 mode, target),
            )

    def _csv_batch(self, rows, *, coverage=("2024-03-18", "2026-07-26"), terminal="2026-07-27"):
        """A completed Monarch-style CSV import on the CSV account, with its coverage window."""
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, status) VALUES ('b-csv','Monarch.csv','completed')"
            )
            conn.execute(
                "INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count, was_skipped,"
                " coverage_start_date, coverage_end_date, terminal_date) VALUES"
                " ('b-csv','CREDIT CARD (...6612)',?,?,0,?,?,?)",
                (self.CSV_ACCOUNT, len(rows), coverage[0], coverage[1], terminal),
            )
            for i, (day, amount, text) in enumerate(rows):
                conn.execute(
                    "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,"
                    " raw_name, date, is_pending, content_hash, import_batch_id, import_evidence_json)"
                    " VALUES (?,?,?,?,?,?,?,?,0,?, 'b-csv', ?)",
                    (f"csv-{i}", self.CSV_ACCOUNT, SHARED_OWNER_ID, amount, text, text, text, day,
                     f"csvhash-{i}",
                     json.dumps({"account": {"header": "Account", "value": "CREDIT CARD (...6612)"}})),
                )

    def _synced(self, txn_id, day, amount, merchant, raw, authorized_date=None):
        return {
            "external_transaction_id": txn_id,
            "external_account_id": self.EXTERNAL,
            "amount": amount,
            "merchant_name": merchant,
            "raw_name": raw,
            "date": day,
            "authorized_date": authorized_date,
            "is_pending": False,
        }

    def _sync(self, added, days=0, adapter=None, full_history=False):
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        adapter = adapter or _Adapter(added)
        token = set_current_db_path(str(self.db_path))
        try:
            with mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                 mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                 mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x"}), \
                 mock.patch.object(sync_module, "get_adapter", return_value=adapter), \
                 mock.patch.object(sync_module, "date", _FrozenDate):
                return sync_module.run_sync(days=days, connection_id="conn-1", request=request,
                                            full_history=full_history)
        finally:
            reset_current_db_path(token)

    def _rows_on(self, account_id):
        with self._db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT * FROM txn WHERE account_id = ? AND trashed_at IS NULL", (account_id,)
            ).fetchall()]

    def _duplicate_reasons(self):
        with self._db() as conn:
            return [r["reason"] for r in conn.execute("SELECT reason FROM import_batch_duplicate").fetchall()]

    # ---- the reported cases --------------------------------------------

    def test_zero_text_overlap_inside_covered_range_is_rejected_when_mapped(self):
        # The Chase payment: "Payment Thank You Bill" vs "Chase", same day, same amount. No text tier
        # can match these — coverage is the only rule that can, and it only applies because the
        # mapping declares this provider account to BE the CSV account.
        self._csv_batch([("2026-07-13", -21.25, "Chase")])
        self._map("existing")
        res = self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])

        self.assertEqual(res["added"], 0)
        self.assertEqual(res["deduped"], 1)
        self.assertIn("covered", " ".join(self._duplicate_reasons()).lower())

    def test_the_same_row_imports_when_the_account_is_unmapped(self):
        # The contrast that shows the mapping is what does the work: with no mapping the provider
        # account is nobody's alias, coverage cannot apply, and the row lands as it always did.
        self._csv_batch([("2026-07-13", -21.25, "Chase")])
        res = self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        self.assertEqual(res["added"], 1)
        self.assertEqual(res["deduped"], 0)

    def test_cvs_pair_three_days_apart_is_caught(self):
        # Texts overlap ("CVS Caremark"), dates are 3 apart (posted vs transaction date).
        self._csv_batch([("2026-07-02", -20.0, "CVS Caremark")])
        self._map("existing")
        res = self._sync([self._synced("p1", "2026-07-05", -20.0, "CVS Caremark", "CAREMARK MAIL")])
        self.assertEqual(res["added"], 0)
        self.assertEqual(res["deduped"], 1)

    def test_whole_foods_pair_four_days_apart_is_soft_flagged_across_accounts(self):
        # +4 with identical text, and — crucially — OUTSIDE the CSV's covered range (which ends
        # 2026-07-26), so coverage cannot reject it. This is the case the cross-account sweep exists
        # for, and it needs the widened date window: at ±3 the pair was never even considered.
        #
        # It is a soft flag, not a hard reject, and deliberately so: the evidence here is "same amount,
        # same text, four days apart on a related account", which is strong enough to raise for review
        # but not to drop a row unseen.
        self._csv_batch([("2026-07-25", -7.49, "Whole Foods")])
        self._map("group", target=self.CSV_ACCOUNT)
        res = self._sync([self._synced("p1", "2026-07-29", -7.49, "Whole Foods", "WHOLE FOODS")])

        self.assertEqual(res["added"], 1)
        row = self._rows_on(self.PLAID_ACCOUNT)[0]
        self.assertIsNotNone(row["suspect_duplicate_of"], "the pair must be raised for review")
        self.assertEqual(row["suspect_duplicate_of"], "csv-0")

    def test_authorized_date_pulls_a_row_into_a_covered_range_its_posted_date_missed(self):
        # The dual-date case, and the reason capturing authorized_date matters more than any window.
        # Monarch dates this charge by its TRANSACTION date (07-25, inside its coverage); Plaid dates
        # the same charge by its POSTED date (07-29, outside). Testing only the posted date, coverage
        # never engaged and the duplicate sailed through. Testing either date, it is covered.
        self._csv_batch([("2026-07-25", -7.49, "Whole Foods")])
        self._map("existing")
        res = self._sync([self._synced("p1", "2026-07-29", -7.49, "Whole Foods", "WHOLE FOODS",
                                       authorized_date="2026-07-25")])
        self.assertEqual(res["added"], 0)
        self.assertEqual(res["deduped"], 1)

    def test_without_an_authorized_date_the_same_row_is_not_covered(self):
        # The control for the test above: identical inputs minus the second date. It imports, which is
        # correct — nothing then places the charge inside the covered range.
        self._csv_batch([("2026-07-25", -7.49, "Whole Foods")])
        self._map("existing")
        res = self._sync([self._synced("p1", "2026-07-29", -7.49, "Whole Foods", "WHOLE FOODS")])
        self.assertEqual(res["added"], 1)

    def test_a_row_outside_the_covered_range_still_imports(self):
        # The guard against over-rejecting: coverage ends 2026-07-26, so a row after it is genuinely
        # new and must arrive. Without this the ladder could "pass" by rejecting everything.
        self._csv_batch([("2026-07-02", -20.0, "CVS Caremark")])
        self._map("existing")
        res = self._sync([self._synced("p2", "2026-08-05", -33.0, "New Merchant", "NEW MERCHANT")])
        self.assertEqual(res["added"], 1)
        self.assertEqual(res["deduped"], 0)

    # ---- what a rejected row leaves behind ------------------------------

    def test_a_rejected_row_is_recorded_for_review_not_silently_dropped(self):
        self._csv_batch([("2026-07-13", -21.25, "Chase")])
        self._map("existing")
        self._sync([self._synced("p1", "2026-07-13", -21.25, None, "Payment Thank You Bill")])
        with self._db() as conn:
            row = conn.execute("SELECT * FROM import_batch_duplicate").fetchone()
            card = conn.execute(
                "SELECT deduped_count FROM import_batch WHERE id = ?", (row["batch_id"],)
            ).fetchone()
        payload = json.loads(row["txn_payload_json"])
        self.assertEqual(payload["external_transaction_id"], "p1")
        self.assertEqual(payload["amount"], -21.25)
        self.assertEqual(card["deduped_count"], 1, "the card's duplicate tally drives the report badge")

    # ---- capture + evidence on inserted rows ----------------------------

    def test_inserted_rows_carry_authorized_date_and_source_evidence(self):
        self._map("new")
        self._sync([self._synced("p1", "2026-07-05", -20.0, "CVS Caremark", "CAREMARK MAIL",
                                 authorized_date="2026-07-02")])
        row = self._rows_on(self.PLAID_ACCOUNT)[0]
        self.assertEqual(row["authorized_date"], "2026-07-02")
        evidence = json.loads(row["import_evidence_json"])
        # The account label is what lets this row serve as a terminal-window candidate later.
        self.assertEqual(evidence["account"]["value"], self.LABEL)
        self.assertEqual(evidence["description"]["value"], "CAREMARK MAIL")

    def test_a_check_number_is_folded_into_the_merchant(self):
        self._map("new")
        txn = self._synced("p1", "2026-08-01", -100.0, None, "CHECK")
        txn["check_number"] = "1042"
        self._sync([txn])
        self.assertEqual(self._rows_on(self.PLAID_ACCOUNT)[0]["merchant_name"], "Check #1042")

    # ---- cards and coverage ---------------------------------------------

    def test_delta_cards_are_keyed_on_the_transaction_month_not_the_fetch_month(self):
        # Fetched 2026-08-10; a July-dated row must land on a July card, not August's.
        self._map("new")
        with self._db() as conn:
            conn.execute("UPDATE connection SET initial_sync_complete = 1, transactions_cursor = 'c0'")
        self._sync([self._synced("p1", "2026-07-30", -5.0, "A", "A"),
                    self._synced("p2", "2026-08-02", -6.0, "B", "B")], days=30)
        with self._db() as conn:
            cards = [r["filename"] for r in conn.execute(
                "SELECT filename FROM import_batch WHERE source_kind = 'connection_sync' ORDER BY filename"
            ).fetchall()]
        self.assertEqual(cards, ["Chase · August 2026", "Chase · July 2026"])

    def test_sync_cards_never_record_coverage(self):
        # A card holds whatever a delta happened to deliver, which proves nothing about the dates it
        # spans. The claim lives on connection_account instead.
        self._map("new")
        self._sync([self._synced("p1", "2026-07-30", -5.0, "A", "A")])
        with self._db() as conn:
            rows = conn.execute(
                "SELECT coverage_start_date, coverage_end_date, terminal_date FROM import_batch_account iba"
                " JOIN import_batch b ON b.id = iba.batch_id WHERE b.source_kind = 'connection_sync'"
            ).fetchall()
        self.assertTrue(rows)
        for r in rows:
            self.assertIsNone(r["coverage_start_date"])
            self.assertIsNone(r["coverage_end_date"])
            self.assertIsNone(r["terminal_date"])

    def test_a_range_pull_establishes_connection_coverage(self):
        self._map("new")
        self._sync([self._synced("p1", "2026-07-30", -5.0, "A", "A")], days=0)
        with self._db() as conn:
            row = conn.execute(
                "SELECT coverage_start_date, coverage_through_date FROM connection_account"
            ).fetchone()
        self.assertIsNotNone(row["coverage_start_date"])
        self.assertEqual(row["coverage_through_date"], "2026-08-10")

    def _complete_connection_with_coverage(self):
        with self._db() as conn:
            conn.execute(
                "UPDATE connection SET initial_sync_complete = 1, transactions_cursor = 'c0'"
            )
            conn.execute(
                "UPDATE connection_account SET coverage_start_date = '2026-06-01',"
                " coverage_through_date = '2026-08-01'"
            )

    def test_fetch_more_history_on_a_complete_connection_extends_coverage_backward(self):
        # The bug this fixes: `initial` is derived from initial_sync_complete, so a genuine 24-month
        # backfill requested AFTER the first sync was treated as a routine delta and never widened the
        # connection's coverage.
        self._map("new")
        self._complete_connection_with_coverage()
        self._sync([self._synced("p1", "2025-01-05", -5.0, "Old", "OLD")], days=0, full_history=True)
        with self._db() as conn:
            row = conn.execute("SELECT coverage_start_date FROM connection_account").fetchone()
        self.assertLess(row["coverage_start_date"], "2026-06-01",
                        "a range pull must widen coverage backward, not leave it where a delta put it")

    def test_a_pull_records_only_the_depth_each_account_actually_reached(self):
        # The over-claim this model exists to prevent, asserted end to end: when the adapter reports per
        # account, `_record_sync_coverage` must write each account's own reach and must not touch an
        # account the pull never fetched for. Coverage that overstates itself makes the ladder hard-reject
        # genuine transactions — a later CSV import of that period discarded as a duplicate of rows
        # nothing ever fetched.
        self._map("new")
        with self._db() as conn:
            conn.execute(
                "INSERT INTO connection_account (connection_id, external_account_id, account_id,"
                " mapping_mode, coverage_start_date) VALUES ('conn-1', 'ext-other', ?, 'new', '2026-01-01')",
                (self.CSV_ACCOUNT,),
            )

        adapter = _Adapter([self._synced("p1", "2026-07-30", -5.0, "A", "A")])
        adapter.account_coverage = {self.EXTERNAL: {"reached": "2026-06-15", "complete": False,
                                                    "empty_streak": 1}}
        self._sync([], adapter=adapter, days=0, full_history=True)

        with self._db() as conn:
            rows = {r["external_account_id"]: dict(r) for r in conn.execute(
                "SELECT external_account_id, coverage_start_date, history_complete, history_empty_streak"
                " FROM connection_account"
            )}
        self.assertEqual(rows[self.EXTERNAL]["coverage_start_date"], "2026-06-15",
                         "the account records what it reached, not the depth requested")
        self.assertEqual(rows[self.EXTERNAL]["history_empty_streak"], 1)
        self.assertEqual(rows["ext-other"]["coverage_start_date"], "2026-01-01",
                         "an account this pull did not fetch for must be left exactly as it was")

    def test_a_routine_sync_does_not_claim_coverage_it_never_fetched(self):
        # The counterpart to the test above, and the reason a range pull has to be declared rather than
        # inferred from `days<=0`: a routine top-up sends the same depth but pulls only a delta, so
        # treating it as a range pull backdated the coverage claim to a range nothing had fetched.
        self._map("new")
        self._complete_connection_with_coverage()
        self._sync([self._synced("p1", "2026-08-09", -5.0, "New", "NEW")], days=0)
        with self._db() as conn:
            row = conn.execute(
                "SELECT coverage_start_date, coverage_through_date FROM connection_account"
            ).fetchone()
        self.assertEqual(row["coverage_start_date"], "2026-06-01", "a delta must not widen coverage back")
        self.assertEqual(row["coverage_through_date"], "2026-08-10", "a delta still advances the leading edge")

    def test_a_connections_own_coverage_never_rejects_its_own_late_arrival(self):
        # The self-exclusion asymmetry. A CSV re-import of a covered range IS a duplicate; a sync delta
        # inside its own covered range is a late-posting charge the provider has only now reported.
        self._map("new")
        with self._db() as conn:
            conn.execute(
                "UPDATE connection_account SET coverage_start_date = '2026-01-01',"
                " coverage_through_date = '2026-08-10'"
            )
        res = self._sync([self._synced("p1", "2026-07-15", -12.0, "Late", "LATE POSTING")])
        self.assertEqual(res["added"], 1)
        self.assertEqual(res["deduped"], 0)

    # ---- what a failed sync must NOT do ---------------------------------
    # The design carries no staleness flag: a connection's coverage is trusted because it only ever
    # advances on a pull that actually succeeded. That self-correcting property is entirely load-bearing
    # and entirely implicit (a failure just `continue`s past the write), so it is pinned here.

    def _coverage(self) -> dict:
        with self._db() as conn:
            row = conn.execute(
                "SELECT coverage_start_date, coverage_through_date FROM connection_account"
            ).fetchone()
            cursor = conn.execute("SELECT transactions_cursor FROM connection").fetchone()
        return {**dict(row), "cursor": cursor["transactions_cursor"]}

    def _established_coverage(self):
        """A connection mid-life: backfilled, cursor parked, coverage claimed through 08-01 — nine days
        behind the frozen today, so any advance is visible."""
        self._map("new")
        with self._db() as conn:
            conn.execute("UPDATE connection SET initial_sync_complete = 1, transactions_cursor = 'c0'")
            conn.execute(
                "UPDATE connection_account SET coverage_start_date = '2026-01-01',"
                " coverage_through_date = '2026-08-01'"
            )

    def test_a_failed_sync_leaves_the_coverage_claim_where_it_was(self):
        self._established_coverage()
        self._sync([], days=30, adapter=_FailingAdapter())

        self.assertEqual(self._coverage(), {
            "coverage_start_date": "2026-01-01",
            "coverage_through_date": "2026-08-01",
            "cursor": "c0",
        }, "a failed sync must advance neither the coverage claim nor the cursor that backs it")

    def test_a_successful_delta_does_advance_the_trailing_edge(self):
        # The control the test above needs to mean anything: the same connection, the same starting
        # coverage, a provider call that works — the trailing edge moves to today. Without this the
        # failure assertion would also pass if deltas never advanced coverage at all.
        self._established_coverage()
        self._sync([self._synced("p1", "2026-08-09", -5.0, "A", "A")], days=30)

        self.assertEqual(self._coverage()["coverage_through_date"], "2026-08-10")

    def test_a_failed_sync_does_not_establish_coverage_for_a_connection_that_had_none(self):
        # The first-backfill shape of the same rule. A range pull is what establishes
        # coverage_start_date, so a range pull that FAILED must leave the connection with no claim at
        # all — rather than one dated from the window it merely asked for.
        self._map("new")
        self._sync([], days=0, adapter=_FailingAdapter())

        self.assertEqual(self._coverage(), {
            "coverage_start_date": None, "coverage_through_date": None, "cursor": None,
        })


if __name__ == "__main__":
    unittest.main()
