# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
A file source's own transaction ids, and what an import does with them.

Some exports give every row an identifier the source assigned (an aggregator's `Id`, a wallet's
`Transaction ID`). Where a data source maps one, each row keeps it in `txn.source_transaction_id`, and it
is the strongest duplicate evidence a file can carry: two rows from one source with the same id are one
transaction however the source reworded or re-dated it between exports, and two with different ids are
two transactions however alike they look.

**The scope is the data source, read through the row's batch.** An id is unique only within the source
that issued it, so it is matched only against rows whose `import_batch.profile_id` is the importing
source. Nothing on the row records the scope; it is derived from the batch at read time. That is what
lets the scope follow the file when a file's batch moves to another source (saving a draft as a data
source, attaching a deleted source's files to another), and it is also why the invariant below matters.

**Invariant: a row's id was issued by the source of the batch it belongs to.** Every writer keeps this:
an id is only ever stamped onto a row of the importing source, and a row re-homed to the importing batch
(the pending→posted conversion) takes the incoming id or loses one another source issued.

**Adoption is per row, never per layout change.** A source can start carrying an id column long after
its earlier files were imported without one. Those rows are given their id when a later import's row is
matched to them by the ordinary duplicate ladder — so the first file with the column backfills every row
it overlaps, a re-import of an older file without the column changes nothing (a row with no id never
clears or rewrites one), and moving back and forth between the two layouts is harmless. Keying on the
moment the column appeared would instead have to tell which of two layouts is the newer.

The ladder sits *behind* the id rung rather than beside it: a candidate row this source already gave a
different id is not this transaction, so it is withheld from every rung that would name it
(`refutes`). A row claimed by an id match earlier in the same import is withheld the same way, which is
what keeps one held row from absorbing two incoming ones.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Optional

ID_MATCH_REASON = "Same transaction ID as an earlier import from this data source"
AMBIGUOUS_ID_MATCH_REASON = "Same transaction ID as more than one earlier row from this data source"


@dataclass
class IdMatch:
    """What the id rung decided for one incoming row.

    `kind` is one of: `same` (a restatement of the held row), `posted` (the held row is the pending version
    of this posted one), `revised` (the source changed the amount), or `ambiguous` (several held rows carry
    the id and none has this amount, so nothing is changed)."""

    kind: str
    row: dict


