"""Build-script behavior that only misbehaves on a platform the developer is not on.

`scripts/` is a directory of standalone scripts rather than a package, so the module under test is
loaded by path. It is worth testing anyway: every bug found here so far has been Windows-only, which
means the feedback loop is a round trip through someone else's machine unless the decision is pinned
down by a test that can run anywhere.
"""

import importlib.util
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
