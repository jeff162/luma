"""Clearing the detail records an import leaves behind, without touching the ledger it produced.

Every import keeps a **duplicate report**: one row per row it refused, holding the raw values, the
transaction it matched and the payload it would have inserted. That report is what the duplicates view
reads, what makes "Import anyway" possible, and what an enrichment is undone from — and it is also, by a
wide margin, the largest thing the import history stores. Measured on a real ledger it was 34 MB of JSON
against a 73 MB database, more than every transaction put together, and it rides every backup.

So this is **maintenance over stored diagnostics**, not deletion of anything curated, and the shape
follows from that:

- **The card stays in the history.** Only its detail records go; the card keeps its row, its counts, its
  coverage and its place in the list, and says that its detail has been cleared. An action that made
  cards disappear would need a destructive vocabulary that misdescribes what it does — and the archive
  already keeps the list short, so hiding them bought nothing.
- **Nothing else on the card is touched**, and each survivor is load-bearing somewhere a removal would
  break silently: `txn.import_batch_id` is how the ledger knows a row was not entered by hand;
  `file_content_hash` with `status` is the re-import guard; `import_batch_account.coverage_*` is the
  claim duplicate detection reads for a terminal-day window; and `config_snapshot` routes later imports
  (a PayPal statement finds its account by reading the snapshots of the statements before it).

**Nothing is left stranded.** A transaction trashed as a confirmed duplicate is deliberately hidden from
Settings → Trash while its report exists, because the report is where it is restorable from. Clearing the
report closes that door, so the row is handed to the Trash in the same write: a row whose only door was
closing gets the one made for it. Rows resolved by an account merge are untouched — their undo is
detaching the accounts, which has nothing to do with the report.
"""

from __future__ import annotations

import json
from typing import Optional

from backend.services.duplicate_detection import (
    ADVISORY_REVIEW_SUBSTATES,
    is_settled_source_restatement,
)

# Resolutions whose only undo lives in the originating card's duplicate report. `auto_merge` is absent
# on purpose: those rows come back by detaching the accounts that were merged, a path this does not
# disturb. See `routers/transactions.py` for the Trash view's matching exclusion.
REPORT_RESTORABLE_RESOLUTIONS = ("user", "auto_cross_source")

_PLACEHOLDERS = ", ".join("?" * len(REPORT_RESTORABLE_RESOLUTIONS))

# What "still flagged for review" means, taken from the one definition rather than restated here. The
# figure this screen shows is the last thing read before an irreversible delete, so it has to mean what
# the cards mean by it: `reviewed_at IS NULL` alone counts every settled restatement and cross-account
# twin nothing ever asked anyone to look at, which on a real ledger read 30,632 where the answer was 75.
_ADVISORY_PLACEHOLDERS = ", ".join("?" * len(ADVISORY_REVIEW_SUBSTATES))
_UNREVIEWED_SQL = f"""
    CASE WHEN reviewed_at IS NULL AND review_substate IN ({_ADVISORY_PLACEHOLDERS}) THEN 1 ELSE 0 END
"""

# The columns that make each kind of record large. Summed rather than estimated, because saying where
# the space actually is is the whole point of the screen this feeds. Both kinds are counted, and both
# are cleared together: a card holding only refused rows would otherwise be offered for clearing while
# reporting nothing at all to clear.
_REPORT_BYTES = """
    LENGTH(COALESCE(values_json, '')) + LENGTH(COALESCE(matched_transaction_json, ''))
  + LENGTH(COALESCE(txn_payload_json, '')) + LENGTH(COALESCE(enriched_delta_json, ''))
"""
_REJECTED_BYTES = """
    LENGTH(COALESCE(values_json, '')) + LENGTH(COALESCE(description, ''))
"""


def _clean_ids(batch_ids) -> list[str]:
    return sorted({str(value).strip() for value in (batch_ids or []) if str(value or "").strip()})


def detail_storage(conn) -> dict:
    """What each card's detail records hold, keyed by batch id.

    Two grouped passes rather than a query per card: this is read when the maintenance screen opens
    rather than on every history load, so one scan of each table beats N round trips.
    """
    by_batch: dict[str, dict] = {}
    for row in conn.execute(f"""
        SELECT batch_id,
               COUNT(*) AS report_rows,
               COALESCE(SUM({_REPORT_BYTES}), 0) AS bytes,
               COALESCE(SUM({_UNREVIEWED_SQL}), 0) AS unreviewed_rows
        FROM   import_batch_duplicate
        GROUP  BY batch_id
    """, ADVISORY_REVIEW_SUBSTATES):
        by_batch[row["batch_id"]] = {
            "report_rows": int(row["report_rows"] or 0),
            "bytes": int(row["bytes"] or 0),
            "unreviewed_rows": int(row["unreviewed_rows"] or 0),
            "rejected_rows": 0,
        }
    for row in conn.execute(f"""
        SELECT batch_id,
               COUNT(*) AS rejected_rows,
               COALESCE(SUM({_REJECTED_BYTES}), 0) AS bytes
        FROM   import_batch_rejected_row
        GROUP  BY batch_id
    """):
        entry = by_batch.setdefault(
            row["batch_id"], {"report_rows": 0, "bytes": 0, "unreviewed_rows": 0, "rejected_rows": 0},
        )
        entry["rejected_rows"] = int(row["rejected_rows"] or 0)
        entry["bytes"] += int(row["bytes"] or 0)
    return by_batch


