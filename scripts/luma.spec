# PyInstaller build definition for the standalone desktop build.
#
# Entry point is `backend/desktop.py` — the same launcher a checkout runs with `python -m backend.desktop`.
# Step 2 of the packaging plan changes how it is shipped, not what it does.
#
# Four things here are not boilerplate:
#
# - **The built frontend is bundled as data.** `runtime_config.bundle_root()` resolves to PyInstaller's
#   unpack directory in a frozen build, so `frontend/dist` has to land at that same relative path or the
#   SPA silently fails to mount and the app serves nothing but its API.
# - **The distribution form is baked in here.** Portable and installed builds are the same binary and
#   differ only in where writable data defaults to, so the artifact has to carry the answer rather than
#   work it out at runtime. `LUMA_DIST_FORM` selects it and a one-word file in the bundle records it.
# - **macOS gets a different layout, and is not the application.** Everywhere else this is a onefile
#   binary. On macOS it is a onedir *tree* that `scripts/build_desktop.py` places inside an application
#   bundle built around the native wrapper in `macos/` — that wrapper is what macOS launches, owns the
#   Dock icon, and answers Quit. So no `BUNDLE` here: PyInstaller would produce a second, competing
#   application with an `Info.plist` we do not control. onedir rather than onefile also means the process
#   the wrapper launches *is* the Python process, so the signal it sends on quit arrives directly instead
#   of at a bootloader that forked.
# - **uvicorn, plaid and truststore are collected wholesale.** Each reaches modules by name at runtime
#   rather than by import statement — uvicorn selects its loop and protocol implementations from
#   strings, the Plaid SDK resolves `plaid.model.*` during deserialization, and truststore picks its
#   platform backend conditionally. Static analysis cannot see any of them, and the failure arrives as
#   an ImportError in the field rather than at build time. The rest of the backend is statically
#   imported and needs no help.

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent

# Imported for the form constants and the bundled filename rather than restating them here. Two files
# that must agree on a literal are two files that can disagree about it, and the failure would be a
# build whose declaration the application cannot read.
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import third_party_notices  # noqa: E402  (needs scripts/ on the path first)
from backend import runtime_config  # noqa: E402  (needs ROOT on the path first)

dist_form = (os.environ.get("LUMA_DIST_FORM") or runtime_config.DIST_FORM_PORTABLE).strip().lower()
if dist_form not in runtime_config.DECLARABLE_DIST_FORMS:
    raise SystemExit(
        f"LUMA_DIST_FORM={dist_form!r} is not a distribution form. "
        f"Expected one of: {', '.join(sorted(runtime_config.DECLARABLE_DIST_FORMS))}."
    )
if sys.platform == "darwin" and dist_form != runtime_config.DIST_FORM_INSTALLED:
    # Not a preference. A portable macOS build would resolve its data directory inside
    # `Luma.app/Contents/MacOS`, which an upgrade replaces and which App Translocation can mount
    # read-only at a path that disappears — so the failure is silent data loss, and refusing to build
    # is the only place it can still be caught.
    raise SystemExit(
        "macOS supports the installed form only; build with LUMA_DIST_FORM=installed "
        "(scripts/build_desktop.py does this on its own)."
    )

# Written into the build tree, which is gitignored, so nothing lands in the checkout that could outlive
# the build and change how a developer's copy resolves its data directory.
# Generated from `assets/luma-icon.svg` by `scripts/build_icons.py` and committed, so a build needs no
# rasterizer. Only Windows needs one here — it reads the icon out of the executable — while the macOS
# icon belongs to the application bundle and is placed there by `scripts/build_desktop.py`.
WINDOWS_ICON = ROOT / "assets" / "luma.ico"

