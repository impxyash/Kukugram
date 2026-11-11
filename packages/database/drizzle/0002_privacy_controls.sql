ALTER TABLE social.follows
  DROP CONSTRAINT follows_status_check;

ALTER TABLE social.follows
  ADD CONSTRAINT follows_status_check CHECK (status IN ('accepted', 'pending'));

CREATE INDEX follows_pending_by_followee
  ON social.follows (followee_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE social.blocks (
  blocker_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_by_blocked ON social.blocks (blocked_id, blocker_id);

CREATE TABLE social.mutes (
  muter_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  muted_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (muter_id, muted_id),
  CHECK (muter_id <> muted_id)
);
CREATE INDEX mutes_by_muted ON social.mutes (muted_id, muter_id);

ALTER TABLE notifications.notifications
  DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow', 'follow_request', 'like', 'comment'));
