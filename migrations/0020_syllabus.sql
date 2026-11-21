-- 0020_syllabus.sql
-- Chapter-wise syllabus per (class, stream, subject) plus the portion attached to each exam paper.
--
-- Shape decisions:
--   * A chapter belongs to a CLASS + SUBJECT (+ STREAM for the senior classes), exactly like
--     `class_subjects`, so Class 11 Science and Class 11 Commerce keep separate chapter lists while
--     Class 5 keeps `stream_id IS NULL`.
--   * Uniqueness ignores the NULL stream for the same reason as `sections`/`class_subjects`
--     (`coalesce(stream_id, 0)`), otherwise two NULL rows of the same chapter number both pass.
--   * `covered_on` is the teacher's tick: NULL means not taught yet, a date means covered. Progress
--     is therefore a count, never a stored percentage that can drift.
--   * The exam portion is a link table to `exam_schedules` (one paper = one exam + class + subject),
--     so "what is in this paper" is answered by the same rows the marks sheet already uses.

CREATE TABLE syllabus_chapters (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  class_id         INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  stream_id        INTEGER REFERENCES streams (id) ON DELETE RESTRICT,
  subject_id       INTEGER NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  chapter_no       SMALLINT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  covered_on       DATE,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT syllabus_chapters_no CHECK (chapter_no > 0),
  CONSTRAINT syllabus_chapters_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX syllabus_chapters_key
  ON syllabus_chapters (academic_year_id, class_id, coalesce(stream_id, 0), subject_id, chapter_no)
  WHERE deleted_at IS NULL;

CREATE INDEX syllabus_chapters_lookup_idx
  ON syllabus_chapters (academic_year_id, class_id, subject_id) WHERE deleted_at IS NULL;

CREATE TRIGGER syllabus_chapters_set_updated_at BEFORE UPDATE ON syllabus_chapters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE syllabus_portions (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_schedule_id INTEGER NOT NULL REFERENCES exam_schedules (id) ON DELETE CASCADE,
  chapter_id       INTEGER NOT NULL REFERENCES syllabus_chapters (id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT syllabus_portions_unique UNIQUE (exam_schedule_id, chapter_id)
);

CREATE INDEX syllabus_portions_chapter_idx ON syllabus_portions (chapter_id);
