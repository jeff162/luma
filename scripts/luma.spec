# PyInstaller build definition for the standalone desktop build.
#
# Entry point is `backend/desktop.py` — the same launcher a checkout runs with `python -m backend.desktop`.
# Step 2 of the packaging plan changes how it is shipped, not what it does.
#
# Two things here are not boilerplate:
#
# - **The built frontend is bundled as data.** `runtime_config.bundle_root()` resolves to PyInstaller's
#   unpack directory in a frozen build, so `frontend/dist` has to land at that same relative path or the
#   SPA silently fails to mount and the app serves nothing but its API.
# - **uvicorn and plaid are collected wholesale.** Both reach modules by name at runtime rather than by
#   import statement — uvicorn selects its loop and protocol implementations from strings, and the Plaid
#   SDK resolves `plaid.model.*` during deserialization. Static analysis cannot see either, and the
#   failure arrives as an ImportError in the field rather than at build time. The rest of the backend is
#   statically imported and needs no help.

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent

analysis = Analysis(
    [str(ROOT / "backend" / "desktop.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[(str(ROOT / "frontend" / "dist"), "frontend/dist")],
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("plaid"),
    hookspath=[],
    runtime_hooks=[],
    # Bundling the test suite would ship pytest and every fixture with the app.
    excludes=["backend.tests", "pytest", "_pytest"],
    noarchive=False,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="luma",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # A terminal stays attached on purpose: the startup line carries the URL, and it is the fallback
    # whenever opening a browser does not work. A windowed build would hide the one thing the user needs.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
