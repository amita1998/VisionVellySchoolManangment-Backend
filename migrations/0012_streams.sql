-- 0012_streams.sql
-- Streams (Science / Commerce / Arts) for the senior classes, plus stream-aware sections and
-- subject assignment.
--
-- Why this shape:
--   * A stream is a property of the SECTION, not of the class: Class 11 has one Science section
--     and one Commerce section, and a student is admitted into a specific one.
--   * A subject is assigned to a (class, stream) pair for senior classes and to a class alone for
--     everybody else. `stream_id IS NULL` therefore keeps every existing row valid: Class 1..10
--     keep working with no change at all, and the UI shows no stream control for them.
--   * Uniqueness has to ignore the NULL, otherwise Class 11 - Science - 'A' and Class 11 -
--     Commerce - 'A' collide on (class_id, name) once two streams exist.

CREATE TABLE streams (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL,                      -- 'science' | 'commerce' | 'arts'
  name       TEXT NOT NULL,                      -- 'Science' | 'Commerce' | 'Arts'
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX streams_code_key ON streams (lower(code)) WHERE deleted_at IS NULL;

CREATE TRIGGER streams_set_updated_at BEFORE UPDATE ON streams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO streams (code, name) VALUES
  ('science',  'Science'),
  ('commerce', 'Commerce'),
  ('arts',     'Arts')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sections carry the stream (NULL for pre-primary, primary and middle school).
-- ---------------------------------------------------------------------------

ALTER TABLE sections ADD COLUMN stream_id INTEGER REFERENCES streams (id) ON DELETE RESTRICT;

DROP INDEX sections_class_name_key;
CREATE UNIQUE INDEX sections_class_name_key
  ON sections (class_id, coalesce(stream_id, 0), name) WHERE deleted_at IS NULL;

CREATE INDEX sections_stream_idx ON sections (stream_id) WHERE stream_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Subject assignment becomes per stream for senior classes.
-- ---------------------------------------------------------------------------

ALTER TABLE class_subjects ADD COLUMN stream_id INTEGER REFERENCES streams (id) ON DELETE CASCADE;

ALTER TABLE class_subjects DROP CONSTRAINT class_subjects_unique;
CREATE UNIQUE INDEX class_subjects_unique
  ON class_subjects (class_id, coalesce(stream_id, 0), subject_id);

CREATE INDEX class_subjects_stream_idx ON class_subjects (stream_id) WHERE stream_id IS NOT NULL;
