"""Shared FastAPI TestClient harness.

Exercises endpoints through the FULL stack — routing, the sign-in session middleware, Query-param
default resolution, and response serialization — which the direct-router-call tests deliberately
bypass (and which is exactly where a class of bugs hides, e.g. unset Query() params arriving as
FieldInfo objects when a router is called as a plain function).

It points BOTH databases at fresh temp files, so nothing touches the developer's real luma-data.db.
The sign-in session middleware requires a session in both modes, so the harness runs perimeter-off and
establishes one by creating a local identity and selecting it. Requests use the configured data DB,
which the harness has patched, so data endpoints reach exactly the temp DB the test seeds.
"""

import base64
import binascii
import json
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.db import control_database, database
from backend.services import attempt_limiter, crypto_service, sign_in_sessions

# A vault passphrase that actually clears the floor `crypto_service` enforces on every slot. Shared so a
# test setting one up says what it means rather than restating the policy — and because the literal it
# replaces, "a-strong-passphrase", was nineteen characters against a floor of twenty. It read as strong
# in twenty places while being the one thing the fixture claimed it was not, which is the failure mode a
# named constant exists to prevent.
STRONG_PASSPHRASE = "a-strong-vault-passphrase"


# A device elsewhere on the network, for `api_client(client_host=...)`. From the range reserved for
# documentation, so it is nobody's address.
LAN_CLIENT = "192.0.2.10"


def _arriving_from(app, client_host: str):
    """`app`, with every request made to look as if it came from `client_host`. Starlette's test client
    reports a fixed, non-address peer, and where a request came from is exactly what transport detection
    reads — so the harness has to be able to say."""
    async def wrapped(scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = {**scope, "client": (client_host, 50000)}
        await app(scope, receive, send)
    return wrapped


@contextmanager
def api_client(base_url: str | None = None, client_host: str = "127.0.0.1"):
    """A client on the server's own machine by default, which is what the desktop build serves and is
    right for everything that does not care how it is reached.

    The two arguments are for the cases that do. Transport detection reads the client's address and the
    scheme: `client_host=LAN_CLIENT` is a request from another device, refused the secret-bearing
    operations over HTTP, and an `https://` `base_url` is that same device behind TLS. The host in
    `base_url` matters separately, to a passkey ceremony, whose Relying Party id it becomes.
    """
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    originals = (
        database.DB_PATH,
        control_database.DB_PATH,
        control_database.CONTROL_DB_PATH,
    )
    database.DB_PATH = data_path
    control_database.DB_PATH = data_path
    control_database.CONTROL_DB_PATH = control_path
    database.init_db(data_path)
    control_database.init_control_db()
    from backend.main import app
    try:
        with TestClient(_arriving_from(app, client_host), base_url=base_url or "http://testserver") as client:
            # Establish a perimeter-off identity so the sign-in session middleware resolves a session. Every data
            # endpoint runs as this selected identity.
            created = client.post("/api/auth/identities", json={"name": "Tester"})
            assert created.status_code == 200, f"identity creation failed: {created.text}"
            identity = created.json()["identity"]
            # Checked rather than fired and forgotten: a select that does not take leaves a session with
            # no `user_id`, and every later request in the test 401s somewhere far away from the cause.
            selected = client.post("/api/auth/select-identity", json={"user_id": identity["id"]})
            assert selected.status_code == 200, f"identity selection failed: {selected.text}"
            yield client, data_path
    finally:
        (
            database.DB_PATH,
            control_database.DB_PATH,
            control_database.CONTROL_DB_PATH,
        ) = originals
        tmp.cleanup()


@contextmanager
def in_browser_session(client):
    """Run service-level vault calls as part of this test client's browser session.

    An unlock belongs to the browser session that presented the secret (`crypto_service` -> the unlock
    cache). A test that unlocks over HTTP and then calls the vault service directly is, to the service, a
    different session with nothing unlocked — so this joins the client's session for the block. The scope
    is read out of the session cookie, whose payload is signed but not encrypted.
    """
    scope = None
    for value in client.cookies.values():
        try:
            payload = json.loads(base64.b64decode(value.split(".")[0]))
        except (ValueError, binascii.Error):
            continue
        if isinstance(payload, dict) and payload.get(sign_in_sessions.SESSION_ID_KEY):
            scope = payload[sign_in_sessions.SESSION_ID_KEY]
            break
    token = crypto_service.set_vault_scope(scope)
    try:
        yield
    finally:
        crypto_service.reset_vault_scope(token)


def exported_credentials(client) -> dict:
    """The data-source credentials a backup taken through `client` carries — the connections and provider
    configurations as ciphertext, with the exporter's vault slots."""
    import io
    import zipfile

    from backend.routers.import_export.backup import ACCOUNTS_CREDENTIALS_MEMBER

    exported = client.get("/api/import-export/backup")
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as zf:
        return json.loads(zf.read(ACCOUNTS_CREDENTIALS_MEMBER))


class LimiterClock:
    """Stands in for the attempt limiter's clock (`limiter_clock`)."""

    def __init__(self):
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@contextmanager
def limiter_clock():
    """Let a test step past the attempt limiter's spacing or a lockout without sleeping. Two attempts at
    one secret inside `MIN_SPACING_SECONDS` of each other are refused, so a test that tries a wrong secret
    and then the right one has to move time between them, exactly as a person typing would."""
    clock = LimiterClock()
    with mock.patch.object(attempt_limiter, "_now", clock):
        yield clock
