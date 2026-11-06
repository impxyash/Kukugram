CREATE TABLE moderation.moderator_roles (
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('moderator', 'admin')),
  granted_by uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX moderator_roles_by_role ON moderation.moderator_roles (role, granted_at DESC);

CREATE TABLE moderation.audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  action varchar(48) NOT NULL,
  report_id uuid REFERENCES moderation.reports(id) ON DELETE SET NULL,
  subject_user_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_audit_by_report ON moderation.audit_events (report_id, created_at DESC);
CREATE INDEX moderation_audit_by_actor ON moderation.audit_events (actor_id, created_at DESC);

CREATE FUNCTION moderation.prevent_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Moderation audit events are immutable';
END;
$$;

CREATE TRIGGER moderation_audit_immutable
BEFORE UPDATE OR DELETE ON moderation.audit_events
FOR EACH ROW EXECUTE FUNCTION moderation.prevent_audit_mutation();

CREATE TABLE moderation.appeals (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL UNIQUE REFERENCES moderation.reports(id) ON DELETE CASCADE,
  appellant_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  details varchar(2000) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  reviewer_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_appeals_queue ON moderation.appeals (status, created_at ASC);
