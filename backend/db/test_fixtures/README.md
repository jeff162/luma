<!-- SPDX-FileCopyrightText: 2026 Jeffrey Orlin -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Migration Test Databases

This folder is for standalone database creators used to test schema migrations
and to create a fresh database fixture for the current schema version.

These creators are intentionally separate from runtime migration logic. Runtime
code should do two things only:

- create a brand-new database directly in the current schema
- migrate older databases forward

Version-tagged fixture creators live here so migration tests can build exact
starting points intentionally.

## Recommended Pattern

When a schema change is introduced:

1. Update `init_db()` in `backend/db/database.py` so a brand-new database is
   created directly in the latest schema and marked at the latest
   `CURRENT_VERSION` without replaying migrations.
2. Add a forward migration for existing databases.
3. Add or update a standalone creator here for the latest schema version
   (`create_vN_db.py`).
4. If migration coverage is needed, keep `create_base_db.py` as the fixture for
   the database shape immediately before the oldest supported migration.

Examples while versions are still relevant:

- `create_base_db.py`
- `create_v1_db.py`
- `create_v2_db.py`
- `create_v3_db.py`

Each creator should:

- build a database directly in that version's schema
- insert only the minimum representative data needed for migration tests
- set `db_meta.version` to that version
- avoid importing current schema helpers in ways that would silently drift

`create_base_db.py` is special:

- while migration `v1` exists, it should create the pre-`v1` database
- while the oldest retained migration is `vN`, it should create the pre-`vN`
  database

Versioned files like `create_v1_db.py` represent fresh databases already at
that schema version.

## Lifecycle

Creators in this folder should exist for:

- `create_base_db.py`, for the pre-oldest-supported-migration starting point
- the current schema version, so fresh-schema expectations are explicit
- any older schema versions still supported as migration starting points

While a migration path from an older schema version is still carried in the
runtime code, there should be a matching creator here for that schema shape.

When old migrations are removed from `backend/db/database.py`, remove the
matching historical DB creators and any tests that depend on them.

When the oldest migration is removed from runtime:

1. delete the old `create_base_db.py`
2. rename the oldest surviving `create_vN_db.py` to `create_base_db.py`
3. delete the old `create_vN_db.py` filename

## Goal

Keep runtime code clean while still making migration testing possible:

- runtime: current schema for fresh DBs + forward migrations for existing DBs
- test fixtures: `create_base_db.py` for the oldest supported migration entry
  point, plus versioned creators for current and historical schema versions
