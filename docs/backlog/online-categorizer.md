# Categorizing merchants Luma has never seen

## What it is

A new ledger has no categorized history, so there is nothing for Generate Rules to learn from and every
merchant has to be categorized by hand. Two independent features help:

1. **An online categorizer.** On request, send each unknown merchant name to an AI service, which picks
   one of the user's own categories ("Spotify → Entertainment"). The user reviews each suggestion, and
   accepting one can create a rule. Opt-in, since merchant names leave the machine.
2. **Merchant-name cleaning.** When building a rule, suggest a cleaned keyword (`BLACKPEARL` from
   `TST*BlackPearl #123 Portland`) so the rule matches every visit, not just one. Runs locally.

**Where it stands:** designed, not started. Worth picking up next time rules are in focus. The second
feature can ship on its own.

Both are distinct from source-text rule matching (`match_source_text`, `docs/data-model.md` → *The
matcher*) and from Generate Rules.

The online categorizer shares most of its subsystem with document itemization
([`document-extraction.md`](document-extraction.md) → *Tier 3 shares a subsystem with the online
categorizer*), so whichever is built first should build the shared part.

## The rule is the cache

Both features end in the existing `category_rule` store. Accepting a suggestion builds a rule, and the
rule then owns that merchant: existing rows through a scoped preserve-manual apply, future rows on
import. So neither feature needs its own storage (no canonical-merchant column, no merchant → category
cache). Building a rule on confirm is safe because it happens during review, consistent with the app's
approve-before-add stance for rules that change data.

Offer both "Accept" and "Accept + make rule", as the import rule-suggestions screen does. A one-off
Accept stays uncached and may come back in a later run. The only new persistent piece is a shared
merchant-cleaning helper for the suggested keyword.

## 1. Online categorizer

Knows "Spotify → Entertainment" with no history. **User-triggered**, since it calls an external API, and
so opt-in and privacy-sensitive.

- Classify each **unique normalized merchant**, not each transaction, against the user's **own leaf
  categories**, using an LLM with **structured output constrained to an enum of those leaves plus
  "unknown"**, so results land directly on `category_id`.
- A small, cheap model through a batch API fits: classification is simple, and a user-triggered run does
  not need to be interactive.
- Provenance: `category_source = 'system'` (a value, not a new column; badged and group-selectable) with
  `category_overridden = 0`, so a real rule can later take over. Accept sets `'manual'` /
  `overridden = 1`; Dismiss clears it.
- **Open decision:** do `category_source = 'system'` rows count in dashboard totals before review, or are
  they excluded until accepted? A one-line reporting filter either way; decide before building.

## 2. Merchant-name cleaning at rule-build time

Do **not** strip noise from the stored or displayed name: `TST*BlackPearl` is more recognizable than
`BlackPearl`. Cleaning only pre-fills the *suggested keyword* in the build-a-rule prompt, where the user
reviews it.

- An aggressive clean (drop the processor prefix `XX*`, store number, location) feeds the **keyword**, so
  the rule generalizes. The display name / `clean_name` is left alone.
- Deterministic, with no internet or LLM, so it can ship on its own into the existing "build a rule when
  you categorize" flow.

## Where to start

Read the "build a rule when you categorize" flow (the keyword and `clean_name` wiring in
`backend/services/categorizer.py`, `backend/routers/rules.py` and the frontend `RuleForm`) to see where
the cleaning helper fits. A related improvement: make the rule-suggestion generator use the same cleaning
for its keywords, and learn from all categorized history, not only import-derived rows.
