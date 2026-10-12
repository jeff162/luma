# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Advertising the server's name on the local network, so a device reaches `luma.local` without knowing
which machine the server is on.

A machine already answers for its own host name; this is a *second* name for it, which nothing publishes
unless a responder in the process does. It is server mode's alone (`backend/desktop.py`), and the name is
load-bearing rather than a convenience where a proxy is in front: a passkey needs a host that is a name,
and the proxy's certificate is issued for this one (`docs/security-model.md` -> "Transport security").

Three decisions:

- **A name somebody else answers for refuses the start.** Two servers sharing a name would have devices
  reaching whichever answered first, with a certificate for the other. The library registers a host name
  without asking whether it is taken, so the question is asked here first. An answer made only of this
  machine's own addresses is not somebody else: it is the operating system's responder, on a machine
  whose host name happens to be the configured one. A second installation on this same machine is the
  case that exemption cannot see, and the library does catch that one: the two would register the same
  service.
- **One address is advertised: the one this machine reaches the local network from.** Every address the
  machine has would include container bridges and tunnels, which a device on the LAN cannot route to and
  would try anyway. It is read once, at startup.
- **What is registered is a web service**, because the library answers for a host name only as part of
  one. Behind a proxy it is HTTPS on the standard port — the proxy's, which this process does not
  configure and so takes on trust. Bound to the network directly it is plain HTTP on the process's own
  port. Either way the address record is what devices actually use.

The import is deferred so a desktop start neither pays for the responder nor depends on it.
"""

import re
import socket

MDNS_DOMAIN = "local"
MDNS_GROUP = ("224.0.0.251", 5353)
HTTPS_SERVICE = "_https._tcp.local."
HTTP_SERVICE = "_http._tcp.local."
HTTPS_PORT = 443
# Long enough for a responder on the same network to answer; the wait is paid once per start.
PROBE_TIMEOUT_MS = 1500

_LABEL = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")


class MdnsError(Exception):
    """The name cannot be advertised. The message is written for the person starting the server."""


def normalize_name(configured: str) -> str:
    """The single label to advertise under `.local`. A value typed with the suffix means the same thing;
    anything that is not one label is refused rather than repaired, since the proxy's certificate has to
    be issued for exactly the name that ends up on the network."""
    name = configured.strip().lower().rstrip(".")
    if name.endswith(f".{MDNS_DOMAIN}"):
        name = name[: -len(MDNS_DOMAIN) - 1]
    if not _LABEL.fullmatch(name):
        raise MdnsError(
            f"MDNS_NAME is {configured!r}, which is not a host name: use letters, digits and hyphens only."
        )
    return name


def answered_by_another_machine(answered: set[str], own: set[str]) -> bool:
    return bool(answered - own)


def _lan_address() -> str:
    """The address the routing table picks for the mDNS group, which is the interface a device on the
    local network would reach this machine through. Connecting a datagram socket sends nothing."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.connect(MDNS_GROUP)
        return probe.getsockname()[0]


def _own_addresses() -> set[str]:
    import ifaddr

    return {
        ip.ip
        for adapter in ifaddr.get_adapters()
        for ip in adapter.ips
        if isinstance(ip.ip, str)
    }


class Advertisement:
    """A name being answered for, until `close()` withdraws it."""

    def __init__(self, hostname: str, responder):
        self.hostname = hostname
        self._responder = responder

    def close(self) -> None:
        # Closing withdraws what was registered, so other devices stop resolving the name at once
        # instead of holding a dead address until its record expires.
        self._responder.close()


def advertise(configured_name: str, *, plain_http_port: int | None = None) -> Advertisement:
    """Start answering for `<name>.local`, or raise `MdnsError` saying why not. `plain_http_port` is the
    process's own port when it is on the network directly; without one a TLS proxy is what devices
    reach."""
    name = normalize_name(configured_name)
    hostname = f"{name}.{MDNS_DOMAIN}"

    from zeroconf import AddressResolver, IPVersion, NonUniqueNameException, ServiceInfo, Zeroconf

    def in_use(by: str) -> MdnsError:
        return MdnsError(
            f"The name {hostname} is already in use on this network (by {by}). "
            "Set MDNS_NAME to a different name for this installation."
        )

    try:
        address = _lan_address()
        responder = Zeroconf(ip_version=IPVersion.V4Only)
    except OSError as exc:
        raise MdnsError(
            f"Could not advertise {hostname}: this machine has no local network to advertise it on ({exc})."
        ) from exc

    try:
        resolver = AddressResolver(f"{hostname}.")
        if resolver.request(responder, PROBE_TIMEOUT_MS):
            answered = set(resolver.parsed_addresses(IPVersion.V4Only))
            if answered_by_another_machine(answered, _own_addresses()):
                raise in_use(", ".join(sorted(answered)))
        service = HTTPS_SERVICE if plain_http_port is None else HTTP_SERVICE
        responder.register_service(ServiceInfo(
            service,
            f"{name}.{service}",
            addresses=[socket.inet_aton(address)],
            port=HTTPS_PORT if plain_http_port is None else plain_http_port,
            server=f"{hostname}.",
        ))
    except MdnsError:
        responder.close()
        raise
    except NonUniqueNameException as exc:
        responder.close()
        raise in_use("another installation on this machine") from exc
    except Exception as exc:
        responder.close()
        raise MdnsError(f"Could not advertise {hostname}: {exc}") from exc
    return Advertisement(hostname, responder)
