"""
Connection account mapping — the data-source analog of a CSV import's account step.

The behavior that matters here is not "a row got written": it is that each mapping mode produces the
*relationship* duplicate detection depends on. So these tests assert on what the dedupe ladder would
receive (`dedupe_inputs_for_connection`), on the account rows each mode does or does not create, and
on the two properties that only exist because the mapping is durable: a skipped provider account
stays skipped across a refresh, and re-applying an unchanged mapping is a no-op rather than a
duplicate-account generator.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db import control_database as cdb
from backend.db import database
from backend.routers import connections as connections_router
from backend.routers.accounts import upsert_connection_accounts
from backend.services.connection_mapping import (
    MAPPING_MODES,
    apply_account_mapping,
    dedupe_inputs_for_connection,
    list_connection_accounts,
    provider_account_label,
    record_provider_accounts,
    unmapped_count,
)


@contextmanager
def _isolated_db():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    database.init_db(data_path)
    try:
        yield data_path
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        tmp.cleanup()


PROVIDER_ACCOUNTS = [
    {"external_account_id": "ext-checking", "name": "CHECKING", "official_name": "Total Checking",
     "type": "depository", "subtype": "checking", "mask": "1111"},
    {"external_account_id": "ext-card", "name": "CREDIT CARD", "official_name": "Voyager Unlimited",
     "type": "credit", "subtype": "credit card", "mask": "4103"},
]


class ConnectionAccountMappingTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_db()
        self.data_path = self._stack.__enter__()
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, institution) VALUES (?,?,?,?)",
                ("conn-1", "plaid", "item-1", "Chase"),
            )
            self.owner_id = conn.execute("SELECT id FROM owner LIMIT 1").fetchone()["id"]

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    # ---- helpers -------------------------------------------------------

    def _existing_account(self, conn, account_id, name, **kw):
        conn.execute(
            "INSERT INTO account (id, name, display_name, type, owner_id, provider) VALUES (?,?,?,?,?,?)",
            (account_id, name, kw.get("display_name", name), kw.get("type", "credit"),
             self.owner_id, kw.get("provider", "csv")),
        )

    def _record(self, conn):
        record_provider_accounts(conn, connection_id="conn-1", accounts=PROVIDER_ACCOUNTS)

    def _apply(self, conn, mappings):
        return apply_account_mapping(
            conn, connection_id="conn-1", provider="plaid", institution="Chase",
            mappings=mappings, default_owner_id=self.owner_id,
        )

    # ---- recording -----------------------------------------------------

    def test_connecting_records_provider_accounts_without_creating_any(self):
        # The core behavior change: connecting no longer materializes local accounts. Nothing is
        # created until the user has said what each provider account *is*.
        with database.get_db() as conn:
            upsert_connection_accounts(
                conn, connection_id="conn-1", provider="plaid", institution="Chase",
                accounts=PROVIDER_ACCOUNTS, default_owner_id=self.owner_id,
            )
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 0)
            self.assertEqual(unmapped_count(conn, "conn-1"), 2)
            rows = list_connection_accounts(conn, "conn-1")
            self.assertEqual({r["source_label"] for r in rows},
                             {"CHECKING ···1111", "CREDIT CARD ···4103"})
            self.assertTrue(all(not r["mapped"] for r in rows))

    def test_the_account_currency_is_recorded_and_its_verdict_travels_with_the_row(self):
        # Recorded before any mapping decision so the mapping grid can warn rather than let the user create
        # an account whose transactions are all discarded. The *verdict* is computed server-side so the
        # client never has to know which currencies the ledger can hold.
        with database.get_db() as conn:
            record_provider_accounts(conn, connection_id="conn-1", accounts=[
                {"external_account_id": "ext-usd", "name": "Checking", "currency": "USD"},
                {"external_account_id": "ext-eur", "name": "Travel", "currency": "EUR"},
                {"external_account_id": "ext-none", "name": "Quiet"},
            ])
            rows = {r["external_account_id"]: r for r in list_connection_accounts(conn, "conn-1")}
        self.assertEqual(rows["ext-eur"]["provider_currency"], "EUR")
        self.assertFalse(rows["ext-eur"]["currency_supported"])
        self.assertTrue(rows["ext-usd"]["currency_supported"])
        # A provider that states nothing is not thereby suspect: the field is optional, so absence means
        # "not stated". Rejecting the account would discard real data over a formatting gap.
        self.assertIsNone(rows["ext-none"]["provider_currency"])
        self.assertTrue(rows["ext-none"]["currency_supported"])

    def test_a_refresh_updates_a_currency_that_changed(self):
        # `provider_currency` is provider-reported detail, not a user decision, so it is overwritten by a
        # refresh like the other provider_* columns — an account redenominated at the bank must not keep
        # being judged on a stale value.
        with database.get_db() as conn:
            record_provider_accounts(conn, connection_id="conn-1", accounts=[
                {"external_account_id": "ext-1", "name": "Travel", "currency": "EUR"},
            ])
            record_provider_accounts(conn, connection_id="conn-1", accounts=[
                {"external_account_id": "ext-1", "name": "Travel", "currency": "USD"},
            ])
            row = list_connection_accounts(conn, "conn-1")[0]
        self.assertEqual(row["provider_currency"], "USD")
        self.assertTrue(row["currency_supported"])

    def test_provider_label_falls_back_when_name_or_mask_missing(self):
        with database.get_db() as conn:
            record_provider_accounts(conn, connection_id="conn-1", accounts=[
                {"external_account_id": "ext-bare", "name": None, "official_name": None,
                 "type": None, "subtype": None, "mask": None},
            ])
            row = next(r for r in conn.execute(
                "SELECT * FROM connection_account WHERE external_account_id = 'ext-bare'"))
            # No name and no mask: the external id is the last resort, so the label is never empty
            # (an empty source value would collide with a single-account CSV's "" and silently merge
            # two unrelated sources' coverage).
            self.assertEqual(provider_account_label(row), "ext-bare")

    # ---- modes ---------------------------------------------------------

    def test_existing_adopts_the_account_and_creates_nothing(self):
        with database.get_db() as conn:
            self._existing_account(conn, "acct-csv", "Northgate Voyager")
            self._record(conn)
            result = self._apply(conn, {"ext-card": {"mode": "existing", "target_account_id": "acct-csv"}})

            self.assertEqual(result["linked"], ["acct-csv"])
            self.assertEqual(result["created"], [])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 1)
            acc = conn.execute("SELECT * FROM account WHERE id = 'acct-csv'").fetchone()
            self.assertEqual(acc["external_account_id"], "ext-card")
            self.assertEqual(acc["connection_id"], "conn-1")
            # The account is provider-fed now, whatever created it.
            self.assertEqual(acc["provider"], "plaid")

    def test_existing_makes_the_receiving_account_its_own_compare_target(self):
        # Mapping onto an account means the coverage the ladder should consult is that account's own,
        # so the compare target is the account itself and the label counts as an explicit alias.
        with database.get_db() as conn:
            self._existing_account(conn, "acct-csv", "Northgate Voyager")
            self._record(conn)
            self._apply(conn, {"ext-card": {"mode": "existing", "target_account_id": "acct-csv"}})
            inputs = dedupe_inputs_for_connection(conn, "conn-1")

            label = "CREDIT CARD ···4103"
            self.assertEqual(inputs["account_by_source_value"], {label: "acct-csv"})
            self.assertEqual(inputs["compare_targets"], {label: "acct-csv"})
            self.assertIn(label, inputs["alias_values"])

    def test_group_nests_under_the_parent_but_is_not_an_alias(self):
        # A sibling in a linked group is a DIFFERENT physical account, so it gets the group's compare
        # target (exact-hash matches resolve across the group, as a CSV import's group attachment does)
        # but NOT alias status — an alias would let the coverage rules fire across the pair and
        # over-collapse genuinely distinct rows.
        with database.get_db() as conn:
            self._existing_account(conn, "acct-parent", "Northgate Voyager")
            self._record(conn)
            result = self._apply(conn, {"ext-card": {"mode": "group", "target_account_id": "acct-parent"}})

            new_id = result["created"][0]
            self.assertEqual(conn.execute(
                "SELECT parent_account_id FROM account WHERE id = ?", (new_id,)
            ).fetchone()["parent_account_id"], "acct-parent")

            inputs = dedupe_inputs_for_connection(conn, "conn-1")
            self.assertEqual(inputs["compare_targets"], {"CREDIT CARD ···4103": "acct-parent"})
            self.assertEqual(inputs["alias_values"], set())

    def test_group_nests_under_the_target_s_root_not_a_child_target(self):
        # The grouping model is one level deep — every scope is `COALESCE(parent_account_id, id)` — so
        # nesting under an account that is itself a child would put the row in a scope nothing else
        # resolves to. Picking a child means picking its group.
        with database.get_db() as conn:
            self._existing_account(conn, "acct-root", "Northgate Voyager")
            self._existing_account(conn, "acct-child", "Old Statement Card")
            conn.execute("UPDATE account SET parent_account_id = 'acct-root' WHERE id = 'acct-child'")
            self._record(conn)
            result = self._apply(conn, {"ext-card": {"mode": "group", "target_account_id": "acct-child"}})

            self.assertEqual(conn.execute(
                "SELECT parent_account_id FROM account WHERE id = ?", (result["created"][0],)
            ).fetchone()["parent_account_id"], "acct-root")

    def test_compare_is_not_a_mapping_mode(self):
        # Removed deliberately: "keep a separate account, but hard-dedupe it against an existing one"
        # had no analogue anywhere else in the app and asserted two accounts were the same physical
        # account while keeping them apart. 'existing' says that properly; 'group' says "related".
        self.assertNotIn("compare", MAPPING_MODES)
        with database.get_db() as conn:
            self._existing_account(conn, "acct-csv", "Northgate Voyager")
            self._record(conn)
            result = self._apply(conn, {"ext-card": {"mode": "compare", "target_account_id": "acct-csv"}})
            self.assertEqual(result["created"], [])
            self.assertFalse(result["changed"])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 1)

    def test_new_creates_a_plain_account_with_no_relationship(self):
        with database.get_db() as conn:
            self._record(conn)
            result = self._apply(conn, {"ext-checking": {"mode": "new", "name": "My Checking"}})

            new_id = result["created"][0]
            acc = conn.execute("SELECT * FROM account WHERE id = ?", (new_id,)).fetchone()
            self.assertEqual(acc["name"], "My Checking")
            self.assertEqual(acc["mask"], "1111")
            self.assertIsNone(acc["parent_account_id"])
            self.assertEqual(dedupe_inputs_for_connection(conn, "conn-1")["alias_values"], set())

    # ---- skip, the decision only this table can hold -------------------

    def test_skip_creates_no_account_and_is_excluded_from_dedupe_inputs(self):
        with database.get_db() as conn:
            self._record(conn)
            self._apply(conn, {"ext-checking": {"mode": "skip"}})

            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 0)
            inputs = dedupe_inputs_for_connection(conn, "conn-1")
            self.assertEqual(inputs["source_values"], [])

    def test_skip_survives_a_refresh_accounts_pass(self):
        # The regression this table exists to prevent: without a remembered decision, every refresh
        # re-creates an account the user already rejected.
        with database.get_db() as conn:
            self._record(conn)
            self._apply(conn, {"ext-checking": {"mode": "skip"}})
            upsert_connection_accounts(
                conn, connection_id="conn-1", provider="plaid", institution="Chase",
                accounts=PROVIDER_ACCOUNTS, default_owner_id=self.owner_id,
            )
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 0)
            row = conn.execute(
                "SELECT mapping_mode FROM connection_account WHERE external_account_id = 'ext-checking'"
            ).fetchone()
            self.assertEqual(row["mapping_mode"], "skip")

    # ---- idempotence and remapping -------------------------------------

    def test_reapplying_an_unchanged_mapping_creates_no_second_account(self):
        with database.get_db() as conn:
            self._record(conn)
            first = self._apply(conn, {"ext-card": {"mode": "new", "name": "Card"}})
            second = self._apply(conn, {"ext-card": {"mode": "new", "name": "Card"}})

            self.assertEqual(len(first["created"]), 1)
            self.assertEqual(second["created"], [], "re-application must adopt, not duplicate")
            self.assertFalse(second["changed"])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 1)

    def test_switching_a_linked_account_to_group_nests_the_account_it_already_had(self):
        # A provider account already adopted onto a local account carries that account's synced
        # history. Choosing 'group' later changes how it is GROUPED, not which account it is —
        # creating a fresh one would strand every transaction already synced under the old one, on an
        # account with no provider linkage left to bring them back.
        with database.get_db() as conn:
            self._existing_account(conn, "acct-plaid", "CREDIT CARD", provider="plaid")
            conn.execute("UPDATE account SET external_account_id = 'ext-card', connection_id = 'conn-1'"
                         " WHERE id = 'acct-plaid'")
            self._existing_account(conn, "acct-parent", "Northgate Voyager")
            self._record(conn)

            self._apply(conn, {"ext-card": {"mode": "group", "target_account_id": "acct-parent"}})

            self.assertEqual(conn.execute(
                "SELECT parent_account_id FROM account WHERE id = 'acct-plaid'"
            ).fetchone()["parent_account_id"], "acct-parent")
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 2)

    def test_refresh_reapplies_group_parent_after_the_account_is_gone(self):
        # A restore rolls back accounts but never connections. Re-applying must rebuild the same
        # relationship, which is only possible because the target is stored on the mapping row rather
        # than inferred from the account it produced.
        with database.get_db() as conn:
            self._existing_account(conn, "acct-parent", "Northgate Voyager")
            self._record(conn)
            created = self._apply(conn, {"ext-card": {"mode": "group", "target_account_id": "acct-parent"}})["created"][0]
            conn.execute("DELETE FROM account WHERE id = ?", (created,))

            upsert_connection_accounts(
                conn, connection_id="conn-1", provider="plaid", institution="Chase",
                accounts=PROVIDER_ACCOUNTS, default_owner_id=self.owner_id,
            )
            rebuilt = conn.execute(
                "SELECT * FROM account WHERE external_account_id = 'ext-card'"
            ).fetchone()
            self.assertIsNotNone(rebuilt, "refresh must rebuild the account the mapping describes")
            self.assertEqual(rebuilt["parent_account_id"], "acct-parent")

    def test_remapping_to_a_different_account_moves_the_provider_handle(self):
        # account.external_account_id is UNIQUE, so a remap must release the handle from the old
        # account first or the update trips the constraint.
        with database.get_db() as conn:
            self._existing_account(conn, "acct-a", "Account A")
            self._existing_account(conn, "acct-b", "Account B")
            self._record(conn)
            self._apply(conn, {"ext-card": {"mode": "existing", "target_account_id": "acct-a"}})
            result = self._apply(conn, {"ext-card": {"mode": "existing", "target_account_id": "acct-b"}})

            self.assertTrue(result["changed"])
            self.assertIsNone(conn.execute(
                "SELECT external_account_id FROM account WHERE id = 'acct-a'").fetchone()["external_account_id"])
            self.assertEqual(conn.execute(
                "SELECT external_account_id FROM account WHERE id = 'acct-b'").fetchone()["external_account_id"],
                "ext-card")

    def test_unknown_external_id_is_ignored_rather_than_inventing_an_account(self):
        with database.get_db() as conn:
            self._record(conn)
            result = self._apply(conn, {"ext-nope": {"mode": "new", "name": "Ghost"}})
            self.assertEqual(result["created"], [])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM account").fetchone()["n"], 0)


class AccountsAwaitingHistoryTests(unittest.TestCase):
    """Which accounts still hold no history — derived from coverage rather than tracked separately.

    Every account present during a history pull came away with a `coverage_start_date`, so a mapped account
    that still has none either joined the connection later or has never been backfilled. Both want the same
    thing, so no flag has to be set anywhere and nothing can drift out of step with the data.
    """

    def setUp(self):
        self._stack = _isolated_db()
        self.data_path = self._stack.__enter__()
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, institution) "
                "VALUES ('conn-1','simplefin','sfin_x','SimpleFIN Bridge')"
            )
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id) "
                "VALUES ('acct-1','A','A','credit', (SELECT id FROM owner LIMIT 1))"
            )

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    def _row(self, conn, external_id, *, mode, coverage, account_id="acct-1"):
        conn.execute(
            "INSERT INTO connection_account (connection_id, external_account_id, account_id, "
            "mapping_mode, coverage_start_date) VALUES ('conn-1', ?, ?, ?, ?)",
            (external_id, account_id, mode, coverage),
        )

    def _awaiting(self, conn):
        return connections_router._accounts_awaiting_history(conn, "conn-1")

    def test_a_mapped_account_with_no_coverage_is_awaiting_history(self):
        with database.get_db() as conn:
            self._row(conn, "simplefin:old", mode="new", coverage="2026-02-01")
            self._row(conn, "simplefin:new", mode="new", coverage=None)
            self.assertEqual(self._awaiting(conn), ["simplefin:new"])

    def test_an_account_that_already_has_coverage_is_not(self):
        with database.get_db() as conn:
            self._row(conn, "simplefin:old", mode="new", coverage="2026-02-01")
            self.assertEqual(self._awaiting(conn), [])

    def test_a_skipped_account_is_never_awaiting_history(self):
        # Nothing to fill: `skip` means the user declined it a destination.
        with database.get_db() as conn:
            self._row(conn, "simplefin:skipped", mode="skip", coverage=None, account_id=None)
            self.assertEqual(self._awaiting(conn), [])

    def test_an_undecided_account_is_not_awaiting_history_either(self):
        # It has nowhere to put transactions yet; the mapping decision comes first.
        with database.get_db() as conn:
            self._row(conn, "simplefin:undecided", mode=None, coverage=None, account_id=None)
            self.assertEqual(self._awaiting(conn), [])


if __name__ == "__main__":
    unittest.main()
