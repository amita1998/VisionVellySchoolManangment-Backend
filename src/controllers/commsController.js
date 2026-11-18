import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as comms from '../services/commsService.js';
import {
  announcementSchema,
  announcementStatusSchema,
  assignmentSchema,
  eventSchema,
} from '../validators/commsValidators.js';

const auditMeta = (req) => [req.user, req.ip, req.headers['user-agent']];

// events
export const events = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { events: await comms.listEvents(req.user) } });
});

export const createEvent = asyncHandler(async (req, res) => {
  const payload = parseBody(eventSchema, req.body);
  res.status(201).json({ success: true, data: await comms.createEvent(payload, ...auditMeta(req)) });
});

export const updateEvent = asyncHandler(async (req, res) => {
  const payload = parseBody(eventSchema, req.body);
  res.json({ success: true, data: await comms.updateEvent(Number(req.params.id), payload, ...auditMeta(req)) });
});

export const deleteEvent = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await comms.deleteEvent(Number(req.params.id), ...auditMeta(req)) });
});

// announcements
export const announcements = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { announcements: await comms.listAnnouncements(req.user) } });
});

export const createAnnouncement = asyncHandler(async (req, res) => {
  const payload = parseBody(announcementSchema, req.body);
  res.status(201).json({ success: true, data: await comms.createAnnouncement(payload, ...auditMeta(req)) });
});

export const setAnnouncementStatus = asyncHandler(async (req, res) => {
  const payload = parseBody(announcementStatusSchema, req.body);
  res.json({ success: true, data: await comms.publishAnnouncement(Number(req.params.id), payload.status, ...auditMeta(req)) });
});

export const deleteAnnouncement = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await comms.deleteAnnouncement(Number(req.params.id), ...auditMeta(req)) });
});

export const markRead = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await comms.markAnnouncementRead(Number(req.params.id), req.user.id) });
});

// notifications
export const notifications = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await comms.listNotifications(req.user.id, { unreadOnly: req.query.unread === 'true' }),
  });
});

export const markNotification = asyncHandler(async (req, res) => {
  // The path says "read": treat a missing body as read=true, and only accept an explicit false
  // to flip it back. `Boolean(undefined)` silently marked the row UNREAD.
  const read = req.body?.read === undefined ? true : Boolean(req.body.read);
  res.json({ success: true, data: await comms.markNotification(req.user.id, Number(req.params.id), read) });
});

// assignments
export const assignments = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { assignments: await comms.listAssignments(req.user) } });
});

export const createAssignment = asyncHandler(async (req, res) => {
  const payload = parseBody(assignmentSchema, req.body);
  res.status(201).json({ success: true, data: await comms.createAssignment(payload, ...auditMeta(req)) });
});

export const deleteAssignment = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await comms.deleteAssignment(Number(req.params.id), ...auditMeta(req)) });
});
