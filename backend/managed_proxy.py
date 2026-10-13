# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The reverse proxy run as a child of the server, for an installation that keeps one beside the executable.

A server behind a proxy is otherwise two programs to install, configure, start and stop, and the second
one's site file has to agree with this installation's name and port. Where a `caddy` executable sits in
the same folder as the application, the server does all of that itself: it starts the proxy on the site
file it would have printed (`backend/server_setup.py`), and stops it on the way out.

**Placing the executable there is what asks for this.** A proxy installed for the whole machine is never
looked for, so an installation whose proxy belongs to a supervisor keeps working exactly as it did.

**A proxy that is already answering is left alone and used.** It is either someone else's, or this
installation's own from a run that was killed before it could stop it; in both cases starting a second
would only fail on the ports the first one holds.

The proxy's own output goes to a file beside the data, rewritten at each start: it is how a proxy that
would not start (a port already taken, most often) gets explained.
"""

import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from backend import runtime_config, server_setup
from backend.services import proxy_certificate

EXECUTABLE_NAME = "caddy.exe" if sys.platform == "win32" else "caddy"
LOG_FILENAME = "proxy.log"
ADMIN_TIMEOUT_SECONDS = 1.0
STARTUP_TIMEOUT_SECONDS = 15.0
STOP_TIMEOUT_SECONDS = 10.0


class ManagedProxyError(Exception):
    """The proxy beside the application could not be started. The message is for the person at the
    console."""


def executable() -> Path | None:
    """The proxy this installation runs itself, or None where there is none beside the application."""
    candidate = runtime_config.install_root() / EXECUTABLE_NAME
    return candidate if candidate.is_file() else None


def _admin_request(path: str, *, post: bool = False) -> bool:
    # No proxy from the environment, for the reason `proxy_certificate.fetch` gives.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(f"{proxy_certificate.ADMIN_URL}{path}", data=b"" if post else None)
    try:
        with opener.open(request, timeout=ADMIN_TIMEOUT_SECONDS):
            return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def another_is_running() -> bool:
    return _admin_request("/config/")


class ManagedProxy:
    """A running proxy, until `stop()`."""

    def __init__(self, process: subprocess.Popen, log):
        self._process = process
        self._log = log

    def stop(self) -> None:
        """Ask the proxy to stop through its admin API, which is a graceful stop on every platform —
        terminating the process is one only where there are signals — and insist if it does not."""
        try:
            if self._process.poll() is None:
                _admin_request("/stop", post=True)
                try:
                    self._process.wait(STOP_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait()
        finally:
            self._log.close()


def start() -> ManagedProxy:
    """Start the proxy beside the application and return once it is answering, or raise
    `ManagedProxyError` saying why it is not."""
    program = executable()
    try:
        site = server_setup.caddyfile(managed=True)
    except server_setup.ServerSetupError as exc:
        raise ManagedProxyError(str(exc)) from exc

    log_path = runtime_config.data_dir() / LOG_FILENAME
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "wb")
    try:
        process = subprocess.Popen(
            # The site file arrives on stdin, so there is no second copy on disk to drift from the
            # configuration it was written from.
            [str(program), "run", "--config", "-", "--adapter", "caddyfile"],
            stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
            # Out of this terminal's reach: Ctrl+C is delivered to everything attached to it, and the
            # proxy has to outlive that keypress long enough to be stopped in order.
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32"
               else {"start_new_session": True}),
        )
        process.stdin.write(site.encode("utf-8"))
        process.stdin.close()
    except OSError as exc:
        log.close()
        raise ManagedProxyError(f"Could not start the reverse proxy at {program}: {exc}") from exc

    proxy = ManagedProxy(process, log)
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        if another_is_running():
            return proxy
        time.sleep(0.1)
    if process.poll() is None:
        process.kill()
    proxy.stop()
    raise ManagedProxyError(
        f"The reverse proxy at {program} did not start. What it reported is in {log_path}. It needs "
        "ports 80 and 443, free and open to this user."
    )
