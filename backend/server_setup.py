# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The two files a server installation needs from outside the application, written from the application's
own configuration: the reverse proxy's site file and the supervisor's unit.

They are printed rather than shipped as files to edit because every value in them is one this
installation already holds, and two of them have to agree with it exactly. The proxy issues its
certificate for the name in its site file, and the server answers on the network for `MDNS_NAME`
(`backend/mdns.py`); a device that resolves one and is shown a certificate for the other is refused with
nothing on screen to say why. The unit names an executable and a user, and a wrong one is a service that
fails at boot, read about later in a journal.

Nothing is installed from here. Both destinations belong to root, and the launcher is run as the user
who owns the data (`docs/operations.md` -> "LAN server" has the sequence).
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


def caddyfile() -> str:
    """Caddy's site file: TLS for the advertised name, every request passed to this process.

    Nothing asks for a certificate authority. Caddy issues from its own for a name no public authority
    could certify, which a `.local` one is. The upstream is the address, not `localhost`, so the proxy
    cannot try an IPv6 loopback the server does not listen on."""
    try:
        name = mdns.normalize_name(app_config.value_of("mdns_name"))
    except mdns.MdnsError as exc:
        raise ServerSetupError(str(exc)) from exc
    return (
        f"{name}.{mdns.MDNS_DOMAIN} {{\n"
        f"\treverse_proxy 127.0.0.1:{_port()}\n"
        "}\n"
    )


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
    command = [sys.executable] if runtime_config.is_frozen() else [sys.executable, "-m", LAUNCHER_MODULE]
    return (
        "[Unit]\n"
        f"Description={runtime_config.app_name()}\n"
        "Wants=network-online.target\n"
        "After=network-online.target caddy.service\n"
        "\n"
        "[Service]\n"
        f"User={getpass.getuser()}\n"
        f"WorkingDirectory={str(root).replace('%', '%%')}\n"
        f"ExecStart={' '.join(_quoted(word) for word in [*command, '--server'])}\n"
        "Restart=on-failure\n"
        "RestartSec=5\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
