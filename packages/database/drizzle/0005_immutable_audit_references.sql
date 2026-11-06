-- Audit events are append-only historical records. Keep UUID references as values,
-- not foreign keys, so deleting an account/report cannot mutate or block the audit log.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'moderation.audit_events'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE moderation.audit_events DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$$;
