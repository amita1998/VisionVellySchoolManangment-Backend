-- 0017_leave_short.sql
-- Short leaves, and the two-way leave notifications they trigger.
--
-- Why a duration instead of another leave type: a school day is not the smallest unit of
-- absence. A teacher may need two hours for a hospital visit; a student may need the afternoon
-- off. Modelling that as separate leave TYPES would multiply the quota bookkeeping, so the
-- request keeps its type (sick / casual / short …) and gains a duration:
--
--   full_day  — the existing behaviour, an inclusive date range
--   half_day  — one date, counts 0.5 day against the quota
--   hourly    — one date, 1..8 hours, counts hours/8 of a day
--
-- `days` therefore becomes NUMERIC(4,2): a half day is 0.5 and an hour is 0.125.
-- Existing rows are full_day, so the migration is backwards compatible.

ALTER TABLE leave_requests
  ALTER COLUMN days TYPE NUMERIC(4, 2);

ALTER TABLE leave_requests
  ADD COLUMN duration_type TEXT NOT NULL DEFAULT 'full_day',
  ADD COLUMN hours         SMALLINT;

ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_duration
    CHECK (duration_type IN ('full_day', 'half_day', 'hourly')),
  -- hours exist exactly for an hourly leave, and the day has at most eight working hours
  ADD CONSTRAINT leave_requests_hours
    CHECK (
      (duration_type = 'hourly' AND hours BETWEEN 1 AND 8)
      OR (duration_type <> 'hourly' AND hours IS NULL)
    ),
  -- anything shorter than a day cannot span dates
  ADD CONSTRAINT leave_requests_short_is_single_day
    CHECK (duration_type = 'full_day' OR from_date = to_date);

-- A dedicated type keeps "short absence" visible in the register and in reports, while the
-- duration above decides how much of the day it actually costs.
INSERT INTO leave_types (code, name, applies_to, annual_quota)
VALUES ('short', 'Short leave (a few hours)', 'both', 12)
ON CONFLICT DO NOTHING;
