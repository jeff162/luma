"""
Settings -> Security checklist: which practices apply to an installation, and how each is judged. The
transport facts are pinned per test, since the module keeps them for the life of the process.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend import transport
from backend.db import control_database as cdb
from backend.db import database
from backend.routers.tasks import security_tasks
from backend.services import proxy_certificate, security_checklist, update_check


def _req(client: str = "127.0.0.1", host: str = "localhost", scheme: str = "http", user: dict | None = None):
    return SimpleNamespace(
        client=SimpleNamespace(host=client),
        url=SimpleNamespace(hostname=host, scheme=scheme),
        state=SimpleNamespace(user=user),
    )


class SecurityChecklistTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        data_path = str(Path(tmp.name) / "data.db")
        for target, name, value in (
            (database, "DB_PATH", data_path),
            (cdb, "DB_PATH", data_path),
            (cdb, "CONTROL_DB_PATH", str(Path(tmp.name) / "control.db")),
            (transport, "_declared", None),
            (transport, "_seen_from_network", False),
            (transport, "_seen_plain_http_from_network", False),
            (transport, "_seen_https_from_network", False),
        ):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # A developer's own Caddy may be answering on this machine; each test says whether one is.
        self.proxy_running = mock.patch.object(proxy_certificate, "is_running", return_value=False).start()
        self.addCleanup(mock.patch.stopall)
        database.init_db(data_path)
        cdb.init_control_db()

    def _items(self, request) -> dict[str, dict]:
        return {item["id"]: item for item in security_checklist.build(request, security_tasks(request))}

    def test_an_installation_only_its_own_computer_opens_is_not_judged_on_the_network(self):
        transport.declare_listener(reachable=False, direct=False)
        items = self._items(_req())
        self.assertEqual(list(items), ["update"])
        self.assertEqual(items["update"]["status"], security_checklist.UNKNOWN)

    def test_a_server_on_the_network_directly_with_no_sign_in(self):
        transport.declare_listener(reachable=True, direct=True)
        items = self._items(_req("192.168.1.10", "luma.local"))
        self.assertEqual(items["sign_in"]["status"], security_checklist.INFO)
        self.assertEqual(items["https"]["status"], security_checklist.NOT_MET)
        self.assertEqual(items["named_host"]["status"], security_checklist.MET)

    def test_a_server_behind_its_proxy_with_sign_in(self):
        transport.declare_listener(reachable=True, direct=False)
        cdb.enable_auth_mode()
        items = self._items(_req("192.168.1.10", "luma.local", "https"))
        self.assertEqual(items["sign_in"]["status"], security_checklist.MET)
        self.assertEqual(items["https"]["status"], security_checklist.MET)

    def test_a_device_seen_in_cleartext_outweighs_the_proxy(self):
        transport.declare_listener(reachable=True, direct=False)
        transport.note_request(_req("192.168.1.10", "luma.local", "http"))
        self.assertEqual(self._items(_req())["https"]["status"], security_checklist.NOT_MET)

    def test_a_wide_bind_beside_a_proxy_in_use_is_a_bypass(self):
        """HTTPS someone set up, quietly undone: elevated, and pointed at the setting."""
        transport.declare_listener(reachable=True, direct=True)
        transport.note_request(_req("192.168.1.10", "luma.local", "https"))
        item = self._items(_req())["https"]
        self.assertEqual((item["status"], item["severity"]), (security_checklist.NOT_MET, security_checklist.ELEVATED))
        self.assertEqual(item["link"], security_checklist.CONFIGURATION_LINK[0])

        transport._seen_https_from_network = False
        self.proxy_running.return_value = True
        self.assertEqual(self._items(_req())["https"]["severity"], security_checklist.ELEVATED)

    def test_a_server_on_plain_http_with_no_proxy_is_not_a_bypass(self):
        transport.declare_listener(reachable=True, direct=True)
        item = self._items(_req())["https"]
        self.assertEqual((item["status"], item["severity"]), (security_checklist.NOT_MET, None))

    def test_a_source_checkout_on_the_network_points_at_its_setting(self):
        values = {"backend_host": "0.0.0.0", "frontend_host": "localhost"}
        with mock.patch.object(transport.app_config, "value_of", side_effect=values.__getitem__):
            item = self._items(_req())["https"]
        self.assertEqual(item["status"], security_checklist.NOT_MET)
        self.assertIsNone(item["severity"])
        self.assertEqual(item["link"], security_checklist.CONFIGURATION_LINK[0])
        self.assertIn("BACKEND_HOST", item["detail"])

    def test_a_browser_on_an_address_cannot_use_passkeys(self):
        transport.declare_listener(reachable=True, direct=True)
        items = self._items(_req("192.168.1.10", "192.168.1.2"))
        self.assertEqual(items["named_host"]["status"], security_checklist.NOT_MET)

    def test_a_condition_that_is_a_task_is_read_from_the_task(self):
        transport.declare_listener(reachable=False, direct=False)
        update_check.set_enabled(True)
        with mock.patch.object(update_check, "available_version", return_value="99.0.0"):
            item = self._items(_req())["update"]
        self.assertEqual(item["status"], security_checklist.NOT_MET)
        self.assertEqual(item["link"], "/settings?section=about")

    def test_the_backup_item_follows_the_backup_task(self):
        transport.declare_listener(reachable=False, direct=False)
        due = {"id": "backup_due", "description": "A change since the last backup."}
        with mock.patch.object(security_checklist, "credentials_exports_detail", return_value=[{}]):
            items = {item["id"]: item for item in security_checklist.build(_req(), [due])}
        self.assertEqual(items["backups"]["status"], security_checklist.NOT_MET)


if __name__ == "__main__":
    unittest.main()
