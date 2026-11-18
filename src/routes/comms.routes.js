import { Router } from 'express';
import * as comms from '../controllers/commsController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = Router();
router.use(authenticate());

const manageEvents = requirePermission(PERMISSIONS.EVENT_MANAGE);
const viewEvents = requirePermission(PERMISSIONS.EVENT_VIEW);
const manageNotices = requirePermission(PERMISSIONS.ANNOUNCEMENT_MANAGE);
const viewNotices = requirePermission(PERMISSIONS.ANNOUNCEMENT_VIEW);
const manageAssignments = requirePermission(PERMISSIONS.ASSIGNMENT_MANAGE);
const viewAssignments = requirePermission(PERMISSIONS.ASSIGNMENT_VIEW);

// events
router.get('/events', viewEvents, comms.events);
router.post('/events', manageEvents, comms.createEvent);
router.put('/events/:id', manageEvents, comms.updateEvent);
router.delete('/events/:id', manageEvents, comms.deleteEvent);

// announcements
router.get('/announcements', viewNotices, comms.announcements);
router.post('/announcements', manageNotices, comms.createAnnouncement);
router.post('/announcements/:id/status', manageNotices, comms.setAnnouncementStatus);
router.post('/announcements/:id/read', viewNotices, comms.markRead);
router.delete('/announcements/:id', manageNotices, comms.deleteAnnouncement);

// notifications
router.get('/notifications', comms.notifications);
router.post('/notifications/:id/read', comms.markNotification);

// assignments
router.get('/assignments', viewAssignments, comms.assignments);
router.post('/assignments', manageAssignments, comms.createAssignment);
router.delete('/assignments/:id', manageAssignments, comms.deleteAssignment);

export default router;
