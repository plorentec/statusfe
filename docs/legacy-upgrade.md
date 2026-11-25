# Legacy upgrade migration repair (5.8.1)

Pre-2.9 installs that upgrade to the versioned-migrations build failed at boot
with `relation "organizations" does not exist` from `002-columns-and-backfills`.
This adds an idempotent, runner-internal schema prerequisite that creates the
missing newer-era tables before 002 runs — no data, applied history or
migration source is touched.

## What broke

The runner **adopts** a database that predates versioning: it records
`001-baseline` as applied *without running* its `CREATE TABLE` statements (the
legacy core schema already exists). On a database that is also older than 2.9.0,
the newer-era tables that 001 would have created — `organizations` and friends —
were never created. `002-columns-and-backfills` then ran its unguarded
Default-organization backfill and died:

```
Migration 001-baseline: already applied
Migration 002-columns-and-backfills FAILED: relation "organizations" does not exist
Startup failed: Migration 002-columns-and-backfills FAILED: relation "organizations" does not exist
```

A later migration could never repair this: the runner always applies 002 first.

## The repair

| Piece | What it does |
|---|---|
| `src/db/migrations/legacy-schema-prerequisites.js` | Creates the missing newer-era tables idempotently (probed first — pg-mem throws on a repeated `CREATE TABLE IF NOT EXISTS`). The mandatory `org_invites` unique-token index is ensured on **every** run when the table exists (idempotent `IF NOT EXISTS`, fail-closed). Every other index is created **unguarded** right after its table (no try/catch swallowing). Never touches core tables, rows, or the applied history. |
| `src/db/migrations/index.js` | Invokes the prerequisite in two places: (1) during adoption (before `init()` runs `seed()`), and (2) right before the **concrete** 002 migration on the retry path. Both are gated so a custom registry that reuses the 001/002 version strings never triggers the real 002 repair, and `upTo:001` on an already-adopted database is a no-op. |

It is **not** a numbered migration: it never appears in `schema_migrations`,
`migrationStatus()` or the registry, so ordinary fresh, current, custom-registry
and `upTo` behaviour is byte-for-byte unchanged (verified by the shared-runner
differential).

The prerequisite is gated at the effective 002 boundary, not the registry:
- **First adoption** (adoption fires this call) — runs before seed, completing
  the adopted baseline schema the way the old `createTables` did.
- **Retry of a failed 002** (001 already recorded) — runs right before the real
  002 executes in the loop.
- **`upTo:001` on an already-adopted database** — does **not** run (002 is not
  in the effective list), so no tables are created and nothing is logged.
- **Custom registry with fake 001/002 version strings** — the concrete-identity
  check (`migration === BACKFILLS_MIGRATION`) and `known.includes(BACKFILLS_MIGRATION)`
  mean an arbitrary callback that reuses those version strings never triggers
  the real repair.

### Tables the prerequisite creates (when missing)

- `organizations`, `organization_members`, `org_invites` (2.9.0+)
- `probe_latency` (3.2.0), `subscribers` (2.8.0), `audit_log`
- `component_groups`, `group_pages`, `component_group_members` (2.2.x — 002's
  unguarded statements reference them)

On a fresh boot (001 actually ran) every table already exists, so the
prerequisite is a probe-only no-op and logs nothing.

### Retry guarantee for the unique-token index

`org_invites.token` uniqueness lives in the **`idx_org_invites_token` UNIQUE
index** — the table DDL has no inline `UNIQUE` on `token`, and the invite-token
lookup depends on it. Because the index is created in a separate statement from
the table, an interruption between the two would otherwise leave a table that a
retry skips (the table exists, so the `if (created)` branch no longer runs).
The prerequisite therefore ensures the index with
`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_token ON org_invites(token)`
**on every run when `org_invites` exists** — idempotent when the index is already
there, and fail-closed when the table already holds duplicate tokens (the
`CREATE` fails, the error propagates, and 002 is not recorded). No row is ever
deleted to force the index.

## Quick path

1. `node scratch/verify_legacy_upgrade.js` — the isolated repair harness (RED →
   GREEN).
2. `node scratch/verify_migrations.js` — the shared-runner regression harness.
3. `git diff --check`.

## Checklist

- [ ] A pre-2.9 database (001 recorded, newer tables missing) boots and 002 applies.
- [ ] A retry of a previously failed 002 repairs without re-running 001.
- [ ] A retry interrupted between `CREATE TABLE org_invites` and its unique index
      still enforces token uniqueness (duplicate-token INSERT rejected, no extra
      row), and a pre-existing duplicate-token table fails closed (002 not
      recorded, no rows deleted).
- [ ] `upTo:001` on an already-adopted database creates no newer tables and logs
      nothing; a custom registry reusing the 001/002 version strings never runs
      the real repair.
- [ ] An injected prerequisite DDL failure surfaces, records no 002, preserves
      001 history/data, and a later corrected retry succeeds.
- [ ] Planted rows survive byte-for-byte; applied history (`applied_at`,
      `checksum`) is unchanged.
- [ ] Fresh/current/custom/`upTo`/`migrationStatus` behaviour is unchanged.

## Known limitations (out of scope, pre-existing)

- Two 3.3.0 columns (`users.email_verified`, `users.verify_token`) are only
  added by 001-baseline and are not backfilled by 002, so an *adopted* legacy
  database never receives them. They are feature-level (self-service signup),
  not boot-level, and were never part of the reported failure.
- The cross-era performance indexes `idx_pages_organization` and
  `idx_api_keys_organization` (on columns 002 adds) are not recreated for an
  adopted database — a minor perf gap, not a correctness issue.
- A database older than 2.2.0 (before multigroup) may also lack
  `components.group_id`; 002's first backfill references it. That era is
  separate from this repair and was not the reported failure.
