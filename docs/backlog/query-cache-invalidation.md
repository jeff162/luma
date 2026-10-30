# Dependency-based cache invalidation

Parked, and maybe never needed. Writes that change a transaction go through `txnMutations`
(`frontend/src/lib/txnMutations.js`), which calls `notifyTransactionsChanged()` after each write, and an
eslint `no-restricted-properties` rule stops callers from skipping it. That one function decides which
transaction-derived views refresh. A new view adds its refresh there and callers stay unaware.

## The idea

Replace the hand-wired refresh list with dependency-based invalidation: each view declares the data it
depends on (a query key such as `transactions` or `tasks`), and a mutation says "transactions changed".
Anything keyed on it re-derives, and nobody maintains a list of consumers. A query-cache library
(TanStack Query, SWR) does this out of the box, or it can be a small in-house key → subscribers registry.

## When it is worth it

It is an architectural shift: a new dependency or a hand-rolled cache, every data-loading screen moved
onto it, and a different mental model for the whole app. Revisit when one of these holds:

- `notifyTransactionsChanged` grows a long, easy-to-forget list of refreshes;
- several unrelated domains need the same pattern;
- over-refetching from broad notifications becomes a measurable performance problem.

## If picked up

Prefer TanStack Query unless bundle size rules it out. Move read paths onto query keys first, leaving
`txnMutations` as the write seam, then switch `notifyTransactionsChanged` to invalidate keys instead of
calling refreshers. Callers do not change.
