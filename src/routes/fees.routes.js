import { Router } from 'express';
import * as fees from '../controllers/feeController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();
router.use(authenticate());

const manage = requirePermission(PERMISSIONS.FEE_MANAGE);
const canView = requirePermission(
  PERMISSIONS.FEE_MANAGE,
  PERMISSIONS.FEE_VIEW_ALL,
  PERMISSIONS.FEE_VIEW_CHILDREN,
);
// A student reaches only their own summary, and only when the school enables it.
const canViewOwn = requirePermission(
  PERMISSIONS.FEE_MANAGE,
  PERMISSIONS.FEE_VIEW_ALL,
  PERMISSIONS.FEE_VIEW_CHILDREN,
  PERMISSIONS.FEE_VIEW_OWN,
);

router.get('/categories', canView, fees.categories);
router.post('/categories', manage, fees.createCategory);
router.get('/structures', canView, fees.structures);
router.post('/structures', manage, fees.createStructure);
router.delete('/structures/:id', manage, fees.deleteStructure);
router.post('/assign', manage, fees.assign);
router.get('/overview', manage, fees.overview);
router.get('/payments', manage, fees.payments);
router.post('/payments', manage, fees.recordPayment);
router.post('/payments/:id/reverse', manage, fees.reverse);
router.get('/summary/:studentId', canViewOwn, fees.summary);

export default router;
