# FinTrack

A self-hosted personal finance tracker. Connect bank accounts via Plaid or import
CSV exports from your bank. Categorize transactions, track spending by category
and owner, and view month-over-month trends - all running locally with your data
never leaving your machine.

## Features

- **Plaid integration** - connect checking, savings, and credit card accounts for automatic transaction sync
- **CSV import** - import transaction exports from any bank with header detection, reusable mappings, remembered recent settings, account creation during import, and post-import category mapping from CSV category text
- **Multi-owner support** - assign accounts and category groups to owners (e.g. Alice, Bob, Shared) for household budgeting
- **Optional auth** - run in simple local mode or enable session-based login with 2FA for shared or multi-user setups
- **Auto-categorization rules** - keyword rules automatically assign categories to incoming transactions, with optional amount range, owner, and account conditions. Rules are evaluated most-specific first so precise overrides always win without manual priority tuning
- **Rule suggestions** - after manually categorizing a transaction, a non-intrusive prompt offers to create a rule for that payee
- **Dashboard** - spending by category with drill-down, month-over-month trends, period comparison, and optional owner split view
- **Detail panels** - payee, category, and account history panels with monthly charts, inline editing, lazy-loaded transaction lists, and draggable remembered placement
- **Tasks** - action items surface automatically (unowned accounts, uncategorized transactions) with direct links to resolve them
- **Duplicate detection** - imports deduplicate by content hash so overlapping CSV exports are safe to re-import
- **Backup & restore** - zipped backups from the Import / Export page, with optional RSA public-key encryption for cloud storage and matching private-key restore support

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12 / FastAPI / SQLite |
| Frontend | React 18 / Vite / Recharts |
| Bank data | Plaid API (optional) |

---

## Platform support

FinTrack is intended to run on:

- **Windows**
- **Linux**
- **macOS**
- **Raspberry Pi** (Raspberry Pi OS / other ARM Linux distributions)

Most of the app is cross-platform. Where setup commands differ by platform,
those differences are called out below.

Notes:

- The backend and frontend both run natively on Windows, Linux, and macOS.
- Raspberry Pi is supported as a Linux target; performance depends on the Pi model,
  storage speed, and whether you run it directly or through Docker.
- Plaid sync scripts in `scripts/` are currently shell-first (`.sh`), so scheduled
  sync examples are Linux/macOS/Raspberry Pi oriented unless you adapt them for
  Windows Task Scheduler or run them inside a Linux environment.

---

## Installation

### Requirements

