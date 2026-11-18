import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import * as userModel from '../models/userModel.js';
import { permissionsFor } from '../config/permissions.js';
import { AppError, forbidden, unauthorized } from '../utils/errors.js';
import {
  createRefreshTokenValue,
  hashRefreshToken,
  newFamilyId,
  refreshTtlMs,
  signAccessToken,
} from '../utils/tokens.js';
import { audit } from './auditService.js';

/**
 * A bcrypt comparison against a fixed hash keeps "unknown user" and "wrong password"
 * at the same latency, so the endpoint does not leak which accounts exist.
 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function publicSession(user) {
  return {
    user: userModel.toPublicUser(user),
    permissions: permissionsFor(user.role),
  };
}

async function issueRefreshToken({ userId, familyId, rememberMe, ip, userAgent }) {
  const value = createRefreshTokenValue();
  const expiresAt = new Date(Date.now() + refreshTtlMs(rememberMe));
  const { rows } = await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, remember_me, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, expires_at`,
    [userId, hashRefreshToken(value), familyId, rememberMe, userAgent?.slice(0, 400) ?? null, ip, expiresAt],
  );
  return { value, id: rows[0].id, expiresAt: rows[0].expires_at };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login({ role, identifier, password, rememberMe, ip, userAgent }) {
  const user = await userModel.findByIdentifier(identifier.trim());

  // Locked accounts are rejected before the password is even compared.
  if (user?.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000),
    );
    await audit({
      action: 'auth.login_blocked_locked',
      entityType: 'users',
      entityId: user.id,
      ip,
      userAgent,
      reason: 'account locked',
    });
    throw new AppError(
      423,
      'ACCOUNT_LOCKED',
      `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
      undefined,
      retryAfterSeconds,
    );
  }

  const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);

  if (!user || !passwordMatches) {
    if (user) {
      const state = await userModel.registerFailedAttempt(
        user.id,
        config.auth.maxLoginAttempts,
        config.auth.lockoutMinutes,
      );
      await audit({
        actorUserId: user.id,
        actorRole: user.role,
        action: state.locked_until && new Date(state.locked_until) > new Date()
          ? 'auth.login_locked_out'
          : 'auth.login_failed',
        entityType: 'users',
        entityId: user.id,
        newValues: { attempts: state.failed_login_attempts },
        ip,
        userAgent,
      });
    }
    throw unauthorized('Invalid credentials. Please check and try again.', 'INVALID_CREDENTIALS');
  }

  if (!user.is_active || user.deleted_at) {
    throw forbidden('This account has been deactivated. Please contact the school office.', 'ACCOUNT_DISABLED');
  }

  // Password was correct. If the client still sends a role and it is the wrong one,
  // say so plainly; a credential-only sign-in (no role) simply continues with the
  // account's own role.
  if (role && user.role !== role) {
    await audit({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'auth.login_role_mismatch',
      entityType: 'users',
      entityId: user.id,
      newValues: { selectedRole: role, actualRole: user.role },
      ip,
      userAgent,
    });
    throw forbidden(
      `This account is registered as a ${user.role}, not as ${role === 'admin' ? 'an admin' : `a ${role}`}. Select the correct role and try again.`,
      'ROLE_MISMATCH',
    );
  }

  await userModel.registerSuccessfulLogin(user.id);
  const familyId = newFamilyId();
  const refresh = await issueRefreshToken({ userId: user.id, familyId, rememberMe, ip, userAgent });

  await audit({
    actorUserId: user.id,
    actorRole: user.role,
    action: 'auth.login',
    entityType: 'users',
    entityId: user.id,
    // `role` is what the account resolved to, which is the whole point of role-free sign-in.
    newValues: { rememberMe: Boolean(rememberMe), role: user.role, roleSupplied: Boolean(role) },
    ip,
    userAgent,
  });

  return {
    ...publicSession(user),
    accessToken: signAccessToken(user),
    refreshToken: refresh.value,
    refreshExpiresAt: refresh.expiresAt,
    rememberMe: Boolean(rememberMe),
  };
}

// ---------------------------------------------------------------------------
// Refresh (rotation + reuse detection)
// ---------------------------------------------------------------------------

export async function refresh({ token, ip, userAgent }) {
  if (!token) throw unauthorized('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  const tokenHash = hashRefreshToken(token);

  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, family_id, remember_me, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    const stored = rows[0];
    if (!stored) return { kind: 'unknown' };

    if (stored.revoked_at) {
      // A rotated token came back: someone has a copy. Kill the whole family.
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'reuse_detected'
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [stored.family_id],
      );
      return { kind: 'reuse', userId: stored.user_id, familyId: stored.family_id };
    }

    if (new Date(stored.expires_at).getTime() <= Date.now()) return { kind: 'expired', userId: stored.user_id };

    const userResult = await client.query(
      `SELECT u.id, u.username, u.email, u.must_change_password, u.is_active, u.deleted_at, r.code AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [stored.user_id],
    );
    const user = userResult.rows[0];
    if (!user || !user.is_active || user.deleted_at) return { kind: 'disabled', userId: stored.user_id };

    const value = createRefreshTokenValue();
    const expiresAt = new Date(Date.now() + refreshTtlMs(stored.remember_me));
    const inserted = await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, remember_me, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [user.id, hashRefreshToken(value), stored.family_id, stored.remember_me, userAgent?.slice(0, 400) ?? null, ip, expiresAt],
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated', replaced_by_token_id = $2
        WHERE id = $1`,
      [stored.id, inserted.rows[0].id],
    );

    return {
      kind: 'rotated',
      user,
      refreshToken: value,
      refreshExpiresAt: expiresAt,
      rememberMe: stored.remember_me,
    };
  });

  if (outcome.kind === 'unknown') {
    throw unauthorized('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  }
  if (outcome.kind === 'reuse') {
    await audit({
      actorUserId: outcome.userId,
      action: 'auth.refresh_reuse_detected',
      entityType: 'refresh_tokens',
      ip,
      userAgent,
      reason: 'refresh token replay',
    });
    throw unauthorized('Your session was ended for security reasons. Please sign in again.', 'SESSION_REVOKED');
  }
  if (outcome.kind === 'expired') {
    throw unauthorized('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  }
  if (outcome.kind === 'disabled') {
    throw forbidden('This account has been deactivated.', 'ACCOUNT_DISABLED');
  }

  return {
    ...publicSession(outcome.user),
    accessToken: signAccessToken(outcome.user),
    refreshToken: outcome.refreshToken,
    refreshExpiresAt: outcome.refreshExpiresAt,
    rememberMe: outcome.rememberMe,
  };
}

// ---------------------------------------------------------------------------
// Logout / sessions
// ---------------------------------------------------------------------------

export async function logout({ token, userId, ip, userAgent }) {
  if (token) {
    const { rows } = await query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING family_id, user_id`,
      [hashRefreshToken(token)],
    );
    if (rows[0]) {
      await audit({
        actorUserId: rows[0].user_id,
        action: 'auth.logout',
        entityType: 'refresh_tokens',
        ip,
        userAgent,
      });
    }
  } else if (userId) {
    await query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
  return { signedOut: true };
}

export async function listSessions(userId) {
  const { rows } = await query(
    `SELECT family_id,
            min(issued_at) FILTER (WHERE revoked_reason IS DISTINCT FROM 'rotated') AS started_at,
            max(expires_at) AS expires_at,
            max(user_agent) AS user_agent,
            host(max(ip)) AS ip,
            bool_or(revoked_at IS NULL) AS active
       FROM refresh_tokens
      WHERE user_id = $1
      GROUP BY family_id
      ORDER BY max(issued_at) DESC
      LIMIT 25`,
    [userId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

export async function changePassword({ userId, currentPassword, newPassword, keepToken, ip, userAgent }) {
  const user = await userModel.findById(userId);
  if (!user) throw unauthorized();

  const matches = await bcrypt.compare(currentPassword, user.password_hash);
  if (!matches) {
    throw new AppError(400, 'CURRENT_PASSWORD_INCORRECT', 'Your current password is incorrect.', {
      currentPassword: 'Incorrect password',
    });
  }
  const reused = await bcrypt.compare(newPassword, user.password_hash);
  if (reused) {
    throw new AppError(400, 'PASSWORD_REUSED', 'The new password must be different from the current one.', {
      newPassword: 'Choose a password you have not used here before',
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, config.auth.bcryptRounds);
  await userModel.setPassword(userId, passwordHash);

  // Sign out every other device; keep the session that performed the change.
  const keepHash = keepToken ? hashRefreshToken(keepToken) : null;
  await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_changed'
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)`,
    [userId, keepHash],
  );

  await audit({
    actorUserId: userId,
    actorRole: user.role,
    action: 'auth.password_changed',
    entityType: 'users',
    entityId: userId,
    ip,
    userAgent,
  });

  return { changed: true };
}

export async function me(userId) {
  const user = await userModel.findById(userId);
  if (!user) throw unauthorized();
  return publicSession(user);
}

export default { login, refresh, logout, listSessions, changePassword, me };
