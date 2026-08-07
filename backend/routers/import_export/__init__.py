"""
Import/export package.

The import/export workflow is concentrated in one feature area on purpose (see
`docs/architecture.md`): preview, run, undo, dedupe, history, category review, and rule
suggestions all share decisions and helpers, so the cohesive run-import + dedupe-context +
batch-history/undo/duplicate-report core lives together in `core`. Only the cleanly-separable
concerns are split out as leaf modules that depend on `core` (never the reverse):

- `profiles` — saved data-source / import-profile CRUD
- `backup`   — data/credentials backup + restore and CSV export
- `preview`  — the CSV preview entry point

This package preserves the original `backend.routers.import_export` import surface: every name
the rest of the codebase and the tests imported from the old single module is re-exported here,
and `router` is the combined router registered by `backend/main.py`.
"""

from fastapi import APIRouter

# `amazon` imports from `core`, so it must be imported after it (core is listed first).
from . import backup, core, preview, profiles, amazon

# Re-export the public surface so `from backend.routers.import_export import X` keeps working
# for callers and tests exactly as it did when this was a single module.
from .core import *  # noqa: F401,F403
from .core import (  # noqa: F401  (underscore-prefixed helpers exercised directly by tests)
    _get_system_rule_suggestion_review_state,
    _save_system_rule_suggestion_review_state,
    _set_batch_imported_category_usage,
)
from .profiles import *  # noqa: F401,F403
from .backup import *  # noqa: F401,F403
from .preview import *  # noqa: F401,F403

# Single combined router for main.py. Each module owns its own APIRouter; assembling them here
# keeps registration a one-liner and lets the split stay invisible to the rest of the app.
router = APIRouter()
router.include_router(core.router)
router.include_router(profiles.router)
router.include_router(backup.router)
router.include_router(preview.router)
router.include_router(amazon.router)
