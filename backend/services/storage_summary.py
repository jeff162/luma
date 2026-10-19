# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
How much the housekeeping surfaces in Settings are holding, as a handful of numbers.

Settings reads this once when it opens, so its section list can say what is in the trash and how much
the import records take *before* either section is opened — which is when someone decides whether a
section is worth their time. Counts and sizes only: the lists themselves load with their sections.
"""

from backend.db.database import database_bytes
from backend.services.import_detail_storage import detail_storage_total

# The two slices of the transaction trash, as predicates over `txn`. Reconciliation removals are the
# rows an Amazon merge or per-copy discard took out; direct deletes are everything else a user can see
# there. The unified dedupe flow's confirmed duplicates match neither: they belong to their file's
# duplicate report and are restored from it, so the trash neither lists, counts nor empties them.
TRASH_DUPLICATES_SQL = "COALESCE(dedupe_resolved_by, '') IN ('amazon_merge', 'amazon_discard')"
TRASH_DELETED_SQL = "COALESCE(rejection_reason, '') <> 'duplicate_confirmed'"


def trash_counts(conn, *, backup_history: bool = False) -> dict:
    """How many items each Trash subsection holds — the whole bucket, where the section lists a page.
    `backup_history` adds the backup history's trash, which only an administrator is shown."""
    txn = conn.execute(f"""
        SELECT COALESCE(SUM(CASE WHEN {TRASH_DUPLICATES_SQL} THEN 1 ELSE 0 END), 0) AS duplicates,
               COALESCE(SUM(CASE WHEN NOT ({TRASH_DUPLICATES_SQL}) AND {TRASH_DELETED_SQL} THEN 1 ELSE 0 END), 0)
                 AS transactions
        FROM   txn
        WHERE  trashed_at IS NOT NULL
    """).fetchone()
    rules = conn.execute("SELECT COUNT(*) FROM category_rule WHERE deleted_at IS NOT NULL").fetchone()[0]
    counts = {
        "transactions": int(txn["transactions"]),
        "duplicates": int(txn["duplicates"]),
        "rules": int(rules),
    }
    if backup_history:
        counts["backup_history"] = int(conn.execute(
            "SELECT COUNT(*) FROM backup_history WHERE deleted_at IS NOT NULL").fetchone()[0])
    return counts


def storage_summary(conn, *, backup_history: bool = False) -> dict:
    return {
        "database_bytes": database_bytes(conn),
        "import_detail": detail_storage_total(conn),
        "trash": trash_counts(conn, backup_history=backup_history),
    }
