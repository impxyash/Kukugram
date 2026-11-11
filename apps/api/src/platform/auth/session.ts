import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createOpaqueSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${token}`).digest("base64url");
}

export interface SessionStore {
  create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  revoke(tokenHash: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

// Password verification (Argon2id) and OAuth/OIDC callbacks will depend on concrete identity repositories.
// Session tokens are opaque and only this one-way hash belongs in PostgreSQL.

const NATIVE_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const NATIVE_ACCESS_TOKEN_ISSUER = "kukugram-api";
const NATIVE_ACCESS_TOKEN_AUDIENCE = "kukugram-native";
const NATIVE_ACCESS_TOKEN_DOMAIN = "kukugram:native-access:v1\\0";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NativeAccessTokenClaims {
  sub: string;
  sid: string;
  iat: number;
  exp: number;
  iss: typeof NATIVE_ACCESS_TOKEN_ISSUER;
  aud: typeof NATIVE_ACCESS_TOKEN_AUDIENCE;
  typ: "access";
}

function encodeTokenPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Creates a short-lived, opaque-to-clients bearer credential for native clients.
 * The associated refresh token remains the only long-lived client credential.
 */
export function createNativeAccessToken(
  userId: string,
  sessionId: string,
  pepper: string,
  now = Date.now()
): string {
  const issuedAt = Math.floor(now / 1000);
  const header = encodeTokenPart({ alg: "HS256", typ: "JWT" });
  const payload = encodeTokenPart({
    sub: userId,
    sid: sessionId,
    iat: issuedAt,
    exp: issuedAt + NATIVE_ACCESS_TOKEN_TTL_SECONDS,
    iss: NATIVE_ACCESS_TOKEN_ISSUER,
    aud: NATIVE_ACCESS_TOKEN_AUDIENCE,
    typ: "access"
  } satisfies NativeAccessTokenClaims);
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", pepper)
    .update(NATIVE_ACCESS_TOKEN_DOMAIN)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

/**
 * Verifies signature, audience, issuer, canonical encoding, UUID claims and
 * the fixed 15-minute lifetime. Invalid or expired tokens return null.
 */
export function verifyNativeAccessToken(
  token: string,
  pepper: string,
  now = Date.now()
): NativeAccessTokenClaims | null {
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const unsigned = `${headerPart}.${payloadPart}`;
  const expectedSignature = createHmac("sha256", pepper)
    .update(NATIVE_ACCESS_TOKEN_DOMAIN)
    .update(unsigned)
    .digest();
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(signaturePart, "base64url");
    if (suppliedSignature.toString("base64url") !== signaturePart) return null;
  } catch {
    return null;
  }
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const expectedKeys = ["aud", "exp", "iat", "iss", "sid", "sub", "typ"];
    if (
      Buffer.from(headerPart, "base64url").toString("base64url") !== headerPart ||
      Buffer.from(payloadPart, "base64url").toString("base64url") !== payloadPart ||
      Object.keys(header).length !== 2 ||
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      Object.keys(claims).sort().join(",") !== expectedKeys.join(",") ||
      typeof claims.sub !== "string" ||
      !UUID_PATTERN.test(claims.sub) ||
      typeof claims.sid !== "string" ||
      !UUID_PATTERN.test(claims.sid) ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iss !== NATIVE_ACCESS_TOKEN_ISSUER ||
      claims.aud !== NATIVE_ACCESS_TOKEN_AUDIENCE ||
      claims.typ !== "access"
    ) {
      return null;
    }
    const issuedAt = claims.iat as number;
    const expiresAt = claims.exp as number;
    const nowSeconds = Math.floor(now / 1000);
    if (
      issuedAt > nowSeconds + 60 ||
      expiresAt <= nowSeconds ||
      expiresAt - issuedAt !== NATIVE_ACCESS_TOKEN_TTL_SECONDS
    ) {
      return null;
    }
    return claims as unknown as NativeAccessTokenClaims;
  } catch {
    return null;
  }
}
