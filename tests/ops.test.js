import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Step 7-9: fees, communication, timetable, settings, audit and reports.
 * Run against a throwaway database (TEST_DATABASE_URL), never the dev one.
 */

let server;
let base;
let ids;
let categoryId;
let structureId;
let studentFeeId;
let paymentId;
let sectionIdA;
let periodId;
let announcementId;

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    type,
    body: type.includes('application/json') ? await res.json().catch(() => null) : await res.text(),
  };
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
  sectionIdA = ids.sectionA;
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

describe('fee structures', () => {
  it('creates a category, a structure and its installments', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);

    const category = await call('POST', '/api/fees/categories', {
      token: admin,
      body: { name: 'Tuition', code: 'TUI' },
    });
    assert.equal(category.status, 201, JSON.stringify(category.body));
    categoryId = category.body.data.id;

    const duplicate = await call('POST', '/api/fees/categories', {
      token: admin,
      body: { name: 'Tuition', code: 'TUI' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'CATEGORY_EXISTS');

    const structure = await call('POST', '/api/fees/structures', {
      token: admin,
      body: {
        name: 'Tuition 2026-27',
        classId: ids.classId,
        categoryId,
        totalAmount: 24000,
        installmentPlan: 'quarterly',
      },
    });
    assert.equal(structure.status, 201, JSON.stringify(structure.body));
    structureId = structure.body.data.id;

    const { rows } = await pool.query(
      'SELECT seq, amount FROM fee_installments WHERE fee_structure_id = $1 ORDER BY seq',
      [structureId],
    );
    assert.equal(rows.length, 4);
    const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
    assert.equal(total, 24000);
  });

  it('assigns the structure to a whole class without duplicating rows', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const first = await call('POST', '/api/fees/assign', {
      token: admin,
      body: { structureId, classId: ids.classId },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.assigned, 2);

    const again = await call('POST', '/api/fees/assign', {
      token: admin,
      body: { structureId, classId: ids.classId },
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.data.assigned, 0, 'a second assignment must not duplicate');

    const { rows } = await pool.query(
      'SELECT id, payable_amount FROM student_fees WHERE fee_structure_id = $1 ORDER BY id',
      [structureId],
    );
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].payable_amount), 24000);
    studentFeeId = rows[0].id;
    void admin;
  });
});

describe('payments and receipts', () => {
  it('records a payment and issues a sequential receipt', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const paid = await call('POST', '/api/fees/payments', {
      token: admin,
      body: {
        studentFeeId,
        amount: 6000,
        paymentMode: 'cash',
        paidOn: '2026-11-17',
      },
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.match(paid.body.data.receipt.receipt_no, /^VVS-RCP-\d{6,}$/);
    paymentId = paid.body.data.payment.id;
  });

  it('refuses a non-cash payment without a reference', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const refused = await call('POST', '/api/fees/payments', {
      token: admin,
      body: { studentFeeId, amount: 500, paymentMode: 'upi', paidOn: '2026-11-17' },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'REFERENCE_REQUIRED');
  });

  it('refuses an overpayment', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const refused = await call('POST', '/api/fees/payments', {
      token: admin,
      body: { studentFeeId, amount: 99999, paymentMode: 'cash', paidOn: '2026-11-17' },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'OVERPAYMENT');
  });

  it('reverses with an entry instead of deleting, and refuses a second reversal', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const shortened = await call('POST', `/api/fees/payments/${paymentId}/reverse`, {
      token: admin,
      body: { reason: 'cheque bounced' },
    });
    assert.equal(shortened.status, 201, JSON.stringify(shortened.body));
    assert.equal(shortened.body.data.amount, -6000);

    const { rows } = await pool.query(
      `SELECT p.is_reversal, r.is_reversed, r.receipt_no
         FROM fee_payments p LEFT JOIN fee_receipts r ON r.payment_id = p.id
        WHERE p.id = $1`,
      [paymentId],
    );
    assert.equal(rows[0].is_reversed, true);
    assert.equal(rows[0].receipt_no.startsWith('VVS-RCP-'), true);

    const twice = await call('POST', `/api/fees/payments/${paymentId}/reverse`, {
      token: admin,
      body: { reason: 'again' },
    });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'ALREADY_REVERSED');
  });

  it('shows the ledger with the collected total back to zero', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const ledger = await call('GET', '/api/fees/payments', { token: admin });
    assert.equal(ledger.status, 200);
    assert.equal(ledger.body.data.rows.length, 2, 'payment + reversal');
    assert.equal(ledger.body.data.summary.collected, 0);
    assert.equal(ledger.body.data.summary.reversals, 1);
  });

  it('keeps teachers out of the fee ledger', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const forbidden = await call('GET', '/api/fees/payments', { token: teacher });
    assert.equal(forbidden.status, 403);
  });
});

