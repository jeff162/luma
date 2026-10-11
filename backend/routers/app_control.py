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
the server; nothing else does. A LAN deployment started with plain uvicorn therefore has no shutdown
route at all — which is the intended asymmetry, since there the process is supervised, and stopping it
from a browser is either futile (systemd restarts it) or a way for one signed-in user to take the
service away from everyone else.
"""

from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.authorization import require_admin_or_local
from backend.runtime_config import bundled_license_path, third_party_notices
from backend.services import update_check

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
