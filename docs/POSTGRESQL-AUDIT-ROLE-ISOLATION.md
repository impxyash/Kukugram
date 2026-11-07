# PostgreSQL Audit Resolver Role Isolation

## Disposable PostgreSQL evidence

The integration test
`apps/api/src/audit-role-isolation.postgres.test.ts` creates a uniquely named
temporary database using `TEST_DATABASE_URL`, applies the repository's SQL
migrations, creates temporary NOLOGIN roles, and drops the database and roles
after the test. It does not connect to or modify Railway production.

On a fresh PostgreSQL 16 database using the CI PostgreSQL superuser:

- Migration 0007 creates `moderation.resolve_audit_actor_ref(uuid, varchar)`
  as a SECURITY DEFINER function.
- Its configured search path is `pg_catalog, moderation`.
- Migration 0007 does not revoke the default PUBLIC EXECUTE privilege.
  The disposable-database test confirms PUBLIC EXECUTE is present under the
  PostgreSQL 16 CI default ACLs.
- The identity-map table itself has PUBLIC privileges revoked by migration
  0007.

The test then applies a fixture-only least-privilege policy:

- The ordinary application role has schema USAGE but no resolver-function
  EXECUTE and no direct SELECT or INSERT on the identity-map table.
- The dedicated resolver role has schema USAGE and function EXECUTE, but no
  direct SELECT or INSERT on the identity-map table.
- The ordinary application role receives PostgreSQL insufficient-privilege
  error 42501 when it calls the resolver function.
- The resolver role can call the SECURITY DEFINER function and create a
  purpose-scoped mapping without direct table privileges.

## What this proves—and what it does not

This verifies the migration's default ACL behavior on a fresh disposable
PostgreSQL 16 instance and proves the proposed role split can enforce
function-level access while keeping the mapping table private.

It does not establish the ACLs, owners, default privileges or grants in
Railway production. Production was not inspected or modified.

The repository does not yet provision dedicated migration, application,
audit-owner or audit-resolver roles. The API currently uses one PostgreSQL
pool, and five existing moderation audit call sites still invoke
`resolve_audit_actor_ref` through that application pool.

## Required safe implementation sequence

1. Preserve the five existing audit actor-reference call sites and their
   transaction boundaries.
2. Define and provision distinct non-superuser migration, application,
   audit-owner and audit-resolver roles in a reviewed migration/operations
   plan.
3. Add a dedicated resolver connection/pool and move all five call sites to
   that pool without changing audit semantics.
4. Add fresh-install and upgrade-path tests for role ownership, PUBLIC
   EXECUTE revocation, explicit resolver grants, direct table denial and
   function execution under the intended roles.
5. Verify the actual deployment ACLs through an approved read-only procedure
   before considering any production change.
6. Only then consider revoking PUBLIC EXECUTE in a migration. Do not blindly
   revoke it while current application call sites still depend on the
   existing shared pool.

Railway production remains strictly read-only during this development work.
