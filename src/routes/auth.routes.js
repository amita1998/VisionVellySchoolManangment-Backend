import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { loginLimiter, refreshLimiter } from '../middleware/rateLimit.js';
import { changePasswordSchema, loginSchema } from '../validators/authValidators.js';

const router = Router();

router.post('/login', loginLimiter, validate(loginSchema), authController.login);
router.post('/refresh', refreshLimiter, authController.refresh);
router.post('/logout', authController.logout);

// Reachable while a password change is pending, otherwise the user is locked out of
// the very endpoint that clears the flag.
router.get('/me', authenticate({ allowPendingPasswordChange: true }), authController.me);
// Session listing is a normal feature: a pending password change must block it,
// otherwise the gate would be decorative.
router.get('/sessions', authenticate(), authController.sessions);
router.post(
  '/change-password',
  authenticate({ allowPendingPasswordChange: true }),
  validate(changePasswordSchema),
  authController.changePassword,
);

export default router;
