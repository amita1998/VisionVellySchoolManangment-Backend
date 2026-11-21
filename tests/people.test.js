import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

let server;
let base;
let ids;

function cookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const found = cookies.find((entry) => entry.startsWith('vvs_rt='));
  return found ? found.slice('vvs_rt='.length).split(';')[0] : null;
}

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
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
  return { token: payload?.data?.accessToken, refresh: cookieFrom(res), body: payload };
}

function admissionForm(overrides = {}) {
  const payload = {
    firstName: 'New',
    lastName: 'Pupil',
    gender: 'male',
    dateOfBirth: '2016-03-02',
    admissionDate: '2026-11-17',
    classId: ids.classId,
    sectionId: ids.sectionB,
    parents: [
      {
        fullName: 'Guardian One',
        relationship: 'father',
        mobile: '9822200011',
        email: 'guardian.one@vvs.test',
      },
    ],
    ...overrides,
  };
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  form.append('documentTypes', JSON.stringify(['birth_certificate']));
  form.append(
    'documents',
    new Blob([Buffer.from('%PDF-1.4 test document')], { type: 'application/pdf' }),
    'birth.pdf',
  );
  return form;
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

describe('student admission', () => {
  it('creates the student, login, enrollment, guardian and document in one call', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('POST', '/api/students', { token: admin.token, form: admissionForm() });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { student, account } = res.body.data;

    assert.match(student.admissionId, /^VVS-\d{6,}$/);
    assert.equal(student.status, 'active');
    assert.equal(student.className, 'Class 5');
    assert.equal(student.sectionName, 'B');
    assert.equal(student.parents.length, 1);
    assert.equal(student.parents[0].relationship, 'father');
    assert.ok(student.parents[0].user_id, 'guardian gets a family account');
    assert.equal(student.documents.length, 1);
    assert.equal(student.documents[0].mime_type, 'application/pdf');
    assert.equal(student.statusHistory.length, 1);
    assert.equal(student.statusHistory[0].to_status, 'active');

    assert.equal(account.username, student.admissionId);
    assert.ok(account.temporaryPassword.length >= 8);

    // the new student can sign in with the temporary password and is forced to change it
    const signIn = await login('student', student.admissionId, account.temporaryPassword);
    assert.ok(signIn.token);
    assert.equal(signIn.body.data.user.mustChangePassword, true);
  });

  it('never accepts an admission id from the client and keeps ids sequential', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('POST', '/api/students', {
      token: admin.token,
      form: admissionForm({
        lastName: 'Second',
        admissionId: 'HACK-000001',
        parents: [{ fullName: 'Guardian Two', relationship: 'mother', mobile: '9822200022' }],
      }),
    });
    assert.equal(res.status, 201);
    assert.match(res.body.data.student.admissionId, /^VVS-\d{6,}$/);
    assert.notEqual(res.body.data.student.admissionId, 'HACK-000001');
  });

  it('rejects a file type that is not PDF/JPG/PNG', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const form = admissionForm({ lastName: 'BadFile' });
    form.delete('documents');
    form.append('documents', new Blob([Buffer.from('plain')], { type: 'text/plain' }), 'notes.txt');
    const res = await call('POST', '/api/students', { token: admin.token, form });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNSUPPORTED_FILE_TYPE');
  });

  it('validates required fields', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('POST', '/api/students', {
      token: admin.token,
      body: { firstName: '', parents: [] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.fields.firstName);
    assert.ok(res.body.error.fields.parents);
  });

  it('refuses a section that belongs to another class', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const otherClass = await pool.query(
      `INSERT INTO classes (name, level_order) VALUES ('Class 9', 9) RETURNING id`,
    );
    const res = await call('POST', '/api/students', {
      token: admin.token,
      form: admissionForm({
        lastName: 'Mismatch',
        classId: otherClass.rows[0].id,
        sectionId: ids.sectionA,
        parents: [{ fullName: 'G3', relationship: 'guardian', mobile: '9822200033' }],
      }),
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SECTION_CLASS_MISMATCH');
  });
});

