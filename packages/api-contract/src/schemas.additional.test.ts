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
    expectValidAndInvalid(
      roleRequest,
      { userId: id, role: "moderator" },
      { userId: "invalid", role: "moderator" }
    );
    expectValidAndInvalid(
      roleParams,
      { userId: id, role: "admin" },
      { userId: id, role: "owner" }
    );
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

    expectValidAndInvalid(postResponseSchema, post, { ...post, authorId: "invalid" });
    expectValidAndInvalid(commentResponseSchema, comment, { id, body: "A comment" });
    expectValidAndInvalid(notificationResponseSchema, notification, {
      ...notification,
      type: "unknown"
    });
    expectValidAndInvalid(accountControlResponseSchema, accountControl, {
      ...accountControl,
      createdAt: "invalid"
    });
    expectValidAndInvalid(followRequestResponseSchema, followRequest, {
      ...followRequest,
      requestedAt: "invalid"
    });
    expectValidAndInvalid(reportSummaryResponseSchema, report, { ...report, status: "unknown" });
    expectValidAndInvalid(
      moderationReportSummaryResponseSchema,
      { ...report, status: "reviewing", updatedAt: timestamp },
      { ...report, updatedAt: "invalid" }
    );
    expectValidAndInvalid(appealSummaryResponseSchema, appeal, {
      ...appeal,
      reportId: "invalid"
    });
    expectValidAndInvalid(moderationAppealQueueItemResponseSchema, appealQueueItem, {
      ...appealQueueItem,
      status: "accepted"
    });
    expectValidAndInvalid(moderatorRoleResponseSchema, moderatorRole, {
      ...moderatorRole,
      userId: "invalid"
    });
    expectValidAndInvalid(auditEventResponseSchema, auditEvent, {
      ...auditEvent,
      actorRef: "invalid"
    });
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
    expectValidAndInvalid(
      roleResponse,
      { userId: id, role: "admin" },
      { userId: "invalid", role: "admin" }
    );
    expectValidAndInvalid(auditResponse, { userId: id }, { userId: "invalid" });
  });
});
