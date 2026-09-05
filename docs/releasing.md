# Building and releasing

Producing the downloadable artifacts, and cutting a release from them. This is maintainer territory:
nothing here is needed to *use* Luma (see the README) or to *work on* it (see `CONTRIBUTING.md`).

**This is the building half.** Running what comes out of it — the topologies, what each binds to, where
the data lives, restore, and diagnosing — is [`operations.md`](operations.md). The split falls on *do I
need a build?*: nothing there does, and nothing here is needed to run one.

## The two distribution forms

`scripts/build_desktop.py` produces a single executable with the Python runtime, the backend and the
built frontend inside it. Two forms come out of the same code, and `--form` chooses:

- **portable** — databases sit beside the executable. Moving the folder moves the data. This is what
  the Windows and Linux zips ship.
- **installed** — databases go to the per-OS user-data directory, for an artifact an installer places
  somewhere the user does not own and an upgrade replaces wholesale. This is what macOS ships.

The default is whichever form the build platform supports; **macOS is installed-only**, because a
`.app` cannot hold its own writable data — a quarantined application may be run from a randomized
read-only path that disappears afterwards. Either way, **Settings → Configuration** reports the
directory actually in force.

Each platform's artifact must be built on that platform: PyInstaller cannot cross-build.

## Setting up the build environment

The build runs from `backend/venv/`. Launching the app once with a start script creates it; on a
checkout that has never been started, create it directly. Pin the interpreter to 3.12 — a venv built
from a newer default Python cannot install the pinned dependencies.

macOS / Linux / Raspberry Pi:

```bash
python3.12 -m venv backend/venv
backend/venv/bin/python -m pip install -r backend/requirements.txt -r backend/requirements-build.txt
```

Windows:

```powershell
py -3.12 -m venv backend\venv
backend\venv\Scripts\python -m pip install -r backend\requirements.txt -r backend\requirements-build.txt
```

`requirements-build.txt` holds only PyInstaller and is deliberately separate from the runtime
dependencies, so a normal install never pulls it in.

## Building

```bash
backend/venv/bin/python scripts/build_desktop.py    # --skip-frontend reuses an existing frontend/dist
```

On Windows substitute `backend\venv\Scripts\python` for `backend/venv/bin/python`, here and below.

The result lands in `dist/` as `luma-<version>-<platform>-<arch>.zip`, with `-installed` appended for a
build that is not the platform's usual form. It runs on a machine with neither Python nor Node
installed. Builds are unsigned, so Windows and macOS warn on first run.

### macOS specifics

macOS produces `luma-<version>-macos-<arch>.dmg`: a `Luma.app` bundle beside a shortcut to
Applications, installed by dragging one onto the other.

**Both architectures are published and they are not interchangeable** — `arm64` for Apple Silicon,
`x64` for Intel. Two builds rather than one universal2 binary, because universal2 would need
universal2 wheels for `cryptography` and `pydantic-core` and those are not dependably published.

**The ad-hoc signature is load-bearing.** `_assemble_macos_app` ends with
`codesign --force --deep --sign -`. This is not notarization and Gatekeeper still asks the user to
approve the app — but on Apple Silicon an unsigned binary does not merely go untrusted, **it will not
load**, and a quarantined bundle with no signature is reported as *damaged*. PyInstaller's `BUNDLE`
used to do this implicitly; assembling the bundle by hand took the step with it, and its absence is
invisible until someone downloads the result. It must stay last, since anything written into the
bundle afterwards invalidates the seal.

**The native wrapper.** `macos/main.swift` is what the `.app` actually launches; the Python server runs
as its child. A Python process cannot check in with the macOS window server, and an application whose
executable is one bounces in the Dock for the length of the launch timeout — minutes — before being
marked as failed, at which point the Dock offers only Force Quit. The wrapper also lets the two
processes watch each other: quitting it stops the server, and the server exiting quits the wrapper
rather than leaving a dead icon in the Dock.

