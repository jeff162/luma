# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The shared filter facets — one definition of "is a member of this facet set", for every surface.

A *facet* is one axis the app-wide FilterBar exposes as chips: account (by name or by type), category
(by group or by leaf), owner, payee, tag, and attribute. Each is accepted as an **include** set and an **exclude** set, and the two are the same expression
— exclusion is the NULL-safe negation of the membership the include path builds, so they cannot drift.

**Why this is a registry rather than a helper per endpoint.** Nine endpoints consume these facets (the
transaction list feed, seven summary/trend endpoints, and the CSV export), and before this module each
one declared its own ~12 `Query` parameters and called its own sequence of append helpers. Adding a
facet therefore meant editing nine signatures, and the failure mode of missing one was silent: the
endpoint kept answering, unfiltered, so a total stopped matching the list it drilled into. The export
had already drifted that way — it hand-rolled its membership SQL and so ignored the synthetic
uncategorized buckets the list feed honors, returning an empty file for a filter that showed rows on
screen.

So the shape here is: one `Facet` row per axis, one `TransactionFacets` dependency carrying the query
parameters, and one `append_facets` that walks the registry. A new facet is a new row plus a new field,
and every endpoint that declares the dependency gets it at once. `FACET_PARAM_NAMES` closes the loop for
callers that need the set as data — the bulk endpoint's allowlist derives from it rather than repeating
it, and the guard in `tests/test_transaction_facets.py` asserts every endpoint accepts every facet, so an
omission fails loudly instead of quietly widening a result.

