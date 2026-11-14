# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Desktop entry point: one command starts the server, opens the browser, and owns both lifetimes.

This is the single-user shape from `docs/operations.md` -> "Desktop" — the whole application in
one process, reached through whatever browser the user already has. It exists instead of a native window
shell because passkey vault slots need WebAuthn's `prf` extension, and a real browser is the only engine
that reliably has it.

Three decisions carry the design:

- **Bind an address, hand out a name.** uvicorn binds `127.0.0.1` so nothing off the machine can reach
  it, but the URL opened is `http://localhost:<port>`. `transport.passkey_context` refuses a
  bare IP as a WebAuthn Relying Party id, so opening `http://127.0.0.1:<port>` would silently disable
  every passkey slot with nothing on screen to explain why. The two are not interchangeable here.
- **A port is a convenience, not an identity.** The configured `FRONTEND_PORT` is preferred so the URL
  stays familiar, but a busy port falls back to an ephemeral one rather than refusing to start. Nothing
  durable is keyed to it: cookies are not port-scoped, and a WebAuthn RP id is the host alone, so a
  different port each launch costs neither the session nor a registered passkey.
- **A second launch joins the first.** Two processes on one SQLite pair is the failure this avoids, and
  the natural user action that would cause it — launching again while it is already running — is also
  the action that means "show me the app." So a live instance is reused: open a tab against it and exit.
- **The printed URL is the contract; opening a browser is a convenience.** No opener on any platform
  reports success usefully, so the outcome is never claimed and a failure to open must not read as the
  app having failed to start.
- **A wrapper that dies takes the server with it.** The macOS bundle is a small native application that
  owns the Dock icon and launches this one as a child (see `macos/`). Force-quitting it gives it no
  chance to clean up, so the child watches for the parent's death directly: the wrapper holds the write
  end of a pipe and hands over the read end, and a read that returns *zero bytes* means every write end
  is closed, which can only happen once the wrapper is gone. The kernel guarantees that even for SIGKILL,
  which is what makes it a dead man's switch rather than a courtesy.
- **Server mode is the same process with the desktop conveniences taken away.** `SERVER_MODE`, or
  `--server`, is the LAN shape from `docs/operations.md` -> "LAN server". What changes is everything
  that assumed a person at this machine — no browser is opened, a second launch is refused rather than
  joined, and the in-app stop is not offered, since the process is supervised and one signed-in user
  must not be able to take it from the rest. The port stops being a convenience there: other devices, or
  the proxy in front, are configured with it, so a busy one refuses the start instead of moving. And the
  process answers for a name on the local network (`backend/mdns.py`), which is how those devices find
  the server at all.
- **Server mode reaches the network one of two ways, and the bind says which.** Left on loopback, a
  TLS-terminating proxy on the same machine is what other devices reach and this process is the hop
  behind it. Given a wider `FRONTEND_HOST`, the process is on the network itself, over plain HTTP. The
  second is a choice someone made by configuring it; what it costs is enforced and explained per
  request (`backend/transport.py`), not here.
- **Where there is no console, the output goes to a file.** A macOS `.app` started from Finder has no
  terminal attached, which turns that contract into nothing at all: the URL is invisible, and — the part
  that actually matters — a failure to start presents as an icon that bounces once and disappears. So a
  LaunchServices start redirects both streams to a log beside the data. Detected by the environment
  variable LaunchServices sets rather than by asking whether stdout is a terminal, since that question
  also answers "yes, a pipe" for anything running the binary and capturing its output.
- **On Windows the console can be given up for a notification-area icon.** The executable is a console
  program, because the recovery and setup commands need somewhere to print, so a start from a shortcut
  or at sign-in is a console window that stops the server when someone closes it. `--tray` starts the
  same command again with no console and exits, which closes a window that was opened for it and frees
  a prompt it was typed into; the second process writes to
  the log and is seen and stopped through the icon (`backend/tray.py`). Declared to that process by an
  environment variable rather than inferred, for the reason the parent pipe is.
- **A proxy kept beside the executable is started and stopped with the server** (`backend/managed_proxy.py`),
  so a server behind one is a single program to run.

