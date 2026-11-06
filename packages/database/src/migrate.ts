import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");

const { db, pool } = createDatabase(databaseUrl);
try {
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
} finally {
  await pool.end();
}
