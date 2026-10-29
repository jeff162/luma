# Cleanup pass (batched low-priority items)

> **Status: backlog.** Small, non-urgent cleanups to do together in a dedicated pass — none block
> current work. Verify with `cd frontend && npm run lint` + the browser console per page.
> Reconciled against the tree on 2026-10-29.

## The file card's *rejected* pill and the *Not imported* view count different sets

The pill counts the three *rejected* kinds it always has, while *Not imported (N)* adds account-skipped
and trailing rows, so a card can read "3 rejected" and open on twelve. Both numbers are honest and the
mismatch is still odd on screen. Changing what the pill counts changes what the card reports, so it is
a decision rather than a fix.

## Press-scoped transient labels (from the 2026-08-19 flicker sweep)

**Unstarted, and deliberately not sweepable.** The 2026-08-19 sweep converted the busy indicators driven
by a **load** and the spinners that replaced content on reload; it left the ~61 labels driven by a
**press** (`Saving…`, `Deleting…`, `Applying…`, `Importing…`). Why they are a different judgement — and
the one question each site has to answer — is in [`../ui-patterns.md`](../ui-patterns.md) → *Loading and
feedback*. What is left here is the pass itself: visit each site, answer the question, and convert only
the ones where something else on screen already reports success.

Find them with `grep -rn "? '[A-Z][a-z]*…'" frontend/src --include=*.jsx`.
