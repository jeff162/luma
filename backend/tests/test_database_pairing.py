"""
The two databases are opened together only when they belong to the same workspace.

Requests use the financial database the configuration names, and the workspace id in both files is what
says the pair belongs together. The cases here are the ways a pair comes apart — a copy, a wrong path, a
ledger from elsewhere, an upgrade from the recorded-path schema — and the ways back.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing, contextmanager
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend import ledger_adoption, pairing_lock
from backend.db import control_database as cdb
from backend.db import database
from backend.tests._api_client import LAN_CLIENT, _arriving_from


@contextmanager
def _configured(data_path: Path, control_path: Path):
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = cdb.DB_PATH = str(data_path)
    cdb.CONTROL_DB_PATH = str(control_path)
    try:
        yield
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        pairing_lock.engage(None)


@contextmanager
def _server(client_host: str = "127.0.0.1"):
    from backend.main import app
    with TestClient(_arriving_from(app, client_host)) as client:
        yield client


def _sign_in(client) -> None:
    identities = client.get("/api/auth/identities").json()["identities"]
    if identities:
        identity = identities[0]
    else:
        created = client.post("/api/auth/identities", json={"name": "Tester"})
        assert created.status_code == 200, created.text
        identity = created.json()["identity"]
    selected = client.post("/api/auth/select-identity", json={"user_id": identity["id"]})
    assert selected.status_code == 200, selected.text


def _installation(folder: Path) -> tuple[Path, Path]:
    """A paired installation in `folder`, made the way a first run makes one."""
    data, control = folder / "luma-data.db", folder / "luma-control.db"
    with _configured(data, control):
        database.init_db(str(data))
        cdb.init_control_db()
        with _server() as client:
            _sign_in(client)
    return data, control


def _ledger_workspace(path: Path) -> str | None:
    with closing(sqlite3.connect(path)) as conn:
        return database.get_workspace_id(conn)


def _category_names(path: Path) -> set[str]:
    with closing(sqlite3.connect(path)) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM category")}


class PairingTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()


class CopiedPairTests(PairingTestCase):
    def test_a_copied_pair_opens_the_copy_not_the_original(self):
        """The reported case: both files copied to another folder, the settings pointed at the copy. The
        copy's control database still described the original, and requests went to the original ledger."""
        data, control = _installation(self.root / "original")
        copy = self.root / "copy"
        copy.mkdir()
        for source in (data, control):
            with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(copy / source.name)) as dst:
                src.backup(dst)

        with _configured(copy / data.name, copy / control.name), _server() as client:
            _sign_in(client)
            created = client.post("/api/categories", json={"name": "Only In The Copy"})
            self.assertEqual(created.status_code, 200, created.text)

        self.assertIn("Only In The Copy", _category_names(copy / data.name))
        self.assertNotIn("Only In The Copy", _category_names(data))


class LockedServerTests(PairingTestCase):
    def test_a_missing_ledger_is_explained_and_not_created(self):
        _data, control = _installation(self.root / "home")
        elsewhere = self.root / "elsewhere" / "luma-data.db"

        with _configured(elsewhere, control), _server() as client:
            api = client.get("/api/categories")
            self.assertEqual(api.status_code, 503)
            self.assertEqual(api.json()["code"], "databases_not_paired")
            page = client.get("/transactions")
            self.assertEqual(page.status_code, 503)
            self.assertIn(str(elsewhere.resolve()), page.text)
            self.assertIn("--adopt-ledger", page.text)
            self.assertEqual(client.get("/api/health").status_code, 200)

        self.assertFalse(elsewhere.exists(), "an empty ledger was created at the wrong path")

    def test_the_network_is_told_what_is_wrong_without_the_paths(self):
        data, control = _installation(self.root / "home")
        elsewhere = self.root / "elsewhere" / "luma-data.db"

        with _configured(elsewhere, control), _server(client_host=LAN_CLIENT) as client:
            page = client.get("/")
            api = client.get("/api/auth/status")

        self.assertEqual(page.status_code, 503)
        self.assertEqual(api.status_code, 503)
        for text in (page.text, api.text):
            self.assertNotIn(str(self.root.resolve()), text)
            self.assertNotIn("--adopt-ledger", text)

    def test_a_ledger_from_another_installation_is_refused(self):
        _data_a, control_a = _installation(self.root / "a")
        data_b, _control_b = _installation(self.root / "b")
        before = _ledger_workspace(data_b)

        with _configured(data_b, control_a):
            self.assertEqual(cdb.pairing_problem().kind, cdb.PAIRING_OTHER_WORKSPACE)
            with _server() as client:
                self.assertEqual(client.get("/api/categories").status_code, 503)
        self.assertEqual(_ledger_workspace(data_b), before)

    def test_a_ledger_never_paired_is_refused(self):
        _data, control = _installation(self.root / "home")
        fresh = self.root / "fresh.db"
        database.init_db(str(fresh))

        with _configured(fresh, control):
            self.assertEqual(cdb.pairing_problem().kind, cdb.PAIRING_UNPAIRED)


class NewControlDatabaseTests(PairingTestCase):
    def test_a_new_control_database_adopts_the_ledger_beside_it(self):
        """The lost-control-database recovery: a fresh one beside existing data starts normally, and its
        first account takes the ledger's workspace id rather than minting one the ledger lacks."""
        data, _control = _installation(self.root / "home")
        with _configured(data, data.parent / "luma-control.db"), _server() as client:
            _sign_in(client)
            client.post("/api/categories", json={"name": "Kept"})
        replacement = self.root / "replacement-control.db"

        with _configured(data, replacement):
            cdb.init_control_db()
            self.assertIsNone(cdb.pairing_problem())
            with _server() as client:
                _sign_in(client)
                listed = client.get("/api/categories")
            self.assertEqual(listed.status_code, 200, listed.text)
            self.assertIn("Kept", listed.text)
            self.assertEqual(cdb.workspace_id(), _ledger_workspace(data))


