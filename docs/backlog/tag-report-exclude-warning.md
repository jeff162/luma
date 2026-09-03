# Report filter-conflict note — the include case

**Parked; the exclude case shipped 2026-07-28.** The shipped behavior is documented as durable
behavior in [`../ui-patterns.md`](../ui-patterns.md) → *General principles* ("Warn when a filter
leaves out what a report is showing"): the shared `FilterConflictNote`, the client-side overlap
computed by `lib/reportFilterConflicts.js`, the like-for-like and view/totals-aware boundaries that
keep it from crying wolf, and both symmetric tag-report cases (a report tag `≠`-excluded, or missing
from an active include set). This file keeps only what was not built.

## Still parked — include narrowing on group/category reports

An **include** chip on a *group or category* report (e.g. include group Food) is deliberately **not**
flagged. A transaction has exactly one category and one group, so an include chip there is ordinary
focusing rather than the co-occurrence distortion that makes the tag case confusing — the breakdown
that results is the one the filter asks for. The behavior is correct without a note; what is parked is
whether a note would be *useful* anyway.

It is a small extension rather than a new mechanism if it proves worth having: add an include check to
the group/category branch of `computeReportSpendingConflicts`, give it distinct "filtered to X" wording
in `describeReportConflicts` (not a report-outcome promise — that phrasing misled in testing on the tag
side), and reuse the same `FilterConflictNote`. Held for a larger tag-report pass rather than shipped
as a one-off.
