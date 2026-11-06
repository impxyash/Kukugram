# Kukugram Technical Blueprint

## 1. Product Vision And User Experience

Kukugram is a creator-first, expressive social space for Gen-Z: a place to publish visual stories, discover niche communities, and build genuine audience relationships. Its identity should center on **Kuku Circles**: interest-led spaces and feed controls that let people intentionally tune what they see, rather than optimizing only for endless passive consumption.

The experience should feel quick, playful, accessible, and safe. Use an original visual language built around layered editorial cards, expressive motion, configurable profile "vibes," and clear user control over recommendations. Avoid copying interaction flows or visual treatments from incumbent social networks.

Core UX principles:

- Creation in under a minute: capture, edit, caption, tag, publish, or save a draft.
- Discovery with agency: explain recommendation reasons, provide "more/less like this" controls, and allow Circle-based feed switching.
- Social depth over vanity metrics: audience connection tools, conversation-friendly comments, and optional public like counts.
- Privacy and safety by default: audience selection at post time, age-aware protections, and frictionless block/report controls.
- Responsive and inclusive: keyboard support, semantic UI, captions, alt text, reduced-motion support, and WCAG 2.2 AA target.

Primary surfaces: Home, Discover, Create, Circles, Inbox, Activity, Profile, and Creator Studio. The mobile web app is the primary experience; desktop adds efficient creation, moderation, and creator-management workflows.

## 2. Complete Feature List

MVP features:

- Email/password and OAuth sign-in; onboarding; age gate; session management.
- Public or private accounts, profiles, follows, close-friends-style custom audiences, block and mute.
- Image/carousel posts and vertical short videos; drafts; captions, locations, mentions, hashtags, accessibility metadata, and audience controls.
- Likes, threaded comments, saves/collections, share links, repost-to-Circle concept, and view/impression analytics.
- Following and For You home feeds, basic personalized ranking, Explore, search, and hashtag pages.
- One-to-one and group direct messages with delivery/read state, media attachments, typing, and presence.
- In-app/push/email notifications with user preferences.
- Direct-to-storage uploads, media processing, CDN delivery, content reporting, automated safety checks, and human moderation queues.
- Admin dashboard, creator analytics, feature flags, audit logs, rate limits, and observability.

Post-MVP features:

- Public and invite-only Circles, collaborative collections, live rooms, scheduled publishing, and creator collaborations.
- Subscriptions, tips, paid digital products, brand campaigns, and an ad marketplace.
- Advanced recommendations, semantic search, multilingual localization, native applications, and federation only if product strategy later requires it.

## 3. Frontend Architecture

Use a Next.js App Router application written in strict TypeScript. Prefer React Server Components for read-heavy routes and server-side data loading; use Client Components only for interactive media controls, composer workflows, realtime state, and gesture-heavy UI.

- `app/` owns route segments, layouts, loading/error states, metadata, and authenticated route groups.
- A typed API client generated from the backend OpenAPI specification separates transport concerns from feature UI.
- Feature modules own screens, view models, schemas, hooks, and local components. A small shared design system owns primitives only.
- Tailwind CSS provides tokens and responsive styling; CSS variables provide theme/vibe customization. Framer Motion is reserved for intentional, reduced-motion-aware interaction transitions.
- Use optimistic updates for likes, saves, follows, message sends, and comment creation; reconcile with API responses and realtime events.
- Cache server-rendered public content with Next.js caching policy; keep personalized feed and session state non-shared. Use TanStack Query only for client-owned, live or paginated data when server components cannot own it.
- Validate forms with shared schema definitions where practical; never trust client validation as authorization.
- Deliver an installable PWA later if retention data supports it; keep browser APIs behind adapters so native clients can reuse API contracts.

## 4. Backend Architecture

Start as a modular TypeScript Node.js API deployed as a stateless service, not microservices. A modular monolith minimizes operational cost while preserving explicit domain boundaries for later extraction.

- Use Fastify for low-overhead HTTP, schema validation, and strong plugin composition. Expose versioned REST endpoints and OpenAPI documentation.
- Modules: identity, users, social-graph, content, media, feed, discovery, messaging, notifications, moderation, payments, administration, and shared platform services.
- Each module owns its routes/controllers, application services, domain rules, repositories, schemas, jobs, and tests. Cross-module interactions use explicit application interfaces and durable domain events.
- PostgreSQL is the system of record. Redis supports caching, limits, queues, presence, and short-lived state. Object storage contains media only.
- Use an outbox table and worker publisher to reliably turn committed domain events into background jobs and realtime notifications.
- Begin with one API deployment and one worker deployment; split high-load boundaries such as media processing, feeds, search indexing, and messaging only when measured load warrants it.

