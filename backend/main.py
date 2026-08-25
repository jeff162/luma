# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Application bootstrap and request wiring for the backend.

This file ties together startup configuration, middleware, and router registration. Its main guarantee
is that each API request runs against the correct database for the authenticated user or local-mode
session before any router code executes.

Configuration is resolved *before* the app object exists, because the session secret and cookie name are
constructor arguments to `SessionMiddleware` rather than something a request can look up later. That is
why the control database is initialized here at import rather than in the lifespan hook — the stored
half of the configuration lives in it. See `app_config.py` for the layering.
"""

import sys

from dotenv import load_dotenv

from backend.runtime_config import env_file_path

# The `.env` file is optional — an install without one runs on defaults plus stored settings. When one
# is present it stays authoritative over a stale shell environment (override=True), which is also what
# lets the Playwright harness redirect LUMA_ENV_FILE at an isolated file and get its throwaway DB paths.
load_dotenv(dotenv_path=env_file_path(), override=True)

# Verify TLS against the operating system's trust store rather than a CA bundle pinned in this
# repository. Not a preference: a packaged macOS build has no usable CA file at all, because the OpenSSL
# inside it looks where the *build* machine kept one, and every outbound HTTPS call fails with
# "unable to get local issuer certificate". The alternative — shipping `certifi` — would be a snapshot
# of the world that ages, ignores roots the user installed, and keeps trusting roots the OS has since
# distrusted.
#
# Placed above the other imports as a matter of course rather than to satisfy a live constraint.
# `inject_into_ssl` replaces `ssl.SSLContext`, so a library that binds its own reference with
# `from ssl import SSLContext` at import time would otherwise keep the original — which urllib3 does,
# and which truststore itself rebinds explicitly, so the Plaid SDK riding on urllib3 is covered either
# way. The placement is insurance against a future dependency that binds the name and gets no such
# help. `backend/tests/test_system_trust_store.py` pins the outcome for both paths.
try:
    import truststore

    truststore.inject_into_ssl()
except Exception as error:  # noqa: BLE001 - see below
    # Deliberately broad, and deliberately not fatal. This reaches into platform APIs through ctypes, so
    # the ways it can fail are open-ended and platform-specific; a failure here leaves TLS exactly where
    # it would have been without it, which is worth strictly more than refusing to start.
    print(f"Could not use the system certificate store ({error}); TLS falls back to OpenSSL defaults.",
          file=sys.stderr)

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from backend import app_config, runtime_config, spa
from backend.db.control_database import auth_required, get_user_by_id, init_control_db
from backend.db.database import init_db, reset_current_db_path, set_current_db_path
from backend.routers import accounts, app_control, connections, auth, categories, currency, documents, import_export, owners, plaid, providers, purchases, recurring, rules, sync, tags, tasks, transactions


class TenantSessionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Tenant selection is request-scoped: the control DB authenticates the user, then
        # the app DB context is switched for just this request and always reset afterward.
        public_paths = {
            "/api/health",
            "/api/auth/status",
            "/api/auth/bootstrap-status",
            "/api/auth/bootstrap",
            "/api/auth/enable",
            "/api/auth/login",
            "/api/auth/logout",
            "/api/auth/2fa/verify",
            "/api/auth/change-password",
            "/api/auth/identities",
            "/api/auth/select-identity",
        }
        if request.url.path in public_paths or not request.url.path.startswith("/api/"):
            return await call_next(request)

        # One identity path for both modes: the session carries `user_id`. `auth_enabled` governs only
        # whether a *password* was required to establish that session — a perimeter-off session is
        # marked `pwless` (identity chosen from the chooser, no password). When the perimeter is on, a
        # `pwless` session is stale (auth was enabled after it was created) and must re-authenticate;
        # Starlette sessions are stateless signed cookies, so this per-request check is the invalidation.
        session = request.scope.get("session")
        if session is None:
            return JSONResponse({"detail": "Session middleware is not available"}, status_code=500)

        user_id = session.get("user_id")
        if not user_id:
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
        if auth_required() and session.get("pwless"):
            session.clear()
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)

        user = get_user_by_id(user_id)
        if not user:
            session.clear()
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)

        token = set_current_db_path(user["db_path"])
        request.state.user = user
        try:
            return await call_next(request)
        finally:
            reset_current_db_path(token)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The control DB is already initialized (configuration was resolved from it below); this readies the
    # financial database so no request handling starts against partial state.
    init_db()
    yield


# The control database has to exist before configuration can be resolved out of it, and configuration
# has to be resolved before the middleware stack is built.
init_control_db()
config = app_config.resolve()

app = FastAPI(title=config.app_name, version=runtime_config.APP_VERSION, lifespan=lifespan)
app.add_middleware(TenantSessionMiddleware)
app.add_middleware(
    SessionMiddleware,
    # Generated and stored on first run rather than required up front, so a fresh install needs no
    # configuration file. It has to persist: a secret regenerated per boot would sign every session out.
    secret_key=config.session_secret,
    session_cookie=config.session_cookie_name,
    # Mark the cookie Secure on a TLS-terminated (client-server) deployment so it never crosses the
    # network in cleartext. Driven by an explicit env the install sets — NOT derived from the security
    # profile (that is a recommendation, not a transport guarantee; deriving Secure from it would lock
    # out a network-profile install running plain HTTP) and NOT hardcoded (that breaks the loopback
    # desktop default). Left false for the loopback default where the cookie never leaves the machine.
    https_only=config.session_cookie_secure,
)

# Empty by default, which disables cross-origin access entirely: every shipped topology serves the SPA
# and the API on one origin — dev proxies `/api` through Vite, Docker through nginx, and the standalone
# build serves `dist/` from this very process (see `spa.py`) — so the browser never makes a cross-origin
# call. Since the grant is credentialed, a standing default would let any page on a listed origin call
# this API with the session cookie attached and read the response — a surface bought for nothing.
# `CORS_ORIGINS` is the escape hatch for a split-origin deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(config.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,         prefix="/api/auth",         tags=["auth"])
app.include_router(accounts.router,     prefix="/api/accounts",     tags=["accounts"])
app.include_router(transactions.router, prefix="/api/transactions",  tags=["transactions"])
app.include_router(categories.router,   prefix="/api/categories",    tags=["categories"])
app.include_router(plaid.router,        prefix="/api/plaid",         tags=["plaid"])
app.include_router(providers.router,    prefix="/api/providers",     tags=["providers"])
app.include_router(connections.router,  prefix="/api/connections",   tags=["connections"])
app.include_router(sync.router,         prefix="/api/sync",          tags=["sync"])
app.include_router(rules.router,        prefix="/api/rules",         tags=["rules"])
app.include_router(owners.router,       prefix="/api/owners",        tags=["owners"])
app.include_router(tags.router,         prefix="/api/tags",          tags=["tags"])
app.include_router(documents.router,    prefix="/api/documents",     tags=["documents"])
app.include_router(purchases.router,    prefix="/api/purchases",     tags=["purchases"])
app.include_router(import_export.router, prefix="/api/import-export", tags=["import-export"])
app.include_router(tasks.router,         prefix="/api/tasks",         tags=["tasks"])
app.include_router(recurring.router,     prefix="/api/recurring",     tags=["recurring"])
app.include_router(currency.router,      prefix="/api/currency",      tags=["currency"])
app.include_router(app_control.router,   prefix="/api/app",           tags=["app"])


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Last, deliberately: this registers a catch-all that would shadow every route above it.
spa_mounted = spa.mount_spa(app)
