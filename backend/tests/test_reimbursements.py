"""
Reimbursable expenses — the receivable arithmetic, the settle rule, and the reversal.

The load-bearing claim is the settle rule: a residual is a *category balance* rather than a row, so it
can only be moved by rewriting an existing transaction's allocations, and which transaction can legally
carry it is decided by the sign. A positive residual (repaid short, or never repaid) settles on the
expense and restates the original period on purpose; a negative one (repaid over) settles on the
repayment. Both halves are asserted, because a rule that only ever settled on the expense would look
correct on every short case and then need a mixed-sign allocation — which `txn_splits` refuses — the
first time somebody was repaid more than their own portion. That case has its own test.

Fixtures use whole scenarios rather than hand-built minimal rows: a four-ticket purchase split between
the buyer and their friends is the motivating case, and the residual only means anything against a
transaction whose parts actually sum to it.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.services.excluded_categories import (
    REIMBURSABLE_GROUP,
    REIMBURSABLE_SYSTEM_KEY,
    find_reimbursable_group_id,
    reimbursable_leaf_ids,
)
from backend.services.reimbursements import (
    DEFAULT_REMINDER_DAYS,
    EXPENSE_ROLE,
    REPAYMENT_ROLE,
    UNASSIGNED_OWNER,
    ReimbursementError,
    add_claims,
    create_reimbursement,
    due_reminders,
    get_reimbursement,
    move_claim,
    outstanding,
    owner_grouping_applies,
    receivable_amounts,
    reimbursements_for_txn,
    complete,
    reopen,
    set_default_reminder_days,
    unclaimed_amounts,
    update_reimbursement,
)
from backend.services.txn_splits import get_split_parts, save_split
from backend.tests._api_client import api_client


class ReimbursementTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "reimbursements.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            self.receivable = self._reimbursable_leaf(conn, "Concert tickets")
            self.entertainment = self._leaf(conn, "Entertainment", "Movies & Events")
            self.groceries = self._leaf(conn, "Food & Drink", "Groceries")
            self.account = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO account (id, external_account_id, provider, name, display_name, type, "
                "subtype, mask, owner_id) VALUES (?, ?, 'fixture_reimb', 'Everyday', 'Everyday', "
                "'checking', 'checking', '0000', ?)",
                (self.account, f"acct_{self.account}", SHARED_OWNER_ID),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    def _reimbursable_leaf(self, conn, name: str) -> str:
        """A leaf under the seeded Reimbursable group, made the way a user makes one.

        Named for what the money is rather than for its state: the group already says it is owed back,
        and a state name would stop being true the moment it was repaid.
        """
        group_id = find_reimbursable_group_id(conn)
        leaf_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, sort_order) "
            "VALUES (?,?,?,'expense',1,0)",
            (leaf_id, group_id, name),
        )
        return leaf_id

    def _claims(self, *txn_ids, amount=None, label=None):
        """The claims shape every construction call now takes. An unstated amount claims whatever of the
        row is still unclaimed, which is what the ordinary single-portion case wants."""
        return [{"txn_id": txn_id, "amount": amount, "label": label} for txn_id in txn_ids]

    def _leaf(self, conn: sqlite3.Connection, group_name: str, leaf_name: str) -> str:
        group = conn.execute(
            "SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (group_name,)
        ).fetchone()
        leaf_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?,?,?,?,0)",
            (leaf_id, group["id"], leaf_name, "expense"),
        )
        return leaf_id

    def _txn(self, conn, *, amount, date="2026-02-14", category=None, name="Concert Tickets"):
        txn_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
            "display_name, raw_name, date, is_pending, category_overridden) "
            "VALUES (?,?,?,?,?,?,?,?,?,0,0)",
            (txn_id, self.account, SHARED_OWNER_ID, category, amount, name, name, name, date),
        )
        return txn_id

    def _tickets(self, conn, *, mine=125.0, theirs=375.0):
        """The motivating case: four tickets at $125, one the buyer's and three for friends."""
        txn_id = self._txn(conn, amount=round(mine + theirs, 2))
        save_split(
            conn,
            txn_id,
            [
                {"category_id": self.entertainment, "amount": mine, "label": "My ticket"},
                {"category_id": self.receivable, "amount": theirs, "label": "Three friends"},
            ],
        )
        return txn_id

    def _repayment(self, conn, amount, date="2026-07-03"):
        """Money coming back, categorized straight to the holding group."""
        return self._txn(
            conn, amount=-abs(amount), date=date, category=self.receivable, name="Repayment"
        )

    def _parts(self, conn, txn_id):
        return {
            (part["category_id"]): round(float(part["amount"]), 2)
            for part in get_split_parts(conn, txn_id)
        }

    def _row(self, conn, txn_id):
        return conn.execute(
            "SELECT category_id, category_source, category_overridden, is_split FROM txn WHERE id = ?",
            (txn_id,),
        ).fetchone()


class ReceivableArithmeticTests(ReimbursementTestCase):
    def test_split_row_is_read_from_its_parts(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 375.0)

    def test_unsplit_row_is_read_from_its_own_category(self):
        with self._db() as conn:
            txn_id = self._txn(conn, amount=500.0, category=self.receivable)
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 500.0)

    def test_row_with_no_receivable_contributes_nothing(self):
        with self._db() as conn:
            txn_id = self._txn(conn, amount=42.0, category=self.groceries)
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 0.0)

    def test_split_with_no_receivable_part_does_not_fall_back_to_the_row(self):
        # The seam's robustness rule: substitution keys on whether allocation rows *matched*, not on
        # the flag. A split row whose parts are all ordinary must read 0, not its full amount — the
        # naive COALESCE(part, txn.category) would report the whole purchase as owed back.
        with self._db() as conn:
            txn_id = self._txn(conn, amount=90.0, category=self.receivable)
            save_split(
                conn,
                txn_id,
                [
                    {"category_id": self.entertainment, "amount": 50.0},
                    {"category_id": self.groceries, "amount": 40.0},
                ],
            )
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 0.0)


