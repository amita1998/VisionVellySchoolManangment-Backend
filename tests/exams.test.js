import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

let server;
let base;
let ids;
let examId;
let scheduleId;

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

describe('exam setup', () => {
  it('creates an exam and refuses a duplicate name', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const created = await call('POST', '/api/exams', {
      token: admin,
      body: { name: 'Term II', examType: 'final', startDate: '2027-02-10', endDate: '2027-02-20' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    examId = created.body.data.id;

    const duplicate = await call('POST', '/api/exams', {
      token: admin,
      body: { name: 'Term II', examType: 'final', startDate: '2027-02-10', endDate: '2027-02-20' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'EXAM_EXISTS');
  });

  it('schedules a paper only for a subject the class is taught', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const extra = await pool.query("INSERT INTO subjects (name, code) VALUES ('History', 'HIS') RETURNING id");

    const notTaught = await call('POST', `/api/exams/${examId}/schedules`, {
      token: admin,
      body: {
        classId: ids.classId,
        subjectId: extra.rows[0].id,
        examDate: '2027-02-11',
        startTime: '09:00',
        endTime: '10:30',
      },
    });
    assert.equal(notTaught.status, 409);
    assert.equal(notTaught.body.error.code, 'SUBJECT_NOT_IN_CLASS');

    const schedule = await call('POST', `/api/exams/${examId}/schedules`, {
      token: admin,
      body: {
        classId: ids.classId,
        subjectId: ids.subjectId,
        examDate: '2027-02-11',
        startTime: '09:00',
        endTime: '10:30',
        maxMarks: 100,
      },
    });
    assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
    scheduleId = schedule.body.data.id;

    const duplicate = await call('POST', `/api/exams/${examId}/schedules`, {
      token: admin,
      body: {
        classId: ids.classId,
        subjectId: ids.subjectId,
        examDate: '2027-02-12',
        startTime: '09:00',
        endTime: '10:30',
      },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'SCHEDULE_EXISTS');
  });

  it('shows the paper to the teacher who teaches it', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('GET', '/api/exams/mine', { token: teacher });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.papers.some((paper) => paper.schedule_id === scheduleId));
    assert.equal(res.body.data.papers.find((p) => p.schedule_id === scheduleId).students, 2);
  });
});

describe('marks entry', () => {
  it('gives the teacher the class roster and saves a draft', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const sheet = await call('GET', `/api/exams/marks/${scheduleId}`, { token: teacher });
    assert.equal(sheet.status, 200);
    assert.equal(sheet.body.data.students.length, 2, 'both sections of Class 5');
    assert.equal(sheet.body.data.editable, true);

    const saved = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: teacher,
      body: { entries: [{ studentId: ids.studentId, marksObtained: 74 }] },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.saved, 1);
    assert.equal(saved.body.data.submitted, false);

    const reloaded = await call('GET', `/api/exams/marks/${scheduleId}`, { token: teacher });
    const row = reloaded.body.data.students.find((student) => student.student_id === ids.studentId);
    assert.equal(Number(row.marks_obtained), 74);
    assert.equal(row.grade, 'B+', '70-79 maps to B+');
    assert.equal(row.status, 'draft');
  });

  it('refuses to submit until every student has marks', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: teacher,
      body: {
        submit: true,
        entries: [{ studentId: ids.studentId, marksObtained: 74 }],
      },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'MARKS_INCOMPLETE');
  });

  it('rejects marks outside the paper maximum', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: teacher,
      body: { entries: [{ studentId: ids.studentId, marksObtained: 120 }] },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'MARKS_OUT_OF_RANGE');
  });

  it('submits, then refuses further teacher edits', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const submitted = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: teacher,
      body: {
        submit: true,
        entries: [
          { studentId: ids.studentId, marksObtained: 74 },
          { studentId: ids.otherStudentId, marksObtained: 91 },
        ],
      },
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.data.submitted, true);

    const again = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: teacher,
      body: { entries: [{ studentId: ids.studentId, marksObtained: 80 }] },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'MARKS_SUBMITTED');
  });

  it('stops a teacher touching a paper they do not teach', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const extra = await pool.query("SELECT id FROM subjects WHERE code = 'HIS'");
    await call('PUT', `/api/academics/classes/${ids.classId}/subjects`, {
      token: admin,
      body: { subjectIds: [ids.subjectId, extra.rows[0].id] },
    });
    const history = await call('POST', `/api/exams/${examId}/schedules`, {
      token: admin,
      body: {
        classId: ids.classId,
        subjectId: extra.rows[0].id,
        examDate: '2027-02-13',
        startTime: '09:00',
        endTime: '10:30',
      },
    });
    assert.equal(history.status, 201);

    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('GET', `/api/exams/marks/${history.body.data.id}`, { token: teacher });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'NOT_YOUR_SUBJECT');
  });
});

