# Database migration and rollback policy

## Migration model

Kukugram uses ordered SQL migrations in `packages/database/drizzle/` and the Drizzle migrator entry point in `packages/database/src/migrate.ts`. The repository does not currently provide paired down-migration scripts or an automated schema rollback command.

Treat the migration stream as **forward-only**:

- Once a migration has been applied in a shared environment, do not edit or reorder that migration.
- Correct an applied migration with a new, reviewed forward migration.
- Do not delete migration-journal records or replay SQL manually to make an older application version appear compatible.
- Keep schema changes backward-compatible with the currently running application whenever possible.

## Required release procedure

Before applying a migration to a production environment:

1. Record the currently deployed application revision and migration state.
2. Take a verified database backup using the approved infrastructure procedure. Confirm that restore access and retention are available.
3. Restore a recent backup or representative prior-release snapshot into a **disposable, isolated** PostgreSQL instance.
4. Run the exact candidate migration sequence against that snapshot, not only against an empty database.
5. Verify constraints, indexes, row counts, critical queries, and application compatibility against the upgraded snapshot.
6. Prefer an expand/migrate/contract rollout: add compatible schema first, deploy code that can operate during the transition, backfill if needed, and remove obsolete schema only in a later release.
7. Apply the migration through the approved deployment process and verify application health and critical flows.

The current CI PostgreSQL job applies the ordered SQL files to a fresh PostgreSQL 16 database and runs integration tests. This validates the fresh-install path; it does **not** replace an upgrade rehearsal from a prior-release database snapshot. Add that upgrade-path coverage before launch and before introducing destructive or compatibility-breaking migrations.

## Rollback and recovery

Application rollback and database rollback are separate decisions:

- Rolling back application code is acceptable only when the old application revision is known to be compatible with the already-upgraded schema.
- There is no automatic database down migration. If a migration has been applied, prefer a reviewed forward-fix migration.
- If data or schema corruption requires restoration, stop the rollout and use the approved backup-restore procedure in an isolated recovery environment first. Validate the restored data and application compatibility before any production cutover.
- Do not attempt an in-place destructive reversal, remove migration-journal entries, or replay old migrations as an emergency shortcut.

Every destructive migration requires an explicit recovery plan, a tested backup restore, and a documented owner/approval before release.

## Immutable moderation audit references

Migration `0005_immutable_audit_references.sql` removes foreign keys from `moderation.audit_events` so account or report deletion cannot mutate or block immutable historical audit records. After that migration, historical UUID references may legitimately point to rows that no longer exist.

Re-adding those foreign keys is not a safe automatic rollback: dangling historical references can make constraint creation fail, while `ON DELETE SET NULL` would reintroduce mutation of immutable audit rows. Do not restore those constraints as a rollback step. Any future change to this retention model requires a separately reviewed audit-history design and migration plan.

## Environment safety

Migration validation and rollback rehearsals must use disposable databases or isolated restored snapshots. Never point CI, local development, or migration experiments at production PostgreSQL or Redis volumes.
