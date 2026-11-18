import { Router } from 'express';
import * as exams from '../controllers/examController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();
router.use(authenticate());

const canManage = requirePermission(PERMISSIONS.EXAM_MANAGE);
const canEnterMarks = requirePermission(PERMISSIONS.MARKS_ENTER);
const canOverride = requirePermission(PERMISSIONS.MARKS_OVERRIDE);
const canViewResults = requirePermission(
  PERMISSIONS.RESULT_VIEW_ALL,
  PERMISSIONS.RESULT_VIEW_ASSIGNED,
  PERMISSIONS.RESULT_VIEW_OWN,
  PERMISSIONS.RESULT_VIEW_CHILDREN,
);

// exams — literal paths before '/:id'
router.get('/mine', requirePermission(PERMISSIONS.MARKS_ENTER), exams.mine);
router.get('/', requirePermission(PERMISSIONS.EXAM_VIEW), exams.list);
router.post('/', canManage, exams.create);
router.get('/:id', requirePermission(PERMISSIONS.EXAM_VIEW), exams.detail);
router.post('/:id/publish', canManage, exams.publish);
router.post('/:id/schedules', canManage, exams.addSchedule);
router.delete('/:id/schedules/:scheduleId', canManage, exams.removeSchedule);

// marks live under their own prefix
router.get('/marks/:scheduleId', canEnterMarks, exams.marksSheet);
router.put('/marks/:scheduleId', canEnterMarks, exams.saveMarks);
router.post('/marks/:scheduleId/unlock', canOverride, exams.unlock);
router.post('/marks/:scheduleId/override', canOverride, exams.override);

// results
router.get('/results/student/:studentId/exams', canViewResults, exams.publishedExams);
router.get('/results/student/:studentId', canViewResults, exams.reportCard);
router.get('/results/class/:classId/exam/:examId', requirePermission(PERMISSIONS.RESULT_VIEW_ALL, PERMISSIONS.RESULT_VIEW_ASSIGNED), exams.classResults);

export default router;
