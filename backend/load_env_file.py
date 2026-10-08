# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Loads the optional `.env` file into the environment, as a side effect of being imported.

**Every entry point imports this before any other `backend` module**, because the database locations are
read from the environment once, when `backend.db.database` and `backend.db.control_database` are first
imported. Anything that reaches those modules first fixes the paths without `.env`, and nothing corrects
them afterwards — the launcher did exactly that for a while, through `app_config`, so a `DATA_DIR` set in
a portable copy's `.env` was ignored while the same file's port was honored. An import rather than a
function call, so that being first is a property of the import list that can be seen at a glance.

The file is optional — an install without one runs on defaults plus stored settings. When one is present
it stays authoritative over a stale shell environment (override=True), which is also what lets the
Playwright harness redirect LUMA_ENV_FILE at an isolated file and get its throwaway DB paths.
"""

from dotenv import load_dotenv

from backend.runtime_config import env_file_path

load_dotenv(dotenv_path=env_file_path(), override=True)
