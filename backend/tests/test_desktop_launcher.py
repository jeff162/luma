"""Launcher decisions that are invisible until they are wrong.

Each of these is a case where the obvious implementation looks fine and fails somewhere the developer
is not: opening a browser under WSL or a Linux desktop, a lockfile left behind by a killed process, a
configured port that something else already holds, and a macOS bundle with no terminal to print to.
"""

import asyncio
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import pytest

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


def test_linux_calls_xdg_open_itself_so_the_child_cannot_write_to_the_console():
    """The reason for not going through `webbrowser` here: it launches the generic openers via
    `BackgroundBrowser`, which passes no streams to `Popen`, so the browser inherits the terminal and
    prints its own startup chatter under Luma's startup line — where it reads as Luma failing."""
    with mock.patch.object(desktop, "_is_wsl", return_value=False), \
         mock.patch("backend.desktop.sys.platform", "linux"), \
         mock.patch.dict(os.environ, {}, clear=True), \
         mock.patch("backend.desktop.subprocess.Popen") as popen, \
         mock.patch("backend.desktop.webbrowser.open") as generic:
        desktop._open_browser("http://localhost:8123")

    assert generic.call_count == 0
    assert popen.call_args.args[0] == ["xdg-open", "http://localhost:8123"]
    assert popen.call_args.kwargs["stdout"] is subprocess.DEVNULL
    assert popen.call_args.kwargs["stderr"] is subprocess.DEVNULL
    # Without a session of its own the browser shares this terminal's foreground process group, and the
    # Ctrl+C that stops the server closes the window the user is reading.
    assert popen.call_args.kwargs["start_new_session"] is True


def test_linux_falls_back_to_the_generic_opener_without_xdg_open():
    with mock.patch.object(desktop, "_is_wsl", return_value=False), \
         mock.patch("backend.desktop.sys.platform", "linux"), \
         mock.patch.dict(os.environ, {}, clear=True), \
         mock.patch("backend.desktop.subprocess.Popen", side_effect=FileNotFoundError), \
         mock.patch("backend.desktop.webbrowser.open") as generic:
        desktop._open_browser("http://localhost:8123")

    assert generic.call_args.args[0] == "http://localhost:8123"


def test_an_explicit_browser_preference_outranks_the_quieter_path():
    """`BROWSER` names the browser to use and `webbrowser` is what honors it. A tidier console is not a
    reason to ignore a choice somebody made deliberately."""
    with mock.patch.object(desktop, "_is_wsl", return_value=False), \
         mock.patch("backend.desktop.sys.platform", "linux"), \
         mock.patch.dict(os.environ, {"BROWSER": "firefox"}), \
         mock.patch("backend.desktop.subprocess.Popen") as popen, \
         mock.patch("backend.desktop.webbrowser.open") as generic:
        desktop._open_browser("http://localhost:8123")

    assert popen.call_count == 0
    assert generic.call_args.args[0] == "http://localhost:8123"


def test_other_platforms_use_the_generic_opener():
    """macOS and Windows have their own openers, and `webbrowser` already redirects the children it
    starts there — this shortcut is for the one platform that does not."""
    with mock.patch.object(desktop, "_is_wsl", return_value=False), \
         mock.patch("backend.desktop.sys.platform", "darwin"), \
         mock.patch("backend.desktop.subprocess.Popen") as popen, \
         mock.patch("backend.desktop.webbrowser.open") as generic:
        desktop._open_browser("http://localhost:8123")

    assert popen.call_count == 0
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


