# Saved tag reports — follow-ups

**Status: deferred, not started (migrated from `TODO.md` 2026-07-30).** Two independent
enhancements to the dashboard tag-report feature. Freezing filters with a report is covered by saved
filters (`architecture.md` → *Saved filters*): apply the saved filter, then pick the report.

## Settings-page mirror of the report manager

**Context.** Tag reports are currently managed from the dashboard picker:
right-click or the `⋯` button on a saved report opens a small menu with
Rename / Edit tags… / Delete (on the unsaved custom report: Edit tags… /
Save as…). There is no Settings-page surface listing all saved reports.

**Why deferred.** Right-click + the `⋯` menu is enough discoverability for
the small surface area today. Add the Settings mirror if the picker menu
turns out to be too easy to miss.

**Suggested approach when picked up.**

- Add a Settings section "Saved tag reports" that lists the user's saved
  reports (`ui.dashboard.tagReports`) with rename/delete affordances and the
  tag composition shown inline.
- Useful as a single place to bulk-clean stale presets, which is harder to
  do one-by-one from the dashboard.

  [since this was written there's now a tags button on the transaction page for

  creating/editing/manging tags. maybe this goes there.]

## Richer report builder

**Context.** Today's builder is a flat tag-checkbox list. Future ideas
discussed: drag-to-bucket for multi-bucket comparisons, or a
natural-language template where the user fills tags into a phrase
("compare [Alice] vs [Bob] for [Essential]").

**Why deferred.** Worth seeing how the simple version actually gets used
before investing in a richer one — the patterns users reach for will
inform the right next step.
