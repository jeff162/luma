# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Settings -> Security checklist: this installation's configuration set against the best practices in
`docs/security-model.md` -> *Best practices*, one item per practice and nothing that is not on that list.

**It compares and refuses nothing.** Each practice is one the operator may decide against for their own
network, so an item states whether it is met, what follows from how things stand, and where it is
changed. An item that does not apply here is left out rather than shown as met: on an installation only
this computer can open, "other devices connect over HTTPS" is not an achievement.

**Three of the items depend on who is asking.** Whether this browser opened the app by name is a fact of
the request, and the vault passphrase and backup items are the viewer's own, as their tasks are.

A condition that is also a task is read from `routers/tasks.security_tasks`, so the checklist and the
Tasks page never judge it differently. A dismissed task is still reported here, since putting a
reminder away changes nothing about the condition.
"""

from fastapi import Request

from backend import transport
from backend.db.control_database import auth_required, credentials_exports_detail
from backend.runtime_config import app_name
from backend.services import crypto_service, proxy_certificate, update_check

MET = "met"
NOT_MET = "not_met"
UNKNOWN = "unknown"


def _item(item_id: str, title: str, status: str, detail: str, link: str | None = None,
          link_label: str | None = None) -> dict:
    return {"id": item_id, "title": title, "status": status, "detail": detail, "link": link,
            "link_label": link_label}


def _sign_in_item() -> dict | None:
    if not transport.reachable_from_network():
        return None
    met = auth_required()
    return _item(
        "sign_in", "Sign-in is required when other devices can connect", MET if met else NOT_MET,
        "Other devices on the network can open this installation, and each has to sign in." if met else
        "Other devices on the network can open this installation, and anyone who reaches it can see and "
        "change all of the data.",
        "/settings?section=signInProtection", "Open Sign-in protection",
    )


def _https_item() -> dict | None:
    if not transport.reachable_from_network():
        return None
    if not transport.plain_http_from_network():
        return _item(
            "https", "Other devices connect over HTTPS", MET,
            f"Other devices reach {app_name()} only through the reverse proxy on this computer.",
        )
    password = ", sign-in passwords included" if auth_required() else ""
    return _item(
        "https", "Other devices connect over HTTPS", NOT_MET,
        f"Other devices can reach {app_name()} over plain HTTP, so what they send crosses the network "
        f"unencrypted{password}. Passkeys are unavailable to them, and a data source can be connected only "
        "from a browser on the server.",
        "/help/running-a-server", "How to set up HTTPS",
    )


def _named_host_item(request: Request) -> dict | None:
    by_address = transport.host_is_address(request)
    # On this computer the launcher opens the app by name, so the item says something only for a browser
    # elsewhere or one that has been pointed at an address.
    if not by_address and transport.request_is_loopback(request):
        return None
    if not by_address:
        return _item("named_host", "This browser opens the server by name", MET,
                     f"This browser opened {app_name()} by name, which passkeys require.")
    return _item(
        "named_host", "This browser opens the server by name", NOT_MET,
        f"This browser opened {app_name()} by its IP address. Browsers allow passkeys only on a name, so "
        "none can be registered or used from here.",
        "/help/running-a-server", "Running as a server",
    )


def _vault_passphrase_item(request: Request, tasks: dict[str, dict]) -> dict | None:
    user = getattr(request.state, "user", None) or {}
    if not user.get("id") or not crypto_service.has_own_passphrase(user["id"]):
        return None
    title = "Your vault passphrase meets the strength rule"
    if "vault_passphrase_change" in tasks:
        return _item("vault_passphrase", title, NOT_MET, tasks["vault_passphrase_change"]["description"],
                     "/tasks", "Open Tasks")
    if "vault_passphrase_check" in tasks:
        return _item("vault_passphrase", title, UNKNOWN, tasks["vault_passphrase_check"]["description"],
                     "/tasks", "Open Tasks")
    return _item("vault_passphrase", title, MET, "Your vault passphrase meets the current strength rule.")


def _backup_item(tasks: dict[str, dict]) -> dict | None:
    if not credentials_exports_detail():
        return None
    title = "Backups carry the vault as it is now"
    due = [task["description"] for task_id, task in tasks.items() if task_id.startswith("backup_due_")]
    if not due:
        return _item("backups", title, MET,
                     "Nothing about the vault or the data provider credentials has changed since the last "
                     "backup that carried them.")
    return _item("backups", title, NOT_MET, " ".join(due), "/settings?section=backup", "Open Backup / Restore")


def _certificate_item(tasks: dict[str, dict]) -> dict | None:
    if not proxy_certificate.has_record():
        return None
    title = "Devices trust the server's certificate"
    task = tasks.get("proxy_certificate_changed")
    if not task:
        return _item("certificate", title, MET,
                     "The reverse proxy presents the certificate this installation's devices were given.")
    return _item("certificate", title, NOT_MET, task["description"], task["link"], task["link_label"])


def _update_item(tasks: dict[str, dict]) -> dict:
    title = "This copy is the latest release"
    if not update_check.is_enabled():
        return _item("update", title, UNKNOWN,
                     "Checking for new versions is off, so whether a newer release exists is not known.",
                     "/settings?section=about", "Open About")
    task = tasks.get("update_available")
    if not task:
        return _item("update", title, MET, "No newer release was found at the last check.")
    return _item("update", title, NOT_MET, task["description"], task["link"], task["link_label"])


def build(request: Request, security_tasks: list[dict]) -> list[dict]:
    """Every item that applies to this installation and this viewer, in the order the practices are
    listed in the doc."""
    tasks = {task["id"]: task for task in security_tasks}
    items = [
        _sign_in_item(),
        _https_item(),
        _named_host_item(request),
        _vault_passphrase_item(request, tasks),
        _backup_item(tasks),
        _certificate_item(tasks),
        _update_item(tasks),
    ]
    return [item for item in items if item]
