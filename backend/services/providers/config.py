# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
App-level provider credentials: the aggregator's own app secret (Plaid's client_id + secret + env),
one per provider, moved out of `.env` into the vaulted DB (security-and-deployment-model phase 6b).

Only the secret is sensitive — it is vault-encrypted under the workspace DEK; client_id/env are
semi-public and stored plaintext. The saved `provider_config` row is the only source: the Configure card
writes it, and there is no migration from anywhere else (decided 2026-08-01 — re-entering the credential
once is the whole of it).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from backend.db.database import get_db
from backend.time_utils import utcnow_iso
from backend.services import crypto_service

VALID_ENVS = {"sandbox", "development", "production"}

def _row(conn, provider: str):
    return conn.execute(
        "SELECT provider, client_id, secret, secret_enc, env FROM provider_config WHERE provider = ?",
        (provider,),
    ).fetchone()


def get_provider_config_status(provider: str) -> dict:
    """Non-secret view for the Configure UI: whether the app credential is set, the client_id and env, and
    whether a secret is on file — never the secret itself.
    Revealing it is a separate, explicit call (`GET /api/providers/{provider}/secret`), so a plaintext
    secret never rides along in a payload the caller did not ask for it in.

    A provider with **no app-level credential** answers a different question with the same word: there is
    nothing for an operator to enter, so `configured` reports whether it has been *connected* instead.
    Reporting it unconfigured forever would strand it in the "add a data source" list with a Configure
    dialog that has no fields, while reporting it configured from the start would claim setup that never
    happened. `env`/`has_secret` are None/False so the UI can drop the mode badge rather than render a
    blank one.
    """
    # Imported here rather than at module scope: the adapter registry imports this module, so a top-level
    # import would close the cycle.
    from backend.services.providers import get_adapter

    if not get_adapter(provider).requires_app_config:
        return {
            "provider":   provider,
            "configured": bool(list_connections(provider)),
            "source":     None,
            "client_id":  "",
            "env":        None,
            "has_secret": False,
        }
    with get_db() as conn:
        row = _row(conn, provider)
    if row and (row["secret_enc"] or row["secret"] or row["client_id"]):
        return {
            "provider":   provider,
            "configured": True,
            "source":     "vault",
            "client_id":  row["client_id"],
            "env":        row["env"],
            "has_secret": bool(row["secret_enc"] or row["secret"]),
        }
    return {"provider": provider, "configured": False, "source": None,
            "client_id": "", "env": "sandbox", "has_secret": False}


# How long a `sync_started_at` marker is believed before it is treated as debris. A sync is bounded by the
# provider's own request budget and the client's poll budget (minutes), so anything this old is a process
# that died mid-sync rather than one still working — and a marker that outlives its sync would disable
# "Sync now" permanently, which is a worse failure than the double-sync it exists to prevent.
_SYNC_MARKER_STALE_AFTER = timedelta(minutes=30)


def set_sync_running(connection_ids: list[str], running: bool) -> None:
    """Mark connections as syncing, or clear the mark, **in its own transaction**.

    This deliberately opens its own `get_db()` rather than reusing the sync's connection, so the marker is
    committed the instant it is written and a concurrent request (another tab, a page reload) can see that
    a sync is running. The sync's own connection now commits at every page boundary, so writing it there
    would also become visible — but only at the first page, which is after the first provider call, and the
    marker's whole job is to be visible *before* anything slow starts.

    Clearing also drops `sync_progress`: it describes a run in flight, and a run that has ended is
    described by `last_sync` instead. Leaving it would make a finished sync read as a stalled one.
    """
    if not connection_ids:
        return
    placeholders = ",".join("?" * len(connection_ids))
    with get_db() as conn:
        conn.execute(
            f"UPDATE connection SET sync_started_at = ?, "
            f"sync_progress = CASE WHEN ? THEN sync_progress ELSE NULL END "
            f"WHERE id IN ({placeholders})",
            [utcnow_iso() if running else None, 1 if running else 0, *connection_ids],
        )


def sync_marker_is_live(started_at: str | None) -> bool:
    """Whether a `sync_started_at` marker should still be believed. An unparseable value reads as stale:
    the failure mode to avoid is a stuck marker, so anything we cannot make sense of expires."""
    if not started_at:
        return False
    try:
        started = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - started < _SYNC_MARKER_STALE_AFTER


