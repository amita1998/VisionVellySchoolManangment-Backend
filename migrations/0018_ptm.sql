-- 0018_ptm.sql
-- Parent–teacher meetings: a teacher publishes time slots, a parent books one per child.
--
-- Shape decisions:
--   * A slot belongs to ONE teacher and ONE date, with a start/end time. `capacity` allows a
--     group slot (a whole section), defaulting to one family.
--   * A booking is (slot, student) unique — the same child cannot hold two places in one slot,
--     and the database says so rather than the UI.
--   * Cancelling a slot closes it to new bookings but keeps the existing ones for history; the
--     status lives on the slot, not on the booking.
--   * `booked_by` keeps the user id of whoever booked (a parent, or the office on their behalf).

CREATE TABLE ptm_slots (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  teacher_id       INTEGER NOT NULL REFERENCES teachers (id) ON DELETE CASCADE,
  slot_date        DATE NOT NULL,
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'in_person',
  location         TEXT,
  capacity         SMALLINT NOT NULL DEFAULT 1,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT ptm_slots_mode CHECK (mode IN ('in_person', 'online', 'phone')),
  CONSTRAINT ptm_slots_status CHECK (status IN ('open', 'closed', 'cancelled')),
  CONSTRAINT ptm_slots_capacity CHECK (capacity BETWEEN 1 AND 20),
  CONSTRAINT ptm_slots_times CHECK (end_time > start_time)
);

CREATE INDEX ptm_slots_teacher_idx ON ptm_slots (teacher_id, slot_date);
CREATE INDEX ptm_slots_open_idx ON ptm_slots (slot_date) WHERE status = 'open' AND deleted_at IS NULL;

CREATE TRIGGER ptm_slots_set_updated_at BEFORE UPDATE ON ptm_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ptm_bookings (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slot_id    INTEGER NOT NULL REFERENCES ptm_slots (id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  booked_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'booked',
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ptm_bookings_status CHECK (status IN ('booked', 'attended', 'no_show', 'cancelled')),
  CONSTRAINT ptm_bookings_one_place UNIQUE (slot_id, student_id)
);

CREATE INDEX ptm_bookings_student_idx ON ptm_bookings (student_id, status);

CREATE TRIGGER ptm_bookings_set_updated_at BEFORE UPDATE ON ptm_bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
