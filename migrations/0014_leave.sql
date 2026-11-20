-- 0014_leave.sql
-- Leave: types (with a yearly quota), applications, decisions.
--
-- Shape decisions:
--   * An application belongs to either a student or a teacher (`student_id` XOR `teacher_id`) —
--     same rule as the library, and it is enforced by the database, not by convention.
--   * `days` is stored on the row: it is what the quota is counted against, and it must not change
--     when a calendar rule is edited later.
--   * Overlapping applications cannot be expressed with a plain unique index on a date RANGE, so the
--     service rejects the overlap by query — the alternative (btree_gist + EXCLUDE) needs an
--     extension that a managed Postgres may not have.
--   * An approved student leave writes 'leave' rows into `attendance`, which is where a class
--     teacher looks. `attendance_one_per_day` makes the upsert idempotent.

CREATE TABLE leave_types (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  applies_to         TEXT NOT NULL DEFAULT 'both',
  annual_quota       SMALLINT,                       -- NULL = no limit
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT leave_types_applies CHECK (applies_to IN ('student', 'staff', 'both')),
  CONSTRAINT leave_types_quota_sane CHECK (annual_quota IS NULL OR annual_quota BETWEEN 1 AND 365)
);

CREATE UNIQUE INDEX leave_types_code_key ON leave_types (lower(code)) WHERE deleted_at IS NULL;

CREATE TRIGGER leave_types_set_updated_at BEFORE UPDATE ON leave_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO leave_types (code, name, applies_to, annual_quota) VALUES
  ('sick',   'Sick leave',   'both',    12),
  ('casual', 'Casual leave', 'both',    10),
  ('duty',   'Duty leave',   'student', 15),
  ('maternity', 'Maternity leave', 'staff', 180)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------

CREATE TABLE leave_requests (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  leave_type_id    INTEGER NOT NULL REFERENCES leave_types (id) ON DELETE RESTRICT,
  student_id       INTEGER REFERENCES students (id) ON DELETE CASCADE,
  teacher_id       INTEGER REFERENCES teachers (id) ON DELETE CASCADE,
  from_date        DATE NOT NULL,
  to_date          DATE NOT NULL,
  days             SMALLINT NOT NULL CHECK (days > 0),
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  requested_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  decided_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ,
  decision_note    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_member_xor CHECK ((student_id IS NULL) <> (teacher_id IS NULL)),
  CONSTRAINT leave_requests_range CHECK (to_date >= from_date),
  CONSTRAINT leave_requests_status CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT leave_requests_decision_consistent CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status = 'cancelled')
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX leave_requests_student_idx ON leave_requests (student_id, status);
CREATE INDEX leave_requests_teacher_idx ON leave_requests (teacher_id, status);
CREATE INDEX leave_requests_pending_idx ON leave_requests (status, created_at DESC);

CREATE TRIGGER leave_requests_set_updated_at BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
