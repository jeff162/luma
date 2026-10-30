# Searching the help pages

## What it is

A search box on the Help page's topic index, so an article can be found by typing a word instead of
scanning the list. Typing filters the topic cards into a flat list of matches; clearing the box restores
the normal sectioned index.

**Where it stands:** parked, not started. A search that only matches titles and summaries misses most of
what people would search for, and article bodies are not plain text (below).

The box sits in the sticky "Topic index" header beside the section jump-pills. `pages/Help.jsx` renders
the index from `HELP_TOPICS` (`help/content.jsx`). While a query is active the jump-pills are hidden, and
an empty result shows a quiet "No topics match".

## The depth-of-match problem

Each topic has a plain-text `title` and `summary`, but its `body` is a JSX component, so there is no
plain text to search. The options:

1. **Title and summary only.** No authoring cost, but it misses a term that appears only in a body
   ("dedupe", "reconcile", "PayPal"), which is the case that motivates search.
2. **A per-topic `keywords` field** in the registry. Reaches body terms without extracting text, at the
   cost of ongoing authoring: every topic needs keywords, and the existing ones need backfilling.
3. **Full body-text search.** Extracting reliable text from a component tree is fragile. Not recommended.

## Direction

Build option 1 as the mechanism (the box and the filtering are the same whatever the match depth), then
add option 2's `keywords` so matches reach body terms. Worth doing once the topic list is long enough
that browsing it is cumbersome; the section jump-pills may be enough until then.
