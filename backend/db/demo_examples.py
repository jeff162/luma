# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Worked examples layered onto the imported demo transactions.

`demo_data` builds a ledger the way a user would — two CSV imports and an Amazon order import through
the real pipelines. What it
cannot express that way is anything that is *done to* a transaction afterwards: a split, a receivable
and its repayment, an attached receipt, a rule carrying an amount range, payments grouped into one
purchase. Those arrive here, against rows the imports already created.

**These are examples rather than fixtures.** Someone exploring the demo is reading them to find out what
a feature is *for*, so each one is a situation with a recognizable shape — a warehouse run that was
half groceries, a work trip that got repaid, tickets bought for friends — rather than the smallest data
that would light the feature up. Where a feature has several distinct uses, several are shown: the
reimbursements below cover a straightforward claim, an immediate settling-up, and a debt that is still
half outstanding, because those are three different reasons someone would reach for it.

Every example is built through the same services the app's own endpoints call, so a demo tenant cannot
drift into a state the UI could not have produced.
"""

import uuid

from backend.services.documents import attach_document, prepare_document
from backend.services.excluded_categories import find_reimbursable_group_id
from backend.services.purchase_links import create_purchase
from backend.services.reimbursements import add_claims, complete, create_reimbursement, update_reimbursement
from backend.services.txn_splits import save_split, suggest_split


def _txn(conn, description_fragment: str) -> dict | None:
    """The newest transaction whose name contains `description_fragment`.

    Matched on the name rather than carried down from the CSV builder because the import pipeline is
    what creates these rows, and looking them up the way a user would find them keeps this module
    independent of how the rows were spelled on the way in.
    """
    row = conn.execute(
        """SELECT id, amount, date, display_name FROM txn
           WHERE display_name LIKE ? OR raw_name LIKE ?
           ORDER BY date DESC LIMIT 1""",
        (f"%{description_fragment}%", f"%{description_fragment}%"),
    ).fetchone()
    return dict(row) if row else None


def _receivable_leaf(conn, name: str) -> str:
    """A leaf under the seeded `Reimbursable` group, created on first use.

    The group is machinery and is seeded for everyone; its leaves are not, because only the user knows
    what a given receivable is *for*. Naming them after the thing rather than the state is the rule the
    feature depends on — a leaf called "awaiting payment" is a lie about every row in it once paid.
    """
    parent_id = find_reimbursable_group_id(conn)
    existing = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id = ?", (name, parent_id)
    ).fetchone()
    if existing:
        return existing["id"]
    leaf_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals)
           VALUES (?, ?, ?, 'expense', 1)""",
        (leaf_id, parent_id, name),
    )
    return leaf_id


def _categorize(conn, txn_id: str, category_id: str) -> None:
    conn.execute(
        "UPDATE txn SET category_id = ?, category_source = 'manual', category_overridden = 1, "
        "needs_review = 0 WHERE id = ?",
        (category_id, txn_id),
    )


# --- Splits ---------------------------------------------------------------------------------------

def seed_split(conn, leaves: dict) -> None:
    """One shop, two categories. The case a split exists for and the one people meet first."""
    txn = _txn(conn, "Warehouse Club")
    if not txn or "Groceries" not in leaves or "Household Supplies" not in leaves:
        return
    save_split(conn, txn["id"], [
        {"category_id": leaves["Groceries"], "amount": 148.20, "label": "Food shop"},
        {"category_id": leaves["Household Supplies"], "amount": 66.40, "label": "Detergent, paper goods"},
    ])


# --- Reimbursables --------------------------------------------------------------------------------

