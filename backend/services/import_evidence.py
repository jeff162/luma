# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The captured-evidence field vocabulary: which of a row's `import_evidence_json` fields may be
compared as *source text* when deciding whether two rows are the same transaction.

This lives in its own leaf module because three subsystems need it and they cannot all import each
other: CSV import (`routers/import_export/core.py`) and data-source sync (`services/
connection_mapping.py`) *write* the role, and duplicate detection (`services/duplicate_detection.py`)
*reads* it — and duplicate_detection already imports connection_mapping, so the constants cannot live
in either of them without a cycle.

An `extra_text_fields` entry is one of two kinds, and text matching must treat them differently.

  * **descriptive** — high-cardinality free text that *names* the transaction: a memo, an item title,
    a counterparty, the raw bank descriptor. An exact or near match between two rows is real evidence
    they are the same charge, so these feed the matcher.

  * **categorical** — everything else: a value drawn from a small repeated vocabulary (transaction
    type, status, currency) *or* a structured datum that describes a row without naming it (a date, a
    check number, a provider's opaque merchant id). Two unrelated rows routinely carry the identical
    value in such a field, so feeding it to the matcher manufactures duplicates out of coincidence.

The motivating failure for the structured half: `build_sync_evidence` records each synced row's
`authorized_date` as a captured field, and both provider adapters publish it as an ISO date string.
The cross-account sweep's text set folded in every captured value, so any two synced rows on
different accounts sharing an amount and an authorized date matched **byte-identically on the date
string** and were flagged as high-confidence cross-account duplicates — with entirely unrelated
merchants. Worse, the date is precisely the signal the sweep's SQL gate has already spent (a ±7-day
window), so the text gate — the strong discriminator the wide window is *justified by* — was
silently answering with the weak one.

Only `categorical` is ever stamped. Descriptive fields stay unmarked to keep the stored shape lean,
which also means evidence written before roles existed reads as descriptive — exactly how it behaved
then. `import_enrichment` preserves whatever role a field carries when folding it into another row.
"""

from __future__ import annotations

EVIDENCE_ROLE_DESCRIPTIVE = "descriptive"
EVIDENCE_ROLE_CATEGORICAL = "categorical"


def evidence_field_feeds_text_match(field_entry) -> bool:
    """Whether an `extra_text_fields` entry may be compared as source text.

    The single predicate every text collector goes through, so a field excluded from one is excluded
    from all of them. `source_match_texts` (the cross-account sweep) used to skip this check
    entirely while `collect_duplicate_match_texts` applied it — the asymmetry that let the sync
    path's structured fields reach the cross-account matcher.
    """
    if not isinstance(field_entry, dict):
        return False
    return str(field_entry.get("role") or "").strip().lower() != EVIDENCE_ROLE_CATEGORICAL
