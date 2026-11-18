import { Router } from 'express';
import * as attendance from '../controllers/attendanceController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

// Literal paths first, then parameterised ones.
router.get('/sections', requirePermission(PERMISSIONS.ATTENDANCE_MARK), attendance.sections);
router.get('/sheet', attendance.sheet);
router.get('/corrections', requirePermission(PERMISSIONS.ATTENDANCE_CORRECTION_REQUEST, PERMISSIONS.ATTENDANCE_CORRECTION_REVIEW), attendance.corrections);
router.get('/summary/:studentId', attendance.summary);

router.post('/mark', requirePermission(PERMISSIONS.ATTENDANCE_MARK), attendance.mark);
router.post('/corrections', requirePermission(PERMISSIONS.ATTENDANCE_CORRECTION_REQUEST), attendance.requestCorrection);
router.post('/corrections/:id/review', requirePermission(PERMISSIONS.ATTENDANCE_CORRECTION_REVIEW), attendance.review);

router.get('/', attendance.list);

export default router;
