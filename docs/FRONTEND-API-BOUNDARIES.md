# Frontend and API Boundaries

> Implementation-derived architecture note for the current web application.
> This document does not select or commit to a native Android architecture.

## Current web application

- Framework: Next.js 15 with React 19.
- The root page renders `AppShell`.
- `AppShell` is a client component and owns the current application flow.
- Main views are Home, Discover, Activity, Profile, Settings, and Moderation.
- Authentication is handled by an in-shell login/signup screen.
- The client checks the current session by requesting `GET /v1/me`.
- The shell loads the feed and notifications after session discovery.
- The moderation navigation is enabled after a moderator reports request succeeds.
- Feature views and UI state are currently colocated in
  `apps/web/src/features/app/app-shell.tsx`.
- Local TypeScript interfaces describe users, posts, comments, notifications,
  follow requests, reports, and appeals.
- These frontend interfaces are not imported from
  `@kukugram/api-contract`.

## HTTP client boundary

- API origin is `NEXT_PUBLIC_API_URL`.
- The current fallback is `http://localhost:3001`.
- The shared `request<T>()` helper prefixes paths with `/v1`.
- Requests use browser `fetch` with `credentials: "include"`.
- The helper sets JSON content type and passes caller-supplied options.
- HTTP 204 responses resolve as `undefined`.
- Other successful responses are parsed as JSON.
- Failed responses attempt to read a Problem Details `title` and throw
  an Error using that title.
- The helper does not currently provide generated request or response types.
- No shared retry, cancellation, caching, or query invalidation layer is
  established by this implementation.

## Web-to-API operations

- Session and identity:
  `/auth/signup`, `/auth/login`, `/auth/logout`, `/me`.
- Feed and posts:
  `/feed`, `/posts`, `/posts/:id`, `/posts/:id/like`.
- Comments:
  `/posts/:id/comments`.
- Discovery and profiles:
  `/users/search`, `/users/:handle/follow`, `/me/profile`.
- Privacy controls:
  `/users/:handle/block`, `/users/:handle/mute`,
  `/me/blocked`, `/me/muted`.
- Follow requests:
  `/me/follow-requests` and its accept/decline operations.
- Reports and appeals:
  `/reports`, `/reports/:id/appeals`, `/me/reports`,
  `/me/appeals`.
- Moderation:
  `/moderation/reports`, `/moderation/appeals`,
  `/moderation/appeals/:id`.
- Notifications:
  `/notifications`, `/notifications/read`.

## Current architectural constraints

1. The main feature shell is a large client-side module. Feature boundaries
   exist as React components but are not separate API/data packages.
2. Authentication state is discovered in the browser. Server-side session
   hydration is not established by the inspected root page.
3. Frontend API types are local declarations and can drift from API responses.
4. The API contract package currently exports only `apiVersion` and
   `HealthResponse`.
5. The web app uses cookie credentials. A native client will need an explicit
   authentication/session strategy; browser cookie behavior must not be
   assumed to transfer directly to Android.
6. The current request helper is a thin fetch wrapper, not a complete
   transport abstraction for offline queues, uploads, refresh, or retries.
7. The inspected web client does not establish WebSocket or EventSource
   messaging/realtime integration.
8. The inspected API routes do not establish push delivery or media upload.
9. The current UI should not be treated as proof that all listed product
   capabilities are production-ready.

## Recommended sequence before Android implementation

1. Extract feature-level API operations from the monolithic shell into
   independently testable modules.
2. Define shared request and response contracts from the actual API handlers.
3. Add contract tests that compare runtime responses with those contracts.
4. Define session lifecycle, token storage, revocation, and step-up behavior
   for non-browser clients.
5. Define media upload, validation, processing, storage, and delivery.
6. Define messaging and realtime delivery separately from push notifications.
7. Compare native Android, React Native, and other options against the
   verified API contracts and product requirements.
8. Build and measure a release APK/AAB before making package-size claims.

## Explicit non-goals of this note

- It does not assert that an Android app or APK exists.
- It does not claim messaging, WebSockets, or push are implemented.
- It does not change API behavior or authentication.
- It does not prescribe an Android framework before contract and feature
  boundaries are verified.
