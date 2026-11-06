import { z } from "zod";

export const serviceEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url()
});

export function parseEnvironment<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  environment: NodeJS.ProcessEnv = process.env
): z.infer<z.ZodObject<T>> {
  return schema.parse(environment);
}
