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

## SimpleFIN's window limit rose to 90 days — and became a silent cap

**Context (2026-08-08).** `WINDOW_DAYS` is set from what the live Bridge *says* rather than from its
documentation, because only one of the two is enforced. What it says changed within a day:

```
2026-08-07  "exceeds recommended range of 45 days. In the future, this may be capped."
2026-08-08  "[gen.api] Requested date range exceeds limit of 90 days and was capped."
```

So the limit is now the published 90, and the future arrived: an over-wide request is no longer
tolerated with a notice, it is **silently truncated**. Doubling the window would roughly halve the
requests a full-history walk spends (~5.4 years/day against the 22-request budget, from ~2.7).

**Why deferred.** The cap is the dangerous shape, and nothing currently guards it: the walk advances
each account's frontier by the window it *asked for*, so a capped response would record coverage over
days nothing fetched — the over-claim that makes duplicate detection reject genuine transactions
(`data-model.md` → "coverage has two shapes"). At 45 days there is a wide margin and the cap cannot be
tripped, so the safe option was to leave it and write down why.

**Suggested approach when picked up.** Two parts, and the second is the real work: (1) raise the
window to **~88**, not 90 — a request is a range of *instants* and `_fetch_window` runs the end bound to
the close of its day, so a nominal N-day window is N days plus a further 23:59:59 on the wire, and a
literal 90 would trip the cap on every request; (2) validate the returned range against the requested
one before recording any coverage, so a cap becomes a visible short-fetch rather than a false claim.
Worth doing only if the request saving matters — 45 days already reaches further back than the Bridge's
upstreams actually hold.
