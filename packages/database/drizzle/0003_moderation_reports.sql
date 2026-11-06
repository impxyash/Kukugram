CREATE SCHEMA IF NOT EXISTS moderation;

CREATE TABLE moderation.reports (
  id uuid PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  target_type varchar(16) NOT NULL CHECK (target_type IN ('profile', 'post', 'comment')),
  target_id uuid NOT NULL,
  category varchar(24) NOT NULL CHECK (category IN ('harassment', 'spam', 'impersonation', 'self_harm', 'violence', 'nudity', 'copyright', 'other')),
  details varchar(1000),
  status varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX reports_active_duplicate
  ON moderation.reports (reporter_id, target_type, target_id)
  WHERE status IN ('open', 'reviewing');

CREATE INDEX reports_queue
  ON moderation.reports (status, created_at ASC);
