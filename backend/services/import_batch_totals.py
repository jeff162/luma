"""Keeping an import card's counts true to the ledger once rows leave it.

An import card (`import_batch`) states its counts in three places: the columns (`row_count`,
`skipped_count`, `deduped_count`), the headline summary in `config_snapshot.import_summary`, and the
per-account breakdown (`import_batch_account.row_count`). An import or a sync writes all three together.
A row leaving afterwards — an account deleted, the trash emptied — is what they cannot foresee, and any
counter a deletion leaves alone goes on describing a row that no longer exists while the others move on.
The card then stops adding up on screen: account chips that total more than the ledger holds, a headline
row count and a duplicates pill drawn from two different tallies.

Two rules follow. A hard delete of imported rows goes through `delete_transactions`, which takes each row
off the per-account entry that counted it and refreshes the cards it touched. And `refresh_batch_totals`
re-derives the columns and every headline figure of the summary from one set of parts, so the card's
row count and its summary cannot contradict each other.
"""

from __future__ import annotations

import json

from backend.json_utils import safe_json_dict

IMPORT_SUMMARY_KEY = "import_summary"


def _batch_has_duplicates(conn, batch_id: str) -> bool:
    """Whether the card still holds a duplicate report — asked of the rows rather than of
    `deduped_count`, so a counter that has drifted low cannot take a real report down with the card."""
    return conn.execute(
        "SELECT 1 FROM import_batch_duplicate WHERE batch_id = ? LIMIT 1", (batch_id,)
    ).fetchone() is not None


def refresh_batch_totals(conn, batch_ids, *, drop_emptied_sync_cards: bool = False) -> None:
    """Re-derive each card's totals from the rows it still holds.

    `imported` is the card's rows still in `txn` (trashed included — a trashed row is recoverable and still
    came from this card); skipped and deduped are the columns, which record rows that never reached the
    ledger and so cannot be recounted from it. `row_count` is their sum — rows received, on a sync card as
    on a file card — and the summary's headline figures are rewritten from the same parts, all four
    together. Rewriting only some of them is how a summary came to say 55 imported + 11 duplicates = 83.

    Per-account entries whose account no longer exists are cleared here too: a mapped entry is removed, a
    skipped one keeps its count and loses only the destination it never used.

    `drop_emptied_sync_cards` deletes a data-source card that recomputes to nothing and holds no duplicate
    report, on the reasoning `connections.remove_synced_transactions` deletes cards instead of leaving
    tombstones: a sync card records rows, so with its last row gone it records nothing, and the card
    resolvers key on (connection, backfill/period) without regard to status — a survivor would simply be
    reused by the next backfill. Deleting the accounts a connection synced into used to strand one, and
    disconnecting afterwards (`connection_id` is ON DELETE SET NULL) left it unreachable by every cleanup
    keyed on the connection. A CSV card is never dropped: it records a file the user supplied, which stays
    true after its rows are gone. Only the deletion paths pass it; the history listing's best-effort
    reconcile does not, since it runs on a read while a sync may be between writing a card and its counts.

    Writes only what changed, because the history listing calls this on every load and a write per card
    per load is lock contention for nothing.
    """
    from backend.routers.sync import SYNC_SOURCE_KIND

    for batch_id in sorted({str(value).strip() for value in (batch_ids or []) if str(value or "").strip()}):
        conn.execute(
            """
            DELETE FROM import_batch_account
            WHERE batch_id = ?
              AND was_skipped = 0
              AND account_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM account a WHERE a.id = import_batch_account.account_id)
            """,
            (batch_id,),
        )
        conn.execute(
            """
            UPDATE import_batch_account
            SET account_id = NULL
            WHERE batch_id = ?
              AND was_skipped = 1
              AND account_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM account a WHERE a.id = import_batch_account.account_id)
            """,
            (batch_id,),
        )

        batch = conn.execute(
            "SELECT row_count, skipped_count, deduped_count, source_kind, config_snapshot "
            "FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            continue

        imported_count = int(conn.execute(
            "SELECT COUNT(*) FROM txn WHERE import_batch_id = ?", (batch_id,),
        ).fetchone()[0] or 0)
        skipped_count = int(batch["skipped_count"] or 0)
        deduped_count = int(batch["deduped_count"] or 0)
        total_rows = imported_count + skipped_count + deduped_count

        if (drop_emptied_sync_cards and total_rows == 0 and batch["source_kind"] == SYNC_SOURCE_KIND
                and not _batch_has_duplicates(conn, batch_id)):
            conn.execute("DELETE FROM import_batch WHERE id = ?", (batch_id,))
            continue

        if int(batch["row_count"] or 0) != total_rows:
            conn.execute("UPDATE import_batch SET row_count = ? WHERE id = ?", (total_rows, batch_id))

        snapshot = safe_json_dict(batch["config_snapshot"])
        summary = snapshot.get(IMPORT_SUMMARY_KEY)
        if isinstance(summary, dict):
            headline = {
                "imported_count": imported_count,
                "skipped_count": skipped_count,
                "deduped_count": deduped_count,
                "total_rows": total_rows,
            }
            if any(summary.get(key) != value for key, value in headline.items()):
                summary.update(headline)
                snapshot[IMPORT_SUMMARY_KEY] = summary
                conn.execute(
                    "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                    (json.dumps(snapshot), batch_id),
                )


def delete_transactions(conn, where_sql: str, params=(), *, drop_emptied_sync_cards: bool = True) -> int:
    """Hard-delete the `txn` rows matching `where_sql`, keeping the cards they came from true. Returns the
    number of rows removed.

    Each imported row is taken off the per-account entry that counted it, found by the source label its
    evidence recorded (`import_evidence_json.account.value`, which is the entry's `csv_value` on a file
    card and a sync card alike); a row with no label came from a single-account file, whose one entry is
    keyed `''`. Attributing by the row's current `account_id` instead would miss exactly the row that has
    moved since it was imported — the entry names the account it arrived on, not the one it is on now.
    The entry is decremented rather than removed, since a file card's entry also carries the coverage claim
    duplicate detection reads, and that claim stays true after the rows are gone.
    """
    released = conn.execute(
        f"""
        SELECT import_batch_id AS batch_id,
               COALESCE(CASE WHEN json_valid(import_evidence_json)
                             THEN json_extract(import_evidence_json, '$.account.value') END, '') AS csv_value,
               COUNT(*) AS n
        FROM   txn
        WHERE  import_batch_id IS NOT NULL AND ({where_sql})
        GROUP  BY 1, 2
        """,
        params,
    ).fetchall()
    removed = conn.execute(f"DELETE FROM txn WHERE {where_sql}", params).rowcount or 0
    for row in released:
        conn.execute(
            "UPDATE import_batch_account SET row_count = MAX(row_count - ?, 0) WHERE batch_id = ? AND csv_value = ?",
            (row["n"], row["batch_id"], row["csv_value"]),
        )
    refresh_batch_totals(
        conn, {row["batch_id"] for row in released}, drop_emptied_sync_cards=drop_emptied_sync_cards,
    )
    return removed