## 5. PostgreSQL Database Architecture

Use PostgreSQL 16+ with UTC `timestamptz`, UUIDv7 primary keys generated at the application boundary, `citext` for case-insensitive identifiers, and `jsonb` only for genuinely flexible attributes. Use migrations, never synchronization from ORM models.

- Organize tables in logical schemas: `identity`, `social`, `content`, `media`, `messaging`, `notifications`, `moderation`, `billing`, and `platform`.
- Every mutable entity has `created_at`, `updated_at`, and, where required, `deleted_at`; preserve immutable audit/event history separately.
- Enforce ownership and relationship invariants through foreign keys, unique constraints, check constraints, and transactions. Application code supplies business authorization.
- Use soft deletion for user-visible content with a retention job that hard-deletes after policy windows. Store immutable deletion/takedown records for compliance.
- Use read replicas for read-heavy public discovery later; writes, authorization-sensitive reads, and feed materialization stay on the primary until consistency controls are established.
- Partition very high-volume append-heavy tables by time when needed: events, notifications, impressions, message receipts, and moderation/audit logs.

## 6. Authentication And Authorization

Support password authentication and OAuth 2.0/OIDC providers such as Google and Apple. Passwords use Argon2id; OAuth identity links are unique per provider and subject.

- Use opaque, rotating session tokens stored only as hashes server-side. Browser session cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to `.kukugram.com` only where needed; API calls use cookie-based CSRF protections or a tightly scoped bearer-token flow for native clients.
- Separate short-lived access credentials from refresh/session credentials for non-browser clients. Revoke sessions on password change, suspected compromise, explicit logout, or administrator action.
- Require verified email for publishing, direct messaging, and creator payouts. Add risk-based step-up verification and optional TOTP/WebAuthn MFA before monetization expands.
- Apply role-based permissions (`user`, `creator`, `moderator`, `admin`, `support`) plus resource policies: account privacy, audience membership, relationship state, ownership, and moderation status.
- Enforce authorization in backend services for every resource action; frontend guards are usability enhancements only.

## 7. User Profiles

The `users` identity record is private and stable; `profiles` holds public presentation data. Profiles include unique handle, display name, bio, avatar, optional links, pronouns, location granularity, verified state, profile-vibe theme, account type, and counters.

- Handles are normalized and reserved-word protected; retain handle history to prevent impersonation and support redirects only after review.
- Privacy modes: public, private, and restricted creator. Private follow requests require approval; profile fields have field-level visibility rules.
- Provide profile tabs for posts, videos, collections, tagged content, and Circle activity according to privacy. Pin selected content and expose creator links when enabled.
- Counters are denormalized, eventually consistent displays; authoritative relations remain normalized.

## 8. Follow/Follower System

Use `social.follows(follower_id, followee_id, status, created_at, ...)` with a composite unique constraint. Status supports `pending`, `accepted`, and `removed`; a separate history/audit event captures changes.

- Public follows become accepted immediately; private accounts create pending requests. Blocked users cannot create or retain follow relationships.
- Transactionally update relationship state and outbox events; counter projections update asynchronously or transactionally where low contention permits.
- Support remove follower, approve/deny requests, suggested accounts, mutual-follow counts, and visibility-safe follower/following lists.
- Do not expose a user's relationship graph where privacy settings prohibit it.

## 9. Posts

Posts are a canonical content model with `post_type` values such as `image`, `carousel`, `video`, `text_card`, and later `collaboration`. Store caption, audience, publication status, scheduled time, location reference, accessibility text, comment policy, and moderation state.

- Keep media in `media.assets` and order it with `content.post_media`; do not embed storage keys directly in post fields.
- Publication states: `draft`, `processing`, `scheduled`, `published`, `limited`, `removed`, `archived`, and `deleted`.
- Validate caption, hashtag, mention, media count, aspect ratio, and audience rules at publish time. Resolve mentions/hashtags transactionally and enqueue downstream notifications/indexing.
- Allow edit history with a limited edit window, archive/unarchive, delete/restore during retention, and URL-safe public IDs/slugs independent from primary keys.

## 10. Short-Form Videos/Reels

Call the product surface **Loops** rather than copying competitor branding. Loops are vertical, immersive video posts with an original progression UI and Circle context.

- Require normalized H.264/H.265 video renditions and HLS adaptive playlists, poster images, captions/subtitles, duration, aspect ratio, audio metadata, and safety processing status.
- Player behavior includes adaptive bitrate, muted autoplay with explicit user controls, viewability-qualified view events, watch-progress telemetry, and accessible captions.
- Start with uploads of capped duration/size and a limited in-browser editor. Move sophisticated trimming, effects, remixes, licensed music, and automatic captions into later phases.
- Rank Loop candidates separately from image posts but blend them intentionally in Home; avoid an infinite full-screen-only interaction as the sole product experience.