class LinkInvariantTests(ReimbursementTestCase):
    def test_roles_are_derived_from_the_sign(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment), counterparty="Ticket friends")
            roles = {member["txn_id"]: member["role"] for member in link["members"]}
        self.assertEqual(roles[expense], EXPENSE_ROLE)
        self.assertEqual(roles[repayment], REPAYMENT_ROLE)

    def test_a_lone_expense_is_a_valid_reimbursement(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
        self.assertEqual(link["residual"], 375.0)
        self.assertEqual(link["repaid"], 0.0)

    def test_a_transaction_with_no_receivable_share_is_refused(self):
        with self._db() as conn:
            plain = self._txn(conn, amount=20.0, category=self.groceries)
            with self.assertRaises(ReimbursementError) as caught:
                create_reimbursement(conn, self._claims(plain))
        self.assertIn("Reimbursable", str(caught.exception))

    def test_a_transaction_belongs_to_at_most_one_reimbursement(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            create_reimbursement(conn, self._claims(expense))
            with self.assertRaises(ReimbursementError):
                create_reimbursement(conn, self._claims(expense))

    def test_trashed_member_is_listed_but_left_out_of_the_figures(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(link["residual"], 0.0)
            conn.execute("UPDATE txn SET trashed_at = '2026-08-01' WHERE id = ?", (repayment,))
            reloaded = reimbursements_for_txn(conn, expense)[0]
        self.assertEqual(reloaded["residual"], 375.0)
        self.assertIn(repayment, {member["txn_id"] for member in reloaded["members"]})


class ResidualTests(ReimbursementTestCase):
    def _link(self, conn, repaid):
        expense = self._tickets(conn)
        repayment = self._repayment(conn, repaid)
        return expense, repayment, create_reimbursement(conn, self._claims(expense, repayment))

    def test_repaid_in_full_is_square(self):
        with self._db() as conn:
            _, _, link = self._link(conn, 375)
        self.assertEqual(link["residual"], 0.0)

    def test_repaid_short_leaves_a_positive_residual(self):
        with self._db() as conn:
            _, _, link = self._link(conn, 350)
        self.assertEqual(link["residual"], 25.0)

    def test_repaid_over_leaves_a_negative_residual(self):
        with self._db() as conn:
            _, _, link = self._link(conn, 400)
        self.assertEqual(link["residual"], -25.0)


class SettleTests(ReimbursementTestCase):
    def test_shortfall_settles_on_the_expense_and_restates_the_original_period(self):
        # $375 was owed and $350 came back, so $25 of the purchase was genuinely the buyer's cost.
        # February moves from $125 of entertainment to $150 — the restatement is the point.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 350)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            settled = complete(conn, link["id"], category_id=self.entertainment)
            expense_parts = self._parts(conn, expense)
            repayment_row = self._row(conn, repayment)
        self.assertTrue(settled["completed"])
        self.assertEqual(expense_parts[self.entertainment], 150.0)
        self.assertEqual(expense_parts[self.receivable], 350.0)
        self.assertEqual(settled["residual"], 0.0)
        # The repayment is untouched: only one side of a reimbursement ever carries the residual.
        self.assertEqual(repayment_row["category_id"], self.receivable)
        self.assertEqual(repayment_row["is_split"], 0)

    def test_surplus_settles_on_the_repayment_and_leaves_february_alone(self):
        # Resold at a profit: $400 came back against $375 owed. The gain was realized in July, so July
        # is where it lands — booking it into February would claim a gain in a month where nothing had
        # yet gone right.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 400)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            complete(conn, link["id"], category_id=self.entertainment)
            expense_parts = self._parts(conn, expense)
            repayment_parts = self._parts(conn, repayment)
        self.assertEqual(expense_parts, {self.entertainment: 125.0, self.receivable: 375.0})
        self.assertEqual(repayment_parts, {self.receivable: -375.0, self.entertainment: -25.0})

    def test_surplus_larger_than_the_buyers_own_share_needs_no_mixed_sign_allocation(self):
        # The case that would force a mixed-sign split if every residual settled on the expense:
        # $520 back against $375 owed is a $145 gain, and the buyer's own portion was only $125, so the
        # expense's entertainment part would have to go to -$20. On the repayment every part stays
        # negative at any magnitude. Do not "simplify" settlement to always target the expense.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 520)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(link["residual"], -145.0)
            complete(conn, link["id"], category_id=self.entertainment)
            repayment_parts = self._parts(conn, repayment)
        self.assertEqual(repayment_parts, {self.receivable: -375.0, self.entertainment: -145.0})
        self.assertTrue(all(amount < 0 for amount in repayment_parts.values()))

    def test_a_surplus_cannot_be_forced_onto_the_expense(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 400)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.entertainment, target_txn_id=expense)
        self.assertIn("a surplus against a repayment", str(caught.exception))

    def test_never_repaid_partial_split_collapses_to_the_real_category(self):
        # Nobody paid; the whole $500 was really spent on entertainment in February.
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            row = self._row(conn, expense)
            parts = get_split_parts(conn, expense)
        self.assertEqual(parts, [], "a single remaining allocation must collapse, not sit as a split")
        self.assertEqual(row["is_split"], 0)
        self.assertEqual(row["category_id"], self.entertainment)
        self.assertEqual(row["category_source"], "manual")

    def test_never_repaid_wholly_reimbursable_row_is_simply_recategorized(self):
        with self._db() as conn:
            expense = self._txn(conn, amount=500.0, category=self.receivable)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            row = self._row(conn, expense)
        self.assertEqual(row["is_split"], 0)
        self.assertEqual(row["category_id"], self.entertainment)

    def test_settling_into_the_holding_group_is_refused(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.receivable)
        self.assertIn("move out of the Reimbursable group", str(caught.exception))

    def test_settling_into_a_group_is_refused(self):
        with self._db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE name = 'Entertainment' AND parent_id IS NULL"
            ).fetchone()["id"]
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=group)
        self.assertIn("not a group", str(caught.exception))

    def test_repaid_in_full_completes_with_nothing_to_move(self):
        # The commonest happy ending, and it was unreachable while "already square" was an error: the
        # record stayed on the open list forever with no action that could finish it. Completing moves
        # nothing — the two sides already cancel inside the excluded group — and asks for no category.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(link["residual"], 0.0)
            done = complete(conn, link["id"])
            parts = self._parts(conn, expense)
            repayment_row = self._row(conn, repayment)
        self.assertTrue(done["completed"])
        self.assertEqual(done["residual"], 0.0)
        # Nothing about either transaction changed.
        self.assertEqual(parts, {self.entertainment: 125.0, self.receivable: 375.0})
        self.assertEqual(repayment_row["category_id"], self.receivable)

    def test_a_completed_reimbursement_drops_off_the_open_list(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(len(outstanding(conn)["reimbursements"]), 1)
            complete(conn, link["id"])
            report = outstanding(conn)
        self.assertEqual(report["reimbursements"], [])
        # And the headline figure is unaffected, because a completed one's claims sum to zero.
        self.assertEqual(report["total"], 0.0)

    def test_completing_with_nothing_to_move_can_be_reopened(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            complete(conn, link["id"])
            reopened = reopen(conn, link["id"])
            parts = self._parts(conn, expense)
        self.assertFalse(reopened["completed"])
        self.assertEqual(reopened["residual"], 0.0)
        self.assertEqual(parts, {self.entertainment: 125.0, self.receivable: 375.0})

    def _two_expenses(self, conn, first, second, repaid):
        """One payment covering two receipts — the work-expenses shape."""
        a = self._txn(conn, amount=first, category=self.receivable, name="Receipt A")
        b = self._txn(conn, amount=second, category=self.receivable, name="Receipt B")
        repayment = self._repayment(conn, repaid)
        return a, b, create_reimbursement(conn, self._claims(a, b, repayment))

    def test_several_expenses_require_the_user_to_choose(self):
        with self._db() as conn:
            _, _, link = self._two_expenses(conn, 100.0, 300.0, 350)
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.groceries)
        self.assertIn("choose which one", str(caught.exception))

    def test_a_named_target_absorbs_the_residual(self):
        with self._db() as conn:
            a, _, link = self._two_expenses(conn, 100.0, 300.0, 350)
            complete(conn, link["id"], category_id=self.groceries, target_txn_id=a)
            parts = self._parts(conn, a)
        self.assertEqual(parts, {self.receivable: 50.0, self.groceries: 50.0})

    def test_a_target_too_small_for_the_residual_is_refused(self):
        with self._db() as conn:
            a, _, link = self._two_expenses(conn, 20.0, 300.0, 270)
            self.assertEqual(link["residual"], 50.0)
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.groceries, target_txn_id=a)
        self.assertIn("portion of that transaction is smaller", str(caught.exception))


