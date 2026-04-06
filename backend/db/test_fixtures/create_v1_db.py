# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
IMPORTANT: Historical migration fixture.

Do not change the database format produced by this file. Refactors are fine if
they preserve the exact schema/version and intended fixture shape. This file
represents a fresh database already at schema version 1. If a different schema
outcome is required, add or rename fixture files according to
backend/db/test_fixtures/README.md instead of changing the meaning of this
file.

Create a brand-new database in schema version 1.

This fixture represents the fresh-install database shape for migration level 1.
It intentionally uses runtime bootstrap for the current schema, because fresh
databases should be created directly in the latest supported format.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.db.database import CURRENT_VERSION, init_db


def create_v1_db(output_path: str):
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite existing database: {target}")
    init_db(str(target))


def main():
    parser = argparse.ArgumentParser(
        description=f"Create a database in FinTrack schema version {CURRENT_VERSION}."
    )
    parser.add_argument("output", help="Path to the SQLite database file to create")
    args = parser.parse_args()
    create_v1_db(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
