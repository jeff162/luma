# Luma

> Your financial data, without the friction.

Luma is a personal finance tool that helps you import your data, categorize it, and keep it organized with minimal friction.

Start with a CSV export or connect an account, clean up your categories, define rules for common transactions, and let Luma apply them as new data comes in.

You stay in control — Luma makes it easy to review what changed, spot anything that looks off, and adjust when needed.

Less repetition. Fewer manual fixes. Clear, usable financial data.

## Why Luma?

Most personal finance tools follow the same basic model: import data, categorize transactions, define rules, and review the results.

The difference is how much friction that introduces.

Luma is designed to reduce that friction:

- Getting data in is quick and flexible (CSV or connected accounts)

- Categorizing and fixing transactions happens directly where the data is

- Rules are easy to create and adjust as you go

- Reviewing your data is straightforward — no digging through menus or workflows

You still do the same core tasks — Luma just makes them easier to do and easier to maintain over time.

## What does Luma do?

Luma helps you turn raw financial data into something organized and usable.

You can:

- import transactions from CSV or connected accounts

- categorize and organize your data across accounts and owners

- define rules to handle recurring transactions

- review and maintain your data as new transactions come in

- analyze spending with dashboards and drill-down views

All core functionality runs locally on your machine. External integrations are optional.

## Who is this for?

Luma is a good fit for people who:

- want to import and organize financial data quickly

- are migrating from another tool or starting fresh

- prefer tools that don’t require constant manual upkeep

- want control over their data without sacrificing usability

- track personal or household finances in one place

It may not be ideal for:

- fully managed cloud services

- mobile-first apps with zero setup

## Philosophy

Luma is built on a few core principles:

- Financial tools should reduce effort, not create it

- Categorization should improve over time, not repeat work

- Data should remain under user control

- Interfaces should support natural workflows

- Users should be able to act directly where their data lives

## Features

Luma focuses on making common tasks easy and reducing the effort required to maintain accurate data over time.

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

- Python 3.12+

- Node.js 20+

- A Plaid account (optional, required only for automatic bank sync)

### Quick start

```
\`git clone https://github.com/your-username/luma.git\`  
  
\`cd luma\`  
  
\`\\\# Windows Command Prompt or double-click\`  
  
\`.\\\\scripts\\\\start\\\_luma.bat\`  
  
  
\`\\\# Windows PowerShell\`  
  
\`powershell -ExecutionPolicy Bypass -File .\\\\scripts\\\\start\\\_luma.ps1\`  
  
  
\`\\\# macOS / Linux / Raspberry Pi\`  
  
\`bash ./scripts/start\\\_luma.sh\`
```

The helper scripts:

- create `.env` from `.env\\\_example` if needed

- generate secure first-run values for `SESSION\\\_SECRET`, `APP\\\_MASTER\\\_KEY`, and `SESSION\\\_COOKIE\\\_NAME`

- create the backend virtual environment if needed

- install backend and frontend dependencies

- open separate backend and frontend windows

After startup, review `.env` as needed to customize ports, Plaid settings,  
logging, or other advanced options.

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

This project is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later).

See the [LICENSE](https://chatgpt.com/c/LICENSE) file for full details.

