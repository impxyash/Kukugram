import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { hashSessionToken } from "./platform/auth/session.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

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

describe("API configuration", () => {
  const environment = {
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    SESSION_COOKIE_NAME: "session",
    SESSION_TOKEN_PEPPER: "a-secure-test-pepper-that-is-long-enough"
  };

  it("uses Railway's injected PORT when API_PORT is not set", () => {
    const railwayConfig = loadConfig({ ...environment, PORT: "8080" });
    expect(railwayConfig.API_PORT).toBe(8080);
  });

  it("prefers an explicit API_PORT over Railway's PORT", () => {
    const railwayConfig = loadConfig({ ...environment, API_PORT: "3001", PORT: "8080" });
    expect(railwayConfig.API_PORT).toBe(3001);
  });
});

describe("API", () => {
  it("returns a request-correlated health response", async () => {
    const app = buildApp(config);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
    await app.close();
  });

  it("requires authentication for privacy-control endpoints", async () => {
    const app = buildApp(config);
    const requests = [
      { method: "GET" as const, url: "/v1/me/blocked" },
      { method: "POST" as const, url: "/v1/reports", payload: { targetType: "profile", targetId: "00000000-0000-0000-0000-000000000001", category: "spam" } },
      { method: "GET" as const, url: "/v1/me/muted" },
      { method: "GET" as const, url: "/v1/me/reports" },
      { method: "GET" as const, url: "/v1/me/follow-requests" },
      { method: "POST" as const, url: "/v1/users/someone/block" },
      { method: "POST" as const, url: "/v1/users/someone/mute" },
      { method: "POST" as const, url: "/v1/users/someone/follow" },
      { method: "POST" as const, url: "/v1/me/follow-requests/someone/accept" },
      { method: "DELETE" as const, url: "/v1/me/follow-requests/someone" }
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, request.url).toBe(401);
    }

    await app.close();
  });

  it("limits repeated authentication attempts from one IP", async () => {
    const app = buildApp(config);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {}
      });
      expect(response.statusCode).toBe(400);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {}
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });
});


describe("social privacy authorization", () => {
  const viewerId = "00000000-0000-4000-8000-000000000001";
  const targetId = "00000000-0000-4000-8000-000000000002";
  const token = "test-session-token";
  const cookie = `session=${token}`;

  function makePool(options: { blocked?: boolean; privacy?: "public" | "private"; accepted?: boolean } = {}) {
    const statements: string[] = [];
    const pool = {
      statements,
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM identity.sessions")) {
          return { rows: [{ id: viewerId, email: "viewer@example.test" }], rowCount: 1 };
        }
        if (sql.includes("SELECT (pr.privacy <> 'private'")) {
          return {
            rows: [{
              allowed: (options.privacy === "public" || options.accepted === true) && options.blocked !== true
            }],
            rowCount: 1
          };
        }
        if (sql.includes("FROM social.profiles p JOIN identity.users u")) {
          return {
            rows: [{
              id: targetId,
              handle: "target_user",
              displayName: "Target User",
              bio: "Private bio",
              avatarUrl: null,
              followers: "0",
              following: "0",
              isFollowing: options.accepted ?? false,
              isRequested: false,
              privacy: options.privacy ?? "private",
              canViewContent: options.privacy === "public" || options.accepted === true,
              isBlocked: options.blocked ?? false
            }],
            rowCount: 1
          };
        }
        if (sql.includes("INSERT INTO social.follows")) {
          return { rows: [{ status: "pending" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      end: vi.fn(async () => undefined)
    };
    return pool as unknown as Pool & { statements: string[] };
  }

  function appWithPool(pool: Pool) {
    return buildApp(config, pool);
  }

  it("returns private profile metadata without granting private content access", async () => {
    const pool = makePool({ privacy: "private" });
    const app = appWithPool(pool);
    const response = await app.inject({ method: "GET", url: "/v1/users/target_user", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.canViewContent).toBe(false);
    await app.close();
  });

  it("hides a profile when either account has blocked the viewer", async () => {
    const pool = makePool({ privacy: "public", blocked: true });
    const app = appWithPool(pool);
    const response = await app.inject({ method: "GET", url: "/v1/users/target_user", headers: { cookie } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("creates a pending follow request for a private profile", async () => {
    const pool = makePool({ privacy: "private" });
    const app = appWithPool(pool);
    const response = await app.inject({ method: "POST", url: "/v1/users/target_user/follow", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(pool.statements.some((sql) => sql.includes("'follow_request'"))).toBe(true);
    await app.close();
  });

  it("applies mute and block exclusions to the authenticated feed query", async () => {
    const pool = makePool();
    const app = appWithPool(pool);
    const response = await app.inject({ method: "GET", url: "/v1/feed", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const feedQuery = pool.statements.find((sql) => sql.includes("FROM content.posts p"));
    expect(feedQuery).toContain("social.mutes");
    expect(feedQuery).toContain("social.blocks");
    await app.close();
  });

  it("denies private post comments to viewers without an accepted follow", async () => {
    const pool = makePool({ privacy: "private", accepted: false });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/posts/00000000-0000-4000-8000-000000000003/comments",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("allows private post comments to accepted followers", async () => {
    const pool = makePool({ privacy: "private", accepted: true });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/posts/00000000-0000-4000-8000-000000000003/comments",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(pool.statements.some((sql) => sql.includes("f.status = 'accepted'"))).toBe(true);
    await app.close();
  });

  it("denies private post comments even when a follow exists if either side blocked", async () => {
    const pool = makePool({ privacy: "private", accepted: true, blocked: true });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/posts/00000000-0000-4000-8000-000000000003/comments",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(404);
    expect(pool.statements.some((sql) => sql.includes("social.blocks"))).toBe(true);
    await app.close();
  });

  it("accepts a valid session cookie only when its peppered hash matches the session record", async () => {
    const pool = makePool();
    const query = pool.query as unknown as ReturnType<typeof vi.fn>;
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      pool.statements.push(sql);
      if (sql.includes("FROM identity.sessions")) {
        expect(values?.[0]).toBe(hashSessionToken(token, config.SESSION_TOKEN_PEPPER));
        return { rows: [{ id: viewerId, email: "viewer@example.test" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const app = appWithPool(pool);
    const response = await app.inject({ method: "GET", url: "/v1/feed", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
