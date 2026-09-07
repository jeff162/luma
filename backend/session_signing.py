# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Session cookies that survive the clock stepping backwards.

`SessionMiddleware` verifies a session cookie with `itsdangerous.TimestampSigner`, whose `max_age` check
raises `SignatureExpired` for two opposite situations: a cookie *older* than `max_age` — a genuinely
stale client — and one whose timestamp is in the **future** (`age < 0`). Starlette answers either with
`session = {}`, which downstream is indistinguishable from having sent no cookie at all, so the user is
silently signed out with no explanation.

The second case is not hypothetical. A wall clock that steps backwards invalidates every session signed
in the window it skipped, for exactly as long as the step, and then stops on its own. It surfaced here as
an intermittent burst of 401s under the browser suite — one run carried 81 rejections at ages of -1s, -2s
and -3s — but the harness only made it *visible*: the same thing happens to a real user whenever their
machine's clock is corrected backwards, which is a laptop resuming from sleep, a VM restored from a
snapshot, or any NTP step.

**A future timestamp is not a security signal, and that is what makes tolerating it safe.** The cookie is
secured by its *signature*; the timestamp is data inside the signed payload and cannot be forged without
the secret. So `age < 0` never indicates an attack — only that two readings of one clock disagree. What
it does bound is *lifetime*: `max_age` is measured from the stamp, so accepting a stamp `T` seconds ahead
lets a session live `T` seconds longer than intended. That is the entire cost of the tolerance, and it is
why there is one rather than the check simply being dropped.

**Why not pass `max_age=None` instead**, which was the first proposal: Starlette derives *both* the
server-side age check and the browser's own `Max-Age` cookie attribute from that one parameter, so
disabling the check would also turn the cookie into a session cookie the browser bounds however it
likes. Giving up the server-side lifetime bound to fix a clock problem is the wrong trade.
"""

from __future__ import annotations

from datetime import datetime

import itsdangerous
from starlette.middleware.sessions import SessionMiddleware

# How far ahead of this clock a session's timestamp may be and still be honoured. Sized against what a
# clock correction actually costs rather than what was observed (steps of one to three seconds): an NTP
# step after a resume is routinely larger, and the tolerance is only ever spent extending a session's
# life by at most this much, so being generous costs almost nothing and being tight reintroduces the bug
# for a slower clock. It stays finite because an unbounded one would let a wildly future-stamped cookie
# outlive `max_age` by that same margin.
CLOCK_SKEW_TOLERANCE_SECONDS = 300


class ClockSkewTolerantSigner(itsdangerous.TimestampSigner):
    """A `TimestampSigner` that accepts a timestamp up to `CLOCK_SKEW_TOLERANCE_SECONDS` in the future.

    **The age test is re-implemented rather than nudged through `get_timestamp`**, which is the shape
    that looks right and is not. `get_timestamp` supplies *both* sides of the parent's
    `age = self.get_timestamp() - ts_int`: the stamp written when signing, and the reading taken when
    verifying. Offsetting it moves both, so the difference — and every comparison against it — comes out
    exactly the same. Only the comparison itself can be widened, which is what this does.
    """

    def unsign(self, signed_value: str | bytes, max_age: int | None = None,
               return_timestamp: bool = False) -> tuple[bytes, datetime] | bytes:
        # `max_age=None` runs the parent's signature and timestamp validation in full and skips only the
        # two age comparisons, which are then made below. Tampering still raises from there.
        value, signed_at = super().unsign(signed_value, max_age=None, return_timestamp=True)
        if max_age is not None:
            age = self.get_timestamp() - int(signed_at.timestamp())
            if age > max_age:
                raise itsdangerous.SignatureExpired(
                    f"Signature age {age} > {max_age} seconds", payload=value, date_signed=signed_at)
            if age < -CLOCK_SKEW_TOLERANCE_SECONDS:
                raise itsdangerous.SignatureExpired(
                    f"Signature age {age} < -{CLOCK_SKEW_TOLERANCE_SECONDS} seconds",
                    payload=value, date_signed=signed_at)
        return (value, signed_at) if return_timestamp else value


class ClockSkewTolerantSessionMiddleware(SessionMiddleware):
    """`SessionMiddleware` with the signer above in place of the stock one. Everything else — the cookie
    name and flags, the `Max-Age` attribute, the empty-session fallback — is Starlette's, unchanged."""

    def __init__(self, app, secret_key, **kwargs) -> None:
        super().__init__(app, secret_key, **kwargs)
        self.signer = ClockSkewTolerantSigner(str(secret_key))
