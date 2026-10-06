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
  the Windows zip and the Linux `.tar.gz` kits ship.
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

The result lands in `dist/` as `luma-<version>-<platform>-<arch>` plus the platform's container —
`.zip` on Windows, `.tar.gz` on Linux, `.dmg` on macOS — with `-installed` appended for a build that is
not the platform's usual form. It runs on a machine with neither Python nor Node
installed. Builds are unsigned, so Windows and macOS warn on first run.

### What the kit carries besides the program

A kit is a conveyed copy of *everything* inside it, so each container holds the executable, `README.txt`,
`LICENSE`, `env_example.txt` and **`THIRD-PARTY-LICENSES.txt`** — and the same notices file is frozen into
the bundle, where the About page links it (`/api/app/third-party-licenses`). Almost every dependency is
licensed on the condition that its notice travels with each copy, and a frozen executable carries none of
the files it was built from: minification strips the comments in the web bundle, and PyInstaller keeps no
`dist-info`. The file is the only form that obligation can take here.

It is **generated on every build, never committed**, because what it must list is whatever that build
actually froze in — a dependency bump that did not reach it would leave it quietly wrong. Three sources
meet in `scripts/third_party_notices.py`, which `scripts/luma.spec` calls *during* the PyInstaller run:

- The **web interface's** packages come from the Vite build (`frontend/scripts/thirdPartyNotices.js`),
  which walks the emitted bundle rather than `package.json`: a dev dependency reaches nobody, and a
  runtime one pulls in packages no manifest here names. It writes `dist/third-party-licenses.txt`, which
  is also what the Docker image serves and what `/api/app/third-party-licenses` falls back to outside a
  packaged build — a checkout's server dependencies are installed normally, each with its own license
  file, so only the bundled half needs generating there. The About row says which of the two it links.
- The **server's** come from the installed metadata of the requirement closure walked from
  `backend/requirements.txt`, with environment markers evaluated — so a dependency that only exists on one
  platform, or only through an extra (`uvicorn[standard]`), is included exactly where it is installed.
  The Python runtime's own `LICENSE.txt` heads the section.
- The **shared libraries**, on Linux only, come from `analysis.binaries` — PyInstaller's own record of
  what it copied off the build machine, which is why the file is written from inside the spec rather than
  before it. OpenSSL, SQLite, zlib and about nine others arrive that way, from neither PyPI nor
  python.org. Each is traced to the package that installed it (`dpkg-query`, or `rpm` on a Fedora build)
  and credited with that package's own copyright file, one entry per package. The interpreter's own
  `libpython` is skipped rather than traced: it is Python, already carried by the runtime entry above, and
  a relocatable Python — the kind CI builds on — keeps it in the installation's `lib/`, where neither the
  package manager nor the standard-library paths that identify the installation can account for it. macOS
  links the system's frameworks instead of copying them and Windows takes its libraries from a Python
  whose `LICENSE.txt` lists them, so the section is empty there and left out. Empty on Windows takes one
  extra rule: `python3xx.dll` sits at the installation root and OpenSSL, SQLite and libffi in the `DLLs`
  directory beside it, outside the four directories that identify the installation everywhere else, so
  the whole prefix counts as Python there — safe only because nothing else is installed under it, which
  is not true of the `/usr` the same prefix names on Linux.

  **`readline` is excluded from the bundle** (`luma.spec`) rather than credited. Nothing here reads a line
  from a terminal, and the module pulls in GNU readline — GPL-3.0-or-later, the one library here whose
  license asks for more than its notice — for a capability the app never uses. Dropping it takes ncurses
  with it.

**A component with no license text stops the build**, wherever it came from. Most packages ship one; for the few
that do not, put the upstream text in `scripts/license-texts/<name>.txt` (server) or
`frontend/scripts/license-texts/<name>.txt` (web), with leading `#` lines saying where it was taken from —
those lines are reproduced in the notice, so a reader can tell a supplied text from a shipped one.
`nulltype` and `victory-vendor` are the current two. A shared library the package manager cannot name, or
whose package ships no copyright file, stops the build the same way — a system library carries no metadata
of its own, so one missed here leaves no trace in the finished kit. Third-party material carried in the source tree
rather than installed (the passphrase word list) is listed alongside the packages, its notice read from
the file's own header.

Checking what a build would ship, without running one: `backend/venv/bin/python
scripts/third_party_notices.py` prints the server half.

### Linux specifics

Linux produces two portable kits, `luma-<version>-linux-x64.tar.gz` and
`luma-<version>-linux-arm64.tar.gz`, and like macOS's pair they are not interchangeable. The ARM one
covers 64-bit Raspberry Pi OS and other aarch64 distributions; a 32-bit Pi OS is a third architecture and
is not built.

**A tar rather than a zip, because the executable bit has to survive unpacking.** A zip records the mode
too, but most extractors ignore it — Python's `zipfile`, Windows Explorer, 7-Zip on Windows and many
desktop archive tools — and the 0.3.0 Linux zips, correct in every header, still reached a Linux machine
with a binary that would not run. A tar's mode is applied by every extractor. Windows keeps the zip,
having no execute bit to lose. The smoke test unpacks the tar and does not reapply the bit, so a kit that
would need a `chmod` fails there.

