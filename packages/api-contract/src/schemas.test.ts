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
  reportSummaryListResponseSchema,
  moderationReportListResponseSchema,
  appealSummaryListResponseSchema,
  moderationAppealQueueResponseSchema,
  moderationRoleListResponseSchema,
  moderationAuditListResponseSchema,
  accountControlListResponseSchema,
  authProvidersResponseSchema,
  authUserResponseSchema,
  healthResponseSchema,
  problemDetailsSchema,
  profileResponseSchema,
  userSearchResponseSchema,
  postCreateResponseSchema,
  followRequestListResponseSchema,
  moderationReportDetailResponseSchema,
  moderationReportDetailResponseWrapperSchema,
  moderationAppealDetailResponseWrapperSchema,
  moderationAppealDetailResponseSchema,
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

  it("validates moderation list and detail rows from the SQL projections", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const timestamp = "2026-11-07T00:00:00.000Z";
    expect(
      reportSummaryListResponseSchema.safeParse({
        reports: [
          {
            id,
            targetType: "post",
            category: "spam",
            status: "open",
            createdAt: timestamp
          }
        ]
      }).success
    ).toBe(true);
    expect(
      moderationReportListResponseSchema.safeParse({
        reports: [
          {
            id,
            targetType: "post",
            category: "spam",
            status: "reviewing",
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ]
      }).success
    ).toBe(true);
    expect(
      moderationReportDetailResponseSchema.safeParse({
        id,
        targetType: "profile",
        targetId: id,
        category: "other",
        details: null,
        status: "resolved",
        createdAt: timestamp,
        updatedAt: timestamp
      }).success
    ).toBe(true);
    expect(
      moderationReportDetailResponseWrapperSchema.safeParse({
        report: {
          id,
          targetType: "profile",
          targetId: id,
          category: "other",
          details: null,
          status: "resolved",
          createdAt: timestamp,
          updatedAt: timestamp
        }
      }).success
    ).toBe(true);
    expect(
      appealSummaryListResponseSchema.safeParse({
        appeals: [
          {
            id,
            reportId: id,
            details: "An appeal with enough explanatory detail.",
            status: "open",
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ]
      }).success
    ).toBe(true);
    expect(
      moderationAppealDetailResponseWrapperSchema.safeParse({
        appeal: {
          id,
          reportId: id,
          details: "An appeal with enough explanatory detail.",
          status: "rejected",
          createdAt: timestamp,
          updatedAt: timestamp
        }
      }).success
    ).toBe(true);
    expect(
      moderationAppealQueueResponseSchema.safeParse({
        appeals: [{ id, reportId: id, status: "open", createdAt: timestamp }]
      }).success
    ).toBe(true);
    expect(
      moderationAppealDetailResponseSchema.safeParse({
        id,
        reportId: id,
        details: "An appeal with enough explanatory detail.",
        status: "rejected",
        createdAt: timestamp,
        updatedAt: timestamp
      }).success
    ).toBe(true);
  });

  it("preserves nullable moderator and legacy audit attribution fields", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const timestamp = "2026-11-07T00:00:00.000Z";
    expect(
      moderationRoleListResponseSchema.safeParse({
        roles: [
          {
            userId: id,
            handle: "moderator",
            role: "moderator",
            grantedByHandle: null,
            grantedAt: timestamp
          }
        ]
      }).success
    ).toBe(true);
    expect(
      moderationAuditListResponseSchema.safeParse({
        events: [
          {
            id,
            action: "report.status_changed",
            actorRef: null,
            caseRef: null,
            metadata: {},
            createdAt: timestamp
          }
        ]
      }).success
    ).toBe(true);
  });

  it("validates post creation and follow-request list response wrappers", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const timestamp = "2026-11-07T00:00:00.000Z";
    expect(
      postCreateResponseSchema.safeParse({
        post: {
          id,
          body: "Hello",
          createdAt: timestamp,
          handle: "creator",
          displayName: "Creator",
          avatarUrl: null,
          likeCount: "0",
          commentCount: "0",
          likedByViewer: false,
          authorId: id
        }
      }).success
    ).toBe(true);
    expect(
      followRequestListResponseSchema.safeParse({
        requests: [
          {
            id,
            handle: "requester",
            displayName: "Requester",
            avatarUrl: null,
            requestedAt: timestamp
          }
        ]
      }).success
    ).toBe(true);
  });

  it("validates profile, authentication provider and user lookup response contracts", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const profile = {
      id,
      handle: "creator",
      displayName: "Creator",
      bio: null,
      avatarUrl: null,
      followers: "12",
      following: "8",
      isFollowing: false,
      isRequested: false,
      privacy: "public" as const,
      canViewContent: true,
      isBlocked: false
    };

    expect(profileResponseSchema.safeParse(profile).success).toBe(true);
    expect(authUserResponseSchema.safeParse({ user: profile }).success).toBe(true);
    expect(userSearchResponseSchema.safeParse({ users: [profile] }).success).toBe(true);
    expect(authProvidersResponseSchema.safeParse({ password: true, oauth: [] }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ status: "ok", requestId: "request-123" }).success).toBe(
      true
    );
    const problemDetails = {
      type: "https://kukugram.com/problems/validation",
      title: "Validation failed",
      status: 400,
      detail: "The request body is invalid.",
      instance: "/v1/me/profile",
      requestId: "request-123"
    };
    expect(problemDetailsSchema.safeParse(problemDetails).success).toBe(true);
    expect(problemDetailsSchema.safeParse({ ...problemDetails, instance: undefined }).success).toBe(
      false
    );
    expect(
      problemDetailsSchema.safeParse({ ...problemDetails, requestId: undefined }).success
    ).toBe(false);
  });

  it("validates blocked and muted account response projections", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(
      accountControlListResponseSchema.safeParse({
        users: [
          {
            id,
            handle: "blocked_user",
            displayName: "Blocked User",
            avatarUrl: null,
            createdAt: "2026-11-07T00:00:00.000Z"
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects invalid login payloads", () => {
    expect(loginRequestSchema.safeParse({ email: "not-email", password: "x" }).success).toBe(false);
  });
});
