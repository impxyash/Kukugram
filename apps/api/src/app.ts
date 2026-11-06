import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { createDatabase } from "@kukugram/database";
import { ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import { identityRoutes } from "./modules/identity/routes.js";
import { socialRoutes } from "./modules/social/routes.js";
import "./platform/database.js";

export function buildApp(config: ApiConfig) {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    genReqId: () => crypto.randomUUID()
  });
  const { pool } = createDatabase(config.DATABASE_URL);
  app.decorate("config", config);
  app.decorate("pool", pool);
  app.addHook("onClose", async () => pool.end());

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
