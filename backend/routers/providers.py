# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Per-provider app-credential configuration — the Configure card's backend (security-and-deployment-model
phase 6b). Admin-gated to configure; the app credential lives in the vaulted DB (`provider_config`), the
secret encrypted under the workspace DEK. Reading status never returns the secret, only whether one is on
file and from where (vaulted DB vs. `.env` bootstrap). The secret is readable in exactly one place, and
only on request: `GET /{provider}/secret`, the Configure dialog's reveal (see its docstring for why that
is a narrow exception rather than a hole in the write-only rule). This is where provider configuration
moves to, out of the Settings environment form.
"""

import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend import transport
from backend.app_logging import log_warning
from backend.db.control_database import auth_required
from backend.db.database import get_db
from backend.db.demo_data import is_demo_data_loaded
from backend.routers.accounts import resolve_default_owner_id, upsert_connection_accounts
from backend.routers.auth import _require_admin_or_local
from backend.services import crypto_service
from backend.services.connection_mapping import unmapped_count
from backend.services.providers import (
    UnknownProviderError,
    get_adapter,
    get_provider_config_status,
    resolve_app_config,
    set_provider_config,
    supported_providers,
)
from backend.services.providers.config import list_connections

router = APIRouter()


class ProviderConfigRequest(BaseModel):
    client_id: str | None = None
    secret: str | None = None
    env: str | None = None


class ConnectRequest(BaseModel):
    # Whatever the provider's connect step collected, described per adapter by `connect_spec`. Deliberately
    # untyped: a Link provider posts {"public_token": …}, a token provider {"setup_token": …}, and the
    # router has no business knowing which.
    payload: dict = {}
    # Which existing connection this authorization *replaces*, where the user was asked. Only meaningful
    # for a provider whose handle is derived from its credential (`stable_external_id = False`) — see
    # `establish_connection` for why the question has to be answered before the provider is called.
    adopt_connection_id: str | None = None


class DisconnectRequest(BaseModel):
    external_id: str


class RefreshAccountsRequest(BaseModel):
    external_id: str


def _validate_provider(provider: str):
    try:
        get_adapter(provider)
    except UnknownProviderError:
        raise HTTPException(status_code=404, detail=f"Unknown provider {provider!r}")


def require_app_config(request: Request, provider: str) -> dict:
    """Resolve the provider's app credential (vaulted DB or `.env` bootstrap). 409 when the provider is
    unconfigured; 423 when its secret is vaulted but the vault is locked (resolve raises VaultLocked).

    A provider that declares `requires_app_config = False` has no such credential to resolve and gets an
    empty config: for it, "nothing configured" is the normal, permanent state rather than a setup step
    left undone, so the 409 would be a dead end the user could never clear.
    """
    if not get_adapter(provider).requires_app_config:
        return {}
    try:
        app_config = resolve_app_config(request.state.user, provider)
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to use this data source.",
        })
    if not app_config:
        raise HTTPException(status_code=409, detail={
            "code": "provider_not_configured",
            "message": "Configure this data source's credentials before connecting.",
        })
    return app_config


def establish_connection(request: Request, provider: str, payload: dict,
                         *, adopt_connection_id: str | None = None) -> dict:
    """Authorize a data source and record it — the whole connect flow, shared by every provider.

    Only the handshake differs between providers, and the adapter's `connect` absorbs that; everything
    after it (encrypt the credential under the vault, upsert the connection on its provider handle, record
    the accounts it offers, count what still needs mapping) is provider-agnostic. Keeping one
    implementation is not tidiness: the Link path and a token path that drifted apart would disagree about
    credential custody and account adoption, which is precisely the class of bug the connection seam
    exists to prevent.

    Returning the connection id lets the client scope the initial backfill to just this bank. `unmapped` is
    non-zero on a fresh connect: the client must run the mapping step before the backfill, since an
    unmapped provider account has no account to sync into and the mapping is what gives duplicate
    detection its cross-account alias.

    **`adopt_connection_id` re-points an existing connection instead of inserting a new one.** It exists
    for a provider that declares `stable_external_id = False`: its handle is derived from the credential,
    so re-authorizing the same source yields a *different* `external_id` and the upsert below would insert
    a second row, stranding the first. Nothing keyed to `connection_id` moves when the row is re-pointed —
    per-account coverage, the cursor, sync history and `account.connection_id` all survive because they
    were never touched — which is the whole reason this is a re-point rather than an insert-and-migrate.
    (The account *mappings* survive either way: `record_provider_accounts` and sync both key on
    `account.external_account_id`.)

    **The caller must ask before this runs, not after.** A claim or exchange is single-use, so by the time
    the handle is known there is no authorizing again to act on a different answer — which is why this
    takes a decision rather than returning candidates for one.
    """
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before connecting a data source.",
            })
    # A connected bank stores a live access credential, which must never sit unencrypted — so connecting
    # always requires a vault, unlocked, regardless of the app-login perimeter (they are orthogonal).
    user = request.state.user
    if not crypto_service.vault_configured():
        raise HTTPException(status_code=409, detail={
            "code": "vault_not_configured",
            "message": "Set a vault passphrase before connecting a data source.",
        })
    if not crypto_service.is_unlocked(user["id"]):
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to connect a data source.",
        })

    adapter = get_adapter(provider)
    # Unconditional, and deliberately kept even though `set_passphrase` now refuses to write a weak slot:
    # this is the boundary where a live bank credential is about to be stored, and it asserts the property
    # that makes storing it safe rather than trusting that every path which could have created a slot
    # enforced it. It used to ask the *adapter* whether this particular attempt was live enough to deserve
    # a strong passphrase; that question has only one answer now, and asking it per provider was one more
    # thing a new adapter could answer wrongly.
    if not crypto_service.ready_for_production():
        raise HTTPException(status_code=400, detail={
            "code": "weak_vault",
            "message": (
                "Set a strong vault passphrase before connecting a data source. Each vault passphrase must "
                f"be at least {crypto_service.VAULT_PRODUCTION_MIN_LEN} characters with at least "
                f"{crypto_service.VAULT_PRODUCTION_MIN_DISTINCT} distinct characters."
            ),
        })

    app_config = require_app_config(request, provider)
    try:
        result      = adapter.connect(app_config, payload)
        credential  = result["credential"]
        external_id = result["external_id"]
        institution = result.get("institution")
        accounts    = adapter.fetch_accounts(app_config, credential)
    except HTTPException:
        raise
    except Exception as e:
        # 502, not 500: the provider refused or could not be reached, which is not an internal fault and
        # is not the user's to report as a bug. The adapter's message is passed through intact because it
        # is the only thing that says *what went wrong* — collapsing it into "Internal Server Error" is
        # what turns a five-second fix into a debugging session. Logged as well, since connect writes no
        # other record anywhere (unlike sync, which has its diagnostics log).
        log_warning(f"[connect] {provider} connect failed: {e}")
        raise HTTPException(status_code=502, detail={
            "code": "provider_error",
            "message": str(e) or f"Could not connect to {provider}.",
        })

    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        # Store the credential on the connection even if account rows are edited later; sync needs a
        # stable credential lookup keyed by the connection's provider handle, not the local account rows.
        # The connection is upserted first so its id is available to stamp on the account rows below.
        stored_credential, stored_credential_enc = crypto_service.encrypt_connection_credential(
            user, provider, external_id, credential
        )
        # Whether the user's "this replaces X" answer can actually be honored, resolved here rather than
        # up front **because the authorization is already spent**: a claim or exchange is single-use, so
        # refusing the request before calling the provider would burn the user's token over a decision the
        # ordinary path can absorb. Both ways it can be stale are absorbed the same way — by falling
        # through to the upsert below and reporting that adoption did not happen:
        #
        #   * the named connection is gone (disconnected in another tab since the dialog was filled in);
        #   * the handle the provider just issued already belongs to a *different* row, which means this is
        #     really a credential refresh of that row. Re-pointing would trip the UNIQUE index, and the
        #     upsert lands it on the right connection anyway.
        adopt_target = None
        if adopt_connection_id:
            named = conn.execute(
                "SELECT id FROM connection WHERE id = ? AND provider = ?",
                (adopt_connection_id, provider),
            ).fetchone()
            holder = conn.execute(
                "SELECT id FROM connection WHERE provider = ? AND external_id = ?",
                (provider, external_id),
            ).fetchone()
            if named and (holder is None or holder["id"] == named["id"]):
                adopt_target = named["id"]

        if adopt_target:
            # Re-point the surviving row: swap the handle and the credential, and leave every other column
            # exactly as it is. That is the entire feature — per-account coverage, the cursor, sync history
            # and `account.connection_id` all live on or point at this row, so not moving them is what
            # preserves them.
            #
            # `reauth_required` is deliberately NOT cleared here, matching the upsert below. The flag is
            # retired by *proof* — a pull that returned data (see `routers/sync.py`) — not by a claim that
            # the credential is fresh, and clearing it on one connect path but not the other would leave
            # the two disagreeing about what the flag means.
            conn.execute(
                """
                UPDATE connection
                   SET external_id = ?, credential = ?, credential_enc = ?,
                       institution = COALESCE(?, institution)
                 WHERE id = ?
                """,
                (external_id, stored_credential, stored_credential_enc, institution, adopt_target),
            )
            connection_id = adopt_target
        else:
            # Upsert the connection atomically on its (provider, external_id) unique key. A user can
            # complete the connect step more than once for the same bank (Plaid's onSuccess may fire twice;
            # a re-link re-exchanges), and those calls can race — a check-then-insert would let the loser
            # hit the UNIQUE constraint and 500. ON CONFLICT makes a duplicate connect a clean
            # credential-refresh instead.
            conn.execute(
                """
                INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(provider, external_id) DO UPDATE SET
                    credential = excluded.credential,
                    credential_enc = excluded.credential_enc,
                    institution = COALESCE(excluded.institution, connection.institution)
                """,
                (str(uuid.uuid4()), provider, external_id, stored_credential, stored_credential_enc, institution),
            )
            connection_id = conn.execute(
                "SELECT id FROM connection WHERE provider = ? AND external_id = ?",
                (provider, external_id),
            ).fetchone()["id"]

        # A connection is connection-centric: one authorization can fan out to many accounts, and later
        # sync discovers the credential by connection, matching transactions to accounts by external id.
        # This records what the bank *offers* and re-applies any mapping already on file (a re-connect of a
        # previously-disconnected bank re-attaches cleanly); it deliberately does NOT create local
        # accounts for undecided ones. The mapping step does that — see services/connection_mapping.py.
        upsert_connection_accounts(
            conn, connection_id=connection_id, provider=provider,
            institution=institution, accounts=accounts, default_owner_id=default_owner_id,
        )
        pending_mapping = unmapped_count(conn, connection_id)

    return {
        "ok": True, "accounts_added": len(accounts), "connection_id": connection_id,
        "provider": provider, "unmapped": pending_mapping,
        # Reported rather than assumed: a re-link the user asked for can legitimately land as an ordinary
        # connect (see the staleness cases above), and the two outcomes leave them looking at different
        # things — one connection carrying its history, or a second one alongside the first.
        "adopted": bool(adopt_target),
    }


@router.post("/{provider}/connect")
def connect(provider: str, body: ConnectRequest, request: Request):
    """Connect a data source whose authorization is not a Link widget — a pasted setup token, a form.
    Link-style providers keep their own entry point (`/plaid/exchange`) because their payload arrives from
    the widget's callback, but both routes converge on `establish_connection` immediately."""
    _validate_provider(provider)
    return establish_connection(request, provider, body.payload or {},
                                adopt_connection_id=body.adopt_connection_id)


