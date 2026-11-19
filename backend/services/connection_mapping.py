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
from datetime import date
from typing import Optional

from backend.services.account_groups import effective_account_id, set_account_parent
from backend.services.import_evidence import EVIDENCE_ROLE_CATEGORICAL
from backend.services.ledger_currency import currency_matches, get_ledger_currency
from backend.services.wallet_accounts import fill_wallet_match_text
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


def provider_account_index(conn: sqlite3.Connection, connection_id: str) -> dict[str, dict]:
    """Every provider account this connection knows of, by external id → `{label, mapping_mode}`.

    Deliberately unfiltered, which is what separates it from `dedupe_inputs_for_connection`'s
    `label_by_external`: that one drops `skip` and unmapped accounts because a source value with no
    destination cannot participate in dedupe. This is the opposite case — the accounts it most needs to
    describe are exactly the ones with no local account, since those are the rows that would otherwise be
    recorded as having come from nowhere.

    Both facts come back together because a sync wants them about the same account at the same moment:
    what to call a dropped row's source, and whether dropping it was the user's decision (`skip`) or a
    gap awaiting one (`mapping_mode` NULL, or no row at all for an account added provider-side).
    """
    return {
        r["external_account_id"]: {
            "label": provider_account_label(r), "mapping_mode": r["mapping_mode"],
        }
        for r in conn.execute(
            "SELECT external_account_id, provider_name, provider_mask, mapping_mode "
            "FROM connection_account WHERE connection_id = ?",
            (connection_id,),
        ).fetchall()
    }