describe('fee visibility', () => {
  it('hides fees from a student while the school setting is off', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const refused = await call('GET', `/api/fees/summary/${ids.studentId}`, { token: student });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'FEE_FORBIDDEN');

    // The student's own screen asks for `me`, never for an id.
    const refusedMe = await call('GET', '/api/fees/summary/me', { token: student });
    assert.equal(refusedMe.status, 403);
  });

  it('never lets a student read another student’s fees once it is on', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    await call('PUT', '/api/admin/settings', { token: admin, body: { feeVisibleToStudents: true } });

    const student = await login('student', ACCOUNTS.student.username);
    const own = await call('GET', `/api/fees/summary/${ids.studentId}`, { token: student });
    assert.equal(own.status, 200, JSON.stringify(own.body));

    const tampered = await call('GET', `/api/fees/summary/${ids.otherStudentId}`, { token: student });
    assert.equal(tampered.status, 403, 'id tampering must be refused');

    const me = await call('GET', '/api/fees/summary/me', { token: student });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.data.totals.payable, own.body.data.totals.payable);
  });

  it('lets a parent read only their own child', async () => {
    const parent = await login('parent', ACCOUNTS.parent.username);
    const own = await call('GET', `/api/fees/summary/${ids.studentId}`, { token: parent });
    assert.equal(own.status, 200, JSON.stringify(own.body));

    const other = await call('GET', `/api/fees/summary/${ids.otherStudentId}`, { token: parent });
    assert.equal(other.status, 403);
  });
});

describe('timetable', () => {
  it('creates a period and books a slot', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const period = await call('POST', '/api/timetable/periods', {
      token: admin,
      body: { label: 'P1', startTime: '08:00', endTime: '08:45' },
    });
    assert.equal(period.status, 201, JSON.stringify(period.body));
    periodId = period.body.data.id;

    const slot = await call('POST', '/api/timetable/slots', {
      token: admin,
      body: {
        sectionId: sectionIdA,
        dayOfWeek: 1,
        periodId,
        subjectId: ids.subjectId,
        teacherId: ids.teacherId,
        room: 'R1',
      },
    });
    assert.equal(slot.status, 201, JSON.stringify(slot.body));
  });

  it('refuses to book the same teacher twice in one period', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const clash = await call('POST', '/api/timetable/slots', {
      token: admin,
      body: {
        sectionId: ids.sectionB,
        dayOfWeek: 1,
        periodId,
        subjectId: ids.subjectId,
        teacherId: ids.teacherId,
      },
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'TEACHER_BUSY');

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM timetable_slots');
    assert.equal(rows[0].total, 1);
  });

  it('gives the teacher and the student their own view', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const mine = await call('GET', '/api/timetable/mine', { token: teacher });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.slots.length, 1);
    // The grid needs the period rows and the slot's period id, not just the slot list.
    assert.ok(mine.body.data.periods.length >= 1, 'the teacher payload carries the period grid');
    assert.equal(mine.body.data.slots[0].period_id, periodId);

    const student = await login('student', ACCOUNTS.student.username);
    const section = await call('GET', '/api/timetable/mine', { token: student });
    assert.equal(section.status, 200);
    assert.equal(section.body.data.slots.length, 1);
    assert.equal(section.body.data.section.section_name, 'A');
  });

  it('keeps a teacher from building a timetable', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const refused = await call('POST', '/api/timetable/periods', {
      token: teacher,
      body: { label: 'P2', startTime: '09:00', endTime: '09:45' },
    });
    assert.equal(refused.status, 403);
  });
});

