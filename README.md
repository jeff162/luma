# Luma

> Understand where the money actually went.

Luma is a local-first personal finance tool. It collects transaction data from banks, cards, various spending and deposit sources and keeps it categorized with a minimal amount of attention, to answer the question: **what was spent, on what, and how does this period compare with others.** Luma exists because Mint is no longer and Monarch has some annoying issues. I had time so I decided to see if I could build a replacement.

## What Luma is not

Two features sit at the centre of many personal finance apps, and Luma has neither. This isn’t a philosophical decision, it's just that I had no reason to implement them:

- **No budgeting.** Nothing to allocate, no envelopes, no per-category targets, no alert when a category runs hot.

- **No net worth tracking.** Luma holds transactions, not balances — no asset and liability rollup, no account values over time.

Anyone whose main requirement is either of these will be better served by some other app, or they can spend the time to add them to Luma if that feels worthwhile.

**Investment accounts.** Investment accounts currently are only of interest as far as money moving in or out of them from other accounts. This one may change in the future.

## What Luma is good at

- **Showing where money went** — spending by category, merchant, account or owner, with drill-down to the individual transactions, editable in place. Tags allow for custom ‘views’ of the data along any axis the user might want.

- **Comparing periods** — the same breakdown across months or years, so a change in spending is visible. Year-over-year and trend comparisons are built in.

- **Getting data in without ceremony** — a CSV file or a connected data source (e.g. SimpleFIN Bridge). Amazon order history can be imported via CSV files to itemize Amazon spending down to the individual items in an order.

- **Keeping the paperwork with the transaction** — attach a receipt or invoice to any transaction by dropping in a file or pasting from the clipboard. A PDF invoice carries its own text, so an attached repair bill still answers *what was actually done* months later, searchable alongside everything else. A photographed receipt can be stored and viewed just the same. Currently transaction detail is only extracted from plain text such as email receipts.

- **Re-importing just works.** Duplicate detection runs across every source, so overlapping exports, a re-downloaded statement, or the same card arriving from two places will not double-count. No pre-planning of import windows is needed.

- **Staying categorized over time** — rules apply categories, merchant renames and tags to matching transactions as they arrive, and can be "learned" from already categorized data in addition to being created as part of categorizing transactions.

- **Finding what repeats** — subscriptions, bills, taxes and paychecks are detected as recurring series automatically, and anything the detector misses can be declared with a rule.

- **Searching the history** — filter and search across the whole ledger, including exclusion filters and cross-cutting tags.

- **Reimbursables** — pair expenses and income which don't represent spending to exclude them from the totals. Also allows for an expense to be created that expects future reimbursement and can generate reminders if it appears to be late.

## Also included

- **Multiple owners** — track personal and shared finances across several people in one ledger, with
  owner as a reporting axis rather than a separate set of books.

- **Backup and restore** — export the data anywhere, with optional encryption under a key of the
  user's choosing.

- **Tasks** — a running list of what needs attention, such as transactions nothing has categorized.

- **Multiple users** — screen layout and preferences stored on a per-user basis.

- **Runs locally or on the network** — a single-user desktop install, or a machine on the LAN that
  other devices reach, with a sign-in perimeter for the second case.

## How it works

The first run creates a local user and offers a choice: load the demo data, import a CSV, connect a data source or do none of the above. Nothing else needs configuring — the initial import is what brings the rest of the application to life.

Two things then drive everything: **reports** (mostly the dashboard) and **searching** the transaction history. Accounts, owners, categories, tags and rules all exist to make those two better, and each can be used or ignored depending on whether it is useful:

- **Categories** group transactions for reporting — start from a curated starter set or build a tree from scratch or from existing transaction data.

- **Tags** are cross-cutting labels (*Essential Expenses*, *Kids*, *Personal Spending*, *Rental expenses*) that span accounts, owners and categories, and drive their own reports.

- **Rules** pair matching criteria with actions: set the merchant name, assign a category or tag, or mark the transaction as part of a recurring series.

- **Recurring** detects transactions that repeat on a schedule, and lists them as series that can be curated.

The same overview is available inside the application under **Help → How Luma works**.

## Design principles

