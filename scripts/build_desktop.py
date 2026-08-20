#!/usr/bin/env python3
"""Build the standalone desktop artifact: one executable, plus the portable zip it ships in.

The output is deliberately *portable* rather than installed. A portable copy keeps its databases beside
the executable, which is what `runtime_config.anchor_relative` arranges in a frozen build — so the zip
carries no configuration file at all and the default behavior is already correct. The installed form,
with a per-OS user-data directory, is a later step and is what would need a build-time signal to tell
the two apart.

Nothing here signs anything. An unsigned artifact carries an OS warning on first run, and someone who
downloads one is choosing that; paying for certificates is a separate decision from being able to build.

Run from anywhere: `python scripts/build_desktop.py [--skip-frontend]`.
"""

import argparse
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import runtime_config  # noqa: E402  (needs ROOT on the path first)

SPEC = ROOT / "scripts" / "luma.spec"
BUILD_DIR = ROOT / "build" / "pyinstaller"
DIST_DIR = ROOT / "dist"

READ_ME = """Luma — portable build

Run the `luma` executable. It starts the application, prints its address, and opens a browser at it.
Press Ctrl+C in the terminal window to stop it.

Data lives in this folder, in luma-data.db and luma-control.db, and stays here when the application is
closed. Moving or copying this whole folder moves the data with it.

Options:
  --no-browser    start without opening a browser, and just print the address

This build is unsigned, so the operating system will warn about it the first time it runs.
"""


def _run(command: list[str], cwd: Path) -> None:
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def _version() -> str:
    """The same constant the running app reports, so an artifact can never be named for one version and
    report another."""
    return runtime_config.APP_VERSION


def _platform_tag() -> str:
    system = {"darwin": "macos"}.get(platform.system().lower(), platform.system().lower())
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
    return f"{system}-{arch}"


def _is_windows() -> bool:
    return platform.system().lower() == "windows"


def _npm() -> str:
    """Locate npm in a form `CreateProcess` can actually start.

    Node ships two things called npm on Windows: `npm.cmd`, the batch wrapper Windows can execute, and
    an extensionless `npm` shell script for Git Bash. `shutil.which("npm")` can return the latter, and
    launching it fails with `WinError 193: %1 is not a valid Win32 application` — an error that names
    nothing recognizable. Asking for the executable extensions by name is what avoids it.
    """
    for candidate in (["npm.cmd", "npm.exe", "npm"] if _is_windows() else ["npm"]):
        found = shutil.which(candidate)
        if found:
            return found
    raise SystemExit("npm was not found on PATH — needed to build the frontend bundle.")


def _build_frontend() -> None:
    npm = _npm()

    frontend = ROOT / "frontend"
    if not (frontend / "node_modules").is_dir():
        # A fresh clone has no node_modules, and `npm run build` there fails with "vite: not found" —
        # which points at the build tool rather than at the missing install. `npm ci` rather than
        # `npm install` because it installs exactly the lockfile, which is what a release wants.
        _run([npm, "ci"], cwd=frontend)

    _run([npm, "run", "build"], cwd=frontend)


def _build_executable() -> Path:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        raise SystemExit(
            "PyInstaller is not installed in this interpreter. Install it with:\n"
            f"    {sys.executable} -m pip install pyinstaller"
        )

    _run(
        [
            sys.executable, "-m", "PyInstaller",
            "--noconfirm",
            # Not `--onefile`: with a spec file the layout is the spec's business, and passing it is a
            # hard error. `luma.spec` folds the binaries and data into EXE with no COLLECT, which *is*
            # onefile.
            "--distpath", str(DIST_DIR / "bin"),
            "--workpath", str(BUILD_DIR),
            str(SPEC),
        ],
        cwd=ROOT,
    )

    name = "luma.exe" if _is_windows() else "luma"
    built = DIST_DIR / "bin" / name
    if not built.is_file():
        raise SystemExit(f"PyInstaller reported success but produced no {built}.")
    return built


def _package(executable: Path) -> Path:
    archive = DIST_DIR / f"luma-{_version()}-{_platform_tag()}.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.unlink(missing_ok=True)

    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        info = zipfile.ZipInfo(f"luma/{executable.name}")
        # The executable bit does not survive a plain `zipfile.write`, and a portable build whose binary
        # arrives without it is one chmod away from working with no indication of why.
        info.external_attr = 0o755 << 16
        bundle.writestr(info, executable.read_bytes())
        bundle.writestr("luma/README.txt", READ_ME)

    return archive


def build(skip_frontend: bool = False) -> Path:
    """Build the artifact and return its path. The entry point `release.py` uses, so the two cannot
    disagree about where the zip lands or what it is called."""
    if skip_frontend:
        if not (ROOT / "frontend" / "dist" / "index.html").is_file():
            raise SystemExit("--skip-frontend was given but frontend/dist holds no build.")
    else:
        _build_frontend()

    return _package(_build_executable())


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the standalone Luma executable and portable zip.")
    parser.add_argument(
        "--skip-frontend",
        action="store_true",
        help="Reuse the existing frontend/dist instead of rebuilding it.",
    )
    args = parser.parse_args()

    archive = build(skip_frontend=args.skip_frontend)
    size_mb = archive.stat().st_size / (1024 * 1024)
    print(f"\nBuilt {archive.relative_to(ROOT)} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
