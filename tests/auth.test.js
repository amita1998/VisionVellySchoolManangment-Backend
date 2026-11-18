import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAuthFixtures, TEST_PASSWORD, ACCOUNTS } from './support/fixtures.js';
import { roleHasPermission, PERMISSIONS } from '../src/config/permissions.js';

let server;
let base;
let ids;

function refreshCookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = cookies.find((entry) => entry.startsWith('vvs_rt='));
  if (!cookie) return null;
  return cookie.slice('vvs_rt='.length).split(';')[0];
}

async function call(method, path, { body, token, cookie } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = `vvs_rt=${cookie}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, refresh: refreshCookieFrom(res) };
}

function loginAs(key, overrides = {}) {
  const account = ACCOUNTS[key];
  return call('POST', '/api/auth/login', {
    body: {
      role: account.role,
      identifier: account.username,
      password: TEST_PASSWORD,
      rememberMe: false,
      ...overrides,
    },
  });
}

before(async () => {
  ids = await seedAuthFixtures();
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

describe('POST /api/auth/login', () => {
  it('signs in one account per role and returns a token, a role and permissions', async () => {
    for (const key of ['admin', 'teacher', 'student', 'parent']) {
      const res = await loginAs(key);
      assert.equal(res.status, 200, `${key} login status`);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.user.role, ACCOUNTS[key].role);
      assert.ok(res.body.data.accessToken, `${key} access token`);
      assert.ok(Array.isArray(res.body.data.permissions));
      assert.ok(res.body.data.permissions.length > 0, `${key} permissions`);
      assert.ok(res.refresh, `${key} refresh cookie`);
      assert.equal(res.body.data.refreshToken, undefined, 'refresh token never in the body');
    }
  });

  it('never returns a password hash', async () => {
    const res = await loginAs('admin');
    const serialised = JSON.stringify(res.body);
    assert.equal(serialised.includes('password_hash'), false);
    assert.equal(serialised.includes(TEST_PASSWORD), false);
  });

  it('gives the admin every permission and the student none of the admin ones', async () => {
    assert.equal(roleHasPermission('admin', PERMISSIONS.SETTINGS_MANAGE), true);
    assert.equal(roleHasPermission('student', PERMISSIONS.SETTINGS_MANAGE), false);
    // A student holds the 'own fees' permission so the route can reach the service,
    // where school_settings.fee_visible_to_students (default off) is the real gate.
    assert.equal(roleHasPermission('student', PERMISSIONS.FEE_VIEW_OWN), true);
    assert.equal(roleHasPermission('student', PERMISSIONS.FEE_MANAGE), false);
    assert.equal(roleHasPermission('student', PERMISSIONS.FEE_VIEW_ALL), false);
    assert.equal(roleHasPermission('parent', PERMISSIONS.FEE_VIEW_CHILDREN), true);
    assert.equal(roleHasPermission('teacher', PERMISSIONS.MARKS_OVERRIDE), false);
    assert.equal(roleHasPermission('teacher', PERMISSIONS.ATTENDANCE_MARK), true);
  });

  it('rejects a wrong password with a generic message', async () => {
    const res = await loginAs('teacher', { password: 'WrongPass@1' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(res.refresh, null);
  });

  it('rejects an unknown account without revealing that it does not exist', async () => {
    const res = await call('POST', '/api/auth/login', {
      body: { role: 'teacher', identifier: 'nobody@vvs.test', password: TEST_PASSWORD },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('refuses a correct password used with the wrong role', async () => {
    const res = await loginAs('teacher', { role: 'admin' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ROLE_MISMATCH');
  });

  it('signs in with credentials only and reports the account\'s own role', async () => {
    for (const account of Object.values(ACCOUNTS)) {
      const res = await call('POST', '/api/auth/login', {
        body: { identifier: account.username, password: TEST_PASSWORD, rememberMe: false },
      });
      assert.equal(res.status, 200, `${account.username} should sign in without a role`);
      assert.equal(res.body.data.user.role, account.role);
      assert.equal(res.body.data.user.username, account.username);
      assert.ok(res.body.data.accessToken);
      assert.ok(res.refresh, 'a refresh cookie is still issued');
    }
  });

  it('signs in without a role by email as well as by username', async () => {
    const account = ACCOUNTS.parent;
    const res = await call('POST', '/api/auth/login', {
      body: { identifier: account.email, password: TEST_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.username, account.username);
  });

  it('rejects a wrong password without a role, without leaking the account', async () => {
    const res = await call('POST', '/api/auth/login', {
      body: { identifier: ACCOUNTS.student.username, password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('validates the request body field by field', async () => {
    const res = await call('POST', '/api/auth/login', { body: { role: 'nope', identifier: '' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.fields.role);
    assert.ok(res.body.error.fields.identifier);
    assert.ok(res.body.error.fields.password);
  });

  it('locks an account for 15 minutes after 5 failed attempts', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await loginAs('lockable', { password: `Wrong${attempt}@x` });
      assert.equal(res.status, 401, `attempt ${attempt}`);
    }
    const locked = await loginAs('lockable');
    assert.equal(locked.status, 423);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');

    const { rows } = await pool.query(
      'SELECT failed_login_attempts, locked_until FROM users WHERE id = $1',
      [ids.lockable],
    );
    assert.equal(rows[0].failed_login_attempts, 5);
    const minutes = (new Date(rows[0].locked_until).getTime() - Date.now()) / 60000;
    assert.ok(minutes > 13 && minutes <= 15, `lock window ~15 min, got ${minutes.toFixed(1)}`);
  });
});

describe('authenticated endpoints', () => {
  it('rejects a missing or bogus token', async () => {
    const anon = await call('GET', '/api/auth/me');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'UNAUTHENTICATED');

    const bogus = await call('GET', '/api/auth/me', { token: 'not-a-jwt' });
    assert.equal(bogus.status, 401);
    assert.equal(bogus.body.error.code, 'INVALID_TOKEN');
  });

  it('returns the signed-in user from /me', async () => {
    const login = await loginAs('parent');
    const me = await call('GET', '/api/auth/me', { token: login.body.data.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.username, ACCOUNTS.parent.username);
    assert.equal(me.body.data.user.role, 'parent');
  });

  it('blocks every endpoint except the password change while a change is pending', async () => {
    await pool.query('UPDATE users SET must_change_password = TRUE WHERE id = $1', [ids.gate]);
    const login = await loginAs('gate');
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.mustChangePassword, true);
    const token = login.body.data.accessToken;

    const me = await call('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200, '/me stays reachable');

    const sessions = await call('GET', '/api/auth/sessions', { token });
    assert.equal(sessions.status, 403);
    assert.equal(sessions.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

    const changed = await call('POST', '/api/auth/change-password', {
      token,
      cookie: login.refresh,
      body: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'Gate@Pass2026',
        confirmPassword: 'Gate@Pass2026',
      },
    });
    assert.equal(changed.status, 200);

    const after = await call('GET', '/api/auth/sessions', { token });
    assert.equal(after.status, 200, 'flag cleared after the change');
  });
});

describe('refresh token rotation', () => {
  it('rotates on every refresh and detects replay of the old token', async () => {
    const login = await loginAs('student');
    const first = login.refresh;

    const rotated = await call('POST', '/api/auth/refresh', { cookie: first });
    assert.equal(rotated.status, 200);
    assert.ok(rotated.refresh);
    assert.notEqual(rotated.refresh, first, 'a new refresh token was issued');

    // Replaying the consumed token must destroy the whole family.
    const replay = await call('POST', '/api/auth/refresh', { cookie: first });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'SESSION_REVOKED');

    const afterReplay = await call('POST', '/api/auth/refresh', { cookie: rotated.refresh });
    assert.equal(afterReplay.status, 401, 'the rotated token died with the family');
  });

  it('refuses an unknown refresh cookie', async () => {
    const res = await call('POST', '/api/auth/refresh', { cookie: 'made-up-token' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'SESSION_EXPIRED');
  });

  it('revokes the session on logout', async () => {
    const login = await loginAs('teacher');
    const out = await call('POST', '/api/auth/logout', {
      token: login.body.data.accessToken,
      cookie: login.refresh,
    });
    assert.equal(out.status, 200);

    const reuse = await call('POST', '/api/auth/refresh', { cookie: login.refresh });
    assert.equal(reuse.status, 401);
  });
});

describe('POST /api/auth/change-password', () => {
  it('rejects a wrong current password, then accepts a valid new one', async () => {
    const login = await loginAs('changer');
    const token = login.body.data.accessToken;

    const wrong = await call('POST', '/api/auth/change-password', {
      token,
      cookie: login.refresh,
      body: {
        currentPassword: 'NotMyPassword1',
        newPassword: 'Brand@New2026',
        confirmPassword: 'Brand@New2026',
      },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'CURRENT_PASSWORD_INCORRECT');

    const weak = await call('POST', '/api/auth/change-password', {
      token,
      cookie: login.refresh,
      body: { currentPassword: TEST_PASSWORD, newPassword: 'abc', confirmPassword: 'abc' },
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'VALIDATION_ERROR');

    const ok = await call('POST', '/api/auth/change-password', {
      token,
      cookie: login.refresh,
      body: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'Brand@New2026',
        confirmPassword: 'Brand@New2026',
      },
    });
    assert.equal(ok.status, 200);

    const oldLogin = await loginAs('changer');
    assert.equal(oldLogin.status, 401, 'old password no longer works');

    const newLogin = await loginAs('changer', { password: 'Brand@New2026' });
    assert.equal(newLogin.status, 200, 'new password works');
  });
});

describe('audit trail', () => {
  it('records successful and failed sign-ins', async () => {
    const { rows } = await pool.query(
      `SELECT action, count(*)::int AS total FROM audit_logs
        WHERE action LIKE 'auth.%' GROUP BY action ORDER BY action`,
    );
    const byAction = Object.fromEntries(rows.map((row) => [row.action, row.total]));
    assert.ok(byAction['auth.login'] > 0, 'auth.login written');
    assert.ok(byAction['auth.login_failed'] > 0, 'auth.login_failed written');
    assert.ok(byAction['auth.login_locked_out'] > 0, 'auth.login_locked_out written');
    assert.ok(byAction['auth.password_changed'] > 0, 'auth.password_changed written');
  });

  it('cannot be edited once written', async () => {
    await assert.rejects(
      () => pool.query("UPDATE audit_logs SET reason = 'tamper' WHERE id = (SELECT min(id) FROM audit_logs)"),
      /append-only/,
    );
  });
});
