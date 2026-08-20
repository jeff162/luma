# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Every place the application version is declared, and how to read or rewrite each one.

`runtime_config.APP_VERSION` is the authority — it is what the API reports and what a packaged artifact
is named for. The two packaging manifests cannot derive it: npm reads `package.json` and Python
packaging reads `pyproject.toml` before any of our code runs, so each needs a literal of its own. This
module is the single statement of *where those literals are*, so the consistency test and the release
script agree on the list rather than each keeping their own copy of it — a fourth declaration site would
otherwise be easy to add to one and forget in the other.

**Repo-time only.** A frozen build carries neither manifest, so nothing here may be imported by
application code; `runtime_config` stays the frozen-safe half of this pair.

Rewrites are done by targeted substitution rather than by parsing and re-serializing. Round-tripping
JSON or TOML would reformat files a person reads and reviews, turning a one-line version bump into an
unreviewable diff.
"""

import json
import re
import tomllib
from pathlib import Path

from backend import runtime_config

REPO_ROOT = Path(__file__).resolve().parent.parent

RUNTIME_CONFIG = REPO_ROOT / "backend" / "runtime_config.py"
PACKAGE_JSON = REPO_ROOT / "frontend" / "package.json"
PYPROJECT = REPO_ROOT / "backend" / "pyproject.toml"

# Anchored so neither can match something else in its file: a dependency pin in `pyproject.toml`
# (`"fastapi==0.115.0"`) and every other `"version"`-ish key in `package.json` have a different shape.
_RUNTIME_CONFIG_PATTERN = re.compile(r'^APP_VERSION = "([^"]+)"$', re.MULTILINE)
_PYPROJECT_PATTERN = re.compile(r'^version = "([^"]+)"$', re.MULTILINE)
_PACKAGE_JSON_PATTERN = re.compile(r'^(\s*"version":\s*)"([^"]+)"', re.MULTILINE)

VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$")


def declared_versions() -> dict[str, str]:
    """Each declaration, keyed by the repo-relative path a person would go and edit."""
    return {
        "backend/runtime_config.py": runtime_config.APP_VERSION,
        "frontend/package.json": json.loads(PACKAGE_JSON.read_text())["version"],
        "backend/pyproject.toml": tomllib.loads(PYPROJECT.read_text())["project"]["version"],
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
    )

    changed = []
    for path, pattern, replacement in edits:
        body = path.read_text()
        rewritten, count = pattern.subn(replacement, body, count=1)
        if count != 1:
            raise ValueError(f"No version declaration found in {path.relative_to(REPO_ROOT)}.")
        if rewritten != body:
            path.write_text(rewritten)
            changed.append(str(path.relative_to(REPO_ROOT)))

    return changed