The lockfile records a port, not a claim of liveness. It survives a crash or a kill, so a stale one is
expected rather than exceptional, and `/api/health` is what settles whether the recorded instance is
really there.
"""

import argparse
import contextlib
import ipaddress
import os
import queue
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

# First, before anything that can reach the database modules (see the module). `app_config` below does.
import backend.load_env_file  # noqa: F401
from backend import (
    account_recovery, app_config, app_log_file, ledger_adoption, managed_proxy, mdns, runtime_config,
    server_setup, spa, transport, tray,
)
from backend.main import app, spa_mounted
from backend.routers import app_control
from backend.services import proxy_certificate

# Loopback is the bind; `localhost` is the name that keeps passkeys available (see module docstring).
BIND_HOST = "127.0.0.1"
BROWSER_HOST = "localhost"

LOCK_FILENAME = "luma-desktop.lock"
LOG_FILENAME = "luma-desktop.log"
# Set by the macOS wrapper to declare that this process's stdin is the read end of a pipe it holds open.
# Required rather than inferred: `something | luma` from a shell also hands over a pipe, one that is
# already at EOF, and inferring from the file descriptor alone would exit instantly on startup for no
# visible reason.
PARENT_PIPE_ENV = "LUMA_PARENT_PIPE"
# Set on the process `--tray` starts in its own place, to say it was started with no console to print to.
NO_CONSOLE_ENV = "LUMA_NO_CONSOLE"
# Names a file the process deletes once it is about to serve, set by the process whose icon has been
# standing in for it until then (`_start_successor`).
SUCCESSOR_SIGNAL_ENV = "LUMA_SUCCESSOR_SIGNAL"
HEALTH_TIMEOUT_SECONDS = 1.0
STARTUP_TIMEOUT_SECONDS = 60.0
# Appended to across runs, so a failure that happened yesterday is still readable, but not without
# limit: uvicorn can be noisy when something is persistently wrong, and nothing here ever prunes.
LOG_MAX_BYTES = 1024 * 1024
# How long a stop waits for in-flight requests before closing them anyway. Ctrl+C never escalates to a
# force quit here (see `_GracefulServer`), so this is what keeps one stuck request from holding a stop open.
GRACEFUL_SHUTDOWN_SECONDS = 5


def _lock_path() -> Path:
    return runtime_config.data_dir() / LOCK_FILENAME


def _parent_pipe_is_attached() -> bool:
    """Whether a parent has wired up the death-watch described in the module docstring. Both halves are
    required: the declaration, and stdin actually being a pipe."""
    if not runtime_config.truthy(os.environ.get(PARENT_PIPE_ENV)):
        return False
    try:
        return stat.S_ISFIFO(os.fstat(0).st_mode)
    except OSError:
        return False


def _watch_for_parent_exit(server: uvicorn.Server, fd: int = 0) -> None:
    """Block until the parent's write end closes, then ask for the same graceful stop everything else
    asks for.

    Only a *zero-length* read means that: it is the end-of-file every write end being closed produces,
    and the parent is the only holder of one. Bytes arriving would mean somebody wrote something, which
    nothing does — but treating any completed read as death would turn a stray byte into a shutdown."""
    while True:
        try:
            if os.read(fd, 1) == b"":
                break
        except OSError:
            # The descriptor went away underneath us, which is the same news by a different route.
            break
    server.should_exit = True


def _started_by_launch_services() -> bool:
    """Whether macOS started this through LaunchServices — a Finder double-click, or `open`. Both leave
    the process with no terminal, which is the case a log file exists for.

    `__CFBundleIdentifier` is what LaunchServices puts in the environment on the way in. Preferred over
    `sys.stdout.isatty()`, which is false for a pipe too: the smoke harness captures this process's
    output, and diverting it to a file there would take away the diagnostics it exists to collect."""
    return (
        sys.platform == "darwin"
        and runtime_config.is_frozen()
        and "__CFBundleIdentifier" in os.environ
    )


def _has_console() -> bool:
    """Whether anything printed here reaches a person as it happens, rather than a log file nobody is
    watching.

    Named for the console rather than for the platform, because that is what the callers actually
    depend on: the macOS bundle has none, and neither does a Windows start that gave its own up for a
    notification-area icon. Both the decision to redirect the streams and the decision to mention
    Ctrl+C have to come from the same answer, or a build ends up advising a keystroke into a log."""
    return not _started_by_launch_services() and not runtime_config.truthy(os.environ.get(NO_CONSOLE_ENV))


def _spawn_without_console(arguments: list[str], **environment: str) -> subprocess.Popen | None:
    """Start this same command again with no console window, or return None having said why not.

    `PYINSTALLER_RESET_ENVIRONMENT` makes a packaged copy unpack for itself rather than borrow this
    process's files, which are deleted when this one exits."""
    try:
        return subprocess.Popen(
            [*server_setup.launcher_command(), *arguments],
            env={**os.environ, NO_CONSOLE_ENV: "1", "PYINSTALLER_RESET_ENVIRONMENT": "1", **environment},
            # Something to write to until the log takes over: with no console there are no streams at all.
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except OSError as exc:
        print(f"Could not start {runtime_config.app_name()} without a console: {exc}", file=sys.stderr)
        return None


def _relaunch_without_console(arguments: list[str]) -> int:
    """Hand over to a copy of this command that has no console window, for the caller to exit behind.

    A console program cannot close its own window while anything is still attached to it, and in a
    packaged build something always is: the executable is a loader with this process as its child. A
    second copy started without a window, and this one exiting, is what works whichever program is
    drawing the console."""
    return 0 if _spawn_without_console(arguments) is not None else 1


def _start_successor(arguments: list[str]) -> bool:
    """Start the server again as a new process, returning once it is about to serve and has an icon of
    its own — at which point this process, whose icon has been saying so, can go. False if it stopped
    before getting that far, which it has reported itself, and this icon is then still here to try again
    from.

    A new process rather than a second run in this one, so that nothing held in memory — an unlocked
    vault above all — outlives a stop. It is the start a sign-in gives. The signal is a file because it
    has to cross the packaged build's loader, which passes the environment on and nothing else."""
    handle, name = tempfile.mkstemp(prefix="successor-")
    os.close(handle)
    signal_file = Path(name)
    try:
        successor = _spawn_without_console(arguments, **{SUCCESSOR_SIGNAL_ENV: name})
        if successor is None:
            return False
        deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
        while signal_file.exists() and time.monotonic() < deadline:
            if successor.poll() is not None:
                return False
            time.sleep(0.1)
        return True
    finally:
        signal_file.unlink(missing_ok=True)


def _release_predecessor() -> None:
    signal_file = os.environ.pop(SUCCESSOR_SIGNAL_ENV, None)
    if signal_file:
        Path(signal_file).unlink(missing_ok=True)


def _show_icon(on_exit: contextlib.ExitStack) -> "tray.TrayIcon | None":
    icon = tray.show()
    if icon is not None:
        on_exit.callback(icon.close)
    return icon


def _redirect_output_to_log() -> Path | None:
    """Point both streams at a log beside the data, returning where it went, or None if it could not be
    opened — in which case the app still starts, just as silently as before.

    Redirected at the file-descriptor level rather than by reassigning `sys.stdout`, so that output from
    uvicorn's logging (configured later, against whatever fd 1 is by then) lands there too."""
    log = runtime_config.data_dir() / LOG_FILENAME
    try:
        log.parent.mkdir(parents=True, exist_ok=True)
        if log.is_file() and log.stat().st_size > LOG_MAX_BYTES:
            log.unlink()
        handle = open(log, "a", encoding="utf-8")
        os.dup2(handle.fileno(), 1)
        os.dup2(handle.fileno(), 2)
    except OSError:
        return None

    for stream in (sys.stdout, sys.stderr):
        try:
            # Line buffered, because the interesting case is a process that dies: block-buffered output
            # would be discarded exactly when it is the only evidence of what happened.
            stream.reconfigure(line_buffering=True)
        except (AttributeError, OSError, ValueError):
            pass

    # Stamped like the other log's start marker, and for the same reason: this file is what a report
    # about a macOS build arrives with, and the version does not identify the build on its own.
    stamp = runtime_config.build_stamp()
    build = f" ({stamp})" if stamp else ""
    print(f"\n--- {runtime_config.app_name()} {runtime_config.APP_VERSION}{build} starting {time.asctime()} ---")
    return log


def _write_lines_as_they_are_printed() -> None:
    """Stop Python holding output back when it is not going to a terminal.

    Into a pipe — a supervisor's journal, which is where a server's output goes — stdout is buffered by
    the block, so the line saying the server is up and where arrives when the process *exits*. The
    journal then shows a service that started and said nothing, and the address appears beside the
    report that it has stopped."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(line_buffering=True)
        except (AttributeError, OSError, ValueError):
            pass


class _GracefulServer(uvicorn.Server):
    """uvicorn's server without its second-Ctrl+C force quit.

    uvicorn reads a SIGINT arriving while a stop is already under way as "force quit": it stops waiting
    for connections and skips the application's shutdown, whose cancelled task it then logs as an error,
    traceback and all. A second SIGINT is not necessarily a second keypress, though. A terminal delivers
    Ctrl+C to its whole foreground process group, and the packaged Linux build is a PyInstaller onefile
    bootloader with this process as its child — the bootloader receives the Ctrl+C as well and forwards
    it, so one keypress can arrive twice. When the two land close together the kernel merges them; when
    they do not, which on a Raspberry Pi they did not, a plain Ctrl+C printed a crash. So every stop is
    graceful, and `GRACEFUL_SHUTDOWN_SECONDS` bounds it where a second keypress used to."""

    def handle_exit(self, sig, frame):
        super().handle_exit(sig, frame)
        self.force_exit = False


def _install_stop_signal_handlers(server: uvicorn.Server) -> None:
    """Make the signals that mean "stop" end in the same graceful path everything else uses.

    **SIGTERM** is already handled by uvicorn, and that is precisely the problem. `Server.capture_signals`
    restores the *previous* handler on the way out and then re-raises what it caught, so a SIGTERM that
    has just shut the server down cleanly is delivered a second time — to `SIG_DFL`, which terminates the
    process on the spot, before the `finally` in `main()` clears the lockfile and before a word is
    printed. Registering a handler here is what makes uvicorn save *this* as the previous one, so the
    re-raise lands somewhere harmless and `run()` returns normally. That path is not exotic: it is the
    macOS Dock's Quit and Command-Q, which reach this process as SIGTERM from the wrapper
    (`macos/main.swift`), and `systemctl stop` in the LAN shape.

    **SIGHUP** is not in uvicorn's `HANDLED_SIGNALS`, so there is nothing to defuse and this is the only
    handler it will ever have. Without one, closing the terminal a portable build was started from kills
    it outright — the same silent death, by a different route. Windows has no such signal, hence the
    guard.

    **SIGINT** gets one for the reason SIGTERM does. uvicorn re-raises it on the way out as well, and with
    Python's default handler in place `asyncio.run` installs one of its own — which cancels on the first
    interrupt and raises `KeyboardInterrupt` on the second. A Ctrl+C delivered twice (see
    `_GracefulServer`) is re-raised twice, so it ended in a traceback from inside the event loop after the
    server had already stopped. With a handler here asyncio leaves SIGINT alone, and every re-raise lands
    harmlessly.

    Requesting the stop rather than ignoring the signal is what covers the window before uvicorn's
    handlers exist: a quit arriving during a slow startup is honoured at the first check instead of being
    swallowed, which is the difference between the app closing and the macOS wrapper waiting out its kill
    timer."""

    def request_stop(_signum, _frame):
        server.should_exit = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, request_stop)


def _instance_is_live(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://{BROWSER_HOST}:{port}/api/health", timeout=HEALTH_TIMEOUT_SECONDS
        ) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _running_instance_port() -> int | None:
    """The port of an instance that is actually answering, or None — clearing the lockfile if it is
    stale so the caller can take the machine over."""
    lock = _lock_path()
    try:
        recorded = int(lock.read_text().strip())
    except (OSError, ValueError):
        return None

    if _instance_is_live(recorded):
        return recorded

    lock.unlink(missing_ok=True)
    return None


def _server_bind_host() -> str:
    """Where server mode listens: loopback unless `FRONTEND_HOST` names something wider. That setting is
    the browser-facing server's address in every way of running the app, as `FRONTEND_PORT` is its port.
    Its default is the name `localhost`, which is spelled as the address here for the same reason the
    desktop bind is (see the module docstring)."""
    host = app_config.value_of("frontend_host").strip()
    return BIND_HOST if _names_this_machine(host) else host


def _names_this_machine(host: str) -> bool:
    if host.lower() == BROWSER_HOST:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _unused_address_notices(server_mode: bool) -> list[str]:
    """What to say about an address setting that asks for the network and is not going to get it.

    Two of them can: `BACKEND_HOST` belongs to the scripts that run a source checkout and is never read
    here, and `FRONTEND_HOST` is read in server mode only. Either left in `.env` would otherwise fail in
    the least visible way there is — the app starts normally, the configuration report lists the value
    as set, and nothing on the network answers. Only a value that widens is mentioned: one that names
    this machine asks for what happens anyway."""
    notices = []
    backend_host = app_config.value_of("backend_host").strip()
    frontend_host = app_config.value_of("frontend_host").strip()
    if not _names_this_machine(backend_host):
        notices.append(
            f"BACKEND_HOST is set to {backend_host} and is not used by this way of starting "
            f"{runtime_config.app_name()}: it applies only when running from source with the start scripts. "
            + ("FRONTEND_HOST is the setting that puts a server on the network."
               if server_mode else
               "To be reachable from other devices, start in server mode (SERVER_MODE=true) and set FRONTEND_HOST.")
        )
    if not server_mode and not _names_this_machine(frontend_host):
        notices.append(
            f"FRONTEND_HOST is set to {frontend_host} and is used only in server mode, so this start "
            "listens to this computer only. Set SERVER_MODE=true, or start with --server, to be reachable "
            "from other devices."
        )
    return notices


def _port_is_free(port: int, host: str = BIND_HOST) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def _choose_port(*, fixed: bool = False, host: str = BIND_HOST) -> int | None:
    """The port this run listens on. `fixed` is server mode, where something else is configured with the
    port and an instance that moved off it would be running and unreachable — so there a port that cannot
    be had is None, with the reason printed, rather than a fallback."""
    # `frontend_port`, not `backend_port`. This one process serves the interface as well as the API, so
    # the port the browser opens is the frontend's — the setting that names the browser's port when
    # running from source too, where `backend_port` is the internal hop behind Vite. One meaning per name
    # across every way of running the app is the point; this build simply has no internal hop.
    try:
        configured = int(app_config.value_of("frontend_port"))
    except (TypeError, ValueError):
        configured = 0

    if configured and _port_is_free(configured, host):
        return configured

    if fixed:
        print(
            f"Port {configured} is in use, and a server installation does not move to another: whatever "
            "reaches it is configured with this one. Free the port or set FRONTEND_PORT."
            if configured else
            "FRONTEND_PORT is not a port number, and a server installation needs a fixed one.",
            file=sys.stderr,
        )
        return None

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((BIND_HOST, 0))
        fallback = probe.getsockname()[1]

    # Named rather than silent: the likeliest reason the usual port is taken is another copy of Luma on
    # the same databases, which the lockfile cannot see because it only tracks launcher-started ones.
    if configured:
        print(
            f"Port {configured} is in use, so this instance is on {fallback}. "
            "If a second Luma is holding it, stop one of them: they share the same databases."
        )
    return fallback


def _is_wsl() -> bool:
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def _spawn_opener(command: list[str]) -> bool:
    """Hand the URL to `command` with the child's output discarded, reporting whether it started.

    Discarding is the point. This console is the whole interface at startup — it carries the address and
    the way to stop — so a child that inherits it is writing into Luma's UI under Luma's name. Browsers
    and openers both do: GTK announces which accessibility modules it declined, and an opener with no
    browser to hand it to reports each one it tried. Neither is Luma's to report, and neither is
    actionable, but both appear directly beneath the startup line where a first-run user reads them as
    something having gone wrong.
    """
    try:
        # `start_new_session` for the reason `webbrowser` uses it on this path: without it the child
        # stays in this terminal's foreground process group, and the Ctrl+C that stops Luma is delivered
        # to the browser as well. Stopping the server must not close the window the user was reading.
        subprocess.Popen(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        return True
    except OSError:
        return False


def _open_browser(url: str) -> None:
    """Best effort, and deliberately silent about the outcome — see the module docstring.

    WSL needs its own path rather than the generic one. `xdg-open` there walks a list of Linux browsers
    a WSL distribution does not have, printing a "not found" line for each before giving up, so the
    generic opener produces a wall of errors that reads as a crash while the server is running fine.
    Handing the URL to Windows is both quieter and what the user actually wants.

    Elsewhere on Linux `xdg-open` is the right opener but the wrong caller: `webbrowser` launches the
    generic ones through `BackgroundBrowser`, which passes no streams to `Popen` and so leaves the child
    on this terminal. (Its browser-specific classes redirect to `DEVNULL` already, which is why the noise
    depends on which opener a machine happens to resolve to.) Calling `xdg-open` directly gets the same
    browser with the streams closed off, and `webbrowser` still stands behind it for anything without
    one — macOS, a bare X session, a desktop that ships something else.
    """
    if _is_wsl():
        for opener in (["wslview"], ["explorer.exe"]):
            if _spawn_opener([*opener, url]):
                return
        return
    # `BROWSER` is skipped over here on purpose: it is an explicit statement of which browser to use,
    # `webbrowser` is what honors it, and a quieter console is not worth ignoring a preference someone
    # set. The shortcut is for the default path, which is the one that resolves to `xdg-open` anyway.
    if sys.platform.startswith("linux") and not os.environ.get("BROWSER"):
        if _spawn_opener(["xdg-open", url]):
            return
    webbrowser.open(url)


def _open_browser_when_ready(server: uvicorn.Server, url: str) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while not server.started and time.monotonic() < deadline:
        if server.should_exit:
            return
        time.sleep(0.05)
    if server.started:
        _open_browser(url)


def _print_certificate_fingerprint() -> int:
    """State the proxy's root-certificate fingerprint on the server's own console — the one route to it
    that does not pass through the connection a new device is trying to decide whether to trust."""
    try:
        certificate = proxy_certificate.fetch()
    except proxy_certificate.ProxyCertificateUnavailable:
        print("No reverse proxy on this machine answered with a root certificate. Is Caddy running?", file=sys.stderr)
        return 1
    print(
        f"{certificate.name}\n"
        f"SHA-256 fingerprint: {certificate.fingerprint}\n"
        f"SHA-1 fingerprint (Windows shows this one, as Thumbprint): {certificate.fingerprint_sha1}"
    )
    return 0


def _print_setup_file(write) -> int:
    """Print one of the files a server installation needs (`backend/server_setup.py`), and nothing else
    on stdout: the output is piped straight into the file's place."""
    try:
        sys.stdout.write(write())
    except server_setup.ServerSetupError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


def _help_on(platform: str, text: str) -> str:
    """Help for an option that belongs to one operating system: listed there, and left out of the list
    everywhere else. The option is still accepted everywhere, so that following another platform's
    instructions is answered by the option itself, which says where it applies."""
    return text if sys.platform.startswith(platform) else argparse.SUPPRESS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="luma",
        description="Run Luma as a single local process: serve the app and open it in a browser.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Start the server and print its URL without opening a browser.",
    )
    parser.add_argument(
        "--server",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Run as a server behind a reverse proxy on this machine: no browser is opened and the port "
             "is fixed. Overrides SERVER_MODE in either direction.",
    )
    parser.add_argument(
        "--certificate-fingerprint",
        action="store_true",
        help="Print the fingerprint of the reverse proxy's root certificate, to compare against the one "
             "shown where another computer downloads it, then exit without starting the server.",
    )
    parser.add_argument(
        "--caddyfile",
        action="store_true",
        help="Print a Caddyfile for this installation's network name and port, then exit without "
             "starting the server.",
    )
    parser.add_argument(
        "--systemd-unit",
        action="store_true",
        help=_help_on(
            "linux",
            "Print a systemd unit that runs this installation as a server, as the current user, then "
            "exit without starting the server.",
        ),
    )
    parser.add_argument(
        "--tray",
        action="store_true",
        help=_help_on("win32", "Run with no console window and a notification-area icon to open and stop it."),
    )
    parser.add_argument(
        "--start-at-sign-in",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=_help_on(
            "win32",
            "Start this installation as a server, with the notification-area icon, whenever the current "
            "user signs in; --no-start-at-sign-in undoes it. Exits without starting the server.",
        ),
    )
    parser.add_argument(
        "--reset-password",
        nargs="?",
        const="",
        metavar="USERNAME",
        help="Set a new password for an account locked out of sign-in, then exit without starting the "
             "server. Asks which account when USERNAME is left out.",
    )
    parser.add_argument(
        "--adopt-ledger",
        action="store_true",
        help="Pair the financial database the settings name with this installation's control database, "
             "after showing both and asking, then exit without starting the server. For a server that "
             "refuses to open its data because the two do not belong together.",
    )
    args = parser.parse_args(argv)

    # Recovery tools, not launches: they need the console they were typed into, so they run before any
    # redirect to the log, and they never touch the port or the lockfile.
    if args.reset_password is not None:
        return account_recovery.run(args.reset_password or None)
    if args.adopt_ledger:
        return ledger_adoption.run()

    if args.certificate_fingerprint:
        return _print_certificate_fingerprint()
    if args.caddyfile:
        return _print_setup_file(server_setup.caddyfile)
    if args.systemd_unit:
        return _print_setup_file(server_setup.systemd_unit)
    if args.start_at_sign_in is not None:
        return _print_setup_file(lambda: server_setup.start_at_sign_in(args.start_at_sign_in) + "\n")

    if args.tray:
        if not tray.supported():
            print("--tray is for Windows, where the notification-area icon is.", file=sys.stderr)
            return 1
        if _has_console():
            return _relaunch_without_console(sys.argv[1:] if argv is None else argv)

    # Before anything that can fail, so that what fails is written down somewhere.
    log = None
    if not _has_console():
        log = _redirect_output_to_log()
    else:
        _write_lines_as_they_are_printed()

    status = _serve(args, sys.argv[1:] if argv is None else argv)
    if status and args.tray:
        tray.report_failed_start(log)
    return status


