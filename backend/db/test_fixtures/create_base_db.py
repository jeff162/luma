# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
IMPORTANT: Historical migration fixture.

Do not change the database format produced by this file. Refactors are fine if
they preserve the exact schema/version and intended fixture shape. This file
represents the database immediately before the oldest still-supported
migration. If a different schema outcome is required, add or rename fixture
files according to backend/db/test_fixtures/README.md instead of changing the
meaning of this file.

Create a pre-v1 database used to test the v1 migration.

As long as the v1 migration exists in runtime code, `create_base_db.py`
represents the database shape immediately before v1. Once v1 migration support
is removed, the then-oldest surviving versioned creator should be renamed to
`create_base_db.py` and the old versioned filename deleted.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.db.database import init_db


def create_base_db(output_path: str):
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite existing database: {target}")

    # Bootstrap the latest schema, then remove db_meta so this fixture behaves
    # like a database from immediately before migration v1 existed.
    init_db(str(target))
    conn = sqlite3.connect(target)
    try:
        conn.execute("DROP TABLE IF EXISTS db_meta")
        conn.commit()
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Create a database in the baseline FinTrack schema.")
    parser.add_argument("output", help="Path to the SQLite database file to create")
    args = parser.parse_args()
    create_base_db(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
