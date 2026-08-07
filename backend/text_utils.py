# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Merchant-text normalization shared by rule matching and duplicate detection.

Both subsystems need the same notion of "the identifying part of a bank descriptor": rules derive
keywords and clean names from it, and duplicate detection compares two sources' text with it. The
primitive lives here rather than in either caller because the two must agree — a rule keyword and a
dedupe comparison that normalized differently would disagree about whether two rows name the same
merchant — and because the dedupe service cannot import the import router without a cycle.
"""


def sanitize_rule_merchant_text(value: str) -> str:
    """Strip trailing account/reference digit runs from a merchant descriptor.

    Banks append transaction or card numbers to an otherwise stable merchant name, which would make
    every occurrence look like a different merchant. Trailing tokens of 4+ digits are dropped (a
    shorter run can be part of the name, e.g. a store number), and a descriptor that is *entirely*
    digits carries no merchant identity at all, so it normalizes to empty.
    """
    normalized = " ".join((value or "").strip().split())
    if not normalized:
        return ""

    tokens = normalized.split()
    while len(tokens) > 1:
        compact = "".join(ch for ch in tokens[-1] if ch.isalnum())
        if compact.isdigit() and len(compact) >= 4:
            tokens.pop()
            continue
        break

    sanitized = " ".join(tokens).strip()
    compact = "".join(ch for ch in sanitized if ch.isalnum())
    if compact and compact.isdigit():
        return ""
    return sanitized
