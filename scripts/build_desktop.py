#!/usr/bin/env python3
"""Build the standalone desktop artifact: one executable, plus the archive it ships in.

Two distribution forms come out of the same code, and which one is being built is a *decision*, not
something the running app can work out for itself:

- **portable** — a kit whose databases live beside the executable, which is what
  `runtime_config.anchor_relative` arranges in a frozen build. It carries no configuration file at all
  because the stock `DATA_DIR = "."` default already means the right thing once frozen.
- **installed** — databases in the per-OS user-data directory, for an artifact that an installer puts
  somewhere the user does not own and an upgrade replaces wholesale.

`--form` chooses, defaulting to whatever the platform can support: macOS is installed-only, since a
`.app` cannot hold its own writable data. The choice reaches the artifact through `LUMA_DIST_FORM`,
which `scripts/luma.spec` bakes into the bundle.

The container differs by platform as well. Windows gets a zip holding one executable and Linux a
`.tar.gz` holding the same, since only a tar's file modes survive every extractor; macOS gets a `.app`
bundle inside a `.dmg` laid out for drag-installing to Applications, which is what an unsigned
application should be — nothing to script, and nothing that needs a certificate to run.

Nothing here signs anything. An unsigned artifact carries an OS warning on first run, and someone who
downloads one is choosing that; paying for certificates is a separate decision from being able to build.

Run from anywhere: `python scripts/build_desktop.py [--form portable|installed] [--skip-frontend]`.
"""

import argparse
import io
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tarfile
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

# The Finder window a mounted `.dmg` opens in, in points. The top row is the install gesture, with the
# background's arrow running from the application to the Applications shortcut; the documents sit in a
# tray below it, inside the window rather than off its edge, so README.txt and its first-launch steps are
# seen. Finder draws every icon at one size, which is what bounds the tray to a single row of four.
# `assets/dmg-background.svg` is drawn on this grid, so a change to one is a change to the other.
DMG_BACKGROUND = ROOT / "assets" / "dmg-background.png"
DMG_WINDOW_SIZE = (640, 460)
DMG_ICON_SIZE = 96
DMG_TOP_ROW_Y = 130
# Centres of the application and the Applications shortcut; the background's arrow spans the gap.
DMG_APP_X, DMG_APPLICATIONS_X = 170, 470
DMG_TRAY_ROW_Y = 330

# The line about where data lives is the reason there are two of these rather than one with a
# substitution: it is the whole difference between the forms, and it is the thing someone reads this
# file to find out.
READ_ME_PORTABLE = """Luma - portable build

Run the `luma` executable. It starts the application, prints its address, and opens a browser.
Press Ctrl+C in the terminal window to stop it.

Data lives in this folder, in luma-data.db and luma-control.db and the documents folder, and stays here when the application is closed. Moving or copying this whole folder moves the data with it.

Configuration is not required. To change a setting such as the port (8010 unless changed), make a copy of env_example.txt as .env and make the desired changes. Settings -> Startup configuration shows the current source of the available settings.

Options:
  --no-browser    start without opening a browser, just print the address

This build is unsigned, so the operating system may warn about it the first time it runs.

Licensed under the GNU AGPL v3.0 or later. The full text is in the LICENSE file. Other software included in this build and their licenses is listed in THIRD-PARTY-LICENSES.txt.
"""

READ_ME_INSTALLED = """Luma - installed build

Run the `luma` executable. It starts the application, prints its address, and opens a browser.
Press Ctrl+C in the terminal window to stop it.

Data lives in the per-user application data directory, not in the folder with the application. Settings -> Startup configuration reports the
exact location in use. DATA_DIR in an .env file can be used to specify a different location.

Configuration is not required. To change a setting make a copy of env_example.txt as .env and make the desired changes. Settings -> Startup configuration shows current source of the various settings.

Options:
  --no-browser    start without opening a browser, and just print the address

This build is unsigned, so the operating system will warn about it the first time it runs. On macOS, 
 xattr -dr com.apple.quarantine /Applications/{DEFAULT_APP_NAME}.app
can be used to clear the quarantine flag before the first launch. This can also be done after running the application in the system menu.

Licensed under the GNU AGPL v3.0 or later. The full text is in the LICENSE file. The
other software included in this build, and their license, is listed in THIRD-PARTY-LICENSES.txt.
"""

