import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashSessionToken } from "./platform/auth/session.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!testDatabaseUrl);
const pepper = "feed-pagination-postgres-test-pepper-long-enough";
const databaseName = `kukugram_feed_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

let admin: Client | undefined;
let fixturePool: Pool | undefined;
let isolatedDatabaseUrl: string | undefined;
let config: ReturnType<typeof loadConfig> | undefined;
let databaseCreated = false;

function database() {
  if (!fixturePool) throw new Error("Feed pagination PostgreSQL fixture is not initialized.");
  return fixturePool;
}

function appConfig() {
  if (!config) throw new Error("Feed pagination API config is not initialized.");
  return config;
}

integration("PostgreSQL feed pagination", () => {
  beforeAll(async () => {
    if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for this integration test.");

    const baseUrl = new URL(testDatabaseUrl);
    const databaseNameFromUrl = decodeURIComponent(baseUrl.pathname.replace(/^\//, ""));
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    if (!loopbackHosts.has(baseUrl.hostname) || !/(^|_)test($|_)/i.test(databaseNameFromUrl)) {
      throw new Error(
        "Refusing PostgreSQL feed integration tests unless TEST_DATABASE_URL points to a local database whose name includes 'test'."
      );
    }

    admin = new Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;

    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    isolatedDatabaseUrl = isolatedUrl.toString();
    fixturePool = new Pool({ connectionString: isolatedDatabaseUrl, max: 4 });

    const migrationsFolder = fileURLToPath(
      new URL("../../../packages/database/drizzle", import.meta.url)
    );
    const migrations = (await readdir(migrationsFolder))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();

    for (const filename of migrations) {
      await database().query(await readFile(join(migrationsFolder, filename), "utf8"));
    }

    config = loadConfig({
      NODE_ENV: "test",
      API_HOST: "127.0.0.1",
      WEB_ORIGIN: "http://localhost:3000",
      DATABASE_URL: isolatedDatabaseUrl,
      REDIS_URL: "redis://localhost:6379",
      SESSION_COOKIE_NAME: "session",
      SESSION_TOKEN_PEPPER: pepper
    });
  }, 30_000);

  afterAll(async () => {
    await fixturePool?.end();
    if (!admin) return;

    try {
      if (databaseCreated) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName]
        );
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      }
    } finally {
      await admin.end();
    }
  }, 30_000);

  it("keeps filtered equal-timestamp posts in exact keyset order across page boundaries", async () => {
    const viewerId = randomUUID();
    const viewerToken = randomUUID();
    const authors = {
      acceptedPublic: randomUUID(),
      acceptedPrivate: randomUUID(),
      pendingPrivate: randomUUID(),
      mutedPublic: randomUUID(),
      blockedByViewer: randomUUID(),
      blockedViewer: randomUUID(),
      deletedPublic: randomUUID()
    };
    const authorEntries = Object.entries(authors) as [keyof typeof authors, string][];
    const userIds = [viewerId, ...authorEntries.map(([, id]) => id)];

    for (const [kind, userId] of [["viewer", viewerId] as const, ...authorEntries]) {
      await database().query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
        userId,
        `${kind}-${userId}@feed-pagination.integration.test`
      ]);
      await database().query(
        "INSERT INTO social.profiles (user_id, handle, display_name, privacy) VALUES ($1, $2, $3, $4)",
        [
          userId,
          `feed_${userId.replaceAll("-", "").slice(0, 12)}`,
          kind,
          kind === "acceptedPrivate" || kind === "pendingPrivate" ? "private" : "public"
        ]
      );
    }

    await database().query(
      "INSERT INTO identity.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')",
      [randomUUID(), viewerId, hashSessionToken(viewerToken, pepper)]
    );

    for (const [kind, authorId] of authorEntries) {
      await database().query(
        "INSERT INTO social.follows (follower_id, followee_id, status) VALUES ($1, $2, $3)",
        [viewerId, authorId, kind === "pendingPrivate" ? "pending" : "accepted"]
      );
    }
    await database().query("INSERT INTO social.mutes (muter_id, muted_id) VALUES ($1, $2)", [
      viewerId,
      authors.mutedPublic
    ]);
    await database().query(
      "INSERT INTO social.blocks (blocker_id, blocked_id) VALUES ($1, $2), ($3, $1)",
      [viewerId, authors.blockedByViewer, authors.blockedViewer]
    );

    const createdAt = new Date("2026-11-08T10:00:00.000Z");
    const excludedAuthors: Array<keyof typeof authors> = [
      "pendingPrivate",
      "mutedPublic",
      "blockedByViewer",
      "blockedViewer",
      "deletedPublic"
    ];
    const visibleAuthors = [viewerId, authors.acceptedPublic, authors.acceptedPrivate];
    const expectedVisibleIds: string[] = [];
    const excludedIds: string[] = [];

    for (let index = 1; index <= 72; index += 1) {
      const isExcluded = index % 4 === 0;
      const excludedKind = excludedAuthors[(index / 4 - 1) % excludedAuthors.length]!;
      const authorId = isExcluded
        ? authors[excludedKind]
        : visibleAuthors[(index - 1) % visibleAuthors.length]!;
      const postId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const deleted = isExcluded && excludedKind === "deletedPublic";

      await database().query(
        "INSERT INTO content.posts (id, author_id, body, created_at, deleted_at) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN $4 ELSE NULL END)",
        [postId, authorId, `Feed pagination fixture ${index}`, createdAt, deleted]
      );

      if (isExcluded) excludedIds.push(postId);
      else expectedVisibleIds.push(postId);
    }

    const appPool = new Pool({ connectionString: isolatedDatabaseUrl, max: 4 });
    const app = buildApp(appConfig(), appPool);
    try {
      const headers = { cookie: `session=${viewerToken}` };
      const firstPage = await app.inject({ method: "GET", url: "/v1/feed", headers });
      expect(firstPage.statusCode).toBe(200);
      const firstBody = firstPage.json<{
        posts: Array<{ id: string }>;
        nextCursor?: string;
      }>();
      expect(firstBody.posts).toHaveLength(50);
      expect(firstBody.nextCursor).toEqual(expect.any(String));

      const secondPage = await app.inject({
        method: "GET",
        url: `/v1/feed?cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
        headers
      });
      expect(secondPage.statusCode).toBe(200);
      const secondBody = secondPage.json<{
        posts: Array<{ id: string }>;
        nextCursor?: string;
      }>();
      expect(secondBody.posts).toHaveLength(4);
      expect(secondBody.nextCursor).toBeUndefined();

      const actualIds = [...firstBody.posts, ...secondBody.posts].map((post) => post.id);
      const expectedIds = [...expectedVisibleIds].reverse();
      expect(actualIds).toEqual(expectedIds);
      expect(actualIds).toHaveLength(54);
      expect(new Set(actualIds).size).toBe(54);
      expect(actualIds.some((id) => excludedIds.includes(id))).toBe(false);
    } finally {
      await app.close();
      await database().query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [userIds]);
    }
  }, 30_000);
});
