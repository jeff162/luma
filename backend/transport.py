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

from backend.runtime_config import app_name


def request_is_loopback(request: Request) -> bool:
    client = request.client
    try:
        address = ipaddress.ip_address(client.host if client else "")
    except ValueError:
        return False
    # A dual-stack listener reports an IPv4 peer in its IPv6-mapped form, which is the same machine.
    return (getattr(address, "ipv4_mapped", None) or address).is_loopback


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


def https_expected(request: Request, *, perimeter_on: bool, provider_intended: bool) -> bool:
    """True when the permissible-HTTP rule says this deployment ought to be on HTTPS: a networked
    link carrying either a login credential/session cookie (perimeter on) or a live bank/vault secret
    (a provider is configured/intended). Loopback never needs it."""
    if request_is_loopback(request):
        return False
    return bool(perimeter_on or provider_intended)
