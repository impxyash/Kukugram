# Audit Role Isolation Status

## Verified migration behavior

The migration chain currently present in the remote feature branch includes
`0007_moderation_audit_actor_refs.sql` and
`0008_moderation_audit_identity_resolution.sql`.

- Migration 0007 revokes all privileges on
  `moderation.audit_actor_identity_map` from PUBLIC and creates
  `moderation.resolve_audit_actor_ref(uuid, varchar)` as SECURITY DEFINER with
  `search_path = pg_catalog, moderation`.
- Migration 0007 does not revoke the default PUBLIC EXECUTE privilege on that
  resolver function. The isolated PostgreSQL test verifies that PUBLIC EXECUTE
  is present immediately after applying the migration chain.
- Migration 0008 revokes PUBLIC privileges on the append-only resolution log
  table, the identity resolver function, and the log trigger function.
- Migration 0008's identity resolver is SECURITY DEFINER with a fixed
  `pg_catalog, moderation` search path.
- The resolution log's trigger rejects UPDATE and DELETE.

## Automated isolation test

`apps/api/src/audit-role-isolation.postgres.test.ts` creates a disposable
PostgreSQL database, applies the checked-out SQL migrations, and creates two
separate LOGIN roles with generated test-only passwords:

- `kg_acl_app_*`: ordinary application principal.
- `kg_acl_resolver_*`: restricted audit resolver principal.

The test connects as each role independently and verifies that both are
non-superusers. The ordinary app role cannot execute either resolver or read
the protected mapping/log tables. The resolver role can execute the two
SECURITY DEFINER resolver functions but cannot directly read the mapping or
resolution-log tables. It also verifies that the append-only trigger blocks
both UPDATE and DELETE.

The test never connects to Railway or uses production credentials.

## What this does not prove or implement

- No production role provisioning has been applied or verified.
- The API still uses one PostgreSQL pool; no dedicated resolver connection is
  wired into the application.
- The resolver-role grants exercised by the test are a least-privilege design
  fixture, not a production deployment configuration.
- Migration 0007's PUBLIC EXECUTE grant must be explicitly revoked in a
  production role-provisioning migration before exposing a least-privilege
  application principal.
- The five existing actor-reference call sites remain in place; they must all
  be supported when the API moves to a restricted resolver connection.
- The current audit-resolution route requires an authenticated viewer before
  writing its access log. Its invalid-request path still substitutes a
  synthetic zero UUID when actorRef is missing or malformed. Anonymous audit
  attempts and nullable actor attribution are therefore not yet implemented
  by the remote route/migration chain.

Do not apply ACL changes to production until the production database owner,
application role, migration role, resolver role, grants, pool wiring, and all
five actor-reference call sites have been reconciled and tested in a disposable
database. Railway production remains read-only.
