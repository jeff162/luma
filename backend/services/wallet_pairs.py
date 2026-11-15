# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Pair a wallet account's rows with the bank and card rows on the other side of the same movement.

A wallet — a PayPal account, a person-to-person app (`services/wallet_accounts.py`) — holds the real
transaction: the purchase, the payment received. Money can sit in its balance, and then the wallet row is
the only record there is. What the wallet took from a card or bank, or sent back to one, also lands on
that card or bank account, where it is only money moving into or out of the wallet. Counted there as
well, the purchase is counted twice, and money received on the wallet and cashed out is received twice.
This pass finds those rows and moves them into the excluded "Money movement" category, linked to the
wallet row they belong to.

**What a pair changes depends on which way the money went.** A *transfer* pair — money into the wallet
from a card or bank, or out of it to one — is money moving on both sides, so both rows end up in
"Money movement"; a user who had categorized both halves alike so they cancelled gets the same net, now
without a phantom expense and income. A *payment* pair — a payment the card or bank paid directly — must
count exactly once, and the wallet row is the record of what was bought, so the bank or card row is
excluded; but where the user has already filed the wallet row as money movement and counts the bank side
instead, that choice already counts it once, and nothing is changed. Excluding the bank row is safe only
because the wallet row it belongs to is in the ledger: a blanket "PAYPAL → excluded" rule would be wrong,
since for anyone not tracking the wallet the bank row *is* the only record. This is the same conditional
exclusion the Amazon importer applies to its card charges.

**A row already filed as money movement is left where it is, and only that.** Money movement is what
`excluded_categories.money_movement_sql` says: excluded from totals, other than under Reimbursable. A
Reimbursable leaf holds a receivable whose balance is meant to be read, so a cash-out left there counts the
repayment a second time and the receivable reads as over-repaid. Such a row is moved like any counted one. What a row
must not lose is a **reimbursement claim** (`docs/data-model.md` → *Reimbursement records*): a claimed
row is never changed, so a claimed bank or card row is not offered at all, and a claimed wallet row pairs
and keeps its category, as a split row does.

**Which wallet rows have a counterpart, and which way it points.** Signed as the ledger signs (positive is
money out of the account):

  * money **into** the wallet from outside — a funding leg (the `wallet_funding` suppression's `leg`), or
    a row whose captured `Type` is a deposit — is the mirror of a bank or card charge: opposite sign;
  * money **out of** the wallet to a bank or card — a `Type` naming a withdrawal — is the mirror of a
    deposit there: opposite sign;
  * a **payment** out of the wallet with no funding leg of its own may have been paid from a card or bank
    directly — the same amount charged there: same sign. It may equally have been paid from the balance,
    so its counterpart is optional. A row with no captured `Type` at all (a synced account) could be a
    payment or a cash-out, so it is offered both.

The first two carry an explicit statement that money crossed to another account, so one with no
counterpart is surfaced for review; a payment with none is not, since a balance-funded payment has none
to find.

**What makes a candidate.** A row on an account that is not a wallet, whose name, raw text or captured
detail contains the wallet's match text, of the matching amount to the cent, within `PAIR_WINDOW_DAYS`
either side, on an account whose owner is compatible with the wallet's (the same owner, the shared owner,
or none recorded) — a household's two PayPal accounts are funded from different accounts, and a
coincidence of amount between them must not pair. Pending rows wait until they post, a split row is
already divided by hand, and a row an Amazon order, a wallet leg or a reimbursement already claims is not
offered.

**Only an unambiguous pairing applies itself.** A wallet row with exactly one candidate that no other
wallet row also wants is paired. So is a cluster of interchangeable rows — the same amount on both sides,
every wallet row wanting every candidate, as many of each — where any assignment has the same effect. A
row with a single candidate also **claims** it, taking it out of the lists of rows that have alternatives
— which often leaves one of those unambiguous in turn, so the rounds repeat until nothing more is
claimed. Anything else is left for the user to choose.

**What the user decides is kept, as links of their own kinds.** Unpairing records the pair as declined,
so the pass never offers it again; "none of these" declines each candidate shown; and acknowledging a row
with nothing to pair records it as reviewed. A decision that changes what is there to pair runs the pass
again (`pair_after_decision`), since settling one row can leave another with a single candidate. Storing
these as `txn_link` kinds rather than tables means they ride in backups, cascade with their rows, and
invalidate the reconciliation attention cache through the triggers that already watch `txn_link`.

**Reversal restores only what is still the pairing's.** Unpairing — or undoing the import that brought
either row in — puts a row's category back only while it still holds the category the pairing set with the
pairing's own source; a category the user has chosen since is theirs and is left alone.
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import date
from typing import Iterable, Optional

from backend.app_logging import log_error
from backend.db.database import get_shared_owner_id
from backend.services import txn_links
from backend.services.categorizer import category_lock_for
from backend.services.duplicate_detection import clear_flag_between
from backend.services.excluded_categories import ensure_excluded_transfers_leaf, money_movement_sql
from backend.services.money_movement import (
    MONEY_MOVEMENT_CATEGORY,
    captured_type,
    is_money_movement_type,
    is_wallet_funding_type,
    is_wallet_withdrawal_type,
    money_movement_category_id_if_exists,
)
from backend.services.money_movement import LINK_KIND as WALLET_FUNDING_KIND
from backend.services.reconciliation_attention import ledger_attention, ledger_cached
from backend.services.reimbursements import REIMBURSEMENT_LINK_KIND, claimed_txn_ids
from backend.services.review_flagging import REVIEW_PRIOR_KEY, restore_review_flag
from backend.services.txn_summaries import txn_summaries
from backend.services.wallet_accounts import match_text_sql, wallet_account_clause

