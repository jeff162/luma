"""
Suspect-duplicate detection coverage.

These tests exercise the service functions in `backend/services/duplicate_detection.py`
directly so each branch of the detection logic (cross-account match, payee normalization,
trash exclusion, account_pair_distinct filtering, promote-on-merge) and the two resolution
paths (keep / trash) can be asserted without standing up a full CSV import for every case.
The functions take a raw connection, so the setup builds the minimum schema state needed
for each scenario.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.accounts import attach_account, detach_account, AccountAttachRequest
from backend.services.duplicate_detection import (
    clear_account_pair_distinct_for_merge,
    count_active_suspects,
    forget_account_pair_distinct,
    list_distinct_account_pairs,
    list_suspects,
    mark_import_suspects,
    promote_in_group_suspects_to_confirmed,
    resolve_suspect,
    scan_scope_for_cross_account_duplicates,
    restore_auto_merged_after_detach,
    restore_rejected_duplicate,
)


class SuspectDuplicateTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "suspect-duplicates.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    # ---- factory helpers -------------------------------------------------

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype,
                       mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'credit', 'credit_card', NULL, ?, NULL, NULL)
                    """,
                    (account_id, f"plaid_{account_id}", "fixture", name, name, SHARED_OWNER_ID),
                )
        return account_id

    def _insert_batch(self, *, filename: str = "fixture.csv") -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO import_batch (id, filename, status, row_count, skipped_count, deduped_count)
                    VALUES (?, ?, 'completed', 0, 0, 0)
                    """,
                    (batch_id, filename),
                )
        return batch_id

    def _insert_txn(
        self,
        *,
        account_id: str,
        date: str,
        amount: float,
        merchant_name: str,
        display_name: str | None = None,
        raw_name: str | None = None,
        batch_id: str | None = None,
        trashed_at: str | None = None,
        import_evidence_json: str | None = None,
    ) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                       date, is_pending, import_batch_id, trashed_at, import_evidence_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                    """,
                    (
                        txn_id,
                        account_id,
                        SHARED_OWNER_ID,
                        amount,
                        merchant_name,
                        display_name or merchant_name,
                        raw_name or merchant_name,
                        date,
                        batch_id,
                        trashed_at,
                        import_evidence_json,
                    ),
                )
        return txn_id

    def _suspect_link(self, txn_id: str) -> dict | None:
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    """
                    SELECT id, suspect_duplicate_of, suspect_duplicate_reason,
                           suspect_resolved_at, trashed_at, rejection_reason,
                           dedupe_resolved_by
                    FROM   txn
                    WHERE  id = ?
                    """,
                    (txn_id,),
                ).fetchone()
                return dict(row) if row else None

    def _insert_category(self, name: str) -> str:
        cat_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, NULL, ?, 'expense', 0)",
                    (cat_id, name),
                )
        return cat_id

    def _set_txn_category(self, txn_id: str, category_id: str | None) -> None:
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE txn SET category_id = ? WHERE id = ?", (category_id, txn_id))

    def _set_batch_uses_categories(self, batch_id: str, value: bool) -> None:
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE import_batch SET use_imported_categories = ? WHERE id = ?",
                    (1 if value else 0, batch_id),
                )

    def _txn_category(self, txn_id: str) -> dict | None:
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    "SELECT category_id, category_overridden, category_source FROM txn WHERE id = ?",
                    (txn_id,),
                ).fetchone()
                return dict(row) if row else None

    # ---- import-time detection ------------------------------------------

    def test_import_flags_cross_account_match(self):
        # Account A exists with a prior transaction; a cross-batch row on Account B in the new
        # import matches A's row on (date, amount, normalized payee). Per-pair-distinct model:
        # the cross-account suspect check runs for all batch rows regardless of whether the
        # receiving account is brand new — no precondition gate.
        account_a = self._insert_account("Chase")
        account_b = self._insert_account("Credit Card ...6612")
        batch = self._insert_batch()

        existing_id = self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="OUTDOOR GEAR CO",
        )
        new_id = self._insert_txn(
            account_id=account_b,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="Outdoor Gear Co",  # case-insensitive match
            batch_id=batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)

        self.assertEqual(marked, 1)
        link = self._suspect_link(new_id)
        self.assertEqual(link["suspect_duplicate_of"], existing_id)
        self.assertEqual(link["suspect_duplicate_reason"], "cross_account")

        # The original (existing) row stays unflagged — only the new arrival gets the badge.
        existing_link = self._suspect_link(existing_id)
        self.assertIsNone(existing_link["suspect_duplicate_of"])

    def test_import_flags_cross_account_match_even_when_receiving_account_has_prior_history(self):
        # The brand-new-account gate was removed in the per-pair-distinct model. The check now
        # runs unconditionally; the receiving account having prior history is no longer a
        # reason to skip cross-account suspect detection. The `account_pair_distinct` table is
        # what keeps the output non-noisy after the user has reviewed pairs.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        prior_batch = self._insert_batch(filename="prior.csv")
        new_batch = self._insert_batch(filename="new.csv")

        existing_match_id = self._insert_txn(
            account_id=account_b,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
        )
        # Earlier import already populated account A — receiving account is NOT brand new.
        self._insert_txn(
            account_id=account_a,
            date="2024-01-01",
            amount=-12.00,
            merchant_name="OTHER",
            batch_id=prior_batch,
        )
        # New import adds another row on account A that matches B's existing row.
        new_id = self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            batch_id=new_batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, new_batch)

        self.assertEqual(marked, 1, "Should flag regardless of receiving-account history")
        self.assertEqual(self._suspect_link(new_id)["suspect_duplicate_of"], existing_match_id)
        self.assertEqual(self._suspect_link(new_id)["suspect_duplicate_reason"], "cross_account")

    def test_import_skips_when_existing_match_is_trashed(self):
        # A trashed row shouldn't anchor a new suspect — once you've decided it's gone, the
        # incoming row is the only live copy.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()

        self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            trashed_at="2026-05-01T00:00:00Z",
        )
        new_id = self._insert_txn(
            account_id=account_b,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            batch_id=batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)

        self.assertEqual(marked, 0)
        self.assertIsNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_import_does_not_flag_same_account_duplicate(self):
        # Exact same account + date + amount + payee is the *normal* duplicate the import-level
        # dedup catches. The soft check only cares about different accounts.
        account_a = self._insert_account("Account A")
        batch = self._insert_batch()
        self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
        )
        new_id = self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="MERCHANT",
            batch_id=batch,
        )

        # Same-account match is the responsibility of the hard-reject path (the
        # `import_batch_duplicate` table); the soft check requires `t2.account_id != t1.account_id`
        # so it must never flag a same-account match even though the cross-account check now runs
        # unconditionally for every batch row.
        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)

        self.assertEqual(marked, 0)
        self.assertIsNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_import_does_not_re_flag_existing_suspect(self):
        # An already-flagged row shouldn't get re-flagged when the import sweep runs again
        # (which it does for the "force import these duplicates" pathway).
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        existing = self._insert_txn(
            account_id=account_a, date="2025-10-30", amount=-10.00, merchant_name="X"
        )
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-10.00, merchant_name="X", batch_id=batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                first_pass = mark_import_suspects(conn, batch)
                second_pass = mark_import_suspects(conn, batch)

        self.assertEqual(first_pass, 1)
        self.assertEqual(second_pass, 0)
        self.assertEqual(self._suspect_link(new_id)["suspect_duplicate_of"], existing)

    def test_import_does_not_flag_same_batch_different_account(self):
        # Within a single import file, the account column is trusted: two rows on different
        # accounts on the same date for the same amount and payee are distinct transactions
        # (the canonical case being a single real-world purchase that was split across two
        # cards). Even when one of the receiving accounts is brand new, the same-batch sibling
        # row must not be the anchor for a suspect flag — there is no pre-existing match.
        account_existing = self._insert_account("Riverstone")
        account_new = self._insert_account("Checking")
        prior_batch = self._insert_batch(filename="prior.csv")
        new_batch = self._insert_batch(filename="new.csv")

        # Prior history on the existing account so it is well-established before the new
        # batch arrives. The per-pair-distinct model no longer gates on "brand-new" status,
        # but keeping the prior row makes the scenario realistic and matches the design
        # intent: two cards in one statement file are trusted as distinct.
        self._insert_txn(
            account_id=account_existing,
            date="2024-01-01",
            amount=-12.00,
            merchant_name="OTHER",
            batch_id=prior_batch,
        )

        existing_side = self._insert_txn(
            account_id=account_existing,
            date="2026-03-16",
            amount=-19.87,
            merchant_name="Amazon",
            batch_id=new_batch,
        )
        new_side = self._insert_txn(
            account_id=account_new,
            date="2026-03-16",
            amount=-19.87,
            merchant_name="Amazon",
            batch_id=new_batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, new_batch)

        self.assertEqual(marked, 0)
        self.assertIsNone(self._suspect_link(existing_side)["suspect_duplicate_of"])
        self.assertIsNone(self._suspect_link(new_side)["suspect_duplicate_of"])

    def test_import_flags_match_from_prior_batch(self):
        # Cross-batch flagging works regardless of whether the anchor row was inserted manually
        # (import_batch_id IS NULL) or came from a previous batch (import_batch_id != current).
        # The existing flags_match_when_receiving_account_is_new test covers the manual-anchor
        # path; this one closes the gap on the prior-batch path so future SQL changes can't
        # silently regress one without the other.
        account_a = self._insert_account("Prior-side account")
        account_b = self._insert_account("New-side account")
        prior_batch = self._insert_batch(filename="prior.csv")
        new_batch = self._insert_batch(filename="new.csv")

        existing_id = self._insert_txn(
            account_id=account_a,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="OUTDOOR GEAR CO",
            batch_id=prior_batch,
        )
        new_id = self._insert_txn(
            account_id=account_b,
            date="2025-10-30",
            amount=-68.00,
            merchant_name="Outdoor Gear Co",
            batch_id=new_batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, new_batch)

        self.assertEqual(marked, 1)
        link = self._suspect_link(new_id)
        self.assertEqual(link["suspect_duplicate_of"], existing_id)
        self.assertEqual(link["suspect_duplicate_reason"], "cross_account")

    def test_import_flags_cross_account_match_via_original_statement_evidence(self):
        # The motivating regression: a data-connection (Plaid) row carries the raw bank descriptor in
        # raw_name ("COUNTRY CREAMERY & COFFE", truncated), while a CSV importer cleaned raw_name to the
        # merchant column ("Country Creamery & Coffee", two e's) and kept the true statement only in an
        # "Original Statement" evidence field. The OLD matcher keyed on merchant_name and saw "coffe" !=
        # "coffee" — a miss. The union-of-source-texts matcher compares the CSV's evidence statement
        # against the Plaid raw_name, finds them byte-identical, and flags an EXACT cross_account match.
        csv_account = self._insert_account("Northgate Rewards (CSV)")
        sync_account = self._insert_account("Northgate Rewards (Plaid)")
        csv_batch = self._insert_batch(filename="monarch.csv")
        sync_batch = self._insert_batch(filename="Chase · Initial import")

        evidence = json.dumps({
            "account": {"header": "Account", "value": "Northgate Rewards"},
            "description": {"header": "Merchant", "value": "Country Creamery & Coffee"},
            "extra_text_fields": [{"header": "Original Statement", "value": "COUNTRY CREAMERY & COFFE"}],
        })
        existing_id = self._insert_txn(
            account_id=csv_account, date="2026-07-03", amount=-7.75,
            merchant_name="Country Creamery & Coffee", raw_name="Country Creamery & Coffee",
            batch_id=csv_batch, import_evidence_json=evidence,
        )
        # The synced row: two days later (posted vs. transaction date), truncated provider text, no evidence.
        new_id = self._insert_txn(
            account_id=sync_account, date="2026-07-05", amount=-7.75,
            merchant_name="Country Creamery & Coffe", raw_name="COUNTRY CREAMERY & COFFE",
            batch_id=sync_batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, sync_batch)

        self.assertEqual(marked, 1)
        link = self._suspect_link(new_id)
        self.assertEqual(link["suspect_duplicate_of"], existing_id)
        # Byte-identical raw descriptor → the high-confidence EXACT tier, not fuzzy.
        self.assertEqual(link["suspect_duplicate_reason"], "cross_account")

    def test_import_flags_fuzzy_cross_account_match_as_review_only(self):
        # Same amount + within the date window, but the source texts differ by a single character and
        # neither side captured the other's exact spelling (no evidence to bridge them). That is the
        # FUZZY tier: flagged for review under a distinct reason, never treated as a certain match.
        csv_account = self._insert_account("CSV account")
        sync_account = self._insert_account("Plaid account")
        csv_batch = self._insert_batch(filename="export.csv")
        sync_batch = self._insert_batch(filename="Chase · August 2026")

        existing_id = self._insert_txn(
            account_id=csv_account, date="2026-07-03", amount=-7.75,
            merchant_name="Country Creamery & Coffee", raw_name="Country Creamery & Coffee",
            batch_id=csv_batch,
        )
        new_id = self._insert_txn(
            account_id=sync_account, date="2026-07-05", amount=-7.75,
            merchant_name="Country Creamery & Coffe", raw_name="COUNTRY CREAMERY & COFFE",
            batch_id=sync_batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, sync_batch)

        self.assertEqual(marked, 1)
        link = self._suspect_link(new_id)
        self.assertEqual(link["suspect_duplicate_of"], existing_id)
        self.assertEqual(link["suspect_duplicate_reason"], "cross_account_fuzzy")

    def test_import_does_not_fuzzy_match_distinct_check_numbers(self):
        # Two genuinely different checks share amount + date + "Check #" and differ by a single digit
        # ("#1042" vs "#1043") — close enough to trip the fuzzy ratio. The check-number discriminator
        # must veto the pair so distinct checks are never flagged as duplicates.
        account_a = self._insert_account("Checking A")
        account_b = self._insert_account("Checking B")
        prior_batch = self._insert_batch(filename="prior.csv")
        new_batch = self._insert_batch(filename="new.csv")

        self._insert_txn(
            account_id=account_a, date="2026-07-03", amount=-50.00,
            merchant_name="Check #1042", batch_id=prior_batch,
        )
        new_id = self._insert_txn(
            account_id=account_b, date="2026-07-03", amount=-50.00,
            merchant_name="Check #1043", batch_id=new_batch,
        )

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, new_batch)

        self.assertEqual(marked, 0)
        self.assertIsNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_merge_does_not_auto_confirm_fuzzy_suspect(self):
        # A FUZZY cross-account soft-flag is review-only: merging the two accounts must NOT silently
        # trash it (that is reserved for the byte-identical exact tier). The flag survives the promote
        # sweep so the user still decides. Contrast test_attach_promotes_in_group_suspects_to_confirmed,
        # which promotes an exact 'cross_account' flag.
        parent = self._insert_account("Parent")
        child_existing = self._insert_account("Child Existing")
        child_new = self._insert_account("Child New")

        existing_id = self._insert_txn(account_id=child_existing, date="2026-07-03", amount=-7.75, merchant_name="Country Creamery & Coffee")
        new_id = self._insert_txn(account_id=child_new, date="2026-07-05", amount=-7.75, merchant_name="Country Creamery & Coffe")

        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, child_existing))
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account_fuzzy' WHERE id = ?",
                    (existing_id, new_id),
                )
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, child_new))
                promoted = promote_in_group_suspects_to_confirmed(conn, [child_new, child_existing, parent])

        self.assertEqual(promoted, 0, "fuzzy suspects must not be auto-confirmed on merge")
        link = self._suspect_link(new_id)
        self.assertIsNone(link["trashed_at"])
        self.assertIsNone(link["rejection_reason"])
        # Still an active suspect awaiting the user's review.
        self.assertEqual(link["suspect_duplicate_of"], existing_id)
        self.assertEqual(link["suspect_duplicate_reason"], "cross_account_fuzzy")

    # ---- account-merge-time behavior ------------------------------------

    # NOTE: in the per-pair-distinct model, merge-time soft-flag CREATION is intentionally
    # absent. Detection happens at import time only; merge's contribution is to (a) promote
    # pre-existing soft-flags between the now-grouped accounts to confirmed duplicates via
    # `promote_in_group_suspects_to_confirmed`, and (b) delete any `account_pair_distinct`
    # row between the merging accounts (the merge contradicts the "distinct" assertion).
    # Tests for those two behaviors live below.

    # ---- list / count / resolve -----------------------------------------

    def test_list_and_count_only_return_unresolved(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                pairs_before = list_suspects(conn)
                count_before = count_active_suspects(conn)
                resolve_suspect(conn, new_id, action="keep")
                pairs_after = list_suspects(conn)
                count_after = count_active_suspects(conn)

        self.assertEqual(count_before, 1)
        self.assertEqual(len(pairs_before), 1)
        self.assertEqual(pairs_before[0]["new_id"], new_id)
        self.assertEqual(count_after, 0)
        self.assertEqual(pairs_after, [])

    def test_resolve_keep_clears_flag_and_leaves_row(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                result = resolve_suspect(conn, new_id, action="keep")

        self.assertEqual(result, {"resolved": True, "action": "keep"})
        link = self._suspect_link(new_id)
        self.assertIsNone(link["suspect_duplicate_of"])
        self.assertIsNone(link["suspect_duplicate_reason"])
        self.assertIsNotNone(link["suspect_resolved_at"])
        # 'keep' must NOT trash the row.
        self.assertIsNone(link["trashed_at"])

    def test_resolve_reject_routes_to_confirmed_duplicate_pool(self):
        # 'reject' (and its back-compat alias 'trash') confirms the suspect as a real duplicate
        # and routes it into the rejected-duplicates pool — `trashed_at` is set so it leaves the
        # active ledger, and `rejection_reason='duplicate_confirmed'` distinguishes it from a
        # user-driven trash. The unified report uses that discriminator to surface confirmed
        # soft-flags alongside import-time hard-rejects.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                result = resolve_suspect(conn, new_id, action="reject")

        self.assertEqual(result, {"resolved": True, "action": "reject"})
        link = self._suspect_link(new_id)
        self.assertIsNotNone(link["trashed_at"])
        self.assertIsNotNone(link["suspect_resolved_at"])
        self.assertEqual(link["rejection_reason"], "duplicate_confirmed")
        # The suspect_duplicate_of pointer is kept as an audit trail of which row was accepted
        # as the canonical copy.
        self.assertIsNotNone(link["suspect_duplicate_of"])

    def test_resolve_trash_is_alias_for_reject(self):
        # The 'trash' action name is preserved as a back-compat alias of 'reject' so the existing
        # API and the SuspectDuplicates page keep working without changes.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                result = resolve_suspect(conn, new_id, action="trash")

        # Same outcome whether the caller said 'reject' or 'trash'.
        self.assertEqual(result["resolved"], True)
        link = self._suspect_link(new_id)
        self.assertEqual(link["rejection_reason"], "duplicate_confirmed")

    def test_resolve_invalid_action(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                result = resolve_suspect(conn, new_id, action="bogus")
        self.assertFalse(result["resolved"])
        self.assertEqual(result["reason"], "invalid_action")
        # Original flag is preserved.
        self.assertIsNotNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_resolve_rejects_non_suspect_row(self):
        account_a = self._insert_account("Account A")
        txn = self._insert_txn(
            account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X"
        )
        with self._use_db_path():
            with get_db() as conn:
                result = resolve_suspect(conn, txn, action="trash")
        self.assertEqual(result, {"resolved": False, "reason": "not_suspect"})

    def test_restore_rejected_duplicate_round_trip(self):
        # User reviews a soft-flag, decides it's a real duplicate (reject), then changes their
        # mind. restore_rejected_duplicate should put the row back in the active ledger and
        # clear the rejection flag.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                resolve_suspect(conn, new_id, action="reject")
                restored = restore_rejected_duplicate(conn, new_id)

        self.assertEqual(restored, {"restored": True})
        link = self._suspect_link(new_id)
        self.assertIsNone(link["trashed_at"])
        self.assertIsNone(link["rejection_reason"])

    def test_replace_keeps_incoming_row_and_removes_existing(self):
        # 'replace' is the inverse survivor of 'reject': the incoming (new-file) row stays in the
        # ledger (it carries the account the user trusts) and the EXISTING matched row is removed
        # as a confirmed duplicate, its audit pointer flipped to the incoming row so its own
        # batch's report can still surface and Restore it. No account_pair_distinct is written.
        existing_acct = self._insert_account("Legacy Card")
        incoming_acct = self._insert_account("Cashback Card")
        existing_batch = self._insert_batch(filename="legacy_export.csv")
        incoming_batch = self._insert_batch(filename="card_statement.csv")
        existing_id = self._insert_txn(
            account_id=existing_acct, date="2023-10-30", amount=68.00, merchant_name="OUTDOOR CO", batch_id=existing_batch,
        )
        incoming_id = self._insert_txn(
            account_id=incoming_acct, date="2023-10-30", amount=68.00, merchant_name="Outdoor Co", batch_id=incoming_batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (existing_id, incoming_id),
                )
                result = resolve_suspect(conn, incoming_id, action="replace")
        self.assertEqual(result, {"resolved": True, "action": "replace"})
        # Incoming survives with its suspect flag cleared.
        inc = self._suspect_link(incoming_id)
        self.assertIsNone(inc["trashed_at"])
        self.assertIsNone(inc["suspect_duplicate_of"])
        self.assertIsNone(inc["rejection_reason"])
        # Existing removed as a confirmed duplicate, pointing at the incoming row that replaced it.
        ex = self._suspect_link(existing_id)
        self.assertIsNotNone(ex["trashed_at"])
        self.assertEqual(ex["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(ex["dedupe_resolved_by"], "user")
        self.assertEqual(ex["suspect_duplicate_of"], incoming_id)
        # No "accounts are distinct" assertion is recorded (replace means "same transaction").
        with self._use_db_path():
            with get_db() as conn:
                pairs = conn.execute("SELECT COUNT(*) AS n FROM account_pair_distinct").fetchone()
        self.assertEqual(pairs["n"], 0)

    def test_replace_category_follows_use_imported_categories_flag(self):
        # The surviving (incoming) row keeps its OWN category only when the incoming file is the
        # sole file flagged to use imported categories; otherwise it adopts the existing row's
        # category (existing-only, and the both/neither tie) as a manual override. A NULL existing
        # category is never copied — we don't downgrade a categorized row to uncategorized.
        existing_cat = self._insert_category("Recreation")
        incoming_cat = self._insert_category("Shopping")

        def run(*, incoming_uses, existing_uses, existing_cat_id=existing_cat):
            ea = self._insert_account(f"ex-{uuid.uuid4()}")
            ia = self._insert_account(f"in-{uuid.uuid4()}")
            eb = self._insert_batch()
            ib = self._insert_batch()
            self._set_batch_uses_categories(eb, existing_uses)
            self._set_batch_uses_categories(ib, incoming_uses)
            eid = self._insert_txn(account_id=ea, date="2023-10-30", amount=68.0, merchant_name="X", batch_id=eb)
            iid = self._insert_txn(account_id=ia, date="2023-10-30", amount=68.0, merchant_name="X", batch_id=ib)
            self._set_txn_category(eid, existing_cat_id)
            self._set_txn_category(iid, incoming_cat)
            with self._use_db_path():
                with get_db() as conn:
                    conn.execute(
                        "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                        (eid, iid),
                    )
                    resolve_suspect(conn, iid, action="replace")
            return self._txn_category(iid)

        # Incoming is the sole categorization file → keep its own category, no override.
        c = run(incoming_uses=True, existing_uses=False)
        self.assertEqual(c["category_id"], incoming_cat)

        # Existing is the sole categorization file → adopt its category as a manual override.
        c = run(incoming_uses=False, existing_uses=True)
        self.assertEqual(c["category_id"], existing_cat)
        self.assertEqual(c["category_overridden"], 1)
        self.assertEqual(c["category_source"], "manual")

        # Both checked → tie → existing wins.
        self.assertEqual(run(incoming_uses=True, existing_uses=True)["category_id"], existing_cat)
        # Neither checked → tie → existing wins.
        self.assertEqual(run(incoming_uses=False, existing_uses=False)["category_id"], existing_cat)
        # Adopt-existing case but existing has no category → never downgrade: keep incoming's.
        self.assertEqual(
            run(incoming_uses=False, existing_uses=True, existing_cat_id=None)["category_id"],
            incoming_cat,
        )

    def test_attach_promotes_in_group_suspects_to_confirmed(self):
        # A soft-flag existed between two accounts before they were merged into a single linked
        # group. After the merge, the flag's "cross-account" premise is invalidated — the user
        # just declared the two accounts as the same physical account. The promote sweep should
        # auto-resolve the flag as a confirmed duplicate, matching what the unified report's
        # 'Reject' action would do.
        parent = self._insert_account("Parent")
        child_existing = self._insert_account("Child Existing")
        child_new = self._insert_account("Child New")

        existing_id = self._insert_txn(account_id=child_existing, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(account_id=child_new, date="2025-10-30", amount=-68.00, merchant_name="X")

        with self._use_db_path():
            with get_db() as conn:
                # Pre-merge: child_existing already in the parent group, child_new independent.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, child_existing))
                # Plant the soft-flag as mark_import_suspects would have done at import time.
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (existing_id, new_id),
                )
                # Now perform the merge: child_new joins the parent group.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, child_new))
                promoted = promote_in_group_suspects_to_confirmed(conn, [child_new, child_existing, parent])

        self.assertEqual(promoted, 1)
        link = self._suspect_link(new_id)
        self.assertIsNotNone(link["trashed_at"])
        self.assertEqual(link["rejection_reason"], "duplicate_confirmed")
        self.assertIsNotNone(link["suspect_resolved_at"])
        # Audit pointer stays so the user can see what the flag matched and Restore if needed.
        self.assertEqual(link["suspect_duplicate_of"], existing_id)

    def test_attach_promotes_ignores_suspects_outside_the_group(self):
        # A soft-flag between two accounts that are NOT becoming part of the newly-merged group
        # should not be touched. The promote sweep is strictly scoped to flags whose endpoints
        # are now both in the same linked group as the freshly-attached accounts.
        parent = self._insert_account("Parent")
        child_in_group = self._insert_account("Child In Group")
        outside_a = self._insert_account("Outside A")
        outside_b = self._insert_account("Outside B")

        outside_existing = self._insert_txn(account_id=outside_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        outside_suspect = self._insert_txn(account_id=outside_b, date="2025-10-30", amount=-68.00, merchant_name="X")

        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, child_in_group))
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (outside_existing, outside_suspect),
                )
                # Promote sweep runs for the group containing parent + child_in_group; outside_a
                # and outside_b are not in that group.
                promoted = promote_in_group_suspects_to_confirmed(conn, [child_in_group, parent])

        self.assertEqual(promoted, 0)
        link = self._suspect_link(outside_suspect)
        self.assertIsNone(link["trashed_at"])
        self.assertIsNone(link["rejection_reason"])
        self.assertEqual(link["suspect_duplicate_of"], outside_existing)

    def test_restore_rejected_duplicate_refuses_non_rejected_rows(self):
        # A normal (non-rejected) txn or a user-trashed row should not be restorable via this
        # endpoint — it would lose semantics ("restore from what?").
        account_a = self._insert_account("Account A")
        normal_id = self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                result = restore_rejected_duplicate(conn, normal_id)
        self.assertEqual(result, {"restored": False, "reason": "not_rejected"})

    # ---- per-pair-distinct model: Keep broad-assertion + filtering ------
    # These tests pin the user-visible semantics of the per-pair-distinct dedupe model:
    #   1. resolve_suspect('keep') records the pair in `account_pair_distinct`.
    #   2. resolve_suspect('keep') CASCADES to every other unresolved suspect between the
    #      same pair (broad reading: "these accounts are distinct" not "this row is distinct").
    #   3. mark_import_suspects skips any pair already recorded in account_pair_distinct.
    #   4. forget_account_pair_distinct erases the assertion; the next import re-evaluates.
    #   5. clear_account_pair_distinct_for_merge erases entries between merging accounts.
    #   6. resolve_suspect('reject') does NOT record the pair (a rejection is row-scoped:
    #      "yes, that one IS a duplicate" tells us nothing about the accounts being distinct).

    def test_resolve_keep_records_account_pair_in_distinct_table(self):
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                resolve_suspect(conn, new_id, action="keep")
                pairs = list_distinct_account_pairs(conn)

        self.assertEqual(len(pairs), 1)
        # Pair stored canonically with lower id in account_id_low.
        low, high = sorted([account_a, account_b])
        self.assertEqual(pairs[0]["account_id_low"], low)
        self.assertEqual(pairs[0]["account_id_high"], high)
        self.assertIsNotNone(pairs[0]["asserted_at"])

    def test_resolve_keep_cascades_to_other_unresolved_suspects_on_same_pair(self):
        # Broad-reading Keep: clicking Keep on ONE suspect between (A, B) clears EVERY other
        # unresolved suspect between (A, B). The user shouldn't have to click Keep N times
        # for N coincidences when one click conveys "these two accounts are distinct".
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        # Three independent matches between the same pair: clicking Keep on the first should
        # cascade-resolve the other two.
        canonical_1 = self._insert_txn(account_id=account_a, date="2025-10-01", amount=-10.00, merchant_name="P1")
        canonical_2 = self._insert_txn(account_id=account_a, date="2025-10-02", amount=-20.00, merchant_name="P2")
        canonical_3 = self._insert_txn(account_id=account_a, date="2025-10-03", amount=-30.00, merchant_name="P3")
        suspect_1 = self._insert_txn(account_id=account_b, date="2025-10-01", amount=-10.00, merchant_name="P1", batch_id=batch)
        suspect_2 = self._insert_txn(account_id=account_b, date="2025-10-02", amount=-20.00, merchant_name="P2", batch_id=batch)
        suspect_3 = self._insert_txn(account_id=account_b, date="2025-10-03", amount=-30.00, merchant_name="P3", batch_id=batch)

        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)
                self.assertEqual(marked, 3)
                # Click Keep on ONLY one — the other two should follow.
                resolve_suspect(conn, suspect_1, action="keep")

        for sid in (suspect_1, suspect_2, suspect_3):
            link = self._suspect_link(sid)
            self.assertIsNone(link["suspect_duplicate_of"],
                              f"suspect {sid} should be cascade-resolved by broad Keep")
            self.assertIsNone(link["suspect_duplicate_reason"])
            self.assertIsNotNone(link["suspect_resolved_at"])
            # Cascade must NOT trash anything.
            self.assertIsNone(link["trashed_at"])
        # Canonical rows are never touched.
        for cid in (canonical_1, canonical_2, canonical_3):
            link = self._suspect_link(cid)
            self.assertIsNone(link["suspect_duplicate_of"])
            self.assertIsNone(link["trashed_at"])

    def test_resolve_keep_cascade_is_scoped_to_the_specific_pair(self):
        # Cascade should ONLY touch suspects whose endpoints match the (A, B) pair being kept,
        # not suspects involving other accounts (even when those other suspects share the
        # same date/amount/payee or one of the same endpoints).
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        account_c = self._insert_account("Account C")
        batch = self._insert_batch()

        canonical_ab = self._insert_txn(account_id=account_a, date="2025-10-01", amount=-10.00, merchant_name="X")
        suspect_ab   = self._insert_txn(account_id=account_b, date="2025-10-01", amount=-10.00, merchant_name="X", batch_id=batch)
        # An unrelated suspect involving account C, sharing endpoint A but NOT the (A, B) pair.
        canonical_ac = self._insert_txn(account_id=account_a, date="2025-10-02", amount=-20.00, merchant_name="Y")
        suspect_ac   = self._insert_txn(account_id=account_c, date="2025-10-02", amount=-20.00, merchant_name="Y", batch_id=batch)

        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                resolve_suspect(conn, suspect_ab, action="keep")

        # (A, B) suspect is cleared.
        self.assertIsNone(self._suspect_link(suspect_ab)["suspect_duplicate_of"])
        # (A, C) suspect is UNTOUCHED — different pair, different assertion required.
        ac_link = self._suspect_link(suspect_ac)
        self.assertEqual(ac_link["suspect_duplicate_of"], canonical_ac)
        self.assertEqual(ac_link["suspect_duplicate_reason"], "cross_account")

    def test_mark_import_suspects_skips_pair_already_in_distinct_table(self):
        # Once the user asserts (A, B) distinct, the cross-account check must not surface
        # new candidates between A and B on subsequent imports — even when the (date, amount,
        # payee) match is genuine. That's what makes the broad Keep sustainable.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        first_batch = self._insert_batch(filename="first.csv")
        # Plant the distinct assertion before the import sweep runs.
        with self._use_db_path():
            with get_db() as conn:
                low, high = sorted([account_a, account_b])
                conn.execute(
                    """
                    INSERT INTO account_pair_distinct
                      (account_id_low, account_id_high, asserted_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    """,
                    (low, high),
                )
        # Existing row on A, new import row on B that would have matched.
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=first_batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, first_batch)

        self.assertEqual(marked, 0, "Pair was declared distinct — no flag should be raised")
        self.assertIsNone(self._suspect_link(new_id)["suspect_duplicate_of"])

    def test_forget_account_pair_distinct_re_enables_detection(self):
        # The management UI lets the user undo a prior "these accounts are distinct" assertion.
        # After forgetting, the next import touching the pair must re-surface fresh suspects.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        first_batch = self._insert_batch(filename="first.csv")
        second_batch = self._insert_batch(filename="second.csv")
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        suspect = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=first_batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, first_batch)
                resolve_suspect(conn, suspect, action="keep")
                self.assertEqual(len(list_distinct_account_pairs(conn)), 1)

                # User forgets the assertion.
                result = forget_account_pair_distinct(conn, account_a, account_b)
                self.assertEqual(result, {"deleted": 1})
                self.assertEqual(list_distinct_account_pairs(conn), [])

        # A new import arrives — fresh match between A and B should surface again.
        canonical_new = self._insert_txn(account_id=account_a, date="2025-11-15", amount=-99.00, merchant_name="Y")
        suspect_new = self._insert_txn(
            account_id=account_b, date="2025-11-15", amount=-99.00, merchant_name="Y", batch_id=second_batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, second_batch)

        self.assertEqual(marked, 1)
        self.assertEqual(self._suspect_link(suspect_new)["suspect_duplicate_of"], canonical_new)

    def test_forget_account_pair_distinct_is_order_independent(self):
        # The pair is stored canonically (low_id, high_id); forget should accept the ids in
        # either order so callers don't need to know the canonical orientation.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        with self._use_db_path():
            with get_db() as conn:
                low, high = sorted([account_a, account_b])
                conn.execute(
                    """
                    INSERT INTO account_pair_distinct
                      (account_id_low, account_id_high, asserted_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    """,
                    (low, high),
                )
                # Call with the IDs in the OPPOSITE order from how they're stored.
                result = forget_account_pair_distinct(conn, high, low)
                self.assertEqual(result, {"deleted": 1})
                self.assertEqual(list_distinct_account_pairs(conn), [])

    def test_forget_account_pair_distinct_noop_when_no_assertion_exists(self):
        # Forgetting a pair that was never asserted is a no-op (deleted == 0). Endpoint exists
        # mostly so the UI can safely call it without first checking; it shouldn't raise.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        with self._use_db_path():
            with get_db() as conn:
                result = forget_account_pair_distinct(conn, account_a, account_b)
        self.assertEqual(result, {"deleted": 0})

    def test_clear_account_pair_distinct_for_merge_removes_pair_assertions(self):
        # When the user merges A and B, they are asserting the accounts are the SAME physical
        # account — the opposite of the "distinct" assertion. Any prior account_pair_distinct
        # row between them must be removed so the new declaration is the truth of record.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        account_c = self._insert_account("Account C")
        with self._use_db_path():
            with get_db() as conn:
                # Plant two assertions: (A, B) and (A, C).
                for a, b in [(account_a, account_b), (account_a, account_c)]:
                    low, high = sorted([a, b])
                    conn.execute(
                        """
                        INSERT INTO account_pair_distinct
                          (account_id_low, account_id_high, asserted_at)
                        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                        """,
                        (low, high),
                    )
                # Merge only A and B — only that pair's assertion should be cleared.
                cleared = clear_account_pair_distinct_for_merge(conn, [account_a, account_b])
                remaining = list_distinct_account_pairs(conn)

        self.assertEqual(cleared, 1)
        self.assertEqual(len(remaining), 1)
        # The surviving row is (A, C) — still distinct (no merge declared for that pair).
        low_ac, high_ac = sorted([account_a, account_c])
        self.assertEqual(remaining[0]["account_id_low"], low_ac)
        self.assertEqual(remaining[0]["account_id_high"], high_ac)

    def test_clear_account_pair_distinct_for_merge_handles_n_way_groups(self):
        # When 3+ accounts are merged into a single group, every pairwise distinct assertion
        # among those accounts is contradicted by the merge. clear_…_for_merge must wipe them
        # all in one call (the IN-clause covers every pair from the group).
        a = self._insert_account("A")
        b = self._insert_account("B")
        c = self._insert_account("C")
        with self._use_db_path():
            with get_db() as conn:
                # Plant all three pairwise assertions.
                for pair in [(a, b), (a, c), (b, c)]:
                    low, high = sorted(pair)
                    conn.execute(
                        """
                        INSERT INTO account_pair_distinct
                          (account_id_low, account_id_high, asserted_at)
                        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                        """,
                        (low, high),
                    )
                cleared = clear_account_pair_distinct_for_merge(conn, [a, b, c])
                remaining = list_distinct_account_pairs(conn)

        self.assertEqual(cleared, 3)
        self.assertEqual(remaining, [])

    def test_clear_account_pair_distinct_for_merge_with_too_few_ids_is_noop(self):
        # Defensive check: callers like detach pass single-account inputs. With fewer than two
        # ids there's no pair to clear; the function should short-circuit and return 0.
        account_a = self._insert_account("Account A")
        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(clear_account_pair_distinct_for_merge(conn, [account_a]), 0)
                self.assertEqual(clear_account_pair_distinct_for_merge(conn, []), 0)

    def test_resolve_reject_does_not_record_account_pair_distinct(self):
        # 'reject' is a row-scoped decision ("yes, that one IS a duplicate"). It tells us
        # nothing about whether the accounts are distinct overall — in fact it asserts the
        # OPPOSITE for this row. The distinct table must remain empty after a reject so the
        # cross-account check stays active for future rows between the same pair.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        batch = self._insert_batch()
        self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        new_id = self._insert_txn(
            account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X", batch_id=batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                mark_import_suspects(conn, batch)
                resolve_suspect(conn, new_id, action="reject")
                pairs = list_distinct_account_pairs(conn)

        self.assertEqual(pairs, [], "reject must not insert an account_pair_distinct row")

    def test_attach_clearing_distinct_then_re_importing_re_surfaces_suspects(self):
        # Full round-trip: user marks (A, B) distinct → merges them (which clears the assertion
        # via clear_account_pair_distinct_for_merge) → detaches → re-imports. The previously
        # cleared assertion is gone, so the cross-account check fires again — the user's prior
        # "distinct" decision was correctly invalidated by the intervening merge.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        first_batch = self._insert_batch(filename="first.csv")
        second_batch = self._insert_batch(filename="second.csv")

        # Establish the distinct assertion.
        with self._use_db_path():
            with get_db() as conn:
                low, high = sorted([account_a, account_b])
                conn.execute(
                    """
                    INSERT INTO account_pair_distinct
                      (account_id_low, account_id_high, asserted_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    """,
                    (low, high),
                )
                # Merge contradicts it — assertion gets cleared.
                clear_account_pair_distinct_for_merge(conn, [account_a, account_b])
                self.assertEqual(list_distinct_account_pairs(conn), [])

        # New import between A and B (post-detach scenario) — fresh match should surface.
        canonical = self._insert_txn(account_id=account_a, date="2025-12-01", amount=-50.00, merchant_name="Z")
        suspect = self._insert_txn(
            account_id=account_b, date="2025-12-01", amount=-50.00, merchant_name="Z", batch_id=second_batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, second_batch)

        self.assertEqual(marked, 1)
        self.assertEqual(self._suspect_link(suspect)["suspect_duplicate_of"], canonical)

    # ---- conservation invariants ----------------------------------------
    # These tests guard against the class of bugs the mutual-flag incident exposed: silent loss
    # of canonical transaction rows after dedupe-state changes. Each one asserts a specific
    # "after the dust settles, this row should still exist" invariant.

    def test_promote_on_merge_preserves_canonical_side_completely(self):
        # Pin the exact post-promotion state of BOTH sides of a flagged pair: the suspect side
        # is fully marked as confirmed-duplicate, the canonical side is left UNTOUCHED (no
        # trashed_at, no rejection_reason, no resolved-at timestamp, no suspect_duplicate_of).
        # This is the invariant the mutual-flag bug violated.
        existing_account = self._insert_account("Existing")
        new_account = self._insert_account("New")
        parent = self._insert_account("Parent")
        canonical_id = self._insert_txn(
            account_id=existing_account, date="2025-11-26", amount=-13.38, merchant_name="GULF OIL",
        )
        suspect_id = self._insert_txn(
            account_id=new_account, date="2025-11-26", amount=-13.38, merchant_name="Gulf Oil",
        )

        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical_id, suspect_id),
                )
                # Now merge new_account into the group containing existing_account.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, existing_account))
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, new_account))
                promoted = promote_in_group_suspects_to_confirmed(conn, [new_account, existing_account, parent])

        self.assertEqual(promoted, 1)
        suspect_link = self._suspect_link(suspect_id)
        canonical_link = self._suspect_link(canonical_id)
        # Suspect side: fully confirmed-duplicate.
        self.assertIsNotNone(suspect_link["trashed_at"])
        self.assertEqual(suspect_link["rejection_reason"], "duplicate_confirmed")
        self.assertIsNotNone(suspect_link["suspect_resolved_at"])
        self.assertEqual(suspect_link["suspect_duplicate_of"], canonical_id)
        # Canonical side: COMPLETELY UNTOUCHED. This is the bug-class invariant.
        self.assertIsNone(canonical_link["trashed_at"])
        self.assertIsNone(canonical_link["rejection_reason"])
        self.assertIsNone(canonical_link["suspect_resolved_at"])
        self.assertIsNone(canonical_link["suspect_duplicate_of"])

    def test_promote_on_merge_handles_many_suspects_with_conservation(self):
        # N suspect pairs across two accounts being merged. Conservation invariant: after the
        # promote sweep, exactly N rows are trashed (the suspect side of each pair) and exactly
        # N rows remain visible (the canonical side). Total rows in txn stays 2N — nothing
        # actually deleted, just hidden by trashed_at.
        existing_account = self._insert_account("Existing")
        new_account = self._insert_account("New")
        pairs = [
            ("2025-10-01", -10.00, "AAA"),
            ("2025-10-02", -20.00, "BBB"),
            ("2025-10-03", -30.00, "CCC"),
            ("2025-10-04", -40.00, "DDD"),
            ("2025-10-05", -50.00, "EEE"),
        ]
        canonical_ids = []
        suspect_ids = []
        for (d, amt, payee) in pairs:
            c_id = self._insert_txn(account_id=existing_account, date=d, amount=amt, merchant_name=payee)
            s_id = self._insert_txn(account_id=new_account, date=d, amount=amt, merchant_name=payee)
            canonical_ids.append(c_id)
            suspect_ids.append(s_id)
            with self._use_db_path():
                with get_db() as conn:
                    conn.execute(
                        "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                        (c_id, s_id),
                    )

        parent = self._insert_account("Parent")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, existing_account))
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, new_account))
                promoted = promote_in_group_suspects_to_confirmed(conn, [new_account, existing_account, parent])

        self.assertEqual(promoted, len(pairs))
        for suspect_id in suspect_ids:
            self.assertIsNotNone(self._suspect_link(suspect_id)["trashed_at"])
            self.assertEqual(self._suspect_link(suspect_id)["rejection_reason"], "duplicate_confirmed")
        for canonical_id in canonical_ids:
            self.assertIsNone(self._suspect_link(canonical_id)["trashed_at"])
            self.assertIsNone(self._suspect_link(canonical_id)["rejection_reason"])

        # Conservation: 2N rows total in txn, N visible (canonical), N trashed (suspect).
        with self._use_db_path():
            with get_db() as conn:
                total = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE account_id IN (?, ?)", (existing_account, new_account),
                ).fetchone()[0]
                visible = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE account_id IN (?, ?) AND trashed_at IS NULL",
                    (existing_account, new_account),
                ).fetchone()[0]
                trashed = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE account_id IN (?, ?) AND trashed_at IS NOT NULL",
                    (existing_account, new_account),
                ).fetchone()[0]
        self.assertEqual(total, 2 * len(pairs))
        self.assertEqual(visible, len(pairs))
        self.assertEqual(trashed, len(pairs))

    def test_undo_dangling_pointer_cleanup_after_canonical_side_deleted(self):
        # Edge case: a suspect was confirmed-rejected (trashed + rejection_reason), THEN the
        # batch containing the canonical row gets undone. The canonical row vanishes, leaving
        # the confirmed-rejected suspect's suspect_duplicate_of pointing at a deleted id. The
        # undo handler's dangling-pointer cleanup should clear the pointer; the row stays
        # trashed/rejected (the user's decision is preserved), it just no longer claims a
        # specific match.
        canonical_batch_id = self._insert_batch(filename="canonical_batch.csv")
        suspect_batch_id   = self._insert_batch(filename="suspect_batch.csv")
        existing_account = self._insert_account("Existing")
        new_account = self._insert_account("New")
        canonical_id = self._insert_txn(
            account_id=existing_account, date="2025-11-26", amount=-13.38,
            merchant_name="GULF OIL", batch_id=canonical_batch_id,
        )
        suspect_id = self._insert_txn(
            account_id=new_account, date="2025-11-26", amount=-13.38,
            merchant_name="Gulf Oil", batch_id=suspect_batch_id,
        )

        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    UPDATE txn
                    SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                           rejection_reason = 'duplicate_confirmed',
                           suspect_duplicate_of = ?,
                           suspect_duplicate_reason = 'cross_account',
                           suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE  id = ?
                    """,
                    (canonical_id, suspect_id),
                )
                # Simulate the dangling-pointer cleanup that undo_batch runs after deleting the
                # batch's txn rows. Same SQL as in undo_batch.
                conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (canonical_batch_id,))
                conn.execute(
                    """
                    UPDATE txn
                    SET    suspect_duplicate_of = NULL,
                           suspect_duplicate_reason = NULL,
                           suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE  suspect_duplicate_of IS NOT NULL
                      AND  suspect_duplicate_of NOT IN (SELECT id FROM txn)
                    """
                )

        suspect_link = self._suspect_link(suspect_id)
        # Pointer is cleared (no longer dangling).
        self.assertIsNone(suspect_link["suspect_duplicate_of"])
        # The user's confirmation decision is preserved — the row stays trashed and rejected.
        self.assertIsNotNone(suspect_link["trashed_at"])
        self.assertEqual(suspect_link["rejection_reason"], "duplicate_confirmed")

    def test_resolve_reject_marks_resolution_as_user(self):
        # The dedupe_resolved_by marker is what protects user-Reject decisions from being
        # auto-undone by a subsequent detach (see restore_auto_merged_after_detach). Pin the
        # source of truth: resolve_suspect('reject') is what sets it to 'user'.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        canonical = self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        suspect = self._insert_txn(account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical, suspect),
                )
                resolve_suspect(conn, suspect, action="reject")
        self.assertEqual(self._suspect_link(suspect)["dedupe_resolved_by"], "user")

    def test_promote_on_merge_marks_resolution_as_auto_merge(self):
        # Auto-promotions during merge are marked 'auto_merge' so detach can safely roll them
        # back without trampling user decisions.
        existing_account = self._insert_account("Existing")
        new_account = self._insert_account("New")
        parent = self._insert_account("Parent")
        canonical = self._insert_txn(account_id=existing_account, date="2025-11-26", amount=-13.38, merchant_name="X")
        suspect = self._insert_txn(account_id=new_account, date="2025-11-26", amount=-13.38, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical, suspect),
                )
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, existing_account))
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, new_account))
                promote_in_group_suspects_to_confirmed(conn, [new_account, existing_account, parent])
        self.assertEqual(self._suspect_link(suspect)["dedupe_resolved_by"], "auto_merge")

    def test_restore_rejected_duplicate_clears_resolution_marker(self):
        # When the user clicks Restore on a confirmed_duplicate row the row goes back to an
        # un-resolved state, so the marker should be cleared. If they later Reject again, it'll
        # be set back to 'user' at that point.
        account_a = self._insert_account("Account A")
        account_b = self._insert_account("Account B")
        canonical = self._insert_txn(account_id=account_a, date="2025-10-30", amount=-68.00, merchant_name="X")
        suspect = self._insert_txn(account_id=account_b, date="2025-10-30", amount=-68.00, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical, suspect),
                )
                resolve_suspect(conn, suspect, action="reject")
        # Commit-and-read in a separate get_db() block — _suspect_link opens its own connection
        # so it wouldn't see uncommitted writes from the same outer with-block above.
        self.assertEqual(self._suspect_link(suspect)["dedupe_resolved_by"], "user")
        with self._use_db_path():
            with get_db() as conn:
                restore_rejected_duplicate(conn, suspect)
        self.assertIsNone(self._suspect_link(suspect)["dedupe_resolved_by"])

    def test_promote_clears_same_batch_sibling_suspect_via_transitivity(self):
        # A new CSV has one same-amount charge on each of two different cards (A and B). An
        # earlier import has the canonical row on a third account (X). The post-import sweep
        # flags BOTH new rows as cross-account suspects of X. When the user then merges card
        # A with X, A's side is promoted to confirmed — and B's suspect-against-X should
        # clear too. Same-batch trust says A and B are distinct, so once A is identified with
        # X, B can't also be.
        existing_account = self._insert_account("Existing")
        card_a = self._insert_account("Card A")
        card_b = self._insert_account("Card B")
        new_batch = self._insert_batch()
        canonical = self._insert_txn(
            account_id=existing_account, date="2025-05-25", amount=-21.29, merchant_name="VENDOR",
        )
        sibling_to_be_merged = self._insert_txn(
            account_id=card_a, date="2025-05-25", amount=-21.29,
            merchant_name="VENDOR", batch_id=new_batch,
        )
        same_batch_other = self._insert_txn(
            account_id=card_b, date="2025-05-25", amount=-21.29,
            merchant_name="VENDOR", batch_id=new_batch,
        )
        with self._use_db_path():
            with get_db() as conn:
                # Both same-batch rows have cross-account suspects pointing at the canonical.
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical, sibling_to_be_merged),
                )
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical, same_batch_other),
                )
                # User merges card_a with the existing account.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (existing_account, card_a))
                promoted = promote_in_group_suspects_to_confirmed(conn, [card_a, existing_account])
        # The merged card's suspect is auto-promoted (the existing behavior).
        self.assertEqual(promoted, 1)
        merged_link = self._suspect_link(sibling_to_be_merged)
        self.assertIsNotNone(merged_link["trashed_at"])
        self.assertEqual(merged_link["dedupe_resolved_by"], "auto_merge")
        # The same-batch sibling's suspect is cleared via transitivity: same CSV → distinct
        # from the merged row → distinct from the canonical too. NOT trashed (it's a real,
        # distinct transaction), just no longer flagged for review.
        other_link = self._suspect_link(same_batch_other)
        self.assertIsNone(other_link["suspect_duplicate_of"])
        self.assertIsNone(other_link["suspect_duplicate_reason"])
        self.assertIsNotNone(other_link["suspect_resolved_at"])
        self.assertIsNone(other_link["trashed_at"])
        self.assertIsNone(other_link["rejection_reason"])

    def test_promote_does_not_transitively_clear_when_sibling_targets_different_canonical(self):
        # The transitive-clear should ONLY fire when the sibling's suspect points at the *same
        # canonical row* the promoted row was confirmed against. A sibling whose suspect targets
        # a different row (here on an entirely unrelated account) stays flagged — same-batch
        # trust says nothing about that unrelated pair.
        existing_account = self._insert_account("Existing")
        unrelated_account = self._insert_account("Unrelated")
        card_a = self._insert_account("Card A")
        card_b = self._insert_account("Card B")
        new_batch = self._insert_batch()
        canonical_a = self._insert_txn(account_id=existing_account, date="2025-05-25", amount=-10.00, merchant_name="P1")
        canonical_b = self._insert_txn(account_id=unrelated_account, date="2025-05-25", amount=-20.00, merchant_name="P2")
        promoted_row = self._insert_txn(account_id=card_a, date="2025-05-25", amount=-10.00, merchant_name="P1", batch_id=new_batch)
        sibling_row = self._insert_txn(account_id=card_b, date="2025-05-25", amount=-20.00, merchant_name="P2", batch_id=new_batch)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical_a, promoted_row),
                )
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical_b, sibling_row),
                )
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (existing_account, card_a))
                promote_in_group_suspects_to_confirmed(conn, [card_a, existing_account])
        # promoted_row is auto-promoted, but sibling_row's suspect (pointing at a different
        # canonical) stays flagged.
        self.assertIsNotNone(self._suspect_link(promoted_row)["trashed_at"])
        sibling_link = self._suspect_link(sibling_row)
        self.assertEqual(sibling_link["suspect_duplicate_of"], canonical_b)
        self.assertIsNone(sibling_link["suspect_resolved_at"])

    def test_promote_does_not_transitively_clear_sibling_targeting_different_row_in_merged_group(self):
        # Real-world regression: a legacy umbrella account "Credit Card" carries transactions that
        # physically belong to two different real cards. A statement import lands rows for card R
        # AND card C in one batch, each flagged cross-account against the corresponding
        # (DIFFERENT) Credit Card transaction. The user merges Credit Card into card R.
        #
        # The card-R row is correctly promoted. The card-C row's suspect points at a DIFFERENT
        # Credit Card transaction that now merely shares the merged group — it is a real, still-
        # open cross-account suspect and must NOT be transitively cleared. The buggy "same merged
        # group" check cleared it (silently, with no confirmed row to restore on a later detach);
        # the correct "same canonical row" check leaves it flagged.
        credit_card     = self._insert_account("Credit Card")    # legacy umbrella, gets merged
        card_r          = self._insert_account("Rewards Card")   # merge target
        card_c          = self._insert_account("Cashback Card")  # untouched by the merge
        batch           = self._insert_batch(filename="card_statement.csv")
        # Two distinct Credit Card transactions (different merchant/amount).
        cc_r_txn = self._insert_txn(account_id=credit_card, date="2023-12-14", amount=-3.65,  merchant_name="PARKS DEPT")
        cc_c_txn = self._insert_txn(account_id=credit_card, date="2023-10-30", amount=-68.00, merchant_name="OUTDOOR CO")
        card_r_row = self._insert_txn(account_id=card_r, date="2023-12-14", amount=-3.65,  merchant_name="Parks Dept", batch_id=batch)
        card_c_row = self._insert_txn(account_id=card_c, date="2023-10-30", amount=-68.00, merchant_name="Outdoor Co", batch_id=batch)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (cc_r_txn, card_r_row),
                )
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (cc_c_txn, card_c_row),
                )
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (card_r, credit_card))
                promote_in_group_suspects_to_confirmed(conn, [credit_card, card_r])
        # Card-R row promoted (the Credit Card row it matched is now in its group).
        self.assertEqual(self._suspect_link(card_r_row)["dedupe_resolved_by"], "auto_merge")
        # Card-C row must stay an active suspect — it targets a *different* Credit Card
        # transaction, so the merge with card R says nothing about it.
        card_c_link = self._suspect_link(card_c_row)
        self.assertEqual(card_c_link["suspect_duplicate_of"], cc_c_txn,
                         "Card-C suspect was wrongly cleared by an over-broad transitivity rule")
        self.assertIsNone(card_c_link["suspect_resolved_at"])
        self.assertIsNone(card_c_link["trashed_at"])

    def test_attach_then_detach_endpoint_round_trip_restores_promoted_rows(self):
        # End-to-end coverage of the router wiring: the service functions
        # (`promote_in_group_suspects_to_confirmed` on attach,
        # `restore_auto_merged_after_detach` on detach) are exercised through the actual
        # POST /accounts/{id}/attach and /detach endpoints, not via direct service calls.
        # Catches regressions where someone refactors the routers and forgets to keep the
        # dedupe coordination calls wired up.
        existing_account = self._insert_account("Existing")
        new_account = self._insert_account("New")
        canonical_id = self._insert_txn(account_id=existing_account, date="2025-11-26", amount=-13.38, merchant_name="X")
        suspect_id   = self._insert_txn(account_id=new_account,      date="2025-11-26", amount=-13.38, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical_id, suspect_id),
                )
        # Attach via the router — this should auto-promote the cross-account suspect because
        # both sides now share an effective root.
        with self._use_db_path():
            attach_account(new_account, AccountAttachRequest(parent_account_id=existing_account))
        promoted_link = self._suspect_link(suspect_id)
        self.assertIsNotNone(promoted_link["trashed_at"])
        self.assertEqual(promoted_link["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(promoted_link["dedupe_resolved_by"], "auto_merge")
        # Detach via the router — should reverse the promotion and report it in the response.
        with self._use_db_path():
            response = detach_account(new_account)
        self.assertEqual(response.get("restored_count"), 1)
        restored_link = self._suspect_link(suspect_id)
        self.assertIsNone(restored_link["trashed_at"])
        self.assertIsNone(restored_link["rejection_reason"])
        self.assertIsNone(restored_link["dedupe_resolved_by"])
        self.assertEqual(restored_link["suspect_duplicate_of"], canonical_id)

    def test_detach_auto_restores_promoted_duplicates(self):
        # Merge promoted the suspect to confirmed (auto_merge). Detach should restore it back
        # to active-suspect state: trashed_at/rejection_reason cleared, suspect_duplicate_of
        # preserved as the audit pointer, marker cleared. The row shows up again in the dialog.
        parent = self._insert_account("Parent")
        existing_account = self._insert_account("Existing")
        new_account = self._insert_account("New")
        canonical_id = self._insert_txn(account_id=existing_account, date="2025-11-26", amount=-13.38, merchant_name="X")
        suspect_id   = self._insert_txn(account_id=new_account,      date="2025-11-26", amount=-13.38, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical_id, suspect_id),
                )
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, existing_account))
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, new_account))
                promote_in_group_suspects_to_confirmed(conn, [new_account, existing_account, parent])
                # The router runs this AFTER clearing parent_account_id; the remaining group
                # is the parent plus the still-grouped child (existing_account).
                conn.execute("UPDATE account SET parent_account_id = NULL WHERE id = ?", (new_account,))
                restored = restore_auto_merged_after_detach(conn, new_account, [parent, existing_account])
        self.assertEqual(restored, 1)
        link = self._suspect_link(suspect_id)
        self.assertIsNone(link["trashed_at"])
        self.assertIsNone(link["rejection_reason"])
        self.assertIsNone(link["suspect_resolved_at"])
        self.assertIsNone(link["dedupe_resolved_by"])
        # suspect_duplicate_of preserved — the row is once again an active suspect.
        self.assertEqual(link["suspect_duplicate_of"], canonical_id)

    def test_detach_does_not_restore_user_rejected_duplicates(self):
        # Pin the protection: a row the user explicitly Rejected before the merge stays
        # rejected after detach. The 'user' marker is what distinguishes it from an auto_merge
        # promotion.
        parent = self._insert_account("Parent")
        existing_account = self._insert_account("Existing")
        new_account = self._insert_account("New")
        canonical_id = self._insert_txn(account_id=existing_account, date="2025-11-26", amount=-13.38, merchant_name="X")
        suspect_id   = self._insert_txn(account_id=new_account,      date="2025-11-26", amount=-13.38, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical_id, suspect_id),
                )
                # User explicitly Rejects BEFORE the merge.
                resolve_suspect(conn, suspect_id, action="reject")
                # Later the user merges and detaches.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, existing_account))
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, new_account))
                promote_in_group_suspects_to_confirmed(conn, [new_account, existing_account, parent])
                conn.execute("UPDATE account SET parent_account_id = NULL WHERE id = ?", (new_account,))
                restored = restore_auto_merged_after_detach(conn, new_account, [parent, existing_account])
        # Nothing restored — the row carries the 'user' marker from the explicit Reject.
        self.assertEqual(restored, 0)
        link = self._suspect_link(suspect_id)
        self.assertIsNotNone(link["trashed_at"])
        self.assertEqual(link["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(link["dedupe_resolved_by"], "user")

    # ---- merge-time fresh cross-scope scan -------------------------------

    def _set_needs_review(self, txn_id: str, value: int) -> None:
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE txn SET needs_review = ? WHERE id = ?", (value, txn_id))

    def test_merge_fresh_scan_catches_uncompared_cross_account_pair(self):
        # The gap the scan closes: two rows that were NEVER compared at import time (e.g. a synced row
        # that ran no detection) carry no suspect pointer, so promote-on-merge alone finds nothing. The
        # fresh scan flags the pair, and promote then confirms it. Attach runs both, end-to-end.
        plaid_acct = self._insert_account("Plaid Checking")
        csv_acct = self._insert_account("CSV Checking")
        kept = self._insert_txn(account_id=csv_acct, date="2026-08-10", amount=-10.0, merchant_name="Coffee")
        synced = self._insert_txn(account_id=plaid_acct, date="2026-08-10", amount=-10.0, merchant_name="Coffee")
        self._set_needs_review(kept, 0)      # reviewed CSV row → the canonical to keep
        self._set_needs_review(synced, 1)    # un-reviewed synced copy → the suspect to trash
        # Neither carries a suspect pointer going in.
        self.assertIsNone(self._suspect_link(synced)["suspect_duplicate_of"])

        with self._use_db_path():
            attach_account(plaid_acct, AccountAttachRequest(parent_account_id=csv_acct))

        # The synced copy is confirmed-trashed against the CSV row; the CSV row is untouched.
        suspect = self._suspect_link(synced)
        self.assertEqual(suspect["suspect_duplicate_of"], kept)
        self.assertEqual(suspect["rejection_reason"], "duplicate_confirmed")
        self.assertEqual(suspect["dedupe_resolved_by"], "auto_merge")
        self.assertIsNotNone(suspect["trashed_at"])
        canonical = self._suspect_link(kept)
        self.assertIsNone(canonical["trashed_at"])
        self.assertIsNone(canonical["suspect_duplicate_of"])

    def test_merge_fresh_scan_is_reversible_on_detach(self):
        # A scan-found, promote-confirmed duplicate is an auto_merge resolution, so detaching the account
        # restores it exactly like any other auto_merge promotion — the scan doesn't create a stuck row.
        plaid_acct = self._insert_account("Plaid Checking")
        csv_acct = self._insert_account("CSV Checking")
        kept = self._insert_txn(account_id=csv_acct, date="2026-08-10", amount=-10.0, merchant_name="Coffee")
        synced = self._insert_txn(account_id=plaid_acct, date="2026-08-10", amount=-10.0, merchant_name="Coffee")
        self._set_needs_review(kept, 0)
        self._set_needs_review(synced, 1)
        with self._use_db_path():
            attach_account(plaid_acct, AccountAttachRequest(parent_account_id=csv_acct))
            response = detach_account(plaid_acct)
        self.assertEqual(response.get("restored_count"), 1)
        link = self._suspect_link(synced)
        self.assertIsNone(link["trashed_at"])
        self.assertIsNone(link["dedupe_resolved_by"])
        self.assertEqual(link["suspect_duplicate_of"], kept)  # back to an active suspect

    def test_merge_fresh_scan_ignores_same_account_repeat(self):
        # Two identical-looking rows on the SAME account are a legitimate repeat (two coffees), not a
        # cross-account duplicate. The scan only pairs rows that straddle two different accounts.
        acct = self._insert_account("Checking")
        other = self._insert_account("Savings")
        r1 = self._insert_txn(account_id=acct, date="2026-08-10", amount=-4.0, merchant_name="Coffee")
        r2 = self._insert_txn(account_id=acct, date="2026-08-10", amount=-4.0, merchant_name="Coffee")
        with self._use_db_path():
            with get_db() as conn:
                flagged = scan_scope_for_cross_account_duplicates(conn, [acct, other])
        self.assertEqual(flagged, 0)
        self.assertIsNone(self._suspect_link(r1)["suspect_duplicate_of"])
        self.assertIsNone(self._suspect_link(r2)["suspect_duplicate_of"])

    def test_detach_restore_skips_rows_pointing_outside_remaining_group(self):
        # The restore SQL filters suspect_duplicate_of to "still in the group" canonicals only,
        # so a promotion that referenced a row on a now-unrelated account doesn't get rolled
        # back (it wasn't part of THIS merge's promotion in any meaningful way).
        parent = self._insert_account("Parent")
        in_group = self._insert_account("Stays in group")
        detaching = self._insert_account("Detaching")
        unrelated = self._insert_account("Unrelated")
        canonical_in_group = self._insert_txn(account_id=in_group, date="2025-11-26", amount=-13.38, merchant_name="X")
        canonical_unrelated = self._insert_txn(account_id=unrelated, date="2025-11-27", amount=-50.00, merchant_name="Y")
        suspect_a = self._insert_txn(account_id=detaching, date="2025-11-26", amount=-13.38, merchant_name="X")
        suspect_b = self._insert_txn(account_id=detaching, date="2025-11-27", amount=-50.00, merchant_name="Y")
        with self._use_db_path():
            with get_db() as conn:
                # Plant both as auto_merge promotions even though only one actually fits the
                # "in-group" pattern. The restore should skip the one pointing outside.
                conn.execute(
                    """UPDATE txn SET trashed_at='2026-01-01', rejection_reason='duplicate_confirmed',
                       suspect_duplicate_of=?, suspect_duplicate_reason='cross_account',
                       suspect_resolved_at='2026-01-01', dedupe_resolved_by='auto_merge' WHERE id=?""",
                    (canonical_in_group, suspect_a),
                )
                conn.execute(
                    """UPDATE txn SET trashed_at='2026-01-01', rejection_reason='duplicate_confirmed',
                       suspect_duplicate_of=?, suspect_duplicate_reason='cross_account',
                       suspect_resolved_at='2026-01-01', dedupe_resolved_by='auto_merge' WHERE id=?""",
                    (canonical_unrelated, suspect_b),
                )
                restored = restore_auto_merged_after_detach(conn, detaching, [parent, in_group])
        self.assertEqual(restored, 1)
        # suspect_a pointed at in_group — restored.
        self.assertIsNone(self._suspect_link(suspect_a)["trashed_at"])
        # suspect_b pointed at unrelated — left alone.
        self.assertIsNotNone(self._suspect_link(suspect_b)["trashed_at"])
        self.assertEqual(self._suspect_link(suspect_b)["dedupe_resolved_by"], "auto_merge")

    def test_detach_restores_promotion_when_canonical_is_on_detaching_account(self):
        # Mirror orientation (the real-world "merge a legacy umbrella source account into a real
        # card" case): the suspect-holding row — the one promotion trashes — sits on the account
        # that STAYS in the group, and the canonical it points at sits on the account being
        # DETACHED. Concretely: a legacy "Credit Card" account is imported first (canonical), then
        # a newer statement imported second carries the suspect pointer at the legacy row. The
        # user attaches Credit Card under the real card (promotes), then detaches it.
        #
        # The pre-fix restore only matched auto_merge rows whose account_id == the detached
        # account, so it never found the trashed statement row (account_id == the account that
        # stayed) and left it confirmed forever — detach silently failed to reverse the merge.
        legacy_cc = self._insert_account("Credit Card")   # umbrella source, gets attached/detached
        real_card = self._insert_account("Rewards Card")  # merge target, stays
        canonical_id = self._insert_txn(account_id=legacy_cc, date="2025-11-26", amount=-13.38, merchant_name="X")
        suspect_id   = self._insert_txn(account_id=real_card, date="2025-11-26", amount=-13.38, merchant_name="X")
        with self._use_db_path():
            with get_db() as conn:
                # The real-card row is the import-time suspect, pointing at the existing legacy row.
                conn.execute(
                    "UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?",
                    (canonical_id, suspect_id),
                )
        with self._use_db_path():
            attach_account(legacy_cc, AccountAttachRequest(parent_account_id=real_card))
        promoted_link = self._suspect_link(suspect_id)
        self.assertEqual(promoted_link["dedupe_resolved_by"], "auto_merge",
                         "the real-card suspect should be auto-promoted by the merge")
        # Detaching the Credit Card must reverse that promotion even though the trashed row lives
        # on the account that stayed (the real card), not on the detaching account.
        with self._use_db_path():
            response = detach_account(legacy_cc)
        self.assertEqual(response.get("restored_count"), 1,
                         "detach must reverse a promotion whose trashed row is on the remaining-group side")
        restored_link = self._suspect_link(suspect_id)
        self.assertIsNone(restored_link["trashed_at"])
        self.assertIsNone(restored_link["rejection_reason"])
        self.assertIsNone(restored_link["dedupe_resolved_by"])
        self.assertEqual(restored_link["suspect_duplicate_of"], canonical_id)


    def test_credit_card_reissue_end_to_end_conservation(self):
        # End-to-end conservation scenario modelling the most common real-world dedupe flow:
        # the user has an account "Old Card" with some prior transactions. Their card is then
        # reissued and the new statement is imported under a brand-new "New Card" account
        # (typical: different last-4 digits, different feed). The new import has SOME rows that
        # overlap with the existing account (the same purchases reposted on the new card mid-
        # cycle) AND some rows that are unique to the new card. The user then merges New Card
        # into Old Card.
        #
        # CONSERVATION INVARIANT after the merge:
        #   * Every existing canonical row is still visible (nothing lost from old import).
        #   * Every unique row from the new import is still visible (no new data lost).
        #   * Every overlapping pair contributes exactly ONE visible row (the canonical), with
        #     the duplicate auto-promoted to confirmed-trashed.
        #   * Total visible count = (old canonical) + (new unique).
        old_card = self._insert_account("Old Card")
        new_card = self._insert_account("New Card")
        batch = self._insert_batch(filename="newcard_statement.csv")

        # Pre-existing rows on Old Card (representing previously-imported data). Payee text
        # is intentionally identical-after-normalization between the matching old/new pairs
        # because mark_import_suspects matches on (date, amount, normalized payee). The unique
        # rows below use distinct payees.
        old_canonical = [
            self._insert_txn(account_id=old_card, date="2025-11-20", amount=-12.34, merchant_name="STARBUCKS"),
            self._insert_txn(account_id=old_card, date="2025-11-22", amount=-45.67, merchant_name="WHOLEFDS"),
            self._insert_txn(account_id=old_card, date="2025-11-24", amount=-89.01, merchant_name="AMAZON"),
            self._insert_txn(account_id=old_card, date="2025-11-26", amount=-13.38, merchant_name="GULF OIL"),
        ]
        # Rows from the new import: 3 overlap with Old Card (case-different text but normalizes
        # to the same value), 2 are unique to the new card.
        new_overlapping = [
            self._insert_txn(account_id=new_card, date="2025-11-22", amount=-45.67, merchant_name="Wholefds", batch_id=batch),
            self._insert_txn(account_id=new_card, date="2025-11-24", amount=-89.01, merchant_name="Amazon", batch_id=batch),
            self._insert_txn(account_id=new_card, date="2025-11-26", amount=-13.38, merchant_name="Gulf Oil", batch_id=batch),
        ]
        new_unique = [
            self._insert_txn(account_id=new_card, date="2025-11-28", amount=-7.99, merchant_name="NETFLIX", batch_id=batch),
            self._insert_txn(account_id=new_card, date="2025-11-30", amount=-35.00, merchant_name="GAS STATION", batch_id=batch),
        ]

        # Step 1: import-time suspect flagging. mark_import_suspects flags each cross-account
        # overlap as a suspect of the corresponding Old Card row, regardless of whether the
        # receiving account is brand-new (the per-pair-distinct model does not gate on
        # account history).
        with self._use_db_path():
            with get_db() as conn:
                marked = mark_import_suspects(conn, batch)
        self.assertEqual(marked, len(new_overlapping),
                         "Each overlapping row should be flagged as a suspect")

        # Step 2: user reviews the dedupe report and decides to merge the accounts. This
        # mirrors what attach_account does: set parent_account_id, then promote in-group
        # suspects to confirmed-rejected.
        parent = self._insert_account("Card Group")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, old_card))
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (parent, new_card))
                promoted = promote_in_group_suspects_to_confirmed(conn, [new_card, old_card, parent])

        self.assertEqual(promoted, len(new_overlapping),
                         "Each overlapping suspect should be promoted to confirmed-duplicate")

        # Assert conservation invariant directly:
        # All Old Card canonical rows remain visible and untouched.
        for canonical_id in old_canonical:
            link = self._suspect_link(canonical_id)
            self.assertIsNone(link["trashed_at"], "Old canonical row was incorrectly trashed")
            self.assertIsNone(link["rejection_reason"], "Old canonical row was incorrectly rejected")
            self.assertIsNone(link["suspect_duplicate_of"], "Old canonical row should not be a suspect")

        # All overlapping suspect rows are trashed + confirmed.
        for suspect_id in new_overlapping:
            link = self._suspect_link(suspect_id)
            self.assertIsNotNone(link["trashed_at"], "Overlapping suspect was not trashed")
            self.assertEqual(link["rejection_reason"], "duplicate_confirmed")

        # All unique new rows remain visible.
        for unique_id in new_unique:
            link = self._suspect_link(unique_id)
            self.assertIsNone(link["trashed_at"], "Unique new row was incorrectly trashed — DATA LOSS")
            self.assertIsNone(link["rejection_reason"])

        # Total visible row count check across both accounts.
        with self._use_db_path():
            with get_db() as conn:
                visible = conn.execute(
                    """
                    SELECT COUNT(*) FROM txn
                    WHERE  account_id IN (?, ?)
                      AND  trashed_at IS NULL
                    """,
                    (old_card, new_card),
                ).fetchone()[0]
        expected_visible = len(old_canonical) + len(new_unique)
        self.assertEqual(visible, expected_visible,
                         f"Conservation: expected {expected_visible} visible rows "
                         f"({len(old_canonical)} old canonical + {len(new_unique)} new unique), "
                         f"got {visible} — data was lost or duplicated")

    def test_three_way_merge_keeps_promote_sweep_consistent(self):
        # A, B, C each have a matching row. User merges B into A (promotes B's suspect against
        # A). Then user merges C into A (promotes C's suspect against A). After both merges,
        # exactly ONE row remains visible (A's canonical) and the other two are confirmed.
        a = self._insert_account("A")
        b = self._insert_account("B")
        c = self._insert_account("C")
        a_id = self._insert_txn(account_id=a, date="2025-11-26", amount=-13.38, merchant_name="GULF OIL")
        b_id = self._insert_txn(account_id=b, date="2025-11-26", amount=-13.38, merchant_name="GULF OIL")
        c_id = self._insert_txn(account_id=c, date="2025-11-26", amount=-13.38, merchant_name="GULF OIL")

        with self._use_db_path():
            with get_db() as conn:
                # Plant the two import-time suspects.
                conn.execute("UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?", (a_id, b_id))
                conn.execute("UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = 'cross_account' WHERE id = ?", (a_id, c_id))

                # First merge: B → A.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (a, b))
                promote_in_group_suspects_to_confirmed(conn, [a, b])

                # Second merge: C → A.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (a, c))
                promote_in_group_suspects_to_confirmed(conn, [a, b, c])

        # A's row stays visible; B and C are both trashed + confirmed.
        self.assertIsNone(self._suspect_link(a_id)["trashed_at"])
        self.assertIsNone(self._suspect_link(a_id)["rejection_reason"])
        self.assertIsNotNone(self._suspect_link(b_id)["trashed_at"])
        self.assertEqual(self._suspect_link(b_id)["rejection_reason"], "duplicate_confirmed")
        self.assertIsNotNone(self._suspect_link(c_id)["trashed_at"])
        self.assertEqual(self._suspect_link(c_id)["rejection_reason"], "duplicate_confirmed")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
