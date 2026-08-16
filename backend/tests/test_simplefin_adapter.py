"""
The SimpleFIN adapter: normalization, the backward history walk, and the request budget.

The fixtures are shaped from the published protocol's example payload
(https://www.simplefin.org/protocol.html) and checked against one live run of the Bridge's demo account.
They deliberately cover the parts a real server varies: `errlist` entries as objects vs. an older `errors`
list of strings, and institution names arriving on a top-level `connections` list vs. an `org` object per
account.

What is worth testing here is not the field mapping but the things with no analog in the Plaid adapter: a
walk that has to *discover* where history ends because nothing reports it, a request budget whose penalty
for being exceeded is the provider disabling the token, and — see `SimpleFinTransportTests` — the HTTP
layer every other test in this file mocks away, which is where a real outage came from.

Two facts came from the live server rather than the documentation, and are worth stating because the
documentation still disagrees with them: the recommended date-range width is **45 days**, not the 90 the
developer guide gives (a 90-day request is answered with a deprecation notice), and the server fronts
itself with a CDN that rejects unnamed HTTP clients outright.
"""

from __future__ import annotations

import io
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from datetime import time as dtime
from unittest import mock

from backend.services.providers import get_adapter
from backend.services.providers.simplefin import (
    EMPTY_WINDOWS_END_HISTORY,
    _merge_advisories,
    FILTERED_WALK_MAX_ACCOUNTS,
    INCREMENTAL_OVERLAP_DAYS,
    REQUEST_BUDGET_CAPACITY,
    REQUEST_BUDGET_REFILL_PER_HOUR,
    WINDOW_DAYS,
    SimpleFinAdapter,
    SimpleFinError,
)

ACCESS_URL = "https://user-abc:pass-xyz@beta-bridge.simplefin.org/simplefin"


def _ext_id(bank_txn_id, bank_account_id="2930002"):
    """The `external_transaction_id` the adapter produces for a bank's own transaction id.

    A SimpleFIN transaction id is unique only within its account, so the adapter namespaces it by the
    (already provider-namespaced) account id. Stated once here rather than spelled out per assertion, so
    these tests read as "the row for t1" and do not have to be rewritten if the format moves."""
    return f"simplefin:{bank_account_id}:{bank_txn_id}"


# The demo token from the Bridge's developer guide: base64 of a claim URL under /claim/DEMO-.
DEMO_TOKEN = (
    "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9ERU1PLXYyLTE2QjA5NDU1RTY4MUIxMjE1ODM2"
)


def _epoch(iso: str) -> int:
    return int(datetime.combine(date.fromisoformat(iso), datetime.min.time(), tzinfo=timezone.utc).timestamp())


def _txn(txn_id, posted, amount, description, **extra):
    return {"id": txn_id, "posted": _epoch(posted), "amount": amount, "description": description, **extra}


def _payload(transactions=None, *, errlist=None, accounts=None):
    return {
        "errlist": errlist or [],
        "connections": [{
            "conn_id": "CONN-1", "name": "My Bank - Mark", "org_id": "INST-1",
            "org_name": "My Bank", "org_url": "https://mybank.example",
        }],
        "accounts": accounts if accounts is not None else [{
            "id": "2930002", "name": "Savings", "conn_id": "CONN-1", "currency": "USD",
            "balance": "100.23", "available-balance": "75.23", "balance-date": 978366153,
            "transactions": transactions or [],
        }],
    }


def drain_pull(fetch_page, targets):
    """Every page of one pull, merged the way `run_sync` merges them.

    A page is `WINDOWS_PER_PAGE` windows, so one `fetch_transactions_sync` no longer walks a history to
    its end — the caller comes back while `has_more`, committing as it goes. Tests about what a *walk*
    does go through here; tests about what a single *page* does call the adapter directly.

    Two details mirror the sync layer rather than being conveniences. Targets are re-derived from the
    coverage each page reports, because that is what the caller does by re-reading `connection_account`;
    a frozen target list would restart every page from the same resume point and loop forever. And
    advisories are folded with the adapter's own `_merge_advisories`, because a `count` is now per page
    and "how many of this *pull's* requests drew it" is the caller's sum.
    """
    added, coverage, advisories, warnings, page = [], {}, {}, {}, None
    targets = [dict(t) for t in targets]
    for _ in range(200):
        page = fetch_page(targets)
        added.extend(page["added"])
        coverage.update(page.get("account_coverage") or {})
        _merge_advisories(advisories, page.get("advisories") or [])
        warnings.update(dict.fromkeys(page.get("warnings") or []))
        if not page["has_more"]:
            break
        targets = [
            {**t,
             "reached": coverage.get(t["external_account_id"], {}).get("reached", t.get("reached")),
             "empty_streak": coverage.get(t["external_account_id"], {}).get(
                 "empty_streak", t.get("empty_streak", 0))}
            for t in targets
            if not coverage.get(t["external_account_id"], {}).get("complete")
        ]
    return {**page, "added": added, "account_coverage": coverage,
            "advisories": list(advisories.values()), "warnings": list(warnings)}


class _Server:
    """Stands in for the Bridge, recording every request and its date window. `windows` maps an
    (start, end) ISO pair to the transactions that window should return; anything unlisted is empty,
    which is how "history ran out" is expressed."""

    def __init__(self, windows=None, payload=None):
        self.windows = windows or {}
        self.payload = payload
        self.calls = []

    def __call__(self, url, *, method="GET", headers=None):
        self.calls.append(url)
        if self.payload is not None:
            return json.dumps(self.payload).encode()
        from urllib.parse import parse_qs, urlsplit
        q = parse_qs(urlsplit(url).query)
        if "start-date" not in q:
            return json.dumps(_payload()).encode()
        start = datetime.fromtimestamp(int(q["start-date"][0]), tz=timezone.utc).date().isoformat()
        end = datetime.fromtimestamp(int(q["end-date"][0]), tz=timezone.utc).date().isoformat()
        return json.dumps(_payload(self.windows.get((start, end), []))).encode()

    @property
    def requested_windows(self):
        from urllib.parse import parse_qs, urlsplit
        out = []
        for url in self.calls:
            q = parse_qs(urlsplit(url).query)
            if "start-date" in q:
                out.append((
                    datetime.fromtimestamp(int(q["start-date"][0]), tz=timezone.utc).date(),
                    datetime.fromtimestamp(int(q["end-date"][0]), tz=timezone.utc).date(),
                ))
        return out

    @property
    def requested_spans(self):
        """Each request's wire span in seconds. The bounds are *instants*, so the date pairs above cannot
        show whether an end ran to midnight or to the close of its day — and that difference is the whole
        of what the server measures its range limit against."""
        from urllib.parse import parse_qs, urlsplit
        out = []
        for url in self.calls:
            q = parse_qs(urlsplit(url).query)
            if "start-date" in q:
                out.append(int(q["end-date"][0]) - int(q["start-date"][0]))
        return out


