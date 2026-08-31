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

- **`matcher_nesting` (info).** One rule's merchant matcher matches a strict subset of the other's rows
  (`amazon` and `amazon prime`). Nothing is wrong and nothing is ambiguous — this is reported for two
  reasons. The winner is not always the one a reader expects, since keyword length only decides *after*
  scope, so an owner-scoped `amazon` rule beats a global `amazon prime` rule on that owner's rows. And
  where both rules file to the same category under the same scope, the narrow one is **redundant** —
  `narrower_is_redundant` marks that, and it is the pair the user can simply delete half of.

The action each kind carries follows from that split, and it is the reverse of what it first looks like.
The *ambiguous* pair offers no removal: the answer there is to refine the conditions until the rules are
unambiguous, and deleting one is picking a side rather than fixing the model. The *nesting* pair does,
because a rule that adds nothing to the categorization is simply surplus.

The two kinds cannot collide: `amount_overlap` requires identical matcher text, `matcher_nesting`
requires strictly different matcher text.

**Which rule wins is read from the engine's own ordering rather than re-decided here.** The rule ids are
pulled once in precedence order and compared by rank, so this module cannot drift from what the import
will actually do — the same reason the ordering lives in one function.

**A nesting finding can be dismissed; an amount overlap cannot.** That asymmetry is the whole policy and
it is not a UI preference — `DISMISSIBLE_KINDS` decides it here, and the filter below refuses to hide a
non-dismissible finding whatever the table holds, so no stored row can ever suppress a warning. A nesting
pair is information, and plenty of them are deliberate: a panel that lists thirty forever is one nobody
opens twice, so acknowledging one is exactly right. An amount overlap is **nondeterminism** — nothing
decides which of the two rules categorizes the charge — and it stays listed until the conditions are
refined, because acknowledging it would leave the ledger being categorized by an arithmetic accident with
the app pretending that was settled.

A dismissal is keyed by the finding's `key`, which carries the pair *and what makes it actionable* — for
a nesting pair, the redundancy verdict. So an acknowledged pair stays hidden through edits that do not
change the situation, and comes back when one does: a pair that becomes redundant re-raises the offer to
delete its surplus half. A dismissal whose pair later dissolves entirely simply stops matching anything,
which is why nothing prunes them.

App-managed rules (the money-movement Type rules) are excluded: their matchers and bounds are the app's,
so a finding naming one would name something the user cannot act on. Rules that cannot fire — trashed,
or targeting a deactivated category — are excluded for the same reason.

Cost is one pairwise pass over the eligible rules, run only when the user asks for it. Rule sets are
bounded by hand-authoring, and the per-pair tests are ordered cheapest-discriminator first (amount
arithmetic, then scope identity, then the string work).
"""

from __future__ import annotations

import math
import sqlite3

from backend.services.account_groups import effective_account_id_sql
from backend.services.categorizer import match_expr_clause_texts, rule_specificity_order_sql

SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"

# Severity ranks the findings list: the ambiguous pairs the user has to settle come before the
# informational ones they only need to know about.
_SEVERITY_ORDER = {SEVERITY_WARNING: 0, SEVERITY_INFO: 1}

# Which findings may be acknowledged. Only the informational kind: an `amount_overlap` is a pair of rules
# with no deterministic winner, so it is not the sort of thing a user can be right about waving through —
# it stays listed until the conditions are refined. Enforced where findings are assembled rather than only
# in the panel, so a stored dismissal cannot hide a warning.
DISMISSIBLE_KINDS = ("matcher_nesting",)


def _load_rules(conn: sqlite3.Connection) -> list[dict]:
    """The rules eligible to appear in a finding, carrying exactly the matcher fields the comparisons
    read. `account_id` resolves to the linked-group root, matching how a rule's account scope is
    evaluated everywhere else (`categorizer.rule_scope_account_sql`) — comparing raw ids would call two
    rules disjoint when a merge has since pointed them at the same account."""
    rows = conn.execute(
        f"""SELECT cr.id, cr.keyword, cr.match_expr, cr.match_source_text, cr.owner_id, cr.category_id,
                   {effective_account_id_sql("cr.account_id")} AS account_id,
                   cr.account_type, cr.amount_min, cr.amount_max, cr.debit_credit
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
                findings.append(_amount_overlap_finding(first, second, range_a, range_b, rank))
            else:
                if _texts_nest(texts_a, texts_b):
                    findings.append(_nesting_finding(first, second, texts_a, rank))
                elif _texts_nest(texts_b, texts_a):
                    findings.append(_nesting_finding(second, first, texts_b, rank))

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


def _amount_overlap_finding(a: dict, b: dict, range_a, range_b, rank) -> dict:
    """The pair is listed lower range first, which is the order the two read in as a number line."""
    low, high = (a, b) if range_a[0] <= range_b[0] else (b, a)
    band_low = max(range_a[0], range_b[0])
    band_high = min(range_a[1], range_b[1])
    label = "+".join(_matcher_texts(a))
    return {
        "kind": "amount_overlap",
        "severity": SEVERITY_WARNING,
        "key": f"amount_overlap:{low['id']}:{high['id']}",
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