def test_server_mode_refuses_a_busy_port_instead_of_moving_off_it():
    """The reverse proxy is configured with the port, so an instance that fell back to another would be
    running and unreachable — a failure that looks like success from the server's own console."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind((desktop.BIND_HOST, 0))
        occupied.listen()
        taken = occupied.getsockname()[1]

        with mock.patch.object(desktop.app_config, "value_of", return_value=str(taken)):
            assert desktop._choose_port(fixed=True) is None


def _launch(argv: list[str], *, env_server_mode: str | None, running_on: int | None = None, advertise=None):
    """Run `main` to completion against a server that returns at once, reporting its exit status, whether
    the in-app stop was registered and whether a browser was asked for. `SERVER_MODE` is pinned either
    way, since the developer's own `.env` is in the environment by the time this runs."""
    stopped = mock.Mock()
    stopped.run.return_value = None
    advertise = advertise or mock.Mock(return_value=mock.Mock(hostname="ledger.local"))
    env = {} if env_server_mode is None else {"SERVER_MODE": env_server_mode}
    with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, env):
        if env_server_mode is None:
            os.environ.pop("SERVER_MODE", None)
        with mock.patch.object(desktop, "spa_mounted", True), \
             mock.patch.object(desktop, "_install_stop_signal_handlers"), \
             mock.patch.object(desktop, "_lock_path", return_value=Path(tmp) / "luma-desktop.lock"), \
             mock.patch.object(desktop, "_running_instance_port", return_value=running_on), \
             mock.patch.object(desktop, "_choose_port", return_value=8123), \
             mock.patch.object(desktop, "_GracefulServer", return_value=stopped) as server_class, \
             mock.patch.object(desktop, "_open_browser") as opened, \
             mock.patch.object(desktop.threading, "Thread") as thread, \
             mock.patch.object(desktop.mdns, "advertise", advertise), \
             mock.patch.object(desktop.app_control, "register_shutdown_handler") as registered:
            status = desktop.main(argv)
            _launch.server_ran = stopped.run.called
            _launch.bound_host = server_class.call_args.args[0].host if server_class.called else None
    return status, registered.called, opened.called or thread.called


def test_server_mode_offers_neither_a_browser_nor_the_in_app_stop():
    """A server is supervised and shared: nobody is sitting at it to want a tab, and a stop offered in
    the app would let one signed-in user take the service from everyone else."""
    assert _launch([], env_server_mode="true") == (0, False, False)
    assert _launch([], env_server_mode=None) == (0, True, True)


def test_the_command_line_overrides_the_env_setting_in_both_directions():
    assert _launch(["--server"], env_server_mode="false") == (0, False, False)
    assert _launch(["--no-server"], env_server_mode="true") == (0, True, True)


def test_a_second_server_launch_fails_rather_than_joining_the_first():
    """Joining means opening a tab, which a server has no use for — and exiting cleanly would tell a
    supervisor the service had started."""
    assert _launch(["--server"], env_server_mode=None, running_on=8123)[0] == 1
    assert _launch([], env_server_mode=None, running_on=8123)[0] == 0


def test_only_a_server_answers_for_a_network_name_and_withdraws_it_on_the_way_out():
    advertise = mock.Mock(return_value=mock.Mock(hostname="ledger.local"))
    _launch([], env_server_mode=None, advertise=advertise)
    assert not advertise.called

    _launch(["--server"], env_server_mode=None, advertise=advertise)
    assert advertise.return_value.close.called


def test_only_server_mode_can_be_put_on_the_network():
    """A wide bind is the whole application over plain HTTP to whoever can reach the machine, so it takes
    both halves of the configuration to get one: a desktop start ignores the address setting."""
    advertise = mock.Mock(return_value=mock.Mock(hostname="ledger.local"))
    with mock.patch.object(desktop, "_server_bind_host", return_value="0.0.0.0"):
        _launch([], env_server_mode=None)
        assert _launch.bound_host == desktop.BIND_HOST

        _launch(["--server"], env_server_mode=None, advertise=advertise)
        assert _launch.bound_host == "0.0.0.0"
    # On the network directly, what is advertised is this process's own port rather than a proxy's.
    assert advertise.call_args.kwargs["plain_http_port"] == 8123


def test_the_default_address_setting_is_a_loopback_bind():
    for configured, bound in (("localhost", "127.0.0.1"), ("127.0.0.1", "127.0.0.1"), ("0.0.0.0", "0.0.0.0")):
        with mock.patch.object(desktop.app_config, "value_of", return_value=configured):
            assert desktop._server_bind_host() == bound


