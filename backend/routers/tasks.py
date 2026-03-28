"""
tasks.py — Live task/action-item computation

Tasks are computed fresh from the database on every request — no storage needed.
They self-resolve automatically as the user completes the work.

Current tasks:
  unowned_accounts   — accounts with owner_id IS NULL when more than one owner
                       exists. Links to Accounts.
  uncategorized_txns — non-pending transactions with no category. Links to Transactions
                       with the __uncategorized__ filter active.

Adding a new task type:
  Add a query to get_tasks() and append a dict to the result list.
  The frontend Tasks page and Dashboard card render whatever the API returns.
"""

from fastapi import APIRouter
from db.database import get_db

router = APIRouter()

SEVERITY_WARNING = "warning"
SEVERITY_INFO    = "info"


@router.get("")
def get_tasks():
    """
    Return a list of open action items, computed live from the database.
    Each task has: id, title, description, count, link, severity.
    Only tasks with count > 0 are returned.
    """
    tasks = []

    with get_db() as conn:
        owner_count = conn.execute("""
            SELECT COUNT(*) AS n FROM owner
        """).fetchone()["n"]

        if owner_count > 1:
            unowned = conn.execute("""
                SELECT COUNT(*) AS n FROM account WHERE owner_id IS NULL
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

        # ── Uncategorized transactions ────────────────────────────────────────
        uncategorized = conn.execute("""
            SELECT COUNT(*) AS n
            FROM   txn
            WHERE  category_id IS NULL
              AND  is_pending   = 0
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

    return {
        "tasks":       tasks,
        "total_count": sum(t["count"] for t in tasks),
        "open_items":  len(tasks),
    }
