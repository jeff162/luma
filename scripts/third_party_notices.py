#!/usr/bin/env python3
"""The third-party notices a packaged build ships: what the server half carries, folded together with
what the frontend build already wrote for the web interface.

A kit is a *conveyed* copy of everything inside it, not only of this project's own code. The Python
runtime, every dependency in `backend/requirements.txt` and everything those pull in are frozen into the
executable, and almost all of them are licensed on the condition that their notice travels with every
copy. `frontend/scripts/thirdPartyNotices.js` answers the same obligation for the web interface from the
bundle it builds; this answers it for the server, and `scripts/luma.spec` writes them out as one file
during the PyInstaller run — which is where the list of collected shared libraries exists.

**Which distributions count is derived, not listed.** The requirement closure is walked from
`requirements.txt` through each distribution's own metadata, with environment markers evaluated on the
machine doing the build — so a dependency that arrives only on one platform, or only through an extra
(`uvicorn[standard]`), is included exactly where it is actually installed. A hand-kept list would be a
second place to forget.

**A distribution with no license text fails the build.** Most wheels carry their license file in
`*.dist-info/`; one that does not takes its text from `scripts/license-texts/<name>.txt`, whose leading
`#` lines say where that text came from. Neither is a stop, because the alternative is shipping a kit
that is quietly out of compliance with one of its dependencies.

**The shared libraries are the third source.** PyInstaller copies the C libraries the interpreter and
the extension modules link against out of the build machine — OpenSSL, SQLite, zlib and a dozen others —
so a Linux kit conveys software that arrived from neither PyPI nor python.org. They are attributed through
the build machine's own package manager, which is what Debian's `/usr/share/doc/<package>/copyright` files
exist for. The official Windows Python carries the licenses of what it bundles in its own `LICENSE.txt`,
so there that is already covered.

**macOS has neither.** The python.org installer builds OpenSSL into the Python framework rather than
linking the system's, no package manager on that machine installed it, and the framework's `LICENSE.txt`
speaks for CPython alone. Those libraries are therefore credited by name from a text this repository
supplies, the same answer as a wheel that ships none.

**What Windows still collects from outside Python is Microsoft's own C runtime**, and it is named here
rather than traced: PyInstaller asks for the Universal CRT and the VC14 runtime by name whatever directory
they are found in, so the path a copy came from says nothing about what it is. Microsoft's redistributable
terms let an application carry these and ask for no notice in return, which is the same reason
`VCRUNTIME140.dll` needs none where the Python installer drops it.
"""

import os
import re
import shutil
import ssl
import subprocess
import sys
import sysconfig
import textwrap
from collections.abc import Callable
from importlib.metadata import Distribution, PackageNotFoundError, distribution
from pathlib import Path
from typing import NamedTuple

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = ROOT / "backend" / "requirements.txt"
SUPPLEMENT_DIR = ROOT / "scripts" / "license-texts"

# A file inside a `.dist-info` directory that holds license text rather than metadata. Modern wheels put
# these under `licenses/` (PEP 639) or `license_files/`; older ones drop them beside `METADATA`.
LICENSE_FILE = re.compile(r"(^|/)(licen[cs]e|copying|notice|authors)([-._].*)?$", re.IGNORECASE)

RULE = "-" * 78

def _python_trees(platform: str = sys.platform) -> tuple[str, ...]:
    """Where a distribution's own files live, so a collected binary can be told from a system library: an
    extension module under the standard library or in site-packages is already covered by Python's entry
    or by its package's. Deliberately the specific library directories and not `sys.prefix`, which on a
    system Python is `/usr` and would swallow every shared library on the machine.

    **Windows is the exception, and there the installation root itself is the tree.** Those four
    directories are `Lib` and `Lib\\site-packages` there and nothing else, while the interpreter keeps its
    DLLs outside both: `python3xx.dll` sits at the root and the OpenSSL, SQLite and libffi it links
    against sit in `DLLs` beside it. All of them are the Python that gets frozen in, covered by the
    runtime entry `python_runtime_license` writes — the official Windows installer's `LICENSE.txt` names
    what the distribution bundles — and none of them is a system library any package manager could speak
    for, so leaving them to the rule below stops every Windows build. The prefix that is too broad on Unix
    is exactly right here: nothing but Python is installed under it. `VCRUNTIME140.dll`, which the
    installer drops at that root too, is the one thing under it that is not CPython; Microsoft's
    redistributable terms let an application carry it and ask for no notice in return.
    """
    trees = {Path(sysconfig.get_paths()[name]).resolve()
             for name in ("stdlib", "platstdlib", "purelib", "platlib")}
    if platform == "win32":
        # Both, because a build run from a virtual environment takes its own site-packages from the first
        # and the interpreter's DLLs from the second.
        trees |= {Path(sys.prefix).resolve(), Path(sys.base_prefix).resolve()}
    # Normalized because these are compared against paths PyInstaller reports, and on Windows the same
    # directory can differ from this one in case and in separator without being a different directory.
    return tuple(sorted(os.path.normcase(str(tree)) for tree in trees))


