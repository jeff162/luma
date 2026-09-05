#!/usr/bin/env python3
"""Build the standalone desktop artifact: one executable, plus the zip it ships in.

Two distribution forms come out of the same code, and which one is being built is a *decision*, not
something the running app can work out for itself:

- **portable** — a zip whose databases live beside the executable, which is what
  `runtime_config.anchor_relative` arranges in a frozen build. It carries no configuration file at all
  because the stock `DATA_DIR = "."` default already means the right thing once frozen.
- **installed** — databases in the per-OS user-data directory, for an artifact that an installer puts
  somewhere the user does not own and an upgrade replaces wholesale.

`--form` chooses, defaulting to whatever the platform can support: macOS is installed-only, since a
`.app` cannot hold its own writable data. The choice reaches the artifact through `LUMA_DIST_FORM`,
which `scripts/luma.spec` bakes into the bundle.

The container differs by platform as well. Windows and Linux get a zip holding one executable; macOS
gets a `.app` bundle inside a `.dmg` laid out for drag-installing to Applications, which is what an
unsigned application should be — nothing to script, and nothing that needs a certificate to run.

Nothing here signs anything. An unsigned artifact carries an OS warning on first run, and someone who
downloads one is choosing that; paying for certificates is a separate decision from being able to build.

Run from anywhere: `python scripts/build_desktop.py [--form portable|installed] [--skip-frontend]`.
"""

import argparse
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import runtime_config  # noqa: E402  (needs ROOT on the path first)
from backend.runtime_config import (  # noqa: E402
    DECLARABLE_DIST_FORMS,
    DEFAULT_APP_NAME,
    DIST_FORM_INSTALLED,
    DIST_FORM_PORTABLE,
)

SPEC = ROOT / "scripts" / "luma.spec"
BUILD_DIR = ROOT / "build" / "pyinstaller"
DIST_DIR = ROOT / "dist"

# The native macOS wrapper — the thing macOS actually launches. See `macos/main.swift`.
SWIFT_SOURCE = ROOT / "macos" / "main.swift"
MACOS_ICON = ROOT / "assets" / "luma.icns"
# A namespace actually controlled, rather than an invented reverse-DNS name. macOS keys LaunchServices
# registration and the preferences domain off this, so two applications sharing one interfere.
BUNDLE_IDENTIFIER = "io.github.jeff162.luma"
# The oldest macOS the artifact claims to support. Stated rather than left to the build machine, which
# would otherwise quietly raise the floor whenever the runner image moves.
MINIMUM_MACOS = "11.0"

# The line about where data lives is the reason there are two of these rather than one with a
# substitution: it is the whole difference between the forms, and it is the thing someone reads this
# file to find out.
READ_ME_PORTABLE = """Luma - portable build

Run the `luma` executable. It starts the application, prints its address, and opens a browser at it.
Press Ctrl+C in the terminal window to stop it.

Data lives in this folder, in luma-data.db and luma-control.db, and stays here when the application is
closed. Moving or copying this whole folder moves the data with it.

Options:
  --no-browser    start without opening a browser, and just print the address

This build is unsigned, so the operating system will warn about it the first time it runs.

Licensed under the GNU AGPL v3.0 or later. The full text is in the LICENSE file beside this one.
"""

READ_ME_INSTALLED = """Luma - installed build

Run the `luma` executable. It starts the application, prints its address, and opens a browser at it.
Press Ctrl+C in the terminal window to stop it.

Data lives in the per-user application data directory for this operating system, not in this folder, so
it survives replacing or moving the application. Settings -> Configuration reports the exact location in
use. Setting DATA_DIR overrides it.

Options:
  --no-browser    start without opening a browser, and just print the address

This build is unsigned, so the operating system will warn about it the first time it runs.

Licensed under the GNU AGPL v3.0 or later. The full text is in the LICENSE file beside this one.
"""

