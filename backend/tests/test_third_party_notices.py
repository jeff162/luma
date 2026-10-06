"""What a kit says about the software it carries.

Two things decide whether those notices are right, and neither is visible in the file they produce: the
set of distributions it walks (too narrow silently drops a licensor, too wide credits software the kit
does not ship), and what it does when a distribution has no license text to reproduce. Both are asserted
here rather than left to a reading of the generated file, which is 400 KB of license boilerplate nobody
is going to diff.
"""

import importlib.util
import os
import sys
import sysconfig
from pathlib import Path
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

spec = importlib.util.spec_from_file_location("third_party_notices_under_test", REPO_ROOT / "scripts" / "third_party_notices.py")
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


def _names():
    return {dist.metadata["Name"].lower() for dist in notices.runtime_distributions()}


def test_the_closure_reaches_dependencies_no_requirement_file_names():
    """`h11` is nobody's stated requirement here — uvicorn pulls it in — and it is frozen into the kit
    like everything else. A list that only walked requirements.txt would leave it, and most of what it
    carries, uncredited."""
    assert {"h11", "starlette", "pycparser"} <= _names()


def test_a_development_dependency_is_not_credited():
    """pytest is installed in the environment doing the build and reaches no kit, which is the whole
    reason the closure is walked from the runtime requirements rather than from what is installed."""
    assert "pytest" not in _names()


def test_a_distribution_with_no_license_text_stops_the_build(tmp_path):
    """The failure mode this exists to prevent is silent: a wheel that ships no license file would
    otherwise be summarized by its metadata line and credited with nothing. `nulltype` is the real case,
    and it is answered by a supplied text — with the supplements taken away, it has to stop the build."""
    with mock.patch.object(notices, "SUPPLEMENT_DIR", tmp_path), \
         mock.patch.object(notices, "license_texts", return_value=[]):
        with pytest.raises(SystemExit) as refusal:
            notices.server_notices()
    assert "scripts/license-texts" in str(refusal.value)


def test_a_supplied_text_carries_the_note_saying_where_it_came_from():
    """A license text this repository supplies rather than one the package shipped is a claim about the
    package, so the reader is told which it is reading and where it was taken from."""
    supplied = notices.supplement_text("nulltype")
    assert supplied is not None
    assert "apache.org/licenses/LICENSE-2.0.txt" in supplied
    assert "Apache License" in supplied


def test_the_notices_carry_python_and_every_distribution():
    text = notices.server_notices()
    assert "PYTHON SOFTWARE FOUNDATION LICENSE" in text
    for name in _names():
        assert name.lower() in text.lower(), name


def test_the_combined_file_keeps_both_halves():
    """One file, because a recipient looking for a package's license does not know which half of the
    application it belongs to."""
    combined = notices.combined_notices("Third-party software in the Luma web interface\n\nreact 18.3.1\n")
    assert "react 18.3.1" in combined
    assert "Third-party software in the Luma server" in combined
    assert "GNU AGPL" in combined.splitlines()[2]


# --- the shared libraries a Linux build copies off the machine that made it -------------------------

BINARY = ("libz.so.1", "/usr/lib/x86_64-linux-gnu/libz.so.1.2.11", "BINARY")
# Built from the *running* interpreter's standard library, because that is what "inside the Python
# installation" means to the code under test. A literal path is only that on a distribution's own Python;
# CI runs one unpacked under /opt, where a hard-coded /usr/lib/python3.12 reads as a system library.
EXTENSION = (
    "_ssl.cpython-312-x86_64-linux-gnu.so",
    str(Path(sysconfig.get_paths()["stdlib"]) / "lib-dynload" / "_ssl.so"),
    "EXTENSION",
)

# The interpreter's own shared library where a relocatable Python keeps it: outside every tree the
# installation is identified by, and part of no package the build machine could name. The layout CI builds
# on, which is where this last escaped and stopped a release build.
RUNTIME = (
    "libpython",
    f"/opt/python/3.12/lib/{Path(sysconfig.get_config_var('INSTSONAME') or 'libpython3.so').name}",
    "BINARY",
)


def test_only_libraries_from_outside_the_python_installation_count():
    """An extension module shipped with Python or inside a wheel is already covered by that entry; what
    needs attributing is what came from the system, which nothing else in the kit accounts for. The
    interpreter's own library is Python too, wherever the installation happens to keep it."""
    found = notices._system_library_paths([BINARY, EXTENSION, RUNTIME])
    assert [p.name for p in found] == ["libz.so.1.2.11"]


def test_a_windows_build_counts_the_whole_python_installation_as_python():
    """Asserted from any platform, because the build it protects only ever runs on one. Windows keeps
    `python3xx.dll` and the OpenSSL, SQLite and libffi it links against at the installation root and in
    `DLLs`, outside the four directories that identify the installation everywhere else — and with no
    package manager to name them, every one of them stopped the Windows release build. The same prefix is
    `/usr` on a system Python, which is why it is added there and nowhere else."""
    installation = os.path.normcase(str(Path(sys.base_prefix).resolve()))
    assert installation in notices._python_trees("win32")
    assert installation not in notices._python_trees("linux")


def test_each_library_is_credited_to_the_package_that_installed_it():
    with mock.patch.object(notices, "_owning_package", return_value="zlib1g"), \
         mock.patch.object(notices, "_package_copyright", return_value="Copyright: 1995-2024 Jean-loup Gailly"):
        text = notices.native_library_notices([BINARY])
    assert "zlib1g" in text
    assert "Provides: libz.so.1.2.11" in text
    assert "Jean-loup Gailly" in text


def test_a_library_nothing_can_name_stops_the_build():
    """A system library carries no metadata of its own, so one that slipped through would leave no trace
    in the finished kit of having been missed — the build is the only place it can still be caught."""
    with mock.patch.object(notices, "_owning_package", return_value=None):
        with pytest.raises(SystemExit) as refusal:
            notices.native_library_notices([BINARY])
    assert "libz.so.1.2.11" in str(refusal.value)


def test_a_package_with_no_copyright_file_stops_the_build_too():
    with mock.patch.object(notices, "_owning_package", return_value="zlib1g"), \
         mock.patch.object(notices, "_package_copyright", return_value=None):
        with pytest.raises(SystemExit):
            notices.native_library_notices([BINARY])


def test_a_build_with_no_collected_libraries_says_nothing():
    """macOS links the system's frameworks rather than copying them, and Windows takes its libraries from
    a Python whose own license file lists them, so both leave this section out entirely."""
    assert notices.native_library_notices([]) == ""
    assert "shared libraries" not in notices.combined_notices("web\n", binaries=[])