_PYTHON_TREES = _python_trees()

# The interpreter's own shared library, which is Python rather than something Python links against — it is
# credited by the runtime's entry (`python_runtime_license`) like the rest of the interpreter. Matched by
# name because a relocatable Python keeps it in the installation's `lib/`, one level above every tree
# above, where the check there misses it and no package manager can name a Python that was unpacked rather
# than installed. That is exactly the build CI makes, and it stopped there.
_PYTHON_RUNTIME_LIBRARIES = frozenset(
    Path(name).name
    for name in (sysconfig.get_config_var(var) for var in ("INSTSONAME", "LDLIBRARY", "PY3LIBRARY"))
    if name
)

# Microsoft's C runtime, which a Windows build collects from wherever a copy happens to sit on disk —
# PyInstaller's Windows include list (`PyInstaller/depend/dylib.py`) names these files explicitly and that
# list overrides its own rule against collecting anything from the Windows directory, so neither the
# system copy nor one in some unrelated package's `bin` is left behind. Matched by name because the
# directory a copy came from is therefore meaningless: the release build found the UCRT forwarders in the
# JDK that the CI image happens to put on PATH, and would have found `ucrtbase.dll` in `system32`.
#
# They need no notice. Microsoft's redistributable terms for the Visual Studio runtime permit an
# application to carry these files, which is also what lets `VCRUNTIME140.dll` ride along from the Python
# installation root. `luma.spec` drops the UCRT half of this list from the bundle outright, so in a
# release build only the VC14 runtime reaches here; the UCRT names stay because a build that collects them
# some other way must not be stopped by a file it is allowed to ship.
# Either separator, and the whole path rather than its last component: a Windows path read anywhere else
# has no last component, and the tests are the one place these names are checked off Windows.
_MICROSOFT_RUNTIME_LIBRARY = re.compile(
    r"(^|[\\/])(api-ms-win-.*|ucrtbase|vcruntime140.*|msvcp140.*|concrt140|vccorlib140)\.dll$",
    re.IGNORECASE,
)


class _BundledLibrary(NamedTuple):
    """A library the Python installation itself bundles: which of the collected files belong to it, what
    it declares about itself, and where the version it is credited under is read from. Its license text is
    the `scripts/license-texts/` entry named after it, exactly like a distribution that ships none."""

    files: re.Pattern[str]
    declared: str
    source: str
    version: Callable[[], str]


# What the python.org macOS installer builds into the framework instead of linking from the system.
# `Mac/BuildScript/build-installer.py` configures OpenSSL with the framework version as its prefix, so the
# dylibs land in the installation's `lib/` — one level above every tree `_python_trees` names, where the
# check there misses them — and PyInstaller collects them because `_ssl` links against them.
#
# Nothing else can speak for them. macOS has no package manager that installed them, and the framework's
# `LICENSE.txt` covers CPython alone: that installer substitutes the bundled libraries' *names* into its
# `License.rtf` and installs no license text of theirs anywhere. So they are credited from a supplied text
# like a wheel that ships none, and a bundled library this does not recognize still stops the build —
# which is what pinning the ABI version in the pattern is for. A `libcrypto.4.dylib` would be a new major
# series whose license has to be read again before a kit carries it.
_BUNDLED_FRAMEWORK_LIBRARIES = {
    "OpenSSL": _BundledLibrary(
        files=re.compile(r"^lib(crypto|ssl)\.3\.dylib$"),
        declared="Apache-2.0",
        source="https://www.openssl.org/",
        # Read from the interpreter rather than stated here, because the exact release is whichever one
        # the installer on the build machine happened to bundle, and `_ssl` is linked against the very
        # files being credited. "OpenSSL 3.0.16 11 Feb 2025" is the shape of what it reports.
        version=lambda: ssl.OPENSSL_VERSION.split()[1],
    ),
}


