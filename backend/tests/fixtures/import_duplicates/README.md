# Import Duplicate Fixtures

These CSVs are are crafted to exercise the duplicate-detection logic.

Covered scenarios:

- `duplicate_prior_base.csv`
  - baseline import that establishes a coverage window ending before the file's terminal day

- `duplicate_new_overlap.csv`
  - cross-source overlap against that baseline
  - includes covered-day duplicates on non-terminal days
  - includes terminal-day overlap plus one genuinely new row on the same day

- `duplicate_new_exact.csv`
  - exact content-hash duplicate that should be rejected before covered-day logic

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
