# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Duplicate detection for transactions — hard-reject (blocked at import) and soft-flag
(imported with a suspect pointer for user review).

The rules sort into confidence tiers, but among the HARD-REJECT rules the chain is evaluated
coverage-first, then exact-hash — deliberately NOT in confidence order. That ordering changes only
the *label*, never the verdict: a row can both fall in an already-imported date range and exactly
match an existing row, and both outcomes are hard-rejects, so which rule "wins" just decides the
reason shown in the duplicate report. Coverage is the more useful reason — a re-imported range is one
uniform story, whereas which individual rows happen to be exact content-hash matches is an incidental
artifact of whether two sources formatted the merchant string identically, and singling those out as
"exact match" splits a homogeneous re-import into a confusing "why are these special?" subset. Exact-
hash still hard-rejects on its own for any row OUTSIDE a covered range, so it catches exactly what it
did before; it just no longer claims the label when coverage already explains the row.

Hard-reject rules (blocked at import; the row never enters the ledger, and the rejection is recorded
in `import_batch_duplicate` so it can resurface if the rejecting batch is later undone), in evaluation
order:

  1-2. Coverage window — same-source (same csv_value, unconditional within the window), then in-scope
       (same linked group, different csv_value). The in-scope rule fires only when the receiving
       account already had prior history in the matching scope, or the import explicitly declared it
       an alias; a brand-new sibling that only inherits its linked-group's coverage doesn't satisfy
       the precondition and falls through.
  3-4. Exact content-hash match — same account, then same linked group. Unconditional (no prior-
       history precondition): same date+amount+payee is the same transaction regardless of which
       account it lands on. Reached only for rows not already inside a covered range.
  5.   Terminal-day reconciliation, then
  6.   a fuzzy-text fallback (medium confidence).

Soft-flag (imported with a suspect pointer for review): the cross-SOURCE match by (date-window,
amount, source text) comes from the post-batch sweep (`mark_import_suspects`), not the ladder above; the
user resolves it with Keep (assert the two accounts are distinct) or Reject (confirm a duplicate). The
text side compares the UNION of each row's captured texts (`source_match_texts`: merchant_name, raw_name,
and the `import_evidence_json` description + extra fields), not one normalized payee — because two
sources for the same charge often store the rawest bank descriptor in different fields (a data-connection
row in `raw_name`; a CSV that cleaned `raw_name` keeps the original in an "Original Statement" evidence
field). A byte-identical overlap flags `'cross_account'` (high confidence — auto-confirmed on merge); a
near-miss above `CROSS_ACCOUNT_FUZZY_RATIO` flags `'cross_account_fuzzy'`; two shared distinctive tokens
flag `'cross_account_weak'`. The latter two are `REVIEW_ONLY_SOFT_FLAG_REASONS` and are never auto-
confirmed (so a slightly-different spelling is surfaced, not silently trashed).

The union has one carve-out (`row_match_texts` / `RowMatchTexts`): when BOTH rows carry precise text —
`raw_name` or evidence, as against the cleaned `merchant_name` — the tier is decided on the precise
half alone, and the payee name can then reach no higher than `'cross_account_weak'`. Without it a chain's
branches all clean to one merchant string, so two rows naming different branches intersect on the payee
and come back byte-identical, i.e. the top tier (and auto-confirm-on-merge) asserted from the one field
that cannot tell them apart. The ladder's own hard-reject rung deliberately keeps the plain union — see
`classify_source_text_relation` for the measurement behind that split.

**What the sweep pairs, and why it is not "cross-account".** The premise has always been *two independent
sources describing one charge* — a single source does not report a charge twice, so two rows from one
source are a legitimate repeat and are never paired. Landing on two different accounts used to imply
that, and still counts on its own. It stopped being NECESSARY once two data connections could each map
`existing` onto ONE local account: the same charge then arrives twice on that account, worded differently
by each provider, and an account-difference test cannot see it. So the pairing condition is a *differing
origin* — a different connection, or a different file when neither row came from a connection — with
"different accounts" retained as the other sufficient arm. Measured on a real ledger, the origin gate is
what makes this safe: same-account cross-source candidates numbered in the single digits, against
thousands of same-account same-source repeats it correctly refuses to pair. Manual rows carry no origin
and so never pair within one account. A same-account exact match is auto-confirmed by
`promote_in_group_suspects_to_confirmed` (they trivially share an effective root) under its own
`AUTO_CROSS_SOURCE_RESOLVED_BY` marker, so the user is not asked about it.

Check-number discriminator (`are_distinct_checks`): two genuinely different checks can share
date+amount+description (often just "Check"), so they collide on the content hash AND on the
terminal-day rule's amount fallback. Wherever a match is keyed on the hash/amount — the exact-hash
rules and the terminal-day matcher — a match between rows carrying explicit, *different* check
numbers (folded into the merchant as "Check #<n>" at import) is discarded as a false positive, so
the row falls through to the lower-confidence rules (review) instead of being silently rejected. It
is conservative — the number must be present on both sides — so rows predating check capture dedupe
unchanged, and it only runs once a rule has already found a candidate (no cost on the common path).

This module owns the whole of duplicate detection — the rule ladder, the source-text comparison
primitives, the coverage/terminal-day candidate lookups, and `build_dedupe_context`, which assembles
them all in a handful of queries. It is deliberately **ingestion-path-neutral**: a CSV import and a
data-source sync are two ways of receiving the same kind of thing, so both build a context and run
the same ladder. Nothing here knows what a CSV is — a "source value" is just whatever label a source
uses to name an account (a CSV's account column, a connection's provider account label), and the
caller supplies the mapping from those labels to local accounts.

Triggers:
  * Ingest-time per row (`evaluate_duplicate` via `DedupeContext`) — assigns hard-reject /
    soft-flag / passthrough verdicts as each row is inserted.
  * Post-batch sweep (`mark_import_suspects`) — runs against the just-inserted batch for the
    cross-account soft-flag case. Skips pairs the user has previously declared distinct via
    `account_pair_distinct`; that table is what keeps the report non-noisy after the user has
    reviewed each pair once.
  * Account merge AND import-into-an-already-merged-group (`promote_in_group_suspects_to_confirmed`)
    — when two accounts merge into one linked group, OR a batch imports rows whose just-flagged
    cross-account match lands on an account already merged with the receiving account, any such
    soft-flag between same-effective-root accounts gets promoted to
    `rejection_reason='duplicate_confirmed'` (tagged `dedupe_resolved_by='auto_merge'`). The
    import-finalize call (right after `mark_import_suspects`) is what makes import order-independent
    with merge order. Also
    performs a same-batch transitivity clear: a sibling row in the same CSV as a promoted row
    whose own suspect points at the *same canonical row* has its suspect flag cleared, because
    same-CSV-different-account asserts distinct, and the merge identifies the promoted row with
    that canonical (a sibling pointing at a *different* row in the merged group stays flagged).
  * Account detach (`restore_auto_merged_after_detach`) — reverses auto_merge promotions whose
    account pair straddles the detach boundary (one endpoint on the detaching account, the other
    in the remaining group), in either orientation: the trashed suspect row may sit on the
    detaching account OR on the account that stays (when the imported file holding the suspect was
    on the staying account and the row it duplicated was on the detaching account). Rows the user
    explicitly Rejected (dedupe_resolved_by='user') are left alone.

The cross-account soft-flag SQL joins on `(date, ROUND(amount, 2), normalized payee)`, indexed
via `idx_txn_date_amount`, so cost stays proportional to candidate pairs rather than N*N.

