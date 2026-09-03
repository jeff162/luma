# Online categorizer + merchant-name cleaning (parked design)

> **Status: parked exploratory design, not implemented.** Two related but independent features. Parked
> 2026-06-16; flagged to resume when rules are in focus. Distinct from the shipped **source-text rule
> matching** (`match_source_text`, see `docs/data-model.md` → the rule action list) and from the
> existing data-driven **Generate Rules** suggester — this is about *cold-start* categorization with no
> history to learn from.

## The unifying insight — "the rule is the cache"

Both features terminate in the existing `category_rule` store: accepting a suggestion builds a rule,
and the categorizer then owns that merchant forever (existing rows via apply-to-transactions, future
rows on import). So neither feature needs its own persistence — no stored canonical-merchant column,
no merchant→category cache. Auto-building a rule on confirm is safe *because it happens during review*
(consistent with the app's reviewed/approve-before-add stance for data-mutating rules). A one-off
Accept that isn't promoted to a rule stays uncached and may resurface in a later discovery run — the
lazy-vs-deliberate spectrum, so offer both "Accept" and "Accept + make rule" (mirroring the import
rule-suggestions screen). The only genuinely new persistent artifact is a shared merchant-cleaning
helper for the suggested keyword.

## 1. Online (internet) categorizer

Solves cold-start: knows "Spotify → Entertainment" with zero history. **User-triggered** (hits an
external API → opt-in, privacy-sensitive).

- Classify each **unique normalized merchant** (not per-transaction) against the user's **own leaf
  categories**, via an LLM with **structured output constrained to an enum of their leaves + "unknown"**,
  so results land directly on `category_id`.
- Model/infra: **Haiku 4.5** (cheap/fast classification) via the **Batches API** (50% off, async — fits
  a user-triggered, non-interactive run).
- Provenance: mark these `category_source = 'system'` (a *value*, not a new column — set, badged,
  group-selectable) with `category_overridden = 0` so a real rule can later supersede. Accept →
  `'manual'` / `overridden = 1`; Dismiss clears.
- **Open decision:** do `category_source = 'system'` rows count in dashboard totals before review, or are
  they excluded until accepted? One-line reporting filter either way — decide before building.

## 2. Merchant-name cleaning at rule-build time

Do **not** strip noise from the stored/displayed name — `TST*BlackPearl` is more recognizable to the
user than `BlackPearl`. Cleaning only pre-fills the *suggested keyword* in the build-a-rule prompt,
where the user reviews it.

- Maps onto two existing rule fields: aggressive clean (drop processor prefix `XX*`, store #, location)
  → the **keyword** (the matcher, so it generalizes); light/none → leave the **display name /
  `clean_name`** alone.
- Deterministic heuristic — **no internet/LLM needed.** Ships independently into the existing "build a
  rule when you categorize" flow.

## Next step when resuming

Read the current "build a rule when you categorize" flow (keyword / `clean_name` wiring in
`backend/services/categorizer.py` + `backend/routers/rules.py` + the frontend `RuleForm`) to see where
the cleaning helper slots in. A parallel ask: make the existing rule-suggestion **generator** more
robust — better keyword extraction via the same cleaning, and learn from *all* categorized history, not
only import-derived rows.
