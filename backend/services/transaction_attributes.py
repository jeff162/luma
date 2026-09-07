# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Transaction attributes — filtering by what a row *is* rather than by what it is filed under.

The other facets ask which account, category, owner, payee or tag a transaction belongs to. These ask a
different kind of question: does it carry an attachment, is it part of a recurring series, is money owed
back on it, has it been looked over yet. The vocabulary is deliberately **the row's own marker strip**
(`components/TransactionRow.jsx`) plus the two states the ledger already had toggles for, so that
filtering and reading use one set of words: whatever the row shows you, you can ask for.

**One vocabulary, three consumers.** The keys below are simultaneously the attribute facet's values (the
FilterBar's Attributes tab, multi-select with "is not"), the Transactions toolbar's single-select quick
filter, and the `?only=<key>` deep link that a Tasks nudge points at. They are plain readable words
rather than the `__sentinel__` shape the category and tag facets use, because those exist to avoid
colliding with real ids in a namespace shared with uuids, and this namespace holds nothing else.

**Every predicate must be NULL-free**, so that `negate_membership`'s COALESCE guard is belt-and-braces
rather than load-bearing. `EXISTS` is never NULL, and the column tests here are all written as `IS NULL`
/ `IS NOT NULL` or against `NOT NULL DEFAULT 0` columns. A future attribute that cannot meet that has to
say so, because "is not X" must return every row that is not X — including rows where X is unknown.

Adding an attribute is one row in `ATTRIBUTES`. It reaches the filter, the API vocabulary endpoint, and
therefore both UI surfaces without any of them being edited.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Attribute:
    key: str
    # What the surfaces call it. Held here rather than in the frontend so that adding an attribute does
    # not mean editing a parallel label table that can drift out of step with the predicate.
    label: str
    # The one-line explanation the pickers show. Says what the filter *selects*, not what the underlying
    # feature is for — the help topics carry the latter.
    description: str
    # A predicate correlating on the outer `t`, true for rows carrying the attribute.
    sql: str
    # Whether the FilterBar offers it as its own row. `uncategorized` is the deliberate exception: the
    # Categories tab already owns that bucket, and offering it twice in one popover would leave the user
    # deciding which of two identical-looking controls to use. It stays in the vocabulary because the
    # toolbar quick filter and the `?only=` link both need it.
    in_filter_bar: bool = True


ATTRIBUTES: tuple[Attribute, ...] = (
    Attribute(
        key="needs-review",
        label="Needs review",
        description="Recently imported or synced and not yet looked over.",
        sql="t.needs_review = 1",
    ),
    Attribute(
        key="uncategorized",
        label="Uncategorized",
        description="No category assigned.",
        sql="t.category_id IS NULL",
        in_filter_bar=False,
    ),
    Attribute(
        key="attachment",
        label="Has attachment",
        description="One or more documents are attached — a receipt, an invoice, a statement.",
        sql="EXISTS (SELECT 1 FROM document d WHERE d.txn_id = t.id)",
    ),
    Attribute(
        key="recurring",
        label="Recurring",
        description="Part of a recurring series.",
        sql="t.recurring_series_id IS NOT NULL",
    ),
    Attribute(
        key="reimbursable",
        label="Reimbursable",
        description="Money is owed back against this transaction, or it repays something.",
        sql=(
            "EXISTS (SELECT 1 FROM txn_link_member m JOIN txn_link l ON l.id = m.link_id "
            "        WHERE m.txn_id = t.id AND l.kind = 'reimbursement')"
        ),
    ),
    Attribute(
        key="purchase",
        # "Multi-payment purchase" is the domain term (mechanism-index.md, data-model.md,
        # architecture.md), and the label has to be that precise rather than shorter. "Part of a
        # purchase" fails because nearly every debit is a purchase, so it names no distinction; and
        # anything built on "part" — "multi-part purchase" — collides with splits, whose allocations
        # *are* the parts, and which mechanism-index.md names as the one pair that actually gets
        # confused with this. What separates them is that this divides a purchase across **payments**
        # and a split divides one payment across categories, so "payment" is the word that must survive.
        label="Multi-payment purchase",
        description="One payment of a purchase paid for in several — a deposit and a balance, an instalment plan.",
        sql=(
            "EXISTS (SELECT 1 FROM txn_link_member m JOIN txn_link l ON l.id = m.link_id "
            "        WHERE m.txn_id = t.id AND l.kind = 'purchase')"
        ),
    ),
    Attribute(
        key="split",
        label="Split",
        description="Divided across more than one category.",
        sql="t.is_split = 1",
    ),
    Attribute(
        key="note",
        label="Has a note",
        description="Carries a note.",
        sql="TRIM(COALESCE(t.notes, '')) <> ''",
    ),
    Attribute(
        key="duplicate",
        label="Possible duplicate",
        description="Flagged as possibly the same transaction as another, and not yet resolved.",
        sql="t.suspect_duplicate_of IS NOT NULL",
    ),
    Attribute(
        key="pending",
        label="Pending",
        description="Not yet settled — the amount or date may still change.",
        sql="t.is_pending = 1",
    ),
)

ATTRIBUTES_BY_KEY = {attribute.key: attribute for attribute in ATTRIBUTES}
ATTRIBUTE_KEYS = frozenset(ATTRIBUTES_BY_KEY)


def attribute_membership(keys: list[str]) -> Optional[tuple[str, list]]:
    """Membership for a set of attribute keys, OR'd together (the within-facet rule every facet follows).

    Unknown keys are ignored rather than raising. A key is a value inside a filter parameter, not a
    parameter name, so a stale one arriving from an old link should narrow to what it can still express
    instead of failing the whole request — the same way a deleted tag id in `tag_ids` simply matches
    nothing. A *parameter* the endpoint does not know still 400s, which is where the strictness belongs.
    """
    predicates = [ATTRIBUTES_BY_KEY[key].sql for key in keys if key in ATTRIBUTES_BY_KEY]
    if not predicates:
        return None
    return f"({' OR '.join(predicates)})", []


def attribute_require_all_sql(keys: list[str]) -> Optional[tuple[str, list]]:
    """An AND constraint over attribute keys — "carries all of these" — independent of the OR facet.

    The facet ORs its values, which is right for a multi-select picker where two ticks mean "either".
    But the ledger's toolbar filter is a *separate control*: someone who has already excluded an account
    in the FilterBar and then picks "Needs review" here is narrowing again, and folding that key into the
    facet's OR list would make a second filter **widen** the result — the one behaviour a filter must
    never have. So it applies as its own AND, exactly as `require_all_tag_ids` does for tags.
    """
    predicates = [ATTRIBUTES_BY_KEY[key].sql for key in keys if key in ATTRIBUTES_BY_KEY]
    if not predicates:
        return None
    return " AND ".join(f"({predicate})" for predicate in predicates), []


def attribute_vocabulary() -> list[dict]:
    """The attribute list as the UI consumes it — labels and all, so no surface keeps its own copy."""
    return [
        {
            "key": attribute.key,
            "label": attribute.label,
            "description": attribute.description,
            "in_filter_bar": attribute.in_filter_bar,
        }
        for attribute in ATTRIBUTES
    ]


__all__ = [
    "ATTRIBUTES",
    "ATTRIBUTES_BY_KEY",
    "ATTRIBUTE_KEYS",
    "Attribute",
    "attribute_membership",
    "attribute_require_all_sql",
    "attribute_vocabulary",
]
