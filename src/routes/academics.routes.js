import { Router } from 'express';
import * as academics from '../controllers/academicsController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

// Read-only lookups are open to every signed-in role (they all hold academic.view).
router.get('/options', requirePermission(PERMISSIONS.ACADEMIC_VIEW), academics.options);
router.get('/settings', academics.settings);
router.get('/classes', requirePermission(PERMISSIONS.ACADEMIC_VIEW), academics.classes);
router.get('/subjects', requirePermission(PERMISSIONS.ACADEMIC_VIEW), academics.subjects);
router.get('/years', requirePermission(PERMISSIONS.ACADEMIC_VIEW), academics.years);
router.get('/classes/:id/subjects', requirePermission(PERMISSIONS.ACADEMIC_VIEW), academics.classSubjects);

// Mutations are admin-only.
router.post('/classes', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.createClass);
router.put('/classes/:id', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.updateClass);
router.delete('/classes/:id', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.deleteClass);
router.put('/classes/:id/subjects', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.setClassSubjects);

router.post('/classes/:classId/sections', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.createSection);
router.put('/sections/:id', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.updateSection);
router.delete('/sections/:id', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.deleteSection);

router.post('/subjects', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.createSubject);
router.put('/subjects/:id', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.updateSubject);
router.delete('/subjects/:id', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.deleteSubject);

router.post('/years', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.createYear);
router.post('/years/:id/current', requirePermission(PERMISSIONS.ACADEMIC_MANAGE), academics.setCurrentYear);

export default router;
