"""
Rule alerts: a Task raised by a matching transaction's arrival.

What is pinned is the contract the feature rests on: an alert reports rows new to the ledger and never
the history a rule matches, a dismissed alert returns with the next arrival, a mute holds however many more
arrive until the alert is dismissed, and the owner lens counts the caught rows' owners. Also that a rule
with no merchant text is allowed only with a scope, since without one it matches the whole ledger.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException

from backend.db import control_database
from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import run_import_core
from backend.routers.rules import RuleCreate, RuleUpdate, create_rule, update_rule
from backend.routers.tasks import dismiss_task, get_tasks, mute_task, restore_task
from backend.services import rule_alerts
from backend.services.categorizer import recategorize_all

CARD = "acc-card"
OTHER = "acc-other"


def _csv(*rows: tuple[str, str, str]) -> str:
    return "Date,Description,Amount\n" + "".join(f"{d},{name},{amount}\n" for d, name, amount in rows)


class RuleAlertTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-alerts.db"
        # A task list built for a user reaches the control database, so it gets a private one too.
        self._control_db_path = control_database.CONTROL_DB_PATH
        control_database.CONTROL_DB_PATH = str(Path(self.tempdir.name) / "control.db")
        control_database.init_control_db()
        init_db(str(self.db_path))
        with self._db() as conn:
            for owner_id, name in (("own-a", "Avery"), ("own-b", "Blake")):
                conn.execute("INSERT INTO owner (id, name) VALUES (?, ?)", (owner_id, name))
            conn.execute("INSERT INTO account (id, provider, name, display_name, type, mask, owner_id) "
                         "VALUES (?, 'manual', 'Legacy Card', 'Legacy Card', 'credit', '4321', 'own-a')", (CARD,))
            conn.execute("INSERT INTO account (id, provider, name, display_name, type, owner_id) "
                         "VALUES (?, 'manual', 'Checking', 'Checking', 'depository', 'own-b')", (OTHER,))
        self.files = 0

    def tearDown(self):
        control_database.CONTROL_DB_PATH = self._control_db_path
        self.tempdir.cleanup()

    @contextmanager
    def _path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    @contextmanager
    def _db(self):
        with self._path(), get_db() as conn:
            yield conn

    def _import(self, account_id: str, *rows: tuple[str, str, str]) -> dict:
        self.files += 1
        cfg = {
            "account_id": account_id,
            "column_map": {"date": "Date", "amount": "Amount", "description": "Description"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
        }
        with self._path():
            return run_import_core(_csv(*rows), cfg, filename=f"file-{self.files}.csv")

    def _alert_rule(self, keyword="coffee", **fields) -> str:
        with self._path():
            created = create_rule(RuleCreate(keyword=keyword, alert=True, **fields))
        self.assertEqual(created["status"], "created")
        return created["id"]

    _request = SimpleNamespace(
        client=SimpleNamespace(host="127.0.0.1"),
        url=SimpleNamespace(hostname="127.0.0.1", scheme="http"),
        state=SimpleNamespace(user={"id": "test-user"}),
    )

    def _tasks(self, lens: str | None = None) -> dict:
        with self._path():
            return get_tasks(self._request, lens)

    def _alert_task(self, rule_id: str, lens: str | None = None):
        return next((t for t in self._tasks(lens)["tasks"] if t["id"] == f"rule_alert_{rule_id}"), None)

    def test_an_alert_reports_arrivals_and_never_the_history_it_matches(self):
        self._import(CARD, ("2026-01-02", "Coffee Cart", "-4.50"))
        rule_id = self._alert_rule()
        with self._db() as conn:
            recategorize_all(conn)
        self.assertIsNone(self._alert_task(rule_id))

        self._import(CARD, ("2026-02-02", "Coffee Cart", "-5.00"), ("2026-02-03", "Bookshop", "-9.00"))
        self.assertEqual(self._alert_task(rule_id)["count"], 1)

        # Handing the same rows over again raises nothing new.
        with self._db() as conn:
            rule_alerts.record_arrivals(
                conn, [r["id"] for r in conn.execute("SELECT id FROM txn WHERE date >= '2026-02-01'")])
        self.assertEqual(self._alert_task(rule_id)["count"], 1)

    def test_an_alert_only_rule_is_a_rule_and_its_message_titles_the_task(self):
        rule_id = self._alert_rule(alert_message="  Closed   card used ")
        self._import(CARD, ("2026-02-02", "Coffee Cart", "-5.00"))
        self.assertEqual(self._alert_task(rule_id)["title"], "Closed card used")

    def test_a_dismissed_alert_returns_with_the_next_arrival(self):
        rule_id = self._alert_rule()
        self._import(CARD, ("2026-02-02", "Coffee Cart", "-5.00"))
        with self._path():
            dismiss_task(f"rule_alert_{rule_id}", self._request)
        self.assertIsNone(self._alert_task(rule_id))
        self._import(CARD, ("2026-03-02", "Coffee Cart", "-6.00"))
        self.assertEqual(self._alert_task(rule_id)["count"], 2)

    def test_a_mute_holds_as_the_count_rises_until_the_alert_is_dismissed(self):
        rule_id = self._alert_rule()
        key = f"rule_alert_{rule_id}"
        self._import(CARD, ("2026-02-02", "Coffee Cart", "-5.00"))
        with self._path():
            mute_task(key, self._request)
        self._import(CARD, ("2026-03-02", "Coffee Cart", "-6.00"))
        self.assertIsNone(self._alert_task(rule_id))
        muted = next(t for t in self._tasks()["dismissed"] if t["id"] == key)
        self.assertEqual((muted["muted"], muted["count"]), (True, 2))

        with self._path():
            dismiss_task(key, self._request)
        self._import(CARD, ("2026-04-02", "Coffee Cart", "-7.00"))
        self.assertEqual(self._alert_task(rule_id)["count"], 3)

        with self._path():
            mute_task(key, self._request)
            restore_task(key, self._request)
        self.assertIsNotNone(self._alert_task(rule_id))

    def test_only_a_mutable_task_can_be_muted(self):
        with self._db() as conn:
            conn.execute("INSERT INTO txn (id, account_id, date, amount, raw_name) "
                         "VALUES ('t-uncat', ?, '2026-02-02', 5, 'Kiosk')", (CARD,))
        with self._path(), self.assertRaises(HTTPException) as caught:
            mute_task("uncategorized_txns", self._request)
        self.assertEqual(caught.exception.status_code, 404)

    def test_the_owner_lens_counts_the_caught_rows_owners(self):
        rule_id = self._alert_rule()
        self._import(CARD, ("2026-02-02", "Coffee Cart", "-5.00"))
        self._import(OTHER, ("2026-02-03", "Coffee Cart", "-3.00"), ("2026-02-04", "Coffee Cart", "-3.00"))
        self.assertEqual(self._alert_task(rule_id)["count"], 3)
        self.assertEqual(self._alert_task(rule_id, "own-a")["count"], 1)
        self.assertEqual(self._alert_task(rule_id, "own-b")["count"], 2)

        scoped = self._alert_rule("cart", account_id=CARD)
        self.assertIsNone(self._alert_task(scoped, "own-b"))
        self.assertIsNone(self._alert_task(scoped))
        self._import(CARD, ("2026-03-02", "Coffee Cart", "-5.00"))
        self.assertIsNone(self._alert_task(scoped, "own-b"))
        self.assertEqual(self._alert_task(scoped, "own-a")["count"], 1)

    def test_turning_an_alert_off_forgets_what_it_caught(self):
        rule_id = self._alert_rule(category_id=None, clean_name="Coffee")
        self._import(CARD, ("2026-02-02", "Coffee Cart", "-5.00"))
        with self._path():
            update_rule(rule_id, RuleUpdate(alert=False))
            update_rule(rule_id, RuleUpdate(alert=True))
        self.assertIsNone(self._alert_task(rule_id))
        with self._db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM rule_alert_hit").fetchone()[0], 0)


    def test_a_rule_with_no_merchant_text_needs_a_scope(self):
        with self._path(), self.assertRaises(HTTPException) as caught:
            create_rule(RuleCreate(keyword="", alert=True))
        self.assertEqual(caught.exception.status_code, 400)

        rule_id = self._alert_rule("", account_id=CARD)
        self._import(CARD, ("2026-02-02", "Coffee Cart", "-5.00"), ("2026-02-03", "Bookshop", "-9.00"))
        self._import(OTHER, ("2026-02-04", "Bookshop", "-9.00"))
        self.assertEqual(self._alert_task(rule_id)["count"], 2)

        with self._path(), self.assertRaises(HTTPException) as caught:
            update_rule(rule_id, RuleUpdate(clear_account=True))
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