# What the last sync *did*, as one word, derived here so the connection card and the sync log can never
# disagree about the same call. Named for the effect on the user's data rather than the mechanism that
# produced it: a walk that stopped on its request budget is not "budget paused" to anyone who does not know
# the provider meters requests — it is "there is more history still coming", which is both shorter and the
# thing worth knowing. `failed` outranks everything; a connection needing re-authentication keeps its own
# louder banner and is not restated here.
SYNC_OUTCOME_FAILED = "failed"            # the pull raised; nothing arrived
SYNC_OUTCOME_INCOMPLETE = "incomplete"    # succeeded, but history is still outstanding
SYNC_OUTCOME_ATTENTION = "attention"      # succeeded, and something did not make it in
SYNC_OUTCOME_OK = "ok"


def sync_outcome(*, error, mode: str | None, already_held: int, became_complete: bool) -> str:
    """One word for what a sync call did, from the facts that call recorded.

    Pure, and called at sync time rather than derived when a card is rendered, so the word is stored with
    the connection and survives the sync log being pruned or cleared. It lives here, beside the constants
    and the label table the card renders, so the rule has one home.

    **`attention` is reserved for a problem with no other surface.** That leaves exactly one: rows the
    provider reported as already held during an *initial* pull, which is a contradiction rather than the
    routine overlap it is on a top-up (nothing can already be held before the first import) — the outward
    appearance of a transaction-id collision.

    Rows with no local account used to raise it too, and that was wrong twice over. A `skip`-mapped account
    is the user's own decision being honoured, so the alarm could never be cleared and fired on every sync
    forever; and an account genuinely awaiting a mapping already raises the card's "N to map" badge from
    `connection_account`, so the second alarm added no information. Where those rows *went* is a question
    about the bundle of transactions received, and it is answered on the import card, per account.
    """
    if error:
        return SYNC_OUTCOME_FAILED
    if mode == "initial" and already_held > 0:
        return SYNC_OUTCOME_ATTENTION
    if mode == "initial" and not became_complete:
        return SYNC_OUTCOME_INCOMPLETE
    return SYNC_OUTCOME_OK