class SimpleFinNormalizationTests(unittest.TestCase):
    def setUp(self):
        self.adapter = SimpleFinAdapter()

    def _sync(self, server, cursor=None, days_requested=730, today="2026-08-07"):
        with mock.patch("backend.services.providers.simplefin._http", server), \
                mock.patch("backend.services.providers.simplefin.date", _FrozenDate(today)):
            return self.adapter.fetch_transactions_sync({}, ACCESS_URL, cursor=cursor,
                                                        days_requested=days_requested)

    def test_registered_as_a_provider(self):
        self.assertIsInstance(get_adapter("simplefin"), SimpleFinAdapter)

    def test_declares_no_app_credential_and_no_cursor(self):
        # Both are what stop the routers treating it as a half-configured Plaid: "no app config" is its
        # permanent normal state, and every pull is a date range rather than a change feed.
        self.assertFalse(self.adapter.requires_app_config)
        self.assertFalse(self.adapter.has_cursor)

    def test_amount_sign_is_inverted(self):
        # SimpleFIN signs money out negative; Luma signs it positive. A missed inversion would not error,
        # it would silently file every expense as income.
        server = _Server(payload=_payload([_txn("t1", "2026-08-01", "-33.87", "COFFEE"),
                                           _txn("t2", "2026-08-02", "1200.00", "PAYROLL")]))
        rows = {r["external_transaction_id"]: r for r in self._sync(server)["added"]}
        self.assertEqual(rows[_ext_id("t1")]["amount"], 33.87)
        self.assertEqual(rows[_ext_id("t2")]["amount"], -1200.00)

    def test_transacted_at_becomes_authorized_date(self):
        server = _Server(payload=_payload([
            _txn("t1", "2026-08-03", "-10.00", "SHOP", transacted_at=_epoch("2026-08-01")),
        ]))
        row = self._sync(server)["added"][0]
        self.assertEqual(row["date"], "2026-08-03")
        self.assertEqual(row["authorized_date"], "2026-08-01")

    def test_missing_transacted_at_leaves_authorized_date_absent(self):
        server = _Server(payload=_payload([_txn("t1", "2026-08-03", "-10.00", "SHOP")]))
        self.assertIsNone(self._sync(server)["added"][0]["authorized_date"])

    def test_a_pending_rows_zero_posted_is_read_as_undated_not_as_1970(self):
        # `posted` is required by the protocol, so a charge that has not posted carries 0 rather than
        # omitting the field. Taken literally that is a valid epoch, and the row enters the ledger dated
        # 1970-01-01 — before every other transaction, outside every report period, and (since sync cards
        # are keyed on the transaction's own month) filed on a card labelled "January 1970". The
        # transaction date is the date such a row actually has, and is what it must be filed under.
        server = _Server(payload=_payload([{
            "id": "p1", "posted": 0, "transacted_at": _epoch("2026-08-11"),
            "amount": "-28.89", "description": "COCONUT NEWTON", "pending": True,
        }]))
        row = self._sync(server)["added"][0]
        self.assertEqual(row["date"], "2026-08-11")
        self.assertEqual(row["authorized_date"], "2026-08-11")
        self.assertTrue(row["is_pending"])

    def test_a_posted_date_still_wins_over_the_transaction_date(self):
        # The fallback above is exactly that — a fallback. Preferring `transacted_at` whenever it is present
        # would re-date every settled row in the ledger to when it was authorized, which is a different fact
        # and not the one totals are reported on.
        server = _Server(payload=_payload([
            _txn("t1", "2026-08-13", "-10.00", "SHOP", transacted_at=_epoch("2026-08-09")),
        ]))
        row = self._sync(server)["added"][0]
        self.assertEqual(row["date"], "2026-08-13")

    def test_a_row_with_no_date_at_all_is_dropped_rather_than_dated_from_nothing(self):
        # Neither field usable: there is no honest date to file it under, and inventing one (today, the
        # window bound) would plant a wrong date that reads exactly like a right one. Dropping is what
        # already happened to a row whose `posted` was missing outright; zero now reaches the same place.
        server = _Server(payload=_payload([
            {"id": "x1", "posted": 0, "amount": "-10.00", "description": "SHOP", "pending": True},
            _txn("t1", "2026-08-03", "-10.00", "SHOP"),
        ]))
        rows = self._sync(server)["added"]
        self.assertEqual([r["external_transaction_id"] for r in rows], [_ext_id("t1")])

    def test_payee_preferred_over_description_but_raw_name_keeps_the_descriptor(self):
        server = _Server(payload=_payload([
            _txn("t1", "2026-08-03", "-10.00", "SQ *COFFEE BAR 00123", payee="Coffee Bar"),
        ]))
        row = self._sync(server)["added"][0]
        self.assertEqual(row["merchant_name"], "Coffee Bar")
        self.assertEqual(row["raw_name"], "SQ *COFFEE BAR 00123")

    def test_account_ids_are_namespaced(self):
        # Accounts are looked up by external id with no provider filter, so an un-namespaced provider id
        # could collide with another provider's and route transactions into the wrong account.
        server = _Server(payload=_payload([_txn("t1", "2026-08-03", "-10.00", "SHOP")]))
        self.assertEqual(self._sync(server)["added"][0]["external_account_id"], "simplefin:2930002")

    def test_fetch_accounts_maps_institution_to_official_name(self):
        server = _Server(payload=_payload())
        with mock.patch("backend.services.providers.simplefin._http", server):
            accounts = self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertEqual(accounts[0]["external_account_id"], "simplefin:2930002")
        self.assertEqual(accounts[0]["name"], "Savings")
        self.assertEqual(accounts[0]["official_name"], "My Bank")
        self.assertIsNone(accounts[0]["mask"], "SimpleFIN supplies no mask; inventing one would be a lie")

    def test_fetch_accounts_falls_back_to_a_per_account_org_object(self):
        payload = _payload()
        payload.pop("connections")
        payload["accounts"][0]["org"] = {"name": "Older Server Bank", "domain": "old.example"}
        server = _Server(payload=payload)
        with mock.patch("backend.services.providers.simplefin._http", server):
            accounts = self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertEqual(accounts[0]["official_name"], "Older Server Bank")

    def test_fetch_accounts_asks_for_balances_only(self):
        server = _Server(payload=_payload())
        with mock.patch("backend.services.providers.simplefin._http", server):
            self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertIn("balances-only=1", server.calls[0])

    def test_credentials_are_sent_as_a_header_not_in_the_url(self):
        server = _Server(payload=_payload())
        with mock.patch("backend.services.providers.simplefin._http", server):
            self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertNotIn("pass-xyz", server.calls[0])

    def test_removed_is_always_empty(self):
        # Stated as a test because the empty list is load-bearing: it means "this provider cannot report
        # deletions", not "nothing was deleted", and a caller that confuses the two would trash live rows.
        server = _Server(payload=_payload([_txn("t1", "2026-08-03", "-10.00", "SHOP")]))
        self.assertEqual(self._sync(server)["removed"], [])


