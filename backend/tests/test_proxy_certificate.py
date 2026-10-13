"""
The TLS proxy's root certificate, as handed to devices: fetched from the proxy's admin API, fingerprinted
the way a device states it, remembered so a later change is noticed, and reachable before sign-in.

A stand-in admin API serves a certificate made here, so the suite needs no proxy installed. The route
and the field it reads are Caddy's (`GET /pki/ca/local` -> `root_certificate`).
"""

from __future__ import annotations

import datetime
import json
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from backend.services import proxy_certificate
from backend.tests._api_client import api_client


def _root_pem(common_name: str) -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, common_name)])
    start = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start).not_valid_after(start + datetime.timedelta(days=3650))
        .sign(key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")


@contextmanager
def _proxy_admin(pem_holder: dict):
    """A proxy admin API answering with whatever `pem_holder["pem"]` is at the time of the request, so a
    test can change the authority underneath a running server."""
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != proxy_certificate.AUTHORITY_PATH:
                self.send_error(404)
                return
            body = json.dumps({"id": "local", "root_certificate": pem_holder["pem"]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with mock.patch.object(proxy_certificate, "ADMIN_URL", f"http://127.0.0.1:{server.server_port}"):
            yield
    finally:
        server.shutdown()
        server.server_close()


class ProxyCertificateTests(unittest.TestCase):
    def test_the_fingerprint_is_the_one_a_device_would_show(self):
        pem = _root_pem("Example Local Authority")
        expected = x509.load_pem_x509_certificate(pem.encode()).fingerprint(hashes.SHA256()).hex().upper()
        with _proxy_admin({"pem": pem}):
            certificate = proxy_certificate.fetch()
        self.assertEqual(certificate.fingerprint.replace(":", ""), expected)
        # The one the Windows certificate viewer shows, which has no SHA-256 to compare with.
        thumbprint = x509.load_pem_x509_certificate(pem.encode()).fingerprint(hashes.SHA1()).hex().upper()
        self.assertEqual(certificate.fingerprint_sha1.replace(":", ""), thumbprint)
        self.assertEqual(certificate.name, "Example Local Authority")
        self.assertEqual(certificate.pem, pem)

    def test_no_proxy_is_an_answer_rather_than_an_error(self):
        with mock.patch.object(proxy_certificate, "ADMIN_URL", "http://127.0.0.1:1"), api_client() as (client, _):
            self.assertEqual(client.get("/api/app/proxy-certificate").json(), {"available": False})
            self.assertEqual(client.get("/api/app/proxy-certificate/download").status_code, 404)

    def test_a_device_can_fetch_it_before_anyone_has_signed_in(self):
        """The certificate is what makes the connection trustworthy, so it cannot sit behind a sign-in
        made over that connection."""
        pem = _root_pem("Example Local Authority")
        with _proxy_admin({"pem": pem}), api_client() as (client, _):
            client.cookies.clear()
            self.assertEqual(client.get("/api/providers").status_code, 401, "the session is gone")

            described = client.get("/api/app/proxy-certificate")
            self.assertEqual(described.status_code, 200, described.text)
            self.assertTrue(described.json()["available"])

            download = client.get("/api/app/proxy-certificate/download")
            self.assertEqual(download.text, pem)
            # The type a device needs in order to offer installing the file instead of showing it.
            self.assertEqual(download.headers["content-type"], "application/x-x509-ca-cert")

    def test_a_new_authority_reads_as_changed_until_an_administrator_accepts_it(self):
        """The proxy mints a new authority if its data is lost, which devices experience as the server
        being refused everywhere at once. The first certificate seen is the baseline."""
        holder = {"pem": _root_pem("Example Local Authority")}
        with _proxy_admin(holder), api_client() as (client, _):
            first = client.get("/api/app/proxy-certificate").json()
            self.assertFalse(first["changed"])

            holder["pem"] = _root_pem("Example Local Authority")
            second = client.get("/api/app/proxy-certificate").json()
            self.assertNotEqual(second["fingerprint"], first["fingerprint"])
            self.assertTrue(second["changed"])
            self.assertTrue(client.get("/api/app/proxy-certificate").json()["changed"], "looking does not accept it")

            self.assertIn("proxy_certificate_changed", self._task_ids(client))

            accepted = client.post("/api/app/proxy-certificate/accept")
            self.assertEqual(accepted.status_code, 200, accepted.text)
            self.assertFalse(client.get("/api/app/proxy-certificate").json()["changed"])
            self.assertNotIn("proxy_certificate_changed", self._task_ids(client))

    def _task_ids(self, client) -> set[str]:
        return {task["id"] for task in client.get("/api/tasks").json()["tasks"]}

    def test_an_installation_that_never_had_a_proxy_does_not_go_looking_for_one(self):
        """The task is computed on every tasks read, on desktop installs too."""
        with mock.patch.object(proxy_certificate, "fetch") as fetch, api_client() as (client, _):
            self.assertNotIn("proxy_certificate_changed", self._task_ids(client))
        fetch.assert_not_called()
