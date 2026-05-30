# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Surfaces the nag list shown on the Tasks page and as a badge count on the nav. Each task is
a small "you have things to look at" item — unowned accounts when the user is tracking owners,
unresolved duplicate suspects, uncategorized transactions, etc.

The conditions here are intentionally curated and behavior-sensitive (e.g., owner-related
tasks stay hidden until the household actually uses owner tracking) so a fresh install doesn't
greet the user with a wall of warnings about features they haven't opted into yet.
"""

from fastapi import APIRouter
from backend.db.database import get_db

router = APIRouter()

SEVERITY_WARNING = "warning"
SEVERITY_INFO    = "info"


@router.get("")
def get_tasks():
    tasks = []

    with get_db() as conn:
        owner_count = conn.execute("""
            SELECT COUNT(*) AS n FROM owner
        """).fetchone()["n"]

        if owner_count > 0:
            # Owner-related tasks stay hidden until the household actually uses owner
            # tracking, so a fresh single-user install does not start with noisy warnings.
            unowned = conn.execute("""
                SELECT COUNT(*) AS n
                FROM account
                WHERE owner_id IS NULL
                  AND parent_account_id IS NULL
                  AND trashed_at IS NULL
            """).fetchone()["n"]

            if unowned:
                tasks.append({
                    "id":          "unowned_accounts",
                    "title":       "Accounts need an owner",
                    "description": f"{unowned} account{'s have' if unowned != 1 else ' has'} no owner assigned. "
                                   "Assign each account to a specific owner.",
                    "count":       unowned,
                    "link":        "/accounts",
                    "link_label":  "Review accounts",
                    "severity":    SEVERITY_WARNING,
                })

        # Pending transactions are intentionally excluded because the rest of the product
        # also keeps them out of reporting and categorization chores until they settle.
        # Trashed rows are excluded too: they no longer appear in the Transactions list the
        # task links to, so counting them here would overstate the work and never reach zero.
        uncategorized = conn.execute("""
            SELECT COUNT(*) AS n
            FROM   txn
            WHERE  category_id IS NULL
              AND  is_pending   = 0
              AND  trashed_at   IS NULL
        """).fetchone()["n"]

        if uncategorized:
            tasks.append({
                "id":          "uncategorized_txns",
                "title":       "Uncategorized transactions",
                "description": f"{uncategorized} transaction{'s have' if uncategorized != 1 else ' has'} "
                               "no category. Categorizing them improves your Dashboard and reports.",
                "count":       uncategorized,
                "link":        "/transactions?uncategorized=1",
                "link_label":  "Review transactions",
                "severity":    SEVERITY_INFO,
            })

        # Soft-detected duplicates flagged at import time (new account on either side) or after
        # an account merge. They never auto-trash, so they linger here until the user reviews.
        suspect_dupes = conn.execute("""
            SELECT COUNT(*) AS n
            FROM   txn
            WHERE  suspect_duplicate_of IS NOT NULL
              AND  suspect_resolved_at  IS NULL
              AND  trashed_at           IS NULL
        """).fetchone()["n"]

        if suspect_dupes:
            # The unified duplicate-detection report is scoped to a single import batch and
            # is opened from /import-export (each file card with unresolved soft flags carries
            # its own entry-point pill, and collapsed data-source rows surface an aggregate
            # badge). Linking the task here to /import-export lets the user pick which
            # batch's report to open rather than dropping them into a global cross-batch view.
            tasks.append({
                "id":          "suspect_duplicates",
                "title":       "Possible duplicate transactions",
                "description": f"{suspect_dupes} transaction{'s match' if suspect_dupes != 1 else ' matches'} "
                               "an existing row on a different account. Open the import that flagged them to review each one.",
                "count":       suspect_dupes,
                "link":        "/import-export",
                "link_label":  "Open Import / Export",
                "severity":    SEVERITY_WARNING,
            })

    return {
        "tasks":       tasks,
        "total_count": sum(t["count"] for t in tasks),
        "open_items":  len(tasks),
    }
