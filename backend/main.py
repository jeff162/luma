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

# First, before anything that can reach the database modules (see the module).
import backend.load_env_file  # noqa: F401

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

import base64
import json
from contextlib import asynccontextmanager

import itsdangerous
from itsdangerous.encoding import base64_decode
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from backend import app_config, app_log_file, runtime_config, spa
from backend.app_logging import log_warning
from backend.db.control_database import auth_required, get_user_by_id, init_control_db
from backend.db.database import init_db, reset_current_db_path, set_current_db_path
from backend.session_signing import ClockSkewTolerantSessionMiddleware, ClockSkewTolerantSigner
from backend.services import crypto_service, sign_in_sessions
from backend.routers import accounts, app_control, connections, auth, categories, currency, diagnostics, documents, import_export, owners, plaid, providers, purchases, recurring, reimbursements, rules, sync, tags, tasks, transactions


# Passed explicitly below so the session's lifetime is stated rather than inherited, and taken from the
# session registry so the cookie and its row expire together. The re-verify diagnostic has to age a cookie
# exactly as the middleware does — same value and same signer — or it would answer a different question
# than the one being asked.
_SESSION_MAX_AGE_SECONDS = sign_in_sessions.MAX_AGE_SECONDS


def _signed_age(raw: str) -> str:
    """How old the cookie's own timestamp is, in seconds, or "unreadable". Negative means it was signed
    *ahead* of the clock now verifying it."""
    try:
        signer = ClockSkewTolerantSigner(str(config.session_secret))
        stamp = int.from_bytes(base64_decode(raw.split(".")[1]), "big")
        return f"{signer.get_timestamp() - stamp}s"
    except Exception:  # noqa: BLE001 - a diagnostic must never be the thing that raises
        return "unreadable"


def _reverified_here(raw: str | None) -> str:
    """Whether *this process*, with *its own* secret, can verify the cookie it was just handed — and
    whether what comes out names a user. Reports a verdict only; the payload is never logged.

    This exists because a preserved trace of the intermittent 401 answered every question the rest of
    this line can ask, and the answer ruled out its own premise. The rejected cookie was pulled from the
    trace and unsigned offline against the harness's pinned secret: valid signature, `user_id` present,
    intact length, sent once. Yet the middleware had handed the app an empty session. So
    "signed cookie, session keys: -" does **not** imply the signature failed, which is what it had been
    read as, and the remaining explanations split on exactly this test:

    * **verifies, user_id present** — the cookie is good and the session still arrived empty, so the
      fault is in the decode/populate step or in the scope, and cookie custody can be dropped from the
      investigation entirely.
    * **BadSignature** — this process cannot verify what an offline check with the configured secret
      can, so the process is not holding the secret the configuration names, and the reasoning that
      called that impossible has to be re-examined from `app_config.resolve()` outward.

    Cheap enough to be unconditional: it runs only on the rejection path, which is rare by construction.

    It answered on its first firing, and the answer was `expired` at a *negative* age — the host clock
    stepping backwards, which is now handled (`backend/session_signing.py`). The instrument stays: it is
    what would name the next cause as quickly, and a diagnostic for a 1-in-11 failure that has silently
    rotted costs another eleven runs to discover. See `docs/security-model.md` → *Identity and the
    network perimeter*.
    """
    if not raw or raw == "null":
        return "-"
    try:
        data = ClockSkewTolerantSigner(str(config.session_secret)).unsign(
            raw.encode(), max_age=_SESSION_MAX_AGE_SECONDS
        )
    except itsdangerous.SignatureExpired:
        # The middleware's own signer, so this verdict is the middleware's verdict — a diagnostic that
        # answered with a *different* signer would report an expiry the app did not act on. A backwards
        # clock step no longer reaches here (`session_signing.py` tolerates a stamp up to five minutes
        # ahead), so this is now either a genuinely stale client or a skew past that tolerance. The age
        # is what separates them: positive is age, negative is the clock. It is a duration, not anything
        # about the session.
        return f"expired (age {_signed_age(raw)})"
    except itsdangerous.BadSignature:
        return "BadSignature"
    except Exception:  # noqa: BLE001 - a diagnostic must never be the thing that raises
        return "unreadable"
    try:
        payload = json.loads(base64.b64decode(data))
    except Exception:  # noqa: BLE001 - as above
        return "verifies, unreadable payload"
    if not isinstance(payload, dict):
        return "verifies, unreadable payload"
    return "verifies, user_id present" if payload.get("user_id") else "verifies, no user_id"