def _read_requirements(path: Path) -> list[Requirement]:
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            lines.append(Requirement(line))
    return lines


def runtime_distributions(requirements: Path = REQUIREMENTS) -> list[Distribution]:
    """Every installed distribution the runtime requirements reach, this platform's answer.

    Extras travel with the requirement that asked for them (`uvicorn[standard]` is the one here), so a
    dependency's markers are evaluated once per extra requested of it — which is what pulls in `uvloop`
    and `httptools` on the platforms that get them and leaves them out where they are not installed.
    """
    wanted: dict[str, set[str]] = {}
    pending = list(_read_requirements(requirements))
    while pending:
        requirement = pending.pop()
        name = canonicalize_name(requirement.name)
        extras = set(requirement.extras)
        if name in wanted and extras <= wanted[name]:
            continue
        try:
            dist = distribution(requirement.name)
        except PackageNotFoundError:
            raise SystemExit(
                f"{requirement.name} is in {requirements.name} but is not installed in {sys.executable}. "
                "The notices are read from installed metadata, so the build environment has to hold "
                "everything the kit will carry."
            )
        wanted[name] = wanted.get(name, set()) | extras
        for entry in dist.requires or []:
            dependency = Requirement(entry)
            if dependency.marker is None:
                pending.append(dependency)
                continue
            # An unconditional dependency is declared with no `extra` marker, so "" stands for "asked for
            # without any extra" and has to be evaluated alongside whichever extras were requested.
            if any(dependency.marker.evaluate({"extra": extra}) for extra in {"", *wanted[name]}):
                pending.append(dependency)
    return [distribution(name) for name in sorted(wanted)]


def license_texts(dist: Distribution) -> list[tuple[str, str]]:
    """The license files a distribution ships, as `(name, text)`."""
    texts = []
    for entry in dist.files or []:
        parts = str(entry).split("/")
        if not any(part.endswith(".dist-info") for part in parts):
            continue
        if not LICENSE_FILE.search(str(entry)):
            continue
        try:
            texts.append((parts[-1], Path(dist.locate_file(entry)).read_text(encoding="utf-8").strip()))
        except OSError:
            continue
    return sorted(texts)


def supplement_text(name: str) -> str | None:
    """The license text supplied here for a distribution that ships none, with the `#` header that says
    where it came from folded into the notice."""
    path = SUPPLEMENT_DIR / f"{canonicalize_name(name)}.txt"
    if not path.is_file():
        return None
    lines = path.read_text(encoding="utf-8").splitlines()
    end = next((i for i, line in enumerate(lines) if not line.startswith("#")), len(lines))
    header = "\n".join(line.lstrip("#").strip() for line in lines[:end]).strip()
    return f"{header}\n\n" + "\n".join(lines[end:]).strip()


def _metadata_license(dist: Distribution) -> str:
    return (dist.metadata.get("License-Expression") or dist.metadata.get("License") or "").split("\n")[0].strip()


def _source(dist: Distribution) -> str:
    for entry in dist.metadata.get_all("Project-URL") or []:
        label, _, url = entry.partition(",")
        if label.strip().lower() in {"homepage", "source", "repository", "source code"}:
            return url.strip()
    return dist.metadata.get("Home-page") or f"https://pypi.org/project/{dist.metadata['Name']}/"


def _system_library_paths(binaries) -> list[Path]:
    """The collected binaries that came from outside the Python installation — the system's own shared
    libraries. `binaries` is PyInstaller's list of `(name, source path, kind)` entries."""
    paths = []
    for entry in binaries:
        source = Path(str(entry[1])).resolve()
        if any(os.path.normcase(str(source)).startswith(tree) for tree in _PYTHON_TREES):
            continue
        if source.name in _PYTHON_RUNTIME_LIBRARIES:
            continue
        if _MICROSOFT_RUNTIME_LIBRARY.search(str(source)):
            continue
        if source.suffix == ".so" or ".so." in source.name or source.suffix in {".dylib", ".dll"}:
            paths.append(source)
    return sorted(set(paths))


