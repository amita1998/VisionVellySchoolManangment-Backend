import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

let server;
let base;
let ids;

// The server decides "today" in the school timezone (Asia/Kolkata). A UTC date is the
// previous day between 00:00 and 05:30 IST, which would make today's sheet look like a past
// day (409 ATTENDANCE_LOCKED instead of the expected outcome).
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

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

async function login(role, identifier, password = TEST_PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, identifier, password }),
  });
  const payload = await res.json();
  return payload?.data?.accessToken;
}

before(async () => {
  ids = await seedAcademicFixtures();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('attendance marking', () => {
  it('gives a class teacher only their own section', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('GET', '/api/attendance/sections', { token: teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.sections.length, 1);
    assert.equal(res.body.data.sections[0].section_id, ids.sectionA);
  });

  it('marks the whole section for today and reads it back', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const sheet = await call('GET', `/api/attendance/sheet?sectionId=${ids.sectionA}`, { token: teacher });
    assert.equal(sheet.status, 200);
    assert.equal(sheet.body.data.canMark, true);
    assert.equal(sheet.body.data.locked, false);
    assert.equal(sheet.body.data.students.length, 1, 'only the pupil in section A');

    const today = sheet.body.data.date;
    const marked = await call('POST', '/api/attendance/mark', {
      token: teacher,
      body: {
        sectionId: ids.sectionA,
        date: today,
        entries: [{ studentId: ids.studentId, status: 'present' }],
      },
    });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    assert.equal(marked.body.data.saved, 1);

    const after = await call('GET', `/api/attendance/sheet?sectionId=${ids.sectionA}`, { token: teacher });
    assert.equal(after.body.data.students[0].status, 'present');

    const { rows } = await pool.query(
      'SELECT count(*)::int AS total FROM attendance WHERE student_id = $1 AND attendance_date = $2',
      [ids.studentId, today],
    );
    assert.equal(rows[0].total, 1, 'one row per student per day');
  });

  it('refuses a teacher who is not the class teacher', async () => {
    const outsider = await pool.query(
      `INSERT INTO teachers (first_name, last_name, gender, mobile, email, joining_date)
       VALUES ('Out', 'Sider', 'male', '9800000077', 'outsider@vvs.test', '2021-01-01')
       RETURNING id`,
    );
    const user = await pool.query(
      `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
       VALUES ((SELECT id FROM roles WHERE code = 'teacher'), 'outsider@vvs.test', 'outsider@vvs.test',
               (SELECT password_hash FROM users WHERE username = $1), FALSE)
       RETURNING id`,
      [ACCOUNTS.teacher.username],
    );
    await pool.query('UPDATE teachers SET user_id = $2 WHERE id = $1', [outsider.rows[0].id, user.rows[0].id]);

    const token = await login('teacher', 'outsider@vvs.test');
    const res = await call('POST', '/api/attendance/mark', {
      token,
      body: {
        sectionId: ids.sectionA,
        date: todayIso(),
        entries: [{ studentId: ids.studentId, status: 'absent' }],
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'NOT_CLASS_TEACHER');
  });

  it('locks a past day and refuses to mark it', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('POST', '/api/attendance/mark', {
      token: teacher,
      body: {
        sectionId: ids.sectionA,
        date: '2026-01-05',
        entries: [{ studentId: ids.studentId, status: 'present' }],
      },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ATTENDANCE_LOCKED');
  });

  it('does not let an admin mark attendance', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('POST', '/api/attendance/mark', {
      token: admin,
      body: {
        sectionId: ids.sectionA,
        date: todayIso(),
        entries: [{ studentId: ids.studentId, status: 'present' }],
      },
    });
    assert.equal(res.status, 403);
  });

  it('rejects an entry for a student outside the section', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('POST', '/api/attendance/mark', {
      token: teacher,
      body: {
        sectionId: ids.sectionA,
        date: todayIso(),
        entries: [{ studentId: ids.otherStudentId, status: 'present' }],
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'STUDENT_NOT_IN_SECTION');
  });
});

describe('corrections', () => {
  let attendanceId;
  let pendingId;

  it('lets the class teacher request a correction', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const today = todayIso();
    const { rows } = await pool.query(
      'SELECT id FROM attendance WHERE student_id = $1 AND attendance_date = $2',
      [ids.studentId, today],
    );
    attendanceId = rows[0].id;

    const res = await call('POST', '/api/attendance/corrections', {
      token: teacher,
      body: { attendanceId, requestedStatus: 'absent', reason: 'Student was on a school trip' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    pendingId = res.body.data.id;

    const duplicate = await call('POST', '/api/attendance/corrections', {
      token: teacher,
      body: { attendanceId, requestedStatus: 'late', reason: 'Second attempt while pending' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'CORRECTION_PENDING');
  });

  it('shows the request to the admin and to the requesting teacher', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const list = await call('GET', '/api/attendance/corrections?status=pending', { token: admin });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.corrections.some((item) => item.id === pendingId));

    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const own = await call('GET', '/api/attendance/corrections', { token: teacher });
    assert.ok(own.body.data.corrections.some((item) => item.id === pendingId));
  });

  it('applies the change only when the admin approves', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);

    const before = await call('GET', `/api/attendance/summary/${ids.studentId}`, { token: admin });
    const beforePercent = before.body.data.summary.percentage;

    const approved = await call('POST', `/api/attendance/corrections/${pendingId}/review`, {
      token: admin,
      body: { decision: 'approved', comment: 'Verified with the class teacher' },
    });
    assert.equal(approved.status, 200);

    const { rows } = await pool.query('SELECT status FROM attendance WHERE id = $1', [attendanceId]);
    assert.equal(rows[0].status, 'absent');

    const after = await call('GET', `/api/attendance/summary/${ids.studentId}`, { token: admin });
    assert.ok(after.body.data.summary.percentage < beforePercent, 'percentage dropped');

    const again = await call('POST', `/api/attendance/corrections/${pendingId}/review`, {
      token: admin,
      body: { decision: 'rejected' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_REVIEWED');
  });

  it('leaves the record untouched when the admin rejects', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const admin = await login('admin', ACCOUNTS.admin.username);

    const request = await call('POST', '/api/attendance/corrections', {
      token: teacher,
      body: { attendanceId, requestedStatus: 'late', reason: 'Requesting late instead' },
    });
    assert.equal(request.status, 201);

    const rejected = await call('POST', `/api/attendance/corrections/${request.body.data.id}/review`, {
      token: admin,
      body: { decision: 'rejected', comment: 'No supporting evidence' },
    });
    assert.equal(rejected.status, 200);

    const { rows } = await pool.query('SELECT status FROM attendance WHERE id = $1', [attendanceId]);
    assert.equal(rows[0].status, 'absent', 'rejection changes nothing');
  });

  it('keeps students out of the correction queue', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const res = await call('GET', '/api/attendance/corrections', { token: student });
    assert.equal(res.status, 403);
  });
});

describe('attendance visibility', () => {
  it('gives a student their own records and percentage only', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const own = await call('GET', `/api/attendance/summary/${ids.studentId}`, { token: student });
    assert.equal(own.status, 200);
    assert.ok(own.body.data.summary.marked >= 2);
    assert.ok(Array.isArray(own.body.data.months));

    const other = await call('GET', `/api/attendance/summary/${ids.otherStudentId}`, { token: student });
    assert.equal(other.status, 403);

    const list = await call('GET', '/api/attendance', { token: student });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.rows.every((row) => row.student_id === ids.studentId));
  });

  it('gives a parent only their own children', async () => {
    const parent = await login('parent', ACCOUNTS.parent.username);
    const list = await call('GET', '/api/attendance', { token: parent });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.rows.every((row) => row.student_id === ids.studentId));

    const forbidden = await call('GET', `/api/attendance/summary/${ids.otherStudentId}`, { token: parent });
    assert.equal(forbidden.status, 403);
  });

  it('gives an admin the school-wide list with a summary', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('GET', '/api/attendance?page=1&limit=50', { token: admin });
    assert.equal(res.status, 200);
    const ids1 = new Set(res.body.data.rows.map((row) => row.student_id));
    assert.ok(ids1.has(ids.studentId) && ids1.has(ids.otherStudentId), 'both students visible');
    assert.ok(res.body.data.summary.marked > 0);
    assert.equal(typeof res.body.data.summary.percentage, 'number');
  });

  it('limits a teacher to their own classes', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('GET', '/api/attendance?limit=50', { token: teacher });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.rows.length > 0);
    assert.ok(
      res.body.data.rows.every((row) => row.class_name === 'Class 5'),
      'only classes this teacher is assigned to',
    );
  });
});