class UnsettleTests(ReimbursementTestCase):
    def test_round_trips_a_split_expense_exactly(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 350)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            before_parts = self._parts(conn, expense)
            before_row = dict(self._row(conn, expense))
            complete(conn, link["id"], category_id=self.entertainment)
            reopened = reopen(conn, link["id"])
            after_parts = self._parts(conn, expense)
            after_row = dict(self._row(conn, expense))
        self.assertEqual(after_parts, before_parts)
        self.assertEqual(after_row, before_row)
        self.assertFalse(reopened["completed"])
        self.assertEqual(reopened["residual"], 25.0)

    def test_round_trips_a_row_that_settlement_had_collapsed(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            before_parts = self._parts(conn, expense)
            before_row = dict(self._row(conn, expense))
            complete(conn, link["id"], category_id=self.entertainment)
            self.assertEqual(get_split_parts(conn, expense), [])
            reopen(conn, link["id"])
            after_parts = self._parts(conn, expense)
            after_row = dict(self._row(conn, expense))
        self.assertEqual(after_parts, before_parts)
        self.assertEqual(after_row, before_row)

    def test_round_trips_a_repayment_that_settlement_had_split(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 400)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            before_row = dict(self._row(conn, repayment))
            complete(conn, link["id"], category_id=self.entertainment)
            self.assertEqual(len(get_split_parts(conn, repayment)), 2)
            reopen(conn, link["id"])
            after_row = dict(self._row(conn, repayment))
            self.assertEqual(get_split_parts(conn, repayment), [])
        self.assertEqual(after_row, before_row)

    def test_a_settled_reimbursement_refuses_edits_until_it_is_reopened(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            other = self._txn(conn, amount=-40.0, category=self.receivable, name="Late repayment")
            with self.assertRaises(ReimbursementError):
                add_claims(conn, link["id"], self._claims(other))


class OutstandingReportTests(ReimbursementTestCase):
    def _group_balance(self, conn) -> float:
        """The receivable group's own balance, read the way a report reads any category rollup: through
        the split expansion, per allocation. The report's headline total has to equal this or the
        "outstanding is just the category's sum" claim is not true."""
        leaves = reimbursable_leaf_ids(conn)
        places = ",".join("?" for _ in leaves)
        from_parts = conn.execute(
            f"SELECT COALESCE(SUM(s.amount), 0) AS total FROM txn_split s "
            f"JOIN txn t ON t.id = s.txn_id "
            f"WHERE t.trashed_at IS NULL AND s.category_id IN ({places})",
            leaves,
        ).fetchone()["total"]
        from_rows = conn.execute(
            f"SELECT COALESCE(SUM(t.amount), 0) AS total FROM txn t "
            f"WHERE t.trashed_at IS NULL AND t.is_split = 0 AND t.category_id IN ({places})",
            leaves,
        ).fetchone()["total"]
        return round(float(from_parts) + float(from_rows), 2)

    def test_total_equals_the_receivable_group_balance(self):
        with self._db() as conn:
            linked_expense = self._tickets(conn)
            repayment = self._repayment(conn, 350)
            create_reimbursement(conn, self._claims(linked_expense, repayment))
            self._txn(conn, amount=80.0, category=self.receivable, name="Loose receipt")
            report = outstanding(conn)
            balance = self._group_balance(conn)
        self.assertEqual(report["total"], balance)
        self.assertEqual(report["total"], 105.0)

    def test_linked_and_loose_receivables_are_kept_apart(self):
        with self._db() as conn:
            linked_expense = self._tickets(conn)
            create_reimbursement(conn, self._claims(linked_expense))
            loose = self._txn(conn, amount=80.0, category=self.receivable, name="Loose receipt")
            report = outstanding(conn)
        self.assertEqual([row["txn_id"] for row in report["loose"]], [loose])
        self.assertEqual(len(report["reimbursements"]), 1)
        self.assertEqual(report["reimbursements"][0]["residual"], 375.0)

    def test_a_settled_reimbursement_stops_contributing(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            report = outstanding(conn)
            balance = self._group_balance(conn)
        self.assertEqual(report["total"], 0.0)
        self.assertEqual(balance, 0.0)


class GroupGuardTests(ReimbursementTestCase):
    """The holding group is machinery. Both guards are flat rather than conditional on whether it
    currently holds anything — a gate on present state produces a control that works on some days and
    not others, and the delete never durably worked anyway (seeding restores the group at next start)."""

    def _group_id(self):
        with self._db() as conn:
            return find_reimbursable_group_id(conn)

    def test_the_group_is_seeded_with_a_system_key_and_excluded(self):
        with self._db() as conn:
            row = conn.execute(
                "SELECT name, system_key, exclude_from_totals, parent_id FROM category WHERE system_key = ?",
                (REIMBURSABLE_SYSTEM_KEY,),
            ).fetchone()
        self.assertEqual(row["name"], REIMBURSABLE_GROUP)
        self.assertIsNone(row["parent_id"])
        self.assertEqual(row["exclude_from_totals"], 1)

    def test_the_group_cannot_be_deleted(self):
        from fastapi import HTTPException

        from backend.routers.categories import delete_category

        token = set_current_db_path(str(self.db_path))
        try:
            with self.assertRaises(HTTPException) as caught:
                delete_category(self._group_id(), None)
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("cannot be deleted", caught.exception.detail)

    def test_the_groups_exclusion_cannot_be_cleared(self):
        from fastapi import HTTPException

        from backend.routers.categories import CategoryUpdate, update_category

        token = set_current_db_path(str(self.db_path))
        try:
            with self.assertRaises(HTTPException) as caught:
                update_category(self._group_id(), CategoryUpdate(exclude_from_totals=0))
            # Renaming stays open: the feature resolves the group by key, so what it is called is the
            # user's business and only the exclusion is load-bearing.
            update_category(self._group_id(), CategoryUpdate(name="Owed back"))
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)
        with self._db() as conn:
            row = conn.execute(
                "SELECT name, exclude_from_totals FROM category WHERE system_key = ?",
                (REIMBURSABLE_SYSTEM_KEY,),
            ).fetchone()
            self.assertEqual(row["exclude_from_totals"], 1)
            self.assertEqual(row["name"], "Owed back")
            # A rename must not lose the feature its group — the whole reason the key is the anchor.
            self.assertEqual(find_reimbursable_group_id(conn), self._group_id_direct(conn))

    def _group_id_direct(self, conn):
        return conn.execute(
            "SELECT id FROM category WHERE system_key = ?", (REIMBURSABLE_SYSTEM_KEY,)
        ).fetchone()["id"]

    def test_the_group_cannot_be_moved_inside_another_group(self):
        # Reparenting turns the group into a leaf, and every lookup that finds it requires
        # `parent_id IS NULL`. Left open, the next write creates a *second* group while the outstanding
        # balance stays stranded under the moved row, and the report reads zero having visibly done
        # nothing wrong. Asserted end to end rather than on the 400 alone, because the refusal only
        # matters for what it prevents.
        from fastapi import HTTPException

        from backend.routers.categories import CategoryUpdate, update_category

        group_id = self._group_id()
        token = set_current_db_path(str(self.db_path))
        try:
            with self._db() as conn:
                shopping = conn.execute(
                    "SELECT id FROM category WHERE name = 'Shopping' AND parent_id IS NULL"
                ).fetchone()["id"]
            with self.assertRaises(HTTPException) as caught:
                update_category(group_id, CategoryUpdate(parent_id=shopping))
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)
        with self._db() as conn:
            self.assertEqual(find_reimbursable_group_id(conn), group_id)
            self.assertEqual(reimbursable_leaf_ids(conn), [self.receivable])
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS n FROM category WHERE system_key = ?",
                    (REIMBURSABLE_SYSTEM_KEY,),
                ).fetchone()["n"],
                1,
            )

    def test_a_leaf_may_still_be_moved_into_the_group(self):
        # The guard stops at the group. Dragging an ordinary category in makes it a receivable leaf,
        # which is exactly what "the feature keys on the group" is meant to allow.
        from backend.routers.categories import CategoryUpdate, update_category

        group_id = self._group_id()
        token = set_current_db_path(str(self.db_path))
        try:
            update_category(self.groceries, CategoryUpdate(parent_id=group_id))
        finally:
            reset_current_db_path(token)
        with self._db() as conn:
            self.assertIn(self.groceries, reimbursable_leaf_ids(conn))

    def test_leaves_inside_the_group_stay_the_users_to_manage(self):
        # The guards stop at the group: a leaf cannot opt itself back into totals anyway, because
        # exclude_from_totals is NOT NULL so an existing parent always wins COALESCE(parent, leaf).
        from backend.routers.categories import CategoryUpdate, update_category

        token = set_current_db_path(str(self.db_path))
        try:
            update_category(self.receivable, CategoryUpdate(name="Owed by friends"))
            update_category(self.receivable, CategoryUpdate(exclude_from_totals=0))
        finally:
            reset_current_db_path(token)
        with self._db() as conn:
            row = conn.execute(
                "SELECT c.name, COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) AS effective "
                "FROM category c LEFT JOIN category p ON p.id = c.parent_id WHERE c.id = ?",
                (self.receivable,),
            ).fetchone()
        self.assertEqual(row["name"], "Owed by friends")
        self.assertEqual(row["effective"], 1)


