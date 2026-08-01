# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Transport-security detection: the topology (standalone vs client-server) and whether the current
request arrived over HTTPS are *detected per request*, not stored presets. The backend always speaks
plain HTTP; a client-server deployment wraps it in TLS at a reverse proxy (Caddy), so "is HTTPS
running" is really "did this request arrive over HTTPS" — read from `request.url.scheme`, which
reflects `X-Forwarded-Proto` once uvicorn runs with `--proxy-headers` behind the proxy.

The permissible-HTTP rule: plain HTTP on a non-loopback bind is acceptable only when there is no
perimeter to defeat — no sign-in protection (no login credential / session cookie to sniff) and no
aggregator/vault configured (no live bank secret on the wire). Enabling sign-in or connecting a
provider on a networked bind therefore implies HTTPS.
"""

from fastapi import Request

# Hostnames that mean "this request never left the machine." `request.url.hostname` strips the
# brackets from an IPv6 literal, so `::1` (not `[::1]`) is what we compare against.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def request_is_loopback(request: Request) -> bool:
    host = (request.url.hostname or "").lower()
    return host in _LOOPBACK_HOSTS or host.endswith(".localhost") or host.startswith("127.")


def request_scheme(request: Request) -> str:
    return (request.url.scheme or "http").lower()


def request_is_https(request: Request) -> bool:
    return request_scheme(request) == "https"


def https_expected(request: Request, *, perimeter_on: bool, provider_intended: bool) -> bool:
    """True when the permissible-HTTP rule says this deployment ought to be on HTTPS: a networked
    link carrying either a login credential/session cookie (perimeter on) or a live bank/vault secret
    (a provider is configured/intended). Loopback never needs it."""
    if request_is_loopback(request):
        return False
    return bool(perimeter_on or provider_intended)


def cleartext_warning(request: Request, *, perimeter_on: bool, provider_intended: bool) -> str | None:
    """A hard-warn string when an action puts a credential or bank secret on a cleartext network link,
    else None. Surfaced inline when a user enables sign-in protection or configures a provider."""
    if request_is_loopback(request) or request_is_https(request):
        return None
    if not (perimeter_on or provider_intended):
        return None
    return (
        "This request reached the server over plain HTTP on a networked address, so credentials and "
        "any bank secrets would cross the network in cleartext. Configure HTTPS (a TLS-terminating "
        "reverse proxy such as Caddy) before using this over the network."
    )
