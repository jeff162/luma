# FinTrack

> Your financial data, without the friction.

FinTrack is a personal finance tool that helps you import your data, categorize it, and keep it organized with minimal friction.

Start with a CSV export or connect an account, clean up your categories, define rules for common transactions, and let FinTrack apply them as new data comes in.

You stay in control — FinTrack makes it easy to review what changed, spot anything that looks off, and adjust when needed.

Less repetition. Fewer manual fixes. Clear, usable financial data.

## Why FinTrack?

Most personal finance tools follow the same basic model: import data, categorize transactions, define rules, and review the results.

The difference is how much friction that introduces.

FinTrack is designed to reduce that friction:

- Getting data in is quick and flexible (CSV or connected accounts)

- Categorizing and fixing transactions happens directly where the data is

- Rules are easy to create and adjust as you go

- Reviewing your data is straightforward — no digging through menus or workflows

You still do the same core tasks — FinTrack just makes them easier to do and easier to maintain over time.

## What does FinTrack do?

FinTrack helps you turn raw financial data into something organized and usable.

You can:

- import transactions from CSV or connected accounts

- categorize and organize your data across accounts and owners

- define rules to handle recurring transactions

- review and maintain your data as new transactions come in

- analyze spending with dashboards and drill-down views

All core functionality runs locally on your machine. External integrations are optional.

## Getting started: what to expect

The first time you open FinTrack you give yourself a name and then **bring in some data** — import a CSV export, connect a data source, or load the bundled demo dataset to explore. That first import is what brings the rest of the app to life; nothing else needs to be set up first.

Two things drive everything else: **reports** (mostly the dashboard) and **searching** your transaction history. Accounts, owners, categories, tags, and rules all exist to make those two better, and you can adopt each one when it earns a place in your reports:

- **Categories** group transactions for reporting — start from a common starter set or build your own.

- **Tags** are cross-cutting labels (e.g. *Essential Expenses*, *Kids*) that span accounts, owners, and categories, on income and expenses alike.

- **Rules** apply categories and tags to new transactions automatically as they arrive — you approve them before they take effect, and they are easy to change later.

The same overview is available any time inside the app under **Help → How FinTrack works**.

## Who is this for?

FinTrack is a good fit for people who:

- want to import and organize financial data quickly

- are migrating from another tool or starting fresh

- prefer tools that don’t require constant manual upkeep

- want control over their data without sacrificing usability

- track personal or household finances in one place

It may not be ideal for:

- fully managed cloud services

- mobile-first apps with zero setup

## Philosophy

FinTrack is built on a few core principles:

- Financial tools should reduce effort, not create it

- Categorization should improve over time, not repeat work

- Data should remain under user control

- Interfaces should support natural workflows

- Users should be able to act directly where their data lives

- Changes should be reversible and rarely destructive

- Overlapping data should be safe to import — duplicates are detected, not feared

## Features

FinTrack focuses on making common tasks easy and reducing the effort required to maintain accurate data over time.

### Core capabilities

- **Import your data:** load transaction exports from any bank (CSV) or connect accounts via Plaid (optional)

- **Categorize transactions:** assign categories and organize data across accounts and owners

- **Define rules:** automatically apply categories to recurring transactions

- **Track and analyze:** view spending by category, compare periods, and drill into details

### Workflow and experience

- **Work directly with your data:** categorize, edit, and review transactions in place

- **Low-friction rule creation:** define rules as you go, without switching contexts

- **Review what matters:** quickly spot uncategorized or unusual transactions and adjust as needed

### Supporting features

- **Multi-owner support:** track personal and shared finances across multiple people

- **Account management:** create, rename, and manage manual or connected accounts

- **Duplicate detection:** safely re-import overlapping data without duplication

- **Rule suggestions:** create rules from manual categorization when useful

- **Dashboards and detail panels:** explore trends with drill-down views and inline editing

- **Tasks:** surface items that need attention, such as uncategorized transactions

- **Backup and restore:** export data with optional encryption for secure storage

- **Flexible access modes:** run locally or configure access for shared environments

## Tech stack

| **Layer** | **Technology** |
| :-: | :-: |
| Backend | Python 3.12 / FastAPI / SQLite |
| Frontend | React 18 / Vite / Recharts |
| Bank data | Plaid API (optional) |

## Platform support

FinTrack is intended to run on:

- **Windows**

- **Linux**

- **macOS**

- **Raspberry Pi** (Raspberry Pi OS / other ARM Linux distributions)

Most of the application is cross-platform. Where setup commands differ by  
platform, those differences are called out below.

Notes:

- The backend and frontend both run natively on Windows, Linux, and macOS.

- Raspberry Pi is supported as a Linux target; performance depends on the Pi model,  
storage speed, and whether it is run directly or through Docker.

- Plaid sync scripts in `scripts/` are currently shell-first (`.sh`), so scheduled  
sync examples are Linux/macOS/Raspberry Pi oriented unless adapted for  
Windows Task Scheduler or run inside a Linux environment.

