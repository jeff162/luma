# Luma

> Understand where the money actually went.

Luma is a local-first personal finance tool. It collects transaction data from banks, cards, various spending and deposit sources and keeps it categorized to answer the question: **what was spent, on what, and how does this period compare with others.** Luma exists because Mint is no longer and Monarch has some annoying issues. I had time so I decided to see if I could build a replacement.

## Contents

- [What Luma is not](#what-luma-is-not)
- [What Luma is good at](#what-luma-is-good-at)
- [Quick start](#quick-start)
- [Features](#features)
- [Design principles](#design-principles)
- [Privacy](#privacy)
- [Security](#security)
- [Installing Luma](#installing-luma)
- [Getting started with real data](#getting-started-with-real-data)
- [Running Luma as a server](#running-luma-as-a-server)
- [Locked out](#locked-out)
- [Running from source](#running-from-source)
- [Platform support](#platform-support)
- [Tech stack](#tech-stack)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## What Luma is not

Two features sit at the centre of many personal finance apps, and Luma has neither. This isn’t a philosophical decision, it's just that I had no reason to implement them:

- **No budgeting.** Nothing to allocate, no envelopes, no per-category targets, no alert when a category runs hot.

- **No net worth tracking.** Luma holds transactions, not balances — no asset and liability rollup, no account values over time.

Anyone whose main requirement is either of these will be better served by some other app, or they can spend the time to add them to Luma if that feels worthwhile.

**Investment accounts.** Investment accounts currently are only of interest as far as money moving in or out of them from other accounts. This one may change in the future.

**Phones.** Luma is built for a laptop or desktop sized screen, and its pages do not adapt to a small one. A tablet is about the smallest device it is comfortable on.

## What Luma is good at

- **Keeping the friction low** — getting data in and keeping it current should not be a project in its own right. An import needs no planning and no arithmetic about which dates are already covered, overlapping files sort themselves out, and a categorization made once is carried forward instead of being made again.

- **Structure if it's wanted** — categories, tags and rules are not the point, examining spending is. They exist so that a question about a period can be answered without going through it row by row, and the work put into building rules keeps paying off on transactions that have not arrived yet.

- **Surfacing potential exceptions** — a subscription that quietly went up, a bill that has not turned up, a charge that no longer matches the rule that used to catch it. Noticing these is what the reports and the recurring detection are for, rather than waiting to be asked the right question.

- **Staying out of the way** — if something needs changing, it can usually be changed right there: a category, a merchant name, whether a transaction counts towards a total at all. Reports can be useful for cleaning the data as well as actual reporting.

## Quick start

1. Download the build for the machine from the [releases page](https://github.com/jeff162/luma/releases) and run it. Luma opens in the browser. [Installing Luma](#installing-luma) has the detail for each platform.
2. Enter a user name and choose **Load demo data**.
3. Look around. Nothing done to the demo data matters.
4. When ready, choose **Clear demo data** in the banner at the top and bring in real data — see [Getting started with real data](#getting-started-with-real-data).

## Features

- **Showing where money went** — spending by category, merchant, account or owner, with drill-down to the individual transactions, editable in place. Tags allow for custom ‘views’ of the data along any axis the user might want.

- **Comparing periods** — the same breakdown across months or years, so a change in spending is visible. Year-over-year and trend comparisons are built in.

- **Analyzing cash flow** — a cash-flow view sits alongside the spending and income views and nets the two. A single period is drawn as a flow diagram, from where the money came in through to the categories it went out to; a run of months is drawn as money in against money out with the net over the top. Anything on either can be drilled into to reach the transactions behind it.

- **Getting data in without ceremony** — a CSV file exported from a bank or card, or a connected data source (e.g. SimpleFIN Bridge) that brings transactions in on its own. A data source can also watch a folder, so a downloaded export is in the ledger the next time the app is open. Other input formats can be added as the need arises.

- **Filling in what a marketplace charge bought** — an Amazon or PayPal purchase typically arrives with just the marketplace name and an amount and nothing else. The marketplace's own export adds the missing detail: Amazon order history as CSV files and PayPal activity as its monthly statement PDFs or a CSV can enrich the entries with detail information about the transaction. In addition to providing useful information in the transaction register, this also allows the transactions to be categorized as more than just "Amazon Spending".

- **Keeping the paperwork with the transaction** — attach a receipt or invoice to any transaction by dropping in a file or pasting from the clipboard. A PDF invoice or HTML receipt carries its own text, so an attached repair bill still answers *what was actually done* months later, searchable alongside everything else. A photographed receipt can be stored and viewed but is not searchable as there is no OCR support.

- **Re-importing just works.** A file that was already imported is recognized, and the rows an overlapping export or a re-downloaded statement repeats exactly are skipped, so no pre-planning of import windows is needed. Activity that arrives a second way without matching exactly — the same card from two sources, say — is flagged as a likely duplicate for review instead, and counts twice until that review resolves it.

- **Staying categorized over time** — rules apply categories, merchant renames and tags to matching transactions as they arrive, and can be "learned" from already categorized data in addition to being created as part of categorizing transactions.

- **Splitting a transaction across categories** — a single charge that was part one thing and part another can be divided between them, and every report counts each part where it belongs rather than filing the whole amount under one category. Each part can be labelled with what it covered, and a charge matched to an imported Amazon order is offered a split already filled in from the item prices.

- **Finding what repeats** — subscriptions, bills, taxes and paychecks are detected as recurring series automatically, and anything the detector misses can be declared with a rule. The Recurring page also reports what looks off about them: a charge that has not turned up, a price that has moved, a series that has only just appeared, and a bill that has drifted outside the amount range its rule matches on. Each one can be dismissed once it has been looked at, and a separate tab lists what is expected next.

- **Searching the history** — filter and search across the whole ledger, including exclusion filters and cross-cutting tags.

- **Reimbursables** — money that goes out and is expected back but is excluded from spending or income. The part that is owed is held in its own excluded category rather than counted as spending, and the repayment lands there too instead of arriving as income, so each month reports what it really spent and what is still outstanding is a running total. A repayment sometimes does not match the original purchase — tickets bought for one price and sold on for another — and what is left over gets categorized as either a real cost or gain. An expense can also be recorded before any repayment exists. Reimbursables can have reminders to alert if they are not completed within the expected timeframe.

### Also included

- **Multiple owners** — track personal and shared finances across several people in one ledger, with
  owner as a reporting axis rather than a separate set of books.

- **Backup and restore** — export the data anywhere, with optional encryption under a key of the
  user's choosing.

- **Tasks** — a running list of what needs attention, such as transactions nothing has categorized.

- **Multiple users** — screen layout and preferences stored on a per-user basis.

- **Runs locally or on the network** — a single-user desktop install, or a machine on the LAN that
 other devices reach.

## Design principles

- **Local unless told otherwise.** Everything runs on the local machine against a local SQLite database. Luma makes no outbound request except for an action the user explicitly asked for — syncing a connected source, writing a backup to a chosen location, reading a CSV off a network drive. There is no telemetry, no analytics, and nothing that phones home. One edge case is that, when enabled, Luma will check for a new version which involves fetching the current release information periodically. Nothing about the installation is sent.

- **Curation compounds.** Effort spent categorizing should keep paying off on data that has not arrived yet, which is what rules are for.

- **Correctable where it is visible.** Anything wrong on screen should be fixable on that screen, without hunting for the settings page that owns it or the editor which allows modifications.

- **Reversible by default.** Most changes can be undone or adjusted later, and most removals go to a trash or an inactive list that can be restored from. The few that are permanent say so before they happen.

## Privacy

Luma is local-first by design, and the data stays local:

- **The data stays on the local machine** — everything is kept in a local SQLite database.

- **No tracking** — Luma has no analytics, telemetry, or "phone home."

- **Connections happen only when the user asks** — the app reaches the network only for user-driven actions, such as syncing transactions from a connected data source. The only other type of network connection Luma might make is to access a network drive to load a CSV file or write a backup, assuming that is what the user specified.

- **Optional check for new releases** — off by default. When enabled Luma periodically asks GitHub for the project's latest version number. The request says nothing about the installation or its data but as with any network request, GitHub sees the address it comes from.

- **Backups stay local** — exports are saved wherever the user wishes and can be encrypted if desired with a user supplied key.

What comes in, what stays and what leaves are all the user's decision. Luma is built to organize financial data, not to collect it.

## Security

Local-first also means the security model is easy to reason about — but it's worth being clear about what protects what, and what a compromise would actually mean.

- **Transaction data is stored unencrypted on disk.** The ledger lives in a local SQLite database in plain form, so the database files — and any **unencrypted** backup — are the artifacts to protect. Consider using the **encrypted backup** (protected with a user-supplied key) for anything that leaves the machine if you feel it is sensitive data.

- **The optional sign-in password is network-access control.** It governs who on the local machine or network can reach a running instance. It does not encrypt the database and does not protect the files if someone copies them off the disk. It does not prevent someone from examining the database file directly with SQLite.

- **Data-source tokens are one of the secrets Luma encrypts at rest.** A connected provider issues a token that grants **ongoing** access to an account's transactions and balances — it may or may not also be able to move money. Because that access is live until revoked, the token is kept in a passphrase-protected vault rather than in plain text. The vault passphrase is separate from the sign-in password and is never stored; losing every way into the vault means re-linking the data sources — the ledger itself is not affected.

- **A household shares one vault, and each person has their own access.** A user requests access to the vault by setting a vault passphrase on an install that already has a vault passphrase. Someone who can already open the vault then approves the request. No passphrase is ever revealed to anyone else, in either direction.

  - **Vault passphrases** are best kept in a password manager: they are complex, and losing every way in means the vault has to be rebuilt (transactions are not lost, just access to the data providers).
  - **A passkey** can be added as a second way in, so a fingerprint or face check replaces retyping a long passphrase — and having two ways in is also the practical safeguard against losing access entirely. (Passkeys need a secure connection. The desktop app's `localhost` address works or reaching Luma over a network uses HTTPS and a host name.)
  - **A recovery code** can also be generated. It is worth keeping somewhere seperate from the vault passphrase as if stored together in one password manager, losing access to the manager loses both. Printed or kept in separate secure storage is what makes it useful to have. Recovery codes are single-use.

- **If a database or backup is lost or copied by someone else** and data connections are configured, Luma's access should be revoked at each connected data source so the copied credentials cannot pull anything new or worse, be used to move money around if the credentials support money movement.. The place to start is **Respond to an exposure** in Vault settings (Import → Connections, with the vault unlocked), which replaces the credentials where the provider allows it and lists the steps that remain. `SECURITY.md` has the full response.

- **Revoking works differently per provider, and the app says which applies.** Where a provider supports it (Plaid), **Disconnect** revokes the credential at the provider and the access genuinely ends. Some providers publish no way for another app to revoke a credential (SimpleFIN); there, Disconnect removes only Luma's copy, and revoking means signing in to the provider and doing it there. The disconnect confirmation states which of the two is about to happen, so a connection is never left live while appearing closed.

## Installing Luma

Luma for a single machine is distributed as a self-contained download. The current build is available at the [releases page](https://github.com/jeff162/luma/releases).

Luma can also be deployed as a server to other computers in a household.
That can be built around the same download or (for Linux) around a Docker container version — see
[Running Luma as a server](#running-luma-as-a-server).

| Platform | Download | Shape |
| --- | --- | --- |
| Windows | `luma-<version>-windows-x64.zip` | Portable |
| Linux (x86-64) | `luma-<version>-linux-x64.tar.gz` | Portable |
| Linux ARM64 / Raspberry Pi | `luma-<version>-linux-arm64.tar.gz` | Portable |
| macOS (Apple Silicon) | `luma-<version>-macos-arm64.dmg` | Drag to Applications |
| macOS (Intel) | `luma-<version>-macos-x64.dmg` | Drag to Applications |

**The builds are unsigned.** so Windows and macOS both generate warnings about untrused software on first run.

### Windows and Linux — portable

Unpack the download and run the luma executable. The folder *is* the installation: the
databases are created beside the executable, so moving the folder moves the data with it, and copying
it to another machine carries everything across.

On Windows, SmartScreen may object to an unsigned executable. Choose **More info**, then **Run anyway**.

On Linux, unpack the downloaded file with `tar -xzf luma-<version>-linux-x64.tar.gz`, then run with
`./luma/luma`. The Linux builds
need glibc 2.39 or newer — Ubuntu 24.04, Debian 13, Raspberry Pi OS trixie, or later.

### macOS

Pick the download matching the
machine — Apple menu → **About This Mac** names which one it is. The two are not interchangeable. Open the downloaded disk image and drag **Luma** onto the Applications shortcut.

Because the build is neither signed nor notarized, macOS refuses it on first launch. To mark the execuatable so it can be run:

1. Double-click **Luma**, and dismiss the warning.
2. Open **System Settings → Privacy & Security**, and scroll down to **Security**.
3. Choose **Open Anyway** beside the message naming Luma, and confirm.

Clearing the quarantine flag beforehand has the same effect:

```bash
xattr -dr com.apple.quarantine /Applications/Luma.app
```

Unlike the portable builds, macOS keeps its data in `~/Library/Application Support/Luma`, and **it
stays there when the application is removed** — an upgrade replaces the bundle wholesale without
touching the databases. An application started from Finder has no terminal, so the startup messages go to `luma-desktop.log` in that directory.

Quit from the Dock, with Command-Q, or with **Shut down Luma** at the bottom of the navigation panel —
all three perform the same graceful shutdown.

### Starting Luma

Luma starts a local server and opens in the default browser. **It listens on loopback only**, so
nothing off the machine can reach it. Launching it again while it is already running opens a new tab
against the existing instance rather than starting a second copy. Additional browser windows can be pointed at the same address if desired; it is safe to access from multiple browsers simultaneously.

There is nothing to be configured up front. Every setting has a working default.

## Getting started with real data

The first run asks for a user name and then offers a choice of where the first data comes from. **Skip for now** opens the application empty, and everything below can be done from there.

1. **Load transactions.** Import CSV files on the Import page, connect a data provider, or both. With several files, import them all before moving on. Importing creates the accounts the transactions belong to.
2. **Set up categories.** Load the starter categories and rules, or have Luma build them from the categories the imported files already carry, or start with none and add them while categorizing.
3. **Categorize what is left.** The Transactions page can show only the uncategorized rows. Assigning a category offers to create a rule from it, so the same kind of transaction is handled from then on.
4. **Open the Dashboard** and drill into the categories to see whether the picture looks right.

**Help → How Luma works** in the application covers the same steps in more detail.

## Running Luma as a server

One computer runs Luma and the other computers on the local network open it in a browser. Everyone
connected sees the same data. Sign-in protection can be enabled to control who can connect.

How to set one up, with HTTPS:

- **Docker on Linux** is the easiest way, and uses Caddy to provide HTTPS. The instructions are [below](#with-docker).
- **On Windows**, the easiest way is to put the Caddy executable (a free download) in the directory with Luma, which then starts it.
- **On Linux without Docker**, Caddy is installed from the distribution's packages.

Instructions for the last two, and what each connecting computer does on its first visit, are in the application under **Help → Running Luma as a server**. Starting the download the ordinary way is enough to read them. A Mac can be the server as well, with Caddy and starting at boot set up using that system's own tools.

`luma --server` starts Luma in server mode and creates a name on the network, `luma.local`, to reach the app. It can be
set up with or without HTTPS, which is what encrypts the connection between the server and the other computers.

| | With HTTPS | Without HTTPS |
| --- | --- | --- |
| Address the other computers open | `https://luma.local` | `http://luma.local:8010` |
| What crosses the network | encrypted | readable by anyone on the network, sign-in passwords and vault passphrase included |
| Passkeys | work | do not work |
| Setting up a data provider | from any computer | only from a browser on the server itself |
| Setup | Caddy runs beside Luma to provide HTTPS. Each computer installs the server's certificate once, so its browser trusts the server | nothing further |

The two restrictions have different causes. The passkey requirement is from the browser and cannot be worked around. The restriction around setting up a data provider comes from Luma, because secrets need to move between the user and the server and these should not pass over a network unencrypted. Syncing is still allowed from any browser, since that does not involve secrets moving over the local network.

**Without HTTPS the vault passphrase travels over the local network unencrypted.** Anyone who captures it and has a copy of either the database or a credentials backup can extract the data provider secrets from that copy. This should be considered before using Luma in a server configuration without HTTPS.

### With Docker

On a Linux host, if Docker with the Compose plugin is available, this is a straightforward way to get Luma running as a server.

1. Save `docker-compose.yml` from the [releases page](https://github.com/jeff162/luma/releases) into a
   folder of its own.
2. Create a file named `.env` in the folder containing: `SESSION_COOKIE_SECURE=true`. If a network name other than the default `luma.local` is desired then add `MDNS_NAME=` followed by the desired name, without the `.local` ending.
3. Start it, and read the address other computers use from the log:

   ```sh
   docker compose up -d
   docker compose logs app
   ```

The data lives in a `data` folder beside `docker-compose.yml`, so backing up that folder backs up the
installation. A firewall on the host has to allow TCP port 443 and UDP port 5353, and ports 80 and 443
have to be free for Caddy. Each connecting computer installs the server's certificate on its first
visit, as described in the Help topic above. The fingerprint for comparison is displayed by:

```sh
docker compose exec app python -m backend.desktop --certificate-fingerprint
```

Updating to a newer release is `docker compose pull` followed by `docker compose up -d`.

Docker Desktop on Windows and macOS runs containers inside a virtual machine, which does not work for a
Luma server, so this only works on Linux.

If running from a source checkout, `docker compose up -d --build` builds the image from the source instead of
pulling the published one.

## Locked out

A forgotten password is reset from a terminal on the computer that holds the data, by running Luma with
`--reset-password`:

| Installation | Command |
| --- | --- |
| Windows or Linux download | `luma --reset-password`, in the folder holding the program |
| macOS | `/Applications/Luma.app/Contents/Resources/server/luma --reset-password` |
| Docker | `docker compose exec app python -m backend.desktop --reset-password` |
| Source checkout | `backend/venv/bin/python -m backend.desktop --reset-password` |

It lists the accounts to choose from and asks for the new password, and is safe to run while Luma is
running. The account chosen ends up as an active administrator with two-factor sign-in off, and current
browser sessions are signed out. The vault passphrase is not affected.

## Running from source

Running from a checkout needs Python 3.12 or newer and Node.js 22.12+, and is the arrangement for working *on*
Luma rather than with it. `CONTRIBUTING.md` has the setup, the useful checks and the project
conventions.

An optional `.env` file overrides the handful of values resolved before the app is running — the ports,
the data directory (`DATA_DIR`, holding both databases, the `documents` folder of attachments and the
`luma.log` error log), and the developer-options gate. Copy
`env_example.txt` to `.env` to use it.

## Platform support

Windows, macOS, Linux, and Raspberry Pi (Raspberry Pi OS and other ARM Linux distributions). On a Pi,
performance depends on the model, storage speed, and whether it runs directly or through Docker.

Each Linux download carries a minimum glibc, because the build links against the C library of the
machine that produced it. Both are compiled on Ubuntu 24.04 and need **glibc 2.39 or newer**, which
covers Ubuntu 24.04, Debian 13, Raspberry Pi OS trixie and everything after them. The ARM64 download
is also **64-bit only** — a 32-bit Raspberry Pi OS is a different architecture and has no build.
Running from source has none of these restrictions, and the Docker image carries its own C library, so
the glibc minimum does not apply to it.

Python 3.12 is what Luma is built on, and the test suite also runs on 3.14. (This applies to running
from source; the downloads carry their own runtime.)

## Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Python 3.12 / FastAPI / SQLite |
| Frontend | React 19 / Vite / Recharts |
| Bank data | Plaid or SimpleFIN (both optional) |

## Documentation

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — development setup, checks, and project conventions
- **[SECURITY.md](SECURITY.md)** — the security model, what is in scope, and how to report a vulnerability
- **[CHANGELOG.md](CHANGELOG.md)** — what changed between releases
- **[docs/architecture.md](docs/architecture.md)** — application structure, data flow, and major subsystems
- **[docs/data-model.md](docs/data-model.md)** — core entities, relationships, and the invariants that hold them together
- **[docs/security-model.md](docs/security-model.md)** — what is defended and what deliberately is not, and why the design is shaped the way it is
- **[docs/operations.md](docs/operations.md)** — running an instance: topologies, configuration, restore, and diagnosing
- **[docs/scale-and-limits.md](docs/scale-and-limits.md)** — what breaks at volume, what is capped on purpose, and why
- **[docs/ui-patterns.md](docs/ui-patterns.md)** — interaction patterns and shared UI behavior
- **[docs/mechanism-index.md](docs/mechanism-index.md)** — which mechanism is which: splits, purchases, recurring series, reimbursements
- **[docs/shared-components.md](docs/shared-components.md)** — which shared component to use for what
- **[docs/building-a-connector.md](docs/building-a-connector.md)** — adding a data source
- **[docs/releasing.md](docs/releasing.md)** — building the downloadable artifacts and cutting a release
- **[docs/backlog/](docs/backlog/)** — deferred and parked work, one file per initiative
- **[docs/README.md](docs/README.md)** — an index of every document in `docs/` and its sections

In the application itself, **Help → How Luma works** covers the same model from the user's side.

## Contributing

Luma is early-stage and evolving. Bug reports, feedback and pull requests are welcome — open an
issue to discuss an idea or a defect, and see [CONTRIBUTING.md](CONTRIBUTING.md) before submitting
changes. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Two things worth knowing before proposing a feature: Luma deliberately has **no budgeting and no net
worth tracking** (see *What Luma is not* above), and there is a set of projects already designed and
queued in [docs/backlog/](docs/backlog/) — commenting on an existing plan is more useful than a new
issue.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

See the [LICENSE](LICENSE) file for full details.
