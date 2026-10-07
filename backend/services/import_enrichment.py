# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Enrich an existing transaction with a later import's novel detail.

When an import row is a duplicate of a row already in the ledger, the incoming source often carries
descriptive detail the stored row lacks (a memo, a counterparty, an item title). This folds only the
**novel** part of that detail into the existing row's `import_evidence_json` — the source-record surface
the transaction-detail Origin hover already renders and `match_source_text` rules already read.

Three properties keep it safe and general (see `docs/data-model.md` → Import batches and profiles):

  * **Additive, never destructive.** It only ever *appends* descriptive fields to `extra_text_fields`;
    it does not overwrite anything, and it deliberately touches no user-facing/editable field
    (display_name, category, notes) — so there is no manual value to protect here. (Name enrichment,
    if ever added, is a separate step guarded by `display_name_source`.)
  * **A delta, not a copy.** A field is folded in only when its value isn't already present on the row
    (in its names or its existing evidence), so nothing the row already holds is duplicated — and a
    re-enrichment of the same match adds nothing.
  * **Reversible.** The exact set of appended fields is returned as the delta, recorded on the duplicate
    report row, and removed verbatim on undo.
  * **Refused when the two disagree about what the transaction is.** A captured `Type` is the source's
    own statement of the kind of transaction (a payment, a refund, a card deposit into a wallet), and
    two rows whose types name different kinds are two transactions however their amounts line up — so
    nothing of the incoming one is folded in (see `_conflicting_kind`).

This is source-agnostic: the same engine backs the manual duplicate-resolution action and the opt-in
per-source auto-enrich. It operates on the incoming import's captured `import_evidence` — so a field
only flows if the import captured it (e.g. PayPal's "Item Title" flows only once that column is captured
into evidence).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from backend.services.money_movement import (
    is_money_movement_type,
    is_refund_type,
    is_wallet_funding_type,
    is_wallet_withdrawal_type,
)


def _parse(raw) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def _parse_list(raw) -> list:
    if not raw:
        return []
    try:
        value = json.loads(raw)
        return value if isinstance(value, list) else []
    except (ValueError, TypeError):
        return []


def _evidence_values(evidence) -> set[str]:
    """Every non-empty string value already present anywhere in an evidence blob, casefolded."""
    values: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            for item in node.values():
                walk(item)
        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)
        elif isinstance(node, str) and node.strip():
            values.add(node.strip().casefold())

    walk(evidence)
    return values


def _incoming_detail_fields(incoming_evidence: dict) -> list[dict]:
    """The descriptive fields worth transferring from an incoming import's evidence: its description and
    any captured extra text fields. The account label is excluded — it identifies the file/account, not
    the transaction's detail."""
    fields: list[dict] = []
    description = incoming_evidence.get("description")
    if isinstance(description, dict) and str(description.get("value") or "").strip():
        fields.append({"header": str(description.get("header") or "Description"), "value": str(description["value"])})
    for field in incoming_evidence.get("extra_text_fields") or []:
        if isinstance(field, dict) and str(field.get("value") or "").strip():
            # Preserve the role (if any) so an enriched categorical value stays out of the duplicate
            # text-matcher on the row it lands on, just as it would on the row it came from.
            transferred = {"header": str(field.get("header") or ""), "value": str(field["value"])}
            role = str(field.get("role") or "").strip()
            if role:
                transferred["role"] = role
            fields.append(transferred)
    return fields


def _type_kinds(evidence: dict) -> set[str]:
    """The kinds of transaction an evidence blob's captured `Type` values name. Compared by kind rather
    than by value because two sources spell one type differently — the activity CSV's "General Card
    Deposit" is the statement's "General Credit Card Deposit"."""
    kinds: set[str] = set()
    for field in evidence.get("extra_text_fields") or []:
        if not isinstance(field, dict) or str(field.get("header") or "").strip().casefold() != "type":
            continue
        value = str(field.get("value") or "").strip()
        if not value:
            continue
        if is_wallet_funding_type(value):
            kinds.add("funding")
        elif is_wallet_withdrawal_type(value):
            kinds.add("withdrawal")
        elif is_money_movement_type(value):
            kinds.add("movement")
        elif is_refund_type(value):
            kinds.add("refund")
        else:
            kinds.add("payment")
    return kinds


def _conflicting_kind(existing_evidence: dict, incoming_evidence: dict) -> bool:
    """Whether both sides state a `Type` and the incoming one names a kind the row is not.

    The case that found it: a wallet's nameless card leg matched, on amount alone, the purchase two days
    away, and folding its "General Card Withdrawal" into that purchase made the PayPal reconciliation read
    the purchase's money as leaving for a card. A row with no captured type yet has nothing to disagree
    with, so this cannot stop a first enrichment — the duplicate report's own claims are what keep the
    wrong row from reaching it (`release_contested_candidates`)."""
    existing, incoming = _type_kinds(existing_evidence), _type_kinds(incoming_evidence)
    return bool(existing and incoming and not incoming <= existing)


