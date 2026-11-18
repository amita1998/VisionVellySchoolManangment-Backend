import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';

/**
 * Brute-force protection at the network level. The per-account lockout in
 * authService is the authoritative control; this stops one host from spraying
 * many accounts. Successful logins do not count towards the limit.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many sign-in attempts from this network. Please wait 15 minutes.',
      },
    });
  },
});

export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

export default { loginLimiter, refreshLimiter };
