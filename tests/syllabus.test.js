import './support/testEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { ACCOUNTS, seedAcademicFixtures, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Chapter-wise syllabus + exam portion.
 *
 *   the admin (or the teacher of that class+subject) writes chapters, the teacher ticks them as
 *   covered, and the chapters that belong to an exam paper are attached to its schedule. Students and
 *   parents read their own class only.
 */

let server;
let base;
let ids;
const tokens = {};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function login(identifier) {
  const res = await call('POST', '/api/auth/login', { body: { identifier, password: TEST_PASSWORD } });
  return res.body.data.accessToken;
}

before(async () => {
  ids = await seedAcademicFixtures();

  // A second subject that is NOT assigned to Class 5, and a second subject that is assigned but not
  // taught by the fixture teacher — both used to prove the two guards are different 400s/403s.
  const unassigned = await pool.query(
    "INSERT INTO subjects (name, code) VALUES ('Physics', 'PHY') RETURNING id",
  );
  ids.unassignedSubjectId = unassigned.rows[0].id;

  const notMine = await pool.query(
    "INSERT INTO subjects (name, code) VALUES ('Hindi', 'HIN') RETURNING id",
  );
  ids.notMineSubjectId = notMine.rows[0].id;
  await pool.query('INSERT INTO class_subjects (class_id, subject_id) VALUES ($1, $2)', [
    ids.classId,
    ids.notMineSubjectId,
  ]);

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

describe('chapters', () => {
  it('lets the admin write three chapters', async () => {
    const titles = ['Numbers and place value', 'Fractions', 'Decimals'];
    ids.chapterIds = [];
    for (let index = 0; index < titles.length; index += 1) {
      const res = await call('POST', '/api/syllabus/chapters', {
        token: tokens.admin,
        body: {
          classId: ids.classId,
          subjectId: ids.subjectId,
          chapterNo: index + 1,
          title: titles[index],
        },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      ids.chapterIds.push(res.body.data.chapter.id);
    }
  });

  it('refuses a duplicate chapter number', async () => {
    const res = await call('POST', '/api/syllabus/chapters', {
      token: tokens.admin,
      body: { classId: ids.classId, subjectId: ids.subjectId, chapterNo: 1, title: 'Again' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CHAPTER_EXISTS');
  });

  it('refuses a subject that is not assigned to the class', async () => {
    const res = await call('POST', '/api/syllabus/chapters', {
      token: tokens.admin,
      body: { classId: ids.classId, subjectId: ids.unassignedSubjectId, chapterNo: 1, title: 'Motion' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.fields.subjectId);
  });

  it('lets the teacher write a chapter of a class+subject they teach', async () => {
    const res = await call('POST', '/api/syllabus/chapters', {
      token: tokens.teacher,
      body: { classId: ids.classId, subjectId: ids.subjectId, chapterNo: 4, title: 'Geometry' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.teacherChapterId = res.body.data.chapter.id;
  });

  it('refuses the teacher a class+subject they do not teach', async () => {
    const res = await call('POST', '/api/syllabus/chapters', {
      token: tokens.teacher,
      body: { classId: ids.classId, subjectId: ids.notMineSubjectId, chapterNo: 1, title: 'Kavita' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'SYLLABUS_NOT_YOUR_SUBJECT');
  });

  it('refuses a student writing a chapter', async () => {
    const res = await call('POST', '/api/syllabus/chapters', {
      token: tokens.student,
      body: { classId: ids.classId, subjectId: ids.subjectId, chapterNo: 9, title: 'No' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('shows the student their own class and a progress block', async () => {
    const res = await call('GET', '/api/syllabus/chapters', { token: tokens.student });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const chapters = res.body.data.rows;
    assert.equal(chapters.length, 4);
    assert.deepEqual(
      chapters.map((row) => row.chapter_no),
      [1, 2, 3, 4],
    );
    assert.equal(res.body.data.progress.total, 4);
    assert.equal(res.body.data.progress.covered, 0);
    assert.equal(res.body.data.scope.classes[0].id, ids.classId);
  });

  it('ticks a chapter as covered and moves the percentage', async () => {
    const res = await call('PUT', `/api/syllabus/chapters/${ids.chapterIds[0]}`, {
      token: tokens.teacher,
      body: { coveredOn: '2026-07-15' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.chapter.covered_on, '2026-07-15');

    const list = await call('GET', '/api/syllabus/chapters', { token: tokens.student });
    assert.equal(list.body.data.progress.covered, 1);
    assert.equal(list.body.data.progress.percent, 25);
  });

  it('shows a parent only their own child\u2019s class', async () => {
    const ok = await call('GET', `/api/syllabus/chapters?childId=${ids.studentId}`, { token: tokens.parent });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.rows.length, 4);

    const denied = await call('GET', `/api/syllabus/chapters?childId=${ids.otherStudentId}`, { token: tokens.parent });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'SYLLABUS_NOT_YOUR_CHILD');
  });

  it('deletes a chapter without touching the others', async () => {
    const res = await call('DELETE', `/api/syllabus/chapters/${ids.teacherChapterId}`, { token: tokens.admin });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const list = await call('GET', '/api/syllabus/chapters', { token: tokens.student });
    assert.equal(list.body.data.rows.length, 3);
  });
});

describe('exam portion', () => {
  it('attaches two chapters to the exam paper', async () => {
    const res = await call('PUT', `/api/syllabus/schedules/${ids.scheduleId}/portion`, {
      token: tokens.admin,
      body: { chapterIds: [ids.chapterIds[0], ids.chapterIds[1]] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.chapterIds.length, 2);
  });

  it('shows the portion to the student for a published exam', async () => {
    const res = await call('GET', '/api/syllabus/portions', { token: tokens.student });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const paper = res.body.data.rows.find((row) => row.schedule_id === ids.scheduleId);
    assert.ok(paper, 'the published paper should be listed');
    assert.deepEqual(
      paper.chapters.map((row) => row.chapter_no),
      [1, 2],
    );
  });

  it('refuses a chapter from another subject in the portion', async () => {
    const other = await call('POST', '/api/syllabus/chapters', {
      token: tokens.admin,
      body: { classId: ids.classId, subjectId: ids.notMineSubjectId, chapterNo: 1, title: 'Kavita 1' },
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));

    const res = await call('PUT', `/api/syllabus/schedules/${ids.scheduleId}/portion`, {
      token: tokens.admin,
      body: { chapterIds: [ids.chapterIds[0], other.body.data.chapter.id] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.fields.chapterIds);
  });

  it('lets the teacher of the paper set its portion, replacing the old one', async () => {
    const res = await call('PUT', `/api/syllabus/schedules/${ids.scheduleId}/portion`, {
      token: tokens.teacher,
      body: { chapterIds: [ids.chapterIds[2]] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const listed = await call('GET', '/api/syllabus/portions', { token: tokens.student });
    const paper = listed.body.data.rows.find((row) => row.schedule_id === ids.scheduleId);
    assert.deepEqual(paper.chapters.map((row) => row.chapter_no), [3]);
  });

  it('refuses a teacher who does not teach the paper', async () => {
    const res = await call('PUT', `/api/syllabus/schedules/${ids.scheduleId}/portion`, {
      token: tokens.teacher,
      body: { chapterIds: [] },
    });
    // the fixture teacher DOES teach this paper, so the guard is proven on the foreign subject:
    // a paper of a class+subject they do not teach is created below and refused.
    assert.equal(res.status, 200);

    const otherClass = await pool.query(
      "INSERT INTO classes (name, level_order) VALUES ('Class 6', 4) RETURNING id",
    );
    const otherExam = await pool.query(
      `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date, created_by)
       VALUES ('Unit Test 2', 'unit_test', $1, '2027-02-01', '2027-02-02', $2) RETURNING id`,
      [ids.yearId, ids.admin],
    );
    const otherSchedule = await pool.query(
      `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time, max_marks)
       VALUES ($1, $2, $3, '2027-02-01', '09:00', '10:00', 100) RETURNING id`,
      [otherExam.rows[0].id, otherClass.rows[0].id, ids.subjectId],
    );

    const denied = await call('PUT', `/api/syllabus/schedules/${otherSchedule.rows[0].id}/portion`, {
      token: tokens.teacher,
      body: { chapterIds: [] },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'SYLLABUS_NOT_YOUR_SUBJECT');
  });

  it('shows the portion of an exam that is not published yet, but only for the own class', async () => {
    const draft = await pool.query(
      `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date, created_by)
       VALUES ('Half Yearly', 'unit_test', $1, '2027-01-10', '2027-01-20', $2) RETURNING id`,
      [ids.yearId, ids.admin],
    );
    const draftSchedule = await pool.query(
      `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time, max_marks)
       VALUES ($1, $2, $3, '2027-01-12', '09:00', '10:00', 100) RETURNING id`,
      [draft.rows[0].id, ids.classId, ids.subjectId],
    );

    const res = await call('GET', '/api/syllabus/portions', { token: tokens.student });
    const ids_ = res.body.data.rows.map((row) => row.schedule_id);
    assert.ok(ids_.includes(draftSchedule.rows[0].id), 'the portion is readable before the exam is published');

    const otherClass = await pool.query(
      "INSERT INTO classes (name, level_order) VALUES ('Class 7', 5) RETURNING id",
    );
    const foreignExam = await pool.query(
      `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date, created_by)
       VALUES ('Class 7 Test', 'unit_test', $1, '2027-03-01', '2027-03-02', $2) RETURNING id`,
      [ids.yearId, ids.admin],
    );
    const foreignSchedule = await pool.query(
      `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time, max_marks)
       VALUES ($1, $2, $3, '2027-03-01', '09:00', '10:00', 100) RETURNING id`,
      [foreignExam.rows[0].id, otherClass.rows[0].id, ids.subjectId],
    );

    const again = await call('GET', '/api/syllabus/portions', { token: tokens.student });
    const ids2 = again.body.data.rows.map((row) => row.schedule_id);
    assert.ok(!ids2.includes(foreignSchedule.rows[0].id), 'another class\'s paper is not visible');
  });
});
