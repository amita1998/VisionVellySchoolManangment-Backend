import { Router } from 'express';
import { dashboard } from '../controllers/dashboardController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

// The permission guard documents intent and blocks a role whose matrix loses the
// ability later, independently of the role string.
router.get('/admin', requirePermission(PERMISSIONS.STUDENT_VIEW_ALL), dashboard('admin'));
router.get(
  '/teacher',
  requirePermission(PERMISSIONS.STUDENT_VIEW_ASSIGNED, PERMISSIONS.TEACHER_VIEW_OWN),
  dashboard('teacher'),
);
router.get('/student', requirePermission(PERMISSIONS.STUDENT_VIEW_OWN), dashboard('student'));
router.get('/parent', requirePermission(PERMISSIONS.STUDENT_VIEW_CHILDREN), dashboard('parent'));

export default router;
