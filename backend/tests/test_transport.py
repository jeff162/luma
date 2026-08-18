"""
Transport-security detection (phase 3): per-request loopback/HTTPS detection, the permissible-HTTP
rule (`https_expected` / `cleartext_warning`), and the computed "Set up HTTPS" task.

The rule under test: plain HTTP on a networked bind is fine only with no perimeter to defeat — no
sign-in protection and no data provider. Either trigger on a non-loopback bind implies HTTPS, and the
provider case is *required* (not dismissible) while plain client-server is only *recommended*.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from backend import transport
from backend.db import control_database as cdb
from backend.db import database
from backend.routers import tasks


def _req(host: str, scheme: str = "http"):
    # transport reads only request.url.hostname / request.url.scheme.
    return SimpleNamespace(url=SimpleNamespace(hostname=host, scheme=scheme))


class DetectionTests(unittest.TestCase):
    def test_loopback_hosts(self):
        for host in ("127.0.0.1", "127.0.0.5", "localhost", "::1", "app.localhost"):
            self.assertTrue(transport.request_is_loopback(_req(host)), host)

    def test_networked_hosts(self):
        for host in ("192.168.1.10", "luma.example.com", "10.0.0.2"):
            self.assertFalse(transport.request_is_loopback(_req(host)), host)

    def test_scheme_and_https(self):
        self.assertTrue(transport.request_is_https(_req("luma.local", "https")))
        self.assertFalse(transport.request_is_https(_req("luma.local", "http")))
        self.assertEqual(transport.request_scheme(_req("x", "HTTPS")), "https")


class PermissibleHttpTests(unittest.TestCase):
    def test_loopback_never_expects_https(self):
        r = _req("127.0.0.1", "http")
        self.assertFalse(transport.https_expected(r, perimeter_on=True, provider_intended=True))
        self.assertIsNone(transport.cleartext_warning(r, perimeter_on=True, provider_intended=True))

    def test_networked_http_with_no_perimeter_is_permitted(self):
        r = _req("192.168.1.10", "http")
        self.assertFalse(transport.https_expected(r, perimeter_on=False, provider_intended=False))
        self.assertIsNone(transport.cleartext_warning(r, perimeter_on=False, provider_intended=False))

    def test_networked_http_with_perimeter_expects_https(self):
        r = _req("192.168.1.10", "http")
        self.assertTrue(transport.https_expected(r, perimeter_on=True, provider_intended=False))
        self.assertIsNotNone(transport.cleartext_warning(r, perimeter_on=True, provider_intended=False))

    def test_networked_https_clears_the_warning(self):
        r = _req("192.168.1.10", "https")
        self.assertIsNone(transport.cleartext_warning(r, perimeter_on=True, provider_intended=True))


@contextmanager
def _isolated_stack():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    database.init_db(data_path)
    cdb.init_control_db()
    try:
        yield
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        tmp.cleanup()


class HttpsTaskTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    def test_no_task_on_loopback(self):
        cdb.enable_auth_mode()
        self.assertIsNone(tasks._https_setup_task(_req("127.0.0.1", "http")))

    def test_no_task_over_https(self):
        cdb.enable_auth_mode()
        self.assertIsNone(tasks._https_setup_task(_req("luma.local", "https")))

    def test_no_task_without_a_trigger(self):
        # Networked HTTP but perimeter off and no provider: permitted, so no nag.
        self.assertIsNone(tasks._https_setup_task(_req("192.168.1.10", "http")))

    def test_perimeter_task_is_recommended_and_dismissible(self):
        cdb.enable_auth_mode()
        task = tasks._https_setup_task(_req("192.168.1.10", "http"))
        self.assertIsNotNone(task)
        self.assertFalse(task["required"])
        self.assertTrue(task["dismissible"])

    def test_recommended_task_suppressible(self):
        cdb.enable_auth_mode()
        cdb.set_https_warning_suppressed(True)
        self.assertIsNone(tasks._https_setup_task(_req("192.168.1.10", "http")))

    def test_provider_task_is_required_and_not_dismissible(self):
        cdb.set_data_provider_intended(True)
        task = tasks._https_setup_task(_req("192.168.1.10", "http"))
        self.assertIsNotNone(task)
        self.assertTrue(task["required"])
        self.assertFalse(task["dismissible"])

    def test_provider_task_ignores_suppression(self):
        cdb.set_data_provider_intended(True)
        cdb.set_https_warning_suppressed(True)  # only the recommended case honors this
        self.assertIsNotNone(tasks._https_setup_task(_req("192.168.1.10", "http")))


if __name__ == "__main__":
    unittest.main()
