# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Stopping the application from inside it.

The desktop shape has no other graceful way out. A macOS bundle's Dock "Quit" is an Apple Event, which
only a process running a Cocoa event loop can answer — this one runs uvicorn on the main thread instead,
deliberately, because that is what makes Ctrl+C a clean shutdown. So the Dock can offer nothing but
Force Quit, and on Windows and Linux the answer would otherwise be "find the terminal window you started
it from". A button in the app the user is already looking at is the one path that works everywhere.

**The capability is registered, not assumed.** `backend/desktop.py` hands over a handler when it owns
the server as a desktop application; nothing else does. A server — the launcher in server mode, or plain
uvicorn — therefore has no shutdown route at all, which is the intended asymmetry: there the process is
supervised, and stopping it from a browser is either futile (systemd restarts it) or a way for one
signed-in user to take the service away from everyone else.
"""

import platform
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel

from backend import transport
from backend.authorization import is_admin_or_local, require_admin_or_local
from backend.db.control_database import auth_required
from backend.db.database import get_db, ledger_epoch
from backend.routers.import_export.amazon import BATCH_SOURCE_KIND as AMAZON_BATCH_SOURCE_KIND
from backend.routers.import_export.amazon import reconciliation_attention_count
from backend.routers.tasks import security_tasks
from backend.runtime_config import (
    APP_VERSION, build_stamp, bundled_license_path, checkout_commit, distribution_form, runs_in_container,
    third_party_notices,
)
from backend.services import paypal_funding, proxy_certificate, security_checklist, update_check
from backend.services.rule_owner_reach import rule_owner_reach
from backend.services.storage_summary import storage_summary

router = APIRouter()

_shutdown_handler: Callable[[], None] | None = None


def register_shutdown_handler(handler: Callable[[], None]) -> None:
    """Declare that this process can stop itself, and how. Called by whoever owns the server object."""
    global _shutdown_handler
    _shutdown_handler = handler


def clear_shutdown_handler() -> None:
    """Give the capability back up. Exists for tests, which must not leave one process's handler
    registered where another test can reach it."""
    global _shutdown_handler
    _shutdown_handler = None


def shutdown_available() -> bool:
    """Whether this process can stop itself on request. Reported in the auth status payload so the UI
    can offer the control only where it would work, rather than offering it everywhere and failing."""
    return _shutdown_handler is not None


@router.post("/shutdown")
def shutdown_app():
    """Ask the server to stop once this response has been delivered.

    Returning first is the whole shape of it: the handler asks uvicorn to begin a *graceful* shutdown,
    which stops accepting new connections and lets in-flight ones finish, so the caller reliably learns
    that the request was accepted. Tearing the process down inside the handler would drop the response
    and leave the browser unable to tell a successful stop from a crash."""
    if _shutdown_handler is None:
        raise HTTPException(
            status_code=404,
            detail="This installation is not managed by the desktop launcher, so it cannot stop itself.",
        )
    _shutdown_handler()
    return {"stopping": True}


@router.get("/proxy-certificate")
def read_proxy_certificate():
    """Whether a TLS proxy on this machine has a root certificate to hand out, its fingerprint, and
    whether it is the one this installation has on record.

    Public, with the download below: a device needs the certificate before its connection is trusted,
    which is before a password can safely be typed on it. Nothing here is secret — a root certificate is
    what a server shows every client. See `services/proxy_certificate.py`."""
    return proxy_certificate.describe()


@router.get("/proxy-certificate/download")
def download_proxy_certificate():
    try:
        certificate = proxy_certificate.fetch()
    except proxy_certificate.ProxyCertificateUnavailable:
        raise HTTPException(status_code=404, detail="No reverse proxy on this server has a certificate to offer.")
    # The type is what lets a device offer to install the file rather than display it.
    return Response(
        certificate.pem,
        media_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": 'attachment; filename="root-certificate.crt"'},
    )


@router.post("/proxy-certificate/accept", dependencies=[Depends(require_admin_or_local)])
def accept_proxy_certificate():
    """Take the proxy's current root certificate as the expected one, after it changed. An
    administrator's statement that the change was theirs — and that each device is getting the new one."""
    try:
        proxy_certificate.accept(proxy_certificate.fetch())
    except proxy_certificate.ProxyCertificateUnavailable:
        raise HTTPException(status_code=404, detail="No reverse proxy on this server has a certificate to offer.")
    return proxy_certificate.describe()


@router.get("/security-checklist", dependencies=[Depends(require_admin_or_local)])
def read_security_checklist(request: Request):
    """Settings -> Security checklist (`services/security_checklist.py`). Admin-or-local, as the rest of the
    Server group is: what it describes is the install and its perimeter."""
    return {"items": security_checklist.build(request, security_tasks(request))}


def bundled_license_available() -> bool:
    """Whether this copy carries its own license text. Reported in the auth status payload for the same
    reason the shutdown capability is: the About page has to decide whether a fallback exists at all
    before it goes looking for one."""
    return bundled_license_path() is not None


def third_party_notices_scope() -> str | None:
    """How much of the application the notices this copy can serve cover — "build", "web", or nothing at
    all. Reported in the status payload beside the license flag and for the same reason: the About page
    has to know whether there is a link to offer, and what to say it covers."""
    found = third_party_notices()
    return found[1] if found else None


