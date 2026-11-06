import { createHash, randomBytes } from "node:crypto";

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
