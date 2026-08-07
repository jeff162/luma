# Import Duplicate Fixtures

These CSVs are are crafted to exercise the duplicate-detection logic.

Covered scenarios:

- `duplicate_prior_base.csv`
  - baseline import that establishes a coverage window ending before the file's soft trailing window
  - spans 11/25–12/08 deliberately: a source's last several days are treated as still filling in
    (`terminal_window_days`, default 7), so a file **shorter than its own lag establishes no coverage
    at all**. The span has to exceed the window for the covered/trailing interaction to exist to test.

- `duplicate_new_overlap.csv`
  - cross-source overlap against that baseline
  - includes covered-day duplicates (11/26, 11/27 — inside the fully-covered stretch)
  - includes trailing-window overlap (12/05, 12/08) plus one genuinely new row on the last day,
    which imports rather than being blanket-rejected — the whole point of the trailing window

- `duplicate_new_exact.csv`
  - exact content-hash duplicate that should be rejected before covered-day logic

- `duplicate_connection_covered.csv`
  - a file landing in an account a **data connection** already claims coverage over, which is the
    second direction of the union coverage reads (the first — a synced row rejected by a *file's*
    coverage — lives in `test_sync_dedupe.py`)
  - two rows inside the connection's fully-covered stretch, one inside its soft trailing window and
    one past the claim entirely, so the file exercises both the rejection and its bounds

- `duplicate_new_text_match.csv`
  - cross-source text/evidence duplicate without a prior coverage window

- `duplicate_same_file_allowed.csv`
  - identical rows inside one CSV, which should both import because intra-file duplicates are allowed

- `duplicate_linked_base.csv` + `duplicate_linked_compare.csv`
  - duplicate detection against a linked existing account when the new file is imported into a brand-new account with `duplicate_compare_account_id`
  - covers one exact duplicate, one covered-day duplicate, one heuristic cross-source duplicate, and one genuinely new surviving row

- `duplicate_grouped_base_a.csv` + `duplicate_grouped_base_b.csv` + `duplicate_grouped_compare.csv`
  - duplicate detection against a real merged account group with three member accounts
  - one grouped child establishes coverage, a second grouped child supplies exact/text duplicate candidates, and the newly imported grouped child still keeps its genuinely new row

- `duplicate_terminal_same_amount_base.csv` + `duplicate_terminal_same_amount_overlap.csv`
  - terminal-day reconciliation where multiple prior rows share the same amount
  - proves the importer only consumes the finite set of historical same-day rows and still imports the extra same-amount row

- undo then reimport
  - covered by reusing `duplicate_prior_base.csv` in the test module
  - proves an undone batch no longer blocks a clean reimport of the same file

Expected final-ledger snapshots are stored as companion CSVs so tests can
compare the normalized imported ledger to a known-good result instead of only
checking counts.

## Running the tests

These fixtures are exercised by:

`python3 -m unittest backend.tests.test_import_duplicate_detection`

The backend Python dependencies need to be installed first. In particular,
multipart form parsing is used by the real import endpoint, so
`python-multipart` must be present along with the rest of `backend/requirements.txt`.
