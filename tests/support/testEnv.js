/**
 * Must be the FIRST import of every test file: sets NODE_ENV and the database URL
 * before src/config/env.js runs. node --test starts a fresh process per file, so
 * this cannot leak into the dev database.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://vvs@127.0.0.1:5434/vvs_test';

export const TEST_PASSWORD = 'Test@1234';

export const ACCOUNTS = {
  admin: { role: 'admin', username: 'admin@vvs.test', email: 'admin@vvs.test' },
  teacher: { role: 'teacher', username: 'teacher@vvs.test', email: 'teacher@vvs.test' },
  student: { role: 'student', username: 'VVS-900001', email: null },
  parent: { role: 'parent', username: 'parent@vvs.test', email: 'parent@vvs.test' },
  // dedicated accounts so destructive tests never disturb the shared ones
  lockable: { role: 'teacher', username: 'lockme@vvs.test', email: 'lockme@vvs.test' },
  changer: { role: 'teacher', username: 'changer@vvs.test', email: 'changer@vvs.test' },
  gate: { role: 'student', username: 'gate@vvs.test', email: null },
};