LINK_KIND = "wallet_pair"
DECLINED_KIND = "wallet_pair_declined"
REVIEWED_KIND = "wallet_pair_reviewed"
WALLET_ROLE = "wallet"
COUNTERPART_ROLE = "counterpart"
REVIEWED_ROLE = "row"

# How far apart the wallet row and its bank or card row may be dated, either way. A card can date the
# charge before PayPal dates the payment, and a bank transfer posts after it; see the measurement cited on
# docs/data-model.md → Wallet funding pairs.
PAIR_WINDOW_DAYS = 4

# How far from a wallet row the manual picker looks, whatever the amount — wide enough for a transfer
# that sat pending over a weekend, or a sum the user knows is right when the amounts differ.
PICKER_WINDOW_DAYS = 14

# A bank or card row claimed by one of these is already accounted for by that feature.
_CLAIMING_KINDS = ("amazon_order", WALLET_FUNDING_KIND)

# The text of a row that a wallet's match text is looked for in.
_HAYSTACK_SQL = ("LOWER(COALESCE(t.raw_name, '') || ' ' || COALESCE(t.merchant_name, '') || ' ' "
                 "|| COALESCE(t.display_name, '') || ' ' || COALESCE(t.import_evidence_json, ''))")


def _cents(amount) -> int:
    return int(round(float(amount or 0.0) * 100))


