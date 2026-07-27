# Tag-report warning when a filter chip touches the report's tags

**Parked, not started (2026-07-26).** The Dashboard "spending by tag report" mode aggregates the
period's transactions client-side by tag signature (`computeTagSignatureRows`, driven by an active
`TagReport`'s `tagIds`). Now that the app-wide filter supports **tag exclusion**, a user can add a
chip like `≠ Business` while viewing a report *built from* the Business tag — the report still renders
correctly (the exclude just scopes the fetched rows before aggregation), but the result can be
confusing: rows are being removed from the very breakdown they'd otherwise populate.

## What it is

A small, quiet inline note on the tag-report view when any active filter chip (include *or* exclude)
references a tag the active report's signature is built from — e.g. "This report is built on tags you're
also filtering on (Business); the chart reflects the filtered subset." It is **informational only** —
the filter still applies (decided: the exclude is honored, not suppressed). Clearing the chip or
switching report modes hides the note.

## Why it's parked

It's a niche interaction and belongs to a **larger tag-report pass** the user wants to do in one go
(the report builder/editor, the missing-tag warning that already exists, and this note are all the same
surface). Wiring a one-off note now would pre-empt that design. The underlying behavior is already
correct without it.

## Direction if revived

- Detect overlap between the active `TagReport.tagIds` and the tag ids present in `filters.selections`
  (either mode); surface it near the report chart, reusing the existing tag-report notice affordance
  (the missing-tag toast/note) rather than a new component.
- Consider the same note for an *include* tag chip that narrows the report to a subset of its own tags,
  not just exclude — same class of "you're filtering on what you're reporting" confusion.
