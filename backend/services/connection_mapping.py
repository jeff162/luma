# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The account-mapping seam for data-source connections — the connection's answer to the account step a
CSV import has always had.

Connecting a bank used to create one new local account per provider account, with no chance to say
"this *is* my existing Northgate Voyager." That is not only a UX gap: the mapping is the missing input to
duplicate detection. The dedupe ladder's cross-account rules fire only when the receiving account
already has history in the matching coverage **or** was explicitly declared an alias of an existing
account, and a sync could satisfy neither — so a re-fetch of transactions already imported from a CSV
landed as a fresh account nobody had connected to anything.

The four mapping modes and what each buys the ladder:

  existing — no new account; the connection linkage is stamped onto the account the user picked, so
             its rows land *in* that account. Strongest: same-account exact-hash and coverage both
             apply with no alias needed.
  group    — a new account created beneath an existing one (`parent_account_id`), which is the same
             end state as creating it and then merging on the Accounts page — one step instead of
             two. Linked-group rules apply (exact-hash across the group); the caller runs the same
             merge sweeps the Accounts page does. Deliberately NOT an alias: a sibling is a
             *different* physical account, so the coverage rules must not fire across the pair.
  new      — a plain new account. Soft-flag sweep only.
  skip     — no local account at all, and *remembered*, so a later "Refresh accounts" stops
             recreating an account the user already rejected.

A fifth mode, `compare` ("keep a separate account, but hard-dedupe against an existing one"), was
removed. It had no analogue anywhere else in the app and occupied an incoherent middle ground: two
accounts asserted to be the same physical account, yet deliberately kept apart. `existing` covers
that intent properly, and `group` covers "related but distinct". Do not reintroduce it.