## 11. Likes, Comments, Saves And Shares

- Use unique join tables for likes and saves, with idempotent create/delete endpoints. Maintain asynchronously projected counts.
- Comments support one level of reply nesting initially, mention notifications, creator pinning, delete/edit windows, comment permissions, keyword filters, and moderation state.
- Saves are private by default and can be organized in named collections. Never expose saved content to other users without an explicit future sharing feature.
- Shares include native share sheet, copy link, and internal share-to-message; record privacy-preserving aggregate share analytics, not invasive recipient tracking.
- All interaction endpoints publish domain events for counts, notifications, recommendation signals, and abuse analysis.

## 12. Home Feed And Recommendation System

Provide two explicit feeds: **Following** is chronological with small integrity/safety interventions; **For You** is personalized and explainable. A Circle filter scopes either feed to chosen interests or communities.

- Candidate sources: followed accounts, Circle affinity, topic/hashtag affinity, similar-content embeddings later, co-engagement, trending content, and editorial/safety-controlled inserts.
- MVP ranker: recency, follow strength, prior positive engagement, content quality, language/location relevance, creator diversity, and negative signals. Apply hard filters before scoring: blocks, mutes, privacy, age policy, removal state, deduplication, and exhaustion.
- Store impression, view, click, dwell, completion, like, save, follow, hide, and report signals as append-only events. Use delayed/aggregated data for ranking features to minimize direct feedback loops.
- Explain recommendations in plain language; offer not interested, hide creator, mute topic, and reset/tune feed controls. Define diversity, creator fairness, and safety metrics as ranking constraints.
- Begin with fan-out-on-read queries plus Redis candidate caches. Introduce hybrid fan-out and precomputed inboxes only for high-follower accounts after measured thresholds.

## 13. Explore And Search

Explore is a curated, topic-first discovery surface with popular Loops, emerging creators, hashtags, Circles, and culturally relevant collections. It should be region/language aware and must apply the same eligibility filters as feeds.

- MVP search uses PostgreSQL full-text search (`tsvector`) and trigram indexes for accounts, handles, captions, and hashtags.
- Use query classes: people, posts, Loops, hashtags, Circles, and later audio/place. Return typed, privacy-filtered results with cursor pagination.
- Add OpenSearch only when PostgreSQL relevance, index volume, or aggregation needs are demonstrably insufficient. Maintain it as a rebuildable derived index through outbox events.

## 14. Hashtags

Normalize tags to Unicode-aware lowercase canonical form while retaining display text. `content.hashtags` is unique on canonical name; `content.post_hashtags` maps posts to tags.

- Enforce length/count limits and reject malformed, banned, or policy-restricted tags at publishing.
- Hashtag pages present eligible recent/top content, related tags, and clear content policy messaging.
- Trend calculations run in background time windows and include spam resistance, diversity controls, and moderation exclusions.

## 15. Real-Time Messaging

Model conversations, memberships, messages, attachments, receipts, and per-user conversation state independently of social posts. Membership authorization is checked on every message action.

- MVP supports direct and group conversations, text, supported media/file attachments, reactions, reply references, typing indicators, online presence, delivery/read receipts, and message requests for non-mutual contacts.
- Persist messages before emitting delivery events. Clients paginate backwards with stable cursors and deduplicate by client-generated idempotency keys.
- Encrypt in transit and at rest. End-to-end encryption is a future dedicated initiative; do not claim it until key management, multi-device recovery, abuse reporting, and legal requirements are fully designed.
- Apply message-specific spam limits, attachment scanning, report/block enforcement, retention policy, and legal hold controls.

## 16. Notifications

Use an event-driven notification service. Store in-app notifications durably, deduplicate with an event key, group compatible events, and dispatch push/email through queue workers.

- Events include follows, follow requests, interactions, mentions, messages, content status, account security, creator milestones, and admin actions.
- Preferences support channel, category, quiet hours, push device lifecycle, and per-conversation mute. Security notices cannot be silently disabled.
- WebSocket delivery gives immediate in-app updates; unread counters are cache-backed projections reconciled from PostgreSQL.

## 17. Image/Video Upload And Processing

The API creates short-lived, constrained presigned multipart upload URLs after validating user, purpose, MIME type, size, and quota. The client uploads directly to private object storage, then confirms completion.

