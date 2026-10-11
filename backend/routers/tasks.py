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

**Every task is dismissible unless it is required.** The Tasks page is a reminder, so dismissing a card
hides the reminder and nothing else: the state it reports stays on the page it links to. That holds for
tasks whose findings have their own per-item answer too — a recurring signal dismissed by fingerprint on
the Recurring page, a reimbursement snoozed — because putting the reminder away ("two of these are waiting
on someone else") is a different statement from answering a finding. The only exception is a task that
declares itself `required` (HTTPS with a data provider configured), which stays until it is fixed.
`_with_dismiss_keys` applies the rule in one place, so a new task is dismissible without opting in.

This reverses an earlier design that withheld dismissal from the connection, vault-access, recurring,
rule-drift and reimbursement tasks, each for a reason about the underlying state. Those reasons are about
the finding, not the reminder; don't re-impose them here.
"""

import json

from fastapi import APIRouter, HTTPException, Request
from backend.authorization import is_admin_or_local
from backend.db.database import get_db
from backend.db.control_database import (
    auth_required,
    get_data_provider_intended,
    get_https_warning_suppressed,
)
from backend import app_log_file, runtime_config, transport
from backend.services import crypto_service, update_check
from backend.services.preferences import get_preferences, set_preference
from backend.services.connection_mapping import unmapped_count
from backend.services.recurring_signals import compute_signals
from backend.services.rule_range_drift import find_range_drift
from backend.services.reimbursements import due_reminders

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
    # provider case is *required* (never dismissible); plain client-server is only *recommended*, so it is
    # dismissible from Tasks like any other reminder (and still honors the older persisted suppression).
    # Self-clears the moment a request arrives over HTTPS.
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
            + ("A data provider is configured, so bank credentials would cross the network in cleartext — "
               "HTTPS is required before connecting."
               if required else
               "Sign-in credentials and the session cookie cross the network in cleartext — configuring "
               "HTTPS is recommended.")
            + " Passkeys, for unlocking the credential vault, also need HTTPS."
            + " Put a TLS-terminating reverse proxy (Caddy) in front of the backend."
        ),
        "count":       1,
        "link":        "/settings",
        "link_label":  "How to set up HTTPS",
        "severity":    SEVERITY_WARNING,
        "required":    required,
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
                       "data provider credential vault. Approving lets them connect and sync data providers."
                       + ("" if crypto_service.is_unlocked(user["id"])
                          else " Unlock the vault first — approving shares the key, so it has to be in hand."),
        "count":       len(waiting),
        "link":        "/accounts?tab=connections",
        "link_label":  "Review vault access",
        "severity":    SEVERITY_INFO,
    }


def _server_error_task(request: Request | None) -> dict | None:
    """Errors in the server's log that no administrator has seen (`backend/app_log_file.py`).

    A crashed request tells whoever hit it only that something failed, and with several users the admin
    who could read the traceback may never hear of it at all. Shown to exactly who can open the Error log
    it links to — the same predicate that page's endpoint enforces. Opening that page acknowledges the
    count for the whole install, which takes this away; dismissing it here hides it until the next error.
    """
    if request is None or not is_admin_or_local(request):
        return None
    unseen = app_log_file.error_counts()["unacknowledged"]
    if not unseen:
        return None
    return {
        "id":          "server_errors",
        "title":       "The server logged an error" if unseen == 1 else "The server logged errors",
        "description": f"{unseen} error{'' if unseen == 1 else 's'} recorded since the error log was last "
                       "opened. Each is a failure the server did not handle, and its entry in the log "
                       "says where it happened.",
        "count":       unseen,
        "link":        "/settings?section=errorLog",
        "link_label":  "Open the error log",
        "severity":    SEVERITY_WARNING,
    }


def _update_available_task(request: Request | None) -> dict | None:
    """A newer release than the running copy, when the install has opted in to checking for one
    (`services/update_check.py`). Shown to whoever could install it. The dismissal key carries the
    version, so putting the reminder away covers that release only and the next one raises it again."""
    if request is None or not is_admin_or_local(request) or not update_check.is_enabled():
        return None
    version = update_check.available_version()
    if not version:
        return None
    return {
        "id":          "update_available",
        "dismiss_key": f"update_available:{version}",
        "title":       f"Version {version} is available",
        "description": f"This copy is version {runtime_config.APP_VERSION}. The release notes and the "
                       "download are on the releases page.",
        "count":       1,
        "link":        "/settings?section=about",
        "link_label":  "Open About",
        "severity":    SEVERITY_INFO,
    }


def _connection_tasks(conn) -> list[dict]:
    """A data connection that has stopped working, or is silently skipping an account.

    These exist because the connections UI is now deliberately split in two: what a connection *is* is
    configured on the Accounts page, and what it has been *doing* lives with the imports on Import /
    Export. Both surfaces show these states, but a user only sees them by visiting one — and the whole
    point of these three is that they are discovered by a sync and cost the user data until acted on. The
    nav badge is the surface that finds the user instead, which is what the Tasks page is for.

    Three separate tasks rather than one "connections need attention", because the remedies are different
    pages' worth of different work and a merged count could not link anywhere useful.

    Dismissible like every task (see the module docstring): the connection card keeps showing the broken
    state. Worth knowing when reading a report about one: these counts do not fall on their own, so a
    dismissed one stays hidden until another connection breaks or the first is fixed.
    """
    tasks = []
    rows = conn.execute(
        "SELECT provider, institution, reauth_required, consecutive_sync_failures FROM connection"
    ).fetchall()

    reauth = [r for r in rows if r["reauth_required"]]
    if reauth:
        names = ", ".join(r["institution"] or r["provider"] for r in reauth)
        tasks.append({
            "id":          "connections_need_reauth",
            "title":       "A data connection needs reconnecting"
                           if len(reauth) == 1 else "Data connections need reconnecting",
            "description": f"{names} no longer accepts the stored credential, so syncing has stopped and "
                           "no new transactions are arriving. Reconnecting restores it in place, keeping "
                           "the accounts, their mapping and the history already fetched.",
            "count":       len(reauth),
            "link":        "/accounts?tab=connections",
            "link_label":  "Reconnect",
            "severity":    SEVERITY_WARNING,
        })

    # A connection needing reconnection is also failing, and is reported only as the former: two entries
    # would name one problem twice and only one of them says what to do. Same rule the cards apply.
    failing = [r for r in rows
               if (r["consecutive_sync_failures"] or 0) > 0 and not r["reauth_required"]]
    if failing:
        names = ", ".join(r["institution"] or r["provider"] for r in failing)
        tasks.append({
            "id":          "connections_failing",
            "title":       "A data connection is failing to sync"
                           if len(failing) == 1 else "Data connections are failing to sync",
            "description": f"The last sync of {names} did not complete. The sync log says what the "
                           "provider reported, which is the difference between a bank being briefly "
                           "unavailable and something that needs fixing.",
            "count":       len(failing),
            "link":        "/import-export",
            "link_label":  "Open the sync log",
            "severity":    SEVERITY_WARNING,
        })

    # Counted in provider accounts rather than connections: the number the user acts on is how many
    # accounts still need a destination, which is what the mapping dialog presents.
    unmapped = unmapped_count(conn)
    if unmapped:
        tasks.append({
            "id":          "connection_accounts_unmapped",
            "title":       "An account from a data connection has no destination"
                           if unmapped == 1 else "Accounts from a data connection have no destination",
            "description": f"{unmapped} account{'' if unmapped == 1 else 's'} offered by a connected bank "
                           f"{'has' if unmapped == 1 else 'have'} nowhere to import into, so every sync "
                           f"skips {'it' if unmapped == 1 else 'them'} — silently, since a skipped "
                           "account appears nowhere else in the app.",
            "count":       unmapped,
            "link":        "/accounts?tab=connections",
            "link_label":  "Choose destinations",
            "severity":    SEVERITY_WARNING,
        })
    return tasks


def _build_tasks(request: Request | None) -> list[dict]:
    """Every task that currently applies, before dismissal is taken into account."""
    tasks = []

    https_task = _https_setup_task(request)
    if https_task:
        tasks.append(https_task)

    vault_task = _vault_access_task(request)
    if vault_task:
        tasks.append(vault_task)

    error_task = _server_error_task(request)
    if error_task:
        tasks.append(error_task)

    update_task = _update_available_task(request)
    if update_task:
        tasks.append(update_task)

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
                "link":        "/transactions?only=uncategorized",
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

        # Files a watched folder could not take on its own. The count is read from the persisted
        # per-file record, never from the filesystem — a badge that scanned a network share would make
        # every page load wait on it. Each of these is answered the same way, by opening the file in the
        # ordinary import flow, so one task carries them all.
        from backend.routers.import_export.watch import attention_counts
        watch_attention = attention_counts(conn)
        if watch_attention["total"]:
            waiting = watch_attention["total"]
            tasks.append({
                "id":          "watched_import_files",
                "title":       "Files waiting in a watched folder",
                "description": f"{waiting} file{'s were' if waiting != 1 else ' was'} left for review rather "
                               "than imported — an account the data source has not been shown, a layout it is "
                               + ("not set up for, or a file that could not be deleted after import. "
                                  if watch_attention["purge_failed"] else "not set up for, or an import that failed. ")
                               + "Open each one in the import flow to finish it.",
                "count":       waiting,
                "link":        "/import-export",
                "link_label":  "Open Import / Export",
                "severity":    SEVERITY_WARNING,
            })

        # The PayPal reconciliation is about the whole ledger rather than one file — matches are made after
        # syncs as well as imports — so it has one entry, and its link opens the review itself.
        from backend.services.paypal_funding import ledger_attention_count
        paypal_attention = ledger_attention_count(conn)
        if paypal_attention:
            tasks.append({
                "id":          "paypal_funding",
                "title":       "PayPal transactions to reconcile",
                "description": f"{paypal_attention} item{'s need' if paypal_attention != 1 else ' needs'} a look: a "
                               "PayPal transaction with more than one possible bank or card match, one that moved "
                               "money with no matching transaction found, or a PayPal charge on a bank or card "
                               "account with no PayPal record.",
                "count":       paypal_attention,
                "link":        "/import-export?review=paypal",
                "link_label":  "Open the PayPal review",
                "severity":    SEVERITY_WARNING,
            })

        tasks.extend(_recurring_signal_tasks(conn))
        tasks.extend(_rule_range_drift_tasks(conn))
        tasks.extend(_reimbursement_tasks(conn))
        tasks.extend(_connection_tasks(conn))

    return _with_dismiss_keys(tasks)


def _with_dismiss_keys(tasks: list[dict]) -> list[dict]:
    """Make every task dismissible except one that declares itself `required`. The key is the task id, so
    a per-owner task (reimbursements) is dismissed per owner, and the ids the original four dismissible
    tasks stored their marks under are unchanged. A task that supplies its own key keeps it."""
    for task in tasks:
        if not task.get("required"):
            task.setdefault("dismiss_key", task["id"])
    return tasks


def _reimbursement_tasks(conn) -> list[dict]:
    """Receivables that have gone quiet for longer than they should have, one task per owner.

    **Why this is a task at all**: until a receivable is settled, spending is under-reported — the
    disease the flag-and-exclude model was rejected for, differing only in that the amount is visible
    here. Nothing else in the app goes looking for money that never came back.

    **One task per owner, gated on the household actually having several people.** Someone with a
    reminder on their own card can act on it and leave another person's alone, which is the whole reason
    the split exists; below that threshold the split would be a heading over a single group. The gate is
    `owner_grouping_applies` rather than "any owner exists", because a built-in *Shared* owner appears
    the first time the Owners page is opened.

    Each receivable also carries a per-record snooze, which is the answer about *that* receivable. The
    task's own dismissal only puts the reminder away, and it returns when another receivable comes due.
    """
    report = due_reminders(conn)
    if not report["total"]:
        return []
    if not report["grouped"]:
        return [_reimbursement_task(group=None, count=report["total"])]
    return [
        _reimbursement_task(group=group, count=group["count"])
        for group in report["groups"]
    ]


def _reimbursement_task(*, group: dict | None, count: int) -> dict:
    # The link opens the reimbursements report already narrowed to what the task counted, so the screen
    # and the badge cannot disagree about which rows are meant. `owner_ids` is the token the transaction
    # list's own owner facet uses, including `unassigned` for an account nobody owns.
    link = "/transactions?reimbursements=1&due=1"
    if group:
        link += f"&owner_ids={group['owner_id']}"
    whose = f" — {group['owner_name']}" if group else ""
    return {
        "id":          f"reimbursements_due_{group['owner_id']}" if group else "reimbursements_due",
        "title":       f"Reimbursements to chase{whose}",
        "description": f"{count} reimbursable expense{'s have' if count != 1 else ' has'} been waiting "
                       "longer than expected. Chase it, push the reminder out, or complete it if the "
                       "money is never coming back.",
        "count":       count,
        "link":        link,
        "link_label":  "Review reimbursements",
        "severity":    SEVERITY_WARNING,
    }


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
]


def _recurring_signal_tasks(conn) -> list[dict]:
    """The recurring anomaly signals, one task per kind. Each signal is also dismissed one at a time on the
    page the task links to, and the count here only ever describes findings still open there; dismissing
    the task hides the reminder until another finding of that kind appears."""
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


def _rule_range_drift_tasks(conn) -> list[dict]:
    """The charges an amount-gated rule nearly claimed. One task covering both kinds rather than two,
    because they are one situation reported at two moments — the range has drifted — and the fix is the
    same rule either way. Like the recurring signals, each finding is also dismissed individually on the
    Rules page this links to."""
    counts = find_range_drift(conn)["counts"]
    n = sum(counts.values())
    if not n:
        return []
    return [{
        "id":          "rule_amount_range",
        "title":       "Rule amount range may need adjusting",
        "description": f"{n} recent transaction{'' if n == 1 else 's'} "
                       f"{'sits' if n == 1 else 'sit'} outside a rule's amount range, or right at its "
                       "edge. An amount range decides which rows the rule claims, so a charge that "
                       "drifts past it quietly stops being categorized by that rule.",
        "count":       n,
        "link":        "/rules?findings=range-drift",
        "link_label":  "Review rules",
        "severity":    SEVERITY_WARNING,
    }]


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