def seed_reimbursements(conn, leaves: dict) -> None:
    """Three shapes of the same idea, because the feature is not obvious from any one of them.

    A **work expense** is the textbook case: paid personally, claimed, repaid in full a fortnight later,
    and finished. A **shared meal** is the same mechanics over hours instead of weeks — the point being
    that the feature is not only for slow money. **Concert tickets** is the one that shows why a claim
    is per *portion*: one charge, two friends, two independent debts, one of them still open months
    before the event. That last is left unfinished on purpose, so the outstanding total is not zero and
    the reminder has a subject.
    """
    # 1. A work trip, repaid in full and closed.
    hotel = _txn(conn, "Northgate Hotel")
    repayment = _txn(conn, "Expense reimbursement")
    if hotel and repayment:
        work_leaf = _receivable_leaf(conn, "Work expenses")
        _categorize(conn, hotel["id"], work_leaf)
        _categorize(conn, repayment["id"], work_leaf)
        record = create_reimbursement(
            conn,
            [{"txn_id": hotel["id"], "amount": hotel["amount"], "label": "Conference hotel"}],
            counterparty="Northwind Ltd",
        )
        add_claims(conn, record["id"], [{"txn_id": repayment["id"], "amount": repayment["amount"]}])
        complete(conn, record["id"])

    # 2. Lunch for four, settled the same afternoon. The expense is split because only three quarters of
    #    it was ever owed — the payer's own share is ordinary spending and should report as such.
    lunch = _txn(conn, "Lakeside Taverna")
    payers = [_txn(conn, f"{name} — lunch") for name in ("Sam Okafor", "Priya Raman", "Dana Whitfield")]
    if lunch and all(payers) and "Dining Out" in leaves:
        lunch_leaf = _receivable_leaf(conn, "Shared meals")
        save_split(conn, lunch["id"], [
            {"category_id": leaves["Dining Out"], "amount": 24.00, "label": "My share"},
            {"category_id": lunch_leaf, "amount": 72.00, "label": "Three friends' shares"},
        ])
        claims = [{"txn_id": lunch["id"], "amount": 72.00, "label": "Three friends' shares"}]
        record = create_reimbursement(conn, claims, counterparty="Lunch, split three ways")
        for payer in payers:
            _categorize(conn, payer["id"], lunch_leaf)
        add_claims(conn, record["id"], [{"txn_id": p["id"], "amount": p["amount"]} for p in payers])
        complete(conn, record["id"])

    # 3. Three concert tickets on one charge: one for the buyer, two owed back by different people. Two
    #    reimbursements over one transaction is the case a "one reimbursement per row" rule could not
    #    express — the debts are namable, repayable and finishable independently, and here one of them is.
    tickets = _txn(conn, "Riverstone Amphitheater")
    ticket_payment = _txn(conn, "Sam Okafor — concert ticket")
    if tickets and "Movies & Events" in leaves:
        ticket_leaf = _receivable_leaf(conn, "Concert tickets")
        save_split(conn, tickets["id"], [
            {"category_id": leaves["Movies & Events"], "amount": 35.00, "label": "My ticket"},
            {"category_id": ticket_leaf, "amount": 35.00, "label": "Sam's ticket"},
            {"category_id": ticket_leaf, "amount": 35.00, "label": "Priya's ticket"},
        ])
        paid = create_reimbursement(
            conn,
            [{"txn_id": tickets["id"], "amount": 35.00, "label": "Sam's ticket"}],
            counterparty="Sam Okafor",
        )
        owing = create_reimbursement(
            conn,
            [{"txn_id": tickets["id"], "amount": 35.00, "label": "Priya's ticket"}],
            counterparty="Priya Raman",
        )
        if ticket_payment and abs(float(ticket_payment["amount"]) + 35.00) < 0.01:
            _categorize(conn, ticket_payment["id"], ticket_leaf)
            add_claims(conn, paid["id"], [{"txn_id": ticket_payment["id"], "amount": ticket_payment["amount"]}])
            complete(conn, paid["id"])
        # The show is months away, so nagging about it now would be noise. An explicit date is the
        # difference between "nobody has paid" and "nobody has paid *yet*", and it is the reason the
        # reminder is a per-record setting rather than one household-wide number.
        update_reimbursement(conn, owing["id"], counterparty="Priya Raman",
                             remind_on=_months_ahead(conn, tickets["date"], 7))


def seed_open_reimbursements(conn, leaves: dict) -> None:
    """Receivables with work still to do, so the report and Tasks have something to act on.

    The examples above end settled or deliberately not yet due. These are the three states someone
    actually comes back to: a repayment that fell **short** and needs its shortfall booked, a debt whose
    reminder has **come due** with nothing paid, and money filed as receivable but **not yet tracked** —
    an expense and its repayment both sitting loose, waiting to be paired and completed.
    """
    # 1. An insurance claim paid at 80%. The record is open with $36 left, and only completing it says
    #    whether that is a shortfall to book as medical spending or a second payment still to come.
    therapy = _txn(conn, "Brightwater Physical Therapy")
    claim = _txn(conn, "Summit Health Plan claim")
    if therapy and claim:
        claims_leaf = _receivable_leaf(conn, "Insurance claims")
        _categorize(conn, therapy["id"], claims_leaf)
        _categorize(conn, claim["id"], claims_leaf)
        record = create_reimbursement(
            conn,
            [{"txn_id": therapy["id"], "amount": therapy["amount"], "label": "Physical therapy visit"}],
            counterparty="Summit Health Plan",
        )
        add_claims(conn, record["id"], [{"txn_id": claim["id"], "amount": claim["amount"]}])

    # 2. A cabin shared with a friend, half owed back and nothing paid. It follows the household default
    #    reminder, which a stay this old is past, so it is what the Tasks reminder is about.
    cabin = _txn(conn, "Pinecrest Cabins")
    if cabin and "Hotel" in leaves:
        trips_leaf = _receivable_leaf(conn, "Shared trips")
        half = round(float(cabin["amount"]) / 2, 2)
        save_split(conn, cabin["id"], [
            {"category_id": leaves["Hotel"], "amount": half, "label": "My half"},
            {"category_id": trips_leaf, "amount": half, "label": "Morgan's half"},
        ])
        create_reimbursement(
            conn, [{"txn_id": cabin["id"], "amount": half, "label": "Morgan's half"}],
            counterparty="Morgan Ellis",
        )

    # 3. Filed as receivable and left loose: no record yet. Tracking is optional, so both rows already
    #    report correctly; grouping them is what lets the pair be completed and leave the report.
    printing = _txn(conn, "Print & Copy Depot")
    payback = _txn(conn, "Acme Corp Expense Reimb")
    if printing and payback:
        work_leaf = _receivable_leaf(conn, "Work expenses")
        _categorize(conn, printing["id"], work_leaf)
        _categorize(conn, payback["id"], work_leaf)


