"""
A connection's nickname is the name it is shown by, and only that: `institution` stays the provider's, and
labels stored from it (an import card's title, a sync log row) are rewritten where they are read, never
where they are kept. The card-title rule exists twice, in Python for stored JSON labels and in SQL for
queries that select a title beside other columns, so the first test holds the two together.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db import control_database as cdb
from backend.db import database
from backend.routers.connections import ConnectionNicknameRequest, set_connection_nickname
from backend.routers.import_export.core import list_batches
from backend.services.connection_names import card_title, card_title_sql


@contextmanager
def _isolated_db():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = str(Path(tmp.name) / "control.db")
    database.init_db(data_path)
    try:
        yield
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        tmp.cleanup()


class CardTitleTests(unittest.TestCase):
    CASES = [
        # (filename, institution, provider, nickname, shown)
        ("Harborline · November 2026", "Harborline", "plaid", "Harborline Joint", "Harborline Joint · November 2026"),
        ("Harborline · Initial import", "Harborline", "plaid", None, "Harborline · Initial import"),
        ("simplefin · March 2026", None, "simplefin", "Household", "Household · March 2026"),
        ("simplefin · March 2026", "", "simplefin", "Household", "Household · March 2026"),
        # Written before the institution changed: shown as stored.
        ("Old Bank · May 2026", "New Bank", "plaid", "Joint", "Old Bank · May 2026"),
        ("statement.csv", "Harborline", "plaid", "Harborline Joint", "statement.csv"),
    ]

    def test_the_python_and_sql_rules_agree(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE b (filename TEXT)")
        conn.execute("CREATE TABLE c (institution TEXT, provider TEXT, nickname TEXT)")
        for filename, institution, provider, nickname, shown in self.CASES:
            with self.subTest(filename=filename, nickname=nickname):
                named = {"institution": institution, "provider": provider, "nickname": nickname}
                self.assertEqual(card_title(filename, named), shown)
                conn.execute("DELETE FROM b")
                conn.execute("DELETE FROM c")
                conn.execute("INSERT INTO b VALUES (?)", (filename,))
                conn.execute("INSERT INTO c VALUES (?, ?, ?)", (institution, provider, nickname))
                self.assertEqual(conn.execute(f"SELECT {card_title_sql('b', 'c')} FROM b, c").fetchone()[0], shown)


class RenameTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_db()
        self._stack.__enter__()
        with database.get_db() as conn:
            conn.execute("INSERT INTO connection (id, provider, external_id, institution) "
                         "VALUES ('c1', 'plaid', 'item-1', 'Harborline')")
            conn.execute("INSERT INTO import_batch (id, filename, connection_id, provider, source_kind) "
                         "VALUES ('card', 'Harborline · November 2026', 'c1', 'plaid', 'connection_sync')")

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    def _rename(self, nickname):
        return set_connection_nickname("c1", ConnectionNicknameRequest(nickname=nickname))

    def test_a_nickname_names_the_connection_and_its_cards_without_changing_what_is_stored(self):
        self.assertEqual(self._rename("  Harborline Joint ")["name"], "Harborline Joint")
        card = next(b for b in list_batches() if b["id"] == "card")
        self.assertEqual((card["connection_name"], card["filename"]),
                         ("Harborline Joint", "Harborline Joint · November 2026"))
        with database.get_db() as conn:
            stored = conn.execute("SELECT c.institution, b.filename FROM connection c, import_batch b").fetchone()
        self.assertEqual(tuple(stored), ("Harborline", "Harborline · November 2026"))

    def test_blank_or_the_institutions_own_name_clears_it(self):
        for cleared in ("", "Harborline"):
            with self.subTest(cleared=cleared):
                self._rename("Harborline Joint")
                self.assertEqual(self._rename(cleared), {"id": "c1", "nickname": None, "name": "Harborline"})

    def test_an_unknown_connection_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            set_connection_nickname("nope", ConnectionNicknameRequest(nickname="x"))
        self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
