"""SPA serving: client routes fall back to index.html, but `/api` never does.

The second half is the one worth guarding. The catch-all exists to make React Router's invented paths
work, and the obvious implementation makes *every* unmatched path return HTML — including API paths that
matched no router, which would hand `api.js` an HTML body where it parses a JSON `detail`.
"""

import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import spa
from backend.tests._api_client import api_client

INDEX_MARKER = "<div id=\"root\"></div>"


def _built_frontend(tmp: Path) -> Path:
    dist = tmp / "frontend" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX_MARKER)
    (dist / "assets" / "app-abc123.js").write_text("console.log('bundle')")
    return dist


def _client_for(dist_root: Path) -> TestClient:
    app = FastAPI()

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    spa.dist_dir = lambda: dist_root / "frontend" / "dist"
    assert spa.mount_spa(app)
    return TestClient(app)


def test_no_bundle_means_nothing_is_mounted():
    """A checkout that has never run `npm run build` still has to start — `npm run dev` proxies to it."""
    with tempfile.TemporaryDirectory() as tmp:
        original = spa.dist_dir
        try:
            spa.dist_dir = lambda: Path(tmp) / "frontend" / "dist"
            app = FastAPI()
            assert spa.mount_spa(app) is False
            assert TestClient(app).get("/transactions").status_code == 404
        finally:
            spa.dist_dir = original


def test_client_routes_and_assets():
    with tempfile.TemporaryDirectory() as tmp:
        original = spa.dist_dir
        try:
            _built_frontend(Path(tmp))
            client = _client_for(Path(tmp))

            for path in ("/", "/transactions", "/help/importing", "/does-not-exist"):
                response = client.get(path)
                assert response.status_code == 200, path
                assert INDEX_MARKER in response.text, path

            bundle = client.get("/assets/app-abc123.js")
            assert bundle.status_code == 200
            assert "console.log" in bundle.text
        finally:
            spa.dist_dir = original


def test_unmatched_api_path_stays_json():
    with tempfile.TemporaryDirectory() as tmp:
        original = spa.dist_dir
        try:
            _built_frontend(Path(tmp))
            client = _client_for(Path(tmp))

            assert client.get("/api/health").json() == {"status": "ok"}

            missing = client.get("/api/no-such-endpoint")
            assert missing.status_code == 404
            assert INDEX_MARKER not in missing.text
            assert missing.json()["detail"] == "Not Found"
        finally:
            spa.dist_dir = original


def test_traversal_cannot_escape_the_bundle():
    with tempfile.TemporaryDirectory() as tmp:
        original = spa.dist_dir
        try:
            root = Path(tmp)
            _built_frontend(root)
            (root / "secret.txt").write_text("not-for-the-browser")
            client = _client_for(root)

            # Percent-encoded so the client cannot normalize the traversal away before it is routed.
            response = client.get("/%2e%2e/%2e%2e/secret.txt")
            assert "not-for-the-browser" not in response.text
        finally:
            spa.dist_dir = original


def test_real_app_keeps_api_errors_json():
    """Ordering guard on `backend.main`: the catch-all is registered last, so it must not shadow the
    routers. Asserted through the API side because whether a bundle exists varies by checkout."""
    with api_client() as (client, _data_path):
        assert client.get("/api/health").json() == {"status": "ok"}

        missing = client.get("/api/accounts/does-not-exist-at-all")
        assert missing.status_code in (404, 405, 422)
        assert INDEX_MARKER not in missing.text