# --- Marketplace orders ----------------------------------------------------------------------------

def seed_order_split(conn, leaves: dict) -> None:
    """An Amazon order of two unlike things, split per item.

    Built from the same proposal the split editor pre-fills: each item's share of what was actually
    paid, weighted by list price, with a category wherever one of the user's rules claims the item. The
    item no rule claims is filed here the way the user would, which is the half of the proposal that is
    left to them.
    """
    order = conn.execute(
        """SELECT t.id FROM txn t JOIN account a ON a.id = t.account_id
           WHERE a.type = 'amazon' AND t.merchant_name LIKE '%Phone tripod%'"""
    ).fetchone()
    if not order or "Electronics" not in leaves:
        return
    suggestion = suggest_split(conn, order["id"])
    if not suggestion or not suggestion["available"]:
        return
    save_split(conn, order["id"], [
        {"category_id": part["category_id"] or leaves["Electronics"], "amount": part["amount"],
         "label": part["label"]}
        for part in suggestion["parts"]
    ])


def _months_ahead(conn, iso_date: str, months: int) -> str:
    return conn.execute("SELECT date(?, ?)", (iso_date, f"+{months} months")).fetchone()[0]


# --- Attached documents ----------------------------------------------------------------------------

# A minimal one-page PDF carrying a real text layer, so tier-1 extraction has something true to read.
# `backend/tests/_pdf_fixture.py` builds one too and the two are deliberately not shared: that one exists
# to stress the parser and may grow malformed variants, this one has to look like a receipt.
def _text_pdf(lines: list[str]) -> bytes:
    body = "BT /F1 12 Tf 40 750 Td 14 TL\n" + "\n".join(
        "({}) Tj T*".format(line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)"))
        for line in lines
    ) + "\nET\n"
    # A PDF text object is latin-1; anything outside it is replaced rather than raising, since a
    # demo receipt is not worth failing a whole tenant build over.
    stream = body.encode("latin-1", errors="replace")
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R"
        b"/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"endstream",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (f"trailer\n<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref_at}\n".encode()
            + b"%%EOF\n")
    return bytes(out)


def seed_documents(conn) -> None:
    """One of each kind that carries text, on transactions where a receipt is the natural thing to keep.

    The three exist to show the three answers the store can give: a PDF's own text layer, an emailed
    receipt's markup reduced to words, and a paste that was already text. All three land in the same
    search, which is the point — the paperwork is findable from the ledger rather than filed beside it.
    """
    invoice = _txn(conn, "City Vet Clinic")
    if invoice:
        _attach(conn, invoice["id"], "vet-invoice.pdf", "application/pdf", _text_pdf([
            "City Vet Clinic - Invoice 4471",
            "Annual wellness exam ............ 68.00",
            "Rabies booster .................. 24.00",
            "Nail trim ....................... 28.00",
            "Total .......................... 120.00",
            "Next visit due in 12 months.",
        ]))

    emailed = _txn(conn, "Sky Harbor Parking")
    if emailed:
        _attach(conn, emailed["id"], "parking-receipt.html", "text/html", (
            "<html><body><h1>Sky Harbor Parking</h1>"
            "<table><tr><td>Garage B, level 3</td><td>4 days</td><td>$64.00</td></tr></table>"
            "<p>Entry 08:12, exit 17:40. Receipt 88-2213.</p></body></html>"
        ).encode("utf-8"))

    pasted = _txn(conn, "Riverstone Amphitheater")
    if pasted:
        _attach(conn, pasted["id"], "ticket-confirmation.txt", "text/plain", (
            "Order RS-90114 confirmed\n"
            "Riverstone Amphitheater — 3 x General Admission @ $35.00\n"
            "Section Lawn, gates open 18:00\n"
            "Tickets are transferable until the day of the show.\n"
        ).encode("utf-8"))