describe('announcements and notifications', () => {
  it('publishes an announcement and notifies each audience', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const created = await call('POST', '/api/comms/announcements', {
      token: admin,
      body: { title: 'Annual day', body: 'Rehearsal on Friday.', type: 'event', status: 'published', audience: 'all' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    announcementId = created.body.data.id;

    const { rows } = await pool.query(
      'SELECT count(*)::int AS total FROM notifications WHERE entity_type = $1 AND entity_id = $2',
      ['announcements', announcementId],
    );
    assert.equal(rows[0].total, 4, 'two parents, one teacher, one student');
  });

  it('shows it unread to a student and marks it read', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const list = await call('GET', '/api/comms/announcements', { token: student });
    assert.equal(list.status, 200);
    const row = list.body.data.announcements.find((item) => item.id === announcementId);
    assert.ok(row);
    assert.equal(row.is_read, false);

    await call('POST', `/api/comms/announcements/${announcementId}/read`, { token: student });
    const after = await call('GET', '/api/comms/announcements', { token: student });
    const updated = after.body.data.announcements.find((item) => item.id === announcementId);
    assert.equal(updated.is_read, true);
  });

  it('keeps drafts away from students', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const draft = await call('POST', '/api/comms/announcements', {
      token: admin,
      body: { title: 'Staff only draft', body: 'internal', type: 'circular', status: 'draft', audience: 'all' },
    });
    assert.equal(draft.status, 201);

    const student = await login('student', ACCOUNTS.student.username);
    const list = await call('GET', '/api/comms/announcements', { token: student });
    assert.equal(list.body.data.announcements.some((item) => item.id === draft.body.data.id), false);
  });

  it('refuses an announcement from a teacher', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const refused = await call('POST', '/api/comms/announcements', {
      token: teacher,
      body: { title: 'Nope', body: 'nope', status: 'published', audience: 'all' },
    });
    assert.equal(refused.status, 403);
  });

  it('lets a teacher publish an assignment only for their own class', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const own = await call('POST', '/api/comms/assignments', {
      token: teacher,
      body: { title: 'Fractions worksheet', classId: ids.classId, subjectId: ids.subjectId, dueDate: '2026-11-25' },
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));

    const other = await pool.query("INSERT INTO subjects (name, code) VALUES ('Art', 'ART') RETURNING id");
    const refused = await call('POST', '/api/comms/assignments', {
      token: teacher,
      body: { title: 'Not mine', classId: ids.classId, subjectId: other.rows[0].id, dueDate: '2026-11-25' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'NOT_YOUR_SUBJECT');
  });

  it('shows assignments to the student of that class', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const list = await call('GET', '/api/comms/assignments', { token: student });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.assignments.length, 1);
    assert.equal(list.body.data.assignments[0].title, 'Fractions worksheet');
  });
});

describe('events', () => {
  it('hides an unpublished event from students', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const draft = await call('POST', '/api/comms/events', {
      token: admin,
      body: { title: 'Internal review', eventDate: '2026-12-01', audience: 'all', publish: false },
    });
    assert.equal(draft.status, 201);

    const student = await login('student', ACCOUNTS.student.username);
    const list = await call('GET', '/api/comms/events', { token: student });
    assert.equal(list.body.data.events.some((item) => item.id === draft.body.data.id), false);

    const published = await call('POST', '/api/comms/events', {
      token: admin,
      body: { title: 'Sports day', eventDate: '2026-12-10', startTime: '09:00', endTime: '13:00', audience: 'all', publish: true },
    });
    assert.equal(published.status, 201);

    const visible = await call('GET', '/api/comms/events', { token: student });
    assert.equal(visible.body.data.events.some((item) => item.id === published.body.data.id), true);
  });

  it('rejects an event that ends before it starts', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const bad = await call('POST', '/api/comms/events', {
      token: admin,
      body: { title: 'Backwards', eventDate: '2026-12-10', startTime: '12:00', endTime: '09:00', audience: 'all' },
    });
    assert.equal(bad.status, 400);
  });
});

