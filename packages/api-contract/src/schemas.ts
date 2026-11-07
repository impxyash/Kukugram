import { z } from "zod";

/**
 * Request contracts extracted from the current API route implementations.
 * These schemas are additive contracts. Routes are not switched to them until
 * protected local route changes are reconciled.
 */

export const signupRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,30}$/),
  displayName: z.string().trim().min(1).max(60),
  bio: z.string().trim().max(500).optional()
});

export const loginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128)
});

export const profileUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  privacy: z.enum(["public", "private", "restricted_creator"]).optional()
});

export const postCreateRequestSchema = z.object({
  body: z.string().trim().min(1).max(2000)
});

export const commentCreateRequestSchema = z.object({
  body: z.string().trim().min(1).max(1000)
});

export const userSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(60)
});

export const moderationReportListQuerySchema = z.object({
  status: z.enum(["open", "reviewing", "resolved", "dismissed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const moderationAuditQuerySchema = z.object({
  reportId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const uuidParamsSchema = z.object({
  id: z.string().uuid()
});

export const handleParamsSchema = z.object({
  handle: z.string()
});

export const reportCreateRequestSchema = z.object({
  targetType: z.enum(["profile", "post", "comment"]),
  targetId: z.string().uuid(),
  category: z.enum([
    "harassment",
    "spam",
    "impersonation",
    "self_harm",
    "violence",
    "nudity",
    "copyright",
    "other"
  ]),
  details: z.string().trim().max(1000).optional()
});

export const appealCreateRequestSchema = z.object({
  details: z.string().trim().min(20).max(2000)
});

export const moderationReportUpdateRequestSchema = z.object({
  status: z.enum(["reviewing", "resolved", "dismissed"])
});

export const moderationAppealReviewRequestSchema = z.object({
  status: z.enum(["accepted", "rejected"])
});

export const moderatorRoleCreateRequestSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["moderator", "admin"])
});

export const moderatorRoleParamsSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["moderator", "admin"])
});

export const auditActorResolutionRequestSchema = z
  .object({
    actorRef: z.string().uuid(),
    reason: z.string().trim().min(20).max(500),
    password: z.string().min(1).max(128)
  })
  .strict();

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const problemDetailsSchema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional()
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  requestId: z.string()
});

export const authProvidersResponseSchema = z.object({
  password: z.boolean(),
  oauth: z.array(z.string())
});

export const profileResponseSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  followers: z.string(),
  following: z.string(),
  isFollowing: z.boolean(),
  isRequested: z.boolean(),
  privacy: z.enum(["public", "private", "restricted_creator"]),
  canViewContent: z.boolean(),
  isBlocked: z.boolean()
});

export const postResponseSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  createdAt: isoDateTimeSchema,
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  likeCount: z.string(),
  commentCount: z.string(),
  likedByViewer: z.boolean(),
  authorId: z.string().uuid()
});

export const authUserResponseSchema = z.object({
  user: profileResponseSchema
});

export const feedResponseSchema = z.object({
  posts: z.array(postResponseSchema)
});

export const userSearchResponseSchema = z.object({
  users: z.array(profileResponseSchema)
});

export const commentResponseSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  createdAt: isoDateTimeSchema,
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable()
});

export const commentCreateResponseSchema = z.object({
  id: z.string().uuid(),
  body: z.string()
});

export const notificationResponseSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["follow", "follow_request", "like", "comment"]),
  postId: z.string().uuid().nullable(),
  createdAt: isoDateTimeSchema,
  readAt: isoDateTimeSchema.nullable(),
  handle: z.string().nullable(),
  displayName: z.string().nullable()
});

export const accountControlResponseSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: isoDateTimeSchema
});

export const followRequestResponseSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  requestedAt: isoDateTimeSchema
});

export const reportCreateResponseSchema = z.object({
  reportId: z.string().uuid(),
  status: z.enum(["open", "reviewing"])
});

export const appealCreateResponseSchema = z.object({
  appealId: z.string().uuid(),
  status: z.literal("open")
});

export const likeResponseSchema = z.object({
  liked: z.literal(true)
});

export const notificationReadResponseSchema = z.object({
  ok: z.literal(true)
});

export const moderationReportUpdateResponseSchema = z.object({
  reportId: z.string().uuid(),
  status: z.enum(["reviewing", "resolved", "dismissed"])
});

export const moderationAppealReviewResponseSchema = z.object({
  appealId: z.string().uuid(),
  status: z.enum(["accepted", "rejected"])
});

export const moderatorRoleCreateResponseSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["moderator", "admin"])
});

export const auditActorResolutionResponseSchema = z.object({
  userId: z.string().uuid()
});

export const accountControlListResponseSchema = z.object({
  users: z.array(accountControlResponseSchema)
});

export const notificationListResponseSchema = z.object({
  notifications: z.array(notificationResponseSchema)
});

export const commentListResponseSchema = z.object({
  comments: z.array(commentResponseSchema)
});

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;
export type ReportCreateRequest = z.infer<typeof reportCreateRequestSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type PostResponse = z.infer<typeof postResponseSchema>;
export type CommentResponse = z.infer<typeof commentResponseSchema>;
export type NotificationResponse = z.infer<typeof notificationResponseSchema>;