- **Local unless told otherwise.** Everything runs on the local machine against a local SQLite database. Luma makes no outbound request except for an action the user explicitly asked for — syncing a connected source, writing a backup to a chosen location, reading a CSV off a network drive. There is no telemetry, no analytics, and nothing that phones home.

- **Curation compounds.** Effort spent categorizing should keep paying off on data that has not arrived yet, which is what rules are for.

- **Correctable where it is visible.** Anything wrong on screen should be fixable on that screen, without hunting for the settings page that owns it or the editor which allows modifications.

- **Reversible by default.** Destructive operations are rare, announced, and reversible where they exist at all.

## Privacy

Luma is local-first by design, and the data stays local:

- **The data stays on the local machine** — everything is kept in a local SQLite database.

- **No tracking** — Luma has no analytics, telemetry, or "phone home," and doesn't report on how it is used.

- **Connections happen only when the user asks** — the app reaches the network only for user-driven actions, such as syncing transactions from a connected data source. The only other type of network connection Luma might make is to access a network drive to load a CSV file or write a backup, assuming that is what the user specified.

- **Backups stay local** — exports are saved wherever the user wishes and can be encrypted if desired with a user supplied key.

What comes in, what stays and what leaves are all the user's decision. Luma is built to organize financial data, not to collect it.

## Security

Local-first also means the security model is easy to reason about — but it's worth being clear about what protects what, and what a compromise would actually mean.

- **Transaction data is stored unencrypted on disk.** The ledger lives in a local SQLite database in plain form, so the database files — and any **unencrypted** backup — are the sensitive artifacts to protect. They should be kept off shared or cloud-synced locations; consider using the **encrypted backup** (protected with a user-supplied key) for anything that leaves the machine if you feel it is sensitive data.

- **The optional sign-in password is network-access control, not disk encryption.** It governs who on the local network can reach a running instance. It does not encrypt the database and does not protect the files if someone copies them off the disk.

- **Data-source tokens are one of the secrets Luma encrypts at rest.** A connected provider issues a token that grants **ongoing** access to an account's transactions and balances — it may or may not be able to move money. Because that access is live until revoked, the token is kept in a passphrase-protected vault rather than in plain text. The vault passphrase is separate from the sign-in password and is never stored; losing every way into the vault means re-linking the data sources — the ledger itself is untouched by it.

- **A household shares one vault, and each person opens it their own way.** A user requests access to the vault by setting a vault passphrase on an install that already has a vault passphrase. Someone who can already open the vault then approves the request. No passphrase is ever revealed to anyone else, in either direction.

  - **Vault passphrases** are best kept in a password manager: they are complex, and losing every way in means the vault has to be rebuilt (transactions are not lost, just access to the data providers).
  - **Vault settings** lists everyone who can open the vault, and access can be removed there.
  - **Replace vault key** exists for when the concern is that a key was exposed, since removing access alone does not change the key someone could already read.
  - **A passkey** can be added as a second way in, so a fingerprint or face check replaces retyping a long passphrase — and having two ways in is also the practical safeguard against losing access entirely. (Passkeys need an HTTPS connection to a named host; a passphrase works everywhere.)
  - **A recovery code** can also be generated. It is worth keeping somewhere the vault passphrase is not — stored together in one password manager, losing access to the manager loses both, and while the manager is available the code adds nothing the passphrase does not already do. Printed, or kept in separate secure storage, is what makes it useful to have. It is shown once, and using it issues a replacement.

- **If a database or backup is lost or copied by someone else:** The transactions it holds should be treated as exposed. The one action that helps is revoking Luma's access at each of the connected data sources, which stops the copied credentials, if they can be decrypted, from pulling anything new. Luma revokes the credentials for a Plaid account when the account is disconnected in the app; SimpleFIN tokens need to be revoked using the SimpleFIN Bridge web page. Revoke the access token created for Luma and create a new one. Do this even though the credentials in the lost copy of the database are encrypted. They are protected only by the vault passphrase’s resistance to an offline attack and revoking makes that question moot. In addition, the vault key needs to be regenerated and the passphrase(s) changed because they will be used to protect the new credentials and it is possible that the stolen ones get cracked. Changing them avoids the issue of the person with the stolen database accessing the new database.

