"""
The ledger's currency setting, and the rule it feeds.

The bug this replaced is the one worth keeping in view: the currency check compared against a hardcoded
`"USD"`, which asks the wrong question. The app's constraint is **one currency at a time** — a
consistently-AUD ledger is entirely correct — so treating "not dollars" as the error case would have
discarded every transaction belonging to a non-US user whose data was never wrong in the first place.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import currency as currency_router
from backend.services.ledger_currency import (
    DEFAULT_LEDGER_CURRENCY,
    InvalidCurrencyCode,
    currency_matches,
    get_ledger_currency,
    is_default,
    normalize_currency_code,
    set_ledger_currency,
)


class LedgerCurrencyTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "currency.db"
        init_db(str(self.db_path))

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

    # ---- the setting ----------------------------------------------------

    def test_an_unset_ledger_reads_as_the_default(self):
        with self._db() as conn:
            self.assertEqual(get_ledger_currency(conn), DEFAULT_LEDGER_CURRENCY)
            self.assertTrue(is_default(conn))

    def test_setting_it_persists_and_normalizes(self):
        with self._db() as conn:
            self.assertEqual(set_ledger_currency(conn, " aud "), "AUD")
            self.assertEqual(get_ledger_currency(conn), "AUD")
            self.assertFalse(is_default(conn))

    def test_a_corrupt_stored_value_degrades_to_the_default(self):
        # A read that raised would break every sync and every mapping list over a setting. Falling back to
        # the app's historical behaviour is recoverable; failing closed is not.
        from backend.db.database import set_tenant_workflow_state
        with self._db() as conn:
            set_tenant_workflow_state(conn, "ledger_currency", {"code": "not-a-code"})
            self.assertEqual(get_ledger_currency(conn), DEFAULT_LEDGER_CURRENCY)

    def test_shape_is_validated_but_membership_is_not(self):
        # Validating against a list of real codes would mean maintaining one, and its failure mode is
        # rejecting a legitimate currency because nobody updated it. A well-formed code the user made up
        # costs them a visible typo, which is self-correcting.
        self.assertEqual(normalize_currency_code("aud"), "AUD")
        self.assertEqual(normalize_currency_code("XYZ"), "XYZ")
        for bad in ("", "US", "USDD", "US1", "€€€", None):
            with self.assertRaises(InvalidCurrencyCode):
                normalize_currency_code(bad)

    # ---- the rule it feeds ----------------------------------------------

    def test_the_question_is_match_not_dollars(self):
        # The regression this file exists for. On an AUD ledger, AUD is the *supported* case and USD is
        # the mismatch — exactly inverted from the hardcoded check this replaced.
        self.assertTrue(currency_matches("AUD", "AUD"))
        self.assertFalse(currency_matches("AUD", "USD"))
        self.assertTrue(currency_matches("USD", "USD"))
        self.assertFalse(currency_matches("USD", "AUD"))

    def test_an_unstated_currency_always_matches(self):
        # Optional in more than one protocol, so absence means "not stated" rather than "not ours".
        # Rejecting an account because its bank omitted a field would discard real data on a formatting gap.
        for unstated in (None, "", "   "):
            self.assertTrue(currency_matches("AUD", unstated))

    def test_matching_ignores_case(self):
        self.assertTrue(currency_matches("aud", "AUD"))
        self.assertTrue(currency_matches("AUD", "aud"))


class CurrencyEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "currency-api.db"
        init_db(str(self.db_path))
        self.token = set_current_db_path(str(self.db_path))

    def tearDown(self):
        reset_current_db_path(self.token)
        self.tempdir.cleanup()

    def _add_transaction(self):
        with get_db() as conn:
            owner = conn.execute("SELECT id FROM owner LIMIT 1").fetchone()["id"]
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id) "
                "VALUES ('acct-1','A','A','depository',?)", (owner,),
            )
            conn.execute(
                "INSERT INTO txn (id, account_id, date, amount, merchant_name) "
                "VALUES ('t-1','acct-1','2026-08-01', 10.0, 'Shop')"
            )

    def test_an_empty_ledger_changes_without_confirmation(self):
        # The first-run case, which is when most people will set this. There is nothing to relabel, so
        # asking them to confirm would be ceremony over nothing.
        state = currency_router.set_currency(currency_router.CurrencyRequest(code="AUD"))
        self.assertEqual(state["code"], "AUD")
        self.assertFalse(state["requires_confirmation"])

    def test_a_populated_ledger_refuses_until_confirmed(self):
        from fastapi import HTTPException
        self._add_transaction()
        with self.assertRaises(HTTPException) as caught:
            currency_router.set_currency(currency_router.CurrencyRequest(code="AUD"))
        self.assertEqual(caught.exception.status_code, 409)
        detail = caught.exception.detail
        self.assertEqual(detail["code"], "currency_change_needs_confirmation")
        # The dialog is built from this payload, so it has to carry both ends and the scope.
        self.assertEqual((detail["from"], detail["to"]), ("USD", "AUD"))
        self.assertEqual(detail["transaction_count"], 1)
        self.assertEqual(currency_router.get_currency()["code"], "USD", "nothing changed on a refusal")

    def test_confirming_applies_it_and_converts_nothing(self):
        self._add_transaction()
        state = currency_router.set_currency(currency_router.CurrencyRequest(code="AUD", confirm=True))
        self.assertEqual(state["code"], "AUD")
        with get_db() as conn:
            amount = conn.execute("SELECT amount FROM txn WHERE id = 't-1'").fetchone()["amount"]
        # The amount is untouched — which is the whole point, and also why it needs confirming: the
        # number now means AUD purely because the label changed.
        self.assertEqual(amount, 10.0)

    def test_it_is_reversible_on_the_same_terms(self):
        # The reason a confirmation is the right guard rather than a prohibition.
        self._add_transaction()
        currency_router.set_currency(currency_router.CurrencyRequest(code="AUD", confirm=True))
        state = currency_router.set_currency(currency_router.CurrencyRequest(code="USD", confirm=True))
        self.assertEqual(state["code"], "USD")

    def test_resaving_the_same_currency_needs_no_confirmation(self):
        # Not a change, so there is nothing to warn about — including when the case differs.
        self._add_transaction()
        state = currency_router.set_currency(currency_router.CurrencyRequest(code="usd"))
        self.assertEqual(state["code"], "USD")

    def test_a_malformed_code_is_rejected_before_anything_is_stored(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as caught:
            currency_router.set_currency(currency_router.CurrencyRequest(code="dollars"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(currency_router.get_currency()["code"], "USD")


if __name__ == "__main__":
    unittest.main()
