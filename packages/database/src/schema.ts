import {
  boolean,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

export const identity = pgSchema("identity");
export const social = pgSchema("social");
export const platform = pgSchema("platform");
export const content = pgSchema("content");
export const notifications = pgSchema("notifications");
export const moderation = pgSchema("moderation");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

export const users = identity.table("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps
});

export const profiles = social.table("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  handle: varchar("handle", { length: 30 }).notNull().unique(),
  displayName: varchar("display_name", { length: 60 }).notNull(),
  bio: varchar("bio", { length: 500 }),
  avatarUrl: text("avatar_url"),
  privacy: varchar("privacy", { length: 32 }).notNull().default("public"),
  ...timestamps
});

export const follows = social.table(
  "follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 16 }).notNull().default("accepted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.followerId, table.followeeId] })]
);

export const blocks = social.table(
  "blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.blockerId, table.blockedId] })]
);

export const mutes = social.table(
  "mutes",
  {
    muterId: uuid("muter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mutedId: uuid("muted_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.muterId, table.mutedId] })]
);

export const posts = content.table("posts", {
  id: uuid("id").primaryKey(),
  authorId: uuid("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  body: varchar("body", { length: 2000 }).notNull(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true })
});

export const likes = content.table("likes", {
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  postId: uuid("post_id")
    .notNull()
    .references(() => posts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const comments = content.table("comments", {
  id: uuid("id").primaryKey(),
  postId: uuid("post_id")
    .notNull()
    .references(() => posts.id, { onDelete: "cascade" }),
  authorId: uuid("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  body: varchar("body", { length: 1000 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const userNotifications = notifications.table("notifications", {
  id: uuid("id").primaryKey(),
  recipientId: uuid("recipient_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  type: varchar("type", { length: 16 }).notNull(),
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true })
});

export const sessions = identity.table("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps
});

export const outboxEvents = platform.table("outbox_events", {
  id: uuid("id").primaryKey(),
  topic: varchar("topic", { length: 128 }).notNull(),
  payload: jsonb("payload").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true })
});

export const reports = moderation.table("reports", {
  id: uuid("id").primaryKey(),
  reporterId: uuid("reporter_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  targetType: varchar("target_type", { length: 16 }).notNull(),
  targetId: uuid("target_id").notNull(),
  category: varchar("category", { length: 24 }).notNull(),
  details: varchar("details", { length: 1000 }),
  status: varchar("status", { length: 16 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const moderatorRoles = moderation.table(
  "moderator_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })]
);

export const moderationAuditEvents = moderation.table("audit_events", {
  id: uuid("id").primaryKey(),
  actorId: uuid("actor_id"),
  action: varchar("action", { length: 48 }).notNull(),
  reportId: uuid("report_id"),
  subjectUserId: uuid("subject_user_id"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const moderationAppeals = moderation.table("appeals", {
  id: uuid("id").primaryKey(),
  reportId: uuid("report_id")
    .notNull()
    .unique()
    .references(() => reports.id, { onDelete: "cascade" }),
  appellantId: uuid("appellant_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  details: varchar("details", { length: 2000 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("open"),
  reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
