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

import tempfile
from contextlib import contextmanager
from pathlib import Path

from fastapi.testclient import TestClient

from backend.db import control_database, database


@contextmanager
def api_client():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    tenant_root = Path(tmp.name) / "tenants"
    originals = (
        database.DB_PATH,
        control_database.DB_PATH,
        control_database.CONTROL_DB_PATH,
        control_database.TENANT_DATA_ROOT,
    )
    database.DB_PATH = data_path
    control_database.DB_PATH = data_path
    control_database.CONTROL_DB_PATH = control_path
    control_database.TENANT_DATA_ROOT = tenant_root
    database.init_db(data_path)
    control_database.init_control_db()
    from backend.main import app
    try:
        with TestClient(app) as client:
            # Establish a perimeter-off identity so the tenant middleware resolves a session (and routes
            # to the temp data DB). Every data endpoint runs as this selected identity.
            identity = client.post("/api/auth/identities", json={"name": "Tester"}).json()["identity"]
            client.post("/api/auth/select-identity", json={"user_id": identity["id"]})
            yield client, data_path
    finally:
        (
            database.DB_PATH,
            control_database.DB_PATH,
            control_database.CONTROL_DB_PATH,
            control_database.TENANT_DATA_ROOT,
        ) = originals
        tmp.cleanup()
