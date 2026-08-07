# Miscellaneous follow-ups

**Status: running catch-all (started 2026-07-30).** A home for genuine one-offs too small to
warrant their own backlog file. When an entry here grows into a real initiative, promote it to
its own file; when it ships, delete the entry.

## CHANGELOG entry for tag-as-owner replacement

**Context.** The four-phase work that removed `owner_id` from `category`
and replaced category/group ownership with the tag inheritance model is
user-visible (the Categories panel UI changed, the Split-by-owner
dashboard panel is gone, tag reports replaced category-owner filtering).

**Why deferred.** Asked at the end of Phase 3 / Phase 4 and didn't get an
answer; held off rather than guess at the right tone. `CHANGELOG.md` now
exists with an `[Unreleased]` section that already documents adjacent
removals (the pre-auth security UI, the Merchant Renames tab), but it still
lists the old owner model under *Added* and never calls out the
category-owner → tag migration — so this entry is still unwritten.

**Suggested approach when picked up.** Standard CHANGELOG line under the
`[Unreleased]` section, calling out the migration of category ownership to
tags and pointing at the Help-page topic for users who want the model
explained.

## Denser layout for the Connections tab

**Context.** At seven-plus connections the tab is a long stack of tall cards. Moving each card's
five action buttons behind a single "⋯" (see `ui-patterns.md`) removed the button noise, but the
card *height* is a separate problem the menu doesn't touch — institution name, badges, and one row
per account, per connection.

**Why deferred (2026-08-07).** Raised as a possible follow-on right after the menu change and
deliberately not bundled with it: the menu may well have solved enough of the density complaint on
its own, and rebuilding the card layout before knowing that would be speculative.

**Suggested approach when picked up.** Confirm the density still reads as a problem *after* living
with the "⋯" change. If it does, a one-row-per-connection layout (institution + accounts inline +
the existing badges + "⋯") would roughly halve the page height; the accounts list is the card's
useful content, so it should stay visible rather than move behind an expander.
