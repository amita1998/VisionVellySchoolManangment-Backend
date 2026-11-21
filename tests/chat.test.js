import './support/testEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { ACCOUNTS, seedAcademicFixtures, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Parent–teacher chat board.
 *
 *   a parent opens a thread for their child with the teacher who teaches that child → both sides
 *   write in it → unread counts follow the read receipts. The rules that must hold: a parent can
 *   only talk about their own child, only with a teacher of that child, a second family cannot read
 *   the thread, and a student has no access at all.
 */

let server;
let base;
let ids;
let strangerTeacherId;
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

  // A teacher who teaches nothing in this school — used to prove the child/teacher relation is
  // checked and not assumed.
  const strangerUser = await pool.query(
    `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
     VALUES ((SELECT id FROM roles WHERE code = 'teacher'), 'stranger.teacher@vvs.test',
             'stranger.teacher@vvs.test', 'x', FALSE) RETURNING id`,
  );
  const stranger = await pool.query(
    `INSERT INTO teachers (user_id, first_name, last_name, gender, mobile, email, joining_date, status)
     VALUES ($1, 'Stranger', 'Teacher', 'male', '9800000099', 'stranger.teacher@vvs.test', '2021-06-01', 'active')
     RETURNING id`,
    [strangerUser.rows[0].id],
  );
  strangerTeacherId = stranger.rows[0].id;

  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login(ACCOUNTS.admin.username);
  tokens.teacher = await login(ACCOUNTS.teacher.username);
  tokens.student = await login(ACCOUNTS.student.username);
  tokens.parent = await login(ACCOUNTS.parent.username);
  tokens.otherParent = await login('other.parent@vvs.test');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('starting a conversation', () => {
  it('lets a parent open a thread with the teacher of their child', async () => {
    const res = await call('POST', '/api/chat/threads', {
      token: tokens.parent,
      body: { studentId: ids.studentId, teacherId: ids.teacherId },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created, true);
    assert.equal(res.body.data.thread.student_id, ids.studentId);
    assert.equal(res.body.data.thread.teacher_id, ids.teacherId);
    ids.threadId = res.body.data.thread.id;
  });

  it('returns the same thread instead of a duplicate', async () => {
    const res = await call('POST', '/api/chat/threads', {
      token: tokens.parent,
      body: { studentId: ids.studentId, teacherId: ids.teacherId },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.created, false);
    assert.equal(res.body.data.thread.id, ids.threadId);
  });

  it('refuses a thread about another family\u2019s child', async () => {
    const res = await call('POST', '/api/chat/threads', {
      token: tokens.parent,
      body: { studentId: ids.otherStudentId, teacherId: ids.teacherId },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CHAT_NOT_YOUR_CHILD');
  });

  it('refuses a thread with a teacher who does not teach that child', async () => {
    const res = await call('POST', '/api/chat/threads', {
      token: tokens.parent,
      body: { studentId: ids.studentId, teacherId: strangerTeacherId },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.fields.teacherId);
  });

  it('lets the teacher open the same thread without naming themselves', async () => {
    const res = await call('POST', '/api/chat/threads', {
      token: tokens.teacher,
      body: { studentId: ids.studentId },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.thread.id, ids.threadId);
  });

  it('never opens the board to a student', async () => {
    const list = await call('GET', '/api/chat/threads', { token: tokens.student });
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('messages', () => {
  it('delivers a parent message to the teacher as unread', async () => {
    const sent = await call('POST', `/api/chat/threads/${ids.threadId}/messages`, {
      token: tokens.parent,
      body: { body: 'Ananya is struggling with fractions.' },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    const inbox = await call('GET', '/api/chat/threads', { token: tokens.teacher });
    assert.equal(inbox.status, 200);
    const thread = inbox.body.data.rows.find((row) => row.id === ids.threadId);
    assert.ok(thread, 'the teacher should see the thread');
    assert.equal(thread.unread, 1);
    assert.equal(thread.last_body, 'Ananya is struggling with fractions.');
    assert.equal(inbox.body.data.unread, 1);
  });

  it('answers from the teacher and counts the parent unread', async () => {
    const sent = await call('POST', `/api/chat/threads/${ids.threadId}/messages`, {
      token: tokens.teacher,
      body: { body: 'I will give her extra practice this week.' },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    const unread = await call('GET', '/api/chat/unread', { token: tokens.parent });
    assert.equal(unread.status, 200);
    assert.equal(unread.body.data.unread, 1);
  });

  it('clears the count when the parent reads the thread', async () => {
    const read = await call('POST', `/api/chat/threads/${ids.threadId}/read`, { token: tokens.parent });
    assert.equal(read.status, 200);
    const unread = await call('GET', '/api/chat/unread', { token: tokens.parent });
    assert.equal(unread.body.data.unread, 0);

    // the teacher still has not read the parent's message
    const teacherUnread = await call('GET', '/api/chat/unread', { token: tokens.teacher });
    assert.equal(teacherUnread.body.data.unread, 1);
  });

  it('returns the conversation oldest first with mine flags', async () => {
    const res = await call('GET', `/api/chat/threads/${ids.threadId}/messages`, { token: tokens.parent });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const bodies = res.body.data.messages.map((row) => row.body);
    assert.deepEqual(bodies, [
      'Ananya is struggling with fractions.',
      'I will give her extra practice this week.',
    ]);
    assert.deepEqual(res.body.data.messages.map((row) => row.mine), [true, false]);
    assert.equal(res.body.data.thread.unread, 0);
  });

  it('rejects an empty and an oversized message', async () => {
    const empty = await call('POST', `/api/chat/threads/${ids.threadId}/messages`, {
      token: tokens.parent,
      body: { body: '   ' },
    });
    assert.equal(empty.status, 400);
    assert.ok(empty.body.error.fields.body);

    const long = await call('POST', `/api/chat/threads/${ids.threadId}/messages`, {
      token: tokens.parent,
      body: { body: 'x'.repeat(2001) },
    });
    assert.equal(long.status, 400);
  });
});

describe('scope', () => {
  it('hides the thread from another family', async () => {
    const read = await call('GET', `/api/chat/threads/${ids.threadId}/messages`, { token: tokens.otherParent });
    assert.equal(read.status, 404);

    const send = await call('POST', `/api/chat/threads/${ids.threadId}/messages`, {
      token: tokens.otherParent,
      body: { body: 'not mine' },
    });
    assert.equal(send.status, 404);
  });

  it('refuses a parent writing to somebody else\u2019s thread', async () => {
    const res = await call('POST', `/api/chat/threads/${ids.threadId}/read`, { token: tokens.otherParent });
    assert.equal(res.status, 404);
  });

  it('lists the parent\u2019s teachers for a child', async () => {
    const res = await call('GET', `/api/chat/contacts?studentId=${ids.studentId}`, { token: tokens.parent });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const found = res.body.data.rows.find((row) => row.id === ids.teacherId);
    assert.ok(found, 'the class teacher should be a contact');
    assert.equal(found.label, 'Class teacher');
  });

  it('lists the teacher\u2019s students', async () => {
    const res = await call('GET', '/api/chat/contacts', { token: tokens.teacher });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const studentIds = res.body.data.rows.map((row) => row.student_id);
    assert.ok(studentIds.includes(ids.studentId));
    assert.ok(studentIds.includes(ids.otherStudentId));
  });
});