@router.get("/third-party-licenses", response_class=PlainTextResponse)
def read_third_party_notices():
    """The licenses of the third-party software this copy carries.

    A packaged build freezes its dependencies into one executable, so the license files they were built
    from reach the recipient only here and in the copy beside the executable in the kit. Elsewhere this
    serves the web interface's own list, which is the half that is bundled rather than installed."""
    found = third_party_notices()
    if found is None:
        raise HTTPException(status_code=404, detail="This copy carries no generated third-party notices.")
    return PlainTextResponse(found[0].read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")


@router.get("/license", response_class=PlainTextResponse)
def read_bundled_license():
    """The license text shipped with this copy.

    A fallback, not the reference: the published text in the repository is the trustworthy one, and this
    file travels with a binary that may have been modified. The About page therefore links out first and
    only reaches here when the repository cannot be reached — which is exactly the case (an air-gapped
    or offline install) where a conveyed copy still owes its recipient a readable license."""
    path = bundled_license_path()
    if path is None:
        raise HTTPException(status_code=404, detail="This build does not carry a bundled license file.")
    return PlainTextResponse(path.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")


def _server_platform() -> str:
    if platform.system() == "Darwin":
        system, release = "macOS", platform.mac_ver()[0]
    else:
        system, release = platform.system(), platform.release()
    return f"{system} {release} ({platform.machine()})"


@router.get("/installation-details")
def installation_details(request: Request):
    """What a bug report needs to know about this installation, for Settings -> About -> Copy details.

    Open to every signed-in user, because it is what anyone filing a report is asked for, and it holds
    nothing that is not safe to paste into a public issue: no file paths (they carry user names), no host
    names or addresses, no instance id, and of the data only which kinds of connection exist. Built on
    request rather than carried in the status payload, since asking git for a checkout's commit is not
    something every page load should pay for."""
    with get_db() as conn:
        providers = sorted(row[0] for row in conn.execute("SELECT DISTINCT provider FROM connection") if row[0])
    return {
        "version": APP_VERSION,
        "build": build_stamp() or checkout_commit(),
        "form": "container" if runs_in_container() else distribution_form(),
        "reachable_from_network": transport.reachable_from_network(),
        "request_is_loopback": transport.request_is_loopback(request),
        "request_is_https": transport.request_is_https(request),
        "sign_in_required": auth_required(),
        "server_platform": _server_platform(),
        "python_version": platform.python_version(),
        "connection_providers": providers,
    }


class UpdateCheckSettings(BaseModel):
    enabled: bool


# Checking for a new version (`services/update_check.py`). Reading the answer is open to every user, and
# so is the load-time call, which does nothing unless the check is switched on and due. Switching it on
# and asking on demand are admin-or-local: both decide whether this server makes an outbound request,
# which is a statement about the install rather than about the ledger.
@router.get("/update-check")
def read_update_check():
    return update_check.status()


@router.post("/update-check/settings", dependencies=[Depends(require_admin_or_local)])
def save_update_check_settings(body: UpdateCheckSettings):
    update_check.set_enabled(body.enabled)
    return update_check.status()


@router.post("/update-check/run", dependencies=[Depends(require_admin_or_local)])
def run_update_check():
    """Check now, whether or not the automatic check is on. `reached` says whether the release list
    answered, which the status alone cannot: an unchanged status is also what "nothing newer" looks like."""
    reached = update_check.run_check()
    return {**update_check.status(), "reached": reached}


@router.post("/update-check/auto")
def auto_update_check():
    update_check.maybe_check()
    return update_check.status()


# Read by a client returning to the foreground, which reloads its ledger pages only if this moved while it
# was away (`ledger_epoch` in db/database.py).
@router.get("/ledger-epoch")
def get_ledger_epoch():
    with get_db() as conn:
        return {"epoch": ledger_epoch(conn)}


# The derived caches a start leaves stale, filled before a page asks for one, so the first visit to Tasks
# or to Rules under the owner lens after a start or a write does not wait for a whole-ledger computation.
# Asked for by the client's catch-up rather than run at start, because there is no tenant to run as until a
# request names one (as with the watched-folder scan). Each read is a lookup when its cache is current. The
# rule reach is filled only for a viewer whose lens is on, since nothing else reads it and its scan is
# the most expensive of them.
@router.post("/warm-derived-caches")
def warm_derived_caches(rule_reach: bool = False):
    with get_db() as conn:
        amazon_batches = conn.execute(
            "SELECT id FROM import_batch WHERE source_kind = ? AND status = 'completed'",
            (AMAZON_BATCH_SOURCE_KIND,),
        ).fetchall()
        for row in amazon_batches:
            reconciliation_attention_count(conn, row["id"])
        paypal_funding.ledger_attention_count(conn)
        paypal_funding.card_counts(conn)
        if rule_reach:
            rule_owner_reach(conn)
    return {"ok": True}


@router.get("/storage-summary")
def get_storage_summary(request: Request):
    """What the trash holds and how much the import records take, against the size of the database —
    read once by Settings so its section list can say so before a section is opened."""
    with get_db() as conn:
        return storage_summary(conn, backup_history=is_admin_or_local(request))