Mapping is idempotent and re-appliable: it is the same call whether it runs once after Link or again
months later from the connection card, so a user can revisit a decision without a re-link (which for
a metered provider may not even be possible).
"""

import json
import sqlite3
import uuid
from typing import Optional

from backend.services.account_groups import effective_account_id
from backend.services.import_evidence import EVIDENCE_ROLE_CATEGORICAL
from backend.services.ledger_currency import currency_matches, get_ledger_currency
from backend.time_utils import utcnow_iso

# The mapping decisions a provider account can carry. NULL/absent means "not yet decided" — the
# connection card badges those, and sync skips them rather than guessing.
MAPPING_MODES = ("new", "existing", "group", "skip")


def record_provider_accounts(conn: sqlite3.Connection, *, connection_id: str, accounts: list[dict]) -> int:
    """Upsert the connection's provider-reported account list, **preserving existing mapping
    decisions**. Called on connect and on every "Refresh accounts", so a newly-appeared account shows
    up unmapped while previously-decided ones keep their mode — including `skip`, which is the whole
    reason a skipped account has a row at all.

    A provider account whose handle is *already* held by a local account is adopted as `existing`
    rather than left unmapped. `account.external_account_id` is itself a durable statement of "this
    local account is that provider account" — and it outlives the mapping row, which a disconnect
    cascades away with its connection. Without this, reconnecting a bank would strand its accounts and
    silently start a second copy of every one of them. Adoption only ever fills a *blank* decision (it
    is confined to the INSERT), so it can never override a choice the user made.
    """
    for acc in accounts:
        external_account_id = acc["external_account_id"]
        adopted = conn.execute(
            "SELECT id FROM account WHERE external_account_id = ? AND trashed_at IS NULL",
            (external_account_id,),
        ).fetchone()
        adopted_id = adopted["id"] if adopted else None
        conn.execute(
            """
            INSERT INTO connection_account
                (connection_id, external_account_id, provider_name, provider_official_name,
                 provider_type, provider_subtype, provider_mask, provider_currency,
                 account_id, mapping_mode, target_account_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(connection_id, external_account_id) DO UPDATE SET
                provider_name          = excluded.provider_name,
                provider_official_name = excluded.provider_official_name,
                provider_type          = excluded.provider_type,
                provider_subtype       = excluded.provider_subtype,
                provider_mask          = excluded.provider_mask,
                provider_currency      = excluded.provider_currency
            """,
            (
                connection_id,
                external_account_id,
                acc.get("name"),
                acc.get("official_name"),
                acc.get("type"),
                acc.get("subtype"),
                acc.get("mask"),
                # NULL from a provider that does not report one. Distinct from a stated currency and read
                # as "not stated" throughout, never as "not the ledger's" — see `services/ledger_currency.py`.
                (acc.get("currency") or "").strip() or None,
                adopted_id,
                "existing" if adopted_id else None,
                adopted_id,
            ),
        )
    return len(accounts)


def provider_account_label(row) -> str:
    """The human label for a provider account — its provider name plus the masked suffix. This is the
    connection's "source value": the analog of a CSV's account-column text, used as
    `import_batch_account.csv_value` and written into each row's evidence so the terminal-window
    matcher can identify a synced row's source account.
    """
    name = str((row["provider_name"] if "provider_name" in row.keys() else None) or "").strip()
    mask = str((row["provider_mask"] if "provider_mask" in row.keys() else None) or "").strip()
    if name and mask:
        return f"{name} ···{mask}"
    return name or (mask and f"···{mask}") or str(row["external_account_id"])


def list_connection_accounts(conn: sqlite3.Connection, connection_id: str) -> list[dict]:
    """The connection's provider accounts with their current mapping, for the mapping UI and for
    building a sync's dedupe context. `account_name` reflects the *local* account (which the user may
    have renamed); the `provider_*` fields keep what the bank called it."""
    rows = conn.execute(
        """
        SELECT ca.*,
               COALESCE(NULLIF(a.display_name,''), a.name) AS account_name,
               a.trashed_at        AS account_trashed_at,
               COALESCE(NULLIF(ct.display_name,''), ct.name) AS target_account_name
        FROM   connection_account ca
        LEFT   JOIN account a  ON a.id  = ca.account_id
        LEFT   JOIN account ct ON ct.id = ca.target_account_id
        WHERE  ca.connection_id = ?
        ORDER  BY LOWER(COALESCE(ca.provider_name, '')), ca.external_account_id
        """,
        (connection_id,),
    ).fetchall()
    # Resolved once for the whole list rather than per row — it is one setting, and re-reading it per
    # account would let a mid-loop change split one response between two currencies.
    ledger_currency = get_ledger_currency(conn)
    out = []
    for r in rows:
        entry = dict(r)
        entry["source_label"] = provider_account_label(r)
        entry["mapped"] = bool(r["mapping_mode"])
        # Decided here rather than in the UI so "which currency can this ledger hold" has one answer in
        # one place. The client renders the verdict; it does not know the rule or the ledger's currency.
        entry["currency_supported"] = currency_matches(ledger_currency, entry.get("provider_currency"))
        out.append(entry)
    return out


def unmapped_count(conn: sqlite3.Connection, connection_id: Optional[str] = None) -> int:
    """How many provider accounts still await a decision — the connection card's nudge badge."""
    if connection_id:
        return int(conn.execute(
            "SELECT COUNT(*) AS n FROM connection_account WHERE connection_id = ? AND mapping_mode IS NULL",
            (connection_id,),
        ).fetchone()["n"] or 0)
    return int(conn.execute(
        "SELECT COUNT(*) AS n FROM connection_account WHERE mapping_mode IS NULL"
    ).fetchone()["n"] or 0)


def _link_account_to_connection(conn, *, account_id: str, connection_id: str, provider: str,
                                external_account_id: str) -> None:
    """Stamp the provider linkage onto a local account so sync resolves rows into it.

    `provider` is overwritten deliberately: the account is now provider-fed, whatever created it. Its
    CSV history is unaffected — per-row provenance lives on `import_batch_account` and each row's
    captured evidence, not on this column.
    """
    conn.execute(
        """
        UPDATE account
        SET    external_account_id = ?, connection_id = ?, provider = ?
        WHERE  id = ?
        """,
        (external_account_id, connection_id, provider, account_id),
    )