class SimpleFinErrorTests(unittest.TestCase):
    def setUp(self):
        self.adapter = SimpleFinAdapter()

    def _drain_walk(self, server, account):
        """A whole walk, since these are claims about what a *pull* reports rather than one page.

        Aggregation moved with the paging: an adapter now reports what one page saw, and folding those
        into "how many of this pull's requests drew the same remark" is the caller's job. `drain_pull`
        does it with the adapter's own `_merge_advisories`, which is the same fold `run_sync` applies.
        """
        budget, pages = {}, {"n": 0}

        def fetch_page(targets):
            with mock.patch("backend.services.providers.simplefin._http", server), \
                    mock.patch("backend.services.providers.simplefin._utc_today", lambda: date(2026, 8, 7)):
                page = self.adapter.fetch_transactions_sync(
                    {}, ACCESS_URL, account_targets=targets, request_budget=budget,
                    continuing=pages["n"] > 0)
            pages["n"] += 1
            return page

        return drain_pull(fetch_page, [
            {"external_account_id": account, "from_date": "2016-01-01",
             "reached": None, "empty_streak": 0},
        ])

    def test_error_with_no_accounts_is_raised_with_the_providers_message(self):
        server = _Server(payload=_payload(
            errlist=[{"code": "con.auth", "msg": "Authentication required", "conn_id": "CONN-1"}],
            accounts=[],
        ))
        with mock.patch("backend.services.providers.simplefin._http", server):
            with self.assertRaises(SimpleFinError) as caught:
                self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertIn("Authentication required", str(caught.exception))

    def test_one_banks_error_does_not_discard_the_other_banks_accounts(self):
        # One access URL can span several institutions. A stale login at one of them must not stop every
        # other account on the same URL from syncing.
        server = _Server(payload=_payload(
            errlist=[{"code": "con.auth", "msg": "Authentication required", "conn_id": "CONN-2"}],
        ))
        with mock.patch("backend.services.providers.simplefin._http", server):
            accounts = self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertEqual(len(accounts), 1)

    def test_a_partial_problem_is_returned_as_a_warning_on_a_successful_sync(self):
        # The failure mode that matters most here: the pull succeeds, so without surfacing this nothing
        # would ever tell the user that one of their banks quietly stopped delivering.
        server = _Server(payload=_payload(
            [_txn("t1", "2026-08-01", "-5.00", "SHOP")],
            errlist=[{"code": "con.auth", "msg": "Authentication required", "conn_id": "CONN-2"}],
        ))
        with mock.patch("backend.services.providers.simplefin._http", server), \
                mock.patch("backend.services.providers.simplefin.date", _FrozenDate("2026-08-07")):
            result = self.adapter.fetch_transactions_sync({}, ACCESS_URL, days_requested=WINDOW_DAYS)
        self.assertEqual(len(result["added"]), 1, "the banks that worked still deliver")
        self.assertEqual(result["warnings"], ["Authentication required"])

    def test_the_same_problem_across_many_windows_is_reported_once(self):
        # A walk touches the same failing bank in every window; the card needs the distinct problems, not
        # one copy per request.
        server = _Server(payload=_payload(
            [_txn("t1", "2026-08-01", "-5.00", "SHOP")],
            errlist=[{"code": "con.auth", "msg": "Authentication required", "conn_id": "CONN-2"}],
        ))
        result = self._drain_walk(server, "simplefin:2930002")
        self.assertGreater(len(server.requested_windows), 1, "this must actually span several windows")
        self.assertEqual(result["warnings"], ["Authentication required"])

    def test_a_request_advisory_is_returned_as_well_as_logged(self):
        # An advisory describes our own request, so it is not a warning and never reaches the connection
        # card. It used to reach only the server console, which answered "why is this happening?" for
        # whoever could read the console and nobody else. Both sinks now, not one.
        server = _Server(payload=_payload(
            [_txn("t1", "2026-08-01", "-5.00", "SHOP")],
            errlist=[{"code": "gen.api", "msg": "Requested date range exceeds recommended range of 45 days."}],
        ))
        with mock.patch("backend.services.providers.simplefin._http", server), \
                mock.patch("backend.services.providers.simplefin.date", _FrozenDate("2026-08-07")), \
                mock.patch("backend.services.providers.simplefin.log_warning") as logged:
            result = self.adapter.fetch_transactions_sync({}, ACCESS_URL, days_requested=WINDOW_DAYS)
        self.assertEqual(result["warnings"], [], "an advisory is not a bank problem")
        self.assertEqual(len(result["advisories"]), 1)
        entry = result["advisories"][0]
        self.assertEqual(entry["message"],
                         "[gen.api] Requested date range exceeds recommended range of 45 days.")
        self.assertEqual(entry["count"], 1)
        # The window that drew it — the detail the console line always carried and the log used to lose.
        # Derived from the request the server actually saw rather than restated, so this asserts the
        # context *identifies the request* instead of pinning a date the fixture happens to produce.
        start, end = server.requested_windows[0]
        self.assertEqual(entry["context"], f"fetching {start.isoformat()}..{end.isoformat()}")
        self.assertTrue(logged.called, "the console stays a sink; it just stopped being the only one")

    def test_the_same_advisory_across_many_windows_is_counted_not_repeated(self):
        # The counterpart of the warning test above, and the reason advisories carry a count where warnings
        # do not: a walk provokes the same remark on every request, and how *many* is the diagnostic —
        # it says the whole walk was affected rather than one stray window.
        server = _Server(payload=_payload(
            [_txn("t1", "2026-08-01", "-5.00", "SHOP")],
            errlist=[{"code": "gen.api", "msg": "Requested date range exceeds recommended range of 45 days."}],
        ))
        result = self._drain_walk(server, "simplefin:2930002")
        windows = len(server.requested_windows)
        self.assertGreater(windows, 1, "this must actually span several windows")
        self.assertEqual(len(result["advisories"]), 1, "one entry, however many windows drew it")
        self.assertEqual(result["advisories"][0]["count"], windows)

    def test_legacy_string_errors_are_understood(self):
        server = _Server(payload={"errors": ["Connection needs attention"], "accounts": []})
        with mock.patch("backend.services.providers.simplefin._http", server):
            with self.assertRaises(SimpleFinError) as caught:
                self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertIn("Connection needs attention", str(caught.exception))


