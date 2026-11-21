import './support/testEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { ACCOUNTS, seedAcademicFixtures, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Hardening, second batch: enrollment lifecycle (BE-05), fees (BE-20..23), attendance (BE-43/44),
 * sections (BE-46), teachers (BE-37), search (BE-13), document metadata (BE-14/17), unlock (BE-25).
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

describe('BE-05 an enrollment follows the student status', () => {
  it('closes the enrollment on withdrawal and reopens it when the student returns', async () => {
    const withdrawn = await call('POST', `/api/students/${ids.studentId}/status`, {
      token: tokens.admin,
      body: { status: 'withdrawn', effectiveDate: todayIso(), remarks: 'left' },
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));

    const closed = await pool.query(
      "SELECT status FROM enrollments WHERE student_id = $1 AND academic_year_id = $2",
      [ids.studentId, ids.yearId],
    );
    assert.equal(closed.rows[0].status, 'withdrawn');

    await call('POST', `/api/students/${ids.studentId}/status`, {
      token: tokens.admin,
      body: { status: 'active', effectiveDate: todayIso(), remarks: 'back' },
    });
    const reopened = await pool.query(
      "SELECT status FROM enrollments WHERE student_id = $1 AND academic_year_id = $2",
      [ids.studentId, ids.yearId],
    );
    assert.equal(reopened.rows[0].status, 'active');
  });
});

