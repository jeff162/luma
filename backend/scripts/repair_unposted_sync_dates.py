"""
Repair for transactions a data-source sync dated at the Unix epoch.

A provider that has to publish a posting timestamp for a charge that has not posted sends zero rather than
omitting the field (SimpleFIN does; the protocol makes `posted` required). Converted literally that is a
valid instant, so the row entered the ledger dated 1970-01-01: it sorts before every other transaction,
falls outside every report period, is unreachable by the duplicate ladder's date tests, and — because sync
cards are keyed on the transaction's own month — was filed on a card labelled "January 1970". The adapter
now reads a zero as "no such instant yet" and files such a row under its transaction date, and the sync
re-stamps the date when the charge settles, but neither reaches rows already written.

This is a script rather than a migration deliberately. The condition is a fixed set of already-written rows,
not a schema change, and this database is routinely restored from backup — so the repair has to be
re-runnable on demand rather than tied to a version bump that a restored copy has already passed. It is
idempotent: a second run finds nothing.

The corrected date is the row's `authorized_date`, which for these rows is the provider's `transacted_at` —
when the charge was made. For a row that has since settled this is *not* the posted date the provider would
report today (nothing local recorded it, and re-fetching a months-old window to learn it is not worth a
request budget), so it is accurate about when the transaction happened and approximate about when it
cleared. A row with no `authorized_date` either has no recoverable date at all and is reported, not guessed
at.

Rows are also re-filed onto the period card for their corrected month, since the card they are on is
labelled with a period that was never real; an emptied period card is then removed, matching the sync's own
rule that a card exists only where rows exist. Initial-import cards span a whole backfill rather than a
month, so rows on one stay put — only the date is wrong there.

    python -m backend.scripts.repair_unposted_sync_dates                  # report only
    python -m backend.scripts.repair_unposted_sync_dates --apply          # write
    python -m backend.scripts.repair_unposted_sync_dates --db other.db
"""

import argparse
import json
import sys
import uuid
from collections import defaultdict
from datetime import date

from backend.db.database import get_db
from backend.routers.import_export.core import make_hash

# The date a zero timestamp produces. Matched exactly rather than by "anything implausibly old": a genuine
# 1969 transaction is not a thing this ledger holds, but a hand-entered typo might be, and re-dating a row
# the user typed themselves is not this script's business.
EPOCH_DATE = "1970-01-01"

SYNC_SOURCE_KIND = "connection_sync"


def _period_cards(conn, connection_id):
    """The connection's period cards, keyed 'YYYY-MM'. Read once: the repair may need several of them and
    may create one, and re-querying per row would make the created ones invisible to each other."""
    rows = conn.execute(
        """
        SELECT id, json_extract(config_snapshot, '$.sync_period') AS period
        FROM   import_batch
        WHERE  connection_id = ? AND source_kind = ?
          AND  json_extract(config_snapshot, '$.sync_period') IS NOT NULL
        """,
        (connection_id, SYNC_SOURCE_KIND),
    ).fetchall()
    return {r["period"]: r["id"] for r in rows}


def _ensure_period_card(conn, connection_id, institution, period, cards, apply):
    """The card for `period`, created if the connection has none. Mirrors `resolve_sync_period_batch` —
    same identity (connection + `sync_period`), same naming — so a card this makes is indistinguishable
    from one the next sync would have made, and the next sync reuses it rather than adding a second."""
    if period in cards:
        return cards[period]
    batch_id = str(uuid.uuid4())
    label = date.fromisoformat(f"{period}-01").strftime("%B %Y")
    if apply:
        conn.execute(
            """
            INSERT INTO import_batch (id, filename, status, source_kind, connection_id, config_snapshot)
            VALUES (?, ?, 'completed', ?, ?, ?)
            """,
            (batch_id, f"{institution} · {label}", SYNC_SOURCE_KIND, connection_id,
             json.dumps({"sync_period": period})),
        )
    cards[period] = batch_id
    return batch_id


def _move_rows(conn, moves, apply):
    """Re-file rows between cards, carrying the per-account tallies the card renders with them.

    `import_batch_account` is the source of a card's account chips and their counts, so moving rows without
    it leaves the origin card claiming rows it no longer holds and the destination silent about the ones it
    gained. The tallies are keyed by the account's source label, which the row itself does not carry — it is
    read from the origin card's own entry for the row's account."""
    for (from_card, to_card), rows in moves.items():
        by_account = defaultdict(int)
        for row in rows:
            by_account[row["account_id"]] += 1
        if not apply:
            continue
        for row in rows:
            conn.execute("UPDATE txn SET import_batch_id = ? WHERE id = ?", (to_card, row["id"]))
        for account_id, n in by_account.items():
            label = conn.execute(
                "SELECT csv_value FROM import_batch_account WHERE batch_id = ? AND account_id = ?",
                (from_card, account_id),
            ).fetchone()
            if not label:
                continue
            conn.execute(
                """
                INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(batch_id, csv_value)
                DO UPDATE SET row_count = row_count + excluded.row_count, account_id = excluded.account_id
                """,
                (to_card, label["csv_value"], account_id, n),
            )
            conn.execute(
                "UPDATE import_batch_account SET row_count = MAX(row_count - ?, 0) "
                "WHERE batch_id = ? AND account_id = ?",
                (n, from_card, account_id),
            )
        conn.execute("UPDATE import_batch SET row_count = row_count + ? WHERE id = ?", (len(rows), to_card))
        conn.execute("UPDATE import_batch SET row_count = MAX(row_count - ?, 0) WHERE id = ?",
                     (len(rows), from_card))


