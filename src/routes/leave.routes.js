import { Router } from 'express';
import * as leave from '../controllers/leaveController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();
router.use(authenticate());

router.get('/types', leave.types);
router.get('/requests', requirePermission(PERMISSIONS.LEAVE_VIEW_OWN, PERMISSIONS.LEAVE_VIEW_CHILDREN, PERMISSIONS.LEAVE_VIEW_ALL), leave.requests);
router.get('/balance', requirePermission(PERMISSIONS.LEAVE_VIEW_OWN, PERMISSIONS.LEAVE_VIEW_CHILDREN, PERMISSIONS.LEAVE_VIEW_ALL), leave.balance);

router.post('/requests', requirePermission(PERMISSIONS.LEAVE_APPLY, PERMISSIONS.LEAVE_MANAGE), leave.apply);
router.post('/requests/:id/decide', requirePermission(PERMISSIONS.LEAVE_APPROVE), leave.decide);
router.post('/requests/:id/cancel', leave.cancel);

export default router;
