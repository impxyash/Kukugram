# API Boundary Inventory

> Status: implementation-derived inventory, not yet a generated or complete machine-readable API contract.
>
> Source baseline: `feature/privacy-controls` at `3d0d3fe0892145a96e61e2c7f3063e7b2559f78b`.
> Inspected sources: `apps/api/src/app.ts`, `apps/api/src/modules/identity/routes.ts`, and `apps/api/src/modules/social/routes.ts`.
> All social and identity paths below are mounted beneath `/v1`.

## Runtime and error boundary

- API framework: Fastify 5; database access: PostgreSQL through `pg` and Drizzle package initialization.
- Health endpoint: `GET /health`; response contains `status: "ok"` and a request ID.
- OpenAPI UI is mounted at `/documentation`.
- The shared error handler emits `application/problem+json` with `type`, `title`, `status`, optional `detail`, `instance`, and `requestId`.
- Zod/Fastify validation errors are mapped to HTTP 400. Explicit application errors below 500 retain their status; other errors map to 500.
- The current handler logs the raw error object. No claim is made here that its serializers redact all sensitive PostgreSQL or application metadata.
- Authentication uses an opaque session token in an HTTP-only cookie. Production cookies are Secure and SameSite=Lax. Sessions are stored as token hashes and have a 30-day expiry in the current signup/login handlers.
- `GET /v1/auth/providers` currently reports password sign-in enabled and an empty OAuth provider list.

## Identity and account

| Method | Path | Access boundary | Verified behavior |
|---|---|---|---|
| GET | `/v1/auth/providers` | Public | Returns password and OAuth provider availability. |
| POST | `/v1/auth/signup` | Public | Validates email, password (12–128 chars), handle (3–30 lowercase alphanumeric/underscore), display name (1–60), optional bio (max 500); creates user/profile/session; returns 201. |
| POST | `/v1/auth/login` | Public | Validates email/password; creates a session on success; invalid credentials return 401. |
| POST | `/v1/auth/logout` | Cookie optional | Revokes the presented session if present, clears cookie, returns 204. |
| GET | `/v1/me` | Authenticated | Returns the current user's profile. |
| PATCH | `/v1/me/profile` | Authenticated | Accepts optional displayName, bio, avatarUrl, and privacy updates. |

## Profiles and social graph

| Method | Path | Access boundary | Verified behavior |
|---|---|---|---|
| GET | `/v1/users/search?q=...` | Authenticated | Search query required (1–60 chars); fixed maximum of 20 results. |
| GET | `/v1/users/:handle` | Public; viewer context optional | Returns profile metadata; blocked or missing profiles return 404. |
| POST | `/v1/users/:handle/follow` | Authenticated | Creates pending request for private profiles, accepted follow otherwise. |
| DELETE | `/v1/users/:handle/follow` | Authenticated | Removes current user's follow relationship; returns 204. |
| GET | `/v1/me/follow-requests` | Authenticated | Lists pending incoming requests; fixed maximum of 100. |
| POST | `/v1/me/follow-requests/:handle/accept` | Authenticated | Accepts a pending request addressed to the current user; returns 204. |
| DELETE | `/v1/me/follow-requests/:handle` | Authenticated | Declines a pending request addressed to the current user; returns 204. |
| GET | `/v1/me/blocked` | Authenticated | Lists blocked profiles; fixed maximum of 200. |
| POST | `/v1/users/:handle/block` | Authenticated | Creates a block relationship; returns 204. |
| DELETE | `/v1/users/:handle/block` | Authenticated | Removes a block relationship; returns 204. |
| GET | `/v1/me/muted` | Authenticated | Lists muted profiles; fixed maximum of 200. |
| POST | `/v1/users/:handle/mute` | Authenticated | Creates a mute relationship; returns 204. |
| DELETE | `/v1/users/:handle/mute` | Authenticated | Removes a mute relationship; returns 204. |

## Reports, appeals, moderation and audit

