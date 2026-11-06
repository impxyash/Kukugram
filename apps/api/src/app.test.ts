import { describe, expect, it } from "vitest";
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
