import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { resetDatabase } from './support/db.js';
import { ACCOUNTS, TEST_PASSWORD } from './support/testEnv.js';

/**
 * Streams (Class 11/12 Science / Commerce / Arts) and the class-wise attendance filter.
 *
 * The rules under test:
 *   - only level >= 13 (Class 11, 12) uses streams; Class 1 must refuse a stream outright
 *   - a Class 11 subject list is per stream, so editing Science never touches Commerce
 *   - two sections named 'A' can coexist when their streams differ
 *   - GET /api/attendance?classId=… actually narrows to that class (it used to be ignored)
 */

let server;
let base;
let ids = {};

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login(identifier, password = TEST_PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const payload = await res.json();
  return payload?.data?.accessToken;
}

async function seed() {
  await resetDatabase();
  const hash = await bcrypt.hash(TEST_PASSWORD, 4);

  const admin = await pool.query(
    `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
     VALUES ((SELECT id FROM roles WHERE code = 'admin'), $1, $1, $2, FALSE) RETURNING id`,
    [ACCOUNTS.admin.username, hash],
  );
  ids.adminUserId = admin.rows[0].id;

  const year = await pool.query(
    `INSERT INTO academic_years (name, start_date, end_date, is_current)
     VALUES ('2026-2027', '2026-04-01', '2027-03-31', TRUE) RETURNING id`,
  );
  ids.yearId = year.rows[0].id;

  const streams = await pool.query('SELECT id, code FROM streams WHERE deleted_at IS NULL');
  ids.streams = Object.fromEntries(streams.rows.map((row) => [row.code, row.id]));

  // Class 1 (level 1) — must never take a stream.
  const class1 = await pool.query(`INSERT INTO classes (name, level_order) VALUES ('Class 1', 1) RETURNING id`);
  ids.class1Id = class1.rows[0].id;
  const sec1 = await pool.query(`INSERT INTO sections (class_id, name) VALUES ($1, 'A') RETURNING id`, [
    ids.class1Id,
  ]);
  ids.class1SectionId = sec1.rows[0].id;

  // Class 11 (level 13) — needs a stream.
  const class11 = await pool.query(`INSERT INTO classes (name, level_order) VALUES ('Class 11', 13) RETURNING id`);
  ids.class11Id = class11.rows[0].id;
  const sec11Science = await pool.query(
    `INSERT INTO sections (class_id, name, stream_id) VALUES ($1, 'A', $2) RETURNING id`,
    [ids.class11Id, ids.streams.science],
  );
  ids.scienceSectionId = sec11Science.rows[0].id;

  const subjectNames = [
    ['Mathematics', 'MAT'],
    ['Physics', 'PHY'],
    ['Chemistry', 'CHE'],
    ['Accountancy', 'ACC'],
    ['Business Studies', 'BUS'],
  ];
  ids.subjectIds = {};
  for (const [name, code] of subjectNames) {
    const row = await pool.query(`INSERT INTO subjects (name, code) VALUES ($1, $2) RETURNING id`, [name, code]);
    ids.subjectIds[code] = row.rows[0].id;
  }

  // Two students, one per class, with one attendance row each (today, school timezone).
  const today = (
    await pool.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day`)
  ).rows[0].day;

  const s1 = await pool.query(
    `INSERT INTO students (admission_id, first_name, last_name, gender, date_of_birth, admission_date, status)
     VALUES ('VVS-910001', 'Primary', 'Child', 'female', '2019-04-04', '2026-04-06', 'active') RETURNING id`,
  );
  const s2 = await pool.query(
    `INSERT INTO students (admission_id, first_name, last_name, gender, date_of_birth, admission_date, status)
     VALUES ('VVS-910002', 'Senior', 'Child', 'male', '2009-04-04', '2026-04-06', 'active') RETURNING id`,
  );
  ids.student1 = s1.rows[0].id;
  ids.student2 = s2.rows[0].id;

  await pool.query(
    `INSERT INTO enrollments (student_id, academic_year_id, class_id, section_id, status)
     VALUES ($1, $3, $4, $5, 'active'), ($2, $3, $6, $7, 'active')`,
    [ids.student1, ids.student2, ids.yearId, ids.class1Id, ids.class1SectionId, ids.class11Id, ids.scienceSectionId],
  );

  await pool.query(
    `INSERT INTO attendance (student_id, academic_year_id, section_id, attendance_date, status, marked_by)
     VALUES ($1, $3, $4, $5, 'present', $6), ($2, $3, $7, $5, 'absent', $6)`,
    [
      ids.student1,
      ids.student2,
      ids.yearId,
      ids.class1SectionId,
      today,
      ids.adminUserId,
      ids.scienceSectionId,
    ],
  );
}

before(async () => {
  await seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  ids.token = await login(ACCOUNTS.admin.username);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('streams', () => {
  it('flags Class 11 as needing a stream and leaves Class 1 alone', async () => {
    const { status, body } = await call('GET', '/api/academics/classes', { token: ids.token });
    assert.equal(status, 200);
    const byName = Object.fromEntries(body.data.classes.map((row) => [row.name, row]));
    assert.equal(byName['Class 11'].needs_stream, true);
    assert.equal(byName['Class 1'].needs_stream, false);
  });

  it('refuses a stream on Class 1', async () => {
    const { status, body } = await call('PUT', `/api/academics/classes/${ids.class1Id}/subjects`, {
      token: ids.token,
      body: { subjectIds: [ids.subjectIds.MAT], streamId: ids.streams.science },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'STREAM_NOT_APPLICABLE');
  });

  it('demands a stream on Class 11', async () => {
    const { status, body } = await call('PUT', `/api/academics/classes/${ids.class11Id}/subjects`, {
      token: ids.token,
      body: { subjectIds: [ids.subjectIds.PHY] },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'STREAM_REQUIRED');
  });

  it('keeps each stream on its own subject list', async () => {
    const science = await call('PUT', `/api/academics/classes/${ids.class11Id}/subjects`, {
      token: ids.token,
      body: {
        subjectIds: [ids.subjectIds.PHY, ids.subjectIds.CHE, ids.subjectIds.MAT],
        streamId: ids.streams.science,
      },
    });
    assert.equal(science.status, 200);
    assert.equal(science.body.data.subjects.length, 3);

    const commerce = await call('PUT', `/api/academics/classes/${ids.class11Id}/subjects`, {
      token: ids.token,
      body: {
        subjectIds: [ids.subjectIds.ACC, ids.subjectIds.BUS],
        streamId: ids.streams.commerce,
      },
    });
    assert.equal(commerce.status, 200);
    assert.equal(commerce.body.data.subjects.length, 2);

    // Science must still hold its three subjects: the delete is scoped per stream.
    const scienceAgain = await call(
      'GET',
      `/api/academics/classes/${ids.class11Id}/subjects?streamId=${ids.streams.science}`,
      { token: ids.token },
    );
    const names = scienceAgain.body.data.subjects.map((row) => row.code).sort();
    assert.deepEqual(names, ['CHE', 'MAT', 'PHY']);

    const commerceAgain = await call(
      'GET',
      `/api/academics/classes/${ids.class11Id}/subjects?streamId=${ids.streams.commerce}`,
      { token: ids.token },
    );
    assert.deepEqual(commerceAgain.body.data.subjects.map((row) => row.code).sort(), ['ACC', 'BUS']);

    // Class 1 untouched by any of it
    const class1 = await call('GET', `/api/academics/classes/${ids.class1Id}/subjects`, { token: ids.token });
    assert.deepEqual(class1.body.data.subjects, []);
  });

  it('allows the same section name in two different streams', async () => {
    const science = await call('POST', `/api/academics/classes/${ids.class11Id}/sections`, {
      token: ids.token,
      body: { name: 'B', streamId: ids.streams.science },
    });
    assert.equal(science.status, 201);

    const commerce = await call('POST', `/api/academics/classes/${ids.class11Id}/sections`, {
      token: ids.token,
      body: { name: 'B', streamId: ids.streams.commerce },
    });
    assert.equal(commerce.status, 201, 'same name under a different stream must not collide');

    const missing = await call('POST', `/api/academics/classes/${ids.class11Id}/sections`, {
      token: ids.token,
      body: { name: 'C' },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'STREAM_REQUIRED');
  });
});

describe('attendance class filter', () => {
  it('narrows the register to the selected class', async () => {
    const all = await call('GET', '/api/attendance?limit=50', { token: ids.token });
    assert.equal(all.status, 200);
    assert.equal(all.body.data.rows.length, 2);

    const class1 = await call('GET', `/api/attendance?classId=${ids.class1Id}`, { token: ids.token });
    assert.equal(class1.status, 200);
    assert.equal(class1.body.data.rows.length, 1);
    assert.equal(class1.body.data.rows[0].student_id, ids.student1);
    assert.equal(class1.body.data.meta.total, 1);

    const class11 = await call('GET', `/api/attendance?classId=${ids.class11Id}`, { token: ids.token });
    assert.equal(class11.body.data.rows.length, 1);
    assert.equal(class11.body.data.rows[0].student_id, ids.student2);

    // the summary follows the same filter, not the whole school
    assert.equal(class11.body.data.summary.counts.absent, 1);
    assert.equal(class11.body.data.summary.counts.present, 0);
  });

  it('still honours the section filter', async () => {
    const section = await call('GET', `/api/attendance?sectionId=${ids.scienceSectionId}`, { token: ids.token });
    assert.equal(section.status, 200);
    assert.equal(section.body.data.rows.length, 1);
    assert.equal(section.body.data.rows[0].student_id, ids.student2);
  });
});
