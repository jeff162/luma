"""Launcher decisions that are invisible until they are wrong.

Each of these is a case where the obvious implementation looks fine and fails somewhere the developer
is not: opening a browser under WSL, a lockfile left behind by a killed process, and a configured port
that something else already holds.
"""

import socket
import tempfile
from pathlib import Path
from unittest import mock

from backend.tests._api_client import api_client


def _desktop():
    """Import through the API harness: `backend.main` initializes the control database at *import*, so
    importing the launcher outside the harness would build one at the default path — the developer's
    real file."""
    with api_client():
        from backend import desktop

        return desktop


desktop = _desktop()


def test_wsl_hands_the_url_to_windows():
    """`xdg-open` under WSL walks a list of Linux browsers the distribution does not have and prints a
    failure for each, which reads as the app crashing while the server is running fine."""
    with mock.patch.object(desktop, "_is_wsl", return_value=True), \
         mock.patch("backend.desktop.subprocess.Popen") as popen, \
         mock.patch("backend.desktop.webbrowser.open") as generic:
        desktop._open_browser("http://localhost:8123")

    assert generic.call_count == 0
    assert popen.call_args.args[0] == ["wslview", "http://localhost:8123"]


def test_wsl_falls_back_when_the_preferred_opener_is_absent():
    with mock.patch.object(desktop, "_is_wsl", return_value=True), \
         mock.patch("backend.desktop.subprocess.Popen", side_effect=[FileNotFoundError, None]) as popen:
        desktop._open_browser("http://localhost:8123")

    assert [call.args[0][0] for call in popen.call_args_list] == ["wslview", "explorer.exe"]


def test_ordinary_platforms_use_the_generic_opener():
    with mock.patch.object(desktop, "_is_wsl", return_value=False), \
         mock.patch("backend.desktop.webbrowser.open") as generic:
        desktop._open_browser("http://localhost:8123")

    assert generic.call_args.args[0] == "http://localhost:8123"


def test_a_stale_lockfile_does_not_block_startup():
    """The lockfile records a port, not liveness — it outlives a crash, so a recorded port that answers
    nothing has to release the machine rather than send the launcher to a dead instance."""
    with tempfile.TemporaryDirectory() as tmp:
        lock = Path(tmp) / "luma-desktop.lock"
        lock.write_text("8123")

        with mock.patch.object(desktop, "_lock_path", return_value=lock), \
             mock.patch.object(desktop, "_instance_is_live", return_value=False):
            assert desktop._running_instance_port() is None

        assert not lock.exists()


def test_a_live_instance_is_reused():
    with tempfile.TemporaryDirectory() as tmp:
        lock = Path(tmp) / "luma-desktop.lock"
        lock.write_text("8123")

        with mock.patch.object(desktop, "_lock_path", return_value=lock), \
             mock.patch.object(desktop, "_instance_is_live", return_value=True):
            assert desktop._running_instance_port() == 8123

        assert lock.exists()


def test_a_busy_configured_port_falls_back_instead_of_refusing_to_start():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind((desktop.BIND_HOST, 0))
        occupied.listen()
        taken = occupied.getsockname()[1]

        with mock.patch.object(desktop.app_config, "value_of", return_value=str(taken)):
            chosen = desktop._choose_port()

    assert chosen != taken
    assert 1024 < chosen < 65536


def test_ctrl_c_exits_cleanly_and_releases_the_lock():
    """uvicorn re-raises SIGINT into the caller after its own graceful shutdown, so the advertised way
    to stop the app arrives as an exception. Letting it escape reports a normal exit as a crash."""
    with tempfile.TemporaryDirectory() as tmp:
        lock = Path(tmp) / "luma-desktop.lock"
        interrupted = mock.Mock()
        interrupted.run.side_effect = KeyboardInterrupt

        with mock.patch.object(desktop, "spa_mounted", True), \
             mock.patch.object(desktop, "_lock_path", return_value=lock), \
             mock.patch.object(desktop, "_running_instance_port", return_value=None), \
             mock.patch.object(desktop, "_choose_port", return_value=8123), \
             mock.patch.object(desktop.uvicorn, "Server", return_value=interrupted):
            assert desktop.main(["--no-browser"]) == 0

        assert not lock.exists()
