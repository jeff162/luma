# Small UI cleanups to batch

## What it is

Two small, unrelated fixes to do together:

- **The import card's "rejected" count disagrees with the list it opens.** A card can say "3 rejected"
  and open a list of twelve.
- **"Saving…"-style button labels that flash for an instant.** Some can go, where the screen already
  shows the result.

**Where it stands:** not started, not urgent, and neither blocks other work. Verify with `cd frontend &&
npm run lint` and the browser console on each page touched.

## The file card's *rejected* pill and the *Not imported* view count different sets

The pill counts the three *rejected* kinds, while *Not imported (N)* adds account-skipped and trailing
rows, so a card can read "3 rejected" and open on twelve. Both numbers are honest, but the mismatch is
odd on screen. Changing what the pill counts changes what the card reports, so it is a decision rather
than a fix.

## Press-driven transient labels

About 60 labels are driven by a **press** (`Saving…`, `Deleting…`, `Applying…`, `Importing…`). They are
not a mechanical sweep: each site answers the question in [`../ui-patterns.md`](../ui-patterns.md) →
*Loading and feedback*. Visit each one and convert only those where something else on screen already
reports success.

Find them with `grep -rn "? '[A-Z][a-z]*…'" frontend/src --include=*.jsx`.
