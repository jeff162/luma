"""
The on-demand check for rules that compete for the same transactions.

Findings with opposite intents, and most of these tests exist to pin the boundary between them and the
much larger set of pairs that must stay silent. An `amount_overlap` is a genuine ambiguity
(`[300, 4000]` against `[3000, inf)`) and needs the user; a `matcher_co_match` is the same ambiguity
reached by a different route, two unrelated matchers landing in one merchant name; a `matcher_nesting`
(`amazon` inside `amazon prime`) is deterministic, and is reported both because the winner is not always
the rule a reader would guess and because its narrow half may be surplus. Everything precedence already
settles for a principled reason — containment, a scope difference — must produce nothing, or the check
cries wolf on the two-rule split that is the recommended way to model several bills from one biller.

The `_benign` variants carry the other half of that: a pair whose two rules file identically is competing
over nothing, and several tests exist only to stop the check calling that a problem. Note what this does
to the fixtures — `_rule` twice over makes a pair that *agrees*, so a test about the warning path has to
use `_differing` or it is quietly testing the benign one.

The `removable_rule_id` cases carry their own weight, because the flag gates a delete button and the
tempting version of it is wrong: same category is not sufficient. A rename or tag only one rule carries,
or a range or direction the broad rule does not cover, means removing the narrow rule would change or
strand rows the broad one does not handle the same way.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.categorizer import build_match_expr
from backend.services.rule_overlaps import dismiss_finding, find_rule_overlaps, restore_finding


class RuleOverlapsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-overlaps.db"
        init_db(str(self.db_path))
        self.checking_id = str(uuid.uuid4())
        self.card_id = str(uuid.uuid4())
        self.other_owner_id = str(uuid.uuid4())
        self.category_id = None
        with self._use_db_path():
            with get_db() as conn:
                for account_id, name, kind in (
                    (self.checking_id, "Harborline Checking", "depository"),
                    (self.card_id, "Riverstone Card", "credit"),
                ):
                    conn.execute(
                        "INSERT INTO account (id, provider, name, display_name, type) VALUES (?, 'fixture', ?, ?, ?)",
                        (account_id, name, name, kind),
                    )
                conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Second')", (self.other_owner_id,))
                unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
                self.category_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO category (id, parent_id, name) VALUES (?, ?, 'Utilities')",
                    (self.category_id, unassigned),
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

    def _other_category(self, name):
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
                conn.execute(
                    "INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)", (category_id, unassigned, name)
                )
        return category_id

    _UNSET = object()

    def _rule(self, keyword="town of harborline", *, rule_id=None, amount_min=None, amount_max=None,
              owner_id=None, account_id=None, account_type=None, clauses=None, debit_credit="both",
              is_managed=0, match_source_text=0, deleted_at=None, category_id=_UNSET,
              clean_name=None, alternatives=None):
        rule_id = rule_id or str(uuid.uuid4())
        category_id = self.category_id if category_id is self._UNSET else category_id
        match_expr = None
        if alternatives:
            match_expr, keyword = build_match_expr(clauses, alternatives)
        elif clauses:
            texts = sorted(clauses)
            keyword = " ".join(texts)
            match_expr = (
                '{"op":"and","clauses":['
                + ",".join('{"type":"contains","text":"%s"}' % text for text in texts)
                + "]}"
            )
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """INSERT INTO category_rule
                         (id, category_id, keyword, match_expr, amount_min, amount_max, debit_credit,
                          owner_id, account_id, account_type, match_source_text, is_managed, deleted_at,
                          clean_name)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (rule_id, category_id, keyword, match_expr, amount_min, amount_max, debit_credit,
                     owner_id, account_id, account_type, match_source_text, is_managed, deleted_at,
                     clean_name),
                )
        return rule_id

    def _differing(self, **kwargs):
        """A rule whose winning *changes the outcome* against the plain `_rule` above — here, a different
        category. Competing rules only earn a warning when the winner changes the ledger, so a test about
        which pairs contend has to make them disagree about something or it is testing the benign split by
        accident. It has to be an action both rules set: one only this rule carried would apply whichever
        rule won (`_outcomes_agree`)."""
        return self._rule(category_id=self._other_category("Water"), **kwargs)

    def _txn(self, name, amount=100.0, date="2026-03-01", account_id=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """INSERT INTO txn (id, account_id, date, amount, raw_name, display_name)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (txn_id, account_id or self.checking_id, date, amount, name, name),
                )
        return txn_id

    def _amount_findings(self):
        """Both amount-overlap kinds. The negative tests assert on this rather than on the warning kind
        alone: a pair that should produce nothing at all must not quietly produce a benign finding."""
        return [f for f in self._findings()["findings"]
                if f["kind"] in ("amount_overlap", "amount_overlap_benign")]

    def _findings(self, kind=None, include_dismissed=False):
        with self._use_db_path():
            with get_db() as conn:
                result = find_rule_overlaps(conn, include_dismissed=include_dismissed)
        if kind is None:
            return result
        return [f for f in result["findings"] if f["kind"] == kind]

    def _dismiss(self, finding):
        with self._use_db_path():
            with get_db() as conn:
                dismiss_finding(conn, finding["key"], finding["kind"])

    def _restore(self, finding):
        with self._use_db_path():
            with get_db() as conn:
                restore_finding(conn, finding["key"])

    # --- Overlapping amount ranges -----------------------------------------------------------------

    def test_ranges_that_overlap_without_containment_are_reported(self):
        # The case ordering cannot answer: a 3500 charge matches both and neither range is the narrower.
        low = self._rule(amount_min=300, amount_max=4000)
        high = self._differing(amount_min=3000)
        findings = self._findings("amount_overlap")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["severity"], "warning")
        self.assertEqual(set(findings[0]["rule_ids"]), {low, high})
        # Listed lower range first, so the pair reads as a number line.
        self.assertEqual(findings[0]["rule_ids"][0], low)

    def test_the_reported_band_is_the_one_both_rules_claim(self):
        self._rule(amount_min=300, amount_max=4000)
        self._differing(amount_min=3000)
        finding = self._findings("amount_overlap")[0]
        self.assertEqual(finding["overlap_min"], 3000.0)
        self.assertEqual(finding["overlap_max"], 4000.0)

    def test_containment_is_not_a_conflict(self):
        # Precedence answers this correctly, and it is the recommended way to split one biller's bills.
        self._rule(amount_min=300)
        self._rule(amount_min=3000)
        self.assertEqual(self._amount_findings(), [])

    def test_a_fully_bounded_range_inside_another_is_not_a_conflict(self):
        self._rule(amount_min=100, amount_max=5000)
        self._rule(amount_min=200, amount_max=260)
        self.assertEqual(self._amount_findings(), [])

    def test_disjoint_ranges_are_not_a_conflict(self):
        self._rule(amount_min=0, amount_max=2999.99)
        self._rule(amount_min=3000)
        self.assertEqual(self._amount_findings(), [])

    def test_ranges_meeting_at_one_value_do_conflict(self):
        # Both bounds are inclusive, so a charge of exactly 3000 really is claimed by both rules.
        self._rule(amount_min=300, amount_max=3000)
        self._differing(amount_min=3000)
        findings = self._findings("amount_overlap")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["overlap_min"], 3000.0)
        self.assertEqual(findings[0]["overlap_max"], 3000.0)

    def test_an_unbounded_rule_never_conflicts_on_amount(self):
        # No bounds is [0, inf), which contains every range — always containment, never an overlap.
        self._rule()
        self._rule(amount_min=300, amount_max=4000)
        self.assertEqual(self._amount_findings(), [])

    def test_a_scope_difference_leaves_precedence_something_to_decide_with(self):
        # Owner scope outranks the amount term, so this pair has a principled winner and is not reported.
        self._rule(amount_min=300, amount_max=4000, owner_id=SHARED_OWNER_ID)
        self._rule(amount_min=3000)
        self.assertEqual(self._amount_findings(), [])

    def test_rules_on_different_accounts_can_never_contend(self):
        self._rule(amount_min=300, amount_max=4000, account_id=self.checking_id)
        self._rule(amount_min=3000, account_id=self.card_id)
        self.assertEqual(self._amount_findings(), [])

    def test_rules_on_opposite_sides_can_never_contend(self):
        self._rule(amount_min=300, amount_max=4000, debit_credit="debit")
        self._rule(amount_min=3000, debit_credit="credit")
        self.assertEqual(self._amount_findings(), [])

    def test_a_direction_difference_does_not_rescue_an_overlap(self):
        # The direction term sits *below* the amount span, so span still decides — and decides nothing.
        self._rule(amount_min=300, amount_max=4000, debit_credit="debit")
        self._differing(amount_min=3000)
        self.assertEqual(len(self._findings("amount_overlap")), 1)

    def test_different_keywords_are_not_an_amount_conflict(self):
        self._rule(keyword="harborline water", amount_min=300, amount_max=4000)
        self._rule(keyword="riverstone gas", amount_min=3000)
        self.assertEqual(self._amount_findings(), [])

    # --- Nested merchant matchers -----------------------------------------------------------------

    def test_a_keyword_inside_another_is_reported_as_information(self):
        broad = self._rule(keyword="northgate")
        narrow = self._rule(keyword="northgate prime")
        findings = self._findings("matcher_nesting")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["severity"], "info")
        # Broader matcher first: "this wide rule also catches what that narrow one is for".
        self.assertEqual(findings[0]["rule_ids"], [broad, narrow])
        self.assertEqual(findings[0]["winner_rule_id"], narrow)

    def test_a_clause_superset_nests_the_same_way(self):
        broad = self._rule(clauses=["northgate"])
        narrow = self._rule(clauses=["northgate", "prime"])
        findings = self._findings("matcher_nesting")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["rule_ids"], [broad, narrow])

    def test_a_plain_keyword_nests_into_a_multi_clause_matcher(self):
        broad = self._rule(keyword="northgate")
        narrow = self._rule(clauses=["northgate", "prime"])
        self.assertEqual(self._findings("matcher_nesting")[0]["rule_ids"], [broad, narrow])

    def test_a_keyword_containing_an_alternative_nests_inside_the_alternatives_rule(self):
        broad = self._rule(alternatives=["northgate", "nrthgt"])
        narrow = self._rule(keyword="northgate prime")
        self.assertEqual(self._findings("matcher_nesting")[0]["rule_ids"], [broad, narrow])

    def test_one_of_the_alternatives_alone_is_the_narrower_rule(self):
        # The plain rule matches a subset of the alternatives rule's rows, so it is the narrower one and
        # wins, although the alternatives rule's joined text is longer.
        broad = self._rule(alternatives=["northgate", "nrthgt"])
        narrow = self._rule(keyword="northgate")
        finding = self._findings("matcher_nesting")[0]
        self.assertEqual(finding["rule_ids"], [broad, narrow])
        self.assertEqual(finding["winner_rule_id"], narrow)

    def test_a_keyword_inside_only_some_alternatives_does_not_nest(self):
        self._rule(alternatives=["northgate", "nrthgt"])
        self._rule(keyword="north")
        self.assertEqual(self._findings("matcher_nesting"), [])

    def test_a_limit_only_the_shorter_keyword_carries_is_a_split_not_a_nesting(self):
        # Neither rule contains the other: one is limited to an account, the other has the longer keyword.
        # Scope outranks keyword length, so the short account-scoped rule takes that account's rows.
        self._txn("NORTHGATE PRIME 0412")
        scoped = self._differing(keyword="northgate", account_id=self.checking_id)
        self._rule(keyword="northgate prime")
        self.assertEqual(self._findings("matcher_nesting"), [])
        finding = self._findings("matcher_scope_split")[0]
        self.assertEqual(finding["rule_ids"][0], scoped)
        self.assertEqual(finding["winner_rule_id"], scoped)
        self.assertEqual(finding["deciding_scope"], "account")
        self.assertEqual(finding["txn_count"], 1)

    def test_a_split_no_transaction_shows_is_not_reported(self):
        # Without a row matching both, the pair is hypothetical.
        self._differing(keyword="northgate", account_id=self.checking_id)
        self._rule(keyword="northgate prime")
        self.assertEqual(self._findings()["findings"], [])

    def test_a_split_whose_rules_do_the_same_thing_is_not_reported(self):
        # Whichever wins, the row ends up the same.
        self._txn("NORTHGATE PRIME 0412")
        self._rule(keyword="northgate", account_id=self.checking_id)
        self._rule(keyword="northgate prime")
        self.assertEqual(self._findings()["findings"], [])

    def test_a_limit_on_the_longer_keyword_still_nests(self):
        # The longer keyword is also the more limited rule, so it matches a subset of the other's rows.
        broad = self._rule(keyword="northgate")
        narrow = self._rule(keyword="northgate prime", account_id=self.checking_id)
        finding = self._findings("matcher_nesting")[0]
        self.assertEqual(finding["rule_ids"], [broad, narrow])
        self.assertEqual(finding["removable_rule_id"], narrow)

    def test_nesting_is_not_reported_when_the_two_can_never_match_one_row(self):
        # Text nests, but no charge satisfies both amount windows, so they never contend.
        self._rule(keyword="northgate", amount_max=50)
        self._rule(keyword="northgate prime", amount_min=1000)
        self.assertEqual(self._findings("matcher_nesting"), [])

    def test_nesting_is_not_reported_across_different_owners(self):
        self._rule(keyword="northgate", owner_id=SHARED_OWNER_ID)
        self._rule(keyword="northgate prime", owner_id=self.other_owner_id)
        self.assertEqual(self._findings("matcher_nesting"), [])

    def test_the_narrow_rule_is_redundant_when_both_file_the_same_way(self):
        # The user's actual shape: `aji` and `aji restaurant` both filing to Restaurants. The narrow rule
        # changes no categorization, so it is the removable half.
        self._rule(keyword="northgate")
        narrow = self._rule(keyword="northgate prime")
        self.assertEqual(self._findings("matcher_nesting")[0]["removable_rule_id"], narrow)

    def test_a_different_category_is_not_redundant(self):
        # The narrow rule is the whole reason those rows are filed where they are.
        other = self._other_category("Subscriptions")
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime", category_id=other)
        self.assertIsNone(self._findings("matcher_nesting")[0]["removable_rule_id"])

    def test_a_rename_only_the_narrow_rule_carries_is_not_redundant(self):
        # Deleting it would change those transactions' name, so the two rules do not do the same thing.
        self._rule(keyword="northgate")
        self._differing(keyword="northgate prime")
        self.assertIsNone(self._findings("matcher_nesting")[0]["removable_rule_id"])

    def test_a_narrower_amount_range_on_the_broad_rule_is_not_redundant(self):
        # The broad rule stops at $50, so the narrow rule's larger charges would be left to nothing.
        self._rule(keyword="northgate", amount_max=50)
        self._rule(keyword="northgate prime")
        self.assertIsNone(self._findings("matcher_nesting")[0]["removable_rule_id"])

    def test_a_direction_difference_is_not_redundant(self):
        self._rule(keyword="northgate", debit_credit="debit")
        self._rule(keyword="northgate prime")
        self.assertIsNone(self._findings("matcher_nesting")[0]["removable_rule_id"])

    def test_unrelated_keywords_do_not_nest(self):
        self._rule(keyword="northgate")
        self._rule(keyword="riverstone")
        self.assertEqual(self._findings("matcher_nesting"), [])

    def test_an_accidental_substring_is_still_a_real_interaction(self):
        # "bp" genuinely matches a "bpost" transaction, so this is information rather than noise.
        broad = self._rule(keyword="bp")
        narrow = self._rule(keyword="bpost")
        self.assertEqual(self._findings("matcher_nesting")[0]["rule_ids"], [broad, narrow])

    def test_identical_matchers_are_never_a_nesting_finding(self):
        # They nest in both directions, which is not a subset relationship. Their range overlap is the
        # amount finding's business; nothing belongs in the informational section.
        self._rule(amount_min=300, amount_max=4000)
        self._rule(amount_min=3000)
        self.assertEqual(self._findings("matcher_nesting"), [])

    # --- What is out of scope entirely -------------------------------------------------------------

    def test_managed_rules_are_excluded(self):
        # Their matchers are the app's, so a finding naming one names nothing the user can act on.
        self._rule(keyword="northgate", is_managed=1)
        self._rule(keyword="northgate prime")
        self.assertEqual(self._findings()["count"], 0)

    def test_trashed_rules_are_excluded(self):
        self._rule(keyword="northgate", deleted_at="2026-01-01T00:00:00")
        self._rule(keyword="northgate prime")
        self.assertEqual(self._findings()["count"], 0)

    def test_rules_targeting_a_deactivated_category_are_excluded(self):
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE category SET is_active = 0 WHERE id = ?", (self.category_id,))
        self.assertEqual(self._findings()["count"], 0)

    def test_a_single_rule_produces_nothing(self):
        self._rule(amount_min=300, amount_max=4000)
        self.assertEqual(self._findings()["count"], 0)

    def test_findings_are_counted_by_kind_and_warnings_sort_first(self):
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        self._rule(keyword="town of harborline", amount_min=300, amount_max=4000)
        self._differing(keyword="town of harborline", amount_min=3000)
        result = self._findings()
        self.assertEqual(result["counts"], {"amount_overlap": 1, "matcher_nesting": 1})
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["findings"][0]["kind"], "amount_overlap")

    def test_the_broadest_matcher_leads_the_informational_section(self):
        self._rule(keyword="northgate market")
        self._rule(keyword="northgate market downtown")
        self._rule(keyword="bp")
        self._rule(keyword="bpost")
        nesting = self._findings("matcher_nesting")
        self.assertEqual(len(nesting), 2)
        first_ids = nesting[0]["rule_ids"]
        with self._use_db_path():
            with get_db() as conn:
                keyword = conn.execute(
                    "SELECT keyword FROM category_rule WHERE id = ?", (first_ids[0],)
                ).fetchone()["keyword"]
        self.assertEqual(keyword, "bp")


    # --- When the winner changes nothing ----------------------------------------------------------
    #
    # A competing pair is only a problem if the rule that wins decides something. Two spellings of one
    # merchant filing to one category fight forever over an outcome that is identical either way, and the
    # user may wave that through. The winner is decided per action, though, and only where both rules set
    # it: a rename or tag only one side carries applies whichever wins, while two different renames, two
    # different categories, or two recurring series are each a real difference.

    def _tag(self, rule_id, name="Reimbursable"):
        tag_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("INSERT INTO tag (id, name, color) VALUES (?, ?, '#888888')", (tag_id, name))
                conn.execute("INSERT INTO rule_tag (rule_id, tag_id) VALUES (?, ?)", (rule_id, tag_id))
        return tag_id

    def test_an_overlap_whose_rules_file_identically_is_information(self):
        self._rule(amount_min=300, amount_max=4000)
        self._rule(amount_min=3000)
        findings = self._findings("amount_overlap_benign")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["severity"], "info")
        # And no warning was raised for the same pair.
        self.assertEqual(self._findings("amount_overlap"), [])

    def test_a_benign_overlap_may_be_acknowledged(self):
        self._rule(amount_min=300, amount_max=4000)
        self._rule(amount_min=3000)
        finding = self._findings("amount_overlap_benign")[0]
        self.assertTrue(finding["dismissible"])
        self._dismiss(finding)
        self.assertEqual(self._findings()["count"], 0)

    def test_a_rename_on_one_side_applies_whichever_wins(self):
        self._rule(amount_min=300, amount_max=4000)
        self._rule(amount_min=3000, clean_name="Harborline Water")
        self.assertEqual(self._findings("amount_overlap"), [])
        self.assertEqual(len(self._findings("amount_overlap_benign")), 1)

    def test_two_different_renames_are_a_real_difference(self):
        self._rule(amount_min=300, amount_max=4000, clean_name="Harborline Utilities")
        self._rule(amount_min=3000, clean_name="Harborline Water")
        self.assertEqual(len(self._findings("amount_overlap")), 1)

    def test_a_category_on_one_side_applies_whichever_wins(self):
        self._rule(amount_min=300, amount_max=4000)
        self._rule(amount_min=3000, category_id=None, clean_name="Harborline Water")
        self.assertEqual(len(self._findings("amount_overlap_benign")), 1)

    def test_tags_on_one_side_are_added_whichever_wins(self):
        self._rule(amount_min=300, amount_max=4000)
        self._tag(self._rule(amount_min=3000))
        self.assertEqual(self._findings("amount_overlap"), [])
        self.assertEqual(len(self._findings("amount_overlap_benign")), 1)

    def test_two_recurring_rules_are_a_real_difference(self):
        # Each owns a series and a transaction joins only one, which rule precedence does not decide.
        first = self._rule(amount_min=300, amount_max=4000)
        second = self._rule(amount_min=3000)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE category_rule SET is_recurring = 1 WHERE id IN (?, ?)", (first, second))
        self.assertEqual(len(self._findings("amount_overlap")), 1)

    def test_a_benign_pair_whose_actions_differ_offers_no_removal(self):
        # Deleting the tagged rule would take its tag off every row, even though it never decided anything.
        self._txn("TOWN OF HARBORLINE", amount=3500)
        self._rule(amount_min=300, amount_max=4000)
        self._tag(self._rule(amount_min=3000))
        finding = self._findings("amount_overlap_benign")[0]
        self.assertIsNone(finding["removable_rule_id"])

    def test_a_different_category_is_a_real_difference(self):
        self._rule(amount_min=300, amount_max=4000)
        self._rule(amount_min=3000, category_id=self._other_category("Water"))
        self.assertEqual(len(self._findings("amount_overlap")), 1)

    def test_two_tag_only_rules_with_the_same_tags_are_benign(self):
        # No category on either side, so "same category" says nothing — but the rules genuinely do the
        # same thing, which is the question that matters.
        shared = self._rule(amount_min=300, amount_max=4000, category_id=None)
        other = self._rule(amount_min=3000, category_id=None)
        tag_id = self._tag(shared)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("INSERT INTO rule_tag (rule_id, tag_id) VALUES (?, ?)", (other, tag_id))
        self.assertEqual(len(self._findings("amount_overlap_benign")), 1)

    def test_the_benign_verdict_is_in_the_key_so_an_acknowledgement_lapses(self):
        # Acknowledging "these two do the same thing" must not also acknowledge them once they stop.
        first = self._rule(amount_min=300, amount_max=4000)
        self._rule(amount_min=3000)
        self._dismiss(self._findings("amount_overlap_benign")[0])
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE category_rule SET category_id = ? WHERE id = ?",
                             (self._other_category("Water"), first))
        result = self._findings()
        self.assertEqual(result["counts"], {"amount_overlap": 1})
        self.assertEqual(result["dismissed_count"], 0)

    # --- Rules that match one transaction by different parts of its name ---------------------------
    #
    # The ambiguity neither other kind can see: two matchers that neither repeat nor contain each other,
    # both landing in one merchant name. Precedence settles it on keyword length, but length stands for
    # "a longer substring matches a strict subset", and between matchers that do not nest there is no
    # subset for it to be about. Unlike every other finding here, it cannot be answered from the rules
    # alone — whether two unrelated keywords ever co-occur is a fact about the ledger.

    def test_two_unrelated_keywords_matching_one_row_are_reported(self):
        self._rule(keyword="northgate")
        self._differing(keyword="riverstone")
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        findings = self._findings("matcher_co_match")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["severity"], "warning")
        self.assertEqual(findings[0]["txn_count"], 1)
        self.assertEqual(findings[0]["txn_name"], "NORTHGATE RIVERSTONE SUPPLY")

    def test_unrelated_keywords_alone_are_still_silent(self):
        # The pre-existing behaviour, and the reason the scan exists: without a row that matches both,
        # there is nothing to report — the rules themselves cannot say whether they ever meet.
        self._rule(keyword="northgate")
        self._differing(keyword="riverstone")
        self.assertEqual(self._findings("matcher_co_match"), [])

    def test_the_count_and_example_describe_the_collisions(self):
        self._rule(keyword="northgate")
        self._differing(keyword="riverstone")
        self._txn("NORTHGATE RIVERSTONE SUPPLY", date="2026-01-05")
        self._txn("NORTHGATE RIVERSTONE SUPPLY", date="2026-04-09")
        finding = self._findings("matcher_co_match")[0]
        self.assertEqual(finding["txn_count"], 2)
        # The most recent collision is the example, being the one the user can still recognize.
        self.assertEqual(finding["txn_date"], "2026-04-09")

    def test_the_winner_is_named_and_listed_first(self):
        # Length decides, on nothing: "riverstone" is longer, so it takes the row.
        self._rule(keyword="northgate")
        longer = self._differing(keyword="riverstone")
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        finding = self._findings("matcher_co_match")[0]
        self.assertEqual(finding["winner_rule_id"], longer)
        self.assertEqual(finding["rule_ids"][0], longer)

    def test_a_co_match_warning_cannot_be_dismissed(self):
        self._rule(keyword="northgate")
        self._differing(keyword="riverstone")
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        finding = self._findings("matcher_co_match")[0]
        self.assertFalse(finding["dismissible"])
        with self.assertRaises(ValueError):
            self._dismiss(finding)

    def test_a_co_match_whose_rules_file_identically_is_information(self):
        # Two spellings of one merchant, both filing the same way: the real shape this mostly takes.
        self._rule(keyword="northgate")
        self._rule(keyword="nrthgt")
        self._txn("NORTHGATE / NRTHGT MARKET")
        findings = self._findings("matcher_co_match_benign")
        self.assertEqual(len(findings), 1)
        self.assertTrue(findings[0]["dismissible"])

    def test_a_benign_pair_offers_to_remove_the_rule_whose_every_transaction_the_other_matches(self):
        self._txn("HARBORLINE WATER")
        self._txn("HARBORLINE GAS")
        self._rule(keyword="harborline")
        water = self._rule(keyword="water")
        self.assertEqual(self._findings("matcher_co_match_benign")[0]["removable_rule_id"], water)

    def test_a_benign_pair_where_each_rule_has_its_own_transactions_offers_no_removal(self):
        self._txn("HARBORLINE WATER")
        self._txn("HARBORLINE GAS")
        self._txn("CITY WATER")
        self._rule(keyword="harborline")
        self._rule(keyword="water")
        self.assertIsNone(self._findings("matcher_co_match_benign")[0]["removable_rule_id"])

    def test_a_nesting_pair_is_not_also_reported_as_a_co_match(self):
        # Nested matchers co-match by definition; the informational nesting finding already has them.
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        self._txn("NORTHGATE PRIME MARKET")
        self.assertEqual(self._findings("matcher_co_match"), [])
        self.assertEqual(self._findings("matcher_co_match_benign"), [])
        self.assertEqual(len(self._findings("matcher_nesting")), 1)

    def test_identical_matchers_are_not_a_co_match(self):
        self._rule(amount_min=300, amount_max=4000)
        self._differing(amount_min=3000)
        self._txn("TOWN OF HARBORLINE", amount=3500)
        self.assertEqual(self._findings("matcher_co_match"), [])
        self.assertEqual(len(self._findings("amount_overlap")), 1)

    def test_a_scope_difference_is_resolved_before_matcher_length(self):
        # Owner scope is a genuine refinement and outranks the keyword term, so this pair has a
        # principled winner however unrelated the two matchers are.
        self._rule(keyword="northgate", owner_id=SHARED_OWNER_ID)
        self._differing(keyword="riverstone")
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self.assertEqual(self._findings("matcher_co_match"), [])

    def test_an_amount_range_that_excludes_the_row_prevents_the_finding(self):
        self._rule(keyword="northgate", amount_max=50)
        self._differing(keyword="riverstone")
        self._txn("NORTHGATE RIVERSTONE SUPPLY", amount=900)
        self.assertEqual(self._findings("matcher_co_match"), [])

    def test_a_trashed_transaction_is_not_evidence(self):
        self._rule(keyword="northgate")
        self._differing(keyword="riverstone")
        txn_id = self._txn("NORTHGATE RIVERSTONE SUPPLY")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE txn SET trashed_at = '2026-05-01' WHERE id = ?", (txn_id,))
        self.assertEqual(self._findings("matcher_co_match"), [])


class RuleOverlapDismissalTests(RuleOverlapsTests):
    """Acknowledging a finding, and the two properties that make the feature trustworthy rather than just
    quiet.

    **An amount overlap can never be dismissed.** It is an arbitrary outcome rather than information —
    the ordering's last terms settle it reproducibly, but on no basis that is about these two rules — so it
    stays listed until the conditions are refined. The
    refusal is enforced where findings are assembled, not only in the panel, so a stored row cannot hide
    a warning however it got there.

    **A dismissal covers the situation it was made about, not the pair of rules forever.** The key
    carries what made the finding actionable, so an edit that changes that brings the finding back.
    """

    def test_an_amount_overlap_cannot_be_dismissed(self):
        self._rule(amount_min=300, amount_max=4000)
        self._differing(amount_min=3000)
        finding = self._findings("amount_overlap")[0]
        self.assertFalse(finding["dismissible"])
        with self.assertRaises(ValueError):
            self._dismiss(finding)

    def test_a_stored_dismissal_can_never_hide_an_amount_overlap(self):
        # Belt and braces: even a row inserted by hand (or left by an older build) must not suppress a
        # warning, because the filter checks the kind and not just the table.
        self._rule(amount_min=300, amount_max=4000)
        self._differing(amount_min=3000)
        finding = self._findings("amount_overlap")[0]
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO rule_overlap_dismissal (finding_key, kind) VALUES (?, 'amount_overlap')",
                    (finding["key"],),
                )
        result = self._findings()
        self.assertEqual(result["counts"].get("amount_overlap"), 1)
        self.assertEqual(result["dismissed_count"], 0)
        self.assertFalse(result["findings"][0]["dismissed"])

    def test_a_nesting_finding_is_dismissible(self):
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        self.assertTrue(self._findings("matcher_nesting")[0]["dismissible"])

    def test_a_dismissed_finding_stops_being_listed(self):
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        self._dismiss(self._findings("matcher_nesting")[0])
        result = self._findings()
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["dismissed_count"], 1)

    def test_dismissed_findings_come_back_flagged_when_asked_for(self):
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        self._dismiss(self._findings("matcher_nesting")[0])
        result = self._findings(include_dismissed=True)
        self.assertEqual(len(result["findings"]), 1)
        self.assertTrue(result["findings"][0]["dismissed"])
        # Counts describe the open work either way, so revealing the set cannot read as new work.
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["counts"], {})

    def test_restoring_puts_it_back(self):
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        finding = self._findings("matcher_nesting")[0]
        self._dismiss(finding)
        self._restore(finding)
        self.assertEqual(self._findings()["count"], 1)
        self.assertEqual(self._findings()["dismissed_count"], 0)

    def test_a_dismissal_survives_an_edit_that_changes_nothing_material(self):
        # Giving both rules the same new rename leaves the pair exactly as it was answered.
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        self._dismiss(self._findings("matcher_nesting")[0])
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE category_rule SET clean_name = 'Northgate'")
        self.assertEqual(self._findings()["count"], 0)

    def test_a_pair_that_becomes_removable_surfaces_again(self):
        # Dismissed while the narrow rule was doing work of its own; once it files the same way, it is
        # surplus and the finding now offers a delete — which the user has never been asked about.
        other = self._other_category("Subscriptions")
        self._rule(keyword="northgate")
        narrow = self._rule(keyword="northgate prime", category_id=other)
        first = self._findings("matcher_nesting")[0]
        self.assertIsNone(first["removable_rule_id"])
        self._dismiss(first)
        self.assertEqual(self._findings()["count"], 0)
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE category_rule SET category_id = ? WHERE id = ?", (self.category_id, narrow))
        reopened = self._findings("matcher_nesting")
        self.assertEqual(len(reopened), 1)
        self.assertEqual(reopened[0]["removable_rule_id"], narrow)

    def test_a_dismissal_whose_pair_dissolves_is_simply_never_matched(self):
        self._rule(keyword="northgate")
        narrow = self._rule(keyword="northgate prime")
        self._dismiss(self._findings("matcher_nesting")[0])
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE category_rule SET keyword = 'riverstone' WHERE id = ?", (narrow,))
        result = self._findings()
        self.assertEqual(result["count"], 0)
        # Nothing prunes the row, but it counts against nothing either.
        self.assertEqual(result["dismissed_count"], 0)

    def test_dismissing_twice_is_not_an_error(self):
        self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        finding = self._findings("matcher_nesting")[0]
        self._dismiss(finding)
        self._dismiss(finding)
        self.assertEqual(self._findings()["dismissed_count"], 1)


class RuleOverlapsEndpointTests(RuleOverlapsTests):
    """The endpoint on top of the detection: it attaches each referenced rule once, in the shape the
    rules list returns, so the dialog can render a finding's two rules the way the list renders them."""

    def _payload(self):
        from backend.routers.rules import rule_overlaps

        with self._use_db_path():
            return rule_overlaps()

    def test_every_referenced_rule_is_returned_ready_to_render(self):
        low = self._rule(amount_min=300, amount_max=4000, account_id=self.checking_id)
        high = self._rule(amount_min=3000, account_id=self.checking_id)
        payload = self._payload()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(set(payload["rules"]), {low, high})
        rendered = payload["rules"][low]
        self.assertEqual(rendered["clauses"], ["town of harborline"])
        self.assertEqual(rendered["category_name"], "Utilities")
        self.assertEqual(rendered["account_name"], "Harborline Checking")
        self.assertEqual(rendered["tags"], [])

    def test_a_rule_in_several_findings_is_carried_once(self):
        # The two long keywords nest into the short one but not into each other, so one rule appears in
        # both findings and must still be carried once.
        broad = self._rule(keyword="northgate")
        self._rule(keyword="northgate prime")
        self._rule(keyword="northgate market")
        payload = self._payload()
        self.assertEqual(payload["counts"]["matcher_nesting"], 2)
        self.assertEqual(len(payload["rules"]), 3)
        self.assertIn(broad, payload["rules"])

    def test_nothing_to_report_carries_no_rules(self):
        self._rule(keyword="northgate")
        payload = self._payload()
        self.assertEqual(payload["count"], 0)
        self.assertEqual(payload["rules"], {})


if __name__ == "__main__":
    unittest.main()
