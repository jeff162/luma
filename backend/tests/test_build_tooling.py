"""Build-script behavior that only misbehaves on a platform the developer is not on.

`scripts/` is a directory of standalone scripts rather than a package, so the module under test is
loaded by path. It is worth testing anyway: every bug found here so far has been Windows-only, which
means the feedback loop is a round trip through someone else's machine unless the decision is pinned
down by a test that can run anywhere.
"""

import importlib.util
import os
import zipfile
from datetime import datetime
from pathlib import Path
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _load_build_desktop():
    spec = importlib.util.spec_from_file_location(
        "build_desktop_under_test", REPO_ROOT / "scripts" / "build_desktop.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build_desktop = _load_build_desktop()


def test_windows_prefers_the_batch_wrapper_over_the_shell_script():
    """Node installs `npm.cmd` and an extensionless `npm` shell script side by side. Starting the
    latter fails with `WinError 193: %1 is not a valid Win32 application`, which names nothing a reader
    would connect to npm."""
    found = {"npm.cmd": r"C:\Program Files\nodejs\npm.cmd", "npm": r"C:\Program Files\nodejs\npm"}

    with mock.patch.object(build_desktop, "_is_windows", return_value=True), \
         mock.patch.object(build_desktop.shutil, "which", side_effect=found.get):
        assert build_desktop._npm() == r"C:\Program Files\nodejs\npm.cmd"


def test_windows_falls_back_when_only_the_bare_name_resolves():
    with mock.patch.object(build_desktop, "_is_windows", return_value=True), \
         mock.patch.object(build_desktop.shutil, "which", side_effect={"npm": "npm"}.get):
        assert build_desktop._npm() == "npm"


def test_other_platforms_ask_for_npm_by_its_own_name():
    with mock.patch.object(build_desktop, "_is_windows", return_value=False), \
         mock.patch.object(build_desktop.shutil, "which", side_effect={"npm": "/usr/bin/npm"}.get) as which:
        assert build_desktop._npm() == "/usr/bin/npm"
    assert [call.args[0] for call in which.call_args_list] == ["npm"]


def test_a_missing_npm_is_reported_rather_than_crashing_later():
    with mock.patch.object(build_desktop.shutil, "which", return_value=None):
        with pytest.raises(SystemExit, match="npm was not found"):
            build_desktop._npm()


@pytest.mark.parametrize("has_node_modules, expected", [
    (True, [["run", "build"]]),
    (False, [["ci"], ["run", "build"]]),
])
def test_a_fresh_checkout_installs_before_it_builds(tmp_path, has_node_modules, expected):
    """`npm run build` without node_modules fails with `vite: not found`, which points at the build tool
    rather than at the missing install."""
    (tmp_path / "frontend").mkdir()
    if has_node_modules:
        (tmp_path / "frontend" / "node_modules").mkdir()

    commands = []
    with mock.patch.object(build_desktop, "ROOT", tmp_path), \
         mock.patch.object(build_desktop, "_npm", return_value="npm"), \
         mock.patch.object(build_desktop, "_run", lambda command, cwd: commands.append(command[1:])):
        build_desktop._build_frontend()

    assert commands == expected


def test_the_bundled_executable_keeps_its_date_and_its_compression(tmp_path):
    """The executable needs a hand-built `ZipInfo` to carry its mode bits, and a hand-built one
    inherits nothing else from the archive — not the date, not the compression. Both defaults shipped:
    every kit went out with its binary dated 1980 and stored uncompressed. The date reads as a broken
    download, and the executable is nearly the whole of the download.

    Written against the archive rather than against the call, because what matters is the bytes a
    recipient unzips, and the two mistakes were invisible in the code that made them."""
    executable = tmp_path / "luma"
    # Compressible on purpose: a random blob would deflate to roughly its own size and prove nothing.
    executable.write_bytes(b"MZ" + b"\0" * 500_000)
    # An even second, since a DOS timestamp stores seconds in two-second units and would round an odd
    # one down — a detail that would otherwise look like an off-by-one in the code under test.
    built_at = datetime(2026, 3, 4, 5, 6, 8).timestamp()
    os.utime(executable, (built_at, built_at))

    with mock.patch.object(build_desktop, "DIST_DIR", tmp_path / "dist"):
        archive = build_desktop._package_zip(executable, build_desktop.DIST_FORM_PORTABLE)

    with zipfile.ZipFile(archive) as bundle:
        entry = bundle.getinfo("luma/luma")
        readme = bundle.getinfo("luma/README.txt")

    assert entry.date_time == (2026, 3, 4, 5, 6, 8)
    assert entry.compress_type == zipfile.ZIP_DEFLATED
    assert entry.compress_size < entry.file_size // 2
    # The reason the entry is hand-built in the first place, and the thing a future edit here could
    # quietly drop while fixing something else.
    assert (entry.external_attr >> 16) & 0o777 == 0o755
    # The members added by name were never affected, and are asserted so a change to how the archive is
    # opened cannot silently take them with it.
    assert readme.compress_type == zipfile.ZIP_DEFLATED
