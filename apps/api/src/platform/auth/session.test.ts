import { describe, expect, it } from "vitest";
import {
  createNativeAccessToken,
  verifyNativeAccessToken,
} from "./session.js";

const pepper = "a-secure-test-pepper-that-is-long-enough";
const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const now = Date.UTC(2026, 10, 9, 0, 0, 0);

describe("native access tokens", () => {
  it("creates a verifiable 15-minute token bound to one user and session", () => {
    const token = createNativeAccessToken(userId, sessionId, pepper, now);
    expect(verifyNativeAccessToken(token, pepper, now)).toEqual({
      sub: userId,
      sid: sessionId,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 900,
      iss: "kukugram-api",
      aud: "kukugram-native",
      typ: "access",
    });
  });

  it("rejects a token with a modified payload or signature", () => {
    const token = createNativeAccessToken(userId, sessionId, pepper, now);
    const [header, payload, signature] = token.split(".");
    expect(
      verifyNativeAccessToken(`${header}.${payload}.${signature}x`, pepper, now),
    ).toBeNull();
    expect(
      verifyNativeAccessToken(`${header}.${payload.slice(0, -1)}A.${signature}`, pepper, now),
    ).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = createNativeAccessToken(userId, sessionId, pepper, now);
    expect(verifyNativeAccessToken(token, pepper, now + 15 * 60 * 1000)).toBeNull();
  });

  it("rejects tokens signed with a different pepper", () => {
    const token = createNativeAccessToken(userId, sessionId, pepper, now);
    expect(
      verifyNativeAccessToken(token, "a-different-secure-pepper-value-123456", now),
    ).toBeNull();
  });

  it("rejects malformed tokens and tokens with a noncanonical lifetime", () => {
    expect(verifyNativeAccessToken("not.a.token", pepper, now)).toBeNull();
    expect(verifyNativeAccessToken("a.b.c.d", pepper, now)).toBeNull();
    const token = createNativeAccessToken(userId, sessionId, pepper, now);
    expect(verifyNativeAccessToken(token, pepper, now + 16 * 60 * 1000)).toBeNull();
  });
});