def _clear_stale_external_id(conn, *, external_account_id: str, keep_account_id: Optional[str]) -> None:
    """Release the provider handle from any other account holding it. `account.external_account_id` is
    UNIQUE, so re-pointing a provider account at a different local account must first detach it from
    the old one — otherwise the UPDATE trips the constraint and the remap fails."""
    conn.execute(
        """
        UPDATE account
        SET    external_account_id = NULL, connection_id = NULL
        WHERE  external_account_id = ?
          AND  (? IS NULL OR id != ?)
        """,
        (external_account_id, keep_account_id, keep_account_id),
    )


def _create_local_account(conn, *, name: str, account_type: Optional[str], subtype: Optional[str],
                          mask: Optional[str], institution: Optional[str], owner_id: Optional[str],
                          parent_account_id: Optional[str], connection_id: str, provider: str,
                          external_account_id: str) -> str:
    account_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO account
            (id, external_account_id, connection_id, provider, name, display_name, institution,
             type, subtype, mask, owner_id, parent_account_id, trashed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)
        """,
        (account_id, external_account_id, connection_id, provider, name, name, institution,
         account_type, subtype, mask, owner_id, parent_account_id),
    )
    return account_id


def apply_account_mapping(conn: sqlite3.Connection, *, connection_id: str, provider: str,
                          institution: Optional[str], mappings: dict, default_owner_id: Optional[str]) -> dict:
    """Materialize the user's mapping decisions. `mappings` is
    {external_account_id: {mode, target_account_id?, name?, type?}}, where `target_account_id` is the
    account adopted ('existing') or nested under ('group').

    Returns {"created": [...], "linked": [...], "skipped": [...], "changed": bool} — `changed` drives
    whether the caller re-runs duplicate detection, since a mapping change can newly qualify rows for
    the cross-account rules.
    """
    existing = {r["external_account_id"]: r for r in conn.execute(
        "SELECT * FROM connection_account WHERE connection_id = ?", (connection_id,)
    ).fetchall()}

    created, linked, skipped = [], [], []
    changed = False

    for external_account_id, choice in (mappings or {}).items():
        row = existing.get(external_account_id)
        if row is None:
            continue  # not an account this connection offers; ignore rather than invent one
        mode = str((choice or {}).get("mode") or "").strip().lower()
        if mode not in MAPPING_MODES:
            continue

        prior_mode = row["mapping_mode"]
        prior_account = row["account_id"]
        # One target for every mode that points at an existing account: adopted / parent / alias.
        target_account_id = str((choice or {}).get("target_account_id") or "").strip() or None
        account_id: Optional[str] = None

        if mode == "skip":
            # Release the handle so sync stops resolving rows into whatever it used to feed. Any rows
            # already imported stay where they are — skipping is about future syncs, not history.
            _clear_stale_external_id(conn, external_account_id=external_account_id, keep_account_id=None)
            skipped.append(external_account_id)

        elif mode == "existing":
            target_id = target_account_id
            if not target_id:
                continue
            _clear_stale_external_id(conn, external_account_id=external_account_id, keep_account_id=target_id)
            _link_account_to_connection(
                conn, account_id=target_id, connection_id=connection_id,
                provider=provider, external_account_id=external_account_id,
            )
            account_id = target_id
            linked.append(target_id)

        else:  # new | group — both resolve to a local account of this provider account's own
            # Group under the target's ROOT, never under the target itself when that target is already
            # a child. The app's grouping model is one level deep — `COALESCE(parent_account_id, id)`
            # is how every scope is computed — so a two-level chain would put the row in a scope
            # nothing else resolves to. The CSV import path does the same
            # (`_attach_import_created_account_to_group` resolves the effective row first).
            if mode == "group" and target_account_id:
                target_account_id = effective_account_id(conn, target_account_id) or target_account_id
            # Whenever a local account already holds this provider handle, it IS this provider
            # account locally — so reuse it rather than creating a second one. That covers the
            # obvious case (re-applying an unchanged mapping must not duplicate the account) and the
            # less obvious one: switching an already-linked account from 'existing' to 'group' is a
            # change to how it is *grouped*, not a decision to abandon it. Creating a
            # fresh account there would strand every transaction already synced under the old one.
            already = conn.execute(
                "SELECT id FROM account WHERE external_account_id = ?", (external_account_id,)
            ).fetchone()
            if already:
                account_id = already["id"]
                # 'group' still has to place it, since the parent may be newly chosen (or cleared).
                if mode == "group":
                    conn.execute(
                        "UPDATE account SET parent_account_id = ? WHERE id = ?",
                        (target_account_id, account_id),
                    )
            else:
                _clear_stale_external_id(conn, external_account_id=external_account_id, keep_account_id=None)
                name = str((choice or {}).get("name") or "").strip() or provider_account_label(row)
                account_id = _create_local_account(
                    conn,
                    name=name,
                    account_type=(choice or {}).get("type") or row["provider_type"],
                    subtype=row["provider_subtype"],
                    mask=row["provider_mask"],
                    institution=institution,
                    owner_id=default_owner_id,
                    parent_account_id=target_account_id if mode == "group" else None,
                    connection_id=connection_id,
                    provider=provider,
                    external_account_id=external_account_id,
                )
                created.append(account_id)

        conn.execute(
            """
            UPDATE connection_account
            SET    account_id = ?, mapping_mode = ?, target_account_id = ?, updated_at = ?
            WHERE  connection_id = ? AND external_account_id = ?
            """,
            (account_id, mode, target_account_id if mode in ("existing", "group") else None,
             utcnow_iso(), connection_id, external_account_id),
        )
        if prior_mode != mode or prior_account != account_id:
            changed = True

    return {"created": created, "linked": linked, "skipped": skipped, "changed": changed}


def build_sync_evidence(txn: dict, *, source_label: str, captured_fields: set[str]) -> Optional[str]:
    """The `import_evidence_json` for a synced row, in the identical shape a CSV import writes.

    Synced rows carried no evidence at all before this, with two consequences: the dedupe text matcher
    saw only `merchant_name`/`raw_name`, and the terminal-window matcher — which identifies a row's
    source account from `evidence.account.value` — could never see a synced row at all. Writing the
    same shape means both work with no per-source special-casing, and the origin hover renders it
    through the existing `importSourceFields` seam for free.

    `captured_fields` gates only the *optional* keys; the ones duplicate detection depends on are
    always written (see `ProviderAdapter.capture_fields`).

    A CSV infers each column's role from its cardinality across the file; a sync has no file to
    measure, but it knows exactly what it is writing, so the role is stamped per field here. Only the
    counterparty is free text that *names* the transaction — everything else is structured metadata
    that two unrelated rows can carry identically, so it is marked categorical and kept out of
    duplicate text matching (see services/import_evidence.py for what went wrong when it wasn't).
    """
    extras: list[dict] = []

    def add(header: str, value, *, role: str | None = None) -> None:
        text = str(value or "").strip()
        if text:
            field: dict = {"header": header, "value": text}
            if role:
                field["role"] = role
            extras.append(field)

    for name in (txn.get("counterparties") or []):
        add("Counterparty", name)
    # An opaque provider id and a checkbook number that restarts at 1 on every account: worth reading,
    # worthless as evidence two rows are the same charge (two accounts both writing check #1042 is
    # ordinary, and a shared merchant id says the same *merchant*, not the same transaction).
    add("Merchant ID", txn.get("merchant_entity_id"), role=EVIDENCE_ROLE_CATEGORICAL)
    add("Check number", txn.get("check_number"), role=EVIDENCE_ROLE_CATEGORICAL)
    # Recorded as text so the authorized/posted disagreement is visible on the row itself, not only
    # inferable from the column. The dedupe sweep reads the real `authorized_date` column for its date
    # window; this copy is for display and must never re-enter matching as text.
    add("Authorized date", txn.get("authorized_date"), role=EVIDENCE_ROLE_CATEGORICAL)
    if "location" in captured_fields:
        add("Location", txn.get("location"), role=EVIDENCE_ROLE_CATEGORICAL)

    evidence: dict = {
        # The provider account label, so this row can serve as a terminal-window candidate. Keyed
        # "Account" to match what a CSV writes, since the matcher reads one shape.
        "account": {"header": "Account", "value": source_label},
    }
    description = str(txn.get("raw_name") or "").strip()
    if description:
        evidence["description"] = {"header": "Description", "value": description}
    if extras:
        evidence["extra_text_fields"] = extras
    return json.dumps(evidence)


def captured_field_keys(conn: sqlite3.Connection, connection_id: str, adapter) -> set[str]:
    """The optional capture keys in force for a connection: the user's stored choice, else the
    adapter's defaults. Locked fields are omitted — they are unconditional, so carrying them here
    would imply they could be turned off."""
    row = conn.execute(
        "SELECT captured_fields FROM connection WHERE id = ?", (connection_id,)
    ).fetchone()
    declared = adapter.capture_fields() if adapter else []
    optional = {f["key"] for f in declared if not f.get("locked")}
    stored = row["captured_fields"] if row else None
    if not stored:
        return {f["key"] for f in declared if not f.get("locked") and f.get("default_on")}
    try:
        chosen = json.loads(stored)
    except (TypeError, ValueError):
        chosen = []
    return {k for k in chosen if k in optional}


def dedupe_inputs_for_connection(conn: sqlite3.Connection, connection_id: str) -> dict:
    """The connection's mapping expressed as `build_dedupe_context` arguments, so a sync builds its
    context exactly the way a CSV import does.

    Only `existing` counts as an explicit alias: it is the user asserting "this provider account IS
    that local account", which is precisely the precondition the coverage rules gate on. `group` sets a
    compare target (so exact-hash matches resolve across the linked group, exactly as a CSV import's
    group attachment does) but is deliberately NOT an alias — a sibling is a *different* physical
    account, and letting coverage span the pair would over-collapse.
    """
    source_values: list[str] = []
    account_by_source_value: dict[str, str] = {}
    compare_targets: dict[str, str] = {}
    alias_values: set[str] = set()
    label_by_external: dict[str, str] = {}

    for r in conn.execute(
        "SELECT * FROM connection_account WHERE connection_id = ? AND mapping_mode IS NOT NULL",
        (connection_id,),
    ).fetchall():
        if r["mapping_mode"] == "skip" or not r["account_id"]:
            continue
        label = provider_account_label(r)
        source_values.append(label)
        account_by_source_value[label] = r["account_id"]
        label_by_external[r["external_account_id"]] = label
        if r["mapping_mode"] == "existing":
            # Mapped onto the account itself: the compare target *is* the receiving account, which
            # makes the linked-group rules resolve against its own history.
            compare_targets[label] = r["account_id"]
            alias_values.add(label)
        elif r["mapping_mode"] == "group":
            # The group's root, so exact-hash matches resolve across the siblings — the same thing a
            # CSV import's group attachment produces (`_attach_import_created_account_to_group`
            # returns the root and it becomes the compare target). No alias: grouping says "related",
            # not "the same physical account".
            root = effective_account_id(conn, r["account_id"])
            if root:
                compare_targets[label] = root

    return {
        "source_values": source_values,
        "account_by_source_value": account_by_source_value,
        "compare_targets": compare_targets,
        "alias_values": alias_values,
        "label_by_external": label_by_external,
    }
