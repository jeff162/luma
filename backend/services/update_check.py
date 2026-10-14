# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Asking the project's release list whether a newer version exists.

**This is the one request the app makes that no click directly caused, so it is opt-in.** Everything
else that leaves the machine follows an action — a sync, a backup to a chosen location. A check for a new
version only earns its place beside those because someone switched it on, on the welcome screen or in
Settings → About, and it stays off until they do (`docs/architecture.md` → *Checking for a new version*).

- **Install-wide, held in the control database.** The server makes the request, so there is one answer
  per install rather than one per user; only putting the reminder away is per user, as with every task.
- **Request-driven, on a watermark.** There is no scheduler (`docs/architecture.md` → *Watched import folders*), so
  the app asks on load and the watermark turns every call inside `MIN_INTERVAL_HOURS` into a no-op. The
  interval is a ceiling on how often a request is made, never a promise that one is.
- **The watermark is written before the request**, and advances whether or not it succeeds. An install
  with no route out would otherwise retry on every page load, and two tabs loading together would each
  make the call.
- **Nothing in the response is trusted beyond a version number.** The tag has to parse as `vX.Y.Z` or it
  is ignored, and the link shown to the user is built from a constant rather than read from the reply —
  so the worst a tampered answer can do is claim a version exists.
- **Whether an update is available is decided at read time**, against the version actually running, so
  the reminder goes away on its own once the newer copy is installed.
"""

import json
import re
import urllib.error
import urllib.request

from backend import runtime_config
from backend.app_logging import log_info
from backend.db.control_database import get_app_setting, get_control_db, set_app_setting
from backend.time_utils import utcnow_iso

# GitHub's "latest release" skips drafts and prereleases, which is the definition wanted here: a build
# someone is still testing is not something to send people after.
LATEST_RELEASE_API_URL = "https://api.github.com/repos/jeff162/luma/releases/latest"

MIN_INTERVAL_HOURS = 24
REQUEST_TIMEOUT_SECONDS = 5
# A release description is a few kilobytes; the cap only bounds what a wrong answer can cost.
MAX_RESPONSE_BYTES = 512 * 1024

ENABLED_KEY = "update_check_enabled"
ATTEMPTED_AT_KEY = "update_check_attempted_at"
SUCCEEDED_AT_KEY = "update_check_succeeded_at"
LATEST_VERSION_KEY = "update_check_latest_version"

_VERSION_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def parse_version(value: str | None) -> tuple[int, int, int] | None:
    match = _VERSION_PATTERN.match((value or "").strip())
    return tuple(int(part) for part in match.groups()) if match else None


def is_enabled() -> bool:
    return get_app_setting(ENABLED_KEY, "0") == "1"


def set_enabled(value: bool) -> None:
    set_app_setting(ENABLED_KEY, "1" if value else "0")


def available_version() -> str | None:
    """The newer released version last seen, or None when the running copy is at or past it."""
    latest = parse_version(get_app_setting(LATEST_VERSION_KEY))
    current = parse_version(runtime_config.APP_VERSION)
    if not latest or not current or latest <= current:
        return None
    return ".".join(str(part) for part in latest)


def status() -> dict:
    checked = get_app_setting(SUCCEEDED_AT_KEY)
    return {
        "enabled": is_enabled(),
        "current_version": runtime_config.APP_VERSION,
        "available_version": available_version(),
        # Stored as naive UTC; the marker is what stops a browser reading it as its own local time.
        "last_checked_at": f"{checked}Z" if checked else None,
    }


def _fetch_latest_tag() -> str:
    # No header names this install or its version: the request says only that some copy asked.
    request = urllib.request.Request(
        LATEST_RELEASE_API_URL, headers={"Accept": "application/vnd.github+json"}
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read(MAX_RESPONSE_BYTES))
    return str(payload.get("tag_name") or "")


def run_check() -> bool:
    """Ask now, whatever the watermark says. Returns whether a usable answer came back; a failure leaves
    the last known version in place, since being offline says nothing about what has been released."""
    set_app_setting(ATTEMPTED_AT_KEY, utcnow_iso())
    try:
        latest = parse_version(_fetch_latest_tag())
    except (urllib.error.URLError, OSError, ValueError, AttributeError) as error:
        # Expected wherever there is no route out, so it stays below the error log — an entry there
        # raises a Task of its own, on every load of an install that simply is not online.
        log_info(f"[update-check] could not read the release list: {error}")
        return False
    if not latest:
        return False
    set_app_setting(LATEST_VERSION_KEY, ".".join(str(part) for part in latest))
    set_app_setting(SUCCEEDED_AT_KEY, utcnow_iso())
    return True


def _due() -> bool:
    last = get_app_setting(ATTEMPTED_AT_KEY)
    if not last:
        return True
    with get_control_db() as conn:
        # julianday() parses the stored timestamp; a malformed value yields NULL, which reads as due.
        return bool(conn.execute(
            "SELECT ((julianday('now') - julianday(?)) * 24.0 >= ?) IS NOT 0 AS due",
            (last, MIN_INTERVAL_HOURS),
        ).fetchone()["due"])


def maybe_check() -> dict:
    """The app-load call: check only if it is switched on and one is due."""
    if not is_enabled():
        return {"skipped": "disabled"}
    if not _due():
        return {"skipped": "recent"}
    return {"checked": run_check()}