class SimpleFinTransportTests(unittest.TestCase):
    """The one layer the rest of this file mocks away.

    Every other test here patches `_http`, so nothing exercises what actually goes on the wire — which is
    precisely where a real outage came from: urllib's default `Python-urllib/x.y` User-Agent is rejected by
    the CDN in front of the Bridge with a 403 that says only `error code: 1010`, so no request ever reached
    SimpleFIN. These tests hold the transport itself, using a fake `urlopen` rather than the network.
    """

    def _capture_request(self, response=b"ok"):
        captured = {}

        class _Response:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *exc):
                return False

            def read(self_inner):
                return response

        def _urlopen(request, timeout=None):
            captured["request"] = request
            return _Response()

        return captured, _urlopen

    def test_every_request_names_the_client(self):
        from backend.services.providers.simplefin import _http
        captured, urlopen = self._capture_request()
        with mock.patch("urllib.request.urlopen", urlopen):
            _http("https://bridge.example/simplefin/accounts")
        agent = captured["request"].get_header("User-agent")
        self.assertTrue(agent, "an unnamed request is refused by the CDN before SimpleFIN ever sees it")
        self.assertNotIn("Python-urllib", agent)

    def test_the_caller_can_still_add_its_own_headers(self):
        from backend.services.providers.simplefin import _http
        captured, urlopen = self._capture_request()
        with mock.patch("urllib.request.urlopen", urlopen):
            _http("https://bridge.example/simplefin/accounts", headers={"Authorization": "Basic abc"})
        self.assertEqual(captured["request"].get_header("Authorization"), "Basic abc")
        self.assertTrue(captured["request"].get_header("User-agent"))

    def _http_error(self, code, body):
        import urllib.error
        return urllib.error.HTTPError("https://bridge.example/simplefin/claim/X", code, "Forbidden", {},
                                      io.BytesIO(body))

    def test_a_403_reports_what_the_server_said_rather_than_guessing_why(self):
        # The regression this pins: a 403 used to assert "this setup token was already claimed", which is
        # plausible and was flatly wrong for a CDN block sending the same status. The reader then goes off
        # to fix something that was never broken, which is worse than being told nothing.
        from backend.services.providers.simplefin import _http
        with mock.patch("urllib.request.urlopen", side_effect=self._http_error(403, b"error code: 1010")):
            with self.assertRaises(SimpleFinError) as caught:
                _http("https://bridge.example/simplefin/claim/X", method="POST")
        message = str(caught.exception)
        self.assertIn("1010", message, "the server's own words are the only real evidence of the cause")
        self.assertNotIn("can only be claimed once", message)

    def test_the_transport_layer_adds_no_interpretation_of_its_own(self):
        # What a status *means* depends on which call made it, and `_http` does not know which call it is
        # serving. Both readings therefore belong to the callers (`connect` and `_get_accounts`), and this
        # pins that neither leaks back down here: a hint added at this level would attach itself to every
        # request that ever gets the same status.
        from backend.services.providers.simplefin import _http
        for url in ("https://bridge.example/simplefin/claim/X",
                    "https://bridge.example/simplefin/accounts"):
            with mock.patch("urllib.request.urlopen", side_effect=self._http_error(403, b"")):
                with self.assertRaises(SimpleFinError) as caught:
                    _http(url, method="POST")
            self.assertNotIn("intercepted", str(caught.exception))
            self.assertNotIn("revoked", str(caught.exception))

    def test_the_status_travels_with_the_error_rather_than_only_the_message(self):
        # So a caller can act on 403 without recognizing it by parsing English. The reconnect signal reads
        # this; matching on message text would break the first time the server rewords itself.
        from backend.services.providers.simplefin import _http
        with mock.patch("urllib.request.urlopen", side_effect=self._http_error(403, b"")):
            with self.assertRaises(SimpleFinError) as caught:
                _http("https://bridge.example/simplefin/accounts")
        self.assertEqual(caught.exception.status, 403)

    def test_provider_text_is_clipped_before_it_can_reach_a_card(self):
        # Nothing in the protocol bounds these strings, and they end up in a DB column and on a connection
        # card. React escapes the content, so the exposure is volume rather than injection — an unbounded
        # message would push a card off the screen and sit in `last_sync_error` until the next sync.
        from backend.services.providers.simplefin import _MAX_MESSAGE_CHARS, _http
        with mock.patch("urllib.request.urlopen", side_effect=self._http_error(500, b"x" * 5000)):
            with self.assertRaises(SimpleFinError) as caught:
                _http("https://bridge.example/simplefin/accounts")
        self.assertLessEqual(len(str(caught.exception)), _MAX_MESSAGE_CHARS)


class SimpleFinConnectTests(unittest.TestCase):
    def setUp(self):
        self.adapter = SimpleFinAdapter()

    def test_setup_token_is_decoded_to_its_claim_url(self):
        self.assertEqual(
            self.adapter._claim_url(DEMO_TOKEN),
            "https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-16B09455E681B1215836",
        )

    def test_a_token_missing_its_base64_padding_still_works(self):
        self.assertTrue(self.adapter._claim_url(DEMO_TOKEN.rstrip("=")).startswith("https://"))

    def test_junk_is_rejected_before_any_network_call(self):
        with self.assertRaises(SimpleFinError):
            self.adapter._claim_url("obviously-not-a-token")

    def test_connect_hashes_the_access_url_for_the_external_id(self):
        # external_id is stored in the clear and used as the encryption AAD, so it cannot be the access URL
        # itself — that is the credential.
        with mock.patch("backend.services.providers.simplefin._http", return_value=ACCESS_URL.encode()):
            result = self.adapter.connect({}, {"setup_token": DEMO_TOKEN})
        self.assertEqual(result["credential"], ACCESS_URL)
        self.assertTrue(result["external_id"].startswith("sfin_"))
        self.assertNotIn("pass-xyz", result["external_id"])
        self.assertEqual(result["institution"], "SimpleFIN Bridge")

    def test_connect_is_stable_for_the_same_access_url(self):
        with mock.patch("backend.services.providers.simplefin._http", return_value=ACCESS_URL.encode()):
            first = self.adapter.connect({}, {"setup_token": DEMO_TOKEN})
            second = self.adapter.connect({}, {"setup_token": DEMO_TOKEN})
        self.assertEqual(first["external_id"], second["external_id"])

    def test_remove_is_a_silent_no_op(self):
        # There is no revocation call. It must not raise: the local disconnect really did succeed, and the
        # part that did not happen is carried in the UI's confirm copy.
        self.assertIsNone(self.adapter.remove({}, ACCESS_URL))

    def test_a_failed_claim_says_the_token_may_have_been_intercepted(self):
        # The protocol's own conformance checklist requires this, and it is the reading the app must NOT
        # leave out: a setup token is single-use, so a claim that fails may mean someone else spent it —
        # in which case they now hold live, unrevokable read access, and only the user can disable it at
        # the Bridge. "Generate a new one" is the reassuring interpretation of exactly the same evidence.
        import urllib.error
        error = urllib.error.HTTPError("https://bridge.example/claim/X", 403, "Forbidden", {}, io.BytesIO(b""))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaises(SimpleFinError) as caught:
                self.adapter.connect({}, {"setup_token": DEMO_TOKEN})
        self.assertIn("intercepted", str(caught.exception))
        self.assertIn("SimpleFIN Bridge", str(caught.exception))

    def test_every_claim_failure_carries_it_not_only_a_403(self):
        # Scoping the warning to one status would be guessing at which failures are suspicious. A CDN block
        # answers 403 too, and a server that refuses a spent token with some other status would slip past —
        # so the cost of being told to check a token that was fine is a moment, and the cost of the reverse
        # mistake is the account.
        import urllib.error
        for error in (
            urllib.error.HTTPError("https://bridge.example/claim/X", 500, "Server Error", {}, io.BytesIO(b"")),
            urllib.error.URLError("connection reset"),
        ):
            with mock.patch("urllib.request.urlopen", side_effect=error):
                with self.assertRaises(SimpleFinError) as caught:
                    self.adapter.connect({}, {"setup_token": DEMO_TOKEN})
            self.assertIn("intercepted", str(caught.exception))


class _FrozenDate:
    """Pins `date.today()` inside the adapter while leaving the rest of `date` intact."""

    def __init__(self, iso):
        self._today = date.fromisoformat(iso)

    def today(self):
        return self._today

    def __getattr__(self, name):
        return getattr(date, name)