describe('student list and status', () => {
  it('searches, filters and paginates on the server', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const all = await call('GET', '/api/students?page=1&limit=2', { token: admin.token });
    assert.equal(all.status, 200);
    assert.equal(all.body.data.rows.length, 2);
    assert.ok(all.body.data.meta.total >= 3);
    assert.equal(all.body.data.meta.pages >= 2, true);

    const search = await call('GET', '/api/students?search=New Pupil', { token: admin.token });
    assert.equal(search.body.data.rows.length, 1);
    assert.equal(search.body.data.rows[0].lastName, 'Pupil');

    const bySection = await call(`GET`, `/api/students?sectionId=${ids.sectionB}`, { token: admin.token });
    assert.ok(bySection.body.data.rows.every((row) => row.sectionName === 'B'));
  });

  it('persists a status change and appends history (no stale read)', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const target = await pool.query(
      "SELECT id FROM students WHERE last_name = 'Pupil' AND deleted_at IS NULL LIMIT 1",
    );
    const studentId = target.rows[0].id;

    const changed = await call('POST', `/api/students/${studentId}/status`, {
      token: admin.token,
      body: { status: 'suspended', effectiveDate: '2026-11-17', remarks: 'Test suspension' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.status, 'suspended', 'the response must show the NEW status');
    assert.equal(changed.body.data.statusHistory[0].to_status, 'suspended');

    const reloaded = await call('GET', `/api/students/${studentId}`, { token: admin.token });
    assert.equal(reloaded.body.data.status, 'suspended');

    const again = await call('POST', `/api/students/${studentId}/status`, {
      token: admin.token,
      body: { status: 'suspended', effectiveDate: '2026-11-17' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'STATUS_UNCHANGED');
  });

  it('stops a student reading another student’s record', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const own = await call('GET', `/api/students/${ids.studentId}`, { token: student.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.data.admissionId, 'VVS-900001');

    const other = await call('GET', `/api/students/${ids.otherStudentId}`, { token: student.token });
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'STUDENT_FORBIDDEN');
  });

  it('keeps students out of the management endpoints', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const list = await call('GET', '/api/students', { token: student.token });
    assert.equal(list.status, 403);

    const create = await call('POST', '/api/students', { token: student.token, body: {} });
    assert.equal(create.status, 403);
  });
});

