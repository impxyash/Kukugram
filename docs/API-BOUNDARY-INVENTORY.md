# API Boundary Inventory

> Implementation-derived inventory, not a complete machine-readable contract.
> Source baseline: `3d0d3fe0892145a96e61e2c7f3063e7b2559f78b`.
> Identity and social routes are mounted beneath `/v1`.

## Runtime and errors

- Framework: Fastify 5.
- Database: PostgreSQL through `pg`; Drizzle provides schema and migrations.
- Health: `GET /health`; returns `status: "ok"` and a request ID.
- OpenAPI UI: `/documentation`.
- Errors use `application/problem+json` with type, title, status,
  optional detail, instance, and requestId.
- Zod and Fastify validation errors map to HTTP 400.
- Explicit application errors below 500 retain their status.
- Other errors map to HTTP 500.
- The error handler currently logs raw error objects. Complete redaction has
  not been established.
- Sessions use opaque cookie tokens; only token hashes are stored.
- Production cookies are HttpOnly, Secure, and SameSite=Lax.
- Signup and login create sessions with a 30-day expiry.
- `GET /v1/auth/providers` currently reports password enabled and no OAuth
  providers.

## Identity and account

- `GET /v1/auth/providers` — public; reports configured sign-in providers.
- `POST /v1/auth/signup` — public; validates email (max 254), password
  (12–128), handle (3–30 lowercase letters, digits, underscore), display name
  (1–60), optional bio (max 500); creates account and session; returns 201.
- `POST /v1/auth/login` — public; validates email and password; invalid
  credentials return 401.
- `POST /v1/auth/logout` — cookie optional; revokes presented session,
  clears cookie, returns 204.
- `GET /v1/me` — authenticated; returns current profile.
- `PATCH /v1/me/profile` — authenticated; accepts optional displayName,
  bio, avatarUrl, and privacy.

## Profiles and social graph

- `GET /v1/users/search?q=...` — authenticated; query is 1–60 characters;
  maximum 20 results.
- `GET /v1/users/:handle` — public with optional viewer context; unavailable
  or blocked profiles return 404.
- `POST /v1/users/:handle/follow` — authenticated; private profiles create
  pending requests; public profiles create accepted follows.
- `DELETE /v1/users/:handle/follow` — authenticated; removes current follow.
- `GET /v1/me/follow-requests` — authenticated; maximum 100 pending requests.
- `POST /v1/me/follow-requests/:handle/accept` — authenticated; accepts
  an incoming request; returns 204.
- `DELETE /v1/me/follow-requests/:handle` — authenticated; declines request;
  returns 204.
- `GET /v1/me/blocked` — authenticated; maximum 200 profiles.
- `POST /v1/users/:handle/block` — authenticated; creates a block.
- `DELETE /v1/users/:handle/block` — authenticated; removes a block.
- `GET /v1/me/muted` — authenticated; maximum 200 profiles.
- `POST /v1/users/:handle/mute` — authenticated; creates a mute.
- `DELETE /v1/users/:handle/mute` — authenticated; removes a mute.

## Reports, appeals, moderation, and audit

- `POST /v1/reports` — authenticated; validates target type, UUID, category,
  and optional details (max 1,000); returns 202.
- `GET /v1/me/reports` — authenticated; maximum 100 reports.
- `POST /v1/reports/:id/appeals` — authenticated; details are 20–2,000
  characters; returns 202.
- `GET /v1/me/appeals` — authenticated; maximum 100 appeals.
- `GET /v1/moderation/reports` — moderator or admin; optional status and
  limit (1–100, default 50).
- `GET /v1/moderation/reports/:id` — moderator or admin; reads case detail.
- `PATCH /v1/moderation/reports/:id` — moderator or admin; changes status
  and writes an audit event.
- `GET /v1/moderation/appeals` — moderator or admin; maximum 100 open appeals.
- `GET /v1/moderation/appeals/:id` — moderator or admin; reads appeal detail.
- `PATCH /v1/moderation/appeals/:id` — moderator or admin; reviews appeal
  and writes an audit event.
- `GET /v1/moderation/roles` — admin; lists moderator roles.
- `POST /v1/moderation/roles` — admin; grants a role and writes an audit event.
- `DELETE /v1/moderation/roles/:userId/:role` — admin; revokes a role.
- `GET /v1/moderation/audit` — admin; optional reportId and limit
  (1–100, default 50); returns selected audit metadata.
- `POST /v1/moderation/audit/resolve-actor` — authenticated, admin-only
  after password step-up; requires actorRef UUID, reason (20–500), and
  password; records resolution outcomes.

## Content and notifications

- `GET /v1/feed` — authenticated; maximum 50 posts.
- `POST /v1/posts` — authenticated; text body is 1–2,000 characters;
  returns 201.
- `DELETE /v1/posts/:id` — authenticated; deletes caller's post; returns 204.
- `POST /v1/posts/:id/like` — authenticated; adds a like and returns
  `{ liked: true }`.
- `DELETE /v1/posts/:id/like` — authenticated; removes a like; returns 204.
- `GET /v1/posts/:id/comments` — public with optional viewer context;
  checks post visibility.
- `POST /v1/posts/:id/comments` — authenticated; body is 1–1,000
  characters; returns 201.
- `GET /v1/notifications` — authenticated; maximum 50 notifications.
- `POST /v1/notifications/read` — authenticated; marks all unread
  notifications for the current user as read; returns `{ ok: true }`.

## Contract and implementation gaps

1. Most request schemas are parsed inline with Zod and are not attached to
   Fastify route schemas. The generated Swagger document is incomplete.
2. Several response types are inferred from SQL row shapes. Explicit public
   response schemas and contract tests are still needed.
3. Lists use fixed SQL limits or a bounded limit parameter. Cursor and offset
   pagination are not implemented in the inspected handlers.
4. The avatar field accepts a URL. No secure upload, object storage,
   image processing, or signed delivery pipeline was found.
5. The inspected routes do not implement direct messaging, realtime
   WebSockets, or push notification delivery.
6. Authentication limiting uses a process-local Map: 10 attempts per endpoint
   in 15 minutes, keyed by `request.ip`. This is not a distributed limiter.
7. Fastify does not explicitly configure `trustProxy`. The effective
   `request.ip` behind Railway ingress is unverified; do not trust arbitrary
   forwarded headers.
8. The audit identity resolver uses the ordinary API pool. Dedicated
   resolver-role isolation has not been demonstrated.
9. Anonymous audit-resolution requests are rejected before access logging.
   Invalid authenticated requests can use an all-zero UUID placeholder;
   it is not a genuine actor reference.

## Next contract work

- Extract reusable request schemas without changing route behavior.
- Add explicit success and error response schemas.
- Generate and snapshot the OpenAPI document in CI.
- Add tests for access control, validation, status codes, response redaction,
  and list limits.
- Keep contract extraction separate from behavior changes.
