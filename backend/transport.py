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
One part is enforced: `require_protected_link` and `require_protected_vault_link` refuse the operations
that put a provider secret or a vault unlock secret on the wire. `docs/security-model.md` -> "Transport security" lists them, and what is left out and why.
"""

import ipaddress

from fastapi import HTTPException, Request

from backend import app_config
from backend.db import control_database
from backend.runtime_config import app_name

# Whether other devices can open this installation at all, as distinct from where one request came
# from. It is what sign-in protection is described against: on an installation only this machine can
# open it keeps out the other people who use the machine, and on one the network can open it keeps out
# the network. Two witnesses, in `reachable_from_network`.
#
# Beside it, whether they can open it without HTTPS: the server listening on the network itself rather
# than only behind a proxy on this machine (`wide_bind`), or a device actually seen connecting in cleartext.
_declared: tuple[bool, bool] | None = None  # (reachable, listens on the network directly)
_seen_from_network = False
_seen_plain_http_from_network = False
_seen_https_from_network = False


def _is_loopback_address(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    # A dual-stack listener reports an IPv4 peer in its IPv6-mapped form, which is the same machine.
    return (getattr(address, "ipv4_mapped", None) or address).is_loopback


def declare_listener(*, reachable: bool, direct: bool) -> None:
    """The launcher's statement of what it started (`backend/desktop.py`): it chose the address, so it
    knows. Server mode is reachable even on a loopback bind, because a proxy on this machine is what
    the network then reaches and nothing here can see one; `direct` is a bind wider than loopback, where
    the network reaches this process's own plain HTTP."""
    global _declared
    _declared = (reachable, direct)


def note_request(request: Request) -> None:
    """Remember that a device other than this machine got through, and whether it did so over HTTPS.
    It settles the question whatever the configuration says — a proxy somebody put in front by hand, a
    server started on an address the settings do not name — and is forgotten at the next start, when it
    will be seen again if still true."""
    global _seen_from_network, _seen_plain_http_from_network, _seen_https_from_network
    if request_is_loopback(request):
        return
    _seen_from_network = True
    if request_is_https(request):
        _seen_https_from_network = True
    else:
        _seen_plain_http_from_network = True


def _is_wide(host: str) -> bool:
    host = host.strip()
    return host.lower() != "localhost" and not _is_loopback_address(host)


def wide_bind() -> dict | None:
    """The setting that puts this process's own plain HTTP on the network, as `{setting, value, checkout}`,
    or None when it listens to this machine only.

    Under the launcher only `FRONTEND_HOST` can, and only in server mode (`desktop._server_bind_host`).
    With no launcher this is a source checkout, where the start scripts pass both settings to the servers
    they start; the interface's own server counts, since it forwards to this one. Neither is ever behind
    TLS of its own."""
    if _declared is not None:
        if not _declared[1]:
            return None
        return {"setting": "FRONTEND_HOST", "value": app_config.value_of("frontend_host").strip(), "checkout": False}
    for key, setting in (("backend_host", "BACKEND_HOST"), ("frontend_host", "FRONTEND_HOST")):
        value = app_config.value_of(key)
        if _is_wide(value):
            return {"setting": setting, "value": value.strip(), "checkout": True}
    return None


def seen_plain_http_from_network() -> bool:
    return _seen_plain_http_from_network


def seen_https_from_network() -> bool:
    return _seen_https_from_network


def reachable_from_network() -> bool:
    if _seen_from_network:
        return True
    if _declared is not None:
        return _declared[0]
    return wide_bind() is not None


def plain_http_from_network() -> bool:
    """Whether another device can open this installation without HTTPS."""
    return _seen_plain_http_from_network or wide_bind() is not None


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


def host_is_address(request: Request) -> bool:
    """Whether the browser opened this page by IP address rather than by name."""
    host = (request.url.hostname or "").strip("[]")
    # A hostname made only of digits and dots, or containing a colon, is an address rather than a name.
    return bool(host) and (":" in host or all(part.isdigit() for part in host.split(".") if part))