describe('settings, audit and reports', () => {
  it('saves settings and writes an audit row', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const saved = await call('PUT', '/api/admin/settings', {
      token: admin,
      body: { schoolName: 'Vision Valley School', attendanceLockTime: '22:00', feeVisibleToStudents: true },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const audit = await call('GET', '/api/admin/audit?action=settings.updated', { token: admin });
    assert.equal(audit.status, 200);
    assert.ok(audit.body.data.total >= 1);
    assert.equal(audit.body.data.rows[0].action, 'settings.updated');
  });

  it('keeps the audit log closed to teachers', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const refused = await call('GET', '/api/admin/audit', { token: teacher });
    assert.equal(refused.status, 403);

    const settings = await call('PUT', '/api/admin/settings', {
      token: teacher,
      body: { schoolName: 'Hacked' },
    });
    assert.equal(settings.status, 403);
  });

  it('returns the student register as JSON and as CSV', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const json = await call('GET', '/api/admin/reports/students', { token: admin });
    assert.equal(json.status, 200);
    assert.equal(json.body.data.total, 2);
    assert.ok(json.body.data.columns.some((column) => column.key === 'admission_id'));

    const csv = await call('GET', '/api/admin/reports/students?format=csv', { token: admin });
    assert.equal(csv.status, 200);
    assert.match(csv.type, /text\/csv/);
    const [header, firstRow] = csv.body.split('\n');
    assert.match(header, /Admission ID/);
    assert.match(firstRow, /VVS-900001|VVS-900002/);
  });

  it('gives a teacher the attendance report but not the student register', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);
    const attendance = await call('GET', '/api/admin/reports/attendance', { token: teacher });
    assert.equal(attendance.status, 200);

    const students = await call('GET', '/api/admin/reports/students', { token: teacher });
    assert.equal(students.status, 403);
  });

  it('reports the fee ledger for the period', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const feeReport = await call('GET', '/api/admin/reports/fees?from=2026-11-01&to=2026-11-30', { token: admin });
    assert.equal(feeReport.status, 200);
    assert.equal(feeReport.body.data.total, 2);
    const amounts = feeReport.body.data.rows.map((row) => Number(row.amount));
    assert.deepEqual(amounts.sort((a, b) => a - b), [-6000, 6000]);
  });

  it('asks for an examination instead of failing when the results report has no exam', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const missing = await call('GET', '/api/admin/reports/results', { token: admin });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
    assert.equal(missing.body.error.fields.examId, 'Choose an examination');

    const unknown = await call('GET', `/api/admin/reports/results?examId=${ids.examId + 9999}`, { token: admin });
    assert.equal(unknown.status, 404);
  });

  it('builds the results report for one exam as JSON and CSV', async () => {
    const admin = await login('admin', ACCOUNTS.admin.username);
    const json = await call('GET', `/api/admin/reports/results?examId=${ids.examId}`, { token: admin });
    assert.equal(json.status, 200, JSON.stringify(json.body));
    assert.equal(json.body.data.total, 1);
    assert.ok(json.body.data.columns.some((column) => column.key === 'grade'));
    assert.equal(json.body.data.rows[0].exam_name, 'Unit Test 1');

    const csv = await call('GET', `/api/admin/reports/results?examId=${ids.examId}&format=csv`, { token: admin });
    assert.equal(csv.status, 200);
    assert.match(csv.type, /text\/csv/);
    assert.match(csv.body.split('\n')[0], /Subject/);
  });

  it('narrows the class-level reports to the classes a teacher actually teaches', async () => {
    // A teacher who teaches nothing this year holds report.view.class but must see an empty report.
    const outsiderHash = await bcrypt.hash(TEST_PASSWORD, 4);
    const outsider = await pool.query(
      `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
       VALUES ((SELECT id FROM roles WHERE code = 'teacher'), $1, $1, $2, FALSE) RETURNING id`,
      ['outsider.teacher@vvs.test', outsiderHash],
    );
    await pool.query(
      `INSERT INTO teachers (user_id, first_name, last_name, gender, mobile, email, joining_date, status)
       VALUES ($1, 'Outsider', 'Teacher', 'male', '9800000009', 'outsider.teacher@vvs.test', '2026-04-01', 'active')`,
      [outsider.rows[0].id],
    );

    const admin = await login('admin', ACCOUNTS.admin.username);
    const assigned = await login('teacher', ACCOUNTS.teacher.username);
    const unassigned = await login('teacher', 'outsider.teacher@vvs.test');

    const adminResults = await call('GET', `/api/admin/reports/results?examId=${ids.examId}`, { token: admin });
    const assignedResults = await call('GET', `/api/admin/reports/results?examId=${ids.examId}`, { token: assigned });
    const unassignedResults = await call('GET', `/api/admin/reports/results?examId=${ids.examId}`, { token: unassigned });

    assert.equal(adminResults.body.data.total, 1, 'admin sees every class');
    assert.equal(assignedResults.status, 200);
    assert.equal(assignedResults.body.data.total, 1, 'the class teacher sees their own class');
    assert.equal(unassignedResults.status, 200);
    assert.equal(unassignedResults.body.data.total, 0, 'an unassigned teacher sees no marks');

    const adminAttendance = await call('GET', '/api/admin/reports/attendance', { token: admin });
    const unassignedAttendance = await call('GET', '/api/admin/reports/attendance', { token: unassigned });
    assert.ok(adminAttendance.body.data.total > 0, 'the fixture marked attendance');
    assert.equal(unassignedAttendance.body.data.total, 0);
  });
});

