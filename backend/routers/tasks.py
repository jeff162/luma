# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Surfaces the nag list shown on the Tasks page and as a badge count on the nav. Each task is
a small "you have things to look at" item — unowned accounts when the user is tracking owners,
unresolved duplicate suspects, uncategorized transactions, etc.

The conditions here are intentionally curated and behavior-sensitive (e.g., owner-related
tasks stay hidden until the household actually uses owner tracking) so a fresh install doesn't
greet the user with a wall of warnings about features they haven't opted into yet.

**Dismissal is a ratcheting high-water mark, not a flag.** A task carrying a `dismiss_key` can be
put away; what is stored is the count it was dismissed at, and the task returns when the count rises
above it. The mark also *falls* to whatever lower count is later observed, and that half is the point:
a plain "hide until the count exceeds 40" swallows new work precisely because the user did some — clear
ten of forty and five new ones arrive, and thirty-five is still under forty, so five genuinely new
items stay hidden forever. Ratcheting down means the comparison is always against the quietest the
list has been since, so anything new re-surfaces. A dismissal for a task that has since gone away
entirely is dropped, which lets the dismissal expire on its own.

The recurring anomaly signals deliberately do NOT use this: each of those is an individually
identifiable finding, so they are dismissed one at a time by fingerprint on the Recurring page
(`services/recurring_signals.py`) and their task counts only ever describe findings still open.
"""

import json

from fastapi import APIRouter, HTTPException, Request
from backend.db.database import get_db
from backend.db.control_database import (
    auth_required,
    get_data_provider_intended,
    get_https_warning_suppressed,
)
from backend import transport
from backend.services import crypto_service
from backend.services.preferences import get_preferences, set_preference
from backend.services.recurring_signals import compute_signals

router = APIRouter()

SEVERITY_WARNING = "warning"
SEVERITY_INFO    = "info"

# Where the per-user dismissal marks live: the data DB's `ui_preference` table, so they ride data
# backups and stay with the ledger they describe.
DISMISSED_PREF_KEY = "ui.tasks.dismissed"


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

    Shown to anyone who **could** approve it — a member holding an unlock method — rather than only to
    someone whose vault happens to be open right now. Gating on `is_unlocked` was the same mistake in two
    places (here and the Connections strip): it treats "cannot approve this second" as "cannot approve",
    and the person it hides the request from is exactly the one who needs telling. Someone who does not
    routinely unlock the vault would otherwise never learn there is anything to unlock *for*, which
    leaves the requester waiting on a signal that is never sent.

    Still not shown to a non-member: they can do nothing about it at any point, so it would be a nag with
    no action behind it.
    """
    user = getattr(request, "state", None) and getattr(request.state, "user", None)
    if not user or not crypto_service.user_has_slot(user["id"]):
        return None
    waiting = [r for r in crypto_service.pending_access_requests() if r["user_id"] != user["id"]]
    if not waiting:
        return None
    names = ", ".join(r["display_name"] for r in waiting)
    return {
        "id":          "vault_access_requests",
        "title":       "Vault access requested",
        "description": f"{names} {'is' if len(waiting) == 1 else 'are'} waiting for access to the "
                       "data-source credential vault. Approving lets them connect and sync data sources."
                       + ("" if crypto_service.is_unlocked(user["id"])
                          else " Unlock the vault first — approving shares the key, so it has to be in hand."),
        "count":       len(waiting),
        "link":        "/accounts?tab=connections",
        "link_label":  "Review vault access",
        "severity":    SEVERITY_INFO,
    }


def _build_tasks(request: Request | None) -> list[dict]:
    """Every task that currently applies, before dismissal is taken into account."""
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
                    "dismiss_key": "unowned_accounts",
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
                "dismiss_key": "uncategorized_txns",
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
                "dismiss_key": "suspect_duplicates",
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
                "dismiss_key": "amazon_reconciliation",
            })

        tasks.extend(_recurring_signal_tasks(conn))

    return tasks


# Each anomaly kind becomes one task naming what it is and pointing at the Recurring page's review
# section, which is where the per-signal actions live. `upcoming` is deliberately not here: a forward
# view of what is due is a budgeting aid, and a badge that counts ordinary life stops meaning anything.
# The two amount-range kinds share a task — a range that has drifted and one that is about to are the
# same maintenance, one occurrence apart.
_SIGNAL_TASKS = [
    {
        "kinds": ("missed",),
        "id": "recurring_missed",
        "title": "Expected recurring charge missing",
        "severity": SEVERITY_WARNING,
        "singular": "recurring charge that was due has not arrived",
        "plural": "recurring charges that were due have not arrived",
        "detail": "A canceled service, a failed payment, or a bill that simply has not been imported yet.",
    },
    {
        "kinds": ("price_change",),
        "id": "recurring_price_change",
        "title": "Recurring charge changed amount",
        "severity": SEVERITY_WARNING,
        "singular": "recurring charge came in away from its established amount",
        "plural": "recurring charges came in away from their established amounts",
        "detail": "A price increase worth knowing about, or a one-off that is not really part of the series.",
    },
    {
        "kinds": ("new_series",),
        "id": "recurring_new_series",
        "title": "New recurring series detected",
        "severity": SEVERITY_INFO,
        "singular": "new recurring series was detected recently",
        "plural": "new recurring series were detected recently",
        "detail": "Confirm the ones that are real — this is where a forgotten trial that started billing shows up.",
    },
    {
        "kinds": ("rule_range", "rule_range_edge"),
        "id": "rule_amount_range",
        "title": "Rule amount range may need adjusting",
        "severity": SEVERITY_WARNING,
        "singular": "recent transaction sits outside a rule's amount range, or right at its edge",
        "plural": "recent transactions sit outside a rule's amount range, or right at its edge",
        "detail": "An amount range decides which rows the rule claims, so a charge that drifts past it "
                  "quietly stops being categorized by that rule.",
    },
]


