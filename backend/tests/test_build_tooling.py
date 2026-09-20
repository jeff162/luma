"""Build-script behavior that only misbehaves on a platform the developer is not on.

`scripts/` is a directory of standalone scripts rather than a package, so the module under test is
loaded by path. It is worth testing anyway: every bug found here so far has been Windows-only, which
means the feedback loop is a round trip through someone else's machine unless the decision is pinned
down by a test that can run anywhere.
"""

import importlib.util
import os
import sys
import tarfile
import zipfile
from datetime import datetime
from pathlib import Path
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _load_script(name):
    spec = importlib.util.spec_from_file_location(f"{name}_under_test", REPO_ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build_desktop = _load_script("build_desktop")
smoke_artifact = _load_script("smoke_artifact")


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


@pytest.fixture
def notices(tmp_path):
    """The third-party notices a kit carries. Written by the build before packaging, so packaging on its
    own — which is what these tests exercise — needs one put in place."""
    path = tmp_path / "THIRD-PARTY-LICENSES.txt"
    path.write_text("Third-party licenses\n", encoding="utf-8")
    with mock.patch.object(build_desktop, "THIRD_PARTY_NOTICES_FILE", path):
        yield path


def test_the_bundled_executable_keeps_its_date_and_its_compression(tmp_path, notices):
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
        _readme = bundle.getinfo("luma/README.txt")

    assert entry.date_time == (2026, 3, 4, 5, 6, 8)
    assert entry.compress_type == zipfile.ZIP_DEFLATED
    assert entry.compress_size < entry.file_size // 2
    # The reason the entry is hand-built in the first place, and the thing a future edit here could
    # quietly drop while fixing something else.
    assert (entry.external_attr >> 16) & 0o777 == 0o755


def test_the_shipped_env_example_is_plain_ascii():
    """It ships as a file opened outside a browser — in a terminal, on Windows under an OEM code page — so
    the rule `check_shipped_ascii.py` applies to the README holds for it too. That check reads Python
    string literals and cannot see this file, which is why it is asserted here."""
    text = build_desktop.ENV_EXAMPLE_FILE.read_bytes()
    assert text.isascii(), [line for line in text.decode("utf-8").splitlines() if not line.isascii()]


def test_the_text_members_extract_readable_and_share_the_build_date(tmp_path, notices):
    """`writestr` given a plain name supplies a mode of 0o600, so `README.txt` and `LICENSE` unpacked
    to something readable only by whoever ran the unzip — a kit extracted into a shared location, or
    by root, left the licence unreadable to the person meant to read it. They also carried the moment
    the zip was written rather than the build's, which is a smaller thing but the same asymmetry."""
    executable = tmp_path / "luma"
    executable.write_bytes(b"MZ" + b"\0" * 1000)
    built_at = datetime(2026, 3, 4, 5, 6, 8).timestamp()
    os.utime(executable, (built_at, built_at))

    with mock.patch.object(build_desktop, "DIST_DIR", tmp_path / "dist"):
        archive = build_desktop._package_zip(executable, build_desktop.DIST_FORM_PORTABLE)

    with zipfile.ZipFile(archive) as bundle:
        members = {info.filename: info for info in bundle.infolist()}

    assert set(members) == {
        "luma/luma", "luma/README.txt", "luma/LICENSE", "luma/THIRD-PARTY-LICENSES.txt",
        "luma/env_example.txt",
    }
    for name in ("luma/README.txt", "luma/LICENSE", "luma/THIRD-PARTY-LICENSES.txt", "luma/env_example.txt"):
        assert (members[name].external_attr >> 16) & 0o777 == 0o644, name
    # One build, one date across every member — so a reader cannot tell them apart by age.
    assert {info.date_time for info in members.values()} == {(2026, 3, 4, 5, 6, 8)}


@pytest.mark.parametrize("is_windows, extension", [(True, ".zip"), (False, ".tar.gz")])
def test_windows_ships_a_zip_and_linux_a_tar(tmp_path, notices, is_windows, extension):
    executable = tmp_path / "luma"
    executable.write_bytes(b"\0" * 100)

    with mock.patch.object(build_desktop, "DIST_DIR", tmp_path / "dist"), \
         mock.patch.object(build_desktop, "_is_macos", return_value=False), \
         mock.patch.object(build_desktop, "_is_windows", return_value=is_windows):
        archive = build_desktop._package(executable, build_desktop.DIST_FORM_PORTABLE)

    assert archive.name.endswith(extension)


@pytest.mark.skipif(sys.platform == "win32", reason="Windows files carry no POSIX mode to extract into")
def test_the_linux_kit_unpacks_runnable_and_readable(tmp_path, notices):
    """Why Linux ships a tar: the 0.3.0 zips recorded 0o755 on the binary and still reached a Linux
    machine unrunnable, because most extractors ignore a zip's mode. So this unpacks the archive and
    asserts what a recipient finds on disk, rather than what the headers claim."""
    executable = tmp_path / "luma"
    executable.write_bytes(b"\x7fELF" + b"\0" * 1000)
    built_at = datetime(2026, 3, 4, 5, 6, 8).timestamp()
    os.utime(executable, (built_at, built_at))

    with mock.patch.object(build_desktop, "DIST_DIR", tmp_path / "dist"):
        archive = build_desktop._package_tar(executable, build_desktop.DIST_FORM_PORTABLE)

    unpacked = tmp_path / "unpacked"
    with tarfile.open(archive) as bundle:
        members = {member.name: member for member in bundle.getmembers()}
        bundle.extractall(unpacked, filter="data")

    assert set(members) == {
        "luma", "luma/luma", "luma/README.txt", "luma/LICENSE", "luma/THIRD-PARTY-LICENSES.txt",
        "luma/env_example.txt",
    }
    assert (unpacked / "luma" / "luma").stat().st_mode & 0o777 == 0o755
    for name in ("README.txt", "LICENSE", "THIRD-PARTY-LICENSES.txt", "env_example.txt"):
        assert (unpacked / "luma" / name).stat().st_mode & 0o777 == 0o644, name
    assert {member.mtime for member in members.values()} == {int(built_at)}
    # The build machine's account stays out of the download.
    assert {(member.uname, member.gname, member.uid, member.gid) for member in members.values()} == {("", "", 0, 0)}


@pytest.mark.parametrize("filename, form", [
    ("luma-0.3.0-linux-x64.tar.gz", smoke_artifact.RELEASE_FORM),
    ("luma-0.3.0-linux-x64-installed.tar.gz", "installed"),
    ("luma-0.3.0-windows-x64.zip", smoke_artifact.RELEASE_FORM),
    ("luma-0.3.0-macos-arm64-portable.dmg", "portable"),
])
def test_the_smoke_test_reads_the_form_from_every_container_name(filename, form):
    """`Path.stem` of a `.tar.gz` ends in `.tar`, so a check on the stem reads every Linux build as the
    release form — and the installed build CI smoke-tests on Linux would be refused as a second portable
    artifact."""
    assert smoke_artifact._form_of(Path(filename)) == form
