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

**Status: SOLVED — the host clock steps backwards mid-run and briefly invalidates every session cookie
signed in the window it skipped. What remains is a decision about `max_age`, below, not an
investigation. The instrumentation that found it is covered
(`backend/tests/test_auth_rejection_diagnostics.py`), because a diagnostic for a 1-in-11 failure that is
silently broken costs another eleven runs to discover.**

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

### Third occurrence — a trace survives this time

`data/check-logs/20260906-145843-597684/`, with Playwright's **trace, video, screenshot and error
context copied in beside the logs** (`playwright-artifacts/`) so a later run cannot clear them the way
it cleared the second occurrence's. Reading that trace is the next step, and it can be done at leisure
now that it is out of `test-results/`.

It lands at the **same phase boundary for the third time**, two tests past the transition rather than
one:

```
✓ 16 [demo-cleared] › demo-clear.setup.js   (58ms)
✓ 17 [import] › ...falls back to a temporary draft
✓ 18 [import] › ...applies it without asking
  [auth] rejected /api/tasks                       (signed cookie, session keys: -)
  [auth] rejected /api/tasks                       (signed cookie, session keys: -)
  [auth] rejected /api/import-export/profiles/{id} (signed cookie, session keys: -)
✘ 19 [import] › ...asks which to use
```

Three rejections, and the mix is the new fact: `/api/tasks` twice is the **app polling from the browser
context**, while the profile `DELETE` comes from Playwright's `request` fixture. Two different cookie
jars are rejected inside the same window, which is what "every request in flight" meant in the first
occurrence and had not been visible in the second. Whatever fails is not specific to one client.

### The trace was read, and it disproves the remaining hypothesis

That instrument no longer needs building: the preserved trace answers it directly, and the answer is
that the cookie is **not** the problem.

Every `/api/` request in the trace was pulled apart — its `Cookie` header measured and digested, and the
three distinct session values that appear across the run **unsigned offline against the pinned
`e2e-playwright-secret`**. All three:

- carry a **valid signature** (`TimestampSigner.unsign`, 14-day `max_age`, no exception),
- decode to `{"pwless": …, "user_id": …}` with the **`user_id` present**,
- are **127 bytes**, and appear exactly once in their `Cookie` header.

So the value that produced `signed cookie, session keys: -` is intact, correctly signed, and carries an
identity. **It is not altered, truncated, substituted, duplicated, or expired**, and it is not a genuine
`BadSignature` — which is what the section above had narrowed to. That reading is wrong and the search
should not resume there.

**The same value both works and fails, minutes apart.** Digest `e6d92f15` was sent on 23 requests: it
was rejected on two `GET /api/tasks` and one `DELETE /api/import-export/profiles/{id}`, and accepted on
the other twenty — including a `GET /api/tasks` before, and a `POST /api/import-export/profiles`
**afterwards**. The fault is therefore time-dependent, not value-dependent, which no property of the
cookie can explain.

```
18:59:51.097  401 GET    /api/tasks                       e6d92f15
18:59:51.173  401 GET    /api/tasks                       e6d92f15
18:59:51.173  200 GET    /api/auth/status                 e6d92f15   <- same cookie, same instant
18:59:51.189  200 POST   /api/auth/select-identity        e6d92f15
18:59:51.197  200 …everything…                            49f28730   <- new session from here
18:59:51.903  401 DELETE /api/import-export/profiles/{id} e6d92f15   <- request fixture, stale jar
18:59:52.176  200 POST   /api/import-export/profiles      e6d92f15   <- and it works again
```

Two clients are involved, which is what "every request in flight" meant: `/api/tasks` is the app polling
from the **browser context**, the `DELETE` is Playwright's **`request` fixture**, and they hold separate
cookie jars. The `auth/*` calls beside the rejections succeed only because they are in `public_paths` —
they never look for a `user_id`.

### What is left, and the one line that splits it

`_not_authenticated`'s own docstring enumerates three situations behind this message. The trace rules out
two (the cookie is neither cleared nor unverifiable) and the third — "a session that verified perfectly
well but was written without a `user_id`" — is contradicted by the decoded payload. **The middleware
handed the app an empty session for a cookie that verifies.** Whatever is wrong sits between
`SessionMiddleware` decoding the cookie and `TenantSessionMiddleware` reading `scope["session"]`, not in
cookie custody.

