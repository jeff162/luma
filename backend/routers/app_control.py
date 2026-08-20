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

from fastapi import APIRouter, HTTPException

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