The amount filter (`AmountFilter`, `append_amount_filter`) sits beside the facets because the FilterBar
shows it too, so every endpoint that takes the facets takes it as well. It is not a facet: it has no
include/exclude pair and no chip. What deliberately stays out: `view`, `ids`, `quick_filter`,
`recurring_series_id` remain per-endpoint, because they genuinely differ in meaning and reach from one
surface to the next.
"""

from dataclasses import dataclass, fields as dataclass_fields
from typing import Callable, Optional

from fastapi import Query
# Aliased: `params` is a local name for SQL bind values throughout this module.
from fastapi import params as fastapi_params
from pydantic.fields import FieldInfo

from backend.services.account_groups import effective_account_id_sql
from backend.services.transaction_attributes import attribute_membership
from backend.services.transaction_tags import tag_filter_membership_sql

# Every membership expression below correlates on the alias set the callers all JOIN identically:
# t(xn) / a(ccount) / p(arent account) / c(ategory) / pc (parent category).
EFFECTIVE_ACCOUNT_ID_SQL = effective_account_id_sql("t.account_id")

# Synthetic selections the category facet accepts alongside real ids. They are not rows in `category`;
# they name the uncategorized buckets the UI shows as if they were entries, which is why every consumer
# has to route through the membership builder rather than comparing ids directly.
UNCATEGORIZED_CATEGORY_ID = "__uncategorized__"
UNCATEGORIZED_EXPENSE_CATEGORY_ID = "__uncategorized_expense__"
UNCATEGORIZED_INCOME_CATEGORY_ID = "__uncategorized_income__"

# The owner facet's first-class unowned bucket, expressed as `owner_id IS NULL`.
UNASSIGNED_OWNER_ID = "unassigned"


# --- Exclusion ("is not") -------------------------------------------------------------------------
# Exclusion is the NULL-safe negation of the *same* membership expression the include path builds. The
# NULL-safety is load-bearing: `t.category_id NOT IN (...)` is SQL-*unknown* (not true) for a NULL
# category, which would silently drop every uncategorized row from a "not Groceries" result even though
# an uncategorized row plainly is not Groceries. Collapsing unknown membership to non-member first keeps
# the invariant that a row the include set does not match always survives that facet's exclusion.
# See docs/data-model.md → "Filter exclusion".
def negate_membership(expr: str) -> str:
    return f"COALESCE(({expr}), 0) = 0"


# Tags negate with a plain NOT: membership is an EXISTS, which is never NULL, so the COALESCE guard
# above would be redundant rather than protective. Kept as its own function so the registry row states
# which negation a facet uses instead of leaving it implicit.
def negate_exists(expr: str) -> str:
    return f"NOT ({expr})"


def split_ids(raw: Optional[str], separator: str) -> list[str]:
    """Parse one facet parameter into its values.

    The isinstance guard is not defensive noise: these endpoints are also called directly (not over
    HTTP) by tests and internal callers, where an unset `Query(...)` default stays a truthy `FieldInfo`
    object rather than None — so a bare truthiness check would trip the clause and filter on nothing.
    """
    if not raw or not isinstance(raw, str):
        return []
    return [value.strip() for value in raw.split(separator) if value.strip()]


# --- Membership per facet -------------------------------------------------------------------------

# Both sides of an account comparison have to resolve the same way. The row side already does
# (`EFFECTIVE_ACCOUNT_ID_SQL`), and the *given* ids are resolved here too rather than compared raw,
# because a caller can hold an id that has since become a merged child — nothing resolves to a child
# any more, so a raw child id matches no row at all and reports no error. Resolving both sides makes
# a child id mean "the group it belongs to", which is the only reading anyone ever wants. Done in SQL,
# not by resolving the ids in Python first, so the filter builder stays a pure function with no
# connection of its own.
# See docs/data-model.md → "A stored account id is a reference into a mutable graph".
def account_membership(ids: list[str]) -> Optional[tuple[str, list]]:
    if not ids:
        return None
    placeholders = ','.join('?' * len(ids))
    return (
        f"{EFFECTIVE_ACCOUNT_ID_SQL} IN "
        f"(SELECT COALESCE(parent_account_id, id) FROM account WHERE id IN ({placeholders}))",
        list(ids),
    )


# "Every account of this type", beside the account facet's named accounts. A type chip keeps covering
# a card opened after it was picked, which a hand-picked set of accounts does not. The type is the
# *effective* account's, so a merged child reads as its group, as rules scoped by account type do
# (see docs/data-model.md → *Rules*).
def account_type_membership(types: list[str]) -> Optional[tuple[str, list]]:
    if not types:
        return None
    placeholders = ','.join('?' * len(types))
    return (
        f"(SELECT type FROM account WHERE id = {EFFECTIVE_ACCOUNT_ID_SQL}) IN ({placeholders})",
        list(types),
    )


def uncategorized_multi_membership(column_sql: str, raw_ids: list[str]) -> Optional[tuple[str, list]]:
    """Membership over real ids mixed with the synthetic uncategorized buckets, OR'd together.

    `__uncategorized__` subsumes the two sign-scoped buckets, so when it is present the narrower pair is
    not also emitted — the union is already the whole NULL-category set.
    """
    ids = [value.strip() for value in raw_ids if value and value.strip()]
    if not ids:
        return None
    normal_ids = []
    include_any_uncategorized = False
    include_uncategorized_expense = False
    include_uncategorized_income = False
    for value in ids:
        if value == UNCATEGORIZED_CATEGORY_ID:
            include_any_uncategorized = True
        elif value == UNCATEGORIZED_EXPENSE_CATEGORY_ID:
            include_uncategorized_expense = True
        elif value == UNCATEGORIZED_INCOME_CATEGORY_ID:
            include_uncategorized_income = True
        else:
            normal_ids.append(value)

    clauses: list[str] = []
    params: list = []
    if normal_ids:
        placeholders = ",".join("?" * len(normal_ids))
        clauses.append(f"{column_sql} IN ({placeholders})")
        params.extend(normal_ids)
    if include_any_uncategorized:
        clauses.append("t.category_id IS NULL")
    else:
        if include_uncategorized_expense:
            clauses.append("(t.category_id IS NULL AND t.amount > 0)")
        if include_uncategorized_income:
            clauses.append("(t.category_id IS NULL AND t.amount < 0)")
    if not clauses:
        return None
    return f"({' OR '.join(clauses)})", params


def category_membership(ids: list[str]) -> Optional[tuple[str, list]]:
    return uncategorized_multi_membership("t.category_id", ids)


def group_membership(ids: list[str]) -> Optional[tuple[str, list]]:
    # Membership = the leaf category sits under one of the selected top-level groups, plus any
    # synthetic uncategorized buckets selected alongside them.
    uncategorized = uncategorized_multi_membership("t.category_id", ids)
    normal_group_ids = [
        value for value in ids
        if value not in {
            UNCATEGORIZED_CATEGORY_ID,
            UNCATEGORIZED_EXPENSE_CATEGORY_ID,
            UNCATEGORIZED_INCOME_CATEGORY_ID,
        }
    ]
    clauses: list[str] = []
    params: list = []
    if normal_group_ids:
        placeholders = ','.join('?' * len(normal_group_ids))
        clauses.append(f"t.category_id IN (SELECT id FROM category WHERE parent_id IN ({placeholders}))")
        params.extend(normal_group_ids)
    if uncategorized:
        clauses.append(uncategorized[0])
        params.extend(uncategorized[1])
    if not clauses:
        return None
    return f"({' OR '.join(clauses)})", params


def owner_membership(ids: list[str]) -> Optional[tuple[str, list]]:
    # 'unassigned' expresses the first-class unowned bucket as `owner_id IS NULL`. Returning the
    # inclusion expression is what lets exclude negate it NULL-safely — which is why a NULL owner_id
    # survives "not owned by X" but *is* removed by "not unassigned": that is the set the user named.
    if not ids:
        return None
    if UNASSIGNED_OWNER_ID in ids:
        other_ids = [i for i in ids if i != UNASSIGNED_OWNER_ID]
        if other_ids:
            placeholders = ','.join('?' * len(other_ids))
            return f"(t.owner_id IS NULL OR t.owner_id IN ({placeholders}))", other_ids
        return "t.owner_id IS NULL", []
    placeholders = ','.join('?' * len(ids))
    return f"t.owner_id IN ({placeholders})", list(ids)


# Matched case-insensitively (`COLLATE NOCASE`), because the same merchant is routinely spelled several
# ways by the same source — `BIKEREG REGISTRATION` one month and `Bikereg Registration` the next — and to
# a person choosing a payee those are one payee, not two. Binary equality made that a silent under-match:
# a filter, a merchant report or a suppressed series' drill-down would show one spelling's rows and
# quietly omit the rest, with a count beside it derived from a case-folded grouping that disagreed.
# NOCASE is ASCII-only in SQLite, which is the right scope here — these are payee labels, and widening it
# would mean carrying a collation the rest of the schema does not use.
def payee_membership(names: list[str]) -> Optional[tuple[str, list]]:
    if not names:
        return None
    or_clauses = ' OR '.join(
        ['(t.display_name = ? COLLATE NOCASE OR t.merchant_name = ? COLLATE NOCASE '
         'OR t.raw_name = ? COLLATE NOCASE)'] * len(names)
    )
    params: list = []
    for name in names:
        params.extend([name, name, name])
    return f"({or_clauses})", params


# The name a row shows: the first non-empty of the rename, the cleaned name and the raw name, as
# `getTxnName` in components/TransactionRow.jsx resolves it.
PAYEE_LABEL_SQL = "COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), '')"


def like_contains_pattern(fragment: str) -> str:
    """`fragment` as a LIKE pattern for "contains", to be used with `ESCAPE '\\'`.

    Escaped because the fragment is text someone typed, and an unescaped `_` or `%` in it would match
    more than it says.
    """
    escaped = fragment.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


# "Payee contains", beside the facet's "payee is". One merchant routinely appears under several names,
# and choosing them one at a time both takes a pick per spelling and silently leaves out the spelling
# that first appears next month. Compared against the name the row *shows*, unlike the exact form's three
# columns: an exact value was picked from a list of names, whereas a fragment found only in a raw
# descriptor the row does not display returns rows with nothing on them to explain why. LIKE folds ASCII
# case, the same scope as the exact form's NOCASE.
def payee_contains_membership(fragments: list[str]) -> Optional[tuple[str, list]]:
    if not fragments:
        return None
    or_clauses = ' OR '.join([f"{PAYEE_LABEL_SQL} LIKE ? ESCAPE '\\'"] * len(fragments))
    return f"({or_clauses})", [like_contains_pattern(fragment) for fragment in fragments]


def tag_membership(ids: list[str]) -> Optional[tuple[str, list]]:
    # The *effective*-tag test — direct, inherited from the leaf category, its parent group, or the
    # effective account, and block-aware — plus the synthetic Untagged and Recurring selections. Defined
    # in services/transaction_tags.py so the row's own tag rendering and this filter ask one question.
    return tag_filter_membership_sql(ids)


# --- The registry ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class Facet:
    name: str
    include_param: str
    exclude_param: Optional[str]
    membership: Callable[[list[str]], Optional[tuple[str, list]]]
    negate: Callable[[str], str] = negate_membership
    # Payee values are names, which may legitimately contain a comma, so that facet is pipe-separated.
    separator: str = ','
    # Further ways of naming this facet's members, each with its own parameter pair. Their values OR
    # with the facet's own, which is what makes one a variant rather than a second facet: facets AND,
    # so "payee is A" and "payee contains b" as two facets would select almost nothing.
    variants: tuple['Facet', ...] = ()


FACETS: tuple[Facet, ...] = (
    Facet('account', 'account_ids', 'exclude_account_ids', account_membership, variants=(
        Facet('account_type', 'account_types', 'exclude_account_types', account_type_membership),
    )),
    # Groups and leaves are picked from one category tree, so a group and a leaf in another group must
    # widen the selection, not intersect to nothing.
    Facet('group', 'group_ids', 'exclude_group_ids', group_membership, variants=(
        Facet('category', 'category_ids', 'exclude_category_ids', category_membership),
    )),
    Facet('owner', 'owner_ids', 'exclude_owner_ids', owner_membership),
    Facet('payee', 'payees', 'exclude_payees', payee_membership, separator='|', variants=(
        Facet('payee_contains', 'payee_contains', 'exclude_payee_contains', payee_contains_membership,
              separator='|'),
    )),
    Facet('tag', 'tag_ids', 'exclude_tag_ids', tag_membership, negate=negate_exists),
    # What a row *is*, rather than what it is filed under — see services/transaction_attributes.py.
    # Its own facet rather than a rider on tags (which is where "recurring" briefly lived) because
    # facets AND with each other while values within one OR: "tagged Business" AND "has an attachment"
    # is the combination people reach for, and riding the tag facet would have made it an OR.
    Facet('attribute', 'attribute_ids', 'exclude_attribute_ids', attribute_membership),
)

# Every query-parameter name the registry owns, for callers that need the set as data rather than as
# code — the bulk endpoint's allowlist derives from this, so a facet cannot be added to the list feed
# and forgotten there (a missing key made bulk resolve a *wider* set than the count on screen).
# The owner lens: the viewer's own "show me these owners" setting, which narrows every scoped page
# (`data-model.md` → *Owner lens*). It rides beside the facets rather than in the registry because it is
# not a chip axis: it has no exclude form, and it ANDs with the owner facet instead of ORing into it, so
# an owner chip narrows inside the lens and never widens past it. It is still a filter of the same rows,
# so it is in `FACET_PARAM_NAMES`: bulk "select all matching" then resolves the lensed set it was shown.
OWNER_LENS_PARAM = "owner_lens"

FACET_PARAM_NAMES: frozenset[str] = frozenset(
    name
    for facet in FACETS
    for kind in (facet, *facet.variants)
    for name in (kind.include_param, kind.exclude_param)
    if name
) | {OWNER_LENS_PARAM}


def owner_lens_admits(owner_ids, lens) -> bool:
    """Whether something reaching these owners shows under the lens, for a list narrowed item by item
    rather than in SQL. Something that reaches no one yet shows to everyone, as `ownerLensAdmits` does in
    `frontend/src/lib/ownerLens.js`."""
    return not lens or not owner_ids or bool(set(owner_ids) & set(lens))


@dataclass
class TransactionFacets:
    """The facet query parameters, as one FastAPI dependency.

    Declared as `facets: TransactionFacets = Depends()` on an endpoint, which keeps the wire format
    byte-identical to the hand-written parameter block it replaces — these are the same names, still
    plain optional query strings — while making the set additive in one place.
    """

    attribute_ids: Optional[str] = Query(None, description="comma-separated attribute keys (see GET /transactions/filter-attributes)")
    account_ids: Optional[str] = Query(None, description="comma-separated account IDs (effective/top-level account)")
    account_types: Optional[str] = Query(None, description="comma-separated account types; ORs with account_ids")
    group_ids: Optional[str] = Query(None, description="comma-separated top-level group IDs; ORs with category_ids")
    category_ids: Optional[str] = Query(None, description="comma-separated leaf category IDs; ORs with group_ids")
    owner_ids: Optional[str] = Query(None, description="comma-separated owner IDs")
    payees: Optional[str] = Query(None, description="pipe-separated payee names")
    payee_contains: Optional[str] = Query(None, description="pipe-separated fragments of the shown payee name")
    tag_ids: Optional[str] = Query(None, description="comma-separated tag IDs")
    exclude_account_ids: Optional[str] = Query(None, description="account IDs to exclude ('is not')")
    exclude_account_types: Optional[str] = Query(None, description="account types to exclude ('is not')")
    exclude_group_ids: Optional[str] = Query(None, description="group IDs to exclude ('is not')")
    exclude_category_ids: Optional[str] = Query(None, description="category IDs to exclude ('is not')")
    exclude_owner_ids: Optional[str] = Query(None, description="owner IDs to exclude ('is not')")
    exclude_payees: Optional[str] = Query(None, description="payee names to exclude ('is not')")
    exclude_payee_contains: Optional[str] = Query(None, description="payee-name fragments to exclude ('is not')")
    exclude_tag_ids: Optional[str] = Query(None, description="tag IDs to exclude ('is not')")
    exclude_attribute_ids: Optional[str] = Query(None, description="attribute keys to exclude ('is not')")
    owner_lens: Optional[str] = Query(None, description="comma-separated owner IDs ('unassigned' for none) the viewer's owner lens shows; ANDs with owner_ids")

    def as_params(self) -> dict:
        """The set as a plain dict, for callers that pass facets around as keyword arguments."""
        return {f.name: getattr(self, f.name) for f in dataclass_fields(self)}


def facets_from(values: Optional[dict]) -> TransactionFacets:
    """Build the dependency from a loose dict — the bulk endpoint's stored filter payload."""
    values = values or {}
    return TransactionFacets(**{
        f.name: values.get(f.name) for f in dataclass_fields(TransactionFacets)
    })