class UpgradeTests(PairingTestCase):
    """A control database from before the workspace id: `tenant.db_path` records the ledger."""

    def _old_control_database(self, control: Path, recorded: Path) -> None:
        with _configured(recorded, control):
            cdb.init_control_db()
            with cdb.get_control_db() as conn:
                conn.execute("INSERT INTO tenant (id, slug, name) VALUES ('ws-1', 'home', 'Home')")
                for name in ("alex", "sam"):
                    conn.execute(
                        "INSERT INTO user_account (id, username, password_hash, tenant_id) "
                        "VALUES (?, ?, 'unset', 'ws-1')", (f"user-{name}", name),
                    )
                    conn.execute(
                        "INSERT INTO user_recovery_code (id, user_id, code_hash) VALUES (?, ?, 'h')",
                        (f"code-{name}", f"user-{name}"),
                    )
        with closing(sqlite3.connect(control, isolation_level=None)) as conn:
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.executescript(f"""
                BEGIN;
                CREATE TABLE tenant_old (
                    id         TEXT PRIMARY KEY,
                    slug       TEXT NOT NULL UNIQUE,
                    name       TEXT NOT NULL,
                    db_path    TEXT NOT NULL UNIQUE,
                    status     TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO tenant_old (id, slug, name, db_path, status, created_at)
                    SELECT id, slug, name, '{recorded}', status, created_at FROM tenant;
                DROP TABLE tenant;
                ALTER TABLE tenant_old RENAME TO tenant;
                COMMIT;
            """)

    def _accounts(self, control: Path) -> tuple[int, int, list]:
        with closing(sqlite3.connect(control)) as conn:
            return (
                conn.execute("SELECT COUNT(*) FROM user_account").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM user_recovery_code").fetchone()[0],
                conn.execute("PRAGMA foreign_key_check").fetchall(),
            )

    def _tenant_columns(self, control: Path) -> set[str]:
        with closing(sqlite3.connect(control)) as conn:
            return {row[1] for row in conn.execute("PRAGMA table_info(tenant)")}

    def test_upgrading_keeps_every_account_and_pairs_the_ledger(self):
        data, control = self.root / "luma-data.db", self.root / "luma-control.db"
        database.init_db(str(data))
        self._old_control_database(control, data)

        with _configured(data, control):
            cdb.init_control_db()
            self.assertIsNone(cdb.pairing_problem())

        self.assertNotIn("db_path", self._tenant_columns(control))
        self.assertEqual(self._accounts(control), (2, 2, []))
        self.assertEqual(_ledger_workspace(data), "ws-1")

    def test_a_checkout_pairs_the_ledger_it_was_using_not_the_configured_one(self):
        """A checkout whose recorded ledger still existed ran on it, so that is the one that is its own."""
        in_use, configured, control = self.root / "in-use.db", self.root / "configured.db", self.root / "c.db"
        database.init_db(str(in_use))
        database.init_db(str(configured))
        self._old_control_database(control, in_use)

        with _configured(configured, control), mock.patch.object(cdb, "is_frozen", return_value=False):
            cdb.init_control_db()
            self.assertEqual(cdb.pairing_problem().kind, cdb.PAIRING_UNPAIRED)

        self.assertEqual(_ledger_workspace(in_use), "ws-1")
        self.assertIsNone(_ledger_workspace(configured))

    def test_a_moved_packaged_build_pairs_the_ledger_beside_it(self):
        """A packaged build adopted its configured ledger at every start, whatever the record said."""
        original, configured, control = self.root / "original.db", self.root / "here.db", self.root / "c.db"
        database.init_db(str(original))
        database.init_db(str(configured))
        self._old_control_database(control, original)

        with _configured(configured, control), mock.patch.object(cdb, "is_frozen", return_value=True):
            cdb.init_control_db()
            self.assertIsNone(cdb.pairing_problem())

        self.assertIsNone(_ledger_workspace(original))


class AdoptLedgerTests(PairingTestCase):
    def _run(self, answer: str) -> tuple[int, str]:
        said: list[str] = []
        status = ledger_adoption.run(ask=lambda _question: answer, say=said.append)
        return status, "\n".join(said)

    def test_declining_changes_nothing_and_accepting_pairs_the_ledger(self):
        _data_a, control_a = _installation(self.root / "a")
        data_b, _control_b = _installation(self.root / "b")
        before = _ledger_workspace(data_b)

        with _configured(data_b, control_a):
            status, said = self._run("n")
            self.assertEqual(status, 1)
            self.assertIn(str(data_b.resolve()), said)
            self.assertEqual(_ledger_workspace(data_b), before)

            status, _said = self._run("y")
            self.assertEqual(status, 0)
            self.assertIsNone(cdb.pairing_problem())

    def test_a_missing_ledger_is_created_empty_for_a_restore(self):
        _data, control = _installation(self.root / "home")
        gone = self.root / "new-home" / "luma-data.db"

        with _configured(gone, control):
            status, _said = self._run("y")
            self.assertEqual(status, 0)
            self.assertIsNone(cdb.pairing_problem())
            with _server() as client:
                _sign_in(client)
                self.assertEqual(client.get("/api/categories").status_code, 200)

    def test_a_pair_that_already_belongs_together_is_left_alone(self):
        data, control = _installation(self.root / "home")
        before = _ledger_workspace(data)
        with _configured(data, control):
            status, _said = self._run("y")
        self.assertEqual(status, 0)
        self.assertEqual(_ledger_workspace(data), before)


if __name__ == "__main__":
    unittest.main()
