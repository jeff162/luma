# Watched import folders

**Design, not started (2026-09-20).** A data source may name a directory; files dropped there are
imported without anyone opening the Import page. The value is the monthly-export routine: download the
file, and it is in the ledger the next time the app is open.

Most of the machinery already exists, which is what makes this worth doing rather than large. Content
hashing plus `idx_import_batch_file_hash` already answers "have we taken this exact file" exactly; a
saved source already carries the column map, the date format and the amount convention; and every
outcome an unattended import can produce — duplicates, refused rows, rows needing review, rule
suggestions — already has a review surface on the file's card. The unattended path does not need new
places to report to. It needs a way in, and a rule for when to refuse.

## Decisions already taken

- **A directory per data source, and no one-folder mode.** Someone who prefers a single folder points
  several sources at the same path. The alternative — one folder plus a per-source filename pattern —
  is not needed as a *primary* discriminator because `csv_import_profile.filename_pattern` already
  exists and already resolves a profile (`routers/import_export/preview.py`), so it stays available as
  a fallback without being designed for.
- **Never create an account unattended.** A file whose account values do not all resolve is parked, not
  imported. This is the whole safety rule: everything else an unattended import gets wrong is visible
  and reversible on the card, while an invented account quietly splits a ledger.
- **A parked file raises a Task**, which opens the ordinary import flow with the file pre-seeded. Tasks
  already carry the dismissal semantics this wants (`routers/tasks.py`).
- **Purging is opt-in and defaults to never.** Per source: never / after N days / immediately on a
  successful import. Only files this app recorded as imported are eligible — matched on the stored
  content hash, never "everything older than N days in that folder" — and a delete that fails is
  reported rather than swallowed.
- **Files are otherwise left alone.** No move to a `processed/` subdirectory: it is a second mechanism
  for the job the purge option already does, it mutates a folder the user's own tooling may be
  watching, and the content hash makes it unnecessary for correctness.

## The precondition: a source's account map has to be persisted

A multi-account file's `csv_value → account_id` mapping is assembled in the mapping UI on each import
and sent with the config; nothing stores it on the source. An unattended import therefore has no map to
apply, and re-deriving one by name is exactly the guess the safety rule forbids. Persisting it on
`csv_import_profile` (and making it editable, which is worth doing regardless — a source's account
mapping is currently invisible and uncorrectable) is the first piece of work, and it is useful on its
own if the rest is never built.

## When a scan runs

**There is no background scheduler in this app, and this should not introduce one.** Everything is
request-driven, and the app is multi-tenant with per-identity database paths, so a timer thread would
have no tenant to run as and no way to choose one. The precedent to copy is
`POST /recurring/auto-scan`, called from `App.jsx` when the data scope activates and scanning only if
one is due.

Three triggers, all client-driven:

- on app load, if the last scan is older than about an hour,
- on entering Import / Export, so the page can say what is waiting,
- an explicit **Check now**.

**The navigation badge must not scan.** It reads the persisted parked count, which costs nothing; the
filesystem is touched only by the three triggers above.

## How a scan stays cheap

`os.scandir` yields each entry's name, size and mtime for roughly the cost of the syscall, so listing a
folder of a few hundred files is immaterial. The expensive part is reading, hashing and parsing, so
that is what the watermark gates: keep a per-source seen-set of `(name, size, mtime)` and only hash an
entry that is not in it. A file edited in place gets a new mtime, is re-hashed, and is then matched
against `import_batch.file_content_hash` — the durable answer to "already imported" — so a re-hash
costs nothing but the read. Comparing a *file count* instead is both cheaper than necessary and wrong:
a replacement that keeps the count is missed.

Two mechanical guards:

- **A file being written is not ready.** Require `(size, mtime)` to be unchanged across two passes, and
  ignore `.part` / `.crdownload` / `.tmp` and lock-file prefixes. A half-downloaded CSV parses as a
  truncated one, which is worse than not seeing it.
- **A missing or unreadable directory is a source-level notice, not an error per scan.** Removable
  media and network shares come and go.

## Restore, and why it cannot simply keep the paths

A restored backup carries another machine's directory paths. The rule: **the same instance keeps its
paths; a different one has watching switched off with a Task raised**, so the person decides what those
folders should be on this machine rather than discovering that the app has started reading a path that
means something else here.

The comparison already exists — `_restore_preflight` in `import_export/backup.py` compares the
backup's `instance_id` against the target's — but note two things before relying on it. It is evaluated
only when the target *has* data, so a restore into a fresh install needs its own answer (treat an empty
target as a different instance: nothing about it says these paths are still right). And the restore
**adopts the backup's `instance_id`** once the wipe is done, so the verdict has to be captured before
that point and carried, not re-derived afterwards.

This matters more than it sounds: the installs in use include a source checkout with different paths
and a Windows portable build, and a path that resolves on the wrong machine is the failure mode worth
designing against.

## Where the directory lives, topologically

The path is read by the **server**. On Desktop that is the user's own machine and the distinction never
comes up; on a LAN server it is a folder on the server, and in a container it is a mounted volume — the
browser's machine is irrelevant in both. `operations.md` and the in-app help both need to say so, since
"the folder on my computer" is the natural and wrong reading.

There is also a security question to settle rather than assume: an authenticated user names a directory
and the server reads it on a timer. That is a new capability class (the app otherwise reads only its own
data directory and what is uploaded to it), and `security-model.md` should record what is and is not
being defended before it ships — including whether the purge option, which *deletes* outside the data
directory, belongs in the same release.

## Interaction with import history

Unattended imports produce cards at a steady rate with nobody pruning them, which makes the unwindowed
import history materially worse. [`import-history-windowing.md`](import-history-windowing.md) is
effectively a precondition rather than an unrelated item.

## Considered and rejected

- **OS file-change events (`watchdog`, inotify/FSEvents/ReadDirectoryChangesW).** A new dependency and a
  platform matrix — inotify does not work on WSL's `/mnt` paths or on network shares, which are exactly
  where a watched folder is likely to be — bought against latency nobody feels on a monthly statement.
  Polling on the triggers above is the cheaper and more portable answer.
- **A background scheduler thread.** No tenant context outside a request, no way to choose which
  databases to scan, and a whole class of failure with nobody watching. See *When a scan runs*.
- **Moving imported files to a `processed/` subdirectory.** See *Decisions already taken*.
- **Filename patterns as the way to tell two sources apart.** Directory-per-source needs no new matching
  code and no naming discipline; the pattern field already exists for anyone who wants it.

## Obstacles

- The account map is not persisted (see above) — nothing unattended can run until it is.
- The import pipeline's entry point takes an upload (`POST /run` reads an `UploadFile`). The reusable
  seam underneath it — `run_import_core(text, cfg, filename=...)` — is what a watcher calls, and it is
  already exercised in-process by the demo loader, so this is a matter of using it rather than building
  it.
- An unattended import has no one to answer the interactive stages. Column mapping comes from the
  source; imported-category mapping, duplicates and rule suggestions all defer to card surfaces that
  already exist; account resolution is the only one that must refuse rather than defer.

## Open

- Whether a watched source may create its *first* batch unattended, or must be imported by hand once so
  the mapping is proven before anything runs on its own.
- Whether the purge option ships with the first version at all, given the security note above.