def compute_enrichment_delta(existing_evidence: dict, existing_names, incoming_evidence: dict) -> list[dict]:
    """The novel descriptive fields the incoming detail adds over what the row already holds. A field is
    novel when its value appears nowhere in the row's names or existing evidence. Nothing is novel when
    the incoming row is a different kind of transaction (`_conflicting_kind`)."""
    if _conflicting_kind(existing_evidence or {}, incoming_evidence or {}):
        return []
    known = _evidence_values(existing_evidence)
    known |= {str(name).strip().casefold() for name in existing_names if name and str(name).strip()}
    delta: list[dict] = []
    seen: set[str] = set()
    for field in _incoming_detail_fields(incoming_evidence or {}):
        key = field["value"].strip().casefold()
        if key in known or key in seen:
            continue
        seen.add(key)
        delta.append(field)
    return delta


def enrich_transaction(conn: sqlite3.Connection, txn_id: str, incoming_evidence: dict) -> Optional[list[dict]]:
    """Fold the incoming import's novel detail into `txn_id`'s evidence. Returns the applied delta (the
    appended fields), or None when the row is missing or the incoming carries nothing new."""
    row = conn.execute(
        "SELECT display_name, merchant_name, raw_name, import_evidence_json FROM txn WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if row is None:
        return None
    existing = _parse(row["import_evidence_json"])
    delta = compute_enrichment_delta(
        existing, (row["display_name"], row["merchant_name"], row["raw_name"]), incoming_evidence or {}
    )
    if not delta:
        return None
    extras = existing.get("extra_text_fields")
    existing["extra_text_fields"] = (extras if isinstance(extras, list) else []) + delta
    conn.execute("UPDATE txn SET import_evidence_json = ? WHERE id = ?", (json.dumps(existing), txn_id))
    return delta


def unenrich_transaction(conn: sqlite3.Connection, txn_id: str, delta: list[dict]) -> None:
    """Reverse a prior enrichment by removing exactly the fields it appended."""
    if not delta:
        return
    row = conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (txn_id,)).fetchone()
    if row is None:
        return
    existing = _parse(row["import_evidence_json"])
    extras = existing.get("extra_text_fields")
    if not isinstance(extras, list):
        return
    remove = {(str(d.get("header") or "").strip(), str(d.get("value") or "")) for d in delta}
    kept = [f for f in extras if (str(f.get("header") or "").strip(), str(f.get("value") or "")) not in remove]
    if kept:
        existing["extra_text_fields"] = kept
    else:
        existing.pop("extra_text_fields", None)
    conn.execute(
        "UPDATE txn SET import_evidence_json = ? WHERE id = ?",
        (json.dumps(existing) if existing else None, txn_id),
    )


# --- tying an enrichment to the duplicate-report row it came from (record + undo) -----------------

def enrich_duplicate_row(conn: sqlite3.Connection, batch_id: str, row_number: int, txn_id: str) -> Optional[list[dict]]:
    """Enrich `txn_id` from a persisted duplicate row's incoming payload and record the outcome on that
    row for undo. Returns the applied delta, or None if the row was already enriched or nothing is new."""
    dup = conn.execute(
        "SELECT txn_payload_json, enriched_at FROM import_batch_duplicate WHERE batch_id = ? AND row_number = ?",
        (batch_id, row_number),
    ).fetchone()
    if dup is None or dup["enriched_at"]:
        return None
    incoming_evidence = _parse(dup["txn_payload_json"]).get("import_evidence") or {}
    delta = enrich_transaction(conn, txn_id, incoming_evidence)
    if delta is None:
        return None
    conn.execute(
        """UPDATE import_batch_duplicate
           SET enriched_txn_id = ?, enriched_delta_json = ?, enriched_at = ?
           WHERE batch_id = ? AND row_number = ?""",
        (txn_id, json.dumps(delta), datetime.now(timezone.utc).isoformat(), batch_id, row_number),
    )
    return delta


def undo_duplicate_enrichment(conn: sqlite3.Connection, batch_id: str, row_number: int) -> bool:
    """Reverse a recorded duplicate-row enrichment (remove the folded-in fields, clear the record).
    Returns True if an enrichment was undone."""
    dup = conn.execute(
        "SELECT enriched_txn_id, enriched_delta_json, enriched_at FROM import_batch_duplicate WHERE batch_id = ? AND row_number = ?",
        (batch_id, row_number),
    ).fetchone()
    if dup is None or not dup["enriched_at"]:
        return False
    if dup["enriched_txn_id"]:
        unenrich_transaction(conn, dup["enriched_txn_id"], _parse_list(dup["enriched_delta_json"]))
    conn.execute(
        """UPDATE import_batch_duplicate
           SET enriched_txn_id = NULL, enriched_delta_json = NULL, enriched_at = NULL
           WHERE batch_id = ? AND row_number = ?""",
        (batch_id, row_number),
    )
    return True


def reverse_batch_enrichments(conn: sqlite3.Connection, batch_id: str) -> int:
    """Undo every enrichment a batch applied to existing rows. An enrichment mutates a row *outside* the
    batch (the pre-existing target), so undoing or replacing the batch must reverse those changes before
    the batch's duplicate records — which hold the delta needed to reverse — are deleted. Returns the
    count reversed."""
    rows = conn.execute(
        "SELECT row_number FROM import_batch_duplicate WHERE batch_id = ? AND enriched_at IS NOT NULL",
        (batch_id,),
    ).fetchall()
    return sum(1 for row in rows if undo_duplicate_enrichment(conn, batch_id, int(row["row_number"])))