- A worker validates file signatures, scans malware, strips unsafe metadata, calculates hashes, extracts technical metadata, and applies moderation classifiers before publication.
- Image pipeline: orientation normalization, EXIF privacy stripping, responsive WebP/AVIF/JPEG renditions, blur placeholder, thumbnail, and alt-text prompt for author review.
- Video pipeline: transcode to adaptive HLS renditions, generate poster/thumbnail/storyboard, normalize audio, extract or generate caption candidates, and retain source only under lifecycle policy.
- Serve only processed/public-safe derivatives; use status polling plus realtime updates for composer progress. Quarantine failed or suspicious uploads.

## 18. Object Storage And CDN

Use S3-compatible private buckets by environment and media class: original quarantine, processed private, and public/eligible derivatives. Object keys are opaque, tenant/environment scoped, and never user-controlled paths.

- CDN at `cdn.kukugram.com` serves immutable processed assets with versioned keys, TLS, origin access control, cache-control headers, image transformation only if securely signed, and signed URLs/cookies for private media.
- Restrict bucket access to service identities; block public bucket listing and direct origin access. Encrypt objects with managed KMS initially and lifecycle old derivatives/originals by policy.
- Maintain a media asset database record containing checksum, processing state, ownership, visibility, rendition metadata, and deletion lifecycle.

## 19. Content Moderation

Use defense in depth: automated pre-publication checks, post-publication detection, user reports, trusted-human review, and appeal workflows. Keep policy, enforcement, and classifier decisions auditable.

- Classify explicit imagery, violence, self-harm indicators, harassment, scams, copyright signals, and spam; use confidence thresholds to permit, hold, blur/limit, or queue review.
- Human reviewers see the minimum required user/context data and work from prioritized queues with documented policies and quality sampling.
- Enforcement can remove a post, restrict distribution, add an interstitial, disable features, warn an account, suspend, or permanently ban. Notify affected users with policy reason and appeal path unless safety/legal requirements prevent it.
- Never use model scores as irreversible sole evidence for high-impact account sanctions.

## 20. Report, Block And Mute Systems

- Reports support content, profile, message, comment, impersonation, copyright, and safety categories; accept context, create a case, prevent duplicate flooding, and allow status updates without exposing reporter identity.
- Blocking immediately removes graph visibility where practical, prevents follows/messages/mentions, suppresses shared discovery, and hides existing interactions subject to legal/audit retention.
- Muting hides an account, topic, or conversation from the muting user without notifying the target. Keyword filters apply to comments and optionally discovery.
- Emergency/self-harm reports route through a high-priority policy workflow with region-appropriate guidance and escalation procedures.

## 21. Admin Dashboard

`admin.kukugram.com` is a separate Next.js application protected by a dedicated admin identity boundary, MFA, IP/device risk controls, least-privilege roles, short sessions, and mandatory audit logs.

- Roles include support, moderator, trust-and-safety lead, finance, analyst, and super-admin; permissions are granular and reviewed periodically.
- Tools: account/content lookup, moderation queues, report case handling, enforcement/appeals, feature flags, configuration, creator verification, payout review, abuse dashboards, and operational health.
- Require reason capture and dual approval for sensitive actions such as permanent bans, data exports, role changes, or payout adjustments. Avoid displaying secrets and minimize private data access.

## 22. Creator Features

Creator Studio exposes audience growth, content reach, completion rates, engagement quality, follower demographics only in privacy-safe aggregate thresholds, earnings, and actionable creation insights.

- Creator account setup includes verification eligibility, category, links, contact preferences, payout onboarding, content scheduling, drafts, and collaboration permissions.
- Support media kits, featured collections, link cards, post-level analytics, audience controls, branded-content disclosure, and later teams/roles.
- Analytics use aggregate event pipelines and delayed data. Clearly distinguish estimated metrics from finalized monetization metrics.

## 23. Monetization Architecture

Monetization is phased behind feature flags and jurisdiction/age eligibility. Build a ledger-first design: do not treat payment-provider webhooks or mutable balances as the source of truth.

- Initial options: creator tips, subscriptions, paid content/products, brand collaboration tools, and later ad inventory.
- Use a payment provider such as Stripe Connect for onboarding, payment methods, tax/payout capabilities, and webhooks. Verify webhook signatures and process events idempotently.
- `billing.ledger_entries` records immutable double-entry movements; derived balances, invoices, transfers, refunds, platform fees, holds, disputes, and payout records reconcile to provider events.
- Gate payouts with identity/tax verification, fraud controls, minimum thresholds, reserves, and manual review. Keep financial data out of the primary product schema where provider tokens suffice.

## 24. Security Architecture

