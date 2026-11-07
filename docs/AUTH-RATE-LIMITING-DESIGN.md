# Authentication Rate-Limit Design

## Verified current implementation

- Login and signup use a module-level in-memory Map in
  `apps/api/src/app.ts`.
- The current policy allows 10 attempts per endpoint in a 15-minute window.
- The key currently uses Fastify `request.ip`, which is based on the
  connection peer unless proxy trust is configured.
- Counters are local to one API process and reset on process restart.
- `REDIS_URL` is required by API configuration.
- Docker Compose provisions Redis 7 with AOF persistence and a health check.
- The API package does not yet declare a Redis client dependency or create a
  Redis client.

## Railway public-ingress client IP decision

Railway's public networking specification identifies `X-Real-IP` as the
client's remote IP. More importantly, a Railway employee explicitly confirmed
that the public HTTP edge overwrites caller-supplied `X-Real-IP` and
`X-Forwarded-For` values on every request it handles, replacing rather than
appending to client values. The employee confirmed the same current behavior
for custom domains and generated `*.up.railway.app` domains and recommended
using `X-Real-IP` for public-ingress rate limiting.

Sources:

- https://docs.railway.com/networking/public-networking/specs-and-limits
- https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86

Important limits from the same Railway employee response:

- This is current platform behavior, not a versioned guarantee; Railway says
  networking details may change.
- `*.railway.internal` requests bypass the public edge and its header
  sanitization. Any service in the same environment can send its own
  `X-Real-IP`; do not treat that header as end-user identity on private
  requests.
- Railway does not publish stable proxy CIDRs or a signed ingress header.
  Observed `100.x` socket peers must not be hard-coded as a trust boundary.
- `Forwarded` handling is undocumented; do not use it.
- For Cloudflare-to-Railway traffic, the employee confirmed the derivation of
  `X-Real-IP` from `CF-Connecting-IP` only for connections from Cloudflare's
  published IPv4 ranges. Cloudflare IPv6 behavior was not confirmed.
- Fastify `request.ip` does not read `X-Real-IP`; enabling global
  `trustProxy` would instead make Fastify interpret socket and
  `X-Forwarded-For` information.

### Decision

- Keep Fastify proxy trust disabled.
- For the public API ingress, parse exactly one valid IP address from
  `X-Real-IP` using Node's `net.isIP`.
- Never parse or trust `X-Forwarded-For`, `Forwarded`, or
  `CF-Connecting-IP` in application code.
- In production, missing, repeated, comma-separated, or malformed
  `X-Real-IP` must fail closed with a retryable 503 rather than falling back
  to a shared Railway socket peer or silently disabling the limiter.
- Private-network service callers are a separate trust domain. Do not send
  browser authentication requests through `*.railway.internal`; any future
  internal caller must use a separately authenticated path or an explicit
  internal identity, not a caller-provided IP header.
- Revisit the IP resolver before putting Cloudflare in front of the API over
  IPv6.

The inspected frontend currently calls the configured API URL directly from
the browser. This keeps browser authentication traffic on the public API
domain rather than relaying it through a private web-to-API request.

## Shared fixed-window counter

Preserve the current user-visible policy initially: 10 attempts per endpoint
per 15 minutes.

Use one Redis counter per endpoint and privacy-preserving client identity.
Create an HMAC-SHA-256 digest using the existing session pepper with a
rate-limit-specific domain-separation prefix. Do not store raw IP addresses in
Redis keys.

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
- Keep connection attempts and command queues bounded.
- Configure reconnect with bounded backoff; do not queue authentication
  attempts while Redis is unavailable.
- If Redis is unavailable, fail authentication attempts closed with a
  retryable 503 Problem Details response. Do not silently fail open.
- Do not represent a Redis outage as a user rate-limit 429.
- Keep readiness semantics explicit so operators can distinguish an
  unavailable limiter from an authentication failure.

## Required tests before rollout

- Atomic concurrent increments from two independent Redis clients.
- Two independent API instances share the same counter.
- Login and signup use independent endpoint buckets.
- Fixed-window expiry occurs once and is not extended by later requests.
- The 10th attempt is allowed and the 11th is rejected.
- Redis connection failure and command failure fail closed.
- Redis reconnection restores counting without process restart.
- Missing, malformed, repeated, and comma-separated `X-Real-IP` values fail
  closed in production.
- `X-Forwarded-For` and `Forwarded` never affect the key.
- Private-network callers are documented as a separate trusted path.

## Rollout constraints

Implement and verify the limiter in disposable local/CI infrastructure first.
Do not deploy or change Railway production configuration as part of this work.
The Railway confirmation supports public HTTP ingress only; it does not make
caller-provided forwarding headers trustworthy over private networking.