WEB_NOTICES = ROOT / "frontend" / "dist" / "third-party-licenses.txt"
NOTICES_FILE = ROOT / "build" / "third-party" / runtime_config.THIRD_PARTY_NOTICES_FILENAME
if not WEB_NOTICES.is_file():
    raise SystemExit(
        f"{WEB_NOTICES} is missing, so the licenses of the web interface's packages cannot be shipped. "
        "Build the frontend first; scripts/build_desktop.py does it."
    )

form_marker = ROOT / "build" / "dist-form" / runtime_config.DIST_FORM_FILENAME
form_marker.parent.mkdir(parents=True, exist_ok=True)
form_marker.write_text(f"{dist_form}\n", encoding="utf-8")

analysis = Analysis(
    [str(ROOT / "backend" / "desktop.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        (str(ROOT / "frontend" / "dist"), "frontend/dist"),
        (str(form_marker), "."),
        # A packaged build is a *conveyed* copy, and the AGPL requires the license to accompany one.
        # The repository copy covers a checkout; nothing covered the binary until this line. It lands at
        # the bundle root, which is where `runtime_config.bundled_license_path` looks for it.
        (str(ROOT / "LICENSE"), "."),
    ],
    hiddenimports=(
        collect_submodules("uvicorn")
        + collect_submodules("plaid")
        + collect_submodules("truststore")
    ),
    hookspath=[],
    runtime_hooks=[],
    # Bundling the test suite would ship pytest and every fixture with the app. `readline` is excluded for
    # a different reason: nothing here reads a line from a terminal, and the module drags GNU readline —
    # GPL-3.0-or-later, the one bundled library whose license asks for more than its notice — into the
    # kit for a capability the app never uses.
    excludes=["backend.tests", "pytest", "_pytest", "readline"],
    noarchive=False,
)

# The licenses of everything the build carries, written *here* because this is where the list of collected
# shared libraries exists: `analysis.binaries` is PyInstaller's own answer to what it copied off this
# machine, and deriving it any other way would be a second implementation that could disagree. The file
# then rides into the bundle as data and is packaged beside the executable by `scripts/build_desktop.py`,
# so the copy in the kit and the copy the About page serves are the same bytes.
NOTICES_FILE.parent.mkdir(parents=True, exist_ok=True)
NOTICES_FILE.write_text(
    third_party_notices.combined_notices(
        WEB_NOTICES.read_text(encoding="utf-8"), binaries=analysis.binaries,
    ),
    encoding="utf-8",
)
analysis.datas.append((runtime_config.THIRD_PARTY_NOTICES_FILENAME, str(NOTICES_FILE), "DATA"))

pyz = PYZ(analysis.pure)

# A terminal stays attached on purpose: the startup line carries the URL, and it is the fallback
# whenever opening a browser does not work. A windowed build would hide the one thing the user needs.
#
# The flag has no effect on macOS now: it only ever reached the Info.plist through PyInstaller's
# `BUNDLE`, which this no longer uses. The wrapper in `macos/` writes that plist instead, and what
# PyInstaller produces there is a plain executable the wrapper runs as a child.
EXE_OPTIONS = dict(
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    # Left to the build machine. Cross-building is not possible anyway, so each architecture is produced
    # on a runner of that architecture rather than selected here.
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

if sys.platform == "darwin":
    # EXE without the payload, then COLLECT to lay the payload out beside it. The result is a directory
    # named `server`, which is exactly where the wrapper looks for it inside `Contents/Resources`.
    exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="luma", **EXE_OPTIONS)
    collected = COLLECT(exe, analysis.binaries, analysis.datas, strip=False, upx=False, name="server")
else:
    exe = EXE(
        pyz,
        analysis.scripts,
        analysis.binaries,
        analysis.datas,
        [],
        name="luma",
        # Windows reads the icon out of the executable itself. Linux has no equivalent — a desktop entry
        # would carry one, and the portable kit deliberately installs nothing.
        icon=str(WINDOWS_ICON) if sys.platform == "win32" else None,
        **EXE_OPTIONS,
    )