- **Revoking works differently per provider, and the app says which applies.** Where a provider supports it (Plaid), **Disconnect** revokes the credential at the provider and the access genuinely ends. Some providers publish no way for another app to revoke a credential (SimpleFIN); there, Disconnect removes only Luma's copy, and revoking means signing in to the provider and doing it there. The disconnect confirmation states which of the two is about to happen, so a connection is never left live while appearing closed.

## Installing Luma

Luma is distributed as a self-contained download — the Python runtime, the backend and the interface
are all inside it, so **neither Python nor Node.js needs to be installed**. Get the current build from
the [releases page](https://github.com/jeff162/luma/releases).

| Platform | Download | Shape |
| --- | --- | --- |
| Windows | `luma-<version>-windows-x64.zip` | Portable |
| Linux | `luma-<version>-linux-x64.zip` | Portable |
| macOS (Apple Silicon) | `luma-<version>-macos-arm64.dmg` | Drag to Applications |
| macOS (Intel) | `luma-<version>-macos-x64.dmg` | Drag to Applications |

Each download has a matching `.sha256` file for anyone who wants to verify it.

**The builds are unsigned.** Certificates are a recurring cost and a separate decision from being able
to build, so Windows and macOS both object on first run. The steps below are what gets past that; the
macOS one in particular is not the gesture most people know.

### Windows and Linux — portable

Unzip the download anywhere and run the executable inside. That folder *is* the installation: the
databases are created beside the executable, so moving the folder moves the data with it, and copying
it to another machine carries everything across.

On Windows, SmartScreen may object to an unsigned executable. Choose **More info**, then **Run anyway**.

### macOS

Open the disk image and drag **Luma** onto the Applications shortcut. Pick the download matching the
machine — Apple menu → **About This Mac** names which one it is. The two are not interchangeable.

Because the build is neither signed nor notarized, macOS refuses it on first launch. **Control-click →
Open no longer works around this on macOS 15 and later.** What does:

1. Double-click **Luma**, and dismiss the warning.
2. Open **System Settings → Privacy & Security**, and scroll down to **Security**.
3. Choose **Open Anyway** beside the message naming Luma, and confirm.

Clearing the quarantine flag beforehand has the same effect:

```bash
xattr -dr com.apple.quarantine /Applications/Luma.app
```

Unlike the portable builds, macOS keeps its data in `~/Library/Application Support/Luma`, and **it
stays there when the application is removed** — an upgrade replaces the bundle wholesale without
touching the databases. An application started from Finder has no terminal, so the startup messages
that would otherwise carry the address go to `luma-desktop.log` in that directory.

Quit from the Dock, with Command-Q, or with **Shut down Luma** at the bottom of the navigation panel —
all three perform the same graceful shutdown.

### First run

Luma starts a local server and opens in the default browser. **It listens on loopback only**, so
nothing off the machine can reach it. Launching it again while it is already running opens a new tab
against the existing instance rather than starting a second copy.

Nothing needs configuring first. Every setting has a working default, and the values that must persist are generated on first run and kept in the
control database. Everything relevant to everyday use is configured in the app under **Settings**.

From there the first run is as described in *How it works* above. **Settings → Configuration** reports
every effective setting and which layer supplied it.

## Running from source

Running from a checkout needs Python 3.12 or 3.13 and Node.js 22.12+, and is the arrangement for working *on*
Luma rather than with it. `CONTRIBUTING.md` has the setup, the useful checks and the project
conventions.

An optional `.env` file overrides the handful of values resolved before the app is running — the ports,
the data directory (`DATA_DIR`, holding both databases), and the developer-options gate. Copy
`.env_example` to `.env` to use it.

## Platform support

Windows, macOS, Linux, and Raspberry Pi (Raspberry Pi OS and other ARM Linux distributions). On a Pi,
performance depends on the model, storage speed, and whether it runs directly or through Docker.

Python 3.12 is what Luma is built and tested on, and 3.13 is expected to work. **3.14 is not
supported:** the pinned `pydantic-core` publishes no wheels for it, so installing the dependencies
would fall back to compiling from source. (This applies to running from source; the downloads carry
their own runtime.)

## Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Python 3.12 / FastAPI / SQLite |
| Frontend | React 18 / Vite / Recharts |
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
