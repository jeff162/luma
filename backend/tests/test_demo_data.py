"""Demo dataset builder: completeness + the safety guard.

The demo data is a shared fixture (the E2E baseline and a future onboarding feature), so it's worth
pinning that it builds the expected shape — and, critically, that the guard refuses to touch a
non-empty database (it must never overwrite real data).

**The worked examples are pinned by what they produce, not by what they contain.** An example exists to
show a feature working, so the assertion that matters is that the feature fires: that the signals the
Recurring page reports include all four kinds, that both sorts of rule overlap are found, that a
document's text actually came out of it. Counting rows would pass just as happily against data that
demonstrates nothing — which is the state this dataset was in before, with every one of those at zero.
"""

import json
import tempfile
import unittest
from collections import Counter
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.db.demo_data import (
    DISCRETIONARY_TAG,
    ESSENTIAL_TAG,
    is_demo_loadable,
    load_demo_data,
)


@contextmanager
def _scoped(db_path):
    """A connection with the *current db path* pointed at it, not just the connection.

    Attaching a document writes a file next to the database, and the store finds that database through
    `current_db_path()` rather than through whichever connection it was handed. A test that only passes a
    path to `get_db` therefore reads and writes its own temp ledger while dropping the files it creates
    into the developer's real data directory.
    """
    token = set_current_db_path(str(db_path))
    try:
        with get_db(str(db_path)) as conn:
            yield conn
    finally:
        reset_current_db_path(token)


class DemoDataTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "demo.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    def _conn(self):
        return _scoped(self.db_path)

    def test_loads_expected_shape(self):
        with self._conn() as conn:
            summary = load_demo_data(conn, scope_id="demo-profile")
        self.assertFalse(summary["skipped"])

        with self._conn() as conn:
            owners = conn.execute(
                "SELECT COUNT(*) FROM owner WHERE id != ?", (SHARED_OWNER_ID,)
            ).fetchone()[0]
            self.assertEqual(owners, 2)

            # Five accounts, each of a distinct type.
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM account").fetchone()[0], 5)
            types = {r[0] for r in conn.execute("SELECT type FROM account")}
            self.assertEqual(types, {"depository", "savings", "credit", "investment", "amazon"})

            n_txn = conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0]
            self.assertGreater(n_txn, 60)
            self.assertEqual(n_txn, summary["transactions"])

            # Custom category + a rule onto it.
            self.assertTrue(conn.execute("SELECT 1 FROM category WHERE name = 'Pet Care'").fetchone())
            pet_rule = conn.execute(
                """SELECT c.name FROM category_rule r JOIN category c ON c.id = r.category_id
                   WHERE LOWER(r.keyword) = 'petco'"""
            ).fetchone()
            self.assertEqual(pet_rule["name"], "Pet Care")

            # Both tags exist and are applied at the category level (the inheritance source).
            for tag_name in (ESSENTIAL_TAG, DISCRETIONARY_TAG):
                tag = conn.execute("SELECT id FROM tag WHERE name = ?", (tag_name,)).fetchone()
                self.assertIsNotNone(tag)
                links = conn.execute(
                    "SELECT COUNT(*) FROM category_tag WHERE tag_id = ?", (tag["id"],)
                ).fetchone()[0]
                self.assertGreater(links, 0)
            # Essential Expenses is on Groceries specifically (a leaf with transactions → inheritance).
            groceries = conn.execute(
                "SELECT id FROM category WHERE name = 'Groceries' AND parent_id IS NOT NULL"
            ).fetchone()["id"]
            ess = conn.execute("SELECT id FROM tag WHERE name = ?", (ESSENTIAL_TAG,)).fetchone()["id"]
            self.assertTrue(
                conn.execute(
                    "SELECT 1 FROM category_tag WHERE category_id = ? AND tag_id = ?", (groceries, ess)
                ).fetchone()
            )

            # The standing inter-account transfer: two accounts, opposite signs netting zero, and every
            # date carrying both legs — which is what the Recurring page pairs on, so a demo where the
            # dates did not line up would show the two cards this data exists to demonstrate folding.
            legs = conn.execute(
                "SELECT account_id, amount, date FROM txn WHERE merchant_name LIKE 'Transfer %'"
            ).fetchall()
            self.assertEqual(len({r["account_id"] for r in legs}), 2)
            self.assertEqual(round(sum(r["amount"] for r in legs), 2), 0.0)
            per_date = Counter(r["date"] for r in legs)
            self.assertTrue(per_date)
            self.assertEqual(set(per_date.values()), {2})

            # Two CSV files (one per data source) and an Amazon order history, produced through the real
            # import pipelines — so every row has provenance, both CSV files land under a saved data
            # source, and the CSV cards get coverage.
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM import_batch").fetchone()[0], 3)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM txn WHERE import_batch_id IS NULL").fetchone()[0], 0
            )
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM csv_import_profile").fetchone()[0], 2)
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(DISTINCT account_id) FROM import_batch_account WHERE account_id IS NOT NULL"
                ).fetchone()[0],
                4,
            )
            # Several novel (non-starter) expense categories land in Unassigned so the "Group imported
            # categories" workspace has real items to organize, not just one.
            unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
            self.assertGreaterEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM category WHERE parent_id = ? AND import_pending = 1", (unassigned,)
                ).fetchone()[0],
                4,
            )

            # The cross-account duplicate pair shares a content_hash...
            dup_groups = conn.execute(
                "SELECT COUNT(*) c FROM txn WHERE content_hash IS NOT NULL "
                "GROUP BY content_hash HAVING c > 1"
            ).fetchall()
            self.assertTrue(any(r["c"] == 2 for r in dup_groups))

            # ...and the REAL post-import sweep flagged exactly one of them as a cross-account suspect.
            self.assertEqual(summary["suspects_flagged"], 1)
            flagged = conn.execute(
                "SELECT COUNT(*) FROM txn WHERE suspect_duplicate_of IS NOT NULL "
                "AND suspect_duplicate_reason = 'cross_account'"
            ).fetchone()[0]
            self.assertEqual(flagged, 1)

            # Sign convention sanity: income stored negative, spending positive.
            salary = conn.execute(
                "SELECT amount FROM txn WHERE merchant_name = 'Acme Corp Payroll' LIMIT 1"
            ).fetchone()["amount"]
            self.assertLess(salary, 0)
            rent = conn.execute(
                "SELECT amount FROM txn WHERE merchant_name = 'Parkside Apartments' LIMIT 1"
            ).fetchone()["amount"]
            self.assertGreater(rent, 0)

            # UI preference seeded (JSON-encoded) so the demo opens with the accounts list expanded.
            pref = conn.execute(
                "SELECT pref_value FROM ui_preference "
                "WHERE scope_id = 'demo-profile' AND pref_key = 'ui.accounts.sections'"
            ).fetchone()
            self.assertIsNotNone(pref)
            self.assertTrue(json.loads(pref["pref_value"])["accountList"])

    def test_guard_refuses_a_non_empty_db(self):
        with self._conn() as conn:
            first = load_demo_data(conn)
        self.assertFalse(first["skipped"])

        with self._conn() as conn:
            self.assertFalse(is_demo_loadable(conn))
            second = load_demo_data(conn)
            txns_after = conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0]

        self.assertTrue(second["skipped"])
        # Second load must not duplicate anything.
        self.assertEqual(txns_after, first["transactions"])

    def test_saved_data_source_suppresses_loadable(self):
        # A fresh tenant (only the seeded category skeleton) is a blank slate.
        with self._conn() as conn:
            self.assertTrue(is_demo_loadable(conn))
            # Saving a data source is engagement even before any file is imported.
            conn.execute("INSERT INTO csv_import_profile (id, name) VALUES ('p1', 'My Bank')")
        with self._conn() as conn:
            self.assertFalse(is_demo_loadable(conn))

    def test_linked_connection_suppresses_loadable(self):
        with self._conn() as conn:
            self.assertTrue(is_demo_loadable(conn))
            # A linked connection counts even before any transactions have synced.
            conn.execute("INSERT INTO connection (id, provider, external_id) VALUES ('c1', 'plaid', 'item-1')")
        with self._conn() as conn:
            self.assertFalse(is_demo_loadable(conn))


if __name__ == "__main__":
    unittest.main()


