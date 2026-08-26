"""Path resolution in a packaged build, which a checkout can never demonstrate.

Every assertion here is about the difference between two roots that are the same directory in a
checkout, so nothing in the ordinary test run would notice if they were confused. `sys.frozen` and
`sys._MEIPASS` are what PyInstaller sets, and simulating them is the only way to exercise the split
short of building a binary.

The two mistakes being guarded are opposites, and both present as data loss rather than as an error:
resources looked for beside the executable (where a onefile build has none), and databases written into
the unpacked bundle (which is deleted when the process exits).

The distribution form is the same kind of problem one level up. Portable and installed builds are the
same binary and differ only in where writable data defaults to, so the answer is declared at build time
and every branch that reads it — including all three per-OS user-data directories — is reachable from
any one platform only by faking `sys.platform`.
"""

import os
import sys
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest import mock

from backend import app_config, runtime_config


@contextmanager
def _frozen(exe_dir: Path, bundle_dir: Path, *, form: str | None = None, platform: str | None = None):
    """Stand in for a PyInstaller onefile build: the executable in one place, the unpacked resources in
    a temporary directory somewhere else entirely.

    `form` writes the declaration a real build bakes into its bundle; omitting it stands in for a build
    that carries none. `platform` fakes the OS, which is the only way one machine can exercise the other
    two branches."""
    if form is not None:
        (bundle_dir / runtime_config.DIST_FORM_FILENAME).write_text(f"{form}\n", encoding="utf-8")
    with ExitStack() as stack:
        stack.enter_context(mock.patch.object(sys, "frozen", True, create=True))
        stack.enter_context(mock.patch.object(sys, "_MEIPASS", str(bundle_dir), create=True))
        stack.enter_context(mock.patch.object(sys, "executable", str(exe_dir / "luma")))
        if platform is not None:
            stack.enter_context(mock.patch.object(sys, "platform", platform))
        yield


@contextmanager
def _env(**values: str | None):
    """Set, or with None unset, environment variables for the block. Clearing matters as much as
    setting: the developer's own `.env` is already loaded into `os.environ` by the time tests run, so a
    test of default behavior has to say which variables must be absent."""
    original = {key: os.environ.get(key) for key in values}
    try:
        for key, value in values.items():
            os.environ.pop(key, None) if value is None else os.environ.__setitem__(key, value)
        yield
    finally:
        for key, value in original.items():
            os.environ.pop(key, None) if value is None else os.environ.__setitem__(key, value)


@contextmanager
def _home(path: Path):
    """A fake home directory. The per-OS defaults are built from it, and the real one differs per
    machine, so asserting against it is the only way the expectations can be literal."""
    with mock.patch.object(Path, "home", classmethod(lambda cls: path)):
        yield


