import { describe, expect, it } from "vitest";
import {
  appealCreateRequestSchema,
  auditActorResolutionRequestSchema,
  feedResponseSchema,
  commentCreateResponseSchema,
  commentListResponseSchema,
  notificationListResponseSchema,
  reportCreateResponseSchema,
  appealCreateResponseSchema,
  loginRequestSchema,
  moderationAuditQuerySchema,
  moderationReportListQuerySchema,
  postCreateRequestSchema,
  profileUpdateRequestSchema,
  reportCreateRequestSchema,
  signupRequestSchema
} from "./schemas.js";

describe("API request contracts", () => {
  it("accepts valid signup data and enforces password and handle bounds", () => {
    const valid = {
      email: "creator@example.test",
      password: "a-strong-password",
      handle: "creator_01",
      displayName: "Creator"
    };
    expect(signupRequestSchema.safeParse(valid).success).toBe(true);
    expect(signupRequestSchema.safeParse({ ...valid, password: "short" }).success).toBe(false);
    expect(signupRequestSchema.safeParse({ ...valid, handle: "Invalid Handle" }).success).toBe(
      false
    );
  });

  it("preserves nullable profile fields and rejects invalid avatar URLs", () => {
    expect(profileUpdateRequestSchema.parse({ bio: null, avatarUrl: null })).toEqual({
      bio: null,
      avatarUrl: null
    });
    expect(profileUpdateRequestSchema.safeParse({ avatarUrl: "not-a-url" }).success).toBe(false);
  });

  it("enforces content, report, and appeal request limits", () => {
    expect(postCreateRequestSchema.safeParse({ body: "hello" }).success).toBe(true);
    expect(postCreateRequestSchema.safeParse({ body: " " }).success).toBe(false);
    expect(
      reportCreateRequestSchema.safeParse({
        targetType: "post",
        targetId: "00000000-0000-4000-8000-000000000001",
        category: "spam"
      }).success
    ).toBe(true);
    expect(appealCreateRequestSchema.safeParse({ details: "too short" }).success).toBe(false);
    expect(
      appealCreateRequestSchema.safeParse({
        details: "This decision is incorrect because the evidence was misunderstood."
      }).success
    ).toBe(true);
  });

  it("coerces and bounds moderation list query limits", () => {
    expect(moderationReportListQuerySchema.parse({ limit: "20" }).limit).toBe(20);
    expect(moderationReportListQuerySchema.parse({}).limit).toBe(50);
    expect(moderationReportListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(moderationAuditQuerySchema.safeParse({ reportId: "invalid" }).success).toBe(false);
  });

  it("requires strict step-up audit input", () => {
    const valid = {
      actorRef: "00000000-0000-4000-8000-000000000001",
      reason: "Required for a documented compliance review.",
      password: "correct-horse-battery"
    };
    expect(auditActorResolutionRequestSchema.safeParse(valid).success).toBe(true);
    expect(auditActorResolutionRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(
      false
    );
  });

  it("validates documented feed response shapes", () => {
    expect(
      feedResponseSchema.safeParse({
        posts: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            body: "Hello",
            createdAt: "2026-11-07T00:00:00.000Z",
            handle: "creator",
            displayName: "Creator",
            avatarUrl: null,
            likeCount: "0",
            commentCount: "0",
            likedByViewer: false,
            authorId: "00000000-0000-4000-8000-000000000002"
          }
        ]
      }).success
    ).toBe(true);
  });


  it("validates comments, notifications, and moderation mutation responses", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(commentCreateResponseSchema.safeParse({ id, body: "Hello" }).success).toBe(true);
    expect(
      commentListResponseSchema.safeParse({
        comments: [
          {
            id,
            body: "Hello",
            createdAt: "2026-11-07T00:00:00.000Z",
            handle: "creator",
            displayName: "Creator",
            avatarUrl: null
          }
        ]
      }).success
    ).toBe(true);
    expect(
      notificationListResponseSchema.safeParse({
        notifications: [
          {
            id,
            type: "follow",
            postId: null,
            createdAt: "2026-11-07T00:00:00.000Z",
            readAt: null,
            handle: "creator",
            displayName: "Creator"
          }
        ]
      }).success
    ).toBe(true);
    expect(reportCreateResponseSchema.safeParse({ reportId: id, status: "open" }).success).toBe(
      true
    );
    expect(appealCreateResponseSchema.safeParse({ appealId: id, status: "open" }).success).toBe(
      true
    );
  });

  it("rejects invalid login payloads", () => {
    expect(loginRequestSchema.safeParse({ email: "not-email", password: "x" }).success).toBe(false);
  });
});