| Method | Path | Access boundary | Verified behavior |
|---|---|---|---|
| POST | `/v1/reports` | Authenticated | Creates a report; validates target type, UUID target, category and optional details. |
| GET | `/v1/me/reports` | Authenticated | Lists the current user's reports; fixed maximum of 100. |
| POST | `/v1/reports/:id/appeals` | Authenticated | Submits an appeal with 20–2,000 characters of details; returns 202. |
| GET | `/v1/me/appeals` | Authenticated | Lists the current user's appeals; fixed maximum of 100. |
| GET | `/v1/moderation/reports` | Moderator or admin | Optional status and limit (1–100, default 50). |
| GET | `/v1/moderation/reports/:id` | Moderator or admin | Reads a moderation case detail. |
| PATCH | `/v1/moderation/reports/:id` | Moderator or admin | Changes report status; writes an audit event. |
| GET | `/v1/moderation/appeals` | Moderator or admin | Lists open appeals; fixed maximum of 100. |
| GET | `/v1/moderation/appeals/:id` | Moderator or admin | Reads appeal detail. |
| PATCH | `/v1/moderation/appeals/:id` | Moderator or admin | Accepts or rejects an appeal; writes an audit event. |
| GET | `/v1/moderation/roles` | Admin | Lists moderator roles. |
| POST | `/v1/moderation/roles` | Admin | Grants a moderator role; writes an audit event. |
| DELETE | `/v1/moderation/roles/:userId/:role` | Admin | Revokes a moderator role; writes an audit event. |
| GET | `/v1/moderation/audit` | Admin | Optional reportId and limit (1–100, default 50); returns redacted event metadata. |
| POST | `/v1/moderation/audit/resolve-actor` | Authenticated, then admin and password step-up | Requires actorRef UUID, reason (20–500 chars), and password; records resolution outcomes in the access log. |

## Content and notifications

| Method | Path | Access boundary | Verified behavior |
|---|---|---|---|
| GET | `/v1/feed` | Authenticated | Returns up to 50 feed posts. |
| POST | `/v1/posts` | Authenticated | Creates a text post; body is 1–2,000 characters; returns 201. |
| DELETE | `/v1/posts/:id` | Authenticated | Deletes the caller's post; returns 204. |
| POST | `/v1/posts/:id/like` | Authenticated | Adds a like. |
| DELETE | `/v1/posts/:id/like` | Authenticated | Removes a like; returns 204. |
| GET | `/v1/posts/:id/comments` | Viewer context optional | Reads comments subject to post visibility checks. |
| POST | `/v1/posts/:id/comments` | Authenticated | Creates a comment; body is 1–1,000 characters; returns 201. |
| GET | `/v1/notifications` | Authenticated | Lists up to 50 notifications. |
| POST | `/v1/notifications/read` | Authenticated | Applies the current implementation's notification-read operation. |

## Contract gaps and implementation constraints

1. Most route schemas are parsed inline with Zod and are not attached to Fastify's OpenAPI route schemas. The current Swagger document therefore must not be treated as a complete contract.
2. Several response types are inferred from SQL row shapes rather than declared public response schemas. A generated contract needs explicit response schemas and tests before clients rely on it.
3. Existing list endpoints generally use fixed LIMIT values; cursor/offset pagination is not implemented in the inspected handlers. Do not document cursor pagination.
4. The profile avatar field accepts a URL. There is no verified upload, object-storage, image-processing, or signed-delivery pipeline.
5. The inspected route module does not implement direct messaging, realtime WebSockets, or push notification delivery.
6. The current authentication limiter is a process-local in-memory Map (10 attempts per IP per endpoint in a 15-minute window), not a distributed Redis limiter.
7. Fastify does not explicitly configure `trustProxy` in the inspected app initialization. Do not rely on forwarded client-IP headers until the ingress trust chain is verified.
8. The audit identity resolver uses the ordinary API pool in the inspected implementation. Dedicated resolver-role isolation has not been demonstrated.
9. Anonymous attempts to call the audit identity resolution route are rejected by authentication before an access-log entry is written. Invalid authenticated requests can use a synthetic all-zero UUID as a placeholder actor reference; this is not a genuine actor identity.

## Next contract work

- Extract request schemas into reusable, exported Zod schemas without changing route behavior.
- Add explicit success and error response schemas to each route.
- Generate and snapshot the OpenAPI document in CI.
- Add contract tests for authentication requirements, status codes, validation, response redaction, and list limits.
- Keep behavior changes separate from contract extraction so each diff is reviewable.
