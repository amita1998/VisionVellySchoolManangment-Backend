-- 0013_library.sql
-- Library: catalogue, copies, issues, returns and fines.
--
-- Shape decisions:
--   * One row per BOOK TITLE with `total_copies` / `available_copies`; copy-level tracking
--     (accession numbers) is a later refinement, not a v1 requirement. The counter is updated
--     inside the same transaction that issues/returns, so it can never drift.
--   * An issue points at either a student or a teacher (`student_id` XOR `teacher_id`), which
--     keeps the membership rule in the database instead of in a comment.
--   * A fine is computed on return from `school_settings.library_fine_per_day`, and stored on
--     the issue row so the amount charged never changes when the rate is edited later.

CREATE TABLE library_books (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title            TEXT NOT NULL,
  author           TEXT,
  isbn             TEXT,
  category         TEXT NOT NULL DEFAULT 'General',
  publisher        TEXT,
  published_year   SMALLINT,
  total_copies     SMALLINT NOT NULL DEFAULT 1 CHECK (total_copies >= 1),
  available_copies SMALLINT NOT NULL DEFAULT 1 CHECK (available_copies >= 0),
  shelf            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT library_books_copies_within_total CHECK (available_copies <= total_copies),
  CONSTRAINT library_books_year_sane CHECK (published_year IS NULL OR published_year BETWEEN 1400 AND 2100)
);

CREATE UNIQUE INDEX library_books_isbn_key
  ON library_books (lower(isbn)) WHERE isbn IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX library_books_title_idx ON library_books (lower(title)) WHERE deleted_at IS NULL;
CREATE INDEX library_books_category_idx ON library_books (lower(category)) WHERE deleted_at IS NULL;

CREATE TRIGGER library_books_set_updated_at BEFORE UPDATE ON library_books
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE library_issues (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id     INTEGER NOT NULL REFERENCES library_books (id) ON DELETE RESTRICT,
  student_id  INTEGER REFERENCES students (id) ON DELETE CASCADE,
  teacher_id  INTEGER REFERENCES teachers (id) ON DELETE CASCADE,
  issued_on   DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  due_on      DATE NOT NULL,
  returned_on DATE,
  status      TEXT NOT NULL DEFAULT 'issued',
  fine_amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (fine_amount >= 0),
  fine_paid   BOOLEAN NOT NULL DEFAULT FALSE,
  notes       TEXT,
  issued_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  returned_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT library_issues_member_xor CHECK ((student_id IS NULL) <> (teacher_id IS NULL)),
  CONSTRAINT library_issues_status_valid CHECK (status IN ('issued', 'returned', 'lost')),
  CONSTRAINT library_issues_due_after_issue CHECK (due_on >= issued_on),
  CONSTRAINT library_issues_returned_needs_date CHECK (status <> 'returned' OR returned_on IS NOT NULL)
);

CREATE INDEX library_issues_book_idx ON library_issues (book_id);
CREATE INDEX library_issues_student_idx ON library_issues (student_id);
CREATE INDEX library_issues_teacher_idx ON library_issues (teacher_id);
-- One open loan per book per member: the same person cannot hold two copies of one title.
CREATE UNIQUE INDEX library_issues_one_open_per_member
  ON library_issues (book_id, coalesce(student_id, 0), coalesce(teacher_id, 0))
  WHERE status = 'issued';

CREATE TRIGGER library_issues_set_updated_at BEFORE UPDATE ON library_issues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Fine rate lives with the other school settings (default ₹2 per overdue day).
-- ---------------------------------------------------------------------------

ALTER TABLE school_settings
  ADD COLUMN library_fine_per_day NUMERIC(10, 2) NOT NULL DEFAULT 2.00
  CHECK (library_fine_per_day >= 0);