@router.get("")
def list_providers(request: Request):
    # `connect_spec` and `requires_app_config` travel with each provider so the Connections tab can render
    # the right affordances — a paste field vs. a Link button, a Configure action or none — without keeping
    # its own list of which provider works which way.
    _require_admin_or_local(request)
    out = []
    for p in supported_providers():
        adapter = get_adapter(p)
        out.append({
            **get_provider_config_status(p),
            "connections": list_connections(p),
            "connect_spec": adapter.connect_spec,
            # The noun for the connect button, where one connect action adds a nameable thing (Plaid: one
            # institution). None where it does not, and the button stays a bare "+ Connect".
            "connect_noun": adapter.connect_noun,
            "requires_app_config": adapter.requires_app_config,
            "revokes_on_disconnect": adapter.revokes_on_disconnect,
            # Drives the re-link question in the connect dialog: False means a fresh credential produces a
            # fresh handle, so the UI must ask which connection this replaces before the provider is called.
            "stable_external_id": adapter.stable_external_id,
        })
    return {"providers": out}


@router.get("/{provider}/config")
def get_config(provider: str, request: Request):
    _require_admin_or_local(request)
    _validate_provider(provider)
    return get_provider_config_status(provider)


@router.post("/{provider}/config")
def save_config(provider: str, body: ProviderConfigRequest, request: Request):
    _require_admin_or_local(request)
    _validate_provider(provider)
    if not get_adapter(provider).requires_app_config:
        raise HTTPException(status_code=409, detail={
            "code": "no_app_credential",
            "message": "This data source has no app-level credentials to configure.",
        })
    # No environment gate here any more. Switching to Production used to demand a strong passphrase,
    # because Sandbox accepted a weak one; with the weak tier gone the check could only ever pass, and
    # keeping it would tell the user that the environment is what governs their passphrase — which is
    # exactly the model this change removes. Storing a secret at all still requires an unlocked vault
    # (the VaultLocked arm below), and that vault is strong by construction.
    try:
        set_provider_config(
            request.state.user, provider,
            client_id=body.client_id, secret=body.secret, env=body.env,
        )
    except crypto_service.VaultLocked:
        # The secret is vault-encrypted, so storing one needs the vault configured and unlocked.
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Set and unlock a vault passphrase before saving this data source's secret.",
        })
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = get_provider_config_status(provider)
    # Configuring a provider puts a live bank secret in play; warn (don't force) when this instance is
    # reachable over a cleartext network link — the connect gate is where HTTPS is actually enforced.
    warning = transport.cleartext_warning(request, perimeter_on=auth_required(), provider_intended=True)
    if warning:
        result["transport_warning"] = warning
    return result