def split_facets(values: dict) -> tuple[TransactionFacets, dict]:
    """Divide a loose keyword mapping into the facet dependency and everything else.

    For callers that hold one flat bag of endpoint arguments and need it in the two-part shape the
    endpoints now take — chiefly the test suite's direct calls, which build a full explicit kwarg set
    because unset `Query(...)` defaults are FieldInfo objects rather than None.
    """
    return facets_from(values), {k: v for k, v in values.items() if k not in FACET_PARAM_NAMES}


def coerce_facets(facets) -> Optional[TransactionFacets]:
    """Resolve whatever a caller passed into facets, or None for "no facets selected".

    This exists for the **direct-call** path. These endpoints are called as plain functions by the test
    suite and by internal callers, where a parameter left at its `Depends()` / `Query()` default keeps
    the FastAPI sentinel object rather than becoming None — the same footgun that makes every other
    filter here carry an isinstance guard. Absorbing it once, here, is what lets a direct caller simply
    omit `facets` when it is filtering on something else, instead of restating twelve `None`s.

    Anything that is neither a real selection nor a recognized sentinel raises, so a genuine mistake
    (passing a list, say) still fails loudly rather than filtering on nothing.
    """
    if facets is None:
        return None
    if isinstance(facets, TransactionFacets):
        return facets
    if isinstance(facets, dict):
        return facets_from(facets)
    # The unresolved FastAPI defaults: `Depends()` on the endpoint, or a bare `Query(...)` FieldInfo.
    if isinstance(facets, (fastapi_params.Depends, FieldInfo)):
        return None
    raise TypeError(f"facets must be TransactionFacets, dict or None — got {type(facets).__name__}")


