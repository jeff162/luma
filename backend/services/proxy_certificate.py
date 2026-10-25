# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The root certificate of the TLS proxy in front of a server installation, handed on to the devices that
have to trust it.

The proxy (Caddy) issues the server's certificate from a certificate authority of its own, which no
device trusts until its root is installed there. The root is public, and the proxy serves it on its
admin API — reachable from this machine only — so it is fetched from there on request rather than read
from the proxy's files, which belong to another user and are not readable by this process.

**The fingerprint exists for one moment: a device's first visit.** That is the only time the certificate
is fetched over a connection nothing vouches for yet, so it is the only time one could be swapped on the
way. Comparing the fingerprint beside the download against one read from the server itself catches
that — which is why the server has a way to state it that does not pass through the browser
(`backend/desktop.py --certificate-fingerprint`). After that the device's own trust store checks every
connection, and nobody compares anything again.

**The fingerprint first seen is kept, so a different one later is noticed.** The proxy mints a new
authority if its data is lost, and from the outside that looks like every device refusing the server at
once with nothing to explain it. Keeping the fingerprint is what turns that into a stated fact. It lives
in the control database, which is this machine's own state and travels with no backup.

Nothing here runs unless asked: an installation with no proxy never contacts the admin port.
"""

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

from cryptography import x509
from cryptography.hazmat.primitives import hashes

from backend.db.control_database import get_app_setting, set_app_setting

# Caddy's defaults: the admin API on loopback, and the authority it issues local certificates from.
ADMIN_URL = "http://localhost:2019"
AUTHORITY_PATH = "/pki/ca/local"
FETCH_TIMEOUT_SECONDS = 2

ACCEPTED_FINGERPRINT_KEY = "proxy_root_fingerprint"


class ProxyCertificateUnavailable(Exception):
    """No root certificate could be had from a proxy on this machine — there is none, it is not running,
    or what answered on that port is something else."""


@dataclass(frozen=True)
class RootCertificate:
    pem: str
    # SHA-256 over the certificate itself, in the colon-separated form a device shows when asked about
    # a certificate, so the two can be compared by eye.
    fingerprint: str
    # The same in SHA-1, which is the only one the Windows certificate viewer shows (as "Thumbprint").
    # Offered for comparing against that screen and nothing else: what is kept on record is the SHA-256.
    fingerprint_sha1: str
    name: str
    expires: str


def _fingerprint(certificate: x509.Certificate, algorithm: hashes.HashAlgorithm) -> str:
    return ":".join(f"{byte:02X}" for byte in certificate.fingerprint(algorithm))


def fetch() -> RootCertificate:
    # No proxy from the environment: this is a call to this machine, and an `http_proxy` set for the
    # provider calls would otherwise carry it off the machine.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"{ADMIN_URL}{AUTHORITY_PATH}", timeout=FETCH_TIMEOUT_SECONDS) as response:
            pem = json.load(response)["root_certificate"]
        certificate = x509.load_pem_x509_certificate(pem.encode("ascii"))
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as exc:
        raise ProxyCertificateUnavailable(str(exc)) from exc

    names = certificate.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    return RootCertificate(
        pem=pem,
        fingerprint=_fingerprint(certificate, hashes.SHA256()),
        # SHA-1 is unfit for signing and fine for this: it is compared against a value a person reads
        # off their own device, not relied on to resist a forged certificate.
        fingerprint_sha1=_fingerprint(certificate, hashes.SHA1()),
        name=names[0].value if names else "",
        expires=certificate.not_valid_after_utc.date().isoformat(),
    )


def accept(certificate: RootCertificate) -> None:
    """Record `certificate` as the one this installation's devices are expected to trust."""
    set_app_setting(ACCEPTED_FINGERPRINT_KEY, certificate.fingerprint)


def is_running() -> bool:
    """Whether a proxy on this machine answers now. A stopped or absent one refuses the connection at once."""
    try:
        fetch()
    except ProxyCertificateUnavailable:
        return False
    return True


def has_record() -> bool:
    """Whether a certificate has been handed out here, which is what makes a change to it matter."""
    return bool(get_app_setting(ACCEPTED_FINGERPRINT_KEY))


def changed_from_record() -> bool:
    """Whether the proxy now presents a different root than the one on record.

    False wherever that cannot be said: with nothing on record there is nothing to have changed from —
    and the proxy is not contacted at all, so an installation that never had one pays nothing for being
    asked — and a proxy that does not answer is a stopped proxy, not a new certificate."""
    accepted = get_app_setting(ACCEPTED_FINGERPRINT_KEY)
    if not accepted:
        return False
    try:
        return fetch().fingerprint != accepted
    except ProxyCertificateUnavailable:
        return False


def describe() -> dict:
    """The current root certificate and whether it is the one on record, for the page that hands it out.

    The first one seen is recorded on the way through: there is nothing to compare it against, and
    whoever is setting the server up has just been shown it."""
    try:
        certificate = fetch()
    except ProxyCertificateUnavailable:
        return {"available": False}

    accepted = get_app_setting(ACCEPTED_FINGERPRINT_KEY)
    if not accepted:
        accept(certificate)
        accepted = certificate.fingerprint
    return {
        "available": True,
        "fingerprint": certificate.fingerprint,
        "fingerprint_sha1": certificate.fingerprint_sha1,
        "name": certificate.name,
        "expires": certificate.expires,
        "changed": certificate.fingerprint != accepted,
    }