class ApiContractTests(unittest.TestCase):
    """The endpoints through the full stack — routing, serialization, and the 400s the screen shows.

    Worth doing over the real client rather than by calling the router functions: `/outstanding` is a
    literal path declared alongside `/{link_id}`, so only real routing proves the collection read is not
    being swallowed as a lookup of a reimbursement whose id happens to be "outstanding".
    """

    def _seed(self, path):
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        account = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO account (id, external_account_id, provider, name, display_name, type, "
            "subtype, mask, owner_id) VALUES (?,?,'fixture_reimb_api','Everyday','Everyday',"
            "'checking','checking','0000',?)",
            (account, f"acct_{account}", SHARED_OWNER_ID),
        )
        group = conn.execute(
            "SELECT id FROM category WHERE name = 'Entertainment' AND parent_id IS NULL"
        ).fetchone()["id"]
        entertainment = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?,?,?,?,0)",
            (entertainment, group, "Movies & Events", "expense"),
        )
        receivable_group = conn.execute(
            "SELECT id FROM category WHERE system_key = ?", (REIMBURSABLE_SYSTEM_KEY,)
        ).fetchone()["id"]
        receivable = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, sort_order) "
            "VALUES (?,?,?,?,1,0)",
            (receivable, receivable_group, "Awaiting reimbursement", "expense"),
        )

        def txn(amount, date, category, name):
            txn_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
                "display_name, raw_name, date, is_pending, category_overridden) "
                "VALUES (?,?,?,?,?,?,?,?,?,0,0)",
                (txn_id, account, SHARED_OWNER_ID, category, amount, name, name, name, date),
            )
            return txn_id

        expense = txn(500.0, "2026-02-14", receivable, "Concert Tickets")
        repayment = txn(-350.0, "2026-07-03", receivable, "Repayment")
        conn.commit()
        conn.close()
        return {"expense": expense, "repayment": repayment, "entertainment": entertainment}

    def test_create_settle_and_reverse_round_trip(self):
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post(
                "/api/reimbursements",
                json={
                    "claims": [{"txn_id": seeded["expense"]}, {"txn_id": seeded["repayment"]}],
                    "counterparty": "Friends",
                },
            )
            self.assertEqual(created.status_code, 200, created.text)
            link = created.json()
            self.assertEqual(link["residual"], 150.0)
            self.assertEqual(link["counterparty"], "Friends")

            listed = client.get("/api/reimbursements/outstanding")
            self.assertEqual(listed.status_code, 200, listed.text)
            self.assertEqual(listed.json()["total"], 150.0)
            self.assertEqual(len(listed.json()["reimbursements"]), 1)

            settled = client.post(
                f"/api/reimbursements/{link['id']}/complete",
                json={"category_id": seeded["entertainment"]},
            )
            self.assertEqual(settled.status_code, 200, settled.text)
            self.assertTrue(settled.json()["completed"])
            self.assertEqual(client.get("/api/reimbursements/outstanding").json()["total"], 0.0)

            reopened = client.delete(f"/api/reimbursements/{link['id']}/complete")
            self.assertEqual(reopened.status_code, 200, reopened.text)
            self.assertEqual(reopened.json()["residual"], 150.0)
            self.assertEqual(client.get("/api/reimbursements/outstanding").json()["total"], 150.0)

    def test_the_literal_settings_and_due_paths_are_not_swallowed_as_lookups(self):
        # Same hazard as `/outstanding`: both are declared alongside `/{link_id}`, so only real routing
        # proves they are not being read as a reimbursement whose id happens to be "settings".
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            self._seed(path)
            settings = client.get("/api/reimbursements/settings")
            self.assertEqual(settings.status_code, 200, settings.text)
            self.assertEqual(settings.json()["reminder_days"], 30)

            due = client.get("/api/reimbursements/due")
            self.assertEqual(due.status_code, 200, due.text)
            # The seeded expense is dated 2026-02-14 and untracked, so it is loose and long overdue.
            self.assertEqual(due.json()["total"], 1)

    def test_the_reminder_default_round_trips_and_bounds_are_enforced(self):
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            self._seed(path)
            saved = client.put("/api/reimbursements/settings", json={"reminder_days": 45})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["reminder_days"], 45)
            self.assertEqual(client.get("/api/reimbursements/settings").json()["reminder_days"], 45)
            # Zero is the disable switch, not an invalid value.
            self.assertEqual(
                client.put("/api/reimbursements/settings", json={"reminder_days": 0}).json()["reminder_days"], 0
            )
            self.assertEqual(client.get("/api/reimbursements/due").json()["total"], 0)
            refused = client.put("/api/reimbursements/settings", json={"reminder_days": -1})
            self.assertEqual(refused.status_code, 400, refused.text)

    def test_a_reminder_date_round_trips_through_the_patch(self):
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post(
                "/api/reimbursements", json={"claims": [{"txn_id": seeded["expense"]}]}
            ).json()
            self.assertIsNone(created["remind_on"])
            dated = client.patch(
                f"/api/reimbursements/{created['id']}",
                json={"counterparty": "Friends", "remind_on": "2026-12-01"},
            )
            self.assertEqual(dated.status_code, 200, dated.text)
            self.assertEqual(dated.json()["remind_on"], "2026-12-01")
            self.assertEqual(client.get("/api/reimbursements/due").json()["total"], 0)

            off = client.patch(
                f"/api/reimbursements/{created['id']}",
                json={"counterparty": "Friends", "clear_reminder": True},
            )
            self.assertEqual(off.json()["remind_on"], "")

    def test_a_record_is_created_with_its_name_and_reminder_in_one_request(self):
        # What the editor's draft sends on Save: nothing exists until then, so the name and reminder must
        # arrive with the claims rather than in a second write that could fail after the first.
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            seeded = self._seed(path)
            dated = client.post("/api/reimbursements", json={
                "claims": [{"txn_id": seeded["expense"]}],
                "counterparty": "Friends",
                "remind_on": "2026-12-01",
            })
            self.assertEqual(dated.status_code, 200, dated.text)
            self.assertEqual(dated.json()["counterparty"], "Friends")
            self.assertEqual(dated.json()["remind_on"], "2026-12-01")

            client.delete(f"/api/reimbursements/{dated.json()['id']}")
            off = client.post("/api/reimbursements", json={
                "claims": [{"txn_id": seeded["expense"]}],
                "clear_reminder": True,
            })
            self.assertEqual(off.json()["remind_on"], "")

    def test_a_portion_moves_between_records_over_the_api(self):
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            seeded = self._seed(path)
            wrong = client.post(
                "/api/reimbursements",
                json={"claims": [{"txn_id": seeded["repayment"]}], "counterparty": "Wrong"},
            ).json()
            right = client.post(
                "/api/reimbursements",
                json={"claims": [{"txn_id": seeded["expense"]}], "counterparty": "Right"},
            ).json()
            moved = client.post(
                f"/api/reimbursements/{right['id']}/transactions/move",
                json={"txn_id": seeded["repayment"], "from_link_id": wrong["id"]},
            )
            self.assertEqual(moved.status_code, 200, moved.text)
            self.assertEqual(moved.json()["repaid"], -350.0)
            self.assertTrue(moved.json()["moved_from"]["deleted"])
            self.assertEqual(client.get(f"/api/reimbursements/{wrong['id']}").status_code, 404)

    def test_a_broken_invariant_comes_back_as_a_400_the_screen_can_show(self):
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post(
                "/api/reimbursements", json={"claims": [{"txn_id": seeded["expense"]}]}
            ).json()
            refused = client.post(
                f"/api/reimbursements/{created['id']}/complete",
                json={"category_id": seeded["entertainment"], "target_txn_id": seeded["repayment"]},
            )
            self.assertEqual(refused.status_code, 400)
            self.assertIn("cannot carry this residual", refused.json()["detail"])


