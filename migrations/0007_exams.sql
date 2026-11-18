-- 0007_exams.sql
-- Exams -> per-class schedules (one paper per class+subject) -> marks.
-- Results are invisible to students/parents until the exam is published.

CREATE TABLE grades (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,                  -- 'A+'
  min_percent NUMERIC(5, 2) NOT NULL CHECK (min_percent >= 0 AND min_percent <= 100),
  max_percent NUMERIC(5, 2) NOT NULL CHECK (max_percent > 0 AND max_percent <= 100),
  grade_point NUMERIC(3, 1) NOT NULL DEFAULT 0,
  remarks     TEXT,
  sort_order  SMALLINT NOT NULL,
  CONSTRAINT grades_range_order CHECK (min_percent < max_percent)
);

CREATE UNIQUE INDEX grades_sort_order_key ON grades (sort_order);

-- ---------------------------------------------------------------------------

CREATE TABLE examinations (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT NOT NULL,
  exam_type        exam_type NOT NULL DEFAULT 'unit_test',
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  publish_status   exam_publish_status NOT NULL DEFAULT 'draft',
  published_at     TIMESTAMPTZ,
  published_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT examinations_date_order CHECK (start_date <= end_date),
  CONSTRAINT examinations_publish_consistency CHECK (
    (publish_status = 'published' AND published_at IS NOT NULL)
    OR (publish_status <> 'published')
  )
);

CREATE INDEX examinations_year_idx ON examinations (academic_year_id, start_date DESC);
CREATE UNIQUE INDEX examinations_name_key ON examinations (academic_year_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE TRIGGER examinations_set_updated_at BEFORE UPDATE ON examinations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE exam_schedules (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id     INTEGER NOT NULL REFERENCES examinations (id) ON DELETE CASCADE,
  class_id    INTEGER NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  subject_id  INTEGER NOT NULL REFERENCES subjects (id) ON DELETE RESTRICT,
  exam_date   DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  room        TEXT,
  max_marks   NUMERIC(6, 2) NOT NULL DEFAULT 100 CHECK (max_marks > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_schedules_one_paper UNIQUE (exam_id, class_id, subject_id),
  CONSTRAINT exam_schedules_time_order CHECK (start_time < end_time)
);

CREATE INDEX exam_schedules_exam_date_idx ON exam_schedules (exam_id, exam_date);
CREATE INDEX exam_schedules_class_idx ON exam_schedules (class_id);

CREATE TRIGGER exam_schedules_set_updated_at BEFORE UPDATE ON exam_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Marks are entered per student per paper. draft -> submitted -> (admin unlock
-- back to draft). Every change is written to audit_logs by the service layer.
-- ---------------------------------------------------------------------------

CREATE TABLE marks (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules (id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  marks_obtained   NUMERIC(6, 2) CHECK (marks_obtained >= 0),
  is_absent        BOOLEAN NOT NULL DEFAULT FALSE,
  grade_id         INTEGER REFERENCES grades (id) ON DELETE SET NULL,
  status           marks_status NOT NULL DEFAULT 'draft',
  remarks          TEXT,
  entered_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  submitted_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marks_one_per_student UNIQUE (exam_schedule_id, student_id),
  CONSTRAINT marks_absent_has_no_value CHECK (NOT is_absent OR marks_obtained IS NULL)
);

CREATE INDEX marks_student_idx ON marks (student_id);
CREATE INDEX marks_schedule_status_idx ON marks (exam_schedule_id, status);

CREATE TRIGGER marks_set_updated_at BEFORE UPDATE ON marks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
