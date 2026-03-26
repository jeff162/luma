from dotenv import load_dotenv
load_dotenv()

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from db.control_database import auth_required, get_local_mode_user, get_user_by_id, init_control_db
from db.database import init_db, reset_current_db_path, set_current_db_path
from routers import accounts, auth, transactions, categories, plaid, sync, rules, owners, import_export, tasks


class TenantSessionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        public_paths = {
            "/api/health",
            "/api/auth/status",
            "/api/auth/bootstrap-status",
            "/api/auth/bootstrap",
            "/api/auth/enable",
            "/api/auth/login",
            "/api/auth/logout",
            "/api/auth/2fa/verify",
        }
        if request.url.path in public_paths or not request.url.path.startswith("/api/"):
            return await call_next(request)

        if not auth_required():
            local_user = get_local_mode_user()
            if not local_user:
                request.state.user = None
                return await call_next(request)
            token = set_current_db_path(local_user["db_path"])
            request.state.user = local_user
            try:
                return await call_next(request)
            finally:
                reset_current_db_path(token)

        session = request.scope.get("session")
        if session is None:
            return JSONResponse({"detail": "Session middleware is not available"}, status_code=500)

        user_id = session.get("user_id")
        if not user_id:
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
    init_db()
    init_control_db()
    yield


app = FastAPI(title="FinTrack", version="0.1.0", lifespan=lifespan)
app.add_middleware(TenantSessionMiddleware)
app.add_middleware(SessionMiddleware, secret_key=os.getenv("SESSION_SECRET", "dev-session-secret-change-me"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,         prefix="/api/auth",         tags=["auth"])
app.include_router(accounts.router,     prefix="/api/accounts",     tags=["accounts"])
app.include_router(transactions.router, prefix="/api/transactions",  tags=["transactions"])
app.include_router(categories.router,   prefix="/api/categories",    tags=["categories"])
app.include_router(plaid.router,        prefix="/api/plaid",         tags=["plaid"])
app.include_router(sync.router,         prefix="/api/sync",          tags=["sync"])
app.include_router(rules.router,        prefix="/api/rules",         tags=["rules"])
app.include_router(owners.router,       prefix="/api/owners",        tags=["owners"])
app.include_router(import_export.router, prefix="/api/import-export", tags=["import-export"])
app.include_router(tasks.router,         prefix="/api/tasks",         tags=["tasks"])


@app.get("/api/health")
def health():
    return {"status": "ok"}
