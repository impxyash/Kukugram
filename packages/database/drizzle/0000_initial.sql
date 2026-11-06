CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS social;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE identity.users (
  id uuid PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  password_hash text,
  email_verified_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (password_hash IS NULL OR length(password_hash) > 20)
);

CREATE TABLE social.profiles (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  handle varchar(30) NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,30}$'),
  display_name varchar(60) NOT NULL,
  bio varchar(500),
  privacy varchar(32) NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private', 'restricted_creator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_active_by_user ON identity.sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY,
  topic varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON platform.outbox_events (occurred_at) WHERE published_at IS NULL;
