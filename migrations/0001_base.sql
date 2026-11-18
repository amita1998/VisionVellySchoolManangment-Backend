-- 0001_base.sql
-- Shared helpers, business-number sequences and domain enums.
-- Naming: snake_case, plural tables, <table>_<column> constraints.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Business number sequences
-- One sequence per document type. Sequences are never reset and never reused,
-- even when the row that consumed the number is soft-deleted.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE admission_id_seq   AS BIGINT START WITH 1 INCREMENT BY 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE employee_id_seq    AS BIGINT START WITH 1 INCREMENT BY 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE receipt_no_seq     AS BIGINT START WITH 1 INCREMENT BY 1 NO MAXVALUE CACHE 1;

-- ---------------------------------------------------------------------------
-- Enums (closed vocabularies). Configurable vocabularies live in lookup tables.
-- ---------------------------------------------------------------------------

CREATE TYPE student_status AS ENUM (
  'new_admission',        -- admitted, paperwork in progress
  'active',
  'promoted',             -- promoted to the next class at year end
  'academic_year_renewed',-- continuing the same class in the next academic year
  'graduated',            -- completed Class 12
  'transferred',          -- left for another school (TC issued)
  'withdrawn',            -- left without a transfer certificate
  'suspended'
);

CREATE TYPE teacher_status AS ENUM ('active', 'on_leave', 'resigned');

CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'late', 'half_day', 'leave');

CREATE TYPE correction_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TYPE marks_status AS ENUM ('draft', 'submitted');

CREATE TYPE exam_publish_status AS ENUM ('draft', 'published');

CREATE TYPE exam_type AS ENUM ('unit_test', 'mid_term', 'final', 'practical', 'internal_assessment');

CREATE TYPE payment_mode AS ENUM ('cash', 'cheque', 'bank_transfer', 'upi', 'card');

CREATE TYPE audience_scope AS ENUM ('all', 'classes', 'teachers', 'students', 'parents');

CREATE TYPE announcement_type AS ENUM (
  'general', 'class_wise', 'circular', 'holiday', 'exam', 'event'
);

CREATE TYPE announcement_status AS ENUM ('draft', 'published', 'archived');

CREATE TYPE installment_plan AS ENUM ('monthly', 'quarterly', 'term', 'one_time');

CREATE TYPE enrollment_status AS ENUM ('active', 'completed', 'transferred', 'withdrawn');
