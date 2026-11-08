#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { Client, Pool } from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Map(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith("--")) all.push([value.slice(2), values[index + 1] ?? "true"]);
  return all;
}, []));
const suite = args.get("suite") ?? "all";
const profile = args.get("profile") ?? "full";
const seed = Number(args.get("seed") ?? "20261109");
if (!["all", "mark-read", "notifications", "feed"].includes(suite)) throw new Error("Invalid --suite.");
if (!["full", "smoke"].includes(profile)) throw new Error("Invalid --profile.");
if (!Number.isSafeInteger(seed)) throw new Error("Seed must be a safe integer.");

const full = profile === "full";
const settings = {
  seed,
  profile,
  warmupMs: full ? 120_000 : 2_000,
  measurementMs: full ? 300_000 : 5_000,
  rounds: full ? 3 : 1,
  workers: [1, 4, 8, 16],
  poolMax: 8,
  chunkSize: 10_000
};
const counts = full
  ? { users: 12_000, posts: 400_000, likes: 120_000, comments: 80_000, notifications: 1_200_000 }
  : { users: 128, posts: 8_000, likes: 1_200, comments: 800, notifications: 12_000 };
const artifactDir = resolve(root, "artifacts/mixed-workload");
await mkdir(artifactDir, { recursive: true });

function assertDisposableTarget() {
  const host = process.env.PGHOST ?? "localhost";
  const port = Number(process.env.PGPORT ?? "5432");
  const user = process.env.PGUSER ?? "postgres";
  const password = process.env.PGPASSWORD ?? "postgres";
  const database = process.env.PGDATABASE ?? "kukugram_bench";
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Safety stop: benchmark refuses non-loopback PostgreSQL hosts.");
  }
  if (!/^kukugram_bench$/.test(database)) {
    throw new Error("Safety stop: PGDATABASE must be exactly kukugram_bench.");
  }
  return { host, port, user, password, database };
}
const target = assertDisposableTarget();
const admin = new Client({ ...target, database: "postgres", application_name: "kukugram-mixed-benchmark-admin" });
await admin.connect();

const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const seedDb = "kg_mwb_seed_" + suffix;
const dbNames = {
  notificationBaseline: "kg_mwb_nb_" + suffix,
  notificationAdditive: "kg_mwb_na_" + suffix,
  notificationReplacement: "kg_mwb_nr_" + suffix,
  feedBaseline: "kg_mwb_fb_" + suffix,
  feedCandidate: "kg_mwb_fc_" + suffix
};
const createdDatabases = [];
const raw = [];
const notes = [];
const errors = [];
let walBefore = null;
let walAfter = null;