@router.get("/{provider}/secret")
def get_secret(provider: str, request: Request):
    """Return the app secret in the clear, for the Configure dialog's reveal.

    A diagnostic, not part of the normal flow: the one thing it answers is "does the secret stored here
    match the one on the provider's dashboard", which nothing else can settle — the value is write-only
    everywhere else (`get_provider_config_status` returns `has_secret` and never the secret, and the
    Configure field keeps its blank-means-unchanged semantics).

    It deliberately does **not** re-prompt for the vault passphrase when the vault is already unlocked.
    An unlocked vault is the app's authorization boundary and sync/disconnect/refresh all ride it; a
    second challenge only here would be inconsistent without raising the bar. The reveal is a separate
    call rather than a field on the status payload precisely so a plaintext secret can only ever appear
    in a response the user explicitly asked for.

    Reuses `resolve_app_config` — the same decryption path a sync takes — so there is one way to turn a
    stored credential back into plaintext, and the vault gate cannot be bypassed by asking here.
    """
    _require_admin_or_local(request)
    _validate_provider(provider)
    try:
        app_config = resolve_app_config(request.state.user, provider)
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to view this data source's secret.",
        })
    if not app_config or not app_config.get("secret"):
        raise HTTPException(status_code=409, detail={
            "code": "no_secret",
            "message": "This data source has no secret on file.",
        })
    return {"secret": app_config["secret"], "source": get_provider_config_status(provider)["source"]}


