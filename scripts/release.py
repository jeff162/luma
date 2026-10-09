#!/usr/bin/env python3
"""Freeze a release: bump the version everywhere, gate the build, produce a checksummed artifact.

The gate is the point. A version bump touches four files because npm and Python packaging each read
their own manifest before any of our code runs — and npm's lockfile repeats the number twice more — and
the failure that creates is quiet: an artifact named for one version that reports another, with nothing
malfunctioning to reveal it. So consistency is checked before anything is built rather than discovered
afterwards, and `--set-version` exists so every declaration is updated together instead of by hand.
`backend/version_sources.py` is the list of where they are.

Deliberately not included:

- **Tagging and CHANGELOG edits.** Both want a human deciding what the release is; a script that writes
  history is a script that has to be undone when the build fails.
- **Running the test suite.** This gates *packaging*, not correctness — it is not a CI replacement, and
  making an 80-second suite part of every build invites skipping the script instead of the suite.
- **Signing.** An unsigned artifact carries an OS warning, and someone who downloads one is choosing
  that; certificates are a separate decision from being able to cut a release.

Cross-building is impossible, so each platform's artifact is produced by running this on that platform
and collecting the results.

    python scripts/release.py --set-version 0.3.0    # rewrite every declaration, then stop
    python scripts/release.py --check                # verify the gates without building
    python scripts/release.py                        # gate, build, checksum
"""

import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import build_desktop  # noqa: E402  (needs scripts/ on the path first)
import build_stamp  # noqa: E402  (same)
from backend import runtime_config, version_sources  # noqa: E402


def _check_versions_agree() -> list[str]:
    mismatched = version_sources.disagreements()
    if not mismatched:
        return []
    problems = [
        f"Version declarations disagree — `{runtime_config.APP_VERSION}` is authoritative "
        f"(backend/runtime_config.py):"
    ]
    problems += [f"  {where} says {found}" for where, found in mismatched.items()]
    problems.append("  Fix with: python scripts/release.py --set-version <version>")
    return problems


def _check_tree_is_clean() -> list[str]:
    """A dirty tree means the artifact cannot be traced back to a commit, which is most of what makes a
    release reproducible."""
    result = subprocess.run(
        ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True
    )
    if result.returncode != 0:
        return ["Not a git repository, or git is unavailable — cannot verify the tree is clean."]

    dirty = [line for line in result.stdout.splitlines() if line.strip()]
    if not dirty:
        return []
    return (
        ["Working tree is not clean, so this build could not be traced back to a commit:"]
        + [f"  {line}" for line in dirty[:10]]
        + ([f"  ... and {len(dirty) - 10} more"] if len(dirty) > 10 else [])
        + ["  Commit first, or pass --allow-dirty for a throwaway build."]
    )


def _write_checksum(archive: Path) -> Path:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    # `sha256sum -c` format, so verification needs no instructions beyond the file itself.
    checksum = archive.with_suffix(archive.suffix + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n")
    return checksum


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Freeze a Luma release: gate the version, build the artifact, write its checksum.",
    )
    parser.add_argument(
        "--set-version",
        metavar="X.Y.Z",
        help="Rewrite every version declaration to this value and stop without building.",
    )
    parser.add_argument("--check", action="store_true", help="Run the gates without building.")
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Build from an uncommitted tree (throwaway builds only).",
    )
    parser.add_argument(
        "--skip-frontend",
        action="store_true",
        help="Reuse the existing frontend/dist instead of rebuilding it.",
    )
    args = parser.parse_args()

    if args.set_version:
        try:
            changed = version_sources.set_version(args.set_version)
        except ValueError as error:
            raise SystemExit(str(error))
        if changed:
            print(f"Set version {args.set_version} in:")
            for path in changed:
                print(f"  {path}")
        else:
            print(f"Every declaration already reads {args.set_version}.")
        print("\nReview the diff and commit, then run this again to build.")
        return 0

    problems = _check_versions_agree()
    if not args.allow_dirty:
        problems += _check_tree_is_clean()
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1

    # The stamp is named here as well as by the spec that writes it, because it is what the clean-tree
    # gate above was for: the commit this artifact will claim, printed before the build output buries it.
    stamp = build_stamp.describe()
    print(f"Version {runtime_config.APP_VERSION}{f' ({stamp})' if stamp else ''}, gates passed.\n")
    if args.check:
        return 0

    archive = build_desktop.build(skip_frontend=args.skip_frontend)
    checksum = _write_checksum(archive)

    size_mb = archive.stat().st_size / (1024 * 1024)
    print(f"\nReleased {archive.relative_to(ROOT)} ({size_mb:.1f} MB)")
    print(f"         {checksum.relative_to(ROOT)}")
    print("\nEach platform's artifact has to be built on that platform; collect them before publishing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
