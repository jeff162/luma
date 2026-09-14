"""
Provider-agnostic connection seam (phase 6a): the plaid_item -> connection cutover.

Pins the three edges of the seam that must hold for a second provider to plug in:
  1. the migration backfill folds legacy plaid_item rows into provider='plaid' connections (idempotently);
  2. the adapter registry resolves a provider and normalizes its SDK dicts to provider-neutral keys;
  3. the credentials backup exports/restores connections (new shape) and still accepts the legacy
     plaid_items shape — all round-tripping the vault-encrypted credential.
"""

from __future__ import annotations

import base64
import json
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from backend.db import control_database as cdb
from backend.db import database
from backend.db.database import get_db
from backend.routers.import_export.backup import read_payload_bytes
from backend.services.ledger_currency import DEFAULT_LEDGER_CURRENCY, currency_matches
from backend.services import crypto_service as cs
from backend.services.providers import PlaidAdapter, UnknownProviderError, get_adapter
from backend.services.providers.base import ProviderAdapter
from backend.services.providers.simplefin import SimpleFinError
from backend.tests._api_client import STRONG_PASSPHRASE, api_client, in_browser_session


@contextmanager
def _isolated_stack():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    database.init_db(data_path)
    cdb.init_control_db()
    try:
        yield data_path
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        tmp.cleanup()


class ConnectionMigrationTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_stack()
        self.data_path = self._stack.__enter__()

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    def _add_legacy_plaid_schema(self, conn):
        # The v18 backfill runs against the pre-v18/v20 shape: a `plaid_item` table (dropped in v20) and an
        # `account.plaid_item_id` column (renamed in v20). init_db builds the *current* schema, so hand-build
        # the legacy bits the migration reads — the "isolated per-migration" pattern this helper documents.
        conn.execute(
            "CREATE TABLE plaid_item (item_id TEXT PRIMARY KEY, access_token TEXT NOT NULL DEFAULT '', access_token_enc TEXT)"
        )
        conn.execute("ALTER TABLE account ADD COLUMN plaid_item_id TEXT")

    def test_backfill_folds_plaid_items_into_connections(self):
        with database.get_db(db_path=self.data_path) as conn:
            self._add_legacy_plaid_schema(conn)
            conn.execute(
                "INSERT INTO plaid_item (item_id, access_token, access_token_enc) VALUES ('item-1', '', 'enc-blob')"
            )
            conn.execute(
                """INSERT INTO account (id, external_account_id, plaid_item_id, name, display_name, institution)
                   VALUES ('a1', 'acct-1', 'item-1', 'Checking', 'Checking', 'Test Bank')"""
            )
            # Fresh init_db already created the (empty) connection table; simulate the upgrade data half.
            database._backfill_connections_from_plaid_items(conn)
            rows = conn.execute(
                "SELECT provider, external_id, credential, credential_enc, institution FROM connection"
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["provider"], "plaid")
        self.assertEqual(rows[0]["external_id"], "item-1")
        self.assertEqual(rows[0]["credential_enc"], "enc-blob")  # ciphertext carried verbatim (no re-key)
        self.assertEqual(rows[0]["institution"], "Test Bank")

    def test_v20_relinks_accounts_and_drops_plaid_item(self):
        # v20 makes the account→connection link provider-neutral. Rebuild the pre-v20 account shape (the
        # renamed columns + the plaid_item_id string link) and a plaid_item table, then run the migration and
        # assert: plaid columns are gone, a real item_id relinks to its connection (id + provider), and the
        # csv/manual sentinels become an origin-only provider with a NULL connection.
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute("DROP TABLE account")
            conn.execute("""
                CREATE TABLE account (
                    id TEXT PRIMARY KEY, plaid_account_id TEXT UNIQUE, plaid_item_id TEXT NOT NULL,
                    name TEXT NOT NULL, display_name TEXT NOT NULL, institution TEXT, type TEXT,
                    subtype TEXT, mask TEXT, owner_id TEXT, parent_account_id TEXT, trashed_at TEXT)
            """)
            conn.execute("CREATE TABLE plaid_item (item_id TEXT PRIMARY KEY)")
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential) VALUES ('c1', 'plaid', 'item-1', '')"
            )
            for row in (
                ("a1", "acct-1", "item-1", "Bank"),      # linked → connection c1
                ("a2", "csv_abc", "csv_import", "CSV"),  # CSV import → provider 'csv', no connection
                ("a3", None, "manual", "Manual"),        # manual → provider 'manual', no connection
            ):
                conn.execute(
                    "INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name) VALUES (?,?,?,?,?)",
                    (*row, row[3]),
                )
            database._account_connection_columns(conn)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(account)")}
            tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            rows = {
                r["id"]: r
                for r in conn.execute("SELECT id, external_account_id, connection_id, provider FROM account")
            }
        self.assertIn("external_account_id", cols)
        self.assertNotIn("plaid_account_id", cols)
        self.assertNotIn("plaid_item_id", cols)
        self.assertNotIn("plaid_item", tables)  # the vestigial table is dropped
        self.assertEqual((rows["a1"]["external_account_id"], rows["a1"]["connection_id"], rows["a1"]["provider"]),
                         ("acct-1", "c1", "plaid"))
        self.assertEqual((rows["a2"]["connection_id"], rows["a2"]["provider"]), (None, "csv"))
        self.assertEqual((rows["a3"]["connection_id"], rows["a3"]["provider"]), (None, "manual"))

    def test_v26_renames_the_provider_transaction_id_preserving_values_and_uniqueness(self):
        # The column has held any provider's transaction id since 6a; v26 gives it the name to match, the
        # way v20 did for the account handle. A rename must carry the values (they are what makes a sync
        # idempotent) and the UNIQUE constraint (which is what stops a re-pull duplicating a row).
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute("DROP TABLE txn")
            conn.execute("""
                CREATE TABLE txn (
                    id TEXT PRIMARY KEY, plaid_transaction_id TEXT UNIQUE, amount REAL, date TEXT)
            """)
            conn.execute("INSERT INTO txn (id, plaid_transaction_id, amount, date) "
                         "VALUES ('t1', 'prov-1', 1.0, '2026-01-01')")
            conn.execute("INSERT INTO txn (id, plaid_transaction_id, amount, date) "
                         "VALUES ('t2', NULL, 2.0, '2026-01-02')")
            database._rename_txn_provider_transaction_id(conn)

            cols = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
            self.assertIn("external_transaction_id", cols)
            self.assertNotIn("plaid_transaction_id", cols)
            self.assertEqual(
                conn.execute("SELECT external_transaction_id FROM txn WHERE id = 't1'").fetchone()[0],
                "prov-1",
            )
            with self.assertRaises(Exception):
                conn.execute("INSERT INTO txn (id, external_transaction_id, amount, date) "
                             "VALUES ('t3', 'prov-1', 3.0, '2026-01-03')")

    def test_v26_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
            database._rename_txn_provider_transaction_id(conn)   # baseline is already post-rename
            database._rename_txn_provider_transaction_id(conn)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(txn)")}
        self.assertIn("external_transaction_id", cols)

    def test_v27_adds_sync_status_columns_to_existing_connections(self):
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute("DROP TABLE connection")
            conn.execute("""
                CREATE TABLE connection (
                    id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_id TEXT,
                    credential TEXT NOT NULL DEFAULT '', institution TEXT)
            """)
            conn.execute("INSERT INTO connection (id, provider, external_id) VALUES ('c1','plaid','item-1')")
            database._add_connection_sync_status(conn)
            row = conn.execute(
                "SELECT last_synced_at, last_sync_error, consecutive_sync_failures, last_sync_warnings "
                "FROM connection WHERE id = 'c1'"
            ).fetchone()
        # A pre-existing connection has no recorded history, and NULL is the honest answer: nothing
        # recorded the time of syncs that happened before the column existed.
        self.assertIsNone(row["last_synced_at"])
        self.assertIsNone(row["last_sync_error"])
        self.assertIsNone(row["last_sync_warnings"])
        # Explicitly backfilled rather than left to the DDL default, which does not apply retroactively.
        self.assertEqual(row["consecutive_sync_failures"], 0)

    def test_v27_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
            database._add_connection_sync_status(conn)   # baseline already has the columns
            database._add_connection_sync_status(conn)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
        self.assertIn("last_synced_at", cols)

    def test_v28_adds_per_account_history_state(self):
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute("DROP TABLE connection_account")
            conn.execute("""
                CREATE TABLE connection_account (
                    connection_id TEXT NOT NULL, external_account_id TEXT NOT NULL,
                    account_id TEXT, mapping_mode TEXT, coverage_start_date TEXT,
                    PRIMARY KEY (connection_id, external_account_id))
            """)
            conn.execute(
                "INSERT INTO connection_account (connection_id, external_account_id, mapping_mode, "
                "coverage_start_date) VALUES ('c1','ext-1','new','2026-02-01')"
            )
            database._per_account_history_state(conn)
            row = conn.execute(
                "SELECT history_complete, history_empty_streak FROM connection_account"
            ).fetchone()
        # Not presumed complete. An account whose end was previously concluded at the *connection* level
        # costs one extra window on the next deep pull; guessing the other way would leave history that is
        # never fetched again.
        self.assertEqual(row["history_complete"], 0)
        self.assertEqual(row["history_empty_streak"], 0)

    def test_v28_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
            database._per_account_history_state(conn)   # baseline already has the columns
            database._per_account_history_state(conn)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_account)")}
        self.assertIn("history_complete", cols)

    def test_v29_leaves_existing_accounts_unrestricted(self):
        # NULL reads as "the provider did not state a currency", which is treated as supported. Anything
        # else would stop working connections on no evidence: every one of them predates the column and was
        # syncing without complaint. The next connect or "Refresh accounts" fills the real value in.
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute("DROP TABLE connection_account")
            conn.execute("""
                CREATE TABLE connection_account (
                    connection_id TEXT NOT NULL, external_account_id TEXT NOT NULL,
                    account_id TEXT, mapping_mode TEXT,
                    PRIMARY KEY (connection_id, external_account_id))
            """)
            conn.execute("INSERT INTO connection_account (connection_id, external_account_id, "
                         "mapping_mode) VALUES ('c1','ext-1','new')")
            database._connection_account_currency(conn)
            row = conn.execute("SELECT provider_currency FROM connection_account").fetchone()
        self.assertIsNone(row["provider_currency"])
        self.assertTrue(currency_matches(DEFAULT_LEDGER_CURRENCY, row["provider_currency"]))

    def test_v29_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
            database._connection_account_currency(conn)   # baseline already has the column
            database._connection_account_currency(conn)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection_account)")}
        self.assertIn("provider_currency", cols)

    def test_v30_starts_every_connection_as_not_needing_a_reconnect(self):
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute("DROP TABLE connection")
            conn.execute("CREATE TABLE connection (id TEXT PRIMARY KEY, provider TEXT NOT NULL)")
            conn.execute("INSERT INTO connection (id, provider) VALUES ('c1','plaid')")
            database._connection_reauth_required(conn)
            row = conn.execute("SELECT reauth_required FROM connection").fetchone()
        # Explicitly backfilled rather than left to the DDL default, which does not apply retroactively.
        # A genuinely revoked connection raises the flag on its very next sync, so 0 is safe both ways.
        self.assertEqual(row["reauth_required"], 0)

    def test_v30_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
            database._connection_reauth_required(conn)   # baseline already has the column
            database._connection_reauth_required(conn)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(connection)")}
        self.assertIn("reauth_required", cols)

    def test_backfill_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
            self._add_legacy_plaid_schema(conn)
            conn.execute(
                "INSERT INTO plaid_item (item_id, access_token, access_token_enc) VALUES ('item-1', '', 'enc-blob')"
            )
            database._backfill_connections_from_plaid_items(conn)
            database._backfill_connections_from_plaid_items(conn)
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM connection WHERE external_id = 'item-1'"
            ).fetchone()["n"]
        self.assertEqual(count, 1)


