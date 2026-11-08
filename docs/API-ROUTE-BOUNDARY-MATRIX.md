# API Route Boundary Matrix

Implementation-derived inventory of the registered API handlers on
`feature/privacy-controls`. This is a review aid, not an OpenAPI document.
The route implementations remain the runtime source of truth. The matrix covers
43 registered handlers: 42 in the social module and one provider-discovery
handler in the identity module.

## Global behavior

- API prefix: `/v1`; health is `/health`.
- Provider discovery is `GET /v1/auth/providers`.
- Session authentication reads the opaque session cookie and checks that the
  session is not revoked or expired and that the user is active.
- `requireViewer` returns 401 when no valid session exists.
- `requireModerationRole` first requires a valid session, then returns 403
  unless the user has one of the requested roles.
- Unless a handler explicitly sets another success status, Fastify's default
  success status is 200.
- The global error handler returns `application/problem+json`. Validation
  failures are 400; application errors can include 401, 403, 404, and 409;
  auth rate limits return 429, Redis/IP-resolution outages return 503, and
  unclassified errors become 500. The Problem Details response contains
  `type`, `title`, `status`, optional `detail`, `instance`, and
  `requestId`.
- Collection limits below are fixed SQL limits or validated query limits,
  except `GET /feed`, which supports opaque cursor pagination. Other collection
  handlers do not yet expose cursor pagination.

## Identity and session

| Method and path       | Access                                    | Request boundary                                                                                                                                                   | Success response                                                                                     |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| GET `/auth/providers` | Public                                    | None                                                                                                                                                               | 200: `{ password: boolean, oauth: string[] }`; currently password is enabled and OAuth list is empty |
| POST `/auth/signup`   | Public                                    | email valid/max 254; password 12–128; handle trimmed/lowercased and 3–30 lowercase alphanumeric/underscore; displayName trimmed 1–60; optional bio trimmed max 500 | 201: `{ user: ProfileRow }`; duplicate email/handle can return 409                                   |
| POST `/auth/login`    | Public                                    | email valid/max 254; password 1–128                                                                                                                                | 200: `{ user: ProfileRow }`; invalid credentials return 401                                          |
| POST `/auth/logout`   | Public; revokes cookie session if present | Cookie only                                                                                                                                                        | 204                                                                                                  |
| GET `/me`             | Authenticated                             | None                                                                                                                                                               | 200: `{ user: ProfileRow }`                                                                          |
| PATCH `/me/profile`   | Authenticated                             | Optional displayName 1–60; bio nullable/max 500; avatarUrl nullable/URL/max 2048; privacy enum                                                                     | 200: `{ user: ProfileRow }`                                                                          |

## Social graph and account controls

| Method and path                           | Access           | Request boundary                     | Success response                                         |
| ----------------------------------------- | ---------------- | ------------------------------------ | -------------------------------------------------------- |
| GET `/users/search`                       | Authenticated    | `q`: trimmed string 1–60             | 200: `{ users: ProfileRow[] }`; fixed limit 20           |
| GET `/users/:handle`                      | Optional session | handle string, lowercased by handler | 200: `{ user: ProfileRow }`; 404 when unavailable        |
| POST `/users/:handle/follow`              | Authenticated    | handle string                        | 200: `{ user: ProfileRow }`                              |
| GET `/me/follow-requests`                 | Authenticated    | None                                 | 200: `{ requests: FollowRequestRow[] }`; fixed limit 100 |
| POST `/me/follow-requests/:handle/accept` | Authenticated    | handle string                        | 204                                                      |
| DELETE `/me/follow-requests/:handle`      | Authenticated    | handle string                        | 204                                                      |
| DELETE `/users/:handle/follow`            | Authenticated    | handle string                        | 204                                                      |
| GET `/me/blocked`                         | Authenticated    | None                                 | 200: `{ users: AccountControlRow[] }`; fixed limit 200   |
| GET `/me/muted`                           | Authenticated    | None                                 | 200: `{ users: AccountControlRow[] }`; fixed limit 200   |
| POST `/users/:handle/block`               | Authenticated    | handle string                        | 204                                                      |
| DELETE `/users/:handle/block`             | Authenticated    | handle string                        | 204                                                      |
| POST `/users/:handle/mute`                | Authenticated    | handle string                        | 204                                                      |
| DELETE `/users/:handle/mute`              | Authenticated    | handle string                        | 204                                                      |

## Reports, appeals and moderation

