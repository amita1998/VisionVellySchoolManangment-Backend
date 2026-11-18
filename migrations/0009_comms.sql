-- 0009_comms.sql
-- Events, announcements, in-app notifications, assignments.

CREATE TABLE event_categories (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX event_categories_name_key ON event_categories (lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER event_categories_set_updated_at BEFORE UPDATE ON event_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE events (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  category_id  INTEGER REFERENCES event_categories (id) ON DELETE SET NULL,
  event_date   DATE NOT NULL,
  start_time   TIME,
  end_time     TIME,
  location     TEXT,
  audience     audience_scope NOT NULL DEFAULT 'all',
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT events_time_order CHECK (
    start_time IS NULL OR end_time IS NULL OR start_time < end_time
  )
);

CREATE INDEX events_date_idx ON events (event_date) WHERE deleted_at IS NULL;
CREATE INDEX events_published_idx ON events (is_published, event_date);

CREATE TRIGGER events_set_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_classes (
  event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, class_id)
);

-- ---------------------------------------------------------------------------

CREATE TABLE announcements (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  type         announcement_type NOT NULL DEFAULT 'general',
  status       announcement_status NOT NULL DEFAULT 'draft',
  audience     audience_scope NOT NULL DEFAULT 'all',
  published_at TIMESTAMPTZ,
  archived_at  TIMESTAMPTZ,
  created_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT announcements_publish_consistency CHECK (
    (status = 'published' AND published_at IS NOT NULL) OR status <> 'published'
  )
);

CREATE INDEX announcements_status_idx ON announcements (status, published_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX announcements_type_idx ON announcements (type);

CREATE TRIGGER announcements_set_updated_at BEFORE UPDATE ON announcements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE announcement_classes (
  announcement_id INTEGER NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  class_id        INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, class_id)
);

CREATE TABLE announcement_attachments (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  announcement_id INTEGER NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX announcement_attachments_announcement_idx ON announcement_attachments (announcement_id);

CREATE TABLE announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX announcement_reads_user_idx ON announcement_reads (user_id);

-- ---------------------------------------------------------------------------
-- In-app notifications only (no email/SMS in this release).
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  entity_type TEXT,
  entity_id   INTEGER,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_read_idx ON notifications (user_id, read_at) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------

CREATE TABLE assignments (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  class_id    INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  section_id  INTEGER REFERENCES sections (id) ON DELETE CASCADE,
  subject_id  INTEGER NOT NULL REFERENCES subjects (id) ON DELETE RESTRICT,
  teacher_id  INTEGER NOT NULL REFERENCES teachers (id) ON DELETE RESTRICT,
  due_date    DATE NOT NULL,
  created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX assignments_class_idx ON assignments (class_id, section_id, due_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX assignments_teacher_idx ON assignments (teacher_id);

CREATE TRIGGER assignments_set_updated_at BEFORE UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE assignment_attachments (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX assignment_attachments_assignment_idx ON assignment_attachments (assignment_id);
