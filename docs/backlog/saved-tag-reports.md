# Saved tag reports — follow-ups

**Status: deferred, not started (migrated from `TODO.md` 2026-07-30).** Four independent
enhancements to the dashboard tag-report feature. Related: `tag-report-exclude-warning.md`
(a separate small note for the report view).

## Settings-page mirror of the report manager

**Context.** Tag reports are currently managed from the dashboard picker:
right-click or the `⋯` button on a saved report opens a small menu with
Rename / Delete. There is no Settings-page surface listing all saved
reports.

**Why deferred.** Right-click + the `⋯` menu is enough discoverability for
the small surface area today. Add the Settings mirror if the picker menu
turns out to be too easy to miss.

**Suggested approach when picked up.**

- Add a Settings section "Saved tag reports" that lists every preset stored
  under `ui.dashboard.tagReports` with rename/delete affordances and the
  tag composition shown inline.
- Useful as a single place to bulk-clean stale presets, which is harder to
  do one-by-one from the dashboard.

## Capture filters with a saved preset

**Context.** A saved preset today is just `{ id, name, tagIds,
dismissedMissingWarning? }` — only the tag selection. The dashboard's
current period, account filter, etc. are not part of the preset, so
loading a preset always uses whatever filters are currently active.

**Why deferred.** Tag-only was the simplest first slice and composes well
("any preset works against any current filter set"). The "I always look at
year-end essentials" use case wants filters frozen with the preset, but no
one has asked for it yet.

**Suggested approach when picked up.**

- Add a "Capture current filters" checkbox in the save dialog.
- Extend the preset shape with optional `filters: { period?, accountId?,
  ownerSelections?, tagFilters? }`.
- When the user picks a preset with captured filters, push those filters
  through `FilterContext` instead of (or in addition to) the current ones.
  Decide whether the active filter pills should visually distinguish
  preset-driven filters from manually-applied ones.

## Cross-user sharing of tag reports

**Context.** Currently per-user via `useUserPreference` (key
`ui.dashboard.tagReports`). Each user has their own presets, no
cross-pollination.

**Why deferred.** Single-user development for now. Sharing model wasn't
fully decided — possible designs include opt-in per-preset (`shared: true`
flag), explicit copy-to-other-user, or path-prefix naming
(`alice/<report>`).

**Suggested approach when picked up.**

- Migrate preset storage out of user preferences into a small backend
  table: `tag_report(id, owner_id, name, tag_ids JSON, shared INTEGER,
  created_at)`.
- Frontend `getTagReports` returns the union of the caller's own presets
  plus any with `shared = 1`; the picker decorates shared presets so the
  user knows they aren't unique to them.
- Mutations (rename/delete) limited to the owner. Non-owners see read-only.
- The existing `useUserPreference`-backed list can be migrated in one shot
  on first run.

## Richer report builder

**Context.** Today's builder is a flat tag-checkbox list. Future ideas
discussed: drag-to-bucket for multi-bucket comparisons, or a
natural-language template where the user fills tags into a phrase
("compare [Alice] vs [Bob] for [Essential]").

**Why deferred.** Worth seeing how the simple version actually gets used
before investing in a richer one — the patterns users reach for will
inform the right next step.
