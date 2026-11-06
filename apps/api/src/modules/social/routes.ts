import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashSessionToken, createOpaqueSessionToken } from "../../platform/auth/session.js";
import "../../platform/database.js";

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/),
  displayName: z.string().trim().min(1).max(60),
  bio: z.string().trim().max(500).optional()
});
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) });
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional()
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

async function profileFor(request: FastifyRequest, handle: string, viewerId?: string): Promise<ProfileRow | null> {
  const result = await request.server.pool.query<ProfileRow>(
    `SELECT u.id, p.handle, p.display_name AS "displayName", p.bio, p.avatar_url AS "avatarUrl",
      (SELECT count(*) FROM social.follows f WHERE f.followee_id = u.id) AS followers,
      (SELECT count(*) FROM social.follows f WHERE f.follower_id = u.id) AS following,
      EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id) AS "isFollowing"
     FROM social.profiles p JOIN identity.users u ON u.id = p.user_id
     WHERE p.handle = $1 AND u.is_active`,
    [handle, viewerId ?? "00000000-0000-0000-0000-000000000000"]
  );
  return result.rows[0] ?? null;
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
      await client.query("INSERT INTO identity.users (id, email, password_hash) VALUES ($1, $2, $3)", [userId, input.email.toLowerCase(), passwordHash]);
      await client.query(
        "INSERT INTO social.profiles (user_id, handle, display_name, bio) VALUES ($1, $2, $3, $4)",
        [userId, input.handle, input.displayName, input.bio ?? null]
      );
      const token = createOpaqueSessionToken();
      await client.query("INSERT INTO identity.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')", [randomUUID(), userId, hashSessionToken(token, app.config.SESSION_TOKEN_PEPPER)]);
      await client.query("COMMIT");
      reply.setCookie(app.config.SESSION_COOKIE_NAME, token, sessionCookie(app));
      return reply.code(201).send({ user: await profileFor(request, input.handle, userId) });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw Object.assign(new Error("That email or username is already in use."), { statusCode: 409 });
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
    await app.pool.query("INSERT INTO identity.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')", [randomUUID(), account.id, hashSessionToken(token, app.config.SESSION_TOKEN_PEPPER)]);
    reply.setCookie(app.config.SESSION_COOKIE_NAME, token, sessionCookie(app));
    return { user: await profileFor(request, account.handle, account.id) };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[app.config.SESSION_COOKIE_NAME];
    if (token) await app.pool.query("UPDATE identity.sessions SET revoked_at = now() WHERE token_hash = $1", [hashSessionToken(token, app.config.SESSION_TOKEN_PEPPER)]);
    reply.clearCookie(app.config.SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/me", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query<{ handle: string }>("SELECT handle FROM social.profiles WHERE user_id = $1", [current.id]);
    return { user: await profileFor(request, result.rows[0]!.handle, current.id) };
  });

  app.patch("/me/profile", async (request) => {
    const current = await requireViewer(request);
    const input = profileSchema.parse(request.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [["display_name", input.displayName], ["bio", input.bio], ["avatar_url", input.avatarUrl]] as const) {
      if (value !== undefined) { values.push(value); fields.push(`${column} = $${values.length}`); }
    }
    if (fields.length) { values.push(current.id); await app.pool.query(`UPDATE social.profiles SET ${fields.join(", ")}, updated_at = now() WHERE user_id = $${values.length}`, values); }
    const handle = (await app.pool.query<{ handle: string }>("SELECT handle FROM social.profiles WHERE user_id = $1", [current.id])).rows[0]!.handle;
    return { user: await profileFor(request, handle, current.id) };
  });

  app.get("/users/search", async (request) => {
    const current = await requireViewer(request);
    const query = z.object({ q: z.string().trim().min(1).max(60) }).parse(request.query).q;
    const result = await app.pool.query<ProfileRow>(
      `SELECT u.id, p.handle, p.display_name AS "displayName", p.bio, p.avatar_url AS "avatarUrl", '0' AS followers, '0' AS following,
       EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $2 AND f.followee_id = u.id) AS "isFollowing"
       FROM social.profiles p JOIN identity.users u ON u.id = p.user_id
       WHERE (p.handle ILIKE $1 OR p.display_name ILIKE $1) AND u.id <> $2 ORDER BY p.handle LIMIT 20`,
      [`%${query}%`, current.id]
    );
    return { users: result.rows };
  });

  app.get("/users/:handle", async (request) => {
    const current = await viewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const profile = await profileFor(request, handle, current?.id);
    if (!profile) throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    return { user: profile };
  });

  app.post("/users/:handle/follow", async (request) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const target = await profileFor(request, handle, current.id);
    if (!target) throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    if (target.id === current.id) throw Object.assign(new Error("You cannot follow yourself."), { statusCode: 400 });
    const inserted = await app.pool.query("INSERT INTO social.follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING followee_id", [current.id, target.id]);
    if (inserted.rowCount) await app.pool.query("INSERT INTO notifications.notifications (id, recipient_id, actor_id, type) VALUES ($1, $2, $3, 'follow')", [randomUUID(), target.id, current.id]);
    return { user: await profileFor(request, handle, current.id) };
  });

  app.delete("/users/:handle/follow", async (request, reply) => {
    const current = await requireViewer(request);
    const handle = z.object({ handle: z.string() }).parse(request.params).handle.toLowerCase();
    const target = await profileFor(request, handle, current.id);
    if (!target) throw Object.assign(new Error("Profile not found."), { statusCode: 404 });
    await app.pool.query("DELETE FROM social.follows WHERE follower_id = $1 AND followee_id = $2", [current.id, target.id]);
    return reply.code(204).send();
  });

  app.get("/feed", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query<PostRow>(`${postSelect()} WHERE p.deleted_at IS NULL AND (p.author_id = $1 OR EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)) ORDER BY p.created_at DESC LIMIT 50`, [current.id]);
    return { posts: result.rows };
  });

  app.post("/posts", async (request, reply) => {
    const current = await requireViewer(request);
    const input = postSchema.parse(request.body);
    const id = randomUUID();
    await app.pool.query("INSERT INTO content.posts (id, author_id, body) VALUES ($1, $2, $3)", [id, current.id, input.body]);
    const result = await app.pool.query<PostRow>(`${postSelect()} WHERE p.id = $2`, [current.id, id]);
    const post = result.rows[0];
    if (!post) throw new Error("Post could not be loaded.");
    return reply.code(201).send({ post });
  });

  app.delete("/posts/:id", async (request, reply) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const result = await app.pool.query("UPDATE content.posts SET deleted_at = now(), updated_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL", [id, current.id]);
    if (!result.rowCount) throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    return reply.code(204).send();
  });

  app.post("/posts/:id/like", async (request) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const post = await app.pool.query<{ authorId: string }>("SELECT author_id AS \"authorId\" FROM content.posts WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!post.rows[0]) throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    const inserted = await app.pool.query("INSERT INTO content.likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING post_id", [current.id, id]);
    if (inserted.rowCount && post.rows[0].authorId !== current.id) await app.pool.query("INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, post_id) VALUES ($1, $2, $3, 'like', $4)", [randomUUID(), post.rows[0].authorId, current.id, id]);
    return { liked: true };
  });

  app.delete("/posts/:id/like", async (request, reply) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    await app.pool.query("DELETE FROM content.likes WHERE user_id = $1 AND post_id = $2", [current.id, id]);
    return reply.code(204).send();
  });

  app.get("/posts/:id/comments", async (request) => {
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const result = await app.pool.query(`SELECT c.id, c.body, c.created_at AS "createdAt", p.handle, p.display_name AS "displayName", p.avatar_url AS "avatarUrl" FROM content.comments c JOIN social.profiles p ON p.user_id = c.author_id WHERE c.post_id = $1 ORDER BY c.created_at ASC`, [id]);
    return { comments: result.rows };
  });

  app.post("/posts/:id/comments", async (request, reply) => {
    const current = await requireViewer(request);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const input = commentSchema.parse(request.body);
    const post = await app.pool.query<{ authorId: string }>("SELECT author_id AS \"authorId\" FROM content.posts WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!post.rows[0]) throw Object.assign(new Error("Post not found."), { statusCode: 404 });
    const commentId = randomUUID();
    await app.pool.query("INSERT INTO content.comments (id, post_id, author_id, body) VALUES ($1, $2, $3, $4)", [commentId, id, current.id, input.body]);
    if (post.rows[0].authorId !== current.id) await app.pool.query("INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, post_id, comment_id) VALUES ($1, $2, $3, 'comment', $4, $5)", [randomUUID(), post.rows[0].authorId, current.id, id, commentId]);
    return reply.code(201).send({ id: commentId, body: input.body });
  });

  app.get("/notifications", async (request) => {
    const current = await requireViewer(request);
    const result = await app.pool.query(`SELECT n.id, n.type, n.post_id AS "postId", n.created_at AS "createdAt", n.read_at AS "readAt", p.handle, p.display_name AS "displayName" FROM notifications.notifications n LEFT JOIN social.profiles p ON p.user_id = n.actor_id WHERE n.recipient_id = $1 ORDER BY n.created_at DESC LIMIT 50`, [current.id]);
    return { notifications: result.rows };
  });

  app.post("/notifications/read", async (request) => {
    const current = await requireViewer(request);
    await app.pool.query("UPDATE notifications.notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL", [current.id]);
    return { ok: true };
  });

  done();
};
