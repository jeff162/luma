# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Sign-in sessions the server can end.

The session cookie is signed, not stored: the server checks the signature and believes what the cookie
says. Signing out cleared the browser's copy, but a copy taken earlier (from a shared machine, a backup
of a browser profile, a proxy log) went on being accepted for its whole lifetime, and changing the
password or disabling the account did nothing to it either.

So a session now has an id, recorded in the control database's `sign_in_session` table when it starts,
and a cookie is honoured only while its row exists. Ending a session is deleting the row, which reaches
every copy of the cookie at once. Rows are deleted:

- by signing out, for that browser;
- by selecting another identity or signing in again, for the session being replaced;
- by setting an account's password or disabling it, for every session of that account except the one
  making the change (`control_database.update_user`);
- by deleting the account (the row's foreign key cascades);
- by `create_sign_in_session`, for any left idle past the cookie's own lifetime.

The id is also what the vault's unlock cache is keyed by (`crypto_service` → the unlock cache), so an
unlock belongs to one browser session and ends with it.

**One place starts a session**, `start`, which every sign-in path calls. A session without an id is
treated as signed out: a cookie carrying a user but no registered id cannot be told apart from a forged
one by anything else.
"""

import hashlib
import secrets

from backend.db import control_database

# The session cookie's lifetime, and the idle time after which a row stops being honoured. Starlette
# re-signs the cookie on every response, so both are measured from last use rather than from sign-in.
MAX_AGE_SECONDS = 14 * 24 * 60 * 60

# How stale a row's last-seen time may get before a request rewrites it. Keeps an ordinary request to a
# read; the cost is that the server's idea of "idle" can lag the cookie's by up to this much, which is
# why the idle limit below adds it on.
TOUCH_INTERVAL_SECONDS = 60 * 60

_MAX_IDLE_SECONDS = MAX_AGE_SECONDS + TOUCH_INTERVAL_SECONDS

# The session key holding the id.
SESSION_ID_KEY = "sid"


def _digest(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def start(session: dict, user_id: str, *, pwless: bool = False) -> None:
    """Sign `user_id` in on this browser, replacing whatever session it held.

    `pwless` marks a session established by choosing an identity with sign-in protection off, which the
    tenant middleware refuses once protection is turned on."""
    end(session)
    session_id = secrets.token_urlsafe(32)
    control_database.create_sign_in_session(
        _digest(session_id), user_id, prune_idle_seconds=_MAX_IDLE_SECONDS,
    )
    session["user_id"] = user_id
    session[SESSION_ID_KEY] = session_id
    if pwless:
        session["pwless"] = True


def end(session: dict) -> None:
    """Sign this browser out: delete its row, so every copy of the cookie stops working, and clear it."""
    session_id = session.get(SESSION_ID_KEY)
    if session_id:
        control_database.delete_sign_in_session(_digest(session_id))
    session.clear()


def session_id(session: dict | None) -> str | None:
    return (session or {}).get(SESSION_ID_KEY)


def digest_of(session: dict | None) -> str | None:
    """The stored form of this session's id, for `control_database.update_user`'s `keep_sign_in_session`."""
    current = session_id(session)
    return _digest(current) if current else None


def is_live(session: dict) -> bool:
    """Whether the signed-in user this cookie names still has the session it claims."""
    current = session_id(session)
    user_id = session.get("user_id")
    if not current or not user_id:
        return False
    return control_database.sign_in_session_is_live(
        _digest(current), user_id,
        max_idle_seconds=_MAX_IDLE_SECONDS, touch_after_seconds=TOUCH_INTERVAL_SECONDS,
    )
