# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Responding to an exposed database while the vault can still be opened.

A copy of the database carries every stored provider credential, sealed only by how well the vault
passphrase resists an offline attack. Changing the passphrase and replacing the vault key protect what is
encrypted *afterwards*; neither touches a credential already sitting in someone else's copy. Only the
provider can retire that — and how it does so is the provider's to define, so every step here follows that
provider's documentation on how its credentials are deactivated rather than a rule of our own.

**Reissue, don't revoke, where the provider allows it.** A provider declaring `reissues_credential` swaps a
connection's credential for a new one and kills the old (Plaid's `/item/access_token/invalidate`), so the
copied credential dies while the connection keeps syncing. Revoking would kill it just as surely and then
cost a re-link the institution or the plan may not grant — which is why this exists beside the vault
reset's *exposed* path rather than being that path. The reset remains the route for a forgotten
passphrase, where nothing can be decrypted and so nothing can be sent to a provider.

**Where a credential needs the app secret, replacing it is hygiene, not containment.** A provider declaring
`credential_needs_app_secret` refuses every request that lacks the secret, so rotating the secret already
retires a copied credential; the reissue only covers an old secret not yet deleted at the provider. Such an
outcome carries `covered_by_app_secret`, and its line states the outcome with nothing for the user to do.

**The app-level secret is always left to the user.** It is not per-connection, no API call retires it, and
reissuing every connection's credential does not change it. What the provider's documentation says about
deactivating it decides the wording: Plaid keeps a rotated-away secret working until it is deleted, so the
step is *rotate, enter the new one, then delete the old one* — rotating alone retires nothing.
"""

from backend.db.database import get_db
from backend.services import connection_log, crypto_service
from backend.services.providers import UnknownProviderError, get_adapter, resolve_app_config
from backend.services.providers.config import sync_marker_is_live

# What became of each connection. Only `manual` and `failed` leave the user something to do at the provider.
REISSUED = "reissued"      # a new credential is stored and the copied one no longer works
MANUAL = "manual"          # the provider cannot reissue; revoke it there, then link again
FAILED = "failed"          # the provider refused or errored; the stored credential is unchanged
UNREADABLE = "unreadable"  # nothing could be decrypted, so nothing was sent


class SyncInProgress(Exception):
    """A sync holds a connection's current credential in memory; replacing it underneath fails that pull."""


def app_secrets_to_rotate() -> list[dict]:
    """The providers whose app-level secret is stored, and so was in whatever copy was exposed.

    Read from what is stored rather than from an adapter capability: a secret that was never saved was never
    exposed. The vault reset calls this before it clears the column it reads.
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT provider FROM provider_config WHERE secret_enc IS NOT NULL OR secret != '' ORDER BY provider"
        ).fetchall()
    return [{"provider": r["provider"]} for r in rows]


def _connection_label(row: dict) -> str:
    return (row["institution"] or "").strip() or f"{row['provider']} ({row['external_id']})"


def reissue_all_credentials(user: dict) -> list[dict]:
    """Replace every connection's credential where its provider can, returning one outcome per connection.

    Refused while a sync is live: that pull holds the credential being replaced and would fail on it. Never
    raises for a provider-side problem — each connection is reported, so one refusal does not strand the
    rest. Each new credential is written in its own transaction the moment it is issued, because the old
    one is already dead at the provider and a later failure must not take the replacement with it.
    """
    with get_db() as conn:
        connections = [dict(r) for r in conn.execute(
            "SELECT id, provider, external_id, institution, credential, credential_enc, sync_started_at "
            "FROM connection ORDER BY institution, provider"
        ).fetchall()]
    if any(sync_marker_is_live(c["sync_started_at"]) for c in connections):
        raise SyncInProgress("A sync is running. Wait for it to finish, then try again.")

    outcomes, failures = [], {}
    for row in connections:
        base = {"connection_id": row["id"], "provider": row["provider"], "label": _connection_label(row),
                "covered_by_app_secret": False}
        try:
            adapter = get_adapter(row["provider"])
        except UnknownProviderError:
            outcomes.append({**base, "outcome": MANUAL, "detail": "This data source is no longer supported."})
            continue
        base["covered_by_app_secret"] = adapter.credential_needs_app_secret
        if not adapter.reissues_credential:
            outcomes.append({**base, "outcome": MANUAL, "detail": None})
            continue

        try:
            credential = crypto_service.decrypt_connection_credential(
                user, row["provider"], row["external_id"], row["credential"], row["credential_enc"],
            )
        except (crypto_service.VaultDecryptError, crypto_service.MissingCredential):
            outcomes.append({**base, "outcome": UNREADABLE, "detail": None})
            continue

        try:
            app_config = {} if not adapter.requires_app_config else (
                resolve_app_config(user, row["provider"]) or {}
            )
            replacement = adapter.reissue_credential(app_config, credential)
        except Exception as exc:
            failures[row["id"]] = exc
            outcomes.append({**base, "outcome": FAILED, "detail": str(exc)[:200] or None})
            continue

        stored, stored_enc = crypto_service.encrypt_connection_credential(
            user, row["provider"], row["external_id"], replacement,
        )
        with get_db() as conn:
            conn.execute(
                "UPDATE connection SET credential = ?, credential_enc = ? WHERE id = ?",
                (stored, stored_enc, row["id"]),
            )
        outcomes.append({**base, "outcome": REISSUED, "detail": None})
    connection_log.record_outcomes(connection_log.REISSUE, outcomes, connections, failed=FAILED, errors=failures)
    return outcomes

