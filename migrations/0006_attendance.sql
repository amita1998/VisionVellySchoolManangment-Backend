-- 0006_attendance.sql
-- Daily attendance: one row per student per calendar day, marked by the class
-- teacher of the section. Corrections keep the old value instead of overwriting it.

CREATE TABLE attendance (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  section_id       INTEGER NOT NULL REFERENCES sections (id) ON DELETE RESTRICT,
  attendance_date  DATE NOT NULL,
  status           attendance_status NOT NULL,
  remarks          TEXT,
  marked_by        INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  marked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendance_one_per_day UNIQUE (student_id, attendance_date)
);

CREATE INDEX attendance_section_date_idx ON attendance (section_id, attendance_date);
CREATE INDEX attendance_student_date_idx ON attendance (student_id, attendance_date DESC);
CREATE INDEX attendance_year_idx ON attendance (academic_year_id, attendance_date);

CREATE TRIGGER attendance_set_updated_at BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- A correction is requested by the class teacher and approved/rejected by an
-- admin. Nothing is updated until it is approved, and the applied values are
-- copied onto this row so history survives later edits.
-- ---------------------------------------------------------------------------

CREATE TABLE attendance_corrections (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attendance_id    INTEGER NOT NULL REFERENCES attendance (id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  old_status       attendance_status NOT NULL,
  requested_status attendance_status NOT NULL,
  reason           TEXT NOT NULL,
  status           correction_status NOT NULL DEFAULT 'pending',
  requested_by     INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_by      INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_at      TIMESTAMPTZ,
  review_comment   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendance_corrections_status_change CHECK (old_status <> requested_status),
  CONSTRAINT attendance_corrections_review_consistency CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX attendance_corrections_pending_idx ON attendance_corrections (status, created_at DESC);
CREATE INDEX attendance_corrections_attendance_idx ON attendance_corrections (attendance_id);
CREATE INDEX attendance_corrections_requester_idx ON attendance_corrections (requested_by);

CREATE TRIGGER attendance_corrections_set_updated_at BEFORE UPDATE ON attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