### Icons

`assets/luma-icon.svg` is the source; `scripts/build_icons.py` derives the macOS `.icns`, the Windows
`.ico` and the browser favicons. The derived files are committed, so an ordinary build needs no
rasterizer — run the script only when the artwork changes (it needs `pip install cairosvg`,
deliberately not a project dependency). It emits two shapes of the same drawing: full-bleed for Windows
and the browser, and inset for macOS, which since Big Sur draws every icon on a canvas larger than the
artwork. An icon that fills its canvas sits visibly oversized in the Dock.

## Cutting a release

`scripts/release.py` gates the build on the things that are quiet when they go wrong, then produces a
checksummed artifact:

```bash
backend/venv/bin/python scripts/release.py --set-version 0.3.0   # rewrite all version declarations
backend/venv/bin/python scripts/release.py --check               # gates only, no build
backend/venv/bin/python scripts/release.py                       # gate, build, checksum
```

The gates are that every version declaration agrees and that the working tree is clean, so an artifact
can be traced back to a commit. `--allow-dirty` skips the second for a throwaway build.

### What CI does, and the two things it deliberately does not

Pushing a `v*` tag runs `.github/workflows/release.yml`: tests first, then parallel builds on Linux,
Windows and both macOS architectures, each uploading its artifact and checksum. `workflow_dispatch`
can build a single platform instead — for testing an artifact on a machine that is in front of
somebody, the Intel Mac above all, which is otherwise only ever built blind.

"Tests first" is `.github/workflows/ci.yml`, *called* by the release workflow rather than copied into
it — the same backend, unit, lint and browser lanes that gate every push and pull request. A release
that was gated on a second transcription of those checks would drift from them silently, in the
workflow nobody reads until a build has already shipped.

Three deliberate omissions, all documented in the workflow header:

- **No tagging.** A person decides what a release is; the workflow reacts to that decision.
- **No publishing.** The jobs upload *workflow* artifacts; they do not create a GitHub Release.
  Publishing is outward-facing and belongs to whoever is cutting the release. **This is a manual step**
  — until the files are attached to a written release, nothing is downloadable by a visitor, since
  workflow artifacts expire and require a signed-in GitHub account.
- **No signing.** See the macOS note above.

### Smoke tests

Each build smoke-tests what it produced, because the failures packaging introduces are ones no unit
test can reach: a bundled resource that did not make it in, or an app that starts normally while
writing its databases somewhere nobody looks. `scripts/smoke_artifact.py` unpacks the artifact,
launches it with the browser suppressed, waits for the health endpoint, and asserts both databases
landed where that distribution form promises.

```bash
backend/venv/bin/python scripts/smoke_artifact.py --form portable
```

CI also builds the *installed* form on Ubuntu and smoke-tests it, even though no installer exists for
Linux and it is excluded from the upload. It proves the mechanism macOS depends on entirely, on the
cheapest runner, so macOS is not the first place it is ever exercised.

## Release checklist

1. `npm run ui:smoke` in `frontend/` — the built bundle loads and routes. Cheap, and the one check
   nothing else in the pipeline performs (see `CONTRIBUTING.md` → *The smoke lane*).
2. `release.py --set-version X.Y.Z`, commit.
3. `release.py --check` — version declarations agree, tree clean.
4. In `CHANGELOG.md`, rename the `## [Unreleased]` heading to `## [X.Y.Z] - YYYY-MM-DD` and open a
   fresh empty `[Unreleased]` above it. The release date enters here and nowhere else, which is why
   this is a rename rather than a placeholder filled in later — the file is never in a wrong state.
   Update the link definitions at the foot of the file to match.
5. Tag `vX.Y.Z` and push. CI builds all four artifacts.
6. Write the GitHub Release and **attach the four artifacts and their `.sha256` files**. Nothing is
   downloadable until this happens.
