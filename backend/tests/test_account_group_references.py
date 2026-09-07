"""
Stored account references survive a merge.

Merging account B into account A leaves B alive as a child and rewrites nothing that points at B, so
every account id stored elsewhere becomes a reference into a graph that moved under it. Rows resolve
to their group root; a stored id that is compared *raw* against that therefore stops selecting
anything the moment its account is merged — a rule quietly stops firing, an Amazon order quietly stops
finding its charge, and nothing errors or looks wrong (see `services/account_groups.py`).

Two layers here:

  * `AccountReferenceRegistryTests` derives every FK into `account(id)` from the schema and fails until
    each one is classified in `ACCOUNT_REFERENCE_KINDS`. It cannot tell whether a classification is
    *right*, only that the decision was made deliberately — which is the part that gets skipped.
  * The behavior tests below prove the `scope` classifications actually hold, by merging the referenced
    account and asserting the reference still resolves. Each fails on the pre-fix code.

All data here is fabricated.
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
from backend.routers.import_export.amazon import _charge_accounts, find_matching_charge
from backend.services import amazon_funding
from backend.services.account_groups import (
    account_group_member_ids,
    effective_account_id,
    effective_account_ids,
)
from backend.services.amazon_import import OrderDisposition
from backend.services.categorizer import recategorize_all
from backend.services.recurring_detection import link_series_members


# Every foreign key into `account(id)`, and what kind of reference it is. A new one must be added here
# with a deliberate choice, because the two kinds behave oppositely when the account is merged:
#
#   scope      — names a set of transactions to match against. MUST be resolved to the group root at
#                read time, or the reference silently matches nothing after a merge.
#   specific   — names one account row for its own sake, not as a matching scope. Left raw on purpose;
#                the merge is meant to change what it means (or to stop it applying) until detach.
#   structural — defines the grouping itself.
ACCOUNT_REFERENCE_KINDS = {
    # The grouping relation.
    ("account", "parent_account_id"): "structural",
    # The row side of every account comparison — resolved by `effective_account_id_sql`.
    ("txn", "account_id"): "scope",
    # Matching scopes: resolved at read time.
    ("category_rule", "account_id"): "scope",
    ("recurring_series", "account_id"): "scope",
    # The far account of a two-legged money movement. A matching scope like the near one: pairing
    # compares it against the row side's already-resolved account, so it has to resolve too or a merge
    # would leave the movement matching nothing at all.
    ("recurring_series", "counterpart_account_id"): "scope",
    ("amazon_funding_map", "funding_account_id"): "scope",
    ("amazon_funding_map", "amazon_account_id"): "scope",
    # Dedupe coverage: `duplicate_detection.scope_id_for` resolves it through the group root before
    # comparing, so a batch's coverage keeps applying to the account it was merged into.
    ("import_batch_account", "account_id"): "scope",
    # A tag attached to one account row. A merged child's tags are deliberately dormant until it is
    # detached (`services/transaction_tags.py`), so this must NOT be resolved.
    ("account_tag", "account_id"): "specific",
    # "These two accounts are distinct" assertions, about the account rows themselves. A merge
    # contradicts the assertion and `clear_account_pair_distinct_for_merge` deletes the row outright,
    # so there is nothing left to resolve.
    ("account_pair_distinct", "account_id_low"): "specific",
    ("account_pair_distinct", "account_id_high"): "specific",
    # Write targets: where a source's rows are inserted. A merged child is a legitimate target — its
    # rows roll up to the parent through the row side — so the raw id keeps meaning what it said.
    ("connection_account", "account_id"): "specific",
    ("connection_account", "target_account_id"): "specific",
    ("csv_import_profile", "account_id"): "specific",
}


def _account_foreign_keys(conn) -> set:
    found = set()
    for table in [
        r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    ]:
        for fk in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall():
            if fk["table"] == "account":
                found.add((table, fk["from"]))
    return found


class _GroupFixture(unittest.TestCase):
    """A ledger with two same-type accounts that can be merged mid-test."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "account-groups.db"
        init_db(str(self.db_path))
        self.legacy = self._insert_account("Legacy Card", mask="1111")
        self.current = self._insert_account("Rewards Card", mask="4455")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name: str, *, mask: str | None = None) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account
                     (id, external_account_id, provider, name, display_name, type, mask, owner_id)
                   VALUES (?, ?, 'fixture', ?, ?, 'credit', ?, ?)""",
                (account_id, f"ext_{account_id}", name, name, mask, SHARED_OWNER_ID),
            )
        return account_id

    def _merge_legacy_into_current(self):
        """The state `POST /accounts/{id}/attach` leaves behind: the child stays, nothing else moves."""
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE account SET parent_account_id = ?, display_name = 'Rewards Card' WHERE id = ?",
                (self.current, self.legacy),
            )

    def _insert_txn(self, *, account_id: str, name: str, amount: float, date: str) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name,
                      raw_name, date, is_pending, category_overridden)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0)""",
                (txn_id, account_id, SHARED_OWNER_ID, amount, name, name, name, date),
            )
        return txn_id

    def _leaf_category(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE name = 'Income' AND parent_id IS NULL"
            ).fetchone()
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, 'income', 0)",
                (category_id, group["id"], name),
            )
        return category_id


