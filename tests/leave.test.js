import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Leave management: application rules, decisions, quota and the attendance hand-off.
 *
 * The rules a school actually depends on:
 *   - the same member cannot hold two overlapping requests
 *   - a request cannot exceed the type's annual quota (pending counts, otherwise two clerks
 *     approve past the limit)
 *   - only the admin (or that student's class teacher) may decide
 *   - an approved student leave lands in the attendance register for the days already gone
 */

let server;
let base;
let ids;
let tokens = {};
let types = {};

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}

async function login(identifier, password = TEST_PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  return (await res.json())?.data?.accessToken;
}

/** School-timezone day strings, e.g. 2026-11-19. */
async function daysAgo(n) {
  const { rows } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date - $1::int, 'YYYY-MM-DD') AS d`,
    [n],
  );
  return rows[0].d;
}

before(async () => {
  ids = await seedAcademicFixtures();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login(ACCOUNTS.admin.username);
  tokens.teacher = await login(ACCOUNTS.teacher.username);
  tokens.student = await login(ACCOUNTS.student.username);
  tokens.parent = await login(ACCOUNTS.parent.username);

  const list = await call('GET', '/api/leave/types', { token: tokens.admin });
  types = Object.fromEntries(list.body.data.types.map((row) => [row.code, row]));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('short leave and notifications', () => {
  it('stores a half day as 0.5 and refuses a short leave that spans dates', async () => {
    const day = await daysAgo(-3); // a few days in the future
    const ok = await call('POST', '/api/leave/requests', {
      token: tokens.student,
      body: {
        leaveTypeId: types.short.id,
        studentId: ids.studentId,
        durationType: 'half_day',
        fromDate: day,
        toDate: day,
        reason: 'Afternoon hospital visit',
      },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(Number(ok.body.data.request.days), 0.5);
    assert.equal(ok.body.data.request.duration_type, 'half_day');

    const bad = await call('POST', '/api/leave/requests', {
      token: tokens.student,
      body: {
        leaveTypeId: types.short.id,
        studentId: ids.studentId,
        durationType: 'half_day',
        fromDate: await daysAgo(-6),
        toDate: await daysAgo(-5),
        reason: 'Spans two days',
      },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  });

  it('counts an hourly leave as hours/8', async () => {
    const day = await daysAgo(-8);
    const res = await call('POST', '/api/leave/requests', {
      token: tokens.teacher,
      body: {
        leaveTypeId: types.short.id,
        durationType: 'hourly',
        hours: 2,
        fromDate: day,
        toDate: day,
        reason: 'Bank work',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(Number(res.body.data.request.days), 0.25);
    assert.equal(res.body.data.request.hours, 2);
    ids.shortRequest = res.body.data.request.id;
  });

  it('notifies the admin of a new request and the teacher of the decision', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM notifications');
    const decided = await call('POST', `/api/leave/requests/${ids.shortRequest}/decide`, {
      token: tokens.admin,
      body: { decision: 'approved', note: 'Fine' },
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));

    const { rows } = await pool.query(
      `SELECT type, title, body, link FROM notifications ORDER BY id DESC LIMIT 2`,
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.link === '/admin/leave'), 'admin should be told about the request');
    const decision = rows.find((row) => row.link === '/teacher/leave');
    assert.ok(decision, 'the applicant should be told about the decision');
    assert.equal(decision.title, 'Leave approved');
    assert.match(decision.body, /was approved/);
    // the request message carries the human length, not "0.25 days"
    const request = rows.find((row) => row.link === '/admin/leave');
    assert.match(request.body, /2 hours/);
    assert.ok((await pool.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n > before.rows[0].n);
  });
});

describe('applying', () => {
  it('lets a student apply and counts the days inclusively', async () => {
    const from = await daysAgo(2);
    const to = await daysAgo(1);
    const res = await call('POST', '/api/leave/requests', {
      token: tokens.student,
      body: { leaveTypeId: types.sick.id, studentId: ids.studentId, fromDate: from, toDate: to, reason: 'Fever' },
    });
    assert.equal(res.status, 201);
    assert.equal(Number(res.body.data.request.days), 2); // NUMERIC arrives as a string
    assert.equal(res.body.data.request.status, 'pending');
    ids.sickRequest = res.body.data.request.id;
  });

  it('refuses an overlapping request for the same member', async () => {
    const from = await daysAgo(1);
    const to = await daysAgo(0);
    const res = await call('POST', '/api/leave/requests', {
      token: tokens.student,
      body: { leaveTypeId: types.casual.id, studentId: ids.studentId, fromDate: from, toDate: to, reason: 'Overlap' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LEAVE_OVERLAP');
  });

  it('lets a parent apply for their own child but not for someone else’s', async () => {
    const from = await daysAgo(5);
    const to = await daysAgo(4);
    const own = await call('POST', '/api/leave/requests', {
      token: tokens.parent,
      body: { leaveTypeId: types.casual.id, studentId: ids.studentId, fromDate: from, toDate: to, reason: 'Family function' },
    });
    assert.equal(own.status, 201);
    ids.parentRequest = own.body.data.request.id;

    const otherChild = await call('POST', '/api/leave/requests', {
      token: tokens.parent,
      body: {
        leaveTypeId: types.casual.id,
        studentId: ids.otherStudentId,
        fromDate: await daysAgo(8),
        toDate: await daysAgo(7),
        reason: 'Not my child',
      },
    });
    assert.equal(otherChild.status, 403);
    assert.equal(otherChild.body.error.code, 'LEAVE_FORBIDDEN');
  });

  it('lets a teacher apply for their own leave', async () => {
    const res = await call('POST', '/api/leave/requests', {
      token: tokens.teacher,
      body: {
        leaveTypeId: types.sick.id,
        teacherId: ids.teacherId,
        fromDate: await daysAgo(6),
        toDate: await daysAgo(6),
        reason: 'Medical checkup',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.request.teacher_id, ids.teacherId);
  });

  it('refuses a request beyond the annual quota', async () => {
    const from = await daysAgo(60);
    const to = await daysAgo(60 - 30); // 31 days against sick quota 12 + 2 already pending
    const res = await call('POST', '/api/leave/requests', {
      token: tokens.student,
      body: { leaveTypeId: types.sick.id, studentId: ids.studentId, fromDate: from, toDate: to, reason: 'Too long' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LEAVE_QUOTA_EXCEEDED');
  });

  it('refuses a leave type that does not apply to the member', async () => {
    const res = await call('POST', '/api/leave/requests', {
      token: tokens.student,
      body: {
        leaveTypeId: types.maternity.id,
        studentId: ids.studentId,
        fromDate: await daysAgo(20),
        toDate: await daysAgo(19),
        reason: 'Nope',
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'LEAVE_TYPE_NOT_APPLICABLE');
  });
});

describe('self-service', () => {
  it('lets a student apply without sending their own id', async () => {
    const res = await call('POST', '/api/leave/requests', {
      token: tokens.student,
      body: {
        leaveTypeId: types.casual.id,
        fromDate: await daysAgo(12),
        toDate: await daysAgo(12),
        reason: 'No id sent',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.request.student_id, ids.studentId);
  });
});

describe('deciding', () => {
  it('refuses a student as approver', async () => {
    const res = await call('POST', `/api/leave/requests/${ids.sickRequest}/decide`, {
      token: tokens.student,
      body: { decision: 'approved' },
    });
    assert.equal(res.status, 403);
  });

  it('approves as the class teacher and writes attendance for the past days', async () => {
    const res = await call('POST', `/api/leave/requests/${ids.sickRequest}/decide`, {
      token: tokens.teacher,
      body: { decision: 'approved', note: 'Get well soon' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.request.status, 'approved');
    assert.ok(res.body.data.request.attendance_marked >= 1, 'past days must be marked as leave');

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM attendance WHERE student_id = $1 AND status = 'leave'`,
      [ids.studentId],
    );
    assert.ok(rows.rows[0].n >= 1);
  });

  it('refuses a second decision on the same request', async () => {
    const res = await call('POST', `/api/leave/requests/${ids.sickRequest}/decide`, {
      token: tokens.admin,
      body: { decision: 'rejected' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LEAVE_NOT_PENDING');
  });

  it('rejects another student’s request for a teacher who does not own that class', async () => {
    // The other student sits in section B; the teacher owns section A only.
    const from = await daysAgo(3);
    const to = await daysAgo(3);
    const other = await call('POST', '/api/leave/requests', {
      token: tokens.admin,
      body: {
        leaveTypeId: types.casual.id,
        studentId: ids.otherStudentId,
        fromDate: from,
        toDate: to,
        reason: 'Admin on behalf',
      },
    });
    assert.equal(other.status, 201);
    const decide = await call('POST', `/api/leave/requests/${other.body.data.request.id}/decide`, {
      token: tokens.teacher,
      body: { decision: 'approved' },
    });
    assert.equal(decide.status, 403);
    assert.equal(decide.body.error.code, 'LEAVE_DECIDE_FORBIDDEN');
  });
});

describe('reading', () => {
  it('shows a student only their own requests and the admin everyone’s', async () => {
    const own = await call('GET', '/api/leave/requests', { token: tokens.student });
    assert.equal(own.status, 200);
    assert.ok(own.body.data.rows.every((row) => row.member_code === 'VVS-900001'));

    const all = await call('GET', '/api/leave/requests?limit=50', { token: tokens.admin });
    assert.ok(all.body.data.meta.total >= 3);
  });

  it('reports the balance per type', async () => {
    const res = await call('GET', '/api/leave/balance', { token: tokens.student });
    assert.equal(res.status, 200);
    const sick = res.body.data.rows.find((row) => row.name === 'Sick leave');
    assert.ok(sick, 'sick leave must be listed');
    assert.equal(sick.used, 2);
    assert.equal(sick.remaining, sick.annual_quota - 2);
  });
});
