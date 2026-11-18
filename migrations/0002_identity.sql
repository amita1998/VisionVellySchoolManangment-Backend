-- 0002_identity.sql
-- Roles, the single users table (all four roles authenticate here), refresh tokens.
-- Role-specific profile data lives in students / teachers / parents.

CREATE TABLE roles (
  id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (code IN ('admin', 'teacher', 'student', 'parent')),
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO roles (code, name, description) VALUES
  ('admin',   'Admin',   'Full school administration'),
  ('teacher', 'Teacher', 'Class and subject teacher'),
  ('student', 'Student', 'Read-only access to own records'),
  ('parent',  'Parent',  'Read-only access to own children');

-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_id               SMALLINT NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  -- Login identifier: email for admin/teacher/parent, Admission ID for students.
  username              TEXT NOT NULL,
  email                 TEXT,
  password_hash         TEXT NOT NULL,
  must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
  password_changed_at   TIMESTAMPTZ,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  deactivated_at        TIMESTAMPTZ,
  failed_login_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_role_idx ON users (role_id) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Refresh tokens. One row per issued refresh token. Rotation creates a new row
-- and marks the old one replaced; a reused token revokes the whole family.
-- ---------------------------------------------------------------------------

CREATE TABLE refresh_tokens (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash           TEXT NOT NULL UNIQUE,
  family_id            UUID NOT NULL,
  remember_me          BOOLEAN NOT NULL DEFAULT FALSE,
  user_agent           TEXT,
  ip                   INET,
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  revoked_reason       TEXT,
  replaced_by_token_id INTEGER REFERENCES refresh_tokens (id) ON DELETE SET NULL
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;
