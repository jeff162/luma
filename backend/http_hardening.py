# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What every response does to keep other websites out of the app, whatever the topology.

The app is reached in a browser that also visits arbitrary websites, so a page elsewhere is the attacker
this module defends against. Three middlewares, each closing a different way in:

- **`HostCheckMiddleware` refuses a request addressed to a name that is not this server's** — the defence
  against DNS rebinding. A page on a public domain can re-point that domain at 127.0.0.1, after which its
  own same-origin requests reach a loopback install and the browser lets it read the answers. The request
  still names the attacker's domain in `Host`, which is the one thing that gives it away. Only a name a
  public DNS could serve is refused: an IP literal, `localhost`, a single label, and the suffixes reserved
  for private networks are answered, since no outside page can be loaded from one. Anything else has to be
  listed in `ALLOWED_HOSTS` — a router-assigned `.lan` name, or an owned domain with a public certificate.
  This reads `Host` only to *refuse*; where a request came from is still read from the connection
  (`transport.py`).
- **`SecureCookieMiddleware` marks a cookie `Secure` when it was set over HTTPS**, so a browser never
  sends it back over cleartext — the plain-HTTP hop a `.local` name takes before the proxy redirects.
  Derived from the request rather than configured, because the same install is plain HTTP on loopback and
  HTTPS from the network. `SESSION_COOKIE_SECURE` still forces it everywhere, for a proxy that does not
  say it terminated TLS.
- **`SecurityHeadersMiddleware` stops the app being framed, and confines what a page may load.** Framing
  is restricted to the app's own origin (the document viewer frames stored files); the content policy
  lets the interface load only its own code and Plaid Link's. It also keeps responses out of the
  browser's disk cache and the app's addresses out of the `Referer` a followed link sends.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Suffixes no public registry delegates, so no page on the internet can be served under one. `.local` is
# mDNS, `.localhost` is this machine (RFC 6761), and `.home.arpa` and `.internal` are reserved for private
# networks (RFC 8375; ICANN, 2024).
_PRIVATE_SUFFIXES = (".local", ".localhost", ".home.arpa", ".internal")

# Plaid Link is the one third party the interface loads: its script, and the frame it opens.
_PLAID_LINK = "https://cdn.plaid.com"


def host_from_header(value: str) -> str:
    """The host name in a `Host` header, without the port or IPv6 brackets, lower-cased."""
    value = value.strip().lower()
    if value.startswith("["):
        return value[1:value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def host_is_allowed(host: str, extra: frozenset[str] = frozenset()) -> bool:
    host = host.rstrip(".")
    if not host:
        return False
    if host in extra:
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    return host == "localhost" or "." not in host or host.endswith(_PRIVATE_SUFFIXES)


def parse_allowed_hosts(value: str) -> frozenset[str]:
    return frozenset(name.strip().lower().rstrip(".") for name in value.split(",") if name.strip())


class HostCheckMiddleware:
    def __init__(self, app: ASGIApp, extra_hosts: frozenset[str] = frozenset()) -> None:
        self.app = app
        self.extra_hosts = extra_hosts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        host = host_from_header(Headers(scope=scope).get("host", ""))
        if host_is_allowed(host, self.extra_hosts):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        # Written for the person who set the name up, since that is who meets it: a page using a rebound
        # name never shows this to anyone.
        body = (
            f"This server does not answer to the name {host!r}. If it is a name for this server, add it to "
            "ALLOWED_HOSTS.\n"
        ).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 400,
            "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})


class SecureCookieMiddleware:
    def __init__(self, app: ASGIApp, always: bool = False) -> None:
        self.app = app
        self.always = always

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not (self.always or scope.get("scheme") == "https"):
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                cookies = headers.getlist("set-cookie")
                if cookies:
                    del headers["set-cookie"]
                    for cookie in cookies:
                        flags = {part.strip().lower() for part in cookie.split(";")[1:]}
                        headers.append("set-cookie", cookie if "secure" in flags else f"{cookie}; secure")
            await send(message)

        await self.app(scope, receive, send_wrapper)


def inline_script_hashes(html: str) -> tuple[str, ...]:
    """CSP source expressions for each inline `<script>` in the built `index.html` (the theme is set
    before first paint, ahead of the bundle). Read from the file rather than written down, so an edit to
    that script cannot leave a stale hash behind that blocks it."""
    hashes = []
    lower = html.lower()
    start = 0
    while (open_at := lower.find("<script", start)) != -1:
        tag_end = lower.find(">", open_at)
        close_at = lower.find("</script>", tag_end)
        if tag_end == -1 or close_at == -1:
            break
        if " src=" not in lower[open_at:tag_end]:
            digest = hashlib.sha256(html[tag_end + 1:close_at].encode("utf-8")).digest()
            hashes.append(f"'sha256-{base64.b64encode(digest).decode('ascii')}'")
        start = close_at + len("</script>")
    return tuple(hashes)


def content_security_policy(script_hashes: tuple[str, ...] = ()) -> str:
    """The policy for every response. Inline styles are allowed because the interface is styled inline
    throughout; script is what the policy exists to confine, and only the app's own and Plaid Link's runs.
    A stored document is served with its own, stricter policy as well, and a browser enforces both."""
    return "; ".join((
        "default-src 'self'",
        " ".join(("script-src 'self'", *script_hashes, _PLAID_LINK)),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' https://*.plaid.com",
        f"frame-src 'self' blob: {_PLAID_LINK}",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ))


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, policy: str) -> None:
        self.app = app
        self.policy = policy

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.append("content-security-policy", self.policy)
                headers.setdefault("x-frame-options", "SAMEORIGIN")
                headers.setdefault("x-content-type-options", "nosniff")
                headers.setdefault("referrer-policy", "same-origin")
                # Ledger data and stored documents stay out of the browser's disk cache. The bundle's
                # hashed assets are the exception, being code that changes name whenever it changes.
                if not scope["path"].startswith("/assets/"):
                    headers.setdefault("cache-control", "no-store")
            await send(message)

        await self.app(scope, receive, send_wrapper)
