# Migration Test Databases

This folder is for standalone database creators used to test schema migrations.

These creators are intentionally separate from runtime bootstrap code. The app
should only know how to create the current schema and migrate older databases
forward. Historical database creation belongs here for testing.

## Recommended Pattern

When a schema change is introduced:

1. Update `init_db()` in `backend/db/database.py` so a brand-new database is
   created directly in the latest schema.
2. Add a forward migration for existing databases.
3. If migration coverage is needed, add a standalone creator here for the
   pre-migration schema version.

Examples while versions are still supported:

- `create_base_db.py`
- `create_v1_db.py`
- `create_v2_db.py`
- `create_v3_db.py`

Each creator should:

- build a database directly in that version's schema
- insert only the minimum representative data needed for migration tests
- set `db_meta.version` to that version
- avoid importing current schema helpers in ways that would silently drift

These files are historical snapshots, not wrappers around current runtime
database code, except for `create_base_db.py`, which defines the oldest
currently supported baseline fixture.

## Lifecycle

Creators in this folder should exist only for schema versions that are still
supported as migration starting points.

While a migration path from an older schema version is still carried in the
runtime code, there should be a matching creator here for that schema shape.

When old migrations are removed from `backend/db/database.py`, remove the
matching historical DB creators and any tests that depend on them.

The exception is the oldest remaining supported schema version. Its creator
becomes the new `create_base_db.py`, because that is now the baseline database
shape from which all still-supported migrations begin.

## Goal

Keep runtime code clean while still making migration testing possible:

- runtime: current schema + forward migrations
- test fixtures: baseline + old schema creators used to verify upgrade paths
