import { config } from '../config/env.js';
import * as authService from '../services/authService.js';
import { asyncHandler } from '../utils/errors.js';

export const REFRESH_COOKIE = 'vvs_rt';

function cookieOptions(rememberMe, expiresAt) {
  const options = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.auth.cookieSameSite,
    path: '/api/auth',
  };
  // Remember me = persistent cookie; otherwise it dies with the browser session.
  if (rememberMe && expiresAt) options.expires = new Date(expiresAt);
  return options;
}

function setRefreshCookie(res, payload) {
  res.cookie(
    REFRESH_COOKIE,
    payload.refreshToken,
    cookieOptions(payload.rememberMe, payload.refreshExpiresAt),
  );
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    path: '/api/auth',
    secure: config.isProduction,
    sameSite: config.auth.cookieSameSite,
  });
}

function requestMeta(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login({
    ...req.body,
    ...requestMeta(req),
  });
  setRefreshCookie(res, result);
  const { refreshToken, refreshExpiresAt, ...body } = result;
  res.json({ success: true, data: body });
});

export const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh({
    token: req.cookies?.[REFRESH_COOKIE],
    ...requestMeta(req),
  });
  setRefreshCookie(res, result);
  const { refreshToken, refreshExpiresAt, ...body } = result;
  res.json({ success: true, data: body });
});

export const logout = asyncHandler(async (req, res) => {
  const result = await authService.logout({
    token: req.cookies?.[REFRESH_COOKIE],
    userId: req.user?.id,
    ...requestMeta(req),
  });
  clearRefreshCookie(res);
  res.json({ success: true, data: result });
});

export const me = asyncHandler(async (req, res) => {
  const data = await authService.me(req.user.id);
  res.json({ success: true, data });
});

export const sessions = asyncHandler(async (req, res) => {
  const data = await authService.listSessions(req.user.id);
  res.json({ success: true, data: { sessions: data } });
});

export const changePassword = asyncHandler(async (req, res) => {
  const result = await authService.changePassword({
    userId: req.user.id,
    currentPassword: req.body.currentPassword,
    newPassword: req.body.newPassword,
    keepToken: req.cookies?.[REFRESH_COOKIE],
    ...requestMeta(req),
  });
  res.json({ success: true, data: result });
});

export default { login, refresh, logout, me, sessions, changePassword };
