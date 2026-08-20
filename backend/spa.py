# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Serving the built SPA from the API process, so one process is a whole application.

Nothing in the app served `frontend/dist` before this: the Vite dev server does it in development and
nginx does it in the Docker image, which is why both of those topologies need two processes. A packaged
single-user build has neither, so the backend serves the bundle itself and the SPA and the API share one
origin by construction rather than by proxy configuration.

Two rules make that work, and both are about what a *client route* is:

- **Client routes are not files.** `/transactions` and `/help/:topic` are React Router inventions; there
  is no `dist/transactions/index.html`. Any path that does not resolve to a real file therefore returns
  `index.html` and lets the router read the URL — the same job nginx does with
  `try_files $uri $uri/ /index.html`.
- **`/api` is never a client route.** The catch-all is registered after every router, so it only sees API
  paths that matched nothing — and those have to stay JSON 404s. Returning `index.html` there would hand
  `api.js` an HTML body where it expects a `detail`, turning every genuine 404 into a parse error.

Mounting is optional and reported: a checkout that has never run `npm run build` has no `dist/`, and the
backend still has to start for `npm run dev` to proxy to it.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from backend import runtime_config


def dist_dir() -> Path:
    """`bundle_root`, not `install_root`: the built frontend is shipped *inside* a packaged build, so in
    a onefile binary it lives in the unpacked temp directory rather than beside the executable."""
    return runtime_config.bundle_root() / "frontend" / "dist"


def mount_spa(app: FastAPI) -> bool:
    """Register SPA serving on `app`, or report that there is no bundle to serve.

    Registers a catch-all, so it has to be called *after* every API router — a route registered earlier
    would shadow them all."""
    dist = dist_dir().resolve()
    index = dist / "index.html"
    if not index.is_file():
        return False

    @app.get("/{spa_path:path}", include_in_schema=False)
    def serve_spa(spa_path: str):
        if spa_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        # `spa_path` is attacker-controlled and may contain `..` or an absolute path, so containment is
        # checked after resolution rather than by inspecting the string.
        candidate = (dist / spa_path).resolve()
        if spa_path and candidate.is_file() and candidate.is_relative_to(dist):
            return FileResponse(candidate)

        return FileResponse(index)

    return True
