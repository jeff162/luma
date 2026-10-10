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

from backend.services.duplicate_detection import ADVISORY_REVIEW_SUBSTATES

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