def _day(value) -> Optional[date]:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _like_pattern(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def has_wallet_account(conn: sqlite3.Connection) -> bool:
    return conn.execute(
        f"""SELECT 1 FROM account a LEFT JOIN account pa ON pa.id = a.parent_account_id
            WHERE a.trashed_at IS NULL AND {wallet_account_clause('a', 'pa')} LIMIT 1"""
    ).fetchone() is not None


def _owners_compatible(shared_owner_id: Optional[str], a: Optional[str], b: Optional[str]) -> bool:
    if a is None or b is None or a == b:
        return True
    return shared_owner_id is not None and shared_owner_id in (a, b)


class _Ledger:
    """Everything the pairing reads, loaded once: the wallet rows, the rows elsewhere that read as one of
    the wallets, and the links that record pairings and decisions. Matching then runs in memory — the
    candidate sets are small, and one pass over the ledger is cheaper than a query per wallet row."""

    def __init__(self, conn: sqlite3.Connection):
        self.shared_owner_id = get_shared_owner_id(conn)
        movement_sql = money_movement_sql(conn, "cc", "pc")
        self.wallet_rows = [dict(r) for r in conn.execute(f"""
            SELECT t.id, t.account_id, t.date, t.amount, t.is_pending, t.is_split, t.import_batch_id,
                   t.import_evidence_json, t.category_id, t.category_source, t.category_overridden,
                   t.needs_review,
                   {movement_sql} AS movement,
                   LOWER(TRIM(COALESCE({match_text_sql('a', 'pa')}, ''))) AS match_text,
                   COALESCE(a.parent_account_id, a.id) AS root_id,
                   COALESCE(a.owner_id, pa.owner_id)   AS owner_id
            FROM   txn t
            JOIN   account a ON a.id = t.account_id
            LEFT   JOIN account pa ON pa.id = a.parent_account_id
            LEFT   JOIN category cc ON cc.id = t.category_id
            LEFT   JOIN category pc ON pc.id = cc.parent_id
            WHERE  t.trashed_at IS NULL AND {wallet_account_clause('a', 'pa')}
        """).fetchall()]
        texts = sorted({r["match_text"] for r in self.wallet_rows if r["match_text"]})
        self.other_rows = []
        if texts:
            reads_as = " OR ".join(f"{_HAYSTACK_SQL} LIKE :t{i} ESCAPE '\\'" for i in range(len(texts)))
            self.other_rows = [dict(r) for r in conn.execute(f"""
                SELECT t.id, t.account_id, t.date, t.amount, t.is_pending, t.is_split,
                       t.category_id, t.category_source, t.category_overridden, t.needs_review,
                       {movement_sql} AS movement,
                       {_HAYSTACK_SQL} AS haystack,
                       COALESCE(a.parent_account_id, a.id) AS root_id,
                       COALESCE(a.owner_id, pa.owner_id)   AS owner_id
                FROM   txn t
                JOIN   account a ON a.id = t.account_id
                LEFT   JOIN account pa ON pa.id = a.parent_account_id
                LEFT   JOIN category cc ON cc.id = t.category_id
                LEFT   JOIN category pc ON pc.id = cc.parent_id
                WHERE  t.trashed_at IS NULL
                  AND  NOT {wallet_account_clause('a', 'pa')}
                  AND  ({reads_as})
            """, {**{f"t{i}": _like_pattern(t) for i, t in enumerate(texts)}}).fetchall()]
        for row in self.other_rows:
            # Which wallets' text the row contains; a candidate must read as its own wallet.
            haystack = row.pop("haystack")
            row["reads_as"] = {t for t in texts if t in haystack}
        self.wallet_by_id = {r["id"]: r for r in self.wallet_rows}
        self.other_by_id = {r["id"]: r for r in self.other_rows}
        # Asked only about rows some reimbursement holds as a member, which are few, rather than the ledger.
        held = {r["txn_id"] for r in conn.execute(
            """SELECT DISTINCT m.txn_id FROM txn_link l JOIN txn_link_member m ON m.link_id = l.id
               WHERE l.kind = ?""", (REIMBURSEMENT_LINK_KIND,))}
        reimbursed = claimed_txn_ids(conn, [i for i in (*self.wallet_by_id, *self.other_by_id) if i in held])
        for row in (*self.wallet_rows, *self.other_rows):
            row["reimbursed"] = row["id"] in reimbursed

        kinds = (LINK_KIND, DECLINED_KIND, REVIEWED_KIND, *_CLAIMING_KINDS)
        members: dict[str, dict] = defaultdict(lambda: {"kind": None, "meta": None, "roles": {}})
        for r in conn.execute(
            f"""SELECT l.id, l.kind, l.metadata_json, m.txn_id, m.role
                FROM   txn_link l JOIN txn_link_member m ON m.link_id = l.id
                WHERE  l.kind IN ({",".join("?" * len(kinds))})""",
            kinds,
        ).fetchall():
            entry = members[r["id"]]
            entry["kind"] = r["kind"]
            entry["meta"] = r["metadata_json"]
            entry["roles"].setdefault(r["role"], []).append(r["txn_id"])

        self.pairs: dict[str, dict] = {}             # link id → {wallet, counterpart}
        self.paired_wallet: dict[str, str] = {}      # wallet txn → link id
        self.paired_other: dict[str, str] = {}       # counterpart txn → link id
        self.declined: set[tuple[str, str]] = set()
        self.reviewed: set[str] = set()
        self.claimed: set[str] = set(reimbursed)
        self.funding_leg: set[str] = set()           # wallet legs: money into the wallet
        self.has_leg: set[str] = set()               # payments a wallet leg already funds
        for link_id, entry in members.items():
            roles = entry["roles"]
            if entry["kind"] == LINK_KIND:
                wallet_ids, other_ids = roles.get(WALLET_ROLE, []), roles.get(COUNTERPART_ROLE, [])
                if wallet_ids and other_ids:
                    self.pairs[link_id] = {"wallet": wallet_ids[0], "counterpart": other_ids[0]}
                    self.paired_wallet[wallet_ids[0]] = link_id
                    self.paired_other[other_ids[0]] = link_id
            elif entry["kind"] == DECLINED_KIND:
                for p in roles.get(WALLET_ROLE, []):
                    for c in roles.get(COUNTERPART_ROLE, []):
                        self.declined.add((p, c))
            elif entry["kind"] == REVIEWED_KIND:
                self.reviewed.update(roles.get(REVIEWED_ROLE, []))
            else:
                for ids in roles.values():
                    self.claimed.update(ids)
                if entry["kind"] == WALLET_FUNDING_KIND:
                    self.funding_leg.update(roles.get("leg", []))
                    self.has_leg.update(roles.get("purchase", []))

    def owners_compatible(self, a: Optional[str], b: Optional[str]) -> bool:
        return _owners_compatible(self.shared_owner_id, a, b)

    def targets(self, row: dict) -> tuple[list[int], bool]:
        """The counterpart amounts (in cents, signed as the counterpart row is) a wallet row could have,
        and whether it states that money crossed to another account (so a missing counterpart is worth a
        look). An empty list means the row has no counterpart to find."""
        cents = _cents(row["amount"])
        if not cents:
            return [], False
        type_value = captured_type(row["import_evidence_json"])
        if cents < 0 and (row["id"] in self.funding_leg or is_wallet_funding_type(type_value)):
            return [-cents], True
        if cents > 0 and is_wallet_withdrawal_type(type_value):
            return [-cents], True
        if cents > 0 and row["id"] not in self.has_leg and not is_money_movement_type(type_value):
            return ([cents] if type_value else [cents, -cents]), False
        return [], False

    def pairable_other(self, row: dict) -> bool:
        return (not row["is_pending"] and not row["is_split"]
                and row["id"] not in self.claimed and row["id"] not in self.paired_other)

    def reads_as(self, other: dict, wallet: dict) -> bool:
        """Whether a bank or card row names this wallet — what makes it a candidate for that wallet's rows
        and not another's."""
        return bool(wallet["match_text"]) and wallet["match_text"] in other["reads_as"]

    def candidates(self, wallet: dict, window_days: int = PAIR_WINDOW_DAYS) -> list[str]:
        targets, _ = self.targets(wallet)
        day = _day(wallet["date"])
        if not targets or day is None:
            return []
        out = []
        for other in self.other_rows:
            if _cents(other["amount"]) not in targets or not self.pairable_other(other):
                continue
            if not self.reads_as(other, wallet):
                continue
            other_day = _day(other["date"])
            if other_day is None or abs((other_day - day).days) > window_days:
                continue
            if (wallet["id"], other["id"]) in self.declined:
                continue
            if not self.owners_compatible(wallet["owner_id"], other["owner_id"]):
                continue
            out.append(other["id"])
        return out

    def open_wallet_rows(self) -> list[dict]:
        return [r for r in self.wallet_rows if not r["is_pending"] and r["id"] not in self.paired_wallet]


def _claim_cornered(wants: dict[str, list[str]]) -> list[str]:
    """Let a wallet row with one candidate claim it, and take it out of every other row's list.

    A row with a single candidate can pair with that one or with nothing, so offering it to a row that
    could equally take something else is what strands the first row. Two same-amount payments days apart
    do this on a real ledger: the earlier one's only bank row falls inside the later one's window too, and
    both are handed to the user although only one of them was ever in doubt. Claiming settles both — what
    is left of the other row's list is then uncontested and pairs itself in the same pass — so the rounds
    repeat until a round claims nothing.

    The claim is made only where a **single** row is cornered. Two rows cornered on one candidate is a
    real shortage rather than an ambiguity (one of the payments was funded some other way), at most one of
    them can have it, and which is not deducible — so nothing is taken from anyone, and the rows go to the
    user as they did before.

    Mutates `wants`, and returns the rows it emptied — they wanted only what another row was cornered on,
    so there is nothing left for them to pair with.
    """
    stranded: list[str] = []
    while True:
        cornered: dict[str, list[str]] = defaultdict(list)
        for wallet_id, found in wants.items():
            if len(found) == 1:
                cornered[found[0]].append(wallet_id)
        claims = {other_id: owners[0] for other_id, owners in cornered.items() if len(owners) == 1}
        taken = False
        for wallet_id, found in wants.items():
            left = [c for c in found if claims.get(c, wallet_id) == wallet_id]
            if len(left) != len(found):
                wants[wallet_id] = left
                taken = True
        if not taken:
            return stranded
        for wallet_id in [p for p, found in wants.items() if not found]:
            del wants[wallet_id]
            stranded.append(wallet_id)


def _analyze(ledger: _Ledger) -> dict:
    """Split the unpaired wallet rows into what pairs itself and what needs a person.

    Returns ``{"auto": [(wallet_id, counterpart_id)], "choice": {wallet_id: [counterpart_id]},
    "unmatched": [wallet_id], "wanted": {counterpart_id}}`` — `unmatched` holds only the rows that state a
    counterpart exists, and `wanted` every counterpart some open wallet row could take (before any claim,
    since a claimed row is accounted for by whoever claimed it)."""
    wants: dict[str, list[str]] = {}
    unmatched: list[str] = []
    for row in ledger.open_wallet_rows():
        found = ledger.candidates(row)
        if found:
            wants[row["id"]] = found
        elif ledger.targets(row)[1]:
            unmatched.append(row["id"])

    wanted = {other_id for found in wants.values() for other_id in found}
    unmatched.extend(p for p in _claim_cornered(wants) if ledger.targets(ledger.wallet_by_id[p])[1])

    wanted_by: dict[str, list[str]] = defaultdict(list)
    for wallet_id, found in wants.items():
        for other_id in found:
            wanted_by[other_id].append(wallet_id)

    # Connected clusters of wallet rows and the candidates between them.
    seen: set[str] = set()
    auto: list[tuple[str, str]] = []
    choice: dict[str, list[str]] = {}
    for start in wants:
        if start in seen:
            continue
        wallet_ids, other_ids, stack = set(), set(), [start]
        while stack:
            wallet_id = stack.pop()
            if wallet_id in wallet_ids:
                continue
            wallet_ids.add(wallet_id)
            for other_id in wants[wallet_id]:
                other_ids.add(other_id)
                stack.extend(p for p in wanted_by[other_id] if p not in wallet_ids)
        seen |= wallet_ids

        by_date = lambda ids, rows: sorted(ids, key=lambda i: (str(rows[i]["date"]), i))  # noqa: E731
        amounts = {_cents(ledger.wallet_by_id[p]["amount"]) for p in wallet_ids}
        other_amounts = {_cents(ledger.other_by_id[c]["amount"]) for c in other_ids}
        interchangeable = (
            len(wallet_ids) == len(other_ids)
            and len(amounts) == 1 and len(other_amounts) == 1
            and all(set(wants[p]) == other_ids for p in wallet_ids)
        )
        if interchangeable:
            auto.extend(zip(by_date(wallet_ids, ledger.wallet_by_id), by_date(other_ids, ledger.other_by_id)))
        else:
            for wallet_id in wallet_ids:
                choice[wallet_id] = wants[wallet_id]
    return {"auto": auto, "choice": choice, "unmatched": unmatched, "wanted": wanted}


def _exclude(conn: sqlite3.Connection, row: dict) -> dict:
    """Move a row into "Money movement", returning what it held so a reversal can put it back. The row goes
    into the background, so its review flag is cleared with the rest (services/review_flagging.py)."""
    prior = {
        "category_id": row["category_id"],
        "category_source": row["category_source"],
        "category_overridden": row["category_overridden"],
        REVIEW_PRIOR_KEY: row["needs_review"],
    }
    conn.execute(
        "UPDATE txn SET category_id = ?, category_source = 'enrichment', category_overridden = 0, "
        "needs_review = 0 WHERE id = ?",
        (ensure_excluded_transfers_leaf(conn, MONEY_MOVEMENT_CATEGORY), row["id"]),
    )
    return prior


def _changeable(row: dict) -> bool:
    """Whether the pairing may move this row. Not when it is already money movement, nor when its category
    is not what decides it: a split row's parts do, and a claimed row's category is what a reimbursement
    record counts on."""
    return not row["movement"] and not row["is_split"] and not row["reimbursed"]


def _attach(conn: sqlite3.Connection, wallet: dict, other: dict, *, matched_by: str) -> str:
    """Record the pair and make its money count the way the pair says (see the module docstring): both
    rows excluded for a transfer, one side counted for a payment. What each changed row held is kept on
    the link for the reversal."""
    priors: dict[str, dict] = {}
    transfer = (_cents(wallet["amount"]) > 0) != (_cents(other["amount"]) > 0)
    if transfer:
        for row in (wallet, other):
            if _changeable(row):
                priors[row["id"]] = _exclude(conn, row)
    elif not wallet["movement"] and _changeable(other):
        priors[other["id"]] = _exclude(conn, other)
    # The pair is one movement on two accounts, so a duplicate flag between its rows is answered.
    clear_flag_between(conn, wallet["id"], other["id"])
    return txn_links.create_link(
        conn, LINK_KIND,
        [(wallet["id"], WALLET_ROLE), (other["id"], COUNTERPART_ROLE)],
        metadata={"priors": priors, "matched_by": matched_by},
    )


def funding_pairs(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    """Every paired (wallet row, counterpart row), as id pairs sorted low to high."""
    rows = conn.execute(
        """SELECT MIN(p.txn_id, c.txn_id) AS low, MAX(p.txn_id, c.txn_id) AS high
           FROM   txn_link l
           JOIN   txn_link_member p ON p.link_id = l.id AND p.role = ?
           JOIN   txn_link_member c ON c.link_id = l.id AND c.role = ?
           WHERE  l.kind = ?""",
        (WALLET_ROLE, COUNTERPART_ROLE, LINK_KIND),
    ).fetchall()
    return {(r["low"], r["high"]) for r in rows}


def _restore(conn: sqlite3.Connection, txn_id: str, prior: dict) -> None:
    """Put a row's category and review flag back — only while it still holds what the pairing set."""
    row = conn.execute("SELECT category_id, category_source FROM txn WHERE id = ?", (txn_id,)).fetchone()
    if not row or row["category_source"] != "enrichment" or row["category_id"] != money_movement_category_id_if_exists(conn):
        return
    conn.execute(
        "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
        (prior.get("category_id"), prior.get("category_source"),
         category_lock_for(prior.get("category_source"), prior.get("category_overridden")), txn_id),
    )
    restore_review_flag(conn, txn_id, prior)


def _release(conn: sqlite3.Connection, link_id: str) -> Optional[dict]:
    """Delete a pairing, restoring what it changed on whichever of its rows remain. Returns the link as it
    was."""
    link = txn_links.get_link(conn, link_id)
    if not link or link["kind"] != LINK_KIND:
        return None
    priors = (link.get("metadata") or {}).get("priors") or {}
    for member in link["members"]:
        prior = priors.get(member["txn_id"])
        if isinstance(prior, dict):
            _restore(conn, member["txn_id"], prior)
    txn_links.delete_link(conn, link_id)
    return link


def _heal(conn: sqlite3.Connection) -> int:
    """Drop the pairings and decisions whose rows are gone, and release the pairings their accounts no
    longer allow. Returns the number of links removed.

    A member row cascades away with its transaction, but the link itself has no foreign key, so a pairing
    whose wallet row was hard-deleted (emptied from Trash, removed with an account merge) would otherwise go
    on excluding its bank row with nothing left to count the money.

    What may pair is read from the accounts, which the user can edit: the wallet row on a wallet-type
    account, the counterpart on one that is not, and owners compatible as a candidate's must be. A pairing
    an edit has put outside that is released as an unpairing would be, since the exclusion it applied no
    longer has a wallet record behind it. Decisions are kept: they act on nothing meanwhile, and apply again
    if the account is set back. A change of match text releases nothing: it decides what is offered, and a
    pair already made was made on its own evidence or by the user."""
    stale = conn.execute(
        """SELECT l.id, l.kind, COUNT(m.txn_id) AS members
           FROM   txn_link l LEFT JOIN txn_link_member m ON m.link_id = l.id
           WHERE  l.kind IN (?, ?, ?)
           GROUP  BY l.id
           HAVING (l.kind = ? AND COUNT(m.txn_id) < 1) OR (l.kind <> ? AND COUNT(m.txn_id) < 2)""",
        (LINK_KIND, DECLINED_KIND, REVIEWED_KIND, REVIEWED_KIND, REVIEWED_KIND),
    ).fetchall()
    for row in stale:
        if row["kind"] == LINK_KIND:
            _release(conn, row["id"])
        else:
            txn_links.delete_link(conn, row["id"])

    shared_owner_id = get_shared_owner_id(conn)
    disallowed = [
        r["id"] for r in conn.execute(
            f"""SELECT l.id,
                       {wallet_account_clause('pa', 'ppa')} AS wallet_on_wallet,
                       {wallet_account_clause('ca', 'cpa')} AS counterpart_on_wallet,
                       COALESCE(pa.owner_id, ppa.owner_id) AS wallet_owner,
                       COALESCE(ca.owner_id, cpa.owner_id) AS counterpart_owner
                FROM   txn_link l
                JOIN   txn_link_member pm ON pm.link_id = l.id AND pm.role = ?
                JOIN   txn pt ON pt.id = pm.txn_id
                JOIN   account pa ON pa.id = pt.account_id
                LEFT   JOIN account ppa ON ppa.id = pa.parent_account_id
                JOIN   txn_link_member cm ON cm.link_id = l.id AND cm.role = ?
                JOIN   txn ct ON ct.id = cm.txn_id
                JOIN   account ca ON ca.id = ct.account_id
                LEFT   JOIN account cpa ON cpa.id = ca.parent_account_id
                WHERE  l.kind = ?""",
            (WALLET_ROLE, COUNTERPART_ROLE, LINK_KIND),
        ).fetchall()
        if not r["wallet_on_wallet"] or r["counterpart_on_wallet"]
        or not _owners_compatible(shared_owner_id, r["wallet_owner"], r["counterpart_owner"])
    ]
    for link_id in disallowed:
        _release(conn, link_id)
    return len(stale) + len(disallowed)


def pair_wallet_rows(conn: sqlite3.Connection) -> dict:
    """The pass run after every import and sync: heal what lost its rows, then apply every unambiguous
    pairing. Returns ``{"paired": n, "healed": n}``. Healing runs even with no wallet account left, since
    retyping the last one is what leaves its pairings to release."""
    healed = _heal(conn)
    if not has_wallet_account(conn):
        return {"paired": 0, "healed": healed}
    ledger = _Ledger(conn)
    analysis = _analyze(ledger)
    for wallet_id, other_id in analysis["auto"]:
        _attach(conn, ledger.wallet_by_id[wallet_id], ledger.other_by_id[other_id], matched_by="auto")
    return {"paired": len(analysis["auto"]), "healed": healed}


def pair_after_decision(conn: sqlite3.Connection) -> int:
    """Run the pass again once a decision in the review has changed what is there to pair.

    A decision is never only about its own row: taking a transaction settles what every row cornered on it
    could have been, and declining one releases it. The pass otherwise runs only after an import, a sync or
    an account change, so a row that a decision had just made unambiguous dropped out of the review —
    there is nothing left to ask about it — while nothing actually paired it, and its bank row went on
    counting beside the wallet row until the next ingest happened to run the pass. Claiming makes that
    reachable from more decisions than it used to be, since settling one row can now cascade through the
    rows it was cornered against.

    Best-effort and deliberately *after* the decision's own write: the decision is what the user asked for
    and stands whatever this finds, so a failure here is logged rather than allowed to undo it.
    """
    try:
        return pair_wallet_rows(conn)["paired"]
    except Exception as e:
        log_error(f"[wallet-funding] pairing after a review decision failed: {e}", exc_info=e)
        return 0


def pair_after_ingest(connection) -> None:
    """Run the pass once new rows are committed, in the connection context manager given. An import or a
    sync can bring either side of a pair — the wallet row or the bank row that arrives days later — so both
    run it. Like the duplicate sweep it runs after the ingest transaction, never inside it, and a failure
    is logged rather than allowed to fail the import or sync that already landed its rows. An account
    settings change runs the pass through `services/account_settings_followups.py`."""
    try:
        with connection as conn:
            pair_wallet_rows(conn)
    except Exception as e:
        log_error(f"[wallet-funding] pairing pass failed: {e}", exc_info=e)


# --- The review ------------------------------------------------------------------------------------------

def _scoped(ledger: _Ledger, analysis: dict, batch_id: Optional[str]) -> dict:
    """The review's rows as ids, over the whole ledger or one import's wallet rows."""
    def in_scope(wallet_id: str) -> bool:
        return batch_id is None or ledger.wallet_by_id.get(wallet_id, {}).get("import_batch_id") == batch_id

    return {
        "matched": [(link_id, pair) for link_id, pair in ledger.pairs.items() if in_scope(pair["wallet"])],
        "choice": {p: cands for p, cands in analysis["choice"].items() if in_scope(p)},
        "unmatched": [p for p in analysis["unmatched"] if in_scope(p)],
        "unaccounted": _unaccounted(ledger, analysis, batch_id),
    }


def _attention_ids(ledger: _Ledger, scoped: dict) -> list[str]:
    """What needs the user, as the rows it is about: a wallet row with a choice of candidates, the one bank
    or card row that several wallet rows are cornered on, and each unmatched or unaccounted row not yet
    acknowledged.

    A shortage is **one** decision however many rows it settles — giving the transaction to one of them
    leaves the rest with nothing to pair with — and the review shows it as one row, so counting each
    cornered row would have the card promise twice the work it lists. Naming it by the contested row also
    counts it once across cards when the rows cornered on it arrived with different files, the same way an
    unaccounted row listed by several cards is counted once."""
    choices = [wallet_id if len(cands) > 1 else cands[0] for wallet_id, cands in scoped["choice"].items()]
    return (list(dict.fromkeys(choices))
            + [p for p in scoped["unmatched"] if p not in ledger.reviewed]
            + [c for c in scoped["unaccounted"] if c not in ledger.reviewed])


def _attention(ledger: _Ledger, scoped: dict) -> int:
    return len(_attention_ids(ledger, scoped))


def wallet_pair_report(conn: sqlite3.Connection, batch_id: Optional[str] = None) -> dict:
    """The review of every wallet row's pairing, or — with `batch_id` — of the rows one import brought in.

      * matched          — a wallet row and the bank or card row paired with it
      * choice           — a wallet row with several candidates, none preferred
      * unmatched        — a wallet row that says money crossed to another account, with no candidate
      * unaccounted      — a bank or card row naming a wallet that nothing pairs with, on an account that
                           funds that wallet, within the dates the wallet's rows cover
      * wallet_names     — the wallets the review covers, which is what the review is called by

    Read-only: the pairing itself runs after imports and syncs, never from a report."""
    if not has_wallet_account(conn):
        return {"matched": [], "choice": [], "unmatched": [], "unaccounted": [], "wallet_names": []}
    ledger = _Ledger(conn)
    scoped = _scoped(ledger, _analyze(ledger), batch_id)
    matched, choice = scoped["matched"], scoped["choice"]

    ids = {pair["wallet"] for _, pair in matched} | {pair["counterpart"] for _, pair in matched}
    ids |= set(choice) | {c for cands in choice.values() for c in cands}
    ids |= set(scoped["unmatched"]) | set(scoped["unaccounted"])
    summaries = txn_summaries(conn, ids)
    link_meta = {link_id: (txn_links.get_link(conn, link_id) or {}).get("metadata") or {} for link_id, _ in matched}

    return {
        "matched": [
            {"link_id": link_id, "wallet": summaries.get(pair["wallet"]), "counterpart": summaries.get(pair["counterpart"]),
             "matched_by": link_meta[link_id].get("matched_by")}
            for link_id, pair in matched
        ],
        "choice": [
            {"wallet": summaries.get(p), "candidates": [summaries.get(c) for c in cands]}
            for p, cands in choice.items()
        ],
        "unmatched": [{"wallet": summaries.get(p), "reviewed": p in ledger.reviewed} for p in scoped["unmatched"]],
        "unaccounted": [{**summaries.get(c, {}), "reviewed": c in ledger.reviewed} for c in scoped["unaccounted"]],
        "wallet_names": _wallet_names(conn, ledger, batch_id),
    }


def _wallet_names(conn: sqlite3.Connection, ledger: _Ledger, batch_id: Optional[str]) -> list[str]:
    """The display names of the wallets whose rows the review covers, by name."""
    roots = sorted({r["root_id"] for r in ledger.wallet_rows if batch_id is None or r["import_batch_id"] == batch_id})
    if not roots:
        return []
    rows = conn.execute(
        f"SELECT DISTINCT COALESCE(display_name, name) AS label FROM account WHERE id IN ({','.join('?' * len(roots))})",
        roots,
    ).fetchall()
    return sorted({r["label"] for r in rows if r["label"]}, key=str.casefold)


def _unaccounted(ledger: _Ledger, analysis: dict, batch_id: Optional[str]) -> list[str]:
    """Bank and card rows naming a wallet that nothing pairs with. Only accounts already paired with that
    wallet are looked at, and only within the dates the wallet's rows cover: such a charge elsewhere
    belongs to a wallet the ledger does not track, where it is the only record and is counted correctly as
    it is. Scoped to one import, the dates are that import's."""
    funds: dict[str, set[str]] = defaultdict(set)   # funding account root → wallet account roots
    for pair in ledger.pairs.values():
        wallet, other = ledger.wallet_by_id.get(pair["wallet"]), ledger.other_by_id.get(pair["counterpart"])
        if wallet and other:
            funds[other["root_id"]].add(wallet["root_id"])
    spans: dict[str, tuple[str, str]] = {}
    wallet_of_root: dict[str, dict] = {}
    for row in ledger.wallet_rows:
        wallet_of_root.setdefault(row["root_id"], row)
        if batch_id is not None and row["import_batch_id"] != batch_id:
            continue
        lo, hi = spans.get(row["root_id"], (row["date"], row["date"]))
        spans[row["root_id"]] = (min(lo, row["date"]), max(hi, row["date"]))
    out = []
    for other in ledger.other_rows:
        if other["id"] in analysis["wanted"] or not ledger.pairable_other(other):
            continue
        for wallet_root in funds.get(other["root_id"], ()):
            span = spans.get(wallet_root)
            if span and span[0] <= other["date"] <= span[1] and ledger.reads_as(other, wallet_of_root[wallet_root]):
                out.append(other["id"])
                break
    return sorted(out, key=lambda i: ledger.other_by_id[i]["date"])


LEDGER_ATTENTION_KEY = "wallet_pair_attention"


def ledger_attention_count(conn: sqlite3.Connection) -> int:
    """The whole review's attention count — the Tasks nag — cached against the reconciliation epoch."""
    def compute(c: sqlite3.Connection) -> int:
        if not has_wallet_account(c):
            return 0
        ledger = _Ledger(c)
        return _attention(ledger, _scoped(ledger, _analyze(ledger), None))
    return ledger_attention(conn, LEDGER_ATTENTION_KEY, compute)


CARDS_KEY = "wallet_pair_cards"


def card_counts(conn: sqlite3.Connection) -> dict[str, dict]:
    """Each import or sync card whose share of the review has anything in it, as
    `{batch_id: {"rows": n, "attention_ids": [...]}}` — how many rows its review lists, and the rows that
    need the user. A card whose wallet rows have no other side (a payment from the balance, a hold) has
    nothing to show and is left out, so it offers no way into an empty review. The attention is ids rather
    than a count so a total over several cards can count each row once: a bank row with no wallet record is
    listed by every card whose dates cover it. One analysis serves every card, cached against the
    reconciliation epoch."""
    def compute(c: sqlite3.Connection) -> dict:
        if not has_wallet_account(c):
            return {}
        ledger = _Ledger(c)
        analysis = _analyze(ledger)
        out = {}
        for batch_id in sorted({r["import_batch_id"] for r in ledger.wallet_rows if r["import_batch_id"]}):
            scoped = _scoped(ledger, analysis, batch_id)
            rows = sum(len(scoped[k]) for k in ("matched", "choice", "unmatched", "unaccounted"))
            if rows:
                out[batch_id] = {"rows": rows, "attention_ids": _attention_ids(ledger, scoped)}
        return out
    return ledger_cached(conn, CARDS_KEY, compute)


# --- What the user decides -------------------------------------------------------------------------------

class PairingError(ValueError):
    pass


def pair_rows(conn: sqlite3.Connection, wallet_txn_id: str, counterpart_txn_id: str) -> str:
    """Pair a wallet row with a bank or card row the user picked. Refused when either side is already
    paired or claimed, the rows are on the wrong kinds of account, or the bank or card row does not name
    the wallet; an amount that differs is the user's call and is allowed."""
    ledger = _Ledger(conn)
    wallet = ledger.wallet_by_id.get(wallet_txn_id)
    other = ledger.other_by_id.get(counterpart_txn_id)
    if not wallet:
        raise PairingError("That is not a wallet transaction.")
    if not other or not ledger.reads_as(other, wallet):
        raise PairingError("That transaction is not a charge or deposit from this wallet on another account.")
    if wallet_txn_id in ledger.paired_wallet:
        raise PairingError("That wallet transaction is already matched.")
    if not ledger.pairable_other(other):
        raise PairingError("That transaction is already accounted for.")
    _release_verdicts(conn, [wallet_txn_id, counterpart_txn_id], pair=(wallet_txn_id, counterpart_txn_id))
    return _attach(conn, wallet, other, matched_by="user")


def unpair(conn: sqlite3.Connection, link_ids: Iterable[str]) -> int:
    """Undo pairings: restore each bank or card row and remember the pair as declined, so the pass does
    not make it again."""
    done = 0
    for link_id in link_ids:
        link = _release(conn, link_id)
        if not link:
            continue
        roles = {m["role"]: m["txn_id"] for m in link["members"]}
        if roles.get(WALLET_ROLE) and roles.get(COUNTERPART_ROLE):
            decline(conn, roles[WALLET_ROLE], [roles[COUNTERPART_ROLE]])
        done += 1
    return done


def decline(conn: sqlite3.Connection, wallet_txn_id: str, counterpart_txn_ids: Iterable[str]) -> int:
    """Record that none of these rows is this wallet row's counterpart."""
    count = 0
    existing = set(_declined_pairs(conn, wallet_txn_id))
    for counterpart_id in counterpart_txn_ids:
        if counterpart_id in existing:
            continue
        txn_links.create_link(conn, DECLINED_KIND, [(wallet_txn_id, WALLET_ROLE), (counterpart_id, COUNTERPART_ROLE)])
        count += 1
    return count


def _declined_pairs(conn: sqlite3.Connection, wallet_txn_id: str) -> list[str]:
    rows = conn.execute(
        """SELECT c.txn_id FROM txn_link l
           JOIN txn_link_member p ON p.link_id = l.id AND p.role = ? AND p.txn_id = ?
           JOIN txn_link_member c ON c.link_id = l.id AND c.role = ?
           WHERE l.kind = ?""",
        (WALLET_ROLE, wallet_txn_id, COUNTERPART_ROLE, DECLINED_KIND),
    ).fetchall()
    return [r["txn_id"] for r in rows]


def _release_verdicts(conn: sqlite3.Connection, txn_ids: list[str], *, pair: Optional[tuple[str, str]] = None) -> None:
    """A row the user now pairs is no longer acknowledged as having nothing to pair, and a pair the user
    makes by hand is no longer declined."""
    set_reviewed(conn, txn_ids, reviewed=False)
    if pair:
        for link_id in [
            r["id"] for r in conn.execute(
                """SELECT l.id FROM txn_link l
                   JOIN txn_link_member p ON p.link_id = l.id AND p.role = ? AND p.txn_id = ?
                   JOIN txn_link_member c ON c.link_id = l.id AND c.role = ? AND c.txn_id = ?
                   WHERE l.kind = ?""",
                (WALLET_ROLE, pair[0], COUNTERPART_ROLE, pair[1], DECLINED_KIND),
            ).fetchall()
        ]:
            txn_links.delete_link(conn, link_id)


def set_reviewed(conn: sqlite3.Connection, txn_ids: Iterable[str], *, reviewed: bool) -> int:
    """Acknowledge rows with nothing to pair (they stay listed but stop needing attention), or take the
    acknowledgement back."""
    changed = 0
    for txn_id in txn_ids:
        existing = [
            r["id"] for r in conn.execute(
                """SELECT l.id FROM txn_link l JOIN txn_link_member m ON m.link_id = l.id
                   WHERE l.kind = ? AND m.txn_id = ?""",
                (REVIEWED_KIND, txn_id),
            ).fetchall()
        ]
        if reviewed and not existing:
            txn_links.create_link(conn, REVIEWED_KIND, [(txn_id, REVIEWED_ROLE)])
            changed += 1
        elif not reviewed:
            for link_id in existing:
                txn_links.delete_link(conn, link_id)
                changed += 1
    return changed


def picker_candidates(conn: sqlite3.Connection, wallet_txn_id: str) -> list[dict]:
    """What the manual picker offers for one wallet row: every bank or card row naming that wallet within
    `PICKER_WINDOW_DAYS` that is free to pair, whatever its amount, nearest first."""
    ledger = _Ledger(conn)
    wallet = ledger.wallet_by_id.get(wallet_txn_id)
    day = _day(wallet["date"]) if wallet else None
    if day is None:
        return []
    near: list[tuple[int, str, str]] = []
    for other in ledger.other_rows:
        other_day = _day(other["date"])
        if other_day is None or abs((other_day - day).days) > PICKER_WINDOW_DAYS:
            continue
        if (ledger.pairable_other(other) and ledger.reads_as(other, wallet)
                and ledger.owners_compatible(wallet["owner_id"], other["owner_id"])):
            near.append((abs((other_day - day).days), str(other["date"]), other["id"]))
    ids = [txn_id for _, _, txn_id in sorted(near)]
    summaries = txn_summaries(conn, ids)
    return [summaries[i] for i in ids if i in summaries]


def reverse_batch_wallet_pairs(conn: sqlite3.Connection, batch_id: str) -> int:
    """Undo the pairings that involve a batch's rows, before those rows are deleted: a bank or card row
    outside the batch gets its category back, and the link goes. Decisions about the batch's rows go with
    them. Returns the number of pairings reversed."""
    link_ids = [
        r["id"] for r in conn.execute(
            """SELECT DISTINCT l.id, l.kind FROM txn_link l
               JOIN txn_link_member m ON m.link_id = l.id
               JOIN txn t ON t.id = m.txn_id
               WHERE l.kind IN (?, ?, ?) AND t.import_batch_id = ?""",
            (LINK_KIND, DECLINED_KIND, REVIEWED_KIND, batch_id),
        ).fetchall()
    ]
    reversed_count = 0
    for link_id in link_ids:
        if _release(conn, link_id):
            reversed_count += 1
        else:
            txn_links.delete_link(conn, link_id)
    return reversed_count
