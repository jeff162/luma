#!/usr/bin/env python3
"""Launch a built artifact and prove its data landed where that distribution form promises.

This is the check no unit test can make. `backend/tests/test_packaged_paths.py` proves the *resolution*
by faking `sys.frozen` and `sys.platform`; what it cannot prove is that the build-time declaration
survived into the artifact, that the frozen binary can read it back, or that the application then
creates its databases there. Those three only fail once packaged, and they fail quietly: an app that
starts normally while writing its data somewhere nobody looks.

Deliberately standalone — it imports nothing from `backend/`. The expected locations are restated here
rather than derived from `runtime_config`, because a check that asks the code under test where it
should have written the file cannot fail. Restating them is the whole point, and the duplication is
load-bearing rather than accidental.

The environment is made self-contained rather than inherited: a fake home (and `%LOCALAPPDATA%` on Windows)
means the assertion is against a known path and the run leaves nothing behind on the machine.

On macOS the artifact is a `.dmg` rather than a zip, and it is installed the way a person would — the
image is mounted, the bundle copied off it, and the image unmounted — before anything is launched. What
is launched there is the *server* inside the bundle rather than the bundle itself: the native wrapper is
a Dock application, and the half of it worth automating is the half that answers HTTP.

    python scripts/smoke_artifact.py --form portable
    python scripts/smoke_artifact.py --form installed
"""

import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"

# Loopback by address, not by name. `localhost` can resolve to `::1` first — notably on the Windows
# runners — while the launcher binds `127.0.0.1`, which would present as the app never starting.
HEALTH_HOST = "127.0.0.1"
# Not the default port: a smoke run should fail because the artifact is broken, not because something
# else on the machine already holds 8010. The launcher falls back to an ephemeral port when its
# configured one is busy, so a collision here would look like a timeout rather than a conflict.
SMOKE_PORT = 8765
STARTUP_TIMEOUT_SECONDS = 120.0
SHUTDOWN_TIMEOUT_SECONDS = 30.0

DB_FILENAMES = ("luma-data.db", "luma-control.db")
LOCK_FILENAME = "luma-desktop.lock"
# What `backend/main.py` prints when it cannot hand TLS verification to the operating system. Matched as
# a substring rather than imported, to keep this script independent of the code it is testing.
TRUST_STORE_FAILURE = "Could not use the system certificate store"

FORMS = ("portable", "installed")
# The form this platform ships, which is the one whose artifact carries no form in its name. Stated
# here rather than imported for the same reason the expected directories are — see the module docstring.
RELEASE_FORM = "installed" if sys.platform == "darwin" else "portable"


def _form_of(artifact: Path) -> str:
    """Which form an artifact holds, read from its name. Only a build that is *not* this platform's
    release form says so in the filename, so anything unmarked is the release form."""
    for form in FORMS:
        if artifact.stem.endswith(f"-{form}"):
            return form
    return RELEASE_FORM


def _archive_for(form: str) -> Path:
    """The one artifact of this form in `dist/`. Ambiguity is an error rather than a guess — picking the
    newest would silently smoke-test yesterday's build after today's failed."""
    artifacts = sorted([*DIST_DIR.glob("luma-*.zip"), *DIST_DIR.glob("luma-*.dmg")])
    wanted = [path for path in artifacts if _form_of(path) == form]
    if not wanted:
        raise SystemExit(f"No {form} artifact in {DIST_DIR} — build one first.")
    if len(wanted) > 1:
        listed = "\n".join(f"  {path.name}" for path in wanted)
        raise SystemExit(f"More than one {form} artifact in {DIST_DIR}:\n{listed}")
    return wanted[0]


def _unpack(archive: Path, into: Path) -> Path:
    return _unpack_disk_image(archive, into) if archive.suffix == ".dmg" else _unpack_zip(archive, into)


