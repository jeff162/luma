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
declares itself `required` because it blocks something until it is fixed (a proxy certificate devices do
not trust, a vault passphrase that has to change), which stays until it is.
`_with_dismiss_keys` applies the rule in one place, so a new task is dismissible without opting in.

**A task marked `mutable` can also be muted**, which hides it however high its count goes until it is
dismissed or restored. It is for a count expected to keep rising while someone deals with the cause, as a
rule alert's does (`services/rule_alerts.py`). A mute is kept with the dismissal marks, per person, and
expires the same way.

**Tasks are ordered like an inbox, per person.** Each task's last-needed-attention moment is when it first
appeared or its count last rose (`ui.tasks.attention`, kept like the dismissal marks and ratcheting down
with the count the same way, so new work after some was cleared still counts as a rise). A task is unread
when that moment is later than the person's last visit to the Tasks page (`ui.tasks.visited_at`). Required
tasks come first, then the unread ones, then the rest, `alert` level before `routine` in both; newest first
within each, so a read task keeps its place among the read until its count rises again. The level is about how often a task comes
up: an `alert` is an exception that rarely arises (a transaction on a closed account, a rule alert, a failing
connection), a `routine` one is the steady flow of work (uncategorized rows, duplicates, recurring events).
Tracked on the whole count, before the owner lens, as dismissal is.

