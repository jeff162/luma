# Luma

> Your financial data, without the friction.

Luma is a personal finance tool that helps you collect your financial transaction data, categorize it, and keep it organized with minimal friction.

Start with a CSV export or connect an account, clean up the categories, define rules for common transactions, and review new transactions to verify they got categorized correctly.

You stay in control — Luma makes it easy to review what changed, spot anything that looks off, and adjust when needed.

Less repetition. Fewer manual fixes. Clear, usable financial data.

## Why Luma?

Many personal finance tools follow the same basic model: import data, categorize transactions, define rules, and review the results.

The difference is how much friction they introduces.

Luma is designed to reduce that friction:

- Getting data in is quick and flexible (CSV or connected accounts)

- Categorizing and curating transactions happens directly where the data is

- Rules are easy to create and adjust on the fly

- Reviewing the data is straightforward — no digging through menus or workflows

The core tasks are the same -- Luma just makes them easier to do and easier to keep the data clean over time.

## What does Luma do?

Luma help turn raw financial data into something organized and usable.

The application can:

- import transactions from CSV or connected accounts

- categorize and organize data across accounts and owners

- spot recurring charges — subscriptions, bills, taxes — automatically

- review and maintain transaction data as new transaction data is added

- analyze spending with dashboards and drill-down views

All core functionality runs locally. External integrations are optional, Luma never makes an outgoing request unless explicitly requested (eg. fetch new data, save a backup).

## Getting started: what to expect

The first time Luma opens a local user needs to be created and the welcome menu offers several options to get started. Either load the demo data to explore the application or load your own data either from a csv or connect a data source. The first import is what brings the rest of the app to life; other than the user name, nothing needs to be configured before loading transaction data.

Two things drive everything else: **reports** (mostly the dashboard) and **searching** the transaction history. Accounts, owners, categories, tags, and rules all exist to make those two better, and they can be used or not depending on whether they are helpful:

- **Categories** group transactions for reporting — start from a common starter set or build your own.

- **Tags** are cross-cutting labels (e.g. *Essential Expenses*, *Kids*, *Personal Spending*) that span accounts, owners, and categories, for generating custom reports.

- **Rules** have a set of matching criteria to select the set of transactions they apply to and a set of actions they take when they apply. The actions include setting the merchant name, assigning a category or a tag and indicating whether the transaction is part of a recurring series.

- **Recurring** tries to detect transactions that repeat on a schedule — subscriptions, bills, taxes, paycheck. Rules can also indicate something is a recurring series if for some reason it was not detected automatically.

The same overview is available any time inside the app under **Help → How Luma works**.

## Who is this for?

Luma is a good fit for people who:

- want to import and organize financial data quickly

- are migrating from another tool or starting fresh

- want control over their data without sacrificing usability

- track personal or household finances in one place

Luma does not:

- have any kind of support for budgeting

- Interact with investment accounts other than to fetch money movement transactions.

## Philosophy

Luma is built on a few core principles:

- Financial tools should reduce effort, not create it

- The curation process should improve over time,

- Data must remain under user control

- Interfaces should support natural workflows

- Users should be able to correct data wherever they can see it

- Changes should be reversible. They are only rarely destructive.

- Strong Duplicate detection across imports so adding data is not something to be feared and doesn't require any pre-planning.

## Privacy

Luma is local-first by design, a the data stays locally:

- **The data lives on your machine** — everything is kept in a local SQLite database.

- **No tracking** — Luma has no analytics, telemetry, or "phone home," and doesn't report on how it is used.

- **Connections happen only when the user asks** — the app reaches the network only for user driven actions, such as syncing transactions from a connected data source. The only other type of network connection Luma might make is to access a network drive to load a CSV file or write a backup, assuming that is what the user specified.

- **Backups stay local** — exports are saved wherever the user wishes and can be encrypted if desired with a user supplied key.

You decide what comes in, what stays, and what leaves. Luma is built to organize your financial data, not to collect it.

## Security

Local-first also means the security model is easy to reason about — but it's worth being clear about what protects what, and what a compromise would actually mean.

- **Transaction data is stored unencrypted on disk.** The ledger lives in a local SQLite database in plain form, so the database files — and any **unencrypted** backup — are the sensitive artifacts to protect. They should be kept off shared or cloud-synced locations; anything that leaves the machine should use the **encrypted backup** (protected with a user-supplied key).

- **The optional sign-in password is network-access control, not disk encryption.** It governs who on the local network can reach a running instance. It does not encrypt the database and does not protect the files if someone copies them off the disk.

- **Data-source tokens are the one secret Luma encrypts at rest.** A connected provider (such as Plaid) issues a token that grants **ongoing, read-only** access to an account's transactions and balances — it cannot move money. Because that access is live until revoked, the token is kept in a passphrase-protected vault rather than in plain text. The vault passphrase is separate from the sign-in password and is never stored; losing every way into the vault means re-linking the data sources, and nothing else — the ledger itself is untouched by it.

- **A household shares one vault, and each person opens it their own way.** Setting a vault passphrase on an install that already has a vault requests access; someone who can already open it approves the request. No passphrase is ever revealed to anyone else, in either direction. **Vault settings** lists everyone who can open the vault, and access can be removed there — followed by **Replace vault key** when the concern is that a key was exposed, since removing access alone does not change the key someone could already read. A **passkey** can be added as a second way in, so a fingerprint or face check replaces retyping a long passphrase — and having two ways in is also the practical safeguard against losing access entirely. (Passkeys need an HTTPS connection to a named host; a passphrase works everywhere.)

