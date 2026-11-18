# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Per-provider app-credential configuration — the Configure card's backend. Admin-gated to configure; the app credential lives in the vaulted DB (`provider_config`), the
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
from backend.db.database import get_db
from backend.db.demo_data import is_demo_data_loaded
from backend.routers.accounts import resolve_default_owner_id, upsert_connection_accounts
from backend.authorization import require_admin_or_local
from backend.services import connection_log, crypto_service
from backend.services.connection_mapping import unmapped_count
from backend.services.recurring_detection import settle_owed_rescans
from backend.services.providers import (
    UnknownProviderError,
    get_adapter,
    get_provider_config_status,
    resolve_app_config,
    set_provider_config,
    supported_providers,
)
from backend.services.providers.config import (
    clear_provider_config,
    list_connections,
    remove_connection,
    sync_marker_is_live,
)

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
    # Remove the connection from this install only, leaving its access live at the provider. Chosen up
    # front when another install shares the credential (a restored copy holds the same token, so revoking
    # here would end the access there too), or as the answer to a `revoke_failed` refusal.
    remove_without_revoking: bool = False


class RefreshAccountsRequest(BaseModel):
    external_id: str


def _validate_provider(provider: str):
    try:
        get_adapter(provider)
    except UnknownProviderError:
        raise HTTPException(status_code=404, detail=f"Unknown provider {provider!r}")


