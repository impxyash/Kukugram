CREATE SCHEMA IF NOT EXISTS content;
CREATE SCHEMA IF NOT EXISTS notifications;

ALTER TABLE social.profiles ADD COLUMN IF NOT EXISTS avatar_url text;

CREATE TABLE social.follows (
  follower_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_by_followee ON social.follows (followee_id, created_at DESC);

CREATE TABLE content.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  body varchar(2000) NOT NULL CHECK (length(trim(body)) > 0),
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX posts_feed_by_author ON content.posts (author_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE content.likes (
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX likes_by_post ON content.likes (post_id, created_at DESC);

CREATE TABLE content.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  body varchar(1000) NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_by_post ON content.comments (post_id, created_at ASC);

CREATE TABLE notifications.notifications (
  id uuid PRIMARY KEY,
  recipient_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  type varchar(16) NOT NULL CHECK (type IN ('follow', 'like', 'comment')),
  post_id uuid REFERENCES content.posts(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES content.comments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_unread_by_recipient ON notifications.notifications (recipient_id, created_at DESC) WHERE read_at IS NULL;
