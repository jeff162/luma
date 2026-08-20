"""Path resolution in a packaged build, which a checkout can never demonstrate.

Every assertion here is about the difference between two roots that are the same directory in a
checkout, so nothing in the ordinary test run would notice if they were confused. `sys.frozen` and
`sys._MEIPASS` are what PyInstaller sets, and simulating them is the only way to exercise the split
short of building a binary.

The two mistakes being guarded are opposites, and both present as data loss rather than as an error:
resources looked for beside the executable (where a onefile build has none), and databases written into
the unpacked bundle (which is deleted when the process exits).
"""

import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend import runtime_config


@contextmanager
def _frozen(exe_dir: Path, bundle_dir: Path):
    """Stand in for a PyInstaller onefile build: the executable in one place, the unpacked resources in
    a temporary directory somewhere else entirely."""
    with mock.patch.object(sys, "frozen", True, create=True), \
         mock.patch.object(sys, "_MEIPASS", str(bundle_dir), create=True), \
         mock.patch.object(sys, "executable", str(exe_dir / "luma")):
        yield


@contextmanager
def _two_roots():
    with tempfile.TemporaryDirectory() as install, tempfile.TemporaryDirectory() as bundle:
        yield Path(install).resolve(), Path(bundle).resolve()


def test_the_two_roots_are_the_same_place_in_a_checkout():
    assert runtime_config.is_frozen() is False
    assert runtime_config.bundle_root() == runtime_config.install_root()


def test_a_packaged_build_separates_resources_from_the_install():
    with _two_roots() as (install, bundle), _frozen(install, bundle):
        assert runtime_config.is_frozen() is True
        assert runtime_config.bundle_root() == bundle
        assert runtime_config.install_root() == install


def test_the_frontend_is_read_from_the_bundle():
    """Beside the executable there is no `frontend/dist` in a onefile build — the SPA would silently
    fail to mount and the app would serve nothing but its API."""
    from backend import spa

    with _two_roots() as (install, bundle), _frozen(install, bundle):
        assert spa.dist_dir() == bundle / "frontend" / "dist"


def test_databases_and_env_sit_beside_the_executable():
    """The counterpart mistake: the bundle directory is deleted when the process exits, so a database
    written there is gone the moment the app is closed."""
    with _two_roots() as (install, bundle), _frozen(install, bundle):
        with mock.patch.dict("os.environ", {"DATA_DIR": "."}, clear=False):
            assert runtime_config.data_dir() == install / "."
            assert Path(runtime_config.resolve_db_path()).parent.resolve() == install
            assert Path(runtime_config.resolve_control_db_path()).parent.resolve() == install

        assert runtime_config.env_file_path() == install / ".env"


def test_a_relative_per_file_override_is_anchored_too():
    with _two_roots() as (install, bundle), _frozen(install, bundle):
        with mock.patch.dict("os.environ", {"DB_PATH": "ledger.db"}, clear=False):
            assert Path(runtime_config.resolve_db_path()) == install / "ledger.db"


def test_an_absolute_setting_is_left_alone():
    with _two_roots() as (install, bundle), _frozen(install, bundle):
        elsewhere = Path(tempfile.gettempdir()).resolve() / "luma-elsewhere"
        with mock.patch.dict("os.environ", {"DATA_DIR": str(elsewhere)}, clear=False):
            assert runtime_config.data_dir() == elsewhere


def test_a_checkout_keeps_resolving_relative_settings_against_the_working_directory():
    """The compatibility guarantee: anchoring is a packaged-build behavior only. Applying it to a
    checkout would relocate the databases of every existing install running a relative `DATA_DIR`."""
    with mock.patch.dict("os.environ", {"DATA_DIR": "testing"}, clear=False):
        assert runtime_config.data_dir() == Path("testing")
