import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

let server;
let base;

function refreshCookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = cookies.find((entry) => entry.startsWith('vvs_rt='));
  if (!cookie) return null;
  return cookie.slice('vvs_rt='.length).split(';')[0];
}

async function call(method, path, { token, cookie } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = `vvs_rt=${cookie}`;
  const res = await fetch(base + path, { method, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login(key, overrides = {}) {
  const account = ACCOUNTS[key];
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      role: account.role,
      identifier: account.username,
      password: TEST_PASSWORD,
      ...overrides,
    }),
  });
  const body = await res.json();
  return { status: res.status, body, token: body?.data?.accessToken, refresh: refreshCookieFrom(res) };
}

before(async () => {
  await seedAcademicFixtures();
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

describe('GET /api/dashboard/:role', () => {
  it('requires a session', async () => {
    const res = await call('GET', '/api/dashboard/admin');
    assert.equal(res.status, 401);
  });

  it('returns the admin summary for an admin', async () => {
    const auth = await login('admin');
    const res = await call('GET', '/api/dashboard/admin', { token: auth.token });
    assert.equal(res.status, 200);

    const cards = Object.fromEntries(res.body.data.cards.map((card) => [card.key, card.value]));
    assert.equal(cards.students, 2);
    assert.equal(cards.teachers, 1);
    assert.equal(cards.classes, 1);
    assert.match(String(cards.attendance), /%/);

    assert.equal(res.body.data.classes.length, 2, 'both sections');
    assert.ok(Array.isArray(res.body.data.activities));
    assert.ok(res.body.data.shell.calendar.today);
  });

  it('scopes the teacher to their own classes and students', async () => {
    const auth = await login('teacher');
    const res = await call('GET', '/api/dashboard/teacher', { token: auth.token });
    assert.equal(res.status, 200);

    const cards = Object.fromEntries(res.body.data.cards.map((card) => [card.key, card.value]));
    assert.equal(cards.classes, 1);
    assert.equal(cards.students, 2, 'only Class 5 students');
    assert.equal(res.body.data.missingProfile, false);
    // the quick action appears because this teacher is a class teacher
    assert.ok(res.body.data.quickActions.some((action) => action.label === 'Mark Attendance'));
  });

  it('returns only the student’s own numbers', async () => {
    const auth = await login('student');
    const res = await call('GET', '/api/dashboard/student', { token: auth.token });
    assert.equal(res.status, 200);

    assert.equal(res.body.data.profile.admissionId, 'VVS-900001');
    assert.equal(res.body.data.profile.name, 'Test Student');

    const cards = Object.fromEntries(res.body.data.cards.map((card) => [card.key, card.value]));
    assert.equal(cards.attendance, '50%', 'one present, one absent');
    assert.equal(cards.marks, '88 / 100');
    assert.equal(res.body.data.recentResults.length, 1);
  });

  it('lets a parent open their own child and refuses another parent’s child', async () => {
    const auth = await login('parent');

    const own = await call('GET', '/api/dashboard/parent', { token: auth.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.data.child.admissionId, 'VVS-900001');
    assert.equal(own.body.data.children.length, 1);

    const other = await call('GET', '/api/dashboard/parent?childId=2', { token: auth.token });
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'CHILD_FORBIDDEN');
  });

  it('refuses to serve another role’s dashboard', async () => {
    const student = await login('student');
    const asParent = await call('GET', '/api/dashboard/parent', { token: student.token });
    assert.equal(asParent.status, 403);

    const teacher = await login('teacher');
    const asAdmin = await call('GET', '/api/dashboard/admin', { token: teacher.token });
    assert.equal(asAdmin.status, 403);

    const parent = await login('parent');
    const asTeacher = await call('GET', '/api/dashboard/teacher', { token: parent.token });
    assert.equal(asTeacher.status, 403);
  });

  it('rejects an expired or forged token before touching data', async () => {
    const res = await call('GET', '/api/dashboard/admin', { token: 'forged.token.value' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_TOKEN');
  });
});
