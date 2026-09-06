# Transient failures under investigation

**Live register, not a backlog.** Each entry is a test failure that happens intermittently, is not
understood yet, and has been instrumented so the *next* occurrence explains itself. Backlog files hold
work that is parked; nothing here is parked — these are open questions waiting on evidence that only
arrives when the failure next fires.

**An entry is deleted when its failure is fixed**, and this file goes when the last entry does. Anything
durable an entry produced — a rule, an invariant, a lesson about how the system behaves — belongs in the
topic doc that owns it before the entry is removed.

**Read this before re-running a red suite.** The rule it exists to serve is in
[`agent-profile.md`](agent-profile.md) → *Verification And Tests*: a failure is investigated when it
happens, before anything else, because a green re-run destroys the evidence. The gate writes every run
whole to `data/check-logs/` and prints the path on its last line; a failed run's logs are kept until a
later failure replaces them. Check whether a red run matches an entry below before concluding anything
about the change in hand — and note that the entries here manifest in *several different specs*, so the
name of the failing test is not a reliable way to tell them apart.

---

## 1. A valid session cookie is rejected as having no `user_id`

**Status: recurred; the leading hypothesis is disproved and the next instrument is chosen. The
instrumentation is itself covered (`backend/tests/test_auth_rejection_diagnostics.py`), because a
diagnostic for a 1-in-11 failure that is silently broken costs another eleven runs to discover.**

### Symptom

A burst of `401 Not authenticated` responses inside about one second, across every request in flight —
both the browser context and Playwright's `request` fixture at once — then normal service resumes.
Roughly **1 in 11 full gate runs**. The middleware logs:

```
[auth] rejected /api/providers (with a session cookie): no user_id on the session
```

### It wears several different masks, and they are one bug

This is the important part, because it was originally filed as three separate intermittents:

- `import-mapping-controls.spec.js` — a `DELETE /api/import-export/profiles/{id}` returns 401 where the
  helper asserts `[200, 404]`.
- `cash-flow.spec.js` — `GET /api/transactions/summary/monthly-trend?…&view=cash_flow` returns 401, so
  the frame has nothing to draw and `Money out · ` never appears. It reads as "the frame did not switch";
  it did switch, and had no data. That run's log held **30** rejection lines.
- Any other spec unlucky enough to be mid-request during the window.

So a red run's *test name* says nothing about which bug it is. Grep the preserved log for
`[auth] rejected` before theorising.

### What the evidence establishes

From a preserved Playwright trace (`retain-on-failure` keeps trace, video and screenshot), read on the
**failing requests themselves** rather than on the page load:

- The cookie sent is a well-formed three-segment `itsdangerous` value.
- Its payload base64-decodes to `{"user_id": "…", "pwless": true}` — a real identity, present.
- The server nonetheless reports no `user_id`.

A payload that decodes but is discarded means **signature verification failed**: `SessionMiddleware`
answers a cookie it cannot verify with `session = {}`, which is indistinguishable downstream from having
sent nothing.

### The secret cannot differ, so a key mismatch is not the cause

The inference drawn from that used to be "the cookie was signed with a different key than the process
verifying it holds", and the open question was how two keys could arise in one process. They cannot, and
no amount of arranging the processes will produce them: **the harness pins the secret to a literal
constant.** `scripts/run-e2e-backend.sh` writes the isolated env file it then launches against —

```sh
DATA_DIR=$E2E_DIR
SESSION_SECRET=e2e-playwright-secret
```

— and that value is not in `PLACEHOLDER_SESSION_SECRETS` (`runtime_config.py`), so `_reject_placeholder_secret`
passes it through and it is used verbatim. Every process, in every run, signs and verifies with the same
string. Generation, storage, and persistence never enter it.

Three things follow, and the third is the reason this section exists rather than a note:

- A stale `tests/.auth/state.json` from an earlier run would verify perfectly well, so cookie staleness is
  not a candidate either. (`globalSetup` re-mints it every run regardless — there is no reuse path.)
- `session_cookie_name` is a digest of the control-DB path and stored on first run, so it is constant
  across runs and distinct from a dev stack's. Not a candidate.
- **The instrument this entry used to propose — a fingerprint of the session secret logged at startup, to
  compare two runs — can only ever print the same value.** Do not build it.

**No trace survives for the second occurrence** — a re-run of `npm run ui:test` clears `test-results/`
on startup, which is worth knowing before re-running anything: the gate's own `data/check-logs/` entry is
kept (failed runs are never pruned; see the `.failed` marker), but Playwright's trace, video and
screenshot are not.

