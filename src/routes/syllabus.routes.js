import { Router } from 'express';
import * as syllabus from '../controllers/syllabusController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

router.get('/pairs', requirePermission(PERMISSIONS.SYLLABUS_VIEW), syllabus.pairs);
router.get('/chapters', requirePermission(PERMISSIONS.SYLLABUS_VIEW), syllabus.chapters);
router.post('/chapters', requirePermission(PERMISSIONS.SYLLABUS_MANAGE), syllabus.createChapter);
router.put('/chapters/:id', requirePermission(PERMISSIONS.SYLLABUS_MANAGE), syllabus.updateChapter);
router.delete('/chapters/:id', requirePermission(PERMISSIONS.SYLLABUS_MANAGE), syllabus.deleteChapter);

router.get('/portions', requirePermission(PERMISSIONS.SYLLABUS_VIEW), syllabus.portions);
router.put('/schedules/:scheduleId/portion', requirePermission(PERMISSIONS.SYLLABUS_MANAGE), syllabus.setPortion);

export default router;
