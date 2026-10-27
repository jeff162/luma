# Recurring audits: refactor smells, and doc conformance

> **Status: backlog / recurring.** Two periodic passes over the whole repo, kept in one file because
> both are standing processes with a carried scope rather than a feature. Not blocking anything.
> Verify each change with `cd frontend && npm run lint` + `npm run build` (and
> `backend/venv/bin/python -m pytest backend/tests` for backend changes).
>
> 1. **[Refactor smells](#why-this-exists)** — duplication and shotgun surgery. First run: frontend,
>    high-signal, 2026-07-03. Next scope: **backend**.
> 2. **[Doc conformance](#doc-conformance-audit-data-modelmd)** — does the code do what
>    `data-model.md` says it does. First run: 2026-10-15, twelve of the doc's seventeen sections.
>    Second run: 2026-10-15, the remaining five. **All seventeen are now covered; nothing is carried.**
>    Next scope: a re-run, which is worth it once the sections have moved — or the same lens over
>    `architecture.md`, whose cross-subsystem contracts have never had one.

## Why this exists

Several times, a small feature change (e.g. adding `blocked_tags` to tag reconciliation) had to be
made in ~10 near-identical places. That's **shotgun surgery** (one change, many edits) and its cousin
**divergent duplication** (the same shape copy-pasted). This item institutionalizes finding and
retiring those patterns before they spread.

## How to run an audit

Detection is structural: `jscpd` over `frontend/src` / `backend` for copy-paste blocks, and `semgrep`
(or `ripgrep` on a structural signature) to find every copy and confirm how far a refactor reaches.
Historical co-change is not useful here, because commits are batched, so "changed together" is noise.

Then a reading pass ranks the candidates by how often they occur and how safe they are to change. The
rule of three and divergence risk decide most cases (`docs/collaboration-notes.md` → *Code Structure
Preferences*). An agent reading pass works well for this half. The output is "do it" or "leave it" for
each candidate, not raw hits, and a deliberate "leave it" is worth recording.

## Carried candidates from the first run (frontend)

The high-value three shipped (see below). These were deliberately **deferred**, not missed:

- **Row-patch idiom** — `setX(prev => prev.map(t => t.id === id ? { ...t, … } : t))` appears ~10×
  across ~7 files. Could become a tiny `updateById(list, id, patch)` util, but each callsite is
  already one line and some are heterogeneous → **low priority; extract opportunistically.**
- **The four drill detail panels** (`CategoryDetail` / `AccountDetail` / `PeriodDetail` / `TagDetail`)
  share a trend-chart + drill-list + child-`TransactionDetail` + bulk skeleton. `detailShared.jsx`
  already factors the chrome/paging/range. A full unify has **high divergence risk** (AccountDetail's
  source-account column/filter is genuinely different) → **leave; keep extracting into
  `detailShared.jsx` incrementally instead of a mega-component.**
- **Reference-data fetch** — `useState(null)` plus a cancelled-flag `getX()` effect for a whole-list
  lookup (categories, accounts, owners) in `FilterBar`, `Accounts`, `AmazonImportDialog` and several
  pages. Only tags have a cache (`useTags`) → **add a `useTags`-style hook for an entity when another
  surface starts refetching it.**
- **Dismiss + undo toast + a durable "N dismissed" list** — recurring signal dismissal (Recurring) and
  task dismissal (Tasks). The storage differs by design, so only the presentation would unify →
  **extract the row/footer/toast trio if a third surface grows one.**
- **Source-account → local-account mapping grid** — the CSV import's account step (`ImportExport.jsx`)
  and `ConnectionAccountMapDialog`. They already share the logic (`importAccountMatching.js`,
  `PossibleAccountMatchChooserDialog`, `AccountMatchSelect`) and the same row-state shape; what is
  duplicated is the surrounding markup → **extract the row when a third source of accounts needs
  mapping, or the two grids drift in what a row offers.**
- **`ContextMenu` vs. `ActionMenu`** — the transaction row's right-click menu (`TransactionRow.jsx`) is
  a second anchored-menu implementation. It anchors at the cursor and takes named per-action handlers
  rather than an item list. `ActionMenu` already anchors at the cursor (`anchorPoint`) → **retire
  `ContextMenu` onto `ActionMenu` when it needs a feature `ActionMenu` already has.**

### `useTags()` consumers not yet migrated (see below)

The shared `useTags()` hook (`frontend/src/lib/useTags.js`) centralizes the tag-list fetch. Migrated:
`BulkEditPanel`, `useBulkTransactionEditing`, `useTransactionRowActions`, `RuleForm`, the Dashboard
tag-report builder — plus the inline-create chokepoint (`TagPickerWithCreate` → `addTagToCache`) and
Settings CRUD (`invalidateTags`). **Intentionally left**, each for a reason:

- `TransactionRow.jsx` `TransactionAmountCell` — **per-row**; a module-subscribing hook there would be
  thousands of listeners. Its lazy per-open fetch is the right pattern; leave it.
- `pages/Accounts.jsx`, `pages/ImportRuleSuggestions.jsx` — fetch tags inside a page-init `Promise.all`
  (and ImportRuleSuggestions refetches after rule ops). Different shape; migrate only if it simplifies.
- `pages/Categories.jsx` — the category-tag management context (own list + optimistic add). Migratable
  but lower value; do in a later pass.
- `components/TransactionDetail.jsx` — has a `providedAvailableTags` host-override path; a clean
  migration must serve both the fed and self-fetched cases. Worth doing, just branchier — next pass.

## Shipped in the first run (fold into docs when this file is deleted)

1. **`getFormControlStyle` adopted in Dashboard** — 8 hand-rolled `<select>` styles → two helper-derived
   constants (`DASH_SELECT_MD/SM`).
2. **`TransactionListToolbar`** (`frontend/src/components/`) — the Copy + Bulk-Edit toggle row, now shared
   across the 6 activity/drill surfaces.
3. **`useTags()`** — shared, cached tag list with explicit invalidation (see above).

## Next scope (refactor smells)

**Backend audit.** Run the same lenses over `backend/` — likely candidates: repeated SQL filter/where
assembly, per-endpoint serialization shapes, and the tag/category chokepoints. Same rule-of-three /
divergence caveats apply.

---

## Doc conformance audit (`data-model.md`)

A different lens from the one above, and the same shape of process: read a topic doc's claims against
the code that is supposed to keep them, and classify each one rather than hunting for bugs directly.
`data-model.md` is the doc that earns it, because it is the one whose statements are *invariants* — a
claim there that the code has quietly stopped keeping means wrong numbers or a wrong relationship
between transactions, with nothing to notice it.

### The method, which is the part worth reusing

Per claim, one of five verdicts: **ENFORCED** (name the schema constraint, the validation, or the one
code path that writes the field), **CONVENTION ONLY** (true today, but name the write paths that could
break it), **VIOLATED** (name the path, the inputs, and what ends up in the database), **DOC STALE**
(the code moved on), **UNVERIFIABLE** (say what would settle it). Three rules made the difference:

- **Rank by what corrupts silently.** VIOLATED before DOC STALE before CONVENTION ONLY, and within
  those, fields where a wrong value changes a total or a cross-transaction relationship without
  surfacing an error. Enumerating the ENFORCED claims is nearly free and nearly worthless — a one-line
  tally per section is enough.
- **Cite file:line for both halves**, the doc claim and the code. A finding that cites only the code is
  an opinion about the code.
- **Never infer from a name.** Most of the first run's wrong turns were a function whose name said it
  did the thing. Build the fixture and run it: that is what separated the three real defects from the
  several that looked identical on a reading.

Nothing from either run is owed. Findings were fixed or folded back into `data-model.md` as
corrections in the same pass, which is where a conformance audit's output belongs — the point of the
exercise is that the doc and the code agree afterwards, so there is no standing finding list to carry.

### What the second run changed, as a shape to expect

Five sections, three code defects and five stale claims. The distribution is worth knowing before a
third run, because it is not what the first run's was:

- **The stale claims clustered where a figure is derived in more than one place.** `row_count` was
  defined as three populations where every write path sums five; the Amazon reconciliation's bucket
  list had drifted two buckets behind the function. Both had a correct second description in a
  docstring beside the code, which is the tell: when the same fact is written twice, the copy in
  `data-model.md` is the one that goes stale, because the one by the code gets edited with it.
- **The code defects were each a second implementation of a rule stated once.** A duplicate
  `watch_enabled` assignment in one `UPDATE`; a `terminal_window_days` normalizer open-coded beside the
  shared one it contradicts; a refund matcher reading the payment's id from only one of the two places
  the id is stored. None was reachable by reading the doc — each needed a fixture.
- **A veto is where a widened mechanism rots.** Refund pairing required a PayPal-shaped `Type`, so the
  CSV path the doc advertised paired nothing, silently. When a mechanism is documented as general and
  implemented against one source, the gate is usually a predicate borrowed from that source.

### Obstacles

- **A green test suite says nothing about conformance.** Every defect the first run found was in a path
  the tests covered; what was missing was a test that asserted the *doc's* claim. Expect to write the
  failing test as part of the finding, and expect it to be easy once the claim is stated precisely.
- **The split seam is where claims go to die.** `txn_effective_sql` substitutes a split part's
  `category_id` and `amount` over the parent row, so any claim phrased in terms of "the transaction's
  category" has two readings, and a query written for one of them is wrong for split rows without
  erroring. Check every per-transaction count for `COUNT(DISTINCT t.id)` against the seam. The first
  run's sharpest findings were all this one shape. It cost the second run nothing: the batch counts
  count rows a card imported, which a split does not multiply, and the three places it could have bitten
  already guard on `is_split`. Check it, but do not budget for it in a section about import counts.
- **A fixture's own premises are the likeliest thing wrong.** Two of the second run's fixtures went red
  on the fixture, not the code: a CSV amount cell is written in the *file's* convention and inverted on
  import, so a purchase is a negative cell and a positive row. Confirm how a value is stored with a
  throwaway import before asserting against it.
- **The tree moves under a long audit.** The second run's citations were taken against a working tree
  four commits behind where it ended, and `database.py` had shifted ~80 lines and a schema version by
  then. Re-grep every doc and code line number against the current tree before acting on a finding
  list, and re-read `git log` rather than the session's opening snapshot.
