import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashSessionToken } from "../src/platform/auth/session.js";
import { InMemoryRateLimitStore } from "../src/platform/rate-limit.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const databaseUrl = process.env.DATABASE_URL;
const viewerId = process.env.BENCH_VIEWER_ID;
const seed = Number(process.env.BENCH_SEED ?? "20261109");
const profile = process.env.BENCH_PROFILE ?? "full";
const variant = process.env.BENCH_VARIANT ?? "feed-candidate";
const output = resolve(process.env.BENCH_OUTPUT ?? resolve(root, "artifacts/mixed-workload/api.json"));
if (!databaseUrl || !viewerId) throw new Error("DATABASE_URL and BENCH_VIEWER_ID are required.");
if (!["full", "smoke"].includes(profile)) throw new Error("Invalid BENCH_PROFILE.");
const parsedUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname) || !/^kg_mwb_/.test(parsedUrl.pathname.slice(1))) {
  throw new Error("Safety stop: API benchmark accepts only a loopback kg_mwb_ disposable database.");
}
const full = profile === "full";
const warmupMs = full ? 120_000 : 2_000;
const measurementMs = full ? 300_000 : 5_000;
const rounds = full ? 3 : 1;
const workers = [1, 4, 8, 16];
const poolMax = 8;
const pepper = "kukugram-mixed-workload-benchmark-pepper-v1";
const token = "kukugram-mwb-session-" + seed;
const pool = new Pool({ connectionString: databaseUrl, max: poolMax, application_name: "kukugram-api-benchmark" });
const poolWaitSamples: number[] = [];
const originalConnect = pool.connect.bind(pool);
(pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
  const started = performance.now();
  const callback = args[0];
  if (typeof callback === "function") {
    return originalConnect((error: unknown, client: unknown, release: unknown) => {
      poolWaitSamples.push(performance.now() - started);
      (callback as (...values: unknown[]) => void)(error, client, release);
    });
  }
  return (originalConnect() as Promise<unknown>).then((client) => {
    poolWaitSamples.push(performance.now() - started);
    return client;
  });
};
const config = loadConfig({
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: databaseUrl,
  REDIS_URL: "redis://127.0.0.1:6379",
  SESSION_COOKIE_NAME: "bench_session",
  SESSION_TOKEN_PEPPER: pepper
});
const raw: Array<Record<string, unknown>> = [];
const errors: Array<Record<string, unknown>> = [];
let app: ReturnType<typeof buildApp> | undefined;

function makeRng(value: number) {
  let state = value >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(4));
}
function summarize(values: number[]) {
  return { count: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), p99_ms: percentile(values, 0.99) };
}
async function phase(workerCount: number, duration: number, capture: boolean, round: number) {
  const deadline = Date.now() + duration;
  await Promise.all(Array.from({ length: workerCount }, async (_, worker) => {
    const rng = makeRng(seed + round * 100_003 + worker * 7_919 + variant.length);
    while (Date.now() < deadline) {
      const draw = rng();
      const started = performance.now();
      let operation = "feed_first_page";
      try {
        let response;
        if (draw < 0.70) {
          response = await app!.inject({ method: "GET", url: "/v1/feed", headers: { cookie: "bench_session=" + token } });
        } else if (draw < 0.85) {
          operation = "feed_cursor_page";
          response = await app!.inject({ method: "GET", url: "/v1/feed?cursor=" + encodeURIComponent(cursor), headers: { cookie: "bench_session=" + token } });
        } else {
          operation = "post_insert_api";
          response = await app!.inject({ method: "POST", url: "/v1/posts", headers: { cookie: "bench_session=" + token }, payload: { body: "API mixed-workload benchmark post " + randomUUID() } });
        }
        const latency = performance.now() - started;
        const expected = operation === "post_insert_api" ? 201 : 200;
        if (response.statusCode !== expected) {
          throw new Error("Unexpected API status " + response.statusCode + " for " + operation + ": " + response.body.slice(0, 300));
        }
        if (capture) raw.push({ variant, worker_count: workerCount, round, operation, latency_ms: Number(latency.toFixed(4)), status_code: response.statusCode, error: false });
      } catch (error) {
        if (capture) {
          errors.push({ variant, worker_count: workerCount, round, operation, message: String((error as Error).message).slice(0, 300) });
          raw.push({ variant, worker_count: workerCount, round, operation, latency_ms: Number((performance.now() - started).toFixed(4)), status_code: null, error: true });
        }
      }
    }
  }));
}
let cursor = "";
try {
  await pool.query(
    "INSERT INTO identity.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '2 hours') ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL, expires_at = EXCLUDED.expires_at",
    [randomUUID(), viewerId, hashSessionToken(token, pepper)]
  );
  app = buildApp(config, pool, new InMemoryRateLimitStore());
  await app.ready();
  const initial = await app.inject({ method: "GET", url: "/v1/feed", headers: { cookie: "bench_session=" + token } });
  if (initial.statusCode !== 200) throw new Error("API feed preflight failed: " + initial.statusCode);
  cursor = initial.json<{ nextCursor?: string }>().nextCursor ?? "";
  if (!cursor) throw new Error("API feed preflight did not produce a cursor; benchmark fixture is insufficient.");
  const summaries = [];
  for (const workerCount of workers) {
    for (let round = 1; round <= rounds; round += 1) {
      await phase(workerCount, warmupMs, false, round);
      const waitStart = poolWaitSamples.length;
      const started = performance.now();
      const rawStart = raw.length;
      await phase(workerCount, measurementMs, true, round);
      const elapsedSeconds = (performance.now() - started) / 1000;
      const measured = raw.slice(rawStart);
      const groups = new Map<string, number[]>();
      for (const row of measured) {
        const key = String(row.operation);
        if (!groups.has(key)) groups.set(key, []);
        if (typeof row.latency_ms === "number") groups.get(key)!.push(row.latency_ms);
      }
      for (const [operation, values] of groups) {
        summaries.push({
          variant, worker_count: workerCount, round, operation,
          ...summarize(values),
          throughput_ops_sec: Number((values.length / elapsedSeconds).toFixed(3)),
          errors: measured.filter((row) => row.operation === operation && row.error).length,
          pool_wait: summarize(poolWaitSamples.slice(waitStart))
        });
      }
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({
    generated_at: new Date().toISOString(),
    variant, seed, profile, warmup_ms: warmupMs, measurement_ms: measurementMs,
    rounds, workers, pool_max: poolMax, summaries, raw_samples: raw,
    errors, pool_wait_samples_ms: poolWaitSamples.map((value) => Number(value.toFixed(4))),
    rate_limit_store: "InMemoryRateLimitStore; Redis is not connected",
    api_latency_note: "Fastify app.inject end-to-end latency; includes routing, auth/session lookup, SQL calls and response serialization. It is not a public-network latency measurement."
  }, null, 2) + "\n");
  console.log(JSON.stringify({ output, samples: raw.length, errors: errors.length, variant }));
  if (errors.length) process.exitCode = 1;
} finally {
  if (app) await app.close();
  else await pool.end();
}