class ProviderAdapterTests(unittest.TestCase):
    def test_registry_resolves_plaid_and_rejects_unknown(self):
        self.assertIsInstance(get_adapter("plaid"), PlaidAdapter)
        with self.assertRaises(UnknownProviderError):
            get_adapter("nope")

    def test_adapter_normalizes_to_provider_neutral_keys(self):
        adapter = get_adapter("plaid")
        cfg = {"client_id": "cid", "secret": "sek", "env": "sandbox"}  # app_config threaded through in 6b
        with mock.patch("backend.services.plaid_service.exchange_public_token",
                        return_value={"access_token": "tok-1", "item_id": "item-1"}):
            self.assertEqual(adapter.exchange(cfg, "public-1"), {"external_id": "item-1", "credential": "tok-1"})
        with mock.patch("backend.services.plaid_service.fetch_accounts", return_value=[
            {"plaid_account_id": "acct-1", "name": "Checking", "official_name": "Total Checking",
             "type": "depository", "subtype": "checking", "mask": "0000"}
        ]):
            self.assertEqual(adapter.fetch_accounts(cfg, "tok-1"), [
                {"external_account_id": "acct-1", "name": "Checking", "official_name": "Total Checking",
                 "type": "depository", "subtype": "checking", "mask": "0000",
                 # Absent from the provider payload above, so normalized to None — "not stated", which
                 # reads as a match everywhere downstream rather than as a rejection.
                 "currency": None}
            ])
        # The optional capture fields (authorized_date, counterparties, …) ride the same neutral dict;
        # a provider that can't supply one leaves it absent, and the adapter normalizes it to
        # None/empty rather than dropping the key, so downstream code never branches on provider.
        with mock.patch("backend.services.plaid_service.fetch_transactions", return_value=[
            {"plaid_transaction_id": "t-1", "plaid_account_id": "acct-1", "amount": 12.5,
             "merchant_name": "Store", "raw_name": "STORE #1", "date": "2026-01-01", "is_pending": False}
        ]):
            self.assertEqual(adapter.fetch_transactions(cfg, "tok-1"), [
                {"external_transaction_id": "t-1", "external_account_id": "acct-1", "amount": 12.5,
                 "merchant_name": "Store", "raw_name": "STORE #1", "date": "2026-01-01", "is_pending": False,
                 "authorized_date": None, "counterparties": [],
                 "check_number": None, "location": None, "currency": None}
            ])


