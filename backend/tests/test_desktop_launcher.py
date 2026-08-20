"""Launcher decisions that are invisible until they are wrong.

Each of these is a case where the obvious implementation looks fine and fails somewhere the developer
is not: opening a browser under WSL, a lockfile left behind by a killed process, a configured port that
something else already holds, and a macOS bundle with no terminal to print to.
"""

import os
import socket
import sys
import tempfile
import threading
import time
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


def _launch_context(platform: str, frozen: bool, launch_services: bool):
    """The three things that decide whether output has anywhere to go: the OS, whether this is a
    packaged build, and whether macOS started it rather than a shell."""
    environ = {**os.environ}
    environ.pop("__CFBundleIdentifier", None)
    if launch_services:
        environ["__CFBundleIdentifier"] = "io.github.jeff162.luma"
    return (
        mock.patch.object(sys, "platform", platform),
        mock.patch.object(desktop.runtime_config, "is_frozen", return_value=frozen),
        mock.patch.dict(os.environ, environ, clear=True),
    )


def _asks_for_a_log(platform: str, frozen: bool, launch_services: bool) -> bool:
    platform_patch, frozen_patch, env_patch = _launch_context(platform, frozen, launch_services)
    with platform_patch, frozen_patch, env_patch:
        return desktop._started_by_launch_services()


def test_a_bundle_opened_from_finder_writes_its_output_to_a_file():
    """The case the log exists for: no terminal is attached, so the startup line is invisible and a
    failure to start is an icon that bounces once and disappears."""
    assert _asks_for_a_log("darwin", frozen=True, launch_services=True) is True


def test_running_the_binary_from_a_shell_keeps_printing_to_it():
    """Including through a pipe. `sys.stdout.isatty()` would answer no here and divert the output of
    anything capturing it — the smoke harness above all, which captures it precisely to report why a
    launch failed."""
    assert _asks_for_a_log("darwin", frozen=True, launch_services=False) is False


def test_only_a_packaged_macos_build_ever_redirects():
    """A checkout is run from a terminal by definition, and no other platform starts an application the
    way LaunchServices does."""
    assert _asks_for_a_log("darwin", frozen=False, launch_services=True) is False
    assert _asks_for_a_log("linux", frozen=True, launch_services=True) is False
    assert _asks_for_a_log("win32", frozen=True, launch_services=True) is False


def test_the_log_sits_with_the_data_rather_than_with_the_application():
    """Same reasoning as the databases: a macOS bundle is replaced wholesale by an upgrade, so anything
    written inside it would be gone exactly when someone wanted to read it. Asserted through the real
    redirect, since where the file lands is the whole claim.

    The redirect is undone afterwards by restoring the saved descriptors — leaving pytest's own stdout
    pointed at a temporary file would silence the rest of the run."""
    saved = (os.dup(1), os.dup(2))
    try:
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"DATA_DIR": tmp}, clear=False):
                written = desktop._redirect_output_to_log()
            assert written == Path(tmp) / desktop.LOG_FILENAME
            assert written.is_file()
            # What lands *in* it is deliberately not asserted: pytest replaces `sys.stdout` with an
            # object of its own that is not backed by file descriptor 1, so `print` here bypasses the
            # redirect this test just performed. In a packaged build the two are the same file.
    finally:
        for descriptor, target in zip(saved, (1, 2)):
            os.dup2(descriptor, target)
            os.close(descriptor)


def _watch_until_eof(write_fd: int, read_fd: int, *, send: bytes = b""):
    """Run the watcher against a real pipe and return the server object it acted on. The write end is
    closed here, standing in for the parent process dying."""
    server = mock.Mock(should_exit=False)
    watcher = threading.Thread(target=desktop._watch_for_parent_exit, args=(server, read_fd))
    watcher.start()
    try:
        if send:
            os.write(write_fd, send)
            # Long enough for a watcher that mistakes any read for death to have acted on it.
            time.sleep(0.05)
            assert server.should_exit is False, "a byte on the pipe is not the parent dying"
    finally:
        os.close(write_fd)
    watcher.join(timeout=5)
    assert not watcher.is_alive()
    return server


def test_the_server_stops_when_the_parent_lets_go_of_the_pipe():
    """The dead man's switch. The kernel closes the write end however the parent died, including under
    SIGKILL, which is the case the wrapper cannot clean up after itself."""
    read_fd, write_fd = os.pipe()
    try:
        assert _watch_until_eof(write_fd, read_fd).should_exit is True
    finally:
        os.close(read_fd)


def test_bytes_on_the_pipe_are_not_mistaken_for_the_parent_dying():
    """Only end-of-file means every write end is closed. A read that merely *completed* does not."""
    read_fd, write_fd = os.pipe()
    try:
        assert _watch_until_eof(write_fd, read_fd, send=b"x").should_exit is True
    finally:
        os.close(read_fd)


def test_the_watch_is_declared_rather_than_inferred():
    """`something | luma` hands over a pipe that is already at EOF. Inferring the arrangement from the
    file descriptor alone would shut the app down the instant it started, with nothing to explain it."""
    read_fd, write_fd = os.pipe()
    try:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(desktop.PARENT_PIPE_ENV, None)
            with mock.patch.object(desktop.os, "fstat", return_value=os.fstat(read_fd)):
                assert desktop._parent_pipe_is_attached() is False

        with mock.patch.dict(os.environ, {desktop.PARENT_PIPE_ENV: "1"}, clear=False):
            with mock.patch.object(desktop.os, "fstat", return_value=os.fstat(read_fd)):
                assert desktop._parent_pipe_is_attached() is True
            # Declared, but stdin is not a pipe — nothing to watch.
            with mock.patch.object(desktop.os, "fstat", return_value=os.stat(__file__)):
                assert desktop._parent_pipe_is_attached() is False
    finally:
        os.close(read_fd)
        os.close(write_fd)
