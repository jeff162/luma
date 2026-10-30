# Help-page topic search

Not started. A search box on the `/help` index, in the sticky "Topic index" header beside the section
jump-pills, to find articles by typing. Parked because it is of limited use until a match can reach the
article text, not just titles and summaries.

## What it is

`pages/Help.jsx` renders the index as sectioned cards from `HELP_TOPICS` (`help/content.jsx`). A live
search filters the cards as the user types into a flat list across sections, hides the jump-pills while a
query is active, and shows a quiet "No topics match" when empty. Clearing the box restores the index.

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
