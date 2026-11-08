# Blueprint Implementation Inventory

Baseline branch: `feature/privacy-controls`  
Baseline commit: `c0cf7f04f4823604ba3331f19ba1e83f0de09218`  
Source: `KUKUGRAM_BLUEPRINT.md`, repository tree, API boundary inventory, API contract status, and current CI/E2E results.

## Status definitions

- **Implemented and tested** — code exists and relevant automated tests are present and passing.
- **Implemented, verification incomplete** — implementation evidence exists, but coverage or operational verification is incomplete.
- **In progress** — only a subset of the requirement is implemented.
- **Not started / not found** — no implementation was found in the inspected repository tree.
- A status describes repository evidence, not a claim that the feature is production-ready.

## Phase 0 — Foundation and product validation

| Requirement                             | Status                               | Evidence / gap                                                                             |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| TypeScript pnpm monorepo                | Implemented and tested               | Workspace, shared packages, CI                                                             |
| Next.js consumer web app                | In progress                          | Web shell and landing surface exist; complete primary surfaces are not present             |
| Fastify modular API                     | In progress                          | Identity/social modules exist; several blueprint modules are absent                        |
| PostgreSQL schema and migrations        | Implemented and tested               | Drizzle schema and migrations 0000–0008; integration tests                                 |
| Redis local dependency                  | Implemented and tested               | Compose and Redis rate-limit integration tests                                             |
| Local development environment           | In progress                          | PostgreSQL/Redis Compose; MinIO/mail catcher are not present in current Compose            |
| CI formatting/typecheck/lint/test/build | Implemented and tested               | CI workflow and latest successful run                                                      |
| Browser E2E harness                     | Implemented and tested               | Playwright workflow; 43 passing tests                                                      |
| API contract package                    | In progress                          | Zod schemas/types and tests; route binding and complete OpenAPI snapshot remain incomplete |
| Product UX prototypes/design system     | In progress                          | Current CSS/app shell; no separate shared UI package found                                 |
| Architecture decision records           | Implemented, verification incomplete | ADR-001 exists; full decision coverage is not established                                  |
| Terraform/cloud infrastructure baseline | Not started / not found              | No Terraform tree found                                                                    |
| Observability and SLO dashboards        | Not started / not found              | No telemetry/metrics integration found                                                     |
| Feature flag service                    | Not started / not found              | No implementation found                                                                    |
| Seed/fixture/test harness package       | In progress                          | Test fixtures exist in tests; no shared test-kit package found                             |

## Phase 1 — Private MVP social core

| Requirement                                       | Status                               | Evidence / gap                                                                                           |
| ------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Email/password signup and login                   | Implemented and tested               | API routes, session tests                                                                                |
| OAuth sign-in                                     | Not started / not found              | Config placeholders exist; provider flows not implemented                                                |
| Session lifecycle/logout                          | Implemented and tested               | Opaque hashed sessions, revoke/logout, session E2E                                                       |
| Age gate and onboarding                           | Not started / not found              | No implementation found                                                                                  |
| Profiles and profile editing                      | Implemented and tested               | Profile route and web profile/settings tests                                                             |
| Public/private profile setting                    | Implemented, verification incomplete | Privacy field and visibility checks exist; edge-case matrix incomplete                                   |
| Restricted creator account mode                   | In progress                          | Enum/value exists; full creator-specific behavior not established                                        |
| Follow/unfollow and private follow requests       | Implemented and tested               | API routes and E2E coverage                                                                              |
| Remove follower / relationship history            | In progress                          | Follow operations exist; dedicated remove-follower/history workflows not established                     |
| Block/unblock                                     | Implemented and tested               | API routes, database constraints, privacy tests                                                          |
| Mute/unmute                                       | Implemented and tested               | API routes and feed filtering; complete surface coverage not established                                 |
| Custom audiences / close friends                  | Not started / not found              | No implementation found                                                                                  |
| Image/carousel post creation                      | Not started / not found              | Current post API accepts text body only                                                                  |
| Video / Loops                                     | Not started / not found              | No media pipeline or Loops surface found                                                                 |
| Drafts, scheduling, archive, restore              | Not started / not found              | No implementation found                                                                                  |
| Captions, mentions, hashtags, locations, alt text | In progress                          | Basic text post only; metadata workflows absent                                                          |
| Audience controls per post                        | Not started / not found              | No post-level audience implementation found                                                              |
| Likes                                             | Implemented and tested               | API and web/E2E tests                                                                                    |
| Threaded comments                                 | In progress                          | Comments exist; current API does not implement threaded replies                                          |
| Saves and collections                             | Not started / not found              | No implementation found                                                                                  |
| Share links / internal share                      | Not started / not found              | No implementation found                                                                                  |
| Following chronological feed                      | Implemented and tested               | Authenticated follow-based feed with deleted/private/block/mute filters; 50-row `(created_at, id)` keyset pagination and next-cursor coverage in API, unit, and browser E2E tests. Circle filters and For You ranking remain separate work |
| For You personalized feed                         | Not started / not found              | No ranker found                                                                                          |
| Explore and search                                | In progress                          | Account search exists; Explore/content search/typed results absent                                       |
| Hashtag pages                                     | Not started / not found              | No implementation found                                                                                  |
| Direct-to-storage uploads                         | Not started / not found              | Avatar accepts URL; no upload-intent/object-storage pipeline                                             |
| Media processing/CDN                              | Not started / not found              | No worker/storage/CDN implementation found                                                               |
| In-app notifications                              | Implemented, verification incomplete | Follow/like/comment notification records and read endpoint; preference/deduplication coverage incomplete |
| Push/email notifications                          | Not started / not found              | No delivery workers/providers found                                                                      |
| User reporting                                    | Implemented and tested               | Report creation and user report list                                                                     |
| Moderation queues and appeals                     | Implemented and tested               | Moderator routes, audit events, appeals and integration/E2E tests                                        |
| Automated content safety checks                   | Not started / not found              | No classifier/pre-publication pipeline found                                                             |
| Admin dashboard                                   | In progress                          | Moderation UI exists in consumer web shell; separate admin app/gateway absent                            |
| Audit logs                                        | Implemented and tested               | Immutable audit migrations and PostgreSQL tests                                                          |
| Authentication rate limits                        | Implemented and tested               | Redis-backed atomic fixed-window limiter and integration tests                                           |
| Backups and disaster recovery                     | Not started / not found              | No backup/restore runbooks or exercises found                                                            |
| Accessibility baseline                            | In progress                          | Keyboard/focus/accessibility E2E checks; WCAG 2.2 AA audit not established                               |

