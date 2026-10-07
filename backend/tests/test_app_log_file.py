"""
The server's own log file: a copy of what it logs, beside the data database.

What is pinned is what makes it worth having and safe to leave on everywhere: it is a copy (whatever
already received the output still does), a line is written once however uvicorn's loggers are wired,
successful requests stay out while failed ones go in, it rotates rather than growing, and the Settings view
reads the errors back out of it, tracebacks included, newest first.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import app_log_file, runtime_config
from backend.db import control_database, database
from backend.tests._api_client import api_client

_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


class _Collect(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record):
        self.records.append(record)


class AppLogFileTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name).resolve()
        patcher = mock.patch.object(database, "DB_PATH", str(self.dir / "luma-data.db"))
        patcher.start()
        self.addCleanup(patcher.stop)
        # Errors are counted into the control database as they are logged.
        control = mock.patch.object(control_database, "CONTROL_DB_PATH", str(self.dir / "luma-control.db"))
        control.start()
        self.addCleanup(control.stop)
        control_database.init_control_db()
        saved = {name: (logging.getLogger(name).propagate, logging.getLogger(name).level) for name in _UVICORN_LOGGERS}
        self.addCleanup(self._restore_loggers, saved)
        # Registered last so it runs first: the handler is closed before its directory goes.
        self.addCleanup(app_log_file.uninstall)

    @staticmethod
    def _restore_loggers(saved):
        for name, (propagate, level) in saved.items():
            logging.getLogger(name).propagate = propagate
            logging.getLogger(name).setLevel(level)

    @staticmethod
    def _as_uvicorn_configures_it():
        # What the uvicorn CLI and the desktop launcher leave behind: its loggers stop at themselves.
        for name in _UVICORN_LOGGERS:
            logging.getLogger(name).setLevel(logging.INFO)
        logging.getLogger("uvicorn").propagate = False
        logging.getLogger("uvicorn.access").propagate = False

    def _lines(self):
        path = self.dir / app_log_file.LOG_FILENAME
        return path.read_text(encoding="utf-8").splitlines() if path.is_file() else []

    def test_it_sits_beside_the_data_database(self):
        self.assertEqual(app_log_file.install(), self.dir / "luma.log")
        logging.getLogger("luma.test").warning("something the server coped with")
        self.assertTrue(any(line.endswith("WARNING luma.test: something the server coped with") for line in self._lines()))

    def _start_marker(self):
        return next(line for line in self._lines() if app_log_file._MARKER_LOGGER in line)

    def test_the_start_marker_names_the_version_and_the_address_when_one_was_declared(self):
        # Only the desktop launcher can declare one: it settles the port, so the log is the only record of
        # which address a given run landed on.
        self.addCleanup(app_log_file.set_reachable_url, None)
        app_log_file.set_reachable_url("http://localhost:8123")
        app_log_file.install()
        self.assertTrue(
            self._start_marker().endswith(f"{runtime_config.APP_VERSION} started at http://localhost:8123 ---"),
            self._start_marker(),
        )

    def test_the_start_marker_omits_an_address_nobody_declared(self):
        """Running from source the browser is on Vite's port with this server behind it, and a container's
        published port is a mapping made outside it — neither is this process's to state, so the marker
        says nothing rather than naming somewhere nobody can reach."""
        app_log_file.install()
        self.assertTrue(
            self._start_marker().endswith(f"{runtime_config.APP_VERSION} started ---"), self._start_marker()
        )

    def test_it_copies_rather_than_replaces_what_already_receives_the_output(self):
        # The terminal, the journal and `docker logs` all hang off handlers like this one.
        self._as_uvicorn_configures_it()
        existing = _Collect()
        server_logger = logging.getLogger("uvicorn")
        server_logger.addHandler(existing)
        self.addCleanup(server_logger.removeHandler, existing)

        app_log_file.install()
        logging.getLogger("uvicorn.error").error("request failed")

        self.assertEqual([record.getMessage() for record in existing.records], ["request failed"])
        self.assertEqual(sum("request failed" in line for line in self._lines()), 1)

    def test_a_line_is_written_once_when_nothing_configured_the_server_loggers(self):
        # The test client's case: uvicorn's loggers still propagate to the root, where the handler also sits.
        for name in _UVICORN_LOGGERS:
            logging.getLogger(name).propagate = True
        app_log_file.install()
        logging.getLogger("uvicorn.error").error("only once")
        self.assertEqual(sum("only once" in line for line in self._lines()), 1)
        self.assertEqual(app_log_file.error_counts()["recorded"], 1)

    def test_only_failed_requests_leave_an_access_line(self):
        self._as_uvicorn_configures_it()
        app_log_file.install()
        access = logging.getLogger("uvicorn.access")
        for path, status in (("/api/tasks", 200), ("/api/rules/r1/widen", 500), ("/api/rules/r1", 409),
                             ("/api/auth/users", 403)):
            access.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "POST", path, "1.1", status)
        written = "\n".join(self._lines())
        self.assertNotIn("/api/tasks", written)
        for path in ("/api/rules/r1/widen", "/api/rules/r1", "/api/auth/users"):
            self.assertIn(f"{path} HTTP", written)

    def test_failures_anyone_can_cause_without_signing_in_stay_out(self):
        # On a networked install a flood of these would rotate genuine failures out of the file.
        self._as_uvicorn_configures_it()
        app_log_file.install()
        access = logging.getLogger("uvicorn.access")
        access.info('%s - "%s %s HTTP/%s" %d', "10.0.0.9:5000", "GET", "/api/accounts", "1.1", 401)
        access.info('%s - "%s %s HTTP/%s" %d', "10.0.0.9:5000", "GET", "/wp-login.php", "1.1", 404)
        server = logging.getLogger("uvicorn.error")
        server.warning("Invalid HTTP request received.", exc_info=ValueError("bad request line"))
        server.warning("Unsupported upgrade request.")
        server.warning("a warning about the application itself")

        written = "\n".join(self._lines())
        for absent in ("/api/accounts", "/wp-login.php", "Invalid HTTP request", "Unsupported upgrade"):
            self.assertNotIn(absent, written)
        self.assertIn("a warning about the application itself", written)

    def test_a_crash_is_read_back_with_its_traceback_newest_first(self):
        self._as_uvicorn_configures_it()
        app_log_file.install()
        server = logging.getLogger("uvicorn.error")
        server.error("first failure")
        try:
            raise RuntimeError("database is locked")
        except RuntimeError as exc:
            # How uvicorn reports a request that raised (`protocols/http/*_impl.py`).
            server.error("Exception in ASGI application\n", exc_info=exc)
        logging.getLogger("luma.test").warning("coped with this")

        result = app_log_file.recent_errors()

        self.assertTrue(result["present"])
        self.assertEqual([entry["message"] for entry in result["entries"]],
                         ["Exception in ASGI application", "first failure"])
        self.assertIn("RuntimeError: database is locked", result["entries"][0]["detail"])
        self.assertEqual(result["entries"][1]["detail"], "")
        self.assertTrue(result["entries"][0]["time"].endswith("Z"))

    def test_it_rotates_keeping_one_previous_file(self):
        with mock.patch.object(app_log_file, "LOG_MAX_BYTES", 2000):
            app_log_file.install()
            for index in range(200):
                logging.getLogger("luma.test").error("filler line %d %s", index, "x" * 40)
        base = self.dir / "luma.log"
        self.assertTrue(Path(f"{base}.1").is_file())
        self.assertFalse(Path(f"{base}.2").exists())
        self.assertLess(base.stat().st_size, 2200)
        # Both files are read: the newest error comes from the current file, and older ones follow it.
        entries = app_log_file.recent_errors(limit=500)["entries"]
        self.assertTrue(entries[0]["message"].startswith("filler line 199 "))
        self.assertGreater(len(entries), len([line for line in self._lines() if " ERROR " in line]))

    def test_an_enormous_record_is_read_back_cut_and_marked(self):
        app_log_file.install()
        server = logging.getLogger("luma.test")
        server.error("short and whole")
        try:
            raise RuntimeError("x" * (app_log_file.DETAIL_LIMIT + 5_000))
        except RuntimeError as exc:
            server.error("m" * (app_log_file.MESSAGE_LIMIT + 500), exc_info=exc)

        newest, older = app_log_file.recent_errors()["entries"]

        self.assertEqual(len(newest["message"]), app_log_file.MESSAGE_LIMIT)
        self.assertEqual(len(newest["detail"]), app_log_file.DETAIL_LIMIT)
        self.assertTrue(newest["truncated"])
        self.assertFalse(older["truncated"])
        # Only what Settings receives is cut; the file keeps the full text.
        self.assertIn("x" * (app_log_file.DETAIL_LIMIT + 5_000), "\n".join(self._lines()))

    def test_nothing_recorded_yet_reads_as_empty_rather_than_failing(self):
        result = app_log_file.recent_errors()
        self.assertEqual((result["present"], result["entries"]), (False, []))

    def test_errors_are_counted_for_the_tasks_reminder_and_nothing_else_is(self):
        self._as_uvicorn_configures_it()
        app_log_file.install()
        logging.getLogger("uvicorn.error").error("a request crashed")
        logging.getLogger("luma.test").warning("coped with this")
        logging.getLogger("uvicorn.access").info(
            '%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "POST", "/api/rules/r1", "1.1", 500)
        self.assertEqual(app_log_file.error_counts(), {"recorded": 1, "unacknowledged": 1})

    def test_an_error_whose_count_could_not_be_written_is_added_by_the_next_write(self):
        app_log_file.install()
        locked = sqlite3.OperationalError("database is locked")
        with mock.patch.object(control_database, "record_server_errors", side_effect=locked):
            logging.getLogger("luma.test").error("logged while the control database was busy")
        self.assertIn("busy", "\n".join(self._lines()))
        self.assertEqual(app_log_file.error_counts()["recorded"], 1)

    def test_a_start_that_fails_readying_the_database_is_still_recorded(self):
        # uvicorn reports a failed start only after the lifespan has raised, so the handler has to be in
        # place before `init_db` runs and still attached once it has failed.
        from backend import main

        async def start():
            async with main.lifespan(main.app):
                pass

        with mock.patch.object(main, "init_db", side_effect=RuntimeError("migration failed")):
            with self.assertRaises(RuntimeError):
                asyncio.run(start())
        logging.getLogger("uvicorn.error").error("Application startup failed. Exiting.")

        self.assertIn("Application startup failed", "\n".join(self._lines()))
        self.assertEqual(app_log_file.error_counts()["recorded"], 1)

    def test_uninstalling_stops_the_copy(self):
        app_log_file.install()
        app_log_file.uninstall()
        logging.getLogger("luma.test").error("after uninstall")
        self.assertFalse(any("after uninstall" in line for line in self._lines()))


class ErrorLogEndpointTests(unittest.TestCase):
    def test_the_application_starts_the_copy_and_settings_reads_it_back(self):
        with api_client() as (client, data_path):
            self.assertEqual(app_log_file.log_path().parent, Path(data_path).resolve().parent)
            logging.getLogger("luma.test").error("surfaced in Settings")
            response = client.get("/api/diagnostics/log/errors")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([entry["message"] for entry in response.json()["entries"]], ["surfaced in Settings"])

    def test_reading_the_errors_and_acknowledging_them_clears_the_task(self):
        def task_ids(client):
            return {task["id"] for task in client.get("/api/tasks").json()["tasks"]}

        with api_client() as (client, _):
            logging.getLogger("luma.test").error("first")
            self.assertIn("server_errors", task_ids(client))

            shown = client.get("/api/diagnostics/log/errors").json()
            self.assertEqual((shown["recorded"], shown["unacknowledged"]), (1, 1))
            # An error logged after the page read its entries has not been seen, whatever the order the
            # acknowledgment arrives in.
            logging.getLogger("luma.test").error("second, after the page was read")
            acknowledged = client.post("/api/diagnostics/log/errors/acknowledge",
                                       json={"through": shown["recorded"]})
            self.assertEqual(acknowledged.json(), {"recorded": 2, "unacknowledged": 1})
            self.assertIn("server_errors", task_ids(client))

            client.post("/api/diagnostics/log/errors/acknowledge", json={"through": 2})
            self.assertNotIn("server_errors", task_ids(client))


if __name__ == "__main__":
    unittest.main()
