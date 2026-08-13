"""
The connection sync log — `connection_sync_log`, its endpoints, and what a sync records in it.

Two things are pinned here that nothing covered before.

**It is not behind `LUMA_DEVELOPER_OPTIONS`.** It was, *including its writes*, which meant a user who hit
connection trouble, found the flag and enabled it got an empty table — the history they needed had never
been recorded. Every test here forces the flag **off** rather than trusting the ambient default: anything
importing `backend.main` runs `load_dotenv()`, so a developer whose own `.env` sets the flag would
otherwise have these tests silently assert the opposite of what they claim, and only in a full-suite run.
The flag still guards the destructive dev reset tools; `test_developer_reset_tools_are_still_gated` is
what says the gate was narrowed rather than removed, and `test_a_sync_records_a_row_with_developer_
options_on` is what says the log no longer consults it in either direction.

**A sync that succeeds while importing nothing must not look identical to one with nothing to import.**
`error` only ever captured outright failure. `warnings` (user-actionable, mirroring the connection card)
and `advisories` (nobody's to act on, and recorded nowhere else) are what make the difference legible.
Advisories arrive from two places and both are exercised: the adapter's own, and the sync layer's
provider-agnostic notices — the latter driven through the Plaid-shaped `FakeCursorAdapter`, which is the
point, since those notices are not any one provider's.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.routers.import_export.core import clear_import_memory

from backend.tests._fake_adapter import DONE as _DONE, FakeCursorAdapter as _FakeAdapter


class _FrozenDate(sync_module.date):
    """Pins `date.today()` inside the sync module; everything else on `date` behaves normally."""
    _today = "2026-08-10"

    @classmethod
    def today(cls):
        return sync_module.date.fromisoformat(cls._today)


class SyncDiagnosticsLogTests(unittest.TestCase):
    CONNECTION_ID = "conn-1"
    EXTERNAL_ACCOUNT_ID = "acct-ext-1"

    def setUp(self):
        # Pinned, not assumed. `load_dotenv()` runs on any import of `backend.main`, so the developer's own
        # `.env` reaches `os.environ` for the whole session — an ambient default here would make these
        # tests pass or fail on whose machine ran them.
        self._env = mock.patch.dict(os.environ, {"LUMA_DEVELOPER_OPTIONS": ""})
        self._env.start()
        self.addCleanup(self._env.stop)
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "sync-log.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES (?, 'plaid', 'item-1', '', 'Example Bank')",
                (self.CONNECTION_ID,),
            )
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES ('a1', ?, ?, 'plaid', 'Checking', 'Checking', 'depository', 'checking',
                        '1188', ?, NULL, NULL)
                """,
                (self.EXTERNAL_ACCOUNT_ID, self.CONNECTION_ID, SHARED_OWNER_ID),
            )
            conn.execute(
                """
                INSERT INTO connection_account
                  (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                   provider_name, provider_mask)
                VALUES (?, ?, 'a1', 'existing', 'a1', 'Checking', '1188')
                """,
                (self.CONNECTION_ID, self.EXTERNAL_ACCOUNT_ID),
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

    # ---- helpers ---------------------------------------------------------

    @contextmanager
    def _driven_sync(self, *, pages=None, adapter=None, connection_id=None):
        """`run_sync` with the provider seam mocked and the clock pinned. Developer options are left at
        their default (off) throughout — that is the condition every assertion here depends on."""
        if adapter is None:
            adapter = _FakeAdapter(pages=pages or [{"added": [], "has_more": False, "update_status": _DONE}])
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x", "secret": "y"}), \
                mock.patch.object(sync_module, "get_adapter", return_value=adapter), \
                mock.patch.object(sync_module, "date", _FrozenDate):
            yield sync_module.run_sync(days=0, connection_id=connection_id or self.CONNECTION_ID,
                                       request=request)

    def _log_rows(self):
        with self._use_db_path(), get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT * FROM connection_sync_log ORDER BY started_at DESC, id DESC"
            ).fetchall()]

    def _advisories(self, row):
        return json.loads(row["advisories"]) if row["advisories"] else []

    def _txn(self, txn_id, external_account_id=None):
        return {
            "external_transaction_id": txn_id,
            "external_account_id": external_account_id or self.EXTERNAL_ACCOUNT_ID,
            "amount": 12.34,
            "merchant_name": "Coffee",
            "raw_name": "COFFEE",
            "date": "2026-08-09",
            "is_pending": False,
        }

    # ---- the gate --------------------------------------------------------

    def test_a_sync_records_a_row_without_developer_options(self):
        # The regression this whole change exists for: the write used to be gated, so the log was empty
        # exactly when someone went looking for it.
        with self._driven_sync(pages=[{"added": [self._txn("t1")], "has_more": False, "update_status": _DONE}]):
            pass
        rows = self._log_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["connection_id"], self.CONNECTION_ID)
        self.assertEqual(rows[0]["added"], 1)

    def test_a_sync_records_a_row_with_developer_options_on(self):
        # The other direction, so "ungated" cannot quietly become "inverted": the log does not consult the
        # flag at all, and an installation that has it set behaves identically.
        with mock.patch.dict(os.environ, {"LUMA_DEVELOPER_OPTIONS": "true"}):
            with self._driven_sync():
                pass
        self.assertEqual(len(self._log_rows()), 1)

    def test_the_endpoints_answer_without_developer_options(self):
        with self._driven_sync():
            pass
        with self._use_db_path():
            self.assertEqual(len(sync_module.sync_diagnostics()["entries"]), 1)
            self.assertEqual(sync_module.clear_sync_diagnostics(), {"ok": True})
            self.assertEqual(sync_module.sync_diagnostics()["entries"], [])

    def test_developer_reset_tools_are_still_gated(self):
        # The other half of the previous test: the flag was narrowed, not removed. A destructive tool must
        # still be invisible without it, or "we ungated the sync log" quietly became "we ungated the gate".
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), self.assertRaises(HTTPException) as ctx:
            clear_import_memory(request)
        self.assertEqual(ctx.exception.status_code, 404)

    # ---- what a row carries ---------------------------------------------

    def test_a_failure_is_recorded_with_its_error(self):
        # A Plaid-shaped connection whose pull raises: the sync survives it, and the log is where the
        # history of "failing since when" lives, since the connection itself keeps only the latest error.
        class _Boom(_FakeAdapter):
            def fetch_transactions_sync(self, *a, **kw):
                raise RuntimeError("provider exploded")

        with self._driven_sync(adapter=_Boom()):
            pass
        rows = self._log_rows()
        self.assertEqual(len(rows), 1)
        self.assertIn("provider exploded", rows[0]["error"])

    def test_a_bank_warning_reaches_both_the_card_and_the_log(self):
        # `last_sync_warnings` is the card's, and holds only the most recent pull. The log keeps it per
        # call, which is what makes "this started three syncs ago" answerable.
        with self._driven_sync(pages=[{
            "added": [], "has_more": False, "update_status": _DONE,
            "warnings": ["Example Bank needs to be reconnected."],
        }]):
            pass
        row = self._log_rows()[0]
        self.assertEqual(json.loads(row["warnings"]), ["Example Bank needs to be reconnected."])
        with self._use_db_path(), get_db() as conn:
            stored = conn.execute(
                "SELECT last_sync_warnings FROM connection WHERE id = ?", (self.CONNECTION_ID,),
            ).fetchone()["last_sync_warnings"]
        self.assertEqual(json.loads(stored), ["Example Bank needs to be reconnected."])

    def test_an_adapters_advisories_are_recorded_with_their_counts(self):
        # Counted, not just deduplicated: a windowed history walk provokes the same remark on every one of
        # its requests, and "the whole walk" reads very differently from "one request".
        with self._driven_sync(pages=[{
            "added": [], "has_more": False, "update_status": _DONE,
            "advisories": [{"message": "Requested date range exceeds recommended range.", "count": 24}],
        }]):
            pass
        self.assertEqual(
            self._advisories(self._log_rows()[0]),
            [{"message": "Requested date range exceeds recommended range.", "count": 24, "context": None}],
        )

    def test_an_advisory_keeps_the_context_of_the_request_that_drew_it(self):
        # The count says how much of the pull was affected; the context names one concrete request to go
        # look at. Both are needed and neither substitutes for the other — folding the context into the
        # message would make every window its own entry and destroy the count.
        with self._driven_sync(pages=[{
            "added": [], "has_more": False, "update_status": _DONE,
            "advisories": [{"message": "Requested date range exceeds recommended range.",
                            "count": 24, "context": "fetching 2023-11-22..2024-01-06"}],
        }]):
            pass
        entry = self._advisories(self._log_rows()[0])[0]
        self.assertEqual(entry["context"], "fetching 2023-11-22..2024-01-06")
        self.assertEqual(entry["count"], 24)

    def test_advisory_counts_accumulate_across_pages(self):
        # One /sync call can drain several pages; the same remark on each is one entry, summed — not two
        # entries, and not the last page's number.
        advisory = [{"message": "Requested date range exceeds recommended range.", "count": 3}]
        with self._driven_sync(pages=[
            {"added": [], "has_more": True, "update_status": None, "advisories": advisory},
            {"added": [], "has_more": False, "update_status": _DONE, "advisories": advisory},
        ]):
            pass
        self.assertEqual(self._advisories(self._log_rows()[0])[0]["count"], 6)

    def test_an_adapter_that_reports_no_advisories_records_none(self):
        # The default `FakeCursorAdapter` page omits the key entirely, modelling an adapter written before
        # the field existed. That must read as "none", not raise.
        with self._driven_sync():
            pass
        self.assertEqual(self._advisories(self._log_rows()[0]), [])
        self.assertIsNone(self._log_rows()[0]["advisories"])

    # ---- what the counts alone cannot say ---------------------------------

    def test_the_cards_the_rows_landed_on_are_named_alongside_the_total(self):
        # `added` is one number, but a sync files each row under its own transaction month, so a pull
        # spanning a month boundary writes to two cards — and the Import/Export page shows one at a time.
        # Without this a correct total reconciles against no visible card and reads as rows going missing.
        # Past the initial backfill, which is the one pull that deliberately keeps everything on one card.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE connection SET initial_sync_complete = 1, transactions_cursor = 'c0' WHERE id = ?",
                (self.CONNECTION_ID,),
            )
        with self._driven_sync(pages=[{
            "added": [dict(self._txn("t1"), date="2026-07-30"),
                      dict(self._txn("t2"), date="2026-08-09"),
                      dict(self._txn("t3"), date="2026-08-10")],
            "has_more": False, "update_status": _DONE,
        }]):
            pass
        row = self._log_rows()[0]
        self.assertEqual(row["added"], 3)
        cards = json.loads(row["card_counts"])
        # Ordered by size so the card that took the bulk of a pull is the one read first.
        self.assertEqual([(c["card"].split(" · ")[-1], c["added"]) for c in cards],
                         [("August 2026", 2), ("July 2026", 1)])

    def test_the_requested_date_ranges_are_recorded_when_the_adapter_reports_them(self):
        with self._driven_sync(pages=[{
            "added": [], "has_more": False, "update_status": _DONE,
            "requested_windows": [{"start": "2026-08-05", "end": "2026-08-12"}],
        }]):
            pass
        self.assertEqual(json.loads(self._log_rows()[0]["requested_windows"]),
                         [{"start": "2026-08-05", "end": "2026-08-12"}])

    def test_an_adapter_that_names_no_window_records_none_rather_than_failing(self):
        # A cursor provider asks for "everything since this token" and has no window to report; the key is
        # simply absent from its page, exactly as `advisories` is for an adapter predating that field.
        with self._driven_sync():
            pass
        self.assertIsNone(self._log_rows()[0]["requested_windows"])

    def test_a_pull_that_added_nothing_names_no_card(self):
        # An empty list is stored as NULL rather than "[]", matching every other optional column here, so
        # a reader cannot mistake "recorded, and it was nothing" for "recorded nothing".
        with self._driven_sync():
            pass
        self.assertIsNone(self._log_rows()[0]["card_counts"])

    # ---- the provider-agnostic notices -----------------------------------
    #
    # Driven through the Plaid-shaped fake on purpose. These are the sync layer's own notices, not any
    # adapter's, and they are the two stock answers to "why did this connection import nothing" — so a
    # test that only proved them for the provider that prompted the work would prove the wrong thing.

    def test_an_unmapped_foreign_currency_account_is_recorded(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO connection_account
                  (connection_id, external_account_id, account_id, mapping_mode, provider_name,
                   provider_currency)
                VALUES (?, 'acct-ext-eur', NULL, 'skip', 'Travel Card', 'EUR')
                """,
                (self.CONNECTION_ID,),
            )
        with self._driven_sync():
            pass
        messages = [a["message"] for a in self._advisories(self._log_rows()[0])]
        self.assertTrue(any("nothing imported" in m and "acct-ext-eur" in m for m in messages), messages)

    def test_a_newly_discovered_unmapped_account_is_recorded(self):
        # A row arrives for a provider account this connection has never seen. It cannot be imported (there
        # is nowhere to put it) and the user's only clue used to be a line in the server console.
        adapter = _FakeAdapter(
            pages=[{"added": [self._txn("t1", external_account_id="acct-ext-new")],
                    "has_more": False, "update_status": _DONE}],
            accounts=[{"external_account_id": "acct-ext-new", "name": "New Savings", "type": "depository",
                       "subtype": "savings", "mask": "9911", "currency": "USD"}],
        )
        with self._driven_sync(adapter=adapter):
            pass
        messages = [a["message"] for a in self._advisories(self._log_rows()[0])]
        self.assertTrue(any("skipped until mapped" in m for m in messages), messages)

    # ---- the sync-in-progress marker -------------------------------------

    def test_a_running_sync_is_visible_to_another_request_while_it_runs(self):
        # The property the whole marker depends on, and the one a naive implementation silently loses:
        # `get_db()` commits when its block exits and the pull holds one open for its entire duration, so a
        # marker written on *that* connection would only become visible once the sync it announces had
        # already finished. Asserted from inside the pull, through a separate connection, because that is
        # exactly what a second browser tab or a page reload is.
        seen = {}

        class _Observer(_FakeAdapter):
            def fetch_transactions_sync(inner, *a, **kw):
                from backend.services.providers.config import list_connections
                seen["syncing"] = {c["id"]: c["syncing"] for c in list_connections("plaid")}
                return super().fetch_transactions_sync(*a, **kw)

        with self._driven_sync(adapter=_Observer(pages=[{"added": [], "has_more": False, "update_status": _DONE}])):
            pass
        self.assertTrue(seen["syncing"][self.CONNECTION_ID], "the marker was not visible during the sync")

    def test_the_marker_is_cleared_when_the_sync_finishes(self):
        with self._driven_sync():
            pass
        from backend.services.providers.config import list_connections
        with self._use_db_path():
            self.assertFalse(list_connections("plaid")[0]["syncing"])

    def test_the_marker_is_cleared_when_the_sync_raises(self):
        # A sync that blows up must not leave the connection looking permanently busy — that would disable
        # "Sync now" until the staleness bound expired, which is worse than the double-sync the marker
        # prevents. The per-connection handler swallows adapter errors, so this raises where it cannot:
        # before the loop, from the scope query the wrapper runs.
        from backend.services.providers.config import list_connections
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                sync_module.run_sync(days=0, connection_id=self.CONNECTION_ID, request=request)
            self.assertFalse(list_connections("plaid")[0]["syncing"])

    def test_a_stale_marker_is_not_believed(self):
        # A process that dies mid-sync leaves the column set with nobody to clear it. Read through the
        # staleness bound, that expires instead of wedging the button for good.
        from backend.services.providers.config import list_connections, sync_marker_is_live
        self.assertTrue(sync_marker_is_live(sync_module._utcnow_iso()))
        self.assertFalse(sync_marker_is_live("2020-01-01T00:00:00.000000Z"))
        self.assertFalse(sync_marker_is_live("not a timestamp"), "unparseable must expire, not stick")
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE connection SET sync_started_at = '2020-01-01T00:00:00.000000Z'")
        with self._use_db_path():
            self.assertFalse(list_connections("plaid")[0]["syncing"])

    # ---- the resume-token marker -----------------------------------------

    def test_an_opaque_cursor_is_fingerprinted_by_length_and_prefix(self):
        # Plaid's shape: nothing about the token is readable, so length plus a leading slice is the only
        # marker available — and it must stay a slice, never the whole token.
        marker = sync_module._cursor_fingerprint("Y3Vyc29yLXZhbHVlLXRoYXQtaXMtb3BhcXVl")
        self.assertEqual(marker, "len=36·Y3Vyc29y")

    def test_a_json_checkpoint_is_summarized_rather_than_sliced(self):
        # A provider with no change feed stores its own checkpoint in that column. Slicing it produced
        # `{"throug` — meaningless, indistinguishable from a truncation bug, and hiding the two facts worth
        # having: how far the walk reached and how much of the request budget it spent.
        marker = sync_module._cursor_fingerprint(
            json.dumps({"through": "2026-08-08", "budget_date": "2026-08-08", "requests_used": 22})
        )
        self.assertEqual(marker, "through=2026-08-08, budget_date=2026-08-08, requests_used=22")

    def test_a_long_value_in_a_checkpoint_is_still_elided(self):
        # Parsing as JSON does not make a token non-secret. The "never store the whole thing" rule holds
        # for both shapes, so anything longer than a date or a count is dropped rather than printed.
        marker = sync_module._cursor_fingerprint(json.dumps({"through": "2026-08-08", "token": "x" * 200}))
        self.assertEqual(marker, "through=2026-08-08, token=…")

    def test_no_cursor_reads_as_none_rather_than_an_empty_marker(self):
        self.assertIsNone(sync_module._cursor_fingerprint(None))
        self.assertIsNone(sync_module._cursor_fingerprint(""))

    # ---- the skip breakdown ----------------------------------------------
    #
    # `skipped` was one number covering three unrelated events. Only the first below means data was lost;
    # the other two are routine, and the second is non-zero on *every* top-up by design because the
    # incremental overlap re-asks for days already held. Anything surfaced from the undivided number would
    # therefore have cried wolf on every sync, which is why the card could not show it before the split.

    def test_rows_with_no_local_account_are_counted_apart_from_routine_skips(self):
        with self._driven_sync(pages=[{
            "added": [self._txn("t1"), self._txn("t2", external_account_id="acct-ext-unmapped")],
            "has_more": False, "update_status": _DONE,
        }]):
            pass
        row = self._log_rows()[0]
        self.assertEqual(row["added"], 1)
        self.assertEqual(row["skipped"], 1, "the total still counts every skip")
        self.assertEqual(row["skipped_no_account"], 1, "the row that had nowhere to go")
        self.assertEqual(row["skipped_already_held"], 0)

    def test_a_re_fetched_row_counts_as_already_held_not_as_lost(self):
        # The routine case: sync the same transaction twice. Nothing is wrong, and nothing should read as
        # though data went missing.
        page = [{"added": [self._txn("t1")], "has_more": False, "update_status": _DONE}]
        with self._driven_sync(pages=page):
            pass
        with self._driven_sync(pages=page):
            pass
        row = self._log_rows()[0]   # newest first
        self.assertEqual(row["added"], 0)
        self.assertEqual(row["skipped_already_held"], 1)
        self.assertEqual(row["skipped_no_account"], 0)

    def test_the_per_account_breakdown_names_the_provider_account(self):
        # Keyed by the *provider's* account id, so an account with no local destination still appears —
        # the whole point, since a breakdown built from what landed can never name what did not.
        with self._driven_sync(pages=[{
            "added": [self._txn("t1"), self._txn("t2", external_account_id="acct-ext-unmapped")],
            "has_more": False, "update_status": _DONE,
        }]):
            pass
        counts = json.loads(self._log_rows()[0]["account_counts"])
        self.assertEqual(counts[self.EXTERNAL_ACCOUNT_ID]["added"], 1)
        self.assertEqual(counts["acct-ext-unmapped"]["skipped_no_account"], 1)

    # ---- the outcome the card reads --------------------------------------

    def _card_summary(self):
        """What the connection card would show for this connection's last sync.

        Not named `_outcome`: `unittest.TestCase` already uses `self._outcome` for its own result
        bookkeeping, and shadowing it replaces the framework's object with a bound method."""
        from backend.services.providers.config import list_connections
        with self._use_db_path():
            return {c["id"]: c["last_sync"] for c in list_connections("plaid")}[self.CONNECTION_ID]

    def test_a_clean_sync_reads_as_ok(self):
        with self._driven_sync(pages=[{"added": [self._txn("t1")], "has_more": False, "update_status": _DONE}]):
            pass
        summary = self._card_summary()
        self.assertEqual(summary["outcome"], "ok")
        self.assertEqual(summary["added"], 1)

    def test_rows_with_nowhere_to_go_raise_the_outcome_to_attention(self):
        with self._driven_sync(pages=[{
            "added": [self._txn("t1", external_account_id="acct-ext-unmapped")],
            "has_more": False, "update_status": _DONE,
        }]):
            pass
        self.assertEqual(self._card_summary()["outcome"], "attention")

    def test_already_held_rows_on_a_first_import_are_a_contradiction(self):
        # Nothing can already be held before the first import, so this cannot be the routine overlap. It is
        # what a transaction-id collision looks like from the outside — the shape that hid an entire account
        # importing nothing — so it reads as needing attention rather than as a clean sync.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO txn (id, external_transaction_id, account_id, owner_id, amount, merchant_name,"
                " raw_name, date, is_pending) VALUES ('t-pre', ?, 'a1', ?, 1.0, 'x', 'x', '2026-08-09', 0)",
                (f"{self.EXTERNAL_ACCOUNT_ID}-dup", SHARED_OWNER_ID),
            )
        collide = dict(self._txn("t1"))
        collide["external_transaction_id"] = f"{self.EXTERNAL_ACCOUNT_ID}-dup"
        with self._driven_sync(pages=[{"added": [collide], "has_more": False, "update_status": _DONE}]):
            pass
        row = self._log_rows()[0]
        self.assertEqual(row["mode"], "initial")
        self.assertEqual(row["skipped_already_held"], 1)
        self.assertEqual(self._card_summary()["outcome"], "attention")

    def test_the_same_rows_on_a_routine_sync_are_not_an_alarm(self):
        # The counterpart: identical bookkeeping, but on a top-up the re-fetch is expected and must not
        # colour the card. Without this pairing the split would just have moved the false alarm.
        page = [{"added": [self._txn("t1")], "has_more": False, "update_status": _DONE}]
        with self._driven_sync(pages=page):
            pass
        with self._driven_sync(pages=page):
            pass
        self.assertEqual(self._log_rows()[0]["mode"], "routine")
        self.assertEqual(self._log_rows()[0]["skipped_already_held"], 1)
        self.assertEqual(self._card_summary()["outcome"], "ok")

    def test_a_connection_that_has_never_synced_reports_no_summary(self):
        # Distinct from a zero-count success: "nothing recorded" and "a sync that imported nothing" are
        # different facts and the card must not render the first as the second.
        self.assertIsNone(self._card_summary())

    # ---- scoping ---------------------------------------------------------

    def test_the_read_endpoint_can_be_scoped_to_one_connection(self):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-2', 'plaid', 'item-2', '', 'Other Bank')"
            )
        with self._driven_sync():
            pass
        with self._driven_sync(connection_id="conn-2"):
            pass
        with self._use_db_path():
            self.assertEqual(len(sync_module.sync_diagnostics()["entries"]), 2)
            scoped = sync_module.sync_diagnostics(connection_id="conn-2")["entries"]
            self.assertEqual([e["connection_id"] for e in scoped], ["conn-2"])


