"""
Cross-account transfer twin for coverage-rejected funding/deposit legs.

A wallet (PayPal/Venmo/…) Activity CSV logs a funding/deposit leg — money into the wallet — whose
real-world twin is the *funding* transaction on the bank/card account: same magnitude, a day or three
off (ACH/settlement lag), named for the wallet. That twin is cross-account and opposite-signed, so the
same-account coverage lookup never sees it and the leg reads as a bare "no specific match". These tests
pin `find_cross_account_transfer_candidates` (the targeted SQL that finds the twin) directly.

The second class covers `find_ledger_payment_match`, the other caller of the same candidate query.
It wants the opposite sign relationship — a payment is corroborated by the *same* outflow charged on
another account — and the two together are why that query states a sign instead of comparing
magnitudes.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.duplicate_detection import (
    find_cross_account_transfer_candidates,
    find_ledger_payment_match,
)


class _WalletLedgerFixture(unittest.TestCase):
    """Three accounts and a row writer, shared by both callers' tests."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transfer-match.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            for acc_id, name in (("paypal", "PayPal"), ("checking", "Everyday Checking"), ("card", "Rewards Card")):
                conn.execute(
                    """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                       VALUES (?, ?, 'fixture', ?, ?, 'checking', ?)""",
                    (acc_id, f"p_{acc_id}", name, name, SHARED_OWNER_ID),
                )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _txn(self, account_id, amount, date, name, *, original_description=None, raw=None):
        """`raw` splits the statement text from the displayed name — the shape a merchant-rename rule
        leaves behind, since it writes `merchant_name` and leaves `raw_name` as the bank wrote it."""
        tid = str(uuid.uuid4())
        evidence = None
        if original_description is not None:
            evidence = json.dumps({"extra_text_fields": [{"header": "Original Description", "value": original_description}]})
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending, import_evidence_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
                (tid, account_id, SHARED_OWNER_ID, amount, name, name, raw if raw is not None else name,
                 date, evidence),
            )
        return tid


class CrossAccountTransferMatchTests(_WalletLedgerFixture):
    def _find(self, date, amount):
        with self._use_db_path(), get_db() as conn:
            return find_cross_account_transfer_candidates(conn, "paypal", date, amount)

    def test_finds_the_opposite_signed_funding_twin_named_for_the_wallet(self):
        # Deposit leg into PayPal is stored -716 (a credit); the funding row on Everyday Checking is +716,
        # named "PayPal", a day later — the twin the same-account lookup can't see.
        fund = self._txn("checking", 716.0, "2026-01-21", "PayPal")
        out = self._find("2026-01-20", -716.0)
        self.assertEqual([c["id"] for c in out], [fund])
        self.assertTrue(out[0]["cross_account"])
        self.assertEqual(out[0]["account_name"], "Everyday Checking")

    def test_a_renamed_counterpart_still_pairs(self):
        # Cleaning up "PAYPAL NORTHGATE OUTFITTERS" to the merchant it was really for is a reasonable
        # thing to want, and it used to cost the pairing: the rename writes `merchant_name`, which sits
        # above `raw_name` in the lookup's COALESCE, so the wallet's own name left the searched text.
        # Both are read now, so a rename can add a token but never take one away.
        fund = self._txn("checking", 40.0, "2026-05-02", "Northgate Outfitters", raw="PAYPAL NORTHGATE OUTFITTERS")
        self.assertEqual([c["id"] for c in self._find("2026-05-01", -40.0)], [fund])

    def test_matches_a_wallet_token_embedded_in_a_longer_name(self):
        fund = self._txn("checking", 2251.67, "2026-03-12", "WDRL-ACH PAYPAL INSTANT TRANSFER - INST XFER")
        out = self._find("2026-03-11", -2251.67)
        self.assertEqual([c["id"] for c in out], [fund])

    def test_matches_via_original_description_evidence_when_the_clean_name_omits_the_wallet(self):
        # The common Mint shape: the cleaned display name drops "PayPal" but the captured Original
        # Description keeps it. Searching the source text (not just the name) must still find the twin.
        fund = self._txn(
            "checking", 254.88, "2026-08-24", "ELECTRONIC PAYMENT  INST XFER 200824",
            original_description="ELECTRONIC PAYMENT PAYPAL    INST XFER    200824",
        )
        out = self._find("2026-08-23", -254.88)
        self.assertEqual([c["id"] for c in out], [fund])
        self.assertTrue(out[0]["cross_account"])

    def test_ignores_same_amount_rows_not_named_for_the_wallet(self):
        # A same-amount, near-date charge on another account that doesn't mention PayPal is not the twin.
        self._txn("card", 716.0, "2026-01-20", "Whole Foods")
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_ignores_rows_whose_name_and_evidence_both_lack_the_wallet(self):
        # Evidence text must not become a false-positive source: a same-amount, near-date row whose name
        # AND Original Description both omit PayPal is still not the twin.
        self._txn(
            "card", 716.0, "2026-01-20", "ELECTRONIC PAYMENT  INST XFER",
            original_description="ELECTRONIC PAYMENT  INST XFER 200120",
        )
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_ignores_rows_outside_the_window_and_on_the_wallet_itself(self):
        self._txn("checking", 716.0, "2026-01-28", "PayPal")           # 8 days off — outside ±3
        self._txn("paypal", 716.0, "2026-01-20", "PayPal transfer")    # on the wallet itself
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_ignores_trashed_twins(self):
        with self._use_db_path(), get_db() as conn:
            tid = self._txn("checking", 716.0, "2026-01-21", "PayPal")
            conn.execute("UPDATE txn SET trashed_at = '2026-02-01T00:00:00Z' WHERE id = ?", (tid,))
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_a_same_signed_row_is_not_a_transfer_twin(self):
        # A twin is the *other side* of one movement, so it carries the opposite sign. A row on another
        # account with the same sign is a second transaction of the same size — and it can be named for
        # the wallet too (a second deposit, a fee), so the name check does not separate them. Magnitude
        # matching used to offer it as a candidate; the sign is what rules it out.
        self._txn("checking", -716.0, "2026-01-21", "PayPal")
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_nearest_date_ranks_first(self):
        far = self._txn("checking", 388.5, "2026-03-08", "PayPal")   # 3 off
        near = self._txn("card", 388.5, "2026-03-05", "PayPal")      # exact
        out = self._find("2026-03-05", -388.5)
        self.assertEqual([c["id"] for c in out], [near, far])


