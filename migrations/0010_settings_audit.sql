-- 0010_settings_audit.sql
-- School settings (single row) and the audit trail for sensitive changes.

CREATE TABLE school_settings (
  id                       SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  school_name              TEXT NOT NULL,
  tagline                  TEXT,
  address                  TEXT,
  phone                    TEXT,
  email                    TEXT,
  website                  TEXT,
  logo_path                TEXT,
  current_academic_year_id INTEGER REFERENCES academic_years (id) ON DELETE SET NULL,
  fee_visible_to_students  BOOLEAN NOT NULL DEFAULT FALSE,
  attendance_lock_time     TIME NOT NULL DEFAULT '23:59',
  working_days             SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  timezone                 TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency                 TEXT NOT NULL DEFAULT 'INR',
  updated_by               INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER school_settings_set_updated_at BEFORE UPDATE ON school_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Append-only audit trail. Nothing in the application updates or deletes rows.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor_role    TEXT,
  action        TEXT NOT NULL,          -- e.g. 'student.status_changed', 'marks.override'
  entity_type   TEXT NOT NULL,
  entity_id     INTEGER,
  old_values    JSONB,
  new_values    JSONB,
  reason        TEXT,
  ip            INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE FUNCTION audit_logs_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

CREATE TRIGGER audit_logs_block_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_no_update();
