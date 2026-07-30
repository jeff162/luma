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