- Python 3.12+
- Node.js 20+
- A Plaid account (free at [dashboard.plaid.com](https://dashboard.plaid.com)) - optional, only needed for live bank sync

### Quick start

Use this path for the shortest local startup flow:

```bash
git clone https://github.com/jeff162/fintrack.git
cd fintrack
```

```bash
# Windows Command Prompt or double-click
.\scripts\start_fintrack.bat

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\scripts\start_fintrack.ps1

# macOS / Linux / Raspberry Pi
bash ./scripts/start_fintrack.sh
```

The helper scripts:

- create `.env` from `.env_example` if needed
- generate secure first-run values for `SESSION_SECRET`, `APP_MASTER_KEY`, and `SESSION_COOKIE_NAME`
- create the backend virtual environment if needed
- install backend and frontend dependencies
- open separate backend and frontend windows

After startup, review `.env` as needed to customize ports, Plaid settings,
logging, or other advanced options.

### Manual setup

Use this path to review or edit configuration before first launch.

#### 1. Clone the repo and create `.env`

```bash
git clone https://github.com/jeff162/fintrack.git
cd fintrack
```

Copy the example environment file:

```bash
# macOS / Linux / Raspberry Pi
cp .env_example .env

# Windows PowerShell
Copy-Item .env_example .env
```

If FinTrack is started manually with an incomplete `.env`, a configuration screen
is loaded on the first connection to generate the missing settings and indicate
when a backend restart is needed.

Review these `.env` settings first:

- Set `SESSION_SECRET` to a long random string
- Strongly consider setting `APP_MASTER_KEY` before linking any bank accounts

Optional:

- Add Plaid credentials only for live bank sync
- Leave the advanced settings at the bottom of `.env` unchanged unless needed

#### 2. Start the backend

Helper script:

```bash
# Windows Command Prompt
.\scripts\start_backend.bat

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\scripts\start_backend.ps1

# macOS / Linux / Raspberry Pi
bash ./scripts/start_backend.sh
```

These helper scripts:

- create `.env` from `.env_example` if needed
- generate secure first-run values for `SESSION_SECRET`, `APP_MASTER_KEY`, and `SESSION_COOKIE_NAME` if needed
- create the backend virtual environment if needed
- install backend dependencies
- start uvicorn on the configured `BACKEND_PORT`

Manual steps:

```bash
cd backend

# Create a virtual environment
# Windows: use the Python version pinned in backend/.python-version
py -3.12 -m venv venv

# macOS / Linux / Raspberry Pi
python -m venv venv
```

Activate it:

```bash
# Windows
venv\Scripts\activate

# macOS / Linux / Raspberry Pi
source venv/bin/activate
```

Install dependencies and start the API:

```bash
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000  # or your BACKEND_PORT value
```

Default API address: `http://localhost:8000`
If `BACKEND_PORT` is set in `.env`, use that same value in the `uvicorn ... --port ...` command.
Interactive API docs: `http://localhost:<chosen-port>/docs`

Windows note:

- `.python-version` is used by `pyenv`; Windows does not read it automatically for
  `python -m venv`. Use `py -3.12 -m venv venv`, where `3.12` matches
  `backend/.python-version`.
- If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
  once, then reopen the shell.

#### 3. Start the frontend

In a separate terminal:

```bash
# Windows Command Prompt
.\scripts\start_frontend.bat

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\scripts\start_frontend.ps1

# macOS / Linux / Raspberry Pi
bash ./scripts/start_frontend.sh
```

These helper scripts:

- create `.env` from `.env_example` if needed
- install frontend dependencies
- start the Vite dev server

Manual steps:

```bash
cd frontend
npm install
npm run dev
```

Default frontend address: `http://localhost:5173`

### Launcher notes

The full launcher opens separate backend and frontend terminals:

```bash
# Windows Command Prompt or double-click
.\scripts\start_fintrack.bat

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\scripts\start_fintrack.ps1

# macOS / Linux / Raspberry Pi
bash ./scripts/start_fintrack.sh
```

Log files are off by default. Set `FINTRACK_USE_LOG_FILES=true` in `.env` to
write fresh launcher logs to `scripts/backend.log` and `scripts/frontend.log`
on each run.
If first-run dependency installation is slow, increase `FINTRACK_BACKEND_READY_TIMEOUT`
in `.env` so the launcher waits longer before opening the frontend.
On Windows, the frontend window usually ends up on top.

### Advanced: running two separate local copies

If you want two independent FinTrack directory trees running at once for testing,
use the advanced settings near the bottom of `.env` and give each checkout its
own ports and session cookie.

In the common case, you only need to change the primary port settings:

- `BACKEND_PORT`
- `FRONTEND_PORT`
- `FRONTEND_DOCKER_PORT` if you use Docker

FinTrack derives the usual proxy and CORS values from those automatically unless
you explicitly override them.

Example:

- Checkout A: `FRONTEND_PORT=5173`, `BACKEND_PORT=8000`, `FRONTEND_DOCKER_PORT=3000`, `SESSION_COOKIE_NAME=fintrack_a_session`
- Checkout B: `FRONTEND_PORT=5174`, `BACKEND_PORT=8001`, `FRONTEND_DOCKER_PORT=3001`, `SESSION_COOKIE_NAME=fintrack_b_session`

For Docker, also set a unique `FRONTEND_DOCKER_PORT` per checkout.

### Advanced: editing environment settings in the app

After startup, FinTrack can edit a small set of `.env` settings from the
Settings page:

- Plaid credentials and environment
- launcher log file toggle

Security-sensitive bootstrap values such as `SESSION_SECRET` and `APP_MASTER_KEY`
stay outside the normal settings flow. If you change environment-backed settings
in the app, restart the backend to apply them.

Node note:

- `npm` works the same on Windows, Linux, macOS, and Raspberry Pi.
- On Raspberry Pi, install a current Node.js build for ARM and expect `npm install`
  to be slower than on a desktop machine.

---

## Getting started

### Option A: CSV import (no Plaid needed)

1. Download a transaction CSV from your bank's website
2. Go to **Import / Export** in the app
3. Upload the file - column mapping is auto-detected where possible
4. Map the Date, Amount, and Description columns to your file's headers
5. Assign each account in the file to a FinTrack account, or create new ones during import
6. If the CSV includes categories, review the post-import category mapping step to match or create categories
7. Click **Import**
8. Save an import profile so the mapping is remembered next time

Import notes:

- FinTrack can detect headers that start after line 1 and show the raw file so you can verify what was skipped
- If a file appears to contain footer text or non-transaction data at the end, the raw file tail is shown for review
- Recent import settings are remembered even when you do not save a formal profile
- Imported category mappings can be saved into a profile, or reused from the most recent similar import

### Option B: Plaid bank sync

1. In `.env`, set `PLAID_ENV=sandbox` for testing with fake accounts,
   or `development` to connect real ones
2. Go to **Accounts** and click **Connect a bank**
3. Complete the Plaid Link flow
4. Click **Sync now**, or set up a scheduled nightly sync:

```bash
# Linux / macOS / Raspberry Pi
chmod +x scripts/sync.sh
crontab -e
# Add: 0 3 * * * /path/to/fintrack/scripts/sync.sh >> /var/log/fintrack-sync.log 2>&1
```

On Windows, use **Task Scheduler** instead of `cron`, or run the sync from WSL/Docker.

### Setting up categories

Go to **Categories** to create groups (e.g. Housing, Food, Transport) and leaf
categories within them (e.g. Rent, Groceries, Gas). A default set is created on
first run - edit or delete them to match your own spending.

Once categories exist, go to **Rules** to create keyword rules that auto-assign
categories to transactions.

### Creating categorization rules

Rules match transactions by merchant name keyword (case-insensitive substring).
Each rule can optionally restrict by amount range, owner, or account. Rules are
evaluated most-specific first - longer keywords beat shorter ones, more conditions
beat fewer - so you never need to set a manual priority.

Example rules:
- `whole foods` -> Groceries
- `amazon` + amount >= $100 -> Shopping  *(beats the generic amazon rule)*
- `starbucks` + owner = Alice -> Coffee & Drinks (Alice)

### Using detail panels

From transaction lists and dashboard drill-downs, the "open detail" controls open focused
detail panels for payees, categories, and accounts. These panels are designed for
investigation without losing your place in the main UI:

- Monthly charts support click-through into a selected month
- Transaction lists load incrementally for large months instead of pulling the
  full history at once
- Editable fields can be changed directly in the panel
- The panel stays open until explicitly closed
- If you drag a panel, FinTrack remembers its last floating position and reopens
  it near the same bottom-left anchor next time

### Multi-owner setup

If you track finances for multiple people:

1. Go to **Settings -> Owners** and create owners (e.g. Alice, Bob, Shared)
2. Assign each account to an owner in Settings
3. Assign spending category groups to owners in Categories
4. On the Dashboard, use **Split by owner** to see spending per person

---

## Project structure

```
fintrack/
|-- backend/
|   |-- main.py                  # FastAPI app, router registration, auth middleware
|   |-- pyproject.toml           # Python packaging metadata and tool config
|   |-- .python-version          # Pins Python version (used by pyenv)
|   |-- runtime_config.py        # First-run config checks and .env helpers
|   |-- db/
|   |   |-- database.py          # SQLite init, schema migrations, seed data
|   |   `-- control_database.py  # Multi-tenant user/session management
|   |-- routers/
|   |   |-- accounts.py          # Account CRUD and owner assignment
|   |   |-- auth.py              # Login, logout, 2FA, bootstrap
|   |   |-- categories.py        # Category and group management
|   |   |-- import_export.py     # CSV import/export, profiles, backup/restore
|   |   |-- owners.py            # Owner CRUD
|   |   |-- plaid.py             # Plaid Link token and token exchange
|   |   |-- rules.py             # Keyword categorization rules
|   |   |-- sync.py              # Transaction sync from Plaid
|   |   |-- tasks.py             # Live action-item computation
|   |   `-- transactions.py      # Transaction list, filters, summary endpoints
|   `-- services/
|       |-- categorizer.py       # Auto-categorization engine
|       |-- crypto_service.py    # Plaid token encryption
|       `-- plaid_service.py     # Plaid API wrapper
|-- frontend/
|   |-- .nvmrc                   # Pins Node.js version (used by nvm)
|   `-- src/
|       |-- App.jsx              # Root component, nav, routes
|       |-- components/          # Shared UI components
|       |   |-- RuntimeConfigScreen.jsx # Fallback repair screen for missing .env secrets
|       |   |-- RuleForm.jsx     # Rule create/edit form (used on Rules page + toast)
|       |   |-- RuleSuggestionToast.jsx  # Post-categorization rule prompt
|       |   |-- TransactionDetail.jsx    # Payee history panel
|       |   |-- TransactionRow.jsx       # Shared transaction cell components
|       |   `-- ui.jsx           # Base UI primitives (Card, Badge, Button, ...)
|       |-- lib/
|       |   |-- api.js           # All API calls to the backend
|       |   |-- FilterContext.jsx # Global filter state (date, accounts, owners...)
|       |   `-- utils.js         # Formatting helpers
|       `-- pages/               # One file per page
|-- scripts/
|   |-- start_backend.bat        # Windows cmd wrapper for backend helper
|   |-- start_backend.ps1        # Windows backend setup/start helper
|   |-- start_backend.sh         # Unix-like backend setup/start helper
|   |-- start_frontend.bat       # Windows cmd wrapper for frontend helper
|   |-- start_frontend.ps1       # Windows frontend setup/start helper
|   |-- start_frontend.sh        # Unix-like frontend setup/start helper
|   |-- start_fintrack.bat       # Windows cmd wrapper for full launcher
|   |-- start_fintrack.ps1       # Windows launcher for backend + frontend
|   |-- start_fintrack.sh        # Unix-like launcher for backend + frontend
|   |-- sync.sh                  # Cron-friendly Plaid sync wrapper
|   `-- seed_rules.py            # Optional: populate default categorization rules
|-- .env_example                 # Environment variable reference
|-- .gitignore
|-- CHANGELOG.md
|-- docker-compose.yml
|-- make_dist.bat               # Windows cmd wrapper for packaging
|-- make_dist.sh                 # Packages source for distribution on Unix-like systems
|-- make_dist.ps1                # Packages source for distribution on Windows PowerShell
`-- LICENSE
```

---

## Database

FinTrack uses SQLite - a single file per user (path set by `DB_PATH` or
`TENANT_DATA_ROOT`). The schema is managed by a versioned migration system in
`database.py` that runs automatically on startup. No manual migration steps are
ever needed; just restart the backend after updating.

The database files contain personal financial data and are excluded from version
control by `.gitignore`. **Back them up regularly** using the built-in backup and
restore tools on the Import / Export page, or by copying the `.db` file directly.

Backup notes:

- Data backups are generated as `.zip` files
- Credentials backups are separate from data backups because they contain Plaid access tokens
- If you add RSA public backup recipients in Settings, FinTrack can generate encrypted backups that are suitable for cloud storage
- Restoring an encrypted backup requires the matching RSA private key file

---

## Docker

A `docker-compose.yml` is included for containerized deployment:

```bash
docker-compose up -d
```

The frontend is served on port 3000, the backend API on port 8000.
Financial data is stored in `./data/` on the host (mounted as a volume).

Docker notes:

- Docker is a good option for Linux, macOS, and Windows Desktop setups.
- Raspberry Pi support depends on using ARM-compatible images and having Docker
  available on your Pi.

---

## Contributing

Pull requests are welcome. For larger changes, open an issue first to discuss
what you'd like to change.

Helpful project docs:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/data-model.md](docs/data-model.md)
- [CHANGELOG.md](CHANGELOG.md)

---

## License

[MIT](LICENSE)
