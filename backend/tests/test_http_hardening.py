"""
The browser-facing hardening in `backend/http_hardening.py`, through the full application.

The host rule is the one that matters most: it is the only defence a loopback install with sign-in off
has against a website that re-points its own name at 127.0.0.1, so both halves are pinned — every name a
real install is reached by is answered, and a public name is refused unless listed.
"""

from __future__ import annotations

import unittest

from backend import http_hardening
from backend.tests._api_client import api_client


class HostRuleTest(unittest.TestCase):
    def test_names_a_page_on_the_internet_cannot_have_are_answered(self):
        for header in ("localhost:8010", "127.0.0.1:8010", "[::1]:8010", "192.168.1.20", "luma.local",
                       "LUMA.LOCAL.", "mybox", "app.localhost", "nas.home.arpa", "box.internal"):
            with self.subTest(header=header):
                self.assertTrue(http_hardening.host_is_allowed(http_hardening.host_from_header(header)))

    def test_a_public_name_is_refused_unless_listed(self):
        extra = http_hardening.parse_allowed_hosts(" Luma.Example.invalid , mybox.lan ")
        self.assertFalse(http_hardening.host_is_allowed("attacker.example"))
        self.assertFalse(http_hardening.host_is_allowed("mybox.lan"))
        self.assertTrue(http_hardening.host_is_allowed("mybox.lan", extra))
        self.assertTrue(http_hardening.host_is_allowed("luma.example.invalid", extra))
        self.assertFalse(http_hardening.host_is_allowed(""))

    def test_the_app_refuses_a_rebound_name(self):
        with api_client() as (client, _):
            refused = client.get("/api/health", headers={"host": "attacker.example:8010"})
            self.assertEqual(refused.status_code, 400)
            self.assertIn("ALLOWED_HOSTS", refused.text)
            self.assertEqual(client.get("/api/health", headers={"host": "localhost:8010"}).status_code, 200)


class CookieAndHeadersTest(unittest.TestCase):
    def _session_cookie(self, base_url):
        with api_client(base_url=base_url) as (client, _):
            created = client.post("/api/auth/identities", json={"name": "Second"}).json()["identity"]
            return client.post("/api/auth/select-identity", json={"user_id": created["id"]}).headers["set-cookie"]

    def test_the_session_cookie_is_strict_and_secure_only_over_https(self):
        plain = self._session_cookie("http://localhost")
        secure = self._session_cookie("https://luma.local")
        self.assertIn("samesite=strict", plain.lower())
        self.assertNotIn("secure", plain.lower())
        self.assertIn("; secure", secure.lower())

    def test_every_response_carries_the_framing_and_content_headers(self):
        with api_client() as (client, _):
            headers = client.get("/api/health").headers
        self.assertEqual(headers["x-frame-options"], "SAMEORIGIN")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertIn("frame-ancestors 'self'", headers["content-security-policy"])
        self.assertEqual(headers["referrer-policy"], "same-origin")
        self.assertEqual(headers["cache-control"], "no-store")

    def test_the_generated_api_pages_are_not_served(self):
        with api_client() as (client, _):
            for path in ("/docs", "/redoc", "/openapi.json"):
                with self.subTest(path=path):
                    self.assertNotIn("swagger", client.get(path).text.lower())
                    self.assertNotIn('"openapi"', client.get(path).text)

    def test_an_inline_script_is_allowed_by_its_hash_and_a_linked_one_is_not_hashed(self):
        html = '<script>var a = 1</script><script type="module" src="/x.js"></script>'
        hashes = http_hardening.inline_script_hashes(html)
        self.assertEqual(hashes, ("'sha256-h1HrJPkDwnmmTjhElzuRBLDNtr5UPz5PinuqE+ovmj8='",))
        self.assertIn(hashes[0], http_hardening.content_security_policy(hashes))


if __name__ == "__main__":
    unittest.main()
