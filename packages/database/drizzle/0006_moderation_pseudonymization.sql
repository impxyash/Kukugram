-- Preserve moderation cases after account deletion while severing direct identity links.
-- Random per-case pseudonyms are deliberately not shared across separate reports/appeals.
ALTER TABLE moderation.reports
  ADD COLUMN reporter_pseudonym_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE moderation.reports
  ADD CONSTRAINT reports_reporter_pseudonym_id_unique UNIQUE (reporter_pseudonym_id);

ALTER TABLE moderation.appeals
  ADD COLUMN appellant_pseudonym_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE moderation.appeals
  ADD CONSTRAINT appeals_appellant_pseudonym_id_unique UNIQUE (appellant_pseudonym_id);

ALTER TABLE moderation.reports
  ALTER COLUMN reporter_id DROP NOT NULL;

ALTER TABLE moderation.appeals
  ALTER COLUMN appellant_id DROP NOT NULL;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'moderation.reports'::regclass
      AND c.contype = 'f'
      AND a.attname = 'reporter_id'
  LOOP
    EXECUTE format('ALTER TABLE moderation.reports DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'moderation.appeals'::regclass
      AND c.contype = 'f'
      AND a.attname = 'appellant_id'
  LOOP
    EXECUTE format('ALTER TABLE moderation.appeals DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

ALTER TABLE moderation.reports
  ADD CONSTRAINT reports_reporter_id_fkey
  FOREIGN KEY (reporter_id) REFERENCES identity.users(id) ON DELETE SET NULL;

ALTER TABLE moderation.appeals
  ADD CONSTRAINT appeals_appellant_id_fkey
  FOREIGN KEY (appellant_id) REFERENCES identity.users(id) ON DELETE SET NULL;
