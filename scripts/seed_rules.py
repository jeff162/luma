#!/usr/bin/env python3

# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Run once after first launch to populate default categorization rules.
Usage: DB_PATH=./data/fintrack-data.db python3 scripts/seed_rules.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.db.database import get_db, init_db
from backend.services.categorizer import seed_default_rules

init_db()
with get_db() as conn:
    seed_default_rules(conn)
    count = conn.execute("SELECT COUNT(*) FROM category_rule").fetchone()[0]
    print(f"Done - {count} rules in database.")
