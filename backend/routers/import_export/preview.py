# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
CSV import preview.

The preview endpoint is the read-only first stage of the import workflow: it parses an uploaded
file enough to drive the mapping UI (detected header row, columns, sample + tail lines, per-column
distinct values and counts for account mapping/skip totals) and surfaces continuity hints — the
best-matching saved profile and the most recent completed batch for the same file content, so a
re-import can restore the previous column/account configuration. It writes nothing.

`/preview/amounts` serves the same stage: it answers what the amount of each previewed row will be
under the current convention and column mapping. It exists because a preview computed by a second
implementation can disagree with the import precisely when that matters — the client used to parse
amounts itself and got `single_unsigned`, `DR`/`CR` suffixes and blank two-column cells wrong — so
the amounts shown come from the same `parse_amount` the import runs. It posts rows rather than a
file because `/preview` persists nothing there is a handle to re-parse.

The actual import (`/run`) and the shared parse/hash/header primitives it co-owns live in `core`;
this module reuses those primitives so preview and run agree on how a file is read.
"""

import csv
import io
import json

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from backend.db.database import get_db

from .core import (
    MAX_DISTINCT_VALUES_PER_COLUMN,
    AmountColumnMap,
    _detect_header_row_index,
    make_import_file_hash,
    parse_amount,
    sniff_paypal_activity,
)

router = APIRouter()

# The mapping table previews 10 rows; the cap only exists so the endpoint can't be handed a whole file.
MAX_PREVIEW_AMOUNT_ROWS = 50


class PreviewAmountsRequest(BaseModel):
    rows:              list[dict]
    amount_convention: str = "single_signed"
    column_map:        AmountColumnMap


def _amount_columns_mapped(convention: str, col_map: AmountColumnMap) -> bool:
    """
    Whether the convention's required columns are mapped. Without this a half-configured mapping
    would render `$0.00` rather than the unparseable marker, because `parse_amount`'s `two_column`
    branch reads a missing column as an empty cell and an empty pair sums to zero.
    """
    if convention == "two_column":
        return bool(col_map.debit and col_map.credit)
    return bool(col_map.amount)


def _summarize_tail_lines(all_lines: list[str], count: int = 20) -> tuple[list[str], int]:
    if not all_lines:
        return [], 0
    start = max(0, len(all_lines) - count)
    return all_lines[start:], start


@router.post("/preview")
async def preview_csv(file: UploadFile = File(...)):
    """
    Parse the uploaded CSV and return (this is the second copy of the parse seam -- the first is in
    `core.py::run_import_core`, and preview must read the same rows the import will; see
    docs/building-a-connector.md -> Adding a file importer):
    - raw_lines: first 20 raw text lines (for the file preview panel)
    - header_row_index: which line index the header was detected on
    - headers: list of column names
    - rows: first 10 data rows as dicts
    - total_rows: total data row count
    - column_distinct_values: all distinct values per column (for account mapping)
    - column_value_counts: row counts for distinct values per column (for account skip totals)
    - suggested_profile_id: best matching saved profile, or null
    - previous_batch: most recent completed batch for this filename, or null
    - previous_batch_accounts: accounts imported in previous batch (for dup warning)
    - config_snapshot: column/account config from previous batch (to restore)
    """
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    try:
        all_lines = text.splitlines()
        raw_lines  = all_lines[:20]
        raw_tail_lines, raw_tail_start_line = _summarize_tail_lines(all_lines)

        header_row_index = _detect_header_row_index(text)
        data_text = "\n".join(all_lines[header_row_index:])
        reader = csv.DictReader(io.StringIO(data_text))
        raw_headers = reader.fieldnames or []
        # Strip leading/trailing whitespace from header names — HTML option values
        # trim whitespace, so a header like " Amount" would cause a key mismatch.
        headers = [h.strip() for h in raw_headers]
        all_rows = []
        for row in reader:
            stripped = {k.strip(): v for k, v in row.items() if k}
            all_rows.append(stripped)
        rows       = all_rows[:10]
        total_rows = len(all_rows)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    filename  = file.filename or ""
    header_fp = "|".join(headers)
    file_content_hash = make_import_file_hash(text)

    column_distinct_values: dict = {}
    column_value_counts: dict = {}
    for row in all_rows:
        for col, val in row.items():
            v = str(val or "").strip()
            if v:
                column_distinct_values.setdefault(col, set()).add(v)
                column_value_counts.setdefault(col, {})
                column_value_counts[col][v] = column_value_counts[col].get(v, 0) + 1
    column_distinct_meta = {
        col: {
            "total_count": len(vals),
            "displayed_count": min(len(vals), MAX_DISTINCT_VALUES_PER_COLUMN),
            "truncated": len(vals) > MAX_DISTINCT_VALUES_PER_COLUMN,
            "limit": MAX_DISTINCT_VALUES_PER_COLUMN,
        }
        for col, vals in column_distinct_values.items()
    }
    sorted_distinct_values = {
        col: sorted(vals)[:MAX_DISTINCT_VALUES_PER_COLUMN]
        for col, vals in column_distinct_values.items()
    }
    column_distinct_values = sorted_distinct_values
    column_value_counts = {
        col: {
            value: column_value_counts.get(col, {}).get(value, 0)
            for value in values
        }
        for col, values in sorted_distinct_values.items()
    }

    try:
        with get_db() as conn:
            profiles = conn.execute(
                "SELECT id, name, filename_pattern, header_fingerprint FROM csv_import_profile"
            ).fetchall()

            suggested_profile_id = None
            for p in profiles:
                if p["header_fingerprint"] and p["header_fingerprint"] == header_fp:
                    suggested_profile_id = p["id"]
                    break
            if not suggested_profile_id:
                for p in profiles:
                    if (
                        p["filename_pattern"]
                        and p["filename_pattern"].lower() in filename.lower()
                        and not p["header_fingerprint"]
                    ):
                        suggested_profile_id = p["id"]
                        break

            # Find most recent completed batch for this exact file content first.
            # Older databases may have imports without a stored file hash, in
            # which case there simply won't be a match.
            previous_batch = conn.execute("""
                SELECT id, imported_at, row_count, status, config_snapshot
                FROM   import_batch
                WHERE  file_content_hash = ? AND status = 'completed'
                ORDER  BY imported_at DESC LIMIT 1
            """, (file_content_hash,)).fetchone()

            previous_batch_accounts = []
            config_snapshot         = None
            if previous_batch:
                # Report the raw data-source account the batch was mapped to, not its
                # current parent. The import mapping UI deals in data-source accounts —
                # whether the user has since grouped that account under another on the
                # Accounts page is irrelevant here.
                acc_rows = conn.execute("""
                    SELECT iba.csv_value, iba.row_count, iba.was_skipped,
                           a.id AS account_id,
                           COALESCE(a.name, a.display_name) AS account_name
                    FROM   import_batch_account iba
                    LEFT JOIN account a ON a.id = iba.account_id
                    WHERE  iba.batch_id = ? AND iba.was_skipped = 0
                """, (previous_batch["id"],)).fetchall()
                previous_batch_accounts = [dict(r) for r in acc_rows]

                if previous_batch["config_snapshot"]:
                    try:
                        config_snapshot = json.loads(previous_batch["config_snapshot"])
                    except Exception:
                        pass

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    return {
        "raw_lines":              raw_lines,
        "raw_tail_lines":         raw_tail_lines,
        "raw_tail_start_line":    raw_tail_start_line,
        "header_row_index":       header_row_index,
        "headers":                headers,
        "rows":                   rows,
        "total_rows":             total_rows,
        "filename":               filename,
        "file_content_hash":      file_content_hash,
        "header_fingerprint":     header_fp,
        "is_paypal":              sniff_paypal_activity(headers),
        "suggested_profile_id":   suggested_profile_id,
        "previous_batch":         dict(previous_batch) if previous_batch else None,
        "previous_batch_accounts":previous_batch_accounts,
        "config_snapshot":        config_snapshot,
        "column_distinct_values": column_distinct_values,
        "column_value_counts":    column_value_counts,
        "column_distinct_meta":   column_distinct_meta,
    }


@router.post("/preview/amounts")
async def preview_amounts(req: PreviewAmountsRequest):
    """
    Return the signed amount for each posted preview row — positionally aligned with `rows`, `null`
    where the row can't be parsed or the convention's columns aren't mapped.

    This is a loop over the import's own `parse_amount`, which is the entire point: the preview and
    the import cannot disagree about a row's sign or magnitude because only one of them parses.
    """
    if len(req.rows) > MAX_PREVIEW_AMOUNT_ROWS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many rows to preview amounts for (limit {MAX_PREVIEW_AMOUNT_ROWS})",
        )

    if not _amount_columns_mapped(req.amount_convention, req.column_map):
        return {"amounts": [None] * len(req.rows)}

    return {
        "amounts": [
            parse_amount(row, req.amount_convention, req.column_map)
            for row in req.rows
        ]
    }
