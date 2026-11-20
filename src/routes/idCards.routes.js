import { Router } from 'express';
import * as cards from '../controllers/idCardController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate());

/**
 * No permission code: who may print which card is decided per record in the service
 * (admin any, a student their own, a parent a child of theirs, a teacher a student they teach).
 */
router.get('/students/:id', cards.student);
router.get('/teachers/:id', cards.teacher);

export default router;
