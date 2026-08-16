"""
Rules that must hold after *every* connection sync, whatever the scenario.

These exist because the bugs in this subsystem were not wrong answers to questions the tests asked — they
were questions no test asked. Each example-based test asserted the behaviour its author had just written,
from the same mental model as the code, so a mistaken premise was encoded twice and agreed with itself.
Both of the following were green through a live over-claim:

    coverage_start_date is written             <- asserted
    coverage_start_date <= what was fetched    <- never asserted

An invariant is not derived from the implementation, so it survives the implementation being wrong. These
are checked after every step of every scenario rather than being restated per test, which is also what
makes them worth maintaining: one place to add a rule, and every scenario immediately enforces it.
"""

from __future__ import annotations


def _connection_accounts(conn, connection_id):
    return [dict(r) for r in conn.execute(
        "SELECT external_account_id, account_id, mapping_mode, coverage_start_date, "
        "coverage_through_date, history_complete, history_empty_streak, provider_currency "
        "FROM connection_account WHERE connection_id = ?",
        (connection_id,),
    )]


def assert_invariants(test, conn, sim, connection_id, *, window_days, budget_capacity,
                      budget_refill_per_hour, ledger_currency):
    """Every rule, checked together. `test` is the TestCase, so failures name themselves.

    `ledger_currency` is passed in rather than imported from the code under test. The rules here are
    deliberately independent of the implementation — that independence is what let them survive the
    implementation being wrong — so resolving the setting the way the app does would make this rule follow
    whatever the app decided, including a mistake. Passing it makes the one coupling explicit and puts it
    at the call site, where a ledger that ever becomes configurable changes it once.
    """
    accounts = _connection_accounts(conn, connection_id)

    # --- 1. Never claim what was never fetched -------------------------------------------------
    # The over-claim bug. A coverage start earlier than anything requested asserts data over a range
    # nothing looked at, and duplicate detection then hard-rejects genuine transactions that fall in it.
    for row in accounts:
        claimed = row["coverage_start_date"]
        if not claimed:
            continue
        floor = sim.earliest_requested(row["external_account_id"])
        test.assertIsNotNone(
            floor,
            f"{row['external_account_id']} claims coverage from {claimed} but was never fetched for",
        )
        test.assertGreaterEqual(
            claimed, floor,
            f"{row['external_account_id']} claims coverage from {claimed}, "
            f"but the earliest window ever requested for it started {floor}",
        )

    # --- 2. Never claim a trailing edge past what was fetched ----------------------------------
    for row in accounts:
        through = row["coverage_through_date"]
        if not through:
            continue
        ceiling = sim.latest_requested(row["external_account_id"])
        test.assertIsNotNone(through and ceiling)
        test.assertLessEqual(
            through, ceiling,
            f"{row['external_account_id']} claims coverage through {through}, "
            f"but the newest window requested for it ended {ceiling}",
        )

    # --- 3. An account with no destination is never given a coverage claim ---------------------
    # Coverage is an assertion about the ledger. An unmapped or skipped account has nothing in it.
    for row in accounts:
        if row["mapping_mode"] in (None, "skip"):
            test.assertIsNone(
                row["coverage_start_date"],
                f"{row['external_account_id']} is {row['mapping_mode']!r} yet carries coverage",
            )

    # --- 4. Stay inside the provider's published limits ----------------------------------------
    # Exceeding these is the one failure with a punitive outcome: the provider disables the token.
    for start, end in sim.windows:
        span = (__import__("datetime").date.fromisoformat(end)
                - __import__("datetime").date.fromisoformat(start)).days
        test.assertLessEqual(span, window_days, f"window {start}..{end} exceeds the {window_days}-day cap")

    # Metered per *allowance*, not per request, because the provider grants several: an unfiltered
    # /accounts call and each ?account= call draw on their own. Summing them into one count would fail a
    # walk that is well inside every real limit, and — the direction that matters — a single count tuned to
    # pass that walk would stop noticing one pool being drained on its own.
    #
    # The rule checked is the provider's own — an allowance that holds `capacity` and refills as time passes
    # — rather than "N per calendar day", which the provider does not publish and which cannot express the
    # overrun that matters here: a full allowance spent late in one day and a second full one spent minutes
    # later, on the far side of a boundary the real allowance knows nothing about. Anchoring at every
    # request in turn is what makes a boundary impossible to straddle, and starting each anchor from a *full*
    # bucket is the most permissive assumption available, so a failure here is never the invariant being
    # stricter than the server.
    for pool, moments in sim.requests_by_pool(test).items():
        for i, anchor in enumerate(moments):
            for count, moment in enumerate(moments[i:], start=1):
                allowed = budget_capacity + (moment - anchor) / 3600 * budget_refill_per_hour
                test.assertLessEqual(
                    count, allowed,
                    f"the {pool!r} allowance saw {count} requests in the "
                    f"{(moment - anchor) / 3600:.1f}h from the one at {anchor}, which a bucket holding "
                    f"{budget_capacity} and refilling {budget_refill_per_hour}/h could not have served",
                )

    # --- 5. Claimed coverage is honoured: the rows are actually there --------------------------
    # The end-to-end consistency check, and the one that generalizes furthest — it fails for any reason a
    # transaction inside a claimed range failed to reach the ledger, including reasons not yet imagined.
    for row in accounts:
        if not (row["coverage_start_date"] and row["coverage_through_date"] and row["account_id"]):
            continue
        expected = sim.expected_ids(
            row["external_account_id"], row["coverage_start_date"], row["coverage_through_date"],
        )
        if not expected:
            continue
        held = {r["external_transaction_id"] for r in conn.execute(
            "SELECT external_transaction_id FROM txn WHERE account_id = ? AND trashed_at IS NULL",
            (row["account_id"],),
        )}
        missing = expected - held
        test.assertFalse(
            missing,
            f"{row['external_account_id']} claims {row['coverage_start_date']}.."
            f"{row['coverage_through_date']} but {len(missing)} transaction(s) in that range are absent "
            f"(e.g. {sorted(missing)[:3]})",
        )

    # --- 6. `history_complete` is only ever concluded, never assumed ---------------------------
    # It is the one flag that can stop a later, deeper request from looking again, so it may only be set
    # for an account whose own windows came back empty — not for one that merely hit the depth asked for.
    for row in accounts:
        if row["history_complete"]:
            test.assertIsNotNone(
                row["coverage_start_date"],
                f"{row['external_account_id']} is marked complete without ever having been fetched",
            )

    # --- 7. An account the ledger cannot hold is claimed for nothing and holds nothing -----------
    # Its transactions are discarded (the ledger stores a bare amount with no currency beside it), so any
    # coverage recorded for it asserts data over a range whose rows were thrown away — the over-claim bug
    # arriving by a different route. Rule 5 catches it once such an account has activity; this catches it
    # even when it does not, and states the second half: nothing of its ever reaches the ledger.
    for row in accounts:
        currency = (row["provider_currency"] or "").strip()
        if not currency or currency.upper() == ledger_currency.upper():
            continue
        test.assertIsNone(
            row["coverage_start_date"],
            f"{row['external_account_id']} is held in {currency}, whose rows are discarded, yet it "
            f"claims coverage from {row['coverage_start_date']}",
        )
        if row["account_id"]:
            held = conn.execute(
                "SELECT COUNT(*) AS n FROM txn WHERE account_id = ? AND trashed_at IS NULL",
                (row["account_id"],),
            ).fetchone()["n"]
            test.assertEqual(held, 0, f"{currency} transactions reached the ledger as bare amounts")

    # --- 8. No duplicate rows from re-fetched windows ------------------------------------------
    # Overlapping and re-walked windows are deliberate and must stay free: the insert is idempotent on the
    # provider transaction id, and if that ever stops holding, every re-fetch silently doubles the ledger.
    dupes = [dict(r) for r in conn.execute(
        "SELECT external_transaction_id, COUNT(*) AS n FROM txn "
        "WHERE external_transaction_id IS NOT NULL AND trashed_at IS NULL "
        "GROUP BY external_transaction_id HAVING n > 1"
    )]
    test.assertFalse(dupes, f"the same provider transaction landed more than once: {dupes[:3]}")
