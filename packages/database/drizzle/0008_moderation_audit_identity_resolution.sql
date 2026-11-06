-- Restricted audit identity resolution and independent append-only access evidence.
CREATE TABLE moderation.audit_identity_resolution_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id uuid,
  actor_ref uuid NOT NULL,
  purpose_scope varchar(96) NOT NULL
    CHECK (purpose_scope ~ '^moderation\\.audit\\.[a-z0-9_.-]{1,64}$'),
  reason varchar(500) NOT NULL
    CHECK (length(btrim(reason)) >= 20),
  outcome varchar(24) NOT NULL
    CHECK (outcome IN ('denied_role', 'denied_step_up', 'resolved', 'not_found')),
  request_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_audit_identity_resolution_log_recent
  ON moderation.audit_identity_resolution_log (created_at DESC);

CREATE FUNCTION moderation.reject_audit_identity_resolution_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Audit identity resolution access log is append-only';
END;
$$;

CREATE TRIGGER moderation_audit_identity_resolution_log_immutable
BEFORE UPDATE OR DELETE ON moderation.audit_identity_resolution_log
FOR EACH ROW EXECUTE FUNCTION moderation.reject_audit_identity_resolution_log_mutation();

CREATE FUNCTION moderation.resolve_audit_actor_identity(
  p_actor_ref uuid,
  p_purpose_scope varchar
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, moderation
AS $$
DECLARE
  resolved_user_id uuid;
BEGIN
  IF p_actor_ref IS NULL OR p_purpose_scope IS NULL
     OR p_purpose_scope !~ '^moderation\\.audit\\.[a-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'Invalid audit identity reference';
  END IF;

  SELECT actor_user_id INTO resolved_user_id
  FROM moderation.audit_actor_identity_map
  WHERE actor_ref = p_actor_ref AND purpose_scope = p_purpose_scope;

  RETURN resolved_user_id;
END;
$$;

REVOKE ALL ON TABLE moderation.audit_identity_resolution_log FROM PUBLIC;
REVOKE ALL ON FUNCTION moderation.resolve_audit_actor_identity(uuid, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION moderation.reject_audit_identity_resolution_log_mutation() FROM PUBLIC;

COMMENT ON TABLE moderation.audit_identity_resolution_log IS
  'Append-only record of every audit identity resolution attempt; contains the mandatory operator reason and outcome.';
COMMENT ON FUNCTION moderation.resolve_audit_actor_identity(uuid, varchar) IS
  'Restricted identity resolution primitive. EXECUTE must be granted only to a dedicated privileged resolver role after production role provisioning.';
