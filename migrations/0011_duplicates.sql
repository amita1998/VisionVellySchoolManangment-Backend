-- 0011_duplicates.sql
-- Stop the same person being admitted/created twice. Both constraints only look at
-- living rows, so a soft-deleted record never blocks a fresh admission and a
-- re-hired teacher is allowed once their old row is deleted.

-- One living student per (name, date of birth).
CREATE UNIQUE INDEX IF NOT EXISTS students_identity_unique
  ON students (lower(btrim(first_name)), lower(btrim(last_name)), date_of_birth)
  WHERE deleted_at IS NULL;

-- One living teacher per mobile number (the email is already unique through users.username).
CREATE UNIQUE INDEX IF NOT EXISTS teachers_mobile_unique
  ON teachers (mobile)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX students_identity_unique IS
  'A second admission of the same name + date of birth is a duplicate; edit the existing record.';
COMMENT ON INDEX teachers_mobile_unique IS
  'Two living teachers cannot share a mobile number.';
