# Sync status surface (and the shapes rejected on the way to it)

**Status: designed, not built (2026-08-16).** The backend half shipped — a sync no longer blocks the app,
commits per page, and publishes live progress. What remains is the UI that shows it.

## Why this exists

A data-connection sync, especially a first backfill, takes minutes. During it the app used to route but
not load: navigation is client-side so clicks worked, while anything that *wrote* waited out the busy
timeout and failed. The obvious reading was "block the UI behind a modal with a cancel button until the
sync finishes", and that was the wrong fix — it would have hidden a database problem behind a scrim.

The cause was `run_sync` holding one write transaction across every provider HTTP call. That is fixed
(see `architecture.md` → Database concurrency, and → Provider connections for the paging contract), which
removes the reason to block anything. What is left is the genuine need underneath the original request:
**while a sync runs, the user should be able to see that it is running, how far it has got, and stop
waiting on it — from anywhere in the app.**

## What the backend already provides

- `connection.sync_started_at` — a run exists (read through `sync_marker_is_live`; a marker from a dead
  process expires rather than disabling "Sync now" forever).
- `connection.sync_progress` — JSON, written at every page commit, cleared when the run ends. Rows added
  so far, requests made, pages drained.
- `connection_account.coverage_start_date` — per account, advanced per page. Real progress in the domain's
  own terms ("reached March 2024" beats a percentage).

All three come back on the existing connections endpoint. No new polling route is needed.

## The design

Reuse the established detached-panel pattern rather than inventing a surface; `ui-patterns.md` →
Minimize-to-nav-bar states that a new one "should be a fourth wrapper, not a bespoke context".

- `useDetachedReportViewer` (`frontend/src/lib/useDetachedReportViewer.js`) — open / minimize / restore
  with data intact.
- `MinimizedReportPill` (`frontend/src/components/MinimizedReportPill.jsx`) — the generic nav chip.
- A `SyncStatusProvider` in `frontend/src/contexts/`, mounted with the other viewer providers in
  `App.jsx`, its renderer above `<Routes>` and its nav item in the chip slot.

Three things make this different from the three viewers already using that seam, and each is a place to
be careful:

1. **The provider must own the poll loop, not just the state.** The existing viewers hold a snapshot
   fetched once; `syncUntilComplete` is a live driver. Today it lives in the Accounts page, so navigating
   away mid-sync leaves it running in a detached closure writing to an unmounted component — the work
   continues invisibly and its results land nowhere. Lifting only the state would strand the driver.
2. **Rehydrate on mount from the server marker.** `useDetachedReportViewer` is in-memory by design, so a
   browser reload drops everything — acceptable for a report you can reopen, not for a sync you cannot
   otherwise tell is running. This is what `sync_started_at` + `sync_progress` are for, and the one thing
   lifting state cannot fix on its own.
3. **Cancel is "stop polling".** The in-flight page finishes on its own, its commit stands, and the next
   sync resumes from the checkpoint. No backend cancellation, no request to abort — the resumability that
   paging already provides *is* the cancel semantics.

`Accounts.jsx` keeps its card-level display but consumes provider state instead of local `syncState`.

## Rejected, with reasons

- **A blocking modal.** The original request, and the right instinct about the symptom. Once the backend
  releases the lock between requests there is nothing to protect the user from, so blocking would cost
  usability for no safety.
- **Producer/consumer threading** — a fetch thread feeding a processing thread, with a supervisor for
  cancel. It targets the wrong constraint: the two threads would need separate connections and would
  contend for the very write lock this work exists to free, the GIL means no CPU parallelism, and the
  queue between them only helps if it is durable, which is the staging table below. The *architectural*
  separation it describes already exists without threads — `ProviderAdapter` is the provider-facing seam
  and the sync loop's insert/modify/remove path is the common ingestion engine every provider feeds.
  Overlapping fetch latency with processing is a real ~30-40% wall-time win, but it is an optimization and
  should be measured before it is built.
- **A raw staging table** for provider payloads, written before processing. Per-page commits already make
  fetched rows durable as they arrive; a staging table would add a second write path and a
  resume-from-staging path to protect only against a *processing* bug costing re-fetched requests. Worth
  revisiting only if re-fetch cost against a metered provider actually bites.

## Also noted while investigating

The dev server burns ~27% CPU continuously because `uvicorn --reload-dir backend` watches ~8,200 files, of
which ~7,500 are `backend/venv/`, and the fallback `StatReload` watcher `stat()`s all of them several times
a second. `pip install watchfiles` switches uvicorn to the inotify-based reloader and removes it. Unrelated
to sync responsiveness — a busy watcher does not block SQLite writers — but it muddies any measurement
taken on this machine.