class SimpleFinWalkTests(unittest.TestCase):
    """The backward history walk, which is now driven entirely by per-account targets.

    One loop serves a first backfill, a deepening pull, and an account that joined the connection late,
    because they differ only in which accounts still want older data and how far back. The adapter holds no
    history state of its own — the caller owns the database, so it decides — and the walk reports what it
    reached **per account**.
    """

    TODAY = "2026-08-07"

    def setUp(self):
        self.adapter = SimpleFinAdapter()
        # One spend record across every `_sync` in a test, which is what the sync layer keeps per
        # connection. Held here rather than threaded through each call so a two-call test exercises the
        # thing that actually carries between syncs.
        self.budget = {}

    def _targets(self, *accounts, from_date="2016-01-01", reached=None, empty_streak=0):
        return [{"external_account_id": a, "from_date": from_date,
                 "reached": reached, "empty_streak": empty_streak} for a in accounts]

    def _moment(self, today=None, hour=12) -> float:
        return datetime.combine(date.fromisoformat(today or self.TODAY),
                                dtime(hour), tzinfo=timezone.utc).timestamp()

    def _drained(self, *pools, today=None, hour=12) -> dict:
        """A spend record with the named allowances already empty — the state a walk that ran out leaves
        behind. `"shared"` is the unfiltered pool; anything else names a provider account."""
        return {"pools": {p: {"tokens": 0.0, "as_of": self._moment(today, hour)} for p in pools}}

    def _sync(self, server, targets, cursor=None, today=None, hour=12, budget=None, continuing=False):
        # Both clocks move together. The budget is metered against instants and the windows are chosen by
        # date, so a test that advanced one without the other would be asserting against a moment nothing
        # was requested at.
        with mock.patch("backend.services.providers.simplefin._http", server), \
                mock.patch("backend.services.providers.simplefin._utc_today",
                           lambda: date.fromisoformat(today or self.TODAY)), \
                mock.patch("backend.services.providers.simplefin._utcnow_epoch",
                           lambda: self._moment(today, hour)):
            return self.adapter.fetch_transactions_sync(
                {}, ACCESS_URL, cursor=cursor, account_targets=targets, continuing=continuing,
                request_budget=self.budget if budget is None else budget)

    def _drain(self, server, targets, cursor=None, today=None, hour=12, budget=None):
        """One pull, all its pages — see `drain_pull`. The cursor advances across pages exactly as the
        sync layer advances it, since a walk's `through` watermark rides in it."""
        state = {"cursor": cursor, "pages": 0}

        def fetch_page(page_targets):
            page = self._sync(server, page_targets, cursor=state["cursor"], today=today, hour=hour,
                              budget=budget, continuing=state["pages"] > 0)
            state["cursor"] = page["next_cursor"]
            state["pages"] += 1
            return page

        return drain_pull(fetch_page, targets)

    def _busy(self, account="simplefin:2930002", count=80):
        """Windows that always return data, so only the budget can end a walk."""
        today = date.fromisoformat(self.TODAY)
        return _Server(windows={
            ((today - timedelta(days=WINDOW_DAYS * (n + 1))).isoformat(),
             (today - timedelta(days=WINDOW_DAYS * n)).isoformat()):
                [_txn(f"t{n}", "2026-01-01", "-1.00", "X")]
            for n in range(count)
        })

    # ---- window shape ---------------------------------------------------

    def test_history_windows_are_contiguous_and_the_declared_width(self):
        # The 5-day overlap belongs to the incremental fetch, not here: overlapping the historical walk
        # would spend extra requests out of a metered budget to re-fetch what the previous window held.
        server = _Server(windows={})
        self._drain(server, self._targets("simplefin:2930002"))
        windows = server.requested_windows
        self.assertEqual((windows[0][1] - windows[0][0]).days, WINDOW_DAYS)
        self.assertEqual(windows[1][1], windows[0][0], "windows must abut, not overlap")

    def test_interior_history_windows_are_exactly_their_declared_width_on_the_wire(self):
        # The bounds are instants, so a window whose end runs to 23:59:59 is a day wider on the wire than
        # its dates say. Every window except the one holding the newest bound must end at midnight instead:
        # the window immediately newer starts at that same instant, so the boundary day is already covered,
        # and closing long re-fetched it in full — which also pushed a WINDOW_DAYS walk past a same-sized
        # server range limit, measured in seconds, by one second short of a day.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:2930002", reached="2026-06-01"))
        # Window 0 is the recent top-up; the walk proper starts at 1 and every one of its windows is older
        # than the top-up, so none of them carries the newest bound.
        walk_spans = server.requested_spans[1:]
        self.assertTrue(walk_spans, "this must actually walk")
        for span in walk_spans:
            self.assertEqual(span, WINDOW_DAYS * 86400)

    def test_the_window_holding_the_newest_bound_still_runs_to_the_close_of_today(self):
        # The counterpart, and the reason this is per-window rather than a blanket switch: nothing covers
        # the rest of today, so a midnight end there would leave anything posted since midnight outside
        # every window ever asked for while coverage — recorded per date — went on claiming the day.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:2930002", reached=None))
        # A first connect starts its walk at today, so request 0 is the one carrying the newest bound.
        self.assertEqual(server.requested_windows[0][1].isoformat(), self.TODAY)
        self.assertEqual(server.requested_spans[0], WINDOW_DAYS * 86400 + 86399)

    def test_a_resuming_top_up_also_runs_to_the_close_of_today(self):
        # The top-up is always the newest bound there is. Losing today's late postings here would be worse
        # than in the walk: `through` advances past today afterwards, so nothing would ever come back.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:2930002", reached="2026-06-01"),
                   cursor=json.dumps({"through": "2026-08-01"}))
        start, end = server.requested_windows[0]
        self.assertEqual(end.isoformat(), self.TODAY)
        # Derived from the window actually asked for rather than restated: its width is the gap since the
        # last top-up *plus* the overlap, so pinning a number here would only re-assert the overlap test
        # above. What this test is for is the trailing 86399 — the close-of-day bound.
        self.assertGreaterEqual((end - start).days, INCREMENTAL_OVERLAP_DAYS)
        self.assertEqual(server.requested_spans[0], (end - start).days * 86400 + 86399)

    def test_a_walk_resumes_from_where_the_account_already_reached(self):
        # No separate parking state: an account's own recorded reach is where it starts again. Window 0 is
        # the recent top-up (below), so the walk proper begins at window 1.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:2930002", reached="2026-06-01"))
        self.assertEqual(server.requested_windows[1][1].isoformat(), "2026-06-01")

    # ---- keeping current while history fills in behind ------------------

    def test_a_resuming_walk_spends_its_first_request_on_the_recent_window(self):
        # Every window a resuming walk fetches is old, so without this no *new* transaction would arrive
        # for however many days the walk takes to finish — and the recent ledger is the part a user looks
        # at. History fills in behind it.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:2930002", reached="2026-06-01"),
                   cursor=json.dumps({"through": "2026-08-01"}))
        first_start, first_end = server.requested_windows[0]
        self.assertEqual(first_end.isoformat(), self.TODAY)
        self.assertEqual(first_start.isoformat(), "2026-07-27", "the 5-day overlap applies here too")

    def test_a_first_connect_does_not_pay_for_a_separate_recent_window(self):
        # The walk still starts at today, so its own first window already covers the recent period; a
        # top-up would re-fetch a subset of it and spend a request from a metered budget for nothing.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:2930002", reached=None))
        self.assertEqual(server.requested_windows[0][1].isoformat(), self.TODAY)
        self.assertEqual((server.requested_windows[0][1] - server.requested_windows[0][0]).days,
                         WINDOW_DAYS, "that first window is the walk's, not a short top-up")

    def test_the_recent_watermark_only_advances_on_data_actually_fetched(self):
        # `through` is where the next top-up starts, so advancing it for a pull that fetched only old
        # windows would silently skip everything between the real last top-up and the new watermark.
        server = self._busy()
        result = self._sync(server, self._targets("simplefin:2930002", reached="2026-06-01"),
                            cursor=json.dumps({"through": "2026-08-01"}),
                            budget=self._drained("shared", "simplefin:2930002"))
        self.assertTrue(result["resume_later"])
        self.assertEqual(json.loads(result["next_cursor"])["through"], "2026-08-01",
                         "no budget for the top-up means the watermark must not move")

    # ---- the stop rules -------------------------------------------------

    def test_two_consecutive_empty_windows_end_an_accounts_history(self):
        today = date.fromisoformat(self.TODAY)
        recent = (today - timedelta(days=WINDOW_DAYS), today)
        server = _Server(windows={
            (recent[0].isoformat(), recent[1].isoformat()): [_txn("t1", "2026-07-20", "-5.00", "A")],
        })
        result = self._drain(server, self._targets("simplefin:2930002"))
        self.assertEqual(len(server.requested_windows), 1 + EMPTY_WINDOWS_END_HISTORY)
        self.assertTrue(result["account_coverage"]["simplefin:2930002"]["complete"])
        self.assertTrue(result["backfill_complete"])

    def test_a_single_quiet_window_does_not_end_it(self):
        # A card unused for a period reports exactly what an exhausted history reports. Stopping at one
        # empty window would silently truncate the backfill at that gap.
        today = date.fromisoformat(self.TODAY)
        w1 = (today - timedelta(days=WINDOW_DAYS), today)
        w3 = (today - timedelta(days=WINDOW_DAYS * 3), today - timedelta(days=WINDOW_DAYS * 2))
        server = _Server(windows={
            (w1[0].isoformat(), w1[1].isoformat()): [_txn("t1", "2026-07-20", "-5.00", "A")],
            (w3[0].isoformat(), w3[1].isoformat()): [_txn("t2", "2026-04-20", "-9.00", "B")],
        })
        result = self._drain(server, self._targets("simplefin:2930002"))
        self.assertIn(_ext_id("t2"), {r["external_transaction_id"] for r in result["added"]})

    def test_reaching_the_requested_depth_is_not_the_same_as_being_complete(self):
        # Only an account whose own windows came back empty has ENDED. One that merely hit the depth asked
        # for has more behind it, and marking it complete would stop a later, deeper request from looking.
        server = _Server(windows={})
        target_start = (date.fromisoformat(self.TODAY) - timedelta(days=WINDOW_DAYS)).isoformat()
        result = self._sync(server, self._targets("simplefin:2930002", from_date=target_start))
        coverage = result["account_coverage"]["simplefin:2930002"]
        self.assertEqual(coverage["reached"], target_start)
        self.assertFalse(coverage["complete"])
        self.assertTrue(result["backfill_complete"], "it reached what was asked, so this pull is done")

    # ---- the filter rule ------------------------------------------------

    def test_a_wide_walk_shares_one_unfiltered_window(self):
        # A request is bounded by a date range, not an account, so one unfiltered window advances every
        # account that wants that period, for one token. Fetching a wide set per account would multiply
        # round trips by the number of accounts to reach exactly the same depth.
        server = _Server(windows={})
        self._sync(server, self._targets(*[f"simplefin:{n}" for n in range(FILTERED_WALK_MAX_ACCOUNTS + 1)]))
        for url in server.calls:
            self.assertNotIn("account=", url)

    def test_a_narrow_walk_is_fetched_one_account_at_a_time(self):
        # Each account has its own allowance at the Bridge, so a few accounts catching up can do it without
        # touching the shared pool the top-up and account discovery spend from.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:a"))
        for url in server.calls:
            self.assertIn("account=a", url)
            self.assertNotIn("simplefin%3A", url, "the namespace prefix is ours, not the provider's")

    def test_a_filtered_request_never_names_more_than_one_account(self):
        # The separate per-account allowance was described in the singular. Nothing says which pool a
        # request naming two accounts is charged to, so the shape whose cost is known is the only one sent —
        # otherwise the budget here would be metering something the server accounts for differently.
        server = _Server(windows={})
        self._sync(server, self._targets("simplefin:a", "simplefin:b"))
        for url in server.calls:
            self.assertLessEqual(url.count("account="), 1, f"{url} names several accounts at once")

    def test_the_walk_narrows_to_filtering_once_enough_accounts_have_finished(self):
        # A wide walk shares windows; as accounts drop out it becomes a narrow one, and the remaining
        # stragglers move to their own allowances rather than going on spending the shared pool.
        today = date.fromisoformat(self.TODAY)
        deep = {
            ((today - timedelta(days=WINDOW_DAYS * (n + 1))).isoformat(),
             (today - timedelta(days=WINDOW_DAYS * n)).isoformat()):
                [{**_txn(f"t{n}", "2026-01-01", "-1.00", "X"), "id": f"t{n}"}]
            for n in range(6)
        }
        server = _Server(windows=deep)
        # `2930002` delivers in every window; the rest never do, so they complete after two empties and the
        # walking set falls to one.
        quiet = [f"simplefin:quiet{n}" for n in range(FILTERED_WALK_MAX_ACCOUNTS)]
        self._drain(server, self._targets("simplefin:2930002", *quiet))
        self.assertNotIn("account=", server.calls[0])
        self.assertTrue(any("account=" in u for u in server.calls[2:]),
                        "once few enough accounts are still walking, the windows narrow to them")

    # ---- the request budget ---------------------------------------------

    def test_the_budget_pauses_the_walk_instead_of_exceeding_it(self):
        # Exceeding SimpleFIN's published budget gets the token disabled, so the walk stops itself.
        server = self._busy()
        result = self._drain(server, self._targets("simplefin:2930002"))
        self.assertEqual(len(server.requested_windows), REQUEST_BUDGET_CAPACITY)
        self.assertTrue(result["resume_later"])
        self.assertFalse(result["backfill_complete"])
        self.assertFalse(result["has_more"], "the client must stop polling a provider that just cut it off")

    def test_a_paused_walk_claims_only_what_it_actually_reached(self):
        # The regression that motivated the per-account model: coverage that overstates itself makes
        # duplicate detection hard-reject genuine transactions in a range nothing ever fetched.
        server = self._busy()
        result = self._sync(server, self._targets("simplefin:2930002", from_date="2016-01-01"))
        reached = result["account_coverage"]["simplefin:2930002"]["reached"]
        self.assertGreater(reached, "2016-01-01", "it must not claim the depth it was aiming for")
        self.assertEqual(reached, min(w[0] for w in server.requested_windows).isoformat())

    def test_a_paused_walk_resumes_the_next_day_from_its_recorded_reach(self):
        server = self._busy()
        first = self._drain(server, self._targets("simplefin:2930002"))
        reached = first["account_coverage"]["simplefin:2930002"]["reached"]

        self._drain(server, self._targets("simplefin:2930002", reached=reached),
                   cursor=first["next_cursor"], today="2026-08-08")
        # The next day opens with the recent top-up, then the walk continues from where it stopped.
        resumed = server.requested_windows[REQUEST_BUDGET_CAPACITY + 1]
        self.assertEqual(resumed[1].isoformat(), reached)

    def test_an_exhausted_allowance_is_not_spent_again_before_it_refills(self):
        server = self._busy()
        first = self._drain(server, self._targets("simplefin:2930002"))
        reached = first["account_coverage"]["simplefin:2930002"]["reached"]
        spent = len(server.requested_windows)
        second = self._drain(server, self._targets("simplefin:2930002", reached=reached),
                            cursor=first["next_cursor"])
        # One further request, and exactly one: the walk's own allowance is empty, but the recent top-up is
        # an unfiltered call and the shared allowance it draws on has not been touched. That the ledger
        # stays current while history is paused is the point of the pools being separate.
        self.assertEqual(len(server.requested_windows), spent + 1,
                         "the paused walk must not fetch, and the top-up must not be blocked by it")
        self.assertTrue(second["resume_later"])

    def test_an_allowance_refills_with_the_hours_that_passed(self):
        # The distinction a per-day counter cannot draw. Coming back part-way through must return part of
        # the allowance — a counter keyed to the calendar returns all of it the moment the date rolls, which
        # is how a walk resuming shortly after midnight overruns a limit that has barely refilled.
        server = self._busy()
        first = self._drain(server, self._targets("simplefin:2930002"))
        spent = len(server.requested_windows)
        # Resumed from the reach the first pull recorded, so the walk stays on `_busy`'s window grid and
        # keeps finding data — otherwise it would stop on two empty windows and measure the wrong thing.
        reached = first["account_coverage"]["simplefin:2930002"]["reached"]

        elapsed = 5
        result = self._drain(server, self._targets("simplefin:2930002", reached=reached),
                            cursor=first["next_cursor"], hour=12 + elapsed)
        walked = len(server.requested_windows) - spent - 1   # less the top-up, which is a different pool
        self.assertEqual(walked, int(elapsed * REQUEST_BUDGET_REFILL_PER_HOUR),
                         "five hours must return five requests — no more, and no fewer")
        self.assertTrue(result["resume_later"], "and the rest still waits on the allowance")

    def test_a_pre_bucket_checkpoints_spend_is_carried_into_the_allowance(self):
        # The allowance used to live in the resume token as a counter keyed to a UTC date. Ignoring that on
        # the first sync after the change would grant a full bucket on top of one already spent the same
        # day — the exact over-spend the bucket exists to prevent, arriving once, at the upgrade.
        server = self._busy()
        already_spent = REQUEST_BUDGET_CAPACITY - 3
        result = self._sync(server, self._targets("simplefin:2930002", reached="2026-08-01"),
                            cursor=json.dumps({"through": "2026-08-01", "budget_date": self.TODAY,
                                               "requests_used": already_spent}))
        # Three were left; the top-up spends one of them. The walk draws on the account's own allowance, so
        # it is not what this measures.
        self.assertEqual(self.budget["pools"]["shared"]["tokens"], 2.0,
                         "the legacy counter's spend must carry over, not be forgotten")
        carried = json.loads(result["next_cursor"])
        self.assertNotIn("requests_used", carried, "and must not be left behind to be adopted twice")
        self.assertNotIn("budget_date", carried)

    def test_the_walk_window_is_dated_from_utc_not_the_hosts_local_date(self):
        # Overrunning the provider's limits is the one error with a punitive outcome, and every bound this
        # adapter sends is a UTC instant — so a host running behind UTC that dated its windows locally would
        # ask for a window ending yesterday and then record coverage through today.
        #
        # The two clocks are pinned to *disagree*, which is the whole test: a host at UTC-7 at 20:00 on the
        # 6th is already the 7th in UTC. Asserting a date both clocks happen to share proves nothing — an
        # earlier version of this test did exactly that and passed against the bug.
        server = self._busy()
        with mock.patch("backend.services.providers.simplefin.datetime") as fake_datetime, \
                mock.patch("backend.services.providers.simplefin.date", _FrozenDate("2026-08-06")):
            fake_datetime.now.return_value = datetime(2026, 8, 7, 3, 0, tzinfo=timezone.utc)
            fake_datetime.combine = datetime.combine
            fake_datetime.min = datetime.min
            fake_datetime.max = datetime.max
            with mock.patch("backend.services.providers.simplefin._http", server):
                self.adapter.fetch_transactions_sync(
                    {}, ACCESS_URL, account_targets=self._targets("simplefin:2930002"),
                    request_budget=self.budget)
        self.assertEqual(max(w[1] for w in server.requested_windows).isoformat(), "2026-08-07",
                         "windows must be dated by the provider's day, not the host's")

    # ---- accounts joining a walk already in progress --------------------

    def test_an_account_added_mid_walk_joins_without_restarting_the_others(self):
        # The case one shared frontier could not express. Each account carries its own reach, so a
        # newcomer starts from today while the account already three windows deep continues from there —
        # neither re-fetches what it holds, and nothing is thrown away.
        server = _Server(windows={})
        targets = [
            {"external_account_id": "simplefin:old", "from_date": "2026-01-01",
             "reached": "2026-05-01", "empty_streak": 0},
            {"external_account_id": "simplefin:new", "from_date": "2026-01-01",
             "reached": None, "empty_streak": 0},
        ]
        result = self._drain(server, targets)
        # The newcomer's first window starts at today; the established account never re-fetches above
        # where it had already reached.
        self.assertEqual(max(w[1] for w in server.requested_windows).isoformat(), self.TODAY)
        self.assertLessEqual(result["account_coverage"]["simplefin:old"]["reached"], "2026-05-01")


