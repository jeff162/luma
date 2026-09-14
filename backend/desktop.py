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
  it, but the URL opened is `http://localhost:<port>`. `_passkey_context` in `routers/auth.py` refuses a
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
- **Where there is no console, the output goes to a file.** A macOS `.app` started from Finder has no
  terminal attached, which turns that contract into nothing at all: the URL is invisible, and — the part
  that actually matters — a failure to start presents as an icon that bounces once and disappears. So a
  LaunchServices start redirects both streams to a log beside the data. Detected by the environment
  variable LaunchServices sets rather than by asking whether stdout is a terminal, since that question
  also answers "yes, a pipe" for anything running the binary and capturing its output.

The lockfile records a port, not a claim of liveness. It survives a crash or a kill, so a stale one is
expected rather than exceptional, and `/api/health` is what settles whether the recorded instance is
really there.
"""

import argparse
import os
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

from backend import app_config, runtime_config, spa
from backend.main import app, spa_mounted
from backend.routers import app_control

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
HEALTH_TIMEOUT_SECONDS = 1.0
STARTUP_TIMEOUT_SECONDS = 60.0
# Appended to across runs, so a failure that happened yesterday is still readable, but not without
# limit: uvicorn can be noisy when something is persistently wrong, and nothing here ever prunes.
LOG_MAX_BYTES = 1024 * 1024


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

    Named for the console rather than for the platform, because that is what the two callers actually
    depend on and the set can grow: today it is only the macOS bundle, but a Windows build made
    windowless would join it. Both the decision to redirect the streams and the decision to mention
    Ctrl+C have to come from the same answer, or a build ends up advising a keystroke into a log."""
    return not _started_by_launch_services()


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

    print(f"\n--- {runtime_config.app_name()} {runtime_config.APP_VERSION} starting {time.asctime()} ---")
    return log


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

    **SIGINT is deliberately absent.** Its default handler raises `KeyboardInterrupt`, which `main()`
    already catches, so the re-raise is survived without help. Taking it over would only make Ctrl+C
    *before* uvicorn installs its own handlers do nothing at all, which is strictly worse.

    Requesting the stop rather than ignoring the signal is what covers the window before uvicorn's
    handlers exist: a quit arriving during a slow startup is honoured at the first check instead of being
    swallowed, which is the difference between the app closing and the macOS wrapper waiting out its kill
    timer."""

    def request_stop(_signum, _frame):
        server.should_exit = True

    signal.signal(signal.SIGTERM, request_stop)
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


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((BIND_HOST, port))
        except OSError:
            return False
    return True


def _choose_port() -> int:
    # `frontend_port`, not `backend_port`. This one process serves the interface as well as the API, so
    # the port the browser opens is the frontend's — the setting that names the browser's port when
    # running from source too, where `backend_port` is the internal hop behind Vite. One meaning per name
    # across every way of running the app is the point; this build simply has no internal hop.
    try:
        configured = int(app_config.value_of("frontend_port"))
    except (TypeError, ValueError):
        configured = 0

    if configured and _port_is_free(configured):
        return configured

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
    args = parser.parse_args(argv)

    # Before anything that can fail, so that what fails is written down somewhere.
    if not _has_console():
        _redirect_output_to_log()

    if not spa_mounted:
        print(
            "No built frontend found. Run `npm run build` in frontend/ first "
            f"(expected {spa.dist_dir() / 'index.html'}).",
            file=sys.stderr,
        )
        return 1

    already_running = _running_instance_port()
    if already_running is not None:
        url = f"http://{BROWSER_HOST}:{already_running}"
        print(f"Luma is already running at {url}")
        if not args.no_browser:
            _open_browser(url)
        return 0

    port = _choose_port()
    url = f"http://{BROWSER_HOST}:{port}"

    lock = _lock_path()
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(str(port))

    server = uvicorn.Server(uvicorn.Config(app, host=BIND_HOST, port=port, log_level="warning"))
    # Four different pieces of news, one way to act on them. The in-app control, a stop signal, and the
    # parent wrapper's death all set `server.should_exit`, which is uvicorn's graceful shutdown — the same
    # one Ctrl+C takes — so in-flight requests finish, the `finally` below clears the lockfile, and a
    # response already on its way out (the one saying "stopping") is delivered before anything closes.
    # None of them can be registered any earlier: the capability *is* the server object, and until one
    # exists there is nothing to ask.
    app_control.register_shutdown_handler(lambda: setattr(server, "should_exit", True))
    _install_stop_signal_handlers(server)

    if _parent_pipe_is_attached():
        threading.Thread(target=_watch_for_parent_exit, args=(server,), daemon=True).start()
    if not args.no_browser:
        threading.Thread(target=_open_browser_when_ready, args=(server, url), daemon=True).start()

    # Ctrl+C is advice only where somebody is watching a terminal. Where this is going to a log instead,
    # the address is the whole of what the line is for, and how to stop a windowless build is documented
    # beside it (`READ_ME_MACOS` in `scripts/build_desktop.py`) and offered inside the app.
    if _has_console():
        print(f"Luma is running at {url}. Press Ctrl+C to stop.")
    else:
        print(f"Luma is running at {url}")
    try:
        # Blocking, and in the main thread on purpose: uvicorn installs the signal handlers that make
        # Ctrl+C a clean shutdown rather than an abandoned server thread.
        server.run()
    except KeyboardInterrupt:
        # Not an error path. `Server.capture_signals` restores the previous SIGINT handler and then
        # re-raises the signal into it, so a graceful shutdown that has already finished still arrives
        # here as a KeyboardInterrupt. Ctrl+C is an advertised way to stop — printing a stack trace for
        # it would report a clean exit as a crash.
        pass
    finally:
        lock.unlink(missing_ok=True)

    print("Luma has stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
