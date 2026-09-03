# Refactor-smell audits (recurring process + carried candidates)

> **Status: backlog / recurring.** A periodic pass to find duplication and shotgun-surgery smells —
> code where one logical change forces edits in many places — decide which are worth centralizing,
> and do the safe ones. Not blocking anything. Verify each change with `cd frontend && npm run lint`
> + `npm run build` (and `backend/venv/bin/python -m pytest backend/tests` for backend changes).
> First run: frontend, high-signal, 2026-07-03.

## Why this exists

Several times, a small feature change (e.g. adding `blocked_tags` to tag reconciliation) had to be
made in ~10 near-identical places. That's **shotgun surgery** (one change, many edits) and its cousin
**divergent duplication** (the same shape copy-pasted). This item institutionalizes finding and
retiring those patterns before they spread.

## How to run an audit

The method — the two detection lenses, why historical co-change is useless in this repo, and the
rule-of-three / divergence-risk caveats that decide most candidates — is in
[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) → *Auditing for duplication*. Concretely here: `jscpd`
over `frontend/src` / `backend` for copy-paste blocks, and `semgrep` (or `ripgrep` on a structural
signature) to enumerate a fan-out and confirm a refactor's blast radius. An agent reading pass works
well for the judgment half; its output is "do it / leave it", not raw hits.

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

## Next scope

**Backend audit.** Run the same lenses over `backend/` — likely candidates: repeated SQL filter/where
assembly, per-endpoint serialization shapes, and the tag/category chokepoints. Same rule-of-three /
divergence caveats apply.
