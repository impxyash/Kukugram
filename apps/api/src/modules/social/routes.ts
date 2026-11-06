import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashSessionToken, createOpaqueSessionToken } from "../../platform/auth/session.js";
import "../../platform/database.js";

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,30}$/),
  displayName: z.string().trim().min(1).max(60),
  bio: z.string().trim().max(500).optional()
});
const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128)
});
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  privacy: z.enum(["public", "private", "restricted_creator"]).optional()
});
const postSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const commentSchema = z.object({ body: z.string().trim().min(1).max(1000) });

type Viewer = { id: string; email: string };
type PostRow = {
  id: string;
  body: string;
  createdAt: Date;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  likeCount: string;
  commentCount: string;
  likedByViewer: boolean;
  authorId: string;
};

type ProfileRow = {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  followers: string;
  following: string;
  isFollowing: boolean;
  isRequested: boolean;
  privacy: "public" | "private" | "restricted_creator";
  canViewContent: boolean;
  isBlocked: boolean;
};

function sessionCookie(app: FastifyInstance) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: app.config.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    signed: false
  };
}

async function viewer(request: FastifyRequest): Promise<Viewer | null> {
  const token = request.cookies[request.server.config.SESSION_COOKIE_NAME];
  if (!token) return null;
  const tokenHash = hashSessionToken(token, request.server.config.SESSION_TOKEN_PEPPER);
  const result = await request.server.pool.query<Viewer>(
    `SELECT u.id, u.email
     FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

async function requireViewer(request: FastifyRequest): Promise<Viewer> {
  const current = await viewer(request);
  if (!current) throw Object.assign(new Error("Authentication is required."), { statusCode: 401 });
  return current;
}

async function requireModerationRole(
  request: FastifyRequest,
  roles: readonly ("moderator" | "admin")[]
) {
  const current = await requireViewer(request);
  const result = await request.server.pool.query<{ role: "moderator" | "admin" }>(
    "SELECT role FROM moderation.moderator_roles WHERE user_id = $1 AND role = ANY($2::varchar[])",
    [current.id, roles]
  );
  if (!result.rows.length)
    throw Object.assign(new Error("Moderator permission is required."), { statusCode: 403 });
  return current;
}

async function profileFor(
  request: FastifyRequest,
  handle: string,
  viewerId?: string
): Promise<ProfileRow | null> {
  const result = await request.server.pool.query<ProfileRow>(
    `SELECT u.id, p.handle, p.display_name AS "displayName", p.bio, p.avatar_url AS "avatarUrl",
      (SELECT count(*) FROM social.follows f WHERE f.followee_id = u.id AND f.status = 'accepted') AS followers,
      (SELECT count(*) FROM social.follows f WHERE f.follower_id = u.id AND f.status = 'accepted') AS following,
      EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id AND f.status = 'accepted') AS "isFollowing",
      EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id AND f.status = 'pending') AS "isRequested",
      p.privacy AS privacy,
      (p.privacy <> 'private' OR u.id = $2 OR EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id AND f.status = 'accepted'))
        AND NOT EXISTS(SELECT 1 FROM social.blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = u.id)) AS "canViewContent",
      EXISTS(SELECT 1 FROM social.blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = u.id)) AS "isBlocked"
     FROM social.profiles p JOIN identity.users u ON u.id = p.user_id
     WHERE p.handle = $1 AND u.is_active`,
    [handle, viewerId ?? "00000000-0000-0000-0000-000000000000"]
  );
  return result.rows[0] ?? null;
}

async function canViewPost(
  request: FastifyRequest,
  postId: string,
  viewerId?: string
): Promise<boolean> {
  const anonymousViewer = "00000000-0000-0000-0000-000000000000";
  const result = await request.server.pool.query<{ allowed: boolean }>(
    `SELECT (pr.privacy <> 'private' OR p.author_id = $2 OR EXISTS(
        SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = p.author_id AND f.status = 'accepted'
      )) AND NOT EXISTS (
        SELECT 1 FROM social.blocks b WHERE (b.blocker_id = p.author_id AND b.blocked_id = $2)
          OR (b.blocker_id = $2 AND b.blocked_id = p.author_id)
      ) AS allowed
     FROM content.posts p JOIN social.profiles pr ON pr.user_id = p.author_id
     WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [postId, viewerId ?? anonymousViewer]
  );
  return result.rows[0]?.allowed ?? false;
}

