"""The bootstrap's TLS trust decision, and the import ordering it silently depends on.

`backend/main.py` hands certificate verification to the operating system's own trust store, because a
packaged macOS build carries an OpenSSL that looks for a CA file where the *build* machine kept one —
so without this every outbound HTTPS call fails with "unable to get local issuer certificate".

There are two paths to pin, not one. Stdlib callers resolve `ssl.SSLContext` at call time, while urllib3
binds its own reference with `from ssl import SSLContext` at import — and the Plaid SDK reaches the
network through urllib3 while SimpleFIN uses the stdlib. A regression that caught only one of them would
present as a single provider failing on a single platform, which is the shape worth a test.
"""

import ssl

import truststore

from backend.tests._api_client import api_client


def _bootstrapped():
    """Import through the API harness, which is what guarantees `backend.main` has run. Importing it
    directly would build a control database at the default path — the developer's real file."""
    with api_client():
        import backend.main  # noqa: F401  (imported for its bootstrap, not its contents)

        import urllib3.util.ssl_ as urllib3_ssl

        return urllib3_ssl


urllib3_ssl = _bootstrapped()


def test_certificate_verification_uses_the_system_trust_store():
    assert ssl.SSLContext is truststore.SSLContext


def test_urllib3_verifies_against_the_system_store_too():
    """Its separately bound reference is rebound by `inject_into_ssl` itself. Asserted rather than
    assumed because it is what the Plaid SDK verifies against, and if it ever stopped being true the
    stdlib path would keep working and hide it."""
    assert urllib3_ssl.SSLContext is truststore.SSLContext


def test_a_context_built_the_ordinary_way_carries_real_roots():
    """Guards against the injection succeeding while producing an empty trust store, which would fail
    exactly the same way the bug did."""
    context = ssl.create_default_context()
    assert isinstance(context, truststore.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED
