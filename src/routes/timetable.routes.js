import { Router } from 'express';
import * as timetable from '../controllers/timetableController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();
router.use(authenticate());

router.get('/periods', requirePermission(PERMISSIONS.TIMETABLE_VIEW), timetable.periods);
router.post('/periods', requirePermission(PERMISSIONS.TIMETABLE_MANAGE), timetable.createPeriod);
router.delete('/periods/:id', requirePermission(PERMISSIONS.TIMETABLE_MANAGE), timetable.deletePeriod);

router.get('/mine', requirePermission(PERMISSIONS.TIMETABLE_VIEW), timetable.myTimetable);
router.get('/sections/:sectionId', requirePermission(PERMISSIONS.TIMETABLE_VIEW), timetable.sectionTimetable);

router.post('/slots', requirePermission(PERMISSIONS.TIMETABLE_MANAGE), timetable.saveSlot);
router.delete('/slots/:id', requirePermission(PERMISSIONS.TIMETABLE_MANAGE), timetable.removeSlot);

export default router;
