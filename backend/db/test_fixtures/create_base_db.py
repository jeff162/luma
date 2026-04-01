"""
Create a brand-new database using the baseline schema/runtime bootstrap.

This is the base fixture creator for the oldest currently supported schema
shape. As new migrations are introduced, newer historical creators can be added
alongside it (for example `create_v2_db.py`, `create_v3_db.py`, etc.).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from backend.db.database import init_db


def create_base_db(output_path: str):
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite existing database: {target}")
    init_db(str(target))


def main():
    parser = argparse.ArgumentParser(description="Create a database in the baseline FinTrack schema.")
    parser.add_argument("output", help="Path to the SQLite database file to create")
    args = parser.parse_args()
    create_base_db(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
