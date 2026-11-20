import { Router } from 'express';
import * as library from '../controllers/libraryController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

// Literal paths first, then parameterised ones.
router.get('/books', requirePermission(PERMISSIONS.LIBRARY_VIEW), library.books);
router.get('/issues', requirePermission(PERMISSIONS.LIBRARY_MANAGE), library.issues);
router.get('/me', requirePermission(PERMISSIONS.LIBRARY_VIEW_OWN, PERMISSIONS.LIBRARY_VIEW_CHILDREN), library.mine);

router.post('/books', requirePermission(PERMISSIONS.LIBRARY_MANAGE), library.createBook);
router.put('/books/:id', requirePermission(PERMISSIONS.LIBRARY_MANAGE), library.updateBook);
router.delete('/books/:id', requirePermission(PERMISSIONS.LIBRARY_MANAGE), library.deleteBook);

router.post('/issues', requirePermission(PERMISSIONS.LIBRARY_MANAGE), library.issue);
router.post('/issues/:id/return', requirePermission(PERMISSIONS.LIBRARY_MANAGE), library.returnIssue);

export default router;
