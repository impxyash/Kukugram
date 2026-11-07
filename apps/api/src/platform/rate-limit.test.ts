import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  createAuthRateLimitKey,
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  resolveClientIp
} from "./rate-limit.js";

const redisUrl = process.env.REDIS_URL;
const redisIntegration = describe.skipIf(!redisUrl);
const config = {
  NODE_ENV: "test" as const,
  API_HOST: "127.0.0.1",
  API_PORT: 3001,
  WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  SESSION_COOKIE_NAME: "session",
  SESSION_TOKEN_PEPPER: "a-secure-test-pepper-that-is-long-enough",
  GOOGLE_OAUTH_CLIENT_ID: undefined,
  GOOGLE_OAUTH_CLIENT_SECRET: undefined,
  APPLE_OAUTH_CLIENT_ID: undefined,
  APPLE_OAUTH_CLIENT_SECRET: undefined
};

describe("authentication rate-limit identity", () => {
  it("accepts a single IP from X-Real-IP and normalizes IPv4-mapped IPv6", () => {
    expect(resolveClientIp("203.0.113.7", "127.0.0.1", true)).toBe("203.0.113.7");
    expect(resolveClientIp("::ffff:203.0.113.7", "127.0.0.1", true)).toBe("203.0.113.7");
  });

  it("rejects missing, repeated, comma-separated and malformed public-ingress headers", () => {
    expect(() => resolveClientIp(undefined, "127.0.0.1", true)).toThrow();
    expect(() => resolveClientIp(["203.0.113.7", "198.51.100.9"], "127.0.0.1", true)).toThrow();
    expect(() => resolveClientIp("203.0.113.7, 198.51.100.9", "127.0.0.1", true)).toThrow();
    expect(() => resolveClientIp("not-an-ip", "127.0.0.1", true)).toThrow();
  });

  it("uses only the socket peer as a non-production fallback", () => {
    expect(resolveClientIp(undefined, "::ffff:127.0.0.1", false)).toBe("127.0.0.1");
    expect(() => resolveClientIp(undefined, undefined, false)).toThrow();
  });

  it("HMACs client IP and endpoint without exposing either in the Redis key", () => {
    const first = createAuthRateLimitKey("test-pepper", "203.0.113.7", "/v1/auth/login");
    const otherIp = createAuthRateLimitKey("test-pepper", "203.0.113.8", "/v1/auth/login");
    const otherEndpoint = createAuthRateLimitKey("test-pepper", "203.0.113.7", "/v1/auth/signup");
    expect(first).not.toContain("203.0.113.7");
    expect(first).not.toBe(otherIp);
    expect(first).not.toBe(otherEndpoint);
  });

  it("keeps the in-memory test store's fixed-window semantics", async () => {
    const store = new InMemoryRateLimitStore();
    const first = await store.consume("test-key", 10_000);
    const second = await store.consume("test-key", 10_000);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeLessThanOrEqual(first.ttlMs);
    await store.close();
  });
});

redisIntegration("Redis fixed-window rate limiter", () => {
  let firstStore: RedisRateLimitStore;
  let secondStore: RedisRateLimitStore;

  beforeAll(async () => {
    if (!redisUrl) throw new Error("REDIS_URL is required for Redis integration tests.");
    firstStore = new RedisRateLimitStore(redisUrl);
    secondStore = new RedisRateLimitStore(redisUrl);
    await Promise.all([firstStore.connect(), secondStore.connect()]);
  }, 15_000);

  afterAll(async () => {
    await Promise.all([firstStore?.close(), secondStore?.close()]);
  });

  it("atomically increments one shared key across independent Redis clients", async () => {
    const key = `test:atomic:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? firstStore : secondStore).consume(key, 60_000)
      )
    );
    expect(results.map((result) => result.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1)
    );
  });

  it("expires a fixed window without extending it on subsequent requests", async () => {
    const key = `test:expiry:${randomUUID()}`;
    const first = await firstStore.consume(key, 500);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await secondStore.consume(key, 500);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeLessThan(first.ttlMs);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const reset = await firstStore.consume(key, 500);
    expect(reset.count).toBe(1);
  });

  it("enforces the authentication threshold atomically under concurrent requests", async () => {
    const appA = buildApp(config, undefined, firstStore);
    const appB = buildApp(config, undefined, secondStore);
    const requests = Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? appA : appB).inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: {
          "x-real-ip": "203.0.113.91",
          "x-forwarded-for": `198.51.100.${index + 1}`
        },
        payload: {}
      })
    );

    try {
      const responses = await Promise.all(requests);
      expect(responses.filter((response) => response.statusCode === 400)).toHaveLength(10);
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(10);
      expect(
        responses
          .filter((response) => response.statusCode === 429)
          .every((response) => response.headers["retry-after"] !== undefined)
      ).toBe(true);
    } finally {
      await Promise.all([appA.close(), appB.close()]);
    }
  });

  it("recovers after the Redis connection is closed and reopened", async () => {
    const key = `test:reconnect:${randomUUID()}`;
    const first = await firstStore.consume(key, 60_000);
    await firstStore.close();
    const recovered = await firstStore.consume(key, 60_000);
    expect(recovered.count).toBe(first.count + 1);
  });

  it("shares the 10-attempt policy across two independent API instances", async () => {
    const appA = buildApp(config, undefined, firstStore);
    const appB = buildApp(config, undefined, secondStore);
    const requests = Array.from({ length: 10 }, (_, index) =>
      (index % 2 === 0 ? appA : appB).inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: {
          "x-real-ip": "203.0.113.90",
          "x-forwarded-for": `198.51.100.${index + 1}`
        },
        payload: {}
      })
    );

    try {
      const allowed = await Promise.all(requests);
      expect(allowed.every((response) => response.statusCode === 400)).toBe(true);
      const limited = await appB.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: {
          "x-real-ip": "203.0.113.90",
          "x-forwarded-for": "192.0.2.99"
        },
        payload: {}
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    } finally {
      await Promise.all([appA.close(), appB.close()]);
    }
  });
});
