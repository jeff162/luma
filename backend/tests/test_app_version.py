"""One version, declared in the three places that each have to declare it.

`runtime_config.APP_VERSION` is authoritative — it is what the API reports and what the packaged
artifact is named for. The two packaging manifests cannot derive it: npm reads `package.json` and Python
packaging reads `pyproject.toml` before any of our code runs, so each needs a literal of its own.
`version_sources` states where those literals are; this is the check that keeps them honest.

The failure being prevented is quiet rather than loud. Bumping one manifest and not the others produces
a release whose filename, whose API version, and whose Settings screen disagree, with nothing
malfunctioning to reveal it.
"""

import shutil
import tempfile
from pathlib import Path

import pytest

from backend import runtime_config, version_sources


def test_every_declaration_agrees():
    mismatched = version_sources.disagreements()
    assert not mismatched, (
        f"{runtime_config.APP_VERSION} is authoritative; "
        + ", ".join(f"{where} says {found}" for where, found in mismatched.items())
    )


def test_nothing_else_hardcodes_a_version():
    """The literals removed when the constant was introduced — the FastAPI app version and the two
    frontend fallbacks — each looked harmless and each would have gone stale silently."""
    sources = {
        "backend/main.py": version_sources.REPO_ROOT / "backend" / "main.py",
        "frontend/vite.config.js": version_sources.REPO_ROOT / "frontend" / "vite.config.js",
        "frontend/src/lib/appConfig.js":
            version_sources.REPO_ROOT / "frontend" / "src" / "lib" / "appConfig.js",
    }
    for label, path in sources.items():
        # Comments may name the version in prose; code may not embed it.
        code = "\n".join(
            line for line in path.read_text().split("\n")
            if not line.lstrip().startswith(("#", "//", "*"))
        )
        assert runtime_config.APP_VERSION not in code, (
            f"{label} embeds the version literal instead of reading it from runtime_config.APP_VERSION"
        )


@pytest.fixture
def sandboxed_declarations(monkeypatch):
    """Copies of the three real files, so the rewrite can be exercised without editing the repo."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "backend").mkdir()
        (root / "frontend").mkdir()

        copies = {
            "RUNTIME_CONFIG": (version_sources.RUNTIME_CONFIG, root / "backend" / "runtime_config.py"),
            "PYPROJECT": (version_sources.PYPROJECT, root / "backend" / "pyproject.toml"),
            "PACKAGE_JSON": (version_sources.PACKAGE_JSON, root / "frontend" / "package.json"),
        }
        for attribute, (real, copy) in copies.items():
            shutil.copyfile(real, copy)
            monkeypatch.setattr(version_sources, attribute, copy)
        monkeypatch.setattr(version_sources, "REPO_ROOT", root)

        yield {name: copy for name, (_, copy) in copies.items()}


def test_a_bump_rewrites_every_declaration(sandboxed_declarations):
    changed = version_sources.set_version("9.8.7")

    assert sorted(changed) == [
        "backend/pyproject.toml", "backend/runtime_config.py", "frontend/package.json",
    ]
    assert 'APP_VERSION = "9.8.7"' in sandboxed_declarations["RUNTIME_CONFIG"].read_text()
    assert 'version = "9.8.7"' in sandboxed_declarations["PYPROJECT"].read_text()
    assert '"version": "9.8.7"' in sandboxed_declarations["PACKAGE_JSON"].read_text()


def test_a_bump_leaves_dependency_pins_alone(sandboxed_declarations):
    """`pyproject.toml` is full of `==` pins and `package.json` of dependency ranges; a loose pattern
    would rewrite those into the app's version and the mistake would look like a dependency bump."""
    before = sandboxed_declarations["PYPROJECT"].read_text()
    version_sources.set_version("9.8.7")
    after = sandboxed_declarations["PYPROJECT"].read_text()

    assert "fastapi==0.115.0" in after
    assert after.count("9.8.7") == 1
    assert before.count("\n") == after.count("\n")


def test_a_malformed_version_is_refused(sandboxed_declarations):
    """A typo here propagates into an artifact filename and a released API response."""
    original = sandboxed_declarations["RUNTIME_CONFIG"].read_text()

    with pytest.raises(ValueError):
        version_sources.set_version("v9.8")

    assert sandboxed_declarations["RUNTIME_CONFIG"].read_text() == original