class SimpleFinRoutineSyncTests(unittest.TestCase):
    """A pull with no targets: the recent window, which is what a routine top-up is."""

    TODAY = "2026-08-07"

    def setUp(self):
        self.adapter = SimpleFinAdapter()

    def _sync(self, server, cursor=None):
        with mock.patch("backend.services.providers.simplefin._http", server), \
                mock.patch("backend.services.providers.simplefin._utc_today",
                           lambda: date.fromisoformat(self.TODAY)):
            return self.adapter.fetch_transactions_sync({}, ACCESS_URL, cursor=cursor)

    def _state(self, through="2026-08-05"):
        return json.dumps({"through": through})

    def test_a_routine_sync_costs_one_request(self):
        server = _Server(windows={})
        self._sync(server, self._state())
        self.assertEqual(len(server.requested_windows), 1)

    def test_it_overlaps_the_last_covered_date_by_five_days(self):
        # A transaction can post with a date earlier than the moment it becomes visible, so a window
        # starting exactly where the last one ended would step over it.
        server = _Server(windows={})
        self._sync(server, self._state(through="2026-08-05"))
        start, end = server.requested_windows[0]
        self.assertEqual(start.isoformat(), "2026-07-31")
        self.assertEqual(end.isoformat(), self.TODAY)

    def test_it_claims_no_coverage(self):
        # A top-up fetches a recent window; it says nothing about how far back an account's history goes,
        # so it must not write a history claim for anyone.
        server = _Server(windows={})
        self.assertEqual(self._sync(server, self._state())["account_coverage"], {})

    def test_an_unreadable_checkpoint_restarts_rather_than_failing_the_sync(self):
        server = _Server(windows={})
        result = self._sync(server, "not json at all")
        self.assertTrue(server.requested_windows)
        self.assertIsNotNone(result["next_cursor"])