- TLS everywhere, HSTS, modern cipher configuration, secure headers/CSP, CSRF defenses, strict CORS allowlists, input schema validation, parameterized SQL, output encoding, and SSRF-safe outbound networking.
- Store secrets in a managed secret manager, rotate credentials, use workload identity, and enforce least-privilege IAM. No secrets in source, logs, URLs, or client bundles.
- Encrypt databases, backups, queues, and storage at rest; separate production access, maintain audit trails, and use just-in-time access for operators.
- Maintain dependency scanning, SBOMs, patch SLAs, SAST/DAST, secret scanning, threat modeling for high-risk features, penetration testing before major launch, and a vulnerability disclosure process.
- Meet applicable privacy requirements through consent/version records, data export/deletion workflows, retention schedules, child-safety controls, and legal review before regional launch.

## 25. Rate Limiting And Abuse Prevention

Use Redis-backed, identity-aware token-bucket/sliding-window limits with independent keys for IP, account, device fingerprint risk signal, endpoint, and target resource.

- Strict limits: login/signup/password reset, OAuth callbacks, presigned uploads, message sends, follows, comments, likes, searches, reports, and admin actions.
- Return standard `429` responses with retry metadata; use progressive friction, CAPTCHA/attestation, email verification, and temporary holds before broad account restrictions.
- Detect coordinated abuse using velocity, graph patterns, reused media hashes, URL/domain reputation, device and session risk, classifier signals, and report quality. Minimize collection and retention of fingerprinting data.
- Idempotency keys are required for payment, publish, upload-complete, and message-send writes; use database uniqueness plus request records to prevent duplicate effects.

## 26. API Architecture And Endpoint Organization

Version external APIs under `/v1`; use resource-oriented REST, JSON, cursor pagination, RFC 9457-style problem responses, request IDs, idempotency headers, and OpenAPI as the contract source.

- `/v1/auth`: registration, sessions, OAuth, recovery, verification, MFA.
- `/v1/me` and `/v1/users`: account settings, profiles, relationships, sessions.
- `/v1/posts`, `/v1/loops`, `/v1/comments`, `/v1/interactions`, `/v1/collections`: content and engagement.
- `/v1/feed`, `/v1/explore`, `/v1/search`, `/v1/hashtags`, `/v1/circles`: discovery.
- `/v1/uploads` and `/v1/media`: upload intents, status, asset lifecycle.
- `/v1/conversations`, `/v1/messages`: messaging history and actions; realtime payloads use a separately versioned event schema.
- `/v1/notifications`, `/v1/reports`, `/v1/safety`, `/v1/creator`, `/v1/billing`: user-facing platform capabilities.
- `/v1/admin` is never publicly routed; admin uses a separate gateway, hostname, authentication, and authorization layer.

Use BFF-style Next.js server routes only for frontend-specific concerns, never as a second business-logic implementation. Publish OpenAPI client types and validate server request/response schemas in CI.

## 27. Database Indexes And Performance

Design indexes from query patterns and validate with `EXPLAIN (ANALYZE, BUFFERS)` under production-like volumes.

- Unique indexes: normalized handle, email, provider identity, follow pair, reaction pair, save pair, idempotency key scoped to actor/action, and hashtag canonical name.
- Composite indexes: follows by `(followee_id, status, created_at DESC)` and `(follower_id, status, created_at DESC)`; posts by `(author_id, published_at DESC)` with published/eligible partial conditions; comments by `(post_id, parent_id, created_at DESC)`; messages by `(conversation_id, created_at DESC)`.
- Use partial indexes for published/non-deleted content, unread notifications, active sessions, and pending moderation cases. Use GIN indexes for full-text vectors and constrained JSONB fields; `pg_trgm` for handle/name autocomplete.
- Avoid offset pagination on unbounded tables; use opaque cursor tuples with deterministic sort keys. Continuously monitor slow queries, lock waits, bloat, connection saturation, and index usage.

## 28. Redis Caching

Redis is an ephemeral acceleration layer, never the sole authority for durable user or financial state.

- Cache public profiles, post presentation payloads, hashtag pages, Explore candidates, feature flags, and scoped feed candidate lists using explicit versioned keys and short TTLs.
- Store rate-limit counters, session/risk lookups where appropriate, WebSocket presence, typing indicators, distributed locks, idempotency response windows, and queue state.
- Invalidate on outbox events for critical changes; tolerate stale counters and non-security presentation data. Do not cache authorization grants beyond very short, safely invalidated windows.
- Deploy with TLS, ACLs, network isolation, memory eviction policies suited to cache data, persistence only where queue requirements demand it, and metrics/alerting for evictions and latency.

## 29. Background Jobs And Queues

Use BullMQ backed by Redis for MVP workers, organized by bounded queues: media processing, notifications, feed projections, search indexing, moderation, analytics aggregation, cleanup, billing webhooks, and scheduled publishing.

