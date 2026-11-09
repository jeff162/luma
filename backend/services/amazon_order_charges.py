# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What an Amazon order carries from the card charges linked to it.

An order's own text is its item list, while the name a charge reached the card under (`Kindle Svcs`,
`Prime Video`, a marketplace descriptor) is often what says what the purchase was. Each linked charge's
text is copied into the order's evidence as an extra field (`Card charge`) with the `linked` role, so a
`match_source_text` rule written against the charge's text also matches the order, which is the row that
carries the category. The ledger search and the Origin block read the same evidence.

The role keeps the copy out of duplicate detection (`evidence_field_feeds_text_match`): the text is the
charge's, not something the order's source said, and fed to the matcher it would pair the order with its
own charge, and with any other charge carrying a generic descriptor.

Whenever a link's charges change, `refresh_order_from_charges` re-derives everything the order takes from
them: its amount (`amazon_order_amount`) and these fields. The fields are rebuilt from the charges linked
now, so adding, removing, unlinking, undoing and a hard delete all reach the same result.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Iterable

from backend.services import txn_links
from backend.services.amazon_order_amount import LINK_KIND, refresh_order_amount
from backend.services.import_evidence import EVIDENCE_ROLE_LINKED, evidence_field_feeds_text_match

LINKED_CHARGE_HEADER = "Card charge"


def charge_texts(row) -> list[str]:
    """The text a charge arrived with, as a rule on the charge itself would see it: its names and the
    descriptive fields its import captured. Repeats are dropped, ignoring case."""
    values = [row["merchant_name"], row["raw_name"]]
    try:
        evidence = json.loads(row["import_evidence_json"]) if row["import_evidence_json"] else {}
    except (TypeError, ValueError):
        evidence = {}
    if isinstance(evidence, dict):
        description = evidence.get("description")
        if isinstance(description, dict):
            values.append(description.get("value"))
        for field in evidence.get("extra_text_fields") or []:
            if evidence_field_feeds_text_match(field):
                values.append(field.get("value"))
    seen: set[str] = set()
    texts: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text.casefold() not in seen:
            seen.add(text.casefold())
            texts.append(text)
    return texts


def _charge_fields(conn: sqlite3.Connection, link_id: str) -> list[dict]:
    charge_ids = txn_links.member_txn_ids(conn, link_id, role="charge")
    if not charge_ids:
        return []
    rows = {r["id"]: r for r in conn.execute(
        f"""SELECT id, merchant_name, raw_name, import_evidence_json FROM txn
            WHERE id IN ({",".join("?" * len(charge_ids))})""",
        charge_ids,
    )}
    fields = []
    for charge_id in charge_ids:
        texts = charge_texts(rows[charge_id]) if charge_id in rows else []
        if texts:
            fields.append({"header": LINKED_CHARGE_HEADER, "value": " · ".join(texts),
                           "role": EVIDENCE_ROLE_LINKED, "txn_id": charge_id})
    return fields


def refresh_charge_text(conn: sqlite3.Connection, link_id: str) -> list[str]:
    """Rebuild the `Card charge` fields on the order of one Amazon link from the charges it links now.
    Returns the ids of the order rows whose evidence changed."""
    link = txn_links.get_link(conn, link_id)
    if not link or link.get("kind") != LINK_KIND:
        return []
    fields = _charge_fields(conn, link_id)
    changed = []
    for order_id in txn_links.member_txn_ids(conn, link_id, role="order"):
        row = conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (order_id,)).fetchone()
        if not row:
            continue
        try:
            evidence = json.loads(row["import_evidence_json"]) if row["import_evidence_json"] else {}
        except (TypeError, ValueError):
            evidence = {}
        if not isinstance(evidence, dict):
            evidence = {}
        current = [f for f in evidence.get("extra_text_fields") or [] if isinstance(f, dict)]
        own = [f for f in current if f.get("role") != EVIDENCE_ROLE_LINKED]
        if [f for f in current if f.get("role") == EVIDENCE_ROLE_LINKED] == fields:
            continue
        if own or fields:
            evidence["extra_text_fields"] = own + fields
        else:
            evidence.pop("extra_text_fields", None)
        conn.execute("UPDATE txn SET import_evidence_json = ? WHERE id = ?",
                     (json.dumps(evidence) if evidence else None, order_id))
        changed.append(order_id)
    return changed


def refresh_order_from_charges(conn: sqlite3.Connection, link_id: str, *, recategorize: bool) -> None:
    """Re-derive what an order takes from its linked charges, after any change to them. ``recategorize``
    re-runs the rules over an order whose charge text changed, so a rule written for the charge's text
    applies once the charge is linked; an import passes False, since its own categorization pass follows
    and the user may have turned it off. A manual or split category is left alone, as every rule pass
    leaves it."""
    refresh_order_amount(conn, link_id)
    changed = refresh_charge_text(conn, link_id)
    if recategorize and changed:
        # Imported here: the categorizer reaches much of the app, and this module sits low in it.
        from backend.services.categorizer import recategorize_all
        recategorize_all(conn, txn_ids=changed)


def links_with_charges(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> list[str]:
    """The Amazon order links that hold any of these transactions as a charge. Read before a delete, since
    the memberships cascade with the rows."""
    ids = [i for i in dict.fromkeys(txn_ids) if i]
    found: list[str] = []
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        found += [r["id"] for r in conn.execute(
            f"""SELECT DISTINCT l.id
                FROM   txn_link l JOIN txn_link_member m ON m.link_id = l.id
                WHERE  l.kind = ? AND m.role = 'charge' AND m.txn_id IN ({",".join("?" * len(chunk))})""",
            (LINK_KIND, *chunk),
        )]
    return list(dict.fromkeys(found))


def backfill_charge_text(conn: sqlite3.Connection) -> int:
    """Give every linked Amazon order its `Card charge` fields. For the migration that introduced them, and
    for a restored backup that predates them. Returns the number of orders written."""
    link_ids = [r["link_id"] for r in conn.execute(
        """SELECT DISTINCT m.link_id
           FROM   txn_link_member m JOIN txn_link l ON l.id = m.link_id
           WHERE  l.kind = ? AND m.role = 'charge'""",
        (LINK_KIND,),
    )]
    return sum(len(refresh_charge_text(conn, link_id)) for link_id in link_ids)