The user-asserted "these two accounts are distinct" model (see `account_pair_distinct` table
and `resolve_suspect(action='keep')`) replaced an older proxy that fired only when the
receiving account was brand new to the database. The new model keeps detection running for
every cross-batch pair forever, with the per-pair table acting as the user's accumulated
filter of "I've already decided these are different accounts."
"""

import difflib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from typing import Callable, Iterable, NamedTuple, Optional

from backend.services.categorizer import source_match_text_from_json
from backend.services.connection_mapping import provider_account_label
from backend.services.import_evidence import evidence_field_feeds_text_match
from backend.text_utils import sanitize_rule_merchant_text


_CHECK_NUMBER_RE = re.compile(r"#(\d+)")


def explicit_check_number(merchant_name: Optional[str]) -> Optional[str]:
    """The check number folded into a merchant like 'Check #1042' at import time, or None."""
    if not merchant_name:
        return None
    match = _CHECK_NUMBER_RE.search(str(merchant_name))
    return match.group(1) if match else None


def are_distinct_checks(merchant_a: Optional[str], merchant_b: Optional[str]) -> bool:
    """True only when both names carry an explicit, DIFFERENT check number.

    Two genuinely different checks can share date+amount+description (often just "Check"), so a
    content-hash match — or a terminal-day amount match — between them is a false positive. This is
    the discriminator that rescues that case. Deliberately conservative: a number must be present on
    BOTH sides, so absence never implies "different" and rows predating check-number capture keep
    deduping exactly as before. Cheap, and only consulted once a rule has already found a match.
    """
    left = explicit_check_number(merchant_a)
    right = explicit_check_number(merchant_b)
    return bool(left and right and left != right)


# Cross-account duplicate matching tolerates a small date gap: the same charge often carries a
# transaction date from one source and a (later) posted date from another, and settlement skips
# weekends/holidays, so a Friday purchase can post the following Monday/Tuesday. ±3 calendar days absorbs
# that common lag without a brittle business-day/holiday calendar. Widening it only trades a few more
# same-amount coincidences into review; the exact amount + provider-name + cross-account anchor keeps that
# low, and matches are paired closest-date-first so genuine same-day twins bind before near-date ones.
#
# Set from measurement, not intuition. Pairing one real ledger's provider rows against their CSV
# counterparts by amount and inspecting each by hand put genuine matches at +1 (Netflix), +3 (CVS, twice),
# +4 (Whole Foods) and +6 (a truncated "Rancatore" spelling) — so ±3 demonstrably missed real duplicates.
# The false positives at those distances (two distinct same-amount Zelle receipts) are rejected by the
# TEXT tiers regardless of window, which is the point: text is the discriminator here and the date window
# is the weak one, so widening it is cheap. Capturing `authorized_date` is the real fix — most of that
# tail collapses to gap 0 once both dates are known — and this stays the fallback for sources that
# publish only one date. Those pairs and the Zelle control are kept as a fixture in
# backend/tests/test_cross_account_window_evidence.py, which asserts the +4/+6 pairs are missed at 3 —
# so narrowing this has to answer a failing test rather than only this comment.
CROSS_ACCOUNT_DATE_WINDOW_DAYS = 7

# The cross-account matcher does not key on a single normalized payee string. Two sources for the same
# real-world charge often store the rawest bank descriptor in DIFFERENT fields — a data-connection (Plaid)
# row carries it in `raw_name`, while a CSV importer may overwrite `raw_name` with a cleaned merchant
# column and keep the true statement in `import_evidence_json` (an "Original Statement" extra). Keying on
# a preferred field (`merchant_name`, then `raw_name`) therefore compared a cleaned name on one side
# against a raw statement on the other and missed the match (the motivating case: a truncated "…Coffe"
# from Plaid vs. the full "…Coffee" a CSV put in raw_name, with the identical "…Coffe" only in the CSV's
# evidence). We instead compare the UNION of every captured text per row (see `source_match_texts`) so a
# byte-identical descriptor matches wherever each source parked it, and fall back to a similarity check
# for near-miss spellings/truncations. `display_name` stays out of the match — a user rename or a rule's
# clean_name diverges `display_name` between two sources of the SAME charge (e.g. one side renamed to
# "Mighty Squirrel Brewery" while both keep the raw provider name "Brewery"), which would hide the
# duplicate; the review UI still labels rows by display name, only the *match* ignores it.

# Character-similarity floor for the FUZZY tier: a pair sharing amount + date-window whose most-original
# texts are close but not identical is flagged for REVIEW only (never auto-removed, and never auto-
# confirmed on merge). 0.9 keeps it to near-miss spellings/truncations rather than merely similar
# merchants; the exact tier below it handles byte-identical descriptors.
CROSS_ACCOUNT_FUZZY_RATIO = 0.9


def _placeholders(values) -> str:
    return ",".join("?" * len(values))


def _account_label_sql(alias: str) -> str:
    """An account's label in a duplicate report: its display name plus the masked suffix.

    One expression, used everywhere a report names an account, because the two sides of a match are read
    against each other. The hard-reject incoming side shows the *source's* own label for the account
    (`provider_account_label`, "Rewards Card ···4417"), which is not ours to restate — so the matched
    side has to reach the same string by its own route, or one account renders as two different-looking
    ones directly beside itself. The mask is what does that, and it is worth having regardless: it is the
    thing that separates two cards a user has named alike.
    """
    return (f"COALESCE(NULLIF({alias}.display_name, ''), {alias}.name)"
            f" || COALESCE(' ···' || NULLIF({alias}.mask, ''), '')")


# A payment processor stamps its own tag on the front of the descriptor it forwards ("<tag> *MERCHANT"),
# and whether a given source passes that tag through is a property of the source, not of the charge — so
# one side carrying it while the other does not is the single most common reason two records of the same
# charge are not byte-identical. Matched as a shape (a short leading token followed by `*`) rather than a
# list of processor names: measured pair-for-pair against a hand-written name list over a real ledger the
# two produce identical results, and the shape also covers processors not yet seen.
#
# Deliberately NOT shared with `sanitize_rule_merchant_text`, which strips reference digits off the other
# end of the string and is also the rules engine's primitive. Rule text is authored by the user and
# matched unanchored, so a typed tag is a deliberate choice there; dedupe reads whatever pre-processing a
# source happened to apply, which the user never chose. Same-looking cleanup, different question.
_PROCESSOR_TAG_RE = re.compile(r"^[a-z0-9]{2,6}\s*\*\s*")

# Below this, what survives the strip is too short to identify a merchant, so no variant is offered
# rather than one that would collide with unrelated rows on a generic word.
_MIN_TEXT_AFTER_PROCESSOR_TAG = 4


def _normalize_match_text(value) -> str:
    """Lowercase, collapse internal whitespace, strip. The shared normalization both sides of a cross-
    account text comparison pass through — a LOWER(TRIM(...)) that also folds runs of whitespace so two
    sources differing only in spacing still line up."""
    return " ".join(str(value or "").split()).lower()


def _processor_tag_stripped(text: str) -> Optional[str]:
    """The text without its leading processor tag, or None if it carries none (or too little would be
    left to identify anything).

    Offered as an ADDITIONAL text to match on rather than replacing the original, because sources
    disagree about the tag in two directions: one may drop it entirely ("MERCHANT") while another keeps
    it either punctuated ("SQ *MERCHANT") or bare ("SQ MERCHANT"). Stripping in place matches the first
    pair but pulls the second apart — the bare form has no `*` to strip, so it would be compared against
    a stripped counterpart it no longer resembles. Keeping both forms matches whichever the other side
    happens to hold.
    """
    stripped = _PROCESSOR_TAG_RE.sub("", text)
    if stripped == text or len(stripped) < _MIN_TEXT_AFTER_PROCESSOR_TAG:
        return None
    return stripped


def source_match_texts(merchant_name, raw_name, evidence_json) -> set[str]:
    """The set of normalized "as the source delivered it" texts a row can be matched on for cross-
    account duplicate detection: `merchant_name`, `raw_name`, and — from `import_evidence_json` — the
    normalized description slot plus each **descriptive** `extra_text_fields` value (an "Original
    Statement", a counterparty, …).

    `evidence_json` is either the stored JSON string or an already-parsed dict: a row still in flight
    (an import's `txn_payload`, a stored `txn_payload_json` blob) carries it as a dict, and making
    callers re-serialize just to have it parsed back is waste in the middle of a per-row loop.

    Comparing the union (rather than a single preferred field) is what lets a byte-identical bank
    descriptor match across sources that stored it in different columns. `display_name` is deliberately
    excluded — a user rename or a rule's clean_name must neither create nor hide a match. Empty strings
    are dropped, so a nameless money-movement leg contributes nothing and never text-matches.

    Categorical fields are excluded via `evidence_field_feeds_text_match`: they are values two
    unrelated rows share by coincidence (a date, a check number, a transaction type), so admitting
    them turns the *strong* half of the cross-account test into a restatement of the weak half. This
    function used to admit every captured field, which made every pair of synced rows sharing an
    amount and an `authorized_date` an exact-tier match — see services/import_evidence.py.
    """
    texts: set[str] = set()
    for value in (merchant_name, raw_name):
        norm = _normalize_match_text(value)
        if norm:
            texts.add(norm)
    if evidence_json:
        # Parse inline (rather than importing categorizer.extract_source_match_text, which concatenates
        # into one haystack) because an EXACT per-field comparison needs the fields kept separate.
        if isinstance(evidence_json, dict):
            evidence = evidence_json
        else:
            try:
                evidence = json.loads(evidence_json)
            except (ValueError, TypeError):
                evidence = None
        if isinstance(evidence, dict):
            description = evidence.get("description")
            if isinstance(description, dict):
                norm = _normalize_match_text(description.get("value"))
                if norm:
                    texts.add(norm)
            for field_entry in (evidence.get("extra_text_fields") or []):
                if evidence_field_feeds_text_match(field_entry):
                    norm = _normalize_match_text(field_entry.get("value"))
                    if norm:
                        texts.add(norm)
    # A tagged descriptor is offered both as delivered and with the tag removed, so it lines up with a
    # source that dropped the tag and with one that kept it (see `_processor_tag_stripped`).
    texts.update(filter(None, (_processor_tag_stripped(text) for text in list(texts))))
    return texts


# Truncation limits are per-descriptor, not per-source — one charge in a real ledger carried 22-, 24- and
# 25-character forms at once, and both sides publish descriptors past 100 characters — so there is no
# source length to derive and compare. What identifies a truncation is the shape of the disagreement: the
# two texts agree from the first character and diverge only at the tail.
#
# The test is deliberately asymmetric — one string is a PREFIX OF the other, never "they share a long
# common prefix". Two distinct receipts from the same service differ only after a long shared run
# ("zelle payment to <name> <ref>"), and a common-prefix rule would merge them; a prefix-of rule cannot,
# because neither is a prefix of the other. That pair is the negative control in
# test_cross_account_window_evidence.py and is the reason this rule has the form it has.
_MAX_TRUNCATED_TAIL = 4       # a longer tail is a different descriptor, not a clipped one
_MIN_TRUNCATION_PREFIX = 12   # floor on what must already agree, in the spirit of `_duplicate_tokens_match`
_MIN_WORD_BOUNDARY_PREFIX = 20


def _is_truncation_of(shorter: str, longer: str) -> bool:
    """Whether `shorter` is `longer` with its tail clipped, rather than a shorter distinct descriptor.

    A cut that lands MID-WORD is the strong case: a length limit sliced through a word, which nothing
    else plausibly does. A cut on a word boundary is weaker — it also describes a source that simply
    carried extra trailing words ("<merchant>" vs "<merchant> <branch>") — so it has to clear a longer
    agreement before it counts.
    """
    if not longer.startswith(shorter) or shorter == longer:
        return False
    tail = longer[len(shorter):]
    if len(tail) > _MAX_TRUNCATED_TAIL or len(shorter) < _MIN_TRUNCATION_PREFIX:
        return False
    cut_is_mid_word = not tail.startswith(" ")
    return cut_is_mid_word or len(shorter) >= _MIN_WORD_BOUNDARY_PREFIX


def classify_text_match(texts_a: set[str], texts_b: set[str]) -> Optional[str]:
    """How two rows' `source_match_texts` sets relate:
        'exact' — some captured text is byte-identical across the two, or is the same text with one side
                  truncated (high confidence)
        'fuzzy' — no exact overlap, but a pair is >= CROSS_ACCOUNT_FUZZY_RATIO similar (near-miss)
        None    — neither.
    Empty sets never match. The fuzzy comparison is over the cross-product of the two (small) sets,
    taking the best ratio — an O(a*b) character diff that is cheap because each set holds a handful
    of short strings and the caller only reaches here for same-amount, same-date-window candidates.

    A truncation counts as exact rather than as a near-miss because the two texts do not actually
    disagree — one source simply stopped early. That tier is what auto-confirms once the two accounts are
    merged, and it is also the primary sort key when several candidates compete for the same row, so a
    clipped descriptor now binds to its twin ahead of a merely similar one.
    """
    if not texts_a or not texts_b:
        return None
    if texts_a & texts_b:
        return "exact"
    for a in texts_a:
        for b in texts_b:
            shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
            if _is_truncation_of(shorter, longer):
                return "exact"
    best = 0.0
    for a in texts_a:
        for b in texts_b:
            ratio = difflib.SequenceMatcher(None, a, b).ratio()
            if ratio > best:
                best = ratio
    return "fuzzy" if best >= CROSS_ACCOUNT_FUZZY_RATIO else None


# How many distinctive (non-generic) tokens two rows must share for the weakest review tier. Two is
# measured, not guessed: at one shared token a pair joined only by a survivor of
# `GENERIC_DUPLICATE_TEXT_TOKENS` ("general", "account") is admitted, which is noise; at two, the pairs
# that survive share a real counterparty word. This tier exists because character similarity is the wrong
# instrument when two sources bracket the same payee with different boilerplate — "WDRL-ACH <PAYEE> 599…"
# against "<PAYEE> Insurance Debitpmt" sits at ratio 0.57, nowhere near `CROSS_ACCOUNT_FUZZY_RATIO`,
# while sharing the two tokens that matter. It is review-only and never auto-confirmed.
_WEAK_SHARED_TOKEN_FLOOR = 2

# One place mapping a text relation to the soft-flag reason it records and to its precedence when several
# existing rows compete for one incoming row. Strongest binds first, so a byte-identical twin is never
# displaced by a merely similar one, and a weak-tier pair is only chosen when nothing better exists.
_TEXT_RELATION_REASONS = {
    "exact": "cross_account",
    "fuzzy": "cross_account_fuzzy",
    "weak":  "cross_account_weak",
}
_TEXT_RELATION_RANK = {"exact": 0, "fuzzy": 1, "weak": 2}

# The soft-flag tiers that are NEVER auto-confirmed — not on a merge, not on a same-account cross-source
# pairing. Both rest on similarity rather than on agreement, so the user resolves them or they stay.
REVIEW_ONLY_SOFT_FLAG_REASONS = ("cross_account_fuzzy", "cross_account_weak")

# `dedupe_resolved_by` for an exact cross-source match auto-confirmed between two rows on the SAME
# account. Deliberately not 'auto_merge': that marker means "a merge asserted this, and a detach should
# take it back", and there is no merge here to undo — the rows share one account outright.
AUTO_CROSS_SOURCE_RESOLVED_BY = "auto_cross_source"


class RowMatchTexts(NamedTuple):
    """A row's captured texts, split by how precisely they describe the transaction.

    `all` is every text (`source_match_texts`). `precise` drops the cleaned payee name, keeping only
    what the source actually delivered — `raw_name` and the descriptive evidence fields. The split
    exists because merging them loses the one distinction that matters when several same-amount
    candidates compete: a cleaned `merchant_name` collapses every branch of a chain to one string, so
    two rows can agree there byte-for-byte while their statement text positively disagrees.
    """
    all: frozenset
    precise: frozenset


def row_match_texts(merchant_name, raw_name, evidence_json) -> RowMatchTexts:
    """`source_match_texts` split into its precise and payee-level halves. See `RowMatchTexts`."""
    precise = source_match_texts(None, raw_name, evidence_json)
    return RowMatchTexts(
        all=frozenset(precise | source_match_texts(merchant_name, None, None)),
        precise=frozenset(precise),
    )


def _union_text_relation(texts_a: set[str], texts_b: set[str]) -> Optional[str]:
    """Best agreement anywhere across two rows' captured texts: `classify_text_match` plus a third,
    weakest tier — 'weak', no exact overlap and no near-miss, but at least
    `_WEAK_SHARED_TOKEN_FLOOR` distinctive tokens in common."""
    kind = classify_text_match(texts_a, texts_b)
    if kind is not None:
        return kind
    if not texts_a or not texts_b:
        return None
    tokens_a: set[str] = set()
    tokens_b: set[str] = set()
    for text in texts_a:
        tokens_a.update(tokenize_duplicate_match_text(text))
    for text in texts_b:
        tokens_b.update(tokenize_duplicate_match_text(text))
    shared = _count_fuzzy_token_overlap(sorted(tokens_a), sorted(tokens_b))
    return "weak" if shared >= _WEAK_SHARED_TOKEN_FLOOR else None


def classify_source_text_relation(a: RowMatchTexts, b: RowMatchTexts) -> Optional[str]:
    """How two rows' captured texts relate: 'exact' | 'fuzzy' | 'weak' | None.

    **When both rows carry precise text, the tier is decided there** — the cleaned payee name can
    then only ever produce 'weak'. Judging on the union instead lets the coarsest field win: a chain's
    every branch cleans to one merchant string, so "TST*<SHOP> - <BRANCH A>" and
    "TST*<SHOP> - <BRANCH B>" intersect on the payee and come back 'exact', which is the strongest tier
    asserted on the weakest evidence while the field that actually discriminates is ignored. Demoting
    them to 'weak' is not a hedge — same payee, different branch detail is *equally* consistent with one
    charge described twice and with two real charges at two branches, and 'weak' is precisely the tier
    that means "worth a look, never act on it unseen".

    Rows with no precise text on one side keep the union rule: a source that publishes only a cleaned
    name has nothing more precise to be judged on, and silence is not disagreement.

    Used by the soft-flag sweeps and by the coverage report's candidate tiering. Both reach here only
    for pairs already narrowed to the same amount inside a date window, so this is ranking evidence
    rather than holding back a flood. The ladder's hard-reject rung does NOT use this — see Rule 6,
    which scores `collect_duplicate_match_texts` with `score_duplicate_text_match`. Keeping that on the
    union is deliberate and measured: on a real ledger 32 of 45 recorded text-strategy rejects pair two
    sources that word a charge completely differently ("<PAYEE> Transfer" against
    "Send Money <PAYEE> <RECIPIENT>"), where the cleaned name is the only thing that legitimately binds
    them, and where same-date-and-amount already rules out the branch ambiguity above.
    """
    if a.precise and b.precise:
        precise_kind = classify_text_match(a.precise, b.precise)
        if precise_kind is not None:
            return precise_kind
        # The precise descriptors disagree. Anything the payee names still share caps out at 'weak'.
        return "weak" if _union_text_relation(a.all, b.all) else None
    return _union_text_relation(a.all, b.all)


def _parse_iso_date(value):
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _date_distance_days(a, b) -> int:
    """Absolute day gap between two ISO dates; a large sentinel when either is unparseable so a
    parseable pair always sorts ahead of it in closest-date selection."""
    da, db = _parse_iso_date(a), _parse_iso_date(b)
    if da is None or db is None:
        return 10 ** 6
    return abs((da - db).days)


# ---------------------------------------------------------------------------
# Source-text comparison primitives
#
# The medium-confidence text rule (Rule 6) and the terminal-day matcher compare what two sources
# *called* a transaction. These live here rather than in the import router because both ingestion
# paths — CSV import and data-source sync — run the same ladder, and the dedupe service cannot
# import the router without a cycle.
# ---------------------------------------------------------------------------

# Tokens that appear in so many bank descriptors that sharing one carries no evidence two rows are
# the same transaction. Dropped from the token-overlap signal (though still present in the raw text
# a similarity ratio sees), so "ACH TRANSFER" and "ACH PAYMENT" don't read as a token match.
GENERIC_DUPLICATE_TEXT_TOKENS = {
    "ach", "atm", "card", "cash", "credit", "debit", "deposit", "money", "payment",
    "purchase", "refcode", "send", "transfer", "transf", "tranno", "withdrawal",
}

# Which captured evidence fields may be compared as source text is decided by
# `evidence_field_feeds_text_match` (see services/import_evidence.py for the descriptive/categorical
# split and why it exists). Both text collectors in this module go through it.


def normalize_evidence_text(value: Optional[str]) -> str:
    """Casefold to comparable form: strip trailing reference digits, lowercase, and reduce to
    single-spaced alphanumerics so punctuation and spacing differences between two sources don't
    defeat a match."""
    normalized = sanitize_rule_merchant_text(str(value or "")).lower()
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return " ".join(normalized.split())


def _normalize_duplicate_token(token: str) -> str:
    compact = str(token or "").strip().lower()
    if len(compact) > 5 and compact.endswith("s"):
        compact = compact[:-1]
    return compact


def _duplicate_tokens_match(left: str, right: str) -> bool:
    """Two tokens match outright or by prefix — a source that truncates ("RANCATORE" vs
    "RANCATORES") should still line up. The 4-character floor keeps short prefixes from matching
    unrelated words."""
    if not left or not right:
        return False
    if left == right:
        return True
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    return len(shorter) >= 4 and longer.startswith(shorter)


def tokenize_duplicate_match_text(value: Optional[str], *, include_generic: bool = False) -> list[str]:
    text = normalize_evidence_text(value)
    if not text:
        return []
    tokens: list[str] = []
    for raw_token in text.split():
        token = _normalize_duplicate_token(raw_token)
        if len(token) < 3:
            continue
        if token.isdigit() and len(token) >= 4:
            continue
        if not include_generic and token in GENERIC_DUPLICATE_TEXT_TOKENS:
            continue
        if token not in tokens:
            tokens.append(token)
    return tokens


def _count_fuzzy_token_overlap(left_tokens: list[str], right_tokens: list[str]) -> int:
    if not left_tokens or not right_tokens:
        return 0
    remaining = list(right_tokens)
    matches = 0
    for token in left_tokens:
        match_index = next((index for index, candidate in enumerate(remaining) if _duplicate_tokens_match(token, candidate)), None)
        if match_index is None:
            continue
        matches += 1
        remaining.pop(match_index)
    return matches


def parse_import_evidence(raw) -> Optional[dict]:
    """The stored `import_evidence_json` as a dict, or None when absent/unparseable/not an object."""
    if isinstance(raw, dict):
        return raw
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def collect_duplicate_match_texts(*, merchant_name: Optional[str], display_name: Optional[str],
                                  raw_name: Optional[str], import_evidence: Optional[dict]) -> list[str]:
    """Every distinct text a row can be text-matched on, most-resolved first. Deduplicated by
    normalized form, so two fields carrying the same descriptor contribute once.

    Distinct from `source_match_texts` (used by the cross-account soft-flag sweep): this list keeps
    `display_name` and excludes categorical evidence, because the medium-confidence rule compares
    *how a source described* a row within an already-narrowed candidate set.
    """
    texts: list[str] = []

    def add_text(value: Optional[str]):
        text = str(value or "").strip()
        normalized = normalize_evidence_text(text)
        if text and normalized and normalized not in {normalize_evidence_text(existing) for existing in texts}:
            texts.append(text)

    add_text(display_name)
    add_text(merchant_name)
    add_text(raw_name)

    if isinstance(import_evidence, dict):
        description = import_evidence.get("description")
        if isinstance(description, dict):
            add_text(description.get("value"))
        for field_entry in import_evidence.get("extra_text_fields") or []:
            if evidence_field_feeds_text_match(field_entry):
                add_text(field_entry.get("value"))
    return texts


# Token-overlap fraction at which two matched tokens are enough to lift a pair over
# `TEXT_DUPLICATE_MATCH_FLOOR` — i.e. enough to **hard-reject** it, unseen. Deliberately set ABOVE two
# thirds, so a 2-of-3 overlap does NOT clear it while 3-of-4 does. Two matched tokens out of three is
# real evidence, but not rejection-grade: one of the two is routinely boilerplate that simply never made
# it onto `GENERIC_DUPLICATE_TEXT_TOKENS` (a bank's payment-type suffix, a processor's product word), so
# a single distinctive token would be carrying the whole decision. That band belongs in review, and has
# somewhere to go: the cross-source sweep's `_WEAK_SHARED_TOKEN_FLOOR` tier surfaces exactly this
# evidence for the user to resolve. This value stood at `0.67` for a while and read as an approximation of
# two thirds that a 2-of-3 overlap could never clear; "correcting" it to a true 2/3 converts precisely the
# pair a user wants to be asked about into a silent rejection. Stated as an explicit bound instead, with a
# regression test pinning the 2-of-3 case.
_TOKEN_OVERLAP_HARD_REJECT_FLOOR = 0.7


def score_duplicate_text_match(left_text: str, right_text: str) -> tuple[float, dict]:
    """Similarity of two descriptors in [0, 1], plus the signals behind it (for diagnosis).

    Blends a character ratio with distinctive-token overlap and a containment bonus, because the
    two failure modes differ: character similarity catches truncations and typos, token overlap
    catches a source that reorders or pads the descriptor with boilerplate.
    """
    normalized_left = normalize_evidence_text(left_text)
    normalized_right = normalize_evidence_text(right_text)
    if not normalized_left or not normalized_right:
        return 0.0, {}
    if normalized_left == normalized_right:
        return 1.0, {"mode": "exact_text"}

    ratio = SequenceMatcher(None, normalized_left, normalized_right).ratio()
    left_tokens = tokenize_duplicate_match_text(normalized_left)
    right_tokens = tokenize_duplicate_match_text(normalized_right)
    matched_tokens = _count_fuzzy_token_overlap(left_tokens, right_tokens)
    overlap = (
        matched_tokens / max(1, min(len(left_tokens), len(right_tokens)))
        if left_tokens and right_tokens else 0.0
    )
    contains = (
        min(len(normalized_left), len(normalized_right)) >= 8
        and (normalized_left in normalized_right or normalized_right in normalized_left)
    )

    score = max(ratio, overlap)
    if contains:
        score = max(score, min(0.92, score + 0.08))
    if matched_tokens >= 2 and overlap >= _TOKEN_OVERLAP_HARD_REJECT_FLOOR:
        score = max(score, 0.82)
    if matched_tokens >= 3 and overlap >= 0.8:
        score = max(score, 0.9)

    return score, {
        "mode": "text_similarity",
        "ratio": ratio,
        "overlap": overlap,
        "matched_tokens": matched_tokens,
        "contains": contains,
    }


# Score at or above which two descriptors are treated as the same transaction by the
# medium-confidence text rule. Tuned against real multi-source files; below it the row falls
# through to the soft-flag sweep for review rather than being hard-rejected.
TEXT_DUPLICATE_MATCH_FLOOR = 0.78


# The text sets an indexed candidate carries for matching. Never persisted — and `source_texts` is a
# `set`, which `json.dumps` refuses outright — so every path that turns a candidate into a stored
# `matched` dict has to strip them. Named once because the failure mode is silent until the day a new
# key reaches the encoder.
_CANDIDATE_TEXT_KEYS = ("match_texts", "source_texts")

# Everything `candidate_summary` strips: the text sets plus the rest of the matcher's bookkeeping.
# `duplicate_scope` is in here but is deliberately NOT stripped by `find_textual_duplicate_candidate` —
# its caller reads it back to word the reject reason.
_INTERNAL_CANDIDATE_KEYS = (
    "_consumed", "content_hash", *_CANDIDATE_TEXT_KEYS, "duplicate_scope", "csv_value", "scope_id",
)


def find_textual_duplicate_candidate(candidate_rows: list[dict], txn_payload: dict) -> Optional[dict]:
    """The best-scoring candidate at or above `TEXT_DUPLICATE_MATCH_FLOOR`, or None. Candidates
    arrive pre-narrowed to the same (date, amount), so this only decides *which* same-amount row on
    the same day is the match."""
    import_texts = collect_duplicate_match_texts(
        merchant_name=txn_payload.get("merchant_name"),
        display_name=txn_payload.get("display_name"),
        raw_name=txn_payload.get("raw_name"),
        import_evidence=txn_payload.get("import_evidence"),
    )
    best_candidate = None
    best_score = 0.0
    for candidate in candidate_rows:
        candidate_texts = candidate.get("match_texts") or []
        if not import_texts or not candidate_texts:
            continue
        candidate_best_score = 0.0
        for import_text in import_texts:
            for candidate_text in candidate_texts:
                score, _ = score_duplicate_text_match(import_text, candidate_text)
                if score > candidate_best_score:
                    candidate_best_score = score
        if candidate_best_score >= TEXT_DUPLICATE_MATCH_FLOOR and candidate_best_score > best_score:
            best_candidate = candidate
            best_score = candidate_best_score
    if not best_candidate:
        return None
    matched = dict(best_candidate)
    for key in _CANDIDATE_TEXT_KEYS:
        matched.pop(key, None)
    matched["duplicate_match_score"] = round(best_score, 3)
    return matched


def match_terminal_day_candidate(candidate_rows: list[dict], *, content_hash: str, amount: float,
                                 incoming_merchant: Optional[str] = None) -> Optional[dict]:
    """Consume one candidate from the terminal day's finite pool, exact hash first then amount-only.

    Consumption (`_consumed`) is what makes the terminal day reconcile rather than blanket-reject:
    each prior row absorbs at most one incoming row, so once the historical overlap is used up the
    genuinely-new rows on that day pass through. The amount-only fallback would match two different
    checks sharing a date and amount, so a differing explicit check number vetoes a candidate — it
    is then neither matched nor consumed.
    """
    active_rows = [
        candidate for candidate in candidate_rows
        if not candidate.get("_consumed")
        and not are_distinct_checks(incoming_merchant, candidate.get("merchant_name") or candidate.get("display_name"))
    ]
    if not active_rows:
        return None
    exact_match = next((candidate for candidate in active_rows if candidate.get("content_hash") == content_hash), None)
    if exact_match:
        exact_match["_consumed"] = True
        return exact_match
    amount_match = next((candidate for candidate in active_rows if float(candidate.get("amount") or 0) == float(amount)), None)
    if amount_match:
        amount_match["_consumed"] = True
        return amount_match
    return None


# ---------------------------------------------------------------------------
# Coverage-window primitives
# ---------------------------------------------------------------------------


def duplicate_amount_key(date_str: str, amount: float) -> str:
    """The (date, amount) bucket key the candidate indexes are built on."""
    return f"{str(date_str or '').strip()}|{float(amount):.2f}"


# How many trailing days of a source's range are treated as SOFT — reconciled one-to-one against what
# is already there rather than blanket-rejected.
#
# The original value was 1, "just the export day", on the premise that only the day an export was taken
# can be partial. That premise turned out to be the special case, not the rule. **Most sources lag the
# thing they describe.** An aggregator (Monarch, Fidelity, any data connection) is itself waiting on the
# bank, so an export dated the 27th can be missing a transaction from the 25th it had not yet ingested;
# even a bank's own export lags its own pending/posted pipeline. Only a first-party export of records
# the source itself created (Amazon, PayPal) genuinely has no lag.
#
# So the default is the lagging case, and 1 is the opt-in for a source that publishes its own records.
# The direction of error decides it: too *small* a window blanket-rejects a real transaction as
# "already covered" and it is gone from the ledger with only a duplicate-report entry to find it by;
# too *large* a window costs nothing but a one-to-one reconciliation pass over a few more days, which
# still catches genuine duplicates by name (Rule 5) and lets genuinely-new rows through. A silent loss
# is much worse than a redundant check, and the window is a far weaker discriminator than the text
# match that runs alongside it.
#
# 7 is the same evidence-derived bound as CROSS_ACCOUNT_DATE_WINDOW_DAYS: measured posting skew between
# two sources describing the same charge reached +6 days.
MIN_TERMINAL_WINDOW_DAYS = 1
DEFAULT_TERMINAL_WINDOW_DAYS = 7


def _normalized_terminal_window(window_days) -> int:
    """One rule for what a window value means, so every caller agrees.

    Absent or unreadable means "this source never said", which takes the default. A number that is
    present but too small is a *stated* narrow window and is clamped to the minimum rather than
    silently widened to the default — the two cases are deliberately not conflated, since a plain
    `or` would read a 0 as "unset" and hand back the widest window of all.
    """
    if window_days is None:
        return DEFAULT_TERMINAL_WINDOW_DAYS
    try:
        return max(MIN_TERMINAL_WINDOW_DAYS, int(window_days))
    except (TypeError, ValueError):
        return DEFAULT_TERMINAL_WINDOW_DAYS


def terminal_window_start(terminal_date: Optional[str], window_days: int = DEFAULT_TERMINAL_WINDOW_DAYS) -> Optional[str]:
    """The first date of the soft trailing window — coverage is fully trusted strictly *before* this.

    At a window of 1 this returns the terminal date itself, making the caller's `< start` test identical
    to the original `< terminal_date`.
    """
    normalized = str(terminal_date or "").strip()
    if not normalized:
        return None
    span = _normalized_terminal_window(window_days)
    if span == 1:
        return normalized
    parsed = _parse_iso_date(normalized)
    if parsed is None:
        return normalized
    return (parsed - timedelta(days=span - 1)).isoformat()


def compute_import_coverage_window(date_values, terminal_date: Optional[str],
                                   window_days: int = DEFAULT_TERMINAL_WINDOW_DAYS) -> tuple[Optional[str], Optional[str]]:
    """The fully-covered span of a source, which deliberately STOPS SHORT of its trailing window.

    Days inside that window are excluded from the blanket-reject range and handled by terminal
    reconciliation instead (see `match_terminal_day_candidate`), so a source that lags its bank does not
    swallow transactions that simply had not arrived yet. Returns (None, None) when nothing is fully
    covered — which is the correct answer for a source whose entire range sits inside its own lag.
    """
    unique_dates = sorted({str(value or "").strip() for value in (date_values or []) if str(value or "").strip()})
    soft_start = terminal_window_start(terminal_date, window_days)
    covered_dates = [d for d in unique_dates if not soft_start or d < soft_start]
    if not covered_dates:
        return None, None
    return covered_dates[0], covered_dates[-1]


def terminal_window_days_for(row) -> int:
    """A coverage row's trailing-window size, falling back to the app default when the batch has no
    owning source (a one-off file import) or the source never recorded one."""
    try:
        value = row["terminal_window_days"]
    except (KeyError, IndexError):
        return DEFAULT_TERMINAL_WINDOW_DAYS
    return _normalized_terminal_window(value)


def terminal_window_dates(terminal_date: Optional[str], window_days: int = DEFAULT_TERMINAL_WINDOW_DAYS) -> list[str]:
    """Every date in the soft trailing window, newest-last. At a window of 1 this is just the terminal
    date, so the candidate index is keyed exactly as it was before the window was generalized."""
    normalized = str(terminal_date or "").strip()
    if not normalized:
        return []
    span = _normalized_terminal_window(window_days)
    parsed = _parse_iso_date(normalized)
    if span == 1 or parsed is None:
        return [normalized]
    return [(parsed - timedelta(days=offset)).isoformat() for offset in range(span - 1, -1, -1)]


def date_in_import_coverage_window(date_str: str, start_date: Optional[str], end_date: Optional[str]) -> bool:
    target = str(date_str or "").strip()
    start = str(start_date or "").strip()
    end = str(end_date or "").strip()
    return bool(target and start and end and start <= target <= end)


def candidate_summary(candidate: Optional[dict]) -> Optional[dict]:
    """Strip the matcher's internal bookkeeping so a candidate is safe to persist in a duplicate
    report and render."""
    if not isinstance(candidate, dict):
        return None
    summary = dict(candidate)
    for key in _INTERNAL_CANDIDATE_KEYS:
        summary.pop(key, None)
    return summary


# ---------------------------------------------------------------------------
# Ledger lookups (the two that need a live connection)
# ---------------------------------------------------------------------------

# A funding/deposit leg on a wallet account (PayPal, Venmo, …) has its money-movement twin on the
# *funding* account — same magnitude, a day or three off (ACH/settlement lag), named for the wallet
# ("PAYPAL", "WDRL-ACH PAYPAL …"). That twin is cross-account and opposite-signed, so the same-account
# coverage lookup never sees it and the leg reads as "no specific match". This ±window is how far the
# funding post may drift from the leg's date.
_CROSS_ACCOUNT_TRANSFER_WINDOW_DAYS = 3

# How far a corroborating charge may sit from the payment (card settlement lag is looser than the
# transfer window). Generic tokens carry no identifying signal, so they never anchor a match.
_PAYMENT_MATCH_WINDOW_DAYS = 14
_GENERIC_MERCHANT_TOKENS = frozenset({
    "payment", "paypal", "purchase", "online", "store", "user", "inc", "llc", "ltd", "the", "and",
})


def _amount_window_rows(conn, receiving_account_id: str, on_date, window_days: int, amount: float):
    """Rows on *other* accounts whose ledger amount is exactly `amount` — **sign included** —
    within ±window_days. The shared candidate query behind both cross-account fallbacks below.

    The caller states the sign it wants, because the two callers want opposite ones: a transfer’s twin
    is the equal-and-**opposite** leg (money out of one account is money into the other), while a
    payment’s corroborating charge is the **same** outflow seen on a second account. This compared
    magnitudes until 2026-08 — `ROUND(ABS(...))`, the union of both — which handed each caller the
    other’s rows and left a text check as the only thing between them. That holds until the text
    agrees: a refund and the charge it reverses share an amount and a merchant, so an opposite-signed
    refund could corroborate a payment and stop a genuinely new row from importing. Stating the sign
    also lets both callers seek `idx_txn_amount_round` rather than scan the ledger once per row.
    """
    low = (on_date - timedelta(days=window_days)).isoformat()
    high = (on_date + timedelta(days=window_days)).isoformat()
    # `_account_label_sql`, not a bare display name: merging propagates the parent's display name onto
    # every child (`_set_root_display_name`), so inside a linked group the display name identifies the
    # *group*, not the member. A candidate on a sibling then renders with the same account label as the
    # row it supposedly duplicates — erasing the one fact that explains the pair, that the twin arrived
    # on a different underlying source. The mask is what separates them. Sharing the expression also
    # keeps one report from carrying two label forms: every other account in it is named through
    # `account_labels`, which skips a candidate that already carries an `account_name` of its own.
    return conn.execute(
        f"""SELECT t.id, t.date, t.amount, t.account_id,
                  COALESCE(NULLIF(t.display_name,''), NULLIF(t.merchant_name,''), t.raw_name) AS merchant_name,
                  t.import_evidence_json, t.import_batch_id,
                  {_account_label_sql('a')} AS account_name
           FROM   txn t JOIN account a ON a.id = t.account_id
           WHERE  ROUND(t.amount, 2) = ROUND(?, 2)
             AND  t.account_id <> ?
             AND  t.trashed_at IS NULL
             AND  date(t.date) BETWEEN date(?) AND date(?)""",
        (float(amount), receiving_account_id, low, high),
    ).fetchall()


def _row_text_haystack(row) -> str:
    """A row's resolved name plus its captured source text, normalized and space-stripped — the same
    haystack `match_source_text` rules search. The cleaned name frequently omits a token ("PayPal")
    that the raw statement carries, so searching only the name misses most of these."""
    return normalize_evidence_text(
        f"{row['merchant_name'] or ''} {source_match_text_from_json(row['import_evidence_json'])}"
    ).replace(" ", "")


def find_cross_account_transfer_candidates(conn, receiving_account_id: str, parsed_date: str,
                                           amount: float) -> list[dict]:
    """The transfer counterpart of a coverage-rejected leg that found no same-account match: a row on a
    *different* account, the equal-and-opposite amount, within a few days, whose name **or captured source text** contains
    the receiving account's name (the wallet it funds). Display-only and heuristic — surfaced for the user
    to confirm or reject, never auto-resolved — so it turns a bare 'no specific match' into a reviewable
    'possible transfer match' without changing the (correct) reject verdict. Empty when the account can't
    be named or nothing plausible exists."""
    acct = conn.execute(
        "SELECT COALESCE(NULLIF(display_name,''), name) AS label FROM account WHERE id = ?",
        (receiving_account_id,),
    ).fetchone()
    token = normalize_evidence_text(acct["label"]).replace(" ", "") if acct and acct["label"] else ""
    on_date = _parse_iso_date(str(parsed_date))
    if not token or on_date is None or amount is None:
        return []
    out: list[dict] = []
    # Negated: a leg’s twin is the other side of one movement. A row on another account with the
    # *same* sign is a second transaction of the same size, never the counterpart of this one.
    for r in _amount_window_rows(conn, receiving_account_id, on_date,
                                 _CROSS_ACCOUNT_TRANSFER_WINDOW_DAYS, -amount):
        if token in _row_text_haystack(r):
            out.append({
                "id": r["id"], "date": r["date"], "merchant_name": r["merchant_name"],
                "amount": r["amount"], "account_id": r["account_id"], "account_name": r["account_name"],
                "import_batch_id": r["import_batch_id"], "cross_account": True,
            })
    # Nearest-date first, so the most likely twin leads.
    out.sort(key=lambda c: _date_distance_days(c["date"][:10], on_date.isoformat()))
    return out


def _merchant_match_tokens(name: Optional[str]) -> list[str]:
    """Distinctive tokens of a merchant name for corroboration matching: normalized words of 4+ chars
    that aren't generic filler. Empty when the name carries nothing identifying."""
    normalized = normalize_evidence_text(name)
    return [t for t in normalized.split() if len(t) >= 4 and t not in _GENERIC_MERCHANT_TOKENS]


def find_ledger_payment_match(conn, receiving_account_id: str, parsed_date: str, amount: float,
                              incoming_merchant: Optional[str]) -> Optional[dict]:
    """For a coverage-rejected **named** payment with no same-account/transfer candidate: is it actually
    already in the ledger as a charge elsewhere — e.g. a ``PAYPAL <merchant>`` card charge — or is it a
    genuinely-new payment the covering aggregator never saw (a balance-funded subscription or P2P send)?
    Matches by a distinctive merchant token + the same signed amount within a couple of weeks on
    another account; the opposite-signed row of that amount is the refund, not a corroborating charge.

    Returns a compact candidate dict (a corroborating charge exists → keep rejecting, and the report can
    show it) or ``None`` (nothing corroborates → the payment is genuinely new and should import). Nameless
    money-movement rows never reach here — the caller gates on a non-empty merchant — so this only ever
    decides real payments, never funding legs."""
    tokens = _merchant_match_tokens(incoming_merchant)
    on_date = _parse_iso_date(str(parsed_date))
    if not tokens or on_date is None or amount is None:
        return None
    # Same sign, deliberately: what corroborates a payment is the same money leaving by another route —
    # the card charge behind a wallet purchase. The opposite-signed row of that amount and merchant is
    # the *refund*, and taking a refund as corroboration is what would keep a real payment out.
    for r in _amount_window_rows(conn, receiving_account_id, on_date, _PAYMENT_MATCH_WINDOW_DAYS, amount):
        haystack = _row_text_haystack(r)
        if any(tok in haystack for tok in tokens):
            return {
                "id": r["id"], "date": r["date"], "merchant_name": r["merchant_name"],
                "amount": r["amount"], "account_id": r["account_id"], "account_name": r["account_name"],
                "import_batch_id": r["import_batch_id"], "cross_account": True, "payment_match": True,
            }
    return None


def get_effective_account_row(conn, account_id: Optional[str]):
    """Walk `parent_account_id` to the top-level account row — the linked group's identity. Returns
    None for an unknown id or a cycle."""
    current_id = str(account_id or "").strip()
    if not current_id:
        return None
    seen: set[str] = set()
    while current_id and current_id not in seen:
        seen.add(current_id)
        row = conn.execute(
            """
            SELECT id, name, display_name, type, owner_id, parent_account_id
            FROM account
            WHERE id = ?
            """,
            (current_id,),
        ).fetchone()
        if not row:
            return None
        if not row["parent_account_id"]:
            return row
        current_id = row["parent_account_id"]
    return None


# ---------------------------------------------------------------------------
# Import-time per-row evaluator
# ---------------------------------------------------------------------------


@dataclass
class DedupeContext:
    """Precomputed lookups for a single ingestion pass. Built once via `build_dedupe_context` so
    the per-row evaluator is just dict lookups."""

    existing_hashes_by_account: dict = field(default_factory=dict)
    existing_hashes_by_effective_account: dict = field(default_factory=dict)
    existing_rows_by_account_amount: dict = field(default_factory=dict)
    existing_rows_by_effective_account_amount: dict = field(default_factory=dict)
    import_coverage_by_csv_value: dict = field(default_factory=dict)
    import_coverage_by_scope_id: dict = field(default_factory=dict)
    terminal_day_candidates_by_csv_day: dict = field(default_factory=dict)
    terminal_day_candidates_by_scope_day: dict = field(default_factory=dict)
    accounts_with_prior_history: set = field(default_factory=set)
    explicit_alias_csv_values: set = field(default_factory=set)
    account_duplicate_compare_targets: dict = field(default_factory=dict)
    coverage_strategy_enabled: bool = True
    text_strategy_enabled: bool = True
    # The live connection, used only by the two coverage *fallback* lookups (cross-account transfer
    # twin, corroborating payment charge). Those fire solely on the 'covered but no specific match'
    # residual, so the common path stays pure dict lookups. Optional so a unit test can drive the
    # evaluator with no DB — the fallbacks are then simply skipped.
    conn: Optional[sqlite3.Connection] = None
    # Resolves (account_id, source_value) → the effective-account scope id, sharing the builder's
    # linked-group cache. Callers need it per row to pass `scope_id` into `evaluate_duplicate`;
    # exposing it here keeps that one definition of "what scope is this row in" rather than letting
    # each ingestion path re-derive it.
    scope_id_for: Optional[Callable[[Optional[str], str], Optional[str]]] = None


@dataclass
class DedupeVerdict:
    """Result of evaluating a single row. Exactly one of `hard_reject` / `soft_flag` / `passthrough`
    is true. When `hard_reject`, `matched` and `reason` describe why; the caller writes the row to
    `import_batch_duplicate` and skips insert. When `soft_flag`, `suspect_of` carries the existing
    row id and `reason_key` carries a stable code (e.g. `'import_new_account'`); the caller inserts
    the row with `suspect_duplicate_of` set. When `passthrough`, the row is inserted normally.

    `terminal_day_reconciled` is exposed separately because the text-strategy rule needs to know
    whether the terminal-day branch already considered the row, even when no terminal-day match
    was produced — preserves the existing precedence semantics.
    """

    hard_reject: bool = False
    soft_flag: bool = False
    passthrough: bool = True
    matched: Optional[dict] = None
    reason: str = ""
    suspect_of: Optional[str] = None
    reason_key: str = ""
    terminal_day_reconciled: bool = False


def _adjacent_date_offsets(parsed_date: str) -> list[tuple[str, int]]:
    """(date_string, day_offset) pairs for a ±1-day candidate-display window. Exact date first so it
    ranks ahead of the near-date fallbacks; falls back to just the exact date if it can't be parsed.
    Two sources for the same transaction routinely disagree on the posting day by one (timezone /
    settlement), which otherwise leaves a covered row with 'no specific match'."""
    try:
        d = datetime.strptime(parsed_date, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return [(parsed_date, 0)]
    return [
        (parsed_date, 0),
        ((d - timedelta(days=1)).isoformat(), -1),
        ((d + timedelta(days=1)).isoformat(), 1),
    ]


def _far_date_offsets(parsed_date: str) -> list[tuple[str, int]]:
    """Candidate offsets from ±2 out to ±`CROSS_ACCOUNT_DATE_WINDOW_DAYS`, used ONLY as a fallback
    when the exact/±1 lookup finds nothing. Ordered closest-first so a nearer candidate is never
    displaced by a farther one.

    This started at ±2, for the foreign-transaction case: a charge posts on its local calendar day (a
    day ahead of US), turning the usual pending/posted ±1 disagreement into ±2. But settlement skew
    between two sources is routinely larger — measuring real pairs on a live ledger found genuine
    matches at +3, +4 and +6 days, which is why the soft-flag sweep's window is 7. At ±2 those rows
    were correctly rejected and then reported as **'no specific match'**, which is the worst pairing:
    the row is gone from the ledger *and* the report can't say what replaced it, so the one thing a
    user auditing the rejections needs is exactly what's missing.

    Widening is safe because this is **display-only** — the reject verdict is already made and cannot
    change (see `_coverage_reject_verdict`). The risk it does carry is naming a coincidental
    same-amount row up to a week out as "the match", which is why these stay a fallback behind
    exact/±1 and carry a `day_offset` the report renders, so a distant candidate reads as a near-date
    guess rather than an exact hit.
    """
    try:
        d = datetime.strptime(parsed_date, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return []
    offsets: list[tuple[str, int]] = []
    for gap in range(2, CROSS_ACCOUNT_DATE_WINDOW_DAYS + 1):
        offsets.append(((d - timedelta(days=gap)).isoformat(), -gap))
        offsets.append(((d + timedelta(days=gap)).isoformat(), gap))
    return offsets


def _candidate_summary_rows_for_coverage(context: "DedupeContext", receiving_account_id: str,
                                          parsed_date: str, amount: float,
                                          scope_id: Optional[str],
                                          incoming_texts: Optional[RowMatchTexts] = None) -> list[dict]:
    """For a coverage-window hit, look up actual same-account candidate rows by (date, amount).
    Returns a list of compact dicts the unified report renders directly. Empty list means
    'covered date but no specific match' — the report flags those for manual review.

    This is display-only: the coverage rule has already returned its hard-reject verdict, so widening
    the lookup (same amount, nearby date) cannot change a decision — it only lets the report point at
    the specific prior transaction when the two sources disagree on the posting day. Exact and ±1 are
    probed first; only when those find nothing does it widen out to
    `CROSS_ACCOUNT_DATE_WINDOW_DAYS`, closest day first, so a nearer candidate is never displaced by a
    farther one. Every hit carries a `day_offset` the UI labels, so a distant candidate reads as a
    near-date guess rather than an exact hit. Only when the whole window finds nothing does the row
    stay 'no specific match' for manual review — a state worth minimizing, since a rejected row whose
    replacement can't be named is precisely what makes auditing the rejections hard.

    The lookup re-uses the per-account amount index that text-strategy already populates, so the
    cost is dict lookups, not extra queries. `scope_id` (the row's linked-group root, passed only by
    the in-scope coverage rule) additionally folds in candidates from sibling accounts in that group,
    since that rule's premise is that the prior import covered the whole effective-account scope. It
    names ONE scope on purpose: the index holds a map per scope in the pass, and reaching into all of
    them would let an unrelated account group in the same import supply a candidate.

    `incoming_texts` (the incoming row's `row_match_texts`) tiers each hit against the incoming
    descriptor with `classify_source_text_relation`, recording the result on `text_relation`. This
    function only *labels*; `_display_candidates` decides what to hide. Keeping the two apart is what
    lets the verdict path go on seeing the complete list — see `_coverage_reject_verdict`.
    """
    seen_ids: set[str] = set()
    out: list[dict] = []
    relation_cache: dict[str, Optional[str]] = {}
    # `RowMatchTexts` is a tuple, so it is truthy even when it holds nothing — every emptiness test
    # here has to go through `.all` rather than the object.
    incoming_has_text = bool(incoming_texts and incoming_texts.all)

    def _relation(candidate: dict) -> Optional[str]:
        """The candidate's text tier, or None when it has none — or when either side has no captured
        text at all, which is not disagreement but an absence of evidence (a nameless money-movement
        leg text-matches nothing, by design)."""
        if not incoming_has_text:
            return None
        candidate_texts = candidate.get("source_texts")
        if not (candidate_texts and candidate_texts.all):
            return None
        cid = str(candidate.get("id") or "")
        if cid not in relation_cache:
            relation_cache[cid] = classify_source_text_relation(incoming_texts, candidate_texts)
        return relation_cache[cid]

    def _append(candidate: dict, day_offset: int) -> None:
        cid = candidate.get("id")
        if not cid or cid in seen_ids:
            return
        seen_ids.add(cid)
        row = {
            "id":            cid,
            "date":          candidate.get("date"),
            "merchant_name": candidate.get("merchant_name"),
            "amount":        candidate.get("amount"),
            "account_id":    candidate.get("account_id"),
            "import_batch_id": candidate.get("import_batch_id"),
        }
        if day_offset:
            row["day_offset"] = day_offset  # candidate's date is this many days off the incoming row's
        relation = _relation(candidate)
        if relation:
            row["text_relation"] = relation  # 'exact' | 'fuzzy' | 'weak'; absent = unjudged or unrelated
        # Whether the pair was *judgeable* at all, so `_display_candidates` can tell "no agreement"
        # (a real signal) apart from "nothing to compare" (never grounds to hide a row).
        candidate_texts = candidate.get("source_texts")
        row["_text_comparable"] = incoming_has_text and bool(candidate_texts and candidate_texts.all)
        if candidate.get("cross_account"):
            # A transfer twin on the funding account — carry the marker + account label so the report
            # can label it 'possible transfer match on <account>' rather than a same-account match.
            row["cross_account"] = True
            row["account_name"] = candidate.get("account_name")
        out.append(row)

    def _probe(offsets) -> None:
        for day, day_offset in offsets:
            key = duplicate_amount_key(day, amount)
            for candidate in context.existing_rows_by_account_amount.get(receiving_account_id, {}).get(key, []):
                _append(candidate, day_offset)
            if scope_id:
                # Linked-group rows too — the sibling/child account a second source files the same
                # charge under is exactly what the receiving-account index above cannot see.
                for candidate in context.existing_rows_by_effective_account_amount.get(scope_id, {}).get(key, []):
                    _append(candidate, day_offset)

    _probe(_adjacent_date_offsets(parsed_date))
    # Only reach to ±2 when exact/±1 produced nothing, so a real exact/±1 match is never diluted
    # by a coincidental ±2 neighbor — the ±2 band is purely the timezone-shift fallback.
    if not out:
        _probe(_far_date_offsets(parsed_date))
    # Still nothing on this account or its linked group? A wallet funding/deposit leg's twin lives on
    # the *funding* account — cross-account, opposite-signed, so invisible above. Surface it (tagged
    # `cross_account`) as a reviewable 'possible transfer match' instead of a bare 'no specific match'.
    if not out and context.conn is not None:
        for candidate in find_cross_account_transfer_candidates(
            context.conn, receiving_account_id, parsed_date, amount,
        ):
            _append(candidate, 0)
    return out


# Best explanation first. Ranks the three text tiers, with everything unjudged behind them; ties keep the
# order they were collected in, which is closest-day-first.
_TEXT_RELATION_RANK = {"exact": 0, "fuzzy": 1, "weak": 2}


def _display_candidates(candidates: list[dict]) -> list[dict]:
    """The subset of a coverage hit's candidates worth showing as "this is what the row duplicates",
    strongest explanation first.

    The lookup finds candidates by amount and date alone, and that is thin evidence on its own: on a real
    ledger a window around any common amount picks up unrelated charges, and the report then presents a
    coincidence with the same confidence as the actual twin. So a candidate has to also agree textually —
    exact, fuzzy, or the weak shared-token tier, the same ladder
    `scan_scope_for_cross_account_duplicates` uses to decide what is worth a human's attention.

    **The date exemption is relative, not absolute, and that distinction is the whole rule.** Exact-date
    and ±1 candidates are kept without any text agreement *only while nothing else in the list has any* —
    because that is the case the exemption exists for: two sources routinely describe one charge with no
    shared text whatsoever (a bank's terminal string against an aggregator's cleaned merchant name), and
    filtering on text there would drop correct matches. But once some candidate for the same row *does*
    agree textually, a better explanation is already present, and the wordless neighbours stop being that
    case and become the coincidence the filter exists to remove. As an absolute rule it could not tell the
    two apart: three same-amount charges on adjacent days each listed all three as equally likely, with
    each row's real twin — identical wording, matching amount, a day away — buried among them.

    One exemption stays unconditional: **a pair with no text on one side is never hidden**
    (`_text_comparable`). A nameless money-movement leg matches nothing by design, and silence is not
    disagreement — there is no evidence to be outranked by.

    Display-only, and applied last: the verdict logic sees the complete list (see
    `_coverage_reject_verdict`), so nothing here can change which rows were rejected or why — only what
    the report names as the thing a row duplicates. Emptying the list entirely is a signal in its own
    right, though — every explanation on offer was a coincidence — and the caller answers it by probing
    the wider ledger for a nameable one.
    """
    # Whether any candidate for THIS row agrees textually. Computed over the whole list rather than per
    # candidate, since it is precisely the comparison between candidates that decides the wordless ones.
    has_agreement = any(candidate.get("text_relation") for candidate in candidates)

    def _keep(candidate: dict) -> bool:
        if candidate.get("text_relation"):
            return True
        if not candidate.get("_text_comparable"):
            return True
        # Judged, and it agrees with nothing. Worth showing only while no candidate does better.
        if has_agreement:
            return False
        return abs(candidate.get("day_offset") or 0) < 2

    kept = sorted(
        (candidate for candidate in candidates if _keep(candidate)),
        key=lambda candidate: (_TEXT_RELATION_RANK.get(candidate.get("text_relation"), 3),
                               abs(candidate.get("day_offset") or 0)),
    )
    return [
        {key: value for key, value in candidate.items() if key != "_text_comparable"}
        for candidate in kept
    ]


def _coverage_matched(cov: dict, candidates: list[dict]) -> dict:
    """Build the verdict's `matched` dict for a coverage-window hit. We deliberately do NOT echo
    the incoming amount as a synthetic 'matched amount' (it implies a specific match we didn't
    make). Instead we describe the coverage and attach any actual candidates the lookup found.

    Shape:
      - covered: { start_date, end_date, source_batch_id }   (always present)
      - candidates: list of compact candidate dicts          (may be empty → no specific match)
      - candidate_count: len(candidates)                     (UI shortcut)
    """
    return {
        "covered": {
            "start_date": cov.get("start_date"),
            "end_date":   cov.get("end_date"),
            "source_batch_id": cov.get("batch_id"),
            "source_csv_value": cov.get("csv_value"),
        },
        "candidates":      candidates,
        "candidate_count": len(candidates),
    }


def _coverage_reject_verdict(context: "DedupeContext", cov: dict, receiving_account_id: str,
                             parsed_date: str, amount: float, scope_id: Optional[str],
                             incoming_merchant, reason: str,
                             incoming_texts: Optional[RowMatchTexts] = None):
    """The verdict for a coverage-window hit: a hard-reject, carrying any same-account/transfer candidates
    for the report. One exception keeps real spending from being silently dropped: a **named** row (a real
    payment, not a nameless money-movement leg) with no such candidate is only treated as a duplicate when
    a corroborating charge actually exists elsewhere in the ledger (a ``PAYPAL <merchant>`` card charge,
    matched by merchant + amount). When none does, the payment is genuinely new — the covering import
    never saw it (it was funded from the wallet balance, so it never hit a card/bank) — and this returns
    ``None`` so the row falls through to import instead of being buried as 'covered, no specific match'.
    Nameless money-movement rows keep their existing coverage rejection unchanged.

    That exception is why `_display_candidates` is applied **last**, to the reported list only. "No
    candidate" is load-bearing here — it is what sends a named row down the escape hatch — so trimming
    the list the check reads would turn rejections into imports. The text tiering decides what the
    report *shows*; it must not decide what the ladder *does*.

    The ledger probe then runs a **second** time when the tiering empties the reported list, purely to
    name the match — see the comment on that branch."""
    candidates = _candidate_summary_rows_for_coverage(
        context, receiving_account_id, parsed_date, amount, scope_id, incoming_texts,
    )
    if not candidates and incoming_merchant and context.conn is not None:
        payment_match = find_ledger_payment_match(
            context.conn, receiving_account_id, parsed_date, amount, incoming_merchant,
        )
        if payment_match is None:
            return None  # genuinely-new named payment → let it import
        candidates = [payment_match]
    display = _display_candidates(candidates)
    if not display and candidates and incoming_merchant and context.conn is not None:
        # Everything the same-account lookup found was a coincidence the tiering discarded, so the row
        # is about to report "covered, no specific match" — while the ledger probe above, the only step
        # that looks at OTHER accounts, never ran, precisely because a candidate existed. That is the
        # wrong way round: an unrelated charge sharing nothing but an amount should not outrank a
        # corroborating charge that agrees on merchant AND amount, which is what the report wanted all
        # along. Observed as a same-amount neighbour five days out standing in for the row's real twin,
        # filed by a second source on a sibling account.
        #
        # Verdict-safe by construction: reaching here means `candidates` was non-empty, so the escape
        # hatch above already declined to fire and the hard-reject is settled. Only `matched` changes,
        # and only from "nothing" to "this row". The probe cannot run twice for one row either — the
        # branch above runs it only on the empty list this one requires to be non-empty.
        #
        # Named rows only, which is also the whole reachable set: the tiering never empties a list for a
        # nameless money-movement leg (nothing to compare is not disagreement), so its transfer twin
        # from the same lookup is displayed as it always was.
        payment_match = find_ledger_payment_match(
            context.conn, receiving_account_id, parsed_date, amount, incoming_merchant,
        )
        if payment_match is not None:
            display = [payment_match]
    return DedupeVerdict(
        hard_reject=True, passthrough=False,
        matched=_coverage_matched(cov, display), reason=reason,
    )


def evaluate_duplicate(
    *,
    context: DedupeContext,
    receiving_account_id: str,
    csv_value: str,
    content_hash: str,
    parsed_date: str,
    amount: float,
    scope_id: Optional[str],
    txn_payload: dict,
    authorized_date: Optional[str] = None,
) -> DedupeVerdict:
    """Run the dedupe rule chain for a single incoming row. See module docstring for the rule
    ladder. The caller builds `context` once per import via `build_dedupe_context` (or constructs
    one directly for tests). `scope_id` is the receiving account's effective-account/linked-group
    scope id, used by the in-scope rules.

    `authorized_date` is the row's *other* date when the source publishes both (when it was
    authorized, as against when it posted). Every date test below asks whether **either** date
    applies, because two sources routinely date the same charge differently — one reports the
    transaction date and the other the posted date. Without this a row reads as outside a covered
    range that morally contains it, and the coverage rule never engages at all.
    """
    incoming_merchant = txn_payload.get("merchant_name")
    # Every date this row could legitimately be filed under, most-authoritative first.
    row_dates = [d for d in (parsed_date, authorized_date) if d]
    # This row as its source described it, for tiering the coverage rules' reported candidates. Built
    # once here rather than per candidate: the coverage rules can each look at a handful of them.
    incoming_texts = row_match_texts(
        txn_payload.get("merchant_name"), txn_payload.get("raw_name"), txn_payload.get("import_evidence"),
    )

    # Coverage rules run before the exact-hash rules below. When a row both falls in an already-
    # imported date range AND exactly matches an existing row, both verdicts are hard-rejects — the
    # order only decides which reason the duplicate report shows, and coverage is the more useful
    # label (see module docstring: a re-imported range is one uniform story; which rows happen to be
    # exact content-hash matches is an incidental artifact of merchant-string formatting). Exact-hash
    # still hard-rejects rows OUTSIDE any covered range, so nothing it caught before stops being
    # caught — it just no longer wins the label when coverage already explains the row.

    # Rule 1: coverage window from a prior import of the same source (csv_value). When the rule
    # fires we ALSO look for actual candidate rows by (receiving_account, date, amount) so the
    # report can show what we think the row matched (or flag "no specific match" if nothing
    # plausible exists). The lookup is free — we already index existing rows by amount-key.
    if context.coverage_strategy_enabled:
        cov = next(
            (entry for entry in context.import_coverage_by_csv_value.get(csv_value, [])
             if any(date_in_import_coverage_window(d, entry.get("start_date"), entry.get("end_date"))
                    for d in row_dates)),
            None,
        )
        if cov:
            verdict = _coverage_reject_verdict(
                context, cov, receiving_account_id, parsed_date, amount,
                scope_id=None, incoming_merchant=incoming_merchant, incoming_texts=incoming_texts,
                reason="Falls within the fully covered date range from an earlier import for this source account",
            )
            if verdict is not None:
                return verdict

    # Rule 2: in-scope coverage window — same linked group, different csv_value. Precondition: the
    # entry must be for the receiving account itself (or for an account the user explicitly
    # aliased this csv to). A brand-new sibling inheriting only its group's coverage does NOT
    # satisfy the precondition; the row falls through to the soft-flag sweep instead.
    if context.coverage_strategy_enabled:
        eligible_account_ids = {receiving_account_id}
        if csv_value in context.explicit_alias_csv_values:
            alias_target = context.account_duplicate_compare_targets.get(csv_value)
            if alias_target:
                eligible_account_ids.add(alias_target)
        cov = next(
            (entry for entry in context.import_coverage_by_scope_id.get(scope_id or "", [])
             if entry.get("csv_value") != csv_value
             and entry.get("account_id") in eligible_account_ids
             and any(date_in_import_coverage_window(d, entry.get("start_date"), entry.get("end_date"))
                     for d in row_dates)),
            None,
        )
        if cov:
            verdict = _coverage_reject_verdict(
                context, cov, receiving_account_id, parsed_date, amount,
                scope_id=scope_id, incoming_merchant=incoming_merchant, incoming_texts=incoming_texts,
                reason="Falls within the fully covered date range from an earlier import in this account scope",
            )
            if verdict is not None:
                return verdict

    # Rule 3: exact content-hash match within the receiving account. Reached only when the row is
    # NOT inside a covered range above. Two different checks can share date+amount+description, so a
    # differing explicit check number means this is NOT the same row — let it fall through to the
    # lower-confidence rules (which route it to review) instead.
    matched = context.existing_hashes_by_account.get(receiving_account_id, {}).get(content_hash)
    if matched and are_distinct_checks(incoming_merchant, matched.get("merchant_name")):
        matched = None
    if matched:
        return DedupeVerdict(hard_reject=True, passthrough=False, matched=matched,
                             reason="Matches an existing transaction")

    # Rule 4: exact content-hash match across the linked-group scope (cross-account).
    compare_target_id = context.account_duplicate_compare_targets.get(csv_value)
    if compare_target_id:
        matched = context.existing_hashes_by_effective_account.get(compare_target_id, {}).get(content_hash)
        if matched and are_distinct_checks(incoming_merchant, matched.get("merchant_name")):
            matched = None
        if matched:
            return DedupeVerdict(hard_reject=True, passthrough=False, matched=matched,
                                 reason="Matches an existing transaction in the linked account group")

    # Rule 5: terminal-day reconciliation. Same-source candidates are always eligible; cross-account
    # candidates only when the receiving account has prior history or is an explicit alias (same
    # precondition as Rule 2 — see module docstring).
    terminal_day_reconciled = False
    if context.coverage_strategy_enabled:
        same_source = [c for d in row_dates
                       for c in context.terminal_day_candidates_by_csv_day.get((csv_value, d), [])]
        receiving_account_is_known = (
            receiving_account_id in context.accounts_with_prior_history
            or csv_value in context.explicit_alias_csv_values
        )
        scope_terminal = (
            [c for d in row_dates
             for c in context.terminal_day_candidates_by_scope_day.get((scope_id or "", d), [])]
            if receiving_account_is_known else []
        )
        terminal_day_reconciled = bool(same_source) or any(
            c.get("csv_value") != csv_value for c in scope_terminal
        )
        if terminal_day_reconciled:
            matched_term = match_terminal_day_candidate(
                same_source, content_hash=content_hash, amount=amount, incoming_merchant=incoming_merchant,
            )
            if not matched_term:
                matched_term = match_terminal_day_candidate(
                    [c for c in scope_terminal if c.get("csv_value") != csv_value],
                    content_hash=content_hash, amount=amount, incoming_merchant=incoming_merchant,
                )
            if matched_term:
                return DedupeVerdict(
                    hard_reject=True, passthrough=False,
                    matched=candidate_summary(matched_term),
                    reason=(
                        "Matches a remaining transaction from the terminal covered day in an earlier import"
                        + (" for this source account" if matched_term.get("csv_value") == csv_value
                           else " in this account scope")
                    ),
                    terminal_day_reconciled=True,
                )

    # Rule 6: fuzzy text match on candidates with the same date+amount. Same precondition as Rule 2
    # for cross-account expansion; same-account candidates are always considered.
    if context.text_strategy_enabled and not terminal_day_reconciled:
        by_amount = context.existing_rows_by_account_amount.get(receiving_account_id, {})
        candidate_rows = []
        seen_candidate_ids = set()
        for d in row_dates:
            for c in by_amount.get(duplicate_amount_key(d, amount), []):
                if c["id"] not in seen_candidate_ids:
                    seen_candidate_ids.add(c["id"])
                    candidate_rows.append(c)
        receiving_account_is_known = (
            receiving_account_id in context.accounts_with_prior_history
            or csv_value in context.explicit_alias_csv_values
        )
        if compare_target_id and receiving_account_is_known:
            scope_by_amount = context.existing_rows_by_effective_account_amount.get(compare_target_id, {})
            for d in row_dates:
                for c in scope_by_amount.get(duplicate_amount_key(d, amount), []):
                    if c["id"] not in seen_candidate_ids:
                        seen_candidate_ids.add(c["id"])
                        candidate_rows.append(c)
        heuristic = find_textual_duplicate_candidate(candidate_rows, txn_payload)
        if heuristic:
            return DedupeVerdict(
                hard_reject=True, passthrough=False, matched=heuristic,
                reason=(
                    "Possible cross-source match by date, amount, and source text"
                    + (" in the linked account group"
                       if heuristic.get("duplicate_scope") == "linked_account_group" else " in this account")
                    + " (medium confidence)"
                ),
                terminal_day_reconciled=terminal_day_reconciled,
            )

    return DedupeVerdict(passthrough=True, terminal_day_reconciled=terminal_day_reconciled)


# ---------------------------------------------------------------------------
# Context builder
# ---------------------------------------------------------------------------


def build_dedupe_context(
    conn: sqlite3.Connection,
    *,
    source_values: Iterable[str],
    account_by_source_value: dict,
    fallback_account_id: Optional[str] = None,
    compare_targets: Optional[dict] = None,
    alias_values: Optional[Iterable[str]] = None,
    exclude_batch_ids: Optional[Iterable[str]] = None,
    exclude_connection_ids: Optional[Iterable[str]] = None,
    coverage_strategy_enabled: bool = True,
    text_strategy_enabled: bool = True,
) -> DedupeContext:
    """Assemble every lookup `evaluate_duplicate` needs, in a handful of queries, for ONE ingestion
    pass. Both ingestion paths use this: a CSV import passes its account-column values as
    `source_values` and the account each maps to as `account_by_source_value`; a data-source sync
    passes its provider account labels and their mapped accounts. Nothing here is CSV-specific —
    "source value" is just whatever label the source uses to name an account.

    `compare_targets` maps a source value to an existing account it was declared an alias of, and
    `alias_values` is the subset where that declaration was **explicit**. The distinction is load
    bearing: an explicit alias asserts "the same physical account in another system", which unlocks
    the cross-account rules, whereas merely landing in a linked group does not (a sibling account is
    a different physical account, and hard-deduping across siblings would over-collapse).

    `exclude_batch_ids` makes the pass behave as though those batches were not there at all: their
    coverage claims, their terminal-window candidates, and **their rows** are all withheld. Used when
    replacing a batch (its own prior coverage must not reject its replacement rows) and when
    re-scanning rows already in the ledger against everything *except* the batches those rows live
    on — without the row exclusion every re-scanned row would match itself. Withholding the whole
    excluded set, rather than just the row being evaluated, is deliberate: excluding only "self"
    would let two rows from the same excluded batch reject each other, and mutual rejection trashes
    both copies of a transaction that has only one duplicate.
    `exclude_connection_ids` does the same for a connection's own coverage claim; see the note at the
    connection-coverage query below for why a sync must exclude itself and a CSV re-import must not.
    """
    compare_targets = dict(compare_targets or {})
    alias_values = set(alias_values or ())
    exclude_batch_ids = {str(b) for b in (exclude_batch_ids or ()) if b}
    exclude_connection_ids = {str(c) for c in (exclude_connection_ids or ()) if c}
    source_values = {str(v or "").strip() for v in source_values}

    relevant_account_ids = {
        str(aid) for aid in account_by_source_value.values() if aid
    }
    if fallback_account_id:
        relevant_account_ids.add(str(fallback_account_id))

    effective_scope_cache: dict[str, Optional[str]] = {}

    def scope_id_for(resolved_account_id: Optional[str], source_value: str) -> Optional[str]:
        """The effective-account scope a row lands in: an explicit compare target wins, else the
        account's linked-group root."""
        compare_target_id = compare_targets.get(source_value)
        if compare_target_id:
            return compare_target_id
        normalized_account_id = str(resolved_account_id or "").strip()
        if not normalized_account_id:
            return None
        if normalized_account_id not in effective_scope_cache:
            effective_row = get_effective_account_row(conn, normalized_account_id)
            effective_scope_cache[normalized_account_id] = str(effective_row["id"]) if effective_row else normalized_account_id
        return effective_scope_cache[normalized_account_id]

    current_scope_ids = {
        s for s in (
            scope_id_for(account_by_source_value.get(v) or fallback_account_id, v)
            for v in source_values
        ) if s
    }

    # Every scope the ladder can consult, so the linked-group index below is populated for all of them.
    # Building it from `compare_targets` alone was a hole: a compare target is only ever recorded when an
    # import *creates* an account and groups it, so a run mapping onto pre-existing accounts left the
    # index empty — and the in-scope coverage rule, which fires off `scope_id` (a linked-group root,
    # compare target or not), then had no sibling rows to name as candidates. It rejected a row on the
    # group's coverage while only ever able to point at the receiving account, so the twin filed under a
    # sibling was invisible and the widened ±N-day fallback pointed at whatever same-amount row happened
    # to sit nearby instead. Note this changes no *verdict*: the two rules that hard-reject across a
    # scope (exact-hash and fuzzy-text, below) both gate on an explicit compare target first, so the
    # scopes added here are keys they never look up.
    relevant_effective_account_ids = {str(v) for v in compare_targets.values() if v} | current_scope_ids

    existing_hashes_by_account: dict[str, dict[str, dict]] = {}
    existing_hashes_by_effective_account: dict[str, dict[str, dict]] = {}
    existing_rows_by_account_amount: dict[str, dict[str, list[dict]]] = {}
    existing_rows_by_effective_account_amount: dict[str, dict[str, list[dict]]] = {}
    import_coverage_by_csv_value: dict[str, list[dict]] = {}
    import_coverage_by_scope_id: dict[str, list[dict]] = {}
    terminal_day_candidates_by_csv_day: dict[tuple[str, str], list[dict]] = {}
    terminal_day_candidates_by_scope_day: dict[tuple[str, str], list[dict]] = {}
    accounts_with_prior_history: set[str] = set()

    def _row_date_variants(r) -> list[str]:
        """Both dates a stored row can legitimately be matched on. Indexing under each is what lets an
        incoming row find it regardless of which date its own source published."""
        dates = [r["date"]]
        try:
            authorized = r["authorized_date"]
        except (KeyError, IndexError):
            authorized = None
        if authorized and authorized != r["date"]:
            dates.append(authorized)
        return [d for d in dates if d]

    def _summary(r, scope: str) -> dict:
        return {
            "id": r["id"],
            "date": r["date"],
            "merchant_name": r["display_name"] or r["merchant_name"] or r["raw_name"],
            "amount": r["amount"],
            "account_id": r["account_id"],
            "import_batch_id": r["import_batch_id"],
            "duplicate_scope": scope,
            "match_texts": collect_duplicate_match_texts(
                merchant_name=r["merchant_name"],
                display_name=r["display_name"],
                raw_name=r["raw_name"],
                import_evidence=parse_import_evidence(r["import_evidence_json"]),
            ),
            # The sweeps' text sets, kept alongside the ladder's: the coverage report tiers its
            # candidates with `classify_source_text_relation`, which is defined over these.
            "source_texts": row_match_texts(
                r["merchant_name"], r["raw_name"], r["import_evidence_json"],
            ),
        }

    def _from_excluded_batch(r) -> bool:
        """Whether a stored row belongs to a withheld batch. Rows with no batch (manual entries) are
        never withheld — they belong to no ingestion event and are always legitimate candidates."""
        batch_id = str(r["import_batch_id"] or "").strip()
        return bool(batch_id) and batch_id in exclude_batch_ids

    if relevant_account_ids:
        ph = _placeholders(relevant_account_ids)
        for r in conn.execute(
            f"""SELECT id, account_id, content_hash, date, authorized_date, raw_name, merchant_name,
                       display_name, amount, is_pending, import_evidence_json, import_batch_id
                FROM   txn
                WHERE  account_id IN ({ph}) AND content_hash IS NOT NULL""",
            list(relevant_account_ids),
        ).fetchall():
            # Pending rows are excluded from dedupe candidacy: a pending row is superseded in place
            # when it posts, so matching against it would reject the very row meant to replace it.
            if r["is_pending"] or not r["content_hash"] or _from_excluded_batch(r):
                continue
            account_hashes = existing_hashes_by_account.setdefault(r["account_id"], {})
            if r["content_hash"] not in account_hashes:
                summary = _summary(r, "same_account")
                account_hashes[r["content_hash"]] = {
                    k: summary[k] for k in ("id", "date", "merchant_name", "amount", "account_id", "import_batch_id")
                }
            summary_row = _summary(r, "same_account")
            for stored_date in _row_date_variants(r):
                key = duplicate_amount_key(stored_date, r["amount"])
                existing_rows_by_account_amount.setdefault(r["account_id"], {}).setdefault(key, []).append(summary_row)

        # Accounts with any prior row. A precondition on the medium-confidence cross-account rules,
        # so a brand-new sibling in a linked group doesn't inherit hard-dedupe behavior from its
        # siblings — its rows fall through to the soft-flag sweep for review instead. The hash-exact
        # cross-account check stays unconditional (same date+amount+payee is high-confidence enough).
        # Withheld batches don't count as history either: an account whose only rows came from an
        # excluded batch is, for this pass, an account with nothing in it — which is exactly the
        # state the precondition is testing for.
        history_query = f"SELECT DISTINCT account_id FROM txn WHERE account_id IN ({_placeholders(relevant_account_ids)})"
        history_params = list(relevant_account_ids)
        if exclude_batch_ids:
            history_query += (
                f" AND (import_batch_id IS NULL OR import_batch_id NOT IN ({_placeholders(exclude_batch_ids)}))"
            )
            history_params.extend(exclude_batch_ids)
        for r in conn.execute(history_query, history_params).fetchall():
            if r["account_id"]:
                accounts_with_prior_history.add(str(r["account_id"]))

    if relevant_effective_account_ids:
        ph = _placeholders(relevant_effective_account_ids)
        for r in conn.execute(
            f"""SELECT t.id, t.account_id, t.content_hash, t.date, t.authorized_date, t.raw_name,
                       t.merchant_name, t.display_name, t.amount, t.import_evidence_json, t.import_batch_id,
                       COALESCE(a.parent_account_id, a.id) AS effective_account_id
                FROM   txn t JOIN account a ON a.id = t.account_id
                WHERE  COALESCE(a.parent_account_id, a.id) IN ({ph})
                  AND  t.is_pending = 0
                  AND  t.content_hash IS NOT NULL""",
            list(relevant_effective_account_ids),
        ).fetchall():
            if _from_excluded_batch(r):
                continue
            scope_hashes = existing_hashes_by_effective_account.setdefault(r["effective_account_id"], {})
            if r["content_hash"] not in scope_hashes:
                summary = _summary(r, "linked_account_group")
                scope_hashes[r["content_hash"]] = {
                    k: summary[k] for k in ("id", "date", "merchant_name", "amount", "account_id", "import_batch_id")
                }
            summary_row = _summary(r, "linked_account_group")
            for stored_date in _row_date_variants(r):
                key = duplicate_amount_key(stored_date, r["amount"])
                existing_rows_by_effective_account_amount.setdefault(r["effective_account_id"], {}).setdefault(key, []).append(summary_row)

    # A data connection's coverage lives on `connection_account`, not on its sync cards: a cursor delta
    # is not a date range (it is "everything new since a checkpoint", scattered across arbitrary dates),
    # so only the *chain* carries a claim. Folded in here so the ladder sees one coverage picture
    # regardless of which shape recorded it.
    #
    # `exclude_connection_ids` is the ingesting connection itself, and the asymmetry is load-bearing.
    # A CSV re-import of an already-covered range IS a duplicate — the user handed us the same range
    # twice. A sync delta inside its own connection's covered range is NOT: the provider just told us
    # about a late-posting charge, and the claim was only ever "everything the provider has told us
    # about is here", never "nothing more will arrive for these dates". Without this exclusion every
    # late arrival would be rejected against the connection's own coverage.
    connection_coverage_query = """
        SELECT ca.account_id, ca.coverage_start_date, ca.coverage_through_date,
               ca.terminal_window_days, ca.connection_id,
               ca.provider_name, ca.provider_mask, ca.external_account_id
        FROM   connection_account ca
        WHERE  ca.account_id IS NOT NULL
          AND  ca.mapping_mode IS NOT NULL
          AND  ca.mapping_mode != 'skip'
          AND  ca.coverage_start_date IS NOT NULL
          AND  ca.coverage_through_date IS NOT NULL
    """
    connection_coverage_params: list[str] = []
    if exclude_connection_ids:
        connection_coverage_query += f" AND ca.connection_id NOT IN ({_placeholders(exclude_connection_ids)})"
        connection_coverage_params.extend(exclude_connection_ids)

    # A connection's trailing window needs candidate SLOTS as well as a shortened coverage range, and
    # they cannot come from the `import_batch_account` pass below: a sync card deliberately records no
    # terminal date (routers/sync.py — a cursor delta is not a date range), so `connection_account` is the
    # only thing that knows where a connection's trailing edge falls. Without these, a connection got the
    # coverage carve-out with none of the reconciliation it exists to enable — a `terminal_window_days`-
    # wide hole at the trailing edge of its coverage, in which neither the coverage rules nor Rule 5 could
    # fire, and through which a second source's copy of a charge imported silently.
    connection_terminal_lookup: dict[tuple[str, str, str], dict] = {}
    connection_terminal_dates: set[str] = set()
    connection_terminal_ids: set[str] = set()

    for row in conn.execute(connection_coverage_query, connection_coverage_params).fetchall():
        account_id = str(row["account_id"] or "").strip()
        scope_id = scope_id_for(account_id, "")
        if account_id not in relevant_account_ids and scope_id not in current_scope_ids:
            continue
        label = provider_account_label(row)
        window_days = terminal_window_days_for(row)
        connection_id = str(row["connection_id"] or "").strip()

        # Slots are registered BEFORE the coverage checks below, which `continue` past a connection whose
        # coverage is entirely swallowed by its own lag. Such a connection still has a trailing window,
        # and its rows are still the candidates Rule 5 must reconcile an incoming row against.
        if connection_id and account_id:
            for soft_date in terminal_window_dates(row["coverage_through_date"], window_days):
                connection_terminal_lookup[(connection_id, account_id, soft_date)] = {
                    "csv_value": label, "scope_id": scope_id,
                }
                connection_terminal_dates.add(soft_date)
            connection_terminal_ids.add(connection_id)

        # The trailing edge of a connection's coverage is soft for the same reason a file's is: the
        # provider lags the bank, so its most recent days are still filling in.
        soft_start = terminal_window_start(row["coverage_through_date"], window_days)
        end_date = None
        if soft_start:
            parsed = _parse_iso_date(soft_start)
            end_date = (parsed - timedelta(days=1)).isoformat() if parsed else None
        if not end_date or not row["coverage_start_date"] or end_date < row["coverage_start_date"]:
            continue
        entry = {
            "start_date": row["coverage_start_date"],
            "end_date": end_date,
            "csv_value": label,
            "account_id": account_id,
            "batch_id": None,
        }
        import_coverage_by_csv_value.setdefault(label, []).append(entry)
        if scope_id:
            import_coverage_by_scope_id.setdefault(scope_id, []).append(entry)

    if connection_terminal_lookup:
        # The connection's own rows on those days, keyed into the SAME two indexes a file's terminal rows
        # feed, so Rule 5 consumes them without knowing which shape recorded them. The source label comes
        # from the current mapping rather than from each row's captured evidence — the same priority
        # `_source_label_for_row` applies, and for the same reason: rows synced before a mapping existed
        # carry whatever the sync could name them at the time, and judging them under that label would key
        # into maps that hold nothing.
        for row in conn.execute(
            f"""SELECT t.id, t.account_id, t.content_hash, t.date, t.raw_name, t.merchant_name,
                       t.display_name, t.amount, t.import_evidence_json, t.import_batch_id,
                       b.connection_id
                FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
                WHERE  b.connection_id IN ({_placeholders(connection_terminal_ids)})
                  AND  t.date IN ({_placeholders(connection_terminal_dates)})
                  AND  t.is_pending = 0
                  AND  t.content_hash IS NOT NULL""",
            [*connection_terminal_ids, *connection_terminal_dates],
        ).fetchall():
            terminal_meta = connection_terminal_lookup.get((
                str(row["connection_id"] or "").strip(),
                str(row["account_id"] or "").strip(),
                str(row["date"] or "").strip(),
            ))
            if not terminal_meta or _from_excluded_batch(row):
                continue
            csv_value = terminal_meta["csv_value"]
            candidate = {
                "id": row["id"],
                "date": row["date"],
                "merchant_name": row["display_name"] or row["merchant_name"] or row["raw_name"],
                "amount": row["amount"],
                "content_hash": row["content_hash"],
                "match_texts": collect_duplicate_match_texts(
                    merchant_name=row["merchant_name"],
                    display_name=row["display_name"],
                    raw_name=row["raw_name"],
                    import_evidence=parse_import_evidence(row["import_evidence_json"]),
                ),
                "csv_value": csv_value,
                "scope_id": terminal_meta.get("scope_id"),
                "_consumed": False,
            }
            terminal_day_candidates_by_csv_day.setdefault((csv_value, row["date"]), []).append(candidate)
            if terminal_meta.get("scope_id"):
                terminal_day_candidates_by_scope_day.setdefault(
                    (terminal_meta["scope_id"], row["date"]), []
                ).append(candidate)

    # `terminal_window_days` comes from the source that produced the batch: a saved CSV data source
    # (csv_import_profile) or a connection account. A batch with neither — a one-off file import — falls
    # back to the default of 1, the original single-terminal-day behavior.
    coverage_query = """
        SELECT iba.batch_id, iba.csv_value, iba.account_id,
               iba.coverage_start_date, iba.coverage_end_date, iba.terminal_date,
               COALESCE(p.terminal_window_days, ca.terminal_window_days) AS terminal_window_days
        FROM   import_batch_account iba
        JOIN   import_batch b ON b.id = iba.batch_id
        LEFT   JOIN csv_import_profile p ON p.id = b.profile_id
        LEFT   JOIN connection_account ca
               ON ca.connection_id = b.connection_id AND ca.account_id = iba.account_id
        WHERE  b.status = 'completed'
          AND  iba.was_skipped = 0
    """
    coverage_params: list[str] = []
    if exclude_batch_ids:
        coverage_query += f" AND b.id NOT IN ({_placeholders(exclude_batch_ids)})"
        coverage_params.extend(exclude_batch_ids)

    terminal_batch_lookup: dict[tuple[str, str, str], dict] = {}
    terminal_batch_ids: set[str] = set()
    terminal_dates: set[str] = set()
    for row in conn.execute(coverage_query, coverage_params).fetchall():
        csv_value = str(row["csv_value"] or "").strip()
        scope_id = scope_id_for(row["account_id"], csv_value)
        # Only coverage that could bear on THIS pass: the same source label, or the same account
        # scope. Everything else is another account's history and is irrelevant here.
        if csv_value not in source_values and scope_id not in current_scope_ids:
            continue
        entry = {
            "start_date": row["coverage_start_date"],
            "end_date": row["coverage_end_date"],
            "csv_value": csv_value,
            "account_id": str(row["account_id"] or "").strip() or None,
            "batch_id": str(row["batch_id"] or "").strip() or None,
        }
        if csv_value and entry["start_date"] and entry["end_date"]:
            import_coverage_by_csv_value.setdefault(csv_value, []).append(entry)
        if scope_id and entry["start_date"] and entry["end_date"]:
            import_coverage_by_scope_id.setdefault(scope_id, []).append(entry)
        terminal_date = str(row["terminal_date"] or "").strip()
        if terminal_date and entry["batch_id"]:
            # Index a candidate slot for EVERY day in the source's soft trailing window, not just the
            # terminal day. At the default window of 1 this is exactly the single terminal date, so a
            # file source keys identically to before; a lagging source gets its whole soft edge
            # reconciled one-to-one instead of blanket-rejected.
            window = terminal_window_days_for(row)
            for soft_date in terminal_window_dates(terminal_date, window):
                terminal_batch_lookup[(entry["batch_id"], csv_value, soft_date)] = {
                    "batch_id": entry["batch_id"], "csv_value": csv_value,
                    "terminal_date": terminal_date, "scope_id": scope_id,
                }
                terminal_dates.add(soft_date)
            terminal_batch_ids.add(entry["batch_id"])

    if terminal_batch_ids and terminal_dates:
        for row in conn.execute(
            f"""SELECT id, import_batch_id, account_id, content_hash, date, raw_name, merchant_name,
                       display_name, amount, import_evidence_json
                FROM   txn
                WHERE  import_batch_id IN ({_placeholders(terminal_batch_ids)})
                  AND  date IN ({_placeholders(terminal_dates)})
                  AND  is_pending = 0""",
            [*terminal_batch_ids, *terminal_dates],
        ).fetchall():
            evidence = parse_import_evidence(row["import_evidence_json"])
            evidence_account = evidence.get("account") if isinstance(evidence, dict) else None
            # A row's own source label lives in its captured evidence — which is why every ingestion
            # path must write it, or its rows can never serve as terminal-day candidates.
            csv_value = str((evidence_account or {}).get("value") or "").strip() if isinstance(evidence_account, dict) else ""
            terminal_meta = terminal_batch_lookup.get(
                (str(row["import_batch_id"] or "").strip(), csv_value, str(row["date"] or "").strip())
            )
            if not terminal_meta:
                continue
            candidate = {
                "id": row["id"],
                "date": row["date"],
                "merchant_name": row["display_name"] or row["merchant_name"] or row["raw_name"],
                "amount": row["amount"],
                "content_hash": row["content_hash"],
                "match_texts": collect_duplicate_match_texts(
                    merchant_name=row["merchant_name"],
                    display_name=row["display_name"],
                    raw_name=row["raw_name"],
                    import_evidence=evidence,
                ),
                "csv_value": csv_value,
                "scope_id": terminal_meta.get("scope_id"),
                "_consumed": False,
            }
            terminal_day_candidates_by_csv_day.setdefault((csv_value, row["date"]), []).append(candidate)
            if terminal_meta.get("scope_id"):
                terminal_day_candidates_by_scope_day.setdefault((terminal_meta["scope_id"], row["date"]), []).append(candidate)

    return DedupeContext(
        existing_hashes_by_account=existing_hashes_by_account,
        existing_hashes_by_effective_account=existing_hashes_by_effective_account,
        existing_rows_by_account_amount=existing_rows_by_account_amount,
        existing_rows_by_effective_account_amount=existing_rows_by_effective_account_amount,
        import_coverage_by_csv_value=import_coverage_by_csv_value,
        import_coverage_by_scope_id=import_coverage_by_scope_id,
        terminal_day_candidates_by_csv_day=terminal_day_candidates_by_csv_day,
        terminal_day_candidates_by_scope_day=terminal_day_candidates_by_scope_day,
        accounts_with_prior_history=accounts_with_prior_history,
        explicit_alias_csv_values=alias_values,
        account_duplicate_compare_targets=compare_targets,
        coverage_strategy_enabled=coverage_strategy_enabled,
        text_strategy_enabled=text_strategy_enabled,
        conn=conn,
        scope_id_for=scope_id_for,
    )


def _sorted_pair(a: str, b: str) -> tuple[str, str]:
    """Return (a, b) sorted so the lower id comes first. Used everywhere account_pair_distinct
    is read or written — the table stores pairs canonically (account_id_low < account_id_high)
    so each pair has exactly one row regardless of which direction surfaced first."""
    a = str(a); b = str(b)
    return (a, b) if a < b else (b, a)


def record_account_pair_distinct(conn: sqlite3.Connection, account_id_a: str, account_id_b: str) -> dict:
    """Record "these two accounts are different physical accounts", and clear every cross-account
    suspect flag the assertion has just made meaningless.

    **The two halves are one operation and must not be separated.** The assertion suppresses *future*
    detection between the pair; if the flags already raised were left standing, the same evidence would
    read as a problem before the assertion and as nothing after it, and the user would be staring at rows
    that can never be flagged again. So resolving them is not a convenience — it is what makes the
    assertion consistent with itself.

    That is deliberately the opposite of what a **merge** does with the same rows. "Different accounts"
    makes every cross-account flag between them a false positive *by definition*, whatever tier the
    evidence was, so clearing all of them destroys nothing. "Same account" only makes the *exact* matches
    duplicates — a near-miss within one account is a genuinely different question (two similar real
    transactions, or one recorded twice?) — which is why `promote_in_group_suspects_to_confirmed` leaves
    the review-only tiers alone. Same rows, opposite answers, and both are right.

    A same-account pair is refused rather than recorded: a `(X, X)` row would be matched by the sweep's
    own MIN/MAX filter for every future candidate on that account, switching detection off there
    permanently. Returns the pair and how many flags the assertion resolved.
    """
    if not account_id_a or not account_id_b or str(account_id_a) == str(account_id_b):
        return {"recorded": False, "resolved": 0}
    low, high = _sorted_pair(account_id_a, account_id_b)
    conn.execute(
        """
        INSERT OR IGNORE INTO account_pair_distinct (account_id_low, account_id_high, asserted_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        """,
        (low, high),
    )
    cursor = conn.execute(
        """
        UPDATE txn
        SET    suspect_duplicate_of = NULL,
               suspect_duplicate_reason = NULL,
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE  id IN (
            SELECT t1.id
            FROM   txn t1
            JOIN   txn t2 ON t2.id = t1.suspect_duplicate_of
            WHERE  t1.suspect_duplicate_of IS NOT NULL
              AND  t1.suspect_resolved_at IS NULL
              AND  t1.trashed_at IS NULL
              AND  ((t1.account_id = ? AND t2.account_id = ?)
                 OR (t1.account_id = ? AND t2.account_id = ?))
        )
        """,
        (low, high, high, low),
    )
    return {"recorded": True, "resolved": cursor.rowcount or 0,
            "account_id_low": low, "account_id_high": high}


def unresolved_account_pairs(conn: sqlite3.Connection, batch_id: str) -> list[dict]:
    """The account pairs this batch's still-unresolved cross-account flags span, with counts and names.

    What the duplicate report needs to ask the only question that actually settles such a pile: are these
    two accounts the same account or not? Both answers are terminal — merge them, or record them as
    distinct — and each resolves every flag between them, so N coincidences between one pair are one
    decision rather than N. That decision used to ride along invisibly on Keep; asking it needs the pairs
    named, which is what this returns.

    `can_merge` is decided here rather than in the browser because it is a *rule*, and the merge rule
    already exists on the account side (`attach_account`): both accounts need a type and an owner, the
    types must match, the owners must be compatible (identical, or either one shared), and neither may
    already be a child — grouping is one level deep. A second copy of that in the report is exactly how
    the two would come to disagree about whether a merge is offerable.
    """
    rows = conn.execute(
        """
        SELECT
            MIN(a1.id, a2.id) AS account_id_low,
            MAX(a1.id, a2.id) AS account_id_high,
            COUNT(*)          AS flag_count,
            MIN(a1.id, a2.id) = a1.id AS low_is_incoming,
            a1.id AS incoming_id,
            COALESCE(NULLIF(a1.display_name, ''), a1.name) AS incoming_name,
            a1.mask AS incoming_mask, a1.type AS incoming_type,
            a1.owner_id AS incoming_owner_id, a1.parent_account_id AS incoming_parent,
            a2.id AS matched_id,
            COALESCE(NULLIF(a2.display_name, ''), a2.name) AS matched_name,
            a2.mask AS matched_mask, a2.type AS matched_type,
            a2.owner_id AS matched_owner_id, a2.parent_account_id AS matched_parent
        FROM   txn t1
        JOIN   txn t2      ON t2.id = t1.suspect_duplicate_of
        JOIN   account a1  ON a1.id = t1.account_id
        JOIN   account a2  ON a2.id = t2.account_id
        WHERE  t1.import_batch_id = ?
          AND  t1.suspect_duplicate_of IS NOT NULL
          AND  t1.suspect_resolved_at IS NULL
          AND  t1.trashed_at IS NULL
          AND  a1.id <> a2.id
        GROUP  BY account_id_low, account_id_high
        ORDER  BY flag_count DESC
        """,
        (batch_id,),
    ).fetchall()
    shared_owner = _shared_owner_id(conn)
    out = []
    for r in rows:
        owners = {r["incoming_owner_id"], r["matched_owner_id"]}
        can_merge = bool(
            r["incoming_type"] and r["matched_type"]
            and r["incoming_owner_id"] and r["matched_owner_id"]
            and r["incoming_type"] == r["matched_type"]
            and (len(owners) == 1 or (shared_owner and shared_owner in owners))
            and not r["incoming_parent"] and not r["matched_parent"]
        )
        out.append({
            "account_id_low": r["account_id_low"], "account_id_high": r["account_id_high"],
            "flag_count": r["flag_count"], "can_merge": can_merge,
            # Named from the *incoming* side first: that is the account the user just imported into, and
            # the one they are deciding about. The pair's canonical ordering is an index detail.
            "incoming": {"id": r["incoming_id"], "name": r["incoming_name"], "mask": r["incoming_mask"]},
            "matched":  {"id": r["matched_id"], "name": r["matched_name"], "mask": r["matched_mask"]},
        })
    return out


def _shared_owner_id(conn: sqlite3.Connection) -> Optional[str]:
    """The shared owner's id. A shared account merges with any personal account of the same type —
    shared ownership usually reflects a life-stage change rather than a permanent category."""
    from backend.db.database import SHARED_OWNER_ID
    return SHARED_OWNER_ID


def list_distinct_account_pairs(conn: sqlite3.Connection) -> list[dict]:
    """Return every recorded distinct-account assertion the user has made, joined to the account display
    names so the management UI can render them without a follow-up fetch."""
    rows = conn.execute(
        """
        SELECT
            p.account_id_low, p.account_id_high, p.asserted_at,
            a_low.name           AS account_low_name,
            a_low.display_name   AS account_low_display_name,
            a_low.mask           AS account_low_mask,
            a_high.name          AS account_high_name,
            a_high.display_name  AS account_high_display_name,
            a_high.mask          AS account_high_mask
        FROM   account_pair_distinct p
        JOIN   account a_low  ON a_low.id  = p.account_id_low
        JOIN   account a_high ON a_high.id = p.account_id_high
        ORDER  BY p.asserted_at DESC
        """
    ).fetchall()
    return [dict(r) for r in rows]


def record_suspect_pair_distinct(conn: sqlite3.Connection, txn_id_a: str, txn_id_b: str,
                                 *, flagged_txn_id: str | None = None,
                                 reason: str | None = None) -> None:
    """Record "the user judged these two rows not the same charge".

    The row-level counterpart of `account_pair_distinct`, and the thing Keep never had. Keep clears its
    own row's flag and stamps `suspect_resolved_at`, but neither names the *pair* — so a re-scan cannot
    tell a row it has never examined from one the user has already judged, and re-raises the finding while
    clearing the stamp that was the only evidence of the decision. Deliberately **not** the account-level
    assertion, which Keep used to write and stopped writing for good reason: this says nothing about the
    accounts, only about these two rows."""
    low, high = _sorted_pair(txn_id_a, txn_id_b)
    if low == high:
        return
    conn.execute(
        """INSERT OR IGNORE INTO suspect_pair_distinct
               (txn_id_low, txn_id_high, flagged_txn_id, reason, asserted_at)
           VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""",
        (low, high, flagged_txn_id, reason),
    )


def forget_suspect_pair_distinct(conn: sqlite3.Connection, txn_id_a: str, txn_id_b: str) -> dict:
    """Undo one such judgement, so detection may raise the pair again. The escape hatch matters because
    the assertion is otherwise permanent by design: a misclick is a different thing from a decision."""
    low, high = _sorted_pair(txn_id_a, txn_id_b)
    cursor = conn.execute(
        "DELETE FROM suspect_pair_distinct WHERE txn_id_low = ? AND txn_id_high = ?", (low, high))
    return {"deleted": cursor.rowcount or 0}


def reopen_suspect_pair(conn: sqlite3.Connection, txn_id_a: str, txn_id_b: str) -> dict:
    """Undo one Keep: forget the judgement **and** put the finding back.

    Both halves or neither. Forgetting alone would leave the pair unflagged until some later scan
    happened to re-raise it, so an Undo would appear to have done nothing — and the user would have no
    way to tell that from a failure. The flag is restored from what was recorded at Keep rather than
    re-derived, because the matching rules may have moved since and a re-derivation could restore a
    different finding from the one being undone."""
    low, high = _sorted_pair(txn_id_a, txn_id_b)
    judged = conn.execute(
        "SELECT flagged_txn_id, reason FROM suspect_pair_distinct WHERE txn_id_low = ? AND txn_id_high = ?",
        (low, high),
    ).fetchone()
    if judged is None:
        return {"reopened": False, "reason": "not_judged"}
    flagged = judged["flagged_txn_id"]
    matched = high if flagged == low else low
    conn.execute("DELETE FROM suspect_pair_distinct WHERE txn_id_low = ? AND txn_id_high = ?", (low, high))
    if not flagged:
        # A v47-era judgement, recorded before the flag was remembered. The assertion is lifted so
        # detection may raise the pair again, but this call cannot say what the finding looked like.
        return {"reopened": False, "reason": "flag_not_recorded", "forgotten": True}
    conn.execute(
        """UPDATE txn SET suspect_duplicate_of = ?, suspect_duplicate_reason = ?,
                          suspect_resolved_at = NULL
           WHERE id = ?""",
        (matched, judged["reason"], flagged),
    )
    return {"reopened": True, "txn_id": flagged, "matched_txn_id": matched}


def list_suspect_pair_distinct(conn: sqlite3.Connection, limit: int = 500) -> list[dict]:
    """Every judged pair with enough of both rows to recognise it. For the management surface, which
    exists for the same reason the distinct-account one does: this is a durable decision the user cannot
    otherwise see, and one they can only have made in passing."""
    rows = conn.execute(
        """
        SELECT p.txn_id_low, p.txn_id_high, p.flagged_txn_id, p.reason, p.asserted_at,
               lo.date AS low_date,  lo.amount AS low_amount,
               COALESCE(lo.display_name, lo.merchant_name, lo.raw_name) AS low_name,
               la.display_name AS low_account,
               hi.date AS high_date, hi.amount AS high_amount,
               COALESCE(hi.display_name, hi.merchant_name, hi.raw_name) AS high_name,
               ha.display_name AS high_account
        FROM   suspect_pair_distinct p
        JOIN   txn lo ON lo.id = p.txn_id_low
        JOIN   txn hi ON hi.id = p.txn_id_high
        LEFT   JOIN account la ON la.id = lo.account_id
        LEFT   JOIN account ha ON ha.id = hi.account_id
        ORDER  BY p.asserted_at DESC
        LIMIT  ?
        """,
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def load_suspect_pair_distinct(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    """Every judged pair, canonically sorted, for the in-Python scan to skip."""
    return {(r["txn_id_low"], r["txn_id_high"])
            for r in conn.execute("SELECT txn_id_low, txn_id_high FROM suspect_pair_distinct")}


def forget_account_pair_distinct(conn: sqlite3.Connection,
                                  account_id_a: str, account_id_b: str) -> dict:
    """Remove a recorded distinct-account assertion. The next import touching both accounts
    will re-evaluate matches between them and may surface fresh suspects. The user's prior
    transaction-level resolutions (Keep/Reject) on specific rows are not touched."""
    low, high = _sorted_pair(account_id_a, account_id_b)
    cursor = conn.execute(
        "DELETE FROM account_pair_distinct WHERE account_id_low = ? AND account_id_high = ?",
        (low, high),
    )
    return {"deleted": cursor.rowcount or 0}


def clear_account_pair_distinct_for_merge(conn: sqlite3.Connection,
                                           account_ids: Iterable[str]) -> int:
    """When two accounts are merged, the user is asserting they're the same physical account.
    That contradicts any prior 'distinct accounts' assertion between them — delete any such
    row so the new declaration is the truth of record."""
    account_id_list = [aid for aid in (account_ids or []) if aid]
    if len(account_id_list) < 2:
        return 0
    placeholders = _placeholders(account_id_list)
    cursor = conn.execute(
        f"""
        DELETE FROM account_pair_distinct
        WHERE  account_id_low  IN ({placeholders})
          AND  account_id_high IN ({placeholders})
        """,
        [*account_id_list, *account_id_list],
    )
    return cursor.rowcount or 0


def restore_auto_merged_after_detach(conn: sqlite3.Connection,
                                      detached_account_id: str,
                                      remaining_group_account_ids: Iterable[str]) -> int:
    """When an account is detached from its merged group, reverse the auto-promotion that
    `promote_in_group_suspects_to_confirmed` did during the original merge — but ONLY for rows
    the marker tags as automatic ('auto_merge'). User-explicit Reject decisions
    (dedupe_resolved_by='user') are left alone; the user's deliberate "yes, this is a duplicate"
    stays in effect even after the accounts are taken apart.

    A restored row goes back to its prior state: trashed_at/rejection_reason/suspect_resolved_at
    cleared, suspect_duplicate_of preserved as the audit pointer. It re-appears as an active
    suspect in the duplicate-detection dialog so the user can Keep, Reject, or leave alone.

    Symmetry matters here. Promotion graduates a soft-flag based on the *pair* — it trashes the
    suspect-holding row (`t1`, the one carrying `suspect_duplicate_of`) whenever either endpoint
    of the pair lands in the merged group. So the trashed `auto_merge` row can sit on *either*
    side of the detached↔remaining split: it might be on the detaching account pointing at a
    canonical in the remaining group, OR on a remaining-group account pointing at a canonical on
    the detaching account (this is exactly the case where the imported file that holds the
    suspect was on the account that stays, and the merge target it duplicated was the account
    being pulled out). Reversing only the first orientation strands the second permanently, so we
    undo both. In both orientations one endpoint is the detaching account and the other is in the
    remaining group — that constraint is what keeps the reversal scoped to the promotions this
    particular detach is splitting, leaving promotions wholly inside the remaining group alone.

    `remaining_group_account_ids` is the set of accounts still in the (formerly merged) group
    after the detach. Only pairs that straddle the detach boundary are reversed.

    Returns the count of rows restored.
    """
    remaining_ids = [aid for aid in (remaining_group_account_ids or []) if aid]
    if not detached_account_id or not remaining_ids:
        return 0
    placeholders = _placeholders(remaining_ids)
    cursor = conn.execute(
        f"""
        UPDATE txn
        SET    trashed_at = NULL,
               rejection_reason = NULL,
               suspect_resolved_at = NULL,
               dedupe_resolved_by = NULL
        WHERE  dedupe_resolved_by = 'auto_merge'
          AND  rejection_reason = 'duplicate_confirmed'
          AND  (
                 -- trashed row on the detaching account, its canonical in the remaining group
                 (account_id = ?
                  AND suspect_duplicate_of IN (
                        SELECT id FROM txn WHERE account_id IN ({placeholders})))
                 -- mirror: trashed row on a remaining-group account, its canonical on the detaching account
              OR (account_id IN ({placeholders})
                  AND suspect_duplicate_of IN (
                        SELECT id FROM txn WHERE account_id = ?))
               )
        """,
        [detached_account_id, *remaining_ids, *remaining_ids, detached_account_id],
    )
    return cursor.rowcount or 0


def _select_best_cross_account_matches(candidate_rows) -> list[dict]:
    """From the raw (new-row × existing-row) candidate pairs — already narrowed in SQL to cross-account,
    equal rounded amount, within the date window, cross-batch, and not `account_pair_distinct` — keep at
    most ONE existing match per new row and classify it.

    Selection order per new row: strongest text match (exact before fuzzy), then closest date (so a near-
    date candidate never displaces an exact-day twin), then lowest existing id. Pairs whose source texts
    don't match at all are dropped, as are pairs carrying explicit, different check numbers (two distinct
    checks can share date/amount). Returns [{new_id, existing_id, reason}] with reason `'cross_account'`
    for an exact text match or `'cross_account_fuzzy'` for a near-miss (review-only) match.
    """
    text_cache: dict = {}

    def _texts(merchant, raw, evidence):
        key = (merchant, raw, evidence)
        cached = text_cache.get(key)
        if cached is None:
            cached = row_match_texts(merchant, raw, evidence)
            text_cache[key] = cached
        return cached

    best_by_new: dict[str, dict] = {}
    for r in candidate_rows:
        if are_distinct_checks(r["new_merchant"], r["existing_merchant"]):
            continue
        kind = classify_source_text_relation(
            _texts(r["new_merchant"], r["new_raw"], r["new_evidence"]),
            _texts(r["existing_merchant"], r["existing_raw"], r["existing_evidence"]),
        )
        if kind is None:
            continue
        rank = (
            _TEXT_RELATION_RANK[kind],
            _date_distance_days(r["new_date"], r["existing_date"]),
            str(r["existing_id"]),
        )
        current = best_by_new.get(r["new_id"])
        if current is None or rank < current["_rank"]:
            best_by_new[r["new_id"]] = {
                "new_id": r["new_id"],
                "existing_id": r["existing_id"],
                "reason": _TEXT_RELATION_REASONS[kind],
                "_rank": rank,
            }
    return list(best_by_new.values())


def mark_import_suspects(conn: sqlite3.Connection, batch_id: str, *,
                         txn_ids: list[str] | None = None,
                         exclude_pairs: set[tuple[str, str]] | None = None) -> int:
    """After a batch's transactions have been inserted, flag every cross-batch cross-SOURCE match by
    (date-window, amount, source text) as a soft-flag suspect — unless the pair of accounts is already in
    `account_pair_distinct` (the user has previously declared them distinct). Returns the number flagged.

    `txn_ids` narrows the sweep to specific rows of the batch, for a caller that adds to a batch it has
    added to before. A **sync** is that caller: a connection's whole first backfill files into one
    "Initial import" card, and a metered provider delivers it across many calls — so the default
    whole-batch sweep re-examines every row imported so far to check the handful just added, and the cost
    of each resumption grows with everything that preceded it. One real backfill reached 7,266 rows on the
    card, at which point adding 172 rows cost a 109-second sweep. A CSV import passes nothing: its batch
    *is* the rows it just added, so the two are the same sweep.

    `exclude_pairs` drops specific (new row, existing row) pairs from consideration — a question the user
    has already answered, which this sweep must not re-ask. "Import anyway" is that answer: the importer
    rejected the row as a duplicate of a named existing transaction and the user overruled it, so pairing
    the two again returns the settled question as review work. Excluding the **pair** rather than skipping
    the row is what keeps the rest of the check: a forced row is an ordinary transaction in the ledger and
    may well duplicate something *else*, and this is the only pass that ever compares it backward against
    what already existed. It also un-masks that other match — selection keeps at most one match per new
    row, and an overridden pair is byte-identical and same-day, so it outranked every other candidate and
    hid it.

    The check runs for ALL rows in the batch (or in `txn_ids`); there is no "brand-new account" gate. The
    `account_pair_distinct` filter is what keeps the output non-noisy after the user has reviewed each
    pair once. Text matching compares the UNION of each row's captured texts (`source_match_texts`): an
    exact (byte-identical) match flags `'cross_account'` (high confidence — auto-confirmed on merge); a
    near-miss above `CROSS_ACCOUNT_FUZZY_RATIO` flags `'cross_account_fuzzy'`; two shared distinctive
    tokens flag `'cross_account_weak'`. The last two are review-only and never auto-confirmed. See the
    module-level notes above `CROSS_ACCOUNT_FUZZY_RATIO` and `_WEAK_SHARED_TOKEN_FLOOR`.

    Pairs are drawn from rows on **different accounts** OR from rows on one account that arrived from two
    different sources — see the comment on the SQL condition for why the second is not a widening of the
    first but a statement of what the first was always standing in for.

    Within-batch (same-batch) pairs are skipped: the source asserts via the CSV that two rows on
    different accounts in the same file are distinct transactions, even if they share date/amount/text.
    Cross-batch pairs are candidates.
    """
    # SQL narrows to same-amount, ±window-day (transaction vs posted date), cross-source, cross-batch,
    # not-distinct candidate pairs; the text match + closest-date-wins selection happens in Python
    # (`_select_best_cross_account_matches`) because comparing evidence-JSON fields per row can't be
    # expressed in the join. Returns every candidate pair, then one existing match is kept per new row.
    window = CROSS_ACCOUNT_DATE_WINDOW_DAYS
    candidates = _cross_account_candidates(conn, batch_id, window, txn_ids)
    if exclude_pairs:
        # Filtered here rather than in SQL, and before selection so the next-best candidate can win the
        # place the excluded pair was holding.
        candidates = [r for r in candidates
                      if (r["new_id"], r["existing_id"]) not in exclude_pairs]
    if not candidates:
        return 0
    matches = _select_best_cross_account_matches(candidates)
    if not matches:
        return 0
    conn.executemany(
        """
        UPDATE txn
        SET    suspect_duplicate_of = ?,
               suspect_duplicate_reason = ?,
               suspect_resolved_at = NULL
        WHERE  id = ?
        """,
        [(m["existing_id"], m["reason"], m["new_id"]) for m in matches],
    )
    return len(matches)


# Chunked so a caller may pass more ids than SQLite will bind in one statement. Splitting on `t1` is safe
# because selection keeps at most one match per *new* row (`_select_best_cross_account_matches` groups by
# `new_id`), so no candidate pair is separated from a rival it would have been ranked against.
_CANDIDATE_ID_CHUNK = 400


def _cross_account_candidates(conn: sqlite3.Connection, batch_id: str, window: int,
                              txn_ids: list[str] | None):
    """The raw (new row × existing row) pairs for `mark_import_suspects`, narrowed in SQL."""
    def _run(id_clause: str, id_params: list) -> list:
        return conn.execute(
            _CROSS_ACCOUNT_CANDIDATE_SQL.format(id_clause=id_clause),
            (*([f"-{window} days", f"+{window} days"] * 3), batch_id, *id_params),
        ).fetchall()

    if txn_ids is None:
        return _run("", [])
    rows: list = []
    for start in range(0, len(txn_ids), _CANDIDATE_ID_CHUNK):
        chunk = txn_ids[start:start + _CANDIDATE_ID_CHUNK]
        if not chunk:
            continue
        rows.extend(_run(f"AND t1.id IN ({','.join('?' * len(chunk))})", list(chunk)))
    return rows


_CROSS_ACCOUNT_CANDIDATE_SQL = """
        SELECT
          t1.id AS new_id, t1.date AS new_date,
          t1.merchant_name AS new_merchant, t1.raw_name AS new_raw,
          t1.import_evidence_json AS new_evidence,
          t2.id AS existing_id, t2.date AS existing_date,
          t2.merchant_name AS existing_merchant, t2.raw_name AS existing_raw,
          t2.import_evidence_json AS existing_evidence
        FROM   txn t1
        LEFT   JOIN import_batch b1 ON b1.id = t1.import_batch_id
        JOIN   txn t2
          ON   t2.id != t1.id
          -- Either row's dates may line up: two sources routinely publish the transaction date and
          -- the posted date for the same charge, so the pair is a candidate if ANY combination falls
          -- inside the window. COALESCE keeps a row with no authorized_date comparing on its own date.
          AND  (   t2.date BETWEEN date(t1.date, ?) AND date(t1.date, ?)
                OR COALESCE(t2.authorized_date, t2.date) BETWEEN date(t1.date, ?) AND date(t1.date, ?)
                OR t2.date BETWEEN date(COALESCE(t1.authorized_date, t1.date), ?)
                               AND date(COALESCE(t1.authorized_date, t1.date), ?))
          AND  ROUND(t2.amount, 2) = ROUND(t1.amount, 2)
          AND  t2.trashed_at IS NULL
          AND  (t2.import_batch_id IS NULL OR t2.import_batch_id != t1.import_batch_id)
          AND  NOT EXISTS (
                SELECT 1
                FROM   account_pair_distinct p
                WHERE  p.account_id_low  = MIN(t1.account_id, t2.account_id)
                  AND  p.account_id_high = MAX(t1.account_id, t2.account_id)
          )
          -- And pairs the user has judged row-by-row. The account-level assertion above answers "are
          -- these two accounts the same?"; this answers "are these two rows the same charge?", which is
          -- a different question and the only one a Keep on a same-account pair ever settled.
          AND  NOT EXISTS (
                SELECT 1
                FROM   suspect_pair_distinct sp
                WHERE  sp.txn_id_low  = MIN(t1.id, t2.id)
                  AND  sp.txn_id_high = MAX(t1.id, t2.id)
          )
        LEFT   JOIN import_batch b2 ON b2.id = t2.import_batch_id
        WHERE  t1.import_batch_id = ?
          AND  t1.trashed_at IS NULL
          AND  t1.suspect_duplicate_of IS NULL
          -- Two rows are comparable when two INDEPENDENT sources describe them. Landing on different
          -- accounts has always implied that, and stays sufficient on its own; it stopped being
          -- NECESSARY once two connections could each map `existing` onto ONE local account, at which
          -- point the same charge arrives twice on that account and an account-difference test cannot
          -- see it. The second arm asks the question directly: different connection, or different file
          -- when neither row came from a connection. Manual rows (no ingesting source) are excluded from
          -- it — they assert nothing about each other, and two same-amount manual entries days apart on
          -- one account are far likelier a legitimate repeat than a duplicate. (In the WHERE rather than
          -- the join's ON only because it reads `b2`, which cannot be joined before t2 itself.)
          AND  (   t2.account_id != t1.account_id
                OR (    COALESCE(b1.connection_id, t1.import_batch_id) IS NOT NULL
                    AND COALESCE(b2.connection_id, t2.import_batch_id) IS NOT NULL
                    AND COALESCE(b1.connection_id, t1.import_batch_id)
                        != COALESCE(b2.connection_id, t2.import_batch_id)))
          {id_clause}
"""


def sweep_import_suspects(conn: sqlite3.Connection, batch_id: str, *,
                          txn_ids: list[str] | None = None) -> None:
    """The post-ingest duplicate sweep, as its two halves are always run together: soft-flag this batch's
    cross-account matches, then promote the ones whose accounts the user has already merged.

    **Stage 2, and it must not run inside the ingest transaction.** It is analysis over the ledger as a
    whole, not part of writing the rows — it reads every account, and on a large ledger it reads for a
    long time. Held inside the write transaction that imported the rows, that time is time no other writer
    can proceed: one 109-second sweep took a sync's request with it, froze the progress panel behind it
    (the sync marker is cleared after the response), and failed every unrelated preference write for the
    duration. Nothing in any caller's response depends on the result — it feeds the card's pills, read
    later — so every caller commits its ingest first and calls this after.
    """
    mark_import_suspects(conn, batch_id, txn_ids=txn_ids)
    # Scoped to the accounts this batch touched: promotion asks "has the user already merged these two
    # accounts", which can only be true for accounts the batch actually landed rows on.
    account_ids = [
        str(r["account_id"]) for r in conn.execute(
            "SELECT DISTINCT account_id FROM txn WHERE import_batch_id = ? AND account_id IS NOT NULL",
            (batch_id,),
        ).fetchall()
    ]
    if account_ids:
        promote_in_group_suspects_to_confirmed(conn, account_ids)


def list_suspects(conn: sqlite3.Connection, *, batch_id: str | None = None, limit: int = 500) -> list[dict]:
    """Return active suspect pairs (flagged, not yet resolved). Each row carries enough context
    for the review UI to render both sides without a follow-up fetch."""
    params: list = []
    clauses = [
        "t1.suspect_duplicate_of IS NOT NULL",
        "t1.suspect_resolved_at IS NULL",
        "t1.trashed_at IS NULL",
    ]
    if batch_id:
        clauses.append("t1.import_batch_id = ?")
        params.append(batch_id)
    where = " AND ".join(clauses)
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT
            t1.id                          AS new_id,
            t1.date                        AS new_date,
            t1.amount                      AS new_amount,
            COALESCE(NULLIF(t1.display_name, ''), NULLIF(t1.merchant_name, ''), NULLIF(t1.raw_name, ''))
                                           AS new_payee,
            a1.display_name                AS new_account_display_name,
            a1.name                        AS new_account_name,
            c1.name                        AS new_category_name,
            t1.import_batch_id             AS new_batch_id,
            t1.suspect_duplicate_reason    AS reason,
            t2.id                          AS existing_id,
            t2.date                        AS existing_date,
            t2.amount                      AS existing_amount,
            COALESCE(NULLIF(t2.display_name, ''), NULLIF(t2.merchant_name, ''), NULLIF(t2.raw_name, ''))
                                           AS existing_payee,
            a2.display_name                AS existing_account_display_name,
            a2.name                        AS existing_account_name,
            c2.name                        AS existing_category_name,
            t2.import_batch_id             AS existing_batch_id
        FROM   txn t1
        JOIN   txn t2                ON t2.id = t1.suspect_duplicate_of
        LEFT JOIN account  a1        ON a1.id = t1.account_id
        LEFT JOIN account  a2        ON a2.id = t2.account_id
        LEFT JOIN category c1        ON c1.id = t1.category_id
        LEFT JOIN category c2        ON c2.id = t2.category_id
        WHERE  {where}
        ORDER  BY t1.date DESC, t1.id
        LIMIT  ?
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def count_active_suspects(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM   txn
        WHERE  suspect_duplicate_of IS NOT NULL
          AND  suspect_resolved_at IS NULL
          AND  trashed_at IS NULL
        """,
    ).fetchone()
    return int(row["n"] if row else 0)


# ---------------------------------------------------------------------------
# Unified per-batch report
# ---------------------------------------------------------------------------
# Hard rejects (from `import_batch_duplicate`) and soft flags (from `txn.suspect_duplicate_of`)
# share a uniform response shape so the import-file card can render them in one place; the
# `kind` field plus a few optional fields in `incoming` distinguish the two cases.


# Maps a free-text reason produced by the import-time rule chain to a stable rule_key + confidence
# tag the UI can group/style on. New reason strings get a fallback of ('other_hard', 'medium')
# until the table is extended; this prevents silent grouping under "unknown" if a rule reason text
# is tweaked without updating the map.
_RULE_REASON_CLASSIFIERS = (
    ("Matches an existing transaction in the linked account group",
     "exact_hash_linked_group", "high"),
    ("Matches an existing transaction",
     "exact_hash_same_account", "high"),
    ("Falls within the fully covered date range from an earlier import for this source account",
     "coverage_same_source", "medium"),
    ("Falls within the fully covered date range from an earlier import in this account scope",
     "coverage_in_scope", "medium"),
    ("Matches a remaining transaction from the terminal covered day in an earlier import for this source account",
     "terminal_day_same_source", "medium"),
    ("Matches a remaining transaction from the terminal covered day in an earlier import in this account scope",
     "terminal_day_in_scope", "medium"),
    ("Possible cross-source match by date, amount, and source text in the linked account group",
     "text_strategy_linked_group", "medium"),
    ("Possible cross-source match by date, amount, and source text in this account",
     "text_strategy_same_account", "medium"),
)

_SOFT_FLAG_CLASSIFIERS = {
    # New unified reason in the per-pair-distinct model.
    "cross_account":      ("cross_account",      "low"),
    # Near-miss text match (same amount + date window, similar-but-not-identical source text). A
    # lower-confidence, review-only tier: never auto-confirmed on merge.
    "cross_account_fuzzy": ("cross_account_fuzzy", "low"),
    # Weakest tier: the descriptors do not resemble each other as strings, but they share at least
    # `_WEAK_SHARED_TOKEN_FLOOR` distinctive words. Review-only, like the fuzzy tier.
    "cross_account_weak": ("cross_account_weak", "low"),
    # Legacy reasons kept in the map for forward-compatibility while old data is being
    # migrated; both map to the same rule_key for UI purposes since they represent the
    # same logical case (cross-account same-(date, amount, payee) match).
    "import_new_account": ("cross_account",      "low"),
    "account_merge":      ("cross_account",      "low"),
    # A row the connection re-scan judged retroactively. Its own key rather than 'cross_account'
    # because the *occasion* is what the user needs explained: this row entered the ledger before the
    # mapping existed, and was re-judged afterwards — not flagged when it arrived.
    "connection_rescan":  ("connection_rescan",  "medium"),
    # Written by Replace onto the row it removes. That row was the *existing* side of someone else's flag,
    # so it had no reason of its own to show, and whatever it did carry described a different pairing.
    "replaced":           ("replaced",           "medium"),
}

# User-facing labels keyed by rule_key. Short label is what shows up in the badge; long label is
# the tooltip. These are intentionally not derived from the reason text so labels can be tuned
# independently of the rule chain's own wording. Keep keys here in sync with the classifiers
# above and with the `_confirmed` suffix used for graduated soft-flags.
_RULE_LABELS = {
    "exact_hash_same_account":         ("Exact match (same account)",
                                        "Identical date, amount, and payee already exist on the receiving account."),
    "exact_hash_linked_group":         ("Exact match (linked group)",
                                        "Identical date, amount, and payee already exist on a sibling account in the same linked group."),
    "coverage_same_source":            ("Date covered (same source)",
                                        "This date falls inside a date range already fully imported from this same source."),
    "coverage_in_scope":               ("Date covered (account)",
                                        "This date falls inside a date range already fully imported for this account from a different source."),
    "terminal_day_same_source":        ("Boundary day (same source)",
                                        "Matches a reserved slot on the boundary day of a prior import from this same source."),
    "terminal_day_in_scope":           ("Boundary day (account)",
                                        "Matches a reserved slot on the boundary day of a prior import for this account."),
    "text_strategy_same_account":      ("Likely match by text (same account)",
                                        "Same date and amount, with similar source text, on the receiving account."),
    "text_strategy_linked_group":      ("Likely match by text (linked group)",
                                        "Same date and amount, with similar source text, on a sibling account in the same linked group."),
    "cross_account":                   ("Cross-account match",
                                        "Same date, amount, and payee as a transaction on a different account. Surfaced for review so you can decide whether the two accounts are actually distinct."),
    "cross_account_confirmed":         ("Cross-account match (confirmed)",
                                        "You confirmed this is the same real-world transaction as one already on a different account; the row stays out of the active ledger."),
    "cross_account_fuzzy":             ("Possible cross-account match",
                                        "Same amount and date, with very similar — but not identical — source text on a different account. Surfaced for review; not auto-removed on merge."),
    "cross_account_fuzzy_confirmed":   ("Possible cross-account match (confirmed)",
                                        "You confirmed this near-match is the same real-world transaction as one on a different account; the row stays out of the active ledger."),
    "cross_account_weak":              ("Same payee, different wording",
                                        "Same amount and a nearby date on a different account, described in different words that still name the same payee. Too little agreement to remove automatically, so it is surfaced for review."),
    "cross_account_weak_confirmed":    ("Same payee, different wording (confirmed)",
                                        "You confirmed these two differently-worded records are the same real-world transaction; the row stays out of the active ledger."),
    # The same four flags once the two accounts have become one (see `_IN_ACCOUNT_RULE_KEYS`). Same
    # evidence, same tiers — only the account relationship the badge asserts is different.
    "in_account":                      ("Duplicate in this account",
                                        "Same date, amount, and payee as another transaction on this account, reported by a second source. Surfaced for review so you can decide which copy to keep."),
    "in_account_confirmed":            ("Duplicate in this account (confirmed)",
                                        "Confirmed as the same real-world transaction as another on this account; the row stays out of the active ledger."),
    "in_account_fuzzy":                ("Possible duplicate in this account",
                                        "Same amount and a nearby date, with very similar — but not identical — source text, on this same account. Similarity alone is not conclusive, so it is surfaced for review rather than removed."),
    "in_account_fuzzy_confirmed":      ("Possible duplicate in this account (confirmed)",
                                        "You confirmed this near-match is the same real-world transaction as another on this account; the row stays out of the active ledger."),
    "in_account_weak":                 ("Same payee, different wording",
                                        "Two sources reported the same amount on the same account within a few days, wording it differently but naming the same payee. Surfaced for review rather than removed, since the wording alone is not conclusive."),
    "in_account_weak_confirmed":       ("Same payee, different wording (confirmed)",
                                        "You confirmed these two differently-worded records are one transaction reported twice on this account; the row stays out of the active ledger."),
    # Legacy keys retained so labels still render correctly for old rows that may exist before
    # the migration sweep has touched them. New rows use the cross_account key above.
    "import_new_account":              ("Cross-account match",
                                        "Same date, amount, and payee as a transaction on a different account."),
    "account_merge":                   ("Cross-account match",
                                        "Same date, amount, and payee as a transaction on a different account."),
    "import_new_account_confirmed":    ("Cross-account match (confirmed)",
                                        "Confirmed duplicate of a transaction on a different account."),
    "account_merge_confirmed":         ("Cross-account match (confirmed)",
                                        "Confirmed duplicate of a transaction on a different account."),
    "connection_rescan":               ("Found by re-scan",
                                        "Matched an existing transaction when this data connection's rows were re-checked after its accounts were mapped."),
    "connection_rescan_confirmed":     ("Found by re-scan (removed)",
                                        "This synced row arrived before its account was mapped, so it was never checked for duplicates. A re-scan matched it to a transaction already in the ledger and removed it; Restore brings it back with its category and edits intact."),
    # Rows removed by a decision rather than flagged by a rule, named for what removed them (see
    # `_REMOVED_WITHOUT_REASON_RULE_KEYS`). The unconfirmed form is what a restored Replace leaves behind.
    "replaced":                        ("Replaced copy (restored)", ""),
    "replaced_confirmed":              ("Replaced by another copy",
                                        "A Replace in a duplicate report kept another copy of this transaction instead."),
    "amazon_merge_confirmed":          ("Merged on Amazon reconciliation",
                                        "Copies of this charge were merged on the Amazon reconciliation report, keeping another one."),
    "other_hard":                      ("Other (hard-reject)", "Hard-rejected with a reason this report does not yet have a friendly label for."),
    "other_soft":                      ("Other (review)",     "Soft-flagged with a reason this report does not yet have a friendly label for."),
    "other_soft_confirmed":            ("Removed as a duplicate", ""),
}

# How a coverage reject's candidate agreed with the incoming row's text — the same three tiers the
# soft-flag rules above name, worded for a row inside a candidate list rather than for a rule badge.
# Applied when the report is READ, not when the verdict is written: the stored candidate carries only
# the tier key, so re-wording these never requires re-importing a file to take effect.
_CANDIDATE_TEXT_RELATION_LABELS = {
    "exact": ("Same wording",
              "A captured description of this transaction is identical to the incoming row's (or is the same text, clipped)."),
    "fuzzy": ("Similar wording",
              "The two descriptions are very similar but not identical."),
    "weak":  ("Same payee, different wording",
              "The descriptions do not resemble each other as text, but they share the distinctive words that name the payee."),
}


def _with_text_relation_label(candidate: dict) -> dict:
    """Resolve a candidate's stored tier key to its user-facing label + tooltip. A candidate with no
    tier — an exact/±1 hit kept on date evidence alone, or one from before this was recorded — is
    returned untouched, and the report simply shows no badge for it."""
    labels = _CANDIDATE_TEXT_RELATION_LABELS.get(candidate.get("text_relation"))
    if not labels:
        return candidate
    labelled = dict(candidate)
    labelled["text_relation_label"], labelled["text_relation_description"] = labels
    return labelled


# A suspect's stored reason records the account relationship that *created* the flag, and a later merge
# retires that premise: the two rows are now on one account, so "cross-account match" states something
# the ledger no longer says — on a report whose two sides then print the same account name, it reads as
# a contradiction. The pair is therefore described by the grouping in force when the report is read,
# using the same effective-root test `promote_in_group_suspects_to_confirmed` applies. Deriving rather
# than storing is what makes it hold in both directions: a merge re-describes every existing flag with
# no backfill, and a detach restores the cross-account reading with no bookkeeping to get wrong.
#
# Only the account relationship is re-derived. The *tier* (exact vs near-miss) is evidence about the two
# rows, which a merge does not change — so an exact in-group match is still auto-confirmed and a fuzzy
# one is still review-only, exactly as before.
_IN_ACCOUNT_RULE_KEYS = {
    "cross_account": "in_account",
    "cross_account_fuzzy": "in_account_fuzzy",
    "cross_account_weak": "in_account_weak",
}

# A removed row with no match reason of its own is described by what removed it (`dedupe_resolved_by`).
# The reason alone cannot say: an Amazon reconciliation merge records none, and neither did Replace until
# it began writing 'replaced' — so a user-resolved row without one is a Replace from before then, since a
# Reject always acts on a flagged row, which carries its flag's reason. Anything else stays the generic
# `other_soft`, labelled for what it is rather than shown as a raw key.
_REMOVED_WITHOUT_REASON_RULE_KEYS = {
    "user": "replaced",
    "amazon_merge": "amazon_merge",
}

# How a removed entry explains itself in the report's reason column, by the occasion its rule names.
_REMOVED_REASON_TEXT = {
    "replaced": "Replaced by another copy of this transaction on {side}",
    "amazon_merge": "Merged into another copy of this charge on {side}",
    "connection_rescan": "Removed by a re-scan as a duplicate of a transaction on {side}",
}


def rule_label_for(rule_key: str) -> tuple[str, str]:
    """Return (short_label, long_description) for a rule_key. Falls back to (rule_key, '') if the
    key is unknown — keeps the UI rendering instead of blowing up when a new rule lands."""
    return _RULE_LABELS.get(rule_key, (rule_key, ""))


def _classify_hard_reject_reason(reason_text: str) -> tuple[str, str]:
    text = (reason_text or "").strip()
    for needle, key, confidence in _RULE_REASON_CLASSIFIERS:
        if needle in text:
            return key, confidence
    return "other_hard", "medium"


def _classify_soft_flag_reason(reason_key: str) -> tuple[str, str]:
    return _SOFT_FLAG_CLASSIFIERS.get((reason_key or "").strip(), ("other_soft", "low"))


def matched_existing_txn_ids(matched) -> list[str]:
    """Pull the existing-transaction id(s) out of a stored `matched_transaction_json`, across the
    rule shapes: exact-hash carries a top-level `id`; coverage carries `candidates: [{id, …}]` (and
    sometimes a `covered` block). Used to resolve what an account's skipped rows matched against."""
    ids: list[str] = []
    if not isinstance(matched, dict):
        return ids
    if matched.get("id"):
        ids.append(matched["id"])
    covered = matched.get("covered")
    if isinstance(covered, dict) and covered.get("id"):
        ids.append(covered["id"])
    for candidate in (matched.get("candidates") or []):
        if isinstance(candidate, dict) and candidate.get("id"):
            ids.append(candidate["id"])
    return ids


def account_skipped_duplicate_summary(conn: sqlite3.Connection, account_id: str) -> dict:
    """Summarize transactions that belonged to `account_id` but never entered (or were trashed from)
    the active ledger because they were duplicates — the explanation for an account that looks empty.

    Two pools contribute: hard-rejected import rows (`import_batch_duplicate`, attributed via the
    stored `txn_payload`'s `account_id`) and confirmed-duplicate rows (soft-flags accepted as real
    duplicates, kept as trashed `txn` rows). Returns the skipped count, the distinct accounts and
    source files the matched (existing) transactions live on, and the importing batch(es) — with a
    `primary_batch_id` for a deep-link into the duplicate report scoped to this account.
    """
    hard_reject_count = 0
    confirmed_count = 0
    batch_counts: dict[str, int] = {}
    matched_ids: set[str] = set()

    for row in conn.execute(
        "SELECT batch_id, txn_payload_json, matched_transaction_json FROM import_batch_duplicate"
    ).fetchall():
        try:
            payload = json.loads(row["txn_payload_json"]) if row["txn_payload_json"] else {}
        except Exception:
            payload = {}
        if not isinstance(payload, dict) or payload.get("account_id") != account_id:
            continue
        hard_reject_count += 1
        batch_counts[row["batch_id"]] = batch_counts.get(row["batch_id"], 0) + 1
        try:
            matched = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
        except Exception:
            matched = {}
        matched_ids.update(matched_existing_txn_ids(matched))

    for row in conn.execute(
        """
        SELECT import_batch_id, suspect_duplicate_of
        FROM   txn
        WHERE  account_id = ?
          AND  trashed_at IS NOT NULL
          AND  rejection_reason = 'duplicate_confirmed'
        """,
        (account_id,),
    ).fetchall():
        confirmed_count += 1
        if row["import_batch_id"]:
            batch_counts[row["import_batch_id"]] = batch_counts.get(row["import_batch_id"], 0) + 1
        if row["suspect_duplicate_of"]:
            matched_ids.add(row["suspect_duplicate_of"])

    skipped_count = hard_reject_count + confirmed_count
    if skipped_count == 0:
        return {
            "account_id": account_id,
            "skipped_count": 0,
            "hard_reject_count": 0,
            "confirmed_count": 0,
            "matched_accounts": [],
            "matched_sources": [],
            "batch_ids": [],
            "primary_batch_id": None,
            "primary_batch_filename": None,
        }

    matched_accounts: set[str] = set()
    matched_sources: set[str] = set()
    if matched_ids:
        id_list = [mid for mid in matched_ids if mid]
        placeholders = ",".join("?" * len(id_list))
        for row in conn.execute(
            f"""
            SELECT COALESCE(NULLIF(p.display_name, ''), p.name, NULLIF(a.display_name, ''), a.name) AS account_label,
                   b.filename AS filename
            FROM   txn t
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN import_batch b ON b.id = t.import_batch_id
            WHERE  t.id IN ({placeholders})
            """,
            id_list,
        ).fetchall():
            if row["account_label"]:
                matched_accounts.add(row["account_label"])
            if row["filename"]:
                matched_sources.add(row["filename"])

    primary_batch_id = max(batch_counts, key=batch_counts.get) if batch_counts else None
    primary_batch_filename = None
    if primary_batch_id:
        r = conn.execute("SELECT filename FROM import_batch WHERE id = ?", (primary_batch_id,)).fetchone()
        primary_batch_filename = r["filename"] if r else None

    return {
        "account_id": account_id,
        "skipped_count": skipped_count,
        "hard_reject_count": hard_reject_count,
        "confirmed_count": confirmed_count,
        "matched_accounts": sorted(matched_accounts),
        "matched_sources": sorted(matched_sources),
        "batch_ids": sorted(batch_counts.keys()),
        "primary_batch_id": primary_batch_id,
        "primary_batch_filename": primary_batch_filename,
    }


def _safe_json_list(raw) -> list:
    try:
        value = json.loads(raw) if raw else []
        return value if isinstance(value, list) else []
    except (ValueError, TypeError):
        return []


def refresh_unexplained_coverage_candidates(conn: sqlite3.Connection, batch_id: str) -> int:
    """Re-run the candidate lookup for this batch's coverage rejects that currently name nothing.

    The report *replays* a stored answer: `matched_transaction_json` is written once, during the import,
    and read back forever after. So a row rejected as "date covered" that could not name its twin at the
    time keeps showing **no specific match** even after the lookup that produces that name improves —
    which is the worst state to leave a row in, since the row is out of the ledger AND the report cannot
    say what replaced it. This recomputes only that missing explanation.

    Deliberately narrow:

      * Only entries whose stored verdict is a coverage reject with an **empty** candidate list are
        touched. An entry that already named a candidate keeps it — a re-run must not re-point an
        explanation the user may have acted on.
      * Only `candidates` / `candidate_count` are rewritten. The verdict, the reason, the rejected
        state, and `reviewed_at` are all left exactly as they were: this explains a decision, it never
        revisits one.
      * It recomputes against **today's** ledger, not the ledger as of the import. For an advisory
        label that is the better answer — a later import may have brought in the very twin this row
        duplicates — but it does mean an entry can gain a candidate that did not exist at the time.

    Cost is why this can sit on the read path: it returns after one cheap query when nothing qualifies
    (the normal case), and when something does, it fetches only rows matching the specific *amounts* of
    the unexplained entries rather than indexing every transaction on the account.

    Returns how many entries gained an explanation.
    """
    pending: list[dict] = []
    for row in conn.execute(
        """
        SELECT row_number, reason, matched_transaction_json, txn_payload_json
        FROM   import_batch_duplicate
        WHERE  batch_id = ?
        """,
        (batch_id,),
    ).fetchall():
        try:
            matched = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
            payload = json.loads(row["txn_payload_json"]) if row["txn_payload_json"] else {}
        except (TypeError, ValueError):
            continue
        if not isinstance(matched, dict) or "covered" not in matched or matched.get("candidates"):
            continue
        account_id = str((payload or {}).get("account_id") or "").strip()
        parsed_date = str((payload or {}).get("date") or "").strip()
        amount = (payload or {}).get("amount")
        if not account_id or not parsed_date or amount is None:
            continue  # a row whose payload can't place it is not something to guess about
        rule_key, _ = _classify_hard_reject_reason(row["reason"])
        # Rule 2 folded in the linked group; Rule 1 did not. Recompute the same shape the original
        # verdict used, so the explanation matches the rule that produced it. The scope is re-derived
        # from the account rather than stored on the entry — a group the account joined after the
        # import is the case this refresh most wants to see.
        scope_id = None
        if rule_key == "coverage_in_scope":
            effective_row = get_effective_account_row(conn, account_id)
            scope_id = str(effective_row["id"]) if effective_row else account_id
        pending.append({
            "row_number": row["row_number"],
            "matched": matched,
            "account_id": account_id,
            "parsed_date": parsed_date,
            "amount": float(amount),
            "scope_id": scope_id,
            # The same text tiering the import applied. Without it this pass would hand back exactly
            # the coincidental same-amount rows the import filtered out, one report-open later.
            "incoming_texts": row_match_texts(
                (payload or {}).get("merchant_name"), (payload or {}).get("raw_name"),
                (payload or {}).get("import_evidence"),
            ),
            # Named rows only reach the ledger probe below; a nameless money-movement leg has no
            # distinctive token to corroborate and never had one.
            "merchant": (payload or {}).get("merchant_name"),
        })

    if not pending:
        return 0

    account_ids = {p["account_id"] for p in pending}
    scope_ids = {p["scope_id"] for p in pending if p["scope_id"]}
    amounts = {round(p["amount"], 2) for p in pending}
    # Exactly the days the lookup will probe, taken from the same helpers it uses so the two cannot
    # drift apart. Filtering on them turns a scan of the account into an index seek (`idx_txn_date`)
    # and, more importantly, bounds the work when an amount is a common one — a $5.00 coffee habit
    # would otherwise pull every such row in the ledger into memory to find one twin.
    probe_dates = {
        d for p in pending
        for d, _ in (*_adjacent_date_offsets(p["parsed_date"]), *_far_date_offsets(p["parsed_date"]))
    }
    account_ph = _placeholders(account_ids)
    amount_ph = _placeholders(amounts)
    date_ph = _placeholders(probe_dates)
    # Sibling accounts in a pending entry's linked group, for the in-scope entries that can use them.
    # Filtering on the rejected row's own account alone would rebuild the very blind spot this refresh
    # is meant to close: the twin a second source filed under a sibling is off-account by definition.
    scope_clause = f" OR COALESCE(a.parent_account_id, a.id) IN ({_placeholders(scope_ids)})" if scope_ids else ""
    # `conn=None` deliberately: it disables the cross-account transfer fallback inside the lookup.
    # That fallback issues a query per unexplained entry — the dominant cost by far — and re-running it
    # here is near-pure waste, because an entry only reaches this function by having found nothing at
    # import time, when the fallback already ran on the same question with the same ±3 window. What
    # this refresh exists to add is the widened same-account and linked-group reach, neither of which
    # needs a connection — both read the indexes built just below.
    #
    # The ledger payment probe below is the one connection-dependent step this reasoning does NOT cover,
    # and it is called directly rather than through the context for exactly that reason: it is gated on
    # the *displayable* list at import time, so a coincidental same-amount neighbour occupying the
    # candidate list is enough to mean it never ran on this row at all.
    context = DedupeContext(conn=None)
    for r in conn.execute(
        f"""SELECT t.id, t.account_id, t.date, t.authorized_date, t.raw_name, t.merchant_name,
                   t.display_name, t.amount, t.import_evidence_json, t.import_batch_id,
                   COALESCE(a.parent_account_id, a.id) AS effective_account_id
            FROM   txn t JOIN account a ON a.id = t.account_id
            WHERE  (t.account_id IN ({account_ph}){scope_clause})
              AND  ROUND(t.amount, 2) IN ({amount_ph})
              AND  (t.date IN ({date_ph}) OR t.authorized_date IN ({date_ph}))
              AND  t.is_pending = 0
              AND  t.trashed_at IS NULL""",
        [*account_ids, *scope_ids, *amounts, *probe_dates, *probe_dates],
    ).fetchall():
        summary = {
            "id": r["id"],
            "date": r["date"],
            "merchant_name": r["display_name"] or r["merchant_name"] or r["raw_name"],
            "amount": r["amount"],
            "account_id": r["account_id"],
            "import_batch_id": r["import_batch_id"],
            "source_texts": row_match_texts(
                r["merchant_name"], r["raw_name"], r["import_evidence_json"],
            ),
        }
        # Both dates, for the same reason the ingestion path indexes both: the twin may be filed under
        # whichever of the two its own source published.
        dates = [r["date"]]
        if r["authorized_date"] and r["authorized_date"] != r["date"]:
            dates.append(r["authorized_date"])
        for stored_date in dates:
            key = duplicate_amount_key(stored_date, r["amount"])
            context.existing_rows_by_account_amount.setdefault(r["account_id"], {}).setdefault(key, []).append(summary)
            context.existing_rows_by_effective_account_amount.setdefault(
                r["effective_account_id"], {}).setdefault(key, []).append(summary)

    updated = 0
    for p in pending:
        # Rows this same batch imported ARE eligible candidates, and excluding them was a mistake:
        # a rejected row is never inserted, so it can never be its own twin, and the case that
        # actually turns up is a file carrying the same charge twice under two different account
        # labels — one copy imports, the other is rejected by coverage. Suppressing the imported copy
        # hid exactly the explanation the report exists to give.
        candidates = _display_candidates(_candidate_summary_rows_for_coverage(
            context, p["account_id"], p["parsed_date"], p["amount"], p["scope_id"], p["incoming_texts"],
        ))
        if not candidates and p["merchant"]:
            # Nothing on the account or in its group explains the row, so ask the wider ledger whether a
            # corroborating charge exists — the same question `_coverage_reject_verdict` asks, on the
            # entries where a coincidence in the candidate list stopped it being asked. Same-source
            # entries need this most: their lookup never folds in the linked group, so a twin a second
            # source filed under a sibling account is invisible to everything above.
            payment_match = find_ledger_payment_match(
                conn, p["account_id"], p["parsed_date"], p["amount"], p["merchant"],
            )
            if payment_match is not None:
                candidates = [payment_match]
        if not candidates:
            continue
        matched = dict(p["matched"])
        matched["candidates"] = candidates
        matched["candidate_count"] = len(candidates)
        conn.execute(
            "UPDATE import_batch_duplicate SET matched_transaction_json = ? WHERE batch_id = ? AND row_number = ?",
            (json.dumps(matched), batch_id, p["row_number"]),
        )
        updated += 1
    return updated


# The captured-origin fields the frontend's import-source seam (lib/importSourceFields.js) turns into
# a hover card. Deliberately named exactly as the transaction list names them, so the report reuses the
# ledger's own origin component instead of growing a second renderer. The duplicate report needs them
# because its "date · merchant · amount" summary is precisely the projection that *hides* why two rows
# matched: the rules compare captured source text, and a pair can match on a descriptor neither side's
# visible merchant shows.
_ORIGIN_COLUMNS_SQL = """
    SELECT t.id,
           t.display_name,
           t.merchant_name,
           t.raw_name,
           t.imported_category,
           t.import_evidence_json,
           b.filename    AS import_batch_filename,
           b.imported_at AS import_batch_imported_at,
           b.provider    AS import_batch_provider,
           (b.provider IS NOT NULL AND b.connection_id IS NULL) AS import_batch_connection_removed
    FROM   txn t
    LEFT JOIN import_batch b  ON b.id  = t.import_batch_id
    WHERE  t.id IN ({placeholders})
"""

# SQLite's bound-parameter ceiling is well above this; chunking is about not building a single
# multi-thousand-placeholder statement for a large re-import's report.
_ORIGIN_LOOKUP_CHUNK = 400


def _txn_origin_map(conn: sqlite3.Connection, txn_ids) -> dict[str, dict]:
    """`txn.id` → its captured-origin fields, for the ids a report references. Ids with no surviving
    row simply don't appear, so callers attach nothing rather than rendering an empty card."""
    ids = sorted({str(i) for i in txn_ids if i})
    out: dict[str, dict] = {}
    for start in range(0, len(ids), _ORIGIN_LOOKUP_CHUNK):
        chunk = ids[start:start + _ORIGIN_LOOKUP_CHUNK]
        for row in conn.execute(_ORIGIN_COLUMNS_SQL.format(placeholders=_placeholders(chunk)), chunk).fetchall():
            out[str(row["id"])] = dict(row)
    return out


def _attach_origins(conn: sqlite3.Connection, entries: list[dict]) -> None:
    """Attach `origin` to every side of every entry that names a real ledger row: the incoming row (soft
    flags and confirmed duplicates, which DID land), the matched-existing row, and each coverage
    candidate. One pass over the finished entries, one query — rather than widening each of the queries
    above and defining the origin shape three times. Hard-rejected incoming rows never became `txn`
    rows; they get their origin from the stored payload at build time instead."""
    referenced: set[str] = set()

    def sides(entry: dict):
        """Every dict in an entry that may carry a `txn.id`, paired with the key holding it."""
        incoming = entry.get("incoming")
        if isinstance(incoming, dict):
            yield incoming, "txn_id"
        matched = entry.get("matched")
        if isinstance(matched, dict):
            yield matched, "id"
            for candidate in (matched.get("candidates") or []):
                if isinstance(candidate, dict):
                    yield candidate, "id"

    for entry in entries:
        for side, id_key in sides(entry):
            if side.get(id_key):
                referenced.add(str(side[id_key]))

    origins = _txn_origin_map(conn, referenced)
    for entry in entries:
        for side, id_key in sides(entry):
            origin = origins.get(str(side.get(id_key) or ""))
            if origin:
                side["origin"] = origin


def list_unified_batch_duplicates(conn: sqlite3.Connection, batch_id: str) -> list[dict]:
    """Return the combined list of hard-reject and soft-flag dedupe entries for a single batch.
    Each entry has the same outer shape; `kind` distinguishes the two pools. Hard rejects carry
    the CSV row number and full CSV values; soft flags carry the resulting `txn` id.

    Every matched-existing row is enriched with `source_batch_id`, `source_filename`, and
    `source_imported_at` so the UI can show where the row came from and offer a drill-through
    into the source file's transactions. Coverage-rule hard-rejects already carry source info on
    their `covered` block (the prior import whose date range caused the rejection).

    Each side that names a transaction also carries `origin` — the captured source detail the ledger's
    own hover card renders (see `_attach_origins`), so the report can answer "what did each source
    actually say?" without a trip to the register.
    """
    # Load a batch_id → filename/imported_at map once. Used to enrich every matched-existing
    # reference (specific rows AND coverage entries) with human-readable source context.
    batch_meta: dict[str, dict] = {}
    for row in conn.execute(
        "SELECT b.id, b.filename, b.imported_at, b.provider, "
        "(b.provider IS NOT NULL AND b.connection_id IS NULL) AS connection_removed "
        "FROM import_batch b"
    ).fetchall():
        batch_meta[str(row["id"])] = {
            "source_filename":           row["filename"],
            "source_imported_at":        row["imported_at"],
            "source_provider":           row["provider"],
            "source_connection_removed": row["connection_removed"],
        }

    # This report's own batch, for the hard-reject incoming side: those rows never became `txn` rows,
    # so their provenance is "the import currently being reported on".
    this_batch = batch_meta.get(str(batch_id), {})
    report_batch_origin = {
        "import_batch_filename":    this_batch.get("source_filename"),
        "import_batch_imported_at": this_batch.get("source_imported_at"),
        "import_batch_provider":    this_batch.get("source_provider"),
        "import_batch_connection_removed": this_batch.get("source_connection_removed"),
    }

    def enrich_with_source(target: dict, source_batch_id: Optional[str]) -> dict:
        """Merge filename/imported_at into target if we know the source batch. No-op if unknown."""
        if not source_batch_id:
            return target
        meta = batch_meta.get(str(source_batch_id))
        if not meta:
            return target
        out = dict(target)
        out["source_batch_id"]     = source_batch_id
        out["source_filename"]     = meta.get("source_filename")
        out["source_imported_at"]  = meta.get("source_imported_at")
        return out

    # Account labels, for naming the account a matched row sits on.
    #
    # Resolved **here, at report time, from the stored id** rather than written into the record at import
    # time — which is what makes this repair reports that already exist instead of only ones imported from
    # now on. The soft-flag half has always named both accounts (it builds its records from a live JOIN);
    # only the hard-reject half went without, because a coverage candidate attached `account_name` solely
    # when it was flagged `cross_account`. The reasoning was that a same-account match need not repeat the
    # account — but the reader sees an account under the incoming row and nothing under the matched one,
    # which reads as unknown rather than as "the same". It also stopped being true once coverage
    # candidates began arriving from linked-group siblings.
    #
    # The label is per row and not hoisted to a column header or the report title, though within any one
    # report it is often constant: a report is not *structurally* single-account. One import spreading
    # across several accounts (a CSV with an account column, a connection feeding several) produces a
    # report whose rows sit on different accounts, and a header stating one of them would read as
    # authoritative while being wrong for the rest — worse than the omission this fixes.
    account_labels: dict[str, str] = {
        str(r["id"]): r["label"]
        for r in conn.execute(
            f"SELECT id, {_account_label_sql('account')} AS label FROM account account"
        ).fetchall()
    }

    duplicate_rows = conn.execute(
        """
        SELECT row_number, reason, values_json, matched_transaction_json, txn_payload_json, reviewed_at,
               enriched_at, enriched_delta_json
        FROM   import_batch_duplicate
        WHERE  batch_id = ?
        ORDER  BY row_number
        """,
        (batch_id,),
    ).fetchall()

    # Records predating `account_id` on the stored match carry only the matched transaction's `id`, so
    # their account is reachable one hop further on. Collected across the whole report and resolved in a
    # single query rather than per record: the fallback fires on every row of an *old* report, and a
    # per-row lookup would make the age of a report decide how many queries rendering it costs.
    def _matched_records(matched: dict) -> list[dict]:
        """Every dict inside a stored match that names a transaction, whatever the rule's shape."""
        if not isinstance(matched, dict):
            return []
        if "covered" in matched:
            return [c for c in (matched.get("candidates") or []) if isinstance(c, dict)]
        return [matched] if matched.get("id") or matched.get("account_id") else []

    unresolved_txn_ids: set[str] = set()
    for row in duplicate_rows:
        try:
            parsed = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
        except Exception:
            continue
        for record in _matched_records(parsed):
            if not record.get("account_id") and record.get("id"):
                unresolved_txn_ids.add(str(record["id"]))
    account_by_txn_id: dict[str, str] = {}
    _unresolved = sorted(unresolved_txn_ids)
    for start in range(0, len(_unresolved), _ORIGIN_LOOKUP_CHUNK):
        chunk = _unresolved[start:start + _ORIGIN_LOOKUP_CHUNK]
        for r in conn.execute(
            f"SELECT id, account_id FROM txn WHERE id IN ({_placeholders(chunk)})", chunk,
        ).fetchall():
            account_by_txn_id[str(r["id"])] = str(r["account_id"])

    def with_account_name(target: dict) -> dict:
        """Name the account a matched record sits on, from whichever id the record kept."""
        if not isinstance(target, dict) or target.get("account_name"):
            return target
        account_id = target.get("account_id") or account_by_txn_id.get(str(target.get("id") or ""))
        label = account_labels.get(str(account_id or ""))
        if not label:
            return target
        out = dict(target)
        out["account_id"] = account_id
        out["account_name"] = label
        return out

    entries: list[dict] = []

    # Hard rejects (never made it into the ledger).
    for row in duplicate_rows:
        try:
            values = json.loads(row["values_json"]) if row["values_json"] else {}
        except Exception:
            values = {}
        try:
            matched = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
        except Exception:
            matched = {}
        try:
            txn_payload = json.loads(row["txn_payload_json"]) if row["txn_payload_json"] else {}
        except Exception:
            txn_payload = {}
        rule_key, confidence = _classify_hard_reject_reason(row["reason"])
        rule_label, rule_description = rule_label_for(rule_key)
        # Hard-reject incoming side comes from the CSV — the row never became a txn — so we surface
        # both the parsed payload fields (date/amount/merchant) and the raw CSV columns the user
        # would recognize, plus the source account string straight from the CSV.
        incoming_account = (
            (values.get("Account") if isinstance(values, dict) else None)
            or txn_payload.get("csv_value")
            or ""
        )

        # Enrich the matched dict with source filename info. The shape varies by rule:
        #   - coverage hard-reject (newer):  matched = {covered: {source_batch_id, ...},
        #                                                candidates: [{id, import_batch_id, ...}], ...}
        #   - exact-hash hard-reject:        matched = {id, date, merchant_name, amount,
        #                                                import_batch_id, ...}
        #   - legacy entries (pre-upgrade):  matched = {date, merchant_name, amount}
        # The newer shapes carry import_batch_id; we add filename lookup. Legacy entries get the
        # raw matched dict unchanged.
        enriched_matched: dict = matched if isinstance(matched, dict) else {}
        if isinstance(enriched_matched, dict):
            if "covered" in enriched_matched:
                covered = enriched_matched.get("covered") or {}
                enriched_matched = dict(enriched_matched)
                enriched_matched["covered"] = enrich_with_source(covered, covered.get("source_batch_id"))
                enriched_matched["candidates"] = [
                    _with_text_relation_label(with_account_name(enrich_with_source(c, c.get("import_batch_id"))))
                    for c in (enriched_matched.get("candidates") or [])
                ]
            else:
                # Named unconditionally, not only when the record knows its source batch: the account is
                # the fact the reader is missing, and a matched row with no batch (a hand-entered
                # transaction) still sits on one.
                enriched_matched = with_account_name(
                    enrich_with_source(enriched_matched, enriched_matched.get("import_batch_id"))
                )

        # Advisory-review sub-state, only meaningful for coverage-window rejects (the rule that can
        # fire without a specific matching row). `reviewed_at` set → the user has acknowledged it,
        # so it leaves the review bucket regardless. Otherwise: a coverage reject whose only
        # candidates sit two or more days out is `matched_near_date` — the report shows the actual
        # offset per candidate, so the bucket says "look at this" without asserting a fixed distance;
        # one with no candidate at all is `no_match` (the genuinely-needs-a-look case); a coverage
        # reject that DID match at exact/±1 is a settled rejection with no sub-state.
        reviewed = bool(row["reviewed_at"])
        review_substate = None
        if isinstance(enriched_matched, dict) and "covered" in enriched_matched and not reviewed:
            candidates = enriched_matched.get("candidates") or []
            if not candidates:
                review_substate = "no_match"
            elif all(c.get("cross_account") for c in candidates):
                # A funding/deposit leg whose only twin is the cross-account transfer counterpart —
                # surfaced to confirm (correctly not re-imported) or reject (separate → import anyway).
                # The cross-account fallback only runs when no same-account candidate exists, so a
                # candidate set is never a mix of the two.
                review_substate = "transfer_match"
            elif min(abs(c.get("day_offset", 0)) for c in candidates) >= 2:
                review_substate = "matched_near_date"

        entries.append({
            "kind": "hard_reject",
            "rule_key": rule_key,
            "rule_label": rule_label,
            "rule_description": rule_description,
            "confidence": confidence,
            "reason_text": row["reason"] or "",
            "reviewed": reviewed,
            "review_substate": review_substate,
            # Enrich-on-duplicate: whether this row's incoming detail was folded into its matched
            # transaction, and what was added — so the report can show the state and offer undo.
            "enriched": bool(row["enriched_at"]),
            "enriched_detail": _safe_json_list(row["enriched_delta_json"]) if row["enriched_at"] else [],
            "incoming": {
                "row_number": row["row_number"],
                "date": txn_payload.get("date"),
                "amount": txn_payload.get("amount"),
                "merchant": txn_payload.get("display_name") or txn_payload.get("merchant_name") or txn_payload.get("raw_name"),
                "account_name": incoming_account,
                # The account the row would have been imported into (resolved at import time). Lets the
                # report be scoped to one account — e.g. opened from an empty account's detail panel.
                "account_id": txn_payload.get("account_id"),
                "csv_values": values if isinstance(values, dict) else {},
                # Reconstructed from the stored payload — this row never became a `txn`, so
                # `_attach_origins` can't reach it, but the payload holds the same captured detail.
                # `import_evidence` rides the payload as a dict; the seam reads the serialized column.
                "origin": {
                    "display_name":         txn_payload.get("display_name"),
                    "merchant_name":        txn_payload.get("merchant_name"),
                    "raw_name":             txn_payload.get("raw_name"),
                    "imported_category":    txn_payload.get("imported_category"),
                    "import_evidence_json": json.dumps(txn_payload["import_evidence"])
                                            if isinstance(txn_payload.get("import_evidence"), dict) else None,
                    **report_batch_origin,
                },
            },
            "matched": enriched_matched,
        })

    # Soft flags (in the ledger with suspect_duplicate_of set) AND confirmed-duplicate rows
    # (soft flags that were resolved as real duplicates — rejection_reason='duplicate_confirmed').
    # Both share the same base shape; the WHERE clause distinguishes their state:
    #   * unresolved soft flag: suspect_duplicate_of set, rejection_reason NULL, trashed_at NULL
    #   * confirmed duplicate:  suspect_duplicate_of set (kept as audit trail),
    #                           rejection_reason='duplicate_confirmed', trashed_at set
    for row in conn.execute(
        f"""
        SELECT
            t1.id                       AS new_id,
            t1.date                     AS new_date,
            t1.amount                   AS new_amount,
            COALESCE(NULLIF(t1.display_name, ''), NULLIF(t1.merchant_name, ''), NULLIF(t1.raw_name, '')) AS new_merchant,
            t1.account_id               AS new_account_id,
            {_account_label_sql('a1')} AS new_account_name,
            COALESCE(NULLIF(a1p.display_name, ''), a1p.name) AS new_account_merged_into,
            COALESCE(a1.parent_account_id, a1.id)            AS new_account_root,
            t1.suspect_duplicate_reason AS reason_key,
            t1.suspect_resolved_at      AS resolved_at,
            t1.rejection_reason         AS rejection_reason,
            t1.dedupe_resolved_by       AS resolved_by,
            t2.id                       AS existing_id,
            t2.date                     AS existing_date,
            t2.amount                   AS existing_amount,
            COALESCE(NULLIF(t2.display_name, ''), NULLIF(t2.merchant_name, ''), NULLIF(t2.raw_name, '')) AS existing_merchant,
            {_account_label_sql('a2')} AS existing_account_name,
            COALESCE(NULLIF(a2p.display_name, ''), a2p.name) AS existing_account_merged_into,
            COALESCE(a2.parent_account_id, a2.id)            AS existing_account_root,
            t2.import_batch_id          AS existing_batch_id
        FROM   txn t1
        JOIN   txn t2                ON t2.id = t1.suspect_duplicate_of
        LEFT JOIN account a1         ON a1.id = t1.account_id
        LEFT JOIN account a2         ON a2.id = t2.account_id
        LEFT JOIN account a1p        ON a1p.id = a1.parent_account_id
        LEFT JOIN account a2p        ON a2p.id = a2.parent_account_id
        WHERE  t1.suspect_duplicate_of IS NOT NULL
          AND  t1.import_batch_id = ?
          AND  (
                (t1.trashed_at IS NULL)
             OR (t1.rejection_reason = 'duplicate_confirmed')
          )
        ORDER  BY t1.date DESC, t1.id
        """,
        (batch_id,),
    ).fetchall():
        is_confirmed = row["rejection_reason"] == "duplicate_confirmed"
        base_rule_key, confidence = _classify_soft_flag_reason(row["reason_key"])
        if is_confirmed and base_rule_key == "other_soft":
            base_rule_key = _REMOVED_WITHOUT_REASON_RULE_KEYS.get(row["resolved_by"], base_rule_key)
        # Re-derive the account relationship from the grouping in force now (see `_IN_ACCOUNT_RULE_KEYS`).
        same_account_now = bool(row["new_account_root"]) and row["new_account_root"] == row["existing_account_root"]
        if same_account_now:
            base_rule_key = _IN_ACCOUNT_RULE_KEYS.get(base_rule_key, base_rule_key)
        matched_side = "this account" if same_account_now else "a different account"
        rule_key = f"{base_rule_key}_confirmed" if is_confirmed else base_rule_key
        rule_label, rule_description = rule_label_for(rule_key)
        # Account labels here are the as-imported account names (`account.name`), NOT the merged
        # effective `display_name`. This report exists to explain what each *file* contained, so a
        # source account later merged under a parent must still read as its own file label (e.g. a
        # "Credit Card" account merged under a parent still shows "Credit Card", with the parent
        # surfaced separately as `account_merged_into` so the UI can annotate the mapping).
        incoming = {
            "txn_id": row["new_id"],
            "date": row["new_date"],
            "amount": row["new_amount"],
            "merchant": row["new_merchant"],
            "account_name": row["new_account_name"],
            "account_id": row["new_account_id"],
            "account_merged_into": row["new_account_merged_into"],
        }
        matched = enrich_with_source({
            "id": row["existing_id"],
            "date": row["existing_date"],
            "amount": row["existing_amount"],
            "merchant": row["existing_merchant"],
            "account_name": row["existing_account_name"],
            "account_merged_into": row["existing_account_merged_into"],
            "import_batch_id": row["existing_batch_id"],
        }, row["existing_batch_id"])
        if is_confirmed:
            # Confirmed soft-flags graduate into `kind: 'hard_reject'` so the unified report
            # routes them through the same UI path as import-time rejects. The rule_key keeps
            # `_confirmed` so the badge text can distinguish the two histories; the confidence
            # band is overridden to 'medium' so the pill renders in the "settled" blue family
            # rather than the "needs attention" orange used for unresolved soft-flags. `removed` is what tells
            # this row apart from an import-time reject: it landed in the ledger and a later decision took it
            # out, which the report counts and filters separately.
            reason_template = _REMOVED_REASON_TEXT.get(
                base_rule_key, "Removed as a duplicate of a transaction on {side}")
            entries.append({
                "kind": "hard_reject",
                "rule_key": rule_key,
                "rule_label": rule_label,
                "rule_description": rule_description,
                "confidence": "medium",
                "reason_text": reason_template.format(side=matched_side),
                "resolved": True,
                "removed": True,
                "incoming": incoming,
                "matched": matched,
            })
        else:
            entries.append({
                "kind": "soft_flag",
                "rule_key": rule_key,
                "rule_label": rule_label,
                "rule_description": rule_description,
                "confidence": confidence,
                "reason_text": f"Suspect duplicate of a transaction on {matched_side}",
                "resolved": False,
                "incoming": incoming,
                "matched": matched,
            })

    _attach_origins(conn, entries)
    return entries


# Every action `resolve_suspect` accepts, checked before anything is read so an unknown one is named as
# such rather than falling through to whichever branch happens to be last.
_SUSPECT_ACTIONS = ("keep", "not_duplicate", "reject", "trash", "replace")


def resolve_suspect(conn: sqlite3.Connection, txn_id: str, *, action: str) -> dict:
    """Resolve a soft-flagged suspect.

    Actions:
      - 'keep' / 'not_duplicate': clears the suspect flag; the row stays in the active ledger as
        a confirmed-distinct transaction. Broad (asserts the two ACCOUNTS are distinct and cascades)
        only when the pair straddles two accounts; per-row when both rows are on one account.
      - 'reject' / 'trash': confirms the suspect as a real duplicate; the row is hidden from
        active ledger queries (`trashed_at` set) and tagged with `rejection_reason =
        'duplicate_confirmed'` so the unified duplicate report can surface it alongside the
        import-time hard-rejects. The `suspect_duplicate_of` pointer is intentionally kept as
        an audit trail of *which* existing row the user accepted as the canonical copy.
        ('trash' is preserved as an alias of 'reject' for back-compat with the existing API.)
      - 'replace': the inverse survivor of 'reject'. The incoming (new-file) row is the correct
        record — it carries the account the user trusts — so it SURVIVES, and the existing matched
        row is removed as a confirmed duplicate (restorable from its own batch's report). Used to
        fix an account when one source labeled a transaction under the wrong account (e.g. a legacy
        umbrella "Credit Card" account vs. the real card from a newer statement). Categorization on the surviving row
        follows each file's "use imported categories" choice: keep the incoming row's own category
        ONLY when the incoming file is the sole one with that flag set; otherwise adopt the existing
        row's category (covers existing-only and the both/neither tie). The adopted category is
        written as a manual override so rule reruns don't undo it, and a NULL existing category is
        never copied (we don't downgrade a categorized row to uncategorized). Unlike 'keep',
        'replace' does NOT assert the two accounts are distinct and does not cascade — it is a
        per-row "these are the same transaction" decision.
    """
    if action not in _SUSPECT_ACTIONS:
        return {"resolved": False, "reason": "invalid_action"}
    row = conn.execute(
        "SELECT id, suspect_duplicate_of, suspect_duplicate_reason, suspect_resolved_at, trashed_at"
        " FROM txn WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if not row:
        return {"resolved": False, "reason": "not_found"}
    if not row["suspect_duplicate_of"]:
        # **Already resolved is a success, not an error.** `keep` on a cross-account pair deliberately
        # resolves rows nobody asked about — one click asserts the two accounts are distinct and cascades
        # over the whole pair — so an action issued per row necessarily arrives at rows a previous call in
        # the same breath has already cleared. Reporting those as failures made a bulk Keep of N rows fail
        # with "not flagged as a suspect duplicate" after having done every bit of the work, and (because
        # the caller abandoned its reload on the error) leave the counts on screen describing the state
        # before it. The requested end state holds, so say so.
        #
        # `suspect_resolved_at` is what separates that from the real error: it is set by every resolution
        # path, so a row carrying it *was* a suspect and has been dealt with, while a row with neither
        # field was never flagged at all and naming an action on it is still a genuine mistake.
        if row["suspect_resolved_at"]:
            return {"resolved": True, "action": action, "already_resolved": True}
        return {"resolved": False, "reason": "not_suspect"}
    if action == "replace":
        existing = conn.execute(
            "SELECT id, category_id, import_batch_id FROM txn WHERE id = ?",
            (row["suspect_duplicate_of"],),
        ).fetchone()
        if not existing:
            return {"resolved": False, "reason": "matched_missing"}
        incoming = conn.execute(
            "SELECT id, import_batch_id FROM txn WHERE id = ?", (txn_id,),
        ).fetchone()

        def _batch_uses_imported_categories(batch_id) -> bool:
            if not batch_id:
                return False
            r = conn.execute(
                "SELECT use_imported_categories FROM import_batch WHERE id = ?", (batch_id,),
            ).fetchone()
            return bool(r["use_imported_categories"]) if r else False

        incoming_uses = _batch_uses_imported_categories(incoming["import_batch_id"])
        existing_uses = _batch_uses_imported_categories(existing["import_batch_id"])
        # Adopt the existing row's categorization onto the surviving incoming row in every case
        # except where the incoming file is the SOLE file flagged to use its imported categories.
        keep_incoming_category = incoming_uses and not existing_uses
        if not keep_incoming_category and existing["category_id"] is not None:
            conn.execute(
                """
                UPDATE txn
                SET    category_id = ?, category_overridden = 1, category_source = 'manual'
                WHERE  id = ?
                """,
                (existing["category_id"], txn_id),
            )
        # Remove the existing row as a confirmed duplicate, pointing its audit at the incoming row
        # that replaced it (so its own batch's report can show + Restore it), then clear the
        # surviving incoming row's suspect flag so it stays as an active, distinct transaction.
        conn.execute(
            """
            UPDATE txn
            SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   rejection_reason = 'duplicate_confirmed',
                   dedupe_resolved_by = 'user',
                   suspect_duplicate_of = ?,
                   suspect_duplicate_reason = 'replaced'
            WHERE  id = ?
            """,
            (txn_id, existing["id"]),
        )
        conn.execute(
            """
            UPDATE txn
            SET    suspect_duplicate_of = NULL,
                   suspect_duplicate_reason = NULL,
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE  id = ?
            """,
            (txn_id,),
        )
        return {"resolved": True, "action": "replace"}
    if action in ("reject", "trash"):
        # `dedupe_resolved_by='user'` records that this resolution is the user's explicit decision,
        # not an automatic side effect. The marker is what protects this row from being auto-
        # restored when accounts are detached — see detach_account / restore_auto_merged_after_detach.
        conn.execute(
            """
            UPDATE txn
            SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   rejection_reason = 'duplicate_confirmed',
                   dedupe_resolved_by = 'user'
            WHERE  id = ?
            """,
            (txn_id,),
        )
        return {"resolved": True, "action": "reject"}
    if action in ("keep", "not_duplicate"):
        # **Per-row, and only this row.** Keep used to carry a second, much larger meaning: it recorded
        # the two accounts as distinct in `account_pair_distinct` and cascade-cleared every other
        # unresolved flag between them. The reasoning was sound — one click conveys the whole assertion —
        # but the placement was not. A button on a transaction row, labelled for what happens to that
        # transaction, was silently making a durable account-level decision that suppressed detection
        # between the pair forever; selecting five rows and clicking it resolved all forty-two, so the
        # bulk selection beside it was a fiction; and the assertion it wrote had no screen anywhere to
        # show or undo it.
        #
        # The account question is now asked as an account question — at mapping time by the "Possible
        # duplicate account?" chooser, and in the duplicate report by the prompt that follows a bulk keep
        # — where it names both accounts and the user answers it deliberately. See
        # `record_account_pair_distinct`. That leaves Keep meaning exactly what it says, identically for
        # a same-account and a cross-account pair, with bulk select doing the bulk.
        #
        # The pair is recorded *before* the pointer naming it is cleared — that ordering is the whole
        # point, since afterwards nothing in the row says what it was judged against. Without it a
        # re-scan re-raises the finding and overwrites `suspect_resolved_at`, destroying the only
        # evidence the user ever decided.
        if row["suspect_duplicate_of"]:
            record_suspect_pair_distinct(
                conn, txn_id, row["suspect_duplicate_of"],
                flagged_txn_id=txn_id, reason=row["suspect_duplicate_reason"],
            )
        conn.execute(
            """
            UPDATE txn
            SET    suspect_duplicate_of = NULL,
                   suspect_duplicate_reason = NULL,
                   suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE  id = ?
            """,
            (txn_id,),
        )
        # The pair travels back so the caller can offer an Undo without looking it up again — after this
        # returns, the row no longer says what it was judged against.
        return {"resolved": True, "action": "keep",
                "pair": list(_sorted_pair(txn_id, row["suspect_duplicate_of"]))
                        if row["suspect_duplicate_of"] else None}
    return {"resolved": False, "reason": "invalid_action"}


# Bumped whenever a change to the matching rules could make detection reach a different verdict on rows
# already in the ledger — a new tier, a tokenizer change, a threshold move, a widened pairing condition.
# On app load a database stamped with an older value is re-scanned once (`maybe_rescan_for_detection_
# change`), because the alternative is what happened in practice: the rules improved, nothing re-examined
# what was already stored, and the pairs the improvement was written for stayed invisible forever.
#
# It is deliberately NOT the schema version. Nothing about these changes touches the schema, and tying
# them together would either force a migration for a threshold tweak or silently skip a re-scan whenever
# a migration happened to land first. Bump it in the same commit as the rule change, the way
# CURRENT_VERSION is bumped with a schema change.
DUPLICATE_DETECTION_VERSION = 1
_DETECTION_VERSION_META_KEY = "duplicate_detection_version"

# A pass only lets each row take one partner, so rows that lose a contest become available on the next
# one and the scan converges rather than settling at once (measured on a real ledger: 70, then 5, then 3,
# then 0). The cap is what keeps that a convergence and not a liveness question — no reachable state
# loops forever, but a bound means a future change to the pairing rules cannot make one.
_MAX_RESCAN_PASSES = 10


def rescan_until_settled(conn: sqlite3.Connection, account_ids: Iterable[str]) -> dict:
    """Run the existing-vs-existing scan to convergence, bounded. Returns the totals and whether it
    settled on its own — a run that hits the cap is reporting that the pairing rules no longer converge,
    which is worth seeing rather than swallowing."""
    ids = list(account_ids)
    total = 0
    for completed in range(1, _MAX_RESCAN_PASSES + 1):
        flagged = scan_scope_for_cross_account_duplicates(conn, ids)
        total += flagged
        if flagged == 0:
            return {"flagged": total, "passes": completed, "settled": True}
    return {"flagged": total, "passes": _MAX_RESCAN_PASSES, "settled": False}


def maybe_rescan_for_detection_change(conn: sqlite3.Connection) -> dict:
    """The app-load catch-up for a matcher that has since improved: re-scan once when the database was
    last examined under older rules, then stamp the current version.

    Mirrors `recurring_detection.maybe_auto_scan` — same place in the lifecycle, same db_meta watermark —
    but gated on a *version* rather than an interval, because the trigger is a code change and not the
    passage of time. Pairs the user has already judged are skipped by the scan itself
    (`suspect_pair_distinct`), so a bump re-examines what was never looked at without re-asking anything
    that was."""
    row = conn.execute("SELECT value FROM db_meta WHERE key = ?",
                       (_DETECTION_VERSION_META_KEY,)).fetchone()
    try:
        seen = int(row["value"]) if row and row["value"] is not None else 0
    except (TypeError, ValueError):
        seen = 0  # a malformed stamp reads as "never scanned" rather than crashing app load
    if seen >= DUPLICATE_DETECTION_VERSION:
        return {"skipped": True, "version": seen}
    account_ids = [r["id"] for r in conn.execute("SELECT id FROM account WHERE trashed_at IS NULL")]
    result = rescan_until_settled(conn, account_ids)
    conn.execute(
        "INSERT INTO db_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_DETECTION_VERSION_META_KEY, str(DUPLICATE_DETECTION_VERSION)),
    )
    return {"skipped": False, "from_version": seen, "version": DUPLICATE_DETECTION_VERSION, **result}


def _same_origin(row_a, row_b) -> bool:
    """Whether two stored rows were reported by the same source, and so must not be paired.

    Rows on different accounts are never same-origin: landing in two accounts is itself the assertion
    that they are two things, and pairing them is the long-standing cross-account case. On ONE account the
    question is real, and a missing `origin_id` (a manual entry) answers it conservatively — a row with no
    ingesting source asserts nothing, so it is treated as sharing an origin with everything on its account
    rather than pairing against a legitimate repeat.
    """
    if row_a["account_id"] != row_b["account_id"]:
        return False
    origin_a, origin_b = row_a["origin_id"], row_b["origin_id"]
    return not origin_a or not origin_b or origin_a == origin_b


def scan_scope_for_cross_account_duplicates(conn: sqlite3.Connection,
                                            account_ids: Iterable[str]) -> int:
    """Fresh existing-vs-existing cross-source scan within a set of accounts (a just-merged group).

    The import-time evaluator and `mark_import_suspects` only ever compare an *incoming* batch's rows
    against what already exists; a pair of rows that both predate the comparison — e.g. a synced row that
    ran no detection before this feature, and a CSV row imported earlier — is never looked at. A merge is
    the strongest "these are the same account" signal, so it is the right moment to close that gap: scan
    every row now in the unified group and soft-flag each un-compared same-(date, amount, normalized payee)
    match reported by two different sources. The following `promote_in_group_suspects_to_confirmed` then
    graduates these (and any pre-existing) in-group soft-flags to confirmed, reversibly.

    Pairing is on differing SOURCE, not differing account — the same premise `mark_import_suspects` uses,
    for the same reason: two connections can both map `existing` onto one local account, so one account
    can hold two independent reports of one charge. Two rows from the same source are never paired, which
    is what keeps a legitimate repeat (the same amount twice in a week on one account) out of the report.

    Canonical choice (which row is KEPT vs. which becomes the trashed suspect): keep the more-curated row.
    A row still awaiting review (needs_review = 1 — every synced row starts here) yields to a reviewed one;
    ties break to the earlier import, then the lower id. So a re-fetched Plaid copy is trashed in favor of
    the categorized CSV row it duplicates, not the reverse. Only rows not already carrying a suspect pointer
    are flagged. Returns the number of rows newly flagged.
    """
    # A single account is a legitimate scope: two sources can both report into one account, so a group of
    # one still has pairs worth finding. (The old floor of two accounts encoded the cross-account premise.)
    ids = [aid for aid in (account_ids or []) if aid]
    if not ids:
        return 0
    ph = _placeholders(ids)
    rows = conn.execute(
        f"""
        SELECT t.id, t.account_id, t.date, ROUND(t.amount, 2) AS amt,
               t.merchant_name, t.raw_name, t.import_evidence_json,
               COALESCE(t.needs_review, 0) AS needs_review,
               t.suspect_duplicate_of,
               COALESCE(b.imported_at, '') AS imported_at,
               -- What reported this row: the connection if it came from one, else the file. NULL for a
               -- manual entry, which asserts nothing and therefore pairs with nothing on its own account.
               COALESCE(b.connection_id, t.import_batch_id) AS origin_id
        FROM   txn t
        LEFT JOIN import_batch b ON b.id = t.import_batch_id
        WHERE  t.account_id IN ({ph})
          AND  t.trashed_at IS NULL
        """,
        ids,
    ).fetchall()

    # Group by amount alone — NOT date, NOT a single payee string — so posted-vs-transaction twins and
    # sources that spell/park the descriptor differently still land together; the date window and the
    # source-text match (captured texts, precise ones deciding the tier — see `row_match_texts`) are
    # applied when pairing within a group below. Each row's match-text sets are precomputed once; a row
    # with no captured text can never match, so it is dropped here.
    judged = load_suspect_pair_distinct(conn)
    row_texts: dict[str, RowMatchTexts] = {}
    groups: dict[float, list] = {}
    for r in rows:
        texts = row_match_texts(r["merchant_name"], r["raw_name"], r["import_evidence_json"])
        if not texts.all:
            continue
        row_texts[r["id"]] = texts
        groups.setdefault(r["amt"], []).append(r)

    def _priority(row) -> tuple:
        # Lower sorts first = the KEPT canonical. A row that ALREADY carries a suspect pointer is a known
        # duplicate of something and must never be chosen as the canonical (else the scan would flag the
        # real canonical as a reciprocal suspect of it — double-counting the pair). After that: keep the
        # more-curated row — reviewed before un-reviewed — then earliest import, then id.
        return (
            1 if row["suspect_duplicate_of"] is not None else 0,
            int(row["needs_review"] or 0),
            row["imported_at"] or "",
            str(row["id"]),
        )

    window = CROSS_ACCOUNT_DATE_WINDOW_DAYS
    flagged: list[tuple[str, str, str]] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        # Pair cross-source rows within the date window, each row to at most one partner. Ordering: an
        # exact text match binds before a fuzzy one and a fuzzy before a weak one, then a same-day twin
        # before a near-date one, then the priority tie-break. Two distinct same-amount charges more than
        # `window` days apart never pair (so a monthly repeat isn't flagged against itself), a differing
        # explicit check number is discarded (two distinct checks share amount + "Check"), and pairs whose
        # texts don't relate at all are skipped.
        candidates = []
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                a, b = members[i], members[j]
                if _same_origin(a, b):
                    continue  # one source does not report a charge twice — a legitimate repeat
                if _sorted_pair(a["id"], b["id"]) in judged:
                    continue  # the user has already decided these two are not the same charge
                dist = _date_distance_days(a["date"], b["date"])
                if dist > window:
                    continue
                if are_distinct_checks(a["merchant_name"], b["merchant_name"]):
                    continue
                kind = classify_source_text_relation(row_texts[a["id"]], row_texts[b["id"]])
                if kind is None:
                    continue
                candidates.append((_TEXT_RELATION_RANK[kind], dist, kind, a, b))
        candidates.sort(key=lambda c: (c[0], c[1], _priority(c[3]), _priority(c[4])))
        matched: set = set()
        for _kind_rank, _dist, kind, a, b in candidates:
            if a["id"] in matched or b["id"] in matched:
                continue
            canonical, other = (a, b) if _priority(a) <= _priority(b) else (b, a)
            if other["suspect_duplicate_of"] is not None:
                continue  # already flagged/compared — leave the existing pointer intact
            if canonical["suspect_duplicate_of"] == other["id"]:
                continue  # the pair is already linked the other way — don't add a reciprocal flag
            flagged.append((canonical["id"], other["id"], _TEXT_RELATION_REASONS[kind]))
            matched.add(a["id"])
            matched.add(b["id"])

    if not flagged:
        return 0
    conn.executemany(
        """
        UPDATE txn
        SET    suspect_duplicate_of = ?,
               suspect_duplicate_reason = ?,
               suspect_resolved_at = NULL
        WHERE  id = ?
        """,
        [(canonical_id, reason, other_id) for canonical_id, other_id, reason in flagged],
    )
    return len(flagged)


def promote_in_group_suspects_to_confirmed(conn: sqlite3.Connection,
                                            account_ids: Iterable[str]) -> int:
    """After accounts are attached into a linked group, any pre-existing soft-flag whose suspect
    and matched-existing rows are now on accounts that share the same effective root has had
    its 'cross-account' premise invalidated by the merge — the user just declared the two
    accounts as the same physical account, so an exact (date, amount, payee) match across them
    is the same case that `exact_hash_linked_group` would have hard-rejected at import time.

    Promote each such flag to a confirmed duplicate: set `trashed_at` +
    `rejection_reason='duplicate_confirmed'` + `suspect_resolved_at`, matching what
    `resolve_suspect(action='reject')` does. The audit pointer `suspect_duplicate_of` stays so
    the user can still see what was matched and Restore if the auto-promotion was wrong.

    EXACT soft-flags (`suspect_duplicate_reason='cross_account'`) are promoted; the review-only tiers in
    `REVIEW_ONLY_SOFT_FLAG_REASONS` (a near-miss text match, or two merely-shared tokens) are deliberately
    left for the user to resolve, so a merge never silently trashes a row on similarity alone. This is the
    merge-time resolution sweep; exact soft-flags are created at import time (and by the merge-time fresh
    scan).

    A review-only flag left here is not left *undescribed*: the report re-derives its account relationship
    from the current grouping (`_IN_ACCOUNT_RULE_KEYS`), so it reads as an in-account near-match rather
    than continuing to claim a cross-account premise this merge just retired.

    **Same-account pairs are promoted too, and this is the path that resolves them.** Two rows on ONE
    account trivially share an effective root, so an exact cross-source match lands here on the first
    sweep after it is flagged — which is the intended outcome (byte-identical captured text, same amount,
    same account, two independent sources) and means the user is never asked about it. They are stamped
    `AUTO_CROSS_SOURCE_RESOLVED_BY` rather than `'auto_merge'`, because no merge produced them and
    `restore_auto_merged_after_detach` must not un-trash them when some unrelated account is detached.
    """
    account_id_list = [aid for aid in (account_ids or []) if aid]
    if not account_id_list:
        return 0
    ph = _placeholders(account_id_list)
    review_only_ph = _placeholders(REVIEW_ONLY_SOFT_FLAG_REASONS)
    rows = conn.execute(
        f"""
        SELECT t1.id, (t1.account_id = t2.account_id) AS same_account
        FROM   txn t1
        JOIN   txn t2 ON t2.id = t1.suspect_duplicate_of
        JOIN   account a1 ON a1.id = t1.account_id
        JOIN   account a2 ON a2.id = t2.account_id
        WHERE  t1.suspect_duplicate_of IS NOT NULL
          AND  t1.suspect_resolved_at IS NULL
          AND  t1.rejection_reason IS NULL
          AND  t1.trashed_at IS NULL
          AND  COALESCE(t1.suspect_duplicate_reason, '') NOT IN ({review_only_ph})
          AND  COALESCE(a1.parent_account_id, a1.id) = COALESCE(a2.parent_account_id, a2.id)
          AND  (t1.account_id IN ({ph}) OR t2.account_id IN ({ph}))
        """,
        [*REVIEW_ONLY_SOFT_FLAG_REASONS, *account_id_list, *account_id_list],
    ).fetchall()
    if not rows:
        return 0
    ids = [r["id"] for r in rows]
    # `dedupe_resolved_by='auto_merge'` marks this as an automatic, undoable resolution. If the
    # user subsequently detaches the accounts, `restore_auto_merged_after_detach` looks for this
    # marker and reverses these promotions. Rows the user explicitly Reject (with
    # `dedupe_resolved_by='user'`) are left alone on detach.
    #
    # A same-account promotion gets its own marker instead. Its premise is not the grouping — the two
    # rows are on ONE account and no detach can separate them — so reversing it on detach would restore
    # a duplicate for a reason that never applied. Restore stays available per-row from the report.
    conn.executemany(
        """
        UPDATE txn
        SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               rejection_reason = 'duplicate_confirmed',
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               dedupe_resolved_by = ?
        WHERE  id = ?
        """,
        [
            (AUTO_CROSS_SOURCE_RESOLVED_BY if r["same_account"] else "auto_merge", r["id"])
            for r in rows
        ],
    )
    # Same-batch transitive clear: a single CSV asserts (via account-column) that rows on
    # different accounts in that file are distinct transactions. If a promoted row Y (now
    # identified with its canonical target X via the merge) had a same-batch sibling Z on a
    # different account, and Z's own suspect points at the *same* canonical X, then Z's suspect
    # is necessarily a false positive: Z ≠ Y (CSV assertion) and Y ≡ X (merge), so Z ≠ X. Clear
    # Z's suspect flag. (Must be the same X, not merely a row in the same merged group — see the
    # helper docstring.)
    _clear_same_batch_siblings_after_promotion(conn, ids)
    return len(ids)


def _clear_same_batch_siblings_after_promotion(conn: sqlite3.Connection, promoted_ids: list[str]) -> int:
    """Helper for promote_in_group_suspects_to_confirmed. Clears a freshly-promoted row's
    same-batch siblings that are guaranteed false positives.

    The transitivity argument is exact: a sibling Z is a guaranteed false positive ONLY when it
    points at the *same canonical row X* that a promoted row Y was confirmed against. The CSV
    asserts Z != Y (Z and Y are on different accounts in the same file), and the merge identifies
    Y ≡ X, so Z != X — Z's flag against X is spurious and is cleared.

    The match must be on the *exact* canonical row, not merely its merged group/effective root.
    A sibling pointing at a *different* row that happens to live on an account now in the same
    merged group proves nothing: that other row is a different transaction Z may genuinely
    duplicate. (Concretely: merging a legacy umbrella "Credit Card" account into one real card R
    promotes R's rows, but a same-batch row on a *different* card C whose suspect points at a
    *different* Credit-Card transaction must stay flagged — it is a real cross-account suspect of
    a row that simply shares the merged account, not of any row on card R.)
    """
    if not promoted_ids:
        return 0
    placeholders = _placeholders(promoted_ids)
    cleared = conn.execute(
        f"""
        SELECT DISTINCT z.id
        FROM   txn z
        JOIN   txn y
          ON   y.import_batch_id = z.import_batch_id
          AND  y.account_id != z.account_id
          AND  y.suspect_duplicate_of = z.suspect_duplicate_of
        WHERE  y.id IN ({placeholders})
          AND  z.suspect_duplicate_of IS NOT NULL
          AND  z.suspect_resolved_at IS NULL
          AND  z.rejection_reason IS NULL
          AND  z.trashed_at IS NULL
        """,
        promoted_ids,
    ).fetchall()
    cleared_ids = [str(r["id"]) for r in cleared]
    if not cleared_ids:
        return 0
    conn.executemany(
        """
        UPDATE txn
        SET    suspect_duplicate_of = NULL,
               suspect_duplicate_reason = NULL,
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE  id = ?
        """,
        [(i,) for i in cleared_ids],
    )
    return len(cleared_ids)


def restore_rejected_duplicate(conn: sqlite3.Connection, txn_id: str) -> dict:
    """Reverse a 'reject' on a previously-resolved soft-flag suspect. Clears `trashed_at` and
    `rejection_reason` so the row returns to the active ledger. The `suspect_duplicate_of`
    pointer stays NULL (the suspect was already resolved); the user is asserting this is a real,
    distinct transaction after all."""
    row = conn.execute(
        "SELECT id, rejection_reason, trashed_at FROM txn WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if not row:
        return {"restored": False, "reason": "not_found"}
    if row["rejection_reason"] != "duplicate_confirmed":
        return {"restored": False, "reason": "not_rejected"}
    # Clear `dedupe_resolved_by` too: the row is no longer in a resolved state, so the
    # provenance marker is moot. If the user re-rejects via the dialog later, it'll be set
    # back to 'user' at that point.
    conn.execute(
        """
        UPDATE txn
        SET    trashed_at = NULL,
               rejection_reason = NULL,
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               dedupe_resolved_by = NULL
        WHERE  id = ?
        """,
        (txn_id,),
    )
    return {"restored": True}
