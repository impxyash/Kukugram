import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import type { Pool } from "pg";
import { createDatabase } from "@kukugram/database";
import { ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import {
  createAuthRateLimitKey,
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  resolveClientIp,
  type RateLimitStore
} from "./platform/rate-limit.js";
import { identityRoutes } from "./modules/identity/routes.js";
import { socialRoutes } from "./modules/social/routes.js";
import "./platform/database.js";

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
export function buildApp(
  config: ApiConfig,
  poolOverride?: Pool,
  rateLimitStoreOverride?: RateLimitStore
) {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    genReqId: () => crypto.randomUUID()
  });
  const pool = poolOverride ?? createDatabase(config.DATABASE_URL).pool;
  const rateLimitStore =
    rateLimitStoreOverride ??
    (config.NODE_ENV === "test"
      ? new InMemoryRateLimitStore()
      : new RedisRateLimitStore(config.REDIS_URL, () => {
          app.log.error("Authentication rate-limit Redis connection error.");
        }));
  app.decorate("config", config);
  app.decorate("pool", pool);
  app.addHook("onReady", async () => {
    try {
      await rateLimitStore.connect();
    } catch {
      throw new Error("Redis rate limiter is unavailable; refusing to start the API.");
    }
  });
  app.addHook("onClose", async () => {
    try {
      await rateLimitStore.close();
    } catch {
      app.log.error("Authentication rate-limit Redis shutdown failed.");
    }
    await pool.end();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method !== "POST" ||
      !["/v1/auth/login", "/v1/auth/signup"].includes(request.url.split("?")[0] ?? "")
    ) {
      return;
    }

    const endpoint = request.url.split("?")[0] ?? "";
    let result: { count: number; ttlMs: number };
    try {
      const clientIp = resolveClientIp(
        request.headers["x-real-ip"],
        request.raw.socket.remoteAddress,
        config.NODE_ENV === "production"
      );
      const key = createAuthRateLimitKey(config.SESSION_TOKEN_PEPPER, clientIp, endpoint);
      result = await rateLimitStore.consume(key, AUTH_WINDOW_MS);
    } catch {
      request.log.error("Authentication rate limiter unavailable.");
      return reply
        .header("retry-after", "5")
        .code(503)
        .type("application/problem+json")
        .send({
          type: "https://kukugram.com/problems/rate-limiter-unavailable",
          title: "Authentication temporarily unavailable",
          status: 503,
          detail: "Please try again shortly.",
          instance: request.url,
          requestId: request.id
        });
    }

    if (result.count > AUTH_MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil(result.ttlMs / 1000));
      return reply
        .header("retry-after", String(retryAfter))
        .code(429)
        .type("application/problem+json")
        .send({
          type: "https://kukugram.com/problems/rate-limit",
          title: "Too many authentication attempts",
          status: 429,
          detail: "Please wait before trying to sign in or create another account.",
          instance: request.url,
          requestId: request.id
        });
    }
  });

  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  app.register(cookie, { hook: "onRequest" });
  app.register(swagger, {
    openapi: {
      info: { title: "Kukugram API", version: "1.0.0" },
      servers: [{ url: "/v1" }]
    }
  });
  app.register(swaggerUi, { routePrefix: "/documentation" });

  app.get("/health", { schema: { hide: true } }, (request) => ({
    status: "ok",
    requestId: request.id
  }));
  app.register(identityRoutes, { prefix: "/v1" });
  app.register(socialRoutes, { prefix: "/v1" });

  app.setErrorHandler((error, request, reply) => {
    const isValidation = error instanceof ZodError || error.validation !== undefined;
    const status = isValidation
      ? 400
      : error.statusCode && error.statusCode < 500
        ? error.statusCode
        : 500;
    request.log.error(error);
    return reply
      .status(status)
      .type("application/problem+json")
      .send({
        type: isValidation
          ? "https://kukugram.com/problems/validation"
          : "https://kukugram.com/problems/internal",
        title: isValidation ? "Invalid request" : "Internal server error",
        status,
        detail: isValidation ? "One or more request fields are invalid." : undefined,
        instance: request.url,
        requestId: request.id
      });
  });

  return app;
}