class AccountReferenceRegistryTests(_GroupFixture):
    def test_every_account_foreign_key_is_classified(self):
        with self._use_db_path(), get_db() as conn:
            found = _account_foreign_keys(conn)
        unclassified = found - set(ACCOUNT_REFERENCE_KINDS)
        self.assertEqual(
            unclassified,
            set(),
            "New foreign key(s) into account(id) must be classified in ACCOUNT_REFERENCE_KINDS: a "
            "'scope' reference has to resolve through the group root at read time or it will silently "
            "stop matching after a merge. See backend/services/account_groups.py.",
        )

    def test_registry_has_no_entries_for_dropped_columns(self):
        with self._use_db_path(), get_db() as conn:
            found = _account_foreign_keys(conn)
        self.assertEqual(set(ACCOUNT_REFERENCE_KINDS) - found, set())


class AccountGroupResolutionTests(_GroupFixture):
    def test_root_resolves_to_itself_and_child_resolves_to_root(self):
        self._merge_legacy_into_current()
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(effective_account_id(conn, self.legacy), self.current)
            self.assertEqual(effective_account_id(conn, self.current), self.current)
            self.assertEqual(
                effective_account_ids(conn, [self.legacy, self.current]),
                {self.legacy: self.current, self.current: self.current},
            )
            self.assertEqual(
                account_group_member_ids(conn, [self.legacy]), {self.legacy, self.current}
            )

    def test_unknown_id_is_returned_unchanged_and_blank_is_none(self):
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(effective_account_id(conn, "no-such-account"), "no-such-account")
            self.assertIsNone(effective_account_id(conn, None))
            self.assertIsNone(effective_account_id(conn, "   "))

    def test_parent_cycle_terminates(self):
        # Not reachable through the API (attach refuses a parent that is itself a child), but a corrupt
        # pair must not spin forever inside a request.
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (self.current, self.legacy))
            conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (self.legacy, self.current))
            self.assertIsNotNone(effective_account_id(conn, self.legacy))


class RuleScopeSurvivesMergeTests(_GroupFixture):
    def test_rule_pinned_to_merged_account_still_categorizes_the_group(self):
        category_id = self._leaf_category("Streaming")
        rule_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO category_rule (id, category_id, keyword, owner_id, account_id)
                   VALUES (?, ?, 'fablestream', NULL, ?)""",
                (rule_id, category_id, self.legacy),
            )
        self._merge_legacy_into_current()

        # A charge arriving on the surviving account after the merge — the ordinary case once a reissued
        # card starts syncing into the account the old one was merged into.
        txn_id = self._insert_txn(
            account_id=self.current, name="FABLESTREAM MONTHLY", amount=12.99, date="2026-05-02"
        )
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(recategorize_all(conn), 1)
            row = conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        self.assertEqual(row["category_id"], category_id)


class RecurringScopeSurvivesMergeTests(_GroupFixture):
    def test_series_scoped_to_merged_account_still_claims_the_group_rows(self):
        series_id = str(uuid.uuid4())
        for day in ("2026-03-04", "2026-04-04", "2026-05-04"):
            self._insert_txn(account_id=self.current, name="Fablegym", amount=44.0, date=day)
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO recurring_series
                     (id, payee_key, display_name, category_id, account_id, cadence, period_days,
                      expected_amount, status, source, confirmed, updated_at)
                   VALUES (?, 'fablegym', 'Fablegym', NULL, ?, 'monthly', 30, 44.0,
                           'active', 'manual', 1, datetime('now'))""",
                (series_id, self.legacy),
            )
        self._merge_legacy_into_current()

        with self._use_db_path(), get_db() as conn:
            self.assertEqual(link_series_members(conn, series_id), 3)