def _attach(conn, txn_id: str, filename: str, mime_type: str, data: bytes) -> None:
    attach_document(conn, txn_id, prepare_document(data, filename, mime_type))


# --- Rules that do more than name a category --------------------------------------------------------

def seed_rules(conn, leaves: dict) -> None:
    """Amount ranges, a rename, and two overlaps worth reporting.

    The amount range is shown doing the job it was built for — telling two bills from one biller apart
    by size — rather than as a filter for its own sake. The overlapping pairs are deliberate: *Check
    overlaps* has nothing to report on a tidy rule set, and both kinds it distinguishes are worth
    meeting once.
    """
    def rule(keyword, leaf, *, amount_min=None, amount_max=None, clean_name=None):
        if leaf not in leaves:
            return
        conn.execute(
            """INSERT INTO category_rule (id, category_id, keyword, amount_min, amount_max, clean_name)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (str(uuid.uuid4()), leaves[leaf], keyword, amount_min, amount_max, clean_name),
        )

    # Disambiguation: the same biller sends a small monthly bill and a large annual one, and the amount
    # is the only thing telling them apart. The bands do not meet, so this pair is unambiguous.
    rule("metro water", "Water", amount_max=60.00)
    rule("metro water", "Home Repairs", amount_min=150.00)

    # A rename, so the ledger reads in the user's words rather than the bank's.
    rule("cellone", "Phone", clean_name="CellOne Mobile")

    # An ambiguity to find: fuel under $100 files as Gas, anything over $80 as a road trip. Between $80
    # and $100 neither rule is more specific and which one wins is an accident of ordering.
    rule("shell", "Gas", amount_max=100.00)
    rule("shell", "Vacation Transportation", amount_min=80.00)

    # Nested matchers: harmless, and reported because the winner is not the one most readers expect.
    rule("amazon fresh", "Groceries")


# --- Multi-payment purchases -----------------------------------------------------------------------

def seed_purchase(conn) -> None:
    """A sofa paid as a deposit and a balance: two payments, one thing bought.

    The expected total is stated because it is what turns the link from a note into a check — with it,
    the purchase can say that nothing is still owed, which is the question someone paying in
    instalments actually has.
    """
    payments = conn.execute(
        "SELECT id FROM txn WHERE raw_name = 'Oakline Furniture' ORDER BY date"
    ).fetchall()
    if len(payments) < 2:
        return
    create_purchase(conn, [p["id"] for p in payments], label="Sofa", reference="OF-20931",
                    expected_total=1599.00)


def seed_transaction_tags(conn, tag_ids: dict) -> None:
    """A couple of tags applied to single transactions, alongside the category-level ones.

    Both routes reach the same reports, and only one of them is visible in the category tree — a tag put
    on one transaction is the answer to "this particular charge belongs to the rental", which no
    category rule would get right.
    """
    tag_id = tag_ids.get("Discretionary")
    if not tag_id:
        return
    for fragment in ("Riverstone Amphitheater", "Lakeside Taverna"):
        txn = _txn(conn, fragment)
        if txn:
            conn.execute(
                "INSERT OR IGNORE INTO txn_tag (txn_id, tag_id) VALUES (?, ?)", (txn["id"], tag_id)
            )


def seed_all(conn, leaves: dict, tag_ids: dict) -> dict:
    """Every example, in dependency order: splits before the reimbursements that claim their parts."""
    seed_split(conn, leaves)
    seed_order_split(conn, leaves)
    seed_reimbursements(conn, leaves)
    seed_open_reimbursements(conn, leaves)
    seed_documents(conn)
    seed_rules(conn, leaves)
    seed_purchase(conn)
    seed_transaction_tags(conn, tag_ids)
    return {
        "purchases": conn.execute("SELECT COUNT(*) FROM txn_link WHERE kind = 'purchase'").fetchone()[0],
        "splits": conn.execute("SELECT COUNT(*) FROM txn WHERE is_split = 1").fetchone()[0],
        "reimbursements": conn.execute(
            "SELECT COUNT(*) FROM txn_link WHERE kind = 'reimbursement'"
        ).fetchone()[0],
        "documents": conn.execute("SELECT COUNT(*) FROM document").fetchone()[0],
    }
