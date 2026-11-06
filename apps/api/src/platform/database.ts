import type { Pool } from "pg";
import type { ApiConfig } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    pool: Pool;
    config: ApiConfig;
  }
}

export {};