def test_a_name_that_cannot_be_advertised_refuses_the_start():
    """Devices find the proxy by this name and its certificate is issued for it, so a server running
    without it — or beside another one answering to it — is up and unreachable."""
    taken = mock.Mock(side_effect=desktop.mdns.MdnsError("in use"))
    assert _launch(["--server"], env_server_mode=None, advertise=taken)[0] == 1
    assert _launch.server_ran is False


def test_the_browser_port_is_the_frontend_port_not_the_backend_port():
    """One process serves the interface and the API, so the port the browser opens is `FRONTEND_PORT` —
    the name that means "the browser's port" when running from source as well. `BACKEND_PORT` names the
    internal hop behind a separate frontend, which this build does not have, so it must not be read."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as first, \
         socket.socket(socket.AF_INET, socket.SOCK_STREAM) as second:
        # Held open together so the two are guaranteed distinct, then released so both are free.
        first.bind((desktop.BIND_HOST, 0))
        second.bind((desktop.BIND_HOST, 0))
        frontend, backend = first.getsockname()[1], second.getsockname()[1]
    values = {"frontend_port": str(frontend), "backend_port": str(backend)}

    with mock.patch.object(desktop.app_config, "value_of", side_effect=values.__getitem__):
        assert desktop._choose_port() == frontend


def test_a_stop_releases_the_lock_and_bounds_its_wait():
    """The lockfile records a running instance, so one left behind sends the next launch probing a server
    that is gone. And with no force quit on a second Ctrl+C, the graceful-shutdown cap is the only thing
    that keeps a stuck request from holding a stop open."""
    with tempfile.TemporaryDirectory() as tmp:
        lock = Path(tmp) / "luma-desktop.lock"
        stopped = mock.Mock()
        stopped.run.return_value = None

        with mock.patch.object(desktop, "spa_mounted", True), \
             mock.patch.object(desktop, "_lock_path", return_value=lock), \
             mock.patch.object(desktop, "_running_instance_port", return_value=None), \
             mock.patch.object(desktop, "_choose_port", return_value=8123), \
             mock.patch.object(desktop, "_install_stop_signal_handlers"), \
             mock.patch.object(desktop, "_GracefulServer", return_value=stopped) as server_class:
            assert desktop.main(["--no-browser"]) == 0

        assert not lock.exists()
    assert server_class.call_args.args[0].timeout_graceful_shutdown == desktop.GRACEFUL_SHUTDOWN_SECONDS


_STOP_SIGNALS = [signum for signum in (signal.SIGTERM, signal.SIGINT, getattr(signal, "SIGHUP", None)) if signum]


@contextmanager
def _stop_handlers_installed(server):
    """The launcher's handlers, for the length of a test — restoring every one replaced, so the test
    process keeps its own Ctrl+C."""
    previous = {signum: signal.getsignal(signum) for signum in _STOP_SIGNALS}
    try:
        desktop._install_stop_signal_handlers(server)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _stop_signal_reaches_the_server(signum: int) -> bool:
    """Send `signum` to this process with the launcher's handlers installed, and report whether the
    server was asked to stop. Surviving the call at all is half the assertion: the default disposition
    for both of these signals terminates the process outright, so a test that merely fails would instead
    take the whole run down with it."""
    server = mock.Mock(should_exit=False)
    with _stop_handlers_installed(server):
        signal.raise_signal(signum)
        return server.should_exit is True


def test_sigterm_stops_the_server_instead_of_killing_the_process():
    """The macOS Dock's Quit and Command-Q arrive here as SIGTERM, and so does `systemctl stop`. uvicorn
    handles the signal and then re-raises it into whatever handler was installed beforehand, so with none
    of our own the second delivery reaches `SIG_DFL` and terminates the process where it stands — after a
    clean shutdown, but before the lockfile is released or a word is printed. Registering a handler is
    what gives that re-raise somewhere harmless to land."""
    assert _stop_signal_reaches_the_server(signal.SIGTERM)


def test_a_closed_terminal_stops_the_server_rather_than_killing_it():
    """SIGHUP is not in uvicorn's `HANDLED_SIGNALS`, so unlike SIGTERM there is nothing to defuse and
    this is the only handler it will ever have. Without one, closing the window a portable build was
    started from kills it outright, leaving the lockfile behind."""
    if not hasattr(signal, "SIGHUP"):
        return  # Windows has no such signal; the launcher guards for the same reason.
    assert _stop_signal_reaches_the_server(signal.SIGHUP)


def test_ctrl_c_stops_the_server():
    assert _stop_signal_reaches_the_server(signal.SIGINT)


def test_ctrl_c_delivered_twice_is_not_an_interrupt():
    """The traceback a plain Ctrl+C printed on a Raspberry Pi. The packaged build's bootloader forwards the
    terminal's SIGINT to this process, which receives it directly too, so one keypress can arrive twice;
    uvicorn catches both and re-raises both as it stands down. With Python's default handler in place,
    `asyncio.run` installs its own, which cancels on the first interrupt and raises `KeyboardInterrupt` on
    the second — from inside the event loop, after the server has already stopped. This replays that
    re-raise inside `asyncio.run`, where uvicorn performs it."""
    server = mock.Mock(should_exit=False)

    async def uvicorn_standing_down():
        signal.raise_signal(signal.SIGINT)
        signal.raise_signal(signal.SIGINT)
        await asyncio.sleep(0)

    with _stop_handlers_installed(server):
        try:
            asyncio.run(uvicorn_standing_down())
        except KeyboardInterrupt:
            pytest.fail("a Ctrl+C delivered twice escaped as KeyboardInterrupt")
    assert server.should_exit is True


def test_a_second_ctrl_c_does_not_force_quit():
    """uvicorn reads a SIGINT during a stop as a force quit, which skips the application's shutdown and logs
    its cancelled task as an error. A duplicate delivery must not be read that way."""
    server = desktop._GracefulServer(desktop.uvicorn.Config(desktop.app))
    server.handle_exit(signal.SIGINT, None)
    server.handle_exit(signal.SIGINT, None)
    assert server.should_exit is True
    assert server.force_exit is False


def test_the_log_file_is_told_the_address_before_the_server_runs():
    """The log's start line is written from the application lifespan, which cannot ask what address this
    run is on: the launcher settles the port, and `_choose_port` may have landed off the configured one.
    So the declaration has to happen before `server.run()`, which is where the lifespan executes — set
    afterwards it would be set for the next start rather than this one."""
    order = []
    stopped = mock.Mock()
    stopped.run.side_effect = lambda: order.append("server ran")

    with tempfile.TemporaryDirectory() as tmp:
        with mock.patch.object(desktop, "spa_mounted", True), \
             mock.patch.object(desktop, "_install_stop_signal_handlers"), \
             mock.patch.object(desktop, "_lock_path", return_value=Path(tmp) / "luma-desktop.lock"), \
             mock.patch.object(desktop, "_running_instance_port", return_value=None), \
             mock.patch.object(desktop, "_choose_port", return_value=8123), \
             mock.patch.object(desktop, "_GracefulServer", return_value=stopped), \
             mock.patch.object(desktop.app_log_file, "set_reachable_url", side_effect=order.append):
            assert desktop.main(["--no-browser"]) == 0

    assert order == ["http://localhost:8123", "server ran"]


def _startup_line(has_console: bool) -> str:
    stopped = mock.Mock()
    stopped.run.return_value = None
    with tempfile.TemporaryDirectory() as tmp:
        with mock.patch.object(desktop, "spa_mounted", True), \
             mock.patch.object(desktop, "_has_console", return_value=has_console), \
             mock.patch.object(desktop, "_redirect_output_to_log", return_value=None), \
             mock.patch.object(desktop, "_install_stop_signal_handlers"), \
             mock.patch.object(desktop, "_lock_path", return_value=Path(tmp) / "luma-desktop.lock"), \
             mock.patch.object(desktop, "_running_instance_port", return_value=None), \
             mock.patch.object(desktop, "_choose_port", return_value=8123), \
             mock.patch.object(desktop, "_GracefulServer", return_value=stopped), \
             mock.patch("builtins.print") as printed:
            assert desktop.main(["--no-browser"]) == 0
    return next(
        call.args[0] for call in printed.call_args_list
        if call.args and "is running at" in str(call.args[0])
    )


def test_a_windowless_build_is_not_told_to_press_ctrl_c():
    """Where the output is going to a log file, there is no terminal to press it in — and the log is read
    after the fact, by someone who cannot act on advice addressed to a session that never existed. How to
    stop a bundle is documented beside it and offered inside the app."""
    assert desktop._has_console() is True  # This test run has one.
    assert "Ctrl+C" not in _startup_line(has_console=False)


def test_a_terminal_start_still_says_how_to_stop_it():
    """The other half of the same claim: suppressing the advice everywhere would take it away from the
    two platforms where it is the only way out of a foreground process."""
    assert "Ctrl+C" in _startup_line(has_console=True)


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


def test_reset_password_runs_the_recovery_tool_instead_of_starting_a_server():
    """Without a console the launcher would send the prompts to a log, and past the recovery check it
    would bind a port; `--reset-password` has to stop before either."""
    with mock.patch.object(desktop.account_recovery, "run", return_value=0) as recover, \
         mock.patch.object(desktop, "_has_console", return_value=False), \
         mock.patch.object(desktop, "_redirect_output_to_log") as redirect, \
         mock.patch.object(desktop, "_GracefulServer") as server_class:
        assert desktop.main(["--reset-password"]) == 0
        assert desktop.main(["--reset-password", "Admin"]) == 0

    assert [call.args for call in recover.call_args_list] == [(None,), ("Admin",)]
    assert redirect.call_count == 0 and server_class.call_count == 0


def test_the_launcher_reads_database_locations_from_the_env_file():
    """The database modules read their paths once, at first import, so the launcher has to load `.env`
    before anything reaches them. It once imported `app_config` first, and a portable copy's `DATA_DIR`
    was silently ignored. A fresh interpreter, because in this one the modules are long since imported.
    The shell's `DATA_DIR` names a decoy, so a regression lands there rather than on a real database."""
    with tempfile.TemporaryDirectory() as tmp:
        target, decoy = Path(tmp) / "from-env-file", Path(tmp) / "from-shell"
        env_file = Path(tmp) / "test.env"
        env_file.write_text(f"DATA_DIR={target}\n")
        env = {key: value for key, value in os.environ.items() if key not in {"DB_PATH", "CONTROL_DB_PATH"}}
        env.update(LUMA_ENV_FILE=str(env_file), DATA_DIR=str(decoy))

        result = subprocess.run(
            [sys.executable, "-c",
             "import backend.desktop\n"
             "from backend.db import control_database, database\n"
             "print(control_database.CONTROL_DB_PATH)\n"
             "print(database.DB_PATH)"],
            cwd=Path(__file__).resolve().parents[2], env=env, capture_output=True, text=True, check=True,
        )

    control_path, data_path = result.stdout.strip().splitlines()[-2:]
    assert Path(control_path).parent == target and Path(data_path).parent == target


def test_a_network_name_is_one_label_however_it_was_typed():
    assert desktop.mdns.normalize_name("Ledger.local") == "ledger"
    for bad in ("two.labels", "under_score", "-leading", ""):
        with pytest.raises(desktop.mdns.MdnsError):
            desktop.mdns.normalize_name(bad)


def test_this_machines_own_answer_is_not_a_name_conflict():
    """A machine whose host name equals the configured name is already answered for by its operating
    system, with this machine's addresses — which is the same server, not a second one."""
    own = {"192.0.2.10", "127.0.0.1"}
    assert not desktop.mdns.answered_by_another_machine({"192.0.2.10"}, own)
    assert desktop.mdns.answered_by_another_machine({"192.0.2.10", "192.0.2.77"}, own)