def _unpack_disk_image(image: Path, into: Path) -> Path:
    """Mount the image, copy the bundle off it, and unmount — which is what dragging it to Applications
    does, and is the state the application actually has to run in. Running it from the mounted image
    instead would test a read-only location nobody installs to."""
    mount = into / "mounted"
    mount.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["hdiutil", "attach", str(image), "-nobrowse", "-readonly", "-mountpoint", str(mount)],
        check=True, capture_output=True, text=True,
    )
    try:
        bundles = sorted(mount.glob("*.app"))
        if len(bundles) != 1:
            raise SystemExit(f"Expected exactly one .app in {image.name}, found {len(bundles)}.")
        if not (mount / "Applications").is_symlink():
            raise SystemExit(f"{image.name} has no Applications symlink, so it cannot be drag-installed.")
        installed = into / bundles[0].name
        # `symlinks=True` for the same reason the build uses it: the bundle links Resources and
        # Frameworks at each other, and flattening those breaks the paths resolved at startup.
        shutil.copytree(bundles[0], installed, symlinks=True)
    finally:
        subprocess.run(["hdiutil", "detach", str(mount)], check=False, capture_output=True)

    # `Contents/MacOS` holds the native wrapper that macOS launches; the server it supervises lives in
    # `Contents/Resources/server`. Both are checked, since a bundle missing either is broken in a way
    # that would otherwise surface only on someone's desktop.
    wrapper = installed / "Contents" / "MacOS" / "Luma"
    if not wrapper.is_file():
        raise SystemExit(f"No application wrapper at {wrapper} — the bundle layout is wrong.")
    if not (installed / "Contents" / "Info.plist").is_file():
        raise SystemExit(f"No Info.plist in {installed} — macOS would refuse to launch this.")

    # The *server* is what gets launched here, not the wrapper. Driving a Dock application from CI would
    # test the part that cannot be automated while skipping the part that can, and running the server
    # directly is also what leaves its output on the pipe this harness reads.
    executable = installed / "Contents" / "Resources" / "server" / "luma"
    if not executable.is_file():
        raise SystemExit(f"No server executable at {executable} — the bundle layout is wrong.")
    executable.chmod(executable.stat().st_mode | 0o755)
    return executable


def _unpack_zip(archive: Path, into: Path) -> Path:
    """Unpack, and check the executable bit was recorded on the way in.

    `ZipFile.extract` drops permissions, so the bit has to be read from the entry and reapplied — which
    also makes this the only place the zip's own mode is ever looked at. A portable build whose binary
    arrives without it is one `chmod` away from working, with nothing to say so."""
    with zipfile.ZipFile(archive) as bundle:
        entries = [info for info in bundle.infolist() if not info.is_dir()]
        bundle.extractall(into)

    executables = [info for info in entries if Path(info.filename).name in ("luma", "luma.exe")]
    if len(executables) != 1:
        raise SystemExit(f"Expected exactly one executable in {archive.name}, found {len(executables)}.")
    entry = executables[0]

    if not entry.external_attr >> 16 & 0o111:
        raise SystemExit(
            f"{entry.filename} carries no executable bit in {archive.name}; "
            "it would need a chmod before it could run."
        )

    executable = into / entry.filename
    executable.chmod(executable.stat().st_mode | 0o755)
    return executable


def _expected_data_dir(form: str, executable: Path, home: Path, local_appdata: Path) -> Path:
    """Where this form must have put its databases. Restated rather than imported — see the module
    docstring."""
    if form == "portable":
        return executable.parent
    if sys.platform == "win32":
        return local_appdata / "Luma"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Luma"
    return home / ".local" / "share" / "luma"


def _environment(home: Path, local_appdata: Path) -> dict[str, str]:
    """A self-contained environment. Every layer that outranks the built-in default is cleared, since
    the built-in default is the thing under test, and the home directory is redirected so the run
    asserts against a known path and leaves nothing behind."""
    # FRONTEND_PORT because the launcher serves the browser on it; BACKEND_PORT is ignored by this build.
    env = {**os.environ, "FRONTEND_PORT": str(SMOKE_PORT)}
    for key in ("DATA_DIR", "DB_PATH", "CONTROL_DB_PATH", "LUMA_ENV_FILE", "XDG_DATA_HOME", "APPDATA"):
        env.pop(key, None)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    env["LOCALAPPDATA"] = str(local_appdata)
    return env


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((HEALTH_HOST, port))
        except OSError:
            return False
    return True