describe('teachers', () => {
  it('creates a teacher with an employee id and a login', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('POST', '/api/teachers', {
      token: admin.token,
      body: {
        firstName: 'Ravi',
        lastName: 'Sharma',
        gender: 'male',
        mobile: '9812300001',
        email: 'ravi.sharma@vvs.test',
        joiningDate: '2022-06-01',
        assignments: [{ classId: ids.classId, subjectId: ids.subjectId }],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.data.teacher.employeeId, /^VVT-\d{4,}$/);
    assert.equal(res.body.data.teacher.assignments.length, 1);
    assert.ok(res.body.data.account.temporaryPassword);
  });

  it('allows one section per teacher and blocks a second', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const teacher = await pool.query("SELECT id FROM teachers WHERE email = 'ravi.sharma@vvs.test'");
    const teacherId = teacher.rows[0].id;

    const first = await call('POST', `/api/teachers/${teacherId}/class-teacher`, {
      token: admin.token,
      body: { sectionId: ids.sectionB, effectiveFrom: '2026-11-17' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.classTeacher.section_id, ids.sectionB);

    const second = await call('POST', `/api/teachers/${teacherId}/class-teacher`, {
      token: admin.token,
      body: { sectionId: ids.sectionA, effectiveFrom: '2026-11-17' },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'TEACHER_ALREADY_CLASS_TEACHER');
  });

  it('refuses to deactivate a class teacher', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const teacher = await pool.query("SELECT id FROM teachers WHERE email = 'ravi.sharma@vvs.test'");
    const res = await call('POST', `/api/teachers/${teacher.rows[0].id}/status`, {
      token: admin.token,
      body: { status: 'resigned' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TEACHER_IS_CLASS_TEACHER');
  });

  it('does not let a teacher create another teacher', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const res = await call('POST', '/api/teachers', { token: teacher.token, body: {} });
    assert.equal(res.status, 403);
  });
});

describe('academics', () => {
  it('creates a class, a section and a subject', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);

    const klass = await call('POST', '/api/academics/classes', {
      token: admin.token,
      body: { name: 'Class 7', levelOrder: 7 },
    });
    assert.equal(klass.status, 201);

    const duplicate = await call('POST', '/api/academics/classes', {
      token: admin.token,
      body: { name: 'Class Seven', levelOrder: 7 },
    });
    assert.equal(duplicate.status, 409);

    const section = await call('POST', `/api/academics/classes/${klass.body.data.id}/sections`, {
      token: admin.token,
      body: { name: 'A', capacity: 30 },
    });
    assert.equal(section.status, 201);

    const subject = await call('POST', '/api/academics/subjects', {
      token: admin.token,
      body: { name: 'Science', code: 'SCI' },
    });
    assert.equal(subject.status, 201);

    const linked = await call('PUT', `/api/academics/classes/${klass.body.data.id}/subjects`, {
      token: admin.token,
      body: { subjectIds: [subject.body.data.id] },
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.data.subjects.length, 1);
  });

  it('will not delete a subject that classes or teachers use', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('DELETE', `/api/academics/subjects/${ids.subjectId}`, { token: admin.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SUBJECT_IN_USE');
  });

  it('switches the current academic year without leaving two marked current', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const created = await call('POST', '/api/academics/years', {
      token: admin.token,
      body: { name: '2027-2028', startDate: '2027-04-01', endDate: '2028-03-31' },
    });
    assert.equal(created.status, 201);

    const set = await call('POST', `/api/academics/years/${created.body.data.id}/current`, {
      token: admin.token,
    });
    assert.equal(set.status, 200);

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM academic_years WHERE is_current');
    assert.equal(rows[0].total, 1, 'exactly one current year');

    // restore for other suites that may inspect the current year
    await call('POST', `/api/academics/years/${ids.yearId}/current`, { token: admin.token });
  });
});

describe('duplicates, guardian logins and teacher editing', () => {
  // A teacher created here is reused by the edit test below.
  let teacherId;
  let teacherPassword;

  it('refuses to admit the same child twice', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    // 'New Pupil' was admitted by the first test in this file (same name + date of birth).
    const res = await call('POST', '/api/students', { token: admin.token, form: admissionForm() });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'STUDENT_EXISTS');
    assert.match(res.body.error.message, /already admitted/);
  });

  it('gives the guardian a login named after their email and prints it with the admission', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const form = admissionForm({
      firstName: 'Guardian',
      lastName: 'Login',
      dateOfBirth: '2017-05-05',
      parents: [
        {
          fullName: 'Login Guardian',
          relationship: 'mother',
          mobile: '9822200099',
          email: 'login.guardian@vvs.test',
        },
      ],
    });
    const res = await call('POST', '/api/students', { token: admin.token, form });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const guardian = res.body.data.guardians.find((g) => g.username === 'login.guardian@vvs.test');
    assert.ok(guardian, 'the admission slip lists the guardian login');
    assert.ok(guardian.temporaryPassword, 'every account gets its own temporary password');

    // The guardian's own password opens the guardian account…
    const signIn = await login('parent', 'login.guardian@vvs.test', guardian.temporaryPassword);
    assert.equal(signIn.body.success, true);
    assert.equal(signIn.body.data.user.role, 'parent');

    // …and the student's password does NOT (a shared password let a parent sign in as the child).
    assert.notEqual(guardian.temporaryPassword, res.body.data.account.temporaryPassword);
    const crossed = await call('POST', '/api/auth/login', {
      body: { identifier: 'login.guardian@vvs.test', password: res.body.data.account.temporaryPassword },
    });
    assert.equal(crossed.status, 401);
  });

  it('issues a fresh temporary password for a guardian', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const student = await pool.query(
      "SELECT s.id, p.id AS parent_id FROM students s JOIN student_parents sp ON sp.student_id = s.id JOIN parents p ON p.id = sp.parent_id WHERE lower(p.email) = 'login.guardian@vvs.test'",
    );
    const { id: studentId, parent_id: parentId } = student.rows[0];

    const res = await call('POST', `/api/students/${studentId}/guardians/${parentId}/reset-password`, {
      token: admin.token,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.username, 'login.guardian@vvs.test');
    assert.ok(res.body.data.temporaryPassword);

    const signIn = await login('parent', res.body.data.username, res.body.data.temporaryPassword);
    assert.equal(signIn.body.success, true);
  });

  it('refuses a second teacher with the same mobile number', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const first = await call('POST', '/api/teachers', {
      token: admin.token,
      body: {
        firstName: 'Meera',
        lastName: 'Kulkarni',
        gender: 'female',
        mobile: '9812300077',
        email: 'meera.kulkarni@vvs.test',
        joiningDate: '2023-04-01',
      },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    teacherId = first.body.data.teacher.id;
    teacherPassword = first.body.data.account.temporaryPassword;

    const second = await call('POST', '/api/teachers', {
      token: admin.token,
      body: {
        firstName: 'Meera',
        lastName: 'Kulkarni',
        gender: 'female',
        mobile: '9812300077',
        email: 'meera.k@vvs.test',
        joiningDate: '2023-04-01',
      },
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error.code, 'TEACHER_EXISTS');
  });

  it('edits a teacher and moves the login to the new email', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('PUT', `/api/teachers/${teacherId}`, {
      token: admin.token,
      body: {
        firstName: 'Meera',
        lastName: 'Kulkarni-Rao',
        mobile: '9812300077',
        email: 'meera.rao@vvs.test',
        qualification: 'M.Sc, B.Ed',
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.lastName, 'Kulkarni-Rao');
    assert.equal(res.body.data.qualification, 'M.Sc, B.Ed');
    assert.equal(res.body.data.login.username, 'meera.rao@vvs.test');

    const signIn = await login('teacher', 'meera.rao@vvs.test', teacherPassword);
    assert.equal(signIn.body.success, true, 'the renamed login works with the existing password');

    const oldEmail = await login('teacher', 'meera.kulkarni@vvs.test', teacherPassword);
    assert.equal(oldEmail.body.error?.code, 'INVALID_CREDENTIALS', 'the old address no longer signs in');
  });

  it('refuses a teacher mobile that another teacher already holds', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const res = await call('PUT', `/api/teachers/${teacherId}`, {
      token: admin.token,
      body: { mobile: '9812300001' }, // Ravi Sharma from the earlier test
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'TEACHER_EXISTS');
  });
});
