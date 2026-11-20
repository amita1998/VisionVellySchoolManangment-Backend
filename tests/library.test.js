import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Library: catalogue, circulation rules and the per-role view.
 *
 * The rules that matter to a school:
 *   - a copy cannot be lent twice; the counter must match the register
 *   - the same member cannot hold two copies of one title
 *   - the fine is overdue days × the setting, frozen on the loan
 *   - students see their own loans only, parents one child at a time, teachers their own
 */

let server;
let base;
let ids;
let tokens = {};

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

async function login(identifier, password = TEST_PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
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
  tokens.admin = await login(ACCOUNTS.admin.username);
  tokens.teacher = await login(ACCOUNTS.teacher.username);
  tokens.student = await login(ACCOUNTS.student.username);
  tokens.parent = await login(ACCOUNTS.parent.username);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('catalogue', () => {
  it('lets the admin add a book and refuses a duplicate ISBN', async () => {
    const created = await call('POST', '/api/library/books', {
      token: tokens.admin,
      body: { title: 'Wings of Fire', author: 'A. P. J. Abdul Kalam', isbn: '9788173711466', category: 'Biography', totalCopies: 3 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.book.total_copies, 3);
    assert.equal(created.body.data.book.available_copies, 3);
    ids.books = { wings: created.body.data.book.id };

    const duplicate = await call('POST', '/api/library/books', {
      token: tokens.admin,
      body: { title: 'Wings of Fire (copy)', isbn: '9788173711466' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'BOOK_EXISTS');
  });

  it('shows the catalogue to students but refuses them the register', async () => {
    const list = await call('GET', '/api/library/books?search=wings', { token: tokens.student });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.rows.length, 1);

    const denied = await call('GET', '/api/library/issues', { token: tokens.student });
    assert.equal(denied.status, 403);

    const write = await call('POST', '/api/library/books', {
      token: tokens.student,
      body: { title: 'Nope' },
    });
    assert.equal(write.status, 403);
  });
});

describe('circulation', () => {
  it('issues a copy, blocks a second copy to the same member, and returns it', async () => {
    const issue = await call('POST', '/api/library/issues', {
      token: tokens.admin,
      body: { bookId: ids.books.wings, studentId: ids.studentId, loanDays: 14 },
    });
    assert.equal(issue.status, 201);
    ids.loan = issue.body.data.issue.id;

    const available = await call('GET', '/api/library/books?search=wings', { token: tokens.admin });
    assert.equal(available.body.data.rows[0].available_copies, 2);
    assert.equal(available.body.data.rows[0].on_loan, 1);

    const again = await call('POST', '/api/library/issues', {
      token: tokens.admin,
      body: { bookId: ids.books.wings, studentId: ids.studentId },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_ISSUED');

    const returned = await call('POST', `/api/library/issues/${ids.loan}/return`, {
      token: tokens.admin,
      body: {},
    });
    assert.equal(returned.status, 200);
    assert.equal(Number(returned.body.data.issue.fine_amount), 0, 'returned on the due date is free');

    const back = await call('GET', '/api/library/books?search=wings', { token: tokens.admin });
    assert.equal(back.body.data.rows[0].available_copies, 3);

    const twice = await call('POST', `/api/library/issues/${ids.loan}/return`, { token: tokens.admin, body: {} });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'LOAN_CLOSED');
  });

  it('charges the fine per overdue day and freezes the amount', async () => {
    const issue = await call('POST', '/api/library/issues', {
      token: tokens.admin,
      body: { bookId: ids.books.wings, studentId: ids.studentId, loanDays: 14 },
    });
    const loanId = issue.body.data.issue.id;

    // Move the due date three days into the past: the fine must follow the clock, not a guess.
    // Issued 17 days ago, due 3 days ago: a real overdue loan, and `due_on >= issued_on` still holds.
    await pool.query(
      `UPDATE library_issues
          SET issued_on = ((now() AT TIME ZONE 'Asia/Kolkata')::date - 17),
              due_on    = ((now() AT TIME ZONE 'Asia/Kolkata')::date - 3)
        WHERE id = $1`,
      [loanId],
    );

    const returned = await call('POST', `/api/library/issues/${loanId}/return`, {
      token: tokens.admin,
      body: { finePaid: false },
    });
    assert.equal(returned.status, 200);
    assert.equal(Number(returned.body.data.issue.fine_amount), 6, '3 overdue days × ₹2');

    // Editing the school rate afterwards must not rewrite history.
    await pool.query('UPDATE school_settings SET library_fine_per_day = 5 WHERE id = 1');
    const readBack = await pool.query('SELECT fine_amount FROM library_issues WHERE id = $1', [loanId]);
    assert.equal(Number(readBack.rows[0].fine_amount), 6);
    await pool.query('UPDATE school_settings SET library_fine_per_day = 2 WHERE id = 1');
  });

  it('refuses a loan when every copy is out, and when no member is chosen', async () => {
    const created = await call('POST', '/api/library/books', {
      token: tokens.admin,
      body: { title: 'Single Copy', totalCopies: 1 },
    });
    const bookId = created.body.data.book.id;

    const first = await call('POST', '/api/library/issues', {
      token: tokens.admin,
      body: { bookId, studentId: ids.studentId },
    });
    assert.equal(first.status, 201);

    const second = await call('POST', '/api/library/issues', {
      token: tokens.admin,
      body: { bookId, studentId: ids.otherStudentId },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'NO_COPIES_LEFT');

    const noMember = await call('POST', '/api/library/issues', {
      token: tokens.admin,
      body: { bookId },
    });
    assert.equal(noMember.status, 400);
  });

  it('never lets the shelf count go below what is on loan', async () => {
    const list = await call('GET', '/api/library/books?search=single', { token: tokens.admin });
    const book = list.body.data.rows[0];

    const shrink = await call('PUT', `/api/library/books/${book.id}`, {
      token: tokens.admin,
      body: { totalCopies: 0 },
    });
    // 0 copies fails the schema minimum; one copy is refused by the service while it is on loan
    assert.equal(shrink.status, 400);

    const one = await call('PUT', `/api/library/books/${book.id}`, {
      token: tokens.admin,
      body: { totalCopies: 1 },
    });
    assert.equal(one.status, 200);
    assert.equal(one.body.data.book.available_copies, 0);
  });
});

describe('per-role view', () => {
  it('gives the student their own loans and nobody else’s', async () => {
    const mine = await call('GET', '/api/library/me', { token: tokens.student });
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.rows.length >= 1);
    assert.ok(mine.body.data.rows.every((row) => row.title));

    const teacherMine = await call('GET', '/api/library/me', { token: tokens.teacher });
    assert.equal(teacherMine.status, 200);
    assert.equal(teacherMine.body.data.rows.length, 0, 'the teacher has not borrowed anything');
  });

  it('gives the parent one child at a time and refuses someone else’s child', async () => {
    const mine = await call('GET', '/api/library/me', { token: tokens.parent });
    assert.equal(mine.status, 200);

    const theirChild = await call('GET', `/api/library/me?childId=${ids.otherStudentId}`, { token: tokens.parent });
    assert.equal(theirChild.status, 403);
    assert.equal(theirChild.body.error.code, 'CHILD_NOT_FOUND');
  });
});
