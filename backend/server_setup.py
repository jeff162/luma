# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What a server installation needs from outside the application, written from the application's own
configuration: the reverse proxy's site file, the supervisor's unit, and on Windows the entry that
starts it at sign-in.

They are printed rather than shipped as files to edit because every value in them is one this
installation already holds, and two of them have to agree with it exactly. The proxy issues its
certificate for the name in its site file, and the server answers on the network for `MDNS_NAME`
(`backend/mdns.py`); a device that resolves one and is shown a certificate for the other is refused with
nothing on screen to say why. The unit names an executable and a user, and a wrong one is a service that
fails at boot, read about later in a journal.

Neither file is installed from here. Both destinations belong to root, and the launcher is run as the
user who owns the data (`docs/operations.md` -> "LAN server" has the sequence). The sign-in entry is the
exception: it belongs to that same user, so it is written directly.
"""

import getpass
import os
import sys

from backend import app_config, mdns, runtime_config

# The entry point of a source checkout, which has no executable of its own to name.
LAUNCHER_MODULE = "backend.desktop"


class ServerSetupError(Exception):
    """The file cannot be written for this installation. The message is for the person at the console."""


def _port() -> int:
    try:
        return int(app_config.value_of("frontend_port"))
    except (TypeError, ValueError):
        raise ServerSetupError("FRONTEND_PORT is not a port number, and a server installation needs a fixed one.")


def caddyfile(*, managed: bool = False) -> str:
    """Caddy's site file: TLS for the advertised name, every request passed to this process.

    Nothing asks for a certificate authority. Caddy issues from its own for a name no public authority
    could certify, which a `.local` one is. The upstream is the address, not `localhost`, so the proxy
    cannot try an IPv6 loopback the server does not listen on.

    `managed` is the proxy this process starts itself (`backend/managed_proxy.py`). There Caddy is told
    not to put its root certificate into the machine's trust store. It otherwise attempts that at every
    start, by asking whoever is at the machine — for a password, or to confirm a dialog — and here there
    may be nobody. The server's own browser gets the certificate the way every other device does."""
    try:
        name = mdns.normalize_name(app_config.value_of("mdns_name"))
    except mdns.MdnsError as exc:
        raise ServerSetupError(str(exc)) from exc
    return (
        ("{\n\tskip_install_trust\n}\n\n" if managed else "")
        + f"{name}.{mdns.MDNS_DOMAIN} {{\n"
        f"\treverse_proxy 127.0.0.1:{_port()}\n"
        "}\n"
    )


def launcher_command() -> list[str]:
    """The command that starts this installation, before any options."""
    return [sys.executable] if runtime_config.is_frozen() else [sys.executable, "-m", LAUNCHER_MODULE]


def _quoted(argument: str) -> str:
    """One word of a unit's command line. systemd splits on whitespace and reads `%` as a specifier."""
    argument = argument.replace("%", "%%")
    return f'"{argument}"' if any(character.isspace() for character in argument) else argument


def systemd_unit() -> str:
    """A unit that starts this installation at boot, as the user running this command.

    `--server` is on the command line so the unit is a server whatever `.env` says. It is ordered after
    the proxy only so the two come up in a sensible order: the server does not need the proxy to start,
    and a machine without `caddy.service` ignores the name. A stop is SIGTERM, systemd's default, which
    the launcher takes as a graceful one."""
    if not sys.platform.startswith("linux"):
        raise ServerSetupError("A systemd unit is for a Linux server; this is not one.")
    if os.geteuid() == 0:
        raise ServerSetupError(
            "Run this as the user the server should run as, without sudo: the unit names that user, "
            "and the databases are created as theirs."
        )

    root = runtime_config.install_root()
    return (
        "[Unit]\n"
        f"Description={runtime_config.app_name()}\n"
        "Wants=network-online.target\n"
        "After=network-online.target caddy.service\n"
        "\n"
        "[Service]\n"
        f"User={getpass.getuser()}\n"
        f"WorkingDirectory={str(root).replace('%', '%%')}\n"
        f"ExecStart={' '.join(_quoted(word) for word in [*launcher_command(), '--server'])}\n"
        "Restart=on-failure\n"
        "RestartSec=5\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )


# Where Windows keeps the programs it starts when this user signs in. An entry here needs no
# administrator and stores no password, and it is listed under Startup apps where it can be switched off.
SIGN_IN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
SIGN_IN_OPTIONS = ("--server", "--tray")


def start_at_sign_in(enabled: bool) -> str:
    """Add or remove the entry that starts this installation as a server when its user signs in to
    Windows, returning what was done, for the console.

    Only for a downloaded build. The entry is a bare command line with no working folder, which is all
    an executable needs and not enough for a checkout started as a module."""
    if sys.platform != "win32":
        raise ServerSetupError("Starting at sign-in is set up this way on Windows only.")
    if not runtime_config.is_frozen():
        raise ServerSetupError("Starting at sign-in is for a downloaded build, not a source checkout.")
    import winreg

    name = runtime_config.app_name()
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, SIGN_IN_KEY) as key:
            if enabled:
                command = " ".join([f'"{sys.executable}"', *SIGN_IN_OPTIONS])
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, command)
                return f"{name} will start as a server when {getpass.getuser()} signs in to Windows."
            try:
                winreg.DeleteValue(key, name)
            except FileNotFoundError:
                pass
            return f"{name} will no longer start at sign-in."
    except OSError as exc:
        raise ServerSetupError(f"Windows refused the change to this user's startup programs: {exc}") from exc
