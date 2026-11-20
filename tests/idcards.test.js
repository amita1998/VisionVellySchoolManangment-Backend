import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Identity cards: the PDF is generated server-side and streamed, so it must work with no
 * writable filesystem — that is exactly what this proves. Access is per record: admin any,
 * a student their own, a parent a child of theirs, a teacher a student they teach.
 */

let server;
let base;
let ids;
let tokens = {};

async function call(method, path, { token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers });
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
    body: buffer,
  };
}

async function login(identifier, password = TEST_PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  return (await res.json())?.data?.accessToken;
}

const isPdf = (buffer) => buffer.subarray(0, 5).toString() === '%PDF-';

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
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('student id card', () => {
  it('streams a real PDF for the admin', async () => {
    const res = await call('GET', `/api/id-cards/students/${ids.studentId}`, { token: tokens.admin });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'application/pdf');
    assert.match(res.disposition, /attachment|inline/);
    assert.ok(isPdf(res.body), 'starts with %PDF-');
    assert.ok(res.body.length > 1200, `pdf looks too small: ${res.body.length} bytes`);
    // The stream is compressed, so the name is not greppable in the bytes; size + magic prove
    // a rendered document, and the access rules below prove it is the right one.
    assert.ok(res.body.subarray(-8).toString().includes('EOF'), 'pdf ends with the EOF marker');
  });

  it('lets a student print their own card and refuses a classmate’s', async () => {
    const own = await call('GET', `/api/id-cards/students/${ids.studentId}`, { token: tokens.student });
    assert.equal(own.status, 200);
    assert.ok(isPdf(own.body));

    const other = await call('GET', `/api/id-cards/students/${ids.otherStudentId}`, { token: tokens.student });
    assert.equal(other.status, 403);
    assert.ok(!isPdf(other.body));
  });

  it('lets a parent print a child’s card and refuses someone else’s child', async () => {
    const own = await call('GET', `/api/id-cards/students/${ids.studentId}`, { token: tokens.parent });
    assert.equal(own.status, 200);

    const other = await call('GET', `/api/id-cards/students/${ids.otherStudentId}`, { token: tokens.parent });
    assert.equal(other.status, 403);
  });

  it('lets the class teacher print a student they teach', async () => {
    const res = await call('GET', `/api/id-cards/students/${ids.studentId}`, { token: tokens.teacher });
    assert.equal(res.status, 200);
    assert.ok(isPdf(res.body));
  });

  it('refuses an anonymous request', async () => {
    const res = await call('GET', `/api/id-cards/students/${ids.studentId}`);
    assert.equal(res.status, 401);
  });
});

describe('teacher id card', () => {
  it('streams a staff card for the admin and for the teacher themselves', async () => {
    const byAdmin = await call('GET', `/api/id-cards/teachers/${ids.teacherId}`, { token: tokens.admin });
    assert.equal(byAdmin.status, 200);
    assert.ok(isPdf(byAdmin.body));

    const own = await call('GET', `/api/id-cards/teachers/${ids.teacherId}`, { token: tokens.teacher });
    assert.equal(own.status, 200);
    assert.ok(isPdf(own.body));
  });

  it('refuses a student asking for a staff card', async () => {
    const res = await call('GET', `/api/id-cards/teachers/${ids.teacherId}`, { token: tokens.student });
    assert.equal(res.status, 403);
  });
});
