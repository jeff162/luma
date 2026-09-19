# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Retiring provider credentials on the way out of a vault reset.

The reset itself is `crypto_service.reset_vault`, which knows about slots and ciphertext and nothing
about providers. This module is the half that has to talk to them, and it lives apart for that reason:
`crypto_service` is imported by the adapters' configuration path, so reaching back into the adapter
registry from inside it would close a cycle.

**Why revoke at all, when the reset already makes the credentials unusable to this app?** Because
"unusable to us" is not "dead". Clearing `credential_enc` removes Luma's copy; it does nothing to a
copy an attacker already took, which is the entire premise of the compromise path. Re-linking replaces
each credential with a newly *issued* one, so the stolen copy is retired by obsolescence — but only for
providers that actually invalidate on revocation. Revoking first turns the rest into a shorter list the
user has to finish by hand, rather than a silent assumption that they are safe.

**Driven by the declared capability, never by naming a provider.** `revokes_on_disconnect` already
records whether `remove()` genuinely ends the access, so a provider added later inherits the right
behaviour by declaring it — the rule `docs/building-a-connector.md` sets for every capability. Naming
Plaid or SimpleFIN here would mean this file had to be edited for each new adapter, and the one nobody
remembered to add would silently be reported as revoked.

**This deliberately does not copy `disconnect`'s failure behaviour.** That endpoint keeps the local
connection when revocation fails, so the user can retry rather than believe a live token is dead. A
reset cannot honour that — clearing the credentials is the point, and it is about to happen whatever
the provider said. So a failure here is recorded and reported per connection, never raised: the user
is told precisely which ones they must go and revoke themselves, and the reset still completes.
"""

from backend.db.database import get_db
from backend.services import connection_log, crypto_service
from backend.services.providers import UnknownProviderError, get_adapter, resolve_app_config

# What became of each connection's credential at the provider. The dialog groups by these, because they
# ask different things of the user: only `manual` and `failed` leave them with something to do.
REVOKED = "revoked"        # the provider invalidated it; nothing further is needed
FAILED = "failed"          # revocation was attempted and refused or errored — finish it by hand
MANUAL = "manual"          # the provider does not revoke on disconnect; it can only be done there
UNREADABLE = "unreadable"  # the credential could not be decrypted, so there was nothing to send


def _connection_label(row: dict) -> str:
    """What to call a connection in the outcome list. The institution is what the user recognizes; the
    provider handle is a fallback that at least distinguishes two rows of the same source."""
    return (row["institution"] or "").strip() or f"{row['provider']} ({row['external_id']})"


def revoke_all_credentials(user: dict) -> list[dict]:
    """Attempt provider-side revocation for every connection, returning one outcome per connection.

    Never raises for a provider-side problem: see the module comment. The caller runs this *before* the
    reset, while the vault is still open — afterwards there is no credential left to send.
    """
    with get_db() as conn:
        connections = [dict(r) for r in conn.execute(
            "SELECT id, provider, external_id, institution, credential, credential_enc FROM connection"
        ).fetchall()]

    outcomes, failures = [], {}
    for row in connections:
        label = _connection_label(row)
        try:
            adapter = get_adapter(row["provider"])
        except UnknownProviderError:
            # An adapter that no longer exists cannot be asked to revoke, and the credential is about to
            # become unopenable anyway. Reported as manual so it still appears on the user's list.
            outcomes.append({"connection_id": row["id"], "provider": row["provider"], "label": label,
                             "outcome": MANUAL, "detail": "This data source is no longer supported."})
            continue

        if not adapter.revokes_on_disconnect:
            outcomes.append({"connection_id": row["id"], "provider": row["provider"], "label": label,
                             "outcome": MANUAL, "detail": None})
            continue

        try:
            credential = crypto_service.decrypt_connection_credential(
                user, row["provider"], row["external_id"], row["credential"], row["credential_enc"],
            )
        except (crypto_service.VaultLocked, crypto_service.VaultDecryptError,
                crypto_service.MissingCredential):
            # Including the case where nothing is stored at all — a second reset, or a connection whose
            # credential was already cleared. Reported as unreadable rather than attempted: sending an
            # empty token earns a provider error, which would be recorded as "the provider refused" and
            # put a connection on the user's to-do list for a credential that no longer exists.
            outcomes.append({"connection_id": row["id"], "provider": row["provider"], "label": label,
                             "outcome": UNREADABLE, "detail": None})
            continue

        try:
            app_config = {} if not adapter.requires_app_config else (
                resolve_app_config(user, row["provider"]) or {}
            )
            adapter.remove(app_config, credential)
        except Exception as exc:
            failures[row["id"]] = exc
            outcomes.append({"connection_id": row["id"], "provider": row["provider"], "label": label,
                             "outcome": FAILED, "detail": str(exc)[:200] or None})
            continue

        outcomes.append({"connection_id": row["id"], "provider": row["provider"], "label": label,
                         "outcome": REVOKED, "detail": None})
    connection_log.record_outcomes(connection_log.REVOKE, outcomes, connections, failed=FAILED, errors=failures)
    return outcomes


def unfinished(outcomes: list[dict]) -> list[dict]:
    """The connections the user still has to revoke themselves — what the reset's result screen leads
    with, since it is the only part of the outcome that asks anything of them."""
    return [o for o in outcomes if o["outcome"] in (FAILED, MANUAL, UNREADABLE)]
