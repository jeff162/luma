#!/usr/bin/env python3
"""
Run once after first launch to populate default categorization rules.
Usage: DB_PATH=./data/fintrack.db python3 scripts/seed_rules.py
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../backend"))

from db.database import get_db, init_db
from services.categorizer import seed_default_rules

init_db()
with get_db() as conn:
    seed_default_rules(conn)
    count = conn.execute("SELECT COUNT(*) FROM category_rule").fetchone()[0]
    print(f"Done - {count} rules in database.")
