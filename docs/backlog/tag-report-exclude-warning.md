# Report warning when a filter chip touches the report's slices

**Exclude case shipped (2026-07-28); include case still parked.** The Dashboard spending report
(by group, by category, or a tag report) can have an active filter chip that removes a slice the
report would otherwise break down — a `≠ Business` chip while viewing a report *built from* Business,
`≠ Groceries` on the category report, or (drilled into a group) an excluded component category. The
report still renders correctly (the exclude just scopes the fetched rows before aggregation), but a
missing wedge can read as a bug.

## What shipped (exclusion)

A quiet inline note above the report breakdown (`FilterConflictNote` in `components/ui.jsx`, driven by
`computeReportSpendingConflicts` / `describeReportConflicts` in `lib/reportFilterConflicts.js`) fires
when an **exclude** chip references a slice the active report shows:

- **tag report** — an excluded tag ∈ `TagReport.tagIds`.
- **group / category report** — an excluded group/category the report breaks down; scoped to the
  active income/expense **view** and skipping `exclude_from_totals` rows (transfers, card payments)
  the report never showed, so a persistent `≠ Transfers` chip doesn't nag.
- **drilled into a group** — an excluded category belonging to *that* group only.

It is informational (the filter is honored, not suppressed — the original decision), names up to two
slices then "and N more", and offers a "Clear exclusion(s)" action that removes just the offending
chips. Purely client-side (report axis + chips both live in front-end state); like-for-like only, so
an indirect account/owner exclude that happens to drop a category never triggers it.

## Tag reports also flag the *missing* case (2026-07-28)

Excluding tag B and including only tag A (on a report built on {A,B}) distort the breakdown the same
way — either drops B's rows — so a bare exclude-only note was asymmetric. For **tag reports**,
`computeReportSpendingConflicts` now flags a report tag that is `≠`-excluded **or** (when a tag
*include* filter is active) missing from that include set, tagging each conflict `reason:
'excluded' | 'missing'`. The note reframes for missing ("built on X, which the current filter leaves
out"), and its action (`resolveConflictSelectionIds`) clears **every** tag chip — a missing tag has no
chip of its own to drop — so the button is labelled after what it does: **"Clear tag filter"** (not a
report-outcome promise like "show all tags", which misled in testing).

## Still parked — include narrowing on group/category reports

An **include** chip on a *group or category* report (e.g. include group Food) is deliberately **not**
flagged: a transaction has exactly one category/group, so an include chip is ordinary focusing, not
the co-occurrence distortion that makes the tag case confusing. If it ever proves worth a note, extend
the group/category branch with an include check and distinct "filtered to X" wording, reusing the same
`FilterConflictNote`.