class AmazonFundingScopeSurvivesMergeTests(_GroupFixture):
    """The reported bug: a funding map written before the paying card was merged into its replacement."""

    def _amazon_account(self) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES (?, ?, 'fixture', 'Amazon', 'Amazon', 'amazon', ?)""",
                (account_id, f"ext_{account_id}", SHARED_OWNER_ID),
            )
        return account_id

    def _disposition(self) -> OrderDisposition:
        return OrderDisposition(
            kind="cash", net_cash=84.89, charge_amount=84.89, match_last4="4455",
            match_date="2026-07-21", match_network="Fablecard",
        )

    def test_mapped_card_still_finds_its_charge_after_the_card_is_merged(self):
        amazon_account = self._amazon_account()
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(
                conn, last4="4455", network="Fablecard", funding_account_id=self.legacy
            )
        self._merge_legacy_into_current()
        charge_id = self._insert_txn(
            account_id=self.current, name="Amazon", amount=84.89, date="2026-07-21"
        )

        with self._use_db_path(), get_db() as conn:
            funding = amazon_funding.resolve_funding_account(conn, amazon_account, "4455", "Fablecard")
            self.assertEqual(funding.state, "mapped")
            found = find_matching_charge(
                conn, self._disposition(),
                exclude_account_id=amazon_account,
                restrict_account_id=funding.funding_account_id,
            )
        self.assertEqual(found, charge_id)

    def test_charge_pool_covers_the_group_the_mapped_card_joined(self):
        # The report's split-suggestion / unaccounted-charge pool is an `account_id IN (...)` list, so a
        # mapped account that became a child has to expand to its group or the charge is invisible even
        # as a suggestion.
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(
                conn, last4="4455", network="Fablecard", funding_account_id=self.legacy
            )
        self._merge_legacy_into_current()
        with self._use_db_path(), get_db() as conn:
            self.assertIn(self.current, _charge_accounts(conn, set()))

    def test_per_amazon_account_override_survives_merging_the_amazon_account(self):
        amazon_account = self._amazon_account()
        old_amazon_account = self._amazon_account()
        with self._use_db_path(), get_db() as conn:
            # Global row points elsewhere; the override is what must keep winning.
            amazon_funding.upsert_funding_source(
                conn, last4="4455", network="Fablecard", untracked=True
            )
            amazon_funding.upsert_funding_source(
                conn, last4="4455", network="Fablecard",
                funding_account_id=self.current, amazon_account_id=old_amazon_account,
            )
            conn.execute(
                "UPDATE account SET parent_account_id = ? WHERE id = ?",
                (amazon_account, old_amazon_account),
            )
            funding = amazon_funding.resolve_funding_account(conn, amazon_account, "4455", "Fablecard")
        self.assertEqual(funding.state, "mapped")
        self.assertEqual(funding.funding_account_id, self.current)

    def test_charge_on_the_amazon_account_group_is_never_the_match(self):
        # The exclusion is a group exclusion too: an order row sitting on a merged child of the Amazon
        # account must not be mistaken for the card charge.
        amazon_account = self._amazon_account()
        old_amazon_account = self._amazon_account()
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE account SET parent_account_id = ? WHERE id = ?",
                (amazon_account, old_amazon_account),
            )
        self._insert_txn(account_id=old_amazon_account, name="Amazon", amount=84.89, date="2026-07-21")
        with self._use_db_path(), get_db() as conn:
            found = find_matching_charge(
                conn, self._disposition(), exclude_account_id=amazon_account, restrict_account_id=None,
            )
        self.assertIsNone(found)


if __name__ == "__main__":
    unittest.main()
