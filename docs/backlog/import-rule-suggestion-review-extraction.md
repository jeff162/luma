# `ImportRuleSuggestionReview` in-component JSX extraction

> **Status: backlog, and no longer blocked.** The review-model work it waited on has landed: the page's
> action orchestration moved server-side and its id-parsed grouping is gone, so what is left here to
> extract is smaller than this file describes (see `docs/data-model.md` → *Rule suggestions*).
> This is otherwise the one remaining piece of the import/export size refactor (backend `import_export/`
> package; `ImportExport.jsx` 7,595 → 4,354; this file's top-level extractions). Reconciled 2026-06-24.

## What's left

`frontend/src/components/ImportRuleSuggestionReview.jsx` is still large (~2,700 lines as of 2026-06-24
— it grew since the earlier extraction as the settled-view conflict table and source-text wiring landed).
The deferred work is **in-component JSX extraction**: pull the big inline JSX seams out of the main
component into prop-driven presentational components — analogous to how `ImportExport.jsx`'s
`ImportUploadStage` / `ImportHistorySection` were carved out.

This is the harder half (the easy, self-contained pieces are already extracted — see below), so it's its
own later pass and **needs manual click-through to verify** (there are no frontend unit tests for this
surface).

## Already done (don't redo)

Top-level, file-private declarations were extracted (behavior-preserving pure movement; ESLint + build
green per step, vitest green):
- `lib/importRuleSuggestions.js` — pure helpers (sort-order keys + `normalizeImportRuleSortOrder`,
  `findNearestScrollParent`, `buildCategoryDisplayLabel`, `getStatusSymbol` / `getStatusPalette`,
  `formatSuggestionAmountLabel`, `getSuggestionFilterPills`).
- `components/importRuleSuggestions/suggestionPresentational.jsx` — the small presentational pieces
  (`ProgressPill`, `SuggestionStatusBadge`, `SuggestionActionButton`, `CriteriaGroup`, `SuggestionPill`,
  `EditableKeyword`, and now `SuggestionDispositionActions`).
- `components/importRuleSuggestions/{RuleEditorModal,ConflictSetModal,MatchingTransactionsModal,ConflictSetCard,SettledConflictSetTable}.jsx`
  — the modals/cards (each already prop-driven).

## Approach when resuming

Keep state in the main component and pass it down to new prop-driven seams (the deliberate
"`ImportHistorySection`" pattern — large prop surfaces are acceptable here, flagged as the spot to
revisit only if grouped props are preferred). One extraction per commit, behavior-preserving; verify
each with `cd frontend && npx eslint <files> && npm run build`, then manual click-through of the
Generate Rules review (pending / conflicts / older / accepted / deferred / discarded / total, bulk
select, the rule editor, the matching-transactions report).
