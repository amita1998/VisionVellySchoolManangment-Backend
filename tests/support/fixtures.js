import './testEnv.js';
import bcrypt from 'bcryptjs';
import { ACCOUNTS, TEST_PASSWORD } from './testEnv.js';
import { pool } from '../../src/config/db.js';
import { resetDatabase } from './db.js';

/**
 * Minimal fixtures for authentication tests: one account per role plus a throwaway
 * account used to prove the lockout. Profile rows (student/teacher/parent) are not
 * needed until the modules that read them exist.
 */
export async function seedAuthFixtures() {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4); // low cost: tests only

  const ids = {};
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    const { rows } = await pool.query(
      `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
       VALUES ((SELECT id FROM roles WHERE code = $1), $2, $3, $4, FALSE)
       RETURNING id`,
      [account.role, account.username, account.email, passwordHash],
    );
    ids[key] = rows[0].id;
  }
  return ids;
}

export { TEST_PASSWORD, ACCOUNTS };