class CandidateAccountLabelTests(_WalletLedgerFixture):
    """What the report calls the account a candidate sits on.

    Merging propagates the parent's display name onto every child, so inside a linked group the display
    name names the *group*. A candidate on a sibling then carried the same account label as the row it
    was offered as the duplicate of — and the whole point of a cross-account candidate is that it came
    from somewhere else. These pin that the label separates group members.
    """

    def _merged_child(self, child_id, own_name, display_name, mask):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type,
                                        mask, owner_id, parent_account_id)
                   VALUES (?, ?, 'fixture', ?, ?, 'credit', ?, ?, 'card')""",
                (child_id, f"p_{child_id}", own_name, display_name, mask, SHARED_OWNER_ID),
            )

    def test_a_candidate_on_a_merged_sibling_is_not_labeled_as_the_group(self):
        # The reported shape: the twin arrived through a second provider onto a child account, which
        # inherited the parent's display name on merge. Labeled by display name alone it read as the
        # same account as the row it duplicated.
        self._merged_child("card-child", "CREDIT CARD", "Rewards Card", "2741")
        self._txn("card-child", -95.00, "2026-07-01", "Annual Membership Fee")
        with self._use_db_path(), get_db() as conn:
            out = find_ledger_payment_match(conn, "paypal", "2026-07-01", -95.00, "Annual Membership Fee")
        self.assertIsNotNone(out)
        self.assertEqual(out["account_name"], "Rewards Card ···2741",
                         "the mask is what separates a merged child from the group it was merged into")

    def test_an_unmerged_account_keeps_its_plain_name(self):
        # No mask, no suffix — the label must not grow noise for the ordinary case.
        self._txn("card", -49.99, "2026-04-02", "PayPal Spotify")
        with self._use_db_path(), get_db() as conn:
            out = find_ledger_payment_match(conn, "paypal", "2026-04-01", -49.99, "Spotify")
        self.assertEqual(out["account_name"], "Rewards Card")

    def test_the_transfer_twin_is_labeled_the_same_way(self):
        # Both callers read the one candidate query, so neither can drift into its own label form.
        self._merged_child("bank-child", "CHECKING", "Everyday Checking", "3506")
        self._txn("bank-child", -120.00, "2026-05-02", "PayPal Transfer")
        with self._use_db_path(), get_db() as conn:
            out = find_cross_account_transfer_candidates(conn, "paypal", "2026-05-01", 120.00)
        self.assertEqual([c["account_name"] for c in out], ["Everyday Checking ···3506"])


class LedgerPaymentMatchTests(_WalletLedgerFixture):
    """The same candidate query, read the other way round.

    A wallet payment the covering aggregator never saw is only a duplicate if the same money already
    reached the ledger by another route — the card charge behind it, which carries the **same** sign. A
    match here keeps the row *out*; no match lets it import.
    """

    def _match(self, date, amount, merchant):
        with self._use_db_path(), get_db() as conn:
            return find_ledger_payment_match(conn, "paypal", date, amount, merchant)

    def test_a_same_signed_charge_on_another_account_corroborates_the_payment(self):
        charge = self._txn("card", -49.99, "2026-04-02", "PayPal Spotify")
        out = self._match("2026-04-01", -49.99, "Spotify")
        self.assertIsNotNone(out)
        self.assertEqual(out["id"], charge)
        self.assertTrue(out["payment_match"])

    def test_a_refund_is_not_corroborated_by_the_charge_it_reverses(self):
        # The case magnitude matching got wrong, and the only one here that changes what lands in the
        # ledger. A +49.99 refund and the -49.99 charge it reverses share an amount and a merchant, so
        # the merchant-token check cannot separate them — under |amount| the refund read as "already in
        # the ledger" and was rejected, losing a real transaction. Opposite signs are opposite events.
        self._txn("card", -49.99, "2026-04-02", "PayPal Spotify")
        self.assertIsNone(self._match("2026-04-01", 49.99, "Spotify"))

    def test_a_refund_is_corroborated_by_a_matching_refund(self):
        # The mirror image, to show the sign is being read rather than payments simply privileged: a
        # refund already in the ledger on another account does corroborate this one.
        refund = self._txn("card", 49.99, "2026-04-02", "PayPal Spotify")
        out = self._match("2026-04-01", 49.99, "Spotify")
        self.assertIsNotNone(out)
        self.assertEqual(out["id"], refund)

    def test_an_unnamed_charge_does_not_corroborate(self):
        # The merchant token is the other half of the test; amount and sign alone are not evidence.
        self._txn("card", -49.99, "2026-04-02", "Corner Market")
        self.assertIsNone(self._match("2026-04-01", -49.99, "Spotify"))


if __name__ == "__main__":
    unittest.main()