class PlaidCurrencyTests(unittest.TestCase):
    """Plaid reports a currency, so the adapter judges rows on it.

    Two layers, deliberately tested separately. `plaid_service` resolves Plaid's *two* currency fields
    into one string — `iso_currency_code` for real ISO-4217 codes, `unofficial_currency_code` for crypto
    and currencies Plaid does not officially support — and the adapter above it only ever compares that
    string against the ledger's. The split matters because an unofficial code can never equal an ISO one,
    which is the correct answer for it and needs no special case anywhere higher up.

    Rows are judged **per transaction**, not per account: Plaid states a currency on every row, so the
    number in `amount` can be judged on its own terms rather than on an assumption about its account.
    """

    CFG = {"client_id": "cid", "secret": "sek", "env": "sandbox"}

    def _page(self, *transactions):
        return {"added": list(transactions), "modified": [], "removed": [],
                "next_cursor": "c1", "has_more": False,
                "update_status": "HISTORICAL_UPDATE_COMPLETE"}

    def _txn(self, txn_id, account, currency):
        """A transaction in the shape `plaid_service` hands up — already normalized, since that is the
        layer the adapter actually consumes."""
        return {"plaid_transaction_id": txn_id, "plaid_account_id": account, "amount": 12.5,
                "merchant_name": "Store", "raw_name": "STORE", "date": "2026-01-01",
                "authorized_date": None, "is_pending": False, "pending_transaction_id": None,
                "counterparties": [], "check_number": None,
                "location": None, "currency": currency}

    def _sync(self, page, ledger_currency="USD"):
        from backend.services import plaid_service
        with mock.patch.object(plaid_service, "fetch_transactions_sync", return_value=page):
            return get_adapter("plaid").fetch_transactions_sync(
                self.CFG, "tok-1", ledger_currency=ledger_currency)

    # ---- resolving Plaid's two fields ------------------------------------

    def test_the_service_resolves_either_currency_field(self):
        from backend.services.plaid_service import _currency_code
        self.assertEqual(_currency_code({"iso_currency_code": "USD"}), "USD")
        # Crypto and unsupported currencies arrive only here. Returned as-is so the comparison above can
        # do its work — "BTC" simply never equals an ISO ledger.
        self.assertEqual(_currency_code({"unofficial_currency_code": "BTC"}), "BTC")
        self.assertEqual(_currency_code({"iso_currency_code": "USD", "unofficial_currency_code": "BTC"}), "USD")
        # Plaid can state neither, which reads as "not stated" rather than as a rejection.
        self.assertIsNone(_currency_code({}))
        self.assertIsNone(_currency_code({"iso_currency_code": None, "unofficial_currency_code": ""}))

    # ---- what the adapter does with it -----------------------------------

    def test_a_row_in_another_currency_never_reaches_the_ledger(self):
        result = self._sync(self._page(
            self._txn("t-usd", "acct-1", "USD"),
            self._txn("t-eur", "acct-2", "EUR"),
        ))
        self.assertEqual({t["external_transaction_id"] for t in result["added"]}, {"t-usd"})
        self.assertEqual(result["unsupported_currency"], {"acct-2": "EUR"})

    def test_the_ledgers_currency_is_what_it_is_compared_against(self):
        # The mirror of the SimpleFIN case: on an AUD ledger, AUD is kept and USD is the mismatch. This is
        # what proves the comparison follows the setting rather than a privileged currency.
        result = self._sync(self._page(
            self._txn("t-aud", "acct-1", "AUD"),
            self._txn("t-usd", "acct-2", "USD"),
        ), ledger_currency="AUD")
        self.assertEqual({t["external_transaction_id"] for t in result["added"]}, {"t-aud"})
        self.assertEqual(result["unsupported_currency"], {"acct-2": "USD"})

    def test_an_unofficial_currency_is_rejected_and_named(self):
        result = self._sync(self._page(self._txn("t-btc", "acct-1", "BTC")))
        self.assertEqual(result["added"], [])
        self.assertEqual(result["unsupported_currency"], {"acct-1": "BTC"})

    def test_a_row_stating_no_currency_is_imported(self):
        # "Not stated" is not "not ours" — rejecting the row would discard real data over a reporting gap.
        result = self._sync(self._page(self._txn("t-1", "acct-1", None)))
        self.assertEqual(len(result["added"]), 1)
        self.assertEqual(result["unsupported_currency"], {})

    def test_modified_rows_are_filtered_on_the_same_rule(self):
        # An update to a row is as capable of carrying a foreign amount as a new one, and it writes to the
        # same column. Filtering only `added` would let the second path store what the first refused.
        page = self._page()
        page["modified"] = [self._txn("t-eur", "acct-2", "EUR")]
        result = self._sync(page)
        self.assertEqual(result["modified"], [])
        self.assertEqual(result["unsupported_currency"], {"acct-2": "EUR"})

    def test_the_offered_account_list_carries_its_currency(self):
        # Recorded at connect time so the mapping step can warn before an account that can never fill is
        # given a destination.
        from backend.services import plaid_service
        with mock.patch.object(plaid_service, "fetch_accounts", return_value=[
            {"plaid_account_id": "acct-1", "name": "Travel", "official_name": None,
             "type": "depository", "subtype": "checking", "mask": "0001", "currency": "EUR"},
        ]):
            accounts = get_adapter("plaid").fetch_accounts(self.CFG, "tok-1")
        self.assertEqual(accounts[0]["currency"], "EUR")


