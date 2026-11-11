-- Purpose-scoped, opaque references for newly written moderation audit events.
-- The mapping is intentionally separate from immutable audit_events and has no user FK,
-- so account deletion does not rewrite historical attribution.
CREATE TABLE moderation.audit_actor_identity_map (
  purpose_scope varchar(96) NOT NULL
    CHECK (purpose_scope ~ '^moderation\.audit\.[a-z0-9_.-]{1,64}$'),
  actor_user_id uuid NOT NULL,
  actor_ref uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (purpose_scope, actor_user_id),
  UNIQUE (purpose_scope, actor_ref)
);

ALTER TABLE moderation.audit_events
  ADD COLUMN actor_ref uuid;

CREATE INDEX moderation_audit_by_actor_ref
  ON moderation.audit_events (actor_ref, created_at DESC);

REVOKE ALL ON TABLE moderation.audit_actor_identity_map FROM PUBLIC;

CREATE FUNCTION moderation.resolve_audit_actor_ref(
  p_actor_user_id uuid,
  p_purpose_scope varchar
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, moderation
AS $$
DECLARE
  resolved_ref uuid;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Audit actor is required';
  END IF;

  IF p_purpose_scope IS NULL
     OR p_purpose_scope !~ '^moderation\.audit\.[a-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'Invalid audit identity purpose scope';
  END IF;

  INSERT INTO moderation.audit_actor_identity_map (purpose_scope, actor_user_id)
  VALUES (p_purpose_scope, p_actor_user_id)
  ON CONFLICT (purpose_scope, actor_user_id)
  DO UPDATE SET actor_user_id = EXCLUDED.actor_user_id
  RETURNING actor_ref INTO resolved_ref;

  RETURN resolved_ref;
END;
$$;

COMMENT ON TABLE moderation.audit_actor_identity_map IS
  'Restricted identity mapping for purpose-scoped moderation audit actor references; never expose this table through application APIs.';
COMMENT ON COLUMN moderation.audit_events.actor_ref IS
  'Opaque, purpose-scoped actor reference for newly written events; legacy actor_id values remain restricted.';
