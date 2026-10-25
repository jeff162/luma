"""
Transport-security detection: per-request loopback/HTTPS detection, the permissible-HTTP
rule (`https_expected`), the protected-link gate, and the computed "Set up HTTPS" task.

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
from unittest import mock

from backend import transport
from backend.db import control_database as cdb
from backend.db import database
from backend.routers import tasks


def _req(client: str, scheme: str = "http", host: str = "luma.local"):
    # transport reads the client's address and request.url.scheme, and must not read the host. The task
    # is also shown only to someone who could set HTTPS up, so the request is an admin's: what varies
    # here is the transport.
    return SimpleNamespace(
        client=SimpleNamespace(host=client),
        url=SimpleNamespace(hostname=host, scheme=scheme),
        state=SimpleNamespace(user={"id": "test-user", "role": "admin"}),
    )


class DetectionTests(unittest.TestCase):
    def test_loopback_clients(self):
        for client in ("127.0.0.1", "127.0.0.5", "::1", "::ffff:127.0.0.1"):
            self.assertTrue(transport.request_is_loopback(_req(client)), client)

    def test_networked_clients(self):
        # The last two are a peer with no address at all, which is read as the network rather than trusted.
        for client in ("192.168.1.10", "10.0.0.2", "testclient", ""):
            self.assertFalse(transport.request_is_loopback(_req(client)), client)

    def test_the_host_a_request_names_does_not_make_it_local(self):
        # The client writes that header, so a device on the network could otherwise call itself local.
        self.assertFalse(transport.request_is_loopback(_req("192.168.1.10", host="localhost")))
        self.assertTrue(transport.request_is_loopback(_req("127.0.0.1", host="luma.local")))

    def test_scheme_and_https(self):
        self.assertTrue(transport.request_is_https(_req("luma.local", "https")))
        self.assertFalse(transport.request_is_https(_req("luma.local", "http")))
        self.assertEqual(transport.request_scheme(_req("x", "HTTPS")), "https")


class ReachableFromNetworkTests(unittest.TestCase):
    """Whether other devices can open the installation at all: what the launcher says it started, else
    the addresses the start scripts are given, and in any case a device that has actually got through."""

    def setUp(self):
        for name, value in (("_declared", None), ("_seen_from_network", False),
                            ("_seen_plain_http_from_network", False), ("_seen_https_from_network", False)):
            patcher = mock.patch.object(transport, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _configured(self, backend_host: str, frontend_host: str = "localhost"):
        values = {"backend_host": backend_host, "frontend_host": frontend_host}
        return mock.patch.object(transport.app_config, "value_of", side_effect=values.__getitem__)

    def test_a_checkout_is_read_from_the_addresses_its_servers_are_started_on(self):
        with self._configured("127.0.0.1"):
            self.assertFalse(transport.reachable_from_network())
        with self._configured("0.0.0.0"):
            self.assertTrue(transport.reachable_from_network())
        # The interface's own server forwards to this one, so widening it alone is enough.
        with self._configured("127.0.0.1", frontend_host="0.0.0.0"):
            self.assertTrue(transport.reachable_from_network())

    def test_the_launcher_outranks_the_settings_it_does_not_read(self):
        """A downloaded copy ignores `BACKEND_HOST`, so one left in its `.env` must not be believed."""
        with self._configured("0.0.0.0"):
            transport.declare_listener(reachable=False, direct=False)
            self.assertFalse(transport.reachable_from_network())
            self.assertFalse(transport.plain_http_from_network())

    def test_a_device_that_got_through_settles_it(self):
        """A proxy put in front by hand leaves every setting saying this machine only."""
        transport.declare_listener(reachable=False, direct=False)
        transport.note_request(_req("127.0.0.1"))
        self.assertFalse(transport.reachable_from_network())
        transport.note_request(_req("192.168.1.10", "https"))
        self.assertTrue(transport.reachable_from_network())
        self.assertFalse(transport.plain_http_from_network())

    def test_a_server_behind_its_proxy_is_reached_over_https_until_seen_otherwise(self):
        """Server mode on loopback is reachable only through the proxy; a wide bind is plain HTTP; and a
        device seen connecting in cleartext settles it whatever was declared."""
        transport.declare_listener(reachable=True, direct=False)
        self.assertTrue(transport.reachable_from_network())
        self.assertFalse(transport.plain_http_from_network())
        transport.note_request(_req("192.168.1.10", "http"))
        self.assertTrue(transport.plain_http_from_network())

        transport._seen_plain_http_from_network = False
        transport.declare_listener(reachable=True, direct=True)
        self.assertTrue(transport.plain_http_from_network())

    def test_a_checkout_on_a_wide_address_is_plain_http(self):
        with self._configured("0.0.0.0"):
            self.assertTrue(transport.plain_http_from_network())
        with self._configured("127.0.0.1"):
            self.assertFalse(transport.plain_http_from_network())


class PermissibleHttpTests(unittest.TestCase):
    def test_loopback_never_expects_https(self):
        r = _req("127.0.0.1", "http")
        self.assertFalse(transport.https_expected(r, perimeter_on=True))

    def test_networked_http_with_no_perimeter_is_permitted(self):
        r = _req("192.168.1.10", "http")
        self.assertFalse(transport.https_expected(r, perimeter_on=False))

    def test_networked_http_with_perimeter_expects_https(self):
        r = _req("192.168.1.10", "http")
        self.assertTrue(transport.https_expected(r, perimeter_on=True))

    def test_only_a_cleartext_request_from_another_device_is_unprotected(self):
        self.assertFalse(transport.link_is_protected(_req("192.168.1.10", "http")))
        self.assertTrue(transport.link_is_protected(_req("192.168.1.10", "https")))
        self.assertTrue(transport.link_is_protected(_req("127.0.0.1", "http")))


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
        # Networked HTTP with sign-in off: no credential on the wire, so nothing to recommend.
        self.assertIsNone(tasks._https_setup_task(_req("192.168.1.10", "http")))

    def test_perimeter_task_is_recommended_and_dismissible(self):
        cdb.enable_auth_mode()
        task = tasks._https_setup_task(_req("192.168.1.10", "http"))
        self.assertIsNotNone(task)
        self.assertFalse(task["required"])
        self.assertIn("dismiss_key", tasks._with_dismiss_keys([task])[0])
        self.assertIn("Passkeys", task["description"])

    def test_recommended_task_suppressible(self):
        cdb.enable_auth_mode()
        cdb.set_https_warning_suppressed(True)
        self.assertIsNone(tasks._https_setup_task(_req("192.168.1.10", "http")))

    def test_the_task_leads_to_the_install_steps(self):
        cdb.enable_auth_mode()
        task = tasks._https_setup_task(_req("192.168.1.10", "http"))
        self.assertEqual(task["link"], "/help/running-a-server")


if __name__ == "__main__":
    unittest.main()


class ProtectedLinkGateTests(unittest.TestCase):
    """The operations that put a provider secret on the wire are refused from another device over plain
    HTTP, whatever host the request names, and allowed from the same device once the link is protected.
    Driven through the real stack, because the claim is about the routes rather than the helper."""

    REFUSED = "protected_link_required"

    def _secret_bearing_calls(self, client):
        return {
            "save a provider secret": client.post("/api/providers/plaid/config",
                                                  json={"client_id": "id", "secret": "s3cret", "env": "sandbox"}),
            "reveal a provider secret": client.get("/api/providers/plaid/secret"),
            "connect with a pasted token": client.post("/api/providers/simplefin/connect",
                                                       json={"payload": {"setup_token": "x"}}),
            "open a Link session": client.get("/api/plaid/link-token"),
        }

    def _codes(self, client):
        codes = {}
        for name, response in self._secret_bearing_calls(client).items():
            detail = response.json().get("detail")
            codes[name] = detail.get("code") if isinstance(detail, dict) else None
        return codes

    def test_another_device_over_plain_http_is_refused_even_naming_itself_local(self):
        from backend.tests._api_client import LAN_CLIENT, api_client

        with api_client(base_url="http://localhost", client_host=LAN_CLIENT) as (client, _):
            for name, code in self._codes(client).items():
                self.assertEqual(code, self.REFUSED, name)

    def test_the_same_requests_pass_the_gate_once_the_link_is_protected(self):
        from backend.tests._api_client import LAN_CLIENT, api_client

        for kwargs in ({"base_url": "https://ledger.local", "client_host": LAN_CLIENT}, {}):
            with api_client(**kwargs) as (client, _):
                for name, code in self._codes(client).items():
                    self.assertNotEqual(code, self.REFUSED, f"{name} {kwargs}")

    def test_what_carries_no_provider_secret_is_left_alone(self):
        """A passphrase over plain HTTP is the operator's call on their own network, as sign-in is, and
        a save that leaves the secret untouched puts nothing secret on the wire."""
        from backend.tests._api_client import LAN_CLIENT, STRONG_PASSPHRASE, api_client

        with api_client(client_host=LAN_CLIENT) as (client, _):
            unlocked = client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(unlocked.status_code, 200, unlocked.text)
            saved = client.post("/api/providers/plaid/config", json={"client_id": "id", "env": "sandbox"})
            self.assertEqual(saved.status_code, 200, saved.text)


class BehindTheProxyTests(unittest.TestCase):
    """Loopback as the server's own proxy handling leaves it, rather than as a hand-built request: what
    uvicorn does with a forwarded address is the thing detection rests on, and it has changed between
    versions."""

    def _reads_as_loopback(self, peer: str, forwarded_for: str | None) -> bool:
        import asyncio

        from starlette.requests import Request
        from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

        seen = {}

        async def app(scope, receive, send):
            seen["loopback"] = transport.request_is_loopback(Request(scope))

        headers = [(b"x-forwarded-for", forwarded_for.encode())] if forwarded_for else []
        scope = {"type": "http", "client": (peer, 40000), "headers": headers, "scheme": "http",
                 "method": "GET", "path": "/", "query_string": b"", "server": ("127.0.0.1", 8010)}
        asyncio.run(ProxyHeadersMiddleware(app, trusted_hosts="127.0.0.1")(scope, None, None))
        return seen["loopback"]

    def test_a_device_reaching_the_proxy_is_the_network(self):
        self.assertFalse(self._reads_as_loopback("127.0.0.1", "192.168.1.50"))

    def test_a_browser_on_the_server_reaching_the_proxy_is_local(self):
        self.assertTrue(self._reads_as_loopback("127.0.0.1", "127.0.0.1"))

    def test_a_device_cannot_forward_a_local_address_for_itself(self):
        self.assertFalse(self._reads_as_loopback("192.168.1.50", "127.0.0.1"))

    def test_no_proxy_at_all(self):
        self.assertTrue(self._reads_as_loopback("127.0.0.1", None))
        self.assertFalse(self._reads_as_loopback("192.168.1.50", None))
