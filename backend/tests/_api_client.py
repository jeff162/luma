"""Shared FastAPI TestClient harness.

Exercises endpoints through the FULL stack — routing, the tenant-session middleware, Query-param
default resolution, and response serialization — which the direct-router-call tests deliberately
bypass (and which is exactly where a class of bugs hides, e.g. unset Query() params arriving as
FieldInfo objects when a router is called as a plain function).

It points BOTH databases at fresh temp files (control DB, data DB, and the tenant root, so nothing
touches the developer's real luma-data.db). Identity is uniform now — the tenant middleware requires a
session in both modes — so the harness runs perimeter-off and establishes one by creating a local
identity and selecting it. That identity adopts the temp data DB (its tenant db_path is the legacy
path, which the harness has patched), so data endpoints reach exactly the temp DB the test seeds.
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


@contextmanager
def api_client(base_url: str | None = None):
    """The default `http://testserver` is right for everything that does not care what host it is on.

    `base_url` exists for the cases that do: transport detection reads the request's host and scheme, so
    a passkey ceremony refuses to run on `testserver` over HTTP exactly as it would on a real cleartext
    LAN address. Passing `http://localhost` puts the harness on the loopback host those tests need, which
    is also what the desktop build actually serves.
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
        with TestClient(app, base_url=base_url or "http://testserver") as client:
            # Establish a perimeter-off identity so the tenant middleware resolves a session (and routes
            # to the temp data DB). Every data endpoint runs as this selected identity.
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