def passkey_context(request: Request) -> dict:
    """The Relying Party id a ceremony must run under, or why one cannot run here.

    Two constraints, both outside the app's control. WebAuthn requires a **secure context**, so a
    cleartext network bind cannot register or use a passkey at all. And an RP id must be a *domain* —
    a bare IP address is not one, so a LAN server reached as `192.168.x.x` can never host passkeys
    however it is served. Both are reported as stated reasons rather than left to surface as an
    unexplained browser exception, because in both cases the answer is "use a passphrase here".
    """
    # The address check comes first because the two reasons differ in whether anything can be done: an
    # address can never host passkeys however it is served, while cleartext is fixed by configuring
    # HTTPS. Reporting the fixable one on a host where the fix would not help sends the user to set up
    # TLS and arrive back at the same refusal.
    if host_is_address(request):
        return {"available": False, "reason": "ip_address_host", "rp_id": None}
    if not page_is_secure_context(request):
        return {"available": False, "reason": "insecure_context", "rp_id": None}
    return {"available": True, "reason": None, "rp_id": (request.url.hostname or "").strip("[]")}


def note_served_host(request: Request) -> None:
    """Record the name this page was opened under, where a passkey could run there.

    The `Host` header is the client's own word, which is why only a session already past the perimeter
    calls this: the most a false name can do is keep a backup's passkey for a name nobody uses."""
    rp_id = passkey_context(request)["rp_id"]
    if rp_id:
        control_database.record_served_host(rp_id)


def passkey_host_names(page_rp_id: str | None) -> set[str]:
    """Every host name a passkey could answer under on this install: the names its pages have been
    opened under (`note_served_host`), and the page asking.

    A passkey registered under any other name can never work here. The vault's own passkeys are not
    evidence of a name: a copied database brings the ones registered where it came from. Nor is
    `MDNS_NAME`: it has a default on every install, so counting it would make each one claim that name and
    keep exactly the passkeys a restore from another machine must leave behind. A name configured only in a
    reverse proxy and never opened in a browser is not known either."""
    names = set(control_database.list_served_hosts())
    if page_rp_id:
        names.add(page_rp_id)
    return {name.lower() for name in names}


def link_is_protected(request: Request) -> bool:
    """Whether what this request carries is out of reach of anyone else on the network: it never left
    the machine, or it crossed the network encrypted."""
    return request_is_loopback(request) or request_is_https(request)


# For someone building from source who accepts the old trade: True lets a vault secret cross the network
# over plain HTTP, so a plain-HTTP install can open the vault, and so sync, from any device. Deliberately
# a constant and not a setting, so no shipped build and no line in `.env` can turn the protection off
# (`security-model.md` -> *Transport security*).
VAULT_OVER_PLAIN_HTTP = False


def vault_link_is_protected(request: Request) -> bool:
    """Whether this request may carry a secret that opens the vault."""
    return VAULT_OVER_PLAIN_HTTP or link_is_protected(request)


def _refuse_unprotected_link(request: Request, what: str) -> None:
    if link_is_protected(request):
        return
    raise HTTPException(status_code=403, detail={
        "code": "protected_link_required",
        "message": (
            f"This cannot be done over plain HTTP from another device, because {what} would cross the "
            f"network unprotected. Use a browser on the computer {app_name()} runs on, or set up HTTPS "
            "first."
        ),
    })


def require_protected_link(request: Request) -> None:
    """Refuse a request that would carry a provider secret across the network in cleartext.

    Says what to do instead, because both ways out are ordinary: the same action works from a browser on
    the server itself, and HTTPS makes it work from anywhere."""
    _refuse_unprotected_link(request, "a data provider's secret")


def require_protected_vault_link(request: Request) -> None:
    """Refuse a request that would carry a vault unlock secret across the network in cleartext: a
    passphrase, a recovery code or a passkey's output, typed or returned.

    A vault secret opens the key the provider credentials are encrypted under, in this database and in
    every copy and backup of it, which is why the passphrase is held to a strength rule; one read off the
    network undoes that. So the vault opens only over a protected link, and since an unlock belongs to the
    browser session that made it, everything that needs the vault open follows: over plain HTTP a
    connection is created, synced and repaired from a browser on the server
    (`security-model.md` -> *Transport security*). `VAULT_OVER_PLAIN_HTTP` lifts it."""
    if VAULT_OVER_PLAIN_HTTP:
        return
    _refuse_unprotected_link(request, "a secret that opens the vault")


def https_expected(request: Request, *, perimeter_on: bool) -> bool:
    """True when this request is the case HTTPS is recommended for: a network link carrying a sign-in
    credential and its session cookie. Loopback never needs it. A provider secret is not part of this —
    it is refused over such a link outright (`require_protected_link`), not advised about."""
    if request_is_loopback(request):
        return False
    return bool(perimeter_on)
