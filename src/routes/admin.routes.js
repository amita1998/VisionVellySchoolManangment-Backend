import { Router } from 'express';
import * as admin from '../controllers/adminController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();
router.use(authenticate());

router.get('/settings', requirePermission(PERMISSIONS.SETTINGS_MANAGE), admin.getSettings);
router.put('/settings', requirePermission(PERMISSIONS.SETTINGS_MANAGE), admin.updateSettings);
router.get('/audit', requirePermission(PERMISSIONS.AUDIT_VIEW), admin.auditLogs);

router.get('/reports/students', requirePermission(PERMISSIONS.REPORT_VIEW_ALL), admin.report('students'));
router.get('/reports/attendance', requirePermission(PERMISSIONS.REPORT_VIEW_ALL, PERMISSIONS.REPORT_VIEW_CLASS), admin.report('attendance'));
router.get('/reports/results', requirePermission(PERMISSIONS.REPORT_VIEW_ALL, PERMISSIONS.REPORT_VIEW_CLASS), admin.report('results'));
router.get('/reports/fees', requirePermission(PERMISSIONS.REPORT_VIEW_ALL), admin.report('fees'));

export default router;
