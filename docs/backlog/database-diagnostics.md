# Database diagnostics

**Status: backlog, not started (2026-08-10).** Nothing in the app ever checks whether its own databases
are intact. There is no health endpoint, no startup check, and — the sharper gap — no check of the
*target* database before a destructive restore. This is the note for building a diagnostics surface, and
for the larger question hiding behind it: structural integrity is the easy half.

## What SQLite already gives us, and what each actually covers

Three pragmas, three genuinely different concerns. Measured against a ~60 MB ledger and its control DB,
both of which came back clean:

| pragma | verifies | cost at ~60 MB |
| --- | --- | --- |
| `quick_check` | page / B-tree / record structure | ~40 ms |
| `integrity_check` | the above **plus** every index agreeing with its table | ~100 ms |
| `foreign_key_check` | referential integrity — orphaned rows | negligible |

**`integrity_check` does not check foreign keys.** They are separate passes, and a database can pass
`integrity_check` with a table full of orphans. That matters here more than in most schemas: accounts →
connections, the four tag-attachment tables, `txn_link_member`, `connection_account`, and a restore path
that wipes and rebuilds in FK-safe order. Any diagnostic worth having runs both.

Orphans are not currently accumulating because enforcement is on per connection — `PRAGMA
foreign_keys=ON` in both `db/database.py` and `db/control_database.py`. SQLite defaults that **off**, so
it is a deliberate choice, and it is the reason `foreign_key_check` is clean rather than a reason to skip
running it.

**The timings kill the usual objection.** `quick_check` exists because `integrity_check` is slow on
multi-gigabyte databases; at this scale the full check is ~100 ms, so there is no need to offer the
cheaper one or to background it. Run the real check.

## The half these do not cover

They verify *SQLite's* structures, not the app's invariants. Everything in `data-model.md` that makes the
data mean something is invisible to them. A database can be structurally perfect and still hold:

- a connection whose `transactions_cursor` sits ahead of a restored ledger, so those rows are never
  re-fetched — a real defect that was found and fixed, and the worked example of an inconsistency the
  pragmas call `ok` (see [`../operations.md`](../operations.md) → restore);
- a coverage claim (`import_batch_account`, `connection_account.coverage_*`) disagreeing with the rows it
  claims to cover;
- a mapping pointing at an account that has since been merged into a group;
- a suspect-duplicate pointer whose counterpart was trashed.

All of those read as `ok`. **Structural checks answer "is the file corrupt"; they never answer "is the
data coherent".** Conflating the two is the trap this note exists to name — a green diagnostic that
implies more than it checked is worse than no diagnostic.

## Shape to build

Start with the structural half, which is small and unambiguous:

- A service that runs `integrity_check` + `foreign_key_check` against **both** databases and returns a
  per-database result plus the offending rows when `foreign_key_check` reports any.
- **Before a destructive restore.** The restore path already verifies the *backup's* `content_sha256`
  before wiping, but never looks at what it is about to overwrite. Checking the target first turns
  "restore onto a corrupt database" into a stated refusal rather than a second corrupt database.
- **A Settings diagnostic**, next to the connection sync log — the existing home for "what is the system
  doing" panels, and a natural place to report WAL/checkpoint state alongside.

Then, as a separate and much larger project, an **invariant checker** over the semantic cases above.
That one needs its own design: which invariants are worth asserting, whether each is a warning or an
error, and — the hard part — whether it can *repair* anything or only report. Do not fold it into the
structural check.

## Open questions

- **User-facing or developer-only?** The structural check is cheap and reassuring, which argues for
  user-facing. The invariant checker reports things most users cannot act on, which argues for
  `LUMA_DEVELOPER_OPTIONS` (see `runtime_config.py`) — the flag already gates destructive dev tooling,
  though note the sync log deliberately sits *outside* it.
- **What happens on failure?** A structural failure is not user-repairable; the honest answer is "restore
  from a backup", which makes this partly a backup-nagging feature. Worth deciding before building, or
  the diagnostic reports a problem with no next step.
- **Scope of the pre-restore check** — refuse outright, or warn and offer `force` (the pattern the
  existing restore-compatibility guard already uses)?
- Is a periodic/background check ever wanted, or strictly on demand? At ~100 ms, on demand seems enough.

## Cross-refs

- [`../operations.md`](../operations.md) → restore — the cursor-ahead-of-ledger case, the worked example
  of an inconsistency no structural check can see.
- `docs/data-model.md` — the invariants an invariant checker would assert.