function ident(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}
function deterministicUuid(label) {
  const hex = createHash("md5").update(label).digest("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}
function makeRng(value) {
  let state = value >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[index].toFixed(4));
}
function summarize(values) {
  return {
    count: values.length,
    p50_ms: percentile(values, 0.50),
    p95_ms: percentile(values, 0.95),
    p99_ms: percentile(values, 0.99),
    min_ms: values.length ? Number(values.reduce((a, b) => Math.min(a, b), Infinity).toFixed(4)) : null,
    max_ms: values.length ? Number(values.reduce((a, b) => Math.max(a, b), -Infinity).toFixed(4)) : null
  };
}
async function createDatabase(name, template) {
  await admin.query("CREATE DATABASE " + ident(name) + (template ? " TEMPLATE " + ident(template) : ""));
  createdDatabases.push(name);
}
async function connectDb(database, applicationName) {
  const client = new Client({ ...target, database, application_name: applicationName });
  await client.connect();
  return client;
}
async function applyMigrations(database) {
  const client = await connectDb(database, "kukugram-benchmark-migrations");
  try {
    const folder = resolve(root, "packages/database/drizzle");
    const files = (await readdir(folder)).filter((name) => /^[0-9].*\.sql$/.test(name)).sort();
    for (const file of files) {
      await client.query(await readFile(resolve(folder, file), "utf8"));
    }
  } finally {
    await client.end();
  }
}
async function seedDatabase(database) {
  const client = await connectDb(database, "kukugram-benchmark-seed");
  const users = counts.users;
  const posts = counts.posts;
  const likes = counts.likes;
  const comments = counts.comments;
  const notifications = counts.notifications;
  try {
    await client.query("SET synchronous_commit = on");
    await client.query(
      "INSERT INTO identity.users (id, email) SELECT md5('kukugram-mwb-user-' || n)::uuid, 'mwb-user-' || n || '@example.invalid' FROM generate_series(1, $1) AS n",
      [users]
    );
    await client.query(
      "INSERT INTO social.profiles (user_id, handle, display_name, privacy) SELECT md5('kukugram-mwb-user-' || n)::uuid, 'mwb_' || n, 'Mixed Workload User ' || n, CASE WHEN n % 20 = 0 THEN 'private' ELSE 'public' END FROM generate_series(1, $1) AS n",
      [users]
    );
    const dense = Math.min(660, users - 24);
    const sparse = Math.min(5, users - 24);
    const high = Math.min(5_000, users - 24);
    await client.query(
      "INSERT INTO social.follows (follower_id, followee_id, status) SELECT md5('kukugram-mwb-user-1')::uuid, md5('kukugram-mwb-user-' || n)::uuid, 'accepted' FROM generate_series(25, $1) AS n",
      [24 + dense]
    );
    await client.query(
      "INSERT INTO social.follows (follower_id, followee_id, status) SELECT md5('kukugram-mwb-user-2')::uuid, md5('kukugram-mwb-user-' || n)::uuid, 'accepted' FROM generate_series(25, $1) AS n",
      [24 + sparse]
    );
    await client.query(
      "INSERT INTO social.follows (follower_id, followee_id, status) SELECT md5('kukugram-mwb-user-3')::uuid, md5('kukugram-mwb-user-' || n)::uuid, 'accepted' FROM generate_series(25, $1) AS n",
      [24 + high]
    );
    await client.query(
      "INSERT INTO social.mutes (muter_id, muted_id) SELECT md5('kukugram-mwb-user-1')::uuid, md5('kukugram-mwb-user-' || n)::uuid FROM generate_series(600, 620) AS n WHERE n <= $1",
      [users]
    );
    await client.query(
      "INSERT INTO social.blocks (blocker_id, blocked_id) SELECT md5('kukugram-mwb-user-1')::uuid, md5('kukugram-mwb-user-' || n)::uuid FROM generate_series(621, 630) AS n WHERE n <= $1",
      [users]
    );
    await client.query(
      "INSERT INTO content.posts (id, author_id, body, created_at, deleted_at) SELECT md5('kukugram-mwb-post-' || n)::uuid, md5('kukugram-mwb-user-' || (mod(n * 37, $1 - 24) + 25))::uuid, 'Mixed workload synthetic post ' || n, now() - (mod(n, 129600)::text || ' minutes')::interval, CASE WHEN n % 97 = 0 THEN now() ELSE NULL END FROM generate_series(1, $2) AS n",
      [users, posts]
    );
    await client.query(
      "INSERT INTO content.likes (user_id, post_id) SELECT md5('kukugram-mwb-user-' || (mod(n * 13, $1 - 24) + 25))::uuid, md5('kukugram-mwb-post-' || n)::uuid FROM generate_series(1, $2) AS n",
      [users, likes]
    );
    await client.query(
      "INSERT INTO content.comments (id, post_id, author_id, body) SELECT md5('kukugram-mwb-comment-' || n)::uuid, md5('kukugram-mwb-post-' || n)::uuid, md5('kukugram-mwb-user-' || (mod(n * 17, $1 - 24) + 25))::uuid, 'Mixed workload comment ' || n FROM generate_series(1, $2) AS n",
      [users, comments]
    );
    await client.query(
      "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, created_at, read_at) SELECT md5('kukugram-mwb-notification-' || n)::uuid, md5('kukugram-mwb-user-' || (mod(n * 29, $1 - 24) + 25))::uuid, md5('kukugram-mwb-user-' || (mod(n * 17, $1 - 24) + 25))::uuid, 'follow', now() - (mod(n, 129600)::text || ' minutes')::interval, CASE WHEN n % 5 = 0 THEN NULL ELSE now() END FROM generate_series(1, $2) AS n",
      [users, notifications]
    );
    await client.query(
      "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, created_at) SELECT md5('kukugram-mwb-page-' || n)::uuid, md5('kukugram-mwb-user-1')::uuid, md5('kukugram-mwb-user-2')::uuid, 'follow', now() - (n::text || ' minutes')::interval FROM generate_series(1, 1000) AS n"
    );
    const markCounts = [50, 500, 2_000, 10_000];
    for (let i = 0; i < markCounts.length; i += 1) {
      const recipient = deterministicUuid("kukugram-mwb-user-" + (i + 4));
      await client.query(
        "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, created_at) SELECT md5('kukugram-mwb-mark-' || $1 || '-' || n)::uuid, $2::uuid, md5('kukugram-mwb-user-2')::uuid, 'follow', now() - (n::text || ' seconds')::interval FROM generate_series(1, $3) AS n",
        [i, recipient, markCounts[i]]
      );
    }
    for (let worker = 0; worker < 16; worker += 1) {
      const recipient = deterministicUuid("kukugram-mwb-user-" + (worker + 8));
      await client.query(
        "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, created_at) SELECT md5('kukugram-mwb-mix-' || $1 || '-' || n)::uuid, $2::uuid, md5('kukugram-mwb-user-2')::uuid, 'follow', now() - (n::text || ' seconds')::interval FROM generate_series(1, 50) AS n",
        [worker, recipient]
      );
    }
    await client.query("ANALYZE");
  } finally {
    await client.end();
  }
}
async function hashTable(database, table, columns) {
  const client = await connectDb(database, "kukugram-benchmark-checksum");
  const chunks = [];
  let lastId = null;
  let rowCount = 0;
  try {
    while (true) {
      const condition = lastId ? "WHERE id > $1::uuid" : "";
      const values = lastId ? [lastId, settings.chunkSize] : [settings.chunkSize];
      const limitParam = lastId ? "$2" : "$1";
      const result = await client.query(
        "SELECT " + columns.join(", ") + " FROM " + table + " " + condition + " ORDER BY id LIMIT " + limitParam,
        values
      );
      if (!result.rows.length) break;
      const hash = createHash("sha256");
      for (const row of result.rows) {
        const normalized = {};
        for (const key of Object.keys(row)) {
          const value = row[key];
          normalized[key] = value instanceof Date ? value.toISOString() : value;
        }
        hash.update(JSON.stringify(normalized) + "\n");
      }
      chunks.push({ first_id: result.rows[0].id, last_id: result.rows[result.rows.length - 1].id, rows: result.rows.length, sha256: hash.digest("hex") });
      rowCount += result.rows.length;
      lastId = result.rows[result.rows.length - 1].id;
      if (result.rows.length < settings.chunkSize) break;
    }
  } finally {
    await client.end();
  }
  const rootHash = createHash("sha256").update(JSON.stringify(chunks)).digest("hex");
  return { table, row_count: rowCount, chunk_size: settings.chunkSize, chunks, root_sha256: rootHash };
}
async function checksumDatabase(database) {
  const [posts, notifications] = await Promise.all([
    hashTable(database, "content.posts", ["id", "author_id", "body", "created_at", "updated_at", "deleted_at"]),
    hashTable(database, "notifications.notifications", ["id", "recipient_id", "actor_id", "type", "post_id", "comment_id", "created_at", "read_at"])
  ]);
  return { database, posts, notifications };
}
async function instrumentedPool(database, max) {
  const pool = new Pool({ ...target, database, max, application_name: "kukugram-mixed-workload-runner" });
  await pool.query("SET jit = off");
  return pool;
}
async function acquire(pool) {
  const start = performance.now();
  const client = await pool.connect();
  return { client, waitMs: performance.now() - start };
}
async function recordQuery(pool, sql, values, record, label, group, variant, worker, round) {
  const acquired = await acquire(pool);
  const started = performance.now();
  try {
    await acquired.client.query(sql, values);
    const elapsed = performance.now() - started;
    if (record) raw.push({ suite: group, variant, worker_count: worker, round, operation: label, latency_ms: Number(elapsed.toFixed(4)), pool_wait_ms: Number(acquired.waitMs.toFixed(4)), error: false });
    return { elapsed, wait: acquired.waitMs };
  } catch (error) {
    if (record) {
      errors.push({ suite: group, variant, worker_count: worker, round, operation: label, message: String(error.message).slice(0, 300) });
      raw.push({ suite: group, variant, worker_count: worker, round, operation: label, latency_ms: Number((performance.now() - started).toFixed(4)), pool_wait_ms: Number(acquired.waitMs.toFixed(4)), error: true });
    }
    throw error;
  } finally {
    acquired.client.release();
  }
}
const FEED_SQL = "SELECT p.id, p.body, p.created_at AS \\"createdAt\\", pr.handle, pr.display_name AS \\"displayName\\", pr.avatar_url AS \\"avatarUrl\\", (SELECT count(*) FROM content.likes l WHERE l.post_id = p.id) AS \\"likeCount\\", (SELECT count(*) FROM content.comments c WHERE c.post_id = p.id) AS \\"commentCount\\", EXISTS(SELECT 1 FROM content.likes l WHERE l.post_id = p.id AND l.user_id = $1) AS \\"likedByViewer\\", p.author_id AS \\"authorId\\" FROM content.posts p JOIN social.profiles pr ON pr.user_id = p.author_id WHERE p.deleted_at IS NULL AND (p.author_id = $1 OR EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id AND f.status = 'accepted')) AND NOT EXISTS(SELECT 1 FROM social.mutes m WHERE m.muter_id = $1 AND m.muted_id = p.author_id) AND NOT EXISTS(SELECT 1 FROM social.blocks b WHERE (b.blocker_id = p.author_id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = p.author_id)) AND (p.author_id = $1 OR EXISTS(SELECT 1 FROM social.profiles x WHERE x.user_id = p.author_id AND x.privacy <> 'private') OR EXISTS(SELECT 1 FROM social.follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id AND f.status = 'accepted')) AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid)) ORDER BY p.created_at DESC, p.id DESC LIMIT 51";
const NOTIFICATION_FIRST_SQL = "SELECT n.id, n.type, n.post_id AS \\"postId\\", n.created_at AS \\"createdAt\\", n.read_at AS \\"readAt\\", p.handle, p.display_name AS \\"displayName\\" FROM notifications.notifications n LEFT JOIN social.profiles p ON p.user_id = n.actor_id WHERE n.recipient_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT 51";
const NOTIFICATION_CURSOR_SQL = "SELECT n.id, n.type, n.post_id AS \\"postId\\", n.created_at AS \\"createdAt\\", n.read_at AS \\"readAt\\", p.handle, p.display_name AS \\"displayName\\" FROM notifications.notifications n LEFT JOIN social.profiles p ON p.user_id = n.actor_id WHERE n.recipient_id = $1 AND (n.created_at, n.id) < (now() - interval '45 days', $2::uuid) ORDER BY n.created_at DESC, n.id DESC LIMIT 51";

async function configureVariant(database, kind) {
  const client = await connectDb(database, "kukugram-benchmark-index-variant");
  try {
    if (kind === "notification-baseline") {
      await client.query("DROP INDEX IF EXISTS notifications.notifications_recipient_cursor");
      await client.query("CREATE INDEX IF NOT EXISTS notifications_unread_by_recipient ON notifications.notifications (recipient_id, created_at DESC) WHERE read_at IS NULL");
    } else if (kind === "notification-additive") {
      await client.query("CREATE INDEX IF NOT EXISTS notifications_unread_by_recipient ON notifications.notifications (recipient_id, created_at DESC) WHERE read_at IS NULL");
      await client.query("CREATE INDEX IF NOT EXISTS notifications_recipient_cursor ON notifications.notifications (recipient_id, created_at DESC, id DESC)");
    } else if (kind === "notification-replacement") {
      await client.query("DROP INDEX IF EXISTS notifications_unread_by_recipient");
      await client.query("CREATE INDEX IF NOT EXISTS notifications_recipient_cursor ON notifications.notifications (recipient_id, created_at DESC, id DESC)");
    } else if (kind === "feed-baseline") {
      await client.query("DROP INDEX IF EXISTS content.posts_feed_global_cursor");
    } else if (kind === "feed-candidate") {
      await client.query("CREATE INDEX IF NOT EXISTS posts_feed_global_cursor ON content.posts (created_at DESC, id DESC) INCLUDE (author_id) WHERE deleted_at IS NULL");
    }
    await client.query("ANALYZE");
  } finally {
    await client.end();
  }
}
async function runMarkRead(database, variant) {
  const client = await connectDb(database, "kukugram-mark-read-correctness");
  const results = [];
  try {
    const counts = [50, 500, 2_000, 10_000];
    for (let i = 0; i < counts.length; i += 1) {
      const recipient = deterministicUuid("kukugram-mwb-user-" + (i + 4));
      const before = await client.query("SELECT count(*)::int AS count FROM notifications.notifications WHERE recipient_id = $1 AND read_at IS NULL", [recipient]);
      if (before.rows[0].count !== counts[i]) throw new Error("Unread fixture count mismatch for " + counts[i]);
      const started = performance.now();
      const updated = await client.query("UPDATE notifications.notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL", [recipient]);
      const elapsed = performance.now() - started;
      const after = await client.query("SELECT count(*)::int AS count FROM notifications.notifications WHERE recipient_id = $1 AND read_at IS NULL", [recipient]);
      const idempotent = await client.query("UPDATE notifications.notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL", [recipient]);
      if (updated.rowCount !== counts[i] || after.rows[0].count !== 0 || idempotent.rowCount !== 0) {
        throw new Error("Mark-read correctness gate failed for unread count " + counts[i]);
      }
      results.push({ variant, unread_rows: counts[i], updated_rows: updated.rowCount, second_call_rows: idempotent.rowCount, latency_ms: Number(elapsed.toFixed(4)), remaining_unread: after.rows[0].count });
    }
    const recipients = [4, 5, 6, 7].map((n) => deterministicUuid("kukugram-mwb-user-" + n));
    const beforeOthers = await client.query("SELECT recipient_id, count(*)::int AS count FROM notifications.notifications WHERE recipient_id = ANY($1::uuid[]) AND recipient_id <> $2 AND read_at IS NULL GROUP BY recipient_id ORDER BY recipient_id", [recipients, recipient]);
    const afterOthers = await client.query("SELECT recipient_id, count(*)::int AS count FROM notifications.notifications WHERE recipient_id = ANY($1::uuid[]) AND recipient_id <> $2 AND read_at IS NULL GROUP BY recipient_id ORDER BY recipient_id", [recipients, recipient]);
    if (JSON.stringify(beforeOthers.rows) !== JSON.stringify(afterOthers.rows)) throw new Error("Recipient isolation gate failed: another recipient unread rows changed.");
  } finally {
    await client.end();
  }
  return results;
}
async function runTimedSuite(database, suiteName, variant, workerCount, round) {
  const pool = await instrumentedPool(database, settings.poolMax);
  const workerRecipients = Array.from({ length: 16 }, (_, i) => deterministicUuid("kukugram-mwb-user-" + (i + 8)));
  const viewers = [1, 2, 3].map((n) => deterministicUuid("kukugram-mwb-user-" + n));
  const cursorId = deterministicUuid("kukugram-mwb-post-200000");
  const notificationCursorId = deterministicUuid("kukugram-mwb-page-500");
  let maxPoolWaiting = 0;
  let retries = 0;
  let timeouts = 0;

  async function operation(workerIndex, rng, capture) {
    const draw = rng();
    let label;
    let sql;
    let values;
    if (suiteName === "notifications") {
      if (draw < 0.2) {
        label = "insert";
        sql = "INSERT INTO notifications.notifications (id, recipient_id, actor_id, type, created_at) VALUES ($1, $2, $3, 'follow', now())";
        values = [randomUUID(), viewers[0], viewers[1]];
      } else if (draw < 0.4) {
        label = "mark_read_update";
        const recipient = workerRecipients[workerIndex % workerRecipients.length];
        const prep = await acquire(pool);
        try {
          await prep.client.query("UPDATE notifications.notifications SET read_at = NULL WHERE recipient_id = $1", [recipient]);
        } finally {
          prep.client.release();
        }
        sql = "UPDATE notifications.notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL";
        values = [recipient];
      } else if (draw < 0.8) {
        label = "first_page";
        sql = NOTIFICATION_FIRST_SQL;
        values = [viewers[0]];
      } else {
        label = "cursor_page";
        sql = NOTIFICATION_CURSOR_SQL;
        values = [viewers[0], notificationCursorId];
      }
    } else {
      const viewer = viewers[workerIndex % viewers.length];
      if (draw < 0.4) {
        label = "first_page";
        sql = FEED_SQL;
        values = [viewer, null, null];
      } else if (draw < 0.8) {
        label = "cursor_page";
        sql = FEED_SQL;
        values = [viewer, new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), cursorId];
      } else {
        label = "post_insert";
        sql = "INSERT INTO content.posts (id, author_id, body) VALUES ($1, $2, $3)";
        values = [randomUUID(), viewer, "Mixed workload concurrent post " + randomUUID()];
      }
    }
    const result = await recordQuery(pool, sql, values, capture, label, suiteName, variant, workerCount, round);
    maxPoolWaiting = Math.max(maxPoolWaiting, pool.waitingCount);
    return result;
  }

  async function phase(duration, capture, phaseName) {
    const deadline = Date.now() + duration;
    const workers = [];
    for (let worker = 0; worker < workerCount; worker += 1) {
      workers.push((async () => {
        const rng = makeRng(seed + round * 100_003 + worker * 7_919 + variant.length * 31 + phaseName.length);
        while (Date.now() < deadline) {
          try {
            await operation(worker, rng, capture);
          } catch (error) {
            if (error.code === "57014" || error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT") timeouts += 1;
            if (capture) retries += 0;
          }
        }
      })());
    }
    await Promise.all(workers);
  }
  try {
    await phase(settings.warmupMs, false, "warmup");
    const started = performance.now();
    const beforeCount = raw.length;
    await phase(settings.measurementMs, true, "measured");
    const elapsedSeconds = (performance.now() - started) / 1000;
    const rows = raw.slice(beforeCount).filter((row) => row.suite === suiteName && row.variant === variant && row.worker_count === workerCount && row.round === round);
    const byOperation = {};
    for (const row of rows) {
      if (!byOperation[row.operation]) byOperation[row.operation] = { latency: [], poolWait: [], errors: 0 };
      byOperation[row.operation].latency.push(row.latency_ms);
      byOperation[row.operation].poolWait.push(row.pool_wait_ms);
      if (row.error) byOperation[row.operation].errors += 1;
    }
    const summary = Object.entries(byOperation).map(([operation, data]) => ({
      suite: suiteName, variant, worker_count: workerCount, round, operation,
      ...summarize(data.latency),
      pool_wait: summarize(data.poolWait),
      errors: data.errors,
      throughput_ops_sec: Number((data.latency.length / elapsedSeconds).toFixed(3)),
      retries,
      timeouts
    }));
    notes.push({ suite: suiteName, variant, worker_count: workerCount, round, elapsed_seconds: Number(elapsedSeconds.toFixed(3)), max_pool_waiting: maxPoolWaiting, pool_max: settings.poolMax });
    return summary;
  } finally {
    await pool.end();
  }
}
async function queryPlans(database, variant, suiteName) {
  const client = await connectDb(database, "kukugram-benchmark-explain");
  const plans = {};
  try {
    if (suiteName === "feed" || suiteName === "all") {
      for (const [name, values] of [["first", [deterministicUuid("kukugram-mwb-user-1"), null, null]], ["cursor", [deterministicUuid("kukugram-mwb-user-1"), new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), deterministicUuid("kukugram-mwb-post-200000")]]]) {
        const result = await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + FEED_SQL, values);
        plans["feed_" + name] = result.rows[0]["QUERY PLAN"];
      }
    }
    if (suiteName === "notifications" || suiteName === "mark-read" || suiteName === "all") {
      for (const [name, sql, values] of [["first", NOTIFICATION_FIRST_SQL, [deterministicUuid("kukugram-mwb-user-1")]], ["cursor", NOTIFICATION_CURSOR_SQL, [deterministicUuid("kukugram-mwb-user-1"), deterministicUuid("kukugram-mwb-page-500")]]]) {
        const result = await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values);
        plans["notifications_" + name] = result.rows[0]["QUERY PLAN"];
      }
    }
  } finally {
    await client.end();
  }
  await writeFile(resolve(artifactDir, variant + "-plans.json"), JSON.stringify(plans, null, 2) + "\n");
}
async function indexAndTableStats(database, variant) {
  const client = await connectDb(database, "kukugram-benchmark-storage");
  try {
    const result = await client.query(
      "SELECT schemaname, relname, indexrelname, pg_relation_size(indexrelid)::bigint AS index_bytes, idx_scan, idx_tup_read, idx_tup_fetch FROM pg_stat_user_indexes ORDER BY schemaname, relname, indexrelname"
    );
    const tables = await client.query(
      "SELECT schemaname, relname, n_live_tup, n_tup_ins, n_tup_upd, n_dead_tup, pg_relation_size(relid)::bigint AS table_bytes, pg_total_relation_size(relid)::bigint AS total_bytes FROM pg_stat_user_tables ORDER BY schemaname, relname"
    );
    return { variant, indexes: result.rows, tables: tables.rows };
  } finally {
    await client.end();
  }
}
function balancedOrders(names) {
  if (names.length === 2) return [
    [names[0], names[1]],
    [names[1], names[0]],
    [names[0], names[1]]
  ];
  if (names.length === 3) return [
    [names[0], names[1], names[2]],
    [names[2], names[1], names[0]],
    [names[1], names[0], names[2]]
  ];
  return [names];
}
function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return '"' + text.replaceAll('"', '""') + '"';
}