# Gatekeeper is the reason this one is long. The gesture most people know for opening an unsigned
# application — Control-click, then Open — stopped working in macOS 15, and someone who tries it and is
# refused concludes the download is broken rather than unsigned.
READ_ME_MACOS = f"""{DEFAULT_APP_NAME} - macOS

To install, drag {DEFAULT_APP_NAME} to the Applications folder.

This build is unsigned and has not been notarized, so macOS refuses it on first launch. Opening it from
the Finder context menu no longer works around that on macOS 15 and later. What does:

  1. Double-click {DEFAULT_APP_NAME}, and dismiss the warning that appears.
  2. Open System Settings -> Privacy & Security and scroll down to Security.
  3. Choose "Open Anyway" beside the message naming {DEFAULT_APP_NAME}, and confirm.

From a terminal, clearing the quarantine flag beforehand has the same effect:

  xattr -dr com.apple.quarantine /Applications/{DEFAULT_APP_NAME}.app

{DEFAULT_APP_NAME} then starts a local server and opens in the default browser. Nothing is published to
the network: the server accepts connections from this machine only.

Data lives in ~/Library/Application Support/{DEFAULT_APP_NAME}, and stays there when the application is
replaced or deleted. Startup messages, including the address in use, are written to luma-desktop.log in
that same folder; an application started from Finder has no terminal to print them to.

To stop it, quit {DEFAULT_APP_NAME} from the Dock, or press Command-Q. Either shuts the server down
cleanly. "Shut down {DEFAULT_APP_NAME}", at the bottom of the navigation panel inside the app, does the
same thing from the browser.

{DEFAULT_APP_NAME} runs no window of its own (the browser is its interface), so the Dock icon is the
only thing on screen when it is running.

Licensed under the GNU AGPL v3.0 or later. The full text is in the LICENSE file beside this one.
"""


def _run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True, env=env)


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


def _is_macos() -> bool:
    return platform.system().lower() == "darwin"


def _default_form() -> str:
    """What this platform can support, which on macOS is one thing only — a `.app` cannot hold its own
    writable data. Elsewhere the portable zip stays the default because it is the form that has actually
    been shipped."""
    return DIST_FORM_INSTALLED if _is_macos() else DIST_FORM_PORTABLE


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
    raise SystemExit("npm was not found on PATH. It builds the frontend bundle.")


def _build_frontend() -> None:
    npm = _npm()

    frontend = ROOT / "frontend"
    if not (frontend / "node_modules").is_dir():
        # A fresh clone has no node_modules, and `npm run build` there fails with "vite: not found" —
        # which points at the build tool rather than at the missing install. `npm ci` rather than
        # `npm install` because it installs exactly the lockfile, which is what a release wants.
        _run([npm, "ci"], cwd=frontend)

    _run([npm, "run", "build"], cwd=frontend)


def _build_executable(form: str) -> Path:
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
        # The spec runs in its own interpreter, so the form travels as an environment variable rather
        # than an argument — PyInstaller passes nothing of its own through to a spec file.
        env={**os.environ, "LUMA_DIST_FORM": form},
    )

    if _is_macos():
        # A directory, not a file: on macOS the spec emits a onedir tree, which becomes the payload of
        # the application bundle assembled around the native wrapper.
        built = DIST_DIR / "bin" / "server"
        if not built.is_dir():
            raise SystemExit(f"PyInstaller reported success but produced no {built}.")
        return built

    name = "luma.exe" if _is_windows() else "luma"
    built = DIST_DIR / "bin" / name
    if not built.is_file():
        raise SystemExit(f"PyInstaller reported success but produced no {built}.")
    return built


def _artifact_name(form: str, extension: str) -> Path:
    """Only the form this platform actually ships is named for the platform alone. Anything else is a
    build to be tested or fed elsewhere rather than downloaded, and has to be able to sit beside the
    real artifact without overwriting it."""
    suffix = "" if form == _default_form() else f"-{form}"
    return DIST_DIR / f"luma-{_version()}-{_platform_tag()}{suffix}{extension}"