| Method and path                          | Access                                              | Request boundary                                                                                                                                                    | Success response                                                                          |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET `/me/reports`                        | Authenticated                                       | None                                                                                                                                                                | 200: `{ reports: ReportSummary[] }`; fixed limit 100                                      |
| GET `/moderation/reports`                | Moderator or admin                                  | status optional enum open/reviewing/resolved/dismissed; limit integer 1–100, default 50                                                                             | 200: `{ reports: ModerationReportSummary[] }`                                             |
| GET `/moderation/reports/:id`            | Moderator or admin                                  | id UUID                                                                                                                                                             | 200: `{ report: ModerationReportDetail }`; 404 if missing                                 |
| PATCH `/moderation/reports/:id`          | Moderator or admin                                  | id UUID; body status enum reviewing/resolved/dismissed                                                                                                              | 200: `{ reportId, status }`; 404/409 on invalid state                                     |
| POST `/reports/:id/appeals`              | Authenticated report owner                          | id UUID; details trimmed 20–2000                                                                                                                                    | 202: `{ appealId, status: "open" }`; 404/409 when report cannot be appealed               |
| GET `/me/appeals`                        | Authenticated                                       | None                                                                                                                                                                | 200: `{ appeals: AppealSummary[] }`; fixed limit 100                                      |
| GET `/moderation/appeals`                | Moderator or admin                                  | None                                                                                                                                                                | 200: `{ appeals: AppealQueueItem[] }`; fixed limit 100                                    |
| GET `/moderation/appeals/:id`            | Moderator or admin                                  | id UUID                                                                                                                                                             | 200: `{ appeal: AppealDetail }`; 404 if missing                                           |
| PATCH `/moderation/appeals/:id`          | Moderator or admin                                  | id UUID; body status accepted/rejected                                                                                                                              | 200: `{ appealId, status }`; 404/409 on invalid state                                     |
| GET `/moderation/roles`                  | Admin                                               | None                                                                                                                                                                | 200: `{ roles: ModeratorRoleRow[] }`                                                      |
| POST `/moderation/roles`                 | Admin                                               | userId UUID; role moderator/admin                                                                                                                                   | 201: `{ userId, role }`; 409 if inactive user or role already assigned                    |
| DELETE `/moderation/roles/:userId/:role` | Admin                                               | userId UUID; role moderator/admin                                                                                                                                   | 204; 404/409 for missing role or protected final/self admin                               |
| GET `/moderation/audit`                  | Admin                                               | reportId optional UUID; limit integer 1–100, default 50                                                                                                             | 200: `{ events: AuditEvent[] }`                                                           |
| POST `/moderation/audit/resolve-actor`   | Authenticated, then admin role and password step-up | Strict body: actorRef UUID, reason trimmed 20–500, password 1–128; unknown keys rejected                                                                            | 200: `{ userId }`; 400 invalid request, 403 role/step-up denied, 404 unresolved reference |
| POST `/reports`                          | Authenticated                                       | targetType profile/post/comment; targetId UUID; category harassment/spam/impersonation/self_harm/violence/nudity/copyright/other; optional details trimmed max 1000 | 202: `{ reportId, status }`; duplicate open/reviewing report returns existing case        |

## Content and notifications

| Method and path            | Access                                       | Request boundary             | Success response                                            |
| -------------------------- | -------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| GET `/feed`                | Authenticated                                | Optional `cursor`: canonical base64url JSON tuple `{ createdAt, id }`, max 512 chars; strict timestamp/UUID validation | 200: `{ posts: PostRow[], nextCursor?: string }`; keyset order `(created_at DESC, id DESC)`, 50 posts/page with 51-row lookahead; mute, block, deleted-post and profile-privacy filters apply |
| POST `/posts`              | Authenticated                                | body trimmed 1–2000          | 201: `{ post: PostRow }`                                    |
| DELETE `/posts/:id`        | Authenticated; author-only                   | id UUID                      | 204; 404 when unavailable/not owned                         |
| POST `/posts/:id/like`     | Authenticated                                | id UUID                      | 200: `{ liked: true }`                                      |
| DELETE `/posts/:id/like`   | Authenticated                                | id UUID                      | 204                                                         |
| GET `/posts/:id/comments`  | Optional session, subject to post visibility | id UUID                      | 200: `{ comments: CommentRow[] }`; no explicit SQL limit    |
| POST `/posts/:id/comments` | Authenticated                                | id UUID; body trimmed 1–1000 | 201: `{ id, body }`                                         |
| GET `/notifications`       | Authenticated                                | None                         | 200: `{ notifications: NotificationRow[] }`; fixed limit 50 |
| POST `/notifications/read` | Authenticated                                | None                         | 200: `{ ok: true }`                                         |

## Shared contract comparison and known gaps

The shared `@kukugram/api-contract` schemas currently mirror the five named
module-level body schemas (signup, login, profile, post, comment) and several
inline query/body schemas. These are currently additive; handlers continue to
parse their existing inline Zod schemas.

Before replacing any inline parser, verify exact equivalence, including:

- Zod transforms, defaults, nullable/optional behavior, unknown-key policy and
  coercion.
- Path parameter case normalization and UUID constraints.
- Response wrappers, nullable values, PostgreSQL count strings and timestamp
  serialization.
- Actual status codes, including 201, 202 and 204.
- Role and ownership checks; these are runtime authorization rules, not merely
  request-schema constraints.

Representative field-level contract tests now cover report and appeal summaries,
moderation detail wrappers, moderator role rows, audit event rows, follow-request
rows, account-control rows, profile lookup, and common response envelopes. These
are fixture-based schema tests, not generated from live SQL results; route-level
contract tests are still needed to detect drift between handler projections and
the shared package.

## OpenAPI status

Fastify Swagger is registered with API metadata, but most social routes do not
declare Fastify JSON schemas. The identity provider route is an existing
exception with a response schema. A complete OpenAPI document must not be
claimed until the route schemas are attached and the generated document is
checked against the actual handlers. The global Problem Details error handler
also needs explicit documented response schemas for applicable status codes.

## Scope exclusions

This inventory does not imply the existence of media upload/storage, direct
messaging, WebSockets, server-sent events or push-delivery endpoints. Those
remain separate implementation workstreams.