describe('teacher portal', () => {
  it('shows a teacher their own classes and only their own roster', async () => {
    const teacher = await login('teacher', ACCOUNTS.teacher.username);

    const mine = await call('GET', '/api/teachers/me', { token: teacher });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.data.teacher.name, 'Test Teacher');
    assert.equal(mine.body.data.classes.length, 1);
    assert.equal(mine.body.data.classes[0].class_name, 'Class 5');
    assert.match(mine.body.data.classes[0].subjects, /Mathematics/);
    assert.deepEqual(
      mine.body.data.classes[0].class_teacher_of.map((section) => section.name),
      ['A'],
      'the class-teacher section is part of the payload',
    );

    const roster = await call('GET', '/api/students', { token: teacher });
    assert.equal(roster.status, 200, JSON.stringify(roster.body));
    assert.equal(roster.body.data.meta.total, 2);
    assert.ok(roster.body.data.rows.every((row) => row.className === 'Class 5'));
  });

  it('answers an empty roster for a teacher who teaches nothing', async () => {
    const hash = await bcrypt.hash(TEST_PASSWORD, 4);
    const outsider = await pool.query(
      `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
       VALUES ((SELECT id FROM roles WHERE code = 'teacher'), $1, $1, $2, FALSE)
       ON CONFLICT (lower(username)) DO NOTHING RETURNING id`,
      ['outsider.teacher@vvs.test', hash],
    );
    if (outsider.rows[0]) {
      await pool.query(
        `INSERT INTO teachers (user_id, first_name, last_name, gender, mobile, email, joining_date, status)
         VALUES ($1, 'Outsider', 'Teacher', 'male', '9800000009', 'outsider.teacher@vvs.test', '2026-04-01', 'active')
         ON CONFLICT DO NOTHING`,
        [outsider.rows[0].id],
      );
    }

    const unassigned = await login('teacher', 'outsider.teacher@vvs.test');
    const roster = await call('GET', '/api/students', { token: unassigned });
    assert.equal(roster.status, 200);
    assert.equal(roster.body.data.meta.total, 0, 'no assignments means no visible students');
  });

  it('keeps the student roster away from students and parents', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    assert.equal((await call('GET', '/api/students', { token: student })).status, 403);

    const parent = await login('parent', ACCOUNTS.parent.username);
    assert.equal((await call('GET', '/api/students', { token: parent })).status, 403);
  });
});

describe('notification centre', () => {
  it('lists notifications with an unread count and marks one read', async () => {
    const student = await login('student', ACCOUNTS.student.username);

    const before = await call('GET', '/api/comms/notifications', { token: student });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.ok(before.body.data.notifications.length >= 1);
    const unread = before.body.data.counts.unread;
    assert.ok(unread >= 1, 'the published announcement and assignment notify the student');

    const target = before.body.data.notifications.find((item) => item.read_at === null);
    assert.ok(target, 'at least one row is unread');
    assert.ok(target.type, 'a notification carries its type for the icon');

    const marked = await call('POST', `/api/comms/notifications/${target.id}/read`, { token: student });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));

    const after = await call('GET', '/api/comms/notifications', { token: student });
    assert.equal(after.body.data.counts.unread, unread - 1);
  });

  it('never lets one user mark another user\'s notification', async () => {
    const student = await login('student', ACCOUNTS.student.username);
    const list = await call('GET', '/api/comms/notifications', { token: student });
    const foreignId = list.body.data.notifications[0].id;

    const parent = await login('parent', ACCOUNTS.parent.username);
    const refused = await call('POST', `/api/comms/notifications/${foreignId}/read`, { token: parent });
    assert.equal(refused.status, 404, 'another user\'s row is not found, not merely forbidden');
  });
});
