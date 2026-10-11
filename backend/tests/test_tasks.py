"""
Coverage for the Tasks "uncategorized transactions" count.

The count is meant to mirror the work the user can actually act on in the Transactions list:
real, settled, live rows that lack a category. So it excludes pending transactions (the rest
of the product keeps them out of categorization chores) and trashed rows (they no longer
appear in any list the task links to). These tests pin those exclusions so the count can't
drift back to over-reporting work that can never reach zero.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException

from backend.db import control_database
from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.tasks import dismiss_task, get_tasks, restore_task


class TasksFixtureTestCase(unittest.TestCase):
    """One account, one category, and a private pair of databases — shared by the count and dismissal
    cases.

    Both databases, not just the ledger: a task list built for a `Request` reaches the vault to decide
    whether to nag about access, so a fixture that repoints only the data DB reads whatever control DB
    the developer is running against.
    """

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "tasks.db"
        self._control_db_path = control_database.CONTROL_DB_PATH
        control_database.CONTROL_DB_PATH = str(Path(self.tempdir.name) / "control.db")
        control_database.init_control_db()
        init_db(str(self.db_path))
        self.account = self._insert_account()
        self.group = self._insert_category()

    def tearDown(self):
        control_database.CONTROL_DB_PATH = self._control_db_path
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype,
                       mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, 'Test Account', 'Test Account', 'credit', 'credit_card',
                            NULL, ?, NULL, NULL)
                    """,
                    (account_id, f"plaid_{account_id}", "fixture", SHARED_OWNER_ID),
                )
        return account_id

    def _insert_category(self) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'Test Group', 'expense')",
                    (category_id,),
                )
        return category_id

    def _insert_txn(self, *, category_id: str | None, is_pending: int = 0, trashed_at: str | None = None) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name,
                       display_name, raw_name, date, is_pending, trashed_at)
                    VALUES (?, ?, ?, ?, 12.00, 'Merchant', 'Merchant', 'Merchant', '2026-04-10', ?, ?)
                    """,
                    (txn_id, self.account, SHARED_OWNER_ID, category_id, is_pending, trashed_at),
                )
        return txn_id

    def _uncategorized_count(self) -> int:
        with self._use_db_path():
            result = get_tasks()
        for task in result["tasks"]:
            if task["id"] == "uncategorized_txns":
                return task["count"]
        return 0


class TasksUncategorizedCountTests(TasksFixtureTestCase):
    def test_counts_only_live_settled_uncategorized_rows(self):
        # Should count: one settled, non-trashed, uncategorized row.
        self._insert_txn(category_id=None)
        # Should NOT count: categorized.
        self._insert_txn(category_id=self.group)
        # Should NOT count: pending (settles later; excluded from categorization chores).
        self._insert_txn(category_id=None, is_pending=1)
        # Should NOT count: trashed (no longer appears in the list the task links to).
        self._insert_txn(category_id=None, trashed_at="2026-05-01T00:00:00Z")

        self.assertEqual(self._uncategorized_count(), 1)

    def test_trashed_uncategorized_rows_are_excluded(self):
        live = self._insert_txn(category_id=None)
        self.assertEqual(self._uncategorized_count(), 1)
        # Trashing the only uncategorized row should drop the count to zero (no task surfaced),
        # not leave it stranded at a number the user can never act down.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
                    (live,),
                )
        self.assertEqual(self._uncategorized_count(), 0)


class TasksSuspectDuplicateDescriptionTests(unittest.TestCase):
    """The suspect-duplicate task names the *relationship* between the two rows, and a merge retires
    the cross-account half of it — the same premise the duplicate report re-derives. Without this the
    Tasks page keeps sending the user to look for a second account that no longer exists."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "tasks-suspects.db"
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

    def _insert_account(self, name: str, parent_account_id: str | None = None) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype,
                       mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, 'fixture', ?, ?, 'credit', 'credit_card', NULL, ?, ?, NULL)
                    """,
                    (account_id, f"ext_{account_id}", name, name, SHARED_OWNER_ID, parent_account_id),
                )
        return account_id

    def _insert_flagged_pair(self, suspect_account: str, canonical_account: str) -> None:
        canonical_id, suspect_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                for txn_id, account_id in ((canonical_id, canonical_account), (suspect_id, suspect_account)):
                    conn.execute(
                        """
                        INSERT INTO txn
                          (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                           date, is_pending, trashed_at)
                        VALUES (?, ?, ?, -20.00, 'Merchant', 'Merchant', 'Merchant', '2026-04-10', 0, NULL)
                        """,
                        (txn_id, account_id, SHARED_OWNER_ID),
                    )
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account_fuzzy' WHERE id = ?",
                    (canonical_id, suspect_id),
                )

    def _description(self) -> str:
        with self._use_db_path():
            result = get_tasks()
        return next(t["description"] for t in result["tasks"] if t["id"] == "suspect_duplicates")

    def test_two_separate_accounts_still_read_as_a_cross_account_match(self):
        first = self._insert_account("Account A")
        second = self._insert_account("Account B")
        self._insert_flagged_pair(first, second)

        self.assertIn("1 transaction matches an existing row on a different account", self._description())

    def test_a_merged_pair_reads_as_the_same_account(self):
        root = self._insert_account("Card statements")
        child = self._insert_account("CARD")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (root, child))
        self._insert_flagged_pair(child, root)

        description = self._description()
        self.assertIn("1 transaction matches another row on the same account", description)
        self.assertNotIn("different account", description)

    def test_a_mixed_queue_claims_neither_relationship(self):
        root = self._insert_account("Card statements")
        child = self._insert_account("CARD")
        other = self._insert_account("Account B")
        unrelated = self._insert_account("Account C")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (root, child))
        self._insert_flagged_pair(child, root)
        self._insert_flagged_pair(other, unrelated)

        description = self._description()
        self.assertIn("2 transactions match an existing row already in the ledger", description)

    def test_a_flag_whose_matched_row_was_deleted_still_counts(self):
        # The count predates this wording split and must not shrink because of it: a dangling pointer
        # (matched row deleted by an undo) is still a row the user has to resolve.
        first = self._insert_account("Account A")
        second = self._insert_account("Account B")
        self._insert_flagged_pair(first, second)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("DELETE FROM txn WHERE suspect_duplicate_of IS NULL")

        self.assertIn("1 transaction matches", self._description())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class TaskDismissalTests(TasksFixtureTestCase):
    """Dismissing a task and the ratchet that decides when it comes back.

    The mark is the count at dismissal, and it falls to any lower count observed since. The falling
    half is the whole design: a mark that only ever held at its original value would swallow new work
    precisely because the user had cleared some — clear two of four and one arrives, and three is
    still under four, so a genuinely new item would stay hidden forever.
    """

    def _request(self):
        return SimpleNamespace(
            url=SimpleNamespace(hostname="127.0.0.1", scheme="http"),
            state=SimpleNamespace(user={"id": "test-user"}),
        )

    def _visible_ids(self, result=None) -> set[str]:
        with self._use_db_path():
            result = result if result is not None else get_tasks(self._request())
        return {t["id"] for t in result["tasks"]}

    def _dismiss(self):
        with self._use_db_path():
            return dismiss_task("uncategorized_txns", self._request())

    def _categorize_one(self):
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    "SELECT id FROM txn WHERE category_id IS NULL AND trashed_at IS NULL LIMIT 1").fetchone()
                conn.execute("UPDATE txn SET category_id = ? WHERE id = ?", (self.group, row["id"]))

    def test_dismissing_hides_the_task_and_lists_it_as_dismissed(self):
        self._insert_txn(category_id=None)
        self.assertIn("uncategorized_txns", self._visible_ids())

        result = self._dismiss()
        self.assertNotIn("uncategorized_txns", {t["id"] for t in result["tasks"]})
        self.assertEqual([t["id"] for t in result["dismissed"]], ["uncategorized_txns"])
        # The badge count must agree with the list it summarizes.
        self.assertEqual(result["open_items"], len(result["tasks"]))

    def test_more_work_arriving_brings_the_task_back(self):
        self._insert_txn(category_id=None)
        self._dismiss()
        self._insert_txn(category_id=None)
        self.assertIn("uncategorized_txns", self._visible_ids())

    def test_the_mark_falls_with_the_count_so_new_work_still_surfaces(self):
        for _ in range(4):
            self._insert_txn(category_id=None)
        self._dismiss()                      # mark = 4
        self._categorize_one()
        self._categorize_one()
        self.assertNotIn("uncategorized_txns", self._visible_ids())  # count 2, mark ratchets to 2

        self._insert_txn(category_id=None)   # count 3 — above the ratcheted mark, not the original one
        self.assertIn("uncategorized_txns", self._visible_ids())

    def test_a_dismissal_expires_once_its_task_goes_away(self):
        self._insert_txn(category_id=None)
        self._dismiss()
        self._categorize_one()               # the task no longer applies at all
        self.assertEqual(self._visible_ids(), set())

        self._insert_txn(category_id=None)
        self.assertIn("uncategorized_txns", self._visible_ids())

    def test_restoring_brings_it_back_immediately(self):
        self._insert_txn(category_id=None)
        self._dismiss()
        with self._use_db_path():
            result = restore_task("uncategorized_txns", self._request())
        self.assertIn("uncategorized_txns", {t["id"] for t in result["tasks"]})
        self.assertEqual(result["dismissed"], [])

    def test_a_required_task_cannot_be_dismissed(self):
        # HTTPS with a data provider configured is the one task that is not a reminder: it stays until
        # fixed. A networked plain-HTTP request is what raises it.
        control_database.set_data_provider_intended(True)
        request = SimpleNamespace(
            url=SimpleNamespace(hostname="192.168.1.10", scheme="http"),
            state=SimpleNamespace(user={"id": "test-user"}),
        )
        with self._use_db_path():
            task = next(t for t in get_tasks(request)["tasks"] if t["id"] == "configure_https")
            self.assertTrue(task["required"])
            self.assertNotIn("dismiss_key", task)
            with self.assertRaises(HTTPException) as raised:
                dismiss_task("configure_https", request)
        self.assertEqual(raised.exception.status_code, 404)

    def test_the_recommended_https_reminder_can_be_dismissed(self):
        from backend.db.control_database import enable_auth_mode
        enable_auth_mode()
        request = SimpleNamespace(
            url=SimpleNamespace(hostname="192.168.1.10", scheme="http"),
            state=SimpleNamespace(user={"id": "test-user", "role": "admin"}),
        )
        with self._use_db_path():
            self.assertIn("configure_https", {t["id"] for t in get_tasks(request)["tasks"]})
            result = dismiss_task("configure_https", request)
        self.assertNotIn("configure_https", {t["id"] for t in result["tasks"]})

    def test_the_https_reminder_is_not_shown_to_a_member(self):
        # Setting up HTTPS is the host's business, so someone who cannot do it is not told to.
        from backend.db.control_database import enable_auth_mode
        enable_auth_mode()
        request = SimpleNamespace(
            url=SimpleNamespace(hostname="192.168.1.10", scheme="http"),
            state=SimpleNamespace(user={"id": "test-user", "role": "member"}),
        )
        with self._use_db_path():
            self.assertNotIn("configure_https", {t["id"] for t in get_tasks(request)["tasks"]})


class ReimbursementTaskTests(TasksFixtureTestCase):
    """The reminder signal: that it appears at all, and that it splits by owner only where that means
    something.

    The gate is more than one *personal* owner rather than "any owner exists". A built-in `Shared` owner
    appears the first time the Owners page is opened, so the looser test would split a single-person
    install into groups all saying the same thing.
    """

    def _receivable_leaf(self) -> str:
        from backend.services.excluded_categories import REIMBURSABLE_SYSTEM_KEY

        leaf_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                group = conn.execute(
                    "SELECT id FROM category WHERE system_key = ?", (REIMBURSABLE_SYSTEM_KEY,)
                ).fetchone()["id"]
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, "
                    "sort_order) VALUES (?,?,'Owed by friends','expense',1,0)",
                    (leaf_id, group),
                )
        return leaf_id

    def _owner(self, name: str) -> str:
        owner_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("INSERT INTO owner (id, name) VALUES (?, ?)", (owner_id, name))
        return owner_id

    def _receivable_txn(self, leaf: str, owner_id: str, *, date: str = "2026-01-05") -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name,
                       display_name, raw_name, date, is_pending)
                    VALUES (?, ?, ?, ?, 120.00, 'Tickets', 'Tickets', 'Tickets', ?, 0)
                    """,
                    (txn_id, self.account, owner_id, leaf, date),
                )
        return txn_id

    def _reimbursement_tasks(self) -> list[dict]:
        with self._use_db_path():
            result = get_tasks()
        return [t for t in result["tasks"] if t["id"].startswith("reimbursements_due")]

    def test_an_overdue_receivable_raises_one_task(self):
        leaf = self._receivable_leaf()
        self._receivable_txn(leaf, SHARED_OWNER_ID)
        tasks = self._reimbursement_tasks()
        self.assertEqual([t["id"] for t in tasks], ["reimbursements_due"])
        self.assertEqual(tasks[0]["count"], 1)

    def test_the_reminder_is_dismissible_per_owner_group(self):
        # A snoozed record answers for that receivable; dismissing the task only puts the reminder away.
        leaf = self._receivable_leaf()
        self._receivable_txn(leaf, SHARED_OWNER_ID)
        self.assertEqual(self._reimbursement_tasks()[0]["dismiss_key"], "reimbursements_due")

    def test_a_recent_receivable_raises_nothing(self):
        leaf = self._receivable_leaf()
        self._receivable_txn(leaf, SHARED_OWNER_ID, date="2099-01-01")
        self.assertEqual(self._reimbursement_tasks(), [])

    def test_one_personal_owner_is_not_split_by_owner(self):
        leaf = self._receivable_leaf()
        alex = self._owner("Alex")
        self._receivable_txn(leaf, alex)
        self.assertEqual([t["id"] for t in self._reimbursement_tasks()], ["reimbursements_due"])

    def test_two_personal_owners_get_a_task_each(self):
        leaf = self._receivable_leaf()
        alex = self._owner("Alex")
        robin = self._owner("Robin")
        self._receivable_txn(leaf, alex)
        self._receivable_txn(leaf, robin)
        tasks = self._reimbursement_tasks()
        self.assertEqual(len(tasks), 2)
        self.assertEqual({t["count"] for t in tasks}, {1})
        # Each links to its own owner's rows, so the screen and the badge cannot disagree.
        self.assertTrue(all("owner_ids=" in t["link"] for t in tasks))