def _recurring_signal_tasks(conn) -> list[dict]:
    """The recurring anomaly signals, one task per kind. These carry no `dismiss_key`: the signals are
    individually identifiable, so they are dismissed one at a time on the page the task links to, and
    the count here only ever describes findings that are still open."""
    counts = compute_signals(conn)["counts"]
    tasks = []
    for spec in _SIGNAL_TASKS:
        n = sum(counts.get(k, 0) for k in spec["kinds"])
        if not n:
            continue
        tasks.append({
            "id":          spec["id"],
            "title":       spec["title"],
            "description": f"{n} {spec['singular'] if n == 1 else spec['plural']}. {spec['detail']}",
            "count":       n,
            "link":        f"/recurring?signal={spec['kinds'][0]}",
            "link_label":  "Review recurring",
            "severity":    spec["severity"],
        })
    return tasks


def _dismissal_scope(request: Request | None) -> str | None:
    """The preference scope for dismissals, or None when no identity is resolved — an unauthenticated
    caller sees the undismissed list rather than an error, since the badge is fetched early."""
    user = getattr(request, "state", None) and getattr(request.state, "user", None)
    return user["id"] if user else None


def _read_dismissals(scope_id: str | None) -> dict[str, int]:
    if not scope_id:
        return {}
    raw = get_preferences(scope_id).get(DISMISSED_PREF_KEY)
    try:
        parsed = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): int(v) for k, v in parsed.items() if isinstance(v, (int, float))}


def _write_dismissals(scope_id: str | None, marks: dict[str, int]) -> None:
    if scope_id:
        set_preference(scope_id, DISMISSED_PREF_KEY, json.dumps(marks))


def _apply_dismissals(tasks: list[dict], scope_id: str | None) -> tuple[list[dict], list[dict]]:
    """Split the task list into what is shown and what a dismissal is hiding, ratcheting each mark down
    to the lowest count seen since it was set (see the module docstring for why that half matters). A
    mark for a task that no longer applies at all is dropped, so the dismissal expires rather than
    silently covering the task's next appearance."""
    marks = _read_dismissals(scope_id)
    if not marks:
        return tasks, []
    by_key = {t["dismiss_key"]: t for t in tasks if t.get("dismiss_key")}
    updated = dict(marks)
    for key, mark in marks.items():
        task = by_key.get(key)
        if task is None:
            del updated[key]
        elif task["count"] < mark:
            updated[key] = task["count"]
    if updated != marks:
        _write_dismissals(scope_id, updated)
        marks = updated

    visible, hidden = [], []
    for task in tasks:
        mark = marks.get(task.get("dismiss_key"))
        if mark is not None and task["count"] <= mark:
            hidden.append(task)
        else:
            visible.append(task)
    return visible, hidden


@router.get("")
def get_tasks(request: Request = None):
    tasks = _build_tasks(request)
    visible, hidden = _apply_dismissals(tasks, _dismissal_scope(request))
    return {
        "tasks":       visible,
        "total_count": sum(t["count"] for t in visible),
        "open_items":  len(visible),
        "dismissed":   [{"id": t["id"], "dismiss_key": t["dismiss_key"], "title": t["title"], "count": t["count"]}
                        for t in hidden],
    }


@router.post("/dismiss/{dismiss_key}")
def dismiss_task(dismiss_key: str, request: Request = None):
    """Put a task away at its current count. It returns when the count rises above that mark — and the
    mark falls with the count, so work that arrives after some has been cleared still surfaces."""
    scope_id = _dismissal_scope(request)
    if not scope_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    task = next((t for t in _build_tasks(request) if t.get("dismiss_key") == dismiss_key), None)
    if task is None:
        raise HTTPException(status_code=404, detail="No such dismissible task")
    marks = _read_dismissals(scope_id)
    marks[dismiss_key] = task["count"]
    _write_dismissals(scope_id, marks)
    return get_tasks(request)


@router.delete("/dismiss/{dismiss_key}")
def restore_task(dismiss_key: str, request: Request = None):
    """Bring a dismissed task back — the undo behind the toast and the dismissed list."""
    scope_id = _dismissal_scope(request)
    if not scope_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    marks = _read_dismissals(scope_id)
    marks.pop(dismiss_key, None)
    _write_dismissals(scope_id, marks)
    return get_tasks(request)
