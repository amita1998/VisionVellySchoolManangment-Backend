import { query } from '../config/db.js';

const USER_SELECT = `
  SELECT u.id, u.username, u.email, u.password_hash, u.must_change_password, u.is_active,
         u.failed_login_attempts, u.locked_until, u.last_login_at, u.deleted_at,
         r.code AS role
  FROM users u
  JOIN roles r ON r.id = u.role_id
`;

/**
 * One identifier for every role. `users.username` is unique (case-insensitive) and so is
 * `users.email`, so a username match is preferred and the email branch is the fallback —
 * without the ORDER BY a value that is one account's username and another's email would
 * resolve arbitrarily.
 */
export function findByIdentifier(identifier) {
  return query(
    `${USER_SELECT}
      WHERE lower(u.username) = lower($1) OR lower(u.email) = lower($1)
      ORDER BY (lower(u.username) = lower($1)) DESC, u.id
      LIMIT 1`,
    [identifier],
  ).then((result) => result.rows[0] || null);
}

export function findById(id) {
  return query(`${USER_SELECT} WHERE u.id = $1 LIMIT 1`, [id]).then((result) => result.rows[0] || null);
}

/** Public shape — never includes password_hash. */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    mustChangePassword: row.must_change_password,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
  };
}

export async function registerFailedAttempt(userId, maxAttempts, lockMinutes) {
  const { rows } = await query(
    `UPDATE users
        SET failed_login_attempts =
              CASE WHEN locked_until IS NOT NULL AND locked_until < now() THEN 1
                   ELSE failed_login_attempts + 1 END,
            locked_until = CASE
              WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until < now() THEN 1
                         ELSE failed_login_attempts + 1 END) >= $2
              THEN now() + ($3 || ' minutes')::interval
              ELSE locked_until END,
            updated_at = now()
      WHERE id = $1
      RETURNING failed_login_attempts, locked_until`,
    [userId, maxAttempts, String(lockMinutes)],
  );
  return rows[0];
}

export async function registerSuccessfulLogin(userId) {
  await query(
    `UPDATE users
        SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
      WHERE id = $1`,
    [userId],
  );
}

export async function setPassword(userId, passwordHash) {
  await query(
    `UPDATE users
        SET password_hash = $2, must_change_password = FALSE, password_changed_at = now(),
            failed_login_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [userId, passwordHash],
  );
}
