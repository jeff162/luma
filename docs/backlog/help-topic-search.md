# Help-page topic search

**Parked, not started (2026-07-25).** Add a search box to the standalone Help page (`/help`) index —
in the sticky "Topic index" header, alongside the section jump-pills — so a user can find articles by
typing rather than scanning the sectioned list. Deferred because its usefulness is limited until the
match can reach the *article text*, not just titles/summaries (see below).

## What it is

`pages/Help.jsx` renders the index as sectioned cards, each from a `HELP_TOPICS` entry
(`help/content.jsx`). A live search would filter the cards as the user types and show a flat list of
matches across sections, hiding the section jump-pills while a query is active (they navigate the full
list) with a quiet "No topics match" empty state. Clearing the box restores the normal sectioned index.

## Why it's parked — the depth-of-match problem

Each topic has a plain-text **`title`** and **`summary`**, but its **`body` is a JSX component**, so
there is no plain-text article body to search. The options, cheapest first:

1. **Title + summary only** — zero authoring cost; summaries are fairly descriptive. But it won't find
   an article by a term that lives only in its body (e.g. "dedupe", "reconcile", "PayPal") — which is
   exactly the "articles that talk about X" case that motivates the search. This is the concern that
   parked it.
2. **Add a per-topic `keywords` / `searchText` field** to the registry so search can hit body-level
   terms without full-text extraction. More thorough, but ongoing authoring: every new topic needs
   keywords and the existing ones need backfilling. This is the likely path if the feature is revived.
3. **Full body-text search** — the bodies are JSX; extracting reliable searchable text from a component
   tree is fragile. Not recommended.

## Direction if revived

Build option 1 as the mechanism (the search box + filtering UI is the same regardless of match depth),
then layer option 2's `keywords` field on top so matches reach body terms. Revisit only if the Help
content grows enough that browsing the sectioned list becomes cumbersome — with the current topic count,
the section jump-nav may already be sufficient.