def append_facets(clauses: list, params: list, facets: TransactionFacets | dict | None) -> None:
    """Append every selected facet's clause to a WHERE being assembled.

    Facets AND together (a row must satisfy each one that is selected); values *within* one facet OR
    together, which is what makes "Groceries or Dining, but not in Checking" the natural reading of a
    chip row. Include and exclude of the same facet both apply — the frontend splits its chips by mode,
    so a value never appears in both.
    """
    facets = coerce_facets(facets)
    if facets is None:
        return
    values = facets.as_params()
    for facet in FACETS:
        for exclude in (False, True):
            member = _facet_membership(facet, values, exclude=exclude)
            if member:
                clauses.append(facet.negate(member[0]) if exclude else member[0])
                params.extend(member[1])
    lens = owner_membership(split_ids(values.get(OWNER_LENS_PARAM), ','))
    if lens:
        clauses.append(lens[0])
        params.extend(lens[1])


# --- Amount ----------------------------------------------------------------------------------------

@dataclass
class AmountFilter:
    """The FilterBar's amount filter, as one FastAPI dependency: a side and a magnitude range.

    The parameter names are the ones the list feed already takes, so a Dashboard drill passes the same
    keys to a summary and to the list behind it.
    """

    direction: Optional[str] = Query(None, description="debit | credit")
    amount_min: Optional[float] = Query(None, description="Lower amount-magnitude bound; compares against ABS(amount). Pair with amount_min_op.")
    amount_max: Optional[float] = Query(None, description="Upper amount-magnitude bound; compares against ABS(amount). Pair with amount_max_op.")
    amount_min_op: Optional[str] = Query(">=", description="Lower-bound comparator: '>=' (default) or '>'.")
    amount_max_op: Optional[str] = Query("<=", description="Upper-bound comparator: '<=' (default) or '<'.")

    def as_params(self) -> dict:
        return {f.name: getattr(self, f.name) for f in dataclass_fields(self)}


