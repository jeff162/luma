"""
Migration v57 — a rule-suggestion review entry carries an explicit partition record.

Before v57 an entry said it owned its rows through a `synthetic` / `pending_override` boolean, and the card a
split remainder belonged beside was parsed back out of its `…:followup:<origin>` id. v57 replaces both with a
`partition` record, in all three containers the review state lives in and inside their trash sets.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


def _review(suggestions: dict, trash_sets: list | None = None) -> dict:
    return {
        "rule_suggestion_review": {
            "suggestions": suggestions,
            "statuses": {},
            "trash_sets": trash_sets or [],
        },
    }


class MigrationV57Tests(unittest.TestCase):
    """A database stamped at 56 whose three review stores each hold entries in the old shape."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "v56.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE import_batch (id TEXT PRIMARY KEY, config_snapshot TEXT);
            CREATE TABLE csv_import_profile (id TEXT PRIMARY KEY, column_map TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE import_workflow_state (key TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '56');
        """)
        batch = _review(
            {
                "market:__global__:food": {"keyword": "market", "source_row_ids": ["r1"]},
                "market:__global__:food:followup:market:owner-b:food": {
                    "keyword": "market",
                    "synthetic": True,
                    "derived_from_suggestion_id": "market:owner-b:food",
                    "source_row_ids": ["r2"],
                },
            },
            trash_sets=[{
                "id": "trash-1",
                "suggestions": {"cafe:__global__:dining": {
                    "keyword": "cafe", "pending_override": True, "source_row_ids": ["r3"],
                }},
                "statuses": {},
            }],
        )
        batch["amount_convention"] = "single_signed"
        self.conn.execute("INSERT INTO import_batch (id, config_snapshot) VALUES ('b1', ?)", (json.dumps(batch),))
        self.conn.execute("INSERT INTO import_batch (id, config_snapshot) VALUES ('b2', NULL)")
        self.conn.execute(
            "INSERT INTO csv_import_profile (id, column_map) VALUES ('p1', ?)",
            (json.dumps(_review({"fuel:__global__:auto": {
                "keyword": "fuel", "pending_override": True, "source_row_ids": ["r4"],
            }})),),
        )
        self.conn.execute(
            "INSERT INTO import_workflow_state (key, payload_json) VALUES ('system_rule_suggestion_review', ?)",
            (json.dumps(_review({"pharmacy:__global__:health": {
                "keyword": "pharmacy", "synthetic": True, "source_row_ids": ["r5"],
            }})),),
        )
        self.conn.execute(
            "INSERT INTO import_workflow_state (key, payload_json) VALUES ('demo_data', ?)",
            (json.dumps({"loaded": True}),),
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _upgrade(self):
        database.run_migrations(self.conn)
        self.conn.commit()

    def _review_state(self, query: str) -> dict:
        return json.loads(self.conn.execute(query).fetchone()[0])["rule_suggestion_review"]

    def _batch_review(self) -> dict:
        return self._review_state("SELECT config_snapshot FROM import_batch WHERE id = 'b1'")

    def test_a_remainder_keeps_the_card_its_id_named_and_the_origin_it_was_derived_from(self):
        self._upgrade()

        entries = self._batch_review()["suggestions"]
        self.assertEqual(
            entries["market:__global__:food:followup:market:owner-b:food"]["partition"],
            {
                "kind": "remainder",
                "origin_id": "market:owner-b:food",
                "split_root_id": "market:__global__:food",
            },
        )
        # An ordinary entry is left alone, and a converted one keeps the rest of its content.
        self.assertEqual(entries["market:__global__:food"], {"keyword": "market", "source_row_ids": ["r1"]})
        self.assertEqual(
            entries["market:__global__:food:followup:market:owner-b:food"]["source_row_ids"], ["r2"],
        )
        for entry in entries.values():
            self.assertNotIn("synthetic", entry)
            self.assertNotIn("pending_override", entry)
            self.assertNotIn("derived_from_suggestion_id", entry)

    def test_every_store_is_converted_including_trashed_entries(self):
        self._upgrade()

        trashed = self._batch_review()["trash_sets"][0]["suggestions"]
        self.assertEqual(trashed["cafe:__global__:dining"]["partition"], {"kind": "refined"})
        profile = self._review_state("SELECT column_map FROM csv_import_profile WHERE id = 'p1'")
        self.assertEqual(profile["suggestions"]["fuel:__global__:auto"]["partition"], {"kind": "refined"})
        system = self._review_state(
            "SELECT payload_json FROM import_workflow_state WHERE key = 'system_rule_suggestion_review'"
        )
        # A remainder whose id carries no marker has only its origin to fall back on — here, itself.
        self.assertEqual(
            system["suggestions"]["pharmacy:__global__:health"]["partition"],
            {
                "kind": "remainder",
                "origin_id": "pharmacy:__global__:health",
                "split_root_id": "pharmacy:__global__:health",
            },
        )

    def test_what_is_not_review_state_is_untouched(self):
        self._upgrade()

        snapshot = json.loads(self.conn.execute("SELECT config_snapshot FROM import_batch WHERE id = 'b1'").fetchone()[0])
        self.assertEqual(snapshot["amount_convention"], "single_signed")
        self.assertIsNone(self.conn.execute("SELECT config_snapshot FROM import_batch WHERE id = 'b2'").fetchone()[0])
        self.assertEqual(
            json.loads(self.conn.execute(
                "SELECT payload_json FROM import_workflow_state WHERE key = 'demo_data'"
            ).fetchone()[0]),
            {"loaded": True},
        )
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_running_it_again_changes_nothing(self):
        self._upgrade()
        before = self._batch_review()
        database.MIGRATIONS[57](self.conn)
        self.assertEqual(self._batch_review(), before)


if __name__ == "__main__":
    unittest.main()
