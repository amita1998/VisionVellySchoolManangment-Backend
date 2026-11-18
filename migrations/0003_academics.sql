-- 0003_academics.sql
-- Academic years, classes, sections, subjects and daily periods.

CREATE TABLE academic_years (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,                    -- '2026-2027'
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT academic_years_date_order CHECK (start_date < end_date),
  CONSTRAINT academic_years_name_format CHECK (name ~ '^\d{4}-\d{4}$')
);

-- At most one academic year is marked current.
CREATE UNIQUE INDEX academic_years_one_current ON academic_years (is_current) WHERE is_current;

CREATE TRIGGER academic_years_set_updated_at BEFORE UPDATE ON academic_years
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE classes (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT NOT NULL,                       -- 'Nursery', 'Class 5'
  level_order    SMALLINT NOT NULL,                   -- 0=Nursery .. 14=Class 12
  is_pre_primary BOOLEAN NOT NULL DEFAULT FALSE,
  strength_limit SMALLINT NOT NULL DEFAULT 40,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX classes_name_key ON classes (lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX classes_level_order_key ON classes (level_order) WHERE deleted_at IS NULL;

CREATE TRIGGER classes_set_updated_at BEFORE UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE sections (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id    INTEGER NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,                          -- 'A', 'B', 'C'
  capacity    SMALLINT NOT NULL DEFAULT 40 CHECK (capacity > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX sections_class_name_key ON sections (class_id, name) WHERE deleted_at IS NULL;

CREATE TRIGGER sections_set_updated_at BEFORE UPDATE ON sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE subjects (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL,
  is_pre_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX subjects_code_key ON subjects (lower(code)) WHERE deleted_at IS NULL;

CREATE TRIGGER subjects_set_updated_at BEFORE UPDATE ON subjects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A subject is taught to a class only if a row exists here.
CREATE TABLE class_subjects (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id   INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT class_subjects_unique UNIQUE (class_id, subject_id)
);

CREATE INDEX class_subjects_subject_idx ON class_subjects (subject_id);

-- ---------------------------------------------------------------------------
-- Daily period grid. Breaks are rows with is_break = true and no period_no:
-- a partial unique index keeps teaching period numbers unique.
-- ---------------------------------------------------------------------------

CREATE TABLE periods (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_no  SMALLINT,
  label      TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  is_break   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT periods_time_order CHECK (start_time < end_time),
  CONSTRAINT periods_teaching_has_number CHECK (is_break OR period_no IS NOT NULL),
  CONSTRAINT periods_break_has_no_number CHECK (NOT is_break OR period_no IS NULL)
);

CREATE UNIQUE INDEX periods_period_no_key ON periods (period_no) WHERE period_no IS NOT NULL;
CREATE UNIQUE INDEX periods_time_key ON periods (start_time);

CREATE TRIGGER periods_set_updated_at BEFORE UPDATE ON periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
