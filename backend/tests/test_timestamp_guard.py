"""The pre-commit timestamp guard, including its one escape hatch.

`scripts/check-backend-timestamps.js` is what keeps stored timestamps flowing through `utcnow_iso()`,
and it grew a `# local-time: <reason>` exemption for the values that genuinely are local (a download
filename, a ZIP entry's timezone-less MS-DOS date). A guard that can be relaxed needs the relaxation
tested from both sides: that it lets the marked line through, and — the half that actually matters —
that everything else still trips, so the exemption cannot quietly become a way to turn the guard off.

Driven from the backend suite rather than the frontend one because what it protects is backend Python,
and because a regression here shows up as backend commits sailing past a guard nobody notices is gone.

**This file is exempt from the guard by path.** A test for a lint rule cannot be written without writing
the thing the rule forbids, so the fixtures below contain the very calls the guard rejects. Do not try to
make them pass by obscuring them — the exemption is deliberate and lives in `SELF_EXEMPT` in the script.
It is narrow on purpose, and `test_other_test_files_are_still_scanned` is what keeps it that way.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts" / "check-backend-timestamps.js"


@unittest.skipIf(shutil.which("node") is None, "node is not available")
class TimestampGuardTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        # The guard only scans paths containing `backend/`, so the fixture has to live under one.
        self.backend = Path(self.tempdir.name) / "backend"
        self.backend.mkdir()

    def tearDown(self):
        self.tempdir.cleanup()

    def _check(self, source: str, name: str = "sample.py"):
        path = self.backend / name
        path.write_text(source)
        return subprocess.run(
            ["node", str(GUARD), str(path)],
            capture_output=True, text=True, cwd=REPO_ROOT,
        )

    def test_a_bare_local_now_is_rejected(self):
        result = self._check("stamp = datetime.now()\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("returns LOCAL time", result.stderr)

    def test_utcnow_is_rejected(self):
        result = self._check("stamp = datetime.utcnow()\n")
        self.assertEqual(result.returncode, 1)

    def test_clean_source_passes(self):
        self.assertEqual(self._check("stamp = utcnow_iso()\n").returncode, 0)

    def test_a_reasoned_exemption_allows_a_local_now(self):
        result = self._check(
            "entry = zip_time(datetime.now())  # local-time: ZIP entry dates carry no timezone\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_exemption_needs_an_actual_reason(self):
        # A bare marker is a rubber stamp, which is the failure mode of every exemption mechanism.
        for marker in ("# local-time:", "# local-time:   ", "# local-time"):
            with self.subTest(marker=marker):
                result = self._check(f"stamp = datetime.now()  {marker}\n")
                self.assertEqual(result.returncode, 1, f"{marker!r} should not exempt anything")

    def test_the_exemption_does_not_cover_utcnow(self):
        # The half of the guard that must stay absolute: utcnow() is deprecated and has no local-time
        # reading, so no reason could make it correct.
        result = self._check("stamp = datetime.utcnow()  # local-time: I would like this to pass\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not apply here", result.stderr)

    def test_the_exemption_is_per_line(self):
        # Marking one line must not license the next: an exemption that leaks down the file is one
        # comment away from disabling the guard for a whole module.
        result = self._check(
            "first = datetime.now()  # local-time: this one is a ZIP entry date\n"
            "second = datetime.now()\n"
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("sample.py:2", result.stderr)
        self.assertNotIn("sample.py:1", result.stderr)

    def test_other_test_files_are_still_scanned(self):
        # The guard skips *this* file by path because its fixtures must quote the banned calls. That
        # exemption has to stay narrow: a sibling test file gets no such pass, or "skip the guard's test"
        # would quietly have become "skip the tests".
        result = self._check("stamp = datetime.now()\n", name="test_something_else.py")
        self.assertEqual(result.returncode, 1)

    def test_the_module_that_prompted_the_exemption_passes(self):
        # The backup module is where this came up: it stamps ZIP entries with local time, and does it
        # through `time.localtime()` — the call `ZipFile.writestr` itself uses — rather than by spending
        # the exemption. Nothing in the tree uses the marker yet; this pins that the module the guard
        # tripped on stays clean however it is spelled.
        result = subprocess.run(
            ["node", str(GUARD), "backend/routers/import_export/backup.py"],
            capture_output=True, text=True, cwd=REPO_ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