def _owning_package(path: Path) -> str | None:
    """Which distribution package installed a file, asked of the package manager that installed it. Debian
    and its derivatives are what the release builds run on; the rpm branch costs one line and covers a
    build on Fedora."""
    if shutil.which("dpkg-query"):
        for candidate in {path, Path(str(path).replace("/usr/lib/", "/lib/", 1)), Path(f"/usr{path}")}:
            found = subprocess.run(
                ["dpkg-query", "-S", str(candidate)], capture_output=True, text=True, check=False,
            )
            if found.returncode == 0 and found.stdout.strip():
                return found.stdout.split(":")[0].split(",")[0].strip()
    if shutil.which("rpm"):
        found = subprocess.run(["rpm", "-qf", "--queryformat", "%{NAME}", str(path)],
                               capture_output=True, text=True, check=False)
        if found.returncode == 0 and found.stdout.strip():
            return found.stdout.strip()
    return None


def _package_copyright(package: str) -> str | None:
    """The package's license text as its own distribution ships it. Debian requires every package to carry
    one at this path, which is what makes this attribution possible at all."""
    debian = Path("/usr/share/doc") / package / "copyright"
    if debian.is_file():
        return debian.read_text(encoding="utf-8", errors="replace").strip()
    if shutil.which("rpm"):
        found = subprocess.run(["rpm", "-q", "--licensefiles", package], capture_output=True, text=True, check=False)
        files = [Path(line.strip()) for line in found.stdout.splitlines() if line.strip()]
        texts = [f.read_text(encoding="utf-8", errors="replace").strip() for f in files if f.is_file()]
        if texts:
            return "\n\n".join(texts)
    return None


def _bundled_component(path: Path, platform: str = sys.platform) -> str | None:
    """Which bundled component a collected library belongs to, or `None` if nothing here speaks for it.

    macOS only, and only for a library that came out of the Python installation itself: on Linux a library
    inside the installation is traced to the package that installed it, and on Windows the whole prefix
    already counts as Python. Restricted to that prefix rather than matched on the file name alone, so a
    copy of OpenSSL from somewhere else on the machine — a Homebrew one, say — stops the build instead of
    being credited to a provenance it does not have."""
    if platform != "darwin":
        return None
    installation = os.path.normcase(str(Path(sys.base_prefix).resolve()))
    if not os.path.normcase(str(path)).startswith(installation):
        return None
    return next((name for name, bundled in _BUNDLED_FRAMEWORK_LIBRARIES.items()
                 if bundled.files.match(path.name)), None)


def native_library_notices(binaries) -> str:
    """The section covering the shared libraries copied out of the build machine, one entry per package —
    or per bundled component, where no package manager installed the library — rather than per file, since
    several libraries usually arrive from one.

    A library nothing can attribute stops the build. It is the same rule the packages follow, and the
    reason is stronger here: a system library carries no metadata of its own, so an unattributed one
    would leave no trace in the finished kit of having been missed."""
    libraries = _system_library_paths(binaries)
    if not libraries:
        return ""
    by_package: dict[str, list[Path]] = {}
    by_component: dict[str, list[Path]] = {}
    unattributed = []
    for path in libraries:
        package = _owning_package(path)
        if package is not None:
            by_package.setdefault(package, []).append(path)
            continue
        component = _bundled_component(path)
        if component is None:
            unattributed.append(str(path))
            continue
        by_component.setdefault(component, []).append(path)
    # Title, the fields it declares, what it accounts for, and the text that governs it.
    entries: list[tuple[str, list[str], list[Path], str]] = []
    for package in sorted(by_package):
        text = _package_copyright(package)
        if text is None:
            unattributed += [str(p) for p in by_package[package]]
            continue
        entries.append((package, [], by_package[package], text))
    for component in sorted(by_component):
        bundled = _BUNDLED_FRAMEWORK_LIBRARIES[component]
        text = supplement_text(component)
        if text is None:
            unattributed += [str(p) for p in by_component[component]]
            continue
        entries.append((
            f"{component} {bundled.version()}",
            [f"License: {bundled.declared}", f"Source: {bundled.source}"],
            by_component[component],
            text,
        ))
    if unattributed:
        raise SystemExit(
            "These shared libraries would be shipped with no license: " + ", ".join(sorted(unattributed))
            + ". They come from the build machine, so nothing else in the kit accounts for them: the "
            "package manager cannot name their package, or that package ships no copyright file, or "
            "(for a library the Python installation bundles rather than links from the system) no "
            "scripts/license-texts entry supplies its text. All of them have to be resolved before a kit "
            "built here can be distributed."
        )
    out = [
        "Third-party shared libraries in the Luma server",
        "",
        "The C libraries the Python runtime and its extension modules link against, copied into this",
        "build from the machine that made it. Each entry is one package of the distribution it came",
        "from, with that package's own copyright and license file. A library the Python installation",
        "bundles rather than links from the system is one entry too, under the component it belongs to,",
        "with the license text that component publishes.",
    ]
    for title, fields, paths, text in entries:
        out += [
            "",
            RULE,
            title,
            *fields,
            "Provides: " + ", ".join(sorted(p.name for p in paths)),
            "",
            text,
        ]
    return "\n".join(out) + "\n"