@router.post("/{provider}/disconnect")
def disconnect(provider: str, body: DisconnectRequest, request: Request):
    # Revoke a linked connection *at the provider* (so any leaked copy of the token dies too — the
    # mitigation the threat model relies on), then drop the local connection row. Needs the vault unlocked
    # to decrypt the credential; not admin-gated (symmetric with connect/sync). Accounts + their
    # transactions are preserved — they simply stop being backed by a live connection.
    _validate_provider(provider)
    user = request.state.user
    with get_db() as conn:
        row = conn.execute(
            "SELECT external_id, credential, credential_enc FROM connection WHERE provider = ? AND external_id = ?",
            (provider, body.external_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    app_config = require_app_config(request, provider)
    credential = None
    try:
        credential = crypto_service.decrypt_connection_credential(
            user, provider, row["external_id"], row["credential"], row["credential_enc"]
        )
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to disconnect this data source.",
        })
    except (crypto_service.MissingCredential, crypto_service.VaultDecryptError):
        # There is no credential to revoke *with* — a vault reset clears them and deliberately keeps the
        # connection rows. The revoke is skipped rather than attempted: sending an empty token earns a
        # provider error, and the 502 below would then make the row undeletable, which is precisely the
        # cleanup the reset leaves the user needing to do. Reported so the response can say the access was
        # not revoked, which for a provider that *can* revoke is a real caveat.
        credential = None

    revoked = False
    if credential is not None:
        try:
            get_adapter(provider).remove(app_config, credential)
            revoked = get_adapter(provider).revokes_on_disconnect
        except Exception as exc:
            # Keep the local connection if provider-side revocation failed, so the user can retry rather
            # than believe the token is dead when it may still be live.
            raise HTTPException(status_code=502, detail=f"Could not revoke the connection at the provider: {exc}")
    with get_db() as conn:
        conn.execute("DELETE FROM connection WHERE provider = ? AND external_id = ?", (provider, body.external_id))
    return {"ok": True, "revoked": revoked}