class SharesOfOneTransactionTests(ReimbursementTestCase):
    """One ledger row serving two independent debts — the case that made portions rather than rows the
    unit, and which the first implementation could not express at all.

    Splits exist so a single row can mean several things, so both of these are ordinary use of the
    feature this one is built on rather than edge cases: a charge divided between two friends, and one
    deposit repaying two of them at once.
    """

    def _three_way_charge(self, conn):
        """$750 on three $250 tickets — one the buyer's, two owed by different people."""
        txn_id = self._txn(conn, amount=750.0)
        save_split(conn, txn_id, [
            {"category_id": self.entertainment, "amount": 250.0, "label": "My ticket"},
            {"category_id": self.receivable, "amount": 250.0, "label": "Dana's ticket"},
            {"category_id": self.receivable, "amount": 250.0, "label": "Rowan's ticket"},
        ])
        return txn_id

    def _split_deposit(self, conn, first, second, other):
        """One ATM deposit carrying repayments for two separate debts, plus unrelated money."""
        total = -round(first + second + other, 2)
        txn_id = self._txn(conn, amount=total, date="2026-07-03", name="ATM Deposit")
        save_split(conn, txn_id, [
            {"category_id": self.receivable, "amount": -first, "label": "From Dana"},
            {"category_id": self.receivable, "amount": -second, "label": "From Rowan"},
            {"category_id": self.groceries, "amount": -other, "label": "Change"},
        ])
        return txn_id

    def test_the_shares_of_one_charge_are_offered_individually(self):
        # The report used to sum a row's receivable parts into one figure, so a charge split between two
        # people looked like a single $500 debt and could only ever be tracked as one.
        with self._db() as conn:
            _charge = self._three_way_charge(conn)
            report = outstanding(conn)
        [row] = report["loose"]
        self.assertEqual(row["unclaimed"], 500.0)
        self.assertEqual(
            [(part["label"], part["amount"]) for part in row["parts"]],
            [("Dana's ticket", 250.0), ("Rowan's ticket", 250.0)],
        )

    def test_one_charge_can_carry_two_reimbursements_with_different_counterparties(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            dana = create_reimbursement(
                conn, [{"txn_id": charge, "amount": 250.0, "label": "Dana's ticket"}],
                counterparty="Dana",
            )
            rowan = create_reimbursement(
                conn, [{"txn_id": charge, "amount": 250.0, "label": "Rowan's ticket"}],
                counterparty="Rowan",
            )
            unclaimed = unclaimed_amounts(conn, [charge])[charge]
            tracked = reimbursements_for_txn(conn, charge)
        self.assertEqual(dana["residual"], 250.0)
        self.assertEqual(rowan["residual"], 250.0)
        self.assertEqual(unclaimed, 0.0)
        self.assertEqual({r["counterparty"] for r in tracked}, {"Dana", "Rowan"})

    def test_claims_cannot_together_exceed_what_the_row_holds(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Dana")
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Rowan")
            with self.assertRaises(ReimbursementError) as caught:
                create_reimbursement(conn, [{"txn_id": charge}], counterparty="Nobody")
        self.assertIn("already claimed by another reimbursement", str(caught.exception))

    def test_an_unstated_amount_claims_only_what_is_left(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Dana")
            # No amount given: takes the remaining $250 rather than the row's whole $500.
            rest = create_reimbursement(conn, [{"txn_id": charge}], counterparty="Rowan")
        self.assertEqual(rest["residual"], 250.0)

    def test_one_deposit_repays_two_separate_debts(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            deposit = self._split_deposit(conn, 250.0, 200.0, 150.0)
            dana = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0, "label": "Dana's ticket"},
                {"txn_id": deposit, "amount": -250.0, "label": "From Dana"},
            ], counterparty="Dana")
            rowan = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0, "label": "Rowan's ticket"},
                {"txn_id": deposit, "amount": -200.0, "label": "From Rowan"},
            ], counterparty="Rowan")
        self.assertEqual(dana["residual"], 0.0, "Dana paid in full")
        self.assertEqual(rowan["residual"], 50.0, "Rowan is $50 short")
        self.assertEqual({m["role"] for m in dana["members"]}, {EXPENSE_ROLE, REPAYMENT_ROLE})

    def test_settling_one_share_leaves_the_other_untouched(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            deposit = self._split_deposit(conn, 250.0, 200.0, 150.0)
            _dana = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0}, {"txn_id": deposit, "amount": -250.0},
            ], counterparty="Dana")
            rowan = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0}, {"txn_id": deposit, "amount": -200.0},
            ], counterparty="Rowan")

            complete(conn, rowan["id"], category_id=self.entertainment, target_txn_id=charge)

            after_dana = reimbursements_for_txn(conn, charge)
            dana_after = next(r for r in after_dana if r["counterparty"] == "Dana")
            parts = self._parts(conn, charge)
            receivable = receivable_amounts(conn, [charge])[charge]
            unclaimed = unclaimed_amounts(conn, [charge])[charge]

        # Rowan's $50 shortfall became real spending in the month of the charge.
        self.assertEqual(parts[self.entertainment], 300.0)
        self.assertEqual(receivable, 450.0)
        # Dana's side is exactly as it was, and the row's claims still add up to its receivable.
        self.assertEqual(dana_after["residual"], 0.0)
        self.assertEqual(unclaimed, 0.0)

    def test_the_report_total_still_equals_the_group_balance_with_shares_in_play(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            deposit = self._split_deposit(conn, 250.0, 200.0, 150.0)
            create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0}, {"txn_id": deposit, "amount": -250.0},
            ], counterparty="Dana")
            # Rowan's repayment portion is left unlinked, so it has to show up as loose rather than
            # vanishing between the two piles.
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Rowan")
            report = outstanding(conn)
            leaves = reimbursable_leaf_ids(conn)
            places = ",".join("?" for _ in leaves)
            balance = conn.execute(
                f"SELECT COALESCE(SUM(s.amount), 0) AS total FROM txn_split s JOIN txn t ON t.id = s.txn_id "
                f"WHERE t.trashed_at IS NULL AND s.category_id IN ({places})",
                leaves,
            ).fetchone()["total"]
        self.assertEqual(report["total"], round(float(balance), 2))
        self.assertEqual([row["unclaimed"] for row in report["loose"]], [-200.0])


