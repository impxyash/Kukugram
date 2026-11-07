import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "redis";

export type RateLimitResult = {
  count: number;
  ttlMs: number;
};

export interface RateLimitStore {
  connect(): Promise<void>;
  consume(key: string, windowMs: number): Promise<RateLimitResult>;
  close(): Promise<void>;
}

const fixedWindowScript = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if count == 1 or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client;
  private connectPromise: Promise<void> | undefined;

  constructor(url: string, onError: () => void = () => undefined) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries) =>
          retries < 5
            ? Math.min(250 * 2 ** Math.min(retries, 4), 4_000)
            : new Error("Redis reconnect attempts exhausted.")
      }
    });
    this.client.on("error", onError);
  }

  connect(): Promise<void> {
    if (this.client.isReady) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        if (!this.client.isOpen) await this.client.connect();
        if (!this.client.isReady) throw new Error("Redis rate limiter is not ready.");
      })().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  async consume(key: string, windowMs: number): Promise<RateLimitResult> {
    if (!this.client.isReady && !this.client.isOpen) await this.connect();
    if (!this.client.isReady) throw new Error("Redis rate limiter is unavailable.");
    const result = await this.client.eval(fixedWindowScript, {
      keys: [key],
      arguments: [String(windowMs)]
    });
    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error("Redis rate limiter returned an invalid response.");
    }

    const count = Number(result[0]);
    const ttlMs = Number(result[1]);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error("Redis rate limiter returned invalid counter values.");
    }
    return { count, ttlMs };
  }

  async close() {
    if (this.client.isOpen) await this.client.close();
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async connect() {}

  async consume(key: string, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return Promise.resolve({ count: bucket.count, ttlMs: Math.max(0, bucket.resetAt - now) });
  }

  close(): Promise<void> {
    this.buckets.clear();
    return Promise.resolve();
  }
}

function normalizeIp(ip: string) {
  const mappedIpv4 = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  return mappedIpv4 && isIP(mappedIpv4) === 4 ? mappedIpv4 : ip.toLowerCase();
}

export function resolveClientIp(
  realIpHeader: string | string[] | undefined,
  socketAddress: string | undefined,
  requireRailwayHeader: boolean
): string {
  if (typeof realIpHeader === "string") {
    const candidate = realIpHeader.trim();
    if (isIP(candidate) !== 0) return normalizeIp(candidate);
  }

  if (!requireRailwayHeader && socketAddress && isIP(socketAddress) !== 0) {
    return normalizeIp(socketAddress);
  }

  throw new Error("A single valid public-ingress client IP is required.");
}

export function createAuthRateLimitKey(secret: string, clientIp: string, endpoint: string) {
  const digest = createHmac("sha256", secret)
    .update("kukugram:auth-rate-limit:v1\0")
    .update(clientIp)
    .update("\0")
    .update(endpoint)
    .digest("hex");
  return `kukugram:auth-rate-limit:v1:${digest}`;
}