def _assemble_macos_app(server_tree: Path) -> Path:
    """Build the application bundle: the native wrapper as its executable, the PyInstaller tree as its
    payload, and an `Info.plist` written here rather than by PyInstaller.

    The wrapper is what macOS launches. A Python process cannot check in with the window server, so an
    application whose executable is one bounces in the Dock until LaunchServices times out and then
    offers only Force Quit — see `macos/main.swift` for the full reasoning."""
    bundle = DIST_DIR / "bin" / f"{DEFAULT_APP_NAME}.app"
    shutil.rmtree(bundle, ignore_errors=True)
    contents = bundle / "Contents"
    macos_dir = contents / "MacOS"
    resources = contents / "Resources"
    macos_dir.mkdir(parents=True)
    resources.mkdir(parents=True)

    if not shutil.which("swiftc"):
        raise SystemExit(
            "swiftc was not found on PATH. It builds the macOS application wrapper. "
            "Install the Xcode command line tools with: xcode-select --install"
        )
    _run(
        [
            "swiftc", "-O",
            "-target", f"{platform.machine()}-apple-macos{MINIMUM_MACOS}",
            str(SWIFT_SOURCE),
            "-o", str(macos_dir / DEFAULT_APP_NAME),
        ],
        cwd=ROOT,
    )

    # `symlinks=True` because a PyInstaller tree contains framework symlinks; resolving them into copies
    # both doubles the size and breaks the paths the bootloader resolves at startup.
    shutil.copytree(server_tree, resources / "server", symlinks=True)
    shutil.copy2(MACOS_ICON, resources / MACOS_ICON.name)

    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleName": DEFAULT_APP_NAME,
        "CFBundleDisplayName": DEFAULT_APP_NAME,
        # Must match the wrapper's filename above — macOS runs whatever this names.
        "CFBundleExecutable": DEFAULT_APP_NAME,
        "CFBundleIdentifier": BUNDLE_IDENTIFIER,
        "CFBundleIconFile": MACOS_ICON.name,
        "CFBundlePackageType": "APPL",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleShortVersionString": _version(),
        "CFBundleVersion": _version(),
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.finance",
        "LSMinimumSystemVersion": MINIMUM_MACOS,
    }))

    # Last, because anything written into the bundle afterwards invalidates the seal.
    #
    # Ad-hoc (`-s -`) rather than a real identity: this is not notarization and Gatekeeper still asks
    # the user to approve the app. What it prevents is worse than a warning — on Apple Silicon an
    # unsigned binary does not merely go untrusted, it will not load, and a quarantined bundle with no
    # signature is reported as *damaged*. PyInstaller's `BUNDLE` did this itself (`sign_binary(...,
    # deep=True)`); assembling the bundle here took the step with it, and its absence is invisible
    # until someone downloads the result.
    _run(["codesign", "--force", "--deep", "--sign", "-", str(bundle)], cwd=ROOT)

    return bundle


def _package(built: Path, form: str) -> Path:
    return _package_disk_image(built, form) if _is_macos() else _package_zip(built, form)


# The license file the distribution carries beside the program. Separate from the copy inside the
# bundle, which only a *running* app can reach: a recipient whose download will not launch — wrong
# architecture, an unsigned binary the OS refuses, a machine that never runs it at all — still received
# a conveyed copy and is still owed its license. It is also the form every packager and license scanner
# looks for, none of which open the app and click About.
LICENSE_FILE = ROOT / "LICENSE"