def list_connection_accounts(conn: sqlite3.Connection, connection_id: str) -> list[dict]:
    """The connection's provider accounts with their current mapping, for the mapping UI. `account_name`
    reflects the *local* account (which the user may have renamed); the `provider_*` fields keep what the
    bank called it. A replaced provider account is left out: it is a decision already made, and listing it
    beside its replacement reads as the same account offered twice."""
    rows = conn.execute(
        """
        SELECT ca.*,
               COALESCE(NULLIF(a.display_name,''), a.name) AS account_name,
               a.trashed_at        AS account_trashed_at,
               COALESCE(NULLIF(ct.display_name,''), ct.name) AS target_account_name
        FROM   connection_account ca
        LEFT   JOIN account a  ON a.id  = ca.account_id
        LEFT   JOIN account ct ON ct.id = ca.target_account_id
        WHERE  ca.connection_id = ? AND ca.replaced_by IS NULL
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
    fill_wallet_match_text(conn, [account_id])
    return account_id


class SharedAccountClaim(ValueError):
    """Two provider accounts were newly mapped onto one local account in the same request, so neither can
    be taken as replacing the other."""


def _live_account_id(conn, account_id: Optional[str]) -> Optional[str]:
    if not account_id:
        return None
    row = conn.execute(
        "SELECT id FROM account WHERE id = ? AND trashed_at IS NULL", (account_id,)
    ).fetchone()
    return row["id"] if row else None


def _own_account(conn, row) -> Optional[str]:
    """The local account a provider account already resolves to: the one holding its handle, or else the
    one its mapping row names. The second covers a handle another provider account has taken over —
    re-applying the row's decision must find its account again, not create a second one."""
    held = conn.execute(
        "SELECT id FROM account WHERE external_account_id = ?", (row["external_account_id"],)
    ).fetchone()
    return held["id"] if held else _live_account_id(conn, row["account_id"])


def _resolve_shared_claims(conn, *, existing: dict,
                           decisions: dict) -> tuple[dict[str, str], dict[str, str], set[str]]:
    """Settle provider accounts that end up pointing at one local account. Returns, keyed by external id,
    ({loser: winner}, {winner: local account id}, {claimants that must not take the handle}).

    A local account can be fed by one provider account only (`account.external_account_id` is a single
    handle), so when several of a connection's provider accounts point at one local account, one feeds it
    and the rest are **replaced**. The usual cause is a provider reissuing an account's ids after the user
    re-links the bank on the provider's side: the old id stops arriving, and the user maps the new one onto
    the same account.

    The winner, in order of evidence:
      - the one claimant this request newly points at the account — that is the user saying "this one now";
        two newly pointed at once is ambiguous and refused (`SharedAccountClaim`)
      - otherwise the claimant the provider listed most recently (`last_listed_at`), the holder of the
        account's handle among several listed together.
    With no listing to go on, nothing is retired: the holder keeps the handle and the others are left as
    they are, so the result is not decided by the order this request named them in. A later pull that lists
    one of them settles it (`resolve_shared_account_claims`).
    """
    claims: dict[str, list[str]] = {}
    for external_account_id, row in existing.items():
        if external_account_id in decisions:
            mode, target = decisions[external_account_id]
            if mode == "existing":
                account_id = _live_account_id(conn, target)
            elif mode in ("new", "group"):
                account_id = _own_account(conn, row)
            else:
                account_id = None
        elif row["mapping_mode"] in ("new", "existing", "group") and not row["replaced_by"]:
            account_id = _live_account_id(conn, row["account_id"])
        else:
            account_id = None
        if account_id:
            claims.setdefault(account_id, []).append(external_account_id)

    replaced: dict[str, str] = {}
    winners: dict[str, str] = {}
    held_back: set[str] = set()
    for account_id, claimants in claims.items():
        if len(claimants) < 2:
            continue
        newly = [e for e in claimants if e in decisions and existing[e]["account_id"] != account_id]
        if len(newly) > 1:
            names = ", ".join(sorted(provider_account_label(existing[e]) for e in newly))
            raise SharedAccountClaim(f"{names} cannot all map to the same account")
        held = conn.execute(
            "SELECT external_account_id FROM account WHERE id = ?", (account_id,)
        ).fetchone()["external_account_id"]
        winner = newly[0] if newly else None
        if winner is None:
            listed = {e: existing[e]["last_listed_at"] for e in claimants if existing[e]["last_listed_at"]}
            latest = max(listed.values(), default=None)
            fresh = [e for e, d in listed.items() if d == latest]
            if held in fresh:
                winner = held
            elif len(fresh) == 1:
                winner = fresh[0]
        if winner is None:
            held_back.update(e for e in claimants if e != held)
            continue
        winners[winner] = account_id
        for loser in claimants:
            if loser != winner:
                replaced[loser] = winner
    return replaced, winners, held_back


def apply_account_mapping(conn: sqlite3.Connection, *, connection_id: str, provider: str,
                          institution: Optional[str], mappings: dict, default_owner_id: Optional[str]) -> dict:
    """Materialize the user's mapping decisions. `mappings` is
    {external_account_id: {mode, target_account_id?, name?, type?, distinct_from_account_ids?}}, where
    `target_account_id` is the account adopted ('existing') or nested under ('group').

    `distinct_from_account_ids` is what the user ruled out by giving this provider account an account of
    its own: every existing account the row offered as a possible match. Each is recorded as an
    `account_pair_distinct` assertion once the new account exists — which is the whole point of carrying
    them. Before this the answer was discarded, so a user who looked at the account names side by side and
    declared them different was asked the same question again, one transaction at a time, as soon as the
    data landed.

    It is a **list** because the question is "is this any of these?", which is a question about a set. As
    a single id it recorded the user's answer about one arbitrarily-chosen account and silently dropped
    it for the rest — and recorded nothing whatsoever in the case where the candidates tied, which is
    precisely when the user has the most to rule out.

    Provider accounts left pointing at one local account are settled first (`_resolve_shared_claims`): each
    loser becomes a `skip` that records what replaced it, and the winner is made to hold the account's
    handle. Without that the outcome was whichever row this loop happened to reach last.

    Returns {"created": [...], "linked": [...], "skipped": [...], "distinct_pairs": int, "changed": bool}
    — `changed` drives whether the caller re-runs duplicate detection, since a mapping change can newly
    qualify rows for the cross-account rules.
    """
    existing = {r["external_account_id"]: r for r in conn.execute(
        "SELECT * FROM connection_account WHERE connection_id = ?", (connection_id,)
    ).fetchall()}

    decisions: dict[str, tuple[str, Optional[str]]] = {}
    for external_account_id, choice in (mappings or {}).items():
        mode = str((choice or {}).get("mode") or "").strip().lower()
        if external_account_id in existing and mode in MAPPING_MODES:
            target = str((choice or {}).get("target_account_id") or "").strip() or None
            decisions[external_account_id] = (mode, target)

    replaced, winners, held_back = _resolve_shared_claims(conn, existing=existing, decisions=decisions)
    held_before = {
        winner for winner, account_id in winners.items()
        if conn.execute(
            "SELECT 1 FROM account WHERE id = ? AND external_account_id = ?", (account_id, winner),
        ).fetchone()
    }
    # Losers first, so releasing a loser's handle can never undo the winner's stamp.
    order = [*replaced, *(e for e in decisions if e not in replaced)]

    created, linked, skipped = [], [], []
    # Collected rather than written inline: the assertion needs the local account's id, and for a `new`
    # mapping that id does not exist until this loop creates it.
    distinct_from: list[tuple[str, str]] = []
    changed = False
    moved: list[str] = []

    for external_account_id in order:
        row = existing[external_account_id]
        if external_account_id in replaced:
            choice, mode, target_account_id = {}, "skip", None
        else:
            choice = (mappings or {}).get(external_account_id) or {}
            mode, target_account_id = decisions[external_account_id]

        prior_mode = row["mapping_mode"]
        prior_account = row["account_id"]
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
            if external_account_id not in held_back:
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
            # Whenever this provider account already has a local account, it IS this provider account
            # locally — so reuse it rather than creating a second one. That covers the obvious case
            # (re-applying an unchanged mapping must not duplicate the account) and the less obvious one:
            # switching an already-linked account from 'existing' to 'group' is a change to how it is
            # *grouped*, not a decision to abandon it. Creating a fresh account there would strand every
            # transaction already synced under the old one.
            held = conn.execute(
                "SELECT id FROM account WHERE external_account_id = ?", (external_account_id,)
            ).fetchone()
            already = held["id"] if held else _own_account(conn, row)
            if already:
                account_id = already
                if not held and external_account_id not in held_back:
                    _link_account_to_connection(
                        conn, account_id=already, connection_id=connection_id,
                        provider=provider, external_account_id=external_account_id,
                    )
                # 'group' still has to place it, since the parent may be newly chosen (or cleared).
                if mode == "group":
                    set_account_parent(conn, [account_id], target_account_id)
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

        # A replaced row stays replaced while it is re-applied as a skip (a refresh re-applies every
        # decision); any other decision about it is the user taking it back.
        replaced_by = replaced.get(external_account_id) or (row["replaced_by"] if mode == "skip" else None)
        conn.execute(
            """
            UPDATE connection_account
            SET    account_id = ?, mapping_mode = ?, target_account_id = ?, replaced_by = ?, updated_at = ?
            WHERE  connection_id = ? AND external_account_id = ?
            """,
            (account_id, mode, target_account_id if mode in ("existing", "group") else None,
             replaced_by, utcnow_iso(), connection_id, external_account_id),
        )
        # Only meaningful for a mapping that ends up as its own local account: 'existing' and 'group' are
        # already statements about the relationship, and 'skip' has no account to assert anything about.
        declined_ids = (choice or {}).get("distinct_from_account_ids") or []
        if account_id and mode in ("new", "group"):
            for declined in {str(d).strip() for d in declined_ids if str(d or "").strip()}:
                if declined != account_id:
                    distinct_from.append((account_id, declined))

        if prior_mode != mode or prior_account != account_id:
            changed = True
            moved.append(external_account_id)

    # The winner holds the account's handle whatever order the loop ran in, including a winner this request
    # did not mention.
    for winner, account_id in winners.items():
        holder = conn.execute("SELECT external_account_id FROM account WHERE id = ?", (account_id,)).fetchone()
        if holder and holder["external_account_id"] != winner:
            _clear_stale_external_id(conn, external_account_id=winner, keep_account_id=account_id)
            _link_account_to_connection(
                conn, account_id=account_id, connection_id=connection_id,
                provider=provider, external_account_id=winner,
            )
        # A winner that did not hold the handle had its rows dropped while its history was walked, so its
        # coverage claims history it never delivered. Cleared, so the next pull fetches that history again
        # rather than treating it as held.
        if winner not in held_before:
            conn.execute(
                """
                UPDATE connection_account
                SET    coverage_start_date = NULL, coverage_through_date = NULL,
                       history_complete = 0, history_empty_streak = 0
                WHERE  connection_id = ? AND external_account_id = ?
                """,
                (connection_id, winner),
            )
        changed = True

    # A provider account that stops feeding the account it won hands back the ones it replaced: they show
    # again as skipped, for the user to decide about.
    for external_account_id in moved:
        if external_account_id not in winners:
            conn.execute(
                "UPDATE connection_account SET replaced_by = NULL WHERE connection_id = ? AND replaced_by = ?",
                (connection_id, external_account_id),
            )

    # After the loop, so every account named here exists. Imported lazily: `duplicate_detection` imports
    # broadly and this module is pulled in by the sync path on every pull.
    pairs = 0
    if distinct_from:
        from backend.services.duplicate_detection import record_account_pair_distinct
        for account_id, declined in distinct_from:
            if record_account_pair_distinct(conn, account_id, declined).get("recorded"):
                pairs += 1

    return {"created": created, "linked": linked, "skipped": skipped,
            "distinct_pairs": pairs, "changed": changed}


def record_listed_accounts(conn: sqlite3.Connection, connection_id: str, listings: list[dict] | None) -> None:
    """Stamp today on each provider account a pull's `complete_listings` returned whole. It is the durable
    record of which provider accounts are still reported, which decides between two claimants of one local
    account (`_resolve_shared_claims`). Kept on the mapping row because the sync log is prunable and a
    restore leaves it empty."""
    today = date.today().isoformat()
    for external_account_id in {(entry or {}).get("external_account_id") for entry in listings or []} - {None}:
        conn.execute(
            "UPDATE connection_account SET last_listed_at = ? WHERE connection_id = ? AND external_account_id = ?",
            (today, connection_id, external_account_id),
        )


def resolve_shared_account_claims(conn: sqlite3.Connection, connection_id: str) -> int:
    """Settle the connection's provider accounts that share a local account, as a mapping save would
    (`_resolve_shared_claims`), re-applying only the rows involved. Run after each pull, once the provider's
    listings have said which of them are still reported. Returns how many it marked replaced."""
    rows = conn.execute(
        """
        SELECT external_account_id, mapping_mode, target_account_id FROM connection_account
        WHERE  connection_id = ? AND replaced_by IS NULL AND mapping_mode IN ('new', 'existing', 'group')
          AND  account_id IN (
                   SELECT account_id FROM connection_account
                   WHERE  connection_id = ? AND replaced_by IS NULL AND account_id IS NOT NULL
                     AND  mapping_mode IN ('new', 'existing', 'group')
                   GROUP  BY account_id HAVING COUNT(*) > 1)
        """,
        (connection_id, connection_id),
    ).fetchall()
    if not rows:
        return 0
    connection = conn.execute("SELECT provider, institution FROM connection WHERE id = ?", (connection_id,)).fetchone()
    count = "SELECT COUNT(*) AS n FROM connection_account WHERE connection_id = ? AND replaced_by IS NOT NULL"
    before = conn.execute(count, (connection_id,)).fetchone()["n"]
    apply_account_mapping(
        conn, connection_id=connection_id, provider=connection["provider"], institution=connection["institution"],
        mappings={r["external_account_id"]: {"mode": r["mapping_mode"], "target_account_id": r["target_account_id"]}
                  for r in rows},
        default_owner_id=None,
    )
    return conn.execute(count, (connection_id,)).fetchone()["n"] - before


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
    # A checkbook number restarts at 1 on every account: worth reading, worthless as evidence two rows are
    # the same charge (two accounts both writing check #1042 is ordinary).
    add("Check number", txn.get("check_number"), role=EVIDENCE_ROLE_CATEGORICAL)
    # Recorded as text so the transaction/posted disagreement is visible on the row itself, not only
    # inferable from the column. The dedupe sweep reads the real `posted_date` column for its date
    # window; this copy is for display and must never re-enter matching as text.
    add("Posted date", txn.get("posted_date"), role=EVIDENCE_ROLE_CATEGORICAL)
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