def _not_authenticated(reason: str, request: Request) -> JSONResponse:
    """Reject a request as unauthenticated, recording *which* check rejected it.

    The response body stays one opaque message on purpose: which of the checks below fired is
    not a caller's business, and answering it would tell an unauthenticated caller whether a user id
    exists. The reason is logged instead, because most of them **clear the session** — a user who
    was signed out mid-session otherwise has no trace to point at, and neither does anyone asked why.

    Whether the request *carried* a session cookie is logged alongside it, because the reason alone
    cannot separate the two cases that matter most. `SessionMiddleware` answers a cookie whose
    signature does not verify with ``scope["session"] = {}`` — byte-identical, from here, to a request
    that sent no cookie at all — so "no user_id" spans both a session that was never established (or
    was cleared, which deletes the cookie) and one signed under a *different* secret than this process
    verifies with. Presence alone separates them; the value is never logged, since it is the session.

    Presence turned out not to be enough. A real occurrence logged "with a session cookie: no user_id"
    on four requests inside one second, and that single line is produced by three different situations
    that want three different fixes: a cookie whose signature did not verify (session decodes to ``{}``),
    a client still holding a *cleared* cookie (Starlette writes the literal ``null`` when a session is
    emptied, and a request carrying it looks identical here), and a session that verified perfectly well
    but was written without a ``user_id``. Two more facts separate all three, and neither is the session:

    * ``keys`` — the session's field *names*, never their values. Empty means the session did not decode
      or was cleared; non-empty without ``user_id`` means something wrote a session that never had one.
    * ``cookie`` — whether the value is absent, empty, or Starlette's cleared marker. A property of the
      value rather than the value itself, so nothing signed or secret is written to the log.

    Those two narrowed it to a cookie that fails verification — and a preserved trace then showed the
    rejected cookie verifying perfectly well, which leaves that reading with nothing to stand on. The
    third fact is the one that settles it: whether this process can verify the value itself
    (``_reverified_here``).
    """
    raw = request.cookies.get(config.session_cookie_name)
    if raw is None:
        cookie_state = "no cookie"
    elif raw == "" or raw == "null":
        # Starlette empties the cookie rather than only expiring it, so a client that has not yet dropped
        # it keeps sending this — which is a *cleared session*, not a failed signature.
        cookie_state = "cleared cookie"
    else:
        cookie_state = "signed cookie"
    # `.keys()` only: the session is the value, and this line exists to be pasted into a bug report.
    keys = ",".join(sorted(request.session.keys())) or "-"
    log_warning(
        f"[auth] rejected {request.url.path} ({cookie_state}, session keys: {keys}, "
        f"re-verified here: {_reverified_here(raw)}): {reason}"
    )
    return JSONResponse({"detail": "Not authenticated"}, status_code=401)


class TenantSessionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        session = request.scope.get("session")
        # A valid signature is not enough: the session also has to still exist (`sign_in_sessions`). Checked
        # before anything reads the session — the public paths included, since `/api/auth/status` reports
        # the signed-in user from it — and only on API paths, which are the only ones that read it.
        ended = bool(
            session is not None
            and session.get("user_id")
            and request.url.path.startswith("/api/")
            and not sign_in_sessions.is_live(session)
        )
        if ended:
            session.clear()
        # Bound before the public-path check, because `/api/auth/status` is public and reports whether this
        # session is unlocked. The session id is the vault scope: see `crypto_service` -> the unlock cache.
        vault_scope = crypto_service.set_vault_scope(sign_in_sessions.session_id(session))
        try:
            return await self._resolve_tenant(request, call_next, ended)
        finally:
            crypto_service.reset_vault_scope(vault_scope)

    async def _resolve_tenant(self, request: Request, call_next, ended: bool):
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
            # Signing in with a passkey is the ceremony that *establishes* a session, so its two halves
            # are public exactly as `/login` is. Registering one is not here: a passkey may only be added
            # from a session that already signed in some other way.
            "/api/auth/passkey/params",
            "/api/auth/passkey/login/begin",
            "/api/auth/passkey/login/complete",
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
            if ended:
                return _not_authenticated("the session was signed out, revoked or has expired", request)
            return _not_authenticated("no user_id on the session", request)
        if auth_required() and session.get("pwless"):
            sign_in_sessions.end(session)
            return _not_authenticated(
                "passwordless session, but the perimeter is on", request
            )

        user = get_user_by_id(user_id)
        if not user:
            session.clear()
            return _not_authenticated(
                f"session user_id {user_id!r} is not in the control database", request
            )

        token = set_current_db_path(user["db_path"])
        request.state.user = user
        try:
            return await call_next(request)
        finally:
            reset_current_db_path(token)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # A copy of the server's log beside the data, whatever is or is not capturing its output. After uvicorn
    # has configured its loggers, which the handler has to sit beside rather than replace (`app_log_file.py`).
    # Before `init_db`, so a start that fails there is kept and counted for the Tasks reminder — and left
    # attached when it does, since uvicorn reports the failure only after this function has raised.
    app_log_file.install()
    # The control DB is already initialized (configuration was resolved from it below); this readies the
    # financial database so no request handling starts against partial state.
    init_db()
    try:
        yield
    finally:
        app_log_file.uninstall()


# The control database has to exist before configuration can be resolved out of it, and configuration
# has to be resolved before the middleware stack is built.
init_control_db()
config = app_config.resolve()

app = FastAPI(title=config.app_name, version=runtime_config.APP_VERSION, lifespan=lifespan)
app.add_middleware(TenantSessionMiddleware)
app.add_middleware(
    # Starlette's `SessionMiddleware` with a clock-skew-tolerant signer: a wall clock that steps
    # backwards used to sign every session out for the length of the step. See `session_signing.py`.
    ClockSkewTolerantSessionMiddleware,
    # Generated and stored on first run rather than required up front, so a fresh install needs no
    # configuration file. It has to persist: a secret regenerated per boot would sign every session out.
    secret_key=config.session_secret,
    session_cookie=config.session_cookie_name,
    max_age=_SESSION_MAX_AGE_SECONDS,
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
app.include_router(reimbursements.router, prefix="/api/reimbursements", tags=["reimbursements"])
app.include_router(import_export.router, prefix="/api/import-export", tags=["import-export"])
app.include_router(tasks.router,         prefix="/api/tasks",         tags=["tasks"])
app.include_router(recurring.router,     prefix="/api/recurring",     tags=["recurring"])
app.include_router(currency.router,      prefix="/api/currency",      tags=["currency"])
app.include_router(app_control.router,   prefix="/api/app",           tags=["app"])
app.include_router(diagnostics.router,   prefix="/api/diagnostics",   tags=["diagnostics"])


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Last, deliberately: this registers a catch-all that would shadow every route above it.
spa_mounted = spa.mount_spa(app)
