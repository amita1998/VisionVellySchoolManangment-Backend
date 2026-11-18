#!/usr/bin/env node
/**
 * Development/demo handover helper — NOT for production.
 *
 * Sets one password on the demo accounts of a freshly seeded database and prints the
 * sign-in table. The password arrives through `HANDOVER_PASSWORD`; nothing is hard-coded
 * here, and the script refuses to run with NODE_ENV=production.
 *
 *   HANDOVER_PASSWORD='…' npm run handover
 */
import bcrypt from 'bcryptjs';
import { pool } from '../src/config/db.js';
import { config } from '../src/config/env.js';

if (config.isProduction) {
  console.error('Refusing to run: this script is for development and demo databases only.');
  process.exit(1);
}

const password = process.env.HANDOVER_PASSWORD;
if (!password || password.length < 10) {
  console.error('Set HANDOVER_PASSWORD to a password of at least 10 characters.');
  process.exit(1);
}

const hash = await bcrypt.hash(password, config.auth.bcryptRounds);

// Every account the demo seed creates, plus the first admin.
const { rowCount: adminTouched } = await pool.query(
  `UPDATE users SET password_hash = $1, must_change_password = FALSE,
          failed_login_attempts = 0, locked_until = NULL
    WHERE deleted_at IS NULL
      AND role_id = (SELECT id FROM roles WHERE code = 'admin')`,
  [hash],
);

const { rowCount: others } = await pool.query(
  `UPDATE users SET password_hash = $1, must_change_password = FALSE,
          failed_login_attempts = 0, locked_until = NULL
    WHERE deleted_at IS NULL AND is_active
      AND role_id <> (SELECT id FROM roles WHERE code = 'admin')`,
  [hash],
);

const { rows } = await pool.query(
  `SELECT r.code AS role,
          u.username AS identifier,
          coalesce(t.first_name || ' ' || t.last_name,
                   s.first_name || ' ' || s.last_name,
                   p.full_name,
                   u.username) AS name,
          coalesce(c.name || ' ' || sec.name, '') AS placement
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN teachers t ON t.user_id = u.id
     LEFT JOIN students s ON s.user_id = u.id
     LEFT JOIN parents p ON p.user_id = u.id
     LEFT JOIN enrollments e ON e.student_id = s.id
     LEFT JOIN sections sec ON sec.id = e.section_id
     LEFT JOIN classes c ON c.id = e.class_id
    WHERE u.deleted_at IS NULL AND u.is_active
    ORDER BY r.code, u.username`,
);

console.log(`\nUpdated ${adminTouched} admin + ${others} other account(s).`);
console.log('Password for every account below:', password, '\n');
console.log('role'.padEnd(9), 'identifier'.padEnd(42), 'name'.padEnd(22), 'class');
console.log('-'.repeat(96));
for (const row of rows) {
  console.log(row.role.padEnd(9), String(row.identifier).padEnd(42), String(row.name).padEnd(22), row.placement);
}
console.log(`\n${rows.length} account(s) total.`);

await pool.end();