- Jobs are small, idempotent, traceable, retry with exponential backoff, and have explicit timeout, retry, and dead-letter policies. Include job version and correlation/request IDs.
- Publish jobs from a transactional outbox relay rather than directly inside database transactions. Consumers use deduplication keys and at-least-once-safe handlers.
- Separate worker deployments and concurrency per queue so video transcodes or emails cannot starve safety, billing, or user-facing work.
- Migrate individual streams to managed queues or Kafka only when throughput, replay, ordering, or multi-consumer needs exceed Redis queue guarantees.

## 30. WebSocket/Realtime Architecture

Use Socket.IO initially for mature fallback/reconnect semantics, authenticated rooms, acknowledgements, and broad client support. It is the pragmatic choice over raw WebSockets for an MVP; evaluate a managed gateway or raw protocol only at proven scale.

- A dedicated realtime gateway validates short-lived connection credentials and joins users only to authorized rooms: user, conversation, post/comment, and admin operational rooms.
- PostgreSQL remains durable state. Write through HTTP/API commands, then emit events after commit/outbox publication; clients recover missed events through cursor-based REST synchronization.
- Redis adapter/pub-sub fans events across gateway replicas. Presence and typing are TTL-based ephemeral records, never authoritative.
- Version event names/payloads, enforce per-socket message and connection limits, authorize every subscription, and instrument connection count, fan-out latency, reconnects, and dropped events.

## 31. Deployment Architecture

Deploy as containers to a managed Kubernetes platform or managed container service. For MVP, prefer a managed container platform to reduce operations; preserve container, health-check, and infrastructure-as-code portability for Kubernetes adoption.

- Workloads: Next.js web app, API, realtime gateway, worker pools, migration job, and admin app. Autoscale independently using CPU, memory, request rate, queue depth, and active connections.
- Managed PostgreSQL with multi-AZ high availability and read replicas later; managed Redis with replication/failover; S3-compatible storage; CDN/WAF; managed secrets and key management.
- Private network for databases, Redis, workers, and origins. Public ingress exposes only web/API/realtime through WAF, TLS termination, and load balancers.
- CI builds immutable images, scans them, runs migrations as a controlled release step, uses rolling/canary deployment, and supports instant rollback of application versions. Database migrations follow expand/migrate/contract compatibility.

## 32. Development Environments

- Local: Docker Compose supplies PostgreSQL, Redis, S3-compatible MinIO, mail catcher, and optional mocked payment/OAuth services. Application services run with hot reload.
- Ephemeral preview: each pull request receives isolated web/API deployment and disposable/seeded dependencies or a safely namespaced shared non-production environment.
- Shared development and staging: production-like managed services, test provider credentials, synthetic fixtures, no production personal data, and stable integration endpoints.
- Production: segregated account/project, separate keys and databases, change controls, restricted access, and realistic capacity/restore exercises.
- Configuration is typed and validated on startup; use `.env.example` with placeholders only, feature flags for rollout, and deterministic seed scripts for test environments.

## 33. Testing Strategy

- Unit tests: domain policies, ranking helpers, schema validation, permissions, and failure paths.
- Integration tests: repositories against real PostgreSQL/Redis containers, migrations, queue handlers, storage adapters, payment webhook idempotency, and API contracts.
- End-to-end tests: critical journeys including registration, onboarding, privacy/follow requests, publish/process/view media, interaction, report/block, messaging, and admin review.
- Contract tests: OpenAPI request/response validation and realtime event schemas; consumer tests before splitting services.
- Nonfunctional tests: accessibility, visual regression for core surfaces, load tests for feeds/realtime/uploads, security scans, dependency checks, and chaos/restore drills in staging.
- CI blocks merge on formatting, type checks, lint, relevant tests, migration validation, and secret scanning. Use synthetic test media and fixture factories rather than production data.

## 34. Backup And Disaster Recovery

- Run continuous PostgreSQL point-in-time recovery plus encrypted daily snapshots, cross-region copy, and documented retention aligned to legal/privacy requirements.
- Version and replicate critical object-storage media and database export artifacts; treat derived media as rebuildable where cost-effective, but protect originals under retention policy.
- Back up infrastructure definitions, configuration metadata, moderation policies, and key recovery procedures; do not rely only on provider defaults.
- Define initial targets: RPO <= 15 minutes for PostgreSQL and RTO <= 4 hours for critical user workflows. Refine after launch based on business requirements.
- Test restore integrity quarterly, conduct annual regional failover exercises, document incident runbooks and owner escalation, and verify backup restoration against application compatibility.

## 35. Logging And Monitoring

