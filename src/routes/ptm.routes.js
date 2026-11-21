import { Router } from 'express';
import * as ptm from '../controllers/ptmController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

// Literal paths first, then parameterised ones.
router.get('/slots', requirePermission(PERMISSIONS.PTM_VIEW, PERMISSIONS.PTM_VIEW_OWN), ptm.slots);
router.get('/bookings', requirePermission(PERMISSIONS.PTM_VIEW, PERMISSIONS.PTM_VIEW_OWN, PERMISSIONS.PTM_BOOK), ptm.bookings);

router.post('/slots', requirePermission(PERMISSIONS.PTM_MANAGE), ptm.createSlot);
router.put('/slots/:id', requirePermission(PERMISSIONS.PTM_MANAGE), ptm.updateSlot);
router.delete('/slots/:id', requirePermission(PERMISSIONS.PTM_MANAGE), ptm.deleteSlot);

router.post('/slots/:slotId/book', requirePermission(PERMISSIONS.PTM_BOOK, PERMISSIONS.PTM_MANAGE), ptm.book);
router.post('/bookings/:id/decision', requirePermission(PERMISSIONS.PTM_MANAGE), ptm.decideBooking);
router.post('/bookings/:id/cancel', requirePermission(PERMISSIONS.PTM_BOOK, PERMISSIONS.PTM_MANAGE, PERMISSIONS.PTM_VIEW_OWN), ptm.cancelBooking);

export default router;
