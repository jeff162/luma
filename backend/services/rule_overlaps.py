# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Rule pairs that compete for the same transactions, surfaced on demand.

Two rules can both match one row. Usually that is fine, because the precedence contract
(`categorizer.rule_specificity_order_sql`) decides between them for a reason the user would recognize:
a scoped rule beats a global one, a longer keyword beats a shorter one, a contained amount range beats
the range containing it. This module reports the two cases worth a human's attention instead.

- **`amount_overlap` (warning).** Two rules the ordering can separate *only* by the amount-span term,
  whose ranges intersect with neither containing the other — `[300, 4000]` against `[3000, inf)`. Span
  picks one by arithmetic accident; there is no reading under which either is more specific. It is an
  ambiguity in the rules themselves, so nothing here tries to resolve it: the pair is named and the
  user decides, usually by making the ranges disjoint.

- **`matcher_co_match` (warning).** Two rules whose matchers neither repeat nor contain each other, both
  matching one real transaction — `delta` and `hertz` against a "DELTA HERTZ" row. The ordering settles
  it on keyword length, but length is only a stand-in for containment ("a longer substring matches a
  strict subset of the rows a shorter one does"), and between matchers that do not nest there is no
  subset relation for it to stand in for. **This is the one finding that cannot be derived from
  `category_rule` alone**: whether two unrelated keywords ever land in one merchant name is a fact about
  the ledger, so it takes a scan (`_co_matching_pairs`).

- **`matcher_nesting` (info).** One rule's merchant matcher matches a strict subset of the other's rows
  (`amazon` and `amazon prime`). Nothing is wrong and nothing is ambiguous — this is reported for two
  reasons. The winner is not always the one a reader expects, since keyword length only decides *after*
  scope, so an owner-scoped `amazon` rule beats a global `amazon prime` rule on that owner's rows. And
  where both rules file to the same category under the same scope, the narrow one is **redundant** —
  `narrower_is_redundant` marks that, and it is the pair the user can simply delete half of.

**Either warning drops to information when the two rules do the same thing** (`_actions_agree`:
category, rename, tags and the recurring flag all equal), as `amount_overlap_benign` and
`matcher_co_match_benign`. A pair can compete forever over an outcome that is identical whichever side
wins — two spellings of one merchant filing to one category is the common shape — and calling that a
problem the user must refine trains them to ignore the panel. The split is by *kind* rather than only
severity because dismissibility is decided by kind, and it rides in the finding's key, so an
acknowledgement lapses the moment the two stop agreeing.

The action each kind carries follows from that split, and it is the reverse of what it first looks like.
The *ambiguous* pair offers no removal: the answer there is to refine the conditions until the rules are
unambiguous, and deleting one is picking a side rather than fixing the model. The *nesting* pair does,
because a rule that adds nothing to the categorization is simply surplus.

The kinds cannot collide. `amount_overlap` requires identical matcher text and `matcher_nesting`
requires one matcher inside the other; `matcher_co_match` takes what is left, matchers that are neither
the same nor nested. All three require the two rules' scopes to tie, because a scope difference is a
real refinement that precedence reads before any of this.

**Which rule wins is read from the engine's own ordering rather than re-decided here.** The rule ids are
pulled once in precedence order and compared by rank, so this module cannot drift from what the import
will actually do — the same reason the ordering lives in one function.

**A nesting finding can be dismissed; an amount overlap cannot.** That asymmetry is the whole policy and
it is not a UI preference — `DISMISSIBLE_KINDS` decides it here, and the filter below refuses to hide a
non-dismissible finding whatever the table holds, so no stored row can ever suppress a warning. A nesting
pair is information, and plenty of them are deliberate: a panel that lists thirty forever is one nobody
opens twice, so acknowledging one is exactly right. An amount overlap is **arbitrary, not undefined** —
the ordering does settle it, because its last terms (the amount span, then the rule id) break any tie the
same way every time, but neither term is answering the question of which rule ought to win. So the pair
stays listed until the conditions are refined: acknowledging it would leave the ledger categorized by an
arithmetic accident with the app pretending that was settled.

A dismissal is keyed by the finding's `key`, which carries the pair *and what makes it actionable* — for
a nesting pair, the redundancy verdict. So an acknowledged pair stays hidden through edits that do not
change the situation, and comes back when one does: a pair that becomes redundant re-raises the offer to
delete its surplus half. A dismissal whose pair later dissolves entirely simply stops matching anything,
which is why nothing prunes them.

App-managed rules (the money-movement Type rules) are excluded: their matchers and bounds are the app's,
so a finding naming one would name something the user cannot act on. Rules that cannot fire — trashed,
or targeting a deactivated category — are excluded for the same reason.

Cost, all of it on demand. The first two kinds are one pairwise pass over the eligible rules, ordered
cheapest-discriminator first (amount arithmetic, then scope identity, then the string work). The
co-match scan is a second pass shaped the other way round — see `_co_matching_pairs` for why pairwise
is not an option there — and is the expensive half: rules x rows, around a second on a ledger of ~20k
transactions and ~200 rules.
"""

from __future__ import annotations

import math
import sqlite3

from backend.services.account_groups import effective_account_id_sql
from backend.services.categorizer import (
    match_expr_clause_texts,
    normalize_clean_name,
    row_match_texts,
    rule_matches_row_prepared,
    rule_specificity_order_sql,
)

SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"

# Severity ranks the findings list: the ambiguous pairs the user has to settle come before the
# informational ones they only need to know about.
_SEVERITY_ORDER = {SEVERITY_WARNING: 0, SEVERITY_INFO: 1}

KIND_AMOUNT_OVERLAP = "amount_overlap"
KIND_AMOUNT_OVERLAP_BENIGN = "amount_overlap_benign"
KIND_MATCHER_NESTING = "matcher_nesting"
KIND_CO_MATCH = "matcher_co_match"
KIND_CO_MATCH_BENIGN = "matcher_co_match_benign"

# Which findings may be acknowledged. The line is not warning-vs-info, it is *does the winner change the
# ledger*: a pair whose two rules file identically can be waved through, because whichever one wins the
# row ends up the same. Where the winner does change the outcome and nothing meaningful picks it, the
# finding stays listed until the conditions are refined — the stable tiebreak settles it, but settling is
# not deciding. Enforced where findings are assembled rather than only in the panel, so a stored dismissal
# cannot hide a warning.
DISMISSIBLE_KINDS = (KIND_MATCHER_NESTING, KIND_AMOUNT_OVERLAP_BENIGN, KIND_CO_MATCH_BENIGN)

# A row matching more than this many rules contributes no pairs. The pair enumeration below is O(k^2) in
# that count, and a row drawing dozens of rules is itself the finding — reporting hundreds of pairs off it
# would bury the panel rather than inform it. Real ledgers sit far under: three is the most observed.
MAX_RULES_PER_ROW = 25


def _load_rules(conn: sqlite3.Connection) -> list[dict]:
    """The rules eligible to appear in a finding, carrying the matcher fields the comparisons read and the
    action fields `_actions_agree` reads. `account_id` resolves to the linked-group root, matching how a rule's account scope is
    evaluated everywhere else (`categorizer.rule_scope_account_sql`) — comparing raw ids would call two
    rules disjoint when a merge has since pointed them at the same account."""
    rows = conn.execute(
        f"""SELECT cr.id, cr.keyword, cr.match_expr, cr.match_source_text, cr.owner_id, cr.category_id,
                   {effective_account_id_sql("cr.account_id")} AS account_id,
                   cr.account_type, cr.amount_min, cr.amount_max, cr.debit_credit,
                   cr.clean_name, cr.is_recurring
            FROM   category_rule cr
            LEFT   JOIN category c ON c.id = cr.category_id
            WHERE  cr.deleted_at IS NULL AND cr.is_managed = 0
              AND  (cr.category_id IS NULL OR c.is_active = 1)"""
    ).fetchall()
    return [dict(r) for r in rows]


def _precedence_rank(conn: sqlite3.Connection) -> dict[str, int]:
    """rule_id -> position in the engine's precedence order (0 = most specific). Taken from the shared
    ORDER BY rather than recomputed, so "which of these two wins" is answered by the contract itself."""
    rows = conn.execute(
        f"""SELECT id FROM category_rule
            WHERE  deleted_at IS NULL
            ORDER  BY {rule_specificity_order_sql("")}"""
    ).fetchall()
    return {row["id"]: i for i, row in enumerate(rows)}


def _effective_account_types(conn: sqlite3.Connection) -> dict[str, str | None]:
    """Effective account id -> its type, for the one scope pairing that needs a lookup: a rule pinned to
    an account and a rule scoped to an account *type* co-match only if that account is of that type."""
    rows = conn.execute(
        """SELECT COALESCE(a.parent_account_id, a.id) AS eff_id, COALESCE(p.type, a.type) AS eff_type
           FROM   account a LEFT JOIN account p ON p.id = a.parent_account_id"""
    ).fetchall()
    return {row["eff_id"]: row["eff_type"] for row in rows}


def _matcher_texts(rule: dict) -> tuple[str, ...]:
    """A rule's merchant matcher as its canonical clause texts — one entry for a plain keyword, several
    for an AND matcher. Sorted, because an AND matcher is order-independent."""
    texts = match_expr_clause_texts(rule["match_expr"])
    if texts is None:
        keyword = str(rule["keyword"] or "").strip().lower()
        texts = [keyword] if keyword else []
    return tuple(sorted(t for t in texts if t))


def _amount_range(rule: dict) -> tuple[float, float]:
    """A rule's amount window as a closed interval. Bounds are compared against |amount|, so an absent
    lower bound is exactly 0 rather than an approximation; an absent upper bound is genuinely open."""
    low = rule["amount_min"]
    high = rule["amount_max"]
    return (0.0 if low is None else float(low), math.inf if high is None else float(high))


def _ranges_intersect(a: tuple[float, float], b: tuple[float, float]) -> bool:
    """Both bounds are inclusive (`categorizer._amount_matches` rejects only `< min` and `> max`), so
    two ranges meeting at a single value really do both claim a charge at exactly that value. Capping
    one rule at the other's floor — the obvious hand-fix — therefore leaves a one-value overlap, and it
    is reported rather than waved through: a rule set split at a round number is one whose bills land on
    that number. The finding names the single amount instead of a band, which is the honest reading."""
    return a[0] <= b[1] and b[0] <= a[1]


def _range_contains(outer: tuple[float, float], inner: tuple[float, float]) -> bool:
    return outer[0] <= inner[0] and outer[1] >= inner[1]


def _directions_compatible(a: dict, b: dict) -> bool:
    left = str(a["debit_credit"] or "both")
    right = str(b["debit_credit"] or "both")
    return left == "both" or right == "both" or left == right


def _scopes_can_share_a_row(a: dict, b: dict, account_types: dict[str, str | None]) -> bool:
    """Could one transaction satisfy both rules' owner and account scopes? A rule with no scope on an
    axis is unconstrained there, so it stays compatible with anything."""
    if a["owner_id"] is not None and b["owner_id"] is not None and a["owner_id"] != b["owner_id"]:
        return False
    if a["account_id"] is not None and b["account_id"] is not None and a["account_id"] != b["account_id"]:
        return False
    if a["account_type"] is not None and b["account_type"] is not None and a["account_type"] != b["account_type"]:
        return False
    if a["account_id"] is not None and b["account_type"] is not None:
        return account_types.get(a["account_id"]) == b["account_type"]
    if b["account_id"] is not None and a["account_type"] is not None:
        return account_types.get(b["account_id"]) == a["account_type"]
    return True


def _scopes_identical(a: dict, b: dict) -> bool:
    """Do the two rules tie on every precedence term above the amount span? That is what makes a range
    overlap unresolvable: with the scopes and the keyword equal, span is the only thing left deciding,
    and where neither range contains the other it decides nothing meaningful."""
    return (
        a["owner_id"] == b["owner_id"]
        and a["account_id"] == b["account_id"]
        and a["account_type"] == b["account_type"]
    )


def _texts_nest(outer: tuple[str, ...], inner: tuple[str, ...]) -> bool:
    """Does every clause of `outer` appear inside some clause of `inner`? That is the condition under
    which `inner` matches a subset of the rows `outer` does, and it covers all three forms the
    relationship takes: plain substring (`amazon` / `amazon prime`), clause superset (`{amazon}` /
    `{amazon, prime}`), and the mix of the two."""
    return all(any(clause in candidate for candidate in inner) for clause in outer)


def _rule_tag_ids(conn: sqlite3.Connection) -> dict[str, frozenset]:
    """rule_id -> its tag ids. Loaded in one query rather than per pair: tags are part of what a rule
    *does*, so `_actions_agree` cannot answer without them."""
    mapping: dict[str, set] = {}
    for row in conn.execute("SELECT rule_id, tag_id FROM rule_tag"):
        mapping.setdefault(row["rule_id"], set()).add(row["tag_id"])
    return {rule_id: frozenset(tags) for rule_id, tags in mapping.items()}


def _actions_agree(a: dict, b: dict, tags: dict[str, frozenset]) -> bool:
    """Would the ledger read the same whichever of these two rules won?

    This is the question that decides whether a competing pair is a problem at all. Two rules can fight
    over a row forever without it mattering, as long as they do the same thing to it — the commonest case
    being two spellings of one merchant filing to one category. Where that holds, the arbitrary winner is
    arbitrary about nothing, and the finding drops to information the user may acknowledge.

    Every effect a rule carries has to agree, not just the category: a rename, a tag or the recurring flag
    that only one side sets is a real difference in outcome. The comparison is deliberately strict — a
    pair that is *almost* identical is exactly the pair whose winner is worth knowing about.
    """
    if a["category_id"] != b["category_id"]:
        return False
    if normalize_clean_name(a["clean_name"]) != normalize_clean_name(b["clean_name"]):
        return False
    if bool(a["is_recurring"]) != bool(b["is_recurring"]):
        return False
    return tags.get(a["id"], frozenset()) == tags.get(b["id"], frozenset())


def _load_scan_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Every live row, newest first, carrying exactly the columns the shared rule matcher reads.

    Unwindowed, which is the deliberate exception to how the other ledger-reading check works. Range
    drift asks whether a *recent charge* was misfiled, so recency is the point; this asks whether two
    rules are ambiguous, which is a fact about the rule set rather than about this month. A pair that
    last collided years ago is still ambiguous today, and both rules are still there to fire on the next
    import that looks like it. Cost is in `_co_matching_pairs`.
    """
    return conn.execute(
        """
        SELECT t.id, t.date, t.amount, t.owner_id, t.merchant_name, t.display_name, t.raw_name,
               t.import_evidence_json,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               COALESCE(p.type, a.type)                    AS effective_account_type
        FROM   txn t
        JOIN   account a ON a.id = t.account_id
        LEFT   JOIN account p ON p.id = a.parent_account_id
        WHERE  t.trashed_at IS NULL AND t.is_pending = 0
        ORDER  BY t.date DESC
        """
    ).fetchall()


def _co_matching_pairs(conn: sqlite3.Connection, rules: list[dict]) -> dict[tuple[str, str], dict]:
    """`(rule_id, rule_id) -> {count, example row}` for every pair of rules some live transaction matches.

    **Row-major on purpose, and that is the whole performance design.** The obvious shape — take each
    candidate pair and look for a row they share — is unworkable here: almost no pair can be excluded from
    the rules alone, because most rules carry neither a scope nor an amount range, so a real rule set
    offers ~20k candidate pairs against ~19k rows. Matching every *rule* against every row once and
    reading the pairs off each row's match list instead is rules x rows, and it discovers the handful of
    pairs that genuinely co-match rather than testing a hypothesis about each of twenty thousand. The
    pairwise filters then run over that handful, as a post-filter.

    Each row's haystacks are derived once (`row_match_texts`) instead of once per rule, which is the
    difference between the scan costing seconds and costing a second. Source text is pulled only when some
    eligible rule asks for it, since that parses JSON per row.
    """
    want_source = any(rule["match_source_text"] for rule in rules)
    pairs: dict[tuple[str, str], dict] = {}
    for row in _load_scan_rows(conn):
        text, source_text_lc = row_match_texts(row, want_source_text=want_source)
        matched = [rule["id"] for rule in rules if rule_matches_row_prepared(rule, row, text, source_text_lc)]
        if len(matched) < 2 or len(matched) > MAX_RULES_PER_ROW:
            continue
        matched.sort()
        for index, first in enumerate(matched):
            for second in matched[index + 1:]:
                entry = pairs.get((first, second))
                if entry is None:
                    # Rows arrive newest first, so the example kept is the most recent collision — the one
                    # the user can still recognize.
                    pairs[(first, second)] = {"count": 1, "row": row}
                else:
                    entry["count"] += 1
    return pairs


def _co_match_findings(conn, rules: list[dict], texts: dict, rank, tags) -> list[dict]:
    """Pairs of rules that both match a real transaction without either matcher containing the other.

    The ambiguity the other two kinds cannot see. `amount_overlap` needs identical matcher text and
    `matcher_nesting` needs one matcher inside the other; two matchers that merely *co-occur* in one
    merchant name — different keywords picking up different parts of it — satisfy neither and were
    invisible. Precedence still settles them, on `LENGTH(keyword)`, but that term means "a longer
    substring matches a strict subset of the rows a shorter one does", and between matchers that do not
    nest there is no subset relation for it to be about. It decides, on nothing.

    Which is why this is the one check that cannot be answered from `category_rule` alone: whether two
    unrelated keywords ever land in one merchant name is a fact about the ledger.

    Three filters over what the scan found, and each drops a pair precedence resolves honestly:
    identical matchers belong to `amount_overlap`, nesting matchers to `matcher_nesting`, and a pair whose
    scopes differ is separated by scope — a term that *is* a refinement — before matcher length is read.
    """
    by_id = {rule["id"]: rule for rule in rules}
    findings = []
    for (first_id, second_id), evidence in _co_matching_pairs(conn, rules).items():
        first, second = by_id[first_id], by_id[second_id]
        texts_a, texts_b = texts[first_id], texts[second_id]
        if texts_a == texts_b:
            continue
        if _texts_nest(texts_a, texts_b) or _texts_nest(texts_b, texts_a):
            continue
        if not _scopes_identical(first, second):
            continue
        findings.append(
            _co_match_finding(first, second, evidence, _actions_agree(first, second, tags), rank)
        )
    return findings


def _co_match_finding(a: dict, b: dict, evidence: dict, benign: bool, rank) -> dict:
    """Two rules whose matchers overlap in no way a reader could predict, caught matching one real row.

    Listed winner first, because the one useful thing to say about such a pair is which of them is
    currently taking the rows. The key is built from the sorted ids rather than that order, so an edit
    elsewhere that flips the winner does not silently lapse an acknowledgement.
    """
    row = evidence["row"]
    winner = _winner(a["id"], b["id"], rank)
    other = b["id"] if winner == a["id"] else a["id"]
    kind = KIND_CO_MATCH_BENIGN if benign else KIND_CO_MATCH
    low, high = sorted((a["id"], b["id"]))
    return {
        "kind": kind,
        "severity": SEVERITY_INFO if benign else SEVERITY_WARNING,
        "key": f"{kind}:{low}:{high}",
        "rule_ids": [winner, other],
        "winner_rule_id": winner,
        # How often the pair has actually collided, and one row to look at. A pair that has met once is a
        # different thing from one that has met two hundred times, and the count is the only honest way to
        # say which this is.
        "txn_count": evidence["count"],
        "txn_id": row["id"],
        "txn_date": row["date"],
        "txn_name": row["display_name"] or row["merchant_name"] or row["raw_name"],
        "amount": round(float(row["amount"] or 0.0), 2),
        # Most-collided first within the section: the pair touching two hundred rows is the one worth
        # opening, and it is not necessarily the one with the longest matcher.
        "sort_width": -evidence["count"],
        "sort_label": "+".join(_matcher_texts(a)),
    }


def find_rule_overlaps(conn: sqlite3.Connection, *, include_dismissed: bool = False) -> dict:
    """Every pair of rules that competes for the same transactions, as
    `{count, counts, dismissed_count, findings}`.

    A finding names its two rules by id (`rule_ids`, broader first) and the rule the precedence order
    currently gives the contested rows to. Nothing here mutates a rule or proposes a specific edit: an
    overlap is a modelling ambiguity, and inventing a tiebreak would dress a coin flip as a decision.

    Dismissed findings are filtered out unless `include_dismissed`, in which case they come back carrying
    `dismissed: True` so the panel can show them as the acknowledged set and offer to restore one.
    """
    rules = _load_rules(conn)
    if len(rules) < 2:
        return {"count": 0, "counts": {}, "dismissed_count": 0, "findings": []}

    account_types = _effective_account_types(conn)
    rank = _precedence_rank(conn)
    tags = _rule_tag_ids(conn)
    texts = {rule["id"]: _matcher_texts(rule) for rule in rules}
    ranges = {rule["id"]: _amount_range(rule) for rule in rules}
    # A rule with no matcher text can never fire, and would otherwise nest into every other rule (the
    # empty clause list makes `_texts_nest` vacuously true).
    rules = [rule for rule in rules if texts[rule["id"]]]

    findings: list[dict] = []
    for index, first in enumerate(rules):
        for second in rules[index + 1:]:
            range_a, range_b = ranges[first["id"]], ranges[second["id"]]
            if not _ranges_intersect(range_a, range_b):
                continue
            if not _directions_compatible(first, second):
                continue
            if not _scopes_can_share_a_row(first, second, account_types):
                continue

            texts_a, texts_b = texts[first["id"]], texts[second["id"]]
            if texts_a == texts_b:
                if not _scopes_identical(first, second):
                    continue
                if _range_contains(range_a, range_b) or _range_contains(range_b, range_a):
                    continue
                findings.append(
                    _amount_overlap_finding(
                        first, second, range_a, range_b, rank,
                        benign=_actions_agree(first, second, tags),
                    )
                )
            else:
                if _texts_nest(texts_a, texts_b):
                    findings.append(_nesting_finding(first, second, texts_a, rank))
                elif _texts_nest(texts_b, texts_a):
                    findings.append(_nesting_finding(second, first, texts_b, rank))

    findings.extend(_co_match_findings(conn, rules, texts, rank, tags))

    # Warnings first, then the broadest matcher, so the rules reaching furthest sit at the top of the
    # informational section where they are worth a look.
    findings.sort(key=lambda f: (_SEVERITY_ORDER[f["severity"]], f["sort_width"], f["sort_label"]))
    dismissed = dismissed_keys(conn)
    open_findings = []
    dismissed_count = 0
    counts: dict[str, int] = {}
    for finding in findings:
        del finding["sort_width"]
        del finding["sort_label"]
        finding["dismissible"] = finding["kind"] in DISMISSIBLE_KINDS
        is_dismissed = finding["dismissible"] and finding["key"] in dismissed
        if is_dismissed:
            dismissed_count += 1
            if not include_dismissed:
                continue
            finding["dismissed"] = True
        else:
            finding["dismissed"] = False
            # Counts describe the open work, so a dismissed finding never contributes to a section's
            # total even while it is being shown.
            counts[finding["kind"]] = counts.get(finding["kind"], 0) + 1
        open_findings.append(finding)
    return {
        "count": sum(counts.values()),
        "counts": counts,
        "dismissed_count": dismissed_count,
        "findings": open_findings,
    }


# --- Dismissal ------------------------------------------------------------------------------------
# The only durable state this module has. Keyed by the finding's fingerprint rather than by a rule id,
# so that acknowledging a pair does not also acknowledge a materially different situation those same two
# rules fall into later. Shared rather than per-user, like the recurring signals' dismissals: saying a
# pair of rules is fine is curation of the rule set, not a UI preference.

def dismissed_keys(conn: sqlite3.Connection) -> set[str]:
    return {r["finding_key"] for r in conn.execute("SELECT finding_key FROM rule_overlap_dismissal")}


def dismiss_finding(conn: sqlite3.Connection, key: str, kind: str) -> None:
    """Raises ValueError for a kind that may not be acknowledged, so the refusal lives with the rule
    rather than only in the panel that happens not to offer the button."""
    if kind not in DISMISSIBLE_KINDS:
        raise ValueError(f"findings of kind '{kind}' cannot be dismissed")
    conn.execute(
        """
        INSERT INTO rule_overlap_dismissal (finding_key, kind, dismissed_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(finding_key) DO UPDATE SET kind = excluded.kind, dismissed_at = excluded.dismissed_at
        """,
        (key, kind),
    )


def restore_finding(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM rule_overlap_dismissal WHERE finding_key = ?", (key,))


def _winner(first_id: str, second_id: str, rank: dict[str, int]) -> str:
    return first_id if rank.get(first_id, 0) <= rank.get(second_id, 0) else second_id


def _amount_overlap_finding(a: dict, b: dict, range_a, range_b, rank, *, benign: bool) -> dict:
    """The pair is listed lower range first, which is the order the two read in as a number line.

    `benign` splits the kind rather than only the severity, because dismissibility is decided by kind —
    and it belongs in the key, so a pair acknowledged while its two rules filed identically comes back
    the moment one of them stops doing so.
    """
    low, high = (a, b) if range_a[0] <= range_b[0] else (b, a)
    band_low = max(range_a[0], range_b[0])
    band_high = min(range_a[1], range_b[1])
    label = "+".join(_matcher_texts(a))
    kind = KIND_AMOUNT_OVERLAP_BENIGN if benign else KIND_AMOUNT_OVERLAP
    return {
        "kind": kind,
        "severity": SEVERITY_INFO if benign else SEVERITY_WARNING,
        "key": f"{kind}:{low['id']}:{high['id']}",
        "rule_ids": [low["id"], high["id"]],
        # The band both rules claim — what makes the finding concrete rather than a statement about
        # bounds. Always finite: two ranges that are both open at the top contain one another, and
        # containment is excluded above.
        "overlap_min": round(band_low, 2),
        "overlap_max": round(band_high, 2),
        "winner_rule_id": _winner(a["id"], b["id"], rank),
        "sort_width": 0,
        "sort_label": label,
    }


def _narrower_is_redundant(broader: dict, narrower: dict) -> bool:
    """Does the narrower rule add nothing to *categorization*, so that deleting it would leave every row
    it owns filed exactly as it is now?

    Two conditions, and the second is the one that is easy to miss. Both rules must assign the **same
    category** — otherwise the narrow rule is the whole reason those rows are filed where they are. And
    their **scopes must be identical**, because text nesting alone does not make the broader rule a
    superset: an owner-scoped `aji` rule does not reach another owner's rows, so a global `aji restaurant`
    rule is what categorizes those, and removing it would strand them.

    Note the deliberate limit: this is about the *category*. A rename or a tag that only the narrow rule
    carries is lost with it, and one that only the broad rule carries starts applying to rows it did not
    reach before. Neither shows up here — the panel reads that difference off the rules themselves and
    says so, rather than this flag quietly meaning "identical in every respect".
    """
    if broader["category_id"] is None or broader["category_id"] != narrower["category_id"]:
        return False
    return (
        broader["owner_id"] == narrower["owner_id"]
        and broader["account_id"] == narrower["account_id"]
        and broader["account_type"] == narrower["account_type"]
        and str(broader["debit_credit"] or "both") == str(narrower["debit_credit"] or "both")
    )


def _nesting_finding(broader: dict, narrower: dict, broader_texts: tuple[str, ...], rank) -> dict:
    """Listed broader matcher first: the finding reads as "this wide rule also catches what that
    narrow one is for"."""
    redundant = _narrower_is_redundant(broader, narrower)
    return {
        "kind": "matcher_nesting",
        "severity": SEVERITY_INFO,
        # The redundancy verdict is part of the key, because it is what a dismissal is *about*: a pair
        # acknowledged while its narrow half was doing real work comes back if that stops being true and
        # the half becomes deletable, which the user has never been asked about.
        "key": f"matcher_nesting:{broader['id']}:{narrower['id']}:{'r' if redundant else 'n'}",
        "rule_ids": [broader["id"], narrower["id"]],
        "winner_rule_id": _winner(broader["id"], narrower["id"], rank),
        # The removable one, when it is removable: the narrow rule is the redundant half of a nesting
        # pair, never the broad one, whose deletion would strand every row the narrow matcher misses.
        "narrower_is_redundant": redundant,
        "sort_width": sum(len(text) for text in broader_texts),
        "sort_label": "+".join(broader_texts),
    }
