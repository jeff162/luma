"""The two dependency manifests that have to say the same thing.

`pyproject.toml` is what Python packaging reads; `requirements.txt` is what the setup scripts and the
documented `pip install -r` path read. Both files state so in their own comments — requirements.txt
"mirrors [project.dependencies]", requirements-test.txt "mirrors [project.optional-dependencies].test" —
but nothing enforced it, and they had already drifted: two runtime dependencies were installed by every
real install while being absent from the packaging metadata.

The failure is quiet, which is why it is worth a test. Nothing malfunctions for the developer whose venv
was built from requirements.txt; it surfaces later, somewhere else, as a package that installs and then
cannot import — the same shape as the version-literal drift `test_app_version.py` guards against.
"""

import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND = REPO_ROOT / "backend"


def _requirements(filename: str) -> set[str]:
    """The pinned requirements in one file, ignoring comments and blanks. Deliberately compares whole
    specifier strings rather than package names: a version that drifts is exactly as broken as a package
    that is missing, and matching on names alone would let the pins diverge silently."""
    lines = (BACKEND / filename).read_text(encoding="utf-8").splitlines()
    return {
        stripped
        for line in lines
        if (stripped := line.strip()) and not stripped.startswith("#")
    }


def _pyproject() -> dict:
    return tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))


def test_runtime_requirements_mirror_the_project_dependencies():
    project = _pyproject()["project"]
    assert _requirements("requirements.txt") == set(project["dependencies"])


def test_test_requirements_mirror_the_optional_test_dependencies():
    project = _pyproject()["project"]
    assert _requirements("requirements-test.txt") == set(project["optional-dependencies"]["test"])