This reverses an earlier design that withheld dismissal from the connection, vault-access, recurring,
rule-drift and reimbursement tasks, each for a reason about the underlying state. Those reasons are about
the finding, not the reminder; don't re-impose them here.
"""

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from backend.authorization import is_admin_or_local, shows_admin_features
from backend.db.database import get_db
from backend.db.control_database import (
    auth_required,
    credentials_exports_detail,
    credentials_reissued_at,
    get_https_warning_suppressed,
    latest_vault_key_retirement,
)
from backend import app_log_file, runtime_config, transport
from backend.services import (
    closed_accounts, crypto_service, group_primary, proxy_certificate, rule_alerts, rule_conflicts, update_check,
    wallet_pairs,
)
from backend.services.preferences import get_preferences, set_preference
from backend.services.connection_mapping import unmapped_count
from backend.services.recurring_detection import overdue_owed_rescan_count, series_shown_under_lens, transfer_review
from backend.services.recurring_signals import compute_signals, narrow_signals
from backend.services.rule_range_drift import find_range_drift
from backend.services.reimbursements import due_reminders
from backend.services.transaction_facets import owner_lens_admits, owner_membership, split_ids
from backend.time_utils import utcnow_iso

router = APIRouter()

SEVERITY_WARNING = "warning"
SEVERITY_INFO    = "info"

# How often a task comes up, for ordering the unread ones (see the module docstring). `routine` is the default.
LEVEL_ALERT   = "alert"
LEVEL_ROUTINE = "routine"

# The Accounts page's Connections tab, where a connection is set up and repaired and the vault strip is.
# The frontend's `CONNECTIONS_ROUTE` names the same place.
CONNECTIONS_LINK = "/accounts?tab=connections"

# Where the per-user dismissal marks live: the data DB's `ui_preference` table, so they ride data
# backups and stay with the ledger they describe.
DISMISSED_PREF_KEY = "ui.tasks.dismissed"
MUTED_PREF_KEY = "ui.tasks.muted"
ATTENTION_PREF_KEY = "ui.tasks.attention"
VISITED_PREF_KEY = "ui.tasks.visited_at"
# The last visit of someone who has never opened the page: before every task, so all of them are unread.
NEVER_VISITED = "1970-01-01T00:00:00"


def _https_setup_task(request: Request | None) -> dict | None:
    # Raised where a sign-in is made over the network in cleartext: the password, and the session cookie
    # on every request after it, can be read by anything on that network. A recommendation and no more —
    # plain HTTP on a network its owner trusts is a supported way to run (`docs/operations.md` -> "LAN
    # server") — so it is dismissible like any other, and it clears itself the moment a request arrives
    # over HTTPS. With sign-in off there is no credential on the wire and nothing is raised; the provider
    # secret needs no task, since the server refuses it over such a link and says so where it is asked.
    # Shown only to someone who could set it up: putting a proxy in front of the server is the host's
    # business.
    if request is None or not transport.https_expected(request, perimeter_on=auth_required()):
        return None
    if transport.request_is_https(request) or not shows_admin_features(request):
        return None
    if get_https_warning_suppressed():
        return None
    return {
        "id":          "configure_https",
        "title":       "Set up HTTPS",
        "description": (
            "This server is reached over the network without HTTPS, so sign-in passwords and the session "
            "cross the network unencrypted. Passkeys are unavailable, and "
            + ("a data source can be connected only from a browser on the server. "
               if transport.VAULT_OVER_PLAIN_HTTP else
               "the vault opens only from a browser on the server, so data sources are connected and synced "
               "there. ")
            + "HTTPS, from a reverse proxy on the server, changes all three."
        ),
        "count":       1,
        "link":        "/help/running-a-server",
        "link_label":  "How to set up HTTPS",
        "severity":    SEVERITY_WARNING,
        "required":    False,
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
        "link":        CONNECTIONS_LINK,
        "link_label":  "Review vault access",
        "severity":    SEVERITY_INFO,
        "level":       LEVEL_ALERT,
    }


def _vault_passphrase_task(request: Request | None) -> dict | None:
    """This member's vault passphrase failed the strength rule when they last typed it.

    Carries an `action` rather than a `link`, as the check task below does: the dialog that clears it opens
    over whatever page is showing (`VaultGateContext`), so there is nowhere to send the user.

    Required rather than dismissible: while it stands no data source can be connected
    (`crypto_service.ready_for_production`) and an unencrypted backup leaves it out, and the only
    person who can clear it is the one it is shown to — a passphrase can be changed by its owner alone.
    """
    user = getattr(request, "state", None) and getattr(request.state, "user", None)
    if not user or not crypto_service.passphrase_needs_change(user["id"]):
        return None
    return {
        "id":          "vault_passphrase_change",
        "title":       "Change your vault passphrase",
        "description": "Your vault passphrase is considered too easy to guess. It still opens the vault, but "
                       "until it is changed data providers cannot be connected and unencrypted backups leave "
                       "it out.",
        "count":       1,
        "action":      "vault_passphrase_change",
        "action_label": "Change passphrase",
        "severity":    SEVERITY_WARNING,
        "required":    True,
    }


def _vault_passphrase_check_task(request: Request | None) -> dict | None:
    """This member's vault passphrase has not been judged under the current strength rule and estimator.

    Dismissable, unlike the change task: nothing is known to be wrong, and usually nothing is — an
    estimator release seldom moves a strong passphrase. What does change is that an unencrypted backup
    leaves the passphrase out until it has been typed (`crypto_service.passphrase_export_shortfall`),
    whether or not this is dismissed. Raised for every member at once when the rule or the estimator changes, and the one way it
    reaches a member who unlocks only with a passkey, which cannot judge a passphrase.
    """
    user = getattr(request, "state", None) and getattr(request.state, "user", None)
    if not user or not crypto_service.passphrase_needs_check(user["id"]):
        return None
    return {
        "id":          "vault_passphrase_check",
        "title":       "Confirm your vault passphrase",
        "description": "The vault needs to be unlocked with your passphrase, not a passkey, so it can be "
                       "validated against the current strength rule. Until then unencrypted backups leave it "
                       "out.",
        "count":       1,
        "action":      "vault_passphrase_check",
        "action_label": "Validate passphrase",
        "severity":    SEVERITY_INFO,
    }


def _backup_due_task(request: Request | None) -> dict | None:
    """A change to the vault or the credentials since the last backup that carried them, which leaves the
    backups before it less useful. One card, worded for the strongest consequence, because the events
    stack: a key replacement after a reset makes the reset's milder consequence moot.

    From strongest to mildest: the credentials in every earlier backup are no longer restorable (a key
    retired as `replaced` or `compromised`, `crypto_service.UNTRUSTED_RETIREMENTS`) or no longer accepted
    at the providers (`record_credentials_reissued`); the vault was reset for a lost passphrase, so an
    earlier backup brings back the vault as it was; this member's passphrase changed, so their earlier
    backups open with the old one. The first two compare against the newest backup by anyone, since
    any backup taken after the event carries the vault as it is now; the passphrase case is this
    member's own, since only their backups carried it.

    Raised only where a credentials backup was ever made, so nobody who never kept one is told to keep
    another, and shown to whoever can take a backup. Dismissed for the event that raised it, by the
    retirement's date, the reissue's date or the wrapping in force, so the next event raises it again;
    a backup taken since clears it, since its export then matches."""
    if request is None or not shows_admin_features(request):
        return None
    user = getattr(request.state, "user", None) or {}
    exports = credentials_exports_detail()
    if not exports:
        return None
    newest = exports[0]["exported_at"]

    untrusted = latest_vault_key_retirement(crypto_service.UNTRUSTED_RETIREMENTS)
    reissued = credentials_reissued_at()
    stamps = [s for s in ((untrusted or {}).get("retired_at"), reissued) if s and s > newest]
    if stamps:
        why, stamp = ("The data provider credentials changed after the last backup. Earlier backups no "
                      "longer restore them."), max(stamps)
    else:
        lost = latest_vault_key_retirement(("lost",))
        own = [e for e in exports if e["user_id"] == user.get("id")]
        fingerprint = crypto_service.current_wrapped_dek_fingerprint(user["id"]) if user.get("id") else None
        if lost and lost["retired_at"] > newest:
            why, stamp = ("The vault was reset after the last backup. Earlier backups open with the unlock "
                          "methods in use before the reset."), lost["retired_at"]
        elif own and fingerprint and all(e["wrapped_dek_fingerprint"] != fingerprint for e in own):
            why, stamp = ("The vault passphrase changed after the last backup. Earlier backups open with "
                          "the old passphrase."), fingerprint
        else:
            return None
    return {
        "id":          "backup_due",
        "dismiss_key": f"backup_due:{stamp}",
        "title":       "Take a new backup",
        "description": why,
        "count":       1,
        "link":        "/settings?section=backup",
        "link_label":  "Open Backup / Restore",
        "severity":    SEVERITY_INFO,
    }


def _server_error_task(request: Request | None) -> dict | None:
    """Errors in the server's log that no administrator has seen (`backend/app_log_file.py`).

    A crashed request tells whoever hit it only that something failed, and with several users the admin
    who could read the traceback may never hear of it at all. Shown to exactly who can open the Error log
    it links to — the same predicate that page's endpoint enforces. Opening that page acknowledges the
    count for the whole install, which takes this away; dismissing it here hides it until the next error.
    """
    if request is None or not shows_admin_features(request):
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
        "level":       LEVEL_ALERT,
    }


def _proxy_certificate_task(request: Request | None) -> dict | None:
    """The TLS proxy is presenting a different root certificate than the one this installation's devices
    were given (`services/proxy_certificate.py`).

    Without this the only sign is every device refusing the server at once. Not dismissible: it stands
    until an administrator accepts the new certificate, which is the statement that the change was
    theirs, and each device still has to install it."""
    if request is None or not shows_admin_features(request):
        return None
    if not proxy_certificate.changed_from_record():
        return None
    return {
        "id":          "proxy_certificate_changed",
        "title":       "The server's certificate changed",
        "description": "The reverse proxy in front of this server is using a different certificate than "
                       "before, which happens when it is reinstalled or loses its data. Each computer has "
                       "to install the new one before its browser trusts this server again.",
        "count":       1,
        "link":        "/settings?section=serverCertificate",
        "link_label":  "Review the certificate",
        "severity":    SEVERITY_WARNING,
        "level":       LEVEL_ALERT,
        "required":    True,
    }


def _update_available_task(request: Request | None) -> dict | None:
    """A newer release than the running copy, when the install has opted in to checking for one
    (`services/update_check.py`). Shown to whoever could install it. The dismissal key carries the
    version, so putting the reminder away covers that release only and the next one raises it again."""
    if request is None or not shows_admin_features(request) or not update_check.is_enabled():
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
        "level":       LEVEL_ALERT,
    }


def _watched_folder_task(request: Request | None) -> dict | None:
    """Watched folders the last scan could not list (`watch.unreadable_folders`). Nothing in one is
    imported until it can be, which a note beside the source on the File Sources tab does not make
    plain. Shown to who can change the folder: the watch settings are an administrator's. Not withdrawn by
    `shows_admin_features`, because the folder is set beside its source, which no one is spared."""
    if request is None or not is_admin_or_local(request):
        return None
    from backend.routers.import_export.watch import unreadable_folders
    with get_db() as conn:
        folders = unreadable_folders(conn)
    if not folders:
        return None
    named = "; ".join(f"{f['name']} ({f['watch_dir']}): {f['watch_notice']}" for f in folders[:3])
    more = f"; and {len(folders) - 3} more" if len(folders) > 3 else ""
    return {
        "id":          "watched_folder_unreadable",
        "title":       "A watched folder is not being checked" if len(folders) == 1
                       else "Watched folders are not being checked",
        "description": f"{named}{more}. Nothing in {'it' if len(folders) == 1 else 'them'} is imported until "
                       "the server can read the folder again.",
        "count":       len(folders),
        "link":        "/import-export?tab=sources",
        "link_label":  "Open File Sources",
        "severity":    SEVERITY_WARNING,
        "level":       LEVEL_ALERT,
    }


def _restored_folder_task(request: Request | None) -> dict | None:
    """Watched folders a restore from another system switched off, still waiting to be used here or
    cleared (`watch.restore_pending_folders`). Shown to who can answer, for the reason
    `_watched_folder_task` is."""
    if request is None or not is_admin_or_local(request):
        return None
    from backend.routers.import_export.watch import restore_pending_folders
    with get_db() as conn:
        folders = restore_pending_folders(conn)
    if not folders:
        return None
    named = "; ".join(f"{f['name']} ({f['watch_dir']})" for f in folders[:3])
    more = f"; and {len(folders) - 3} more" if len(folders) > 3 else ""
    return {
        "id":          "watched_folder_restored",
        "title":       "A restored watched folder needs a decision" if len(folders) == 1
                       else "Restored watched folders need a decision",
        "description": f"{named}{more}. These paths came from the system the backup was made on. Use each "
                       "on this machine or clear it.",
        "count":       len(folders),
        "link":        "/import-export?tab=sources",
        "link_label":  "Open File Sources",
        "severity":    SEVERITY_WARNING,
        "level":       LEVEL_ALERT,
    }


def _connection_tasks(conn) -> list[dict]:
    """A data connection that has stopped working, or is silently skipping an account.

    The Connections tab shows these states, but a user only sees them by visiting it — and
    the whole point of these is that they are discovered by a sync and cost the user data until
    acted on. The nav badge is the surface that finds the user instead, which is what the Tasks page is for.

    Separate tasks rather than one "connections need attention", because the remedies are different
    pages' worth of different work and a merged count could not link anywhere useful.

    Dismissible like every task (see the module docstring): the connection card keeps showing the broken
    state. Worth knowing when reading a report about one: these counts do not fall on their own, so a
    dismissed one stays hidden until another connection breaks or the first is fixed.
    """
    tasks = []
    rows = conn.execute(
        """
        SELECT provider, COALESCE(NULLIF(TRIM(nickname), ''), institution) AS institution, reauth_required,
               consecutive_sync_failures, credential, credential_enc,
               (SELECT COUNT(*) FROM connection_account ca WHERE ca.connection_id = connection.id) AS account_count
        FROM connection
        """
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
            "link":        CONNECTIONS_LINK,
            "link_label":  "Reconnect",
            "severity":    SEVERITY_WARNING,
            "level":       LEVEL_ALERT,
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
            "level":       LEVEL_ALERT,
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
            "link":        CONNECTIONS_LINK,
            "link_label":  "Choose destinations",
            "severity":    SEVERITY_WARNING,
        })

    # A working credential with no account list under it: what a credentials restore leaves when no data
    # backup named the connection, and what a data restore leaves a connection its backup did not name.
    # Asked of the state rather than of a restore having happened, so any other route to it is covered.
    # One needing reconnection is left to that task, since a refresh cannot run on a refused credential.
    accountless = [r for r in rows
                   if not r["account_count"] and not r["reauth_required"]
                   and crypto_service.connection_has_credential(r["credential"], r["credential_enc"])]
    if accountless:
        names = ", ".join(r["institution"] or r["provider"] for r in accountless)
        tasks.append({
            "id":          "connections_without_accounts",
            "title":       "A data connection has no accounts"
                           if len(accountless) == 1 else "Data connections have no accounts",
            "description": f"{names} has a stored credential and no account list, which is how a restored "
                           "backup can leave a connection. A sync has nowhere to import into until "
                           "Refresh accounts, in the connection's menu, fetches the list.",
            "count":       len(accountless),
            "link":        CONNECTIONS_LINK,
            "link_label":  "Refresh accounts",
            "severity":    SEVERITY_WARNING,
        })
    return tasks


def security_tasks(request: Request | None) -> list[dict]:
    """The tasks Settings -> Security checklist also reports (`services/security_checklist.py`), taken from
    here so the two never judge one condition differently. Undismissed: the checklist states the
    condition, and putting the reminder away does not change it."""
    found = [
        _vault_passphrase_task(request) or _vault_passphrase_check_task(request),
        _backup_due_task(request),
        _proxy_certificate_task(request),
        _update_available_task(request),
    ]
    return [task for task in found if task]


# Pending transactions are intentionally excluded because the rest of the product also keeps them out of
# reporting and categorization chores until they settle. Trashed rows are excluded too: they no longer
# appear in the Transactions list the task links to, so counting them here would overstate the work and
# never reach zero.
#
# An owner with `count_uncategorized_in_tasks` off is left out of the count, which is all the switch does: the
# rows stay uncategorized and every other list shows them. A row with no owner has nobody to have opted out
# for it, so it always counts.
def _uncategorized_count(conn, lens: list[str] | None = None) -> int:
    clauses = [
        "t.category_id IS NULL", "t.is_pending = 0", "t.trashed_at IS NULL",
        "(t.owner_id IS NULL OR t.owner_id NOT IN (SELECT id FROM owner WHERE count_uncategorized_in_tasks = 0))",
    ]
    params: list = []
    member = owner_membership(lens or [])
    if member:
        clauses.append(member[0])
        params.extend(member[1])
    return conn.execute(f"SELECT COUNT(*) AS n FROM txn t WHERE {' AND '.join(clauses)}", params).fetchone()["n"]


def _owners_not_counted(conn) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT id, name FROM owner WHERE count_uncategorized_in_tasks = 0 ORDER BY name"
    )]


def _uncategorized_task(n: int, not_counted: list[dict]) -> dict | None:
    """`link_filters` are the chips following the link sets in place of clearing them: an "is not" chip for
    each owner left out of the count, so the list it opens holds the rows counted."""
    if not n:
        return None
    return {
        "id":          "uncategorized_txns",
        "title":       "Uncategorized transactions",
        "description": f"{n} transaction{'s have' if n != 1 else ' has'} "
                       "no category. Categorizing them improves your Dashboard and reports.",
        "count":       n,
        "link":        "/transactions?only=uncategorized",
        "link_label":  "Review transactions",
        "link_filters": [{"type": "owner", "id": o["id"], "label": o["name"], "mode": "exclude"} for o in not_counted],
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

    passphrase_task = _vault_passphrase_task(request) or _vault_passphrase_check_task(request)
    if passphrase_task:
        tasks.append(passphrase_task)

    backup_task = _backup_due_task(request)
    if backup_task:
        tasks.append(backup_task)

    error_task = _server_error_task(request)
    if error_task:
        tasks.append(error_task)

    certificate_task = _proxy_certificate_task(request)
    if certificate_task:
        tasks.append(certificate_task)

    update_task = _update_available_task(request)
    if update_task:
        tasks.append(update_task)

    folder_task = _watched_folder_task(request)
    if folder_task:
        tasks.append(folder_task)

    restored_folder_task = _restored_folder_task(request)
    if restored_folder_task:
        tasks.append(restored_folder_task)

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
        uncategorized_task = _uncategorized_task(_uncategorized_count(conn), _owners_not_counted(conn))
        if uncategorized_task:
            tasks.append(uncategorized_task)

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
            # is opened from the Import History tab (each file card with unresolved soft flags
            # carries its own entry-point pill, and collapsed data-source rows surface an aggregate
            # badge). Linking the task there lets the user pick which batch's report to open
            # rather than dropping them into a global cross-batch view.
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
                "link":        "/import-export?tab=history",
                "link_label":  "Open Import History",
                "severity":    SEVERITY_WARNING,
            })

        # Amazon imports whose reconciliation has actionable items — a duplicate charge to merge/discard, or a
        # split-shipment suggestion to accept/dismiss. One count per Amazon batch, cached against the
        # reconciliation epoch; plain "No charge found" is intentionally excluded (nothing to resolve).
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
                "link":        "/import-export?tab=history",
                "link_label":  "Open Import History",
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
            unreadable = watch_attention["unreadable"]
            tasks.append({
                "id":          "watched_import_files",
                "title":       "Files waiting in a watched folder",
                "description": f"{waiting} file{'s were' if waiting != 1 else ' was'} left for review rather "
                               "than imported — an account the data source has not been shown, a layout it is "
                               + ("not set up for, or a file that could not be deleted after import. "
                                  if watch_attention["purge_failed"] else "not set up for, or an import that failed. ")
                               + "Open each one in the import flow to finish it."
                               + (f" {unreadable} of them cannot be read by the server, which needs the file's owner "
                                  "or permissions changed first."
                                  if unreadable else ""),
                "count":       waiting,
                "link":        "/import-export",
                "link_label":  "Open Import",
                "severity":    SEVERITY_WARNING,
            })

        tasks.extend(_wallet_pair_tasks(conn))

        owed_rescan_task = _owed_rescan_task(conn)
        if owed_rescan_task:
            tasks.append(owed_rescan_task)
        tasks.extend(_recurring_signal_tasks(conn))
        transfer_ties_task = _transfer_ties_task(conn)
        if transfer_ties_task:
            tasks.append(transfer_ties_task)
        tasks.extend(_rule_range_drift_tasks(conn))
        tasks.extend(_rule_conflict_tasks(conn))
        tasks.extend(_rule_alert_tasks(conn))
        after_close_task = _after_close_task(closed_accounts.after_close_count(conn))
        if after_close_task:
            tasks.append(after_close_task)
        tasks.extend(_group_primary_tasks(conn))
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


def _recurring_signal_tasks(conn, counts: dict | None = None) -> list[dict]:
    """The recurring anomaly signals, one task per kind. Each signal is also dismissed one at a time on the
    page the task links to, and the count here only ever describes findings still open there; dismissing
    the task hides the reminder until another finding of that kind appears. `counts` is a narrowed set of
    signal counts, for the owner lens; by default every open signal is counted."""
    if counts is None:
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


def _transfer_ties_task(conn) -> dict | None:
    """Transfers the recurring scan could not pair because two transactions match equally well
    (`recurring_detection.transfer_review`). The link lands on the Recurring page's *Needs attention*
    view, where each is answered."""
    n = len(transfer_review(conn)["ambiguous"])
    if not n:
        return None
    return {
        "id":          "recurring_transfer_ties",
        "title":       "Transfer needs matching",
        "description": f"{n} transfer{'s' if n != 1 else ''} between two tracked accounts "
                       f"{'match' if n != 1 else 'matches'} more than one transaction equally well. "
                       "Picking the other half lets it count towards a recurring series.",
        "count":       n,
        "link":        "/recurring?signal=transfer_ties",
        "link_label":  "Review recurring",
        "severity":    SEVERITY_INFO,
    }


def _owed_rescan_task(conn) -> dict | None:
    """Recurring detection known to be behind: a rescan an edit or import owed that no scan has settled
    (`docs/data-model.md` → *When a scan runs*). Every series, member and finding read off those payees may
    be stale until one does, and a scan from the Recurring page settles everything owed."""
    overdue = overdue_owed_rescan_count(conn)
    if not overdue:
        return None
    return {
        "id":          "recurring_rescan_owed",
        "title":       "Recurring detection is out of date",
        "description": "Transactions were changed and recurring detection has not caught up with them, so "
                       "some series, their members and their findings may be out of date. Scan for "
                       "recurring brings them up to date.",
        "count":       overdue,
        "link":        "/recurring",
        "link_label":  "Open Recurring",
        "severity":    SEVERITY_WARNING,
    }


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


def _rule_conflict_tasks(conn) -> list[dict]:
    """Rule pairs a categorization pass caught deciding a transaction arbitrarily. Dismissing the task puts
    the reminder away until a new pair is recorded; the pairs themselves stay listed in the rule checkup
    until the rules stop conflicting."""
    n = rule_conflicts.open_count(conn)
    if not n:
        return []
    return [{
        "id":          "rule_conflict",
        "title":       "Rules competing for the same transactions",
        "description": f"{n} pair{' of rules' if n == 1 else 's of rules'} matched the same transaction, "
                       "and which one applied changes its category, name or recurring series. Nothing "
                       "meaningful chooses between them: neither keyword contains the other, or their "
                       "amount ranges only partly overlap.",
        "count":       n,
        "link":        "/rules?findings=conflicts",
        "link_label":  "Review rules",
        "severity":    SEVERITY_WARNING,
    }]


WALLET_PAIRS_TASK_PREFIX = "wallet_pairs_"


def _wallet_pair_tasks(conn) -> list[dict]:
    """One task per wallet account with rows to reconcile. A wallet is one account, possibly someone
    else's, so each has its own entry named for it, and its link opens that account's review. Matches are
    made after syncs as well as imports, so the review is about the account's whole history rather than
    one file."""
    counts = wallet_pairs.wallet_attention_counts(conn)
    labels = wallet_pairs.wallet_labels(conn, counts)
    tasks = []
    for wallet_id, n in sorted(counts.items(), key=lambda kv: labels.get(kv[0], {}).get("name", "").casefold()):
        name = labels.get(wallet_id, {}).get("name") or "Wallet"
        tasks.append({
            "id":          f"{WALLET_PAIRS_TASK_PREFIX}{wallet_id}",
            "title":       f"{name} transactions to reconcile",
            "description": f"{n} item{'s need' if n != 1 else ' needs'} a look: a {name} transaction with more "
                           "than one possible bank or card match, one that moved money with no matching "
                           f"transaction found, or a {name} charge on a bank or card account with no {name} "
                           "record.",
            "count":       n,
            "link":        f"/import-export?review=wallet&account={wallet_id}",
            "link_label":  "Open the reconciliation",
            "severity":    SEVERITY_WARNING,
        })
    return tasks


RULE_ALERT_TASK_PREFIX = "rule_alert_"


def _rule_alert_tasks(conn, lens: list[str] | None = None) -> list[dict]:
    """One task per rule whose alert has caught live transactions (`services/rule_alerts.py`). The count only
    rises, so a dismissal returns with the next arrival, and it can be muted."""
    tasks = []
    for alert in rule_alerts.open_alerts(conn, lens):
        rule, n = alert["rule"], alert["count"]
        condition = rule_alerts.alert_condition_text(rule)
        message = rule["alert_message"]
        tasks.append({
            "id":          f"{RULE_ALERT_TASK_PREFIX}{rule['id']}",
            "title":       message or f"Rule matched: {condition}",
            "description": f"{n} transaction{'s have' if n != 1 else ' has'} matched "
                           + (f"the rule {condition}." if message else "this rule."),
            "count":       n,
            "link":        "/transactions?only=rule-alert",
            "link_label":  "Review transactions",
            "severity":    SEVERITY_WARNING,
            "level":       LEVEL_ALERT,
            "mutable":     True,
        })
    return tasks


AFTER_CLOSE_TASK_ID = "after_close_txns"


def _after_close_task(n: int) -> dict | None:
    """Transactions dated after their account closed (`services/closed_accounts.py`). They import like any
    other, so this is what says one arrived. The count rises with each, so a dismissal returns with the next,
    and it can be muted while a feed that should have stopped is dealt with."""
    if not n:
        return None
    return {
        "id":          AFTER_CLOSE_TASK_ID,
        "title":       "Transactions on closed accounts",
        "description": f"{n} transaction{'s are' if n != 1 else ' is'} dated after {'their' if n != 1 else 'its'} "
                       "account was closed. A charge on a closed account may be a mistake or fraud, or the "
                       "close date may be wrong.",
        "count":       n,
        "link":        "/transactions?only=after-close",
        "link_label":  "Review transactions",
        "severity":    SEVERITY_WARNING,
        "level":       LEVEL_ALERT,
        "mutable":     True,
    }


GROUP_PRIMARY_TASK_PREFIX = "group_primary_"


def _group_primary_tasks(conn) -> list[dict]:
    """One task per group whose primary looks replaced (`services/group_primary.py`). Its id names the member
    suggested, so putting it away holds for that suggestion, and a later replacement asks again."""
    return [{
        "id":          f"{GROUP_PRIMARY_TASK_PREFIX}{entry['root_id']}_{entry['member_id']}",
        "title":       f"Make {entry['member_label']} the primary?",
        "description": f"{entry['root_label']}, the primary of its group, has had no transactions in "
                       f"{group_primary.QUIET_DAYS} days, while {entry['member_label']} has. Making "
                       f"{entry['member_label']} the primary lets {entry['root_label']} be closed on its own.",
        "count":       1,
        "link":        "/accounts",
        "link_label":  "Open Accounts",
        "severity":    SEVERITY_INFO,
        "owner_id":    entry["owner_id"],
    } for entry in group_primary.quiet_primaries(conn)]


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


def _read_mutes(scope_id: str | None) -> set[str]:
    if not scope_id:
        return set()
    raw = get_preferences(scope_id).get(MUTED_PREF_KEY)
    try:
        parsed = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return set()
    return {str(k) for k in parsed} if isinstance(parsed, list) else set()


def _write_mutes(scope_id: str | None, mutes: set[str]) -> None:
    if scope_id:
        set_preference(scope_id, MUTED_PREF_KEY, json.dumps(sorted(mutes)))


def _attention_key(task: dict) -> str:
    return task.get("dismiss_key") or task["id"]


def _track_attention(tasks: list[dict], scope_id: str | None) -> dict[str, str]:
    """`{task key: when it last needed attention}`, recording a task that has appeared or whose count has risen
    since the last read. The stored count falls with the task's, as a dismissal mark does, so work arriving
    after some was cleared is a rise. A task that has gone is dropped. The first read for a person dates every
    task as unknown (""), so the ordering starts as it was rather than marking the whole list new."""
    if not scope_id:
        return {}
    raw = get_preferences(scope_id).get(ATTENTION_PREF_KEY)
    try:
        parsed = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        parsed = {}
    stored = {str(k): v for k, v in parsed.items() if isinstance(v, list) and len(v) == 2} \
        if isinstance(parsed, dict) else {}
    now = utcnow_iso()
    updated: dict[str, list] = {}
    for task in tasks:
        key, count = _attention_key(task), task["count"]
        previous = stored.get(key)
        if previous is None:
            updated[key] = [count, now if raw else ""]
        elif count > previous[0]:
            updated[key] = [count, now]
        else:
            updated[key] = [count, previous[1]]
    if updated != stored or not raw:
        set_preference(scope_id, ATTENTION_PREF_KEY, json.dumps(updated))
    return {key: value[1] for key, value in updated.items()}


def _order(tasks: list[dict], attention: dict[str, str], since: str) -> list[dict]:
    """The shown tasks in inbox order, each carrying `unread` (see the module docstring)."""
    for task in tasks:
        task["unread"] = attention.get(_attention_key(task), "") > since
    ordered = sorted(tasks, key=lambda task: attention.get(_attention_key(task), ""), reverse=True)

    def group(task):
        if task.get("required"):
            return 0
        return (1 if task["unread"] else 3) + (0 if task.get("level") == LEVEL_ALERT else 1)
    return sorted(ordered, key=group)


def _visited_at(scope_id: str | None) -> str:
    return (get_preferences(scope_id).get(VISITED_PREF_KEY) if scope_id else None) or NEVER_VISITED


def _apply_dismissals(tasks: list[dict], scope_id: str | None) -> tuple[list[dict], list[dict]]:
    """Split the task list into what is shown and what a dismissal is hiding, ratcheting each mark down
    to the lowest count seen since it was set (see the module docstring for why that half matters). A
    mark for a task that no longer applies at all is dropped, so the dismissal expires rather than
    silently covering the task's next appearance. A muted task is hidden whatever its count, and its mute
    expires the same way. Each hidden task carries `muted`."""
    marks = _read_dismissals(scope_id)
    by_key = {t["dismiss_key"]: t for t in tasks if t.get("dismiss_key")}
    mutes = _read_mutes(scope_id)
    live_mutes = {key for key in mutes if key in by_key}
    if live_mutes != mutes:
        _write_mutes(scope_id, live_mutes)
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
        key = task.get("dismiss_key")
        mark = marks.get(key)
        if key in live_mutes:
            hidden.append({**task, "muted": True})
        elif mark is not None and task["count"] <= mark:
            hidden.append({**task, "muted": False})
        else:
            visible.append(task)
    return visible, hidden


# The tasks the owner lens narrows: each reports something that belongs to owners, so it is recounted over
# the lens owners' rows or, when it is about one owner's account or group, shown only to that owner. Every
# other task is about import folders, the rule checkup, connections or the installation, and stays whole.
_RECURRING_SIGNAL_TASK_IDS = {spec["id"] for spec in _SIGNAL_TASKS}


def _narrow_to_lens(tasks: list[dict], lens: list[str]) -> list[dict]:
    """Shown tasks recounted over the lens owners' rows; one with nothing left is dropped. Run after
    dismissal, which always judges the whole count: a mark ratcheted down to a narrowed count would bring
    the task back the moment the lens is switched off."""
    narrowed: list[dict] = []
    with get_db() as conn:
        signal_counts = None
        alert_tasks = None
        for task in tasks:
            if task["id"] == "uncategorized_txns":
                task = _keep_dismissal(
                    task, _uncategorized_task(_uncategorized_count(conn, lens), _owners_not_counted(conn)),
                )
            elif task["id"] == AFTER_CLOSE_TASK_ID:
                task = _keep_dismissal(task, _after_close_task(closed_accounts.after_close_count(conn, lens)))
            elif task["id"].startswith("reimbursements_due_"):
                # One task per owner already; the owner token is the task's own.
                owner = task["id"].removeprefix("reimbursements_due_")
                task = task if owner_lens_admits([owner], lens) else None
            elif task["id"] == "reimbursements_due":
                # Not split by owner on screen, but the report still groups what it counts by whose it is.
                n = sum(g["count"] for g in due_reminders(conn)["groups"] if owner_lens_admits([g["owner_id"]], lens))
                task = _keep_dismissal(task, _reimbursement_task(group=None, count=n) if n else None)
            elif task["id"] in _RECURRING_SIGNAL_TASK_IDS:
                if signal_counts is None:
                    shown = series_shown_under_lens(conn, lens)
                    signal_counts = narrow_signals(compute_signals(conn), shown)["counts"]
                fresh = next((t for t in _recurring_signal_tasks(conn, signal_counts) if t["id"] == task["id"]), None)
                task = _keep_dismissal(task, fresh)
            elif task["id"].startswith(WALLET_PAIRS_TASK_PREFIX):
                # One task per wallet account already; it shows to the account's owner.
                wallet_id = task["id"].removeprefix(WALLET_PAIRS_TASK_PREFIX)
                owner = (wallet_pairs.wallet_labels(conn, [wallet_id]).get(wallet_id) or {}).get("owner_id")
                task = task if owner_lens_admits([owner] if owner else [], lens) else None
            elif task["id"].startswith(GROUP_PRIMARY_TASK_PREFIX):
                # One task per group already; it shows to the group's owner.
                owner = task.get("owner_id")
                task = task if owner_lens_admits([owner] if owner else [], lens) else None
            elif task["id"].startswith(RULE_ALERT_TASK_PREFIX):
                # Counted over the caught rows' owners, so a rule scoped to an account shows to that
                # account's owner and one applying to everyone shows each owner their own rows.
                if alert_tasks is None:
                    alert_tasks = {t["id"]: t for t in _rule_alert_tasks(conn, lens)}
                task = _keep_dismissal(task, alert_tasks.get(task["id"]))
            if task:
                narrowed.append(task)
    return narrowed


def _keep_dismissal(original: dict, rebuilt: dict | None) -> dict | None:
    return {**rebuilt, "dismiss_key": original.get("dismiss_key")} if rebuilt else None


@router.get("")
def get_tasks(
    request: Request = None,
    owner_lens: Optional[str] = Query(None, description="comma-separated owner IDs ('unassigned' for none) the Tasks page's owner lens shows"),
    since: Optional[str] = Query(None, description="the last visit to judge unread against; the stored one when absent"),
):
    """The shown tasks, in inbox order, and the dismissed ones. Under the owner lens the shown tasks that link
    to a lensed page are recounted for its owners (`_narrow_to_lens`); the dismissed list stays whole, since it
    is the way back to a reminder whoever's rows it counts. `visited_at` is the last visit the unread marks
    were judged against; the Tasks page passes it back as `since` for the rest of a visit, so the marks and
    the order hold while it is open."""
    scope_id = _dismissal_scope(request)
    tasks = _build_tasks(request)
    attention = _track_attention(tasks, scope_id)
    visible, hidden = _apply_dismissals(tasks, scope_id)
    lens = split_ids(owner_lens, ",")
    if lens:
        visible = _narrow_to_lens(visible, lens)
    # A direct call leaves `since` as its `Query` default, which is not a visit.
    visited_at = since if isinstance(since, str) and since else _visited_at(scope_id)
    visible = _order(visible, attention, visited_at) if scope_id else visible
    return {
        "tasks":       visible,
        "visited_at":  visited_at,
        "total_count": sum(t["count"] for t in visible),
        "open_items":  len(visible),
        "dismissed":   [{"id": t["id"], "dismiss_key": t["dismiss_key"], "muted": t["muted"],
                         "title": t["title"], "count": t["count"]}
                        for t in hidden],
    }


@router.post("/dismiss/{dismiss_key}")
def dismiss_task(dismiss_key: str, request: Request = None, owner_lens: Optional[str] = Query(None),
                 since: Optional[str] = Query(None)):
    """Put a task away at its current count. It returns when the count rises above that mark — and the
    mark falls with the count, so work that arrives after some has been cleared still surfaces. Dismissing
    a muted task ends the mute."""
    scope_id = _dismissal_scope(request)
    if not scope_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    task = next((t for t in _build_tasks(request) if t.get("dismiss_key") == dismiss_key), None)
    if task is None:
        raise HTTPException(status_code=404, detail="No such dismissible task")
    marks = _read_dismissals(scope_id)
    marks[dismiss_key] = task["count"]
    _write_dismissals(scope_id, marks)
    mutes = _read_mutes(scope_id)
    if dismiss_key in mutes:
        _write_mutes(scope_id, mutes - {dismiss_key})
    return get_tasks(request, owner_lens, since)


@router.post("/mute/{dismiss_key}")
def mute_task(dismiss_key: str, request: Request = None, owner_lens: Optional[str] = Query(None),
              since: Optional[str] = Query(None)):
    """Hide a `mutable` task however high its count goes, until it is dismissed or restored."""
    scope_id = _dismissal_scope(request)
    if not scope_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    task = next((t for t in _build_tasks(request) if t.get("dismiss_key") == dismiss_key), None)
    if task is None or not task.get("mutable"):
        raise HTTPException(status_code=404, detail="No such mutable task")
    _write_mutes(scope_id, _read_mutes(scope_id) | {dismiss_key})
    return get_tasks(request, owner_lens, since)


@router.delete("/dismiss/{dismiss_key}")
def restore_task(dismiss_key: str, request: Request = None, owner_lens: Optional[str] = Query(None),
                 since: Optional[str] = Query(None)):
    """Bring a dismissed or muted task back — the undo behind the toast and the dismissed list."""
    scope_id = _dismissal_scope(request)
    if not scope_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    marks = _read_dismissals(scope_id)
    marks.pop(dismiss_key, None)
    _write_dismissals(scope_id, marks)
    mutes = _read_mutes(scope_id)
    if dismiss_key in mutes:
        _write_mutes(scope_id, mutes - {dismiss_key})
    return get_tasks(request, owner_lens, since)


@router.post("/visited")
def mark_tasks_visited(request: Request = None):
    """Record a visit to the Tasks page: tasks needing attention before now stop being unread."""
    scope_id = _dismissal_scope(request)
    if scope_id:
        set_preference(scope_id, VISITED_PREF_KEY, utcnow_iso())
    return {"ok": True}