class ReminderTests(ReimbursementTestCase):
    """When a receivable starts asking to be chased, and whose reminder it is.

    The clock runs from the **transaction's** date rather than from the record's creation, which is the
    half most likely to be got wrong: a record made today for a charge in February is already months
    overdue, and dating it from the record would let tidying up postpone the reminder indefinitely.
    """

    def _due_ids(self, conn, today="2026-09-03"):
        report = due_reminders(conn, today=today)
        return report["total"], {group["owner_id"] for group in report["groups"]}

    def test_an_old_expense_comes_due_on_the_default_gap(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            # The charge is 2026-02-14 and the default gap is 30 days, so it is long past due.
            total, _ = self._due_ids(conn)
        self.assertEqual(total, 1)

    def test_a_recent_expense_is_not_due_yet(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            total, _ = self._due_ids(conn, today="2026-02-20")
        self.assertEqual(total, 0)

    def test_the_clock_runs_from_the_expense_not_from_the_record(self):
        # The record is made months after the charge. It must be due immediately rather than starting a
        # fresh 30 days, or tidying up would keep pushing the reminder away.
        with self._db() as conn:
            txn_id = self._tickets(conn)
            create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            total, _ = self._due_ids(conn, today="2026-03-16")
        self.assertEqual(total, 1)

    def test_a_repayment_arriving_does_not_restart_the_clock(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            repayment = self._repayment(conn, 100, date="2026-09-01")
            create_reimbursement(conn, [
                {"txn_id": txn_id, "amount": 375.0}, {"txn_id": repayment, "amount": -100.0},
            ], counterparty="Dana")
            total, _ = self._due_ids(conn)
        self.assertEqual(total, 1)

    def test_a_records_own_date_overrides_the_default(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            record = create_reimbursement(conn, self._claims(txn_id), counterparty="Concert")
            update_reimbursement(conn, record["id"], counterparty="Concert", remind_on="2026-12-01")
            self.assertEqual(self._due_ids(conn)[0], 0)
            self.assertEqual(self._due_ids(conn, today="2026-12-02")[0], 1)

    def test_a_record_can_switch_its_reminder_off(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            record = create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            update_reimbursement(conn, record["id"], counterparty="Dana", clear_reminder=True)
            self.assertEqual(self._due_ids(conn)[0], 0)

    def test_switching_off_survives_a_later_save(self):
        # "Off" and "follow the default" are different answers. Collapsing them into one empty value
        # would make a switched-off reminder quietly return on the next unrelated edit.
        with self._db() as conn:
            txn_id = self._tickets(conn)
            record = create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            update_reimbursement(conn, record["id"], counterparty="Dana", clear_reminder=True)
            update_reimbursement(conn, record["id"], counterparty="Dana Renamed")
            self.assertEqual(self._due_ids(conn)[0], 0)

    def test_a_record_can_go_back_to_following_the_default(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            record = create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            update_reimbursement(conn, record["id"], counterparty="Dana", clear_reminder=True)
            update_reimbursement(conn, record["id"], counterparty="Dana", follow_default_reminder=True)
            self.assertEqual(self._due_ids(conn)[0], 1)

    def test_a_reminder_survives_claims_being_added(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            record = create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            update_reimbursement(conn, record["id"], counterparty="Dana", remind_on="2026-12-01")
            repayment = self._repayment(conn, 100)
            updated = add_claims(conn, record["id"], [{"txn_id": repayment, "amount": -100.0}])
        self.assertEqual(updated["remind_on"], "2026-12-01")

    def test_a_reminder_survives_completing_and_reopening(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            record = create_reimbursement(conn, self._claims(txn_id, repayment), counterparty="Dana")
            update_reimbursement(conn, record["id"], counterparty="Dana", remind_on="2026-12-01")
            completed = complete(conn, record["id"])
            self.assertEqual(completed["remind_on"], "2026-12-01")
            self.assertEqual(reopen(conn, record["id"])["remind_on"], "2026-12-01")

    def test_a_completed_reimbursement_stops_being_due(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            record = create_reimbursement(conn, self._claims(txn_id, repayment), counterparty="Dana")
            self.assertEqual(self._due_ids(conn)[0], 0)  # square, so nothing is owed
            complete(conn, record["id"])
            self.assertEqual(self._due_ids(conn)[0], 0)

    def test_a_surplus_is_never_due(self):
        # Repaid over is a gain waiting to be booked, not money to chase. Chasing it would be the
        # feature telling the user to go and collect something they already have.
        with self._db() as conn:
            txn_id = self._tickets(conn)
            repayment = self._repayment(conn, 400)
            create_reimbursement(conn, self._claims(txn_id, repayment), counterparty="Dana")
            self.assertEqual(self._due_ids(conn)[0], 0)

    def test_loose_receivable_comes_due_on_the_default(self):
        with self._db() as conn:
            self._tickets(conn)  # never tracked; it is loose receivable money
            total, _ = self._due_ids(conn)
        self.assertEqual(total, 1)

    def test_an_unmatched_credit_is_not_due(self):
        # Money in that nothing has claimed is not under-reported spending; there is nothing to chase.
        with self._db() as conn:
            self._repayment(conn, 375, date="2026-02-01")
            total, _ = self._due_ids(conn)
        self.assertEqual(total, 0)

    def test_a_zero_default_switches_the_signal_off(self):
        with self._db() as conn:
            self._tickets(conn)
            set_default_reminder_days(conn, 0)
            try:
                self.assertEqual(self._due_ids(conn)[0], 0)
            finally:
                set_default_reminder_days(conn, DEFAULT_REMINDER_DAYS)

    def test_a_record_keeps_its_own_date_when_the_default_is_off(self):
        # The disable switch must not be a dead end: an explicit date still fires.
        with self._db() as conn:
            txn_id = self._tickets(conn)
            record = create_reimbursement(conn, self._claims(txn_id), counterparty="Dana")
            update_reimbursement(conn, record["id"], counterparty="Dana", remind_on="2026-03-01")
            set_default_reminder_days(conn, 0)
            try:
                self.assertEqual(self._due_ids(conn)[0], 1)
            finally:
                set_default_reminder_days(conn, DEFAULT_REMINDER_DAYS)


class ReminderOwnerTests(ReimbursementTestCase):
    """Whose reminder it is. Grouping reads `txn.owner_id` — the axis every owner filter uses — and
    attributes a record to the owners of its **expense** side, since the question is who is owed."""

    def setUp(self):
        super().setUp()
        with self._db() as conn:
            self.alex = str(uuid.uuid4())
            self.robin = str(uuid.uuid4())
            conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Alex')", (self.alex,))
            conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Robin')", (self.robin,))
            self.alex_account = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO account (id, external_account_id, provider, name, display_name, type, "
                "subtype, mask, owner_id) VALUES (?, ?, 'fixture_reimb', 'Harborline Card', "
                "'Harborline Card', 'credit', 'credit card', '1111', ?)",
                (self.alex_account, f"acct_{self.alex_account}", self.alex),
            )

    def _owned_txn(self, conn, owner_id, *, amount, date="2026-02-14"):
        txn_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
            "display_name, raw_name, date, is_pending, category_overridden) "
            "VALUES (?,?,?,?,?,'Tickets','Tickets','Tickets',?,0,0)",
            (txn_id, self.alex_account, owner_id, self.receivable, amount, date),
        )
        return txn_id

    def test_grouping_applies_once_the_household_has_two_people(self):
        with self._db() as conn:
            self.assertTrue(owner_grouping_applies(conn))

    def test_a_lone_personal_owner_is_not_grouped(self):
        # `ensure_shared_owner` mints a built-in Shared row the first time the Owners page is opened, so
        # "any owner exists" would split a single-person install into groups saying the same thing.
        with self._db() as conn:
            conn.execute("DELETE FROM owner WHERE id = ?", (self.robin,))
            self.assertFalse(owner_grouping_applies(conn))

    def test_a_reminder_is_attributed_to_the_owner_of_the_expense(self):
        with self._db() as conn:
            expense = self._owned_txn(conn, self.alex, amount=375.0)
            create_reimbursement(conn, self._claims(expense), counterparty="Dana")
            groups = due_reminders(conn, today="2026-09-03")["groups"]
        self.assertEqual([(g["owner_id"], g["count"]) for g in groups], [(self.alex, 1)])

    def test_the_repayment_side_does_not_decide_whose_it_is(self):
        # An expense on one person's card repaid into another's account is the owed person's reminder.
        with self._db() as conn:
            expense = self._owned_txn(conn, self.alex, amount=375.0)
            repayment = self._owned_txn(conn, self.robin, amount=-100.0, date="2026-03-01")
            create_reimbursement(conn, [
                {"txn_id": expense, "amount": 375.0}, {"txn_id": repayment, "amount": -100.0},
            ], counterparty="Dana")
            groups = due_reminders(conn, today="2026-09-03")["groups"]
        self.assertEqual([g["owner_id"] for g in groups], [self.alex])

    def test_a_record_spanning_two_owners_appears_under_both(self):
        with self._db() as conn:
            mine = self._owned_txn(conn, self.alex, amount=200.0)
            theirs = self._owned_txn(conn, self.robin, amount=175.0)
            create_reimbursement(conn, [
                {"txn_id": mine, "amount": 200.0}, {"txn_id": theirs, "amount": 175.0},
            ], counterparty="Shared trip")
            groups = due_reminders(conn, today="2026-09-03")["groups"]
        self.assertEqual({g["owner_id"] for g in groups}, {self.alex, self.robin})

    def test_an_unowned_row_lands_in_the_unassigned_bucket(self):
        with self._db() as conn:
            orphan = self._owned_txn(conn, None, amount=120.0)
            create_reimbursement(conn, self._claims(orphan), counterparty="Nobody")
            groups = due_reminders(conn, today="2026-09-03")["groups"]
        self.assertEqual([g["owner_id"] for g in groups], [UNASSIGNED_OWNER])


class OutstandingFilterTests(unittest.TestCase):
    """The FilterBar marks the report's entries rather than removing them, reading the filters as the
    ledger does. A record is tested on its expense side, since that is whose debt it is."""

    def _seed(self, path):
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        alex, robin = str(uuid.uuid4()), str(uuid.uuid4())
        conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Alex')", (alex,))
        conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Robin')", (robin,))
        account = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO account (id, external_account_id, provider, name, display_name, type, "
            "subtype, mask, owner_id) VALUES (?,?,'fixture_reimb_filter','Everyday','Everyday',"
            "'checking','checking','0000',?)",
            (account, f"acct_{account}", SHARED_OWNER_ID),
        )
        receivable_group = conn.execute(
            "SELECT id FROM category WHERE system_key = ?", (REIMBURSABLE_SYSTEM_KEY,)
        ).fetchone()["id"]
        receivable = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, sort_order) "
            "VALUES (?,?,'Awaiting reimbursement','expense',1,0)",
            (receivable, receivable_group),
        )

        def txn(owner, amount, date):
            txn_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
                "display_name, raw_name, date, is_pending, category_overridden) "
                "VALUES (?,?,?,?,?,'Tickets','Tickets','Tickets',?,0,0)",
                (txn_id, account, owner, receivable, amount, date),
            )
            return txn_id

        seeded = {
            "alex": alex, "robin": robin,
            "expense": txn(alex, 375.0, "2026-02-14"),
            "repayment": txn(robin, -100.0, "2026-03-01"),
            "loose": txn(robin, 60.0, "2026-05-20"),
        }
        conn.commit()
        conn.close()
        return seeded

    def _report(self, client, **params):
        response = client.get("/api/reimbursements/outstanding", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_entries_are_marked_by_the_filters_and_the_total_stays_whole(self):
        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post("/api/reimbursements", json={"claims": [
                {"txn_id": seeded["expense"]}, {"txn_id": seeded["repayment"]},
            ], "counterparty": "Dana"})
            self.assertEqual(created.status_code, 200, created.text)

            unfiltered = self._report(client)
            self.assertNotIn("filtered", unfiltered)

            # Robin's filter: the record is Alex's debt even though its repayment is on Robin's row.
            robin = self._report(client, owner_ids=seeded["robin"])
            self.assertTrue(robin["filtered"])
            self.assertFalse(robin["reimbursements"][0]["matches_filter"])
            self.assertTrue(robin["loose"][0]["matches_filter"])
            self.assertEqual(robin["total"], unfiltered["total"])

            not_alex = self._report(client, exclude_owner_ids=seeded["alex"])
            self.assertFalse(not_alex["reimbursements"][0]["matches_filter"])

            february = self._report(client, date_start="2026-02-01", date_end="2026-02-28")
            self.assertTrue(february["reimbursements"][0]["matches_filter"])
            self.assertFalse(february["loose"][0]["matches_filter"])


class MoveClaimTests(ReimbursementTestCase):
    """Moving a portion between records — the path out of a row attached to the wrong reimbursement,
    which the ordinary picker cannot offer because it lists unclaimed money only."""

    def test_a_portion_moves_and_empties_its_old_record(self):
        with self._db() as conn:
            charge = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            wrong = create_reimbursement(conn, self._claims(repayment), counterparty="Wrong friend")
            right = create_reimbursement(conn, self._claims(charge), counterparty="Right friend")
            moved = move_claim(conn, right["id"], repayment, wrong["id"])
            self.assertEqual(moved["repaid"], -375.0)
            self.assertTrue(moved["moved_from"]["deleted"])
            with self.assertRaises(ReimbursementError):
                get_reimbursement(conn, wrong["id"])

    def test_the_old_record_survives_when_it_still_holds_something(self):
        with self._db() as conn:
            charge = self._tickets(conn)
            first = self._repayment(conn, 200)
            second = self._repayment(conn, 175, date="2026-07-10")
            source = create_reimbursement(conn, self._claims(first, second), counterparty="Both")
            target = create_reimbursement(conn, self._claims(charge), counterparty="Right friend")
            moved = move_claim(conn, target["id"], second, source["id"])
            self.assertFalse(moved["moved_from"]["deleted"])
            self.assertEqual(get_reimbursement(conn, source["id"])["repaid"], -200.0)

    def test_moving_into_a_record_that_already_covers_the_row_is_refused(self):
        # A record holds one claim per transaction, so this would replace rather than accumulate —
        # silently discarding what the target was already tracking.
        with self._db() as conn:
            deposit = self._txn(conn, amount=-400.0, date="2026-07-03", category=self.receivable)
            source = create_reimbursement(conn, [{"txn_id": deposit, "amount": -150.0}], counterparty="A")
            target = create_reimbursement(conn, [{"txn_id": deposit, "amount": -250.0}], counterparty="B")
            with self.assertRaises(ReimbursementError):
                move_claim(conn, target["id"], deposit, source["id"])

    def test_moving_a_portion_that_is_not_there_is_refused(self):
        with self._db() as conn:
            charge = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            source = create_reimbursement(conn, self._claims(charge), counterparty="A")
            target = create_reimbursement(conn, self._claims(repayment), counterparty="B")
            with self.assertRaises(ReimbursementError):
                move_claim(conn, target["id"], repayment, source["id"])


class ClaimOutlivingItsReceivableTests(unittest.TestCase):
    """A claim is checked when it is made; the receivable it claims can be moved afterwards.

    Every one of these edits used to succeed and corrupt the outstanding report silently — a record
    claiming more than its row still holds reports a residual nobody owes, and a row with nothing left
    in the group drops out of the report entirely while its record stays live, so the headline reads as
    nothing owed. Exercised through the API, because the refusal sits at the endpoints: the service's
    own `save_split` calls are how a settlement rewrites allocations, and a guard inside it would refuse
    the feature's own writes.
    """

    def _seed(self, path):
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        account = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO account (id, external_account_id, provider, name, display_name, type, "
            "subtype, mask, owner_id) VALUES (?,?,'fixture_reimb_guard','Everyday','Everyday',"
            "'checking','checking','0000',?)",
            (account, f"acct_{account}", SHARED_OWNER_ID),
        )
        group = conn.execute(
            "SELECT id FROM category WHERE name = 'Entertainment' AND parent_id IS NULL"
        ).fetchone()["id"]
        entertainment = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?,?,?,?,0)",
            (entertainment, group, "Movies & Events", "expense"),
        )
        receivable_group = conn.execute(
            "SELECT id FROM category WHERE system_key = ?", (REIMBURSABLE_SYSTEM_KEY,)
        ).fetchone()["id"]
        receivable = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, sort_order) "
            "VALUES (?,?,?,'expense',1,0)",
            (receivable, receivable_group, "Concert tickets"),
        )
        conn.commit()
        conn.close()
        return {"account": account, "receivable": receivable, "entertainment": entertainment}

    def _txn(self, path, account, amount, category=None):
        txn_id = str(uuid.uuid4())
        conn = sqlite3.connect(path)
        conn.execute(
            "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
            "display_name, raw_name, date, is_pending, category_overridden) "
            "VALUES (?,?,?,?,?,'Concert Tickets','Concert Tickets','Concert Tickets','2026-02-14',0,0)",
            (txn_id, account, SHARED_OWNER_ID, category, amount),
        )
        conn.commit()
        conn.close()
        return txn_id

    def _claimed_whole_row(self, client, path):
        """A $500 charge filed entirely in the holding group, claimed in full by one record."""
        seeded = self._seed(path)
        txn = self._txn(path, seeded["account"], 500.0, seeded["receivable"])
        created = client.post(
            "/api/reimbursements",
            json={"claims": [{"txn_id": txn}], "counterparty": "Friends"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["residual"], 500.0)
        return seeded, txn

    def _claimed_split_row(self, client, path):
        """A $500 charge split $125 / $375, with the $375 receivable portion claimed."""
        seeded = self._seed(path)
        txn = self._txn(path, seeded["account"], 500.0)
        split = client.put(f"/api/transactions/{txn}/split", json={"parts": [
            {"category_id": seeded["entertainment"], "amount": 125.0},
            {"category_id": seeded["receivable"], "amount": 375.0},
        ]})
        self.assertEqual(split.status_code, 200, split.text)
        created = client.post(
            "/api/reimbursements",
            json={"claims": [{"txn_id": txn}], "counterparty": "Friends"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["residual"], 375.0)
        return seeded, txn

    def _outstanding(self, client):
        return client.get("/api/reimbursements/outstanding").json()

    def test_recategorizing_a_claimed_row_out_of_the_group_is_refused(self):
        with api_client() as (client, path):
            seeded, txn = self._claimed_whole_row(client, path)
            response = client.patch(
                f"/api/transactions/{txn}/category",
                json={"category_id": seeded["entertainment"]},
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("500.00", response.json()["detail"])
            # The money is still where the record says it is, and the report still says so.
            self.assertEqual(self._outstanding(client)["total"], 500.0)

    def test_re_splitting_below_the_claim_is_refused_but_above_it_is_allowed(self):
        with api_client() as (client, path):
            seeded, txn = self._claimed_split_row(client, path)

            too_small = client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": seeded["entertainment"], "amount": 480.0},
                {"category_id": seeded["receivable"], "amount": 20.0},
            ]})
            self.assertEqual(too_small.status_code, 400)
            self.assertIn("375.00", too_small.json()["detail"])

            # Correcting the portion *upward* is an ordinary edit and still works — the guard asks what
            # would be left, not whether the row is claimed.
            larger = client.put(f"/api/transactions/{txn}/split", json={"parts": [
                {"category_id": seeded["entertainment"], "amount": 80.0},
                {"category_id": seeded["receivable"], "amount": 420.0},
            ]})
            self.assertEqual(larger.status_code, 200, larger.text)
            report = self._outstanding(client)
            self.assertEqual(report["total"], 420.0)
            # $375 of it is spoken for; the $45 the correction added is loose.
            self.assertEqual(report["reimbursements"][0]["residual"], 375.0)
            self.assertEqual(report["loose"][0]["unclaimed"], 45.0)

    def test_un_splitting_a_claimed_row_is_refused(self):
        with api_client() as (client, path):
            _, txn = self._claimed_split_row(client, path)
            response = client.delete(f"/api/transactions/{txn}/split")
            self.assertEqual(response.status_code, 400)
            self.assertIn("375.00", response.json()["detail"])
            self.assertEqual(self._outstanding(client)["total"], 375.0)

    def test_a_bulk_recategorize_declines_the_claimed_row_and_keeps_counting_honest(self):
        # Bulk declines rather than refusing the batch: the user selected a set, and the rows it can act
        # on are still correct to act on. The declined row must not be counted as updated.
        with api_client() as (client, path):
            seeded, claimed = self._claimed_whole_row(client, path)
            plain = self._txn(path, seeded["account"], 40.0)

            body = client.post("/api/transactions/bulk", json={
                "selection": {"mode": "ids", "ids": [claimed, plain]},
                "actions": [{"type": "set_category", "category_id": seeded["entertainment"]}],
            }).json()

            self.assertEqual(body["skipped_claimed"], 1)
            self.assertEqual(body["skipped_splits"], 0)
            self.assertEqual(body["updated_count"], 1)
            self.assertEqual(self._outstanding(client)["total"], 500.0)

    def test_a_bulk_recategorize_counts_a_declined_split_out_of_the_total_too(self):
        # The contract the response comment already claimed and the count did not keep.
        with api_client() as (client, path):
            seeded, split_row = self._claimed_split_row(client, path)
            plain = self._txn(path, seeded["account"], 40.0)

            body = client.post("/api/transactions/bulk", json={
                "selection": {"mode": "ids", "ids": [split_row, plain]},
                "actions": [{"type": "set_category", "category_id": seeded["entertainment"]}],
            }).json()

            self.assertEqual(body["skipped_splits"], 1)
            self.assertEqual(body["updated_count"], 1)

    def test_uncategorizing_a_claimed_row_is_refused(self):
        # The fifth write site: it clears `category_id` outright, so it empties the receivable the same
        # way a recategorize does.
        with api_client() as (client, path):
            _, txn = self._claimed_whole_row(client, path)
            response = client.patch(f"/api/transactions/{txn}/uncategorize")
            self.assertEqual(response.status_code, 400)
            self.assertIn("500.00", response.json()["detail"])
            self.assertEqual(self._outstanding(client)["total"], 500.0)

    def test_an_unclaimed_row_is_never_held_up(self):
        # The guard asks about claims, not about the Reimbursable group: receivable money nobody has
        # claimed is the ordinary state of a reimbursable between the purchase and the repayment, and
        # recategorizing it has to stay free.
        with api_client() as (client, path):
            seeded = self._seed(path)
            loose = self._txn(path, seeded["account"], 90.0, seeded["receivable"])
            self.assertEqual(self._outstanding(client)["total"], 90.0)

            moved = client.patch(
                f"/api/transactions/{loose}/category",
                json={"category_id": seeded["entertainment"]},
            )
            self.assertEqual(moved.status_code, 200, moved.text)
            self.assertEqual(self._outstanding(client)["total"], 0.0)

    def test_moving_between_two_receivable_categories_is_allowed(self):
        # The money stays in the group, so the claim still has everything it needs behind it.
        with api_client() as (client, path):
            seeded, txn = self._claimed_whole_row(client, path)
            conn = sqlite3.connect(path)
            second = str(uuid.uuid4())
            group = conn.execute(
                "SELECT parent_id FROM category WHERE id = ?", (seeded["receivable"],)
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, "
                "sort_order) VALUES (?,?,'Work expenses','expense',1,0)",
                (second, group),
            )
            conn.commit()
            conn.close()

            moved = client.patch(
                f"/api/transactions/{txn}/category", json={"category_id": second}
            )
            self.assertEqual(moved.status_code, 200, moved.text)
            self.assertEqual(self._outstanding(client)["total"], 500.0)

    def test_detaching_the_claim_first_releases_the_edit(self):
        # The refusal is a sequencing requirement, not a dead end: the message names detaching, so the
        # path it points at has to work.
        with api_client() as (client, path):
            seeded, txn = self._claimed_whole_row(client, path)
            link_id = self._outstanding(client)["reimbursements"][0]["id"]

            removed = client.delete(f"/api/reimbursements/{link_id}/transactions/{txn}")
            self.assertEqual(removed.status_code, 200, removed.text)

            response = client.patch(
                f"/api/transactions/{txn}/category",
                json={"category_id": seeded["entertainment"]},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self._outstanding(client)["total"], 0.0)

