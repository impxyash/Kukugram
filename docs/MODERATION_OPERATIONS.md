# Moderation operations

## First-admin provisioning

Kukugram deliberately has **no public bootstrap, self-promotion, or unauthenticated role-grant endpoint**. The first administrator must be provisioned by an authorized infrastructure/database operator through a trusted PostgreSQL administrative session after the application has been deployed and the target account has been verified.

1. Have the intended administrator create and verify a normal Kukugram account.
2. Verify the account identity out-of-band with the operator. Do not accept an email address supplied only in an unverified support request.
3. Connect using the approved production database access path and a privileged operator identity. Never put database credentials in source control, chat, shell history, or an application request.
4. Resolve the verified account to its UUID and confirm it is active:

```sql
SELECT id, email, is_active
FROM identity.users
WHERE lower(email) = lower('<verified-account-email>');
```

5. In a transaction, grant the admin role only to that verified UUID and write a bootstrap audit event:

```sql
BEGIN;

INSERT INTO moderation.moderator_roles (user_id, role, granted_by)
SELECT id, 'admin', NULL
FROM identity.users
WHERE id = '<verified-user-uuid>'
  AND is_active = true
ON CONFLICT (user_id, role) DO NOTHING;

INSERT INTO moderation.audit_events (id, actor_id, action, subject_user_id, details)
SELECT gen_random_uuid(), NULL, 'moderator.initial_admin_provisioned', id,
       jsonb_build_object('provisioning', 'trusted_operator')
FROM identity.users
WHERE id = '<verified-user-uuid>'
  AND is_active = true
  AND EXISTS (
    SELECT 1 FROM moderation.moderator_roles
    WHERE user_id = identity.users.id AND role = 'admin'
  );

COMMIT;
```

6. Verify the resulting role and audit event using a read-only query, then close the privileged session. Keep a record of the operator/change ticket outside the application database.

Replace both placeholders with values verified directly by the operator. Run the provisioning transaction once; do not turn it into a reusable application endpoint. If the target account is inactive or the UUID is not found, stop and investigate instead of broadening the query.

## Role model

- `moderator`: may read the report queue, change report status, and review appeals.
- `admin`: may do all moderator work, manage moderator/admin assignments, and read the moderation audit log.
- Role checks are performed by the API against `moderation.moderator_roles`; a client-side flag is never an authorization boundary.
- Role changes are made through authenticated admin-only API routes and are recorded in the audit log.
- The API prevents an administrator from revoking their own admin role. Maintain at least two independently verified administrators for operational continuity.

## Audit log

The purpose-scoped audit actor mapping lives in `moderation.audit_actor_identity_map`, separate from immutable events. Public table privileges are revoked; the API writes references through `moderation.resolve_audit_actor_ref` and the ordinary audit response exposes only the opaque reference. Production must use a dedicated, non-owner runtime database role that cannot SELECT the mapping table; grant that role only the function execution privilege it needs. The migration/owner role must remain separate from the application runtime role. The current repository does not provision or verify production database roles, so this separation is a launch prerequisite, not a claim that the current deployment is already isolated.

### Audit identity resolution

The `POST /v1/moderation/audit/resolve-actor` endpoint is admin-only and requires the current account password as step-up authentication plus a 20–500 character reason. Failed role checks, invalid requests, failed step-up checks, successful resolutions, and unknown references are written to `moderation.audit_identity_resolution_log`; UPDATE and DELETE are rejected by a database trigger. The ordinary audit endpoint does not expose this access log or resolved identities. The endpoint uses the dedicated SECURITY DEFINER resolver function, whose EXECUTE privilege is revoked from PUBLIC. Production must provision a separate resolver database role, grant EXECUTE only to the API runtime identity-resolution service role, and keep that role separate from ordinary API and migration roles. Do not grant the general runtime role direct SELECT on `moderation.audit_actor_identity_map`.

Password re-entry is the current step-up factor; production should add MFA/WebAuthn step-up before enabling this endpoint for live operations. The mapping and resolution log are not KMS-encrypted by this migration. A managed KMS/HSM-backed envelope-encryption design, key rotation, recovery and audited break-glass procedure remain production dependencies.

The application treats moderation audit events as append-only. A database trigger rejects UPDATE and DELETE statements. Keep database ownership and privileges restricted to trusted operators; the trigger is defense in depth, not protection against a database owner or superuser deliberately disabling it. Backups and external retention controls should be considered for production.

Report status changes, appeal submissions/reviews, and role grants/revocations must be committed in the same transaction as their corresponding audit event. Review production database permissions before launch so the runtime application role cannot alter or truncate the audit table or disable its trigger.

## Operational safeguards

- Never expose first-admin provisioning as a public route, signup option, environment-variable shortcut, or client-side control.
- Do not grant roles based only on a submitted username/email; verify the account out-of-band.
- Review role assignments and audit events periodically.
- Do not manually edit audit rows to correct mistakes; append a new explanatory event through an approved operator procedure.
- Test migrations and moderation flows against disposable databases before applying them to production.