class SimpleFinCurrencyTests(unittest.TestCase):
    """Accounts denominated in something the ledger cannot hold.

    `txn.amount` is a bare number with no denomination stored beside it, so importing a €100 charge would
    make it indistinguishable from a $100 one and silently add it into every total, budget and report. The
    only safe handling is to discard — and then to *say so*, because an account that syncs cleanly and stays
    empty is the most confusing possible way to fail.
    """

    TODAY = "2026-08-07"

    def setUp(self):
        self.adapter = SimpleFinAdapter()

    def _accounts_payload(self, currency):
        return {
            "errlist": [],
            "accounts": [
                {"id": "usd-1", "name": "Checking", "currency": "USD", "balance": "10.00",
                 "transactions": [_txn("t-usd", "2026-08-05", "-5.00", "Coffee")]},
                {"id": "other-1", "name": "Travel", "currency": currency, "balance": "10.00",
                 "transactions": [_txn("t-other", "2026-08-05", "-5.00", "Museum")]},
            ],
        }

    def _sync(self, payload):
        server = _Server(payload=payload)
        with mock.patch("backend.services.providers.simplefin._http", server), \
                mock.patch("backend.services.providers.simplefin._utc_today",
                           lambda: date.fromisoformat(self.TODAY)):
            return self.adapter.fetch_transactions_sync({}, ACCESS_URL, cursor=None)

    def test_transactions_in_another_currency_never_enter_the_ledger(self):
        result = self._sync(self._accounts_payload("EUR"))
        ids = {t["external_transaction_id"] for t in result["added"]}
        self.assertEqual(ids, {_ext_id("t-usd", "usd-1")},
                         "a foreign-currency row would be stored as if it were dollars")

    def test_the_drop_is_reported_per_account_with_its_currency(self):
        # Reported as data rather than as a warning string: the adapter knows nothing of mappings, and
        # whether this is a real loss or an account already being ignored depends entirely on that.
        result = self._sync(self._accounts_payload("EUR"))
        self.assertEqual(result["unsupported_currency"], {"simplefin:other-1": "EUR"})

    def test_a_custom_currency_url_is_reported_by_name_not_by_url(self):
        # SimpleFIN allows `currency` to be a URL identifying a custom currency — reward points, a scrip.
        # It is an identifier, not a name, and would be the longest thing on the row it appears in.
        result = self._sync(self._accounts_payload("https://example.org/currencies/AirMiles"))
        self.assertEqual(result["unsupported_currency"], {"simplefin:other-1": "AirMiles"})

    def test_an_account_stating_no_currency_is_imported(self):
        # The field is optional, so absence means "not stated", not "not dollars". Rejecting an account
        # because its bank omitted a field would discard real data over a formatting gap.
        payload = self._accounts_payload("USD")
        del payload["accounts"][1]["currency"]
        result = self._sync(payload)
        self.assertEqual({t["external_transaction_id"] for t in result["added"]},
                         {_ext_id("t-usd", "usd-1"), _ext_id("t-other", "other-1")})
        self.assertEqual(result["unsupported_currency"], {})

    def test_currency_matching_is_not_case_sensitive(self):
        payload = self._accounts_payload("usd")
        result = self._sync(payload)
        self.assertEqual({t["external_transaction_id"] for t in result["added"]},
                         {_ext_id("t-usd", "usd-1"), _ext_id("t-other", "other-1")})

    def test_an_account_with_no_activity_is_not_reported(self):
        # Nothing was lost, so there is nothing to tell the user. Reporting every foreign account on every
        # sync would put a permanent notice on a card for a situation that never changes.
        payload = self._accounts_payload("EUR")
        payload["accounts"][1]["transactions"] = []
        self.assertEqual(self._sync(payload)["unsupported_currency"], {})

    def test_the_offered_account_list_carries_its_currency(self):
        # Recorded at connect time so the mapping step can warn *before* an account that can never fill is
        # given a destination.
        server = _Server(payload=self._accounts_payload("EUR"))
        with mock.patch("backend.services.providers.simplefin._http", server):
            accounts = self.adapter.fetch_accounts({}, ACCESS_URL)
        self.assertEqual({a["external_account_id"]: a["currency"] for a in accounts},
                         {"simplefin:usd-1": "USD", "simplefin:other-1": "EUR"})


