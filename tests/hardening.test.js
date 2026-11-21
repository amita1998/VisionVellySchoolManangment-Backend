import './support/testEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { pool, withTransaction } from '../src/config/db.js';
import { audit } from '../src/services/auditService.js';
import { ACCOUNTS, seedAcademicFixtures, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Hardening tests for the code audit.
 *
 *   BE-01 CORS allow-list · BE-02 audit savepoint · BE-06 non-numeric marks · BE-07 publish gate
 *   BE-08 class-results scope · BE-11 per-account passwords · BE-12 reactivating the login
 *   BE-30 calendar audiences · BE-41 teacher opening an assigned student · BE-42 review race
 */

let server;
let base;
let ids;
const tokens = {};

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, headers: res.headers };
}

async function login(identifier, password = TEST_PASSWORD) {
  const res = await call('POST', '/api/auth/login', { body: { identifier, password } });
  return res.body.data?.accessToken;
}

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

before(async () => {
  ids = await seedAcademicFixtures();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login(ACCOUNTS.admin.username);
  tokens.teacher = await login(ACCOUNTS.teacher.username);
  tokens.student = await login(ACCOUNTS.student.username);
  tokens.parent = await login(ACCOUNTS.parent.username);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('BE-01 CORS is an allow-list', () => {
  it('refuses a look-alike vercel host', async () => {
    const res = await call('GET', '/api/health', { headers: { origin: 'https://vvs-evil.vercel.app' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('allows an origin listed in CLIENT_ORIGIN', async () => {
    const res = await call('GET', '/api/health', { headers: { origin: 'http://localhost:5174' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5174');
  });
});

describe('BE-02 a failed audit insert must not undo the business write', () => {
  it('keeps the row when the audit insert fails inside the transaction', async () => {
    const marker = `audit-savepoint-${Date.now()}`;
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO school_settings (id, school_name, tagline, timezone, currency)
         VALUES (1, 'Vision Valley School', 'Nursery to Class 12', 'Asia/Kolkata', 'INR')
         ON CONFLICT (id) DO UPDATE SET tagline = $1`,
        [marker],
      );
      // entity_type is NOT NULL, so this insert fails — the savepoint must absorb it.
      await audit({ client, action: 'test.audit.failure', entityType: null });
    });

    const { rows } = await pool.query('SELECT tagline FROM school_settings WHERE id = 1');
    assert.equal(rows[0].tagline, marker, 'the business write survived the failed audit insert');
  });
});

describe('BE-06 marks must be numbers', () => {
  let examId;
  let scheduleId;

  before(async () => {
    const exam = await pool.query(
      `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date, created_by)
       VALUES ('Hardening Exam', 'unit_test', $1, '2026-12-01', '2026-12-02', $2) RETURNING id`,
      [ids.yearId, ids.admin],
    );
    examId = exam.rows[0].id;
    const schedule = await pool.query(
      `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time, max_marks)
       VALUES ($1, $2, $3, '2026-12-01', '09:00', '10:00', 100) RETURNING id`,
      [examId, ids.classId, ids.subjectId],
    );
    scheduleId = schedule.rows[0].id;
  });

  it('rejects text as a mark instead of storing NaN', async () => {
    const res = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: tokens.teacher,
      body: { entries: [{ studentId: ids.studentId, marksObtained: 'abc' }] },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.fields.entries || res.body.error.fields['entries.0.marksObtained']);
  });

  it('accepts a numeric string', async () => {
    const res = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: tokens.teacher,
      body: { entries: [{ studentId: ids.studentId, marksObtained: '74' }] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

describe('BE-07 an exam cannot be published on draft marks', () => {
  it('refuses while a paper has only drafts, then publishes once every student is submitted', async () => {
    const exam = await pool.query(
      `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date, created_by)
       VALUES ('Publish Gate', 'unit_test', $1, '2026-12-10', '2026-12-11', $2) RETURNING id`,
      [ids.yearId, ids.admin],
    );
    const schedule = await pool.query(
      `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time, max_marks)
       VALUES ($1, $2, $3, '2026-12-10', '09:00', '10:00', 100) RETURNING id`,
      [exam.rows[0].id, ids.classId, ids.subjectId],
    );
    const scheduleId = schedule.rows[0].id;

    await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: tokens.admin,
      body: { entries: [
        { studentId: ids.studentId, marksObtained: 70 },
        { studentId: ids.otherStudentId, marksObtained: 80 },
      ] },
    });

    const draftPublish = await call('POST', `/api/exams/${exam.rows[0].id}/publish`, {
      token: tokens.admin,
      body: { publish: true },
    });
    assert.equal(draftPublish.status, 409, JSON.stringify(draftPublish.body));
    assert.equal(draftPublish.body.error.code, 'MARKS_INCOMPLETE');

    const submitted = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: tokens.admin,
      body: {
        submit: true,
        entries: [
          { studentId: ids.studentId, marksObtained: 70 },
          { studentId: ids.otherStudentId, marksObtained: 80 },
        ],
      },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

    const published = await call('POST', `/api/exams/${exam.rows[0].id}/publish`, {
      token: tokens.admin,
      body: { publish: true },
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.data.publish_status, 'published');
  });
});

describe('BE-08 class results are scoped to the classes a teacher teaches', () => {
  it('lets the teacher read their own class and refuses another one', async () => {
    const own = await call('GET', `/api/exams/results/class/${ids.classId}/exam/${ids.examId}`, {
      token: tokens.teacher,
    });
    assert.equal(own.status, 200, JSON.stringify(own.body));

    const otherClass = await pool.query(
      "INSERT INTO classes (name, level_order) VALUES ('Class 9', 7) RETURNING id",
    );
    const refused = await call('GET', `/api/exams/results/class/${otherClass.rows[0].id}/exam/${ids.examId}`, {
      token: tokens.teacher,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'RESULT_FORBIDDEN');
  });

  it('counts only submitted marks', async () => {
    const res = await call('GET', `/api/exams/results/class/${ids.classId}/exam/${ids.examId}`, {
      token: tokens.admin,
    });
    assert.equal(res.status, 200);
    for (const row of res.body.data.results) {
      assert.equal(Number.isFinite(row.obtained), true);
    }
  });
});

describe('BE-36 a plain teacher edit cannot change status', () => {
  it('ignores a status in PUT /api/teachers/:id', async () => {
    const res = await call('PUT', `/api/teachers/${ids.teacherId}`, {
      token: tokens.admin,
      body: { status: 'resigned' },
    });
    // either a 400 (nothing to update) or a 200 that left the status alone — never a resignation
    const { rows } = await pool.query('SELECT status FROM teachers WHERE id = $1', [ids.teacherId]);
    assert.equal(rows[0].status, 'active');
    assert.ok([200, 400].includes(res.status), `unexpected ${res.status}`);
  });
});

describe('BE-12 reactivating a student re-enables the login', () => {
  it('disables the login on withdrawal and enables it again on active', async () => {
    const withdrawn = await call('POST', `/api/students/${ids.studentId}/status`, {
      token: tokens.admin,
      body: { status: 'withdrawn', effectiveDate: todayIso(), remarks: 'test' },
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    const blocked = await login(ACCOUNTS.student.username);
    assert.equal(blocked, undefined, 'a withdrawn student cannot sign in');

    const active = await call('POST', `/api/students/${ids.studentId}/status`, {
      token: tokens.admin,
      body: { status: 'active', effectiveDate: todayIso(), remarks: 'back' },
    });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    const allowed = await login(ACCOUNTS.student.username);
    assert.ok(allowed, 'the login works again after returning to active');
  });
});

describe('BE-41 a teacher can open a student they teach', () => {
  it('answers 200 for an assigned student and 403 for another class', async () => {
    const own = await call('GET', `/api/students/${ids.studentId}`, { token: tokens.teacher });
    assert.equal(own.status, 200, JSON.stringify(own.body));

    const otherClass = await pool.query(
      "INSERT INTO classes (name, level_order) VALUES ('Class 10', 8) RETURNING id",
    );
    const section = await pool.query(
      'INSERT INTO sections (class_id, name) VALUES ($1, $2) RETURNING id',
      [otherClass.rows[0].id, 'A'],
    );
    const stranger = await pool.query(
      `INSERT INTO students (admission_id, first_name, last_name, gender, date_of_birth, admission_date)
       VALUES ('VVS-990001', 'Outside', 'Student', 'male', '2015-01-01', '2026-04-06') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO enrollments (student_id, academic_year_id, class_id, section_id, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [stranger.rows[0].id, ids.yearId, otherClass.rows[0].id, section.rows[0].id],
    );

    const refused = await call('GET', `/api/students/${stranger.rows[0].id}`, { token: tokens.teacher });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  });
});

describe('BE-30 the dashboard calendar follows the role', () => {
  it('hides a teachers-only event from a parent and shows a parents event', async () => {
    const admin = await pool.query('SELECT id FROM users WHERE username = $1', [ACCOUNTS.admin.username]);
    const day = todayIso();
    await pool.query(
      `INSERT INTO events (title, event_date, audience, is_published, created_by)
       VALUES ('Staff only briefing', $1, 'teachers', TRUE, $2),
              ('Parents evening', $1, 'parents', TRUE, $2)`,
      [day, admin.rows[0].id],
    );

    const res = await call('GET', '/api/dashboard/parent', { token: tokens.parent });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const titles = (res.body.data.shell.calendar?.events || []).map((entry) => entry.title);
    assert.ok(!titles.includes('Staff only briefing'), 'a parent must not see a staff event');
    assert.ok(titles.includes('Parents evening'), 'a parent sees their own audience');
  });
});

describe('BE-42 a correction is reviewed exactly once', () => {
  it('refuses a second decision and a stale approval', async () => {
    const day = todayIso();
    const attendance = await pool.query(
      'SELECT id FROM attendance WHERE student_id = $1 AND attendance_date = $2',
      [ids.studentId, day],
    );
    const attendanceId = attendance.rows[0].id;

    const created = await call('POST', '/api/attendance/corrections', {
      token: tokens.teacher,
      body: { attendanceId, requestedStatus: 'late', reason: 'Hardening test' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const correctionId = created.body.data.id;

    const approved = await call('POST', `/api/attendance/corrections/${correctionId}/review`, {
      token: tokens.admin,
      body: { decision: 'approved' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const rejected = await call('POST', `/api/attendance/corrections/${correctionId}/review`, {
      token: tokens.admin,
      body: { decision: 'rejected' },
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'ALREADY_REVIEWED');
  });

  it('refuses an approval when the attendance moved underneath the request', async () => {
    const day = todayIso();
    await pool.query(
      "UPDATE attendance SET status = 'present' WHERE student_id = $1 AND attendance_date = $2",
      [ids.studentId, day],
    );
    const attendance = await pool.query(
      'SELECT id FROM attendance WHERE student_id = $1 AND attendance_date = $2',
      [ids.studentId, day],
    );
    const attendanceId = attendance.rows[0].id;

    const created = await call('POST', '/api/attendance/corrections', {
      token: tokens.teacher,
      body: { attendanceId, requestedStatus: 'late', reason: 'Stale request' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // somebody marks it again before the admin reviews
    await pool.query("UPDATE attendance SET status = 'half_day' WHERE id = $1", [attendanceId]);

    const approved = await call('POST', `/api/attendance/corrections/${created.body.data.id}/review`, {
      token: tokens.admin,
      body: { decision: 'approved' },
    });
    assert.equal(approved.status, 409, JSON.stringify(approved.body));
    assert.equal(approved.body.error.code, 'ATTENDANCE_CHANGED');
  });
});
