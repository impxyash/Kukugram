-- Additive indexes for stable global-feed and recipient-notification keyset pagination.
CREATE INDEX IF NOT EXISTS posts_feed_global_cursor
  ON content.posts (created_at DESC, id DESC)
  INCLUDE (author_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_recipient_cursor
  ON notifications.notifications (recipient_id, created_at DESC, id DESC);