## Installation

### Requirements

- Python 3.12+ — including the `venv` module. On Debian/Ubuntu/Mint install it with `sudo apt install python3-venv` (it also provides `ensurepip`, which the backend virtual environment needs).

- Node.js 20+ (with npm) — for the frontend.

- A Plaid account (optional, required only for automatic bank sync)

### Quick start

```bash
git clone https://github.com/your-username/fintrack.git
cd fintrack
```

Then launch the backend and frontend together with the script for your platform:

- **Windows** (Command Prompt or double-click): `scripts\start_fintrack.bat`
- **Windows PowerShell**: `powershell -ExecutionPolicy Bypass -File .\scripts\start_fintrack.ps1`
- **macOS / Linux / Raspberry Pi**: `bash ./scripts/start_fintrack.sh`

The helper scripts:

- create `.env` from `.env_example` if needed

- generate secure first-run values for `SESSION_SECRET`, `APP_MASTER_KEY`, and `SESSION_COOKIE_NAME`

- create the backend virtual environment if needed (and rebuild it automatically if it is incomplete)

- install backend and frontend dependencies

- open separate backend and frontend windows

After startup, review `.env` as needed to customize ports, Plaid settings, logging, or other advanced options.

## Testing

FinTrack currently has a small set of test paths that are useful for catching regressions:

- **Backend duplicate-detection tests:** fixture-driven import tests live in `backend/tests/test_import_duplicate_detection.py` with anonymized CSV fixtures under `backend/tests/fixtures/import_duplicates/`
- **Backend suspect-duplicate detection tests:** unit-style coverage of the soft-match flow (cross-account import-time flagging, payee normalization, per-pair-distinct filter via `account_pair_distinct`, broad-Keep cascade, keep/reject resolution with the `dedupe_resolved_by` provenance marker, promote-on-merge with same-batch transitivity clear, auto-restore-on-detach for auto_merge rows, user-Reject preservation across detach, conservation invariants for credit-card-reissue and N-way-merge scenarios) in `backend/tests/test_suspect_duplicates.py`
- **Backend dedupe rule evaluator tests:** isolated tests for the per-row `evaluate_duplicate` rule chain in `backend/tests/test_evaluate_duplicate.py` — drives each rule with a programmatic `DedupeContext` so individual rule preconditions and verdict shapes can be pinned without standing up a full import
- **Backend trash filter tests:** confirm trashed transactions disappear from `list_transactions`, `monthly_trend`, and `spending_by_group`, and that `/transactions/trash` reveals them, in `backend/tests/test_transaction_trash_filter.py`
- **Frontend UI regression checks:** Playwright tests live in `frontend/tests/ui/` and cover a small set of import/export behaviors and smoke checks

### Running the backend tests

A helper script under `scripts/` wraps `python -m unittest` using the backend venv, so the same command works whether you've installed the backend deps system-wide or only inside `backend/venv/`. Tests use isolated SQLite files in `tempfile.TemporaryDirectory()`s — they do not touch the live `fintrack-data.db`, so they're safe to run with the backend still up.

```bash
scripts/run_tests.sh                                              # everything
scripts/run_tests.sh backend.tests.test_suspect_duplicates        # one module
scripts/run_tests.sh backend.tests.test_evaluate_duplicate.EvaluateDuplicateRuleTests.test_exact_hash_same_account_dominates_other_rules
scripts/run_tests.sh -v                                           # verbose listing
```

The script requires `backend/venv/` to exist — `scripts/start_backend.sh` creates the venv on its first run and installs `backend/requirements.txt`. If a new dependency lands, re-run `start_backend.sh` once to refresh the venv before running tests again.

The fixture-driven import tests run real CSV imports through the backend import logic and compare the resulting duplicate reasons and final imported ledger against expected snapshots under `backend/tests/fixtures/import_duplicates/`.

### Frontend Playwright checks

```bash
cd frontend
npm run ui:test
```

These UI tests are intentionally small and are mainly meant to catch regressions in shared behavior on important screens rather than provide exhaustive browser coverage.

## Contributing

FinTrack is an early-stage project and evolving quickly. Feedback, bug reports, and contributions are welcome.

To contribute:

- open an issue to discuss ideas or bugs

- submit a pull request for improvements

- share usage patterns and feedback

## Documentation

FinTrack is built around a small set of coordinated systems. The following documents describe how those systems are structured and how they work together:

- **Architecture:** `docs/architecture.md` — application structure, data flow, and major subsystems

- **Data model:** `docs/data-model.md` — core entities, relationships, and invariants

- **UI patterns:** `docs/ui-patterns.md` — interaction patterns and shared UI behavior

These documents are intended for development and deeper understanding of how FinTrack works internally.

For implementation details, see inline comments in the codebase, which document system behavior and invariants at the module level.

## License

This project is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later).

See the [LICENSE](https://chatgpt.com/c/LICENSE) file for full details.
