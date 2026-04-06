<!-- SPDX-FileCopyrightText: 2026 Jeffrey Orlin -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# FinTrack

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)

> A self-hosted personal finance tracker with full control over financial data.
> No cloud lock-in. No subscriptions. Data stays on the local machine.

## Contents

- [Why FinTrack?](#why-fintrack)
- [Who is this for?](#who-is-this-for)
- [Philosophy](#philosophy)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Platform support](#platform-support)
- [Installation](#installation)
- [Contributing](#contributing)
- [License](#license)

---

## Why FinTrack?

FinTrack is designed for people who want direct control over their financial
data without relying on a hosted personal-finance service.

- 💻 **Runs locally** – data never leaves the local machine
- 🔒 **Privacy-first** – no external analytics or tracking
- ✨ **Natural interaction** – if an action looks possible, it probably is
- 🧠 **Smart categorization** – automatic rules with flexible overrides
- 👥 **Multi-user aware** – built for shared household finances
- 📊 **Insightful dashboards** – track trends and spending over time

---

A self-hosted personal finance tracker for local-first financial management.
Connect bank accounts via Plaid or import CSV exports from a bank. Categorize
transactions, track spending by category and owner, and view month-over-month
trends, all running locally with data remaining on the local machine except for
optional external integrations such as Plaid.

## Who is this for?

FinTrack is a good fit for:

- self-hosted tools instead of SaaS
- direct control of financial data
- personal or household spending tracked in one place
- customizable and extensible tooling

It may not be ideal for:

- fully managed cloud services
- mobile-first apps with zero setup

---

## Philosophy

FinTrack is built on a few core principles:

- Financial data should remain under direct control
- Local-first software should be a first-class option
- Personal finance tools should be transparent and customizable
- In-place control should let users act where the data already is
- Workflow-first design should anticipate what users are likely to try so it works when they do
- Open source enables trust and long-term sustainability

---

## Features

- **Plaid integration:** connect checking, savings, and credit card accounts for automatic transaction sync
- **CSV import:** import transaction exports from any bank with header detection, reusable mappings, remembered recent settings, account creation during import, and post-import category mapping from CSV category text
- **Account management:** add manual accounts, rename them inline, change account type, assign owners, and connect or sync provider-linked accounts from the Accounts page
- **Multi-owner support:** assign accounts and category groups to owners such as Alice, Bob, and Shared for household budgeting
- **Flexible security modes:** choose between localhost-only use, private network or remote access, shared household access, or a work-in-progress multi-tenant posture, with optional session-based login, password policy controls, and 2FA
- **Auto-categorization rules:** keyword rules automatically assign categories to incoming transactions, with optional amount range, owner, and account conditions; more-specific rules win without manual priority tuning
- **Rule suggestions:** after manual categorization, a non-intrusive prompt can create a rule for that payee
- **Dashboard:** view spending by category with drill-down, month-over-month trends, period comparison, and optional owner split view
- **Detail panels:** inspect payee, category, and account history with monthly charts, inline editing, lazy-loaded transaction lists, and remembered draggable placement
- **Tasks:** surface action items such as unowned accounts and uncategorized transactions with direct links to resolution
- **Duplicate detection:** deduplicate imports by content hash so overlapping CSV exports can be re-imported safely
- **Backup and restore:** create zipped backups from the Import / Export page, with optional RSA public-key encryption for cloud storage and matching private-key restore support

## Tech stack

| Layer     | Technology                     |
| --------- | ------------------------------ |
| Backend   | Python 3.12 / FastAPI / SQLite |
| Frontend  | React 18 / Vite / Recharts     |
| Bank data | Plaid API (optional)           |

---

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

---

## Installation

### Requirements

- Python 3.12+
- Node.js 20+
- A Plaid account (free at https://dashboard.plaid.com), optional and required only for live bank sync

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

For local testing, developer-only reset tools in Settings can also be enabled by
adding `FINTRACK_DEVELOPER_OPTIONS=true` to `.env`.

### Manual setup

Additional setup and usage details continue below.

---

## Contributing

FinTrack is an early-stage project and evolving quickly. Feedback, bug reports, and contributions are welcome.

To contribute:

- open an issue to discuss ideas or bugs
- submit a pull request for improvements
- share FinTrack usage patterns

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## License

This project is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later).

Distributing modified versions of FinTrack requires making the corresponding
source code available under the same license.

See the [LICENSE](LICENSE) file for full details.