describe('fees', () => {
  let structureId;
  let studentFeeId;

  before(async () => {
    const structure = await pool.query(
      `INSERT INTO fee_structures (academic_year_id, class_id, name, total_amount, installment_plan)
       VALUES ($1, $2, 'Tuition', 10000, 'one_time') RETURNING id`,
      [ids.yearId, ids.classId],
    );
    structureId = structure.rows[0].id;
    const fee = await pool.query(
      `INSERT INTO student_fees (student_id, academic_year_id, fee_structure_id, gross_amount, concession_amount)
       VALUES ($1, $2, $3, 10000, 0) RETURNING id`,
      [ids.studentId, ids.yearId, structureId],
    );
    studentFeeId = fee.rows[0].id;
  });

  it('BE-20 records a retried payment once', async () => {
    const key = '5b1f4c1e-1111-4a4a-9a9a-1a2b3c4d5e6f';
    const first = await call('POST', '/api/fees/payments', {
      token: tokens.admin,
      body: { studentFeeId, amount: 2500, paymentMode: 'cash', paidOn: todayIso(), idempotencyKey: key },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const again = await call('POST', '/api/fees/payments', {
      token: tokens.admin,
      body: { studentFeeId, amount: 2500, paymentMode: 'cash', paidOn: todayIso(), idempotencyKey: key },
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.data.receipt.receipt_no, first.body.data.receipt.receipt_no);

    const rows = await pool.query('SELECT count(*)::int AS n FROM fee_payments WHERE student_fee_id = $1', [studentFeeId]);
    assert.equal(rows.rows[0].n, 1, 'one real payment, not two');
  });

  it('BE-22 refuses to re-cost a class below what a family already paid', async () => {
    // paid 2500 against a 10000 structure with 0 concession -> dropping to 2000 must be refused
    const res = await call('POST', '/api/fees/structures/bulk', {
      token: tokens.admin,
      body: {
        installmentPlan: 'one_time',
        recostExisting: true,
        entries: [{ classId: ids.classId, totalAmount: 2000 }],
      },
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'RECOST_NEGATIVE');
  });

  it('BE-23 accepts an empty categoryId instead of a 500', async () => {
    const res = await call('POST', '/api/fees/structures', {
      token: tokens.admin,
      body: { name: 'Empty category', classId: ids.classId, categoryId: '', totalAmount: 1200, installmentPlan: 'one_time' },
    });
    assert.ok([201, 409].includes(res.status), JSON.stringify(res.body));
    assert.notEqual(res.status, 500);
  });

  it('BE-24 rejects a payment dated in the future', async () => {
    const res = await call('POST', '/api/fees/payments', {
      token: tokens.admin,
      body: { studentFeeId, amount: 10, paymentMode: 'cash', paidOn: '2099-01-01' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.fields.paidOn);
  });
});

describe('attendance', () => {
  it('BE-43 allows only one pending correction per record', async () => {
    const day = todayIso();
    const attendance = await pool.query(
      'SELECT id, status FROM attendance WHERE student_id = $1 AND attendance_date = $2',
      [ids.studentId, day],
    );
    const row = attendance.rows[0];
    const requested = row.status === 'late' ? 'absent' : 'late';

    const first = await call('POST', '/api/attendance/corrections', {
      token: tokens.teacher,
      body: { attendanceId: row.id, requestedStatus: requested, reason: 'first' },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await call('POST', '/api/attendance/corrections', {
      token: tokens.teacher,
      body: { attendanceId: row.id, requestedStatus: row.status === 'present' ? 'late' : 'present', reason: 'second' },
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error.code, 'CORRECTION_PENDING');

    await pool.query(
      "UPDATE attendance_corrections SET status = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1",
      [first.body.data.id, ids.admin],
    );
  });

  it('BE-44 obeys the attendance lock time from Settings', async () => {
    const early = await call('PUT', '/api/admin/settings', {
      token: tokens.admin,
      body: { attendanceLockTime: '00:01' },
    });
    assert.equal(early.status, 200, JSON.stringify(early.body));

    const locked = await call('POST', '/api/attendance/mark', {
      token: tokens.teacher,
      body: { sectionId: ids.sectionA, date: todayIso(), entries: [{ studentId: ids.studentId, status: 'present' }] },
    });
    assert.equal(locked.status, 409, JSON.stringify(locked.body));
    assert.equal(locked.body.error.code, 'ATTENDANCE_LOCKED');

    // restore the default so later runs behave
    await call('PUT', '/api/admin/settings', { token: tokens.admin, body: { attendanceLockTime: '23:59' } });
  });
});

describe('sections and teachers', () => {
  it('BE-46 refuses to delete a section that still has a class teacher', async () => {
    // an EMPTY section (no students) that nevertheless has a class teacher
    const section = await pool.query(
      "INSERT INTO sections (class_id, name) VALUES ($1, 'Z') RETURNING id",
      [ids.classId],
    );
    const user = await pool.query(
      `INSERT INTO users (role_id, username, email, password_hash)
       VALUES ((SELECT id FROM roles WHERE code = 'teacher'), 'z.teacher@vvs.test', 'z.teacher@vvs.test', 'x') RETURNING id`,
    );
    const teacher = await pool.query(
      `INSERT INTO teachers (user_id, first_name, last_name, gender, mobile, joining_date)
       VALUES ($1, 'Zed', 'Teacher', 'male', '9800000097', '2026-04-01') RETURNING id`,
      [user.rows[0].id],
    );
    await pool.query(
      'INSERT INTO class_teachers (academic_year_id, section_id, teacher_id) VALUES ($1, $2, $3)',
      [ids.yearId, section.rows[0].id, teacher.rows[0].id],
    );

    const res = await call('DELETE', `/api/academics/sections/${section.rows[0].id}`, { token: tokens.admin });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'SECTION_HAS_CLASS_TEACHER');
  });

  it('BE-37 refuses a class teacher who is not active', async () => {
    await pool.query("UPDATE teachers SET status = 'resigned' WHERE id = $1", [ids.teacherId]);
    const res = await call('POST', `/api/teachers/${ids.teacherId}/class-teacher`, {
      token: tokens.admin,
      body: { sectionId: ids.sectionB, effectiveFrom: todayIso() },
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'TEACHER_NOT_ACTIVE');
    await pool.query("UPDATE teachers SET status = 'active' WHERE id = $1", [ids.teacherId]);
  });
});

describe('reads and metadata', () => {
  it('BE-13 escapes LIKE wildcards in the student search', async () => {
    const res = await call('GET', '/api/students?search=%25%25', { token: tokens.admin });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.rows.length, 0, 'a literal %% matches nobody');
  });

  it('BE-14 hides the login metadata from a parent', async () => {
    const asAdmin = await call('GET', `/api/students/${ids.studentId}`, { token: tokens.admin });
    assert.ok(asAdmin.body.data.login, 'the office still sees the login');
    const asParent = await call('GET', `/api/students/${ids.studentId}`, { token: tokens.parent });
    assert.equal(asParent.status, 200);
    assert.equal(asParent.body.data.login, undefined);
  });

  it('BE-04 rejects a file whose bytes are not what its name claims', async () => {
    const upload = async (bytes, name) => {
      const form = new FormData();
      form.append('documents', new Blob([bytes], { type: 'application/pdf' }), name);
      form.append('documentTypes', JSON.stringify(['other']));
      const res = await fetch(`${base}/api/students/${ids.studentId}/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.admin}` },
        body: form,
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    const fake = await upload('<html><script>alert(1)</script></html>', 'marksheet.pdf');
    assert.equal(fake.status, 400, JSON.stringify(fake.body));
    assert.equal(fake.body.error.code, 'UNSUPPORTED_FILE_TYPE');

    const real = await upload('%PDF-1.4\n% test\n', 'marksheet.pdf');
    assert.equal(real.status, 201, JSON.stringify(real.body));
  });

  it('BE-25 answers 404 for an unlock of a paper that does not exist', async () => {
    const res = await call('POST', '/api/exams/marks/999999/unlock', { token: tokens.admin, body: { reason: 'nope' } });
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });
});
