# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Surfaces the nag list shown on the Tasks page and as a badge count on the nav. Each task is
a small "you have things to look at" item — unowned accounts when the user is tracking owners,
unresolved duplicate suspects, uncategorized transactions, etc.

The conditions here are intentionally curated and behavior-sensitive (e.g., owner-related
tasks stay hidden until the household actually uses owner tracking) so a fresh install doesn't
greet the user with a wall of warnings about features they haven't opted into yet.
"""

from fastapi import APIRouter, Request
from backend.db.database import get_db
from backend.db.control_database import (
    auth_required,
    get_data_provider_intended,
    get_https_warning_suppressed,
)
from backend import transport
from backend.services import crypto_service

router = APIRouter()

SEVERITY_WARNING = "warning"
SEVERITY_INFO    = "info"


def _https_setup_task(request: Request | None) -> dict | None:
    # Transport nag: on a networked (non-loopback) bind still served over plain HTTP, credentials and
    # bank secrets would cross the wire in cleartext. Emit when either trigger is live — sign-in
    # protection on (a login cookie to sniff) or a data provider intended (a live bank secret). The
    # provider case is *required* (not dismissible); plain client-server is only *recommended* and is
    # suppressible. Self-clears the moment a request arrives over HTTPS — no stored dismissal for it.
    if request is None or transport.request_is_loopback(request) or transport.request_is_https(request):
        return None
    perimeter_on = auth_required()
    provider_intended = get_data_provider_intended()
    if not (perimeter_on or provider_intended):
        return None
    required = provider_intended
    if not required and get_https_warning_suppressed():
        return None
    return {
        "id":          "configure_https",
        "title":       "Set up HTTPS",
        "description": (
            "This server is reached over the network without HTTPS. "
            + ("A data source is configured, so bank credentials would cross the network in cleartext — "
               "HTTPS is required before connecting."
               if required else
               "Sign-in credentials cross the network in cleartext — configuring HTTPS is recommended.")
            + " Put a TLS-terminating reverse proxy (Caddy) in front of the backend."
        ),
        "count":       1,
        "link":        "/settings",
        "link_label":  "How to set up HTTPS",
        "severity":    SEVERITY_WARNING,
        "required":    required,
        "dismissible": not required,
    }


def _vault_access_task(request: Request | None) -> dict | None:
    """Someone is waiting to be let into the credential vault.

    Shown only to a member who can actually approve it — that means holding the DEK, so an admin with a
    locked vault sees nothing, because there is nothing they could do from here. Without this the
    request is invisible: the person waiting has no way to reach the people who could grant it, and the
    people who could have no reason to open the page where the queue lives.
    """
    user = getattr(request, "state", None) and getattr(request.state, "user", None)
    if not user or not crypto_service.is_unlocked(user["id"]):
        return None
    waiting = [r for r in crypto_service.pending_access_requests() if r["user_id"] != user["id"]]
    if not waiting:
        return None
    names = ", ".join(r["display_name"] for r in waiting)
    return {
        "id":          "vault_access_requests",
        "title":       "Vault access requested",
        "description": f"{names} {'is' if len(waiting) == 1 else 'are'} waiting for access to the "
                       "data-source credential vault. Approving lets them connect and sync data sources.",
        "count":       len(waiting),
        "link":        "/accounts?tab=connections",
        "link_label":  "Review vault access",
        "severity":    SEVERITY_INFO,
    }


@router.get("")
def get_tasks(request: Request = None):
    tasks = []

    https_task = _https_setup_task(request)
    if https_task:
        tasks.append(https_task)

    vault_task = _vault_access_task(request)
    if vault_task:
        tasks.append(vault_task)

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
                    "link":        "/accounts?tab=accounts",
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
        # Counted alongside how many of the pairs are on accounts that have since been merged into one,
        # because the task's sentence names the relationship and a merge retires the cross-account half
        # of it — the same re-derivation the duplicate report does (`_IN_ACCOUNT_RULE_KEYS`). LEFT JOINs
        # so a flag whose matched row has been deleted still counts toward the total it always did.
        suspect_row = conn.execute("""
            SELECT COUNT(*) AS n,
                   SUM(CASE
                         WHEN COALESCE(a1.parent_account_id, a1.id) = COALESCE(a2.parent_account_id, a2.id)
                         THEN 1 ELSE 0
                       END) AS in_account
            FROM   txn t1
            LEFT   JOIN txn t2     ON t2.id = t1.suspect_duplicate_of
            LEFT   JOIN account a1 ON a1.id = t1.account_id
            LEFT   JOIN account a2 ON a2.id = t2.account_id
            WHERE  t1.suspect_duplicate_of IS NOT NULL
              AND  t1.suspect_resolved_at  IS NULL
              AND  t1.trashed_at           IS NULL
        """).fetchone()
        suspect_dupes = suspect_row["n"]
        in_account_dupes = suspect_row["in_account"] or 0

        if suspect_dupes:
            # The unified duplicate-detection report is scoped to a single import batch and
            # is opened from /import-export (each file card with unresolved soft flags carries
            # its own entry-point pill, and collapsed data-source rows surface an aggregate
            # badge). Linking the task here to /import-export lets the user pick which
            # batch's report to open rather than dropping them into a global cross-batch view.
            verb = "s match" if suspect_dupes != 1 else " matches"
            if in_account_dupes == 0:
                relationship = "an existing row on a different account"
            elif in_account_dupes == suspect_dupes:
                relationship = "another row on the same account"
            else:
                relationship = "an existing row already in the ledger"
            tasks.append({
                "id":          "suspect_duplicates",
                "title":       "Possible duplicate transactions",
                "description": f"{suspect_dupes} transaction{verb} {relationship}. "
                               "Open the import that flagged them to review each one.",
                "count":       suspect_dupes,
                "link":        "/import-export",
                "link_label":  "Open Import / Export",
                "severity":    SEVERITY_WARNING,
            })

        # Amazon imports whose reconciliation has actionable items — a duplicate charge to merge/discard, or a
        # split-shipment suggestion to accept/dismiss. Computed from the on-demand reconciliation per Amazon
        # batch (few in practice); plain "No charge found" is intentionally excluded (nothing to resolve).
        from backend.routers.import_export.amazon import BATCH_SOURCE_KIND, reconciliation_attention_count
        amazon_batches = conn.execute(
            "SELECT id FROM import_batch WHERE source_kind = ? AND status = 'completed'",
            (BATCH_SOURCE_KIND,),
        ).fetchall()
        amazon_attention = sum(reconciliation_attention_count(conn, row["id"]) for row in amazon_batches)
        if amazon_attention:
            tasks.append({
                "id":          "amazon_reconciliation",
                "title":       "Amazon orders need review",
                "description": f"{amazon_attention} Amazon order{'s need' if amazon_attention != 1 else ' needs'} "
                               "reconciling — a duplicate charge to resolve, or a split-shipment match to confirm. "
                               "Open the import and review its Amazon reconciliation report.",
                "count":       amazon_attention,
                "link":        "/import-export",
                "link_label":  "Open Import / Export",
                "severity":    SEVERITY_WARNING,
            })

    return {
        "tasks":       tasks,
        "total_count": sum(t["count"] for t in tasks),
        "open_items":  len(tasks),
    }