def _package_zip(executable: Path, form: str) -> Path:
    archive = _artifact_name(form, ".zip")
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.unlink(missing_ok=True)

    # Named once so the hand-built entry below cannot drift from the archive it is written into.
    compression = zipfile.ZIP_DEFLATED

    with zipfile.ZipFile(archive, "w", compression) as bundle:
        # A `ZipInfo` constructed by hand inherits **nothing** from the archive: its date defaults to
        # the 1980 DOS epoch and its compression to ZIP_STORED, where `writestr` given a plain name
        # takes the current time and the archive's own compression. Both defaults shipped, and neither
        # is cosmetic — a binary dated 1980 reads as a broken download, and storing it uncompressed put
        # the whole of the executable into the zip uncompressed, which is nearly the whole download.
        #
        # The date is the executable's own mtime rather than "now", so the archive reports when the
        # program was actually built.
        info = zipfile.ZipInfo(
            f"luma/{executable.name}",
            date_time=time.localtime(executable.stat().st_mtime)[:6],
        )
        info.compress_type = compression
        # The executable bit does not survive a plain `zipfile.write`, and a portable build whose binary
        # arrives without it is one chmod away from working with no indication of why.
        info.external_attr = 0o755 << 16
        bundle.writestr(info, executable.read_bytes())
        readme = READ_ME_PORTABLE if form == DIST_FORM_PORTABLE else READ_ME_INSTALLED
        bundle.writestr("luma/README.txt", readme)
        bundle.writestr("luma/LICENSE", LICENSE_FILE.read_text(encoding="utf-8"))

    return archive


def _package_disk_image(app: Path, form: str) -> Path:
    """A `.dmg` holding the bundle, a symlink to Applications, and the notes about opening an unsigned
    application. `hdiutil` is macOS-only, which is fine: this branch is only ever reached there."""
    image = _artifact_name(form, ".dmg")
    image.parent.mkdir(parents=True, exist_ok=True)
    image.unlink(missing_ok=True)

    staging = DIST_DIR / "dmg"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        # `symlinks=True` is load-bearing: a PyInstaller bundle links `Contents/Resources` and
        # `Contents/Frameworks` at each other, and resolving those into copies would both double the
        # size and break the paths the bootloader resolves at startup.
        shutil.copytree(app, staging / app.name, symlinks=True)
        (staging / "Applications").symlink_to("/Applications")
        (staging / "README.txt").write_text(READ_ME_MACOS)
        shutil.copyfile(LICENSE_FILE, staging / "LICENSE")

        _run(
            [
                "hdiutil", "create",
                "-volname", DEFAULT_APP_NAME,
                "-srcfolder", str(staging),
                "-ov",
                # Compressed and read-only, which is what a distributed image should be.
                "-format", "UDZO",
                str(image),
            ],
            cwd=ROOT,
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return image


def build(skip_frontend: bool = False, form: str | None = None) -> Path:
    """Build the artifact and return its path. The entry point `release.py` uses, so the two cannot
    disagree about where the artifact lands or what it is called."""
    form = form or _default_form()
    if form not in DECLARABLE_DIST_FORMS:
        raise SystemExit(
            f"Unknown distribution form {form!r}. "
            f"Expected one of: {', '.join(sorted(DECLARABLE_DIST_FORMS))}."
        )

    if skip_frontend:
        if not (ROOT / "frontend" / "dist" / "index.html").is_file():
            raise SystemExit("--skip-frontend was given but frontend/dist holds no build.")
    else:
        _build_frontend()

    built = _build_executable(form)
    if _is_macos():
        built = _assemble_macos_app(built)
    return _package(built, form)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the standalone Luma executable and its zip.")
    parser.add_argument(
        "--skip-frontend",
        action="store_true",
        help="Reuse the existing frontend/dist instead of rebuilding it.",
    )
    parser.add_argument(
        "--form",
        choices=sorted(DECLARABLE_DIST_FORMS),
        default=_default_form(),
        help="Where the built app keeps its data: beside the executable, or in the per-OS user-data "
             "directory. Defaults to what this platform supports.",
    )
    args = parser.parse_args()

    archive = build(skip_frontend=args.skip_frontend, form=args.form)
    size_mb = archive.stat().st_size / (1024 * 1024)
    print(f"\nBuilt {archive.relative_to(ROOT)} ({args.form} form, {size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