class SimpleFinRevokedAccessTests(unittest.TestCase):
    """A 403 on a data call — the only notice this app ever gets that access was revoked.

    SimpleFIN has no revocation API, so revoking at the Bridge is both the only way a user *can* revoke and
    invisible here until a request is refused. Treated as its own signal rather than as another sync
    failure, because retrying cannot fix it and there is exactly one thing the user can do.
    """

    def setUp(self):
        self.adapter = SimpleFinAdapter()

    def _refuse(self, code):
        import urllib.error
        return urllib.error.HTTPError("https://bridge.example/simplefin/accounts", code, "Forbidden", {},
                                      io.BytesIO(b""))

    def test_a_403_on_a_data_call_asks_for_a_reconnect(self):
        from backend.services.providers.base import ProviderCredentialRejected
        with mock.patch("urllib.request.urlopen", side_effect=self._refuse(403)):
            with self.assertRaises(ProviderCredentialRejected):
                self.adapter.fetch_accounts({}, ACCESS_URL)

    def test_other_statuses_stay_ordinary_failures(self):
        # A 500 or a timeout is transient and self-correcting. Marking those as needing a reconnect would
        # tell the user to redo their setup over a blip — and the flag is sticky, so it would stay wrong.
        from backend.services.providers.base import ProviderCredentialRejected
        for code in (429, 500, 503):
            with mock.patch("urllib.request.urlopen", side_effect=self._refuse(code)):
                with self.assertRaises(SimpleFinError) as caught:
                    self.adapter.fetch_accounts({}, ACCESS_URL)
            self.assertNotIsInstance(caught.exception, ProviderCredentialRejected)

    def test_a_stored_address_that_is_not_https_is_refused_before_any_request(self):
        # The scheme is checked when the access URL is claimed, but it is read back out of the vault on
        # every call and the protocol's rule is about the *request*. No later validation can un-send a
        # credential that went out in the clear.
        called = []
        with mock.patch("urllib.request.urlopen", side_effect=lambda *a, **k: called.append(1)):
            with self.assertRaises(SimpleFinError):
                self.adapter.fetch_accounts({}, "http://user:pass@bridge.example/simplefin")
        self.assertEqual(called, [])


if __name__ == "__main__":
    unittest.main()
