# API Contract Package Status

## Current state

`@kukugram/api-contract` is an additive shared contract package backed by Zod.
It currently exports request schemas, response schemas, and inferred TypeScript
types for the first audited set of API operations.

Covered request areas include:

- Signup and login.
- Profile updates.
- Post and comment creation.
- User search.
- Report creation and appeal submission.
- Moderation report and appeal review.
- Moderator role management.
- Audit actor resolution.
- Moderation list query parameters and common UUID/handle parameters.

Covered response areas include:

- Problem Details errors and health checks.
- Authentication providers and profile data.
- Feed posts and user search.
- Comments and notifications.
- Blocked/muted account lists and follow requests.
- Report and appeal creation.
- Like and notification-read acknowledgements.
- Moderation mutations, audit actor resolution, report/appeal summary and detail rows, moderator roles, and audit event rows.

## Verification

- Contract tests exercise validation bounds, nullable fields, query coercion,
  strict audit-resolution input, and representative response shapes.
- The package has independent typecheck, lint, and Vitest scripts.
- CI runs these scripts through the workspace recursive commands.

## Important limitations

1. These schemas are not yet attached to Fastify route definitions.
2. Existing route handlers still parse their inline Zod schemas. Those inline
   schemas remain the runtime source of truth until the protected local route
   file is reconciled.
3. The web client now consumes shared inferred response types for its current user, post, notification, comment, follow-request, account-control, report and appeal models. The API runtime still uses its inline Zod parsers.
4. Response schemas cover a selected set of observed response shapes; they do
   not constitute a complete API contract.
5. Fastify Swagger output is still incomplete because most routes do not
   declare request/response JSON schemas.
6. No complete OpenAPI document or committed OpenAPI snapshot is claimed yet.

## Safe adoption sequence

1. Reconcile the user's protected local route file before changing route code.
2. Compare every shared request schema against the exact inline route schema.
3. Replace duplicated inline schemas incrementally, preserving all parsing,
   defaults, transforms, status codes, and authorization behavior.
4. Keep the web app on shared inferred types and add runtime response validation only where it is explicitly required.
5. Add Fastify route schemas for documented success and error responses.
6. Generate OpenAPI from the actual registered routes, not a hand-written
   endpoint list.
7. Snapshot the generated OpenAPI document and fail CI on unreviewed changes.
