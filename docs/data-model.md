# Data Model

This is the working model FinTrack is built around.

This document focuses on data semantics and invariants. For how these are exposed through the API and UI, see `architecture.md`.

## Contents

- [Core hierarchy](#core-hierarchy)

- [Owners](#owners)

- [Accounts](#accounts)

- [Transactions](#transactions)

- [Categories](#categories)

- [Rules](#rules)

- [Import batches and profiles](#import-batches-and-profiles)

- [Backups](#backups)

- [Schema evolution](#schema-evolution)

- [Reporting assumptions](#reporting-assumptions)

## Core hierarchy

The main relationship chain is:

`Owner -\> Account -\> Transaction -\> Category (leaf) -\> Category Group`

In practice:

- an **owner** represents a person or household bucket

- an **account** belongs to one owner

- a **transaction** belongs to one account

- a **transaction** may be assigned to one leaf category

- a **leaf category** belongs to a top-level category group

## Owners

Owners represent household members or shared buckets such as:

- Alice

- Bob

- Shared

They are used for:

- assigning accounts

- scoping some rules

- splitting dashboard views

- surfacing ownership-related tasks

Transactions also carry `owner\_id`, denormalized from the account, so owner-based filtering is cheaper in summary queries.

## Accounts

Accounts represent bank or credit accounts, typically imported from Plaid or created during CSV import.

Important behavior:

- each account belongs to an owner or is temporarily unassigned

- transactions reference `account\_id`

- account ownership affects owner-based reporting and tasks

## Transactions

Transactions are the central fact table.

Important conventions:

- `amount \> 0` means money out

- `amount \< 0` means money in

- `category\_overridden = 1` means the user manually chose the category

- pending transactions are visible in lists but usually excluded from summary totals

Name fields:

- **`raw\_name`:** imported or provider-supplied name

- **`merchant\_name`:** cleaned display name when available

## Categories

Categories are intentionally limited to **two levels**:

- top-level **groups**

- child **leaf categories**

Examples:

- Group: `Food & Drink`

- Leaf: `Groceries`

- Leaf: `Dining Out`

Important invariant:

- transactions should be assigned to leaf categories, not groups

Groups also carry important reporting behavior:

- **`category\_type`:** typically `expense` or `income`

- **`exclude\_from\_totals`:** removes that group and all descendants from charts and totals

This is used for things like transfers and credit-card-payment categories.

## Rules

Rules are keyword-based categorization rules.

They can include:

- merchant keyword

- amount conditions

- owner scope

- account scope

- category assignment

- merchant rename (`clean\_name`)

Important behavior:

- rule priority is automatic, not manually curated

- more specific rules beat more general ones

- amount comparisons use absolute values

- owner-scoped rules beat global rules when otherwise similar

## Import batches and profiles

CSV import creates supporting records for workflow and recovery:

- **Import profiles:** saved mapping/setup templates for recurring CSV formats

- **Import batches:** one record per import run so imported transactions can be undone

Imports also use content hashing for duplicate detection.

## Backups

Backup/restore deals with two different classes of data:

- regular app data

- credentials/secrets such as Plaid-linked credentials

Those are intentionally separated so normal backups can stay safer and simpler.

## Schema evolution

The SQLite schema is versioned and migrated automatically on startup.

If the schema changes:

- add a migration in `backend/db/database.py`

- bump the current schema version

- keep migrations idempotent when practical

## Reporting assumptions

A few behavior rules matter across the whole app:

- income groups match money-in transactions

- expense groups match money-out transactions

- `exclude\_from\_totals` must be honored consistently across summaries and charts

- category grouping is only two levels deep

If any of these assumptions change, both backend queries and frontend UI logic will likely need coordinated updates.

