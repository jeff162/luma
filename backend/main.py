# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Application bootstrap and request wiring for the backend.

This file ties together startup checks, middleware, and router registration. Its
main guarantee is that each API request runs against the correct tenant database
for the authenticated user or local-mode session before any router code executes.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Allow the dotenv path to be redirected: the Playwright E2E harness points LUMA_ENV_FILE at an
# isolated env file so its throwaway DB paths take effect. override=True still keeps the chosen .env
# authoritative over a stale shell environment — unchanged for the default repo .env.
load_dotenv(
    dotenv_path=os.getenv("LUMA_ENV_FILE") or (Path(__file__).resolve().parent.parent / ".env"),
    override=True,
)

from contextlib import asynccontextmanager

from backend.app_logging import log_warning

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from backend.db.control_database import auth_required, get_user_by_id, init_control_db
from backend.db.database import init_db, reset_current_db_path, set_current_db_path
from backend.routers import accounts, connections, auth, categories, import_export, owners, plaid, providers, recurring, rules, sync, tags, tasks, transactions
from backend.runtime_config import APP_NAME, runtime_config_status


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name, "") or "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _truthy_env(value: str | None, default: bool = False) -> bool:
    normalized = (value or "").strip().lower()
    if not normalized:
        return default
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _cors_origins() -> list[str]:
    configured = os.getenv("CORS_ORIGINS", "").strip()
    if configured:
        return [origin.strip() for origin in configured.split(",") if origin.strip()]
    frontend_port = _env_int("FRONTEND_PORT", 5173)
    frontend_docker_port = _env_int("FRONTEND_DOCKER_PORT", 3000)
    origins = [
        f"http://localhost:{frontend_port}",
        f"http://localhost:{frontend_docker_port}",
    ]
    return list(dict.fromkeys(origins))


class TenantSessionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Tenant selection is request-scoped: the control DB authenticates the user, then
        # the app DB context is switched for just this request and always reset afterward.
        public_paths = {
            "/api/health",
            "/api/auth/status",
            "/api/auth/runtime-config",
            "/api/auth/runtime-config/defaults",
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
    # Startup initializes both databases before any request handling so auth/session
    # decisions and tenant DB routing are never running against partial state.
    init_db()
    init_control_db()
    config_status = runtime_config_status()
    if not config_status["ok"]:
        log_warning(f"[config] {config_status['message']}")
    yield


app = FastAPI(title=APP_NAME, version="0.2.0", lifespan=lifespan)
app.add_middleware(TenantSessionMiddleware)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET", "dev-session-secret-change-me"),
    session_cookie=os.getenv("SESSION_COOKIE_NAME", "session"),
    # Mark the cookie Secure on a TLS-terminated (client-server) deployment so it never crosses the
    # network in cleartext. Driven by an explicit env the install sets — NOT derived from the security
    # profile (that is a recommendation, not a transport guarantee; deriving Secure from it would lock
    # out a network-profile install running plain HTTP) and NOT hardcoded (that breaks the loopback
    # desktop default). Left false for the loopback default where the cookie never leaves the machine.
    https_only=_truthy_env(os.getenv("SESSION_COOKIE_SECURE"), default=False),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
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
app.include_router(import_export.router, prefix="/api/import-export", tags=["import-export"])
app.include_router(tasks.router,         prefix="/api/tasks",         tags=["tasks"])
app.include_router(recurring.router,     prefix="/api/recurring",     tags=["recurring"])


@app.get("/api/health")
def health():
    return {"status": "ok"}
