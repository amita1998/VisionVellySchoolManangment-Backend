import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as timetable from '../services/timetableService.js';
import { periodSchema, slotSchema } from '../validators/commsValidators.js';

const meta = (req) => [req.user, req.ip, req.headers['user-agent']];

export const periods = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { periods: await timetable.listPeriods() } });
});

export const createPeriod = asyncHandler(async (req, res) => {
  const payload = parseBody(periodSchema, req.body);
  res.status(201).json({ success: true, data: await timetable.createPeriod(payload, ...meta(req)) });
});

export const deletePeriod = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await timetable.deletePeriod(Number(req.params.id), ...meta(req)) });
});

export const sectionTimetable = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await timetable.sectionTimetable(Number(req.params.sectionId)) });
});

export const myTimetable = asyncHandler(async (req, res) => {
  if (req.user.role === 'teacher') {
    res.json({ success: true, data: await timetable.teacherTimetable(req.user.id) });
    return;
  }
  const sectionId = await timetable.sectionForUser(req.user);
  if (!sectionId) {
    res.json({ success: true, data: { days: timetable.DAYS, slots: [], section: null } });
    return;
  }
  res.json({ success: true, data: await timetable.sectionTimetable(sectionId) });
});

export const saveSlot = asyncHandler(async (req, res) => {
  const payload = parseBody(slotSchema, req.body);
  res.status(201).json({ success: true, data: await timetable.setSlot(payload, ...meta(req)) });
});

export const removeSlot = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await timetable.deleteSlot(Number(req.params.id), ...meta(req)) });
});