## Phase 2 — Engagement and realtime beta

| Requirement                                      | Status                  | Evidence / gap                             |
| ------------------------------------------------ | ----------------------- | ------------------------------------------ |
| Loops short-form video                           | Not started / not found | No implementation found                    |
| For You ranking v1                               | Not started / not found | No ranker found                            |
| Recommendation controls / explanations           | Not started / not found | No implementation found                    |
| WebSocket gateway                                | Not started / not found | No realtime app or gateway found           |
| Direct and group messaging                       | Not started / not found | No messaging module found                  |
| Message delivery/read state, typing, presence    | Not started / not found | No implementation found                    |
| Creator profile enhancements                     | In progress             | Basic profile exists; creator tools absent |
| Analytics v1                                     | Not started / not found | No analytics pipeline found                |
| Performance/load validation                      | Not started / not found | No load-test suite found                   |
| Invitation beta and retention/safety measurement | Not started / not found | No beta operations evidence found          |

## Phase 3 — Public MVP launch

| Requirement                                         | Status                  | Evidence / gap                                                                         |
| --------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| Production scaling and capacity planning            | Not started / not found | No measured load baselines                                                             |
| Incident response and operational runbooks          | In progress             | Migration rollback and moderation operations docs exist; full incident runbooks absent |
| CDN/media cost controls                             | Not started / not found | Media/CDN pipeline absent                                                              |
| Abuse detection                                     | In progress             | Auth rate limits and moderation/reporting; coordinated abuse detection absent          |
| Support tooling                                     | Not started / not found | No support console found                                                               |
| SEO public surfaces                                 | In progress             | Landing page exists; complete public profile/content SEO not verified                  |
| Localization                                        | Not started / not found | No localization framework found                                                        |
| Legal/compliance launch review                      | Not started / not found | No launch evidence found                                                               |
| Canary release, SLO dashboards, rollback operations | Not started / not found | No production release pipeline/SLO dashboards found                                    |

## Phase 4 — Creator economy and discovery scale

| Requirement                             | Status                  | Evidence / gap                 |
| --------------------------------------- | ----------------------- | ------------------------------ |
| Creator Studio                          | Not started / not found | No implementation found        |
| Verification and creator scheduling     | Not started / not found | No implementation found        |
| Collaborations and branded content      | Not started / not found | No implementation found        |
| Subscriptions, tips, products, payouts  | Not started / not found | No billing/ledger module found |
| Advanced search and hybrid feed fan-out | Not started / not found | No implementation found        |

## Phase 5 — Platform expansion

| Requirement                                      | Status                  | Evidence / gap                                        |
| ------------------------------------------------ | ----------------------- | ----------------------------------------------------- |
| Native mobile clients                            | Not started / not found | No mobile app found                                   |
| Advanced recommendation/search infrastructure    | Not started / not found | No implementation found                               |
| Circles/community features                       | Not started / not found | Product concept only; no implementation found         |
| Managed media pipelines                          | Not started / not found | No media worker/storage stack found                   |
| Data warehouse and regional resilience           | Not started / not found | No implementation found                               |
| Service extraction based on measured bottlenecks | Not started / not found | Current architecture remains a small modular monolith |

## Prioritized next implementation sequence

1. Finish and test the Phase 1 social-core baseline: profile privacy, follow graph, block/mute visibility, post audience/visibility, feed correctness, and interaction authorization.
2. Implement image/carousel upload foundations only after selecting and configuring a non-production object-storage adapter and its local test substitute.
3. Extend cursor pagination to search, comments, notifications, and moderation lists without breaking existing response contracts; Following feed cursor pagination is implemented and tested.
4. Complete the shared API contract adoption and generated OpenAPI snapshot.
5. Add remaining Phase 1 product surfaces: saves/collections, richer posts, Explore/hashtags, notification preferences, and accessibility audit.
6. Add workers, media processing, and realtime only after the corresponding domain contracts and infrastructure are ready.

## Progress calculation policy

Do not assign a single project completion percentage from this inventory yet. The blueprint mixes implementation requirements, future architecture recommendations, and later-stage scale targets; counting each row equally would distort progress. For a defensible percentage, first approve a phase/priority weighting scheme, split broad rows into independently verifiable acceptance criteria, and score only criteria backed by code and tests. Report Phase 1 completion separately from overall roadmap completion.
