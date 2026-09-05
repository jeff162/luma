# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Every place the application version is declared, and how to read or rewrite each one.

`runtime_config.APP_VERSION` is the authority — it is what the API reports and what a packaged artifact
is named for. The packaging manifests cannot derive it: npm reads `package.json` and Python packaging
reads `pyproject.toml` before any of our code runs, so each needs a literal of its own. This module is
the single statement of *where those literals are*, so the consistency test and the release script agree
on the list rather than each keeping their own copy of it — a further declaration site is otherwise easy
to add to one and forget in the other, which is exactly what happened to the lockfile below.

`package-lock.json` carries the version **twice**, once at the root and once in its own `packages[""]`
entry, and npm rewrites both from `package.json` on any install. That makes it a generated file rather
than an authored one, but it is still a declaration: it goes stale the moment the manifest beside it is
bumped, and nothing fails when it does — `npm ci` validates dependency resolution, not the root version.
Left out of the rewrite it simply stays behind at the previous release's number forever.

**Repo-time only.** A frozen build carries none of these manifests, so nothing here may be imported by
application code; `runtime_config` stays the frozen-safe half of this pair.

Rewrites are done by targeted substitution rather than by parsing and re-serializing. Round-tripping
JSON or TOML would reformat files a person reads and reviews, turning a one-line version bump into an
unreviewable diff — and in the lockfile's case it would rewrite thousands of lines npm owns, on the
chance that this module's serializer and npm's agree in every detail.
"""

import json
import re
import tomllib
from pathlib import Path

from backend import runtime_config

REPO_ROOT = Path(__file__).resolve().parent.parent

RUNTIME_CONFIG = REPO_ROOT / "backend" / "runtime_config.py"
PACKAGE_JSON = REPO_ROOT / "frontend" / "package.json"
PACKAGE_LOCK = REPO_ROOT / "frontend" / "package-lock.json"
PYPROJECT = REPO_ROOT / "backend" / "pyproject.toml"

# Anchored so neither can match something else in its file: a dependency pin in `pyproject.toml`
# (`"fastapi==0.115.0"`) and every other `"version"`-ish key in `package.json` have a different shape.
_RUNTIME_CONFIG_PATTERN = re.compile(r'^APP_VERSION = "([^"]+)"$', re.MULTILINE)
_PYPROJECT_PATTERN = re.compile(r'^version = "([^"]+)"$', re.MULTILINE)
_PACKAGE_JSON_PATTERN = re.compile(r'^(\s*"version":\s*)"([^"]+)"', re.MULTILINE)

# The lockfile is the one file here where `"version"` is overwhelmingly *not* the app's — every
# dependency entry has one. Both patterns are anchored on structure the dependency entries cannot
# reproduce: the root declaration is the only `"version"` at the top level's two-space indent, and the
# self entry is reached from the `""` package key. Bounding the second to a few lines keeps a failure
# loud — if npm ever reorders those keys the substitution finds nothing and `set_version` raises,
# rather than silently walking into the first dependency it meets.
_PACKAGE_LOCK_ROOT_PATTERN = re.compile(r'^(  "version": )"([^"]+)"', re.MULTILINE)
_PACKAGE_LOCK_SELF_PATTERN = re.compile(
    r'^(    "": \{\n(?:      .*\n){0,5}?      "version": )"([^"]+)"', re.MULTILINE
)

VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$")


def declared_versions() -> dict[str, str]:
    """Each declaration, keyed by where it lives. The lockfile's two are reported separately: they can
    disagree with each other as well as with the authority, and which one is stale says whether the file
    was hand-edited or regenerated."""
    lock = json.loads(PACKAGE_LOCK.read_text())
    return {
        "backend/runtime_config.py": runtime_config.APP_VERSION,
        "frontend/package.json": json.loads(PACKAGE_JSON.read_text())["version"],
        "backend/pyproject.toml": tomllib.loads(PYPROJECT.read_text())["project"]["version"],
        "frontend/package-lock.json": lock["version"],
        'frontend/package-lock.json (packages."")': lock["packages"][""]["version"],
    }


def disagreements() -> dict[str, str]:
    """Declarations that do not match the authority, or an empty mapping when they all agree."""
    authoritative = runtime_config.APP_VERSION
    return {where: found for where, found in declared_versions().items() if found != authoritative}


def set_version(new_version: str) -> list[str]:
    """Rewrite every declaration, returning the paths that changed. Raises `ValueError` on a version
    that is not `MAJOR.MINOR.PATCH` (optionally suffixed), since a typo here propagates into an artifact
    filename and a released API response."""
    if not VERSION_PATTERN.match(new_version):
        raise ValueError(f"{new_version!r} is not a MAJOR.MINOR.PATCH version.")

    edits = (
        (RUNTIME_CONFIG, _RUNTIME_CONFIG_PATTERN, f'APP_VERSION = "{new_version}"'),
        (PYPROJECT, _PYPROJECT_PATTERN, f'version = "{new_version}"'),
        (PACKAGE_JSON, _PACKAGE_JSON_PATTERN, rf'\g<1>"{new_version}"'),
        (PACKAGE_LOCK, _PACKAGE_LOCK_ROOT_PATTERN, rf'\g<1>"{new_version}"'),
        (PACKAGE_LOCK, _PACKAGE_LOCK_SELF_PATTERN, rf'\g<1>"{new_version}"'),
    )

    # Every substitution is resolved before any file is written. One declaration lives in a file npm
    # generates, so "the anchor is no longer there" is a reachable failure rather than a typo — and a
    # bump that raises halfway leaves the tree declaring two versions at once, which is the exact state
    # this module exists to prevent. Pending edits accumulate per path so the lockfile's two land
    # together.
    pending: dict[Path, str] = {}
    for path, pattern, replacement in edits:
        body = pending.get(path) or path.read_text()
        rewritten, count = pattern.subn(replacement, body, count=1)
        if count != 1:
            raise ValueError(f"No version declaration found in {path.relative_to(REPO_ROOT)}.")
        pending[path] = rewritten

    changed = []
    for path, rewritten in pending.items():
        if rewritten != path.read_text():
            path.write_text(rewritten)
            changed.append(str(path.relative_to(REPO_ROOT)))

    return changed
