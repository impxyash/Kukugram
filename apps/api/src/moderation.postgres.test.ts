import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashSessionToken } from "./platform/auth/session.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL moderation guarantees", () => {
  const pepper = "postgres-integration-test-pepper-long-enough";
  const config = loadConfig({
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:3000",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/kukugram_test",
    REDIS_URL: "redis://localhost:6379",
    SESSION_COOKIE_NAME: "session",
    SESSION_TOKEN_PEPPER: pepper
  });
  let adminPool: Pool | undefined;

  function database() {
    if (!adminPool) throw new Error("PostgreSQL integration pool was not initialized.");
    return adminPool;
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 8 });
    await migrate(drizzle(database()), {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url)
      )
    });
  });

  afterAll(async () => {
    await database().end();
  });

  async function seedAdmin() {
    const userId = randomUUID();
    const token = randomUUID();
    await database().query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@integration.test`
    ]);
    await database().query(
      "INSERT INTO identity.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')",
      [randomUUID(), userId, hashSessionToken(token, pepper)]
    );
    await database().query(
      "INSERT INTO moderation.moderator_roles (user_id, role) VALUES ($1, 'admin')",
      [userId]
    );
    return { userId, token, cookie: `session=${token}` };
  }

  it("rejects UPDATE and DELETE against immutable audit events", async () => {
    const actorId = randomUUID();
    const reportId = randomUUID();
    const eventId = randomUUID();
    await database().query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
      actorId,
      `${actorId}@audit.test`
    ]);
    await database().query(
      "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category) VALUES ($1, $2, 'profile', $3, 'spam')",
      [reportId, actorId, randomUUID()]
    );
    await database().query(
      "INSERT INTO moderation.audit_events (id, actor_id, action, report_id) VALUES ($1, $2, 'integration.audit_test', $3)",
      [eventId, actorId, reportId]
    );

    await expect(
      database().query("UPDATE moderation.audit_events SET action = 'tampered' WHERE id = $1", [
        eventId
      ])
    ).rejects.toThrow("Moderation audit events are immutable");
    await expect(
      database().query("DELETE FROM moderation.audit_events WHERE id = $1", [eventId])
    ).rejects.toThrow("Moderation audit events are immutable");

    const persisted = await database().query(
      "SELECT action FROM moderation.audit_events WHERE id = $1",
      [eventId]
    );
    expect(persisted.rows).toEqual([{ action: "integration.audit_test" }]);
  });

  it("rolls back a report decision when its audit insert fails", async () => {
    const admin = await seedAdmin();
    const reportId = randomUUID();
    const reporterId = randomUUID();
    await database().query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
      reporterId,
      `${reporterId}@reporter.test`
    ]);
    await database().query(
      "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category) VALUES ($1, $2, 'profile', $3, 'spam')",
      [reportId, reporterId, randomUUID()]
    );

    const constraint = `test_reject_audit_${randomUUID().replaceAll("-", "")}`;
    await database().query(
      `ALTER TABLE moderation.audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'report.status_changed') NOT VALID`
    );
    const appPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const app = buildApp(config, appPool);
    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/moderation/reports/${reportId}`,
        headers: { cookie: admin.cookie },
        payload: { status: "resolved", note: "Integration rollback test" }
      });
      expect(response.statusCode).toBe(500);

      const report = await database().query(
        "SELECT status FROM moderation.reports WHERE id = $1",
        [reportId]
      );
      expect(report.rows).toEqual([{ status: "open" }]);
      const audit = await database().query(
        "SELECT id FROM moderation.audit_events WHERE report_id = $1",
        [reportId]
      );
      expect(audit.rowCount).toBe(0);
    } finally {
      await app.close();
      await database().query(`ALTER TABLE moderation.audit_events DROP CONSTRAINT ${constraint}`);
    }
  });

  it("never removes both administrators during concurrent role revocations", async () => {
    const first = await seedAdmin();
    const second = await seedAdmin();
    const appPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const app = buildApp(config, appPool);

    try {
      const [firstResponse, secondResponse] = await Promise.all([
        app.inject({
          method: "DELETE",
          url: `/v1/moderation/roles/${second.userId}/admin`,
          headers: { cookie: first.cookie }
        }),
        app.inject({
          method: "DELETE",
          url: `/v1/moderation/roles/${first.userId}/admin`,
          headers: { cookie: second.cookie }
        })
      ]);

      const statuses = [firstResponse.statusCode, secondResponse.statusCode];
      expect(statuses.filter((status) => status === 204)).toHaveLength(1);
      expect(statuses.every((status) => [204, 403, 409].includes(status))).toBe(true);

      const remaining = await database().query(
        "SELECT user_id FROM moderation.moderator_roles WHERE role = 'admin' AND user_id = ANY($1::uuid[])",
        [[first.userId, second.userId]]
      );
      expect(remaining.rowCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});
