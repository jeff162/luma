# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
A notification-area icon for a Windows start that has no console window.

Started with `--tray`, the launcher lets go of its console (`backend/desktop.py`), which leaves a running
server with nothing on screen: no address, and no way to stop it short of ending the process. The icon
is that surface — it names the address, opens the application, and stops it through the same graceful
path every other stop takes.

**The icon outlives a stop, so that the server can be started again from it.** Started at sign-in there
is no other place to do that from. *Stop* leaves the icon saying so and offering *Start*; *Exit* is what
ends the process, and is what replacing the executable needs.

**Something is on screen for the whole of a start and a stop.** Both take seconds — a packaged build
unpacks itself before anything runs, and a stop waits for open connections — so the icon appears before
the slow part of a start and says which of the two is under way.

It is also where a start that failed has to be reported. Without a console the reason is in a log file
nobody is looking at, and at sign-in the only visible symptom would be an icon that never appeared.

The icon lives on a thread of its own. Windows delivers an icon's events to the thread that created it,
so it is created and run in one place, and the server keeps the main thread for the reason the launcher
gives.
"""

import sys
import threading
from pathlib import Path
from typing import Callable

from backend import runtime_config, spa

# The interface's own icon, which every build already carries.
ICON_FILE = "apple-touch-icon.png"
READY_TIMEOUT_SECONDS = 10.0


def supported() -> bool:
    return sys.platform == "win32"


# What the icon says where the address would be, while there is nothing to do but wait or start.
STARTING = "Starting..."
STOPPING = "Stopping..."
STOPPED = "Stopped"


class TrayIcon:
    """An icon being shown, until `close()`. It says which of four states the server is in, and offers
    only what that state allows: nothing while starting or stopping, since both are a few seconds of
    waiting that a second click could only confuse."""

    def __init__(self, icon, ready: threading.Event, state: dict):
        self._icon = icon
        self._ready = ready
        self._state = state

    def _show(self, status: str, **actions: Callable[[], None]) -> None:
        self._state.update(status=status, actions=actions)
        if self._ready.is_set():
            self._icon.title = f"{self._icon.name} - {status}"
            self._icon.update_menu()

    def show_running(self, address: str, *, on_open, on_stop, on_exit) -> None:
        self._state["address"] = address
        self._show(address, open=on_open, stop=on_stop, exit=on_exit)

    def show_stopping(self) -> None:
        self._show(STOPPING)

    def show_stopped(self, *, on_start, on_exit) -> None:
        self._show(STOPPED, start=on_start, exit=on_exit)

    def show_starting(self) -> None:
        self._show(STARTING)

    def close(self) -> None:
        # Stopping an icon that never finished appearing has nothing to post its request to.
        if self._ready.is_set():
            self._icon.stop()


def show() -> TrayIcon | None:
    """Show the icon, saying the server is starting, or return None where it cannot be shown — the
    server is worth more than its icon, so that is reported and survived."""
    try:
        import pystray
        from PIL import Image

        image = Image.open(spa.dist_dir() / ICON_FILE)
        image.load()
    except Exception as exc:
        print(f"The notification-area icon could not be shown: {exc}", file=sys.stderr)
        return None

    name = runtime_config.app_name()
    state = {"status": STARTING, "actions": {}}

    def offered(action: str) -> Callable[..., bool]:
        return lambda _item=None: action in state["actions"]

    def chosen(action: str) -> Callable[[], None]:
        return lambda: state["actions"][action]()

    icon = pystray.Icon(
        name,
        image,
        f"{name} - {STARTING}",
        pystray.Menu(
            pystray.MenuItem(lambda _item: state["status"], None, enabled=False),
            # Said, because the line above names a different address: the one other devices use.
            pystray.MenuItem(
                f"Open {name} (localhost)", chosen("open"), default=offered("open"), visible=offered("open"),
            ),
            pystray.MenuItem(f"Stop {name}", chosen("stop"), visible=offered("stop")),
            pystray.MenuItem(f"Start {name}", chosen("start"), default=offered("start"), visible=offered("start")),
            pystray.MenuItem(f"Exit {name}", chosen("exit"), visible=offered("exit")),
        ),
    )
    ready = threading.Event()

    def appear(shown) -> None:
        shown.visible = True
        ready.set()

    threading.Thread(target=lambda: icon.run(setup=appear), daemon=True).start()
    ready.wait(READY_TIMEOUT_SECONDS)
    return TrayIcon(icon, ready, state)


def report_failed_start(log: Path | None) -> None:
    """Say on screen that a consoleless start did not get as far as running."""
    import ctypes

    name = runtime_config.app_name()
    where = f"The reason is at the end of {log}." if log else "No log could be written to say why."
    icon_error = 0x10
    ctypes.windll.user32.MessageBoxW(None, f"{name} could not start. {where}", name, icon_error)