def _serve(args: argparse.Namespace, arguments: list[str]) -> int:
    """Run the server until it is stopped, or return nonzero having printed why it did not start.
    `arguments` is the command line as given, for starting again from the notification-area icon."""
    with contextlib.ExitStack() as on_exit:
        return _run_server(args, arguments, on_exit)


def _run_server(args: argparse.Namespace, arguments: list[str], on_exit: contextlib.ExitStack) -> int:
    # The icon goes up first, saying the server is starting: what follows — the check for a name already
    # answered, the proxy — takes seconds, on top of the seconds a packaged build spent unpacking. Unless
    # this start was asked for from a stopped server's icon, which is still on screen saying the same
    # thing and stays until this one is ready to replace it.
    succeeding = SUCCESSOR_SIGNAL_ENV in os.environ
    icon = _show_icon(on_exit) if args.tray and not succeeding else None

    if not spa_mounted:
        print(
            "No built frontend found. Run `npm run build` in frontend/ first "
            f"(expected {spa.dist_dir() / 'index.html'}).",
            file=sys.stderr,
        )
        return 1

    server_mode = app_config.server_mode_enabled() if args.server is None else args.server

    already_running = _running_instance_port()
    if already_running is not None:
        url = f"http://{BROWSER_HOST}:{already_running}"
        if server_mode:
            # Nonzero, so a supervisor reports it: there is no tab to open on a server, and exiting
            # cleanly would read as the service having started.
            print(f"{runtime_config.app_name()} is already running at {url}.", file=sys.stderr)
            return 1
        # No version here, and deliberately: the instance being joined is a different process, possibly a
        # different build, and `/api/health` reports only that something answered. Naming this process's
        # version would be a claim about a program that is not running.
        print(f"{runtime_config.app_name()} is already running at {url}")
        if not args.no_browser:
            _open_browser(url)
        return 0

    bind_host = _server_bind_host() if server_mode else BIND_HOST
    behind_proxy = bind_host == BIND_HOST
    port = _choose_port(fixed=server_mode, host=bind_host)
    if port is None:
        return 1
    url = f"http://{BROWSER_HOST}:{port}"

    advertisement = None
    if server_mode:
        try:
            advertisement = mdns.advertise(
                app_config.value_of("mdns_name"), plain_http_port=None if behind_proxy else port,
            )
        except mdns.MdnsError as exc:
            print(exc, file=sys.stderr)
            return 1

    proxy = None
    if server_mode and behind_proxy and managed_proxy.executable() is not None:
        if managed_proxy.another_is_running():
            print(
                "A reverse proxy is already running on this machine, so the one beside "
                f"{runtime_config.app_name()} was not started."
            )
        else:
            try:
                proxy = managed_proxy.start()
            except managed_proxy.ManagedProxyError as exc:
                print(exc, file=sys.stderr)
                advertisement.close()
                return 1

    transport.declare_listener(reachable=server_mode, direct=not behind_proxy)
    for notice in _unused_address_notices(server_mode):
        print(notice)

    # The port is settled here and nowhere else — a busy configured one falls back to an ephemeral port —
    # so the launcher is the only place that can tell the log file which address this run is on. Declared
    # before the server runs, because the lifespan that writes the start marker is inside `server.run()`.
    app_log_file.set_reachable_url(url)

    lock = _lock_path()
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(str(port))

    server = _GracefulServer(uvicorn.Config(
        app, host=bind_host, port=port, log_level="warning", timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SECONDS,
    ))
    # Four different pieces of news, one way to act on them. The in-app control, a stop signal, and the
    # parent wrapper's death all set `server.should_exit`, which is uvicorn's graceful shutdown — the same
    # one Ctrl+C takes — so in-flight requests finish, the `finally` below clears the lockfile, and a
    # response already on its way out (the one saying "stopping") is delivered before anything closes.
    # None of them can be registered any earlier: the capability *is* the server object, and until one
    # exists there is nothing to ask. Server mode withholds the in-app one (see the module docstring).
    if not server_mode:
        app_control.register_shutdown_handler(lambda: setattr(server, "should_exit", True))
    _install_stop_signal_handlers(server)

    if _parent_pipe_is_attached():
        threading.Thread(target=_watch_for_parent_exit, args=(server,), daemon=True).start()
    if not args.no_browser and not server_mode:
        threading.Thread(target=_open_browser_when_ready, args=(server, url), daemon=True).start()

    # Ctrl+C is advice only where somebody is watching a terminal. Where this is going to a log instead,
    # the address is the whole of what the line is for, and how to stop a windowless build is documented
    # beside it (`READ_ME_MACOS` in `scripts/build_desktop.py`) and offered inside the app.
    running = f"{runtime_config.app_name()} (v{runtime_config.APP_VERSION}) is running at {url}"
    reached_at = url
    if server_mode:
        reached_at = (
            f"https://{advertisement.hostname}" if behind_proxy else f"http://{advertisement.hostname}:{port}"
        )
        running += f" in server mode; other devices reach it at {reached_at}" + (
            " through the reverse proxy on this machine" if behind_proxy else ", over plain HTTP"
        )
    # Opens the address this machine reaches it at, which needs no certificate; names the one to give
    # everybody else.
    #
    # The icon's *Stop* differs from every other stop in one way: the process stays, as the icon, until
    # *Start* or *Exit* is chosen there. A start that fails comes back to that choice.
    held_by_icon = threading.Event()
    start_again: queue.SimpleQueue[bool] = queue.SimpleQueue()

    def stop_from_icon(*, held: bool) -> None:
        if held:
            held_by_icon.set()
        icon.show_stopping()
        server.should_exit = True

    if args.tray and succeeding:
        icon = _show_icon(on_exit)
    if icon is not None:
        icon.show_running(
            reached_at,
            on_open=lambda: _open_browser(url),
            on_stop=lambda: stop_from_icon(held=True),
            on_exit=lambda: stop_from_icon(held=False),
        )
    _release_predecessor()
    # A server's output is usually a supervisor's journal, where the keystroke is as unusable as it is in
    # a log file; the advice is kept for a server someone started by hand.
    if _has_console() and (sys.stdout.isatty() or not server_mode):
        print(f"{running}. Press Ctrl+C to stop.")
    else:
        print(f"{running}.")
    try:
        # Blocking, and in the main thread on purpose: uvicorn installs the signal handlers that make
        # Ctrl+C a clean shutdown rather than an abandoned server thread. Nothing is caught: every stop
        # signal has a handler, so Ctrl+C ends `run()` normally instead of arriving as `KeyboardInterrupt`.
        server.run()
    finally:
        lock.unlink(missing_ok=True)
        if advertisement is not None:
            advertisement.close()
        if proxy is not None:
            proxy.stop()

    print(f"{runtime_config.app_name()} has stopped.")
    while held_by_icon.is_set():
        icon.show_stopped(on_start=lambda: start_again.put(True), on_exit=lambda: start_again.put(False))
        if not start_again.get():
            break
        icon.show_starting()
        if _start_successor(arguments):
            break
    return 0


if __name__ == "__main__":
    status = main()
    # Once `main` has returned there is nothing left to stop, and interpreter shutdown puts the default
    # handlers back — so a duplicate stop signal arriving this late (see `_GracefulServer`) would kill the
    # process by signal after a clean stop. Here rather than in `main`, which tests call in-process.
    for stop_signal in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if stop_signal is not None:
            signal.signal(stop_signal, signal.SIG_IGN)
    raise SystemExit(status)
