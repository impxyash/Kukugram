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
  let migrationUpgradeFixture: { userId: string; reportId: string; appealId: string } | undefined;

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
        if (filename === "0005_immutable_audit_references.sql") {
          const userId = randomUUID();
          const reportId = randomUUID();
          const appealId = randomUUID();
          await client.query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
            userId,
            `${userId}@migration-upgrade.test`
          ]);
          await client.query(
            "INSERT INTO social.profiles (user_id, handle, display_name) VALUES ($1, $2, 'Legacy reporter')",
            [userId, `legacy_${userId.replaceAll("-", "").slice(0, 12)}`]
          );
          await client.query(
            "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category, status) VALUES ($1, $2, 'profile', $3, 'spam', 'resolved')",
            [reportId, userId, randomUUID()]
          );
          await client.query(
            "INSERT INTO moderation.appeals (id, report_id, appellant_id, details) VALUES ($1, $2, $3, 'Legacy appeal submitted before pseudonymization migration.')",
            [appealId, reportId, userId]
          );
          migrationUpgradeFixture = { userId, reportId, appealId };
        }
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

  it("upgrades populated moderation cases without losing records or identity-link control", async () => {
    if (!migrationUpgradeFixture) throw new Error("Migration upgrade fixture was not created.");
    const { userId, reportId, appealId } = migrationUpgradeFixture;
    const beforeDeletion = await database().query<{
      reporterId: string | null;
      reporterPseudonymId: string;
      appellantId: string | null;
      appellantPseudonymId: string;
      details: string;
    }>(
      `SELECT r.reporter_id AS "reporterId",
        r.reporter_pseudonym_id AS "reporterPseudonymId",
        a.appellant_id AS "appellantId",
        a.appellant_pseudonym_id AS "appellantPseudonymId",
        a.details
       FROM moderation.reports r
       JOIN moderation.appeals a ON a.report_id = r.id
       WHERE r.id = $1 AND a.id = $2`,
      [reportId, appealId]
    );
    expect(beforeDeletion.rows).toHaveLength(1);
    const beforeRow = beforeDeletion.rows[0];
    if (!beforeRow) throw new Error("Legacy moderation case was not retained.");
    expect(beforeRow.reporterId).toBe(userId);
    expect(beforeRow.appellantId).toBe(userId);
    expect(beforeRow.reporterPseudonymId).toEqual(expect.any(String));
    expect(beforeRow.appellantPseudonymId).toEqual(expect.any(String));
    expect(beforeRow.reporterPseudonymId).not.toBe(userId);
    expect(beforeRow.appellantPseudonymId).not.toBe(userId);
    expect(beforeRow.reporterPseudonymId).not.toBe(beforeRow.appellantPseudonymId);
    expect(beforeRow.details).toBe(
      "Legacy appeal submitted before pseudonymization migration."
    );

    await database().query("DELETE FROM identity.users WHERE id = $1", [userId]);

    const afterDeletion = await database().query<{
      reporterId: string | null;
      reporterPseudonymId: string;
      appellantId: string | null;
      appellantPseudonymId: string;
      details: string;
    }>(
      `SELECT r.reporter_id AS "reporterId",
        r.reporter_pseudonym_id AS "reporterPseudonymId",
        a.appellant_id AS "appellantId",
        a.appellant_pseudonym_id AS "appellantPseudonymId",
        a.details
       FROM moderation.reports r
       JOIN moderation.appeals a ON a.report_id = r.id
       WHERE r.id = $1 AND a.id = $2`,
      [reportId, appealId]
    );
    expect(afterDeletion.rows).toEqual([
      {
        reporterId: null,
        reporterPseudonymId: beforeDeletion.rows[0].reporterPseudonymId,
        appellantId: null,
        appellantPseudonymId: beforeDeletion.rows[0].appellantPseudonymId,
        details: "Legacy appeal submitted before pseudonymization migration."
      }
    ]);
  });

  it("issues production session cookies securely and stores only token hashes", async () => {
    const appPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const app = buildApp({ ...config, NODE_ENV: "production" }, appPool);
    const userId = randomUUID();
    const email = `cookie_${userId}@kukugram.test`;
    const handle = `cookie_${userId.replaceAll("-", "").slice(0, 12)}`;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: {
          email,
          password: "a-strong-test-password-123",
          handle,
          displayName: "Cookie Security Test"
        }
      });

      expect(response.statusCode).toBe(201);
      const setCookie = response.headers["set-cookie"];
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieHeader).toContain("HttpOnly");
      expect(cookieHeader).toContain("Secure");
      expect(cookieHeader).toContain("SameSite=Lax");

      const cookiePair = cookieHeader?.split(";")[0];
      expect(cookiePair).toBeDefined();
      const token = cookiePair!.slice(cookiePair!.indexOf("=") + 1);
      expect(token.length).toBeGreaterThan(20);

      const storedSession = await appPool.query<{ tokenHash: string }>(
        'SELECT s.token_hash AS "tokenHash" FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id WHERE u.email = $1',
        [email]
      );
      expect(storedSession.rows).toEqual([{ tokenHash: hashSessionToken(token, pepper) }]);
      expect(storedSession.rows[0]?.tokenHash).not.toBe(token);
    } finally {
      await app.close();
    }
  });

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
    const retainedReport = await database().query<{
      reporterId: string | null;
      reporterPseudonymId: string;
    }>(
      'SELECT reporter_id AS "reporterId", reporter_pseudonym_id AS "reporterPseudonymId" FROM moderation.reports WHERE id = $1',
      [reportId]
    );
    expect(retainedReport.rows).toHaveLength(1);
    expect(retainedReport.rows[0]?.reporterId).toBeNull();
    expect(retainedReport.rows[0]?.reporterPseudonymId).toEqual(expect.any(String));
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
      "INSERT INTO social.profiles (user_id, handle, display_name) VALUES ($1, $2, 'Deleted reporter')",
      [deletedUser.userId, `deleted_${deletedUser.userId.replaceAll("-", "").slice(0, 12)}`]
    );
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

    const retainedReport = await database().query<{
      reporterId: string | null;
      reporterPseudonymId: string;
    }>(
      'SELECT reporter_id AS "reporterId", reporter_pseudonym_id AS "reporterPseudonymId" FROM moderation.reports WHERE id = $1',
      [reportId]
    );
    const retainedAppeal = await database().query<{
      appellantId: string | null;
      appellantPseudonymId: string;
    }>(
      'SELECT appellant_id AS "appellantId", appellant_pseudonym_id AS "appellantPseudonymId" FROM moderation.appeals WHERE id = $1',
      [appealId]
    );
    expect(retainedReport.rows).toHaveLength(1);
    expect(retainedReport.rows[0]?.reporterId).toBeNull();
    expect(retainedReport.rows[0]?.reporterPseudonymId).toEqual(expect.any(String));
    expect(retainedAppeal.rows).toHaveLength(1);
    expect(retainedAppeal.rows[0]?.appellantId).toBeNull();
    expect(retainedAppeal.rows[0]?.appellantPseudonymId).toEqual(expect.any(String));

    const appPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const app = buildApp(config, appPool);
    try {
      const [reportQueue, appealQueue] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/v1/moderation/reports?status=resolved",
          headers: { cookie: survivingUser.cookie }
        }),
        app.inject({
          method: "GET",
          url: "/v1/moderation/appeals",
          headers: { cookie: survivingUser.cookie }
        })
      ]);
      expect(reportQueue.statusCode).toBe(200);
      expect(appealQueue.statusCode).toBe(200);
      expect(reportQueue.payload).toContain(reportId);
      expect(appealQueue.payload).toContain(appealId);
      expect(
        reportQueue.json<{ reports: { reporterHandle: string | null }[] }>().reports[0]
          ?.reporterHandle
      ).toBeNull();
      expect(
        appealQueue.json<{ appeals: { appellantHandle: string | null }[] }>().appeals[0]
          ?.appellantHandle
      ).toBeNull();
    } finally {
      await app.close();
    }

    const retainedAudit = await database().query(
      'SELECT actor_id AS "actorId", report_id AS "reportId", subject_user_id AS "subjectUserId" FROM moderation.audit_events WHERE id = $1',
      [auditId]
    );
    expect(retainedAudit.rows).toEqual([
      { actorId: deletedUser.userId, reportId, subjectUserId: deletedUser.userId }
    ]);
  });

  it("keeps reports about deleted target accounts visible in the moderator queue", async () => {
    const reporter = await seedAdmin();
    const targetId = randomUUID();
    const reportId = randomUUID();

    const reporterHandle = `reporter_${reporter.userId.replaceAll("-", "").slice(0, 12)}`;
    await database().query(
      "INSERT INTO social.profiles (user_id, handle, display_name) VALUES ($1, $2, 'Report author')",
      [reporter.userId, reporterHandle]
    );
    await database().query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
      targetId,
      `${targetId}@target-retention.test`
    ]);
    await database().query(
      "INSERT INTO social.profiles (user_id, handle, display_name) VALUES ($1, $2, 'Deleted target')",
      [targetId, `target_${targetId.replaceAll("-", "").slice(0, 12)}`]
    );
    await database().query(
      "INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category) VALUES ($1, $2, 'profile', $3, 'impersonation')",
      [reportId, reporter.userId, targetId]
    );

    await database().query("DELETE FROM identity.users WHERE id = $1", [targetId]);

    const retainedReport = await database().query(
      'SELECT id, target_id AS "targetId" FROM moderation.reports WHERE id = $1',
      [reportId]
    );
    expect(retainedReport.rows).toEqual([{ id: reportId, targetId }]);

    const appPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const app = buildApp(config, appPool);
    try {
      const queue = await app.inject({
        method: "GET",
        url: "/v1/moderation/reports",
        headers: { cookie: reporter.cookie }
      });

      expect(queue.statusCode).toBe(200);
      expect(queue.payload).toContain(reportId);
      expect(queue.payload).toContain(targetId);
      expect(queue.payload).toContain(reporterHandle);
      expect(queue.payload).not.toContain(reporter.userId);
    } finally {
      await app.close();
    }
  });

  it("cascades account deletion through authored content and social controls", async () => {
    const deletedUser = await seedAdmin();
    const survivingUser = await seedAdmin();
    const deletedPostId = randomUUID();
    const survivingPostId = randomUUID();
    const deletedAuthorCommentId = randomUUID();
    const deletedPostCommentId = randomUUID();
    const survivingCommentId = randomUUID();
    const deletedPostNotificationId = randomUUID();
    const deletedCommentNotificationId = randomUUID();

    await database().query(
      "INSERT INTO content.posts (id, author_id, body) VALUES ($1, $2, 'Post owned by deleted user'), ($3, $4, 'Post owned by surviving user')",
      [deletedPostId, deletedUser.userId, survivingPostId, survivingUser.userId]
    );
    await database().query(
      "INSERT INTO content.comments (id, post_id, author_id, body) VALUES ($1, $2, $3, 'Comment by deleted user'), ($4, $5, $6, 'Comment on deleted post'), ($7, $8, $9, 'Surviving comment')",
      [
        deletedAuthorCommentId,
        survivingPostId,
        deletedUser.userId,
        deletedPostCommentId,
        deletedPostId,
        survivingUser.userId,
        survivingCommentId,
        survivingPostId,
        survivingUser.userId
      ]
    );
    await database().query(
      "INSERT INTO content.likes (user_id, post_id) VALUES ($1, $2), ($3, $4), ($5, $6)",
      [
        deletedUser.userId,
        survivingPostId,
        survivingUser.userId,
        deletedPostId,
        survivingUser.userId,
        survivingPostId
      ]
    );
    await database().query(
      "INSERT INTO social.follows (follower_id, followee_id) VALUES ($1, $2), ($2, $1)",
      [deletedUser.userId, survivingUser.userId]
    );
    await database().query(
      "INSERT INTO social.blocks (blocker_id, blocked_id) VALUES ($1, $2), ($2, $1)",
      [deletedUser.userId, survivingUser.userId]
    );
    await database().query(
      "INSERT INTO social.mutes (muter_id, muted_id) VALUES ($1, $2), ($2, $1)",
      [deletedUser.userId, survivingUser.userId]
    );
    await database().query(
      "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, post_id, comment_id) VALUES ($1, $2, $3, 'like', $4, NULL), ($5, $2, $3, 'comment', $6, $7)",
      [
        deletedPostNotificationId,
        survivingUser.userId,
        survivingUser.userId,
        deletedPostId,
        deletedCommentNotificationId,
        survivingPostId,
        deletedAuthorCommentId
      ]
    );

    await database().query("DELETE FROM identity.users WHERE id = $1", [deletedUser.userId]);

    const deletedPosts = await database().query(
      "SELECT id FROM content.posts WHERE author_id = $1",
      [deletedUser.userId]
    );
    const survivingPost = await database().query("SELECT id FROM content.posts WHERE id = $1", [
      survivingPostId
    ]);
    const deletedComments = await database().query(
      "SELECT id FROM content.comments WHERE id = ANY($1::uuid[])",
      [[deletedAuthorCommentId, deletedPostCommentId]]
    );
    const survivingComment = await database().query(
      "SELECT id FROM content.comments WHERE id = $1",
      [survivingCommentId]
    );
    const survivingLike = await database().query(
      "SELECT user_id, post_id FROM content.likes WHERE user_id = $1 AND post_id = $2",
      [survivingUser.userId, survivingPostId]
    );
    const remainingLikes = await database().query(
      "SELECT user_id, post_id FROM content.likes WHERE user_id = $1 OR post_id = $2",
      [deletedUser.userId, deletedPostId]
    );

    expect(deletedPosts.rowCount).toBe(0);
    expect(survivingPost.rowCount).toBe(1);
    expect(deletedComments.rowCount).toBe(0);
    expect(survivingComment.rowCount).toBe(1);
    expect(survivingLike.rowCount).toBe(1);
    expect(remainingLikes.rowCount).toBe(0);
    const deletedContentNotifications = await database().query(
      "SELECT id FROM notifications.notifications WHERE id = ANY($1::uuid[])",
      [[deletedPostNotificationId, deletedCommentNotificationId]]
    );
    expect(deletedContentNotifications.rowCount).toBe(0);

    const remainingSocialRelations = await database().query(
      "SELECT 'follow' AS relation FROM social.follows WHERE follower_id = $1 OR followee_id = $1 UNION ALL SELECT 'block' FROM social.blocks WHERE blocker_id = $1 OR blocked_id = $1 UNION ALL SELECT 'mute' FROM social.mutes WHERE muter_id = $1 OR muted_id = $1",
      [deletedUser.userId]
    );
    expect(remainingSocialRelations.rowCount).toBe(0);
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
