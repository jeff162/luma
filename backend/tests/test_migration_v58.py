"""
Migration v58 — a document may exist before its transaction does.

A *stored* document (an invoice kept before its charge is imported) has `txn_id` NULL, which the v42 shape
forbade. SQLite cannot drop NOT NULL in place, so v58 rebuilds `document`. The rebuild must keep every row
and its rowid, keep the cascade from `txn`, and leave the text index in step with the table: the index
addresses documents by rowid, and its triggers go with the old table.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class MigrationV58Tests(unittest.TestCase):
    """A database stamped at 57 holding two attached documents, with the v42 table and its text index."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "v57.db")
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE txn (id TEXT PRIMARY KEY);
            CREATE TABLE document (
                id          TEXT PRIMARY KEY,
                txn_id      TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                filename    TEXT NOT NULL,
                mime_type   TEXT NOT NULL,
                byte_size   INTEGER NOT NULL,
                sha256      TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                text        TEXT,
                text_source TEXT
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '57');
            INSERT INTO txn (id) VALUES ('t1'), ('t2');
            -- Rowids with a gap, as a deleted document leaves them, so a copy that renumbered would show.
            INSERT INTO document (rowid, id, txn_id, filename, mime_type, byte_size, sha256, created_at, text, text_source)
            VALUES
                (3, 'd-invoice', 't1', 'invoice.pdf', 'application/pdf', 10, 'aa', '2026-09-01T10:00:00Z',
                 'brake pads and rotors', 'pdf_text'),
                (7, 'd-photo', 't2', 'receipt.jpg', 'image/jpeg', 20, 'bb', '2026-09-02T10:00:00Z', NULL, NULL);
        """)
        database._create_document_search_index(self.conn)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _upgrade(self):
        database.run_migrations(self.conn)
        self.conn.commit()

    def _rows(self):
        return [tuple(r) for r in self.conn.execute(
            "SELECT rowid, id, txn_id, filename, mime_type, byte_size, sha256, created_at, text, text_source "
            "FROM document ORDER BY rowid"
        )]

    def test_every_row_survives_with_its_rowid_and_a_document_can_now_be_stored(self):
        before = self._rows()
        self._upgrade()

        self.assertEqual(self._rows(), before)
        not_null = {r["name"]: r["notnull"] for r in self.conn.execute("PRAGMA table_info(document)")}
        self.assertEqual(not_null["txn_id"], 0)
        self.conn.execute(
            "INSERT INTO document (id, txn_id, filename, mime_type, byte_size, sha256, created_at) "
            "VALUES ('d-stored', NULL, 'quote.pdf', 'application/pdf', 5, 'cc', '2026-09-03T10:00:00Z')"
        )
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_the_cascade_from_the_transaction_is_kept(self):
        self._upgrade()

        fks = self.conn.execute("PRAGMA foreign_key_list(document)").fetchall()
        self.assertEqual([(fk["from"], fk["table"], fk["on_delete"]) for fk in fks], [("txn_id", "txn", "CASCADE")])
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("DELETE FROM txn WHERE id = 't1'")
        self.assertEqual([r[1] for r in self._rows()], ["d-photo"])

    def test_the_text_index_is_rebuilt_against_the_new_table_and_kept_in_step(self):
        # What init_db does after the chain: recreate the index (dropped by the rebuild) and its triggers.
        self._upgrade()
        database._create_document_search_index(self.conn)

        def matches(term):
            return [r["id"] for r in self.conn.execute(
                "SELECT d.id FROM document_fts JOIN document d ON d.rowid = document_fts.rowid "
                "WHERE document_fts MATCH ?", (term,)
            )]

        self.assertEqual(matches("rotors"), ["d-invoice"])
        # The triggers exist again: a delete leaves the index, rather than leaving a hit on a missing row.
        self.conn.execute("DELETE FROM document WHERE id = 'd-invoice'")
        self.assertEqual(matches("rotors"), [])

    def test_running_it_again_changes_nothing(self):
        self._upgrade()
        before = self._rows()
        database.MIGRATIONS[58](self.conn)
        self.assertEqual(self._rows(), before)


if __name__ == "__main__":
    unittest.main()