AMOUNT_PARAM_NAMES: frozenset[str] = frozenset(f.name for f in dataclass_fields(AmountFilter))


def append_amount_filter(clauses: list, params: list, amount: AmountFilter | dict | None) -> None:
    """Append the amount filter's side and magnitude bounds to a WHERE being assembled.

    Mirrors the category-rule amount condition: bounds compare against ABS(amount) and the debit/credit
    side applies separately, so "credit, >= $50" resolves to amount <= -50. Comparators are whitelisted
    to the two the UI offers per bound so they can be interpolated. Under split expansion `t.amount` is
    the part's, so a report compares each allocation, which is what it counts.

    The isinstance guards absorb a direct (non-HTTP) call, where an unset `Query(...)` default or an
    omitted `Depends()` arrives as a FieldInfo or Depends object rather than None (bool is excluded
    because it is not a bound).
    """
    if isinstance(amount, AmountFilter):
        values = amount.as_params()
    elif isinstance(amount, dict):
        values = amount
    else:
        return
    direction = values.get("direction")
    if direction == "debit":
        clauses.append("t.amount > 0")
    elif direction == "credit":
        clauses.append("t.amount < 0")
    amount_min, amount_max = values.get("amount_min"), values.get("amount_max")
    if isinstance(amount_min, (int, float)) and not isinstance(amount_min, bool):
        op = ">" if str(values.get("amount_min_op")) == ">" else ">="
        clauses.append(f"ABS(t.amount) {op} ?")
        params.append(float(amount_min))
    if isinstance(amount_max, (int, float)) and not isinstance(amount_max, bool):
        op = "<" if str(values.get("amount_max_op")) == "<" else "<="
        clauses.append(f"ABS(t.amount) {op} ?")
        params.append(float(amount_max))