@dataclass
class SourceTransactionIds:
    """One import's view of its data source's ids. Built once per import (`load`), then consulted and
    updated row by row, so later rows in the same file see what earlier ones claimed and stamped."""

    held_by_id: dict[str, list[dict]] = field(default_factory=dict)
    # Every row of this source, keyed by txn id, mapped to its id (None while it has none).
    id_by_txn: dict[str, Optional[str]] = field(default_factory=dict)
    rows_by_txn: dict[str, dict] = field(default_factory=dict)
    # Rows this import has already matched, by id or by adoption. Never matched a second time.
    claimed: set[str] = field(default_factory=set)

    @classmethod
    def load(cls, conn: sqlite3.Connection, profile_id: Optional[str], *,
             exclude_batch_id: Optional[str] = None) -> Optional["SourceTransactionIds"]:
        """The source's rows, trashed ones included — a row the user removed is still the record of that
        transaction, and an import naming it again must not bring it back. None without a data source:
        a one-off file has no scope to match ids in, though it still stores them.

        `exclude_batch_id` leaves out one file's own rows, for re-judging that file's held rejections:
        its rows were not in the ledger when those rows were judged, as with any import."""
        if not profile_id:
            return None
        index = cls()
        for r in conn.execute(
            """SELECT t.id, t.source_transaction_id, t.amount, t.is_pending, t.date, t.raw_name,
                      t.merchant_name, t.display_name, t.account_id, t.import_batch_id
               FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
               WHERE  b.profile_id = ? AND b.id IS NOT ?""",
            (profile_id, exclude_batch_id),
        ).fetchall():
            row = dict(r)
            index.rows_by_txn[row["id"]] = row
            index.id_by_txn[row["id"]] = row["source_transaction_id"]
            if row["source_transaction_id"]:
                index.held_by_id.setdefault(row["source_transaction_id"], []).append(row)
        return index

    def claim(self, source_id: Optional[str], *, amount: float, is_pending: bool) -> Optional[IdMatch]:
        """The id rung. Equal amounts pair off first, so a source that issued one id to two rows (a split
        line, a fee) restates both without either being read as a revision of the other; only a lone
        unclaimed holder of the id can be revised."""
        if not source_id:
            return None
        held = [row for row in self.held_by_id.get(source_id, []) if row["id"] not in self.claimed]
        if not held:
            return None
        same_amount = next((row for row in held if _same_amount(row["amount"], amount)), None)
        if same_amount is not None:
            row, kind = same_amount, "same"
        elif len(held) == 1:
            row, kind = held[0], "revised"
        else:
            row, kind = held[0], "ambiguous"
        if kind != "ambiguous" and row["is_pending"] and not is_pending:
            kind = "posted"
        self.claimed.add(row["id"])
        return IdMatch(kind=kind, row=row)

    def refutes(self, txn_id: Optional[str], source_id: Optional[str]) -> bool:
        """Whether this import may NOT pair the incoming row with `txn_id`: the row was already claimed in
        this import, or this source gave it a different id. A row from another source, or one with no id
        yet, is never refuted — an id only speaks for its own source."""
        if not txn_id:
            return False
        if txn_id in self.claimed:
            return True
        held_id = self.id_by_txn.get(txn_id)
        return bool(source_id and held_id and held_id != source_id)

    def held_id(self, txn_id: str) -> Optional[str]:
        """The id this source gave `txn_id`, or None (no id yet, or not this source's row)."""
        return self.id_by_txn.get(txn_id)

    def adoption_target(self, matched: Optional[dict]) -> Optional[str]:
        """The held row a ladder rejection names precisely enough to give it the incoming id, or None.

        A rung that names one row (exact hash, boundary day, text) is taken at its word. A coverage
        rejection names *candidates*, and only an unambiguous one qualifies: same date, not a transfer
        counterpart, and either the one such candidate or the first whose wording is identical. Anything
        looser would hand the id to whichever same-amount row the lookup happened to list first."""
        if not isinstance(matched, dict):
            return None
        candidates = matched.get("candidates")
        if not isinstance(candidates, list):
            txn_id = matched.get("id")
            return txn_id if self._adoptable(txn_id) else None
        eligible = [
            c for c in candidates
            if isinstance(c, dict) and self._adoptable(c.get("id"))
            and not c.get("day_offset") and not c.get("cross_account")
        ]
        exact = [c for c in eligible if c.get("text_relation") == "exact"]
        if exact:
            return exact[0]["id"]
        return eligible[0]["id"] if len(eligible) == 1 else None

    def stamp(self, conn: sqlite3.Connection, txn_id: str, source_id: Optional[str]) -> bool:
        """Give an id-less row of this source its id. Never overwrites one already held."""
        if not source_id or not self._adoptable(txn_id):
            return False
        conn.execute(
            "UPDATE txn SET source_transaction_id = ? WHERE id = ? AND source_transaction_id IS NULL",
            (source_id, txn_id),
        )
        self.note_held(txn_id, source_id)
        return True

    def note_held(self, txn_id: str, source_id: Optional[str]) -> None:
        """Record that `txn_id` now carries `source_id` and is spoken for in this import."""
        self.claimed.add(txn_id)
        if not source_id:
            return
        self.id_by_txn[txn_id] = source_id
        row = self.rows_by_txn.get(txn_id)
        if row is not None:
            row["source_transaction_id"] = source_id
            self.held_by_id.setdefault(source_id, []).append(row)

    def _adoptable(self, txn_id: Optional[str]) -> bool:
        return bool(txn_id) and txn_id in self.id_by_txn and self.id_by_txn[txn_id] is None \
            and txn_id not in self.claimed


def held_row_summary(row: dict) -> dict:
    """The matched-transaction shape the duplicate report and enrichment read for a single-row match."""
    return {
        "id": row["id"],
        "date": row["date"],
        "merchant_name": row.get("display_name") or row.get("merchant_name") or row.get("raw_name"),
        "amount": row["amount"],
        "account_id": row["account_id"],
        "import_batch_id": row["import_batch_id"],
    }


def _same_amount(a, b) -> bool:
    return round(float(a or 0), 2) == round(float(b or 0), 2)