class ConnectionTaskTests(TasksFixtureTestCase):
    """The three connection states the nav badge exists to surface.

    They matter because the connections UI is split across two pages — what a connection *is* is
    configured on Accounts, what it has been *doing* lives with the imports — so a user who visits
    neither would otherwise never learn that a bank stopped importing. Each is a broken state with a
    concrete remedy, which is why they link to different pages.
    """

    def _insert_connection(self, *, institution, reauth=0, failures=0) -> str:
        connection_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO connection
                      (id, provider, external_id, institution, reauth_required, consecutive_sync_failures)
                    VALUES (?, 'fixture', ?, ?, ?, ?)
                    """,
                    (connection_id, f"ext_{connection_id}", institution, reauth, failures),
                )
        return connection_id

    def _insert_provider_account(self, connection_id, *, mapping_mode=None):
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO connection_account
                      (connection_id, external_account_id, mapping_mode)
                    VALUES (?, ?, ?)
                    """,
                    (connection_id, str(uuid.uuid4()), mapping_mode),
                )

    def _task(self, task_id):
        with self._use_db_path():
            result = get_tasks()
        return next((t for t in result["tasks"] if t["id"] == task_id), None)

    def test_a_connection_needing_reauth_is_reported_and_names_the_bank(self):
        self._insert_connection(institution="Harborline Savings", reauth=1)
        task = self._task("connections_need_reauth")
        self.assertIsNotNone(task)
        self.assertEqual(task["count"], 1)
        # Naming it is the point: with several connected, "a connection" leaves the user hunting.
        self.assertIn("Harborline Savings", task["description"])
        # The remedy is a re-authorization, which lives with the configuration.
        self.assertEqual(task["link"], "/accounts?tab=connections")

    def test_a_reauth_connection_is_not_also_counted_as_failing(self):
        # Two entries would name one problem twice, and only one of them says what to do. Same rule the
        # connection cards apply to their own pills.
        self._insert_connection(institution="Harborline Savings", reauth=1, failures=4)
        self.assertIsNone(self._task("connections_failing"))
        self.assertIsNotNone(self._task("connections_need_reauth"))

    def test_a_plain_failure_is_reported_and_points_at_the_log(self):
        self._insert_connection(institution="Riverstone Credit Union", failures=2)
        task = self._task("connections_failing")
        self.assertIsNotNone(task)
        # The log is what separates a bank being briefly unavailable from something needing a fix, and it
        # now lives with the imports rather than in Settings.
        self.assertEqual(task["link"], "/import-export")

    def test_unmapped_provider_accounts_are_counted_in_accounts_not_connections(self):
        # The number the user acts on is how many accounts still need a destination — that is what the
        # mapping dialog presents, and one connection can offer several.
        connection = self._insert_connection(institution="Northgate Bank")
        self._insert_provider_account(connection, mapping_mode=None)
        self._insert_provider_account(connection, mapping_mode=None)
        self._insert_provider_account(connection, mapping_mode="skip")
        task = self._task("connection_accounts_unmapped")
        self.assertIsNotNone(task)
        self.assertEqual(task["count"], 2)

    def test_a_healthy_connection_raises_nothing(self):
        # A fresh install with a working connection must not be greeted with warnings.
        connection = self._insert_connection(institution="Northgate Bank")
        self._insert_provider_account(connection, mapping_mode="skip")
        for task_id in ("connections_need_reauth", "connections_failing", "connection_accounts_unmapped"):
            self.assertIsNone(self._task(task_id), task_id)

    def test_a_dismissed_reminder_returns_when_another_connection_breaks(self):
        # The Tasks page is a reminder: dismissing hides it, and the count rising brings it back. These
        # counts do not fall on their own, so "another connection" is what brings one back.
        request = SimpleNamespace(
            url=SimpleNamespace(hostname="127.0.0.1", scheme="http"),
            state=SimpleNamespace(user={"id": "test-user"}),
        )
        self._insert_connection(institution="Harborline Savings", reauth=1)
        with self._use_db_path():
            result = dismiss_task("connections_need_reauth", request)
        self.assertNotIn("connections_need_reauth", {t["id"] for t in result["tasks"]})

        self._insert_connection(institution="Riverstone Credit Union", reauth=1)
        with self._use_db_path():
            visible = {t["id"] for t in get_tasks(request)["tasks"]}
        self.assertIn("connections_need_reauth", visible)


