# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Transport-security detection: the topology (standalone vs client-server) and whether the current
request arrived over HTTPS are *detected per request*, not stored presets. The backend always speaks
plain HTTP; a client-server deployment wraps it in TLS at a reverse proxy (Caddy), so "is HTTPS
running" is really "did this request arrive over HTTPS" — read from `request.url.scheme`, which
reflects `X-Forwarded-Proto` once uvicorn runs with `--proxy-headers` behind the proxy.

**Where a request came from is read from the connection, never from what the request says about
itself.** Loopback is the client address: the peer uvicorn accepted, or the address a proxy on this
machine forwarded for it — uvicorn honors `X-Forwarded-For` from a loopback peer only, so a device on
the network cannot name itself local. The `Host` header is the wrong witness for the same question,
because the client writes it and a proxy may rewrite it. A request whose client cannot be read as an
address is treated as coming from the network.

The permissible-HTTP rule: plain HTTP on a non-loopback bind is acceptable only when there is no
perimeter to defeat — no sign-in protection (no login credential / session cookie to sniff) and no
aggregator/vault configured (no live bank secret on the wire). Enabling sign-in or connecting a
provider on a networked bind therefore implies HTTPS.

Most of that rule is advice, because running plain HTTP on a network someone trusts is their decision.
One part is enforced: `require_protected_link` refuses the operations that put a provider secret on
the wire. `docs/security-model.md` -> "Transport security" lists them, and what is left out and why.
"""

import ipaddress

from fastapi import HTTPException, Request

from backend import app_config
from backend.runtime_config import app_name

# Whether other devices can open this installation at all, as distinct from where one request came
# from. It is what sign-in protection is described against: on an installation only this machine can
# open it keeps out the other people who use the machine, and on one the network can open it keeps out
# the network. Two witnesses, in `reachable_from_network`.
_declared_reachable: bool | None = None
_seen_from_network = False


def _is_loopback_address(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    # A dual-stack listener reports an IPv4 peer in its IPv6-mapped form, which is the same machine.
    return (getattr(address, "ipv4_mapped", None) or address).is_loopback


def declare_reachable_from_network(reachable: bool) -> None:
    """The launcher's statement of what it started (`backend/desktop.py`): it chose the address, so it
    knows. Server mode is reachable even on a loopback bind, because a proxy on this machine is what
    the network then reaches and nothing here can see one."""
    global _declared_reachable
    _declared_reachable = reachable


def note_request(request: Request) -> None:
    """Remember that a device other than this machine got through. It settles the question whatever
    the configuration says — a proxy somebody put in front by hand, a server started on an address the
    settings do not name — and is forgotten at the next start, when it will be seen again if still true."""
    global _seen_from_network
    if not _seen_from_network and not request_is_loopback(request):
        _seen_from_network = True


def reachable_from_network() -> bool:
    if _seen_from_network:
        return True
    if _declared_reachable is not None:
        return _declared_reachable
    # No launcher: a source checkout, where the start scripts pass these two settings to the servers
    # they start. The interface's own server counts, since it forwards to this one.
    return any(
        host.strip().lower() != "localhost" and not _is_loopback_address(host.strip())
        for host in (app_config.value_of("backend_host"), app_config.value_of("frontend_host"))
    )


def request_is_loopback(request: Request) -> bool:
    client = request.client
    host = client.host if client else ""
    if client is not None and host is None:
        # uvicorn's answer when every forwarded hop was one it trusts: it looks for the first address
        # that is *not* a trusted proxy, finds none, and leaves the client blank. That is a browser on
        # this machine reaching the server through the proxy, and the header — vouched for hop by hop —
        # still names where the chain began.
        host = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return _is_loopback_address(host or "")


def request_scheme(request: Request) -> str:
    return (request.url.scheme or "http").lower()


def request_is_https(request: Request) -> bool:
    return request_scheme(request) == "https"


# Hosts a browser treats as this machine, whatever the scheme. `request.url.hostname` strips the
# brackets from an IPv6 literal, so `::1` (not `[::1]`) is what is compared.
_LOCAL_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "::1"}


def page_is_secure_context(request: Request) -> bool:
    """Whether the browser showing this page will run a passkey ceremony on it: HTTPS, or an origin it
    counts as local.

    A different question from `request_is_loopback`, with a different witness. That one asks whether
    bytes crossed the network, which only the connection can say. This one predicts a rule the browser
    applies to the *origin it was given*, so the host is the right thing to read — a browser on the
    server itself that opened the machine's network name over HTTP is a loopback client and still not a
    secure context. Nothing is granted on the strength of it: the browser enforces the real rule, and
    this only lets the refusal be explained."""
    host = (request.url.hostname or "").lower()
    return (
        request_is_https(request)
        or host in _LOCAL_ORIGIN_HOSTS or host.endswith(".localhost") or host.startswith("127.")
    )


def link_is_protected(request: Request) -> bool:
    """Whether what this request carries is out of reach of anyone else on the network: it never left
    the machine, or it crossed the network encrypted."""
    return request_is_loopback(request) or request_is_https(request)


def require_protected_link(request: Request) -> None:
    """Refuse a request that would carry a provider secret across the network in cleartext.

    Says what to do instead, because both ways out are ordinary: the same action works from a browser on
    the server itself, and HTTPS makes it work from anywhere."""
    if link_is_protected(request):
        return
    raise HTTPException(status_code=403, detail={
        "code": "protected_link_required",
        "message": (
            "This cannot be done over plain HTTP from another device, because a data provider's secret "
            f"would cross the network unprotected. Use a browser on the computer {app_name()} runs on, "
            "or set up HTTPS first."
        ),
    })


def https_expected(request: Request, *, perimeter_on: bool) -> bool:
    """True when this request is the case HTTPS is recommended for: a network link carrying a sign-in
    credential and its session cookie. Loopback never needs it. A provider secret is not part of this —
    it is refused over such a link outright (`require_protected_link`), not advised about."""
    if request_is_loopback(request):
        return False
    return bool(perimeter_on)