# Gatekeeper is the reason this one is long. The gesture most people know for opening an unsigned
# application — Control-click, then Open — stopped working in macOS 15, and someone who tries it and is
# refused concludes the download is broken rather than unsigned.
READ_ME_MACOS = f"""{DEFAULT_APP_NAME} - macOS

To install, drag {DEFAULT_APP_NAME} to the Applications folder.

This build is unsigned and has not been notarized, so macOS refuses it on first launch. To resolve this:

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

No configuration is needed. To change a setting such as the port (8010 unless changed), copy
env_example.txt from this disk image to a file named .env in that same folder and edit it. Settings ->
Configuration shows every effective value and where it came from.

To stop it, quit {DEFAULT_APP_NAME} from the Dock, or press Command-Q. Either shuts the server down
cleanly. "Shut down {DEFAULT_APP_NAME}", at the bottom of the navigation panel inside the app, does the
same thing from the browser.

{DEFAULT_APP_NAME} runs no window of its own (the browser is its interface), so the Dock icon is the
only thing on screen when it is running.

Licensed under the GNU AGPL v3.0 or later. The full text is in the LICENSE file beside this one. The
other software included in this build, and the license of each, is listed in THIRD-PARTY-LICENSES.txt.
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
    writable data. Elsewhere the portable kit stays the default because it is the form that has actually
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
    if _is_macos():
        return _package_disk_image(built, form)
    return _package_zip(built, form) if _is_windows() else _package_tar(built, form)


# The license file the distribution carries beside the program. Separate from the copy inside the
# bundle, which only a *running* app can reach: a recipient whose download will not launch — wrong
# architecture, an unsigned binary the OS refuses, a machine that never runs it at all — still received
# a conveyed copy and is still owed its license. It is also the form every packager and license scanner
# looks for, none of which open the app and click About.
LICENSE_FILE = ROOT / "LICENSE"
# The commented list of every override, shipped as-is beside the README: a downloaded copy has no other
# place to learn what a `.env` can say. One file for every way of running the app, each setting marked
# with where it applies, so the kit and the repository cannot disagree. Named without a leading dot, and
# the same in both places: Finder and most Linux file managers hide dot-files, so `.env_example` was
# invisible in exactly the disk image meant to hand it over.
ENV_EXAMPLE_FILE = ROOT / "env_example.txt"
# The licenses of everything else the kit carries. Most of those licenses require their notice to travel
# with every copy, and a frozen executable carries none of the files it was built from, so this file is
# the only form that obligation can take here. `scripts/luma.spec` writes it during the PyInstaller run —
# that is where the list of collected shared libraries exists — folding in the web interface's half from
# the frontend build (`frontend/scripts/thirdPartyNotices.js`). The kit ships the same bytes the bundle
# carries, so the copy beside the executable and the copy the About page serves cannot disagree.
THIRD_PARTY_NOTICES_FILE = ROOT / "build" / "third-party" / runtime_config.THIRD_PARTY_NOTICES_FILENAME


def _kit_members(executable: Path, form: str) -> list[tuple[str, bytes, int]]:
    """What a kit holds, as `(name, content, mode)`, whichever container it ships in — so the Windows zip
    and the Linux tar cannot come to carry different files."""
    read_me = READ_ME_PORTABLE if form == DIST_FORM_PORTABLE else READ_ME_INSTALLED
    return [
        (executable.name, executable.read_bytes(), 0o755),
        ("README.txt", read_me.encode("utf-8"), 0o644),
        ("LICENSE", LICENSE_FILE.read_text(encoding="utf-8").encode("utf-8"), 0o644),
        (
            THIRD_PARTY_NOTICES_FILE.name,
            THIRD_PARTY_NOTICES_FILE.read_text(encoding="utf-8").encode("utf-8"),
            0o644,
        ),
        (ENV_EXAMPLE_FILE.name, ENV_EXAMPLE_FILE.read_text(encoding="utf-8").encode("utf-8"), 0o644),
    ]


def _package_tar(executable: Path, form: str) -> Path:
    """Linux's container. A tar's mode field is applied by every extractor; a zip's is a field most of them
    ignore — Python's `zipfile`, Windows Explorer, 7-Zip on Windows and many desktop archive tools. The
    0.3.0 Linux zips carried 0o755 on the binary and still reached a Linux machine unrunnable, which is
    what moved Linux off the zip. Windows keeps it, having no execute bit to lose."""
    archive = _artifact_name(form, ".tar.gz")
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.unlink(missing_ok=True)

    # One timestamp for the whole archive, as in the zip.
    built_at = int(executable.stat().st_mtime)

    def header(name: str, mode: int, kind: bytes, size: int = 0) -> tarfile.TarInfo:
        info = tarfile.TarInfo(name)
        info.type = kind
        info.mode = mode
        info.size = size
        info.mtime = built_at
        # Owned by nobody in particular, rather than recording the build machine's account (`runner`
        # on CI) in every download.
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    with tarfile.open(archive, "w:gz") as bundle:
        # The folder itself, so it unpacks with a stated mode rather than one the extractor invents.
        bundle.addfile(header("luma", 0o755, tarfile.DIRTYPE))
        for name, content, mode in _kit_members(executable, form):
            bundle.addfile(header(f"luma/{name}", mode, tarfile.REGTYPE, len(content)), io.BytesIO(content))

    return archive


def _package_zip(executable: Path, form: str) -> Path:
    archive = _artifact_name(form, ".zip")
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.unlink(missing_ok=True)

    # Named once so no member can drift from the archive it is written into.
    compression = zipfile.ZIP_DEFLATED
    # One timestamp for the whole archive. Every member is an output of this build, and the executable
    # is the only one of the three whose own mtime means anything.
    built_at = time.localtime(executable.stat().st_mtime)[:6]

    with zipfile.ZipFile(archive, "w", compression) as bundle:
        # Each member states its date, its compression and its mode, because `writestr` fills in a
        # *different* set depending on what it is handed and neither set is right on its own. Given a
        # plain name it supplies the current time, the archive's compression and a mode of 0o600; given
        # a `ZipInfo` it supplies nothing at all, leaving the 1980 DOS epoch and ZIP_STORED. Both halves
        # of that shipped as defects — the executable needs a `ZipInfo` to carry its mode bits and so
        # went out dated 1980 and uncompressed, while the text files took 0o600 and extract unreadable
        # to anyone but the user who unpacked them. Stating all three here removes the asymmetry rather
        # than fixing each symptom.
        #
        # Compressing the executable saves about 1% — PyInstaller has already compressed the archive
        # inside it — so this is consistency rather than a size win; the win is that nothing here depends
        # on which overload of `writestr` a future edit happens to use. The mode is recorded even though
        # Windows has no use for it, so the entry says what it is to any tool that reads it.
        for name, content, mode in _kit_members(executable, form):
            info = zipfile.ZipInfo(f"luma/{name}", date_time=built_at)
            info.compress_type = compression
            info.external_attr = mode << 16
            bundle.writestr(info, content)

    return archive


def _package_disk_image(app: Path, form: str) -> Path:
    """A `.dmg` holding the bundle, a symlink to Applications, and the notes about opening an unsigned
    application, laid out as the `DMG_` constants describe. `dmgbuild` writes the window's layout into the
    image's `.DS_Store` directly rather than by scripting Finder, which a headless CI runner cannot do
    dependably; it drives `hdiutil`, so this branch, like the dependency, is macOS-only."""
    import dmgbuild

    image = _artifact_name(form, ".dmg")
    image.parent.mkdir(parents=True, exist_ok=True)
    image.unlink(missing_ok=True)

    staging = DIST_DIR / "dmg"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        readme = staging / "README.txt"
        readme.write_text(READ_ME_MACOS)
        # In the order they sit in the tray, README first since it is the one needed before first launch.
        documents = [
            (readme, readme.name),
            (LICENSE_FILE, "LICENSE"),
            (THIRD_PARTY_NOTICES_FILE, THIRD_PARTY_NOTICES_FILE.name),
            (ENV_EXAMPLE_FILE, ENV_EXAMPLE_FILE.name),
        ]

        tray_slot = DMG_WINDOW_SIZE[0] // len(documents)
        icon_locations = {
            app.name: (DMG_APP_X, DMG_TOP_ROW_Y),
            "Applications": (DMG_APPLICATIONS_X, DMG_TOP_ROW_Y),
        }
        for index, (_, name) in enumerate(documents):
            icon_locations[name] = (tray_slot * index + tray_slot // 2, DMG_TRAY_ROW_Y)

        dmgbuild.build_dmg(
            str(image),
            DEFAULT_APP_NAME,
            settings={
                # Copied with `ditto`, which keeps the bundle's internal symlinks: a PyInstaller bundle
                # links `Contents/Resources` and `Contents/Frameworks` at each other, and resolving those
                # into copies would both double the size and break the paths the bootloader resolves.
                "files": [str(app), *((str(source), name) for source, name in documents)],
                "symlinks": {"Applications": "/Applications"},
                # Compressed and read-only, which is what a distributed image should be.
                "format": "UDZO",
                # `dmgbuild` picks up the `@2x` file beside this one by name, for Retina displays.
                "background": str(DMG_BACKGROUND),
                "window_rect": ((200, 120), DMG_WINDOW_SIZE),
                "icon_size": DMG_ICON_SIZE,
                "text_size": 13,
                "icon_locations": icon_locations,
            },
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
    parser = argparse.ArgumentParser(description="Build the standalone Luma executable and its archive.")
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
