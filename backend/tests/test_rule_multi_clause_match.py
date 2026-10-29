"""
Multi-clause merchant matching (category_rule.match_expr): AND-only, contains-only, up to 3 clauses.

A rule with a match_expr matches a row only when *every* clause's text is a substring of the row's name
text (or, for match_source_text rules, its captured source text) — order-independent. The stored keyword
is derived from the sorted clause texts so search and LENGTH-based specificity ordering keep working, and
the summed clause length ranks a subsuming rule above the one it subsumes. All data here is fabricated.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import (
    SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path,
)
from backend.routers.rules import (
    RuleCreate, RuleUpdate, create_rule_core, update_rule, delete_rule, _rule_affected_txn_ids,
)
from backend.services.categorizer import (
    recategorize_all, build_match_expr, normalize_match_clauses, merchant_matcher,
)


class BuildMatchExprUnitTests(unittest.TestCase):
    """The pure canonicalization/derivation helper — no database."""

    def test_zero_clauses(self):
        self.assertEqual(build_match_expr([]), (None, ""))

    def test_single_clause_is_legacy(self):
        # 1 clause stores no expr and behaves as an ordinary single-substring rule.
        self.assertEqual(build_match_expr(["Amazon"]), (None, "amazon"))

    def test_multi_clause_derives_sorted_keyword_and_expr(self):
        expr, keyword = build_match_expr(["Flash", "amazon", "Shoebox"])
        self.assertEqual(keyword, "amazon flash shoebox")  # sorted, lowercased, space-joined
        self.assertEqual(merchant_matcher(keyword, expr).filters, ("amazon", "flash", "shoebox"))

    def test_normalize_dedupes_and_trims(self):
        self.assertEqual(normalize_match_clauses([" C ", "a", "c", "b"]), ["a", "b", "c"])

    def test_a_fourth_text_is_refused_not_dropped(self):
        # Dropping a filter would store a broader rule than the one written.
        with self.assertRaises(ValueError):
            normalize_match_clauses(["a", "b", "c", "d"])

    def test_clause_order_is_canonical(self):
        # Reordering the same clauses yields the same expr + keyword (identity-stable).
        self.assertEqual(build_match_expr(["a", "b"]), build_match_expr(["b", "a"]))


class AlternativesMatchExprUnitTests(unittest.TestCase):
    """The alternatives half of the canonical form — no database."""

    def test_alternatives_are_canonical(self):
        self.assertEqual(
            build_match_expr(["Market"], ["NRTHGT", "northgate"]),
            build_match_expr(["market"], ["northgate", "nrthgt"]),
        )

    def test_a_single_alternative_is_a_filter(self):
        self.assertEqual(build_match_expr(["market"], ["northgate"]), build_match_expr(["market", "northgate"]))
        self.assertEqual(build_match_expr([], ["northgate"]), (None, "northgate"))

    def test_an_older_build_finds_nothing_to_match_on(self):
        # A build that predates alternatives reads only `clauses`, then falls back to the plain keyword.
        # Filters stored under `clauses` would make it fire on the filters alone, far broader than the rule.
        expr, keyword = build_match_expr(["market"], ["northgate", "nrthgt"])
        self.assertNotIn("clauses", json.loads(expr))
        self.assertNotIn(keyword, "northgate market")


class MultiClauseMatchTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "multiclause.db"
        init_db(str(self.db_path))
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('acc', 'p_acc', 'fix', 'acc', 'acc', 'depository', ?)""",
                (SHARED_OWNER_ID,),
            )
            grp = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'G', 'expense')", (grp,))
            self.cat_a = str(uuid.uuid4())
            self.cat_b = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'A', 'expense')", (self.cat_a, grp))
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'B', 'expense')", (self.cat_b, grp))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _txn(self, merchant, *, amount=5.00, evidence_json=None):
        tid = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                                    date, is_pending, import_evidence_json)
                   VALUES (?, 'acc', ?, ?, ?, ?, ?, '2026-01-01', 0, ?)""",
                (tid, SHARED_OWNER_ID, amount, merchant, merchant, merchant, evidence_json),
            )
        return tid

    def _rule(self, clauses, category_id, **kwargs):
        with self._use_db(), get_db() as conn:
            return create_rule_core(conn, RuleCreate(keyword="", clauses=clauses, category_id=category_id, **kwargs))

    def _cat(self, txn_id):
        with self._use_db(), get_db() as conn:
            return conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()["category_id"]

    def _recategorize(self):
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)

    # --- AND semantics -------------------------------------------------------

    def test_all_clauses_must_be_present(self):
        both = self._txn("Amazon Prime Video")
        one = self._txn("Amazon Fresh")  # no "prime"
        self._rule(["amazon", "prime"], self.cat_b)
        self._recategorize()
        self.assertEqual(self._cat(both), self.cat_b, "row with both tokens matches")
        self.assertIsNone(self._cat(one), "row missing a clause does not match (AND is self-limiting)")

    def test_order_independent(self):
        # Clauses can appear in any order in the text.
        txn = self._txn("FLASH sale at Amazon")
        self._rule(["amazon", "flash"], self.cat_b)
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_b)

    def test_single_clause_rule_is_plain_substring(self):
        txn = self._txn("AmazonPurchases")
        created = self._rule(["amazon"], self.cat_a)
        self.assertIsNone(self._stored_match_expr(created["id"]), "one clause stores no expr")
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_a)

    def _stored_match_expr(self, rule_id):
        with self._use_db(), get_db() as conn:
            return conn.execute("SELECT match_expr FROM category_rule WHERE id = ?", (rule_id,)).fetchone()["match_expr"]

    # --- Precedence (summed clause length) -----------------------------------

    def test_subsuming_multiclause_rule_wins(self):
        # {amazon, prime} is a strict superset of {amazon}, so it is narrower and must win where both match.
        txn = self._txn("Amazon Prime Video")
        self._rule(["amazon"], self.cat_a)
        self._rule(["amazon", "prime"], self.cat_b)
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_b)

    def test_long_single_keyword_beats_several_short_clauses(self):
        # "starbucks" (len 9) outweighs {sb, card} (summed 6) — the meaningful long keyword wins.
        txn = self._txn("SB Card Starbucks")
        self._rule(["starbucks"], self.cat_a)
        self._rule(["sb", "card"], self.cat_b)
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_a)

    def test_summed_length_orders_unrelated_clause_sets(self):
        # {amazon, flash, shoebox} (summed 18) outweighs the single "amazonpurchases" (15) where both match.
        txn = self._txn("AmazonPurchases Shoebox Flash Deal")
        self._rule(["amazonpurchases"], self.cat_a)
        self._rule(["amazon", "flash", "shoebox"], self.cat_b)
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_b)

    # --- Matcher identity ----------------------------------------------------

    def test_clause_order_does_not_fork_a_duplicate(self):
        a = self._rule(["amazon", "flash"], self.cat_b)
        self.assertEqual(a["status"], "created")
        with self._use_db(), get_db() as conn:
            b = create_rule_core(conn, RuleCreate(keyword="", clauses=["flash", "amazon"], category_id=self.cat_b))
        self.assertEqual(b["status"], "duplicate", "reordered clauses share the canonical matcher")

    def test_a_rule_over_the_clause_cap_is_refused(self):
        with self.assertRaises(HTTPException) as raised:
            self._rule(["amazon", "flash", "prime", "video"], self.cat_b)
        self.assertEqual(raised.exception.status_code, 400)
        with self._use_db(), get_db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM category_rule").fetchone()[0], 0)

    def test_multiclause_and_single_keyword_are_distinct_matchers(self):
        # A single contains-"amazon flash" and a two-clause {amazon, flash} derive the same keyword but mean
        # different things, so match_expr keeps them distinct.
        multi = self._rule(["amazon", "flash"], self.cat_b)
        with self._use_db(), get_db() as conn:
            single = create_rule_core(conn, RuleCreate(keyword="amazon flash", category_id=self.cat_a))
        self.assertEqual(single["status"], "created")
        self.assertNotEqual(multi["id"], single["id"])

    # --- Alternatives ---------------------------------------------------------

    def test_any_alternative_and_every_filter(self):
        plain = self._txn("NORTHGATE MARKET")
        variant = self._txn("NRTHGT MARKET #0412")
        no_filter = self._txn("NORTHGATE FUEL")
        no_alternative = self._txn("RIVERSTONE MARKET")
        self._rule(["market"], self.cat_a, alternatives=["northgate", "nrthgt"])
        self._recategorize()
        self.assertEqual(self._cat(plain), self.cat_a)
        self.assertEqual(self._cat(variant), self.cat_a)
        self.assertIsNone(self._cat(no_filter))
        self.assertIsNone(self._cat(no_alternative))

    def test_an_alternatives_rule_ranks_on_its_shortest_alternative(self):
        # Joined, the alternatives rule's text ("northgate nrthgt", 16) is longer than "northgate m" (11),
        # but it is as broad as "nrthgt" (6), so the narrower plain rule wins the row both match.
        txn = self._txn("NORTHGATE MKT")
        self._rule([], self.cat_a, alternatives=["northgate", "nrthgt"])
        self._rule(["northgate m"], self.cat_b)
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_b)

    def test_alternative_order_does_not_fork_a_duplicate(self):
        self._rule(["market"], self.cat_a, alternatives=["northgate", "nrthgt"])
        again = self._rule(["market"], self.cat_a, alternatives=["nrthgt", "northgate"])
        self.assertEqual(again["status"], "duplicate")

    def test_a_rename_does_not_feed_another_rule(self):
        # Rules match the names as they arrived. If they read the rename too, the second pass would see
        # "grocer market", hand the row to the longer rule, and categorizing twice would differ from once.
        txn = self._txn("STOP SHOP 0412")
        self._rule(["stop shop"], self.cat_a, clean_name="Grocer Market")
        self._rule(["grocer market"], self.cat_b)
        self._recategorize()
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_a)

    # --- match_source_text interaction ---------------------------------------

    def test_clause_can_match_source_text(self):
        evidence = '{"description": {"value": "ACH DEBIT SECRETCODE"}}'
        txn = self._txn("Bank Transfer", evidence_json=evidence)  # "secretcode" only in source text
        self._rule(["bank", "secretcode"], self.cat_b, match_source_text=True)
        self._recategorize()
        self.assertEqual(self._cat(txn), self.cat_b, "a clause satisfied only by source text still counts")

    def test_source_text_clause_ignored_without_flag(self):
        evidence = '{"description": {"value": "ACH DEBIT SECRETCODE"}}'
        txn = self._txn("Bank Transfer", evidence_json=evidence)
        self._rule(["bank", "secretcode"], self.cat_b)  # no match_source_text
        self._recategorize()
        self.assertIsNone(self._cat(txn), "without the flag, a source-only clause fails the AND")

    # --- reconcile uses the AND matcher, not the derived keyword --------------

    def test_delete_reconcile_reverts_only_and_matches(self):
        both = self._txn("Amazon Prime Video")
        _one = self._txn("Amazon Fresh")
        created = self._rule(["amazon", "prime"], self.cat_b)
        self._recategorize()
        self.assertEqual(self._cat(both), self.cat_b)
        # The affected set the reconcile computes must be exactly the AND-matched rows (the derived keyword
        # "amazon prime" as a plain substring would match neither row's contiguous text differently, but a
        # bug that fell back to it could mis-scope; assert the real AND set).
        with self._use_db(), get_db() as conn:
            rule = conn.execute(
                """SELECT id, keyword, match_expr, category_id, amount_min, amount_max, debit_credit,
                          clean_name, owner_id, account_id, account_type, match_source_text
                   FROM category_rule WHERE id = ?""",
                (created["id"],),
            ).fetchone()
            affected = _rule_affected_txn_ids(conn, rule)
        self.assertEqual(set(affected), {both}, "only the row matching every clause is owned by the rule")
        with self._use_db():
            delete_rule(created["id"], reconcile=True)
        self.assertIsNone(self._cat(both), "the AND-matched row reverts on reconcile delete")

    # --- editing the matcher -------------------------------------------------

    def test_edit_single_to_multi_and_back(self):
        created = self._rule(["amazon"], self.cat_a)
        self.assertIsNone(self._stored_match_expr(created["id"]))
        with self._use_db():
            update_rule(created["id"], RuleUpdate(clauses=["amazon", "prime"]))
        self.assertEqual(merchant_matcher("", self._stored_match_expr(created["id"])).filters, ("amazon", "prime"))
        with self._use_db():
            update_rule(created["id"], RuleUpdate(clauses=["amazon"]))
        self.assertIsNone(self._stored_match_expr(created["id"]), "back to one clause clears the expr")

    # --- the /rules/{id}/matches endpoint (per-rule count + report rows) -------

    def test_matches_endpoint_counts_all_matcher_hits(self):
        from backend.routers.rules import rule_matches
        self._txn("Amazon Prime")
        self._txn("Amazon Fresh")
        self._txn("Starbucks")  # non-match
        created = self._rule(["amazon"], self.cat_a)
        with self._use_db():
            res = rule_matches(created["id"])
        self.assertEqual(res["count"], 2)
        self.assertEqual({t["merchant_name"] for t in res["transactions"]}, {"Amazon Prime", "Amazon Fresh"})

    def test_matches_endpoint_counts_and_matcher_hits(self):
        from backend.routers.rules import rule_matches
        self._txn("Amazon Prime Video")   # amazon AND prime
        self._txn("Amazon Fresh")         # amazon only — excluded by the AND matcher
        created = self._rule(["amazon", "prime"], self.cat_b)
        with self._use_db():
            res = rule_matches(created["id"])
        self.assertEqual(res["count"], 1)
        self.assertEqual(res["transactions"][0]["merchant_name"], "Amazon Prime Video")


if __name__ == "__main__":
    unittest.main()