def append_totals_exclusion(
    clauses: list, params: list, facets: TransactionFacets | dict | None, *, group_alias: str,
) -> None:
    """Drop `exclude_from_totals` categories from a cross-cutting summary, unless a chip names them.

    A total leaves out money movement, but a group or category the user includes by name is a scope
    they asked for, so its rows count even when it is excluded: `group: Transfers` reports the
    transfers rather than nothing. Only the group and category include facets name a scope. A tag,
    account or payee chip selects rows without naming what they are filed under, and an exclude chip
    only removes rows.

    Every summary and the list feed's dashboard drill call this one function, so a drill lists the rows
    its figure counted. The leaf category is joined as `c`; the group alias differs between the summary
    endpoints (`p`) and the list feed (`pc`). See docs/data-model.md → *Reporting assumptions*.
    """
    facets = coerce_facets(facets)
    values = facets.as_params() if facets else {}
    category_ids = split_ids(values.get('category_ids'), ',')
    group_ids = split_ids(values.get('group_ids'), ',')
    exempt = []
    if category_ids:
        exempt.append(f"c.id IN ({','.join('?' * len(category_ids))})")
    if group_ids:
        exempt.append(f"c.parent_id IN ({','.join('?' * len(group_ids))})")
    clauses.append(
        f"(COALESCE({group_alias}.exclude_from_totals, c.exclude_from_totals, 0) = 0"
        + "".join(f" OR {sql}" for sql in exempt) + ")"
    )
    params.extend(category_ids + group_ids)


def _facet_membership(facet: Facet, values: dict, *, exclude: bool) -> Optional[tuple[str, list]]:
    """One facet's selection in one mode as a single membership, its variants ORed in."""
    parts = []
    for kind in (facet, *facet.variants):
        param = kind.exclude_param if exclude else kind.include_param
        member = kind.membership(split_ids(values.get(param), kind.separator)) if param else None
        if member:
            parts.append(member)
    if len(parts) <= 1:
        return parts[0] if parts else None
    return f"({' OR '.join(sql for sql, _ in parts)})", [value for _, bound in parts for value in bound]