Use structured JSON logs with correlation IDs propagated through HTTP, jobs, database calls, and realtime events. Redact credentials, tokens, message bodies, raw IPs where policy requires, and sensitive user fields.

- OpenTelemetry instruments frontend, API, workers, database, Redis, and external providers; export traces and metrics to a managed observability platform.
- Monitor golden signals, queue backlog/failures, upload/transcode duration, feed latency, WebSocket connections, PostgreSQL saturation/replication lag, Redis pressure, CDN errors, moderation SLA, payments reconciliation, and abuse spikes.
- Define SLOs and error budgets for availability and latency. Alert on actionable symptoms with runbook links, severity, ownership, and escalation; avoid alerting on every isolated failure.
- Maintain tamper-resistant audit logs for administrator and security-sensitive actions with retention and access controls.

## 36. Scalability Strategy

Scale vertically and operationally simply first, then split based on measured bottlenecks.

- Stateless web/API/realtime services scale horizontally; use connection pooling (PgBouncer), Redis adapters, CDN caching, direct upload, and bounded pagination from day one.
- Keep media transcoding in isolated worker pools and use provider-managed encoding if it becomes more reliable/cost-effective.
- Evolve feeds from query/cached candidate assembly to hybrid fan-out based on creator follower thresholds; isolate ranking as a service only when model iteration/latency merits it.
- Partition high-volume events, add read replicas for eligible query paths, archive cold analytics to object storage/warehouse, and introduce OpenSearch/Kafka only after concrete capacity thresholds.
- Establish load-test baselines and capacity reviews before campaigns, product launches, or regional expansion. Favor graceful degradation: cached feeds, delayed noncritical notifications, and upload retry over total outages.

## 37. Recommended Technology Stack With Reasons

| Area | Recommendation | Reason |
| --- | --- | --- |
| Web | Next.js (App Router), React, TypeScript | Fast SSR/RSC delivery, mature ecosystem, typed product UI. |
| UI | Tailwind CSS, Radix primitives, Framer Motion | Tokenized responsive design, accessible foundations, purposeful animation. |
| API | Node.js 22 LTS, TypeScript, Fastify, Zod, OpenAPI | High-throughput typed API, validation, contract generation, modular plugins. |
| Data access | Drizzle ORM plus parameterized SQL for complex queries | Typed migrations/query composition without hiding PostgreSQL capabilities. |
| Primary data | PostgreSQL 16+ | Strong transactional integrity, FTS, mature indexing, reliable operations. |
| Cache/queues | Redis 7+, BullMQ | Low-latency cache/limits/realtime coordination and MVP worker queues. |
| Realtime | Socket.IO with Redis adapter | Reconnection, acknowledgements, rooms, and broad browser support. |
| Storage | Amazon S3 or Cloudflare R2, S3-compatible interface | Durable object storage with portable application integration. |
| CDN/WAF | Cloudflare CDN/WAF or equivalent | Edge media delivery, DDoS protection, bot controls, custom CDN hostname. |
| Media | FFmpeg workers initially; managed transcoding at scale | Control and cost efficiency first, managed reliability later. |
| Search | PostgreSQL FTS + `pg_trgm`; OpenSearch later | Avoid unnecessary infrastructure until scale/relevance demands it. |
| Auth | Argon2id, opaque rotating sessions, OAuth/OIDC | Secure browser model, revocation control, familiar sign-in. |
| Payments | Stripe Connect | Marketplace onboarding, payouts, tax/payment primitives, webhook ecosystem. |
| Observability | OpenTelemetry with Sentry plus managed metrics/logs | Unified traces/errors/metrics and actionable incident response. |
| Delivery | Docker, GitHub Actions, Terraform, managed containers | Reproducible builds/infrastructure with low MVP operations burden. |

## 38. Domain/Subdomain Architecture

| Hostname | Responsibility |
| --- | --- |
| `kukugram.com` | Marketing, legal pages, help entry points, SEO landing pages. |
| `app.kukugram.com` | Authenticated consumer web application and public social surfaces. |
| `api.kukugram.com` | Versioned public product API; only CORS-approved clients. |
| `admin.kukugram.com` | Isolated internal administration and moderation application. |
| `cdn.kukugram.com` | CDN-delivered processed media; no application/session routes. |

Use DNS managed in the infrastructure account, HTTPS everywhere, separate deployment targets and WAF policies per hostname, and no wildcard cookie unless a documented cross-subdomain session need remains after threat modeling. Marketing pages should link to the app rather than share privileged app server state.

## 39. Complete Folder/Project Structure

Use a pnpm workspace monorepo so types, API contracts, configuration, and deployment definitions evolve together while applications retain deployable boundaries.

