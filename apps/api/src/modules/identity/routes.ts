import type { FastifyPluginAsync } from "fastify";

export const identityRoutes: FastifyPluginAsync = (app) => {
  app.get(
    "/auth/providers",
    {
      schema: {
        tags: ["Identity"],
        summary: "List configured sign-in providers",
        response: {
          200: {
            type: "object",
            required: ["password", "oauth"],
            properties: {
              password: { type: "boolean" },
              oauth: { type: "array", items: { type: "string" } }
            },
            additionalProperties: false
          },
          500: {
            description: "Internal server error",
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" }
              }
            }
          }
        }
      }
    },
    () => ({ password: true, oauth: [] })
  );
  return Promise.resolve();
};