function postSelect() {
  return `SELECT p.id, p.body, p.created_at AS "createdAt", pr.handle, pr.display_name AS "displayName", pr.avatar_url AS "avatarUrl",
    (SELECT count(*) FROM content.likes l WHERE l.post_id = p.id) AS "likeCount",
    (SELECT count(*) FROM content.comments c WHERE c.post_id = p.id) AS "commentCount",
    EXISTS(SELECT 1 FROM content.likes l WHERE l.post_id = p.id AND l.user_id = $1) AS "likedByViewer",
    p.author_id AS "authorId"
    FROM content.posts p JOIN social.profiles pr ON pr.user_id = p.author_id`;
}

export const socialRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post("/auth/signup", async (request, reply) => {
    const input = signupSchema.parse(request.body);
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      const userId = randomUUID();
      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      await client.query(
        "INSERT INTO identity.users (id, email, password_hash) VALUES ($1, $2, $3)",
        [userId, input.email.toLowerCase(), passwordHash]
      );
      await client.query(
        "INSERT INTO social.profiles (user_id, handle, display_name, bio) VALUES ($1, $2, $3, $4)",
        [userId, input.handle, input.displayName, input.bio ?? null]
      );
      const token = createOpaqueSessionToken();
      await client.query(
        "INSERT INTO identity.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')",
        [randomUUID(), userId, hashSessionToken(token, app.config.SESSION_TOKEN_PEPPER)]
      );
      await client.query("COMMIT");
      reply.setCookie(app.config.SESSION_COOKIE_NAME, token, sessionCookie(app));
      return reply.code(201).send({ user: await profileFor(request, input.handle, userId) });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw Object.assign(new Error("That email or username is already in use."), {
          statusCode: 409
        });
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await app.pool.query<{ id: string; passwordHash: string; handle: string }>(
      `SELECT u.id, u.password_hash AS "passwordHash", p.handle FROM identity.users u
       JOIN social.profiles p ON p.user_id = u.id WHERE u.email = $1 AND u.is_active`,
      [input.email.toLowerCase()]
    );
    const account = result.rows[0];
    if (!account || !(await argon2.verify(account.passwordHash, input.password))) {
      throw Object.assign(new Error("Email or password is incorrect."), { statusCode: 401 });
    }
    const token = createOpaqueSessionToken();
    await app.pool.query(
      "INSERT INTO identity.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')",
      [randomUUID(), account.id, hashSessionToken(token, app.config.SESSION_TOKEN_PEPPER)]
    );
    reply.setCookie(app.config.SESSION_COOKIE_NAME, token, sessionCookie(app));
    return { user: await profileFor(request, account.handle, account.id) };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[app.config.SESSION_COOKIE_NAME];
    if (token)
      await app.pool.query(
        "UPDATE identity.sessions SET revoked_at = now() WHERE token_hash = $1",
        [hashSessionToken(token, app.config.SESSION_TOKEN_PEPPER)]
      );
    reply.clearCookie(app.config.SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/me", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query<{ handle: string }>(
      "SELECT handle FROM social.profiles WHERE user_id = $1",
      [current.id]
    );
    return { user: await profileFor(request, result.rows[0]!.handle, current.id) };
  });

  app.patch("/me/profile", async (request) => {
    const current = await requireViewer(request);
    const input = profileSchema.parse(request.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [
      ["display_name", input.displayName],
      ["bio", input.bio],
      ["avatar_url", input.avatarUrl],
      ["privacy", input.privacy]
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        fields.push(`${column} = $${values.length}`);
      }
    }
    if (fields.length) {
      values.push(current.id);
      await app.pool.query(
        `UPDATE social.profiles SET ${fields.join(", ")}, updated_at = now() WHERE user_id = $${values.length}`,
        values
      );
    }
    const handle = (
      await app.pool.query<{ handle: string }>(
        "SELECT handle FROM social.profiles WHERE user_id = $1",
        [current.id]
      )
    ).rows[0]!.handle;
    return { user: await profileFor(request, handle, current.id) };
  });

  app.get("/users/search", async (request) => {
    const current = await requireViewer(request);
    const query = z.object({ q: z.string().trim().min(1).max(60) }).parse(request.query).q;
    const result = await app.pool.query<ProfileRow>(
      `SELECT u.id, p.handle, p.display_name AS "displayName", p.bio, p.avatar_url AS "avatarUrl",
       (SELECT count(*) FROM social.follows f WHERE f.followee_id = u.id AND f.status = 'accepted') AS followers,
       (SELECT count(*) FROM social.follows f WHERE f.follower_id = u.id AND f.status = 'accepted') AS following,
       EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id AND f.status = 'accepted') AS "isFollowing",
       EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id AND f.status = 'pending') AS "isRequested",
       p.privacy AS privacy,
       (p.privacy <> 'private' OR EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id AND f.status = 'accepted')) AS "canViewContent",
       false AS "isBlocked"
       FROM social.profiles p JOIN identity.users u ON u.id = p.user_id
       WHERE (p.handle ILIKE $1 OR p.display_name ILIKE $1) AND u.id <> $2
         AND NOT EXISTS(SELECT 1 FROM social.blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = u.id))
       ORDER BY p.handle LIMIT 20`,
      [`%${query}%`, current.id]
    );
    return { users: result.rows };
  });

  app.get("/users/:handle", async (request) => {
    const current = await viewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const profile = await profileFor(request, handle, current?.id);
    if (!profile || profile.isBlocked)
      throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    return { user: profile };
  });

  app.post("/users/:handle/follow", async (request) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const target = await profileFor(request, handle, current.id);
    if (!target) throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    if (target.id === current.id)
      throw Object.assign(new Error("You cannot follow yourself."), { statusCode: 400 });
    if (target.isBlocked)
      throw Object.assign(new Error("This profile is unavailable."), { statusCode: 404 });
    const status = target.privacy === "private" ? "pending" : "accepted";
    const inserted = await app.pool.query(
      "INSERT INTO social.follows (follower_id, followee_id, status) VALUES ($1, $2, $3) ON CONFLICT (follower_id, followee_id) DO UPDATE SET status = EXCLUDED.status WHERE social.follows.status = 'pending' AND EXCLUDED.status = 'accepted' RETURNING status",
      [current.id, target.id, status]
    );
    if (inserted.rowCount)
      await app.pool.query(
        "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type) VALUES ($1, $2, $3, $4)",
        [randomUUID(), target.id, current.id, status === "pending" ? "follow_request" : "follow"]
      );
    return { user: await profileFor(request, handle, current.id) };
  });

  app.get("/me/follow-requests", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query(
      `SELECT u.id, p.handle, p.display_name AS "displayName", p.avatar_url AS "avatarUrl", f.created_at AS "requestedAt"
       FROM social.follows f JOIN identity.users u ON u.id = f.follower_id
       JOIN social.profiles p ON p.user_id = u.id
       WHERE f.followee_id = $1 AND f.status = 'pending' AND u.is_active
       ORDER BY f.created_at DESC LIMIT 100`,
      [current.id]
    );
    return { requests: result.rows };
  });

  app.post("/me/follow-requests/:handle/accept", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const result = await app.pool.query<{ follower_id: string }>(
      `UPDATE social.follows f SET status = 'accepted'
       FROM social.profiles p WHERE f.follower_id = p.user_id AND p.handle = $1
         AND f.followee_id = $2 AND f.status = 'pending' RETURNING f.follower_id`,
      [handle, current.id]
    );
    if (!result.rowCount)
      throw Object.assign(new Error("Follow request not found."), { statusCode: 404 });
    await app.pool.query(
      "DELETE FROM notifications.notifications WHERE recipient_id = $1 AND actor_id = $2 AND type = 'follow_request'",
      [current.id, result.rows[0]!.follower_id]
    );
    await app.pool.query(
      "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type) VALUES ($1, $2, $3, 'follow')",
      [randomUUID(), result.rows[0]!.follower_id, current.id]
    );
    return reply.code(204).send();
  });

  app.delete("/me/follow-requests/:handle", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const rejected = await app.pool.query<{ follower_id: string }>(
      `DELETE FROM social.follows f USING social.profiles p
       WHERE f.follower_id = p.user_id AND p.handle = $1 AND f.followee_id = $2 AND f.status = 'pending'
       RETURNING f.follower_id`,
      [handle, current.id]
    );
    if (rejected.rowCount) {
      await app.pool.query(
        "DELETE FROM notifications.notifications WHERE recipient_id = $1 AND actor_id = $2 AND type = 'follow_request'",
        [current.id, rejected.rows[0]!.follower_id]
      );
    }
    return reply.code(204).send();
  });

  app.delete("/users/:handle/follow", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const target = await profileFor(request, handle, current.id);
    if (!target) throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    await app.pool.query("DELETE FROM social.follows WHERE follower_id = $1 AND followee_id = $2", [
      current.id,
      target.id
    ]);
    return reply.code(204).send();
  });

  app.get("/me/blocked", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query<{
      id: string;
      handle: string;
      displayName: string;
      avatarUrl: string | null;
      createdAt: Date;
    }>(
      `SELECT u.id, p.handle, p.display_name AS "displayName", p.avatar_url AS "avatarUrl", b.created_at AS "createdAt"
       FROM social.blocks b JOIN identity.users u ON u.id = b.blocked_id
       JOIN social.profiles p ON p.user_id = u.id
       WHERE b.blocker_id = $1 AND u.is_active
       ORDER BY b.created_at DESC LIMIT 200`,
      [current.id]
    );
    return { users: result.rows };
  });

  app.get("/me/muted", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query<{
      id: string;
      handle: string;
      displayName: string;
      avatarUrl: string | null;
      createdAt: Date;
    }>(
      `SELECT u.id, p.handle, p.display_name AS "displayName", p.avatar_url AS "avatarUrl", m.created_at AS "createdAt"
       FROM social.mutes m JOIN identity.users u ON u.id = m.muted_id
       JOIN social.profiles p ON p.user_id = u.id
       WHERE m.muter_id = $1 AND u.is_active
       ORDER BY m.created_at DESC LIMIT 200`,
      [current.id]
    );
    return { users: result.rows };
  });

  app.post("/users/:handle/block", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const target = await profileFor(request, handle, current.id);
    if (!target) throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    if (target.id === current.id)
      throw Object.assign(new Error("You cannot block yourself."), { statusCode: 400 });
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO social.blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [current.id, target.id]
      );
      await client.query(
        "DELETE FROM social.follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)",
        [current.id, target.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return reply.code(204).send();
  });

  app.delete("/users/:handle/block", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    await app.pool.query(
      "DELETE FROM social.blocks b USING social.profiles p WHERE b.blocked_id = p.user_id AND b.blocker_id = $1 AND p.handle = $2",
      [current.id, handle]
    );
    return reply.code(204).send();
  });

  app.post("/users/:handle/mute", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const target = await profileFor(request, handle, current.id);
    if (!target) throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    if (target.id === current.id)
      throw Object.assign(new Error("You cannot mute yourself."), { statusCode: 400 });
    await app.pool.query(
      "INSERT INTO social.mutes (muter_id, muted_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [current.id, target.id]
    );
    return reply.code(204).send();
  });

  app.delete("/users/:handle/mute", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    await app.pool.query(
      "DELETE FROM social.mutes m USING social.profiles p WHERE m.muted_id = p.user_id AND m.muter_id = $1 AND p.handle = $2",
      [current.id, handle]
    );
    return reply.code(204).send();
  });

  app.get("/me/reports", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query<{
      id: string;
      targetType: string;
      category: string;
      status: string;
      createdAt: Date;
    }>(
      `SELECT id, target_type AS "targetType", category, status, created_at AS "createdAt"
       FROM moderation.reports
       WHERE reporter_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [current.id]
    );
    return { reports: result.rows };
  });

  app.get("/moderation/reports", async (request) => {
    await requireModerationRole(request, ["moderator", "admin"]);
    const query = z
      .object({
        status: z.enum(["open", "reviewing", "resolved", "dismissed"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      })
      .parse(request.query);
    const result = await app.pool.query(
      `SELECT r.id, r.target_type AS "targetType", r.target_id AS "targetId",
        r.category, r.details, r.status, r.created_at AS "createdAt",
        r.updated_at AS "updatedAt", r.reporter_id AS "reporterId",
        p.handle AS "reporterHandle"
       FROM moderation.reports r
       JOIN social.profiles p ON p.user_id = r.reporter_id
       WHERE ($1::varchar IS NULL OR r.status = $1)
       ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
         r.created_at ASC
       LIMIT $2`,
      [query.status ?? null, query.limit]
    );
    return { reports: result.rows };
  });

  app.patch("/moderation/reports/:id", async (request, reply) => {
    const actor = await requireModerationRole(request, ["moderator", "admin"]);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z
      .object({
        status: z.enum(["reviewing", "resolved", "dismissed"]),
        note: z.string().trim().max(1000).optional()
      })
      .parse(request.body);
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ status: string }>(
        "SELECT status FROM moderation.reports WHERE id = $1 FOR UPDATE",
        [params.id]
      );
      const previous = current.rows[0]?.status;
      if (!previous) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Report not found."), { statusCode: 404 });
      }
      if (previous === "resolved" || previous === "dismissed") {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Closed reports cannot be changed."), { statusCode: 409 });
      }
      await client.query(
        "UPDATE moderation.reports SET status = $1, updated_at = now() WHERE id = $2",
        [input.status, params.id]
      );
      await client.query(
        "INSERT INTO moderation.audit_events (id, actor_id, action, report_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [
          randomUUID(),
          actor.id,
          "report.status_changed",
          params.id,
          JSON.stringify({ from: previous, to: input.status, note: input.note ?? null })
        ]
      );
      await client.query("COMMIT");
      return reply.code(200).send({ reportId: params.id, status: input.status });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error; the connection is released in finally.
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/reports/:id/appeals", async (request, reply) => {
    const appellant = await requireViewer(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ details: z.string().trim().min(20).max(2000) }).parse(request.body);
    const appealId = randomUUID();
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      const report = await client.query<{ status: string }>(
        "SELECT status FROM moderation.reports WHERE id = $1 AND reporter_id = $2 FOR UPDATE",
        [params.id, appellant.id]
      );
      if (!report.rows[0]) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Report not found."), { statusCode: 404 });
      }
      if (!["resolved", "dismissed"].includes(report.rows[0].status)) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Only closed reports can be appealed."), {
          statusCode: 409
        });
      }
      await client.query(
        "INSERT INTO moderation.appeals (id, report_id, appellant_id, details) VALUES ($1, $2, $3, $4)",
        [appealId, params.id, appellant.id, input.details]
      );
      await client.query(
        "INSERT INTO moderation.audit_events (id, actor_id, action, report_id, details) VALUES ($1, $2, 'appeal.submitted', $3, $4::jsonb)",
        [randomUUID(), appellant.id, params.id, JSON.stringify({ appealId })]
      );
      await client.query("COMMIT");
      return reply.code(202).send({ appealId, status: "open" });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error; the connection is released in finally.
      }
      if ((error as { code?: string }).code === "23505")
        throw Object.assign(new Error("An appeal has already been submitted for this report."), {
          statusCode: 409
        });
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/me/appeals", async (request) => {
    const appellant = await requireViewer(request);
    const result = await app.pool.query(
      `SELECT id, report_id AS "reportId", details, status,
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM moderation.appeals WHERE appellant_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [appellant.id]
    );
    return { appeals: result.rows };
  });

  app.get("/moderation/appeals", async (request) => {
    await requireModerationRole(request, ["moderator", "admin"]);
    const result = await app.pool.query(
      `SELECT a.id, a.report_id AS "reportId", a.appellant_id AS "appellantId",
        p.handle AS "appellantHandle", a.details, a.status,
        a.created_at AS "createdAt"
       FROM moderation.appeals a
       JOIN social.profiles p ON p.user_id = a.appellant_id
       WHERE a.status = 'open' ORDER BY a.created_at ASC LIMIT 100`
    );
    return { appeals: result.rows };
  });

  app.patch("/moderation/appeals/:id", async (request, reply) => {
    const reviewer = await requireModerationRole(request, ["moderator", "admin"]);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ status: z.enum(["accepted", "rejected"]) }).parse(request.body);
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      const appeal = await client.query<{ reportId: string; status: string }>(
        'SELECT report_id AS "reportId", status FROM moderation.appeals WHERE id = $1 FOR UPDATE',
        [params.id]
      );
      const row = appeal.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Appeal not found."), { statusCode: 404 });
      }
      if (row.status !== "open") {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("This appeal has already been reviewed."), {
          statusCode: 409
        });
      }
      await client.query(
        "UPDATE moderation.appeals SET status = $1, reviewer_id = $2, reviewed_at = now(), updated_at = now() WHERE id = $3",
        [input.status, reviewer.id, params.id]
      );
      await client.query(
        "INSERT INTO moderation.audit_events (id, actor_id, action, report_id, details) VALUES ($1, $2, 'appeal.reviewed', $3, $4::jsonb)",
        [
          randomUUID(),
          reviewer.id,
          row.reportId,
          JSON.stringify({ appealId: params.id, status: input.status })
        ]
      );
      if (input.status === "accepted") {
        await client.query(
          "UPDATE moderation.reports SET status = 'reviewing', updated_at = now() WHERE id = $1",
          [row.reportId]
        );
      }
      await client.query("COMMIT");
      return reply.code(200).send({ appealId: params.id, status: input.status });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error; the connection is released in finally.
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/moderation/roles", async (request) => {
    await requireModerationRole(request, ["admin"]);
    const result = await app.pool.query(
      `SELECT r.user_id AS "userId", p.handle, r.role,
        r.granted_by AS "grantedBy", r.granted_at AS "grantedAt"
       FROM moderation.moderator_roles r
       JOIN social.profiles p ON p.user_id = r.user_id
       ORDER BY r.role, p.handle`
    );
    return { roles: result.rows };
  });

  app.post("/moderation/roles", async (request, reply) => {
    const admin = await requireModerationRole(request, ["admin"]);
    const input = z
      .object({
        userId: z.string().uuid(),
        role: z.enum(["moderator", "admin"])
      })
      .parse(request.body);
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO moderation.moderator_roles (user_id, role, granted_by) SELECT id, $2, $3 FROM identity.users WHERE id = $1 AND is_active ON CONFLICT DO NOTHING RETURNING user_id",
        [input.userId, input.role, admin.id]
      );
      if (!inserted.rowCount) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Active user not found or role already assigned."), {
          statusCode: 409
        });
      }
      await client.query(
        "INSERT INTO moderation.audit_events (id, actor_id, action, subject_user_id, details) VALUES ($1, $2, 'moderator.role_granted', $3, $4::jsonb)",
        [randomUUID(), admin.id, input.userId, JSON.stringify({ role: input.role })]
      );
      await client.query("COMMIT");
      return reply.code(201).send({ userId: input.userId, role: input.role });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error; the connection is released in finally.
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/moderation/roles/:userId/:role", async (request, reply) => {
    const admin = await requireModerationRole(request, ["admin"]);
    const params = z
      .object({
        userId: z.string().uuid(),
        role: z.enum(["moderator", "admin"])
      })
      .parse(request.params);
    if (params.userId === admin.id && params.role === "admin")
      throw Object.assign(new Error("You cannot revoke your own admin role."), { statusCode: 409 });
    const client = await app.pool.connect();
    try {
      await client.query("BEGIN");
      if (params.role === "admin") {
        const administrators = await client.query<{ userId: string }>(
          "SELECT user_id AS \"userId\" FROM moderation.moderator_roles WHERE role = 'admin' ORDER BY user_id FOR UPDATE"
        );
        if (administrators.rows.length <= 1 && administrators.rows[0]?.userId === params.userId) {
          await client.query("ROLLBACK");
          throw Object.assign(new Error("The final administrator role cannot be revoked."), {
            statusCode: 409
          });
        }
      }
      const removed = await client.query(
        "DELETE FROM moderation.moderator_roles WHERE user_id = $1 AND role = $2 RETURNING user_id",
        [params.userId, params.role]
      );
      if (!removed.rowCount) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Moderator role not found."), { statusCode: 404 });
      }
      await client.query(
        "INSERT INTO moderation.audit_events (id, actor_id, action, subject_user_id, details) VALUES ($1, $2, 'moderator.role_revoked', $3, $4::jsonb)",
        [randomUUID(), admin.id, params.userId, JSON.stringify({ role: params.role })]
      );
      await client.query("COMMIT");
      return reply.code(204).send();
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error; the connection is released in finally.
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/moderation/audit", async (request) => {
    await requireModerationRole(request, ["admin"]);
    const query = z
      .object({
        reportId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      })
      .parse(request.query);
    const result = await app.pool.query(
      `SELECT id, actor_id AS "actorId", action, report_id AS "reportId",
        subject_user_id AS "subjectUserId", details, created_at AS "createdAt"
       FROM moderation.audit_events
       WHERE ($1::uuid IS NULL OR report_id = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [query.reportId ?? null, query.limit]
    );
    return { events: result.rows };
  });

  app.post("/reports", async (request, reply) => {
    const current = await requireViewer(request);
    const input = z
      .object({
        targetType: z.enum(["profile", "post", "comment"]),
        targetId: z.string().uuid(),
        category: z.enum([
          "harassment",
          "spam",
          "impersonation",
          "self_harm",
          "violence",
          "nudity",
          "copyright",
          "other"
        ]),
        details: z.string().trim().max(1000).optional()
      })
      .parse(request.body);

    let targetOwnerId: string | null = null;
    if (input.targetType === "profile") {
      const target = await app.pool.query<{ userId: string }>(
        'SELECT user_id AS "userId" FROM social.profiles WHERE user_id = $1',
        [input.targetId]
      );
      targetOwnerId = target.rows[0]?.userId ?? null;
    } else if (input.targetType === "post") {
      const target = await app.pool.query<{ authorId: string }>(
        'SELECT author_id AS "authorId" FROM content.posts WHERE id = $1 AND deleted_at IS NULL',
        [input.targetId]
      );
      targetOwnerId = target.rows[0]?.authorId ?? null;
      if (targetOwnerId && !(await canViewPost(request, input.targetId, current.id)))
        targetOwnerId = null;
    } else {
      const target = await app.pool.query<{ authorId: string; postId: string }>(
        'SELECT author_id AS "authorId", post_id AS "postId" FROM content.comments WHERE id = $1',
        [input.targetId]
      );
      targetOwnerId = target.rows[0]?.authorId ?? null;
      if (targetOwnerId && !(await canViewPost(request, target.rows[0]!.postId, current.id)))
        targetOwnerId = null;
    }

    if (!targetOwnerId)
      throw Object.assign(new Error("Report target not found."), { statusCode: 404 });
    if (targetOwnerId === current.id)
      throw Object.assign(new Error("You cannot report your own content."), { statusCode: 400 });

    const reportId = randomUUID();
    const inserted = await app.pool.query<{ id: string }>(
      `INSERT INTO moderation.reports (id, reporter_id, target_type, target_id, category, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (reporter_id, target_type, target_id)
         WHERE status IN ('open', 'reviewing')
       DO NOTHING
       RETURNING id`,
      [
        reportId,
        current.id,
        input.targetType,
        input.targetId,
        input.category,
        input.details ?? null
      ]
    );
    const existing = inserted.rows[0]
      ? null
      : await app.pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM moderation.reports
       WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3
         AND status IN ('open', 'reviewing') LIMIT 1`,
          [current.id, input.targetType, input.targetId]
        );
    const caseId = inserted.rows[0]?.id ?? existing?.rows[0]?.id;
    const caseStatus = inserted.rows[0] ? "open" : existing?.rows[0]?.status;
    return reply.code(202).send({ reportId: caseId, status: caseStatus ?? "open" });
  });

  app.get("/feed", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query<PostRow>(
      `${postSelect()} WHERE p.deleted_at IS NULL
      AND (p.author_id = $1 OR EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id AND f.status = 'accepted'))
      AND NOT EXISTS(SELECT 1 FROM social.mutes m WHERE m.muter_id = $1 AND m.muted_id = p.author_id)
      AND NOT EXISTS(SELECT 1 FROM social.blocks b WHERE (b.blocker_id = p.author_id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = p.author_id))
      AND (p.author_id = $1 OR EXISTS(SELECT 1 FROM social.profiles pr WHERE pr.user_id = p.author_id AND pr.privacy <> 'private')
        OR EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id AND f.status = 'accepted'))
      ORDER BY p.created_at DESC LIMIT 50`,
      [current.id]
    );
    return { posts: result.rows };
  });

  app.post("/posts", async (request, reply) => {
    const current = await requireViewer(request);
    const input = postSchema.parse(request.body);
    const id = randomUUID();
    await app.pool.query("INSERT INTO content.posts (id, author_id, body) VALUES ($1, $2, $3)", [
      id,
      current.id,
      input.body
    ]);
    const result = await app.pool.query<PostRow>(`${postSelect()} WHERE p.id = $2`, [
      current.id,
      id
    ]);
    const post = result.rows[0];
    if (!post) throw new Error("Post could not be loaded.");
    return reply.code(201).send({ post });
  });

  app.delete("/posts/:id", async (request, reply) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const result = await app.pool.query(
      "UPDATE content.posts SET deleted_at = now(), updated_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL",
      [id, current.id]
    );
    if (!result.rowCount) throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    return reply.code(204).send();
  });

  app.post("/posts/:id/like", async (request) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const post = await app.pool.query<{ authorId: string }>(
      'SELECT author_id AS "authorId" FROM content.posts WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (!post.rows[0] || !(await canViewPost(request, id, current.id)))
      throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    const inserted = await app.pool.query(
      "INSERT INTO content.likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING post_id",
      [current.id, id]
    );
    if (inserted.rowCount && post.rows[0].authorId !== current.id)
      await app.pool.query(
        "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, post_id) VALUES ($1, $2, $3, 'like', $4)",
        [randomUUID(), post.rows[0].authorId, current.id, id]
      );
    return { liked: true };
  });

  app.delete("/posts/:id/like", async (request, reply) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    if (!(await canViewPost(request, id, current.id)))
      throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    await app.pool.query("DELETE FROM content.likes WHERE user_id = $1 AND post_id = $2", [
      current.id,
      id
    ]);
    return reply.code(204).send();
  });

  app.get("/posts/:id/comments", async (request) => {
    const current = await viewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    if (!(await canViewPost(request, id, current?.id)))
      throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    const result = await app.pool.query(
      `SELECT c.id, c.body, c.created_at AS "createdAt", p.handle, p.display_name AS "displayName", p.avatar_url AS "avatarUrl" FROM content.comments c JOIN social.profiles p ON p.user_id = c.author_id WHERE c.post_id = $1 ORDER BY c.created_at ASC`,
      [id]
    );
    return { comments: result.rows };
  });

  app.post("/posts/:id/comments", async (request, reply) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const input = commentSchema.parse(request.body);
    const post = await app.pool.query<{ authorId: string }>(
      'SELECT author_id AS "authorId" FROM content.posts WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (!post.rows[0] || !(await canViewPost(request, id, current.id)))
      throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    const commentId = randomUUID();
    await app.pool.query(
      "INSERT INTO content.comments (id, post_id, author_id, body) VALUES ($1, $2, $3, $4)",
      [commentId, id, current.id, input.body]
    );
    if (post.rows[0].authorId !== current.id)
      await app.pool.query(
        "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, post_id, comment_id) VALUES ($1, $2, $3, 'comment', $4, $5)",
        [randomUUID(), post.rows[0].authorId, current.id, id, commentId]
      );
    return reply.code(201).send({ id: commentId, body: input.body });
  });

  app.get("/notifications", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query(
      `SELECT n.id, n.type, n.post_id AS "postId", n.created_at AS "createdAt", n.read_at AS "readAt", p.handle, p.display_name AS "displayName" FROM notifications.notifications n LEFT JOIN social.profiles p ON p.user_id = n.actor_id WHERE n.recipient_id = $1 ORDER BY n.created_at DESC LIMIT 50`,
      [current.id]
    );
    return { notifications: result.rows };
  });

  app.post("/notifications/read", async (request) => {
    const current = await requireViewer(request);
    await app.pool.query(
      "UPDATE notifications.notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL",
      [current.id]
    );
    return { ok: true };
  });

  done();
};
