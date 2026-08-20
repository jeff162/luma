"""
Layered configuration: hardcoded default < control-DB `app_setting` row < environment variable.

Pins the properties a `.env`-free install depends on: the session secret is generated once and *stays*
the same across restarts (a regenerated secret would sign everyone out), an environment override wins
without being written into the database, a placeholder secret left over from an old template counts as
no secret at all, and the configuration report never leaks the secret or seeds a row just by being read.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend import app_config, runtime_config
from backend.db import control_database as cdb
from backend.tests._api_client import api_client


@contextmanager
def _isolated_control_db():
    tmp = tempfile.TemporaryDirectory()
    original = cdb.CONTROL_DB_PATH
    cdb.CONTROL_DB_PATH = str(Path(tmp.name) / "control.db")
    cdb.init_control_db()
    try:
        yield Path(tmp.name)
    finally:
        cdb.CONTROL_DB_PATH = original
        tmp.cleanup()


@contextmanager
def _env(**values):
    """Set (or, with None, unset) environment variables for the duration of the block. The developer's
    own `.env` is loaded into `os.environ` by the time tests run, so overrides must be cleared explicitly
    rather than assumed absent."""
    cleared = {key: None for key in values if values[key] is None}
    patch = {key: value for key, value in values.items() if value is not None}
    with mock.patch.dict(os.environ, patch):
        for key in cleared:
            os.environ.pop(key, None)
        yield


def _row(key: str) -> dict:
    return next(row for row in app_config.effective_config() if row["key"] == key)


class AppConfigTests(unittest.TestCase):
    def test_session_secret_is_generated_once_and_reused(self):
        with _isolated_control_db(), _env(SESSION_SECRET=None):
            first = app_config.resolve().session_secret
            second = app_config.resolve().session_secret

        self.assertTrue(first)
        self.assertGreater(len(first), 32)
        self.assertEqual(first, second, "a regenerated secret would invalidate every session on restart")

    def test_generated_secret_is_persisted_to_the_control_db(self):
        with _isolated_control_db(), _env(SESSION_SECRET=None):
            secret = app_config.resolve().session_secret
            self.assertEqual(cdb.get_app_setting("session_secret"), secret)

    def test_environment_overrides_stored_value_without_persisting(self):
        with _isolated_control_db(), _env(SESSION_SECRET=None):
            stored = app_config.resolve().session_secret

            with _env(SESSION_SECRET="an-operator-supplied-secret"):
                self.assertEqual(app_config.resolve().session_secret, "an-operator-supplied-secret")

            self.assertEqual(cdb.get_app_setting("session_secret"), stored)
            self.assertEqual(app_config.resolve().session_secret, stored)

    def test_placeholder_secret_counts_as_unset(self):
        # Both literals shipped in old `.env` templates; honoring one would sign cookies with a value
        # that is public knowledge.
        for placeholder in ("change_me_to_a_long_random_value", "dev-session-secret-change-me"):
            with self.subTest(placeholder=placeholder):
                with _isolated_control_db(), _env(SESSION_SECRET=placeholder):
                    resolved = app_config.resolve().session_secret
                    self.assertNotEqual(resolved, placeholder)
                    self.assertEqual(cdb.get_app_setting("session_secret"), resolved)

    def test_cookie_name_defaults_are_persisted_and_overridable(self):
        with _isolated_control_db(), _env(SESSION_COOKIE_NAME=None):
            derived = app_config.resolve().session_cookie_name
            self.assertTrue(derived.endswith("_session"))
            self.assertEqual(cdb.get_app_setting("session_cookie_name"), derived)

            with _env(SESSION_COOKIE_NAME="other_session"):
                self.assertEqual(app_config.resolve().session_cookie_name, "other_session")

    def test_cookie_name_distinguishes_two_databases(self):
        # The case the install directory cannot tell apart: one checkout, two databases reached by
        # swapping `.env` files. A shared name signs the user out on every swap.
        names = []
        for _ in range(2):
            with _isolated_control_db(), _env(SESSION_COOKIE_NAME=None):
                names.append(app_config.resolve().session_cookie_name)

        self.assertNotEqual(names[0], names[1])
        self.assertTrue(all(name.endswith("_session") for name in names))

    def test_data_dir_places_both_databases(self):
        with _env(DATA_DIR="/srv/luma", DB_PATH=None, CONTROL_DB_PATH=None):
            self.assertEqual(runtime_config.resolve_db_path(), "/srv/luma/luma-data.db")
            self.assertEqual(runtime_config.resolve_control_db_path(), "/srv/luma/luma-control.db")

    def test_default_data_dir_keeps_both_databases_in_the_working_directory(self):
        with _env(DATA_DIR=None, DB_PATH=None, CONTROL_DB_PATH=None):
            self.assertEqual(runtime_config.resolve_db_path(), "luma-data.db")
            self.assertEqual(runtime_config.resolve_control_db_path(), "luma-control.db")

    def test_per_file_overrides_still_win_over_the_data_directory(self):
        # Back-compat: installs and Docker setups predating DATA_DIR set these directly, and an existing
        # database must not be abandoned because a directory setting was introduced.
        with _env(DATA_DIR="/srv/luma", DB_PATH="/elsewhere/ledger.db", CONTROL_DB_PATH=None):
            self.assertEqual(runtime_config.resolve_db_path(), "/elsewhere/ledger.db")
            self.assertEqual(runtime_config.resolve_control_db_path(), "/srv/luma/luma-control.db")

    def test_a_path_that_only_followed_the_data_directory_reports_as_derived(self):
        # And names no variable: advertising DB_PATH here would present a narrow escape hatch — for a
        # database not on the default filename — as an ordinary setting.
        with _isolated_control_db(), _env(DATA_DIR="/srv/luma", DB_PATH=None, CONTROL_DB_PATH=None):
            rows = {row["key"]: row for row in app_config.effective_config()}
            self.assertEqual(rows["db_path"]["source"], "derived")
            self.assertEqual(rows["db_path"]["derived_from"], "data_dir")
            self.assertIsNone(rows["db_path"]["env_var"])

    def test_a_path_named_directly_reports_as_configured_and_names_its_variable(self):
        with _isolated_control_db(), _env(DATA_DIR=None, DB_PATH="/elsewhere/ledger.db", CONTROL_DB_PATH=None):
            rows = {row["key"]: row for row in app_config.effective_config()}
            self.assertEqual(rows["db_path"]["source"], "env")
            self.assertEqual(rows["db_path"]["env_var"], "DB_PATH")

    def test_relative_paths_carry_an_absolute_form_and_absolute_ones_do_not(self):
        with _isolated_control_db(), _env(DATA_DIR=None, DB_PATH=None, CONTROL_DB_PATH=None):
            rows = {row["key"]: row for row in app_config.effective_config()}
            self.assertEqual(rows["data_dir"]["value"], ".")
            self.assertTrue(rows["data_dir"]["absolute_value"].startswith("/"))
            self.assertIsNone(rows["backend_port"]["absolute_value"])

        with _isolated_control_db(), _env(DATA_DIR="/srv/luma", DB_PATH=None, CONTROL_DB_PATH=None):
            rows = {row["key"]: row for row in app_config.effective_config()}
            self.assertIsNone(rows["data_dir"]["absolute_value"])

    def test_database_paths_report_what_the_process_is_using(self):
        # These are resolved at import and held as module state; re-deriving them from the environment
        # would let the report name a database the process never opened.
        with _isolated_control_db():
            rows = {row["key"]: row for row in app_config.effective_config()}
            self.assertEqual(rows["control_db_path"]["value"], cdb.CONTROL_DB_PATH)

    def test_cross_origin_access_is_off_unless_configured(self):
        # The grant is credentialed, and every shipped topology serves the SPA and the API on one origin,
        # so a standing default would hand out cookie-bearing access nothing asked for.
        with _isolated_control_db(), _env(CORS_ORIGINS=None):
            self.assertEqual(app_config.resolve().cors_origins, ())

        with _isolated_control_db(), _env(CORS_ORIGINS="https://example.invalid"):
            self.assertEqual(app_config.resolve().cors_origins, ("https://example.invalid",))

    def test_report_names_the_layer_each_value_came_from(self):
        # FRONTEND_PORT is cleared too: importing `backend.main` anywhere in the suite loads the
        # developer's own `.env` into os.environ, so "unset" has to be made true rather than assumed.
        with _isolated_control_db(), _env(
            SESSION_SECRET=None, SESSION_COOKIE_NAME=None, BACKEND_PORT=None, FRONTEND_PORT=None,
        ):
            app_config.resolve()
            with _env(BACKEND_PORT="9001"):
                rows = {row["key"]: row for row in app_config.effective_config()}

        self.assertEqual(rows["session_cookie_name"]["source"], "app_setting")
        self.assertEqual(rows["backend_port"]["source"], "env")
        self.assertEqual(rows["backend_port"]["value"], "9001")
        self.assertEqual(rows["frontend_port"]["source"], "default")

    def test_report_reveals_whether_the_secret_is_set_but_never_its_value(self):
        with _isolated_control_db(), _env(SESSION_SECRET=None):
            secret = app_config.resolve().session_secret
            row = next(r for r in app_config.effective_config() if r["key"] == "session_secret")

        self.assertTrue(row["redacted"])
        self.assertTrue(row["is_set"])
        self.assertIsNone(row["value"])
        self.assertNotIn(secret, str(row))

    def test_reading_the_report_does_not_seed_stored_settings(self):
        # Opening the Settings page must not be a write. A row appearing here would also mean the report
        # and the running app could disagree about what the effective value is.
        with _isolated_control_db(), _env(SESSION_SECRET=None, SESSION_COOKIE_NAME=None):
            app_config.effective_config()
            self.assertIsNone(cdb.get_app_setting("session_secret"))
            self.assertIsNone(cdb.get_app_setting("session_cookie_name"))

    def test_clearing_a_stored_value_lets_the_default_apply_again(self):
        # The reason this exists: a value stored under an earlier derivation would otherwise be permanent.
        with _isolated_control_db(), _env(SESSION_COOKIE_NAME=None):
            app_config.resolve()
            cdb.set_app_setting("session_cookie_name", "stored_under_an_old_rule")
            self.assertEqual(app_config.resolve().session_cookie_name, "stored_under_an_old_rule")

            result = app_config.clear_stored_value("session_cookie_name")
            self.assertTrue(result["restart_required"])
            self.assertIsNone(cdb.get_app_setting("session_cookie_name"))
            self.assertEqual(app_config.resolve().session_cookie_name, result["pending_value"])

    def test_clearing_the_secret_regenerates_a_different_one(self):
        with _isolated_control_db(), _env(SESSION_SECRET=None):
            original = app_config.resolve().session_secret

            result = app_config.clear_stored_value("session_secret")
            self.assertIsNone(result["pending_value"], "a regenerated secret cannot be promised in advance")
            self.assertNotEqual(app_config.resolve().session_secret, original)

    def test_clearing_is_refused_where_it_would_change_nothing(self):
        # An environment override outranks the stored row, so the write would succeed and do nothing.
        with _isolated_control_db(), _env(SESSION_COOKIE_NAME="named_by_the_operator"):
            with self.assertRaises(ValueError):
                app_config.clear_stored_value("session_cookie_name")

        # Settings consumed before the app exists have no stored row to clear.
        with _isolated_control_db():
            with self.assertRaises(ValueError):
                app_config.clear_stored_value("backend_port")
            with self.assertRaises(KeyError):
                app_config.clear_stored_value("no_such_setting")

    def test_a_row_under_an_environment_override_is_not_offered_as_resettable(self):
        with _isolated_control_db(), _env(SESSION_COOKIE_NAME="named_by_the_operator"):
            rows = {row["key"]: row for row in app_config.effective_config()}
            self.assertFalse(rows["session_cookie_name"]["resettable"])

    def test_developer_options_are_off_unless_the_environment_enables_them(self):
        with _isolated_control_db(), _env(LUMA_DEVELOPER_OPTIONS=None):
            self.assertFalse(app_config.developer_options_enabled())
        with _isolated_control_db(), _env(LUMA_DEVELOPER_OPTIONS="true"):
            self.assertTrue(app_config.developer_options_enabled())
        with _isolated_control_db(), _env(LUMA_DEVELOPER_OPTIONS="off"):
            self.assertFalse(app_config.developer_options_enabled())


class NoEnvFileTests(unittest.TestCase):
    def test_resolving_configuration_never_creates_an_override_file(self):
        """The property the whole design rests on: an install with no `.env` stays that way. Earlier
        versions wrote one — the launcher copied the example and the setup screen wrote secrets into it —
        which is what made the file feel mandatory."""
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / ".env"
            with _isolated_control_db(), _env(LUMA_ENV_FILE=str(env_path)):
                app_config.resolve()
                app_config.effective_config()
                app_config.clear_stored_value("session_secret")

            self.assertFalse(env_path.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])


class ConfigGroupingTests(unittest.TestCase):
    """Which settings the panel leads with. Placement is a property of the setting, not of its current
    value, so the grouping cannot shift under a reader who changed nothing.

    Isolated like the rest of the module even though nothing here reads a stored value: building the
    report resolves *every* setting, and the stored ones have to resolve against some control database.
    Without one these pass on a machine that happens to have a real database on the default path and
    fail on a fresh checkout, which is the difference between a developer's machine and CI."""

    def test_the_settings_an_ordinary_install_might_change_are_not_advanced(self):
        with _isolated_control_db():
            rows = {row["key"]: row for row in app_config.effective_config()}
        for key in ("data_dir", "backend_port", "frontend_port"):
            self.assertFalse(rows[key]["advanced"], f"{key} is one of the few worth leading with")

    def test_startup_and_deployment_knobs_are_advanced(self):
        with _isolated_control_db():
            rows = {row["key"]: row for row in app_config.effective_config()}
        for key in ("session_secret", "cors_origins", "developer_options", "backend_ready_timeout"):
            self.assertTrue(rows[key]["advanced"])

    def test_placement_does_not_move_when_a_value_does(self):
        # The panel promotes an overridden row itself; the declaration behind it stays put, so the same
        # setting is filed the same way on every install.
        with _isolated_control_db(), _env(LUMA_USE_LOG_FILES=None):
            self.assertTrue(_row("use_log_files")["advanced"])
        with _isolated_control_db(), _env(LUMA_USE_LOG_FILES="true"):
            row = _row("use_log_files")
            self.assertTrue(row["advanced"])
            self.assertEqual(row["source"], "env")


class ConfigEndpointTests(unittest.TestCase):
    """The report and its one write, over HTTP — the layer where the admin guard and the refusal codes
    live, neither of which the service function can pin on its own."""

    def test_report_lists_settings_and_says_whether_an_override_file_is_present(self):
        with api_client() as (client, _):
            resp = client.get("/api/auth/config")
            self.assertEqual(resp.status_code, 200, resp.text)
            payload = resp.json()
            keys = {row["key"] for row in payload["settings"]}
            self.assertIn("data_dir", keys)
            self.assertIn("session_secret", keys)
            self.assertIn("env_file_present", payload)

    def test_resetting_an_unknown_setting_is_a_404_and_a_startup_only_one_a_409(self):
        with api_client() as (client, _):
            self.assertEqual(client.post("/api/auth/config/no_such_setting/reset").status_code, 404)
            self.assertEqual(client.post("/api/auth/config/backend_port/reset").status_code, 409)


if __name__ == "__main__":
    unittest.main()