# Cleared for any test asserting a *default*, since each of these outranks one.
_NO_OVERRIDES = {
    "DATA_DIR": None,
    "DB_PATH": None,
    "CONTROL_DB_PATH": None,
    "LUMA_ENV_FILE": None,
    "XDG_DATA_HOME": None,
    "LOCALAPPDATA": None,
}


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
    written there is gone the moment the app is closed.

    The per-file overrides are cleared rather than left alone: each of them wins over the directory
    setting this is about, so a developer whose own environment names one would see this fail for a
    reason that has nothing to do with the two roots."""
    with _two_roots() as (install, bundle), _frozen(install, bundle), \
         _env(**{**_NO_OVERRIDES, "DATA_DIR": "."}):
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


# ── Distribution form ────────────────────────────────────────────────────────────────────────────


def test_a_checkout_is_neither_portable_nor_installed():
    """A working copy is recognized rather than declared, and keeps the working-directory default every
    existing install already depends on."""
    with _env(**_NO_OVERRIDES):
        assert runtime_config.distribution_form() == runtime_config.DIST_FORM_CHECKOUT
        assert runtime_config.default_data_dir() == runtime_config.DEFAULT_DATA_DIR


def test_a_build_reads_the_form_it_was_built_with():
    for form in sorted(runtime_config.DECLARABLE_DIST_FORMS):
        with _two_roots() as (install, bundle), _frozen(install, bundle, form=form):
            assert runtime_config.distribution_form() == form


def test_an_undeclared_build_falls_back_to_what_the_platform_supports():
    """macOS cannot support the portable form at all, so the guess follows the platform rather than
    being a fixed default — guessing portable there would write into the `.app`."""
    for platform, expected in (
        ("linux", runtime_config.DIST_FORM_PORTABLE),
        ("win32", runtime_config.DIST_FORM_PORTABLE),
        ("darwin", runtime_config.DIST_FORM_INSTALLED),
    ):
        with _two_roots() as (install, bundle), _frozen(install, bundle, platform=platform):
            assert runtime_config.distribution_form() == expected


def test_an_unrecognized_declaration_is_not_trusted():
    with _two_roots() as (install, bundle), _frozen(install, bundle, form="beside-the-executable"):
        assert runtime_config.distribution_form() == runtime_config.DIST_FORM_PORTABLE


# ── Where each form keeps its data ───────────────────────────────────────────────────────────────


def test_a_portable_build_needs_no_configuration_to_land_beside_itself():
    """The portable zip ships no `.env`, so this default is the whole mechanism."""
    portable = runtime_config.DIST_FORM_PORTABLE
    with _two_roots() as (install, bundle), _frozen(install, bundle, form=portable), _env(**_NO_OVERRIDES):
        assert runtime_config.default_data_dir() == runtime_config.DEFAULT_DATA_DIR
        assert Path(runtime_config.resolve_db_path()).parent.resolve() == install
        assert Path(runtime_config.resolve_control_db_path()).parent.resolve() == install


def test_an_installed_build_uses_the_per_os_user_data_directory():
    installed = runtime_config.DIST_FORM_INSTALLED
    with tempfile.TemporaryDirectory() as home_dir:
        home = Path(home_dir).resolve()
        expected = {
            "win32": home / "AppData" / "Local" / "Luma",
            "darwin": home / "Library" / "Application Support" / "Luma",
            "linux": home / ".local" / "share" / "luma",
        }
        for platform, directory in expected.items():
            with _two_roots() as (install, bundle), \
                 _frozen(install, bundle, form=installed, platform=platform), \
                 _env(**_NO_OVERRIDES), _home(home):
                assert runtime_config.user_data_dir() == directory
                assert runtime_config.data_dir() == directory
                assert Path(runtime_config.resolve_db_path()) == directory / runtime_config.DB_FILENAME


def test_the_platform_variable_for_relocating_a_profile_is_honored():
    """Someone who has moved their profile has already answered this question once."""
    installed = runtime_config.DIST_FORM_INSTALLED
    with tempfile.TemporaryDirectory() as elsewhere_dir, tempfile.TemporaryDirectory() as home_dir:
        elsewhere = Path(elsewhere_dir).resolve()
        home = Path(home_dir).resolve()
        with _two_roots() as (install, bundle), \
             _frozen(install, bundle, form=installed, platform="win32"), \
             _env(**{**_NO_OVERRIDES, "LOCALAPPDATA": str(elsewhere)}), _home(home):
            assert runtime_config.user_data_dir() == elsewhere / "Luma"
        with _two_roots() as (install, bundle), \
             _frozen(install, bundle, form=installed, platform="linux"), \
             _env(**{**_NO_OVERRIDES, "XDG_DATA_HOME": str(elsewhere)}), _home(home):
            assert runtime_config.user_data_dir() == elsewhere / "luma"


def test_a_relative_xdg_data_home_is_ignored():
    """The spec says to ignore one, and it matters here: a relative value would put the databases
    wherever the app happened to be started from, which for a desktop launch is arbitrary."""
    installed = runtime_config.DIST_FORM_INSTALLED
    with tempfile.TemporaryDirectory() as home_dir:
        home = Path(home_dir).resolve()
        with _two_roots() as (install, bundle), \
             _frozen(install, bundle, form=installed, platform="linux"), \
             _env(**{**_NO_OVERRIDES, "XDG_DATA_HOME": "share"}), _home(home):
            assert runtime_config.user_data_dir() == home / ".local" / "share" / "luma"


def test_a_configured_data_dir_still_outranks_the_installed_default():
    """The per-OS directory is a default, not a policy — the environment layer wins as it does
    everywhere else."""
    installed = runtime_config.DIST_FORM_INSTALLED
    with tempfile.TemporaryDirectory() as chosen_dir, tempfile.TemporaryDirectory() as home_dir:
        chosen = Path(chosen_dir).resolve()
        with _two_roots() as (install, bundle), \
             _frozen(install, bundle, form=installed, platform="darwin"), \
             _env(**{**_NO_OVERRIDES, "DATA_DIR": str(chosen)}), _home(Path(home_dir).resolve()):
            assert runtime_config.data_dir() == chosen


# ── Where each form keeps its `.env` ─────────────────────────────────────────────────────────────


def test_an_installed_build_keeps_its_env_file_in_the_user_data_directory():
    """Its install root is inside the `.app` on macOS, which an upgrade replaces wholesale. Resolved
    from `user_data_dir` rather than `data_dir` because this file is one of the things that may set
    `DATA_DIR`."""
    installed = runtime_config.DIST_FORM_INSTALLED
    with tempfile.TemporaryDirectory() as home_dir, tempfile.TemporaryDirectory() as chosen_dir:
        home = Path(home_dir).resolve()
        support = home / "Library" / "Application Support" / "Luma"
        with _two_roots() as (install, bundle), \
             _frozen(install, bundle, form=installed, platform="darwin"), \
             _env(**{**_NO_OVERRIDES, "DATA_DIR": chosen_dir}), _home(home):
            assert runtime_config.env_file_path() == support / ".env"


def test_a_portable_build_keeps_its_env_file_beside_the_executable():
    portable = runtime_config.DIST_FORM_PORTABLE
    with _two_roots() as (install, bundle), _frozen(install, bundle, form=portable), _env(**_NO_OVERRIDES):
        assert runtime_config.env_file_path() == install / ".env"


# ── What the configuration report claims ─────────────────────────────────────────────────────────


def test_the_report_shows_the_directory_a_packaged_build_actually_uses():
    """Resolving the relative default against the working directory would have the Settings page name a
    path the app is not using — and something launched from a file manager has an arbitrary one."""
    portable = runtime_config.DIST_FORM_PORTABLE
    with _two_roots() as (install, bundle), _frozen(install, bundle, form=portable):
        assert app_config._absolute_display(runtime_config.DEFAULT_DATA_DIR) == str(install)