class RangePullDefaultTests(unittest.TestCase):
    """The base adapter's `fetch_transactions_sync`, which is what a provider with no change feed rides.

    It exists so a non-cursor provider needs no special case in the sync loop — the loop asks the same
    question and gets the same shaped answer, with the differences (no deletions, a real coverage figure)
    stated in the payload rather than inferred from which provider answered.
    """

    class _RangeOnly(ProviderAdapter):
        provider = "rangeonly"

        def __init__(self):
            self.calls = []

        def connect(self, app_config, payload):
            raise NotImplementedError

        def fetch_accounts(self, app_config, credential):
            return []

        def fetch_transactions(self, app_config, credential, start_date=None, end_date=None):
            self.calls.append((start_date, end_date))
            return [{"external_transaction_id": "t-1", "external_account_id": "a-1", "amount": 1.0,
                     "merchant_name": "Shop", "raw_name": "SHOP", "date": "2026-01-01", "is_pending": False}]

        def remove(self, app_config, credential):
            pass

    def test_it_presents_a_window_as_one_complete_page(self):
        adapter = self._RangeOnly()
        page = adapter.fetch_transactions_sync({}, "cred", days_requested=30)
        self.assertEqual(len(page["added"]), 1)
        self.assertFalse(page["has_more"], "a range pull has nothing to page to")
        self.assertTrue(page["backfill_complete"])
        self.assertFalse(page["resume_later"])

    def test_removed_is_empty_because_the_provider_cannot_report_deletions(self):
        # Load-bearing: the empty list must never be read as the provider confirming nothing was deleted.
        self.assertEqual(self._RangeOnly().fetch_transactions_sync({}, "cred")["removed"], [])

    def test_it_reports_the_window_it_actually_fetched_per_targeted_account(self):
        adapter = self._RangeOnly()
        page = adapter.fetch_transactions_sync({}, "cred", days_requested=30, account_targets=[
            {"external_account_id": "acct-1", "from_date": "2020-01-01"},
        ])
        reached = (date.today() - timedelta(days=30)).isoformat()
        self.assertEqual(page["account_coverage"], {"acct-1": {"reached": reached, "complete": False}})

    def test_a_plain_range_pull_never_concludes_an_accounts_history_has_ended(self):
        # It returns what the range holds and says no more. Claiming completeness would stop a later,
        # deeper request from ever looking further back.
        adapter = self._RangeOnly()
        page = adapter.fetch_transactions_sync({}, "cred", days_requested=30, account_targets=[
            {"external_account_id": "acct-1", "from_date": "2020-01-01"},
        ])
        self.assertFalse(page["account_coverage"]["acct-1"]["complete"])

    def test_the_requested_depth_bounds_the_window(self):
        adapter = self._RangeOnly()
        adapter.fetch_transactions_sync({}, "cred", days_requested=7)
        start, end = adapter.calls[0]
        self.assertEqual((end - start).days, 7)


