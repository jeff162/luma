# FinTrack

> A self-hosted personal finance tracker with full control over your data.
> No cloud lock-in. No subscriptions. Your data stays on your machine.

---

## Why FinTrack?

FinTrack is designed for people who want complete ownership of their financial data without relying on third-party services.

* 💻 **Runs locally** – your data never leaves your machine
* 🔒 **Privacy-first** – no external analytics or tracking
* 🧠 **Smart categorization** – automatic rules with flexible overrides
* 👥 **Multi-user aware** – built for shared household finances
* 📊 **Insightful dashboards** – track trends and spending over time

---

## Who is this for?

FinTrack is a good fit if you:

* Prefer **self-hosted tools** over SaaS
* Want **full control of your financial data**
* Track spending for **yourself or a household**
* Like tools that are **customizable and extensible**

It may not be ideal if you:

* Want a fully managed cloud solution
* Prefer mobile-first apps with zero setup

---

## Philosophy

FinTrack is built on a few core principles:

* Your financial data should belong to you
* Local-first software should be a first-class option
* Personal finance tools should be transparent and customizable
* Open source enables trust and long-term sustainability

---

A self-hosted personal finance tracker. Connect bank accounts via Plaid or import
CSV exports from your bank. Categorize transactions, track spending by category
and owner, and view month-over-month trends - all running locally with your data
never leaving your machine.

## Features

* **Plaid integration** - connect checking, savings, and credit card accounts for automatic transaction sync
* **CSV import** - import transaction exports from any bank with header detection, reusable mappings, remembered recent settings, account creation during import, and post-import category mapping from CSV category text
* **Account management** - add manual accounts, rename them inline, change account type, assign owners, and connect or sync provider-linked accounts from the Accounts page
* **Multi-owner support** - assign accounts and category groups to owners (e.g. Alice, Bob, Shared) for household budgeting
* **Flexible security modes** - choose between localhost-only use, private network/remote access, shared household access, or a work-in-progress multi-tenant posture, with optional session-based login, password policy controls, and 2FA
* **Auto-categorization rules** - keyword rules automatically assign categories to incoming transactions, with optional amount range, owner, and account conditions. Rules are evaluated most-specific first so precise overrides always win without manual priority tuning
* **Rule suggestions** - after manually categorizing a transaction, a non-intrusive prompt offers to create a rule for that payee
* **Dashboard** - spending by category with drill-down, month-over-month trends, period comparison, and optional owner split view
* **Detail panels** - payee, category, and account history panels with monthly charts, inline editing, lazy-loaded transaction lists, and draggable remembered placement
* **Tasks** - action items surface automatically (unowned accounts, uncategorized transactions) with direct links to resolve them
* **Duplicate detection** - imports deduplicate by content hash so overlapping CSV exports are safe to re-import
* **Backup & restore** - zipped backups from the Import / Export page, with optional RSA public-key encryption for cloud storage and matching private-key restore support

## Tech stack

| Layer     | Technology                     |
| --------- | ------------------------------ |
| Backend   | Python 3.12 / FastAPI / SQLite |
| Frontend  | React 18 / Vite / Recharts     |
| Bank data | Plaid API (optional)           |

---

## Platform support

FinTrack is intended to run on:

* **Windows**
* **Linux**
* **macOS**
* **Raspberry Pi** (Raspberry Pi OS / other ARM Linux distributions)

Most of the app is cross-platform. Where setup commands differ by platform,
those differences are called out below.

Notes:

* The backend and frontend both run natively on Windows, Linux, and macOS.
* Raspberry Pi is supported as a Linux target; performance depends on the Pi model,
  storage speed, and whether you run it directly or through Docker.
* Plaid sync scripts in `scripts/` are currently shell-first (`.sh`), so scheduled
  sync examples are Linux/macOS/Raspberry Pi oriented unless you adapt them for
  Windows Task Scheduler or run them inside a Linux environment.

---

## Installation

### Requirements

* Python 3.12+
* Node.js 20+
* A Plaid account (free at https://dashboard.plaid.com) - optional, only needed for live bank sync

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

* create `.env` from `.env_example` if needed
* generate secure first-run values for `SESSION_SECRET`, `APP_MASTER_KEY`, and `SESSION_COOKIE_NAME`
* create the backend virtual environment if needed
* install backend and frontend dependencies
* open separate backend and frontend windows

After startup, review `.env` as needed to customize ports, Plaid settings,
logging, or other advanced options.

### Manual setup

*(rest of your original README continues unchanged…)*

---

## Contributing

FinTrack is an early-stage project and evolving quickly. Feedback, bug reports, and contributions are welcome.

If you're interested in contributing:

* Open an issue to discuss ideas or bugs
* Submit a pull request for improvements
* Share how you're using FinTrack

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## License

This project is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later).

This means that if you distribute modified versions of FinTrack, you must also make the source code available under the same license.

See the [LICENSE](LICENSE) file for full details.
