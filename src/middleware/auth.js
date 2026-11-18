import { asyncHandler, forbidden, unauthorized } from '../utils/errors.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { findById } from '../models/userModel.js';
import { roleHasPermission } from '../config/permissions.js';

/**
 * Verifies the bearer access token and loads the user fresh from the database on
 * every request. A role change, deactivation or deletion therefore takes effect
 * immediately instead of when the token expires.
 *
 * Access tokens live in memory on the client and travel in the Authorization
 * header (never a cookie), so state-changing requests are not CSRF-able.
 */
export function authenticate({ allowPendingPasswordChange = false } = {}) {
  return asyncHandler(async (req, _res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw unauthorized('Please sign in to continue.', 'UNAUTHENTICATED');
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      const expired = error.name === 'TokenExpiredError';
      throw unauthorized(
        expired ? 'Your session has expired.' : 'Please sign in again.',
        expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      );
    }

    const user = await findById(payload.sub);
    if (!user || !user.is_active || user.deleted_at) {
      throw unauthorized('This account is no longer active.', 'ACCOUNT_DISABLED');
    }

    req.user = {
      id: user.id,
      role: user.role,
      username: user.username,
      email: user.email,
      mustChangePassword: user.must_change_password,
    };

    if (user.must_change_password && !allowPendingPasswordChange) {
      throw forbidden(
        'You must set a new password before using the system.',
        'PASSWORD_CHANGE_REQUIRED',
      );
    }

    next();
  });
}

/** Any-of permissions (all four roles are covered by one matrix). */
export function requirePermission(...permissions) {
  return function checkingPermission(req, _res, next) {
    if (!req.user) return next(unauthorized());
    const allowed = permissions.some((permission) => roleHasPermission(req.user.role, permission));
    if (!allowed) {
      return next(
        forbidden('Your role does not have access to this feature.', 'PERMISSION_DENIED'),
      );
    }
    return next();
  };
}

export function requireRole(...roles) {
  return function checkingRole(req, _res, next) {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden('Your role does not have access to this page.', 'ROLE_FORBIDDEN'));
    }
    return next();
  };
}

export default { authenticate, requirePermission, requireRole };