def _wait_for_health(process: subprocess.Popen) -> bool:
    url = f"http://{HEALTH_HOST}:{SMOKE_PORT}/api/health"
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=2.0) as response:
                if response.status == 200:
                    return True
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.5)
    return False


def _stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)


def _report_failure(reason: str, log: Path, data_dir: Path) -> None:
    print(f"\nSmoke test failed: {reason}", file=sys.stderr)
    lock = data_dir / LOCK_FILENAME
    if lock.is_file():
        # The launcher records the port it actually took. A different one here means the configured
        # port was busy and it fell back, which otherwise reads as the app having failed to start.
        print(f"  {LOCK_FILENAME} records port {lock.read_text().strip()}", file=sys.stderr)
    if log.is_file():
        print(f"\n--- application output ({log}) ---", file=sys.stderr)
        print(log.read_text(errors="replace").strip() or "(nothing)", file=sys.stderr)


def smoke(form: str) -> int:
    archive = _archive_for(form)
    print(f"Smoke testing {archive.name} ({form} form)")

    if not _port_is_free(SMOKE_PORT):
        raise SystemExit(f"Port {SMOKE_PORT} is already in use; the launcher would fall back to another.")

    workspace = Path(tempfile.mkdtemp(prefix="luma-smoke-"))
    try:
        unpacked = workspace / "unpacked"
        home = workspace / "home"
        local_appdata = home / "AppData" / "Local"
        local_appdata.mkdir(parents=True)

        executable = _unpack(archive, unpacked)
        expected = _expected_data_dir(form, executable, home, local_appdata)
        log = workspace / "output.log"

        print(f"  executable: {executable}")
        print(f"  expecting data in: {expected}")

        with log.open("w") as sink:
            process = subprocess.Popen(
                [str(executable), "--no-browser"],
                # Deliberately not the directory the executable is in. A portable build has to resolve
                # its data against itself rather than against wherever it was started from, which is
                # the whole point of anchoring — and something launched from a file manager gets an
                # arbitrary working directory anyway.
                cwd=workspace,
                env=_environment(home, local_appdata),
                stdout=sink,
                stderr=subprocess.STDOUT,
            )

        try:
            if not _wait_for_health(process):
                exited = f" (exited {process.returncode})" if process.poll() is not None else ""
                _report_failure(f"no healthy response within {STARTUP_TIMEOUT_SECONDS:.0f}s{exited}",
                                log, expected)
                return 1

            # The packaged build has to be able to verify TLS, and the way that broke once was silent:
            # the app started normally and every outbound HTTPS call failed later, in the field. The
            # bootstrap says so on stderr when it cannot use the system trust store, and both streams
            # are already captured here, so this costs nothing and needs no network call.
            if TRUST_STORE_FAILURE in log.read_text(errors="replace"):
                _report_failure("the packaged build could not use the system certificate store",
                                log, expected)
                return 1

            missing = [name for name in DB_FILENAMES if not (expected / name).is_file()]
            if missing:
                found = sorted(str(path) for path in workspace.rglob("*.db"))
                _report_failure(
                    f"{', '.join(missing)} not in {expected}. Databases found: {found or 'none'}",
                    log, expected,
                )
                return 1

            if form == "installed":
                # The opposite mistake, and the one macOS cannot survive: data written beside the
                # executable, which for a `.app` is inside the bundle.
                beside = sorted(path.name for path in executable.parent.glob("*.db"))
                if beside:
                    _report_failure(
                        f"an installed build wrote {', '.join(beside)} beside its executable", log, expected
                    )
                    return 1
        finally:
            _stop(process)

        print(f"  both databases present in {expected}")
        print("Smoke test passed.")
        return 0
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Launch a built Luma artifact and assert where it put its databases.",
    )
    parser.add_argument(
        "--form",
        choices=("portable", "installed"),
        required=True,
        help="Which form's artifact in dist/ to test, and therefore where its data must land.",
    )
    return smoke(parser.parse_args().form)


if __name__ == "__main__":
    raise SystemExit(main())
