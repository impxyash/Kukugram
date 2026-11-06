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
import { identityRoutes } from "./modules/identity/routes.js";
import { socialRoutes } from "./modules/social/routes.js";
import "./platform/database.js";

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const authAttempts = new Map<string, { count: number; resetAt: number }>();

export function buildApp(config: ApiConfig, poolOverride?: Pool) {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    genReqId: () => crypto.randomUUID()
  });
  const pool = poolOverride ?? createDatabase(config.DATABASE_URL).pool;
  app.decorate("config", config);
  app.decorate("pool", pool);
  app.addHook("onClose", async () => pool.end());

  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || !["/v1/auth/login", "/v1/auth/signup"].includes(request.url.split("?")[0] ?? "")) {
      return;
    }

    const now = Date.now();
    const key = `${request.ip}:${request.url.split("?")[0]}`;
    let bucket = authAttempts.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + AUTH_WINDOW_MS };
      authAttempts.set(key, bucket);
    }

    if (bucket.count >= AUTH_MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
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

    bucket.count += 1;
    if (authAttempts.size > 10_000) {
      for (const [entryKey, entry] of authAttempts) {
        if (entry.resetAt <= now) authAttempts.delete(entryKey);
      }
      if (authAttempts.size > 10_000) {
        const oldestKey = authAttempts.keys().next().value;
        if (oldestKey) authAttempts.delete(oldestKey);
      }
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