### Ruled out, with the evidence for each

- **Secret rotation mid-run.** `config = app_config.resolve()` runs once at module import
  (`backend/main.py`), and the preserved log shows exactly one `Started server process` — no restart.
- **Cookie expiry.** No `max_age` is passed to `SessionMiddleware`, so Starlette's 14-day default applies
  against a run lasting well under a minute.
- **`POST /api/auth/demo-data/clear`**, which runs immediately before the window that first exposed this.
  It wipes tenant data tables only; it never touches the control database, identities, or the session.
- **A spec turning the perimeter on**, which would make the middleware clear a `pwless` session
  deliberately. Nothing under `frontend/tests/ui/` references `auth_enabled` or sign-in protection, and
  that path logs a different reason.

### Where it fires, which is the surviving lead

The second recorded occurrence (`data/check-logs/20260906-093646-545354/frontend-check.log`, lines 83-84)
was **two** rejections rather than a burst of thirty, and their position is the fact worth having:

```
✓ 15 [demo-cleared] › demo-clear.setup.js   (47ms)
✓ 16 [import] › ...falls back to a temporary draft
  [auth] rejected /api/import-export/preview       (signed cookie, session keys: -)
  [auth] rejected /api/import-export/profiles/{id} (signed cookie, session keys: -)
✘ 17 [import] › ...applies it without asking
```

Both occurrences sit at the same seam: the `demo-cleared` → `import` **phase transition**, where ten
parallel workers finish one project and adopt `storageState` for the next at once. The `clear` call
beside it stays ruled out on its own code (tenant data tables only) — what the two occurrences have in
common is the boundary, not the wipe.

With the secret constant, `signed cookie, session keys: -` narrows to a cookie that reaches the server
**altered or substituted** — a genuine `BadSignature` — or a second cookie under the same name. Expiry is
out (no `max_age` against a run under a minute), and Starlette never signs an empty session.

### What the next occurrence will say

The rejection line now carries two more facts, and neither is the session itself:

- `session keys:` — the session's field *names*. `-` means the session did not decode or was cleared;
  names without `user_id` would mean something wrote a session that never had one.
- the cookie's state — `no cookie`, `cleared cookie` (Starlette writes the literal `null` when a session
  is emptied, which used to be indistinguishable from a failed signature), or `signed cookie`.

`signed cookie, session keys: -` confirms the reading above without needing a trace.

**The instrument to add next** follows the value rather than the key: the raw cookie's **length and a
short non-reversible digest**, plus whether the `Cookie` header carried the session name more than once.
Neither reveals the session. It splits the two survivors in one line — a digest matching the known-good
cookie means verification itself is failing and the fault is below the app, while a different one means
something replaced or truncated the value, and the phase boundary says where to look.

---

## 2. Two documents on one transaction list in the wrong order

**Status: instrumented, waiting on a recurrence.**

### Symptom

`test_documents_api.py::AttachAndServeTests::test_several_documents_hang_off_one_transaction_in_attach_order`
fails: two documents attached to one transaction come back in reverse attach order.

**Roughly 1 in 11 full backend runs, and never in 60 runs of that file alone** — it needs the parallel
suite (pytest-xdist, 20 workers). That asymmetry is itself the most interesting fact about it.

### Why it is strange

The listing already has the tiebreaker anyone would reach for
(`services/documents.py` → `list_documents`):

```sql
SELECT … FROM document WHERE txn_id = ? ORDER BY created_at, rowid
```

Each test builds its own temp database, so the table is two rows old and the rowids are 1 and 2. The
tiebreaker therefore cannot be what failed, which leaves `created_at` — written by `utcnow_iso()` at the
`INSERT`, microsecond ISO-8601. A healthy run has the two about 8ms apart and correctly ordered.

The one way ISO-8601 strings sort against chronology — `isoformat()` omits the microsecond field entirely
when it is zero, giving a 19-character string against a 26-character one — was checked and is **not** the
explanation: the shorter value is a prefix of the longer, so it still sorts first in both directions.

### What the next occurrence will say

The assertion now dumps `rowid`, `id` and `created_at` for both rows, which separates the three
candidates: equal timestamps (a tie the rowid should then have settled), an inverted pair (the wall clock
moved backwards mid-run), or rowids that are not what a fresh table should hold.

---

## Not an entry: the cash-flow frame

Recorded because it was briefly filed as its own intermittent and someone will otherwise re-open it.
`cash-flow.spec.js` failing with `Money out · ` never visible is **entry 1**, not a Dashboard bug. Its
trace showed the frame switching correctly and its data request returning 401.
