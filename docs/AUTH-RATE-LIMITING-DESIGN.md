# Authentication Rate-Limit Design

## Verified current implementation

- Login and signup use a module-level in-memory Map in
  `apps/api/src/app.ts`.
- The current policy allows 10 attempts per endpoint in a 15-minute window.
- The key uses `request.ip`.
- Counters are local to one API process and reset on process restart.
- `REDIS_URL` is required by API configuration.
- Docker Compose provisions Redis 7 with AOF persistence and a health check.
- The API package does not currently declare a Redis client dependency, and
  the inspected API initialization does not create a Redis client.

## Client IP trust boundary

Railway's public-networking documentation identifies `X-Real-IP` as the
header for the client's remote IP. Railway's edge-networking documentation
describes the edge proxy as adding request headers before forwarding traffic.

References:

- https://docs.railway.com/networking/public-networking/specs-and-limits
- https://docs.railway.com/networking/edge-networking

The documentation does not explicitly establish, in the inspected passages,
whether a client-supplied `X-Real-IP` is always overwritten. Existing Railway
logs also do not prove the exact header trust chain.

Therefore:

- Do not enable Fastify `trustProxy: true`.
- Do not trust arbitrary `X-Forwarded-For` values.
- Do not yet use `X-Real-IP` as an authorization or rate-limit identity.
- Verify the edge overwrite behavior and the effective Fastify request address
  before implementing the production client-IP resolver.
- A missing or invalid client IP must not silently collapse every user into
  one shared bucket or disable protection.

## Proposed shared fixed-window counter

Preserve the current user-visible policy initially: 10 attempts per endpoint
per 15 minutes.

Use one Redis counter per endpoint and privacy-preserving client identity.
Prefer an HMAC of the normalized IP address using a dedicated rate-limit key
secret, rather than storing raw IP addresses in Redis keys.

The increment and expiry must happen in one atomic Lua script:

1. Increment the key.
2. If the key has no expiry, set the fixed-window expiry.
3. Return the count and remaining TTL.
4. Permit counts 1 through 10; reject count 11 and above.
5. Derive `Retry-After` from the returned TTL.

Do not reset the expiry on every request; that would silently change the
policy from a fixed window to a sliding window.

## Redis lifecycle and outage behavior

- Use one Redis client per API process, not one client per request.
- Connect during Fastify readiness before accepting traffic.
- Close the client through Fastify's shutdown lifecycle.
- Keep Redis operations bounded by explicit connection and command timeouts.
- If Redis is unavailable, fail authentication attempts closed with a
  retryable 503 Problem Details response. Do not silently fail open.
- Do not represent a Redis outage as a user rate-limit 429.
- Keep health/readiness semantics explicit so operators can distinguish an
  unavailable limiter from an authentication failure.

## Required tests before rollout

- Atomic concurrent increments against one shared Redis instance.
- Two independent Fastify app instances share the same counter.
- Login and signup use independent endpoint buckets.
- Fixed-window expiry occurs once and is not extended by later requests.
- The 10th attempt is allowed and the 11th is rejected.
- Redis connection failure and command timeout fail closed.
- Recovery after Redis reconnect works without process restart.
- Missing, malformed, spoofed, and trusted client-IP headers are covered.
- Proxy behavior is tested without trusting client-controlled forwarded data.

## Rollout constraints

Do not deploy or change Railway production configuration as part of this work.
Implement and verify the limiter in disposable local/CI infrastructure first.
Only after the trusted client-IP boundary is proven should the production
integration be considered.