def require_app_config(request: Request, provider: str) -> dict:
    """Resolve the provider's app credential from its saved row. 409 when the provider is
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
            "message": "Unlock the vault to use this data provider.",
        })
    if not app_config:
        raise HTTPException(status_code=409, detail={
            "code": "provider_not_configured",
            "message": "Configure this data provider's credentials before connecting.",
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
    # First, before the provider is asked for anything: the payload is the authorization itself, and a
    # refusal after the handshake would have already spent a single-use claim.
    transport.require_protected_link(request)
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before connecting a data provider.",
            })
    # A connected bank stores a live access credential, which must never sit unencrypted — so connecting
    # always requires a vault, unlocked, regardless of the app-login perimeter (they are orthogonal).
    user = request.state.user
    if not crypto_service.vault_configured():
        raise HTTPException(status_code=409, detail={
            "code": "vault_not_configured",
            "message": "Set a vault passphrase before connecting a data provider.",
        })
    if not crypto_service.is_unlocked(user["id"]):
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to connect a data provider.",
        })

    adapter = get_adapter(provider)
    # Unconditional, and deliberately kept even though `set_passphrase` refuses to write a weak slot: a
    # slot can fall below the floor later, when the rule tightens and its passphrase is re-judged at
    # unlock. This is the boundary where a live bank credential is about to be stored, and it asserts the
    # property that makes storing it safe rather than trusting that every path which could have created a
    # slot enforced it. It used to ask the *adapter* whether this particular attempt was live enough to deserve
    # a strong passphrase; that question has only one answer now, and asking it per provider was one more
    # thing a new adapter could answer wrongly.
    if not crypto_service.ready_for_production():
        raise HTTPException(status_code=400, detail={
            "code": "weak_vault",
            "message": (
                "A vault passphrase in this workspace does not meet the strength rule, so no data provider "
                "can be connected until its owner changes it in Vault settings."
                if not crypto_service.passphrase_needs_change(user["id"]) else
                "Your vault passphrase does not meet the strength rule. Change it in Vault settings before "
                "connecting a data provider."
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
        # what turns a five-second fix into a debugging session. Recorded in the connection log under the
        # connection being re-linked, if one was named, and otherwise with the provider's connect attempts.
        with get_db() as conn:
            relinking = conn.execute(
                "SELECT id, institution FROM connection WHERE id = ? AND provider = ?",
                (adopt_connection_id, provider),
            ).fetchone() if adopt_connection_id else None
        connection_log.record_event(
            event=connection_log.RECONNECT if relinking else connection_log.CONNECT,
            provider=provider,
            connection_id=relinking["id"] if relinking else None,
            institution=relinking["institution"] if relinking else payload.get("institution_name"),
            error=str(e) or f"Could not connect to {provider}.",
            detail=connection_log.error_detail(e),
        )
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
        # Labelled from the row rather than `institution`, which a provider may leave empty and the upsert
        # then keeps the stored name for.
        stored_institution = conn.execute(
            "SELECT institution FROM connection WHERE id = ?", (connection_id,),
        ).fetchone()["institution"]
        connection_log.write_event(
            conn, event=connection_log.RECONNECT if adopt_target else connection_log.CONNECT,
            provider=provider, connection_id=connection_id, institution=stored_institution,
            detail={"accounts": len(accounts), "unmapped": pending_mapping},
        )
    settle_owed_rescans()

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
    require_admin_or_local(request)
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
            # Names the card's menu entry: with nothing optional to capture, the dialog it opens is only
            # the account mapping, and "settings" would promise choices it does not have.
            "has_optional_capture_fields": any(not f.get("locked") for f in adapter.capture_fields()),
        })
    return {"providers": out}


@router.get("/{provider}/config")
def get_config(provider: str, request: Request):
    require_admin_or_local(request)
    _validate_provider(provider)
    return get_provider_config_status(provider)


@router.post("/{provider}/config")
def save_config(provider: str, body: ProviderConfigRequest, request: Request):
    require_admin_or_local(request)
    _validate_provider(provider)
    if not get_adapter(provider).requires_app_config:
        raise HTTPException(status_code=409, detail={
            "code": "no_app_credential",
            "message": "This data provider has no app-level credentials to configure.",
        })
    # Only a save that carries the secret: the client id and the environment are not secrets, and the
    # dialog leaves the secret blank to mean "unchanged".
    if body.secret:
        transport.require_protected_link(request)
    # No environment gate here any more. Switching to Production used to demand a strong passphrase,
    # because Sandbox accepted a weak one; with the weak tier gone the check could only ever pass, and
    # keeping it would tell the user that the environment is what governs their passphrase — which is
    # exactly the model this change removes. Every save requires an unlocked vault (the VaultLocked arm
    # below), and that vault is strong by construction.
    try:
        set_provider_config(
            request.state.user, provider,
            client_id=body.client_id, secret=body.secret, env=body.env,
        )
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Set and unlock a vault passphrase before configuring this data provider.",
        })
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return get_provider_config_status(provider)


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
    require_admin_or_local(request)
    _validate_provider(provider)
    transport.require_protected_link(request)
    try:
        app_config = resolve_app_config(request.state.user, provider)
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to view this data provider's secret.",
        })
    if not app_config or not app_config.get("secret"):
        raise HTTPException(status_code=409, detail={
            "code": "no_secret",
            "message": "This data provider has no secret on file.",
        })
    return {"secret": app_config["secret"], "source": get_provider_config_status(provider)["source"]}


@router.delete("/{provider}/config")
def remove_config(provider: str, request: Request, revoke: bool = True):
    """Remove a provider from this install: every connection under it, then its app credential.

    The connections go first because each one needs the app credential to be revoked, and a connection
    left without it could neither sync nor be revoked later. `revoke` is the same choice a single
    disconnect offers. With it, each connection is revoked and removed in turn, and a refusal stops the
    walk with the app credential kept: the connections already revoked are gone, and the rest wait for the
    user to retry or to remove them from this install only. Without it nothing is sent to the provider.

    Like every save of the app credential, it needs the vault unlocked, since it discards a vaulted value.
    Accounts and transactions are kept, as with any disconnect."""
    require_admin_or_local(request)
    _validate_provider(provider)
    if not get_adapter(provider).requires_app_config:
        raise HTTPException(status_code=409, detail={
            "code": "no_app_credential",
            "message": "This data provider has no app-level credentials to remove.",
        })
    user = request.state.user
    if not crypto_service.is_unlocked(user["id"]):
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to remove this data provider.",
        })
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, institution, external_id, credential, credential_enc, sync_started_at "
            "FROM connection WHERE provider = ? ORDER BY created_at, id",
            (provider,),
        ).fetchall()
    if any(sync_marker_is_live(r["sync_started_at"]) for r in rows):
        raise HTTPException(status_code=409, detail={
            "code": "sync_running",
            "message": "A sync is running for this data provider. Try again once it finishes.",
        })
    for row in rows:
        _disconnect_row(request, provider, row, user, revoke=revoke)
    clear_provider_config(provider)
    return {"ok": True, "removed_connections": len(rows)}


@router.post("/{provider}/disconnect")
def disconnect(provider: str, body: DisconnectRequest, request: Request):
    # Revoke a linked connection *at the provider* (so any leaked copy of the token dies too — the
    # mitigation the threat model relies on), then drop the local connection row; or, on request, drop the
    # row alone. Revoking needs the vault unlocked to decrypt the credential; not admin-gated (symmetric
    # with connect/sync). Accounts + their transactions are preserved — they simply stop being backed by a
    # live connection.
    _validate_provider(provider)
    user = request.state.user
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, institution, external_id, credential, credential_enc FROM connection "
            "WHERE provider = ? AND external_id = ?",
            (provider, body.external_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    revoked = _disconnect_row(request, provider, row, user, revoke=not body.remove_without_revoking)
    return {"ok": True, "revoked": revoked}


def _disconnect_row(request: Request, provider: str, row, user, *, revoke: bool) -> bool:
    """Remove one connection, revoking it at the provider first when `revoke` asks; returns whether access
    ended there. The log row's reason says why it did not: nothing stored to revoke with, a provider with
    no revocation call, or the user keeping the access live for use elsewhere. A connection with nothing
    stored is removed the same way whichever was asked, needing neither the vault nor the app credential."""
    has_credential = crypto_service.connection_has_credential(row["credential"], row["credential_enc"])
    if revoke and has_credential:
        credential, revoked = _revoke_for_disconnect(request, provider, row, user)
        reason = None if revoked else "no_credential" if credential is None else "provider_cannot_revoke"
    else:
        revoked, reason = False, "kept_at_provider" if has_credential else "no_credential"
    with get_db() as conn:
        remove_connection(conn, {"id": row["id"], "provider": provider, "institution": row["institution"]},
                          revoked=revoked, reason=reason)
    return revoked


def _revoke_for_disconnect(request: Request, provider: str, row, user) -> tuple:
    """Revoke a connection's credential at its provider ahead of removing it: `(credential, revoked)`, the
    credential None when there was none to send.

    A provider that refuses is a `revoke_failed` 502 and the connection stays, so a passing failure can be
    retried rather than the user believing the token dead when it may still be live. Some refusals never
    pass — the app credentials changed to another environment, or the provider account ended — so the
    refusal is also where the user can choose to remove it anyway (`remove_without_revoking`)."""
    app_config = require_app_config(request, provider)
    credential = None
    try:
        credential = crypto_service.decrypt_connection_credential(
            user, provider, row["external_id"], row["credential"], row["credential_enc"]
        )
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to disconnect this connection.",
        })
    except (crypto_service.MissingCredential, crypto_service.VaultDecryptError):
        # There is no credential to revoke *with* — a vault reset clears them and deliberately keeps the
        # connection rows. The revoke is skipped rather than attempted: sending an empty token earns a
        # provider error, and the 502 below would then make the row undeletable, which is precisely the
        # cleanup the reset leaves the user needing to do. Reported so the response can say the access was
        # not revoked, which for a provider that *can* revoke is a real caveat.
        credential = None

    if credential is None:
        return None, False
    try:
        get_adapter(provider).remove(app_config, credential)
    except Exception as exc:
        message = f"Could not revoke the connection at the provider: {exc}"
        connection_log.record_event(event=connection_log.DISCONNECT, provider=provider,
                                    connection_id=row["id"], institution=row["institution"], error=message,
                                    detail=connection_log.error_detail(exc))
        raise HTTPException(status_code=502, detail={"code": "revoke_failed", "message": message})
    return credential, get_adapter(provider).revokes_on_disconnect


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
            "message": "Unlock the vault to refresh this connection.",
        })
    except (crypto_service.MissingCredential, crypto_service.VaultDecryptError):
        raise HTTPException(status_code=409, detail={
            "code": "no_credential",
            "message": "This connection has no usable credential, so its accounts cannot be refreshed. "
                       "Connect the provider again, then disconnect this one.",
        })
    try:
        accounts = get_adapter(provider).fetch_accounts(app_config, credential)
    except Exception as exc:
        message = f"Could not fetch accounts from the provider: {exc}"
        connection_log.record_event(event=connection_log.REFRESH_ACCOUNTS, provider=provider,
                                    connection_id=row["id"], institution=row["institution"], error=message,
                                    detail=connection_log.error_detail(exc))
        raise HTTPException(status_code=502, detail=message)
    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        upsert_connection_accounts(
            conn, connection_id=row["id"], provider=provider,
            institution=row["institution"], accounts=accounts, default_owner_id=default_owner_id,
        )
        connection_log.write_event(
            conn, event=connection_log.REFRESH_ACCOUNTS, provider=provider, connection_id=row["id"],
            institution=row["institution"], detail={"accounts": len(accounts)},
        )
    settle_owed_rescans()
    return {"ok": True, "accounts_added": len(accounts), "connection_id": row["id"]}
