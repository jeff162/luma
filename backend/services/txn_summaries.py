# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The ledger row as a reconciliation report shows it: amount, date, the readable name and account, and
the full origin fields the frontend's origin-detail hover reads (`importSourceFields.js`), so every report
renders one row the same way. Loaded in bulk, because a report lists hundreds of rows."""

from __future__ import annotations

import sqlite3
from typing import Iterable


def txn_summaries(conn: sqlite3.Connection, txn_ids: Iterable[str]) -> dict[str, dict]:
    """The summary for each id that exists, keyed by id."""
    ids = list(dict.fromkeys(i for i in txn_ids if i))
    out: dict[str, dict] = {}
    # SQLite's default bound-parameter ceiling is well above this, but a report can name thousands of rows.
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        rows = conn.execute(
            f"""SELECT t.id, t.date, t.amount, t.display_name, t.merchant_name, t.raw_name, t.account_id,
                       t.category_source, t.category_id, t.is_split, t.imported_category, t.import_evidence_json,
                       a.display_name AS account_name,
                       t.import_batch_id           AS source_batch_id,
                       ib.filename                 AS source_filename,
                       ib.imported_at              AS source_imported_at
                FROM   txn t
                JOIN   account a ON a.id = t.account_id
                LEFT   JOIN import_batch ib ON ib.id = t.import_batch_id
                WHERE  t.id IN ({",".join("?" * len(chunk))})""",
            chunk,
        ).fetchall()
        for row in rows:
            out[row["id"]] = _summary(row)
    return out


def _summary(row) -> dict:
    # Provenance: where this row came from, so a report can show "from <file>" on hover (and, with a
    # drill-through handler, open that file's ledger). Absent for rows that were not imported.
    source = None
    if row["source_filename"]:
        source = {
            "batchId": row["source_batch_id"],
            "filename": row["source_filename"],
            "importedAt": row["source_imported_at"],
        }
    return {
        "id": row["id"], "date": row["date"], "amount": row["amount"],
        "name": row["display_name"] or row["merchant_name"],
        "account_id": row["account_id"], "account": row["account_name"],
        "category_id": row["category_id"], "is_split": bool(row["is_split"]),
        "source": source,
        # Keyed as the ledger's origin-fields hover card expects.
        "display_name": row["display_name"],
        "merchant_name": row["merchant_name"],
        "raw_name": row["raw_name"],
        "category_source": row["category_source"],
        "imported_category": row["imported_category"],
        "import_evidence_json": row["import_evidence_json"],
        "import_batch_filename": row["source_filename"],
        "import_batch_imported_at": row["source_imported_at"],
    }
