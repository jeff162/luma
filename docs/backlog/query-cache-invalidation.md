# Dependency-based cache invalidation (frontend data freshness)

**Status: parked — maybe never (migrated from `TODO.md` 2026-07-30).** Only worth it if
transaction-derived views proliferate enough that hand-maintaining the notify→refresh set
inside `notifyTransactionsChanged` starts to hurt. The current event-bus seam already removed
the real pain.

**Context.** Writes that change a transaction's categorization/trashed state
now go through the `txnMutations` layer (`src/lib/txnMutations.js`), which
fires a single `notifyTransactionsChanged()` after each write. That notify is
already the single place that decides which transaction-derived views refresh
(it has grown past its original lone `refreshTaskBadge()` call). As more views
come to depend on transaction data (dashboard totals, the Categories page's
uncategorized counts, reports), the natural move is to add their refreshes
inside that one function — callers stay unaware. This is the imperative "mutation announces,
listeners re-fetch" model, and it scales fine for a handful of consumers.

This item is the *next* step beyond that, and is **not** something that needs
doing — only worth it if the number of derived views (and the cost of
hand-maintaining "which mutation refreshes which view") grows enough to hurt.

**The idea.** Replace the hand-wired notify→refresh map with
dependency-based invalidation: each view declares the data it depends on
(e.g. a query key like `transactions` or `tasks`), and a mutation simply
says "transactions changed." Anything keyed on that re-derives; nobody
maintains an explicit list of consumers. This is what a query-cache library
(TanStack Query / SWR) gives you out of the box (`queryClient.invalidate
Queries(['transactions'])`), or it can be a small in-house key→subscribers
registry if pulling in a dependency isn't wanted.

**Why deferred / why maybe never.** The current event-bus + `txnMutations`
seam already removed the real pain (callers forgetting to notify — now
impossible, enforced by the `no-restricted-properties` eslint rule). The
remaining benefit is only "stop hand-maintaining the invalidation set inside
`notifyTransactionsChanged`," which is cheap while that set is small. A
query-cache is a real architectural shift: a new dependency (or a hand-rolled
cache), every data-loading screen migrated onto it, and a different mental
model for the whole app. For a single-user app with a few derived views, the
cost outweighs the gain. Revisit if/when: (a) `notifyTransactionsChanged`
grows a long, easy-to-forget list of refreshes, (b) multiple unrelated
domains need the same pattern, or (c) over-refetching from broad broadcasts
becomes a measurable performance problem.

**If picked up.** Prefer TanStack Query unless bundle size rules it out;
migrate read paths to query keys first (leaving `txnMutations` as the write
seam), then switch `notifyTransactionsChanged` to invalidate keys instead of
calling refreshers directly. The `txnMutations` boundary is deliberately the
right place to make this swap — callers won't need to change.