def list_connections(provider: str) -> list[dict]:
    """Non-secret view of a provider's linked connections (for the Connections cards + disconnect). Returns
    the stable external handle, institution, and sync health — never the credential.

    The health fields are here rather than behind a separate call because the connection card must be able
    to say "this stopped working" while **collapsed**: a failure a user has to expand a card to discover is
    one they will not discover. `last_synced_at` is the freshness of the *data* (successful pulls only),
    which is why it can sit next to a non-zero failure count and still be the honest number.

    `last_sync` carries what the most recent call actually did — its outcome plus the counts, including the
    per-account breakdown. A card that only reports failure cannot distinguish "nothing arrived" from
    "everything arrived", and the gap between those two is where an account quietly receiving none of its
    transactions lived.

    It is read from the **connection**, not from the sync log. The log is a diagnostic ring buffer: capped,
    pruned on every write, and emptied outright by `DELETE /sync/diagnostics` — so a card that derived from
    it lost its entire "Last sync" block, on a perfectly healthy connection, the moment a user cleared a
    debugging view. The two cannot drift apart despite living in different tables, because both are written
    from the same recorded facts in the same call (`_record_connection_last_sync` in `routers/sync.py`).
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, external_id, institution, last_synced_at, last_sync_error, last_sync_error_at, "
            "consecutive_sync_failures, last_sync_warnings, reauth_required, sync_started_at, "
            "sync_progress, last_sync_outcome, last_sync_summary "
            "FROM connection WHERE provider = ? ORDER BY rowid",
            (provider,),
        ).fetchall()
    out = []
    for r in rows:
        try:
            warnings = json.loads(r["last_sync_warnings"]) if r["last_sync_warnings"] else []
        except (TypeError, ValueError):
            warnings = []
        out.append({
            "id": r["id"], "external_id": r["external_id"], "institution": r["institution"],
            "last_synced_at": r["last_synced_at"],
            "last_sync_error": r["last_sync_error"],
            "last_sync_error_at": r["last_sync_error_at"],
            "consecutive_sync_failures": r["consecutive_sync_failures"] or 0,
            "last_sync_warnings": warnings,
            # Separate from the failure count on purpose: the count says how long something has been
            # wrong, this says the user has to do something about it, and only one of the two is
            # actionable. A card showing both should lead with this one.
            "reauth_required": bool(r["reauth_required"]),
            "last_sync": _last_sync_summary(r),
            # Read through the staleness check rather than as a bare "is the column set": a process that
            # died mid-sync leaves the marker behind, and a card that believed it would disable syncing
            # for good. Imported here rather than duplicating the rule — the router owns it because it is
            # the thing that writes it.
            "syncing": sync_marker_is_live(r["sync_started_at"]),
            # How far the running sync has got, or None when none is running. Read from the connection
            # rather than from the sync's own response because a long backfill is a single HTTP call: its
            # response says nothing until it finishes, and a client that navigated away or reloaded has no
            # response to wait on at all. Gated on the same staleness check as `syncing`, so a marker left
            # behind by a dead process cannot leave stale numbers on screen.
            "sync_progress": (
                _json_or_none(r["sync_progress"]) if sync_marker_is_live(r["sync_started_at"]) else None
            ),
        })
    return out


def _json_or_none(value):
    """Stored JSON, or None when absent or unreadable. A progress blob is a diagnostic — showing nothing
    beats failing a connection listing over it."""
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _last_sync_summary(connection_row) -> dict | None:
    """The card's view of the connection's most recent sync. None when it has never synced — which reads as
    "no record yet" rather than as a zero-count success.

    A **currently** failing connection outranks the stored word. `last_sync_outcome` records what one call
    did; `last_sync_error` says the connection is broken right now, which is the more important of the two
    and is what the card must lead with. It is not a second copy of the outcome — it is a different fact,
    and it is the reason the stored word is not simply trusted unconditionally.
    """
    if connection_row["last_sync_error"]:
        stored = _json_or_none(connection_row["last_sync_summary"]) or {}
        return {**stored, "outcome": SYNC_OUTCOME_FAILED,
                "at": connection_row["last_sync_error_at"] or stored.get("at")}
    outcome = connection_row["last_sync_outcome"]
    if not outcome:
        return None
    summary = _json_or_none(connection_row["last_sync_summary"]) or {}
    accounts = summary.get("accounts")
    return {
        "outcome":  outcome,
        "at":       summary.get("at"),
        "mode":     summary.get("mode"),
        "added":    int(summary.get("added") or 0),
        "updated":  int(summary.get("updated") or 0),
        "removed":  int(summary.get("removed") or 0),
        # Keyed by the provider's account id; the caller resolves display names from its own account list.
        # The per-account buckets travel whole rather than pre-summed — the card's chips want them per
        # account, and a total beside them would be a stored sum of the thing it sums.
        "accounts": accounts if isinstance(accounts, dict) else {},
    }


def resolve_app_config(user: dict, provider: str) -> dict | None:
    """The decrypted app credential the adapter needs to call the provider: {client_id, secret, env}.
    The saved `provider_config` row is the only source — its secret decrypts under the vault (raises
    VaultLocked if locked). None when nothing is saved.

    There was once a `.env` bootstrap (`PLAID_*`) consulted when no row existed, carried over from before
    app credentials moved into the vault. It is gone: it kept a plaintext secret readable in a file for a
    credential the vault exists to protect, and the Configure card has been the way to enter one for long
    enough that the fallback only served installs that had never opened it."""
    with get_db() as conn:
        row = _row(conn, provider)
    if row and (row["secret_enc"] or row["secret"] or row["client_id"]):
        secret = crypto_service.decrypt_app_credential(user, provider, row["secret"], row["secret_enc"])
        return {"client_id": row["client_id"], "secret": secret, "env": row["env"]}
    return None


def set_provider_config(user: dict, provider: str, *, client_id=None, secret=None, env=None) -> None:
    """Upsert the app credential. client_id/env store plaintext; a provided secret is vault-encrypted
    (requires the vault unlocked). `secret=None` leaves the stored secret unchanged; `secret=''` clears it.
    A field left None keeps its current value (or the default on a fresh row)."""
    normalized_env = None
    if env is not None:
        normalized_env = (env or "sandbox").strip() or "sandbox"
        if normalized_env not in VALID_ENVS:
            raise ValueError("env must be sandbox, development, or production")

    with get_db() as conn:
        row = _row(conn, provider)
        new_client_id = client_id.strip() if client_id is not None else (row["client_id"] if row else "")
        new_env = normalized_env if normalized_env is not None else (row["env"] if row else "sandbox")
        if secret is None:
            new_secret, new_secret_enc = (row["secret"], row["secret_enc"]) if row else ("", None)
        elif secret == "":
            new_secret, new_secret_enc = "", None
        else:
            new_secret, new_secret_enc = crypto_service.encrypt_app_credential(user, provider, secret)
        conn.execute(
            """
            INSERT INTO provider_config (provider, client_id, secret, secret_enc, env, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(provider) DO UPDATE SET
                client_id  = excluded.client_id,
                secret     = excluded.secret,
                secret_enc = excluded.secret_enc,
                env        = excluded.env,
                updated_at = excluded.updated_at
            """,
            (provider, new_client_id, new_secret, new_secret_enc, new_env),
        )
