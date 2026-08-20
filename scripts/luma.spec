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
# - **macOS gets a different layout.** Everywhere else this is a onefile binary; a `.app` bundle is
#   built onedir instead, because a onefile inside a bundle would re-unpack itself to a temporary
#   directory on every launch — slow, and the same vanishing-path problem the two roots exist to avoid,
#   just moved inside the artifact.
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
    ],
    hiddenimports=(
        collect_submodules("uvicorn")
        + collect_submodules("plaid")
        + collect_submodules("truststore")
    ),
    hookspath=[],
    runtime_hooks=[],
    # Bundling the test suite would ship pytest and every fixture with the app.
    excludes=["backend.tests", "pytest", "_pytest"],
    noarchive=False,
)

pyz = PYZ(analysis.pure)

# A terminal stays attached on purpose: the startup line carries the URL, and it is the fallback
# whenever opening a browser does not work. A windowed build would hide the one thing the user needs.
# It buys nothing on macOS, where a bundle started from Finder has no terminal to attach to either way
# — `backend/desktop.py` writes to a log file there instead — but a console build is still what makes
# the executable inside the bundle usable directly from a shell.
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
    # Three nested steps rather than one: EXE without the payload, COLLECT to lay the payload out beside
    # it, BUNDLE to wrap the result in the directory structure macOS recognizes as an application.
    exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="luma", **EXE_OPTIONS)
    collected = COLLECT(exe, analysis.binaries, analysis.datas, strip=False, upx=False, name="luma")
    app = BUNDLE(
        collected,
        name=f"{runtime_config.DEFAULT_APP_NAME}.app",
        icon=None,
        # A namespace actually controlled, rather than an invented reverse-DNS name. macOS keys a good
        # deal off this — LaunchServices registration, and the preferences domain — so two applications
        # sharing one would interfere with each other.
        bundle_identifier="io.github.jeff162.luma",
        version=runtime_config.APP_VERSION,
        info_plist={
            "CFBundleName": runtime_config.DEFAULT_APP_NAME,
            "CFBundleDisplayName": runtime_config.DEFAULT_APP_NAME,
            "CFBundleShortVersionString": runtime_config.APP_VERSION,
            "CFBundleVersion": runtime_config.APP_VERSION,
            "NSHighResolutionCapable": True,
            "LSApplicationCategoryType": "public.app-category.finance",
        },
    )
else:
    exe = EXE(
        pyz,
        analysis.scripts,
        analysis.binaries,
        analysis.datas,
        [],
        name="luma",
        **EXE_OPTIONS,
    )