class GenericConnectTests(unittest.TestCase):
    """`POST /api/providers/{provider}/connect` — the entry point for a provider whose authorization is not
    a Link widget, and the proof that it lands in the same place Link does."""

    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    ACCESS_URL = "https://u:p@bridge.simplefin.org/simplefin"
    TOKEN = base64.b64encode(b"https://bridge.simplefin.org/simplefin/claim/DEMO-abc").decode()

    def _connect(self, client):
        with mock.patch("backend.services.providers.simplefin._http") as http:
            http.side_effect = [
                self.ACCESS_URL.encode(),                       # the claim POST
                json.dumps({"errlist": [], "accounts": [       # the balances-only accounts read
                    {"id": "2930002", "name": "Savings", "conn_id": "C1", "currency": "USD",
                     "balance": "1.00", "balance-date": 978366153},
                ], "connections": [{"conn_id": "C1", "org_name": "My Bank"}]}).encode(),
            ]
            return client.post("/api/providers/simplefin/connect",
                               json={"payload": {"setup_token": self.TOKEN}})

    def test_a_token_provider_connects_and_records_its_accounts(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = self._connect(client)
            self.assertEqual(r.status_code, 200, r.text)
            body = r.json()
            self.assertEqual(body["provider"], "simplefin")
            self.assertEqual(body["accounts_added"], 1)
            self.assertEqual(body["unmapped"], 1, "a fresh connect leaves the mapping decision to the user")

    def test_the_credential_is_vaulted_and_the_handle_is_not_the_credential(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect(client)
            with get_db() as conn:
                row = conn.execute("SELECT external_id, credential, credential_enc FROM connection").fetchone()
        self.assertTrue(row["external_id"].startswith("sfin_"))
        self.assertNotIn("bridge.simplefin.org", row["external_id"])
        self.assertEqual(row["credential"], "", "no plaintext credential may be stored")
        self.assertTrue(row["credential_enc"])

    def test_connecting_requires_an_unlocked_vault_like_every_other_provider(self):
        with api_client() as (client, _):
            r = self._connect(client)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"]["code"], "vault_not_configured")

    def test_connecting_is_refused_under_a_weak_slot_this_install_did_not_write(self):
        # The connect gate is unconditional now — it no longer asks the adapter whether *this* attempt is
        # live enough to deserve a strong passphrase, because every attempt is. Reaching it at all takes a
        # slot `set_passphrase` would refuse to create: an install carried in from before the floor, or a
        # future slot method that wraps the same DEK more weakly. That is the only remaining way the vault
        # can be weak, and it is what the gate is left standing for.
        #
        # Patched at `ready_for_production` rather than by fabricating that slot: its own answer to a weak
        # slot is pinned in test_vault.py, and what needs proving here is that connect consults it and
        # refuses — the seam, not the slot plumbing.
        real_token = base64.b64encode(b"https://bridge.simplefin.org/simplefin/claim/REAL-abc").decode()
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            with mock.patch.object(cs, "ready_for_production", return_value=False):
                r = client.post("/api/providers/simplefin/connect",
                                json={"payload": {"setup_token": real_token}})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"]["code"], "weak_vault")

    def test_a_provider_with_no_app_credential_reports_configured_once_connected(self):
        # "Configured" answers a different question for a provider with nothing to configure: it must not
        # sit in the add-a-data-source list forever, nor claim setup that never happened.
        with api_client() as (client, _):
            def _simplefin():
                return next(p for p in client.get("/api/providers").json()["providers"]
                            if p["provider"] == "simplefin")

            before = _simplefin()
            self.assertFalse(before["configured"])
            self.assertFalse(before["requires_app_config"])
            self.assertIsNone(before["env"], "no sandbox/production distinction to badge")
            self.assertEqual(before["connect_spec"]["style"], "token")

            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect(client)
            self.assertTrue(_simplefin()["configured"])

    def test_the_provider_list_carries_each_connections_sync_health(self):
        # The Connections card has to be able to report "this stopped working" while collapsed, so the
        # health travels with the connection list rather than behind a separate call a collapsed card
        # would have no reason to make.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect(client)
            with get_db() as conn:
                conn.execute(
                    "UPDATE connection SET last_synced_at = '2026-08-06T12:00:00Z',"
                    " last_sync_error = 'bank unavailable', consecutive_sync_failures = 4,"
                    " last_sync_warnings = ?", (json.dumps(["Other Bank: authentication required"]),),
                )
            connection = next(p for p in client.get("/api/providers").json()["providers"]
                              if p["provider"] == "simplefin")["connections"][0]
        self.assertEqual(connection["last_synced_at"], "2026-08-06T12:00:00Z")
        self.assertEqual(connection["last_sync_error"], "bank unavailable")
        self.assertEqual(connection["consecutive_sync_failures"], 4)
        self.assertEqual(connection["last_sync_warnings"], ["Other Bank: authentication required"])

    def test_a_provider_refusal_is_a_502_carrying_the_providers_own_message(self):
        # Not a 500. The provider refused or could not be reached, which is neither an internal fault nor
        # something the user should report as a bug — and the adapter's message is the only thing that says
        # what actually went wrong, so collapsing it into "Internal Server Error" is what turns a
        # five-second fix into a debugging session.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            with mock.patch("backend.services.providers.simplefin._http",
                            side_effect=SimpleFinError("SimpleFIN returned 403: error code: 1010.")):
                r = client.post("/api/providers/simplefin/connect",
                                json={"payload": {"setup_token": self.TOKEN}})
        self.assertEqual(r.status_code, 502, r.text)
        self.assertEqual(r.json()["detail"]["code"], "provider_error")
        self.assertIn("1010", r.json()["detail"]["message"])

    def test_configuring_a_provider_that_has_nothing_to_configure_is_refused(self):
        with api_client() as (client, _):
            r = client.post("/api/providers/simplefin/config", json={"client_id": "x", "secret": "y"})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"]["code"], "no_app_credential")

    def test_disconnect_succeeds_even_though_nothing_can_be_revoked(self):
        # SimpleFIN has no revocation call, so remove() is a no-op. Disconnect must still drop the local
        # connection rather than fail — the part that did not happen is carried in the UI's confirm copy.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            external_id = self._connect(client).json() and None
            with get_db() as conn:
                external_id = conn.execute("SELECT external_id FROM connection").fetchone()["external_id"]
            r = client.post("/api/providers/simplefin/disconnect", json={"external_id": external_id})
            self.assertEqual(r.status_code, 200, r.text)
            simplefin = next(p for p in client.get("/api/providers").json()["providers"]
                             if p["provider"] == "simplefin")
            self.assertEqual(len(simplefin["connections"]), 0)


class CredentialBackupTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _connect_one(self, client):
        # Exchange now resolves the provider's app credential (phase 6b), so Plaid must be configured
        # first (the vault is unlocked by set-passphrase, so the secret can be vaulted).
        client.post("/api/providers/plaid/config", json={"client_id": "cid-1", "secret": "app-secret-1"})
        with mock.patch("backend.services.plaid_service.exchange_public_token",
                        return_value={"access_token": "access-sandbox-xyz", "item_id": "item-1"}), \
             mock.patch("backend.services.plaid_service.fetch_accounts", return_value=[
                 {"plaid_account_id": "acct-1", "name": "Checking", "official_name": "Total Checking",
                  "type": "depository", "subtype": "checking", "mask": "0000"}
             ]):
            r = client.post("/api/plaid/exchange", json={"public_token": "public-1", "institution_name": "Test Bank"})
        self.assertEqual(r.status_code, 200, r.text)
        # Connecting records what the bank offers but creates no local account — the mapping step does
        # (see services/connection_mapping.py). These tests are about the credential/connection seam, so
        # they run the real two-step flow and take the plain "create a new account" choice. A re-connect
        # reports `unmapped: 0` (the handle is already adopted) and needs no second mapping call.
        connection_id = r.json()["connection_id"]
        if r.json()["unmapped"]:
            mapped = client.post(
                f"/api/connections/{connection_id}/account-map",
                json={"mappings": {"acct-1": {"mode": "new", "name": "Checking"}}},
            )
            self.assertEqual(mapped.status_code, 200, mapped.text)

    def test_disconnect_revokes_at_provider_and_removes_the_connection(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect_one(client)
            plaid = next(p for p in client.get("/api/providers").json()["providers"] if p["provider"] == "plaid")
            self.assertEqual(len(plaid["connections"]), 1)

            with mock.patch("backend.services.plaid_service.remove_item") as remove_item:
                r = client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})
            self.assertEqual(r.status_code, 200, r.text)
            remove_item.assert_called_once()  # revoked provider-side, not just deleted locally

            plaid = next(p for p in client.get("/api/providers").json()["providers"] if p["provider"] == "plaid")
            self.assertEqual(len(plaid["connections"]), 0)

            # The account survives the disconnect (its rows are kept); its connection_id drops to NULL via
            # the account.connection_id → connection(id) ON DELETE SET NULL FK — it's just no longer linked.
            accounts = client.get("/api/accounts").json()
            acct = next(a for a in accounts if a["name"] == "Checking")
            self.assertIsNone(acct["connection_id"])

    def test_exchange_writes_a_connection_and_status_counts_it(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect_one(client)
            status = client.get("/api/import-export/backup/credentials/status").json()
            self.assertTrue(status["has_credentials"])
            # 1 connection + 1 provider_config (the app credential _connect_one saves): both are vaulted
            # secrets the credentials backup carries.
            self.assertEqual(status["credential_count"], 2)

    def test_repeated_exchange_is_idempotent(self):
        # A user can complete Plaid Link more than once for the same bank (onSuccess double-fire, re-link),
        # which re-exchanges to the same item_id. That must upsert cleanly (200), not 500 on the connection's
        # UNIQUE(provider, external_id) or the account's UNIQUE(external_account_id).
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect_one(client)
            self._connect_one(client)  # second exchange for the same item — must not raise
            plaid = next(p for p in client.get("/api/providers").json()["providers"] if p["provider"] == "plaid")
            self.assertEqual(len(plaid["connections"]), 1)  # de-duplicated, not a second connection
            checking = [a for a in client.get("/api/accounts").json() if a["name"] == "Checking"]
            self.assertEqual(len(checking), 1)  # account not duplicated either
            self.assertIsNotNone(checking[0]["connection_id"])  # re-stamped to the (single) connection

    def test_reexchange_reattaches_a_disconnected_account(self):
        # Reconnecting a bank whose accounts were left dangling by a prior disconnect (connection_id NULL)
        # re-attaches them: the account upsert re-stamps connection_id on conflict.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect_one(client)
            with mock.patch("backend.services.plaid_service.remove_item"):
                client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})
            self.assertIsNone(next(a for a in client.get("/api/accounts").json() if a["name"] == "Checking")["connection_id"])
            self._connect_one(client)  # reconnect the same bank
            self.assertIsNotNone(next(a for a in client.get("/api/accounts").json() if a["name"] == "Checking")["connection_id"])

    def _stored_token(self, client, external_id="item-1") -> str:
        """What a stored connection credential decrypts to under this install's DEK. The export no
        longer reveals plaintext, so the round trip is verified against the ledger instead of the file."""
        user_id = client.get("/api/auth/status").json()["user"]["id"]
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM connection WHERE external_id = ?", (external_id,)
            ).fetchone()
        with in_browser_session(client):
            return cs.decrypt_connection_credential(
                {"id": user_id}, "plaid", external_id, row["credential"], row["credential_enc"],
            )

    def test_credentials_export_restore_roundtrip(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._connect_one(client)

            exported = client.get("/api/import-export/backup/credentials")
            self.assertEqual(exported.status_code, 200)
            payload = read_payload_bytes(exported.content)
            # The export carries CIPHERTEXT plus the vault material that reopens it — the token itself
            # must not be in the file (see routers/import_export/backup.py::export_credentials).
            self.assertEqual(payload["version"], 4)
            self.assertEqual(payload["connections"][0]["provider"], "plaid")
            self.assertNotIn("access-sandbox-xyz", json.dumps(payload))
            self.assertTrue(payload["connections"][0]["credential_enc"])
            self.assertTrue(payload["vault"]["sealed_dek"])

            restored = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertEqual(restored.json()["restored"], 2)  # 1 connection + 1 provider_config
            self.assertEqual(self._stored_token(client), "access-sandbox-xyz",
                             "the restored credential still decrypts to the original secret")

    def test_restore_accepts_legacy_v1_plaid_items(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            # A pre-6a credentials export: version 1, plaid_items shape. The content hash is only verified
            # when present, so a hand-built legacy payload without it restores (matching old exports that
            # predate the hash field).
            legacy = {"version": 1, "plaid_items": [{"item_id": "item-legacy", "access_token": "tok-legacy"}]}
            restored = client.post("/api/import-export/restore/credentials", json={"data": legacy})
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertEqual(restored.json()["restored"], 1)
            again = read_payload_bytes(client.get("/api/import-export/backup/credentials").content)
            self.assertEqual(again["connections"][0]["provider"], "plaid")
            self.assertEqual(self._stored_token(client, "item-legacy"), "tok-legacy",
                             "a legacy plaintext payload is vaulted on the way in")
            self.assertEqual(again["connections"][0]["external_id"], "item-legacy")
            # Round-tripping a v1 file UPGRADES it: what was plaintext on the way in comes back out as
            # ciphertext, so the legacy artifact is not reproduced.
            self.assertEqual(again["connections"][0]["credential"], "")
            self.assertTrue(again["connections"][0]["credential_enc"])


if __name__ == "__main__":
    unittest.main()