def _account_header(config_snapshot: Optional[str]) -> str:
    """The file header the import read each row's source label from, or "" when there is none.

    No header means no way to know which source a stored row was mapped under, which is the one fact
    the restatement test turns on — a single-account file (nothing to read) and a sync card (no column
    map at all) both land here, and both are left alone rather than guessed about.
    """
    try:
        snapshot = json.loads(config_snapshot) if config_snapshot else {}
    except (TypeError, ValueError):
        return ""
    if not isinstance(snapshot, dict):
        return ""
    column_map = snapshot.get("column_map")
    if not isinstance(column_map, dict):
        return ""
    return str(column_map.get("account") or "").strip()


def restatement_rows(conn, batch_id: str) -> list[int]:
    """The rows of this card's report that an import running today would never have written.

    The same test the import path applies (`is_settled_source_restatement`), asked after the fact. It
    needs the source label each row was mapped under, which the report has no column for — so it is
    read back out of the row's own stored cells, which is exact rather than approximate: a file mapping
    several accounts at once (an aggregator export is always one) would otherwise have a second source's
    claim mistaken for the card's own.

    `review_substate` is what the sub-state is read from rather than recomputing it, and it is
    trustworthy both ways: the one thing that rewrites it after the fact
    (`refresh_unexplained_coverage_candidates`) keeps it in step with the candidates it rewrites, and it
    only ever moves a row *out of* `no_match`. So a row settled today cannot become flagged tomorrow,
    which is what makes removing it safe.
    """
    batch = conn.execute(
        "SELECT config_snapshot FROM import_batch WHERE id = ?", (batch_id,),
    ).fetchone()
    if not batch:
        return []
    header = _account_header(batch["config_snapshot"])
    if not header:
        return []
    found: list[int] = []
    for row in conn.execute(
        """
        SELECT row_number, values_json, matched_transaction_json, review_substate
        FROM   import_batch_duplicate
        WHERE  batch_id = ? AND enriched_at IS NULL
        """,
        (batch_id,),
    ):
        try:
            values = json.loads(row["values_json"]) if row["values_json"] else {}
            matched = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
        except (TypeError, ValueError):
            continue
        if not isinstance(values, dict) or not isinstance(matched, dict):
            continue
        if row["review_substate"] in ADVISORY_REVIEW_SUBSTATES:
            continue
        csv_value = str(values.get(header, "") or "").strip()
        if is_settled_source_restatement(matched, csv_value=csv_value):
            found.append(int(row["row_number"]))
    return found


def summarize_restatement_removal(conn, batch_ids) -> dict:
    """What bringing these cards in line with how imports work now would remove, and what would stay.

    Counted by the code that performs the write, like the clearing preview beside it, so the sentence
    agreed to is the one carried out.
    """
    summary = {"cards": 0, "rows": 0, "bytes": 0, "rows_kept": 0, "flagged_kept": 0}
    for batch_id in _clean_ids(batch_ids):
        rows = restatement_rows(conn, batch_id)
        if not rows:
            continue
        placeholders = ", ".join("?" * len(rows))
        counts = conn.execute(
            f"""
            SELECT COALESCE(SUM({_REPORT_BYTES}), 0) AS bytes
            FROM   import_batch_duplicate
            WHERE  batch_id = ? AND row_number IN ({placeholders})
            """,
            (batch_id, *rows),
        ).fetchone()
        kept = conn.execute(
            f"""
            SELECT COUNT(*) AS rows_kept,
                   COALESCE(SUM({_UNREVIEWED_SQL}), 0) AS flagged_kept
            FROM   import_batch_duplicate
            WHERE  batch_id = ? AND row_number NOT IN ({placeholders})
            """,
            (*ADVISORY_REVIEW_SUBSTATES, batch_id, *rows),
        ).fetchone()
        summary["cards"] += 1
        summary["rows"] += len(rows)
        summary["bytes"] += int(counts["bytes"] or 0)
        summary["rows_kept"] += int(kept["rows_kept"] or 0)
        summary["flagged_kept"] += int(kept["flagged_kept"] or 0)
    return summary


