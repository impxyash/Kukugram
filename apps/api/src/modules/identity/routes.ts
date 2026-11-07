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
                schema: {
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
          }
        }
      }
    },
    () => ({ password: true, oauth: [] })
  );
  return Promise.resolve();
};