```text
Kukugram/
├── apps/
│   ├── web/                       # app.kukugram.com Next.js consumer app
│   │   └── src/
│   │       ├── app/               # Route groups, layouts, server components
│   │       ├── features/          # Feature-owned UI and client state
│   │       ├── components/        # Shared presentation components
│   │       └── lib/               # Browser/server integration adapters
│   ├── api/                       # api.kukugram.com Fastify API
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── identity/
│   │       │   ├── users/
│   │       │   ├── social-graph/
│   │       │   ├── content/
│   │       │   ├── media/
│   │       │   ├── feed/
│   │       │   ├── discovery/
│   │       │   ├── messaging/
│   │       │   ├── notifications/
│   │       │   ├── moderation/
│   │       │   ├── billing/
│   │       │   └── administration/
│   │       ├── platform/          # DB, cache, auth, outbox, observability
│   │       └── openapi/
│   ├── realtime/                  # Socket.IO gateway
│   ├── workers/                   # Queue consumers and schedulers
│   └── admin/                     # admin.kukugram.com Next.js app
├── packages/
│   ├── api-contract/              # OpenAPI-generated client/types
│   ├── database/                  # Drizzle schema, migrations, query helpers
│   ├── domain/                    # Cross-app value objects and policies
│   ├── ui/                        # Accessible design primitives/tokens
│   ├── config/                    # Shared lint/TS/Tailwind configuration
│   └── test-kit/                  # Fixtures, factories, integration helpers
├── infrastructure/
│   ├── terraform/                 # Cloud, network, data, CDN, IAM
│   ├── containers/                # Dockerfiles and local Compose
│   └── runbooks/                  # Operations and recovery procedures
├── docs/                          # ADRs, API guides, policy references
├── scripts/                       # Safe maintenance and CI scripts
├── .github/workflows/             # CI/CD workflows
├── pnpm-workspace.yaml
├── package.json
└── KUKUGRAM_BLUEPRINT.md
```

At MVP size, retain all listed API modules in one deployable API and all workers in one worker application with per-queue concurrency. The directory boundaries are architectural contracts, not a requirement to deploy microservices.

## 40. Development Roadmap Divided Into Phases

### Phase 0: Foundation And Product Validation

- Establish product requirements, trust/safety policy, privacy review, brand/design system, architecture decision records, threat model, and core UX prototypes.
- Provision environments, CI, Terraform baseline, PostgreSQL/Redis/storage, observability, feature flags, migrations, seed data, and test harness.

### Phase 1: Private MVP Social Core

- Deliver identity/onboarding, profiles/privacy, follows, image/carousel posts, direct upload/processing, likes/comments/saves, chronological Following feed, basic Explore/search/hashtags, reports/block/mute, and moderation operations.
- Include audit logs, rate limits, backups, monitoring, accessibility baseline, and end-to-end critical-path tests before private beta.

### Phase 2: Engagement And Realtime Beta

- Add Loops, For You ranking v1, recommendations controls, notifications, WebSocket gateway, direct/group messaging, creator profile enhancements, analytics v1, and performance/load validation.
- Run invitation-based beta, measure retention/safety/latency, tune moderation and ranker, and remediate findings before wider release.

### Phase 3: Public MVP Launch

- Harden scaling, incident response, CDN/media costs, abuse detection, support tooling, SEO public surfaces, localization foundations, legal compliance, and launch operations.
- Release to a controlled region/audience with feature flags, canary deployments, SLO dashboards, and defined rollback procedures.

### Phase 4: Creator Economy And Discovery Scale

- Introduce Creator Studio depth, verification, scheduling, collaborations, subscriptions/tips or products, ledger/payout workflows, branded content, advanced search, and hybrid feed fan-out where metrics justify it.

### Phase 5: Platform Expansion

- Build mobile-native clients if validated, advanced recommendation/search infrastructure, Circles/community features, managed media pipelines, data warehouse, regional resilience, and selectively extracted services based on measured bottlenecks.

## Architecture Decision Summary

- Start with a TypeScript modular monolith to ship an MVP quickly while preserving domain seams for future service extraction.
- Treat PostgreSQL as the transactional source of truth, Redis as ephemeral acceleration/queue infrastructure, and S3-compatible storage as the media system of record.
- Use direct uploads plus asynchronous media safety/transcoding so API capacity is not consumed by large files and unsafe media is never served prematurely.
- Build event-driven side effects through a transactional outbox, enabling reliable notifications, indexing, analytics, feed projections, and realtime delivery.
- Favor user-controlled, transparent recommendations and a distinct Circle-led social identity over cloning incumbent social platform patterns.
- Isolate administration, financial flows, and media delivery on dedicated subdomains and security boundaries from the beginning.