describe('publishing and results', () => {
  it('will not publish while a paper has no marks', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('POST', `/api/exams/${examId}/publish`, { token: admin, body: { publish: true } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'MARKS_INCOMPLETE');
  });

  it('hides unpublished results from students and parents', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const res = await call('GET', `/api/exams/results/student/${ids.studentId}?examId=${examId}`, {
      token: student,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'RESULT_NOT_PUBLISHED');

    const list = await call('GET', `/api/exams/results/student/${ids.studentId}/exams`, { token: student });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.exams.some((exam) => exam.id === examId), false);
  });

  it('publishes once every paper is complete, then shows the report card', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const exam = await call('GET', `/api/exams/${examId}`, { token: admin });
    const historyPaper = exam.body.data.schedules.find((schedule) => schedule.id !== scheduleId);

    // fill the second paper so the publish gate passes
    await call('PUT', `/api/exams/marks/${historyPaper.id}`, {
      token: admin,
      body: {
        submit: true,
        entries: [
          { studentId: ids.studentId, marksObtained: 60 },
          { studentId: ids.otherStudentId, marksObtained: 85 },
        ],
      },
    });

    const published = await call('POST', `/api/exams/${examId}/publish`, { token: admin, body: { publish: true } });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.data.publish_status, 'published');

    const student = await login('student', ACCOUNTS.student.username);
    const card = await call('GET', `/api/exams/results/student/${ids.studentId}?examId=${examId}`, {
      token: student,
    });
    assert.equal(card.status, 200);
    assert.equal(card.body.data.papers.length, 2);
    assert.equal(card.body.data.totals.obtained, 134);
    assert.equal(card.body.data.totals.maximum, 200);
    assert.equal(card.body.data.totals.percentage, 67);
    assert.equal(card.body.data.totals.grade, 'B');
    assert.ok(card.body.data.rank.position >= 1);

    const list = await call('GET', `/api/exams/results/student/${ids.studentId}/exams`, { token: student });
    assert.ok(list.body.data.exams.some((examRow) => examRow.id === examId));
  });

  it('lets a parent read their own child and not another', async () => {
    const parent = await login('parent', ACCOUNTS.parent.username);
    const own = await call('GET', `/api/exams/results/student/${ids.studentId}?examId=${examId}`, {
      token: parent,
    });
    assert.equal(own.status, 200);

    const other = await call('GET', `/api/exams/results/student/${ids.otherStudentId}?examId=${examId}`, {
      token: parent,
    });
    assert.equal(other.status, 403);
  });

  it('ranks the class results', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('GET', `/api/exams/results/class/${ids.classId}/exam/${examId}`, { token: admin });
    assert.equal(res.status, 200);
    const rows = res.body.data.results;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].position, 1);
    assert.ok(rows[0].percentage >= rows[1].percentage);
  });
});

describe('admin override and unlock', () => {
  it('requires a reason and audits the change', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);

    const noReason = await call('POST', `/api/exams/marks/${scheduleId}/override`, {
      token: admin,
      body: { studentId: ids.studentId, marksObtained: 80, reason: 'x' },
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.code, 'VALIDATION_ERROR');

    const override = await call('POST', `/api/exams/marks/${scheduleId}/override`, {
      token: admin,
      body: { studentId: ids.studentId, marksObtained: 80, reason: 'Revaluation accepted' },
    });
    assert.equal(override.status, 200);

    const { rows } = await pool.query('SELECT marks_obtained FROM marks WHERE exam_schedule_id = $1 AND student_id = $2', [
      scheduleId,
      ids.studentId,
    ]);
    assert.equal(Number(rows[0].marks_obtained), 80);

    const auditRow = await pool.query(
      "SELECT old_values, new_values, reason FROM audit_logs WHERE action = 'marks.overridden' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(auditRow.rows[0]);
    assert.equal(Number(auditRow.rows[0].old_values.marks_obtained), 74);
    assert.equal(Number(auditRow.rows[0].new_values.marksObtained), 80);
    assert.match(auditRow.rows[0].reason, /Revaluation/);
  });

  it('blocks teacher marks on a published paper until an admin unlocks it', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const blocked = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: teacher,
      body: { entries: [{ studentId: ids.studentId, marksObtained: 70 }] },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'MARKS_LOCKED');

    const admin = await login('admin', ACCOUNTS.admin.username);
    const unlocked = await call('POST', `/api/exams/marks/${scheduleId}/unlock`, {
      token: admin,
      body: { reason: 'Correction window' },
    });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.body.data.unlocked, 2);
  });

  it('keeps students out of marks entry', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const res = await call('PUT', `/api/exams/marks/${scheduleId}`, {
      token: student,
      body: { entries: [{ studentId: ids.studentId, marksObtained: 100 }] },
    });
    assert.equal(res.status, 403);
  });
});
