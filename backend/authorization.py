# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Authority checks for the operations that are not ordinary data work.

The login perimeter keeps non-users out and nothing more: once inside, every user reads and edits the same
data, and no data route checks role. Admin gates the few things that are not data edits — user management,
provider and environment settings, and the operations that replace the workspace wholesale: every restore
path, and the backup keys that decide who can read a backup. Creating a backup is held to the same gate so
the server agrees with the Settings section that offers it. See `docs/security-model.md` → *Identity
and the network perimeter*.

Kept out of `routers/auth.py` because routers that the auth router itself imports need these too, and a
guard reached through a lazy import is one that is easy to leave off the next route.
"""

from fastapi import HTTPException, Request

from backend.db.control_database import auth_required
from backend.services.preferences import get_preference_values


def _is_admin(user: dict | None) -> bool:
    return bool(user) and user.get("role") == "admin"


def require_admin(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def require_admin_or_local(request: Request) -> dict:
    if not auth_required():
        # With sign-in protection off there is no perimeter to hold a role against, and environment
        # settings are global app config rather than tenant data, so local mode needs no control-db user
        # record to pass.
        user = getattr(request.state, "user", None)
        return user or {"role": "admin", "local_mode": True}
    return require_admin(request)


def is_admin_or_local(request: Request | None) -> bool:
    """`require_admin_or_local` as a question, for a surface that shows or hides rather than refuses. A
    reminder pointing at an admin-only page has to agree with that page's guard, or it sends someone to a
    refusal."""
    if not auth_required():
        return True
    return _is_admin(getattr(getattr(request, "state", None), "user", None))


# A display preference, not an authority: with sign-in protection off everyone passes the guards above, and
# some people would rather not see what manages the installation. Mirrors `useShowsAdminFeatures` in the
# client. Read only while sign-in is off, so a value left from those days can never hide anything from an
# administrator once roles exist, and is kept for when it is turned off again.
SHOW_ADMIN_FEATURES_PREF_KEY = "ui.showAdminFeatures"


def shows_admin_features(request: Request | None) -> bool:
    """Whether to show this caller what `is_admin_or_local` admits them to: a reminder, a count or a list
    that belongs to an administrator's page. Never a guard — a route enforces with `require_admin_or_local`,
    whatever this answers."""
    if auth_required():
        return is_admin_or_local(request)
    user = getattr(getattr(request, "state", None), "user", None)
    if not user:
        return True
    stored = get_preference_values(user["id"], (SHOW_ADMIN_FEATURES_PREF_KEY,)).get(SHOW_ADMIN_FEATURES_PREF_KEY)
    return stored != "false"
