import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

const ISSUER = 'vvs';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, typ: 'access' },
    config.auth.accessSecret,
    { expiresIn: config.auth.accessTtlSeconds, issuer: ISSUER },
  );
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.auth.accessSecret, { issuer: ISSUER });
  if (payload.typ !== 'access') throw new Error('Not an access token');
  return payload;
}

/** 48 random bytes, base64url. Only the sha256 hash is stored. */
export function createRefreshTokenValue() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashRefreshToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function newFamilyId() {
  return crypto.randomUUID();
}

export function refreshTtlMs(rememberMe) {
  const days = rememberMe ? config.auth.rememberMeTtlDays : config.auth.refreshTtlDays;
  return days * 24 * 60 * 60 * 1000;
}
