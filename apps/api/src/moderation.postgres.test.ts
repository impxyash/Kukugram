import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    const migrationsFolder = fileURLToPath(
      new URL("../../../packages/database/drizzle", import.meta.url)
    );
    const migrations = (await readdir(migrationsFolder))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    const client = await database().connect();
    try {
      for (const filename of migrations) {
        await client.query(await readFile(join(migrationsFolder, filename), "utf8"));
      }
    } finally {
      client.release();
    }
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

  it("allows moderators to review reports but denies admin-only endpoints", async () => {
    const moderator = await seedAdmin();
    await database().query(
      "UPDATE moderation.moderator_roles SET role = 'moderator' WHERE user_id = $1",
      [moderator.userId]
    );
    const appPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const app = buildApp(config, appPool);

    try {
      const queue = await app.inject({
        method: "GET",
        url: "/v1/moderation/reports",
        headers: { cookie: moderator.cookie }
      });
      const audit = await app.inject({
        method: "GET",
        url: "/v1/moderation/audit",
        headers: { cookie: moderator.cookie }
      });
      const roles = await app.inject({
        method: "GET",
        url: "/v1/moderation/roles",
        headers: { cookie: moderator.cookie }
      });

      const grantRole = await app.inject({
        method: "POST",
        url: "/v1/moderation/roles",
        headers: { cookie: moderator.cookie },
        payload: { userId: randomUUID(), role: "moderator" }
      });
      const revokeRole = await app.inject({
        method: "DELETE",
        url: `/v1/moderation/roles/${randomUUID()}/moderator`,
        headers: { cookie: moderator.cookie }
      });

      expect(queue.statusCode).toBe(200);
      expect(audit.statusCode).toBe(403);
      expect(roles.statusCode).toBe(403);
      expect(grantRole.statusCode).toBe(403);
      expect(revokeRole.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

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

  it("preserves historical audit identifiers when an account is deleted", async () => {
    const actorId = randomUUID();
    const reportId = randomUUID();
    const eventId = randomUUID();
    await database().query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
      actorId,
      `${actorId}@retention.test`
    ]);
    await database().query(
      "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category) VALUES ($1, $2, 'profile', $3, 'spam')",
      [reportId, actorId, randomUUID()]
    );
    await database().query(
      "INSERT INTO moderation.audit_events (id, actor_id, action, report_id, subject_user_id) VALUES ($1, $2, 'integration.account_deleted', $3, $2)",
      [eventId, actorId, reportId]
    );

    await database().query("DELETE FROM identity.users WHERE id = $1", [actorId]);

    const event = await database().query(
      'SELECT actor_id AS "actorId", report_id AS "reportId", subject_user_id AS "subjectUserId" FROM moderation.audit_events WHERE id = $1',
      [eventId]
    );
    expect(event.rows).toEqual([{ actorId, reportId, subjectUserId: actorId }]);
    const deletedReport = await database().query(
      "SELECT id FROM moderation.reports WHERE id = $1",
      [reportId]
    );
    expect(deletedReport.rowCount).toBe(0);
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

      const report = await database().query("SELECT status FROM moderation.reports WHERE id = $1", [
        reportId
      ]);
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
    await database().query("DELETE FROM moderation.moderator_roles WHERE role = 'admin'");
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

  it("applies account-deletion retention rules to sessions, notifications, reports, appeals and audit", async () => {
    const deletedUser = await seedAdmin();
    const survivingUser = await seedAdmin();
    const reportId = randomUUID();
    const appealId = randomUUID();
    const auditId = randomUUID();

    await database().query(
      "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category, status) VALUES ($1, $2, 'profile', $3, 'spam', 'resolved')",
      [reportId, deletedUser.userId, randomUUID()]
    );
    await database().query(
      "INSERT INTO moderation.appeals (id, report_id, appellant_id, details) VALUES ($1, $2, $3, $4)",
      [appealId, reportId, deletedUser.userId, "I request a review of this moderation decision."]
    );
    await database().query(
      "INSERT INTO moderation.audit_events (id, actor_id, action, report_id, subject_user_id) VALUES ($1, $2, 'integration.retention_test', $3, $2)",
      [auditId, deletedUser.userId, reportId]
    );
    await database().query(
      "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type) VALUES ($1, $2, $3, 'follow'), ($4, $3, $2, 'follow')",
      [randomUUID(), survivingUser.userId, deletedUser.userId, randomUUID()]
    );

    await database().query("DELETE FROM identity.users WHERE id = $1", [deletedUser.userId]);

    const sessions = await database().query("SELECT id FROM identity.sessions WHERE user_id = $1", [
      deletedUser.userId
    ]);
    expect(sessions.rowCount).toBe(0);

    const roles = await database().query(
      "SELECT user_id FROM moderation.moderator_roles WHERE user_id = $1",
      [deletedUser.userId]
    );
    expect(roles.rowCount).toBe(0);

    const deletedRecipientNotifications = await database().query(
      "SELECT id FROM notifications.notifications WHERE recipient_id = $1",
      [deletedUser.userId]
    );
    expect(deletedRecipientNotifications.rowCount).toBe(0);

    const survivingRecipientNotification = await database().query(
      'SELECT actor_id AS "actorId" FROM notifications.notifications WHERE recipient_id = $1',
      [survivingUser.userId]
    );
    expect(survivingRecipientNotification.rows).toEqual([{ actorId: null }]);

    const deletedReport = await database().query(
      "SELECT id FROM moderation.reports WHERE id = $1",
      [reportId]
    );
    const deletedAppeal = await database().query(
      "SELECT id FROM moderation.appeals WHERE id = $1",
      [appealId]
    );
    expect(deletedReport.rowCount).toBe(0);
    expect(deletedAppeal.rowCount).toBe(0);

    const retainedAudit = await database().query(
      'SELECT actor_id AS "actorId", report_id AS "reportId", subject_user_id AS "subjectUserId" FROM moderation.audit_events WHERE id = $1',
      [auditId]
    );
    expect(retainedAudit.rows).toEqual([
      { actorId: deletedUser.userId, reportId, subjectUserId: deletedUser.userId }
    ]);
  });

  it("serializes concurrent appeal submissions and records only one appeal", async () => {
    const appellant = await seedAdmin();
    const reportId = randomUUID();
    await database().query(
      "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category, status) VALUES ($1, $2, 'profile', $3, 'spam', 'resolved')",
      [reportId, appellant.userId, randomUUID()]
    );
    const appPool = new Pool({ connectionString: databaseUrl, max: 8 });
    const app = buildApp(config, appPool);

    try {
      const submit = () =>
        app.inject({
          method: "POST",
          url: `/v1/reports/${reportId}/appeals`,
          headers: { cookie: appellant.cookie },
          payload: { details: "I disagree with this moderation decision and request a review." }
        });
      const responses = await Promise.all([submit(), submit()]);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
      const persisted = await database().query(
        "SELECT id FROM moderation.appeals WHERE report_id = $1",
        [reportId]
      );
      expect(persisted.rowCount).toBe(1);
      const audit = await database().query(
        "SELECT id FROM moderation.audit_events WHERE report_id = $1 AND action = 'appeal.submitted'",
        [reportId]
      );
      expect(audit.rowCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("enforces appeal ownership and closed-report eligibility in PostgreSQL", async () => {
    const appellant = await seedAdmin();
    const otherUser = await seedAdmin();
    const ownedOpenReport = randomUUID();
    const foreignClosedReport = randomUUID();
    await database().query(
      "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category, status) VALUES ($1, $2, 'profile', $3, 'spam', 'open'), ($4, $5, 'profile', $6, 'spam', 'resolved')",
      [
        ownedOpenReport,
        appellant.userId,
        randomUUID(),
        foreignClosedReport,
        otherUser.userId,
        randomUUID()
      ]
    );
    const appPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const app = buildApp(config, appPool);

    try {
      const openReportAppeal = await app.inject({
        method: "POST",
        url: `/v1/reports/${ownedOpenReport}/appeals`,
        headers: { cookie: appellant.cookie },
        payload: { details: "I would like to appeal this decision anyway." }
      });
      const foreignReportAppeal = await app.inject({
        method: "POST",
        url: `/v1/reports/${foreignClosedReport}/appeals`,
        headers: { cookie: appellant.cookie },
        payload: { details: "I would like to appeal this other user's decision." }
      });

      expect(openReportAppeal.statusCode).toBe(409);
      expect(foreignReportAppeal.statusCode).toBe(404);
      const appeals = await database().query(
        "SELECT id FROM moderation.appeals WHERE report_id = ANY($1::uuid[])",
        [[ownedOpenReport, foreignClosedReport]]
      );
      expect(appeals.rowCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});