def remove_batch_restatements(conn, batch_ids) -> dict:
    """Remove the report rows an import running today would not have written, and move each card's
    counts to match.

    Deliberately **not** the clearing path with a narrower WHERE, because two of that path's steps would
    be wrong here. It does not release the card's trashed confirmed-duplicates to the Trash: that happens
    because the report they are restorable from is going away, and here it stays. And it does not set
    `detail_cleared_at`: nothing was cleared in the sense that marker records, and a card wearing it
    would say its detail had been freed while still holding a report. What moves instead is the pair of
    counts, out of `deduped_count` and into `ignored_count` — which is the whole point, since that is
    the shape the same file would have produced had it been imported today.
    """
    done = summarize_restatement_removal(conn, batch_ids)
    for batch_id in _clean_ids(batch_ids):
        rows = restatement_rows(conn, batch_id)
        if not rows:
            continue
        placeholders = ", ".join("?" * len(rows))
        conn.execute(
            f"DELETE FROM import_batch_duplicate WHERE batch_id = ? AND row_number IN ({placeholders})",
            (batch_id, *rows),
        )
        conn.execute(
            """
            UPDATE import_batch
            SET    deduped_count = MAX(0, deduped_count - ?),
                   ignored_count = ignored_count + ?
            WHERE  id = ?
            """,
            (len(rows), len(rows), batch_id),
        )
    return done


def summarize_detail_clearing(conn, batch_ids) -> dict:
    """What clearing these cards' detail would and would not do, for the confirmation to state.

    Every figure the dialog shows is counted here rather than inferred on the client, so the sentence
    agreed to is the one the write is about to carry out.
    """
    summary = {
        "cards": 0,
        "transactions_kept": 0,
        "report_rows": 0,
        "unreviewed_rows": 0,
        "enrichment_undos": 0,
        "rejected_rows": 0,
        "trashed_released": 0,
        "bytes": 0,
    }
    for batch_id in _clean_ids(batch_ids):
        counts = conn.execute(
            f"""
            SELECT COUNT(*) AS report_rows,
                   COALESCE(SUM({_REPORT_BYTES}), 0) AS bytes,
                   COALESCE(SUM({_UNREVIEWED_SQL}), 0) AS unreviewed,
                   COALESCE(SUM(CASE WHEN enriched_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS enriched
            FROM   import_batch_duplicate
            WHERE  batch_id = ?
            """,
            (*ADVISORY_REVIEW_SUBSTATES, batch_id),
        ).fetchone()
        rejected_row = conn.execute(
            f"""
            SELECT COUNT(*) AS rows, COALESCE(SUM({_REJECTED_BYTES}), 0) AS bytes
            FROM   import_batch_rejected_row
            WHERE  batch_id = ?
            """,
            (batch_id,),
        ).fetchone()
        rejected = int(rejected_row["rows"] or 0)
        # Nothing stored, so nothing to offer — a card already cleared, or one that refused no rows.
        if not counts["report_rows"] and not rejected:
            continue
        summary["cards"] += 1
        summary["report_rows"] += int(counts["report_rows"] or 0)
        summary["bytes"] += int(counts["bytes"] or 0) + int(rejected_row["bytes"] or 0)
        summary["unreviewed_rows"] += int(counts["unreviewed"] or 0)
        summary["enrichment_undos"] += int(counts["enriched"] or 0)
        summary["rejected_rows"] += rejected
        summary["transactions_kept"] += int(conn.execute(
            "SELECT COUNT(*) FROM txn WHERE import_batch_id = ? AND trashed_at IS NULL", (batch_id,),
        ).fetchone()[0] or 0)
        summary["trashed_released"] += int(conn.execute(
            f"""
            SELECT COUNT(*) FROM txn
            WHERE  import_batch_id = ? AND trashed_at IS NOT NULL
              AND  rejection_reason = 'duplicate_confirmed'
              AND  COALESCE(dedupe_resolved_by, '') IN ({_PLACEHOLDERS})
            """,
            (batch_id, *REPORT_RESTORABLE_RESOLUTIONS),
        ).fetchone()[0] or 0)
    return summary


def clear_batch_detail(conn, batch_ids, *, cleared_at: str) -> dict:
    """Clear these cards' detail records. Returns what `summarize_detail_clearing` promised."""
    done = summarize_detail_clearing(conn, batch_ids)
    for batch_id in _clean_ids(batch_ids):
        # Handed to the Trash before the report that owned them is deleted. `suspect_duplicate_of` stays:
        # it is the audit trail of which row was accepted as the canonical copy, and no read of a trashed
        # row consults it.
        conn.execute(
            f"""
            UPDATE txn
            SET    rejection_reason = NULL, dedupe_resolved_by = NULL
            WHERE  import_batch_id = ?
              AND  trashed_at IS NOT NULL
              AND  rejection_reason = 'duplicate_confirmed'
              AND  COALESCE(dedupe_resolved_by, '') IN ({_PLACEHOLDERS})
            """,
            (batch_id, *REPORT_RESTORABLE_RESOLUTIONS),
        )
        conn.execute("DELETE FROM import_batch_duplicate WHERE batch_id = ?", (batch_id,))
        conn.execute("DELETE FROM import_batch_rejected_row WHERE batch_id = ?", (batch_id,))
        conn.execute(
            "UPDATE import_batch SET detail_cleared_at = ? WHERE id = ?", (cleared_at, batch_id),
        )
    return done
