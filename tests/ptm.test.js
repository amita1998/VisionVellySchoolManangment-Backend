import './support/testEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { ACCOUNTS, seedAcademicFixtures, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Parent–teacher meetings.
 *
 *   admin publishes a slot for a teacher → a parent books it for their child → the teacher marks
 *   it attended. The rules that must hold: no overlapping slots, one place per child, capacity is
 *   respected, a parent cannot book for someone else's child, and both sides get a notification.
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
  const res = await call('POST', '/api/auth/login', {
    body: { identifier, password: TEST_PASSWORD },
  });
  return res.body.data.accessToken;
}

function tomorrow(offset = 1) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
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

describe('slots', () => {
  it('lets the admin publish a slot for a teacher', async () => {
    const res = await call('POST', '/api/ptm/slots', {
      token: tokens.admin,
      body: {
        teacherId: ids.teacherId,
        slotDate: tomorrow(2),
        startTime: '10:00',
        endTime: '10:20',
        mode: 'in_person',
        location: 'Room 4',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.slotId = res.body.data.slot.id;
  });

  it('refuses an overlapping slot for the same teacher', async () => {
    const res = await call('POST', '/api/ptm/slots', {
      token: tokens.admin,
      body: { teacherId: ids.teacherId, slotDate: tomorrow(2), startTime: '10:10', endTime: '10:30' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PTM_SLOT_OVERLAP');
  });

  it('lets a teacher publish their own slot but not for a colleague', async () => {
    const ok = await call('POST', '/api/ptm/slots', {
      token: tokens.teacher,
      body: { teacherId: ids.teacherId, slotDate: tomorrow(3), startTime: '11:00', endTime: '11:20' },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    ids.ownSlotId = ok.body.data.slot.id;

    const denied = await call('POST', '/api/ptm/slots', {
      token: tokens.teacher,
      body: { teacherId: 999999, slotDate: tomorrow(4), startTime: '09:00', endTime: '09:20' },
    });
    assert.equal(denied.status, 403);
  });

  // The teacher screen has no teacher picker: it posts no teacherId and the server must use the
  // caller's own teacher record. Without this the teacher's only way to publish answered 400.
  it('defaults a teacher slot to the caller when no teacherId is sent', async () => {
    const res = await call('POST', '/api/ptm/slots', {
      token: tokens.teacher,
      body: { slotDate: tomorrow(6), startTime: '09:00', endTime: '09:20' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const mine = await call('GET', '/api/ptm/slots?from=' + tomorrow(6) + '&to=' + tomorrow(6), {
      token: tokens.teacher,
    });
    const slot = mine.body.data.rows.find((row) => row.id === res.body.data.slot.id);
    assert.ok(slot, 'the new slot should be in the teacher own list');
    assert.equal(slot.teacher_id, ids.teacherId);
  });

  it('refuses an admin slot with no teacher named', async () => {
    const res = await call('POST', '/api/ptm/slots', {
      token: tokens.admin,
      body: { slotDate: tomorrow(7), startTime: '09:00', endTime: '09:20' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.fields.teacherId, 'the answer names the missing field');
  });

  it('refuses a parent publishing a slot', async () => {
    const res = await call('POST', '/api/ptm/slots', {
      token: tokens.parent,
      body: { teacherId: ids.teacherId, slotDate: tomorrow(8), startTime: '09:00', endTime: '09:20' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('shows open slots to a parent', async () => {
    const res = await call('GET', '/api/ptm/slots', { token: tokens.parent });
    assert.equal(res.status, 200);
    const ids_ = res.body.data.rows.map((row) => row.id);
    assert.ok(ids_.includes(ids.slotId), 'the published slot should be visible');
  });
});

describe('bookings', () => {
  it('lets a parent book a slot for their own child and notifies the teacher', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM notifications');
    const res = await call('POST', `/api/ptm/slots/${ids.slotId}/book`, {
      token: tokens.parent,
      body: { studentId: ids.studentId, note: 'Want to discuss maths' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.bookingId = res.body.data.booking.id;

    const note = await pool.query(
      `SELECT title, link FROM notifications ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(note.rows[0].link, '/teacher/ptm');
    assert.ok((await pool.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n > before.rows[0].n);
  });

  it('refuses a second place for the same child in one slot', async () => {
    const res = await call('POST', `/api/ptm/slots/${ids.slotId}/book`, {
      token: tokens.parent,
      body: { studentId: ids.studentId },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PTM_ALREADY_BOOKED');
  });

  it('refuses a booking for a child that is not theirs', async () => {
    const res = await call('POST', `/api/ptm/slots/${ids.ownSlotId}/book`, {
      token: tokens.parent,
      body: { studentId: ids.otherStudentId },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'PTM_NOT_YOUR_CHILD');
  });

  it('stops booking once the slot is full', async () => {
    const created = await call('POST', '/api/ptm/slots', {
      token: tokens.admin,
      body: { teacherId: ids.teacherId, slotDate: tomorrow(5), startTime: '12:00', endTime: '12:15' },
    });
    const slotId = created.body.data.slot.id;
    const first = await call('POST', `/api/ptm/slots/${slotId}/book`, {
      token: tokens.parent,
      body: { studentId: ids.studentId },
    });
    assert.equal(first.status, 201);

    // capacity is 1 by default: the same slot must reject the second family
    const adminSecond = await call('POST', `/api/ptm/slots/${slotId}/book`, {
      token: tokens.admin,
      body: { studentId: ids.otherStudentId },
    });
    assert.equal(adminSecond.status, 409);
    assert.equal(adminSecond.body.error.code, 'PTM_SLOT_FULL');
  });

  it('lets the teacher mark a booking attended and tells the parent', async () => {
    const res = await call('POST', `/api/ptm/bookings/${ids.bookingId}/decision`, {
      token: tokens.teacher,
      body: { status: 'attended' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.booking.status, 'attended');

    const note = await pool.query('SELECT title, link FROM notifications ORDER BY id DESC LIMIT 1');
    assert.equal(note.rows[0].link, '/parent/ptm');
  });

  it('shows the student their own booking', async () => {
    const res = await call('GET', '/api/ptm/bookings', { token: tokens.student });
    assert.equal(res.status, 200);
    const ids_ = res.body.data.rows.map((row) => row.id);
    assert.ok(ids_.includes(ids.bookingId));
  });
});