@router.post("/{provider}/refresh-accounts")
def refresh_accounts(provider: str, body: RefreshAccountsRequest, request: Request):
    # Rebuild the local account rows for an existing connection from its still-valid credential — no
    # re-linking, no token churn. The recovery path when a backup restore rolls back the ledger (account
    # rows included) but leaves the live connection intact (connections are credential data the restore
    # never carries — see import_export/backup.py), leaving a connection whose accounts are gone and whose
    # sync therefore skips every fetched transaction for lack of a matching account. Needs the vault
    # unlocked to decrypt the credential; not admin-gated (symmetric with connect/sync/disconnect). Never
    # revokes anything. The caller then backfills history via POST /sync?connection_id=…&days=0.
    _validate_provider(provider)
    user = request.state.user
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, external_id, credential, credential_enc, institution FROM connection WHERE provider = ? AND external_id = ?",
            (provider, body.external_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    app_config = require_app_config(request, provider)
    try:
        credential = crypto_service.decrypt_connection_credential(
            user, provider, row["external_id"], row["credential"], row["credential_enc"]
        )
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to refresh this data source.",
        })
    except (crypto_service.MissingCredential, crypto_service.VaultDecryptError):
        raise HTTPException(status_code=409, detail={
            "code": "no_credential",
            "message": "This connection has no usable credential, so its accounts cannot be refreshed. "
                       "Connect the data source again, then disconnect this one.",
        })
    try:
        accounts = get_adapter(provider).fetch_accounts(app_config, credential)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch accounts from the provider: {exc}")
    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        upsert_connection_accounts(
            conn, connection_id=row["id"], provider=provider,
            institution=row["institution"], accounts=accounts, default_owner_id=default_owner_id,
        )
    return {"ok": True, "accounts_added": len(accounts), "connection_id": row["id"]}
