# FinTrack

A self-hosted personal finance tracker. Connect bank accounts via Plaid or import
CSV exports from your bank. Categorize transactions, track spending by category
and owner, and view month-over-month trends — all running locally with your data
never leaving your machine.

## Features

- **Plaid integration** — connect checking, savings, and credit card accounts for automatic transaction sync
- **CSV import** — import transaction exports from any bank; configurable column mapping with saved profiles per institution
- **Multi-owner support** — assign accounts and category groups to owners (e.g. Alice, Bob, Shared) for household budgeting
- **Auto-categorization rules** — keyword rules automatically assign categories to incoming transactions, with optional amount range, owner, and account conditions. Rules are evaluated most-specific first so precise overrides always win without manual priority tuning
- **Rule suggestions** — after manually categorizing a transaction, a non-intrusive prompt offers to create a rule for that payee
- **Dashboard** — spending by category with drill-down, month-over-month trends, period comparison, and optional owner split view
- **Tasks** — action items surface automatically (unowned accounts, uncategorized transactions) with direct links to resolve them
- **Duplicate detection** — imports deduplicate by content hash so overlapping CSV exports are safe to re-import
- **Backup & restore** — full data export and restore as JSON from the Import/Export page

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12 · FastAPI · SQLite |
| Frontend | React 18 · Vite · Recharts |
| Bank data | Plaid API (optional) |

---

## Installation

### Requirements

- Python 3.12+
- Node.js 20+
- A Plaid account (free at [dashboard.plaid.com](https://dashboard.plaid.com)) — optional, only needed for live bank sync

### 1. Clone and configure

```bash
git clone https://github.com/yourusername/fintrack.git
cd fintrack
cp .env.example .env
# Edit .env — at minimum set SESSION_SECRET to a random string.
# Add Plaid credentials if you want bank sync. CSV import works without them.
```

### 2. Start the backend

```bash
cd backend

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate        # macOS / Linux
# venv\Scripts\activate         # Windows

pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be at `http://localhost:8000`.
Interactive API docs at `http://localhost:8000/docs`.

### 3. Start the frontend

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

The app will be at `http://localhost:5173`.

---

## Getting started

### Option A: CSV import (no Plaid needed)

1. Download a transaction CSV from your bank's website
2. Go to **Import / Export** in the app
3. Upload the file — column mapping is auto-detected where possible
4. Map the Date, Amount, and Description columns to your file's headers
5. Assign each account in the file to a FinTrack account (or create new ones)
6. Click **Import**
7. Save an import profile so the mapping is remembered next time

### Option B: Plaid bank sync

1. In `.env`, set `PLAID_ENV=sandbox` for testing with fake accounts,
   or `development` to connect real ones
2. Go to **Accounts** and click **Connect a bank**
3. Complete the Plaid Link flow
4. Click **Sync now**, or set up a nightly cron:

```bash
chmod +x scripts/sync.sh
crontab -e
# Add: 0 3 * * * /path/to/fintrack/scripts/sync.sh >> /var/log/fintrack-sync.log 2>&1
```

### Setting up categories

Go to **Categories** to create groups (e.g. Housing, Food, Transport) and leaf
categories within them (e.g. Rent, Groceries, Gas). A default set is created on
first run — edit or delete them to match your own spending.

Once categories exist, go to **Rules** to create keyword rules that auto-assign
categories to transactions.

### Creating categorization rules

Rules match transactions by merchant name keyword (case-insensitive substring).
Each rule can optionally restrict by amount range, owner, or account. Rules are
evaluated most-specific first — longer keywords beat shorter ones, more conditions
beat fewer — so you never need to set a manual priority.

Example rules:
- `whole foods` → Groceries
- `amazon` + amount >= $100 → Shopping  *(beats the generic amazon rule)*
- `starbucks` + owner = Alice → Coffee & Drinks (Alice)

### Multi-owner setup

If you track finances for multiple people:

1. Go to **Settings → Owners** and create owners (e.g. Alice, Bob, Shared)
2. Assign each account to an owner in Settings
3. Assign spending category groups to owners in Categories
4. On the Dashboard, use **Split by owner** to see spending per person

---

## Project structure

```
fintrack/
├── backend/
│   ├── main.py                  # FastAPI app, router registration, auth middleware
│   ├── pyproject.toml           # Python packaging metadata and tool config
│   ├── .python-version          # Pins Python version (used by pyenv)
│   ├── db/
│   │   ├── database.py          # SQLite init, schema migrations, seed data
│   │   └── control_database.py  # Multi-tenant user/session management
│   ├── routers/
│   │   ├── accounts.py          # Account CRUD and owner assignment
│   │   ├── auth.py              # Login, logout, 2FA, bootstrap
│   │   ├── categories.py        # Category and group management
│   │   ├── import_export.py     # CSV import/export, profiles, backup/restore
│   │   ├── owners.py            # Owner CRUD
│   │   ├── plaid.py             # Plaid Link token and token exchange
│   │   ├── rules.py             # Keyword categorization rules
│   │   ├── sync.py              # Transaction sync from Plaid
│   │   ├── tasks.py             # Live action-item computation
│   │   └── transactions.py      # Transaction list, filters, summary endpoints
│   └── services/
│       ├── categorizer.py       # Auto-categorization engine
│       ├── crypto_service.py    # Plaid token encryption
│       └── plaid_service.py     # Plaid API wrapper
├── frontend/
│   ├── .nvmrc                   # Pins Node.js version (used by nvm)
│   └── src/
│       ├── App.jsx              # Root component, nav, routes
│       ├── components/          # Shared UI components
│       │   ├── RuleForm.jsx     # Rule create/edit form (used on Rules page + toast)
│       │   ├── RuleSuggestionToast.jsx  # Post-categorization rule prompt
│       │   ├── TransactionDetail.jsx    # Payee history panel
│       │   ├── TransactionRow.jsx       # Shared transaction cell components
│       │   └── ui.jsx           # Base UI primitives (Card, Badge, Button, …)
│       ├── lib/
│       │   ├── api.js           # All API calls to the backend
│       │   ├── FilterContext.jsx # Global filter state (date, accounts, owners…)
│       │   └── utils.js         # Formatting helpers
│       └── pages/               # One file per page
├── scripts/
│   ├── sync.sh                  # Cron-friendly Plaid sync wrapper
│   └── seed_rules.py            # Optional: populate default categorization rules
├── .env.example                 # Environment variable reference
├── .gitignore
├── CHANGELOG.md
├── docker-compose.yml
├── make_dist.sh                 # Packages source for distribution (excludes data/secrets)
└── LICENSE
```

---

## Database

FinTrack uses SQLite — a single file per user (path set by `DB_PATH` or
`TENANT_DATA_ROOT`). The schema is managed by a versioned migration system in
`database.py` that runs automatically on startup. No manual migration steps are
ever needed; just restart the backend after updating.

The database files contain personal financial data and are excluded from version
control by `.gitignore`. **Back them up regularly** using the built-in export on
the Import/Export page, or by copying the `.db` file directly.

---

## Docker

A `docker-compose.yml` is included for containerized deployment:

```bash
docker-compose up -d
```

The frontend is served on port 3000, the backend API on port 8000.
Financial data is stored in `./data/` on the host (mounted as a volume).

---

## Contributing

Pull requests are welcome. For larger changes, open an issue first to discuss
what you'd like to change. See [CHANGELOG.md](CHANGELOG.md) for a summary of
recent changes.

---

## License

[MIT](LICENSE)