- **If a database or backup is lost or copied by someone else:** the historical transactions it holds should be treated as exposed, since they were never encrypted. Any connected data source should be **revoked**, so a stolen copy can no longer pull new data, and — for a deliberate compromise — the vault key replaced from Vault settings, which re-encrypts every stored credential so an older copy of the key opens nothing. Cancelling a credential limits the damage to what was already in the copied files.

- **Revoking works differently per provider, and the app says which applies.** Where a provider supports it (Plaid), **Disconnect** revokes the credential at the provider and the access genuinely ends. Some providers publish no way for another app to revoke a credential (SimpleFIN); there, Disconnect removes only Luma's copy, and revoking means signing in to the provider and doing it there. The disconnect confirmation states which of the two is about to happen, so a connection is never left live while appearing closed.

## Features

Luma focuses on making common tasks easy and reducing the effort required to maintain accurate data over time.

### Core capabilities

- **Import your data:** load transaction exports from any bank (CSV) or connect accounts via Plaid (optional)

- **Categorize transactions:** assign categories and organize data across accounts and owners

- **Define rules:** automatically apply categories, renames, and tags to matching transactions as they arrive

- **Track recurring charges:** find subscriptions, bills, and taxes that repeat on a schedule, and declare one the detector misses with a rule

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

Luma is intended to run on:

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
git clone https://github.com/jeff162/luma.git
cd luma
```

Then launch the backend and frontend together with the script for your platform:

- **Windows** (Command Prompt or double-click): `scripts\start_luma.bat`
- **Windows PowerShell**: `powershell -ExecutionPolicy Bypass -File .\scripts\start_luma.ps1`
- **macOS / Linux / Raspberry Pi**: `bash ./scripts/start_luma.sh`

The helper scripts:

- create the backend virtual environment if needed (and rebuild it automatically if it is incomplete)

- install backend and frontend dependencies

- open separate backend and frontend windows

No configuration file is needed to start. Every setting has a working default, and the values that must
persist — the session signing secret and the session cookie name — are generated on first run and kept
in the control database. Everything relevant to everyday use is configured in the app under **Settings**,
including data-source credentials, which are stored in the encrypted vault.

An optional `.env` file overrides the handful of values that are resolved before the app is running:
the ports, the data directory (`DATA_DIR`, holding both databases), and the developer-options gate. Copy `.env_example` to `.env` to use it, and
see **Settings → Configuration** for the effective value of every setting and which layer supplied it.

## Testing

Luma currently has a small set of test paths that are useful for catching regressions:

- **Backend duplicate-detection tests:** fixture-driven import tests live in `backend/tests/test_import_duplicate_detection.py` with anonymized CSV fixtures under `backend/tests/fixtures/import_duplicates/`
- **Backend suspect-duplicate detection tests:** unit-style coverage of the soft-match flow (cross-account import-time flagging, payee normalization, per-pair-distinct filter via `account_pair_distinct`, broad-Keep cascade, keep/reject resolution with the `dedupe_resolved_by` provenance marker, promote-on-merge with same-batch transitivity clear, auto-restore-on-detach for auto_merge rows, user-Reject preservation across detach, conservation invariants for credit-card-reissue and N-way-merge scenarios) in `backend/tests/test_suspect_duplicates.py`
- **Backend dedupe rule evaluator tests:** isolated tests for the per-row `evaluate_duplicate` rule chain in `backend/tests/test_evaluate_duplicate.py` — drives each rule with a programmatic `DedupeContext` so individual rule preconditions and verdict shapes can be pinned without standing up a full import
- **Backend trash filter tests:** confirm trashed transactions disappear from `list_transactions`, `monthly_trend`, and `spending_by_group`, and that `/transactions/trash` reveals them, in `backend/tests/test_transaction_trash_filter.py`
- **Frontend UI regression checks:** Playwright tests live in `frontend/tests/ui/` and cover a small set of import/export behaviors and smoke checks

### Running the backend tests

A helper script under `scripts/` wraps `python -m unittest` using the backend venv, so the same command works whether you've installed the backend deps system-wide or only inside `backend/venv/`. Tests use isolated SQLite files in `tempfile.TemporaryDirectory()`s — they do not touch the live `luma-data.db`, so they're safe to run with the backend still up.

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

Luma is an early-stage project and evolving quickly. Feedback, bug reports, and contributions are welcome.

To contribute:

- open an issue to discuss ideas or bugs

- submit a pull request for improvements

- share usage patterns and feedback

## Documentation

Luma is built around a small set of coordinated systems. The following documents describe how those systems are structured and how they work together:

- **Architecture:** `docs/architecture.md` — application structure, data flow, and major subsystems

- **Data model:** `docs/data-model.md` — core entities, relationships, and invariants

- **UI patterns:** `docs/ui-patterns.md` — interaction patterns and shared UI behavior

These documents are intended for development and deeper understanding of how Luma works internally.

For implementation details, see inline comments in the codebase, which document system behavior and invariants at the module level.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

See the [LICENSE](https://chatgpt.com/c/LICENSE) file for full details.