class DemoWorkedExampleTests(unittest.TestCase):
    """Each example, asserted through the feature it exists to demonstrate."""

    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.db_path = Path(cls.tempdir.name) / "demo.db"
        init_db(str(cls.db_path))
        with _scoped(cls.db_path) as conn:
            cls.summary = load_demo_data(conn)

    @classmethod
    def tearDownClass(cls):
        cls.tempdir.cleanup()

    def _conn(self):
        return _scoped(self.db_path)

    def test_every_recurring_signal_kind_is_represented(self):
        """The reason the dataset carries a stopped subscription and a streaming price step: without
        them the findings never appear and the Recurring page's whole review section can only be seen
        empty."""
        from backend.services.recurring_detection import maybe_auto_scan
        from backend.services.recurring_signals import compute_signals

        with self._conn() as conn:
            maybe_auto_scan(conn)
            counts = compute_signals(conn)["counts"]

        for kind in ("missed", "price_change", "new_series"):
            self.assertGreaterEqual(counts.get(kind, 0), 1, f"no {kind} signal in the demo data")

    def test_the_water_bill_that_outgrew_its_rule_is_findable(self):
        """The same reason as the signals above, for the finding that lives with the rules instead: the
        demo's water bill drifts past its rule's maximum, so the Rules page's findings panel has its
        range-drift section to show."""
        from backend.services.rule_range_drift import find_range_drift

        with self._conn() as conn:
            kinds = {finding["kind"] for finding in find_range_drift(conn)["findings"]}
        self.assertIn("rule_range", kinds)

    def test_both_kinds_of_rule_overlap_are_findable(self):
        """The overlap half of `Rule checkup` reports nothing on a tidy rule set, so the demo carries one ambiguous pair
        and one nested pair — the two the checker deliberately tells apart."""
        from backend.services.rule_overlaps import find_rule_overlaps

        with self._conn() as conn:
            kinds = {finding["kind"] for finding in find_rule_overlaps(conn)["findings"]}
        self.assertIn("amount_overlap", kinds)
        self.assertIn("matcher_nesting", kinds)

    def test_a_split_reports_each_part_in_its_own_category(self):
        with self._conn() as conn:
            split_rows = conn.execute("SELECT id FROM txn WHERE is_split = 1").fetchall()
            self.assertGreaterEqual(len(split_rows), 1)
            for row in split_rows:
                parts = conn.execute(
                    "SELECT amount, category_id FROM txn_split WHERE txn_id = ?", (row["id"],)
                ).fetchall()
                self.assertGreaterEqual(len(parts), 2, "a one-part split is just a categorization")
                total = conn.execute("SELECT amount FROM txn WHERE id = ?", (row["id"],)).fetchone()[0]
                self.assertAlmostEqual(sum(p["amount"] for p in parts), total, places=2)

    def test_the_reimbursements_cover_open_closed_due_and_loose(self):
        """Settled records and work still to do. An all-closed set leaves the outstanding report empty and
        Tasks silent; an all-open one never shows what finishing looks like. Among the open ones, one has
        been repaid short, one is past its reminder, and some receivable money is not tracked at all."""
        from backend.services.reimbursements import due_reminders, outstanding

        with self._conn() as conn:
            report = outstanding(conn)
            due = due_reminders(conn)
            completed = conn.execute(
                "SELECT COUNT(*) FROM txn_link WHERE kind = 'reimbursement' "
                "AND json_extract(metadata_json, '$.completion') IS NOT NULL"
            ).fetchone()[0]

        self.assertGreaterEqual(completed, 2)
        self.assertGreater(report["total"], 0)
        part_repaid = [r for r in report["reimbursements"]
                       if any(m["claim"] < 0 for m in r["members"]) and r["residual"] > 0]
        self.assertTrue(part_repaid, "no open record has been repaid short")
        self.assertTrue(report["loose"], "no untracked receivable money")
        self.assertGreater(due["total"], 0, "no reimbursement reminder has come due")

    def test_one_charge_carries_two_independent_debts(self):
        """The concert tickets. A claim is per *portion*, so one transaction can owe two different
        people — the case a one-reimbursement-per-row rule could not express."""
        with self._conn() as conn:
            row = conn.execute(
                """SELECT m.txn_id, COUNT(*) AS links
                   FROM   txn_link_member m
                   JOIN   txn_link l ON l.id = m.link_id AND l.kind = 'reimbursement'
                   GROUP  BY m.txn_id HAVING links > 1"""
            ).fetchone()
        self.assertIsNotNone(row, "no transaction is claimed by two reimbursements")

    def test_a_document_of_each_readable_kind_yielded_text(self):
        """Attaching is not the assertion — extraction is. A PDF with no text layer, or markup that
        reduced to nothing, would store perfectly happily and be invisible to search."""
        with self._conn() as conn:
            rows = conn.execute("SELECT text_source, text FROM document").fetchall()
        by_source = {r["text_source"]: r["text"] for r in rows}
        for source in ("pdf_text", "html_text", "verbatim"):
            self.assertIn(source, by_source, f"no document extracted as {source}")
            self.assertTrue((by_source[source] or "").strip(), f"{source} produced no text")

    def test_card_payments_pair_as_one_uncounted_movement(self):
        """Paying the card is money movement: both legs are excluded from totals, and detection folds
        them into one series spanning checking and the card rather than two."""
        with self._conn() as conn:
            legs = conn.execute(
                """SELECT t.account_id, t.amount, c.exclude_from_totals AS leaf_ex, g.exclude_from_totals AS group_ex
                   FROM txn t JOIN category c ON c.id = t.category_id JOIN category g ON g.id = c.parent_id
                   WHERE c.name = 'Credit Card Payment'"""
            ).fetchall()
            series = conn.execute(
                """SELECT occurrence_count FROM recurring_series
                   WHERE counterpart_account_id = (SELECT id FROM account WHERE type = 'credit')"""
            ).fetchall()
        self.assertEqual(len({r["account_id"] for r in legs}), 2)
        self.assertEqual(round(sum(r["amount"] for r in legs), 2), 0.0)
        self.assertTrue(all(r["leaf_ex"] or r["group_ex"] for r in legs))
        self.assertEqual([s["occurrence_count"] for s in series], [len(legs)])

    def test_a_rule_owns_a_recurring_series(self):
        with self._conn() as conn:
            row = conn.execute(
                """SELECT s.occurrence_count FROM recurring_series s
                   JOIN category_rule r ON r.id = s.rule_id WHERE s.source = 'rule'"""
            ).fetchone()
        self.assertIsNotNone(row, "no rule-backed series")
        self.assertGreaterEqual(row["occurrence_count"], 3)

    def test_the_amazon_import_reconciles_against_the_card(self):
        """The report has to show both outcomes worth meeting: orders matched to their card charges, and
        a charge no order accounts for. A non-cash order is in the history as well."""
        from backend.routers.import_export.amazon import amazon_reconciliation

        with self._conn() as conn:
            batch_id = conn.execute(
                "SELECT id FROM import_batch WHERE source_kind = 'marketplace:amazon'"
            ).fetchone()["id"]
            report = amazon_reconciliation(conn, batch_id)
            itemized = conn.execute(
                """SELECT COUNT(*) FROM txn t JOIN account a ON a.id = t.account_id
                   WHERE a.type = 'amazon' AND t.category_id IS NOT NULL AND t.amount > 0"""
            ).fetchone()[0]
        self.assertGreaterEqual(len(report["matched"]), 5)
        self.assertEqual(len(report["payment_unmatched"]), 1)
        self.assertGreater(itemized, 0, "no order was filed by a rule matching its contents")

    def test_a_multi_payment_purchase_is_fully_paid(self):
        from backend.services.purchase_links import get_purchase

        with self._conn() as conn:
            link = conn.execute("SELECT id FROM txn_link WHERE kind = 'purchase'").fetchone()
            self.assertIsNotNone(link, "no multi-payment purchase")
            purchase = get_purchase(conn, link["id"])
        self.assertGreaterEqual(len(purchase["payments"]), 2)
        self.assertEqual(purchase["unaccounted"], 0)

    def test_an_amazon_order_is_split_per_item(self):
        """Each part is one item of the order, in that item's own category."""
        with self._conn() as conn:
            parts = conn.execute(
                """SELECT s.label, s.category_id FROM txn_split s
                   JOIN txn t ON t.id = s.txn_id JOIN account a ON a.id = t.account_id
                   WHERE a.type = 'amazon'"""
            ).fetchall()
        self.assertGreaterEqual(len(parts), 2)
        self.assertEqual(len({p["category_id"] for p in parts}), len(parts))
        self.assertTrue(all(p["label"] for p in parts))

    def test_the_ledger_spans_more_than_a_year(self):
        """Year-over-year comparison is on the feature list, and with a single season of data there is
        nothing for it to compare against."""
        with self._conn() as conn:
            first, last = conn.execute("SELECT MIN(date), MAX(date) FROM txn").fetchone()
        self.assertGreater(last[:4] + last[5:7], first[:4] + first[5:7])
        self.assertGreaterEqual((int(last[:4]) - int(first[:4])) * 12
                                + int(last[5:7]) - int(first[5:7]), 12)
