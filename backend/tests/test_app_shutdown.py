"""App-level capabilities the UI has to ask about before offering: stopping the app, and the license
copy shipped with it.

Stopping is the asymmetry one:

the capability is registered by whoever owns the uvicorn server object, which is
only ever the desktop launcher, so a deployment started with plain uvicorn must not hand a signed-in
user a button that stops the service for everyone. The license route is the same shape from the UI's
side — a capability that may or may not be there, reported in the status payload so the About page can
decide whether a local fallback exists before it goes looking for one.
"""

import unittest
from unittest import mock

from backend.routers import app_control
from backend.tests._api_client import api_client


class ShutdownCapabilityTests(unittest.TestCase):
    def tearDown(self):
        # A handler left registered would leak into every later test in the process, including the ones
        # asserting the capability is absent.
        app_control.clear_shutdown_handler()

    def test_a_plain_server_cannot_be_stopped_through_the_api(self):
        """No launcher, no capability. The route exists — it is registered unconditionally — but it
        refuses, so the asymmetry lives in one place rather than in how the app is assembled."""
        with api_client() as (client, _):
            resp = client.post("/api/app/shutdown")
            self.assertEqual(resp.status_code, 404, resp.text)

    def test_the_status_payload_says_the_control_would_not_work(self):
        """What the UI reads to decide whether to offer the button at all."""
        with api_client() as (client, _):
            resp = client.get("/api/auth/status")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertFalse(resp.json()["app_shutdown_available"])

    def test_a_launcher_owned_process_stops_on_request(self):
        stopped = []
        app_control.register_shutdown_handler(lambda: stopped.append(True))

        with api_client() as (client, _):
            self.assertTrue(client.get("/api/auth/status").json()["app_shutdown_available"])

            resp = client.post("/api/app/shutdown")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertTrue(resp.json()["stopping"])

        # Asked for exactly once, and — the point of returning before stopping — the response arrived.
        self.assertEqual(stopped, [True])

    def test_stopping_requires_a_session(self):
        """It is not on the public path list, so the tenant middleware turns it away like any other
        endpoint. Worth pinning: a route that stops the process is the last one that should be
        reachable unauthenticated."""
        app_control.register_shutdown_handler(lambda: None)
        with api_client() as (client, _):
            client.cookies.clear()
            resp = client.post("/api/app/shutdown")
            self.assertEqual(resp.status_code, 401, resp.text)


class BundledLicenseTests(unittest.TestCase):
    """The AGPL copy that travels with a conveyed build.

    A checkout always has one (the repository's own LICENSE), so the interesting case is a build
    assembled without it: absent has to read as "no fallback offered", not as a broken page.
    """

    def test_a_checkout_serves_the_license_it_ships_with(self):
        with api_client() as (client, _):
            resp = client.get("/api/app/license")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertIn("GNU AFFERO GENERAL PUBLIC LICENSE", resp.text)
            self.assertTrue(resp.headers["content-type"].startswith("text/plain"))
            self.assertTrue(client.get("/api/auth/status").json()["bundled_license_available"])

    def test_a_build_without_one_says_so_rather_than_failing(self):
        with mock.patch("backend.routers.app_control.bundled_license_path", return_value=None):
            with api_client() as (client, _):
                self.assertFalse(client.get("/api/auth/status").json()["bundled_license_available"])
                self.assertEqual(client.get("/api/app/license").status_code, 404)
