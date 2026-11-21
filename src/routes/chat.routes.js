import { Router } from 'express';
import * as chat from '../controllers/chatController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();

router.use(authenticate());

// Literal paths first.
router.get('/unread', requirePermission(PERMISSIONS.CHAT_VIEW), chat.unread);
router.get('/contacts', requirePermission(PERMISSIONS.CHAT_VIEW), chat.contacts);

router.get('/threads', requirePermission(PERMISSIONS.CHAT_VIEW), chat.threads);
router.post('/threads', requirePermission(PERMISSIONS.CHAT_SEND), chat.startThread);
router.get('/threads/:id/messages', requirePermission(PERMISSIONS.CHAT_VIEW), chat.messages);
router.post('/threads/:id/messages', requirePermission(PERMISSIONS.CHAT_SEND), chat.send);
router.post('/threads/:id/read', requirePermission(PERMISSIONS.CHAT_VIEW), chat.read);

export default router;