**The runner's glibc is the artifact's floor.** PyInstaller bundles the Python runtime but not the C
library, so the binary links against whatever the build machine has and refuses to start anywhere older.
That is why both Linux jobs run on Ubuntu 22.04 (`ubuntu-22.04`, `ubuntu-22.04-arm`) rather than 24.04:
22.04 carries glibc 2.35, which Ubuntu 22.04, Debian 12 and Raspberry Pi OS bookworm (2.36) satisfy,
where 24.04's 2.39 would not. The failure mode is a link error at launch that names a `GLIBC_` version,
and nothing in the build notices it — the 0.3.0 x64 kit, built on `ubuntu-latest`, would not start under
WSL's Ubuntu 22.04. The labels are pinned rather than `-latest` so the floor cannot move with an alias.

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

Pushing a `v*` tag runs `.github/workflows/release.yml`: tests first, then parallel builds on both
Linux architectures, Windows and both macOS architectures, each uploading its artifact and checksum. `workflow_dispatch`
can build a single platform instead — for testing an artifact on a machine that is in front of
somebody, the Intel Mac above all, which is otherwise only ever built blind.

Each upload is named `luma-<system>-<arch>` — `luma-linux-arm64`, `luma-macos-x64` and so on — which is
what GitHub names the wrapper zip a download produces. That is the `slug` column of the platform table
rather than the runner label, because the labels name build infrastructure rather than targets:
`macos-latest` and `macos-15-intel` are an arm64 and an x64 build named by image vintage, and the
"latest" in a label reads as a version while meaning only that the image alias floats. The slugs match
the `<system>-<arch>` tag already in the archive *inside* the wrapper, so the two agree.

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
5. Tag `vX.Y.Z` and push. CI builds all five artifacts.
6. Write the GitHub Release and **attach the five artifacts and their `.sha256` files**. Nothing is
   downloadable until this happens.

## Configuring the public repository

Public visibility is part of a release, not a replacement for one: publish the tagged GitHub Release
and attach its artifacts before or alongside changing visibility, so the README's download link works
when visitors first see it. The repository's community files — `README.md`, `LICENSE`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, the issue forms, and the pull-request template
— are the public contract and should remain enabled.

Some GitHub controls are unavailable on a private repository under the free plan. Configure the
following immediately after making the repository public, in this order.

### Security features

Open **Settings → Code security and analysis** and enable:

- **Dependency graph**, **Dependabot alerts**, and **Dependabot security updates**, so known vulnerable
  dependencies create actionable, repository-visible alerts.
- **Secret scanning** and **push protection**, so new credentials are blocked before reaching public
  history. These prevent future disclosure; they do not remove anything already pushed.
- **Code scanning default setup**, selecting both Python and JavaScript when GitHub asks which
  languages to analyze. Review the first scan's findings before treating its configuration as settled.

Keep private vulnerability reporting enabled under the repository's **Security** tab. The existing
`SECURITY.md` and issue-form contact link direct reporters to that channel instead of exposing
financial-data security reports in public issues.

### Main branch rule

Create a branch ruleset in **Settings → Rules → Rulesets** that targets `main`. Require a pull request
before merging and require these CI status checks:

- `Backend, unit and lint`
- `Browser suite`

Also block force pushes and branch deletion, and require the branch to be up to date before merging.
Do not require an approving review merely because the control exists: for a sole maintainer, it adds
friction without an independent review. If collaborators gain merge access, revisit that choice and
the bypass list at the same time. Keep the ruleset in an active/enforced state, and verify a test pull
request cannot merge while either required check is failing.

### Actions supply chain

The repository currently uses version tags for GitHub Actions. Before enabling mandatory SHA pinning,
replace every external `uses:` reference in `.github/workflows/` with the full commit SHA for a
reviewed release of that action; retain the version in a trailing comment so it remains auditable.
After that change is merged, open **Settings → Actions → General** and:

- set **Actions permissions** to allow only GitHub-owned actions and explicitly approved actions or
  reusable workflows;
- enable **Require actions to be pinned to a full-length commit SHA**;
- retain the read-only default `GITHUB_TOKEN` permissions and leave workflow pull-request approval
  disabled.

Pinning first makes an Actions compromise unable to silently move a tag to different code. Requiring
SHAs before the workflow change would instead stop the release and CI workflows from running.

### Repository presentation and collaboration

Open **Settings → General** and check the repository description, topics, homepage, and social preview.
The description already states Luma's purpose; add concise discovery topics that accurately describe
the project, such as `personal-finance`, `local-first`, `self-hosted`, `python`, and `react`. Leave the
homepage blank unless there is a maintained project site distinct from this repository. Use a real,
sanitized application screenshot for the social preview after the screenshot work in the release plan
is complete.

Keep **Issues** and **Discussions** enabled, and leave the wiki disabled unless it gains a clearly
different purpose from `docs/`. Preserve the existing signed-commit acknowledgement requirement and
delete-head-branch-on-merge setting. Review the fork setting deliberately: public forks are normal for
an AGPL project, but disabling them is reasonable if the maintainer does not want to support that
workflow.
