"""Shared FastAPI TestClient harness.

Exercises endpoints through the FULL stack — routing, the tenant-session middleware, Query-param
default resolution, and response serialization — which the direct-router-call tests deliberately
bypass (and which is exactly where a class of bugs hides, e.g. unset Query() params arriving as
FieldInfo objects when a router is called as a plain function).

It points BOTH databases at fresh temp files. The control DB starts empty, so the app runs in local
mode with no signed-in user; the tenant middleware then leaves the request on the default (temp) data
DB, which is enough to reach the data endpoints. Patching the module-level DB_PATH / CONTROL_DB_PATH
(read at call time by get_db / get_control_db) is what makes the routing reach the request thread,
where a ContextVar set in the test thread would not.
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
    original_data, original_control = database.DB_PATH, control_database.CONTROL_DB_PATH
    database.DB_PATH = data_path
    control_database.CONTROL_DB_PATH = control_path
    database.init_db(data_path)
    control_database.init_control_db()
    from backend.main import app
    try:
        with TestClient(app) as client:
            yield client, data_path
    finally:
        database.DB_PATH = original_data
        control_database.CONTROL_DB_PATH = original_control
        tmp.cleanup()