class ServerErrorTaskTests(TasksFixtureTestCase):
    """Errors in the server's log that no administrator has seen. Shown to whoever can open the Error log
    it links to, and cleared for the whole install when someone does."""

    def _task(self, role=None):
        user = {"id": "test-user", **({"role": role} if role else {})}
        request = SimpleNamespace(url=SimpleNamespace(hostname="127.0.0.1", scheme="http"),
                                  state=SimpleNamespace(user=user))
        with self._use_db_path():
            result = get_tasks(request)
        return next((t for t in result["tasks"] if t["id"] == "server_errors"), None)

    def test_it_is_shown_to_whoever_can_open_the_error_log(self):
        control_database.record_server_errors(2, busy_timeout_ms=500)
        # Sign-in off: there is no perimeter to hold a role against, so everyone can open the page.
        self.assertEqual(self._task()["count"], 2)

        control_database.enable_auth_mode()
        self.assertEqual(self._task(role="admin")["count"], 2)
        self.assertIsNone(self._task(role="member"))

    def test_acknowledging_clears_it_until_the_next_error(self):
        control_database.record_server_errors(2, busy_timeout_ms=500)
        control_database.acknowledge_server_errors(2)
        self.assertIsNone(self._task())

        control_database.record_server_errors(1, busy_timeout_ms=500)
        self.assertEqual(self._task()["count"], 1)

    def test_an_acknowledgment_cannot_reach_past_the_errors_that_exist(self):
        # Otherwise an acknowledgment arriving with a stale or inflated count would silence errors not yet
        # logged — and one that moved backwards would resurrect errors already seen.
        control_database.record_server_errors(1, busy_timeout_ms=500)
        control_database.acknowledge_server_errors(5)
        control_database.acknowledge_server_errors(0)
        self.assertIsNone(self._task())

        control_database.record_server_errors(1, busy_timeout_ms=500)
        self.assertEqual(self._task()["count"], 1)