def _drop_emptied_period_cards(conn, leaving, apply):
    """Remove a period card the repair leaves with no transactions. A sync card records a fetch, not a file,
    so an empty one is not evidence of anything — and one labelled for a period that never happened is the
    artifact this whole script exists to remove. CSV cards are untouched: those record a file, which stays
    true after its rows are gone.

    `leaving` maps a card to how many rows are moving off it, so the same arithmetic answers the question
    before the move as after it — the dry run has to report the card removal it would perform, and reading
    the row count alone would only ever see the pre-move state."""
    dropped = []
    for card_id, moving_off in leaving.items():
        held = conn.execute(
            "SELECT COUNT(*) n FROM txn WHERE import_batch_id = ?", (card_id,)
        ).fetchone()["n"]
        if held - (0 if apply else moving_off) > 0:
            continue
        row = conn.execute("SELECT filename FROM import_batch WHERE id = ?", (card_id,)).fetchone()
        if not row:
            continue
        dropped.append(row["filename"])
        if apply:
            conn.execute("DELETE FROM import_batch WHERE id = ?", (card_id,))
    return dropped


def repair(conn, apply=False):
    rows = conn.execute(
        """
        SELECT t.id, t.date, t.authorized_date, t.amount, t.merchant_name, t.raw_name, t.account_id,
               t.import_batch_id, b.connection_id, b.filename AS card_name,
               json_extract(b.config_snapshot, '$.sync_period') AS card_period,
               c.institution, c.provider
        FROM   txn t
        JOIN   import_batch b ON b.id = t.import_batch_id
        LEFT   JOIN connection c ON c.id = b.connection_id
        WHERE  t.date = ? AND b.source_kind = ?
        ORDER BY t.rowid
        """,
        (EPOCH_DATE, SYNC_SOURCE_KIND),
    ).fetchall()

    repaired, unrecoverable = [], []
    moves = defaultdict(list)
    cards_by_connection = {}
    leaving = defaultdict(int)

    for row in rows:
        if not row["authorized_date"]:
            unrecoverable.append(row)
            continue
        new_date = row["authorized_date"]
        if apply:
            conn.execute(
                "UPDATE txn SET date = ?, content_hash = ? WHERE id = ?",
                (new_date, make_hash(new_date, row["amount"],
                                     row["raw_name"] or row["merchant_name"] or ""), row["id"]),
            )
        repaired.append((row, new_date))

        # Only a *period* card can be on the wrong one; an initial-import card holds a whole backfill and
        # says nothing about a month. A period card whose label already matches the corrected month needs
        # no move either — which is what makes a second run of this script a no-op rather than a shuffle.
        period = new_date[:7]
        if not row["card_period"] or row["card_period"] == period or not row["connection_id"]:
            continue
        connection_id = row["connection_id"]
        if connection_id not in cards_by_connection:
            cards_by_connection[connection_id] = _period_cards(conn, connection_id)
        institution = row["institution"] or row["provider"] or "Data source"
        target = _ensure_period_card(conn, connection_id, institution, period,
                                     cards_by_connection[connection_id], apply)
        moves[(row["import_batch_id"], target)].append(row)
        leaving[row["import_batch_id"]] += 1

    _move_rows(conn, moves, apply)
    dropped = _drop_emptied_period_cards(conn, leaving, apply)
    return repaired, unrecoverable, moves, dropped


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--db", help="database file (defaults to the app's own DB_PATH resolution)")
    parser.add_argument("--apply", action="store_true",
                        help="write the repair; without it the script only reports what it would do")
    args = parser.parse_args(argv)

    with get_db(args.db) as conn:
        repaired, unrecoverable, moves, dropped = repair(conn, apply=args.apply)
        if not repaired and not unrecoverable:
            print(f"Nothing to repair: no synced transactions dated {EPOCH_DATE}.")
            return 0
        print(f"{'Repaired' if args.apply else 'Would repair'} {len(repaired)} transaction(s) "
              f"dated {EPOCH_DATE}:")
        for row, new_date in repaired:
            print(f"  {row['id']}  {EPOCH_DATE} → {new_date}  {row['merchant_name'] or row['raw_name'] or ''}")
        moved = sum(len(v) for v in moves.values())
        if moved:
            print(f"{'Moved' if args.apply else 'Would move'} {moved} row(s) onto the card for their "
                  f"corrected month.")
        for name in dropped:
            print(f"{'Removed' if args.apply else 'Would remove'} the emptied card: {name}")
        for row in unrecoverable:
            print(f"  UNRECOVERABLE {row['id']} — no authorized_date to date it from; left as is "
                  f"({row['merchant_name'] or row['raw_name'] or ''})")
        if not args.apply:
            print("\nDry run — nothing was written. Re-run with --apply to make these changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
