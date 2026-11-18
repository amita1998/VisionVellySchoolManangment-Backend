-- 0005_timetable.sql
-- Class timetable. One lesson per (section, day, period) and a teacher can only
-- be in one room at a time — both enforced by unique indexes, not by the UI.

CREATE TABLE timetable_slots (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE CASCADE,
  section_id       INTEGER NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  day_of_week      SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 6), -- 1=Mon .. 6=Sat
  period_id        INTEGER NOT NULL REFERENCES periods (id) ON DELETE RESTRICT,
  subject_id       INTEGER NOT NULL REFERENCES subjects (id) ON DELETE RESTRICT,
  teacher_id       INTEGER NOT NULL REFERENCES teachers (id) ON DELETE RESTRICT,
  room             TEXT,
  effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT timetable_slots_one_lesson UNIQUE (academic_year_id, section_id, day_of_week, period_id),
  CONSTRAINT timetable_slots_teacher_not_double_booked UNIQUE (academic_year_id, teacher_id, day_of_week, period_id)
);

CREATE INDEX timetable_slots_section_idx ON timetable_slots (academic_year_id, section_id);
CREATE INDEX timetable_slots_teacher_idx ON timetable_slots (academic_year_id, teacher_id, day_of_week);

CREATE TRIGGER timetable_slots_set_updated_at BEFORE UPDATE ON timetable_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
