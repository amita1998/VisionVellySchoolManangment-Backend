-- 0021_hardening.sql
-- Indexes and constraints from the code audit (BE-05, BE-15, BE-20, BE-43, DB-01) plus the
-- data cleanup each one needs to be safe.
--
-- Everything here is idempotent (`IF NOT EXISTS`) and additive: no table is rewritten, no column
-- changes type. The one UPDATE repairs rows an earlier version of the app left inconsistent.

-- BE-05: an enrollment of a student who has left must not stay 'active'. Active rows are what the
-- exam publish gate, ID cards and leave/library queries trust.
UPDATE enrollments e
   SET status = CASE st.status
                  WHEN 'transferred' THEN 'transferred'::enrollment_status
                  WHEN 'graduated' THEN 'completed'::enrollment_status
                  ELSE 'withdrawn'::enrollment_status
                END
  FROM students st
 WHERE st.id = e.student_id
   AND e.status = 'active'
   AND (st.deleted_at IS NOT NULL OR st.status IN ('withdrawn', 'transferred', 'graduated'));

-- BE-15: one roll number per section per year (NULL stays allowed — not every school uses them).
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_roll_no_unique
  ON enrollments (academic_year_id, section_id, roll_no)
  WHERE roll_no IS NOT NULL;

-- BE-43: at most one PENDING correction per attendance row. Two teachers raising the same change
-- used to leave two live requests for one day.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_corrections_one_pending
  ON attendance_corrections (attendance_id)
  WHERE status = 'pending';

-- BE-20: a retried payment must not become a second payment + receipt.
ALTER TABLE fee_payments ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS fee_payments_idempotency_key
  ON fee_payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- DB-01: the admin attendance report filters on attendance_date alone; every existing index starts
-- with another column, so it scanned the table.
CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (attendance_date);
