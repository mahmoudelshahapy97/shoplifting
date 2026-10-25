# Migrations

`../schema.sql` is the baseline: Postgres runs it once, on the first boot of an
empty volume. Every schema change made after that goes into **both** places:

1. `schema.sql`, so a fresh database is born current;
2. a new file here, `NNN_short_name.sql` (three or more digits, applied in name
   order), so an existing database catches up.

The api applies pending files at startup, one transaction each, recording them
in `schema_migration` (`app/core/migrations.py`; list them with
`python -m app.core.migrations --list`). On a fresh volume a migration runs
against a schema that already has its change, so write them idempotently
(`IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object ...`).

There are none yet: this app started from the current schema.
