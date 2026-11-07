import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { RateLimitStore } from "./platform/rate-limit.js";
import {
  authProvidersResponseSchema,
  healthResponseSchema,
  problemDetailsSchema
} from "@kukugram/api-contract";

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
  it("publishes health and identity response media types in OpenAPI", async () => {
    const app = buildApp(config);
    await app.ready();
    const document = app.swagger() as {
      servers?: Array<{ url: string }>;
      paths?: Record<string, { get?: { responses?: Record<string, unknown> } }>;
    };

    expect(document.servers).toEqual([{ url: "/" }]);
    expect(document.paths).toHaveProperty("/health");
    expect(document.paths).toHaveProperty("/v1/auth/providers");
    expect(document.paths).toHaveProperty("/v1/feed");
    expect(document.paths?.["/v1/feed"]?.get?.responses).toHaveProperty(
      "default.content.application/problem+json.schema.$ref",
      "#/components/schemas/ProblemDetails"
    );
    expect(document).toMatchObject({
      components: {
        schemas: {
          ProblemDetails: {
            type: "object",
            required: ["type", "title", "status", "instance", "requestId"],
            properties: {
              type: { type: "string", format: "uri" },
              title: { type: "string" },
              status: { type: "integer", minimum: 400, maximum: 599 },
              detail: { type: "string" },
              instance: { type: "string" },
              requestId: { type: "string" }
            },
            additionalProperties: false
          }
        }
      }
    });

    for (const path of ["/health", "/v1/auth/providers"]) {
      const responses = document.paths?.[path]?.get?.responses;
      const successSchema = responses?.["200"] as
        | { content?: Record<string, { schema?: Record<string, unknown> }> }
        | undefined;
      const problemSchema = responses?.["500"] as
        | { content?: Record<string, { schema?: Record<string, unknown> }> }
        | undefined;

      expect(successSchema?.content).toHaveProperty("application/json");
      expect(successSchema?.content?.["application/json"]?.schema).toHaveProperty("type", "object");
      expect(problemSchema?.content).toHaveProperty("application/problem+json");
      expect(problemSchema?.content?.["application/problem+json"]?.schema).toEqual({
        $ref: "#/components/schemas/ProblemDetails"
      });
    }
    await app.close();
  });

  it("guards the versioned OpenAPI route inventory and shared error contract", async () => {
    const app = buildApp(config);
    await app.ready();
    const document = app.swagger() as {
      paths?: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              {
                content?: Record<
                  string,
                  {
                    schema?: { $ref?: string };
                  }
                >;
              }
            >;
          }
        >
      >;
    };
    const operations = Object.entries(document.paths ?? {}).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map(([method, operation]) => ({ path, method, operation }))
    );
    const versionedOperations = operations.filter(({ path }) => path.startsWith("/v1/"));

    const actualInventory = versionedOperations
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();
    const expectedInventory = [
      "DELETE /v1/me/follow-requests/{handle}",
      "DELETE /v1/moderation/roles/{userId}/{role}",
      "DELETE /v1/posts/{id}",
      "DELETE /v1/posts/{id}/like",
      "DELETE /v1/users/{handle}/block",
      "DELETE /v1/users/{handle}/follow",
      "DELETE /v1/users/{handle}/mute",
      "GET /v1/auth/providers",
      "GET /v1/feed",
      "GET /v1/me",
      "GET /v1/me/appeals",
      "GET /v1/me/blocked",
      "GET /v1/me/follow-requests",
      "GET /v1/me/muted",
      "GET /v1/me/reports",
      "GET /v1/moderation/appeals",
      "GET /v1/moderation/appeals/{id}",
      "GET /v1/moderation/audit",
      "GET /v1/moderation/reports",
      "GET /v1/moderation/reports/{id}",
      "GET /v1/moderation/roles",
      "GET /v1/notifications",
      "GET /v1/posts/{id}/comments",
      "GET /v1/users/{handle}",
      "GET /v1/users/search",
      "PATCH /v1/me/profile",
      "PATCH /v1/moderation/appeals/{id}",
      "PATCH /v1/moderation/reports/{id}",
      "POST /v1/auth/login",
      "POST /v1/auth/logout",
      "POST /v1/auth/signup",
      "POST /v1/me/follow-requests/{handle}/accept",
      "POST /v1/moderation/audit/resolve-actor",
      "POST /v1/moderation/roles",
      "POST /v1/notifications/read",
      "POST /v1/posts",
      "POST /v1/posts/{id}/comments",
      "POST /v1/posts/{id}/like",
      "POST /v1/reports",
      "POST /v1/reports/{id}/appeals",
      "POST /v1/users/{handle}/block",
      "POST /v1/users/{handle}/follow",
      "POST /v1/users/{handle}/mute"
    ].sort();

    expect(actualInventory).toEqual(expectedInventory);
    expect(new Set(versionedOperations.map(({ method }) => method))).toEqual(
      new Set(["get", "post", "patch", "delete"])
    );
    for (const { path, method, operation } of versionedOperations) {
      expect(
        operation.responses?.default?.content?.["application/problem+json"]?.schema?.$ref,
        `${method.toUpperCase()} ${path} must document Problem Details`
      ).toBe("#/components/schemas/ProblemDetails");
    }
    await app.close();
  });

  it("documents every path parameter in the generated OpenAPI operations", async () => {
    const app = buildApp(config);
    await app.ready();
    const document = app.swagger() as {
      paths?: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{ in?: string; name?: string; required?: boolean }>;
          }
        >
      >;
    };

    for (const [path, methods] of Object.entries(document.paths ?? {})) {
      if (!path.startsWith("/v1/")) continue;
      const expectedNames = Array.from(
        path.matchAll(/\{([^}]+)\}/g),
        (match) => match[1] ?? ""
      ).sort();
      if (expectedNames.length === 0) continue;

      for (const [method, operation] of Object.entries(methods)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        const pathParameters = (operation.parameters ?? []).filter(
          (parameter) => parameter.in === "path"
        );
        expect(
          pathParameters.map((parameter) => parameter.name).sort(),
          `${method.toUpperCase()} ${path} must document all path parameters`
        ).toEqual(expectedNames);
        for (const parameter of pathParameters) {
          expect(parameter.required).toBe(true);
        }
      }
    }

    await app.close();
  });

  it("returns request-correlated health, identity and Problem Details responses", async () => {
    const app = buildApp(config);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const healthBody = healthResponseSchema.parse(health.json());
    expect(healthBody.status).toBe("ok");
    expect(healthBody.requestId).toEqual(expect.any(String));

    const providers = await app.inject({ method: "GET", url: "/v1/auth/providers" });
    expect(providers.statusCode).toBe(200);
    expect(authProvidersResponseSchema.parse(providers.json())).toEqual({
      password: true,
      oauth: []
    });

    const invalidLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {}
    });
    expect(invalidLogin.statusCode).toBe(400);
    expect(invalidLogin.headers["content-type"]).toContain("application/problem+json");
    const problemDetails = problemDetailsSchema.parse(invalidLogin.json());
    expect(problemDetails).toMatchObject({
      type: "https://kukugram.com/problems/validation",
      title: "Invalid request",
      status: 400,
      instance: "/v1/auth/login",
    });
    expect(typeof problemDetails.requestId).toBe("string");
    expect(problemDetails.requestId.length).toBeGreaterThan(0);
    expect(problemDetails).not.toHaveProperty("unexpected");
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

  it("uses Railway X-Real-IP and ignores caller-controlled X-Forwarded-For", async () => {
    const app = buildApp(config);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: {
          "x-real-ip": "203.0.113.44",
          "x-forwarded-for": `198.51.100.${attempt + 1}`
        },
        payload: {}
      });
      expect(response.statusCode).toBe(400);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: {
        "x-real-ip": "203.0.113.44",
        "x-forwarded-for": "192.0.2.77"
      },
      payload: {}
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("fails closed when production public-ingress client IP is missing", async () => {
    const productionConfig = { ...config, NODE_ENV: "production" as const };
    const store: RateLimitStore = {
      connect: () => Promise.resolve(),
      consume: () => Promise.resolve({ count: 1, ttlMs: 900_000 }),
      close: () => Promise.resolve()
    };
    const app = buildApp(productionConfig, undefined, store, true);
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {}
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    await app.close();
  });

  it("fails closed during Redis errors and resumes after the store recovers", async () => {
    let available = false;
    const store: RateLimitStore = {
      connect: () => Promise.resolve(),
      consume: () => {
        if (!available) return Promise.reject(new Error("simulated Redis outage"));
        return Promise.resolve({ count: 1, ttlMs: 900_000 });
      },
      close: () => Promise.resolve()
    };
    const app = buildApp(config, undefined, store);
    const request = {
      method: "POST" as const,
      url: "/v1/auth/login",
      headers: { "x-real-ip": "203.0.113.45" },
      payload: {}
    };

    const unavailable = await app.inject(request);
    expect(unavailable.statusCode).toBe(503);
    available = true;
    const recovered = await app.inject(request);
    expect(recovered.statusCode).toBe(400);
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
      adminIds?: string[];
      reportStatus?: "open" | "reviewing" | "resolved" | "dismissed";
      reportOwnerId?: string;
      duplicateReport?: boolean;
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
        if (sql.includes("ORDER BY user_id FOR UPDATE")) {
          const administrators = (options.adminIds ?? [targetId]).map((userId) => ({ userId }));
          return { rows: administrators, rowCount: administrators.length };
        }
        if (sql.includes("SELECT status FROM moderation.reports WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ status: options.reportStatus ?? "open" }], rowCount: 1 };
        }
        if (
          sql.includes(
            "SELECT status FROM moderation.reports WHERE id = $1 AND reporter_id = $2 FOR UPDATE"
          )
        ) {
          const ownsReport = options.reportOwnerId === values?.[1];
          return {
            rows: ownsReport ? [{ status: options.reportStatus ?? "resolved" }] : [],
            rowCount: ownsReport ? 1 : 0
          };
        }
        if (sql.includes("SELECT id, status FROM moderation.reports")) {
          return {
            rows: [
              {
                id: "00000000-0000-4000-8000-000000000004",
                status: options.reportStatus ?? "reviewing"
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes('SELECT report_id AS "reportId", status FROM moderation.appeals')) {
          return {
            rows: [{ reportId: "00000000-0000-4000-8000-000000000004", status: "open" }],
            rowCount: 1
          };
        }
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
          return options.duplicateReport
            ? { rows: [], rowCount: 0 }
            : { rows: [{ id: "00000000-0000-4000-8000-000000000004" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO social.follows")) {
          return { rows: [{ status: "pending" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(() => ({
        query: (sql: string, values?: unknown[]) => pool.query(sql, values),
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

  it("returns the existing open case when the same reporter submits a duplicate report", async () => {
    const pool = makePool({ duplicateReport: true, reportStatus: "reviewing" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { cookie },
      payload: { targetType: "profile", targetId, category: "spam" }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      reportId: "00000000-0000-4000-8000-000000000004",
      status: "reviewing"
    });
    expect(
      pool.statements.some((sql) =>
        sql.includes("ON CONFLICT (reporter_id, target_type, target_id)")
      )
    ).toBe(true);
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

  it("prevents moderators from changing a report after it has been closed", async () => {
    const pool = makePool({ moderatorRole: "moderator", reportStatus: "resolved" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/moderation/reports/00000000-0000-4000-8000-000000000004",
      headers: { cookie },
      payload: { status: "dismissed", note: "Attempted second decision." }
    });
    expect(response.statusCode).toBe(409);
    expect(pool.statements.some((sql) => sql.includes("UPDATE moderation.reports"))).toBe(false);
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.audit_events"))).toBe(
      false
    );
    expect(pool.statements).toContain("ROLLBACK");
    await app.close();
  });

  it("records moderator report decisions in the audit log", async () => {
    const pool = makePool({ moderatorRole: "moderator" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/moderation/reports/00000000-0000-4000-8000-000000000004",
      headers: { cookie },
      payload: { status: "resolved", note: "Reviewed by safety team." }
    });
    expect(response.statusCode).toBe(200);
    expect(pool.statements.some((sql) => sql.includes("UPDATE moderation.reports"))).toBe(true);
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.audit_events"))).toBe(
      true
    );
    const reportUpdate = pool.statements.findIndex((sql) =>
      sql.includes("UPDATE moderation.reports")
    );
    const auditInsert = pool.statements.findIndex((sql) =>
      sql.includes("INSERT INTO moderation.audit_events")
    );
    const commit = pool.statements.indexOf("COMMIT");
    expect(reportUpdate).toBeGreaterThanOrEqual(0);
    expect(reportUpdate).toBeLessThan(auditInsert);
    expect(auditInsert).toBeLessThan(commit);
    await app.close();
  });

  it("records appeal decisions in the audit log", async () => {
    const pool = makePool({ moderatorRole: "moderator" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/moderation/appeals/00000000-0000-4000-8000-000000000005",
      headers: { cookie },
      payload: { status: "accepted" }
    });
    expect(response.statusCode).toBe(200);
    expect(pool.statements.some((sql) => sql.includes("UPDATE moderation.appeals"))).toBe(true);
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.audit_events"))).toBe(
      true
    );
    const appealUpdate = pool.statements.findIndex((sql) =>
      sql.includes("UPDATE moderation.appeals")
    );
    const auditInsert = pool.statements.findIndex((sql) =>
      sql.includes("INSERT INTO moderation.audit_events")
    );
    const commit = pool.statements.indexOf("COMMIT");
    expect(appealUpdate).toBeGreaterThanOrEqual(0);
    expect(appealUpdate).toBeLessThan(auditInsert);
    expect(auditInsert).toBeLessThan(commit);
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

  it("allows revoking an administrator when another administrator remains", async () => {
    const pool = makePool({ moderatorRole: "admin", adminIds: [viewerId, targetId] });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/moderation/roles/${targetId}/admin`,
      headers: { cookie }
    });
    expect(response.statusCode).toBe(204);
    expect(
      pool.statements.some((sql) => sql.includes("DELETE FROM moderation.moderator_roles"))
    ).toBe(true);
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.audit_events"))).toBe(
      true
    );
    expect(pool.statements).toContain("COMMIT");
    await app.close();
  });

  it("prevents revoking the only remaining administrator", async () => {
    const pool = makePool({ moderatorRole: "admin" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/moderation/roles/${targetId}/admin`,
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

  it("allows only the original reporter to submit an appeal for a closed report", async () => {
    const pool = makePool({ reportOwnerId: viewerId, reportStatus: "resolved" });
    const app = appWithPool(pool);
    const response = await app.inject({
      method: "POST",
      url: "/v1/reports/00000000-0000-4000-8000-000000000004/appeals",
      headers: { cookie },
      payload: { details: "I believe this decision was incorrect." }
    });
    expect(response.statusCode).toBe(202);
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.appeals"))).toBe(
      true
    );
    expect(pool.statements.some((sql) => sql.includes("INSERT INTO moderation.audit_events"))).toBe(
      true
    );
    expect(pool.statements).toContain("COMMIT");
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
