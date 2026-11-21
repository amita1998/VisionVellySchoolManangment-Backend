-- 0019_chat.sql
-- Parent–teacher chat board: one thread per (child, teacher), messages inside it.
--
-- Shape decisions:
--   * A thread is identified by the CHILD and the TEACHER, not by the parent's account. Two
--     guardians of the same child (mother and father, or one shared family login) therefore write
--     into the same conversation, and the child appears in exactly one thread per teacher.
--   * Messages record the sender's user id and role; the thread itself does not hold a "last
--     message" column beyond `last_message_at` (kept on the thread so the inbox sorts in one scan
--     without a correlated subquery over a growing table).
--   * Read state is per (thread, user) rather than a boolean on the message, because a thread has
--     two sides and a sibling family may read with a different account.
--   * Students do not get the board: only a teacher of the child and the child's guardians can read
--     or write. The API enforces that; the permission matrix never grants chat to `student`.

CREATE TABLE chat_threads (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  student_id       INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  teacher_id       INTEGER NOT NULL REFERENCES teachers (id) ON DELETE CASCADE,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  last_message_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_threads_one_per_pair UNIQUE (student_id, teacher_id)
);

CREATE INDEX chat_threads_teacher_idx ON chat_threads (teacher_id, last_message_at DESC NULLS LAST);
CREATE INDEX chat_threads_student_idx ON chat_threads (student_id, last_message_at DESC NULLS LAST);

CREATE TRIGGER chat_threads_set_updated_at BEFORE UPDATE ON chat_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE chat_messages (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id      INTEGER NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  sender_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sender_role    TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_role CHECK (sender_role IN ('teacher', 'parent', 'admin')),
  CONSTRAINT chat_messages_body CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)
);

CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_id, id);
CREATE INDEX chat_messages_sender_idx ON chat_messages (sender_user_id);

CREATE TABLE chat_reads (
  thread_id    INTEGER NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);
