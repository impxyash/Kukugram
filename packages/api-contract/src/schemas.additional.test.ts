import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  accountControlResponseSchema,
  appealSummaryResponseSchema,
  auditActorResolutionResponseSchema as auditResponse,
  auditEventResponseSchema,
  commentCreateRequestSchema as commentRequest,
  commentResponseSchema,
  followRequestResponseSchema,
  handleParamsSchema as handleParams,
  likeResponseSchema as likeResponse,
  moderationAppealQueueItemResponseSchema,
  moderationAppealReviewRequestSchema as appealRequest,
  moderationAppealReviewResponseSchema as appealResponse,
  moderationReportSummaryResponseSchema,
  moderationReportUpdateRequestSchema as reportRequest,
  moderationReportUpdateResponseSchema as reportResponse,
  moderatorRoleCreateRequestSchema as roleRequest,
  moderatorRoleCreateResponseSchema as roleResponse,
  moderatorRoleParamsSchema as roleParams,
  moderatorRoleResponseSchema,
  notificationReadResponseSchema as readResponse,
  notificationResponseSchema,
  postResponseSchema,
  reportSummaryResponseSchema,
  userSearchQuerySchema as searchQuery,
  uuidParamsSchema as uuidParams
} from "./schemas.js";

function expectValidAndInvalid(schema: ZodTypeAny, valid: unknown, invalid: unknown) {
  expect(schema.safeParse(valid).success).toBe(true);
  expect(schema.safeParse(invalid).success).toBe(false);
}

describe("additional API contracts", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const timestamp = "2026-11-07T00:00:00.000Z";

  it("validates comment, search, path and moderation requests", () => {
    expectValidAndInvalid(commentRequest, { body: "A comment" }, { body: " " });
    expectValidAndInvalid(searchQuery, { q: "creator" }, { q: " " });
    expectValidAndInvalid(uuidParams, { id }, { id: "invalid" });
    expect(handleParams.safeParse({ handle: "creator_01" }).success).toBe(true);
    expectValidAndInvalid(reportRequest, { status: "resolved" }, { status: "open" });
    expectValidAndInvalid(appealRequest, { status: "accepted" }, { status: "open" });
    const validRoleRequest = { userId: id, role: "moderator" };
    const invalidRoleRequest = { userId: "invalid", role: "moderator" };
    expectValidAndInvalid(roleRequest, validRoleRequest, invalidRoleRequest);
    const validRoleParams = { userId: id, role: "admin" };
    const invalidRoleParams = { userId: id, role: "owner" };
    expectValidAndInvalid(roleParams, validRoleParams, invalidRoleParams);
  });

  it("validates standalone feed, notification, account and moderation response rows", () => {
    const post = {
      id,
      body: "A post",
      createdAt: timestamp,
      handle: "creator",
      displayName: "Creator",
      avatarUrl: null,
      likeCount: "2",
      commentCount: "1",
      likedByViewer: false,
      authorId: id
    };
    const comment = {
      id,
      body: "A comment",
      createdAt: timestamp,
      handle: "creator",
      displayName: "Creator",
      avatarUrl: null
    };
    const notification = {
      id,
      type: "follow",
      postId: null,
      createdAt: timestamp,
      readAt: null,
      handle: "creator",
      displayName: "Creator"
    };
    const accountControl = {
      id,
      handle: "creator",
      displayName: "Creator",
      avatarUrl: null,
      createdAt: timestamp
    };
    const followRequest = {
      id,
      handle: "creator",
      displayName: "Creator",
      avatarUrl: null,
      requestedAt: timestamp
    };
    const report = {
      id,
      targetType: "post",
      category: "spam",
      status: "open",
      createdAt: timestamp
    };
    const appeal = {
      id,
      reportId: id,
      details: "An appeal with supporting context.",
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const appealQueueItem = {
      id,
      reportId: id,
      status: "open",
      createdAt: timestamp
    };
    const moderatorRole = {
      userId: id,
      handle: "creator",
      role: "moderator",
      grantedByHandle: null,
      grantedAt: timestamp
    };
    const auditEvent = {
      id,
      action: "report.resolved",
      actorRef: id,
      caseRef: null,
      metadata: {},
      createdAt: timestamp
    };

    const invalidPost = { ...post, authorId: "invalid" };
    const invalidComment = { id, body: "A comment" };
    const invalidNotification = { ...notification, type: "unknown" };
    const invalidAccountControl = { ...accountControl, createdAt: "invalid" };
    const invalidFollowRequest = { ...followRequest, requestedAt: "invalid" };
    const invalidReport = { ...report, status: "unknown" };
    const validModerationReport = { ...report, status: "reviewing", updatedAt: timestamp };
    const invalidModerationReport = { ...report, updatedAt: "invalid" };
    const invalidAppeal = { ...appeal, reportId: "invalid" };
    const invalidAppealQueueItem = { ...appealQueueItem, status: "accepted" };
    const invalidModeratorRole = { ...moderatorRole, userId: "invalid" };
    const invalidAuditEvent = { ...auditEvent, actorRef: "invalid" };

    expectValidAndInvalid(postResponseSchema, post, invalidPost);
    expectValidAndInvalid(commentResponseSchema, comment, invalidComment);
    expectValidAndInvalid(notificationResponseSchema, notification, invalidNotification);
    expectValidAndInvalid(accountControlResponseSchema, accountControl, invalidAccountControl);
    expectValidAndInvalid(followRequestResponseSchema, followRequest, invalidFollowRequest);
    expectValidAndInvalid(reportSummaryResponseSchema, report, invalidReport);
    expectValidAndInvalid(
      moderationReportSummaryResponseSchema,
      validModerationReport,
      invalidModerationReport
    );
    expectValidAndInvalid(appealSummaryResponseSchema, appeal, invalidAppeal);
    expectValidAndInvalid(moderationAppealQueueItemResponseSchema, appealQueueItem, invalidAppealQueueItem);
    expectValidAndInvalid(moderatorRoleResponseSchema, moderatorRole, invalidModeratorRole);
    expectValidAndInvalid(auditEventResponseSchema, auditEvent, invalidAuditEvent);
  });

  it("validates like, read, moderation and audit responses", () => {
    expectValidAndInvalid(likeResponse, { liked: true }, { liked: false });
    expectValidAndInvalid(readResponse, { ok: true }, { ok: false });
    expectValidAndInvalid(
      reportResponse,
      { reportId: id, status: "resolved" },
      { reportId: id, status: "open" }
    );
    expectValidAndInvalid(
      appealResponse,
      { appealId: id, status: "accepted" },
      { appealId: id, status: "open" }
    );
    const validRoleResponse = { userId: id, role: "admin" };
    const invalidRoleResponse = { userId: "invalid", role: "admin" };
    expectValidAndInvalid(roleResponse, validRoleResponse, invalidRoleResponse);
    expectValidAndInvalid(auditResponse, { userId: id }, { userId: "invalid" });
  });
});