**The instrument is in place** (`_reverified_here` in `backend/main.py`, covered by
`test_auth_rejection_diagnostics.py`). Every rejection line now carries a third fact — whether *this
process*, with *its own* secret, can verify the cookie it was handed, and whether what comes out names a
user. The value is never logged, only the verdict:

```
[auth] rejected /api/tasks (signed cookie, session keys: -, re-verified here: …): no user_id on the session
```

It answered on its **first firing**, and the answer was not on the list.

### The verdict: `expired` — and the clock is the suspect

`data/check-logs/20260906-161559-622439` (this time `cash-flow.spec.js`, one of the masks above). Every
one of the **35 rejection lines in that run carries the same verdict**:

```
[auth] rejected /api/tags (signed cookie, session keys: -, re-verified here: expired): no user_id …
```

Not `BadSignature`, so the secret is confirmed correct — the earlier offline check and the process agree.
Not `verifies, user_id present`, so the decode step is not at fault either. The cookie's **timestamp** is
what fails, and `itsdangerous` raises `SignatureExpired` for two opposite situations:

* `age > max_age` — a genuinely stale client. Ruled out here: `tests/.auth/state.json` is re-minted every
  run (checked: 68 seconds old, verifying cleanly, `expires` 14 days out).
* **`age < 0` — the cookie was signed *ahead* of the clock now verifying it.**

Only the second can happen inside a run lasting under a minute, and it accounts for every property this
entry has collected and could not previously explain:

| observed | explained by a backwards clock step |
| --- | --- |
| a burst inside ~1 second, then normal service | the step's size *is* the outage's length |
| every request in flight, both cookie jars | every cookie signed in the skipped window is invalid at once |
| the same cookie value failing, then working again later | it becomes valid again as real time passes its stamp |
| ~1 in 11 runs | a run has to overlap a correction |
| the secret cannot differ, and the cookie is intact | neither is involved |

The phase-boundary correlation recorded above now reads as incidental: that is simply where the most
requests are in flight, so it is where a step is most likely to be *noticed*.

**The environment fits.** This runs on a **WSL2 guest with `NTP service: active`**. A WSL2 VM's clock
drifts whenever the host sleeps or idles, and the correction is a step — including backwards.

### Confirmed: the clock steps backwards, by one to three seconds, repeatedly

The very next run was **green**, and carried **81 rejections** — every one of them negative:

```
52 × re-verified here: expired (age -2s)
27 × re-verified here: expired (age -1s)
 2 × re-verified here: expired (age -3s)
```

A negative age is not ambiguous. The cookie was signed one to three seconds **ahead** of the clock that
then verified it, by the same process, seconds later. Nothing about the cookie, the secret, the client or
the middleware ordering is involved: the wall clock moved backwards between signing and verifying, and
`SessionMiddleware`'s `max_age` check reports that as an expired signature and hands the app `session =
{}` — indistinguishable, downstream, from no session at all.

That also explains why the failure is only *occasionally* a failure. Steps happen throughout every run;
a run goes red only when one lands on a request a test asserts on. Roughly one in eleven, as recorded.

**This is not only a test problem.** The same thing happens to a real user whose machine's clock steps
back — a laptop resuming from sleep, a VM being restored, any NTP correction. They are signed out for
the length of the step, with no explanation. That makes the entry a product decision rather than a
harness fix:

* **`max_age=None` on `SessionMiddleware`** — the timestamp is not what secures the cookie (the
  signature is), and the browser's own `expires` still bounds its life. Removes the failure mode
  outright, at the cost of a server-side lifetime bound.
* **Keep `max_age` and tolerate a small negative age** — needs a subclass, and picks an arbitrary
  tolerance.
* **Leave it**, treating it as the environment's problem.

Nothing has been changed on the strength of this: it alters how sessions expire for every install, which
is the user's call, not a conclusion an investigation gets to make on its own.

**Status: understood, awaiting that decision.** When it is taken, the durable half of this entry —
`SessionMiddleware` answers a timestamp failure and a missing cookie identically, and the diagnostic that
tells them apart — belongs in `security-model.md` before the entry is deleted.

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
