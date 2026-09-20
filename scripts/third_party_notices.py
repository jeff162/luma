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

**The shared libraries are the third source, and only Linux has them.** PyInstaller copies the C
libraries the interpreter and the extension modules link against out of the build machine — OpenSSL,
SQLite, zlib and a dozen others — so a Linux kit conveys software that arrived from neither PyPI nor
python.org. They are attributed through the build machine's own package manager, which is what Debian's
`/usr/share/doc/<package>/copyright` files exist for. macOS links its system frameworks instead of
copying them, and the official Windows Python carries the licenses of what it bundles in its own
`LICENSE.txt`, so both of those are already covered.
"""

import re
import shutil
import subprocess
import sys
import sysconfig
from importlib.metadata import Distribution, PackageNotFoundError, distribution
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = ROOT / "backend" / "requirements.txt"
SUPPLEMENT_DIR = ROOT / "scripts" / "license-texts"

# A file inside a `.dist-info` directory that holds license text rather than metadata. Modern wheels put
# these under `licenses/` (PEP 639) or `license_files/`; older ones drop them beside `METADATA`.
LICENSE_FILE = re.compile(r"(^|/)(licen[cs]e|copying|notice|authors)([-._].*)?$", re.IGNORECASE)

RULE = "-" * 78

# Where a distribution's own files live, so a collected binary can be told from a system library: an
# extension module under the standard library or in site-packages is already covered by Python's entry or
# by its package's. Deliberately the specific library directories and not `sys.prefix`, which on a
# system Python is `/usr` and would swallow every shared library on the machine.
_PYTHON_TREES = tuple(sorted({
    str(Path(sysconfig.get_paths()[name]).resolve())
    for name in ("stdlib", "platstdlib", "purelib", "platlib")
}))


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
        if any(str(source).startswith(tree) for tree in _PYTHON_TREES):
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


def native_library_notices(binaries) -> str:
    """The section covering the shared libraries copied out of the build machine, one entry per package
    rather than per file, since several libraries usually arrive from one.

    A library nothing can attribute stops the build. It is the same rule the packages follow, and the
    reason is stronger here: a system library carries no metadata of its own, so an unattributed one
    would leave no trace in the finished kit of having been missed."""
    libraries = _system_library_paths(binaries)
    if not libraries:
        return ""
    by_package: dict[str, list[Path]] = {}
    unattributed = []
    for path in libraries:
        package = _owning_package(path)
        if package is None:
            unattributed.append(str(path))
            continue
        by_package.setdefault(package, []).append(path)
    texts = {}
    for package in list(by_package):
        text = _package_copyright(package)
        if text is None:
            unattributed += [str(p) for p in by_package[package]]
            del by_package[package]
            continue
        texts[package] = text
    if unattributed:
        raise SystemExit(
            "These shared libraries would be shipped with no license: " + ", ".join(sorted(unattributed))
            + ". They come from the build machine, so either the package manager cannot name their "
            "package or that package ships no copyright file; both have to be resolved before a kit "
            "built here can be distributed."
        )
    out = [
        "Third-party shared libraries in the Luma server",
        "",
        "The C libraries the Python runtime and its extension modules link against, copied into this",
        "build from the machine that made it. Each entry is one package of the distribution it came",
        "from, with that package's own copyright and license file.",
    ]
    for package in sorted(by_package):
        out += [
            "",
            RULE,
            package,
            "Provides: " + ", ".join(sorted(p.name for p in by_package[package])),
            "",
            texts[package],
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
    return (
        "Third-party licenses\n"
        "\n"
        "Luma itself is licensed under the GNU AGPL v3.0 or later; see the LICENSE file beside this one.\n"
        "This file covers the other software included in this build. Each entry names a component and\n"
        "reproduces the license text it ships.\n"
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