def python_runtime_license() -> tuple[Path, str]:
    """The license of the Python that will be frozen into the executable. Searched rather than assumed:
    the file sits beside the standard library on Unix and at the installation root on Windows."""
    candidates = [
        Path(sysconfig.get_paths()["stdlib"]) / "LICENSE.txt",
        Path(sys.base_prefix) / "LICENSE.txt",
        Path(sys.base_prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "LICENSE.txt",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate, candidate.read_text(encoding="utf-8", errors="replace").strip()
    raise SystemExit(
        "The Python runtime's LICENSE.txt was not found, so a kit built here would ship the interpreter "
        "without its license. Looked in: " + ", ".join(str(c) for c in candidates)
    )


def server_notices(requirements: Path = REQUIREMENTS) -> str:
    """The server half: the Python runtime, then every distribution frozen in beside it."""
    license_path, python_license = python_runtime_license()
    out = [
        "Third-party software in the Luma server",
        "",
        "The Python runtime and the packages frozen into this build, each with the license text it",
        "ships. Generated from the build environment's installed metadata.",
        "",
        RULE,
        f"Python {sys.version.split()[0]}",
        f"Source: https://www.python.org/ (license as shipped at {license_path.name})",
        "",
        python_license,
    ]
    missing = []
    for dist in runtime_distributions(requirements):
        name = dist.metadata["Name"]
        texts = license_texts(dist)
        if not texts:
            supplied = supplement_text(name)
            if supplied is None:
                missing.append(f"{name} ({_metadata_license(dist) or 'no license declared'})")
                continue
            texts = [("supplied license text", supplied)]
        out += ["", RULE, f"{name} {dist.version}"]
        if _metadata_license(dist):
            out.append(f"License: {_metadata_license(dist)}")
        out.append(f"Source: {_source(dist)}")
        for entry_name, text in texts:
            out += ["", *([f"[{entry_name}]"] if len(texts) > 1 else []), text]
    if missing:
        raise SystemExit(
            "These packages ship no license text: " + ", ".join(missing) + ". Add the upstream text as "
            "scripts/license-texts/<name>.txt, with a leading # line saying where it came from."
        )
    return "\n".join(out) + "\n"


# How an entry announces itself, which both halves of the file agree on: a rule line, the component's
# name, then at least one `Field: value` line naming its license, its source, or what it provides. The
# summary below is read back out of the rendered text for that reason — an index derived from the finished
# file cannot disagree with it, and needs no second pass over npm manifests from a script that never sees
# them.
#
# Read strictly, because a license text is reproduced verbatim and can contain anything, including a rule
# line of its own: Pillow ships a Debian-style copyright whose `Files:` paragraphs are separated that way,
# and a loose reading filed six of them as components. Hence both guards — a component's name carries no
# `Field:` of its own, and the lines under it are *only* the fields an entry declares.
_ENTRY_FIELD = re.compile(r"^(License|Source|Provides): *(.*)$")

# Past this, what the metadata holds is not an identifier. A few older distributions put their entire
# license text in the `License` field, and the first line of one reads as a sentence rather than a name.
_LICENSE_NAME_LIMIT = 60

UNKNOWN_LICENSE = "Other"

# Spellings of the same license, folded so the summary does not list Apache-2.0 three times under three
# names. Spelling only: nothing here decides that one license *is* another, and an identifier this does
# not recognize is shown exactly as the component declared it, ambiguous (`BSD`) or odd (`Dual License`)
# as that may be.
_LICENSE_SPELLINGS = {
    "the mit license": "MIT",
    "mit license": "MIT",
    "apache 2.0": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "bsd-3-clause license": "BSD-3-Clause",
    "bsd-2-clause license": "BSD-2-Clause",
    "isc license": "ISC",
}


def _declared_licenses(section: str) -> list[tuple[str, str]]:
    """Each component in a rendered section, as `(name, declared license)`. The license is `Other` for a
    component that declares none — the Python runtime and the shared libraries, whose terms are stated in
    the text they carry rather than in a field."""
    entries = []
    for block in section.split(f"\n{RULE}\n")[1:]:
        lines = block.strip().splitlines()
        if not lines or _ENTRY_FIELD.match(lines[0]) or ": " in lines[0]:
            continue
        fields = {}
        for line in lines[1:]:
            if not line.strip():
                break
            field = _ENTRY_FIELD.match(line)
            if not field:
                fields.clear()
                break
            fields[field.group(1)] = field.group(2).strip()
        if not fields:
            continue
        declared = " ".join(fields.get("License", "").split())
        if not declared or len(declared) > _LICENSE_NAME_LIMIT:
            declared = UNKNOWN_LICENSE
        entries.append((lines[0].strip(), _LICENSE_SPELLINGS.get(declared.lower(), declared)))
    return entries


def license_index(sections) -> str:
    """The summary that heads the file: every component grouped under the license it declares.

    A summary and not a determination. The identifiers are each component's own claim about itself, a
    handful of components make no claim at all, and one string can stand for a choice of licenses — so
    this is the shape of what the build carries, read before the license texts that actually govern. Worth
    having anyway, because the question it answers — what obligations come with this? — is otherwise
    unanswerable without reading 400 KB of boilerplate.
    """
    grouped: dict[str, list[str]] = {}
    for section in sections:
        for name, license_name in _declared_licenses(section):
            grouped.setdefault(license_name, []).append(name)
    # Alphabetical, with the components that declare nothing last rather than filed under O.
    order = sorted((k for k in grouped if k != UNKNOWN_LICENSE), key=str.lower)
    order += [UNKNOWN_LICENSE] if UNKNOWN_LICENSE in grouped else []
    out = [
        "Components grouped by license",
        "",
    ]
    for license_name in order:
        names = sorted(grouped[license_name], key=str.lower)
        out += ["", f"{license_name} ({len(names)})"]
        out += textwrap.wrap(", ".join(names), width=96, initial_indent="  ", subsequent_indent="  ")
    return "\n".join(out) + "\n"


def combined_notices(web_notices: str, binaries=(), requirements: Path = REQUIREMENTS) -> str:
    """The one file a kit carries: the web interface's notices as the frontend build wrote them, then the
    server's, then the shared libraries this build collected. One file rather than three because a
    recipient looking for a license should not have to know which part of the application something
    belongs to."""
    sections = [web_notices.strip(), server_notices(requirements).strip()]
    native = native_library_notices(binaries).strip()
    if native:
        sections.append(native)
    separator = f"\n\n{RULE}\n{RULE}\n\n"
    # Read from the sections rather than built alongside them, so the index and the entries it indexes
    # cannot drift apart.
    sections.insert(0, license_index(sections).strip())
    return (
        "Third-party licenses\n"
        "\n"
        "Luma is licensed under the GNU AGPL v3.0 or later; see the LICENSE file.\n"
        "This file covers the other software packaged in this build.\n"
        f"{separator}"
        + separator.join(sections)
        + "\n"
    )


def main() -> int:
    """Print the server's notices, for checking what a build would ship without running one."""
    sys.stdout.write(server_notices())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
