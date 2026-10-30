# Recurring audits: refactor smells, and doc conformance

Two periodic passes over the repo, kept together because both are standing processes with a carried
scope rather than a feature. Neither blocks anything.

| Audit | Next scope |
| --- | --- |
| [Refactor smells](#refactor-smells) (duplication, shotgun surgery) | the **backend**; the frontend has had one pass |
| [Doc conformance](#doc-conformance) (does the code do what a doc says) | **`architecture.md`**, whose cross-subsystem contracts have never had one; `data-model.md` is fully covered |

Verify each change with `cd frontend && npm run lint` and `npm run build`, plus
`backend/venv/bin/python -m pytest backend/tests` for backend changes.

## Refactor smells

A small feature change that has to be made in many near-identical places is **shotgun surgery**; its
cousin is **divergent duplication**, the same shape copy-pasted. This audit finds and retires those
patterns before they spread.

### How to run it

Detection is structural: `jscpd` over `frontend/src` or `backend` for copy-paste blocks, and `semgrep`
(or `ripgrep` on a structural signature) to find every copy and see how far a refactor reaches.
Historical co-change is not useful, because commits are batched.

Then a reading pass ranks the candidates by how often they occur and how safe they are to change. The
rule of three and divergence risk decide most cases (`docs/collaboration-notes.md` → *Code Structure
Preferences*). The output is "do it" or "leave it" for each candidate, not raw hits, and a deliberate
"leave it" is worth recording here.

### Backend: likely candidates

Repeated SQL filter and `WHERE` assembly, per-endpoint serialization shapes, and the tag and category
chokepoints.

### Frontend: candidates left open, each with its trigger

- **Row-patch idiom.** `setX(prev => prev.map(t => t.id === id ? { ...t, … } : t))` appears about ten
  times across seven files. A tiny `updateById(list, id, patch)` would do, but each site is already one
  line and some differ. Extract opportunistically.
- **The four drill detail panels** (`CategoryDetail` / `AccountDetail` / `PeriodDetail` / `TagDetail`)
  share a trend chart, drill list, child `TransactionDetail` and bulk skeleton, and `detailShared.jsx`
  already factors the chrome, paging and range. A full merge has high divergence risk (AccountDetail's
  source-account column and filter are different). Keep extracting into `detailShared.jsx` instead of a
  mega-component.
- **Reference-data fetch.** `useState(null)` plus a cancelled-flag `getX()` effect for a whole-list
  lookup (categories, accounts, owners) in `FilterBar`, `Accounts`, `AmazonImportDialog` and several
  pages. Only tags have a cache (`useTags`). Add a `useTags`-style hook for an entity when another surface
  starts refetching it.
- **Dismiss, undo toast and a "N dismissed" list**, on Recurring signals and Tasks. The storage differs by
  design, so only the presentation would unify. Extract the row / footer / toast trio if a third surface
  grows one.
- **Source-account → local-account mapping grid**, in the CSV import's account step (`ImportExport.jsx`)
  and `ConnectionAccountMapDialog`. The logic is shared (`importAccountMatching.js`,
  `PossibleAccountMatchChooserDialog`, `AccountMatchSelect`) and so is the row-state shape; the markup
  around it is duplicated. Extract the row when a third source of accounts needs mapping, or when the two
  grids start to drift in what a row offers.

### `useTags()` consumers not migrated

The shared `useTags()` hook (`frontend/src/lib/useTags.js`) caches the tag list. These still fetch their
own:

- `TransactionRow.jsx` `TransactionAmountCell`: **leave it.** It is per row, and a subscribing hook there
  would mean thousands of listeners; its lazy fetch on open is right.
- `FilterBar.jsx`: fetches tags with the rest of its reference data (see *Reference-data fetch* above).
- `pages/Accounts.jsx`, `pages/ImportRuleSuggestions.jsx`: fetch tags inside a page-init `Promise.all`
  (ImportRuleSuggestions also refetches after rule actions). Migrate only if it simplifies.
- `pages/Categories.jsx`, `components/TagsDialog.jsx`: each manages its own list and calls
  `invalidateTags()` after an edit. Migratable, lower value.
- `components/TransactionDetail.jsx`: has a `providedAvailableTags` override from the host, so a
  migration has to serve both the fed and self-fetched cases. Worth doing; just more branches.

## Doc conformance

Read a topic doc's claims against the code that is supposed to keep them, and classify each one, rather
than hunting for bugs directly. It matters most for a doc whose statements are invariants: a claim the
code has quietly stopped keeping means wrong numbers or a wrong relationship between transactions, with
nothing to notice it.

Findings are fixed, or folded back into the doc as corrections, in the same pass. The point is that the
doc and the code agree afterwards, so there is no standing finding list to carry.

### The method

Per claim, one of five verdicts: **ENFORCED** (name the schema constraint, the validation, or the one
code path that writes the field), **CONVENTION ONLY** (true today; name the write paths that could break
it), **VIOLATED** (name the path, the inputs and what ends up in the database), **DOC STALE** (the code
moved on), **UNVERIFIABLE** (say what would settle it).

- **Rank by what corrupts silently.** VIOLATED before DOC STALE before CONVENTION ONLY, and within those,
  fields where a wrong value changes a total or a cross-transaction relationship without an error.
  ENFORCED claims get a one-line tally per section.
- **Cite file:line for both halves**, the doc claim and the code. A finding that cites only the code is an
  opinion about the code.
- **Never infer from a name.** Build the fixture and run it; that is what separates a real defect from
  several that look identical on a reading.

### Where defects turn up

- **Stale claims cluster where a fact is written in more than one place.** When a docstring beside the
  code also describes it, the copy in the topic doc is the one that goes stale.
- **Code defects are usually a second implementation of a rule stated once**: an open-coded normalizer
  beside the shared one, a second create path with its own existence check, a matcher reading an id from
  only one of the two places it is stored.
- **A mechanism documented as general but gated by a predicate borrowed from one source** silently does
  nothing for the others.
- **A test can encode the defect.** One that asserts the wrong behaviour reads as coverage.

### Obstacles

- **A green suite says nothing about conformance.** Defects sit in paths the tests cover; what is missing
  is a test asserting the *doc's* claim. Expect to write the failing test as part of the finding.
- **The split seam.** `txn_effective_sql` substitutes a split part's `category_id` and `amount` over the
  parent row, so a claim about "the transaction's category" has two readings, and a query written for one
  is wrong for split rows without erroring. Check every per-transaction count for `COUNT(DISTINCT t.id)`
  against the seam. It rarely matters for import counts, which a split does not multiply.
- **A fixture's own premises are the likeliest thing wrong.** A CSV amount cell is in the *file's*
  convention and inverted on import, so a purchase is a negative cell and a positive row. Confirm how a
  value is stored with a throwaway import before asserting against it.
- **The tree moves under a long audit.** Re-grep every doc and code line number against the current tree
  before acting on a finding list, and re-read `git log`.