class SyncLogMigrationTests(unittest.TestCase):
    """Migration 31 adds the two message columns to a database that predates them."""

    # The v30 shape, written out rather than derived by dropping columns from the current one: that is what
    # an upgrading database actually presents, and SQLite's DROP COLUMN additionally refuses to reparse a
    # CREATE carrying inline comments, so deriving it would test the rewind more than the migration.
    _V30_SYNC_LOG = """
        CREATE TABLE connection_sync_log (
            id              TEXT PRIMARY KEY,
            connection_id   TEXT,
            provider        TEXT,
            institution     TEXT,
            started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            finished_at     TEXT,
            mode            TEXT,
            days_requested  INTEGER,
            cursor_before   TEXT,
            cursor_after    TEXT,
            pages           INTEGER NOT NULL DEFAULT 0,
            added           INTEGER NOT NULL DEFAULT 0,
            updated         INTEGER NOT NULL DEFAULT 0,
            removed         INTEGER NOT NULL DEFAULT 0,
            skipped         INTEGER NOT NULL DEFAULT 0,
            status_sequence TEXT,
            final_status    TEXT,
            became_complete INTEGER NOT NULL DEFAULT 0,
            error           TEXT
        )
    """

    def test_the_message_columns_are_added_to_an_existing_database(self):
        from backend.db.database import MIGRATIONS

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "pre-31.db"
            init_db(str(db_path))
            token = set_current_db_path(str(db_path))
            try:
                with get_db() as conn:
                    conn.execute("DROP TABLE connection_sync_log")
                    conn.execute(self._V30_SYNC_LOG)
                    conn.execute(
                        "INSERT INTO connection_sync_log (id, provider, mode) VALUES ('old', 'plaid', 'routine')"
                    )

                    MIGRATIONS[31](conn)

                    cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_sync_log)")}
                    self.assertIn("warnings", cols)
                    self.assertIn("advisories", cols)
                    # A row written before the columns existed reads as "this call recorded none", which is
                    # the honest reading — not "none occurred".
                    old = conn.execute("SELECT * FROM connection_sync_log WHERE id = 'old'").fetchone()
                    self.assertIsNone(old["warnings"])
                    self.assertIsNone(old["advisories"])

                    # Re-running is a no-op rather than an error, so a partially-applied upgrade is
                    # recoverable by simply running it again.
                    MIGRATIONS[31](conn)
            finally:
                reset_current_db_path(token)

    def test_the_migration_skips_a_database_without_the_table(self):
        # Minimal hand-built fixtures exist in this suite; a migration that assumed the table would break
        # every one of them at import time.
        from backend.db.database import MIGRATIONS

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "bare.db"
            init_db(str(db_path))
            token = set_current_db_path(str(db_path))
            try:
                with get_db() as conn:
                    conn.execute("DROP TABLE connection_sync_log")
                    MIGRATIONS[31](conn)   # must not raise
            finally:
                reset_current_db_path(token)


if __name__ == "__main__":
    unittest.main()
