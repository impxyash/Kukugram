import { describe, expect, it } from "vitest";
import {
  accountControlResponseSchema,
  appealSummaryResponseSchema,
  auditEventResponseSchema,
  auditActorResolutionResponseSchema as auditResponse,
  commentResponseSchema,
  followRequestResponseSchema,
  moderationAppealQueueItemResponseSchema,
  moderationReportSummaryResponseSchema,
  moderatorRoleResponseSchema,
  notificationResponseSchema,
  postResponseSchema,
  reportSummaryResponseSchema,
  commentCreateRequestSchema as commentRequest,
  likeResponseSchema as likeResponse,
  moderationAppealReviewRequestSchema as appealRequest,
  moderationAppealReviewResponseSchema as appealResponse,
  moderationReportUpdateRequestSchema as reportRequest,
  moderationReportUpdateResponseSchema as reportResponse,
  moderatorRoleCreateRequestSchema as roleRequest,
  moderatorRoleCreateResponseSchema as roleResponse,
  moderatorRoleParamsSchema as roleParams,
  notificationReadResponseSchema as readResponse,
  userSearchQuerySchema as searchQuery,
  uuidParamsSchema as uuidParams,
  handleParamsSchema as handleParams
} from "./schemas.js";

describe("additional API contracts", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("validates comment, search, path and moderation requests", () => {
    expect(commentRequest.safeParse({ body: "A comment" }).success).toBe(true);
    expect(commentRequest.safeParse({ body: " " }).success).toBe(false);
    expect(searchQuery.safeParse({ q: "creator" }).success).toBe(true);
    expect(searchQuery.safeParse({ q: " " }).success).toBe(false);
    expect(uuidParams.safeParse({ id }).success).toBe(true);
    expect(uuidParams.safeParse({ id: "invalid" }).success).toBe(false);
    expect(handleParams.safeParse({ handle: "creator_01" }).success).toBe(true);
    expect(reportRequest.safeParse({ status: "resolved" }).success).toBe(true);
    expect(reportRequest.safeParse({ status: "open" }).success).toBe(false);
    expect(appealRequest.safeParse({ status: "accepted" }).success).toBe(true);
    expect(appealRequest.safeParse({ status: "open" }).success).toBe(false);
    expect(roleRequest.safeParse({ userId: id, role: "moderator" }).success).toBe(true);
    expect(roleRequest.safeParse({ userId: "invalid", role: "moderator" }).success).toBe(false);
    expect(roleParams.safeParse({ userId: id, role: "admin" }).success).toBe(true);
    expect(roleParams.safeParse({ userId: id, role: "owner" }).success).toBe(false);
  });

  it("validates standalone feed, notification, account and moderation response rows", () => {
    const timestamp = "2026-11-07T00:00:00.000Z";
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
    const report = {
      id,
      targetType: "post",
      category: "spam",
      status: "open",
      createdAt: timestamp
    };

    expect(postResponseSchema.safeParse(post).success).toBe(true);
    expect(postResponseSchema.safeParse({ ...post, authorId: "invalid" }).success).toBe(false);
    expect(commentResponseSchema.safeParse({
      id, body: "A comment", createdAt: timestamp, handle: "creator",
      displayName: "Creator", avatarUrl: null
    }).success).toBe(true);
    expect(commentResponseSchema.safeParse({ id, body: "A comment" }).success).toBe(false);
    expect(notificationResponseSchema.safeParse({
      id, type: "follow", postId: null, createdAt: timestamp, readAt: null,
      handle: "creator", displayName: "Creator"
    }).success).toBe(true);
    expect(notificationResponseSchema.safeParse({
      id, type: "unknown", postId: null, createdAt: timestamp, readAt: null,
      handle: null, displayName: null
    }).success).toBe(false);
    expect(accountControlResponseSchema.safeParse({
      id, handle: "creator", displayName: "Creator", avatarUrl: null, createdAt: timestamp
    }).success).toBe(true);
    expect(accountControlResponseSchema.safeParse({ id, createdAt: "invalid" }).success).toBe(false);
    expect(followRequestResponseSchema.safeParse({
      id, handle: "creator", displayName: "Creator", avatarUrl: null, requestedAt: timestamp
    }).success).toBe(true);
    expect(followRequestResponseSchema.safeParse({ id, requestedAt: "invalid" }).success).toBe(false);
    expect(reportSummaryResponseSchema.safeParse(report).success).toBe(true);
    expect(reportSummaryResponseSchema.safeParse({ ...report, status: "unknown" }).success).toBe(false);
    expect(moderationReportSummaryResponseSchema.safeParse({
      ...report, status: "reviewing", updatedAt: timestamp
    }).success).toBe(true);
    expect(moderationReportSummaryResponseSchema.safeParse({
      ...report, updatedAt: "invalid"
    }).success).toBe(false);
    expect(appealSummaryResponseSchema.safeParse({
      id, reportId: id, details: "An appeal with supporting context.", status: "open",
      createdAt: timestamp, updatedAt: timestamp
    }).success).toBe(true);
    expect(appealSummaryResponseSchema.safeParse({
      id, reportId: "invalid", details: "An appeal", status: "open",
      createdAt: timestamp, updatedAt: timestamp
    }).success).toBe(false);
    expect(moderationAppealQueueItemResponseSchema.safeParse({
      id, reportId: id, status: "open", createdAt: timestamp
    }).success).toBe(true);
    expect(moderationAppealQueueItemResponseSchema.safeParse({
      id, reportId: id, status: "accepted", createdAt: timestamp
    }).success).toBe(false);
    expect(moderatorRoleResponseSchema.safeParse({
      userId: id, handle: "creator", role: "moderator", grantedByHandle: null, grantedAt: timestamp
    }).success).toBe(true);
    expect(moderatorRoleResponseSchema.safeParse({
      userId: "invalid", handle: "creator", role: "moderator", grantedByHandle: null, grantedAt: timestamp
    }).success).toBe(false);
    expect(auditEventResponseSchema.safeParse({
      id, action: "report.resolved", actorRef: id, caseRef: null, metadata: {}, createdAt: timestamp
    }).success).toBe(true);
    expect(auditEventResponseSchema.safeParse({
      id, action: "report.resolved", actorRef: "invalid", caseRef: null, metadata: {}, createdAt: timestamp
    }).success).toBe(false);
  });

  it("validates like, read, moderation and audit responses", () => {
    expect(likeResponse.safeParse({ liked: true }).success).toBe(true);
    expect(likeResponse.safeParse({ liked: false }).success).toBe(false);
    expect(readResponse.safeParse({ ok: true }).success).toBe(true);
    expect(readResponse.safeParse({ ok: false }).success).toBe(false);
    expect(reportResponse.safeParse({ reportId: id, status: "resolved" }).success).toBe(true);
    expect(reportResponse.safeParse({ reportId: id, status: "open" }).success).toBe(false);
    expect(appealResponse.safeParse({ appealId: id, status: "accepted" }).success).toBe(true);
    expect(appealResponse.safeParse({ appealId: id, status: "open" }).success).toBe(false);
    expect(roleResponse.safeParse({ userId: id, role: "admin" }).success).toBe(true);
    expect(roleResponse.safeParse({ userId: "invalid", role: "admin" }).success).toBe(false);
    expect(auditResponse.safeParse({ userId: id }).success).toBe(true);
    expect(auditResponse.safeParse({ userId: "invalid" }).success).toBe(false);
  });
});
