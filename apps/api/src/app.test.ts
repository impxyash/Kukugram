import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
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
      {
        method: "POST" as const,
        url: "/v1/reports",
        payload: {
          targetType: "profile",
          targetId: "00000000-0000-0000-0000-000000000001",
          category: "spam"
        }
      },
      { method: "GET" as const, url: "/v1/me/muted" },
      { method: "GET" as const, url: "/v1/me/reports" },
      { method: "GET" as const, url: "/v1/me/follow-requests" },
      { method: "POST" as const, url: "/v1/users/someone/block" },
      { method: "POST" as const, url: "/v1/users/someone/mute" },
      { method: "POST" as const, url: "/v1/users/someone/follow" },
      { method: "POST" as const, url: "/v1/me/follow-requests/someone/accept" },
      { method: "DELETE" as const, url: "/v1/me/follow-requests/someone" },
      { method: "GET" as const, url: "/v1/moderation/reports" },
      { method: "GET" as const, url: "/v1/moderation/appeals" },
      { method: "GET" as const, url: "/v1/moderation/roles" },
      { method: "GET" as const, url: "/v1/moderation/audit" },
      {
        method: "POST" as const,
        url: "/v1/reports/00000000-0000-4000-8000-000000000004/appeals",
        payload: { details: "I believe this decision was incorrect." }
      }
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

  function makePool(
    options: {
      blocked?: boolean;
      privacy?: "public" | "private";
      accepted?: boolean;
      targetOwnerId?: string;
      followRequest?: boolean;
      moderatorRole?: "moderator" | "admin";
    } = {}
  ) {
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const pool = {
      statements,
      parameters,
      query: vi.fn((sql: string, values?: unknown[]) => {
        statements.push(sql);
        parameters.push(values ?? []);
        if (sql.includes("FROM moderation.moderator_roles")) {
          const allowedRoles = values?.[1] as string[] | undefined;
          const allowed = Boolean(
            options.moderatorRole && allowedRoles?.includes(options.moderatorRole)
          );
          return {
            rows: allowed ? [{ role: options.moderatorRole }] : [],
            rowCount: allowed ? 1 : 0
          };
        }
        if (sql.includes("FROM identity.sessions")) {
          return { rows: [{ id: viewerId, email: "viewer@example.test" }], rowCount: 1 };
        }
        if (sql.includes("SELECT (pr.privacy <> 'private'")) {
          return {
            rows: [
              {
                allowed:
                  (options.privacy === "public" || options.accepted === true) &&
                  options.blocked !== true
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes("FROM social.profiles p JOIN identity.users u")) {
          return {
            rows: [
              {
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
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes('SELECT user_id AS "userId" FROM social.profiles')) {
          return { rows: [{ userId: options.targetOwnerId ?? targetId }], rowCount: 1 };
        }
        if (sql.includes("UPDATE social.follows f SET status = 'accepted'")) {
          return {
            rows: options.followRequest ? [{ follower_id: targetId }] : [],
            rowCount: options.followRequest ? 1 : 0
          };
        }
        if (sql.includes("DELETE FROM social.follows f USING social.profiles p")) {
          return {
            rows: options.followRequest ? [{ follower_id: targetId }] : [],
            rowCount: options.followRequest ? 1 : 0
          };
        }
        if (sql.includes("INSERT INTO moderation.reports")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000004" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO social.follows")) {
          return { rows: [{ status: "pending" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(async () => ({
        query: async (sql: string, values?: unknown[]) => {
          const result = await pool.query(sql, values);
          return result;
        },
        release: vi.fn()
      })),
      end: vi.fn(() => Promise.resolve())
    };
    return pool as unknown as Pool & { statements: string[]; parameters: unknown[][] };
  }

  function appWithPool(pool: Pool) {
    return buildApp(config, pool);
  }

  it("returns private profile metadata without granting private content access", async () => {
    const pool = makePool({ privacy: "private" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/users/target_user",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { canViewContent: boolean } }>().user.canViewContent).toBe(false);
    await app.close();
  });

  it("hides a profile when either account has blocked the viewer", async () => {
    const pool = makePool({ privacy: "public", blocked: true });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/users/target_user",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("creates a pending follow request for a private profile", async () => {
    const pool = makePool({ privacy: "private" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "POST",
      url: "/v1/users/target_user/follow",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(pool.parameters.some((values) => values[2] === "pending")).toBe(true);
    expect(
      pool.statements.some((sql) => sql.includes("INSERT INTO notifications.notifications"))
    ).toBe(true);
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

  it("accepts a report for another user's profile and creates a moderation case", async () => {
    const pool = makePool();
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { cookie },
      payload: {
        targetType: "profile",
        targetId,
        category: "impersonation",
        details: "This account is impersonating someone."
      }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      reportId: "00000000-0000-4000-8000-000000000004",
      status: "open"
    });
    await app.close();
  });

  it("accepts only a pending follow request addressed to the authenticated profile", async () => {
    const pool = makePool({ followRequest: true });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "POST",
      url: "/v1/me/follow-requests/target_user/accept",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(204);
    const update = pool.statements.findIndex((sql) =>
      sql.includes("UPDATE social.follows f SET status = 'accepted'")
    );
    expect(update).toBeGreaterThanOrEqual(0);
    expect(pool.parameters[update]).toEqual(["target_user", viewerId]);
    expect(pool.statements.some((sql) => sql.includes("type = 'follow_request'"))).toBe(true);
    expect(pool.statements.some((sql) => sql.includes("VALUES ($1, $2, $3, 'follow')"))).toBe(true);
    await app.close();
  });

  it("declines only a pending follow request addressed to the authenticated profile", async () => {
    const pool = makePool({ followRequest: true });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/me/follow-requests/target_user",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(204);
    const deletion = pool.statements.findIndex((sql) =>
      sql.includes("DELETE FROM social.follows f USING social.profiles p")
    );
    expect(deletion).toBeGreaterThanOrEqual(0);
    expect(pool.parameters[deletion]).toEqual(["target_user", viewerId]);
    expect(pool.statements.some((sql) => sql.includes("type = 'follow_request'"))).toBe(true);
    await app.close();
  });

  it("prevents users from reporting their own profile", async () => {
    const pool = makePool({ targetOwnerId: viewerId });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { cookie },
      payload: {
        targetType: "profile",
        targetId: viewerId,
        category: "other"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.reports"))).toBe(
      false
    );
    await app.close();
  });

  it("denies ordinary users access to the moderation queue", async () => {
    const pool = makePool();
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/moderation/reports",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(403);
    expect(pool.statements.some((sql) => sql.includes("FROM moderation.reports r"))).toBe(false);
    await app.close();
  });

  it("allows a moderator to read the moderation queue", async () => {
    const pool = makePool({ moderatorRole: "moderator" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/moderation/reports?status=open&limit=20",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(pool.statements.some((sql) => sql.includes("FROM moderation.reports r"))).toBe(true);
    await app.close();
  });

  it("denies non-admin users access to moderator role management", async () => {
    const pool = makePool({ moderatorRole: "moderator" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/moderation/roles",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("prevents an administrator from revoking their own admin role", async () => {
    const pool = makePool({ moderatorRole: "admin" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/moderation/roles/${viewerId}/admin`,
      headers: { cookie }
    });
    expect(response.statusCode).toBe(409);
    expect(
      pool.statements.some((sql) => sql.includes("DELETE FROM moderation.moderator_roles"))
    ).toBe(false);
    await app.close();
  });

  it("does not expose the moderation audit log to moderators", async () => {
    const pool = makePool({ moderatorRole: "moderator" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "GET",
      url: "/v1/moderation/audit",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(403);
    expect(pool.statements.some((sql) => sql.includes("FROM moderation.audit_events"))).toBe(false);
    await app.close();
  });

  it("does not allow ordinary users to change report status", async () => {
    const pool = makePool();
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/moderation/reports/00000000-0000-4000-8000-000000000004",
      headers: { cookie },
      payload: { status: "resolved", note: "Reviewed" }
    });
    expect(response.statusCode).toBe(403);
    expect(pool.statements.some((sql) => sql.includes("UPDATE moderation.reports"))).toBe(false);
    await app.close();
  });

  it("does not allow a user to appeal another reporter's case", async () => {
    const pool = makePool();
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "POST",
      url: "/v1/reports/00000000-0000-4000-8000-000000000004/appeals",
      headers: { cookie },
      payload: { details: "I believe this decision was incorrect." }
    });
    expect(response.statusCode).toBe(404);
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.appeals"))).toBe(
      false
    );
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
});
