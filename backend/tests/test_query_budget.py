"""
The requests every page makes must not issue more queries as the ledger grows.

A request that runs a query per receivable, per series or per rule looks fine on a small ledger and slows
everything else on a large one: each query hands Python's interpreter lock back and forth, so under load
a request that issues thousands of them waits its turn thousands of times
(`docs/scale-and-limits.md` → *Many sessions on one server*). The reimbursement reminders on the Tasks
poll did exactly that, unnoticed, until a stalled browser lane was profiled.

So each request is run against the same ledger at two sizes and must issue the same number of queries at
both. A failure names the request and both counts: the difference is the part that grows with the data.
"""

from __future__ import annotations

import sqlite3
import threading
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from unittest import mock

from backend.db import database
from backend.db.database import SHARED_OWNER_ID, get_db, set_current_db_path, reset_current_db_path
from backend.services.excluded_categories import find_reimbursable_group_id
from backend.services.recurring_detection import scan_and_store
from backend.services.reimbursements import create_reimbursement
from backend.tests._api_client import api_client

# The pages these requests serve. The transaction list asks for one page of rows, as the ledger does.
_REQUESTS = ("/api/tasks", "/api/transactions?limit=200&offset=0", "/api/recurring/signals",
             "/api/rules/range-drift", "/api/reimbursements/due", "/api/reimbursements/outstanding")


@contextmanager
def _counting_queries(data_path):
    """Counts every statement run against the data database, on whichever thread runs it."""
    counted = [0]
    lock = threading.Lock()
    connect = sqlite3.connect

    def count(_statement):
        with lock:
            counted[0] += 1

    def counting_connect(path, *args, **kwargs):
        conn = connect(path, *args, **kwargs)
        if str(path) == str(data_path):
            conn.set_trace_callback(count)
        return conn

    with mock.patch.object(database.sqlite3, "connect", counting_connect):
        yield counted


def _seed(data_path, scale: int) -> None:
    """A ledger whose reimbursements, recurring series and ranged rules all grow with `scale`."""
    token = set_current_db_path(data_path)
    try:
        with get_db() as conn:
            account_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO account (id, provider, name, display_name, type) "
                "VALUES (?, 'fixture', 'Checking', 'Checking', 'depository')",
                (account_id,),
            )
            unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
            # A leaf under the seeded receivable group, made the way a user makes one.
            receivable = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals) "
                "VALUES (?, ?, 'Shared costs', 'expense', 1)",
                (receivable, find_reimbursable_group_id(conn)),
            )
            old = (date.today() - timedelta(days=120)).isoformat()

            def txn(payee, category_id, amount, when):
                txn_id = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                        display_name, raw_name, date)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (txn_id, account_id, SHARED_OWNER_ID, category_id, amount, payee, payee, payee, when),
                )
                return txn_id

            for i in range(scale):
                # A reimbursement still owed, and a receivable nobody has claimed yet — both long overdue.
                create_reimbursement(conn, [{"txn_id": txn(f"Dinner {i}", receivable, 40.0 + i, old)}],
                                     counterparty=f"Friend {i}")
                txn(f"Tickets {i}", receivable, 25.0 + i, old)
                # A monthly charge for the detector to find, and a ranged rule it nearly misses.
                category_id = str(uuid.uuid4())
                conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)",
                             (category_id, unassigned, f"Service {i}"))
                for month in range(6):
                    txn(f"Service {i}", category_id, 10.0 + i,
                        (date.today() - timedelta(days=30 * month + 3)).isoformat())
                rule_category_id = str(uuid.uuid4())
                conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)",
                             (rule_category_id, unassigned, f"Plan {i}"))
                conn.execute(
                    "INSERT INTO category_rule (id, category_id, keyword, amount_min, amount_max) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), rule_category_id, f"service {i}", 1.0, 9.0 + i),
                )
            scan_and_store(conn)
    finally:
        reset_current_db_path(token)


class QueryBudgetTests(unittest.TestCase):
    def _queries(self, scale: int) -> dict[str, int]:
        with api_client() as (client, data_path):
            _seed(data_path, scale)
            counts = {}
            for request in _REQUESTS:
                client.get(request)  # warms what a first request does once per process
                with _counting_queries(data_path) as counted:
                    response = client.get(request)
                self.assertEqual(response.status_code, 200, f"{request}: {response.text}")
                counts[request] = counted[0]
        return counts

    def test_the_requests_every_page_makes_issue_a_fixed_number_of_queries(self):
        small, large = self._queries(2), self._queries(20)
        for request in _REQUESTS:
            with self.subTest(request=request):
                self.assertEqual(
                    large[request], small[request],
                    f"{request} issued {small[request]} queries on the small ledger and {large[request]} on one "
                    "ten times larger — something in it runs a query per item",
                )


if __name__ == "__main__":
    unittest.main()
