# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Settings -> Security checklist. Compares this installation with the practices in
`docs/security-model.md` -> *Best practices*, one item per practice.

Nothing here is enforced: each item says whether the practice is met, what that means, and where to change
it. Items that don't apply are left out, so an installation only this computer can open has no HTTPS item.

The browser-name, vault passphrase and backup items depend on who is viewing.

Items that are also tasks use the task's own check (`routers/tasks.security_tasks`), so the two always
agree. A dismissed task still shows here.
"""

from fastapi import Request

from backend import transport
from backend.db.control_database import auth_required, credentials_exports_detail
from backend.runtime_config import app_name
from backend.services import crypto_service, proxy_certificate, update_check

MET = "met"
NOT_MET = "not_met"
UNKNOWN = "unknown"
# Reported, not graded: a choice that depends on who is on the network, which only the operator knows.
INFO = "info"

# A not-met item that bypasses protection the operator set up, not just one they haven't set up yet.
ELEVATED = "elevated"

CONFIGURATION_LINK = ("/settings?section=configuration", "Open Startup configuration")


def _item(item_id: str, title: str, status: str, detail: str, link: str | None = None,
          link_label: str | None = None, severity: str | None = None) -> dict:
    return {"id": item_id, "title": title, "status": status, "detail": detail, "link": link,
            "link_label": link_label, "severity": severity}


def _sign_in_item() -> dict | None:
    if not transport.reachable_from_network():
        return None
    if auth_required():
        return _item("sign_in", "Sign-in required", MET,
                     "This installation is open to other devices on the network, and they have to sign in.")
    return _item(
        "sign_in", "Sign-in required", INFO,
        "Other devices on the network can open this installation without signing in.",
        "/settings?section=signInProtection", "Turn on sign-in",
    )


# What going without HTTPS costs another device, said after whichever reason applies.
def _without_https_costs() -> str:
    passwords = ", including passwords," if auth_required() else ""
    vault = ("they cannot connect data sources" if transport.VAULT_OVER_PLAIN_HTTP
             else "they cannot open the vault, so they cannot connect or sync data sources")
    return f"What they send{passwords} is not encrypted, they cannot use passkeys, and {vault}."


def _https_item() -> dict | None:
    """Four ways another device can end up without HTTPS, each with its own fix:

    - a source checkout listening on the network: use server mode behind HTTPS instead;
    - a server with a wide bind and a proxy in use: devices can skip the proxy, so this one is elevated. A
      proxy is in use if a device has connected over HTTPS since startup, or the proxy answers now;
    - a server with a wide bind and no proxy: the supported plain-HTTP setup;
    - nothing set wide, but a device connected without HTTPS, such as through a proxy without TLS."""
    if not transport.reachable_from_network():
        return None
    title = "HTTPS for other devices"
    wide = transport.wide_bind()
    if wide and wide["checkout"]:
        return _item(
            "https", title, NOT_MET,
            f"This source checkout listens on the network ({wide['setting']} is {wide['value']}), so other "
            f"devices connect without HTTPS. {_without_https_costs()} To share {app_name()} with other "
            "devices, use a downloaded build in server mode behind HTTPS.",
            *CONFIGURATION_LINK,
        )
    if wide and (transport.seen_https_from_network() or proxy_certificate.is_running()):
        return _item(
            "https", title, NOT_MET,
            f"HTTPS can be bypassed. {app_name()} also listens on the network directly ({wide['setting']} is "
            f"{wide['value']}), so devices can skip the proxy and connect unencrypted. Set {wide['setting']} "
            "back to localhost.",
            *CONFIGURATION_LINK, severity=ELEVATED,
        )
    if wide:
        return _item(
            "https", title, NOT_MET,
            f"{app_name()} listens on the network directly ({wide['setting']} is {wide['value']}), so other "
            f"devices connect without HTTPS. {_without_https_costs()}",
            "/help/running-a-server", "Set up HTTPS",
        )
    if transport.seen_plain_http_from_network():
        return _item(
            "https", title, NOT_MET,
            f"A device has connected without HTTPS since {app_name()} started. {_without_https_costs()}",
            "/help/running-a-server", "Set up HTTPS",
        )
    return _item("https", title, MET, "Other devices connect through the HTTPS proxy on this computer.")


def _named_host_item(request: Request) -> dict | None:
    by_address = transport.host_is_address(request)
    # A browser on this computer uses `localhost`, which is a name, so only another device or an address
    # is worth reporting.
    if not by_address and transport.request_is_loopback(request):
        return None
    if not by_address:
        return _item("named_host", "Opened by name", MET,
                     "This browser uses the server's name, which passkeys need.")
    return _item(
        "named_host", "Opened by name", NOT_MET,
        "This browser uses the server's IP address, so passkeys cannot be used. Open it by name instead.",
        "/help/running-a-server", "Running as a server",
    )


def _vault_passphrase_item(request: Request, tasks: dict[str, dict]) -> dict | None:
    user = getattr(request.state, "user", None) or {}
    if not user.get("id") or not crypto_service.has_own_passphrase(user["id"]):
        return None
    title = "Strong vault passphrase"
    if "vault_passphrase_change" in tasks:
        return _item("vault_passphrase", title, NOT_MET, tasks["vault_passphrase_change"]["description"],
                     "/tasks", "Open Tasks")
    if "vault_passphrase_check" in tasks:
        return _item("vault_passphrase", title, UNKNOWN, tasks["vault_passphrase_check"]["description"],
                     "/tasks", "Open Tasks")
    return _item("vault_passphrase", title, MET, "Your vault passphrase is strong.")


def _backup_item(tasks: dict[str, dict]) -> dict | None:
    if not credentials_exports_detail():
        return None
    title = "Vault is backed up"
    due = tasks.get("backup_due")
    if not due:
        return _item("backups", title, MET,
                     "The vault and data provider credentials have not changed since the last backup.")
    return _item("backups", title, NOT_MET, due["description"], "/settings?section=backup", "Open Backup / Restore")


def _certificate_item(tasks: dict[str, dict]) -> dict | None:
    if not proxy_certificate.has_record():
        return None
    title = "Server certificate unchanged"
    task = tasks.get("proxy_certificate_changed")
    if not task:
        return _item("certificate", title, MET, "The proxy is using the certificate your devices installed.")
    return _item("certificate", title, NOT_MET, task["description"], task["link"], task["link_label"])


def _update_item(tasks: dict[str, dict]) -> dict:
    title = "Latest version"
    if not update_check.is_enabled():
        return _item("update", title, UNKNOWN, "Checking for new versions is turned off.",
                     "/settings?section=about", "Turn it on in About")
    task = tasks.get("update_available")
    if not task:
        return _item("update", title, MET, "No newer version was found at the last check.")
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
