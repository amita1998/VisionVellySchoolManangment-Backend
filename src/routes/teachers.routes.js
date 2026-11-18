import { Router } from 'express';
import * as teachers from '../controllers/teacherController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

router.get('/', requirePermission(PERMISSIONS.TEACHER_VIEW_ALL), teachers.list);
router.post('/', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.create);

// Literal before parameterised: `/me` must not be parsed as an id.
router.get('/me', teachers.me);

router.get('/:id', teachers.detail);
router.put('/:id', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.update);
router.post('/:id/status', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.changeStatus);
router.put('/:id/assignments', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.setAssignments);
router.post('/:id/class-teacher', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.assignClassTeacher);
router.delete('/:id/class-teacher', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.clearClassTeacher);
router.post('/:id/reset-password', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.resetPassword);
router.delete('/:id', requirePermission(PERMISSIONS.TEACHER_MANAGE), teachers.remove);

export default router;
