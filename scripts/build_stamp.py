#!/usr/bin/env python3
"""The commit a build came from, for the artifact to carry.

`runtime_config.APP_VERSION` is bumped by hand at release time, so it does not distinguish two builds
made from different commits between one release and the next — and that is exactly the pair someone is
holding when they ask whether the bug they are seeing has been fixed since. `scripts/release.py`
already refuses to build from a dirty tree so that an artifact *can* be traced back to a commit;
nothing recorded which commit it was.

**`git describe` rather than a bare revision**, because its answer is readable without a lookup:
`v0.3.0-14-ga1b2c3d` says fourteen commits past the `v0.3.0` tag, which is the shape of the question
being asked. The cost is that it needs the tags *and* the history between them — a shallow clone with
no tags degrades to the abbreviated revision `--always` falls back to, silently, which is why the
release workflow checks out with full history.

`--dirty` marks a build whose tree had uncommitted changes. `release.py` normally prevents one, but
`--allow-dirty` exists for throwaway builds and such an artifact should say so rather than name a
commit it does not match.

**No stamp is a tolerable answer**, which is why git failing here is not fatal. A build from an export
or a source tarball has no repository to ask, and refusing to produce an artifact over a line in the
About panel would be the wrong trade. The application reports no build then, the same as a checkout.
"""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def describe() -> str | None:
    """How git names the current commit, or `None` if it cannot be asked."""
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--always", "--dirty"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
    except OSError:
        # git missing entirely, which is a build from an unpacked source archive.
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


if __name__ == "__main__":
    print(describe() or "(no build stamp: git could not describe this tree)")