try {
  notes.push({ event: "settings", ...settings, counts, suite });
  await createDatabase(seedDb);
  await applyMigrations(seedDb);
  await seedDatabase(seedDb);
  const seedChecksum = await checksumDatabase(seedDb);
  await writeFile(resolve(artifactDir, "seed-checksums.json"), JSON.stringify(seedChecksum, null, 2) + "\n");

  const selected = suite === "all"
    ? ["notificationBaseline", "notificationAdditive", "notificationReplacement", "feedBaseline", "feedCandidate"]
    : suite === "mark-read" || suite === "notifications"
      ? ["notificationBaseline", "notificationAdditive", "notificationReplacement"]
      : ["feedBaseline", "feedCandidate"];
  for (const key of selected) await createDatabase(dbNames[key], seedDb);

  const variantDefinitions = {
    notificationBaseline: ["notification-baseline", "notificationBaseline"],
    notificationAdditive: ["notification-additive", "notificationAdditive"],
    notificationReplacement: ["notification-replacement", "notificationReplacement"],
    feedBaseline: ["feed-baseline", "feedBaseline"],
    feedCandidate: ["feed-candidate", "feedCandidate"]
  };
  const summaries = [];
  const markReadResults = [];
  const storage = [];
  const walStart = await admin.query("SELECT wal_bytes::text FROM pg_stat_wal");
  walBefore = walStart.rows[0]?.wal_bytes ?? null;

  for (const key of selected) {
    const [variant, dbKey] = variantDefinitions[key];
    const database = dbNames[dbKey];
    await configureVariant(database, variant);
    await queryPlans(database, variant, suite);
    if (variant.startsWith("notification") && (suite === "all" || suite === "mark-read" || suite === "notifications")) {
      if (suite === "all" || suite === "mark-read") markReadResults.push(...await runMarkRead(database, variant));
      if (suite === "all" || suite === "notifications") {
        for (const workerCount of settings.workers) {
          for (let round = 1; round <= settings.rounds; round += 1) {
            summaries.push(...await runTimedSuite(database, "notifications", variant, workerCount, round));
          }
        }
      }
    }
    if (variant.startsWith("feed") && (suite === "all" || suite === "feed")) {
      for (const workerCount of settings.workers) {
        for (let round = 1; round <= settings.rounds; round += 1) {
          summaries.push(...await runTimedSuite(database, "feed", variant, workerCount, round));
        }
      }
      const apiOutput = resolve(artifactDir, variant + "-api.json");
      const apiScript = resolve(root, "apps/api/scripts/mixed-workload-api.mts");
      const child = spawnSync("pnpm", ["--filter", "@kukugram/api", "exec", "tsx", apiScript], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://" + encodeURIComponent(target.user) + ":" + encodeURIComponent(target.password) + "@" + target.host + ":" + target.port + "/" + database,
          BENCH_VIEWER_ID: deterministicUuid("kukugram-mwb-user-1"),
          BENCH_SEED: String(seed),
          BENCH_PROFILE: profile,
          BENCH_OUTPUT: apiOutput,
          BENCH_VARIANT: variant
        },
        maxBuffer: 20 * 1024 * 1024
      });
      if (child.status !== 0) throw new Error("API benchmark helper failed: " + (child.stderr || child.stdout).slice(-4000));
      notes.push({ event: "api-helper", variant, stdout: child.stdout.slice(-1000) });
    }
    storage.push(await indexAndTableStats(database, variant));
  }

  const walEnd = await admin.query("SELECT wal_bytes::text FROM pg_stat_wal");
  walAfter = walEnd.rows[0]?.wal_bytes ?? null;
  const walDelta = walBefore !== null && walAfter !== null ? (BigInt(walAfter) - BigInt(walBefore)).toString() : null;
  const postChecksums = {};
  for (const key of selected) {
    const database = dbNames[variantDefinitions[key][1]];
    postChecksums[variantDefinitions[key][0]] = await checksumDatabase(database);
  }

  const report = {
    generated_at: new Date().toISOString(),
    safety: { postgres_host: target.host, postgres_database: target.database, disposable_database_prefix: "kg_mwb_", production_connections: false },
    settings,
    counts,
    suite,
    seed_checksum: seedChecksum,
    post_checksums: postChecksums,
    mark_read_correctness: markReadResults,
    summaries,
    storage,
    wal: { cluster_wal_bytes_before: walBefore, cluster_wal_bytes_after: walAfter, cluster_wal_bytes_delta: walDelta, note: "Cluster-wide WAL delta from an isolated disposable PostgreSQL service; includes benchmark fixture resets and all variant writes, not a pure per-query measurement." },
    balanced_order: {
      notification_variants: balancedOrders(["notification-baseline", "notification-additive", "notification-replacement"]),
      feed_variants: balancedOrders(["feed-baseline", "feed-candidate"]),
      seed,
      note: "Variant order is deterministic and balanced across three rounds; each variant starts from an identical PostgreSQL template clone."
    },
    runtime_notes: notes,
    errors,
    acceptance: {
      correctness_gate: errors.length === 0 && markReadResults.every((row) => row.updated_rows === row.unread_rows && row.second_call_rows === 0 && row.remaining_unread === 0),
      p95_regressions_over_10_percent_require_investigation: true,
      post_insert_p95_target_regression_percent: 10,
      post_insert_p95_over_15_percent_requires_justification: true,
      notification_update_p95_target_regression_percent: 10,
      p99_review_required: true,
      production_index_approval: false
    }
  };
  await writeFile(resolve(artifactDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(resolve(artifactDir, "raw-samples.json"), JSON.stringify(raw) + "\n");
  await writeFile(resolve(artifactDir, "errors.json"), JSON.stringify(errors, null, 2) + "\n");
  await writeFile(resolve(artifactDir, "storage.json"), JSON.stringify(storage, null, 2) + "\n");
  const csv = [
    ["suite", "variant", "worker_count", "round", "operation", "latency_ms", "pool_wait_ms", "error"].map(csvEscape).join(","),
    ...raw.map((row) => [row.suite, row.variant, row.worker_count, row.round, row.operation, row.latency_ms, row.pool_wait_ms, row.error].map(csvEscape).join(","))
  ].join("\n") + "\n";
  await writeFile(resolve(artifactDir, "raw-samples.csv"), csv);
  console.log(JSON.stringify({ report: resolve(artifactDir, "report.json"), samples: raw.length, errors: errors.length, walDelta, variants: selected }, null, 2));
  if (errors.length || !report.acceptance.correctness_gate) process.exitCode = 1;
} finally {
  for (const database of createdDatabases.reverse()) {
    try {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [database]);
      await admin.query("DROP DATABASE IF EXISTS " + ident(database));
    } catch (error) {
      notes.push({ cleanup_error: database, message: String(error.message) });
    }
  }
  await admin.end();
  await writeFile(resolve(artifactDir, "cleanup-notes.json"), JSON.stringify(notes.filter((item) => item.cleanup_error), null, 2) + "\n");
}
